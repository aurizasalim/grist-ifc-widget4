import { GeometryProcessor, type GeometryResult, type MeshData } from '@ifc-lite/geometry';
import { chooseSharedRtcOffset } from '@ifc-lite/geometry/world-frame';
import { convergeGeometryOntoRtcAnchor } from '@ifc-lite/geometry/rtc-rebase';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { federationRegistry, Renderer } from '@ifc-lite/renderer';
import './style.css';

interface GristTableData {
  [columnId: string]: unknown[];
}

interface GristApi {
  ready(settings: {
    requiredAccess: 'full';
  }): void;
  onRecords(callback: () => void): void;
  docApi: {
    fetchTable(tableId: string): Promise<GristTableData>;
  };
}

declare const grist: GristApi | undefined;

interface SourceModel {
  id: string;
  name: string;
  url: string;
}

interface LoadedModel {
  id: string;
  name: string;
  store: IfcDataStore;
  geometry: GeometryResult;
  visible: boolean;
  offset: number;
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`The widget page is missing ${selector}.`);
  return element;
}

const canvas = requireElement<HTMLCanvasElement>('#viewer');
const status = requireElement<HTMLElement>('#status');
const modelList = requireElement<HTMLElement>('#models');
const selectionPanel = requireElement<HTMLElement>('#selection');
const errorPanel = requireElement<HTMLElement>('#error');
const gristApi = typeof grist === 'undefined' ? null : grist;
const renderer = new Renderer(canvas);
const geometryProcessor = new GeometryProcessor({ enableInstancing: false });
const parser = new IfcParser();
const loadedModels = new Map<string, LoadedModel>();
let animationFrame: number | null = null;
let resizeObserver: ResizeObserver | null = null;
let previousFrameTime = 0;
let generation = 0;
let loadedFingerprint = '';
let activeController: AbortController | null = null;

function setStatus(message: string): void {
  status.textContent = message;
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  errorPanel.textContent = message;
  errorPanel.hidden = false;
  setStatus('Unable to load the federated models.');
  console.error('[Grist IFClite Federation]', error);
}

function clearError(): void {
  errorPanel.textContent = '';
  errorPanel.hidden = true;
}

