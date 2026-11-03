// Rough hardware check for the onboarding page: is there an NVIDIA GPU (for
// the whisper.cpp CUDA models) and how much video memory does it have?
import { app } from 'electron';
import { execFile } from 'node:child_process';
import { HardwareInfo } from '../shared/ipc';

const NVIDIA_VENDOR_ID = 0x10de;

function nvidiaSmi(): Promise<{ name: string; vramMb: number } | null> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const [name, mem] = stdout.split('\n')[0].split(',').map((s) => s.trim());
        const vramMb = Number(mem);
        resolve(name ? { name, vramMb: Number.isFinite(vramMb) ? vramMb : 0 } : null);
      },
    );
  });
}

export async function detectHardware(): Promise<HardwareInfo> {
  // nvidia-smi ships with the NVIDIA driver and also reports VRAM
  const smi = await nvidiaSmi();
  if (smi) return { nvidia: true, gpuName: smi.name, vramMb: smi.vramMb || undefined };
  try {
    const info = (await app.getGPUInfo('basic')) as { gpuDevice?: { vendorId?: number }[] };
    if (info.gpuDevice?.some((d) => d.vendorId === NVIDIA_VENDOR_ID)) return { nvidia: true };
  } catch {
    /* no GPU info available */
  }
  return { nvidia: false };
}
