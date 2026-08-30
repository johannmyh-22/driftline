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
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
      roughness: 0.34,
      metalness: 0.28,
      // 车身不抖色:24 边的连续曲面上再抖就是一身脏斑(见 PartOptions 注释)。
      spread: 0,
      smooth: true,
    }),
  );

  /*
   * 座舱走**深色玻璃**,不再用 accent 车漆色。
   *
   * 从车外看,真车的座舱主要就是一整片深色玻璃 —— 原来那块 accent 色的实心
   * 盒子是「像玩具车」的第二大来源。玻璃靠低粗糙度 + 高清漆反天空,配色反而
   * 不重要:反射出来的环境本身就在告诉你那是玻璃。
   */
  const cabin = loftSections(CABIN_SECTIONS);
  group.add(
    flatPart(cabin.points, cabin.faces, GLASS_COLOR, rng, {
      roughness: 0.06,
      metalness: 0.1,
      spread: 0,
      smooth: true,
      opacity: 0.72,
    }),
  );

  // 车顶盖:玻璃是半透明的,不加这块从上面能看穿到车里,反而更假。
  const roofShell = loftSections(ROOF_SECTIONS);
  group.add(
    flatPart(roofShell.points, roofShell.faces, palette.craftHull, rng, {
      roughness: 0.34,
      metalness: 0.28,
      spread: 0,
      smooth: true,
    }),
  );

  addWheelArches(group, palette, rng);
  addMirrors(group, palette, rng);
  addFrontFace(group, rng);

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

/**
 * 轮眉。**「像玩具车」最直接的一条**:原来的车身是平直的侧板,轮子就那么从
 * 板子底下探出来,像积木插了四个轮。真车的轮子是嵌在一圈翼子板开口里的。
 *
 * 用一段半环(自己放样,不引入 TorusGeometry —— 这里要的是扁的、贴着车身的
 * 弧,不是正圆管)。四个轮位各一片,略宽于轮胎,压在车身外表面上。
 */
function addWheelArches(parent: Group, palette: Palette, rng: Rng): void {
  // 只比轮胎大一点点:轮眉是贴着轮子的一圈翼子板边缘,不是罩在外面的挡泥板。
  const radius = CAR.wheelRadius * 1.13;
  const thickness = 0.035;
  const halfWidth = TIRE_WIDTH * 0.5;
  const steps = 12;

  for (const zSign of [1, -1]) {
    for (const xSign of [1, -1]) {
      const points: Point[] = [];
      const faces: Face[] = [];
      // 从前往后扫过 180°,每一步给内外两圈四个点(一个扁的弧形壳)。
      for (let i = 0; i <= steps; i++) {
        const angle = Math.PI * (i / steps);
        const cy = Math.sin(angle);
        const cz = Math.cos(angle);
        for (const r of [radius, radius + thickness]) {
          for (const w of [-halfWidth, halfWidth]) {
            points.push([w, cy * r, cz * r]);
          }
        }
      }
      for (let i = 0; i < steps; i++) {
        const a0 = i * 4;
        const b0 = (i + 1) * 4;
        // 四个侧面各连一圈,形成一段封闭的弧形壳。
        for (const [p, q] of [
          [0, 1],
          [1, 3],
          [3, 2],
          [2, 0],
        ] as const) {
          faces.push([a0 + p, a0 + q, b0 + p]);
          faces.push([a0 + q, b0 + q, b0 + p]);
        }
      }

      const arch = flatPart(points, faces, palette.craftHull, rng, {
        roughness: 0.34,
        metalness: 0.28,
        spread: 0,
        smooth: true,
      });
      // 埋进车身一点,只露出外侧那道边,才像翼子板开口而不是外挂件。
      arch.position.set(xSign * (HALF_W - 0.07), ARCH_Y, zSign * ARCH_Z);
      parent.add(arch);
    }
  }
}

/**
 * 车头:前大灯 + 下进气口。
 *
 * 和后视镜同理 —— **「有没有灯、有没有进气口」是人眼判断「车 / 玩具」的强
 * 信号**。原来的车头是一整片素色曲面,没有任何可读的面部特征,那正是"玩具车"
 * 观感的一部分。
 *
 * 大灯不用 `MeshBasicMaterial`(那是尾灯为了配合 bloom 才用的自发光);白天的
 * 前灯不亮,靠**低粗糙度的玻璃反射**读出来,和座舱玻璃是同一套逻辑。
 */
