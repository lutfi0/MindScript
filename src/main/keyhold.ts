// Hold-to-start hotkey. globalShortcut only reports presses and swallows the
// key, which makes Caps Lock unusable as Caps Lock. Instead a small
// long-lived PowerShell/C# helper polls GetAsyncKeyState for the hotkey's
// main key (no keyboard hook, nothing is swallowed) and reports
// down/up transitions; timing lives here in the main process.
//
// Toggle keys (Caps/Num/Scroll Lock) flip their lock state on the physical
// press, so when a press was used by MindScript the helper puts the lock
// state back to what it was before the press.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const HELPER = `
Add-Type -TypeDefinition @'
using System;
using System.Threading;
using System.Runtime.InteropServices;
public static class MsKeyWatch {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern short GetKeyState(int vk);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  static volatile int vk = 0;
  static volatile int muteUntil = 0;
  static bool Down(int k) { return (GetAsyncKeyState(k) & 0x8000) != 0; }
  static int Toggled(int k) { return GetKeyState(k) & 1; }
  static void Commands() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string[] p = line.Trim().Split(' ');
      if (p[0] == "watch" && p.Length > 1) vk = int.Parse(p[1]);
      else if (p[0] == "lock" && p.Length > 2) {
        int k = int.Parse(p[1]);
        if (Toggled(k) != int.Parse(p[2])) {
          muteUntil = Environment.TickCount + 120;
          keybd_event((byte)k, 0, 0, UIntPtr.Zero);
          keybd_event((byte)k, 0, 2, UIntPtr.Zero);
        }
      }
    }
    Environment.Exit(0);
  }
  public static void Run() {
    Thread t = new Thread(Commands);
    t.IsBackground = true;
    t.Start();
    bool was = false;
    int lockWhileUp = 0;
    Console.Out.WriteLine("ready");
    Console.Out.Flush();
    int lastBeat = Environment.TickCount;
    while (true) {
      if (Environment.TickCount - lastBeat >= 2000) {
        lastBeat = Environment.TickCount;
        Console.Out.WriteLine("hb");
        Console.Out.Flush();
      }
      int k = vk;
      bool d = k != 0 && Down(k);
      if (Environment.TickCount < muteUntil) d = was;
      if (!d && k != 0) lockWhileUp = Toggled(k);
      if (d != was) {
        was = d;
        if (d) {
          int m = (Down(0x11) ? 1 : 0) | (Down(0x12) ? 2 : 0) | (Down(0x10) ? 4 : 0) |
                  ((Down(0x5B) || Down(0x5C)) ? 8 : 0);
          Console.Out.WriteLine("down " + m + " " + lockWhileUp);
        } else {
          Console.Out.WriteLine("up");
        }
        Console.Out.Flush();
      }
      Thread.Sleep(8);
    }
  }
}
'@
[MsKeyWatch]::Run()
`;

const MOD_BITS: Record<string, number> = {
  control: 1, ctrl: 1, commandorcontrol: 1, cmdorctrl: 1,
  alt: 2, option: 2, altgr: 2,
  shift: 4,
  super: 8, meta: 8, command: 8, cmd: 8,
};

const NAMED_VK: Record<string, number> = {
  capslock: 0x14, numlock: 0x90, scrolllock: 0x91,
  space: 0x20, tab: 0x09, enter: 0x0d, return: 0x0d, backspace: 0x08,
  escape: 0x1b, esc: 0x1b, insert: 0x2d, delete: 0x2e, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, pause: 0x13,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  ',': 0xbc, '.': 0xbe, '/': 0xbf, ';': 0xba, '[': 0xdb, ']': 0xdd,
  '\\': 0xdc, '-': 0xbd, '=': 0xbb, '`': 0xc0,
};

const TOGGLE_VKS = new Set([0x14, 0x90, 0x91]);

export interface HoldKey {
  vk: number;
  mods: number;
}

/** Electron accelerator → virtual-key code + modifier mask, or null if unsupported. */
export function parseAccelerator(accel: string): HoldKey | null {
  let mods = 0;
  let vk = 0;
  for (const raw of accel.split('+')) {
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    if (MOD_BITS[p] !== undefined) mods |= MOD_BITS[p];
    else if (/^[a-z0-9]$/.test(p)) vk = p.toUpperCase().charCodeAt(0);
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(p)) vk = 0x6f + Number(p.slice(1));
    else if (NAMED_VK[p] !== undefined) vk = NAMED_VK[p];
    else return null;
  }
  return vk ? { vk, mods } : null;
}

/** A release this soon after recording starts leaves it running hands-free. */
const LATCH_MS = 800;

export interface HoldHandlers {
  /** true when idle and a new recording may start */
  canStart(): boolean;
  /** true while a recording is running (or starting) */
  isRecording(): boolean;
  start(): void;
  stop(): void;
  log(event: string, detail?: string): void;
}

