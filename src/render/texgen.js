// Procedural texture generation.
//
// The game ships no image files: every block, item, mob and UI texture is drawn
// at runtime into a pixel buffer by a painter function, then uploaded as one
// layer of a WebGL2 2D texture array. Using an array rather than an atlas means
// each texture gets its own mip chain, so there is no bleeding between
// neighbouring tiles at distance — the classic voxel-atlas artefact.
//
// Painters are deterministic: they receive a `Random` seeded from the texture
// name, so a texture looks identical every run.

import { Random, hashString } from '../core/rng.js';
import { clamp, lerp, hsv, mixHex } from '../core/math.js';

/** Every block/item texture is drawn at this resolution. */
export const TEX_SIZE = 16;

// ---------------------------------------------------------------------------
// Pixel buffer with a painting-oriented helper API
// ---------------------------------------------------------------------------

export class Pixels {
  constructor(size = TEX_SIZE) {
    this.size = size;
    this.data = new Uint8ClampedArray(size * size * 4);
  }

  index(x, y) { return ((y | 0) * this.size + (x | 0)) * 4; }

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.size && y < this.size; }

  /** Write a pixel from a packed 0xRRGGBB colour. */
  set(x, y, hex, a = 255) {
    if (!this.inBounds(x, y)) return this;
    const i = this.index(x, y);
    this.data[i] = (hex >> 16) & 255;
    this.data[i + 1] = (hex >> 8) & 255;
    this.data[i + 2] = hex & 255;
    this.data[i + 3] = a;
    return this;
  }

  /** Alpha-blend a colour over the existing pixel. */
  blend(x, y, hex, alpha = 1) {
    if (!this.inBounds(x, y) || alpha <= 0) return this;
    const i = this.index(x, y);
    const sr = (hex >> 16) & 255, sg = (hex >> 8) & 255, sb = hex & 255;
    const da = this.data[i + 3] / 255;
    const outA = alpha + da * (1 - alpha);
    if (outA <= 0) { this.data[i + 3] = 0; return this; }
    this.data[i] = (sr * alpha + this.data[i] * da * (1 - alpha)) / outA;
    this.data[i + 1] = (sg * alpha + this.data[i + 1] * da * (1 - alpha)) / outA;
    this.data[i + 2] = (sb * alpha + this.data[i + 2] * da * (1 - alpha)) / outA;
    this.data[i + 3] = outA * 255;
    return this;
  }

  get(x, y) {
    if (!this.inBounds(x, y)) return 0;
    const i = this.index(x, y);
    return (this.data[i] << 16) | (this.data[i + 1] << 8) | this.data[i + 2];
  }

  getAlpha(x, y) {
    if (!this.inBounds(x, y)) return 0;
    return this.data[this.index(x, y) + 3];
  }

  fill(hex, a = 255) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) this.set(x, y, hex, a);
    }
    return this;
  }

  clear() { this.data.fill(0); return this; }

  rect(x, y, w, h, hex, a = 255) {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) this.set(i, j, hex, a);
    }
    return this;
  }

  /** Outline of a rectangle, 1px wide. */
  frame(x, y, w, h, hex, a = 255) {
    for (let i = x; i < x + w; i++) { this.set(i, y, hex, a); this.set(i, y + h - 1, hex, a); }
    for (let j = y; j < y + h; j++) { this.set(x, j, hex, a); this.set(x + w - 1, j, hex, a); }
    return this;
  }

  hline(x0, x1, y, hex, a = 255) {
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
    for (let x = x0; x <= x1; x++) this.set(x, y, hex, a);
    return this;
  }

  vline(x, y0, y1, hex, a = 255) {
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    for (let y = y0; y <= y1; y++) this.set(x, y, hex, a);
    return this;
  }

  line(x0, y0, x1, y1, hex, a = 255) {
    // Bresenham — pixel art lines, no anti-aliasing.
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this.set(x0, y0, hex, a);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    return this;
  }

  circle(cx, cy, r, hex, a = 255, filled = true) {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (filled ? d <= r2 : Math.abs(Math.sqrt(d) - r) < 0.6) this.set(x, y, hex, a);
      }
    }
    return this;
  }

  /** Scatter `count` single pixels of `hex` using `rng`. */
  speckle(rng, count, hex, alpha = 1) {
    for (let i = 0; i < count; i++) {
      this.blend(rng.int(this.size), rng.int(this.size), hex, alpha);
    }
    return this;
  }

  /**
   * Per-pixel brightness jitter — the signature look of Minecraft's stone,
   * dirt and wool textures. `amount` is in 0..1 of full brightness.
   */
  grain(rng, amount = 0.12, mono = true) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const i = this.index(x, y);
        if (this.data[i + 3] === 0) continue;
        if (mono) {
          const d = (rng.next() * 2 - 1) * amount * 255;
          this.data[i] += d; this.data[i + 1] += d; this.data[i + 2] += d;
        } else {
          this.data[i] += (rng.next() * 2 - 1) * amount * 255;
          this.data[i + 1] += (rng.next() * 2 - 1) * amount * 255;
          this.data[i + 2] += (rng.next() * 2 - 1) * amount * 255;
        }
      }
    }
    return this;
  }

  /** Blotchy clusters, for ore-bearing stone and grass patches. */
  blotches(rng, count, hex, radius = 2, alpha = 1) {
    for (let i = 0; i < count; i++) {
      const cx = rng.int(this.size), cy = rng.int(this.size);
      const r = radius * (0.5 + rng.next());
      for (let y = Math.floor(cy - r); y <= cy + r; y++) {
        for (let x = Math.floor(cx - r); x <= cx + r; x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d > r) continue;
          // Wrap so the texture tiles seamlessly.
          this.blend(mod(x, this.size), mod(y, this.size), hex,
            alpha * (1 - d / r) * (0.6 + rng.next() * 0.4));
        }
      }
    }
    return this;
  }

  /** Darken/lighten every opaque pixel. `f` > 1 brightens. */
  scale(f) {
    for (let i = 0; i < this.data.length; i += 4) {
      if (this.data[i + 3] === 0) continue;
      this.data[i] *= f; this.data[i + 1] *= f; this.data[i + 2] *= f;
    }
    return this;
  }

  /** Multiply by a tint colour. */
  tint(hex, strength = 1) {
    const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
    for (let i = 0; i < this.data.length; i += 4) {
      if (this.data[i + 3] === 0) continue;
      this.data[i] = lerp(this.data[i], this.data[i] * r, strength);
      this.data[i + 1] = lerp(this.data[i + 1], this.data[i + 1] * g, strength);
      this.data[i + 2] = lerp(this.data[i + 2], this.data[i + 2] * b, strength);
    }
    return this;
  }

  /** 1px dark outline on the outside of opaque pixels — used for item icons. */
  outline(hex = 0x000000, alpha = 1) {
    const src = new Uint8ClampedArray(this.data);
    const at = (x, y) => (x < 0 || y < 0 || x >= this.size || y >= this.size)
      ? 0 : src[(y * this.size + x) * 4 + 3];
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (at(x, y) > 0) continue;
        if (at(x - 1, y) > 0 || at(x + 1, y) > 0 || at(x, y - 1) > 0 || at(x, y + 1) > 0) {
          this.set(x, y, hex, alpha * 255);
        }
      }
    }
    return this;
  }

  /** Add a lit top-left / shaded bottom-right bevel, as on stone bricks. */
  bevel(x, y, w, h, light = 0.28, dark = 0.28) {
    for (let i = x; i < x + w; i++) {
      this.shadePixel(i, y, light);
      this.shadePixel(i, y + h - 1, -dark);
    }
    for (let j = y; j < y + h; j++) {
      this.shadePixel(x, j, light);
      this.shadePixel(x + w - 1, j, -dark);
    }
    return this;
  }

  shadePixel(x, y, amount) {
    if (!this.inBounds(x, y)) return this;
    const i = this.index(x, y);
    if (this.data[i + 3] === 0) return this;
    if (amount >= 0) {
      this.data[i] = lerp(this.data[i], 255, amount);
      this.data[i + 1] = lerp(this.data[i + 1], 255, amount);
      this.data[i + 2] = lerp(this.data[i + 2], 255, amount);
    } else {
      const a = -amount;
      this.data[i] = lerp(this.data[i], 0, a);
      this.data[i + 1] = lerp(this.data[i + 1], 0, a);
      this.data[i + 2] = lerp(this.data[i + 2], 0, a);
    }
    return this;
  }

  /** Copy another buffer over this one, honouring alpha. */
  draw(other, ox = 0, oy = 0) {
    for (let y = 0; y < other.size; y++) {
      for (let x = 0; x < other.size; x++) {
        const a = other.getAlpha(x, y);
        if (a === 0) continue;
        this.blend(x + ox, y + oy, other.get(x, y), a / 255);
      }
    }
    return this;
  }

  /** Mirror horizontally. */
  flipX() {
    const s = this.size;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s / 2; x++) {
        const a = this.index(x, y), b = this.index(s - 1 - x, y);
        for (let k = 0; k < 4; k++) {
          const t = this.data[a + k]; this.data[a + k] = this.data[b + k]; this.data[b + k] = t;
        }
      }
    }
    return this;
  }

  clone() {
    const p = new Pixels(this.size);
    p.data.set(this.data);
    return p;
  }

  /** Rotate 90 degrees clockwise `n` times. */
  rotate(n = 1) {
    n = ((n % 4) + 4) % 4;
    let cur = this;
    for (let k = 0; k < n; k++) {
      const out = new Pixels(cur.size);
      const s = cur.size;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const i = cur.index(x, y), j = out.index(s - 1 - y, x);
          for (let c = 0; c < 4; c++) out.data[j + c] = cur.data[i + c];
        }
      }
      cur = out;
    }
    if (cur !== this) this.data.set(cur.data);
    return this;
  }
}

