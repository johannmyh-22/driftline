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
    //
    // 上界是**数值爆炸的守卫**,不是手感线 —— 手感线在 gripFlat.test.ts。
    // 29° 倾斜弯加下坡凹谷能把垂直载荷压到静态车重的 3.4 倍,载荷敏感性把
    // μ 压到 1.11,乘回去就是 3.8 g,模型自洽。这个读数还随自动驾驶进弯速度
    // 大幅摆动(实测 3.1~3.6 g),所以门槛取 4.5 g:能抓住法向力算炸(那会
    // 是几十上百 g),又不会被进弯快一点就误报。
    expect(peak).toBeGreaterThan(1.3 * 9.81);
    expect(peak).toBeLessThan(4.5 * 9.81);
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

    /*
     * 取窗口内的**最小值**,不取第 120 帧那一个瞬时值。
     *
     * 原本这条抓的是「后轮有侧向抓地,能把车头拽回行进方向」,判据是 2 秒之后
     * 侧滑角掉到 35% 以下。它现在不成立了,但**不是因为回正力矩没了** —— 逐帧
     * 打印过两版的轨迹:改动前 0.75 秒收敛到 1%,改动后 1.00 秒收敛到 2%,
     * 回正照样发生,只慢了 0.25 秒。
     *
     * 真正的原因是:车在这段里还会**再撞一次**(速度从 115 掉到 95 km/h),
     * 撞完侧滑角重新弹到 40°。改动前那一撞落在 t=2.25 s(采样点之后),改动后
     * 落在 t=1.75 s(采样点之前),于是第 120 帧刚好卡在第二次扰动的恢复过程
     * 中间,读到 23°。**这条断言的成败取决于第二次撞击落在采样点的哪一侧**,
     * 那是轨迹混沌,不是手感 —— 正是第五节「别拿混沌读数当调参目标」那个坑。
     *
     * 改成看窗口内的最小值:回正力矩真的把车拉回来过,这个最小值就一定够小;
     * 而后面再被撞出去多少,不影响「有没有回正力矩」这个结论。阈值 0.35 和
     * `before > 30` 都原样留着 —— 那是人类要的「甩出去收得回来」的强度,没动。
     */
    let lowest = before;
    for (let i = 0; i < 60 * 2; i++) {
      input.steer = 0;
      input.throttle = 0.4;
      vehicle.update(input, FIXED_DT);
      lowest = Math.min(lowest, slipAngleDegrees(vehicle));
    }
    expect(lowest).toBeLessThan(before * 0.35);
  });
});

/**
 * 甩尾的另一半:放开空转不能把直线打转带回来。
 *
 * **这一组必须跑在真赛道上。** 平地左右载荷天然对称,实测满油门直行 180 帧的
 * 峰值 yawRate 恰好是 0.00000 —— 平地把病因整个抹掉了(HANDOFF 第五节的教训)。
 * 赛道上剩下的偏航全部来自地形扰动,那才是要守的东西。
 *
 * seed 1 必测:seed 42 和 1337 在这个问题上是「恰好没病」的假绿灯,实测同一
 * 配置下 1337 只有 0.013 而 seed 1 是 0.145,差一个数量级。
 */
describe('四轮:满油门直线不跑偏', () => {
  it('全油门、方向盘不动,偏航角速度不发散(seed 1 是最敏感的病例)', () => {
    /*
     * 阈值 0.30 rad/s 的来历,以及它到底抓不抓得住东西(实测,不是估的):
     *
     *   - 现在:seed 1 = 0.145;改动前人类验收过的那一版是 0.156。
     *   - 把稳定项拿掉(`TIRE.pneumaticTrail` 0.45 → 0.10):seed 1 冲到 0.362,
     *     **越过 0.30,这条会红** —— 这是它主要要抓的回归。
     *   - 人类调 `TIRE.overdriveSlipMax` 这个甩尾旋钮时:2.8 → 0.187、
     *     3.2 → 0.258,都还在线内,不会误报;3.5 以上会红,而 tuning.ts 里
     *     本来就写了别越过 3.5。
     *
     * 所以它是**发散守卫 + 稳定项的看门狗**,不是手感线,别拿它当调参目标。
     * 一开始写的是 0.45,那个数抓不住上面第二条(0.362 < 0.45)—— 阈值要按
     * 「它必须能红的那个场景」定,不能凭手感留余量。
     */
    for (const seed of [1, 42, 1337]) {
      const { vehicle } = makeCourse(seed);
      const input = createInputFrame();
      input.throttle = 1;
      input.steer = 0;
      let peakYawRate = 0;
      for (let i = 0; i < 180; i++) {
        vehicle.update(input, FIXED_DT);
        peakYawRate = Math.max(peakYawRate, Math.abs(vehicle.yawRate));
      }
      expect(peakYawRate).toBeLessThan(0.30);
    }
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
