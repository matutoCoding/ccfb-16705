import type { CarveOp, LabelGrid, PlanGeometry, VolumeGrid } from './types';
import { VoxelLabel } from './types';
import { idx, inBounds, occupancyToSDF } from './volume';
import { voxelCountWeight } from './stoneGenerator';

function cloneLabels(g: LabelGrid): LabelGrid {
  return { ...g, data: new Uint8Array(g.data) };
}

/** 操作体的局部有符号距离(体素单位),负值表示在操作体内 */
function opSDF(op: CarveOp, x: number, y: number, z: number): number {
  const [cx, cy, cz] = op.center;
  const [sx, sy, sz] = op.size;
  if (op.shape === 'sphere') {
    const r = Math.max(sx, 1);
    return Math.hypot(x - cx, y - cy, z - cz) - r;
  }
  if (op.shape === 'box') {
    const dx = Math.abs(x - cx) - sx / 2;
    const dy = Math.abs(y - cy) - sy / 2;
    const dz = Math.abs(z - cz) - sz / 2;
    const q = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0));
    return q + Math.min(Math.max(dx, dy, dz), 0);
  }
  // cylinder:沿 Y 轴
  const radial = Math.hypot(x - cx, z - cz) - sx;
  const ay = Math.abs(y - cy) - sy / 2;
  return Math.hypot(Math.max(radial, 0), Math.max(ay, 0)) + Math.min(Math.max(radial, ay), 0);
}

function occupancyMask(volume: VolumeGrid): Uint8Array {
  const mask = new Uint8Array(volume.sdf.length);
  for (let i = 0; i < mask.length; i++) mask[i] = volume.sdf[i] < 0 ? 1 : 0;
  return mask;
}

/**
 * 应用雕刻方案。以占据掩码为唯一真值做布尔运算,结束后重建 SDF。
 * - subtract:差集,从掩码挖掉工具体
 * - relief:  对工具体内的表面做抬升/下压(通过局部掩码膨胀/收缩近似)
 * - hollow:  工具体内部且距外表超过 wall 的体素掏空,保留壁厚外壳
 */
export function applyCarvePlan(
  base: VolumeGrid,
  baseLabels: LabelGrid,
  ops: CarveOp[],
  density: number,
  _crackSheets: { id: string }[],
  crackExposure: (volume: VolumeGrid, labels: LabelGrid) => PlanGeometry['crackExposure'],
): PlanGeometry {
  const { nx, ny, nz, voxelMm } = base;
  const mask = occupancyMask(base);
  const labels = cloneLabels(baseLabels);
  const g = { nx, ny, nz };

  // 预先计算每个内部体素到表面的距离(体素),供镂空判壁厚
  const surfaceDist = computeSurfaceDistance(mask, nx, ny, nz);

  for (const op of ops) {
    if (!op.enabled) continue;
    const grow = (op.type === 'relief' && (op.displacement ?? 0) > 0) ? Math.round(op.displacement ?? 0) : 0;

    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const i = idx(g, x, y, z);
          const d = opSDF(op, x, y, z);
          const insideTool = d < 0;

          if (op.type === 'subtract' && insideTool) {
            mask[i] = 0;
            labels.data[i] = VoxelLabel.Jade;
          } else if (op.type === 'hollow' && insideTool) {
            // 仅掏空深于壁厚的内部体素,表面 wall 层保留
            if (mask[i] && surfaceDist[i] > (op.wall ?? 6)) {
              mask[i] = 0;
              labels.data[i] = VoxelLabel.Jade;
            }
          } else if (op.type === 'relief' && insideTool) {
            const disp = op.displacement ?? 0;
            if (disp < 0 && mask[i]) {
              // 下压:工具体内部整体向内收缩一层
              if (surfaceDist[i] <= Math.round(-disp)) { mask[i] = 0; labels.data[i] = VoxelLabel.Jade; }
            } else if (disp > 0) {
              // 抬升:把紧邻工具体的外部体素纳入(膨胀)
              if (!mask[i] && d > -grow) mask[i] = 1;
            }
          }
        }
  }

  const volume = occupancyToSDF(mask, nx, ny, nz, voxelMm);
  const before = voxelCountWeight(base, density);
  const after = voxelCountWeight(volume, density);
  const lossRate = before.count ? 1 - after.count / before.count : 0;

  return {
    volume,
    labels,
    remainingWeightG: Math.round(after.weightG),
    lossRate,
    crackExposure: crackExposure(volume, labels),
  };
}

