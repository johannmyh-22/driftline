import { beforeAll, describe, expect, it } from 'vitest';
import { createInputFrame } from '../../src/core/input';
import { FIXED_DT } from '../../src/core/loop';
import type { GroundHit, GroundQuery } from '../../src/game/groundQuery';
import { Physics, initPhysics } from '../../src/game/physics';
import { Vehicle } from '../../src/game/vehicle';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 平地抓地基准。
 *
 * 「峰值侧向抓地 1.3~1.6 g」这条验收线**按平地定**(2026-08 由人类拍板)。
 * 原来它测在起伏赛道上,而赛道的倾斜弯和下坡凹谷会把垂直载荷压到静态车重
 * 的 2~3.4 倍,轮胎照着这个载荷放出来的侧向力自然超过 1.6 g —— 那是真实
 * 的(Daytona 大倾斜弯就是这样),不是 bug。但它同时让这条线随车最后停在
 * 哪个弯而混沌跳变,调参等于拟合噪声。
 *
 * 所以本征能力测在**绝对平面**上:同一个地面查询、同一段输入,没有地形
 * 变量,数值可复现。赛道上的上限另测,见 grip.test.ts。
 * ══════════════════════════════════════════════════════════════════════════
 */

/** 绝对平面。没有起伏、没有墙,只留轮胎和载荷这两个变量。 */
const flatGround: GroundQuery = {
  sample(_x: number, _z: number, out: GroundHit): void {
    out.height = 0;
    out.normalX = 0;
    out.normalY = 1;
    out.normalZ = 0;
    out.lateral = 0;
    out.arc = 0;
    out.segment = 0;
    out.onTrack = true;
    out.tangentX = 0;
    out.tangentZ = 1;
    out.wallDistance = Number.POSITIVE_INFINITY;
  },
};

/** 直线推到 `targetKmh`,再满舵过弯 3 秒,返回峰值侧向抓地(m/s²)。 */
function peakLateralAccel(targetKmh: number): number {
  const vehicle = new Vehicle(flatGround, new Physics());
  vehicle.reset(0, 0, 0);
  const input = createInputFrame();
  input.throttle = 1;

  let frames = 0;
  while (vehicle.groundSpeed * 3.6 < targetKmh && frames < 60 * 20) {
    vehicle.update(input, FIXED_DT);
    frames++;
  }

  let peak = 0;
  input.steer = 1;
  for (let i = 0; i < 60 * 3; i++) {
    vehicle.update(input, FIXED_DT);
    peak = Math.max(peak, vehicle.lateralGripAccel);
  }
  return peak;
}

beforeAll(async () => {
  await initPhysics();
});

describe('平地基准:轮胎本征抓地', () => {
  it('80 km/h 满舵过弯的峰值侧向抓地落在 1.3~1.6 g', () => {
    const peak = peakLateralAccel(80);
    expect(peak).toBeGreaterThan(1.3 * 9.81);
    expect(peak).toBeLessThan(1.6 * 9.81);
  });

  it('100 km/h 也落在同一区间 —— 下压力不该把本征抓地顶穿', () => {
    const peak = peakLateralAccel(100);
    expect(peak).toBeGreaterThan(1.3 * 9.81);
    expect(peak).toBeLessThan(1.6 * 9.81);
  });
});
