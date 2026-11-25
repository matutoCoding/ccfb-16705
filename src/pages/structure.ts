import type { CrackSheet, VoxelLabel } from '../core/types';
import { VoxelLabel as VL } from '../core/types';
import { idx } from '../core/volume';
import { storage } from '../core/storage';
import { store } from '../state/store';
import { h, mount, download } from '../ui/dom';
import { navigate, toast } from '../ui/shell';
import { uid } from '../core/vec3';
import { importRawVolume, exampleRawVolumeJSON } from '../core/volumeImport';

type Axis = 0 | 1 | 2;
const AXIS_NAME = ['X 切面', 'Y 切面', 'Z 切面'];

export function renderStructurePage(root: HTMLElement): void {
  const stone0 = store.currentStone;
  if (!stone0) { emptyState(root); return; }
  const stone = stone0;

  let axis: Axis = 0;
  let slice = Math.floor(dim(axis) / 2);
  let brush: VoxelLabel = VL.Crack;
  let brushSize = 2;
  let painting = false;

  function dim(a: Axis): number {
    return a === 0 ? stone.volume.nx : a === 1 ? stone.volume.ny : stone.volume.nz;
  }

  mount(root,
    h('h2', { class: 'page-title' }, '内部结构 · ' + stone.name),
    h('p', { class: 'page-desc' }, '在切片上逐层绘制绺裂面、棉絮与杂色;也可导入简单体数据(.json)。绘制结果实时写入标签网格并参与透光计算。'),
  );

  const canvas = h('canvas', { class: 'slice-canvas', width: 420, height: 420 }) as HTMLCanvasElement;
  const status = h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' });
  const sliceLabel = h('span', {}, '');

  const card = h('div', { class: 'card' },
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      ...([0, 1, 2] as Axis[]).map((a) => h('button', {
        class: 'ghost sm' + (a === axis ? '' : ''),
        onclick: () => { axis = a; slice = Math.floor(dim(a) / 2); slider.value = String(slice); draw(); },
      }, AXIS_NAME[a])),
    ),
    h('div', { class: 'row' },
      h('input', {
        type: 'range', min: 0, max: dim(axis) - 1, value: slice,
        oninput: (e: Event) => { slice = +(e.target as HTMLInputElement).value; draw(); },
      }),
      sliceLabel,
    ),
    h('div', { class: 'row', style: 'margin:12px 0' },
      brushBtn('绺裂', VL.Crack),
      brushBtn('棉絮', VL.Cotton),
      brushBtn('杂色/糖色', VL.Impurity),
      brushBtn('橡皮擦(玉肉)', VL.Jade),
      h('span', { class: 'muted' }, '笔刷半径'),
      h('input', { type: 'number', min: 1, max: 8, value: 2, style: 'width:70px', oninput: (e: Event) => (brushSize = +(e.target as HTMLInputElement).value) }),
    ),
    canvas,
    status,
  );

  const slider = card.querySelector('input[type=range]') as HTMLInputElement;

  const info = h('div', { class: 'card' },
    h('h3', {}, '缺陷统计'),
    h('div', { id: 'defect-stats' }),
    h('hr', { class: 'sep' }),
    h('h3', {}, '绺裂面登记'),
    h('div', { id: 'crack-list' }),
    h('button', { class: 'sm ghost', style: 'margin-top:8px', onclick: registerCrack }, '把当前切片登记为绺裂面'),
    h('hr', { class: 'sep' }),
    h('h3', {}, '体数据'),
    h('div', { class: 'row' },
      h('button', { class: 'sm ghost', onclick: importVolume }, '导入体数据 JSON'),
      h('button', { class: 'sm ghost', onclick: () => download('example-volume.json', exampleRawVolumeJSON(), 'application/json') }, '下载体数据样例'),
    ),
    h('hr', { class: 'sep' }),
    h('div', { class: 'row' },
      h('button', { onclick: save }, '保存修改'),
      h('button', { class: 'ghost', onclick: () => navigate('render') }, '去透光渲染'),
    ),
  );

  const wrap = h('div', { class: 'grid cols-2' }, card, info);
  root.append(wrap);

  function brushBtn(label: string, v: VoxelLabel) {
    return h('button', {
      class: 'sm', onclick: () => { brush = v; draw(); },
    }, label);
  }

  function cellXY(u: number, v: number): [number, number, number] {
    // 把切面二维 (u,v) 映射回三维体素
    if (axis === 0) return [slice, u, v];
    if (axis === 1) return [u, slice, v];
    return [u, v, slice];
  }
  function planeDims(): [number, number] {
    return axis === 0 ? [stone.volume.ny, stone.volume.nz]
      : axis === 1 ? [stone.volume.nx, stone.volume.nz]
        : [stone.volume.nx, stone.volume.ny];
  }

  function draw() {
    slider.max = String(dim(axis) - 1);
    const [pu, pv] = planeDims();
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(pu, pv);
    for (let v = 0; v < pv; v++)
      for (let u = 0; u < pu; u++) {
        const [x, y, z] = cellXY(u, v);
        const i = idx(stone.volume, x, y, z);
        const inside = stone.volume.sdf[i] < 0;
        const lab = stone.labels.data[i];
        const o = (v * pu + u) * 4;
        if (!inside) { img.data[o] = 12; img.data[o + 1] = 15; img.data[o + 2] = 20; }
        else if (lab === VL.Crack) { img.data[o] = 255; img.data[o + 1] = 90; img.data[o + 2] = 60; }
        else if (lab === VL.Cotton) { img.data[o] = 230; img.data[o + 1] = 235; img.data[o + 2] = 245; }
        else if (lab === VL.Impurity) { img.data[o] = 180; img.data[o + 1] = 120; img.data[o + 2] = 60; }
        else { img.data[o] = 120; img.data[o + 1] = 150; img.data[o + 2] = 140; }
        img.data[o + 3] = 255;
      }
    // 放大绘制
    const off = document.createElement('canvas');
    off.width = pu; off.height = pv;
    off.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
    sliceLabel.textContent = `${AXIS_NAME[axis]} 第 ${slice}/${dim(axis) - 1} 层 · 笔刷:${['玉肉', '绺裂', '棉絮', '杂色'][brush]}`;
    drawStats();
  }

  function paintAt(e: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    const [pu, pv] = planeDims();
    const u = Math.floor(((e.clientX - rect.left) / rect.width) * pu);
    const v = Math.floor(((e.clientY - rect.top) / rect.height) * pv);
    for (let dv = -brushSize; dv <= brushSize; dv++)
      for (let du = -brushSize; du <= brushSize; du++) {
        if (du * du + dv * dv > brushSize * brushSize) continue;
        const [x, y, z] = cellXY(u + du, v + dv);
        if (x < 0 || y < 0 || z < 0) continue;
        if (x >= stone.volume.nx || y >= stone.volume.ny || z >= stone.volume.nz) continue;
        const i = idx(stone.volume, x, y, z);
        if (stone.volume.sdf[i] < 0) stone.labels.data[i] = brush;
      }
    draw();
  }

  canvas.addEventListener('pointerdown', (e) => { painting = true; paintAt(e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => painting && paintAt(e));
  canvas.addEventListener('pointerup', () => (painting = false));

  function drawStats() {
    const counts = [0, 0, 0, 0];
    for (const l of stone.labels.data) counts[l]++;
    const el = document.getElementById('defect-stats');
    if (el) el.innerHTML = '';
    el?.append(
      h('div', { class: 'legend' },
        h('span', {}, h('i', { style: 'background:#ff5a3c' }), `绺裂 ${counts[VL.Crack]} 格`),
        h('span', {}, h('i', { style: 'background:#e6ebf5' }), `棉絮 ${counts[VL.Cotton]} 格`),
        h('span', {}, h('i', { style: 'background:#b4783c' }), `杂色 ${counts[VL.Impurity]} 格`),
      ),
    );
    const list = document.getElementById('crack-list');
    if (list) list.replaceChildren(...stone.cracks.map((c) =>
      h('div', { class: 'op-row' },
        h('span', {}, c.name),
        h('span', { class: 'pill' }, `${AXIS_NAME[c.axis]} #${c.slice}`),
        h('span', { class: 'muted' }, `宽 ${c.widthMm}mm`),
        h('button', { class: 'sm danger', onclick: () => { stone.cracks = stone.cracks.filter((x) => x.id !== c.id); drawStats(); } }, '移除'),
      )));
  }

  function registerCrack() {
    const sheet: CrackSheet = {
      id: uid('crack'), name: `绺裂 ${stone.cracks.length + 1}`,
      axis, slice, polygon: [], widthMm: 1.2,
    };
    stone.cracks.push(sheet);
    drawStats();
    toast('已登记绺裂面(绘制的红色区域即其形态)');
  }

  async function save() {
    await storage.putStone(stone);
    store.stones = store.stones.map((s) => (s.id === stone.id ? stone : s));
    toast('内部结构已保存');
  }

  function importVolume() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const raw = JSON.parse(await file.text());
        const { volume, labels } = importRawVolume(raw);
        stone.volume = volume; stone.labels = labels; stone.cracks = [];
        await save();
        location.reload();
      } catch (e) { toast('导入失败:' + (e as Error).message); }
    };
    input.click();
  }

  draw();
}

function emptyState(root: HTMLElement) {
  mount(root,
    h('h2', { class: 'page-title' }, '内部结构'),
    h('div', { class: 'card' },
      h('p', { class: 'muted' }, '请先在原料库选择一块料。'),
      h('button', { onclick: () => navigate('library') }, '去原料库'),
    ),
  );
}
