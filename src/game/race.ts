import { HUD_TUNING } from './tuning';
import { loadRecord, saveRecord } from './records';
import type { TrackLayout } from './trackLayout';
import { TrackRecovery } from './trackRecovery';
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
  /**
   * 出界回收。逻辑本身搬到了 `TrackRecovery`(对手车也要用,见那个类的注释),
   * 这里保留 `offTrackTime`/`resets` 两个只读转发,HUD 与既有测试还按老名字读。
   */
  private readonly recovery: TrackRecovery;

  /** 连续在界外待了多久(秒)。 */
  get offTrackTime(): number {
    return this.recovery.offTrackTime;
  }

  /** 累计被重置了几次。 */
  get resets(): number {
    return this.recovery.resets;
  }

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
  private readonly checkpointArc: number;

  constructor(layout: TrackLayout) {
    this.recovery = new TrackRecovery(layout);
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
    this.recovery.reset();
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
    // 玩家送回**最近通过的检查点**,不是当前弧长——否则出界抄近道反而有赚。
    this.recovery.update(vehicle, dt, this.lastCheckpoint * this.checkpointArc);
  }

  /** 把载具放回最近通过的检查点,速度清零、车头朝赛道方向。 */
  respawn(vehicle: Vehicle): void {
    this.recovery.respawn(vehicle, this.lastCheckpoint * this.checkpointArc);
  }
}
