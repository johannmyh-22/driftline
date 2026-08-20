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
 * 赛道外的地形。
 *
 * **三个顶点全部落在条带上的三角形才跳过** —— 赛道条带会盖住那块地方,
 * 两层几何叠着只会 z-fighting。判断用的就是 `Course.sample()` 的 `onTrack`,
 * 和物理走同一条判据,不会出现「视觉上有路、物理上没有」。
 *
 * 早先是按三角形**重心**判断的,结果跨在赛道边缘的三角被整个删掉,沿着赛道
 * 两侧留下一圈能看穿的黑色缺口。宁可让边缘的三角和条带轻微相交(被盖住,
 * 看不出来),也不能留洞。
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

  const onTrackAt = (ix: number, iz: number): boolean => {
    course.sample(minX + ix * CELL, minZ + iz * CELL, hit);
    return hit.onTrack;
  };

  const emit = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number): void => {
    if (onTrackAt(ax, az) && onTrackAt(bx, bz) && onTrackAt(cx, cz)) {
      return;
    }

    const ys = [heightAt(ax, az), heightAt(bx, bz), heightAt(cx, cz)];
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

  const textures = createSurfaceTextures(rng, palette.terrainSurface);
  const mesh = new Mesh(
    geometry,
    new MeshStandardMaterial({
      map: textures.map,
      normalMap: textures.normalMap,
      roughnessMap: textures.roughnessMap,
      normalScale: new Vector2(1.1, 1.1),
      vertexColors: true,
      metalness: 0,
    }),
  );
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  return mesh;
}
