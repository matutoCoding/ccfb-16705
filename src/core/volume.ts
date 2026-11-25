import type { LabelGrid, Vec3, VolumeGrid } from './types';
import { VoxelLabel } from './types';
import { clamp } from './vec3';

export function idx(g: { nx: number; ny: number; nz: number }, x: number, y: number, z: number): number {
  return x + g.nx * (y + g.ny * z);
}

export function inBounds(g: { nx: number; ny: number; nz: number }, x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < g.nx && y < g.ny && z < g.nz;
}

/** 三线性采样 SDF(体素坐标) */
export function sampleSDF(g: VolumeGrid, x: number, y: number, z: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const at = (i: number, j: number, k: number): number => {
    const ci = clamp(x0 + i, 0, g.nx - 1);
    const cj = clamp(y0 + j, 0, g.ny - 1);
    const ck = clamp(z0 + k, 0, g.nz - 1);
    return g.sdf[idx(g, ci, cj, ck)];
  };
  const c00 = at(0, 0, 0) * (1 - fx) + at(1, 0, 0) * fx;
  const c10 = at(0, 1, 0) * (1 - fx) + at(1, 1, 0) * fx;
  const c01 = at(0, 0, 1) * (1 - fx) + at(1, 0, 1) * fx;
  const c11 = at(0, 1, 1) * (1 - fx) + at(1, 1, 1) * fx;
  const c0 = c00 * (1 - fy) + c10 * fy;
  const c1 = c01 * (1 - fy) + c11 * fy;
  return c0 * (1 - fz) + c1 * fz;
}

/** 最近邻采样标签 */
export function sampleLabel(g: LabelGrid, x: number, y: number, z: number): VoxelLabel {
  const i = clamp(Math.round(x), 0, g.nx - 1);
  const j = clamp(Math.round(y), 0, g.ny - 1);
  const k = clamp(Math.round(z), 0, g.nz - 1);
  return g.data[idx(g, i, j, k)] as VoxelLabel;
}

/** 占据判定:SDF<0 */
export function isInside(g: VolumeGrid, x: number, y: number, z: number): boolean {
  if (!inBounds(g, x, y, z)) return false;
  return g.sdf[idx(g, x, y, z)] < 0;
}

/** 创建空网格 */
export function makeGrid(nx: number, ny: number, nz: number, voxelMm: number, fill = 1e3): VolumeGrid {
  return { nx, ny, nz, voxelMm, sdf: new Float32Array(nx * ny * nz).fill(fill) };
}

export function makeLabels(nx: number, ny: number, nz: number): LabelGrid {
  return { nx, ny, nz, data: new Uint8Array(nx * ny * nz) };
}

/** 由占据掩码(1=内部)生成 SDF:三维 chamfer 距离变换,单位体素后乘 voxelMm */
export function occupancyToSDF(mask: Uint8Array, nx: number, ny: number, nz: number, voxelMm: number): VolumeGrid {
  const n = nx * ny * nz;
  // 初始:内部距离 0,外部为大值;先算到最近内部体素的距离(外部场)
  const INF = 1e6;
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = mask[i] ? 0 : INF;
  chamfer(dist, nx, ny, nz);
  const sdf = new Float32Array(n);
  // 内部场:到最近外部体素
  const inner = new Float32Array(n);
  for (let i = 0; i < n; i++) inner[i] = mask[i] ? INF : 0;
  chamfer(inner, nx, ny, nz);
  for (let i = 0; i < n; i++) {
    sdf[i] = (mask[i] ? -inner[i] : dist[i]) * voxelMm;
  }
  return { nx, ny, nz, voxelMm, sdf };
}

// 3-4-5 chamfer 距离变换,两遍扫描
function chamfer(d: Float32Array, nx: number, ny: number, nz: number): void {
  const N1 = 1, N2 = Math.SQRT2, N3 = Math.sqrt(3);
  const at = (x: number, y: number, z: number) => d[idx({ nx, ny, nz }, x, y, z)];
  // 前向
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
  // 后向
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
}

export interface OpticalSegment {
  /** 该段物理长度(mm) */
  lengthMm: number;
  label: VoxelLabel;
}

