import type { BufferAttribute, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { Course } from '../../src/game/course';
import { generateTrack } from '../../src/game/trackLayout';
import { createPalette } from '../../src/gfx/palette';
import { createTrackMesh } from '../../src/gfx/trackMesh';

function buildWall(seed: number): { wall: Mesh; course: Course } {
  const rng = new Rng(seed);
  const course = new Course(generateTrack(rng.fork()), rng.fork());
  const group = createTrackMesh(course, rng.fork(), createPalette(rng.fork()));
  const wall = group.children.find((child) => child.name === 'guardrail');
  if (wall === undefined) {
    throw new Error('赛道网格里没有 guardrail');
  }
  return { wall: wall as Mesh, course };
}

describe('护墙几何', () => {
  /*
   * 绕序错了不会报错、不会让测试变红,只会让整面墙被背面剔除掉 —— 也就是
   * 「墙凭空消失」。这个项目已经在扇形三角上栽过一次同样的跟头。
   *
   * 断言的是三角形**自己的叉乘**和它携带的着色法线同向,不是某个内部约定的
   * 符号:如果哪天剖面点序或者 out 向量的定义变了,这条会跟着一起响。
   */
  it('每个三角的绕序都和它的着色法线同向,不会被背面剔除', () => {
    for (const seed of [42, 7, 1337]) {
      const { wall } = buildWall(seed);
      const position = wall.geometry.getAttribute('position') as BufferAttribute;
      const normal = wall.geometry.getAttribute('normal') as BufferAttribute;
      const triangles = position.count / 3;
      expect(triangles).toBeGreaterThan(100);

      let checked = 0;
      for (let t = 0; t < triangles; t++) {
        const i = t * 3;
        const ax = position.getX(i);
        const ay = position.getY(i);
        const az = position.getZ(i);
        const e1x = position.getX(i + 1) - ax;
        const e1y = position.getY(i + 1) - ay;
        const e1z = position.getZ(i + 1) - az;
        const e2x = position.getX(i + 2) - ax;
        const e2y = position.getY(i + 2) - ay;
        const e2z = position.getZ(i + 2) - az;

        // 面法线 = e1 × e2,由绕序决定朝向。
        const fx = e1y * e2z - e1z * e2y;
        const fy = e1z * e2x - e1x * e2z;
        const fz = e1x * e2y - e1y * e2x;
        const area = Math.hypot(fx, fy, fz);
        // 剖面里有零长度的段(底缘那两个点横向同位),退化三角没有朝向可言。
        if (area < 1e-9) {
          continue;
        }

        const dot =
          (fx * normal.getX(i) + fy * normal.getY(i) + fz * normal.getZ(i)) / area;
        expect(dot).toBeGreaterThan(0);
        checked++;
      }
      expect(checked).toBeGreaterThan(100);
    }
  });

  /*
   * 不变量「同一条边只能有一个高度」在装饰物上的推论。上一版护栏照着 sample.y
   * 和 bank 另算了一套高度、还带一个 0.5 的经验系数,墙底和路肩就对不上了。
   */
  it('墙底坐在条带自己的外缘顶点上,没有另算一套高度', () => {
    const { wall, course } = buildWall(42);
    const position = wall.geometry.getAttribute('position') as BufferAttribute;

    // 量化成字符串查表,避免 3.6 万顶点 × 边线点的暴力比对。
    const key = (x: number, y: number, z: number): string =>
      `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    const present = new Set<string>();
    for (let i = 0; i < position.count; i++) {
      present.add(key(position.getX(i), position.getY(i), position.getZ(i)));
    }

    for (const side of [-1, 1] as const) {
      const edge = course.buildEdgeLine(side);
      const rows = edge.length / 3;
      for (let row = 0; row < rows; row++) {
        // Float32 存储会丢精度,所以按写进 buffer 的那个精度取整再比。
        const x = Math.fround(edge[row * 3] ?? 0);
        const y = Math.fround(edge[row * 3 + 1] ?? 0);
        const z = Math.fround(edge[row * 3 + 2] ?? 0);
        expect(present.has(key(x, y, z))).toBe(true);
      }
    }
  });

  it('墙高不超过剖面给的高度,不会穿进天上去', () => {
    const { wall, course } = buildWall(42);
    const position = wall.geometry.getAttribute('position') as BufferAttribute;
    const edge = course.buildEdgeLine(-1);

    let minEdgeY = Infinity;
    let maxEdgeY = -Infinity;
    for (const side of [-1, 1] as const) {
      const line = side < 0 ? edge : course.buildEdgeLine(1);
      for (let row = 0; row < line.length / 3; row++) {
        const y = line[row * 3 + 1] ?? 0;
        minEdgeY = Math.min(minEdgeY, y);
        maxEdgeY = Math.max(maxEdgeY, y);
      }
    }

    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < position.count; i++) {
      minY = Math.min(minY, position.getY(i));
      maxY = Math.max(maxY, position.getY(i));
    }

    expect(minY).toBeGreaterThanOrEqual(minEdgeY - 1e-3);
    // 剖面最高 1.08 米,留一点浮点余量。
    expect(maxY).toBeLessThanOrEqual(maxEdgeY + 1.09);
  });
});
