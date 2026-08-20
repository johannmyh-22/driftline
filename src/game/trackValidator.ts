/**
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

/** 闭环回绕:让任意整数索引落在合法范围内。JS 里 -1 % n === -1,所以要 +n 再取模。 */
function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

/** 对数组做带判空的索引访问,越界(或空数组)时返回 undefined。 */
function at<T>(arr: readonly T[] | T[], index: number): T | undefined {
  return arr[index];
}

/** 第 `a`、`b` 两个点在 XZ 平面上的平方距离。 */
function sqDistXZ(a: TrackPoint, b: TrackPoint): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** 点 `p` 到线段 `a→b` 在 XZ 平面上的最短距离。 */
function pointSegmentDistXZ(p: TrackPoint, a: TrackPoint, b: TrackPoint): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lenSq = abx * abx + abz * abz;
  // 退化成点时就返回到端点的距离。
  if (lenSq === 0) {
    return Math.sqrt(sqDistXZ(p, a));
  }
  const apx = p.x - a.x;
  const apz = p.z - a.z;
  const t = Math.max(0, Math.min(1, (apx * abx + apz * abz) / lenSq));
  const projx = a.x + abx * t;
  const projz = a.z + abz * t;
  const dx = p.x - projx;
  const dz = p.z - projz;
  return Math.sqrt(dx * dx + dz * dz);
}

