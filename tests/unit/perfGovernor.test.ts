import { describe, expect, it } from 'vitest';
import { PerfGovernor } from '../../src/core/perfGovernor';
import { PERF } from '../../src/game/tuning';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 动态画质调节。
 *
 * 这一层最容易写错的地方是**判据的基准**:能测到的只有两次渲染之间的墙钟
 * 间隔,而它被 vsync 钳住 —— 60 Hz 上渲染再轻松也只报 16.7 ms。所以下面
 * 前三条测的都是同一件事的不同侧面:**跑满刷新率不算掉帧,不管刷新率是多少**。
 * 用绝对毫秒阈值的实现会在这三条里当场露馅。
 * ══════════════════════════════════════════════════════════════════════════
 */

/** 喂 n 帧同样的间隔,返回换过几次档。 */
function feed(governor: PerfGovernor, ms: number, frames: number): number {
  let changes = 0;
  for (let i = 0; i < frames; i++) {
    if (governor.sample(ms)) {
      changes++;
    }
  }
  return changes;
}

/** 学出显示器周期需要的预热帧数,给足余量。 */
const WARMUP = 240;

const HZ60 = 1000 / 60;
const HZ144 = 1000 / 144;

describe('PerfGovernor', () => {
  it('样本不够就不做任何判断', () => {
    const governor = new PerfGovernor();
    expect(feed(governor, 100, PERF.periodMinSamples - 1)).toBe(0);
    expect(governor.levelIndex).toBe(0);
  });

  it('稳定跑满 60 Hz 不降档', () => {
    const governor = new PerfGovernor();
    feed(governor, HZ60, 600);
    expect(governor.levelIndex).toBe(0);
  });

  it('稳定跑满 144 Hz 也不降档 —— 判据是周期的倍数,不是绝对毫秒', () => {
    const governor = new PerfGovernor();
    feed(governor, HZ144, 600);
    expect(governor.levelIndex).toBe(0);
    expect(governor.displayPeriodMs).toBeCloseTo(HZ144, 6);
  });

  it('真的掉帧(60 Hz 屏上每帧 33 ms)就降档', () => {
    const governor = new PerfGovernor();
    // 先让它学到周期:一段跑满,然后开始掉帧。
    feed(governor, HZ60, WARMUP);
    const changes = feed(governor, HZ60 * 2, PERF.windowFrames + PERF.cooldownFrames);
    expect(changes).toBeGreaterThan(0);
    expect(governor.levelIndex).toBeGreaterThan(0);
  });

  it('一直掉帧会降到最低档就停住,不会越界', () => {
    const governor = new PerfGovernor();
    feed(governor, HZ60, WARMUP);
    feed(governor, HZ60 * 3, 6000);
    expect(governor.levelIndex).toBe(PERF.levels.length - 1);
    expect(governor.level.scale).toBe(PERF.levels[PERF.levels.length - 1]?.scale);
  });

  it('后处理只在最低一档才关 —— 前面几档先降分辨率', () => {
    // 这条钉的是顺序本身(见 PERF.levels 的注释),不是某个具体数值。
    for (let i = 0; i < PERF.levels.length - 1; i++) {
      expect(PERF.levels[i]?.post, `第 ${i} 档不该关后处理`).toBe(true);
    }
    expect(PERF.levels[PERF.levels.length - 1]?.post).toBe(false);
    // 分辨率必须逐档单调下降,否则"降一档"就不是降。
    for (let i = 1; i < PERF.levels.length; i++) {
      expect(PERF.levels[i]!.scale).toBeLessThanOrEqual(PERF.levels[i - 1]!.scale);
    }
  });

  it('压力过去之后会升回来', () => {
    const governor = new PerfGovernor();
    feed(governor, HZ60, WARMUP);
    feed(governor, HZ60 * 2, 1000);
    const dropped = governor.levelIndex;
    expect(dropped).toBeGreaterThan(0);

    feed(governor, HZ60, 4000);
    expect(governor.levelIndex).toBeLessThan(dropped);
  });

  it('升档试探失败之后不会一直来回抖', () => {
    /*
     * vsync 把余量藏起来了:降档之后"跑满 60 fps"和"刚好只能跑 60 fps"报的
     * 是同一个 16.7 ms,所以升档本质上是试探。只有冷却挡不住来回抖 ——
     * 升上去掉帧、降回来、冷却结束再升,无限循环,画面每几秒闪一次。
     *
     * 这里模拟的就是那个环境:第 0 档撑不住(掉帧),第 1 档跑得满。
     */
    const governor = new PerfGovernor();
    feed(governor, HZ60, WARMUP);
    feed(governor, HZ60 * 2, 400); // 掉到第 1 档

    // 跑 30000 帧 ≈ 8 分钟。环境全程不变,第 0 档就是撑不住。
    const half = 15000;
    let early = 0;
    let late = 0;
    let previous = governor.levelIndex;
    for (let i = 0; i < half * 2; i++) {
      governor.sample(governor.levelIndex === 0 ? HZ60 * 2 : HZ60);
      if (governor.levelIndex !== previous) {
        if (i < half) {
          early++;
        } else {
          late++;
        }
        previous = governor.levelIndex;
      }
    }
    /*
     * 没有退避的话,每 ceilingHoldFrames(30 秒)就来回一次,8 分钟要抖
     * 三十几次。有退避之后总数要小得多,而且**后半段必须比前半段安静** ——
     * 这条才是"退避真的在起作用"的证据,单看总数看不出来。
     */
    expect(early + late).toBeLessThanOrEqual(14);
    expect(late).toBeLessThan(early);
  });

  it('切标签页那种超长间隔被丢掉,不会让画质无端掉两档', () => {
    const governor = new PerfGovernor();
    feed(governor, HZ60, WARMUP);
    feed(governor, PERF.outlierMs + 1, 200);
    expect(governor.levelIndex).toBe(0);
    // 负数/NaN 同样不该进窗口。
    expect(governor.sample(Number.NaN)).toBe(false);
    expect(governor.sample(-1)).toBe(false);
  });

  it('换档之后有冷却 —— 重建渲染目标本身会造成长帧,不冷却会连锁降档', () => {
    const governor = new PerfGovernor();
    feed(governor, HZ60, WARMUP);

    // 一帧一帧喂,记下每次换档发生在第几帧。
    const at: number[] = [];
    for (let i = 0; i < 2000; i++) {
      if (governor.sample(HZ60 * 2)) {
        at.push(i);
      }
    }
    expect(at.length).toBeGreaterThan(1);
    for (let i = 1; i < at.length; i++) {
      expect(
        (at[i] as number) - (at[i - 1] as number),
        '两次换档挨得比冷却还近',
      ).toBeGreaterThanOrEqual(PERF.cooldownFrames);
    }
  });

  it('自定义档位表只有一档时就是个空操作', () => {
    const governor = new PerfGovernor([{ scale: 1, post: true }]);
    feed(governor, HZ60, WARMUP);
    feed(governor, HZ60 * 4, 2000);
    expect(governor.levelIndex).toBe(0);
  });

  it('档位表为空直接报错 —— 这是配置写错了,不该悄悄降级', () => {
    expect(() => new PerfGovernor([])).toThrow();
  });
});
