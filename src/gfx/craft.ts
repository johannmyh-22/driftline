import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import type { Rng } from '../core/rng';
import { CAR, CRAFT } from '../game/tuning';
import type { Palette } from './palette';

type Point = readonly [number, number, number];
type Face = readonly [number, number, number];

/**
 * 程序化生成的车辆造型,车头朝 +Z。
 *
 * 每块都是**凸的(或至少相对自身重心是星形的)**,所以绕序不用逐面手算:
 * 统一按「法线要背离该块的重心」自动翻正。手写几十个面的 winding 是纯粹的
 * 抄写错误来源 —— 这个项目已经在「贴地阴影因为绕序反了整个消失」上栽过一次。
 *
 * 车身用**截面放样**(`loftSections`)而不是手列顶点表:车壳有三十多个面,
 * 手写索引表既容易错又改不动。放样只需要给几个 Z 站位的截面尺寸,面由代码生成。
 *
 * **所有尺寸都从 `CAR` 推,不写死。** 轮距/轴距/轮半径/悬挂行程是物理在用的
 * 同一组数,造型必须跟着它们走 —— 否则轮子会浮在地上或者陷进路面,而那种错
 * 只有看图才发现得了。
 */
export interface Craft {
  readonly group: Group;
  /**
   * 尾灯亮度,0..1。0 是滑行,1 是全速全油门。
   *
   * 只改亮度、不改几何:尾灯是车尾的局部坐标,拿 scale 拉长会把它拽向原点、
   * 穿进车身里。
   */
  setThrust(level: number): void;
  /**
   * 摆放一个车轮。**每帧四次,不许在这里分配对象。**
   *
   * @param index 与 `Vehicle.wheelViews` 同序:前右、前左、后右、后左
   * @param suspensionLength 悬挂长度(米),安装点到**接地点**
   * @param steerAngle 前轮转角(弧度,正 = 左);后轮传 0
   * @param rollAngle 累计滚转角(弧度)
   */
  setWheel(index: number, suspensionLength: number, steerAngle: number, rollAngle: number): void;
}

export function createCraft(rng: Rng, palette: Palette): Craft {
  const group = new Group();
  group.name = 'craft';

  const lower = loftSections(BODY_SECTIONS);
  group.add(
    flatPart(lower.points, lower.faces, palette.craftHull, rng, {
      roughness: 0.38,
      metalness: 0.25,
      spread: 0.05,
    }),
  );

  // 座舱用 accent 色:两段配色能让车身在远处也看得出前后朝向,而这台车没有
  // 任何贴图可以承担这件事。
  const cabin = loftSections(CABIN_SECTIONS);
  group.add(
    flatPart(cabin.points, cabin.faces, palette.craftAccent, rng, {
      roughness: 0.22,
      metalness: 0.2,
      spread: 0.03,
    }),
  );

  /*
   * 尾灯。**亮度机制原样保留了尾焰那一套**(见 `setThrust` 与 `CRAFT` 的注释):
   * 颜色推进线性 HDR,跨过 `POST.bloomThreshold` 时 bloom 自己烧出光晕,速度感
   * 就来自这个跨越。造型换成真车之后语义有点别扭(真车该是**刹车**点亮尾灯),
   * 但那是手感/表现的改动,不属于「造型」这个里程碑,留给人类决定。
   */
  const glow = new Color();
  const tailLightMaterials: MeshBasicMaterial[] = [];
  const tail = loftSections(TAIL_LIGHT_SECTIONS);
  for (const sign of [-1, 1]) {
    const material = new MeshBasicMaterial({ color: palette.craftGlow });
    const light = new Mesh(geometryFrom(tail.points, tail.faces), material);
    light.name = 'craft-taillight';
    light.position.set(sign * TAIL_LIGHT_X, TAIL_LIGHT_Y, TAIL_LIGHT_Z);
    tailLightMaterials.push(material);
    group.add(light);
  }

  const wheels = createWheels(group);

  return {
    group,
    setThrust(level: number): void {
      const eased = Math.min(1, Math.max(0, level));
      const gain = CRAFT.thrusterIdleGain + (CRAFT.thrusterFullGain - CRAFT.thrusterIdleGain) * eased;
      glow.copy(palette.craftGlow).multiplyScalar(gain);
      for (const material of tailLightMaterials) {
        material.color.copy(glow);
      }
    },
    setWheel(index: number, suspensionLength: number, steerAngle: number, rollAngle: number): void {
      const node = wheels[index];
      if (node === undefined) {
        return;
      }
      /*
       * 轮心高度 = 轮半径 − 悬挂长度。
       *
       * `suspensionLength` 是安装点到**接地点**的距离(vehicle.ts 阶段 1 就是
       * 这么定义的),而安装点恒在车身局部 y = 0。所以接地点在 y = −length,
       * 轮心再往上抬一个轮半径。**这条对错只有看图才发现得了** —— 写错就是
       * 轮子浮在路面上方或者陷进沥青里。
       */
      node.steer.position.y = CAR.wheelRadius - suspensionLength;
      node.steer.rotation.y = steerAngle;
      node.roll.rotation.x = rollAngle;
    },
  };
}

