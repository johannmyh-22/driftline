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

    /*
     * **判据是「相对一段基准算术的倍数」,不是绝对毫秒。**
     *
     * 挂钟断言在共享的 CI 机器上会被别的进程干扰:实测人为压 8 个满载进程
     * 之后,同一段代码的耗时涨到 2.3 倍 —— 一测就红,而代码根本没变。
     * **放宽预算是错的解法**,那等于把这条断言真正想守的东西一起放掉。
     *
     * 办法是在同一次运行里量一段固定的基准算术,拿比值当判据:CPU 被抢走时
     * 两边一起变慢,比值基本不动。实测同一台机器上——
     *
     * | | 查询 | 基准 | 比值 |
     * |---|---|---|---|
     * | 空载 | 322 ms | 19 ms | 16.9 |
     * | 8 进程满载 | 739 ms | 36 ms | 20.5 |
     *
     * 挂钟摆了 2.3 倍,比值只摆了 1.2 倍。真的写慢了的话查询那一侧单独涨,
     * 比值照样会红。
     *
     * 两边都取多轮里**最快**的一轮:干扰只会让测量变慢不会变快,最快的那轮
     * 最接近没被打扰时的真实成本。
     */
    let queryMs = Number.POSITIVE_INFINITY;
    let referenceMs = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 3; round++) {
      const started = Date.now();
      for (let i = 0; i < 200_000; i++) {
        course.sample(rng.range(-700, 700), rng.range(-700, 700), hit);
      }
      queryMs = Math.min(queryMs, Date.now() - started);
      referenceMs = Math.min(referenceMs, referenceWorkMs());
    }

    // 一帧几十次查询,单次必须远低于微秒级预算。这个机器上 200k 次查询约
    // 300 ms(1.6 µs/次),基准约 19 ms —— 阈值取到实测的近两倍,留足余量。
    expect(queryMs / Math.max(1, referenceMs)).toBeLessThan(32);
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

describe('Course 弧长边界与起跑线环回保护', () => {
  /*
   * 【测试改写说明】
   * 1. 原来抓的是什么:
   *    原快照测试锁定的是已知缺陷行为 —— 闭环赛道首尾相连, 当采样点落在起跑线正后方微小距离
   *    [-ε, 0] 时, 空间索引将其匹配到最后一个线段 (segment = rows - 1), 导致算出的 arc 环绕至
   *    赛道总长度附近 (~2736m) 而非 0 附近 (实测后溜 0.00002m 即可触发)。
   *
   * 2. 为什么原来的写法不再成立:
   *    Course.sample 现已实现起跑线弧长环回保护: 在最后一段 (rows - 1) 且靠近起跑线 (samples[0])
   *    的微小区间内, 将 arc 严格 clamp 到 0。因此对于起跑线后方微小位移, arc 不再返回
   *    totalLength - epsilon (~2736m), 原断言必然不再成立。
   *    【为何选择 clamp 到 0 而非允许小负值】:
   *    - 物理与数据结构规范: 赛道弧长定义域为非负实数 [0, totalLength], clamp 到 0 保证了 arc >= 0。
   *    - 防范下游负索引越界: 下游 Autopilot / Race 等模块广泛使用 Math.floor(vehicle.arc / spacing) % count,
   *      在 JS 中负数取模仍为负数 (-1 % 24 === -1), 允许负 arc 会导致 samples[-1] 读取为 undefined;
   *      clamp 到 0 彻底杜绝了负下标越界隐患。
   *    - 保持起跑线状态连续: 车辆在起跑线上静止沉降或微小后溜时, arc 稳定保持为 0, 不会产生圈数误判。
   *
   * 3. 新写法仍然守得住什么:
   *    - 守住起跑线后方微小位移 (如 -0.00002m、-0.01m、-0.5m) 时 arc 严格连续为 0, 绝不跳变到 2736m。
   *    - 守住 onTrack 仍然为 true (车依然在赛道起跑区域内, 不会误判出界)。
   *    - 跨敏感 seed (1 / 42 / 1337 / 7) 逐一验证, 避免 seed 42 / 1337 假绿灯。
   */
  for (const seed of [1, 42, 1337, 7]) {
    it(`seed ${seed} 起跑线后方微小负向位移时 arc 连续归零且在赛道上`, () => {
      const course = makeCourse(seed);
      const hit = createGroundHit();
      const start = course.layout.samples[0];
      if (start === undefined) {
        throw new Error('采样点缺失');
      }

      // 归零窗口是 ARC_LINE_EPSILON = 0.05 m。要修的场景(悬挂沉降、起步前后抖动)
      // 量级在 1e-5 ~ 1e-2 m,全部落在窗口内。
      for (const epsilon of [0.00002, 0.001, 0.01, 0.04]) {
        course.sample(start.x - start.tangentX * epsilon, start.z - start.tangentZ * epsilon, hit);
        expect(hit.onTrack).toBe(true);
        expect(hit.arc).toBe(0);
      }

      /*
       * 窗口之外必须**照常报接近 totalLength 的弧长**,不许也归零。
       *
       * 这一段是补的:交付的第一版窗口写成 `spacing * 0.5`,把终点线前 3 米整段
       * clamp 成 0,而当时的测试只取到线后 0.5 m 以内、外加线前 +0.05 m,
       * **恰好绕开了被改坏的区间**。实测 seed 1 当时 −2.99 m 处 arc 就是 0.000,
       * 而 −3.05 m 处是 3071.017 —— 每圈正常前进都会经过那个 3071 米的跳变。
       */
      for (const back of [0.5, 1, 2, 3]) {
        course.sample(start.x - start.tangentX * back, start.z - start.tangentZ * back, hit);
        expect(hit.onTrack).toBe(true);
        expect(hit.arc).toBeGreaterThan(course.layout.totalLength - back - 1);
        expect(hit.arc).toBeLessThanOrEqual(course.layout.totalLength);
      }
    });
  }

  it('起跑线前后连续过渡: 负向位移 clamp 为 0, 正向位移单调递增', () => {
    const course = makeCourse(1);
    const hit = createGroundHit();
    const start = course.layout.samples[0];
    if (start === undefined) {
      throw new Error('采样点缺失');
    }

    // 后方 -0.02m(明确落在 0.05 归零窗口内,不压边界)-> 0 -> 正前方 +0.05m
    course.sample(start.x - start.tangentX * 0.02, start.z - start.tangentZ * 0.02, hit);
    expect(hit.arc).toBe(0);

    course.sample(start.x, start.z, hit);
    expect(hit.arc).toBe(0);

    course.sample(start.x + start.tangentX * 0.05, start.z + start.tangentZ * 0.05, hit);
    expect(hit.arc).toBeCloseTo(0.05, 2);
  });
});

