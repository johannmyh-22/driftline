/**
 * 手感的唯一数据源。
 *
 * 所有影响驾驶感受的数字都必须待在这个文件里 —— 人类调手感时只该改这一个地方,
 * 不用去物理代码里翻魔法数字。改动请连同「为什么」一起写在注释里。
 *
 * 单位统一:长度 米,时间 秒,角度 弧度。
 */

export const VEHICLE = {
  /** 悬浮目标离地高度。太低会频繁擦地,太高会像在飞。 */
  rideHeight: 1.55,
  /**
   * 悬浮弹簧刚度与阻尼。阻尼取得接近临界阻尼:
   * 欠阻尼会在平地上持续上下弹,那个感觉像坏掉而不像悬浮。
   */
  hoverStiffness: 190,
  hoverDamping: 20,
  /**
   * 超过这个离地高度就认为脱离地面,悬浮力完全消失。
   * 给得比 rideHeight 大不少,冲过小起伏时才不会一帧一帧地断续吸附。
   */
  hoverRange: 3.6,

  /** 重力。比现实大,落地干脆,跳跃不拖沓。 */
  gravity: 26,

  /** 满油门推力加速度。 */
  thrust: 34,
  /** 倒车推力,明显弱于前进 —— 倒车不该是一种战术。 */
  reverseThrust: 12,
  /**
   * 阻力系数。和 thrust 联立解出极速:
   * thrust = dragLinear·v + dragQuadratic·v²  →  v ≈ 88 m/s(约 317 km/h)。
   * 改 thrust 就得回头核这两个数,否则极速会悄悄漂走。
   */
  dragQuadratic: 0.00234,
  dragLinear: 0.18,

  /**
   * 侧向抓地(每秒衰减率)。这是「漂移感」的主旋钮:
   * 调低 → 车尾更容易滑出去;调高 → 像在轨道上跑。
   */
  lateralGrip: 11,
  /** 空中几乎没有侧向抓地,不然会出现空中急转的怪异手感。 */
  lateralGripAirborne: 0.6,

  /**
   * 空气刹:额外阻力 + 额外抓地,用来「刹车入弯」。
   *
   * 这是个一次项系数,极速下的减速度 ≈ (dragLinear + airBrakeDrag + dragQuadratic·v)·v。
   * 取 1.9 时相当于 17g,一秒从 277 km/h 掉到 30 km/h —— 那不是刹车是急停。
   * 0.5 大约是纯滑行的 2.4 倍,能刹进弯又不会把速度清零。
   */
  airBrakeDrag: 0.5,
  airBrakeGripBonus: 7,

  /** 低速时的最大偏航角速度。 */
  yawRateMax: 2.05,
  /**
   * 高速时的最大偏航角速度。比低速小得多:
   * 高速还能原地转会让车像陀螺,失去速度感。
   */
  yawRateAtTopSpeed: 0.78,
  /** 转向响应:输入到目标角速度的追随速率,越大越「贼」。 */
  yawResponse: 9.5,
  /** 松开方向键后的回正速率。 */
  yawRecenter: 7,
  /** 空中转向能力打折 —— 保留一点姿态微调,但不能当成飞行器开。 */
  yawAuthorityAirborne: 0.35,

  /** 姿态贴合地面法线的速率。太快会在碎地形上抖,太慢会「穿模」进斜坡。 */
  attitudeAlign: 9,
  /** 离地后回到世界竖直方向的速率。 */
  attitudeAlignAirborne: 2.4,
  /** 侧倾:横向速度带来的车身滚转,单纯为了好看。 */
  bankPerLateralSpeed: 0.022,
  bankMax: 0.42,
  /** 俯仰:加减速带来的车头抬压。 */
  pitchPerAcceleration: 0.011,
  pitchMax: 0.3,
} as const;

