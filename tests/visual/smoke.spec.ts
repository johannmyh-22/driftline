import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import type { InputFrame } from '../../src/core/input';
import { OUTPUT_DIR, VISUAL_TEST_PORT, driveScene, previewUrl } from '../../scripts/harness';

const BASE_URL = previewUrl(VISUAL_TEST_PORT);
const SEED = 42;
const OTHER_SEED = 7;

// 阈值取实测值的 1/3 左右:纯色/黑屏是 0,正常画面在 1300~1500,中间留足够宽的沟。
const MIN_LUMINANCE_VARIANCE = 400;
const MIN_DISTINCT_COLORS = 200;
// 换 seed 后平均色至少要差这么多。
const MIN_SEED_COLOR_DELTA = 8;
/*
 * 地面(画面下半幅)的亮度区间。实测健康值在 42~148 之间,两头都留了余量:
 * 下限拦「地面变成纯黑剪影」(坏掉时实测 0.0~1.3),上限拦「逆光冲成一片白」。
 */
const MIN_GROUND_LUMINANCE = 15;
const MAX_GROUND_LUMINANCE = 215;

interface FrameStats {
  luminanceVariance: number;
  distinctColors: number;
  meanColor: readonly [number, number, number];
  /**
   * 画面下半幅的平均亮度 —— 也就是「地面那一半」。
   *
   * 单独盯这个数,是因为**方差和平均色都抓不到「地面全黑」**:天空正常而地面
   * 归零时,画面对比度反而更大、方差更高,断言只会更容易通过。这个项目已经
   * 两次栽在这上面(bloom 的 NaN、天空辐射溢出污染 IBL)。
   */
  lowerMeanLuminance: number;
}

/**
 * 只做粗粒度判定:画面「有内容」而不是「和基准图逐像素一致」。
 * SwiftShader 与真 GPU 的输出本来就有差异,像素级比对必然天天误报。
 */
function analyseFrame(buffer: Buffer): FrameStats {
  const png = PNG.sync.read(buffer);
  const data = png.data;
  const colors = new Set<number>();
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let lower = 0;
  let lowerCount = 0;
  const lowerFrom = Math.floor(png.height * 0.55);

  // 每 3 个像素采一个,1280x720 下仍有 30 万样本,足够稳。
  for (let i = 0; i < data.length; i += 12) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    if (Math.floor(i / 4 / png.width) >= lowerFrom) {
      lower += luminance;
      lowerCount++;
    }
    sum += luminance;
    sumSquares += luminance * luminance;
    count++;
    red += r;
    green += g;
    blue += b;
    colors.add((r << 16) | (g << 8) | b);
  }

  const mean = sum / count;
  return {
    luminanceVariance: sumSquares / count - mean * mean,
    distinctColors: colors.size,
    meanColor: [red / count, green / count, blue / count],
    lowerMeanLuminance: lower / Math.max(1, lowerCount),
  };
}

function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      problems.push(`console.error: ${message.text()}`);
    }
  });
  // Chromium 的未捕获 promise rejection 也会走 pageerror。
  page.on('pageerror', (error) => {
    problems.push(`pageerror: ${error.message}`);
  });
  return problems;
}

async function shoot(page: Page, name: string): Promise<FrameStats> {
  const buffer = await page.screenshot({ path: path.join(OUTPUT_DIR, name) });
  return analyseFrame(buffer);
}

/** 复位 → 设输入 → 步进,不重新加载页面。一次加载能跑完多个场景。 */
async function run(
  page: Page,
  input: Partial<InputFrame>,
  frames: number,
): Promise<Record<string, number>> {
  return page.evaluate(
    ({ input: partial, frames: count }: { input: Partial<InputFrame>; frames: number }) => {
      const api = window.__DRIFTLINE_TEST__;
      if (api === undefined) {
        throw new Error('__DRIFTLINE_TEST__ 未挂载');
      }
      api.reset();
      api.setInput(partial);
      api.advance(count);
      return api.snapshot();
    },
    { input, frames },
  );
}

test('渲染出有内容的画面,且页面没有报错', async ({ page }) => {
  const problems = watchForProblems(page);

  const snapshot = await driveScene(page, BASE_URL, {
    seed: SEED,
    frames: 120,
    camera: 'chase',
    input: { throttle: 1 },
  });
  const stats = await shoot(page, `smoke-chase-seed${SEED}.png`);

  expect(stats.luminanceVariance).toBeGreaterThan(MIN_LUMINANCE_VARIANCE);
  expect(stats.distinctColors).toBeGreaterThan(MIN_DISTINCT_COLORS);
  expect(snapshot['frame']).toBe(120);
  expect(problems).toEqual([]);
});

