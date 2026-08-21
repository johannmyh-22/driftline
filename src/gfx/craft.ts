import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  Vector3,
} from 'three';
import type { Rng } from '../core/rng';
import { CRAFT } from '../game/tuning';
import type { Palette } from './palette';

type Point = readonly [number, number, number];
type Face = readonly [number, number, number];

/**
 * 手写的低多边形悬浮载具,车头朝 +Z。
 *
 * 每块都是凸的,所以绕序不用逐面手算:统一按「法线要背离该块的重心」
 * 自动翻正。手写十几个面的 winding 是纯粹的抄写错误来源。
 */
export interface Craft {
  readonly group: Group;
  /**
   * 尾焰强度,0..1。0 是滑行,1 是全速全油门。
   *
   * 只改亮度、不改几何:THRUSTER_POINTS 是车尾的局部坐标,拿 scale 拉长会把它
   * 拽向原点、穿进车身里。
   */
  setThrust(level: number): void;
}

export function createCraft(rng: Rng, palette: Palette): Craft {
  const group = new Group();
  group.name = 'craft';

  group.add(
    flatPart(HULL_POINTS, HULL_FACES, palette.craftHull, rng, {
      roughness: 0.38,
      metalness: 0.25,
      spread: 0.07,
    }),
  );

  for (const sign of [-1, 1]) {
    group.add(
      // 侧翼和车体一样是车漆,不是裸金属。metalness 0.6 那一版在强 IBL 下会
      // 反射出一块比尾焰还亮的白斑 —— 和车漆那条坑同源:金属度一高,基色就不再
      // 决定颜色、只决定反射色调,车身自己的颜色就没了。
      flatPart(mirrorX(FIN_POINTS, sign), FIN_FACES, palette.craftAccent, rng, {
        roughness: 0.32,
        metalness: 0.22,
        spread: 0.04,
      }),
    );
  }

  /*
   * 尾部亮条。除了「一眼看出车头朝哪」,它现在还是**速度反馈**的主要来源。
   *
   * 做法是把颜色推进 HDR 区间,让链上的 bloom 自己去决定辉光有多大 ——
   * 全速时超过 bloom 阈值就自然烧出光晕,松油门时落回阈值以下、辉光消失。
   * 零额外 pass,只动一个颜色。
   *
   * 注意这里**不能**再用 `toneMapped: false`:色调映射已经搬到链末的 OutputPass,
   * 它对整张缓冲做,不看单个材质的这个标志 —— 留着只会误导下一个读代码的人。
   */
  const glow = new Color();
  const thrusterMaterials: MeshBasicMaterial[] = [];
  for (const sign of [-1, 1]) {
    const material = new MeshBasicMaterial({ color: palette.craftGlow });
    const thruster = new Mesh(
      geometryFrom(mirrorX(THRUSTER_POINTS, sign), THRUSTER_FACES),
      material,
    );
    thruster.name = 'craft-thruster';
    thrusterMaterials.push(material);
    group.add(thruster);
  }

  return {
    group,
    setThrust(level: number): void {
      const eased = Math.min(1, Math.max(0, level));
      const gain = CRAFT.thrusterIdleGain + (CRAFT.thrusterFullGain - CRAFT.thrusterIdleGain) * eased;
      glow.copy(palette.craftGlow).multiplyScalar(gain);
      for (const material of thrusterMaterials) {
        material.color.copy(glow);
      }
    },
  };
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

function mirrorX(points: readonly Point[], sign: number): Point[] {
  return points.map(([x, y, z]) => [x * sign, y, z] as Point);
}

// 车体:机首在 +Z,尾部在 -Z。数值是按「看得清姿态」调的,不是空气动力学。
const HULL_POINTS: readonly Point[] = [
  [0, 0.08, 2.95], // 0 机首
  [-0.86, 0.58, -0.3], // 1 上左
  [0.86, 0.58, -0.3], // 2 上右
  [-1.18, -0.3, -0.1], // 3 下左
  [1.18, -0.3, -0.1], // 4 下右
  [-0.74, 0.4, -2.15], // 5 尾上左
  [0.74, 0.4, -2.15], // 6 尾上右
  [-0.98, -0.26, -2.15], // 7 尾下左
  [0.98, -0.26, -2.15], // 8 尾下右
];

const HULL_FACES: readonly Face[] = [
  [0, 1, 2],
  [1, 5, 6],
  [1, 6, 2],
  [0, 3, 4],
  [3, 7, 8],
  [3, 8, 4],
  [0, 1, 3],
  [1, 5, 7],
  [1, 7, 3],
  [0, 2, 4],
  [2, 6, 8],
  [2, 8, 4],
  [5, 6, 8],
  [5, 8, 7],
];

// 尾翼:根部埋进车体内(y 低于车体上沿 0.5),不然从正面看就是两根悬空的天线。
const FIN_POINTS: readonly Point[] = [
  [0.6, 0.26, -0.75],
  [0.6, 0.26, -2.2],
  [0.6, 0.95, -2.05],
  [0.88, 0.26, -0.75],
  [0.88, 0.26, -2.2],
  [0.88, 0.95, -2.05],
];

const FIN_FACES: readonly Face[] = [
  [0, 1, 2],
  [3, 4, 5],
  [0, 1, 4],
  [0, 4, 3],
  [1, 2, 5],
  [1, 5, 4],
  [0, 2, 5],
  [0, 5, 3],
];

const THRUSTER_POINTS: readonly Point[] = [
  [0.18, 0.28, -2.16],
  [0.66, 0.28, -2.16],
  [0.66, -0.12, -2.16],
  [0.18, -0.12, -2.16],
  [0.42, 0.08, -2.5],
];

const THRUSTER_FACES: readonly Face[] = [
  [0, 1, 2],
  [0, 2, 3],
  [0, 1, 4],
  [1, 2, 4],
  [2, 3, 4],
  [3, 0, 4],
];
