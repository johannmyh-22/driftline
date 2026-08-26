/**
 * HUD 与小地图的视觉与交互调优参数。
 *
 * 【待合并说明】:
 * 因 `src/game/tuning.ts` 当前有并发编辑,本文件的数值单独维护,
 * 待后续交接时合并进 `tuning.ts` 的 `HUD` / `MINIMAP` 节。
 */

export const HUD_TUNING = {
  /** 分段 delta 在界面上高亮显示的保持时间(秒)。 */
  deltaHoldTime: 3.5,
  /** 极速展示上限(仅用于刻度或视觉参考, km/h)。 */
  speedMaxScale: 300,
  /** 配色体系 */
  colors: {
    textPrimary: '#e8ecff',
    textSecondary: '#94a3b8',
    textDim: '#64748b',
    deltaAhead: '#4ade80', // 领先(绿色)
    deltaBehind: '#f87171', // 落后(红色)
    deltaEqual: '#94a3b8', // 持平
    recordGold: '#fbbf24', // 最佳成绩高亮金
    backgroundPanel: 'rgba(5, 8, 18, 0.72)',
    borderPanel: 'rgba(255, 255, 255, 0.08)',
  },
} as const;

export const MINIMAP_TUNING = {
  /** 小地图 SVG 视口宽高。 */
  viewBoxSize: 200,
  /** 赛道边界到小地图边缘的留白比例。 */
  paddingRatio: 0.12,
  /** 赛道底衬线宽。 */
  trackBgWidth: 6,
  /** 赛道中心线宽。 */
  trackLineWidth: 3,
  /** 赛道底衬颜色。 */
  trackBgColor: 'rgba(56, 189, 248, 0.18)',
  /** 赛道主线颜色。 */
  trackLineColor: '#38bdf8',
  /** 起跑线标记颜色。 */
  startLineColor: '#fbbf24',
  /** 玩家箭头/圆点颜色。 */
  playerColor: '#ffffff',
  playerDotRadius: 4.5,
  playerHeadingLength: 8,
} as const;
