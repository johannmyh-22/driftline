import { Matrix4, Quaternion, Vector3 } from 'three';
import type { InputFrame } from '../core/input';
import { clamp, damp, lerp, normalize01 } from '../core/mathx';
import { type GroundHit, type Heightfield, createGroundHit } from './heightfield';
import { REFERENCE_TOP_SPEED, VEHICLE } from './tuning';

// 每帧路径上的临时量,全部提到模块作用域复用。60Hz 下新建 Vector3 的 GC 抖动看得见。
const forward = new Vector3();
const right = new Vector3();
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
 * 车头朝向局部 +Z。偏航角 `yaw` 绕世界 Y 轴,`yaw = 0` 时车头指向 +Z;
 * yaw 增大 = 俯视顺时针 = 右转。
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
  /** 车体坐标系下的侧向速度,正值表示向右滑。漂移感就看它。 */
  lateralSpeed = 0;

  private readonly field: Heightfield;
  private readonly hit: GroundHit = createGroundHit();
  private readonly surfaceUp = new Vector3(0, 1, 0);
  private smoothedForwardAccel = 0;

  constructor(field: Heightfield) {
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

    forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    this.applyHover(dt);
    this.applySteering(input, dt);
    this.applyThrust(input, dt);
    this.applyDrag(input, dt);
    this.applyLateralGrip(input, dt);

    this.position.addScaledVector(this.velocity, dt);

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

    const target = input.steer * maxYawRate * authority;
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
    this.lateralSpeed = this.velocity.dot(right);

    let grip = this.grounded ? VEHICLE.lateralGrip : VEHICLE.lateralGripAirborne;
    if (this.grounded) {
      grip += VEHICLE.airBrakeGripBonus * input.airBrake;
    }

    const removed = this.lateralSpeed * (1 - Math.exp(-grip * dt));
    this.velocity.addScaledVector(right, -removed);
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
    right.copy(up).cross(forward).normalize();

    basis.makeBasis(right, up, forward);
    this.orientation.setFromRotationMatrix(basis);

    const bank = clamp(this.lateralSpeed * VEHICLE.bankPerLateralSpeed, -VEHICLE.bankMax, VEHICLE.bankMax);
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
