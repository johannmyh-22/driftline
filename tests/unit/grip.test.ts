import { beforeAll, describe, expect, it } from 'vitest';
import { createInputFrame } from '../../src/core/input';
import { FIXED_DT } from '../../src/core/loop';
import { Rng } from '../../src/core/rng';
import { Autopilot } from '../../src/game/autopilot';
import { Course } from '../../src/game/course';
import { Heightfield } from '../../src/game/heightfield';
import { setTelemetryEnabled, readTelemetry } from '../../src/game/diagnostics';
import { generateTrack } from '../../src/game/trackLayout';
import { CAR, TIRE } from '../../src/game/tuning';
import { Physics, initPhysics } from '../../src/game/physics';
import { Vehicle } from '../../src/game/vehicle';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 四轮真车的抓地 / 摩擦圆规格书。
 *
 * 原文件是悬浮时代的规格书,`describe.skip` 只是藏起过期的断言。这里按
 * `docs/HANDOFF.md` 第十三节的目标数值重写,核心几件事:
 *
 *   1. **摩擦圆必须封得住** —— 任意操纵下,任意一条胎的合力 |F| 都不得超
 *      过该轮的摩擦预算 μ·Fz(悬浮版在这里栽过:合力峰值 1.384·μFz)。
 *   2. **过弯要有速度代价** —— 全油门不减速冲弯,抓地预算被顶穿,车滑向
 *      墙;这是写实而不是街机。
 *   3. **峰值侧向抓地 1.3~1.6 g**(悬浮版是 3.80 g,别照抄)。
 *   4. **车辆不能一打方向就打转** —— 见 docs/tasks/spin-diagnosis.md,当前
 *      已知有 bug。凡反映正确目标、但现在会红的用例,标 `it.fails(...)`
 *      ,不许为了绿把目标数值改成迁就 bug 的数字。
 *
 * 引擎确定性与轮胎模型分别由 physics.test.ts / tire.test.ts 守着。
 * ══════════════════════════════════════════════════════════════════════════
 */


function makeCourse(seed: number): { course: Course; vehicle: Vehicle; pilot: Autopilot } {
  const rng = new Rng(seed);
  const layout = generateTrack(rng.fork());
  const course = new Course(layout, rng.fork());
  const vehicle = new Vehicle(course, new Physics());
  const start = layout.samples[0];
  if (start === undefined) {
    throw new Error('赛道没有采样点');
  }
  vehicle.reset(start.x, start.z, Math.atan2(start.tangentX, start.tangentZ));
  return { course, vehicle, pilot: new Autopilot(layout) };
}

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

// wasm 要先加载完才能造物理世界。
beforeAll(async () => {
  await initPhysics();
});

describe('四轮:摩擦圆必须封得住', () => {
  it('任意操纵下,每条胎合力都不超过摩擦预算(μ·Fz)', () => {
    setTelemetryEnabled(true);
    const v = new Vehicle(new Heightfield(new Rng(7)), new Physics());
    const frame = createInputFrame();
    const rng = new Rng(99);

    // 扫一轮随机但确定的操纵:油门/方向/空气刹/倒车乱切,看有没有哪条胎
    // 超出预算。这正是把轮胎模型接进刚体之后最容易出现的回归。
    for (let i = 0; i < 60 * 6; i++) {
      if (i % 16 === 0) {
        frame.throttle = rng.next();
        frame.reverse = rng.next() > 0.85 ? 1 : 0;
        frame.steer = rng.range(-1, 1);
        frame.airBrake = rng.next() > 0.6 ? 1 : 0;
      }
      v.update(frame, FIXED_DT);
      const tel = readTelemetry();
      for (let w = 0; w < tel.wheels.length; w++) {
        const wheel = tel.wheels[w];
        if (wheel === undefined || !wheel.grounded || wheel.load <= 0) {
          continue;
        }
        const force = Math.hypot(wheel.fx, wheel.fy);
        // 预算 = μ(load)·load。μ 随载荷下降(loadSensitivity),但在 load→0
        // 时达到摩擦 → friction·mu0·(1+loadSensitivity)。真实路面抓地再差也只
        // 会使 μ 更低,所以这个上界对所有接地胎都成立 —— 拿它当摩擦圆的天花板:
        // 任何一条胎合力都不许超过「它在这种载荷下理论能给出的最大 μ·Fz」。
        const muCeiling = TIRE.mu0 * (1 + TIRE.loadSensitivity);
        const allowance = wheel.load * muCeiling * 1.02;
        expect(
          force,
          `seed7 第 ${i} 帧 轮w${w} 合力 ${force.toFixed(0)}N 超预算 ${allowance.toFixed(0)}N`,
        ).toBeLessThanOrEqual(allowance);
      }
    }
  });
});

