import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { build, preview } from 'vite';
import {
  CHROMIUM_ARGS,
  OUTPUT_DIR,
  PREVIEW_HOST,
  SHOOT_PORT,
  VIEWPORT,
  driveScene,
  previewUrl,
} from './harness';

interface ShootOptions {
  seed: number;
  frames: number;
  camera: string;
  out: string | null;
  rebuild: boolean;
  throttle: number;
  steer: number;
  brake: number;
}

const USAGE = `用法: npm run shoot -- [--seed=42] [--frames=120] [--camera=chase]
                     [--throttle=1] [--steer=0] [--brake=0] [--out=name.png] [--no-build]
机位: chase(玩家视角) / side / front / top`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.rebuild) {
    await build({ logLevel: 'warn' });
  }

  // 先声明再赋值:任何一步失败都要走到 finally 把 preview server 关掉,
  // 否则进程会挂在那里等一个永远不会来的连接。
  let server: Awaited<ReturnType<typeof preview>> | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  const problems: string[] = [];

  try {
    server = await preview({
      logLevel: 'warn',
      preview: { host: PREVIEW_HOST, port: SHOOT_PORT, strictPort: true },
    });

    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    const context = await browser.newContext({
      viewport: { ...VIEWPORT },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    page.on('console', (message) => {
      if (message.type() === 'error') {
        problems.push(`console.error: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      problems.push(`pageerror: ${error.message}`);
    });

    const snapshot = await driveScene(page, previewUrl(SHOOT_PORT), {
      seed: options.seed,
      frames: options.frames,
      camera: options.camera,
      input: { throttle: options.throttle, steer: options.steer, airBrake: options.brake },
    });

    await mkdir(OUTPUT_DIR, { recursive: true });
    const name =
      options.out ?? `${options.camera}-seed${options.seed}-f${options.frames}.png`;
    const file = path.join(OUTPUT_DIR, name);
    await page.screenshot({ path: file });

    process.stdout.write(`${file}\n${JSON.stringify(snapshot)}\n`);
  } finally {
    await browser?.close();
    await server?.close();
  }

  for (const problem of problems) {
    process.stderr.write(`${problem}\n`);
  }
  if (problems.length > 0) {
    throw new Error(`页面报了 ${problems.length} 条错误,截图不可信`);
  }
}

function parseArgs(argv: readonly string[]): ShootOptions {
  const options: ShootOptions = {
    seed: 42,
    frames: 120,
    camera: 'chase',
    out: null,
    rebuild: true,
    throttle: 1,
    steer: 0,
    brake: 0,
  };

  for (const arg of argv) {
    if (arg === '--no-build') {
      options.rebuild = false;
      continue;
    }
    const match = /^--([a-z]+)=(-?[\w.\-]*)$/.exec(arg);
    if (match === null) {
      throw new Error(`无法解析参数 "${arg}"\n${USAGE}`);
    }
    const [, key = '', value = ''] = match;
    switch (key) {
      case 'seed':
        options.seed = requireInteger(value, 'seed');
        break;
      case 'frames':
        options.frames = requireInteger(value, 'frames');
        break;
      case 'camera':
        options.camera = value;
        break;
      case 'out':
        options.out = value;
        break;
      case 'throttle':
        options.throttle = requireNumber(value, 'throttle');
        break;
      case 'steer':
        options.steer = requireNumber(value, 'steer');
        break;
      case 'brake':
        options.brake = requireNumber(value, 'brake');
        break;
      default:
        throw new Error(`未知参数 "--${key}"\n${USAGE}`);
    }
  }

  return options;
}

function requireNumber(value: string, name: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} 需要数字,收到 "${value}"`);
  }
  return parsed;
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
