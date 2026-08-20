/**
 * mulberry32:32 位状态、无乘法溢出问题、周期 2^32。
 *
 * 为什么不用 `Math.random`:截图回归和幽灵回放都要求同一个 seed 必须逐帧复现,
 * 而 `Math.random` 的种子不可控。整个 `src/` 禁止直接调用它
 * (由 tests/unit/no-math-random.test.ts 强制)。
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** 下一个 32 位无符号整数。 */
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** `[0, 1)` 均匀分布。 */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** `[min, max)` 均匀分布。 */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** `[0, maxExclusive)` 的整数。 */
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  /** 从非空数组里等概率取一个元素。 */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('Rng.pick() 需要非空数组');
    }
    return items[this.int(items.length)] as T;
  }

  /**
   * 派生一条独立的随机流。
   *
   * 让子系统各持一个 Rng,而不是共用一个:这样"地形多消费了两个随机数"
   * 不会把赛道生成结果整个改掉。
   */
  fork(): Rng {
    return new Rng(this.nextUint32());
  }
}

/** 把任意字符串折叠成 32 位种子(FNV-1a),供 URL 里的文字 seed 使用。 */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 解析 URL 上的 `?seed=`:纯数字按数字用,其余走 hash,缺省用 fallback。 */
export function parseSeed(raw: string | null, fallback: number): number {
  if (raw === null || raw === '') {
    return fallback >>> 0;
  }
  if (/^\d+$/.test(raw)) {
    return Number.parseInt(raw, 10) >>> 0;
  }
  return hashSeed(raw);
}
