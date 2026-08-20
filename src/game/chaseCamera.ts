import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { clamp, damp, lerp, normalize01 } from '../core/mathx';
import { type GroundHit, type Heightfield, createGroundHit } from './heightfield';
import { CAMERA, REFERENCE_TOP_SPEED } from './tuning';
import type { Vehicle } from './vehicle';

const desired = new Vector3();
const lookTarget = new Vector3();
const forward = new Vector3();
const shownPosition = new Vector3();
const shownLook = new Vector3();
const upAxis = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);
const rollQuat = new Quaternion();

/**
 * 跟随相机。
 *
 * 三样东西共同制造速度感,缺一个都会「快但不觉得快」:位置弹簧(加速时
 * 相机被甩在后面)、随速度增大的 FOV(视野边缘拉伸)、以及跟着偏航角
 * 速度走的轻微滚转。
 *
 * 状态在固定步里推进(保证同 seed 同输入 → 同一帧画面),渲染时再用
 * `present(alpha)` 插值,所以高刷新率下也不会看到 60Hz 的台阶。
 */
export class ChaseCamera {
  readonly camera: PerspectiveCamera;

  private readonly field: Heightfield;
  private readonly hit: GroundHit = createGroundHit();

  private readonly position = new Vector3();
  private readonly look = new Vector3();
  private fov: number = CAMERA.fovBase;
  private roll = 0;

  private readonly prevPosition = new Vector3();
  private readonly prevLook = new Vector3();
  private prevFov: number = CAMERA.fovBase;
  private prevRoll = 0;

  constructor(field: Heightfield, aspect = 16 / 9) {
    this.field = field;
    this.camera = new PerspectiveCamera(CAMERA.fovBase, aspect, 0.1, 3000);
  }

  /** 直接落到目标位姿。重生时用,免得镜头从上一局的位置飞过来。 */
  snapTo(vehicle: Vehicle): void {
    this.computeDesired(vehicle);
    this.position.copy(desired);
    this.look.copy(lookTarget);
    this.fov = CAMERA.fovBase;
    this.roll = 0;
    this.savePrevious();
    this.present(1);
  }

  update(vehicle: Vehicle, dt: number): void {
    this.savePrevious();
    this.computeDesired(vehicle);

    this.position.lerp(desired, 1 - Math.exp(-CAMERA.positionLambda * dt));
    this.look.lerp(lookTarget, 1 - Math.exp(-CAMERA.lookLambda * dt));

    // 不许钻进地里。
    this.field.sample(this.position.x, this.position.z, this.hit);
    const floor = this.hit.height + CAMERA.minGroundClearance;
    if (this.position.y < floor) {
      this.position.y = floor;
    }

    const speed01 = normalize01(vehicle.groundSpeed, 0, REFERENCE_TOP_SPEED);
    this.fov = damp(this.fov, CAMERA.fovBase + CAMERA.fovGain * speed01, CAMERA.fovLambda, dt);

    const targetRoll = clamp(
      -vehicle.yawRate * CAMERA.rollPerYawRate * (0.35 + speed01),
      -CAMERA.rollMax,
      CAMERA.rollMax,
    );
    this.roll = damp(this.roll, targetRoll, CAMERA.rollLambda, dt);
  }

  present(alpha: number): void {
    shownPosition.lerpVectors(this.prevPosition, this.position, alpha);
    shownLook.lerpVectors(this.prevLook, this.look, alpha);

    this.camera.position.copy(shownPosition);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(shownLook);

    const roll = lerp(this.prevRoll, this.roll, alpha);
    if (roll !== 0) {
      rollQuat.setFromAxisAngle(AXIS_Z, roll);
      this.camera.quaternion.multiply(rollQuat);
    }

    const fov = lerp(this.prevFov, this.fov, alpha);
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  private savePrevious(): void {
    this.prevPosition.copy(this.position);
    this.prevLook.copy(this.look);
    this.prevFov = this.fov;
    this.prevRoll = this.roll;
  }

  private computeDesired(vehicle: Vehicle): void {
    forward.set(Math.sin(vehicle.yaw), 0, Math.cos(vehicle.yaw));

    desired
      .copy(vehicle.position)
      .addScaledVector(forward, -CAMERA.offsetBack)
      .addScaledVector(upAxis, CAMERA.offsetUp)
      // 前馈抵消稳态滞后,否则速度一上来车就缩成画面里的一个点。
      .addScaledVector(vehicle.velocity, CAMERA.lagCompensation / CAMERA.positionLambda);

    lookTarget
      .copy(vehicle.position)
      .addScaledVector(forward, CAMERA.lookAhead)
      .addScaledVector(upAxis, CAMERA.lookUp);
  }
}
