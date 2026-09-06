import { lerp } from '../core/mathx';
import type { Rng } from '../core/rng';
import { AUDIO } from '../game/tuning';
import type { AudioBus } from './context';
import { createNoiseBuffer } from './noise';

/**
 * 贴着护墙磨过去的持续刮擦声。
 *
 * **和 `ImpactPlayer` 是两件事,不是同一个声音的两种强度**:撞击是*事件*
 * (发生在一帧),刮擦是*状态*(贴着墙滑多久就响多久)。人类反馈"碰撞是分为
 * 好几种的,可能是摩擦过去的,可能直接撞过去的",少的就是这一层——上一版
 * 只有事件层,所以擦墙滑行要么被 `impactMinStrength` 整个静音、要么退化成
 * 一串重复的"哐",两种都不像在磨墙。
 *
 * 结构和 `WindNoise` 一样(预生成噪声循环 + 滤波 + 增益),但有两处刻意的
 * 区别,不然两层噪声会糊成一片:
 *
 * - 滤波器用**高 Q 带通**(`scrapeQ`)而不是宽频低通——刮擦要的是金属摩擦
 *   的共鸣,气流要的是宽频呼啸。
 * - 平滑时间常数**远快于**气流(`scrapeSmoothing` vs `windSmoothing`)。接触
 *   是通断式的:离开墙面还拖着尾巴,听起来就像刮擦声黏在车后面跟着跑。
 */
export class ScrapeNoise {
  private readonly source: AudioBufferSourceNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;

  constructor(bus: AudioBus, rng: Rng) {
    this.source = bus.context.createBufferSource();
    this.source.buffer = createNoiseBuffer(bus.context, rng);
    this.source.loop = true;

    this.filter = bus.context.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.frequency.value = AUDIO.scrapeFilterIdleFreq;
    this.filter.Q.value = AUDIO.scrapeQ;

    this.gain = bus.context.createGain();
    this.gain.gain.value = 0;

    this.source.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(bus.master);
    this.source.start();
  }

  /**
   * `tangentSpeed` 是 `Vehicle.wallTangentSpeed`(m/s,没接触墙是 0)。
   * 没接触时直接喂 0 就会静音,不需要额外的通断标志。
   */
  update(tangentSpeed: number, context: AudioContext): void {
    const now = context.currentTime;
    const speed01 = Math.min(1, tangentSpeed / AUDIO.scrapeRefSpeed);
    const targetFilter = lerp(AUDIO.scrapeFilterIdleFreq, AUDIO.scrapeFilterMaxFreq, speed01);
    this.filter.frequency.setTargetAtTime(targetFilter, now, AUDIO.scrapeSmoothing);
    this.gain.gain.setTargetAtTime(AUDIO.scrapeMaxGain * speed01, now, AUDIO.scrapeSmoothing);
  }

  dispose(): void {
    this.source.stop();
    this.source.disconnect();
    this.filter.disconnect();
    this.gain.disconnect();
  }
}
