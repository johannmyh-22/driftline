import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type InputFrame, InputRecorder, RecordedInput, createInputFrame } from '../../src/core/input';
import { FIXED_DT } from '../../src/core/loop';
import { Rng } from '../../src/core/rng';
import { Heightfield } from '../../src/game/heightfield';
import { setTelemetryEnabled, readTelemetry } from '../../src/game/diagnostics';
import { CAR } from '../../src/game/tuning';
import { Physics, initPhysics } from '../../src/game/physics';
import { Vehicle } from '../../src/game/vehicle';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 四轮真车(Rapier + 四轮 raycast + 轮胎模型)的手感规格书。
 *
 * 原文件是悬浮载具时代的规格书(0-100 用 2.3s、峰值侧向 3.80g),被测对象
 * 已经不存在,`describe.skip` 只是把过期断言藏起来让 CI 不红 —— 那不是
 * 终态。这里的版本按 `docs/HANDOFF.md` 第十三节的目标数值重写:
 *
 *   | 项目        | 目标(HANDOFF)                  |
 *   |-------------|-------------------------------|
 *   | 0 → 100 km/h| 四秒出头                      |
 *   | 峰值侧向抓地| 1.3 ~ 1.6 g(别抄悬浮版的 3.80) |
 *
 * 断言一律留合理容差、断言可观测的物理行为(车跑到了哪儿、转成什么样),
 * 绝不锁死贴当前实现的值。当前物理有已知缺陷(「一给油就原地打转」,见
 * docs/tasks/spin-diagnosis.md),所以反映正确目标、但现在会红的用例统一标
 * `it.fails('等 spin bug 修复后启用')` —— 不许为了绿把目标数值改成迁就 bug
 * 的数字。
 *
 * 物理本身有测试守着:引擎确定性与状态基准在 physics.test.ts,轮胎模型在
 * tire.test.ts(19 条)。
 * ══════════════════════════════════════════════════════════════════════════
 */

const field = new Heightfield(new Rng(42));

// wasm 要先加载完才能造物理世界。
beforeAll(async () => {
  await initPhysics();
});

afterEach(() => {
  setTelemetryEnabled(false);
});

function makeVehicle(): Vehicle {
  // 每辆车一个独立的物理世界:Vehicle.update() 自己驱动 step(),
  // 共用一个世界会让同一帧被步进多次。
  return new Vehicle(field, new Physics());
}

function input(partial: Partial<InputFrame> = {}): InputFrame {
  return Object.assign(createInputFrame(), partial);
}

function drive(vehicle: Vehicle, frame: InputFrame, seconds: number): void {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) {
    vehicle.update(frame, FIXED_DT);
  }
}

/**
 * 这个文件同时是「四轮真车的手感规格书」。
 *
 * 断言里的区间是写实目标(不是街机)。区间挂了不一定是 bug,但一定意味着
 * 手感变了 —— 需要有人确认那是不是想要的变化。注意区分:「一定会挂、且
 * 该挂」的用例标了 `it.fails` 并写死原因;普通用例要么现在绿,要么也是
 * 目标差但被明确标注。
 */

describe('Vehicle 四轮:静止与接地', () => {
  it('静止时四个轮子都接地,不上下弹', () => {
    const v = makeVehicle();
    drive(v, input(), 3);

    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      v.update(input(), FIXED_DT);
      samples.push(v.clearance);
    }
    const min = Math.min(...samples);
    const max = Math.max(...samples);

    // 前轮/后轮都应落地:轮子数量由 delta 判断,别只看 clearance。
    setTelemetryEnabled(true);
    v.update(input(), FIXED_DT);
    const tel = readTelemetry();
    const groundedWheels = tel.wheels.filter((w) => w.grounded).length;

    // 静止时四个轮子都该支撑在路面上(地面是平地,载荷稳定)。
    expect(groundedWheels).toBe(4);
    // 静止稳态高度落在悬挂行程附近、且几乎不抖。
    expect(min).toBeGreaterThan(CAR.suspensionRest - CAR.suspensionTravel - 0.05);
    expect(max).toBeLessThan(CAR.suspensionRest + 0.05);
    expect(max - min).toBeLessThan(0.01);
  });

  it('从高处落下会掉回路面并稳定', () => {
    const v = makeVehicle();
    v.position.y += 40;
    expect(v.position.y).toBeGreaterThan(30);

    drive(v, input(), 5);

    expect(v.grounded).toBe(true);
    expect(Math.abs(v.velocity.y)).toBeLessThan(2);
    // 落到路面时悬挂被车重压掉一部分,clearance 应回落到悬挂行程量级。
    expect(v.clearance).toBeGreaterThan(CAR.suspensionRest - CAR.suspensionTravel - 0.1);
    expect(v.clearance).toBeLessThan(CAR.suspensionRest + CAR.suspensionTravel);
  });
});

