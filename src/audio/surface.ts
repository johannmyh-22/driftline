import type { Rng } from '../core/rng';
import { AUDIO } from '../game/tuning';
import type { AudioBus } from './context';
import { createNoiseBuffer } from './noise';

/**
 * 出界地面噪声:冲出赛道压在土石上的滚动轰隆。
 *
 * 和气流(`WindNoise`)刻意分开音色:气流是宽频呼啸,这个低通得狠得多
 * (`surfaceFilterFreq` 380Hz),**出界要听起来「变粗糙」而不是「变吵」**。
 * 只在离开路面时出声,回到柏油上立刻掉下去。
 */
export class SurfaceNoise {
  private readonly source: AudioBufferSourceNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;

  constructor(bus: AudioBus, rng: Rng) {
    this.source = bus.context.createBufferSource();
    this.source.buffer = createNoiseBuffer(bus.context, rng);
    this.source.loop = true;

    this.filter = bus.context.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = AUDIO.surfaceFilterFreq;
    this.filter.Q.value = AUDIO.surfaceQ;

    this.gain = bus.context.createGain();
    this.gain.gain.value = 0;

    this.source.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(bus.master);
    this.source.start();
  }

  /** `offTrack` = 是否在赛道外,`speed01` 是 0..1 归一化车速。 */
  update(offTrack: boolean, speed01: number, context: AudioContext): void {
    const target = offTrack ? AUDIO.surfaceMaxGain * Math.min(1, speed01) : 0;
    this.gain.gain.setTargetAtTime(target, context.currentTime, AUDIO.surfaceSmoothing);
  }

  dispose(): void {
    this.source.stop();
    this.source.disconnect();
    this.filter.disconnect();
    this.gain.disconnect();
  }
}
