// MindScript — updates from GitHub Releases (electron-updater).
// Two modes, switched on the Behavior page (Settings.updateNotify):
//   on  — new versions download in the background, a notification says when
//         one is ready and it installs when the app quits;
//   off — the app only checks; the Behavior page shows the new version and
//         downloads + installs it when the user clicks Update.
// Only active in the packaged app. Silent on any failure: dictation must never
// break because of an update check.
import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';
import { Channels, UpdateStatus } from '../shared/ipc';
import { tMain } from './lang';

let status: UpdateStatus = { state: 'idle', current: app.getVersion() };
let notify = true;
/** the user clicked Update before the download finished */
let installWhenDownloaded = false;

function setStatus(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(Channels.updateStatus, status);
  }
}

// Silent install, then start the new version.
const install = () => autoUpdater.quitAndInstall(true, true);

function checkNow(): void {
  if (status.state === 'unsupported') return;
  void autoUpdater.checkForUpdates().catch((err: Error) => setStatus({ state: 'error', message: err.message }));
}

function installNow(): void {
  if (status.state === 'downloaded') {
    install();
  } else if (status.state === 'available') {
    installWhenDownloaded = true;
    setStatus({ state: 'downloading', progress: 0 });
    void autoUpdater.downloadUpdate().catch((err: Error) => setStatus({ state: 'error', message: err.message }));
  }
}

export function setUpdateNotify(enabled: boolean): void {
  notify = enabled;
  autoUpdater.autoDownload = enabled;
  autoUpdater.autoInstallOnAppQuit = enabled;
}

export function setupAutoUpdater(log: (event: string, detail?: string) => void, notifyUpdates: boolean): void {
  ipcMain.handle(Channels.updateGet, () => status);
  ipcMain.handle(Channels.updateCheck, () => checkNow());
  ipcMain.handle(Channels.updateInstall, () => installNow());

  if (!app.isPackaged) {
    status = { ...status, state: 'unsupported' };
    return;
  }
  setUpdateNotify(notifyUpdates);

  autoUpdater.on('checking-for-update', () => {
    log('update-check');
    // a finished download stays ready to install; don't hide it behind a re-check
    if (status.state !== 'downloaded' && status.state !== 'downloading') setStatus({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    log('update-available', info.version);
    if (status.state === 'downloaded' && status.version === info.version) return;
    setStatus({ state: notify ? 'downloading' : 'available', version: info.version, progress: 0 });
  });
  autoUpdater.on('update-not-available', () => {
    log('update-none');
    setStatus({ state: 'none', version: undefined });
  });
  autoUpdater.on('download-progress', (p) => setStatus({ state: 'downloading', progress: Math.round(p.percent) }));
  autoUpdater.on('error', (err) => {
    log('update-error', err.message);
    setStatus({ state: 'error', message: err.message });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log('update-downloaded', info.version);
    setStatus({ state: 'downloaded', version: info.version, progress: 100 });
    if (installWhenDownloaded) {
      install();
      return;
    }
    if (!notify) return;
    const n = new Notification({
      title: tMain('update.title'),
      body: tMain('update.body', { version: info.version }),
    });
    n.on('click', install);
    n.show();
  });

  // First check shortly after start, then every 6 hours.
  setTimeout(checkNow, 15_000);
  setInterval(checkNow, 6 * 60 * 60 * 1000);
}
