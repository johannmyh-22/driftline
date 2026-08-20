import type { Rng } from '../core/rng';

/**
 * 赛道外地形用的梯度噪声(Perlin 风格)+ fbm。
 *
 * 自己写而不是引库:这个项目禁止二进制资产也不想为了一个噪声函数加依赖,
 * 而且置换表必须由注入的 seeded PRNG 生成 —— 换了 seed 地形要跟着变,
 * 同一个 seed 又必须逐帧复现。
 */

const TABLE_SIZE = 256;
const TABLE_MASK = TABLE_SIZE - 1;

export interface TerrainOptions {
  /** 特征尺度(米)。越大山越缓。 */
  scale: number;
  /** 起伏幅度(米)。 */
  amplitude: number;
  /** 叠加几层。每层频率翻倍、幅度减半。 */
  octaves: number;
}

export class TerrainNoise {
  private readonly permutation: Uint8Array;
  private readonly options: TerrainOptions;

  constructor(rng: Rng, options: TerrainOptions) {
    this.options = options;

    // Fisher-Yates 洗牌,随机数全部来自注入的 Rng。
    const table = new Uint8Array(TABLE_SIZE);
    for (let i = 0; i < TABLE_SIZE; i++) {
      table[i] = i;
    }
    for (let i = TABLE_SIZE - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const a = table[i] ?? 0;
      const b = table[j] ?? 0;
      table[i] = b;
      table[j] = a;
    }
    this.permutation = table;
  }

  /** 分形叠加后的高度(米)。 */
  heightAt(x: number, z: number): number {
    let total = 0;
    let frequency = 1 / this.options.scale;
    let amplitude = 1;
    let normalizer = 0;

    for (let octave = 0; octave < this.options.octaves; octave++) {
      total += this.noise2D(x * frequency, z * frequency) * amplitude;
      normalizer += amplitude;
      frequency *= 2;
      amplitude *= 0.5;
    }

    return (total / (normalizer || 1)) * this.options.amplitude;
  }

  /** 单层梯度噪声,输出大致在 [-1, 1]。 */
  private noise2D(x: number, z: number): number {
    const xi = Math.floor(x) & TABLE_MASK;
    const zi = Math.floor(z) & TABLE_MASK;
    const xf = x - Math.floor(x);
    const zf = z - Math.floor(z);

    const u = fade(xf);
    const v = fade(zf);

    const aa = this.hash(xi, zi);
    const ab = this.hash(xi, zi + 1);
    const ba = this.hash(xi + 1, zi);
    const bb = this.hash(xi + 1, zi + 1);

    const x1 = lerp(gradient(aa, xf, zf), gradient(ba, xf - 1, zf), u);
    const x2 = lerp(gradient(ab, xf, zf - 1), gradient(bb, xf - 1, zf - 1), u);
    return lerp(x1, x2, v);
  }

  private hash(x: number, z: number): number {
    const a = this.permutation[x & TABLE_MASK] ?? 0;
    return this.permutation[(a + z) & TABLE_MASK] ?? 0;
  }
}

function fade(t: number): number {
  // 6t⁵-15t⁴+10t³:一阶和二阶导数在格点处都为 0,所以格点上看不出接缝。
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function gradient(hash: number, x: number, z: number): number {
  // 用低两位选四个对角方向之一,比查梯度表便宜,视觉上没差别。
  switch (hash & 3) {
    case 0:
      return x + z;
    case 1:
      return -x + z;
    case 2:
      return x - z;
    default:
      return -x - z;
  }
}
