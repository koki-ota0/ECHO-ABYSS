// Shared plumbing for the demo-video pipeline.
//
// Recordings are made from a real browser at a fixed 1/60 s simulation step so
// every take is reproducible from its seed, and so a 6 s beat always looks like
// 6 s of gameplay regardless of how fast the capture machine renders. Each
// scene is written as a separate clip plus a still, which is what makes the
// footage editable later: the clips can be re-ordered, re-timed or re-cut
// without re-running the game.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import chromiumBin, { inflate, setupLambdaEnvironment } from '@sparticuz/chromium';

export const ROOT = process.cwd();
export const DEMOS_DIR = path.join(ROOT, 'demos');

export async function launchBrowser() {
  await inflate(path.resolve('node_modules/@sparticuz/chromium/bin/al2023.tar.br'));
  setupLambdaEnvironment('/tmp/al2023/lib');
  chromiumBin.setGraphicsMode = false;
  const args = chromiumBin.args.filter(arg => arg !== '--single-process' && arg !== '--in-process-gpu');
  return chromium.launch({ executablePath: await chromiumBin.executablePath(), args, headless: true });
}

/** A page with the game loaded, tutorial suppressed and all audio muted. */
export async function openGame(browser, { width, height, deviceScaleFactor = 1 }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor });
  await context.addInitScript(() => {
    localStorage.setItem('echo-abyss-tutorial-complete', '1');
    // The promo footage is silent; the soundtrack is added at edit time.
    try { window.AudioContext = class { resume() {} createOscillator() { return { connect() {}, start() {}, stop() {}, frequency: { setValueAtTime() {} }, type: '' }; } createGain() { return { connect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } }; } get destination() { return null; } get currentTime() { return 0; } get state() { return 'running'; } }; } catch {}
    window.__DEMO__ = { engine: null };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  return { context, page, errors };
}

/**
 * Takes control of the engine: the real rAF loop is stopped and the simulation
 * is stepped by hand at a fixed rate. Rendering still happens every frame, so
 * the recording shows the shipped visuals.
 */
export async function takeControl(page) {
  await page.evaluate(() => {
    const engine = window.__ECHO__;
    window.__DEMO__ = window.__DEMO__ ?? {};
    window.__DEMO__.engine = engine;
    cancelAnimationFrame(engine.animation);
    engine.status = 'idle';
    // Zoom is a CSS transform on the canvas, so the game still renders at its
    // native resolution: only the framing changes.
    window.__DEMO__.zoom = 1;
    window.__DEMO__.tracking = false;
    window.__DEMO__.canvas = document.querySelector('canvas');
    const W = 1440, H = 900;
    window.__DEMO__.frame = () => {
      const canvas = window.__DEMO__.canvas;
      let x = W / 2, y = H / 2;
      if (window.__DEMO__.tracking && engine.player) { x = engine.player.x; y = engine.player.y; }
      x = Math.max(100, Math.min(1200, x)); y = Math.max(90, Math.min(750, y));
      canvas.style.transformOrigin = `${(x / W) * 100}% ${(y / H) * 100}%`;
      canvas.style.transform = `scale(${window.__DEMO__.zoom})`;
    };
    window.__DEMO__.step = () => {
      if (engine.status === 'running') {
        const steps = 4;
        for (let i = 0; i < steps; i++) engine.update(1 / 240);
      }
      window.__DEMO__.frame();
      engine.render(performance.now() / 1000);
    };
    window.__DEMO__.tick = seconds => {
      const frames = Math.round(seconds * 60);
      for (let i = 0; i < frames; i++) window.__DEMO__.step();
    };
    window.__DEMO__.start = async options => {
      await engine.start(options.core ?? 'wraith', options.difficulty ?? 'standard', options.seed ?? 'DEMO', options.mode ?? 'infinite', options.stage ?? 1);
      engine.tutorialEnabled = false;
      engine.tutorialStep = 5;
    };
    // Builds the same draft the UI is showing, so a take can answer the real
    // upgrade cards without a human click.
    window.__DEMO__.draft = null;
    window.__DEMO__.choose = (index = 0) => {
      const draft = engine.makeDraft(engine.pendingBossDraft ? 'boss' : 'level');
      const choice = draft.choices[index] || draft.choices[0];
      if (!choice) return false;
      engine.chooseUpgrade(choice.id);
      return true;
    };
  });
}

