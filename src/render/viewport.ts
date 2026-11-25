import type { JadeMaterial, LabelGrid, LightMode, RenderMode, VolumeGrid } from '../core/types';
import { JadeRenderer, type RenderViewState } from './jadeRenderer';

export interface ViewportOptions {
  renderMode: RenderMode;
  getMaterial: () => JadeMaterial;
  getVolume: () => VolumeGrid;
  getLabels: () => LabelGrid;
  getLightMode: () => LightMode;
  getLightPower: () => number;
  validationMode?: boolean;
  validationThicknessMm?: number;
  exposure?: number;
  onStatus?: (samples: number, converged: boolean) => void;
}

/** 把 canvas 包装成带轨道交互的 WebGPU 视图 */
export class Viewport {
  renderer: JadeRenderer;
  private canvas: HTMLCanvasElement;
  private opts: ViewportOptions;
  private resizeObs: ResizeObserver;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private statusEl: HTMLElement;
  ready = false;

  private constructor(canvas: HTMLCanvasElement, statusEl: HTMLElement, opts: ViewportOptions) {
    this.canvas = canvas;
    this.statusEl = statusEl;
    this.opts = opts;
    this.renderer = new JadeRenderer();
    this.resizeObs = new ResizeObserver(() => this.doResize());
  }

  static async create(canvas: HTMLCanvasElement, statusEl: HTMLElement, opts: ViewportOptions): Promise<Viewport> {
    const vp = new Viewport(canvas, statusEl, opts);
    await vp.renderer.init(canvas);
    vp.renderer.setVolume(opts.getVolume(), opts.getLabels());
    vp.bindInput();
    vp.doResize();
    vp.renderer.maxSamples = 200;
    vp.renderer.onConverged = () => vp.updateStatus();
    vp.renderer.start(() => vp.buildState());
    vp.resizeObs.observe(canvas.parentElement ?? canvas);
    vp.ready = true;
    vp.tickStatus();
    return vp;
  }

  private buildState(): RenderViewState {
    return {
      volume: this.opts.getVolume(),
      labels: this.opts.getLabels(),
      material: this.opts.getMaterial(),
      renderMode: this.opts.renderMode,
      lightMode: this.opts.getLightMode(),
      lightPower: this.opts.getLightPower(),
      validationMode: this.opts.validationMode ?? false,
      validationThicknessMm: this.opts.validationThicknessMm ?? 10,
      crackSigma: 0.25,
      cottonSigma: 0.12,
      impuritySigma: 0.18,
      exposure: this.opts.exposure ?? 1.0,
    };
  }

  setRenderMode(m: RenderMode): void { this.opts.renderMode = m; this.interact(); }
  setLightMode(m: LightMode): void { this.opts.getLightMode = () => m; this.interact(); }
  update(): void { this.renderer.setVolume(this.opts.getVolume(), this.opts.getLabels()); this.interact(); }

  private interact(): void {
    this.renderer.markInteraction();
    this.updateStatus();
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.dragging = true; this.lastX = e.clientX; this.lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
      if (e.shiftKey || e.button === 2) this.renderer.camera.pan(dx, dy);
      else this.renderer.camera.rotate(dx, dy);
      this.interact();
    });
    const end = () => (this.dragging = false);
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.renderer.camera.zoom(e.deltaY);
      this.interact();
    }, { passive: false });
  }

  private doResize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.resize(parent.clientWidth, parent.clientHeight, dpr);
    this.canvas.width = this.renderer['width'];
    this.canvas.height = this.renderer['height'];
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
  }

  private tickStatus(): void {
    this.updateStatus();
    requestAnimationFrame(() => this.ready && this.tickStatus());
  }
  private updateStatus(): void {
    const s = this.renderer.sampleCount;
    const conv = this.renderer.isConverged;
    this.statusEl.textContent = conv ? `已收敛 · ${s} 采样` : `累积中 · ${s} 采样(转视角为低质量预览)`;
    this.statusEl.className = conv ? 'status ok' : 'status';
    this.opts.onStatus?.(s, conv);
  }

  async readPixels(): Promise<ImageData> {
    const w = this.canvas.width, h = this.canvas.height;
    const data = await this.renderer.readback(w, h);
    const img = new ImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      img.data[i * 4] = clamp255(data[i * 4]);
      img.data[i * 4 + 1] = clamp255(data[i * 4 + 1]);
      img.data[i * 4 + 2] = clamp255(data[i * 4 + 2]);
      img.data[i * 4 + 3] = 255;
    }
    return img;
  }

  getCanvas(): HTMLCanvasElement { return this.canvas; }

  dispose(): void {
    this.ready = false;
    this.resizeObs.disconnect();
    this.renderer.stop();
  }
}

function clamp255(x: number): number {
  // 累积缓冲是线性 HDR,导出前做一次 gamma
  const v = Math.pow(Math.min(1, Math.max(0, x)), 1 / 2.2) * 255;
  return Math.round(v);
}
