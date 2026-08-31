import {
  Box3,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { CAR, CRAFT, MODEL_MATERIAL } from '../game/tuning';
import modelUrl from '../assets/car.glb?url';
import type { Palette } from './palette';
import type { Craft } from './craft';

/**
 * 从 glTF 载入的车辆造型。
 *
 * ## 这是项目里第二次、也是范围更大的一次「二进制破例」
 *
 * CLAUDE.md 的第一条硬约束是「不引入二进制资产」,原本只为 Rapier 的 wasm
 * 破过一次,而且那一节明确写着「**不破的是素材那一格**」。这次由人类在
 * 2026-08 直接拍板破掉素材那一格,理由是程序化几何做不出照片级车身外形
 * (那也是 CLAUDE.md 自己写明的天花板)。**破例的范围同样写死**:
 *
 * - 进仓库的只有 `src/assets/car.glb` **一个**文件。贴图、音效、字体一律
 *   仍然由代码生成 —— 「反正已经有 glb 了」不是理由。
 * - 解码器走 `node_modules`(meshopt 的解码器是一个内嵌 wasm 的 **JS 模块**),
 *   不往仓库里再放第二个二进制。这也是选 meshopt 而不是 Draco 的原因:
 *   Draco 小 100 KB 左右,但要额外往仓库或产物里塞独立的解码器文件。
 * - 程序化的 `craft.ts` **原样保留**并且仍然是回退路径:模型没载入成功时
 *   照常出程序化车,游戏不会因为一个素材文件挂掉。
 *
 * ## 模型的来源与授权
 *
 * Khronos glTF-Sample-Assets 的 `CarConcept`,**CC-BY-4.0**
 * (© 2024 Darmstadt Graphics Group GmbH,Eric Chadwick),署名见仓库根目录的
 * `THIRD_PARTY_LICENSES.md`。原始素材本身派生自一个 CC0 概念车。
 *
 * **Khronos 与 3D Commerce 的 logo 已经去掉** —— 那两个是商标,授权文件里
 * 明确排除在 CC-BY 之外。它们烤在**轮胎侧壁**的贴图上,处理脚本
 * (`scripts/buildCarModel.mjs`)把 `Tireside` 材质的 baseColor 贴图摘掉换成
 * 纯深色。这不是"顺手优化",是授权要求。
 *
 * ## 素材是展厅件,不是游戏件 —— 这决定了下面两组处理
 *
 * CarConcept 是 Khronos 3D Commerce 的**展厅/电商**素材:按摄影棚打光调的
 * 材质、按渲染器整棵树变换的层级。两件事都不能直接拿进实时赛车里用:
 *
 * 1. **材质**要压亮(见 `MODEL_MATERIAL` 与 `tuneMaterial()`)。
 * 2. **轮子**要按真轮轴重新分组(见 `initCraftModel()` 里的 pass 1)。
 */

/** 载入并烘焙好的模板。四个轮子的几何已经各自移到轮轴上,方便绕自己的轴转。 */
interface Template {
  readonly body: Mesh[];
  /** 跟着轮子一起滚的部分:轮辋、轮胎、刹车盘。 */
  readonly wheels: Mesh[][];
  /** 只跟着转向、**不**跟着滚的部分:刹车卡钳。 */
  readonly uprights: Mesh[][];
  readonly tailLights: Mesh[];
}

let template: Template | null = null;

/** 模型是否已经就绪。没就绪时 `craft.ts` 会回退到程序化造型。 */
export function isCraftModelReady(): boolean {
  return template !== null;
}

/**
 * 预载模型。**必须在造 `World` 之前 await**,和 `initPhysics()` 同一个位置、
 * 同一个理由:`createCraft()` 是同步的,而且测试模式要求场景一造好就能立刻
 * 逐帧步进,不能让第一帧去等一个网络请求。
 */
export async function initCraftModel(): Promise<void> {
  if (template !== null) {
    return;
  }
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(modelUrl);

  const scene = gltf.scene;
  scene.updateMatrixWorld(true);

  /*
   * 模型空间 → 本项目空间:**只缩放,不旋转。**
   *
   * 原始 glTF 的节点坐标确实是 Blender 的 Z 轴朝上(轮子的前后差在 Y 上、
   * 高度在 Z 上),但 glTF 的场景根节点自带一个 Z-up → Y-up 的旋转,
   * `GLTFLoader` 读出来的 `matrixWorld` 里已经包含它了。第一版在这上面又转了
   * 一次 −90°,结果车立起来了 —— 实测车身包围盒高 4.10 m(正常应该 1.1 m 上下),
   * 而截图里因为是从正后方看,竖着的车和趴着的车轮廓很接近,肉眼没看出来。
   * **是量出来的,不是看出来的。**
   *
   * 转完之后模型的车头正好朝 +Z,和本项目约定一致,所以这里只剩缩放。
   */
  const wheelBaseScale = CAR.wheelBase / MODEL_WHEEL_BASE;
  const trackScale = CAR.trackWidth / MODEL_TRACK;
  const toWorld = new Matrix4().makeScale(trackScale, wheelBaseScale, wheelBaseScale);

  /*
   * ## pass 1:拿四个轮子的**真轮轴**位置
   *
   * 上一版是把「一个轮子组里所有网格的并集包围盒中心」当轮轴用的,这假设
   * 组里的东西都绕轮轴对称。**实测不成立**:每个轮子节点下面挂着四个网格 ——
   * 轮辋、轮胎、刹车盘、**刹车卡钳**,而卡钳本来就是偏心的(它抱在刹车盘
   * 边缘上,不在轴心)。并集中心因此偏离轮轴,`roll.rotation.x` 一转,整个
   * 轮子就绕着一个偏心点公转 —— 人类看到的「前面的轮胎完全在放飞状态」。
   *
   * 现在直接用轮子根节点自己的世界坐标:那**就是**轮轴,不需要从几何反推。
   */
  const pivots: (Vector3 | null)[] = [null, null, null, null];
  scene.traverse((child) => {
    const index = wheelRootIndex(child.name);
    if (index >= 0) {
      pivots[index] = child.getWorldPosition(new Vector3()).applyMatrix4(toWorld);
    }
  });
  const axles = pivots.map((p) => {
    if (p === null) {
      // 抛出去而不是凑合:`main.ts` 会 catch 并回退到程序化造型,出一辆
      // 轮子乱飞的车比回退难查得多。
      throw new Error('craftModel: 模型里找不到四个轮子的根节点');
    }
    return p;
  });

  /*
   * 模型的轮距中点**不在原点上**:实测前轴 z=+1.486、后轴 z=−1.314(模型
   * 单位),中点偏了 0.086 m。而本项目的悬挂点是对称的 ±wheelBase/2。不补
   * 这个偏移,四个轮子会整体相对车身前移 8 cm —— 轮子不居中在轮眉里。
   * 上一版同样有这个偏差,只是被更显眼的「放飞」盖过去了。
   */
  const bodyOffset = new Vector3()
    .addVectors(axles[0] as Vector3, axles[3] as Vector3)
    .add(axles[1] as Vector3)
    .add(axles[2] as Vector3)
    .multiplyScalar(0.25);
  // 模型原点在地面,本项目原点在轮心平面 —— 高度差单独算,不用四轮平均的 x/z 那套。
  bodyOffset.y = (axles[0] as Vector3).y - (CAR.wheelRadius - CAR.suspensionRest);

  const body: Mesh[] = [];
  const wheels: Mesh[][] = [[], [], [], []];
  const uprights: Mesh[][] = [[], [], [], []];
  const tailLights: Mesh[] = [];
  const bake = new Matrix4();

  scene.traverse((child) => {
    if (!(child instanceof Mesh)) {
      return;
    }
    const slot = wheelSlotOf(child);
    const mesh = new Mesh(child.geometry.clone(), child.material);
    // 把节点的世界变换和「模型 → 本项目」一起烘进几何,之后整棵树就是平的,
    // 轮子可以随便重新分组而不用担心嵌套变换。
    bake.multiplyMatrices(toWorld, child.matrixWorld);
    mesh.geometry.applyMatrix4(bake);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    if (slot !== null) {
      // 移到轮轴上,这样绕自己的轴转就是转向/滚转,而不是绕车身转。
      const axle = axles[slot.index] as Vector3;
      mesh.geometry.translate(-axle.x, -axle.y, -axle.z);
      (slot.rolls ? wheels : uprights)[slot.index]?.push(mesh);
    } else {
      mesh.geometry.translate(-bodyOffset.x, -bodyOffset.y, -bodyOffset.z);
      body.push(mesh);
      if (/taillight/i.test(child.name)) {
        tailLights.push(mesh);
      }
    }
  });

  template = { body, wheels, uprights, tailLights };
}

/** 模型自带的轴距/轮距(米),量自节点位置,用来反解缩放比例。 */
const MODEL_WHEEL_BASE = 2.8;
const MODEL_TRACK = 1.952;

/**
 * 轮子根节点的名字 → 索引。索引顺序和 `vehicle.ts` 的 `makeWheel` 一致:
 * 0=前 +X,1=前 −X,2=后 +X,3=后 −X。
 *
 * 模型里 L/R 的命名对应 ±X:`WheelFrontL` 在 +X 侧(实测节点坐标 x=+0.975)。
 * 只认**根节点**(`WheelFrontL` 这一层),下面的 `WheelFrontLRim` 之类由
 * `wheelSlotOf()` 沿父链找回来。
 */
function wheelRootIndex(name: string): number {
  if (/^WheelFront[LR]$/i.test(name)) {
    return /L$/i.test(name) ? 0 : 1;
  }
  if (/^WheelRear[LR]$/i.test(name)) {
    return /L$/i.test(name) ? 2 : 3;
  }
  return -1;
}

/**
 * 网格属于哪个轮子、以及它跟不跟着轮子滚。
 *
 * **刹车卡钳(`BrakePad`)不滚。** 真车上卡钳是固定在转向节上的,只有刹车盘
 * 和轮辋在转;跟着滚会看见卡钳绕着轮心飞。上一版把它和轮辋一起塞进滚转节点,
 * 既转错了、又(通过并集包围盒)把整个轮子的旋转轴带偏。
 */
function wheelSlotOf(mesh: Mesh): { index: number; rolls: boolean } | null {
  let node: Object3D | null = mesh;
  let rolls = true;
  while (node !== null) {
    if (/BrakePad/i.test(node.name)) {
      rolls = false;
    }
    const index = wheelRootIndex(node.name);
    if (index >= 0) {
      return { index, rolls };
    }
    node = node.parent;
  }
  return null;
}

/**
 * 把展厅材质压成户外材质。
 *
 * 人类反馈「这个车有点过于闪亮了」。实测模型自带的参数就是一台镜面车:
 * 主车漆 `Paint 1 Carmine` 是 **clearcoat=1.0、clearcoatRoughness=0.0**
 * 叠在 metalness=1.0 / roughness=0.25 上;`Mirror` 的 roughness 干脆是 0,
 * `Rim2` 是 0.049。这些值在摄影棚里是对的 —— 光源可控、只有一两个柔光箱;
 * 放进整片天空的 IBL 里,每一处都在镜面反射天光,于是整台车在发光。
 *
 * 处理分两层,都在 `MODEL_MATERIAL` 里可调:
 *
 * - **所有**材质吃一个粗糙度下限,把 0 和 0.049 这种镜面值抬起来。
 * - 车漆额外单独设一套:清漆压到有光泽但不照人,金属度从 1.0 降下来 ——
 *   真实车漆是**介质**漆膜里掺金属片,不是一整块金属。
 *
 * **玻璃排除在外**:它靠 transmission 出效果,抬粗糙度会变成毛玻璃。
 */
function tuneMaterial(material: MeshStandardMaterial | MeshPhysicalMaterial): void {
  const isGlass =
    material instanceof MeshPhysicalMaterial && (material.transmission > 0 || material.opacity < 1);
  if (isGlass) {
    return;
  }
  material.roughness = Math.max(material.roughness, MODEL_MATERIAL.minRoughness);
  material.envMapIntensity = MODEL_MATERIAL.envMapIntensity;

  if (/^Paint/i.test(material.name)) {
    material.roughness = MODEL_MATERIAL.paintRoughness;
    material.metalness = MODEL_MATERIAL.paintMetalness;
    if (material instanceof MeshPhysicalMaterial) {
      material.clearcoat = MODEL_MATERIAL.paintClearcoat;
      material.clearcoatRoughness = MODEL_MATERIAL.paintClearcoatRoughness;
    }
  }
}

/** 用载入好的模型造一辆车。调用前必须 `isCraftModelReady()`。 */
export function createModelCraft(palette: Palette): Craft {
  const built = template;
  if (built === null) {
    throw new Error('createModelCraft: 模型还没载入,先 await initCraftModel()');
  }

  const group = new Group();
  group.name = 'craft';

  // 材质按车逐份克隆:三辆对手要各自换色,共用材质会一起变。
  const cloned = new Map<unknown, MeshPhysicalMaterial | MeshStandardMaterial>();
  const cloneMaterial = (source: unknown): MeshPhysicalMaterial | MeshStandardMaterial => {
    const hit = cloned.get(source);
    if (hit !== undefined) {
      return hit;
    }
    const material = (source as MeshStandardMaterial).clone();
    tuneMaterial(material);
    // 车漆按调色板上色;其余材质(轮胎/玻璃/卡钳)保持模型原样。
    if (/^Paint/i.test(material.name)) {
      material.color.copy(palette.craftHull);
    }
    cloned.set(source, material);
    return material;
  };

  const attach = (source: Mesh, parent: Group): Mesh => {
    const mesh = new Mesh(source.geometry, cloneMaterial(source.material));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };

  for (const mesh of built.body) {
    attach(mesh, group);
  }

  const tailMaterials: (MeshPhysicalMaterial | MeshStandardMaterial)[] = [];
  for (const mesh of built.tailLights) {
    tailMaterials.push(cloneMaterial(mesh.material));
  }

  const halfBase = CAR.wheelBase / 2;
  const halfTrack = CAR.trackWidth / 2;
  const layout: readonly (readonly [number, number])[] = [
    [halfTrack, halfBase],
    [-halfTrack, halfBase],
    [halfTrack, -halfBase],
    [-halfTrack, -halfBase],
  ];

  const steerNodes: Group[] = [];
  const rollNodes: Group[] = [];
  for (let i = 0; i < 4; i++) {
    const steer = new Group();
    const [x, z] = layout[i] ?? [0, 0];
    steer.position.set(x, 0, z);
    const roll = new Group();
    steer.add(roll);
    group.add(steer);
    steerNodes.push(steer);
    rollNodes.push(roll);
    for (const mesh of built.wheels[i] ?? []) {
      attach(mesh, roll);
    }
    for (const mesh of built.uprights[i] ?? []) {
      attach(mesh, steer);
    }
  }

  const glow = new Color();
  return {
    group,
    setThrust(level: number): void {
      const eased = Math.min(1, Math.max(0, level));
      const gain =
        CRAFT.thrusterIdleGain + (CRAFT.thrusterFullGain - CRAFT.thrusterIdleGain) * eased;
      glow.copy(palette.craftGlow).multiplyScalar(gain);
      for (const material of tailMaterials) {
        material.emissive?.copy(glow);
      }
    },
    setWheel(index: number, suspensionLength: number, steerAngle: number, rollAngle: number): void {
      const steer = steerNodes[index];
      const roll = rollNodes[index];
      if (steer === undefined || roll === undefined) {
        return;
      }
      // 和程序化造型同一条:轮心高度 = 轮半径 − 悬挂长度。
      steer.position.y = CAR.wheelRadius - suspensionLength;
      steer.rotation.y = steerAngle;
      roll.rotation.x = rollAngle;
    },
    dispose(): void {
      /*
       * **只释放材质,不碰几何。** 几何是 `template` 里那份烘焙好的模板,
       * 四辆车加幽灵共用同一批 `BufferGeometry`(`attach()` 传的就是
       * `source.geometry` 本身);在这里 dispose 掉,场上其他车会一起变成
       * 空网格。材质则是逐车 `clone()` 出来的(对手要各自换色),独占。
       */
      for (const material of cloned.values()) {
        material.dispose();
      }
    },
  };
}

/**
 * 四个轮子组的包围盒,只给测试用。
 *
 * **这一层验收是这次修 bug 补出来的。**「轮子绕偏心点公转」在静态截图里
 * 看不出来(轮子停在哪一帧都像是对的),第四十五节的教训「截图拦不住模型
 * 路径的问题」在这里第二次应验。所以改成量:每个轮子组烘焙完之后,包围盒
 * 中心必须落在原点(= 轮轴)上,尺寸必须接近 `2 × wheelRadius`。
 */
export function measureWheelBounds(): { centre: Vector3; size: Vector3 }[] {
  const built = template;
  if (built === null) {
    throw new Error('measureWheelBounds: 模型还没载入');
  }
  return built.wheels.map((group) => {
    const box = new Box3();
    for (const mesh of group) {
      mesh.geometry.computeBoundingBox();
      const b = mesh.geometry.boundingBox;
      if (b !== null) {
        box.union(b);
      }
    }
    return { centre: box.getCenter(new Vector3()), size: box.getSize(new Vector3()) };
  });
}
