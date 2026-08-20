/**
 * 闭合 Catmull-Rom 样条与弧长重采样。纯数学,不依赖 three.js。
 *
 * 赛道的每一样东西 —— 条带网格、悬浮时的地面查询、检查点、循迹自动驾驶 ——
 * 都从这里重采样出来的那一串点出发。所以它必须是确定的:同样的控制点
 * 永远给出同样的采样序列,一个浮点都不差。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 每段控制点之间先密集采多少个样,用来建弧长表。 */
const ARC_TABLE_STEPS = 48;

/**
 * 标准 Catmull-Rom(张力 0.5)。
 *
 * 用它而不是 B 样条:Catmull-Rom **穿过**控制点,所以「把控制点摆成一个圈」
 * 就真的能得到一条环形赛道,调起来直观。
 */
function interpolate(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function wrap(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function pick(points: readonly Vec3[], index: number): Vec3 {
  const point = points[wrap(index, points.length)];
  if (point === undefined) {
    throw new RangeError('控制点数组不能为空');
  }
  return point;
}

/**
 * 在闭合样条上取一点。`t` 的整数部分选段,小数部分是段内参数;
 * 超出 `[0, control.length)` 会自动回绕。
 */
export function sampleClosedSpline(control: readonly Vec3[], t: number, out: Vec3): void {
  const count = control.length;
  if (count < 4) {
    throw new RangeError(`闭合样条至少需要 4 个控制点,收到 ${count}`);
  }

  const segment = Math.floor(t);
  const local = t - segment;

  const p0 = pick(control, segment - 1);
  const p1 = pick(control, segment);
  const p2 = pick(control, segment + 1);
  const p3 = pick(control, segment + 2);

  out.x = interpolate(p0.x, p1.x, p2.x, p3.x, local);
  out.y = interpolate(p0.y, p1.y, p2.y, p3.y, local);
  out.z = interpolate(p0.z, p1.z, p2.z, p3.z, local);
}

export interface ResampledSpline {
  /** 沿弧长等距的采样点,闭环(最后一个点之后接回第 0 个)。 */
  points: Vec3[];
  /** 闭环总长度(米)。 */
  totalLength: number;
  /** 实际点间距。不等于请求的 spacing —— 见下面的说明。 */
  spacing: number;
}

/**
 * 按弧长等距重采样。
 *
 * 实际间距会被调整成 `总长 / round(总长 / spacing)`,而不是严格等于请求值:
 * 闭环的总长几乎不可能是间距的整数倍,硬按请求值走会在接缝处留下一段
 * 长短不一的碎片,而下游(条带网格、检查点、曲率校验)全都假设间距均匀。
 */
export function resampleByArcLength(control: readonly Vec3[], spacing: number): ResampledSpline {
  if (spacing <= 0) {
    throw new RangeError(`spacing 必须为正,收到 ${spacing}`);
  }

  // 第一遍:密集采样并累计弧长。
  const dense: Vec3[] = [];
  const cumulative: number[] = [0];
  const scratch: Vec3 = { x: 0, y: 0, z: 0 };
  const steps = control.length * ARC_TABLE_STEPS;

  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * control.length;
    sampleClosedSpline(control, t, scratch);
    dense.push({ x: scratch.x, y: scratch.y, z: scratch.z });

    if (i > 0) {
      const prev = dense[i - 1];
      const current = dense[i];
      if (prev !== undefined && current !== undefined) {
        const step = Math.hypot(current.x - prev.x, current.y - prev.y, current.z - prev.z);
        cumulative.push((cumulative[i - 1] ?? 0) + step);
      }
    }
  }

  const totalLength = cumulative[cumulative.length - 1] ?? 0;
  const count = Math.max(4, Math.round(totalLength / spacing));
  const actualSpacing = totalLength / count;

  // 第二遍:在弧长表上走,等距取点。
  const points: Vec3[] = [];
  let cursor = 0;
  for (let k = 0; k < count; k++) {
    const target = k * actualSpacing;
    while (cursor < cumulative.length - 2 && (cumulative[cursor + 1] ?? 0) < target) {
      cursor++;
    }

    const a = dense[cursor];
    const b = dense[cursor + 1];
    const arcA = cumulative[cursor] ?? 0;
    const arcB = cumulative[cursor + 1] ?? arcA;
    if (a === undefined || b === undefined) {
      break;
    }

    const span = arcB - arcA;
    const f = span > 0 ? (target - arcA) / span : 0;
    points.push({
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: a.z + (b.z - a.z) * f,
    });
  }

  return { points, totalLength, spacing: actualSpacing };
}
