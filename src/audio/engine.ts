import { clamp, lerp } from '../core/mathx';
import type { Rng } from '../core/rng';
import { AUDIO } from '../game/tuning';
import type { AudioBus } from './context';
import { createNoiseBuffer } from './noise';

/**
 * 引擎音:一个自定义谐波谱的振荡器(排气声部)+ 一层窄带噪声(排气粗糙度),
 * 两路都过随"转速代理"调制的滤波器,不是采样循环。
 *
 * 频率/滤波截止/音量都按 `drive`(物理转速与油门的加权混合,见 `update()`)
 * 线性映射,松油门时音量回落但不到零(滑行时引擎还在转,只是不再推)。
 * 转速本身现在是物理变速箱算出来的真转速(见下面「转速来自物理变速箱」),
 * 混进油门是为了「定速滑行时深踩油门也该有反应」。
 *
 * ## 为什么是谐波表 + 噪声,而不是"两个失谐振荡器"
 *
 * 上一版用主锯齿波 + 一个按 1.008 失谐的副锯齿波叠加来"增厚",人类实际听过
 * 之后反馈**颤音/干涉感**。这是确诊不是猜:两个频率相近的音源叠加必然产生
 * 拍频,拍频速率就是两者的频率差,1.008 × 62Hz 的差是每秒约 0.5 次——正好
 * 落在人耳对振幅调制最敏感的区间。那是给合成器 pad 用的技巧,引擎音不能用。
 *
 * 换掉之后,"厚度"由两件本来就该干这件事的东西提供:
 *
 * - **谐波堆叠**(`AUDIO.engineHarmonics` → `PeriodicWave`):所有分量都是
 *   基频的严格整数倍,彼此锁相,叠加只改变波形不产生拍频。表本身是不单调的,
 *   模拟排气管驻波,避开锯齿波那种 1/n 平滑衰减的"合成器测试音"频谱。
 * - **窄带噪声**:真实发动机每个工作循环都有湍流和燃烧的随机差异,纯周期
 *   波形永远缺这一块。这才是失谐振荡器本来想解决的问题的正确解法。
 *
 * ## 转速来自物理变速箱,不再自己编
 *
 * 这里曾经有一套**音频专用的假变速箱**:读归一化车速 `speed01`,自己算挡位,
 * 造出转速锯齿。它在物理层还没有变速箱的时候是合理的,但 `game/gearbox.ts`
 * 落地之后就变成了「两套互不相干的挡位」,而且假的那套是错的 —— 实测它
 * **86% 的时间卡在六挡不动**。
 *
 * 原因是 `speed01 = groundSpeed / REFERENCE_TOP_SPEED` 会**饱和**:参考极速
 * 是 60.3 m/s,而车实际能跑到 68.9(`maxSpin` 给的上限是 1.15 倍),所以只要
 * 超过 217 km/h,speed01 就恒等于 1。实测跑三个 seed 各 200 秒,车速中位数
 * 65.9 m/s —— **一大半时间 speed01 都钉在 1.0 上,音调、挡位、换挡声全部
 * 冻住**。人类反馈的「听不出转速变化」「没听到换挡」就是这么来的,一个是
 * 音色问题都不是。
 *
 * 现在直接读物理变速箱的 `rpm` 与 `gear`(由 `AudioDirector` 归一化后传进来):
 *
 * - 转速范围是真的:实测常规驾驶 rpm 在 4400~6950 之间来回走(怠速 900、
 *   红线 7200),音调跟着扫,不再是一条直线。
 * - 换挡声和**真的换挡**同一帧,不会各响各的。物理换挡本来就切 0.14 秒动力,
 *   声音那一下断油正好对上。
 */
export class EngineSound {
  private readonly osc: OscillatorNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly noiseFilter: BiquadFilterNode;
  private readonly noiseGain: GainNode;
  /** 上一帧的挡位,用来抓「换挡了」这个瞬间。−1 = 还没收到过。 */
  private lastGear = -1;
  /** 换挡断油持续到的绝对时间(`context.currentTime` 同一时基),没在换挡就是 0。 */
  private shiftCutUntil = 0;

