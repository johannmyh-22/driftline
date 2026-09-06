import { describe, expect, it } from 'vitest';
import { MotionBlurShader, motionBlurStrength } from '../../src/gfx/motionBlur';
import {
  MOVING_LAYER,
  ObjectMotionBlurShader,
  objectMotionStrength,
} from '../../src/gfx/objectMotionBlur';
import { CAMERA, POST, REFERENCE_TOP_SPEED } from '../../src/game/tuning';

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

describe('motionBlurStrength 与 prefers-reduced-motion', () => {
  /*
   * 这一条是**新加动态模糊时顺带补的洞**:项目本来就尊重
   * `prefers-reduced-motion`(相机的滚转清零、FOV 收窄),而全屏径向涂抹
   * 恰恰是前庭不适最直接的诱因 —— 加了这个效果却不接那条偏好,等于把已经
   * 做好的无障碍处理又戳一个洞。
   */
  it('开了偏好之后按 motionReducedScale 收 —— 默认是整个关掉', () => {
    expect(motionBlurStrength(1, true)).toBe(POST.motionReducedScale);
    expect(POST.motionReducedScale).toBe(0);
  });

  it('比相机那条更狠是刻意的,不是抄漏了', () => {
    // FOV 是取景线索,收窄到 0.3 仍然看得出快;模糊减到 0.3 仍然是整幅画面
    // 在动。所以这两个数不该一样,而且模糊这条必须更小。
    expect(POST.motionReducedScale).toBeLessThan(CAMERA.reducedMotionFovScale);
  });

  it('没开偏好的人一个像素都不受影响', () => {
    for (const speed of [0, 0.4, 0.7, 1]) {
      expect(motionBlurStrength(speed, false)).toBe(motionBlurStrength(speed));
    }
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

describe('objectMotionStrength(逐物体那一级)', () => {
  /*
   * 治的是**轮子的马车轮效应**:轮辐每帧转过的角度接近它的旋转对称周期,
   * 看起来在倒转。和上面那级径向模糊分工不同,起点也刻意更低 —— 频闪在中速
   * 就已经很明显了,不用等到快满速。
   */
  it('低速不开 —— 轮子转得慢本来就不频闪', () => {
    expect(objectMotionStrength(0)).toBe(0);
    expect(objectMotionStrength(POST.objectMotionMinSpeed01)).toBe(0);
  });

  it('比径向那级更早开始、更早到顶', () => {
    // 频闪在中速就明显了;而径向模糊是"速度感",慢速下加了只会显得脏。
    expect(POST.objectMotionMinSpeed01).toBeLessThan(POST.motionMinSpeed01);
    expect(POST.objectMotionFullSpeed01).toBeLessThan(POST.motionFullSpeed01);
  });

  it('到满速封顶且单调不减', () => {
    expect(objectMotionStrength(POST.objectMotionFullSpeed01)).toBeCloseTo(1, 9);
    expect(objectMotionStrength(1)).toBe(1);
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const value = objectMotionStrength(i / 100);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('起点对应的车速在常规驾驶够得着的范围内', () => {
    const startKmh = POST.objectMotionMinSpeed01 * REFERENCE_TOP_SPEED * 3.6;
    expect(startKmh).toBeGreaterThan(15);
    expect(startKmh).toBeLessThan(60);
  });

  it('快门比例落在有物理意义的区间里', () => {
    /*
     * 1.0 = 360° 快门(整帧都在曝光),电影常用 180°(0.5)。比 0.5 大一点
     * 才压得住轮辐频闪,但不能超过 1 —— 超过 1 意味着"曝光时间比一帧还长",
     * 那不是快门是拖影。
     */
    expect(POST.objectMotionShutter).toBeGreaterThan(0.5);
    expect(POST.objectMotionShutter).toBeLessThanOrEqual(1);
  });

  it('不受 prefers-reduced-motion 影响 —— 它做的是消除闪烁', () => {
    /*
     * 和径向那级刻意相反。闪烁本身就是光敏性的诱因,为了"减少动态效果"反而
     * 把去闪烁关掉是本末倒置;它作用的面积也只有轮子那么大,不是全屏涂抹。
     * 这条钉住的是"签名里没有 reducedMotion 参数"这件事本身。
     */
    expect(objectMotionStrength.length).toBe(1);
  });
});

describe('MOVING_LAYER', () => {
  it('不是第 0 层 —— 那些网格还要在主画面里正常渲染', () => {
    /*
     * 速度缓冲靠 `camera.layers.set(MOVING_LAYER)` 只画会动的东西。如果这个
     * 层号是 0,`layers.enable(0)` 等于没做标记,速度缓冲会把**整个世界**都
     * 画进去 —— 帧时间直接翻倍,而画面上看不出区别。
     */
    expect(MOVING_LAYER).toBeGreaterThan(0);
    expect(MOVING_LAYER).toBeLessThan(32);
  });
});

describe('ObjectMotionBlurShader', () => {
  it('uniform 名字和 Postprocess 里写的对得上', () => {
    for (const name of ['tDiffuse', 'tVelocity', 'strength', 'maxShift']) {
      expect(ObjectMotionBlurShader.uniforms).toHaveProperty(name);
    }
  });

  it('采样数被编进了 shader,而且比径向那级多', () => {
    expect(ObjectMotionBlurShader.fragmentShader).toContain(
      `SAMPLES = ${String(POST.objectMotionSamples)}`,
    );
    // 轮辐是高对比细节,采样少了会看出一格一格的重影。
    expect(POST.objectMotionSamples).toBeGreaterThan(POST.motionSamples);
  });

  it('速度缓冲的 alpha 当掩码用 —— 没画到的地方必须原样输出', () => {
    // 没有这条判断的话,整片地形和天空都会去读一张全 0 的速度图再走一遍
    // 采样循环,白花全屏的钱。
    expect(ObjectMotionBlurShader.fragmentShader).toContain('velocity.a < 0.5');
  });
});