describe('Vehicle 四轮:纵向加速', () => {
  it('0 → 100 km/h 四秒出头(写实目标)', () => {
    const v = makeVehicle();
    const go = input({ throttle: 1 });
    let frames = 0;
    while (v.groundSpeed * 3.6 < 100 && frames < 60 * 8) {
      v.update(go, FIXED_DT);
      frames++;
    }
    const time = frames / 60;
    expect(v.groundSpeed * 3.6).toBeGreaterThanOrEqual(100);
    // HANDOFF 目标「四秒出头」,留宽容差:4.25s 现测,区间 3.5~6.5。
    expect(time).toBeGreaterThan(3.5);
    expect(time).toBeLessThan(6.5);
  });

  it('松油门滑行持续减速但不会倒车、不会突然失稳', () => {
    const v = makeVehicle();
    drive(v, input({ throttle: 1 }), 3);
    const before = v.groundSpeed;
    expect(before).toBeGreaterThan(15);

    drive(v, input(), 6);
    // 真实车辆滚阻小,滑行衰减很缓;这里只要持续下降且不反向、不 NaN。
    expect(v.groundSpeed).toBeLessThan(before);
    expect(v.groundSpeed).toBeGreaterThan(0);
    expect(Number.isFinite(v.yawRate)).toBe(true);
  });

  it('空气刹明显强于自然滑行,但不会把速度清零', () => {
    const coast = makeVehicle();
    const braked = makeVehicle();
    const go = input({ throttle: 1 });

    drive(coast, go, 3);
    drive(braked, go, 3);
    const start = braked.groundSpeed;

    drive(coast, input(), 1);
    drive(braked, input({ airBrake: 1 }), 1);

    expect(braked.groundSpeed).toBeLessThan(coast.groundSpeed * 0.75);
    expect(braked.groundSpeed).toBeGreaterThan(start * 0.2);
  });

  it('倒车明显弱于前进', () => {
    const v = makeVehicle();
    drive(v, input({ reverse: 1 }), 6);
    // 前进 4.25s 就到 100;倒车 6s 远低于此,且转得动(方向可控)。
    expect(v.groundSpeed).toBeGreaterThan(1);
    expect(v.groundSpeed).toBeLessThan(55);
    expect(Number.isFinite(v.yawRate)).toBe(true);
  });

  it.fails(
    '满油门直线行驶不应原地打转 —— 回正力矩要能把车尾拉直(等 spin bug 修复后启用)',
    { timeout: 30_000 },
    () => {
      // 平地长期满油门是测这套「打转」最干净的场景:没有赛道出生点那一点
      // 初始扰动帮助,车自己就能靠滑移/载荷转移转起来(见 spin-diagnosis.md)。
      const v = makeVehicle();
      drive(v, input({ throttle: 1 }), 15);

      // 直线、方向盘正:车不该横向漂、更不该横着转。
      expect(Math.abs(v.lateralSpeed)).toBeLessThan(1.5);
      expect(Math.abs(v.yawRate)).toBeLessThan(0.3);
    },
  );
});

describe('Vehicle 四轮:转向', () => {
  it('静止时打满舵不会原地转头(没有速度就没有侧向力)', () => {
    const v = makeVehicle();
    drive(v, input(), 1);
    const yawBefore = v.yaw;

    drive(v, input({ steer: 1 }), 2);

    expect(v.groundSpeed).toBeLessThan(0.5);
    expect(Math.abs(v.yaw - yawBefore)).toBeLessThan(0.02);
  });

  it('按右转,车就往车头的右手边跑(A/D 不能反)', () => {
    const measure = (steer: number): number => {
      const v = makeVehicle();
      drive(v, input({ throttle: 1 }), 3);
      const x0 = v.position.x;
      drive(v, input({ throttle: 1, steer }), 1);
      return v.position.x - x0;
    };
    // 出生 yaw=0 朝 +Z,右手边是 -X(forward×up = (0,0,1)×(0,1,0)=(-1,0,0))。
    // 断言位置而非 yaw 符号 —— 位置不依赖任何内部约定。
    expect(measure(1)).toBeLessThan(-2);
    expect(measure(-1)).toBeGreaterThan(2);
  });

  it('左右满舵的轨迹关于出发方向镜像(容差放宽:地形侧向不完全对称)', () => {
    const right = makeVehicle();
    const left = makeVehicle();
    const go = input({ throttle: 1 });
    drive(right, go, 3);
    drive(left, go, 3);
    drive(right, input({ throttle: 1, steer: 1 }), 1);
    drive(left, input({ throttle: 1, steer: -1 }), 1);

    // Heightfield 是带起伏的地面,左右两轮各自压到不同地形,所以不追求逐位
    // 镜像 —— 只要量级一致、方向相反(precision 0 = ±0.5),就能抓住
    // 「转向方向写反」那种整片反号的 bug,又不会被地形不对称误报。
    expect(right.position.x).toBeCloseTo(-left.position.x, 0);
    expect(right.position.z).toBeCloseTo(left.position.z, 0);
    expect(right.yaw).toBeCloseTo(-left.yaw, 0);
  });

  it.fails(
    '高速满舵不应原地打转、持续过弯侧滑角不应失控(等 spin bug 修复后启用)',
    { timeout: 30_000 },
    () => {
      const v = makeVehicle();
      drive(v, input({ throttle: 1 }), 3);
      const before = v.groundSpeed;

      let peakYawRate = 0;
      for (let i = 0; i < 60 * 2; i++) {
        v.update(input({ throttle: 1, steer: 1 }), FIXED_DT);
        peakYawRate = Math.max(peakYawRate, Math.abs(v.yawRate));
      }

      // 高速打满舵是过弯,不是原地画圈。
      expect(v.groundSpeed).toBeGreaterThan(before * 0.5);
      expect(peakYawRate).toBeLessThan(2.5);
    },
  );
});

