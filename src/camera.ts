import type { ProjectionMode, Renderer } from '@ifc-lite/renderer';

interface CameraView {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  fov: number;
  projectionMode: ProjectionMode;
  orthoSize: number;
}

export class CameraViewState {
  private hasEstablishedView = false;

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

  restore(renderer: Renderer, view: CameraView | null): void {
    if (!view) return;

    const camera = renderer.getCamera();
    camera.setProjectionMode(view.projectionMode);
    camera.setOrthoSize(view.orthoSize);
    camera.setPosition(view.position.x, view.position.y, view.position.z);
    camera.setTarget(view.target.x, view.target.y, view.target.z);
    camera.setUp(view.up.x, view.up.y, view.up.z);
    camera.setFOV(view.fov);
    this.hasEstablishedView = true;
  }
}

export function setupCameraControls(canvas: HTMLCanvasElement, renderer: Renderer): void {
  const camera = renderer.getCamera();

  let isDragging = false;
  let isPanning = false;
  let lastX = 0;
  let lastY = 0;

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
  });

  // Mouse up - stop drag
  canvas.addEventListener('mouseup', () => {
    isDragging = false;
    isPanning = false;
    canvas.style.cursor = 'grab';
  });

  // Mouse leave - stop drag
  canvas.addEventListener('mouseleave', () => {
    isDragging = false;
    isPanning = false;
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
  });

  // Prevent context menu on right-click
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Set initial cursor
  canvas.style.cursor = 'grab';
}