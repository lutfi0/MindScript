import type {
  CleanupStatus,
  CustomModel,
  HardwareInfo,
  HistoryEntry,
  ModelCatalogEntry,
  ModelStatus,
  SaveResult,
  Settings,
  TestResult,
  UpdateStatus,
  WhisperModelId,
} from '../../shared/ipc';
import type { I18nPayload } from '../../shared/i18n';

export {};

declare global {
  interface Window {
    msSettings: {
      get(): Promise<Settings>;
      save(partial: Partial<Settings>): Promise<SaveResult>;
      testPolish(polish: Settings['polish']): Promise<TestResult>;
      ensureModel(model: WhisperModelId): Promise<{ started: boolean }>;
      getModelStates(): Promise<Record<string, ModelCatalogEntry>>;
      deleteModel(model: WhisperModelId): Promise<{ ok: boolean; message?: string; settings?: Settings }>;
      onModelStatus(cb: (status: ModelStatus) => void): () => void;
      getCleanupStates(): Promise<Record<string, ModelCatalogEntry>>;
      ensureCleanup(model: string): Promise<{ started: boolean }>;
      deleteCleanup(model: string): Promise<{ ok: boolean; message?: string; settings?: Settings }>;
      onCleanupStatus(cb: (status: CleanupStatus) => void): () => void;
      addCustomModel(kind: CustomModel['kind'], link: string, name: string): Promise<{ ok: boolean; id?: string; message?: string }>;
      getHardware(): Promise<HardwareInfo>;
      getUpdate(): Promise<UpdateStatus>;
      checkUpdate(): Promise<void>;
      installUpdate(): Promise<void>;
      onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
      historyList(): Promise<HistoryEntry[]>;
      historyRemove(id: string): Promise<void>;
      historyClear(): Promise<void>;
      historyRepaste(text: string): Promise<void>;
      getI18n(): Promise<I18nPayload>;
      onI18nChanged(cb: (p: I18nPayload) => void): () => void;
      onOpenPage(cb: (page: string) => void): () => void;
      winMinimize(): void;
      winToggleMaximize(): void;
      winClose(): void;
      winIsMaximized(): Promise<boolean>;
      onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
    };
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/* ── State ─────────────────────────────────────────────────── */
let settings: Settings;
let i18n: I18nPayload = { lang: 'en', langs: [], dict: {} };
let modelCatalog: Record<string, ModelCatalogEntry> = {};
let selectedModel = '';
/** Built-in text-cleanup models (llama.cpp GGUF). */
let cleanupCatalog: Record<string, ModelCatalogEntry> = {};
type RowStatus = { state: string; progress?: number; message?: string };
const rowStatus = new Map<string, RowStatus>();
const cleanupRowStatus = new Map<string, RowStatus>();
/** Speech models (Models page) vs text-cleanup models (Text cleanup page). */
type Kind = 'speech' | 'cleanup';
let historyEntries: HistoryEntry[] = [];

const t = (key: string, vars?: Record<string, string | number>): string => {
  let s = i18n.dict[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
};

/** Applies the static strings + re-renders everything dynamic. */
function applyI18n(): void {
  document.documentElement.lang = i18n.lang;
  document.title = t('app.title');
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle!);
    el.setAttribute('aria-label', el.title);
  });
  syncMaxButton();
  document.querySelectorAll<HTMLElement>('[data-i18n-ph]').forEach((el) => {
    (el as HTMLInputElement).placeholder = t(el.dataset.i18nPh!);
  });
  // Refresh the auto-label inside the language select.
  const auto = $('uiLang').querySelector('option[value="auto"]');
  if (auto) auto.textContent = t('behavior.uiLang.auto');
  renderAll();
  renderCleanup();
  renderHistory();
  renderUpdate();
}

function fillLangSelect(): void {
  const sel = $('uiLang') as HTMLSelectElement;
  sel.textContent = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = t('behavior.uiLang.auto');
  sel.append(auto);
  for (const l of i18n.langs) {
    const o = document.createElement('option');
    o.value = l.id;
    o.textContent = l.label;
    sel.append(o);
  }
  sel.value = settings.uiLanguage || 'auto';
}

/* ── Title bar ─────────────────────────────────────────────── */
let maximized = false;
function syncMaxButton(): void {
  document.body.classList.toggle('maximized', maximized);
  const key = maximized ? 'win.restore' : 'win.maximize';
  const btn = $('winMax');
  btn.dataset.i18nTitle = key;
  btn.title = t(key);
  btn.setAttribute('aria-label', btn.title);
}

