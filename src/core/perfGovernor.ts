import { PERF } from '../game/tuning';

/** 一档画质。分辨率先降,后处理最后才关 —— 顺序的理由见 `PERF.levels` 的注释。 */
export interface PerfLevel {
  /** 渲染分辨率倍率,乘在 `devicePixelRatio` 上。 */
  readonly scale: number;
  /** 这一档是否还开后处理。 */
  readonly post: boolean;
}

/**
 * 动态画质调节(M6「DPR 自适应、动态分辨率缩放、低配自动关后处理」)。
 *
 * ## 判据为什么是「相对显示器周期」而不是「绝对毫秒」
 *
 * 唯一拿得到的信号是**两次渲染之间的墙钟间隔**,而它被 vsync 钳住:60 Hz 上
 * 渲染再轻松也只报 16.7 ms,144 Hz 上再轻松也只报 6.9 ms。所以「超过 16.7 ms
 * 就降档」这种绝对阈值是错的 —— 它在 144 Hz 屏上永远不降,在 30 Hz 屏上永远
 * 降到底。
 *
 * 这里改成先**学出显示器周期**(长窗口里的最小间隔,vsync 锁死的那个值),
 * 再按「实际间隔是周期的几倍」判断:
 *
 * - 一大半帧都超过 `missRatio` 倍周期 → 在掉帧,降一档。
 * - 几乎每一帧都贴着周期跑 → 有余量,升一档试试。
 *
 * ## 为什么需要「天花板」
 *
 * vsync 把余量藏起来了:锁在 60 fps 跑满和「刚好只能跑 60 fps」报的是同一个
 * 16.7 ms,升上去之前无从分辨。所以升档本质上是**试探**,试错了会立刻掉回来。
 * 只有冷却时间挡不住这种来回抖(升→掉帧→降→冷却结束→再升),必须记住
 * 「这一档试过、不行」:`ceiling` 就是这个记忆,它在 `ceilingHoldFrames` 之后
 * 才慢慢放开,允许环境真的变好(比如别的程序退出了)之后再试。
 *
 * ## 不在 `?test=1` 下构造
 *
 * 分辨率会变,截图就不可复现了。和 `Hud`/`AudioDirector` 同一条:测试模式
 * 根本不构造这个类,而不是构造了再判一个标志。
 */
export class PerfGovernor {
  private readonly levels: readonly PerfLevel[];
  /** 当前档位下标,0 = 最高画质。 */
  private index = 0;
  /** 允许升到的最高档(下标最小值)。试探失败会把它压下来。 */
  private ceiling = 0;
  /** `ceiling` 放开的倒计时(帧)。 */
  private ceilingHold = 0;
  /** 下一次试探失败要锁多久。每失败一次翻倍 —— 环境一直没变就别一直试。 */
  private nextHold: number = PERF.ceilingHoldFrames;
  /** 换档后的冷却(帧),期间不再做任何判断。 */
  private cooldown = 0;
  /** 判据窗口:最近若干帧的间隔(毫秒)。 */
  private readonly window: number[] = [];
  /**
   * 学显示器周期用:**见过的最小的若干个间隔**,升序保存。
   *
   * 一开始写的是「最近 240 帧里的最小值」,**那是错的**:一旦持续掉帧,
   * 窗口里最快的一帧也是慢的,估出来的"周期"跟着涨,于是"掉帧"这个判据
   * 自己把自己抹平了 —— 单测里一路喂 50 ms 反而一档都不降。刷新率是硬件
   * 属性,不该跟着负载走,所以改成**历史最小**。
   *
   * 不直接用单个最小值:两次 rAF 偶尔会挨得极近(补帧、时间戳抖动),一个
   * 异常小的样本会把周期永久钉低。取第 `periodSlots` 小的那个,单个异常值
   * 顶不动它。
   */
  private readonly fastest: number[] = [];
  /** 上一次是升档吗?用来认出「升上去就掉帧」这个模式。 */
  private lastWasUpgrade = false;
  /** 收到过多少个有效样本。 */
  private seen = 0;

