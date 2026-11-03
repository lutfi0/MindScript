// The settings window (history lives on one of its pages). Singleton —
// reopening from the tray just focuses the existing one.
import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';

type WinId = 'settings';

const windows = new Map<WinId, BrowserWindow>();

function create(id: WinId, width: number, height: number): BrowserWindow {
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 760,
    minHeight: 520,
    autoHideMenuBar: true,
    // Settings draws its own title bar; 'hidden' keeps the native resize
    // border, shadow and Aero Snap that frame:false would lose.
    titleBarStyle: 'hidden',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', `${id}.js`),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  const sendMax = () => {
    if (!win.isDestroyed()) win.webContents.send('win:maximized', win.isMaximized());
  };
  win.on('maximize', sendMax);
  win.on('unmaximize', sendMax);
  win.on('closed', () => windows.delete(id));
  void win.loadFile(path.join(__dirname, '..', 'renderer', id, 'index.html'));
  return win;
}

export function openWindow(id: WinId): void {
  const existing = windows.get(id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  windows.set(id, create(id, 1180, 820));
}

/** Opens the settings window and switches it to the given page. */
export function openSettingsPage(page: string): void {
  openWindow('settings');
  const win = windows.get('settings');
  if (!win || win.isDestroyed()) return;
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send('settings:page', page);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

/** Custom title-bar buttons: each acts on the window that sent it. */
export function registerWindowControls(): void {
  const from = (e: Electron.IpcMainEvent) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.on('win:minimize', (e) => from(e)?.minimize());
  ipcMain.on('win:toggle-maximize', (e) => {
    const win = from(e);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('win:close', (e) => from(e)?.close());
  ipcMain.handle('win:is-maximized', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false);
}
