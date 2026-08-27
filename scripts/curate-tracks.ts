/**
 * 精选赛道扫描器(M5)。**只做测量,不改任何生成器/物理参数,输出留给人手动
 * 誊进 `src/game/curatedTracks.ts`。**
 *
 * 目的:`generateTrack()` 保证「每个 seed 都能生成出合格赛道」,但「合格」
 * 不等于「有代表性/好玩」——退化成近似正圆的赛道也合格。这个脚本用两道筛子
 * 从一批候选 seed 里挑出更有代表性的几条:
 *
 *   1. `layout.attempts === 1`:第一次就通过校验,意味着控制点的随机幅度
 *      没被收紧过,弯道形状更「原生」。
 *   2. 总长落在 2.6~3.8 km(参考 HANDOFF 第六节「赛道长度 2.8–3.4 km」那条
 *      验收数据,两头各放宽一点给挑选留余地)。
 *
 * 筛过之后按主题(`palette.ts` 的三套 `THEMES`)分组,每套主题挑不超过 2 条。
 *
 * **目标时间的来源(2026-08 改,现实参照校准)不是这个脚本算出来的**——
 * 是 Alpine A110 官方纽博格林北环圈速换算的配速(`REAL_PACE_S_PER_KM`,
 * 见 `curatedTracks.ts` 的类注释与 `docs/CLAUDE.md`「现实参照」一节)乘赛道
 * 长度。`Autopilot`(M2 的验收循迹器,保守、不甩尾)在这里**只做可行性
 * 校验**——证明这条赛道确实能在合理时间内跑完,不是拿它的圈速当目标来源:
 * 它偏保守,拿它的时间乘系数得到的目标会随车辆性能调整而漂移,不如直接钉
 * 在真实数据上稳。
 *
 * 用法:
 *   npm run curate-tracks
 *   npm run curate-tracks -- --range=800 --perTheme=3
 */
import process from 'node:process';
import { createInputFrame } from '../src/core/input';
import { FIXED_DT } from '../src/core/loop';
import { Rng } from '../src/core/rng';
import { Autopilot } from '../src/game/autopilot';
import { Course } from '../src/game/course';
import { Physics, initPhysics } from '../src/game/physics';
import { Race } from '../src/game/race';
import { generateTrack } from '../src/game/trackLayout';
import { Vehicle } from '../src/game/vehicle';
import { createPalette } from '../src/gfx/palette';

/**
 * Alpine A110(2017 基础版)纽博格林北环官方圈速 8:03(483s)/ 20.832km。
 * 来源与信心等级见 `docs/CLAUDE.md`「现实参照」一节。
 */
const REAL_PACE_S_PER_KM = 483 / 20.832;
const MIN_LENGTH = 2600;
const MAX_LENGTH = 3800;
/** 一圈最多推进这么多帧(200 秒)还没完赛就放弃,免得卡死在异常 seed 上。 */
const MAX_FRAMES = 12_000;

interface Candidate {
  seed: number;
  theme: string;
  totalLength: number;
  attempts: number;
}

interface Timed extends Candidate {
  autopilotLapTime: number | null;
  targetLapTime: number | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await initPhysics();

  const candidates: Candidate[] = [];
  for (let seed = 1; seed <= args.range; seed++) {
    const rng = new Rng(seed);
    const palette = createPalette(rng.fork());
    const layout = generateTrack(rng.fork());
    if (layout.attempts !== 1) {
      continue;
    }
    if (layout.totalLength < MIN_LENGTH || layout.totalLength > MAX_LENGTH) {
      continue;
    }
    candidates.push({
      seed,
      theme: palette.themeName,
      totalLength: layout.totalLength,
      attempts: layout.attempts,
    });
  }

  const byTheme = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byTheme.get(c.theme) ?? [];
    list.push(c);
    byTheme.set(c.theme, list);
  }

  const selected: Candidate[] = [];
  for (const [, list] of byTheme) {
    // 按总长挑中位数附近的几条——太短没内容,太长偏离验收过的量级。
    list.sort((a, b) => a.totalLength - b.totalLength);
    const mid = Math.floor(list.length / 2);
    const spread: Candidate[] = [];
    for (let i = 0; i < list.length && spread.length < args.perTheme; i++) {
      const idx = (mid + i * 7) % list.length; // 隔开取样,避免总长扎堆
      const item = list[idx];
      if (item !== undefined && !spread.includes(item)) {
        spread.push(item);
      }
    }
    selected.push(...spread);
  }

  const timed: Timed[] = [];
  for (const c of selected) {
    const lapTime = runAutopilotLap(c.seed);
    const targetLapTime = Math.round((c.totalLength / 1000) * REAL_PACE_S_PER_KM * 100) / 100;
    timed.push({
      ...c,
      autopilotLapTime: lapTime,
      targetLapTime: lapTime === null ? null : targetLapTime,
    });
  }

  timed.sort((a, b) => a.theme.localeCompare(b.theme) || a.seed - b.seed);

  process.stdout.write(`扫了 seed 1..${args.range},候选(attempts=1 且 ${MIN_LENGTH}-${MAX_LENGTH}m)${candidates.length} 条\n`);
  process.stdout.write(`按主题分组:${Array.from(byTheme.entries()).map(([t, l]) => `${t}=${l.length}`).join(', ')}\n\n`);
  for (const t of timed) {
    const lapText = t.autopilotLapTime === null ? '未完赛(异常,别用,可行性校验没过)' : `${t.autopilotLapTime.toFixed(2)}s(仅可行性校验)`;
    const targetText = t.targetLapTime === null ? '—' : `${t.targetLapTime.toFixed(2)}s`;
    process.stdout.write(
      `seed=${t.seed}\t主题=${t.theme}\t长度=${t.totalLength.toFixed(0)}m\t` +
        `autopilot=${lapText}\t目标(真实配速)=${targetText}\n`,
    );
  }
}

function runAutopilotLap(seed: number): number | null {
  const rng = new Rng(seed);
  createPalette(rng.fork());
  const layout = generateTrack(rng.fork());
  const course = new Course(layout, rng.fork());
  const physics = new Physics();
  const vehicle = new Vehicle(course, physics);
  const race = new Race(layout);
  const pilot = new Autopilot(layout);

  const start = layout.samples[0];
  if (start === undefined) {
    return null;
  }
  vehicle.reset(start.x, start.z, Math.atan2(start.tangentX, start.tangentZ));

  const input = createInputFrame();
  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    pilot.drive(vehicle, input);
    vehicle.update(input, FIXED_DT);
    race.update(vehicle, FIXED_DT);
    if (race.laps >= 1) {
      return race.lastLapTime;
    }
  }
  return null;
}

function parseArgs(argv: readonly string[]): { range: number; perTheme: number } {
  let range = 500;
  let perTheme = 2;
  for (const arg of argv) {
    const match = /^--([a-z]+)=(\d+)$/.exec(arg);
    if (match === null) {
      continue;
    }
    const [, key, value] = match;
    if (key === 'range') {
      range = Number.parseInt(value ?? '', 10);
    } else if (key === 'perTheme') {
      perTheme = Number.parseInt(value ?? '', 10);
    }
  }
  return { range, perTheme };
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
