import { h, mount } from './dom';
import { store } from '../state/store';
import { renderLibraryPage } from '../pages/library';
import { renderStructurePage } from '../pages/structure';
import { renderPlanPage } from '../pages/plan';
import { renderRenderPage } from '../pages/renderPage';
import { renderComparePage } from '../pages/compare';
import { renderSettingsPage } from '../pages/settings';

export type Route = 'library' | 'structure' | 'plan' | 'render' | 'compare' | 'settings';

const NAV: { id: Route; label: string; icon: string }[] = [
  { id: 'library', label: '原料库', icon: '🪨' },
  { id: 'structure', label: '内部结构', icon: '🔍' },
  { id: 'plan', label: '雕刻方案', icon: '🔨' },
  { id: 'render', label: '透光渲染', icon: '💡' },
  { id: 'compare', label: '方案对比', icon: '⚖️' },
  { id: 'settings', label: '设置', icon: '⚙️' },
];

const RENDERERS: Record<Route, (el: HTMLElement) => Promise<void> | void> = {
  library: renderLibraryPage,
  structure: renderStructurePage,
  plan: renderPlanPage,
  render: renderRenderPage,
  compare: renderComparePage,
  settings: renderSettingsPage,
};

export function navigate(route: Route): void {
  location.hash = route;
}

export async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  const aside = h('aside');
  const main = h('main');
  mount(app, aside, main);

  const brand = h('div', { class: 'brand' }, '玉雕透光推演', h('small', {}, 'Jade Light Studio · WebGPU'));
  const navEls = new Map<Route, HTMLElement>();
  const nav = h('nav', { style: 'display:flex;flex-direction:column;gap:4px' });
  for (const item of NAV) {
    const el = h('div', { class: 'nav-item' }, h('span', { class: 'ico' }, item.icon), item.label);
    el.addEventListener('click', () => navigate(item.id));
    navEls.set(item.id, el);
    nav.append(el);
  }
  const foot = h('div', { class: 'sidebar-foot' }, '体素光程 + Beer-Lambert', h('br'), '透光解析误差 < 5%');
  mount(aside, brand, nav, foot);

  let current: Route | null = null;
  const route = (): Route => {
    const r = location.hash.replace('#', '') as Route;
    return NAV.some((n) => n.id === r) ? r : 'library';
  };

  const render = async () => {
    const r = route();
    if (r === current) return;
    current = r;
    navEls.forEach((el, id) => el.classList.toggle('active', id === r));
    main.replaceChildren();
    try {
      await RENDERERS[r](main);
    } catch (err) {
      console.error(err);
      main.append(h('div', { class: 'gpu-error' }, `页面渲染失败:${(err as Error).message}`));
    }
  };
  window.addEventListener('hashchange', render);
  store.subscribe(() => {});
  await render();
}

export function toast(msg: string): void {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}
