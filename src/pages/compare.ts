import type { CarvePlan, PlanGeometry } from '../core/types';
import { applyCarvePlan, computeCrackExposure } from '../core/carve';
import { store } from '../state/store';
import { h, mount } from '../ui/dom';
import { navigate, toast } from '../ui/shell';
import { JadeRenderer } from '../render/jadeRenderer';
import type { RenderViewState } from '../render/jadeRenderer';

export function renderComparePage(root: HTMLElement): void {
  const stone0 = store.currentStone;
  if (!stone0) { mount(root, h('div', { class: 'card' }, h('p', { class: 'muted' }, '请先选择料。'), h('button', { onclick: () => navigate('library') }, '去原料库'))); return; }
  const stone = stone0;
  const plans = store.plansFor(stone.id);

  mount(root,
    h('h2', { class: 'page-title' }, '方案对比'),
    h('p', { class: 'page-desc' }, '勾选 2–3 个方案,在同一视角、同一灯光下并排查看,并对比损料率、剩余重量与绺裂暴露。'),
  );

  if (plans.length < 2) {
    root.append(h('div', { class: 'card' }, h('p', { class: 'muted' }, '至少需要两个已保存方案才能对比。'), h('button', { onclick: () => navigate('plan') }, '去做方案')));
    return;
  }

  const selected = new Set<string>(store.comparePlanIds.filter((id) => plans.some((p) => p.id === id)).slice(0, 3));
  if (selected.size < 2) plans.slice(0, 2).forEach((p) => selected.add(p.id));

  const checkRow = h('div', { class: 'card row' },
    ...plans.map((p) => h('label', { style: 'display:flex;gap:6px;align-items:center' },
      h('input', {
        type: 'checkbox', checked: selected.has(p.id),
        onchange: (e: Event) => {
          const on = (e.target as HTMLInputElement).checked;
          if (on && selected.size >= 3) { (e.target as HTMLInputElement).checked = false; toast('最多对比 3 个方案'); return; }
          on ? selected.add(p.id) : selected.delete(p.id);
          store.comparePlanIds = [...selected];
          rebuild();
        },
      }), p.name)),
    h('button', { class: 'sm ghost', onclick: syncCameras }, '同步视角'),
  );
  root.append(checkRow);

  const cellsWrap = h('div', {});
  const metricsWrap = h('div', { class: 'card' }, h('h3', {}, '量化指标'));
  root.append(cellsWrap, metricsWrap);

  const renderers: JadeRenderer[] = [];

  function geometryFor(plan: CarvePlan): PlanGeometry {
    return applyCarvePlan(
      stone.volume, stone.labels, plan.ops, stone.material.density,
      stone.cracks, (vol, lab) => computeCrackExposure(vol, lab, stone.cracks.map((c) => c.id), () => null),
    );
  }

  async function rebuild() {
    renderers.forEach((r) => r.stop());
    renderers.length = 0;
    cellsWrap.replaceChildren();
    metricsWrap.replaceChildren(h('h3', {}, '量化指标'));
    const chosen = plans.filter((p) => selected.has(p.id)).slice(0, 3);
    if (chosen.length < 2) return;
    const grid = h('div', { class: 'grid', style: `grid-template-columns:repeat(${chosen.length},1fr)` });
    cellsWrap.append(grid);

    const table = h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '指标'), ...chosen.map((p) => h('th', {}, p.name)))));
    const tb = h('tbody', {});
    table.append(tb);
    metricsWrap.append(table);

    const geoms = chosen.map(geometryFor);
    addMetricRow(tb, '剩余重量 (g)', geoms.map((g) => String(g.remainingWeightG)));
    addMetricRow(tb, '损料率 (%)', geoms.map((g) => (g.lossRate * 100).toFixed(1)));
    addMetricRow(tb, '去除重量 (g)', geoms.map((g) => String(stone.weightG - g.remainingWeightG)));
    addMetricRow(tb, '绺裂暴露 (mm²)', geoms.map((g) => g.crackExposure.reduce((a, c) => a + c.exposedMm2, 0).toFixed(1)));
    addMetricRow(tb, '操作数', chosen.map((p) => String(p.ops.filter((o) => o.enabled).length)));

    for (let k = 0; k < chosen.length; k++) {
      const plan = chosen[k];
      const geom = geoms[k];
      const cell = h('div', { class: 'compare-cell' },
        h('b', {}, plan.name),
        h('div', { class: 'viewport-wrap', style: 'min-height:340px;margin-top:8px' },
          h('canvas', {}), h('div', { class: 'status' }, '初始化…')),
      );
      grid.append(cell);
      await initCell(cell, geom, k);
    }
  }

  function addMetricRow(tb: HTMLElement, name: string, vals: string[]) {
    tb.append(h('tr', {}, h('td', { class: 'muted' }, name), ...vals.map((v) => h('td', {}, h('b', {}, v)))));
  }

  async function initCell(cell: HTMLElement, geom: PlanGeometry, index: number) {
    if (!(await JadeRenderer.isSupported())) {
      cell.querySelector('.status')!.textContent = '不支持 WebGPU';
      return;
    }
    const canvas = cell.querySelector('canvas') as HTMLCanvasElement;
    const statusEl = cell.querySelector('.status') as HTMLElement;
    const r = new JadeRenderer();
    await r.init(canvas);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    r.resize(cell.querySelector('.viewport-wrap')!.clientWidth, 340, dpr);
    canvas.width = r['width']; canvas.height = r['height'];
    r.setVolume(geom.volume, geom.labels);
    r.maxSamples = 120;
    // 与第一个渲染器共享相机位姿,保证同视角
    if (renderers.length) {
      const ref = renderers[0].camera;
      r.camera.yaw = ref.yaw; r.camera.pitch = ref.pitch; r.camera.distance = ref.distance; r.camera.target = [...ref.target] as any;
    }
    bindOrbit(canvas, r, statusEl, () => syncCameras());
    const state = (): RenderViewState => ({
      volume: geom.volume, labels: geom.labels, material: stone.material,
      renderMode: 'transmission', lightMode: store.settings.lightMode, lightPower: store.settings.lightPower,
      validationMode: false, validationThicknessMm: 10, crackSigma: 0.25, cottonSigma: 0.12, impuritySigma: 0.18, exposure: 1,
    });
    r.start(state);
    renderers.push(r);
    void index;
  }

  function syncCameras() {
    if (renderers.length < 2) return;
    const ref = renderers[0].camera;
    for (let i = 1; i < renderers.length; i++) {
      renderers[i].camera.yaw = ref.yaw;
      renderers[i].camera.pitch = ref.pitch;
      renderers[i].camera.distance = ref.distance;
      renderers[i].camera.target = [...ref.target] as any;
      renderers[i].markInteraction();
    }
    renderers[0].markInteraction();
    toast('视角已同步');
  }

  rebuild();
}

function bindOrbit(canvas: HTMLCanvasElement, r: JadeRenderer, statusEl: HTMLElement, onMove: () => void) {
  let down = false, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => { down = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!down) return;
    r.camera.rotate(e.clientX - lx, e.clientY - ly);
    lx = e.clientX; ly = e.clientY; r.markInteraction();
    statusEl.textContent = '预览…';
    onMove();
  });
  canvas.addEventListener('pointerup', () => (down = false));
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); r.camera.zoom(e.deltaY); r.markInteraction(); onMove(); }, { passive: false });
}
