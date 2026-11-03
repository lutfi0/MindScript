// Rough hardware check: which graphics card is there, how much video memory
// does it have, and which backend should the native whisper.cpp / llama.cpp
// engines use (CUDA on NVIDIA, Vulkan on AMD and Intel)?
import { app } from 'electron';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GpuBackend, HardwareInfo } from '../shared/ipc';

const NVIDIA_VENDOR_ID = 0x10de;
const VULKAN_VENDOR_IDS = [0x1002, 0x8086]; // AMD, Intel

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function nvidiaSmi(): Promise<{ name: string; vramMb: number } | null> {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (!out) return null;
  const [name, mem] = out.split('\n')[0].split(',').map((s) => s.trim());
  const vramMb = Number(mem);
  return name ? { name, vramMb: Number.isFinite(vramMb) ? vramMb : 0 } : null;
}

interface Adapter {
  name: string;
  vendorId: number;
  vramMb: number;
}

/** Display adapters from the driver registry; the only place Windows reports
 *  real VRAM sizes above 4 GB. */
async function registryAdapters(): Promise<Adapter[]> {
  const script =
    "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | " +
    "ForEach-Object { [pscustomobject]@{ n = $_.DriverDesc; id = $_.MatchingDeviceId; m = $_.'HardwareInformation.qwMemorySize' } } | ConvertTo-Json -Compress";
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!out?.trim()) return [];
  try {
    const raw = JSON.parse(out) as { n?: string; id?: string; m?: number } | { n?: string; id?: string; m?: number }[];
    return (Array.isArray(raw) ? raw : [raw]).flatMap((a) => {
      const ven = /ven_([0-9a-f]{4})/i.exec(a.id ?? '');
      if (!a.n || !ven) return [];
      return [{ name: a.n, vendorId: parseInt(ven[1], 16), vramMb: a.m ? Math.round(a.m / 1024 / 1024) : 0 }];
    });
  } catch {
    return [];
  }
}

function hasVulkanLoader(): boolean {
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'vulkan-1.dll');
  return fs.existsSync(sys);
}

/** MINDSCRIPT_GPU_BACKEND=cuda|vulkan forces a backend (testing Vulkan on NVIDIA). */
export function forcedBackend(): GpuBackend | null {
  const v = process.env.MINDSCRIPT_GPU_BACKEND?.trim().toLowerCase();
  return v === 'cuda' || v === 'vulkan' ? v : null;
}

async function detect(): Promise<HardwareInfo> {
  const forced = forcedBackend();
  // nvidia-smi ships with the NVIDIA driver and also reports VRAM
  const smi = await nvidiaSmi();
  if (smi) return { nvidia: true, backend: forced ?? 'cuda', gpuName: smi.name, vramMb: smi.vramMb || undefined };

  const adapters = await registryAdapters();
  const vulkanGpu = adapters
    .filter((a) => VULKAN_VENDOR_IDS.includes(a.vendorId))
    .sort((a, b) => b.vramMb - a.vramMb)[0];
  if (vulkanGpu && hasVulkanLoader()) {
    return { nvidia: false, backend: forced ?? 'vulkan', gpuName: vulkanGpu.name, vramMb: vulkanGpu.vramMb || undefined };
  }
  try {
    const info = (await app.getGPUInfo('basic')) as { gpuDevice?: { vendorId?: number }[] };
    if (info.gpuDevice?.some((d) => d.vendorId === NVIDIA_VENDOR_ID)) return { nvidia: true, backend: forced ?? 'cuda' };
  } catch {
    /* no GPU info available */
  }
  return { nvidia: false, backend: forced };
}

let cached: Promise<HardwareInfo> | null = null;

export function detectHardware(): Promise<HardwareInfo> {
  cached ??= detect();
  return cached;
}