/** 线段 `a→b` 与线段 `c→d` 在 XZ 平面上的最短距离。 */
function segmentSegmentDistXZ(
  a: TrackPoint,
  b: TrackPoint,
  c: TrackPoint,
  d: TrackPoint,
): number {
  // 四组「点到另一条线段」的距离里取最小,即为两线段最短距离。
  return Math.min(
    pointSegmentDistXZ(a, c, d),
    pointSegmentDistXZ(b, c, d),
    pointSegmentDistXZ(c, a, b),
    pointSegmentDistXZ(d, a, b),
  );
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
export function curvatureRadiusAt(points: readonly TrackPoint[], index: number): number {
  const n = points.length;
  const p0 = at(points, wrapIndex(index - 1, n));
  const p1 = at(points, wrapIndex(index, n));
  const p2 = at(points, wrapIndex(index + 1, n));

  // 空数组时 wrapIndex 会得到 undefined,这里显式兜底,不让后续计算崩。
  if (p0 === undefined || p1 === undefined || p2 === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  const a = Math.sqrt(sqDistXZ(p0, p1));
  const b = Math.sqrt(sqDistXZ(p1, p2));
  const c = Math.sqrt(sqDistXZ(p2, p0));

  // 用叉积算三角形面积(海伦公式在浮点上不如叉积稳),共线时面积是 0。
  const area = 0.5 * Math.abs(
    (p0.x - p2.x) * (p1.z - p2.z) - (p1.x - p2.x) * (p0.z - p2.z),
  );
  // 三点共线没有外接圆,按「无限直」处理,不除以零。
  if (area === 0) {
    return Number.POSITIVE_INFINITY;
  }
  // 外接圆半径 R = abc / (4A)。
  return (a * b * c) / (4 * area);
}

/**
 * 第 `index` 个点到下一个点的坡度 = |Δy| / 水平距离(闭环回绕)。
 *
 * 水平距离为 0 时返回 `Infinity`(垂直的墙,一定不合格)。
 */
export function gradeAt(points: readonly TrackPoint[], index: number): number {
  const n = points.length;
  const p0 = at(points, wrapIndex(index, n));
  const p1 = at(points, wrapIndex(index + 1, n));

  if (p0 === undefined || p1 === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  const horizontal = Math.sqrt(sqDistXZ(p0, p1));
  // 水平距离为 0 意味着一段纯竖直的墙,按坡度无限大处理。
  if (horizontal === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(p1.y - p0.y) / horizontal;
}

/**
 * 找出条带压到自己的地方。
 *
 * 判据:两条中心线线段 i 与 j,在 **XZ 平面**上的最短距离小于 `2 * halfWidth`
 * (两侧条带贴到一起),就算自交。线段 i 指 `points[i] → points[i + 1]`,
 * 最后一段回绕到 `points[0]`。
 *
 * 必须排除沿赛道方向本来就挨着的线段,否则每一对相邻线段都会误报。两条规则:
 *
 * 1. **共用端点的线段直接跳过**,与弧长无关 —— 它们的最短距离恒为 0,
 *    永远不可能通过距离判据。
 * 2. 两段中点沿闭环的弧长距离(取两个方向里较短的那个)小于 `4 * halfWidth` 时跳过。
 *
 * 只有规则 2 是不够的:它是个绝对长度,点稀疏时(比如边长 100 米、只有 4 个点的
 * 方形闭环)相邻段的弧长距离会超过阈值,于是一个完全合法的赛道被报出 4 处自交。
 *
 * 返回的每一对里 `indexA < indexB`,整体按 `indexA` 再按 `indexB` 升序,
 * 保证同样的输入永远给出同样的顺序。
 */
export function findSelfIntersections(
  points: readonly TrackPoint[],
  halfWidth: number,
): Array<{ indexA: number; indexB: number; distance: number }> {
  const n = points.length;
  const result: Array<{ indexA: number; indexB: number; distance: number }> = [];

  // 少于两条线段的闭环无法构成自交,也没有意义。
  if (n < 2) {
    return result;
  }

  // 沿闭环从线段 0 到第 i 个点起点的累计弧长,arcAtPoint[i] 即 points[i] 的弧长位置。
  const arcAtPoint: number[] = [0];
  for (let i = 0; i < n; i++) {
    const a = at(points, i);
    const b = at(points, wrapIndex(i + 1, n));
    // 输入长度保证这些元素都存在;取不到时按 0 弧长兜底,不影响整体判定。
    const segLen = a === undefined || b === undefined ? 0 : Math.sqrt(sqDistXZ(a, b));
    arcAtPoint.push((arcAtPoint[i] ?? 0) + segLen);
  }
  const totalArc = arcAtPoint[n] ?? 0;

  // 两段中点沿闭环的较短弧长距离(两个绕行方向取较小那个)。
  function arcDistBetweenMidpoints(i: number, j: number): number {
    const mi = ((arcAtPoint[i] ?? 0) + (arcAtPoint[i + 1] ?? 0)) / 2;
    const mj = ((arcAtPoint[j] ?? 0) + (arcAtPoint[j + 1] ?? 0)) / 2;
    const forward = Math.abs(mj - mi);
    const backward = totalArc - forward;
    return Math.min(forward % totalArc, backward % totalArc);
  }

  const threshold = 2 * halfWidth;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // 共用端点的相邻段(含末段回绕接首段)距离恒为 0,先无条件排掉。
      if (j === i + 1 || (i === 0 && j === n - 1)) {
        continue;
      }
      // 再去掉沿赛道方向靠得很近的一批,避免同一段弯道两侧互相误报。
      if (arcDistBetweenMidpoints(i, j) < 4 * halfWidth) {
        continue;
      }
      const a = at(points, i);
      const b = at(points, wrapIndex(i + 1, n));
      const c = at(points, j);
      const d = at(points, wrapIndex(j + 1, n));
      // 这四个下标的取值受 n 约束,必然存在;判空是为了让类型收窄成 TrackPoint。
      if (a === undefined || b === undefined || c === undefined || d === undefined) {
        continue;
      }
      const distance = segmentSegmentDistXZ(a, b, c, d);
      if (distance < threshold) {
        result.push({ indexA: i, indexB: j, distance });
      }
    }
  }

  // i、j 都按升序扫描,天然符合「先 indexA 再 indexB」的要求。
  return result;
}

/**
 * 汇总判定。`problems` 的顺序:先全部 self-intersection,再全部 curvature,
 * 最后全部 grade;每类内部按 index 升序。
 *
 * 点数少于 4 或 `halfWidth <= 0` 时抛 `RangeError` —— 闭环赛道少于 4 个点
 * 没有意义,静默返回「合格」会让生成器把废数据放行。
 */
export function validateTrack(
  points: readonly TrackPoint[],
  limits: TrackLimits,
): TrackValidation {
  if (points.length < 4 || limits.halfWidth <= 0) {
    throw new RangeError('闭环赛道至少需要 4 个点,且 halfWidth 必须为正');
  }

  const selfInt = findSelfIntersections(points, limits.halfWidth);
  const curvProblems: Array<Extract<TrackProblem, { kind: 'curvature' }>> = [];
  const gradeProblems: Array<Extract<TrackProblem, { kind: 'grade' }>> = [];
  let minCurvatureRadius = Number.POSITIVE_INFINITY;
  let maxGrade = 0;

  for (let i = 0; i < points.length; i++) {
    const radius = curvatureRadiusAt(points, i);
    minCurvatureRadius = Math.min(minCurvatureRadius, radius);
    if (radius < limits.minCurvatureRadius) {
      curvProblems.push({ kind: 'curvature', index: i, radius });
    }

    const grade = gradeAt(points, i);
    maxGrade = Math.max(maxGrade, grade);
    if (grade > limits.maxGrade) {
      gradeProblems.push({ kind: 'grade', index: i, grade });
    }
  }

  // findSelfIntersections 返回的是不带 kind 的裸结构,这里补上判别字段 ——
  // 少了它 problems 里的自交项就认不出来,调用方的 kind 分支会全部落空。
  const problems: TrackProblem[] = [
    ...selfInt.map((hit) => ({ kind: 'self-intersection' as const, ...hit })),
    ...curvProblems,
    ...gradeProblems,
  ];

  return {
    ok: problems.length === 0,
    problems,
    minCurvatureRadius,
    maxGrade,
  };
}
