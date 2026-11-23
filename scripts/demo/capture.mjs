// Captures one clip + still per scene into demos/<version>/<resolution>/.
//
//   node scripts/demo/capture.mjs --version v1.0.0 --resolution 1080p
//   node scripts/demo/capture.mjs --version v1.0.0 --resolution 1080p --only 04-boss
//
// Requires the dev server on :5173 (`npm run dev`) and a writable
// `scripts/demo/node_modules/ffmpeg` (see README in demos/).

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CAMERA, SCENES } from './scenes.mjs';
import { DEMOS_DIR, ensureDirs, launchBrowser, probeDuration, recordScene, takeControl } from './lib.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};

const version = option('version', 'unversioned');
const resolution = option('resolution', '720p');
const commit = option('commit', null);
const pullRequest = option('pr', null);
const only = option('only', null);
const ffmpeg = await resolveFfmpeg();

export const RESOLUTIONS = {
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
  'vertical': { width: 1080, height: 1920 },
};

export async function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  // ffmpeg is fetched by scripts/demo/fetch-ffmpeg.mjs; it is only needed for
  // conversion, so capture can still run without it.
  const local = path.join(DEMOS_DIR, '..', 'scripts', 'demo', 'node_modules', 'ffmpeg');
  try {
    await fs.access(local);
    return local;
  } catch {
    return null;
  }
}

const target = path.join(DEMOS_DIR, version, resolution);
const rawDir = path.join(DEMOS_DIR, '.raw');
ensureDirs(target, rawDir, path.join(DEMOS_DIR, '.raw', 'clips'));

const manifestPath = path.join(target, 'clips.json');
// The commit and PR are what tie a clip back to the release it shows, so they
// are recorded in the manifest itself, not only in demos/index.json.
let manifest = {
  version, resolution, capturedAt: null,
  commit: resolveCommit(commit), pullRequest: pullRequest ? Number(pullRequest) : null,
  clips: [],
};
try { manifest = { ...manifest, ...JSON.parse(await fs.readFile(manifestPath, 'utf8')) }; } catch {}
manifest.commit ??= resolveCommit(commit);
manifest.pullRequest ??= pullRequest ? Number(pullRequest) : null;

const scenes = SCENES.filter(scene => !only || scene.id === only);
const browser = await launchBrowser();
const startedAt = Date.now();

for (const scene of scenes) {
  const size = scene.vertical ? RESOLUTIONS.vertical : RESOLUTIONS[resolution];
  // The 9:16 take is recorded in real portrait mode (the game switches to its
  // portrait camera below 700 CSS px wide) and marked up to the delivery size.
  // 640 px wide is what trips the game's portrait camera: it then renders the
  // arena across the whole tall frame, so the take is full-bleed vertical.
  const viewport = scene.vertical ? { width: 640, height: 1280 } : { width: size.width, height: size.height };
  const dsf = 1;
  process.stdout.write(`${scene.id} (${size.width}x${size.height}) … `);

  const result = await recordScene(browser, {
    ...size,
    viewport,
    deviceScaleFactor: dsf,
    action: async page => {
      const helpers = await stageScene(page, scene, size);
      await advance(page, scene.seconds, helpers);
    },
  });

  const videoPath = result.videoPath;
  const clipName = `${scene.id}.mp4`;
  const posterName = `${scene.id}.jpg`;
  const clipPath = path.join(target, clipName);
  const posterPath = path.join(target, posterName);
  if (ffmpeg && videoPath) {
    // The raw take includes the page load and the teardown. Trim it to the
    // scene window and normalise codec, fps and pixel format so every clip can
    // be dropped on one timeline without re-encoding.
    const total = probeDuration(ffmpeg, videoPath) ?? scene.seconds;
    const end = Math.min(scene.seconds + 1.2, Math.max(1, total - 0.4));
    const start = Math.max(0, end - scene.seconds);
    execFileSync(ffmpeg, [
      '-y', '-loglevel', 'error',
      '-ss', start.toFixed(2), '-i', videoPath, '-t', scene.seconds.toFixed(2),
      '-vf', `${scaleFilter(scene, size)},fps=30,setsar=1`,
      // 720p at CRF 26 keeps the glow gradients clean (verified against a
      // 1080p CRF 23 encode) at roughly a quarter of the size, which is what
      // makes keeping every merged version inside the repository affordable.
      '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', clipPath,
    ]);
    // Poster taken from the middle of the beat, where the action peaks.
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-ss', (scene.seconds * 0.55).toFixed(2), '-i', clipPath, '-frames:v', '1', '-q:v', '2', posterPath]);
    await fs.rm(videoPath, { force: true });
  }
  manifest.clips = manifest.clips.filter(clip => clip.id !== scene.id);
  manifest.clips.push({
    id: scene.id, file: clipName, poster: posterName, note: scene.note,
    seconds: scene.seconds, camera: scene.camera, vertical: Boolean(scene.vertical),
  });
  manifest.clips.sort((a, b) => a.id.localeCompare(b.id));
  manifest.capturedAt = new Date().toISOString();
  manifest.commit = resolveCommit(commit) ?? manifest.commit;
  manifest.pullRequest = pullRequest ? Number(pullRequest) : manifest.pullRequest;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`ok (${result.errors.length ? result.errors.slice(0, 2).join(' | ') : 'no errors'})`);
}

