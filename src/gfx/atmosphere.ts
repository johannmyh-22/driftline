import {
  DirectionalLight,
  type IUniform,
  type Mesh,
  PMREMGenerator,
  Scene,
  type Texture,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { Rng } from '../core/rng';
import { SKY } from '../game/tuning';

/**
 * 大气散射天空 + 由它生成的环境贴图(IBL)。
 *
 * 这是整个写实方向里性价比最高的一块。渐变色卡的天空一眼假,而 Preetham 模型
 * 把瑞利/米氏散射算出来,天空的颜色梯度、地平线的浑浊、太阳周围的辉光都对得上
 * 真实大气。更关键的是**把这片天空烘成环境贴图喂给 PBR 材质** —— 金属和光滑
 * 表面开始反射真实的天空和地面,这一步比任何贴图都更能拉开「照片」和「插画」。
 *
 * 全程零素材文件:天空是 shader 算的,环境贴图是运行时从 shader 渲出来的。
 */
export class Atmosphere {
  readonly sky: Mesh;
  readonly sunDirection = new Vector3();
  readonly sunLight: DirectionalLight;

  private environmentTexture: Texture | null = null;

  constructor(rng: Rng) {
    const elevation = rng.range(SKY.elevationMin, SKY.elevationMax);
    const azimuth = rng.range(SKY.azimuthMin, SKY.azimuthMax);

    const sky = new Sky();
    // Sky 是个巨大的盒子,要罩住整个可视范围;它自身不写深度,永远在最里层。
    sky.scale.setScalar(450_000);
    sky.name = 'atmosphere';

    const uniforms: Record<string, IUniform> = sky.material.uniforms;
    setUniform(uniforms, 'turbidity', SKY.turbidity);
    setUniform(uniforms, 'rayleigh', SKY.rayleigh);
    setUniform(uniforms, 'mieCoefficient', SKY.mieCoefficient);
    setUniform(uniforms, 'mieDirectionalG', SKY.mieDirectionalG);

    // 球面角转方向。仰角从天顶算起,所以用 90 - elevation。
    const phi = ((90 - elevation) * Math.PI) / 180;
    const theta = (azimuth * Math.PI) / 180;
    this.sunDirection.setFromSphericalCoords(1, phi, theta);
    const sunPosition = uniforms['sunPosition'];
    if (sunPosition !== undefined && sunPosition.value instanceof Vector3) {
      sunPosition.value.copy(this.sunDirection);
    }

    clampSkyRadiance(sky);
    this.sky = sky;

    // 平行光要和天空里那颗太阳指向一致,否则影子方向和天空对不上,一眼假。
    this.sunLight = new DirectionalLight(0xffffff, SKY.sunIntensity);
    this.sunLight.name = 'sun';
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(600);

    /*
     * 阴影相机只罩住载具周围一小块。
     *
     * 赛道横跨一千多米,用一张阴影图盖全场的话每个像素要负责好几米,
     * 车影会糊成一坨。跟着车走、只覆盖 SHADOW_EXTENT 米,阴影才够锐。
     * 远处没有投影 —— 那里本来也看不出有没有。
     */
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(SKY.shadowMapSize, SKY.shadowMapSize);
    const shadowCamera = this.sunLight.shadow.camera;
    shadowCamera.left = -SKY.shadowExtent;
    shadowCamera.right = SKY.shadowExtent;
    shadowCamera.top = SKY.shadowExtent;
    shadowCamera.bottom = -SKY.shadowExtent;
    shadowCamera.near = 1;
    shadowCamera.far = 1400;
    shadowCamera.updateProjectionMatrix();
    // 低仰角太阳下,影子在接触点附近容易出现自遮挡条纹,normalBias 比 bias 更稳。
    this.sunLight.shadow.normalBias = 0.06;
    this.sunLight.shadow.bias = -0.0004;
  }

  /**
   * 把天空烘成环境贴图。**必须在渲染器就绪后调用。**
   *
   * 只烘一次:天空是静态的,每帧重烘会直接吃掉几十毫秒。
   */
  buildEnvironment(renderer: WebGLRenderer): Texture {
    const generator = new PMREMGenerator(renderer);
    // 单独用一个只装天空的场景,免得把赛道和车也烘进反射里。
    const scene = new Scene();

    // three 里一个对象只能有一个父节点,add 会把天空从世界场景里摘走。
    // 烘完必须放回去,否则天上就是一片纯黑 —— 而且黑得很干净,乍看像
    // 「天空还没做」而不像 bug。
    const previousParent = this.sky.parent;
    scene.add(this.sky);

    const target = generator.fromScene(scene);
    generator.dispose();

    if (previousParent !== null) {
      previousParent.add(this.sky);
    } else {
      scene.remove(this.sky);
    }

    this.environmentTexture = target.texture;
    return target.texture;
  }

  /** 让阴影相机跟着载具走。每帧调用,不分配对象。 */
  followShadow(x: number, y: number, z: number): void {
    this.sunLight.target.position.set(x, y, z);
    this.sunLight.target.updateMatrixWorld();
    this.sunLight.position.set(
      x + this.sunDirection.x * 600,
      y + this.sunDirection.y * 600,
      z + this.sunDirection.z * 600,
    );
    this.sunLight.updateMatrixWorld();
  }

  dispose(): void {
    this.environmentTexture?.dispose();
    this.sky.geometry.dispose();
  }
}

/**
 * 给天空的输出加一道上限。
 *
 * **不加的话,太阳仰角一超过约 15 度,整个场景的光照就会消失。** 表现是天空正常、
 * 地面和赛道变成纯黑剪影 —— 看着像「地形没被照亮」,其实是 NaN。
 *
 * 链条是这样的:Preetham 模型在太阳附近的辐射值能到上千(shader 里 `EE = 1000`),
 * 太阳越高峰值越大;这片天空要被 `PMREMGenerator` 烘成环境贴图,而 PMREM 的
 * render target 是 `HalfFloatType`,上限 65504;一旦溢出成 Inf,后续的卷积就产出
 * NaN,整张环境贴图报废。**所有** PBR 材质采样到它之后输出 NaN,于是全黑。
 *
 * NaN 的传染性让这个问题格外难认:把 `environmentIntensity` 调成 0 也救不回来,
 * 因为 `0 * NaN` 还是 NaN —— 这一点和 bloom 那条钳制同源,见
 * `gfx/postprocess.ts` 的 `clampBloomInput()`。
 *
 * 钳制只削掉太阳盘那一小块的峰值,天空的颜色梯度、地平线的浑浊、太阳周围的辉光
 * 都不受影响 —— 那些区域的值离上限还远。
 */
function clampSkyRadiance(sky: Sky): void {
  const material = sky.material;
  const anchor = 'gl_FragColor = vec4( texColor, 1.0 );';
  if (!material.fragmentShader.includes(anchor)) {
    throw new Error('Sky 着色器变了,天空的辐射钳制补丁没打上');
  }
  material.fragmentShader = material.fragmentShader.replace(
    anchor,
    `gl_FragColor = vec4( min( texColor, vec3( ${SKY.radianceCeiling.toFixed(1)} ) ), 1.0 );`,
  );
  material.needsUpdate = true;
}

/** `noUncheckedIndexedAccess` 下 uniform 查表返回可空,统一在这里判一次。 */
function setUniform(uniforms: Record<string, IUniform>, name: string, value: number): void {
  const uniform = uniforms[name];
  if (uniform === undefined) {
    throw new Error(`Sky 着色器没有 uniform "${name}",three 版本可能变了`);
  }
  uniform.value = value;
}
