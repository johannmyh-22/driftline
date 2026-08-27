import { describe, expect, it } from 'vitest';
import { CURATED_TRACKS, getCuratedTrack } from '../../src/game/curatedTracks';

describe('精选赛道列表', () => {
  it('有 3~5 条,seed 互不重复', () => {
    expect(CURATED_TRACKS.length).toBeGreaterThanOrEqual(3);
    expect(CURATED_TRACKS.length).toBeLessThanOrEqual(5);
    const seeds = CURATED_TRACKS.map((t) => t.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('三套环境主题(gfx/palette.ts 的 THEMES)都至少覆盖到一条', () => {
    const themes = new Set(CURATED_TRACKS.map((t) => t.theme));
    expect(themes).toEqual(new Set(['荒漠', '高原岩地', '火山']));
  });

  it('目标时间是正数,量级落在合理的单圈区间', () => {
    for (const track of CURATED_TRACKS) {
      expect(track.targetLapTime).toBeGreaterThan(30);
      expect(track.targetLapTime).toBeLessThan(180);
    }
  });

  it('getCuratedTrack 按 seed 精确查找,查不到返回 null', () => {
    const first = CURATED_TRACKS[0];
    if (first === undefined) {
      throw new Error('CURATED_TRACKS 不该是空的');
    }
    expect(getCuratedTrack(first.seed)).toEqual(first);
    expect(getCuratedTrack(-1)).toBeNull();
  });
});
