// MindScript — "Launch at Windows startup".
// The NSIS build uses the registry Run key through setLoginItemSettings. An
// MSIX (Microsoft Store) package can't: its registry writes are private to
// the package. There the manifest declares a StartupTask (see
// build/appx-startup.xml) and we switch it with the WinRT StartupTask API.
// That API needs the package identity, which processes we spawn don't
// inherit, so PowerShell starts the call inside the package with
// Invoke-CommandInDesktopPackage.
import { app } from 'electron';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

const STARTUP_TASK_ID = 'MindScriptStartup';
const APP_ID = 'MindScript'; // build.appx.applicationId in package.json

// C:\Program Files\WindowsApps\<Name>_<Version>_<Arch>_<ResourceId>_<PublisherId>\app\MindScript.exe
// → family name <Name>_<PublisherId>
function packageFamilyName(): string | null {
  const full = process.execPath.split(path.sep).find((part) => /^[^_]+_[^_]+_[^_]+_[^_]*_[^_]+$/.test(part));
  if (!full) return null;
  const parts = full.split('_');
  return `${parts[0]}_${parts[parts.length - 1]}`;
}

const encode = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');

// Runs inside the package and writes the resulting task state to `out`.
const startupTaskScript = (enable: boolean, out: string): string => `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
  function Await($op, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }
  [Windows.ApplicationModel.StartupTask, Windows.ApplicationModel, ContentType = WindowsRuntime] | Out-Null
  $t = Await ([Windows.ApplicationModel.StartupTask]::GetAsync('${STARTUP_TASK_ID}')) ([Windows.ApplicationModel.StartupTask])
  ${enable
    ? "$state = Await ($t.RequestEnableAsync()) ([Windows.ApplicationModel.StartupTaskState])"
    : '$t.Disable(); $state = $t.State'}
  Set-Content -LiteralPath '${out}' -Value $state
} catch {
  Set-Content -LiteralPath '${out}' -Value ('error ' + $_.Exception.Message)
}
`;

// Starts the inner script in the package and waits up to 10 s for its result.
const launcherScript = (family: string, inner: string, out: string): string => `
Remove-Item -LiteralPath '${out}' -ErrorAction SilentlyContinue
Invoke-CommandInDesktopPackage -PackageFamilyName '${family}' -AppId '${APP_ID}' -Command 'powershell.exe' -Args '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${inner}'
for ($i = 0; $i -lt 40 -and -not (Test-Path -LiteralPath '${out}'); $i++) { Start-Sleep -Milliseconds 250 }
if (Test-Path -LiteralPath '${out}') { Get-Content -LiteralPath '${out}'; Remove-Item -LiteralPath '${out}' } else { 'no result' }
`;

export function setLaunchOnStartup(enabled: boolean, log: (event: string, detail?: string) => void): void {
  if (!process.windowsStore) {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
    return;
  }
  const family = packageFamilyName();
  if (!family) {
    log('startup-task', `error no package family in ${process.execPath}`);
    return;
  }
  const out = path.join(os.tmpdir(), 'mindscript-startup-task.txt');
  const script = launcherScript(family, encode(startupTaskScript(enabled, out)), out);
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)],
    { windowsHide: true, timeout: 20_000 },
    (err, stdout) => log('startup-task', err ? `error ${err.message.split('\n')[0]}` : stdout.trim()),
  );
}

// A StartupTask launches the app without arguments, so it can't pass
// --hidden. When the Store build starts right after sign-in with
// launch-at-startup on, treat it as a startup launch and stay in the tray.
export function launchedAtStartup(launchOnStartup: boolean): boolean {
  if (process.argv.includes('--hidden')) return true;
  return process.windowsStore && launchOnStartup && os.uptime() < 240;
}
