import { DRAFT } from './tuning';
import type { Vehicle } from './vehicle';

/**
 * 尾流(牵引):把每辆车的 `Vehicle.dragScale` 按「正前方有没有人挡风」写一遍。
 *
 * 真实赛车里跟车能省下两三成气动阻力,超车战术有一半建立在这个差速上。这个
 * 项目之前完全没有,于是「跟车」除了挡路之外没有任何收益,超车只能等对方犯错。
 *
 * ## 判定是纵向 + 横向两条
 *
 * 前车必须在**车头方向**上、纵向距离不小于 `minDistance`,而且横向错开不能
 * 太多。只看直线距离会把并排的车也算进来 —— 错身跟车吃不到牵引,那不是尾流。
 * 纵向下限还兼职挡住一个浮点陷阱,见 `DRAFT.minDistance` 的注释。
 *
 * 取最强的一份,**不叠加**:两辆车前后排着也不该让第三辆减掉七成阻力。
 *
 * ## 实测效果比直觉小,原因在别处
 *
 * 满尾流(减阻 35%)从 120 km/h 全油门跑 5 秒,比干净空气多走约 2.1 米;
 * 从 180 km/h 起只多走 1.2 米 —— **越快反而收益越小**,和「阻力随 v² 涨」
 * 的直觉相反。原因是这台车的极速由 `maxSpin` 轮速硬钳位决定(模拟 A110 的
 * 电子限速 250 km/h),不是由阻力与推力的平衡决定:接近限速时省下来的阻力
 * 没地方去。真实的带限速器的车也是这样 —— 两车都顶在限速器上时,尾流不产生
 * 速度差。想让尾流更夸张只能调 `DRAFT.maxReduction`,但那会脱离真实量级。
 */
export function applyDraft(cars: readonly Vehicle[]): void {
  for (const car of cars) {
    let best = 0;
    const fx = Math.sin(car.yaw);
    const fz = Math.cos(car.yaw);
    for (const other of cars) {
      if (other === car) {
        continue;
      }
      const ahead =
        (other.position.x - car.position.x) * fx + (other.position.z - car.position.z) * fz;
      if (ahead < DRAFT.minDistance || ahead > DRAFT.maxDistance) {
        continue;
      }
      if (Math.abs(other.lateral - car.lateral) > DRAFT.lateralGap) {
        continue;
      }
      // fullDistance 以内按满效果,到 maxDistance 线性衰减到 0。
      const closeness =
        ahead <= DRAFT.fullDistance
          ? 1
          : 1 - (ahead - DRAFT.fullDistance) / (DRAFT.maxDistance - DRAFT.fullDistance);
      best = Math.max(best, closeness);
    }
    car.dragScale = 1 - DRAFT.maxReduction * best;
  }
}
