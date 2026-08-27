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
 * **`targetLapTime` 的数据来源(2026-08 改,现实参照校准)**:
 * Alpine A110(2017 基础版,252hp/1103kg,和这台车的比例/质量最接近的那一档)
 * 在纽博格林北环(Nürburgring Nordschleife,20.832km)的官方圈速 8:03
 * (483s),换算配速 483/20.832 ≈ 23.19 秒/公里,乘赛道实际长度得到目标时间。
 * 来源与信心等级见 `docs/CLAUDE.md`「现实参照」一节。
 *
 * **这不是精确预测,原因写明白,免得被当成钉死的规格**:
 * 1. 这台车的极速已经按 A110 真实数据校准(`tuning.ts` 的
 *    `REFERENCE_TOP_SPEED`),但**加速度没有**——0-100 仍是约 3.6s,比真实
 *    A110 的 4.5s 快不少。原因见 `CAR.driveTorque` 的注释:调低扭矩去匹配
 *    真实加速度,会把已验收的甩尾手感几乎完全压平(实测扭矩从 4000 降到
 *    3200,稳态侧滑角就从 9.70° 掉到 2.66°),两者没法同时满足,这一轮保了
 *    甩尾手感,加速度维持原样。也就是说这台车"直线比真车快,但没有真车那么
 *    容易靠油门甩起来"——用它的圈速换算出的目标时间理论上应该比真实 A110
 *    在同等技术弯道量级的赛道上更容易达到。
 * 2. 赛道是程序化生成的,不是纽北的复刻,曲率分布不会完全一致。
 * 3. **没有人实际开过这些赛道去验证目标是否合理**,需要人类试玩后调整,
 *    旋钮就是这个文件里的 `targetLapTime`。
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
  { seed: 135, name: '荒漠 #135', theme: '荒漠', targetLapTime: 72.04 },
  { seed: 325, name: '荒漠 #325', theme: '荒漠', targetLapTime: 72.57 },
  { seed: 107, name: '高原岩地 #107', theme: '高原岩地', targetLapTime: 72.41 },
  { seed: 110, name: '高原岩地 #110', theme: '高原岩地', targetLapTime: 70.53 },
  { seed: 154, name: '火山 #154', theme: '火山', targetLapTime: 74.49 },
];

export function getCuratedTrack(seed: number): CuratedTrack | null {
  return CURATED_TRACKS.find((track) => track.seed === seed) ?? null;
}
