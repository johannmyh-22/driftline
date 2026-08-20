import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages project site 挂在 /driftline/ 下,资源必须走相对于该前缀的路径。
  base: '/driftline/',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    // three.js 单包就 500kB+,拆包与懒加载是 M6 性能里程碑的事,现在只是别让告警刷屏。
    chunkSizeWarningLimit: 900,
  },
});
