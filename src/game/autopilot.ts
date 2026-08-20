import { clamp, normalize01 } from '../core/mathx';
import type { InputFrame } from '../core/input';
import type { TrackLayout } from './trackLayout';
import { REFERENCE_TOP_SPEED } from './tuning';
import type { Vehicle } from './vehicle';

/**
 * 沿中心线循迹的简易自动驾驶。**不是游戏内容,是验收工具。**
 *
 * M2 的验收标准是「连续 10 个随机 seed 都能生成出可跑完的赛道」。靠人开
 * 10 圈来验收既慢又不可复现,所以写一个开得过去就行的循迹器,让测试每次
 * 都去实跑一圈。它不需要开得好看,只需要证明赛道是可通行的。
 *
 * 用纯追踪(pure pursuit):瞄准前方一段距离的中心线点,按方位角误差打方向,
 * 按前方曲率收油门。
 */
export class Autopilot {
  private readonly layout: TrackLayout;

  constructor(layout: TrackLayout) {
    this.layout = layout;
  }

  drive(vehicle: Vehicle, out: InputFrame): void {
    const samples = this.layout.samples;
    const count = samples.length;
    const spacing = this.layout.spacing;

    // 车当前所在的采样点。出界时 arc 停在最后一次有效值,循迹会把它带回来。
    const here = Math.floor(vehicle.arc / spacing) % count;

    // 前视距离随速度增长:低速时贴着线走,高速时提前切入,不然过弯必冲出去。
    const lookAhead = 26 + vehicle.groundSpeed * 0.75;
    const aheadIndex = (here + Math.round(lookAhead / spacing)) % count;
    const target = samples[aheadIndex];
    if (target === undefined) {
      out.throttle = 0;
      return;
    }

    // 方位角误差:目标方向与车头方向的夹角,取值 (-π, π]。
    const toTargetX = target.x - vehicle.position.x;
    const toTargetZ = target.z - vehicle.position.z;
    const targetYaw = Math.atan2(toTargetX, toTargetZ);
    let error = targetYaw - vehicle.yaw;
    while (error > Math.PI) {
      error -= Math.PI * 2;
    }
    while (error < -Math.PI) {
      error += Math.PI * 2;
    }

    // yaw 增大是左转,而 steer 为正是右转,所以取负。
    out.steer = clamp(-error * 2.2, -1, 1);

    // 前方越弯,油门收得越多。看得比转向更远,给减速留出距离。
    const scanIndex = (here + Math.round((lookAhead * 1.8) / spacing)) % count;
    const bend = Math.abs(samples[scanIndex]?.bank ?? 0);
    const speed01 = normalize01(vehicle.groundSpeed, 0, REFERENCE_TOP_SPEED);
    const wantsSlowing = bend > 0.12 && speed01 > 0.45;

    out.throttle = wantsSlowing ? 0.2 : 1;
    out.reverse = 0;
    out.airBrake = wantsSlowing && speed01 > 0.7 ? 1 : 0;
  }
}