const mod = (a, n) => ((a % n) + n) % n;

// ---------------------------------------------------------------------------
// Colour helpers for painters
// ---------------------------------------------------------------------------

/** Lighten (t>0) or darken (t<0) a packed colour. */
export function shade(hex, t) {
  return t >= 0 ? mixHex(hex, 0xffffff, t) : mixHex(hex, 0x000000, -t);
}

export { mixHex, hsv };

/** Deterministic value noise on a 2D grid, used for organic textures. */
export function valueNoise2(rng, size, freq) {
  const g = freq + 1;
  const grid = new Float32Array(g * g);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * freq, fy = (y / size) * freq;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      // Wrap the lattice so textures tile.
      const gx0 = x0 % freq, gy0 = y0 % freq;
      const gx1 = (x0 + 1) % freq, gy1 = (y0 + 1) % freq;
      const v00 = grid[gy0 * g + gx0], v10 = grid[gy0 * g + gx1];
      const v01 = grid[gy1 * g + gx0], v11 = grid[gy1 * g + gx1];
      out[y * size + x] = lerp(lerp(v00, v10, sx), lerp(v01, v11, sx), sy);
    }
  }
  return out;
}

/** Multi-octave version of `valueNoise2`, normalised to 0..1. */
export function fbm2(rng, size, octaves = 3, baseFreq = 4) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0, freq = baseFreq;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise2(rng, size, Math.max(2, Math.round(freq)));
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp;
    amp *= 0.5;
    freq *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// ---------------------------------------------------------------------------
