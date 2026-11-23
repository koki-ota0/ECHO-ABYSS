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
