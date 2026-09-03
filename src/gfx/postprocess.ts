import {
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  Vector2,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js';
import { POST } from '../game/tuning';
import { MotionBlurShader, motionBlurStrength } from './motionBlur';
import {
  ObjectMotionBlurShader,
  VelocityBuffer,
  objectMotionStrength,
} from './objectMotionBlur';
import { prefersReducedMotion } from '../core/reducedMotion';

/** 可单独开关的环节。`?post=` 按名字启用,量各级成本、诊断画面问题都靠它。 */
export type PostStage = 'ao' | 'motion' | 'objmotion' | 'bloom' | 'smaa' | 'vignette';

export const ALL_STAGES: readonly PostStage[] = [
  'ao',
  'motion',
  'objmotion',
  'bloom',
  'smaa',
  'vignette',
];

/**
 * 默认启用的环节。**AO 故意不在里面。**
 *
 * SwiftShader 上量下来(1280x720,chase 机位,相对无后处理的 325 ms/帧):
 *
 * | 环节 | 每帧成本 | 画面差异(对比无后处理) |
 * |---|---|---|
 * | 暗角 | +45 ms | 明显,四角压暗 |
 * | bloom | +155 ms | 明显,太阳方向出逆光辉光 |
 * | SMAA | +178 ms | 明显,边缘锯齿消失 |
 * | AO | +169 ms | **平均 3.8/255,肉眼看不出** |
 *
 * AO 弱不是配置错了,是**这个场景根本没有遮蔽关系**:开阔沙漠、平坦赛道,
 * 而且反重力载具悬浮在地面 1.6 米以上,连接触点都没有。半径从 0.45 米加到
 * 2.5 米,差异反而更小(越大越平滑)—— 符合预期,只是没东西可遮。
 *
 * 代码留着不删:M5 的隧道段一进来,遮蔽关系就有了,那时把 'ao' 加回默认即可。
 */
export const DEFAULT_STAGES: readonly PostStage[] = [
  'motion',
  'objmotion',
  'bloom',
  'smaa',
  'vignette',
];

/**
 * 后处理链。
 *
 * 顺序不是随便排的,排错了不会报错、只会让画面悄悄变糟:
 *
 * - **AO 和 bloom 必须在线性 HDR 空间做。** three 只在渲染到画布时应用色调映射,
 *   渲染到 render target 时是 `NoToneMapping` —— 所以 `RenderPass` 的输出天然就是
 *   线性 HDR,正好是这两个 pass 想要的输入。在 sRGB 上做 bloom,亮部会溢出成一团
 *   均匀的白,而不是按能量扩散。
 * - **`OutputPass` 才是做 ACES + sRGB 的地方**,它从 renderer 上读这两个设置。
 * - **SMAA 必须排在 `OutputPass` 之后。** 它按感知亮度找边,喂线性值会让暗部的边
 *   全被判成平坦区,抗锯齿基本失效。
 * - 暗角最后,压在成片上。
 *
 * 全链零素材:SMAA 的两张查找纹理是 three 用 base64 内联在 js 里的,不是素材文件。
 */
export class Postprocess {
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly gtao: GTAOPass | null = null;
  private readonly bloom: UnrealBloomPass | null = null;
  private readonly motion: ShaderPass | null = null;
  private readonly objectMotion: ShaderPass | null = null;
  private readonly velocity: VelocityBuffer | null = null;
  /** 除 RenderPass / OutputPass 之外的所有 pass,给 `setEffectsEnabled()` 整批开关。 */
  private readonly effects: Pass[] = [];
  private readonly aoScale: number;
  private readonly bloomScale: number;
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private effectsOn = true;
  private readonly reducedMotion = prefersReducedMotion();
  private width = 1;
  private height = 1;

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    stages: readonly PostStage[] = DEFAULT_STAGES,
  ) {
    const enabled = new Set(stages);
    this.renderer = renderer;
    this.scene = scene;
    this.aoScale = POST.aoResolutionScale;
    this.bloomScale = POST.bloomResolutionScale;
    this.composer = new EffectComposer(renderer);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    if (enabled.has('ao')) {
      const gtao = new GTAOPass(scene, camera);
      gtao.blendIntensity = POST.aoIntensity;
      gtao.updateGtaoMaterial({
        radius: POST.aoRadius,
        distanceExponent: POST.aoDistanceExponent,
        thickness: POST.aoThickness,
        scale: POST.aoScale,
        samples: POST.aoSamples,
      });
      this.composer.addPass(gtao);
      this.effects.push(gtao);
      this.gtao = gtao;
    }

    /*
     * 动态模糊排在 AO 之后、bloom 之前。
     *
     * AO 是**着色**阶段的效果,先算完再谈曝光;动态模糊和 bloom 都是相机在
     * 「拍下这一帧」时发生的事,而真实相机里是先有曝光时间内的位移(模糊),
     * 光才在镜头/传感器里散开(bloom)—— 所以模糊在前。反过来的话,尾灯的
     * 辉光会被拉成一条明显是后期加的光带。
     *
     * 两者都必须在 `OutputPass` 之前,也就是在**线性 HDR** 空间里做,理由和
     * bloom 那条一样(见类注释)。
     */
    if (enabled.has('motion')) {
      const motion = new ShaderPass(MotionBlurShader);
      // 默认不出力:`setMotionBlur()` 每帧按车速给值,慢速时整级会被关掉。
      motion.enabled = false;
      this.composer.addPass(motion);
      this.effects.push(motion);
      this.motion = motion;
    }

    /*
     * 逐物体模糊紧跟在径向之后:两者都是"相机在曝光期间发生的事",而它们的
     * 分工是相机运动 vs 物体相对运动(见 `objectMotionBlur.ts`)。谁先谁后
     * 差别很小,排在一起是为了让"曝光"这一段在链上是连续的,后面才是
     * bloom(镜头/传感器的散射)。
     */
    if (enabled.has('objmotion')) {
      const velocity = new VelocityBuffer();
      const pass = new ShaderPass(ObjectMotionBlurShader);
      const slot = pass.uniforms['tVelocity'];
      if (slot === undefined) {
        throw new Error('ObjectMotionBlurShader 没有 tVelocity uniform');
      }
      slot.value = velocity.target.texture;
      pass.enabled = false;
      this.composer.addPass(pass);
      this.effects.push(pass);
      this.objectMotion = pass;
      this.velocity = velocity;
    }

    if (enabled.has('bloom')) {
      // 分辨率由 setSize 接管,构造时给什么都会被覆盖。
      const bloom = new UnrealBloomPass(
        new Vector2(1, 1),
        POST.bloomStrength,
        POST.bloomRadius,
        POST.bloomThreshold,
      );
      clampBloomInput(bloom);
      this.composer.addPass(bloom);
      this.effects.push(bloom);
      this.bloom = bloom;
    }

    this.composer.addPass(new OutputPass());

    if (enabled.has('smaa')) {
      const smaa = new SMAAPass();
      this.composer.addPass(smaa);
      this.effects.push(smaa);
    }

    if (enabled.has('vignette')) {
      const vignette = new ShaderPass(VignetteShader);
      setNumberUniform(vignette, 'offset', POST.vignetteOffset);
      setNumberUniform(vignette, 'darkness', POST.vignetteDarkness);
      this.composer.addPass(vignette);
      this.effects.push(vignette);
    }
  }

  /**
   * 渲染一帧。
   *
   * 相机要每帧传进来:`World.camera` 在 chase 和固定机位之间切换,返回的是不同的
   * 相机对象,pass 里存的那个引用不会自己跟着换。
   */
  /**
   * 只给 `?bloom=` 这个调试开关用。定稿的值仍然只住在 `tuning.ts` 里。
   *
   * 逆光强度已经被人类打回来三次,每次「再收一档」都要重新 build + shoot
   * 才能和上一版对比。有了它,一次构建就能拍完两档。
   */
  setBloomStrength(strength: number): void {
    if (this.bloom !== null) {
      this.bloom.strength = strength;
    }
  }

  /**
   * 每帧喂一次动态模糊的强度与扩张焦点。
   *
   * `speed01` 是归一化车速;`focusX/focusY` 是**速度方向在画面上的投影**
   * (uv,0..1),由 `main.ts` 用相机把它投出来 —— 钉死在屏幕中心的话过弯时
   * 模糊方向会明显不对(推导见 `gfx/motionBlur.ts`)。
   *
   * **强度为 0 时整级 pass 直接关掉**,而不是喂一个 0 进去:后者照样要跑一遍
   * 全屏采样,而慢速行驶和停车恰恰是最不该花这笔钱的时候。
   */
  setMotionBlur(speed01: number, focusX: number, focusY: number): void {
    const pass = this.motion;
    if (pass === null || !this.effectsOn) {
      return;
    }
    const strength = motionBlurStrength(speed01, this.reducedMotion);
    pass.enabled = strength > 0;
    if (!pass.enabled) {
      return;
    }
    setNumberUniform(pass, 'strength', strength);
    const focus = pass.uniforms['focus']?.value as Vector2 | undefined;
    focus?.set(focusX, focusY);
  }

  /**
   * 把一棵子树标成「会动的」,它才会进速度缓冲。**换车壳之后要再调一次**
   * (`World.upgradeCrafts()` 会把整批网格换掉)。重复调是空操作。
   */
  markMoving(roots: readonly Object3D[]): void {
    for (const root of roots) {
      this.velocity?.mark(root);
    }
  }

  /**
   * 每帧喂一次逐物体模糊的强度。和径向那一级一样,强度为 0 时整级关掉 ——
   * 这一级更值得关,因为它还连着一次额外的场景渲染。
   */
  setObjectMotionBlur(speed01: number): void {
    const pass = this.objectMotion;
    if (pass === null || !this.effectsOn) {
      return;
    }
    const strength = objectMotionStrength(speed01);
    pass.enabled = strength > 0;
    if (pass.enabled) {
      setNumberUniform(pass, 'strength', strength * POST.objectMotionShutter);
    }
  }

  /**
   * 整批开关后处理效果。**给动态画质调节用(`core/perfGovernor.ts`)**,
   * 是最后一档才动的杠杆 —— 前面几档先降分辨率,理由见 `PERF.levels`。
   *
   * `RenderPass` 和 `OutputPass` 不在里面:前者是画面本身,后者做 ACES +
   * sRGB,关掉画面会直接变成一片过曝的线性值,那不是"省一点",是坏掉。
   */
  setEffectsEnabled(on: boolean): void {
    this.effectsOn = on;
    for (const pass of this.effects) {
      pass.enabled = on;
    }
  }

  render(camera: PerspectiveCamera): void {
    this.renderPass.camera = camera;
    if (this.gtao !== null) {
      this.gtao.camera = camera;
    }
    // 速度缓冲要在主渲染之前画:模糊那一级读的是这一帧的速度。
    // pass 关着的时候连这一遍都不画 —— 它是这一级真正的成本所在。
    if (this.objectMotion?.enabled === true) {
      this.velocity?.render(this.renderer, this.scene, camera);
    }
    this.composer.render();
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    /*
     * **必须显式转告 composer 当前的 pixelRatio。**
     *
     * `EffectComposer` 在**构造时**把 `renderer.getPixelRatio()` 抄进
     * `_pixelRatio` 就再也不看了,`setSize()` 只按这个抄下来的值算渲染目标。
     * 所以动态画质调节改 `renderer.setPixelRatio()` 之后,如果不补这一句,
     * 渲染目标**尺寸一点没变** —— 省下的只有最后那一次贴到画布的 blit。
     *
     * 这个坑是量出来的:降到最低档实测只快了 17%,而按像素数算应该快得多;
     * 那 17% 全是"关掉后处理"带来的,分辨率那一档完全没生效。
     */
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
    this.applyEffectResolution();
    const ratio = this.renderer.getPixelRatio();
    this.velocity?.setSize(
      Math.round(width * ratio * POST.objectMotionResolutionScale),
      Math.round(height * ratio * POST.objectMotionResolutionScale),
    );
  }

  /**
   * AO 和 bloom 的自有渲染目标。**composer.setSize 会把每个 pass 都拉到全
   * 分辨率,所以缩放必须在它之后补。**
   *
   * 两者都是低频信号,半分辨率肉眼看不出来,省下的却是全屏的一半 fill ——
   * SwiftShader 上 fill 就是全部成本。
   *
   * 基准刻意用的是 **CSS 像素**而不是渲染像素:DPR 2 的屏上这等于 1/4 渲染
   * 分辨率,更省,而且照样看不出来。但要夹住上限 —— 动态画质把 pixelRatio
   * 降到 1 以下时,不夹的话这两个目标会比主目标还大,白花钱。
   */
  private applyEffectResolution(): void {
    const ratio = this.renderer.getPixelRatio();
    const maxW = Math.max(1, Math.round(this.width * ratio));
    const maxH = Math.max(1, Math.round(this.height * ratio));
    const sized = (scale: number): [number, number] => [
      Math.min(maxW, Math.max(1, Math.round(this.width * scale))),
      Math.min(maxH, Math.max(1, Math.round(this.height * scale))),
    ];
    this.gtao?.setSize(...sized(this.aoScale));
    this.bloom?.setSize(...sized(this.bloomScale));
  }


  dispose(): void {
    this.velocity?.dispose();
    this.composer.dispose();
  }
}

