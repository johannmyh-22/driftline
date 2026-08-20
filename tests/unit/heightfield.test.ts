import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { createGroundHit } from '../../src/game/groundQuery';
import { Heightfield } from '../../src/game/heightfield';

function field(seed = 42): Heightfield {
  return new Heightfield(new Rng(seed));
}

describe('Heightfield', () => {
  it('出生点是绝对平的 —— 起步加速不该被地形干扰', () => {
    const hit = createGroundHit();
    const f = field();
    for (const [x, z] of [
      [0, 0],
      [8, -8],
      [-15, 12],
      [20, 20],
    ] as const) {
      f.sample(x, z, hit);
      expect(hit.height).toBeCloseTo(0, 6);
      expect(hit.normalY).toBeCloseTo(1, 6);
    }
  });

  it('法线永远是单位向量且朝上', () => {
    const hit = createGroundHit();
    const f = field();
    const rng = new Rng(7);
    for (let i = 0; i < 2000; i++) {
      f.sample(rng.range(-260, 260), rng.range(-260, 260), hit);
      expect(Math.hypot(hit.normalX, hit.normalY, hit.normalZ)).toBeCloseTo(1, 6);
      expect(hit.normalY).toBeGreaterThan(0);
      expect(Number.isFinite(hit.height)).toBe(true);
    }
  });

  it('顶点处的采样高度等于该顶点高度', () => {
    const f = field();
    const hit = createGroundHit();
    const half = f.size / 2;

    for (const [ix, iz] of [
      [30, 40],
      [64, 64],
      [100, 20],
    ] as const) {
      f.sample(-half + ix * f.step, -half + iz * f.step, hit);
      expect(hit.height).toBeCloseTo(f.vertexHeight(ix, iz), 5);
    }
  });

  it('物理采样落在渲染网格的三角面上 —— 两边必须是同一个面', () => {
    const f = field();
    const hit = createGroundHit();
    const { positions } = f.buildTriangles();
    const triangles = positions.length / 9;

    const rng = new Rng(11);
    for (let n = 0; n < 300; n++) {
      const t = rng.int(triangles);
      const base = t * 9;
      // 三角形重心处采样,结果应等于三个顶点高度的平均。
      const x = ((positions[base] ?? 0) + (positions[base + 3] ?? 0) + (positions[base + 6] ?? 0)) / 3;
      const z = ((positions[base + 2] ?? 0) + (positions[base + 5] ?? 0) + (positions[base + 8] ?? 0)) / 3;
      const y = ((positions[base + 1] ?? 0) + (positions[base + 4] ?? 0) + (positions[base + 7] ?? 0)) / 3;

      f.sample(x, z, hit);
      expect(hit.height).toBeCloseTo(y, 4);
    }
  });

  it('外圈有围墙,不至于一脚油门开进虚空', () => {
    const f = field();
    const hit = createGroundHit();
    f.sample(250, 0, hit);
    expect(hit.height).toBeGreaterThan(5);
    f.sample(0, -250, hit);
    expect(hit.height).toBeGreaterThan(5);
  });

  it('地形里确实有可以起跳的高点', () => {
    const f = field();
    let peak = 0;
    for (let iz = 0; iz <= f.cells; iz++) {
      for (let ix = 0; ix <= f.cells; ix++) {
        const h = f.vertexHeight(ix, iz);
        // 只看围墙以内,免得把边界墙当成跳台。
        const x = -f.size / 2 + ix * f.step;
        const z = -f.size / 2 + iz * f.step;
        if (Math.max(Math.abs(x), Math.abs(z)) < f.size / 2 - 60) {
          peak = Math.max(peak, h);
        }
      }
    }
    expect(peak).toBeGreaterThan(3);
  });

  it('同 seed 完全一致,不同 seed 地形不同', () => {
    const hit = createGroundHit();
    const read = (seed: number): number[] => {
      const f = new Heightfield(new Rng(seed));
      const out: number[] = [];
      const rng = new Rng(3);
      for (let i = 0; i < 200; i++) {
        f.sample(rng.range(-200, 200), rng.range(-200, 200), hit);
        out.push(hit.height);
      }
      return out;
    };

    expect(read(42)).toEqual(read(42));
    expect(read(42)).not.toEqual(read(43));
  });

  it('越界采样不产生 NaN', () => {
    const f = field();
    const hit = createGroundHit();
    for (const [x, z] of [
      [1e6, 0],
      [-1e6, 1e6],
      [0, -1e6],
    ] as const) {
      f.sample(x, z, hit);
      expect(Number.isFinite(hit.height)).toBe(true);
      expect(Number.isFinite(hit.normalY)).toBe(true);
    }
  });
});
