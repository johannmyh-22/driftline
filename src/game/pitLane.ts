import { clamp } from '../core/mathx';
import type { CarCondition } from './condition';
import type { FuelTank } from './fuel';
import type { TrackLayout } from './trackLayout';
import { PIT } from './tuning';

/**
 * 维修道:一条平行于主赛道的独立车道(2026-09,取代路肩折中版)。
 *
 * ## 和上一版的区别
 *
 * 上一版(HANDOFF 第五十八节)是明写的折中 —— 在起跑线前的一段**路肩**上划
 * 一个区,赛道生成一个字不动。它把「进站要减速、出来要重新加速」这个时间代价
 * 做出来了,但那不是维修道:没有独立路面、没有隔离墙、没有入口和出口,而且
 * 就贴在赛车线旁边,只能靠「必须停到 2 m/s 才作业」防误触发。
 *
 * 这一版是真的:
 *
 * - **独立路面**。`Course` 在条带外缘之外再铺一条 12 米宽的路面,物理查询和
 *   渲染共用同一份顶点表(和主条带一样的不变量)。
 * - **隔离墙**。主条带右侧的护墙在维修道这一段兼作隔离墙,两端各开一个缺口
 *   当引道;维修道外侧另起一道墙。
 * - **入口 / 限速区 / 出口**。入口在起跑线前 `entryBeforeLine` 米,出口在线后
 *   `exitAfterLine` 米 —— **跨过终点线**,和真实赛道一样,所以从维修道出来
 *   正好接上新的一圈。
 * - **圈数判定跟着变**。维修道是合法路面(`GroundHit.onTrack` 为真),所以
 *   检查点、圈计时、名次全部照常走;不这么做的话在维修道里跑会被出界回收
 *   传送走,而且那一圈根本不算数。
 *
 * ## 为什么用「主赛道弧长偏移」而不是另生成一条 spline
 *
 * 另生成一条 spline 要自己保证不和主赛道自交、曲率不超限、两端接得上 ——
 * 那是 `trackValidator` 已经解决过一次的问题,再解一次没有收益。而按主赛道
 * 中心线**横向偏移**出来的车道天然满足这些:它和主赛道处处平行,曲率只会比
 * 主赛道更缓(偏向外侧),两端由入口/出口的弧长直接定义。
 *
 * 代价是维修道和主赛道**处处等长**,不像真实赛道那样切掉最后一个弯。所以
 * 从维修道穿过去不会比赛道更短,也就不存在"拿维修道抄近道"这件事,不需要
 * 额外的防作弊判定;限速器纯粹是为了不用手动收油。
 *
 * ## 边界一律用**行号**定义,不用米
 *
 * 路面网格、隔离墙缺口、物理的墙判定三者必须落在同一个位置上,差一行(6 米)
 * 就是一堵看不见的墙。所以入口/出口/缺口/车位全部量化到采样行,米数只是
 * 算行号时的输入。`Course.sample()` 的 `bestRow` 和 `Math.floor(arc / spacing)`
 * 是同一个数,所以下面这些按弧长的判定和按行号的判定完全等价。
 */
export interface PitLane {
  /** 采样间距(米)。 */
  readonly spacing: number;
  /** 整条赛道的采样行数。 */
  readonly rowCount: number;
  readonly trackLength: number;
  /** 维修道内缘的横向位置(米,以赛道中心线为 0,正 = 右侧)= 条带外缘。 */
  readonly lateralMin: number;
  /**
   * 维修道**全宽处**的外缘。引道那两段窄于它,见 `pitLaneOuterAt()`。
   */
  readonly lateralMax: number;
  /** 车位那一侧的横向起点。内侧到这里是快车道。 */
  readonly boxLateralMin: number;
  /** 入口所在行(含)。 */
  readonly entryRow: number;
  /** 出口所在行(含)。可能小于 `entryRow` —— 这条道跨过终点线。 */
  readonly exitRow: number;
  /** 入口到出口一共多少行(含两端)。 */
  readonly laneRowCount: number;
  /** 隔离墙的起止行(含)。两端缺口就是 entry..wallStart 和 wallEnd..exit。 */
  readonly wallStartRow: number;
  readonly wallEndRow: number;
  /** 车位的起止行(含)。 */
  readonly boxStartRow: number;
  readonly boxEndRow: number;
}