describe('Vehicle 确定性', () => {
  it('同一段输入跑两次,状态逐位一致', () => {
    const run = (): number[] => {
      const v = new Vehicle(new Heightfield(new Rng(42)), new Physics());
      const go = input({ throttle: 1, steer: 0.4 });
      drive(v, go, 6);
      return [v.position.x, v.position.y, v.position.z, v.velocity.x, v.velocity.z, v.yaw];
    };
    expect(run()).toEqual(run());
  });

  it('录制的输入重放一遍,结果与原始运行完全一致', () => {
    const recorder = new InputRecorder();
    const rng = new Rng(9);

    const live = makeVehicle();
    const frame = createInputFrame();
    for (let i = 0; i < 600; i++) {
      // 每 30 帧换一次操作,模拟真人断续输入。
      if (i % 30 === 0) {
        frame.throttle = rng.next() > 0.25 ? 1 : 0;
        frame.steer = rng.range(-1, 1);
        frame.airBrake = rng.next() > 0.85 ? 1 : 0;
      }
      recorder.record(frame);
      live.update(frame, FIXED_DT);
    }

    const playback = new RecordedInput(recorder.toRecording());
    const ghost = makeVehicle();
    const replayed = createInputFrame();
    for (let i = 0; i < 600; i++) {
      playback.sample(replayed);
      ghost.update(replayed, FIXED_DT);
    }

    // 逐位相等,不是「足够接近」。record() 会把实时输入也量化成回放精度,
    // 所以两次仿真吃的是同一串数字 —— 这正是 M4 幽灵能对得上的前提。
    expect(ghost.position.x).toBe(live.position.x);
    expect(ghost.position.y).toBe(live.position.y);
    expect(ghost.position.z).toBe(live.position.z);
    expect(ghost.yaw).toBe(live.yaw);
    expect(ghost.velocity.x).toBe(live.velocity.x);
    expect(ghost.velocity.z).toBe(live.velocity.z);
  });

  it('长时间随机操作不会产生 NaN', () => {
    const v = makeVehicle();
    const rng = new Rng(5);
    const frame = createInputFrame();

    for (let i = 0; i < 60 * 90; i++) {
      if (i % 17 === 0) {
        frame.throttle = rng.next();
        frame.reverse = rng.next() > 0.8 ? rng.next() : 0;
        frame.steer = rng.range(-1, 1);
        frame.airBrake = rng.next() > 0.7 ? 1 : 0;
      }
      v.update(frame, FIXED_DT);
    }

    for (const value of [
      v.position.x, v.position.y, v.position.z,
      v.velocity.x, v.velocity.y, v.velocity.z,
      v.yaw, v.yawRate, v.clearance, v.lateralSpeed,
      v.orientation.x, v.orientation.y, v.orientation.z, v.orientation.w,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(v.orientation.length()).toBeCloseTo(1, 6);
  });

  it('地形起伏能把车送上天,而且一定会落回来', () => {
    let sawAirborne = false;
    let landedAgain = false;

    // 朝八个方向各冲一段,只要地形里有跳台就一定会出现离地帧。
    for (let dir = 0; dir < 8; dir++) {
      const v = makeVehicle();
      v.reset(0, 0, (dir / 8) * Math.PI * 2);
      const go = input({ throttle: 1 });

      let airborneHere = false;
      for (let i = 0; i < 60 * 12; i++) {
        v.update(go, FIXED_DT);
        if (!v.grounded) {
          airborneHere = true;
          sawAirborne = true;
        } else if (airborneHere) {
          landedAgain = true;
        }
      }
    }

    expect(sawAirborne).toBe(true);
    expect(landedAgain).toBe(true);
  });
});
