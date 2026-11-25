import type { CrackSheet, LabelGrid, StoneRecord, Vec3, VolumeGrid } from './types';
import { VoxelLabel } from './types';
import { idx, makeLabels, occupancyToSDF } from './volume';
import { rng, uid } from './vec3';
import { JADE_MATERIALS } from './materials';

const GRID = 96;
const VOXEL_MM = 0.6; // 每体素 0.6mm,整块约 57.6mm

interface PebbleSpec {
  name: string;
  origin: string;
  color: string;
  oiliness: number;
  /** 椭球半轴(体素) */
  radii: Vec3;
  center: Vec3;
  seed: number;
  material: keyof typeof JADE_MATERIALS;
}

/** 平滑值噪声(确定性) */
function valueNoise3(seed: number) {
  const r = rng(seed);
  const size = 32;
  const grid = new Float32Array(size * size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = r();
  const at = (x: number, y: number, z: number) => {
    const xi = ((x % size) + size) % size, yi = ((y % size) + size) % size, zi = ((z % size) + size) % size;
    return grid[xi + size * (yi + size * zi)];
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number, z: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const fx = smooth(x - x0), fy = smooth(y - y0), fz = smooth(z - z0);
    const c000 = at(x0, y0, z0), c100 = at(x0 + 1, y0, z0);
    const c010 = at(x0, y0 + 1, z0), c110 = at(x0 + 1, y0 + 1, z0);
    const c001 = at(x0, y0, z0 + 1), c101 = at(x0 + 1, y0, z0 + 1);
    const c011 = at(x0, y0 + 1, z0 + 1), c111 = at(x0 + 1, y0 + 1, z0 + 1);
    const c00 = c000 * (1 - fx) + c100 * fx;
    const c10 = c010 * (1 - fx) + c110 * fx;
    const c01 = c001 * (1 - fx) + c101 * fx;
    const c11 = c011 * (1 - fx) + c111 * fx;
    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;
    return c0 * (1 - fz) + c1 * fz;
  };
}

function buildPebble(spec: PebbleSpec): { volume: VolumeGrid; labels: LabelGrid } {
  const n = GRID;
  const mask = new Uint8Array(n * n * n);
  const labels = makeLabels(n, n, n);
  const noise = valueNoise3(spec.seed);
  const [rx, ry, rz] = spec.radii;
  const [cx, cy, cz] = spec.center;

  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        // 不规则卵石:多倍频噪声扰动椭球
        const n1 = noise(x * 0.08, y * 0.08, z * 0.08) - 0.5;
        const n2 = noise(x * 0.2 + 10, y * 0.2, z * 0.2) - 0.5;
        const deform = 1 + n1 * 0.12 + n2 * 0.05;
        const dx = (x - cx) / (rx * deform);
        const dy = (y - cy) / (ry * deform);
        const dz = (z - cz) / (rz * deform);
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1) mask[idx({ nx: n, ny: n, nz: n }, x, y, z)] = 1;
      }

  const volume = occupancyToSDF(mask, n, n, n, VOXEL_MM);
  return { volume, labels };
}

/** 体素物理体积(cm³)与重量 */
export function voxelCountWeight(volume: VolumeGrid, density: number): { count: number; weightG: number } {
  let count = 0;
  for (let i = 0; i < volume.sdf.length; i++) if (volume.sdf[i] < 0) count++;
  const vCm = volume.voxelMm / 10;
  const volCm3 = count * vCm * vCm * vCm;
  return { count, weightG: volCm3 * density };
}

function markCrack(labels: LabelGrid, sheet: CrackSheet) {
  const { axis, slice, polygon, widthMm } = sheet;
  const half = Math.max(1, Math.round(widthMm / VOXEL_MM / 2));
  const inside = (u: number, v: number) => pointInPoly(u, v, polygon);
  const n = labels.nx;
  for (let a = slice - half; a <= slice + half; a++) {
    if (a < 0 || a >= n) continue;
    for (let b = 0; b < n; b++)
      for (let c = 0; c < n; c++) {
        const u = axis === 0 ? b : axis === 1 ? c : b;
        const v = axis === 0 ? c : axis === 1 ? b : c;
        if (inside(u, v)) {
          const x = axis === 0 ? a : axis === 1 ? c : b;
          const y = axis === 1 ? a : axis === 2 ? c : b;
          const z = axis === 2 ? a : c;
          labels.data[idx(labels, x, y, z)] = VoxelLabel.Crack;
        }
      }
  }
}

