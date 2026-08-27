/**
 * 甩尾 / 直线打转分离探针。
 *
 * 背景见 `docs/HANDOFF.md` 第十九节:`TIRE.overdriveSlipMax` 往上调甩尾就回来,
 * 直线打转按同样比例一起回来 —— 一个旋钮同时管两件事。这个脚本的唯一目的是
 * **把这两件事分别量出来**,让「有没有分开」变成可读的数,而不是靠试玩体感。
 *
 * 两个工况**故意跑在不同场地**,这是上一轮用大半个窗口换来的教训:
 *
 *   - 打转量在**真赛道**上(`Course` + `generateTrack`)。平地左右载荷天然对称,
 *     而打转的根因恰恰是载荷不对称 —— 平地会把病因整个抹掉。
 *   - 甩尾量在**绝对平地**上。它是轮胎本征能力,赛道的倾斜弯和坡会让读数随
 *     车停在哪个弯混沌跳变,那是拟合噪声。
 *
 * **只做测量,不改任何默认参数。** `--set` 只在本进程内临时改写,不落盘。
 *
 * 用法:
 *   npx tsx scripts/drift-probe.ts
 *   npx tsx scripts/drift-probe.ts --set=TIRE.overdriveSlipMax=6
 *   npx tsx scripts/drift-probe.ts --seeds=1,42,1337 --speeds=60,100
 */

import process from 'node:process';
import { createInputFrame } from '../src/core/input';
import { FIXED_DT } from '../src/core/loop';
import { Rng } from '../src/core/rng';
import { Course } from '../src/game/course';
import { readTelemetry, setTelemetryEnabled } from '../src/game/diagnostics';
import type { GroundHit, GroundQuery } from '../src/game/groundQuery';
import { Physics, initPhysics } from '../src/game/physics';
import { generateTrack } from '../src/game/trackLayout';
import { CAR, TIRE } from '../src/game/tuning';
import { Vehicle } from '../src/game/vehicle';

/** 去掉 readonly,给 `--set` 用。`as const` 只是类型上的只读,运行时可写。 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const MUTABLE_TABLES: Record<string, Mutable<Record<string, number>>> = {
  TIRE: TIRE as unknown as Mutable<Record<string, number>>,
  CAR: CAR as unknown as Mutable<Record<string, number>>,
};

/** 与 gripFlat.test.ts 的桩一致:绝对平面,没有起伏也没有墙。 */
const flatGround: GroundQuery = {
  sample(_x: number, _z: number, out: GroundHit): void {
    out.height = 0;
    out.normalX = 0;
    out.normalY = 1;
    out.normalZ = 0;
    out.lateral = 0;
    out.arc = 0;
    out.segment = 0;
    out.onTrack = true;
    out.tangentX = 0;
    out.tangentZ = 1;
    out.wallDistance = Number.POSITIVE_INFINITY;
  },
};

const RAD = 180 / Math.PI;

interface StraightResult {
  seed: number;
  peakYawRate3s: number;
  peakYawRateFull: number;
  finalKmh: number;
  peakBetaDeg: number;
  lateralDriftM: number;
  /** 车离开赛道面的帧号;-1 = 全程都在赛道上。出界之后的读数是地形,不算数。 */
  offTrackFrame: number;
  /** 只统计还在赛道上那一段的峰值 yawRate。 */
  peakYawRateOnTrack: number;
}

interface DriftResult {
  entryKmh: number;
  /** 稳态段(最后 1 秒)的车身侧滑角。 */
  steadyBetaDeg: number;
  peakBetaDeg: number;
  /** 稳态段的后轴侧偏角 —— 「车尾真的在滑」的诚实指标,不含运动学分量。 */
  steadyRearAlphaDeg: number;
  peakRearAlphaDeg: number;
  steadyFrontAlphaDeg: number;
  steadyRearSlipRatio: number;
  steadyYawRate: number;
  /** 稳态前轮转角(度)。用来判断前轮是不是被打过了峰值侧偏角。 */
  steadySteerDeg: number;
  /** 稳态前/后轴侧向力合计(牛)。均衡看这两个数,不看单一标量。 */
  steadyFrontFy: number;
  steadyRearFy: number;
  exitKmh: number;
  /** 松开油门与方向后 1.5 秒,侧滑角是否收回来(收得回来才算「能收」)。 */
  recoverBetaDeg: number;
}

