// Scene list for the demo capture. Each entry is one self-contained take that
// becomes its own clip, so the editor can pick, reorder or re-time them freely.
//
// Camera presets are applied by styling the real game canvas, which is how the
// "different angles" are produced without touching gameplay code:
//   full    the shipped framing
//   push    a slow push-in on the player
//   punch   a 2x crop around the player for ability detail
//   letter  a 2.39:1 crop with the HUD hidden
//
// Every scene steps the engine at a fixed 1/60 s, so a take is deterministic
// and never depends on how fast the capture machine is.

export const SCENES = [
  { id: '01-menu', kind: 'menu', seconds: 7, camera: 'full', density: 0, note: 'タイトル → モード選択 → 初期ボーナス画面' },
  { id: '02-combat', kind: 'game', seconds: 9, camera: 'full', mode: 'infinite', core: 'wraith', seed: 'DEMO-COMBAT', density: 20, note: '基本戦闘（残響・手動照準・ダッシュ）' },
  { id: '03-rail', kind: 'game', seconds: 8, camera: 'full', mode: 'level', stage: 40, core: 'wraith', seed: 'DEMO-RAIL', scripted: 'rail', density: 0, note: '貫通レール：中心撃破・周辺大ダメージ' },
  { id: '04-boss', kind: 'game', seconds: 10, camera: 'push', mode: 'infinite', boss: 'lancer', seed: 'DEMO-BOSS', density: 12, note: 'ボス戦（KAIROS）' },
  { id: '05-draft', kind: 'game', seconds: 8, camera: 'full', mode: 'level', stage: 25, core: 'tempest', seed: 'DEMO-DRAFT', scripted: 'draft', density: 0, note: 'レベルアップ抽選→選択' },
  { id: '06-punch-echo', kind: 'game', seconds: 6, camera: 'punch', mode: 'infinite', core: 'wraith', seed: 'DEMO-ECHO', scripted: 'echo', density: 8, note: '残響召喚の寄り' },
  { id: '07-overdrive', kind: 'game', seconds: 6, camera: 'push', mode: 'infinite', core: 'tempest', seed: 'DEMO-OD', scripted: 'overdrive', density: 6, note: 'ZERO FIELD（オーバードライブ）' },
  { id: '08-bastion', kind: 'game', seconds: 7, camera: 'push', mode: 'infinite', core: 'bastion', seed: 'DEMO-BASTION', density: 12, note: 'BASTION 全方位射撃' },
  { id: '09-letterbox', kind: 'game', seconds: 9, camera: 'letter', mode: 'level', stage: 85, core: 'wraith', seed: 'DEMO-CINE', density: 16, note: 'シネマティック比率（HUDなし）' },
  { id: '10-vertical', kind: 'game', seconds: 8, camera: 'vertical', vertical: true, mode: 'level', stage: 40, core: 'wraith', seed: 'DEMO-VERT', density: 14, note: '縦型（SNS リール / Shorts 用）' },
  { id: '11-boss-chorus', kind: 'game', seconds: 8, camera: 'punch', mode: 'infinite', boss: 'choir', seed: 'DEMO-CHOIR', density: 10, note: 'NEXUS 弾幕の寄り' },
  { id: '12-final', kind: 'game', seconds: 10, camera: 'letter', mode: 'infinite', boss: 'warden', seed: 'DEMO-FINAL', density: 14, note: 'AION 最終ボス（シネマティック）' },
  { id: '13-tank', kind: 'game', seconds: 6, camera: 'punch', mode: 'infinite', core: 'bastion', seed: 'DEMO-TANK', scripted: 'tank', density: 6, note: '装甲タンクの破壊（寄り）' },
  { id: '14-cards', kind: 'game', seconds: 7, camera: 'full', mode: 'level', stage: 60, core: 'tempest', seed: 'DEMO-CARDS', scripted: 'draft', density: 0, note: 'カード選択アップ（別アングル）' },
];

// Zoom is applied by the demo camera in lib.mjs (it can follow the pilot);
// `letter` additionally hides the HUD for a cut that can carry titles.
export const CAMERA = {
  full: { zoom: 1, track: false },
  push: { zoom: 1.35, track: true },
  punch: { zoom: 2, track: true },
  letter: { zoom: 1.08, track: true, hideHud: true },
  // Portrait takes run in a phone-sized viewport; the HUD is off so the crop to
  // 9:16 is pure gameplay.
  vertical: { zoom: 1, track: false, hideHud: false },
};
