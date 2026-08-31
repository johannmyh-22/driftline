import { describe, expect, it } from 'vitest';
import { createInputFrame } from '../../src/core/input';
import { TouchInput } from '../../src/core/touchInput';
import { TOUCH } from '../../src/game/tuning';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 触屏操作的判据。**这一层必须是纯逻辑、必须能在 node 里跑** —— 死区、多指、
 * 摇杆原点、命中判定全是"能出错又看不出来"的数值细节,而它们只在真手机上
 * 才暴露。DOM 那一半在 `game/touchOverlay.ts`,两边读同一张 `TOUCH` 表。
 * ══════════════════════════════════════════════════════════════════════════
 */

const W = 800;
const H = 400;
const UNIT = Math.min(W, H);

function makeInput(): TouchInput {
  const input = new TouchInput();
  input.resize(W, H);
  return input;
}

/** 某个按钮的像素中心。 */
function buttonCentre(action: string): [number, number] {
  const button = TOUCH.buttons.find((b) => b.action === action);
  if (button === undefined) {
    throw new Error(`没有这个按钮:${action}`);
  }
  return [button.centre[0] * W, button.centre[1] * H];
}

describe('TouchInput 摇杆', () => {
  it('按下那一刻方向是回正的 —— 摇杆是相对的,不是绝对的', () => {
    const input = makeInput();
    const frame = createInputFrame();
    // 故意按在离提示圈中心很远的地方。绝对式实现在这里会立刻打死方向。
    input.press(1, 10, H - 10);
    input.sample(frame);
    expect(frame.steer).toBe(0);
  });

  it('往右拖到满程 steer 到 1,往左到 −1', () => {
    const input = makeInput();
    const frame = createInputFrame();
    const radius = TOUCH.stickRadius * UNIT;

    input.press(1, 200, 300);
    input.move(1, 200 + radius, 300);
    input.sample(frame);
    expect(frame.steer).toBeCloseTo(1, 6);

    input.move(1, 200 - radius, 300);
    input.sample(frame);
    expect(frame.steer).toBeCloseTo(-1, 6);
  });

  it('超过满程不会溢出', () => {
    const input = makeInput();
    const frame = createInputFrame();
    input.press(1, 200, 300);
    input.move(1, 200 + TOUCH.stickRadius * UNIT * 5, 300);
    input.sample(frame);
    expect(frame.steer).toBe(1);
  });

  it('死区内不出方向,出了死区从 0 连续长上去(不跳变)', () => {
    const input = makeInput();
    const frame = createInputFrame();
    const radius = TOUCH.stickRadius * UNIT;
    input.press(1, 200, 300);

    // 死区里面:拇指静止时的抖动不该让直线段一直在微调方向。
    input.move(1, 200 + radius * TOUCH.deadZone * 0.9, 300);
    input.sample(frame);
    expect(frame.steer).toBe(0);

    // 刚出死区:必须接近 0,而不是直接跳到 deadZone 对应的值。
    input.move(1, 200 + radius * (TOUCH.deadZone + 0.001), 300);
    input.sample(frame);
    expect(frame.steer).toBeGreaterThan(0);
    expect(frame.steer).toBeLessThan(0.02);
  });

  it('松手方向立刻回正', () => {
    const input = makeInput();
    const frame = createInputFrame();
    input.press(1, 200, 300);
    input.move(1, 200 + TOUCH.stickRadius * UNIT, 300);
    input.release(1);
    input.sample(frame);
    expect(frame.steer).toBe(0);
    expect(input.stick).toBeNull();
  });
});

describe('TouchInput 按钮', () => {
  it('三个按钮各自映射到对应的输入', () => {
    for (const action of ['throttle', 'airBrake', 'reverse'] as const) {
      const input = makeInput();
      const frame = createInputFrame();
      const [x, y] = buttonCentre(action);
      input.press(7, x, y);
      input.sample(frame);
      expect(frame[action], `${action} 没接上`).toBe(1);
    }
  });

  it('松开就松开,不会粘住', () => {
    const input = makeInput();
    const frame = createInputFrame();
    const [x, y] = buttonCentre('throttle');
    input.press(7, x, y);
    input.release(7);
    input.sample(frame);
    expect(frame.throttle).toBe(0);
  });

  it('按钮圈外按下不算按住', () => {
    const input = makeInput();
    const frame = createInputFrame();
    const button = TOUCH.buttons.find((b) => b.action === 'throttle')!;
    const [x, y] = buttonCentre('throttle');
    input.press(7, x, y - button.radius * UNIT * 1.6);
    input.sample(frame);
    expect(frame.throttle).toBe(0);
  });
});

