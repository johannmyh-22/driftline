import { Quaternion, Vector3 } from 'three';
import type { InputFrame } from '../core/input';
import { clamp, damp, normalize01 } from '../core/mathx';
import { type GroundHit, type GroundQuery, createGroundHit } from './groundQuery';
import { type BodyState, type Physics, createBodyState } from './physics';
import { type TireForce, type TireState, tireForce } from './tire';
import { CAR, REFERENCE_TOP_SPEED, TIRE, VEHICLE } from './tuning';

// 每帧路径上的临时量,全部提到模块作用域复用。60Hz 下新建 Vector3 的 GC 抖动看得见。
const chassisUp = new Vector3();
const chassisForward = new Vector3();
const chassisLeft = new Vector3();
const attach = new Vector3();
const contact = new Vector3();
const arm = new Vector3();
const pointVelocity = new Vector3();
const wheelForward = new Vector3();
const wheelLeft = new Vector3();
const normal = new Vector3();
const scratch = new Vector3();
const spin = new Quaternion();

/**
 * 滑移率分母的下限(米/秒)。
 *
 * 滑移率的定义 `(ωR − v) / |v|` 在 v→0 时发散,而车每次起步都要经过 v=0。
 * 不夹住的话起步第一帧滑移率就是几百,轮胎力直接饱和,车原地弹射。
 * 取 2.5 是常见做法:低于这个速度时分母恒为 2.5,滑移率平滑地趋向有限值。
 */
const SLIP_SPEED_FLOOR = 2.5;

/** 车身翻过头时,「沿车身 up 轴向下找地面」这件事本身就没意义了。 */
const MIN_UP_COMPONENT = 0.15;

/** 一个车轮。位置在车身局部系:**+X 是驾驶员左侧,+Z 是车头**。 */
interface Wheel {
  readonly localX: number;
  readonly localZ: number;
  readonly steered: boolean;
  readonly driveShare: number;
  readonly brakeShare: number;
  /** 车轮角速度(弧度/秒),正 = 往前滚。 */
  spin: number;
  /** 悬挂当前长度(米),从安装点到接地点。 */
  length: number;
  grounded: boolean;
  /** 垂直载荷(牛)。载荷转移就体现在四个轮子这个值的此消彼长上。 */
  load: number;
  slipRatio: number;
  slipAngle: number;
}

const tireState: TireState = { slipRatio: 0, slipAngle: 0, load: 0, friction: 1 };
const tireOut: TireForce = { longitudinal: 0, lateral: 0 };

/**
 * 四轮 raycast 车辆。车身由 Rapier 做刚体积分,四个轮子各自查地面、各自出力。
 *
 * 车头朝向局部 +Z。偏航角 `yaw` 绕世界 Y 轴,`yaw = 0` 时车头指向 +Z。
 * **yaw 增大 = 俯视逆时针 = 左转**(`forward = (sin yaw, 0, cos yaw)`)。
 * 这条一开始写反过,而且单测只断言「yaw 与 steer 同号」—— 那正是搞反的那件事,
 * 测试和 bug 共用了同一个前提,必然通过。转向测试现在断言车最后跑到哪边。
 *
 * **和悬浮版相比,有两件事从「手写的补丁」变成了「物理的副产品」:**
 *
 * 1. 偏航角速度不再需要人为封顶。悬浮版必须用 `ω = a_lat / v` 去推一个上限,
 *    否则一打方向就原地打转;现在偏航力矩由四条胎的侧向力产生,而侧向力本身
 *    受摩擦圆限制,上限是自然出现的。
 * 2. 静止时转向不再需要人为衰减。侧向力来自侧偏角,侧偏角来自速度 ——
 *    车不动就没有力矩。
 *
 * **别把这两条再手写回来。** 它们在 `docs/HANDOFF.md` 第九节里被列为
 * 「为悬浮而写但换成真车依然需要」,那个判断对悬浮式积分是对的,对现在这套不对。
 *
 * 所有数值都在 `tuning.ts` 的 `CAR` 段,这里只写「怎么算」。
 */
export class Vehicle {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly orientation = new Quaternion();

