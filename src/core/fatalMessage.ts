/**
 * 启动失败时显示给用户的那段话。
 *
 * 单独一个文件是为了能单测:`main.ts` 一 import 就会跑整个启动流程,而这段
 * 文案的分支恰恰值得钉住 —— 它是**用户唯一能看到的东西**,写错了没有任何
 * 测试会红,只会有人对着一屏英文报错发懵。
 *
 * ## WebGL 那一类单独给一句人话
 *
 * 跑 Lighthouse 时发现的:它那台 Chrome 拿不到 GPU,three 抛的是
 * 「Error creating WebGL context.」—— 对开发者够用,对用户等于没说。而这一类
 * 失败恰恰**最可能落在真实用户头上**(老显卡、驱动没更新、浏览器里关掉了
 * 硬件加速、跑在虚拟机里),不是只在开发环境出现的怪事。
 *
 * 原始信息仍然附在后面:人话是给用户的,原文是给来帮忙排查的人的,两个都要。
 */
export function fatalMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!/webgl/i.test(message)) {
    return `driftline 启动失败\n\n${message}`;
  }
  return [
    'driftline 起不来:这个浏览器创建不了 WebGL。',
    '',
    '常见原因:浏览器设置里关掉了「硬件加速」、显卡驱动太旧,',
    '或者跑在没有 GPU 的虚拟机里。',
    '',
    `原始信息:${message}`,
  ].join('\n');
}
