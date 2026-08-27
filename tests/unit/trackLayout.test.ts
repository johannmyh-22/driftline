import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import {
  type TrackLayout,
  alignStartAwayFromSun,
  generateTrack,
} from '../../src/game/trackLayout';
import { TRACK } from '../../src/game/tuning';

describe('generateTrack', () => {
  it('连续 10 个 seed 都生成出合格赛道', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const layout = generateTrack(new Rng(seed));
      expect(layout.validation.ok).toBe(true);
      expect(layout.validation.problems).toEqual([]);
      expect(layout.attempts).toBeLessThanOrEqual(TRACK.maxAttempts);
    }
  });

  it('赛道长度落在能跑的范围里', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const layout = generateTrack(new Rng(seed));
      // 太短一圈几秒就跑完,太长会让首圈变成苦役。
      expect(layout.totalLength).toBeGreaterThan(1500);
      expect(layout.totalLength).toBeLessThan(6000);
    }
  });

  it('采样点沿弧长等距', () => {
    const layout = generateTrack(new Rng(3));
    const { samples, spacing } = layout;

    for (let i = 0; i < samples.length; i++) {
      const a = samples[i];
      const b = samples[(i + 1) % samples.length];
      if (a === undefined || b === undefined) {
        throw new Error('采样点缺失');
      }
      const step = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      expect(step).toBeGreaterThan(spacing * 0.9);
      expect(step).toBeLessThan(spacing * 1.1);
    }
  });

  it('切线是单位向量', () => {
    const layout = generateTrack(new Rng(4));
    for (const sample of layout.samples) {
      expect(Math.hypot(sample.tangentX, sample.tangentZ)).toBeCloseTo(1, 6);
    }
  });

  it('侧倾不超过上限', () => {
    for (let seed = 1; seed <= 6; seed++) {
      for (const sample of generateTrack(new Rng(seed)).samples) {
        expect(Math.abs(sample.bank)).toBeLessThanOrEqual(TRACK.maxBank + 1e-9);
      }
    }
  });

  it('侧倾沿赛道是渐变的 —— 突变会把车弹起来', () => {
    const layout = generateTrack(new Rng(5));
    const { samples } = layout;

    let maxJump = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = samples[i];
      const b = samples[(i + 1) % samples.length];
      if (a === undefined || b === undefined) {
        continue;
      }
      maxJump = Math.max(maxJump, Math.abs(b.bank - a.bank));
    }
    // 阈值不是拍脑袋:limitBankRate 保证了每米变化不超过 maxBankRatePerMeter,
    // 所以相邻两点之间的上界就是它乘以间距。
    expect(maxJump).toBeLessThanOrEqual(TRACK.maxBankRatePerMeter * layout.spacing + 1e-9);
  });

  it('侧倾变化率换算到极速仍在姿态贴合能跟上的范围内', () => {
    // 这条守的是「压过弯道不会被弹起来」。载具 attitudeAlign 是 9/秒,
    // 侧倾变化率必须明显低于它,否则车追不上路面姿态。
    const maxDegreesPerSecond = (TRACK.maxBankRatePerMeter * 180 / Math.PI) * 88;
    expect(maxDegreesPerSecond).toBeLessThan(20);
  });

  it('侧倾方向朝弯心:左转时右侧更高', () => {
    // 逐点严格比对会误报:平滑和变化率限制让侧倾滞后于瞬时曲率,S 弯拐点附近
    // 两者符号本来就该短暂不一致(实测 6 个 seed 里最差 8/282 个点)。
    // 所以这里断言的是整体一致率,外加「最急的那个弯必须对」——
    // 那个点毫无歧义,符号要是反了它一定第一个暴露。
    for (let seed = 1; seed <= 6; seed++) {
      const { samples } = generateTrack(new Rng(seed));
      const count = samples.length;

      const crossAt = (i: number): number => {
        const prev = samples[(i - 1 + count) % count];
        const current = samples[i];
        const next = samples[(i + 1) % count];
        if (prev === undefined || current === undefined || next === undefined) {
          return 0;
        }
        return (
          (current.z - prev.z) * (next.x - current.x) -
          (current.x - prev.x) * (next.z - current.z)
        );
      };

      let agree = 0;
      let total = 0;
      let tightestIndex = 0;
      let tightestCross = 0;

      for (let i = 0; i < count; i++) {
        const cross = crossAt(i);
        if (Math.abs(cross) > Math.abs(tightestCross)) {
          tightestCross = cross;
          tightestIndex = i;
        }

        const current = samples[i];
        if (current === undefined || Math.abs(current.bank) < 0.08) {
          continue;
        }
        total++;
        if (Math.sign(current.bank) === Math.sign(cross)) {
          agree++;
        }
      }

      expect(total).toBeGreaterThan(100);
      expect(agree / total).toBeGreaterThan(0.95);
      expect(Math.sign(samples[tightestIndex]?.bank ?? 0)).toBe(Math.sign(tightestCross));
    }
  });

  it('弯越急侧倾越大', () => {
    const tight = generateTrack(new Rng(6));
    const loose = generateTrack(new Rng(8));
    const peak = (layout: ReturnType<typeof generateTrack>): number =>
      Math.max(...layout.samples.map((s) => Math.abs(s.bank)));

    expect(tight.validation.minCurvatureRadius).toBeLessThan(
      loose.validation.minCurvatureRadius,
    );
    expect(peak(tight)).toBeGreaterThan(peak(loose));
  });

  it('同 seed 完全一致', () => {
    expect(generateTrack(new Rng(42))).toEqual(generateTrack(new Rng(42)));
  });

  it('不同 seed 给出不同赛道', () => {
    const a = generateTrack(new Rng(42));
    const b = generateTrack(new Rng(43));
    expect(b.samples).not.toEqual(a.samples);
  });
});

