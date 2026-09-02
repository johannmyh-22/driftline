import { describe, expect, it } from 'vitest';
import { MotionBlurShader, motionBlurStrength } from '../../src/gfx/motionBlur';
import { POST, REFERENCE_TOP_SPEED } from '../../src/game/tuning';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 径向动态模糊(M3「速度感」那一格)。
 *
 * 这里测的是**什么时候糊、糊多少**,不是糊出来好不好看 —— 后者归人类看图。
 * 但"停着不动画面也是糊的"和"跑到极速才刚开始糊"这两种错,恰恰是数值问题,
 * 而且只有人盯着玩才发现得了,所以钉在这儿。
 * ══════════════════════════════════════════════════════════════════════════
 */

describe('motionBlurStrength', () => {
  it('静止和低速完全不糊 —— 慢速下的模糊只会让人觉得画面脏', () => {
    expect(motionBlurStrength(0)).toBe(0);
    expect(motionBlurStrength(POST.motionMinSpeed01)).toBe(0);
    expect(motionBlurStrength(POST.motionMinSpeed01 - 0.01)).toBe(0);
  });

  it('过了起点之后连续长上去,不跳变', () => {
    const justAfter = motionBlurStrength(POST.motionMinSpeed01 + 0.001);
    expect(justAfter).toBeGreaterThan(0);
    expect(justAfter).toBeLessThan(0.02);
  });

  it('到满速车速封顶,再快也不继续糊', () => {
    expect(motionBlurStrength(POST.motionFullSpeed01)).toBeCloseTo(1, 9);
    expect(motionBlurStrength(1)).toBe(1);
    expect(motionBlurStrength(5)).toBe(1);
  });

  it('单调不减', () => {
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const value = motionBlurStrength(i / 100);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('起点落在真实会开到的车速区间里', () => {
    /*
     * `motionMinSpeed01` 是拿 `REFERENCE_TOP_SPEED` 归一化的。定得太高的话
     * 这个效果实际上永远不触发 —— 音频那套假变速箱就是这么废掉的(第四十七
     * 节:speed01 在 217 km/h 以上恒等于 1,挡位整段冻住)。这里反过来钉住
     * 下限:起点对应的车速必须在常规驾驶够得着的范围内。
     */
    const startKmh = POST.motionMinSpeed01 * REFERENCE_TOP_SPEED * 3.6;
    expect(startKmh).toBeGreaterThan(40);
    expect(startKmh).toBeLessThan(120);
  });
});

describe('MotionBlurShader', () => {
  it('uniform 名字和 Postprocess 里写的那几个对得上', () => {
    // 名字写错不会报错,只会让效果**悄悄不生效**(uniform.value 设了个没人读
    // 的字段)。这条就是防这个。
    for (const name of ['tDiffuse', 'focus', 'strength', 'focusRadius', 'maxShift']) {
      expect(MotionBlurShader.uniforms).toHaveProperty(name);
    }
  });

  it('采样数被编进了 shader —— 常量改了 shader 要跟着变', () => {
    expect(MotionBlurShader.fragmentShader).toContain(`SAMPLES = ${String(POST.motionSamples)}`);
  });

  it('默认强度是 0 —— 第一帧不该糊', () => {
    expect(MotionBlurShader.uniforms.strength.value).toBe(0);
  });
});
