import type { Rng } from '../core/rng';

/** 一次向下地面查询的结果。复用同一个对象,别在每帧路径上新建。 */
export interface GroundHit {
  height: number;
  normalX: number;
  normalY: number;
  normalZ: number;
}

export function createGroundHit(): GroundHit {
  return { height: 0, normalX: 0, normalY: 1, normalZ: 0 };
}

interface Ramp {
  x: number;
  z: number;
  angle: number;
  length: number;
  width: number;
  rise: number;
}

interface Dome {
  x: number;
  z: number;
  radius: number;
  height: number;
}

const SIZE = 512;
const CELLS = 128;
/** 出生点周围留一片绝对平坦的地,加速手感才有干净的参照。 */
const SPAWN_CLEARANCE = 46;
/** 外圈围墙的宽度与高度 —— 免得一脚油门开进虚空。 */
const RIM_WIDTH = 48;
const RIM_HEIGHT = 14;

/**
 * 地形高度场。**物理与渲染的共同真相。**
 *
 * 悬浮控制器向下查询的是这里的三角面,地面网格也是从同一份网格、同一套
 * 三角划分生成的 —— 所以车贴合的那个面,就是你在屏幕上看到的那个面。
 * 如果两边各算各的,车会莫名浮空或者陷进坡里,而且极难查。
 *
 * 用解析高度场而不是对 mesh 做 `Raycaster`:后者每次相交都要分配对象,
 * 60Hz 下的 GC 抖动看得见,而且结果依赖 BVH 实现细节、不好复现。
 */
export class Heightfield {
  readonly size = SIZE;
  readonly cells = CELLS;
  readonly step = SIZE / CELLS;

  private readonly heights: Float32Array;
  private readonly half = SIZE / 2;

  constructor(rng: Rng) {
    const ramps = buildRamps(rng);
    const domes = buildDomes(rng);

    const verts = CELLS + 1;
    this.heights = new Float32Array(verts * verts);
    for (let iz = 0; iz < verts; iz++) {
      const z = -this.half + iz * this.step;
      for (let ix = 0; ix < verts; ix++) {
        const x = -this.half + ix * this.step;
        this.heights[iz * verts + ix] = evaluate(x, z, ramps, domes);
      }
    }
  }

  /** 顶点高度。越界按最近边缘处理,车开出网格也不会掉进 NaN。 */
  vertexHeight(ix: number, iz: number): number {
    const verts = CELLS + 1;
    const cx = ix < 0 ? 0 : ix > CELLS ? CELLS : ix;
    const cz = iz < 0 ? 0 : iz > CELLS ? CELLS : iz;
    return this.heights[cz * verts + cx] ?? 0;
  }

  /**
   * 向下查询:给出该点的地面高度与所在三角面的法线。
   *
   * 法线取整个三角面的法线(而不是顶点插值),这样姿态贴合的结果和
   * flat shading 画出来的明暗面完全对得上。
   */
  sample(x: number, z: number, out: GroundHit): void {
    const gx = (x + this.half) / this.step;
    const gz = (z + this.half) / this.step;

    let ix = Math.floor(gx);
    let iz = Math.floor(gz);
    ix = ix < 0 ? 0 : ix > CELLS - 1 ? CELLS - 1 : ix;
    iz = iz < 0 ? 0 : iz > CELLS - 1 ? CELLS - 1 : iz;

    const u = gx - ix;
    const v = gz - iz;

    const ha = this.vertexHeight(ix, iz);
    const hb = this.vertexHeight(ix + 1, iz);
    const hc = this.vertexHeight(ix, iz + 1);
    const hd = this.vertexHeight(ix + 1, iz + 1);

    let nx: number;
    let nz: number;
    if (u + v <= 1) {
      out.height = ha + (hb - ha) * u + (hc - ha) * v;
      nx = (ha - hb) / this.step;
      nz = (ha - hc) / this.step;
    } else {
      out.height = hd + (hc - hd) * (1 - u) + (hb - hd) * (1 - v);
      nx = (hc - hd) / this.step;
      nz = (hb - hd) / this.step;
    }

    const inv = 1 / Math.hypot(nx, 1, nz);
    out.normalX = nx * inv;
    out.normalY = inv;
    out.normalZ = nz * inv;
  }

