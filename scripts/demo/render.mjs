// Builds the browsing assets for one version: a contact sheet of every still
// and a single reel that plays all clips back to back.
//
//   node scripts/demo/render.mjs --version v1.0.0 --resolution 1080p
//
// Both outputs are derived from the clips, so the reel can be re-cut later
// without touching the recorded material.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEMOS_DIR, probeDuration } from './lib.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};

const version = option('version', 'unversioned');
const resolution = option('resolution', '720p');
const ffmpeg = process.env.FFMPEG_PATH ?? path.join('scripts', 'demo', 'node_modules', 'ffmpeg');
const dir = path.join(DEMOS_DIR, version, resolution);
const manifest = JSON.parse(await fs.readFile(path.join(dir, 'clips.json'), 'utf8'));

// ------------------------------------------------------------ contact sheet --
const stills = manifest.clips.filter(clip => clip.poster);
const columns = 4;
const rows = Math.ceil(stills.length / columns);
const inputs = stills.flatMap(clip => ['-i', path.join(dir, clip.poster)]);
const labels = stills.map((_, index) => `[${index}:v]scale=480:270,fps=30,format=rgba[card${index}]`);
const pads = stills.map((_, index) => `[card${index}]pad=490:300:0:0:color=0x05090f[pad${index}]`);
const layout = stills.map((_, index) => `${(index % columns) * 490}_${Math.floor(index / columns) * 300}`).join('|');
execFileSync(ffmpeg, [
  '-y', '-loglevel', 'error', ...inputs,
  '-filter_complex',
  `${[...labels, ...pads].join(';')};${stills.map((_, index) => `[pad${index}]`).join('')}xstack=inputs=${stills.length}:layout=${layout}:fill=0x05090f[sheet]`,
  '-map', '[sheet]', '-frames:v', '1', '-q:v', '3', path.join(dir, 'contact-sheet.jpg'),
]);

// -------------------------------------------------------------------- reel ---
const listPath = path.join(dir, '.reel.txt');
await fs.writeFile(listPath, manifest.clips.map(clip => `file '${path.resolve(dir, clip.file)}'`).join('\n') + '\n');
const reelPath = path.join(dir, `reel.mp4`);
execFileSync(ffmpeg, [
  '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', reelPath,
]);
await fs.rm(listPath, { force: true });

const seconds = probeDuration(ffmpeg, reelPath);
const bytes = (await fs.stat(reelPath)).size;
console.log(`contact-sheet.jpg (${columns}x${rows})`);
console.log(`reel.mp4 ${seconds?.toFixed(1)}s ${(bytes / 1024 / 1024).toFixed(1)} MB`);
