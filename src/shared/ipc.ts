// Shared types used by main, preload and renderer code.
// Type-only for renderers (loaded via /// <reference path=...>), so no runtime
// import is emitted into the browser scripts.

export type OverlayPhase = 'idle' | 'recording' | 'transcribing' | 'done' | 'error';

export interface OverlayStateMsg {
  phase: OverlayPhase;
  message?: string;
}

export type OverlayCommand = { type: 'start' } | { type: 'stop' } | { type: 'cancel' };

/**
 * Local Whisper model served through the bundled transformers.js engine.
 * Model weights are downloaded once from HuggingFace into userData/models/
 * and everything afterwards runs fully offline on this machine.
 */
export type BuiltinWhisperId =
  | 'whisper-tiny'
  | 'whisper-base'
  | 'whisper-small'
  | 'whisper-large-v3-turbo'
  | 'ggml-small-q5'
  | 'ggml-large-v3-turbo-q5'
  | 'ggml-large-v3-turbo-tr-q5'
  | 'ggml-large-v3-q5'
  | 'ggml-large-v3-turbo-f16'
  | 'ggml-large-v3-f16';

/** Suggested catalog entries, or a whisper.cpp model the user added by link. */
export type WhisperModelId = BuiltinWhisperId | `ggml-custom-${string}`;

/** ggml-* models (custom ones included) run through the bundled whisper.cpp
 *  CUDA server instead of the transformers.js engine window. */
export function isGgmlModel(model: string): boolean {
  return model.startsWith('ggml-');
}

/** A third-party model the user added from a download link. */
export interface CustomModel {
  id: string;
  kind: 'speech' | 'cleanup';
  label: string;
  /** direct https download link */
  url: string;
  /** file name on disk */
  file: string;
  /** bytes, when the server reported it */
  size?: number;
}

export interface EngineSettings {
  model: WhisperModelId;
  /** BCP-47 code ('tr', 'en', …), empty = auto detect */
  language: string;
}

/** Built-in text-cleanup model (GGUF) served by the bundled llama.cpp
 *  CUDA server — the no-install alternative to Ollama. */
export type BuiltinCleanupId = 'qwen3-0.6b-q4' | 'qwen3.5-2b-q4' | 'gemma3-4b-q4';
export type CleanupModelId = BuiltinCleanupId | `gguf-custom-${string}`;

export type PolishEngine = 'builtin' | 'ollama';

/** Where the built-in cleanup model runs: the graphics card, or the CPU
 *  (slower, but leaves the GPU free for games and editors). */
export type CleanupDevice = 'gpu' | 'cpu';

export interface PolishSettings {
  /** optional second pass that fixes punctuation/casing/typos */
  enabled: boolean;
  /** 'builtin' = bundled llama.cpp server, 'ollama' = user's own Ollama */
  engine: PolishEngine;
  /** model for the built-in engine */
  localModel: CleanupModelId;
  /** run the built-in model on the GPU (default) or on the CPU */
  device: CleanupDevice;
  /** minutes without use before the built-in model leaves VRAM; 0 = never */
  idleUnloadMin: number;
  /** Ollama: e.g. http://127.0.0.1:11434/v1 */
  baseUrl: string;
  /** Ollama model name */
  model: string;
}

export interface Settings {
  engine: EngineSettings;
  polish: PolishSettings;
  /** Electron accelerator that toggles dictation */
  hotkey: string;
  /**
   * 0: a press toggles dictation. >0: the hotkey must be held this many ms to
   * start, so short presses keep their normal meaning (e.g. Caps Lock).
   */
  holdToStartMs: number;
  /** accelerator registered only while recording, cancels the take */
  cancelKey: string;
  pasteMode: 'clipboard-paste' | 'clipboard-only';
  overlayPosition: 'bottom-center' | 'near-cursor';
  launchOnStartup: boolean;
  /** show a live draft transcript while speaking */
  liveDrafts: boolean;
  /** UI language: 'auto' follows the OS, otherwise a UiLang code (en/tr/de/fr/es/ru) */
  uiLanguage: string;
  /**
   * true: new versions download in the background, a notification says when
   * one is ready and it installs on quit. false: the app only checks; the
   * Behavior page shows the new version and installs it on request.
   */
  updateNotify: boolean;
  /**
   * Personal dictionary: names and foreign words (one per line or comma
   * separated) that the speech model should spell exactly. Sent to Whisper as
   * its starting prompt and to the cleanup model as a spelling list.
   */
  dictionary: string;
  /** third-party models added from a link (managed through their own IPC) */
  customModels: CustomModel[];
}

/** Dictation languages offered in the settings (Whisper language codes). */
export const DICTATION_LANGUAGES = ['tr', 'en', 'de', 'fr', 'es', 'it', 'ru', 'ar'] as const;

/** Choices offered for Settings.holdToStartMs. */
export const HOLD_TO_START_OPTIONS = [0, 500, 1000, 1500, 2000] as const;