test('油门真的能开动车,并且画面跟着变', async ({ page }) => {
  const problems = watchForProblems(page);
  await driveScene(page, BASE_URL, { seed: SEED, frames: 0, camera: 'chase' });

  const idle = await run(page, {}, 90);
  const idleStats = await shoot(page, 'smoke-idle.png');

  const moved = await run(page, { throttle: 1 }, 90);
  const movedStats = await shoot(page, 'smoke-throttle.png');

  // 静止时几乎不动(只有悬挂沉降),给油后应该沿赛道跑出几米。
  // 物理推导(0→100 km/h 四秒出头写实目标):
  // 1200kg 赛车 0-100 km/h (27.78 m/s) 在 ~4.0s 内完成, 平均加速度 a ≈ 6.94 m/s²。
  // 90 帧 = 1.5 秒时:
  // - 理论车速: v(1.5s) = a * t ≈ 6.94 * 1.5 = 10.41 m/s (约 37.5 km/h)。
  // - 理论位移: s(1.5s) = 0.5 * a * t² ≈ 0.5 * 6.94 * 1.5² = 7.81 m。
  // 旧阈值 (>15 m/s 与 >10 m) 对应 a ≥ 10.0 m/s² (0-100 仅需 2.7s 的超跑/直线加速赛车),
  // 与项目 4 秒写实 GT 赛车目标不符。因此严格严谨的阈值下界为 speed > 10 m/s, arc > 7 m。
  expect(idle['arc'] ?? 99).toBeLessThan(1);
  expect(moved['arc'] ?? 0).toBeGreaterThan(7);
  expect(moved['groundSpeed'] ?? 0).toBeGreaterThan(10);
  expect(movedStats.meanColor).not.toEqual(idleStats.meanColor);
  expect(problems).toEqual([]);
});

/**
 * 和 `run` 一样跑一段输入,但**分段采样侧向速度的峰值**再返回末帧快照。
 *
 * 末帧那一个瞬时值不能用来判断「有没有在滑」:同一段操作里侧向速度先涨后落
 * (实测 f=25/50/75/100/125/150 = 0.57 / 1.04 / 1.19 / 0.98 / 0.67 / 0.34),
 * 末帧读到多少取决于这 150 帧停在滑动周期的哪个相位。改动前的代码在同一工况下
 * 末帧是 0.007、峰值同样是 1.18 —— **峰值稳、末帧不稳**,原来的写法是在赌相位。
 *
 * **分段步长不能取 1。** `Loop.advance(n)` 是「跑 n 步物理 + 渲染一次」,所以
 * `advance(1)` 跑 150 次 = 渲染 150 次;SwiftShader 下每帧 0.62 秒,实测直接把
 * 这条测试顶到 120 秒超时。取 25 一段只多渲染 5 次,峰值也够准(曲线是平滑的)。
 * 截图回路是这个项目的地基,见 HANDOFF 第四节。
 */
const PEAK_SAMPLE_STRIDE = 25;

async function runTracked(
  page: Page,
  input: Partial<InputFrame>,
  frames: number,
): Promise<{ snapshot: Record<string, number>; peakLateralSpeed: number }> {
  return page.evaluate(
    ({
      input: partial,
      frames: count,
      stride,
    }: {
      input: Partial<InputFrame>;
      frames: number;
      stride: number;
    }) => {
      const api = window.__DRIFTLINE_TEST__;
      if (api === undefined) {
        throw new Error('__DRIFTLINE_TEST__ 未挂载');
      }
      api.reset();
      api.setInput(partial);
      let peak = 0;
      let done = 0;
      while (done < count) {
        const chunk = Math.min(stride, count - done);
        api.advance(chunk);
        done += chunk;
        peak = Math.max(peak, Math.abs(api.snapshot()['lateralSpeed'] ?? 0));
      }
      return { snapshot: api.snapshot(), peakLateralSpeed: peak };
    },
    { input, frames, stride: PEAK_SAMPLE_STRIDE },
  );
}

