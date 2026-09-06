import { beforeAll, describe, expect, it } from 'vitest';
import { type InputFrame, createInputFrame } from '../../src/core/input';
import { clamp } from '../../src/core/mathx';
import { FIXED_DT } from '../../src/core/loop';
import { Rng } from '../../src/core/rng';
import { CarCondition } from '../../src/game/condition';
import { Course } from '../../src/game/course';
import { FuelTank } from '../../src/game/fuel';
import { createGroundHit } from '../../src/game/groundQuery';
import {
  type PitService,
  PitStop,
  createPitLane,
  insidePitBox,
  insidePitLane,
  pitBoxCentre,
  pitLaneWidthAt,
  pitLimiterScale,
  pitRowIndex,
  pitWallAtRow,
  planService,
  rowAtArc,
} from '../../src/game/pitLane';
import { Physics, initPhysics } from '../../src/game/physics';
import { Race } from '../../src/game/race';
import { RacingPilot } from '../../src/game/racingPilot';
import { type TrackLayout, generateTrack } from '../../src/game/trackLayout';
import { PIT, RACING_AI, TRACK } from '../../src/game/tuning';
import { Vehicle } from '../../src/game/vehicle';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 维修道(2026-09,取代 B3 那版路肩折中)。
 *
 * 这一版是真的一条平行车道:独立路面、隔离墙、入口/限速区/出口,而且跨过
 * 终点线。最容易写错、错了只有玩起来才发现的几条:
 *
 * 1. **维修道必须是合法路面**(`onTrack`)。不是的话在里面跑会被出界回收
 *    传送走,而且那一圈根本不算数 —— 圈数判定读的就是 `onTrack`。
 * 2. **隔离墙的缺口和物理走廊的开口必须是同一批行**。差一行就是一堵看不见
 *    的墙,或者一段看得见却拦不住的墙。
 * 3. **限速器不替你刹车**。它只切驱动力矩,和真机上那颗按钮一样。
 * 4. **作业完之后不能立刻回到 idle**,车还停在车位里,会无限循环。
 * ══════════════════════════════════════════════════════════════════════════
 */

const DT = 1 / 60;

function makeCourse(seed = 42): Course {
  const rng = new Rng(seed);
  const layout = generateTrack(rng.fork());
  const lane = createPitLane(layout, layout.halfWidth + TRACK.shoulderWidth);
  return new Course(layout, rng.fork(), lane);
}

/** 一直喂 `inside`/`speed`,跑 `seconds` 秒,返回每一帧是否在作业。 */
function run(
  stop: PitStop,
  seconds: number,
  inside: boolean,
  speed: number,
  service: PitService,
): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < seconds / DT; i++) {
    out.push(stop.update(DT, inside, speed, () => service));
  }
  return out;
}

const SERVICE: PitService = { refuelLitres: 4, changeTires: true, repair: false, seconds: 10 };

