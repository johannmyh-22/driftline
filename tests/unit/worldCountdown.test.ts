import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { type InputRecorder, createInputFrame } from '../../src/core/input';
import { initPhysics } from '../../src/game/physics';
import { RACE_FORMAT } from '../../src/game/tuning';
import { World } from '../../src/game/world';

const DT = 1 / 60;
const COUNTDOWN_STEPS = Math.round(RACE_FORMAT.countdownSeconds / DT);

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 发车倒计时期间,玩家的圈计时、输入录制、幽灵回放都不走(HANDOFF 第七十二节)。
 *
 * 这是修出来的:原来三样都在倒计时里照走。第一圈白白多 3 秒,各圈加起来和
 * `RaceSession.elapsed`(倒计时不走)对不上;幽灵比玩家早 3 秒出发。
 *
 * 测试模式跳过倒计时(`skipCountdown`),所以冒烟测试和截图永远碰不到这条路 ——
 * 只有真人开局才走得到。这里直接造一个带倒计时的 `World`。
 * ══════════════════════════════════════════════════════════════════════════
 */
describe('发车倒计时', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  const throttle = createInputFrame();
  throttle.throttle = 1;

  it('圈计时从发车那一步开始,和赛事总用时逐位一致', () => {
    const world = new World(new Rng(42), 'race', { skipCountdown: false });
    for (let i = 0; i < COUNTDOWN_STEPS - 1; i++) {
      world.update(throttle, DT);
      expect(world.session?.phase).toBe('countdown');
      expect(world.race?.lapTime).toBe(0);
    }
    for (let i = 0; i < 180; i++) {
      world.update(throttle, DT);
    }
    expect(world.session?.phase).toBe('running');
    expect(world.race?.lapTime).toBeGreaterThan(2);
    // 两边都是从同一步开始、每步加同一个 dt —— 应当逐位相同,不是「差不多」。
    expect(world.race?.lapTime).toBe(world.session?.elapsed);
  });

  it('幽灵等发车灯,不在倒计时里先开走', () => {
    const world = new World(new Rng(42), 'race', { skipCountdown: false });
    const ghost = world.ghost;
    expect(ghost).not.toBeNull();
    // 一段全油门的录制:幽灵只要被推进,就一定会动。
    const recording = new Int8Array(600 * 4);
    for (let f = 0; f < 600; f++) {
      recording[f * 4] = 127;
    }
    ghost?.loadRecording(recording);
    world.spawnAtStart();

    world.present(1);
    const start = ghost?.craft.group.position.clone();
    for (let i = 0; i < COUNTDOWN_STEPS - 1; i++) {
      world.update(throttle, DT);
    }
    world.present(1);
    expect(ghost?.craft.group.position.distanceTo(start!)).toBeLessThan(1e-6);

    for (let i = 0; i < 120; i++) {
      world.update(throttle, DT);
    }
    world.present(1);
    expect(ghost?.craft.group.position.distanceTo(start!)).toBeGreaterThan(5);
  });

  it('输入录制从发车开始:倒计时那 3 秒不进幽灵', () => {
    const world = new World(new Rng(42), 'race', { skipCountdown: false });
    // `recorder` 是私有的;这里只读它的长度,别的不碰。
    const recorder = (world as unknown as { recorder: InputRecorder }).recorder;
    // 步数不写死:3 秒 / (1/60) 的浮点累减未必恰好在第 180 步归零。
    for (let i = 0; i < COUNTDOWN_STEPS + 5 && world.session?.phase === 'countdown'; i++) {
      world.update(throttle, DT);
    }
    // 倒计时在最后那一步归零,那一步本身输入仍然锁着,也不录。
    expect(world.session?.phase).toBe('running');
    expect(recorder.length).toBe(0);
    for (let i = 0; i < 90; i++) {
      world.update(throttle, DT);
    }
    expect(recorder.length).toBe(90);
  });
});
