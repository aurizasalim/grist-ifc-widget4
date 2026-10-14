import { GeometryProcessor, type GeometryResult, type MeshData } from '@ifc-lite/geometry';
import { chooseSharedRtcOffset } from '@ifc-lite/geometry/world-frame';
import { convergeGeometryOntoRtcAnchor } from '@ifc-lite/geometry/rtc-rebase';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { federationRegistry, Renderer } from '@ifc-lite/renderer';
import { CameraViewState, setupCameraControls, type CameraView } from './camera';
import './style.css';

interface GristTableData {
  [columnId: string]: unknown[];
}

interface GristRecord {
  id: number;
  [columnId: string]: unknown;
}

interface GristApi {
  ready(settings: {
    requiredAccess: 'full';
  }): void;
  onRecord(callback: (record: GristRecord | null) => void): void;
  onRecords(callback: () => void): void;
  docApi: {
    fetchTable(tableId: string): Promise<GristTableData>;
    applyUserActions(actions: unknown[][]): Promise<unknown>;
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
  offset: number;
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`The widget page is missing ${selector}.`);
  return element;
}

const canvas = requireElement<HTMLCanvasElement>('#viewer');
const status = requireElement<HTMLElement>('#status');
const selectionPanel = requireElement<HTMLElement>('#selection');
const errorPanel = requireElement<HTMLElement>('#error');
const cameraTargetInfo = requireElement<HTMLElement>('#camera-target-info');
const saveCameraBtn = requireElement<HTMLButtonElement>('#save-camera-btn');
const loadCameraBtn = requireElement<HTMLButtonElement>('#load-camera-btn');
const gristApi = typeof grist === 'undefined' ? null : grist;
const renderer = new Renderer(canvas);
const geometryProcessor = new GeometryProcessor({ enableInstancing: false });
const parser = new IfcParser();
const cameraViewState = new CameraViewState();
const loadedModels = new Map<string, LoadedModel>();
const modelCameras = new Map<number, string>();
let selectedRecord: GristRecord | null = null;
let animationFrame: number | null = null;
let resizeObserver: ResizeObserver | null = null;
let previousFrameTime = 0;
let generation = 0;
let currentFingerprint = '';
let activeController: AbortController | null = null;
let refreshCheckRunning = false;
let refreshInterval: number | null = null;

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

function updateSelectedRecord(record: GristRecord | null): void {
  selectedRecord = record;
  if (!record || typeof record.id !== 'number') {
    cameraTargetInfo.textContent = 'No row selected';
    cameraTargetInfo.title = 'Select a row in Grist to save or load camera positions';
    saveCameraBtn.disabled = true;
    loadCameraBtn.hidden = true;
    return;
  }

  const name = typeof record.Name === 'string' && record.Name.trim()
    ? record.Name.trim()
    : `Row #${record.id}`;
  cameraTargetInfo.textContent = name;
  cameraTargetInfo.title = `${name} (Row ID: ${record.id})`;
  saveCameraBtn.disabled = false;

  const cameraStr = (typeof record.Camera === 'string' && record.Camera.trim())
    || modelCameras.get(record.id)
    || '';
  let hasValidCamera = false;
  if (cameraStr) {
    try {
      const parsed = JSON.parse(cameraStr);
      hasValidCamera = Boolean(parsed && parsed.position && parsed.target);
    } catch {
      hasValidCamera = false;
    }
  }

  loadCameraBtn.hidden = !hasValidCamera;
}

