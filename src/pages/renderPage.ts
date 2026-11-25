import type { LightMode, RenderMode } from '../core/types';
import { store } from '../state/store';
import { h, mount, download } from '../ui/dom';
import { navigate, toast } from '../ui/shell';
import { JadeRenderer } from '../render/jadeRenderer';
import type { RenderViewState } from '../render/jadeRenderer';
import { computeThickness } from '../core/carve';
import { thicknessToHeatmap } from '../export/heatmap';

const RENDER_MODES: { id: RenderMode; label: string }[] = [
  { id: 'material', label: '玉质外观' },
  { id: 'transmission', label: '透光(SSS)' },
  { id: 'thickness', label: '厚度色带' },
  { id: 'crack', label: '绺裂显现' },
];
const LIGHTS: { id: LightMode; label: string }[] = [
  { id: 'backlight', label: '手电·背后打光' },
  { id: 'sidelight', label: '台灯·侧面光' },
  { id: 'ambient', label: '环境顶光' },
];

export function renderRenderPage(root: HTMLElement): void {
  const stone0 = store.currentStone;
  if (!stone0) { mount(root, h('div', { class: 'card' }, h('p', { class: 'muted' }, '请先选择料。'), h('button', { onclick: () => navigate('library') }, '去原料库'))); return; }
  const stone = stone0;

  let renderMode: RenderMode = 'transmission';
  let lightMode: LightMode = store.settings.lightMode;
  let lightPower = store.settings.lightPower;
  let renderer: JadeRenderer | null = null;

  mount(root,
    h('h2', { class: 'page-title' }, '透光渲染 · ' + stone.name),
    h('p', { class: 'page-desc' }, '次表面散射 + 逐体素光程 Beer-Lambert,呈现玉的半透明与油润感。拖动旋转时出低质量预览,静止后在 GPU 上逐步累加到收敛。'),
  );

  const viewport = h('div', { class: 'viewport-wrap', style: 'min-height:540px' },
    h('canvas', {}),
    h('div', { class: 'light-badge' }, '灯光:'),
    h('div', { class: 'toolbar' },
      ...RENDER_MODES.map((m) => h('button', { class: 'sm', onclick: () => { renderMode = m.id; renderer?.markInteraction(); syncActive(); } }, m.label)),
    ),
    h('div', { class: 'status' }, '初始化…'),
  );
  const lightBadge = viewport.querySelector('.light-badge') as HTMLElement;

  const panel = h('div', { class: 'card' },
    h('h3', {}, '灯光'),
    h('div', { class: 'row' }, ...LIGHTS.map((l) => h('button', { class: 'sm ghost', onclick: () => { lightMode = l.id; lightBadge.textContent = '灯光:' + l.label; renderer?.markInteraction(); } }, l.label))),
    h('label', { class: 'field', style: 'margin-top:12px' },
      h('span', {}, `灯光功率 ${lightPower.toFixed(2)}`),
      h('input', { type: 'range', min: 0.3, max: 3, step: 0.05, value: lightPower, oninput: (e: Event) => { lightPower = +(e.target as HTMLInputElement).value; renderer?.markInteraction(); } }),
    ),
    h('hr', { class: 'sep' }),
    h('h3', {}, '导出给师傅'),
    h('div', { class: 'row' },
      h('button', { class: 'sm', onclick: exportView }, '导出当前视角渲染图 PNG'),
      h('button', { class: 'sm ghost', onclick: exportThickness }, '导出厚度图 PNG'),
      h('button', { class: 'sm ghost', onclick: printReport }, '打印报告'),
    ),
    h('hr', { class: 'sep' }),
    h('h3', {}, '光学参数(当前料)'),
    opticsTable(),
  );

  root.append(viewport, panel);
  lightBadge.textContent = '灯光:' + LIGHTS.find((l) => l.id === lightMode)!.label;

  function syncActive() { /* 模式按钮状态由当前 renderMode 反映 */ }

  function opticsTable() {
    const m = stone.material;
    const row = (name: string, val: string) => h('tr', {}, h('td', { class: 'muted' }, name), h('td', {}, val));
    return h('table', {},
      h('tbody', {},
        row('吸收系数 σA (1/mm)', `[${m.sigmaA.map((x) => x.toFixed(3)).join(', ')}]`),
        row('约化散射 σS (1/mm)', `[${m.sigmaS.map((x) => x.toFixed(3)).join(', ')}]`),
        row('折射率 IOR', String(m.ior)),
        row('粗糙度 / 油性', `${m.roughness} / ${m.oiliness}`),
        row('密度 g/cm³', String(m.density)),
      ),
    );
  }

  async function init() {
    if (!(await JadeRenderer.isSupported())) {
      viewport.querySelector('.status')!.textContent = '不支持 WebGPU';
      viewport.append(h('div', { class: 'gpu-error', style: 'position:absolute;inset:60px 20px' }, '当前浏览器/硬件未开启 WebGPU。请使用最新版 Chrome/Edge 并启用硬件加速。'));
      return;
    }
    const canvas = viewport.querySelector('canvas') as HTMLCanvasElement;
    const statusEl = viewport.querySelector('.status') as HTMLElement;
    renderer = new JadeRenderer();
    await renderer.init(canvas);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.resize(viewport.clientWidth, viewport.clientHeight, dpr);
    canvas.width = renderer['width']; canvas.height = renderer['height'];
    renderer.setVolume(stone.volume, stone.labels);
    renderer.maxSamples = store.settings.maxSamples;
    bindOrbit(canvas, renderer, statusEl);
    const state = (): RenderViewState => ({
      volume: stone.volume, labels: stone.labels, material: stone.material,
      renderMode, lightMode, lightPower, validationMode: false, validationThicknessMm: 10,
      crackSigma: 0.25, cottonSigma: 0.12, impuritySigma: 0.18, exposure: 1,
    });
    renderer.onConverged = (s) => (statusEl.textContent = `已收敛 · ${s} 采样`);
    renderer.start(state);
  }

  async function exportView() {
    if (!renderer) return;
    const data = await renderer.readback(renderer['width'], renderer['height']);
    const canvas = document.createElement('canvas');
    canvas.width = renderer['width']; canvas.height = renderer['height'];
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(Math.pow(Math.min(1, Math.max(0, data[i + c])), 1 / 2.2) * 255);
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    canvas.toBlob((b) => b && download(`${stone.name}-视角渲染.png`, b, 'image/png'));
    toast('渲染图已导出');
  }

  function exportThickness() {
    const thickness = computeThickness(stone.volume);
    const { canvas } = thicknessToHeatmap(thickness, stone.volume, planMinThickness());
    canvas.toBlob((b) => b && download(`${stone.name}-厚度图.png`, b, 'image/png'));
    toast('厚度图已导出(蓝=薄,红=厚,闪烁区为超薄报警)');
  }

  function planMinThickness() {
    return store.currentPlan?.minThicknessMm ?? 4;
  }

  function printReport() {
    const win = window.open('', '_blank');
    if (!win) { toast('弹窗被拦截'); return; }
    const thickness = computeThickness(stone.volume);
    const { dataUrl } = thicknessToHeatmap(thickness, stone.volume, planMinThickness());
    const m = stone.material;
    win.document.write(`<html><head><title>${stone.name} 加工报告</title>
      <style>body{font-family:'Microsoft YaHei';padding:30px;color:#222}h2{color:#8a6d3b}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #bbb;padding:7px;font-size:13px}img{max-width:480px;border:1px solid #ccc}</style>
      </head><body>
      <h2>${stone.name} · 透光与厚度报告</h2>
      <p>产地:${stone.origin} | 颜色:${stone.color} | 重量:${stone.weightG}g | 灯光:${lightMode}</p>
      <table><tr><th>σA</th><td>${m.sigmaA.join(', ')}</td><th>σS</th><td>${m.sigmaS.join(', ')}</td></tr>
      <tr><th>IOR</th><td>${m.ior}</td><th>密度</th><td>${m.density}</td></tr></table>
      <h3>厚度图(蓝薄→红厚)</h3><img src="${dataUrl}"/>
      <p style="font-size:12px;color:#666;margin-top:20px">由玉雕透光与取料推演系统生成 · Beer-Lambert 光程积分</p>
      </body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 400);
  }

  init().catch((e) => toast('初始化失败:' + e.message));
}

function bindOrbit(canvas: HTMLCanvasElement, r: JadeRenderer, statusEl: HTMLElement) {
  let down = false, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => { down = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!down) return;
    r.camera.rotate(e.clientX - lx, e.clientY - ly);
    lx = e.clientX; ly = e.clientY;
    r.markInteraction();
    statusEl.textContent = `低质量预览 · ${r.sampleCount} 采样`;
  });
  canvas.addEventListener('pointerup', () => (down = false));
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); r.camera.zoom(e.deltaY); r.markInteraction(); }, { passive: false });
}