function addFrontFace(parent: Group, rng: Rng): void {
  const lamp: readonly Section[] = [
    { z: 0.06, halfWidth: 0.15, yBottom: -0.045, yTop: 0.045, chamfer: 0.03 },
    { z: -0.06, halfWidth: 0.16, yBottom: -0.05, yTop: 0.05, chamfer: 0.03 },
  ];
  for (const sign of [-1, 1]) {
    const g = loftSections(lamp);
    const light = flatPart(g.points, g.faces, HEADLIGHT_COLOR, rng, {
      roughness: 0.05,
      metalness: 0.15,
      spread: 0,
      smooth: true,
    });
    light.position.set(sign * 0.44, 0.06, 1.92);
    parent.add(light);
  }

  // 下进气口:一块压暗的横条,读作格栅。真车前脸最大的一块深色面积就是它。
  const intake: readonly Section[] = [
    { z: 0.05, halfWidth: 0.42, yBottom: -0.085, yTop: 0.085, chamfer: 0.04 },
    { z: -0.05, halfWidth: 0.44, yBottom: -0.09, yTop: 0.09, chamfer: 0.04 },
  ];
  const g = loftSections(intake);
  const grille = flatPart(g.points, g.faces, GRILLE_COLOR, rng, {
    roughness: 0.55,
    metalness: 0.1,
    spread: 0,
    smooth: true,
  });
  grille.position.set(0, -0.14, 1.94);
  parent.add(grille);
}

/**
 * 后视镜。两个很小的部件,但**「有没有后视镜」是人眼判断「这是车还是玩具」
 * 的一个强信号** —— 玩具车通常省掉它。
 */
