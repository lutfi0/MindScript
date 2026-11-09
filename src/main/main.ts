// MindScript — talk, and MindScript types.
// Fully local voice dictation for Windows: global hotkey → overlay records →
// Whisper runs on this machine (never the cloud) → text is pasted into the
// focused app → kept in local history.
import { app, globalShortcut, ipcMain, clipboard, BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { CustomModel, DEFAULT_SETTINGS, parseModelLink, Channels, DICTATION_LANGUAGES, HOLD_TO_START_OPTIONS, CleanupModelId, HistoryEntry, ModelStatus, SaveResult, Settings, TestResult, WHISPER_MODELS, WhisperModelId, isCleanupModel, isGgmlModel } from '../shared/ipc';
import { HistoryStore, SettingsStore } from './store';
import { OverlayController } from './overlay';
import { MindScriptTray } from './tray';
import { openWindow, openSettingsPage, registerWindowControls } from './windows';
import { captureForegroundHwnd, pasteIntoActiveApp } from './paste';
import { polishText, testPolish } from './polish';
import { collapseRepeats } from './transcript';
import { KeyHoldWatcher } from './keyhold';
import { cleanupIds, cleanupSpec, setCustomModels, speechIds, speechSpec } from './catalog';
import { detectHardware } from './hardware';
import {
  LlamaCppServer,
  cleanupModelDir,
  cleanupModelSize,
  deleteCleanupModel,
  ensureCleanupModel,
  isCleanupModelDownloaded,
  llamaServerExe,
} from './llamacpp';
import { TranscribeTimeoutError, TranscriptionEngine, handleMsresScheme, registerMsresScheme } from './engine';
import { deleteModel, ensureModelDownloaded, isModelDownloaded, modelDir, modelDirSize } from './models';
import { setUpdateNotify, setupAutoUpdater } from './updater';
import { getMainLang, setMainLang, tMain } from './lang';
import { i18nPayload } from '../shared/i18n';

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';

const SMOKE = process.argv.includes('--smoke');
const ENGINE_TEST = process.argv.includes('--engine-test');
const POLISH_TEST = process.argv.find((a) => a.startsWith('--polish-test='))?.slice('--polish-test='.length) ?? null;

// Isolated profile for dev/test runs so they don't collide with an installed
// MindScript over the (case-insensitive, thus shared) userData folder and its
// single-instance lock.
if (process.argv.includes('--dev-profile')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'mindscript-dev'));
}

// Windows drops notifications (such as "update ready") from an app without an
// AppUserModelId; use the one the installer gives the Start menu shortcut.
app.setAppUserModelId('com.mindscript.app');

// Must run before app ready.
registerMsresScheme();

const settingsStore = new SettingsStore();
const historyStore = new HistoryStore();
const overlay = new OverlayController();
const engine = new TranscriptionEngine();
const llama = new LlamaCppServer();
let settings = settingsStore.load();
setCustomModels(settings.customModels);
let tray: MindScriptTray | null = null;
let phase: Phase = 'idle';
let hideTimer: NodeJS.Timeout | null = null;
let interimBusy = false;
// Incremental transcription checkpoint: latest full transcript of the
// audio-so-far and the recording timestamp it covers.
let incText = '';
let incAtMs = 0;
// Foreground window captured when dictation stops — the paste goes back
// there even if the user clicks elsewhere while transcribing.
let pasteTargetHwnd: string | null = null;

/** Collapses whisper.cpp's per-segment newlines and stray whitespace into
 *  normal flowing text before it is pasted/stored. */
function normalizeTranscript(t: string): string {
  return collapseRepeats(stripSubtitleHallucinations(t.replace(/\s+/g, ' ').trim()));
}

