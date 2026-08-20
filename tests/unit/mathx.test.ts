import { describe, expect, it } from 'vitest';
import { clamp, damp, lerp, moveToward, normalize01 } from '../../src/core/mathx';

describe('mathx', () => {
  it('clamp 截断到区间', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it('lerp 端点精确', () => {
    expect(lerp(2, 8, 0)).toBe(2);
    expect(lerp(2, 8, 1)).toBe(8);
    expect(lerp(2, 8, 0.5)).toBe(5);
  });

  it('damp 单调趋近且不过冲', () => {
    let value = 0;
    for (let i = 0; i < 200; i++) {
      const next = damp(value, 10, 5, 1 / 60);
      expect(next).toBeGreaterThanOrEqual(value);
      expect(next).toBeLessThanOrEqual(10);
      value = next;
    }
    expect(value).toBeCloseTo(10, 3);
  });

  it('damp 对步长划分稳定 —— 这是它存在的全部理由', () => {
    // 走 1 大步 vs 走 10 小步,总时长相同,结果应该几乎一样。
    const oneStep = damp(0, 10, 4, 0.5);

    let split = 0;
    for (let i = 0; i < 10; i++) {
      split = damp(split, 10, 4, 0.05);
    }

    expect(split).toBeCloseTo(oneStep, 10);
  });

  it('moveToward 精确命中目标,不过冲', () => {
    expect(moveToward(0, 1, 0.3)).toBeCloseTo(0.3, 10);
    expect(moveToward(0.9, 1, 0.3)).toBe(1);
    expect(moveToward(-0.9, -1, 0.3)).toBe(-1);
  });

  it('normalize01 映射并截断', () => {
    expect(normalize01(5, 0, 10)).toBe(0.5);
    expect(normalize01(-5, 0, 10)).toBe(0);
    expect(normalize01(50, 0, 10)).toBe(1);
    expect(normalize01(3, 7, 7)).toBe(0);
  });
});
