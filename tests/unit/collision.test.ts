import { beforeAll, describe, expect, it } from 'vitest';
import { createInputFrame } from '../../src/core/input';
import { FIXED_DT } from '../../src/core/loop';
import { Rng } from '../../src/core/rng';
import { Heightfield } from '../../src/game/heightfield';
import { Physics, initPhysics } from '../../src/game/physics';
import { CAR } from '../../src/game/tuning';
import { Vehicle } from '../../src/game/vehicle';

/*
 * M7 车间碰撞的下限测试。`Physics.createChassis()` 现在会给车身挂一个
 * density = 0 的碰撞体(physics.ts),两辆车第一次可以共享同一个 Physics
 * 世界互相撞上。
 *
 * 这里只证机器能证的部分:穿模会被推开、分开过程数值不发散、同样的输入
 * 跑两次结果一致。**「撞起来像不像真车」证不了**——弹性/摩擦系数
 * (`CAR.collisionRestitution/Friction`)是估的,没有实测,跟甩尾手感
 * 同一类,需要人类实际撞一次确认(见 docs/HANDOFF.md 第三十五节)。
 */

const idle = createInputFrame();

beforeAll(async () => {
  await initPhysics();
});

/** 两辆车共享一个 Physics 世界:各自 applyForces() → 共用一次 step() → 各自 readState()。 */
function stepBoth(a: Vehicle, b: Vehicle, physics: Physics, steps: number): void {
  for (let i = 0; i < steps; i++) {
    a.applyForces(idle, FIXED_DT);
    b.applyForces(idle, FIXED_DT);
    physics.step();
    a.readState(FIXED_DT);
    b.readState(FIXED_DT);
  }
}

/** 横向间距故意小于车宽,让两个碰撞体在第一帧就有一段重叠。 */
function makeOverlappingPair(seed: number): { physics: Physics; a: Vehicle; b: Vehicle } {
  const field = new Heightfield(new Rng(seed));
  const physics = new Physics();
  const a = new Vehicle(field, physics);
  const b = new Vehicle(field, physics);
  a.reset(-CAR.bodyWidth * 0.42, 0, 0);
  b.reset(CAR.bodyWidth * 0.42, 0, 0);
  return { physics, a, b };
}

describe('车间碰撞', () => {
  it('横向重叠会被推开,不再穿模', () => {
    const { physics, a, b } = makeOverlappingPair(1);
    const initialGap = Math.abs(a.position.x - b.position.x);
    expect(initialGap).toBeLessThan(CAR.bodyWidth);

    stepBoth(a, b, physics, 90);

    const finalGap = Math.abs(a.position.x - b.position.x);
    expect(finalGap).toBeGreaterThan(initialGap);
    expect(finalGap).toBeGreaterThanOrEqual(CAR.bodyWidth * 0.85);
  });

  it('分开之后不会数值发散', () => {
    const { physics, a, b } = makeOverlappingPair(2);
    stepBoth(a, b, physics, 180);

    for (const v of [a, b]) {
      expect(Number.isFinite(v.position.x)).toBe(true);
      expect(Number.isFinite(v.position.y)).toBe(true);
      expect(Number.isFinite(v.position.z)).toBe(true);
      expect(v.speed).toBeLessThan(50);
    }
  });

  it('同样的初始状态跑两次,结果一致', () => {
    const run = (): number[] => {
      const { physics, a, b } = makeOverlappingPair(3);
      stepBoth(a, b, physics, 120);
      return [a.position.x, a.position.y, a.position.z, b.position.x, b.position.y, b.position.z];
    };
    expect(run()).toEqual(run());
  });
});
