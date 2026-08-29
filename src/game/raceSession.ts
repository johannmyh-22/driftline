import { RACE_FORMAT } from './tuning';
import type { StandingRow, Standings } from './standings';

/** 赛事阶段。 */
export type RacePhase = 'countdown' | 'running' | 'finished';

/** 一辆车的完赛结果。 */
export interface RaceResult {
  readonly id: string;
  /** 完赛名次,1 = 冠军。 */
  readonly position: number;
  /** 从发车到冲线的总用时(秒)。 */
  readonly time: number;
}

/**
 * 赛制(M7 最后一格):把「无限刷圈的计时赛」变成「跑 N 圈就结束」。
 *
 * 三个阶段:
 *
 * - `countdown` —— 发车倒计时。这期间**输入被锁住**(`inputLocked`),
 *   `World` 会把油门/刹车/转向清零。抢跑不做判罚,只是压根动不了。
 * - `running` —— 正常比赛。每辆车跑满 `lapCount` 圈就记一次完赛。
 * - `finished` —— 所有车都完赛,或者冠军冲线之后又过了
 *   `RACE_FORMAT.finishGrace` 秒(否则被套圈的车会让结算画面一直等)。
 *
 * ## 为什么完赛判定读 `Standings` 而不是 `Race`
 *
 * `Race` 只伺候玩家(它还管纪录持久化),对手车根本没接进去。`Standings`
 * 的 `laps` 是从弧长累计推出来的,**每辆车都有**,而且跨起跑线不会抖
 * (见 `standings.ts` 的类注释)。名次也现成。
 *
 * ## 测试模式
 *
 * `?test=1` 下由 `World` 直接 `begin({ skipCountdown: true })`:截图回路要
 * 逐帧确定,不能让前 180 帧全耗在倒计时上——既有的冒烟测试从第 60 帧就开始
 * 断言车在动。真人游戏走开始菜单,倒计时在那之后。
 */
export class RaceSession {
  phase: RacePhase = 'countdown';
  /** 倒计时剩余秒数,`running` 之后恒为 0。 */
  countdown: number = RACE_FORMAT.countdownSeconds;
  /** 发车之后经过的时间(秒)。倒计时期间不走。 */
  elapsed = 0;
  /** 已完赛的车,按冲线顺序。 */
  readonly results: RaceResult[] = [];

  private readonly lapCount: number;
  /** 冠军冲线的时刻,还没有人完赛时是 null。 */
  private winnerTime: number | null = null;

  constructor(lapCount: number = RACE_FORMAT.lapCount) {
    this.lapCount = Math.max(1, Math.floor(lapCount));
  }

  get totalLaps(): number {
    return this.lapCount;
  }

  /** 输入是否被锁住(倒计时中,或者比赛已经结束)。 */
  get inputLocked(): boolean {
    return this.phase !== 'running';
  }

  /** 重开一局。`skipCountdown` 给测试模式用,见类注释。 */
  begin(options: { skipCountdown?: boolean } = {}): void {
    this.results.length = 0;
    this.winnerTime = null;
    this.elapsed = 0;
    if (options.skipCountdown === true) {
      this.phase = 'running';
      this.countdown = 0;
    } else {
      this.phase = 'countdown';
      this.countdown = RACE_FORMAT.countdownSeconds;
    }
  }

  /** 某辆车是否已经完赛。 */
  hasFinished(id: string): boolean {
    return this.results.some((r) => r.id === id);
  }

  resultOf(id: string): RaceResult | null {
    return this.results.find((r) => r.id === id) ?? null;
  }

  /** 每个固定步调一次,在 `Standings.update()` 之后。 */
  update(dt: number, standings: Standings | null): void {
    if (this.phase === 'countdown') {
      this.countdown = Math.max(0, this.countdown - dt);
      if (this.countdown <= 0) {
        this.phase = 'running';
      }
      return;
    }
    if (this.phase === 'finished' || standings === null) {
      return;
    }

    this.elapsed += dt;

    // 按当前名次顺序遍历,冲线顺序才和名次一致(同一帧多车完赛时尤其重要)。
    for (const row of standings.order) {
      if (row.laps < this.lapCount || this.hasFinished(row.id)) {
        continue;
      }
      this.results.push({ id: row.id, position: this.results.length + 1, time: this.elapsed });
      if (this.winnerTime === null) {
        this.winnerTime = this.elapsed;
      }
    }

    const everyoneDone = this.results.length >= standings.rows.length;
    const graceExpired =
      this.winnerTime !== null && this.elapsed - this.winnerTime >= RACE_FORMAT.finishGrace;
    if (everyoneDone || graceExpired) {
      this.finish(standings);
    }
  }

  /**
   * 收尾:还没冲线的车按当时名次补进结果里(被套圈/被撞坏的车也要有个名次,
   * 不能从结算画面里凭空消失)。
   */
  private finish(standings: Standings): void {
    for (const row of standings.order) {
      if (!this.hasFinished(row.id)) {
        this.results.push({ id: row.id, position: this.results.length + 1, time: 0 });
      }
    }
    this.phase = 'finished';
  }

  /** 结算画面用:名次顺序的行,含没冲线的。 */
  standingsRowFor(standings: Standings, id: string): StandingRow | null {
    return standings.rowOf(id);
  }
}
