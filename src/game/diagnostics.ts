/**
 * 「原地打转」诊断探针的数据采集。
 *
 * 只做采集,不改任何物理/轮胎逻辑:vehicle 每帧把这些已经算好的量复写进
 * 一份**模块级预分配**的缓冲,谁也不许在这里 new 对象 —— 它在每帧热路径上。
 *
 * 探测脚本通过 `__DRIFTLINE_TEST__.readVehicleTelemetry()` 在 advance() 之后
 * 读走上一帧的采样(读取侧克隆,不在热路径里)。
 *
 * 为什么要把这份东西从 vehicle 里单独拎出来:物理/轮胎是调试对象,诊断采样
 * 是探针。两者混在一个文件里,探针一删就分不清哪里是逻辑哪里是脚手架。
 *
 * 坐标约定与 vehicle.ts 一致:车头 +Z,yaw 增大 = 左转(world +Y 俯视逆时针),
 * 侧向力 / 侧滑的正方向是驾驶员**左侧**(局部 +X),侧向速度正向右。
 */

/** 一个轮子某一帧的采样。下标 0..3 与 vehicle.ts 的 wheels 数组一一对应。 */
export interface WheelTelemetry {
  grounded: boolean;
  /** 悬挂当前长度(安装点到接地点,米)。伸展时 = suspensionRest。 */
  length: number;
  /** 悬挂压缩量(米),0 = 全伸长。 */
  compression: number;
  /** 垂直载荷 / 悬浮法向合力(牛)。接地且有正向压力时 > 0。 */
  load: number;
  /** 滑移率 κ(0 = 纯滚动,正 = 打滑)。 */
  slipRatio: number;
  /** 侧偏角 α(弧度,正 = 车轮指向偏向驾驶员左侧,即抵抗向右滑)。 */
  slipAngle: number;
  /** 轮胎纵向力(牛,正 = 推车向前)。 */
  fx: number;
  /** 轮胎侧向力(牛,正 = 指向驾驶员左侧)。 */
  fy: number;
  /** 施力点(接地点)的世界坐标。 */
  px: number;
  py: number;
  pz: number;
  /** 轮胎纵向方向(轮子指向,已投影到接触面)的世界分量。 */
  wfX: number;
  wfY: number;
  wfZ: number;
  /** 轮胎侧向方向(n × forward,指向驾驶员左侧)的世界分量。 */
  wlX: number;
  wlY: number;
  wlZ: number;
}

/** 单独的整车悬停法向力/轮胎力的世界分量,用于还原 yaw 力矩来源。 */
export interface FrameWheelForce {
  /** 施加到车身的世界系合力(悬挂法向 + 轮胎力),牛。 */
  fx: number;
  fy: number;
  fz: number;
  /** 该轮的接触点世界坐标(作用点)。 */
  px: number;
  py: number;
  pz: number;
}

/** 整车某一帧的采样。 */
export interface FrameTelemetry {
  /** 车身质心世界坐标与线速度。 */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** 车身姿态四元数(用于把速度转进车身系)。 */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  yaw: number;
  yawRate: number;
  /** 顺序与 vehicle.wheels 一致:前右、前左、后右、后左。 */
  wheels: readonly WheelTelemetry[];
  /** 施力点上的世界系合力(含悬挂法向与轮胎两个来源)。 */
  applied: readonly FrameWheelForce[];
}

const WHEEL_COUNT = 4;

// 预分配:每帧就地复写,不 new 对象。
const wheelBuf: WheelTelemetry[] = Array.from({ length: WHEEL_COUNT }, () => ({
  grounded: false,
  length: 0,
  compression: 0,
  load: 0,
  slipRatio: 0,
  slipAngle: 0,
  fx: 0,
  fy: 0,
  px: 0,
  py: 0,
  pz: 0,
  wfX: 0,
  wfY: 0,
  wfZ: 0,
  wlX: 0,
  wlY: 0,
  wlZ: 0,
}));
const appliedBuf: FrameWheelForce[] = Array.from({ length: WHEEL_COUNT }, () => ({
  fx: 0,
  fy: 0,
  fz: 0,
  px: 0,
  py: 0,
  pz: 0,
}));

const telemetry: FrameTelemetry = {
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
  yaw: 0,
  yawRate: 0,
  wheels: wheelBuf,
  applied: appliedBuf,
};

/** 探针停用时,vehicle 每帧照常跑但不写采样,零开销。 */
let enabled = false;

/** 打开/关闭采样。只应在加载阶段调用,不在每帧路径上。 */
export function setTelemetryEnabled(flag: boolean): void {
  enabled = flag;
}

export function telemetryEnabled(): boolean {
  return enabled;
}

/* ════════════════════════════════════════════════════════════════════
 * 写入 API 用「预分配槽 + 提交」,而不是对象字面量。
 *
 * vehicle 的热路径每帧要写 4 个轮子,`recordWheel(i, {...})` 那样的签名会
 * 在调用前先 new 一个对象字面量 —— 即使用不到也在分配,违反宪法的
 * 「每帧不分配对象」。所以暴露可写的槽,vehicle 就地填字段,再调用零开销
 * 的提交函数把槽拷进缓冲(关闭时提交直接 no-op)。
 * ════════════════════════════════════════════════════════════════════ */

