import type { VolumeGrid } from '../core/types';
import { VoxelLabel } from '../core/types';

/** 厚度 -> 色带:薄蓝、中绿、厚红;超薄报警点闪烁色 */
export function thicknessColor(t: number, maxMm: number): [number, number, number] {
  const k = Math.max(0, Math.min(1, t / maxMm));
  if (k < 0.5) {
    const u = k * 2;
    return [Math.round(26 + (26 - 26) * u), Math.round(102 + (230 - 102) * u), Math.round(255 + (102 - 255) * u)];
  }
  const u = (k - 0.5) * 2;
  return [Math.round(26 + (255 - 26) * u), Math.round(230 + (64 - 230) * u), Math.round(102 + (38 - 102) * u)];
}

export interface HeatmapResult {
  canvas: HTMLCanvasElement;
  dataUrl: string;
  minMm: number;
  maxMm: number;
  meanMm: number;
  thinCount: number;
}

/**
 * 生成厚度图:取穿过网格中心、垂直三个主轴的最大投影厚度,
 * 输出一张可打印的 PNG。
 */
export function thicknessToHeatmap(thickness: Float32Array, volume: VolumeGrid, minAlarmMm: number): HeatmapResult {
  const { nx, ny, nz } = volume;
  // 沿 Z 投影:每个 (x,y) 取该列最大厚度
  const w = nx, h = ny;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  let minMm = Infinity, maxMm = 0, sum = 0, cnt = 0, thinCount = 0;

  for (let i = 0; i < thickness.length; i++) {
    const t = thickness[i];
    if (t > 0) { minMm = Math.min(minMm, t); maxMm = Math.max(maxMm, t); sum += t; cnt++; if (t < minAlarmMm) thinCount++; }
  }
  if (!isFinite(minMm)) minMm = 0;
  const scale = Math.max(maxMm, 1);

  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      let best = 0;
      for (let z = 0; z < nz; z++) {
        const t = thickness[x + nx * (y + ny * z)];
        if (t > best) best = t;
      }
      const o = (y * w + x) * 4;
      if (best <= 0) { img.data[o + 3] = 0; continue; }
      const [r, g, b] = thicknessColor(best, scale);
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
      if (best < minAlarmMm) { img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 0; } // 报警=黄
    }
  ctx.putImageData(img, 0, 0);

  // 放大到便于打印的分辨率
  const out = document.createElement('canvas');
  const scale2 = 6;
  out.width = w * scale2; out.height = h * scale2;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = false;
  octx.drawImage(canvas, 0, 0, out.width, out.height);
  drawLegend(octx, out.width, out.height, scale);

  return {
    canvas: out,
    dataUrl: out.toDataURL('image/png'),
    minMm, maxMm,
    meanMm: cnt ? sum / cnt : 0,
    thinCount,
  };
}

function drawLegend(ctx: CanvasRenderingContext2D, w: number, h: number, maxMm: number) {
  const barW = 24, barH = h - 80, x0 = w - 60, y0 = 40;
  for (let i = 0; i < barH; i++) {
    const t = (1 - i / barH) * maxMm;
    const [r, g, b] = thicknessColor(t, maxMm);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x0, y0 + i, barW, 1);
  }
  ctx.fillStyle = '#222';
  ctx.font = '18px sans-serif';
  ctx.fillText(`${maxMm.toFixed(1)}mm`, x0 + barW + 8, y0 + 8);
  ctx.fillText(`${(maxMm / 2).toFixed(1)}mm`, x0 + barW + 8, y0 + barH / 2);
  ctx.fillText(`0mm`, x0 + barW + 8, y0 + barH);
}

/** 供非 DOM 环境(单元测试)使用的纯函数色带 */
export function labelColor(label: VoxelLabel): [number, number, number] {
  switch (label) {
    case VoxelLabel.Crack: return [255, 90, 60];
    case VoxelLabel.Cotton: return [230, 235, 245];
    case VoxelLabel.Impurity: return [180, 120, 60];
    default: return [120, 150, 140];
  }
}
