// Runs electron-builder through its programmatic API. Calling build()
// directly avoids CLI argument-parsing problems when `node` on PATH is an
// Electron binary running with ELECTRON_RUN_AS_NODE.
//
//   node scripts/dist.mjs               NSIS installer (GitHub Releases)
//   node scripts/dist.mjs --store       MSIX for Microsoft Store upload.
//                                       Unsigned: the Store signs it. Needs the
//                                       Partner Center identity in build.appx
//                                       (identityName, publisher).
//   node scripts/dist.mjs --store-test  MSIX signed with the local certificate,
//                                       to install on this PC before uploading.
import builder from 'electron-builder';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = process.argv.includes('--store');
const storeTest = process.argv.includes('--store-test');

if (store) {
  const appx = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).build?.appx ?? {};
  if (!appx.identityName || !appx.publisher?.startsWith('CN=')) {
    console.error(
      'BUILD FAILED: set build.appx.identityName and build.appx.publisher in package.json\n' +
        'to the values from Partner Center → your app → Product identity\n' +
        '(Package/Identity/Name and Package/Identity/Publisher).',
    );
    process.exit(1);
  }
  // the Store signs the package itself; signing here would also force the
  // publisher to match our own certificate
  delete process.env.CSC_LINK;
  delete process.env.CSC_KEY_PASSWORD;
} else {
  // Code signing: if cert/mindscript-codesign.pfx exists and CSC_LINK is not
  // set, use it. The password is read from cert/password.txt (gitignored).
  const pfx = path.join(root, 'cert', 'mindscript-codesign.pfx');
  const pwdFile = path.join(root, 'cert', 'password.txt');
  if (!process.env.CSC_LINK && existsSync(pfx) && existsSync(pwdFile)) {
    process.env.CSC_LINK = pfx;
    process.env.CSC_KEY_PASSWORD = readFileSync(pwdFile, 'utf8').trim();
    console.log('signing with cert/mindscript-codesign.pfx');
  }
  // electron-builder's bundled signtool (winCodeSign 2.6.0) fails on .appx
  // with "A required function is not present"; use the newest Windows SDK one
  if (storeTest && !process.env.SIGNTOOL_PATH) {
    const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
    const versions = existsSync(kits) ? readdirSync(kits).filter((d) => /^10\.\d+\.\d+\.\d+$/.test(d)) : [];
    versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const signtool = versions.map((v) => path.join(kits, v, 'x64', 'signtool.exe')).filter(existsSync).pop();
    if (signtool) {
      process.env.SIGNTOOL_PATH = signtool;
      console.log(`using ${signtool}`);
    }
  }
}

const targets = builder.Platform.WINDOWS.createTarget([store || storeTest ? 'appx' : 'nsis']);
// --store-test: an MSIX installs only when its publisher equals the signing
// certificate's subject, so drop the Store publisher and let electron-builder
// take it from the certificate. The SDK signtool also rejects the legacy SHA1
// pass, which an MSIX doesn't need anyway.
const config = storeTest
  ? { appx: { publisher: null }, win: { signtoolOptions: { signingHashAlgorithms: ['sha256'] } } }
  : undefined;

try {
  const artifacts = await builder.build({ targets, config });
  console.log('BUILD OK');
  for (const a of artifacts) console.log('  →', a);
} catch (err) {
  console.error('BUILD FAILED:', err?.message ?? err);
  process.exit(1);
}
