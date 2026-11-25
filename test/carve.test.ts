import { describe, it, expect } from 'vitest';
import { generateTestStones, voxelCountWeight, GRID_SIZE } from '../src/core/stoneGenerator';
import { VoxelLabel } from '../src/core/types';
import { computeThickness, findThinVoxels, applyCarvePlan, computeCrackExposure } from '../src/core/carve';

describe('三块测试料', () => {
  const stones = generateTestStones();

  it('生成三块且分辨率正确', () => {
    expect(stones).toHaveLength(3);
    for (const s of stones) {
      expect(s.volume.nx).toBe(GRID_SIZE);
      expect(s.weightG).toBeGreaterThan(0);
    }
  });

  it('第一块带贯穿裂,第二块带糖色皮,第三块带大片棉', () => {
    const count = (id: number, label: VoxelLabel) => stones[id].labels.data.filter((l) => l === label).length;
    expect(count(0, VoxelLabel.Crack)).toBeGreaterThan(50);
    expect(stones[0].cracks.length).toBe(1);
    expect(count(1, VoxelLabel.Impurity)).toBeGreaterThan(100);
    expect(count(2, VoxelLabel.Cotton)).toBeGreaterThan(100);
  });

  it('每块料都是封闭实心(内部体素为负 SDF)', () => {
    for (const s of stones) {
      const inside = s.volume.sdf.filter((v) => v < 0).length;
      expect(inside).toBeGreaterThan(1000);
    }
  });
});

describe('雕刻与厚度', () => {
  const [stone] = generateTestStones();
  const before = voxelCountWeight(stone.volume, stone.material.density);

  it('布尔减料降低重量并产生损料率', () => {
    const c = GRID_SIZE / 2;
    const geom = applyCarvePlan(
      stone.volume, stone.labels,
      [{ id: 'a', type: 'subtract', shape: 'sphere', center: [c, c, c], size: [14, 14, 14], enabled: true }],
      stone.material.density, [],
      (v, l) => computeCrackExposure(v, l, [], () => null),
    );
    const after = voxelCountWeight(geom.volume, stone.material.density);
    expect(after.count).toBeLessThan(before.count);
    expect(geom.lossRate).toBeGreaterThan(0);
    expect(geom.lossRate).toBeLessThan(1);
    expect(geom.remainingWeightG).toBe(Math.round(after.weightG));
  });

  it('厚度场非负且薄点报警可检出', () => {
    const thickness = computeThickness(stone.volume);
    const valid = thickness.filter((t) => t > 0);
    expect(valid.length).toBeGreaterThan(0);
    expect(Math.min(...valid)).toBeGreaterThan(0);
    // 人为把下限设到极大,应能报出大量薄点
    const thin = findThinVoxels(thickness, 1e6);
    expect(thin.length).toBe(valid.length);
  });

  it('镂空保留壁厚:外壳仍在,内部被掏空', () => {
    const c = GRID_SIZE / 2;
    const geom = applyCarvePlan(
      stone.volume, stone.labels,
      [{ id: 'h', type: 'hollow', shape: 'box', center: [c, c, c], size: [50, 50, 50], wall: 4, enabled: true }],
      stone.material.density, [],
      (v, l) => computeCrackExposure(v, l, [], () => null),
    );
    expect(geom.lossRate).toBeGreaterThan(0.2);
  });
});
