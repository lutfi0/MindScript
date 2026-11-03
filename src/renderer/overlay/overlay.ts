// Recording engine for the overlay. getUserMedia + MediaRecorder live here
// (renderer side), the captured audio is shipped to main as a Uint8Array.
// `import type` is erased at emit, keeping this a plain browser script.
import type { OverlayCommand, OverlayPhase, OverlayStateMsg } from '../../shared/ipc';
import type { I18nPayload } from '../../shared/i18n';

export {};

declare global {
  interface Window {
    msOverlay: {
      onState(cb: (state: OverlayStateMsg) => void): () => void;
      onPartial(cb: (text: string) => void): () => void;
      onCommand(cb: (cmd: OverlayCommand) => void): () => void;
      started(): void;
      failed(message: string): void;
      audio(data: Uint8Array, mime: string, durationMs: number): void;
      interim(data: Uint8Array, mime: string, durationMs: number): void;
      cancelled(): void;
      getI18n(): Promise<I18nPayload>;
      onI18nChanged(cb: (p: I18nPayload) => void): () => void;
    };
  }
}

const pill = document.getElementById('pill') as HTMLDivElement;
const titleEl = document.getElementById('title') as HTMLDivElement;
const liveEl = document.getElementById('live') as HTMLDivElement;
const hintEl = document.getElementById('hint') as HTMLDivElement;
const timerEl = document.getElementById('timer') as HTMLDivElement;
const canvas = document.getElementById('wave') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let audioCtx: AudioContext | null = null;
let rafId = 0;
let timerInterval = 0;
let interimTimer = 0;
let silenceTimer = 0;
let startedAt = 0;
/** performance.now() of the newest recorded chunk — the audio really captured so far. */
let lastChunkAt = 0;
let stopPending = false;
/** Keep recording briefly after the stop key so the word being spoken isn't clipped. */
const STOP_TAIL_MS = 350;
let cancelled = false;
let recordingMime = '';
const amplitudes: number[] = [];

// Silence timeout: pausing to think must NOT end the recording, but after
// 60 s with no speech at all it finishes on its own (what was said is still
// transcribed and pasted).
const SILENCE_LIMIT_MS = 60_000;
const SILENCE_WARN_MS = 45_000;
/** Speech threshold — room noise usually stays below 0.03. */
const VOICE_PEAK = 0.04;
let lastVoiceAt = 0;

function pickMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