/** The autopilot's steering decision, run inside the page each frame. */
const DRIVE_SOURCE = `
window.__DEMO__.drive = (options) => {
  const engine = window.__DEMO__.engine;
  const mode = options.mode || 'combat';
  const p = engine.player;
  const living = engine.enemies.filter(enemy => !enemy.dead);
  const boss = living.find(enemy => enemy.kind === 'boss');
  const nearest = living.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
  const target = mode === 'boss' ? (boss || nearest) : nearest;

  // The demo pilot looks busy but stays alive: it circles the arena, keeps the
  // crosshair on a target and dodges both bodies and bullets.
  let x = Math.cos(engine.elapsed * 0.72) * 0.5;
  let y = Math.sin(engine.elapsed * 0.72) * 0.5;
  for (const enemy of living) {
    const dx = p.x - enemy.x, dy = p.y - enemy.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    if (d < 250) {
      const force = (250 - d) / 250 * (enemy.kind === 'boss' ? 1.8 : 1.15);
      x += dx / d * force; y += dy / d * force;
    }
  }
  for (const shot of engine.projectiles) {
    if (shot.friendly || shot.life <= 0) continue;
    const dx = p.x - shot.x, dy = p.y - shot.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    if (d < 150) { const force = (150 - d) / 150 * 2.2; x += dx / d * force; y += dy / d * force; }
  }
  if (p.x < 190) x += 1; if (p.x > 1410) x -= 1;
  if (p.y < 160) y += 1; if (p.y > 740) y -= 1;
  const length = Math.hypot(x, y);
  if (length > 1) { x /= length; y /= length; }
  engine.setTouchMove(x, y);
  if (target) {
    engine.pointer.inside = true;
    engine.pointer.down = Boolean(options.manual);
    engine.pointer.x = target.x; engine.pointer.y = target.y;
  } else {
    engine.pointer.down = false;
  }
  if (options.skills !== false) {
    if (engine.elapsed > 1.2 && p.echoCooldown <= 0) engine.triggerEcho();
    if (target && p.weaponCooldown <= 0 && engine.elapsed > 0.8 && Math.hypot(target.x - p.x, target.y - p.y) < 900) engine.triggerWeaponSkill();
    if (p.dashCooldown <= 0 && living.some(enemy => Math.hypot(enemy.x - p.x, enemy.y - p.y) < 80)) engine.triggerDash();
    if (p.sync >= 100) engine.triggerOverdrive();
  }
  if (options.invincible !== false && p.hp > 0 && p.hp < p.stats.maxHp * 0.25) p.hp = p.stats.maxHp * 0.6;

  const frame = options.frame || 0;

  // Keeps the arena at the density the scene asks for, so a take never looks
  // empty just because the random spawner happened to be quiet.
  // Cinematic takes drop the enemy callouts too: they are drawn inside the
  // world transform, so hiding the DOM HUD alone would leave them on screen.
  if (options.clean) for (const enemy of engine.enemies) enemy.showLabel = false;

  if (options.density) {
    const living = engine.enemies.filter(enemy => !enemy.dead && enemy.kind !== 'boss');
    if (living.length < options.density) {
      const kinds = ['drone', 'dart', 'drone', 'gunner', 'drone', 'splitter', 'sniper', 'drone'];
      engine.spawnEnemy(kinds[(frame + living.length) % kinds.length]);
    }
  }

  // Per-scene choreography. Each branch runs once per simulated frame so the
  // beats land at a predictable point in the clip.
  switch (options.script) {
    case 'rail': {
      // The lance lives ~1 s, so it fires on a strict 1.6 s cadence and a fresh
      // wave walks into it every 0.8 s. Any random frame of the clip then has
      // a good chance of showing the beam, and the poster is predictable.
      if (frame % 96 === 0) {
        engine.enemies = engine.enemies.filter(enemy => !enemy.dead);
      }
      if (frame % 48 === 0) {
        // Bodies sit on the firing line (a few just off it) so the clip shows
        // both the erase on the centre and the wound at the edge.
        const lanes = [0, 18, -22, 40, 96, 132];
        for (let index = 0; index < lanes.length; index++) {
          engine.spawnEnemy(index % 3 === 0 ? 'tank' : 'drone', 680 + index * 92, 450 + lanes[index], false);
          const placed = engine.enemies[engine.enemies.length - 1];
          if (placed) { placed.elite = false; placed.hp = placed.maxHp; }
        }
      }
      // Hold the pilot on the lane: the shot is framed around the beam, so
      // drifting would push the bodies out of it.
      p.x = 300; p.y = 450;
      engine.railAim = { angle: 0, at: engine.elapsed };
      if (frame % 96 === 30) p.weaponCooldown = 0;
      if (frame % 96 === 30 || (frame % 96 === 90 && p.weaponCooldown <= 0 && engine.beams.every(beam => beam.kind !== 'rail'))) {
        engine.triggerWeaponSkill();
      }
      break;
    }
    case 'echo': {
      // The echo is the shot's subject, so it is re-summoned on a cadence and
      // held near the pilot instead of chasing whatever is closest.
      if (frame % 150 === 60 && p.echoCooldown <= 0) engine.triggerEcho();
      if (p.echoCooldown > 0) p.echoCooldown = Math.min(p.echoCooldown, 0.2);
      break;
    }
    case 'overdrive': {
      // ZERO FIELD is only readable while it is running, so top the gauge up
      // and keep bodies on screen to dissolve.
      if (p.sync >= 100 && p.overdrive <= 0) engine.triggerOverdrive();
      if (p.overdrive <= 0 && p.sync < 100) p.sync = 100;
      if (frame % 20 === 0 && engine.enemies.filter(enemy => !enemy.dead).length < 14) {
        engine.spawnEnemy('drone', 300 + (frame * 37) % 900, 200 + (frame * 61) % 500, false);
      }
      break;
    }
    case 'draft': {
      // The card screen has to be on screen for most of the clip, so the pick
      // only happens near the end.
      if (engine.status === 'draft' && options.pickAt !== undefined && frame >= options.pickAt) {
        const draft = engine.makeDraft(engine.pendingBossDraft ? 'boss' : 'level');
        if (draft.choices[0]) engine.chooseUpgrade(draft.choices[0].id);
      }
      break;
    }
    default:
      // Drafts are answered so a long take never stalls on a card screen.
      if (engine.status === 'draft') { const draft = engine.makeDraft(engine.pendingBossDraft ? 'boss' : 'level'); if (draft.choices[0]) engine.chooseUpgrade(draft.choices[0].id); }
      break;
  }
  if (engine.status === 'checkpoint') engine.continueInfinite();
  return engine.status;
};
`;

