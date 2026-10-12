import { GeometryProcessor, type GeometryResult, type MeshData } from '@ifc-lite/geometry';
import { chooseSharedRtcOffset } from '@ifc-lite/geometry/world-frame';
import { convergeGeometryOntoRtcAnchor } from '@ifc-lite/geometry/rtc-rebase';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { federationRegistry, Renderer } from '@ifc-lite/renderer';
import './style.css';

interface GristRecord {
  id?: number;
  [columnId: string]: unknown;
}

interface GristApi {
  ready(settings: {
    columns: Array<{
      name: string;
      title: string;
      type: string;
      optional: boolean;
    }>;
    requiredAccess: 'read table';
  }): void;
  onRecords(callback: (records: GristRecord[]) => void): void;
  mapColumnNames(record: GristRecord): Record<string, unknown> | null;
  docApi: {
    getAccessToken(options?: { readOnly?: boolean }): Promise<{
      baseUrl: string;
      token: string;
    }>;
  };
}

declare const grist: GristApi | undefined;

interface SourceModel {
  id: string;
  name: string;
  attachmentId: number;
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
let activeFingerprint = '';
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

function extractAttachmentIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0);
}

function buildSourceModels(records: GristRecord[]): SourceModel[] {
  if (!gristApi) throw new Error('Open this page as a Grist custom widget to load IFC attachments.');
  const models: SourceModel[] = [];
  records.forEach((record, rowIndex) => {
    const mapped = gristApi.mapColumnNames(record);
    if (!mapped) {
      throw new Error('Map the required IFC model field to an Attachments column in Grist.');
    }

    const attachmentIds = extractAttachmentIds(mapped.ifcModel);
    const mappedName = typeof mapped.modelName === 'string' ? mapped.modelName.trim() : '';
    attachmentIds.forEach((attachmentId, attachmentIndex) => {
      const rowId = record.id ?? rowIndex;
      models.push({
        id: `${rowId}:${attachmentId}:${attachmentIndex}`,
        name: mappedName,
        attachmentId,
      });
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

async function fetchAttachment(
  attachmentId: number,
  access: { baseUrl: string; token: string },
  signal: AbortSignal,
): Promise<{ buffer: ArrayBuffer; filename: string | null }> {
  const baseUrl = access.baseUrl.replace(/\/$/, '');
  const url = `${baseUrl}/attachments/${attachmentId}/download?auth=${encodeURIComponent(access.token)}`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Grist attachment ${attachmentId} could not be downloaded (${response.status} ${response.statusText}).`);
  }
  return {
    buffer: await response.arrayBuffer(),
    filename: parseFilename(response.headers.get('Content-Disposition')),
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

async function loadFederation(records: GristRecord[], requestGeneration: number, signal: AbortSignal): Promise<void> {
  if (!gristApi) throw new Error('Open this page as a Grist custom widget to load IFC attachments.');
  const sources = buildSourceModels(records);
  if (sources.length === 0) {
    loadedModels.clear();
    federationRegistry.clear();
    setVisibleGeometry(false);
    renderModelList();
    selectionPanel.textContent = 'No IFC attachments found in the selected table.';
    setStatus('No IFC models to display.');
    return;
  }

  clearError();
  setStatus(`Getting access to ${sources.length} IFC model${sources.length === 1 ? '' : 's'}…`);
  const access = await gristApi.docApi.getAccessToken({ readOnly: true });
  const stagedModels: LoadedModel[] = [];

  for (let index = 0; index < sources.length; index += 1) {
    if (generation !== requestGeneration || signal.aborted) return;
    const source = sources[index];
    setStatus(`Loading ${source.name || `model ${index + 1}`} (${index + 1}/${sources.length})…`);

    const attachment = await fetchAttachment(source.attachmentId, access, signal);
    const filename = source.name || attachment.filename || `IFC model ${index + 1}.ifc`;
    const geometryBytes = new Uint8Array(attachment.buffer.slice(0));
    const store = await parser.parseColumnar(attachment.buffer, {
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

function start(): void {
  if (!gristApi) {
    setStatus('Open this page as a Grist custom widget to load IFC attachments.');
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
        columns: [
          { name: 'ifcModel', title: 'IFC model', type: 'Attachments', optional: false },
          { name: 'modelName', title: 'Model name', type: 'Text', optional: true },
        ],
        requiredAccess: 'read table',
      });
      gristApi.onRecords((records) => {
        const fingerprint = JSON.stringify(records.map((record) => [record.id, gristApi.mapColumnNames(record)]));
        if (fingerprint === activeFingerprint || fingerprint === loadedFingerprint) return;

        generation += 1;
        activeController?.abort();
        const requestGeneration = generation;
        const controller = new AbortController();
        activeController = controller;
        activeFingerprint = fingerprint;
        void loadFederation(records, requestGeneration, controller.signal)
          .then(() => {
            if (generation === requestGeneration) loadedFingerprint = fingerprint;
          })
          .catch((error: unknown) => {
            if (!(error instanceof DOMException && error.name === 'AbortError') && generation === requestGeneration) {
              showError(error);
            }
          })
          .finally(() => {
            if (generation === requestGeneration) {
              activeFingerprint = '';
              activeController = null;
            }
          });
      });
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
