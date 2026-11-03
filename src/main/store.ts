import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_SETTINGS,
  HISTORY_LIMIT,
  HOLD_TO_START_OPTIONS,
  HistoryEntry,
  PolishSettings,
  Settings,
  isCleanupModel,
  WHISPER_MODELS,
  WhisperModelId,
} from '../shared/ipc';

function userDataFile(name: string): string {
  return path.join(app.getPath('userData'), name);
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

function mergeSection<T extends object>(defaults: T, loaded: unknown): T {
  if (!loaded || typeof loaded !== 'object') return { ...defaults };
  return { ...defaults, ...(loaded as Partial<T>) };
}

function loadPolish(defaults: PolishSettings, loaded: unknown): PolishSettings {
  const p = mergeSection(defaults, loaded);
  const rawEngine = (loaded as Partial<PolishSettings> | undefined)?.engine;
  // Settings from before the built-in engine existed: whoever already had
  // cleanup on was using Ollama, so keep them there.
  if (rawEngine !== 'builtin' && rawEngine !== 'ollama') p.engine = p.enabled ? 'ollama' : 'builtin';
  if (!isCleanupModel(p.localModel)) p.localModel = defaults.localModel;
  if (typeof p.idleUnloadMin !== 'number' || p.idleUnloadMin < 0) p.idleUnloadMin = defaults.idleUnloadMin;
  return p;
}

export class SettingsStore {
  private file = userDataFile('settings.json');

  /** false on first run, before any settings were saved */
  exists(): boolean {
    return fs.existsSync(this.file);
  }

  load(): Settings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Settings>;
      const d = DEFAULT_SETTINGS;
      const models = Object.keys(WHISPER_MODELS) as WhisperModelId[];
      const s: Settings = {
        engine: {
          model:
            typeof raw.engine?.model === 'string' && models.includes(raw.engine.model)
              ? raw.engine.model
              : d.engine.model,
          language: typeof raw.engine?.language === 'string' ? raw.engine.language : '',
        },
        polish: loadPolish(d.polish, raw.polish),
        hotkey: typeof raw.hotkey === 'string' && raw.hotkey ? raw.hotkey : d.hotkey,
        holdToStartMs: (HOLD_TO_START_OPTIONS as readonly number[]).includes(raw.holdToStartMs as number)
          ? (raw.holdToStartMs as number)
          : d.holdToStartMs,
        cancelKey: typeof raw.cancelKey === 'string' && raw.cancelKey ? raw.cancelKey : d.cancelKey,
        pasteMode: raw.pasteMode === 'clipboard-only' ? 'clipboard-only' : 'clipboard-paste',
        overlayPosition: raw.overlayPosition === 'near-cursor' ? 'near-cursor' : 'bottom-center',
        launchOnStartup: raw.launchOnStartup === true,
        liveDrafts: raw.liveDrafts !== false,
        uiLanguage: typeof raw.uiLanguage === 'string' ? raw.uiLanguage : 'auto',
      };
      return s;
    } catch {
      return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings;
    }
  }

  save(s: Settings): void {
    writeAtomic(this.file, JSON.stringify(s, null, 2));
  }
}

export class HistoryStore {
  private file = userDataFile('history.json');
  private entries: HistoryEntry[];

  constructor() {
    this.entries = this.read();
  }

  private read(): HistoryEntry[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) return raw as HistoryEntry[];
    } catch {
      // first run or corrupt file — start empty
    }
    return [];
  }

  private persist(): void {
    writeAtomic(this.file, JSON.stringify(this.entries.slice(0, HISTORY_LIMIT)));
  }

  list(): HistoryEntry[] {
    return [...this.entries];
  }

  add(entry: HistoryEntry): void {
    this.entries.unshift(entry);
    this.entries = this.entries.slice(0, HISTORY_LIMIT);
    this.persist();
  }

  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.persist();
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }
}
