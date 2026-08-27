/**
 * 轮胎模型(Magic Formula + 载荷敏感 + 摩擦圆)。
 *
 * 引擎只做刚体积分和碰撞;把一条胎的「工作状态」换算成它现在能给车多大的力,
 * 是这个文件唯一的事。它是纯函数:不碰 three.js / Rapier / 渲染,没有任何状态,
 * 每一帧每个轮子各自调一次。
 *
 * 三个环节的顺序不能反:先由载荷定出这条胎的摩擦预算,再把纵向和侧向的滑移
 * **合成**成一个量去取曲线,最后按方向把合力分回两个轴。合成在前是关键 ——
 * 两向各自取曲线再事后修正的话,摩擦圆在中等滑移区是封不住的(实测超预算 38%,
 * 见 `tireForce()` 里的注释)。
 */

import { TIRE } from './tuning';

/** 一条轮胎某一瞬间的工作状态。全部是接地点的局部量。 */
export interface TireState {
  /**
   * 纵向滑移率 κ。0 = 纯滚动,正 = 驱动打滑,负 = 抱死拖滑。
   * 定义:(轮速 - 车速) / max(|车速|, eps)
   */
  slipRatio: number;
  /** 侧偏角 α(弧度)。轮胎实际前进方向与轮胎指向的夹角。 */
  slipAngle: number;
  /** 垂直载荷(牛),恒为正。由悬挂给出,已经含了载荷转移。 */
  load: number;
  /** 路面附着系数。沥青 1,路肩 0.7,沙地 0.45(具体值由调用方给)。 */
  friction: number;
}

/** 轮胎产生的力(牛),接地点局部坐标。 */
export interface TireForce {
  /** 纵向力,正 = 推着车往前。 */
  longitudinal: number;
  /** 侧向力,正 = 指向轮胎局部 +x。 */
  lateral: number;
}

/**
 * 算一条胎当前产生的力。
 *
 * 结果写进 `out` 并返回它 —— 每帧被调四次,不能在这里分配对象。
 */
export function tireForce(state: TireState, out: TireForce): TireForce {
  // 任何非有限输入都回 0:一个 NaN 会随刚体积分把整车位置摊成 NaN、画面直接
  // 消失,而 "0 * NaN" 依旧是 NaN,光靠别处的包围根本拦不住。宁可这一帧没抓地。
  if (
    state.load <= 0 ||
    !Number.isFinite(state.slipRatio) ||
    !Number.isFinite(state.slipAngle) ||
    !Number.isFinite(state.load) ||
    !Number.isFinite(state.friction)
  ) {
    out.longitudinal = 0;
    out.lateral = 0;
    return out;
  }

  // 额定载荷处 μ 恰好等于给定系数;载荷往上涨时 μ 线性下降 —— 这是载荷
  // 转移降低总抓地的唯一定价机制(见 tuning 的 loadSensitivity 注释)。
  const fz0 = TIRE.staticLoadPerWheel;
  // 载荷极大时线性下降会算出负值,钳到 0,不然力会反向。
  const mu = Math.max(
    0,
    state.friction * TIRE.mu0 * (1 - (TIRE.loadSensitivity * (state.load - fz0)) / fz0),
  );

  // 峰值力随载荷缩放;载荷越大抓地越低,所以必须先算 μ 再乘 load。
  const peak = mu * state.load;

  /*
   * 联合滑移:**先合成,再取曲线,最后按方向分配。**
   *
   * 交付的第一版是「两向各自取曲线,只在 σ>1 时才压缩」,那样摩擦圆在 σ<1 的
   * 整片区域是不封顶的 —— 实测合力峰值到了 1.384·μFz,超预算 38%,发生在
   * κ=0.090 / α=0.087(两个都还在各自峰值以下,所以那个 σ>1 的分支根本进不去)。
   * 现在改成对合成滑移 σ 取一次曲线:|F| = peak·curve(σ) ≤ peak,**恒成立**,
   * 而且过峰下降在任意方向上都保留。
   */
  const nx = state.slipRatio / TIRE.peakSlipRatio;
  const ny = state.slipAngle / TIRE.peakSlipAngle;
  const sigma = Math.hypot(nx, ny);
  if (sigma < 1e-9) {
    out.longitudinal = 0;
    out.lateral = 0;
    return out;
  }

  // 形状参数按方向在纵向/侧向两组之间插值:纯纵向滑移用纵向的 C,纯侧向用侧向的 C。
  // 两条曲线的形状本来就不一样,合成之后不该只认其中一条。
  const longitudinalWeight = (nx * nx) / (sigma * sigma);
  const c = TIRE.lateralC + (TIRE.longitudinalC - TIRE.lateralC) * longitudinalWeight;
  const e = TIRE.lateralE + (TIRE.longitudinalE - TIRE.lateralE) * longitudinalWeight;
  // σ 已经是归一化滑移(峰值在 1),所以 B 就是把峰值钉在 1 的那个值。
  const b = Math.tan(Math.PI / (2 * c));
  const magnitude = peak * normalizedCurve(sigma, b, c, e);

  out.longitudinal = (magnitude * nx) / sigma;
  /*
   * **侧向力取负:轮胎力抵抗侧滑,不是顺着侧滑。**
   *
   * 交付的第一版没取负,`slipAngle=+0.14` 给出 `lateral=+4120` —— 车一向左滑
   * 就被继续推向左,正反馈,一帧就发散。任务书里只写了「正 = 指向轮胎局部 +x」,
   * 说的是坐标轴,没有钉死它和滑移方向的关系,是任务书的漏洞。
   *
   * 现在把物理关系写死在模块里,而不是留给每个调用方自己记得取负 ——
   * 这个项目已经因为「左右反了」栽过一次,那次也是符号约定散在调用方手里。
   */
  out.lateral = (-magnitude * ny) / sigma;
  return out;
}

/**
 * Pacejka '89 简化式,归一化成「峰值为 1」的曲线。
 *
 * 输入是**合成滑移 σ**(已经按各自的峰值归一化过),恒为非负,峰值钉在 σ=1。
 * 方向不在这里处理 —— 由调用方按 nx / ny 的比例分回两个轴,所以负滑移天然
 * 得到大小相等、方向相反的力。
 */
function normalizedCurve(s: number, b: number, c: number, e: number): number {
  const x = b * s;
  return Math.sin(c * Math.atan(x - e * (x - Math.atan(x))));
}
