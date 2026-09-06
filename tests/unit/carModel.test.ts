import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODEL_MATERIAL } from '../../src/game/tuning';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * `src/assets/car.glb` 的**结构**断言。
 *
 * 为什么需要这一层:`craftModel.ts` 是把 glTF 的节点树拆开重组的 —— 四个
 * 轮子要从车身上摘下来、按物理算出的位置重新挂,卡钳要和轮辋分开。这些
 * 全都建立在「模型里的节点长成某个样子」这个假设上,而假设一旦不成立,
 * **表现出来的是画面错而不是报错**。
 *
 * 已经踩过两次了,两次都是截图没拦住:
 *
 * 1. 车整个立起来(多转了一次 −90°)—— 从正后方看轮廓太像,肉眼没认出来,
 *    最后是量包围盒量出来的。
 * 2. 前轮「放飞」—— 轮子的旋转中心用了整组网格的并集包围盒中心,而组里
 *    混着**偏心的刹车卡钳**。静态截图里轮子停在哪个角度都像是对的,只有
 *    动起来才看得见它在绕一个偏心点公转。
 *
 * 所以这里不测渲染结果,测的是那几条被依赖的**结构前提**。glTF 的 JSON
 * 块直接读二进制头就能拿到,不需要 GLTFLoader(它要 DOM 才能解贴图)。
 * ══════════════════════════════════════════════════════════════════════════
 */

interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  translation?: [number, number, number];
}

interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: { roughnessFactor?: number; metallicFactor?: number };
  extensions?: {
    KHR_materials_clearcoat?: { clearcoatFactor?: number; clearcoatRoughnessFactor?: number };
  };
}

function readGlbJson(): { nodes: GltfNode[]; materials: GltfMaterial[] } {
  const path = fileURLToPath(new URL('../../src/assets/car.glb', import.meta.url));
  const buffer = readFileSync(path);
  // GLB 容器:12 字节头,之后是若干 chunk(4 字节长度 + 4 字节类型 + 数据)。
  // 规范要求第一个 chunk 必须是 JSON。
  const length = buffer.readUInt32LE(12);
  const parsed = JSON.parse(buffer.subarray(20, 20 + length).toString('utf8')) as {
    nodes?: GltfNode[];
    materials?: GltfMaterial[];
  };
  return { nodes: parsed.nodes ?? [], materials: parsed.materials ?? [] };
}

const { nodes, materials } = readGlbJson();

/** 名字 → 节点,顺带保证名字唯一(重名的话下面的查找就没意义了)。 */
function nodeNamed(name: string): GltfNode {
  const hits = nodes.filter((n) => n.name === name);
  expect(hits, `节点 ${name} 应该唯一存在`).toHaveLength(1);
  return hits[0] as GltfNode;
}

const WHEEL_ROOTS = ['WheelFrontL', 'WheelFrontR', 'WheelRearL', 'WheelRearR'] as const;

