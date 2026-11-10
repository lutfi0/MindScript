// Built-in text cleanup: llama.cpp GPU server lifecycle (CUDA on NVIDIA,
// Vulkan on AMD/Intel) + GGUF model store.
// The no-install alternative to Ollama, mirroring whispercpp.ts: a native
// llama-server.exe is spawned once per model, kept warm on its own port and
// spoken to through its OpenAI-compatible /v1 API (so polish.ts is shared).
// The runtime itself (CUDA ~280 MB, Vulkan ~40 MB zip) is fetched from the official llama.cpp
// GitHub release the first time a cleanup model is downloaded.
import { app, BrowserWindow } from 'electron';
import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CleanupDevice, CleanupModelId, CleanupStatus, GpuBackend } from '../shared/ipc';
import { cleanupSpec } from './catalog';
import { runInBackground } from './proc';
import { detectHardware } from './hardware';
import { backendOrder, downloadFile, downloadWithMirrors, modelsRoot, unzip } from './models';
import { tMain } from './lang';

const PORT = 17896;
const HEALTH_TIMEOUT_MS = 90_000; // first CUDA init + model load
// Small context keeps the KV cache (and VRAM) tiny; polish.ts chunks long
// dictations so each request fits comfortably.
const CTX_SIZE = 2048;

