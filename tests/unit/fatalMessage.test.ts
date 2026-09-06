import { describe, expect, it } from 'vitest';
import { fatalMessage } from '../../src/core/fatalMessage';

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 启动失败的文案。**这是用户唯一看得到的东西**,写错了没有任何别的测试会红,
 * 只会有人对着一屏英文报错发懵。
 *
 * WebGL 那一支是跑 Lighthouse 时发现的:它那台 Chrome 拿不到 GPU,three 抛
 * 「Error creating WebGL context.」—— 而这类失败最可能落在真实用户头上
 * (关了硬件加速、老驱动、虚拟机),不是开发环境里的怪事。
 * ══════════════════════════════════════════════════════════════════════════
 */

describe('fatalMessage', () => {
  it('WebGL 失败给一句人话,而且保留原始信息', () => {
    const text = fatalMessage(new Error('Error creating WebGL context.'));
    expect(text).toContain('创建不了 WebGL');
    expect(text).toContain('硬件加速');
    // 原文要留着 —— 人话是给用户的,原文是给来帮忙排查的人的。
    expect(text).toContain('Error creating WebGL context.');
  });

  it('three 那几种 WebGL 报错的措辞都认得出来', () => {
    for (const raw of [
      'Error creating WebGL context.',
      'THREE.WebGLRenderer: A WebGL context could not be created.',
      'WebGL2 not supported',
      'webgl unavailable',
    ]) {
      expect(fatalMessage(new Error(raw)), raw).toContain('创建不了 WebGL');
    }
  });

  it('其他失败照常显示原始信息,不硬套 WebGL 那套说辞', () => {
    const text = fatalMessage(new Error('缺少 #app 挂载点'));
    expect(text).toContain('缺少 #app 挂载点');
    expect(text).not.toContain('硬件加速');
  });

  it('抛出来的不是 Error 也不能炸', () => {
    expect(fatalMessage('炸了')).toContain('炸了');
    expect(fatalMessage(null)).toContain('null');
    expect(fatalMessage(undefined)).toContain('undefined');
  });
});
