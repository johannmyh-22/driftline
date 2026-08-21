import { describe, expect, it } from 'vitest';
import { tireForce, type TireForce, type TireState } from '../../src/game/tire';
import { TIRE } from '../../src/game/tuning';

/**
 * 全部断言可观测的物理行为,不读任何中间变量。教训见附录:
 * 曾经有测试断言 `yaw 与 steer 同号`,而「yaw 正方向是哪边」恰好正是搞反的那件事,
 * 断言和 bug 共用同一个错误前提 → 83 条测试全绿也拦不住。所以这里一律断言
 * 「力有多大、方向对没对」,不碰内部约定。
 */

const FZ0 = TIRE.staticLoadPerWheel;

function force(row: Partial<TireState> & { load?: number }): TireForce {
  const state: TireState = {
    slipRatio: 0,
    slipAngle: 0,
    load: FZ0,
    friction: 1,
    ...row,
  };
  return tireForce(state, { longitudinal: 0, lateral: 0 });
}

/** 只改变一个量、其余在无滑移状态下的纵向力。 */
function longOnly(slipRatio: number): number {
  return force({ slipRatio }).longitudinal;
}

/** 只改变侧偏角、其余在无滑移状态下的侧向力。 */
function latOnly(slipAngle: number): number {
  return force({ slipAngle }).lateral;
}

/** 找到滑移率在 [0,1] 的粗网格里最大纵向力出现的点。 */
function longPeakPosition(): number {
  let peak = -Infinity;
  let pos = 0;
  for (let s = 0; s <= 1; s += 0.01) {
    const v = longOnly(s);
    if (v > peak) {
      peak = v;
      pos = s;
    }
  }
  return pos;
}

/** 找到侧偏角在 [0,PI/2] 的粗网格里最大侧向力出现的点。 */
function latPeakPosition(): number {
  let peak = -Infinity;
  let pos = 0;
  for (let a = 0; a <= Math.PI / 2; a += Math.PI / 400) {
    const v = latOnly(a);
    if (v > peak) {
      peak = v;
      pos = a;
    }
  }
  return pos;
}

describe('tireForce:零滑移', () => {
  it('slipRatio=0 且 slipAngle=0 时两个分量都是 0', () => {
    const out = force({ slipRatio: 0, slipAngle: 0 });
    expect(out.longitudinal).toBe(0);
    expect(out.lateral).toBe(0);
  });
});

describe('tireForce:峰值位置', () => {
  it('纵向力峰值落在标称峰值滑移率附近(±0.05)', () => {
    const pos = longPeakPosition();
    expect(Math.abs(pos - TIRE.peakSlipRatio)).toBeLessThanOrEqual(0.05);
  });

  it('侧向力峰值落在标称峰值侧偏角附近(±0.05 rad)', () => {
    const pos = latPeakPosition();
    expect(Math.abs(pos - TIRE.peakSlipAngle)).toBeLessThanOrEqual(0.05);
  });
});

describe('tireForce:过峰下降', () => {
  it('纵向力在峰值之后严格单调递减', () => {
    const from = TIRE.peakSlipRatio + 0.02;
    let prev = longOnly(from);
    for (let s = from + 0.02; s <= 1; s += 0.02) {
      const v = longOnly(s);
      expect(v).toBeLessThan(prev);
      prev = v;
    }
  });

  it('侧向力在峰值之后严格单调递减', () => {
    const from = TIRE.peakSlipAngle + 0.02;
    let prev = latOnly(from);
    for (let a = from + 0.02; a <= Math.PI / 2; a += Math.PI / 200) {
      const v = latOnly(a);
      expect(v).toBeLessThan(prev);
      prev = v;
    }
  });
});

describe('tireForce:峰值量级', () => {
  it('额定载荷、friction=1 时峰值侧向力对应 1.3~1.6 g', () => {
    let peak = 0;
    for (let a = 0; a <= Math.PI / 2; a += Math.PI / 2000) {
      peak = Math.max(peak, latOnly(a));
    }
    const g = 9.81;
    const perG = (TIRE.mass / 4) * g; // 单轮承受的静态重量对应的力
    expect(peak / perG).toBeGreaterThan(1.3);
    expect(peak / perG).toBeLessThan(1.6);
  });
});

describe('tireForce:载荷敏感(四轮模型的前提)', () => {
  it('载荷翻倍时峰值力严格小于翻倍', () => {
    const f1 = latOnly(0.2);
    const f2 = force({ load: 2 * FZ0, slipAngle: 0.2 }).lateral;
    expect(f2).toBeLessThan(2 * f1);
  });
});