function pointInPoly(u: number, v: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 石1:贯穿裂。在 X 中部切平面画一条贯穿上下的蜿蜒裂面 */
function stoneCrack(): { volume: VolumeGrid; labels: LabelGrid; cracks: CrackSheet[] } {
  const spec: PebbleSpec = {
    name: '青白玉籽料 · 贯穿裂',
    origin: '新疆和田玉龙喀什河',
    color: '青白带水线',
    oiliness: 0.72,
    radii: [34, 26, 30],
    center: [48, 48, 48],
    seed: 101,
    material: 'whiteHetian',
  };
  const { volume, labels } = buildPebble(spec);
  // 蜿蜒贯穿多边形(在 YZ 平面,axis=0)
  const poly: [number, number][] = [];
  const r = rng(7);
  for (let y = 20; y <= 76; y += 4) {
    const z = 48 + Math.sin(y * 0.18) * 6 + (r() - 0.5) * 4;
    poly.push([y, z - 1.5]);
  }
  for (let y = 76; y >= 20; y -= 4) {
    const z = 48 + Math.sin(y * 0.18) * 6 + (r() - 0.5) * 4;
    poly.push([y, z + 1.5]);
  }
  const crack: CrackSheet = {
    id: uid('crack'),
    name: '主贯穿绺裂',
    axis: 0,
    slice: 48,
    polygon: poly,
    widthMm: 1.2,
  };
  markCrack(labels, crack);
  return { volume, labels, cracks: [crack] };
}

/** 石2:糖色皮。外壳一层杂色(糖色),并保留一块糖沁 */
function stoneSugar(): { volume: VolumeGrid; labels: LabelGrid; cracks: CrackSheet[] } {
  const spec: PebbleSpec = {
    name: '糖白玉籽料 · 糖色皮',
    origin: '新疆且末',
    color: '白玉底糖褐皮',
    oiliness: 0.66,
    radii: [32, 30, 28],
    center: [48, 47, 48],
    seed: 202,
    material: 'sugarHetian',
  };
  const { volume, labels } = buildPebble(spec);
  const noise = valueNoise3(999);
  // 糖皮:距表面近的体素标杂色;另在一侧加一块向内沁入的糖
  for (let z = 0; z < GRID; z++)
    for (let y = 0; y < GRID; y++)
      for (let x = 0; x < GRID; x++) {
        const i = idx(labels, x, y, z);
        if (volume.sdf[i] >= 0) continue;
        const skinDepth = -volume.sdf[i]; // 距表面 mm
        const band = 2.2 + noise(x * 0.15, y * 0.15, z * 0.15) * 2.5;
        const intrusion = Math.hypot(x - 70, y - 30, z - 48) < 16 ? 4 : 0;
        if (skinDepth < band + intrusion) labels.data[i] = VoxelLabel.Impurity;
      }
  return { volume, labels, cracks: [] };
}

/** 石3:大片棉。中部一团云片状棉絮 */
function stoneCotton(): { volume: VolumeGrid; labels: LabelGrid; cracks: CrackSheet[] } {
  const spec: PebbleSpec = {
    name: '白玉籽料 · 大片棉',
    origin: '新疆和田于田',
    color: '暖白',
    oiliness: 0.58,
    radii: [30, 32, 27],
    center: [48, 48, 49],
    seed: 303,
    material: 'whiteHetian',
  };
  const { volume, labels } = buildPebble(spec);
  const noise = valueNoise3(31337);
  // 几团棉絮:椭球区域内按噪声阈值标记
  const blobs: Vec3[] = [[44, 50, 46], [55, 46, 50], [48, 56, 44]];
  for (let z = 0; z < GRID; z++)
    for (let y = 0; y < GRID; y++)
      for (let x = 0; x < GRID; x++) {
        const i = idx(labels, x, y, z);
        if (volume.sdf[i] >= 0) continue;
        for (const [bx, by, bz] of blobs) {
          const d = Math.hypot((x - bx) / 13, (y - by) / 10, (z - bz) / 11);
          if (d < 1 && noise(x * 0.25, y * 0.25, z * 0.25) > 0.42) {
            labels.data[i] = VoxelLabel.Cotton;
            break;
          }
        }
      }
  return { volume, labels, cracks: [] };
}

export function generateTestStones(): StoneRecord[] {
  const makers = [stoneCrack, stoneSugar, stoneCotton];
  const metas: PebbleSpec[] = [
    { name: '', origin: '', color: '', oiliness: 0, radii: [0, 0, 0], center: [0, 0, 0], seed: 0, material: 'whiteHetian' },
  ];
  void metas;
  return makers.map((fn, k) => {
    const built = fn();
    const specs: PebbleSpec[] = [
      { name: '青白玉籽料 · 贯穿裂', origin: '新疆和田玉龙喀什河', color: '青白带水线', oiliness: 0.72, radii: [34, 26, 30], center: [48, 48, 48], seed: 101, material: 'whiteHetian' },
      { name: '糖白玉籽料 · 糖色皮', origin: '新疆且末', color: '白玉底糖褐皮', oiliness: 0.66, radii: [32, 30, 28], center: [48, 47, 48], seed: 202, material: 'sugarHetian' },
      { name: '白玉籽料 · 大片棉', origin: '新疆和田于田', color: '暖白', oiliness: 0.58, radii: [30, 32, 27], center: [48, 48, 49], seed: 303, material: 'whiteHetian' },
    ];
    const spec = specs[k];
    const { weightG } = voxelCountWeight(built.volume, JADE_MATERIALS[spec.material].density);
    return {
      id: uid('stone'),
      name: spec.name,
      origin: spec.origin,
      color: spec.color,
      oiliness: spec.oiliness,
      weightG: Math.round(weightG),
      createdAt: Date.now() + k,
      material: structuredClone(JADE_MATERIALS[spec.material]),
      volume: built.volume,
      labels: built.labels,
      cracks: built.cracks,
    } satisfies StoneRecord;
  });
}

export const GRID_SIZE = GRID;
export const GRID_VOXEL_MM = VOXEL_MM;