/** 一个车轮的两级节点:外层管转向(绕车身 Y),内层管滚转(绕轮轴 X)。 */
interface WheelNode {
  readonly steer: Group;
  readonly roll: Group;
}

/*
 * 四个轮子共用同一份几何与材质:三角形完全一样,分开建只是白占显存。
 * 材质不随主题变 —— 黑轮胎在哪个主题里都是黑的,所以它们不进 `palette`。
 *
 * **几何必须在这里建,不能提到模块作用域。** `rotateZ` 是就地改顶点的,而
 * `createCraft` 会被调用多次(每个 World 一次,测试里更多);共用一份模块级
 * 几何的话第二次调用会把它再转 90°,轮子就躺下了。
 */
function createWheels(parent: Group): readonly WheelNode[] {
  // 圆柱默认沿 Y 轴,绕 Z 转 90° 之后轴变成 X —— 也就是车的左右方向。
  const tireGeometry = new CylinderGeometry(CAR.wheelRadius, CAR.wheelRadius, TIRE_WIDTH, 20);
  // 比胎面宽一丝,轮辋端面才露得出来 —— 轮胎是实心圆柱,不露就整个是黑饼。
  const rimGeometry = new CylinderGeometry(RIM_RADIUS, RIM_RADIUS, TIRE_WIDTH * 1.02, 14);
  tireGeometry.rotateZ(Math.PI / 2);
  rimGeometry.rotateZ(Math.PI / 2);

  const tireMaterial = new MeshStandardMaterial({
    color: new Color(0.055, 0.055, 0.062),
    roughness: 0.88,
    metalness: 0,
  });
  /*
   * 轮辋**不能给高 metalness**。第一版给了 0.85 + roughness 0.3,在强 IBL 下
   * 直接反射天空、整个轮子烧成一块白饼,轮胎完全看不见 —— 这和第五节记的
   * 「车漆反射成磨砂玻璃」「侧翼是块比尾焰还亮的白斑」是**同一个坑,第三次**:
   * metalness 一高,基色就不再决定颜色、只决定反射色调。
   *
   * 真的铝合金轮毂是有涂层的,漫反射占大头。0.5 / 0.5 才是那个样子。
   */
  const rimMaterial = new MeshStandardMaterial({
    color: new Color(0.3, 0.31, 0.33),
    roughness: 0.5,
    metalness: 0.5,
  });

  const halfBase = CAR.wheelBase / 2;
  const halfTrack = CAR.trackWidth / 2;
  // 顺序必须与 vehicle.ts 的 wheels 数组一致:前右、前左、后右、后左。
  const layout: readonly (readonly [number, number])[] = [
    [halfTrack, halfBase],
    [-halfTrack, halfBase],
    [halfTrack, -halfBase],
    [-halfTrack, -halfBase],
  ];

  const nodes: WheelNode[] = [];
  for (const [x, z] of layout) {
    const steer = new Group();
    steer.name = 'craft-wheel';
    steer.position.set(x, 0, z);

    const roll = new Group();
    const tire = new Mesh(tireGeometry, tireMaterial);
    const rim = new Mesh(rimGeometry, rimMaterial);
    for (const mesh of [tire, rim]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    roll.add(tire);
    roll.add(rim);
    steer.add(roll);
    parent.add(steer);
    nodes.push({ steer, roll });
  }
  return nodes;
}

/**
 * 沿 Z 轴放样出一段壳体。
 *
 * 每个站位是一个**倒角矩形**(8 个点)。用放样而不是手列顶点表:车壳有几十个
 * 面,手写索引表既容易错又改不动,而这个项目已经在「绕序反了」上栽过一次。
 * 面由代码生成,朝向再交给 `geometryFrom` 按重心自动翻正。
 */
interface Section {
  z: number;
  halfWidth: number;
  yBottom: number;
  yTop: number;
  /** 上下棱的倒角。0 就是方盒,给一点点棱角才不像积木。 */
  chamfer: number;
}

const RING = 8;

function loftSections(sections: readonly Section[]): {
  points: readonly Point[];
  faces: readonly Face[];
} {
  const points: Point[] = [];
  for (const s of sections) {
    // 倒角不能吃掉整个截面,否则会自交成一个蝴蝶结。
    const cx = Math.min(s.chamfer, s.halfWidth * 0.9);
    const cy = Math.min(s.chamfer, (s.yTop - s.yBottom) * 0.45);
    points.push(
      [-s.halfWidth, s.yBottom + cy, s.z],
      [-s.halfWidth + cx, s.yBottom, s.z],
      [s.halfWidth - cx, s.yBottom, s.z],
      [s.halfWidth, s.yBottom + cy, s.z],
      [s.halfWidth, s.yTop - cy, s.z],
      [s.halfWidth - cx, s.yTop, s.z],
      [-s.halfWidth + cx, s.yTop, s.z],
      [-s.halfWidth, s.yTop - cy, s.z],
    );
  }

  const faces: Face[] = [];
  for (let i = 0; i + 1 < sections.length; i++) {
    const near = i * RING;
    const far = (i + 1) * RING;
    for (let k = 0; k < RING; k++) {
      const k2 = (k + 1) % RING;
      faces.push([near + k, near + k2, far + k]);
      faces.push([near + k2, far + k2, far + k]);
    }
  }

  // 两头封盖:从环上第 0 个点扇形展开。
  const last = (sections.length - 1) * RING;
  for (let k = 1; k + 1 < RING; k++) {
    faces.push([0, k, k + 1]);
    faces.push([last, last + k, last + k + 1]);
  }

  return { points, faces };
}

interface PartOptions {
  roughness: number;
  metalness: number;
  /** 逐面明度抖动幅度,低多边形的面才不会糊成一整块。 */
  spread: number;
}

function flatPart(
  points: readonly Point[],
  faces: readonly Face[],
  base: Color,
  rng: Rng,
  options: PartOptions,
): Mesh {
  const geometry = geometryFrom(points, faces);

  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const tint = new Color();
  for (let i = 0; i < position.count; i += 3) {
    tint.copy(base).offsetHSL(0, 0, rng.range(-options.spread, options.spread));
    for (let v = 0; v < 3; v++) {
      colors[(i + v) * 3] = tint.r;
      colors[(i + v) * 3 + 1] = tint.g;
      colors[(i + v) * 3 + 2] = tint.b;
    }
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));

  const mesh = new Mesh(
    geometry,
    // 车漆是「金属漆 + 清漆」的夹层,不是裸金属:纯 metalness=1 会反射成镀铬。
    // clearcoat 那一层薄而光滑的高光,才是「车漆」区别于「塑料」和「铁皮」的地方。
    new MeshPhysicalMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: options.roughness,
      metalness: options.metalness,
      clearcoat: 0.9,
      clearcoatRoughness: 0.06,
    }),
  );
  // 车身投影是唯一真实的高度参照,必须投也必须接(自阴影)。
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

