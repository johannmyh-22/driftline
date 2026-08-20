import { defineConfig } from '@playwright/test';
import { CHROMIUM_ARGS, VIEWPORT, VISUAL_TEST_PORT, previewUrl } from './scripts/harness';

export default defineConfig({
  testDir: 'tests/visual',
  outputDir: 'test-results',
  // SwiftShader 是纯 CPU 渲染,并行 worker 只会互相抢核,反而更慢更容易超时。
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  timeout: 120_000,
  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: previewUrl(VISUAL_TEST_PORT),
    browserName: 'chromium',
    viewport: { ...VIEWPORT },
    deviceScaleFactor: 1,
    launchOptions: { args: CHROMIUM_ARGS },
  },
  webServer: {
    command: `npm run build && npm run preview -- --port ${VISUAL_TEST_PORT} --strictPort`,
    url: previewUrl(VISUAL_TEST_PORT),
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
