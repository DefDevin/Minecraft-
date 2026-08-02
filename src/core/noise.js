// Noise primitives for terrain generation.
//
// Provides gradient (Perlin) noise in 2D/3D, a Minecraft-style octave stack
// (`OctaveNoise` / `NormalNoise`), ridged and billowed variants for caves and
// mountains, Voronoi/cellular noise for biome scattering, and cubic splines for
// mapping noise values onto terrain parameters.

import { lerp, smootherstep, clamp } from './math.js';
import { Random, hashString } from './rng.js';

// ---------------------------------------------------------------------------
// Improved Perlin noise with a per-instance permutation table.
// ---------------------------------------------------------------------------

const GRAD3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  1, 1, 0, 0, -1, 1, -1, 1, 0, 0, -1, -1,
]);

export class PerlinNoise {
  /** @param {Random|number} rand seed or generator */
  constructor(rand) {
    const r = rand instanceof Random ? rand : new Random(rand | 0);
    // Random offset keeps different octaves from lining up on lattice points.
    this.ox = r.next() * 256;
    this.oy = r.next() * 256;
    this.oz = r.next() * 256;
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = r.int(i + 1);
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    // Doubled table avoids a modulo in the inner loop.
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 16;
    }
  }

  /** 3D gradient noise in roughly [-1,1]. */
  noise3(x, y, z) {
    x += this.ox; y += this.oy; z += this.oz;
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = smootherstep(x), v = smootherstep(y), w = smootherstep(z);
    const p = this.perm;
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
    const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    return lerp(
      lerp(
        lerp(grad3(p[AA], x, y, z), grad3(p[BA], x - 1, y, z), u),
        lerp(grad3(p[AB], x, y - 1, z), grad3(p[BB], x - 1, y - 1, z), u), v),
      lerp(
        lerp(grad3(p[AA + 1], x, y, z - 1), grad3(p[BA + 1], x - 1, y, z - 1), u),
        lerp(grad3(p[AB + 1], x, y - 1, z - 1), grad3(p[BB + 1], x - 1, y - 1, z - 1), u), v),
      w);
  }

  /** 2D gradient noise in roughly [-1,1]. */
  noise2(x, y) {
    x += this.ox; y += this.oy;
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = smootherstep(x), v = smootherstep(y);
    const p = this.perm;
    const A = p[X] + Y, B = p[X + 1] + Y;
    return lerp(
      lerp(grad2(p[A], x, y), grad2(p[B], x - 1, y), u),
      lerp(grad2(p[A + 1], x, y - 1), grad2(p[B + 1], x - 1, y - 1), u),
      v);
  }
}

function grad3(hash, x, y, z) {
  const h = (hash & 15) * 3;
  return GRAD3[h] * x + GRAD3[h + 1] * y + GRAD3[h + 2] * z;
}

function grad2(hash, x, y) {
  const h = hash & 7;
  const u = h < 4 ? x : y;
  const v = h < 4 ? y : x;
  return ((h & 1) ? -u : u) + ((h & 2) ? -2 * v : 2 * v);
}

// ---------------------------------------------------------------------------
// Octave stacks
// ---------------------------------------------------------------------------

/**
 * Fractal Brownian motion over N Perlin octaves.
 * Output is normalised to roughly [-1,1] by the sum of amplitudes.
 */
export class OctaveNoise {
  /**
   * @param {number|Random} seed
   * @param {number} octaves
   * @param {object} [opts]
   * @param {number} [opts.lacunarity=2] frequency multiplier per octave
   * @param {number} [opts.persistence=0.5] amplitude multiplier per octave
   * @param {number} [opts.scale=1] base frequency
   */
  constructor(seed, octaves = 4, opts = {}) {
    const r = seed instanceof Random ? seed : new Random(seed | 0);
    this.octaves = [];
    this.lacunarity = opts.lacunarity ?? 2;
    this.persistence = opts.persistence ?? 0.5;
    this.scale = opts.scale ?? 1;
    let amp = 1, total = 0;
    for (let i = 0; i < octaves; i++) {
      this.octaves.push({ noise: new PerlinNoise(r), amp, freq: Math.pow(this.lacunarity, i) });
      total += amp;
      amp *= this.persistence;
    }
    this.norm = total > 0 ? 1 / total : 1;
  }

  sample2(x, z) {
    let sum = 0;
    const s = this.scale;
    for (let i = 0; i < this.octaves.length; i++) {
      const o = this.octaves[i];
      sum += o.noise.noise2(x * s * o.freq, z * s * o.freq) * o.amp;
    }
    return sum * this.norm;
  }

  sample3(x, y, z) {
    let sum = 0;
    const s = this.scale;
    for (let i = 0; i < this.octaves.length; i++) {
      const o = this.octaves[i];
      sum += o.noise.noise3(x * s * o.freq, y * s * o.freq, z * s * o.freq) * o.amp;
    }
    return sum * this.norm;
  }

  /** fBm with each octave's contribution warped by the previous — richer ridges. */
  warped2(x, z, strength = 0.6) {
    const wx = this.octaves[0].noise.noise2(x * this.scale, z * this.scale) * strength;
    const wz = this.octaves[0].noise.noise2(x * this.scale + 5.2, z * this.scale + 1.3) * strength;
    return this.sample2(x + wx * 40, z + wz * 40);
  }
}

/**
 * Named noise stream. Deriving the seed from a label rather than call order
 * means adding a new noise later never shifts existing terrain.
 */
export function namedNoise(worldSeed, label, octaves, opts) {
  return new OctaveNoise(new Random((worldSeed ^ hashString(label)) | 0), octaves, opts);
}

