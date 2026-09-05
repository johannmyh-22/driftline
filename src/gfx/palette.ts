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
  /** 地形、路面与护墙的 PBR 贴图参数。 */
  terrainSurface: SurfaceOptions;
  roadSurface: SurfaceOptions;
  wallSurface: SurfaceOptions;

  /** 路肩、标线、护墙压顶。 */
  shoulder: Color;
  roadEdge: Color;
  wallCap: Color;
  startLine: Color;
  /**
   * 维修区地标。**故意用一个赛道上不会出现的颜色**(偏蓝的冷色)——
   * 它是功能标识不是装饰,玩家要能一眼在路肩上认出来,而路肩、标线、起跑线
   * 已经把中性灰白那一档占满了。
   */
  pitBox: Color;

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

    wallSurface: {
      // 混凝土的反照率 0.2~0.35,比沥青亮一个档;起伏比路面细,粗糙度也更高。
      base: [0.235, 0.231, 0.222],
      variation: 0.3,
      roughness: 0.88,
      roughnessVariation: 0.07,
      bumpiness: 1.3,
      frequency: 12,
    },

    shoulder: linear(terrain[0] * 0.8, terrain[1] * 0.8, terrain[2] * 0.8),
    // 标线是脏白不是纯白:真实的路面标线被碾过、积过灰。
    roadEdge: linear(0.42, 0.41, 0.38),
    // 护墙的压顶。比墙身深一档:顶面积灰、被雨水冲刷,现实里从来不是最亮的那块。
    wallCap: linear(0.62, 0.61, 0.585),
    startLine: linear(0.5, 0.49, 0.46),
    pitBox: linear(0.24, 0.42, 0.62),

    // 金属材质下基色是**反射的色调**而不是亮度,所以要比直觉暗:
    // 上一版取 0.34 亮度,配上高强度太阳和 IBL 直接过曝成一片惨白。
    // 电介质车漆下基色直接决定车身颜色,可以给足饱和度。
    craftHull: new Color().setHSL(theme.craftHue, 0.55, 0.16),
    craftAccent: new Color().setHSL(theme.craftHue, 0.45, 0.26),
    craftGlow: new Color().setHSL(0.55, 0.9, 0.62),
  };
}

/**
 * 从一份基础配色派生「和玩家明显不同」的车身配色,给 M7 的对手车用。
 *
 * 不重新挑主题 —— 地形/路面/护墙必须和玩家共享同一个环境,只有车身颜色
 * 需要区分。直接把色相转半圈:不管原来是三套主题里哪一套选出来的色相,
 * 转完之后都离得够远,一眼分得清谁是谁(人类看过并排出现在同一屏的截图,
 * 反馈"对手车不能和玩家长一样",见 docs/HANDOFF.md 第三十六节)。
 */
export function rivalCraftColors(base: Palette, index = 0, count = 1): Palette {
  const hsl = { h: 0, s: 0, l: 0 };
  base.craftHull.getHSL(hsl);
  /*
   * 多辆对手时把色相在**除玩家之外**的色环上均分,而不是每辆都转半圈——
   * 转半圈只在一对一时管用,两辆以上会撞成同一个颜色。玩家占 0 号位,
   * 对手从半圈处开始按 (index+1)/(count+1) 铺开,谁都不会和玩家撞色。
   */
  const spread = (index + 1) / (count + 1);
  const rivalHue = (hsl.h + spread) % 1;
  return {
    ...base,
    craftHull: new Color().setHSL(rivalHue, 0.55, 0.16),
    craftAccent: new Color().setHSL(rivalHue, 0.45, 0.26),
  };
}

/** 直接指定线性空间的值。写实反照率是查表来的,不该再过一遍 sRGB 转换。 */
function linear(r: number, g: number, b: number): Color {
  return new Color().setRGB(r, g, b);
}
