/**
 * 无头验证契约。契约本体写在根目录 CLAUDE.md,这里是它的类型化落地。
 *
 * 只有 `?test=1` 时才挂载:实时模式下没人应该能从控制台手动步进世界。
 */
export interface DriftlineTestApi {
  /** 渲染器与场景就绪、且已画过第一帧。 */
  ready: Promise<void>;
  /** 以固定 dt (1/60) 步进 N 帧,然后渲染一次。 */
  advance(frames: number): void;
  /** 切到固定机位,用于回归截图。 */
  setCamera(preset: string): void;
  /** 可断言的数值快照。后续里程碑往里加字段,不改已有字段含义。 */
  snapshot(): Record<string, number>;
}

declare global {
  interface Window {
    __DRIFTLINE_TEST__?: DriftlineTestApi;
  }
}

export function installTestApi(api: DriftlineTestApi): void {
  window.__DRIFTLINE_TEST__ = api;
}
