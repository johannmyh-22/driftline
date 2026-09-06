/**
 * 名次:把每辆车的「跑了多远」算出来并排序。
 *
 * M7 的地基。在这之前赛道上虽然已经有对手车(第三十七节),但代码里根本没有
 * 「谁在前面」这个概念——HUD 名次、终点结算、AI 的前车感知全都要建在它上面。
 *
 * ## 为什么不直接用 `laps × 圈长 + arc`
 *
 * 因为 `Race.laps` 和 `Vehicle.arc` 是两个独立更新的量,跨过起跑线的那一两帧
 * 必然对不齐:`arc` 已经绕回 0 了,`laps` 要等检查点 0 判定通过才 +1。用乘加
 * 公式的话,那一两帧算出来的总距离会**凭空少一整圈**,名次当场翻转再翻回来,
 * HUD 上就是闪一下。
 *
 * 所以这里改成**增量累加**:每帧只看 `arc` 相对上一帧的变化量,变化量绝对值
 * 超过半圈就判定为跨越起跑线并补一个圈长回去。这个做法根本不需要 `laps`,
 * 也就不存在两个量对不齐的问题,顺便还能正确处理倒车跨线(变化量为正的一大坨
 * → 减一个圈长 → 记成后退)。
 *
 * ## 发车位:算的是「赛道上的绝对进度」,不是「自己跑了多远」
 *
 * 这条是拿截图快照核对时发现的:对手车在玩家**后面** 20 米发车,可两辆车都
 * 跑出 14.5 米之后,「各自跑了多远」几乎相等,名次就成了平手甚至对手领先——
 * 但赛道上明明是玩家领先 20 米。**跑过的路程不等于赛道上的位置**,只要发车位
 * 不在同一点,前者就不能拿来排名次。
 *
 * 所以累计值的**起点**不是 0,而是该车发车位相对起跑线的**带符号弧长**:
 * 起跑线上是 0,线后 20 米是 −20(不是 `圈长−20`,那会被当成领先一整圈)。
 * 换算方法是把弧长折进 (−半圈, +半圈] 这个区间。之后照常增量累加,两辆车的
 * 累计值就落在同一把尺子上,直接比大小即可。
 *
 * ## 为什么用弧长而不是检查点
 *
 * `Race.progress` 按检查点算,那是为了防抄近道刷圈——计时必须那么严。但名次
 * 要的是**空间上谁在前面**,分辨率必须连续:两辆车在同一个检查点区间里也得分
 * 得出先后,不然同区间内名次会一直并列。`arc` 是投影到中心线的弧长,抄近道
 * 也不会让它跳变,拿来比位置是对的。
 */

/** 一辆车的名次行。**对象复用**,不要持有引用跨帧比较。 */
export interface StandingRow {
  readonly id: string;
  /** 累计行驶弧长(米),可以超过一圈。 */
  distance: number;
  /** 已完成圈数。 */
  laps: number;
  /** 名次,1 = 领先。 */
  position: number;
  /** 落后领跑者多少米,领跑者为 0。 */
  gapToLeader: number;
  /** 落后前车多少米,领跑者为 0。 */
  gapToAhead: number;
  /** 领先后车多少米,最后一名为 0。领跑时 HUD 显示的是这个。 */
  gapToBehind: number;
}

/** 单车的累计里程。跨起跑线用增量法处理,见类注释。 */
export class RaceProgress {
  /**
   * 赛道上的绝对进度(米),从起跑线量起。发车位在线后时是负的,见类注释。
   * 不会退到自己的发车位之前。
   */
  distance = 0;

  private readonly trackLength: number;
  private readonly halfLength: number;
  private prevArc: number | null = null;
  /** 发车位的进度值,也是 `distance` 的下界。 */
  private floor = 0;

  constructor(trackLength: number) {
    this.trackLength = trackLength;
    this.halfLength = trackLength / 2;
  }

  /** 已完成圈数。还没到起跑线(发车位在线后)时是 0,不是 −1。 */
  get laps(): number {
    return Math.max(0, Math.floor(this.distance / this.trackLength));
  }

