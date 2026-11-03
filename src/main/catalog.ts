// One lookup for speech and cleanup models: the suggested catalog entries plus
// the third-party models the user added by link (kept in Settings).
import {
  CLEANUP_MODELS,
  CleanupModelId,
  CustomModel,
  WHISPER_MODELS,
  WhisperModelId,
} from '../shared/ipc';

export interface ModelSpec {
  label: string;
  size: string;
  hint: string;
  /** Hugging Face repo for catalog entries, the download URL for custom ones */
  repo: string;
  /** single-file models (ggml / gguf); undefined for the transformers.js ONNX folders */
  file?: string;
  /** direct download link (custom models only) */
  url?: string;
  custom: boolean;
}

let customs: CustomModel[] = [];

export function setCustomModels(list: CustomModel[]): void {
  customs = list;
}

function fmtSize(bytes?: number): string {
  if (!bytes) return '—';
  return bytes >= 1024 ** 3 ? `~${(bytes / 1024 ** 3).toFixed(1)} GB` : `~${Math.round(bytes / 1024 ** 2)} MB`;
}

function fromCustom(c: CustomModel): ModelSpec {
  return { label: c.label, size: fmtSize(c.size), hint: c.url, repo: c.url, file: c.file, url: c.url, custom: true };
}

export function speechSpec(id: string): ModelSpec | null {
  if (id in WHISPER_MODELS) return { ...WHISPER_MODELS[id as keyof typeof WHISPER_MODELS], custom: false };
  const c = customs.find((m) => m.kind === 'speech' && m.id === id);
  return c ? fromCustom(c) : null;
}

export function cleanupSpec(id: string): ModelSpec | null {
  if (id in CLEANUP_MODELS) return { ...CLEANUP_MODELS[id as keyof typeof CLEANUP_MODELS], custom: false };
  const c = customs.find((m) => m.kind === 'cleanup' && m.id === id);
  return c ? fromCustom(c) : null;
}

export function speechIds(): WhisperModelId[] {
  return [
    ...(Object.keys(WHISPER_MODELS) as WhisperModelId[]),
    ...customs.filter((m) => m.kind === 'speech').map((m) => m.id as WhisperModelId),
  ];
}

export function cleanupIds(): CleanupModelId[] {
  return [
    ...(Object.keys(CLEANUP_MODELS) as CleanupModelId[]),
    ...customs.filter((m) => m.kind === 'cleanup').map((m) => m.id as CleanupModelId),
  ];
}
