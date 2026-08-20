import type { Rng } from '../core/rng';
import { type Vec3, resampleByArcLength } from './spline';
import { type TrackValidation, validateTrack } from './trackValidator';
import { TRACK, VEHICLE } from './tuning';

/** 中心线上的一个采样点,附带条带生成和地面查询需要的全部信息。 */
export interface TrackSample {
  x: number;
  y: number;
  z: number;
  /** 水平切线(单位向量)。 */
  tangentX: number;
  tangentZ: number;
  /** 侧倾角(弧度)。**正值表示赛道右侧更高。** */
  bank: number;
  /** 从起跑线算起的累计弧长(米)。 */
  arc: number;
}

export interface TrackLayout {
  samples: TrackSample[];
  totalLength: number;
  spacing: number;
  halfWidth: number;
  /** 最终采用的那组控制点。渲染护栏和调试时有用。 */
  control: Vec3[];
  /** 试了几次才生成出合格的赛道。1 表示第一次就过了。 */
  attempts: number;
  validation: TrackValidation;
}

/**
 * 由 seed 生成一条合格的闭环赛道。
 *
 * **一定会返回结果。** 每失败一次就把抖动幅度收紧一档,极限是一个近似正圆,
 * 而正圆必然通过校验。把「生成不出来」甩给调用方等于把问题推到运行时,
 * 那会变成玩家点开就白屏。
 */
export function generateTrack(rng: Rng): TrackLayout {
  const limits = {
    halfWidth: TRACK.halfWidth,
    minCurvatureRadius: TRACK.minCurvatureRadius,
    maxGrade: TRACK.maxGrade,
  };

  let lastLayout: TrackLayout | null = null;

  for (let attempt = 1; attempt <= TRACK.maxAttempts; attempt++) {
    // 抖动幅度随尝试次数衰减:前几次放开了随机,实在生成不出来就逐步收敛成圆。
    const tameness = 1 - (attempt - 1) / TRACK.maxAttempts;
    const control = buildControlPoints(rng.fork(), tameness);
    const { points, totalLength, spacing } = resampleByArcLength(control, TRACK.spacing);
    const validation = validateTrack(points, limits);

    const layout: TrackLayout = {
      samples: buildSamples(points, spacing),
      totalLength,
      spacing,
      halfWidth: TRACK.halfWidth,
      control,
      attempts: attempt,
      validation,
    };
    lastLayout = layout;

    if (validation.ok) {
      return layout;
    }
  }

  // 走到这里说明收敛策略失效了,是我们的 bug 而不是运气问题,应该炸得明显。
  if (lastLayout === null) {
    throw new Error('赛道生成一次都没跑起来');
  }
  throw new Error(
    `试了 ${TRACK.maxAttempts} 组控制点仍未生成出合格赛道,` +
      `最后一次:最小曲率半径 ${lastLayout.validation.minCurvatureRadius.toFixed(1)}m、` +
      `最大坡度 ${lastLayout.validation.maxGrade.toFixed(3)}`,
  );
}

function buildControlPoints(rng: Rng, tameness: number): Vec3[] {
  const count =
    TRACK.minControlPoints + rng.int(TRACK.maxControlPoints - TRACK.minControlPoints + 1);

  const angleJitter = TRACK.angleJitter * tameness;
  const heightAmplitude = TRACK.heightAmplitude * tameness;
  const radiusSpread = (TRACK.maxRadius - TRACK.minRadius) * tameness;
  const baseRadius = (TRACK.minRadius + TRACK.maxRadius) / 2;

  const points: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const slot = (i / count) * Math.PI * 2;
    const angle = slot + rng.range(-angleJitter, angleJitter) * ((Math.PI * 2) / count);
    const radius = baseRadius + rng.range(-radiusSpread / 2, radiusSpread / 2);
    points.push({
      x: Math.cos(angle) * radius,
      y: rng.range(-heightAmplitude, heightAmplitude),
      z: Math.sin(angle) * radius,
    });
  }
  return points;
}

function buildSamples(points: readonly Vec3[], spacing: number): TrackSample[] {
  const count = points.length;
  const samples: TrackSample[] = [];

  for (let i = 0; i < count; i++) {
    const current = points[i];
    const next = points[(i + 1) % count];
    const prev = points[(i - 1 + count) % count];
    if (current === undefined || next === undefined || prev === undefined) {
      throw new RangeError('重采样点数不足');
    }

    // 用前后两点的中心差分求切线,比只看下一个点稳,弯道里不会抖。
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const length = Math.hypot(tx, tz) || 1;
    tx /= length;
    tz /= length;

    samples.push({
      x: current.x,
      y: current.y,
      z: current.z,
      tangentX: tx,
      tangentZ: tz,
      bank: 0,
      arc: i * spacing,
    });
  }

  applyBanking(samples, spacing);
  return samples;
}

