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

  resume(): void {
    if (this.context.state === 'suspended') {
      void this.context.resume();
    }
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