describe('alignStartAwayFromSun', () => {
  /** 车头朝向和太阳方位角的夹角(度)。0 = 正对太阳。 */
  const sunAngleAtStart = (layout: TrackLayout, sunX: number, sunZ: number): number => {
    const start = layout.samples[0];
    if (start === undefined) {
      throw new Error('赛道没有采样点');
    }
    const horizontal = Math.hypot(sunX, sunZ);
    const dot = (start.tangentX * sunX + start.tangentZ * sunZ) / horizontal;
    return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
  };

  /*
   * 断言的是**夹角**,不是「选中了第几号采样」。
   *
   * 第五节那条教训:断言内部约定(下标、符号)会和 bug 共用同一个错误前提。
   * 「车头和太阳差多少度」是画面上真实看得见的量,选点策略怎么改都不该动它。
   */
  it('起点车头与太阳的夹角不小于避让半角', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const base = generateTrack(new Rng(seed));
      // 绕一圈扫方位角:总有几个角度会让原来的 0 号点变成逆光。
      for (let azimuth = 0; azimuth < 360; azimuth += 30) {
        const radians = (azimuth * Math.PI) / 180;
        const sunX = Math.sin(radians);
        const sunZ = Math.cos(radians);
        const aligned = alignStartAwayFromSun(base, sunX, sunZ);
        expect(sunAngleAtStart(aligned, sunX, sunZ)).toBeGreaterThanOrEqual(
          TRACK.startSunAvoidance - 1e-6,
        );
      }
    }
  });

  it('原来的起点已经合格时原样返回', () => {
    // 合格有两条:不逆光、而且在平地上。太阳可以摆到车尾后面把第一条满足掉,
    // 但坡度是赛道自己的形状,只能挑一个 0 号点本来就够平的 seed。
    let base = generateTrack(new Rng(5));
    for (let seed = 1; seed <= 40; seed++) {
      const candidate = generateTrack(new Rng(seed));
      const prev = candidate.samples[candidate.samples.length - 1]!;
      const next = candidate.samples[1]!;
      const run = Math.hypot(next.x - prev.x, next.z - prev.z);
      if (run > 1e-6 && Math.abs(next.y - prev.y) / run <= TRACK.startMaxGrade) {
        base = candidate;
        break;
      }
    }

    const start = base.samples[0];
    if (start === undefined) {
      throw new Error('赛道没有采样点');
    }
    // 太阳放在车尾正后方,怎么算都不可能逆光。
    const aligned = alignStartAwayFromSun(base, -start.tangentX, -start.tangentZ);
    expect(aligned).toBe(base);
  });

  it('换起点不改赛道几何,只换了标号', () => {
    const base = generateTrack(new Rng(7));
    const start = base.samples[0];
    if (start === undefined) {
      throw new Error('赛道没有采样点');
    }
    // 太阳正对车头,一定会触发换点。
    const aligned = alignStartAwayFromSun(base, start.tangentX, start.tangentZ);
    expect(aligned.samples).not.toEqual(base.samples);
    expect(aligned.samples.length).toBe(base.samples.length);
    expect(aligned.totalLength).toBe(base.totalLength);

    // 同一条闭环:新数组是旧数组的一个循环移位,顶点一个没动、一个没多。
    const key = (s: { x: number; y: number; z: number; bank: number }): string =>
      `${s.x},${s.y},${s.z},${s.bank}`;
    expect([...aligned.samples].map(key).sort()).toEqual(
      [...base.samples].map(key).sort(),
    );

    const shift = base.samples.findIndex((s) => key(s) === key(aligned.samples[0]!));
    expect(shift).toBeGreaterThan(0);
    for (let i = 0; i < aligned.samples.length; i++) {
      expect(key(aligned.samples[i]!)).toBe(
        key(base.samples[(shift + i) % base.samples.length]!),
      );
    }
  });

  it('arc 从新起点重新编号,仍然等距递增', () => {
    const base = generateTrack(new Rng(9));
    const start = base.samples[0];
    if (start === undefined) {
      throw new Error('赛道没有采样点');
    }
    const aligned = alignStartAwayFromSun(base, start.tangentX, start.tangentZ);

    // Race 按 arc 划检查点,arc 要是没重编,起跑线和 0 号检查点就对不上了。
    aligned.samples.forEach((sample, i) => {
      expect(sample.arc).toBe(i * aligned.spacing);
    });
  });

  it('太阳接近正当头时不换点', () => {
    const base = generateTrack(new Rng(11));
    expect(alignStartAwayFromSun(base, 0, 0)).toBe(base);
  });

  it('同样的输入给同样的起点', () => {
    const a = alignStartAwayFromSun(generateTrack(new Rng(13)), 0.6, -0.8);
    const b = alignStartAwayFromSun(generateTrack(new Rng(13)), 0.6, -0.8);
    expect(a).toEqual(b);
  });
});
