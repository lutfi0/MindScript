// Downloads Whisper model files once from HuggingFace into
// userData/models/<modelId>/ and reports progress to every open window.
// ggml models also need the whisper.cpp server (CUDA or Vulkan build), fetched
// once from a GitHub release. After that MindScript runs offline.
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GpuBackend, ModelStatus, WhisperModelId } from '../shared/ipc';
import { speechSpec } from './catalog';
import { detectHardware, forcedBackend } from './hardware';
import { tMain } from './lang';

const MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

export function modelsRoot(): string {
  return path.join(app.getPath('userData'), 'models');
}

export function modelDir(model: WhisperModelId): string {
  return path.join(modelsRoot(), model);
}

function isGgmlFileDownloaded(model: WhisperModelId): boolean {
  const spec = speechSpec(model);
  if (!spec?.file) return false;
  const p = path.join(modelDir(model), spec.file);
  // catalog ggml files are written in place, so treat small ones as partial;
  // custom files go through *.part, so any finished file is complete
  return fs.existsSync(p) && fs.statSync(p).size > (spec.custom ? 1024 * 1024 : 100 * 1024 * 1024);
}

/** Ready to use: model files present, plus the whisper.cpp server for ggml models. */
export function isModelDownloaded(model: WhisperModelId): boolean {
  const spec = speechSpec(model);
  if (!spec) return false;
  if (spec.file) return isGgmlFileDownloaded(model) && whisperServerExe() !== null;
  const dir = modelDir(model);
  return MODEL_FILES.every((f) => fs.existsSync(path.join(dir, f)));
}

/* ── whisper.cpp runtime ───────────────────────────────────── */

// CUDA: the official whisper.cpp release. Vulkan: whisper.cpp ships no Windows
// Vulkan build, so .github/workflows/whisper-vulkan.yml builds the same
// version from source and publishes it on this repo as a prerelease.
const WHISPER_BUILD = 'b5454';
const WHISPER_VULKAN_VERSION = 'v1.9.5';
const CUDA_DLLS = ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll'];
const WHISPER_RUNTIMES: Record<GpuBackend, { url: string; dir: string[]; required: string[]; members: string[]; root: string }> = {
  cuda: {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_BUILD}/whisper-bin-win-cuda-12.4.0-x64.zip`,
    dir: ['bin', 'Release'],
    required: CUDA_DLLS,
    // Only what whisper-server needs; the archive ships ~40 other tools.
    members: ['whisper-server.exe', 'whisper.dll', 'ggml*.dll', ...CUDA_DLLS].map((f) => `Release/${f}`),
    root: 'Release',
  },
  vulkan: {
    url: `https://github.com/lutfi0/MindScript/releases/download/whisper-vulkan-${WHISPER_VULKAN_VERSION}/whisper-vulkan-${WHISPER_VULKAN_VERSION}-win-x64.zip`,
    dir: ['vulkan'],
    required: ['ggml-vulkan.dll'],
    members: [],
    root: '',
  },
};

function whisperBinDir(backend: GpuBackend, root = app.getPath('userData')): string {
  return path.join(root, 'whispercpp', ...WHISPER_RUNTIMES[backend].dir);
}

/** Backends to look for, in order: the forced one only, else CUDA before Vulkan. */
export function backendOrder(): GpuBackend[] {
  const forced = forcedBackend();
  return forced ? [forced] : ['cuda', 'vulkan'];
}

export function whisperServerExe(): string | null {
  for (const backend of backendOrder()) {
    const dirs = [whisperBinDir(backend)];
    // dev-profile runs use a different userData; fall back to the real one
    const prod = whisperBinDir(backend, path.join(app.getPath('appData'), 'mindscript'));
    if (!dirs.includes(prod)) dirs.push(prod);
    for (const dir of dirs) {
      const exe = path.join(dir, 'whisper-server.exe');
      if (fs.existsSync(exe) && WHISPER_RUNTIMES[backend].required.every((f) => fs.existsSync(path.join(dir, f)))) {
        return exe;
      }
    }
  }
  return null;
}

/** Unpacks a zip (optionally only the given members) with Windows' bundled bsdtar. */
export function unzip(zip: string, dest: string, members: string[] = []): Promise<void> {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  fs.mkdirSync(dest, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(tar, ['-xf', zip, '-C', dest, ...members], { windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
  });
}

async function installWhisperRuntime(onProgress: (frac: number) => void): Promise<void> {
  const backend = (await detectHardware()).backend;
  if (!backend) throw new Error(tMain('main.noGpuBackend'));
  const runtime = WHISPER_RUNTIMES[backend];
  const tmp = path.join(app.getPath('userData'), 'whispercpp', 'tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const zip = path.join(tmp, 'whisper.zip');
    await downloadFile(runtime.url, zip, onProgress);
    const extracted = path.join(tmp, 'x');
    await unzip(zip, extracted, runtime.members);
    fs.rmSync(zip, { force: true });
    const staged = path.join(extracted, runtime.root);
    if (!fs.existsSync(path.join(staged, 'whisper-server.exe'))) {
      throw new Error('whisper-server.exe not found in release archive');
    }
    const dest = whisperBinDir(backend);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(staged, dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Total size of a model directory in bytes (0 when missing). */
export function modelDirSize(model: WhisperModelId): number {
  const walk = (dir: string): number => {
    let total = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += walk(p);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* skip vanished files */
        }
      }
    }
    return total;
  };
  return walk(modelDir(model));
}

/** Removes a downloaded model from disk entirely. */
export function deleteModel(model: WhisperModelId): void {
  fs.rmSync(modelDir(model), { recursive: true, force: true });
}

function broadcast(status: ModelStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('model:status', status);
  }
}

