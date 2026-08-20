import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { Course } from '../../src/game/course';
import { createGroundHit } from '../../src/game/groundQuery';
import { generateTrack } from '../../src/game/trackLayout';

function makeCourse(seed = 42): Course {
  const rng = new Rng(seed);
  return new Course(generateTrack(rng.fork()), rng.fork());
}

describe('Course 与渲染网格的一致性', () => {
  it('物理查询落在渲染网格的三角面上 —— 车贴合的面就是看到的面', () => {
    const course = makeCourse();
    const hit = createGroundHit();
    const { positions } = course.buildRibbonTriangles();
    const triangles = positions.length / 9;

    const rng = new Rng(11);
    let checked = 0;
    for (let n = 0; n < 600; n++) {
      const t = rng.int(triangles);
      const base = t * 9;
      const cx =
        ((positions[base] ?? 0) + (positions[base + 3] ?? 0) + (positions[base + 6] ?? 0)) / 3;
      const cy =
        ((positions[base + 1] ?? 0) + (positions[base + 4] ?? 0) + (positions[base + 7] ?? 0)) / 3;
      const cz =
        ((positions[base + 2] ?? 0) + (positions[base + 5] ?? 0) + (positions[base + 8] ?? 0)) / 3;

      course.sample(cx, cz, hit);
      // 条带自交时同一个 (x,z) 可能对应两层,重心恰好落在另一层上就不算数;
      // 校验器已经排除自交,所以这种情况不该出现,真出现了就是 bug。
      expect(hit.onTrack).toBe(true);
      expect(hit.height).toBeCloseTo(cy, 3);
      checked++;
    }
    expect(checked).toBe(600);
  });

  it('法线是单位向量且朝上', () => {
    const course = makeCourse();
    const hit = createGroundHit();
    const rng = new Rng(7);

    for (let n = 0; n < 500; n++) {
      const sample = course.layout.samples[rng.int(course.layout.samples.length)];
      if (sample === undefined) {
        continue;
      }
      const d = rng.range(-course.outerHalfWidth, course.outerHalfWidth);
      course.sample(sample.x - sample.tangentZ * d, sample.z + sample.tangentX * d, hit);

      expect(Math.hypot(hit.normalX, hit.normalY, hit.normalZ)).toBeCloseTo(1, 6);
      expect(hit.normalY).toBeGreaterThan(0);
    }
  });
});

describe('Course 横向定位', () => {
  it('中心线上横向距离接近 0,且判定在赛道上', () => {
    const course = makeCourse();
    const hit = createGroundHit();

    for (const sample of course.layout.samples) {
      course.sample(sample.x, sample.z, hit);
      expect(hit.onTrack).toBe(true);
      expect(Math.abs(hit.lateral)).toBeLessThan(0.5);
    }
  });

  it('横向距离的正方向是车头的右手边', () => {
    const course = makeCourse();
    const hit = createGroundHit();
    const sample = course.layout.samples[40];
    if (sample === undefined) {
      throw new Error('采样点缺失');
    }

    // 车头右手边 = tangent × up = (-tz, 0, tx)。
    const offset = 8;
    course.sample(sample.x - sample.tangentZ * offset, sample.z + sample.tangentX * offset, hit);
    expect(hit.lateral).toBeCloseTo(offset, 1);

    course.sample(sample.x + sample.tangentZ * offset, sample.z - sample.tangentX * offset, hit);
    expect(hit.lateral).toBeCloseTo(-offset, 1);
  });

  it('离开条带外缘就不算在赛道上', () => {
    const course = makeCourse();
    const hit = createGroundHit();
    const sample = course.layout.samples[80];
    if (sample === undefined) {
      throw new Error('采样点缺失');
    }

    const far = course.outerHalfWidth + 30;
    course.sample(sample.x - sample.tangentZ * far, sample.z + sample.tangentX * far, hit);
    expect(hit.onTrack).toBe(false);
  });

  it('弧长沿赛道单调推进,一圈回到起点', () => {
    const course = makeCourse();
    const hit = createGroundHit();
    const samples = course.layout.samples;

    let previous = -1;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      if (sample === undefined) {
        continue;
      }
      course.sample(sample.x, sample.z, hit);
      expect(hit.arc).toBeGreaterThan(previous);
      previous = hit.arc;
    }
    expect(previous).toBeCloseTo(course.layout.totalLength - course.layout.spacing, 0);
  });
});

describe('Course 侧倾', () => {
  it('弯道外侧比内侧高', () => {
    const course = makeCourse();
    const inner = createGroundHit();
    const outer = createGroundHit();

    let checked = 0;
    for (const sample of course.layout.samples) {
      if (Math.abs(sample.bank) < 0.12) {
        continue;
      }
      const d = course.halfWidth * 0.9;
      // bank 为正表示右侧更高。
      const highSign = Math.sign(sample.bank);
      course.sample(
        sample.x - sample.tangentZ * d * highSign,
        sample.z + sample.tangentX * d * highSign,
        outer,
      );
      course.sample(
        sample.x + sample.tangentZ * d * highSign,
        sample.z - sample.tangentX * d * highSign,
        inner,
      );

      expect(outer.height).toBeGreaterThan(inner.height);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('侧倾处法线跟着倾斜,不是一直朝正上方', () => {
    const course = makeCourse();
    const hit = createGroundHit();

    let maxTilt = 0;
    for (const sample of course.layout.samples) {
      course.sample(sample.x, sample.z, hit);
      maxTilt = Math.max(maxTilt, Math.acos(Math.min(1, hit.normalY)));
    }
    // 最大侧倾 25° 上下,法线倾角应该同量级。
    expect(maxTilt).toBeGreaterThan(0.15);
  });
});

describe('Course 确定性与性能', () => {
  it('同 seed 查询结果完全一致', () => {
    const read = (): number[] => {
      const course = makeCourse(9);
      const hit = createGroundHit();
      const out: number[] = [];
      const rng = new Rng(3);
      for (let i = 0; i < 200; i++) {
        course.sample(rng.range(-700, 700), rng.range(-700, 700), hit);
        out.push(hit.height, hit.normalY, hit.lateral);
      }
      return out;
    };
    expect(read()).toEqual(read());
  });

  it('查询够快 —— 每帧要问几十次', () => {
    const course = makeCourse();
    const hit = createGroundHit();
    const rng = new Rng(5);

    const started = Date.now();
    for (let i = 0; i < 200_000; i++) {
      course.sample(rng.range(-700, 700), rng.range(-700, 700), hit);
    }
    const perQuery = (Date.now() - started) / 200_000;
    // 一帧几十次查询,单次必须远低于微秒级预算。
    expect(perQuery).toBeLessThan(0.005);
  });

  it('任意位置都不产生 NaN', () => {
    const course = makeCourse();
    const hit = createGroundHit();
    const rng = new Rng(13);

    for (let i = 0; i < 2000; i++) {
      course.sample(rng.range(-5000, 5000), rng.range(-5000, 5000), hit);
      expect(Number.isFinite(hit.height)).toBe(true);
      expect(Number.isFinite(hit.normalY)).toBe(true);
    }
  });
});