/**
 * Amanatides-Woo 体素 DDA:沿射线在网格内推进,返回穿过的每个体素段。
 * 输入输出均为体素坐标;段长度换算为毫米。
 */
export function voxelDDA(
  g: { nx: number; ny: number; nz: number; voxelMm: number },
  origin: Vec3,
  dir: Vec3,
  maxDistVox = 1e4,
  labels?: LabelGrid,
): OpticalSegment[] {
  const segs: OpticalSegment[] = [];
  let x = Math.floor(origin[0]), y = Math.floor(origin[1]), z = Math.floor(origin[2]);
  const stepX = dir[0] > 0 ? 1 : dir[0] < 0 ? -1 : 0;
  const stepY = dir[1] > 0 ? 1 : dir[1] < 0 ? -1 : 0;
  const stepZ = dir[2] > 0 ? 1 : dir[2] < 0 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dir[0]) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dir[1]) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir[2]) : Infinity;
  const boundary = (o: number, s: number) => (s > 0 ? Math.floor(o) + 1 - o : o - Math.floor(o));
  let tMaxX = stepX !== 0 ? boundary(origin[0], stepX) * tDeltaX : Infinity;
  let tMaxY = stepY !== 0 ? boundary(origin[1], stepY) * tDeltaY : Infinity;
  let tMaxZ = stepZ !== 0 ? boundary(origin[2], stepZ) * tDeltaZ : Infinity;
  let t = 0;
  let curLabel: VoxelLabel | -1 = -1;
  let segStart = 0;
  const flush = (endT: number) => {
    if (curLabel !== -1 && endT > segStart) {
      segs.push({ lengthMm: (endT - segStart) * g.voxelMm, label: curLabel });
    }
  };
  while (t <= maxDistVox && inBounds(g, x, y, z)) {
    const label = labels ? (labels.data[idx(g, x, y, z)] as VoxelLabel) : VoxelLabel.Jade;
    if (label !== curLabel) {
      flush(t);
      curLabel = label;
      segStart = t;
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += tDeltaX; }
    else if (tMaxY < tMaxZ) { y += stepY; t = tMaxY; tMaxY += tDeltaY; }
    else { z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
  }
  flush(t);
  return segs;
}

/**
 * Beer-Lambert 透光率:T = exp(-sigma * d)。
 * 这是整个系统的解析真值,GPU 与 CPU 都必须收敛到它。
 */
export function beerLambert(sigmaPerMm: number, distanceMm: number): number {
  return Math.exp(-sigmaPerMm * distanceMm);
}

export interface MediumOptics {
  sigmaA: Vec3;
  /** 绺裂额外吸收(1/mm) */
  crackSigma: number;
  /** 棉絮额外散射(1/mm) */
  cottonSigma: number;
  /** 杂色额外吸收(1/mm) */
  impuritySigma: number;
}

/**
 * 沿一条光路段序列做逐体素光程积分,得到 RGB 透射率。
 * 厚度翻倍 => 光程翻倍 => 指数衰减(数学上严格满足)。
 */
export function integrateTransmission(segs: OpticalSegment[], m: MediumOptics): Vec3 {
  let tauR = 0, tauG = 0, tauB = 0;
  for (const s of segs) {
    let extra = 0;
    if (s.label === VoxelLabel.Crack) extra = m.crackSigma;
    else if (s.label === VoxelLabel.Cotton) extra = m.cottonSigma;
    else if (s.label === VoxelLabel.Impurity) extra = m.impuritySigma;
    tauR += (m.sigmaA[0] + extra) * s.lengthMm;
    tauG += (m.sigmaA[1] + extra) * s.lengthMm;
    tauB += (m.sigmaA[2] + extra) * s.lengthMm;
  }
  return [Math.exp(-tauR), Math.exp(-tauG), Math.exp(-tauB)];
}

/** 均质板解析透射率(校验真值) */
export function analyticSlabTransmission(sigmaA: Vec3, thicknessMm: number): Vec3 {
  return sigmaA.map((s) => beerLambert(s, thicknessMm)) as Vec3;
}
