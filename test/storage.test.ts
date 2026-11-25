import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { storage, defaultSettings } from '../src/core/storage';
import { generateTestStones } from '../src/core/stoneGenerator';

describe('IndexedDB 存储', () => {
  beforeEach(async () => {
    const stones = await storage.allStones();
    for (const s of stones) await storage.deleteStone(s.id);
  });

  it('原料与方案的增删查', async () => {
    const [s] = generateTestStones();
    await storage.putStone(s);
    expect(await storage.allStones()).toHaveLength(1);
    const got = await storage.getStone(s.id);
    expect(got?.name).toBe(s.name);

    await storage.putPlan({ id: 'p1', stoneId: s.id, name: '测试方案', createdAt: 1, ops: [], minThicknessMm: 4 });
    expect(await storage.plansForStone(s.id)).toHaveLength(1);

    await storage.deleteStone(s.id);
    expect(await storage.allStones()).toHaveLength(0);
    // 删料级联删方案
    expect(await storage.plansForStone(s.id)).toHaveLength(0);
  });

  it('设置存取', async () => {
    const s = defaultSettings();
    s.lightPower = 1.7;
    await storage.saveSettings(s);
    const loaded = await storage.loadSettings();
    expect(loaded?.lightPower).toBe(1.7);
  });
});
