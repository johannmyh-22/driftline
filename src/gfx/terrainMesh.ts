import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial, Vector2 } from 'three';
import type { Rng } from '../core/rng';
import type { Course } from '../game/course';
import { createGroundHit } from '../game/groundQuery';
import type { Palette } from './palette';
import { createSurfaceTextures } from './textures';
import { TRACK } from '../game/tuning';

/** 地形网格的格子边长(米)。背景地形,不需要赛道那种精度。 */
const CELL = 9;
/** 赛道 AABB 之外再铺多远。够远到地平线上看不到边界。 */
const MARGIN = 420;

/**
 * 地形在路面下面**留多少不切**(米)。着色器丢掉「离路面外缘向里超过这么多」
 * 的片元。
 *
 * 不能是 0:到外缘的距离按顶点算、在三角形里线性插值,弯道上插值会比真值偏里
 * 一点 —— 取 0 的话,路面外面的地形会被误切,露出一个能看穿的洞。18 个 seed 实测
 * 插值最多偏里 0.25 米,这里给一倍余量。代价是外缘里面这半米地形照旧保留,
 * 实测最多比路面高 0.26 米(原来是 3 米)。
 */
export const SURFACE_OVERLAP = 0.5;

/**
 * 赛道外的地形。
 *
 * **三个顶点全部落在条带上的三角形才跳过** —— 赛道条带会盖住那块地方,
 * 两层几何叠着只会 z-fighting。判断用的就是 `Course.sample()` 的 `onTrack`,
 * 和物理走同一条判据,不会出现「视觉上有路、物理上没有」。
 *
 * 早先是按三角形**重心**判断的,结果跨在赛道边缘的三角被整个删掉,沿着赛道
 * 两侧留下一圈能看穿的黑色缺口。宁可让边缘的三角和条带相交,也不能留洞。
 *
 * **但「相交的部分会被条带盖住」这个假设在侧倾弯里不成立**(HANDOFF 第七十节)。
 * 地形顶点落在条带上时取的是中心线高度,而侧倾弯低的一侧,路面比中心线低
 * `半宽 × tan(侧倾)` —— seed 135 实测 −23° 侧倾,地形高出路肩 3.1 米,
 * 开局第一帧就能看见一块尖角沙地压在路肩上。所以每个顶点另带一个「到路面外缘的
 * 有符号距离」(`Course.surfaceEdgeDistance()`),着色器把路面底下的那部分丢掉。
 * 几何和物理都没动:这只是渲染上的裁切。
 */
