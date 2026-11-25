import type { JadeMaterial, LabelGrid, LightMode, RenderMode, VolumeGrid } from '../core/types';
import { OrbitCamera } from './camera';
import { PRESENT_WGSL, TRACE_WGSL } from './shaders';

// Uniforms 结构(与 WGSL 对齐,每个 vec4/mat4 16 字节)
const UNIFORM_FLOATS = 16 + 4 * 9; // mat4 + 9 个 vec4
const BYTES = 4;

export interface RenderViewState {
  volume: VolumeGrid;
  labels: LabelGrid;
  material: JadeMaterial;
  renderMode: RenderMode;
  lightMode: LightMode;
  lightPower: number;
  validationMode: boolean;
  validationThicknessMm: number;
  crackSigma: number;
  cottonSigma: number;
  impuritySigma: number;
  exposure: number;
}

export class JadeRenderer {
  device!: GPUDevice;
  context!: GPUCanvasContext;
  format!: GPUTextureFormat;
  camera = new OrbitCamera();

  private sdfTex!: GPUTexture;
  private labelTex!: GPUTexture;
  private accumBuf!: GPUBuffer;
  private countBuf!: GPUBuffer;
  private uniformBuf!: GPUBuffer;
  private presentUniformBuf!: GPUBuffer;
  private tracePipeline!: GPUComputePipeline;
  private presentPipeline!: GPURenderPipeline;
  private bindGroup!: GPUBindGroup;
  private presentBind!: GPUBindGroup;
  private sampler!: GPUSampler;
  private width = 1;
  private height = 1;
  private frameIndex = 0;
  private gridDims = [1, 1, 1];
  private raf = 0;
  private lastInteract = performance.now();
  private running = false;
  private converged = false;
  onConverged?: (samples: number) => void;
  maxSamples = 256;
  previewScale = 0.4;
  private fullResQueued = false;