// Whisper was trained on film/TV subtitles, so on silence (usually the end of
// a recording) it "hears" the subtitle credits or a YouTube sign-off. Nobody
// dictates a subtitler's credit, so those go wherever they appear.
const SUBTITLE_CREDITS: RegExp[] = [
  /(?<!\p{L})altyaz[ıi](?:lar)?\s*:?\s*m\.?\s*k\.?/giu,
  /[^.!?…]*amara\.org[^.!?…]*[.!?…]*/giu,
  /(?<!\p{L})untertitel(?:ung)?\s+(?:im\s+auftrag\s+)?(?:des|der|von)\s+[^.!?…]{0,40}?(?:zdf|ard|swr|wdr|ndr|br|funk)(?!\p{L})[^.!?…]*[.!?…]*/giu,
  /(?<!\p{L})sous-titrage\s+st'?\s*\d+[.!?…]*/giu,
  /(?<!\p{L})субтитры\s+(?:сделал|создавал|подогнал|подготовил)[а-яё]*\s+[^.!?…]{0,40}[.!?…]*/giu,
  /(?<!\p{L})редактор\s+субтитров\s+[^.!?…]{0,60}(?:корректор\s+[^.!?…]{0,30})?[.!?…]*/giu,
];
// Sign-offs could be said on purpose, so they're only dropped as the last
// sentence (where the silence hallucination lands).
const TRAILING_SIGNOFF =
  /(?:^|(?<=[.!?…])\s*)(?:[iİ]zlediğiniz\s+[iİ]çin\s+teşekkür(?:ler|\s+ederim)|abone\s+olmayı\s+unutmayın|thank(?:s|\s+you)\s+(?:so\s+much\s+)?for\s+watching|please\s+subscribe|vielen\s+dank\s+(?:fürs|für\s+das|für's)\s+zuschauen|merci\s+d'avoir\s+regardé|¡?gracias\s+por\s+ver(?:\s+el\s+video)?|спасибо\s+за\s+просмотр|продолжение\s+следует)[\s.!?…]*$/iu;

function stripSubtitleHallucinations(text: string): string {
  let out = text;
  for (const re of SUBTITLE_CREDITS) out = out.replace(re, ' ');
  for (let i = 0; i < 3; i++) {
    const next = out.trim().replace(TRAILING_SIGNOFF, '');
    if (next === out.trim()) break;
    out = next;
  }
  return out.replace(/\s+([.,!?…])/g, '$1').replace(/\s+/g, ' ').trim();
}

/** Joins the checkpoint transcript with the tail pass, dropping words that
 *  were transcribed twice in the 1s overlap region. */
function mergeTranscripts(base: string, tail: string): string {
  const a = base.trim();
  const b = tail.trim();
  if (!a) return b;
  if (!b) return a;
  const norm = (w: string) => w.toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}]+/gu, '');
  const aw = a.split(/\s+/);
  const bw = b.split(/\s+/);
  const maxK = Math.min(10, aw.length, bw.length);
  for (let k = maxK; k >= 1; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (norm(aw[aw.length - k + i]) !== norm(bw[i])) {
        match = false;
        break;
      }
    }
    if (match) {
      const rest = bw.slice(k).join(' ');
      return rest ? `${a} ${rest}` : a;
    }
  }
  return `${a} ${b}`;
}

engine.onStatus((status) => {
  // surface model lifecycle to every window (settings shows a progress bar)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(Channels.modelStatus, status);
  }
  if (status.state === 'ready' || status.state === 'error') {
    diag('engine-status', `${status.state} ${status.model} ${status.message ?? ''}`);
  }
});

// Lightweight diagnostics for field debugging: appends timestamped lines to
// <userData>/diag.log so we can trace hotkey → overlay → mic → transcription.
import * as fs from 'node:fs';
function diag(event: string, detail = ''): void {
  try {
    const line = `${new Date().toISOString()} ${event}${detail ? ' ' + detail : ''}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'diag.log'), line);
  } catch {
    /* never break the app for logging */
  }
}

/**
 * How long a whisper.cpp pass may take before we give up on it. The GPU
 * normally runs ~10-30x realtime, so half the audio length plus 30s is
 * generous; only a graphics card kept busy by another app gets near it.
 */
function transcribeTimeoutMs(audioMs: number): number {
  return 30_000 + Math.max(0, audioMs) / 2;
}

/**
 * Stops whisper-server / llama-server processes left from an earlier run
 * (crash, killed from Task Manager). A leftover holds the engine's port, so a
 * new server can't bind and requests would reach the old, possibly stuck one.
 * Only engines started from MindScript's own folders are touched; the
 * single-instance lock guarantees no other MindScript owns them.
 */
function stopStaleEngines(): Promise<void> {
  const roots = [app.getPath('userData'), path.join(app.getPath('appData'), 'mindscript')];
  const list = roots.map((r) => `'${r.replace(/'/g, "''")}'`).join(',');
  const script =
    `$roots = @(${list}); ` +
    `Get-CimInstance Win32_Process -Filter "Name='whisper-server.exe' OR Name='llama-server.exe'" | ` +
    `Where-Object { $p = $_.ExecutablePath; $p -and ($roots | Where-Object { $p.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }) } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.Name + ' ' + $_.ProcessId }`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 10_000 },
      (_err, stdout) => {
        const stopped = stdout.trim().split(/\r?\n/).filter(Boolean);
        if (stopped.length) diag('stale-engines-stopped', stopped.join(', '));
        resolve();
      },
    );
  });
}

function builtinCleanupActive(): boolean {
  return (
    settings.polish.enabled &&
    settings.polish.engine === 'builtin' &&
    isCleanupModelDownloaded(settings.polish.localModel) &&
    !!llamaServerExe()
  );
}

/** Loads the built-in cleanup model while the user is still speaking, so
 *  it is warm by the time the transcript is ready. */
