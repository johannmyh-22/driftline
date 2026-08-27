/**
 * 「原地打转」诊断探针。
 *
 * 现象(HANDOFF 第十三节):满油门直行 90 帧,yawRate 到 1.98 rad/s、
 * lateralSpeed 5.49 m/s —— 车横着走,方向盘是正的。
 *
 * 这个脚本走 `?test=1&seed=N` 的确定性步进接口,打开轮子级遥测采样,
 * 逐帧 advance 并采样,把每帧每个轮子的接地/悬挂压缩/法向力/滑移 / 力
 * 和整车速度、yawRate、每轮 yaw 力矩来源导出成 CSV + JSON 汇总。
 *
 * **只做诊断,不改任何物理参数。** 结论由人/接手者读取,别让脚本劝自己改数。
 *
 * 用法:
 *   npm run spin-probe -- [--seeds=1337,1,42] [--frames=90] [--no-build]
 *
 * 输出:
 *   - 每个 seed 一份 raw CSV 到 tests/visual/__output__/diagnostics/<seed>.csv
 *   - 汇总 JSON 到同样目录 summary.json
 *   - stdout 打印每轮的分析要点
 */

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { build, preview } from 'vite';
import { Quaternion, Vector3 } from 'three';
import type { FrameTelemetry, WheelTelemetry } from '../src/game/diagnostics';
import { CHROMIUM_ARGS, PREVIEW_HOST, VIEWPORT, previewUrl } from './harness';

/** 全项目只有这一个端口。与 perf/shoot 错开。 */
const PROBE_PORT = 4176;
const BATCH_DIR = 'tests/visual/__output__/diagnostics';

interface ProbeOptions {
  seeds: number[];
  frames: number;
  rebuild: boolean;
  course: 'race' | 'flat';
}

const USAGE = `用法: npm run spin-probe -- [--seeds=1337,1,42] [--frames=90] [--course=race|flat] [--no-build]`;

/** 前 20 帧里找「第一次异常」的范围。见诊断结论。 */
const ANOMALY_WINDOW = 20;

interface FrameRow {
  frame: number;
  seed: number;
  // 整车
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  vForward: number; vLeft: number; vUp: number;
  yaw: number; yawRate: number;
  // 每轮
  wheels: readonly WheelTelemetry[];
  groundSpeed: number;
  // 每轮 yaw 力矩分解
  yawTorque: number[]; // 该轮合计(牛·米,+ = 左转)
  yawLong: number[];   // 其中轮胎纵向力贡献
  yawLat: number[];    // 其中轮胎侧向力贡献
  yawSusp: number[];   // 其中悬挂法向力贡献
  yawTotal: number;    // 四轮合计
  lateralSet: number;  // 当前帧横向速度(右为正)
}

/** 把世界速度转到车身系。车头 +Z、左 +X、上 +Y 与 vehicle.ts 一致。 */
function toBodyFrame(
  vx: number, vy: number, vz: number,
  q: { x: number; y: number; z: number; w: number },
): { forward: number; left: number; up: number } {
  const qInv = new Quaternion(-q.x, -q.y, -q.z, q.w).normalize();
  const vw = new Vector3(vx, vy, vz);
  vw.applyQuaternion(qInv);
  // local: +Z = 车头(forward),+X = 左,+Y = 上。
  return { forward: vw.z, left: vw.x, up: vw.y };
}

/** 单轮对 yaw(绕世界 +Y)的力矩= (r × F)·(0,1,0) = r_z·F_x − r_x·F_z。 */
function yawMomentAboutUp(
  contact: { x: number; y: number; z: number },
  com: { x: number; y: number; z: number },
  forceWorld: { x: number; y: number; z: number },
): number {
  const rz = contact.z - com.z;
  const rx = contact.x - com.x;
  return rz * forceWorld.x - rx * forceWorld.z;
}

function yawMomentOfTire(
  w: WheelTelemetry,
  com: { x: number; y: number; z: number },
): { total: number; longitudinal: number; lateral: number } {
  const rz = w.pz - com.z;
  const rx = w.px - com.x;
  // 轮胎世界力 = wf·fx + wl·fy;利用同一根力臂分别算两个来源的 yaw 力矩。
  const long = rz * (w.wfX * w.fx) - rx * (w.wfZ * w.fx);
  const lat = rz * (w.wlX * w.fy) - rx * (w.wlZ * w.fy);
  return { total: long + lat, longitudinal: long, lateral: lat };
}

