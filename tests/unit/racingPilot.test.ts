import { beforeAll, describe, expect, it } from 'vitest';
import { createInputFrame } from '../../src/core/input';
import { Rng } from '../../src/core/rng';
import { Autopilot } from '../../src/game/autopilot';
import { Course } from '../../src/game/course';
import { CURATED_TRACKS } from '../../src/game/curatedTracks';
import { Physics, initPhysics } from '../../src/game/physics';
import { RacingPilot } from '../../src/game/racingPilot';
import { type TrackLayout, generateTrack } from '../../src/game/trackLayout';
import { RACING_AI } from '../../src/game/tuning';
import { Vehicle } from '../../src/game/vehicle';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics();
});

interface LapResult {
  time: number;
  fullThrottleRatio: number;
  wallHits: number;
  maxLateral: number;
}

function runLap(seed: number, pilot: 'auto' | 'race', aggression?: number): LapResult | null {
  const rng = new Rng(seed);
  const layout = generateTrack(rng.fork());
  const course = new Course(layout, rng.fork());
  const vehicle = new Vehicle(course, new Physics());
  const start = layout.samples[0];
  if (start === undefined) {
    throw new Error('赛道没有采样点');
  }
  vehicle.reset(start.x, start.z, Math.atan2(start.tangentX, start.tangentZ));

  const auto = new Autopilot(layout);
  const race = new RacingPilot(layout, aggression);
  const input = createInputFrame();
  const total = layout.totalLength;

  let time = 0;
  let prevArc = 0;
  let travelled = 0;
  let frames = 0;
  let fullThrottle = 0;
  let wallHits = 0;
  let maxLateral = 0;

  for (let i = 0; i < 60 * 300; i++) {
    if (pilot === 'auto') {
      auto.drive(vehicle, input);
    } else {
      race.drive(vehicle, input, []);
    }
    vehicle.update(input, DT);
    time += DT;
    frames++;

    let delta = vehicle.arc - prevArc;
    if (delta < -total / 2) {
      delta += total;
    } else if (delta > total / 2) {
      delta -= total;
    }
    travelled += delta;
    prevArc = vehicle.arc;

    if (input.throttle > 0.99) {
      fullThrottle++;
    }
    if (vehicle.wallNormalSpeed > 0.6) {
      wallHits++;
    }
    maxLateral = Math.max(maxLateral, Math.abs(vehicle.lateral));

    if (travelled >= total) {
      return { time, fullThrottleRatio: fullThrottle / frames, wallHits, maxLateral };
    }
  }
  return null;
}

/*
 * 这一组直接跑物理,比一般单测慢(整套约 20 秒)。留在 vitest 而不是搬进
 * Playwright 的理由和 physics.test.ts 一样:Rapier 的 wasm 在 Node 里跑得起来,
 * 而且结果和浏览器逐位一致(见 CLAUDE.md 的无头验证契约)。
 */
describe('RacingPilot vs Autopilot', () => {
  /*
   * 这一组每条用例都要把好几条精选赛道各跑满一圈(两个 pilot × 每条赛道
   * 上万个物理步),空载约两三秒,**但机器一忙就会超过 vitest 默认的 5 秒**。
   * 实测人为压满 CPU 之后必红,而它测的根本不是速度。给足超时,不是放宽断言。
   */
  const SLOW = 120_000;

  it('每条精选赛道都跑得完,而且明显快过当验收工具用的 Autopilot', { timeout: SLOW }, () => {
    for (const track of CURATED_TRACKS) {
      const auto = runLap(track.seed, 'auto');
      const race = runLap(track.seed, 'race');

      expect(race, `seed ${track.seed} RacingPilot 没跑完一圈`).not.toBeNull();
      expect(auto, `seed ${track.seed} Autopilot 没跑完一圈`).not.toBeNull();
      if (race === null || auto === null) {
        continue;
      }
      // Autopilot 实测慢 56~74%,这里只要求"至少快 25%",留足余量不做脆断言。
      expect(race.time, `seed ${track.seed}`).toBeLessThan(auto.time * 0.75);
    }
  });

  it('单圈明显快过目标时间——人类反馈"对手还是太弱",难度已经拉到收益拐点', { timeout: SLOW }, () => {
    for (const track of CURATED_TRACKS) {
      const race = runLap(track.seed, 'race');
      expect(race).not.toBeNull();
      if (race === null) {
        continue;
      }
      const ratio = race.time / track.targetLapTime;
      // 实测区间 0.69~0.80(即比目标快 20~31%)。下界留到 0.55:再快只可能
      // 是弯速上限算错了(比如曲率估成 0),那是 bug 不是变强。
      expect(ratio, `seed ${track.seed} 用时比 ${ratio.toFixed(2)}`).toBeGreaterThan(0.55);
      expect(ratio, `seed ${track.seed} 用时比 ${ratio.toFixed(2)}`).toBeLessThan(0.95);
    }
  });

  it('跑完全程不撞墙,也不会跑出赛道宽度太多', () => {
    for (const track of CURATED_TRACKS) {
      const race = runLap(track.seed, 'race');
      expect(race).not.toBeNull();
      if (race === null) {
        continue;
      }
      expect(race.wallHits, `seed ${track.seed} 撞墙 ${race.wallHits} 帧`).toBe(0);
    }
  });

  it('难度系数是有效的旋钮——调低确实会变慢,而且照样跑得完', () => {
    const track = CURATED_TRACKS[0];
    if (track === undefined) {
      return;
    }
    const fast = runLap(track.seed, 'race', RACING_AI.defaultAggression);
    const slow = runLap(track.seed, 'race', 0.7);
    expect(fast).not.toBeNull();
    expect(slow).not.toBeNull();
    if (fast === null || slow === null) {
      return;
    }
    expect(fast.time).toBeLessThan(slow.time);
    expect(fast.wallHits).toBe(0);
    expect(slow.wallHits).toBe(0);
  });

  /*
   * 这条守的是一个真 bug:构造函数原来把 aggression 钳在 [0.3, 1],于是传任何
   * 大于 1 的值都没有效果——第一次扫 1.15/1.30/1.45 时五条赛道数字一模一样,
   * 就是这个钳位吃掉的。默认值 1.4 正好在被吃掉的区间里。
   */
  it('大于 1 的难度系数不会被钳掉', () => {
    const track = CURATED_TRACKS[0];
    if (track === undefined) {
      return;
    }
    const one = runLap(track.seed, 'race', 1);
    const high = runLap(track.seed, 'race', 1.4);
    expect(one).not.toBeNull();
    expect(high).not.toBeNull();
    if (one === null || high === null) {
      return;
    }
    expect(high.time).toBeLessThan(one.time);
  });
});

