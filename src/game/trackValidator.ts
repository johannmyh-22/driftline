/**
 * 赛道校验器 —— **接口与文档已定,实现待填**。
 *
 * 参数暂时带下划线前缀只是为了让 `noUnusedParameters` 放行,填实现时去掉。
 * 对应的测试在 `tests/unit/trackValidator.test.ts`,当前是 skip 状态,
 * 实现落地时必须一并解除。
 *
 * 赛道校验器。**纯几何,没有副作用,不碰渲染。**
 *
 * M2 的赛道由 seed 随机生成,生成出来不一定能跑:可能有过不去的急弯、
 * 爬不上去的陡坡,或者条带自己压到自己。生成器靠这里判定「这个 seed 废了,
 * 换一个重来」,所以判定必须便宜、确定、可复现。
 *
 * 中心线传进来时已经沿弧长重采样过,相邻点间距近似均匀。
 */

export interface TrackPoint {
  x: number;
  y: number;
  z: number;
}

export interface TrackLimits {
  /** 赛道半宽(米)。自交要按条带算,不能只看中心线。 */
  halfWidth: number;
  /** 允许的最小曲率半径(米)。比这更急的弯在极速下过不去。 */
  minCurvatureRadius: number;
  /** 允许的最大坡度,垂直位移 / 水平位移。0.3 约等于 17°。 */
  maxGrade: number;
}

export type TrackProblem =
  | { kind: 'self-intersection'; indexA: number; indexB: number; distance: number }
  | { kind: 'curvature'; index: number; radius: number }
  | { kind: 'grade'; index: number; grade: number };

export interface TrackValidation {
  ok: boolean;
  /** 全部问题。`ok` 为 true 时必须是空数组。 */
  problems: TrackProblem[];
  /** 实测的最小曲率半径(米)。整条线都是直的时为 Infinity。 */
  minCurvatureRadius: number;
  /** 实测的最大坡度。 */
  maxGrade: number;
}

/**
 * 第 `index` 个点处的曲率半径,单位米。
 *
 * 用相邻三点(`index - 1`、`index`、`index + 1`,首尾按闭环回绕)的外接圆半径
 * (Menger 曲率)。三点共线时返回 `Infinity`。
 *
 * **只在 XZ 平面上算。** 赛道的「弯急不急」是俯视看的事,一个上坡不该被
 * 当成急弯。
 */
export function curvatureRadiusAt(_points: readonly TrackPoint[], _index: number): number {
  throw new Error('未实现');
}

/**
 * 第 `index` 个点到下一个点的坡度 = |Δy| / 水平距离(闭环回绕)。
 *
 * 水平距离为 0 时返回 `Infinity`(垂直的墙,一定不合格)。
 */
export function gradeAt(_points: readonly TrackPoint[], _index: number): number {
  throw new Error('未实现');
}

/**
 * 找出条带压到自己的地方。
 *
 * 判据:两条中心线线段 i 与 j,在 **XZ 平面**上的最短距离小于 `2 * halfWidth`
 * (两侧条带贴到一起),就算自交。线段 i 指 `points[i] → points[i + 1]`,
 * 最后一段回绕到 `points[0]`。
 *
 * 必须排除沿赛道方向本来就挨着的线段,否则每一对相邻线段都会误报。排除规则:
 * 两段中点沿闭环的弧长距离(取两个方向里较短的那个)小于 `4 * halfWidth` 时跳过。
 *
 * 返回的每一对里 `indexA < indexB`,整体按 `indexA` 再按 `indexB` 升序,
 * 保证同样的输入永远给出同样的顺序。
 */
export function findSelfIntersections(
  _points: readonly TrackPoint[],
  _halfWidth: number,
): Array<{ indexA: number; indexB: number; distance: number }> {
  throw new Error('未实现');
}

/**
 * 汇总判定。`problems` 的顺序:先全部 self-intersection,再全部 curvature,
 * 最后全部 grade;每类内部按 index 升序。
 *
 * 点数少于 4 或 `halfWidth <= 0` 时抛 `RangeError` —— 闭环赛道少于 4 个点
 * 没有意义,静默返回「合格」会让生成器把废数据放行。
 */
export function validateTrack(
  _points: readonly TrackPoint[],
  _limits: TrackLimits,
): TrackValidation {
  throw new Error('未实现');
}