describe('createPitLane 的走向', () => {
  const course = makeCourse();
  const lane = course.pit;
  if (lane === null) {
    throw new Error('测试赛道应该带维修道');
  }

  it('**跨过终点线**:入口在线前、出口在线后', () => {
    // 入口的行号靠近整圈末尾,出口的行号靠近 0 —— 也就是这条道绕过了 arc 0。
    expect(lane.entryRow).toBeGreaterThan(lane.exitRow);
    expect(lane.entryRow * lane.spacing).toBeCloseTo(
      lane.trackLength - PIT.entryBeforeLine,
      -1,
    );
    expect(lane.exitRow * lane.spacing).toBeCloseTo(PIT.exitAfterLine, -1);
    // 起跑线那一行一定在这条道上,否则"跨过终点线"就是句空话。
    expect(pitRowIndex(lane, 0)).toBeGreaterThanOrEqual(0);
  });

  it('压在赛道外面,不占赛车线', () => {
    // 内缘就是条带外缘 —— 两块面在这里接上,不留台阶。
    expect(lane.lateralMin).toBeCloseTo(course.outerHalfWidth, 9);
    expect(lane.lateralMax - lane.lateralMin).toBeCloseTo(PIT.laneWidth, 9);
    // 车位在外侧一半,内侧留给快车道。
    expect(lane.boxLateralMin).toBeGreaterThan(lane.lateralMin);
    expect(lane.boxLateralMin).toBeLessThan(lane.lateralMax);
  });

  it('隔离墙两端各有一个缺口,中间是连续的', () => {
    // 入口那一行没有墙(引道),隔离墙起点那一行有。
    expect(pitWallAtRow(lane, lane.entryRow)).toBe(false);
    expect(pitWallAtRow(lane, lane.exitRow)).toBe(false);
    expect(pitWallAtRow(lane, lane.wallStartRow)).toBe(true);
    expect(pitWallAtRow(lane, lane.wallEndRow)).toBe(true);
    // 墙这一段中间不能断。
    const span = (lane.wallEndRow - lane.wallStartRow + lane.rowCount) % lane.rowCount;
    for (let i = 0; i <= span; i++) {
      expect(pitWallAtRow(lane, (lane.wallStartRow + i) % lane.rowCount)).toBe(true);
    }
    // 赛道上离维修道十万八千里的地方当然没有"维修道的墙"这回事。
    const far = (lane.entryRow - 50 + lane.rowCount) % lane.rowCount;
    expect(pitWallAtRow(lane, far)).toBe(false);
  });

  it('车位落在隔离墙这一段里 —— 不能露在引道上', () => {
    expect(pitWallAtRow(lane, lane.boxStartRow)).toBe(true);
    expect(pitWallAtRow(lane, lane.boxEndRow)).toBe(true);
  });

  it('区内区外判得对', () => {
    const c = pitBoxCentre(lane);
    expect(insidePitLane(lane, c.arc, c.lateral)).toBe(true);
    expect(insidePitBox(lane, c.arc, c.lateral)).toBe(true);
    // 赛车线上(横向 0)既不在道里也不在车位里。
    expect(insidePitLane(lane, c.arc, 0)).toBe(false);
    expect(insidePitBox(lane, c.arc, 0)).toBe(false);
    // 快车道上不算车位 —— 从旁边开过去不该触发进站。
    expect(insidePitLane(lane, c.arc, lane.lateralMin + 1)).toBe(true);
    expect(insidePitBox(lane, c.arc, lane.lateralMin + 1)).toBe(false);
    // 另一侧不算。
    expect(insidePitLane(lane, c.arc, -c.lateral)).toBe(false);
    // 弧长离得远也不算。
    const away = ((lane.entryRow - 20 + lane.rowCount) % lane.rowCount) * lane.spacing;
    expect(insidePitLane(lane, away, c.lateral)).toBe(false);
  });

  it('rowAtArc 和 Course 内部的行号是同一个数 —— 不然边界会差一行', () => {
    const samples = course.layout.samples;
    const hit = createGroundHit();
    for (const row of [0, 7, lane.entryRow, lane.wallStartRow, samples.length - 1]) {
      const sample = samples[row];
      if (sample === undefined) {
        continue;
      }
      course.sample(sample.x, sample.z, hit);
      expect(rowAtArc(lane, hit.arc)).toBe(row);
    }
  });
});

