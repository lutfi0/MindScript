// Renders the MindScript logo (assets/icon.svg) into assets/icon.png, used
// for the window, tray and NSIS installer. sharp is the image library
// @huggingface/transformers already installs.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(ROOT, 'assets', 'icon.svg');
const OUT = path.join(ROOT, 'assets', 'icon.png');
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
