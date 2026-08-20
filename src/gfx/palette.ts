import { Color } from 'three';
import type { Rng } from '../core/rng';

/**
 * 一整套由 seed 推出来的配色。M0 只是验证「seed 会改变画面」这条链路,
 * M3 才会认真定视觉,所以这里的取值范围刻意保守:不要跑出难看的荧光色。
 */
export interface Palette {
  zenith: Color;
  horizon: Color;
  nadir: Color;
  ground: Color;
  gridMajor: Color;
  road: Color;
  roadEdge: Color;
  shoulder: Color;
  guardrail: Color;
  startLine: Color;
  craftHull: Color;
  craftAccent: Color;
  craftGlow: Color;
  keyLight: Color;
  fillLight: Color;
}

export function createPalette(rng: Rng): Palette {
  // 主色相全局旋转,再让地面与主体错开一段补色距离,画面才不会糊成一片。
  const baseHue = rng.next();
  const groundHue = wrap(baseHue + rng.range(0.42, 0.58));

  return {
    zenith: hsl(baseHue, 0.6, 0.16),
    horizon: hsl(wrap(baseHue + 0.08), 0.72, 0.58),
    nadir: hsl(wrap(baseHue + 0.12), 0.35, 0.1),
    ground: hsl(groundHue, 0.45, 0.17),
    // 路面刻意压得比地形更暗、更去饱和:赛道要在画面里读作「一条带子」,
    // 靠的是它和周围地形的明度差,不是它自己有多花。
    road: hsl(wrap(groundHue + 0.06), 0.1, 0.2),
    roadEdge: hsl(wrap(baseHue + 0.5), 0.85, 0.72),
    shoulder: hsl(wrap(groundHue + 0.02), 0.3, 0.3),
    guardrail: hsl(wrap(baseHue + 0.5), 0.7, 0.55),
    startLine: hsl(0, 0, 0.88),
    gridMajor: hsl(wrap(groundHue + 0.5), 0.9, 0.72),
    // 载具取地面的补色:不管 seed 转到哪儿,车都不会陷进背景里。
    craftHull: hsl(wrap(groundHue + 0.5), 0.5, 0.56),
    craftAccent: hsl(wrap(groundHue + 0.58), 0.72, 0.66),
    craftGlow: hsl(wrap(groundHue + 0.62), 0.95, 0.72),
    keyLight: hsl(wrap(baseHue + 0.06), 0.25, 0.92),
    fillLight: hsl(baseHue, 0.45, 0.55),
  };
}

function hsl(h: number, s: number, l: number): Color {
  return new Color().setHSL(h, s, l);
}

function wrap(h: number): number {
  return h - Math.floor(h);
}
