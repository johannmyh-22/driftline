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
  readonly Q = new FakeAudioParam();
}

/** `createPeriodicWave(real, imag)` 的返回值,单测只需要留住两条系数供断言。 */
class FakePeriodicWave {
  constructor(
    readonly real: Float32Array,
    readonly imag: Float32Array,
  ) {}
}

class FakeOscillatorNode extends FakeAudioNode {
  type = 'sine';
  readonly frequency = new FakeAudioParam();
  periodicWave: FakePeriodicWave | null = null;
  started = false;
  stopped = false;
  private endedHandler: (() => void) | null = null;

  setPeriodicWave(wave: FakePeriodicWave): void {
    this.periodicWave = wave;
    this.type = 'custom';
  }

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

  createPeriodicWave(real: Float32Array, imag: Float32Array): FakePeriodicWave {
    return new FakePeriodicWave(real, imag);
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
    const engine = new EngineSound(bus, new Rng(5));
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
    const engine = new EngineSound(bus, new Rng(5));
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
    const engine = new EngineSound(bus, new Rng(5));
    const osc = (engine as unknown as { osc: FakeOscillatorNode }).osc;

    engine.update(0.4, 0, bus.context);
    const coastFreq = osc.frequency.value;
    engine.update(0.4, 1, bus.context);
    const throttleFreq = osc.frequency.value;

    expect(throttleFreq).toBeGreaterThan(coastFreq);
  });

  it('高速滑行(松油门)音高比同速度地板油低——转速代理不是纯跟车速走', () => {
    const { bus } = makeBus();
    const engine = new EngineSound(bus, new Rng(5));
    const osc = (engine as unknown as { osc: FakeOscillatorNode }).osc;

    engine.update(1, 0, bus.context);
    const coastFreq = osc.frequency.value;
    engine.update(1, 1, bus.context);
    const fullFreq = osc.frequency.value;

    expect(coastFreq).toBeLessThan(fullFreq);
    expect(coastFreq).toBeGreaterThan(0);
  });

  /*
   * 下面三条守的是"人类听到颤音/干涉感"那次反馈的修法。根因是确诊过的:
   * 老实现叠了一个按 1.008 失谐的副振荡器,两个频率相近的音源必然拍频。
   * 现在只有一个振荡器,厚度靠谐波表 + 一层噪声,不靠失谐。
   */
  it('只有一个振荡器,而且用的是自定义谐波谱不是现成波形', () => {
    const { bus, context } = makeBus();
    let oscCount = 0;
    const originalOsc = context.createOscillator.bind(context);
    context.createOscillator = () => {
      oscCount++;
      return originalOsc();
    };
    const engine = new EngineSound(bus, new Rng(5));
    const osc = (engine as unknown as { osc: FakeOscillatorNode }).osc;

    // 两个频率相近的振荡器叠加 = 拍频 = 人类听到的颤音,所以只能有一个。
    expect(oscCount).toBe(1);
    expect(osc.type).toBe('custom');
    expect(osc.periodicWave).not.toBeNull();
  });

  it('谐波谱首项是直流 0,其余项按 engineHarmonics 严格整数倍排布', () => {
    const { bus } = makeBus();
    const engine = new EngineSound(bus, new Rng(5));
    const wave = (engine as unknown as { osc: FakeOscillatorNode }).osc.periodicWave;

    expect(wave).not.toBeNull();
    const imag = wave?.imag ?? new Float32Array();
    const real = wave?.real ?? new Float32Array();
    expect(imag.length).toBe(AUDIO.engineHarmonics.length + 1);
    expect(imag[0]).toBe(0);
    for (let i = 0; i < AUDIO.engineHarmonics.length; i++) {
      expect(imag[i + 1]).toBeCloseTo(AUDIO.engineHarmonics[i] ?? 0, 6);
    }
    // real 全零 = 纯正弦分量,不引入额外相位。
    expect(Array.from(real).every((v) => v === 0)).toBe(true);
  });

  it('转速音域至少跨两个半八度——人耳对音高是对数感知的', () => {
    // 老版本 62~210Hz 只有 1.76 个八度,人类反馈"转速范围听不出来"。
    const octaves = Math.log2(AUDIO.engineMaxFreq / AUDIO.engineIdleFreq);
    expect(octaves).toBeGreaterThanOrEqual(2.5);
  });

  it('排气粗糙度噪声层走带通,音量随转速代理涨但压在音调层之下', () => {
    const { bus } = makeBus();
    const engine = new EngineSound(bus, new Rng(5));
    const noiseFilter = (engine as unknown as { noiseFilter: FakeBiquadFilterNode }).noiseFilter;
    const noiseGain = (engine as unknown as { noiseGain: FakeGainNode }).noiseGain;
    const gain = (engine as unknown as { gain: FakeGainNode }).gain;

    expect(noiseFilter.type).toBe('bandpass');
    expect(noiseFilter.Q.value).toBeCloseTo(AUDIO.engineNoiseQ, 5);

    engine.update(0, 0, bus.context);
    const idleNoise = noiseGain.gain.value;
    const idleFilter = noiseFilter.frequency.value;

    engine.update(1, 1, bus.context);
    expect(noiseGain.gain.value).toBeGreaterThan(idleNoise);
    expect(noiseFilter.frequency.value).toBeGreaterThan(idleFilter);
    // 噪声只是质感,盖过音调就变成嘶嘶声了。
    expect(noiseGain.gain.value).toBeLessThan(gain.gain.value);
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

  /*
   * 撞击音这一组不按创建顺序取节点,而是顺着节点图走:先按滤波器类型认出
   * 「噪声碎裂层(highpass)」和「车身层(lowpass)」,再从各自的 connected[0]
   * 拿到对应的 gain。上一版测试硬编码了 gains[0]/gains[2] 的下标,两层的
   * 创建顺序一调整就会静默地断言错对象——那正是这一轮要改的东西。
   */
  function capturePlay(strength: number): {
    tone: { osc: FakeOscillatorNode; filter: FakeBiquadFilterNode; gain: FakeGainNode };
    noise: { src: FakeBufferSourceNode; filter: FakeBiquadFilterNode; gain: FakeGainNode };
  } {
    const { bus, context } = makeBus();
    const oscillators: FakeOscillatorNode[] = [];
    const sources: FakeBufferSourceNode[] = [];
    const filters: FakeBiquadFilterNode[] = [];
    const originalOsc = context.createOscillator.bind(context);
    const originalBuf = context.createBufferSource.bind(context);
    const originalFilter = context.createBiquadFilter.bind(context);

    const impact = new ImpactPlayer(bus, new Rng(1));
    context.createOscillator = () => {
      const osc = originalOsc();
      oscillators.push(osc);
      return osc;
    };
    context.createBufferSource = () => {
      const src = originalBuf();
      sources.push(src);
      return src;
    };
    context.createBiquadFilter = () => {
      const filter = originalFilter();
      filters.push(filter);
      return filter;
    };
    impact.play(strength);

    const toneFilter = filters.find((f) => f.type === 'lowpass');
    const noiseFilter = filters.find((f) => f.type === 'highpass');
    if (toneFilter === undefined || noiseFilter === undefined) {
      throw new Error('撞击音应该同时有一个低通(车身)和一个高通(碎裂)滤波器');
    }
    return {
      tone: {
        osc: oscillators[0] as FakeOscillatorNode,
        filter: toneFilter,
        gain: toneFilter.connected[0] as FakeGainNode,
      },
      noise: {
        src: sources[0] as FakeBufferSourceNode,
        filter: noiseFilter,
        gain: noiseFilter.connected[0] as FakeGainNode,
      },
    };
  }

  it('音高、亮度、时长、噪声音量四个维度都随强度缩放,不只是音量', () => {
    const weak = capturePlay(0.3);
    const hard = capturePlay(1);

    // 音高:下滑音的落点随强度抬高。
    const weakEnd = weak.tone.osc.frequency.rampCalls[0]?.value ?? 0;
    const hardEnd = hard.tone.osc.frequency.rampCalls[0]?.value ?? 0;
    expect(hardEnd).toBeGreaterThan(weakEnd);

    // 亮度:车身低通和噪声高通都随强度上移。
    expect(hard.tone.filter.frequency.value).toBeGreaterThan(weak.tone.filter.frequency.value);
    expect(hard.noise.filter.frequency.value).toBeGreaterThan(weak.noise.filter.frequency.value);

    // 音量:两层的峰值都随强度涨。
    expect(hard.tone.gain.gain.valueAtTimeCalls[0]?.value ?? 0).toBeGreaterThan(
      weak.tone.gain.gain.valueAtTimeCalls[0]?.value ?? 0,
    );
    expect(hard.noise.gain.gain.valueAtTimeCalls[0]?.value ?? 0).toBeGreaterThan(
      weak.noise.gain.gain.valueAtTimeCalls[0]?.value ?? 0,
    );

    // 时长:两层的衰减都随强度拖长。
    expect(hard.tone.gain.gain.rampCalls[0]?.time ?? 0).toBeGreaterThan(
      weak.tone.gain.gain.rampCalls[0]?.time ?? 0,
    );
    expect(hard.noise.gain.gain.rampCalls[0]?.time ?? 0).toBeGreaterThan(
      weak.noise.gain.gain.rampCalls[0]?.time ?? 0,
    );
  });

  /*
   * 下面四条守的是"太软/太闷/空心"那次反馈的修法,每一条都对应一个查出来的
   * 根因,不是听感偏好。
   */
  it('噪声"碎裂"层是主角:峰值比车身层高,衰减比车身层快', () => {
    const { tone, noise } = capturePlay(1);
    const tonePeak = tone.gain.gain.valueAtTimeCalls[0]?.value ?? 0;
    const noisePeak = noise.gain.gain.valueAtTimeCalls[0]?.value ?? 0;
    // 老版本这里是反的(0.5 vs 0.35),听感就是"一个闷响的球"。
    expect(noisePeak).toBeGreaterThan(tonePeak);

    const toneEnd = tone.gain.gain.rampCalls[0]?.time ?? 0;
    const noiseEnd = noise.gain.gain.rampCalls[0]?.time ?? 0;
    // 碎裂是瞬态,拖得比车身还长就变成嘶嘶声了。
    expect(noiseEnd).toBeLessThan(toneEnd);
  });

  it('噪声层走高通,不再和车身层共用一个低通', () => {
    const { noise, tone } = capturePlay(1);
    // 老版本噪声过的是和车身同一条低通(最高 2400Hz),crack 的高频全被砍掉。
    expect(noise.filter.type).toBe('highpass');
    expect(tone.filter.type).toBe('lowpass');
  });

  it('车身层是锯齿波不是方波——方波只有奇次谐波,那是"空心"的来源', () => {
    const { tone } = capturePlay(1);
    expect(tone.osc.type).toBe('sawtooth');
  });

  it('车身层有一段自高向低的快速下滑,而不是定频', () => {
    const { tone } = capturePlay(1);
    const startFreq = tone.osc.frequency.valueAtTimeCalls[0]?.value ?? 0;
    const ramp = tone.osc.frequency.rampCalls[0];
    expect(ramp).toBeDefined();
    expect(startFreq).toBeGreaterThan(ramp?.value ?? 0);
    expect(startFreq).toBeCloseTo((ramp?.value ?? 0) * AUDIO.impactTonePitchDrop, 5);
    // 下滑必须在包络结束前完成,否则听起来是科幻音效不是撞击。
    const toneEnd = tone.gain.gain.rampCalls[0]?.time ?? 0;
    expect(ramp?.time ?? 0).toBeLessThan(toneEnd);
  });

  it('音调落点整体高于老版本的 42~85Hz —— "太低沉"是量得出来的', () => {
    expect(AUDIO.impactToneFreqMin).toBeGreaterThan(42);
    expect(AUDIO.impactToneFreqMax).toBeGreaterThan(85);
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
