import type { InputFrame } from '../core/input';
import { normalize01 } from '../core/mathx';
import type { Rng } from '../core/rng';
import { REFERENCE_TOP_SPEED } from '../game/tuning';
import type { Vehicle } from '../game/vehicle';
import { AudioBus } from './context';
import { EngineSound } from './engine';
import { playImpact } from './impact';
import { playUiClick } from './ui';
import { WindNoise } from './wind';

/**
 * 音频总控。持有唯一的 `AudioContext`/`AudioBus`,拼装引擎音 + 气流噪声
 * 两个持续声源;撞击音/UI 音是一次性的,不需要长期持有实例(见
 * `impact.ts`/`ui.ts` 的类注释)。
 *
 * 和 `Hud`/`Menu` 一样,测试模式下不构造这个类——`?test=1` 下没有真实
 * 用户手势,`AudioContext` 也起不来,构造了也是白白多一个悬空的音频图。
 */
export class AudioDirector {
  private readonly bus: AudioBus;
  private readonly engine: EngineSound;
  private readonly wind: WindNoise;

  constructor(rng: Rng) {
    this.bus = new AudioBus();
    this.engine = new EngineSound(this.bus);
    this.wind = new WindNoise(this.bus, rng);
  }

  /** 浏览器自动播放策略要求先有一次用户手势才能出声,`main.ts` 在首次按键/点击时调用。 */
  resume(): void {
    this.bus.resume();
  }

  /** 每个固定步调一次,和物理同频率——引擎/气流的参数平滑内建在节点自己的 setTargetAtTime 里。 */
  update(vehicle: Vehicle, input: InputFrame): void {
    const speed01 = normalize01(vehicle.groundSpeed, 0, REFERENCE_TOP_SPEED);
    this.engine.update(speed01, input.throttle, this.bus.context);
    this.wind.update(speed01, this.bus.context);
    if (vehicle.wallImpact > 0) {
      playImpact(this.bus, vehicle.wallImpact);
    }
  }

  triggerUiClick(): void {
    playUiClick(this.bus);
  }

  get masterVolume(): number {
    return this.bus.currentVolume;
  }

  setMasterVolume(volume: number): void {
    this.bus.setVolume(volume);
  }

  get muted(): boolean {
    return this.bus.isMuted;
  }

  setMuted(muted: boolean): void {
    this.bus.setMuted(muted);
  }

  dispose(): void {
    this.engine.dispose();
    this.wind.dispose();
    this.bus.dispose();
  }
}
