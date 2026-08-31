import { clamp } from './mathx';

/**
 * 一帧的操作意图。刻意做成「归一化的模拟量」而不是「哪个键按下了」——
 * 键盘、手柄、触屏都能填进同一个结构,下游物理代码不需要知道来源。
 */
export interface InputFrame {
  /** 0..1 前进油门。 */
  throttle: number;
  /** 0..1 倒车。 */
  reverse: number;
  /** -1(左)..1(右)。 */
  steer: number;
  /** 0..1 空气刹。 */
  airBrake: number;
}

export function createInputFrame(): InputFrame {
  return { throttle: 0, reverse: 0, steer: 0, airBrake: 0 };
}

export function copyInputFrame(source: InputFrame, target: InputFrame): void {
  target.throttle = source.throttle;
  target.reverse = source.reverse;
  target.steer = source.steer;
  target.airBrake = source.airBrake;
}

export function clampInputFrame(frame: InputFrame): void {
  frame.throttle = clamp(frame.throttle, 0, 1);
  frame.reverse = clamp(frame.reverse, 0, 1);
  frame.steer = clamp(frame.steer, -1, 1);
  frame.airBrake = clamp(frame.airBrake, 0, 1);
}

/** 输入来源。`sample` 必须把结果写进 `out`,不要返回新对象 —— 它在每帧路径上。 */
export interface InputSource {
  sample(out: InputFrame): void;
}

/**
 * 把几个输入源合成一个。**「绝对值大的赢」,不是后者覆盖前者。**
 *
 * 键盘和触屏会同时存在(平板接键盘、桌面开着触屏调试),后者覆盖前者的话
 * 没在用的那一路每帧都会把另一路清零 —— 表现是"两个都插着就都不好使",
 * 而且只在同时接的机器上出现。
 */
export class MergedInput implements InputSource {
  private readonly sources: readonly InputSource[];
  /** 复用的临时帧。每帧路径上不许分配对象。 */
  private readonly scratch: InputFrame = createInputFrame();

  constructor(sources: readonly InputSource[]) {
    this.sources = sources;
  }

  sample(out: InputFrame): void {
    out.throttle = 0;
    out.reverse = 0;
    out.steer = 0;
    out.airBrake = 0;
    for (const source of this.sources) {
      source.sample(this.scratch);
      out.throttle = Math.max(out.throttle, this.scratch.throttle);
      out.reverse = Math.max(out.reverse, this.scratch.reverse);
      out.airBrake = Math.max(out.airBrake, this.scratch.airBrake);
      if (Math.abs(this.scratch.steer) > Math.abs(out.steer)) {
        out.steer = this.scratch.steer;
      }
    }
  }
}

const KEY_BINDINGS: Readonly<Record<string, keyof InputFrame | 'steerLeft' | 'steerRight'>> = {
  KeyW: 'throttle',
  ArrowUp: 'throttle',
  KeyS: 'reverse',
  ArrowDown: 'reverse',
  KeyA: 'steerLeft',
  ArrowLeft: 'steerLeft',
  KeyD: 'steerRight',
  ArrowRight: 'steerRight',
  Space: 'airBrake',
  ShiftLeft: 'airBrake',
  ShiftRight: 'airBrake',
};

/**
 * 键盘输入。用 `event.code` 而不是 `event.key`:前者是物理按键位置,
 * 换成 AZERTY 键盘时 WASD 仍然落在同一片区域。
 */
export class KeyboardInput implements InputSource {
  private readonly pressed = new Set<string>();
  private readonly target: EventTarget;

  /** `target` 默认是 window;单测传一个假的 EventTarget 就能驱动同一条码。 */
  constructor(target: EventTarget = window) {
    this.target = target;
    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
    // 切走标签页时按键的 keyup 收不到,回来就会「油门粘住」。
    this.target.addEventListener('blur', this.onBlur);
  }

  sample(out: InputFrame): void {
    let throttle = 0;
    let reverse = 0;
    let steer = 0;
    let airBrake = 0;

    for (const code of this.pressed) {
      switch (KEY_BINDINGS[code]) {
        case 'throttle':
          throttle = 1;
          break;
        case 'reverse':
          reverse = 1;
          break;
        case 'steerLeft':
          steer -= 1;
          break;
        case 'steerRight':
          steer += 1;
          break;
        case 'airBrake':
          airBrake = 1;
          break;
        default:
          break;
      }
    }

    out.throttle = throttle;
    out.reverse = reverse;
    out.steer = clamp(steer, -1, 1);
    out.airBrake = airBrake;
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.pressed.clear();
  }