  /** 每个固定步喂一次当前弧长(`Vehicle.arc`)。 */
  update(arc: number): void {
    if (!Number.isFinite(arc)) {
      return;
    }
    if (this.prevArc === null) {
      this.prevArc = arc;
      return;
    }

    let delta = arc - this.prevArc;
    // 单帧跑不过半圈,所以超过半圈的跳变一定是跨越了起跑线而不是真的位移。
    if (delta < -this.halfLength) {
      delta += this.trackLength;
    } else if (delta > this.halfLength) {
      delta -= this.trackLength;
    }

    this.distance = Math.max(this.floor, this.distance + delta);
    this.prevArc = arc;
  }

  /**
   * 回到发车位(或换 seed 重开)。`arc` 是重置后的弧长。
   *
   * 起点取的是 `arc` 折进 (−半圈, +半圈] 之后的带符号值:起跑线后方 20 米的
   * 发车位,弧长读数是 `圈长−20`,但它的进度是 **−20** 而不是 `圈长−20`,
   * 否则会被当成领先了一整圈。
   */
  reset(arc: number): void {
    if (!Number.isFinite(arc)) {
      this.distance = 0;
      this.floor = 0;
      this.prevArc = null;
      return;
    }
    const wrapped = ((arc % this.trackLength) + this.trackLength) % this.trackLength;
    this.distance = wrapped > this.halfLength ? wrapped - this.trackLength : wrapped;
    this.floor = this.distance;
    this.prevArc = arc;
  }
}

/**
 * 一组车的名次表。
 *
 * `rows` 保持构造时的 id 顺序(方便按索引喂数据),`order` 是同一批对象按名次
 * 排好的引用——**两个数组共享同一批 `StandingRow` 对象,每帧原地改写**,
 * 不新建对象。名次每个固定步算一次,CLAUDE.md 那条「每帧不分配」在这里同样成立。
 */
export class Standings {
  /** 按构造时的 id 顺序。 */
  readonly rows: StandingRow[];
  /** 同一批对象,按名次排序(`order[0]` 是领跑者)。 */
  readonly order: StandingRow[];

  private readonly progress: RaceProgress[];

  constructor(ids: readonly string[], trackLength: number) {
    this.rows = ids.map((id) => ({
      id,
      distance: 0,
      laps: 0,
      position: 1,
      gapToLeader: 0,
      gapToAhead: 0,
      gapToBehind: 0,
    }));
    this.order = [...this.rows];
    this.progress = ids.map(() => new RaceProgress(trackLength));
  }

  /** 喂第 `index` 辆车这一帧的弧长。 */
  setArc(index: number, arc: number): void {
    this.progress[index]?.update(arc);
  }

  /** 全部喂完之后调一次:重排名次、算差距。 */
  update(): void {
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const progress = this.progress[i];
      if (row === undefined || progress === undefined) {
        continue;
      }
      row.distance = progress.distance;
      row.laps = progress.laps;
    }

    // 跑得远的排前面。并列时按构造顺序稳定排列(Array.sort 在现代引擎里是稳定的)。
    this.order.sort((a, b) => b.distance - a.distance);

    const leader = this.order[0];
    for (let i = 0; i < this.order.length; i++) {
      const row = this.order[i];
      if (row === undefined) {
        continue;
      }
      row.position = i + 1;
      row.gapToLeader = leader === undefined ? 0 : leader.distance - row.distance;
      const ahead = i === 0 ? undefined : this.order[i - 1];
      row.gapToAhead = ahead === undefined ? 0 : ahead.distance - row.distance;
      const behind = this.order[i + 1];
      row.gapToBehind = behind === undefined ? 0 : row.distance - behind.distance;
    }
  }

  /** 按 id 取行,找不到返回 null。 */
  rowOf(id: string): StandingRow | null {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  /** 重开:每辆车给一个重置后的弧长,顺序和构造时的 ids 一致。 */
  reset(arcs: readonly number[]): void {
    for (let i = 0; i < this.progress.length; i++) {
      this.progress[i]?.reset(arcs[i] ?? 0);
    }
    this.update();
  }
}
