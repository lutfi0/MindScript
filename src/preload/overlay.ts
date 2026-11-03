import { contextBridge, ipcRenderer } from 'electron';
import type { I18nPayload } from '../shared/i18n';
import type { OverlayCommand, OverlayStateMsg } from '../shared/ipc';

// Channel literals are duplicated here because sandboxed preloads cannot
// require local modules; keep in sync with shared/ipc.ts Channels.
const api = {
  onState(cb: (state: OverlayStateMsg) => void): () => void {
    const listener = (_e: unknown, state: OverlayStateMsg) => cb(state);
    ipcRenderer.on('overlay:state', listener);
    return () => ipcRenderer.removeListener('overlay:state', listener);
  },
  onPartial(cb: (text: string) => void): () => void {
    const listener = (_e: unknown, text: string) => cb(text);
    ipcRenderer.on('overlay:partial', listener);
    return () => ipcRenderer.removeListener('overlay:partial', listener);
  },
  onCommand(cb: (cmd: OverlayCommand) => void): () => void {
    const listener = (_e: unknown, cmd: OverlayCommand) => cb(cmd);
    ipcRenderer.on('overlay:command', listener);
    return () => ipcRenderer.removeListener('overlay:command', listener);
  },
  started(): void {
    ipcRenderer.send('overlay:recording-started');
  },
  failed(message: string): void {
    ipcRenderer.send('overlay:recording-error', message);
  },
  audio(data: Uint8Array, mime: string, durationMs: number): void {
    ipcRenderer.send('overlay:audio', data, mime, durationMs);
  },
  /** audio-so-far while still recording — powers the live draft */
  interim(data: Uint8Array, mime: string, durationMs: number): void {
    ipcRenderer.send('overlay:interim', data, mime, durationMs);
  },
  cancelled(): void {
    ipcRenderer.send('overlay:cancelled');
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
};

contextBridge.exposeInMainWorld('msOverlay', api);
