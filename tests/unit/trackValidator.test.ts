import { describe, expect, it } from 'vitest';
import {
  type TrackLimits,
  type TrackPoint,
  curvatureRadiusAt,
  findSelfIntersections,
  gradeAt,
  validateTrack,
} from '../../src/game/trackValidator';

/** 平放的正圆。每三个连续点的外接圆半径精确等于 radius。 */
function circle(radius: number, count: number, y = 0): TrackPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const t = (i / count) * Math.PI * 2;
    return { x: Math.cos(t) * radius, y, z: Math.sin(t) * radius };
  });
}

/** 正圆但高度按正弦起伏,用来造坡度。 */
function tiltedCircle(radius: number, count: number, amplitude: number): TrackPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const t = (i / count) * Math.PI * 2;
    return { x: Math.cos(t) * radius, y: Math.sin(t) * amplitude, z: Math.sin(t) * radius };
  });
}

/** Gerono 双纽线(8 字),在原点自交。count 取 4 的倍数时会有两个点精确重合。 */
function figureEight(scale: number, count: number): TrackPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const t = (i / count) * Math.PI * 2;
    return { x: Math.cos(t) * scale, y: 0, z: Math.sin(t) * Math.cos(t) * scale };
  });
}

const LIMITS: TrackLimits = { halfWidth: 8, minCurvatureRadius: 100, maxGrade: 0.3 };

/*
 * 这 20 条现在是 skip 的,因为 trackValidator.ts 还只是接口桩。
 *
 * 先写测试再写实现是刻意的:这块要交给外部实现,测试就是验收标准,
 * 必须在实现出现之前就固定下来,否则很容易变成「照着实现改测试」。
 *
 * **实现合入时,把下面四个 describe.skip 的 .skip 去掉。** 桩里的
 * `throw new Error('未实现')` 还在,漏掉了会立刻炸,不会静默放行。
 */

describe('curvatureRadiusAt', () => {
  it('正圆上每一点的曲率半径都等于圆半径', () => {
    const points = circle(150, 120);
    for (let i = 0; i < points.length; i++) {
      expect(curvatureRadiusAt(points, i)).toBeCloseTo(150, 6);
    }
  });

  it('首尾按闭环回绕,不是断开的', () => {
    const points = circle(150, 120);
    expect(curvatureRadiusAt(points, 0)).toBeCloseTo(150, 6);
    expect(curvatureRadiusAt(points, points.length - 1)).toBeCloseTo(150, 6);
  });

  it('三点共线时是 Infinity', () => {
    const points: TrackPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 20, y: 0, z: 0 },
      { x: 10, y: 0, z: 10 },
    ];
    expect(curvatureRadiusAt(points, 1)).toBe(Number.POSITIVE_INFINITY);
  });

  it('只看俯视形状:纯上下起伏不该被当成急弯', () => {
    const flat = circle(150, 120);
    const hilly = tiltedCircle(150, 120, 40);
    for (let i = 0; i < flat.length; i++) {
      expect(curvatureRadiusAt(hilly, i)).toBeCloseTo(curvatureRadiusAt(flat, i), 6);
    }
  });
});

