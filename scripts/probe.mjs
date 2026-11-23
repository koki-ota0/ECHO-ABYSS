import { chromium } from '@playwright/test';
import chromiumBin, { inflate, setupLambdaEnvironment } from '@sparticuz/chromium';
import path from 'node:path';

// Fast balance probe. Runs the real GameEngine headlessly at a fixed timestep
// with the render loop disabled, so one 60 second run costs well under a
// second instead of a minute. Several pilot skill levels are simulated so the
// same stage can be judged for a perfect player and for an ordinary one.
//
// node scripts/probe.mjs '<json config>'
// config: [{ mode:'level', stage:1, meta:'none'|'progression'|'max', policies:['ace','good','casual'], seeds:['A','B'], seconds:90 }]

const configs = JSON.parse(process.argv[2] ?? '[]');
if (!configs.length) throw new Error('pass a JSON array of probe configs');

await inflate(path.resolve('node_modules/@sparticuz/chromium/bin/al2023.tar.br'));
setupLambdaEnvironment('/tmp/al2023/lib');
chromiumBin.setGraphicsMode = false;
const args = chromiumBin.args.filter(arg => arg !== '--single-process' && arg !== '--in-process-gpu');
const browser = await chromium.launch({ executablePath: await chromiumBin.executablePath(), args, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.stack || error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

await page.evaluate(async () => {
  const { GameEngine } = await import('/src/game/GameEngine.ts');
  const campaign = await import('/src/game/campaign.ts');
  const canvas = document.createElement('canvas');
  canvas.width = 1600; canvas.height = 900;
  window.__probe = { GameEngine, campaign, canvas, engine: null, draft: null };

  // ---- pilot policies -----------------------------------------------------
  // The engine is stepped by hand; the pilot only decides movement, skill use
  // and draft picks, exactly like a human at the keyboard.
  const PRIORITY = [
    'splitstream', 'amplifier', 'singularity', 'echo_damage', 'fork', 'dash_damage',
    'overclock', 'pierce', 'critical', 'echo_time', 'resonance', 'vitality',
    'armor', 'shield', 'afterimage', 'mobility', 'echo_cooldown', 'harvest',
    'dash_echo', 'dash_cooldown', 'leech', 'interest', 'magnet', 'luck',
    'zero_time', 'velocity', 'seeker', 'chain', 'revive',
  ];

  // track = how many incoming bullets the pilot can hold in mind at once,
  // lapse = a short window where it stops correcting, like a human blink.
  // These make the middle policies a believable stand-in for real play.
  const SKILL = {
    ace: { reaction: 0.1, avoid: 165, noise: 0.02, dashAt: 55, dash: true, skills: true, track: 14, lapseEvery: 0, lapseFor: 0 },
    good: { reaction: 0.22, avoid: 145, noise: 0.16, dashAt: 52, dash: true, skills: true, track: 7, lapseEvery: 9, lapseFor: 0.28 },
    casual: { reaction: 0.36, avoid: 118, noise: 0.34, dashAt: 30, dash: false, skills: true, track: 4, lapseEvery: 6, lapseFor: 0.5 },
  };

  function worldInput(engine, cfg, mem, dt) {
    const p = engine.player;
    const now = engine.elapsed;
    // Human reaction: decisions are refreshed on an interval, not per frame.
    if (cfg.reaction === 0 || now >= mem.next) {
      mem.next = now + cfg.reaction;
      let x = 0, y = 0, nearest = 9999, nearestEnemy = null;
      for (const enemy of engine.enemies) {
        if (enemy.dead) continue;
        const dx = p.x - enemy.x, dy = p.y - enemy.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const gap = d - enemy.radius;
        if (gap < nearest) { nearest = gap; nearestEnemy = enemy; }
        const range = enemy.kind === 'boss' ? 320 : 240;
        if (d < range + enemy.radius) {
          const force = (range + enemy.radius - d) / range * 1.15;
          x += dx / d * force; y += dy / d * force;
        }
      }
      let danger = null, dangerD = 9999;
      // Only the closest few bullets are tracked: a screen swarming with 120
      // shots is exactly when a human starts getting clipped.
      const incoming = [];
      for (const shot of engine.projectiles) {
        if (shot.friendly || shot.life <= 0) continue;
        const d = Math.hypot(p.x - shot.x, p.y - shot.y);
        if (d < cfg.avoid) incoming.push({ shot, d });
      }
      incoming.sort((a, b) => a.d - b.d);
      for (const { shot, d } of incoming.slice(0, cfg.track)) {
        const dx = p.x - shot.x, dy = p.y - shot.y;
        if (d < dangerD) { dangerD = d; danger = shot; }
        const force = (cfg.avoid - d) / cfg.avoid * 3.1;
        x += dx / d * force; y += dy / d * force;
      }
      for (const enemy of engine.enemies) {
        if (enemy.dead) continue;
        const dx = p.x - enemy.x, dy = p.y - enemy.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        if (d < 90 + enemy.radius) {
          const force = (90 + enemy.radius - d) / 90 * 2.2;
          x += dx / d * force; y += dy / d * force;
        }
      }
      if (p.x < 150) x += 1.1; if (p.x > 1450) x -= 1.1;
      if (p.y < 140) y += 1.1; if (p.y > 760) y -= 1.1;
      if (cfg.noise > 0) {
        x += Math.cos(now * 0.7) * cfg.noise; y += Math.sin(now * 1.1) * cfg.noise;
      }
      const length = Math.hypot(x, y);
      mem.x = length > 1 ? x / length : x;
      mem.y = length > 1 ? y / length : y;
      // Blink: for a short window the pilot keeps its old heading instead of
      // steering out of the way.
      if (cfg.lapseEvery > 0) {
        if (now >= (mem.lapseAt ?? 0)) {
          mem.lapseAt = now + cfg.lapseEvery;
          mem.lapseEnd = now + cfg.lapseFor;
        }
        if (now < (mem.lapseEnd ?? 0)) { mem.x = 0; mem.y = 0; }
      }
      mem.nearest = nearest;
      mem.danger = danger;
      mem.dangerD = dangerD;
      mem.target = nearestEnemy;
    }
    // Weapon skill goes toward the densest lane on cooldown, like the UI does.
    if (cfg.skills && p.weaponCooldown <= 0 && (mem.nearest ?? 999) < 900 && engine.elapsed > 2) {
      engine.triggerWeaponSkill();
    }
    if (cfg.skills && p.echoCooldown <= 0 && engine.elapsed > 5 && (mem.nearest ?? 999) < 420) engine.triggerEcho();
    if (p.sync >= 100) engine.triggerOverdrive();
    if (cfg.dash && p.dashCooldown <= 0 && mem.danger && (mem.dangerD ?? 999) < cfg.dashAt) engine.triggerDash();
    return { x: mem.x ?? 0, y: mem.y ?? 0 };
  }

  window.__probe.run = async ({ mode, stage, meta, policy, seed, seconds, difficulty }) => {
    const { GameEngine, campaign, canvas } = window.__probe;
    // Reset persistent combat buffs for each probe.
    localStorage.setItem(campaign.CAMPAIGN_XP_KEY, '0');
    localStorage.setItem(campaign.CAMPAIGN_LOADOUT_KEY, '{}');
    localStorage.setItem('echo-abyss-unlocked-level', '100');
    localStorage.setItem('echo-abyss-tutorial-complete', '1');
    if (mode === 'level' && meta && meta !== 'none') {
      if (meta === 'max') {
        localStorage.setItem(campaign.CAMPAIGN_LOADOUT_KEY, JSON.stringify(Object.fromEntries(campaign.INITIAL_BONUSES.map(b => [b.id, b.maxRank]))));
      } else {
        const order = ['damage', 'fireRate', 'vitality', 'echoDamage', 'vitality', 'damage', 'fireRate', 'vitality', 'echoDamage', 'damage'];
        for (let previous = 1; previous < stage; previous++) {
          const available = campaign.readCampaignXp() + campaign.getStageXp(previous, true);
          localStorage.setItem(campaign.CAMPAIGN_XP_KEY, String(available));
          let bought = true;
          while (bought) {
            bought = false;
            for (const id of order) { if (campaign.purchaseInitialBonus(id).changed) bought = true; }
          }
        }
      }
    }

    const engine = new GameEngine(canvas, {
      onHud: () => {}, onStatus: () => {}, onDraft: draft => { window.__probe.draft = draft; },
      onGameOver: () => {}, onToast: () => {},
    });
    cancelAnimationFrame(engine.animation);
    engine.render = () => {}; // never draw during a probe
    window.__probe.engine = engine;
    await engine.start('wraith', 'standard', seed, mode, stage, undefined);
    if (difficulty === 'abyss' && mode === 'infinite') engine.difficulty = 'abyss';

    const cfg = SKILL[policy];
    const mem = { next: 0, x: 0, y: 0 };
    const dt = 1 / 60;
    let hpLoss = 0, hits = 0, minHp = engine.player.hp, lastHp = engine.player.hp;
    let peakEnemies = 0, peakProjectiles = 0, sumEnemies = 0, samples = 0;
    const timeline = [];
    let nextStamp = 0;
    const originalHurt = engine.hurtPlayer.bind(engine);
    engine.hurtPlayer = raw => {
      const before = engine.player.hp;
      originalHurt(raw);
      const delta = before - engine.player.hp;
      if (delta > 0) { hpLoss += delta; hits += 1; }
    };
    // How much fire the field actually produces, and how many enemies exist
    // long enough to shoot at all.
    let shotsFired = 0, spawned = 0;
    const originalShot = engine.enemyShot.bind(engine);
    engine.enemyShot = (...args) => { shotsFired++; return originalShot(...args); };
    const originalSpawn = engine.spawnEnemy.bind(engine);
    engine.spawnEnemy = (...args) => { spawned++; return originalSpawn(...args); };
    let shotsBySector = {};

    let steps = 0;
    const maxSteps = Math.round(seconds / dt);
    while (steps < maxSteps) {
      if (engine.status === 'draft') {
        const choices = window.__probe.draft?.choices ?? [];
        let pick = choices[0];
        for (const id of PRIORITY) {
          const match = choices.find(choice => choice.id === id);
          if (match) { pick = match; break; }
        }
        if (pick) engine.chooseUpgrade(pick.id); else break;
        continue;
      }
      if (engine.status === 'checkpoint') { engine.continueInfinite(); continue; }
      if (engine.status === 'gameover') break;
      if (engine.status === 'paused') { engine.resume(); continue; }

      const move = worldInput(engine, cfg, mem, dt);
      engine.touchMove.x = move.x; engine.touchMove.y = move.y;
      engine.update(dt);
      steps++;
      const p = engine.player;
      minHp = Math.min(minHp, p.hp);
      peakEnemies = Math.max(peakEnemies, engine.enemies.filter(e => !e.dead).length);
      peakProjectiles = Math.max(peakProjectiles, engine.projectiles.filter(s => !s.friendly).length);
      sumEnemies += engine.enemies.filter(e => !e.dead).length;
      samples++;
      if (engine.elapsed >= nextStamp) {
        timeline.push({
          t: Math.round(engine.elapsed), hp: Math.round(p.hp), sector: engine.sector, shots: shotsFired,
          enemies: engine.enemies.filter(e => !e.dead).length, level: engine.level,
          bossHp: (() => { const boss = engine.enemies.find(e => e.kind === 'boss' && !e.dead); return boss ? Math.round(boss.hp) : null; })(),
        });
        nextStamp += 5;
      }
      lastHp = p.hp;
    }

    const result = {
      mode, stage, meta: meta ?? 'none', policy, seed, difficulty: difficulty ?? 'standard',
      status: engine.status, victory: engine.status === 'gameover' && engine.player.hp > 0,
      hp: Math.round(engine.player.hp), maxHp: engine.player.stats.maxHp,
      hpRatio: +(engine.player.hp / engine.player.stats.maxHp).toFixed(3),
      minHp: Math.round(minHp), hpLoss: Math.round(hpLoss), hits,
      elapsed: +engine.elapsed.toFixed(1), sector: engine.sector, level: engine.level,
      kills: engine.kills, bossDefeated: engine.bossDefeated,
      spawned, shotsFired, shotsPerSec: +(shotsFired / Math.max(1, engine.elapsed)).toFixed(2),
      avgEnemies: +(sumEnemies / Math.max(1, samples)).toFixed(1),
      spawned, shotsFired, shotsPerSec: +(shotsFired / Math.max(1, engine.elapsed)).toFixed(2),
      peakEnemies, peakProjectiles,
      stacks: { ...engine.stacks },
      timeline,
    };
    engine.destroy();
    return result;
  };
});

const results = [];
for (const config of configs) {
  for (const policy of config.policies ?? ['ace']) {
    for (const seed of config.seeds ?? ['PROBE']) {
      results.push(await page.evaluate(input => window.__probe.run(input), {
        mode: config.mode, stage: config.stage ?? 1, meta: config.meta ?? 'none',
        policy, seed, seconds: config.seconds ?? 90, difficulty: config.difficulty,
      }));
    }
  }
}

for (const result of results) {
  const extra = result.mode === 'level' ? `stage ${String(result.stage).padStart(3, '0')} (${result.meta})` : `${result.difficulty} sector ${result.sector}`;
  console.log(`${result.policy.padEnd(6)} ${extra.padEnd(28)} ${String(result.status).padEnd(9)} hp ${String(result.hp).padStart(4)}/${String(result.maxHp).padEnd(4)} (${String(Math.round(result.hpRatio * 100)).padStart(3)}%) min ${String(result.minHp).padStart(4)} loss ${String(result.hpLoss).padStart(4)} hits ${String(result.hits).padStart(3)} t ${String(result.elapsed).padStart(5)}s lvl ${String(result.level).padStart(2)} en ${String(result.avgEnemies).padStart(4)}/${String(result.peakEnemies).padStart(3)} bullets ${String(result.peakProjectiles).padStart(3)} spawn ${String(result.spawned).padStart(4)} fire ${String(result.shotsPerSec).padStart(4)}/s boss ${result.bossDefeated}`);
}
if (process.env.PROBE_JSON) console.log(JSON.stringify(results));
if (errors.length) console.log('ERRORS', errors.slice(0, 4));
await browser.close();
