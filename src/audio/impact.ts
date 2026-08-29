import { lerp } from '../core/mathx';
import type { Rng } from '../core/rng';
import { AUDIO } from '../game/tuning';
import type { AudioBus } from './context';
import { createNoiseBuffer } from './noise';

/**
 * 撞墙音:噪声"碎裂"(主角)+ 快速下滑的低频"车身"分量(配角)叠加。
 *
 * 事件驱动,不在每帧路径上——只在真的撞进墙里那一帧调用。持续贴着墙磨过去
 * 是另一回事,归 `ScrapeNoise`(见 `scrape.ts`),不由这里出声。噪声缓冲在
 * 构造时预生成一次(仿 `WindNoise`,见 `wind.ts`)。
 *
 * ## 两个轴:多硬(强度)× 什么角度(性格)
 *
 * 人类反馈"碰撞是分为好几种的,可能是摩擦过去的,可能直接撞过去的,而不是
 * 只是一种声音"。上一版分不出来的根因在数据层:它只拿到 `Vehicle.wallImpact`
 * 这一个标量,而那个量本身就是 `min(1, 法向/总速) × 法向`——**「多硬」和
 * 「什么角度」已经被乘死在一起了**,音频层再怎么映射也还原不出两个维度。
 *
 * 现在 `Vehicle` 把两半拆开报出来,这里用:
 *
 * - `strength = 法向速度 / impactRefNormalSpeed` —— 多硬,管音量/亮度/时长的基准。
 * - `headOn = 法向 / (法向 + 切向)` —— 什么角度,0 = 纯擦过,1 = 纯正面撞。
 *
 * `headOn` 通过四个 `impactGraze*Scale` 系数改变**音色性格**而不只是响度:
 * 正面撞激发车身低阶模态,低沉、有肉、拖得久;擦过去只在表面激发高频,又薄
 * 又亮又短。同样的法向速度,不同角度出来的是两种声音,不是一种声音调音量。
 *
 * ## 两层各管各的频段
 *
 * 更早一版噪声和车身共用一个低通(最高 2400Hz),crack 的高频全被砍掉,只剩
 * 低频轰隆——这是"闷"最直接的原因。现在噪声走**高通**留下脆的部分,车身走
 * **低通**保留重量感。另外车身层是锯齿波不是方波(方波只有奇次谐波,那是
 * "空心"音色的来源),并且带一段快速下滑音——定频振荡器听起来是"一个音",
 * 有下滑才像"一下撞击"。
 */
export class ImpactPlayer {
  private readonly bus: AudioBus;
  private readonly noiseBuffer: AudioBuffer;
  /** 上一次真的出声的时间与强度,用于抑制磨墙时的机关枪式重复触发。 */
  private lastPlayTime = Number.NEGATIVE_INFINITY;
  private lastStrength = 0;

  constructor(bus: AudioBus, rng: Rng) {
    this.bus = bus;
    this.noiseBuffer = createNoiseBuffer(bus.context, rng, 0.5);
  }

  /**
   * `normalSpeed`/`tangentSpeed` 都是 m/s,来自 `Vehicle.wallNormalSpeed` /
   * `wallTangentSpeed`。法向决定多硬,两者之比决定是擦过还是撞进去。
   */
  play(normalSpeed: number, tangentSpeed: number): void {
    const s = Math.min(1, normalSpeed / AUDIO.impactRefNormalSpeed);
    if (s < AUDIO.impactMinStrength) {
      return;
    }
    const context = this.bus.context;
    const now = context.currentTime;

    /*
     * 磨墙时法向速度会在阈值上下不停抖动,不挡一下就会每几帧放一次 crack,
     * 连成机关枪。持续接触归 `ScrapeNoise` 管,这里只放"一下"。冷却窗口内
     * 只有明显更重的撞击才准打断——否则真的撞重了会被前一下轻碰吃掉。
     */
    if (
      now - this.lastPlayTime < AUDIO.impactRetriggerTime &&
      s < this.lastStrength * AUDIO.impactRetriggerRatio
    ) {
      return;
    }
    this.lastPlayTime = now;
    this.lastStrength = s;

    // 0 = 纯擦过,1 = 纯正面撞。下面每个 lerp(擦过系数, 1, headOn) 在正面撞时
    // 退化成 1,也就是基准值本身。
    const total = normalSpeed + tangentSpeed;
    const headOn = total > 0 ? normalSpeed / total : 1;
    const bodyScale = lerp(AUDIO.impactGrazeBodyScale, 1, headOn);
    const pitchScale = lerp(AUDIO.impactGrazePitchScale, 1, headOn);
    const brightScale = lerp(AUDIO.impactGrazeBrightScale, 1, headOn);
    const durationScale = lerp(AUDIO.impactGrazeDurationScale, 1, headOn);

    // ── 噪声"碎裂":主角。高通留下 crack,包络比车身层更短。 ──
    const noiseDuration =
      lerp(AUDIO.impactNoiseDurationMin, AUDIO.impactNoiseDurationMax, s) * durationScale;

    const noise = context.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.value =
      lerp(AUDIO.impactNoiseHighpassMin, AUDIO.impactNoiseHighpassMax, s) * brightScale;

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
    const duration = lerp(AUDIO.impactDurationMin, AUDIO.impactDurationMax, s) * durationScale;
    const endFreq = lerp(AUDIO.impactToneFreqMin, AUDIO.impactToneFreqMax, s) * pitchScale;

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
    toneGain.gain.setValueAtTime(AUDIO.impactGain * s * bodyScale, now);
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