/**
 * 由曲率推侧倾:半径越小倾得越狠,方向朝弯心。
 *
 * 形式借用「无侧向摩擦时刚好平衡」的理想侧倾角 `atan(v² / (r·g))`,但参考速度
 * 是造型参数而不是真实速度 —— 理由见 tuning.ts 里 bankReferenceSpeed 的注释。
 */
function applyBanking(samples: TrackSample[], spacing: number): void {
  const count = samples.length;
  const designSpeed = TRACK.bankReferenceSpeed;

  for (let i = 0; i < count; i++) {
    const prev = samples[(i - 1 + count) % count];
    const current = samples[i];
    const next = samples[(i + 1) % count];
    if (prev === undefined || current === undefined || next === undefined) {
      continue;
    }

    const ax = current.x - prev.x;
    const az = current.z - prev.z;
    const bx = next.x - current.x;
    const bz = next.z - current.z;

    // 叉积的 y 分量给出转向方向:俯视逆时针(左转)为正。
    const cross = az * bx - ax * bz;
    const chord = Math.hypot(next.x - prev.x, next.z - prev.z);
    const a = Math.hypot(ax, az);
    const b = Math.hypot(bx, bz);
    const area = Math.abs(cross) / 2;

    // 外接圆半径 R = abc / (4A);近似直线时 area 趋零,半径趋无穷,侧倾也趋零。
    const radius = area > 1e-9 ? (a * b * chord) / (4 * area) : Number.POSITIVE_INFINITY;
    const ideal = Math.atan((designSpeed * designSpeed) / (radius * VEHICLE.gravity));

    // 左转时弯心在左,外侧是右侧,所以右侧要抬高 —— 与 bank 正方向一致。
    current.bank = Math.sign(cross) * Math.min(ideal, TRACK.maxBank);
  }

  smoothBanking(samples);
  // 用重采样后的**实际**间距,不是 TRACK.spacing —— 两者差千分之一,
  // 而变化率上界是按间距推的,用错会让下游的保证差那么一点点。
  limitBankRate(samples, spacing);
}

/**
 * 限制侧倾沿赛道的变化率。
 *
 * 前向和反向各扫一遍并夹住相邻差值,重复几轮让约束绕过闭环的接缝传播开。
 * 每一步只会把值往下压,所以单调收敛,不会来回震荡。
 */
function limitBankRate(samples: TrackSample[], spacing: number): void {
  const count = samples.length;
  const maxDelta = TRACK.maxBankRatePerMeter * spacing;

  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < count; i++) {
      clampAgainst(samples, i, (i - 1 + count) % count, maxDelta);
    }
    for (let i = count - 1; i >= 0; i--) {
      clampAgainst(samples, i, (i + 1) % count, maxDelta);
    }
  }
}

function clampAgainst(
  samples: TrackSample[],
  index: number,
  neighbourIndex: number,
  maxDelta: number,
): void {
  const current = samples[index];
  const neighbour = samples[neighbourIndex];
  if (current === undefined || neighbour === undefined) {
    return;
  }
  const low = neighbour.bank - maxDelta;
  const high = neighbour.bank + maxDelta;
  current.bank = current.bank < low ? low : current.bank > high ? high : current.bank;
}

/**
 * 沿赛道把侧倾抹平。
 *
 * 逐点算出来的理想侧倾在弯道进出口是阶跃的,车压上去会被直接弹起来。
 * 真实赛道的侧倾也是渐变的(过渡段),所以这一步不是美化而是必需。
 */
function smoothBanking(samples: TrackSample[]): void {
  const count = samples.length;
  const buffer = new Float64Array(count);

  for (let pass = 0; pass < TRACK.bankSmoothingPasses; pass++) {
    for (let i = 0; i < count; i++) {
      const prev = samples[(i - 1 + count) % count]?.bank ?? 0;
      const current = samples[i]?.bank ?? 0;
      const next = samples[(i + 1) % count]?.bank ?? 0;
      buffer[i] = prev * 0.25 + current * 0.5 + next * 0.25;
    }
    for (let i = 0; i < count; i++) {
      const sample = samples[i];
      if (sample !== undefined) {
        sample.bank = buffer[i] ?? 0;
      }
    }
  }
}
