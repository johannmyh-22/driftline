import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { createPalette } from '../../src/gfx/palette';
import { type SurfaceOptions, createSurfaceTextures } from '../../src/gfx/textures';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 程序化贴图必须能无缝平铺(2026-09,HANDOFF 第六十七节)。
 *
 * 这些贴图全部以 `RepeatWrapping` 铺满地面、路面和护墙,地形每 5 米重复一次
 * (`TRACK.textureScale`)。平铺边上只要有一点断口,就会变成一张铺满世界的
 * 方格网 —— 而且法线贴图从高度图求梯度,断口处会变成一道迎着太阳发亮的线。
 *
 * **原来就有这个问题,而且注释写的平铺条件是反的**(「频率必须整除 LATTICE」)。
 * 四层 fbm 共用一张按 64 回绕的格点表,只有频率恰好是 64 的那一层在贴图边缘
 * 回到格点 0。实测接缝处的亮度跳变是内部相邻像素的 17~22 倍(地形)。
 *
 * 断言的是「接缝处的跳变」和「贴图内部任意相邻像素的典型跳变」之比:接缝不该
 * 比贴图里随便哪条像素边界更显眼。
 * ══════════════════════════════════════════════════════════════════════════
 */

interface Seam {
  /** 贴图内部相邻像素的平均跳变。 */
  inner: number;
  /** 最后一列 → 第一列、最后一行 → 第一行的平均跳变(取两者较大)。 */
  seam: number;
}

/** 按通道取值;`channels` 选哪几个通道参与比较(albedo 用亮度,法线用 xy)。 */
function measureSeam(data: Uint8Array, size: number, channels: readonly number[]): Seam {
  const value = (x: number, y: number): number => {
    const i = (y * size + x) * 4;
    let v = 0;
    for (const c of channels) {
      v += data[i + c] ?? 0;
    }
    return v;
  };
  let inner = 0;
  let innerCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size - 1; x++) {
      inner += Math.abs(value(x + 1, y) - value(x, y));
      innerCount++;
    }
  }
  let seamX = 0;
  let seamY = 0;
  for (let i = 0; i < size; i++) {
    seamX += Math.abs(value(0, i) - value(size - 1, i));
    seamY += Math.abs(value(i, 0) - value(i, size - 1));
  }
  return { inner: inner / innerCount, seam: Math.max(seamX, seamY) / size };
}

function surfaces(): [string, SurfaceOptions][] {
  const palette = createPalette(new Rng(135).fork());
  return [
    ['地形', palette.terrainSurface],
    ['路面', palette.roadSurface],
    ['护墙', palette.wallSurface],
  ];
}

describe('程序化贴图无缝平铺', () => {
  for (const [label, options] of surfaces()) {
    it(`${label}:albedo 的平铺边不比内部任何一条像素边界更显眼`, () => {
      const textures = createSurfaceTextures(new Rng(7), options);
      const image = textures.map.image as { data: Uint8Array; width: number };
      const { inner, seam } = measureSeam(image.data, image.width, [0, 1, 2]);
      // 修前实测 6.5~21.7 倍,修后 0.4~0.7 倍。阈值 2:比修后宽几倍,远低于修前。
      expect(seam / inner).toBeLessThan(2);
    });

    it(`${label}:法线贴图的平铺边也连续 —— 断口会变成一道发亮的线`, () => {
      const textures = createSurfaceTextures(new Rng(7), options);
      const image = textures.normalMap.image as { data: Uint8Array; width: number };
      const { inner, seam } = measureSeam(image.data, image.width, [0, 1]);
      expect(seam / inner).toBeLessThan(2);
    });
  }

  it('非 2 的幂的频率也能平铺 —— 护墙用的就是 12', () => {
    const options: SurfaceOptions = {
      base: [0.2, 0.2, 0.2],
      variation: 0.4,
      roughness: 0.8,
      roughnessVariation: 0.1,
      bumpiness: 2,
      frequency: 12,
    };
    const textures = createSurfaceTextures(new Rng(3), options);
    const image = textures.map.image as { data: Uint8Array; width: number };
    const { inner, seam } = measureSeam(image.data, image.width, [0, 1, 2]);
    expect(seam / inner).toBeLessThan(2);
  });
});
