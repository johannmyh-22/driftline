import {
  type Camera,
  Color,
  HalfFloatType,
  type Material,
  Matrix4,
  Mesh,
  NoBlending,
  type Object3D,
  type Scene,
  ShaderMaterial,
  Vector4,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { POST } from '../game/tuning';

/**
 * 会动的东西所在的渲染层。速度缓冲只画这一层。
 *
 * 用 `layers.enable()` 而不是 `set()`:这些网格**同时**还要在第 0 层被正常
 * 渲染,`set()` 会把它们从主画面里摘掉。
 */
export const MOVING_LAYER = 1;

/**
 * 逐物体运动模糊(B2:治轮子高速频闪)。
 *
 * ## 要治的到底是什么
 *
 * 车轮每帧转过的角度接近轮辐的旋转对称周期,采样定理下看起来在倒转或乱转
 * (马车轮效应)。24 m/s 时每帧转 66°,而五辐轮的对称周期是 72° —— 视觉上
 * 每帧倒退 6°。**这不是 bug 是采样**,唯一的解是让每一帧包含"曝光时间内的
 * 一段运动",也就是运动模糊。
 *
 * ## 和 `motionBlur.ts` 那一级是两件事,合起来才完整
 *
 * | | 治什么 | 怎么做 |
 * |---|---|---|
 * | `motionBlur.ts`(径向) | **相机自己在动**:世界向后掠过 | 从扩张焦点向外的径向涂抹,不需要任何缓冲 |
 * | 这里(逐物体) | **物体相对相机在动**:轮子在转、对手在错身 | 画一张速度缓冲,按每个像素自己的速度方向涂抹 |
 *
 * 两者刻意**不重复计算**:速度缓冲用的是**当前帧的相机矩阵**算前后两个位置,
 * 所以相机自身的运动被约掉了,剩下的纯粹是物体相对相机的运动。车身相对追尾
 * 相机几乎不动 → 几乎不糊;车轮在自转 → 糊。这正是想要的分工。
 *
 * ## 只画会动的那几个物体,不画整个世界
 *
 * 整场景再渲一遍在 SwiftShader 上基本等于帧时间翻倍,而这条截图回路是整个
 * 项目的地基(CLAUDE.md 的性能风险那条)。所以速度缓冲只画 `MOVING_LAYER`
 * 上的东西 —— 玩家、三辆对手、幽灵,合计几万三角形,而不是整片地形。
 *
 * **代价写在这里,别当它不存在**:速度缓冲没有世界的深度,所以一辆被土坡
 * 挡住的对手车仍然会往那块地形上写速度,理论上会在坡上糊出一小片。实际影响
 * 很小(对手相对我们移动慢,`objectMotionMaxShift` 又把位移夹得很紧),而
 * 最主要的场景 —— 自己的车轮 —— 在追尾视角下永远不会被挡。要根治就得整场景
 * 渲速度,那是拿地基换一个看不太出来的边角。
 */

/**
 * 速度缓冲的材质。算的是**这个点在屏幕上真正移动了多少**,也就是光流本身。
 *
 * ## 上一帧的位置必须用**上一帧的相机矩阵**
 *
 * 第一版两边都用当前帧的相机矩阵,注释里还写着"这样相机自己的运动就被约掉
 * 了" —— **完全写反了**。两边同一个相机 = 算的是物体在**世界里**的位移,
 * 而车在世界里每帧要跑 0.83 米(50 m/s)。于是跟着相机一起走、在画面上纹丝
 * 不动的车身,被算出一大截速度,开快了整台车就糊了。人类的原话是
 * 「开快起来的时候车怎么是糊的」。
 *
 * 正确的是 `s_now − s_prev`,两边各用各的相机:
 *
 * - 车身跟着相机走 → 两个屏幕坐标几乎重合 → **不糊**。
 * - 车轮在自转,那份旋转不在相机里 → 有速度 → **糊**。这正是要治的频闪。
 * - 对手横向错身 → 有速度 → 糊。
 *
 * 世界(地形/赛道)不在这张缓冲里(只画 `MOVING_LAYER`),相机运动那一份由
 * `motionBlur.ts` 的径向近似负责,两级仍然不重复。
 */
function createVelocityMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      /** 这个物体**上一帧**的世界变换。逐物体在 `onBeforeRender` 里换。 */
      prevModelMatrix: { value: new Matrix4() },
      /** **上一帧**的 projection × view。每帧换一次,不是逐物体。 */
      prevViewProjection: { value: new Matrix4() },
    },
    vertexShader: /* glsl */ `
      uniform mat4 prevModelMatrix;
      uniform mat4 prevViewProjection;
      varying vec4 vCurrent;
      varying vec4 vPrevious;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vec4 prevWorld = prevModelMatrix * vec4(position, 1.0);
        // 各用各的相机 —— 这才是"这个点在屏幕上移动了多少"。用同一个相机
        // 算出来的是世界位移,跟着相机走的车身会被判成在高速移动。
        vCurrent = projectionMatrix * viewMatrix * world;
        vPrevious = prevViewProjection * prevWorld;
        gl_Position = vCurrent;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec4 vCurrent;
      varying vec4 vPrevious;
      void main() {
        vec2 a = vCurrent.xy / vCurrent.w;
        vec2 b = vPrevious.xy / vPrevious.w;
        // NDC 的跨度是 2,uv 是 1,所以差值要减半。
        vec2 delta = (a - b) * 0.5;
        // alpha 当掩码用:没画到的地方 alpha 是 0,模糊那一级据此整个跳过。
        gl_FragColor = vec4(delta, 0.0, 1.0);
      }
    `,
    // 速度不能混合,写进去多少就是多少。
    blending: NoBlending,
  });
}

