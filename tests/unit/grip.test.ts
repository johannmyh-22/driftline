import { describe, expect, it } from 'vitest';
import { type InputFrame, createInputFrame } from '../../src/core/input';
import { FIXED_DT } from '../../src/core/loop';
import { Rng } from '../../src/core/rng';
import { Autopilot } from '../../src/game/autopilot';
import { Course } from '../../src/game/course';
import { Heightfield } from '../../src/game/heightfield';
import { createGroundHit } from '../../src/game/groundQuery';
import { generateTrack } from '../../src/game/trackLayout';
import { VEHICLE } from '../../src/game/tuning';
import { Vehicle } from '../../src/game/vehicle';

function makeCourse(seed: number): { course: Course; vehicle: Vehicle; pilot: Autopilot } {
  const rng = new Rng(seed);
  const layout = generateTrack(rng.fork());
  const course = new Course(layout, rng.fork());
  const vehicle = new Vehicle(course);
  const start = layout.samples[0];
  if (start === undefined) {
    throw new Error('赛道没有采样点');
  }
  vehicle.reset(start.x, start.z, Math.atan2(start.tangentX, start.tangentZ));
  return { course, vehicle, pilot: new Autopilot(layout) };
}

/**
 * 抓地力施加的峰值侧向加速度。
 *
 * 读 `lateralGripAccel` 而不是拿速度差反推:车头转动会让机体坐标系下的侧向
 * 速度以 ω·v 变化,拿速度差算会把这份坐标系旋转的记账也算成地面给的力,
 * 在 0.9 rad/s、80 m/s 下能虚高七十多 m/s²。
 */
function peakGripAccel(
  vehicle: Vehicle,
  drive: (input: InputFrame) => void,
  seconds: number,
): number {
  const input = createInputFrame();
  let peak = 0;
  for (let i = 0; i < seconds * 60; i++) {
    drive(input);
    vehicle.update(input, FIXED_DT);
    peak = Math.max(peak, vehicle.lateralGripAccel);
  }
  return peak;
}

/**
 * 「300 km/h 过弯居然不用减速」的回归守卫。
 *
 * 根因不是数值偏软,是抓地模型缺了力的上限:指数衰减的等效侧向加速度正比于
 * 侧滑速度且无封顶,实测能拉到 7 g,物理上不存在「过弯极限」。
 */
describe('侧向抓地力上限', () => {
  it('抓地力施加的侧向加速度有硬上限', () => {
    const { vehicle, pilot } = makeCourse(1);
    const peak = peakGripAccel(vehicle, (input) => {
      pilot.drive(vehicle, input);
      input.throttle = 1;
      input.airBrake = 0;
    }, 60);

    // 上限之上唯一的加成来自侧倾(重力分量)与空气刹,两者都是有界的。
    // maxBank 是 0.5 rad,tan(0.5) ≈ 0.546。
    const ceiling =
      VEHICLE.lateralGripLimit + VEHICLE.gravity * 0.55 + VEHICLE.airBrakeGripBonus;
    expect(peak).toBeLessThanOrEqual(ceiling);
    // 也不能软到过不了弯。
    expect(peak).toBeGreaterThan(VEHICLE.lateralGripLimit * 0.6);
  });

  it('全油门不减速冲弯会滑到墙上 —— 过弯必须付出速度代价', () => {
    const { vehicle, pilot } = makeCourse(1);
    const input = createInputFrame();

    let sawSaturation = false;
    let hitWall = false;
    for (let i = 0; i < 60 * 90; i++) {
      pilot.drive(vehicle, input);
      input.throttle = 1;
      input.airBrake = 0;
      vehicle.update(input, FIXED_DT);
      if (vehicle.gripSaturation >= 1) {
        sawSaturation = true;
      }
      if (vehicle.wallImpact > 0) {
        hitWall = true;
      }
    }

    expect(sawSaturation).toBe(true);
    expect(hitWall).toBe(true);
  });

  it('正常收油驾驶时抓地力极少触顶 —— 上限只惩罚不减速的开法', () => {
    const { vehicle, pilot } = makeCourse(2);
    const input = createInputFrame();

    let saturated = 0;
    const frames = 60 * 60;
    for (let i = 0; i < frames; i++) {
      pilot.drive(vehicle, input);
      vehicle.update(input, FIXED_DT);
      if (vehicle.gripSaturation >= 1) {
        saturated++;
      }
    }
    // 偶尔蹭到上限没问题,但绝大多数时间应该在上限以内。
    expect(saturated / frames).toBeLessThan(0.1);
  });

  it('空中几乎没有侧向抓地力', () => {
    const { vehicle, pilot } = makeCourse(3);
    const input = createInputFrame();
    for (let i = 0; i < 60 * 10; i++) {
      pilot.drive(vehicle, input);
      vehicle.update(input, FIXED_DT);
    }

    vehicle.position.y += 40;
    vehicle.update(input, FIXED_DT);
    const before = vehicle.lateralSpeed;
    vehicle.velocity.addScaledVector(
      { x: -Math.cos(vehicle.yaw), y: 0, z: Math.sin(vehicle.yaw) } as never,
      20,
    );
    for (let i = 0; i < 30; i++) {
      vehicle.update(input, FIXED_DT);
    }
    // 空中侧滑几乎不衰减,20 m/s 的横移半秒后还剩绝大部分。
    expect(Math.abs(vehicle.lateralSpeed - before)).toBeGreaterThan(12);
  });
});

