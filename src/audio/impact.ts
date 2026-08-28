import { lerp } from '../core/mathx';
import type { Rng } from '../core/rng';
import { AUDIO } from '../game/tuning';
import type { AudioBus } from './context';
import { createNoiseBuffer } from './noise';

/**
 * 撞墙音:低频"闷响"(方波)+ 噪声"碎裂"分量叠加,`strength` 是
 * `Vehicle.wallImpact`(0..1,当帧撞墙强度,没撞是 0)。
 *
 * 事件驱动,不在每帧路径上——只在真的撞墙那一帧调用。噪声缓冲在构造时
 * 预生成一次(仿 `WindNoise` 的做法,见 `wind.ts`):撞墙可能连续好几帧
 * 触发(贴着护栏蹭),没必要每次撞击都现造一段新的随机数据。
 *
 * 音高、滤波亮度、衰减时长、噪声混合量四个维度都跟 `strength` 走(见
 * `tuning.ts` AUDIO 段的注释)——只让音量变化会让不同速度的撞击听起来
 * 像同一个声音调了音量旋钮,人耳很容易分辨出来,不像是真的撞击。
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
    const brightness = lerp(AUDIO.impactFilterFreqMin, AUDIO.impactFilterFreqMax, s);
    const duration = lerp(AUDIO.impactDurationMin, AUDIO.impactDurationMax, s);

    const osc = context.createOscillator();
    osc.type = 'square';
    osc.frequency.value = lerp(AUDIO.impactToneFreqMin, AUDIO.impactToneFreqMax, s);

    const toneFilter = context.createBiquadFilter();
    toneFilter.type = 'lowpass';
    toneFilter.frequency.value = brightness;

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

    const noise = context.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = brightness;

    const noiseGain = context.createGain();
    noiseGain.gain.setValueAtTime(AUDIO.impactNoiseGain * s, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + AUDIO.impactNoiseDuration);

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.bus.master);
    noise.start(now);
    noise.stop(now + AUDIO.impactNoiseDuration + 0.02);
    noise.addEventListener('ended', () => {
      noise.disconnect();
      noiseFilter.disconnect();
      noiseGain.disconnect();
    });
  }
}