/**
 * 同样的直线工况跑在**绝对平地**上。
 *
 * 这是用来分因的:平地左右载荷天然对称,所以平地上还剩的 yawRate 只可能来自
 * 底盘/驱动链自己的不对称(那是 bug);平地为 0 而赛道上有,说明车只是**扛不住
 * 地形扰动**(那是稳定性不足,不是不对称 bug)。两者的修法完全不同。
 */
function measureStraightFlat(frames: number): number {
  const vehicle = new Vehicle(flatGround, new Physics());
  vehicle.reset(0, 0, 0);
  const input = createInputFrame();
  input.throttle = 1;
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    vehicle.update(input, FIXED_DT);
    peak = Math.max(peak, Math.abs(vehicle.yawRate));
  }
  return peak;
}

function makeCourseVehicle(seed: number): Vehicle {
  const rng = new Rng(seed);
  const layout = generateTrack(rng.fork());
  const course = new Course(layout, rng.fork());
  const vehicle = new Vehicle(course, new Physics());
  const start = layout.samples[0];
  if (start === undefined) {
    throw new Error('赛道没有采样点');
  }
  vehicle.reset(start.x, start.z, Math.atan2(start.tangentX, start.tangentZ));
  return vehicle;
}

/** 车身侧滑角(度):车头方向与速度方向的夹角。0 = 车头正对着走。 */
function betaDegrees(vehicle: Vehicle): number {
  const speed = Math.hypot(vehicle.velocity.x, vehicle.velocity.z);
  if (speed < 0.5) {
    return 0;
  }
  return Math.abs(Math.atan2(vehicle.lateralSpeed, speed)) * RAD;
}

/** 满油门直线、方向盘不动:量打转。必须在真赛道上跑。 */
function measureStraight(seed: number, frames: number): StraightResult {
  const vehicle = makeCourseVehicle(seed);
  const input = createInputFrame();
  input.throttle = 1;
  input.steer = 0;

  const x0 = vehicle.position.x;
  const z0 = vehicle.position.z;
  const yaw0 = vehicle.yaw;
  const fx = Math.sin(yaw0);
  const fz = Math.cos(yaw0);

  let peak3s = 0;
  let peakFull = 0;
  let peakOnTrack = 0;
  let peakBeta = 0;
  let offTrackFrame = -1;
  for (let f = 0; f < frames; f++) {
    vehicle.update(input, FIXED_DT);
    const yr = Math.abs(vehicle.yawRate);
    peakFull = Math.max(peakFull, yr);
    if (f < 180) {
      peak3s = Math.max(peak3s, yr);
    }
    if (offTrackFrame < 0) {
      if (vehicle.onTrack) {
        peakOnTrack = Math.max(peakOnTrack, yr);
      } else {
        offTrackFrame = f;
      }
    }
    peakBeta = Math.max(peakBeta, betaDegrees(vehicle));
  }

  // 出发方向的法向位移 = 「跑偏了多少米」,比 yawRate 更贴近人开着的感觉。
  const dx = vehicle.position.x - x0;
  const dz = vehicle.position.z - z0;
  const lateralDrift = Math.abs(dx * fz - dz * fx);

  return {
    seed,
    peakYawRate3s: peak3s,
    peakYawRateFull: peakFull,
    finalKmh: vehicle.groundSpeed * 3.6,
    peakBetaDeg: peakBeta,
    lateralDriftM: lateralDrift,
    offTrackFrame,
    peakYawRateOnTrack: peakOnTrack,
  };
}

