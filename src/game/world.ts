import {
  DirectionalLight,
  Group,
  HemisphereLight,
  type PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
} from 'three';
import { type InputFrame, createInputFrame } from '../core/input';
import type { Rng } from '../core/rng';
import { createCraft } from '../gfx/craft';
import { createGround } from '../gfx/ground';
import { createPalette } from '../gfx/palette';
import { GroundShadow } from '../gfx/shadowBlob';
import { createSky } from '../gfx/sky';
import { ChaseCamera } from './chaseCamera';
import { Heightfield } from './heightfield';
import { Vehicle } from './vehicle';

const shownPosition = new Vector3();
const shownOrientation = new Quaternion();


/** 固定机位:回归截图用,和玩家实际在用的跟随机位分开。 */
const FIXED_PRESETS: Readonly<Record<string, { back: number; side: number; up: number }>> = {
  side: { back: 0, side: 13, up: 4 },
  front: { back: -13, side: 0, up: 3.4 },
  top: { back: 0.01, side: 0, up: 22 },
};

export const CAMERA_PRESET_NAMES = ['chase', ...Object.keys(FIXED_PRESETS)];

/**
 * M1 的世界:一块带跳台和起伏的大平地 + 一辆悬浮载具 + 跟随相机。
 *
 * 只做手感,不做内容 —— 没有赛道、检查点、计时。那些是 M2 / M4。
 */
export class World {
  readonly scene = new Scene();
  readonly field: Heightfield;
  readonly vehicle: Vehicle;
  readonly chase: ChaseCamera;

  private readonly craft: Group;
  private readonly shadow = new GroundShadow();
  private readonly prevPosition = new Vector3();
  private readonly prevOrientation = new Quaternion();
  private preset = 'chase';
  private readonly fixedCamera: PerspectiveCamera;
  private readonly input: InputFrame = createInputFrame();

  constructor(rng: Rng) {
    const palette = createPalette(rng.fork());

    this.field = new Heightfield(rng.fork());
    this.vehicle = new Vehicle(this.field);
    this.chase = new ChaseCamera(this.field);
    this.fixedCamera = this.chase.camera.clone();

    this.scene.add(createSky(palette));
    this.scene.add(createGround(this.field, rng.fork(), palette));

    this.craft = createCraft(rng.fork(), palette);
    this.scene.add(this.craft);

    this.scene.add(this.shadow.mesh);

    // 一主一补:主光造明暗面,半球光把背光面从死黑里拉回来。
    const key = new DirectionalLight(palette.keyLight, 2.4);
    key.position.set(90, 160, 60);
    key.name = 'key-light';
    this.scene.add(key);

    const fill = new HemisphereLight(palette.horizon, palette.fillLight, 0.5);
    fill.name = 'fill-light';
    this.scene.add(fill);

    this.prevPosition.copy(this.vehicle.position);
    this.prevOrientation.copy(this.vehicle.orientation);
    this.chase.snapTo(this.vehicle);
    this.present(1);
  }

  get camera(): PerspectiveCamera {
    return this.preset === 'chase' ? this.chase.camera : this.fixedCamera;
  }

  update(input: InputFrame, dt: number): void {
    this.prevPosition.copy(this.vehicle.position);
    this.prevOrientation.copy(this.vehicle.orientation);

    this.input.throttle = input.throttle;
    this.input.reverse = input.reverse;
    this.input.steer = input.steer;
    this.input.airBrake = input.airBrake;

    this.vehicle.update(this.input, dt);
    this.chase.update(this.vehicle, dt);
  }

  present(alpha: number): void {
    shownPosition.lerpVectors(this.prevPosition, this.vehicle.position, alpha);
    shownOrientation.copy(this.prevOrientation).slerp(this.vehicle.orientation, alpha);

    this.craft.position.copy(shownPosition);
    this.craft.quaternion.copy(shownOrientation);
    this.shadow.update(this.field, shownPosition.x, shownPosition.z, shownPosition.y);

    if (this.preset === 'chase') {
      this.chase.present(alpha);
    } else {
      this.updateFixedCamera(shownPosition);
    }
  }

  setCameraPreset(preset: string): void {
    if (preset !== 'chase' && FIXED_PRESETS[preset] === undefined) {
      throw new RangeError(`未知机位 "${preset}",可用:${CAMERA_PRESET_NAMES.join(', ')}`);
    }
    this.preset = preset;
    if (preset === 'chase') {
      this.chase.snapTo(this.vehicle);
    } else {
      this.updateFixedCamera(this.vehicle.position);
    }
  }

  get cameraPreset(): string {
    return this.preset;
  }

  resize(width: number, height: number): void {
    const aspect = width / Math.max(1, height);
    this.chase.setAspect(aspect);
    this.fixedCamera.aspect = aspect;
    this.fixedCamera.updateProjectionMatrix();
  }

  private updateFixedCamera(target: Vector3): void {
    const config = FIXED_PRESETS[this.preset];
    if (config === undefined) {
      return;
    }
    // 固定机位跟着车走但不跟着车转:回归截图里车的朝向变化才看得出来。
    this.fixedCamera.position.set(
      target.x + config.side,
      target.y + config.up,
      target.z - config.back,
    );
    this.fixedCamera.up.set(0, 1, 0);
    this.fixedCamera.lookAt(target);
  }
}
