import { TouchInput } from '../core/touchInput';
import { TOUCH } from './tuning';

/**
 * 触屏控件的那一层 DOM(M6)。
 *
 * **判据逻辑一行都不在这里** —— 死区、多指、摇杆原点、命中判定全在
 * `core/touchInput.ts`,那边能在 vitest 里逐条断言。这里只做两件事:按 `TOUCH`
 * 那张表把控件画出来,把 pointer 事件转给 `TouchInput`。两边读同一张表,
 * 所以"画在这儿、按在那儿"这种错不可能发生。
 *
 * ## 为什么是 DOM 而不是画进 canvas
 *
 * 和 HUD 同一条(CLAUDE.md 的技术选型表):canvas 里排版文字和圆角要自己写
 * 一套,而且拿不到系统的触摸反馈。DOM 一个 `border-radius` 就完事。
 *
 * ## `touch-action: none` 是必须的
 *
 * 不设的话浏览器会把拖动当成滚动/下拉刷新,`pointermove` 收到一半就被抢走
 * (`pointercancel`),表现是"打方向打到一半方向自己回正了"。
 */
export class TouchOverlay {
  readonly input = new TouchInput();

  private readonly root: HTMLDivElement;
  private readonly stickRing: HTMLDivElement;
  private readonly stickKnob: HTMLDivElement;
  private readonly buttons = new Map<string, HTMLDivElement>();
  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.root = document.createElement('div');
    this.root.className = 'touch';

    this.stickRing = document.createElement('div');
    this.stickRing.className = 'touch-stick';
    this.stickKnob = document.createElement('div');
    this.stickKnob.className = 'touch-knob';
    this.stickRing.append(this.stickKnob);
    this.root.append(this.stickRing);

    for (const button of TOUCH.buttons) {
      const element = document.createElement('div');
      element.className = 'touch-button';
      element.textContent = LABELS[button.action] ?? '';
      this.buttons.set(button.action, element);
      this.root.append(element);
    }

    container.append(this.root);
    this.layout();

    this.root.addEventListener('pointerdown', this.onDown);
    this.root.addEventListener('pointermove', this.onMove);
    this.root.addEventListener('pointerup', this.onUp);
    // pointercancel 必须收:系统手势(通知栏下拉、来电)会直接抢走指针,
    // 不处理就是油门粘住 —— 而且是在最不该粘住的时候。
    this.root.addEventListener('pointercancel', this.onUp);
    window.addEventListener('blur', this.onBlur);
  }

  /** 视口变了就重排。控件是按归一化坐标放的,横竖屏切换必须跟着走。 */
  layout(): void {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.input.resize(width, height);
    const unit = Math.min(width, height);

    place(this.stickRing, TOUCH.stickCentre[0] * width, TOUCH.stickCentre[1] * height, TOUCH.stickRadius * unit);
    for (const button of TOUCH.buttons) {
      const element = this.buttons.get(button.action);
      if (element !== undefined) {
        place(element, button.centre[0] * width, button.centre[1] * height, button.radius * unit);
      }
    }
  }

  /**
   * 每帧刷一次视觉反馈:摇杆圈跟到拇指下面、摇杆头按方向偏出去、按住的按钮
   * 高亮。
   *
   * **摇杆圈按住时会挪到按下的那一点。** 摇杆本身是相对的(按哪儿哪儿就是
   * 原点,见 `TouchInput` 的类注释),圈却钉在固定位置的话,拇指落在圈外时
   * 画面上看到的是"手指在圈外、摇杆头在圈里动",对不上。
   */
  present(): void {
    const stick = this.input.stick;
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    const unit = Math.min(width, height);
    const radius = TOUCH.stickRadius * unit;
    if (stick === null) {
      this.stickRing.style.opacity = '';
      place(this.stickRing, TOUCH.stickCentre[0] * width, TOUCH.stickCentre[1] * height, radius);
      this.stickKnob.style.transform = 'translate(-50%, -50%)';
    } else {
      this.stickRing.style.opacity = '1';
      place(this.stickRing, stick.originX, stick.originY, radius);
      this.stickKnob.style.transform = `translate(calc(-50% + ${stick.value * radius}px), -50%)`;
    }
    for (const [action, element] of this.buttons) {
      element.classList.toggle('is-held', this.input.isHeld(action as 'throttle'));
    }
  }

  dispose(): void {
    this.root.removeEventListener('pointerdown', this.onDown);
    this.root.removeEventListener('pointermove', this.onMove);
    this.root.removeEventListener('pointerup', this.onUp);
    this.root.removeEventListener('pointercancel', this.onUp);
    window.removeEventListener('blur', this.onBlur);
    this.root.remove();
  }

  private readonly onDown = (event: PointerEvent): void => {
    if (!this.input.press(event.pointerId, event.clientX, event.clientY)) {
      return;
    }
    /*
     * 接管了就要吃掉这一下。不吃的话它会冒泡到画布上的点击处理,把鼠标视角
     * 的**指针锁定**打开 —— 手机上锁定指针的后果是所有触摸都进不来了。
     */
    event.preventDefault();
    event.stopPropagation();
    this.root.setPointerCapture(event.pointerId);
  };

  private readonly onMove = (event: PointerEvent): void => {
    this.input.move(event.pointerId, event.clientX, event.clientY);
  };

  private readonly onUp = (event: PointerEvent): void => {
    this.input.release(event.pointerId);
    if (this.root.hasPointerCapture(event.pointerId)) {
      this.root.releasePointerCapture(event.pointerId);
    }
  };

  private readonly onBlur = (): void => {
    this.input.releaseAll();
  };
}

const LABELS: Readonly<Record<string, string>> = {
  throttle: '油门',
  airBrake: '刹车',
  reverse: '倒车',
};

function place(element: HTMLElement, x: number, y: number, radius: number): void {
  element.style.left = `${x - radius}px`;
  element.style.top = `${y - radius}px`;
  element.style.width = `${radius * 2}px`;
  element.style.height = `${radius * 2}px`;
}

/**
 * 这台设备要不要出触屏控件。
 *
 * `maxTouchPoints` 而不是 `'ontouchstart' in window`:后者在带触屏的桌面
 * 浏览器上也是真,会给用鼠标的人白白盖上一层控件。`?touch=1` 强制打开,
 * 桌面上调试和无头测试都靠它 —— 无头 Chromium 默认没有触摸点。
 */
export function shouldShowTouchControls(force: boolean): boolean {
  if (force) {
    return true;
  }
  return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
}