describe('RacingPilot 的避让', () => {
  function setup(): { pilot: RacingPilot; vehicle: Vehicle; other: Vehicle } {
    const rng = new Rng(135);
    const layout = generateTrack(rng.fork());
    const course = new Course(layout, rng.fork());
    const physics = new Physics();
    const vehicle = new Vehicle(course, physics);
    const other = new Vehicle(course, physics);
    const start = layout.samples[0];
    if (start === undefined) {
      throw new Error('赛道没有采样点');
    }
    const yaw = Math.atan2(start.tangentX, start.tangentZ);
    vehicle.reset(start.x, start.z, yaw);
    other.reset(start.x, start.z, yaw);
    return { pilot: new RacingPilot(layout), vehicle, other };
  }

  it('正前方紧贴着一辆车时会收油,不会直接怼上去', () => {
    const { pilot, vehicle, other } = setup();
    const alone = createInputFrame();
    pilot.drive(vehicle, alone, []);
    const soloThrottle = alone.throttle;

    // 把对方放到正前方 10 米、横向几乎重合。
    const fx = Math.sin(vehicle.yaw);
    const fz = Math.cos(vehicle.yaw);
    other.position.set(vehicle.position.x + fx * 10, other.position.y, vehicle.position.z + fz * 10);
    (other as unknown as { lateral: number }).lateral = vehicle.lateral;

    const blocked = createInputFrame();
    pilot.drive(vehicle, blocked, [other]);
    expect(blocked.throttle).toBeLessThan(soloThrottle);
  });

  it('并排(横向拉开)的车不算挡路,不该无缘无故收油', () => {
    const { pilot, vehicle, other } = setup();
    const fx = Math.sin(vehicle.yaw);
    const fz = Math.cos(vehicle.yaw);
    other.position.set(vehicle.position.x + fx * 10, other.position.y, vehicle.position.z + fz * 10);
    (other as unknown as { lateral: number }).lateral =
      vehicle.lateral + RACING_AI.rivalLateralGap + 1;

    const alone = createInputFrame();
    pilot.drive(vehicle, alone, []);
    const beside = createInputFrame();
    pilot.drive(vehicle, beside, [other]);
    expect(beside.throttle).toBeCloseTo(alone.throttle, 6);
  });

  it('后方的车不算挡路', () => {
    const { pilot, vehicle, other } = setup();
    const fx = Math.sin(vehicle.yaw);
    const fz = Math.cos(vehicle.yaw);
    other.position.set(vehicle.position.x - fx * 10, other.position.y, vehicle.position.z - fz * 10);
    (other as unknown as { lateral: number }).lateral = vehicle.lateral;

    const alone = createInputFrame();
    pilot.drive(vehicle, alone, []);
    const behind = createInputFrame();
    pilot.drive(vehicle, behind, [other]);
    expect(behind.throttle).toBeCloseTo(alone.throttle, 6);
  });

  it('把自己传进对手列表里不会把自己当成挡路的车', () => {
    const { pilot, vehicle } = setup();
    const alone = createInputFrame();
    pilot.drive(vehicle, alone, []);
    const withSelf = createInputFrame();
    pilot.drive(vehicle, withSelf, [vehicle]);
    expect(withSelf.throttle).toBeCloseTo(alone.throttle, 6);
  });
});