/** 把差值折回 `[0, count)`。JS 的 `%` 对负数返回负数,不能直接用。 */
function wrapCount(value: number, count: number): number {
  return ((value % count) + count) % count;
}

/**
 * 建一条维修道。**不消耗随机数** —— 只看赛道长度、采样间距和条带外缘半宽。
 *
 * 这一条是刻意的:`World` 构造函数里 `rng.fork()` 的取用顺序是载荷状态的,
 * 插一次取数进去就会让同一个 seed 生成出另一条赛道,精选赛道的目标时间和
 * 玩家存的最佳圈全部作废(HANDOFF 第五十七节踩过)。
 */
export function createPitLane(layout: TrackLayout, outerHalfWidth: number): PitLane {
  const spacing = layout.spacing;
  const rowCount = layout.samples.length;
  const rows = (metres: number): number => Math.max(1, Math.round(metres / spacing));

  const entryRows = rows(PIT.entryBeforeLine);
  const exitRows = rows(PIT.exitAfterLine);
  const gapRows = rows(PIT.gapMetres);
  const boxRows = rows(PIT.boxLengthMetres);

  const entryRow = wrapCount(-entryRows, rowCount);
  const laneRowCount = Math.min(rowCount, entryRows + exitRows + 1);
  const exitRow = wrapCount(entryRow + laneRowCount - 1, rowCount);

  // 隔离墙从入口缺口之后开始、到出口缺口之前结束。缺口太长会把墙吃光,
  // 所以夹一下:至少给墙留一行,否则「隔离墙」就名存实亡了。
  const maxGap = Math.max(1, Math.floor((laneRowCount - 1) / 2) - 1);
  const gap = Math.min(gapRows, maxGap);
  const wallStartRow = wrapCount(entryRow + gap, rowCount);
  const wallEndRow = wrapCount(exitRow - gap, rowCount);

  // 车位摆在隔离墙这一段的中间:前后都留出减速和重新加速的距离。
  const wallSpan = wrapCount(wallEndRow - wallStartRow, rowCount) + 1;
  const boxStartRow = wrapCount(wallStartRow + Math.max(0, Math.floor((wallSpan - boxRows) / 2)), rowCount);
  const boxEndRow = wrapCount(boxStartRow + Math.min(boxRows, wallSpan) - 1, rowCount);

  return {
    spacing,
    rowCount,
    trackLength: layout.totalLength,
    lateralMin: outerHalfWidth,
    lateralMax: outerHalfWidth + PIT.laneWidth,
    boxLateralMin: outerHalfWidth + PIT.fastLaneWidth,
    entryRow,
    exitRow,
    laneRowCount,
    wallStartRow,
    wallEndRow,
    boxStartRow,
    boxEndRow,
  };
}

/**
 * 维修道在这一行有多宽(米)。
 *
 * **入口和出口是楔形张开的,不是凭空多出一条 12 米宽的路。** 三个理由:
 *
 * 1. 开得进去。第一版是等宽的,车要在引道那 48 米里横移 20 米才够得着车道,
 *    实测横向速度得 7.9 m/s —— 开不进去。楔形让车沿着张开的边缘自然滑出去,
 *    走廊的右界跟着一起长(`Course.sample()` 里那条),不用先"跳"过一段
 *    没有路面的空档。
 * 2. 看得懂。楔形是真实赛道引道的样子,从车里看就是一条岔出去的路;
 *    等宽的话它是"旁边突然多了一条路",玩家看不出入口在哪。
 * 3. 内缘不动。楔形只往**外**张,内缘永远贴着条带外缘 —— 两块面共用同一排
 *    顶点这条不变量不受影响(见 `course.ts` 的 `buildPitRibbon()`)。
 */
