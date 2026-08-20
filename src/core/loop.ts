/** 物理步长。整个工程只认这一个 dt,回放与截图都建立在它之上。 */
export const FIXED_DT = 1 / 60;

/** 单次 rAF 回调里最多补几步。防止切回后台标签页后一次性追上千帧。 */
const DEFAULT_MAX_STEPS_PER_TICK = 5;

export interface LoopHandlers {
  /** 固定步长的逻辑更新,`dt` 恒等于 `Loop.fixedDt`。 */
  update(dt: number): void;
  /**
   * 渲染。`alpha` 是「上一帧 → 当前帧」之间的插值系数:
   * 逻辑按 60Hz 跑,显示器可能是 144Hz,不插值就会看到抖动。
   */
  render(alpha: number): void;
}

export interface LoopOptions {
  fixedDt?: number;
  maxStepsPerTick?: number;
  /** 可注入的 rAF,单测里用来在没有浏览器的情况下驱动实时模式。 */
  requestFrame?: (callback: (timeMs: number) => void) => number;
  cancelFrame?: (handle: number) => void;
}

/**
 * 累加器式固定步长主循环。
 *
 * 两种驱动方式互斥:
 * - 实时模式 `start()`:注册 rAF。
 * - 测试模式:**完全不注册 rAF**,只由外部 `advance(n)` 推进。
 *   `?test=1` 下 main.ts 不会调用 `start()`,所以截图不受机器性能影响。
 */
export class Loop {
  readonly fixedDt: number;

  private readonly handlers: LoopHandlers;
  private readonly maxStepsPerTick: number;
  private readonly requestFrame: (callback: (timeMs: number) => void) => number;
  private readonly cancelFrame: (handle: number) => void;

  private accumulator = 0;
  private frameCount = 0;
  private lastTimeMs: number | null = null;
  private handle: number | null = null;
  /** 被上限截掉、故意丢弃的模拟时间,单测用它断言追帧没有失控。 */
  private droppedTime = 0;

  constructor(handlers: LoopHandlers, options: LoopOptions = {}) {
    this.handlers = handlers;
    this.fixedDt = options.fixedDt ?? FIXED_DT;
    this.maxStepsPerTick = options.maxStepsPerTick ?? DEFAULT_MAX_STEPS_PER_TICK;
    this.requestFrame =
      options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? ((h) => cancelAnimationFrame(h));
  }

  /** 已完成的固定步数。 */
  get frame(): number {
    return this.frameCount;
  }

  /** 模拟时间(秒)。由帧数乘出来,避免逐帧累加的浮点漂移。 */
  get elapsed(): number {
    return this.frameCount * this.fixedDt;
  }

  get running(): boolean {
    return this.handle !== null;
  }

  get dropped(): number {
    return this.droppedTime;
  }

  /** 进入实时模式。重复调用是幂等的。 */
  start(): void {
    if (this.handle !== null) {
      return;
    }
    this.lastTimeMs = null;
    this.handle = this.requestFrame(this.tick);
  }

  stop(): void {
    if (this.handle === null) {
      return;
    }
    this.cancelFrame(this.handle);
    this.handle = null;
    this.lastTimeMs = null;
    this.accumulator = 0;
  }

  /**
   * 测试模式推进:恰好走 `frames` 个固定步,然后渲染一次。
   *
   * 这里用 `alpha = 1` 而不是 `accumulator / fixedDt`(=0):截图必须画的是
   * `snapshot()` 报告的那个状态,否则断言值和图对不上。
   */
  advance(frames: number): void {
    if (!Number.isInteger(frames) || frames < 0) {
      throw new RangeError(`advance() 需要非负整数,收到 ${String(frames)}`);
    }
    for (let i = 0; i < frames; i++) {
      this.step();
    }
    this.handlers.render(1);
  }

  private step(): void {
    this.handlers.update(this.fixedDt);
    this.frameCount++;
  }

  private readonly tick = (timeMs: number): void => {
    this.handle = this.requestFrame(this.tick);
    this.pump(timeMs);
  };

  /**
   * 把墙钟时间喂进累加器,补齐固定步,再渲染插值帧。
   *
   * 与 rAF 注册分开,单测才能在没有浏览器的情况下逐个时间戳驱动实时路径。
   */
  pump(timeMs: number): void {
    const previous = this.lastTimeMs ?? timeMs;
    this.lastTimeMs = timeMs;
    this.accumulator += Math.max(0, (timeMs - previous) / 1000);

    const budget = this.maxStepsPerTick * this.fixedDt;
    if (this.accumulator > budget) {
      this.droppedTime += this.accumulator - budget;
      this.accumulator = budget;
    }

    while (this.accumulator >= this.fixedDt) {
      this.accumulator -= this.fixedDt;
      this.step();
    }

    this.handlers.render(this.accumulator / this.fixedDt);
  }
}
