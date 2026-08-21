# driftline

写实向计时赛。Web / TypeScript / three.js。
**素材零二进制** —— 所有几何体、贴图、音效都由代码生成。

> **载具方向已变(2026-08-21 由人类改定):反重力悬浮 → 真实车辆。**
> 物理换成 Rapier 引擎 + 四轮 raycast(取舍分析与代价见 `docs/HANDOFF.md` 第十节)。
> 悬浮相关的物理、数值、造型逐步作废;赛道生成、渲染管线、截图回路全部留用。

## 视觉方向:写实(2026-08 由人类改定)

原定的「低多边形」风格**已作废**。目标改为尽量接近实拍照片的画面。

零二进制资产这条**不变** —— 贴图可以在运行时用 shader / canvas 程序化生成成
`DataTexture`,不需要任何素材文件。写实和零资产不冲突。

这条方向有一条硬天花板,别拿它去要求做不到的事:

- **能做到接近实拍的**:光照(IBL 环境反射、真实阴影、AO)、大气散射天空、
  PBR 材质(程序化生成沥青 / 混凝土 / 岩石的法线与粗糙度)、色调映射与后处理。
  这些是程序化生成最擅长、也是拉近真实感最有效的部分。
- **做不到实拍级的**:复杂的**造型**。手写 `BufferGeometry` 做不出照片级的
  载具外形。地形和赛道可以靠加密网格 + 法线贴图补,载具会是明显的短板。

所以判断标准是:**材质与光照按实拍要求,造型受限于程序化生成**。

物理同理:过弯要有速度代价、撞墙要有损失,不做「怎么开都能拽回来」的街机手感。

## 最重要的三条

1. **不要引入二进制资产**。没有 `.glb` / `.fbx` / `.png` 贴图 / `.mp3`。模型用 `BufferGeometry` 手写或程序化生成,贴图用 canvas / shader 生成到 `DataTexture`,音效用 Web Audio 合成。仓库里应该只有文本文件。

   **唯一的破例:物理引擎运行时(Rapier 的 `.wasm`),2026-08-21 由人类拍板。**
   破例的范围写死在这里,别拿它当口子:

   - 破的是**依赖**这一格 —— 一个从 npm 装进 `node_modules`、由构建产出到
     `dist/` 的编译产物。**仓库里仍然只有文本文件**,这条一个字没松。
   - **不破的是素材那一格。** 几何体、贴图、音效、字体,一律仍然由代码生成,
     一个素材文件都不许进。「反正已经有 wasm 了」不是理由 —— 破例的理由是
     「物理求解器没法用 TypeScript 手写到可用质量」,而贴图和音效恰恰可以,
     这个项目已经证明了。
   - 代价是量过的:首屏传输 **202 KB → 1285 KB**(gzip)。体积留到 M6 处理。
   - 用的是 **`@dimforge/rapier3d-compat`**(wasm 以 base64 内联在 JS 里),
     不是独立 `.wasm` 的 `@dimforge/rapier3d`。**独立 wasm 版只要 997 KB,
     小 288 KB,但它在 vitest(Node)里根本 import 不起来** —— 那个包是给
     打包器用的,没有 `main`/`exports` 入口,加了 alias 之后 wasm-bindgen 的
     堆表又会失配。而「browser 用一个包、测试用另一个包」是不能接受的:
     这个项目的整套测试前提就是**单测能预测运行时行为**,两个不同的构建产物
     会把这个前提悄悄挖空。**用 288 KB 换「测的和跑的是同一个二进制」。**
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

**「同 seed 逐帧复现」在引入引擎之后依然成立 —— 这是量出来的,不是假设。**

引入引擎之前普遍担心的是「求解器是迭代的、对浮点累加顺序敏感,逐位复现会没」。
**对 WASM 编译的引擎这条不成立**:WebAssembly 的浮点语义由规范强制
(IEEE-754,不允许 FMA 合并、不允许重结合、没有扩展精度),所以同一份 wasm
在任何符合规范的运行时上结果必然一致 —— 这恰恰是原生编译的物理引擎做不到的。

实测:同一段接触密集的计算跑 600 步,**Node 和 Chromium 的 10 个状态字段
逐位完全相同**。守卫在 `tests/unit/physics.test.ts`,里面还钉了一组基准值。

两个推论:

- 车辆物理单测继续留在 vitest(8 秒),不用搬进 Playwright(2 分钟)。
- M4 的幽灵回放可以继续存**输入序列**重放,不必退化成存位置轨迹。

**但基准值那条测试哪天红了,不要放宽它。** 它变红只有一个含义:求解器动过了
(多半是升级了 Rapier),所有手感数值和回放基准都要重新核,并且需要人类确认。

截图只做**粗粒度回归**(非黑屏、构图大致正确、无报错),不做像素级比对:SwiftShader 与真 GPU 输出有差异。

## 技术选型(已定,不要替换)

| 层 | 选择 |
|---|---|
| 构建 | Vite + TypeScript(strict) |
| 渲染 | three.js,**裸用,不要 React / R3F** |
| 材质 | PBR(`MeshStandardMaterial` / `MeshPhysicalMaterial`),贴图运行时程序化生成 |
| 物理 | **Rapier**(`@dimforge/rapier3d-compat`)+ **自写四轮 raycast 与轮胎模型** |
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
