import { describe, it, expect } from 'vitest';
import { generateTestStones } from '../src/core/stoneGenerator';
import { validateTransmission, analyticSelfCheck } from '../src/core/validation';
import type { MediumOptics } from '../src/core/volume';

describe('透光校验报告', () => {
  it('所有测试料在 5% 阈值内通过,且厚度翻倍误差接近 0', () => {
    for (const stone of generateTestStones()) {
      const optics: MediumOptics = {
        sigmaA: stone.material.sigmaA,
        crackSigma: 0.25, cottonSigma: 0.12, impuritySigma: 0.18,
      };
      const report = validateTransmission(stone.volume, stone.labels, optics, [3, 6, 12, 24, 36], 5);
      expect(report.passed).toBe(true);
      expect(report.maxErrorPct).toBeLessThan(5);
      for (const d of report.doublingChecks) {
        expect(Math.max(...d.errorPct)).toBeLessThan(1e-9);
      }
    }
  });

  it('解析自检误差为浮点级', () => {
    const r = analyticSelfCheck(0.02);
    expect(r.errorPct).toBeLessThan(1e-10);
  });
});