/**
 * Hold the key for `holdMs` to start. Then either keep holding while
 * speaking and release to finish (push-to-talk), or let go right away and
 * tap the key once more to finish (hands-free).
 */
export class KeyHoldWatcher {
  private child: ChildProcessWithoutNullStreams | null = null;
  private key: HoldKey | null = null;
  private holdMs = 0;
  private holdTimer: NodeJS.Timeout | null = null;
  private pressed = false;
  /** lock state before the current press (toggle keys only) */
  private lockBefore = 0;
  /** the current press belongs to MindScript, undo its lock toggle on release */
  private consumed = false;
  /** recording was started by the current, still-held press */
  private holding = false;
  private startedAt = 0;
  private handsFree = false;
  private accel = '';
  private ready = false;
  private lastSeen = 0;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(private readonly h: HoldHandlers) {}

  /** Starts watching `accel`; holdMs <= 0 or an unsupported key stops the watcher. */
  configure(accel: string, holdMs: number): boolean {
    const key = holdMs > 0 ? parseAccelerator(accel) : null;
    this.accel = accel;
    this.key = key;
    this.holdMs = holdMs;
    this.reset();
    if (!key) {
      this.stop();
      return holdMs <= 0;
    }
    this.ensureChild();
    this.send(`watch ${key.vk}`);
    return true;
  }

  /** Forget any hands-free state, e.g. after a recording ended some other way. */
  recordingEnded(): void {
    this.handsFree = false;
    this.holding = false;
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const child = this.child;
    this.child = null;
    this.ready = false;
    child?.stdin.end();
    child?.kill();
  }

  /** Throws the helper away and starts a fresh one (after sleep/unlock, or if it hangs). */
  restart(reason: string): void {
    if (!this.key) return;
    this.h.log('keyhold-restart', reason);
    // A dead helper can never report the release, don't leave a recording running.
    if (this.holding && this.h.isRecording()) this.h.stop();
    const accel = this.accel;
    const holdMs = this.holdMs;
    this.stop();
    this.configure(accel, holdMs);
  }

  private reset(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.pressed = false;
    this.consumed = false;
    this.holding = false;
    this.handsFree = false;
  }

  private ensureChild(): void {
    if (this.child) return;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', HELPER],
      { windowsHide: true },
    );
    this.child = child;
    this.ready = false;
    this.lastSeen = Date.now();
    // The helper sends a heartbeat every 2 s; silence means it hung or was
    // frozen, so the key would no longer be noticed. Compiling the C# on first
    // start can take a while, hence the longer grace before "ready".
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.child !== child) return;
      const limit = this.ready ? 8000 : 30000;
      if (Date.now() - this.lastSeen > limit) this.restart('no-heartbeat');
    }, 2000);
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      this.lastSeen = Date.now();
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr.on('data', (d: Buffer) => this.h.log('keyhold-stderr', d.toString('utf8').trim().slice(0, 300)));
    child.on('error', (err) => this.h.log('keyhold-error', err.message));
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
      if (!this.key) return;
      // helper died unexpectedly — bring it back
      this.h.log('keyhold-exit', `code=${code}`);
      setTimeout(() => {
        if (this.key && !this.child) this.configure(this.accel, this.holdMs);
      }, 1000);
    });
  }

  private send(cmd: string): void {
    this.child?.stdin.write(cmd + '\n');
  }

  private onLine(line: string): void {
    if (line === 'ready') {
      this.ready = true;
      this.h.log('keyhold-ready', `vk=${this.key?.vk} hold=${this.holdMs}ms`);
      return;
    }
    const key = this.key;
    if (!key) return;
    const [kind, modsStr, lockStr] = line.split(' ');
    if (kind === 'down') {
      if (Number(modsStr) !== key.mods) return;
      this.pressed = true;
      this.lockBefore = Number(lockStr) || 0;
      this.onDown();
    } else if (kind === 'up' && this.pressed) {
      this.pressed = false;
      this.onUp();
    }
  }

  private onDown(): void {
    if (this.handsFree && this.h.isRecording()) {
      // second tap ends a hands-free recording
      this.consumed = true;
      this.handsFree = false;
      this.h.stop();
      return;
    }
    this.handsFree = false;
    if (!this.h.canStart()) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (!this.pressed || !this.h.canStart()) return;
      this.consumed = true;
      this.holding = true;
      this.startedAt = Date.now();
      this.h.start();
    }, this.holdMs);
  }

  private onUp(): void {
    if (this.holdTimer) {
      // released before the threshold: an ordinary key press
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (this.holding) {
      this.holding = false;
      if (Date.now() - this.startedAt < LATCH_MS) this.handsFree = true;
      else if (this.h.isRecording()) this.h.stop();
    }
    if (this.consumed && this.key && TOGGLE_VKS.has(this.key.vk)) {
      this.send(`lock ${this.key.vk} ${this.lockBefore}`);
    }
    this.consumed = false;
  }
}
