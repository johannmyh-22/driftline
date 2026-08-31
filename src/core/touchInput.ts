import { clamp } from './mathx';
import { TOUCH } from '../game/tuning';
import type { InputFrame, InputSource } from './input';

/** 一个圆形按钮区。归一化坐标,半径以视口**较短边**为基准。 */
export interface TouchButton {
  readonly action: 'throttle' | 'reverse' | 'airBrake';
  readonly centre: readonly [number, number];
  readonly radius: number;
}

/** 摇杆当前的偏移,给覆盖层画摇杆头用。没按住时是 null。 */
export interface StickState {
  /** 摇杆中心的**像素**坐标(按下时那一点,不是控件中心)。 */
  readonly originX: number;
  readonly originY: number;
  /** −1..1,已经过死区处理,和 `InputFrame.steer` 同一个值。 */
  readonly value: number;
}

/**
 * 触屏操作(M6)。**这个类不碰 DOM**,只做「指头在哪 → `InputFrame`」这一段。
 *
 * 拆开的理由和 `KeyboardInput` 接一个可替换的 `EventTarget` 是同一条:这段
 * 逻辑(死区、多指、摇杆原点、按钮命中)全都是能出错又看不出来的数值细节,
 * 必须能在 vitest 里逐个断言。而 vitest 跑在 node 环境下没有 DOM,把控件
 * 一起写进来就只能靠人在手机上试。画控件那一半在 `game/touchOverlay.ts`。
 *
 * ## 摇杆是**相对**的,不是绝对的
 *
 * 按下的那一点就是摇杆原点,`steer` 按「离这一点多远」算。绝对式(按屏幕
 * 上控件的中心算)在手机上很难用:拇指第一下几乎不可能正好落在圆心上,
 * 于是一按下方向就先猛地打过去。相对式按下去永远是回正的。
 *
 * ## 多指必须按 `pointerId` 记
 *
 * 打方向的同时踩油门是常态。只记「最后一个 pointer」的话,踩油门那一下会把
 * 方向抢走 —— 这是触屏操作最典型的 bug,而且在鼠标上永远复现不出来。
 */
export class TouchInput implements InputSource {
  private readonly buttons: readonly TouchButton[];
  private width = 1;
  private height = 1;

  /** 正在打方向的那根指头。 */
  private stickPointer: number | null = null;
  private stickOriginX = 0;
  private stickOriginY = 0;
  private steer = 0;
  /** 按住某个按钮的指头:pointerId → 动作。 */
  private readonly held = new Map<number, TouchButton['action']>();

  constructor(buttons: readonly TouchButton[] = TOUCH.buttons) {
    this.buttons = buttons;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  /** 归一化半径 → 像素。以**较短边**为基准,横竖屏下控件大小才一致。 */
  private toPixels(radius: number): number {
    return radius * Math.min(this.width, this.height);
  }

  /** 摇杆当前状态,给覆盖层画摇杆头。没按住时 null。 */
  get stick(): StickState | null {
    if (this.stickPointer === null) {
      return null;
    }
    return { originX: this.stickOriginX, originY: this.stickOriginY, value: this.steer };
  }

  /** 某个动作现在是不是按住的,给覆盖层高亮按钮。 */
  isHeld(action: TouchButton['action']): boolean {
    for (const held of this.held.values()) {
      if (held === action) {
        return true;
      }
    }
    return false;
  }

  /**
   * 一根指头按下。返回**是否被这里接管** —— 覆盖层据此决定要不要
   * `preventDefault()`:接管了就不能让这一下再去触发鼠标视角的指针锁定。
   */
  press(pointerId: number, x: number, y: number): boolean {
    for (const button of this.buttons) {
      if (this.hits(button, x, y)) {
        this.held.set(pointerId, button.action);
        return true;
      }
    }
    // 按钮优先于摇杆:两者重叠时按钮说了算,不然靠近按钮的一按会变成打方向。
    if (this.stickPointer === null && this.inStickZone(x)) {
      this.stickPointer = pointerId;
      this.stickOriginX = x;
      this.stickOriginY = y;
      this.steer = 0;
      return true;
    }
    return false;
  }

  move(pointerId: number, x: number, _y: number): void {
    if (pointerId !== this.stickPointer) {
      return;
    }
    const radius = this.toPixels(TOUCH.stickRadius);
    const raw = clamp((x - this.stickOriginX) / radius, -1, 1);
    const dead = TOUCH.deadZone;
    if (Math.abs(raw) <= dead) {
      this.steer = 0;
      return;
    }
    // 死区之外重新归一化到 0..1,否则出死区的瞬间方向会跳一下。
    const sign = raw < 0 ? -1 : 1;
    this.steer = sign * ((Math.abs(raw) - dead) / (1 - dead));
  }

  release(pointerId: number): void {
    if (pointerId === this.stickPointer) {
      this.stickPointer = null;
      this.steer = 0;
    }
    this.held.delete(pointerId);
  }

  /** 所有指头一起松开。切走标签页/失焦时调,否则油门会「粘住」。 */
  releaseAll(): void {
    this.stickPointer = null;
    this.steer = 0;
    this.held.clear();
  }

  sample(out: InputFrame): void {
    out.steer = this.steer;
    out.throttle = this.isHeld('throttle') ? 1 : 0;
    out.reverse = this.isHeld('reverse') ? 1 : 0;
    out.airBrake = this.isHeld('airBrake') ? 1 : 0;
  }

  private hits(button: TouchButton, x: number, y: number): boolean {
    const cx = button.centre[0] * this.width;
    const cy = button.centre[1] * this.height;
    const r = this.toPixels(button.radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  }

  /**
   * 摇杆区是**整个左半屏**,不是画出来的那个圈。
   *
   * 画出来的圈只是「拇指大概放这儿」的提示。真按在圈外几十像素的地方还是
   * 应该能打方向 —— 手机上看不见自己的拇指,要求精确命中一个圈是不现实的。
   */
  private inStickZone(x: number): boolean {
    return x < this.width * TOUCH.stickZoneWidth;
  }
}
