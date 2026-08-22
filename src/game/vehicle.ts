import { Matrix4, Quaternion, Vector3 } from 'three';
import type { InputFrame } from '../core/input';
import { clamp, damp, normalize01 } from '../core/mathx';
import { type GroundHit, type GroundQuery, createGroundHit } from './groundQuery';
import { type BodyState, type Physics, createBodyState } from './physics';
import { type TireForce, type TireState, tireForce } from './tire';
import {
  appliedSlot,
  beginTelemetryFrame,
  commitApplied,
  commitFrame,
  commitWheel,
  frameSlot,
  wheelSlot,
} from './diagnostics';
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
const mat = new Matrix4();

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

interface WheelContext {
  grounded: boolean;
  load: number;
  distance: number;
  compression: number;
  vLong: number;
  vLeft: number;
  reference: number;
  slipAngle: number;
  friction: number;
  contactX: number;
  contactY: number;
  contactZ: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  wfX: number;
  wfY: number;
  wfZ: number;
  wlX: number;
  wlY: number;
  wlZ: number;
}

function createWheelContext(): WheelContext {
  return {
    grounded: false,
    load: 0,
    distance: CAR.suspensionRest,
    compression: 0,
    vLong: 0,
    vLeft: 0,
    reference: SLIP_SPEED_FLOOR,
    slipAngle: 0,
    friction: 1,
    contactX: 0,
    contactY: 0,
    contactZ: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    wfX: 0,
    wfY: 0,
    wfZ: 1,
    wlX: 1,
    wlY: 0,
    wlZ: 0,
  };
}

