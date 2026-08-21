/**
 * 轮胎模型(Magic Formula + 载荷敏感 + 摩擦圆)。
 *
 * 引擎只做刚体积分和碰撞;把一条胎的「工作状态」换算成它现在能给车多大的力,
 * 是这个文件唯一的事。它是纯函数:不碰 three.js / Rapier / 渲染,没有任何状态,
 * 每一帧每个轮子各自调一次。
 *
 * 三个环节的顺序不能反:先按各自方向算出理论力,再用联合滑移把共用的一份
 * 摩擦预算分配给两个方向 —— 预算在方向之间分配,而不是先扣掉某一向再算另一向,
 * 否则侧偏为零的满油门打滑会和正常行驶一样有满侧向力。
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

  // 两组独立形状参数:纵向和侧向的滑移-力曲线本来就长得不一样(C 差零点几,
  // 峰值出现的位置也不同),共用一组参数只会让某一向的曲线对不准它的峰值。
  const curveLong = normalizedCurve(
    Math.abs(state.slipRatio),
    TIRE.longitudinalB,
    TIRE.longitudinalC,
    TIRE.longitudinalE,
  );
  const curveLat = normalizedCurve(
    Math.abs(state.slipAngle),
    TIRE.lateralB,
    TIRE.lateralC,
    TIRE.lateralE,
  );

  // 联合滑移强度:两个方向离各自峰值的距离共同决定压了多少摩擦预算。用绝对值
  // 是因为方向和大小是两回事,反打方向只是换了个方向使力,预算照扣。
  const sigma = Math.hypot(
    state.slipRatio / TIRE.peakSlipRatio,
    state.slipAngle / TIRE.peakSlipAngle,
  );

  let long, lat;
  if (sigma > 1) {
    // 联合滑移过大:两块力都按比重压缩,合力落在摩擦圆内、沿当前的滑移方向。
    long = peak * curveLong * (Math.abs(state.slipRatio) / TIRE.peakSlipRatio / sigma);
    lat = peak * curveLat * (Math.abs(state.slipAngle) / TIRE.peakSlipAngle / sigma);
  } else {
    long = peak * curveLong;
    lat = peak * curveLat;
  }

  // 曲线本身归一化为非负(峰值处为 1);方向由滑移的符号给,大小由曲线给。
  out.longitudinal = long * (state.slipRatio < 0 ? -1 : 1);
  out.lateral = lat * (state.slipAngle < 0 ? -1 : 1);
  return out;
}

/**
 * Pacejka '89 简化式,归一化成峰值为 1 的非负曲线。
 *
 * 输入必须取绝对值:曲线本身描述的是「滑移量 → 附着比」的标量关系,方向由
 * 调用方在最后一步按符号加回去。这样负滑移天然得到负力、大小相等,不会出现
 * 「正负两半不对称导致朝刹车方向的力更小」这种隐性偏心。
 */
function normalizedCurve(s: number, b: number, c: number, e: number): number {
  const x = b * s;
  return Math.sin(c * Math.atan(x - e * (x - Math.atan(x))));
}
