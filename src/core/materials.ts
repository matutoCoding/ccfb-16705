import type { JadeMaterial } from './types';

/**
 * 玉质光学材质库。
 * sigmaA/sigmaS 单位 1/mm,数值参考典型软玉(和田玉)半透明区间标定,
 * 可在设置页按实测打灯数据反推调整。
 */
export const JADE_MATERIALS: Record<string, JadeMaterial> = {
  // 白玉/青白玉:弱吸收,暖白透射
  whiteHetian: {
    density: 2.95,
    sigmaA: [0.012, 0.016, 0.022],
    sigmaS: [0.05, 0.045, 0.04],
    ior: 1.62,
    roughness: 0.28,
    oiliness: 0.7,
  },
  // 青玉:绿通道透射更强
  greenHetian: {
    density: 2.98,
    sigmaA: [0.03, 0.014, 0.02],
    sigmaS: [0.06, 0.055, 0.05],
    ior: 1.62,
    roughness: 0.32,
    oiliness: 0.65,
  },
  // 糖玉:糖色(褐)吸收,蓝通道衰减明显
  sugarHetian: {
    density: 2.96,
    sigmaA: [0.02, 0.045, 0.09],
    sigmaS: [0.05, 0.05, 0.045],
    ior: 1.61,
    roughness: 0.34,
    oiliness: 0.6,
  },
};

export function defaultMaterial(): JadeMaterial {
  return structuredClone(JADE_MATERIALS.whiteHetian);
}
