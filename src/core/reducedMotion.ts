/**
 * 读操作系统的「减少动态效果」偏好。**不能直接写 `window.matchMedia`**——
 * 单测跑在 Node 环境下没有 `window`,直接引用会抛 `ReferenceError`;仿照
 * `records.ts`/`audio/context.ts` 的 `getStorage()` 写法防御式处理。
 */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
  } catch {
    return false;
  }
  return false;
}
