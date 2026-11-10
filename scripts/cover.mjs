// Generates cover.png (800x534) for gladys-teslamate: plain Node, no dependency.
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};

// Background: diagonal gradient, deep teal to night blue.
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W + y / H) / 2;
    set(x, y, [16 + 20 * t, 60 - 30 * t, 80 + 40 * t]);
  }
}
const white = [255, 255, 255];

const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
disc(400, 267, 260, white, 0.04);

// The dashboard card.
box(110, 70, 690, 464, 28, [248, 249, 252]);
box(150, 110, 420, 130, 8, [200, 205, 215]);

const red = [204, 30, 40];
const dark = [40, 44, 56];
const green = [47, 158, 68];
const grey = [214, 218, 226];

// A car seen from the side: body, cabin, wheels.
box(170, 230, 630, 320, 40, red);
box(270, 170, 520, 250, 50, red);
box(300, 186, 390, 240, 18, [235, 238, 245]);
box(405, 186, 495, 240, 18, [235, 238, 245]);
disc(265, 322, 44, dark);
disc(265, 322, 20, grey);
disc(535, 322, 44, dark);
disc(535, 322, 20, grey);

// A battery, 80 % full, and a lightning bolt.
box(150, 380, 470, 430, 12, dark);
box(470, 393, 484, 417, 4, dark);
box(158, 388, 412, 422, 8, green);
const bolt = [
  [580, 372],
  [548, 408],
  [578, 408],
  [546, 446],
];
for (let k = 0; k < bolt.length - 1; k += 1) {
  const [[x0, y0], [x1, y1]] = [bolt[k], bolt[k + 1]];
  for (let i = 0; i <= 40; i += 1) {
    disc(x0 + ((x1 - x0) * i) / 40, y0 + ((y1 - y0) * i) / 40, 6, [250, 176, 5]);
  }
}

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