  constructor(bus: AudioBus, rng: Rng) {
    const context = bus.context;

    // real 全零、imag 放谐波幅度 = 一组纯正弦分量的叠加。首项必须是直流,
    // 恒为 0,所以谐波表整体后移一位。
    const harmonics = AUDIO.engineHarmonics;
    const real = new Float32Array(harmonics.length + 1);
    const imag = new Float32Array(harmonics.length + 1);
    for (let i = 0; i < harmonics.length; i++) {
      imag[i + 1] = harmonics[i] ?? 0;
    }

    this.osc = context.createOscillator();
    this.osc.setPeriodicWave(context.createPeriodicWave(real, imag));
    this.osc.frequency.value = AUDIO.engineIdleFreq;

    this.filter = context.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = AUDIO.engineFilterIdleFreq;

    this.gain = context.createGain();
    this.gain.gain.value = 0;

    this.osc.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(bus.master);
    this.osc.start();

    // 噪声缓冲和 `WindNoise` 一样构造时预生成一次后循环播放,不在每帧路径上
    // 造随机数据(见 `noise.ts` 的注释)。
    this.noise = context.createBufferSource();
    this.noise.buffer = createNoiseBuffer(context, rng);
    this.noise.loop = true;

    this.noiseFilter = context.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = AUDIO.engineNoiseFilterIdleFreq;
    this.noiseFilter.Q.value = AUDIO.engineNoiseQ;

    this.noiseGain = context.createGain();
    this.noiseGain.gain.value = 0;

    this.noise.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(bus.master);
    this.noise.start();
  }

  /**
   * `rpm01` 是物理变速箱的转速归一化到怠速..红线(0..1),`gear` 是它的挡位
   * 下标,`throttle` 是 0..1。每个固定步调一次,和物理同频率。
   */
  update(rpm01: number, gear: number, throttle: number, context: AudioContext): void {
    const now = context.currentTime;
    // 升挡才断油;降挡在真车上是补油,这里不做,免得听起来像卡顿。
    if (this.lastGear >= 0 && gear > this.lastGear) {
      this.shiftCutUntil = now + AUDIO.engineShiftCutTime;
    }
    this.lastGear = gear;

    const drive = clamp(
      clamp(rpm01, 0, 1) * AUDIO.engineSpeedTrack + throttle * AUDIO.engineThrottleTrack,
      0,
      1,
    );
    const targetFreq = lerp(AUDIO.engineIdleFreq, AUDIO.engineMaxFreq, drive);
    const targetFilter = lerp(AUDIO.engineFilterIdleFreq, AUDIO.engineFilterMaxFreq, drive);
    // 松油门滑行时音量降到 30%,不是静音——引擎还在转。
    const throttleFactor = 0.3 + 0.7 * throttle;
    // 换挡那一下离合器切断动力,音量短暂塌下去——没有这一下,转速掉下来只会
    // 像是松了油门,不像换挡。
    const shiftCut = now < this.shiftCutUntil ? AUDIO.engineShiftCutGain : 1;
    const targetGain =
      lerp(AUDIO.engineIdleGain, AUDIO.engineMaxGain, drive) * throttleFactor * shiftCut;
    const targetNoiseFilter = lerp(
      AUDIO.engineNoiseFilterIdleFreq,
      AUDIO.engineNoiseFilterMaxFreq,
      drive,
    );
    const targetNoiseGain =
      lerp(AUDIO.engineNoiseIdleGain, AUDIO.engineNoiseMaxGain, drive) * throttleFactor;

    this.osc.frequency.setTargetAtTime(targetFreq, now, AUDIO.engineSmoothing);
    this.filter.frequency.setTargetAtTime(targetFilter, now, AUDIO.engineSmoothing);
    this.gain.gain.setTargetAtTime(targetGain, now, AUDIO.engineSmoothing);
    this.noiseFilter.frequency.setTargetAtTime(targetNoiseFilter, now, AUDIO.engineSmoothing);
    this.noiseGain.gain.setTargetAtTime(targetNoiseGain, now, AUDIO.engineSmoothing);
  }

  dispose(): void {
    this.osc.stop();
    this.osc.disconnect();
    this.filter.disconnect();
    this.gain.disconnect();
    this.noise.stop();
    this.noise.disconnect();
    this.noiseFilter.disconnect();
    this.noiseGain.disconnect();
  }
}
