import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { OUTPUT_DIR, VISUAL_TEST_PORT, driveScene, previewUrl } from '../../scripts/harness';

const BASE_URL = previewUrl(VISUAL_TEST_PORT);
const SEED = 42;
const OTHER_SEED = 7;

// 阈值取实测值的 1/6 左右:纯色/黑屏是 0,正常画面在 2400 上下,中间留足够宽的沟。
const MIN_LUMINANCE_VARIANCE = 400;
const MIN_DISTINCT_COLORS = 200;
// 换 seed 后平均色至少要差这么多。实测 seed 42 与 7 差约 26。
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

test('渲染出有内容的画面,且页面没有报错', async ({ page }) => {
  const problems = watchForProblems(page);

  const snapshot = await driveScene(page, BASE_URL, {
    seed: SEED,
    frames: 120,
    camera: 'default',
  });
  const stats = await shoot(page, `smoke-default-seed${SEED}.png`);

  expect(stats.luminanceVariance).toBeGreaterThan(MIN_LUMINANCE_VARIANCE);
  expect(stats.distinctColors).toBeGreaterThan(MIN_DISTINCT_COLORS);
  expect(snapshot['frame']).toBe(120);
  expect(problems).toEqual([]);
});

test('低机位同样出图,机位切换生效', async ({ page }) => {
  const problems = watchForProblems(page);

  await driveScene(page, BASE_URL, { seed: SEED, frames: 120, camera: 'default' });
  const front = await shoot(page, `smoke-default-b-seed${SEED}.png`);

  await page.evaluate(() => {
    const api = window.__DRIFTLINE_TEST__;
    if (api === undefined) {
      throw new Error('__DRIFTLINE_TEST__ 未挂载');
    }
    api.setCamera('low');
  });
  const low = await shoot(page, `smoke-low-seed${SEED}.png`);

  expect(low.luminanceVariance).toBeGreaterThan(MIN_LUMINANCE_VARIANCE);
  expect(low.meanColor).not.toEqual(front.meanColor);
  expect(problems).toEqual([]);
});

test('advance(60) 精确推进 60 帧', async ({ page }) => {
  const before = await driveScene(page, BASE_URL, { seed: SEED, frames: 30, camera: 'default' });

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
  expect(after['spinnerRotation']).toBeGreaterThan(before['spinnerRotation'] ?? 0);
});

test('同 seed 跑两次,数值完全一致', async ({ page }) => {
  const options = { seed: SEED, frames: 90, camera: 'default' } as const;

  const first = await driveScene(page, BASE_URL, options);
  const second = await driveScene(page, BASE_URL, options);

  expect(second).toEqual(first);
});

test('换 seed 会换掉画面配色', async ({ page }) => {
  await driveScene(page, BASE_URL, { seed: SEED, frames: 120, camera: 'default' });
  const a = await shoot(page, `smoke-default-seed${SEED}-a.png`);

  await driveScene(page, BASE_URL, { seed: OTHER_SEED, frames: 120, camera: 'default' });
  const b = await shoot(page, `smoke-default-seed${OTHER_SEED}.png`);

  const delta = Math.max(
    ...a.meanColor.map((channel, index) => Math.abs(channel - (b.meanColor[index] ?? 0))),
  );
  expect(delta).toBeGreaterThan(MIN_SEED_COLOR_DELTA);
});

test('未知机位会明确报错,而不是悄悄画错', async ({ page }) => {
  await driveScene(page, BASE_URL, { seed: SEED, frames: 1, camera: 'default' });

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

  expect(stats.luminanceVariance).toBeGreaterThan(MIN_LUMINANCE_VARIANCE);
  expect(exposed).toBe(false);
  expect(problems).toEqual([]);
});
