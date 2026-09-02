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
    varying vec2 vUv;

    void main() {
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
export function motionBlurStrength(speed01: number): number {
  const span = POST.motionFullSpeed01 - POST.motionMinSpeed01;
  if (span <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, (speed01 - POST.motionMinSpeed01) / span));
}