await browser.close();
console.log(`\n${scenes.length} scene(s) → ${path.relative(process.cwd(), target)} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
if (!ffmpeg) console.log('ffmpeg not found: raw .webm files were kept instead of mp4. Run scripts/demo/fetch-ffmpeg.mjs.');

// ---------------------------------------------------------------- helpers ---

/** Full hash for whatever ref the capture is attributed to (usually HEAD). */
function resolveCommit(ref) {
  try {
    return execFileSync('git', ['rev-parse', ref ?? 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Frames the take for its delivery format.
 *
 * The 9:16 take runs in a 640 px wide window, which is what switches the game
 * to its portrait camera, and stageScene then scales the canvas so the arena
 * fills the tall frame. All that is left is delivering it at 1080x1920.
 */
function scaleFilter(scene, size) {
  if (scene.crop === '9x16') {
    // The 1.5x canvas zoom makes the arena overfill the tall frame, so the
    // centre 9:16 slice of the recording is all gameplay: no bars to crop out.
    return 'crop=405:720:158:0,scale=1080:1920:flags=lanczos';
  }
  return `scale=${size.width}:${size.height}:flags=lanczos`;
}

async function stageScene(page, scene, size) {
  await takeControl(page);
  const camera = CAMERA[scene.camera] ?? CAMERA.full;
  // The camera is driven inside the page (see lib.mjs) so a zoomed take can
  // follow the pilot instead of cropping a fixed patch of the arena.
  await page.evaluate(({ zoom, track, hideHud }) => {
    window.__DEMO__.zoom = zoom;
    window.__DEMO__.tracking = track;
    if (hideHud) {
      const style = document.createElement('style');
      style.textContent = '.hud,.hud-top,.hud-bottom,.pilot-guide,.action-dock,.toast-stack{display:none !important;}';
      document.head.appendChild(style);
    }
  }, { zoom: camera.zoom, track: camera.track, hideHud: Boolean(camera.hideHud) });
  if (camera.hideHud && scene.camera === 'letter') {
    await page.addStyleTag({ content:
      `.game-canvas{clip-path: inset(${Math.round(size.height * 0.065)}px 0 ${Math.round(size.height * 0.065)}px 0);}` });
  }

  if (scene.kind === 'menu') {
    await page.evaluate(() => {
      localStorage.removeItem('echo-abyss-unlocked-level');
      localStorage.setItem('echo-abyss-unlocked-level', '100');
    });
    return { menu: true };
  }

  await page.evaluate(async ({ scene }) => {
    const engine = window.__ECHO__;
    await engine.start(scene.core ?? 'wraith', 'standard', scene.seed ?? 'DEMO', scene.mode ?? 'infinite', scene.stage ?? 1);
    engine.tutorialEnabled = false;
    engine.tutorialStep = 5;
    if (scene.boss) {
      engine.enemies = [];
      engine.bossSpawned = true;
      engine.spawnBoss(scene.boss);
      for (let index = 0; index < 6; index++) engine.spawnEnemy('drone', 380 + index * 170, 660, false);
    }
    if (scene.scripted === 'rail') {
      engine.enemies = [];
      engine.player.x = 300; engine.player.y = 450; engine.player.angle = 0;
      engine.railAim = { angle: 0, at: engine.elapsed };
      // A mix of bodies on the firing line and off it, so the clip shows both
      // the erase and the wound.
      for (let index = 0; index < 8; index++) {
        const offset = [0, 12, -18, 30, 95, 130, -150, 0][index];
        engine.spawnEnemy(index % 3 === 0 ? 'tank' : 'drone', 620 + index * 96, 450 + offset, false);
      }
    }
    if (scene.scripted === 'draft') {
      engine.enemies = [];
      engine.spawnTimer = 999;
      engine.player.xp = engine.player.xpNext;
      engine.checkLevelUp();
    }
    if (scene.scripted === 'overdrive') { engine.player.sync = 100; engine.player.hp = engine.player.stats.maxHp; }
    if (scene.scripted === 'tank') {
      engine.enemies = [];
      engine.player.x = 720; engine.player.y = 470;
      for (let index = 0; index < 4; index++) engine.spawnEnemy('tank', 760 + index * 160, 380 + index * 70, false);
      for (let index = 0; index < 6; index++) engine.spawnEnemy('drone', 700 + index * 110, 250 + (index % 3) * 220, false);
    }
  }, { scene });

  if (scene.crop === '9x16') {
    // The portrait layout centres a 1440x900 arena inside the tall frame, which
    // leaves black above and below. Scaling the canvas by exactly that ratio
    // makes the arena fill the window, so the recording is already 9:16 with no
    // crop and no bars.
    await page.evaluate(() => {
      const view = window.__ECHO__.view;
      window.__DEMO__.zoom = 1.5;
      window.__DEMO__.tracking = false;
    });
  }

  return {
    script: scene.scripted ?? null,
    // The draft pick lands at 85% through the clip so the cards are readable.
    pickAt: scene.scripted === 'draft' ? Math.round(scene.seconds * 60 * 0.85) : undefined,
    driveMode: scene.boss ? 'boss' : 'combat',
    density: scene.density ?? 0,
    clean: Boolean(CAMERA[scene.camera]?.hideHud),
  };
}

async function advance(page, seconds, helpers) {
  if (helpers.menu) {
    // Real UI interaction: the menu, then each setup panel.
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'LEVEL', exact: true }).click();
    await page.waitForTimeout(1400);
    await page.getByRole('button', { name: 'INFINITE', exact: true }).click().catch(() => {});
    await page.waitForTimeout(1400);
    return;
  }
  await page.evaluate(async ({ seconds, script, pickAt, mode, density, clean }) => {
    const demo = window.__DEMO__;
    const frames = Math.round(seconds * 60);
    // Pace the simulation against the wall clock: the recorder samples the page
    // in real time, so stepping as fast as possible would make the clip play as
    // a fast-forward and come out shorter than the scene.
    const startedAt = performance.now();
    for (let frame = 0; frame < frames; frame++) {
      demo.drive({ mode, manual: true, script, frame, pickAt, density, clean });
      demo.step();
      const target = startedAt + ((frame + 1) * 1000) / 60;
      const wait = target - performance.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      else await new Promise(resolve => setTimeout(resolve, 0));
    }
  }, {
    seconds,
    script: helpers.script ?? null,
    clean: Boolean(helpers.clean),
    pickAt: helpers.pickAt,
    mode: helpers.driveMode ?? 'combat',
    density: helpers.density ?? 0,
  });
  await page.waitForTimeout(600);
}
