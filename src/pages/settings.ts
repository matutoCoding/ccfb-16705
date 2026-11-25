import type { RenderSettings } from '../core/types';
import { store } from '../state/store';
import { storage } from '../core/storage';
import { h, mount } from '../ui/dom';
import { toast } from '../ui/shell';
import { validateTransmission, analyticSelfCheck } from '../core/validation';
import type { MediumOptics } from '../core/volume';
import { JadeRenderer } from '../render/jadeRenderer';
import type { RenderViewState } from '../render/jadeRenderer';

export function renderSettingsPage(root: HTMLElement): void {
  const s = store.settings;
  mount(root,
    h('h2', { class: 'page-title' }, '设置与精度校验'),
    h('p', { class: 'page-desc' }, '调整渐进渲染与灯光默认值;运行 Beer-Lambert 解析校验,验证"厚度翻倍、透光指数衰减、误差 < 5%"。'),
  );

  // ---- 渲染参数 ----
  const renderCard = h('div', { class: 'card' },
    h('h3', {}, '渐进渲染'),
    rangeField('收敛采样上限', 'maxSamples', 64, 1024, 8, (v) => `${v} spp`),
    rangeField('静止收敛时间(参考)', 'convergeSeconds', 0.5, 8, 0.5, (v) => `${v.toFixed(1)} s`),
    rangeField('预览缩放', 'previewScale', 0.25, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
    rangeField('默认灯光功率', 'lightPower', 0.3, 3, 0.05, (v) => v.toFixed(2)),
    h('div', { class: 'row' },
      h('button', { onclick: save }, '保存设置'),
      h('span', { class: 'muted' }, '默认灯光模式:'),
      lightSelect(),
    ),
  );
  root.append(renderCard);

  // ---- CPU 解析校验 ----
  const cpuCard = h('div', { class: 'card' },
    h('h3', {}, '① CPU 解析校验(CI / 无 GPU 可跑)'),
    h('p', { class: 'muted', style: 'font-size:13px' }, '在当前料内部取实心参考区,用体素 DDA 光程积分与 Beer-Lambert 解析值逐厚度、逐通道比对。'),
    h('button', { onclick: runCpu }, '运行 CPU 校验'),
    h('div', { id: 'cpu-result', style: 'margin-top:14px' }),
  );
  root.append(cpuCard);

  // ---- GPU 校验板 ----
  const gpuCard = h('div', { class: 'card' },
    h('h3', {}, '② GPU 渲染校验板(确定性解析模式)'),
    h('p', { class: 'muted', style: 'font-size:13px' }, '关闭随机散射,GPU 着色器对已知厚度板输出纯 exp(-σd),回读像素与解析值对比。'),
    h('div', { class: 'viewport-wrap', style: 'min-height:300px' }, h('canvas', {}), h('div', { class: 'status' }, '待运行')),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { onclick: runGpu }, '运行 GPU 校验板'),
      h('span', { class: 'muted' }, '板厚(mm):'),
      thicknessSelect(),
    ),
    h('div', { id: 'gpu-result', style: 'margin-top:14px' }),
  );
  root.append(gpuCard);

  // ---- 数学自检 ----
  const self = analyticSelfCheck(0.02);
  root.append(h('div', { class: 'card' },
    h('h3', {}, '③ 厚度翻倍指数衰减自检'),
    h('p', {}, `σ=0.02/mm,d=10mm:T(2d)/T(d)=${self.doublingRatio.toFixed(5)},解析期望 exp(-σd)=${self.expected.toFixed(5)},误差 ${self.errorPct.toExponential(2)}%`),
    h('p', { class: self.errorPct < 5 ? 'ok-text' : 'warn-text' }, self.errorPct < 5 ? '✓ 严格满足指数衰减(浮点级误差)' : '✗ 超差'),
  ));

  function rangeField(label: string, key: keyof RenderSettings, min: number, max: number, step: number, fmt: (v: number) => string) {
    const val = s[key] as number;
    const out = h('div', {}, h('span', { class: 'muted' }, label), h('b', { id: `lbl-${key}` }, ' ' + fmt(val)));
    const input = h('input', { type: 'range', min, max, step, value: val, oninput: (e: Event) => {
      const v = +(e.target as HTMLInputElement).value;
      (s as any)[key] = v;
      document.getElementById(`lbl-${key}`)!.textContent = ' ' + fmt(v);
    } });
    return h('label', { class: 'field' }, out, input);
  }
  function lightSelect() {
    const names: Record<string, string> = { backlight: '背后手电', sidelight: '侧面台灯', ambient: '环境顶光' };
    return h('select', { style: 'width:160px', onchange: (e: Event) => (s.lightMode = (e.target as HTMLSelectElement).value as any) },
      ...(['backlight', 'sidelight', 'ambient'] as const).map((m) => h('option', { value: m, selected: s.lightMode === m ? '' : undefined }, names[m])));
  }
  function thicknessSelect() {
    return h('select', { style: 'width:120px', id: 'slab-thick' }, ...s.validationThicknesses.map((d: number) => h('option', { value: d }, d + ' mm')));
  }

  async function save() {
    await storage.saveSettings(s);
    toast('设置已保存');
  }

  function optics(): MediumOptics | null {
    const stone = store.currentStone;
    if (!stone) return null;
    return { sigmaA: stone.material.sigmaA, crackSigma: 0.25, cottonSigma: 0.12, impuritySigma: 0.18 };
  }

  function runCpu() {
    const stone = store.currentStone;
    const box = document.getElementById('cpu-result')!;
    if (!stone) { box.replaceChildren(h('p', { class: 'warn-text' }, '请先在原料库选择一块料')); return; }
    const opt = optics()!;
    const report = validateTransmission(stone.volume, stone.labels, opt, s.validationThicknesses, 5);
    const rows = report.points.map((p) => h('tr', {},
      h('td', {}, p.thicknessMm + ' mm'),
      h('td', {}, p.analytic.map((x) => x.toFixed(4)).join(', ')),
      h('td', {}, p.measured.map((x) => x.toFixed(4)).join(', ')),
      h('td', { class: Math.max(...p.errorPct) <= 5 ? 'ok-text' : 'warn-text' }, p.errorPct.map((x) => x.toFixed(2) + '%').join(', ')),
    ));
    const doubleRows = report.doublingChecks.map((d) => h('tr', {},
      h('td', {}, d.thickness + '→' + d.thickness * 2 + ' mm'),
      h('td', {}, d.ratio.map((x) => x.toFixed(4)).join(', ')),
      h('td', {}, d.expectedRatio.map((x) => x.toFixed(4)).join(', ')),
      h('td', { class: Math.max(...d.errorPct) <= 5 ? 'ok-text' : 'warn-text' }, d.errorPct.map((x) => x.toExponential(1) + '%').join(', ')),
    ));
    box.replaceChildren(
      h('div', { class: 'big-number ' + (report.passed ? 'ok-text' : 'warn-text') }, report.passed ? '✓ 通过' : '✗ 超差',
        h('span', { style: 'font-size:14px;margin-left:10px' }, `最大误差 ${report.maxErrorPct.toFixed(2)}% / 平均 ${report.meanErrorPct.toFixed(2)}% / 阈值 ${report.thresholdPct}%`)),
      h('h4', { style: 'margin:14px 0 6px' }, '透射率:解析值 vs DDA 积分值(RGB)'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '厚度'), h('th', {}, '解析 T'), h('th', {}, 'DDA T'), h('th', {}, '误差'))), h('tbody', {}, ...rows)),
      h('h4', { style: 'margin:14px 0 6px' }, '厚度翻倍:透射比 vs exp(-σd)'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '厚度'), h('th', {}, 'T(2d)/T(d)'), h('th', {}, 'exp(-σd)'), h('th', {}, '误差'))), h('tbody', {}, ...doubleRows)),
    );
  }

  async function runGpu() {
    const stone = store.currentStone;
    const box = document.getElementById('gpu-result')!;
    const statusEl = gpuCard.querySelector('.status') as HTMLElement;
    if (!stone) { box.replaceChildren(h('p', { class: 'warn-text' }, '请先选择料')); return; }
    if (!(await JadeRenderer.isSupported())) { box.replaceChildren(h('p', { class: 'warn-text' }, '当前环境不支持 WebGPU,无法运行 GPU 校验(CPU 校验仍然有效)')); return; }

    const thickness = +(document.getElementById('slab-thick') as HTMLSelectElement).value;
    const canvas = gpuCard.querySelector('canvas') as HTMLCanvasElement;
    const r = new JadeRenderer();
    await r.init(canvas);
    const wrap = gpuCard.querySelector('.viewport-wrap')!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    r.resize(wrap.clientWidth, 300, dpr);
    canvas.width = r['width']; canvas.height = r['height'];
    r.setVolume(stone.volume, stone.labels);
    r.maxSamples = 32;
    const state = (): RenderViewState => ({
      volume: stone.volume, labels: stone.labels, material: stone.material,
      renderMode: 'material', lightMode: 'backlight', lightPower: 1,
      validationMode: true, validationThicknessMm: thickness,
      crackSigma: 0.25, cottonSigma: 0.12, impuritySigma: 0.18, exposure: 1,
    });
    r.start(state);
    statusEl.textContent = '校验板累加中…';
    await new Promise((res) => setTimeout(res, 900));
    const data = await r.readback(r['width'], r['height']);
    // 取中心区域平均(线性累积值,未 tone map)
    const w = r['width'], hh = r['height'];
    let ar = 0, ag = 0, ab = 0, n = 0;
    for (let y = hh * 0.3; y < hh * 0.7; y++)
      for (let x = w * 0.3; x < w * 0.7; x++) {
        const i = (y | 0) * w + (x | 0);
        ar += data[i * 4]; ag += data[i * 4 + 1]; ab += data[i * 4 + 2]; n++;
      }
    ar /= n; ag /= n; ab /= n;
    const analytic = stone.material.sigmaA.map((sig: number) => Math.exp(-sig * thickness));
    const measured: number[] = [ar, ag, ab];
    const err = analytic.map((a: number, c: number) => (Math.abs(measured[c] - a) / a) * 100);
    const passed = Math.max(...err) <= 5;
    r.stop();
    statusEl.textContent = '校验完成';
    box.replaceChildren(
      h('div', { class: 'big-number ' + (passed ? 'ok-text' : 'warn-text') }, passed ? '✓ GPU 校验通过' : '✗ GPU 超差'),
      h('table', { style: 'margin-top:10px' }, h('tbody', {},
        h('tr', {}, h('td', { class: 'muted' }, '板厚'), h('td', {}, thickness + ' mm')),
        h('tr', {}, h('td', { class: 'muted' }, 'GPU 透射 RGB'), h('td', {}, measured.map((x) => x.toFixed(4)).join(', '))),
        h('tr', {}, h('td', { class: 'muted' }, '解析 exp(-σd)'), h('td', {}, analytic.map((x) => x.toFixed(4)).join(', '))),
        h('tr', {}, h('td', { class: 'muted' }, '相对误差'), h('td', { class: passed ? 'ok-text' : 'warn-text' }, err.map((x) => x.toFixed(2) + '%').join(', '))),
      )),
    );
  }
}
