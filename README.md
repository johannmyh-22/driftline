# driftline

低多边形反重力计时赛。跑在浏览器里,three.js + TypeScript。

**零二进制资产** —— 赛道、地形、载具、贴图、音效全部由代码程序化生成,仓库里只有文本文件。

🎮 **[在线试玩](https://johannmyh-22.github.io/driftline/)**(M0 部署后可用)

## 状态

M2(赛道生成)开发中:由 seed 生成带侧倾的闭环赛道、护栏与起跑线、赛道外程序化
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

`shoot` 可以带参数:

```bash
npm run shoot -- --seed=7 --frames=240 --steer=0.8 --out=turn.png
npm run shoot -- --camera=side --throttle=0     # 静止侧视,看载具本身
npm run shoot -- --no-build                     # 复用现有 dist,连拍时省掉重复构建
```

机位:`chase`(玩家视角,默认)/ `side` / `front` / `top` / `map`(俯瞰整条赛道)。
`--throttle` / `--steer` / `--brake` 是步进期间一直保持的操作输入。

## 设计约束

CI runner 没有 GPU,所以游戏支持**确定性手动步进**:`?test=1&seed=N` 会关掉实时主循环,
改由测试代码逐帧推进,再用 SwiftShader 软件渲染截图。这让自动化流程能真正"看到"画面,
而不只是确认编译通过。细节见 [CLAUDE.md](CLAUDE.md)。

Playwright 固定在 `~1.56.1`:每个 Playwright 版本绑定一个 Chromium 构建号,
浮到最新会让本地与 CI 拿到不同的渲染器版本,截图基线就没法比。升级请连同
截图一起复核。

## License

MIT
