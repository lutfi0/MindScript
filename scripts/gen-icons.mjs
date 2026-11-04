// Renders the MindScript logo (assets/icon.svg) into assets/icon.png — used
// for the window, tray and NSIS installer — and into the Microsoft Store
// tiles in build/appx/. sharp is the image library @huggingface/transformers
// already installs.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(ROOT, 'assets', 'icon.svg');
const OUT = path.join(ROOT, 'assets', 'icon.png');
const APPX_DIR = path.join(ROOT, 'build', 'appx');
const SVG_SIZE = 1024; // the logo's viewBox

// Draws the logo `mark` pixels wide, centred on a transparent width x height
// canvas.
async function write(file, width, height, mark) {
  const logo = await sharp(SVG, { density: (72 * mark * 4) / SVG_SIZE })
    .resize(mark, mark)
    .png()
    .toBuffer();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: logo, left: Math.round((width - mark) / 2), top: Math.round((height - mark) / 2) }])
    .png({ compressionLevel: 9 })
    .toFile(file);
  console.log(`wrote ${path.relative(ROOT, file)} (${width}x${height})`);
}

await write(OUT, 256, 256, 256);

// Microsoft Store (MSIX) tiles, picked up by electron-builder from build/appx/.
// Tiles keep some margin around the mark, as the Windows tile guidelines ask.
const TILES = [
  ['StoreLogo.png', 50, 50, 50],
  ['Square44x44Logo.png', 44, 44, 44],
  ['SmallTile.png', 71, 71, 52],
  ['Square150x150Logo.png', 150, 150, 100],
  ['Wide310x150Logo.png', 310, 150, 100],
  ['LargeTile.png', 310, 310, 200],
];
for (const [name, w, h, mark] of TILES) await write(path.join(APPX_DIR, name), w, h, mark);
