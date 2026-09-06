import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector2,
} from 'three';
import type { Course } from '../game/course';
import type { Rng } from '../core/rng';
import type { Palette } from './palette';
import { type PitLane, pitRowIndex, pitWallAtRow, rowWithin } from '../game/pitLane';
import { createSurfaceTextures } from './textures';
import { clamp, lerp } from '../core/mathx';
import { WEATHER } from '../game/tuning';

/** 边线条纹的宽度,占外缘半宽的比例。 */
const EDGE_STRIPE = 0.06;

/** 顶点色当贴图乘数用时的中性值。 */
const WHITE = new Color().setRGB(1, 1, 1);
/**
 * 混凝土护墙的横截面,单位米。
 * `out` = 从条带外缘向外的横向距离,`up` = 从外缘顶点起算的高度。
 *
 * 这是 Jersey barrier 的剖面:底缘竖直一小段,中段 55° 斜面(真实作用是把
 * 蹭上来的车「托」回赛道而不是直接拦停),上段近垂直,顶上一道压顶。
 * 剖面从最靠近赛道的底缘起,绕到外侧落地为止 —— 底面朝下看不见,不画。
 */
const WALL_PROFILE: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 0.08],
  [0.18, 0.34],
  [0.25, 0.98],
  [0.25, 1.08],
  [0.55, 1.08],
  [0.55, 0],
];

/** 顶面那一段在剖面里的下标(`WALL_PROFILE[4] → [5]`),用来单独上压顶色。 */
const WALL_TOP_SEGMENT = 4;

/** 预制段长度(米)。真实护墙是一段段拼的,接缝是最省的「这不是一整块」的线索。 */
const WALL_SEGMENT_LENGTH = 12;
/** 起跑线覆盖多少个中心线采样。 */
const START_LINE_ROWS = 3;

/**
 * 赛道条带、边线、路肩、护栏、起跑线。
 *
 * 几何体全部来自 `Course.buildRibbonTriangles()`,和物理查询共用同一份顶点表 ——
 * 一旦这里自己算一套,车就会浮在路面上方或者陷进侧倾里。
 */
/**
 * `pit` 传进来就多铺一条维修道的路面,并且在隔离墙上开出入口/出口的缺口。
 * 传 null 就没有(`flat` 那块平地)。
 *
 * 路面上的标记一律用**顶点色**涂,不加贴片:路面本来就是靠顶点色区分标线 /
 * 路肩 / 起跑线的,多一块几何体既要对齐赛道侧倾又会 z-fighting。
 */
export function createTrackMesh(
  course: Course,
  rng: Rng,
  palette: Palette,
  pit: PitLane | null = null,
): Group {
  const group = new Group();
  group.name = 'track';
  group.add(createRibbon(course, rng, palette, pit));
  if (pit !== null) {
    group.add(createPitSurface(course, rng, palette, pit));
  }
  group.add(createGuardrails(course, rng, palette, pit));
  return group;
}

