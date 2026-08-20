import type { Page } from '@playwright/test';

/** Playwright 与 `npm run shoot` 各起一个 preview,端口错开,互不打架。 */
export const VISUAL_TEST_PORT = 4173;
export const SHOOT_PORT = 4174;

/** 与 `vite.config.ts` 的 `base` 保持一致。 */
export const BASE_PATH = '/driftline/';

/**
 * preview server 的绑定地址,同时也是探测地址 —— 必须是同一个常量。
 *
 * 不能用 vite 默认的 `localhost`:Node 17 起 DNS 按 verbatim 顺序返回,
 * 在有 IPv6 的机器上(比如 GitHub runner)`localhost` 先解析成 `::1`,
 * preview 就只监听 IPv6,而探测方连的是 `127.0.0.1`,直接连不上。
 * 本地没有 IPv6 的环境反而一切正常,于是这个坑只在 CI 里炸。
 */
export const PREVIEW_HOST = '127.0.0.1';

export const OUTPUT_DIR = 'tests/visual/__output__';

export const VIEWPORT = { width: 1280, height: 720 } as const;

/**
 * CI runner 没有 GPU。这四个 flag 缺一个,`getContext('webgl2')` 就会返回 null,
 * 画面直接变黑屏 —— 别删。
 */
export const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-lcd-text',
];

export function previewUrl(port: number): string {
  return `http://${PREVIEW_HOST}:${port}${BASE_PATH}`;
}

export interface SceneOptions {
  seed: number;
  frames: number;
  camera: string;
}

/**
 * 把页面推进到一个确定的状态。
 *
 * 全程不用 `waitForTimeout`:等的是 `ready` 和显式的 `advance()`,
 * 所以同样的参数在任何机器上都得到同一帧。
 */
export async function driveScene(
  page: Page,
  baseUrl: string,
  options: SceneOptions,
): Promise<Record<string, number>> {
  await page.goto(`${baseUrl}?test=1&seed=${options.seed}`, { waitUntil: 'load' });

  await page.waitForFunction(() => window.__DRIFTLINE_TEST__ !== undefined);
  await page.evaluate(async () => {
    const api = window.__DRIFTLINE_TEST__;
    if (api === undefined) {
      throw new Error('__DRIFTLINE_TEST__ 未挂载');
    }
    await api.ready;
  });

  return page.evaluate((opts: SceneOptions) => {
    const api = window.__DRIFTLINE_TEST__;
    if (api === undefined) {
      throw new Error('__DRIFTLINE_TEST__ 未挂载');
    }
    api.setCamera(opts.camera);
    api.advance(opts.frames);
    return api.snapshot();
  }, options);
}
