// Copies static renderer assets (html/css) into dist/, next to the compiled js,
// and vendors the local inference runtime (transformers.js + onnxruntime wasm)
// so the engine never needs the network at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'renderer');
const DST = path.join(ROOT, 'dist', 'renderer');

let count = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const src = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(src);
    } else if (/\.(html|css)$/.test(entry.name)) {
      const dst = path.join(DST, path.relative(SRC, src));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      count++;
    }
  }
}
walk(SRC);
console.log(`copied ${count} renderer assets to dist/renderer`);

// Renderer pages reference assets via relative paths (../../assets/...).
fs.mkdirSync(path.join(ROOT, 'dist', 'assets'), { recursive: true });
for (const asset of fs.readdirSync(path.join(ROOT, 'assets'))) {
  fs.copyFileSync(path.join(ROOT, 'assets', asset), path.join(ROOT, 'dist', 'assets', asset));
}
console.log('copied assets/ into dist/assets');

// --- vendor the local AI runtime -------------------------------------------
const vendor = path.join(ROOT, 'dist', 'vendor');
fs.mkdirSync(vendor, { recursive: true });

function vendorFile(from, to) {
  const dst = path.join(vendor, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(from, dst);
  console.log(`vendored ${to}`);
}

vendorFile(
  path.join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.min.js'),
  'transformers.min.js',
);

// Copy every ORT wasm variant (plain/jsep/asyncify/jspi) — which one loads
// depends on the runtime environment, so all of them must be vendored.
const ortDist = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
for (const file of fs.readdirSync(ortDist)) {
  if (/^ort-wasm-simd-threaded\.(mjs|wasm)$/.test(file) || /^ort-wasm-simd-threaded\.\w+\.(mjs|wasm)$/.test(file)) {
    vendorFile(path.join(ortDist, file), path.join('ort', file));
  }
}
