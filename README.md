# driftline

低多边形反重力计时赛。跑在浏览器里,three.js + TypeScript。

**零二进制资产** —— 赛道、地形、载具、贴图、音效全部由代码程序化生成,仓库里只有文本文件。

🎮 **[在线试玩](https://johannmyh-22.github.io/driftline/)**(M0 部署后可用)

## 状态

M0(骨架与验证回路)已就位:Vite + TypeScript strict + three.js、固定步长主循环、
seeded PRNG、`?test=1` 确定性步进接口、Playwright 无头截图与冒烟测试。
场景里那个旋转多面体只是管线验证用的占位物,M1 会整个换掉。

路线图见 [docs/PLAN.md](docs/PLAN.md)。

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
npm run shoot -- --seed=7 --camera=low --frames=240 --out=low.png
npm run shoot -- --no-build          # 复用现有 dist,连拍时省掉重复构建
```

机位可选 `default` / `low` / `top` / `wide`。

## 设计约束

CI runner 没有 GPU,所以游戏支持**确定性手动步进**:`?test=1&seed=N` 会关掉实时主循环,
改由测试代码逐帧推进,再用 SwiftShader 软件渲染截图。这让自动化流程能真正"看到"画面,
而不只是确认编译通过。细节见 [CLAUDE.md](CLAUDE.md)。

Playwright 固定在 `~1.56.1`:每个 Playwright 版本绑定一个 Chromium 构建号,
浮到最新会让本地与 CI 拿到不同的渲染器版本,截图基线就没法比。升级请连同
截图一起复核。

## License

MIT
