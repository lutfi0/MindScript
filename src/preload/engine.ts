import { contextBridge, ipcRenderer } from 'electron';

const api = {
  onJob(
    cb: (job: { id: number; model: string; language: string; data: ArrayBuffer | Uint8Array; mime: string; offsetMs?: number; serverUrl?: string; prompt?: string }) => void,
  ): void {
    ipcRenderer.on('engine:job', (_e, job) => cb(job));
  },
  onLoad(cb: (msg: { model: string; serverUrl?: string }) => void): void {
    ipcRenderer.on('engine:load', (_e, msg) => cb(msg));
  },
  result(msg: { id: number; ok: boolean; text?: string; error?: string }): void {
    ipcRenderer.send('engine:result', msg);
  },
  status(msg: { state: string; model: string; message?: string }): void {
    ipcRenderer.send('engine:status', msg);
  },
};

contextBridge.exposeInMainWorld('msEngine', api);
