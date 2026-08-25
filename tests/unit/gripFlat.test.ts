import { beforeAll, describe, expect, it } from 'vitest';
import { createInputFrame } from '../../src/core/input';
import { FIXED_DT } from '../../src/core/loop';
import type { GroundHit, GroundQuery } from '../../src/game/groundQuery';
import { Physics, initPhysics } from '../../src/game/physics';
import { Vehicle } from '../../src/game/vehicle';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 平地抓地基准。
 *
 * 「峰值侧向抓地 1.3~1.6 g」这条验收线**按平地定**(2026-08 由人类拍板)。
 * 原来它测在起伏赛道上,而赛道的倾斜弯和下坡凹谷会把垂直载荷压到静态车重
 * 的 2~3.4 倍,轮胎照着这个载荷放出来的侧向力自然超过 1.6 g —— 那是真实
 * 的(Daytona 大倾斜弯就是这样),不是 bug。但它同时让这条线随车最后停在
 * 哪个弯而混沌跳变,调参等于拟合噪声。
 *
 * 所以本征能力测在**绝对平面**上:同一个地面查询、同一段输入,没有地形
 * 变量,数值可复现。赛道上的上限另测,见 grip.test.ts。
 * ══════════════════════════════════════════════════════════════════════════
 */

/** 绝对平面。没有起伏、没有墙,只留轮胎和载荷这两个变量。 */
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

/**
 * 直线推到 `targetKmh`,再按 `steer` 过弯 3 秒,返回峰值侧向抓地(m/s²)。
 *
 * 峰值抓地要在**最优转向角**下量,满舵不一定是最优 —— 打过头前轮越过峰值
 * 侧偏角反而掉力。所以调用方扫几档取最大值。
 */
function peakLateralAccelAt(targetKmh: number, steer: number): number {
  const vehicle = new Vehicle(flatGround, new Physics());
  vehicle.reset(0, 0, 0);
  const input = createInputFrame();
  input.throttle = 1;

  let frames = 0;
  while (vehicle.groundSpeed * 3.6 < targetKmh && frames < 60 * 20) {
    vehicle.update(input, FIXED_DT);
    frames++;
  }

  // 定速过弯,不是收油滑行:滑行会一路掉速,量到的是「速度越来越低时的抓地」,
  // 而下压力随 v² 变,读数就没了意义。也不能全油门 —— 那会把后轮推到空转,
  // 纵向力吃掉摩擦圆,量到的变成联合工况。这里用最小的油门把速度稳住。
  let peak = 0;
  input.steer = steer;
  for (let i = 0; i < 60 * 3; i++) {
    input.throttle = vehicle.groundSpeed * 3.6 < targetKmh ? 0.25 : 0;
    vehicle.update(input, FIXED_DT);
    peak = Math.max(peak, vehicle.lateralGripAccel);
  }
  return peak;
}

beforeAll(async () => {
  await initPhysics();
});

/** 扫转向角取峰值。 */
function peakLateralAccel(targetKmh: number): number {
  let peak = 0;
  for (const steer of [0.45, 0.6, 0.8, 1]) {
    peak = Math.max(peak, peakLateralAccelAt(targetKmh, steer));
  }
  return peak;
}

describe('平地基准:轮胎本征抓地', () => {
  it('100 km/h 的峰值侧向抓地落在 1.3~1.6 g', () => {
    // 验收速度定在 100 km/h:这是赛道上过弯的常用区间,也是「1.3~1.6 g」这条
    // 人类验收线该被兑现的地方。
    const peak = peakLateralAccel(100);
    expect(peak).toBeGreaterThan(1.3 * 9.81);
    expect(peak).toBeLessThan(1.6 * 9.81);
  });

  it('80 km/h 抓地略低于 100 km/h,但不塌 —— 下压力随 v² 变', () => {
    // 有下压力的车,侧向抓地**不可能**与速度无关:80 km/h 的下压力比 100 km/h
    // 少 36%,载荷少了抓地就该少。原来这条要求两个速度落进同一个区间,那个
    // 前提本身不成立。这里改成量它该有的样子:比高速略低,但不能塌下去。
    const slow = peakLateralAccel(80);
    const fast = peakLateralAccel(100);
    expect(slow).toBeLessThan(fast);
    expect(slow).toBeGreaterThan(1.2 * 9.81);
    expect(slow).toBeLessThan(1.6 * 9.81);
  });
});