  static async isSupported(): Promise<boolean> {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('未找到 WebGPU 适配器,请使用最新版 Chrome/Edge');
    this.device = await adapter.requestDevice();
    this.context = canvas.getContext('webgpu')!;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });

    this.sampler = this.device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge',
    });

    const traceMod = this.device.createShaderModule({ code: TRACE_WGSL });
    const presentMod = this.device.createShaderModule({ code: PRESENT_WGSL });
    this.uniformBuf = this.device.createBuffer({ size: UNIFORM_FLOATS * BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.presentUniformBuf = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.tracePipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: traceMod, entryPoint: 'main' },
    });
    this.presentPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: presentMod, entryPoint: 'vs' },
      fragment: { module: presentMod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  /** 上传/替换体积数据 */
  setVolume(volume: VolumeGrid, labels: LabelGrid): void {
    this.gridDims = [volume.nx, volume.ny, volume.nz];
    this.sdfTex?.destroy();
    this.labelTex?.destroy();
    this.sdfTex = this.device.createTexture({
      size: [volume.nx, volume.ny, volume.nz],
      format: 'r32float',
      dimension: '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.labelTex = this.device.createTexture({
      size: [volume.nx, volume.ny, volume.nz],
      format: 'r32uint',
      dimension: '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture: this.sdfTex }, volume.sdf as unknown as BufferSource, { bytesPerRow: volume.nx * 4, rowsPerImage: volume.ny }, [volume.nx, volume.ny, volume.nz]);
    this.device.queue.writeTexture({ texture: this.labelTex }, new Uint32Array(labels.data) as unknown as BufferSource, { bytesPerRow: volume.nx * 4, rowsPerImage: volume.ny }, [volume.nx, volume.ny, volume.nz]);
    this.resetAccum(this.width, this.height);
  }

  private resetAccum(width: number, height: number): void {
    const n = width * height;
    this.accumBuf?.destroy();
    this.countBuf?.destroy();
    this.accumBuf = this.device.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.countBuf = this.device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.device.queue.writeBuffer(this.countBuf, 0, new Int32Array(n).fill(0) as unknown as BufferSource);
    this.device.queue.writeBuffer(this.accumBuf, 0, new Float32Array(n * 4).fill(0) as unknown as BufferSource);

    this.bindGroup = this.device.createBindGroup({
      layout: this.tracePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: this.sdfTex.createView() },
        { binding: 2, resource: this.labelTex.createView() },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: this.accumBuf } },
        { binding: 5, resource: { buffer: this.countBuf } },
      ],
    });
    this.presentBind = this.device.createBindGroup({
      layout: this.presentPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.presentUniformBuf } },
        { binding: 1, resource: { buffer: this.accumBuf } },
      ],
    });
    this.frameIndex = 0;
    this.converged = false;
  }

  markInteraction(): void {
    this.lastInteract = performance.now();
    this.converged = false;
    this.frameIndex = 0;
    this.fullResQueued = false;
  }

  private writeUniforms(state: RenderViewState, width: number, height: number): void {
    const u = new Float32Array(UNIFORM_FLOATS);
    const vp = this.camera.viewProj();
    u.set(vp, 0);
    const cam = this.camera.position;
    const light = this.lightPosition(state.lightMode);
    u.set([...cam, 1], 16);
    u.set([48, 48, 48, 1], 20);
    u.set([light[0], light[1], light[2], state.lightPower], 24);
    const m = state.material;
    u.set([m.sigmaA[0], m.sigmaA[1], m.sigmaA[2], m.ior], 28);
    u.set([m.sigmaS[0], m.sigmaS[1], m.sigmaS[2], m.roughness], 32);
    u.set([state.crackSigma, state.cottonSigma, state.impuritySigma, m.oiliness], 36);
    u.set([state.volume.voxelMm, this.frameIndex, this.renderModeIndex(state.renderMode), this.lightModeIndex(state.lightMode)], 40);
    u.set([this.gridDims[0], this.gridDims[1], this.gridDims[2], state.validationMode ? 1 : 0], 44);
    // slab: x 验证板厚度, y width, z height, w 相机 tan(FOV/2)
    const tanHalfFov = Math.tan(this.camera.fov / 2);
    u.set([state.validationThicknessMm, width, height, tanHalfFov], 48);
    this.device.queue.writeBuffer(this.uniformBuf, 0, u as unknown as BufferSource);

    const p = new Float32Array([width, height, state.exposure, 0]);
    this.device.queue.writeBuffer(this.presentUniformBuf, 0, p as unknown as BufferSource);
  }

  private lightPosition(mode: LightMode): [number, number, number] {
    if (mode === 'backlight') return [-60, 48, 48];   // 手电从背后打
    if (mode === 'sidelight') return [48, 30, 110];   // 台灯侧面
    return [90, 90, 90];                                // 环境顶光
  }
  private renderModeIndex(m: RenderMode): number {
    return m === 'material' ? 0 : m === 'thickness' ? 2 : m === 'transmission' ? 0 : 3;
  }
  private lightModeIndex(m: LightMode): number {
    return m === 'backlight' ? 0 : m === 'sidelight' ? 2 : 1;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(64, Math.floor(cssW * dpr));
    const h = Math.max(64, Math.floor(cssH * dpr));
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.camera.aspect = w / h;
    this.resetAccum(w, h);
  }

  /** 渲染循环:交互时低分辨率快速预览,静止后全分辨率收敛 */
  start(state: () => RenderViewState): void {
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      const s = state();
      const idleMs = performance.now() - this.lastInteract;
      const idle = idleMs > 180;
      // 预览:用全分辨率缓冲但只跑少量样本;静止后持续累加
      this.writeUniforms(s, this.width, this.height);

      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.tracePipeline);
      pass.setBindGroup(0, this.bindGroup);
      const wgX = Math.ceil(this.width / 8);
      const wgY = Math.ceil(this.height / 8);
      // 预览阶段每帧 1 个 sample,收敛阶段多 dispatch 加快累积
      const dispatches = idle ? Math.min(4, Math.max(1, this.maxSamples / 64)) : 1;
      for (let d = 0; d < dispatches; d++) {
        pass.dispatchWorkgroups(wgX, wgY, 1);
        this.frameIndex++;
      }
      pass.end();

      const rp = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
      rp.setPipeline(this.presentPipeline);
      rp.setBindGroup(0, this.presentBind);
      rp.draw(6);
      rp.end();
      this.device.queue.submit([encoder.finish()]);

      if (!this.converged && this.frameIndex >= this.maxSamples) {
        this.converged = true;
        this.onConverged?.(this.frameIndex);
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  get sampleCount(): number {
    return this.frameIndex;
  }
  get isConverged(): boolean {
    return this.converged;
  }

  /** 回读累积缓冲(用于校验/导出) */
  async readback(width: number, height: number): Promise<Float32Array> {
    const n = width * height;
    const readBuf = this.device.createBuffer({ size: n * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.accumBuf, 0, readBuf, 0, n * 16);
    this.device.queue.submit([encoder.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    readBuf.destroy();
    return data;
  }
}
