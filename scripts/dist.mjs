// Runs electron-builder through its programmatic API. Calling build()
// directly avoids CLI argument-parsing problems when `node` on PATH is an
// Electron binary running with ELECTRON_RUN_AS_NODE.
import builder from 'electron-builder';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Code signing: if cert/mindscript-codesign.pfx exists and CSC_LINK is not
// set, use it. The password is read from cert/password.txt (gitignored).
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pfx = path.join(root, 'cert', 'mindscript-codesign.pfx');
const pwdFile = path.join(root, 'cert', 'password.txt');
if (!process.env.CSC_LINK && existsSync(pfx) && existsSync(pwdFile)) {
  process.env.CSC_LINK = pfx;
  process.env.CSC_KEY_PASSWORD = readFileSync(pwdFile, 'utf8').trim();
  console.log('signing with cert/mindscript-codesign.pfx');
}

const targets = builder.Platform.WINDOWS.createTarget(['nsis']);

try {
  const artifacts = await builder.build({ targets });
  console.log('BUILD OK');
  for (const a of artifacts) console.log('  →', a);
} catch (err) {
  console.error('BUILD FAILED:', err?.message ?? err);
  process.exit(1);
}
