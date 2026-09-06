import { describe, expect, it } from 'vitest';
import { CarCondition } from '../../src/game/condition';
import { CONDITION } from '../../src/game/tuning';

const DT = 1 / 60;

describe('CarCondition', () => {
  it('全新的车三个缩放系数都是 1 —— 加这套系统不影响第一圈的手感基线', () => {
    const c = new CarCondition();
    expect(c.tireGripScale).toBe(1);
    expect(c.brakeScale).toBe(1);
    expect(c.powerScale).toBe(1);
  });

  it('磨损跟滑移功率走:贴着极限开磨得比顺顺当当开快得多', () => {
    const hard = new CarCondition();
    const easy = new CarCondition();
    for (let i = 0; i < 60 * 30; i++) {
      hard.update(DT, 1, CONDITION.tireWearRefSpeed, 0);
      easy.update(DT, 0.2, CONDITION.tireWearRefSpeed, 0);
    }
    expect(hard.tireWear).toBeGreaterThan(easy.tireWear * 3);
    expect(hard.tireGripScale).toBeLessThan(1);
  });

  it('停着不动不磨胎 —— 磨损按滑移算,不按时间算', () => {
    const c = new CarCondition();
    for (let i = 0; i < 60 * 60; i++) {
      c.update(DT, 1, 0, 0);
    }
    expect(c.tireWear).toBe(0);
  });

  it('磨损与损伤都夹在 0..1,长时间跑不会越界', () => {
    const c = new CarCondition();
    for (let i = 0; i < 60 * 3000; i++) {
      c.update(DT, 1, CONDITION.tireWearRefSpeed, 1);
    }
    expect(c.tireWear).toBe(1);
    expect(c.brakeHeat).toBe(1);
    expect(c.tireGripScale).toBeCloseTo(1 - CONDITION.tireGripLoss, 6);

    for (let i = 0; i < 50; i++) {
      c.addImpact(CONDITION.damageRefSpeed);
    }
    expect(c.damage).toBe(1);
    expect(c.powerScale).toBeCloseTo(1 - CONDITION.damagePowerLoss, 6);
  });

  /*
   * 这条守的是一个实测出来的配平错误:第一版升温 0.09 / 冷却 0.055,而车手
   * 不是一直踩着刹车的(占空比撑死两成),0.09 × 0.2 完全抵不过 0.055 的冷却,
   * 跑完 3 圈刹车温度**恒为 0**,热衰等于没做。
   */
  it('升温速率必须远大于冷却速率,否则热衰永远触发不了', () => {
    expect(CONDITION.brakeHeatRate).toBeGreaterThan(CONDITION.brakeCoolRate * 4);
  });

  it('间歇重刹也能攒起温度,松开之后会冷却回去', () => {
    const c = new CarCondition();
    // 两成占空比的刹车,和 AI 实际用刹车的比例接近。
    for (let i = 0; i < 60 * 60; i++) {
      c.update(DT, 0.3, CONDITION.brakeHeatRefSpeed, i % 5 === 0 ? 1 : 0);
    }
    const hot = c.brakeHeat;
    expect(hot).toBeGreaterThan(0);
    expect(c.brakeScale).toBeLessThan(1);

    for (let i = 0; i < 60 * 60; i++) {
      c.update(DT, 0, 0, 0);
    }
    expect(c.brakeHeat).toBeLessThan(hot);
  });

  it('撞得越重掉的动力越多,而且损伤只增不减', () => {
    const light = new CarCondition();
    light.addImpact(CONDITION.damageRefSpeed * 0.3);
    const heavy = new CarCondition();
    heavy.addImpact(CONDITION.damageRefSpeed);
    expect(heavy.damage).toBeGreaterThan(light.damage);
    expect(heavy.powerScale).toBeLessThan(light.powerScale);

    // 之后一直平稳开,损伤不会自己好。
    const before = heavy.damage;
    for (let i = 0; i < 60 * 60; i++) {
      heavy.update(DT, 0, 30, 0);
    }
    expect(heavy.damage).toBe(before);
  });

  it('没撞就不加损伤', () => {
    const c = new CarCondition();
    c.addImpact(0);
    c.addImpact(-5);
    expect(c.damage).toBe(0);
  });

  it('reset 换新车', () => {
    const c = new CarCondition();
    for (let i = 0; i < 600; i++) {
      c.update(DT, 1, CONDITION.tireWearRefSpeed, 1);
    }
    c.addImpact(CONDITION.damageRefSpeed);
    c.reset();
    expect(c.tireWear).toBe(0);
    expect(c.brakeHeat).toBe(0);
    expect(c.damage).toBe(0);
  });
});
