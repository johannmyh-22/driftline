import { clamp } from '../core/mathx';
import type { InputFrame } from '../core/input';
import { RACING_AI } from './tuning';
import type { TrackLayout } from './trackLayout';
import type { Vehicle } from './vehicle';

/**
 * 能当对手开的竞速 AI(M7)。
 *
 * ## 和 `Autopilot` 的关系:替换,不是改造
 *
 * `Autopilot` 是 M2 留下的**验收工具**,它自己的类注释写着「不是游戏内容」。
 * 实测把它当对手用,五条精选赛道单圈比目标时间慢 56~74%,**满油门占比只有
 * 5%** —— 人类反馈「AI 车太垃圾了,特别慢也不聪明」,这个数字就是原因。
 *
 * 但 `Autopilot` 一个字都没动:截图回归的既有基线(包括那条曾经红过的转向
 * 测试)全靠它逐帧稳定,改它等于把整套视觉基线一起动了。这里另起一个类。
 *
 * ## 为什么慢:二值化的油门
 *
 * `Autopilot` 的逻辑是「前方是弯 → 油门归零 + 空气刹拉满」,而它判定「是弯」
 * 的阈值很低,于是整圈几乎都在滑行。它从来不问「这个弯到底能多快过」。
 *
 * ## 这里怎么做:先算弯速,再反解刹车点
 *
 * 三步,都是实车赛道工程里的标准做法:
 *
 * 1. **弯速上限**:由曲率反解,`v = √(a_lat · R)`,`R = 1/κ`。
 * 2. **刹车点**:朝前扫 `scanDistance` 米,对每个采样点 j 算「要在 j 点降到
 *    `v_j`,现在最多能有多快」——`√(v_j² + 2·a_brake·d)`,取所有 j 的最小值。
 *    这一步是「提前减速」的全部内容:不需要判断"是不是弯",直接得到当前
 *    允许的最高速度。
 * 3. **油门/刹车**:低于目标给油,高于目标刹车,中间留一条滑行带,免得油门
 *    和刹车在目标值附近来回抖。
 *
 * 另外走线朝弯内偏(`lineOffset`):沿中心线跑等于把弯道半径用满了却一米不
 * 占便宜,往内切能撑大有效半径,弯速上限跟着涨。
 *
 * ## 旁边有车
 *
 * 只做最基本的一条:前方近距离有横向也近的车就侧移 + 收油,不追尾。超车靠
 * 速度差自然发生,不做刻意的博弈——那需要完整的赛制(还没做,见 PLAN.md M7)。
 */
export class RacingPilot {
  private readonly layout: TrackLayout;
  /**
   * 难度系数,同时缩放弯速上限与刹车能力。默认值的标定数据见
   * `RACING_AI.defaultAggression` 的注释——1.0 跑得完而且比目标时间快两成,
   * 压到 0.7 纯粹是为了让对手可赢。
   */
  private readonly aggression: number;

  constructor(layout: TrackLayout, aggression: number = RACING_AI.defaultAggression) {
    this.layout = layout;
    this.aggression = clamp(aggression, 0.3, 1);
  }

  drive(vehicle: Vehicle, out: InputFrame, rivals: readonly Vehicle[] = []): void {
    const { samples, spacing } = this.layout;
    const count = samples.length;
    if (count === 0) {
      out.throttle = 0;
      return;
    }

    const here = ((Math.floor(vehicle.arc / spacing) % count) + count) % count;
    const speed = vehicle.groundSpeed;

    // ── 1. 目标速度:朝前扫,取所有前方弯所允许的最小当前速度 ──
    const latAccel = RACING_AI.lateralAccel * this.aggression;
    const brakeAccel = RACING_AI.brakeAccel * this.aggression;
    const steps = Math.max(1, Math.round(RACING_AI.scanDistance / spacing));
    let targetSpeed = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= steps; i++) {
      const idx = (here + i) % count;
      const kappa = this.curvatureAt(idx);
      // 直道曲率趋近 0,弯速上限趋近无穷,自然不会成为约束。
      const cornerSpeed = kappa > 1e-6 ? Math.sqrt(latAccel / kappa) : Number.POSITIVE_INFINITY;
      if (cornerSpeed === Number.POSITIVE_INFINITY) {
        continue;
      }
      // 还要走 d 米才到那个弯,所以现在可以比弯速快 √(2·a·d)。
      const d = i * spacing;
      const allowedNow = Math.sqrt(cornerSpeed * cornerSpeed + 2 * brakeAccel * d);
      if (allowedNow < targetSpeed) {
        targetSpeed = allowedNow;
      }
    }

    // ── 2. 转向:纯追踪,目标点朝弯内偏 ──
    const lookAhead = RACING_AI.lookAheadBase + speed * RACING_AI.lookAheadTime;
    const aheadIdx = (here + Math.round(lookAhead / spacing)) % count;
    const target = samples[aheadIdx];
    if (target === undefined) {
      out.throttle = 0;
      return;
    }

