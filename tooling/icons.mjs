// Draws the two app icons (1024 × 1024 PNG; electron-builder makes the .icns from them):
// a rounded square with the ring-and-dot mark used in the menu bar. Green for the host
// (Grandma's computer), blue for the helper. Run `node tooling/icons.mjs` after changing them.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 1024;

/** How much of the pixel a shape covers, from its signed distance (negative inside). */
const coverage = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

function roundedSquare(x, y) {
  // macOS icon grid: an 824-pixel body with rounded corners, centred on the canvas.
  const half = 412;
  const radius = 185;
  const qx = Math.abs(x - SIZE / 2) - (half - radius);
  const qy = Math.abs(y - SIZE / 2) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function mark(x, y) {
  const distance = Math.hypot(x - SIZE / 2, y - SIZE / 2);
  const ring = Math.abs(distance - 230) - 38;
  const dot = distance - 92;
  return Math.min(ring, dot);
}

function draw(top, bottom) {
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(1 + SIZE * 4);
    const t = y / (SIZE - 1);
    const background = top.map((value, i) => value + (bottom[i] - value) * t);
    for (let x = 0; x < SIZE; x++) {
      const alpha = coverage(roundedSquare(x + 0.5, y + 0.5));
      const white = coverage(mark(x + 0.5, y + 0.5));
      const offset = 1 + x * 4;
      for (let i = 0; i < 3; i++) {
        row[offset + i] = Math.round(background[i] + (255 - background[i]) * white);
      }
      row[offset + 3] = Math.round(alpha * 255);
    }
    rows.push(row);
  }
  return png(Buffer.concat(rows));
}

function png(pixels) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(join(root, 'apps/host/build/icon.png'), draw([46, 140, 114], [26, 94, 77]));
writeFileSync(join(root, 'apps/helper/build/icon.png'), draw([70, 120, 190], [38, 70, 128]));
console.log('icons: wrote apps/host/build/icon.png and apps/helper/build/icon.png');
