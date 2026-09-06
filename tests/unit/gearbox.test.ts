import { describe, expect, it } from 'vitest';
import { Gearbox, torqueAt } from '../../src/game/gearbox';
import { GEARBOX } from '../../src/game/tuning';

const DT = 1 / 60;

/** 把某个挡位下、某个转速对应的驱动轮角速度算出来(rad/s)。 */
function spinFor(gear: number, rpm: number): number {
  const total = (GEARBOX.ratios[gear] ?? 1) * GEARBOX.finalDrive;
  return (rpm * Math.PI * 2) / (60 * total);
}

describe('扭矩曲线', () => {
  it('峰值在 peakRpm,两端都低于峰值', () => {
    expect(torqueAt(GEARBOX.peakRpm)).toBeCloseTo(1, 6);
    expect(torqueAt(GEARBOX.idleRpm)).toBeLessThanOrEqual(1);
    expect(torqueAt(GEARBOX.redlineRpm)).toBeLessThan(1);
  });

  it('过了峰值会回落 —— 那才是"该换挡了"的体感', () => {
    expect(torqueAt(GEARBOX.redlineRpm)).toBeLessThan(torqueAt(GEARBOX.peakRpm));
  });
});

describe('Gearbox', () => {
  it('齿比单调递减,一挡最大', () => {
    for (let i = 1; i < GEARBOX.ratios.length; i++) {
      expect(GEARBOX.ratios[i]).toBeLessThan(GEARBOX.ratios[i - 1] ?? 0);
    }
  });

  it('低挡的轮上力矩明显大于高挡 —— 这就是低挡出弯更容易甩尾的原因', () => {
    const low = new Gearbox();
    const lowScale = low.update(spinFor(0, GEARBOX.peakRpm), 1, DT);

    const high = new Gearbox();
    high.gear = 4;
    const highScale = high.update(spinFor(4, GEARBOX.peakRpm), 1, DT);

    expect(lowScale).toBeGreaterThan(highScale * 2);
  });

  it('转速上到红线会升挡,并且换挡期间动力被切断', () => {
    const gb = new Gearbox();
    const scale = gb.update(spinFor(0, GEARBOX.redlineRpm), 1, DT);
    expect(gb.gear).toBe(1);
    expect(scale).toBe(0);

    // 换挡时间走完之前一直没有动力。
    let t = 0;
    while (t < GEARBOX.shiftTime - DT) {
      expect(gb.update(spinFor(1, GEARBOX.peakRpm), 1, DT)).toBe(0);
      t += DT;
    }
    // 走完之后恢复。
    gb.update(spinFor(1, GEARBOX.peakRpm), 1, DT);
    expect(gb.update(spinFor(1, GEARBOX.peakRpm), 1, DT)).toBeGreaterThan(0);
  });

  it('升挡之后转速不会立刻跌破降挡线 —— 否则会来回抖', () => {
    for (let g = 0; g < GEARBOX.ratios.length - 1; g++) {
      const before = GEARBOX.ratios[g] ?? 1;
      const after = GEARBOX.ratios[g + 1] ?? 1;
      const rpmAfterShift = GEARBOX.upshiftRpm * (after / before);
      expect(rpmAfterShift).toBeGreaterThan(GEARBOX.downshiftRpm);
    }
  });

  it('松油门没有驱动力矩', () => {
    const gb = new Gearbox();
    expect(gb.update(spinFor(0, GEARBOX.peakRpm), 0, DT)).toBe(0);
  });

  it('转速被夹在怠速与红线之间', () => {
    const gb = new Gearbox();
    gb.update(0, 1, DT);
    expect(gb.rpm).toBe(GEARBOX.idleRpm);
    gb.update(spinFor(0, GEARBOX.redlineRpm * 5), 1, DT);
    expect(gb.rpm).toBeLessThanOrEqual(GEARBOX.redlineRpm);
  });

  it('reset 回到一挡怠速', () => {
    const gb = new Gearbox();
    gb.update(spinFor(0, GEARBOX.redlineRpm), 1, DT);
    gb.reset();
    expect(gb.gear).toBe(0);
    expect(gb.rpm).toBe(GEARBOX.idleRpm);
  });
});
