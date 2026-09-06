import { clamp } from '../core/mathx';
import type { Rng } from '../core/rng';
import { WEATHER } from './tuning';

/**
 * 赛道状态(B3,人类 2026-09 批准):气温、**路面温度**、路面湿度。
 *
 * ## 为什么是「路面温度」而不是「天气图标」
 *
 * 人类要的是「天气/路面温度」。这两个词在赛车里指的是同一件事的因和果:天气
 * 决定路温,而**路温才是直接决定抓地的那个量**。真实转播里念的也是路温不是
 * 气温 —— 20°C 的路面和 45°C 的路面,同一套胎能差出好几秒。
 *
 * 所以这里不做「晴/阴/雨」这种分类,做的是三个连续量:
 *
 * - `airTempC` 气温:只是背景信息,间接影响路温。
 * - `trackTempC` 路面温度:**抓地和磨损都挂在它上面**。
 * - `damp` 路面湿度 0..1:0 是干的,1 是湿透。它是独立于温度的一条,潮湿的
 *   凉路面和干燥的凉路面完全是两回事。
 *
 * ## 抓地对路温是**倒 U 形**,不是越热越好也不是越凉越好
 *
 * 轮胎有一个工作温度窗口:太凉橡胶硬、抓不住;太热橡胶发软起泡、同样抓不住,
 * 而且磨得飞快。所以曲线是以 `optimalTrackC` 为顶的抛物线,两边都掉。
 * 这条是真实的,也是「暖胎圈」和「轮胎过热掉速」这两件事的共同来源。
 *
 * ## 由 seed 决定,一局之内不变
 *
 * 和赛道、配色一样从 seed 推,所以同 seed 复现这条不受影响。**路温在真实
 * 比赛里是会随时段和铺胶变化的,这里没做** —— 那需要一套随比赛推进演化的
 * 状态,而且会让「同 seed 逐帧复现」多一个时间维度,留着当后续。
 */
export interface Weather {
  /** 气温(摄氏度)。 */
  readonly airTempC: number;
  /** 路面温度(摄氏度)。抓地与磨损都挂在它上面。 */
  readonly trackTempC: number;
  /** 路面湿度 0..1。0 = 干,1 = 湿透。 */
  readonly damp: number;
}

/** 中性状态:抓地与磨损的缩放都恰好是 1。 */
export const NEUTRAL_WEATHER: Weather = {
  airTempC: WEATHER.neutralAirC,
  trackTempC: WEATHER.optimalTrackC,
  damp: 0,
};

/**
 * 按 seed 生成赛道状态。
 *
 * `sunElevation` 是太阳仰角(度),由 `Atmosphere` 定。路温跟着它走是有物理
 * 依据的:低角度的太阳单位面积得到的能量少,清晨/黄昏的路面就是凉的。
 * 把这两件事绑在一起,画面里"太阳很低"和读数上"路面很凉"才是同一回事,
 * 而不是各说各话。
 */
export function createWeather(rng: Rng, sunElevation: number): Weather {
  const airTempC = rng.range(WEATHER.airMinC, WEATHER.airMaxC);
  /*
   * 路面比气温高多少,取决于太阳晒得有多狠。正午的柏油能比气温高 20 度以上,
   * 这是真实现象(沥青黑体吸热),不是为了好玩编的。
   */
  const solar = clamp(
    (sunElevation - WEATHER.elevationRefLow) /
      Math.max(1, WEATHER.elevationRefHigh - WEATHER.elevationRefLow),
    0,
    1,
  );
  // 潮湿会把路面压回气温附近:水在蒸发,吸走热量。
  const damp =
    rng.next() < WEATHER.dampChance ? rng.range(WEATHER.dampMin, WEATHER.dampMax) : 0;
  const solarGain = WEATHER.trackGainMaxC * solar * (1 - damp * WEATHER.dampCoolingShare);
  return { airTempC, trackTempC: airTempC + solarGain, damp };
}

/**
 * 侧向抓地缩放。倒 U 形的温度曲线 × 潮湿的折扣。
 *
 * 有下限(`gripFloor`):再凉再湿也不该变成冰面,那已经不是"难开"是"没法开"。
 */
export function weatherGripScale(weather: Weather): number {
  const off = (weather.trackTempC - WEATHER.optimalTrackC) / WEATHER.trackSpreadC;
  const temperature = 1 - WEATHER.tempGripLoss * off * off;
  const wet = 1 - WEATHER.dampGripLoss * clamp(weather.damp, 0, 1);
  return Math.max(WEATHER.gripFloor, temperature * wet);
}

/**
 * 轮胎磨损速率缩放。**只有过热才加速磨损,凉路面不会**——凉胎是抓不住,
 * 不是磨得快;而热胎既抓不住又磨得快,这两件事在真实世界里就是不对称的。
 */
export function weatherWearScale(weather: Weather): number {
  const over = Math.max(0, weather.trackTempC - WEATHER.optimalTrackC) / WEATHER.trackSpreadC;
  return 1 + WEATHER.tempWearGain * over;
}
