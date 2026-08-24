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
/**
 * 方位角误差到归一化转向输入的增益(1/弧度)。
 *
 * 这是**测试用自动驾驶**的参数,不是玩法手感,所以留在这里而不是 tuning.ts。
 */
const AUTOPILOT_STEER_GAIN = 8.0;

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
    const lookAhead = 20 + vehicle.groundSpeed * 0.60;
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
    //
    // 增益跟着转向权限走:steer 是归一化输入,实际前轮转角由
    // Vehicle.steerLimit() 按车速给,高速下只有低速的几分之一。增益写死会
    // 让回路在高速段变钝、跟线跑宽、整圈变慢。这里按「多少弧度的方位角误差
    // 打满舵」来定,和车速无关。
    out.steer = clamp(-error * AUTOPILOT_STEER_GAIN, -1, 1);

    // 前方越弯,油门收得越多。看得比转向更远,给减速留出距离。
    const scanIndex = (here + Math.round((lookAhead * 2.0) / spacing)) % count;
    const currSample = samples[here] ?? samples[0]!;
    const aheadSample = samples[scanIndex] ?? currSample;
    const bend = Math.abs(aheadSample.bank ?? 0);
    const dTangent = Math.hypot(
      aheadSample.tangentX - currSample.tangentX,
      aheadSample.tangentZ - currSample.tangentZ,
    );
    const isCurve = bend > 0.05 || dTangent > 0.10;

    const speed01 = normalize01(vehicle.groundSpeed, 0, REFERENCE_TOP_SPEED);
    const wantsSlowing = isCurve && speed01 > 0.28;

    // 后轮一旦空转,纵向力吃掉摩擦圆,车尾会出去 —— 对玩家是甩尾,对这个
    // 跟线回路只是丢时间。所以给它一份最朴素的牵引力控制:方向打得越多,
    // 油门给得越少。人类玩家自己决定要不要甩,这里只负责把圈跑完。
    const traction = 1 - 0.5 * Math.abs(out.steer);
    out.throttle = wantsSlowing ? 0 : traction;
    out.reverse = 0;
    out.airBrake = wantsSlowing && speed01 > 0.45 ? 1 : 0;
  }
}
