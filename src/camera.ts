import type { ProjectionMode, Renderer } from '@ifc-lite/renderer';

export interface CameraView {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  fov: number;
  projectionMode: ProjectionMode;
  orthoSize: number;
}

const STORAGE_KEY = typeof window !== 'undefined'
  ? `grist_ifc_camera_view:${window.location.pathname}`
  : 'grist_ifc_camera_view';

function isValidVec3(v: unknown): v is { x: number; y: number; z: number } {
  return (
    typeof v === 'object' &&
    v !== null &&
    Number.isFinite((v as { x?: unknown }).x) &&
    Number.isFinite((v as { y?: unknown }).y) &&
    Number.isFinite((v as { z?: unknown }).z)
  );
}

function isValidCameraView(v: unknown): v is CameraView {
  if (typeof v !== 'object' || v === null) return false;
  const view = v as Partial<CameraView>;
  return (
    isValidVec3(view.position) &&
    isValidVec3(view.target) &&
    isValidVec3(view.up) &&
    Number.isFinite(view.fov) &&
    Number.isFinite(view.orthoSize) &&
    (view.projectionMode === 'perspective' || view.projectionMode === 'orthographic')
  );
}

export class CameraViewState {
  private hasEstablishedView = false;

  hasEstablished(): boolean {
    return this.hasEstablishedView;
  }

  markEstablished(): void {
    this.hasEstablishedView = true;
  }

  capture(renderer: Renderer): CameraView | null {
    if (!this.hasEstablishedView) return null;

    const camera = renderer.getCamera();
    return {
      position: camera.getPosition(),
      target: camera.getTarget(),
      up: camera.getUp(),
      fov: camera.getFOV(),
      projectionMode: camera.getProjectionMode(),
      orthoSize: camera.getOrthoSize(),
    };
  }

  restore(renderer: Renderer, view: CameraView | null): boolean {
    if (!view || !isValidCameraView(view)) return false;

    const camera = renderer.getCamera();
    camera.setProjectionMode(view.projectionMode);
    camera.setOrthoSize(view.orthoSize);
    camera.setPosition(view.position.x, view.position.y, view.position.z);
    camera.setTarget(view.target.x, view.target.y, view.target.z);
    camera.setUp(view.up.x, view.up.y, view.up.z);
    camera.setFOV(view.fov);
    this.hasEstablishedView = true;
    renderer.render();
    return true;
  }

  saveToStorage(renderer: Renderer): void {
    try {
      const camera = renderer.getCamera();
      const view: CameraView = {
        position: camera.getPosition(),
        target: camera.getTarget(),
        up: camera.getUp(),
        fov: camera.getFOV(),
        projectionMode: camera.getProjectionMode(),
        orthoSize: camera.getOrthoSize(),
      };
      if (isValidCameraView(view)) {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(view));
      }
    } catch {
      // In restricted iframe environments, sessionStorage might be blocked or throw
    }
  }

  loadFromStorage(): CameraView | null {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (isValidCameraView(parsed)) {
        return parsed;
      }
    } catch {
      // Ignore JSON parse or storage access errors
    }
    return null;
  }

  clearStorage(): void {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore
    }
  }
}

export function setupCameraControls(
  canvas: HTMLCanvasElement,
  renderer: Renderer,
  cameraViewState?: CameraViewState,
): void {
  const camera = renderer.getCamera();

  let isDragging = false;
  let isPanning = false;
  let lastX = 0;
  let lastY = 0;
  let saveTimer: number | null = null;

  const persistView = () => {
    if (cameraViewState) {
      cameraViewState.markEstablished();
      cameraViewState.saveToStorage(renderer);
    }
  };

  const scheduleSave = () => {
    if (!cameraViewState) return;
    cameraViewState.markEstablished();
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      cameraViewState.saveToStorage(renderer);
      saveTimer = null;
    }, 250);
  };

  // Mouse down - start drag
  canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    isPanning = e.button === 1 || e.button === 2 || e.shiftKey; // Middle/right click or shift = pan
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.style.cursor = isPanning ? 'move' : 'grabbing';
  });

  // Mouse move - orbit or pan
  canvas.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const deltaX = e.clientX - lastX;
    const deltaY = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (isPanning) {
      camera.pan(deltaX, deltaY);
    } else {
      camera.orbit(deltaX, deltaY);
    }

    renderer.render();
    scheduleSave();
  });

  // Mouse up - stop drag
  canvas.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      isPanning = false;
      canvas.style.cursor = 'grab';
      persistView();
    }
  });

  // Mouse leave - stop drag
  canvas.addEventListener('mouseleave', () => {
    if (isDragging) {
      isDragging = false;
      isPanning = false;
      persistView();
    }
  });

  // Scroll wheel - zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Zoom towards mouse position
    camera.zoom(e.deltaY, false, mouseX, mouseY, canvas.width, canvas.height);
    renderer.render();
    scheduleSave();
  });

  // Prevent context menu on right-click
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Set initial cursor
  canvas.style.cursor = 'grab';
}
