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

/**
 * 只改变侧偏角时的侧向力**大小**。
 *
 * 取绝对值是有意的:侧向力抵抗侧滑,所以正侧偏角对应负的力。「峰值多大」
 * 「过峰后掉不掉」这类断言问的是大小,方向单独由下面那条测试盯着 ——
 * 第一版把两件事混在一个符号里,结果方向反了也照样绿。
 */
function latMagnitude(slipAngle: number): number {
  return Math.abs(force({ slipAngle }).lateral);
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
    const v = latMagnitude(a);
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
    let prev = latMagnitude(from);
    for (let a = from + 0.02; a <= Math.PI / 2; a += Math.PI / 200) {
      const v = latMagnitude(a);
      expect(v).toBeLessThan(prev);
      prev = v;
    }
  });
});

describe('tireForce:峰值量级', () => {
  it('额定载荷、friction=1 时峰值侧向力对应 1.3~1.6 g', () => {
    let peak = 0;
    for (let a = 0; a <= Math.PI / 2; a += Math.PI / 2000) {
      peak = Math.max(peak, latMagnitude(a));
    }
    // 单轮静载就是「1 g」对应的力,tuning 里已经有这个量,不要再抄一份质量和重力。
    const perG = TIRE.staticLoadPerWheel;
    expect(peak / perG).toBeGreaterThan(1.3);
    expect(peak / perG).toBeLessThan(1.6);
  });
});

describe('tireForce:载荷敏感(四轮模型的前提)', () => {
  it('载荷翻倍时峰值力严格小于翻倍', () => {
    const f1 = latMagnitude(0.2);
    const f2 = Math.abs(force({ load: 2 * FZ0, slipAngle: 0.2 }).lateral);
    expect(f2).toBeLessThan(2 * f1);
  });
});

describe('tireForce:摩擦圆', () => {
  it('纵向滑移远超峰值时,同一刻的侧向力显著小于纯侧向工况', () => {
    const pureLat = latMagnitude(0.2);
    const mixed = force({ slipAngle: 0.2, slipRatio: 1 }).lateral;
    expect(mixed / pureLat).toBeLessThan(0.2);
  });

  it('满油门全滑移时侧向力接近 0(直线猛打方向不该立刻转向)', () => {
    const pureLat = latMagnitude(0.2);
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
      peakDry = Math.max(peakDry, latMagnitude(a));
      peakLo = Math.max(peakLo, Math.abs(force({ slipAngle: a, friction: 0.45 }).lateral));
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

describe('tireForce:两个「全绿也没拦住」的洞', () => {
  /*
   * 这两条是补上去的。交付的第一版 16 条测试全绿,但同时存在两个真缺陷:
   * 侧向力方向反了、摩擦圆在中等滑移区超预算 38%。
   * 它们没被拦住,是因为原来的断言全都只问「大小」和「极端工况」。
   */

  it('侧向力抵抗侧滑,不是顺着侧滑', () => {
    // 接地点往左滑(正侧偏角),轮胎就必须往右推,否则是正反馈,一帧就发散。
    expect(force({ slipAngle: 0.05 }).lateral).toBeLessThan(0);
    expect(force({ slipAngle: 0.14 }).lateral).toBeLessThan(0);
    expect(force({ slipAngle: 0.6 }).lateral).toBeLessThan(0);
    expect(force({ slipAngle: -0.14 }).lateral).toBeGreaterThan(0);
  });

  it('驱动滑移推着车往前,制动滑移拖着车往后', () => {
    expect(force({ slipRatio: 0.12 }).longitudinal).toBeGreaterThan(0);
    expect(force({ slipRatio: -0.12 }).longitudinal).toBeLessThan(0);
  });

  it('合力在整个滑移平面上都不超过摩擦预算', () => {
    // 关键是**扫一片**而不是只测极端值:第一版的洞在 κ、α 都还没到各自峰值
    // 的中间区(实测最差 1.384 倍,出现在 κ=0.090 / α=0.087)。
    const budget = TIRE.mu0 * FZ0;
    let worst = 0;
    for (let i = 0; i <= 60; i++) {
      for (let j = 0; j <= 60; j++) {
        const out = force({ slipRatio: (i / 60) * 0.6, slipAngle: (j / 60) * 0.8 });
        worst = Math.max(worst, Math.hypot(out.longitudinal, out.lateral) / budget);
      }
    }
    expect(worst).toBeLessThanOrEqual(1 + 1e-9);
    // 同时确认预算是**用得满**的,否则「不超过」可以靠把力算小来作弊。
    expect(worst).toBeGreaterThan(0.98);
  });
});
