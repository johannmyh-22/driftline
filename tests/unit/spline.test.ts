import { describe, expect, it } from 'vitest';
import { type Vec3, resampleByArcLength, sampleClosedSpline } from '../../src/game/spline';

/** 摆成正多边形的控制点。Catmull-Rom 穿过控制点,所以采样结果应该接近正圆。 */
function ring(radius: number, count: number, y = 0): Vec3[] {
  return Array.from({ length: count }, (_, i) => {
    const t = (i / count) * Math.PI * 2;
    return { x: Math.cos(t) * radius, y, z: Math.sin(t) * radius };
  });
}

describe('sampleClosedSpline', () => {
  it('整数 t 处精确穿过控制点', () => {
    const control = ring(200, 8);
    const out: Vec3 = { x: 0, y: 0, z: 0 };

    for (let i = 0; i < control.length; i++) {
      sampleClosedSpline(control, i, out);
      const expected = control[i];
      expect(expected).toBeDefined();
      expect(out.x).toBeCloseTo(expected?.x ?? 0, 10);
      expect(out.z).toBeCloseTo(expected?.z ?? 0, 10);
    }
  });

  it('t 回绕:t = n 等价于 t = 0', () => {
    const control = ring(200, 8);
    const a: Vec3 = { x: 0, y: 0, z: 0 };
    const b: Vec3 = { x: 0, y: 0, z: 0 };

    sampleClosedSpline(control, 0, a);
    sampleClosedSpline(control, control.length, b);
    expect(b.x).toBeCloseTo(a.x, 10);
    expect(b.z).toBeCloseTo(a.z, 10);

    sampleClosedSpline(control, -1, a);
    sampleClosedSpline(control, control.length - 1, b);
    expect(b.x).toBeCloseTo(a.x, 10);
  });

  it('控制点少于 4 个时抛错', () => {
    const out: Vec3 = { x: 0, y: 0, z: 0 };
    expect(() => sampleClosedSpline(ring(200, 3), 0, out)).toThrow(RangeError);
  });

  it('闭合处是连续的,不会有突然的跳变', () => {
    const control = ring(200, 8);
    const a: Vec3 = { x: 0, y: 0, z: 0 };
    const b: Vec3 = { x: 0, y: 0, z: 0 };

    sampleClosedSpline(control, control.length - 0.001, a);
    sampleClosedSpline(control, 0.001, b);
    expect(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)).toBeLessThan(1);
  });
});

describe('resampleByArcLength', () => {
  it('点间距真的均匀', () => {
    const { points, spacing } = resampleByArcLength(ring(300, 10), 8);

    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      const step = Math.hypot(
        (b?.x ?? 0) - (a?.x ?? 0),
        (b?.y ?? 0) - (a?.y ?? 0),
        (b?.z ?? 0) - (a?.z ?? 0),
      );
      // 直线段近似弧长,会略小于弧长本身,给 1% 的余量。
      expect(step).toBeGreaterThan(spacing * 0.98);
      expect(step).toBeLessThan(spacing * 1.02);
    }
  });

  it('接缝处不会留下长短不一的碎片', () => {
    const { points, totalLength, spacing } = resampleByArcLength(ring(300, 10), 7);
    // 实际间距被调整成能整除总长,所以点数 × 间距 == 总长。
    expect(points.length * spacing).toBeCloseTo(totalLength, 6);
  });

  it('正多边形控制点重采样出来接近正圆', () => {
    const radius = 300;
    const { points, totalLength } = resampleByArcLength(ring(radius, 16), 10);

    for (const p of points) {
      expect(Math.hypot(p.x, p.z)).toBeCloseTo(radius, 0);
    }
    expect(totalLength).toBeCloseTo(2 * Math.PI * radius, -1);
  });

  it('高度也跟着插值,不是只管平面', () => {
    const control = ring(300, 8).map((p, i) => ({ ...p, y: i % 2 === 0 ? 0 : 40 }));
    const { points } = resampleByArcLength(control, 10);
    const heights = points.map((p) => p.y);
    expect(Math.max(...heights)).toBeGreaterThan(20);
    expect(Math.min(...heights)).toBeLessThan(20);
  });

  it('完全确定:同样的控制点给出同样的采样序列', () => {
    const control = ring(300, 10);
    expect(resampleByArcLength(control, 8)).toEqual(resampleByArcLength(control, 8));
  });

  it('spacing 非正时抛错', () => {
    expect(() => resampleByArcLength(ring(300, 8), 0)).toThrow(RangeError);
    expect(() => resampleByArcLength(ring(300, 8), -5)).toThrow(RangeError);
  });
});