/**
 * Records one scene. `action` receives helpers for staging the scene and for
 * advancing time, so every clip is written the same way.
 */
export async function recordScene(browser, spec) {
  const width = spec.width ?? 1920;
  const height = spec.height ?? 1080;
  const viewport = spec.viewport ?? { width, height };
  const scale = spec.deviceScaleFactor ?? 1;
  ensureDirs(path.join(DEMOS_DIR, '.raw'));
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    // The recording must match the viewport exactly: any other size makes
    // Playwright letterbox the capture with grey bars.
    recordVideo: { dir: path.join(DEMOS_DIR, '.raw'), size: viewport },
  });
  await context.addInitScript(() => {
    localStorage.setItem('echo-abyss-tutorial-complete', '1');
    window.__DEMO__ = { engine: null };
  });
  const page = await context.newPage();
  const video = page.video();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ECHO__);
  await page.evaluate(DRIVE_SOURCE);

  let window = null;
  try {
    // The capture starts when the page finished loading. Timestamping the
    // action tells the encoder which slice of the recording is the scene.
    const startedAt = Date.now();
    window = await spec.action(page);
    window = { ...(window ?? {}), startedAt, endedAt: Date.now() };
  } finally {
    // The video file only becomes available once the context is closed.
    await context.close();
  }
  const videoPath = await video.path();
  return { videoPath, sceneWindow: window ?? null, errors, width, height };
}

/** Duration in seconds of a media file, via ffmpeg's banner. */
export function probeDuration(ffmpeg, file) {
  // Without an output file ffmpeg writes the banner to stderr and exits 1, so
  // the duration is read from whichever stream carries it.
  let output = '';
  try {
    output = execFileSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(output);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function ensureDirs(...dirs) {
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
}

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
