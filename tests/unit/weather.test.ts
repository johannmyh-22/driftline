import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { SKY, WEATHER } from '../../src/game/tuning';
import {
  NEUTRAL_WEATHER,
  createWeather,
  weatherGripScale,
  weatherWearScale,
} from '../../src/game/weather';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 赛道状态(B3)。
 *
 * 抓地挂在**路面温度**上不是气温上,而且是**倒 U 形**:太凉橡胶硬抓不住,
 * 太热橡胶软了同样抓不住还磨得飞快。这两条是这一层全部的物理内容,下面逐条钉。
 *
 * 另外钉一条边界:**天气最多只准拿走一成抓地。** 这不是保守,是实测逼出来的
 * ——抓地掉到 0.84 时 RacingPilot 的单圈从 57.9 s 崩到 83~99 s,而 0.84 是
 * 轮胎磨到底就能达到的值,也就是说那条塌陷在加天气之前就存在。天气不该去
 * 引爆一个既有问题。详见 HANDOFF 第五十七节。
 * ══════════════════════════════════════════════════════════════════════════
 */

describe('weatherGripScale', () => {
  it('理想路温时正好是 1 —— 中性状态下这套系统必须完全隐形', () => {
    expect(weatherGripScale(NEUTRAL_WEATHER)).toBe(1);
    expect(weatherWearScale(NEUTRAL_WEATHER)).toBe(1);
  });

  it('是倒 U 形:凉和热都掉抓地', () => {
    const optimal = weatherGripScale(NEUTRAL_WEATHER);
    const cold = weatherGripScale({ airTempC: 5, trackTempC: 10, damp: 0 });
    const hot = weatherGripScale({ airTempC: 35, trackTempC: 60, damp: 0 });
    expect(cold).toBeLessThan(optimal);
    expect(hot).toBeLessThan(optimal);
  });

  it('偏离同样多的凉和热,损失一样 —— 曲线是对称的', () => {
    const off = WEATHER.trackSpreadC;
    const cold = weatherGripScale({
      airTempC: 0,
      trackTempC: WEATHER.optimalTrackC - off,
      damp: 0,
    });
    const hot = weatherGripScale({
      airTempC: 0,
      trackTempC: WEATHER.optimalTrackC + off,
      damp: 0,
    });
    expect(cold).toBeCloseTo(hot, 9);
  });

  it('潮湿单独再扣一层,和温度无关', () => {
    const dry = weatherGripScale({ airTempC: 20, trackTempC: WEATHER.optimalTrackC, damp: 0 });
    const wet = weatherGripScale({ airTempC: 20, trackTempC: WEATHER.optimalTrackC, damp: 1 });
    expect(wet).toBeLessThan(dry);
  });

  it('**天气最多只准拿走一成抓地** —— 再多就进了 AI 会塌陷的区间', () => {
    // 扫一遍所有可能的组合,任何一种都不许跌破下限。
    for (let t = -20; t <= 90; t += 5) {
      for (const damp of [0, 0.5, 1]) {
        const scale = weatherGripScale({ airTempC: 20, trackTempC: t, damp });
        expect(scale, `路温 ${t}°C 湿度 ${damp}`).toBeGreaterThanOrEqual(WEATHER.gripFloor);
      }
    }
    expect(WEATHER.gripFloor).toBeGreaterThanOrEqual(0.85);
  });
});

describe('weatherWearScale', () => {
  it('只有过热才加速磨损,凉路面不会 —— 这条不对称是真实的', () => {
    // 凉胎是抓不住,不是磨得快;热胎既抓不住又磨得快。
    const cold = weatherWearScale({ airTempC: 5, trackTempC: 10, damp: 0 });
    const hot = weatherWearScale({ airTempC: 35, trackTempC: 60, damp: 0 });
    expect(cold).toBe(1);
    expect(hot).toBeGreaterThan(1);
  });
});

describe('createWeather', () => {
  it('太阳越高路面越热 —— 画面里"太阳很低"和读数上"路面很凉"要是同一回事', () => {
    // 同一条随机数流喂给两个仰角,只有仰角这一个变量在动。
    const low = createWeather(new Rng(7), SKY.elevationMin);
    const high = createWeather(new Rng(7), SKY.elevationMax);
    expect(high.trackTempC).toBeGreaterThan(low.trackTempC);
    // 气温和仰角无关,同一条流应该抽到同一个值。
    expect(high.airTempC).toBeCloseTo(low.airTempC, 9);
  });

  it('路面永远不比气温凉 —— 太阳只会加热,不会制冷', () => {
    for (let seed = 0; seed < 60; seed++) {
      const w = createWeather(new Rng(seed), SKY.elevationMax * 0.6);
      expect(w.trackTempC, `seed ${seed}`).toBeGreaterThanOrEqual(w.airTempC - 1e-9);
    }
  });

  it('同 seed 同仰角必然一样', () => {
    const a = createWeather(new Rng(42), 30);
    const b = createWeather(new Rng(42), 30);
    expect(a).toEqual(b);
  });

  it('潮湿是少数情况,而且潮湿时路面会被压凉', () => {
    let damp = 0;
    let dry = 0;
    let dampTemp = 0;
    let dryTemp = 0;
    for (let seed = 0; seed < 400; seed++) {
      const w = createWeather(new Rng(seed), SKY.elevationMax);
      if (w.damp > 0) {
        damp++;
        dampTemp += w.trackTempC - w.airTempC;
      } else {
        dry++;
        dryTemp += w.trackTempC - w.airTempC;
      }
    }
    expect(damp).toBeGreaterThan(0);
    expect(damp).toBeLessThan(dry);
    // 水在蒸发,吸走热量:潮湿时路面高出气温的幅度明显更小。
    expect(dampTemp / damp).toBeLessThan(dryTemp / dry);
  });
});
