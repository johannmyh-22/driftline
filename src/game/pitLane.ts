import { clamp } from '../core/mathx';
import type { CarCondition } from './condition';
import type { FuelTank } from './fuel';
import { PIT } from './tuning';

/**
 * 维修进站(B3,人类 2026-09 批准)。
 *
 * ## 位置:起跑线前的一段路肩,不是一条独立的维修道
 *
 * 真实赛道的维修道是一条**平行于主赛道的独立路径**,有自己的入口、限速区、
 * 出口。那要动赛道生成:多一条 spline、多一套护墙、多一组检查点判定,而且
 * 「怎么算跑完一圈」会跟着变复杂。**这一轮不做那个。**
 *
 * 折中是:在**起跑线前的一段路肩**上划一个维修区。代价是它就在赛车线旁边,
 * 好处是赛道生成一个字不用改,而且「进站要减速、出来要重新加速」这个核心的
 * 时间代价一样成立。
 *
 * **必须真的停下来才开始作业**(`PIT.entrySpeed`),所以以赛车速度从旁边扫
 * 过去不会误触发 —— 这是这个折中位置能成立的前提。
 *
 * ## 作业时间按「修了什么」算
 *
 * 不是一个固定秒数。加油按升算(真实加油枪 2 L/s 上下)、换胎一个固定时长、
 * 修车按损伤程度。所以「只加油不换胎」明显更快,策略才有得选;一个固定秒数
 * 会让所有决定都退化成"要不要进站"这一个二选一。
 */

/** 维修区的范围。弧长以**起跑线**为终点往回算,横向以赛道中心线为 0。 */
export interface PitBox {
  /** 区间起点(米,沿赛道弧长)。 */
  readonly arcStart: number;
  /** 区间终点(米)。 */
  readonly arcEnd: number;
  /** 横向范围(米,正 = 赛道某一侧)。 */
  readonly lateralMin: number;
  readonly lateralMax: number;
}

/** 按赛道长度与半宽算出维修区。放在起跑线**之前**,出站就是过线。 */
export function createPitBox(trackLength: number, halfWidth: number): PitBox {
  const end = trackLength - PIT.lineGapMetres;
  return {
    arcStart: end - PIT.lengthMetres,
    arcEnd: end,
    lateralMin: halfWidth * PIT.lateralInner,
    lateralMax: halfWidth * PIT.lateralOuter,
  };
}

/** 车现在是不是压在维修区里。 */
export function insidePitBox(box: PitBox, arc: number, lateral: number): boolean {
  return (
    arc >= box.arcStart && arc <= box.arcEnd && lateral >= box.lateralMin && lateral <= box.lateralMax
  );
}

/** 维修区的中心点(弧长,横向),给画标记和 AI 瞄点用。 */
export function pitBoxCentre(box: PitBox): { arc: number; lateral: number } {
  return {
    arc: (box.arcStart + box.arcEnd) / 2,
    lateral: (box.lateralMin + box.lateralMax) / 2,
  };
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
 * `released` 是个**单独的相位**而不是直接回 `idle`:作业做完之后车还压在
 * 维修区里,不锁住的话下一帧就会判定"又进站了"、无限循环。要等车真的开出去
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
   * `speed` 是车速(m/s),`inside` 是是否压在维修区里。`begin` 是"如果要开
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
      // 必须真的停下来:以赛车速度从旁边扫过去不算进站。
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