const HF_MIRRORS = ['https://huggingface.co', 'https://hf-mirror.com'];

function downloadBases(): string[] {
  const custom = process.env.MINDSCRIPT_HF_MIRROR?.trim();
  return custom ? [custom] : HF_MIRRORS;
}

/**
 * Streams a file to disk with a stall watchdog: if no bytes arrive for
 * STALL_MS the transfer aborts and the caller can fall back to a mirror.
 */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress: (frac: number) => void,
): Promise<boolean> {
  const STALL_MS = 60_000;
  const controller = new AbortController();
  let lastActivity = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > STALL_MS) controller.abort();
  }, 5_000);

  const out = fs.createWriteStream(dest);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }
    const total = Number(res.headers.get('content-length')) || 0;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastActivity = Date.now();
      received += value.byteLength;
      out.write(Buffer.from(value));
      if (total > 0) onProgress(received / total);
    }
    await new Promise<void>((resolve, reject) => {
      out.end(resolve);
      out.on('error', reject);
    });
    if (received === 0) throw new Error('empty response');
    return true;
  } finally {
    clearInterval(watchdog);
    if (!out.closed) out.destroy();
    if (fs.existsSync(dest) && fs.statSync(dest).size === 0) fs.rmSync(dest, { force: true });
  }
}

export async function downloadWithMirrors(repoFile: string, dest: string, onProgress: (frac: number) => void): Promise<void> {
  let lastError: unknown = null;
  for (const base of downloadBases()) {
    try {
      await downloadFile(`${base}/${repoFile}`, dest, onProgress);
      return;
    } catch (err) {
      lastError = err;
      fs.rmSync(dest, { force: true });
    }
  }
  throw new Error(`${repoFile}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

let activeDownload: Promise<void> | null = null;

/**
 * Ensures the given model exists locally. Concurrent calls share one download.
 * Safe to call when already downloaded (resolves immediately).
 */
export function ensureModelDownloaded(model: WhisperModelId): Promise<void> {
  if (isModelDownloaded(model)) return Promise.resolve();
  if (activeDownload) return activeDownload;

  const spec = speechSpec(model);
  if (!spec) return Promise.reject(new Error(`unknown model: ${model}`));
  const { repo, url } = spec;
  const dir = modelDir(model);
  const singleFile = spec.file;

  activeDownload = (async () => {
    broadcast({ state: 'downloading', model, progress: 0, message: tMain('main.downloading') });
    try {
      if (singleFile) {
        if (!whisperServerExe()) {
          broadcast({ state: 'downloading', model, progress: 0, message: tMain('cleanup.dlEngine') });
          await installWhisperRuntime((frac) =>
            broadcast({
              state: 'downloading',
              model,
              progress: Math.round(frac * 100),
              message: tMain('cleanup.dlEngine'),
            }),
          );
        }
        // ggml model: one big .bin straight from the whisper.cpp HF repo
        if (!isGgmlFileDownloaded(model)) {
          const onProgress = (frac: number) =>
            broadcast({
              state: 'downloading',
              model,
              progress: Math.round(frac * 100),
              message: tMain('main.downloading'),
            });
          const dest = path.join(dir, singleFile);
          fs.mkdirSync(dir, { recursive: true });
          if (url) {
            // custom model: straight from the user's link, renamed when complete
            await downloadFile(url, `${dest}.part`, onProgress);
            fs.renameSync(`${dest}.part`, dest);
          } else {
            await downloadWithMirrors(`${repo}/resolve/main/${singleFile}`, dest, onProgress);
          }
        }
        broadcast({ state: 'loading', model, message: tMain('main.preparing') });
        return;
      }
      for (let i = 0; i < MODEL_FILES.length; i++) {
        const file = MODEL_FILES[i];
        const dest = path.join(dir, file);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
        const url = `${repo}/resolve/main/${file}`;
        // per-file progress mapped into the file's slice of 0..100
        const base = (i / MODEL_FILES.length) * 100;
        const span = 100 / MODEL_FILES.length;
        await downloadWithMirrors(url, dest, (frac) => {
          broadcast({
            state: 'downloading',
            model,
            progress: Math.round(base + frac * span),
            message: tMain('main.downloadingFiles', { i: i + 1, n: MODEL_FILES.length }),
          });
        });
      }
      broadcast({ state: 'loading', model, message: tMain('main.preparing') });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcast({ state: 'error', model, message: tMain('main.downloadFailed', { message }) });
      throw err;
    }
  })();

  const flight = activeDownload;
  flight.finally(() => {
    if (activeDownload === flight) activeDownload = null;
  });
  return flight;
}
