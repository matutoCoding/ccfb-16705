import type { CarveOp, CarvePlan, PlanGeometry } from '../core/types';
import { applyCarvePlan, computeCrackExposure, computeThickness, findThinVoxels } from '../core/carve';
import { storage } from '../core/storage';
import { store } from '../state/store';
import { h, mount } from '../ui/dom';
import { navigate, toast } from '../ui/shell';
import { uid } from '../core/vec3';
import { JadeRenderer } from '../render/jadeRenderer';
import type { RenderViewState } from '../render/jadeRenderer';

export function renderPlanPage(root: HTMLElement): void {
  const stone0 = store.currentStone;
  if (!stone0) { mount(root, needStone()); return; }
  const stone = stone0;

  let plan: CarvePlan = store.currentPlan && store.currentPlan.stoneId === stone.id
    ? structuredClone(store.currentPlan)
    : newPlan(stone.id);
  let geometry: PlanGeometry | null = null;
  let thickness: Float32Array | null = null;
  let renderer: JadeRenderer | null = null;

  mount(root,
    h('h2', { class: 'page-title' }, '雕刻方案'),
    h('p', { class: 'page-desc' }, '布尔减料 / 浮雕 / 镂空;厚度以色带实时显示,薄于下限的位置报警;系统统计每条绺裂被暴露的面积。'),
  );

  const statusBar = h('div', { class: 'row', style: 'margin-bottom:12px' },
    h('span', { class: 'pill' }, '当前方案:'),
    h('input', { value: plan.name, style: 'width:200px', oninput: (e: Event) => (plan.name = (e.target as HTMLInputElement).value) }),
    h('button', { class: 'sm ghost', onclick: loadOther }, '载入其它方案'),
    h('button', { class: 'sm ghost', onclick: () => { plan = newPlan(stone.id); refresh(); } }, '新建方案'),
  );

  const viewport = h('div', { class: 'viewport-wrap', style: 'min-height:520px' },
    h('canvas', {}),
    h('div', { class: 'status' }, '初始化 WebGPU…'),
  );

  const opList = h('div', {});
  const stats = h('div', {});
  const panel = h('div', { class: 'card' },
    h('h3', {}, '雕刻操作'),
    h('div', { class: 'row' },
      addBtn('布尔减料', 'subtract'),
      addBtn('浮雕', 'relief'),
      addBtn('镂空', 'hollow'),
    ),
    opList,
    h('hr', { class: 'sep' }),
    h('label', { class: 'field' },
      h('span', {}, `厚度报警下限:${plan.minThicknessMm} mm`),
      h('input', { type: 'range', min: 1, max: 12, step: 0.5, value: plan.minThicknessMm, oninput: (e: Event) => { plan.minThicknessMm = +(e.target as HTMLInputElement).value; recompute(); } }),
    ),
    stats,
    h('hr', { class: 'sep' }),
    h('div', { class: 'row' },
      h('button', { onclick: save }, '保存方案'),
      h('button', { class: 'ghost', onclick: () => navigate('render') }, '去透光渲染'),
      h('button', { class: 'ghost', onclick: () => navigate('compare') }, '去方案对比'),
    ),
  );

  root.append(statusBar, h('div', { class: 'grid cols-2' }, viewport, panel));

  function addBtn(label: string, type: CarveOp['type']) {
    return h('button', { class: 'sm', onclick: () => addOp(type) }, label);
  }

  function newOp(type: CarveOp['type']): CarveOp {
    const c = Math.floor(stone.volume.nx / 2);
    return {
      id: uid('op'), type, shape: type === 'hollow' ? 'box' : 'sphere',
      center: [c, c, c], size: type === 'hollow' ? [40, 40, 40] : [12, 12, 12],
      displacement: type === 'relief' ? 3 : 0, wall: 6, enabled: true,
    };
  }
  function addOp(type: CarveOp['type']) { plan.ops.push(newOp(type)); refresh(); }

  function drawOps() {
    opList.replaceChildren();
    if (!plan.ops.length) opList.append(h('p', { class: 'muted' }, '暂无操作,点击上方按钮添加。'));
    plan.ops.forEach((op, k) => {
      const row = h('div', { class: 'op-row' },
        h('input', { type: 'checkbox', checked: op.enabled, onchange: (e: Event) => { op.enabled = (e.target as HTMLInputElement).checked; refresh(); } }),
        h('b', { style: 'min-width:64px' }, typeName(op.type)),
        shapeSelect(op),
        h('span', { class: 'muted' }, '中心'),
        ...vecInputs(op.center, () => refresh()),
        h('span', { class: 'muted' }, '尺寸'),
        ...vecInputs(op.size, () => refresh()),
        op.type === 'relief' ? numField('位移', op.displacement ?? 0, (v) => { op.displacement = v; refresh(); }) : null,
        op.type === 'hollow' ? numField('壁厚', op.wall ?? 6, (v) => { op.wall = v; refresh(); }) : null,
        h('button', { class: 'sm danger', onclick: () => { plan.ops.splice(k, 1); refresh(); } }, '删'),
      );
      opList.append(row);
    });
  }

  function shapeSelect(op: CarveOp) {
    return h('select', { onchange: (e: Event) => { op.shape = (e.target as HTMLSelectElement).value as CarveOp['shape']; refresh(); } },
      ...['sphere', 'box', 'cylinder'].map((s) => h('option', { value: s, selected: op.shape === s ? '' : undefined }, shapeName(s))),
    );
  }

  function vecInputs(v: number[], onChange: () => void) {
    return v.map((val, i) => h('input', {
      type: 'number', value: val,
      oninput: (e: Event) => { v[i] = +(e.target as HTMLInputElement).value; onChange(); },
    }));
  }
  function numField(label: string, val: number, cb: (v: number) => void) {
    return h('label', { style: 'display:flex;align-items:center;gap:4px' },
      h('span', { class: 'muted', style: 'margin:0' }, label),
      h('input', { type: 'number', value: val, oninput: (e: Event) => cb(+(e.target as HTMLInputElement).value) }),
    );
  }

  function recompute() {
    geometry = applyCarvePlan(
      stone.volume, stone.labels, plan.ops, stone.material.density,
      stone.cracks,
      (vol, lab) => computeCrackExposure(vol, lab, stone.cracks.map((c) => c.id), () => null),
    );
    thickness = computeThickness(geometry.volume);
    const thin = findThinVoxels(thickness, plan.minThicknessMm);
    drawStats(geometry, thin);
    if (renderer) renderer.setVolume(geometry.volume, geometry.labels);
  }

  function drawStats(g: PlanGeometry, thin: number[]) {
    stats.replaceChildren();
    const minT = Math.min(...thickness!.filter((t) => t > 0));
    stats.append(
      h('div', { class: 'grid cols-2' },
        stat('剩余重量', g.remainingWeightG + ' g'),
        stat('损料率', (g.lossRate * 100).toFixed(1) + '%'),
        stat('最薄处', minT.toFixed(1) + ' mm', minT < plan.minThicknessMm),
        stat('超薄报警体素', thin.length + ' 格', thin.length > 0),
      ),
      h('h3', { style: 'margin-top:14px' }, '绺裂暴露面积'),
    );
    if (!stone.cracks.length) {
      stats.append(h('p', { class: 'muted' }, '该料未登记绺裂。'));
    } else {
      const table = h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '绺裂'), h('th', {}, '暴露面积'), h('th', {}, '总面积'), h('th', {}, '暴露比例'))));
      const tb = h('tbody', {});
      for (const c of g.crackExposure) {
        const ratio = c.totalMm2 ? c.exposedMm2 / c.totalMm2 : 0;
        tb.append(h('tr', {},
          h('td', {}, stone.cracks.find((x) => x.id === c.crackId)?.name ?? c.crackId),
          h('td', { class: ratio > 0.1 ? 'warn-text' : '' }, c.exposedMm2.toFixed(1) + ' mm²'),
          h('td', {}, c.totalMm2.toFixed(1) + ' mm²'),
          h('td', {}, (ratio * 100).toFixed(1) + '%'),
        ));
      }
      table.append(tb);
      stats.append(table, h('p', { class: 'muted', style: 'font-size:12px' }, '提示:把绺裂藏进雕刻凹处(被玉肉包裹)可降低暴露比例。'));
    }
  }

  function stat(label: string, value: string, warn = false) {
    return h('div', {}, h('div', { class: 'muted', style: 'font-size:12px' }, label), h('div', { class: 'metric' + (warn ? ' warn' : '') }, value));
  }

  async function ensureRenderer() {
    if (renderer) return;
    const canvas = viewport.querySelector('canvas') as HTMLCanvasElement;
    const statusEl = viewport.querySelector('.status') as HTMLElement;
    if (!(await JadeRenderer.isSupported())) {
      statusEl.textContent = '当前浏览器不支持 WebGPU';
      return;
    }
    renderer = new JadeRenderer();
    await renderer.init(canvas);
    const parent = viewport;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.resize(parent.clientWidth, parent.clientHeight, dpr);
    canvas.width = renderer['width']; canvas.height = renderer['height'];
    bindOrbit(canvas, renderer);
    const state = (): RenderViewState => ({
      volume: geometry!.volume, labels: geometry!.labels, material: stone.material,
      renderMode: 'thickness', lightMode: store.settings.lightMode, lightPower: store.settings.lightPower,
      validationMode: false, validationThicknessMm: 10, crackSigma: 0.25, cottonSigma: 0.12, impuritySigma: 0.18, exposure: 1,
    });
    renderer.maxSamples = store.settings.maxSamples;
    renderer.start(state);
  }

  function refresh() {
    (statusBar.querySelector('input') as HTMLInputElement);
    drawOps();
    recompute();
  }

  async function save() {
    plan.name = plan.name || '未命名方案';
    store.currentPlanId = plan.id;
    await storage.putPlan(plan);
    store.plans = await storage.allPlans();
    toast('方案已保存');
  }

  function loadOther() {
    const others = store.plansFor(stone.id);
    if (!others.length) { toast('该料还没有已保存方案'); return; }
    const name = prompt('载入哪个方案?\n' + others.map((p, i) => `${i + 1}. ${p.name}`).join('\n'), '1');
    const k = parseInt(name || '0', 10) - 1;
    if (others[k]) { plan = structuredClone(others[k]); store.currentPlanId = plan.id; refresh(); }
  }

  refresh();
  ensureRenderer().catch((e) => toast('渲染器初始化失败:' + e.message));
}

function bindOrbit(canvas: HTMLCanvasElement, r: JadeRenderer) {
  let down = false, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => { down = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!down) return;
    r.camera.rotate(e.clientX - lx, e.clientY - ly);
    lx = e.clientX; ly = e.clientY; r.markInteraction();
  });
  canvas.addEventListener('pointerup', () => (down = false));
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); r.camera.zoom(e.deltaY); r.markInteraction(); }, { passive: false });
}

function newPlan(stoneId: string): CarvePlan {
  return { id: uid('plan'), stoneId, name: '方案 ' + new Date().toLocaleString('zh-CN', { hour12: false }), createdAt: Date.now(), ops: [], minThicknessMm: 4 };
}
function typeName(t: string) { return t === 'subtract' ? '减料' : t === 'relief' ? '浮雕' : '镂空'; }
function shapeName(s: string) { return s === 'sphere' ? '球' : s === 'box' ? '盒' : '圆柱'; }
function needStone() {
  return h('div', { class: 'card' }, h('p', { class: 'muted' }, '请先在原料库选择一块料。'), h('button', { onclick: () => navigate('library') }, '去原料库'));
}