describe('四轮:打转 / 过弯代价', () => {
  it('全油门不减速冲弯会滑向墙 —— 过弯必须付出速度代价', () => {
    // 「过弯要有速度代价,不做怎么开都能拽回去的街机手感」。
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

  it('赛道上的峰值侧向抓地不超过地形加成的合理上限,且不应原地打转', () => {
    // 「峰值侧向抓地 1.3~1.6 g」这条**本征能力**的验收线已经挪到平地上测,
    // 见 gripFlat.test.ts(2026-08 由人类拍板)。原因:赛道的倾斜弯与下坡
    // 凹谷会把垂直载荷压到静态车重的 2~3.4 倍,轮胎照这个载荷放出来的侧向
    // 力本来就会超过 1.6 g —— 真车在 Daytona 大倾斜弯里也是这样。而且车最
    // 后停在哪个弯随轨迹混沌跳变,拿它当验收线等于拟合噪声。
    //
    // 这里留下的是**上限**:地形可以加成,但不能加成到离谱,否则说明载荷
    // 敏感性没起作用、或者法向力算炸了。
    // 测法:先在直道上推起速度,再满舵过弯一段时间,盯峰值侧向抓地。
    const { vehicle, pilot } = makeCourse(1);
    const input = createInputFrame();
    for (let i = 0; i < 60 * 25; i++) {
      pilot.drive(vehicle, input);
      vehicle.update(input, FIXED_DT);
    }

    let peak = 0;
    let peakYawRate = 0;
    for (let i = 0; i < 60 * 2; i++) {
      input.throttle = 1;
      input.steer = 1;
      input.airBrake = 0;
      vehicle.update(input, FIXED_DT);
      peak = Math.max(peak, vehicle.lateralGripAccel);
      peakYawRate = Math.max(peakYawRate, Math.abs(vehicle.yawRate));
    }

    // 下界仍按本征能力 1.3 g:地形只会加载荷,不该让抓地比平地还差。
    // 上界 2.5 g 是地形加成的天花板 —— 实测最狠的倾斜弯在 1.9~2.2 g。
    expect(peak).toBeGreaterThan(1.3 * 9.81);
    expect(peak).toBeLessThan(2.5 * 9.81);
    expect(Math.abs(peakYawRate)).toBeLessThan(2.0);
  });

  it('侧滑之后车头会被拉回行进方向(有回正力矩)', () => {
    // 真车靠后轮侧向力自回正;spin bug 正是因为没有后轮侧向抓地而回不来。
    const { vehicle, pilot } = makeCourse(3);
    const input = createInputFrame();
    for (let i = 0; i < 60 * 20; i++) {
      pilot.drive(vehicle, input);
      vehicle.update(input, FIXED_DT);
    }
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
});

describe('四轮:护栏与出界', () => {
  it('护栏会挡住车 —— 车体中心停在墙内侧一个半宽的位置', () => {
    const { course, vehicle, pilot } = makeCourse(4);
    const input = createInputFrame();
    let maxLateral = 0;
    for (let i = 0; i < 60 * 60; i++) {
      pilot.drive(vehicle, input);
      input.steer = 1;
      input.throttle = 1;
      vehicle.update(input, FIXED_DT);
      if (Number.isFinite(vehicle.lateral)) {
        maxLateral = Math.max(maxLateral, Math.abs(vehicle.lateral));
      }
    }
    expect(maxLateral).toBeLessThanOrEqual(course.outerHalfWidth - CAR.halfWidth + 0.01);
  });
});
