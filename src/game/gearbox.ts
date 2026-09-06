import { clamp, lerp } from '../core/mathx';
import { CAR, GEARBOX } from './tuning';

/**
 * 变速箱(物理层)。
 *
 * ## 和 `audio/engine.ts` 里那个的关系
 *
 * 音频层早就有一套「变速箱」了(第三十九节),但那是**纯显示层的**:它读车速
 * 自己算挡位,只用来生成转速锯齿,不回写任何物理量。这个才是真的 —— 它决定
 * 车轮上到底有多少力矩。
 *
 * ## 模型
 *
 * 标准的「发动机扭矩曲线 × 齿比 × 主减速比」:
 *
 * 1. 由轮速反推发动机转速:`rpm = ω_wheel × 齿比 × 主减速比 × 60/2π`。
 * 2. 查扭矩曲线拿到当前转速下的相对扭矩(峰值在 `peakRpm` 附近,红线区回落)。
 * 3. 轮上力矩 = 相对扭矩 × 齿比 × 主减速比 × `torqueScale`。
 * 4. 转速上红线升挡、掉到 `downshiftRpm` 降挡,换挡期间**扭矩归零**。
 *
 * ## 为什么低挡反而更容易甩尾
 *
 * 齿比放大扭矩,一挡的轮上力矩是六挡的四倍多。CLAUDE.md 记着这个游戏的甩尾
 * 机制是「驱动力矩超过后轴抓地预算」——所以加了变速箱之后,低挡出弯给油更
 * 容易甩,高挡巡航基本甩不起来。这比原来那个恒定力矩更接近真车。
 */
export class Gearbox {
  /** 当前挡位下标(0 = 一挡)。 */
  gear = 0;
  /** 当前发动机转速(rpm),仅用于读数与调试。 */
  rpm: number = GEARBOX.idleRpm;
  /** 换挡剩余时间(秒),>0 时动力被切断。 */
  private shiftRemaining = 0;

  reset(): void {
    this.gear = 0;
    this.rpm = GEARBOX.idleRpm;
    this.shiftRemaining = 0;
  }

  private ratio(gear: number): number {
    return GEARBOX.ratios[clamp(gear, 0, GEARBOX.ratios.length - 1)] ?? 1;
  }

  /**
   * 每个固定步调一次。`wheelSpin` 是驱动轮角速度(rad/s),返回**轮上驱动
   * 力矩的缩放系数**(乘到 `CAR.driveTorque` 上)。
   */
  update(wheelSpin: number, throttle: number, dt: number): number {
    const spin = Math.abs(wheelSpin);
    const total = this.ratio(this.gear) * GEARBOX.finalDrive;
    // rad/s → rpm
    this.rpm = clamp((spin * total * 60) / (Math.PI * 2), GEARBOX.idleRpm, GEARBOX.redlineRpm);

    if (this.shiftRemaining > 0) {
      this.shiftRemaining = Math.max(0, this.shiftRemaining - dt);
      // 换挡期间离合器断开,轮上没有驱动力。
      return 0;
    }

    // 升挡:到红线就换。降挡:转速掉太低才换,两个阈值分开留回滞,
    // 否则会在换挡点附近来回抖(和音频那套变速箱同一个道理)。
    if (this.gear < GEARBOX.ratios.length - 1 && this.rpm >= GEARBOX.upshiftRpm) {
      this.gear++;
      this.shiftRemaining = GEARBOX.shiftTime;
      return 0;
    }
    if (this.gear > 0 && this.rpm <= GEARBOX.downshiftRpm) {
      this.gear--;
      this.shiftRemaining = GEARBOX.shiftTime;
      return 0;
    }

    return torqueAt(this.rpm) * this.ratio(this.gear) * GEARBOX.finalDrive * GEARBOX.torqueScale * throttle;
  }
}

/**
 * 相对扭矩曲线:怠速偏低,`peakRpm` 处为 1,红线区回落。
 *
 * 真实内燃机的扭矩不是常数 —— 恒定扭矩正是「踩下去永远一个劲」那种电动车
 * 手感的来源。峰值之后回落这一段尤其重要:它才是「该换挡了」的体感。
 */
export function torqueAt(rpm: number): number {
  if (rpm <= GEARBOX.peakRpm) {
    const t = (rpm - GEARBOX.idleRpm) / Math.max(1, GEARBOX.peakRpm - GEARBOX.idleRpm);
    return lerp(GEARBOX.idleTorque, 1, clamp(t, 0, 1));
  }
  const t = (rpm - GEARBOX.peakRpm) / Math.max(1, GEARBOX.redlineRpm - GEARBOX.peakRpm);
  return lerp(1, GEARBOX.redlineTorque, clamp(t, 0, 1));
}

/** 六挡全开时的轮上力矩上限,给调参时对照用。 */
export function peakWheelTorqueScale(): number {
  return (GEARBOX.ratios[0] ?? 1) * GEARBOX.finalDrive * GEARBOX.torqueScale;
}

/** 让 `CAR.driveTorque` 在类型上被用到,避免误删这条耦合的注释。 */
export const REFERENCE_DRIVE_TORQUE = CAR.driveTorque;