export interface HistoryEntry {
  id: string;
  ts: number;
  durationMs: number;
  chars: number;
  text: string;
}

export const DEFAULT_SETTINGS: Settings = {
  engine: {
    model: 'whisper-base',
    // Replaced on first run by the OS language when it is one of
    // DICTATION_LANGUAGES (transformers.js assumes English without one).
    language: 'en',
  },
  polish: {
    enabled: false,
    engine: 'builtin',
    // Lightest model that still does the job: ~0.4 GB download, well under
    // 1 GB of VRAM. Users can move up to a bigger one or turn cleanup off.
    localModel: 'qwen3-0.6b-q4',
    device: 'gpu',
    idleUnloadMin: 10,
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.2',
  },
  hotkey: 'Control+Shift+Space',
  holdToStartMs: 0,
  cancelKey: 'Escape',
  pasteMode: 'clipboard-paste',
  overlayPosition: 'bottom-center',
  launchOnStartup: false,
  liveDrafts: true,
  uiLanguage: 'auto',
  updateNotify: true,
  dictionary: '',
  customModels: [],
};

/**
 * Checks a pasted download link for a custom model: https only, a Hugging
 * Face "blob" page link is turned into its direct "resolve" download, and the
 * file must be a whisper.cpp .bin (speech) or a .gguf (cleanup).
 */
