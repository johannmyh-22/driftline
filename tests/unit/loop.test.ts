import { describe, expect, it } from 'vitest';
import { FIXED_DT, Loop } from '../../src/core/loop';

interface Harness {
  loop: Loop;
  updates: number[];
  renders: number[];
  scheduled: ((timeMs: number) => void)[];
}

function makeLoop(maxStepsPerTick?: number): Harness {
  const updates: number[] = [];
  const renders: number[] = [];
  const scheduled: ((timeMs: number) => void)[] = [];

  const loop = new Loop(
    {
      update: (dt) => updates.push(dt),
      render: (alpha) => renders.push(alpha),
    },
    {
      ...(maxStepsPerTick === undefined ? {} : { maxStepsPerTick }),
      requestFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelFrame: () => {},
    },
  );

  return { loop, updates, renders, scheduled };
}

describe('Loop 测试模式', () => {
  it('构造与 advance 都不注册 rAF', () => {
    const { loop, scheduled } = makeLoop();
    loop.advance(10);
    expect(scheduled).toHaveLength(0);
    expect(loop.running).toBe(false);
  });

  it('advance(60) 精确走 60 个固定步', () => {
    const { loop, updates, renders } = makeLoop();
    loop.advance(60);

    expect(loop.frame).toBe(60);
    expect(updates).toHaveLength(60);
    expect(new Set(updates)).toEqual(new Set([FIXED_DT]));
    // 一次 advance 只渲染一次,且渲染的是步进后的状态。
    expect(renders).toEqual([1]);
  });

  it('多次 advance 的帧数累加', () => {
    const { loop } = makeLoop();
    loop.advance(17);
    const before = loop.frame;
    loop.advance(60);
    expect(loop.frame - before).toBe(60);
  });

  it('elapsed 由帧数算出,不累积浮点漂移', () => {
    const { loop } = makeLoop();
    loop.advance(600);
    expect(loop.elapsed).toBe(600 * FIXED_DT);
  });

  it('advance(0) 只渲染不步进', () => {
    const { loop, updates, renders } = makeLoop();
    loop.advance(0);
    expect(loop.frame).toBe(0);
    expect(updates).toHaveLength(0);
    expect(renders).toEqual([1]);
  });

  it('拒绝负数与非整数', () => {
    const { loop } = makeLoop();
    expect(() => loop.advance(-1)).toThrow(RangeError);
    expect(() => loop.advance(1.5)).toThrow(RangeError);
  });
});

describe('Loop 实时模式', () => {
  it('start 注册一次 rAF,stop 之后不再续帧', () => {
    const { loop, scheduled } = makeLoop();
    loop.start();
    expect(scheduled).toHaveLength(1);
    expect(loop.running).toBe(true);

    loop.start();
    expect(scheduled).toHaveLength(1);

    loop.stop();
    expect(loop.running).toBe(false);
  });

  it('按墙钟时间补齐固定步,余量作为插值系数', () => {
    const { loop, updates, renders } = makeLoop();
    loop.pump(0);
    expect(updates).toHaveLength(0);

    // 25ms ≈ 1.5 步:走 1 步,剩下半步进插值。
    loop.pump(25);
    expect(loop.frame).toBe(1);
    expect(renders.at(-1)).toBeCloseTo(0.5, 5);

    loop.pump(50);
    expect(loop.frame).toBe(3);
  });

  it('长时间挂起后只补有限帧,其余丢弃', () => {
    const { loop } = makeLoop(5);
    loop.pump(0);
    // 切走标签页 10 秒 = 600 帧,只允许补 5 帧。
    loop.pump(10_000);

    expect(loop.frame).toBe(5);
    expect(loop.dropped).toBeGreaterThan(9.9);
  });

  it('时间戳倒退不会产生负步长', () => {
    const { loop, updates } = makeLoop();
    loop.pump(1000);
    loop.pump(900);
    expect(loop.frame).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
