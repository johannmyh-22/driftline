import { lerp } from '../core/mathx';
import type { Rng } from '../core/rng';
import { AUDIO } from '../game/tuning';
import type { AudioBus } from './context';
import { createNoiseBuffer } from './noise';

/**
 * 撞墙音:噪声"碎裂"(主角)+ 快速下滑的低频"车身"分量(配角)叠加,
 * `strength` 是 `Vehicle.wallImpact`(0..1,当帧撞墙强度,没撞是 0)。
 *
 * 事件驱动,不在每帧路径上——只在真的撞墙那一帧调用。噪声缓冲在构造时
 * 预生成一次(仿 `WindNoise` 的做法,见 `wind.ts`):撞墙可能连续好几帧
 * 触发(贴着护栏蹭),没必要每次撞击都现造一段新的随机数据。
 *
 * 音高、亮度、衰减时长、噪声混合量都跟 `strength` 走——只让音量变化会让
 * 不同速度的撞击听起来像同一个声音调了音量旋钮,人耳很容易分辨。
 *
 * ## 为什么噪声是主角、车身是配角
 *
 * 上一版反过来:车身层增益 0.5 比噪声层 0.35 高、时长也更长,人类实际听过
 * 之后反馈"太软/太闷没有硬物撞击感""音调太低沉听起来空心"。三条根因都是
 * 查出来的:
 *
 * 1. **主次颠倒**。硬物相撞那一下"硬"在瞬态,瞬态是宽频噪声,不是音调。让
 *    音调层压过噪声层,出来的必然是"一个闷响的球"。两个增益已经对调。
 * 2. **方波 = 空心**。方波只有奇次谐波,这在音色学上就是空心音色(单簧管)
 *    的来源。换成锯齿波补上偶次谐波,音高区间也从 42~85Hz 抬到 74~155Hz。
 *    另外加了一段极快的下滑音(`impactTonePitchDrop`):定频振荡器听起来是
 *    "一个音",有下滑才像"一下撞击",这是打击乐合成的通用做法。
 * 3. **噪声层被低通砍掉了脆的那一半**。上一版噪声和车身共用同一个截止
 *    500~2400Hz 的**低通**,crack 最关键的高频全被滤掉,只剩低频轰隆——这是
 *    "闷"最直接的一条。现在噪声独立走**高通**,把低频轰隆滤掉、留下脆的部分,
 *    车身层继续走低通保留重量感,两层各管各的频段。
 */
export class ImpactPlayer {
  private readonly bus: AudioBus;
  private readonly noiseBuffer: AudioBuffer;

  constructor(bus: AudioBus, rng: Rng) {
    this.bus = bus;
    this.noiseBuffer = createNoiseBuffer(bus.context, rng, 0.5);
  }

  play(strength: number): void {
    if (strength < AUDIO.impactMinStrength) {
      return;
    }
    const s = Math.min(1, strength);
    const context = this.bus.context;
    const now = context.currentTime;

    // ── 噪声"碎裂":主角。高通留下 crack,包络比车身层更短。 ──
    const noiseDuration = lerp(AUDIO.impactNoiseDurationMin, AUDIO.impactNoiseDurationMax, s);

    const noise = context.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.value = lerp(
      AUDIO.impactNoiseHighpassMin,
      AUDIO.impactNoiseHighpassMax,
      s,
    );

    const noiseGain = context.createGain();
    noiseGain.gain.setValueAtTime(AUDIO.impactNoiseGain * s, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + noiseDuration);

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.bus.master);
    noise.start(now);
    noise.stop(now + noiseDuration + 0.02);
    noise.addEventListener('ended', () => {
      noise.disconnect();
      noiseFilter.disconnect();
      noiseGain.disconnect();
    });

    // ── 车身"重量":配角。锯齿波 + 快速下滑,过低通保留低频实体感。 ──
    const duration = lerp(AUDIO.impactDurationMin, AUDIO.impactDurationMax, s);
    const endFreq = lerp(AUDIO.impactToneFreqMin, AUDIO.impactToneFreqMax, s);

    const osc = context.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(endFreq * AUDIO.impactTonePitchDrop, now);
    osc.frequency.exponentialRampToValueAtTime(
      endFreq,
      now + duration * AUDIO.impactToneSweepRatio,
    );

    const toneFilter = context.createBiquadFilter();
    toneFilter.type = 'lowpass';
    toneFilter.frequency.value = lerp(AUDIO.impactFilterFreqMin, AUDIO.impactFilterFreqMax, s);

    const toneGain = context.createGain();
    toneGain.gain.setValueAtTime(AUDIO.impactGain * s, now);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(toneFilter);
    toneFilter.connect(toneGain);
    toneGain.connect(this.bus.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
    osc.addEventListener('ended', () => {
      osc.disconnect();
      toneFilter.disconnect();
      toneGain.disconnect();
    });
  }
}
