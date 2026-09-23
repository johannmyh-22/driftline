import { ShaderLib } from 'three';
import type {
  BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  WebGLProgramParametersWithUniforms,
  WebGLRenderer,
} from 'three';
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { Course } from '../../src/game/course';
import { createGroundHit } from '../../src/game/groundQuery';
import { createPitLane } from '../../src/game/pitLane';
import { alignStartAwayFromSun, generateTrack } from '../../src/game/trackLayout';
import { TRACK } from '../../src/game/tuning';
import { Atmosphere } from '../../src/gfx/atmosphere';
import { createPalette } from '../../src/gfx/palette';
import { SURFACE_OVERLAP, createTerrainMesh } from '../../src/gfx/terrainMesh';

/**
 * 和 `World` 构造函数同一个 `rng.fork()` 顺序 —— seed 135 那个 −23° 侧倾弯、
 * seed 6 / 12 那两处插值误差最大的弯,都是按真实游戏里的赛道量出来的。
 */
function buildWorldTerrain(seed: number): { course: Course; terrain: Mesh } {
  const rng = new Rng(seed);
  const palette = createPalette(rng.fork());
  const atmosphere = new Atmosphere(rng.fork());
  const layout = alignStartAwayFromSun(
    generateTrack(rng.fork()),
    atmosphere.sunDirection.x,
    atmosphere.sunDirection.z,
  );
  const lane = createPitLane(layout, layout.halfWidth + TRACK.shoulderWidth);
  const course = new Course(layout, rng.fork(), lane);
  const terrain = createTerrainMesh(course, rng.fork(), palette);
  return { course, terrain };
}

/**
 * 在地形三角形上撒点,只看跨在路面外缘附近的那些三角。回调拿到的是点的世界
 * 坐标、地形在这一点的高度、以及着色器会插值出来的「到路面外缘的距离」。
 */
function forEachEdgePoint(
  terrain: Mesh,
  visit: (x: number, y: number, z: number, edge: number) => void,
): void {
  const position = terrain.geometry.getAttribute('position') as BufferAttribute;
  const edge = terrain.geometry.getAttribute('surfaceEdge') as BufferAttribute;
  const steps = 6;
  for (let i = 0; i < position.count; i += 3) {
    const e0 = edge.getX(i);
    const e1 = edge.getX(i + 1);
    const e2 = edge.getX(i + 2);
    if (Math.min(e0, e1, e2) > 0 || Math.max(e0, e1, e2) < -TRACK.shoulderWidth) {
      continue;
    }
    for (let a = 0; a <= steps; a++) {
      for (let b = 0; a + b <= steps; b++) {
        const u = a / steps;
        const v = b / steps;
        const w = 1 - u - v;
        visit(
          position.getX(i) * w + position.getX(i + 1) * u + position.getX(i + 2) * v,
          position.getY(i) * w + position.getY(i + 1) * u + position.getY(i + 2) * v,
          position.getZ(i) * w + position.getZ(i + 1) * u + position.getZ(i + 2) * v,
          e0 * w + e1 * u + e2 * v,
        );
      }
    }
  }
}

describe('地形不压在路面上', () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════
   * 这一块是修出来的(2026-09,HANDOFF 第七十节)。
   *
   * 地形顶点落在条带上时取中心线高度,而侧倾弯低的一侧路面比中心线低
   * 「半宽 × tan(侧倾)」。seed 135 −23° 侧倾,地形高出路肩 3.1 米;全赛道
   * 落在路面上的地形采样点有四成比路面高。开局第一帧就能看见一块尖角沙地
   * 压在路肩上。现在着色器按「到路面外缘的距离」把路面底下那部分丢掉。
   * ══════════════════════════════════════════════════════════════════════════
   */
  it('到外缘的距离和 sample() 的 onTrack 用的是同一条边界,包括维修道', () => {
    for (const seed of [135, 42]) {
      const { course } = buildWorldTerrain(seed);
      const hit = createGroundHit();
      let inside = 0;
      let inPit = 0;
      for (const sample of course.layout.samples) {
        // 沿法向从路面中间一路扫到外缘外面,两侧都扫,维修道那侧扫得更远。
        for (let lateral = -20; lateral <= 40; lateral += 0.37) {
          const x = sample.x - sample.tangentZ * lateral;
          const z = sample.z + sample.tangentX * lateral;
          course.sample(x, z, hit);
          const edge = course.surfaceEdgeDistance(x, z);
          expect(edge < 0).toBe(hit.onTrack);
          inside += hit.onTrack ? 1 : 0;
          inPit += hit.inPit ? 1 : 0;
        }
      }
      expect(inside).toBeGreaterThan(1000);
      expect(inPit).toBeGreaterThan(100);
    }
  });

  it('被丢掉的地形底下一定有路面 —— 不会切出能看穿的洞', () => {
    // 6 和 12 是 18 个 seed 里插值误差最大的两个(实测 0.25 米)。
    for (const seed of [6, 12, 135]) {
      const { course, terrain } = buildWorldTerrain(seed);
      const hit = createGroundHit();
      let discarded = 0;
      forEachEdgePoint(terrain, (x, _y, z, edge) => {
        if (edge >= -SURFACE_OVERLAP) {
          return;
        }
        discarded++;
        course.sample(x, z, hit);
        expect(hit.onTrack).toBe(true);
      });
      expect(discarded).toBeGreaterThan(1000);
    }
  });

  it('留下来的地形不再明显高出路面(原来最多 3.1 米)', () => {
    for (const seed of [135, 42, 7]) {
      const { course, terrain } = buildWorldTerrain(seed);
      const hit = createGroundHit();
      let worst = 0;
      let kept = 0;
      forEachEdgePoint(terrain, (x, y, z, edge) => {
        if (edge < -SURFACE_OVERLAP) {
          return;
        }
        course.sample(x, z, hit);
        if (!hit.onTrack) {
          return;
        }
        kept++;
        worst = Math.max(worst, y - hit.height);
      });
      expect(kept).toBeGreaterThan(100);
      expect(worst).toBeLessThan(0.35);
    }
  });

  /*
   * `onBeforeCompile` 是字符串替换,替换失败不报错 —— three 改了 chunk 名,
   * 那块沙地就静悄悄地回来了。
   */
  it('着色器注入的锚点在当前 three 版本里都还在', () => {
    const { terrain } = buildWorldTerrain(42);
    const material = terrain.material as MeshStandardMaterial;
    const shader = {
      uniforms: {},
      vertexShader: ShaderLib.standard.vertexShader,
      fragmentShader: ShaderLib.standard.fragmentShader,
    };
    material.onBeforeCompile(
      shader as unknown as WebGLProgramParametersWithUniforms,
      undefined as unknown as WebGLRenderer,
    );
    expect(shader.vertexShader).toContain('attribute float surfaceEdge;');
    expect(shader.vertexShader).toContain('vSurfaceEdge = surfaceEdge;');
    expect(shader.fragmentShader).toContain('if (vSurfaceEdge < -uSurfaceOverlap) discard;');
    expect(shader.uniforms).toHaveProperty('uSurfaceOverlap');
    expect(material.customProgramCacheKey()).toBe('driftline-terrain-cutout');
  });
});
