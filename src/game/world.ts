import {
  type PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
} from 'three';
import { type InputFrame, InputRecorder, createInputFrame } from '../core/input';
import { rollAt } from './wheelView';
import type { Rng } from '../core/rng';
import { type Craft, createCraft } from '../gfx/craft';
import { createGround } from '../gfx/ground';
import { createPalette, rivalCraftColors } from '../gfx/palette';
import { Atmosphere } from '../gfx/atmosphere';
import { createTerrainMesh } from '../gfx/terrainMesh';
import { createTrackMesh } from '../gfx/trackMesh';
import { clamp, normalize01 } from '../core/mathx';
import { RacingPilot } from './racingPilot';
import { TrackRecovery } from './trackRecovery';
import { RaceSession } from './raceSession';
import { Standings } from './standings';
import { ChaseCamera } from './chaseCamera';
import { Course } from './course';
import { Ghost } from './ghost';
import type { GroundQuery } from './groundQuery';
import { Heightfield } from './heightfield';
import { Physics } from './physics';
import { Race } from './race';
import { encodeGhostInput, saveRecord } from './records';
import { type TrackLayout, alignStartAwayFromSun, generateTrack } from './trackLayout';
import { CRAFT, RACE_FORMAT, RACING_AI, REFERENCE_TOP_SPEED } from './tuning';
import { applyDraft } from './draft';
import { Vehicle } from './vehicle';

const shownPosition = new Vector3();
const shownOrientation = new Quaternion();
const rivalShownPosition = new Vector3();
const rivalShownOrientation = new Quaternion();
const mapCentre = new Vector3();

/**
 * 对手起步时落后玩家多远(沿赛道弧长,米)。**不是手感参数**,只是起步
 * 摆位,不放进 `tuning.ts`。
 *
 * **故意沿赛道纵向错开,不是并排。** 第一次接这块时试过并排起步(横向
 * 偏移),结果 `smoke.spec.ts` 里"满油门打满舵 2.5 秒"那条测试红了——
 * 不是断言太严,是玩家真的被 3 米外的对手车撞歪了,横向位移的方向都变了。
 * 那条测试的前提是"只有玩家一辆车",纵向错开能保证短时间窗口的测试
 * (这个项目里最长的连续输入测试是 6.5 秒)碰不到跟在后面的对手车,
 * 同时不用去改测试本身迁就一个新加入的、和被测行为无关的变量。
 */
/** 传给对手 AI 的「场上其他车」。复用同一个数组,每帧不分配。 */
const rivalOpponents: Vehicle[] = [];
/** 场上所有车(玩家 + 对手),尾流计算用。同样复用,不每帧新建。 */
const allCars: Vehicle[] = [];

/** 名次表 / 结算面板里各车的 id。0 号恒为玩家,其后是对手。 */
function racerIds(rivalCount: number): string[] {
  const ids = ['player'];
  for (let i = 0; i < rivalCount; i++) {
    ids.push(`rival${i}`);
  }
  return ids;
}

/**
 * 发车格:第 `slot` 位(0 = 玩家的杆位)相对起跑线的纵向后退距离与横向偏移。
 *
 * 两两一排交错(和真实发车格一样),不是一字纵队——纵队里后车全程被前车
 * 挡着,永远看不到超车。
 */
