// MindScript — auto-update wiring (electron-updater).
// Only active in the packaged app and only when a `publish` provider is
// configured in package.json (GitHub Releases). Silent on any failure:
// dictation must never break because of an update check.
import { app, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';
import { tMain } from './lang';

export function setupAutoUpdater(log: (event: string, detail?: string) => void): void {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => log('update-check'));
  autoUpdater.on('update-available', (info) => log('update-available', info.version));
  autoUpdater.on('update-not-available', () => log('update-none'));
  autoUpdater.on('error', (err) => log('update-error', err.message));

  autoUpdater.on('update-downloaded', (info) => {
    log('update-downloaded', info.version);
    const n = new Notification({
      title: tMain('update.title'),
      body: tMain('update.body', { version: info.version }),
    });
    n.on('click', () => autoUpdater.quitAndInstall());
    n.show();
  });

  // First check shortly after start, then every 6 hours.
  setTimeout(() => void autoUpdater.checkForUpdates().catch(() => undefined), 15_000);
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => undefined), 6 * 60 * 60 * 1000);
}
