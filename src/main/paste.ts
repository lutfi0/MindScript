// Inserts dictated text into the window the user was dictating into.
// Strategy: when dictation stops we capture the foreground window handle;
// at paste time we re-focus that window (AttachThreadInput trick, so Windows
// actually grants the foreground switch), write the clipboard and synthesize
// Ctrl+V through PowerShell's WScript.Shell SendKeys.
import { clipboard } from 'electron';
import { spawn } from 'node:child_process';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function runPs(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('powershell timed out'));
    }, 5000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`powershell exit code ${code}`));
    });
  });
}

const U32 = `
Add-Type -Namespace Win32 -Name U -MemberDefinition '
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'`;

/** Handle of the window that has focus right now (decimal string), or null. */
export async function captureForegroundHwnd(): Promise<string | null> {
  try {
    const out = await runPs(`${U32}; [Win32.U]::GetForegroundWindow().ToInt64()`);
    return /^-?\d+$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** Brings the given window back to the foreground (best-effort). */
async function focusWindow(hwnd: string): Promise<void> {
  await runPs(`${U32};
$t = [System.IntPtr]::new([long]${hwnd});
$cur = [Win32.U]::GetForegroundWindow();
if ($cur -ne $t) {
  [uint32]$p = 0;
  $tgtTid = [Win32.U]::GetWindowThreadProcessId($t, [ref]$p);
  $me = [Win32.U]::GetCurrentThreadId();
  [void][Win32.U]::AttachThreadInput($me, $tgtTid, $true);
  [void][Win32.U]::SetForegroundWindow($t);
  [void][Win32.U]::AttachThreadInput($me, $tgtTid, $false);
}`);
}

function sendCtrlV(): Promise<void> {
  return runPs(`$s = New-Object -ComObject WScript.Shell; $s.SendKeys('^v')`).then(() => undefined);
}

/**
 * Pastes text into the target window. If targetHwnd is given and the focus
 * has drifted elsewhere while transcribing, the original window is pulled
 * back to the foreground first.
 */
export async function pasteIntoActiveApp(text: string, targetHwnd?: string | null): Promise<void> {
  clipboard.writeText(text);
  if (targetHwnd) {
    try {
      await focusWindow(targetHwnd);
      await sleep(120); // let the focus switch settle
    } catch {
      /* fall through: paste wherever the focus is */
    }
  }
  await sleep(60); // let the clipboard settle before synthesizing the keystroke
  await sendCtrlV();
}