  constructor(levels: readonly PerfLevel[] = PERF.levels) {
    if (levels.length === 0) {
      throw new Error('PerfGovernor: 至少要有一档');
    }
    this.levels = levels;
  }

  get level(): PerfLevel {
    return this.levels[this.index] as PerfLevel;
  }

  get levelIndex(): number {
    return this.index;
  }

  /** 学出来的显示器刷新周期(毫秒)。样本不够时返回 null。 */
  get displayPeriodMs(): number | null {
    if (this.seen < PERF.periodMinSamples || this.fastest.length < PERF.periodSlots) {
      return null;
    }
    return this.fastest[this.fastest.length - 1] as number;
  }

  /**
   * 喂一帧的间隔(毫秒)。返回**档位是否变了** —— 变了才需要去重建渲染目标,
   * 那是个不便宜的操作,不能每帧都做。
   */
  sample(intervalMs: number): boolean {
    /*
     * 明显异常的间隔直接扔掉,不进任何窗口:切走标签页、断点、一次大 GC 都会
     * 报出几百毫秒。把它们算进去会让画质在用户切回来的一瞬间无端掉两档。
     */
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > PERF.outlierMs) {
      return false;
    }

    this.seen++;
    // 有序插入,只留最小的 periodSlots 个。数组长度是个位数,这么写最直白。
    if (this.fastest.length < PERF.periodSlots || intervalMs < (this.fastest[this.fastest.length - 1] as number)) {
      const at = this.fastest.findIndex((v) => v > intervalMs);
      this.fastest.splice(at < 0 ? this.fastest.length : at, 0, intervalMs);
      if (this.fastest.length > PERF.periodSlots) {
        this.fastest.pop();
      }
    }
    this.window.push(intervalMs);
    if (this.window.length > PERF.windowFrames) {
      this.window.shift();
    }

    if (this.ceilingHold > 0) {
      this.ceilingHold--;
      if (this.ceilingHold === 0 && this.ceiling > 0) {
        // 慢慢放开天花板:一次只放一档,再让它重新试探。
        this.ceiling--;
      }
    }
    if (this.cooldown > 0) {
      this.cooldown--;
      return false;
    }

    const period = this.displayPeriodMs;
    if (period === null || this.window.length < PERF.windowFrames) {
      return false;
    }

    let missed = 0;
    let healthy = 0;
    for (const ms of this.window) {
      if (ms > period * PERF.missRatio) {
        missed++;
      } else if (ms <= period * PERF.healthyRatio) {
        healthy++;
      }
    }
    const total = this.window.length;

    if (missed / total >= PERF.missFraction) {
      return this.shift(1);
    }

    /*
     * 撑过了一整个窗口没掉帧 —— 上一次升档是**成功**的。把"试探失败"的记忆
     * 清掉,下次再遇到瓶颈时退避从头开始算。不清的话,一台机器只要早年失败
     * 过几次,后面即使换了显卡也要等八分钟才肯往上试。
     */
    if (this.lastWasUpgrade) {
      this.lastWasUpgrade = false;
      this.nextHold = PERF.ceilingHoldFrames;
    }
    if (this.index > this.ceiling && healthy / total >= PERF.healthyFraction) {
      return this.shift(-1);
    }
    return false;
  }

  /** 换档。`step` 为正 = 降画质。 */
  private shift(step: number): boolean {
    const next = Math.min(this.levels.length - 1, Math.max(this.ceiling, this.index + step));
    if (next === this.index) {
      return false;
    }
    if (step > 0 && this.lastWasUpgrade) {
      /*
       * 升上去之后立刻又掉帧 —— 说明刚才那档试探失败了。把天花板钉在**降下来
       * 之后**的这一档上,别再往上试,直到 `ceilingHold` 走完。
       */
      this.ceiling = next;
      this.ceilingHold = this.nextHold;
      this.nextHold = Math.min(PERF.maxCeilingHoldFrames, this.nextHold * 2);
    }
    this.lastWasUpgrade = step < 0;
    this.index = next;
    this.cooldown = PERF.cooldownFrames;
    this.window.length = 0;
    return true;
  }
}
