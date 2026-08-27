import { Mesh, Quaternion, Vector3 } from 'three';
import { type InputFrame, RecordedInput, createInputFrame } from '../core/input';
import type { Rng } from '../core/rng';
import { type Craft, createCraft } from '../gfx/craft';
import type { Palette } from '../gfx/palette';
import { normalize01 } from '../core/mathx';
import type { GroundQuery } from './groundQuery';
import { Physics } from './physics';
import { Race } from './race';
import type { TrackLayout } from './trackLayout';
import { CRAFT, GHOST, REFERENCE_TOP_SPEED } from './tuning';
import { Vehicle } from './vehicle';

/**
 * 幽灵回放(M4)。
 *
 * **不存轨迹,只存输入。** 玩家最佳圈的 `InputRecorder` 输出原样喂给一辆
 * 独立的 `Vehicle`,靠同一个 seed、同一套物理重新算出整圈 —— 见
 * `core/input.ts` 的 `InputRecorder` 类注释。这样幽灵天然继承了玩家跑出
 * 那一圈时遇到的每一次出界/回正,不需要额外记录轨迹或事件。
 *
 * 幽灵自带一个内部 `Race`,**只用它的出界重置逻辑**,不暴露给外部、
 * 也从不 `setSeed()`(没有 seed 就不会去读/写 localStorage,见 `Race.reset`)——
 * 这不是「计时」,是「让幽灵在原本出界的地方也一样被拽回来」。
 *
 * **幽灵有自己独立的 `Physics` 世界,不能借用玩家那个。**
 * `Vehicle.update()` 内部会调用一次 `physics.step()`(见 vehicle.ts);
 * 如果幽灵和玩家共用同一个 Rapier `World`,`World.update()` 里玩家、幽灵
 * 各调一次 `vehicle.update()` 就等于同一个世界一帧内被推进了两步 —— 玩家
 * 自己的车会跟着遭殃,速度/位移全部翻倍。两套车身没有碰撞体,分开各开
 * 一个物理世界互不干扰,这也是 `Physics.createChassis()` 本来就没挂碰撞体
 * 的原因之一(见 physics.ts 类注释)。
 */
export class Ghost {
  readonly craft: Craft;

  private readonly physics: Physics;
  private readonly vehicle: Vehicle;
  private readonly race: Race;
  private readonly layout: TrackLayout;
  private readonly frame: InputFrame = createInputFrame();
  private readonly prevPosition = new Vector3();
  private readonly prevOrientation = new Quaternion();

  private recording: RecordedInput | null = null;
  private active = false;

  constructor(field: GroundQuery, layout: TrackLayout, rng: Rng, palette: Palette) {
    this.layout = layout;
    this.physics = new Physics();
    this.vehicle = new Vehicle(field, this.physics);
    this.race = new Race(layout);

    this.craft = createCraft(rng.fork(), palette);
    this.craft.group.visible = false;
    // 幽灵是「半透明的自己」,不是新造型:复用玩家那套车壳/轮子材质,
    // 只调不透明度、关掉阴影(半透明物体投实心阴影看着像穿模)。
    this.craft.group.traverse((child) => {
      if (child instanceof Mesh) {
        child.castShadow = false;
        child.receiveShadow = false;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          material.transparent = true;
          material.opacity = GHOST.opacity;
          material.depthWrite = false;
        }
      }
    });

    this.prevPosition.copy(this.vehicle.position);
    this.prevOrientation.copy(this.vehicle.orientation);
  }

  /** 是否已经有可回放的录制。没有录制时 `update`/`present` 都是空操作。 */
  get hasRecording(): boolean {
    return this.recording !== null;
  }

  /**
   * 装载一段录制(`InputRecorder.toRecording()` 的输出)。传 `null` 表示
   * 清空(比如换 seed 后旧的录制不再适用于新赛道)。
   */
  loadRecording(data: Int8Array | null): void {
    this.recording = data === null ? null : new RecordedInput(data);
    this.active = this.recording !== null;
    this.craft.group.visible = this.active;
  }

  /**
   * 从起跑线重新开始这一圈的回放。**由玩家的圈计时驱动**(玩家每次跨过
   * 起跑线,幽灵也重新起跑),这样两车在视觉上是「同时出发」的,而不是
   * 幽灵按自己的节奏无限循环。
   */
  restartLap(): void {
    this.recording?.rewind();
    const start = this.layout.samples[0];
    if (start !== undefined) {
      this.vehicle.reset(start.x, start.z, Math.atan2(start.tangentX, start.tangentZ));
    } else {
      this.vehicle.reset();
    }
    this.race.reset();
    this.prevPosition.copy(this.vehicle.position);
    this.prevOrientation.copy(this.vehicle.orientation);
  }

  update(dt: number): void {
    if (!this.active || this.recording === null) {
      return;
    }
    this.prevPosition.copy(this.vehicle.position);
    this.prevOrientation.copy(this.vehicle.orientation);
    // 放完之后 RecordedInput 输出全零(见其类注释),幽灵会滑停在原地等
    // 玩家跑完这一圈触发下一次 restartLap() —— 不回绕,不需要特殊处理。
    this.recording.sample(this.frame);
    this.vehicle.update(this.frame, dt);
    this.race.update(this.vehicle, dt);
  }

  present(alpha: number): void {
    if (!this.active) {
      return;
    }
    const position = shownPosition.lerpVectors(this.prevPosition, this.vehicle.position, alpha);
    const orientation = shownOrientation.copy(this.prevOrientation).slerp(this.vehicle.orientation, alpha);

    this.craft.group.position.copy(position);
    this.craft.group.quaternion.copy(orientation);
    this.craft.setThrust(
      this.frame.throttle * CRAFT.thrustThrottleWeight +
        normalize01(this.vehicle.groundSpeed, 0, REFERENCE_TOP_SPEED) * CRAFT.thrustSpeedWeight,
    );

    const wheels = this.vehicle.wheelViews;
    for (let i = 0; i < wheels.length; i++) {
      const wheel = wheels[i];
      if (wheel === undefined) {
        continue;
      }
      this.craft.setWheel(i, wheel.length, wheel.steered ? this.vehicle.steerAngle : 0, wheel.rollAngle);
    }
  }
}

const shownPosition = new Vector3();
const shownOrientation = new Quaternion();
