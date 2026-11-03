// Local transcription engine. A hidden, never-shown BrowserWindow hosts the
// vendored transformers.js bundle and runs Whisper (ONNX) fully on this
// machine. Main talks to it over IPC; model files are served from userData
// through the msres:// protocol so nothing is ever fetched from the network
// after the one-time model download.
import { app, BrowserWindow, ipcMain, net, protocol } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ModelStatus, WhisperModelId, isGgmlModel } from '../shared/ipc';
import { ensureModelDownloaded, isModelDownloaded, modelDir } from './models';
import { WhisperCppServer } from './whispercpp';
import { tMain } from './lang';

export function registerMsresScheme(): void {
  // must run before app ready
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'msres',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

export function handleMsresScheme(): void {
  // runs after app ready. Single origin, two path prefixes:
  //   msres://app/<path>          → the app's dist/ folder (engine page + vendor)
  //   msres://app/models/<path>   → userData/models (local Whisper weights)
  // Everything lives on one origin because Chromium does not support
  // cross-origin fetch for custom schemes at all (no ACAO can fix it).
  const distRoot = path.join(__dirname, '..');
  const modelsRoot = path.join(app.getPath('userData'), 'models');
  protocol.handle('msres', (request) => {
    const url = new URL(request.url);
    if (url.hostname.toLowerCase() !== 'app') {
      return new Response('Not found', { status: 404 });
    }
    const rel = url.pathname.replace(/^\/+/, '');
    let target: string;
    if (rel === 'models' || rel.startsWith('models/') || rel.startsWith('models\\')) {
      target = path.normalize(path.join(modelsRoot, rel.slice('models/'.length)));
      if (!target.startsWith(modelsRoot)) {
        return new Response('Forbidden', { status: 403 });
      }
    } else {
      target = path.normalize(path.join(distRoot, rel));
      if (!target.startsWith(distRoot)) {
        return new Response('Forbidden', { status: 403 });
      }
    }
    if (!fs.existsSync(target)) {
      console.log(`[msres] MISS ${rel}`);
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

interface EngineJob {
  id: number;
  model: WhisperModelId;
  language: string;
  data: Uint8Array;
  mime: string;
  /** Skip this many leading milliseconds of decoded PCM (incremental tail pass). */
  offsetMs?: number;
  /** whisper.cpp route: warm server URL the renderer should POST WAV chunks to. */
  serverUrl?: string;
}

interface EngineResultMsg {
  id: number;
  ok: boolean;
  text?: string;
  error?: string;
}

interface EngineStatusMsg extends ModelStatus {}

export class TranscriptionEngine {
  private win: BrowserWindow | null = null;
  private winReady: Promise<void> | null = null;
  private reqSeq = 0;
  private pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
  private loadedModel: WhisperModelId | null = null;
  private modelReady: Promise<void> | null = null;
  private listeners: ((status: ModelStatus) => void) | null = null;
  private cpp = new WhisperCppServer();

  /** Kills the warm whisper.cpp server (called on app quit). */
  dispose(): void {
    this.cpp.stop();
  }

  /**
   * Drops a model from the ready set. For ggml models the warm native server
   * is stopped too (its model file is usually being deleted right after).
   */
  unloadModel(model: WhisperModelId): void {
    this.loadedModels.delete(model);
    if (isGgmlModel(model) && this.cpp.isRunningFor(model)) {
      this.cpp.stop();
    }
  }

  onStatus(cb: (status: ModelStatus) => void): void {
    this.listeners = cb;
  }

  private emit(status: ModelStatus): void {
    this.listeners?.(status);
  }

  private createWindow(): BrowserWindow {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'engine.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    void win.loadURL('msres://app/renderer/engine/index.html');
    return win;
  }

  private ensureWindow(): Promise<void> {
    if (!this.win || this.win.isDestroyed()) {
      const win = this.createWindow();
      this.win = win;
      this.winReady = new Promise<void>((resolve) => {
        win.webContents.once('did-finish-load', () => resolve());
      });
      this.registerHandlers();
    }
    return this.winReady!;
  }

  private registerHandlers(): void {
    ipcMain.removeHandler('engine:result');
    ipcMain.removeAllListeners('engine:result');
    ipcMain.removeAllListeners('engine:status');
    ipcMain.on('engine:result', (_e, msg: EngineResultMsg) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.text ?? '');
      else p.reject(new Error(msg.error ?? 'Transcription failed'));
    });
    ipcMain.on('engine:status', (_e, msg: EngineStatusMsg) => {
      this.emit(msg);
      if (msg.state === 'ready') {
        this.loadedModels.add(msg.model as WhisperModelId);
        this.modelLoads.delete(msg.model as WhisperModelId);
        const settle = this.settlers.get(msg.model);
        if (settle) {
          this.settlers.delete(msg.model);
          settle.resolve();
        }
      } else if (msg.state === 'error') {
        const settle = this.settlers.get(msg.model);
        if (settle) {
          this.settlers.delete(msg.model);
          this.modelLoads.delete(msg.model as WhisperModelId);
          settle.reject(new Error(msg.message ?? tMain('main.modelLoadFailed')));
        }
      } else if (msg.state === 'idle' && this.pendingLoad) {
        // The engine page finished evaluating after our engine:load was sent
        // (the ESM bundle import can suspend module evaluation past
        // did-finish-load) — re-deliver.
        this.win?.webContents.send('engine:load', { model: this.pendingLoad });
      }
    });
  }

  /** Models whose pipelines are resident in the engine window. */
  private loadedModels = new Set<WhisperModelId>();
  private modelLoads = new Map<WhisperModelId, Promise<void>>();
  private settlers = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void }
  >();
  private pendingLoad: WhisperModelId | null = null;

  private async ensureModel(model: WhisperModelId): Promise<void> {
    if (isGgmlModel(model)) {
      // whisper.cpp route: the "pipeline" is the warm native CUDA server; the
      // engine window is only used to decode webm→PCM and POST WAV chunks.
      if (this.loadedModels.has(model) && this.cpp.isRunningFor(model)) return;
      if (!isModelDownloaded(model)) {
        throw new Error(tMain('main.modelMissing'));
      }
      let load = this.modelLoads.get(model);
      if (!load) {
        load = (async () => {
          this.emit({ state: 'loading', model, message: tMain('main.gpuStarting') });
          const url = await this.cpp.ensureReady(model);
          this.loadedModels.add(model);
          this.emit({ state: 'ready', model, message: tMain('main.modelReady') });
          await this.ensureWindow();
          this.win!.webContents.send('engine:load', { model, serverUrl: url });
        })();
        this.modelLoads.set(model, load);
        load.catch(() => this.modelLoads.delete(model));
      }
      await load;
      return;
    }
    if (this.loadedModels.has(model)) return;
    if (!isModelDownloaded(model)) {
      throw new Error(tMain('main.modelMissing'));
    }
    let load = this.modelLoads.get(model);
    if (!load) {
      load = new Promise<void>((resolve, reject) => {
        this.settlers.set(model, { resolve, reject });
      });
      this.modelLoads.set(model, load);
      await this.ensureWindow();
      this.pendingLoad = model;
      this.win!.webContents.send('engine:load', { model });
      this.emit({ state: 'loading', model, message: tMain('main.modelLoadingMem') });
    }
    await load;
    this.pendingLoad = null;
  }

  async isReady(model: WhisperModelId): Promise<boolean> {
    return this.loadedModels.has(model) || isModelDownloaded(model);
  }

  async transcribe(
    model: WhisperModelId,
    language: string,
    data: Buffer,
    mime: string,
    offsetMs?: number,
  ): Promise<string> {
    await this.ensureModel(model);
    const id = ++this.reqSeq;
    const job: EngineJob = {
      id,
      model,
      language,
      data: new Uint8Array(data),
      mime,
      offsetMs,
      serverUrl: isGgmlModel(model) ? this.cpp.url : undefined,
    };
    const promise = new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.win!.webContents.send('engine:job', job);
    try {
      return await promise;
    } finally {
      this.pending.delete(id);
    }
  }

  /** Warms the pipeline for the selected model without transcribing. */
  async warmup(model: WhisperModelId): Promise<void> {
    await this.ensureWindow();
    if (!isModelDownloaded(model)) return;
    if (this.loadedModels.has(model)) return;
    await this.ensureModel(model);
  }
}

export async function modelDirExists(model: WhisperModelId): Promise<boolean> {
  return fs.existsSync(modelDir(model));
}

export { ensureModelDownloaded, isModelDownloaded };