describe('gradeAt', () => {
  it('平的赛道坡度是 0', () => {
    const points = circle(150, 120);
    for (let i = 0; i < points.length; i++) {
      expect(gradeAt(points, i)).toBe(0);
    }
  });

  it('= |Δy| / 水平距离', () => {
    const points: TrackPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: 100, y: 0, z: 0 },
      { x: 100, y: 0, z: 100 },
      { x: 0, y: 10, z: 100 },
    ];
    // 点 2 → 点 3:水平走 100,垂直升 10。
    expect(gradeAt(points, 2)).toBeCloseTo(0.1, 10);
  });

  it('最后一个点回绕到第一个点', () => {
    const points: TrackPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: 100, y: 0, z: 0 },
      { x: 100, y: 0, z: 100 },
      { x: 0, y: 20, z: 100 },
    ];
    // 点 3 → 点 0:水平走 100,垂直降 20。
    expect(gradeAt(points, 3)).toBeCloseTo(0.2, 10);
  });

  it('水平距离为 0 时是 Infinity', () => {
    const points: TrackPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 30, z: 0 },
      { x: 100, y: 0, z: 0 },
      { x: 50, y: 0, z: 80 },
    ];
    expect(gradeAt(points, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('findSelfIntersections', () => {
  it('正圆不自交', () => {
    expect(findSelfIntersections(circle(150, 120), 8)).toEqual([]);
  });

  it('相邻线段不算自交 —— 否则每一对都会误报', () => {
    // 半径小到相邻点间距远小于条带宽度,但它仍然是一条合法的圆形赛道。
    expect(findSelfIntersections(circle(60, 200), 8)).toEqual([]);
  });

  it('共用端点的相邻线段永远不算自交,哪怕点很稀疏', () => {
    // 边长 100 米、只有 4 个点的方形闭环。相邻段的弧长距离(100)远超
    // 4 * halfWidth(32),如果只靠弧长阈值排除,这条完全合法的赛道会被
    // 报出 4 处「距离为 0」的自交 —— 那是首尾相接,不是压到自己。
    const square: TrackPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: 100, y: 0, z: 0 },
      { x: 100, y: 0, z: 100 },
      { x: 0, y: 0, z: 100 },
    ];
    expect(findSelfIntersections(square, 8)).toEqual([]);
    expect(validateTrack(square, { ...LIMITS, minCurvatureRadius: 20 }).ok).toBe(true);
  });

  it('8 字形会被抓出来', () => {
    const found = findSelfIntersections(figureEight(200, 160), 8);
    expect(found.length).toBeGreaterThan(0);
    for (const hit of found) {
      expect(hit.indexA).toBeLessThan(hit.indexB);
      expect(hit.distance).toBeLessThan(16);
    }
  });

  it('结果顺序稳定,先按 indexA 再按 indexB 升序', () => {
    const found = findSelfIntersections(figureEight(200, 160), 8);
    const sorted = [...found].sort((a, b) => a.indexA - b.indexA || a.indexB - b.indexB);
    expect(found).toEqual(sorted);
    expect(findSelfIntersections(figureEight(200, 160), 8)).toEqual(found);
  });

  it('条带越宽越容易判定为自交', () => {
    const narrow = findSelfIntersections(figureEight(200, 160), 4).length;
    const wide = findSelfIntersections(figureEight(200, 160), 20).length;
    expect(wide).toBeGreaterThanOrEqual(narrow);
  });
});

describe('validateTrack', () => {
  it('宽敞的平圆合格', () => {
    const result = validateTrack(circle(150, 120), LIMITS);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.minCurvatureRadius).toBeCloseTo(150, 6);
    expect(result.maxGrade).toBe(0);
  });

  it('弯太急时不合格,并报出实测半径', () => {
    const result = validateTrack(circle(150, 120), { ...LIMITS, minCurvatureRadius: 200 });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === 'curvature')).toBe(true);
    expect(result.minCurvatureRadius).toBeCloseTo(150, 6);
  });

  it('坡太陡时不合格', () => {
    const result = validateTrack(tiltedCircle(150, 120, 90), LIMITS);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === 'grade')).toBe(true);
    expect(result.maxGrade).toBeGreaterThan(LIMITS.maxGrade);
  });

  it('自交时不合格', () => {
    const result = validateTrack(figureEight(300, 160), LIMITS);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === 'self-intersection')).toBe(true);
  });

  it('problems 按 自交 → 曲率 → 坡度 分组排列', () => {
    const order = { 'self-intersection': 0, curvature: 1, grade: 2 } as const;
    const result = validateTrack(
      figureEight(120, 160).map((p, i) => ({
        ...p,
        y: Math.sin((i / 160) * Math.PI * 6) * 40,
      })),
      LIMITS,
    );

    expect(result.ok).toBe(false);
    const ranks = result.problems.map((p) => order[p.kind]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('是纯函数:同样输入永远同样输出,且不改动入参', () => {
    const points = figureEight(300, 160);
    const snapshot = JSON.stringify(points);

    const first = validateTrack(points, LIMITS);
    const second = validateTrack(points, LIMITS);

    expect(second).toEqual(first);
    expect(JSON.stringify(points)).toBe(snapshot);
  });

  it('点太少或半宽非法时抛 RangeError,而不是静默放行', () => {
    expect(() => validateTrack(circle(150, 3), LIMITS)).toThrow(RangeError);
    expect(() => validateTrack(circle(150, 120), { ...LIMITS, halfWidth: 0 })).toThrow(RangeError);
  });
});
