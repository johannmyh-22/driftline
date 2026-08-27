import { beforeAll, expect, it } from 'vitest';
import { FIXED_DT } from '../../src/core/loop';
import { InputRecorder, createInputFrame } from '../../src/core/input';
import { Rng } from '../../src/core/rng';
import { Course } from '../../src/game/course';
import { Ghost } from '../../src/game/ghost';
import { Physics, initPhysics } from '../../src/game/physics';
import { generateTrack } from '../../src/game/trackLayout';
import { Vehicle } from '../../src/game/vehicle';
import { createPalette } from '../../src/gfx/palette';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 幽灵回放的确定性:「不存轨迹,只存输入,靠同一个 seed 和同一套物理重新
 * 算出来」这句设计说明(见 ghost.ts / core/input.ts 的 InputRecorder 类注释)
 * 必须真的成立,不能只是注释里的一句话。
 *
 * 做法:手动驱动一辆「玩家」车跑若干帧,同时用 InputRecorder 录下同一串
 * 已经量化过的输入;把这段录制喂给一个独立的 Ghost(独立 Physics 世界、
 * 同一个 seed 生成的同一条赛道),推进同样的帧数,断言两边落在同一个位置。
 * ══════════════════════════════════════════════════════════════════════════
 */

beforeAll(async () => {
  await initPhysics();
});

it('幽灵用同一段录制重放,跟玩家实际跑出来的落点一致', () => {
  const seed = 7;
  const rng = new Rng(seed);
  const layout = generateTrack(rng.fork());
  const course = new Course(layout, rng.fork());
  const palette = createPalette(rng.fork());

  const start = layout.samples[0];
  if (start === undefined) {
    throw new Error('测试赛道没有采样点');
  }
  const startYaw = Math.atan2(start.tangentX, start.tangentZ);

  const player = new Vehicle(course, new Physics());
  player.reset(start.x, start.z, startYaw);

  const recorder = new InputRecorder();
  const frame = createInputFrame();
  const FRAMES = 240;

  for (let i = 0; i < FRAMES; i++) {
    // 全程给油,中段打一段舵:两个字段都只取 -1/0/1 这类能被 127 档量化
    // 精确表示的值,量化不引入误差(参见 InputRecorder.record 的类注释)。
    frame.throttle = 1;
    frame.steer = i > 80 && i < 160 ? 1 : 0;
    recorder.record(frame);
    player.update(frame, FIXED_DT);
  }

  const recording = recorder.toRecording();
  expect(recording.length).toBe(FRAMES * 4);

  const ghost = new Ghost(course, layout, rng.fork(), palette);
  expect(ghost.hasRecording).toBe(false);
  ghost.loadRecording(recording);
  expect(ghost.hasRecording).toBe(true);
  ghost.restartLap();

  for (let i = 0; i < FRAMES; i++) {
    ghost.update(FIXED_DT);
  }
  ghost.present(1);

  const ghostPosition = ghost.craft.group.position;
  // 独立的 Rapier World、独立的浮点运算路径,允许极小的数值噪声,
  // 但绝不该是「跑到了完全不同的地方」那种量级(见 course.ts 的赛道尺度,
  // 几十到几百米)。1mm 的容差远小于任何有意义的漂移。
  expect(ghostPosition.x).toBeCloseTo(player.position.x, 3);
  expect(ghostPosition.y).toBeCloseTo(player.position.y, 3);
  expect(ghostPosition.z).toBeCloseTo(player.position.z, 3);
});

it('放完录制后幽灵输出全零,不回绕,restartLap 才重新出发', () => {
  const seed = 11;
  const rng = new Rng(seed);
  const layout = generateTrack(rng.fork());
  const course = new Course(layout, rng.fork());
  const palette = createPalette(rng.fork());

  const start = layout.samples[0];
  if (start === undefined) {
    throw new Error('测试赛道没有采样点');
  }

  const recorder = new InputRecorder();
  const frame = createInputFrame();
  for (let i = 0; i < 30; i++) {
    frame.throttle = 1;
    recorder.record(frame);
  }

  const ghost = new Ghost(course, layout, rng.fork(), palette);
  ghost.loadRecording(recorder.toRecording());
  ghost.restartLap();

  for (let i = 0; i < 30; i++) {
    ghost.update(FIXED_DT);
  }
  ghost.present(1);
  const afterRecording = ghost.craft.group.position.clone();

  // 录制放完了,再推进几十帧:没有回绕,车只会因为残余速度/重力继续动一点点,
  // 不会像还在按录制里的输入那样继续加速前进。
  for (let i = 0; i < 30; i++) {
    ghost.update(FIXED_DT);
  }
  ghost.present(1);
  const afterIdle = ghost.craft.group.position.clone();
  const driftedWhileIdle = afterIdle.distanceTo(afterRecording);

  ghost.restartLap();
  ghost.present(1);
  const afterRestart = ghost.craft.group.position;

  expect(driftedWhileIdle).toBeLessThan(5);
  // 用距离而不是逐轴 toBeCloseTo:reset() 落点会带一点悬挂/坡度残差
  // (和 smoke.spec.ts「起步静止半秒不溜车」那条断言同一类噪声来源),
  // 这里只关心「确实回到了起点附近」,不是逐厘米核对。
  const distanceFromStart = Math.hypot(afterRestart.x - start.x, afterRestart.z - start.z);
  expect(distanceFromStart).toBeLessThan(1);
});

it('没有装载录制时 update/present 都是空操作,craft 保持不可见', () => {
  const seed = 3;
  const rng = new Rng(seed);
  const layout = generateTrack(rng.fork());
  const course = new Course(layout, rng.fork());
  const palette = createPalette(rng.fork());

  const ghost = new Ghost(course, layout, rng.fork(), palette);
  expect(ghost.craft.group.visible).toBe(false);

  const before = ghost.craft.group.position.clone();
  ghost.update(FIXED_DT);
  ghost.present(1);
  expect(ghost.craft.group.position.equals(before)).toBe(true);

  ghost.loadRecording(null);
  expect(ghost.hasRecording).toBe(false);
  expect(ghost.craft.group.visible).toBe(false);
});
