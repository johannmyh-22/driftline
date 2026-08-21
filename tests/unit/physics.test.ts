import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';

/**
 * 物理引擎的确定性守卫。
 *
 * 「同 seed 逐帧复现」是整个测试体系、`?test=1` 步进、以及 M4 幽灵回放的地基
 * (`docs/HANDOFF.md` 第四节不变量 2)。引入 Rapier 之前,这条靠自写积分保证;
 * 之后它变成一个**依赖外部库的假设**,所以必须有测试盯着。
 *
 * 场景故意造得难:倾斜地面上的重物,持续偏置力,一路滑移翻滚 —— 逼求解器每帧
 * 做多次接触迭代。平白无奇的自由落体测不出求解器的不确定性。
 */
function run(steps: number): number[] {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;

  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    // 绕 Z 轴倾斜约 11°:平地上物体会停住,停住之后就测不到求解器的迭代了。
    RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setRotation({
      x: 0,
      y: 0,
      z: Math.sin(0.1),
      w: Math.cos(0.1),
    }),
    ground,
  );

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 6, 0).setAdditionalMass(1200),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(2, 0.6, 1).setFriction(1.2), body);

  for (let i = 0; i < steps; i++) {
    // 偏心施力,同时产生线加速度和力矩,姿态一直在变。
    body.addForceAtPoint({ x: 900, y: 0, z: 420 }, { x: 0.4, y: 0.3, z: -0.2 }, true);
    world.step();
  }

  const t = body.translation();
  const r = body.rotation();
  const v = body.linvel();
  return [t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z];
}

describe('Rapier 确定性', () => {
  it('同样的输入跑两次,逐位相同', async () => {
    await RAPIER.init();
    expect(run(600)).toEqual(run(600));
  });

  /*
   * 这条断言的是「与浏览器一致」,而它在 Node 里跑 —— 看起来测不到,其实测得到:
   *
   * WebAssembly 的浮点语义由规范强制(IEEE-754,不允许 FMA 合并、不允许重结合、
   * 没有扩展精度),所以**同一份 wasm 在任何符合规范的运行时上结果必然一致**。
   * 这正是原生编译的物理引擎做不到、而 wasm 版做得到的事。
   *
   * 实测验证过:同一段计算在 Node 和 Chromium(CI 用的 SwiftShader flag)里
   * 跑 600 步,10 个状态字段逐位完全相同。所以单测里的车辆行为能预测截图里的
   * 车辆行为 —— 这是把物理单测留在 vitest(8 秒)而不是搬进 Playwright
   * (2 分钟)的依据。
   *
   * 留下这个基准值:哪天升级 Rapier 版本导致它变了,说明求解器动过,
   * 所有手感数值和回放基准都要重新核。**它变了不代表是 bug,但一定意味着
   * 物理变了,需要人类确认。**
   */
  it('状态基准没漂(升级 Rapier 时这条会红,那是提醒不是故障)', async () => {
    await RAPIER.init();
    expect(run(600)).toEqual([
      2544.489013671875, -33.777103424072266, 1182.156005859375, 0.6743795871734619,
      -0.11628637462854385, 0.6002697348594666, -0.4139634966850281, 362.38641357421875,
      -8.79185676574707, 169.11170959472656,
    ]);
  });
});
