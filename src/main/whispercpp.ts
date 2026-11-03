// whisper.cpp CUDA server lifecycle. ggml-* models bypass the transformers.js
// pipeline: a native whisper-server.exe (ggml CUDA build) is spawned once per
// model, kept warm, and the engine renderer POSTs 16 kHz WAV chunks to its
// /inference endpoint. ~10-30x realtime on an RTX-class GPU vs ~1x for the
// WebGPU path.
import { app } from 'electron';
import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WHISPER_MODELS, WhisperModelId } from '../shared/ipc';
import { modelDir } from './models';

const PORT = 17895;
const HEALTH_TIMEOUT_MS = 60_000; // first CUDA init + model mmap can be slow

function binDirCandidates(): string[] {
  const dirs = [path.join(app.getPath('userData'), 'whispercpp', 'bin', 'Release')];
  // dev-profile runs use a different userData; fall back to the real one
  const prod = path.join(app.getPath('appData'), 'mindscript', 'whispercpp', 'bin', 'Release');
  if (!dirs.includes(prod)) dirs.push(prod);
  return dirs;
}

export function cppServerExe(): string | null {
  for (const dir of binDirCandidates()) {
    const exe = path.join(dir, 'whisper-server.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

export function cppModelPath(model: WhisperModelId): string {
  const file = WHISPER_MODELS[model].file;
  if (!file) throw new Error(`not a ggml model: ${model}`);
  return path.join(modelDir(model), file);
}

export class WhisperCppServer {
  private child: ChildProcess | null = null;
  private model: WhisperModelId | null = null;
  private starting: Promise<void> | null = null;
  private logLines: string[] = [];

  get url(): string {
    return `http://127.0.0.1:${PORT}`;
  }

  isRunningFor(model: WhisperModelId): boolean {
    return !!this.child && this.model === model;
  }

  /** Spawns (or reuses) the warm server for the given model. */
  async ensureReady(model: WhisperModelId): Promise<string> {
    const exe = cppServerExe();
    if (!exe) {
      throw new Error('whisper.cpp server not found (userData/whispercpp).');
    }
    if (this.isRunningFor(model)) {
      await this.waitHealthy();
      return this.url;
    }
    if (!this.starting) {
      this.starting = this.spawnAndWait(exe, model).finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
    return this.url;
  }

  private async spawnAndWait(exe: string, model: WhisperModelId): Promise<void> {
    this.stop();
    const modelPath = cppModelPath(model);
    if (!fs.existsSync(modelPath)) {
      throw new Error(`model file missing: ${modelPath}`);
    }
    const child = spawn(
      exe,
      ['-m', modelPath, '--host', '127.0.0.1', '--port', String(PORT), '-t', '4'],
      { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;
    this.model = model;
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
      throw new Error(`whisper-server failed to start: ${message}${tail ? ` — ${tail}` : ''}`);
    }
  }

  private async waitHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    for (;;) {
      if (!this.child) throw new Error('server process exited');
      try {
        const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error('health check timed out');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  stop(): void {
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
