import type { LabelGrid, VolumeGrid } from './types';
import { VoxelLabel } from './types';
import { makeLabels, occupancyToSDF } from './volume';

/**
 * 简单体数据导入。
 * 支持两种 JSON:
 *  { "dims":[nx,ny,nz], "voxelMm":0.6, "occupancy": number[] (0/1) }
 *  { "dims":[...], "voxelMm":0.6, "density": number[] (0..255 灰度,阈值化) }
 * 可选 "labels": number[] (0 玉 / 1 裂 / 2 棉 / 3 杂)
 */
export interface RawVolume {
  dims: [number, number, number];
  voxelMm: number;
  occupancy?: number[];
  density?: number[];
  labels?: number[];
}

export function importRawVolume(raw: RawVolume): { volume: VolumeGrid; labels: LabelGrid } {
  const [nx, ny, nz] = raw.dims;
  const n = nx * ny * nz;
  const mask = new Uint8Array(n);
  if (raw.occupancy) {
    for (let i = 0; i < n; i++) mask[i] = raw.occupancy[i] ? 1 : 0;
  } else if (raw.density) {
    for (let i = 0; i < n; i++) mask[i] = raw.density[i] > 127 ? 1 : 0;
  } else {
    throw new Error('体数据缺少 occupancy 或 density 字段');
  }
  const volume = occupancyToSDF(mask, nx, ny, nz, raw.voxelMm ?? 0.6);
  const labels = makeLabels(nx, ny, nz);
  if (raw.labels) {
    for (let i = 0; i < n; i++) {
      const v = raw.labels[i];
      labels.data[i] = v >= 0 && v <= 3 ? v : VoxelLabel.Jade;
    }
  }
  return { volume, labels };
}

/** 生成一份可下载的示例体数据 JSON 字符串 */
export function exampleRawVolumeJSON(): string {
  const dims: [number, number, number] = [32, 24, 28];
  const [nx, ny, nz] = dims;
  const occupancy: number[] = [];
  const labels: number[] = [];
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const d = Math.hypot((x - 16) / 14, (y - 12) / 10, (z - 14) / 12);
        const inside = d < 1 ? 1 : 0;
        occupancy.push(inside);
        labels.push(inside && Math.abs(x - 16) <= 1 && y > 4 && y < 20 ? VoxelLabel.Crack : 0);
      }
  return JSON.stringify({ dims, voxelMm: 0.6, occupancy, labels });
}