function initTitleBar(): void {
  $('winMin').addEventListener('click', () => window.msSettings.winMinimize());
  $('winMax').addEventListener('click', () => window.msSettings.winToggleMaximize());
  $('winClose').addEventListener('click', () => window.msSettings.winClose());
  window.msSettings.onMaximizedChanged((m) => {
    maximized = m;
    syncMaxButton();
  });
  void window.msSettings.winIsMaximized().then((m) => {
    maximized = m;
    syncMaxButton();
  });
  window.addEventListener('blur', () => document.body.classList.add('blurred'));
  window.addEventListener('focus', () => document.body.classList.remove('blurred'));
}

/* ── Small helpers ─────────────────────────────────────────── */
function fmtBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string, err = false): void {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('err', err);
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

/** Instant save — there is no Save button, every change applies. */
async function save(partial: Partial<Settings>, okText?: string): Promise<boolean> {
  const res = await window.msSettings.save(partial);
  if (res.ok) {
    Object.assign(settings, partial);
    renderSummary();
    toast(okText ?? t('toast.saved'));
    return true;
  }
  toast(res.message ?? t('toast.saveFailed'), true);
  return false;
}

/* ── Page routing ──────────────────────────────────────────── */
const pages = ['baslangic', 'genel', 'modeller', 'metin', 'kisayollar', 'davranis', 'gecmis'] as const;
type Page = (typeof pages)[number];

function showPage(page: Page): void {
  if (!pages.includes(page)) return;
  for (const p of pages) $(`page-${p}`).classList.toggle('hidden', p !== page);
  document.querySelectorAll('#nav button').forEach((b) => {
    b.classList.toggle('active', (b as HTMLButtonElement).dataset.page === page);
  });
  document.querySelector('main')!.scrollTop = 0;
  if (page === 'gecmis') void loadHistory();
}

/* ── Model rows ────────────────────────────────────────────── */
const popup = $('menuPopup');
let popupFor: string | null = null;

function closePopup(): void {
  popup.classList.add('hidden');
  popupFor = null;
}

document.addEventListener('click', (e) => {
  if (!popup.classList.contains('hidden') && !popup.contains(e.target as Node)) closePopup();
});

function openPopup(id: string, anchor: HTMLButtonElement, kind: Kind): void {
  if (popupFor === id && !popup.classList.contains('hidden')) {
    closePopup();
    return;
  }
  popupFor = id;
  popup.textContent = '';

  const info = document.createElement('button');
  info.type = 'button';
  info.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg><span></span>';
  info.querySelector('span')!.textContent = t('model.menu.info');
  info.addEventListener('click', () => {
    closePopup();
    showModelInfo(id, kind);
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'danger';
  del.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span></span>';
  del.querySelector('span')!.textContent = t('model.menu.delete');
  del.addEventListener('click', () => {
    const span = del.querySelector('span')!;
    if (del.dataset.armed) {
      closePopup();
      void (kind === 'cleanup' ? doDeleteCleanup(id) : doDelete(id as WhisperModelId));
    } else {
      del.dataset.armed = '1';
      span.textContent = t('model.menu.confirm');
    }
  });

  popup.append(info, del);
  const r = anchor.getBoundingClientRect();
  popup.classList.remove('hidden');
  const pw = popup.offsetWidth;
  popup.style.left = `${Math.max(8, r.right - pw)}px`;
  popup.style.top = `${r.bottom + 6}px`;
}

/** Translated hint when a dict entry exists, catalog hint otherwise. */
function hintFor(id: string, entry: ModelCatalogEntry): string {
  const key = `hint.${id}`;
  const v = t(key);
  return v === key ? entry.hint : v;
}

/** Translated model name when a dict entry exists, catalog label otherwise. */
function labelFor(id: string): string {
  const key = `mlabel.${id}`;
  const v = t(key);
  return v === key ? (modelCatalog[id] ?? cleanupCatalog[id])?.label ?? id : v;
}

function showModelInfo(id: string, kind: Kind): void {
  const e = kind === 'cleanup' ? cleanupCatalog[id] : modelCatalog[id];
  if (!e) return;
  $('infoTitle').textContent = labelFor(id);
  const dl = $('infoBody');
  dl.textContent = '';
  const rows: [string, string][] = [
    [t('model.info.desc'), hintFor(id, e)],
    [
      t('model.info.engine'),
      kind === 'cleanup'
        ? t('model.engine.llama', { gpu: gpuApi() })
        : id.startsWith('ggml-')
          ? t('model.engine.cpp', { gpu: gpuApi() })
          : t('model.engine.tjs'),
    ],
    [t('model.info.size'), e.downloaded && e.sizeOnDisk ? fmtBytes(e.sizeOnDisk) : e.size],
    [t('model.info.status'), e.downloaded ? t('model.info.downloaded') : t('model.info.notDownloaded')],
    [t('model.info.location'), e.downloaded ? e.dir : '—'],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  $('infoModal').classList.remove('hidden');
}

async function doDelete(id: WhisperModelId): Promise<void> {
  const res = await window.msSettings.deleteModel(id);
  modelCatalog = await window.msSettings.getModelStates();
  if (!res.ok) {
    toast(res.message ?? t('toast.deleteFailed'), true);
  } else if (res.settings && res.settings.engine.model !== selectedModel) {
    selectedModel = res.settings.engine.model;
    settings.engine.model = selectedModel as WhisperModelId;
    toast(t('toast.modelDeletedActive', { model: labelFor(selectedModel) }));
  } else {
    toast(t('toast.modelDeleted'));
  }
  renderAll();
}

async function doDeleteCleanup(id: string): Promise<void> {
  const res = await window.msSettings.deleteCleanup(id);
  cleanupCatalog = await window.msSettings.getCleanupStates();
  if (!res.ok) {
    toast(res.message ?? t('toast.deleteFailed'), true);
  } else if (res.settings && res.settings.polish.localModel !== settings.polish.localModel) {
    settings.polish = res.settings.polish;
    toast(t('toast.modelDeletedActive', { model: labelFor(settings.polish.localModel) }));
  } else {
    toast(t('toast.modelDeleted'));
  }
  renderCleanup();
}

function modelRow(id: string, entry: ModelCatalogEntry, withMenu: boolean, kind: Kind = 'speech'): HTMLElement {
  const status = (kind === 'cleanup' ? cleanupRowStatus : rowStatus).get(id);
  const busy = status && (status.state === 'downloading' || status.state === 'loading');
  const active = kind === 'cleanup' ? settings.polish.localModel : selectedModel;

  const row = document.createElement('div');
  row.className = 'mrow';
  if (id === active) row.classList.add('selected');

  const radio = document.createElement('button');
  radio.type = 'button';
  radio.className = 'radio';
  radio.setAttribute('aria-checked', String(id === active));

  const info = document.createElement('div');
  info.className = 'minfo';
  const name = document.createElement('div');
  name.className = 'mname';
  name.textContent = labelFor(id);
  if (kind === 'speech' && entry.recommended) {
    // The developer's own setup: a suggestion, never forced
    const rec = document.createElement('span');
    rec.className = 'mrec';
    rec.textContent = t('model.recommended');
    rec.title = t('model.recommendedTip');
    name.append(' ', rec);
  }
  const hint = document.createElement('div');
  hint.className = 'mhint';
  hint.textContent = hintFor(id, entry);
  info.append(name, hint);

  const selectThis = () => {
    if (id === active) return;
    if (kind === 'cleanup') {
      void save(
        { polish: { ...settings.polish, localModel: id as Settings['polish']['localModel'] } },
        t('toast.activeModel', { model: labelFor(id) }),
      ).then(renderCleanup);
      return;
    }
    selectedModel = id;
    void save(
      { engine: { ...settings.engine, model: id as WhisperModelId } },
      t('toast.activeModel', { model: labelFor(id) }),
    );
    renderAll();
  };
  radio.addEventListener('click', selectThis);
  info.addEventListener('click', selectThis);

  const sizeEl = document.createElement('span');
  sizeEl.className = 'msize';
  sizeEl.textContent = entry.downloaded && entry.sizeOnDisk ? fmtBytes(entry.sizeOnDisk) : entry.size;

  const badge = document.createElement('span');
  badge.className = 'mbadge';
  if (busy) {
    badge.textContent = status.state === 'downloading' ? `%${status.progress ?? 0}` : t('model.preparing');
  } else if (entry.downloaded) {
    badge.textContent = t('model.ready');
  } else {
    badge.textContent = t('model.notDownloaded');
    badge.classList.add('dim');
  }

  row.append(radio, info, sizeEl, badge);

  if (!busy && !entry.downloaded) {
    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'btn-dl';
    dl.textContent = t('model.download');
    dl.addEventListener('click', (e) => {
      e.stopPropagation();
      const start =
        kind === 'cleanup' ? window.msSettings.ensureCleanup(id) : window.msSettings.ensureModel(id as WhisperModelId);
      void start.then((res) => {
        if (!res.started) toast(t('toast.dlFailed'), true);
      });
    });
    row.append(dl);
  } else if (withMenu && !busy && entry.downloaded) {
    const dots = document.createElement('button');
    dots.type = 'button';
    dots.className = 'dots';
    dots.textContent = '⋮';
    dots.addEventListener('click', (e) => {
      e.stopPropagation();
      openPopup(id, dots, kind);
    });
    row.append(dots);
  } else {
    const spacer = document.createElement('span');
    spacer.style.width = '32px';
    row.append(spacer);
  }

  if (status?.state === 'downloading') {
    const prog = document.createElement('div');
    prog.className = 'progress mprogress';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = `${status.progress ?? 0}%`;
    prog.append(fill);
    row.append(prog);
  }
  if (status?.state === 'error') {
    const err = document.createElement('div');
    err.className = 'merror';
    err.textContent = status.message ?? 'Error';
    row.append(err);
  }
  return row;
}

/** Visible text of a select's current option (already translated). */
function selectedText(id: string): string {
  const sel = $(id) as HTMLSelectElement;
  return sel.selectedOptions[0]?.textContent ?? '—';
}

/** General page: read-only overview of the current setup. Changes happen
 *  on each section's own page; only on/off switches live here. */
function renderSummary(): void {
  $('sumModel').textContent = labelFor(selectedModel);
  $('sumEngine').textContent = selectedModel.startsWith('ggml-') ? t('model.engine.cpp', { gpu: gpuApi() }) : t('model.engine.tjs');
  ($('language') as HTMLSelectElement).value = settings.engine.language;
  $('sumLang').textContent = selectedText('language');

  const builtin = settings.polish.engine === 'builtin';
  $('sumCleanupEngine').textContent = t(builtin ? 'cleanup.engine.builtin' : 'cleanup.engine.ollama');
  $('sumCleanupModel').textContent = builtin ? labelFor(settings.polish.localModel) : settings.polish.model || '—';

  ($('pasteMode2') as HTMLSelectElement).value = settings.pasteMode;
  ($('overlayPosition2') as HTMLSelectElement).value = settings.overlayPosition;
  ($('uiLang') as HTMLSelectElement).value = settings.uiLanguage || 'auto';
  $('sumPaste').textContent = selectedText('pasteMode2');
  $('sumOverlay').textContent = selectedText('overlayPosition2');
  $('sumUiLang').textContent = selectedText('uiLang');
}

function renderModelList(): void {
  const host = $('modelList');
  host.textContent = '';
  const ids = Object.keys(modelCatalog);
  const custom = (id: string) => Boolean(modelCatalog[id].custom);
  const groups: [string, (id: string) => boolean][] = [
    [t('model.groupCuda'), (id) => !custom(id) && id.startsWith('ggml-')],
    [t('model.groupWebgpu'), (id) => !custom(id) && !id.startsWith('ggml-')],
    [t('custom.group'), custom],
  ];
  for (const [label, match] of groups) {
    const groupIds = ids.filter(match);
    if (!groupIds.length) continue;
    const g = document.createElement('div');
    g.className = 'model-group';
    g.textContent = label;
    host.append(g);
    for (const id of groupIds) host.append(modelRow(id, modelCatalog[id], true));
  }
}

function renderStatus(): void {
  const ready = Boolean(modelCatalog[selectedModel]?.downloaded);
  $('brandDot').className = ready ? 'dot ok' : 'dot';
  $('brandStatus').textContent = ready ? t('brand.ready') : t('brand.needModel');
  $('readyDot').className = ready ? 'dot ok big' : 'dot big';
  $('readyTitle').textContent = ready ? t('strip.ready') : t('strip.noModel');
  $('readySub').textContent = ready
    ? t('strip.readySub', { model: labelFor(selectedModel) })
    : t('strip.noModelSub');
  $('hotkeyPill').textContent = settings.hotkey;
  $('hotkeyPill2').textContent = settings.hotkey;
  $('cancelPill').textContent = settings.cancelKey || 'Escape';
}

/* ── Onboarding ────────────────────────────────────────────── */
let hardware: HardwareInfo | null = null;
let hasWebGpu = false;

const anySpeechModel = (): boolean => Object.values(modelCatalog).some((e) => e.downloaded);

/** A first model that fits this computer — a suggestion, never a requirement. */
function suggestion(): { id: string; why: string } {
  // unknown VRAM: NVIDIA cards without nvidia-smi are rare and usually big;
  // on AMD/Intel it often means an integrated GPU
  const vram = hardware?.vramMb ?? (hardware?.nvidia ? 8192 : 0);
  // Integrated AMD/Intel GPUs (little dedicated memory) are slower through
  // whisper.cpp Vulkan than a small WebGPU model, so only cards get it.
  if (hardware?.backend && (hardware.nvidia || vram >= 2048)) {
    return vram >= 4000
      ? { id: 'ggml-large-v3-turbo-q5', why: t('onb.why.cudaBig') }
      : { id: 'ggml-small-q5', why: t('onb.why.cudaSmall') };
  }
  return { id: 'whisper-base', why: hasWebGpu ? t('onb.why.webgpu') : t('onb.why.cpu') };
}

/** Name of the native engine's GPU API on this computer, for labels. */
const gpuApi = (): string => (hardware?.backend === 'vulkan' ? 'Vulkan' : 'NVIDIA CUDA');

function renderOnboarding(): void {
  $('navStart').classList.toggle('hidden', anySpeechModel());
  if (!hardware) return;
  $('onbHw').textContent = hardware.backend
    ? t('onb.hw.gpu', {
        name: hardware.gpuName ?? (hardware.nvidia ? 'NVIDIA' : 'GPU'),
        vram: hardware.vramMb ? ` · ${(hardware.vramMb / 1024).toFixed(0)} GB` : '',
      })
    : hasWebGpu
      ? t('onb.hw.webgpu')
      : t('onb.hw.cpu');
  const { id, why } = suggestion();
  const host = $('onbSuggest');
  host.textContent = '';
  const entry = modelCatalog[id];
  if (entry) host.append(modelRow(id, entry, false));
  $('onbWhy').textContent = why;
  const ready = Boolean(entry?.downloaded);
  const busy = rowStatus.has(id);
  const auto = $('onbAuto') as HTMLButtonElement;
  auto.textContent = ready ? t('onb.done') : t('onb.auto');
  auto.disabled = busy;
}

async function onboardingAuto(): Promise<void> {
  const { id } = suggestion();
  if (modelCatalog[id]?.downloaded) {
    showPage('genel');
    return;
  }
  selectedModel = id;
  await save({ engine: { ...settings.engine, model: id as WhisperModelId } }, t('toast.activeModel', { model: labelFor(id) }));
  const res = await window.msSettings.ensureModel(id as WhisperModelId);
  if (!res.started) toast(t('toast.dlFailed'), true);
  renderAll();
}

function renderAll(): void {
  renderModelList();
  renderOnboarding();
  renderStatus();
  renderSummary();
}

/* ── Text cleanup (built-in engine / Ollama) ───────────────── */
function renderCleanup(): void {
  const host = $('cleanupModelList');
  host.textContent = '';
  const ids = Object.keys(cleanupCatalog);
  for (const id of ids.filter((i) => !cleanupCatalog[i].custom)) host.append(modelRow(id, cleanupCatalog[id], true, 'cleanup'));
  const customIds = ids.filter((i) => cleanupCatalog[i].custom);
  if (customIds.length) {
    const g = document.createElement('div');
    g.className = 'model-group';
    g.textContent = t('custom.group');
    host.append(g);
    for (const id of customIds) host.append(modelRow(id, cleanupCatalog[id], true, 'cleanup'));
  }

  const builtin = settings.polish.engine === 'builtin';
  ($('polishEngine2') as HTMLSelectElement).value = settings.polish.engine;
  $('builtinBox2').classList.toggle('hidden', !builtin);
  $('ollamaBox2').classList.toggle('hidden', builtin);
  ($('idleUnload') as HTMLSelectElement).value = String(settings.polish.idleUnloadMin);
  ($('cleanupDevice') as HTMLSelectElement).value = settings.polish.device;
  renderSummary();
  void refreshPolishConn();
}

function applyCleanupStatus(status: CleanupStatus): void {
  cleanupRowStatus.set(status.model, status);
  if (status.state === 'ready' || status.state === 'error') {
    void window.msSettings.getCleanupStates().then((catalog) => {
      cleanupCatalog = catalog;
      if (status.state === 'ready') cleanupRowStatus.delete(status.model);
      renderCleanup();
    });
    if (status.state === 'ready') toast(t('toast.modelReady'));
    return;
  }
  renderCleanup();
}

function applyModelStatus(status: ModelStatus): void {
  rowStatus.set(status.model, status);
  if (status.state === 'ready' || status.state === 'error') {
    void window.msSettings.getModelStates().then((catalog) => {
      modelCatalog = catalog;
      rowStatus.delete(status.model);
      renderAll();
    });
    if (status.state === 'ready') toast(t('toast.modelReady'));
    return;
  }
  renderAll();
}

/* ── Ollama connection state ───────────────────────────────── */
async function refreshPolishConn(): Promise<void> {
  const dot = $('polishDot');
  const text = $('polishConnText');
  if (!settings.polish.enabled) {
    dot.className = 'dot';
    text.textContent = t('polish.off');
    return;
  }
  if (settings.polish.engine === 'builtin') {
    const ready = Boolean(cleanupCatalog[settings.polish.localModel]?.downloaded);
    dot.className = ready ? 'dot ok' : 'dot';
    text.textContent = ready ? t('cleanup.ready') : t('cleanup.needModel');
    return;
  }
  text.textContent = t('polish.testing');
  dot.className = 'dot';
  const res = await window.msSettings.testPolish(settings.polish);
  dot.className = res.ok ? 'dot ok' : 'dot';
  text.textContent = res.ok ? t('polish.connected') : t('polish.disconnected');
}

/* ── Hotkey capture ────────────────────────────────────────── */
function accelFromEvent(e: KeyboardEvent, requireModifier: boolean): string | null {
  const MODIFIERS = ['Control', 'Alt', 'Shift', 'Meta'];
  if (MODIFIERS.includes(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');

  let key: string | null = null;
  if (/^[a-z]$/i.test(e.key)) key = e.key.toUpperCase();
  else if (/^[0-9]$/.test(e.key)) key = e.key;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
  else if (e.key === 'CapsLock') key = 'CapsLock';
  else {
    const map: Record<string, string> = {
      ' ': 'Space',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Enter: 'Enter',
      Tab: 'Tab',
      ',': ',',
      '.': '.',
      '/': '/',
      ';': ';',
      '[': '[',
      ']': ']',
      '\\': '\\',
      '-': '-',
      '=': '=',
      '`': '`',
    };
    key = map[e.key] ?? null;
  }
  if (!key) return null;
  parts.push(key);
  const bareAllowed = key === 'CapsLock' || /^F\d{1,2}$/.test(key);
  if (requireModifier && parts.length < 2 && !bareAllowed) return null;
  return parts.join('+');
}

function attachHotkeyCapture(input: HTMLInputElement, requireModifier: boolean, onSave: (v: string) => void): void {
  input.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Backspace') {
      input.value = '';
      input.classList.remove('listening');
      return;
    }
    const accel = accelFromEvent(e, requireModifier);
    if (accel) {
      input.value = accel;
      input.classList.remove('listening');
      input.blur();
      onSave(accel);
    }
  });
  input.addEventListener('focus', () => input.classList.add('listening'));
  input.addEventListener('blur', () => input.classList.remove('listening'));
}

/* ── History ───────────────────────────────────────────────── */
const DATE_LOCALES: Record<I18nPayload['lang'], string> = {
  en: 'en-US',
  tr: 'tr-TR',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  ru: 'ru-RU',
};

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString(DATE_LOCALES[i18n.lang], {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderHistory(): void {
  const query = ($('historySearch') as HTMLInputElement).value.trim().toLocaleLowerCase(DATE_LOCALES[i18n.lang]);
  const visible = query
    ? historyEntries.filter((e) => e.text.toLocaleLowerCase(DATE_LOCALES[i18n.lang]).includes(query))
    : historyEntries;

  const list = $('historyList');
  list.textContent = '';
  $('historyEmpty').classList.toggle('hidden', visible.length > 0);

  for (const entry of visible) {
    const card = document.createElement('div');
    card.className = 'hentry';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = fmtDate(entry.ts);
    const dur = document.createElement('span');
    dur.textContent = `${(entry.durationMs / 1000).toFixed(1)} s`;
    const chars = document.createElement('span');
    chars.textContent = t('history.chars', { n: entry.chars });
    meta.append(date, dur, chars);

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = entry.text;

    const actions = document.createElement('div');
    actions.className = 'actions';
    const mk = (labelKey: string, doneKey: string, fn: () => Promise<void>) => {
      const b = document.createElement('button');
      b.type = 'button';
      const label = t(labelKey);
      b.textContent = label;
      b.addEventListener('click', async () => {
        try {
          await fn();
          b.textContent = t(doneKey);
          setTimeout(() => (b.textContent = label), 1200);
        } catch {
          b.textContent = t('history.failed');
          setTimeout(() => (b.textContent = label), 1200);
        }
      });
      return b;
    };
    actions.append(
      mk('history.copy', 'history.copied', () => navigator.clipboard.writeText(entry.text)),
      mk('history.repaste', 'history.inserted', () => window.msSettings.historyRepaste(entry.text)),
      mk('history.delete', 'history.deleted', async () => {
        await window.msSettings.historyRemove(entry.id);
        historyEntries = historyEntries.filter((e) => e.id !== entry.id);
        renderHistory();
      }),
    );

    card.append(meta, text, actions);
    list.append(card);
  }
}

async function loadHistory(): Promise<void> {
  historyEntries = await window.msSettings.historyList();
  renderHistory();
}

/* ── Updates (Behavior page) ───────────────────────────────── */
let update: UpdateStatus | null = null;

function renderUpdate(): void {
  if (!update) return;
  const u = update;
  const version = u.version ?? '';
  const status = $('updateStatus');
  const texts: Record<UpdateStatus['state'], [string, string]> = {
    unsupported: [t('updates.unsupported'), ''],
    idle: ['', ''],
    checking: [t('updates.checking'), ''],
    none: [t('updates.none'), ''],
    available: [t('updates.available', { version }), 'new'],
    downloading: [t('updates.downloading', { version, progress: u.progress ?? 0 }), 'new'],
    downloaded: [t('updates.ready', { version }), 'new'],
    error: [t('updates.error'), 'err'],
  };
  const [text, kind] = texts[u.state];
  $('updateVersion').textContent = t('updates.current', { version: u.current });
  status.textContent = text;
  status.dataset.kind = kind;
  status.title = u.state === 'error' ? (u.message ?? '') : '';
  ($('updateCheck') as HTMLButtonElement).disabled = ['unsupported', 'checking', 'downloading'].includes(u.state);
  const install = $('updateInstall') as HTMLButtonElement;
  install.classList.toggle('hidden', u.state !== 'available' && u.state !== 'downloaded');
  install.textContent = t(u.state === 'downloaded' ? 'updates.restart' : 'updates.install');
}

/* ── Paired controls (General ↔ own page) ──────────────────── */
function pair(a: string, b: string, apply: (el: HTMLInputElement, v: boolean) => void, read: (el: HTMLInputElement) => boolean, saveFn: (v: boolean) => void): void {
  const elA = $(a) as unknown as HTMLInputElement;
  const elB = $(b) as unknown as HTMLInputElement;
  elA.addEventListener('change', () => {
    const v = read(elA);
    apply(elB, v);
    saveFn(v);
  });
  elB.addEventListener('change', () => {
    const v = read(elB);
    apply(elA, v);
    saveFn(v);
  });
}

/* ── Init ──────────────────────────────────────────────────── */
async function init(): Promise<void> {
  settings = await window.msSettings.get();
  selectedModel = settings.engine.model;
  i18n = await window.msSettings.getI18n();
  initTitleBar();

  fillLangSelect();

  // General page controls
  ($('language') as HTMLSelectElement).value = settings.engine.language;
  ($('polishEnabled') as HTMLInputElement).checked = settings.polish.enabled;
  ($('liveDrafts') as HTMLInputElement).checked = settings.liveDrafts;
  ($('dictionary') as HTMLTextAreaElement).value = settings.dictionary;

  // Paired controls on their own pages
  ($('polishEnabled2') as HTMLInputElement).checked = settings.polish.enabled;
  ($('polishUrl2') as HTMLInputElement).value = settings.polish.baseUrl;
  ($('polishModel2') as HTMLInputElement).value = settings.polish.model;
  ($('liveDrafts2') as HTMLInputElement).checked = settings.liveDrafts;
  ($('pasteMode2') as HTMLSelectElement).value = settings.pasteMode;
  ($('overlayPosition2') as HTMLSelectElement).value = settings.overlayPosition;
  ($('launchOnStartup') as HTMLInputElement).checked = settings.launchOnStartup;
  ($('launchOnStartup1') as HTMLInputElement).checked = settings.launchOnStartup;
  ($('hotkey') as HTMLInputElement).value = settings.hotkey;
  ($('cancelKey') as HTMLInputElement).value = settings.cancelKey;
  ($('holdToStart') as HTMLSelectElement).value = String(settings.holdToStartMs);

  // Paired toggles
  pair('polishEnabled', 'polishEnabled2', (el, v) => (el.checked = v), (el) => el.checked, (v) => {
    void save({ polish: { ...settings.polish, enabled: v } }).then(() => void refreshPolishConn());
  });
  pair('liveDrafts', 'liveDrafts2', (el, v) => (el.checked = v), (el) => el.checked, (v) => {
    void save({ liveDrafts: v });
  });

  // Text/select controls (each lives only on its own page)
  const onChange = (id: string, saveFn: (v: string) => void) => {
    const el = $(id) as HTMLInputElement;
    el.addEventListener('change', () => saveFn(el.value));
  };
  onChange('polishUrl2', (v) => void save({ polish: { ...settings.polish, baseUrl: v.trim() } }));
  onChange('polishModel2', (v) => void save({ polish: { ...settings.polish, model: v.trim() } }));
  onChange('pasteMode2', (v) => void save({ pasteMode: v as Settings['pasteMode'] }));
  onChange('holdToStart', (v) => void save({ holdToStartMs: Number(v) }).then(renderStatus));
  onChange('overlayPosition2', (v) => void save({ overlayPosition: v as Settings['overlayPosition'] }));

  $('language').addEventListener('change', () => {
    void save({ engine: { ...settings.engine, language: ($('language') as HTMLSelectElement).value } });
  });
  pair('launchOnStartup', 'launchOnStartup1', (el, v) => (el.checked = v), (el) => el.checked, (v) => {
    void save({ launchOnStartup: v });
  });

  // Updates
  ($('updateNotify') as HTMLInputElement).checked = settings.updateNotify;
  $('updateNotify').addEventListener('change', () => {
    void save({ updateNotify: ($('updateNotify') as HTMLInputElement).checked });
  });
  $('updateCheck').addEventListener('click', () => void window.msSettings.checkUpdate());
  $('updateInstall').addEventListener('click', () => void window.msSettings.installUpdate());
  update = await window.msSettings.getUpdate();
  window.msSettings.onUpdateStatus((s) => {
    update = s;
    renderUpdate();
  });

  // Text cleanup engine (General card ↔ Text cleanup page)
  onChange('polishEngine2', (v) => {
    void save({ polish: { ...settings.polish, engine: v as Settings['polish']['engine'] } }).then(renderCleanup);
  });
  $('idleUnload').addEventListener('change', () => {
    const v = Number(($('idleUnload') as HTMLSelectElement).value) || 0;
    void save({ polish: { ...settings.polish, idleUnloadMin: v } });
  });
  // Personal dictionary: saved when the box loses focus and by the Save button
  const saveDictionary = async (): Promise<void> => {
    const value = ($('dictionary') as HTMLTextAreaElement).value;
    await save({ dictionary: value });
    const terms = new Set(value.split(/[\n\r,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)).size;
    $('dictionaryResult').textContent = t('dict.saved', { count: String(terms), first: String(Math.min(terms, 8)) });
  };
  $('dictionary').addEventListener('change', () => void saveDictionary());
  $('dictionarySave').addEventListener('click', () => void saveDictionary());
  $('dictionary').addEventListener('input', () => {
    $('dictionaryResult').textContent = '';
  });
  $('cleanupDevice').addEventListener('change', () => {
    const v = ($('cleanupDevice') as HTMLSelectElement).value === 'cpu' ? 'cpu' : 'gpu';
    void save({ polish: { ...settings.polish, device: v } });
  });

  // UI language — applies instantly.
  $('uiLang').addEventListener('change', () => {
    const v = ($('uiLang') as HTMLSelectElement).value;
    // main broadcasts i18n:changed when the resolved language actually changes
    void save({ uiLanguage: v });
  });

  // Ollama test buttons
  const testPolish = async (resultEl: HTMLElement) => {
    resultEl.textContent = t('polish.testing');
    const res = await window.msSettings.testPolish({
      ...settings.polish,
      enabled: true,
      baseUrl: ($('polishUrl2') as HTMLInputElement).value.trim(),
      model: ($('polishModel2') as HTMLInputElement).value.trim(),
    });
    resultEl.textContent = res.message;
    resultEl.dataset.kind = res.ok ? 'ok' : 'err';
    void refreshPolishConn();
  };
  $('testPolish2').addEventListener('click', () => void testPolish($('testPolishResult2')));

  // Hotkey capture
  attachHotkeyCapture($('hotkey') as HTMLInputElement, true, (v) => {
    void save({ hotkey: v }).then(renderStatus);
  });
  attachHotkeyCapture($('cancelKey') as HTMLInputElement, false, (v) => {
    void save({ cancelKey: v }).then(renderStatus);
  });

  // Page navigation
  document.querySelectorAll('#nav button').forEach((b) => {
    b.addEventListener('click', () => showPage((b as HTMLButtonElement).dataset.page as Page));
  });
  document.querySelectorAll<HTMLElement>('[data-goto]').forEach((b) => {
    b.addEventListener('click', () => showPage(b.dataset.goto as Page));
  });
  $('gotoHotkeys').addEventListener('click', () => showPage('kisayollar'));
  $('hotkeyPill').addEventListener('click', () => showPage('kisayollar'));
  $('hotkeyPill2').addEventListener('click', () => showPage('kisayollar'));
  $('cancelPill').addEventListener('click', () => showPage('kisayollar'));

  // Tray → "History" opens the settings window on the history page.
  window.msSettings.onOpenPage((p) => showPage(p as Page));

  // History
  $('historySearch').addEventListener('input', renderHistory);
  $('clearHistory').addEventListener('click', async () => {
    await window.msSettings.historyClear();
    historyEntries = [];
    renderHistory();
    toast(t('toast.historyCleared'));
  });

  // Info modal
  $('infoClose').addEventListener('click', () => $('infoModal').classList.add('hidden'));
  $('infoModal').addEventListener('click', (e) => {
    if (e.target === $('infoModal')) $('infoModal').classList.add('hidden');
  });

  $('onbAuto').addEventListener('click', () => void onboardingAuto());
  $('onbManual').addEventListener('click', () => showPage('modeller'));

  modelCatalog = await window.msSettings.getModelStates();
  cleanupCatalog = await window.msSettings.getCleanupStates();
  applyI18n();
  // First start (or every model deleted): nothing is downloaded until the
  // user picks something on the onboarding page.
  if (!anySpeechModel()) showPage('baslangic');
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  hasWebGpu = Boolean(gpu && (await gpu.requestAdapter().catch(() => null)));
  hardware = await window.msSettings.getHardware();
  if (hardware.backend === 'vulkan') applyI18n(); // engine labels name the GPU API
  renderOnboarding();

  window.msSettings.onModelStatus(applyModelStatus);
  window.msSettings.onCleanupStatus(applyCleanupStatus);
  window.msSettings.onI18nChanged((p) => {
    i18n = p;
    applyI18n();
  });
}

void init();
