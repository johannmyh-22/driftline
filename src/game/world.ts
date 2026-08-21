import {
  type PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
} from 'three';
import { type InputFrame, createInputFrame } from '../core/input';
import type { Rng } from '../core/rng';
import { type Craft, createCraft } from '../gfx/craft';
import { createGround } from '../gfx/ground';
import { createPalette } from '../gfx/palette';
import { Atmosphere } from '../gfx/atmosphere';
import { createTerrainMesh } from '../gfx/terrainMesh';
import { createTrackMesh } from '../gfx/trackMesh';
import { normalize01 } from '../core/mathx';
import { ChaseCamera } from './chaseCamera';
import { Course } from './course';
import type { GroundQuery } from './groundQuery';
import { Heightfield } from './heightfield';
import { Race } from './race';
import { type TrackLayout, alignStartAwayFromSun, generateTrack } from './trackLayout';
import { CRAFT, REFERENCE_TOP_SPEED } from './tuning';
import { Vehicle } from './vehicle';

const shownPosition = new Vector3();
const shownOrientation = new Quaternion();
const mapCentre = new Vector3();


/** 固定机位:回归截图用,和玩家实际在用的跟随机位分开。 */
const FIXED_PRESETS: Readonly<Record<string, { back: number; side: number; up: number }>> = {
  side: { back: 0, side: 13, up: 4 },
  front: { back: -13, side: 0, up: 3.4 },
  top: { back: 0.01, side: 0, up: 22 },
};

/** 俯瞰整条赛道的调试机位。M2 的构图和自交问题,只有从这个高度才看得出来。 */
const MAP_PRESET = 'map';

export const CAMERA_PRESET_NAMES = ['chase', ...Object.keys(FIXED_PRESETS), MAP_PRESET];

/**
 * M1 的世界:一块带跳台和起伏的大平地 + 一辆悬浮载具 + 跟随相机。
 *
 * 只做手感,不做内容 —— 没有赛道、检查点、计时。那些是 M2 / M4。
 */
/** 场地种类。`flat` 是 M1 那块带跳台的平地,留着单独调手感用。 */
export type CourseKind = 'race' | 'flat';

export class World {
  readonly scene = new Scene();
  readonly field: GroundQuery;
  readonly vehicle: Vehicle;
  readonly chase: ChaseCamera;
  /** 赛道布局。`flat` 场地下是 null。 */
  readonly track: TrackLayout | null;
  /** 大气与太阳。环境贴图要等渲染器就绪后才能烘。 */
  readonly atmosphere: Atmosphere;
  /** 检查点与圈计时。`flat` 场地下是 null —— 那块地没有赛道可计圈。 */
  readonly race: Race | null;

  private readonly craft: Craft;
  private readonly prevPosition = new Vector3();
  private readonly prevOrientation = new Quaternion();
  private preset = 'chase';
  private readonly fixedCamera: PerspectiveCamera;
  private readonly input: InputFrame = createInputFrame();

  constructor(rng: Rng, kind: CourseKind = 'race') {
    const palette = createPalette(rng.fork());

    this.atmosphere = new Atmosphere(rng.fork());
    this.scene.add(this.atmosphere.sky);
    this.scene.add(this.atmosphere.sunLight);

    if (kind === 'race') {
      // 起点要避开逆光,而太阳方位角是 Atmosphere 定的,所以只能等它先造好。
      // 换起点不消耗随机数,rng 的取用顺序不变 —— 同 seed 的赛道形状还是那条。
      const layout = alignStartAwayFromSun(
        generateTrack(rng.fork()),
        this.atmosphere.sunDirection.x,
        this.atmosphere.sunDirection.z,
      );
      const course = new Course(layout, rng.fork());
      this.track = layout;
      this.field = course;
      this.scene.add(createTerrainMesh(course, rng.fork(), palette));
      this.scene.add(createTrackMesh(course, rng.fork(), palette));
    } else {
      const field = new Heightfield(rng.fork());
      this.track = null;
      this.field = field;
      this.scene.add(createGround(field, rng.fork(), palette));
    }

    this.race = this.track === null ? null : new Race(this.track);
    this.vehicle = new Vehicle(this.field);
    this.chase = new ChaseCamera(this.field);
    this.fixedCamera = this.chase.camera.clone();
    this.spawnAtStart();

    this.craft = createCraft(rng.fork(), palette);
    this.scene.add(this.craft.group);


    // 背光面不再靠半球光去补,改由 IBL 提供 —— 环境反射来自真实的大气散射,
    // 明暗过渡和天空是一致的,而不是人为塞一个补光。
    this.prevPosition.copy(this.vehicle.position);
    this.prevOrientation.copy(this.vehicle.orientation);
    this.chase.snapTo(this.vehicle);
    this.present(1);
  }