describe('car.glb 的节点结构', () => {
  it('四个轮子各有一个根节点,且自己不带网格', () => {
    for (const name of WHEEL_ROOTS) {
      const node = nodeNamed(name);
      // 根节点只当挂点用。它要是自己带网格,`wheelSlotOf` 的父链查找就会把
      // 这块网格算进轮子,而它未必绕轮轴对称。
      expect(node.mesh, `${name} 不该自己带网格`).toBeUndefined();
      expect(node.translation, `${name} 必须有平移(轮轴位置从这里取)`).toBeDefined();
    }
  });

  it('轴距/轮距和 craftModel.ts 里写死的缩放基准对得上', () => {
    const front = nodeNamed('WheelFrontL').translation as [number, number, number];
    const rear = nodeNamed('WheelRearL').translation as [number, number, number];
    const frontR = nodeNamed('WheelFrontR').translation as [number, number, number];

    // 模型空间是 Z 朝上:前后差在 Y 上、左右差在 X 上、轮心高度在 Z 上。
    expect(Math.abs(front[1] - rear[1])).toBeCloseTo(2.8, 2); // MODEL_WHEEL_BASE
    expect(Math.abs(front[0] - frontR[0])).toBeCloseTo(1.952, 2); // MODEL_TRACK
  });

  it('四个轮心等高 —— 车身下沉量是从轮轴 Y 反推的', () => {
    const heights = WHEEL_ROOTS.map((n) => (nodeNamed(n).translation as number[])[2] as number);
    for (const h of heights) {
      expect(h).toBeCloseTo(heights[0] as number, 4);
    }
  });

  it('轮距中点不在原点上 —— 车身必须补这个偏移', () => {
    const front = (nodeNamed('WheelFrontL').translation as number[])[1] as number;
    const rear = (nodeNamed('WheelRearL').translation as number[])[1] as number;
    /*
     * 这条不是在断言"模型必须是歪的",而是在钉住**这个偏移确实存在且不可忽略**:
     * 实测 0.086 m。`craftModel.ts` 按四轮平均把车身挪回去,不挪的话四个轮子
     * 相对车身整体前移 8 cm(轮子不居中在轮眉里)。哪天换了对称的模型,这条
     * 会红,那时候删掉它就行 —— 但要**知道**自己在删什么。
     */
    const midpoint = (front + rear) / 2;
    expect(Math.abs(midpoint)).toBeGreaterThan(0.02);
    expect(Math.abs(midpoint)).toBeLessThan(0.2);
  });

  it('每个轮子下面都挂着一个偏心的刹车卡钳 —— 这是"放飞"的根因', () => {
    for (const root of WHEEL_ROOTS) {
      const children = (nodeNamed(root).children ?? []).map((i) => nodes[i] as GltfNode);
      const pads = children.filter((c) => /BrakePad/i.test(c.name ?? ''));
      expect(pads, `${root} 下面应该有卡钳`).toHaveLength(1);
      // 卡钳存在 = `wheelSlotOf` 里那条「卡钳不跟着滚」的分支有实际作用。
      // 它要是哪天没了,那条分支就是死代码,应该一并删掉而不是留着。
      const rims = children.filter((c) => /Rim$/i.test(c.name ?? ''));
      expect(rims, `${root} 下面应该有轮辋`).toHaveLength(1);
    }
  });
});

describe('car.glb 的材质', () => {
  it('主车漆自带展厅级的镜面清漆 —— tuneMaterial() 必须继续压它', () => {
    const paint = materials.find((m) => m.name === 'Paint 1 Carmine');
    expect(paint, '找不到主车漆材质').toBeDefined();
    const clearcoat = paint?.extensions?.KHR_materials_clearcoat;
    expect(clearcoat, '主车漆应该带 clearcoat 扩展').toBeDefined();
    /*
     * 素材自带 clearcoat=1.0 / clearcoatRoughness=0.0,就是一面镜子;
     * 人类反馈「这个车有点过于闪亮了」说的就是它。这条红了只意味着素材换了,
     * 那时候要重新核 MODEL_MATERIAL 的每一个值,而不是直接放宽这条。
     */
    expect(clearcoat?.clearcoatFactor ?? 0).toBeGreaterThan(MODEL_MATERIAL.paintClearcoat);
    expect(clearcoat?.clearcoatRoughnessFactor ?? 0).toBeLessThan(
      MODEL_MATERIAL.paintClearcoatRoughness,
    );
  });

  it('有镜面级粗糙度的材质存在 —— minRoughness 这条下限不是摆设', () => {
    const mirrors = materials.filter(
      (m) => (m.pbrMetallicRoughness?.roughnessFactor ?? 1) < MODEL_MATERIAL.minRoughness,
    );
    // 实测:Glass(0)、Mirror(0)、Brake(0.2)、Rim2(0.049)、Paint 2 Graphite(0.2)。
    expect(mirrors.length).toBeGreaterThan(0);
  });

  it('轮胎侧壁的商标贴图已经摘掉 —— 这是 CC-BY 的授权要求', () => {
    const tireside = materials.find((m) => m.name === 'Tireside') as
      | (GltfMaterial & { pbrMetallicRoughness?: { baseColorTexture?: unknown } })
      | undefined;
    expect(tireside, '找不到胎壁材质').toBeDefined();
    // Khronos / 3D Commerce 的 logo 烤在这张贴图上,商标不在 CC-BY 授权范围内。
    expect(tireside?.pbrMetallicRoughness?.baseColorTexture).toBeUndefined();
  });
});
