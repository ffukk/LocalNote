/**
 * 生成 PWA 图标：零依赖，手写 PNG 编码器（zlib 是 Node 内置）。
 * 用法：node tools/make-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = resolve(fileURLToPath(new URL("../public/icons/", import.meta.url)));
const EXT_DIR = resolve(fileURLToPath(new URL("../extension/icons/", import.meta.url)));

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * @param {number} size 边长
 * @param {{maskable?: boolean}} options maskable 时满幅铺底并缩小图形以留安全区
 */
function draw(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const top = [0x3b, 0x77, 0xf5];
  const bottom = [0x1f, 0x5a, 0xd0];
  const radius = maskable ? 0 : size * 0.22;
  const scale = maskable ? 0.7 : 1;
  const stroke = size * 0.115 * scale;

  const points = [
    [0.27, 0.52],
    [0.44, 0.68],
    [0.75, 0.33],
  ].map(([x, y]) => [size / 2 + (x - 0.5) * size * scale, size / 2 + (y - 0.5) * size * scale]);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (y * size + x) * 4;
      // 圆角矩形覆盖判断
      const cx = Math.min(Math.max(x, radius), size - radius);
      const cy = Math.min(Math.max(y, radius), size - radius);
      const cornerDist = Math.hypot(x - cx, y - cy);
      if (!maskable && cornerDist > radius) continue; // 保持透明
      const ratio = y / size;
      let color = [top[0] + (bottom[0] - top[0]) * ratio, top[1] + (bottom[1] - top[1]) * ratio, top[2] + (bottom[2] - top[2]) * ratio];
      // 顶部一道更亮的高光带，让图标在小尺寸下仍有层次
      if (ratio < 0.12) color = color.map((c, i) => c + (i === 2 ? 18 : 6) * (1 - ratio / 0.12));
      let [r, g, b] = color.map((v) => Math.max(0, Math.min(255, Math.round(v))));
      let a = 255;
      if (!maskable) {
        // 圆角边缘做 1px 抗锯齿
        const edge = radius - cornerDist;
        if (edge < 1) a = Math.max(0, Math.round(255 * edge));
      }
      let onCheck = false;
      for (let i = 0; i < points.length - 1; i += 1) {
        const [ax, ay] = points[i];
        const [bx, by] = points[i + 1];
        if (distToSegment(x + 0.5, y + 0.5, ax, ay, bx, by) <= stroke / 2) {
          onCheck = true;
          break;
        }
      }
      if (onCheck) {
        r = 255;
        g = 255;
        b = 255;
      }
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = a;
    }
  }
  return encodePng(size, size, rgba);
}

const tasks = [
  ["icon-192.png", draw(192)],
  ["icon-512.png", draw(512)],
  ["icon-maskable-512.png", draw(512, { maskable: true })],
  ["icon-32.png", draw(32)],
];

await mkdir(OUT_DIR, { recursive: true });
await mkdir(EXT_DIR, { recursive: true });
for (const [name, buffer] of tasks) {
  const targets = [[`public/icons/${name}`, join(OUT_DIR, name)]];
  // 扩展只需 32 与 192 两个尺寸，直接复用同一份像素
  if (name === "icon-32.png" || name === "icon-192.png") targets.push([`extension/icons/${name}`, join(EXT_DIR, name)]);
  for (const [label, path] of targets) {
    await writeFile(path, buffer);
    console.log(`✓ ${label}  ${buffer.readUInt32BE(16)}px  ${buffer.length} bytes`);
  }
}
