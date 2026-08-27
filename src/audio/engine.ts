import { lerp } from '../core/mathx';
import { AUDIO } from '../game/tuning';
import type { AudioBus } from './context';

/**
 * 引擎音:锯齿波过一个随速度调制的低通滤波器,不是采样循环。
 *
 * 频率/滤波截止/音量三个参数都按参考极速线性映射,松油门时音量回落但
 * 不到零(滑行时引擎还在转,只是不再推)。这不是真实发动机转速表——这台
 * 车没有变速箱模型,目标只是「踩深油门音调会往上走」这个直觉,和 M3
 * 视觉方向那条「材质/光照按实拍要求,造型受限于程序化生成」是同一个
 * 判断标准的音频版本。
 */
export class EngineSound {
  private readonly osc: OscillatorNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;

  constructor(bus: AudioBus) {
    this.osc = bus.context.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = AUDIO.engineIdleFreq;

    this.filter = bus.context.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = AUDIO.engineFilterIdleFreq;

    this.gain = bus.context.createGain();
    this.gain.gain.value = 0;

    this.osc.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(bus.master);
    this.osc.start();
  }

  /** `speed01`/`throttle` 都是 0..1。每个固定步调一次,和物理同频率。 */
  update(speed01: number, throttle: number, context: AudioContext): void {
    const targetFreq = lerp(AUDIO.engineIdleFreq, AUDIO.engineMaxFreq, speed01);
    const targetFilter = lerp(AUDIO.engineFilterIdleFreq, AUDIO.engineFilterMaxFreq, speed01);
    // 松油门滑行时音量降到 30%,不是静音——引擎还在转。
    const throttleFactor = 0.3 + 0.7 * throttle;
    const targetGain = lerp(AUDIO.engineIdleGain, AUDIO.engineMaxGain, speed01) * throttleFactor;

    const now = context.currentTime;
    this.osc.frequency.setTargetAtTime(targetFreq, now, AUDIO.engineSmoothing);
    this.filter.frequency.setTargetAtTime(targetFilter, now, AUDIO.engineSmoothing);
    this.gain.gain.setTargetAtTime(targetGain, now, AUDIO.engineSmoothing);
  }

  dispose(): void {
    this.osc.stop();
    this.osc.disconnect();
    this.filter.disconnect();
    this.gain.disconnect();
  }
}
