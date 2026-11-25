import type { CarvePlan, RenderSettings, StoneRecord } from '../core/types';
import { defaultSettings } from '../core/storage';

type Listener = () => void;

/** 极简集中状态 + 发布订阅,页面据此重渲染 */
class AppStore {
  stones: StoneRecord[] = [];
  plans: CarvePlan[] = [];
  settings: RenderSettings = defaultSettings();
  currentStoneId: string | null = null;
  currentPlanId: string | null = null;
  /** 对比页选中的方案 id(最多 3) */
  comparePlanIds: string[] = [];
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  get currentStone(): StoneRecord | null {
    return this.stones.find((s) => s.id === this.currentStoneId) ?? null;
  }
  get currentPlan(): CarvePlan | null {
    return this.plans.find((p) => p.id === this.currentPlanId) ?? null;
  }
  plansFor(stoneId: string): CarvePlan[] {
    return this.plans.filter((p) => p.stoneId === stoneId);
  }
}

export const store = new AppStore();
