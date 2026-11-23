// Canvas 2D renders a blurred fill dramatically slower than a plain one, and
// combining shadowBlur with globalCompositeOperation 'lighter' pushes Chromium
// off its fast path entirely: roughly 3.3s of frame time for 300 enemy bullets
// versus 6ms for the same bullets drawn from a pre-rendered sprite.
//
// Every glow here is therefore baked once into a small offscreen canvas and
// blitted with drawImage. The shipped look is preserved; only the cost changes.

export type Sprite = HTMLCanvasElement;

const cache = new Map<string, Sprite>();

/** Parses '#rgb', '#rrggbb' or 'rgb()/rgba()' into components. */
function parseColor(color: string) {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full = hex.length === 3 ? hex.split('').map(part => part + part).join('') : hex;
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
    };
  }
  const [r, g, b] = (color.match(/[\d.]+/g) ?? ['255', '255', '255']).map(Number);
  return { r: r ?? 255, g: g ?? 255, b: b ?? 255 };
}

const rgba = (color: string, alpha: number) => {
  const { r, g, b } = parseColor(color);
  return `rgba(${r},${g},${b},${alpha})`;
};

/**
 * A soft radial glow, sized so the bright core matches the requested radius.
 * Used for bullets, pickups and cores drawn in 'lighter' mode.
 */
export function glowSprite(color: string, radius: number, coreScale = 1): Sprite {
  const key = `glow:${color}:${radius}:${coreScale}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const size = Math.ceil(radius * 4);
  const center = size / 2;
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const ctx = sprite.getContext('2d')!;
  const core = Math.max(1, radius * coreScale);
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, radius * 2);
  gradient.addColorStop(0, rgba(color, 1));
  gradient.addColorStop(Math.min(0.9, core / (radius * 2)), rgba(color, 0.92));
  gradient.addColorStop(Math.min(0.97, (core * 1.9) / (radius * 2)), rgba(color, 0.42));
  gradient.addColorStop(Math.min(0.995, (core * 2.9) / (radius * 2)), rgba(color, 0.12));
  gradient.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  cache.set(key, sprite);
  return sprite;
}

/**
 * A pure bloom: no opaque core, just a soft radial falloff. This is what a
 * shadowBlur halo looks like when the shape itself supplies the solid colour,
 * so it reproduces the original bullet and shard look instead of a bright ball
 * that swallows the sprite it is supposed to sit behind.
 */
export function haloSprite(color: string, spread: number, intensity = 0.55): Sprite {
  const key = `halo:${color}:${spread}:${intensity}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const size = Math.ceil(spread * 2) + 2;
  const center = size / 2;
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const ctx = sprite.getContext('2d')!;
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, spread);
  gradient.addColorStop(0, rgba(color, intensity));
  gradient.addColorStop(0.28, rgba(color, intensity * 0.62));
  gradient.addColorStop(0.55, rgba(color, intensity * 0.24));
  gradient.addColorStop(0.8, rgba(color, intensity * 0.07));
  gradient.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  cache.set(key, sprite);
  return sprite;
}

/** Draws a glow sprite centred on (x, y). */
export function drawGlow(ctx: CanvasRenderingContext2D, sprite: Sprite, x: number, y: number, scale = 1) {
  const width = sprite.width * scale;
  const height = sprite.height * scale;
  ctx.drawImage(sprite, x - width / 2, y - height / 2, width, height);
}

/** A blurred rounded capsule, baked once and rotated at blit time. */
export function capsuleSprite(color: string, length: number, thickness: number, blur = 3): Sprite {
  const key = `capsule:${color}:${length}:${thickness}:${blur}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const pad = blur * 3;
  const width = Math.ceil(length + pad * 2);
  const height = Math.ceil(thickness + pad * 2);
  const sprite = document.createElement('canvas');
  sprite.width = width;
  sprite.height = height;
  const ctx = sprite.getContext('2d')!;
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.fillStyle = color;
  const y = height / 2 - thickness / 2;
  const radius = thickness / 2;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(pad, y, length, thickness, radius);
  else ctx.rect(pad, y, length, thickness);
  ctx.fill();
  // A second pass builds the bloom without needing a bigger blur radius.
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.35;
  ctx.fill();
  cache.set(key, sprite);
  return sprite;
}

/**
 * A baked beam band: one long capsule with a baked glow, drawn along its
 * length. Canvas shadowBlur on a stroke thousands of pixels long costs more
 * than an entire frame, so the rail's bands are pre-rendered like every other
 * glow in the scene.
 */
export function beamSprite(color: string, length: number, thickness: number): Sprite {
  const key = `beam:${color}:${length}:${thickness}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const pad = Math.ceil(thickness * 1.4) + 12;
  const width = Math.ceil(length + pad * 2);
  const height = Math.ceil(thickness + pad * 2);
  const sprite = document.createElement('canvas');
  sprite.width = width;
  sprite.height = height;
  const ctx = sprite.getContext('2d')!;
  const mid = height / 2;
  // A soft vertical falloff across the band, drawn as a stack of translucent
  // capsules so the core stays bright and the edges fade out.
  const bands = 12;
  for (let index = bands; index >= 1; index--) {
    const spread = thickness * (0.35 + index / bands * 0.95);
    ctx.globalAlpha = 0.055 + 0.16 / index;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(pad * 0.35, mid - spread / 2, length + pad * 1.3, spread, spread / 2);
    else ctx.rect(pad * 0.35, mid - spread / 2, length + pad * 1.3, spread);
    ctx.fill();
  }
  cache.set(key, sprite);
  return sprite;
}

/**
 * Draws a baked beam from (x1, y1) to (x2, y2). The sprite is built along +X
 * and rotated once at blit time, which keeps a full-length lance to a single
 * drawImage instead of a shadowed stroke.
 */
export function drawBeam(ctx: CanvasRenderingContext2D, sprite: Sprite, x1: number, y1: number, x2: number, y2: number, scale = 1) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const pad = sprite.height / 2;
  ctx.save();
  ctx.translate(x1, y1);
  ctx.rotate(angle);
  const height = sprite.height * scale;
  // The baked padding hangs past both ends; keep the visible band centred on
  // the requested segment.
  ctx.drawImage(sprite, -pad * scale, -height / 2, sprite.width * scale, height);
  ctx.restore();
}

/** Releases cached sprites so a new run does not inherit stale colours. */
export function clearSpriteCache() {
  cache.clear();
}

/**
 * The static nebula backdrop, painted once at field size. Rendering the same
 * radial gradient every frame measured ~12ms; blitting this canvas is ~1ms.
 */
export function buildBackgroundSprite(width: number, height: number): Sprite {
  const sprite = document.createElement('canvas');
  sprite.width = width;
  sprite.height = height;
  const ctx = sprite.getContext('2d')!;
  const gradient = ctx.createRadialGradient(width * 0.5, height * 0.45, 30, width * 0.5, height * 0.45, 850);
  gradient.addColorStop(0, '#0b1620');
  gradient.addColorStop(0.55, '#070c14');
  gradient.addColorStop(1, '#030509');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  return sprite;
}