interface Collected {
  rows: readonly FrameRow[];
  /** 前 ANOMALY_WINDOW 帧里 |yawRate| 第一次超 0.05 rad/s 的帧号(车开始真的在转)。 */
  firstAnomalous: number | null;
  /** |yawRate| 第一次超 0.2 rad/s 的帧号(转速开始失控)。 */
  firstEscalated: number | null;
  /** |yawRate| 峰值的帧号。 */
  peakYawFrame: number;
  peakYawRate: number;
  peakLateralSpeed: number;
}

function analyse(rows: readonly FrameRow[]): Collected {
  let firstAnomalous: number | null = null;
  let firstEscalated: number | null = null;
  let peakYawFrame = -1;
  let peakYawRate = 0;
  let peakLateralSpeed = 0;
  for (const row of rows) {
    if (row.frame <= ANOMALY_WINDOW) {
      if (firstAnomalous === null && Math.abs(row.yawRate) > 0.05) {
        firstAnomalous = row.frame;
      }
      if (firstEscalated === null && Math.abs(row.yawRate) > 0.2) {
        firstEscalated = row.frame;
      }
    }
    if (Math.abs(row.yawRate) > Math.abs(peakYawRate)) {
      peakYawRate = Math.abs(row.yawRate);
      peakYawFrame = row.frame;
    }
    peakLateralSpeed = Math.max(peakLateralSpeed, Math.abs(row.lateralSet));
  }
  return { rows, firstAnomalous, firstEscalated, peakYawFrame, peakYawRate, peakLateralSpeed };
}

/** 哪种来源主导了峰值帧的 yaw。返回 "tire-long" / "tire-lat" / "susp" / 组合。 */
function dominantYawTerm(row: FrameRow | undefined): string {
  if (row === undefined) {
    return 'n/a';
  }
  const longSum = row.yawLong.reduce((s, v) => s + Math.abs(v), 0);
  const latSum = row.yawLat.reduce((s, v) => s + Math.abs(v), 0);
  const suspSum = row.yawSusp.reduce((s, v) => s + Math.abs(v), 0);
  const best = Math.max(longSum, latSum, suspSum);
  if (best < 1e-6) {
    return 'none';
  }
  if (best === longSum) {
    return 'tire-longitudinal';
  }
  if (best === latSum) {
    return 'tire-lateral';
  }
  return 'suspension';
}

function csvHeader(): string {
  const wheel = (suffix: string): string => {
    const parts: string[] = [];
    for (let i = 0; i < 4; i++) {
      for (const field of ['grounded', 'length', 'compression', 'load', 'slipRatio', 'slipAngle', 'fx', 'fy', 'px', 'pz']) {
        parts.push(`w${i}${field}${suffix}`);
      }
    }
    return parts.join(',');
  };
  return [
    'frame', 'seed', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'vForward', 'vLeft', 'vUp',
    'yaw', 'yawRate', 'groundSpeed', 'lateralSpeed',
    wheel(''),
    'yawTorque0', 'yawTorque1', 'yawTorque2', 'yawTorque3',
    'yawLong0', 'yawLong1', 'yawLong2', 'yawLong3',
    'yawLat0', 'yawLat1', 'yawLat2', 'yawLat3',
    'yawSusp0', 'yawSusp1', 'yawSusp2', 'yawSusp3',
    'yawTotal',
  ].join(',');
}

function csvRow(row: FrameRow): string {
  const nums: number[] = [];
  const pick = (v: boolean | number): number => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
  for (const w of row.wheels) {
    for (const v of [
      pick(w.grounded), w.length, w.compression, w.load, w.slipRatio, w.slipAngle,
      w.fx, w.fy, w.px, w.pz,
    ]) {
      nums.push(v);
    }
  }
  const sig = (v: number): string => {
    if (!Number.isFinite(v)) {
      return 'NaN';
    }
    return Math.abs(v) < 1e-9 ? '0' : v.toFixed(6);
  };
  return [
    row.frame, row.seed,
    sig(row.x), sig(row.y), sig(row.z),
    sig(row.vx), sig(row.vy), sig(row.vz),
    sig(row.vForward), sig(row.vLeft), sig(row.vUp),
    sig(row.yaw), sig(row.yawRate), sig(row.groundSpeed), sig(row.lateralSet),
    ...nums.map(sig),
    ...row.yawTorque.map(sig),
    ...row.yawLong.map(sig),
    ...row.yawLat.map(sig),
    ...row.yawSusp.map(sig),
    sig(row.yawTotal),
  ].join(',');
}

