import { clamp } from '../core/mathx';
import { FUEL, GEARBOX } from './tuning';

/**
 * 油箱(B3,人类 2026-09 批准)。
 *
 * ## 主要机制是**质量**,不是"会不会开到没油"
 *
 * 名字叫「燃油载荷」不是「燃油耗尽」——真实赛车里燃油最直接的影响是**它是
 * 一坨会变轻的配重**:满油起步的车加速更慢、刹车更晚、过弯载荷更大,跑到
 * 后段轻下来,单圈自然变快。排位赛之所以要空油箱跑,就是这个。
 *
 * 所以这里的重点是把质量老老实实喂给物理(`Vehicle` 每步更新刚体质量),
 * 而不是搞一个"油尽熄火"的惩罚机制。**耗尽也做了**(见 `dry`),但它是
 * 余量没留够的后果,不是主玩法。
 *
 * ## 起步带多少油
 *
 * 按**赛程 + 余量**算,不是灌满一箱 —— 真实车队就是这么做的,灌满等于白背
 * 几十公斤。`FUEL.reserveLaps` 就是那点余量。所以圈数改了油量会自己跟着变。
 *
 * ## 消耗跟发动机负荷走,不跟时间走
 *
 * 和轮胎磨损跟滑移功率走是同一条思路:全油门高转的时候烧得快,收油滑行几乎
 * 不烧。这样「收油滑行省油」才成立,而那是真实的省油开法。
 */
export class FuelTank {
  /** 当前油量(升)。 */
  litres: number;
  /**
   * 这一段行程加了多少油(升)。**HUD 的油量条以它为分母,不是箱容。**
   *
   * 箱容 60 L 而按赛程只加 4.5 L,拿箱容当分母的话油量条一开局就是红的、
   * 全程贴着底 —— 玩家看到的是"我快没油了",而实际上余量有 30%。分母该是
   * "这趟带了多少",玩家关心的从来是"还剩几分之几",不是"油箱空了多少"。
   */
  private reference: number;

  constructor(litres: number = FUEL.startLitres) {
    this.litres = clamp(litres, 0, FUEL.tankLitres);
    this.reference = Math.max(this.litres, 1e-6);
  }

  /** 当前燃油质量(千克)。 */
  get massKg(): number {
    return this.litres * FUEL.densityKgPerLitre;
  }

  /** 相对**这趟加的油**的剩余比例 0..1,给 HUD 用。分母的理由见 `reference`。 */
  get fraction(): number {
    return clamp(this.litres / this.reference, 0, 1);
  }

  /** 相对箱容的比例。调试/遥测用,不进 HUD。 */
  get tankFraction(): number {
    return FUEL.tankLitres <= 0 ? 0 : clamp(this.litres / FUEL.tankLitres, 0, 1);
  }

  /** 是否已经没油。没油时 `Vehicle` 把驱动力矩清零 —— 发动机不转了。 */
  get dry(): boolean {
    return this.litres <= 0;
  }

  /**
   * 每个固定步调一次。`rpm` 是物理变速箱的发动机转速,`throttle` 是 0..1。
   *
   * 怠速那一份不受油门影响 —— 发动机转着就在烧,这正是"堵在维修区里也在
   * 掉油"的来源。
   */
  burn(dt: number, throttle: number, rpm: number): void {
    if (this.litres <= 0) {
      return;
    }
    const rpm01 = clamp(
      (rpm - GEARBOX.idleRpm) / Math.max(1, GEARBOX.redlineRpm - GEARBOX.idleRpm),
      0,
      1,
    );
    const flow = FUEL.idleFlowPerSecond + FUEL.peakFlowPerSecond * clamp(throttle, 0, 1) * rpm01;
    this.litres = Math.max(0, this.litres - flow * dt);
  }

  /** 加油。进站用,加满到 `litres` 或箱容上限。 */
  refill(litres: number = FUEL.tankLitres): void {
    this.litres = clamp(litres, 0, FUEL.tankLitres);
    this.reference = Math.max(this.litres, 1e-6);
  }

  reset(litres: number = FUEL.startLitres): void {
    this.litres = clamp(litres, 0, FUEL.tankLitres);
    this.reference = Math.max(this.litres, 1e-6);
  }
}

/**
 * 按赛程算起步油量(升)。
 *
 * 单独一个函数是为了能单测,也为了「圈数改了油量自己跟着变」这条是明写的
 * 而不是散在某个构造函数里。
 */
export function raceFuelLitres(lapCount: number, lapDistanceMetres: number): number {
  const perLap = lapDistanceMetres / 1000 / FUEL.kmPerLitre;
  return clamp(perLap * (lapCount + FUEL.reserveLaps), 0, FUEL.tankLitres);
}
