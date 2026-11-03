// Generates assets/icon.png without any image dependency: a minimal PNG encoder
// (zlib deflate + manual CRC32) drawing the MindScript mark — the app's own
// four-bar waveform (see brand-mark in settings/index.html) on a dark rounded
// square, matching the monochrome UI.
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'icon.png');
const SIZE = 256;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const TOP = hex('#24242a');
const BOTTOM = hex('#0c0c0e');
const EDGE = hex('#3a3a40');
const BAR = hex('#f4f4f5');

function insideRoundRect(dx, dy, half, r) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax > half || ay > half) return false;
  if (ax <= half - r || ay <= half - r) return true;
  const ex = ax - (half - r);
  const ey = ay - (half - r);
  return ex * ex + ey * ey <= r * r;
}

function insideCapsule(dx, dy, w, h) {
  const hw = w / 2;
  const hh = h / 2 - hw;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax > hw) return false;
  if (ay <= hh) return true;
  const ey = ay - hh;
  return ax * ax + ey * ey <= hw * hw;
}

// The settings brand-mark (24-unit viewBox: bars at x 3/8.2/13.4/18.6, w 3,
// heights 6/16/8/12) scaled 7x around the canvas centre.
const SCALE = 7;
const BARS = [
  { dx: -7.8, h: 6 },
  { dx: -2.6, h: 16 },
  { dx: 2.6, h: 8 },
  { dx: 7.8, h: 12 },
].map((b) => ({ dx: b.dx * SCALE, h: b.h * SCALE }));
const BAR_W = 3 * SCALE;

const HALF = SIZE / 2 - 10;
const RADIUS = 52;
const BORDER = 3;

function sample(x, y) {
  // returns [r,g,b] or null — rounded square, vertical gradient, hairline edge, bars
  const dx = x - SIZE / 2;
  const dy = y - SIZE / 2;
  if (!insideRoundRect(dx, dy, HALF, RADIUS)) return null;
  for (const bar of BARS) {
    if (insideCapsule(dx - bar.dx, dy, BAR_W, bar.h)) return BAR;
  }
  if (!insideRoundRect(dx, dy, HALF - BORDER, RADIUS - BORDER)) return EDGE;
  const t = Math.min(1, Math.max(0, (dy + HALF) / (2 * HALF)));
  return [0, 1, 2].map((k) => TOP[k] + (BOTTOM[k] - TOP[k]) * t);
}

const N = 4;
const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let rr = 0;
    let gg = 0;
    let bb = 0;
    let hits = 0;
    for (let sy = 0; sy < N; sy++) {
      for (let sx = 0; sx < N; sx++) {
        const s = sample(x + (sx + 0.5) / N, y + (sy + 0.5) / N);
        if (!s) continue;
        rr += s[0];
        gg += s[1];
        bb += s[2];
        hits++;
      }
    }
    const i = (y * SIZE + x) * 4;
    if (hits === 0) continue;
    rgba[i] = Math.round(rr / hits);
    rgba[i + 1] = Math.round(gg / hits);
    rgba[i + 2] = Math.round(bb / hits);
    rgba[i + 3] = Math.round((hits / (N * N)) * 255);
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodePng(SIZE, SIZE, rgba));
console.log(`wrote ${path.relative(ROOT, OUT)} (${SIZE}x${SIZE})`);
