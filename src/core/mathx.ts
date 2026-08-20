/** 标量工具。都是纯函数、不分配对象,可以放心在每帧路径上调用。 */

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 指数趋近。`lambda` 越大追得越快。
 *
 * 为什么不用 `lerp(a, b, 0.1)` 这种写法:那个 0.1 隐含了「每帧」的假设,
 * dt 一变手感就跟着变。这里的形式对 dt 是稳定的。
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** 以固定速率逼近目标,不会过冲。用在转向这类需要「线性回中」的地方。 */
export function moveToward(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) {
    return target;
  }
  return current + Math.sign(delta) * maxDelta;
}

/** 把 `value` 从 `[inMin, inMax]` 映射到 `[0, 1]`,超出部分截断。 */
export function normalize01(value: number, inMin: number, inMax: number): number {
  if (inMax === inMin) {
    return 0;
  }
  return clamp((value - inMin) / (inMax - inMin), 0, 1);
}