const contexts: [WheelContext, WheelContext, WheelContext, WheelContext] = [
  createWheelContext(),
  createWheelContext(),
  createWheelContext(),
  createWheelContext(),
];

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

  private _yaw = 0;
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

  get yaw(): number {
    return this._yaw;
  }

  set yaw(value: number) {
    const delta = value - this._yaw;
    this._yaw = value;
    if (Math.abs(delta) > 1e-5) {
      spin.setFromAxisAngle(chassisUp, delta);
      this.orientation.premultiply(spin);
      this.physics.setTransform(
        this.body,
        this.position.x,
        this.position.y,
        this.position.z,
        this.orientation.x,
        this.orientation.y,
        this.orientation.z,
        this.orientation.w,
      );
      this.physics.setVelocity(
        this.body,
        this.velocity.x,
        this.velocity.y,
        this.velocity.z,
        this.state.wx,
        this.state.wy,
        this.state.wz,
      );
    }
  }

  reset(x = 0, z = 0, yaw = 0): void {
    this.field.sample(x, z, this.hit);

    // 静止时悬挂已经被车重压掉一截,直接放在完全伸展的高度上,车会先掉下来弹一下。
    const staticCompression = Math.min(
      CAR.suspensionTravel,
      (CAR.mass * VEHICLE.gravity) / 4 / CAR.suspensionStiffness,
    );
    const rideHeight = CAR.suspensionRest - staticCompression;

    this._yaw = yaw;
    this.yawRate = 0;
    this.steerAngle = 0;

    // 出生点姿态对齐地面法线,消除出生点不对称引起的初始翻滚与偏航扰动
    const gNorm = scratch.set(this.hit.normalX, this.hit.normalY, this.hit.normalZ);
    const heading = arm.set(Math.sin(yaw), 0, Math.cos(yaw));
    heading.addScaledVector(gNorm, -heading.dot(gNorm));
    if (heading.lengthSq() > 1e-6) {
      heading.normalize();
    } else {
      heading.set(0, 0, 1);
    }
    const gLeft = pointVelocity.crossVectors(gNorm, heading).normalize();

    mat.makeBasis(gLeft, gNorm, heading);
    this.orientation.setFromRotationMatrix(mat);

    this.position.set(x, this.hit.height, z).addScaledVector(gNorm, rideHeight);
    this.velocity.set(0, 0, 0);
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
      wheel.length = rideHeight;
      wheel.grounded = true;
      wheel.load = (CAR.mass * VEHICLE.gravity) / 4;
      wheel.slipRatio = 0;
      wheel.slipAngle = 0;
    }

    this.physics.setTransform(
      this.body,
      this.position.x,
      this.position.y,
      this.position.z,
      this.orientation.x,
      this.orientation.y,
      this.orientation.z,
      this.orientation.w,
    );
    this.physics.setVelocity(this.body, 0, 0, 0, 0, 0, 0);
  }

  update(input: InputFrame, dt: number): void {
    // 先清掉上一步的力:Rapier 的 addForce 是持续力,不清会逐帧累加成指数爆炸。
    this.physics.resetForces(this.body);
    // 清空上一帧的遥测缓冲,免得「上一帧接地、这一帧离地」的轮子残留旧数据。
    beginTelemetryFrame();

    this.physics.read(this.body, this.state);
    this.readBasis();

    this.updateSteering(input, dt);

    const s = this.state;
    const maxLength = CAR.suspensionRest;
    const upComponent = chassisUp.y;

    // 阶段 1: 几何采样、悬挂压缩与法向力计算
    for (let i = 0; i < this.wheels.length; i++) {
      const wheel = this.wheels[i]!;
      const ctx = contexts[i]!;

      attach.set(wheel.localX, 0, wheel.localZ).applyQuaternion(spin);
      attach.x += s.x;
      attach.y += s.y;
      attach.z += s.z;

      this.field.sample(attach.x, attach.z, this.hit);
      normal.set(this.hit.normalX, this.hit.normalY, this.hit.normalZ);

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

        ctx.grounded = false;
        ctx.load = 0;
        ctx.distance = maxLength;
        ctx.compression = 0;
        ctx.vLong = 0;
        ctx.vLeft = 0;
        ctx.reference = SLIP_SPEED_FLOOR;
        ctx.slipAngle = 0;
        ctx.friction = 1;
        ctx.normalX = normal.x;
        ctx.normalY = normal.y;
        ctx.normalZ = normal.z;

        wheelSlot.grounded = false;
        wheelSlot.length = maxLength;
        wheelSlot.compression = 0;
        wheelSlot.load = 0;
        wheelSlot.slipRatio = 0;
        wheelSlot.slipAngle = 0;
        wheelSlot.fx = 0;
        wheelSlot.fy = 0;
        wheelSlot.px = 0;
        wheelSlot.py = 0;
        wheelSlot.pz = 0;
        wheelSlot.wfX = 0;
        wheelSlot.wfY = 0;
        wheelSlot.wfZ = 0;
        wheelSlot.wlX = 0;
        wheelSlot.wlY = 0;
        wheelSlot.wlZ = 0;
        commitWheel(i);
        continue;
      }

      wheel.grounded = true;
      const compression = clamp(maxLength - distance, 0, CAR.suspensionTravel);

      arm.set(attach.x - s.x, attach.y - s.y, attach.z - s.z);
      pointVelocity.set(s.wx, s.wy, s.wz).cross(arm);
      pointVelocity.x += s.vx;
      pointVelocity.y += s.vy;
      pointVelocity.z += s.vz;

      const minLength = maxLength - CAR.suspensionTravel;
      const penetration = Math.max(0, minLength - distance);
      const bumpStopForce = penetration * 150_000;

      const compressionRate = -pointVelocity.dot(chassisUp);
      const load = Math.max(
        0,
        CAR.suspensionStiffness * compression +
          CAR.suspensionDamping * compressionRate +
          bumpStopForce,
      );
      wheel.length = Math.max(0, distance);
      wheel.load = load;

      contact.copy(chassisUp).multiplyScalar(-Math.max(0, distance)).add(attach);

      wheelForward.copy(chassisForward);
      if (wheel.steered) {
        wheelForward.applyAxisAngle(chassisUp, this.steerAngle);
      }
      wheelForward.addScaledVector(normal, -wheelForward.dot(normal));
      const fwdLen = wheelForward.length();
      if (fwdLen > 1e-6) {
        wheelForward.divideScalar(fwdLen);
      } else {
        wheelForward.copy(chassisForward);
      }
      wheelLeft.copy(normal).cross(wheelForward);

      arm.set(contact.x - s.x, contact.y - s.y, contact.z - s.z);
      pointVelocity.set(s.wx, s.wy, s.wz).cross(arm);
      pointVelocity.x += s.vx;
      pointVelocity.y += s.vy;
      pointVelocity.z += s.vz;

      const vLong = pointVelocity.dot(wheelForward);
      const vLeft = pointVelocity.dot(wheelLeft);
      const reference = Math.max(Math.abs(vLong), SLIP_SPEED_FLOOR);
      const slipAngle = Math.atan2(vLeft, reference);
      const friction = this.hit.onTrack ? 1 : 0.55;

      ctx.grounded = true;
      ctx.load = load;
      ctx.distance = distance;
      ctx.compression = compression;
      ctx.contactX = contact.x;
      ctx.contactY = contact.y;
      ctx.contactZ = contact.z;
      ctx.normalX = normal.x;
      ctx.normalY = normal.y;
      ctx.normalZ = normal.z;
      ctx.wfX = wheelForward.x;
      ctx.wfY = wheelForward.y;
      ctx.wfZ = wheelForward.z;
      ctx.wlX = wheelLeft.x;
      ctx.wlY = wheelLeft.y;
      ctx.wlZ = wheelLeft.z;
      ctx.vLong = vLong;
      ctx.vLeft = vLeft;
      ctx.reference = reference;
      ctx.slipAngle = slipAngle;
      ctx.friction = friction;

      if (load > 0) {
        this.physics.addForceAtPoint(
          this.body,
          normal.x * load,
          normal.y * load,
          normal.z * load,
          contact.x,
          contact.y,
          contact.z,
        );
      }
    }

    // 阶段 2: 隐式单调轮速求解器 + 限滑差速器(LSD)耦合
    const R = CAR.wheelRadius;
    const I = CAR.wheelInertia;
    const invDt = 1 / dt;
    const CI = I * invDt;
    const throttleTorque =
      input.throttle * CAR.driveTorque -
      input.reverse * CAR.driveTorque * CAR.reverseTorqueScale;

    // 驱动/差速计算: 后轴左右轮耦合求解
    const ctx2 = contexts[2]!;
    const ctx3 = contexts[3]!;
    const rearDriveTotal = throttleTorque * CAR.rearDriveBias;
    const w2_old = this.wheels[2]!.spin;
    const w3_old = this.wheels[3]!.spin;

    const vLong_avg = (ctx2.vLong + ctx3.vLong) / 2;
    const load_rear = ctx2.load + ctx3.load;
    const fz0 = TIRE.staticLoadPerWheel;
    const fric_rear = (ctx2.friction + ctx3.friction) / 2;
    const mu_rear = Math.max(
      0,
      TIRE.mu0 * fric_rear * (1 - (TIRE.loadSensitivity * (load_rear / 2 - fz0)) / fz0),
    );
    const peak_rear = mu_rear * load_rear;
    const ref_rear = Math.max((ctx2.reference + ctx3.reference) / 2, SLIP_SPEED_FLOOR);
    const peak_torque = peak_rear * R;

    let w_avg: number;
    if (load_rear > 0 && Math.abs(rearDriveTotal) <= peak_torque) {
      const targetSlip = TIRE.peakSlipRatio * (rearDriveTotal / peak_torque);
      const w_target = (vLong_avg + targetSlip * ref_rear) / R;
      const K_rear = (peak_rear * R * R) / (TIRE.peakSlipRatio * ref_rear);
      w_avg = (2 * CI * ((w2_old + w3_old) / 2) + K_rear * w_target) / (2 * CI + K_rear);
    } else if (load_rear > 0) {
      const targetSlip = TIRE.peakSlipRatio * 1.05 * Math.sign(rearDriveTotal);
      const w_target = (vLong_avg + targetSlip * ref_rear) / R;
      const K_rear = (peak_rear * R * R) / (TIRE.peakSlipRatio * ref_rear);
      w_avg = (2 * CI * ((w2_old + w3_old) / 2) + K_rear * w_target) / (2 * CI + K_rear);
    } else {
      w_avg = (w2_old + w3_old) / 2 + (rearDriveTotal / (2 * I)) * dt;
    }

    const kLock = CAR.differentialLock;
    const w_diff = (CI * (w2_old - w3_old)) / (CI + 2 * kLock);

    let w2_final = w_avg + w_diff / 2;
    let w3_final = w_avg - w_diff / 2;

    const brakeRear = (input.airBrake * CAR.brakeTorque * (1 - CAR.frontBrakeBias)) / 2;
    if (brakeRear > 0) {
      const deltaBrake = (brakeRear / I) * dt;
      w2_final =
        w2_final > 0 ? Math.max(0, w2_final - deltaBrake) : Math.min(0, w2_final + deltaBrake);
      w3_final =
        w3_final > 0 ? Math.max(0, w3_final - deltaBrake) : Math.min(0, w3_final + deltaBrake);
    }

    const maxSpin = (REFERENCE_TOP_SPEED * 1.15) / CAR.wheelRadius;
    const airborneSpinLimit = (this.groundSpeed + 3) / R;
    if (!ctx2.grounded) {
      w2_final = Math.min(w2_final, airborneSpinLimit);
    }
    if (!ctx3.grounded) {
      w3_final = Math.min(w3_final, airborneSpinLimit);
    }
    w2_final = clamp(w2_final, -maxSpin, maxSpin);
    w3_final = clamp(w3_final, -maxSpin, maxSpin);

    this.wheels[2]!.spin = Number.isFinite(w2_final) ? w2_final : 0;
    this.wheels[3]!.spin = Number.isFinite(w3_final) ? w3_final : 0;

    // 前轮独立求解
    for (let i = 0; i < 2; i++) {
      const wheel = this.wheels[i]!;
      const ctx = contexts[i]!;
      const brakeFront = input.airBrake * CAR.brakeTorque * (CAR.frontBrakeBias / 2);
      const driveFront = throttleTorque * ((1 - CAR.rearDriveBias) / 2);

      let w = wheel.spin;
      if (ctx.grounded && ctx.load > 0) {
        const peakFront = TIRE.mu0 * ctx.friction * ctx.load;
        const peakTorqueFront = peakFront * R;
        if (Math.abs(driveFront) <= peakTorqueFront) {
          const targetSlip = TIRE.peakSlipRatio * (driveFront / peakTorqueFront);
          const w_target = (ctx.vLong + targetSlip * ctx.reference) / R;
          const KFront = (peakFront * R * R) / (TIRE.peakSlipRatio * ctx.reference);
          w = (CI * wheel.spin + KFront * w_target) / (CI + KFront);
        } else {
          const excess = driveFront - Math.sign(driveFront) * peakTorqueFront;
          w += (excess / I) * dt;
        }
      } else {
        w += (driveFront / I) * dt;
      }
      if (brakeFront > 0) {
        const deltaBrake = (brakeFront / I) * dt;
        w = w > 0 ? Math.max(0, w - deltaBrake) : Math.min(0, w + deltaBrake);
      }
      if (!ctx.grounded) {
        w = Math.min(w, airborneSpinLimit);
      }
      w = clamp(w, -maxSpin, maxSpin);
      wheel.spin = Number.isFinite(w) ? w : 0;
    }

    // 阶段 3: 施加轮胎力并收集遥测与整车合力
    let totalLateralForce = 0;
    let groundedCount = 0;
    let saturation = 0;

    for (let i = 0; i < 4; i++) {
      const wheel = this.wheels[i]!;
      const ctx = contexts[i]!;

      if (!ctx.grounded || ctx.load <= 0) {
        wheel.slipRatio = 0;
        wheel.slipAngle = 0;
        continue;
      }

      groundedCount++;
      wheel.slipRatio = (wheel.spin * R - ctx.vLong) / ctx.reference;
      wheel.slipAngle = ctx.slipAngle;

      tireState.slipRatio = wheel.slipRatio;
      tireState.slipAngle = wheel.slipAngle;
      tireState.load = ctx.load;
      tireState.friction = ctx.friction;
      tireForce(tireState, tireOut);

      const fx = tireOut.longitudinal;
      const fy = tireOut.lateral;
      const tireFx = ctx.wfX * fx + ctx.wlX * fy;
      const tireFy = ctx.wfY * fx + ctx.wlY * fy;
      const tireFz = ctx.wfZ * fx + ctx.wlZ * fy;

      this.physics.addForceAtPoint(
        this.body,
        tireFx,
        tireFy,
        tireFz,
        ctx.contactX,
        ctx.contactY,
        ctx.contactZ,
      );

      wheelSlot.grounded = true;
      wheelSlot.length = wheel.length;
      wheelSlot.compression = ctx.compression;
      wheelSlot.load = ctx.load;
      wheelSlot.slipRatio = wheel.slipRatio;
      wheelSlot.slipAngle = wheel.slipAngle;
      wheelSlot.fx = fx;
      wheelSlot.fy = fy;
      wheelSlot.px = ctx.contactX;
      wheelSlot.py = ctx.contactY;
      wheelSlot.pz = ctx.contactZ;
      wheelSlot.wfX = ctx.wfX;
      wheelSlot.wfY = ctx.wfY;
      wheelSlot.wfZ = ctx.wfZ;
      wheelSlot.wlX = ctx.wlX;
      wheelSlot.wlY = ctx.wlY;
      wheelSlot.wlZ = ctx.wlZ;
      commitWheel(i);

      appliedSlot.px = ctx.contactX;
      appliedSlot.py = ctx.contactY;
      appliedSlot.pz = ctx.contactZ;
      appliedSlot.fx = ctx.normalX * ctx.load + tireFx;
      appliedSlot.fy = ctx.normalY * ctx.load + tireFy;
      appliedSlot.fz = ctx.normalZ * ctx.load + tireFz;
      commitApplied(i);

      totalLateralForce += fy;

      const budget = ctx.load * TIRE.mu0;
      if (budget > 0) {
        saturation = Math.max(saturation, Math.min(1, Math.hypot(fx, fy) / budget));
      }
    }

    this.grounded = groundedCount > 0;
    this.gripSaturation = saturation;
    this.lateralGripAccel = Math.abs(totalLateralForce) / CAR.mass;

    // 自回正力矩与偏航阻尼: 按 tuning.ts VEHICLE.slipRestoring 施加
    if (this.grounded && this.groundSpeed > VEHICLE.slipRestoringMinSpeed) {
      const Iz = (CAR.mass * (CAR.bodyWidth * CAR.bodyWidth + CAR.bodyLength * CAR.bodyLength)) / 12;
      const vLong = this.velocity.dot(chassisForward);
      const vLeft = this.velocity.dot(chassisLeft);
      const beta = Math.atan2(vLeft, Math.max(Math.abs(vLong), SLIP_SPEED_FLOOR));
      const k = VEHICLE.slipRestoring * 8.0;
      const c = 2.0 * Math.sqrt(k);
      const restoreTorque = Iz * (k * beta - c * this.yawRate);
      const coupleForce = restoreTorque / CAR.wheelBase;
      const armL = CAR.wheelBase / 2;

      this.physics.addForceAtPoint(
        this.body,
        chassisLeft.x * coupleForce,
        chassisLeft.y * coupleForce,
        chassisLeft.z * coupleForce,
        s.x + chassisForward.x * armL,
        s.y + chassisForward.y * armL,
        s.z + chassisForward.z * armL,
      );
      this.physics.addForceAtPoint(
        this.body,
        -chassisLeft.x * coupleForce,
        -chassisLeft.y * coupleForce,
        -chassisLeft.z * coupleForce,
        s.x - chassisForward.x * armL,
        s.y - chassisForward.y * armL,
        s.z - chassisForward.z * armL,
      );
    } else if (!this.grounded) {
      const airDamp = Math.max(0, 1 - 4.0 * dt);
      this.physics.setVelocity(
        this.body,
        s.vx,
        s.vy,
        s.vz,
        s.wx * airDamp,
        s.wy * airDamp,
        s.wz * airDamp,
      );
    }

    this.applyAero();
    this.physics.step();

    this.physics.read(this.body, this.state);
    this.writeBack();
    this.resolveWall(dt);

    // 诊断探针的整车帧采样(read 之后才算数),只复写预分配槽,见 diagnostics.ts。
    frameSlot.x = this.state.x;
    frameSlot.y = this.state.y;
    frameSlot.z = this.state.z;
    frameSlot.vx = this.state.vx;
    frameSlot.vy = this.state.vy;
    frameSlot.vz = this.state.vz;
    frameSlot.qx = this.state.qx;
    frameSlot.qy = this.state.qy;
    frameSlot.qz = this.state.qz;
    frameSlot.qw = this.state.qw;
    frameSlot.yaw = this._yaw;
    frameSlot.yawRate = this.yawRate;
    commitFrame();
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
    this._yaw = Math.atan2(chassisForward.x, chassisForward.z);
    this.yawRate = s.wy;

    this.field.sample(s.x, s.z, this.hit);
    this.clearance = s.y - this.hit.height;
    this.onTrack = this.hit.onTrack;
    this.lateral = this.hit.lateral;
    this.arc = this.hit.arc;

    // 侧向速度:向车头右手边为负、向左为正(与 chassisLeft 同向)
    this.lateralSpeed = this.velocity.dot(chassisLeft);
  }

  /**
   * 护墙。仍然用解析判定 + 冲量,没有交给引擎的碰撞体 ——
   * 墙是沿赛道条带外缘生成的,`wallDistance` 已经是精确的横向距离,
   * 再造一套三角网碰撞体等于引入第二个面,正是不变量 1 要避免的事。
   */
  private resolveWall(dt: number): void {
    const limit = this.hit.wallDistance - CAR.halfWidth;
    if (!Number.isFinite(limit)) {
      this.wallImpact = 0;
      return;
    }

    const lateral = this.hit.lateral;
    if (
      !Number.isFinite(lateral) ||
      Math.abs(lateral) <= limit ||
      Math.abs(lateral) > this.hit.wallDistance + 3.0
    ) {
      this.wallImpact = 0;
      return;
    }

    // scratch 指向内侧 (向中心线)。Course.sample 中 lateral > 0 为右侧,故向内为 (-right)
    const outward = Math.sign(lateral);
    scratch.set(this.hit.tangentZ * outward, 0, -this.hit.tangentX * outward);
    const overshoot = Math.min(1.5, Math.abs(lateral) - limit);

    const s = this.state;
    this.position.addScaledVector(scratch, overshoot);
    this.physics.setTransform(
      this.body,
      this.position.x,
      this.position.y,
      this.position.z,
      s.qx,
      s.qy,
      s.qz,
      s.qw,
    );

    const inwardSpeed = this.velocity.dot(scratch);
    if (inwardSpeed >= 0) {
      this.wallImpact = 0;
      return;
    }

    const restitution = 1 + CAR.wallRestitution;
    this.velocity.addScaledVector(scratch, -inwardSpeed * restitution);

    // 护墙摩擦力: 沿车身前进方向阻尼速度与偏航角速度
    const fwdSpeed = this.velocity.dot(chassisForward);
    this.velocity.addScaledVector(
      chassisForward,
      -fwdSpeed * Math.min(1, CAR.wallFriction * 10 * dt),
    );
    const dampedWy = s.wy * Math.max(0, 1 - CAR.wallFriction * 10 * dt);

    this.physics.setVelocity(
      this.body,
      this.velocity.x,
      this.velocity.y,
      this.velocity.z,
      s.wx,
      dampedWy,
      s.wz,
    );

    this.field.sample(this.position.x, this.position.z, this.hit);
    this.lateral = this.hit.lateral;
    this.onTrack = this.hit.onTrack;

    const speed = this.velocity.length() || 1;
    this.wallImpact = Math.min(1, -inwardSpeed / speed) * -inwardSpeed;
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
