# driftline 路线图

每个里程碑 = 一个 PR。合进 `main` 自动部署到 Pages,人类在真机验收后才开下一个。

---

## M0 — 骨架与验证回路

**目标:让"云端 agent 能看见自己的画面"这件事先成立。**

- Vite + TypeScript(strict) + three.js 工程
- `src/core/loop.ts`:fixed timestep 累加器,渲染插值
- `src/core/rng.ts`:seeded PRNG(mulberry32 或 xorshift128),全局禁用 `Math.random()`
- `?test=1&seed=N` 测试模式 + `window.__DRIFTLINE_TEST__` 接口(契约见 CLAUDE.md)
- 场景内容:一个受光的旋转多面体 + 渐变天空 + 地面网格。**仅用于验证管线,不是游戏内容**
- `scripts/shoot.ts`:Playwright 无头截图,SwiftShader 参数,输出到 `tests/visual/__output__/`
- `tests/visual/smoke.spec.ts`:非黑屏(像素方差 > 阈值)、无 console error、`advance(60)` 后状态推进
- CI workflow + Pages 部署 workflow

**验收:** Pages 线上能打开看到画面;CI 全绿;`npm run shoot` 产出的截图我能读出内容。

---

## M1 — 手感

**目标:一辆开起来就爽的悬浮载具。只做手感,不做内容。**

- 输入层(键盘 + 后续可扩展手柄/触屏),支持录制输入帧序列
- 悬浮控制器:向下 raycast 求离地距离 → 弹簧阻尼维持悬浮高度;贴合地面法线做姿态对齐
- 推力 / 阻力 / 侧向摩擦 / 空气刹 / 转向响应曲线,全部参数进 `src/game/tuning.ts`
- 跟随相机:位置弹簧 + 速度相关 FOV 拉伸 + 轻微 roll
- 一块足够大的平地 + 几个障碍物

**验收(需人类试玩):** 加速、转向、擦地、脱离地面再落回的手感。反馈请给具体数值方向。

---

## M2 — 赛道生成

- Catmull-Rom 闭合 spline → 沿弧长重采样 → 生成带侧倾(banking)的赛道条带网格
- 侧倾由曲率推导;护栏 / 路肩 / 起跑线
- **生成后校验**:自交检测、最小曲率半径、最大坡度,不合格则换 seed 重采样
- 检查点系统 + 圈计时 + 出界重置到最近检查点
- 赛道外的 simplex noise 地形,按高度/坡度上顶点色

**验收:** 连续 10 个随机 seed 都能生成出可跑完的赛道。

---

## M3 — 视觉基线

**目标:决定"不像素、看着不廉价"。**

- 材质:flat-shaded low-poly + 少量 emissive 描边条纹;程序化 env map 提供反射
- 光照:定向光 + 半球光 + 程序化渐变天空盒(shader)
- 后处理:bloom → SMAA → vignette → 轻度色差
- 速度感:速度线粒子、尾焰、地面掠影、屏幕边缘扭曲
- 三套主题配色(由 seed 决定)

**验收(需人类看图):** 附 3 张不同赛道的截图 + Pages 链接。

---

## M4 — 游戏循环

- 圈速 / 最佳成绩(localStorage)/ 分段计时与 delta 显示
- 幽灵回放:记录输入帧序列,用同 seed 确定性重播(这也是 M1 输入录制的用途)
- HUD(DOM):速度、圈时、delta、小地图
- 开始菜单 / 暂停 / 重开 / seed 输入框

---

## M5 — 内容与音频

- 3–5 条精选 seed 赛道,各配主题与目标时间
- 程序化音频:引擎音(锯齿波 + 随车速调制的低通滤波)、气流噪声、撞击包络、UI 音
- 加速带、跳台、隧道段
- 主音量与静音,尊重 `prefers-reduced-motion`

---

## M6 — 移动端与性能

- 触屏控制(虚拟摇杆或倾斜)
- DPR 自适应、动态分辨率缩放、低配自动关后处理
- 首屏加载 < 3s,中端手机稳定 60fps
- Lighthouse 检查