  private readonly onKeyDown = (event: Event): void => {
    const code = (event as KeyboardEvent).code;
    if (code in KEY_BINDINGS) {
      this.pressed.add(code);
      event.preventDefault();
    }
  };

  private readonly onKeyUp = (event: Event): void => {
    this.pressed.delete((event as KeyboardEvent).code);
  };

  private readonly onBlur = (): void => {
    this.pressed.clear();
  };
}

/** 由代码直接喂输入。测试和回放都走这条路,不需要伪造键盘事件。 */
export class ScriptedInput implements InputSource {
  private readonly frame = createInputFrame();

  set(partial: Partial<InputFrame>): void {
    Object.assign(this.frame, partial);
    clampInputFrame(this.frame);
  }

  reset(): void {
    this.frame.throttle = 0;
    this.frame.reverse = 0;
    this.frame.steer = 0;
    this.frame.airBrake = 0;
  }

  sample(out: InputFrame): void {
    copyInputFrame(this.frame, out);
  }
}

/** 量化步长。127 档对手感来说远远够用,而回放数据能小一个数量级。 */
const QUANTIZE = 127;

/**
 * 按固定步录制输入序列。
 *
 * M1 用它做「录一段→重放一遍→状态必须逐位一致」的确定性测试;
 * M4 的幽灵回放直接复用这份数据 —— 幽灵不存轨迹,只存输入,
 * 靠同一个 seed 和同一套物理重新算出来。
 */
export class InputRecorder {
  private readonly samples: number[] = [];

  get length(): number {
    return this.samples.length / 4;
  }

  /**
   * 记录一帧,**并就地把 `frame` 量化成回放时的精度**。
   *
   * 就地改写是刻意的:如果物理吃的是原始浮点、录下来的是量化值,
   * 幽灵就会沿着一条和你实际跑过的略有不同的线走 —— 实测 10 秒漂 1.2 米,
   * 而且越跑越偏。让录制端和仿真端看到同一串数字,这个 bug 就不存在了,
   * 而不是靠调用方记得先量化。
   */
  record(frame: InputFrame): void {
    const throttle = Math.round(clamp(frame.throttle, 0, 1) * QUANTIZE);
    const reverse = Math.round(clamp(frame.reverse, 0, 1) * QUANTIZE);
    const steer = Math.round(clamp(frame.steer, -1, 1) * QUANTIZE);
    const airBrake = Math.round(clamp(frame.airBrake, 0, 1) * QUANTIZE);

    this.samples.push(throttle, reverse, steer, airBrake);

    frame.throttle = throttle / QUANTIZE;
    frame.reverse = reverse / QUANTIZE;
    frame.steer = steer / QUANTIZE;
    frame.airBrake = airBrake / QUANTIZE;
  }

  clear(): void {
    this.samples.length = 0;
  }

  toRecording(): Int8Array {
    return Int8Array.from(this.samples);
  }
}

/** 回放 `InputRecorder` 录下的序列。放完之后输出全零,而不是回绕。 */
export class RecordedInput implements InputSource {
  private readonly data: Int8Array;
  private cursor = 0;

  constructor(data: Int8Array) {
    if (data.length % 4 !== 0) {
      throw new RangeError('回放数据长度必须是 4 的倍数');
    }
    this.data = data;
  }

  get finished(): boolean {
    return this.cursor >= this.data.length;
  }

  rewind(): void {
    this.cursor = 0;
  }

  sample(out: InputFrame): void {
    if (this.finished) {
      out.throttle = 0;
      out.reverse = 0;
      out.steer = 0;
      out.airBrake = 0;
      return;
    }
    out.throttle = (this.data[this.cursor] ?? 0) / QUANTIZE;
    out.reverse = (this.data[this.cursor + 1] ?? 0) / QUANTIZE;
    out.steer = (this.data[this.cursor + 2] ?? 0) / QUANTIZE;
    out.airBrake = (this.data[this.cursor + 3] ?? 0) / QUANTIZE;
    this.cursor += 4;
  }
}
