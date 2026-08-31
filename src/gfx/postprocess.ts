import { type PerspectiveCamera, type Scene, Vector2, type WebGLRenderer } from 'three';
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

/** 可单独开关的环节。`?post=` 按名字启用,量各级成本、诊断画面问题都靠它。 */
export type PostStage = 'ao' | 'bloom' | 'smaa' | 'vignette';

export const ALL_STAGES: readonly PostStage[] = ['ao', 'bloom', 'smaa', 'vignette'];

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
export const DEFAULT_STAGES: readonly PostStage[] = ['bloom', 'smaa', 'vignette'];

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
  /** 除 RenderPass / OutputPass 之外的所有 pass,给 `setEffectsEnabled()` 整批开关。 */
  private readonly effects: Pass[] = [];
  private readonly aoScale: number;
  private readonly bloomScale: number;
  private readonly renderer: WebGLRenderer;
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
   * 整批开关后处理效果。**给动态画质调节用(`core/perfGovernor.ts`)**,
   * 是最后一档才动的杠杆 —— 前面几档先降分辨率,理由见 `PERF.levels`。
   *
   * `RenderPass` 和 `OutputPass` 不在里面:前者是画面本身,后者做 ACES +
   * sRGB,关掉画面会直接变成一片过曝的线性值,那不是"省一点",是坏掉。
   */
  setEffectsEnabled(on: boolean): void {
    for (const pass of this.effects) {
      pass.enabled = on;
    }
  }

  render(camera: PerspectiveCamera): void {
    this.renderPass.camera = camera;
    if (this.gtao !== null) {
      this.gtao.camera = camera;
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
