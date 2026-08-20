import {
  BufferAttribute,
  Color,
  EdgesGeometry,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import type { Rng } from '../core/rng';
import type { Palette } from './palette';

const RADIUS = 2.4;

/**
 * 占位多面体。M1 会整个删掉换成载具 —— 它存在的唯一理由是让截图里有一个
 * 「明暗面清楚、朝向可辨」的物体,好让我确认光照和步进都真的生效了。
 */
export function createSpinner(rng: Rng, palette: Palette): Group {
  const group = new Group();
  group.name = 'spinner';

  const geometry = new IcosahedronGeometry(RADIUS, 0).toNonIndexed();
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const tint = new Color();

  for (let i = 0; i < position.count; i += 3) {
    tint.copy(palette.spinner);
    tint.offsetHSL(rng.range(-0.03, 0.03), 0, rng.range(-0.1, 0.1));
    for (let v = 0; v < 3; v++) {
      colors[(i + v) * 3] = tint.r;
      colors[(i + v) * 3 + 1] = tint.g;
      colors[(i + v) * 3 + 2] = tint.b;
    }
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const body = new Mesh(
    geometry,
    new MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.35,
      metalness: 0.15,
      // 把面往后推一点,描边线才不会和自己所在的面深度打架、渲染成虚线。
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );
  body.name = 'spinner-body';
  group.add(body);

  const edges = new LineSegments(
    new EdgesGeometry(geometry, 1),
    new LineBasicMaterial({ color: palette.spinnerEdge, transparent: true, opacity: 0.9 }),
  );
  edges.name = 'spinner-edges';
  group.add(edges);

  return group;
}