/** 采样时用的模糊着色器。读一张速度图,按每个像素自己的速度方向涂抹。 */
export const ObjectMotionBlurShader = {
  name: 'ObjectMotionBlurShader',
  uniforms: {
    tDiffuse: { value: null },
    tVelocity: { value: null },
    /** 快门比例:一帧位移的多少算进这次曝光。 */
    strength: { value: 0 },
    /** 位移上限(uv),防止极端转速把画面拉成一条。 */
    maxShift: { value: POST.objectMotionMaxShift },
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
    uniform sampler2D tVelocity;
    uniform float strength;
    uniform float maxShift;
    varying vec2 vUv;

    void main() {
      vec4 velocity = texture2D(tVelocity, vUv);
      // 速度缓冲里没画到的地方(整片地形、天空)直接原样输出。
      if (velocity.a < 0.5) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      vec2 delta = velocity.xy * strength;
      float len = length(delta);
      if (len < 0.0004) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }
      if (len > maxShift) {
        delta *= maxShift / len;
      }

      vec4 sum = vec4(0.0);
      const int SAMPLES = ${String(POST.objectMotionSamples)};
      for (int i = 0; i < SAMPLES; i++) {
        // 对称展开:曝光的中点就是当前这一帧的位置,真实相机就是这么积分的。
        float t = float(i) / float(SAMPLES - 1) - 0.5;
        sum += texture2D(tDiffuse, clamp(vUv + delta * t, vec2(0.0), vec2(1.0)));
      }
      gl_FragColor = sum / float(SAMPLES);
    }
  `,
};

/**
 * 速度缓冲。持有渲染目标和逐物体的「上一帧世界变换」。
 *
 * 上一帧的矩阵存在 `WeakMap` 里而不是挂到 `userData`:换车壳(第四十九节)
 * 会把整批网格换掉,弱引用不会把旧的那批钉在内存里。
 */
export class VelocityBuffer {
  readonly target: WebGLRenderTarget;

  private readonly material = createVelocityMaterial();
  private readonly previous = new WeakMap<Object3D, Matrix4>();
  private readonly marked = new Set<Object3D>();
  private readonly savedViewport = new Vector4();
  private readonly savedClearColor = new Color();
  /** 上一帧的 projection × view。 */
  private readonly prevViewProjection = new Matrix4();
  /**
   * 上一帧用的是哪个相机。**切机位要当第一帧处理** —— 追尾和固定机位之间
   * 一换,两帧的屏幕坐标毫无关系,不重置的话会闪一帧糊得看不清的画面。
   */
  private lastCamera: Camera | null = null;

  constructor(width = 1, height = 1) {
    this.target = new WebGLRenderTarget(width, height, {
      // 半浮点:速度可正可负,而且要的精度远高于 8 位(8 位在慢转时会分档)。
      type: HalfFloatType,
      depthBuffer: true,
    });
  }

  /**
   * 把一棵子树标成「会动的」。可以重复调(换车壳之后要对新的那批再调一次)。
   */
  mark(root: Object3D): void {
    root.traverse((child) => {
      if (!(child instanceof Mesh) || this.marked.has(child)) {
        return;
      }
      this.marked.add(child);
      child.layers.enable(MOVING_LAYER);
      const mesh = child;
      /*
       * `overrideMaterial` 全场只有一份材质,所以逐物体的 uniform 只能在这里
       * 换。**必须判一下当前用的是不是速度材质** —— 这个回调在正常上色那一遍
       * 也会被调到。
       */
      mesh.onBeforeRender = (_renderer, _scene, _camera, _geometry, material: Material): void => {
        const shader = material as ShaderMaterial;
        const slot = shader.uniforms?.['prevModelMatrix'];
        if (slot === undefined) {
          return;
        }
        (slot.value as Matrix4).copy(this.previous.get(mesh) ?? mesh.matrixWorld);
        /*
         * **这一行是整件事能不能成立的关键。**
         *
         * `overrideMaterial` 让全场共用同一份材质,而 three 会按材质 id 缓存
         * "程序已经刷过了":同一份材质连着画很多个物体时,后面那些**根本不会
         * 重新上传材质的 uniform**。于是上面那次 copy 只对第一个网格生效,
         * 其余几十个网格全都拿着第一个的上一帧矩阵在算速度。
         *
         * 症状很有欺骗性:速度缓冲**看起来是work的**(轮子确实糊了),只是
         * 幅度不对。是量出来才发现的 —— 把快门从 0.7 拉到 2.0、位移上限从
         * 0.03 拉到 0.09,帧间差几乎没变,说明幅度被别的东西钉住了,不是参数
         * 不够大。
         */
        shader.uniformsNeedUpdate = true;
      };
    });
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, width), Math.max(1, height));
  }

  /**
   * 画一遍速度缓冲。**只画 `MOVING_LAYER`**,靠临时改相机的层掩码实现 ——
   * 不复制相机,免得每帧再同步一套矩阵。
   */
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    const savedTarget = renderer.getRenderTarget();
    const savedOverride = scene.overrideMaterial;
    const savedMask = camera.layers.mask;
    renderer.getViewport(this.savedViewport);
    renderer.getClearColor(this.savedClearColor);
    const savedClearAlpha = renderer.getClearAlpha();

    /*
     * 第一帧、以及刚切过机位的那一帧,没有可用的"上一帧相机" —— 直接用当前
     * 的,速度自然算成 0,比闪一帧糊掉的画面好。
     */
    if (this.lastCamera !== camera) {
      this.prevViewProjection
        .copy(camera.projectionMatrix)
        .multiply(camera.matrixWorldInverse);
      this.lastCamera = camera;
    }
    const slot = this.material.uniforms['prevViewProjection'];
    if (slot !== undefined) {
      (slot.value as Matrix4).copy(this.prevViewProjection);
    }

    camera.layers.set(MOVING_LAYER);
    scene.overrideMaterial = this.material;
    renderer.setRenderTarget(this.target);
    // 清成全 0:alpha=0 就是「这里没有会动的东西」,模糊那一级据此跳过。
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    scene.overrideMaterial = savedOverride;
    camera.layers.mask = savedMask;
    renderer.setRenderTarget(savedTarget);
    renderer.setViewport(this.savedViewport);
    // 清屏色一定要还回去:后面那条后处理链里有人会用它清背景。
    renderer.setClearColor(this.savedClearColor, savedClearAlpha);

    // 这一帧画完才更新「上一帧」,否则同一帧里前后两个位置会是同一个。
    this.prevViewProjection.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse);
    for (const mesh of this.marked) {
      let stored = this.previous.get(mesh);
      if (stored === undefined) {
        stored = new Matrix4();
        this.previous.set(mesh, stored);
      }
      stored.copy(mesh.matrixWorld);
    }
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.marked.clear();
  }
}

/**
 * 归一化车速 → 逐物体模糊强度(0..1)。单独拎出来是为了能单测,理由和
 * `motionBlurStrength()` 一样。
 */
export function objectMotionStrength(speed01: number): number {
  const span = POST.objectMotionFullSpeed01 - POST.objectMotionMinSpeed01;
  if (span <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, (speed01 - POST.objectMotionMinSpeed01) / span));
}
