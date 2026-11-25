import { describe, it, expect } from 'vitest';
import { beerLambert, analyticSlabTransmission, integrateTransmission, voxelDDA } from '../src/core/volume';
import type { MediumOptics } from '../src/core/volume';
import { VoxelLabel } from '../src/core/types';
import type { VolumeGrid, LabelGrid } from '../src/core/types';
import { makeGrid, makeLabels, idx } from '../src/core/volume';

const optics: MediumOptics = {
  sigmaA: [0.012, 0.016, 0.022],
  crackSigma: 0.25,
  cottonSigma: 0.12,
  impuritySigma: 0.18,
};

/** 造一个实心长方体网格(0..nx 全内部),用于 DDA 光程测试 */
function solidBox(nx = 40, ny = 10, nz = 10): { volume: VolumeGrid; labels: LabelGrid } {
  const volume = makeGrid(nx, ny, nz, 1.0, 1);
  const labels = makeLabels(nx, ny, nz);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        // 内部体素给负 SDF
        if (x > 0 && x < nx - 1 && y > 0 && y < ny - 1 && z > 0 && z < nz - 1) {
          volume.sdf[idx(volume, x, y, z)] = -1;
        }
      }
  return { volume, labels };
}

describe('Beer-Lambert 解析衰减', () => {
  it('厚度翻倍,透射按指数衰减:T(2d)/T(d) == exp(-σd)', () => {
    const sigma = 0.02;
    const d = 10;
    const t1 = beerLambert(sigma, d);
    const t2 = beerLambert(sigma, d * 2);
    const ratio = t2 / t1;
    const expected = beerLambert(sigma, d);
    expect(Math.abs(ratio - expected) / expected).toBeLessThan(1e-12);
  });

  it('零厚度透射为 1,厚度增大单调递减', () => {
    expect(beerLambert(0.05, 0)).toBeCloseTo(1, 10);
    const seq = [0, 5, 10, 20, 40].map((d) => beerLambert(0.05, d));
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeLessThan(seq[i - 1]);
  });

  it('RGB 三通道独立指数衰减', () => {
    const t = analyticSlabTransmission(optics.sigmaA, 15);
    t.forEach((v, c) => expect(v).toBeCloseTo(Math.exp(-optics.sigmaA[c] * 15), 10));
  });
});

describe('DDA 光程积分 vs 解析值 (<5%)', () => {
  it('沿 X 穿透已知厚度,逐通道误差小于 5%', () => {
    const { volume, labels } = solidBox();
    // 从 x=2 出发沿 +X,截取不同物理厚度
    const origin: [number, number, number] = [2, 5, 5];
    const segs = voxelDDA(volume, origin, [1, 0, 0], 100, labels);
    const totalPath = segs.reduce((a, s) => a + s.lengthMm, 0);
    expect(totalPath).toBeGreaterThan(0);

    for (const d of [3, 6, 12, 24]) {
      const trunc: typeof segs = [];
      let acc = 0;
      for (const s of segs) {
        if (acc >= d) break;
        const take = Math.min(s.lengthMm, d - acc);
        trunc.push({ lengthMm: take, label: s.label });
        acc += take;
      }
      const measured = integrateTransmission(trunc, optics);
      const analytic = analyticSlabTransmission(optics.sigmaA, d);
      measured.forEach((m, c) => {
        const err = Math.abs(m - analytic[c]) / analytic[c];
        expect(err).toBeLessThan(0.05);
      });
    }
  });

  it('缺陷标签引入额外光学厚度,裂纹处更暗', () => {
    const { volume, labels } = solidBox();
    // 在 x=10 切片放裂纹
    for (let y = 1; y < 9; y++)
      for (let z = 1; z < 9; z++) labels.data[idx(labels, 10, y, z)] = VoxelLabel.Crack;
    const segs = voxelDDA(volume, [2, 5, 5], [1, 0, 0], 100, labels);
    const tDefect = integrateTransmission(segs, optics);
    const clean = integrateTransmission(segs.map((s) => ({ ...s, label: VoxelLabel.Jade })), optics);
    tDefect.forEach((v, c) => expect(v).toBeLessThan(clean[c]));
  });
});
