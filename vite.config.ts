import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

/**
 * 构建标识,显示在左下角读数条上。
 *
 * 人类试玩时要能一眼确认「我开的是不是刚推的那一版」—— 手感改动经常只差一点,
 * 光靠感觉分辨不出新旧。提交数是单调递增的,比 SHA 更容易口头对齐。
 */
function buildId(): string {
  try {
    const count = execSync('git rev-list --count HEAD').toString().trim();
    const sha = execSync('git rev-parse --short HEAD').toString().trim();
    return `#${count} ${sha}`;
  } catch {
    // 没有 git(比如从压缩包解出来构建)不该让构建挂掉。
    return '#dev';
  }
}

export default defineConfig({
  // GitHub Pages project site 挂在 /driftline/ 下,资源必须走相对于该前缀的路径。
  base: '/driftline/',
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    // three.js 单包就 500kB+,拆包与懒加载是 M6 性能里程碑的事,现在只是别让告警刷屏。
    chunkSizeWarningLimit: 900,
  },
});
