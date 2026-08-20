import type { Rng } from '../core/rng';
import { TerrainNoise } from './terrainNoise';
import type { TrackLayout } from './trackLayout';
import { TRACK } from './tuning';

/** 横向分档数。条带每一段被切成这么多列,列数越多侧倾越平滑。 */
const LATERAL_DIVISIONS = 10;
/** 空间索引的格子边长(米)。 */
const INDEX_CELL = 24;

export interface CourseHit {
  height: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  /** 到中心线的有符号横向距离,**正值在赛道右侧**。 */
  lateral: number;
  /** 沿赛道的弧长位置(米),从起跑线算起。 */
  arc: number;
  /** 最近的中心线采样下标。 */
  segment: number;
  /** 是否踩在赛道条带(含路肩)上。 */
  onTrack: boolean;
}

export function createCourseHit(): CourseHit {
  return {
    height: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    lateral: 0,
    arc: 0,
    segment: 0,
    onTrack: false,
  };
}

/**
 * 赛道 + 赛道外地形,合成一个统一的向下查询。
 *
 * **条带部分是物理与渲染的共享真相**,做法和 M1 的高度场一样:预先算好一张
 * 顶点网格(行 = 中心线采样,列 = 横向分档),渲染网格和 `sample()` 都吃这张表,
 * 而且 `sample()` 返回的是所在三角面的**精确平面高度和面法线** —— 车贴合的面
 * 就是屏幕上那个面。带侧倾之后这一点尤其重要:用 4 米格点的高度场表达 26 米宽
 * 的侧倾条带,只有 6 个格子横跨,倾角会被量化成台阶。
 *
 * 赛道外的地形是噪声函数 + 有限差分法线,**没有做到面级精确**。那里是出界区,
 * 踩上去会被重置回检查点,不值得为它多维护一张网格。
 */
export class Course {
  readonly layout: TrackLayout;
  readonly halfWidth: number;
  /** 含路肩的外缘半宽。超出它就算离开条带。 */
  readonly outerHalfWidth: number;

  private readonly terrain: TerrainNoise;
  private readonly rows: number;
  private readonly columns = LATERAL_DIVISIONS + 1;
  private readonly lateralStep: number;

  private readonly vx: Float64Array;
  private readonly vy: Float64Array;
  private readonly vz: Float64Array;

  // 空间索引:CSR 结构,cellStart[c]..cellStart[c+1] 是落在格子 c 里的行号。
  private readonly gridMinX: number;
  private readonly gridMinZ: number;
  private readonly gridCols: number;
  private readonly gridRows: number;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;

  constructor(layout: TrackLayout, rng: Rng) {
    this.layout = layout;
    this.halfWidth = layout.halfWidth;
    this.outerHalfWidth = layout.halfWidth + TRACK.shoulderWidth;
    this.lateralStep = (this.outerHalfWidth * 2) / LATERAL_DIVISIONS;
    this.rows = layout.samples.length;

    this.terrain = new TerrainNoise(rng.fork(), {
      scale: TRACK.terrainScale,
      amplitude: TRACK.terrainAmplitude,
      octaves: 4,
    });

    const total = this.rows * this.columns;
    this.vx = new Float64Array(total);
    this.vy = new Float64Array(total);
    this.vz = new Float64Array(total);
    this.buildRibbon();

    // 索引范围按条带外缘再加一格,免得边界查询落到格子外面。
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < total; i++) {
      minX = Math.min(minX, this.vx[i] ?? 0);
      maxX = Math.max(maxX, this.vx[i] ?? 0);
      minZ = Math.min(minZ, this.vz[i] ?? 0);
      maxZ = Math.max(maxZ, this.vz[i] ?? 0);
    }
    this.gridMinX = minX - INDEX_CELL;
    this.gridMinZ = minZ - INDEX_CELL;
    this.gridCols = Math.ceil((maxX - minX) / INDEX_CELL) + 3;
    this.gridRows = Math.ceil((maxZ - minZ) / INDEX_CELL) + 3;