/** 平地上加速到 `entryKmh`,再满油门 + 满舵 3 秒:量甩尾。 */
function measureDrift(entryKmh: number, holdFrames: number, steer: number): DriftResult {
  const vehicle = new Vehicle(flatGround, new Physics());
  vehicle.reset(0, 0, 0);
  const input = createInputFrame();
  input.throttle = 1;
  input.steer = 0;

  let f = 0;
  while (vehicle.groundSpeed * 3.6 < entryKmh && f < 60 * 40) {
    vehicle.update(input, FIXED_DT);
    f++;
  }
  const entry = vehicle.groundSpeed * 3.6;

  input.steer = steer;
  let peakBeta = 0;
  let peakRearAlpha = 0;
  let betaSum = 0;
  let rearAlphaSum = 0;
  let frontAlphaSum = 0;
  let rearSlipSum = 0;
  let yawSum = 0;
  let steerSum = 0;
  let frontFySum = 0;
  let rearFySum = 0;
  let steadyCount = 0;
  const steadyFrom = holdFrames - 60;

  for (let i = 0; i < holdFrames; i++) {
    vehicle.update(input, FIXED_DT);
    const t = readTelemetry();
    const w2 = t.wheels[2];
    const w3 = t.wheels[3];
    const w0 = t.wheels[0];
    const w1 = t.wheels[1];
    const rearAlpha =
      w2 !== undefined && w3 !== undefined ? (Math.abs(w2.slipAngle) + Math.abs(w3.slipAngle)) / 2 : 0;
    const frontAlpha =
      w0 !== undefined && w1 !== undefined ? (Math.abs(w0.slipAngle) + Math.abs(w1.slipAngle)) / 2 : 0;
    const rearSlip =
      w2 !== undefined && w3 !== undefined ? (Math.abs(w2.slipRatio) + Math.abs(w3.slipRatio)) / 2 : 0;
    const beta = betaDegrees(vehicle);
    peakBeta = Math.max(peakBeta, beta);
    peakRearAlpha = Math.max(peakRearAlpha, rearAlpha * RAD);
    if (i >= steadyFrom) {
      steerSum += Math.abs(vehicle.steerAngle) * RAD;
      frontFySum +=
        w0 !== undefined && w1 !== undefined ? Math.abs(w0.fy + w1.fy) : 0;
      rearFySum += w2 !== undefined && w3 !== undefined ? Math.abs(w2.fy + w3.fy) : 0;
      betaSum += beta;
      rearAlphaSum += rearAlpha * RAD;
      frontAlphaSum += frontAlpha * RAD;
      rearSlipSum += rearSlip;
      yawSum += Math.abs(vehicle.yawRate);
      steadyCount++;
    }
  }
  const exit = vehicle.groundSpeed * 3.6;

  // 松开油门与方向,看侧滑角收不收得回来。「甩得出去还收得回来」是人类的原话。
  input.throttle = 0;
  input.steer = 0;
  for (let i = 0; i < 90; i++) {
    vehicle.update(input, FIXED_DT);
  }

  const n = Math.max(1, steadyCount);
  return {
    entryKmh: entry,
    steadyBetaDeg: betaSum / n,
    peakBetaDeg: peakBeta,
    steadyRearAlphaDeg: rearAlphaSum / n,
    peakRearAlphaDeg: peakRearAlpha,
    steadyFrontAlphaDeg: frontAlphaSum / n,
    steadyRearSlipRatio: rearSlipSum / n,
    steadyYawRate: yawSum / n,
    steadySteerDeg: steerSum / n,
    steadyFrontFy: frontFySum / n,
    steadyRearFy: rearFySum / n,
    exitKmh: exit,
    recoverBetaDeg: betaDegrees(vehicle),
  };
}

/**
 * 平地峰值侧向抓地(m/s²)。与 `gripFlat.test.ts` 同工况:定速过弯、扫转向角
 * 取最大 —— 人类那条 1.3~1.6 g 的验收线就量在这里,调参时要能随手复核。
 */
