import { DataTexture, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, SRGBColorSpace, UnsignedByteType } from 'three';
import type { Rng } from '../core/rng';

/**
 * 运行时程序化生成 PBR 贴图。**零素材文件。**
 *
 * 写实感的近景全靠这一层:没有高频表面细节,再好的光照也只是「一块干净的
 * 色卡被照亮」。沥青的砂砾、岩石的凹凸,都要靠法线贴图在几何体不变的前提下
 * 骗出来 —— 这正是程序化生成能做、而手写 BufferGeometry 做不到的部分。
 *
 * 噪声用的是**可平铺**的周期格点,不然 RepeatWrapping 会在每个拼接缝露馅。
 */

export interface SurfaceOptions {
  /** 基色(线性空间 0..1)。 */
  base: readonly [number, number, number];
  /** 基色的随机明暗浮动幅度。 */
  variation: number;
  /** 粗糙度中值与浮动。1 = 完全漫反射。 */
  roughness: number;
  roughnessVariation: number;
  /** 法线起伏强度。越大表面看着越糙。 */
  bumpiness: number;
  /** 细节频率(每张贴图里重复多少个特征)。 */
  frequency: number;
}

export interface SurfaceTextures {
  map: DataTexture;
  normalMap: DataTexture;
  roughnessMap: DataTexture;
  dispose(): void;
}

const SIZE = 256;

export function createSurfaceTextures(rng: Rng, options: SurfaceOptions): SurfaceTextures {
  const lattice = buildLattice(rng);

  // 先算一张高度图,albedo 的明暗和法线都从它派生 —— 这样凹处偏暗、
  // 凸处偏亮,和法线对得上,而不是两张互不相干的噪声。
  const height = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      height[y * SIZE + x] = fbm(lattice, x, y, options.frequency);
    }
  }

  const albedo = new Uint8Array(SIZE * SIZE * 4);
  const normal = new Uint8Array(SIZE * SIZE * 4);
  const rough = new Uint8Array(SIZE * SIZE * 4);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const h = height[i] ?? 0;

      const shade = 1 + (h - 0.5) * 2 * options.variation;
      albedo[i * 4] = toByte(srgb((options.base[0] ?? 0) * shade));
      albedo[i * 4 + 1] = toByte(srgb((options.base[1] ?? 0) * shade));
      albedo[i * 4 + 2] = toByte(srgb((options.base[2] ?? 0) * shade));
      albedo[i * 4 + 3] = 255;

      // 中心差分求梯度,按周期回绕取邻居,保证贴图可平铺。
      const dx = (height[y * SIZE + wrap(x + 1)] ?? 0) - (height[y * SIZE + wrap(x - 1)] ?? 0);
      const dy = (height[wrap(y + 1) * SIZE + x] ?? 0) - (height[wrap(y - 1) * SIZE + x] ?? 0);
      const nx = -dx * options.bumpiness;
      const ny = -dy * options.bumpiness;
      const inv = 1 / Math.hypot(nx, ny, 1);
      normal[i * 4] = toByte((nx * inv) * 0.5 + 0.5);
      normal[i * 4 + 1] = toByte((ny * inv) * 0.5 + 0.5);
      normal[i * 4 + 2] = toByte(inv * 0.5 + 0.5);
      normal[i * 4 + 3] = 255;

      // 凹处积灰更粗糙,凸处被磨得更光 —— 这个相关性比纯随机更像真实表面。
      const r = options.roughness + (0.5 - h) * 2 * options.roughnessVariation;
      const byte = toByte(Math.min(1, Math.max(0, r)));
      rough[i * 4] = byte;
      rough[i * 4 + 1] = byte;
      rough[i * 4 + 2] = byte;
      rough[i * 4 + 3] = 255;
    }
  }

  const map = makeTexture(albedo, true);
  const normalMap = makeTexture(normal, false);
  const roughnessMap = makeTexture(rough, false);

  return {
    map,
    normalMap,
    roughnessMap,
    dispose(): void {
      map.dispose();
      normalMap.dispose();
      roughnessMap.dispose();
    },
  };
}

function makeTexture(data: Uint8Array, srgbSpace: boolean): DataTexture {
  const texture = new DataTexture(data, SIZE, SIZE, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  // 只有 albedo 是颜色,法线和粗糙度是数据,走 sRGB 会把数值弄错。
  if (srgbSpace) {
    texture.colorSpace = SRGBColorSpace;
  }
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

const LATTICE = 64;

/** 周期为 LATTICE 的随机格点。回绕取值,所以生成的噪声天然可平铺。 */
function buildLattice(rng: Rng): Float32Array {
  const values = new Float32Array(LATTICE * LATTICE);
  for (let i = 0; i < values.length; i++) {
    values[i] = rng.next();
  }
  return values;
}

function latticeAt(lattice: Float32Array, x: number, y: number): number {
  const ix = ((x % LATTICE) + LATTICE) % LATTICE;
  const iy = ((y % LATTICE) + LATTICE) % LATTICE;
  return lattice[iy * LATTICE + ix] ?? 0;
}

function valueNoise(lattice: Float32Array, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);

  const a = latticeAt(lattice, x0, y0);
  const b = latticeAt(lattice, x0 + 1, y0);
  const c = latticeAt(lattice, x0, y0 + 1);
  const d = latticeAt(lattice, x0 + 1, y0 + 1);

  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** 多层叠加。频率必须整除 LATTICE,否则平铺处会错位。 */
function fbm(lattice: Float32Array, x: number, y: number, frequency: number): number {
  let total = 0;
  let amplitude = 1;
  let normalizer = 0;
  let f = frequency;

  for (let octave = 0; octave < 4; octave++) {
    total += valueNoise(lattice, (x / SIZE) * f, (y / SIZE) * f) * amplitude;
    normalizer += amplitude;
    amplitude *= 0.5;
    f *= 2;
  }
  return total / (normalizer || 1);
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function wrap(v: number): number {
  return ((v % SIZE) + SIZE) % SIZE;
}

function srgb(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

function toByte(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}
