// Terrain shaping: splines, the density function, and the ore table.
//
// Split out of generator.js so the *shape* of the world is readable on its own.
// Nothing here holds state or touches the world — every function is pure, which
// makes the terrain easy to plot, diff and tune.
//
// The pipeline mirrors Minecraft 1.18:
//
//   continentalness -> base height     (deep ocean .. far inland)
//   erosion         -> relief amplitude and how squashed the density gradient is
//   weirdness       -> peaks and valleys, and river channels at pv = -1
//
// Those combine into a *target height*; the density at a point is then
//
//   density = (targetHeight - y) * squash + noise3D
//
// which is positive (solid) below the target and negative (air) above it, with
// the 3D noise term free to punch overhangs, ledges and floating shelves near
// the boundary. Evaluating that on a coarse lattice and interpolating is what
// keeps a whole chunk column affordable.

import { Spline } from '../core/noise.js';
import { clamp } from '../core/math.js';

export const SEA_LEVEL = 63;
/** Everything open below this is lava, matching the deep-dark lava sheet. */
export const LAVA_LEVEL = -54;

// ---------------------------------------------------------------------------
// Splines
// ---------------------------------------------------------------------------

/** Continentalness -> the height the land sits at before any relief is added. */
export const CONTINENT_SPLINE = new Spline([
  [-1.20, 16],
  [-1.05, 26],
  [-0.70, 34],
  [-0.455, 45],
  [-0.30, 52],
  [-0.19, 59],
  [-0.14, 62],
  [-0.11, 66],
  [0.03, 72],
  [0.15, 78],
  [0.30, 86],
  [0.50, 93],
  [1.00, 100],
]);

/** Erosion -> how much of the peaks-and-valleys relief survives. */
export const EROSION_AMP_SPLINE = new Spline([
  [-1.000, 1.00],
  [-0.780, 0.92],
  [-0.375, 0.60],
  [-0.2225, 0.44],
  [0.050, 0.30],
  [0.450, 0.16],
  [0.550, 0.09],
  [1.000, 0.04],
]);

/** Continentalness -> how many blocks of relief the amplitude is scaled by. */
export const RELIEF_SCALE_SPLINE = new Spline([
  [-1.20, 5],
  [-0.455, 9],
  [-0.19, 14],
  [-0.11, 26],
  [0.03, 46],
  [0.30, 70],
  [1.00, 92],
]);

/** Peaks-and-valleys -> normalised relief, slightly biased toward valleys. */
export const PV_SPLINE = new Spline([
  [-1.00, -0.90],
  [-0.60, -0.52],
  [-0.20, -0.12],
  [0.10, 0.08],
  [0.40, 0.50],
  [0.70, 0.86],
  [1.00, 1.15],
]);

/**
 * Erosion -> the density gradient. A small squash means density crosses zero
 * slowly, so the 3D noise dominates and you get cliffs and overhangs; a large
 * squash pins the surface tightly to the target height.
 */
export const SQUASH_SPLINE = new Spline([
  [-1.00, 0.055],
  [-0.60, 0.070],
  [-0.20, 0.090],
  [0.20, 0.115],
  [0.60, 0.150],
  [1.00, 0.190],
]);

/** Erosion -> how much ridged jaggedness rides on top of a peak. */
export const JAGGEDNESS_SPLINE = new Spline([
  [-1.00, 26],
  [-0.78, 18],
  [-0.55, 7],
  [-0.375, 2],
  [0.00, 0],
  [1.00, 0],
]);

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/** Peaks-and-valleys from weirdness, as in Minecraft. */
export function peaksAndValleys(w) {
  return -(Math.abs(Math.abs(w) - 0.6666667) - 0.33333334) * 3.0;
}

/**
 * How strongly this column reads as a river. Weirdness near zero is the floor
 * of the peaks-and-valleys curve, which is exactly where Minecraft puts rivers;
 * carving the height down there is what turns that band into actual water.
 */
export function riverStrength(weirdness, continentalness, erosion) {
  const a = Math.abs(weirdness);
  if (a > 0.10) return 0;
  let s = 1 - a / 0.10;
  s = s * s * (3 - 2 * s);
  // No rivers out at sea, and mountains shed them rather than pooling.
  if (continentalness < -0.16) s *= clamp((continentalness + 0.30) / 0.14, 0, 1);
  if (erosion < -0.6) s *= clamp((erosion + 1.0) / 0.4, 0, 1);
  return s;
}

/**
 * Target surface height for a column.
 *
 * @param {number} c continentalness
 * @param {number} e erosion
 * @param {number} pv peaks and valleys
 * @param {number} jagged ridged noise in [-1,1], only used on steep peaks
 * @param {number} river river strength 0..1
 * @param {number} biomeScale extra relief the biome asks for, in blocks
 */
