import { Color } from 'three';
import type { Rng } from '../core/rng';
import type { SurfaceOptions } from './textures';

/**
 * 写实配色。
 *
 * **不再按随机色相生成。** 低多边形时代那套「baseHue + 补色」能保证画面协调,
 * 但出来的紫色山、绿色天一眼就是电脑配的。真实环境的颜色范围很窄:岩石是
 * 土黄到灰褐,沥青是接近中性的深灰,标线是脏白。所以改成挑选**实拍参考过的
 * 环境主题**,seed 只决定选哪一套、以及套内的小幅浮动。
 *
 * 贴图基色用线性空间的三元组,直接喂给程序化贴图生成器。
 */
export interface Palette {
  /** 地形与路面的 PBR 贴图参数。 */
  terrainSurface: SurfaceOptions;
  roadSurface: SurfaceOptions;

  /** 路肩、标线、护栏。 */
  shoulder: Color;
  roadEdge: Color;
  guardrail: Color;
  startLine: Color;

  /** 载具。 */
  craftHull: Color;
  craftAccent: Color;
  craftGlow: Color;

  /** 主题名,截图和调试时用来认场景。 */
  themeName: string;
}

interface Theme {
  name: string;
  /** 地形基色(线性空间)。 */
  terrain: readonly [number, number, number];
  craftHue: number;
}

/**
 * 三套环境主题。取值参照实拍地貌的反照率:干燥岩土大约 0.2~0.35,
 * 玄武岩 0.08 上下 —— 都比「好看的颜色」暗得多,这正是写实的一部分。
 */
const THEMES: readonly Theme[] = [
  { name: '荒漠', terrain: [0.29, 0.22, 0.14], craftHue: 0.55 },
  { name: '高原岩地', terrain: [0.19, 0.19, 0.17], craftHue: 0.08 },
  { name: '火山', terrain: [0.08, 0.07, 0.07], craftHue: 0.11 },
];

export function createPalette(rng: Rng): Palette {
  const theme = rng.pick(THEMES);
  const drift = rng.range(-0.02, 0.02);
  const terrain: [number, number, number] = [
    Math.max(0, (theme.terrain[0] ?? 0) + drift),
    Math.max(0, (theme.terrain[1] ?? 0) + drift),
    Math.max(0, (theme.terrain[2] ?? 0) + drift * 0.5),
  ];

  return {
    themeName: theme.name,
    terrainSurface: {
      base: terrain,
      variation: 0.35,
      roughness: 0.94,
      roughnessVariation: 0.05,
      bumpiness: 2.6,
      frequency: 8,
    },
    roadSurface: {
      // 沥青的反照率只有 0.05~0.12,而且几乎中性 —— 比大多数人以为的暗得多。
      base: [0.055, 0.054, 0.056],
      variation: 0.5,
      roughness: 0.82,
      roughnessVariation: 0.09,
      bumpiness: 1.6,
      frequency: 16,
    },

    shoulder: linear(terrain[0] * 0.8, terrain[1] * 0.8, terrain[2] * 0.8),
    // 标线是脏白不是纯白:真实的路面标线被碾过、积过灰。
    roadEdge: linear(0.42, 0.41, 0.38),
    guardrail: linear(0.32, 0.33, 0.35),
    startLine: linear(0.5, 0.49, 0.46),

    craftHull: new Color().setHSL(theme.craftHue, 0.18, 0.34),
    craftAccent: new Color().setHSL(theme.craftHue, 0.3, 0.5),
    craftGlow: new Color().setHSL(0.55, 0.9, 0.62),
  };
}

/** 直接指定线性空间的值。写实反照率是查表来的,不该再过一遍 sRGB 转换。 */
function linear(r: number, g: number, b: number): Color {
  return new Color().setRGB(r, g, b);
}