// Texture registry
// ---------------------------------------------------------------------------

const painters = new Map();     // name -> painter(px, rng, name)
const layerIndex = new Map();   // name -> layer
const layerNames = [];          // layer -> name
const generated = [];           // layer -> Pixels
/** Animated textures: layer -> {frames: Pixels[], speed, interpolate} */
const animations = new Map();

/**
 * Register a texture painter.
 * @param {string} name
 * @param {(px: Pixels, rng: Random, name: string) => void} painter
 */
export function registerTexture(name, painter) {
  painters.set(name, painter);
  return name;
}

/**
 * Register an animated texture; `painter` is called once per frame with the
 * frame index and total, and the renderer cycles layers at `speed` ticks/frame.
 */
export function registerAnimated(name, frameCount, painter, speed = 2) {
  painters.set(name, { frameCount, painter, speed, animated: true });
  return name;
}

/** Register a texture derived from another (tinting, overlays, rotation). */
export function derive(name, source, transform) {
  registerTexture(name, (px, rng) => {
    paintInto(source, px);
    transform(px, rng);
  });
  return name;
}

export function hasTexture(name) { return painters.has(name); }

/** Paint a named texture into an existing buffer (for derived textures). */
export function paintInto(name, px) {
  const p = painters.get(name);
  if (!p) { px.fill(0xff00ff); return px; }
  const rng = new Random(hashString(name));
  if (p.animated) p.painter(px, rng, 0, p.frameCount);
  else p(px, rng, name);
  return px;
}

/** Resolve a texture name to its array layer, generating on first use. */
export function layerOf(name) {
  let l = layerIndex.get(name);
  if (l !== undefined) return l;
  const painter = painters.get(name);
  if (!painter) {
    if (!layerIndex.has('__missing')) buildMissing();
    return layerIndex.get('__missing');
  }
  if (painter.animated) {
    // Animated textures occupy one layer per frame, contiguous.
    const base = generated.length;
    for (let f = 0; f < painter.frameCount; f++) {
      const px = new Pixels(TEX_SIZE);
      painter.painter(px, new Random(hashString(name) + f * 7919), f, painter.frameCount);
      generated.push(px);
      layerNames.push(`${name}#${f}`);
    }
    layerIndex.set(name, base);
    animations.set(base, { frames: painter.frameCount, speed: painter.speed });
    return base;
  }
  l = generated.length;
  const px = new Pixels(TEX_SIZE);
  const rng = new Random(hashString(name));
  painter(px, rng, name);
  generated.push(px);
  layerNames.push(name);
  layerIndex.set(name, l);
  return l;
}

