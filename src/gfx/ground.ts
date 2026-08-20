import {
  BufferAttribute,
  Color,
  DoubleSide,
  Group,
  GridHelper,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
} from 'three';
import type { Rng } from '../core/rng';
import type { Palette } from './palette';

const SIZE = 160;
const DIVISIONS = 32;
/** 网格线比三角面稀一半:太密的话远处会糊成一片摩尔纹。 */
const GRID_DIVISIONS = 16;

/**
 * 地面 = 逐三角上色的平面 + 网格线。
 *
 * 平面本身保持绝对水平:M0 只要证明「光照 / 顶点色 / seed」这条链路是通的,
 * 真正的地形放到 M2。三角面各自取色是为了在纯平的几何上也能看出低多边形质感。
 */
export function createGround(rng: Rng, palette: Palette): Group {
  const group = new Group();
  group.name = 'ground';

  const geometry = new PlaneGeometry(SIZE, SIZE, DIVISIONS, DIVISIONS).toNonIndexed();
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const tint = new Color();

  for (let i = 0; i < position.count; i += 3) {
    // 每个三角形取一次随机数,三个顶点共用 —— 这才是 flat shading 想要的效果。
    const jitter = rng.range(-0.06, 0.06);
    const cx = (position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3;
    const cz = (position.getZ(i) + position.getZ(i + 1) + position.getZ(i + 2)) / 3;
    const falloff = Math.min(1, Math.hypot(cx, cz) / (SIZE * 0.5));

    tint.copy(palette.ground);
    tint.offsetHSL(0, -0.12 * falloff, jitter - 0.14 * falloff);

    for (let v = 0; v < 3; v++) {
      colors[(i + v) * 3] = tint.r;
      colors[(i + v) * 3 + 1] = tint.g;
      colors[(i + v) * 3 + 2] = tint.b;
    }
  }

  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const plane = new Mesh(
    geometry,
    new MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.95,
      metalness: 0,
      side: DoubleSide,
    }),
  );
  plane.name = 'ground-plane';
  group.add(plane);

  const grid = new GridHelper(SIZE, GRID_DIVISIONS, palette.gridMajor, palette.gridMinor);
  grid.name = 'ground-grid';
  // 抬高一点点避免和地面共面打架,肉眼看不出这个高度差。
  grid.position.y = 0.03;
  const gridMaterial = grid.material as LineBasicMaterial;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.9;
  gridMaterial.depthWrite = false;
  group.add(grid);

  return group;
}
