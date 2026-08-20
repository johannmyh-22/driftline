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

    this.sky = sky;

    // 平行光要和天空里那颗太阳指向一致,否则影子方向和天空对不上,一眼假。
    this.sunLight = new DirectionalLight(0xffffff, SKY.sunIntensity);
    this.sunLight.name = 'sun';
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(600);
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

  dispose(): void {
    this.environmentTexture?.dispose();
    this.sky.geometry.dispose();
  }
}

/** `noUncheckedIndexedAccess` 下 uniform 查表返回可空,统一在这里判一次。 */
function setUniform(uniforms: Record<string, IUniform>, name: string, value: number): void {
  const uniform = uniforms[name];
  if (uniform === undefined) {
    throw new Error(`Sky 着色器没有 uniform "${name}",three 版本可能变了`);
  }
  uniform.value = value;
}
