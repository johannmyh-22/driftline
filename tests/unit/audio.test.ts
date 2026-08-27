import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { AudioBus } from '../../src/audio/context';
import { EngineSound } from '../../src/audio/engine';
import { playImpact } from '../../src/audio/impact';
import { createNoiseBuffer } from '../../src/audio/noise';
import { playUiClick } from '../../src/audio/ui';
import { WindNoise } from '../../src/audio/wind';
import { AUDIO } from '../../src/game/tuning';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * Node/vitest 没有真实的 Web Audio API,这里搭一套最小可用的假节点图:
 * 记录每次 setTargetAtTime/setValueAtTime 的目标值,断言合成器算出的参数
 * 方向对不对(速度越快音调/音量越高之类),而不是真的听声音。
 *
 * `npm run shoot`/`test:visual` 拍不出声音,这一层单测是「音频版的截图核验」——
 * 没有它,合成公式写错了(比如速度和音量的映射反了)只能靠人耳发现。
 * ══════════════════════════════════════════════════════════════════════════
 */

class FakeAudioParam {
  value = 0;
  readonly targetCalls: { target: number; time: number; constant: number }[] = [];
  readonly valueAtTimeCalls: { value: number; time: number }[] = [];
  readonly rampCalls: { value: number; time: number }[] = [];

  setTargetAtTime(target: number, time: number, constant: number): AudioParam {
    this.targetCalls.push({ target, time, constant });
    this.value = target;
    return this as unknown as AudioParam;
  }

  setValueAtTime(value: number, time: number): AudioParam {
    this.valueAtTimeCalls.push({ value, time });
    this.value = value;
    return this as unknown as AudioParam;
  }

  exponentialRampToValueAtTime(value: number, time: number): AudioParam {
    this.rampCalls.push({ value, time });
    this.value = value;
    return this as unknown as AudioParam;
  }
}

class FakeAudioNode {
  connected: FakeAudioNode[] = [];
  disconnected = false;

  connect(target: FakeAudioNode): FakeAudioNode {
    this.connected.push(target);
    return target;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}

class FakeBiquadFilterNode extends FakeAudioNode {
  type = 'lowpass';
  readonly frequency = new FakeAudioParam();
}

class FakeOscillatorNode extends FakeAudioNode {
  type = 'sine';
  readonly frequency = new FakeAudioParam();
  started = false;
  stopped = false;
  private endedHandler: (() => void) | null = null;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
    this.endedHandler?.();
  }

  addEventListener(type: string, handler: () => void): void {
    if (type === 'ended') {
      this.endedHandler = handler;
    }
  }
}

class FakeBufferSourceNode extends FakeAudioNode {
  buffer: AudioBuffer | null = null;
  loop = false;
  started = false;
  stopped = false;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }
}

class FakeAudioBuffer {
  private readonly data: Float32Array;

  constructor(length: number) {
    this.data = new Float32Array(length);
  }

  getChannelData(_channel: number): Float32Array {
    return this.data;
  }
}

class FakeAudioContext {
  readonly destination = new FakeAudioNode();
  readonly sampleRate = 44100;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 0;

  createGain(): FakeGainNode {
    return new FakeGainNode();
  }

  createBiquadFilter(): FakeBiquadFilterNode {
    return new FakeBiquadFilterNode();
  }

  createOscillator(): FakeOscillatorNode {
    return new FakeOscillatorNode();
  }

  createBufferSource(): FakeBufferSourceNode {
    return new FakeBufferSourceNode();
  }

  createBuffer(_channels: number, length: number, _sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(length);
  }

  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

/** 造一个假 localStorage,和 records.test.ts 同一个思路。 */
function installFakeStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const storage: Storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true, configurable: true });
  return store;
}

/** 把假 AudioContext 塞进一个 `AudioBus`,绕开真实构造函数里的 `new AudioContext()`。 */
function makeBus(): { bus: AudioBus; context: FakeAudioContext } {
  installFakeStorage();
  const context = new FakeAudioContext();
  const OriginalAudioContext = globalThis.AudioContext;
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = function AudioContextStub() {
    return context;
  };
  const bus = new AudioBus();
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = OriginalAudioContext;
  return { bus, context: context };
}

describe('createNoiseBuffer', () => {
  it('用注入的 Rng 填充,不产生越界值', () => {
    const context = new FakeAudioContext();
    const buffer = createNoiseBuffer(context as unknown as AudioContext, new Rng(1), 0.01);
    const data = (buffer as unknown as FakeAudioBuffer).getChannelData(0);
    expect(data.length).toBeGreaterThan(0);
    for (const sample of data) {
      expect(sample).toBeGreaterThanOrEqual(-1);
      expect(sample).toBeLessThanOrEqual(1);
    }
  });

  it('同一个 seed 生成完全相同的缓冲(确定性)', () => {
    const context = new FakeAudioContext();
    const a = createNoiseBuffer(context as unknown as AudioContext, new Rng(7), 0.01);
    const b = createNoiseBuffer(context as unknown as AudioContext, new Rng(7), 0.01);
    expect(Array.from((a as unknown as FakeAudioBuffer).getChannelData(0))).toEqual(
      Array.from((b as unknown as FakeAudioBuffer).getChannelData(0)),
    );
  });
});