/**
 * 甩尾必须成立,而且要收得回来。
 *
 * 人类连着三轮反馈「甩尾不明显」,而每一轮把它调回来都被「直线打转」顶回去。
 * 这一组把结论钉住,免得后面谁再顺手把它压没了 —— 上一轮就是为了压打转加的
 * 后轴钳位,顺带把油门甩尾一起掐死,而当时没有任何一条测试会因此变红。
 *
 * 跑在**绝对平地**上:甩尾幅度是轮胎本征能力,赛道的倾斜弯和坡会让它随车停在
 * 哪个弯混沌跳变(见 HANDOFF 第五节)。直线打转那一侧必须反过来跑在真赛道上,
 * 守卫在 grip.test.ts。
 */
describe('平地基准:油门甩尾', () => {
  /** 车头方向与速度方向的夹角(度)。 */
  function betaDegrees(vehicle: Vehicle): number {
    const speed = Math.hypot(vehicle.velocity.x, vehicle.velocity.z);
    if (speed < 1) {
      return 0;
    }
    return Math.abs(Math.atan2(vehicle.lateralSpeed, speed)) * (180 / Math.PI);
  }

  /** 加速到 `entryKmh`,再满油门满舵 3 秒,返回稳态(最后 1 秒)与松手后的侧滑角。 */
  function driftAt(entryKmh: number): { steady: number; recovered: number } {
    const vehicle = new Vehicle(flatGround, new Physics());
    vehicle.reset(0, 0, 0);
    const input = createInputFrame();
    input.throttle = 1;
    let frames = 0;
    while (vehicle.groundSpeed * 3.6 < entryKmh && frames < 60 * 40) {
      vehicle.update(input, FIXED_DT);
      frames++;
    }

    input.steer = 1;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < 180; i++) {
      vehicle.update(input, FIXED_DT);
      if (i >= 120) {
        sum += betaDegrees(vehicle);
        count++;
      }
    }

    input.throttle = 0;
    input.steer = 0;
    for (let i = 0; i < 90; i++) {
      vehicle.update(input, FIXED_DT);
    }
    return { steady: sum / Math.max(1, count), recovered: betaDegrees(vehicle) };
  }

  it('满油门满舵能持续甩尾 —— 稳态侧滑角不是入弯瞬态', () => {
    /*
     * 下界 6° 卡的是「持续」这件事:改动之前 90 km/h 的稳态侧滑角只有 2.0°
     * (入弯瞬间能到 4~7°,之后就回去了),人类三轮反馈的正是这个。现在实测
     * 60 km/h 是 9.3°、90 km/h 是 11.7°。
     *
     * 上界 30° 是**发散守卫**,不是手感线:超过这个数就不是甩尾而是打转了,
     * 实测 `TIRE.overdriveSlipMax` 调到 7.0 时 60 km/h 会到 32.6°、且松手收不
     * 干净。手感线由人类试玩定,别拿这两个数当调参目标。
     */
    for (const kmh of [60, 90]) {
      const { steady } = driftAt(kmh);
      expect(steady).toBeGreaterThan(6);
      expect(steady).toBeLessThan(30);
    }
  });

  it('松开油门与方向之后甩尾收得回来', () => {
    // 「甩得出去还收得回来」是人类的原话。1.5 秒零输入之后应该基本回正。
    for (const kmh of [60, 90]) {
      const { recovered } = driftAt(kmh);
      expect(recovered).toBeLessThan(2);
    }
  });
});