let i18n: I18nPayload = { lang: 'en', langs: [], dict: {} };
let silenceHint = false;
function t(key: string, vars?: Record<string, string | number>): string {
  let s = i18n.dict[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
void window.msOverlay.getI18n().then((p) => {
  i18n = p;
  document.documentElement.lang = p.lang;
});
window.msOverlay.onI18nChanged((p) => {
  i18n = p;
  document.documentElement.lang = p.lang;
});

// Waveform bar colours follow the light/dark theme.
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
let waveOn = '#e5e5e5';
let waveOff = '#404040';
function syncWaveColors(): void {
  waveOn = darkMq.matches ? '#e5e5e5' : '#27272a';
  waveOff = darkMq.matches ? '#404040' : '#d4d4d8';
}
syncWaveColors();
darkMq.addEventListener('change', syncWaveColors);

function setPhaseUI(phase: OverlayPhase, message?: string): void {
  pill.dataset.phase = phase;
  if (phase === 'recording') {
    titleEl.textContent = t('overlay.listening');
    hintEl.textContent = t('overlay.hint');
  } else if (phase === 'transcribing') {
    titleEl.textContent = message ?? t('overlay.transcribing');
    hintEl.textContent = t('overlay.wait');
  } else if (phase === 'done') {
    titleEl.textContent = message ?? t('overlay.inserted');
    hintEl.textContent = '';
  } else if (phase === 'error') {
    titleEl.textContent = t('overlay.error');
    hintEl.textContent = message ?? t('overlay.unexpected');
  }
}

function drawLoop(analyser: AnalyserNode): void {
  const data = new Uint8Array(analyser.fftSize);
  const draw = () => {
    if (!audioCtx) return;
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    if (peak > VOICE_PEAK) lastVoiceAt = performance.now();
    amplitudes.push(peak);
    if (amplitudes.length > 44) amplitudes.shift();

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const barW = 2;
    const gap = 1.6;
    const mid = canvas.height / 2;
    amplitudes.forEach((a, i) => {
      const h = Math.max(2, a * canvas.height * 1.8);
      const x = i * (barW + gap);
      ctx.fillStyle = a > 0.02 ? waveOn : waveOff;
      ctx.beginPath();
      ctx.roundRect(x, mid - h / 2, barW, h, 1);
      ctx.fill();
    });
    rafId = requestAnimationFrame(draw);
  };
  rafId = requestAnimationFrame(draw);
}

/** Checks silence once a second; finishes the recording after 60 s without speech. */
function checkSilence(): void {
  if (!recorder || recorder.state !== 'recording') return;
  const silentFor = performance.now() - lastVoiceAt;
  if (silentFor > SILENCE_LIMIT_MS) {
    stopRecording();
  } else if (silentFor > SILENCE_WARN_MS) {
    const left = Math.ceil((SILENCE_LIMIT_MS - silentFor) / 1000);
    hintEl.textContent = t('overlay.silence', { n: left });
    silenceHint = true;
  } else if (silenceHint) {
    silenceHint = false;
    hintEl.textContent = t('overlay.hint');
  }
}

function teardownAudio(): void {
  cancelAnimationFrame(rafId);
  window.clearInterval(timerInterval);
  window.clearInterval(interimTimer);
  window.clearInterval(silenceTimer);
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (audioCtx) {
    void audioCtx.close().catch(() => undefined);
    audioCtx = null;
  }
}

function updateTimer(): void {
  const s = Math.floor((performance.now() - startedAt) / 1000);
  timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Ships the audio-so-far for the incremental transcription pass (every ~2.5s). */
function sendInterim(): void {
  if (!recorder || recorder.state !== 'recording' || chunks.length === 0) return;
  // Measure up to the last chunk, not "now": chunks arrive every 400ms, so
  // the wall clock runs ahead of the audio and main's checkpoint would skip
  // the gap.
  const elapsedMs = startedAt ? lastChunkAt - startedAt : 0;
  const blob = new Blob(chunks, { type: recordingMime || 'audio/webm' });
  void blob.arrayBuffer().then((ab) => {
    if (recorder && recorder.state === 'recording') {
      window.msOverlay.interim(new Uint8Array(ab), blob.type, elapsedMs);
    }
  });
}

/** getUserMedia can hang forever when another app holds the mic (Discord,
 *  Teams…) or the driver stalls. Race it against a timeout, retry once with
 *  plain constraints, then fail visibly instead of freezing the pill. */
async function acquireMic(): Promise<MediaStream> {
  // Plain capture: Chromium's echoCancellation/noiseSuppression keep a CPU
  // core busy for the whole recording and measurably slow down the local
  // Whisper passes running in parallel.
  const attempts: MediaStreamConstraints[] = [{ audio: true }];
  let lastErr: unknown = new Error(t('overlay.micNoResponse'));
  for (const constraints of attempts) {
    try {
      return await Promise.race([
        navigator.mediaDevices.getUserMedia(constraints),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error(t('overlay.micTimeout'))), 5000),
        ),
      ]);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function startRecording(): Promise<void> {
  if (recorder && recorder.state === 'recording') return;
  cancelled = false;
  stopPending = false;
  chunks = [];
  amplitudes.length = 0;
  timerEl.textContent = '0:00';

  try {
    stream = await acquireMic();
  } catch {
    setPhaseUI('error', t('overlay.micBusy'));
    window.msOverlay.failed(t('overlay.micFailed'));
    return;
  }

  recordingMime = pickMime();
  recorder = new MediaRecorder(stream, recordingMime ? { mimeType: recordingMime } : undefined);
  recorder.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
      lastChunkAt = performance.now();
    }
  };
  recorder.onstop = onStopped;
  recorder.start(400);

  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  drawLoop(analyser);

  startedAt = performance.now();
  lastChunkAt = startedAt;
  lastVoiceAt = startedAt;
  timerInterval = window.setInterval(updateTimer, 250);
  interimTimer = window.setInterval(sendInterim, 2500);
  silenceTimer = window.setInterval(checkSilence, 1000);
  liveEl.textContent = '';
  setPhaseUI('recording');
  window.msOverlay.started();
}

function onStopped(): void {
  const duration = startedAt ? performance.now() - startedAt : 0;
  teardownAudio();
  if (cancelled) return; // main already knows via the cancel command

  const blob = new Blob(chunks, { type: recordingMime || 'audio/webm' });
  chunks = [];
  if (blob.size === 0) {
    setPhaseUI('error', t('overlay.noAudio'));
    window.msOverlay.cancelled();
    return;
  }
  void blob.arrayBuffer().then((ab) => {
    window.msOverlay.audio(new Uint8Array(ab), blob.type, duration);
  });
}

function stopRecording(): void {
  if (!recorder || recorder.state !== 'recording' || stopPending) return;
  stopPending = true;
  const rec = recorder;
  setTimeout(() => {
    stopPending = false;
    if (rec.state === 'recording') rec.stop();
  }, STOP_TAIL_MS);
}

function cancelRecording(): void {
  cancelled = true;
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
  } else {
    teardownAudio();
  }
  window.msOverlay.cancelled();
}

function resetIdle(): void {
  cancelled = false;
  chunks = [];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  amplitudes.length = 0;
  timerEl.textContent = '0:00';
  liveEl.textContent = '';
}

window.msOverlay.onCommand((cmd) => {
  if (cmd.type === 'start') void startRecording();
  else if (cmd.type === 'stop') stopRecording();
  else if (cmd.type === 'cancel') cancelRecording();
});

window.msOverlay.onPartial((text) => {
  // live draft while speaking; keep the last draft visible during the final pass
  if (pill.dataset.phase === 'recording' || pill.dataset.phase === 'transcribing') {
    liveEl.textContent = text;
  }
});

window.msOverlay.onState((state) => {
  if (state.phase === 'idle') {
    resetIdle();
  } else {
    setPhaseUI(state.phase, state.message);
  }
});

setPhaseUI('idle');

// Mic pre-warm: the first getUserMedia *of this renderer process* can stall
// for many seconds while Windows spins up the audio driver (especially
// wireless headsets). The overlay window is created eagerly at app start,
// so opening and immediately releasing the mic here makes the first real
// dictation start instantly.
void navigator.mediaDevices
  ?.getUserMedia({ audio: true })
  .then((s) => {
    for (const track of s.getTracks()) track.stop();
  })
  .catch(() => undefined);
