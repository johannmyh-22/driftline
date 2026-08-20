# driftline

低多边形反重力计时赛(anti-grav time trial)。Web / TypeScript / three.js。
**零二进制资产** —— 所有几何体、贴图、音效都由代码生成。

## 最重要的三条

1. **不要引入二进制资产**。没有 `.glb` / `.fbx` / `.png` 贴图 / `.mp3`。模型用 `BufferGeometry` 手写或 primitive 组合,贴图用 canvas / shader 生成,音效用 Web Audio 合成。仓库里应该只有文本文件。
2. **改完必须自己看画面**。跑 `npm run shoot` 生成截图,然后用 Read 工具读取 `tests/visual/__output__/*.png` 亲眼确认。不要只靠 `npm run build` 通过就宣称完成 —— 编译通过和画面正确是两件事。
3. **一个里程碑一个 PR**。范围见 `docs/PLAN.md`。不要顺手做下一个里程碑的事,也不要"顺便重构"。

## 命令

```bash
npm run dev        # 本地开发服务器
npm run typecheck  # tsc --noEmit,提交前必过
npm run build      # vite build,提交前必过
npm run shoot      # 无头截图 → tests/visual/__output__/
npm run test       # 单元测试(vitest)
npm run test:visual # 截图冒烟测试(非黑屏 / 无 console error / 帧时间)
```

## 无头验证契约

CI runner 没有 GPU,WebGL 走 SwiftShader 软件渲染。为了让截图可复现,游戏必须支持**确定性手动步进**:

- URL 带 `?test=1` 时,**禁用 `requestAnimationFrame` 主循环**,改由外部驱动。
- `?seed=N` 指定世界生成种子;所有随机数走注入的 seeded PRNG,**禁止直接调用 `Math.random()`**。
- 暴露测试接口:

```ts
window.__DRIFTLINE_TEST__ = {
  ready: Promise<void>,              // 资源与场景就绪
  advance(frames: number): void,     // 以固定 dt (1/60) 步进 N 帧
  setCamera(preset: string): void,   // 固定机位,用于回归截图
  snapshot(): Record<string, number> // 车速/位置/圈时等,便于断言
}
```

主循环用 **fixed timestep**(累加器 + 固定 dt),渲染插值。这不是可选项 —— 后期再改会波及所有物理和回放代码。

截图只做**粗粒度回归**(非黑屏、构图大致正确、无报错),不做像素级比对:SwiftShader 与真 GPU 输出有差异。

## 技术选型(已定,不要替换)

| 层 | 选择 |
|---|---|
| 构建 | Vite + TypeScript(strict) |
| 渲染 | three.js,**裸用,不要 React / R3F** |
| 物理 | **不用物理引擎**。自写 raycast 悬浮 + 速度积分控制器 |
| 后处理 | `EffectComposer`:bloom + SMAA + vignette |
| 音频 | Web Audio API 程序化合成 |
| UI/HUD | DOM overlay,不要在 canvas 里排文字 |
| 测试 | vitest(逻辑) + Playwright chromium(截图) |
| 部署 | GitHub Actions → GitHub Pages(`base: '/driftline/'`) |

## 代码约定

- `src/core/` 引擎无关的循环、时间、输入、PRNG;`src/game/` 玩法;`src/gfx/` 程序化几何与材质;`src/audio/` 合成器。
- 玩法数值集中在 `src/game/tuning.ts`,单一来源,便于人类调手感。不要把魔法数字散落在各处。
- `strict: true`,不写 `any`,不用 `// @ts-ignore` 绕过类型错误。
- 注释只写"为什么",不写"做了什么"。
- 每帧执行的代码里**不要分配对象**(复用 `Vector3` / `Quaternion` 临时量),GC 抖动在 60fps 下看得见。

## 不做的事

联机 / 多人、车辆改装与经济系统、剧情与对话、账号系统、后端服务、成就徽章、任何形式的角色骨骼动画。

## 人类验收点

"好玩"和"好看"由人判断,不要自己下结论。到达 M1(手感)和 M3(视觉基线)时,在 PR 描述里明确写 **"需要人类试玩/看图确认"**,并附上 Pages 链接和关键截图,然后停下等反馈,不要继续往下推。