function printSeedSummary(seed: number, c: Collected): void {
  const peakRow = c.rows.find((r) => r.frame === c.peakYawFrame);
  const dom = dominantYawTerm(peakRow);
  // wheels 顺序:0=前左(FL) 1=前右(FR) 2=后左(RL) 3=后右(RR)。
  const wheelContrib = (peakRow?.yawTorque ?? [0, 0, 0, 0]).map((v) => v.toFixed(1)).join(' / ');
  process.stdout.write(
    [
      `seed ${seed}  帧 ${String(c.rows.length)}`,
      `  前20帧里 |yawRate|>0.05 第一次在 第 ${c.firstAnomalous === null ? '未出现' : String(c.firstAnomalous)} 帧`,
      `  |yawRate|>0.2 第一次在 第 ${c.firstEscalated === null ? '未出现' : String(c.firstEscalated)} 帧`,
      `  峰值 |yawRate| ${c.peakYawRate.toFixed(3)} rad/s @ 第 ${c.peakYawFrame} 帧`,
      `  峰值 |lateralSpeed| ${c.peakLateralSpeed.toFixed(3)} m/s`,
      `  峰值帧 yaw 力矩来源(FL/FR/RL/RR,牛·米):${wheelContrib}`,
      `  主导 yaw 项:${dom}`,
      `  第 ${c.peakYawFrame} 帧每轮 (fy 侧向力, slipAngle):` +
        (peakRow?.wheels.map((w) => `(${w.fy.toFixed(0)}N, ${w.slipAngle.toFixed(3)})`).join(', ') ?? ''),
      '',
    ].join('\n'),
  );
}

