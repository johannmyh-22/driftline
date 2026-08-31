import { describe, expect, it } from 'vitest';
import { FIXED_DT } from '../../src/core/loop';
import { rollAt } from '../../src/game/wheelView';
import { CAR } from '../../src/game/tuning';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 轮子滚转角的渲染插值。
 *
 * 这一层是补上来的:上一版渲染直接拿物理的当前 `rollAngle`,理由写在注释里
 * ——「悬挂行程和转向角的变化幅度是厘米/几度的量级,插不插值看不出来」。
 * 那条推理**对悬挂和转向成立、对滚转角不成立**,而且差了两个数量级:
 * 24 m/s 时一个物理步就转 66°。物理固定 60 Hz、渲染按 alpha 插值,于是在
 * 高刷屏上车身平滑、轮子一顿一顿的。
 *
 * 所以这里钉两件事:插值本身对,以及**每步的角度量确实大到必须插**——
 * 后面这条才是当初那句注释错在哪。
 * ══════════════════════════════════════════════════════════════════════════
 */

describe('rollAt', () => {
  it('alpha=1 时就是物理的当前值 —— 截图回路必须逐位不变', () => {
    const wheel = { rollAngle: 1.234, spin: 70 };
    expect(rollAt(wheel, 1)).toBe(wheel.rollAngle);
  });

  it('alpha=0 时回到上一个物理步的角度', () => {
    const wheel = { rollAngle: 1.234, spin: 70 };
    expect(rollAt(wheel, 0)).toBeCloseTo(1.234 - 70 * FIXED_DT, 12);
  });

  it('中间值线性,且和物理积分完全一致', () => {
    const wheel = { rollAngle: 2, spin: 120 };
    const half = rollAt(wheel, 0.5);
    // 物理是 rollAngle_prev + spin*dt;插一半就该正好是 prev + spin*dt/2。
    expect(half).toBeCloseTo(2 - 120 * FIXED_DT * 0.5, 12);
  });

  it('倒车(spin 为负)时往反方向回推', () => {
    const wheel = { rollAngle: 0.5, spin: -40 };
    expect(rollAt(wheel, 0)).toBeGreaterThan(wheel.rollAngle);
  });

  it('不受 rollAngle 对 2π 取模的影响 —— 这正是不能按角度插值的原因', () => {
    /*
     * 物理里 `rollAngle` 每步都 `% (2π)`,所以它会在 0 附近来回跳。按角度
     * 插值(lerp(prev, curr, alpha))在跨过这一步时会朝反方向插一大圈;
     * 按角速度回推只依赖 spin,和当前角落在哪一圈无关。
     */
    const spin = 70;
    const justWrapped = { rollAngle: 0.05, spin };
    const notWrapped = { rollAngle: 0.05 + Math.PI * 2, spin };
    expect(rollAt(justWrapped, 0.3) + Math.PI * 2).toBeCloseTo(rollAt(notWrapped, 0.3), 12);
  });

  it('每个物理步转过的角度确实大到必须插值', () => {
    // 24 m/s(约 86 km/h,这个游戏里的常规巡航速度)。
    const spin = 24 / CAR.wheelRadius;
    const perStep = ((spin * FIXED_DT) / Math.PI) * 180;
    expect(perStep).toBeGreaterThan(60);
    // 顺带钉住上限:极速下一步转过半圈以上,这就是频闪的来源
    //(采样定理,插值治不了,要运动模糊)。
    const perStepTop = (((240 / 3.6 / CAR.wheelRadius) * FIXED_DT) / Math.PI) * 180;
    expect(perStepTop).toBeGreaterThan(180);
  });
});