function addMirrors(parent: Group, palette: Palette, rng: Rng): void {
  const shell: readonly Section[] = [
    { z: 0.055, halfWidth: 0.045, yBottom: -0.03, yTop: 0.035, chamfer: 0.02 },
    { z: -0.055, halfWidth: 0.05, yBottom: -0.035, yTop: 0.04, chamfer: 0.02 },
  ];
  const stalk: readonly Section[] = [
    { z: 0.02, halfWidth: 0.055, yBottom: -0.012, yTop: 0.012, chamfer: 0.008 },
    { z: -0.02, halfWidth: 0.055, yBottom: -0.012, yTop: 0.012, chamfer: 0.008 },
  ];

  for (const sign of [-1, 1]) {
    const s = loftSections(shell);
    const mirror = flatPart(s.points, s.faces, palette.craftHull, rng, {
      roughness: 0.34,
      metalness: 0.28,
      spread: 0,
      smooth: true,
    });
    mirror.position.set(sign * (HALF_W + 0.08), MIRROR_Y, MIRROR_Z);
    parent.add(mirror);

    const t = loftSections(stalk);
    const arm = flatPart(t.points, t.faces, palette.craftHull, rng, {
      roughness: 0.4,
      metalness: 0.2,
      spread: 0,
      smooth: true,
    });
    // 撑杆横过来把镜子接回车身。
    arm.rotation.y = Math.PI / 2;
    arm.position.set(sign * (HALF_W + 0.03), MIRROR_Y, MIRROR_Z);
    parent.add(arm);
  }
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

/**
 * 每个截面采样多少个点。
 *
 * 原来是 8 —— 一个八边形。**这是「像玩具车」最直接的来源**:车身横截面只有
 * 八条边,无论怎么打光都是硬邦邦的棱柱,真车的车身是连续曲面。提到 24 之后
 * 截面接近圆角矩形,配合平滑法线才有钣金的感觉。
 *
 * 代价是三角形数量涨了三倍(车身 ~1100 面)。四辆车也就四千多面,对这个
 * 场景可以忽略 —— 地形和赛道条带比它多一个数量级。
 */
const RING = 24;

/**
 * 圆角矩形截面上的第 `k` 个点(0..RING-1)。
 *
 * 用「超椭圆」的思路而不是直角加倒角:`chamfer` 越大越接近椭圆,越小越接近
 * 矩形,中间是连续过渡的圆角矩形。八点倒角盒子在角上只有一条斜边,而这里
 * 角上有好几个点,高光能沿着棱线连续滚过去,那正是钣金的样子。
 */
function ringPoint(s: Section, k: number): Point {
  const t = (k / RING) * Math.PI * 2;
  const cx = Math.cos(t);
  const cy = Math.sin(t);
  const halfHeight = (s.yTop - s.yBottom) / 2;
  const midY = (s.yBottom + s.yTop) / 2;
  // n 越大越方。chamfer 归一化到截面尺寸上,再映射成指数。
  const round = Math.min(0.95, s.chamfer / Math.max(0.001, Math.min(s.halfWidth, halfHeight)));
  const n = 2 / Math.max(0.08, round);
  const shape = (v: number): number => Math.sign(v) * Math.pow(Math.abs(v), 2 / n);
  return [s.halfWidth * shape(cx), midY + halfHeight * shape(cy), s.z];
}

function loftSections(sections: readonly Section[]): {
  points: readonly Point[];
  faces: readonly Face[];
} {
  const points: Point[] = [];
  for (const s of sections) {
    for (let k = 0; k < RING; k++) {
      points.push(ringPoint(s, k));
    }
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
  /**
   * 逐面明度抖动幅度。**低多边形时代的遗产** —— 那时候面少,不抖就糊成一整块。
   * 现在截面是 24 边的连续曲面,再抖就变成一身脏斑,车身传 0。
   */
  spread: number;
  /**
   * 平滑法线。车身钣金必须开:平面着色会把 24 边的截面重新变回一圈可见的
   * 棱面,等于白提分辨率。
   */
  smooth?: boolean;
  /** 透明度 —— 玻璃用。 */
  opacity?: number;
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

  const smooth = options.smooth === true;
  if (smooth) {
    // 放样出来的是非索引几何,逐顶点法线要按位置合并之后才平滑得起来。
    geometry.deleteAttribute('normal');
    const merged = mergeVertices(geometry, 1e-4);
    merged.computeVertexNormals();
    geometry.copy(merged);
  }

  const transparent = options.opacity !== undefined && options.opacity < 1;
  const mesh = new Mesh(
    geometry,
    // 车漆是「金属漆 + 清漆」的夹层,不是裸金属:纯 metalness=1 会反射成镀铬。
    // clearcoat 那一层薄而光滑的高光,才是「车漆」区别于「塑料」和「铁皮」的地方。
    new MeshPhysicalMaterial({
      vertexColors: true,
      flatShading: !smooth,
      roughness: options.roughness,
      metalness: options.metalness,
      clearcoat: 0.9,
      clearcoatRoughness: 0.06,
      transparent,
      opacity: options.opacity ?? 1,
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
/** 前大灯玻璃:白天不亮,靠低粗糙度反射读出来,不是自发光。 */
const HEADLIGHT_COLOR = new Color(0.62, 0.66, 0.72);
/** 前格栅:前脸上最大的一块深色面积。 */
const GRILLE_COLOR = new Color(0.02, 0.022, 0.026);
/** 深色玻璃。座舱靠反射而不是靠颜色读出「玻璃」,所以压得很暗。 */
const GLASS_COLOR = new Color(0.035, 0.045, 0.06);
/**
 * 轮眉圆心的高度,**必须和静止时的轮心同高**,弧才刚好罩住轮子上半圈。
 *
 * 第一版写死 0(车身局部原点),而轮心在 `wheelRadius − suspensionRest`
 * = −0.11 —— 高了 11 厘米,加上半径给大了,截图里就是四个悬在车头车尾的
 * 大黑箍。**这种错只有看图才发现得了**,几何本身没有任何不合法的地方。
 */
const ARCH_Y = CAR.wheelRadius - CAR.suspensionRest;
const MIRROR_Y = 0.30;
const MIRROR_Z = 0.72;

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

/**
 * 车顶壳。座舱是半透明玻璃,不盖一层实心车顶的话从上方能看穿到车里 ——
 * 空心的车比不透明的盒子更假。比座舱窄一圈,露出来的边就是 A/B/C 柱。
 */
const ROOF_SECTIONS: readonly Section[] = [
  { z: 0.28, halfWidth: 0.5, yBottom: ROOF - 0.1, yTop: ROOF - 0.02, chamfer: 0.07 },
  { z: -0.55, halfWidth: 0.54, yBottom: ROOF - 0.08, yTop: ROOF + 0.005, chamfer: 0.08 },
  { z: -1.05, halfWidth: 0.5, yBottom: ROOF - 0.18, yTop: ROOF - 0.11, chamfer: 0.07 },
];

/** 尾灯灯条。建在原点,由两个实例分别平移到左右。 */
const TAIL_LIGHT_SECTIONS: readonly Section[] = [
  { z: 0.03, halfWidth: 0.17, yBottom: -0.045, yTop: 0.045, chamfer: 0.02 },
  { z: -0.03, halfWidth: 0.17, yBottom: -0.045, yTop: 0.045, chamfer: 0.02 },
];
