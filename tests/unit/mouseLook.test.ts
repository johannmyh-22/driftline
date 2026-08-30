import { afterEach, describe, expect, it } from 'vitest';
import { MouseLook } from '../../src/core/mouseLook';
import { CAMERA } from '../../src/game/tuning';

/*
 * Node 下没有 DOM,这里搭一套只够 MouseLook 用的假元素/假 document:
 * 记录监听器,手动派发事件,并且能切换 pointerLockElement 来模拟锁定与否。
 */
type Listener = (event: unknown) => void;

class FakeTarget {
  readonly listeners = new Map<string, Set<Listener>>();
  lockRequested = 0;

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatch(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event);
    }
  }

  requestPointerLock(): void {
    this.lockRequested++;
  }
}

function install(): { element: FakeTarget; doc: FakeTarget; look: MouseLook; lock: (on: boolean) => void } {
  const element = new FakeTarget();
  const doc = new FakeTarget();
  // 假 document 只需要 addEventListener/removeEventListener/pointerLockElement
  // 三样,不去凑真正的 Document 接口(那是 180 多个成员)。
  const docRef = doc as unknown as { pointerLockElement: unknown };
  docRef.pointerLockElement = null;
  Object.defineProperty(globalThis, 'document', {
    value: doc,
    writable: true,
    configurable: true,
  });

  const look = new MouseLook(element as unknown as HTMLElement, {
    sensitivity: CAMERA.lookSensitivity,
    yawLimit: CAMERA.lookYawLimit,
    pitchMin: CAMERA.lookPitchMin,
    pitchMax: CAMERA.lookPitchMax,
    recenterDelay: CAMERA.lookRecenterDelay,
    recenterLambda: CAMERA.lookRecenterLambda,
  });

  const lock = (on: boolean): void => {
    docRef.pointerLockElement = on ? element : null;
    doc.dispatch('pointerlockchange', {});
  };
  return { element, doc, look, lock };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document');
});

describe('MouseLook', () => {
  it('没有指针锁定时忽略鼠标移动——否则光标划过画面就会莫名其妙转视角', () => {
    const { doc, look } = install();
    doc.dispatch('mousemove', { movementX: 500, movementY: 200 });
    expect(look.yaw).toBe(0);
    expect(look.pitch).toBe(0);
    look.dispose();
  });

  it('点击画面会申请指针锁定', () => {
    const { element, look } = install();
    element.dispatch('click', {});
    expect(element.lockRequested).toBe(1);
    look.dispose();
  });

  it('锁定后鼠标位移按灵敏度累积成角度', () => {
    const { doc, look, lock } = install();
    lock(true);
    doc.dispatch('mousemove', { movementX: 100, movementY: 50 });
    // yaw 取负:它是"相机绕车转多少"不是"视线转多少",两者方向相反,
    // 见 mouseLook.ts 里的注释(人类实测反馈"左右弄反了")。
    expect(look.yaw).toBeCloseTo(-100 * CAMERA.lookSensitivity, 6);
    expect(look.pitch).toBeCloseTo(50 * CAMERA.lookSensitivity, 6);
    look.dispose();
  });

  it('鼠标右移 = 视线向右 = 相机绕到车的左边(负 yaw)', () => {
    const { doc, look, lock } = install();
    lock(true);
    doc.dispatch('mousemove', { movementX: 200, movementY: 0 });
    expect(look.yaw).toBeLessThan(0);
    look.reset();
    doc.dispatch('mousemove', { movementX: -200, movementY: 0 });
    expect(look.yaw).toBeGreaterThan(0);
    look.dispose();
  });

  it('偏航与俯仰都被夹在范围内,不会转到天上去', () => {
    const { doc, look, lock } = install();
    lock(true);
    for (let i = 0; i < 50; i++) {
      doc.dispatch('mousemove', { movementX: 5000, movementY: 5000 });
    }
    expect(look.yaw).toBeCloseTo(-CAMERA.lookYawLimit, 6);
    expect(look.pitch).toBeCloseTo(CAMERA.lookPitchMax, 6);

    for (let i = 0; i < 100; i++) {
      doc.dispatch('mousemove', { movementX: -5000, movementY: -5000 });
    }
    expect(look.yaw).toBeCloseTo(CAMERA.lookYawLimit, 6);
    expect(look.pitch).toBeCloseTo(CAMERA.lookPitchMin, 6);
    look.dispose();
  });

  it('停顿超过 recenterDelay 之后自动回正', () => {
    const { doc, look, lock } = install();
    lock(true);
    doc.dispatch('mousemove', { movementX: 300, movementY: 0 });
    const turned = look.yaw;
    // 只关心"转开了",方向由上面那条专门的测试管。
    expect(Math.abs(turned)).toBeGreaterThan(0);

    // 停顿窗口之内不动。
    const dt = 1 / 60;
    for (let t = 0; t < CAMERA.lookRecenterDelay - 0.05; t += dt) {
      look.update(dt);
    }
    expect(look.yaw).toBeCloseTo(turned, 6);

    // 过了停顿窗口就往回收。
    for (let t = 0; t < 4; t += dt) {
      look.update(dt);
    }
    expect(Math.abs(look.yaw)).toBeLessThan(Math.abs(turned) * 0.05);
    look.dispose();
  });

  it('回正计时会被新的鼠标移动打断', () => {
    const { doc, look, lock } = install();
    lock(true);
    doc.dispatch('mousemove', { movementX: 300, movementY: 0 });
    const turned = look.yaw;
    const dt = 1 / 60;
    for (let i = 0; i < 200; i++) {
      look.update(dt);
      doc.dispatch('mousemove', { movementX: 0, movementY: 0 });
    }
    expect(look.yaw).toBeCloseTo(turned, 6);
    look.dispose();
  });

  it('reset 立刻清零', () => {
    const { doc, look, lock } = install();
    lock(true);
    doc.dispatch('mousemove', { movementX: 300, movementY: 120 });
    look.reset();
    expect(look.yaw).toBe(0);
    expect(look.pitch).toBe(0);
    look.dispose();
  });

  it('dispose 之后不再响应事件', () => {
    const { doc, look, lock } = install();
    lock(true);
    look.dispose();
    doc.dispatch('mousemove', { movementX: 500, movementY: 0 });
    expect(look.yaw).toBe(0);
  });
});
