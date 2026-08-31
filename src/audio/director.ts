import type { InputFrame } from '../core/input';
import { normalize01 } from '../core/mathx';
import type { Rng } from '../core/rng';
import { GEARBOX, REFERENCE_TOP_SPEED } from '../game/tuning';
import type { Vehicle } from '../game/vehicle';
import { AudioBus } from './context';
import { EngineSound } from './engine';
import { ImpactPlayer } from './impact';
import { ScrapeNoise } from './scrape';
import { TireSqueal } from './skid';
import { SurfaceNoise } from './surface';
import { playUiClick } from './ui';
import { WindNoise } from './wind';

/**
 * 音频总控。持有唯一的 `AudioContext`/`AudioBus`,拼装引擎音 + 气流噪声
 * 两个持续声源;UI 音是一次性的,不需要长期持有实例(见 `ui.ts` 的类
 * 注释)。撞击音(`ImpactPlayer`)虽然也是事件驱动,但要预生成噪声缓冲
 * (见 `impact.ts` 的类注释),所以和引擎/气流一样长期持有一个实例。
 *
 * 六个消费者各 `rng.fork()` 一份:引擎的排气粗糙度层、气流、撞击、刮擦、
 * 轮胎尖叫、出界地面噪声都要预生成自己的噪声缓冲,共用同一条随机数流的话,任何一处改了取数个数都会连带改掉
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
  private readonly squeal: TireSqueal;
  private readonly surface: SurfaceNoise;
  /** 上一帧是否接地,用来抓「落地」这个瞬间。 */
  private wasGrounded = true;

  constructor(rng: Rng) {
    this.bus = new AudioBus();
    this.engine = new EngineSound(this.bus, rng.fork());
    this.wind = new WindNoise(this.bus, rng.fork());
    this.impact = new ImpactPlayer(this.bus, rng.fork());
    this.scrape = new ScrapeNoise(this.bus, rng.fork());
    this.squeal = new TireSqueal(this.bus, rng.fork());
    this.surface = new SurfaceNoise(this.bus, rng.fork());
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
    /*
     * 引擎音读**物理变速箱**的真转速与真挡位,不再按车速自己编一套。
     * `speed01` 会在 217 km/h 以上饱和(参考极速 60.3 m/s,实际能跑到 68.9),
     * 拿它当转速代理的话一大半时间音调是冻住的 —— 见 `engine.ts` 的类注释。
     * 气流和地面噪声仍然用 `speed01`:它们本来就该跟车速走,饱和了也无所谓。
     */
    const rpm01 = normalize01(vehicle.gearbox.rpm, GEARBOX.idleRpm, GEARBOX.redlineRpm);
    this.engine.update(rpm01, vehicle.gearbox.gear, input.throttle, this.bus.context);
    this.wind.update(speed01, this.bus.context);
    // 撞击是事件、刮擦是状态,两条独立喂:正面撞进去只出 crack,贴着墙磨过去
    // 只出刮擦,斜着撞两个都有——这正是"碰撞分好几种"要的效果。
    this.scrape.update(vehicle.wallTangentSpeed, this.bus.context);
    if (vehicle.wallNormalSpeed > 0) {
      this.impact.play(vehicle.wallNormalSpeed, vehicle.wallTangentSpeed);
    }

    // 甩尾:抓地饱和 + 真的滑出速度,两个条件都在 TireSqueal 里判。
    this.squeal.update(vehicle.gripSaturation, vehicle.lateralSpeed, this.bus.context);
    // 出界:压在土石上的滚动噪声,和气流音色刻意分开。
    this.surface.update(!vehicle.onTrack, speed01, this.bus.context);

    // 落地:只在「上一帧腾空、这一帧接地」的那一瞬间放一次。用垂直速度定
    // 强度 —— 轻轻压过路肩和从跳台砸下来不该是同一声。
    if (vehicle.grounded && !this.wasGrounded) {
      this.impact.playLanding(Math.max(0, -vehicle.velocity.y));
    }
    this.wasGrounded = vehicle.grounded;
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
    this.squeal.dispose();
    this.surface.dispose();
    this.bus.dispose();
  }
}