export function pitLaneWidthAt(lane: PitLane, row: number): number {
  const j = pitRowIndex(lane, row);
  if (j < 0) {
    return 0;
  }
  const openIn = wrapCount(lane.wallStartRow - lane.entryRow, lane.rowCount);
  const openOut = wrapCount(lane.exitRow - lane.wallEndRow, lane.rowCount);
  const tIn = openIn > 0 ? Math.min(1, j / openIn) : 1;
  const tOut = openOut > 0 ? Math.min(1, (lane.laneRowCount - 1 - j) / openOut) : 1;
  const t = Math.min(tIn, tOut);
  // smoothstep:楔尖处切线和赛道边缘相切,不留一个折角。
  return (lane.lateralMax - lane.lateralMin) * t * t * (3 - 2 * t);
}

/** 维修道在这一行的外缘横向位置。引道那两段窄于 `lateralMax`。 */
export function pitLaneOuterAt(lane: PitLane, row: number): number {
  return lane.lateralMin + pitLaneWidthAt(lane, row);
}

/** 弧长换算成采样行。和 `Course.sample()` 内部的 `bestRow` 是同一个数。 */
export function rowAtArc(lane: PitLane, arc: number): number {
  return wrapCount(Math.floor(arc / lane.spacing), lane.rowCount);
}

/** 行号 `row` 是否落在从 `start` 顺行到 `end`(含两端)的区间里,可跨终点线。 */
export function rowWithin(lane: PitLane, start: number, end: number, row: number): boolean {
  const span = wrapCount(end - start, lane.rowCount);
  return wrapCount(row - start, lane.rowCount) <= span;
}

/**
 * 这一行在维修道里的下标(0 = 入口),不在维修道上返回 -1。
 *
 * 维修道的顶点网格按这个下标存,渲染和物理查询共用一份 —— 和主条带一样。
 */
export function pitRowIndex(lane: PitLane, row: number): number {
  const offset = wrapCount(row - lane.entryRow, lane.rowCount);
  return offset < lane.laneRowCount ? offset : -1;
}

/** 这个位置是不是压在维修道的路面上。引道那两段按楔形的实际宽度判。 */
export function insidePitLane(lane: PitLane, arc: number, lateral: number): boolean {
  const row = rowAtArc(lane, arc);
  if (pitRowIndex(lane, row) < 0) {
    return false;
  }
  return lateral >= lane.lateralMin && lateral <= pitLaneOuterAt(lane, row);
}

/** 这个位置是不是停在车位里。 */
export function insidePitBox(lane: PitLane, arc: number, lateral: number): boolean {
  if (lateral < lane.boxLateralMin || lateral > lane.lateralMax) {
    return false;
  }
  return rowWithin(lane, lane.boxStartRow, lane.boxEndRow, rowAtArc(lane, arc));
}

/** 这一段有没有隔离墙。入口/出口的缺口上没有,那是引道。 */
export function pitWallAtRow(lane: PitLane, row: number): boolean {
  return (
    pitRowIndex(lane, row) >= 0 && rowWithin(lane, lane.wallStartRow, lane.wallEndRow, row)
  );
}

/** 车位中心(弧长,横向)。给发车调试、地标和 HUD 用。 */
export function pitBoxCentre(lane: PitLane): { arc: number; lateral: number } {
  const span = wrapCount(lane.boxEndRow - lane.boxStartRow, lane.rowCount);
  const row = lane.boxStartRow + span / 2;
  return {
    arc: (row * lane.spacing) % lane.trackLength,
    lateral: (lane.boxLateralMin + lane.lateralMax) / 2,
  };
}