function prewarmCleanup(): void {
  if (!builtinCleanupActive()) return;
  const { localModel, idleUnloadMin } = settings.polish;
  void llama
    .ensureReady(localModel)
    .then(() => llama.touch(idleUnloadMin))
    .catch((err) => diag('cleanup-prewarm-failed', err instanceof Error ? err.message : String(err)));
}

/** Cleanup pass; any failure keeps the raw transcript. */
async function runPolish(text: string): Promise<string> {
  const p = settings.polish;
  const kept = (reason: string) => diag('polish-kept-raw', reason.slice(0, 300));
  if (p.engine === 'ollama') {
    return polishText(text, { baseUrl: p.baseUrl, model: p.model }, kept);
  }
  if (!builtinCleanupActive()) {
    kept('built-in cleanup model not downloaded');
    return text;
  }
  try {
    const baseUrl = await llama.ensureReady(p.localModel);
    return await polishText(text, { baseUrl, model: p.localModel }, kept);
  } catch (err) {
    kept(err instanceof Error ? err.message : String(err));
    return text;
  } finally {
    llama.touch(p.idleUnloadMin);
  }
}

function scheduleHideOverlay(delay: number): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    overlay.hide();
  }, delay);
}

function setPhase(next: Phase): void {
  phase = next;
  if (next === 'idle') {
    stopWhenStarted = false;
    keyHold.recordingEnded();
  }
  tray?.rebuild(next === 'recording' || next === 'starting', settings.launchOnStartup);
}

// Hold-to-start mode: the hotkey is watched (not swallowed) so a short press
// keeps its normal meaning; see keyhold.ts.
const keyHold = new KeyHoldWatcher({
  canStart: () => phase === 'idle',
  isRecording: () => phase === 'starting' || phase === 'recording',
  start: () => {
    diag('hotkey-hold', `phase=${phase}`);
    startDictation();
  },
  stop: () => {
    diag('hotkey-release', `phase=${phase}`);
    if (phase === 'recording') stopDictation();
    else if (phase === 'starting') stopWhenStarted = true;
  },
  log: (event, detail) => diag(event, detail),
});

/** push-to-talk released before the mic was up: stop as soon as it is */
let stopWhenStarted = false;

function registerHotkeys(): boolean {
  globalShortcut.unregisterAll();
  if (settings.holdToStartMs > 0 && keyHold.configure(settings.hotkey, settings.holdToStartMs)) {
    return true;
  }
  keyHold.configure(settings.hotkey, 0);
  return globalShortcut.register(settings.hotkey, onHotkey);
}

let lastHotkeyAt = 0;

function onHotkey(): void {
  // Phantom/repeat guard: some keyboards (and remapping tools) deliver the
  // accelerator twice within a few ms of one physical press. Without this,
  // one press can toggle start→stop instantly.
  const now = Date.now();
  if (now - lastHotkeyAt < 400) {
    diag('hotkey-debounced', `phase=${phase}`);
    return;
  }
  lastHotkeyAt = now;
  diag('hotkey', `phase=${phase}`);
  switch (phase) {
    case 'idle':
      startDictation();
      break;
    case 'recording':
      stopDictation();
      break;
    // 'starting' / 'transcribing': ignore, prevents double-fire mid-transition
  }
}

let startingWatchdog: NodeJS.Timeout | null = null;

function startDictation(): void {
  if (!isModelDownloaded(settings.engine.model)) {
    // nothing to transcribe with yet: point to the onboarding page instead
    overlay.show(settings.overlayPosition);
    overlay.sendState({ phase: 'error', message: tMain('main.modelMissing') });
    scheduleHideOverlay(3200);
    openSettingsPage('baslangic');
    return;
  }
  setPhase('starting');
  incText = '';
  incAtMs = 0;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  // Backstop: if the overlay never reports recording (mic hang, renderer
  // crash…), don't leave the phase machine stuck — every further hotkey
  // press would be silently ignored otherwise.
  if (startingWatchdog) clearTimeout(startingWatchdog);
  startingWatchdog = setTimeout(() => {
    startingWatchdog = null;
    if (phase === 'starting') {
      diag('starting-timeout');
      overlay.sendCommand({ type: 'cancel' });
      overlay.sendState({
        phase: 'error',
        message: tMain('main.micStuck'),
      });
      scheduleHideOverlay(3200);
      if (settings.cancelKey) globalShortcut.unregister(settings.cancelKey);
      setPhase('idle');
    }
  }, 9000);
  prewarmCleanup();
  overlay.show(settings.overlayPosition);
  overlay.sendState({ phase: 'idle' });
  overlay.sendCommand({ type: 'start' });
  if (settings.cancelKey) {
    globalShortcut.register(settings.cancelKey, cancelDictation);
  }
}

