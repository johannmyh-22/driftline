import { clamp, lerp } from '../core/mathx';
import type { Rng } from '../core/rng';
import { AUDIO } from '../game/tuning';
import type { AudioBus } from './context';
import { createNoiseBuffer } from './noise';

/**
 * 引擎音:一个自定义谐波谱的振荡器(排气声部)+ 一层窄带噪声(排气粗糙度),
 * 两路都过随"转速代理"调制的滤波器,不是采样循环。
 *
 * 频率/滤波截止/音量都按"转速代理"(`rpm01`,车速与油门的加权混合,见
 * `update()`)线性映射,松油门时音量回落但不到零(滑行时引擎还在转,只是
 * 不再推)。这不是真实发动机转速表——这台车没有变速箱模型,目标只是「踩深
 * 油门音调会往上走、松油门音调会掉」这个直觉,和 M3 视觉方向那条「材质/光照
 * 按实拍要求,造型受限于程序化生成」是同一个判断标准的音频版本。
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
 */
export class EngineSound {
  private readonly osc: OscillatorNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly noiseFilter: BiquadFilterNode;
  private readonly noiseGain: GainNode;

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

  /** `speed01`/`throttle` 都是 0..1。每个固定步调一次,和物理同频率。 */
  update(speed01: number, throttle: number, context: AudioContext): void {
    const rpm01 = clamp(
      speed01 * AUDIO.engineSpeedTrack + throttle * AUDIO.engineThrottleTrack,
      0,
      1,
    );
    const targetFreq = lerp(AUDIO.engineIdleFreq, AUDIO.engineMaxFreq, rpm01);
    const targetFilter = lerp(AUDIO.engineFilterIdleFreq, AUDIO.engineFilterMaxFreq, rpm01);
    // 松油门滑行时音量降到 30%,不是静音——引擎还在转。
    const throttleFactor = 0.3 + 0.7 * throttle;
    const targetGain = lerp(AUDIO.engineIdleGain, AUDIO.engineMaxGain, rpm01) * throttleFactor;
    const targetNoiseFilter = lerp(
      AUDIO.engineNoiseFilterIdleFreq,
      AUDIO.engineNoiseFilterMaxFreq,
      rpm01,
    );
    const targetNoiseGain =
      lerp(AUDIO.engineNoiseIdleGain, AUDIO.engineNoiseMaxGain, rpm01) * throttleFactor;

    const now = context.currentTime;
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
