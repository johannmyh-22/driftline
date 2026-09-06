/*
 * Lighthouse 检查(M6 清单的最后一格)。
 *
 * **一次性脚本,不进构建流程也不进 devDependencies。** 和
 * `scripts/buildCarModel.mjs` 同一类:lighthouse 连着 chrome-launcher 一大串
 * 依赖,为了偶尔跑一次把它们钉进 lockfile 不划算。留在仓库里是为了让「怎么
 * 跑的、看哪几个数」可复现。
 *
 * 用法:
 *   npm run build
 *   npx vite preview --host 127.0.0.1 --port 4177 --strictPort &
 *   npm i --no-save lighthouse
 *   node scripts/lighthouse.mjs
 *
 * ## 只看无障碍和最佳实践,**性能分不要看**
 *
 * 这个环境没有 GPU,WebGL 走 SwiftShader,主线程工作实测 182 秒 —— Lighthouse
 * 的性能分在这里量的是软件渲染器,不是这个项目。第二次跑还直接把 DevTools
 * 协议拖超时(PROTOCOL_TIMEOUT),整份报告作废。
 *
 * 首屏那一段用 `npm run loadtime`(限速 + Resource Timing,量的是网络与解析),
 * 帧时间用 `npm run perf`。这两个才是这个项目里说得清的指标。
 *
 * ## 2026-08 这次跑出来的两条,都已经修掉
 *
 * 1. `/favicon.ico` 404 —— 浏览器不给图标就自己去要。修法是内联 SVG data URI,
 *    **不放图标文件**(CLAUDE.md 第一条:仓库里只有文本文件,favicon 恰恰是
 *    最容易被顺手破例的那个)。
 * 2. 拿不到 GPU 时 three 抛「Error creating WebGL context.」,原样糊在屏幕上
 *    对用户等于没说。现在 `core/fatalMessage.ts` 给这一类单独一句人话。
 *
 * 无障碍两次都是 **100**。
 */
import { spawn } from 'node:child_process';

const url = process.argv[2] ?? 'http://127.0.0.1:4177/driftline/';
const args = [
  'lighthouse',
  url,
  '--quiet',
  '--output=json',
  '--output-path=lighthouse-report.json',
  '--only-categories=accessibility,best-practices',
  '--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage',
];
console.log(`npx ${args.join(' ')}`);
spawn('npx', args, { stdio: 'inherit', env: { ...process.env, CHROME_PATH: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium' } });