describe('TouchInput 多指', () => {
  /*
   * 打方向的同时踩油门是常态。只记「最后一个 pointer」的实现会在踩油门那一下
   * 把方向抢走 —— 这是触屏最典型的 bug,而且**在鼠标上永远复现不出来**。
   */
  it('一根指头打方向、另一根踩油门,互不干扰', () => {
    const input = makeInput();
    const frame = createInputFrame();
    const [tx, ty] = buttonCentre('throttle');

    input.press(1, 200, 300);
    input.move(1, 200 + TOUCH.stickRadius * UNIT, 300);
    input.press(2, tx, ty);

    input.sample(frame);
    expect(frame.steer).toBeCloseTo(1, 6);
    expect(frame.throttle).toBe(1);

    // 松开油门那根,方向还在。
    input.release(2);
    input.sample(frame);
    expect(frame.steer).toBeCloseTo(1, 6);
    expect(frame.throttle).toBe(0);
  });

  it('第二根指头按进摇杆区不会抢走摇杆', () => {
    const input = makeInput();
    const frame = createInputFrame();
    input.press(1, 200, 300);
    input.move(1, 200 + TOUCH.stickRadius * UNIT, 300);
    // 另一根手指也落在左半屏 —— 不该改变方向。
    expect(input.press(2, 60, 60)).toBe(false);
    input.move(2, 60, 60);
    input.sample(frame);
    expect(frame.steer).toBeCloseTo(1, 6);
  });

  it('油门刹车能同时按住 —— 左脚刹车是合法操作,不该互斥', () => {
    const input = makeInput();
    const frame = createInputFrame();
    input.press(1, ...buttonCentre('throttle'));
    input.press(2, ...buttonCentre('airBrake'));
    input.sample(frame);
    expect(frame.throttle).toBe(1);
    expect(frame.airBrake).toBe(1);
  });

  it('releaseAll 把所有指头松掉 —— 切走标签页时油门不能粘住', () => {
    const input = makeInput();
    const frame = createInputFrame();
    input.press(1, 200, 300);
    input.move(1, 200 + TOUCH.stickRadius * UNIT, 300);
    input.press(2, ...buttonCentre('throttle'));
    input.releaseAll();
    input.sample(frame);
    expect(frame.throttle).toBe(0);
    expect(frame.steer).toBe(0);
  });
});

describe('TouchInput 命中与布局', () => {
  it('按钮优先于摇杆 —— 两者重叠时按钮说了算', () => {
    // 用一张自定义按钮表把按钮**故意**放进摇杆区里。现行布局不会重叠
    // (下一条测的就是这个),但这条规则是防线,不能因为"现在碰不到"就不测。
    const input = new TouchInput([
      { action: 'throttle', centre: [0.2, 0.75], radius: 0.1 },
    ]);
    input.resize(W, H);
    const frame = createInputFrame();
    input.press(1, 0.2 * W, 0.75 * H);
    input.sample(frame);
    expect(frame.throttle).toBe(1);
    expect(frame.steer).toBe(0);
    expect(input.stick).toBeNull();
  });

  it('现行布局里按钮全在摇杆区之外', () => {
    /*
     * 摇杆区是**整个左半屏**,按钮只要伸进去一点,那块面积就被"按钮优先"
     * 悄悄吃掉了 —— 表现是"左手拇指靠右一点就打不了方向",而且只在某些
     * 屏幕比例下出现。所以把这条钉成布局不变量,不是靠肉眼看控件。
     */
    for (const ratio of [
      [800, 400],
      [400, 800],
      [1280, 720],
    ] as const) {
      const [width, height] = ratio;
      const unit = Math.min(width, height);
      for (const button of TOUCH.buttons) {
        const left = button.centre[0] * width - button.radius * unit;
        expect(
          left,
          `${button.action} 在 ${width}x${height} 下伸进了摇杆区`,
        ).toBeGreaterThan(width * TOUCH.stickZoneWidth);
      }
    }
  });

  it('右半屏空白处按下不接管 —— 那儿要留给鼠标/触摸转视角', () => {
    const input = makeInput();
    expect(input.press(1, W * 0.55, H * 0.15)).toBe(false);
  });

  it('控件大小按较短边算,横竖屏一致', () => {
    const landscape = new TouchInput();
    landscape.resize(800, 400);
    const portrait = new TouchInput();
    portrait.resize(400, 800);

    // 同样"离原点 0.1×短边"的拖动,两种朝向该给出同一个 steer。
    const drag = 0.1 * 400;
    for (const input of [landscape, portrait]) {
      input.press(1, 100, 200);
      input.move(1, 100 + drag, 200);
    }
    const a = createInputFrame();
    const b = createInputFrame();
    landscape.sample(a);
    portrait.sample(b);
    expect(a.steer).toBeCloseTo(b.steer, 9);
  });
});