function measurePeakLateralFlat(targetKmh: number): number {
  let peak = 0;
  for (const steer of [0.45, 0.6, 0.8, 1]) {
    const vehicle = new Vehicle(flatGround, new Physics());
    vehicle.reset(0, 0, 0);
    const input = createInputFrame();
    input.throttle = 1;
    let f = 0;
    while (vehicle.groundSpeed * 3.6 < targetKmh && f < 60 * 40) {
      vehicle.update(input, FIXED_DT);
      f++;
    }
    input.steer = steer;
    for (let i = 0; i < 60 * 3; i++) {
      input.throttle = vehicle.groundSpeed * 3.6 < targetKmh ? 0.25 : 0;
      vehicle.update(input, FIXED_DT);
      peak = Math.max(peak, vehicle.lateralGripAccel);
    }
  }
  return peak;
}

/** 平地极速(km/h)。加功率限制会动它,必须一起盯着。 */
function measureTopSpeedFlat(): number {
  const vehicle = new Vehicle(flatGround, new Physics());
  vehicle.reset(0, 0, 0);
  const input = createInputFrame();
  input.throttle = 1;
  let last = 0;
  for (let i = 0; i < 60 * 240; i++) {
    vehicle.update(input, FIXED_DT);
    if (i % 60 === 0) {
      const now = vehicle.groundSpeed;
      if (i > 600 && now - last < 0.01) {
        break;
      }
      last = now;
    }
  }
  return vehicle.groundSpeed * 3.6;
}

/** 平地 0-100,确定性版本(赛道版随轨迹混沌跳变,不能拿来调参)。 */
function measureZeroTo100Flat(): number {
  const vehicle = new Vehicle(flatGround, new Physics());
  vehicle.reset(0, 0, 0);
  const input = createInputFrame();
  input.throttle = 1;
  let f = 0;
  while (vehicle.groundSpeed * 3.6 < 100 && f < 60 * 40) {
    vehicle.update(input, FIXED_DT);
    f++;
  }
  return f >= 60 * 40 ? Number.NaN : f * FIXED_DT;
}

function applyOverrides(spec: string): void {
  for (const item of spec.split(',')) {
    if (item.trim() === '') {
      continue;
    }
    const [pathPart, valuePart] = item.split('=');
    if (pathPart === undefined || valuePart === undefined) {
      throw new Error(`--set 格式应为 TABLE.key=数值,收到 ${item}`);
    }
    const [table, key] = pathPart.split('.');
    if (table === undefined || key === undefined) {
      throw new Error(`--set 格式应为 TABLE.key=数值,收到 ${item}`);
    }
    const target = MUTABLE_TABLES[table];
    if (target === undefined) {
      throw new Error(`未知的参数表 ${table}(只支持 TIRE / CAR)`);
    }
    if (!(key in target)) {
      throw new Error(`${table} 里没有 ${key}`);
    }
    const value = Number(valuePart);
    if (!Number.isFinite(value)) {
      throw new Error(`${item} 的值不是有限数`);
    }
    target[key] = value;
  }
}