function setupCameraToolbar(): void {
  saveCameraBtn.addEventListener('click', async () => {
    if (!selectedRecord || typeof selectedRecord.id !== 'number') return;
    const targetId = selectedRecord.id;
    const camera = renderer.getCamera();
    const currentView: CameraView = {
      position: camera.getPosition(),
      target: camera.getTarget(),
      up: camera.getUp(),
      fov: camera.getFOV(),
      projectionMode: camera.getProjectionMode(),
      orthoSize: camera.getOrthoSize(),
    };

    const jsonStr = JSON.stringify(currentView);
    saveCameraBtn.disabled = true;
    const originalHtml = saveCameraBtn.innerHTML;
    saveCameraBtn.textContent = 'Saving…';

    try {
      if (gristApi) {
        try {
          await gristApi.docApi.applyUserActions([
            ['UpdateRecord', 'Models', targetId, { Camera: jsonStr }]
          ]);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('Camera') || msg.includes('column') || msg.includes('Invalid column')) {
            await gristApi.docApi.applyUserActions([
              ['AddVisibleColumn', 'Models', 'Camera', { type: 'Text' }],
              ['UpdateRecord', 'Models', targetId, { Camera: jsonStr }]
            ]);
          } else {
            throw err;
          }
        }
      }

      modelCameras.set(targetId, jsonStr);
      if (selectedRecord && selectedRecord.id === targetId) {
        selectedRecord.Camera = jsonStr;
        loadCameraBtn.hidden = false;
      }

      saveCameraBtn.classList.add('success');
      saveCameraBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>Saved!</span>
      `;
      setTimeout(() => {
        saveCameraBtn.classList.remove('success');
        saveCameraBtn.innerHTML = originalHtml;
        saveCameraBtn.disabled = false;
      }, 1800);
      setStatus(`Saved camera position to row #${targetId}.`);
    } catch (error) {
      saveCameraBtn.classList.remove('success');
      saveCameraBtn.innerHTML = originalHtml;
      saveCameraBtn.disabled = false;
      showError(`Failed to save camera position: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  loadCameraBtn.addEventListener('click', () => {
    if (!selectedRecord || typeof selectedRecord.id !== 'number') return;
    const cameraStr = (typeof selectedRecord.Camera === 'string' && selectedRecord.Camera.trim())
      || modelCameras.get(selectedRecord.id);
    if (!cameraStr) return;

    try {
      const view = JSON.parse(cameraStr);
      if (cameraViewState.restore(renderer, view)) {
        cameraViewState.saveToStorage(renderer);
        setStatus(`Restored camera view from row #${selectedRecord.id}.`);
      } else {
        showError('Saved camera data in this row is invalid.');
      }
    } catch (error) {
      showError(`Failed to load saved camera view: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
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
  const meshes = Array.from(loadedModels.values()).flatMap((model) => model.geometry.meshes);
  const outcome = renderer.loadGeometry(meshes);
  if (!outcome.ok) {
    throw outcome.reason === 'error' ? outcome.error : new Error('The WebGPU device was lost while loading model geometry.');
  }
  if (fitView && meshes.length > 0) renderer.fitToView();
}

function displaySelection(globalId: number): void {
  const lookup = federationRegistry.fromGlobalId(globalId);
  const model = lookup ? loadedModels.get(lookup.modelId) : undefined;
  selectionPanel.hidden = false;
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
  clearError();
  setStatus(sources.length === 0
    ? 'Unloading disabled models…'
    : `Loading ${sources.length} IFC model${sources.length === 1 ? '' : 's'}…`);
  selectionPanel.hidden = true;
  const cameraView = cameraViewState.hasEstablished()
    ? cameraViewState.capture(renderer)
    : cameraViewState.loadFromStorage();
  await renderer.init();
  if (generation !== requestGeneration || signal.aborted) return;

  loadedModels.clear();
  federationRegistry.clear();

  if (sources.length === 0) {
    if (cameraView) cameraViewState.restore(renderer, cameraView);
    setStatus('No models are marked Show.');
    return;
  }

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

  for (const model of stagedModels) {
    model.offset = federationRegistry.registerModel(model.id, maximumExpressId(model.store, model.geometry.meshes));
    applyIdOffset(model.geometry.meshes, model.offset);
  }

  loadedModels.clear();
  for (const model of stagedModels) loadedModels.set(model.id, model);
  const shouldFitView = cameraView === null;
  setVisibleGeometry(shouldFitView);
  if (cameraView) {
    cameraViewState.restore(renderer, cameraView);
    cameraViewState.saveToStorage(renderer);
  } else {
    cameraViewState.markEstablished();
    cameraViewState.saveToStorage(renderer);
  }
  const entityCount = stagedModels.reduce((sum, model) => sum + model.store.entityCount, 0);
  setStatus(`Federated ${stagedModels.length} model${stagedModels.length === 1 ? '' : 's'} · ${entityCount.toLocaleString()} entities`);
}

function refreshModels(): void {
  if (!gristApi || refreshCheckRunning) return;
  refreshCheckRunning = true;

  void (async () => {
    const table = await gristApi.docApi.fetchTable('Models');
    modelCameras.clear();
    const rowIds = table.id;
    const cameras = table.Camera;
    if (Array.isArray(rowIds) && Array.isArray(cameras)) {
      rowIds.forEach((id, idx) => {
        if (typeof id === 'number' && typeof cameras[idx] === 'string' && cameras[idx].trim()) {
          modelCameras.set(id, cameras[idx].trim());
        }
      });
    }
    if (selectedRecord && typeof selectedRecord.id === 'number') {
      const updatedCamera = modelCameras.get(selectedRecord.id);
      if (updatedCamera !== undefined) {
        selectedRecord.Camera = updatedCamera;
      }
      updateSelectedRecord(selectedRecord);
    }
    const sources = buildSourceModels(table);
    const fingerprint = JSON.stringify(sources);
    if (fingerprint === currentFingerprint) return;

    currentFingerprint = fingerprint;
    generation += 1;
    activeController?.abort();
    const requestGeneration = generation;
    const controller = new AbortController();
    activeController = controller;

    void loadFederation(sources, requestGeneration, controller.signal)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError') && generation === requestGeneration) {
          showError(error);
        }
      })
      .finally(() => {
        if (generation === requestGeneration) activeController = null;
      });
  })()
    .catch((error: unknown) => {
      showError(error);
    })
    .finally(() => {
      refreshCheckRunning = false;
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
      setupCameraControls(canvas, renderer, cameraViewState);
      setupCameraToolbar();
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
          if (hit) {
            displaySelection(hit.expressId);
            const lookup = federationRegistry.fromGlobalId(hit.expressId);
            if (lookup) {
              const rowId = parseInt(lookup.modelId.split(':')[0], 10);
              if (Number.isFinite(rowId) && (!selectedRecord || selectedRecord.id !== rowId)) {
                const model = loadedModels.get(lookup.modelId);
                updateSelectedRecord({
                  id: rowId,
                  Name: model?.name ?? `Row #${rowId}`,
                  Camera: modelCameras.get(rowId),
                });
              }
            }
          } else {
            selectionPanel.textContent = 'Click an element to inspect it.';
          }
        } catch (error) {
          showError(error);
        }
      });
      gristApi.ready({
        requiredAccess: 'full',
      });
      gristApi.onRecord(updateSelectedRecord);
      gristApi.onRecords(refreshModels);
      refreshModels();
      refreshInterval = window.setInterval(refreshModels, 1000);
    } catch (error) {
      showError(error);
    }
  })();
}

window.addEventListener('resize', () => {
  renderer.resize(canvas.clientWidth, canvas.clientHeight);
});

window.addEventListener('beforeunload', () => {
  cameraViewState.saveToStorage(renderer);
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  if (refreshInterval !== null) window.clearInterval(refreshInterval);
  resizeObserver?.disconnect();
  activeController?.abort();
});

start();