describe('AudioBus', () => {
  it('音量/静音会存进 localStorage,下次构造时读回来', () => {
    const store = installFakeStorage();
    const context1 = new FakeAudioContext();
    const OriginalAudioContext = globalThis.AudioContext;
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = function AudioContextStub() {
      return context1;
    };
    const bus1 = new AudioBus();
    bus1.setVolume(0.3);
    bus1.setMuted(true);
    expect(store.get('driftline:audio')).toContain('0.3');

    const context2 = new FakeAudioContext();
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = function AudioContextStub() {
      return context2;
    };
    const bus2 = new AudioBus();
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = OriginalAudioContext;

    expect(bus2.currentVolume).toBeCloseTo(0.3, 5);
    expect(bus2.isMuted).toBe(true);
  });

  it('setVolume 钳到 0..1', () => {
    const { bus } = makeBus();
    bus.setVolume(5);
    expect(bus.currentVolume).toBe(1);
    bus.setVolume(-2);
    expect(bus.currentVolume).toBe(0);
  });

  it('resume() 把 suspended 的 context 变成 running', () => {
    const { bus, context } = makeBus();
    expect(context.state).toBe('suspended');
    bus.resume();
    expect(context.state).toBe('running');
  });
});

describe('EngineSound', () => {
  it('速度和油门越高,目标频率/音量越高', () => {
    const { bus } = makeBus();
    const engine = new EngineSound(bus);
    const osc = (engine as unknown as { osc: FakeOscillatorNode }).osc;
    const gain = (engine as unknown as { gain: FakeGainNode }).gain;

    engine.update(0, 0, bus.context);
    const idleFreq = osc.frequency.value;
    const idleGain = gain.gain.value;

    engine.update(1, 1, bus.context);
    const maxFreq = osc.frequency.value;
    const maxGain = gain.gain.value;

    expect(maxFreq).toBeGreaterThan(idleFreq);
    expect(maxGain).toBeGreaterThan(idleGain);
    expect(idleFreq).toBeCloseTo(AUDIO.engineIdleFreq, 5);
    expect(maxFreq).toBeCloseTo(AUDIO.engineMaxFreq, 5);
  });

  it('松油门滑行(throttle=0)音量比同速度地板油低,但不是零', () => {
    const { bus } = makeBus();
    const engine = new EngineSound(bus);
    const gain = (engine as unknown as { gain: FakeGainNode }).gain;

    engine.update(0.6, 0, bus.context);
    const coastGain = gain.gain.value;
    engine.update(0.6, 1, bus.context);
    const fullGain = gain.gain.value;

    expect(coastGain).toBeGreaterThan(0);
    expect(coastGain).toBeLessThan(fullGain);
  });
});

describe('WindNoise', () => {
  it('速度越高,音量与滤波截止频率越高', () => {
    const { bus } = makeBus();
    const wind = new WindNoise(bus, new Rng(3));
    const gain = (wind as unknown as { gain: FakeGainNode }).gain;
    const filter = (wind as unknown as { filter: FakeBiquadFilterNode }).filter;

    wind.update(0, bus.context);
    expect(gain.gain.value).toBeCloseTo(0, 5);
    const idleFilter = filter.frequency.value;

    wind.update(1, bus.context);
    expect(gain.gain.value).toBeCloseTo(AUDIO.windMaxGain, 5);
    expect(filter.frequency.value).toBeGreaterThan(idleFilter);
  });
});

describe('playImpact', () => {
  it('强度低于阈值不发声', () => {
    const { bus, context } = makeBus();
    const before = context.createOscillator.bind(context);
    let calls = 0;
    context.createOscillator = () => {
      calls++;
      return before();
    };
    playImpact(bus, AUDIO.impactMinStrength - 0.01);
    expect(calls).toBe(0);
  });

  it('强度高于阈值时创建振荡器并播放,峰值随强度缩放', () => {
    const { bus, context } = makeBus();
    const oscillators: FakeOscillatorNode[] = [];
    const gains: FakeGainNode[] = [];
    const originalOsc = context.createOscillator.bind(context);
    const originalGain = context.createGain.bind(context);
    context.createOscillator = () => {
      const osc = originalOsc();
      oscillators.push(osc);
      return osc;
    };
    context.createGain = () => {
      const gain = originalGain();
      gains.push(gain);
      return gain;
    };

    playImpact(bus, 0.5);
    playImpact(bus, 1);

    expect(oscillators.length).toBe(2);
    expect(oscillators[0]?.started).toBe(true);
    // 峰值应正比于强度(钳到 1):第二次(强度 1)比第一次(强度 0.5)响。
    const firstPeak = gains[0]?.gain.valueAtTimeCalls[0]?.value ?? 0;
    const secondPeak = gains[1]?.gain.valueAtTimeCalls[0]?.value ?? 0;
    expect(secondPeak).toBeGreaterThan(firstPeak);
  });
});

describe('playUiClick', () => {
  it('发出一次短促脉冲', () => {
    const { bus, context } = makeBus();
    let oscCreated = 0;
    const originalOsc = context.createOscillator.bind(context);
    context.createOscillator = () => {
      oscCreated++;
      return originalOsc();
    };
    playUiClick(bus);
    expect(oscCreated).toBe(1);
  });
});