/** 单个轮子的写入槽(预分配,热路径就地填)。 */
export const wheelSlot = {
  grounded: false,
  length: 0,
  compression: 0,
  load: 0,
  slipRatio: 0,
  slipAngle: 0,
  fx: 0,
  fy: 0,
  px: 0,
  py: 0,
  pz: 0,
  wfX: 0,
  wfY: 0,
  wfZ: 0,
  wlX: 0,
  wlY: 0,
  wlZ: 0,
};

/** 施加到车身的世界系合力 + 作用点(预分配槽)。 */
export const appliedSlot = {
  fx: 0,
  fy: 0,
  fz: 0,
  px: 0,
  py: 0,
  pz: 0,
};

/** 整车帧元数据槽。字段含义见 FrameTelemetry。 */
export const frameSlot = {
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
  yaw: 0,
  yawRate: 0,
};

/** 整车帧采样(在 update 开头调用,清空上一帧的缓冲)。 */
export function beginTelemetryFrame(): void {
  if (!enabled) {
    return;
  }
  for (let i = 0; i < WHEEL_COUNT; i++) {
    const w = wheelBuf[i];
    if (w === undefined) {
      continue;
    }
    w.grounded = false;
    w.length = 0;
    w.compression = 0;
    w.load = 0;
    w.slipRatio = 0;
    w.slipAngle = 0;
    w.fx = 0;
    w.fy = 0;
    w.px = 0;
    w.py = 0;
    w.pz = 0;
    w.wfX = 0;
    w.wfY = 0;
    w.wfZ = 0;
    w.wlX = 0;
    w.wlY = 0;
    w.wlZ = 0;
    const a = appliedBuf[i];
    if (a === undefined) {
      continue;
    }
    a.fx = 0;
    a.fy = 0;
    a.fz = 0;
    a.px = 0;
    a.py = 0;
    a.pz = 0;
  }
}

/** 把 wheelSlot 拷进该轮的一帧缓冲(关闭时 no-op)。 */
export function commitWheel(index: number): void {
  if (!enabled) {
    return;
  }
  const w = wheelBuf[index];
  if (w === undefined) {
    return;
  }
  w.grounded = wheelSlot.grounded;
  w.length = wheelSlot.length;
  w.compression = wheelSlot.compression;
  w.load = wheelSlot.load;
  w.slipRatio = wheelSlot.slipRatio;
  w.slipAngle = wheelSlot.slipAngle;
  w.fx = wheelSlot.fx;
  w.fy = wheelSlot.fy;
  w.px = wheelSlot.px;
  w.py = wheelSlot.py;
  w.pz = wheelSlot.pz;
  w.wfX = wheelSlot.wfX;
  w.wfY = wheelSlot.wfY;
  w.wfZ = wheelSlot.wfZ;
  w.wlX = wheelSlot.wlX;
  w.wlY = wheelSlot.wlY;
  w.wlZ = wheelSlot.wlZ;
}

/**
 * 把 appliedSlot 拷进该轮的一帧缓冲(关闭时 no-op)。单轮只有一个作用点,
 * 悬挂法向力与轮胎力都施加在同一接地点,所以合力分量用一条槽就够了。
 */
export function commitApplied(index: number): void {
  if (!enabled) {
    return;
  }
  const a = appliedBuf[index];
  if (a === undefined) {
    return;
  }
  a.fx = appliedSlot.fx;
  a.fy = appliedSlot.fy;
  a.fz = appliedSlot.fz;
  a.px = appliedSlot.px;
  a.py = appliedSlot.py;
  a.pz = appliedSlot.pz;
}

/** 整车帧元数据(update 末尾调用,从 frameSlot 拷贝)。 */
export function commitFrame(): void {
  if (!enabled) {
    return;
  }
  telemetry.x = frameSlot.x;
  telemetry.y = frameSlot.y;
  telemetry.z = frameSlot.z;
  telemetry.vx = frameSlot.vx;
  telemetry.vy = frameSlot.vy;
  telemetry.vz = frameSlot.vz;
  telemetry.qx = frameSlot.qx;
  telemetry.qy = frameSlot.qy;
  telemetry.qz = frameSlot.qz;
  telemetry.qw = frameSlot.qw;
  telemetry.yaw = frameSlot.yaw;
  telemetry.yawRate = frameSlot.yawRate;
}

/** 深拷贝一份当前帧采样,供探针在 advance() 之后读取。 */
export function readTelemetry(): FrameTelemetry {
  if (!enabled) {
    throw new Error('telemetry 未启用,先 setTelemetryEnabled(true)');
  }
  return {
    x: telemetry.x,
    y: telemetry.y,
    z: telemetry.z,
    vx: telemetry.vx,
    vy: telemetry.vy,
    vz: telemetry.vz,
    qx: telemetry.qx,
    qy: telemetry.qy,
    qz: telemetry.qz,
    qw: telemetry.qw,
    yaw: telemetry.yaw,
    yawRate: telemetry.yawRate,
    wheels: wheelBuf.map((w) => ({ ...w })),
    applied: appliedBuf.map((a) => ({ ...a })),
  };
}
