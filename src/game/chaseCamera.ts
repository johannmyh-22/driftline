import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { clamp, damp, lerp, normalize01 } from '../core/mathx';
import { prefersReducedMotion } from '../core/reducedMotion';
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
/** 自由视角:相机相对车的偏移方向,以及俯仰用的水平右轴。每帧路径上,复用。 */
const orbitOffset = new Vector3();
const orbitRight = new Vector3();
const carFocus = new Vector3();

/**
 * 跟随相机。
 *
 * 三样东西共同制造速度感,缺一个都会「快但不觉得快」:位置弹簧(加速时
 * 相机被甩在后面)、随速度增大的 FOV(视野边缘拉伸)、以及跟着偏航角
 * 速度走的轻微滚转。
 *
 * 状态在固定步里推进(保证同 seed 同输入 → 同一帧画面),渲染时再用
 * `present(alpha)` 插值,所以高刷新率下也不会看到 60Hz 的台阶。
 *
 * `reducedMotion` 默认读 `prefers-reduced-motion` 操作系统偏好,只影响开了
 * 这个偏好的用户:滚转(转动画面的轴,前庭刺激最强)完全关掉,FOV 拉伸按
 * `CAMERA.reducedMotionFovScale` 收窄但不清零(仍要看得出「快了」)。默认
 * 关闭这个偏好的用户画面一个像素不变——已验收的手感/观感(第十九、二十节)
 * 不受影响。
 */
export class ChaseCamera {
  readonly camera: PerspectiveCamera;

  private readonly field: GroundQuery;
  private readonly hit: GroundHit = createGroundHit();
  private readonly reducedMotion: boolean;

  private readonly position = new Vector3();
  private readonly look = new Vector3();
  private fov: number = CAMERA.fovBase;
  private roll = 0;
  /** 鼠标自由视角的当前角度(平滑之后的,不是鼠标的瞬时目标值)。 */
  private lookYaw = 0;
  private lookPitch = 0;

  private readonly prevPosition = new Vector3();
  private readonly prevLook = new Vector3();
  private prevFov: number = CAMERA.fovBase;
  private prevRoll = 0;

  constructor(field: GroundQuery, aspect = 16 / 9, reducedMotion = prefersReducedMotion()) {
    this.field = field;
    this.reducedMotion = reducedMotion;
    this.camera = new PerspectiveCamera(CAMERA.fovBase, aspect, 0.1, 3000);
  }

  /**
   * 设置鼠标自由视角的目标角度(弧度)。由 `main.ts` 每个固定步从 `MouseLook`
   * 喂进来;`?test=1` 下没人调,相机行为和以前逐帧一致。
   */
  setLookAngles(yaw: number, pitch: number, dt: number): void {
    const k = 1 - Math.exp(-CAMERA.lookFollowLambda * dt);
    this.lookYaw += (yaw - this.lookYaw) * k;
    this.lookPitch += (pitch - this.lookPitch) * k;
  }

  /** 直接落到目标位姿。重生时用,免得镜头从上一局的位置飞过来。 */
  snapTo(vehicle: Vehicle): void {
    this.lookYaw = 0;
    this.lookPitch = 0;
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
    const fovGain = this.reducedMotion ? CAMERA.fovGain * CAMERA.reducedMotionFovScale : CAMERA.fovGain;
    this.fov = damp(this.fov, CAMERA.fovBase + fovGain * speed01, CAMERA.fovLambda, dt);

    const targetRoll = this.reducedMotion
      ? 0
      : clamp(
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

    /*
     * 相机相对车的偏移。自由视角就是把这个偏移**绕着车**转:先绕世界 Y 轴
     * 转偏航,再绕「转完之后的水平右轴」转俯仰。绕车转而不是原地转头,车才
     * 会始终留在画面里——原地转头看到的是空地,那不是第三人称的环视。
     */
    orbitOffset
      .set(0, 0, 0)
      .addScaledVector(forward, -CAMERA.offsetBack)
      .addScaledVector(upAxis, CAMERA.offsetUp);

    if (this.lookYaw !== 0 || this.lookPitch !== 0) {
      orbitOffset.applyAxisAngle(upAxis, this.lookYaw);
      orbitRight.crossVectors(upAxis, orbitOffset);
      if (orbitRight.lengthSq() > 1e-8) {
        orbitRight.normalize();
        // 取负:鼠标下移(movementY 为正 → lookPitch 为正)是「往下看」,对
        // 第三人称环绕机位来说就是相机**抬高**去俯视车,不是把相机压进地里。
        orbitOffset.applyAxisAngle(orbitRight, -this.lookPitch);
      }
    }

    desired.copy(vehicle.position).add(orbitOffset);

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

    /*
     * 一开始环视就把注视点从「车前方的路」挪到「车本身」。不挪的话镜头绕到
     * 侧面时仍然盯着车头前方,车会直接滑出画面——那是转头,不是环视。
     */
    const freeAmount = clamp(
      (Math.abs(this.lookYaw) + Math.abs(this.lookPitch)) / CAMERA.lookFocusAngle,
      0,
      1,
    );
    if (freeAmount > 0) {
      carFocus.copy(vehicle.position).addScaledVector(upAxis, CAMERA.lookUp);
      lookTarget.lerp(carFocus, freeAmount);
    }
  }
}
