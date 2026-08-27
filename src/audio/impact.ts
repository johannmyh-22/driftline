import { AUDIO } from '../game/tuning';
import type { AudioBus } from './context';

/**
 * 撞墙音:一次性的方波脉冲 + 短促指数衰减包络。`strength` 是
 * `Vehicle.wallImpact`(0..1,当帧撞墙强度,没撞是 0)。
 *
 * **事件驱动,不在每帧路径上**——只在真的撞墙那一帧调用一次,新建几个
 * 音频节点用完即扔不违反「每帧不分配对象」的约束(那条约束管的是 60fps
 * 热路径,不是偶发事件)。低频方波和引擎音(锯齿波、更高音域)分开,
 * 撞击听起来是「闷响」而不是「引擎音突然变调」。
 */
export function playImpact(bus: AudioBus, strength: number): void {
  if (strength < AUDIO.impactMinStrength) {
    return;
  }
  const context = bus.context;
  const now = context.currentTime;

  const osc = context.createOscillator();
  osc.type = 'square';
  osc.frequency.value = 55;

  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = AUDIO.impactFilterFreq;

  const gain = context.createGain();
  const peak = AUDIO.impactGain * Math.min(1, strength);
  gain.gain.setValueAtTime(peak, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + AUDIO.impactDuration);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(bus.master);

  osc.start(now);
  osc.stop(now + AUDIO.impactDuration + 0.02);
  osc.addEventListener('ended', () => {
    osc.disconnect();
    filter.disconnect();
    gain.disconnect();
  });
}