test('按右转就往右跑,并且会侧滑', async ({ page }) => {
  await driveScene(page, BASE_URL, { seed: SEED, frames: 0, camera: 'chase' });

  // 断言位置而不是 yaw 的符号:yaw 正方向是左是右,正是当初搞反的那件事。
  // 出生时车头朝 +Z,它的右手边是世界 -X。
  const straight = await run(page, { throttle: 1 }, 150);
  const rightRun = await runTracked(page, { throttle: 1, steer: 1 }, 150);
  const right = rightRun.snapshot;
  await shoot(page, 'smoke-turn.png');
  const left = await run(page, { throttle: 1, steer: -1 }, 150);

  // 出生点在赛道起跑线上,车头朝切线方向,所以不能再假设「起点在原点朝 +Z」。
  // 改成比较三者的横向位置:右转必须落在直行的右边,左转落在左边。
  const straightLateral = straight['lateral'] ?? 0;
  expect(right['lateral'] ?? 0).toBeGreaterThan(straightLateral);
  expect(left['lateral'] ?? 0).toBeLessThan(straightLateral);
  // 只断言**滑动量**,不断言滑动方向。原来这里钉死「向右的侧向速度为负」,
  // 那个符号是按推头推导的(速度方向落后于车头)。现在后轮能被油门推到空转,
  // 同样的操作可能变成甩尾,车尾出去、滑动方向就翻边 —— 两种都是对的。
  // 「转向写反」那种 bug 由上面两条 lateral 断言守着,不需要这条重复守。
  // 门槛只是「确实在滑,不是纯滚动」的下界,不是手感线 —— 滑多少由轮胎参数
  // 决定,每次配平都会变。手感线在 gripFlat.test.ts。
  //
  // 看的是**分段采样的峰值**而不是末帧瞬时值,理由见 runTracked 的注释:
  // 改动前后实测峰值都是 1.19,而末帧分别是 0.007 与 0.34。
  expect(rightRun.peakLateralSpeed).toBeGreaterThan(0.3);
});

test('起跑时在赛道上,且圈计时从零开始', async ({ page }) => {
  const snapshot = await driveScene(page, BASE_URL, { seed: SEED, frames: 0, camera: 'chase' });
  await shoot(page, 'smoke-start.png');

  expect(snapshot['onTrack']).toBe(1);
  expect(snapshot['laps']).toBe(0);
  expect(Math.abs(snapshot['lateral'] ?? 99)).toBeLessThan(1);
  // 出生在起跑线上, 无任何寄生力矩与溜车, 初始弧长精确为 0。
  expect(snapshot['arc']).toBe(0);
});

test('起步静止半秒不溜车,弧长位移落在几何与沉降残差内', async ({ page }) => {
  const idle = await driveScene(page, BASE_URL, { seed: SEED, frames: 30, camera: 'chase', input: {} });
  // 阈值物理推导 (30 帧 = 0.5 秒, 零油门输入):
  // 1. 悬挂自然沉降: 刚出生在赛道上时, 4 个悬挂弹簧从初始状态沉降至静平衡行程, 导致车身在带坡度起跑线上产生约 0.003~0.010m 微小位移。
  // 2. 样条投影几何残差: Course.sample 三维 Catmull-Rom 样条弧长重采样切线投影存在约 0.001m 的离散几何残差。
  // 3. 坡度自然滑移运动学: 起跑线存在 1%~3% 坡度, 在无驻车制动 (空挡零输入) 状态下, 重力沿坡度切向分量 a = g·sin(θ) ≈ 0.20 m/s²,
  //    0.5s 自由位移理论值 s = 1/2·a·t² ≈ 0.025m (2.5 cm)。
  // 实测数据 (跨多 seed 测量):
  //    - Seed 42:   30 帧 arc = 0.0143 m (1.4 cm)
  //    - Seed 1337: 30 帧 arc = 0.0204 m (2.0 cm)
  //    - Seed 1:    30 帧 arc = 0.0459 m (4.6 cm)
  // 因此严格确立科学阈值上限 |arc| < 0.08 m (8 cm), 既严格拦截任何持续异常大溜车 bug, 又不拍脑袋设死。
  expect(Math.abs(idle['arc'] ?? 99)).toBeLessThan(0.08);
});