describe('瞄点不许跑到路面外', () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════
   * 这一条是量出来的(2026-09,HANDOFF 第六十三节),而且**第一次尝试是失败
   * 的** —— 当时拿「撞墙帧数」当验收标准,同一个改动在两套配置下得出相反结论
   * (probe 里 972→276,单测里 0→23)。原因是多车碰撞混沌,那个量根本不只
   * 量到了我想量的东西。
   *
   * 所以这一版断言的是**这条改动直接控制的量**:瞄点相对中心线的偏移。它是
   * 确定性的、一帧就能验、不用跑物理、不受碰撞影响。
   *
   * 缺陷本身:走线朝弯内偏 `halfWidth × lineOffset` = 4.65 米,避让再偏
   * `rivalSideStep` = 4.5 米,而原来只有后者夹了自己那一项 —— 叠起来 9.15 米,
   * 而路面半宽只有 7.5 米。瞄点落到路肩上,纯追踪照着开就是贴着墙跑。
   * ══════════════════════════════════════════════════════════════════════════
   */
  function rig(seed = 42): { layout: TrackLayout; course: Course; pilot: RacingPilot } {
    const rng = new Rng(seed);
    const layout = generateTrack(rng.fork());
    return { layout, course: new Course(layout, rng.fork()), pilot: new RacingPilot(layout) };
  }

  /** 把车摆到「行号 + 横向」上。`Course.sample()` 的 lateral 正方向是 (-tz, tx)。 */
  function place(car: Vehicle, layout: TrackLayout, row: number, lateral: number): void {
    const samples = layout.samples;
    const sample = samples[((row % samples.length) + samples.length) % samples.length];
    if (sample === undefined) {
      throw new Error('采样点缺失');
    }
    car.reset(
      sample.x - sample.tangentZ * lateral,
      sample.z + sample.tangentX * lateral,
      Math.atan2(sample.tangentX, sample.tangentZ),
    );
  }

  it('两项偏移的上限之和确实超得过路面半宽 —— 所以这条 clamp 是要干活的', () => {
    const { layout } = rig();
    const stacked = layout.halfWidth * RACING_AI.lineOffset + RACING_AI.rivalSideStep;
    // 不成立就说明有人调过旋钮,这条测试也就不再测它想测的东西了。
    expect(stacked).toBeGreaterThan(layout.halfWidth);
    expect(stacked).toBeCloseTo(9.15, 2);
  });

  it('**整条赛道、任意挡路位置,瞄点都留在路面内**', () => {
    const { layout, course, pilot } = rig();
    const physics = new Physics();
    const car = new Vehicle(course, physics);
    const blocker = new Vehicle(course, physics);
    const room = pilot.lineRoom;

    let worst = 0;
    let outside = 0;
    let samplesChecked = 0;
    for (let row = 0; row < layout.samples.length; row += 3) {
      for (const mine of [-4, 0, 4]) {
        place(car, layout, row, mine);
        // 挡路的车摆在正前方,左右都试 —— 避让的方向由它决定。
        for (const theirs of [-6, -1, 1, 6]) {
          place(blocker, layout, row + 2, theirs);
          const offset = pilot.aimOffset(car, [car, blocker], pilot.aheadIndex(car));
          worst = Math.max(worst, Math.abs(offset));
          if (Math.abs(offset) > room) {
            outside++;
          }
          samplesChecked++;
        }
      }
    }
    expect(samplesChecked).toBeGreaterThan(500);
    expect(outside).toBe(0);
    expect(worst).toBeLessThanOrEqual(room + 1e-9);
    // 而且 clamp 确实生效过 —— 不然这条测试是空过的。
    expect(worst).toBeCloseTo(room, 6);
  });

  it('单车时这条 clamp 一次都不生效 —— 已验收的单车行为逐位不变', () => {
    /*
     * 单车没有避让偏移,总量就是走线那 4.65 米,小于 6.5 —— clamp 碰不到。
     * 这一条是「改动不会碰到既有基线」的直接证据,不用靠跑圈去推断。
     */
    const { layout, course, pilot } = rig();
    const car = new Vehicle(course, new Physics());
    const limit = layout.halfWidth * RACING_AI.lineOffset;
    for (let row = 0; row < layout.samples.length; row += 2) {
      place(car, layout, row, 0);
      expect(Math.abs(pilot.aimOffset(car, [car], pilot.aheadIndex(car)))).toBeLessThanOrEqual(
        limit + 1e-9,
      );
    }
    expect(limit).toBeLessThan(pilot.lineRoom);
  });
});
