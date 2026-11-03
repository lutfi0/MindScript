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
// Subfolders (assets/readme: README images) are not app assets.
fs.mkdirSync(path.join(ROOT, 'dist', 'assets'), { recursive: true });
for (const asset of fs.readdirSync(path.join(ROOT, 'assets'), { withFileTypes: true })) {
  if (!asset.isFile()) continue;
  fs.copyFileSync(path.join(ROOT, 'assets', asset.name), path.join(ROOT, 'dist', 'assets', asset.name));
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

// License notices for the vendored libraries ship next to them.
vendorFile(
  path.join(ROOT, 'node_modules', '@huggingface', 'transformers', 'LICENSE'),
  'LICENSE.transformers.txt',
);
// onnxruntime-web's npm package carries no LICENSE file; it is MIT.
fs.writeFileSync(
  path.join(vendor, 'ort', 'LICENSE.txt'),
  `MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
);
console.log('wrote ort/LICENSE.txt');
