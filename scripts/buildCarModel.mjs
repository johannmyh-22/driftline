/*
 * 从 Khronos glTF-Sample-Assets 的 CarConcept 生成 src/assets/car.glb。
 *
 * **一次性脚本,不进构建流程**(CI 里没有网络也不该下载素材)。留在仓库里是为了
 * 让「这个二进制是怎么来的、动过什么」可复现、可审计 —— 尤其是去商标那一步,
 * 那是授权要求不是优化。
 *
 * 用法:
 *   curl -L -o CarConcept.glb \
 *     https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/CarConcept/glTF-Binary/CarConcept.glb
 *   npm i --no-save @gltf-transform/cli
 *   node scripts/buildCarModel.mjs
 *   npx gltf-transform optimize car.pre.glb src/assets/car.glb \
 *     --compress false --texture-compress webp --texture-size 512 \
 *     --simplify-error 0.01 --join false --flatten false
 *
 * **`--compress false` 是必须的。** meshopt/quantize 会把反量化的缩放放在节点
 * 变换上,而 craftModel.ts 是把 matrixWorld 烘进几何再重新分组的,两者不兼容 ——
 * 实测压过的模型在游戏里是散架的(车身面片错位、轮子飞出去)。用未压缩的,
 * 靠 gzip 传输(1666 KB → 990 KB)。
 *
 * `--join false --flatten false` 也是必须的:默认的 join 会把 58 个节点压成
 * 13 个,四个轮子的节点直接消失,就没法单独转向/滚转了。
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read('CarConcept.glb');
const root = doc.getRoot();

// 1) 剥内饰:追尾机位永远看不到,占了大半的面数与贴图。
let stripped = 0;
for (const node of root.listNodes()) {
  if (/^(Interior|Engine|Axles|License)/i.test(node.getName() ?? '')) { node.dispose(); stripped++; }
}

// 2) 去商标:KHRONOS GROUP 与 3DCommerce 的 logo 烤在**轮胎侧壁**贴图上。
//    授权文件明确写着 logo 与商标不在 CC-BY 授权范围内,必须去掉。
let cleaned = 0;
for (const mat of root.listMaterials()) {
  if ((mat.getName() ?? '') === 'Tireside') {
    if (mat.getBaseColorTexture()) { mat.setBaseColorTexture(null); cleaned++; }
    mat.setBaseColorFactor([0.055, 0.055, 0.058, 1]); // 干净的深色胎壁
  }
}
console.log(`stripped nodes: ${stripped}, logo textures removed: ${cleaned}`);
await io.write('car.pre.glb', doc);
