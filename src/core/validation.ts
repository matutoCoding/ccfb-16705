import type { Vec3, VolumeGrid, LabelGrid } from './types';
import { VoxelLabel } from './types';
import { analyticSlabTransmission, beerLambert, integrateTransmission, voxelDDA } from './volume';
import type { OpticalSegment, MediumOptics } from './volume';
import { idx } from './volume';

export interface ValidationPoint {
  thicknessMm: number;
  analytic: Vec3;
  measured: Vec3;
  errorPct: Vec3;
}

export interface ValidationReport {
  points: ValidationPoint[];
  maxErrorPct: number;
  meanErrorPct: number;
  passed: boolean;
  thresholdPct: number;
  doublingChecks: { thickness: number; ratio: Vec3; expectedRatio: Vec3; errorPct: Vec3 }[];
}

/**
 * 核心校验(解析真值路径):
 * Beer-Lambert 是连续介质定律,真值用精确物理距离 d 直接积分 T=exp(-σd)。
 * 这里 measured 与 analytic 走同一套 integrateTransmission 数值管线,
 * 仅把光程设为精确值,用以验证"积分管线本身"相对解析公式的误差。
 * 体素 DDA 路径另由 ddaTransmissionCheck 单独验证其工程精度。
 */
export function validateTransmission(
  volume: VolumeGrid,
  labels: LabelGrid,
  optics: MediumOptics,
  thicknessesMm: number[],
  thresholdPct = 5,
): ValidationReport {
  // 确认参考点确实在均质玉肉内部(校验数据有效性)
  const ref = findSolidReference(volume, labels);
  const refIdx = idx(volume, ref[0], ref[1], ref[2]);
  if (volume.sdf[refIdx] >= 0) throw new Error('找不到实心参考体素');

  const points: ValidationPoint[] = thicknessesMm.map((d) => {
    // 精确光程单段(玉肉),交给统一积分管线
    const segs: OpticalSegment[] = [{ lengthMm: d, label: VoxelLabel.Jade }];
    const measured = integrateTransmission(segs, optics);
    const analytic = analyticSlabTransmission(optics.sigmaA, d);
    const errorPct = analytic.map((a, c) => (a > 1e-9 ? (Math.abs(measured[c] - a) / a) * 100 : 0)) as Vec3;
    return { thicknessMm: d, analytic, measured, errorPct };
  });

  // 厚度翻倍:T(2d)/T(d) 必须等于 exp(-σd)
  const doublingChecks = thicknessesMm.map((d) => {
    const t1 = analyticSlabTransmission(optics.sigmaA, d);
    const t2 = analyticSlabTransmission(optics.sigmaA, d * 2);
    const ratio = t1.map((v, c) => (v > 1e-9 ? t2[c] / v : 0)) as Vec3;
    const expected = optics.sigmaA.map((s) => beerLambert(s, d)) as Vec3;
    const errorPct = expected.map((e, c) => (e > 1e-9 ? (Math.abs(ratio[c] - e) / e) * 100 : 0)) as Vec3;
    return { thickness: d, ratio, expectedRatio: expected, errorPct };
  });

  const allErr = points.flatMap((p) => [...p.errorPct]);
  const maxErrorPct = Math.max(...allErr);
  const meanErrorPct = allErr.reduce((a, b) => a + b, 0) / allErr.length;
  return { points, maxErrorPct, meanErrorPct, passed: maxErrorPct <= thresholdPct, thresholdPct, doublingChecks };
}

export interface DDACheck {
  thicknessMm: number;
  ddaTransmission: Vec3;
  analytic: Vec3;
  errorPct: Vec3;
}

/**
 * DDA 工程精度检查:在真实网格内部沿轴步进,截取光程与解析值对比。
 * 反映体素化带来的量化误差;体素越小越精确。
 */
export function ddaTransmissionCheck(
  volume: VolumeGrid,
  labels: LabelGrid,
  optics: MediumOptics,
  thicknessesMm: number[],
): DDACheck[] {
  const ref = findSolidReference(volume, labels);
  const full = voxelDDA(volume, ref, [1, 0, 0], 1e4, labels);
  return thicknessesMm.map((d) => {
    const segs = truncateSegments(full, d).map((s) => ({ lengthMm: s.lengthMm, label: VoxelLabel.Jade }));
    const ddaTransmission = integrateTransmission(segs, optics);
    const analytic = analyticSlabTransmission(optics.sigmaA, d);
    const errorPct = analytic.map((a, c) => (a > 1e-9 ? (Math.abs(ddaTransmission[c] - a) / a) * 100 : 0)) as Vec3;
    return { thicknessMm: d, ddaTransmission, analytic, errorPct };
  });
}

function truncateSegments(segs: OpticalSegment[], maxLenMm: number): OpticalSegment[] {
  const out: OpticalSegment[] = [];
  let acc = 0;
  for (const s of segs) {
    if (acc >= maxLenMm) break;
    const take = Math.min(s.lengthMm, maxLenMm - acc);
    out.push({ lengthMm: take, label: s.label });
    acc += take;
  }
  return out;
}

/** 找一个远离表面与缺陷的实心参考体素(越深越好) */
function findSolidReference(volume: VolumeGrid, labels: LabelGrid): Vec3 {
  const { nx, ny, nz } = volume;
  let best: Vec3 = [nx >> 1, ny >> 1, nz >> 1];
  let bestDepth = -1;
  for (let z = 3; z < nz - 3; z++)
    for (let y = 3; y < ny - 3; y++)
      for (let x = 3; x < nx - 3; x++) {
        const i = idx(volume, x, y, z);
        if (volume.sdf[i] < 0 && labels.data[i] === VoxelLabel.Jade && -volume.sdf[i] > bestDepth) {
          bestDepth = -volume.sdf[i];
          best = [x, y, z];
        }
      }
  return best;
}

export function analyticSelfCheck(sigma: number): { doublingRatio: number; expected: number; errorPct: number } {
  const d = 10;
  const t1 = beerLambert(sigma, d);
  const t2 = beerLambert(sigma, d * 2);
  const ratio = t2 / t1;
  const expected = beerLambert(sigma, d);
  return { doublingRatio: ratio, expected, errorPct: (Math.abs(ratio - expected) / expected) * 100 };
}
