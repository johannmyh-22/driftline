import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { generateTrack } from '../../src/game/trackLayout';
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
