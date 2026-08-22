import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FIXED_DT } from '../../src/core/loop';
import { Rng } from '../../src/core/rng';
import { Heightfield } from '../../src/game/heightfield';
import {
  readTelemetry,
  setTelemetryEnabled,
  telemetryEnabled,
} from '../../src/game/diagnostics';
import { Physics, initPhysics } from '../../src/game/physics';
import { Vehicle } from '../../src/game/vehicle';
import type { InputFrame } from '../../src/core/input';

/*
 * diagnostics.ts 是「原地打转」诊断探针的数据采集层。它只复写模块级缓冲、
 * 不改任何物理逻辑 —— 这里守的是它「开/关采样」和「读走的每帧都单帧有效」。
 */

beforeAll(async () => {
  await initPhysics();
});

afterEach(() => {
  setTelemetryEnabled(false);
});

function input(partial: Partial<InputFrame> = {}): InputFrame {
  return Object.assign({ throttle: 0, reverse: 0, steer: 0, airBrake: 0 }, partial);
}

describe('Diagnostics 遥测开关', () => {
  it('默认关闭,关闭时读会报错而不是给旧数据', () => {
    expect(telemetryEnabled()).toBe(false);
    expect(() => readTelemetry()).toThrow(/未启用/);
  });

  it('开之后 vehicle 每帧都更新遥测,且四个轮子的下标齐全', () => {
    setTelemetryEnabled(true);
    const vehicle = new Vehicle(new Heightfield(new Rng(1)), new Physics());
    vehicle.update(input({ throttle: 1 }), FIXED_DT);

    const telemetry = readTelemetry();
    expect(telemetry.wheels).toHaveLength(4);
    // 起步至少一个后轮接地且带着载荷。
    const rearGrounded = telemetry.wheels[2]?.grounded ?? telemetry.wheels[3]?.grounded;
    const rearLoad = Math.max(
      telemetry.wheels[2]?.load ?? 0,
      telemetry.wheels[3]?.load ?? 0,
    );
    expect(rearGrounded).toBe(true);
    expect(rearLoad).toBeGreaterThan(0);
    // 施力点(接触点)落在轮子所在的那一侧:后轮接触点在质心后方(+Z 是车头?
    // 不是 —— 车身 +Z 是车头,后轮在 -Z 侧,所以接触点 z 应小于质心 z)。
    const rearContactZ = Math.max(
      telemetry.wheels[2]?.pz ?? 0,
      telemetry.wheels[3]?.pz ?? 0,
    );
    expect(rearContactZ).toBeLessThan(telemetry.z);
  });

  it('关掉之后采样停止,缓冲不再被改动', () => {
    setTelemetryEnabled(true);
    const vehicle = new Vehicle(new Heightfield(new Rng(2)), new Physics());
    vehicle.update(input({ throttle: 1 }), FIXED_DT);
    const active = readTelemetry();

    setTelemetryEnabled(false);
    vehicle.update(input({ throttle: 1 }), FIXED_DT);
    setTelemetryEnabled(true);

    // 关闭期间的那一帧不该写进缓冲 —— 重新读到的是开启时那一帧的旧值。
    const after = readTelemetry();
    expect(after.vx).toBe(active.vx);
  });
});
