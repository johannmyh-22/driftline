import { HUD_TUNING } from './tuning';
import { loadRecord, saveRecord } from './records';
import type { TrackLayout } from './trackLayout';
import { TRACK } from './tuning';
import type { Vehicle } from './vehicle';

/**
 * 检查点、分段计时、圈计时、出界重置与本地最佳成绩持久化。
 *
 * 检查点必须**按顺序**通过才算数:否则抄近道或者倒着开都能刷圈,
 * 计时就没有意义了。
 */
export class Race {
  readonly checkpointCount = TRACK.checkpointCount;

  /** 已完成的圈数。 */
  laps = 0;
  /** 当前圈已用时间(秒)。 */
  lapTime = 0;
  /** 上一圈用时,没跑完过是 0。 */
  lastLapTime = 0;
  /** 最快单圈,没跑完过是 0。 */
  bestLapTime = 0;
  /** 下一个要通过的检查点。 */
  nextCheckpoint = 1;
  /** 最近通过的检查点,出界后重置回它。 */
  lastCheckpoint = 0;
  /** 连续在界外待了多久(秒)。 */
  offTrackTime = 0;
  /** 累计被重置了几次。 */
  resets = 0;

  /** 当前圈各检查点的累计用时(秒)。 */
  readonly currentSectorTimes: number[];
  /** 最佳圈各检查点的累计用时(秒)。 */
  readonly bestSectorTimes: number[];
  /** 当前最新分段相对于最佳圈的 delta(秒),负值领先,正值落后,无最佳圈时为 null。 */
  delta: number | null = null;
  /** delta 提示剩余显示时间(秒)。 */
  deltaTimer = 0;
  /** 最近一次触发 delta 的检查点编号。 */
  deltaCheckpoint = 0;
  /** 上一圈是否刷新了最佳纪录。 */
  isNewBestLap = false;

  private seed: number | null = null;
  private readonly layout: TrackLayout;
  private readonly checkpointArc: number;

  constructor(layout: TrackLayout) {
    this.layout = layout;
    this.checkpointArc = layout.totalLength / this.checkpointCount;
    this.currentSectorTimes = new Array<number>(this.checkpointCount).fill(0);
    this.bestSectorTimes = new Array<number>(this.checkpointCount).fill(0);
  }

  /** 关联赛道 seed,并加载该 seed 下的历史最佳记录。 */
  setSeed(seed: number): void {
    this.seed = seed;
    const record = loadRecord(seed);
    if (record !== null && record.bestLapTime > 0) {
      this.bestLapTime = record.bestLapTime;
      if (Array.isArray(record.bestSectorTimes)) {
        for (let i = 0; i < this.checkpointCount; i++) {
          this.bestSectorTimes[i] = record.bestSectorTimes[i] ?? 0;
        }
      }
    }
  }

  getSeed(): number | null {
    return this.seed;
  }

  reset(): void {
    this.laps = 0;
    this.lapTime = 0;
    this.lastLapTime = 0;
    this.nextCheckpoint = 1;
    this.lastCheckpoint = 0;
    this.offTrackTime = 0;
    this.resets = 0;
    this.currentSectorTimes.fill(0);
    this.delta = null;
    this.deltaTimer = 0;
    this.isNewBestLap = false;

    if (this.seed !== null) {
      const record = loadRecord(this.seed);
      if (record !== null && record.bestLapTime > 0) {
        this.bestLapTime = record.bestLapTime;
        for (let i = 0; i < this.checkpointCount; i++) {
          this.bestSectorTimes[i] = record.bestSectorTimes[i] ?? 0;
        }
      } else {
        this.bestLapTime = 0;
        this.bestSectorTimes.fill(0);
      }
    } else {
      this.bestLapTime = 0;
      this.bestSectorTimes.fill(0);
    }
  }

  /** 本圈进度 0..1,按已通过的检查点算,不看弧长 —— 抄近道不该算进度。 */
  get progress(): number {
    return this.lastCheckpoint / this.checkpointCount;
  }

  update(vehicle: Vehicle, dt: number): void {
    this.lapTime += dt;
    if (this.deltaTimer > 0) {
      this.deltaTimer = Math.max(0, this.deltaTimer - dt);
    }
    this.trackCheckpoints(vehicle);
    this.handleOutOfBounds(vehicle, dt);
  }

  private trackCheckpoints(vehicle: Vehicle): void {
    if (!vehicle.onTrack) {
      return;
    }

    const index = Math.floor(vehicle.arc / this.checkpointArc) % this.checkpointCount;
    if (index !== this.nextCheckpoint) {
      return;
    }

    this.lastCheckpoint = index;
    this.currentSectorTimes[index] = this.lapTime;

    if (index === 0) {
      // 绕回 0 号点意味着一整圈的检查点都按顺序过了。
      this.laps++;
      this.lastLapTime = this.lapTime;
      const prevBest = this.bestLapTime;
      const isNewBest = prevBest === 0 || this.lapTime < prevBest;

      if (prevBest > 0) {
        this.delta = this.lapTime - prevBest;
        this.deltaTimer = HUD_TUNING.deltaHoldTime;
        this.deltaCheckpoint = 0;
      } else {
        this.delta = null;
      }

      if (isNewBest) {
        this.bestLapTime = this.lapTime;
        this.isNewBestLap = true;
        for (let i = 0; i < this.checkpointCount; i++) {
          this.bestSectorTimes[i] = this.currentSectorTimes[i] ?? 0;
        }
        if (this.seed !== null) {
          saveRecord(this.seed, {
            bestLapTime: this.bestLapTime,
            bestSectorTimes: [...this.bestSectorTimes],
          });
        }
      } else {
        this.isNewBestLap = false;
      }

      this.lapTime = 0;
      this.currentSectorTimes.fill(0);
    } else {
      // 中途各检查点:如果已有最佳圈的分段记录,计算分段 delta
      const bestSplit = this.bestSectorTimes[index];
      if (this.bestLapTime > 0 && typeof bestSplit === 'number' && bestSplit > 0) {
        this.delta = this.lapTime - bestSplit;
        this.deltaTimer = HUD_TUNING.deltaHoldTime;
        this.deltaCheckpoint = index;
      }
    }

    this.nextCheckpoint = (index + 1) % this.checkpointCount;
  }

  private handleOutOfBounds(vehicle: Vehicle, dt: number): void {
    const outside =
      !vehicle.onTrack &&
      Math.abs(vehicle.lateral) > this.layout.halfWidth + TRACK.outOfBoundsMargin;

    if (!outside) {
      this.offTrackTime = 0;
      return;
    }

    this.offTrackTime += dt;
    // 给一段宽限时间:压出路肩、飞出去再落回来都不该被立刻拽走,
    // 那种「刚出界就传送」的处理比出界本身更破坏手感。
    if (this.offTrackTime < TRACK.outOfBoundsGrace) {
      return;
    }

    this.respawn(vehicle);
  }

  /** 把载具放回最近通过的检查点,速度清零、车头朝赛道方向。 */
  respawn(vehicle: Vehicle): void {
    const samples = this.layout.samples;
    const index = Math.floor(
      (this.lastCheckpoint * this.checkpointArc) / this.layout.spacing,
    );
    const sample = samples[index % samples.length];
    if (sample === undefined) {
      return;
    }

    vehicle.reset(sample.x, sample.z, Math.atan2(sample.tangentX, sample.tangentZ));
    this.offTrackTime = 0;
    this.resets++;
  }
}