export function createTerrainMesh(course: Course, rng: Rng, palette: Palette): Mesh {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const sample of course.layout.samples) {
    minX = Math.min(minX, sample.x);
    maxX = Math.max(maxX, sample.x);
    minZ = Math.min(minZ, sample.z);
    maxZ = Math.max(maxZ, sample.z);
  }
  minX -= MARGIN;
  maxX += MARGIN;
  minZ -= MARGIN;
  maxZ += MARGIN;

  const cols = Math.ceil((maxX - minX) / CELL);
  const rows = Math.ceil((maxZ - minZ) / CELL);

  // 先把格点高度算出来复用,免得每个三角形重复求噪声。
  const heights = new Float64Array((cols + 1) * (rows + 1));
  for (let iz = 0; iz <= rows; iz++) {
    for (let ix = 0; ix <= cols; ix++) {
      heights[iz * (cols + 1) + ix] = course.groundHeightAt(minX + ix * CELL, minZ + iz * CELL);
    }
  }
  const heightAt = (ix: number, iz: number): number => heights[iz * (cols + 1) + ix] ?? 0;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];

  /*
   * 逐顶点法线由噪声的解析梯度求出,而不是三角面法线。
   *
   * 写实材质靠「平滑着色 + 法线贴图」出细节;用面法线的话地形就是一堆折面,
   * 贴多好的图都盖不住那个棱。
   */
  const normalAt = (wx: number, wz: number, out: number[]): void => {
    const e = CELL * 0.5;
    const dx = (course.terrainHeightAt(wx + e, wz) - course.terrainHeightAt(wx - e, wz)) / (2 * e);
    const dz = (course.terrainHeightAt(wx, wz + e) - course.terrainHeightAt(wx, wz - e)) / (2 * e);
    const inv = 1 / Math.hypot(-dx, 1, -dz);
    out[0] = -dx * inv;
    out[1] = inv;
    out[2] = -dz * inv;
  };
  const normalScratch = [0, 1, 0];
  const hit = createGroundHit();
  const tint = new Color();

  // 每个格点问一次,不是每个三角形的每个角问一次(一个格点被六个三角共用)。
  const onTrack = new Uint8Array((cols + 1) * (rows + 1));
  const edge = new Float32Array((cols + 1) * (rows + 1));
  for (let iz = 0; iz <= rows; iz++) {
    for (let ix = 0; ix <= cols; ix++) {
      const wx = minX + ix * CELL;
      const wz = minZ + iz * CELL;
      course.sample(wx, wz, hit);
      onTrack[iz * (cols + 1) + ix] = hit.onTrack ? 1 : 0;
      edge[iz * (cols + 1) + ix] = course.surfaceEdgeDistance(wx, wz);
    }
  }
  const onTrackAt = (ix: number, iz: number): boolean => onTrack[iz * (cols + 1) + ix] === 1;
  const edgeAt = (ix: number, iz: number): number => edge[iz * (cols + 1) + ix] ?? 0;
  const edges: number[] = [];

  const emit = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number): void => {
    if (onTrackAt(ax, az) && onTrackAt(bx, bz) && onTrackAt(cx, cz)) {
      return;
    }

    const ys = [heightAt(ax, az), heightAt(bx, bz), heightAt(cx, cz)];
    edges.push(edgeAt(ax, az), edgeAt(bx, bz), edgeAt(cx, cz));
    const corners: Array<[number, number, number]> = [
      [minX + ax * CELL, ys[0] ?? 0, minZ + az * CELL],
      [minX + bx * CELL, ys[1] ?? 0, minZ + bz * CELL],
      [minX + cx * CELL, ys[2] ?? 0, minZ + cz * CELL],
    ];
    for (const [wx, wy, wz] of corners) {
      positions.push(wx, wy, wz);
      normalAt(wx, wz, normalScratch);
      normals.push(normalScratch[0] ?? 0, normalScratch[1] ?? 1, normalScratch[2] ?? 0);
      uvs.push(wx / TRACK.textureScale, wz / TRACK.textureScale);
    }

    const height = ((ys[0] ?? 0) + (ys[1] ?? 0) + (ys[2] ?? 0)) / 3;
    // 顶点色只做大尺度的明暗变化,细节交给贴图。高处略亮,让山脊读得出形状。
    const shade = 1 + Math.max(-0.12, Math.min(0.22, height * 0.005)) + rng.range(-0.05, 0.05);
    tint.setRGB(shade, shade, shade);
    for (let v = 0; v < 3; v++) {
      colors.push(tint.r, tint.g, tint.b);
    }
  };

  for (let iz = 0; iz < rows; iz++) {
    for (let ix = 0; ix < cols; ix++) {
      emit(ix, iz, ix, iz + 1, ix + 1, iz);
      emit(ix + 1, iz + 1, ix + 1, iz, ix, iz + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(Float32Array.from(normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(Float32Array.from(uvs), 2));
  geometry.setAttribute('color', new BufferAttribute(Float32Array.from(colors), 3));
  geometry.setAttribute('surfaceEdge', new BufferAttribute(Float32Array.from(edges), 1));

  const textures = createSurfaceTextures(rng, palette.terrainSurface);
  const material = new MeshStandardMaterial({
    map: textures.map,
    normalMap: textures.normalMap,
    roughnessMap: textures.roughnessMap,
    normalScale: new Vector2(1.1, 1.1),
    vertexColors: true,
    metalness: 0,
  });
  applySurfaceCutout(material);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * 丢掉压在路面底下的地形片元。`surfaceEdge` 是顶点到路面外缘的有符号距离
 * (路面里为负),在三角形里线性插值。
 *
 * 用 `discard` 而不是在 CPU 上沿外缘裁三角形:外缘是弯的,9 米一格的三角形
 * 裁出来是一段段弦,弯道内侧的弦会落在路面外面,留出一条能看穿的缝。
 */
function applySurfaceCutout(material: MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uSurfaceOverlap'] = { value: SURFACE_OVERLAP };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float surfaceEdge;
varying float vSurfaceEdge;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vSurfaceEdge = surfaceEdge;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uSurfaceOverlap;
varying float vSurfaceEdge;`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `if (vSurfaceEdge < -uSurfaceOverlap) discard;
#include <clipping_planes_fragment>`,
      );
  };
  // 不同的 onBeforeCompile 要有不同的缓存键,否则 three 会把别的材质编好的程序拿来复用。
  material.customProgramCacheKey = () => 'driftline-terrain-cutout';
}
