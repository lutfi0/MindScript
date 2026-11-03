// Runs inside the hidden engine window. Imports the vendored transformers.js
// ESM bundle lazily (never at top level, so IPC listeners register
// synchronously before main can send engine:load), pulls Whisper weights
// from msres://models/ (local disk) and transcribes decoded PCM — 100% on
// this machine.

import type { TransformersModule } from './vendor-shim';

export {};

declare global {
  interface Window {
    msEngine: {
      onJob(
        cb: (job: { id: number; model: string; language: string; data: ArrayBuffer | Uint8Array; mime: string; offsetMs?: number; serverUrl?: string }) => void,
      ): void;
      onLoad(cb: (msg: { model: string; serverUrl?: string }) => void): void;
      result(msg: { id: number; ok: boolean; text?: string; error?: string }): void;
      status(msg: { state: string; model: string; message?: string }): void;
    };
  }
}

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string }>;

let transformers: TransformersModule | null = null;
// Cached pipelines — typically the fast draft model (whisper-tiny) and the
// selected final model stay resident at the same time.
const pipelines = new Map<string, Asr>();
const loads = new Map<string, Promise<void>>();

function status(state: string, model: string, message?: string): void {
  window.msEngine.status({ state, model, message });
}

async function getTransformers(): Promise<TransformersModule> {
  if (!transformers) {
    status('loading', currentLoad ?? '', 'Loading engine library…');
    transformers = (await import('../../vendor/transformers.min.js')) as TransformersModule;

    const ortBase = new URL('../../vendor/ort/', window.location.href).href;
    transformers.env.allowRemoteModels = false; // never touch the network for models
    transformers.env.allowLocalModels = true;
    transformers.env.localModelPath = 'msres://app/models/';
    transformers.env.useBrowserCache = false; // files are already local
    transformers.env.backends.onnx.wasm.wasmPaths = ortBase; // vendored onnxruntime binaries
  }
  return transformers;
}

let currentLoad: string | null = null;

