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
  gridMinor: Color;
  spinner: Color;
  spinnerEdge: Color;
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
    gridMajor: hsl(wrap(groundHue + 0.5), 0.9, 0.72),
    gridMinor: hsl(wrap(groundHue + 0.5), 0.6, 0.45),
    spinner: hsl(wrap(baseHue + 0.5), 0.62, 0.55),
    spinnerEdge: hsl(wrap(baseHue + 0.5), 0.95, 0.78),
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