function createRibbon(course: Course, rng: Rng, palette: Palette, pit: PitLane | null): Mesh {
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
  const rowCount = course.layout.samples.length;
  const rowTriangles = triangles / rowCount;

  /*
   * 引道:隔离墙的两个缺口那一段,把**路肩**涂成维修道的颜色。
   *
   * 这是玩家唯一看得见的「从这里切出去」的线索 —— 缺口在墙上,而墙从赛车线
   * 上是看不出哪儿断的。判定和物理的走廊开口用的是同一批行号
   * (`pitRowIndex` + `pitWallAtRow`),差一行就会出现「看着能进、开过去撞墙」。
   */
  for (let t = 0; t < triangles; t++) {
    const side = Math.abs(lateral[t] ?? 0);
    const row = Math.floor(t / rowTriangles);

    // 顶点色在这里是**贴图的乘数**:路面本身由沥青贴图决定,顶点色只负责
    // 区分标线、路肩和起跑线。所以基准值是 1 而不是某个颜色。
    const signed = lateral[t] ?? 0;
    if (
      pit !== null &&
      signed > roadEdge &&
      pitRowIndex(pit, row) >= 0 &&
      !pitWallAtRow(pit, row)
    ) {
      tint.copy(palette.pitApron);
    } else if (row < START_LINE_ROWS && side < roadEdge) {
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
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * 维修道的路面。
 *
 * 几何体来自 `Course.buildPitTriangles()`,和物理查询共用同一份顶点表 ——
 * 和主条带同一条不变量。**必须让 `Course` 认识这条道**,不能只在这里画一块
 * 好看的路面:那样物理上它仍然是出界区,车开进去会被回收传送走。
 *
 * 上色分三档:内侧快车道、外侧车位区、以及车位本身。真实维修道就是这么分的,
 * 而且分开之后「停进车位」是一个横向动作,不是"停在道中间"。
 */
function createPitSurface(course: Course, rng: Rng, palette: Palette, pit: PitLane): Mesh {
  const { positions, normals, uvs, lateral, row } = course.buildPitTriangles();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));

  const triangles = positions.length / 9;
  const colors = new Float32Array(triangles * 9);
  const tint = new Color();

  // 快车道 / 车位区的分界,换算成 0..1 的归一化横向。
  const boxEdge = (pit.boxLateralMin - pit.lateralMin) / (pit.lateralMax - pit.lateralMin);

  for (let t = 0; t < triangles; t++) {
    const across = lateral[t] ?? 0;
    const trackRow = row[t] ?? 0;
    const inBoxRows = rowWithin(pit, pit.boxStartRow, pit.boxEndRow, trackRow);

    if (across >= boxEdge && inBoxRows) {
      tint.copy(palette.pitBox);
    } else if (across >= boxEdge) {
      tint.copy(palette.pitApron);
    } else {
      // 快车道留中性色,让沥青贴图自己说话 —— 它就是一段普通路面。
      tint.copy(WHITE);
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
  mesh.name = 'pit-surface';
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * 混凝土护墙:赛道两侧 + 维修道外缘。
 *
 * 存在的意义首先是给驾驶员一条**看得见的边界** —— 没有它,高速下根本判断不出
 * 赛道从哪里拐弯;车撞上去的响应在 `Vehicle.resolveWall()`,吃的是
 * `GroundHit.wallLeft/wallRight`,和这里的外观无关。
 *
 * 墙体沿 `Course.buildEdgeLine()` / `buildPitEdgeLine()` 给的**路面自己的外缘
 * 顶点**扫掠 —— 不要自己按 bank 另算一套高度,那样墙底和路肩对不上,远看就是
 * 一条浮在地上的带子。
 *
 * ## 维修道带来的两件事
 *
 * 1. **右侧护墙在维修道那一段兼作隔离墙**,而且两端要开缺口 —— 那是引道。
 *    缺口的行号和 `Course.sample()` 判走廊开口用的是同一个 `pitWallAtRow()`,
 *    **差一行就是一堵看不见的墙**。
 * 2. 维修道外缘另起一道墙,否则那条道没有可见边界,开出去就直接进了地形。
 *
 * 三段墙的行数不一样,所以缓冲区改成先收集再一次性转 Float32Array;这只在
 * 建场时跑一次,不在每帧路径上。
 */
function createGuardrails(course: Course, rng: Rng, palette: Palette, pit: PitLane | null): Mesh {
  const samples = course.layout.samples;
  const rows = samples.length;
  const segments = WALL_PROFILE.length - 1;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];

  // 剖面上每个点的累积弧长,拿来做 v 方向的 UV,贴图才不会在斜面上被拉伸。
  const profileArc = new Float64Array(WALL_PROFILE.length);
  for (let i = 1; i < WALL_PROFILE.length; i++) {
    const previous = WALL_PROFILE[i - 1] ?? [0, 0];
    const current = WALL_PROFILE[i] ?? [0, 0];
    profileArc[i] =
      (profileArc[i - 1] ?? 0) +
      Math.hypot((current[0] ?? 0) - (previous[0] ?? 0), (current[1] ?? 0) - (previous[1] ?? 0));
  }

  // 每个预制段给一点明暗差:真实护墙是一段段浇出来再拼起来的,批次之间对不齐。
  // 这比画一道接缝线便宜,粒度也正好落在采样间距上。
  const spacing = course.layout.spacing;
  const segmentCount = Math.max(1, Math.ceil((rows * spacing) / WALL_SEGMENT_LENGTH));
  const segmentShade = new Float32Array(segmentCount);
  for (let i = 0; i < segmentCount; i++) {
    segmentShade[i] = 1 + rng.range(-0.05, 0.05);
  }

  const tint = new Color();

  const push = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    shade: number,
  ): void => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    uvs.push(u, v);
    colors.push(tint.r * shade, tint.g * shade, tint.b * shade);
  };

  /**
   * 扫掠一段墙。
   *
   * `edge` 是墙底那条线(xyz 依次排列),`sampleOf(i)` 给出第 i 段用哪个中心线
   * 采样(墙的朝向跟着赛道切线转),`side` 决定墙往哪边长,`arcAt(i)` 是那一
   * 行的弧长(UV 和预制段明暗要用)。`count` 是要画多少段。
   */
  const sweep = (
    edge: Float64Array,
    count: number,
    side: -1 | 1,
    indexOf: (i: number) => number,
    sampleOf: (i: number) => { tangentX: number; tangentZ: number } | undefined,
    arcOf: (i: number) => number,
  ): void => {
    for (let i = 0; i < count; i++) {
      const here = sampleOf(i);
      const there = sampleOf(i + 1);
      if (here === undefined || there === undefined) {
        continue;
      }
      const a = indexOf(i);
      const b = indexOf(i + 1);

      // 向外 = 远离赛道中心。right 是 (-tangentZ, tangentX),乘 side 翻到对应一侧。
      const outHereX = -here.tangentZ * side;
      const outHereZ = here.tangentX * side;
      const outThereX = -there.tangentZ * side;
      const outThereZ = there.tangentX * side;

      const baseHereX = edge[a * 3] ?? 0;
      const baseHereY = edge[a * 3 + 1] ?? 0;
      const baseHereZ = edge[a * 3 + 2] ?? 0;
      const baseThereX = edge[b * 3] ?? 0;
      const baseThereY = edge[b * 3 + 1] ?? 0;
      const baseThereZ = edge[b * 3 + 2] ?? 0;

      const arcHere = arcOf(i);
      const arcThere = arcOf(i + 1);
      const uHere = arcHere / 4;
      const uThere = arcThere / 4;

      const shadeHere = segmentShade[Math.floor(arcHere / WALL_SEGMENT_LENGTH) % segmentCount] ?? 1;
      const shadeThere =
        segmentShade[Math.floor(arcThere / WALL_SEGMENT_LENGTH) % segmentCount] ?? 1;

      for (let k = 0; k < segments; k++) {
        const lo = WALL_PROFILE[k] ?? [0, 0];
        const hi = WALL_PROFILE[k + 1] ?? [0, 0];
        const dOut = (hi[0] ?? 0) - (lo[0] ?? 0);
        const dUp = (hi[1] ?? 0) - (lo[1] ?? 0);
        const length = Math.hypot(dOut, dUp) || 1;
        // 剖面段的 2D 外法线。(-dUp, dOut) 这个取向让内侧面朝赛道、顶面朝上。
        const nOut = -dUp / length;
        const nUp = dOut / length;

        // 横截面方向硬边、沿赛道方向平滑:法线在剖面上逐段给死,但 out 向量
        // 跟着切线转,所以弯道上不会出现 6 米一节的折面。
        const nHereX = outHereX * nOut;
        const nHereY = nUp;
        const nHereZ = outHereZ * nOut;
        const nThereX = outThereX * nOut;
        const nThereY = nUp;
        const nThereZ = outThereZ * nOut;

        // 顶面单独上色,其余留 1 让混凝土贴图自己说话。
        tint.copy(k === WALL_TOP_SEGMENT ? palette.wallCap : WHITE);

        const vLo = (profileArc[k] ?? 0) / 4;
        const vHi = (profileArc[k + 1] ?? 0) / 4;

        const aX = baseHereX + outHereX * (lo[0] ?? 0);
        const aY = baseHereY + (lo[1] ?? 0);
        const aZ = baseHereZ + outHereZ * (lo[0] ?? 0);
        const bX = baseThereX + outThereX * (lo[0] ?? 0);
        const bY = baseThereY + (lo[1] ?? 0);
        const bZ = baseThereZ + outThereZ * (lo[0] ?? 0);
        const cX = baseThereX + outThereX * (hi[0] ?? 0);
        const cY = baseThereY + (hi[1] ?? 0);
        const cZ = baseThereZ + outThereZ * (hi[0] ?? 0);
        const dX = baseHereX + outHereX * (hi[0] ?? 0);
        const dY = baseHereY + (hi[1] ?? 0);
        const dZ = baseHereZ + outHereZ * (hi[0] ?? 0);

        // 绕序必须分左右侧。两侧的 out 向量互为反向,同一套绕序会让其中一侧
        // 整面朝里、被背面剔除掉 —— 而且是「墙凭空消失」这种只有看图才发现的错。
        // `tests/unit/trackMesh.test.ts` 拿三角形自己的叉乘断言这件事。
        if (side < 0) {
          push(aX, aY, aZ, nHereX, nHereY, nHereZ, uHere, vLo, shadeHere);
          push(bX, bY, bZ, nThereX, nThereY, nThereZ, uThere, vLo, shadeThere);
          push(cX, cY, cZ, nThereX, nThereY, nThereZ, uThere, vHi, shadeThere);
          push(aX, aY, aZ, nHereX, nHereY, nHereZ, uHere, vLo, shadeHere);
          push(cX, cY, cZ, nThereX, nThereY, nThereZ, uThere, vHi, shadeThere);
          push(dX, dY, dZ, nHereX, nHereY, nHereZ, uHere, vHi, shadeHere);
        } else {
          push(aX, aY, aZ, nHereX, nHereY, nHereZ, uHere, vLo, shadeHere);
          push(cX, cY, cZ, nThereX, nThereY, nThereZ, uThere, vHi, shadeThere);
          push(bX, bY, bZ, nThereX, nThereY, nThereZ, uThere, vLo, shadeThere);
          push(aX, aY, aZ, nHereX, nHereY, nHereZ, uHere, vLo, shadeHere);
          push(dX, dY, dZ, nHereX, nHereY, nHereZ, uHere, vHi, shadeHere);
          push(cX, cY, cZ, nThereX, nThereY, nThereZ, uThere, vHi, shadeThere);
        }
      }
    }
  };

  for (const side of [-1, 1] as const) {
    const edge = course.buildEdgeLine(side);
    for (let row = 0; row < rows; row++) {
      // 右侧墙在引道那两段要断开,不然进不去也出不来。左侧永远是完整的。
      if (side > 0 && pit !== null && pitRowIndex(pit, row) >= 0 && !pitWallAtRow(pit, row)) {
        continue;
      }
      sweep(
        edge,
        1,
        side,
        (i) => (row + i) % rows,
        (i) => samples[(row + i) % rows],
        // 闭环最后一行要用整圈长度,不能用 next=0 反推,否则 UV 在接缝处倒着走一圈。
        (i) => (row + i) * spacing,
      );
    }
  }

  if (pit !== null) {
    const edge = course.buildPitEdgeLine('outer');
    sweep(
      edge,
      pit.laneRowCount,
      1,
      (i) => i,
      (i) => samples[(pit.entryRow + i) % rows],
      (i) => (pit.entryRow + i) * spacing,
    );
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(Float32Array.from(normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(Float32Array.from(uvs), 2));
  geometry.setAttribute('color', new BufferAttribute(Float32Array.from(colors), 3));

  const textures = createSurfaceTextures(rng, palette.wallSurface);
  const mesh = new Mesh(
    geometry,
    new MeshStandardMaterial({
      map: textures.map,
      normalMap: textures.normalMap,
      roughnessMap: textures.roughnessMap,
      normalScale: new Vector2(0.7, 0.7),
      vertexColors: true,
      // 混凝土是电介质。上一版给了 metalness 0.3 还带自发光,所以远看是一条
      // 发白的金属带 —— 写实方向下护墙不该自己发光。
      metalness: 0.02,
    }),
  );
  mesh.name = 'guardrail';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * 把路面改成潮湿的样子。`damp` 是 0..1(见 `game/weather.ts`)。
 *
 * 湿沥青**又暗又亮** —— 水膜填平了表面的孔隙,反射变强而漫反射变弱。这两件
 * 事必须一起做:只调暗会变成"脏路面",只调亮会变成"塑料路面"。
 *
 * 做成**事后调用**而不是造网格时传参,是为了不动 `World` 里随机数的取用
 * 顺序:天气本身要消耗一次 `rng.fork()`,如果排在赛道生成之前,同一个 seed
 * 会生成出**另一条赛道** —— 精选赛道的目标时间、玩家存的最佳圈全部作废。
 * 所以天气那次取数排在构造函数最后,路面湿度只能回过头来抹。
 */
export function applyTrackDamp(track: Group, damp: number): void {
  const wet = clamp(damp, 0, 1);
  if (wet <= 0) {
    return;
  }
  const ribbon = track.getObjectByName('track-ribbon');
  if (!(ribbon instanceof Mesh)) {
    return;
  }
  const material = ribbon.material as MeshStandardMaterial;
  material.color.setScalar(1 - WEATHER.dampDarken * wet);
  material.roughness = lerp(1, WEATHER.dampRoughness, wet);
}
