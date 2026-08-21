import { describe, expect, it } from 'vitest';
import { type InputFrame, InputRecorder, RecordedInput, createInputFrame } from '../../src/core/input';
import { FIXED_DT } from '../../src/core/loop';
import { Rng } from '../../src/core/rng';
import { Heightfield } from '../../src/game/heightfield';
import { VEHICLE } from '../../src/game/tuning';
import { Vehicle } from '../../src/game/vehicle';

const field = new Heightfield(new Rng(42));

function makeVehicle(): Vehicle {
  return new Vehicle(field);
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
 * 这个文件同时是「手感规格书」。
 *
 * 断言里的数值区间就是当前调校的实测结果 —— 人类反馈「转向太贼」「刹车太软」
 * 之后,改的是 tuning.ts,然后回来把这里的区间一起更新。区间挂了不一定是
 * bug,但一定意味着手感变了,需要有人确认那是不是想要的变化。
 */
describe('Vehicle 悬浮', () => {
  it('静止时稳定悬浮,不上下弹', () => {
    const v = makeVehicle();
    drive(v, input(), 3);

    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      v.update(input(), FIXED_DT);
      samples.push(v.clearance);
    }

    const min = Math.min(...samples);
    const max = Math.max(...samples);
    // 稳态比 rideHeight 高约 4.6 cm,是固定步长离散化的残差,见 vehicle.ts 注释。
    expect(min).toBeGreaterThan(VEHICLE.rideHeight - 0.02);
    expect(max).toBeLessThan(VEHICLE.rideHeight + 0.1);
    expect(max - min).toBeLessThan(0.01);
  });

  it('从高处落下会掉回来并稳定下来', () => {
    const v = makeVehicle();
    v.position.y += 40;
    expect(v.position.y).toBeGreaterThan(30);

    drive(v, input(), 5);

    expect(v.grounded).toBe(true);
    expect(v.clearance).toBeGreaterThan(VEHICLE.rideHeight - 0.1);
    expect(v.clearance).toBeLessThan(VEHICLE.rideHeight + 0.2);
    expect(Math.abs(v.velocity.y)).toBeLessThan(0.5);
  });

  it('离地超过 hoverRange 就判定为脱离地面', () => {
    const v = makeVehicle();
    v.position.y += VEHICLE.hoverRange + 5;
    v.update(input(), FIXED_DT);
    expect(v.grounded).toBe(false);
  });
});

describe('Vehicle 加速与阻力', () => {
  it('极速稳定在设计值附近(≈ 88 m/s / 315 km/h)', () => {
    const v = makeVehicle();
    drive(v, input({ throttle: 1 }), 40);
    expect(v.groundSpeed).toBeGreaterThan(84);
    expect(v.groundSpeed).toBeLessThan(90);
  });

  it('0 → 100 km/h 在 1 秒出头', () => {
    const v = makeVehicle();
    const go = input({ throttle: 1 });
    let frames = 0;
    while (v.groundSpeed * 3.6 < 100 && frames < 600) {
      v.update(go, FIXED_DT);
      frames++;
    }
    // 0.92 秒那一版是 3g 起步,人类试玩后判为「太快、不写实」。现在约 2.3 秒,
    // 落在高性能量产车(2.5~3.5 秒)偏快的一档 —— 它毕竟是反重力赛车。
    expect(frames / 60).toBeGreaterThan(1.8);
    expect(frames / 60).toBeLessThan(3.0);
  });

  it('松油门会滑行减速,但不会倒车', () => {
    const v = makeVehicle();
    drive(v, input({ throttle: 1 }), 8);
    const before = v.groundSpeed;

    drive(v, input(), 3);
    // 滑行衰减比以前慢得多:线性阻力从 0.18 降到 0.05(那是轮胎滚阻的量级,
    // 而这台车没有轮胎)。松手后能滑很久,正是「没有轮胎」该有的样子。
    expect(v.groundSpeed).toBeLessThan(before * 0.97);
    expect(v.groundSpeed).toBeGreaterThan(0);
  });

  it('空气刹明显强于滑行,但不会把速度清零', () => {
    const coast = makeVehicle();
    const braked = makeVehicle();
    const go = input({ throttle: 1 });

    drive(coast, go, 12);
    drive(braked, go, 12);
    const start = braked.groundSpeed;

    drive(coast, input(), 1);
    drive(braked, input({ airBrake: 1 }), 1);

    expect(braked.groundSpeed).toBeLessThan(coast.groundSpeed * 0.75);
    expect(braked.groundSpeed).toBeGreaterThan(start * 0.25);
  });

  it('倒车明显弱于前进', () => {
    expect(VEHICLE.reverseThrust).toBeLessThan(VEHICLE.thrust / 2);

    const v = makeVehicle();
    drive(v, input({ reverse: 1 }), 6);
    expect(v.groundSpeed).toBeGreaterThan(1);
    expect(v.groundSpeed).toBeLessThan(45);
  });
});

