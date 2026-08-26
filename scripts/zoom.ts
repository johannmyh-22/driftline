/**
 * 把截图裁一块出来放大。
 *
 * **为什么值得单独有个脚本:** agent 只能通过截图看画面(HANDOFF 第三节),
 * 而 1280×720 的全景图里车只占一百来个像素 —— 这一轮就因此没看出轮辋被
 * 高 metalness 烧成了白饼(那是同一个坑的第三次)。放大之后一眼就看见了。
 *
 * 用法:
 *   npx tsx scripts/zoom.ts <输入.png> <输出.png> [cx] [cy] [w] [h] [scale]
 *   npm run zoom -- tests/visual/__output__/car-side.png out.png 640 350 240 150
 *
 * cx/cy 是要放大的中心点(像素),w/h 是裁剪尺寸,scale 是放大倍数(最近邻,
 * 不插值 —— 要看的是像素本身,插值会把问题抹掉)。
 */

import fs from 'node:fs';
import process from 'node:process';
import { PNG } from 'pngjs';

const [src, dst, cxRaw, cyRaw, wRaw, hRaw, scaleRaw] = process.argv.slice(2);
if (src === undefined || dst === undefined) {
  throw new Error('用法: npx tsx scripts/zoom.ts <输入.png> <输出.png> [cx] [cy] [w] [h] [scale]');
}

const png = PNG.sync.read(fs.readFileSync(src));
const w = Math.max(1, Math.min(png.width, Number(wRaw ?? 240)));
const h = Math.max(1, Math.min(png.height, Number(hRaw ?? 150)));
const scale = Math.max(1, Number(scaleRaw ?? 4));
const cx = Number(cxRaw ?? Math.floor(png.width / 2));
const cy = Number(cyRaw ?? Math.floor(png.height / 2));
const x0 = Math.max(0, Math.min(png.width - w, cx - Math.floor(w / 2)));
const y0 = Math.max(0, Math.min(png.height - h, cy - Math.floor(h / 2)));

const out = new PNG({ width: w * scale, height: h * scale });
for (let y = 0; y < out.height; y++) {
  for (let x = 0; x < out.width; x++) {
    const si = ((y0 + Math.floor(y / scale)) * png.width + x0 + Math.floor(x / scale)) * 4;
    const di = (y * out.width + x) * 4;
    out.data[di] = png.data[si] ?? 0;
    out.data[di + 1] = png.data[si + 1] ?? 0;
    out.data[di + 2] = png.data[si + 2] ?? 0;
    out.data[di + 3] = 255;
  }
}
fs.writeFileSync(dst, PNG.sync.write(out));
console.log(`${dst}  <- ${src} @(${x0},${y0}) ${w}x${h} ×${scale}`);