  /**
   * 生成非索引的三角面。地面网格直接吃这份数据,三角划分与 `sample()`
   * 严格一致 —— 这是「车贴合的面 == 你看到的面」的保证。
   *
   * `cells` 是每个三角所属的格子坐标(每三角两个 int),上色时用来画网格线。
   */
  buildTriangles(): { positions: Float32Array; cells: Int32Array } {
    const triangles = CELLS * CELLS * 2;
    const positions = new Float32Array(triangles * 9);
    const cells = new Int32Array(triangles * 2);
    let o = 0;
    let c = 0;

    const push = (ix: number, iz: number): void => {
      positions[o++] = -this.half + ix * this.step;
      positions[o++] = this.vertexHeight(ix, iz);
      positions[o++] = -this.half + iz * this.step;
    };

    for (let iz = 0; iz < CELLS; iz++) {
      for (let ix = 0; ix < CELLS; ix++) {
        // 与 sample() 相同的对角线切分(b–c),且绕序保证法线朝上。
        push(ix, iz);
        push(ix, iz + 1);
        push(ix + 1, iz);

        push(ix + 1, iz + 1);
        push(ix + 1, iz);
        push(ix, iz + 1);

        cells[c++] = ix;
        cells[c++] = iz;
        cells[c++] = ix;
        cells[c++] = iz;
      }
    }

    return { positions, cells };
  }
}

function evaluate(x: number, z: number, ramps: readonly Ramp[], domes: readonly Dome[]): number {
  let height = 0;

  for (const ramp of ramps) {
    height = Math.max(height, rampHeight(x, z, ramp));
  }
  for (const dome of domes) {
    height = Math.max(height, domeHeight(x, z, dome));
  }

  // 出生点附近强制压平,起步加速时不该被地形干扰。
  const fromSpawn = Math.hypot(x, z);
  if (fromSpawn < SPAWN_CLEARANCE) {
    height *= smoothstep(SPAWN_CLEARANCE * 0.6, SPAWN_CLEARANCE, fromSpawn);
  }

  return Math.max(height, rimHeight(x, z));
}

function rampHeight(x: number, z: number, ramp: Ramp): number {
  const dx = x - ramp.x;
  const dz = z - ramp.z;
  const cos = Math.cos(-ramp.angle);
  const sin = Math.sin(-ramp.angle);
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;

  const halfLength = ramp.length / 2;
  const halfWidth = ramp.width / 2;
  if (lx < -halfLength || lx > halfLength || Math.abs(lz) > halfWidth) {
    return 0;
  }

  // 沿局部 +x 抬升,末端保持满高度形成起跳唇口;两侧收边免得出现竖直墙。
  const along = (lx + halfLength) / ramp.length;
  const taper = 1 - smoothstep(halfWidth * 0.72, halfWidth, Math.abs(lz));
  return ramp.rise * along * along * taper;
}

function domeHeight(x: number, z: number, dome: Dome): number {
  const d = Math.hypot(x - dome.x, z - dome.z);
  if (d >= dome.radius) {
    return 0;
  }
  const t = 1 - (d / dome.radius) ** 2;
  return dome.height * t * t;
}

function rimHeight(x: number, z: number): number {
  const edge = SIZE / 2;
  const inset = Math.min(edge - Math.abs(x), edge - Math.abs(z));
  if (inset >= RIM_WIDTH) {
    return 0;
  }
  const t = 1 - Math.max(0, inset) / RIM_WIDTH;
  return RIM_HEIGHT * t * t;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function buildRamps(rng: Rng): Ramp[] {
  const ramps: Ramp[] = [];
  for (let i = 0; i < 4; i++) {
    const angle = rng.range(0, Math.PI * 2);
    const distance = rng.range(70, 165);
    ramps.push({
      x: Math.cos(angle) * distance,
      z: Math.sin(angle) * distance,
      angle: rng.range(0, Math.PI * 2),
      length: rng.range(26, 38),
      width: rng.range(20, 30),
      rise: rng.range(4, 7),
    });
  }
  return ramps;
}

function buildDomes(rng: Rng): Dome[] {
  const domes: Dome[] = [];
  for (let i = 0; i < 14; i++) {
    const angle = rng.range(0, Math.PI * 2);
    const distance = rng.range(55, 200);
    domes.push({
      x: Math.cos(angle) * distance,
      z: Math.sin(angle) * distance,
      radius: rng.range(14, 34),
      height: rng.range(1.4, 4.2),
    });
  }
  return domes;
}