    const signedKappa = this.signedCurvatureAt(aheadIdx);
    let offset = 0;
    if (Math.abs(signedKappa) > RACING_AI.lineCurvature) {
      // 朝弯内偏。signedKappa > 0 表示向右弯,内侧在右。
      offset = Math.sign(signedKappa) * this.layout.halfWidth * RACING_AI.lineOffset;
    }
    offset += this.avoidOffset(vehicle, rivals);

    // 赛道右手边的单位法向 = 切线绕 Y 轴转 -90°:(tz, -tx) → 这里用 (tangentZ, -tangentX)。
    const aimX = target.x + target.tangentZ * offset;
    const aimZ = target.z - target.tangentX * offset;

    let error = Math.atan2(aimX - vehicle.position.x, aimZ - vehicle.position.z) - vehicle.yaw;
    while (error > Math.PI) {
      error -= Math.PI * 2;
    }
    while (error < -Math.PI) {
      error += Math.PI * 2;
    }
    // yaw 增大是左转、steer 为正是右转,所以取负。
    out.steer = clamp(-error * RACING_AI.steerGain, -1, 1);

    // ── 3. 油门/刹车 ──
    const lift = this.followLift(vehicle, rivals);
    out.reverse = 0;
    if (speed < targetSpeed * RACING_AI.throttleBand) {
      // 转向越多留给纵向的摩擦圆越少,给油要收着点,否则后轴空转反而更慢。
      out.throttle = clamp((1 - RACING_AI.tractionCut * Math.abs(out.steer)) * lift, 0, 1);
      out.airBrake = 0;
    } else if (speed > targetSpeed * RACING_AI.brakeBand) {
      out.throttle = 0;
      out.airBrake = 1;
    } else {
      // 滑行带:既不给油也不刹车,免得在目标速度附近来回抖。
      out.throttle = 0;
      out.airBrake = 0;
    }
  }

  /** 无符号曲率(1/m)。用一段基线上的切线转角除以弧长,比逐点差分抗噪。 */
  private curvatureAt(index: number): number {
    return Math.abs(this.signedCurvatureAt(index));
  }

  /** 带符号曲率:正 = 向右弯。 */
  private signedCurvatureAt(index: number): number {
    const { samples, spacing } = this.layout;
    const count = samples.length;
    const half = Math.max(1, Math.round(RACING_AI.curvatureBase / spacing / 2));
    const a = samples[((index - half) % count + count) % count];
    const b = samples[(index + half) % count];
    if (a === undefined || b === undefined) {
      return 0;
    }
    // 两条切线的夹角(带符号),除以两点间弧长 = 曲率。
    const cross = a.tangentZ * b.tangentX - a.tangentX * b.tangentZ;
    const dot = a.tangentX * b.tangentX + a.tangentZ * b.tangentZ;
    const angle = Math.atan2(cross, dot);
    const arcLen = half * 2 * spacing;
    return arcLen > 0 ? angle / arcLen : 0;
  }

  /** 前方有车挡路时朝旁边挪。返回附加的横向偏移(米)。 */
  private avoidOffset(vehicle: Vehicle, rivals: readonly Vehicle[]): number {
    const blocker = this.findBlocker(vehicle, rivals);
    if (blocker === null) {
      return 0;
    }
    // 往对方所在一侧的反方向挪;正好并排(差值接近 0)时默认往左让。
    const side = blocker.lateral - vehicle.lateral;
    const away = side >= 0 ? -1 : 1;
    const room = this.layout.halfWidth - 1;
    return clamp(away * RACING_AI.rivalSideStep, -room, room);
  }

  /** 跟在别人后面时的油门系数,避免直接怼上去。 */
  private followLift(vehicle: Vehicle, rivals: readonly Vehicle[]): number {
    return this.findBlocker(vehicle, rivals) === null ? 1 : RACING_AI.rivalLift;
  }

  /**
   * 找正前方挡路的车:必须在**前面**(沿车头方向的投影为正)、够近、而且横向
   * 也够近。只看直线距离会把并排的车也当成挡路,那会让 AI 无缘无故一直收油。
   */
  private findBlocker(vehicle: Vehicle, rivals: readonly Vehicle[]): Vehicle | null {
    const fx = Math.sin(vehicle.yaw);
    const fz = Math.cos(vehicle.yaw);
    for (const other of rivals) {
      if (other === vehicle) {
        continue;
      }
      const dx = other.position.x - vehicle.position.x;
      const dz = other.position.z - vehicle.position.z;
      const ahead = dx * fx + dz * fz;
      if (ahead <= 0 || ahead > RACING_AI.rivalAheadDistance) {
        continue;
      }
      if (Math.abs(other.lateral - vehicle.lateral) > RACING_AI.rivalLateralGap) {
        continue;
      }
      return other;
    }
    return null;
  }
}