function buildSourceModels(table: GristTableData): SourceModel[] {
  const links = table.Link;
  const names = table.Name;
  const shows = table.Show;
  const rowIds = table.id;
  if (!Array.isArray(links) || !Array.isArray(shows) || !Array.isArray(rowIds)) {
    throw new Error('The Models table must have Link and Show columns, and Grist row IDs.');
  }

  const models: SourceModel[] = [];
  links.forEach((value, rowIndex) => {
    if (shows[rowIndex] !== true) return;

    const link = typeof value === 'string' ? value.trim() : '';
    if (!link) return;

    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new Error(`The Link value in row ${rowIds[rowIndex]} is not a valid URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`The Link in row ${rowIds[rowIndex]} must use HTTP or HTTPS.`);
    }

    const name = Array.isArray(names) && typeof names[rowIndex] === 'string'
      ? names[rowIndex].trim()
      : '';
    models.push({
      id: `${rowIds[rowIndex]}:${url.href}`,
      name,
      url: url.href,
    });
  });
  return models;
}

function parseFilename(contentDisposition: string | null): string | null {
  if (!contentDisposition) return null;
  const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ''));
    } catch (error) {
      console.warn('Could not decode attachment filename from Grist.', error);
    }
  }
  return contentDisposition.match(/filename="?([^";]+)"?/i)?.[1] ?? null;
}

async function fetchModelUrl(
  url: string,
  signal: AbortSignal,
): Promise<{ buffer: ArrayBuffer; filename: string | null }> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`The IFC model at ${url} could not be downloaded (${response.status} ${response.statusText}).`);
  }
  const pathFilename = new URL(response.url || url).pathname.split('/').pop();
  let filename = parseFilename(response.headers.get('Content-Disposition'));
  if (!filename && pathFilename) {
    try {
      filename = decodeURIComponent(pathFilename);
    } catch (error) {
      console.warn('Could not decode the IFC filename from its URL.', error);
      filename = pathFilename;
    }
  }
  return {
    buffer: await response.arrayBuffer(),
    filename,
  };
}

async function processGeometry(
  bytes: Uint8Array,
  sharedRtcOffset: { x: number; y: number; z: number } | undefined,
  signal: AbortSignal,
  filename: string,
  requestGeneration: number,
): Promise<GeometryResult> {
  if (signal.aborted) throw new DOMException('The model load was cancelled.', 'AbortError');
  const meshes: MeshData[] = [];
  let coordinateInfo: GeometryResult['coordinateInfo'] | null = null;

  for await (const event of geometryProcessor.processStreaming(bytes, undefined, 25, sharedRtcOffset)) {
    if (signal.aborted) throw new DOMException('The model load was cancelled.', 'AbortError');
    if (event.type === 'batch') {
      for (const mesh of event.meshes) meshes.push(mesh);
      if (generation === requestGeneration) {
        setStatus(`Meshing ${filename} · ${meshes.length.toLocaleString()} meshes`);
      }
    } else if (event.type === 'complete') {
      coordinateInfo = event.coordinateInfo;
    }
  }

  if (!coordinateInfo) {
    throw new Error(`IFClite finished meshing ${filename} without coordinate information.`);
  }

  return {
    meshes,
    totalTriangles: meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0),
    totalVertices: meshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0),
    coordinateInfo,
  };
}

function maximumExpressId(store: IfcDataStore, meshes: MeshData[]): number {
  let maxId = 0;
  for (const id of store.entityIndex.byId.keys()) maxId = Math.max(maxId, id);
  for (const mesh of meshes) {
    maxId = Math.max(maxId, mesh.expressId);
    if (mesh.entityIds) {
      for (const id of mesh.entityIds) maxId = Math.max(maxId, id);
    }
  }
  return maxId;
}

function applyIdOffset(meshes: MeshData[], offset: number): void {
  if (offset === 0) return;
  for (const mesh of meshes) {
    mesh.expressId += offset;
    if (mesh.entityIds) {
      for (let index = 0; index < mesh.entityIds.length; index += 1) {
        mesh.entityIds[index] += offset;
      }
    }
    if (mesh.geometryItemId !== undefined) mesh.geometryItemId += offset;
    if (mesh.textureRef) {
      mesh.textureRef = { ...mesh.textureRef, textureId: mesh.textureRef.textureId + offset };
    }
  }
}

function setVisibleGeometry(fitView: boolean): void {
  const meshes = Array.from(loadedModels.values())
    .filter((model) => model.visible)
    .flatMap((model) => model.geometry.meshes);
  const outcome = renderer.loadGeometry(meshes);
  if (!outcome.ok) {
    throw outcome.reason === 'error' ? outcome.error : new Error('The WebGPU device was lost while loading model geometry.');
  }
  if (fitView && meshes.length > 0) renderer.fitToView();
}

function renderModelList(): void {
  modelList.replaceChildren();
  for (const model of loadedModels.values()) {
    const label = document.createElement('label');
    label.className = 'model-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = model.visible;
    checkbox.setAttribute('aria-label', `Show ${model.name}`);
    checkbox.addEventListener('change', () => {
      model.visible = checkbox.checked;
      try {
        setVisibleGeometry(false);
      } catch (error) {
        showError(error);
      }
    });

    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = model.name;

    const count = document.createElement('small');
    count.textContent = `${model.store.entityCount.toLocaleString()} entities`;

    label.append(checkbox, name, count);
    modelList.append(label);
  }
}

function displaySelection(globalId: number): void {
  const lookup = federationRegistry.fromGlobalId(globalId);
  const model = lookup ? loadedModels.get(lookup.modelId) : undefined;
  if (!lookup || !model) {
    selectionPanel.textContent = `Selected global entity #${globalId}`;
    return;
  }

  const entity = model.store.entityIndex.byId.get(lookup.expressId);
  const name = model.store.entities.getName(lookup.expressId);
  selectionPanel.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = name || `${entity?.type ?? 'IFC entity'} #${lookup.expressId}`;
  const details = document.createElement('p');
  details.textContent = `${model.name} · ${entity?.type ?? 'IFC entity'} · local #${lookup.expressId} · global #${globalId}`;
  selectionPanel.append(heading, details);
}

function startRenderLoop(): void {
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  previousFrameTime = performance.now();
  const render = (time: number) => {
    const deltaSeconds = Math.min((time - previousFrameTime) / 1000, 0.1);
    previousFrameTime = time;
    renderer.getCamera().update(deltaSeconds);
    renderer.render();
    animationFrame = requestAnimationFrame(render);
  };
  animationFrame = requestAnimationFrame(render);
}

async function loadFederation(sources: SourceModel[], requestGeneration: number, signal: AbortSignal): Promise<void> {
  if (sources.length === 0) {
    await renderer.init();
    if (generation !== requestGeneration || signal.aborted) return;

    loadedModels.clear();
    federationRegistry.clear();
    renderModelList();
    selectionPanel.textContent = 'No models with Show enabled were found in the Models table.';
    setStatus('No models are marked Show.');
    return;
  }

  clearError();
  setStatus(`Loading ${sources.length} IFC model${sources.length === 1 ? '' : 's'}…`);
  const stagedModels: LoadedModel[] = [];

  for (let index = 0; index < sources.length; index += 1) {
    if (generation !== requestGeneration || signal.aborted) return;
    const source = sources[index];
    setStatus(`Loading ${source.name || `model ${index + 1}`} (${index + 1}/${sources.length})…`);

    const modelFile = await fetchModelUrl(source.url, signal);
    const filename = source.name || modelFile.filename || `IFC model ${index + 1}.ifc`;
    const geometryBytes = new Uint8Array(modelFile.buffer.slice(0));
    const store = await parser.parseColumnar(modelFile.buffer, {
      onProgress: ({ phase, percent }) => {
        if (generation === requestGeneration) setStatus(`${filename}: ${phase} ${percent}%`);
      },
    });
    if (generation !== requestGeneration || signal.aborted) return;
    const sharedRtcOffset = chooseSharedRtcOffset(stagedModels.map((model, loadedAt) => ({
      loadedAt,
      geometryResult: model.geometry,
    })));
    setStatus(`Meshing ${filename} (${index + 1}/${sources.length})…`);
    const geometry = await processGeometry(geometryBytes, sharedRtcOffset, signal, filename, requestGeneration);
    stagedModels.push({
      id: source.id,
      name: filename,
      store,
      geometry,
      visible: true,
      offset: 0,
    });
  }

  if (generation !== requestGeneration || signal.aborted) return;

  const anchor = chooseSharedRtcOffset(stagedModels.map((model, loadedAt) => ({
    loadedAt,
    geometryResult: model.geometry,
  })));
  if (anchor) {
    const alignment = convergeGeometryOntoRtcAnchor(stagedModels.map((model) => model.geometry), anchor);
    if (alignment.refused.length > 0) {
      const refusedNames = stagedModels
        .filter((model) => alignment.refused.includes(model.geometry))
        .map((model) => model.name);
      throw new Error(`Could not align GPU-instanced model geometry to the federation frame: ${refusedNames.join(', ')}.`);
    }
  }

  await renderer.init();
  if (generation !== requestGeneration || signal.aborted) return;

  federationRegistry.clear();
  for (const model of stagedModels) {
    model.offset = federationRegistry.registerModel(model.id, maximumExpressId(model.store, model.geometry.meshes));
    applyIdOffset(model.geometry.meshes, model.offset);
    model.visible = true;
  }

  loadedModels.clear();
  for (const model of stagedModels) loadedModels.set(model.id, model);
  setVisibleGeometry(true);
  renderModelList();
  selectionPanel.textContent = 'Click an element to inspect it.';
  const entityCount = stagedModels.reduce((sum, model) => sum + model.store.entityCount, 0);
  setStatus(`Federated ${stagedModels.length} model${stagedModels.length === 1 ? '' : 's'} · ${entityCount.toLocaleString()} entities`);
}

function refreshModels(): void {
  if (!gristApi) return;

  generation += 1;
  activeController?.abort();
  const requestGeneration = generation;
  const controller = new AbortController();
  activeController = controller;

  void (async () => {
    const table = await gristApi.docApi.fetchTable('Models');
    if (generation !== requestGeneration) return;

    const sources = buildSourceModels(table);
    const fingerprint = JSON.stringify(sources);
    if (fingerprint === loadedFingerprint) return;

    await loadFederation(sources, requestGeneration, controller.signal);
    if (generation === requestGeneration) loadedFingerprint = fingerprint;
  })()
    .catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError') && generation === requestGeneration) {
        showError(error);
      }
    })
    .finally(() => {
      if (generation === requestGeneration) activeController = null;
    });
}

