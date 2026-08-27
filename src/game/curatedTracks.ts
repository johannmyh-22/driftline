/**
 * 精选赛道(M5)。
 *
 * `generateTrack()` 保证任何 seed 都能生成出「合格」的赛道,但合格不等于
 * 有代表性——退化成近似正圆的赛道也合格。这份列表是从一批候选里手动挑出来
 * 的几条,方法和实测数据见 `scripts/curate-tracks.ts` 的类注释与
 * `docs/HANDOFF.md` 对应小节:`layout.attempts === 1`(控制点随机幅度没被
 * 收紧过)、总长落在验收过的量级、三套环境主题(`gfx/palette.ts`)都至少
 * 覆盖到一条。
 *
 * `targetLapTime` 不是人类圈速的精确预测,是 `Autopilot`(M2 的验收循迹器,
 * 保守、不甩尾、不贴线)跑出的基线圈速乘一个系数——给目标时间一个数据支撑
 * 的量级,而不是拍脑袋。**没有人实际开过这些赛道去验证目标是否合理**,
 * 需要人类试玩后调整,旋钮就是这个文件里的 `targetLapTime`。
 */

export interface CuratedTrack {
  seed: number;
  /** 展示名,主题 + seed,不编故事/背景,和 CLAUDE.md「不做剧情」的方向一致。 */
  name: string;
  theme: string;
  /** 目标单圈时间(秒)。 */
  targetLapTime: number;
}

export const CURATED_TRACKS: readonly CuratedTrack[] = [
  { seed: 135, name: '荒漠 #135', theme: '荒漠', targetLapTime: 67.06 },
  { seed: 325, name: '荒漠 #325', theme: '荒漠', targetLapTime: 72.46 },
  { seed: 107, name: '高原岩地 #107', theme: '高原岩地', targetLapTime: 74.14 },
  { seed: 110, name: '高原岩地 #110', theme: '高原岩地', targetLapTime: 67.68 },
  { seed: 154, name: '火山 #154', theme: '火山', targetLapTime: 74.29 },
];

export function getCuratedTrack(seed: number): CuratedTrack | null {
  return CURATED_TRACKS.find((track) => track.seed === seed) ?? null;
}
