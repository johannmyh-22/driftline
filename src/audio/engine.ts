import { clamp, lerp } from '../core/mathx';
import { AUDIO } from '../game/tuning';
import type { AudioBus } from './context';

/**
 * 引擎音:两个略微失谐的锯齿波叠加,过一个随"转速代理"调制的低通滤波器,
 * 不是采样循环。
 *
 * 频率/滤波截止/音量三个参数都按"转速代理"(`rpm01`,车速与油门的加权
 * 混合,见 `update()`)线性映射,松油门时音量回落但不到零(滑行时引擎还在
 * 转,只是不再推)。这不是真实发动机转速表——这台车没有变速箱模型,目标
 * 只是「踩深油门音调会往上走、松油门音调会掉」这个直觉,和 M3 视觉方向那条
 * 「材质/光照按实拍要求,造型受限于程序化生成」是同一个判断标准的音频版本。
 *
 * 早期版本频率只跟车速走,油门只影响音量——定速滑行深踩油门只会变响、
 * 音调不变,松油门高速滑行音调也不会掉,人耳听感反馈"不跟给油联动"。
 * 现在转速代理由车速和油门加权混合(`AUDIO.engineSpeedTrack`/
 * `engineThrottleTrack`),两个权重加起来等于 1,车速与油门都拉满时行为
 * 和原来的顶速情况对齐。
 */
export class EngineSound {
  private readonly osc: OscillatorNode;
  private readonly oscDetune: OscillatorNode;
  private readonly detuneGain: GainNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;

  constructor(bus: AudioBus) {
    this.osc = bus.context.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = AUDIO.engineIdleFreq;

    // 第二个振荡器和主振荡器频率相近但不同,叠加出拍频,单个纯振荡器太像
    // 合成器测试音,不像发动机的多缸声部叠加。
    this.oscDetune = bus.context.createOscillator();
    this.oscDetune.type = 'sawtooth';
    this.oscDetune.frequency.value = AUDIO.engineIdleFreq * AUDIO.engineDetuneRatio;

    this.detuneGain = bus.context.createGain();
    this.detuneGain.gain.value = AUDIO.engineDetuneMix;

    this.filter = bus.context.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = AUDIO.engineFilterIdleFreq;

    this.gain = bus.context.createGain();
    this.gain.gain.value = 0;

    this.osc.connect(this.filter);
    this.oscDetune.connect(this.detuneGain);
    this.detuneGain.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(bus.master);
    this.osc.start();
    this.oscDetune.start();
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

    const now = context.currentTime;
    this.osc.frequency.setTargetAtTime(targetFreq, now, AUDIO.engineSmoothing);
    this.oscDetune.frequency.setTargetAtTime(
      targetFreq * AUDIO.engineDetuneRatio,
      now,
      AUDIO.engineSmoothing,
    );
    this.filter.frequency.setTargetAtTime(targetFilter, now, AUDIO.engineSmoothing);
    this.gain.gain.setTargetAtTime(targetGain, now, AUDIO.engineSmoothing);
  }

  dispose(): void {
    this.osc.stop();
    this.osc.disconnect();
    this.oscDetune.stop();
    this.oscDetune.disconnect();
    this.detuneGain.disconnect();
    this.filter.disconnect();
    this.gain.disconnect();
  }
}