function start(): void {
  if (!gristApi) {
    setStatus('Open this page as a Grist custom widget to load IFC model URLs.');
    return;
  }

  void (async () => {
    try {
      await renderer.init();
      await geometryProcessor.init();
      resizeObserver = new ResizeObserver(() => {
        renderer.resize(canvas.clientWidth, canvas.clientHeight);
      });
      resizeObserver.observe(canvas);
      renderer.resize(canvas.clientWidth, canvas.clientHeight);
      startRenderLoop();
      canvas.addEventListener('click', async (event) => {
        try {
          const rect = canvas.getBoundingClientRect();
          const hit = await renderer.pick(event.clientX - rect.left, event.clientY - rect.top);
          if (hit) displaySelection(hit.expressId);
          else selectionPanel.textContent = 'Click an element to inspect it.';
        } catch (error) {
          showError(error);
        }
      });
      gristApi.ready({
        requiredAccess: 'full',
      });
      gristApi.onRecords(refreshModels);
      refreshModels();
    } catch (error) {
      showError(error);
    }
  })();
}

window.addEventListener('resize', () => {
  renderer.resize(canvas.clientWidth, canvas.clientHeight);
});

window.addEventListener('beforeunload', () => {
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  resizeObserver?.disconnect();
  activeController?.abort();
});

start();
