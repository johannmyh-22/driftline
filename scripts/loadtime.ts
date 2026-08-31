import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { build, preview } from 'vite';
import { CHROMIUM_ARGS, PREVIEW_HOST, VIEWPORT, previewUrl } from './harness';

const PORT = 4176;

/**
 * 首屏加载耗时与字节数(M6「首屏加载 < 3s」)。
 *
 * **量的是网络那一段,不是渲染那一段。** 主指标取 `data-booted` —— 下载 +
 * 解析 + wasm 起来 + 建世界,也就是首屏优化真正能动的部分。`data-painted`
 * 还包含第一帧的渲染,而无头环境走 SwiftShader,编译着色器就要一秒多,
 * 混在一起会把优化效果整个淹掉。
 *
 * 网络按档位限速,默认跑一遍常见的几档。**限速是靠 CDP 的
 * `Network.emulateNetworkConditions`**,不是靠估算。
 */
interface Profile {
  readonly name: string;
  /** 下行 bit/s。0 = 不限速。 */
  readonly downloadBps: number;
  readonly latencyMs: number;
}

const PROFILES: readonly Profile[] = [
  { name: '不限速', downloadBps: 0, latencyMs: 0 },
  { name: '4G     ', downloadBps: 9_000_000, latencyMs: 60 },
  { name: '慢 4G  ', downloadBps: 4_000_000, latencyMs: 120 },
  { name: '3G     ', downloadBps: 1_600_000, latencyMs: 300 },
];

interface Measurement {
  readonly profile: Profile;
  readonly bootedMs: number;
  readonly craftMs: number | null;
  readonly bytesBeforeBoot: number;
  readonly bytesTotal: number;
}

async function measure(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  url: string,
  profile: Profile,
): Promise<Measurement> {
  const context = await browser.newContext({ viewport: { ...VIEWPORT }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: profile.downloadBps === 0 ? -1 : profile.downloadBps / 8,
    uploadThroughput: profile.downloadBps === 0 ? -1 : profile.downloadBps / 8,
    latency: profile.latencyMs,
  });

  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForFunction(() => document.documentElement.dataset['booted'] !== undefined, null, {
    timeout: 180_000,
  });
  const bootedMs = Number(await page.getAttribute('html', 'data-booted'));
  /*
   * 用 Resource Timing 的 `transferSize`,**不是 `response.body().byteLength`**:
   * 后者拿到的是解压之后的字节,而真正决定慢网上要等多久的是**压缩后**在线
   * 上传的量。两者在这个项目里差三倍(3.7 MB vs 1.3 MB),用错的话结论会
   * 整个反过来。
   */
  const bytesBeforeBoot = await transferred(page);

  let craftMs: number | null = null;
  try {
    await page.waitForFunction(
      () => document.documentElement.dataset['craft'] !== undefined,
      null,
      { timeout: 180_000 },
    );
    craftMs = await page.evaluate(() => Math.round(performance.now()));
  } catch {
    craftMs = null;
  }

  const bytesTotal = await transferred(page);
  await context.close();
  return { profile, bootedMs, craftMs, bytesBeforeBoot, bytesTotal };
}

async function main(): Promise<void> {
  await build({ logLevel: 'warn' });
  const server = await preview({
    logLevel: 'warn',
    preview: { host: PREVIEW_HOST, port: PORT, strictPort: true },
  });
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  try {
    const url = previewUrl(PORT);
    const rows: Measurement[] = [];
    for (const profile of PROFILES) {
      rows.push(await measure(browser, url, profile));
    }

    console.log('\n首屏(data-booted = 下载 + 解析 + wasm + 建世界,不含渲染第一帧)\n');
    console.log('网络      可开始画   车模到位   开画前字节   全部字节');
    for (const row of rows) {
      const craft = row.craftMs === null ? '   ——   ' : `${String(row.craftMs).padStart(6)} ms`;
      console.log(
        `${row.profile.name}  ${String(row.bootedMs).padStart(6)} ms  ${craft}  ` +
          `${mib(row.bytesBeforeBoot).padStart(9)}  ${mib(row.bytesTotal).padStart(9)}`,
      );
    }
    console.log('\n目标:3G 一档的「可开始画」进 3000 ms 以内(PLAN M6)。');

    const split = bundleSplit();
    if (split !== null) {
      console.log('\n首屏 JS 的构成(gzip):');
      console.log(`  Rapier 的 wasm(base64 内联) ${String(split.wasmKb).padStart(5)} KB`);
      console.log(`  其余(three.js + 游戏代码)   ${String(split.restKb).padStart(5)} KB`);
      console.log(`  合计                          ${String(split.totalKb).padStart(5)} KB`);
      const share = Math.round((split.wasmKb / split.totalKb) * 100);
      console.log(`  → 物理引擎占 ${String(share)}%;首屏优化剩下的空间都在它身上。`);
    }
    console.log('');
  } finally {
    await browser.close();
    await server.close();
  }
}

async function transferred(page: { evaluate: <T>(fn: () => T) => Promise<T> }): Promise<number> {
  return page.evaluate(() => {
    let total = 0;
    for (const entry of performance.getEntriesByType('resource')) {
      total += (entry as PerformanceResourceTiming).transferSize;
    }
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    return total + (nav?.transferSize ?? 0);
  });
}

/**
 * 首屏 JS 里 Rapier 的 wasm 占多少。
 *
 * `@dimforge/rapier3d-compat` 把 wasm 以 **base64 内联在 JS 里**(CLAUDE.md
 * 记着为什么选这个包而不是独立 `.wasm` 版:后者在 vitest 里 import 不起来,
 * 而"测的和跑的是同一个二进制"是这个项目整套测试的前提)。所以它不是一个
 * 单独的资源,常规的按文件统计看不见它 —— 只能在打包产物里把那一长段
 * base64 找出来单独称重。
 *
 * 这个数决定了首屏优化还有多少空间可谈,值得每次都报一次。
 */
function bundleSplit(): { totalKb: number; wasmKb: number; restKb: number } | null {
  const dir = 'dist/assets';
  const file = readdirSync(dir).find((name) => name.endsWith('.js'));
  if (file === undefined) {
    return null;
  }
  const source = readFileSync(`${dir}/${file}`, 'utf8');
  // wasm 的 base64 以 "AGFzbQEAAAA"(魔数 \0asm)开头,直接找最长的一段连续
  // base64 字符即可 —— 这个包里没有第二段能接近这个长度的字面量。
  let best = 0;
  let bestAt = -1;
  let run = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (/[A-Za-z0-9+/=]/.test(source[i] as string)) {
      if (run === 0) {
        start = i;
      }
      run++;
    } else {
      if (run > best) {
        best = run;
        bestAt = start;
      }
      run = 0;
    }
  }
  if (bestAt < 0) {
    return null;
  }
  const kb = (text: string): number => Math.round(gzipSync(Buffer.from(text)).length / 1024);
  const wasm = source.slice(bestAt, bestAt + best);
  return {
    totalKb: kb(source),
    wasmKb: kb(wasm),
    restKb: kb(source.slice(0, bestAt) + source.slice(bestAt + best)),
  };
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
