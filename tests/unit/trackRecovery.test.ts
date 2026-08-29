import { beforeAll, describe, expect, it } from 'vitest';
import { FIXED_DT } from '../../src/core/loop';
import { Rng } from '../../src/core/rng';
import { Course } from '../../src/game/course';
import { Physics, initPhysics } from '../../src/game/physics';
import { generateTrack } from '../../src/game/trackLayout';
import { TrackRecovery } from '../../src/game/trackRecovery';
import { TRACK } from '../../src/game/tuning';
import { Vehicle } from '../../src/game/vehicle';

beforeAll(async () => {
  await initPhysics();
});

function setup(): { layout: ReturnType<typeof generateTrack>; vehicle: Vehicle; recovery: TrackRecovery } {
  const rng = new Rng(135);
  const layout = generateTrack(rng.fork());
  const course = new Course(layout, rng.fork());
  const vehicle = new Vehicle(course, new Physics());
  const start = layout.samples[0];
  if (start === undefined) {
    throw new Error('赛道没有采样点');
  }
  vehicle.reset(start.x, start.z, Math.atan2(start.tangentX, start.tangentZ));
  return { layout, vehicle, recovery: new TrackRecovery(layout) };
}

/**
 * 把车挪到赛道外足够远的地方。
 *
 * **必须走 `vehicle.reset()`,不能直接改 `vehicle.position`**:位置的权威在
 * Rapier 刚体上,直接写字段下一帧就会被 `readState()` 用刚体的旧变换覆盖掉,
 * 车压根没离开过赛道。
 */
function shoveOffTrack(vehicle: Vehicle, layout: ReturnType<typeof generateTrack>): void {
  const start = layout.samples[0];
  if (start === undefined) {
    throw new Error('赛道没有采样点');
  }
  const far = layout.halfWidth + TRACK.outOfBoundsMargin + 30;
  // 切线的右手法向 = (tangentZ, -tangentX)。
  const x = start.x + start.tangentZ * far;
  const z = start.z - start.tangentX * far;
  vehicle.reset(x, z, Math.atan2(start.tangentX, start.tangentZ));
}

describe('TrackRecovery', () => {
  it('在赛道上时不计时、不回收', () => {
    const { vehicle, recovery } = setup();
    for (let i = 0; i < 60; i++) {
      const did = recovery.update(vehicle, FIXED_DT, 0);
      expect(did).toBe(false);
    }
    expect(recovery.offTrackTime).toBe(0);
    expect(recovery.resets).toBe(0);
  });

  it('出界但还在宽限时间内不回收 —— 飞出去再落回来不该被立刻传送', () => {
    const { layout, vehicle, recovery } = setup();
    shoveOffTrack(vehicle, layout);
    const steps = Math.floor((TRACK.outOfBoundsGrace / FIXED_DT) * 0.5);
    for (let i = 0; i < steps; i++) {
      expect(recovery.update(vehicle, FIXED_DT, 0)).toBe(false);
    }
    expect(recovery.offTrackTime).toBeGreaterThan(0);
    expect(recovery.resets).toBe(0);
  });

  it('出界超过宽限时间就把车放回赛道 —— 这正是对手车之前缺的那一环', () => {
    const { layout, vehicle, recovery } = setup();
    shoveOffTrack(vehicle, layout);

    let recovered = false;
    for (let i = 0; i < 60 * 20 && !recovered; i++) {
      recovered = recovery.update(vehicle, FIXED_DT, vehicle.arc);
    }
    expect(recovered).toBe(true);
    expect(recovery.resets).toBe(1);
    expect(recovery.offTrackTime).toBe(0);
    // 回来之后必须站在赛道上。
    expect(Math.abs(vehicle.lateral)).toBeLessThan(layout.halfWidth);
  });

  it('respawn 放到指定弧长处的中心线上,并且速度清零', () => {
    const { layout, vehicle, recovery } = setup();
    const targetArc = layout.totalLength * 0.4;
    recovery.respawn(vehicle, targetArc);

    const expected = layout.samples[Math.floor(targetArc / layout.spacing) % layout.samples.length];
    expect(expected).toBeDefined();
    if (expected === undefined) {
      return;
    }
    // reset() 会把车贴到地面采样高度上,x/z 允许厘米级偏差。
    expect(vehicle.position.x).toBeCloseTo(expected.x, 1);
    expect(vehicle.position.z).toBeCloseTo(expected.z, 1);
    expect(vehicle.velocity.length()).toBeCloseTo(0, 3);
    expect(recovery.resets).toBe(1);
  });

  it('弧长超过一圈时按环形取模,不会越界取到 undefined', () => {
    const { layout, vehicle, recovery } = setup();
    expect(() => recovery.respawn(vehicle, layout.totalLength * 3.7)).not.toThrow();
    expect(Number.isFinite(vehicle.position.x)).toBe(true);
  });

  it('reset 把计时与计数清零', () => {
    const { layout, vehicle, recovery } = setup();
    shoveOffTrack(vehicle, layout);
    recovery.update(vehicle, FIXED_DT, 0);
    recovery.respawn(vehicle, 0);
    recovery.reset();
    expect(recovery.offTrackTime).toBe(0);
    expect(recovery.resets).toBe(0);
  });
});
