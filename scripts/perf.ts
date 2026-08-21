import process from 'node:process';
import { chromium } from '@playwright/test';
import { build, preview } from 'vite';
import { CHROMIUM_ARGS, PERF_PORT, PREVIEW_HOST, VIEWPORT, previewUrl } from './harness';

/**
 * 每帧渲染成本探针。
 *
 * `npm run shoot` 和冒烟测试的墙钟时间**量不出**每帧成本:`Loop.advance(n)` 走 n 个
 * 物理步之后只渲染一帧,所以那两个数字里绝大部分是 vite build、浏览器启动、
 * 场景构建和 shader 编译。加一条后处理 pass 到底让每帧贵了多少,在那里看不见。
 *
 * 这里改成循环调 `advance(1)` —— 每次都真的渲染一帧 —— 再用一次 screenshot 强制
 * 把缓冲的 GL 命令结算掉,量到的才是完整的一帧。
 *
 * SwiftShader 是软件渲染,绝对值和真机没有可比性;有意义的是**同一台机器上改动
 * 前后的比值**。
 */

interface PerfOptions {
  seed: number;
  warmup: number;
  samples: number;
  camera: string;
  rebuild: boolean;
  /** 附加到 URL 上的查询串,用来对比不同后处理配置。 */
  extra: string;
}

const USAGE = `用法: npm run perf -- [--seed=42] [--samples=40] [--warmup=20]
                    [--camera=chase] [--extra=post%3Dnone] [--no-build]`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.rebuild) {
    await build({ logLevel: 'warn' });
  }

  let server: Awaited<ReturnType<typeof preview>> | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    server = await preview({
      logLevel: 'warn',
      preview: { host: PREVIEW_HOST, port: PERF_PORT, strictPort: true },
    });

    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    const context = await browser.newContext({
      viewport: { ...VIEWPORT },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    const suffix = options.extra === '' ? '' : `&${options.extra}`;
    await page.goto(`${previewUrl(PERF_PORT)}?test=1&seed=${options.seed}${suffix}`, {
      waitUntil: 'load',
    });
    await page.waitForFunction(() => window.__DRIFTLINE_TEST__ !== undefined);
    await page.evaluate(async () => {
      const api = window.__DRIFTLINE_TEST__;
      if (api === undefined) {
        throw new Error('__DRIFTLINE_TEST__ 未挂载');
      }
      await api.ready;
    });

    // 预热要跑够:第一帧会编译全部 shader,SwiftShader 上那一帧能比稳态贵一个量级。
    await page.evaluate(
      ({ camera, warmup }: { camera: string; warmup: number }) => {
        const api = window.__DRIFTLINE_TEST__;
        if (api === undefined) {
          throw new Error('__DRIFTLINE_TEST__ 未挂载');
        }
        api.setCamera(camera);
        api.setInput({ throttle: 1 });
        for (let i = 0; i < warmup; i++) {
          api.advance(1);
        }
      },
      { camera: options.camera, warmup: options.warmup },
    );
    await page.screenshot();

    const start = performance.now();
    const inPage = await page.evaluate((count: number) => {
      const api = window.__DRIFTLINE_TEST__;
      if (api === undefined) {
        throw new Error('__DRIFTLINE_TEST__ 未挂载');
      }
      const times: number[] = [];
      for (let i = 0; i < count; i++) {
        const t0 = performance.now();
        api.advance(1);
        times.push(performance.now() - t0);
      }
      return times;
    }, options.samples);
    // GL 命令可能还排在队列里,截一张图把它们结算掉,墙钟时间才是完整的。
    // 超时要给够:后处理全开时几十帧的积压能轻松超过 Playwright 默认的 30 秒。
    await page.screenshot({ timeout: 180_000 });
    const wall = performance.now() - start;

    report(options, inPage, wall);
  } finally {
    await browser?.close();
    await server?.close();
  }
}

function report(options: PerfOptions, inPage: readonly number[], wall: number): void {
  const sorted = [...inPage].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const mean = inPage.reduce((sum, value) => sum + value, 0) / Math.max(1, inPage.length);

  process.stdout.write(
    [
      `配置      ${options.extra === '' ? '(默认)' : options.extra}  机位 ${options.camera}  seed ${options.seed}`,
      `样本      ${String(options.samples)} 帧(预热 ${String(options.warmup)} 帧)`,
      `页面内    平均 ${mean.toFixed(1)} ms  p50 ${at(0.5).toFixed(1)} ms  p95 ${at(0.95).toFixed(1)} ms`,
      `墙钟      合计 ${wall.toFixed(0)} ms → 每帧 ${(wall / options.samples).toFixed(1)} ms`,
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: readonly string[]): PerfOptions {
  const options: PerfOptions = {
    seed: 42,
    warmup: 20,
    samples: 40,
    camera: 'chase',
    rebuild: true,
    extra: '',
  };

  for (const arg of argv) {
    if (arg === '--no-build') {
      options.rebuild = false;
      continue;
    }
    const match = /^--([a-z]+)=(.*)$/.exec(arg);
    if (match === null) {
      throw new Error(`无法解析参数 "${arg}"\n${USAGE}`);
    }
    const [, key = '', value = ''] = match;
    switch (key) {
      case 'seed':
        options.seed = requireInteger(value, 'seed');
        break;
      case 'warmup':
        options.warmup = requireInteger(value, 'warmup');
        break;
      case 'samples':
        options.samples = requireInteger(value, 'samples');
        break;
      case 'camera':
        options.camera = value;
        break;
      case 'extra':
        options.extra = value;
        break;
      default:
        throw new Error(`未知参数 "--${key}"\n${USAGE}`);
    }
  }

  if (options.samples < 1) {
    throw new Error('--samples 至少要 1');
  }
  return options;
}

function requireInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} 需要非负整数,收到 "${value}"`);
  }
  return parsed;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
