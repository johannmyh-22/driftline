import { Vector2 } from 'three';
import { POST } from '../game/tuning';

/**
 * 径向动态模糊(M3「速度感:动态模糊或速度线」那一格)。
 *
 * ## 为什么是**径向**,而且中心不是屏幕中心
 *
 * 这不是"随便糊一下显得快"。相机纯前进时,静止场景在画面上的光流是一个
 * **从扩张焦点(focus of expansion)向外发散的径向场** —— 扩张焦点就是相机
 * 速度方向在画面上的投影。所以径向模糊在这里是**物理上对的形状**,不是特效
 * 风格的选择;把中心钉死在屏幕中央才是近似,过弯时会明显不对。
 *
 * 这里按每帧真实的速度方向算扩张焦点(见 `Postprocess.setMotionBlur()`),
 * 直线段它就在画面中心附近,过弯时会挪到弯心那一侧 —— 和眼睛看到的一致。
 *
 * ## 拖尾是**单向**的
 *
 * 采样从当前像素往扩张焦点方向走,不向两边对称展开:物体是从靠近焦点的地方
 * 「过来」的,尾巴应该拖在后面,前缘保持清晰。对称模糊会让物体的前缘也糊掉,
 * 看着像失焦而不是像快。
 *
 * ## 尊重 `prefers-reduced-motion`
 *
 * 全屏径向涂抹是前庭不适最直接的诱因,开了那个偏好就整个关掉
 * (`POST.motionReducedScale`)。**这一条比相机那边更狠是故意的**:
 * `CAMERA.reducedMotionFovScale` 只把 FOV 收窄不清零,因为 FOV 是取景线索;
 * 而模糊减到三成仍然是整幅画面在动。理由写在那个常量的注释里。
 *
 * ## 两级分区:会动的物体交给逐物体那一级
 *
 * 这一级的模型是「静止的世界在相机运动下的光流」,**它对跟着相机一起走的
 * 车身根本不成立**。而追尾机位是俯视着车的,扩张焦点落在车的**上方** ——
 * 车离焦点有 0.3 uv,算出来约 9 个像素的涂抹。人类反馈「开快起来的时候车
 * 怎么是糊的」,主要就是这一份。
 *
 * 修法不是把不糊的半径调大(那会连车周围的路面一起解糊),而是让两级真正
 * **按像素分区**:`objectMotionBlur.ts` 的速度缓冲里,alpha 已经精确标出
 * 「这个像素属于会动的物体」。这一级跳过它们,交给那一级按各自真实的速度
 * 去涂。世界归径向,物体归逐物体,不重叠也不漏。
 *
 * 逐物体那一级被关掉时(`?post=` 里没有 `objmotion`)掩码不可用,
 * `useMask` 为 0,这一级退回原来的"全屏都涂"。
 *
 * ## 为什么中心留一块不糊
 *
 * 光流大小 ∝ 离焦点的距离,焦点处本来就是 0。而追尾机位下车正好在焦点附近 ——
 * 这一条同时解决了「车自己不该糊」(它相对相机几乎不动)和「中心不该糊」
 * 两件事,不需要额外的深度或速度缓冲。`motionFocusRadius` 就是这块的大小。
 */
export const MotionBlurShader = {
  name: 'MotionBlurShader',

  uniforms: {
    tDiffuse: { value: null },
    /** 扩张焦点,uv 坐标(0..1)。 */
    focus: { value: new Vector2(0.5, 0.5) },
    /** 0..1 总强度。0 时 `Postprocess` 会直接把这一级关掉,不白跑一遍全屏。 */
    strength: { value: 0 },
    /** 这个半径(uv)以内不糊,以外线性长上去。 */
    focusRadius: { value: POST.motionFocusRadius },
    /** 满强度时最远采样偏移,占「像素到焦点距离」的比例。 */
    maxShift: { value: POST.motionMaxShift },
    /** 逐物体那一级的速度缓冲,当掩码用(见下面「两级分区」)。 */
    tVelocity: { value: null },
    /** 掩码可不可用。逐物体那一级被关掉时是 0,这一级退回"全屏都涂"。 */
    useMask: { value: 0 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 focus;
    uniform float strength;
    uniform float focusRadius;
    uniform float maxShift;
    uniform sampler2D tVelocity;
    uniform float useMask;
    varying vec2 vUv;

    void main() {
      // 会动的物体交给逐物体那一级 —— 这一级的模型对它们不成立(见类注释)。
      if (useMask > 0.5 && texture2D(tVelocity, vUv).a > 0.5) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      vec2 toFocus = focus - vUv;
      float r = length(toFocus);
      // 焦点附近不糊,往外线性长起来。smoothstep 而不是 step:硬边界会在
      // 画面上留下一圈看得见的接缝。
      float ramp = smoothstep(focusRadius, focusRadius + 0.35, r);
      float amount = ramp * strength * maxShift;
      if (amount <= 0.0001) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      vec4 sum = vec4(0.0);
      const int SAMPLES = ${String(POST.motionSamples)};
      for (int i = 0; i < SAMPLES; i++) {
        float t = float(i) / float(SAMPLES - 1);
        // 往焦点方向走 = 往「这个像素刚才在哪」走,尾巴拖在后面。
        vec2 uv = vUv + toFocus * t * amount;
        sum += texture2D(tDiffuse, clamp(uv, vec2(0.0), vec2(1.0)));
      }
      gl_FragColor = sum / float(SAMPLES);
    }
  `,
};

/**
 * 归一化车速 → 模糊强度(0..1)。
 *
 * 单独拎出来是为了能单测:`Postprocess` 要一个真的 `WebGLRenderer` 才能构造,
 * 而这段"什么时候开始糊、多快糊到顶"的判断恰恰是最需要钉住的 —— 它错了的
 * 表现是"停着不动画面也是糊的"或者"跑到极速才刚开始糊",两种都只有人盯着
 * 玩才发现得了。
 */
export function motionBlurStrength(speed01: number, reducedMotion = false): number {
  const span = POST.motionFullSpeed01 - POST.motionMinSpeed01;
  if (span <= 0) {
    return 0;
  }
  const raw = Math.min(1, Math.max(0, (speed01 - POST.motionMinSpeed01) / span));
  return reducedMotion ? raw * POST.motionReducedScale : raw;
}
