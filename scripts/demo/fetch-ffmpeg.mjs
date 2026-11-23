// Places a static ffmpeg binary at scripts/demo/node_modules/ffmpeg.
//
// The capture scripts only need *a* static ffmpeg: one for Playwright's own
// video encoder and one for the mp4 normalisation. Both are found in the
// `imageio-ffmpeg` Python wheel, which ships a self-contained Linux build, so
// this script fetches the wheel and copies the binary out. No system ffmpeg,
// package manager or build toolchain is required.
//
//   node scripts/demo/fetch-ffmpeg.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEMOS_DIR } from './lib.mjs';

const local = path.join('scripts', 'demo', 'node_modules', 'ffmpeg');
await fs.mkdir(path.dirname(local), { recursive: true });

async function tryLink(from) {
  // The wheel's binary is itself static, so a symlink is enough and avoids
  // copying ~170 MB. It also makes the script idempotent.
  try {
    const resolved = await fs.realpath(from);
    const current = await fs.realpath(local).catch(() => null);
    if (current === resolved) return true;
    await fs.rm(local, { force: true });
    await fs.symlink(resolved, local);
    return true;
  } catch {
    return false;
  }
}

// 1. Already installed (common in this sandbox).
const pythonBin = (() => {
  try {
    return execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();

if (pythonBin && await tryLink(pythonBin)) {
  console.log(`ffmpeg → ${local}`);
} else {
  // 2. Install the wheel, then copy.
  console.log('imageio-ffmpeg not found, installing…');
  execFileSync('python3', ['-m', 'pip', 'install', '--quiet', '--break-system-packages', 'imageio-ffmpeg'], { stdio: 'inherit' });
  const installed = execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
  if (!await tryLink(installed)) {
    console.error('Could not copy the ffmpeg binary. Set FFMPEG_PATH instead.');
    process.exit(1);
  }
  console.log(`ffmpeg → ${local}`);
}

// Playwright records video with its own bundled ffmpeg build. Copy the same
// binary into its cache so `context.recordVideo` works without a download.
const version = await playwrightVersion();
const cache = path.join(process.env.HOME ?? '/root', '.cache', 'ms-playwright', `ffmpeg-${version}`, 'ffmpeg-linux');
if (version) {
  await fs.mkdir(path.dirname(cache), { recursive: true });
  if (!(await exists(cache))) {
    execFileSync('cp', [local, cache]);
    execFileSync('chmod', ['+x', cache]);
    console.log(`playwright ffmpeg → ${cache}`);
  }
}

console.log('\nReady. Verify with: scripts/demo/node_modules/ffmpeg -version');
console.log('Recordings are written to', path.join(DEMOS_DIR, '.raw'));

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function playwrightVersion() {
  // Playwright names its ffmpeg cache after the browser build (e.g. 1013).
  try {
    const pkg = JSON.parse(await fs.readFile('node_modules/playwright-core/browsers.json', 'utf8'));
    const entry = pkg.browsers?.find(browser => browser.name === 'ffmpeg');
    return entry?.revision ?? null;
  } catch {
    return null;
  }
}