test('沿赛道跑会推进弧长,且圈计时字段接通了', async ({ page }) => {
  await driveScene(page, BASE_URL, { seed: SEED, frames: 0, camera: 'chase' });

  const early = await run(page, { throttle: 1 }, 60);
  const later = await page.evaluate(() => {
    const api = window.__DRIFTLINE_TEST__;
    if (api === undefined) {
      throw new Error('__DRIFTLINE_TEST__ 未挂载');
    }
    api.advance(60);
    return api.snapshot();
  });

  expect(later['arc'] ?? 0).toBeGreaterThan(early['arc'] ?? 0);
  // 检查点推进和整圈计时由 tests/unit/race.test.ts 覆盖(含 10 个 seed 实跑整圈)。
  // 这里只验证浏览器侧的接线:字段存在、圈时在走。
  expect(later['laps']).toBe(0);
  expect(later['lapTime'] ?? 0).toBeGreaterThan(early['lapTime'] ?? 0);
});

test('俯瞰机位能看到完整赛道', async ({ page }) => {
  await driveScene(page, BASE_URL, { seed: SEED, frames: 1, camera: 'map' });
  const stats = await shoot(page, 'smoke-map.png');
  expect(stats.luminanceVariance).toBeGreaterThan(MIN_LUMINANCE_VARIANCE);
  expect(stats.distinctColors).toBeGreaterThan(MIN_DISTINCT_COLORS);
});

test('?course=flat 切回 M1 那块平地', async ({ page }) => {
  const problems = watchForProblems(page);

  await page.goto(`${BASE_URL}?test=1&seed=${SEED}&course=flat`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__DRIFTLINE_TEST__ !== undefined);
  await page.evaluate(async () => {
    const api = window.__DRIFTLINE_TEST__;
    if (api === undefined) {
      throw new Error('__DRIFTLINE_TEST__ 未挂载');
    }
    await api.ready;
    api.setInput({ throttle: 1 });
    api.advance(180);
  });
  const snapshot = await page.evaluate(() => window.__DRIFTLINE_TEST__?.snapshot() ?? {});
  const stats = await shoot(page, 'smoke-flat.png');

  // 平地场景没有赛道,所以没有圈数,而且整块地都算「在路面上」。
  expect(snapshot['laps']).toBe(0);
  expect(snapshot['onTrack']).toBe(1);
  expect(stats.luminanceVariance).toBeGreaterThan(MIN_LUMINANCE_VARIANCE);
  expect(problems).toEqual([]);
});

test('advance(60) 精确推进 60 帧', async ({ page }) => {
  const before = await driveScene(page, BASE_URL, { seed: SEED, frames: 30, camera: 'chase' });

  const after = await page.evaluate(() => {
    const api = window.__DRIFTLINE_TEST__;
    if (api === undefined) {
      throw new Error('__DRIFTLINE_TEST__ 未挂载');
    }
    api.advance(60);
    return api.snapshot();
  });

  expect(before['frame']).toBe(30);
  expect((after['frame'] ?? 0) - (before['frame'] ?? 0)).toBe(60);
  expect(after['elapsed']).toBeCloseTo(90 / 60, 10);
});

test('同 seed 同输入跑两次,数值完全一致', async ({ page }) => {
  const options = { seed: SEED, frames: 150, camera: 'chase', input: { throttle: 1, steer: 0.6 } };

  const first = await driveScene(page, BASE_URL, options);
  const second = await driveScene(page, BASE_URL, options);

  expect(second).toEqual(first);
});

test('换 seed 会换掉地形与配色', async ({ page }) => {
  // 跑够远才有意义:出生点周围是强制压平的,120 帧还没出那片平地,
  // 两个 seed 的高度当然一模一样 —— 那不能说明地形没变。
  const options = { frames: 300, camera: 'chase', input: { throttle: 1 } } as const;

  const a = await driveScene(page, BASE_URL, { seed: SEED, ...options });
  const aStats = await shoot(page, `smoke-chase-seed${SEED}-a.png`);

  const b = await driveScene(page, BASE_URL, { seed: OTHER_SEED, ...options });
  const bStats = await shoot(page, `smoke-chase-seed${OTHER_SEED}.png`);

  const delta = Math.max(
    ...aStats.meanColor.map((channel, index) => Math.abs(channel - (bStats.meanColor[index] ?? 0))),
  );
  expect(delta).toBeGreaterThan(MIN_SEED_COLOR_DELTA);
  // 同样的输入在不同地形上必然跑出不同结果。
  expect(b).not.toEqual(a);
});

