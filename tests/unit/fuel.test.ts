import { describe, expect, it } from 'vitest';
import { FuelTank, raceFuelLitres } from '../../src/game/fuel';
import { CAR, FUEL, GEARBOX, RACE_FORMAT } from '../../src/game/tuning';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 燃油(B3)。
 *
 * **这套东西的主要机制是质量,不是"会不会开到没油"** —— 所以下面钉的重点是
 * 「消耗跟发动机负荷走」「起步油量按赛程算」这两条,以及一条很不直观的实测
 * 结论:在 3 圈的赛程下,燃油质量对单圈的影响只有百分之几秒(见最后一组)。
 * 那不是 bug,是这个赛程本来就短;记在测试里免得下次有人以为它坏了。
 * ══════════════════════════════════════════════════════════════════════════
 */

const DT = 1 / 60;

/** 跑 `seconds` 秒,返回用掉多少升。 */
function burnFor(tank: FuelTank, seconds: number, throttle: number, rpm: number): number {
  const before = tank.litres;
  for (let i = 0; i < seconds / DT; i++) {
    tank.burn(DT, throttle, rpm);
  }
  return before - tank.litres;
}

describe('FuelTank', () => {
  it('松油门也在烧 —— 发动机转着就在耗', () => {
    const tank = new FuelTank(10);
    const used = burnFor(tank, 60, 0, GEARBOX.idleRpm);
    expect(used).toBeCloseTo(FUEL.idleFlowPerSecond * 60, 5);
    expect(used).toBeGreaterThan(0);
  });

  it('油门越深、转速越高烧得越快', () => {
    const idle = burnFor(new FuelTank(10), 10, 0, GEARBOX.idleRpm);
    const cruise = burnFor(new FuelTank(10), 10, 0.5, GEARBOX.peakRpm);
    const flat = burnFor(new FuelTank(10), 10, 1, GEARBOX.redlineRpm);
    expect(cruise).toBeGreaterThan(idle);
    expect(flat).toBeGreaterThan(cruise);
  });

  it('收油滑行明显比全油门省 —— "省油开法"要成立', () => {
    const coast = burnFor(new FuelTank(10), 10, 0, GEARBOX.peakRpm);
    const flat = burnFor(new FuelTank(10), 10, 1, GEARBOX.peakRpm);
    // 差一个数量级以上,不然"抬脚省油"只是个说法。
    expect(flat).toBeGreaterThan(coast * 5);
  });

  it('烧到 0 就停住,不会变成负数', () => {
    const tank = new FuelTank(0.01);
    burnFor(tank, 60, 1, GEARBOX.redlineRpm);
    expect(tank.litres).toBe(0);
    expect(tank.dry).toBe(true);
  });

  it('质量跟着油量走', () => {
    const tank = new FuelTank(10);
    expect(tank.massKg).toBeCloseTo(10 * FUEL.densityKgPerLitre, 9);
    burnFor(tank, 30, 1, GEARBOX.redlineRpm);
    expect(tank.massKg).toBeLessThan(10 * FUEL.densityKgPerLitre);
  });

  it('加油不会超过箱容', () => {
    const tank = new FuelTank(1);
    tank.refill(999);
    expect(tank.litres).toBe(FUEL.tankLitres);
  });

  it('构造和 reset 也夹在箱容里', () => {
    expect(new FuelTank(-5).litres).toBe(0);
    expect(new FuelTank(999).litres).toBe(FUEL.tankLitres);
    const tank = new FuelTank(10);
    tank.reset(-1);
    expect(tank.litres).toBe(0);
  });
});

describe('油量条的分母是"这趟加了多少",不是箱容', () => {
  /*
   * 这条是拍完截图才发现的:`fraction` 原来拿箱容当分母,而按赛程只加
   * 4.5 L / 60 L —— 油量条一开局就是红的、全程贴着底,玩家看到的是"我快没油
   * 了",实际余量有 30%。玩家关心的从来是"还剩几分之几",不是"油箱空了多少"。
   */
  it('刚加完油是满的,不管加了多少', () => {
    for (const litres of [4.5, 14, FUEL.tankLitres]) {
      const tank = new FuelTank(litres);
      expect(tank.fraction, `${litres} L`).toBeCloseTo(1, 9);
    }
  });

  it('烧掉一半就是一半', () => {
    const tank = new FuelTank(10);
    tank.litres = 5;
    expect(tank.fraction).toBeCloseTo(0.5, 9);
  });

  it('进站加油之后分母跟着换 —— 加多少就以多少为满', () => {
    const tank = new FuelTank(10);
    tank.litres = 2;
    tank.refill(20);
    expect(tank.fraction).toBeCloseTo(1, 9);
  });

  it('箱容比例单独留一个,不进 HUD', () => {
    const tank = new FuelTank(FUEL.tankLitres / 2);
    expect(tank.tankFraction).toBeCloseTo(0.5, 9);
    expect(tank.fraction).toBeCloseTo(1, 9);
  });
});