function buildMissing() {
  const px = new Pixels(TEX_SIZE);
  // The classic magenta/black checkerboard.
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      px.set(x, y, ((x >> 3) + (y >> 3)) % 2 ? 0x000000 : 0xf800f8);
    }
  }
  layerIndex.set('__missing', generated.length);
  layerNames.push('__missing');
  generated.push(px);
}

/** Force-generate every registered texture (called once at startup). */
export function generateAll() {
  buildMissing();
  const names = [...painters.keys()].sort();
  for (const n of names) layerOf(n);
  return generated.length;
}

export function textureCount() { return generated.length; }
export function texturePixels(layer) { return generated[layer]; }
export function textureNameOf(layer) { return layerNames[layer]; }
export function animationInfo() { return animations; }
export function allTextureNames() { return [...painters.keys()]; }

/**
 * Pack every generated texture into a single Uint8Array suitable for
 * `gl.texImage3D` with TEXTURE_2D_ARRAY.
 */
export function packLayers() {
  const n = generated.length;
  const stride = TEX_SIZE * TEX_SIZE * 4;
  const out = new Uint8Array(n * stride);
  for (let i = 0; i < n; i++) out.set(generated[i].data, i * stride);
  return { data: out, layers: n, size: TEX_SIZE };
}

/** Render one texture to a data URL — used by the HUD and item icons. */
export function toCanvas(layer, scale = 1) {
  const px = generated[layer];
  if (!px) return null;
  const c = document.createElement('canvas');
  c.width = px.size * scale;
  c.height = px.size * scale;
  const ctx = c.getContext('2d');
  const img = new ImageData(new Uint8ClampedArray(px.data), px.size, px.size);
  const tmp = document.createElement('canvas');
  tmp.width = px.size; tmp.height = px.size;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, c.width, c.height);
  return c;
}

// ---------------------------------------------------------------------------
// Larger sheets (mob skins, UI). These live in their own texture units rather
// than the 16x16 block array.
// ---------------------------------------------------------------------------

const sheets = new Map();  // name -> {width, height, pixels: Pixels-like}

export class Sheet {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
  index(x, y) { return ((y | 0) * this.width + (x | 0)) * 4; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }
  set(x, y, hex, a = 255) {
    if (!this.inBounds(x, y)) return this;
    const i = this.index(x, y);
    this.data[i] = (hex >> 16) & 255;
    this.data[i + 1] = (hex >> 8) & 255;
    this.data[i + 2] = hex & 255;
    this.data[i + 3] = a;
    return this;
  }
  get(x, y) {
    if (!this.inBounds(x, y)) return 0;
    const i = this.index(x, y);
    return (this.data[i] << 16) | (this.data[i + 1] << 8) | this.data[i + 2];
  }
  getAlpha(x, y) { return this.inBounds(x, y) ? this.data[this.index(x, y) + 3] : 0; }
  rect(x, y, w, h, hex, a = 255) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, hex, a);
    return this;
  }
  frame(x, y, w, h, hex, a = 255) {
    for (let i = x; i < x + w; i++) { this.set(i, y, hex, a); this.set(i, y + h - 1, hex, a); }
    for (let j = y; j < y + h; j++) { this.set(x, j, hex, a); this.set(x + w - 1, j, hex, a); }
    return this;
  }
  /** Apply per-pixel jitter within a sub-rectangle. */
  grainRect(rng, x, y, w, h, amount = 0.1) {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        if (!this.inBounds(i, j)) continue;
        const k = this.index(i, j);
        if (this.data[k + 3] === 0) continue;
        const d = (rng.next() * 2 - 1) * amount * 255;
        this.data[k] += d; this.data[k + 1] += d; this.data[k + 2] += d;
      }
    }
    return this;
  }
  shadeRect(x, y, w, h, amount) {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        if (!this.inBounds(i, j)) continue;
        const k = this.index(i, j);
        if (this.data[k + 3] === 0) continue;
        if (amount >= 0) {
          this.data[k] = lerp(this.data[k], 255, amount);
          this.data[k + 1] = lerp(this.data[k + 1], 255, amount);
          this.data[k + 2] = lerp(this.data[k + 2], 255, amount);
        } else {
          this.data[k] = lerp(this.data[k], 0, -amount);
          this.data[k + 1] = lerp(this.data[k + 1], 0, -amount);
          this.data[k + 2] = lerp(this.data[k + 2], 0, -amount);
        }
      }
    }
    return this;
  }
}

export function registerSheet(name, width, height, painter) {
  sheets.set(name, { width, height, painter, built: null });
  return name;
}

export function getSheet(name) {
  const s = sheets.get(name);
  if (!s) return null;
  if (!s.built) {
    s.built = new Sheet(s.width, s.height);
    s.painter(s.built, new Random(hashString(name)));
  }
  return s.built;
}

export function allSheetNames() { return [...sheets.keys()]; }