async function runSeed(
  page: import('@playwright/test').Page,
  baseUrl: string,
  seed: number,
  outputs: Collected[],
): Promise<void> {
  const courseSuffix = options.course === 'flat' ? '&course=flat' : '';
  await page.goto(`${baseUrl}?test=1&seed=${seed}${courseSuffix}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__DRIFTLINE_TEST__ !== undefined);
  await page.evaluate(async () => {
    const api = window.__DRIFTLINE_TEST__!;
    await api.ready;
    api.setTelemetryEnabled(true);
    api.setInput({ throttle: 1, steer: 0, reverse: 0, airBrake: 0 });
  });

  const rows: FrameRow[] = [];
  for (let frame = 1; frame <= options.frames; frame++) {
    const data = await page.evaluate(() => {
      const api = window.__DRIFTLINE_TEST__!;
      api.advance(1);
      const tel: FrameTelemetry = api.readVehicleTelemetry();
      const snap = api.snapshot();
      return { tel, snap };
    });
    const t = data.tel;
    const { forward, left, up } = toBodyFrame(t.vx, t.vy, t.vz, { x: t.qx, y: t.qy, z: t.qz, w: t.qw });
    const com = { x: t.x, y: t.y, z: t.z };
    const yawTorque: number[] = [];
    const yawLong: number[] = [];
    const yawLat: number[] = [];
    const yawSusp: number[] = [];
    for (let i = 0; i < t.wheels.length; i++) {
      const w = t.wheels[i];
      const applied = t.applied[i];
      if (w === undefined || applied === undefined) {
        yawTorque.push(0);
        yawLong.push(0);
        yawLat.push(0);
        yawSusp.push(0);
        continue;
      }
      const tire = yawMomentOfTire(w, com);
      const total = yawMomentAboutUp(
        { x: applied.px, y: applied.py, z: applied.pz },
        com,
        { x: applied.fx, y: applied.fy, z: applied.fz },
      );
      // applied = suspension + tire,所以 suspension = total − tire。
      yawTorque.push(total);
      yawLong.push(tire.longitudinal);
      yawLat.push(tire.lateral);
      yawSusp.push(total - tire.longitudinal - tire.lateral);
    }
    const row: FrameRow = {
      frame,
      seed,
      x: t.x, y: t.y, z: t.z,
      vx: t.vx, vy: t.vy, vz: t.vz,
      vForward: forward, vLeft: left, vUp: up,
      yaw: t.yaw, yawRate: t.yawRate,
      wheels: t.wheels,
      groundSpeed: Math.hypot(t.vx, t.vz),
      yawTorque,
      yawLong,
      yawLat,
      yawSusp,
      yawTotal: yawTorque.reduce((s, v) => s + v, 0),
      lateralSet: -left,
    };
    rows.push(row);
  }
  outputs.push(analyse(rows));
}

async function main(): Promise<void> {
  if (options.rebuild) {
    await build({ logLevel: 'warn' });
  }

  let server: Awaited<ReturnType<typeof preview>> | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  const outputs: Collected[] = [];

  try {
    server = await preview({
      logLevel: 'warn',
      preview: { host: PREVIEW_HOST, port: PROBE_PORT, strictPort: true },
    });
    // 若无 --no-build 则走刚构建的产物;preview 会 serve dist/。

    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    const context = await browser.newContext({
      viewport: { ...VIEWPORT },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const baseUrl = previewUrl(PROBE_PORT);

    for (const seed of options.seeds) {
      await runSeed(page, baseUrl, seed, outputs);
    }

    // 写 CSV 与 JSON 汇总。
    fs.mkdirSync(BATCH_DIR, { recursive: true });
    for (const c of outputs) {
      const seed = c.rows[0]?.seed ?? 0;
      const csv = [csvHeader(), ...c.rows.map(csvRow)].join('\n');
      fs.writeFileSync(path.join(BATCH_DIR, `seed${seed}.csv`), `${csv}\n`);
    }
    fs.writeFileSync(
      path.join(BATCH_DIR, 'summary.json'),
      `${JSON.stringify(
        outputs.map((c) => ({
          seed: c.rows[0]?.seed ?? 0,
          course: options.course,
          frames: c.rows.length,
          firstAnomalous: c.firstAnomalous,
          firstEscalated: c.firstEscalated,
          peakYawFrame: c.peakYawFrame,
          peakYawRate: c.peakYawRate,
          peakLateralSpeed: c.peakLateralSpeed,
          dominantTermAtPeak:
            dominantYawTerm(c.rows.find((r) => r.frame === c.peakYawFrame)),
          lastFrame: c.rows[c.rows.length - 1]
            ? {
                groundSpeed: c.rows[c.rows.length - 1]!.groundSpeed,
                yawRate: c.rows[c.rows.length - 1]!.yawRate,
                lateralSpeed: c.rows[c.rows.length - 1]!.lateralSet,
              }
            : null,
        })),
        null,
        2,
      )}\n`,
    );

    process.stdout.write(`\nCSV 已写入 ${path.resolve(BATCH_DIR)}/\n`);
    for (const c of outputs) {
      printSeedSummary(c.rows[0]?.seed ?? 0, c);
    }
  } finally {
    await browser?.close();
    await server?.close();
  }
}

const options = parseArgs(process.argv.slice(2));
void main();

function parseArgs(argv: readonly string[]): ProbeOptions {
  const opts: ProbeOptions = { seeds: [1337, 1, 42], frames: 90, rebuild: true, course: 'race' };
  for (const arg of argv) {
    if (arg === '--no-build') {
      opts.rebuild = false;
      continue;
    }
    const match = /^--([a-z]+)=(.*)$/.exec(arg);
    if (match === null) {
      throw new Error(`无法解析参数 "${arg}"\n${USAGE}`);
    }
    const [, key = '', value = ''] = match;
    switch (key) {
      case 'seeds':
        opts.seeds = value.split(',').map((s) => {
          const n = Number.parseInt(s, 10);
          if (!Number.isInteger(n)) {
            throw new Error(`seed 需要整数,收到 "${s}"`);
          }
          return n;
        });
        break;
      case 'frames':
        opts.frames = requireInt(value, 'frames');
        break;
      case 'course':
        if (value !== 'race' && value !== 'flat') {
          throw new Error(`--course 需要 race 或 flat,收到 "${value}"`);
        }
        opts.course = value;
        break;
      default:
        throw new Error(`未知参数 "--${key}"\n${USAGE}`);
    }
  }
  if (opts.frames < 1) {
    throw new Error('--frames 至少要 1');
  }
  return opts;
}

function requireInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} 需要非负整数,收到 "${value}"`);
  }
  return parsed;
}