async function ensurePipeline(model: string): Promise<Asr> {
  const cached = pipelines.get(model);
  if (cached) return cached;
  const inFlight = loads.get(model);
  if (inFlight) {
    await inFlight;
    return pipelines.get(model)!;
  }

  currentLoad = model;
  const load = (async () => {
    const { pipeline } = await getTransformers();
    status('loading', model, 'Loading model into memory…');
    try {
      const probe = await fetch(`msres://app/models/${model}/config.json`);
      if (!probe.ok) throw new Error(`config.json HTTP ${probe.status}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      status('error', model, `Could not read local model files (msres): ${message}`);
      throw err;
    }
    let pipe: Asr;
    try {
      pipe = await pipeline('automatic-speech-recognition', model, {
        dtype: 'q8',
        device: 'webgpu',
      });
      status('ready', model, 'Model ready (GPU · WebGPU).');
    } catch {
      status('loading', model, 'GPU unavailable — switching to CPU (WASM)…');
      pipe = await pipeline('automatic-speech-recognition', model, {
        dtype: 'q8',
        device: 'wasm',
      });
      status('ready', model, 'Model ready (CPU · WASM).');
    }
    pipelines.set(model, pipe);
  })();
  loads.set(model, load);
  try {
    await load;
  } catch (err) {
    loads.delete(model);
    const message = err instanceof Error ? err.message : String(err);
    status('error', model, `Model failed to load: ${message}`);
    throw err;
  } finally {
    currentLoad = null;
  }
  return pipelines.get(model)!;
}

/** Normalize IPC audio payloads (Uint8Array or ArrayBuffer) to a copy-safe ArrayBuffer. */
function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** Decode any browser-supported audio container to mono 16 kHz Float32 PCM. */
async function toPcm16k(data: ArrayBuffer | Uint8Array): Promise<Float32Array> {
  const bytes = toArrayBuffer(data);
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(bytes);
    if (decoded.sampleRate === 16000 && decoded.numberOfChannels === 1) {
      return decoded.getChannelData(0).slice();
    }
    const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
    const offline = new OfflineAudioContext(1, frames, 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

// ── whisper.cpp (ggml) route ─────────────────────────────────────────────
// Main spawns a warm native whisper-server (CUDA) and hands us its URL; we
// decode webm→PCM here (AudioContext), wrap the samples as a 16-bit WAV and
// POST to /inference. ~10-30x realtime — vs ~1x for the WebGPU pipeline.
const cppServers = new Map<string, string>(); // model → server URL

/** Wraps mono 16 kHz Float32 PCM in a 16-bit PCM RIFF/WAV container. */
function pcmToWav(pcm: Float32Array): ArrayBuffer {
  const dataLen = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM format
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 16000, true); // sample rate
  v.setUint32(28, 32000, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  v.setUint32(40, dataLen, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

async function transcribeCpp(
  serverUrl: string,
  pcm: Float32Array,
  language: string,
): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'audio.wav');
  form.append('language', language || 'auto');
  form.append('response_format', 'json');
  // Anti-hallucination decoder thresholds (cuts silent-window boilerplate
  // like "Thank you for watching" — values proven by OpenWhispr in #1458).
  form.append('entropy_thold', '2.8');
  form.append('logprob_thold', '-1.25');
  const res = await fetch(`${serverUrl}/inference`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}`);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? '').trim();
}

window.msEngine.onLoad(async (msg) => {
  try {
    if (msg.model.startsWith('ggml-')) {
      // Server is already warm (main waited for /health) — just cache the URL.
      if (msg.serverUrl) cppServers.set(msg.model, msg.serverUrl);
      status('ready', msg.model, 'Model ready (whisper.cpp · CUDA).');
      return;
    }
    await ensurePipeline(msg.model);
    // Always confirm the engine:load handshake — ensurePipeline emits
    // nothing when the pipeline is already cached.
    status('ready', msg.model, 'Model ready.');
  } catch {
    // status already reported to main
  }
});

window.msEngine.onJob(async (job) => {
  try {
    const cppUrl = job.serverUrl ?? cppServers.get(job.model);
    if (!cppUrl) await ensurePipeline(job.model);
    let pcm = await toPcm16k(job.data);
    if (job.offsetMs && job.offsetMs > 0) {
      // Incremental tail pass: drop everything before the checkpoint.
      // 16 kHz mono → 16 samples per millisecond.
      const start = Math.min(pcm.length, Math.floor(job.offsetMs * 16));
      pcm = pcm.slice(start);
    }
    if (pcm.length < 1600) {
      // under ~0.1s — nothing to transcribe
      window.msEngine.result({ id: job.id, ok: true, text: '' });
      return;
    }
    if (cppUrl) {
      const text = await transcribeCpp(cppUrl, pcm, job.language);
      window.msEngine.result({ id: job.id, ok: true, text });
      return;
    }
    const asr = await ensurePipeline(job.model);
    const opts: Record<string, unknown> = { task: 'transcribe', return_timestamps: false };
    if (job.language) (opts as { language?: string }).language = job.language;
    const out = await asr(pcm, opts);
    window.msEngine.result({ id: job.id, ok: true, text: (out?.text ?? '').trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    window.msEngine.result({ id: job.id, ok: false, error: message });
  }
});

status('idle', '', 'Engine ready.');

// Mic pre-warm: the first getUserMedia of a session can stall for many
// seconds while Windows spins up the audio driver (especially wireless
// headsets). Opening and immediately releasing the device here — at app
// start, inside this always-running hidden window — makes the first real
// dictation start instantly. The track is stopped right away.
void navigator.mediaDevices
  ?.getUserMedia({ audio: true })
  .then((s) => {
    for (const track of s.getTracks()) track.stop();
  })
  .catch(() => undefined);
