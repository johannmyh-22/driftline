import { describe, expect, it } from 'vitest';
import { CarCondition } from '../../src/game/condition';
import { FuelTank } from '../../src/game/fuel';
import {
  type PitService,
  PitStop,
  createPitBox,
  insidePitBox,
  pitBoxCentre,
  planService,
} from '../../src/game/pitLane';
import { PIT } from '../../src/game/tuning';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 维修进站(B3)。
 *
 * 两条最容易写错、而且错了只有玩起来才发现的:
 *
 * 1. **必须真的停下来才开始作业。** 维修区就在赛车线旁边的路肩上(这是为了
 *    不动赛道生成而做的折中),以赛车速度扫过去必须什么都不发生。
 * 2. **作业完之后不能立刻回到 idle。** 车还压在维修区里,直接回 idle 下一帧
 *    就会判定"又进站了",无限循环。要等车真的开出去。
 * ══════════════════════════════════════════════════════════════════════════
 */

const DT = 1 / 60;
const BOX = createPitBox(3000, 7.5);

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

describe('createPitBox / insidePitBox', () => {
  it('维修区在起跑线之前,不跨过终点', () => {
    expect(BOX.arcEnd).toBeLessThan(3000);
    expect(BOX.arcStart).toBeLessThan(BOX.arcEnd);
    // 留了一段,免得作业完一出来就过线。
    expect(3000 - BOX.arcEnd).toBeCloseTo(PIT.lineGapMetres, 9);
  });

  it('压在赛道外侧,不占赛车线也不越过路缘', () => {
    expect(BOX.lateralMin).toBeGreaterThan(0);
    // 内缘不侵入赛道中间那一半。
    expect(BOX.lateralMin).toBeGreaterThanOrEqual(7.5 * 0.4);
    // 不越过路缘 —— 越过就是半个车在路肩上,进站会变成靠运气。
    expect(BOX.lateralMax).toBeLessThanOrEqual(7.5);
  });

  it('宽度至少盖得住两格路面网格 —— 不然地标细得像条标线', () => {
    /*
     * 地标是用顶点色涂的,顶点色的最小单位是一格(`LATERAL_DIVISIONS` = 10,
     * 一格约 2.9 m)。判定范围窄于两格的话只涂得出一格:45 米长、2.9 米宽,
     * 看着像条标线而不像个车位。**这条是照着截图按回来的** —— 第一版
     * (0.5~0.92)只命中 18 个三角形(一列),现在 36 个(两列)。
     */
    const cell = (14.5 * 2) / 10;
    expect(BOX.lateralMax - BOX.lateralMin).toBeGreaterThan(cell);
  });

  it('区内区外判得对', () => {
    const c = pitBoxCentre(BOX);
    expect(insidePitBox(BOX, c.arc, c.lateral)).toBe(true);
    // 赛车线上(横向 0)不算。
    expect(insidePitBox(BOX, c.arc, 0)).toBe(false);
    // 另一侧不算。
    expect(insidePitBox(BOX, c.arc, -c.lateral)).toBe(false);
    // 弧长不在范围里不算。
    expect(insidePitBox(BOX, BOX.arcStart - 1, c.lateral)).toBe(false);
    expect(insidePitBox(BOX, BOX.arcEnd + 1, c.lateral)).toBe(false);
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
