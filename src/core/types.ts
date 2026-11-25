// 全局领域类型定义

export type Vec3 = [number, number, number];

/** 体素标签:0=玉肉,1=绺裂,2=棉絮,3=杂色(糖色) */
export enum VoxelLabel {
  Jade = 0,
  Crack = 1,
  Cotton = 2,
  Impurity = 3,
}

/** 有符号距离场网格:sdf<0 表示在玉料内部 */
export interface VolumeGrid {
  nx: number;
  ny: number;
  nz: number;
  /** 每体素物理尺寸(毫米) */
  voxelMm: number;
  /** 长度 nx*ny*nz 的 SDF,单位毫米 */
  sdf: Float32Array;
}

/** 标签网格,与 SDF 同分辨率 */
export interface LabelGrid {
  nx: number;
  ny: number;
  nz: number;
  data: Uint8Array;
}

/** 绺裂面(一张由多段折线围成的面,位于某个切平面内) */
export interface CrackSheet {
  id: string;
  name: string;
  /** 切平面轴向:0=X,1=Y,2=Z */
  axis: 0 | 1 | 2;
  /** 该平面在该轴向上的体素索引 */
  slice: number;
  /** 平面内的多边形顶点(体素坐标,二维) */
  polygon: [number, number][];
  /** 物理宽度(毫米),用于透光衰减与暴露面积 */
  widthMm: number;
}

/** 玉料光学与物性参数 */
export interface JadeMaterial {
  /** 密度 g/cm^3 */
  density: number;
  /** RGB 吸收系数 (1/mm),控制 Beer-Lambert 衰减 */
  sigmaA: Vec3;
  /** 约化散射系数 (1/mm) */
  sigmaS: Vec3;
  /** 折射率 */
  ior: number;
  /** 表面粗糙度 0..1 */
  roughness: number;
  /** 油脂光泽 0..1 */
  oiliness: number;
}

export interface StoneMeta {
  id: string;
  name: string;
  origin: string;
  color: string;
  /** 油性 0..1 */
  oiliness: number;
  /** 重量(克) */
  weightG: number;
  createdAt: number;
  material: JadeMaterial;
}

export interface StoneRecord extends StoneMeta {
  volume: VolumeGrid;
  labels: LabelGrid;
  cracks: CrackSheet[];
}

/** 雕刻操作类型 */
export type CarveOpType = 'subtract' | 'relief' | 'hollow';

export interface CarveOp {
  id: string;
  type: CarveOpType;
  /** 操作体形状 */
  shape: 'sphere' | 'box' | 'cylinder';
  /** 中心(体素坐标) */
  center: Vec3;
  /** 尺寸/半径(体素单位) */
  size: Vec3;
  /** 浮雕:抬升为正、下压为负的位移(体素) */
  displacement?: number;
  /** 镂空:保留壁厚(体素) */
  wall?: number;
  enabled: boolean;
}

export interface CarvePlan {
  id: string;
  stoneId: string;
  name: string;
  createdAt: number;
  ops: CarveOp[];
  /** 厚度报警下限(毫米) */
  minThicknessMm: number;
}

/** 雕刻后的网格产物 */
export interface PlanGeometry {
  volume: VolumeGrid;
  labels: LabelGrid;
  /** 剩余重量(克) */
  remainingWeightG: number;
  /** 损料率 0..1 */
  lossRate: number;
  /** 每条绺裂的暴露面积(mm²) */
  crackExposure: { crackId: string; exposedMm2: number; totalMm2: number }[];
}

export type LightMode = 'backlight' | 'sidelight' | 'ambient';
export type RenderMode = 'material' | 'thickness' | 'transmission' | 'crack';

export interface RenderSettings {
  lightMode: LightMode;
  /** 灯光功率 */
  lightPower: number;
  /** 每像素采样数(收敛上限) */
  maxSamples: number;
  /** 视角静止后收敛秒数 */
  convergeSeconds: number;
  /** 预览缩放(转视角时) */
  previewScale: number;
  /** 校验板厚度序列(毫米) */
  validationThicknesses: number[];
}

export interface DBSchema {
  stones: StoneRecord;
  plans: CarvePlan;
  settings: RenderSettings;
}
