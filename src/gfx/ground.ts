import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial } from 'three';
import type { Rng } from '../core/rng';
import type { Heightfield } from '../game/heightfield';
import type { Palette } from './palette';

/** 每隔这么多格画一条「网格线」。速度感需要一个周期性的参照物。 */
const GRID_PERIOD = 8;

/**
 * 地面网格。几何体完全来自 `Heightfield`,不自己算高度 ——
 * 一旦这里和物理各算一套,车就会浮空或者陷进坡里。
 *
 * 网格线不是额外的线段,而是直接烧进顶点色:线段跟不上起伏的地形,
 * 会浮在山包上方或者被埋进去。
 */
export function createGround(field: Heightfield, rng: Rng, palette: Palette): Mesh {
  const { positions, cells } = field.buildTriangles();

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.computeVertexNormals();

  const triangles = positions.length / 9;
  const colors = new Float32Array(positions.length / 3 * 3);
  const tint = new Color();

  for (let t = 0; t < triangles; t++) {
    const ix = cells[t * 2] ?? 0;
    const iz = cells[t * 2 + 1] ?? 0;

    // 三角形中心的高度,用来做高度分层上色。
    const base = t * 9;
    const height =
      ((positions[base + 1] ?? 0) + (positions[base + 4] ?? 0) + (positions[base + 7] ?? 0)) / 3;

    const onGridLine = ix % GRID_PERIOD === 0 || iz % GRID_PERIOD === 0;

    const albedo = palette.terrainSurface.base;
    tint.setRGB(albedo[0] ?? 0.2, albedo[1] ?? 0.2, albedo[2] ?? 0.2);
    if (onGridLine) {
      // 只是提亮一档,不是换个颜色 —— 一格就有 4 米宽,真按亮色画会变成公路。
      tint.multiplyScalar(1.3);
    }
    // 越高越亮:坡和山包不用靠光照也能读出形状。
    tint.offsetHSL(0, 0, Math.min(0.22, height * 0.022) + rng.range(-0.035, 0.035));

    for (let v = 0; v < 3; v++) {
      const o = (t * 3 + v) * 3;
      colors[o] = tint.r;
      colors[o + 1] = tint.g;
      colors[o + 2] = tint.b;
    }
  }

  geometry.setAttribute('color', new BufferAttribute(colors, 3));

  const mesh = new Mesh(
    geometry,
    new MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.94,
      metalness: 0,
    }),
  );
  mesh.name = 'ground';
  return mesh;
}
