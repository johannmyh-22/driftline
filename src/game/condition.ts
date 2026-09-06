import { clamp } from '../core/mathx';
import { CONDITION } from './tuning';

/**
 * 车况:轮胎磨损、刹车热衰、碰撞损伤。
 *
 * ## 为什么三样都从 0 开始
 *
 * 它们是**累积量**,一局开始时全是 0,三个缩放系数全是 1 —— 所以加这套系统
 * 之前和之后,第一圈的车逐位一样。CLAUDE.md 里已验收的手感(峰值侧向
 * 1.3~1.6 g、甩尾稳态侧滑角)是在新胎冷刹的车上验的,那条基线不受影响,
 * 衰减是随着比赛推进才出现的。
 *
 * ## 磨损速率跟滑移功率走,不跟时间走
 *
 * 真实轮胎不是按秒磨的,是按「滑着走了多少」磨的。这里用
 * `抓地饱和度 × 车速` 当滑移功率的代理:贴着极限开磨得快,顺顺当当开磨得
 * 慢。这也是真实轮胎管理的核心 —— 会开的人能让胎多撑几圈,而不是所有人
 * 一样掉。
 *
 * ## 损伤不可修复
 *
 * `Vehicle.reset()`(出界回收)**不清车况**:把车扶回赛道是回收,不是修车。
 * 一局结束重开才清,由 `World.spawnAtStart()` 显式调 `reset()`。
 */
export class CarCondition {
  /** 轮胎磨损 0..1。1 = 磨到底。 */
  tireWear = 0;
  /** 刹车温度 0..1。1 = 热到底。 */
  brakeHeat = 0;
  /** 车体损伤 0..1。1 = 最惨。 */
  damage = 0;

  /** 侧向抓地缩放,1 = 新胎。 */
  get tireGripScale(): number {
    return 1 - CONDITION.tireGripLoss * this.tireWear;
  }

  /** 制动力缩放,1 = 冷刹。 */
  get brakeScale(): number {
    return 1 - CONDITION.brakeFadeLoss * this.brakeHeat;
  }

  /** 驱动力缩放,1 = 完好。 */
  get powerScale(): number {
    return 1 - CONDITION.damagePowerLoss * this.damage;
  }

  /** 每个固定步调一次。 */
  update(
    dt: number,
    gripSaturation: number,
    speed: number,
    brakeInput: number,
    wearScale = 1,
  ): void {
    const slipPower =
      clamp(gripSaturation, 0, 1) * clamp(speed / CONDITION.tireWearRefSpeed, 0, 1);
    // `wearScale` 是路面过热带来的加速磨损(见 `weather.ts`)。默认 1,所以
    // 不传的调用点行为逐位不变。
    this.tireWear = clamp(this.tireWear + CONDITION.tireWearRate * wearScale * slipPower * dt, 0, 1);

    const heating =
      clamp(brakeInput, 0, 1) * clamp(speed / CONDITION.brakeHeatRefSpeed, 0, 1);
    this.brakeHeat = clamp(
      this.brakeHeat + (CONDITION.brakeHeatRate * heating - CONDITION.brakeCoolRate) * dt,
      0,
      1,
    );
  }

  /** 撞了一下。`normalSpeed` 是法向撞击速度(m/s)。 */
  addImpact(normalSpeed: number): void {
    if (normalSpeed <= 0) {
      return;
    }
    const severity = clamp(normalSpeed / CONDITION.damageRefSpeed, 0, 1);
    this.damage = clamp(this.damage + CONDITION.damagePerImpact * severity, 0, 1);
  }

  /** 换新车。只在一局开始时调,出界回收不调。 */
  reset(): void {
    this.tireWear = 0;
    this.brakeHeat = 0;
    this.damage = 0;
  }
}
