// The floating dictation pill. Borderless, always-on-top and —
// critically — non-focusable, so the user's target app keeps keyboard focus
// for the whole record → transcribe → paste cycle.
import { BrowserWindow, nativeTheme, screen } from 'electron';
import * as path from 'node:path';
import { OverlayCommand, OverlayStateMsg, Settings } from '../shared/ipc';

// The window is the pill itself: opaque, with Windows 11 drawing the rounded
// corners and the shadow. A transparent window with a CSS shadow had its
// shadow clipped at the window edge and stuttered, because Windows reads a
// transparent window back from the GPU every frame while Whisper is busy on it.
const WIDTH = 532;
const HEIGHT = 120;
/** Distance from the bottom of the work area (kept where the old pill sat). */
const BOTTOM_GAP = 78;

function pillBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#101010' : '#ffffff';
}

export class OverlayController {
  private win: BrowserWindow | null = null;
  private lastPosition: Settings['overlayPosition'] = 'bottom-center';
  /** Messages sent before the page finishes loading would be silently
   *  dropped (first dictation after launch) — queue and flush on load. */
  private loaded = false;
  private pending: Array<() => void> = [];
  private topTimer: NodeJS.Timeout | null = null;

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: false,
      roundedCorners: true,
      thickFrame: true, // gives the frameless window the native shadow
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: true,
      show: false,
      backgroundColor: pillBackground(),
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
    // If anything ever clears the topmost flag, put it back right away.
    win.on('always-on-top-changed', (_e, onTop) => {
      if (!onTop && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
    });
    const syncBackground = () => {
      if (!win.isDestroyed()) win.setBackgroundColor(pillBackground());
    };
    nativeTheme.on('updated', syncBackground);
    win.on('closed', () => {
      nativeTheme.off('updated', syncBackground);
      this.stopKeepOnTop();
    });
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
      y: Math.round(workArea.y + workArea.height - HEIGHT - BOTTOM_GAP),
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
    this.raise(win);
    this.startKeepOnTop(win);
  }

  hide(): void {
    this.stopKeepOnTop();
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  /** Re-asserts the topmost z-order. Other topmost windows (full-screen apps,
   *  the taskbar, other always-on-top tools) can slip above a window that was
   *  made topmost only once, so this runs on show and while the pill is up.
   *  moveTop() does not activate the window, focus stays in the target app. */
  private raise(win: BrowserWindow): void {
    if (win.isDestroyed() || !win.isVisible()) return;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  }

  private startKeepOnTop(win: BrowserWindow): void {
    if (this.topTimer) return;
    this.topTimer = setInterval(() => this.raise(win), 400);
  }

  private stopKeepOnTop(): void {
    if (this.topTimer) clearInterval(this.topTimer);
    this.topTimer = null;
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