export function targetHeight(c, e, pv, jagged, river, biomeScale = 0) {
  const base = CONTINENT_SPLINE.eval(c);
  const amp = EROSION_AMP_SPLINE.eval(e);
  const scale = RELIEF_SCALE_SPLINE.eval(c);
  let h = base + PV_SPLINE.eval(pv) * amp * scale;

  // Jaggedness only bites on high ground with low erosion — that is what turns
  // a smooth ridge into a jagged peak instead of making all terrain noisy.
  if (pv > 0.25 && e < -0.35) {
    const j = JAGGEDNESS_SPLINE.eval(e) * (pv - 0.25) * 1.34;
    h += Math.max(0, jagged) * j;
  }

  if (biomeScale) h += biomeScale * (pv * 0.5 + 0.5);

  if (river > 0) {
    // Cut a channel down to just below sea level, keeping the banks.
    const bed = SEA_LEVEL - 5;
    h = h + (Math.min(h, bed) - h) * river;
  }
  return h;
}

/** Erosion -> density gradient, clamped so extreme noise cannot invert it. */
export function squashFor(e) {
  return SQUASH_SPLINE.eval(e);
}

/**
 * Bias applied to raw density so the world has a floor and a ceiling: solid
 * near the bottom of the build range, empty near the top, blended smoothly so
 * neither reads as a flat plane.
 */
export function verticalBias(y) {
  if (y < -40) return (-40 - y) * 0.12;
  if (y > 240) return -(y - 240) * 0.045;
  return 0;
}

/**
 * Amplitude of the 3D noise term at a given height relative to the surface.
 * Full strength near the surface (overhangs, cliffs), fading well below it so
 * deep stone stays solid and caves are the only thing that opens it up.
 */
export function noiseWeight(y, target) {
  const d = target - y;
  if (d > 34) return 0.18;
  if (d < -26) return 0.22;
  return 0.55;
}

// ---------------------------------------------------------------------------
// Caves
// ---------------------------------------------------------------------------

/**
 * How eager cheese caves are at a given height. Large cavities want to live in
 * the middle of the stone column, not right under the grass and not in the
 * bedrock, so the threshold tightens at both ends.
 */
export function cheeseThreshold(y) {
  if (y > 90) return 1.6;                       // effectively off
  if (y > 40) return 0.62 + (y - 40) * 0.012;
  if (y < -50) return 0.62 + (-50 - y) * 0.06;
  return 0.60;
}

/** Spaghetti tunnels thin out near the surface and near bedrock. */
export function spaghettiThreshold(y) {
  if (y > 110) return 2;
  if (y > 60) return 0.70 + (y - 60) * 0.006;
  if (y < -52) return 0.70 + (-52 - y) * 0.05;
  return 0.66;
}

/** Noodle caves are the thin winding ones — a high bar, so they stay narrow. */
export function noodleThreshold(y) {
  if (y > 100 || y < -56) return 2;
  return 0.86;
}

// ---------------------------------------------------------------------------
// Ores
// ---------------------------------------------------------------------------

/**
 * Minecraft's ore placement, as (attempts per chunk, vein size, height range).
 *
 * `dist` picks how y is sampled inside the range:
 *   'uniform'  — flat
 *   'triangle' — peaks in the middle of the range
 * `deep` is the deepslate variant, chosen from the host block rather than from
 * y so the boundary stays as noisy as the deepslate transition itself.
 */
export const ORES = [
  // name                deep variant                 tries size  minY  maxY  dist
  { name: 'coal_ore', deep: 'deepslate_coal_ore', tries: 20, size: 17, minY: 0, maxY: 192, dist: 'triangle' },
  { name: 'coal_ore', deep: 'deepslate_coal_ore', tries: 12, size: 17, minY: 136, maxY: 256, dist: 'uniform' },
  { name: 'iron_ore', deep: 'deepslate_iron_ore', tries: 10, size: 9, minY: -24, maxY: 56, dist: 'triangle' },
  { name: 'iron_ore', deep: 'deepslate_iron_ore', tries: 10, size: 4, minY: -63, maxY: 72, dist: 'uniform' },
  { name: 'iron_ore', deep: 'deepslate_iron_ore', tries: 4, size: 9, minY: 80, maxY: 232, dist: 'triangle' },
  { name: 'copper_ore', deep: 'deepslate_copper_ore', tries: 16, size: 10, minY: -16, maxY: 112, dist: 'triangle' },
  { name: 'gold_ore', deep: 'deepslate_gold_ore', tries: 4, size: 9, minY: -64, maxY: 32, dist: 'triangle' },
  { name: 'redstone_ore', deep: 'deepslate_redstone_ore', tries: 4, size: 8, minY: -64, maxY: 15, dist: 'uniform' },
  { name: 'redstone_ore', deep: 'deepslate_redstone_ore', tries: 8, size: 8, minY: -64, maxY: -32, dist: 'triangle' },
  { name: 'diamond_ore', deep: 'deepslate_diamond_ore', tries: 7, size: 8, minY: -64, maxY: 16, dist: 'triangle', bias: -0.6 },
  { name: 'lapis_ore', deep: 'deepslate_lapis_ore', tries: 2, size: 7, minY: -32, maxY: 32, dist: 'triangle' },
  { name: 'lapis_ore', deep: 'deepslate_lapis_ore', tries: 4, size: 7, minY: -64, maxY: 64, dist: 'uniform' },
];

