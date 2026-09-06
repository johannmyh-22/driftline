import { lerp } from '../core/mathx';
import type { Rng } from '../core/rng';
import { AUDIO } from '../game/tuning';
import type { AudioBus } from './context';
import { createNoiseBuffer } from './noise';

/**
 * 轮胎尖叫。甩尾/推头时那一声「吱——」。
 *
 * `Vehicle.gripSaturation` 的注释从一开始就写着「给音效和 HUD 用」,但音频层
 * 一直没接过它 —— **甩尾是这个游戏的核心机制,却一直是静音的**,人类反馈
 * 「汽车甩尾也有声音」指的就是这个洞。
 *
 * ## 两个条件必须同时满足
 *
 * 抓地饱和(`gripSaturation` 高 = 轮胎在滑)**且**真的滑出了速度
 * (`|lateralSpeed|` 大)。缺一不可:
 *
 * - 只看饱和度:低速原地打死方向也会满饱和,那时候不该尖叫。
 * - 只看侧滑速度:高速正常过弯本来就有横向速度分量,会一路误触发。
 *
 * ## 音色为什么是高 Q 带通
 *
 * 真实轮胎尖叫是胎面橡胶的「粘-滑」自激振荡,频谱上是一个很窄的共振峰,
 * 有明确音高感,不是宽频噪声。所以 Q 开到 9(比 `ScrapeNoise` 的 5.5 还窄),
 * 中心频率随滑移速度小幅上移 —— 滑得越狠叫得越尖。
 */
export class TireSqueal {
  private readonly source: AudioBufferSourceNode;
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;

  constructor(bus: AudioBus, rng: Rng) {
    this.source = bus.context.createBufferSource();
    this.source.buffer = createNoiseBuffer(bus.context, rng);
    this.source.loop = true;

    this.filter = bus.context.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.frequency.value = AUDIO.skidFilterIdleFreq;
    this.filter.Q.value = AUDIO.skidQ;

    this.gain = bus.context.createGain();
    this.gain.gain.value = 0;

    this.source.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(bus.master);
    this.source.start();
  }

  /**
   * `saturation` = `Vehicle.gripSaturation`(0..1),`lateralSpeed` 是侧滑速度
   * (m/s,正负都可以,这里只用大小)。
   */
  update(saturation: number, lateralSpeed: number, context: AudioContext): void {
    const now = context.currentTime;
    // 饱和度从阈值到 1 重新归一化,阈值以下直接是 0(不是一路淡出)。
    const bite =
      saturation <= AUDIO.skidMinSaturation
        ? 0
        : (saturation - AUDIO.skidMinSaturation) / (1 - AUDIO.skidMinSaturation);
    const slip = Math.min(1, Math.abs(lateralSpeed) / AUDIO.skidRefSlip);
    const amount = Math.min(1, bite * slip);

    this.filter.frequency.setTargetAtTime(
      lerp(AUDIO.skidFilterIdleFreq, AUDIO.skidFilterMaxFreq, slip),
      now,
      AUDIO.skidSmoothing,
    );
    this.gain.gain.setTargetAtTime(AUDIO.skidMaxGain * amount, now, AUDIO.skidSmoothing);
  }

  dispose(): void {
    this.source.stop();
    this.source.disconnect();
    this.filter.disconnect();
    this.gain.disconnect();
  }
}
