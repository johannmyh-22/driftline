import type { TrackLayout } from './trackLayout';
import { TRACK } from './tuning';
import type { Vehicle } from './vehicle';

/**
 * 出界回收:一辆车在赛道外待够久就把它放回赛道上。
 *
 * **为什么单独拆出来**:这套逻辑原本长在 `Race` 里,而 `Race` 是玩家专属的
 * (它还管圈速、分段 delta、纪录持久化)。M7 加了对手车之后,`World` 只把
 * 玩家传给 `Race.update()`,于是**对手车出界之后没有任何东西会把它拉回来**
 * —— 被撞出赛道就永远躺在山坡上,而名次表还在认真统计它。拆成这个类之后
 * 每辆车各持有一份,谁出界谁被拉回来。
 *
 * `Race` 现在也用它,行为保持逐位一致:宽限时间、判定条件、`resets` 计数
 * 全部原样搬过来,只是换了个位置。
 */
export class TrackRecovery {
  /** 连续在界外待了多久(秒)。 */
  offTrackTime = 0;
  /** 累计被拉回来几次。 */
  resets = 0;

  private readonly layout: TrackLayout;

  constructor(layout: TrackLayout) {
    this.layout = layout;
  }

  reset(): void {
    this.offTrackTime = 0;
    this.resets = 0;
  }

  /**
   * 每个固定步调一次。`respawnArc` 是要被放回去的弧长位置(米)——玩家用
   * 「最近通过的检查点」(不许靠出界抄近道),对手用「它自己当前的弧长」
   * (AI 不刷成绩,原地扶起来就行,送回检查点反而是平白惩罚)。
   *
   * 返回这一帧是否真的把车放回去了。
   */
  update(vehicle: Vehicle, dt: number, respawnArc: number): boolean {
    const outside =
      !vehicle.onTrack &&
      Math.abs(vehicle.lateral) > this.layout.halfWidth + TRACK.outOfBoundsMargin;

    if (!outside) {
      this.offTrackTime = 0;
      return false;
    }

    this.offTrackTime += dt;
    // 给一段宽限时间:压出路肩、飞出去再落回来都不该被立刻拽走,
    // 那种「刚出界就传送」的处理比出界本身更破坏手感。
    if (this.offTrackTime < TRACK.outOfBoundsGrace) {
      return false;
    }

    this.respawn(vehicle, respawnArc);
    return true;
  }

  /** 把载具放回指定弧长处的赛道中心线,速度清零、车头朝赛道方向。 */
  respawn(vehicle: Vehicle, respawnArc: number): void {
    const samples = this.layout.samples;
    if (samples.length === 0) {
      return;
    }
    const index = Math.floor(respawnArc / this.layout.spacing);
    const sample = samples[((index % samples.length) + samples.length) % samples.length];
    if (sample === undefined) {
      return;
    }
    vehicle.reset(sample.x, sample.z, Math.atan2(sample.tangentX, sample.tangentZ));
    this.offTrackTime = 0;
    this.resets++;
  }
}