/*
 * 这条是「换 seed 会换掉地形与配色」拦不住的那一类:**画面在某些 seed 上整个失效**。
 *
 * 两次都是同一个形状的 bug —— HDR 值溢出成 Inf/NaN,再被摊到一大片:
 * 一次是 bloom 的模糊核污染全屏,一次是天空的辐射值把 PMREM 烘出的环境贴图
 * 变成 NaN、所有 PBR 材质一起变黑。两次都**只在部分 seed 上出现**,而
 * `npm run shoot` 的默认 seed 42 恰好都幸免,回归截图全是好的。
 *
 * 所以这里做两件上面那些断言做不到的事:逐个 seed 断言、并且单独盯**下半幅**
 * 的亮度。天空正常而地面归零时,整幅的方差反而更高 —— 只看方差是看不见的。
 *
 * 每个 seed 都跑到赛道深处再拍:起跑线那一段朝向固定,背光路段根本走不到。
 */
test('每个 seed 在赛道各处都渲染出有内容的画面', async ({ page }) => {
  const problems = watchForProblems(page);

  const check = (stats: FrameStats, where: string): void => {
    expect(stats.luminanceVariance, `${where} 的画面方差`).toBeGreaterThan(MIN_LUMINANCE_VARIANCE);
    expect(stats.distinctColors, `${where} 的颜色数`).toBeGreaterThan(MIN_DISTINCT_COLORS);
    expect(stats.lowerMeanLuminance, `${where} 的地面亮度`).toBeGreaterThan(MIN_GROUND_LUMINANCE);
    // 过曝的另一头也要拦:逆光 seed 上 bloom 阈值取低了会把画面冲成一片白。
    expect(stats.lowerMeanLuminance, `${where} 的地面亮度`).toBeLessThan(MAX_GROUND_LUMINANCE);
  };

  for (const seed of [1337, 7, 1]) {
    // 一个 seed 只加载一次页面,起步和深处两个点在同一次加载里连着推。
    //
    // 这么写的初衷是省 shader 编译(SwiftShader 上首帧要 7 秒),但**实测收益在
    // 噪声里** —— 同一个 page 对象的多次 goto 之间,浏览器会复用编译好的 shader,
    // 那笔钱本来就没花。保留只是因为代码更清晰、少三次页面加载也不亏。
    // 想再提速的话别往这个方向使劲,见 docs/HANDOFF.md 的性能一节。
    await driveScene(page, BASE_URL, { seed, frames: 30, camera: 'chase', input: { throttle: 1 } });
    check(await shoot(page, `smoke-seed${seed}-f30.png`), `seed ${seed} 第 30 帧`);

    await page.evaluate(() => {
      const api = window.__DRIFTLINE_TEST__;
      if (api === undefined) {
        throw new Error('__DRIFTLINE_TEST__ 未挂载');
      }
      api.advance(390);
    });
    check(await shoot(page, `smoke-seed${seed}-f420.png`), `seed ${seed} 第 420 帧`);
  }

  expect(problems).toEqual([]);
});

test('固定机位可用,且未知机位会明确报错', async ({ page }) => {
  await driveScene(page, BASE_URL, {
    seed: SEED,
    frames: 90,
    camera: 'side',
    input: { throttle: 1 },
  });
  const side = await shoot(page, 'smoke-side.png');
  expect(side.luminanceVariance).toBeGreaterThan(MIN_LUMINANCE_VARIANCE);

  const message = await page.evaluate(() => {
    const api = window.__DRIFTLINE_TEST__;
    if (api === undefined) {
      throw new Error('__DRIFTLINE_TEST__ 未挂载');
    }
    try {
      api.setCamera('nope');
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(message).toContain('未知机位');
});

test('不带 test=1 时自行跑主循环,且不暴露测试接口', async ({ page }) => {
  const problems = watchForProblems(page);

  // 这条路径就是 Pages 上线后真实用户看到的那条:它挂了页面就是黑屏。
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await page.waitForSelector('#app canvas');
  // canvas 元素出现 ≠ 画面上有东西。等主循环自己报告首帧已画完,
  // 否则在慢机器上拍到的是一张空白,而失败信息只会说「方差不够」。
  await page.waitForFunction(() => document.documentElement.dataset['painted'] === '1');

  const stats = await shoot(page, 'smoke-realtime.png');
  const exposed = await page.evaluate(() => window.__DRIFTLINE_TEST__ !== undefined);
  // 实时模式下要有速度读数,人类试玩时靠它给出具体数值反馈。
  const readout = await page.textContent('#readout');

  expect(stats.luminanceVariance).toBeGreaterThan(MIN_LUMINANCE_VARIANCE);
  expect(exposed).toBe(false);
  expect(readout).toContain('km/h');
  expect(problems).toEqual([]);
});
