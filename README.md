# driftline

写实风格的反重力计时赛。跑在浏览器里,three.js + TypeScript。

**零二进制资产** —— 赛道、地形、载具、贴图、音效全部由代码程序化生成,仓库里只有文本文件。

🎮 **[在线试玩](https://johannmyh-22.github.io/driftline/)**(M0 部署后可用)

## 状态

M3(视觉写实化)进行中:大气散射天空 + IBL + ACES、程序化 PBR 贴图与写实配色、
太阳阴影与车漆材质、混凝土护墙、后处理链(bloom / SMAA / 暗角)。
**还没有速度感表现(速度线、尾焰)、也没有多套时段与天气主题。**

视觉方向在 2026-08 由人类从「低多边形」改定为「写实」,天花板见 [CLAUDE.md](CLAUDE.md)
的「视觉方向」一节:材质与光照按实拍要求,**造型受限于程序化生成**。

M2(赛道生成)已合并:由 seed 生成带侧倾的闭环赛道、护墙与起跑线、赛道外程序化
地形、检查点与圈计时、出界重置。**还没有分段 delta / 小地图 / 菜单 / 幽灵回放**
—— 那些属于 M4。
M1(手感)已合并:悬浮载具、输入层与输入录制、跟随相机。
M0(骨架与验证回路)已合并:固定步长主循环、seeded PRNG、`?test=1` 确定性步进接口、
Playwright 无头截图与冒烟测试。

路线图见 [docs/PLAN.md](docs/PLAN.md)。

## 操作

| 键 | 作用 |
|---|---|
| `W` / `↑` | 油门 |
| `S` / `↓` | 倒车 |
| `A` `D` / `←` `→` | 转向 |
| `Space` / `Shift` | 空气刹(减速 + 增加抓地,用来刹车入弯) |

`?course=flat` 可以切回 M1 那块带跳台的平地 —— 没有赛道干扰,调手感更干净。
`?post=none` 关掉整条后处理链,`?post=bloom,vignette` 只留其中几级 —— 画面出问题时
一级一级排掉,比盯着成片猜快得多。

手感与赛道数值全部集中在 [`src/game/tuning.ts`](src/game/tuning.ts),调参只改那一个文件。
`tests/unit/vehicle.test.ts` 里的断言区间就是当前调校的实测值,改了 tuning 要回去同步。

## 开发

```bash
npm install
npm run dev
```

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器 |
| `npm run typecheck` | 类型检查 |
| `npm run build` | 生产构建 |
| `npm run test` | 单元测试 |
| `npm run test:visual` | 无头截图冒烟测试 |
| `npm run shoot` | 生成截图到 `tests/visual/__output__/` |
| `npm run perf` | 量每帧渲染成本(见下) |

`shoot` 可以带参数:

```bash
npm run shoot -- --seed=7 --frames=240 --steer=0.8 --out=turn.png
npm run shoot -- --camera=side --throttle=0     # 静止侧视,看载具本身
npm run shoot -- --no-build                     # 复用现有 dist,连拍时省掉重复构建
```

机位:`chase`(玩家视角,默认)/ `side` / `front` / `top` / `map`(俯瞰整条赛道)。
`--throttle` / `--steer` / `--brake` 是步进期间一直保持的操作输入。
`--extra=post=none` 把查询串透传给页面,用来对比单级后处理的效果。

### 量每帧成本

`shoot` 和冒烟测试的墙钟时间**量不出**每帧渲染成本 —— `advance(n)` 走 n 个物理步之后
只渲染一帧,那两个数字里绝大部分是构建、启动和场景生成。`npm run perf` 改成逐帧
`advance(1)`,再用一次截图强制结算 GL 队列:

```bash
npm run perf                                    # 默认配置
npm run perf -- --no-build --extra=post=none    # 和关掉后处理对比
```

SwiftShader 是软件渲染,绝对值和真机没有可比性,有意义的是**同机器上改动前后的比值**。

## 设计约束

CI runner 没有 GPU,所以游戏支持**确定性手动步进**:`?test=1&seed=N` 会关掉实时主循环,
改由测试代码逐帧推进,再用 SwiftShader 软件渲染截图。这让自动化流程能真正"看到"画面,
而不只是确认编译通过。细节见 [CLAUDE.md](CLAUDE.md)。

Playwright 固定在 `~1.56.1`:每个 Playwright 版本绑定一个 Chromium 构建号,
浮到最新会让本地与 CI 拿到不同的渲染器版本,截图基线就没法比。升级请连同
截图一起复核。

## License

MIT