/**
 * 给 bloom 的高通阶段加一道输入钳制。
 *
 * 不加的话,**大多数 seed 会整屏变黑**:天空在太阳附近的辐射值能超出
 * `HalfFloatType` 的 65504 上限变成 Inf,高通之后被模糊核一摊,Inf/NaN 就顺着
 * mip 链污染整幅画面。而且 NaN 有传染性 —— `bloomStrength` 调成 0 也照样黑,
 * 因为 `0 * NaN` 还是 NaN。
 *
 * 这个坑之所以差点漏过去:`npm run shoot` 的默认 seed 是 42,而 42 恰好是少数
 * 不溢出的 seed 之一。所有回归截图都正常,只有实时模式(默认 seed 1337)黑屏。
 * **换 seed 复核,不要只信默认那一张。**
 *
 * 改高通 shader 而不是插一个钳制 pass:后者在 SwiftShader 上要多花约 45 ms/帧,
 * 而这里是零成本 —— 高通本来就要采样这张图。
 */
function clampBloomInput(bloom: UnrealBloomPass): void {
  const material = bloom.materialHighPassFilter;
  const anchor = 'vec4 texel = texture2D( tDiffuse, vUv );';
  if (!material.fragmentShader.includes(anchor)) {
    throw new Error('LuminosityHighPassShader 变了,bloom 的钳制补丁没打上');
  }
  // NaN 参与的比较恒为 false,所以 lessThanEqual 同时挡掉了 NaN 和 Inf。
  material.fragmentShader = material.fragmentShader.replace(
    anchor,
    [
      'vec4 rawTexel = texture2D( tDiffuse, vUv );',
      'vec4 texel = mix(',
      '  vec4( 0.0 ),',
      `  min( rawTexel, vec4( ${POST.bloomInputCeiling.toFixed(1)} ) ),`,
      '  vec4( lessThanEqual( rawTexel, vec4( 1e10 ) ) )',
      ');',
    ].join('\n'),
  );
  material.needsUpdate = true;
}

/** `noUncheckedIndexedAccess` 下 uniform 查表返回可空,统一在这里判一次。 */
function setNumberUniform(pass: ShaderPass, name: string, value: number): void {
  const uniform = pass.uniforms[name];
  if (uniform === undefined) {
    throw new Error(`shader 没有 uniform "${name}",three 版本可能变了`);
  }
  uniform.value = value;
}
