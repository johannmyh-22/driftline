import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { AudioBus } from '../../src/audio/context';
import { EngineSound } from '../../src/audio/engine';
import { ImpactPlayer } from '../../src/audio/impact';
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

  it('同速度下深踩油门音高也会跟着涨,不再只是音量变化', () => {
    const { bus } = makeBus();
    const engine = new EngineSound(bus);
    const osc = (engine as unknown as { osc: FakeOscillatorNode }).osc;

    engine.update(0.4, 0, bus.context);
    const coastFreq = osc.frequency.value;
    engine.update(0.4, 1, bus.context);
    const throttleFreq = osc.frequency.value;

    expect(throttleFreq).toBeGreaterThan(coastFreq);
  });

  it('高速滑行(松油门)音高比同速度地板油低——转速代理不是纯跟车速走', () => {
    const { bus } = makeBus();
    const engine = new EngineSound(bus);
    const osc = (engine as unknown as { osc: FakeOscillatorNode }).osc;

    engine.update(1, 0, bus.context);
    const coastFreq = osc.frequency.value;
    engine.update(1, 1, bus.context);
    const fullFreq = osc.frequency.value;

    expect(coastFreq).toBeLessThan(fullFreq);
    expect(coastFreq).toBeGreaterThan(0);
  });

  it('第二个失谐振荡器跟着主振荡器的频率走,但按 engineDetuneRatio 略微偏高', () => {
    const { bus } = makeBus();
    const engine = new EngineSound(bus);
    const osc = (engine as unknown as { osc: FakeOscillatorNode }).osc;
    const oscDetune = (engine as unknown as { oscDetune: FakeOscillatorNode }).oscDetune;
    const detuneGain = (engine as unknown as { detuneGain: FakeGainNode }).detuneGain;

    engine.update(0.7, 0.5, bus.context);

    expect(oscDetune.frequency.value).toBeCloseTo(osc.frequency.value * AUDIO.engineDetuneRatio, 5);
    expect(detuneGain.gain.value).toBeCloseTo(AUDIO.engineDetuneMix, 5);
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

describe('ImpactPlayer', () => {
  it('强度低于阈值不发声', () => {
    const { bus, context } = makeBus();
    const before = context.createOscillator.bind(context);
    let calls = 0;
    context.createOscillator = () => {
      calls++;
      return before();
    };
    const impact = new ImpactPlayer(bus, new Rng(1));
    impact.play(AUDIO.impactMinStrength - 0.01);
    expect(calls).toBe(0);
  });

  it('强度高于阈值时同时播放音调和噪声两个分量', () => {
    const { bus, context } = makeBus();
    const oscillators: FakeOscillatorNode[] = [];
    const buffers: FakeBufferSourceNode[] = [];
    const originalOsc = context.createOscillator.bind(context);
    const originalBuf = context.createBufferSource.bind(context);
    context.createOscillator = () => {
      const osc = originalOsc();
      oscillators.push(osc);
      return osc;
    };
    context.createBufferSource = () => {
      const src = originalBuf();
      buffers.push(src);
      return src;
    };

    const impact = new ImpactPlayer(bus, new Rng(1));
    impact.play(0.8);

    expect(oscillators.length).toBe(1);
    expect(oscillators[0]?.started).toBe(true);
    expect(buffers.length).toBe(1);
    expect(buffers[0]?.started).toBe(true);
  });

  it('音高、滤波亮度、时长、噪声音量四个维度都随强度缩放,不只是音量', () => {
    const { bus, context } = makeBus();
    const oscillators: FakeOscillatorNode[] = [];
    const toneFilters: FakeBiquadFilterNode[] = [];
    const gains: FakeGainNode[] = [];
    const originalOsc = context.createOscillator.bind(context);
    const originalFilter = context.createBiquadFilter.bind(context);
    const originalGain = context.createGain.bind(context);
    context.createOscillator = () => {
      const osc = originalOsc();
      oscillators.push(osc);
      return osc;
    };
    context.createBiquadFilter = () => {
      const filter = originalFilter();
      toneFilters.push(filter);
      return filter;
    };
    context.createGain = () => {
      const gain = originalGain();
      gains.push(gain);
      return gain;
    };

    const impact = new ImpactPlayer(bus, new Rng(1));
    impact.play(0.3);
    impact.play(1);

    // 每次 play() 建 2 个振荡器等价物(方波 osc)？不——只有 1 个 osc,但有 2 个
    // filter(音调+噪声各一个)和 2 个 gain(音调+噪声各一个)。按调用顺序切片。
    const [lowFreq, highFreq] = [oscillators[0]?.frequency.value, oscillators[1]?.frequency.value];
    expect(highFreq).toBeGreaterThan(lowFreq ?? 0);

    const [lowBrightness, highBrightness] = [
      toneFilters[0]?.frequency.value,
      toneFilters[2]?.frequency.value,
    ];
    expect(highBrightness).toBeGreaterThan(lowBrightness ?? 0);

    // gains 数组顺序: [toneGain(强度0.3), noiseGain(强度0.3), toneGain(强度1), noiseGain(强度1)]
    const lowTonePeak = gains[0]?.gain.valueAtTimeCalls[0]?.value ?? 0;
    const highTonePeak = gains[2]?.gain.valueAtTimeCalls[0]?.value ?? 0;
    expect(highTonePeak).toBeGreaterThan(lowTonePeak);
    const lowNoisePeak = gains[1]?.gain.valueAtTimeCalls[0]?.value ?? 0;
    const highNoisePeak = gains[3]?.gain.valueAtTimeCalls[0]?.value ?? 0;
    expect(highNoisePeak).toBeGreaterThan(lowNoisePeak);

    // 衰减时长(ramp 的目标时间)也随强度变长。
    const lowDurationEnd = gains[0]?.gain.rampCalls[0]?.time ?? 0;
    const highDurationEnd = gains[2]?.gain.rampCalls[0]?.time ?? 0;
    expect(highDurationEnd).toBeGreaterThan(lowDurationEnd);
  });

  it('同一个 seed 构造出的噪声缓冲是确定性的', () => {
    const { bus: busA } = makeBus();
    const { bus: busB } = makeBus();
    const a = new ImpactPlayer(busA, new Rng(9));
    const b = new ImpactPlayer(busB, new Rng(9));
    const bufferA = (a as unknown as { noiseBuffer: FakeAudioBuffer }).noiseBuffer;
    const bufferB = (b as unknown as { noiseBuffer: FakeAudioBuffer }).noiseBuffer;
    expect(Array.from(bufferA.getChannelData(0))).toEqual(Array.from(bufferB.getChannelData(0)));
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
