import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const FORBIDDEN = /Math\s*\.\s*random\s*\(/;

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else if (/\.(ts|js|glsl|css)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * 这条守卫等价于 M0 要求的「CI grep 检查」。
 *
 * 一旦 src/ 里出现这个调用,种子就不再决定一切:截图回归、幽灵回放、
 * 赛道生成校验会同时失去可复现性,而且通常几个里程碑之后才暴雷。
 *
 * 匹配的是「带括号的调用」而不是裸标识符,所以注释里提到这个 API 时
 * 请不要连括号一起写。
 */
describe('确定性守卫', () => {
  const files = collectFiles(SRC_DIR);

  it('扫到了 src/ 下的源文件', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((file) => path.relative(SRC_DIR, file)))(
    'src/%s 不直接调用 Math.random()',
    (relative) => {
      const source = readFileSync(path.join(SRC_DIR, relative), 'utf8');
      expect(FORBIDDEN.test(source)).toBe(false);
    },
  );
});