    const { cellStart, cellItems } = this.buildIndex();
    this.cellStart = cellStart;
    this.cellItems = cellItems;
  }

  /** 赛道外地形的高度。条带内也能问,用来做路肩到地形的过渡。 */
  terrainHeightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  /**
   * 向下查询。先用空间索引找出附近的中心线段,再判断落在条带内还是外。
   *
   * 全程不分配对象 —— 它在每帧路径上,而且贴地阴影一帧要问二十几次。
   */
  sample(x: number, z: number, out: CourseHit): void {
    const cell = this.cellIndexAt(x, z);
    let bestRow = -1;
    let bestDistSq = Infinity;
    let bestT = 0;

    if (cell >= 0) {
      const start = this.cellStart[cell] ?? 0;
      const end = this.cellStart[cell + 1] ?? start;
      for (let k = start; k < end; k++) {
        const row = this.cellItems[k] ?? 0;
        const a = this.layout.samples[row];
        const b = this.layout.samples[(row + 1) % this.rows];
        if (a === undefined || b === undefined) {
          continue;
        }

        const abx = b.x - a.x;
        const abz = b.z - a.z;
        const lenSq = abx * abx + abz * abz;
        const t =
          lenSq > 0 ? clamp01(((x - a.x) * abx + (z - a.z) * abz) / lenSq) : 0;
        const px = a.x + abx * t;
        const pz = a.z + abz * t;
        const distSq = (x - px) * (x - px) + (z - pz) * (z - pz);

        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestRow = row;
          bestT = t;
        }
      }
    }

    if (bestRow < 0) {
      this.fillFromTerrain(x, z, out);
      return;
    }

    const a = this.layout.samples[bestRow];
    if (a === undefined) {
      this.fillFromTerrain(x, z, out);
      return;
    }

    // 有符号横向距离:沿「车头右手边」= tangent × up = (-tz, 0, tx)。
    const rightX = -a.tangentZ;
    const rightZ = a.tangentX;
    const lateral = (x - a.x) * rightX + (z - a.z) * rightZ;

    out.lateral = lateral;
    out.segment = bestRow;
    out.arc = a.arc + bestT * this.layout.spacing;

    if (Math.abs(lateral) > this.outerHalfWidth) {
      this.fillFromTerrain(x, z, out);
      out.lateral = lateral;
      out.segment = bestRow;
      out.arc = a.arc + bestT * this.layout.spacing;
      return;
    }

    out.onTrack = true;
    this.fillFromRibbon(x, z, bestRow, bestT, lateral, out);
  }

  /**
   * 生成条带的三角面。渲染网格吃这份数据,三角划分与 `sample()` 完全一致。
   *
   * `lateral` 是每个三角形所在的横向分档中点(-1..1 归一化),上色时用来
   * 区分路面、路肩和边线。
   */
  buildRibbonTriangles(): { positions: Float32Array; lateral: Float32Array } {
    const quads = this.rows * LATERAL_DIVISIONS;
    const positions = new Float32Array(quads * 6 * 3);
    const lateral = new Float32Array(quads * 2);
    let o = 0;
    let l = 0;

    const push = (row: number, col: number): void => {
      const index = this.vertexIndex(row, col);
      positions[o++] = this.vx[index] ?? 0;
      positions[o++] = this.vy[index] ?? 0;
      positions[o++] = this.vz[index] ?? 0;
    };

    for (let row = 0; row < this.rows; row++) {
      const nextRow = (row + 1) % this.rows;
      for (let col = 0; col < LATERAL_DIVISIONS; col++) {
        // 与 sample() 相同的对角线切分。
        push(row, col);
        push(row, col + 1);
        push(nextRow, col);

        push(nextRow, col + 1);
        push(nextRow, col);
        push(row, col + 1);

        const centre = ((col + 0.5) / LATERAL_DIVISIONS) * 2 - 1;
        lateral[l++] = centre;
        lateral[l++] = centre;
      }
    }

    return { positions, lateral };
  }

  private vertexIndex(row: number, col: number): number {
    return (row % this.rows) * this.columns + col;
  }

  private buildRibbon(): void {
    for (let row = 0; row < this.rows; row++) {
      const sample = this.layout.samples[row];
      if (sample === undefined) {
        continue;
      }

      const rightX = -sample.tangentZ;
      const rightZ = sample.tangentX;
      const tanBank = Math.tan(sample.bank);

      for (let col = 0; col < this.columns; col++) {
        const d = -this.outerHalfWidth + col * this.lateralStep;
        const px = sample.x + rightX * d;
        const pz = sample.z + rightZ * d;

        // 路面:按侧倾抬高/压低。正的 bank 表示右侧更高,所以直接乘有符号距离。
        const roadY = sample.y + d * tanBank;

        let y = roadY;
        const overshoot = Math.abs(d) - this.halfWidth;
        if (overshoot > 0) {
          // 路肩:从路面边缘平滑过渡到地形高度,不留台阶。
          const edgeY = sample.y + Math.sign(d) * this.halfWidth * tanBank;
          const blend = smoothstep(0, TRACK.shoulderWidth, overshoot);
          y = edgeY + (this.terrain.heightAt(px, pz) - edgeY) * blend;
        }

        const index = this.vertexIndex(row, col);
        this.vx[index] = px;
        this.vy[index] = y;
        this.vz[index] = pz;
      }
    }
  }

  private fillFromRibbon(
    x: number,
    z: number,
    row: number,
    t: number,
    lateral: number,
    out: CourseHit,
  ): void {
    const raw = (lateral + this.outerHalfWidth) / this.lateralStep;
    let col = Math.floor(raw);
    col = col < 0 ? 0 : col > LATERAL_DIVISIONS - 1 ? LATERAL_DIVISIONS - 1 : col;
    const s = raw - col;

    const nextRow = (row + 1) % this.rows;
    // 与 buildRibbonTriangles 相同的切分:t + s <= 1 落在含 (row, col) 的那一片。
    const useFirst = t + s <= 1;
    const i0 = useFirst ? this.vertexIndex(row, col) : this.vertexIndex(nextRow, col + 1);
    const i1 = useFirst ? this.vertexIndex(row, col + 1) : this.vertexIndex(nextRow, col);
    const i2 = useFirst ? this.vertexIndex(nextRow, col) : this.vertexIndex(row, col + 1);

    const ax = this.vx[i0] ?? 0;
    const ay = this.vy[i0] ?? 0;
    const az = this.vz[i0] ?? 0;
    const e1x = (this.vx[i1] ?? 0) - ax;
    const e1y = (this.vy[i1] ?? 0) - ay;
    const e1z = (this.vz[i1] ?? 0) - az;
    const e2x = (this.vx[i2] ?? 0) - ax;
    const e2y = (this.vy[i2] ?? 0) - ay;
    const e2z = (this.vz[i2] ?? 0) - az;

    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    // 条带不会翻面,法线一律朝上;绕序在两片三角之间是反的,这里统一。
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const inv = 1 / (Math.hypot(nx, ny, nz) || 1);

    out.normalX = nx * inv;
    out.normalY = ny * inv;
    out.normalZ = nz * inv;
    // 在三角形所在平面上精确求高度,而不是在参数空间插值 ——
    // 参数到世界的映射不是仿射的,插值结果会和渲染出来的面差一点点。
    out.height = ny !== 0 ? ay - (nx * (x - ax) + nz * (z - az)) / ny : ay;
  }

  private fillFromTerrain(x: number, z: number, out: CourseHit): void {
    const h = this.terrain.heightAt(x, z);
    const e = 1.5;
    const dx = (this.terrain.heightAt(x + e, z) - this.terrain.heightAt(x - e, z)) / (2 * e);
    const dz = (this.terrain.heightAt(x, z + e) - this.terrain.heightAt(x, z - e)) / (2 * e);
    const inv = 1 / Math.hypot(-dx, 1, -dz);

    out.height = h;
    out.normalX = -dx * inv;
    out.normalY = inv;
    out.normalZ = -dz * inv;
    out.onTrack = false;
    out.lateral = Number.POSITIVE_INFINITY;
    out.arc = 0;
    out.segment = 0;
  }

  private cellIndexAt(x: number, z: number): number {
    const cx = Math.floor((x - this.gridMinX) / INDEX_CELL);
    const cz = Math.floor((z - this.gridMinZ) / INDEX_CELL);
    if (cx < 0 || cz < 0 || cx >= this.gridCols || cz >= this.gridRows) {
      return -1;
    }
    return cz * this.gridCols + cx;
  }

  private buildIndex(): { cellStart: Int32Array; cellItems: Int32Array } {
    const cellCount = this.gridCols * this.gridRows;
    const counts = new Int32Array(cellCount + 1);

    // 两遍法:先数每格多少项,前缀和定位,再填。省掉每格一个数组的开销。
    const visit = (callback: (cell: number, row: number) => void): void => {
      for (let row = 0; row < this.rows; row++) {
        const nextRow = (row + 1) % this.rows;
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;

        for (let col = 0; col < this.columns; col++) {
          for (const r of [row, nextRow]) {
            const index = this.vertexIndex(r, col);
            const px = this.vx[index] ?? 0;
            const pz = this.vz[index] ?? 0;
            minX = Math.min(minX, px);
            maxX = Math.max(maxX, px);
            minZ = Math.min(minZ, pz);
            maxZ = Math.max(maxZ, pz);
          }
        }

        const x0 = Math.floor((minX - this.gridMinX) / INDEX_CELL);
        const x1 = Math.floor((maxX - this.gridMinX) / INDEX_CELL);
        const z0 = Math.floor((minZ - this.gridMinZ) / INDEX_CELL);
        const z1 = Math.floor((maxZ - this.gridMinZ) / INDEX_CELL);

        for (let cz = z0; cz <= z1; cz++) {
          for (let cx = x0; cx <= x1; cx++) {
            if (cx < 0 || cz < 0 || cx >= this.gridCols || cz >= this.gridRows) {
              continue;
            }
            callback(cz * this.gridCols + cx, row);
          }
        }
      }
    };

    visit((cell) => {
      counts[cell + 1] = (counts[cell + 1] ?? 0) + 1;
    });
    for (let i = 0; i < cellCount; i++) {
      counts[i + 1] = (counts[i + 1] ?? 0) + (counts[i] ?? 0);
    }

    const cellStart = Int32Array.from(counts);
    const cursor = Int32Array.from(counts);
    const cellItems = new Int32Array(counts[cellCount] ?? 0);
    visit((cell, row) => {
      const at = cursor[cell] ?? 0;
      cellItems[at] = row;
      cursor[cell] = at + 1;
    });

    return { cellStart, cellItems };
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