/** 每个内部体素到最近外部体素的距离(体素),3-4-5 chamfer */
function computeSurfaceDistance(mask: Uint8Array, nx: number, ny: number, nz: number): Float32Array {
  const INF = 1e6;
  const d = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) d[i] = mask[i] ? INF : 0;
  const N1 = 1, N2 = Math.SQRT2, N3 = Math.sqrt(3);
  const at = (x: number, y: number, z: number) => d[idx({ nx, ny, nz }, x, y, z)];
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const i = idx({ nx, ny, nz }, x, y, z);
        let v = d[i];
        if (x > 0) v = Math.min(v, at(x - 1, y, z) + N1);
        if (y > 0) v = Math.min(v, at(x, y - 1, z) + N1);
        if (z > 0) v = Math.min(v, at(x, y, z - 1) + N1);
        if (x > 0 && y > 0) v = Math.min(v, at(x - 1, y - 1, z) + N2);
        if (x > 0 && z > 0) v = Math.min(v, at(x - 1, y, z - 1) + N2);
        if (y > 0 && z > 0) v = Math.min(v, at(x, y - 1, z - 1) + N2);
        if (x > 0 && y > 0 && z > 0) v = Math.min(v, at(x - 1, y - 1, z - 1) + N3);
        d[i] = v;
      }
  for (let z = nz - 1; z >= 0; z--)
    for (let y = ny - 1; y >= 0; y--)
      for (let x = nx - 1; x >= 0; x--) {
        const i = idx({ nx, ny, nz }, x, y, z);
        let v = d[i];
        if (x < nx - 1) v = Math.min(v, at(x + 1, y, z) + N1);
        if (y < ny - 1) v = Math.min(v, at(x, y + 1, z) + N1);
        if (z < nz - 1) v = Math.min(v, at(x, y, z + 1) + N1);
        if (x < nx - 1 && y < ny - 1) v = Math.min(v, at(x + 1, y + 1, z) + N2);
        if (x < nx - 1 && z < nz - 1) v = Math.min(v, at(x + 1, y, z + 1) + N2);
        if (y < ny - 1 && z < nz - 1) v = Math.min(v, at(x, y + 1, z + 1) + N2);
        if (x < nx - 1 && y < ny - 1 && z < nz - 1) v = Math.min(v, at(x + 1, y + 1, z + 1) + N3);
        d[i] = v;
      }
  return d;
}

/**
 * 厚度场:对每个内部体素,沿 ±X/±Y/±Z 六方向求到表面距离,取最小值的 2 倍近似壁厚(毫米)。
 */
export function computeThickness(volume: VolumeGrid): Float32Array {
  const { nx, ny, nz, voxelMm } = volume;
  const out = new Float32Array(nx * ny * nz);
  const dirs: [number, number, number][] = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const i = idx({ nx, ny, nz }, x, y, z);
        if (volume.sdf[i] >= 0) continue;
        let minHalf = Infinity;
        for (const [dx, dy, dz] of dirs) {
          let d = 0;
          let cx = x, cy = y, cz = z;
          while (inBounds({ nx, ny, nz }, cx, cy, cz)) {
            if (volume.sdf[idx({ nx, ny, nz }, cx, cy, cz)] >= 0) break;
            cx += dx; cy += dy; cz += dz; d++;
          }
          minHalf = Math.min(minHalf, d);
        }
        out[i] = minHalf * 2 * voxelMm;
      }
  return out;
}

export function findThinVoxels(thickness: Float32Array, minMm: number): number[] {
  const res: number[] = [];
  for (let i = 0; i < thickness.length; i++) {
    if (thickness[i] > 0 && thickness[i] < minMm) res.push(i);
  }
  return res;
}

/**
 * 绺裂暴露面积:统计标记为绺裂、且紧邻外部(表面)的体素面数。
 * 每个暴露面 = voxelMm²。被玉肉包裹的裂不计入(藏裂成功)。
 */
export function computeCrackExposure(
  volume: VolumeGrid,
  labels: LabelGrid,
  crackIds: string[],
  _polygonFor: (id: string) => unknown,
): PlanGeometry['crackExposure'] {
  const { nx, ny, nz, voxelMm } = volume;
  const faceArea = voxelMm * voxelMm;
  const neighbors: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let exposedFaces = 0;
  let crackVoxels = 0;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const i = idx({ nx, ny, nz }, x, y, z);
        if (labels.data[i] !== VoxelLabel.Crack) continue;
        crackVoxels++;
        for (const [dx, dy, dz] of neighbors) {
          const ax = x + dx, ay = y + dy, az = z + dz;
          if (!inBounds({ nx, ny, nz }, ax, ay, az) || volume.sdf[idx({ nx, ny, nz }, ax, ay, az)] >= 0) {
            exposedFaces++;
          }
        }
      }
  const totalMm2 = crackVoxels * faceArea;
  const exposedMm2 = exposedFaces * faceArea;
  return crackIds.map((id) => ({ crackId: id, exposedMm2, totalMm2 }));
}

export function emptyPlanGeometry(base: VolumeGrid, labels: LabelGrid, density: number): PlanGeometry {
  const { weightG } = voxelCountWeight(base, density);
  return {
    volume: { ...base, sdf: new Float32Array(base.sdf) },
    labels: cloneLabels(labels),
    remainingWeightG: Math.round(weightG),
    lossRate: 0,
    crackExposure: [],
  };
}