  yaw = 0;
  yawRate = 0;
  grounded = false;
  /** 车身原点到地面的高度。 */
  clearance = 0;
  onTrack = true;
  lateral = 0;
  arc = 0;
  /** 侧向抓地力的使用率 0..1。到 1 就是滑出去了,给音效和 HUD 用。 */
  gripSaturation = 0;
  /**
   * 抓地力这一帧实际施加的侧向加速度(m/s²)。
   *
   * 想知道「车在拉几个 g」必须看这个,**不能拿速度差去算** —— 车头转动本身
   * 就会让机体系下的侧向速度以 ω·v 的速率变化,那是坐标系旋转的记账。
   */
  lateralGripAccel = 0;
  /** 最近一次撞墙的强度,没撞是 0。 */
  wallImpact = 0;
  /** 侧向速度,**正值 = 向驾驶员右手边滑**。漂移感就看它。 */
  lateralSpeed = 0;
  /** 当前前轮转角(弧度),正 = 左。 */
  steerAngle = 0;

  private readonly field: GroundQuery;
  private readonly physics: Physics;
  private readonly body: ReturnType<Physics['createChassis']>;
  private readonly state: BodyState = createBodyState();
  private readonly hit: GroundHit = createGroundHit();
  private readonly wheels: Wheel[];

  constructor(field: GroundQuery, physics: Physics) {
    this.field = field;
    this.physics = physics;
    this.body = physics.createChassis({
      mass: CAR.mass,
      width: CAR.bodyWidth,
      height: CAR.bodyHeight,
      length: CAR.bodyLength,
    });

    const halfBase = CAR.wheelBase / 2;
    const halfTrack = CAR.trackWidth / 2;
    const rearDrive = CAR.rearDriveBias;
    const frontBrake = CAR.frontBrakeBias;
    this.wheels = [
      // 前轮转向、分到大部分制动;后轮驱动。左右对称,所以左右各一份。
      makeWheel(halfTrack, halfBase, true, (1 - rearDrive) / 2, frontBrake / 2),
      makeWheel(-halfTrack, halfBase, true, (1 - rearDrive) / 2, frontBrake / 2),
      makeWheel(halfTrack, -halfBase, false, rearDrive / 2, (1 - frontBrake) / 2),
      makeWheel(-halfTrack, -halfBase, false, rearDrive / 2, (1 - frontBrake) / 2),
    ];

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

    // 静止时悬挂已经被车重压掉一截,直接放在完全伸展的高度上,车会先掉下来弹一下。
    const staticCompression = Math.min(
      CAR.suspensionTravel,
      (CAR.mass * VEHICLE.gravity) / 4 / CAR.suspensionStiffness,
    );
    const rideHeight = CAR.suspensionRest - staticCompression;

    this.yaw = yaw;
    this.yawRate = 0;
    this.steerAngle = 0;
    this.position.set(x, this.hit.height + rideHeight, z);
    this.velocity.set(0, 0, 0);
    this.orientation.setFromAxisAngle(new Vector3(0, 1, 0), yaw);
    this.lateralSpeed = 0;
    this.gripSaturation = 0;
    this.lateralGripAccel = 0;
    this.wallImpact = 0;
    this.grounded = true;
    this.clearance = rideHeight;
    this.onTrack = this.hit.onTrack;
    this.lateral = this.hit.lateral;
    this.arc = this.hit.arc;

    for (const wheel of this.wheels) {
      wheel.spin = 0;
      wheel.length = CAR.suspensionRest - staticCompression;
      wheel.grounded = true;
      wheel.load = (CAR.mass * VEHICLE.gravity) / 4;
      wheel.slipRatio = 0;
      wheel.slipAngle = 0;
    }

    this.physics.setTransform(
      this.body,
      this.position.x, this.position.y, this.position.z,
      this.orientation.x, this.orientation.y, this.orientation.z, this.orientation.w,
    );
    this.physics.setVelocity(this.body, 0, 0, 0, 0, 0, 0);
  }

