import type { CarvePlan, RenderSettings, StoneRecord } from './types';

const DB_NAME = 'jade-light-studio';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('stones')) db.createObjectStore('stones', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('plans')) db.createObjectStore('plans', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const storage = {
  async putStone(s: StoneRecord): Promise<void> {
    await tx('stones', 'readwrite', (st) => st.put(s as any));
  },
  async getStone(id: string): Promise<StoneRecord | undefined> {
    return tx('stones', 'readonly', (st) => st.get(id) as IDBRequest<StoneRecord | undefined>);
  },
  async allStones(): Promise<StoneRecord[]> {
    return tx('stones', 'readonly', (st) => st.getAll() as IDBRequest<StoneRecord[]>);
  },
  async deleteStone(id: string): Promise<void> {
    await tx('stones', 'readwrite', (st) => st.delete(id));
    const plans = await this.allPlans();
    await Promise.all(plans.filter((p) => p.stoneId === id).map((p) => this.deletePlan(p.id)));
  },

  async putPlan(p: CarvePlan): Promise<void> {
    await tx('plans', 'readwrite', (st) => st.put(p as any));
  },
  async allPlans(): Promise<CarvePlan[]> {
    return tx('plans', 'readonly', (st) => st.getAll() as IDBRequest<CarvePlan[]>);
  },
  async plansForStone(stoneId: string): Promise<CarvePlan[]> {
    const all = await this.allPlans();
    return all.filter((p) => p.stoneId === stoneId);
  },
  async deletePlan(id: string): Promise<void> {
    await tx('plans', 'readwrite', (st) => st.delete(id));
  },

  async saveSettings(s: RenderSettings): Promise<void> {
    await tx('settings', 'readwrite', (st) => st.put({ id: 'global', ...s } as any));
  },
  async loadSettings(): Promise<RenderSettings | undefined> {
    const row = await tx('settings', 'readonly', (st) => st.get('global') as IDBRequest<any>);
    if (!row) return undefined;
    const { id, ...rest } = row;
    void id;
    return rest as RenderSettings;
  },
};

export function defaultSettings(): RenderSettings {
  return {
    lightMode: 'backlight',
    lightPower: 1.0,
    maxSamples: 256,
    convergeSeconds: 2.5,
    previewScale: 0.4,
    validationThicknesses: [3, 6, 12, 24, 36],
  };
}
