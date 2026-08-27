import { lerp } from '../core/mathx';
import type { Rng } from '../core/rng';
import { AUDIO } from '../game/tuning';
import type { AudioBus } from './context';
import { createNoiseBuffer } from './noise';

/**
 * 气流噪声:一段预生成的白噪声循环过低通滤波器,音量和滤波截止频率都
 * 随速度涨——静止时几乎听不见,高速时呼啸声压过引擎音,这是速度感的
 * 另一半来源(引擎音管的是「油门给了多少」,气流管的是「跑多快」)。
 */
export class WindNoise {
  private readonly source: AudioBufferSourceNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;

  constructor(bus: AudioBus, rng: Rng) {
    this.source = bus.context.createBufferSource();
    this.source.buffer = createNoiseBuffer(bus.context, rng);
    this.source.loop = true;

    this.filter = bus.context.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = AUDIO.windFilterIdleFreq;

    this.gain = bus.context.createGain();
    this.gain.gain.value = 0;

    this.source.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(bus.master);
    this.source.start();
  }

  /** `speed01` 是 0..1 归一化车速。 */
  update(speed01: number, context: AudioContext): void {
    const now = context.currentTime;
    const targetFilter = lerp(AUDIO.windFilterIdleFreq, AUDIO.windFilterMaxFreq, speed01);
    this.filter.frequency.setTargetAtTime(targetFilter, now, AUDIO.windSmoothing);
    this.gain.gain.setTargetAtTime(AUDIO.windMaxGain * speed01, now, AUDIO.windSmoothing);
  }

  dispose(): void {
    this.source.stop();
    this.source.disconnect();
    this.filter.disconnect();
    this.gain.disconnect();
  }
}