  update(input: InputFrame, dt: number): void {
    // 先清掉上一步的力:Rapier 的 addForce 是持续力,不清会逐帧累加成指数爆炸。
    this.physics.resetForces(this.body);

    this.physics.read(this.body, this.state);
    this.readBasis();

    this.updateSteering(input, dt);

    let totalLateralForce = 0;
    let groundedCount = 0;
    let saturation = 0;

    for (const wheel of this.wheels) {
      const result = this.driveWheel(wheel, input, dt);
      totalLateralForce += result.lateral;
      saturation = Math.max(saturation, result.saturation);
      if (wheel.grounded) {
        groundedCount++;
      }
    }

    this.grounded = groundedCount > 0;
    this.gripSaturation = saturation;
    this.lateralGripAccel = totalLateralForce / CAR.mass;

    this.applyAero();
    this.physics.step();

    this.physics.read(this.body, this.state);
    this.writeBack();
    this.resolveWall();
  }

  /** 从刚体姿态取出车身三轴。 */
  private readBasis(): void {
    const s = this.state;
    spin.set(s.qx, s.qy, s.qz, s.qw);
    chassisUp.set(0, 1, 0).applyQuaternion(spin);
    chassisForward.set(0, 0, 1).applyQuaternion(spin);
    // 模型朝 +Z 建,右手系下局部 +X 指向驾驶员的**左**边。名字直接叫左,免得又搞反。
    chassisLeft.set(1, 0, 0).applyQuaternion(spin);
  }

  private updateSteering(input: InputFrame, dt: number): void {
    const speed01 = normalize01(this.groundSpeed, 0, REFERENCE_TOP_SPEED);
    // 高速打满舵在物理上就是失控,真车靠转向比和驾驶员自己限制。
    const authority = 1 - (1 - CAR.steerAtTopSpeed) * speed01;
    // steer 正值是右转,而 yaw/局部 +X 正方向是左,所以这里取负。
    const target = -input.steer * CAR.steerMax * authority;
    this.steerAngle = damp(this.steerAngle, target, CAR.steerRate, dt);
  }

