import { contextBridge, ipcRenderer } from 'electron';
import type { I18nPayload } from '../shared/i18n';
import type { CleanupStatus, HistoryEntry, ModelCatalogEntry, ModelStatus, SaveResult, Settings, TestResult, WhisperModelId } from '../shared/ipc';

const api = {
  get(): Promise<Settings> {
    return ipcRenderer.invoke('settings:get');
  },
  save(partial: Partial<Settings>): Promise<SaveResult> {
    return ipcRenderer.invoke('settings:save', partial);
  },
  testPolish(polish: Settings['polish']): Promise<TestResult> {
    return ipcRenderer.invoke('test-polish', polish);
  },
  /** One-time local model download; progress arrives via onModelStatus. */
  ensureModel(model: WhisperModelId): Promise<{ started: boolean }> {
    return ipcRenderer.invoke('model:ensure', model);
  },
  /** Model catalogue: metadata, on-disk location and download state. */
  getModelStates(): Promise<Record<string, ModelCatalogEntry>> {
    return ipcRenderer.invoke('model:state');
  },
  /** Permanently deletes a downloaded model from disk. */
  deleteModel(model: WhisperModelId): Promise<{ ok: boolean; message?: string; settings?: Settings }> {
    return ipcRenderer.invoke('model:delete', model);
  },
  onModelStatus(cb: (status: ModelStatus) => void): () => void {
    const listener = (_e: unknown, status: ModelStatus) => cb(status);
    ipcRenderer.on('model:status', listener);
    return () => ipcRenderer.removeListener('model:status', listener);
  },
  /** Built-in cleanup models (llama.cpp): catalogue, download, delete. */
  getCleanupStates(): Promise<Record<string, ModelCatalogEntry>> {
    return ipcRenderer.invoke('cleanup:state');
  },
  ensureCleanup(model: string): Promise<{ started: boolean }> {
    return ipcRenderer.invoke('cleanup:ensure', model);
  },
  deleteCleanup(model: string): Promise<{ ok: boolean; message?: string; settings?: Settings }> {
    return ipcRenderer.invoke('cleanup:delete', model);
  },
  onCleanupStatus(cb: (status: CleanupStatus) => void): () => void {
    const listener = (_e: unknown, status: CleanupStatus) => cb(status);
    ipcRenderer.on('cleanup:status', listener);
    return () => ipcRenderer.removeListener('cleanup:status', listener);
  },
  historyList(): Promise<HistoryEntry[]> {
    return ipcRenderer.invoke('history:list');
  },
  historyRemove(id: string): Promise<void> {
    return ipcRenderer.invoke('history:delete', id);
  },
  historyClear(): Promise<void> {
    return ipcRenderer.invoke('history:clear');
  },
  historyRepaste(text: string): Promise<void> {
    return ipcRenderer.invoke('history:repaste', text);
  },
  /** Resolved UI language + dictionary (renderers cannot import shared/i18n). */
  getI18n(): Promise<I18nPayload> {
    return ipcRenderer.invoke('i18n:get');
  },
  onI18nChanged(cb: (p: I18nPayload) => void): () => void {
    const listener = (_e: unknown, p: I18nPayload) => cb(p);
    ipcRenderer.on('i18n:changed', listener);
    return () => ipcRenderer.removeListener('i18n:changed', listener);
  },
  /** Custom title bar controls. */
  winMinimize(): void {
    ipcRenderer.send('win:minimize');
  },
  winToggleMaximize(): void {
    ipcRenderer.send('win:toggle-maximize');
  },
  winClose(): void {
    ipcRenderer.send('win:close');
  },
  winIsMaximized(): Promise<boolean> {
    return ipcRenderer.invoke('win:is-maximized');
  },
  onMaximizedChanged(cb: (maximized: boolean) => void): () => void {
    const listener = (_e: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on('win:maximized', listener);
    return () => ipcRenderer.removeListener('win:maximized', listener);
  },
  /** Main asks the window to switch to a page (e.g. tray → History). */
  onOpenPage(cb: (page: string) => void): () => void {
    const listener = (_e: unknown, page: string) => cb(page);
    ipcRenderer.on('settings:page', listener);
    return () => ipcRenderer.removeListener('settings:page', listener);
  },
};

contextBridge.exposeInMainWorld('msSettings', api);