describe('Vehicle 转向', () => {
  /**
   * 断言的是「车最后跑到了哪一边」,不是 yaw 的符号。
   *
   * 之前那版断言「yaw 与 steer 同号」,而 yaw 正方向到底是左还是右,正是当时
   * 搞反的那件事 —— 断言和 bug 共用同一个错误前提,83 条测试全绿也拦不住,
   * 最后是人试玩时发现 A 和 D 反了。位置断言不依赖任何内部约定,复制不了这个错。
   *
   * 出生时 yaw = 0、车头朝 +Z。此时「车头的右手边」= forward × up
   * = (0,0,1) × (0,1,0) = (-1,0,0),也就是世界的 -X。
   */
  /*
   * 静止时打满舵,车头一动不动 —— 这条是人类试玩时发现的:原来站着不动也能
   * 原地左右转,像坦克不像车。
   *
   * 根因在 `applySteering()`:能维持的转向速率 `ω = a_lat / v` 的分母写了
   * `Math.max(speed, 6)` 防除零,于是速度为 0 时它仍是个正数,转向权限没归零。
   * 偏航靠的是地面/气流给的侧向力,没有速度就没有力可用。
   */
  it('静止时打满舵也不会原地转头', () => {
    const v = makeVehicle();
    // 先让悬浮沉降稳定下来,免得把「车还在往下掉」误当成有速度。
    drive(v, input(), 1);
    const yawBefore = v.yaw;

    drive(v, input({ steer: 1 }), 2);

    expect(v.groundSpeed).toBeLessThan(0.5);
    expect(Math.abs(v.yaw - yawBefore)).toBeLessThan(0.02);
  });

  it('起步之后转向权限恢复', () => {
    const v = makeVehicle();
    drive(v, input({ throttle: 1 }), 2);
    const yawBefore = v.yaw;

    drive(v, input({ throttle: 1, steer: 1 }), 1);

    // 跑起来了就该能转 —— 上面那条不能是靠「转向坏掉」通过的。
    expect(v.groundSpeed).toBeGreaterThan(10);
    expect(Math.abs(v.yaw - yawBefore)).toBeGreaterThan(0.2);
  });

  it('按右转,车就往车头的右边跑(A/D 不能反)', () => {
    // 先直线加速再打方向,并且只打 1 秒:静止起步满舵 2 秒会转过 200° 以上,
    // 车绕回来了,终点位置就说明不了「往哪边偏」。
    const measure = (steer: number): number => {
      const v = makeVehicle();
      drive(v, input({ throttle: 1 }), 3);
      expect(v.position.x).toBe(0);
      drive(v, input({ throttle: 1, steer }), 1);
      return v.position.x;
    };

    expect(measure(1)).toBeLessThan(-2);
    expect(measure(-1)).toBeGreaterThan(2);
  });

  it('左右满舵的轨迹关于出发方向镜像', () => {
    /*
     * 只跑 1.2 秒,是为了让车留在出生点那片强制压平的地里(半径 46 米)。
     * 跑满 2 秒会开出去约 49 米,左右两边压到**不同的随机地形**,轨迹自然不再
     * 镜像 —— 那是地形不对称,不是转向逻辑不对称,别被它骗去放宽容差。
     */
    const right = makeVehicle();
    const left = makeVehicle();
    drive(right, input({ throttle: 1, steer: 1 }), 1.2);
    drive(left, input({ throttle: 1, steer: -1 }), 1.2);

    expect(Math.hypot(right.position.x, right.position.z)).toBeLessThan(46);

    expect(right.position.x).toBeCloseTo(-left.position.x, 6);
    expect(right.position.z).toBeCloseTo(left.position.z, 6);
    expect(right.yaw).toBeCloseTo(-left.yaw, 6);
  });

  it('高速转向率明显低于低速 —— 否则高速就变成原地打转', () => {
    const slow = makeVehicle();
    drive(slow, input({ throttle: 0.18, steer: 1 }), 4);

    const fast = makeVehicle();
    drive(fast, input({ throttle: 1 }), 20);
    drive(fast, input({ throttle: 1, steer: 1 }), 2);

    expect(fast.groundSpeed).toBeGreaterThan(slow.groundSpeed * 3);
    expect(Math.abs(fast.yawRate)).toBeLessThan(Math.abs(slow.yawRate) * 0.65);
  });

  it('转向时会有侧滑,方向与转向相反(速度落后于车头)', () => {
    const v = makeVehicle();
    drive(v, input({ throttle: 1 }), 20);
    drive(v, input({ throttle: 1, steer: 1 }), 1.5);

    // 右转 → 速度方向落后于车头,即相对车身在向左滑 → 「向右的侧向速度」为负。
    expect(v.lateralSpeed).toBeLessThan(-1);
  });

  it('空气刹提高侧向抓地,侧滑更少', () => {
    const loose = makeVehicle();
    const gripped = makeVehicle();
    drive(loose, input({ throttle: 1 }), 20);
    drive(gripped, input({ throttle: 1 }), 20);

    drive(loose, input({ throttle: 1, steer: 1 }), 1.5);
    drive(gripped, input({ throttle: 1, steer: 1, airBrake: 1 }), 1.5);

    expect(Math.abs(gripped.lateralSpeed)).toBeLessThan(Math.abs(loose.lateralSpeed));
  });

  it('松开方向后偏航角速度回到零', () => {
    const v = makeVehicle();
    drive(v, input({ throttle: 1, steer: 1 }), 2);
    expect(Math.abs(v.yawRate)).toBeGreaterThan(0.3);

    drive(v, input({ throttle: 1 }), 2);
    expect(Math.abs(v.yawRate)).toBeLessThan(0.02);
  });

  it('空中转向权限被大幅削弱', () => {
    const ground = makeVehicle();
    drive(ground, input({ throttle: 1 }), 10);
    const groundYaw = ground.yaw;
    drive(ground, input({ throttle: 1, steer: 1 }), 0.5);
    const groundDelta = Math.abs(ground.yaw - groundYaw);

    const air = makeVehicle();
    drive(air, input({ throttle: 1 }), 10);
    air.position.y += 30;
    const airYaw = air.yaw;
    drive(air, input({ throttle: 1, steer: 1 }), 0.5);
    const airDelta = Math.abs(air.yaw - airYaw);

    // 只比大小:方向已经由上面的位置断言守住了,这里管的是「空中转不动」。
    expect(airDelta).toBeGreaterThan(0);
    expect(airDelta).toBeLessThan(groundDelta * 0.6);
  });
});

describe('Vehicle 确定性', () => {
  it('同一段输入跑两次,状态逐位一致', () => {
    const run = (): number[] => {
      const v = new Vehicle(new Heightfield(new Rng(42)));
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
