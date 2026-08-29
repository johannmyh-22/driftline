import type { InputFrame } from '../core/input';
import { normalize01 } from '../core/mathx';
import type { Rng } from '../core/rng';
import { REFERENCE_TOP_SPEED } from '../game/tuning';
import type { Vehicle } from '../game/vehicle';
import { AudioBus } from './context';
import { EngineSound } from './engine';
import { ImpactPlayer } from './impact';
import { ScrapeNoise } from './scrape';
import { playUiClick } from './ui';
import { WindNoise } from './wind';

/**
 * 音频总控。持有唯一的 `AudioContext`/`AudioBus`,拼装引擎音 + 气流噪声
 * 两个持续声源;UI 音是一次性的,不需要长期持有实例(见 `ui.ts` 的类
 * 注释)。撞击音(`ImpactPlayer`)虽然也是事件驱动,但要预生成噪声缓冲
 * (见 `impact.ts` 的类注释),所以和引擎/气流一样长期持有一个实例。
 *
 * 四个消费者各 `rng.fork()` 一份:引擎的排气粗糙度层、气流、撞击、刮擦都要
 * 预生成自己的噪声缓冲,共用同一条随机数流的话,任何一处改了取数个数都会连带改掉
 * 另外两处的缓冲内容。
 *
 * 和 `Hud`/`Menu` 一样,测试模式下不构造这个类——`?test=1` 下没有真实
 * 用户手势,`AudioContext` 也起不来,构造了也是白白多一个悬空的音频图。
 */
export class AudioDirector {
  private readonly bus: AudioBus;
  private readonly engine: EngineSound;
  private readonly wind: WindNoise;
  private readonly impact: ImpactPlayer;
  private readonly scrape: ScrapeNoise;

  constructor(rng: Rng) {
    this.bus = new AudioBus();
    this.engine = new EngineSound(this.bus, rng.fork());
    this.wind = new WindNoise(this.bus, rng.fork());
    this.impact = new ImpactPlayer(this.bus, rng.fork());
    this.scrape = new ScrapeNoise(this.bus, rng.fork());
  }

  /** 浏览器自动播放策略要求先有一次用户手势才能出声,`main.ts` 在每次手势时调用直到真的跑起来。 */
  resume(): void {
    this.bus.resume();
  }

  /** 音频上下文是否真的在跑(不是"没被 suspend",见 `AudioBus.resume()` 的注释)。 */
  get isRunning(): boolean {
    return this.bus.isRunning;
  }

  /** 每个固定步调一次,和物理同频率——引擎/气流的参数平滑内建在节点自己的 setTargetAtTime 里。 */
  update(vehicle: Vehicle, input: InputFrame): void {
    const speed01 = normalize01(vehicle.groundSpeed, 0, REFERENCE_TOP_SPEED);
    this.engine.update(speed01, input.throttle, this.bus.context);
    this.wind.update(speed01, this.bus.context);
    // 撞击是事件、刮擦是状态,两条独立喂:正面撞进去只出 crack,贴着墙磨过去
    // 只出刮擦,斜着撞两个都有——这正是"碰撞分好几种"要的效果。
    this.scrape.update(vehicle.wallTangentSpeed, this.bus.context);
    if (vehicle.wallNormalSpeed > 0) {
      this.impact.play(vehicle.wallNormalSpeed, vehicle.wallTangentSpeed);
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
    this.scrape.dispose();
    this.bus.dispose();
  }
}
