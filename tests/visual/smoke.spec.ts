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

interface FrameStats {
  luminanceVariance: number;
  distinctColors: number;
  meanColor: readonly [number, number, number];
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

  // 每 3 个像素采一个,1280x720 下仍有 30 万样本,足够稳。
  for (let i = 0; i < data.length; i += 12) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

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

  // 静止时几乎不动(只有悬浮沉降),给油后应该跑出几十米。
  expect(Math.abs(idle['z'] ?? 0)).toBeLessThan(1);
  expect(moved['z'] ?? 0).toBeGreaterThan(30);
  expect(moved['groundSpeed'] ?? 0).toBeGreaterThan(30);
  expect(movedStats.meanColor).not.toEqual(idleStats.meanColor);
  expect(problems).toEqual([]);
});

test('按右转就往右跑,并且会侧滑', async ({ page }) => {
  await driveScene(page, BASE_URL, { seed: SEED, frames: 0, camera: 'chase' });

  // 断言位置而不是 yaw 的符号:yaw 正方向是左是右,正是当初搞反的那件事。
  // 出生时车头朝 +Z,它的右手边是世界 -X。
  const straight = await run(page, { throttle: 1 }, 150);
  const right = await run(page, { throttle: 1, steer: 1 }, 150);
  await shoot(page, 'smoke-turn.png');
  const left = await run(page, { throttle: 1, steer: -1 }, 150);

  expect(straight['x']).toBe(0);
  expect(right['x'] ?? 0).toBeLessThan(-5);
  expect(left['x'] ?? 0).toBeGreaterThan(5);
  // 右转时速度方向落后于车头,相对车身在向左滑,所以「向右的侧向速度」为负。
  expect(right['lateralSpeed'] ?? 0).toBeLessThan(-0.5);
});

test('冲过地形会脱离地面,阴影提供落点参照', async ({ page }) => {
  await driveScene(page, BASE_URL, { seed: SEED, frames: 0, camera: 'chase' });

  const airborne = await run(page, { throttle: 1 }, 180);
  await shoot(page, 'smoke-airborne.png');

  expect(airborne['grounded']).toBe(0);
  expect(airborne['clearance'] ?? 0).toBeGreaterThan(3);
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

  const stats = await shoot(page, 'smoke-realtime.png');
  const exposed = await page.evaluate(() => window.__DRIFTLINE_TEST__ !== undefined);
  // 实时模式下要有速度读数,人类试玩时靠它给出具体数值反馈。
  const readout = await page.textContent('#readout');

  expect(stats.luminanceVariance).toBeGreaterThan(MIN_LUMINANCE_VARIANCE);
  expect(exposed).toBe(false);
  expect(readout).toContain('km/h');
  expect(problems).toEqual([]);
});
