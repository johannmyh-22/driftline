import { clamp } from '../core/mathx';
import { AUDIO } from '../game/tuning';

const STORAGE_KEY = 'driftline:audio';

interface StoredAudioSettings {
  volume: number;
  muted: boolean;
}

/**
 * 拿可用的 Storage 对象。**不能直接写 `window.localStorage`**——单测跑在
 * Node 环境下没有 `window`,直接引用会抛 `ReferenceError`,被下面的 try/catch
 * 悄悄吞掉,音量偏好就永远读不到也存不下,而且不会有任何测试变红(这个项目
 * 在 `records.ts` 上已经踩过一次同样的坑,见 `getStorage()` 的写法)。
 */
function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
      return window.localStorage;
    }
    if (
      typeof globalThis !== 'undefined' &&
      'localStorage' in globalThis &&
      (globalThis as unknown as { localStorage?: Storage }).localStorage
    ) {
      return (globalThis as unknown as { localStorage: Storage }).localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

function loadSettings(): StoredAudioSettings {
  const storage = getStorage();
  if (storage === null) {
    return { volume: AUDIO.masterVolume, muted: false };
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) {
      return { volume: AUDIO.masterVolume, muted: false };
    }
    const parsed = JSON.parse(raw) as Partial<StoredAudioSettings>;
    const volume =
      typeof parsed.volume === 'number' && parsed.volume >= 0 && parsed.volume <= 1
        ? parsed.volume
        : AUDIO.masterVolume;
    return { volume, muted: parsed.muted === true };
  } catch {
    return { volume: AUDIO.masterVolume, muted: false };
  }
}

function saveSettings(settings: StoredAudioSettings): void {
  const storage = getStorage();
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 存不下就算了,音量控件本身还能用,只是刷新后回到默认值。
  }
}

/**
 * 唯一的 `AudioContext` 与主音量总线。
 *
 * 浏览器自动播放策略要求 `AudioContext` 在用户手势之后才会真正出声——
 * 构造时创建的上下文是 `suspended` 的,`resume()` 由 `main.ts` 在首次
 * 按键/点击时调用一次,不在这里自己猜「什么算用户手势」。
 */
export class AudioBus {
  readonly context: AudioContext;
  readonly master: GainNode;

  private volume: number;
  private muted: boolean;

  constructor() {
    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.master.connect(this.context.destination);

    const settings = loadSettings();
    this.volume = settings.volume;
    this.muted = settings.muted;
    this.applyGain();
  }

  /**
   * 在用户手势里调。**无条件调 `context.resume()`,不要按 `state` 判断是否
   * 需要调。**
   *
   * 老代码写的是 `if (state === 'suspended') resume()`,人类实际听到的症状是
   * 「刚进游戏没声音,得撞一下车之后引擎声才出来」。原因就在这个判断上:
   * Chrome 的自动播放策略下,未经手势创建的 `AudioContext` **可以报告
   * `state === 'running'` 却根本不出声**——被策略挡住和被 `suspend()` 挂起
   * 是两回事,`state` 只反映后者。于是这个 if 把唯一能解锁它的那次调用跳过了。
   *
   * `resume()` 在已经运行的上下文上是无害的空操作,所以这里不做任何判断。
   */
  resume(): void {
    void this.context.resume().then(() => {
      // 解锁之后按当前(已经开始走动的)时钟重新锚一次主音量:构造时那次
      // setTargetAtTime 锚在冻结的 currentTime 上,解锁后可能是一条已经过期的
      // 自动化曲线。
      this.applyGain();
    });
  }

  /** 上下文是否真的在跑。`main.ts` 用它决定要不要继续等下一次手势。 */
  get isRunning(): boolean {
    return this.context.state === 'running';
  }

  get currentVolume(): number {
    return this.volume;
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    this.applyGain();
    saveSettings({ volume: this.volume, muted: this.muted });
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
    saveSettings({ volume: this.volume, muted: this.muted });
  }

  private applyGain(): void {
    // setTargetAtTime 而不是直接赋值:音量滑块拖动时不能有咔哒声。
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.context.currentTime, 0.05);
  }

  dispose(): void {
    void this.context.close();
  }
}
