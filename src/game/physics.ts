import RAPIER from '@dimforge/rapier3d-compat';
import { FIXED_DT } from '../core/loop';
import { VEHICLE } from './tuning';

/**
 * 物理引擎边界。**全项目只有这个文件 import Rapier。**
 *
 * 这样做不是为了「以后好换引擎」那种空话,而是为了两件具体的事:
 *
 * 1. **固定步长只在这里被设定一次。** Rapier 的确定性建立在「每次 step 的 dt
 *    完全一样」上,任何一处用了可变 dt 都会把它毁掉,而那种 bug 不会报错、
 *    只会让回放慢慢对不上。收在一个地方,就没有第二个地方能写错。
 * 2. **wasm 的异步初始化只有一处要等。** `RAPIER.init()` 必须在造任何世界
 *    之前 await 完,漏掉一处就是运行时崩溃。
 *
 * 确定性本身有测试守着,见 `tests/unit/physics.test.ts`。
 */

let ready = false;

/**
 * 加载并初始化 wasm。**造 `Physics` 之前必须 await 它。**
 *
 * 重复调用是安全的 —— 主循环、单测、截图脚本各自都想确保初始化过,
 * 让它们各自调用比让每个调用方去记「谁负责初始化」要可靠。
 */
export async function initPhysics(): Promise<void> {
  if (ready) {
    return;
  }
  await RAPIER.init();
  ready = true;
}

/** 一个刚体的只读状态,读进调用方给的对象,不分配。 */
export interface BodyState {
  x: number;
  y: number;
  z: number;
  /** 姿态四元数。 */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** 线速度(米/秒,世界系)。 */
  vx: number;
  vy: number;
  vz: number;
  /** 角速度(弧度/秒,世界系)。 */
  wx: number;
  wy: number;
  wz: number;
}

export function createBodyState(): BodyState {
  return {
    x: 0, y: 0, z: 0,
    qx: 0, qy: 0, qz: 0, qw: 1,
    vx: 0, vy: 0, vz: 0,
    wx: 0, wy: 0, wz: 0,
  };
}

/** 车身的质量与惯量。按均质长方体算,真实车辆的偏航/侧倾惯量量级就在这附近。 */
export interface ChassisSpec {
  mass: number;
  /** 车身尺寸(米):宽 × 高 × 长,长边沿局部 +Z(车头方向)。 */
  width: number;
  height: number;
  length: number;
}

/*
 * 每帧路径上的临时量。Rapier 的 API 吃普通对象字面量,而这些调用每帧发生
 * 十几次(四个轮子各两三次施力),照着写 `{ x, y, z }` 就是每帧十几次分配。
 */
const vecA = { x: 0, y: 0, z: 0 };
const vecB = { x: 0, y: 0, z: 0 };

export class Physics {
  private readonly world: RAPIER.World;

  constructor() {
    if (!ready) {
      throw new Error('造 Physics 之前必须 await initPhysics()');
    }
    // 真实重力。悬浮那版用的是 26 —— 那是反重力设定下为了压住载具编的数,
    // 真车必须用 9.81,否则轮胎载荷、载荷转移、悬挂行程全部对不上现实量级。
    this.world = new RAPIER.World({ x: 0, y: -VEHICLE.gravity, z: 0 });
    // 固定步长是确定性的前提,设在这里、只设一次。
    this.world.timestep = FIXED_DT;
  }

  /**
   * 造车身刚体。**不挂碰撞体** —— 轮子的接地靠 `Course.sample()` 查询,
   * 那条路径保证了「物理查询的面 == 渲染出来的面」(见 `docs/HANDOFF.md`
   * 第四节不变量 1),换成引擎的三角网碰撞体反而会引入两套面。
   *
   * 没有碰撞体就没有由碰撞体推出的质量,所以质量和惯量在这里显式给。
   * 这也更可控:惯量是手感的一部分,不该是几何体的副产物。
   */
  createChassis(spec: ChassisSpec): RAPIER.RigidBody {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        // 车永远在被驱动,让它睡着只会让第一帧输入丢失。
        .setCanSleep(false),
    );

    const { mass, width, height, length } = spec;
    const k = mass / 12;
    body.setAdditionalMassProperties(
      mass,
      { x: 0, y: 0, z: 0 },
      {
        // 绕 X = 俯仰,绕 Y = 偏航,绕 Z = 侧倾。
        x: k * (height * height + length * length),
        y: k * (width * width + length * length),
        z: k * (width * width + height * height),
      },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );
    return body;
  }

  /** 在世界点上施力(牛)。力只作用一步,每步都要重新施加。 */
  addForceAtPoint(
    body: RAPIER.RigidBody,
    fx: number, fy: number, fz: number,
    px: number, py: number, pz: number,
  ): void {
    vecA.x = fx; vecA.y = fy; vecA.z = fz;
    vecB.x = px; vecB.y = py; vecB.z = pz;
    body.addForceAtPoint(vecA, vecB, true);
  }

  /** 在世界点上施加冲量(牛·秒)。撞墙这种瞬时事件用它,不用力。 */
  applyImpulseAtPoint(
    body: RAPIER.RigidBody,
    ix: number, iy: number, iz: number,
    px: number, py: number, pz: number,
  ): void {
    vecA.x = ix; vecA.y = iy; vecA.z = iz;
    vecB.x = px; vecB.y = py; vecB.z = pz;
    body.applyImpulseAtPoint(vecA, vecB, true);
  }

  setTransform(
    body: RAPIER.RigidBody,
    x: number, y: number, z: number,
    qx: number, qy: number, qz: number, qw: number,
  ): void {
    vecA.x = x; vecA.y = y; vecA.z = z;
    body.setTranslation(vecA, true);
    body.setRotation({ x: qx, y: qy, z: qz, w: qw }, true);
  }

  setVelocity(
    body: RAPIER.RigidBody,
    vx: number, vy: number, vz: number,
    wx: number, wy: number, wz: number,
  ): void {
    vecA.x = vx; vecA.y = vy; vecA.z = vz;
    body.setLinvel(vecA, true);
    vecB.x = wx; vecB.y = wy; vecB.z = wz;
    body.setAngvel(vecB, true);
  }

  read(body: RAPIER.RigidBody, out: BodyState): BodyState {
    const t = body.translation();
    const r = body.rotation();
    const v = body.linvel();
    const w = body.angvel();
    out.x = t.x; out.y = t.y; out.z = t.z;
    out.qx = r.x; out.qy = r.y; out.qz = r.z; out.qw = r.w;
    out.vx = v.x; out.vy = v.y; out.vz = v.z;
    out.wx = w.x; out.wy = w.y; out.wz = w.z;
    return out;
  }

  /**
   * 清掉上一步累积的力和力矩。**每帧施力之前必须先调它。**
   *
   * Rapier 的 `addForce` / `addForceAtPoint` 是**持续力**:加进去之后会一直
   * 留在累加器里,`step()` 不会清。不清的话,这一帧的悬挂力叠在上一帧之上,
   * 几秒钟就指数爆炸 —— 实测忘了这一步时,车 30 秒飞到 1267 km/h、离地 −324 米。
   *
   * 症状很像「弹簧参数不稳定」,很容易被误导去调刚度和阻尼,那个方向是死路。
   */
  resetForces(body: RAPIER.RigidBody): void {
    body.resetForces(true);
    body.resetTorques(true);
  }

  /** 推进一个固定步。**dt 不是参数** —— 见类注释。 */
  step(): void {
    this.world.step();
  }

  dispose(): void {
    this.world.free();
  }
}