/** 车头方向与速度方向的夹角(度)。>90 就是在倒着走。 */
function slipAngleDegrees(vehicle: Vehicle): number {
  const speed = Math.hypot(vehicle.velocity.x, vehicle.velocity.z);
  if (speed < 1) {
    return 0;
  }
  const headingX = Math.sin(vehicle.yaw);
  const headingZ = Math.cos(vehicle.yaw);
  const cos = (vehicle.velocity.x * headingX + vehicle.velocity.z * headingZ) / speed;
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/**
 * 「车太轻、很飘」的回归守卫。
 *
 * 给抓地力加上限时漏了转向:偏航角速度仍由输入直接指令,和地面能不能真的把
 * 车头拽过去无关。车头瞬间甩过去、速度矢量还朝原方向,175 km/h 满舵两秒就能
 * 转成倒着走(侧滑角 171°),速度从 212 崩到 57。
 */
describe('车辆不会一打方向就打转', () => {
  it('全速满舵是甩尾,不是打转', () => {
    const { vehicle, pilot } = makeCourse(1);
    const input = createInputFrame();
    for (let i = 0; i < 60 * 25; i++) {
      pilot.drive(vehicle, input);
      vehicle.update(input, FIXED_DT);
    }
    expect(vehicle.groundSpeed * 3.6).toBeGreaterThan(120);

    let peakSlip = 0;
    for (let i = 0; i < 60 * 2; i++) {
      input.throttle = 1;
      input.steer = 1;
      input.airBrake = 0;
      input.reverse = 0;
      vehicle.update(input, FIXED_DT);
      peakSlip = Math.max(peakSlip, slipAngleDegrees(vehicle));
    }

    // 改之前是 171°(转成倒着走)。90° 以上就是横着或倒着,不能接受。
    expect(peakSlip).toBeLessThan(80);
  });

  it('偏航角速度受可用侧向力限制,速度越高转得越慢', () => {
    const { vehicle, pilot } = makeCourse(2);
    const input = createInputFrame();

    for (let i = 0; i < 60 * 25; i++) {
      pilot.drive(vehicle, input);
      vehicle.update(input, FIXED_DT);
    }
    const speed = vehicle.groundSpeed;

    let peakYawRate = 0;
    for (let i = 0; i < 60; i++) {
      input.throttle = 1;
      input.steer = 1;
      vehicle.update(input, FIXED_DT);
      peakYawRate = Math.max(peakYawRate, Math.abs(vehicle.yawRate));
    }

    // 稳态过弯 ω = a_lat / v,再留一点主动甩尾的余地。
    const sustainable = (VEHICLE.lateralGripLimit * VEHICLE.yawSlideAllowance) / speed;
    expect(peakYawRate).toBeLessThan(sustainable * 1.5);
    // 低速档位的上限在高速下不该起作用。
    expect(peakYawRate).toBeLessThan(VEHICLE.yawRateMax);
  });

  it('侧滑之后车头会被拉回行进方向', () => {
    const { vehicle, pilot } = makeCourse(3);
    const input = createInputFrame();
    for (let i = 0; i < 60 * 20; i++) {
      pilot.drive(vehicle, input);
      vehicle.update(input, FIXED_DT);
    }

    // 硬把车头拧过去 40°,然后松手直行。
    vehicle.yaw += 0.7;
    const before = slipAngleDegrees(vehicle);
    expect(before).toBeGreaterThan(30);

    for (let i = 0; i < 60 * 2; i++) {
      input.steer = 0;
      input.throttle = 0.4;
      vehicle.update(input, FIXED_DT);
    }
    expect(slipAngleDegrees(vehicle)).toBeLessThan(before * 0.35);
  });

  it('空中没有回正力 —— 没有接触面就没有力矩', () => {
    const { vehicle, pilot } = makeCourse(4);
    const input = createInputFrame();
    for (let i = 0; i < 60 * 20; i++) {
      pilot.drive(vehicle, input);
      vehicle.update(input, FIXED_DT);
    }

    vehicle.position.y += 60;
    vehicle.yaw += 0.7;
    const before = slipAngleDegrees(vehicle);

    for (let i = 0; i < 30; i++) {
      input.steer = 0;
      input.throttle = 0;
      vehicle.update(input, FIXED_DT);
      expect(vehicle.grounded).toBe(false);
    }
    // 空中侧滑角基本不变。
    expect(Math.abs(slipAngleDegrees(vehicle) - before)).toBeLessThan(5);
  });
});

describe('护栏碰撞', () => {
  it('车出不去护栏', () => {
    const { course, vehicle, pilot } = makeCourse(4);
    const input = createInputFrame();

    let maxLateral = 0;
    for (let i = 0; i < 60 * 60; i++) {
      pilot.drive(vehicle, input);
      // 一直往一边打死,硬往墙上怼。
      input.steer = 1;
      input.throttle = 1;
      vehicle.update(input, FIXED_DT);
      if (Number.isFinite(vehicle.lateral)) {
        maxLateral = Math.max(maxLateral, Math.abs(vehicle.lateral));
      }
    }

    // 车体中心停在墙内侧一个半宽的位置,车身才不会穿进护栏。
    expect(maxLateral).toBeLessThanOrEqual(course.outerHalfWidth - VEHICLE.halfWidth + 0.01);
  });

  it('正面撞墙比擦墙掉速多 —— 否则贴着墙磨会变成最快跑法', () => {
    /*
     * 只统计**撞击帧上**的速度损失。整段计时会被油门的加速抵消掉:
     * 车不再打转之后一路在加速,四秒下来两种撞法的净速度都是涨的,
     * 比「前后速度差」得不出任何结论。
     */
    const lossOnImpact = (steer: number): number => {
      const { vehicle, pilot } = makeCourse(5);
      const input = createInputFrame();
      for (let i = 0; i < 60 * 12; i++) {
        pilot.drive(vehicle, input);
        vehicle.update(input, FIXED_DT);
      }

      let loss = 0;
      for (let i = 0; i < 60 * 4; i++) {
        input.steer = steer;
        input.throttle = 1;
        input.airBrake = 0;
        const before = vehicle.groundSpeed;
        vehicle.update(input, FIXED_DT);
        if (vehicle.wallImpact > 0) {
          loss += Math.max(0, before - vehicle.groundSpeed);
        }
      }
      return loss;
    };

    // 打死方向 = 大角度撞;小角度 = 缓缓贴上去。
    expect(lossOnImpact(1)).toBeGreaterThan(lossOnImpact(0.18));
  });

  it('平地场景没有墙,车爱开多远开多远', () => {
    const rng = new Rng(9);
    const field = new Heightfield(rng.fork());
    const hit = createGroundHit();
    field.sample(12, -30, hit);
    expect(hit.wallDistance).toBe(Number.POSITIVE_INFINITY);

    const vehicle = new Vehicle(field);
    const input = createInputFrame();
    input.throttle = 1;
    for (let i = 0; i < 60 * 8; i++) {
      vehicle.update(input, FIXED_DT);
    }
    expect(vehicle.wallImpact).toBe(0);
    expect(vehicle.position.length()).toBeGreaterThan(100);
  });
});
