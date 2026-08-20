import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector2,
} from 'three';
import type { Course } from '../game/course';
import type { Rng } from '../core/rng';
import type { Palette } from './palette';
import { createSurfaceTextures } from './textures';

/** 边线条纹的宽度,占外缘半宽的比例。 */
const EDGE_STRIPE = 0.06;
/** 护栏高度(米)与厚度。 */
const RAIL_HEIGHT = 1.6;
/** 起跑线覆盖多少个中心线采样。 */
const START_LINE_ROWS = 3;

/**
 * 赛道条带、边线、路肩、护栏、起跑线。
 *
 * 几何体全部来自 `Course.buildRibbonTriangles()`,和物理查询共用同一份顶点表 ——
 * 一旦这里自己算一套,车就会浮在路面上方或者陷进侧倾里。
 */
export function createTrackMesh(course: Course, rng: Rng, palette: Palette): Group {
  const group = new Group();
  group.name = 'track';
  group.add(createRibbon(course, rng, palette));
  group.add(createGuardrails(course, palette));
  return group;
}

function createRibbon(course: Course, rng: Rng, palette: Palette): Mesh {
  const { positions, normals, uvs, lateral } = course.buildRibbonTriangles();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  // 用条带网格算出的平滑法线,不要 computeVertexNormals 的面法线 ——
  // 面法线会让路面变成一段段折面,法线贴图再细也盖不住。
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));

  const triangles = positions.length / 9;
  const colors = new Float32Array(triangles * 9);
  const tint = new Color();

  // 归一化的路面/路肩分界。lateral 是 -1..1,覆盖含路肩的外缘半宽。
  const roadEdge = course.halfWidth / course.outerHalfWidth;
  const rowTriangles = triangles / course.layout.samples.length;

  for (let t = 0; t < triangles; t++) {
    const side = Math.abs(lateral[t] ?? 0);
    const row = Math.floor(t / rowTriangles);

    // 顶点色在这里是**贴图的乘数**:路面本身由沥青贴图决定,顶点色只负责
    // 区分标线、路肩和起跑线。所以基准值是 1 而不是某个颜色。
    if (row < START_LINE_ROWS && side < roadEdge) {
      tint.copy(palette.startLine);
    } else if (side > roadEdge + EDGE_STRIPE) {
      tint.copy(palette.shoulder);
    } else if (side > roadEdge - EDGE_STRIPE) {
      tint.copy(palette.roadEdge);
    } else {
      tint.setRGB(1, 1, 1);
    }

    tint.multiplyScalar(1 + rng.range(-0.03, 0.03));
    for (let v = 0; v < 3; v++) {
      const o = (t * 3 + v) * 3;
      colors[o] = tint.r;
      colors[o + 1] = tint.g;
      colors[o + 2] = tint.b;
    }
  }

  geometry.setAttribute('color', new BufferAttribute(colors, 3));

  const textures = createSurfaceTextures(rng, palette.roadSurface);
  const mesh = new Mesh(
    geometry,
    new MeshStandardMaterial({
      map: textures.map,
      normalMap: textures.normalMap,
      roughnessMap: textures.roughnessMap,
      normalScale: new Vector2(0.8, 0.8),
      vertexColors: true,
      metalness: 0.02,
    }),
  );
  mesh.name = 'track-ribbon';
  return mesh;
}

/**
 * 两侧护栏。竖直的窄带,贴着条带外缘走。
 *
 * 它不参与碰撞(M2 不做碰撞响应),存在的意义是给驾驶员一条**看得见的边界** ——
 * 没有它,高速下根本判断不出赛道从哪里拐弯。
 */
function createGuardrails(course: Course, palette: Palette): Mesh {
  const samples = course.layout.samples;
  const count = samples.length;
  const positions = new Float32Array(count * 2 * 6 * 3);
  let o = 0;

  const push = (x: number, y: number, z: number): void => {
    positions[o++] = x;
    positions[o++] = y;
    positions[o++] = z;
  };

  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? -1 : 1;
    for (let i = 0; i < count; i++) {
      const a = samples[i];
      const b = samples[(i + 1) % count];
      if (a === undefined || b === undefined) {
        continue;
      }

      const ax = a.x - a.tangentZ * course.outerHalfWidth * sign;
      const az = a.z + a.tangentX * course.outerHalfWidth * sign;
      const bx = b.x - b.tangentZ * course.outerHalfWidth * sign;
      const bz = b.z + b.tangentX * course.outerHalfWidth * sign;
      const ay = a.y + sign * course.outerHalfWidth * Math.tan(a.bank) * 0.5;
      const by = b.y + sign * course.outerHalfWidth * Math.tan(b.bank) * 0.5;

      // 两个三角组成一片竖直的矩形。材质是双面的,所以不用按左右侧分绕序 ——
      // 分绕序的话有一侧的法线会背着光,两条护栏明暗对不上,看着像 bug。
      push(ax, ay, az);
      push(bx, by, bz);
      push(ax, ay + RAIL_HEIGHT, az);
      push(bx, by, bz);
      push(bx, by + RAIL_HEIGHT, bz);
      push(ax, ay + RAIL_HEIGHT, az);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.computeVertexNormals();

  const mesh = new Mesh(
    geometry,
    new MeshStandardMaterial({
      color: palette.guardrail,
      side: DoubleSide,
      flatShading: true,
      roughness: 0.5,
      metalness: 0.3,
      emissive: palette.guardrail,
      emissiveIntensity: 0.22,
    }),
  );
  mesh.name = 'guardrail';
  return mesh;
}