describe('维修道是一块真正的路面', () => {
  const course = makeCourse();
  const lane = course.pit;
  if (lane === null) {
    throw new Error('测试赛道应该带维修道');
  }
  const samples = course.layout.samples;
  const hit = createGroundHit();

  /**
   * 把「主赛道行号 + 横向」换算成世界坐标。
   *
   * 两条只有量过才知道的:
   * 1. `Course.sample()` 的 `lateral` 正方向是 `(-tangentZ, tangentX)`,
   *    **和 `world.ts` 发车格里那条 `(tangentZ, -tangentX)` 相反**
   *    (HANDOFF 第五十八节量的)。用错号会落到赛道另一侧,而"另一侧同样
   *    是出界"会让断言看起来只是数值不对,不像方向错了。
   * 2. 往前挪半格再采样:正好落在采样点上时 `nearestRow` 可能返回前一段
   *    (t≈1),行号差一,而这个测试的全部意义就是行号边界。
   */
  function worldAt(row: number, lateral: number): { x: number; z: number } {
    const sample = samples[row % samples.length];
    if (sample === undefined) {
      throw new Error('行号越界');
    }
    const ahead = course.layout.spacing * 0.5;
    return {
      x: sample.x - sample.tangentZ * lateral + sample.tangentX * ahead,
      z: sample.z + sample.tangentX * lateral + sample.tangentZ * ahead,
    };
  }

  it('**踩上去算在赛道上** —— 不然圈不算数,人还会被出界回收传送走', () => {
    const mid = lane.wallStartRow;
    const p = worldAt(mid, (lane.lateralMin + lane.lateralMax) / 2);
    course.sample(p.x, p.z, hit);
    expect(hit.onTrack).toBe(true);
    expect(hit.inPit).toBe(true);
  });

  it('同样的横向距离,不在维修道那一段就是出界', () => {
    const far = (lane.entryRow - 60 + samples.length) % samples.length;
    const p = worldAt(far, (lane.lateralMin + lane.lateralMax) / 2);
    course.sample(p.x, p.z, hit);
    expect(hit.onTrack).toBe(false);
    expect(hit.inPit).toBe(false);
  });

  it('物理查询落在渲染出来的三角面上 —— 和主条带同一条不变量', () => {
    /*
     * **楔尖那几行是例外,而且是量过之后写下来的例外。**
     *
     * 三角形的重心在参数空间是 1/3,而 `Course.sample()` 找的是把这个点投影
     * 到中心线上得到的段内参数 —— 一个 20 米开外的点,两者不完全相等。楔形
     * 段的外缘宽度跟着段内参数走,于是宽度只有几十厘米的那几行,重心会落到
     * 判定边界外一丁点。实测 792 个三角里有 17 个,全部在宽度 < 0.15 m 的
     * 楔尖上。
     *
     * 不去"修"它,因为修的方向都更糟:把判定放宽到两行的较大值,车就能贴进
     * 画出来的墙里 —— 墙是看得见的,那个错更明显。这里改成**把例外钉死**:
     * 宽度够 1 米的行必须一个不漏,不够的只准出现在楔尖。
     */
    const { positions, row } = course.buildPitTriangles();
    const triangles = positions.length / 9;
    expect(triangles).toBeGreaterThan(0);

    let checked = 0;
    let skipped = 0;
    for (let t = 0; t < triangles; t++) {
      const base = t * 9;
      const cx =
        ((positions[base] ?? 0) + (positions[base + 3] ?? 0) + (positions[base + 6] ?? 0)) / 3;
      const cy =
        ((positions[base + 1] ?? 0) + (positions[base + 4] ?? 0) + (positions[base + 7] ?? 0)) / 3;
      const cz =
        ((positions[base + 2] ?? 0) + (positions[base + 5] ?? 0) + (positions[base + 8] ?? 0)) / 3;
      if (pitLaneWidthAt(lane, row[t] ?? 0) < 0.5) {
        skipped++;
        continue;
      }
      course.sample(cx, cz, hit);
      expect(hit.inPit).toBe(true);
      expect(hit.height).toBeCloseTo(cy, 3);
      checked++;
    }
    expect(checked).toBeGreaterThan(triangles * 0.9);
    // 楔尖那几行占的比例:6% 上下,再高就说明楔形张得太慢了。
    expect(skipped).toBeLessThan(triangles * 0.08);
  });

  it('**内缘和条带外缘共用同一排顶点** —— 逐位相同,不可能有台阶', () => {
    /*
     * 这是强的那条:两块面在交界处不是"差不多高",而是**同一批顶点**。
     * 两边都用 `blendTerrain()` 在同一个横向距离上求值,输入一模一样。
     * 顶点对得上,面就一定接得上。
     */
    const trackEdge = course.buildEdgeLine(1);
    const pitEdge = course.buildPitEdgeLine('inner');
    for (let i = 0; i <= lane.laneRowCount; i++) {
      const row = (lane.entryRow + i) % samples.length;
      for (let k = 0; k < 3; k++) {
        expect(pitEdge[i * 3 + k]).toBe(trackEdge[row * 3 + k]);
      }
    }
  });

  it('跨过交界采样出来的高度差是格子级的残差,不是台阶', () => {
    /*
     * 弱的那条,但它量的是**采样出来的面**而不是顶点。差值不会正好是 0:
     * 条带最后一列有 2.9 米宽,路肩的过渡是 smoothstep 而三角面内是线性的,
     * 交界内侧 5 厘米处必然差那么一点。
     *
     * 阈值取 2 厘米:悬挂行程是它的两个数量级以上,车压过去不会有任何反应;
     * 而真出现台阶(用错高度公式)量级是分米到米,一定拦得住。
     */
    let worst = 0;
    const wallSpan = (lane.wallEndRow - lane.wallStartRow + samples.length) % samples.length;
    for (let i = 0; i <= wallSpan; i += 5) {
      const row = (lane.wallStartRow + i) % samples.length;
      const inside = worldAt(row, course.outerHalfWidth - 0.05);
      const outside = worldAt(row, course.outerHalfWidth + 0.05);
      course.sample(inside.x, inside.z, hit);
      const hIn = hit.height;
      course.sample(outside.x, outside.z, hit);
      worst = Math.max(worst, Math.abs(hit.height - hIn));
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('维修道基本是平的 —— 横向坡度不该像赛道那样带侧倾', () => {
    let worst = 0;
    const wallSpan = (lane.wallEndRow - lane.wallStartRow + samples.length) % samples.length;
    for (let i = 0; i <= wallSpan; i++) {
      const row = (lane.wallStartRow + i) % samples.length;
      const a = worldAt(row, lane.lateralMin + 0.2);
      const b = worldAt(row, lane.lateralMax - 0.2);
      course.sample(a.x, a.z, hit);
      const ha = hit.height;
      course.sample(b.x, b.z, hit);
      worst = Math.max(worst, Math.abs(hit.height - ha) / (PIT.laneWidth - 0.4));
    }
    // 真实维修道和停车场的排水横坡在 2% 上下;这里跟着地形压平那条曲线走,
    // 所以放宽到 10%,但绝不能是赛道那种 50% 量级的侧倾。
    expect(worst).toBeLessThan(0.1);
  });
});

describe('走廊边界:隔离墙的缺口', () => {
  const course = makeCourse();
  const lane = course.pit;
  if (lane === null) {
    throw new Error('测试赛道应该带维修道');
  }
  const samples = course.layout.samples;
  const hit = createGroundHit();

  /** 见上一个 describe 里 `worldAt()` 的注释:横向的符号和半格前移都有讲究。 */
  function sampleAt(row: number, lateral: number): void {
    const sample = samples[row % samples.length];
    if (sample === undefined) {
      throw new Error('行号越界');
    }
    const ahead = course.layout.spacing * 0.5;
    course.sample(
      sample.x - sample.tangentZ * lateral + sample.tangentX * ahead,
      sample.z + sample.tangentX * lateral + sample.tangentZ * ahead,
      hit,
    );
  }

  it('隔离墙那一段:赛道上的右界就是条带外缘', () => {
    sampleAt(lane.wallStartRow, 0);
    expect(hit.wallRight).toBeCloseTo(course.outerHalfWidth, 9);
    expect(hit.wallLeft).toBeCloseTo(-course.outerHalfWidth, 9);
  });

  it('**引道那一段:右界跟着楔形一起往外长** —— 车才切得进去', () => {
    // 楔尖:还没张开,和普通路段一样。
    sampleAt(lane.entryRow, 0);
    expect(hit.wallRight).toBeLessThan(course.outerHalfWidth + 0.2);

    // 引道中段:已经张开了一部分,但还没到全宽。
    const gap = (lane.wallStartRow - lane.entryRow + samples.length) % samples.length;
    sampleAt(lane.entryRow + Math.floor(gap / 2), 0);
    expect(hit.wallRight).toBeGreaterThan(course.outerHalfWidth + 1);
    expect(hit.wallRight).toBeLessThan(lane.lateralMax);

    // 隔离墙开始前一行:已经是全宽了。
    sampleAt(lane.wallStartRow - 1, 0);
    expect(hit.wallRight).toBeCloseTo(lane.lateralMax, 0);
  });

  it('楔形是单调张开的 —— 中间不能忽宽忽窄', () => {
    const gap = (lane.wallStartRow - lane.entryRow + samples.length) % samples.length;
    let previous = -Infinity;
    for (let i = 0; i <= gap; i++) {
      const width = pitLaneWidthAt(lane, (lane.entryRow + i) % samples.length);
      expect(width).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = width;
    }
    expect(pitLaneWidthAt(lane, lane.entryRow)).toBeCloseTo(0, 9);
    expect(pitLaneWidthAt(lane, lane.wallStartRow)).toBeCloseTo(PIT.laneWidth, 9);
    expect(pitLaneWidthAt(lane, lane.boxStartRow)).toBeCloseTo(PIT.laneWidth, 9);
    expect(pitLaneWidthAt(lane, lane.exitRow)).toBeCloseTo(0, 9);
  });

  it('维修道里:隔离墙那一段被夹在两道墙之间', () => {
    sampleAt(lane.wallStartRow, (lane.lateralMin + lane.lateralMax) / 2);
    expect(hit.wallLeft).toBeCloseTo(lane.lateralMin, 9);
    expect(hit.wallRight).toBeCloseTo(lane.lateralMax, 9);
  });

  it('维修道里的缺口那一段:左界一路通回赛道 —— 出口才出得来', () => {
    // 楔形在出口已经收窄,所以取出口引道的中段来问。
    const gap = (lane.exitRow - lane.wallEndRow + samples.length) % samples.length;
    sampleAt(lane.wallEndRow + Math.floor(gap / 3), lane.lateralMin + 2);
    expect(hit.wallLeft).toBeCloseTo(-course.outerHalfWidth, 9);
  });

  it('没有维修道的路段照旧对称', () => {
    const far = (lane.entryRow - 40 + samples.length) % samples.length;
    sampleAt(far, 0);
    expect(hit.wallLeft).toBeCloseTo(-course.outerHalfWidth, 9);
    expect(hit.wallRight).toBeCloseTo(course.outerHalfWidth, 9);
  });
});

describe('限速器', () => {
  it('限速以下完全不收油', () => {
    expect(pitLimiterScale(0)).toBe(1);
    expect(pitLimiterScale(PIT.speedLimit - PIT.speedLimitBand)).toBe(1);
  });

  it('超过限速就切到 0', () => {
    expect(pitLimiterScale(PIT.speedLimit)).toBe(0);
    expect(pitLimiterScale(PIT.speedLimit + 20)).toBe(0);
  });

  it('过渡带里是连续的 —— 硬开关会在限速点上抖', () => {
    const mid = pitLimiterScale(PIT.speedLimit - PIT.speedLimitBand / 2);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });
});

describe('planService', () => {
  it('按修了什么算时间,不是一个固定秒数', () => {
    const fuel = new FuelTank(10);
    const fresh = new CarCondition();
    const worn = new CarCondition();
    worn.tireWear = 0.9;

    const fuelOnly = planService(fuel, fresh, 14);
    const withTires = planService(fuel, worn, 14);
    expect(withTires.seconds).toBeGreaterThan(fuelOnly.seconds);
    // 「只加油不换胎」必须明显更快,否则策略退化成"要不要进站"一个二选一。
    expect(withTires.seconds - fuelOnly.seconds).toBeCloseTo(PIT.tireSeconds, 9);
  });

  it('没磨到就不换 —— 白花时间', () => {
    const fuel = new FuelTank(10);
    const barely = new CarCondition();
    barely.tireWear = PIT.tireWearThreshold * 0.5;
    expect(planService(fuel, barely, 10).changeTires).toBe(false);
  });

  it('加油量是"想加到多少"减"现在有多少",不会是负数', () => {
    const fuel = new FuelTank(20);
    expect(planService(fuel, new CarCondition(), 10).refuelLitres).toBe(0);
    expect(planService(fuel, new CarCondition(), 26).refuelLitres).toBeCloseTo(6, 9);
  });

  it('损伤越重修得越久', () => {
    const fuel = new FuelTank(10);
    const light = new CarCondition();
    light.damage = 0.2;
    const heavy = new CarCondition();
    heavy.damage = 0.9;
    expect(planService(fuel, heavy, 10).seconds).toBeGreaterThan(
      planService(fuel, light, 10).seconds,
    );
  });
});

describe('PitStop 状态机', () => {
  it('**以赛车速度扫过去什么都不发生**', () => {
    const stop = new PitStop();
    const busy = run(stop, 3, true, 50, SERVICE);
    expect(busy.some(Boolean)).toBe(false);
    expect(stop.phase).toBe('idle');
    expect(stop.stops).toBe(0);
  });

  it('停稳了才开始作业', () => {
    const stop = new PitStop();
    run(stop, 1, true, 0.5, SERVICE);
    expect(stop.phase).toBe('servicing');
    expect(stop.stops).toBe(1);
  });

  it('不在区里怎么停都不作业', () => {
    const stop = new PitStop();
    const busy = run(stop, 3, false, 0, SERVICE);
    expect(busy.some(Boolean)).toBe(false);
  });

  it('作业期间一直返回"忙",到点才松开', () => {
    const stop = new PitStop();
    const busy = run(stop, SERVICE.seconds - 0.5, true, 0, SERVICE);
    expect(busy.every(Boolean)).toBe(true);
    run(stop, 1, true, 0, SERVICE);
    expect(stop.phase).toBe('released');
  });

  it('**作业完之后不会立刻又进站** —— 车还压在区里', () => {
    const stop = new PitStop();
    run(stop, SERVICE.seconds + 1, true, 0, SERVICE);
    expect(stop.phase).toBe('released');
    // 继续停在区里十秒,不该再触发一次。
    const again = run(stop, 10, true, 0, SERVICE);
    expect(again.some(Boolean)).toBe(false);
    expect(stop.stops).toBe(1);
  });

  it('开出去之后才回到 idle,然后可以再进一次', () => {
    const stop = new PitStop();
    run(stop, SERVICE.seconds + 1, true, 0, SERVICE);
    run(stop, 0.5, false, 30, SERVICE);
    expect(stop.phase).toBe('idle');
    run(stop, 1, true, 0, SERVICE);
    expect(stop.phase).toBe('servicing');
    expect(stop.stops).toBe(2);
  });

  it('没什么可修的时候不作业 —— 不该有一个"白停十秒"的按钮', () => {
    const stop = new PitStop();
    const nothing: PitService = { refuelLitres: 0, changeTires: false, repair: false, seconds: 0 };
    const busy = run(stop, 3, true, 0, nothing);
    expect(busy.some(Boolean)).toBe(false);
    expect(stop.phase).toBe('idle');
  });

  it('进度从 0 走到 1', () => {
    const stop = new PitStop();
    run(stop, 0.1, true, 0, SERVICE);
    expect(stop.progress).toBeGreaterThanOrEqual(0);
    expect(stop.progress).toBeLessThan(0.1);
    run(stop, SERVICE.seconds / 2, true, 0, SERVICE);
    expect(stop.progress).toBeGreaterThan(0.4);
    expect(stop.progress).toBeLessThan(0.6);
  });

  it('reset 清干净', () => {
    const stop = new PitStop();
    run(stop, 1, true, 0, SERVICE);
    stop.reset();
    expect(stop.phase).toBe('idle');
    expect(stop.stops).toBe(0);
    expect(stop.service).toBeNull();
  });
});

/*
 * ── 下面这些要真的开车 ──────────────────────────────────────────────────
 *
 * 上面全是几何和状态机,那些只证明「算得对」。开起来是不是那么回事是另一件
 * 事:限速器切的是驱动力矩,而力矩到车速中间隔着变速箱、轮胎和阻力。
 */

beforeAll(async () => {
  await initPhysics();
});

/** 把车放到「主赛道行号 + 横向」上,车头朝赛道前进方向。 */
function placeAt(vehicle: Vehicle, layout: TrackLayout, row: number, lateral: number): void {
  const sample = layout.samples[row % layout.samples.length];
  if (sample === undefined) {
    throw new Error('行号越界');
  }
  vehicle.reset(
    sample.x - sample.tangentZ * lateral,
    sample.z + sample.tangentX * lateral,
    Math.atan2(sample.tangentX, sample.tangentZ),
  );
}

describe('限速器开起来是那么回事', () => {
  function driveFlatOut(lateral: number, seconds: number): { max: number; last: number } {
    const rng = new Rng(42);
    const layout = generateTrack(rng.fork());
    const lane = createPitLane(layout, layout.halfWidth + TRACK.shoulderWidth);
    const course = new Course(layout, rng.fork(), lane);
    const vehicle = new Vehicle(course, new Physics());
    placeAt(vehicle, layout, lane.wallStartRow + 2, lateral);

    const input = createInputFrame();
    input.throttle = 1;
    let max = 0;
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      vehicle.update(input, FIXED_DT);
      max = Math.max(max, vehicle.groundSpeed);
    }
    return { max, last: vehicle.groundSpeed };
  }

  /*
   * 5 秒不是随手取的:方向盘打直、赛道在拐弯,再开下去车会蹭到隔离墙上,
   * 量到的就变成"撞墙掉速"而不是"限速器压住了"。实测 5.5 秒时横向已经从
   * 20.5 漂到 15.8(隔离墙在 14.5),6 秒整就顶上去了。
   */
  const PLATEAU_SECONDS = 5;
  const MID_LANE = (14.5 + 26.5) / 2;

  it('维修道里满油门也上不去 —— 限速压住了', () => {
    const pit = driveFlatOut(MID_LANE, PLATEAU_SECONDS);
    // 真的加速了(不是被卡住或者压根没动),但顶不过限速。
    expect(pit.max).toBeGreaterThan(15);
    expect(pit.max).toBeLessThan(PIT.speedLimit);
  });

  it('同样的地方在赛道上满油门就快得多 —— 说明压住它的是限速器不是路面', () => {
    const track = driveFlatOut(0, PLATEAU_SECONDS);
    // 5 秒站立起步实测约 30.7 m/s(110 km/h),限速是 22.22 —— 差 38%。
    expect(track.max).toBeGreaterThan(PIT.speedLimit * 1.3);
  });

  it('**限速器不替你刹车** —— 顶到限速就停在那儿,不会被拽下来', () => {
    const pit = driveFlatOut(MID_LANE, PLATEAU_SECONDS);
    /*
     * 稳态落在限速下面一点点(实测 22.17,限速 22.22):过渡带里收油收到
     * 刚好抵消阻力那一档。**如果限速器还替你刹车,这里会明显低于限速**,
     * 那就是一脚看不见的刹车,不是真机上那颗按钮做的事。
     */
    expect(pit.last).toBeGreaterThan(PIT.speedLimit - 0.5);
    expect(pit.last).toBeLessThan(PIT.speedLimit);
  });
});

describe('圈数判定跟着维修道走', () => {
  /**
   * **这一条是这次改动的核心。**
   *
   * 维修道跨过终点线,所以「从维修道里冲线」是每一次进站都会发生的事。
   * 如果维修道不算合法路面,`Race.trackCheckpoints()` 会因为 `!onTrack`
   * 直接跳过,那一圈**根本不算数** —— 而且玩家还会被出界回收传送走。
   */
  function runCheckpoints(lateralAt: (index: number) => number): Race {
    const rng = new Rng(42);
    const layout = generateTrack(rng.fork());
    const lane = createPitLane(layout, layout.halfWidth + TRACK.shoulderWidth);
    const course = new Course(layout, rng.fork(), lane);
    const vehicle = new Vehicle(course, new Physics());
    const race = new Race(layout);
    const checkpointArc = layout.totalLength / race.checkpointCount;

    for (let i = 1; i <= race.checkpointCount; i++) {
      const index = i % race.checkpointCount;
      // 落在该检查点区间的正中间,免得踩在边界上。
      const arc = (index + 0.5) * checkpointArc;
      const row = Math.floor(arc / layout.spacing);
      placeAt(vehicle, layout, row, lateralAt(index));
      race.update(vehicle, FIXED_DT);
    }
    return race;
  }

  it('全程走赛车线:一圈算一圈(基准)', () => {
    expect(runCheckpoints(() => 0).laps).toBe(1);
  });

  it('**最后一段在维修道里冲线,这一圈照样算**', () => {
    const rng = new Rng(42);
    const layout = generateTrack(rng.fork());
    const lane = createPitLane(layout, layout.halfWidth + TRACK.shoulderWidth);
    const inLane = (index: number): number => {
      const arc = (index + 0.5) * (layout.totalLength / TRACK.checkpointCount);
      return insidePitLane(lane, arc, (lane.lateralMin + lane.lateralMax) / 2)
        ? (lane.lateralMin + lane.lateralMax) / 2
        : 0;
    };
    // 前提:确实有检查点落在维修道上,否则这条测试什么也没测到。
    let covered = 0;
    for (let i = 0; i < TRACK.checkpointCount; i++) {
      if (inLane(i) !== 0) {
        covered++;
      }
    }
    expect(covered).toBeGreaterThan(0);
    expect(runCheckpoints(inLane).laps).toBe(1);
  });

  it('同样的横向距离但不在维修道上,检查点不算 —— 那是出界', () => {
    // 全程都偏出去 20 米:只有维修道那一段是路面,其余都是山坡。
    expect(runCheckpoints(() => 20).laps).toBe(0);
  });
});

describe('**开得进去、停得下、开得出来**', () => {
  /*
   * 这一条是整个功能的验收:上面所有几何和状态机都对,也可能凑出一条**开不
   * 进去**的维修道。第一版就是 —— 等宽车道 + 48 米引道,车得在 48 米里横移
   * 20 米,实测怎么开都是撞在隔离墙上。楔形引道 + 90 米就是被这条逼出来的。
   *
   * 驾驶员是一段最朴素的 P-D:盯住一个横向目标,按误差和变化率给舵。**它比
   * 人开得差**,所以它能做到的事人一定做得到;反过来不成立,但这条测试要守的
   * 就是下界。
   */
  it('一段朴素的 P-D 驾驶员能完整走完一次进站', () => {
    const rng = new Rng(135);
    const layout = generateTrack(rng.fork());
    const lane = createPitLane(layout, layout.halfWidth + TRACK.shoulderWidth);
    const course = new Course(layout, rng.fork(), lane);
    const vehicle = new Vehicle(course, new Physics());
    const samples = layout.samples;

    // 入口前 150 米起步,够加到赛车速度再减速切进引道。
    const startRow =
      ((lane.entryRow - Math.round(150 / layout.spacing)) % samples.length + samples.length) %
      samples.length;
    placeAt(vehicle, layout, startRow, 0);

    const input = createInputFrame();
    let previousLateral = vehicle.lateral;
    let stoppedAt = -1;
    let leftLaneAt = -1;
    let worstImpact = 0;
    let maxSpeedInLane = 0;

    for (let i = 0; i < 60 * 45; i++) {
      const row = rowAtArc(lane, vehicle.arc);
      const onApproach = pitRowIndex(lane, row) >= 0 && !pitWallAtRow(lane, row);
      const inLane = insidePitLane(lane, vehicle.arc, vehicle.lateral);
      const inBox = insidePitBox(lane, vehicle.arc, vehicle.lateral);

      let target = 0;
      if (stoppedAt < 0 && (onApproach || inLane)) {
        const nearBox =
          inBox || (lane.boxStartRow - row + lane.rowCount) % lane.rowCount < 12;
        target = nearBox
          ? (lane.boxLateralMin + lane.lateralMax) / 2
          : (lane.lateralMin + lane.lateralMax) / 2;
      } else if (stoppedAt >= 0 && inLane) {
        // 出站沿快车道走。
        target = lane.lateralMin + 3;
      }
      const rate = (vehicle.lateral - previousLateral) / FIXED_DT;
      previousLateral = vehicle.lateral;
      input.steer = clamp((target - vehicle.lateral) * 0.14 - rate * 0.22, -1, 1);

      const wanted = stoppedAt >= 0 ? 20 : inBox ? 0 : inLane || onApproach ? 16 : 30;
      input.throttle = vehicle.groundSpeed < wanted ? 1 : 0;
      input.airBrake = vehicle.groundSpeed > wanted + 1.5 ? 1 : 0;

      vehicle.update(input, FIXED_DT);
      if (vehicle.inPit) {
        maxSpeedInLane = Math.max(maxSpeedInLane, vehicle.groundSpeed);
        worstImpact = Math.max(worstImpact, vehicle.wallImpact);
      }
      if (stoppedAt < 0 && inBox && vehicle.groundSpeed < PIT.entrySpeed) {
        stoppedAt = i / 60;
      }
      if (stoppedAt >= 0 && leftLaneAt < 0 && !vehicle.inPit && vehicle.onTrack) {
        leftLaneAt = i / 60;
      }
    }

    // 停进了车位(实测约 19 秒)。
    expect(stoppedAt).toBeGreaterThan(0);
    // 又开了出来,回到赛道上(实测约 36 秒)。
    expect(leftLaneAt).toBeGreaterThan(stoppedAt);
    /*
     * 没有撞墙。留 0.5 的余量而不是钉死 0:这个驾驶员是个 P-D,出站沿快车道
     * 走的时候会有一点超调,实测轻蹭到 0.04。**真撞一下是 10 以上**
     * (同一段路上第一版等宽车道实测 12.3),所以 0.5 分得开"擦了一下"和
     * "撞上去了"。
     */
    expect(worstImpact).toBeLessThan(0.5);
    // 维修道里从没超过限速。
    expect(maxSpeedInLane).toBeLessThan(PIT.speedLimit);
  });
});

describe('维修道不该改变赛道上发生的任何事', () => {
  /*
   * 加一条并排的车道最容易悄悄干掉的东西,是**赛道本身**。两条具体的路子:
   *
   * 1. 引道那两段把右墙撤了(要撤,不然进不去),于是原本会被墙挡回来的车
   *    从那儿跑出去了 —— 单圈、名次、精选赛道的目标时间全部跟着变。
   * 2. AI 顺着引道拐进维修道,吃一路限速,名次莫名其妙崩掉。
   *
   * 这两条都不会让别的测试变红,只会让**已经验收过的数字**悄悄漂掉。
   */
  const SEEDS = [135, 325, 107, 110, 154];

  function raceOneLap(seed: number, withPit: boolean): { lapTime: number; resets: number } {
    const rng = new Rng(seed);
    const layout = generateTrack(rng.fork());
    const lane = withPit ? createPitLane(layout, layout.halfWidth + TRACK.shoulderWidth) : null;
    const course = new Course(layout, rng.fork(), lane);
    const car = new Vehicle(course, new Physics());
    const pilot = new RacingPilot(layout, RACING_AI.defaultAggression);
    const race = new Race(layout);
    const input = createInputFrame();
    placeAt(car, layout, 0, 0);
    for (let f = 0; f < 60 * 300 && race.laps < 2; f++) {
      pilot.drive(car, input, [car]);
      car.update(input, FIXED_DT);
      race.update(car, FIXED_DT);
    }
    return { lapTime: race.lastLapTime, resets: race.resets };
  }

  it('**五条精选赛道的单圈逐位不变**', () => {
    for (const seed of SEEDS) {
      const without = raceOneLap(seed, false);
      const withPit = raceOneLap(seed, true);
      expect(withPit.lapTime).toBe(without.lapTime);
      expect(withPit.resets).toBe(without.resets);
      // 顺手确认这一圈真的跑出来了,别拿两个 0 对得很开心。
      expect(withPit.lapTime).toBeGreaterThan(20);
    }
  });

  it('对手一次都不会误拐进维修道', () => {
    for (const seed of SEEDS) {
      const rng = new Rng(seed);
      const layout = generateTrack(rng.fork());
      const lane = createPitLane(layout, layout.halfWidth + TRACK.shoulderWidth);
      const course = new Course(layout, rng.fork(), lane);
      const physics = new Physics();
      const cars = [0, 1, 2].map(() => new Vehicle(course, physics));
      const pilots = cars.map(
        (_, i) =>
          new RacingPilot(layout, RACING_AI.defaultAggression - i * RACING_AI.aggressionSpread),
      );
      const inputs = cars.map(() => createInputFrame());
      cars.forEach((car, i) => {
        placeAt(car, layout, 0, (i - 1) * 3);
      });

      let pitFrames = 0;
      for (let f = 0; f < 60 * 90; f++) {
        for (let i = 0; i < cars.length; i++) {
          pilots[i]?.drive(cars[i] as Vehicle, inputs[i] as InputFrame, cars);
          cars[i]?.applyForces(inputs[i] as InputFrame, FIXED_DT);
        }
        physics.step();
        for (const car of cars) {
          car.readState(FIXED_DT);
          if (car.inPit) {
            pitFrames++;
          }
        }
      }
      expect(pitFrames).toBe(0);
    }
  });
});