/** Extra gold in badlands, exactly as Minecraft does it. */
export const BADLANDS_GOLD = {
  name: 'gold_ore', deep: 'deepslate_gold_ore',
  tries: 20, size: 9, minY: 32, maxY: 200, dist: 'uniform',
};

/** Emerald is mountains-only, and always a single block. */
export const MOUNTAIN_EMERALD = {
  name: 'emerald_ore', deep: 'deepslate_emerald_ore',
  tries: 50, size: 1, minY: -16, maxY: 250, dist: 'triangle', bias: 0.7,
};

/** Stone-variant blobs. Same machinery, no deepslate variant. */
export const STONE_BLOBS = [
  { name: 'dirt', deep: null, tries: 7, size: 33, minY: 0, maxY: 160, dist: 'uniform' },
  { name: 'gravel', deep: null, tries: 8, size: 33, minY: -48, maxY: 190, dist: 'uniform' },
  { name: 'granite', deep: null, tries: 4, size: 33, minY: -16, maxY: 80, dist: 'uniform' },
  { name: 'diorite', deep: null, tries: 4, size: 33, minY: -16, maxY: 80, dist: 'uniform' },
  { name: 'andesite', deep: null, tries: 4, size: 33, minY: -16, maxY: 80, dist: 'uniform' },
  { name: 'tuff', deep: null, tries: 2, size: 33, minY: -64, maxY: 0, dist: 'uniform' },
];

/** Sample a y inside an ore's range from two uniforms in [0,1). */
export function oreY(cfg, r1, r2) {
  const { minY, maxY } = cfg;
  if (cfg.dist === 'triangle') {
    let t = (r1 + r2) * 0.5;
    if (cfg.bias) t = clamp(t + cfg.bias * 0.5 * (1 - Math.abs(t * 2 - 1)), 0, 1);
    return Math.round(minY + t * (maxY - minY));
  }
  return Math.round(minY + r1 * (maxY - minY));
}

// ---------------------------------------------------------------------------
// Badlands banding
// ---------------------------------------------------------------------------

/**
 * The terracotta colour bands. Minecraft builds a 64-entry palette per world
 * seed; the pattern is stripes of white/orange/light-grey plus occasional
 * bright bands, repeating every 64 blocks of height.
 */
const BAND_COLORS = [
  'terracotta', 'terracotta', 'terracotta', 'terracotta',
  'orange_terracotta', 'terracotta', 'terracotta', 'terracotta',
  'yellow_terracotta', 'terracotta', 'brown_terracotta', 'terracotta',
  'red_terracotta', 'terracotta', 'terracotta', 'white_terracotta',
  'terracotta', 'light_gray_terracotta', 'terracotta', 'terracotta',
  'orange_terracotta', 'terracotta', 'terracotta', 'brown_terracotta',
  'terracotta', 'terracotta', 'white_terracotta', 'terracotta',
  'terracotta', 'orange_terracotta', 'terracotta', 'terracotta',
];

/** Build the per-seed 64-entry band table as an array of block names. */
export function badlandsBands(rand) {
  const bands = new Array(64);
  for (let i = 0; i < 64; i++) bands[i] = 'terracotta';
  // Broad orange stripes.
  for (let i = 0; i < 64; i += 1) {
    if (((i + 3) % 11) < 3) bands[i] = 'orange_terracotta';
  }
  // Then scatter the accent bands from the seeded generator.
  for (let pass = 0; pass < 18; pass++) {
    const color = BAND_COLORS[rand.int(BAND_COLORS.length)];
    const y = rand.int(64);
    const h = 1 + rand.int(3);
    for (let i = y; i < Math.min(64, y + h); i++) bands[i] = color;
  }
  return bands;
}

export { clamp };
