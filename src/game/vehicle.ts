import { Matrix4, Quaternion, Vector3 } from 'three';
import type { InputFrame } from '../core/input';
import { clamp, damp, lerp, normalize01 } from '../core/mathx';
import { type GroundHit, type GroundQuery, createGroundHit } from './groundQuery';
import { REFERENCE_TOP_SPEED, VEHICLE } from './tuning';

// 每帧路径上的临时量,全部提到模块作用域复用。60Hz 下新建 Vector3 的 GC 抖动看得见。
const forward = new Vector3();
/** 驾驶员的右手边 = forward × up。侧滑与抓地用这个。 */
const rightward = new Vector3();
/** 车体模型的局部 +X 轴。模型朝 +Z 建,所以它指向驾驶员的**左**边。 */
const bodyX = new Vector3();
const up = new Vector3();
const scratch = new Vector3();
const basis = new Matrix4();
const bankQuat = new Quaternion();
const pitchQuat = new Quaternion();
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Z = new Vector3(0, 0, 1);

/** 撞进地面的兜底距离。正常情况下弹簧会先接住,这只是防止高速下的穿透。 */
const HARD_FLOOR = 0.3;

/**
 * 悬浮载具。自写速度积分 + 弹簧悬浮,不用物理引擎。
 *
 * 车头朝向局部 +Z。偏航角 `yaw` 绕世界 Y 轴,`yaw = 0` 时车头指向 +Z。
 *
 * **yaw 增大 = 俯视逆时针 = 左转。** 因为 `forward = (sin yaw, 0, cos yaw)`,
 * yaw 变大是把 +Z 扫向 +X,在右手系里俯视看就是逆时针。所以右转输入要取负号。
 * 这条一开始写反了,而且单测只断言「yaw 与 steer 同号」—— 那正是搞反的那件事,
 * 于是测试和 bug 用了同一个前提,必然通过。现在转向测试改成断言车最后跑到哪边。
 *
 * 所有手感数字都在 `tuning.ts`,这里只写「怎么算」,不写「算多少」。
 */
export class Vehicle {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly orientation = new Quaternion();

  yaw = 0;
  yawRate = 0;
  grounded = false;
  /** 当前离地高度(车体原点到地面)。 */
  clearance = 0;
  /** 是否踩在可跑的路面上。出界判定和圈计时看它。 */
  onTrack = true;
  /** 到赛道中心线的有符号横向距离,正值在右侧。 */
  lateral = 0;
  /** 沿赛道的弧长位置(米)。 */
  arc = 0;
  /** 侧向抓地力的使用率 0..1。到 1 就是滑出去了,给音效和 HUD 用。 */
  gripSaturation = 0;
  /**
   * 抓地力这一帧实际施加的侧向加速度(m/s²)。
   *
   * 想知道「车在拉几个 g」必须看这个,**不能拿速度差去算** —— 车头转动本身
   * 就会让机体坐标系下的侧向速度以 ω·v 的速率变化(0.9 rad/s × 80 m/s = 72 m/s²),
   * 那是坐标系旋转的记账,不是地面给的力。
   */
  lateralGripAccel = 0;
  /** 最近一次撞墙的强度(法向速度 × 撞击角),没撞是 0。 */
  wallImpact = 0;
  /**
   * 侧向速度,**正值 = 向驾驶员右手边滑**。漂移感就看它。
   *
   * 右转时速度方向落后于车头,所以是向左滑,这个值为负 —— 别被符号绕进去。
   */
  lateralSpeed = 0;

  private readonly field: GroundQuery;
  private readonly hit: GroundHit = createGroundHit();
  private readonly surfaceUp = new Vector3(0, 1, 0);
  private smoothedForwardAccel = 0;

  constructor(field: GroundQuery) {
    this.field = field;
    this.reset();
  }

  get speed(): number {
    return this.velocity.length();
  }

  /** 水平速度。速度表和 FOV 用它,免得垂直方向的起落污染读数。 */
  get groundSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  reset(x = 0, z = 0, yaw = 0): void {
    this.field.sample(x, z, this.hit);
    this.position.set(x, this.hit.height + VEHICLE.rideHeight, z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.yawRate = 0;
    this.grounded = true;
    this.clearance = VEHICLE.rideHeight;
    this.lateralSpeed = 0;
    this.smoothedForwardAccel = 0;
    this.surfaceUp.set(0, 1, 0);
    this.updateOrientation(0);
  }

  update(input: InputFrame, dt: number): void {
    this.field.sample(this.position.x, this.position.z, this.hit);
    this.clearance = this.position.y - this.hit.height;
    this.grounded = this.clearance < VEHICLE.hoverRange;
    this.onTrack = this.hit.onTrack;
    this.lateral = this.hit.lateral;
    this.arc = this.hit.arc;

    forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    rightward.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));