function stopDictation(): void {
  if (settings.cancelKey) globalShortcut.unregister(settings.cancelKey);
  // Lock the paste target: the window in focus at stop time is where the
  // user was dictating. Transcription is fast but not instant — if they
  // click elsewhere meanwhile, we still paste back here.
  void captureForegroundHwnd().then((h) => {
    pasteTargetHwnd = h;
  });
  overlay.sendCommand({ type: 'stop' });
}

function cancelDictation(): void {
  if (settings.cancelKey) globalShortcut.unregister(settings.cancelKey);
  incText = '';
  incAtMs = 0;
  pasteTargetHwnd = null;
  overlay.sendCommand({ type: 'cancel' });
  setPhase('idle');
}

async function handleAudio(buf: Buffer, mime: string, durationMs: number): Promise<void> {
  setPhase('transcribing');
  overlay.sendState({ phase: 'transcribing' });

  if (!isModelDownloaded(settings.engine.model)) {
    overlay.sendState({
      phase: 'error',
      message: tMain('main.modelMissing'),
    });
    scheduleHideOverlay(3200);
    setPhase('idle');
    openSettingsPage('baslangic');
    return;
  }

  // Grab and reset the incremental checkpoint before any awaits, so a new
  // dictation can't observe stale state.
  const checkpointText = incText;
  const checkpointAtMs = incAtMs;
  incText = '';
  incAtMs = 0;

  const fullPass = () =>
    engine.transcribe(settings.engine.model, settings.engine.language, buf, mime, undefined, transcribeTimeoutMs(durationMs));

  let text: string;
  try {
    const tailMs = durationMs - checkpointAtMs;
    // Always transcribe the tail, however short: skipping it dropped the
    // last words spoken right before the stop key.
    if (checkpointText) {
      // Transcribe only the tail since the checkpoint (with 1s overlap) and merge.
      try {
        const tail = await engine.transcribe(
          settings.engine.model,
          settings.engine.language,
          buf,
          mime,
          Math.max(0, checkpointAtMs - 1000),
          transcribeTimeoutMs(tailMs),
        );
        text = mergeTranscripts(checkpointText, tail);
        diag('incremental-tail', `tail=${Math.round(tailMs)}ms merged`);
      } catch (err) {
        // a full pass would only take longer than the tail that timed out
        if (err instanceof TranscribeTimeoutError) throw err;
        diag('transcribe-error', `tail: ${err instanceof Error ? err.message : String(err)}`);
        text = await fullPass();
      }
    } else {
      text = await fullPass();
    }
    text = normalizeTranscript(text);
    if (settings.polish.enabled) {
      overlay.sendState({ phase: 'transcribing', message: tMain('main.polishing') });
      const t0 = Date.now();
      const raw = text;
      text = await runPolish(text);
      diag('polish', `${settings.polish.engine} ${Date.now() - t0}ms changed=${text !== raw}`);
    }
  } catch (err) {
    const timedOut = err instanceof TranscribeTimeoutError;
    const message = timedOut ? tMain('main.transcribeTimeout') : err instanceof Error ? err.message : String(err);
    diag('transcribe-error', `${timedOut ? 'timeout' : 'failed'} audio=${Math.round(durationMs)}ms ${err instanceof Error ? err.message : String(err)}`);
    overlay.sendState({ phase: 'error', message });
    scheduleHideOverlay(timedOut ? 8000 : 3200);
    setPhase('idle');
    return;
  }

  if (!text) {
    overlay.sendState({ phase: 'error', message: tMain('main.noSpeech') });
    scheduleHideOverlay(1800);
    setPhase('idle');
    return;
  }

  const entry: HistoryEntry = {
    id: randomUUID(),
    ts: Date.now(),
    durationMs,
    chars: text.length,
    text,
  };
  historyStore.add(entry);

  if (settings.pasteMode === 'clipboard-paste') {
    const target = pasteTargetHwnd;
    pasteTargetHwnd = null;
    try {
      await pasteIntoActiveApp(text, target);
      overlay.sendState({ phase: 'done' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      overlay.sendState({ phase: 'error', message: tMain('main.pasteFailed', { message }) });
      scheduleHideOverlay(2600);
      setPhase('idle');
      return;
    }
  } else {
    clipboard.writeText(text);
    overlay.sendState({ phase: 'done', message: tMain('main.copied') });
  }
  scheduleHideOverlay(700);
  setPhase('idle');
}

function applySettings(next: Settings): SaveResult {
  const prevHotkey = settings.hotkey;
  const prevHold = settings.holdToStartMs;
  const engineChanged = next.engine.model !== settings.engine.model;
  const prevPolish = settings.polish;
  settings = next;
  setCustomModels(next.customModels);
  settingsStore.save(next);
  const prevLang = getMainLang();
  if (setMainLang(next.uiLanguage, app.getLocale()) !== prevLang) {
    const payload = i18nPayload(getMainLang());
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('i18n:changed', payload);
    }
  }
  app.setLoginItemSettings({
    openAtLogin: next.launchOnStartup,
    args: ['--hidden'],
  });
  setUpdateNotify(next.updateNotify);
  tray?.setHotkeyLabel(next.hotkey);
  tray?.rebuild(false, next.launchOnStartup);
  if (prevHotkey !== next.hotkey || prevHold !== next.holdToStartMs) {
    const ok = registerHotkeys();
    if (!ok) {
      // fall back to the previous accelerator so the app stays usable
      settings = { ...next, hotkey: prevHotkey };
      registerHotkeys();
      return {
        ok: false,
        hotkeyRegistered: false,
        message: tMain('main.hotkeyFailed', { hotkey: next.hotkey, prev: prevHotkey }),
      };
    }
  }
  const np = next.polish;
  if (!np.enabled || np.engine !== 'builtin' || np.localModel !== prevPolish.localModel) {
    // free the VRAM right away; the next dictation reloads what it needs
    llama.stop();
  } else if (np.idleUnloadMin !== prevPolish.idleUnloadMin && llama.isRunningFor(np.localModel)) {
    llama.touch(np.idleUnloadMin);
  }
  if (engineChanged) {
    // next dictation picks it up; warm the new pipeline in the background
    void engine.warmup(next.engine.model).catch(() => undefined);
  }
  return { ok: true, hotkeyRegistered: true };
}

function registerIpc(): void {
  registerWindowControls();
  ipcMain.on(Channels.overlayStarted, () => {
    diag('overlay-started');
    if (startingWatchdog) {
      clearTimeout(startingWatchdog);
      startingWatchdog = null;
    }
    setPhase('recording');
    if (stopWhenStarted) {
      stopWhenStarted = false;
      stopDictation();
    }
  });

  ipcMain.on(Channels.overlayFailed, (_e, message: string) => {
    diag('overlay-failed', message);
    overlay.sendState({ phase: 'error', message: message || tMain('main.micFailed') });
    scheduleHideOverlay(2400);
    if (settings.cancelKey) globalShortcut.unregister(settings.cancelKey);
    setPhase('idle');
  });

  ipcMain.on(Channels.overlayCancelled, () => {
    if (settings.cancelKey) globalShortcut.unregister(settings.cancelKey);
    overlay.hide();
    setPhase('idle');
  });

  ipcMain.on(
    Channels.overlayAudio,
    (_e, payload: Uint8Array | ArrayBuffer, mime: string, durationMs: number) => {
      const buf = Buffer.from(payload as Uint8Array);
      diag('overlay-audio', `${buf.length}B ${mime} ${Math.round(durationMs)}ms`);
      void handleAudio(buf, mime || 'audio/webm', durationMs || 0);
    },
  );

  // Incremental chunked pass: while still recording, the overlay ships the
  // audio-so-far every ~2.5s; every ~5s we transcribe ONLY the segment since
  // the last checkpoint (engine slices the decoded PCM at offsetMs) and roll
  // it into the running transcript — constant cost per pass no matter how
  // long the dictation runs. At stop time only the short tail since the last
  // checkpoint needs transcribing, so the result lands almost immediately
  // (streaming-style latency). One pass in flight at a time — extra ticks
  // are simply dropped.
  ipcMain.on(
    Channels.overlayInterim,
    (_e, payload: Uint8Array | ArrayBuffer, mime: string, durationMs: number) => {
      if (phase !== 'recording' || interimBusy) return;
      const model = settings.engine.model;
      if (!isModelDownloaded(model)) return;
      const elapsed = typeof durationMs === 'number' ? durationMs : 0;
      // First pass once ~5s of speech exists, then roughly every 8s — the
      // WebGPU pipeline costs ~1x its audio length per pass, so a tighter
      // cadence would just queue passes behind each other. The whisper.cpp
      // CUDA route decodes at ~10-30x realtime, so it can afford a ~3s
      // cadence: the final tail at stop time stays tiny.
      const fast = isGgmlModel(model);
      const gap = fast ? 3000 : incAtMs === 0 ? 5000 : 8000;
      if (elapsed - incAtMs < gap) return;
      interimBusy = true;
      const buf = Buffer.from(payload as Uint8Array);
      // 800ms overlap into the previous segment; mergeTranscripts dedupes
      // the words that appear in both.
      const offsetMs = incAtMs > 0 ? Math.max(0, incAtMs - 800) : undefined;
      const checkpointBefore = incAtMs;
      void engine
        .transcribe(
          model,
          settings.engine.language,
          buf,
          mime || 'audio/webm',
          offsetMs,
          transcribeTimeoutMs(elapsed - (offsetMs ?? 0)),
        )
        .then((segment) => {
          if (phase !== 'recording') return;
          if (segment) {
            incText = mergeTranscripts(incText, normalizeTranscript(segment));
            if (settings.liveDrafts) overlay.sendPartial(incText);
            diag('incremental-segment', `${Math.round(checkpointBefore)}→${Math.round(elapsed)}ms "${segment.slice(0, 60)}"`);
          } else {
            diag('incremental-segment', `${Math.round(checkpointBefore)}→${Math.round(elapsed)}ms (empty)`);
          }
          // Advance the checkpoint even on empty segments (silence) so the
          // final tail stays short.
          incAtMs = elapsed;
        })
        .catch((err) => diag('transcribe-error', `live draft: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          interimBusy = false;
        });
    },
  );

  ipcMain.handle(Channels.settingsGet, () => settings);
  ipcMain.handle('app:locale', () => app.getLocale());
  ipcMain.handle('i18n:get', () => i18nPayload(getMainLang()));

  ipcMain.handle(Channels.settingsSave, (_e, partial: Partial<Settings>): SaveResult => {
    const next: Settings = {
      engine: { ...settings.engine, ...(partial.engine ?? {}) },
      polish: { ...settings.polish, ...(partial.polish ?? {}) },
      hotkey: typeof partial.hotkey === 'string' && partial.hotkey ? partial.hotkey : settings.hotkey,
      holdToStartMs:
        typeof partial.holdToStartMs === 'number' &&
        (HOLD_TO_START_OPTIONS as readonly number[]).includes(partial.holdToStartMs)
          ? partial.holdToStartMs
          : settings.holdToStartMs,
      cancelKey:
        typeof partial.cancelKey === 'string' && partial.cancelKey
          ? partial.cancelKey
          : settings.cancelKey,
      pasteMode: partial.pasteMode ?? settings.pasteMode,
      overlayPosition: partial.overlayPosition ?? settings.overlayPosition,
      launchOnStartup: partial.launchOnStartup ?? settings.launchOnStartup,
      liveDrafts: partial.liveDrafts ?? settings.liveDrafts,
      uiLanguage: typeof partial.uiLanguage === 'string' ? partial.uiLanguage : settings.uiLanguage,
      updateNotify: typeof partial.updateNotify === 'boolean' ? partial.updateNotify : settings.updateNotify,
      // custom models change only through model:add-custom / the delete handlers
      customModels: settings.customModels,
    };
    return applySettings(next);
  });

  ipcMain.handle(Channels.testPolish, (_e, polish: Settings['polish']): Promise<TestResult> =>
    testPolish(polish),
  );

  // Kicks off the one-time local model download; progress arrives via model:status.
  ipcMain.handle(Channels.modelEnsure, (_e, model: Settings['engine']['model']) => {
    if (!speechSpec(model)) {
      return { started: false as const };
    }
    void ensureModelDownloaded(model)
      .then(() => engine.warmup(model))
      .catch(() => undefined);
    return { started: true as const };
  });

  // Model catalogue for the settings UI: metadata + on-disk location + state.
  ipcMain.handle(Channels.modelState, () =>
    Object.fromEntries(
      speechIds().map((id) => [
        id,
        {
          ...speechSpec(id)!,
          dir: modelDir(id),
          downloaded: isModelDownloaded(id),
          sizeOnDisk: modelDirSize(id),
        },
      ]),
    ),
  );

  // Permanently deletes a downloaded model from disk. If the deleted model
  // was the active one, falls back to another downloaded model so dictation
  // keeps working.
  ipcMain.handle(Channels.modelDelete, (_e, model: Settings['engine']['model']) => {
    const spec = speechSpec(model);
    if (!spec) return { ok: false as const };
    engine.unloadModel(model);
    try {
      deleteModel(model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, message: tMain('main.deleteFailed', { message }) };
    }
    diag('model-deleted', model);
    let next = settings;
    // a deleted custom model leaves the list entirely
    if (spec.custom) next = { ...next, customModels: next.customModels.filter((m) => m.id !== model) };
    if (settings.engine.model === model) {
      const fallback = speechIds().find((id) => id !== model && isModelDownloaded(id));
      next = { ...next, engine: { ...next.engine, model: fallback ?? DEFAULT_SETTINGS.engine.model } };
    }
    if (next !== settings) applySettings(next);
    return { ok: true as const, settings };
  });

  // Built-in cleanup models (llama.cpp): catalogue, download, delete.
  ipcMain.handle(Channels.cleanupState, () =>
    Object.fromEntries(
      cleanupIds().map((id) => [
        id,
        {
          ...cleanupSpec(id)!,
          dir: cleanupModelDir(id),
          downloaded: isCleanupModelDownloaded(id) && !!llamaServerExe(),
          sizeOnDisk: cleanupModelSize(id),
        },
      ]),
    ),
  );

  ipcMain.handle(Channels.cleanupEnsure, (_e, model: CleanupModelId) => {
    if (!cleanupSpec(model)) return { started: false as const };
    void ensureCleanupModel(model)
      .then(() => {
        if (settings.polish.localModel === model) prewarmCleanup();
      })
      .catch((err) => diag('cleanup-download-failed', err instanceof Error ? err.message : String(err)));
    return { started: true as const };
  });

  ipcMain.handle(Channels.cleanupDelete, (_e, model: CleanupModelId) => {
    const spec = cleanupSpec(model);
    if (!spec) return { ok: false as const };
    if (llama.isRunningFor(model)) llama.stop();
    try {
      deleteCleanupModel(model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, message: tMain('main.deleteFailed', { message }) };
    }
    diag('cleanup-model-deleted', model);
    let next = settings;
    if (spec.custom) next = { ...next, customModels: next.customModels.filter((m) => m.id !== model) };
    if (settings.polish.localModel === model) {
      const fallback = cleanupIds().find((id) => id !== model && isCleanupModelDownloaded(id));
      next = { ...next, polish: { ...next.polish, localModel: fallback ?? DEFAULT_SETTINGS.polish.localModel } };
    }
    if (next !== settings) applySettings(next);
    return { ok: true as const, settings };
  });

  // Adds a third-party model from a download link and starts downloading it.
  ipcMain.handle(
    Channels.modelAddCustom,
    async (_e, kind: CustomModel['kind'], link: string, name: string): Promise<{ ok: boolean; id?: string; message?: string }> => {
      const parsed = parseModelLink(link, kind);
      if (!parsed) return { ok: false, message: tMain(kind === 'speech' ? 'custom.badLinkSpeech' : 'custom.badLinkCleanup') };
      if (settings.customModels.some((m) => m.url === parsed.url)) {
        return { ok: false, message: tMain('custom.exists') };
      }
      let size: number | undefined;
      try {
        // reachability check; also gives the size to show before downloading
        const res = await fetch(parsed.url, { method: 'HEAD', redirect: 'follow' });
        if (!res.ok) return { ok: false, message: tMain('custom.unreachable', { status: res.status }) };
        size = Number(res.headers.get('content-length')) || undefined;
      } catch (err) {
        return { ok: false, message: tMain('custom.unreachable', { status: err instanceof Error ? err.message : String(err) }) };
      }
      const slug = parsed.file.replace(/\.(bin|gguf)$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const id = `${kind === 'speech' ? 'ggml' : 'gguf'}-custom-${slug}-${randomUUID().slice(0, 6)}`;
      const entry: CustomModel = {
        id,
        kind,
        label: name.trim().slice(0, 60) || parsed.file,
        url: parsed.url,
        file: parsed.file,
        size,
      };
      applySettings({ ...settings, customModels: [...settings.customModels, entry] });
      diag('custom-model-added', `${kind} ${parsed.url}`);
      if (kind === 'speech') {
        void ensureModelDownloaded(id as WhisperModelId)
          .then(() => engine.warmup(id as WhisperModelId))
          .catch(() => undefined);
      } else {
        void ensureCleanupModel(id as CleanupModelId).catch((err) =>
          diag('cleanup-download-failed', err instanceof Error ? err.message : String(err)),
        );
      }
      return { ok: true, id };
    },
  );

  ipcMain.handle(Channels.systemHardware, () => detectHardware());

  ipcMain.handle(Channels.historyList, () => historyStore.list());
  ipcMain.handle(Channels.historyDelete, (_e, id: string) => historyStore.remove(id));
  ipcMain.handle(Channels.historyClear, () => historyStore.clear());
  ipcMain.handle(Channels.historyRepaste, (_e, text: string) => pasteIntoActiveApp(text));
}

void app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // A dev-profile run sits beside the installed app; its engines aren't stale.
  if (!process.argv.includes('--dev-profile')) await stopStaleEngines();

  handleMsresScheme();
  registerIpc();
  setupAutoUpdater(diag, settings.updateNotify);
  setMainLang(settings.uiLanguage, app.getLocale());
  if (!settingsStore.exists()) {
    // first run: dictate in the OS language when we offer it
    const osLang = app.getLocale().slice(0, 2).toLowerCase();
    if ((DICTATION_LANGUAGES as readonly string[]).includes(osLang)) {
      settings = { ...settings, engine: { ...settings.engine, language: osLang } };
    }
    settingsStore.save(settings);
  }

  tray = new MindScriptTray({
    onToggle: onHotkey,
    onSettings: () => openWindow('settings'),
    onHistory: () => openSettingsPage('gecmis'),
    onQuit: () => app.quit(),
    onStartupToggle: (enabled) => applySettings({ ...settings, launchOnStartup: enabled }),
  });
  tray.setHotkeyLabel(settings.hotkey);
  tray.rebuild(false, settings.launchOnStartup);

  const hotkeyOk = registerHotkeys();
  console.log(
    `[mindscript] hotkey ${settings.hotkey} ${hotkeyOk ? 'registered' : 'FAILED to register'}`,
  );
  diag('app-ready', `hotkey=${settings.hotkey} registered=${hotkeyOk} model=${settings.engine.model}`);

  app.on('second-instance', () => openWindow('settings'));

  if (SMOKE) {
    // Headless verification path: everything wired above, nothing shown,
    // no model download, no engine window.
    setTimeout(() => {
      console.log('SMOKE OK');
      app.exit(0);
    }, 1200);
    return;
  }

  if (POLISH_TEST !== null) {
    // Built-in cleanup verification: --polish-test="raw text"
    // [--polish-test-model=<id>] downloads runtime + model if needed,
    // starts llama-server and prints the cleaned text.
    const modelArg = process.argv.find((a) => a.startsWith('--polish-test-model='))?.split('=')[1];
    const model: CleanupModelId = modelArg && isCleanupModel(modelArg) ? modelArg : 'qwen3.5-2b-q4';
    try {
      await ensureCleanupModel(model);
      settings = { ...settings, polish: { ...settings.polish, enabled: true, engine: 'builtin', localModel: model } };
      const t0 = Date.now();
      const out = await runPolish(POLISH_TEST);
      console.log(`POLISH (${Date.now() - t0}ms): ${JSON.stringify(out)}`);
      const t1 = Date.now();
      const again = await runPolish(POLISH_TEST);
      console.log(`POLISH warm (${Date.now() - t1}ms): ${JSON.stringify(again)}`);
      llama.stop();
      app.exit(0);
    } catch (err) {
      console.error('POLISH TEST FAILED:', err instanceof Error ? err.message : err);
      llama.stop();
      app.exit(1);
    }
    return;
  }

  if (ENGINE_TEST) {
    // Full local-pipeline verification: one-time model download →
    // msres:// protocol → transformers.js pipeline warm-up (+ optional
    // transcription of --engine-test-file=<audio>).
    const audioArg = process.argv.find((a) => a.startsWith('--engine-test-file='));
    const audioFile = audioArg ? audioArg.slice('--engine-test-file='.length) : '';
    // With an audio file the test mirrors the real flow: fast tiny draft,
    // then the selected default model for the final pass.
    // --engine-test-model=<id> overrides the final-pass model.
    const modelArg = process.argv.find((a) => a.startsWith('--engine-test-model='));
    const modelOverride = modelArg?.slice('--engine-test-model='.length) as WhisperModelId | undefined;
    const model: Settings['engine']['model'] =
      modelOverride && modelOverride in WHISPER_MODELS
        ? modelOverride
        : audioFile
          ? 'whisper-base'
          : 'whisper-tiny';
    console.log(`[engine-test] downloading ${model} (if needed)…`);
    try {
      await ensureModelDownloaded(model);
      console.log('[engine-test] download ok, loading pipeline…');
      engine.onStatus((s) => console.log(`[engine-test] status: ${s.state} ${s.message ?? ''}`));
      await engine.warmup(model);
      if (audioFile) {
        console.log(`[engine-test] transcribing ${audioFile}…`);
        const { readFile } = await import('node:fs/promises');
        const audio = await readFile(audioFile);
        if (model !== 'whisper-tiny' && isModelDownloaded('whisper-tiny')) {
          // simulate the live-draft path: fast model first…
          const partial = await engine.transcribe('whisper-tiny', '', audio, 'audio/wav');
          console.log(`PARTIAL: ${JSON.stringify(partial)}`);
        }
        // …then the final pass with the selected model
        const text = await engine.transcribe(model, '', audio, 'audio/wav');
        console.log(`TRANSCRIPT: ${JSON.stringify(text)}`);
      }
      console.log('ENGINE TEST OK');
      app.exit(0);
    } catch (err) {
      console.error('ENGINE TEST FAILED:', err instanceof Error ? err.message : err);
      app.exit(1);
    }
    return;
  }

  // Pre-warm the engine in the background so the first dictation is fast.
  if (isModelDownloaded(settings.engine.model)) {
    void engine.warmup(settings.engine.model).catch(() => undefined);
  }

  // Create the overlay window eagerly so its renderer can pre-warm the mic
  // (the first getUserMedia of a renderer stalls on Windows for seconds).
  overlay.prewarm();

  if (!process.argv.includes('--hidden')) openWindow('settings');
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  keyHold.stop();
  engine.dispose();
  llama.stop();
});

app.on('window-all-closed', () => {
  // Tray-resident app: keep running. Quit only comes from the tray menu.
});