const LLAMA_BUILD = 'b12034';
const RELEASE_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}`;
const LLAMA_ZIPS: Record<GpuBackend, string> = {
  cuda: `llama-${LLAMA_BUILD}-bin-win-cuda-12.4-x64.zip`,
  vulkan: `llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`,
};
const CUDART_ZIP = 'cudart-llama-bin-win-cuda-12.4-x64.zip';
const CUDA_DLLS = ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll'];
const REQUIRED: Record<GpuBackend, string[]> = { cuda: CUDA_DLLS, vulkan: ['ggml-vulkan.dll'] };
// Only what llama-server needs — the release zip also ships ~40 other tools.
const KEEP = /^(llama-server(-impl)?\.(exe|dll)|llama-common\.dll|llama\.dll|mtmd\.dll|ggml.*\.dll|libomp\.dll|LICENSE.*)$/i;

function binDir(backend: GpuBackend, root = app.getPath('userData')): string {
  // CUDA keeps the original location so existing installs stay valid
  return path.join(root, 'llamacpp', backend === 'cuda' ? 'bin' : 'vulkan');
}

function llamaRuntime(): { exe: string; backend: GpuBackend } | null {
  for (const backend of backendOrder()) {
    const dirs = [binDir(backend)];
    // dev-profile runs use a different userData; fall back to the real one
    const prod = binDir(backend, path.join(app.getPath('appData'), 'mindscript'));
    if (!dirs.includes(prod)) dirs.push(prod);
    for (const dir of dirs) {
      const exe = path.join(dir, 'llama-server.exe');
      if (fs.existsSync(exe) && REQUIRED[backend].every((f) => fs.existsSync(path.join(dir, f)))) {
        return { exe, backend };
      }
    }
  }
  return null;
}

export function llamaServerExe(): string | null {
  return llamaRuntime()?.exe ?? null;
}

export function cleanupModelDir(model: CleanupModelId): string {
  return path.join(modelsRoot(), model);
}

export function cleanupModelPath(model: CleanupModelId): string {
  return path.join(cleanupModelDir(model), cleanupSpec(model)?.file ?? 'missing.gguf');
}

export function isCleanupModelDownloaded(model: CleanupModelId): boolean {
  const p = cleanupModelPath(model);
  // partial downloads are written to *.part, so any real file is complete
  return !!cleanupSpec(model) && fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024;
}

export function cleanupModelSize(model: CleanupModelId): number {
  try {
    return fs.statSync(cleanupModelPath(model)).size;
  } catch {
    return 0;
  }
}

export function deleteCleanupModel(model: CleanupModelId): void {
  fs.rmSync(cleanupModelDir(model), { recursive: true, force: true });
}

function broadcast(status: CleanupStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('cleanup:status', status);
  }
}

/** whisper.cpp's CUDA build already ships the same CUDA 12 runtime DLLs —
 *  reuse them instead of downloading another ~390 MB. */
function findLocalCudaDlls(): string | null {
  const roots = [app.getPath('userData'), path.join(app.getPath('appData'), 'mindscript')];
  for (const root of roots) {
    const dir = path.join(root, 'whispercpp', 'bin', 'Release');
    if (CUDA_DLLS.every((f) => fs.existsSync(path.join(dir, f)))) return dir;
  }
  return null;
}

async function installRuntime(onProgress: (frac: number) => void): Promise<void> {
  const root = path.join(app.getPath('userData'), 'llamacpp');
  const tmp = path.join(root, 'tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const backend = (await detectHardware()).backend;
    if (!backend) throw new Error(tMain('main.noGpuBackend'));
    const cuda = backend === 'cuda';
    const cudaDir = cuda ? findLocalCudaDlls() : null;
    const llamaZip = path.join(tmp, LLAMA_ZIPS[backend]);
    // cudart download (when needed) is the bigger half of the bar
    const llamaShare = !cuda || cudaDir ? 1 : 0.42;
    await downloadFile(`${RELEASE_BASE}/${LLAMA_ZIPS[backend]}`, llamaZip, (f) => onProgress(f * llamaShare));
    const extracted = path.join(tmp, 'x');
    await unzip(llamaZip, extracted);
    fs.rmSync(llamaZip, { force: true });

    const staged = path.join(tmp, 'bin');
    fs.mkdirSync(staged, { recursive: true });
    for (const name of fs.readdirSync(extracted)) {
      if (KEEP.test(name)) fs.renameSync(path.join(extracted, name), path.join(staged, name));
    }
    if (!fs.existsSync(path.join(staged, 'llama-server.exe'))) {
      throw new Error('llama-server.exe not found in release archive');
    }

    if (!cuda) {
      // Vulkan needs no extra runtime: the GPU driver provides vulkan-1.dll
    } else if (cudaDir) {
      for (const f of CUDA_DLLS) {
        // hard link on the same volume saves ~570 MB; copy otherwise
        try {
          fs.linkSync(path.join(cudaDir, f), path.join(staged, f));
        } catch {
          fs.copyFileSync(path.join(cudaDir, f), path.join(staged, f));
        }
      }
    } else {
      const cudaZip = path.join(tmp, CUDART_ZIP);
      await downloadFile(`${RELEASE_BASE}/${CUDART_ZIP}`, cudaZip, (f) =>
        onProgress(llamaShare + f * (1 - llamaShare)),
      );
      const cx = path.join(tmp, 'cuda');
      await unzip(cudaZip, cx);
      for (const name of fs.readdirSync(cx)) {
        if (name.toLowerCase().endsWith('.dll')) fs.renameSync(path.join(cx, name), path.join(staged, name));
      }
    }

    fs.rmSync(binDir(backend), { recursive: true, force: true });
    fs.renameSync(staged, binDir(backend));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

let activeDownload: Promise<void> | null = null;

/**
 * Makes sure the llama.cpp runtime and the given GGUF model are on disk,
 * reporting progress on 'cleanup:status'. Concurrent calls share one flight.
 */
export function ensureCleanupModel(model: CleanupModelId): Promise<void> {
  if (llamaServerExe() && isCleanupModelDownloaded(model)) return Promise.resolve();
  if (activeDownload) return activeDownload;

  activeDownload = (async () => {
    try {
      if (!llamaServerExe()) {
        broadcast({ state: 'downloading', model, progress: 0, message: tMain('cleanup.dlEngine') });
        await installRuntime((frac) =>
          broadcast({
            state: 'downloading',
            model,
            progress: Math.round(frac * 100),
            message: tMain('cleanup.dlEngine'),
          }),
        );
      }
      if (!isCleanupModelDownloaded(model)) {
        const spec = cleanupSpec(model);
        if (!spec?.file) throw new Error(`unknown model: ${model}`);
        const dest = cleanupModelPath(model);
        const part = `${dest}.part`;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        broadcast({ state: 'downloading', model, progress: 0, message: tMain('main.downloading') });
        const onProgress = (frac: number) =>
          broadcast({
            state: 'downloading',
            model,
            progress: Math.round(frac * 100),
            message: tMain('main.downloading'),
          });
        if (spec.url) await downloadFile(spec.url, part, onProgress);
        else await downloadWithMirrors(`${spec.repo}/resolve/main/${spec.file}`, part, onProgress);
        fs.renameSync(part, dest);
      }
      broadcast({ state: 'ready', model });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcast({ state: 'error', model, message: tMain('main.downloadFailed', { message }) });
      throw err;
    }
  })();

  const flight = activeDownload;
  flight
    .finally(() => {
      if (activeDownload === flight) activeDownload = null;
    })
    .catch(() => undefined);
  return flight;
}

export class LlamaCppServer {
  private child: ChildProcess | null = null;
  private model: CleanupModelId | null = null;
  private device: CleanupDevice = 'gpu';
  private starting: Promise<void> | null = null;
  private logLines: string[] = [];
  private idleTimer: NodeJS.Timeout | null = null;

  get url(): string {
    return `http://127.0.0.1:${PORT}`;
  }

  /** True when the warm server runs this model (and, if given, on this device). */
  isRunningFor(model: CleanupModelId, device?: CleanupDevice): boolean {
    return !!this.child && this.model === model && (!device || this.device === device);
  }

  /** Spawns (or reuses) the warm server; resolves to its /v1 base URL. */
  async ensureReady(model: CleanupModelId, device: CleanupDevice = 'gpu'): Promise<string> {
    const runtime = llamaRuntime();
    if (!runtime) throw new Error(tMain('cleanup.noEngine'));
    if (!this.isRunningFor(model, device)) {
      if (!this.starting) {
        this.starting = this.spawnAndWait(runtime.exe, runtime.backend, model, device).finally(() => {
          this.starting = null;
        });
      }
      await this.starting;
    } else {
      await this.waitHealthy();
    }
    return `${this.url}/v1`;
  }

  /** (Re)arms the idle unload timer; 0 minutes keeps the model loaded. */
  touch(idleMinutes: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (idleMinutes > 0) {
      this.idleTimer = setTimeout(() => this.stop(), idleMinutes * 60_000);
    }
  }

  private async spawnAndWait(
    exe: string,
    backend: GpuBackend,
    model: CleanupModelId,
    device: CleanupDevice,
  ): Promise<void> {
    this.stop();
    const modelPath = cleanupModelPath(model);
    if (!fs.existsSync(modelPath)) throw new Error(`Model file missing: ${modelPath}`);
    const cpu = device === 'cpu';
    const args = [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(PORT),
      // GPU: every layer on the card. CPU: '-dev none' keeps llama.cpp off
      // the graphics card completely (no VRAM, no GPU work for games/editors).
      ...(cpu ? ['-dev', 'none', '-ngl', '0'] : ['-ngl', '999']),
      '-c', String(CTX_SIZE),
      '-np', '1',
      // GPU: the CPU only feeds the card, so 4 threads are as fast as all
      // cores. CPU: the math runs on the threads; half the cores keeps the
      // rest of the PC responsive.
      '-t', String(cpu ? Math.max(2, Math.floor(os.cpus().length / 2)) : 4),
      '-fa', 'on',
      '--reasoning', 'off', // Qwen3.5 would otherwise "think" first
      '--cache-ram', '0',
      '--no-webui',
    ];
    // Vulkan sees integrated GPUs too and would split the model across all of
    // them (~40% slower here). Keep it on device 0: the Windows Vulkan loader
    // lists the high-performance GPU first.
    if (backend === 'vulkan' && !cpu) args.push('-sm', 'none', '-mg', '0');
    const child = spawn(exe, args, {
      cwd: path.dirname(exe),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runInBackground(child);
    this.child = child;
    this.model = model;
    this.device = device;
    this.logLines = [];
    const onData = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logLines.push(line);
        if (this.logLines.length > 200) this.logLines.shift();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.model = null;
      }
    });
    try {
      await this.waitHealthy();
    } catch (err) {
      const tail = this.logLines.slice(-8).join(' | ');
      this.stop();
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`llama-server failed to start: ${message}${tail ? ` — ${tail}` : ''}`);
    }
  }

  private async waitHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    for (;;) {
      if (!this.child) throw new Error('server process exited');
      try {
        // 503 while the model is still loading, 200 once ready
        const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error('health check timed out');
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    this.child = null;
    this.model = null;
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}