  /** 算一个轮子的悬挂力与轮胎力并施加,返回它对整车的侧向贡献。 */
  private driveWheel(
    wheel: Wheel,
    input: InputFrame,
    dt: number,
  ): { lateral: number; saturation: number } {
    const s = this.state;

    // 悬挂安装点的世界坐标。
    attach.set(wheel.localX, 0, wheel.localZ).applyQuaternion(spin);
    attach.x += s.x;
    attach.y += s.y;
    attach.z += s.z;

    this.field.sample(attach.x, attach.z, this.hit);
    normal.set(this.hit.normalX, this.hit.normalY, this.hit.normalZ);

    const maxLength = CAR.suspensionRest;
    // 沿车身 up 轴往下走多远碰到地面。车翻过来时这个投影没意义,当作离地。
    const upComponent = chassisUp.y;
    const distance =
      upComponent > MIN_UP_COMPONENT
        ? (attach.y - this.hit.height) / upComponent
        : Number.POSITIVE_INFINITY;

    if (!(distance < maxLength)) {
      wheel.grounded = false;
      wheel.load = 0;
      wheel.length = maxLength;
      wheel.slipRatio = 0;
      wheel.slipAngle = 0;
      // 离地的轮子没有地面力矩,只有制动能改变它的转速。
      this.integrateSpin(wheel, input, 0, dt);
      return { lateral: 0, saturation: 0 };
    }

    wheel.grounded = true;
    const compression = clamp(maxLength - distance, 0, CAR.suspensionTravel);

    // 安装点在世界系里的速度 = 质心线速度 + 角速度 × 力臂。
    arm.set(attach.x - s.x, attach.y - s.y, attach.z - s.z);
    pointVelocity.set(s.wx, s.wy, s.wz).cross(arm);
    pointVelocity.x += s.vx;
    pointVelocity.y += s.vy;
    pointVelocity.z += s.vz;

    // 压缩速率:安装点朝地面靠近为正。
    const compressionRate = -pointVelocity.dot(chassisUp);
    // 只推不拉 —— 悬挂不该像磁铁一样把车吸回地面,那样冲上跳台就飞不起来。
    const load = Math.max(
      0,
      CAR.suspensionStiffness * compression + CAR.suspensionDamping * compressionRate,
    );
    wheel.length = distance;
    wheel.load = load;

    // 接地点。
    contact.copy(chassisUp).multiplyScalar(-distance).add(attach);

    if (load <= 0) {
      wheel.slipRatio = 0;
      wheel.slipAngle = 0;
      this.integrateSpin(wheel, input, 0, dt);
      return { lateral: 0, saturation: 0 };
    }

    // 悬挂力沿接触法线施加:在带侧倾的赛道上,这才是路面真正推车的方向。
    this.physics.addForceAtPoint(
      this.body,
      normal.x * load, normal.y * load, normal.z * load,
      contact.x, contact.y, contact.z,
    );

    // 轮子指向:前轮跟着方向盘绕车身 up 轴转。
    wheelForward.copy(chassisForward);
    if (wheel.steered) {
      wheelForward.applyAxisAngle(chassisUp, this.steerAngle);
    }
    // 投影到接触平面上,否则上下坡时纵向力会有一个虚假的垂直分量。
    wheelForward.addScaledVector(normal, -wheelForward.dot(normal));
    const forwardLength = wheelForward.length();
    if (forwardLength < 1e-6) {
      return { lateral: 0, saturation: 0 };
    }
    wheelForward.divideScalar(forwardLength);
    // n × forward 在右手系里指向驾驶员左侧,和局部 +X 的约定一致。
    wheelLeft.copy(normal).cross(wheelForward);

    // 接地点速度。
    arm.set(contact.x - s.x, contact.y - s.y, contact.z - s.z);
    pointVelocity.set(s.wx, s.wy, s.wz).cross(arm);
    pointVelocity.x += s.vx;
    pointVelocity.y += s.vy;
    pointVelocity.z += s.vz;

    const vLong = pointVelocity.dot(wheelForward);
    const vLeft = pointVelocity.dot(wheelLeft);
    const reference = Math.max(Math.abs(vLong), SLIP_SPEED_FLOOR);

    const slipRatio = (wheel.spin * CAR.wheelRadius - vLong) / reference;
    // 侧偏角:速度方向偏离轮子指向多少。用夹住的参考速度,免得低速时发散。
    const slipAngle = Math.atan2(vLeft, reference);
    wheel.slipRatio = slipRatio;
    wheel.slipAngle = slipAngle;

    tireState.slipRatio = slipRatio;
    tireState.slipAngle = slipAngle;
    tireState.load = load;
    // 路肩和赛道外的沙地抓地更差 —— 压出去要付代价,这是宪法要求的。
    tireState.friction = this.hit.onTrack ? 1 : 0.55;
    tireForce(tireState, tireOut);

    const fx = tireOut.longitudinal;
    const fy = tireOut.lateral;
    this.physics.addForceAtPoint(
      this.body,
      wheelForward.x * fx + wheelLeft.x * fy,
      wheelForward.y * fx + wheelLeft.y * fy,
      wheelForward.z * fx + wheelLeft.z * fy,
      contact.x, contact.y, contact.z,
    );

    this.integrateSpin(wheel, input, fx, dt);

    // 摩擦预算的用满程度。到 1 就是滑出去了,给音效和 HUD 用。
    const budget = load * TIRE.mu0;
    return {
      lateral: fy,
      saturation: budget > 0 ? Math.min(1, Math.hypot(fx, fy) / budget) : 0,
    };
  }

  /**
   * 车轮转速的积分。
   *
   * **这是打滑和抱死的来源。** 驱动力矩让轮子转得比地面快(滑移率为正 → 烧胎),
   * 制动力矩让它转得比地面慢(滑移率为负 → 抱死拖滑)。没有这一步的话,
   * 滑移率只能从油门开度硬编出来,那就退回街机手感了。
   */
  private integrateSpin(wheel: Wheel, input: InputFrame, tractionForce: number, dt: number): void {
    const drive =
      (input.throttle * CAR.driveTorque -
        input.reverse * CAR.driveTorque * CAR.reverseTorqueScale) *
      wheel.driveShare;

    // 地面对轮子的反力矩:轮子推地面往后,地面就拖着轮子减速。
    let torque = drive - tractionForce * CAR.wheelRadius;

    let next = wheel.spin + (torque / CAR.wheelInertia) * dt;

    // 刹车只能让轮子趋向静止,不能把它拉过零点反着转 —— 那是倒车,不是刹车。
    const brake = input.airBrake * CAR.brakeTorque * wheel.brakeShare;
    if (brake > 0) {
      const delta = (brake / CAR.wheelInertia) * dt;
      next = next > 0 ? Math.max(0, next - delta) : Math.min(0, next + delta);
    }

    wheel.spin = Number.isFinite(next) ? next : 0;
    void torque;
  }

