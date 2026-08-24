import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { clamp, damp, lerp, normalize01 } from '../core/mathx';
import { type GroundHit, type GroundQuery, createGroundHit } from './groundQuery';
import { CAMERA, REFERENCE_TOP_SPEED } from './tuning';
import type { Vehicle } from './vehicle';

const desired = new Vector3();
const lookTarget = new Vector3();
const forward = new Vector3();
const shownPosition = new Vector3();
const shownLook = new Vector3();
const upAxis = new Vector3(0, 1, 0);
/** 注视点处的地面查询结果。每帧路径上,复用。 */
const lookHit = createGroundHit();
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

  private readonly field: GroundQuery;
  private readonly hit: GroundHit = createGroundHit();

  private readonly position = new Vector3();
  private readonly look = new Vector3();
  private fov: number = CAMERA.fovBase;
  private roll = 0;

  private readonly prevPosition = new Vector3();
  private readonly prevLook = new Vector3();
  private prevFov: number = CAMERA.fovBase;
  private prevRoll = 0;

  constructor(field: GroundQuery, aspect = 16 / 9) {
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
      .addScaledVector(upAxis, CAMERA.offsetUp);

    /*
     * 前馈抵消稳态滞后,否则速度一上来车就缩成画面里的一个点。
     *
     * 只取速度在**车头方向**上的分量,不用完整的速度矢量:侧滑时两者能差
     * 几十度,按完整矢量前馈会把相机推到侧面去,画面看着「偏得离谱」。
     * 滞后本来就只发生在前后方向上,横向那份前馈纯属副作用。
     */
    const along = vehicle.velocity.x * forward.x + vehicle.velocity.z * forward.z;
    desired.addScaledVector(forward, (along * CAMERA.lagCompensation) / CAMERA.positionLambda);

    lookTarget
      .copy(vehicle.position)
      .addScaledVector(forward, CAMERA.lookAhead)
      .addScaledVector(upAxis, CAMERA.lookUp);

    /*
     * 注视点跟着**前方地面**走,而不是钉在车身的水平前方。
     *
     * 钉死的话上坡时路面从下方抬起来糊住画面,看不到前面的路;下坡时又只剩天。
     * 这里取车前方 `lookAhead` 处的地面高度,把注视点抬到它上面 `lookUp`,
     * 相机自然就有了俯仰。落差用 `slopeLookLimit` 夹住:跳台边缘那种断崖会让
     * 采样点比车低十几米,不夹的话镜头会突然甩向地面。
     */
    this.field.sample(lookTarget.x, lookTarget.z, lookHit);
    const groundLook = lookHit.height + CAMERA.lookUp;
    const flatLook = vehicle.position.y + CAMERA.lookUp;
    lookTarget.y =
      flatLook + clamp(groundLook - flatLook, -CAMERA.slopeLookLimit, CAMERA.slopeLookLimit);
  }
}