/**
 * 限速器:超过限速就收驱动力矩,返回 0..1 的油门缩放。
 *
 * **它不替你刹车。** 真机上那颗按钮做的事就是切油/切点火,车速靠阻力和滚阻
 * 自己掉下来。所以以赛车速度冲进维修道照样会冲过车位 —— 那个代价是真实的,
 * 不该用一脚看不见的刹车替玩家消化掉。
 *
 * 过渡带里线性收而不是硬开关:硬开关会在限速点上来回抖,听感上像发动机在打嗝。
 */
export function pitLimiterScale(speed: number): number {
  return clamp((PIT.speedLimit - speed) / PIT.speedLimitBand, 0, 1);
}

export type PitPhase = 'idle' | 'servicing' | 'released';

/** 这次作业要修什么,以及各自要多久。 */
export interface PitService {
  readonly refuelLitres: number;
  readonly changeTires: boolean;
  readonly repair: boolean;
  readonly seconds: number;
}

/**
 * 算这次进站要做什么、要多久。
 *
 * `wanted` 是想加到多少升 —— 由调用方按「还剩几圈」算,不是一律加满:加满
 * 等于白背几十公斤出去(和 `fuel.ts` 里起步不灌满是同一条)。
 */
export function planService(
  fuel: FuelTank,
  condition: CarCondition,
  wantedLitres: number,
): PitService {
  const refuelLitres = Math.max(0, wantedLitres - fuel.litres);
  const changeTires = condition.tireWear >= PIT.tireWearThreshold;
  const repair = condition.damage >= PIT.damageThreshold;
  const seconds =
    PIT.baseSeconds +
    refuelLitres * PIT.secondsPerLitre +
    (changeTires ? PIT.tireSeconds : 0) +
    (repair ? condition.damage * PIT.repairSeconds : 0);
  return { refuelLitres, changeTires, repair, seconds };
}

/**
 * 一次进站的状态机。
 *
 * `released` 是个**单独的相位**而不是直接回 `idle`:作业做完之后车还停在
 * 车位里,不锁住的话下一帧就会判定"又进站了"、无限循环。要等车真的开出去
 * 才回到 `idle`。
 */
export class PitStop {
  phase: PitPhase = 'idle';
  /** 当前作业的剩余时间(秒)。 */
  remaining = 0;
  /** 这次作业的内容,`idle` 时是 null。 */
  service: PitService | null = null;
  /** 这一局进过几次站。 */
  stops = 0;

  reset(): void {
    this.phase = 'idle';
    this.remaining = 0;
    this.service = null;
    this.stops = 0;
  }

  /**
   * 每个固定步调一次。返回**这一帧是否要锁住输入并把车按住**。
   *
   * `speed` 是车速(m/s),`inside` 是是否停在车位里。`begin` 是"如果要开
   * 始作业,内容是什么" —— 由调用方现算,因为它要读油量/车况。
   */
  update(dt: number, inside: boolean, speed: number, begin: () => PitService): boolean {
    if (this.phase === 'released') {
      if (!inside) {
        this.phase = 'idle';
        this.service = null;
      }
      return false;
    }

    if (this.phase === 'idle') {
      // 必须真的停下来:以维修道限速从车位旁边过去不算进站。
      if (!inside || speed > PIT.entrySpeed) {
        return false;
      }
      const service = begin();
      if (service.seconds <= 0) {
        return false;
      }
      this.phase = 'servicing';
      this.service = service;
      this.remaining = service.seconds;
      this.stops++;
      return true;
    }

    this.remaining = Math.max(0, this.remaining - dt);
    if (this.remaining > 0) {
      return true;
    }
    this.phase = 'released';
    return false;
  }

  /** 作业进度 0..1,给 HUD 画进度条。 */
  get progress(): number {
    const total = this.service?.seconds ?? 0;
    return total <= 0 ? 0 : clamp(1 - this.remaining / total, 0, 1);
  }
}
