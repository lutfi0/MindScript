// The floating dictation pill. Borderless, transparent, always-on-top and —
// critically — non-focusable, so the user's target app keeps keyboard focus
// for the whole record → transcribe → paste cycle.
import { BrowserWindow, screen } from 'electron';
import * as path from 'node:path';
import { OverlayCommand, OverlayStateMsg, Settings } from '../shared/ipc';

const WIDTH = 560;
const HEIGHT = 148;

export class OverlayController {
  private win: BrowserWindow | null = null;
  private lastPosition: Settings['overlayPosition'] = 'bottom-center';
  /** Messages sent before the page finishes loading would be silently
   *  dropped (first dictation after launch) — queue and flush on load. */
  private loaded = false;
  private pending: Array<() => void> = [];

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The pill is transparent + never focused: Chromium otherwise treats it
        // as an occluded/background page and freezes its timers, rAF and even
        // MediaRecorder events — the timer sticks at 0:00 and the recording
        // never reaches the main process. Keep this page fully alive.
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(false);
    win.webContents.once('did-finish-load', () => {
      this.loaded = true;
      for (const send of this.pending.splice(0)) send();
    });
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay', 'index.html'));
    return win;
  }

  /** Send to the overlay page, queueing until it has finished loading. */
  private deliver(fn: (win: BrowserWindow) => void): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.loaded) {
        fn(this.win);
      } else {
        const win = this.win;
        this.pending.push(() => {
          if (!win.isDestroyed()) fn(win);
        });
      }
    }
  }

  private ensure(): BrowserWindow {
    if (!this.win || this.win.isDestroyed()) {
      this.loaded = false;
      this.win = this.create();
    }
    return this.win;
  }

  private positionFor(mode: Settings['overlayPosition']): { x: number; y: number } {
    let workArea = screen.getPrimaryDisplay().workArea;
    if (mode === 'near-cursor') {
      const pt = screen.getCursorScreenPoint();
      workArea = screen.getDisplayNearestPoint(pt).workArea;
    }
    return {
      x: Math.round(workArea.x + (workArea.width - WIDTH) / 2),
      y: Math.round(workArea.y + workArea.height - HEIGHT - 64),
    };
  }

  /** Creates the (hidden) window at app start so the page can pre-warm the
   *  microphone — the first dictation then starts without the driver stall. */
  prewarm(): void {
    this.ensure();
  }

  show(position: Settings['overlayPosition']): void {
    this.lastPosition = position;
    const win = this.ensure();
    const { x, y } = this.positionFor(position);
    win.setPosition(x, y, false);
    win.showInactive();
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  sendState(state: OverlayStateMsg): void {
    this.deliver((win) => win.webContents.send('overlay:state', state));
  }

  /** Live draft transcript while still recording. */
  sendPartial(text: string): void {
    this.deliver((win) => win.webContents.send('overlay:partial', text));
  }

  sendCommand(cmd: OverlayCommand): void {
    this.deliver((win) => win.webContents.send('overlay:command', cmd));
  }
}
