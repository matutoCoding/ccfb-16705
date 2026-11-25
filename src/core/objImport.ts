import type { LabelGrid, VolumeGrid } from './types';
import { occupancyToSDF, makeLabels } from './volume';

export interface ImportedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** 网格包围盒(原单位) */
  min: [number, number, number];
  max: [number, number, number];
}

/** 极简 OBJ 解析(顶点 + 三角面,支持 v / f) */
export function parseOBJ(text: string): ImportedMesh {
  const verts: number[] = [];
  const faces: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v') {
      verts.push(+parts[1], +parts[2], +parts[3]);
    } else if (parts[0] === 'f') {
      const idx = parts.slice(1).map((p) => parseInt(p.split('/')[0], 10) - 1);
      for (let i = 1; i < idx.length - 1; i++) faces.push(idx[0], idx[i], idx[i + 1]);
    }
  }
  const positions = new Float32Array(verts);
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  return { positions, indices: new Uint32Array(faces), min, max };
}

/**
 * 网格体素化:三角形光栅化到占据掩码,再用距离变换生成 SDF。
 * targetVox 为最长边目标体素数。
 */
export function voxelizeMesh(mesh: ImportedMesh, targetVox = 96, voxelMm = 0.6): { volume: VolumeGrid; labels: LabelGrid } {
  const { min, max, positions, indices } = mesh;
  const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const scale = (targetVox - 4) / Math.max(...extent);
  const dims = extent.map((e) => Math.max(8, Math.ceil(e * scale) + 4));
  const nx = dims[0], ny = dims[1], nz = dims[2];
  const mask = new Uint8Array(nx * ny * nz);
  const toVox = (i: number): [number, number, number] => [
    (positions[i] - min[0]) * scale + 2,
    (positions[i + 1] - min[1]) * scale + 2,
    (positions[i + 2] - min[2]) * scale + 2,
  ];

  // 每个三角形求 AABB,在内部按重心/扫描近似填充
  for (let f = 0; f < indices.length; f += 3) {
    const a = toVox(indices[f] * 3);
    const b = toVox(indices[f + 1] * 3);
    const c = toVox(indices[f + 2] * 3);
    const lo = [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])].map(Math.floor);
    const hi = [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])].map(Math.ceil);
    for (let z = lo[2]; z <= hi[2]; z++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let x = lo[0]; x <= hi[0]; x++) {
          if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
          // 保守标记三角形 AABB 覆盖体素为表面壳,真正内外由 flood fill 决定
          mask[x + nx * (y + ny * z)] = 1;
        }
  }
  // 泛洪填充内部:从边界把外部掏空,未被访问的封闭体素标记为内部
  floodFillOutside(mask, nx, ny, nz);
  const volume = occupancyToSDF(mask, nx, ny, nz, voxelMm);
  return { volume, labels: makeLabels(nx, ny, nz) };
}

function pointInTri(p: number[], a: number[], b: number[], c: number[]): boolean {
  // 仅在三角形平面附近用 AABB 保守覆盖,实际由 flood fill 决定内外
  return true;
}

function floodFillOutside(mask: Uint8Array, nx: number, ny: number, nz: number): void {
  const outside = new Uint8Array(mask.length);
  const stack: number[] = [];
  const tryPush = (x: number, y: number, z: number) => {
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
    const i = x + nx * (y + ny * z);
    if (mask[i] === 0 && !outside[i]) { outside[i] = 1; stack.push(i); }
  };
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) { tryPush(x, y, 0); tryPush(x, y, nz - 1); }
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) { tryPush(0, y, z); tryPush(nx - 1, y, z); }
  for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) { tryPush(x, 0, z); tryPush(x, ny - 1, z); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / (nx * ny)) | 0;
    tryPush(x + 1, y, z); tryPush(x - 1, y, z);
    tryPush(x, y + 1, z); tryPush(x, y - 1, z);
    tryPush(x, y, z + 1); tryPush(x, y, z - 1);
  }
  // 表面(原 mask=1)与封闭内部(未 outside)都算占据
  for (let i = 0; i < mask.length; i++) if (!outside[i]) mask[i] = 1;
}
