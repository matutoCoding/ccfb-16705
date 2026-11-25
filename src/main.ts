import './ui/styles.css';
import { boot } from './ui/shell';
import { storage } from './core/storage';
import { store } from './state/store';
import { generateTestStones } from './core/stoneGenerator';

async function seed() {
  const existing = await storage.allStones();
  if (existing.length === 0) {
    const stones = generateTestStones();
    for (const s of stones) await storage.putStone(s);
  }
  store.stones = await storage.allStones();
  store.plans = await storage.allPlans();
  const saved = await storage.loadSettings();
  if (saved) store.settings = saved;
  if (store.stones.length && !store.currentStoneId) store.currentStoneId = store.stones[0].id;
}

seed().then(boot).catch((err) => {
  document.getElementById('app')!.innerHTML =
    `<div class="gpu-error" style="margin:24px">初始化失败:${err.message}<br>请确认浏览器支持 IndexedDB 与 WebGPU。</div>`;
});