export const CAMERA = {
  /** 跟随点在车体坐标系里的偏移(后方、上方)。 */
  offsetBack: 8,
  offsetUp: 3.2,
  /**
   * 位置弹簧追随速率。
   *
   * 指数追随对匀速目标有稳态滞后 ≈ v / lambda:lambda 取 6.5 时,88 m/s
   * 下相机会落后 13 米,车在画面里缩成一个点。取 11 让滞后压到 8 米以内 ——
   * 加速时相机被甩开的感觉还在,但车始终占得住画面。
   */
  positionLambda: 11,
  /**
   * 速度前馈,用来抵消上面那个稳态滞后(前馈量 = v · lag / lambda)。
   *
   * 取 0.8 而不是 1:完全抵消会让相机变成硬连接,匀速和加速看起来一样。
   * 留 20% 滞后,油门一给相机就往后坠一下,这一下就是速度感的来源。
   */
  lagCompensation: 0.8,
  /** 看向车前方一段距离,过弯时视线会先进入弯心。 */
  lookAhead: 4.5,
  lookUp: 1,
  lookLambda: 9,

  /** 静止时的 FOV,以及拉到极速时额外增加的度数。 */
  fovBase: 62,
  fovGain: 17,
  fovLambda: 3.2,

  /** 相机随偏航角速度产生的轻微滚转。太大就晕。 */
  rollPerYawRate: 0.075,
  rollMax: 0.12,
  rollLambda: 6,

  /** 相机不允许低于地面这个高度,免得钻到地里。 */
  minGroundClearance: 0.8,
} as const;

export const TRACK = {
  /** 赛道半宽(米)。总宽 26 米,够两三辆车并排,也够走内外线。 */
  halfWidth: 13,
  /** 中心线重采样间距。越小条带越平滑,但顶点数和校验开销线性增长。 */
  spacing: 6,

  /** 控制点数量范围。太少赛道单调,太多会挤出一堆过不去的急弯。 */
  minControlPoints: 9,
  maxControlPoints: 14,
  /** 控制点到原点的距离范围(米)。 */
  minRadius: 300,
  maxRadius: 620,
  /** 控制点角度相对均分位置的最大抖动(占一格的比例)。 */
  angleJitter: 0.3,
  /** 高度起伏幅度(米)。 */
  heightAmplitude: 26,

  /** 校验门槛。过不了就换一组控制点重来。 */
  minCurvatureRadius: 62,
  maxGrade: 0.17,

  /**
   * 最多试多少组。每失败一次抖动幅度收一点,极限情况会收敛成一个近似正圆 ——
   * 正圆一定合格,所以这个循环保证有解,不会把「生成不出赛道」甩给调用方。
   */
  maxAttempts: 48,

  /** 最大侧倾角(弧度)。0.5 ≈ 29°,再大车会贴着墙跑,像轨道玩具。 */
  maxBank: 0.5,
  /**
   * 推侧倾用的参考速度(m/s)。
   *
   * **这不是物理保证,是造型参数。** 侧倾角按 `atan(v² / (r·g))` 算,
   * 取真实极速(88)会让半径 65~130 米的弯全部超过上限、处处顶格 28.6°,
   * 「侧倾由曲率推导」就名存实亡了。取 32 时:65 米的急弯接近上限,
   * 300 米的缓弯只有 7° 左右,曲率差异才看得出来。
   */
  bankReferenceSpeed: 32,
  /** 侧倾平滑次数。弯道进出口的侧倾必须渐变,突变会把车弹起来。 */
  bankSmoothingPasses: 24,
  /**
   * 侧倾的最大变化率(弧度/米)。
   *
   * 光靠模糊不够:个别采样点的局部曲率会尖出来,模糊只能削低不能削平,
   * 实测最差处仍有 3.6°/6 米 —— 换算到 88 m/s 就是 52°/秒,而载具的姿态
   * 贴合速率(attitudeAlign)只有 9/秒,压上去必然被弹起来。
   *
   * 0.003 rad/m ≈ 1°/6 米 ≈ 极速下 15°/秒,姿态跟得上。
   * 直接限制变化率比无脑加大模糊好:后者会把弯道峰值一起抹平。
   */
  maxBankRatePerMeter: 0.003,

  /** 路肩宽度(米)。路面边缘到地形之间的过渡带,压上去还能开,但会掉速。 */
  shoulderWidth: 7,
  /** 赛道外地形的噪声特征尺度与幅度(米)。 */
  terrainScale: 260,
  terrainAmplitude: 34,

  /** 检查点数量。出界重置回最近的那个。 */
  checkpointCount: 24,
  /** 离中心线超过这个距离就算出界。给了半宽之外的缓冲,压到路肩不会被立刻拽回去。 */
  outOfBoundsMargin: 9,
} as const;

/** 用于把速度归一化成 0..1(FOV、转向衰减都靠它)。 */
export const REFERENCE_TOP_SPEED = 88;
