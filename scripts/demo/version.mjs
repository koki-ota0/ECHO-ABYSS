// Captures the demo material for one merged version.
//
//   node scripts/demo/version.mjs --pr 8 --sha 1a2b3c4 --label "Rail rework"
//
// Run this right after a PR is merged into main. It reads the merge commit,
// records every scene against that commit's code, writes the clips, stills,
// contact sheet and reel into demos/<tag>/, and adds the entry to demos/index.json.
//
// The tag is derived from the merge commit so it is stable and traceable:
//   <date>-<short sha>        e.g. 2026-11-23-2ffeaec
// A PR number is recorded alongside it when available (see demos/README.md).

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEMOS_DIR, ROOT } from './lib.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  // `--flag` with nothing after it (or followed by another flag) must not
  // silently become a directory named "undefined" or overwrite a real tag.
  if (index >= 0 && (value === undefined || value.startsWith('--'))) {
    console.error(`--${name} needs a value.`);
    process.exit(1);
  }
  return value ?? fallback;
};

/**
 * True when the merge changed what the game looks like, false when it only
 * touched footage, docs or capture tooling, null when that cannot be determined.
 *
 * This is an allowlist of the paths that actually feed the rendered game.
 * A deny-list of demos/ is not enough: a "capture the last merge" PR also
 * updates READMEs and the capture scripts, and those changes never alter a
 * single pixel of gameplay. Treating them as gameplay would shoot footage
 * identical to the previous version, and merging that capture would queue
 * another identical one forever.
 */
const GAMEPLAY_PATHS = [/^src\//, /^public\//, /^index\.html$/, /^vite\.config\.ts$/, /^package(-lock)?\.json$/];
function mergeChangesGameplay(ref) {
  try {
    const parents = git(['rev-list', '--parents', '-n', '1', ref]).split(' ').slice(1);
    if (!parents.length) return null;
    const files = git(['diff', '--name-only', parents[0], ref]).split('\n').filter(Boolean);
    if (!files.length) return null;
    return files.some(file => GAMEPLAY_PATHS.some(pattern => pattern.test(file)));
  } catch {
    return null;
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const sha = option('sha') ?? git(['rev-parse', '--short=7', 'HEAD']);
const pr = option('pr', null);
const label = option('label', '');
const resolution = option('resolution', '720p');

const resolve = ref => {
  try {
    return git(['rev-parse', ref]);
  } catch {
    return null;
  }
};

// The capture must run against the merged tree so the footage matches the tag.
const head = resolve('HEAD');
const target = resolve(sha);
if (!target) {
  console.error(`Unknown commit: ${sha}`);
  console.error('Pass the merge commit of the PR, e.g. --sha $(git rev-parse --short=7 HEAD).');
  process.exit(1);
}
if (head !== target) {
  console.error(`HEAD is ${head.slice(0, 7)} but --sha is ${sha}.`);
  console.error('Check out the merged commit first (git switch --detach <merge-sha>), then rerun.');
  process.exit(1);
}

const tag = option('tag') ?? `${git(['show', '-s', '--format=%cs', sha])}-${sha}`;
const force = argv.includes('--force');

for (const dir of [path.join(DEMOS_DIR, tag), path.join(DEMOS_DIR, `${git(['show', '-s', '--format=%cs', sha])}-${sha}`)]) {
  if (!force && await fs.stat(dir).then(() => true, () => false)) {
    console.error(`${path.relative(ROOT, dir)}/ already exists.`);
    console.error('A version is captured once; pass --force to re-shoot it (the old files are replaced).');
    process.exit(1);
  }
}

// A merge that only adds footage (the usual "capture the last merge" PR) does
// not change the game, so its clips would be a byte-for-byte repeat of the
// previous version. Capture only when something outside demos/ moved.
const changed = mergeChangesGameplay(sha);
if (changed === false && !force) {
  console.error(`${sha} changes nothing under src/, public/ or the build config: its clips would repeat the previous version.`);
  console.error('Nothing to capture. Pass --force to record it anyway.');
  process.exit(0);
}

console.log(`capturing ${tag}${pr ? ` (PR #${pr})` : ''} at ${resolution}`);
// Pass the commit and PR through so the manifest records them per clip set.
const captureArgs = ['scripts/demo/capture.mjs', '--version', tag, '--resolution', resolution, '--commit', sha];
if (pr) captureArgs.push('--pr', String(pr));
execFileSync('node', captureArgs, { cwd: ROOT, stdio: 'inherit' });
execFileSync('node', ['scripts/demo/render.mjs', '--version', tag, '--resolution', resolution], { cwd: ROOT, stdio: 'inherit' });

// Update the index that readers and the README link to.
const indexPath = path.join(DEMOS_DIR, 'index.json');
let index = { versions: [] };
try { index = JSON.parse(await fs.readFile(indexPath, 'utf8')); } catch {}

const dir = path.join(DEMOS_DIR, tag, resolution);
const manifest = JSON.parse(await fs.readFile(path.join(dir, 'clips.json'), 'utf8'));
const sizeOf = async name => (await fs.stat(path.join(dir, name))).size;
const entry = {
  tag,
  date: git(['show', '-s', '--format=%cs', sha]),
  sha,
  mergeCommit: git(['rev-parse', sha]),
  pr: pr ? Number(pr) : null,
  label,
  resolution,
  capturedAt: manifest.capturedAt,
  clips: manifest.clips.length,
  seconds: manifest.clips.reduce((total, clip) => total + clip.seconds, 0),
  reel: `demos/${tag}/${resolution}/reel.mp4`,
  reelBytes: await sizeOf('reel.mp4'),
  contactSheet: `demos/${tag}/${resolution}/contact-sheet.jpg`,
  scenes: manifest.clips.map(clip => ({ id: clip.id, file: clip.file, note: clip.note, seconds: clip.seconds })),
};

index.versions = index.versions.filter(version => version.tag !== tag);
index.versions.unshift(entry);
index.versions.sort((a, b) => (a.date === b.date ? b.tag.localeCompare(a.tag) : b.date.localeCompare(a.date)));
await fs.writeFile(indexPath, JSON.stringify(index, null, 2) + '\n');

console.log(`\n${tag}: ${entry.clips} clips, ${entry.seconds}s, reel ${(entry.reelBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`index updated: demos/index.json`);
