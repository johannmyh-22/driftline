/**
 * 向下地面查询的统一契约。
 *
 * 悬浮控制器、跟随相机、贴地阴影都只认这个接口,不关心脚下是 M1 那块平地
 * 还是 M2 的赛道 —— 所以 `?course=flat` 能在不动物理代码的前提下切回去。
 */
export interface GroundHit {
  height: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  /** 到赛道中心线的有符号横向距离,**正值在赛道右侧**。不在赛道上时是 Infinity。 */
  lateral: number;
  /** 沿赛道的弧长位置(米)。 */
  arc: number;
  /** 最近的中心线采样下标。 */
  segment: number;
  /** 是否踩在可跑的路面上。平地场景恒为 true。 */
  onTrack: boolean;
  /** 赛道前进方向的水平切线(单位向量)。撞墙时要靠它算墙面朝向。 */
  tangentX: number;
  tangentZ: number;
  /** 护栏所在的横向距离。没有墙时是 Infinity。 */
  wallDistance: number;
}

export function createGroundHit(): GroundHit {
  return {
    height: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    lateral: 0,
    arc: 0,
    segment: 0,
    onTrack: true,
    tangentX: 0,
    tangentZ: 1,
    wallDistance: Number.POSITIVE_INFINITY,
  };
}

export interface GroundQuery {
  /** 把结果写进 `out`,不要返回新对象 —— 它在每帧路径上。 */
  sample(x: number, z: number, out: GroundHit): void;
}