    this.applyHover(dt);
    this.applySteering(input, dt);
    this.applyThrust(input, dt);
    this.applyDrag(input, dt);
    this.applyLateralGrip(input, dt);

    this.position.addScaledVector(this.velocity, dt);
    this.resolveWall();

    // 兜底:高速冲上陡坡时不让车体穿进地里。
    this.field.sample(this.position.x, this.position.z, this.hit);
    const floor = this.hit.height + HARD_FLOOR;
    if (this.position.y < floor) {
      this.position.y = floor;
      if (this.velocity.y < 0) {
        this.velocity.y = 0;
      }
    }

    this.updateOrientation(dt);
  }

  private applyHover(dt: number): void {
    this.velocity.y -= VEHICLE.gravity * dt;

    if (!this.grounded) {
      return;
    }

    // 只推不拉:悬浮力把车顶起来,但不该像磁铁一样把车吸回地面 ——
    // 那样冲上跳台就飞不起来了。
    //
    // 额外加一份重力补偿:不加的话平衡点会停在 rideHeight - g/k(约低 14 cm),
    // tuning 里那个数就名不副实,人类照着调会一直差一截。
    //
    // 补偿之后仍有约 +4.6 cm 的残差(= damping·gravity·dt / stiffness),
    // 那是固定步长离散化的产物,不是 bug;换 dt 才会变。
    const compression = VEHICLE.rideHeight - this.clearance;
    const spring =
      VEHICLE.hoverStiffness * compression -
      VEHICLE.hoverDamping * this.velocity.y +
      VEHICLE.gravity;
    if (spring > 0) {
      this.velocity.y += spring * dt;
    }
  }

  private applySteering(input: InputFrame, dt: number): void {
    const speed01 = normalize01(this.groundSpeed, 0, REFERENCE_TOP_SPEED);
    // 速度越高转向上限越低,否则高速原地打转,速度感全丢。
    const maxYawRate = lerp(VEHICLE.yawRateMax, VEHICLE.yawRateAtTopSpeed, speed01);
    const authority = this.grounded ? 1 : VEHICLE.yawAuthorityAirborne;

    // 取负:steer 为正表示向右,而 yaw 增大是向左(见类注释)。
    const target = -input.steer * maxYawRate * authority;
    const lambda = input.steer === 0 ? VEHICLE.yawRecenter : VEHICLE.yawResponse;
    this.yawRate = damp(this.yawRate, target, lambda, dt);
    this.yaw += this.yawRate * dt;
  }

  private applyThrust(input: InputFrame, dt: number): void {
    const drive = input.throttle * VEHICLE.thrust - input.reverse * VEHICLE.reverseThrust;
    // 空中推力大幅衰减:能微调落点,但不能当飞行器开。
    const accel = drive * (this.grounded ? 1 : 0.25);
    this.velocity.addScaledVector(forward, accel * dt);
    this.smoothedForwardAccel = damp(this.smoothedForwardAccel, accel, 6, dt);
  }

  private applyDrag(input: InputFrame, dt: number): void {
    const horizontal = Math.hypot(this.velocity.x, this.velocity.z);
    if (horizontal <= 1e-5) {
      return;
    }

    const airBrake = VEHICLE.airBrakeDrag * input.airBrake;
    const decel = (VEHICLE.dragLinear + airBrake + VEHICLE.dragQuadratic * horizontal) * horizontal;
    // 不允许阻力把速度拉成负数并反向。
    const scale = Math.max(0, 1 - (decel * dt) / horizontal);
    this.velocity.x *= scale;
    this.velocity.z *= scale;
  }

  private applyLateralGrip(input: InputFrame, dt: number): void {
    this.lateralSpeed = this.velocity.dot(rightward);

    let grip = this.grounded ? VEHICLE.lateralGrip : VEHICLE.lateralGripAirborne;
    if (this.grounded) {
      grip += VEHICLE.airBrakeGripBonus * input.airBrake;
    }

    const wanted = this.lateralSpeed * (1 - Math.exp(-grip * dt));

    // 抓地力封顶(摩擦圆)。没有这一层的话,抓地力正比于侧滑速度且无上限,
    // 任何速度进弯都能被硬拽回线上 —— 也就没有「过弯极限」这回事了。
    const budget = this.lateralGripBudget(input) * dt;
    const removed = Math.sign(wanted) * Math.min(Math.abs(wanted), budget);

    this.gripSaturation = budget > 1e-6 ? Math.min(1, Math.abs(wanted) / budget) : 0;
    this.lateralGripAccel = Math.abs(removed) / dt;
    this.velocity.addScaledVector(rightward, -removed);
  }

  /**
   * 当前可用的侧向加速度上限。
   *
   * 侧倾会加分:路面朝侧滑方向抬起时,重力的分量帮着把车推回来。这正是
   * 真实赛道压弯道外侧能多带速度的原因,也让侧倾对圈速产生了实际意义。
   */
  private lateralGripBudget(input: InputFrame): number {
    if (!this.grounded) {
      return VEHICLE.lateralGripLimit * 0.12;
    }

    let budget = VEHICLE.lateralGripLimit;
    budget += VEHICLE.airBrakeGripBonus * input.airBrake;

    if (this.hit.normalY > 1e-6 && this.lateralSpeed !== 0) {
      // 法线在横向上的分量给出路面的横向坡度;车往哪边滑,那边是上坡就得分。
      const slope = -(this.hit.normalX * rightward.x + this.hit.normalZ * rightward.z) /
        this.hit.normalY;
      budget += Math.max(0, VEHICLE.gravity * slope * Math.sign(this.lateralSpeed));
    }

    return budget;
  }

  /**
   * 护栏碰撞。M2 的护栏只是画出来的,车能直接穿过去。
   *
   * 处理成「贴着墙滑行」而不是弹开:把超出的部分推回来,法向速度按反弹系数
   * 反向,切向速度按撞击角度扣一刀。正面撞掉速多、小角度擦墙掉速少 ——
   * 反过来的话贴着墙磨会变成最快跑法。
   */
  private resolveWall(): void {
    const limit = this.hit.wallDistance;
    if (!Number.isFinite(limit)) {
      return;
    }

    this.field.sample(this.position.x, this.position.z, this.hit);
    const lateral = this.hit.lateral;
    if (!Number.isFinite(lateral) || Math.abs(lateral) <= limit) {
      this.wallImpact = 0;
      return;
    }

    // 墙的法线就是赛道横向轴,朝向赛道内侧。
    rightward.set(-this.hit.tangentZ, 0, this.hit.tangentX);
    const outward = Math.sign(lateral);
    const overshoot = Math.abs(lateral) - limit;

    this.position.addScaledVector(rightward, -overshoot * outward);

    const normalSpeed = this.velocity.dot(rightward) * outward;
    if (normalSpeed > 0) {
      this.velocity.addScaledVector(
        rightward,
        -normalSpeed * (1 + VEHICLE.wallRestitution) * outward,
      );

      const speed = this.velocity.length() || 1;
      // 撞击角:法向速度占总速度的比例。正面撞接近 1,擦墙接近 0。
      const bite = Math.min(1, normalSpeed / speed);
      this.wallImpact = bite * normalSpeed;
      const scrub = Math.exp(-VEHICLE.wallScrubbing * bite * (1 / 60));
      this.velocity.multiplyScalar(scrub);
    }
  }

  private updateOrientation(dt: number): void {
    // 贴地时姿态跟随地面法线,离地后慢慢回到世界竖直方向。
    const lambda = this.grounded ? VEHICLE.attitudeAlign : VEHICLE.attitudeAlignAirborne;
    const targetX = this.grounded ? this.hit.normalX : 0;
    const targetY = this.grounded ? this.hit.normalY : 1;
    const targetZ = this.grounded ? this.hit.normalZ : 0;

    const blend = dt > 0 ? 1 - Math.exp(-lambda * dt) : 1;
    this.surfaceUp.x += (targetX - this.surfaceUp.x) * blend;
    this.surfaceUp.y += (targetY - this.surfaceUp.y) * blend;
    this.surfaceUp.z += (targetZ - this.surfaceUp.z) * blend;
    this.surfaceUp.normalize();

    up.copy(this.surfaceUp);
    forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    // 把车头投影到与地面法线垂直的平面上,车身才真正贴着坡面而不是插进去。
    scratch.copy(up).multiplyScalar(forward.dot(up));
    forward.sub(scratch);
    if (forward.lengthSq() < 1e-8) {
      forward.set(0, 0, 1);
    }
    forward.normalize();
    // up × forward 得到的是模型的局部 +X(驾驶员左手边),makeBasis 要的正是它。
    bodyX.copy(up).cross(forward).normalize();

    basis.makeBasis(bodyX, up, forward);
    this.orientation.setFromRotationMatrix(basis);

    // 车身向弯内压坡度:右转时向左滑(lateralSpeed 为负),要把右半边压下去。
    // 绕局部 +Z 正向旋转会把局部 +X(左半边)抬起来,所以这里取负号。
    const bank = clamp(
      -this.lateralSpeed * VEHICLE.bankPerLateralSpeed,
      -VEHICLE.bankMax,
      VEHICLE.bankMax,
    );
    bankQuat.setFromAxisAngle(AXIS_Z, bank);
    this.orientation.multiply(bankQuat);

    const pitch = clamp(
      -this.smoothedForwardAccel * VEHICLE.pitchPerAcceleration,
      -VEHICLE.pitchMax,
      VEHICLE.pitchMax,
    );
    pitchQuat.setFromAxisAngle(AXIS_X, pitch);
    this.orientation.multiply(pitchQuat);
  }
}
