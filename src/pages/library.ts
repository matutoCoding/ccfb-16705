import type { StoneRecord } from '../core/types';
import { voxelCountWeight, generateTestStones } from '../core/stoneGenerator';
import { parseOBJ, voxelizeMesh } from '../core/objImport';
import { storage } from '../core/storage';
import { store } from '../state/store';
import { h, mount, clear } from '../ui/dom';
import { navigate, toast } from '../ui/shell';
import { uid } from '../core/vec3';
import { defaultMaterial } from '../core/materials';

export async function renderLibraryPage(root: HTMLElement): Promise<void> {
  mount(root,
    h('h2', { class: 'page-title' }, '原料库'),
    h('p', { class: 'page-desc' }, '导入原石网格,记录产地、颜色、油性与重量;每块料下挂多个雕刻方案。'),
  );

  const toolbar = h('div', { class: 'row card' },
    h('button', {
      onclick: () => importObj(),
    }, '导入原石网格 (.obj)'),
    h('button', { class: 'ghost', onclick: () => regenerate() }, '重新生成三块测试料'),
    h('span', { class: 'muted' }, '共 ' + store.stones.length + ' 块料'),
  );
  root.append(toolbar);

  const grid = h('div', { class: 'grid cols-3' });
  root.append(grid);
  drawCards(grid);

  function drawCards(container: HTMLElement) {
    clear(container);
    for (const s of store.stones) {
      const { count } = voxelCountWeight(s.volume, s.material.density);
      const planCount = store.plansFor(s.id).length;
      const selected = store.currentStoneId === s.id;
      const card = h('div', { class: 'card stone-card' + (selected ? ' selected' : '') },
        h('h3', {}, s.name),
        h('div', { class: 'muted', style: 'line-height:1.9;font-size:13px' },
          h('div', {}, '产地:' + s.origin),
          h('div', {}, '颜色:' + s.color),
          h('div', {}, '油性:', h('span', { class: 'pill gold' }, s.oiliness.toFixed(2))),
          h('div', {}, '重量:', h('b', {}, s.weightG + ' g')),
          h('div', {}, `网格:${s.volume.nx}³ · 体素 ${s.volume.voxelMm}mm · 实心 ${count} 格`),
        ),
        h('div', { class: 'row', style: 'margin-top:12px' },
          h('span', { class: 'pill' }, planCount + ' 个方案'),
          defectPill(s),
        ),
        h('div', { class: 'row', style: 'margin-top:14px' },
          h('button', { class: 'sm', onclick: (e: Event) => { e.stopPropagation(); select(s); } }, '选中'),
          h('button', { class: 'sm ghost', onclick: (e: Event) => { e.stopPropagation(); store.currentStoneId = s.id; navigate('structure'); } }, '内部结构'),
          h('button', { class: 'sm danger', onclick: (e: Event) => { e.stopPropagation(); remove(s); } }, '删除'),
        ),
      );
      card.addEventListener('click', () => select(s));
      container.append(card);
    }
  }

  function defectPill(s: StoneRecord) {
    const labels = s.labels.data;
    const has = (v: number) => labels.some((l) => l === v);
    const tags: string[] = [];
    if (has(1)) tags.push('绺裂');
    if (has(2)) tags.push('棉絮');
    if (has(3)) tags.push('糖色');
    return h('span', { class: 'pill ' + (tags.length ? 'warn' : '') }, tags.length ? tags.join('/') : '无明显缺陷');
  }

  function select(s: StoneRecord) {
    store.currentStoneId = s.id;
    store.emit();
    drawCards(grid);
    toast('已选中:' + s.name);
  }

  async function remove(s: StoneRecord) {
    if (!confirm(`删除「${s.name}」及其全部方案?`)) return;
    await storage.deleteStone(s.id);
    store.stones = store.stones.filter((x) => x.id !== s.id);
    store.plans = store.plans.filter((p) => p.stoneId !== s.id);
    if (store.currentStoneId === s.id) store.currentStoneId = store.stones[0]?.id ?? null;
    store.emit();
    drawCards(grid);
  }
}

async function importObj() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.obj';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const mesh = parseOBJ(text);
      const { volume, labels } = voxelizeMesh(mesh, 96, 0.6);
      const material = defaultMaterial();
      const { weightG } = voxelCountWeight(volume, material.density);
      const rec: StoneRecord = {
        id: uid('stone'), name: file.name.replace(/\.obj$/i, ''), origin: '待补充', color: '待补充',
        oiliness: 0.6, weightG: Math.round(weightG), createdAt: Date.now(), material, volume, labels, cracks: [],
      };
      await storage.putStone(rec);
      store.stones = await storage.allStones();
      store.currentStoneId = rec.id;
      store.emit();
      toast('导入成功');
      location.hash = 'library';
      setTimeout(() => location.reload(), 300);
    } catch (e) {
      toast('导入失败:' + (e as Error).message);
    }
  };
  input.click();
}

async function regenerate() {
  if (!confirm('重新生成三块测试料(贯穿裂 / 糖色皮 / 大片棉)?现有测试料将被替换。')) return;
  for (const s of store.stones) await storage.deleteStone(s.id);
  for (const s of generateTestStones()) await storage.putStone(s);
  store.stones = await storage.allStones();
  store.plans = await storage.allPlans();
  store.currentStoneId = store.stones[0].id;
  store.emit();
  location.reload();
}
