# 第三方素材与依赖的授权

这个项目的原则是「素材零二进制,一切由代码生成」(见 `CLAUDE.md`)。下面是
**仅有的两处破例**,以及它们的授权与义务。

---

## 1. 车辆模型 `src/assets/car.glb`

**必须署名(CC-BY-4.0 的强制要求)。**

- **来源**:Khronos Group [glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)
  的 `CarConcept`
- **授权**:[Creative Commons Attribution 4.0 International (CC-BY-4.0)](https://creativecommons.org/licenses/by/4.0/legalcode)
- **著作权**:© 2024 Darmstadt Graphics Group GmbH —— 模型与贴图由 Eric Chadwick 制作
- **原始素材**:派生自一个公共领域(CC0)的概念车模型

### 本项目做过的修改(CC-BY 允许修改,但要求说明)

1. **去掉了 Khronos Group 与 3D Commerce 的 logo。** 这两个是**商标**,
   原授权文件明确把它们排除在 CC-BY 之外。它们烤在**轮胎侧壁**的贴图上,
   处理时把 `Tireside` 材质的 baseColor 贴图整个摘掉、换成纯深色。
   **这不是优化,是授权要求。**
2. 删除了内饰、引擎、传动轴、车牌等在追尾机位下永远看不到的部件。
3. 网格简化、贴图压成 WebP 并降到 512。

重现步骤见 `scripts/buildCarModel.mjs`。

---

## 2. 物理引擎 `@dimforge/rapier3d-compat`

- **授权**:Apache-2.0
- 由 npm 安装,编译产物(wasm 以 base64 内联)进入 `dist/`,**不进仓库**。
- 破例理由见 `CLAUDE.md`:物理求解器没法用 TypeScript 手写到可用质量。

---

## 其他运行时依赖

`three`(MIT)、`vite`(MIT)等常规依赖按各自的授权使用,不在这里逐条列出 ——
它们不引入任何**素材**,也没有署名义务。
