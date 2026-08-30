import {
  Box3,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { CAR, CRAFT } from '../game/tuning';
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
 * ## 坐标系
 *
 * 模型是 **Z 轴朝上、车头朝 −Y**(Blender 约定),这个项目是 Y 轴朝上、
 * 车头朝 +Z。所以载入时要绕 X 轴转 −90°。另外模型的轴距 2.80 m / 轮距
 * 1.95 m 都比物理用的(2.60 / 1.60)大,X 与 Y 分别按各自的比例缩放,
 * 让**轮子正好落在物理算出来的位置上** —— 否则轮子会浮在轮眉外面。
 */

/** 载入并烘焙好的模板。四个轮子的几何已经各自移到原点,方便绕自己的轴转。 */
interface Template {
  readonly body: Mesh[];
  readonly wheels: Mesh[][];
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

  // 模型原点在地面,本项目原点在轮心平面 —— 差值就是车身要下移的量。
  const bodyDrop = CAR.wheelRadius - CAR.suspensionRest - MODEL_WHEEL_CENTRE * wheelBaseScale;

  const body: Mesh[] = [];
  const wheels: Mesh[][] = [[], [], [], []];
  const tailLights: Mesh[] = [];
  const centre = new Vector3();
  const bake = new Matrix4();

  scene.traverse((child) => {
    if (!(child instanceof Mesh)) {
      return;
    }
    const wheelIndex = wheelIndexOf(child);
    const mesh = new Mesh(child.geometry.clone(), child.material);
    // 把节点的世界变换和「模型 → 本项目」一起烘进几何,之后整棵树就是平的,
    // 轮子可以随便重新分组而不用担心嵌套变换。
    bake.multiplyMatrices(toWorld, child.matrixWorld);
    mesh.geometry.applyMatrix4(bake);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    if (wheelIndex >= 0) {
      wheels[wheelIndex]?.push(mesh);
    } else {
      // 车身整体下移,让模型的轮心平面对上本项目的轮心高度。
      mesh.geometry.translate(0, bodyDrop, 0);
      body.push(mesh);
      if (/taillight/i.test(child.name)) {
        tailLights.push(mesh);
      }
    }
  });

  // 每个轮子的几何移到原点,这样绕自己的轴转就是转向/滚转,而不是绕车身转。
  for (const group of wheels) {
    if (group.length === 0) {
      continue;
    }
    const box = new Box3();
    for (const mesh of group) {
      mesh.geometry.computeBoundingBox();
      const b = mesh.geometry.boundingBox;
      if (b !== null) {
        box.union(b);
      }
    }
    box.getCenter(centre);
    for (const mesh of group) {
      mesh.geometry.translate(-centre.x, -centre.y, -centre.z);
    }
  }

  template = { body, wheels, tailLights };
}

/** 模型自带的轴距/轮距(米),量自节点位置,用来反解缩放比例。 */
const MODEL_WHEEL_BASE = 2.8;
const MODEL_TRACK = 1.952;
/**
 * 模型里轮心离地的高度(模型空间的 Z,也就是本项目的 Y)。
 *
 * 模型的原点在**地面**上,而本项目的车身局部原点在**轮心平面**上
 * (`setWheel` 把轮心放到 `wheelRadius − suspensionLength` = −0.11)。不做这
 * 个对齐,车身会整整浮在轮子上方半米 —— 第一次截图就是这个样子。
 */
const MODEL_WHEEL_CENTRE = 0.384;

/**
 * 网格属于哪个轮子。索引顺序和 `vehicle.ts` 的 `makeWheel` 一致:
 * 0=前 +X,1=前 −X,2=后 +X,3=后 −X。
 *
 * 模型里 L/R 的命名对应 ±X:`WheelFrontL` 在 +X 侧(实测节点坐标 x=+0.975)。
 */
function wheelIndexOf(mesh: Mesh): number {
  let node: { name: string; parent: unknown } | null = mesh as unknown as {
    name: string;
    parent: unknown;
  };
  while (node !== null && typeof node.name === 'string') {
    const name = node.name;
    if (/^WheelFront/i.test(name)) {
      return /L/i.test(name.slice(10)) ? 0 : 1;
    }
    if (/^WheelRear/i.test(name)) {
      return /L/i.test(name.slice(9)) ? 2 : 3;
    }
    node = node.parent as { name: string; parent: unknown } | null;
  }
  return -1;
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
  };
}