/**
 * 一段固定的基准算术,用来把机器快慢和 CPU 争抢从上面那条性能断言里除掉。
 *
 * 故意用纯浮点运算而不是空循环:空循环会被 JIT 整个消掉。返回耗时(毫秒)。
 */
function referenceWorkMs(): number {
  const started = Date.now();
  let acc = 0;
  for (let i = 0; i < 2_000_000; i++) {
    acc += Math.sqrt(i * 1.000001) + Math.sin(i * 0.0001);
  }
  // 结果要被"用掉",否则整段循环会被优化掉,基准就永远是 0。
  if (acc === 12345.6789) {
    throw new Error('基准循环被优化掉了');
  }
  return Date.now() - started;
}

describe('赛道外的压平走廊不是楼梯', () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════
   * 这一条是修出来的(2026-09,HANDOFF 第六十二节)。
   *
   * `groundHeightAt()` 原来直接取**最近那一行**的 `sample.y`,而"最近那一行"
   * 在一行之内是常数、跨行才跳。于是赛道外那条压平走廊实际上是**一段段 6 米
   * 平台 + 台阶的楼梯**:seed 107 第 23 行实测 −1.664 m,下一行 −0.671 m,
   * **0.99 米落差发生在一个行边界上**,六条精选赛道无一幸免(0.49~0.99 m)。
   *
   * 压平走廊本来就是为了「赛道边缘不立起一堵墙」而存在的,量化成台阶等于把
   * 那堵墙切碎了再摆回去 —— 跑宽出去的车会被一路弹。
   *
   * **截图拦不住这个**:地形网格按 9 米格点采样,采不到 6 米周期的台阶,
   * 画面上是平滑的斜坡,而物理踩的是楼梯。只有数值断言拦得住。
   * ══════════════════════════════════════════════════════════════════════════
   */
  const SEEDS = [42, 135, 325, 107, 110, 154];

  /** 沿中心线偏移 `lateral` 米的那条平行线上,第 `row` 段内参数 `t` 处的点。 */
  function offsetPoint(
    course: Course,
    row: number,
    t: number,
    lateral: number,
  ): { x: number; z: number } {
    const samples = course.layout.samples;
    const a = samples[((row % samples.length) + samples.length) % samples.length];
    const b = samples[(((row + 1) % samples.length) + samples.length) % samples.length];
    if (a === undefined || b === undefined) {
      throw new Error('采样点缺失');
    }
    const cx = a.x + (b.x - a.x) * t;
    const cz = a.z + (b.z - a.z) * t;
    const tx = a.tangentX + (b.tangentX - a.tangentX) * t;
    const tz = a.tangentZ + (b.tangentZ - a.tangentZ) * t;
    const n = Math.hypot(tx, tz) || 1;
    return { x: cx - (tz / n) * lateral, z: cz + (tx / n) * lateral };
  }

  it('**一行之内高度必须跟着坡度走** —— 这条直接钉住原来那个 bug', () => {
    /*
     * 原来的实现在一行之内返回**同一个常数**,所以这条会以「差值恰好是 0」
     * 变红。断言的是「走廊的坡度 ≈ 赛道自己的坡度」,而不是"差值非零" ——
     * 后者随便插一点噪声就能骗过去。
     */
    for (const seed of SEEDS) {
      const course = makeCourse(seed);
      const samples = course.layout.samples;
      const lateral = course.outerHalfWidth + 1;
      let checked = 0;

      for (let row = 0; row < samples.length; row += 17) {
        const a = samples[row];
        const b = samples[(row + 1) % samples.length];
        if (a === undefined || b === undefined) {
          continue;
        }
        const segLen = Math.hypot(b.x - a.x, b.z - a.z);
        const grade = (b.y - a.y) / segLen;
        // 太平的段上比值没有意义,跳过。
        if (Math.abs(grade) < 0.02) {
          continue;
        }
        const p0 = offsetPoint(course, row, 0.25, lateral);
        const p1 = offsetPoint(course, row, 0.75, lateral);
        const measured =
          (course.groundHeightAt(p1.x, p1.z) - course.groundHeightAt(p0.x, p0.z)) /
          (segLen * 0.5);
        /*
         * 比值不会正好是 1:偏移出去的那条线在拐角处比中心线长/短一截,
         * 最近点投影把段内参数压缩或拉伸了。实测 2279 个样本
         * 中位 0.972、min 0.760、max 1.123 —— 取 [0.6, 1.4]:比实测宽一倍,
         * 而**原来那个 bug 的比值恰好是 0**,分得开得不能再开。
         */
        expect(measured / grade).toBeGreaterThan(0.6);
        expect(measured / grade).toBeLessThan(1.4);
        checked++;
      }
      expect(checked).toBeGreaterThan(5);
    }
  });

  it('行边界上没有一米级的台阶', () => {
    /*
     * 剩下的残差是**最近点投影在拐角处折叠**的固有产物:实测最差的边界上,
     * 段内参数从 t=0.881 直接跳到下一段的 t=0.119,中间约 1.4 米的中心线
     * 从来不是任何一个偏移点的最近点。折叠量正比于横向距离乘拐角角度。
     *
     * 修完之后:中位 0.4~0.9 cm、p90 约 3 cm、最大 8~15 cm,超过 5 cm 的只占
     * 2~7%(修之前是**每一个**行边界上 0.49~0.99 m)。阈值取 0.25 m ——
     * 比实测最大值宽一倍,又远低于那个一米级的 bug。
     */
    for (const seed of SEEDS) {
      const course = makeCourse(seed);
      const samples = course.layout.samples;
      let worst = 0;

      for (const lateral of [course.outerHalfWidth + 1, course.outerHalfWidth + 6]) {
        for (let row = 0; row < samples.length; row++) {
          const a = samples[row];
          const b = samples[(row + 1) % samples.length];
          if (a === undefined || b === undefined) {
            continue;
          }
          const segLen = Math.hypot(b.x - a.x, b.z - a.z);
          const before = offsetPoint(course, row, 1 - 0.05 / segLen, lateral);
          const after = offsetPoint(course, row + 1, 0.05 / segLen, lateral);
          worst = Math.max(
            worst,
            Math.abs(
              course.groundHeightAt(after.x, after.z) - course.groundHeightAt(before.x, before.z),
            ),
          );
        }
      }
      expect(worst).toBeLessThan(0.25);
    }
  });
});