function fmt(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let seeds = [1, 42, 1337];
  let speeds = [60, 100];
  let steers = [1];
  let straightFrames = 300;
  let holdFrames = 180;

  for (const arg of args) {
    if (arg.startsWith('--set=')) {
      applyOverrides(arg.slice('--set='.length));
    } else if (arg.startsWith('--seeds=')) {
      seeds = arg.slice('--seeds='.length).split(',').map(Number);
    } else if (arg.startsWith('--steers=')) {
      steers = arg.slice('--steers='.length).split(',').map(Number);
    } else if (arg.startsWith('--speeds=')) {
      speeds = arg.slice('--speeds='.length).split(',').map(Number);
    } else if (arg.startsWith('--frames=')) {
      straightFrames = Number(arg.slice('--frames='.length));
    } else if (arg.startsWith('--hold=')) {
      holdFrames = Number(arg.slice('--hold='.length));
    } else {
      throw new Error(`未知参数 ${arg}`);
    }
  }

  await initPhysics();
  setTelemetryEnabled(true);

  console.log(
    `overdriveSlipMax=${fmt(TIRE.overdriveSlipMax, 2)} ` +
      `overdriveSlipGain=${fmt(TIRE.overdriveSlipGain, 2)} ` +
      `overdriveSlipSpeed=${fmt(TIRE.overdriveSlipSpeed, 1)} ` +
      `driveTorque=${fmt(CAR.driveTorque, 0)} mu0=${fmt(TIRE.mu0, 3)}`,
  );

  console.log(
    `\n0-100(平地,确定性): ${fmt(measureZeroTo100Flat(), 2)} s;` +
      ` 极速: ${fmt(measureTopSpeedFlat(), 0)} km/h`,
  );
  const peak100 = measurePeakLateralFlat(100);
  const peak80 = measurePeakLateralFlat(80);
  console.log(
    `平地峰值侧向抓地 100 km/h: ${fmt(peak100, 3)} m/s² = ${fmt(peak100 / 9.81, 3)} g` +
      `(验收线 1.3~1.6 g);80 km/h: ${fmt(peak80 / 9.81, 3)} g`,
  );

  console.log(
    `\n平地满油门直线 ${straightFrames} 帧的峰值 yawRate: ` +
      `${fmt(measureStraightFlat(straightFrames), 5)}(≈0 说明底盘对称,赛道上的偏航是地形扰动)`,
  );

  console.log('\n== 打转:满油门直线、方向盘不动(真赛道)==');
  console.log('seed  peakYaw3s  峰值(在赛道上)  出界帧  peakYawFull  跑偏(m)  峰值β(°)  末速(km/h)');
  for (const seed of seeds) {
    const r = measureStraight(seed, straightFrames);
    console.log(
      `${String(r.seed).padEnd(6)}${fmt(r.peakYawRate3s).padEnd(11)}` +
        `${fmt(r.peakYawRateOnTrack).padEnd(16)}${String(r.offTrackFrame).padEnd(9)}` +
        `${fmt(r.peakYawRateFull).padEnd(13)}${fmt(r.lateralDriftM, 2).padEnd(10)}` +
        `${fmt(r.peakBetaDeg, 2).padEnd(11)}${fmt(r.finalKmh, 1)}`,
    );
  }

  console.log('\n== 甩尾:满油门 + 打舵 3 秒(平地)==');
  console.log(
    '入弯   舵   前轮δ(°)  稳态β(°)  峰值β(°)  后轴α(°)  峰值后α(°)  前轴α(°)  后轮κ   前轴Fy(N)  后轴Fy(N)  yawRate  出弯   松手后β(°)',
  );
  for (const kmh of speeds) {
    for (const steer of steers) {
      const d = measureDrift(kmh, holdFrames, steer);
      console.log(
        `${fmt(d.entryKmh, 0).padEnd(7)}${fmt(steer, 2).padEnd(5)}` +
          `${fmt(d.steadySteerDeg, 2).padEnd(10)}${fmt(d.steadyBetaDeg, 2).padEnd(10)}` +
          `${fmt(d.peakBetaDeg, 2).padEnd(10)}${fmt(d.steadyRearAlphaDeg, 2).padEnd(10)}` +
          `${fmt(d.peakRearAlphaDeg, 2).padEnd(12)}${fmt(d.steadyFrontAlphaDeg, 2).padEnd(10)}` +
          `${fmt(d.steadyRearSlipRatio, 3).padEnd(8)}${fmt(d.steadyFrontFy, 0).padEnd(11)}` +
          `${fmt(d.steadyRearFy, 0).padEnd(11)}${fmt(d.steadyYawRate, 3).padEnd(9)}` +
          `${fmt(d.exitKmh, 0).padEnd(7)}${fmt(d.recoverBetaDeg, 2)}`,
      );
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
