import { describe, expect, it } from 'vitest';
import { applyDraft } from '../../src/game/draft';
import { DRAFT } from '../../src/game/tuning';
import type { Vehicle } from '../../src/game/vehicle';

/**
 * `applyDraft` 只读位置/朝向/lateral,写 `dragScale`。用最小假车而不是真
 * `Vehicle`:这一层的逻辑和物理无关,真车要 initPhysics + 地面查询,慢且
 * 把判定逻辑的失败和物理的失败混在一起。
 */
function car(x: number, z: number, yaw = 0, lateral = 0): Vehicle {
  return {
    position: { x, y: 0, z },
    yaw,
    lateral,
    dragScale: 1,
  } as unknown as Vehicle;
}

describe('applyDraft', () => {
  it('场上只有自己时没有尾流', () => {
    const a = car(0, 0);
    applyDraft([a]);
    expect(a.dragScale).toBe(1);
  });

  it('正前方近距离有车 —— 拿到满额减阻', () => {
    // yaw = 0 时车头朝 +Z。
    const me = car(0, 0);
    const ahead = car(0, DRAFT.fullDistance - 1);
    applyDraft([me, ahead]);
    expect(me.dragScale).toBeCloseTo(1 - DRAFT.maxReduction, 6);
    // 前车自己没人挡风。
    expect(ahead.dragScale).toBe(1);
  });

  it('距离越远尾流越弱,超出 maxDistance 完全没有', () => {
    const near = car(0, 0);
    applyDraft([near, car(0, DRAFT.fullDistance + 1)]);
    const far = car(0, 0);
    applyDraft([far, car(0, DRAFT.maxDistance - 1)]);
    expect(near.dragScale).toBeLessThan(far.dragScale);
    expect(far.dragScale).toBeLessThan(1);

    const none = car(0, 0);
    applyDraft([none, car(0, DRAFT.maxDistance + 1)]);
    expect(none.dragScale).toBe(1);
  });

  it('横向错开太多吃不到 —— 错身跟车没有牵引', () => {
    const me = car(0, 0, 0, 0);
    const beside = car(0, DRAFT.fullDistance, 0, DRAFT.lateralGap + 0.5);
    applyDraft([me, beside]);
    expect(me.dragScale).toBe(1);
  });

  it('后方的车不产生尾流', () => {
    const me = car(0, 0);
    const behind = car(0, -DRAFT.fullDistance);
    applyDraft([me, behind]);
    expect(me.dragScale).toBe(1);
  });

  it('尾流不叠加 —— 前面排两辆也只按最强的一份算', () => {
    const me = car(0, 0);
    applyDraft([me, car(0, DRAFT.fullDistance - 1), car(0, DRAFT.fullDistance)]);
    expect(me.dragScale).toBeCloseTo(1 - DRAFT.maxReduction, 6);
    expect(me.dragScale).toBeGreaterThan(0);
  });

  it('车头朝向变了,判定跟着转 —— 用的是车头方向不是世界坐标', () => {
    // 车头朝 +X(yaw = π/2),此时 +Z 方向的车在侧面,不算前方。
    const me = car(0, 0, Math.PI / 2);
    applyDraft([me, car(0, DRAFT.fullDistance)]);
    expect(me.dragScale).toBe(1);

    const me2 = car(0, 0, Math.PI / 2);
    applyDraft([me2, car(DRAFT.fullDistance - 1, 0)]);
    expect(me2.dragScale).toBeLessThan(1);
  });

  it('每帧重算 —— 前车走开之后阻力立刻恢复', () => {
    const me = car(0, 0);
    const ahead = car(0, DRAFT.fullDistance - 1);
    applyDraft([me, ahead]);
    expect(me.dragScale).toBeLessThan(1);
    applyDraft([me]);
    expect(me.dragScale).toBe(1);
  });
});