  /** 把载具放到起跑线,车头朝赛道前进方向。平地场景就是原点朝 +Z。 */
  spawnAtStart(): void {
    this.race?.reset();
    const start = this.track?.samples[0];
    if (start === undefined) {
      this.vehicle.reset();
      return;
    }
    // forward = (sin yaw, 0, cos yaw),所以由切线反解 yaw 用 atan2(x, z)。
    this.vehicle.reset(start.x, start.z, Math.atan2(start.tangentX, start.tangentZ));
  }

  get camera(): PerspectiveCamera {
    return this.preset === 'chase' ? this.chase.camera : this.fixedCamera;
  }

  /**
   * 车头方向和太阳方位角的夹角余弦:**1 = 正对太阳(逆光),-1 = 太阳在背后**。
   *
   * 逆光的强弱只有截图能看,而截图要先知道往哪开才拍得到 —— 这个值让
   * 「跑到逆光路段」变成可搜索的量,不用靠猜帧数。跟随机位大致朝着车头,
   * 所以它同时也是相机的逆光程度。
   */
  get sunAhead(): number {
    const sun = this.atmosphere.sunDirection;
    const horizontal = Math.hypot(sun.x, sun.z);
    if (horizontal < 1e-6) {
      return 0;
    }
    const yaw = this.vehicle.yaw;
    return (Math.sin(yaw) * sun.x + Math.cos(yaw) * sun.z) / horizontal;
  }

  update(input: InputFrame, dt: number): void {
    this.prevPosition.copy(this.vehicle.position);
    this.prevOrientation.copy(this.vehicle.orientation);

    this.input.throttle = input.throttle;
    this.input.reverse = input.reverse;
    this.input.steer = input.steer;
    this.input.airBrake = input.airBrake;

    this.vehicle.update(this.input, dt);
    this.race?.update(this.vehicle, dt);
    this.chase.update(this.vehicle, dt);
  }

  present(alpha: number): void {
    shownPosition.lerpVectors(this.prevPosition, this.vehicle.position, alpha);
    shownOrientation.copy(this.prevOrientation).slerp(this.vehicle.orientation, alpha);

    this.craft.group.position.copy(shownPosition);
    this.craft.group.quaternion.copy(shownOrientation);
    // 尾焰要油门和速度都满才到全亮:光有油门(起步)或光有速度(松手滑行)
    // 都只是半亮,踩着油门冲刺才烧起来。
    this.craft.setThrust(
      this.input.throttle * CRAFT.thrustThrottleWeight +
        normalize01(this.vehicle.groundSpeed, 0, REFERENCE_TOP_SPEED) * CRAFT.thrustSpeedWeight,
    );
    // 阴影相机只罩住车周围一小块,必须跟着车走。
    this.atmosphere.followShadow(shownPosition.x, shownPosition.y, shownPosition.z);

    if (this.preset === 'chase') {
      this.chase.present(alpha);
    } else {
      this.updateFixedCamera(shownPosition);
    }
  }

  setCameraPreset(preset: string): void {
    if (preset !== 'chase' && preset !== MAP_PRESET && FIXED_PRESETS[preset] === undefined) {
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

  /** 把整条赛道框进画面。构图和自交这类问题只有从这个高度才看得出来。 */
  private frameWholeTrack(fallback: Vector3): void {
    const samples = this.track?.samples;
    if (samples === undefined || samples.length === 0) {
      this.fixedCamera.position.set(fallback.x, fallback.y + 400, fallback.z + 1);
      this.fixedCamera.up.set(0, 1, 0);
      this.fixedCamera.lookAt(fallback);
      return;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const sample of samples) {
      minX = Math.min(minX, sample.x);
      maxX = Math.max(maxX, sample.x);
      minZ = Math.min(minZ, sample.z);
      maxZ = Math.max(maxZ, sample.z);
    }

    const centreX = (minX + maxX) / 2;
    const centreZ = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxZ - minZ);

    mapCentre.set(centreX, 0, centreZ);
    // 略微偏后而不是正上方:纯垂直俯视时 lookAt 的 roll 没有定义,画面会莫名歪掉。
    this.fixedCamera.position.set(centreX, span * 0.95, centreZ + span * 0.28);
    this.fixedCamera.up.set(0, 1, 0);
    this.fixedCamera.lookAt(mapCentre);
  }

  private updateFixedCamera(target: Vector3): void {
    if (this.preset === MAP_PRESET) {
      this.frameWholeTrack(target);
      return;
    }

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
