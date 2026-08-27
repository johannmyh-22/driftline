import type { Rng } from '../core/rng';

/**
 * 生成一段可循环的白噪声缓冲,给气流声用。
 *
 * 用注入的 `Rng`,不直接调全局随机数函数(见 CLAUDE.md 的硬约束)——
 * 这段缓冲只在构造时生成一次,之后循环播放,不影响后续每帧路径的确定性,
 * 但生成过程本身仍然要走同一条随机数纪律,免得漏网之鱼被
 * `tests/unit/noMathRandom.test.ts` 之外的地方藏起来。
 */
export function createNoiseBuffer(context: AudioContext, rng: Rng, seconds = 2): AudioBuffer {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = rng.range(-1, 1);
  }
  return buffer;
}
