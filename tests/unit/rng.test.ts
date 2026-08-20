import { describe, expect, it } from 'vitest';
import { Rng, hashSeed, parseSeed } from '../../src/core/rng';

function take(rng: Rng, count: number): number[] {
  return Array.from({ length: count }, () => rng.next());
}

describe('Rng', () => {
  it('同 seed 产出完全相同的序列', () => {
    expect(take(new Rng(42), 32)).toEqual(take(new Rng(42), 32));
  });

  it('不同 seed 产出不同序列', () => {
    expect(take(new Rng(42), 32)).not.toEqual(take(new Rng(43), 32));
  });

  it('输出落在 [0, 1)', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 10_000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('分布大致均匀', () => {
    const rng = new Rng(20_260_820);
    const samples = 50_000;
    let sum = 0;
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < samples; i++) {
      const value = rng.next();
      sum += value;
      buckets[Math.floor(value * 10)] = (buckets[Math.floor(value * 10)] ?? 0) + 1;
    }
    expect(sum / samples).toBeCloseTo(0.5, 2);
    for (const count of buckets) {
      expect(count).toBeGreaterThan(samples / 10 - samples * 0.01);
      expect(count).toBeLessThan(samples / 10 + samples * 0.01);
    }
  });

  it('range / int 落在区间内', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 1000; i++) {
      const r = rng.range(-3, 5);
      expect(r).toBeGreaterThanOrEqual(-3);
      expect(r).toBeLessThan(5);

      const n = rng.int(7);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(7);
    }
  });

  it('pick 只返回数组内元素,空数组报错', () => {
    const rng = new Rng(5);
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 50; i++) {
      expect(items).toContain(rng.pick(items));
    }
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it('fork 出的子流互相独立,但整体仍然确定', () => {
    const build = (): number[][] => {
      const root = new Rng(2024);
      const a = root.fork();
      const b = root.fork();
      return [take(a, 8), take(b, 8)];
    };

    const first = build();
    expect(build()).toEqual(first);
    expect(first[0]).not.toEqual(first[1]);
  });

  it('nextUint32 是 32 位无符号整数', () => {
    const rng = new Rng(1);
    for (let i = 0; i < 1000; i++) {
      const value = rng.nextUint32();
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('parseSeed', () => {
  it('缺省时用 fallback', () => {
    expect(parseSeed(null, 1337)).toBe(1337);
    expect(parseSeed('', 1337)).toBe(1337);
  });

  it('纯数字按数字解析', () => {
    expect(parseSeed('42', 1337)).toBe(42);
    expect(parseSeed('0', 1337)).toBe(0);
  });

  it('非数字走 hash,且稳定', () => {
    expect(parseSeed('driftline', 1337)).toBe(hashSeed('driftline'));
    expect(hashSeed('driftline')).toBe(hashSeed('driftline'));
    expect(hashSeed('driftline')).not.toBe(hashSeed('driftlin'));
  });
});