const centroid = new Vector3();
const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
const edge1 = new Vector3();
const edge2 = new Vector3();
const normal = new Vector3();
const toFace = new Vector3();

function geometryFrom(points: readonly Point[], faces: readonly Face[]): BufferGeometry {
  centroid.set(0, 0, 0);
  for (const p of points) {
    centroid.x += p[0];
    centroid.y += p[1];
    centroid.z += p[2];
  }
  centroid.divideScalar(points.length);

  const positions = new Float32Array(faces.length * 9);
  let o = 0;

  for (const face of faces) {
    readPoint(points, face[0], a);
    readPoint(points, face[1], b);
    readPoint(points, face[2], c);

    edge1.subVectors(b, a);
    edge2.subVectors(c, a);
    normal.crossVectors(edge1, edge2);
    toFace.copy(a).add(b).add(c).divideScalar(3).sub(centroid);

    // 法线朝里就把后两个顶点对调,而不是回头去改常量表。
    const flip = normal.dot(toFace) < 0;
    const v1 = flip ? c : b;
    const v2 = flip ? b : c;

    o = write(positions, o, a);
    o = write(positions, o, v1);
    o = write(positions, o, v2);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function readPoint(points: readonly Point[], index: number, out: Vector3): void {
  const point = points[index];
  if (point === undefined) {
    throw new RangeError(`面引用了不存在的顶点 ${index}`);
  }
  out.set(point[0], point[1], point[2]);
}

function write(target: Float32Array, offset: number, v: Vector3): number {
  target[offset] = v.x;
  target[offset + 1] = v.y;
  target[offset + 2] = v.z;
  return offset + 3;
}

/*
 * 车身尺寸以**实车比例**为基准,不是随手捏的。
 *
 * 现有的 `CAR` 数值(车长 4.2 m、车宽 1.8 m、整备 1200 kg、纯后驱)几乎正好是
 * **Alpine A110** 的实车规格(4.205 × 1.798 m、约 1100 kg、中置后驱),所以造型
 * 按它那一类轻量中置跑车的比例来。**只借尺寸比例,不复制任何具体的品牌造型
 * 特征或标识。**
 *
 * 对齐到的几条实车比例:
 *   - 车高 ≈ 1.23 m(实车 1.252),约等于两个车轮直径 —— 这是「看起来像跑车」
 *     最关键的一条,第一版车高 1.0 m 配 0.25 m 离地间隙,读出来是跨界车。
 *   - 离地间隙 0.18 m。实车是 0.12,这里留厚一点是因为悬挂行程有 0.16 m,
 *     压到底时车身还要再降下去(0.18 − 0.16 = 0.02 m 余量)。
 *   - **轮拱处车身最宽(半宽 0.90 = 车宽的一半),轮胎外沿 0.905 与它齐平。**
 *     第一版车身中段最宽、轮拱处反而收进去,轮子看着像装在车侧面的脚轮。
 *     实车一律是翼子板鼓在轮子外面。
 *   - 溜背:车顶最高点在轴距中点稍后,之后一路斜下去收进车尾。
 *
 * 局部坐标系:**+Z 车头,+X 驾驶员左侧,y = 0 是悬挂安装点**(静止时离地
 * `CAR.suspensionRest` = 0.45 m,所以地面在 y = −0.45)。轮心静止时在
 * y = wheelRadius − suspensionRest = −0.11,轮顶在 y = +0.23。
 */

/** 轮胎宽度(米)。 */
const TIRE_WIDTH = 0.21;
/** 轮辋半径(米)。留出一圈胎壁,轮子才不像个实心饼。 */
const RIM_RADIUS = CAR.wheelRadius * 0.55;

/** 车身最大半宽 = 车宽的一半。轮拱就取这个值,让翼子板和轮胎外沿齐平。 */
const HALF_W = CAR.bodyWidth / 2;
/** 轮拱中心的 Z:必须等于车轮的 localZ,否则轮子不在轮眉里。 */
const ARCH_Z = CAR.wheelBase / 2;
/** 车身下沿(米)。见上面「离地间隙」那条,和悬挂行程绑着。 */
const SILL = -(CAR.suspensionRest - 0.18);
/** 车顶高度(米),对应实车车高约 1.23 m。 */
const ROOF = CAR.suspensionRest * 0.5 + 0.555;

/** 尾灯相对车身原点的位置。 */
const TAIL_LIGHT_X = 0.56;
const TAIL_LIGHT_Y = 0.12;
const TAIL_LIGHT_Z = -2.0;

const BODY_SECTIONS: readonly Section[] = [
  { z: 2.05, halfWidth: 0.62, yBottom: SILL + 0.07, yTop: 0.16, chamfer: 0.09 },
  { z: 1.7, halfWidth: 0.78, yBottom: SILL + 0.02, yTop: 0.24, chamfer: 0.11 },
  { z: ARCH_Z, halfWidth: HALF_W, yBottom: SILL + 0.01, yTop: 0.3, chamfer: 0.12 },
  { z: 0.55, halfWidth: 0.85, yBottom: SILL, yTop: 0.34, chamfer: 0.12 },
  { z: -0.55, halfWidth: 0.85, yBottom: SILL, yTop: 0.36, chamfer: 0.12 },
  { z: -ARCH_Z, halfWidth: HALF_W, yBottom: SILL + 0.01, yTop: 0.34, chamfer: 0.12 },
  { z: -1.75, halfWidth: 0.8, yBottom: SILL + 0.03, yTop: 0.3, chamfer: 0.11 },
  { z: -2.05, halfWidth: 0.66, yBottom: SILL + 0.09, yTop: 0.24, chamfer: 0.09 },
];

/*
 * 座舱。下沿 0.30 埋进主车身(主车身上沿 0.34~0.36),不然从侧面看是一块浮在
 * 车顶上的独立盒子。前风挡根部窄而低、车顶最高点在中后段、之后一路收进车尾 ——
 * 溜背的形状全靠这几个站位的 yTop 和 halfWidth 走出来。
 */
const CABIN_SECTIONS: readonly Section[] = [
  // 风挡根部尽量往前放:A 柱的倾角 = (车顶高 − 风挡根高) / 两个站位的 Z 距离。
  // 第一版根部在 z=0.62,只有 0.52 m 的进深撑 0.34 m 的高差,A 柱几乎是竖的。
  { z: 0.86, halfWidth: 0.5, yBottom: 0.3, yTop: 0.35, chamfer: 0.05 },
  { z: 0.1, halfWidth: 0.64, yBottom: 0.3, yTop: ROOF - 0.06, chamfer: 0.1 },
  { z: -0.55, halfWidth: 0.66, yBottom: 0.3, yTop: ROOF, chamfer: 0.1 },
  { z: -1.1, halfWidth: 0.62, yBottom: 0.3, yTop: ROOF - 0.12, chamfer: 0.09 },
  { z: -1.6, halfWidth: 0.52, yBottom: 0.3, yTop: 0.42, chamfer: 0.07 },
];

/** 尾灯灯条。建在原点,由两个实例分别平移到左右。 */
const TAIL_LIGHT_SECTIONS: readonly Section[] = [
  { z: 0.03, halfWidth: 0.17, yBottom: -0.045, yTop: 0.045, chamfer: 0.02 },
  { z: -0.03, halfWidth: 0.17, yBottom: -0.045, yTop: 0.045, chamfer: 0.02 },
];