function gridSlot(slot: number): { back: number; lateral: number } {
  // 杆位(玩家)留在中心线上。真实发车格杆位也是偏一侧的,但把玩家摆偏之后
  // 一上来就得先并回赛道中间,而且「起跑在中心线」是既有截图测试钉住的行为
  // (smoke.spec.ts「起跑时在赛道上」断言 |lateral| < 1)。对手才交错排开。
  if (slot <= 0) {
    return { back: 0, lateral: 0 };
  }
  const index = slot - 1;
  const row = Math.floor(index / 2);
  const side = index % 2 === 0 ? -1 : 1;
  return {
    back: (row + 1) * RACE_FORMAT.gridRow,
    lateral: side * RACE_FORMAT.gridLateral,
  };
}


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
  /** 物理世界。**造 World 之前必须 await `initPhysics()`**,否则这里会抛。 */
  readonly physics: Physics;
  /** 幽灵回放。`flat` 场地(没有 `Race`)下是 null。 */
  readonly ghost: Ghost | null;
  /**
   * 竞速对手(M7 第一次真的有第二辆车参与物理,和玩家共享同一个
   * `Physics` 世界——不是幽灵那种独立世界里的半透明重放)。
   *
   * 开的是 `RacingPilot`。**曾经是 `Autopilot`,换掉了**:那东西自己的类
   * 注释写着「不是游戏内容,是验收工具」,实测当对手用单圈比目标时间慢
   * 56~74%、满油门占比只有 5%,人类反馈「AI 车太垃圾了」。`Autopilot` 本身
   * 一个字没动,截图回归的既有基线还靠它。
   *
   * `flat` 场地(没有赛道可循迹)下是 null。
   */
  readonly rivals: Vehicle[] = [];
  /**
   * 名次表(M7)。`flat` 场地没有赛道也就没有弧长,自然也没有名次,是 null。
   * 下标顺序固定:0 = 玩家,1 = 对手,和 `RACER_IDS` 一致。
   */
  readonly standings: Standings | null;
  /**
   * 赛制(M7):倒计时发车、跑 N 圈、结算。`flat` 场地没有赛道也就没有比赛。
   */
  readonly session: RaceSession | null;

  private readonly craft: Craft;
  private readonly rivalPilots: RacingPilot[] = [];
  /**
   * 对手车的出界回收。**没有它对手被撞出赛道就再也回不来了**——出界重置本来
   * 长在 `Race` 里,而 `Race` 只伺候玩家(见 `trackRecovery.ts` 的类注释)。
   */
  private readonly rivalRecoveries: TrackRecovery[] = [];
  private readonly rivalCrafts: Craft[] = [];
  private readonly rivalInputs: InputFrame[] = [];
  private readonly rivalPrevPositions: Vector3[] = [];
  private readonly rivalPrevOrientations: Quaternion[] = [];
  private readonly prevPosition = new Vector3();
  private readonly prevOrientation = new Quaternion();
  private preset = 'chase';
  private readonly fixedCamera: PerspectiveCamera;
  private readonly input: InputFrame = createInputFrame();
  /**
   * 玩家本圈的输入录制。**只在跨过起跑线时清空**(`spawnAtStart` /
   * 圈完成),出界重置不清 —— 幽灵要重放出那次出界和被拽回来的过程。
   */
  private readonly recorder = new InputRecorder();

  /** 测试模式:跳过发车倒计时,理由见 `raceSession.ts` 的类注释。 */
  private readonly skipCountdown: boolean;

  constructor(rng: Rng, kind: CourseKind = 'race', options: { skipCountdown?: boolean } = {}) {
    this.skipCountdown = options.skipCountdown === true;
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
    this.physics = new Physics();
    this.vehicle = new Vehicle(this.field, this.physics);
    // 和玩家共享 this.physics——这正是这一节要证明的事:两辆车能安全地
    // 共用同一个 Rapier 世界(见 vehicle.ts 的 applyForces()/readState() 拆分、
    // 以及 ghost.ts 类注释里「为什么 Ghost 必须用独立世界」的对照说明)。
    const track = this.track;
    const rivalCount = track === null ? 0 : RACE_FORMAT.rivalCount;
    for (let i = 0; i < rivalCount; i++) {
      this.rivals.push(new Vehicle(this.field, this.physics));
      // 每辆对手的难度递减一档:全场同速会变成一列火车,谁也超不了谁。
      this.rivalPilots.push(
        new RacingPilot(
          track as TrackLayout,
          RACING_AI.defaultAggression - i * RACING_AI.aggressionSpread,
        ),
      );
      // 只给 AI 开卡住检测:玩家停车是合法操作,见 TrackRecovery 的构造注释。
      this.rivalRecoveries.push(new TrackRecovery(track as TrackLayout, { detectStall: true }));
      this.rivalInputs.push(createInputFrame());
      this.rivalPrevPositions.push(new Vector3());
      this.rivalPrevOrientations.push(new Quaternion());
    }
    this.session = track === null ? null : new RaceSession();
    this.standings =
      track === null ? null : new Standings(racerIds(rivalCount), track.totalLength);
    this.chase = new ChaseCamera(this.field);
    this.fixedCamera = this.chase.camera.clone();
    this.spawnAtStart();

    this.craft = createCraft(rng.fork(), palette);
    this.scene.add(this.craft.group);
    for (let i = 0; i < this.rivals.length; i++) {
      const craft = createCraft(rng.fork(), rivalCraftColors(palette, i, this.rivals.length));
      this.rivalCrafts.push(craft);
      this.scene.add(craft.group);
    }

    this.ghost = this.track === null ? null : new Ghost(this.field, this.track, rng.fork(), palette);
    if (this.ghost !== null) {
      this.scene.add(this.ghost.craft.group);
    }

    // 背光面不再靠半球光去补,改由 IBL 提供 —— 环境反射来自真实的大气散射,
    // 明暗过渡和天空是一致的,而不是人为塞一个补光。
    this.prevPosition.copy(this.vehicle.position);
    this.prevOrientation.copy(this.vehicle.orientation);
    this.saveRivalPrevious();
    this.chase.snapTo(this.vehicle);
    this.present(1);
  }

  /** 记下所有对手车上一帧的位姿,给渲染插值用。 */
  private saveRivalPrevious(): void {
    for (let i = 0; i < this.rivals.length; i++) {
      const rival = this.rivals[i];
      if (rival === undefined) {
        continue;
      }
      this.rivalPrevPositions[i]?.copy(rival.position);
      this.rivalPrevOrientations[i]?.copy(rival.orientation);
    }
  }

  /** 把载具放到起跑线,车头朝赛道前进方向。平地场景就是原点朝 +Z。 */
  spawnAtStart(): void {
    this.race?.reset();
    this.recorder.clear();
    this.ghost?.restartLap();
    if (this.track === null || this.track.samples[0] === undefined) {
      // 平地场景:没有赛道也就没有发车格,原点起步。
      this.vehicle.reset();
      return;
    }

    {
      /*
       * 发车格。玩家占杆位(slot 0),对手依次往后排;两两一排交错开,
       * 横向偏移压在半宽以内。上一版是「对手沿赛道往回退 20 米」的一字纵队,
       * 多辆车之后那样排会全叠在同一条线上互相追尾。
       */
      const { samples, spacing, halfWidth } = this.track;
      const count = samples.length;
      const room = halfWidth - 1.5;
      const placeAt = (vehicle: Vehicle, slot: number): void => {
        const { back, lateral } = gridSlot(slot);
        const behindIndex = ((-Math.round(back / spacing) % count) + count) % count;
        const sample = samples[behindIndex];
        if (sample === undefined) {
          return;
        }
        const offset = clamp(lateral, -room, room);
        // 赛道右手法向 = (tangentZ, -tangentX)。
        vehicle.reset(
          sample.x + sample.tangentZ * offset,
          sample.z - sample.tangentX * offset,
          Math.atan2(sample.tangentX, sample.tangentZ),
        );
      };

      placeAt(this.vehicle, 0);
      for (let i = 0; i < this.rivals.length; i++) {
        const rival = this.rivals[i];
        if (rival !== undefined) {
          placeAt(rival, i + 1);
        }
      }
    }

    // 一局重开才换新车:出界回收调的是 vehicle.reset(),那个不清车况
    // ——把车扶回赛道是回收,不是修车(见 condition.ts 的类注释)。
    this.vehicle.condition.reset();
    for (const rival of this.rivals) {
      rival.condition.reset();
    }
    for (const recovery of this.rivalRecoveries) {
      recovery.reset();
    }
    this.standings?.reset([this.vehicle.arc, ...this.rivals.map((r) => r.arc)]);
    this.session?.begin({ skipCountdown: this.skipCountdown });
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
    this.saveRivalPrevious();

    /*
     * 发车倒计时中、以及冲线之后,输入被锁住。抢跑不判罚——压根动不了,
     * 这比事后罚时直观。锁住的是**写进物理的那份**,不是外面传进来的
     * `input`,免得把调用方的帧改脏。
     */
    const locked = this.session?.inputLocked === true;
    this.input.throttle = locked ? 0 : input.throttle;
    this.input.reverse = locked ? 0 : input.reverse;
    this.input.steer = locked ? 0 : input.steer;
    this.input.airBrake = locked ? 0 : input.airBrake;

    if (this.race !== null) {
      // 就地把 this.input 量化成回放精度 —— 物理这一帧吃到的和录下来的必须是
      // 同一串数字,否则幽灵会慢慢和玩家原本跑的线漂开(见 InputRecorder 类注释)。
      this.recorder.record(this.input);
    }

    /*
     * 所有车先 applyForces(),物理世界只 step() 一次,再所有车 readState() ——
     * 这正是 vehicle.ts 拆分 update() 时预留的模式(见那边的类注释),
     * 现在真的用上了第二辆车。玩家和对手共享同一个 this.physics,
     * 车间碰撞靠 Physics.createChassis() 挂的碰撞体自然发生,不用在这里
     * 额外处理。
     */
    // 尾流要在所有车都还没施力之前算好——它读的是上一帧读回来的位置,
    // 和「所有车先 applyForces 再统一 step」那条模式一致。
    if (this.rivals.length > 0) {
      allCars.length = 0;
      allCars.push(this.vehicle, ...this.rivals);
      applyDraft(allCars);
    }

    this.vehicle.applyForces(this.input, dt);
    /*
     * 每辆对手都要看到**场上所有其他车**(玩家 + 其他对手),否则对手之间
     * 会互相追尾。`rivalOpponents` 是复用的数组,每帧重填不新建。
     */
    if (this.rivals.length > 0) {
      rivalOpponents.length = 0;
      rivalOpponents.push(this.vehicle, ...this.rivals);
    }
    for (let i = 0; i < this.rivals.length; i++) {
      const rival = this.rivals[i];
      const pilot = this.rivalPilots[i];
      const input = this.rivalInputs[i];
      if (rival === undefined || pilot === undefined || input === undefined) {
        continue;
      }
      // RacingPilot 自己会跳过 `other === vehicle`,不用在这里剔除自己。
      pilot.drive(rival, input, rivalOpponents);
      if (locked) {
        // 对手也要等发车灯,否则倒计时期间它自己先跑了。
        input.throttle = 0;
        input.reverse = 0;
        input.steer = 0;
        input.airBrake = 0;
      }
      rival.applyForces(input, dt);
    }
    this.physics.step();
    this.vehicle.readState(dt);
    for (const rival of this.rivals) {
      rival.readState(dt);
    }

    // 名次:两辆车的弧长都读回来之后算一次。用弧长而不是检查点,理由见
    // standings.ts 的类注释。
    if (this.standings !== null) {
      this.standings.setArc(0, this.vehicle.arc);
      for (let i = 0; i < this.rivals.length; i++) {
        this.standings.setArc(i + 1, this.rivals[i]?.arc ?? 0);
      }
      this.standings.update();
    }

    // 对手出界也要被拉回来。送回它**当前**的弧长而不是某个检查点:AI 不刷
    // 成绩,原地扶起来就行,送回检查点反而是平白惩罚。
    // 发车倒计时期间所有车都静止,那是合法的,别让卡住检测把它们全传送一遍。
    if (!locked) {
      for (let i = 0; i < this.rivals.length; i++) {
        const rival = this.rivals[i];
        this.rivalRecoveries[i]?.update(rival as Vehicle, dt, rival?.arc ?? 0);
      }
    }

    // 赛制在名次算完之后推进:完赛判定读的是 Standings.laps(每辆车都有,
    // 而 Race 只伺候玩家),见 raceSession.ts 的类注释。
    this.session?.update(dt, this.standings);

    const lapsBefore = this.race?.laps ?? 0;
    this.race?.update(this.vehicle, dt);

    if (this.race !== null && this.race.laps > lapsBefore) {
      if (this.race.isNewBestLap) {
        const seed = this.race.getSeed();
        if (seed !== null) {
          /*
           * Race.update() 内部(trackCheckpoints)已经为新纪录写过一次不带
           * 幽灵数据的记录。Race 不认识 InputRecorder——层次上不该让它认识——
           * 所以这里带着 ghostInput 再写一次覆盖它。多写一次的代价可以接受,
           * 新纪录本来就不常发生。
           */
          saveRecord(seed, {
            bestLapTime: this.race.bestLapTime,
            bestSectorTimes: [...this.race.bestSectorTimes],
            ghostInput: encodeGhostInput(this.recorder.toRecording()),
          });
          this.ghost?.loadRecording(this.recorder.toRecording());
        }
      }
      this.recorder.clear();
      this.ghost?.restartLap();
    }

    this.ghost?.update(dt);
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
    const wheels = this.vehicle.wheelViews;
    for (let i = 0; i < wheels.length; i++) {
      const wheel = wheels[i];
      if (wheel === undefined) {
        continue;
      }
      this.craft.setWheel(
        i,
        wheel.length,
        wheel.steered ? this.vehicle.steerAngle : 0,
        rollAt(wheel, alpha),
      );
    }

    for (let i = 0; i < this.rivals.length; i++) {
      const rival = this.rivals[i];
      const craft = this.rivalCrafts[i];
      const input = this.rivalInputs[i];
      const prevPos = this.rivalPrevPositions[i];
      const prevRot = this.rivalPrevOrientations[i];
      if (
        rival === undefined ||
        craft === undefined ||
        input === undefined ||
        prevPos === undefined ||
        prevRot === undefined
      ) {
        continue;
      }
      rivalShownPosition.lerpVectors(prevPos, rival.position, alpha);
      rivalShownOrientation.copy(prevRot).slerp(rival.orientation, alpha);
      craft.group.position.copy(rivalShownPosition);
      craft.group.quaternion.copy(rivalShownOrientation);
      craft.setThrust(
        input.throttle * CRAFT.thrustThrottleWeight +
          normalize01(rival.groundSpeed, 0, REFERENCE_TOP_SPEED) * CRAFT.thrustSpeedWeight,
      );
      const wheels = rival.wheelViews;
      for (let w = 0; w < wheels.length; w++) {
        const wheel = wheels[w];
        if (wheel === undefined) {
          continue;
        }
        craft.setWheel(w, wheel.length, wheel.steered ? rival.steerAngle : 0, rollAt(wheel, alpha));
      }
    }

    this.ghost?.present(alpha);

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
