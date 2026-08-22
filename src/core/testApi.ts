import type { InputFrame } from './input';
import type { FrameTelemetry } from '../game/diagnostics';

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
  /**
   * M1 新增:直接注入操作意图,一直保持到下次调用。
   *
   * 没有它就没法在无头环境里测手感 —— 伪造键盘事件既脆弱又和真实
   * 输入路径不是同一条码。
   */
  setInput(input: Partial<InputFrame>): void;
  /** M1 新增:把载具放回出生点并清空输入。让一次页面加载能跑多个场景。 */
  reset(): void;
  /**
   * 「原地打转」诊断探针专用:开/关每帧的轮子级遥测采样。
   *
   * 采样是全静态的、每帧就地复写,不开销就不写;关掉后 vehicle 每帧照常跑。
   * 探测脚本在 `advance(N)` 之后读 `readVehicleTelemetry()` 拿到最后一帧。
   */
  setTelemetryEnabled(flag: boolean): void;
  /** 读走上一帧的轮子级遥测(在 advance/reset 之后调用)。 */
  readVehicleTelemetry(): FrameTelemetry;
}

declare global {
  interface Window {
    __DRIFTLINE_TEST__?: DriftlineTestApi;
  }
}

export function installTestApi(api: DriftlineTestApi): void {
  window.__DRIFTLINE_TEST__ = api;
}