describe('raceFuelLitres', () => {
  it('按赛程算,不是灌满一箱', () => {
    const litres = raceFuelLitres(RACE_FORMAT.lapCount, 3140);
    expect(litres).toBeLessThan(FUEL.tankLitres);
    // 灌满 60 L 去跑 3 圈等于白背 40 公斤,真实车队不会那么干。
    expect(litres).toBeLessThan(FUEL.tankLitres * 0.3);
  });

  it('圈数或赛道变长,油量自己跟着变', () => {
    const short = raceFuelLitres(3, 3000);
    const moreLaps = raceFuelLitres(6, 3000);
    const longer = raceFuelLitres(3, 6000);
    expect(moreLaps).toBeGreaterThan(short);
    expect(longer).toBeGreaterThan(short);
  });

  it('留的余量正好是 reserveLaps 圈', () => {
    const withReserve = raceFuelLitres(3, 3000);
    const bare = (3 * 3) / FUEL.kmPerLitre;
    const perLap = 3 / FUEL.kmPerLitre;
    expect(withReserve - bare).toBeCloseTo(perLap * FUEL.reserveLaps, 9);
  });

  it('再长的赛程也不会算出超过箱容的油量', () => {
    expect(raceFuelLitres(100, 10_000)).toBe(FUEL.tankLitres);
  });
});

describe('燃油质量在这个赛程下有多大分量(实测值)', () => {
  /*
   * 这一组不是断言代码行为,是**把实测结论钉在这里**。
   *
   * 实测(seed 135,3.14 km,RacingPilot 全力跑,只改起步油量):
   *
   * | 起步油量 | 车重增量 | 首圈 |
   * |---|---|---|
   * | 4.5 L(按赛程算) | +3.3 kg | 58.817 s |
   * | 13.5 L | +10.0 kg | 58.950 s |
   * | 60 L(满箱) | +44.7 kg | 59.083 s |
   *
   * 也就是 **+10 kg ≈ +0.065 s/圈**。真实赛车的经验值是 90 秒级赛道上
   * 10 kg 约 0.3 s,折到 59 秒的圈长约 0.2 s —— **这台车对质量的敏感度比
   * 真车低约三倍**,那是 CLAUDE.md 里为保甩尾手感刻意不动 `driveTorque`
   * 的连带结果,不是这里算错了。
   *
   * 结论:**3 圈赛程下燃油质量是 0.03 秒量级,肉眼不可见。** 它要变成真正的
   * 变量,得靠更长的赛程(圈数一多,起步油量和"要不要省油"才有分量),或者
   * 靠"跑干"这个失败模式。别指望现在这个赛程能感觉出来。
   */
  it('起步油量占空车质量不到 1% —— 所以感觉不到是意料之中', () => {
    const litres = raceFuelLitres(RACE_FORMAT.lapCount, 3140);
    const share = (litres * FUEL.densityKgPerLitre) / CAR.mass;
    expect(share).toBeLessThan(0.01);
  });

  it('满箱也只有空车的 4% 上下', () => {
    const share = (FUEL.tankLitres * FUEL.densityKgPerLitre) / CAR.mass;
    expect(share).toBeGreaterThan(0.02);
    expect(share).toBeLessThan(0.06);
  });

  it('按赛程算的油量够跑完,而且余量不至于离谱', () => {
    // 实测 3 圈用掉 3.08 L,起步 4.5 L。留太多是白背重量,留太少是赌。
    const litres = raceFuelLitres(RACE_FORMAT.lapCount, 3140);
    const needed = (3.14 * RACE_FORMAT.lapCount) / FUEL.kmPerLitre;
    expect(litres).toBeGreaterThan(needed);
    expect(litres).toBeLessThan(needed * 1.6);
  });
});
