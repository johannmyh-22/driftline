import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { AudioBus } from '../../src/audio/context';
import { EngineSound } from '../../src/audio/engine';
import { ImpactPlayer } from '../../src/audio/impact';
import { ScrapeNoise } from '../../src/audio/scrape';
import { TireSqueal } from '../../src/audio/skid';
import { SurfaceNoise } from '../../src/audio/surface';
import { createNoiseBuffer } from '../../src/audio/noise';
import { playUiClick } from '../../src/audio/ui';
import { WindNoise } from '../../src/audio/wind';
import { AUDIO, GEARBOX, REFERENCE_TOP_SPEED } from '../../src/game/tuning';
import { normalize01 } from '../../src/core/mathx';

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

    engine.update(0, 0, 0, bus.context);
    const idleFreq = osc.frequency.value;
    const idleGain = gain.gain.value;

    engine.update(1, 0, 1, bus.context);
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

    engine.update(0.6, 0, 0, bus.context);
    const coastGain = gain.gain.value;
    engine.update(0.6, 0, 1, bus.context);
    const fullGain = gain.gain.value;

    expect(coastGain).toBeGreaterThan(0);
    expect(coastGain).toBeLessThan(fullGain);
  });

  it('同速度下深踩油门音高也会跟着涨,不再只是音量变化', () => {
    const { bus } = makeBus();
    const engine = new EngineSound(bus, new Rng(5));
    const osc = (engine as unknown as { osc: FakeOscillatorNode }).osc;

    engine.update(0.4, 0, 0, bus.context);
    const coastFreq = osc.frequency.value;
    engine.update(0.4, 0, 1, bus.context);
    const throttleFreq = osc.frequency.value;

    expect(throttleFreq).toBeGreaterThan(coastFreq);
  });

  it('高速滑行(松油门)音高比同速度地板油低——转速代理不是纯跟车速走', () => {
    const { bus } = makeBus();
    const engine = new EngineSound(bus, new Rng(5));
    const osc = (engine as unknown as { osc: FakeOscillatorNode }).osc;

    engine.update(1, 0, 0, bus.context);
    const coastFreq = osc.frequency.value;
    engine.update(1, 0, 1, bus.context);
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

    engine.update(0, 0, 0, bus.context);
    const idleNoise = noiseGain.gain.value;
    const idleFilter = noiseFilter.frequency.value;

    engine.update(1, 0, 1, bus.context);
    expect(noiseGain.gain.value).toBeGreaterThan(idleNoise);
    expect(noiseFilter.frequency.value).toBeGreaterThan(idleFilter);
    // 噪声只是质感,盖过音调就变成嘶嘶声了。
    expect(noiseGain.gain.value).toBeLessThan(gain.gain.value);
  });

  /*
   * ── 变速箱 ──────────────────────────────────────────────────────────────
   *
   * 这一组原来测的是**音频自己那套假变速箱**(读归一化车速算挡位)。那套
   * 已经删了 —— 实测它 86% 的时间卡在六挡不动,因为 `speed01` 在 217 km/h
   * 以上就饱和了,而车能跑到 248。现在挡位和转速都由物理变速箱给,音频只
   * 负责跟随,所以这组改成测「跟随得对不对」。
   */
  it('升挡那一瞬音量被断油压低,过了断油窗口再恢复', () => {
    const { bus, context } = makeBus();
    const engine = new EngineSound(bus, new Rng(5));
    const gain = (engine as unknown as { gain: FakeGainNode }).gain;

    // 先喂一帧建立 lastGear,否则第一帧无从判断"换挡了"。
    engine.update(0.9, 0, 1, bus.context);
    const before = gain.gain.value;
    // 转速不变、只换挡:音量差别只可能来自断油。
    engine.update(0.9, 1, 1, bus.context);
    const during = gain.gain.value;
    expect(during).toBeLessThan(before);

    context.currentTime += AUDIO.engineShiftCutTime + 0.01;
    engine.update(0.9, 1, 1, bus.context);
    expect(gain.gain.value).toBeGreaterThan(during);
  });

  it('第一帧不断油 —— 刚进游戏不该无端塌一下音量', () => {
    const { bus } = makeBus();
    const engine = new EngineSound(bus, new Rng(5));
    const gain = (engine as unknown as { gain: FakeGainNode }).gain;

    engine.update(0.9, 3, 1, bus.context);
    const first = gain.gain.value;
    engine.update(0.9, 3, 1, bus.context);
    expect(gain.gain.value).toBeCloseTo(first, 9);
  });

  it('降挡不断油 —— 真车降挡是补油,断一下听起来像卡顿', () => {
    const { bus } = makeBus();
    const engine = new EngineSound(bus, new Rng(5));
    const gain = (engine as unknown as { gain: FakeGainNode }).gain;

    engine.update(0.5, 3, 1, bus.context);
    const before = gain.gain.value;
    engine.update(0.5, 2, 1, bus.context);
    expect(gain.gain.value).toBeCloseTo(before, 9);
  });

  it('音高跟着转速走 —— 锯齿由物理给,音频只负责跟随', () => {
    const { bus } = makeBus();
    const engine = new EngineSound(bus, new Rng(5));
    const osc = (engine as unknown as { osc: FakeOscillatorNode }).osc;

    // 挡内爬升 → 升挡后转速掉下来 → 再爬。这条锯齿现在来自 gearbox.ts。
    engine.update(0.5, 2, 1, bus.context);
    const low = osc.frequency.value;
    engine.update(0.95, 2, 1, bus.context);
    const redline = osc.frequency.value;
    engine.update(0.36, 3, 1, bus.context);
    const afterShift = osc.frequency.value;

    expect(redline).toBeGreaterThan(low);
    expect(afterShift).toBeLessThan(redline);
  });

  /*
   * ↓ 这条是**回归守卫**,守的是人类反馈「听不出转速变化」那个 bug 本身。
   *
   * 老代码把 `speed01 = groundSpeed / REFERENCE_TOP_SPEED` 当转速代理,而
   * `REFERENCE_TOP_SPEED` 只是**参考**极速:`vehicle.ts` 的轮速上限是它的
   * 1.15 倍,车真能跑到 68.9 m/s。于是超过 60.3 之后 speed01 恒等于 1,
   * 音调、挡位、换挡声全部冻住 —— 实测常规驾驶车速中位数就是 65.9 m/s,
   * 一大半时间都在饱和区里。
   *
   * 现在的输入是物理转速,同样这段车速区间里它是**在动的**。
   */
  it('车速饱和的那一段里,转速仍然在动(这正是老代码的 bug)', () => {
    const saturated = [60.3, 63, 65.9, 68.9];
    const speed01 = saturated.map((v) => normalize01(v, 0, REFERENCE_TOP_SPEED));
    // 老的输入:整段都是 1,一点变化都没有。
    expect(new Set(speed01)).toEqual(new Set([1]));

    // 新的输入:同一段车速对应的转速跨越怠速到红线之间的一大片。实测常规
    // 驾驶 rpm 在 4400~6950 之间来回走。
    const rpm01 = [4404, 5600, 6521, 6952].map((r) =>
      normalize01(r, GEARBOX.idleRpm, GEARBOX.redlineRpm),
    );
    const spread = Math.max(...rpm01) - Math.min(...rpm01);
    expect(spread).toBeGreaterThan(0.35);

    // 落到频率上要跨过一个八度以上才算"听得出转速"。
    const { bus } = makeBus();
    const engine = new EngineSound(bus, new Rng(5));
    const osc = (engine as unknown as { osc: FakeOscillatorNode }).osc;
    engine.update(Math.min(...rpm01), 4, 1, bus.context);
    const lowFreq = osc.frequency.value;
    engine.update(Math.max(...rpm01), 4, 1, bus.context);
    expect(osc.frequency.value / lowFreq).toBeGreaterThan(1.15);
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
    // 强度现在按法向速度归一化,不再直接吃 wallImpact 那个混合标量。
    impact.play(AUDIO.impactRefNormalSpeed * (AUDIO.impactMinStrength - 0.01), 0);
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
    impact.play(AUDIO.impactRefNormalSpeed * 0.8, 0);

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
  function capturePlay(normalSpeed: number, tangentSpeed = 0): {
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
    impact.play(normalSpeed, tangentSpeed);

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
    const weak = capturePlay(AUDIO.impactRefNormalSpeed * 0.3);
    const hard = capturePlay(AUDIO.impactRefNormalSpeed);

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
    const { tone, noise } = capturePlay(AUDIO.impactRefNormalSpeed);
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
    const { noise, tone } = capturePlay(AUDIO.impactRefNormalSpeed);
    // 老版本噪声过的是和车身同一条低通(最高 2400Hz),crack 的高频全被砍掉。
    expect(noise.filter.type).toBe('highpass');
    expect(tone.filter.type).toBe('lowpass');
  });

  it('车身层是锯齿波不是方波——方波只有奇次谐波,那是"空心"的来源', () => {
    const { tone } = capturePlay(AUDIO.impactRefNormalSpeed);
    expect(tone.osc.type).toBe('sawtooth');
  });

  it('车身层有一段自高向低的快速下滑,而不是定频', () => {
    const { tone } = capturePlay(AUDIO.impactRefNormalSpeed);
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

  /*
   * 下面这组守的是"碰撞是分为好几种的"那次反馈的修法:**同样的法向速度**下,
   * 擦过去和正面撞进去必须是两种声音,而不是一种声音调音量。
   */
  it('同样法向速度,擦过去和正面撞的音色性格不同', () => {
    const n = AUDIO.impactRefNormalSpeed * 0.8;
    const headOn = capturePlay(n, 0);
    const graze = capturePlay(n, n * 6);

    // 擦过:车身"肉"少得多。
    const headOnBody = headOn.tone.gain.gain.valueAtTimeCalls[0]?.value ?? 0;
    const grazeBody = graze.tone.gain.gain.valueAtTimeCalls[0]?.value ?? 0;
    expect(grazeBody).toBeLessThan(headOnBody);

    // 擦过:更高更薄。
    const headOnPitch = headOn.tone.osc.frequency.rampCalls[0]?.value ?? 0;
    const grazePitch = graze.tone.osc.frequency.rampCalls[0]?.value ?? 0;
    expect(grazePitch).toBeGreaterThan(headOnPitch);

    // 擦过:更亮更尖。
    expect(graze.noise.filter.frequency.value).toBeGreaterThan(
      headOn.noise.filter.frequency.value,
    );

    // 擦过:更短促,没有余振。
    const headOnEnd = headOn.tone.gain.gain.rampCalls[0]?.time ?? 0;
    const grazeEnd = graze.tone.gain.gain.rampCalls[0]?.time ?? 0;
    expect(grazeEnd).toBeLessThan(headOnEnd);
  });

  it('强度只由法向速度决定,切向速度再大也不会把轻擦放成重撞', () => {
    const { bus, context } = makeBus();
    let calls = 0;
    const before = context.createOscillator.bind(context);
    context.createOscillator = () => {
      calls++;
      return before();
    };
    const impact = new ImpactPlayer(bus, new Rng(1));
    // 法向在阈值以下:哪怕以 80 m/s 贴着墙飞过去也不该触发撞击事件
    // ——那是刮擦(ScrapeNoise)的活,不是撞击的。
    impact.play(AUDIO.impactRefNormalSpeed * (AUDIO.impactMinStrength - 0.01), 80);
    expect(calls).toBe(0);
  });

  /*
   * 下面两条守的是"贴墙磨会连成机关枪"这个问题。实测 90% 的撞墙接触帧法向
   * 速度不到 0.16 m/s(见 tuning.ts 里那段标定注释),阈值之上的抖动仍然会
   * 每几帧触发一次,必须再加一道冷却。
   */
  it('冷却窗口内的重复轻碰不会连发', () => {
    const { bus, context } = makeBus();
    let calls = 0;
    const before = context.createOscillator.bind(context);
    context.createOscillator = () => {
      calls++;
      return before();
    };
    const impact = new ImpactPlayer(bus, new Rng(1));
    const hit = AUDIO.impactRefNormalSpeed * 0.3;
    // 8 次轻碰全部落在同一个冷却窗口内(累计推进 0.8 个窗口)。
    for (let i = 0; i < 8; i++) {
      impact.play(hit, 0);
      context.currentTime += AUDIO.impactRetriggerTime / 10;
    }
    expect(calls).toBe(1);
  });

  it('冷却窗口内明显更重的撞击仍然放得出来,不会被前一下轻碰吃掉', () => {
    const { bus, context } = makeBus();
    let calls = 0;
    const before = context.createOscillator.bind(context);
    context.createOscillator = () => {
      calls++;
      return before();
    };
    const impact = new ImpactPlayer(bus, new Rng(1));
    impact.play(AUDIO.impactRefNormalSpeed * 0.2, 0);
    expect(calls).toBe(1);
    // 同一窗口内,强度远超上一次(> impactRetriggerRatio 倍)。
    impact.play(AUDIO.impactRefNormalSpeed * 1.0, 0);
    expect(calls).toBe(2);
  });

  it('冷却过后可以再次触发', () => {
    const { bus, context } = makeBus();
    let calls = 0;
    const before = context.createOscillator.bind(context);
    context.createOscillator = () => {
      calls++;
      return before();
    };
    const impact = new ImpactPlayer(bus, new Rng(1));
    const hit = AUDIO.impactRefNormalSpeed * 0.3;
    impact.play(hit, 0);
    context.currentTime += AUDIO.impactRetriggerTime * 1.5;
    impact.play(hit, 0);
    expect(calls).toBe(2);
  });

  it('强度标定挡得住磨墙那堆接触帧(实测 p90 = 0.16 m/s)', () => {
    const gate = AUDIO.impactMinStrength * AUDIO.impactRefNormalSpeed;
    expect(gate).toBeGreaterThan(0.16);
    // 但又不能高到把真实撞击(实测 p99 ≈ 3 m/s)也挡掉。
    expect(gate).toBeLessThan(1);
  });

  it('撞击的峰值音量盖得过引擎与气流,否则撞了跟没撞一样', () => {
    expect(AUDIO.impactNoiseGain).toBeGreaterThan(AUDIO.engineMaxGain);
    expect(AUDIO.impactNoiseGain).toBeGreaterThan(AUDIO.windMaxGain);
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

describe('ScrapeNoise', () => {
  it('切向速度越大,音量与带通中心频率越高;没接触时静音', () => {
    const { bus } = makeBus();
    const scrape = new ScrapeNoise(bus, new Rng(4));
    const gain = (scrape as unknown as { gain: FakeGainNode }).gain;
    const filter = (scrape as unknown as { filter: FakeBiquadFilterNode }).filter;

    scrape.update(0, bus.context);
    expect(gain.gain.value).toBeCloseTo(0, 5);
    const idleFilter = filter.frequency.value;

    scrape.update(AUDIO.scrapeRefSpeed, bus.context);
    expect(gain.gain.value).toBeCloseTo(AUDIO.scrapeMaxGain, 5);
    expect(filter.frequency.value).toBeGreaterThan(idleFilter);

    // 离开墙面立刻回到静音——刮擦是状态不是余响。
    scrape.update(0, bus.context);
    expect(gain.gain.value).toBeCloseTo(0, 5);
  });

  it('用高 Q 带通,和气流那层宽频低通区分开', () => {
    const { bus } = makeBus();
    const scrape = new ScrapeNoise(bus, new Rng(4));
    const filter = (scrape as unknown as { filter: FakeBiquadFilterNode }).filter;
    expect(filter.type).toBe('bandpass');
    expect(filter.Q.value).toBeCloseTo(AUDIO.scrapeQ, 5);
    // 两层噪声要是同一个音色会糊成一片,刮擦必须比气流更快跟随接触通断。
    expect(AUDIO.scrapeSmoothing).toBeLessThan(AUDIO.windSmoothing);
  });
});

describe('TireSqueal(甩尾)', () => {
  function gainOf(squeal: TireSqueal): FakeGainNode {
    return (squeal as unknown as { gain: FakeGainNode }).gain;
  }

  /*
   * 这一组守的是「甩尾一直是静音的」那个洞。核心是**两个条件必须同时满足**:
   * 只看饱和度,低速原地打死方向也会满饱和;只看侧滑速度,高速正常过弯的
   * 横向分量会一路误触发。
   */
  it('抓地饱和但没真的滑出速度 —— 不叫', () => {
    const { bus } = makeBus();
    const squeal = new TireSqueal(bus, new Rng(2));
    squeal.update(1, 0, bus.context);
    expect(gainOf(squeal).gain.value).toBeCloseTo(0, 6);
    squeal.dispose();
  });

  it('滑得很快但抓地没饱和 —— 也不叫', () => {
    const { bus } = makeBus();
    const squeal = new TireSqueal(bus, new Rng(2));
    squeal.update(AUDIO.skidMinSaturation - 0.01, AUDIO.skidRefSlip, bus.context);
    expect(gainOf(squeal).gain.value).toBeCloseTo(0, 6);
    squeal.dispose();
  });

  it('两个条件同时满足才叫,而且滑得越狠越响', () => {
    const { bus } = makeBus();
    const squeal = new TireSqueal(bus, new Rng(2));

    squeal.update(1, AUDIO.skidRefSlip * 0.4, bus.context);
    const mild = gainOf(squeal).gain.value;
    expect(mild).toBeGreaterThan(0);

    squeal.update(1, AUDIO.skidRefSlip, bus.context);
    const hard = gainOf(squeal).gain.value;
    expect(hard).toBeGreaterThan(mild);
    expect(hard).toBeCloseTo(AUDIO.skidMaxGain, 5);
    squeal.dispose();
  });

  it('侧滑方向不影响音量 —— 往左甩和往右甩一样响', () => {
    const { bus } = makeBus();
    const squeal = new TireSqueal(bus, new Rng(2));
    squeal.update(1, AUDIO.skidRefSlip * 0.6, bus.context);
    const right = gainOf(squeal).gain.value;
    squeal.update(1, -AUDIO.skidRefSlip * 0.6, bus.context);
    expect(gainOf(squeal).gain.value).toBeCloseTo(right, 6);
    squeal.dispose();
  });

  it('滑得越快叫得越尖,而且用的是比刮擦更窄的高 Q 带通', () => {
    const { bus } = makeBus();
    const squeal = new TireSqueal(bus, new Rng(2));
    const filter = (squeal as unknown as { filter: FakeBiquadFilterNode }).filter;
    expect(filter.type).toBe('bandpass');
    expect(filter.Q.value).toBeGreaterThan(AUDIO.scrapeQ);

    squeal.update(1, 0, bus.context);
    const low = filter.frequency.value;
    squeal.update(1, AUDIO.skidRefSlip, bus.context);
    expect(filter.frequency.value).toBeGreaterThan(low);
    squeal.dispose();
  });
});

describe('SurfaceNoise(出界)', () => {
  it('在赛道上静音,出界之后随速度出声', () => {
    const { bus } = makeBus();
    const surface = new SurfaceNoise(bus, new Rng(6));
    const gain = (surface as unknown as { gain: FakeGainNode }).gain;

    surface.update(false, 1, bus.context);
    expect(gain.gain.value).toBeCloseTo(0, 6);

    surface.update(true, 1, bus.context);
    expect(gain.gain.value).toBeCloseTo(AUDIO.surfaceMaxGain, 5);

    // 出界但停着不动也不该响。
    surface.update(true, 0, bus.context);
    expect(gain.gain.value).toBeCloseTo(0, 6);
    surface.dispose();
  });

  it('走低通,而且截止频率远低于气流 —— 出界要「变粗糙」不是「变吵」', () => {
    const { bus } = makeBus();
    const surface = new SurfaceNoise(bus, new Rng(6));
    const filter = (surface as unknown as { filter: FakeBiquadFilterNode }).filter;
    expect(filter.type).toBe('lowpass');
    expect(AUDIO.surfaceFilterFreq).toBeLessThan(AUDIO.windFilterMaxFreq);
    surface.dispose();
  });
});

describe('ImpactPlayer.playLanding(落地)', () => {
  it('轻微起伏不出声', () => {
    const { bus, context } = makeBus();
    let calls = 0;
    const before = context.createOscillator.bind(context);
    context.createOscillator = () => {
      calls++;
      return before();
    };
    const impact = new ImpactPlayer(bus, new Rng(1));
    impact.playLanding(AUDIO.landingMinSpeed - 0.01);
    expect(calls).toBe(0);
  });

  it('砸得越重音量越大、音调越高', () => {
    const capture = (descent: number): { gain: number; freq: number } => {
      const { bus, context } = makeBus();
      const gains: FakeGainNode[] = [];
      const oscs: FakeOscillatorNode[] = [];
      const og = context.createGain.bind(context);
      const oo = context.createOscillator.bind(context);
      const impact = new ImpactPlayer(bus, new Rng(1));
      context.createGain = () => {
        const g = og();
        gains.push(g);
        return g;
      };
      context.createOscillator = () => {
        const o = oo();
        oscs.push(o);
        return o;
      };
      impact.playLanding(descent);
      return {
        gain: gains[0]?.gain.valueAtTimeCalls[0]?.value ?? 0,
        freq: oscs[0]?.frequency.rampCalls[0]?.value ?? 0,
      };
    };
    const soft = capture(AUDIO.landingRefSpeed * 0.4);
    const hard = capture(AUDIO.landingRefSpeed);
    expect(hard.gain).toBeGreaterThan(soft.gain);
    expect(hard.freq).toBeGreaterThan(soft.freq);
  });

  it('落地是闷的:噪声走低通,不是撞墙那种高通 crack', () => {
    const { bus, context } = makeBus();
    const filters: FakeBiquadFilterNode[] = [];
    const of = context.createBiquadFilter.bind(context);
    const impact = new ImpactPlayer(bus, new Rng(1));
    context.createBiquadFilter = () => {
      const f = of();
      filters.push(f);
      return f;
    };
    impact.playLanding(AUDIO.landingRefSpeed);
    expect(filters.every((f) => f.type === 'lowpass')).toBe(true);
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
