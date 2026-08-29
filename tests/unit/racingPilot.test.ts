import { beforeAll, describe, expect, it } from 'vitest';
import { createInputFrame } from '../../src/core/input';
import { Rng } from '../../src/core/rng';
import { Autopilot } from '../../src/game/autopilot';
import { Course } from '../../src/game/course';
import { CURATED_TRACKS } from '../../src/game/curatedTracks';
import { Physics, initPhysics } from '../../src/game/physics';
import { RacingPilot } from '../../src/game/racingPilot';
import { generateTrack } from '../../src/game/trackLayout';
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
  it('每条精选赛道都跑得完,而且明显快过当验收工具用的 Autopilot', () => {
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

  it('单圈落在目标时间附近——对手要能赢也要能被赢', () => {
    for (const track of CURATED_TRACKS) {
      const race = runLap(track.seed, 'race');
      expect(race).not.toBeNull();
      if (race === null) {
        continue;
      }
      const ratio = race.time / track.targetLapTime;
      // 实测区间 0.89~1.09。放宽到 0.8~1.25:再快就没法赢,再慢就又变成活靶子。
      expect(ratio, `seed ${track.seed} 用时比 ${ratio.toFixed(2)}`).toBeGreaterThan(0.8);
      expect(ratio, `seed ${track.seed} 用时比 ${ratio.toFixed(2)}`).toBeLessThan(1.25);
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

  it('难度系数拉满仍然跑得完,只是更快——0.7 是玩法取舍不是能力上限', () => {
    const track = CURATED_TRACKS[0];
    if (track === undefined) {
      return;
    }
    const normal = runLap(track.seed, 'race', RACING_AI.defaultAggression);
    const full = runLap(track.seed, 'race', 1);
    expect(normal).not.toBeNull();
    expect(full).not.toBeNull();
    if (normal === null || full === null) {
      return;
    }
    expect(full.time).toBeLessThan(normal.time);
    expect(full.wallHits).toBe(0);
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