export function parseModelLink(raw: string, kind: CustomModel['kind']): { url: string; file: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (/(^|\.)huggingface\.co$/i.test(u.hostname)) u.pathname = u.pathname.replace('/blob/', '/resolve/');
  const file = decodeURIComponent(u.pathname.split('/').pop() ?? '');
  const ext = kind === 'speech' ? /\.bin$/i : /\.gguf$/i;
  if (!ext.test(file) || /[\\/:*?"<>|]/.test(file)) return null;
  u.hash = '';
  return { url: u.toString(), file };
}

export const HISTORY_LIMIT = 500;

export interface ModelCatalogEntry {
  label: string;
  size: string;
  hint: string;
  repo: string;
  /** Absolute on-disk folder (filled in by the main process). */
  dir: string;
  downloaded: boolean;
  /** Bytes on disk when downloaded (filled in by the main process). */
  sizeOnDisk?: number;
  /** added by the user from a link (download URL in `repo`) */
  custom?: boolean;
}

/** What the onboarding page needs to suggest a first speech model. */
/** GPU API for the native whisper.cpp / llama.cpp engines. */
export type GpuBackend = 'cuda' | 'vulkan';

export interface HardwareInfo {
  nvidia: boolean;
  /** native engine backend for this machine; null = no usable GPU (WebGPU/CPU only) */
  backend: GpuBackend | null;
  gpuName?: string;
  /** dedicated VRAM in MiB, when known */
  vramMb?: number;
}

/** Suggested speech models: third-party models, independent of MindScript. */
export const WHISPER_MODELS: Record<
  BuiltinWhisperId,
  {
    label: string;
    size: string;
    hint: string;
    /** Hugging Face repo the weights come from (credited in the UI) */
    repo: string;
    file?: string;
    /** direct download, for weights converted by this project */
    url?: string;
  }
> = {
  'whisper-tiny': {
    label: 'Tiny',
    size: '~45 MB',
    hint: 'Fastest, lower accuracy',
    repo: 'onnx-community/whisper-tiny',
  },
  'whisper-base': {
    label: 'Base',
    size: '~85 MB',
    hint: 'Balance of speed and accuracy',
    repo: 'onnx-community/whisper-base',
  },
  'whisper-small': {
    label: 'Small',
    size: '~250 MB',
    hint: 'More accurate, slower',
    repo: 'onnx-community/whisper-small',
  },
  'whisper-large-v3-turbo': {
    label: 'Large v3 Turbo',
    size: '~1.1 GB',
    hint: 'Highest accuracy; ~8x faster than other large models on GPU',
    repo: 'onnx-community/whisper-large-v3-turbo',
  },
  'ggml-small-q5': {
    label: 'Small · CUDA (light)',
    size: '~190 MB',
    hint: 'whisper.cpp + NVIDIA CUDA — very light and fast; less accurate than Turbo',
    repo: 'ggerganov/whisper.cpp',
    file: 'ggml-small-q5_1.bin',
  },
  'ggml-large-v3-turbo-q5': {
    label: 'Large v3 Turbo · CUDA',
    size: '~575 MB',
    hint: 'whisper.cpp + NVIDIA CUDA — ~10 s of audio per second; fastest and most accurate',
    repo: 'ggerganov/whisper.cpp',
    file: 'ggml-large-v3-turbo-q5_0.bin',
  },
  'ggml-large-v3-turbo-tr-q5': {
    label: 'Large v3 Turbo Turkish · CUDA',
    size: '~575 MB',
    hint: 'Turbo fine-tuned on Turkish speech (selimc, MIT) — Turbo speed, tuned for Turkish',
    // selimc/whisper-large-v3-turbo-turkish, converted to ggml and q5_0 for whisper.cpp
    repo: 'selimc/whisper-large-v3-turbo-turkish',
    file: 'ggml-large-v3-turbo-tr-q5_0.bin',
    url: 'https://github.com/lutfi0/MindScript/releases/download/models/ggml-large-v3-turbo-tr-q5_0.bin',
  },
  'ggml-large-v3-q5': {
    label: 'Large v3 · CUDA',
    size: '~1.1 GB',
    hint: 'whisper.cpp + NVIDIA CUDA — slightly more accurate than Turbo, ~2-3x slower',
    repo: 'ggerganov/whisper.cpp',
    file: 'ggml-large-v3-q5_0.bin',
  },
  'ggml-large-v3-turbo-f16': {
    label: 'Large v3 Turbo · CUDA (full precision)',
    size: '~1.6 GB',
    hint: 'Uncompressed — noticeably more accurate than q5 Turbo, still very fast',
    repo: 'ggerganov/whisper.cpp',
    file: 'ggml-large-v3-turbo.bin',
  },
  'ggml-large-v3-f16': {
    label: 'Large v3 · CUDA (full precision)',
    size: '~3.1 GB',
    hint: 'Uncompressed — highest accuracy; slightly slower than q5 Large',
    repo: 'ggerganov/whisper.cpp',
    file: 'ggml-large-v3.bin',
  },
};

/** Suggested cleanup models: third-party models, independent of MindScript. */
export const CLEANUP_MODELS: Record<
  BuiltinCleanupId,
  { label: string; size: string; hint: string; repo: string; file: string }
> = {
  'qwen3-0.6b-q4': {
    label: 'Qwen3 0.6B (default, lightest)',
    size: '~0.4 GB',
    hint: 'Tiny and very fast (~0.6 GB VRAM, or run it on the CPU); fixes punctuation and casing, but misses some commas and word endings',
    repo: 'unsloth/Qwen3-0.6B-GGUF',
    file: 'Qwen3-0.6B-Q4_K_M.gguf',
  },
  'qwen3.5-2b-q4': {
    label: 'Qwen3.5 2B (light)',
    size: '~1.3 GB',
    hint: 'Fast and light (~1.6 GB VRAM); good punctuation in many languages',
    repo: 'unsloth/Qwen3.5-2B-GGUF',
    file: 'Qwen3.5-2B-Q4_K_M.gguf',
  },
  'gemma3-4b-q4': {
    label: 'Gemma 3 4B (quality)',
    size: '~2.5 GB',
    hint: 'More careful fixes (~3 GB VRAM); a bit slower',
    repo: 'unsloth/gemma-3-4b-it-GGUF',
    file: 'gemma-3-4b-it-Q4_K_M.gguf',
  },
};

export function isCleanupModel(id: string): id is BuiltinCleanupId {
  return id in CLEANUP_MODELS;
}

export interface CleanupStatus {
  state: 'downloading' | 'ready' | 'error';
  model: CleanupModelId;
  progress?: number;
  message?: string;
}

export interface UpdateStatus {
  /** 'unsupported': not an installed build (dev run), updates are off */
  state: 'unsupported' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'downloaded' | 'error';
  /** installed version */
  current: string;
  /** newer version on GitHub Releases, once found */
  version?: string;
  /** 0..100 while downloading */
  progress?: number;
  message?: string;
}

export type ModelStatusState = 'idle' | 'downloading' | 'loading' | 'ready' | 'error';

export interface ModelStatus {
  state: ModelStatusState;
  model: WhisperModelId;
  /** 0..100 while downloading */
  progress?: number;
  message?: string;
}

// IPC channel names. Main imports this module; preloads are sandboxed and
// self-contained, so they duplicate these literals — keep them in sync.
export const Channels = {
  overlayState: 'overlay:state',
  overlayCommand: 'overlay:command',
  overlayStarted: 'overlay:recording-started',
  overlayFailed: 'overlay:recording-error',
  overlayAudio: 'overlay:audio',
  overlayCancelled: 'overlay:cancelled',
  overlayInterim: 'overlay:interim',
  overlayPartial: 'overlay:partial',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  testPolish: 'test-polish',
  historyList: 'history:list',
  historyDelete: 'history:delete',
  historyClear: 'history:clear',
  historyRepaste: 'history:repaste',
  modelEnsure: 'model:ensure',
  modelStatus: 'model:status',
  modelState: 'model:state',
  modelDelete: 'model:delete',
  cleanupState: 'cleanup:state',
  cleanupEnsure: 'cleanup:ensure',
  cleanupDelete: 'cleanup:delete',
  cleanupStatus: 'cleanup:status',
  modelAddCustom: 'model:add-custom',
  systemHardware: 'system:hardware',
  updateGet: 'update:get',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateStatus: 'update:status',
} as const;

export interface SaveResult {
  ok: boolean;
  hotkeyRegistered: boolean;
  message?: string;
}

export interface TestResult {
  ok: boolean;
  message: string;
}