  /** 空气阻力与下压力。 */
  private applyAero(): void {
    const s = this.state;
    const speedSq = s.vx * s.vx + s.vy * s.vy + s.vz * s.vz;
    if (speedSq < 1e-6) {
      return;
    }
    const speed = Math.sqrt(speedSq);

    // 阻力与速度反向,大小正比于 v²。
    const drag = CAR.dragArea * speedSq;
    scratch.set(-s.vx / speed, -s.vy / speed, -s.vz / speed).multiplyScalar(drag);

    // 下压力沿车身向下:速度越高抓地越强,高速弯反而比低速弯稳。
    const down = CAR.downforce * speedSq;
    scratch.addScaledVector(chassisUp, -down);

    this.physics.addForceAtPoint(
      this.body,
      scratch.x, scratch.y, scratch.z,
      s.x, s.y, s.z,
    );
  }

  /** 把刚体状态写回公开字段,供渲染、相机、计时读取。 */
  private writeBack(): void {
    const s = this.state;
    this.position.set(s.x, s.y, s.z);
    this.velocity.set(s.vx, s.vy, s.vz);
    this.orientation.set(s.qx, s.qy, s.qz, s.qw);
    this.readBasis();

    // 偏航角由车头的水平投影反解,和 forward = (sin yaw, 0, cos yaw) 一致。
    this.yaw = Math.atan2(chassisForward.x, chassisForward.z);
    this.yawRate = s.wy;

    this.field.sample(s.x, s.z, this.hit);
    this.clearance = s.y - this.hit.height;
    this.onTrack = this.hit.onTrack;
    this.lateral = this.hit.lateral;
    this.arc = this.hit.arc;

    // 侧向速度正值向右,而 chassisLeft 指向左,所以取负。
    this.lateralSpeed = -this.velocity.dot(chassisLeft);
  }

  /**
   * 护墙。仍然用解析判定 + 冲量,没有交给引擎的碰撞体 ——
   * 墙是沿赛道条带外缘生成的,`wallDistance` 已经是精确的横向距离,
   * 再造一套三角网碰撞体等于引入第二个面,正是不变量 1 要避免的事。
   */
  private resolveWall(): void {
    const limit = this.hit.wallDistance - CAR.halfWidth;
    if (!Number.isFinite(limit)) {
      this.wallImpact = 0;
      return;
    }

    const lateral = this.hit.lateral;
    if (!Number.isFinite(lateral) || Math.abs(lateral) <= limit) {
      this.wallImpact = 0;
      return;
    }

    // 墙的法线就是赛道横向轴,朝向赛道内侧。
    scratch.set(-this.hit.tangentZ, 0, this.hit.tangentX);
    const outward = Math.sign(lateral);
    const overshoot = Math.abs(lateral) - limit;

    const s = this.state;
    this.position.addScaledVector(scratch, -overshoot * outward);
    this.physics.setTransform(
      this.body,
      this.position.x, this.position.y, this.position.z,
      s.qx, s.qy, s.qz, s.qw,
    );

    const normalSpeed = this.velocity.dot(scratch) * outward;
    if (normalSpeed <= 0) {
      this.wallImpact = 0;
      return;
    }

    this.velocity.addScaledVector(
      scratch,
      -normalSpeed * (1 + CAR.wallRestitution) * outward,
    );
    this.physics.setVelocity(
      this.body,
      this.velocity.x, this.velocity.y, this.velocity.z,
      s.wx, s.wy, s.wz,
    );

    const speed = this.velocity.length() || 1;
    // 撞击角:法向速度占总速度的比例。正面撞接近 1,擦墙接近 0。
    this.wallImpact = Math.min(1, normalSpeed / speed) * normalSpeed;
  }
}

function makeWheel(
  localX: number,
  localZ: number,
  steered: boolean,
  driveShare: number,
  brakeShare: number,
): Wheel {
  return {
    localX,
    localZ,
    steered,
    driveShare,
    brakeShare,
    spin: 0,
    length: CAR.suspensionRest,
    grounded: false,
    load: 0,
    slipRatio: 0,
    slipAngle: 0,
  };
}