describe('tireForce:摩擦圆', () => {
  it('纵向滑移远超峰值时,同一刻的侧向力显著小于纯侧向工况', () => {
    const pureLat = latOnly(0.2);
    const mixed = force({ slipAngle: 0.2, slipRatio: 1 }).lateral;
    expect(mixed / pureLat).toBeLessThan(0.2);
  });

  it('满油门全滑移时侧向力接近 0(直线猛打方向不该立刻转向)', () => {
    const pureLat = latOnly(0.2);
    const mixed = force({ slipAngle: 0.2, slipRatio: 10 }).lateral;
    expect(mixed / pureLat).toBeLessThan(0.05);
  });
});

describe('tireForce:符号对称', () => {
  it('滑移取负、力也取负,大小相等', () => {
    const pos = force({ slipRatio: 0.4, slipAngle: 0.3 });
    const neg = force({ slipRatio: -0.4, slipAngle: -0.3 });
    expect(neg.longitudinal).toBeCloseTo(-pos.longitudinal, 10);
    expect(neg.lateral).toBeCloseTo(-pos.lateral, 10);
  });

  it('单独反转一个方向的滑移,该方向力反向、另一方向不变', () => {
    const base = force({ slipRatio: 0.4, slipAngle: 0.3 });
    const negLong = force({ slipRatio: -0.4, slipAngle: 0.3 });
    expect(negLong.longitudinal).toBeCloseTo(-base.longitudinal, 10);
    expect(negLong.lateral).toBeCloseTo(base.lateral, 10);
  });
});

describe('tireForce:路面附着', () => {
  it('friction=0.45 时峰值力约为 friction=1 的 45%(容差放宽)', () => {
    let peakDry = 0;
    let peakLo = 0;
    for (let a = 0; a <= Math.PI / 2; a += Math.PI / 400) {
      peakDry = Math.max(peakDry, latOnly(a));
      peakLo = Math.max(peakLo, force({ slipAngle: a, friction: 0.45 }).lateral);
    }
    expect(peakLo / peakDry).toBeGreaterThan(0.4);
    expect(peakLo / peakDry).toBeLessThan(0.5);
  });
});

describe('tireForce:数值安全', () => {
  it('load=0 时输出有限且为 0', () => {
    const cases: TireState[] = [
      { slipRatio: 0.2, slipAngle: 0.3, load: 0, friction: 1 },
      { slipRatio: 0.2, slipAngle: 0.3, load: -100, friction: 1 },
      { slipRatio: Number.NaN, slipAngle: 0.3, load: FZ0, friction: 1 },
      { slipRatio: Number.POSITIVE_INFINITY, slipAngle: 0.3, load: FZ0, friction: 1 },
      { slipRatio: 0.2, slipAngle: Number.NaN, load: FZ0, friction: 1 },
      { slipRatio: 0.2, slipAngle: Number.NEGATIVE_INFINITY, load: FZ0, friction: 1 },
      { slipRatio: 0.2, slipAngle: 0.3, load: Number.NaN, friction: 1 },
      { slipRatio: 0.2, slipAngle: 0.3, load: Infinity, friction: 1 },
      { slipRatio: 0.2, slipAngle: 0.3, load: FZ0, friction: Number.NaN },
    ];
    for (const s of cases) {
      const out = tireForce(s, { longitudinal: -999, lateral: -999 });
      expect(Number.isFinite(out.longitudinal)).toBe(true);
      expect(Number.isFinite(out.lateral)).toBe(true);
    }
  });

  it('load<=0 时两个分量都为 0', () => {
    const out = force({ load: 0, slipRatio: 0.6, slipAngle: 0.6 });
    expect(out.longitudinal).toBe(0);
    expect(out.lateral).toBe(0);
  });

  it('极大载荷下不出现负力', () => {
    const out = force({ load: 1e9, slipRatio: 0.4 });
    expect(out.longitudinal).toBeGreaterThanOrEqual(0);
  });
});

describe('tireForce:写进 out(不分配)', () => {
  it('连续两次调用复用同一个 out,返回引用同一对象', () => {
    const state: TireState = { slipRatio: 0.4, slipAngle: 0.3, load: FZ0, friction: 1 };
    const out: TireForce = { longitudinal: 0, lateral: 0 };
    const r1 = tireForce(state, out);
    void r1;
    const r2 = tireForce(state, out);
    expect(r2).toBe(out);
  });
});