/** Ridged multifractal — sharp crests, used for mountains and spaghetti caves. */
export class RidgedNoise extends OctaveNoise {
  sample2(x, z) {
    let sum = 0;
    const s = this.scale;
    for (let i = 0; i < this.octaves.length; i++) {
      const o = this.octaves[i];
      const n = 1 - Math.abs(o.noise.noise2(x * s * o.freq, z * s * o.freq));
      sum += n * n * o.amp;
    }
    return sum * this.norm * 2 - 1;
  }

  sample3(x, y, z) {
    let sum = 0;
    const s = this.scale;
    for (let i = 0; i < this.octaves.length; i++) {
      const o = this.octaves[i];
      const n = 1 - Math.abs(o.noise.noise3(x * s * o.freq, y * s * o.freq, z * s * o.freq));
      sum += n * n * o.amp;
    }
    return sum * this.norm * 2 - 1;
  }
}

/** Billowed noise — rounded blobs, good for cave "cheese" cavities. */
export class BillowNoise extends OctaveNoise {
  sample3(x, y, z) {
    let sum = 0;
    const s = this.scale;
    for (let i = 0; i < this.octaves.length; i++) {
      const o = this.octaves[i];
      sum += Math.abs(o.noise.noise3(x * s * o.freq, y * s * o.freq, z * s * o.freq)) * o.amp;
    }
    return sum * this.norm * 2 - 1;
  }
}

// ---------------------------------------------------------------------------
// Cellular / Voronoi noise — biome scatter, ore clustering, structure jitter.
// ---------------------------------------------------------------------------

export class VoronoiNoise {
  constructor(seed, scale = 1) {
    this.seed = seed | 0;
    this.scale = scale;
  }

  /** Returns {cellX, cellZ, dist, id} for the nearest feature point. */
  cell2(x, z) {
    x *= this.scale; z *= this.scale;
    const cx = Math.floor(x), cz = Math.floor(z);
    let bestD = Infinity, bx = 0, bz = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx, gz = cz + dz;
        const h = hashCell(this.seed, gx, gz);
        const px = gx + ((h & 0xffff) / 65535);
        const pz = gz + (((h >>> 16) & 0xffff) / 65535);
        const d = (px - x) * (px - x) + (pz - z) * (pz - z);
        if (d < bestD) { bestD = d; bx = gx; bz = gz; }
      }
    }
    return { cellX: bx, cellZ: bz, dist: Math.sqrt(bestD), id: hashCell(this.seed, bx, bz) };
  }

  /** Distance to the boundary between the two nearest cells — crack patterns. */
  edge2(x, z) {
    x *= this.scale; z *= this.scale;
    const cx = Math.floor(x), cz = Math.floor(z);
    let d1 = Infinity, d2 = Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx, gz = cz + dz;
        const h = hashCell(this.seed, gx, gz);
        const px = gx + ((h & 0xffff) / 65535);
        const pz = gz + (((h >>> 16) & 0xffff) / 65535);
        const d = (px - x) * (px - x) + (pz - z) * (pz - z);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
      }
    }
    return Math.sqrt(d2) - Math.sqrt(d1);
  }
}

function hashCell(seed, x, z) {
  let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(z, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Splines — map a noise parameter onto a terrain value with control points.
// This mirrors how Minecraft 1.18+ turns continentalness/erosion into height.
// ---------------------------------------------------------------------------

/**
 * A monotone-in-X piecewise curve. Points are `[x, y, derivative?]`; when a
 * derivative is supplied the segment uses Hermite interpolation, otherwise it
 * blends with a smoothstep so joins stay flat.
 */
export class Spline {
  constructor(points) {
    this.points = points.slice().sort((a, b) => a[0] - b[0]);
  }

  eval(x) {
    const p = this.points;
    const n = p.length;
    if (n === 0) return 0;
    if (x <= p[0][0]) return p[0][1];
    if (x >= p[n - 1][0]) return p[n - 1][1];
    let i = 0;
    while (i < n - 2 && x > p[i + 1][0]) i++;
    const [x0, y0, d0] = p[i];
    const [x1, y1, d1] = p[i + 1];
    const span = x1 - x0;
    if (span <= 0) return y0;
    const t = (x - x0) / span;
    if (d0 === undefined || d1 === undefined) {
      return lerp(y0, y1, smootherstep(t));
    }
    // Cubic Hermite
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * y0 + h10 * span * d0 + h01 * y1 + h11 * span * d1;
  }
}

// ---------------------------------------------------------------------------
// Small helpers used throughout generation
// ---------------------------------------------------------------------------

/** Map a value from [-1,1] to [0,1]. */
export const unorm = (v) => v * 0.5 + 0.5;

/** Soft-clamp `v` into [lo,hi] with a smooth falloff of width `k`. */
export function softClamp(v, lo, hi, k = 0.1) {
  const span = hi - lo;
  if (span <= 0) return lo;
  const t = clamp((v - lo) / span, -2, 3);
  const s = k <= 0 ? clamp(t, 0, 1) : clamp(t, 0, 1) * (1 - k) + smootherstep(clamp(t, 0, 1)) * k;
  return lo + s * span;
}

/** Blend two values where `t` runs 0..1 through a smootherstep. */
export const sblend = (a, b, t) => lerp(a, b, smootherstep(clamp(t, 0, 1)));

/**
 * Trilinear cell interpolation helper. Terrain density is evaluated on a coarse
 * lattice (typically every 4 blocks horizontally, 8 vertically) and interpolated
 * between, which is how Minecraft keeps generation affordable.
 */
export function trilerp(v000, v100, v010, v110, v001, v101, v011, v111, tx, ty, tz) {
  const x00 = lerp(v000, v100, tx);
  const x10 = lerp(v010, v110, tx);
  const x01 = lerp(v001, v101, tx);
  const x11 = lerp(v011, v111, tx);
  return lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz);
}
