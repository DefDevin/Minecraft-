// Every block texture in the game, painted pixel by pixel.
//
// `registerBlockTextures()` installs a painter for each of the ~740 texture
// names the block registry references. Nothing here allocates a buffer or runs
// a painter: texgen calls them lazily, once, with a `Random` seeded from the
// texture's own name, so a texture is byte-identical every run and reordering
// this file cannot change what the world looks like.
//
// House rules, learned the hard way from making these read at 16x16:
//
//  * Tile first. Anything that wraps — cobble cells, ore blobs, noise — uses
//    the toroidal helpers below, because a seam on a stone wall is the single
//    most obvious artefact in a voxel game.
//  * Three tones minimum. A flat fill plus grain looks like plastic; a mid,
//    a highlight biased to the top-left and a shadow biased to the bottom-right
//    is what makes 16 pixels read as a lump of rock.
//  * Derive variants. Mossy, cracked and dyed forms go through `derive()` so
//    the moss lands on the same cobbles the plain texture drew.
//  * Leave the biome-tinted textures pale. The chunk shader multiplies grass
//    tops, foliage and water by a per-block biome colour; saturating them here
//    doubles up and turns temperate forests radioactive.

import {
  Pixels, registerTexture, registerAnimated, derive, paintInto,
  shade, mixHex, hsv, fbm2, valueNoise2, TEX_SIZE,
} from '../texgen.js';
import { clamp, lerp } from '../../core/math.js';
import { Random, hashString } from '../../core/rng.js';
import { PALETTE as P, DYE_ORDER } from './palette.js';

const S = TEX_SIZE;
const tex = registerTexture;

// ---------------------------------------------------------------------------
// Painting helpers
// ---------------------------------------------------------------------------

/** Wrap a coordinate into the tile — the basis of every seamless pattern. */
const w = (v) => ((v % S) + S) % S;

/** Shortest signed offset from `a` to `b` on a wrapping axis. */
function wdelta(a, b) {
  let d = b - a;
  if (d > S / 2) d -= S;
  if (d < -S / 2) d += S;
  return d;
}

/** Set a pixel with wrapping, so shapes that run off an edge come back on. */
const setw = (px, x, y, hex, a = 255) => px.set(w(x), w(y), hex, a);
const blendw = (px, x, y, hex, a = 1) => px.blend(w(x), w(y), hex, a);

/** Fill with `base` modulated by tiling fbm noise. The workhorse. */
function noiseFill(px, rng, base, amp = 0.12, octaves = 3, freq = 4) {
  const n = fbm2(rng, S, octaves, freq);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      px.set(x, y, shade(base, (n[y * S + x] - 0.5) * 2 * amp));
    }
  }
  return n;
}

/** Blend a second colour in where tiling noise is above `threshold`. */
function noiseOverlay(px, rng, hex, threshold = 0.55, freq = 5, strength = 1) {
  const n = fbm2(rng, S, 3, freq);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = n[y * S + x];
      if (v <= threshold) continue;
      px.blend(x, y, hex, clamp((v - threshold) / (1 - threshold), 0, 1) * strength);
    }
  }
}

/** A handful of tight pixel clusters — stone's darker mineral flecks. */
function clusters(px, rng, count, hex, alpha = 1, size = 3) {
  for (let i = 0; i < count; i++) {
    const cx = rng.int(S), cy = rng.int(S);
    const n = 2 + rng.int(size);
    for (let k = 0; k < n; k++) {
      blendw(px, cx + rng.int(3) - 1, cy + rng.int(3) - 1, hex,
        alpha * (0.6 + rng.next() * 0.4));
    }
  }
}

/**
 * Toroidal Voronoi cells. Returns a sampler giving, for a point, the distance
 * to the nearest cell, the gap to the second nearest (which is where mortar
 * goes), the cell's own random tone, and the offset from its centre (which is
 * where the bevel comes from).
 */
function cellField(rng, count) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    pts.push({ x: rng.next() * S, y: rng.next() * S, tone: rng.next(), id: i });
  }
  return (x, y) => {
    let d1 = 1e9, d2 = 1e9, best = pts[0];
    for (const p of pts) {
      const dx = wdelta(x, p.x), dy = wdelta(y, p.y);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < d1) { d2 = d1; d1 = d; best = p; } else if (d < d2) { d2 = d; }
    }
    return { d1, gap: d2 - d1, cell: best, ox: -wdelta(x, best.x), oy: -wdelta(y, best.y) };
  };
}

/**
 * Rounded cobbles separated by dark mortar, lit from the top-left. Used for
 * cobblestone, its deepslate and blackstone cousins, and gravel.
 */
function paintCobbles(px, rng, base, opts = {}) {
  const field = cellField(rng, opts.count ?? 11);
  const mortar = opts.mortar ?? shade(base, -0.42);
  const gap = opts.gap ?? 1.15;
  const spread = opts.spread ?? 0.26;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const f = field(x + 0.5, y + 0.5);
      if (f.gap < gap - rng.next() * 0.45) { px.set(x, y, mortar); continue; }
      let c = shade(base, (f.cell.tone - 0.5) * spread);
      // Bevel: the top-left of each cobble catches the light.
      const b = clamp(-(f.ox + f.oy) / 7, -0.3, 0.32);
      c = shade(c, b * (opts.bevel ?? 0.9));
      px.set(x, y, c);
    }
  }
  px.grain(rng, opts.grain ?? 0.05);
}

/** A staggered brick course: `rows` bands, alternate rows offset by half. */
function paintBrickCourse(px, rng, base, mortar, opts = {}) {
  const rows = opts.rows ?? 4;
  const h = S / rows;
  const jitter = opts.jitter ?? 0.1;
  px.fill(mortar);
  for (let r = 0; r < rows; r++) {
    const y0 = r * h;
    const off = (r % 2) * (S / 4) + (opts.offset ?? 0);
    const bricksPerRow = opts.perRow ?? 2;
    const bw = S / bricksPerRow;
    for (let b = 0; b < bricksPerRow; b++) {
      const x0 = b * bw + off;
      const tone = shade(base, (rng.next() - 0.5) * 2 * jitter);
      for (let y = y0; y < y0 + h - 1; y++) {
        for (let x = x0; x < x0 + bw - 1; x++) {
          setw(px, x, y, shade(tone, (rng.next() - 0.5) * 0.06));
        }
      }
      // Bevel each brick individually.
      for (let x = x0; x < x0 + bw - 1; x++) {
        px.shadePixel(w(x), w(y0), 0.13);
        px.shadePixel(w(x), w(y0 + h - 2), -0.16);
      }
      for (let y = y0; y < y0 + h - 1; y++) {
        px.shadePixel(w(x0), w(y), 0.1);
        px.shadePixel(w(x0 + bw - 2), w(y), -0.13);
      }
    }
  }
}

/** Horizontal planks with seams, per-plank hue jitter and grain streaks. */
function paintPlanks(px, rng, base, opts = {}) {
  const rows = opts.rows ?? 4;
  const h = S / rows;
  for (let r = 0; r < rows; r++) {
    const y0 = r * h;
    const c = shade(base, (rng.next() - 0.5) * (opts.jitter ?? 0.16));
    px.rect(0, y0, S, h, c);
    // Lengthwise grain.
    for (let k = 0; k < 3; k++) {
      const gy = y0 + 1 + rng.int(h - 2);
      const x0 = rng.int(S), len = 3 + rng.int(8);
      for (let i = 0; i < len; i++) blendw(px, x0 + i, gy, shade(c, -0.15), 0.55);
    }
    // One butt joint per plank, offset row to row so it does not line up.
    const jx = rng.int(S);
    for (let y = y0; y < y0 + h - 1; y++) setw(px, jx, y, shade(c, -0.26));
    // Seam below, highlight above.
    px.hline(0, S - 1, y0 + h - 1, shade(base, -0.34));
    px.hline(0, S - 1, y0, shade(c, 0.09));
  }
  px.grain(rng, opts.grain ?? 0.035);
}

/** Bark: vertical striations plus a knot or two. */
function paintBark(px, rng, sp, opts = {}) {
  const cols = [];
  for (let x = 0; x < S; x++) cols.push(rng.next());
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // A slow vertical wobble keeps the stripes from looking like a barcode.
      const t = clamp(cols[x] + Math.sin(y * 0.8 + x * 2.1) * 0.09
        + (rng.next() - 0.5) * 0.12, 0, 1);
      px.set(x, y, mixHex(sp.barkDark, sp.bark, t));
    }
  }
  if (opts.dashes) {
    // Birch: short dark scars scattered over pale bark.
    for (let i = 0; i < 5; i++) {
      const x = rng.int(S), y = rng.int(S), len = 1 + rng.int(3);
      for (let k = 0; k < len; k++) setw(px, x + k, y, sp.barkDark);
      if (rng.chance(0.5)) setw(px, x - 1, y, shade(sp.barkDark, 0.25));
    }
  } else {
    for (let i = 0; i < (opts.knots ?? 2); i++) {
      const cx = rng.int(S), cy = 2 + rng.int(S - 4), r = 1.2 + rng.next();
      for (let y = -3; y <= 3; y++) {
        for (let x = -3; x <= 3; x++) {
          const d = Math.hypot(x, y);
          if (d > r + 1) continue;
          setw(px, cx + x, cy + y, d < r ? sp.barkDark : shade(sp.bark, 0.14));
        }
      }
    }
  }
  px.grain(rng, 0.05);
}

/** A log's cut end: concentric growth rings inside a bark rim. */
function paintLogTop(px, rng, sp, opts = {}) {
  const n = valueNoise2(rng, S, 4);
  const core = opts.core ?? sp.core;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - 7.5, dy = y - 7.5;
      const d = Math.hypot(dx, dy) + (n[y * S + x] - 0.5) * 1.4;
      if (d > 7.1) { px.set(x, y, mixHex(sp.bark, sp.barkDark, 0.35)); continue; }
      if (d > 6.2) { px.set(x, y, sp.bark); continue; }
      const ring = Math.sin(d * 2.1 + 0.6);
      px.set(x, y, mixHex(core, shade(core, -0.24), ring > 0 ? 0.05 : 0.85));
    }
  }
  px.set(7, 7, shade(core, -0.4));
  px.set(8, 7, shade(core, -0.32));
  px.grain(rng, 0.045);
}

/** Bare stripped wood: no bark, straight vertical grain. */
function paintStripped(px, rng, base) {
  noiseFill(px, rng, base, 0.06, 2, 3);
  for (let x = 0; x < S; x++) {
    const t = (rng.next() - 0.5) * 0.14;
    for (let y = 0; y < S; y++) px.shadePixel(x, y, t * 0.5);
  }
  for (let i = 0; i < 7; i++) {
    const x = rng.int(S), y0 = rng.int(S), len = 4 + rng.int(9);
    for (let k = 0; k < len; k++) blendw(px, x, y0 + k, shade(base, -0.16), 0.5);
  }
  px.grain(rng, 0.04);
}

/**
 * Dense clumpy foliage with holes punched through to alpha 0. `light`/`dark`
 * should be near-neutral for anything the shader tints.
 */
function paintLeaves(px, rng, light, dark, opts = {}) {
  const shape = fbm2(rng, S, 3, 5);
  const holes = fbm2(rng, S, 2, 8);
  const cut = opts.holes ?? 0.30;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      if (holes[i] < cut) continue;
      const t = clamp((shape[i] - 0.28) * 2.0, 0, 1);
      px.set(x, y, mixHex(dark, light, t));
    }
  }
  // Dark pixels where clumps overlap, light ones on the sunlit tips.
  for (let i = 0; i < 26; i++) {
    const x = rng.int(S), y = rng.int(S);
    if (px.getAlpha(x, y) === 0) continue;
    px.blend(x, y, rng.chance(0.55) ? shade(dark, -0.3) : shade(light, 0.22), 0.7);
  }
  if (opts.berry) {
    for (let i = 0; i < 6; i++) {
      const x = rng.int(S), y = rng.int(S);
      if (px.getAlpha(x, y) === 0) continue;
      px.set(x, y, opts.berry);
    }
  }
  px.grain(rng, 0.06);
}

/** One mineral lump: mid body, highlight rim top-left, shadow rim bottom-right. */
function mineralBlob(px, rng, m, cx, cy, r) {
  for (let y = Math.floor(cy - r) - 1; y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r) - 1; x <= cx + r + 1; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      if (d > r - 0.85) {
        if (rng.chance(0.22)) continue;          // ragged edge
        setw(px, x, y, dx + dy < 0 ? m.light : m.dark);
      } else {
        setw(px, x, y, m.mid);
      }
    }
  }
}

/** Scatter `count` mineral lumps over whatever is already in the buffer. */
function scatterMineral(px, rng, m, count = 6, minR = 1.3, maxR = 2.2) {
  for (let i = 0; i < count; i++) {
    mineralBlob(px, rng, m, rng.next() * S, rng.next() * S, minR + rng.next() * (maxR - minR));
  }
}

/** Register `name` as `parent` with mineral lumps scattered over it. */
function ore(name, parent, m, count = 6, opts = {}) {
  tex(name, (px, rng) => {
    paintInto(parent, px);
    scatterMineral(px, rng, m, count, opts.minR, opts.maxR);
    if (opts.glow) {
      for (let i = 0; i < 6; i++) {
        const x = rng.int(S), y = rng.int(S);
        px.blend(x, y, opts.glow, 0.5);
      }
    }
  });
}

/** Fine dry grain — sand, and anything else that pours. */
function paintGrainy(px, rng, base, dark, amp = 0.07) {
  noiseFill(px, rng, base, amp, 3, 6);
  px.grain(rng, 0.055);
  px.speckle(rng, 26, dark, 0.5);
  px.speckle(rng, 18, shade(base, 0.14), 0.45);
}

/** A 1px lit/shaded border around the whole tile — polished and cut stone. */
function frameBevel(px, light = 0.16, dark = 0.18) {
  px.bevel(0, 0, S, S, light, dark);
}

/** Cracks: jagged dark walks, used by cracked variants and destroy overlays. */
function crackWalk(px, rng, count, len, hex, alpha = 1, spur = 0.35) {
  for (let i = 0; i < count; i++) {
    let x = rng.int(S), y = rng.int(S);
    let dx = rng.chance(0.5) ? 1 : -1, dy = rng.chance(0.5) ? 1 : -1;
    for (let s = 0; s < len; s++) {
      blendw(px, x, y, hex, alpha);
      if (rng.chance(spur)) blendw(px, x + 1, y, hex, alpha * 0.5);
      if (rng.chance(spur)) blendw(px, x, y + 1, hex, alpha * 0.5);
      if (rng.chance(0.4)) x += dx; else y += dy;
      if (rng.chance(0.18)) dx = -dx;
      if (rng.chance(0.18)) dy = -dy;
      x = w(x); y = w(y);
    }
  }
}

/** Moss creeping over the top and into the crevices of a stone texture. */
function mossOver(px, rng, opts = {}) {
  const n = fbm2(rng, S, 3, 4);
  const light = opts.light ?? P.stone.moss;
  const dark = opts.dark ?? P.stone.mossDark;
  const bias = opts.top ?? 0.0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = n[y * S + x] + bias * (1 - y / S);
      if (v < (opts.threshold ?? 0.52)) continue;
      const t = clamp((v - 0.52) * 2.4, 0, 1);
      px.blend(x, y, mixHex(dark, light, t), 0.75 + rng.next() * 0.25);
    }
  }
}

/** A vertical plant stalk drawn down the middle of an otherwise empty tile. */
function stalk(px, rng, x0, wdt, top, bottom, light, dark) {
  for (let y = top; y <= bottom; y++) {
    for (let k = 0; k < wdt; k++) {
      px.set(x0 + k, y, k === 0 ? light : k === wdt - 1 ? dark : mixHex(light, dark, 0.5));
    }
    if (rng.chance(0.25)) px.shadePixel(x0 + rng.int(wdt), y, -0.15);
  }
}

/**
 * The two-crossed-quads plant look: a stem up the middle with leaves either
 * side. `draw` gets the buffer to add the flower head or fruit.
 */
function crossPlant(px, rng, opts = {}) {
  const stemC = opts.stem ?? P.plant.stem;
  const stemD = opts.stemDark ?? P.plant.stemDark;
  const base = opts.base ?? 15;
  const top = opts.top ?? 6;
  const cx = opts.cx ?? 7;
  for (let y = top; y <= base; y++) {
    px.set(cx, y, stemC);
    if (rng.chance(0.4)) px.set(cx + 1, y, stemD);
  }
  const leaves = opts.leaves ?? 2;
  for (let i = 0; i < leaves; i++) {
    const y = base - 2 - i * 3 - rng.int(2);
    const dir = i % 2 === 0 ? -1 : 1;
    for (let k = 1; k <= 2 + rng.int(2); k++) {
      px.set(cx + dir * k, y - (k > 2 ? 1 : 0), k === 1 ? stemC : stemD);
    }
  }
  if (opts.draw) opts.draw(px, rng, cx);
}

/** A round flower head of `hex` with an optional core colour. */
function flowerHead(px, rng, cx, cy, r, hex, core, edge) {
  for (let y = -3; y <= 3; y++) {
    for (let x = -3; x <= 3; x++) {
      const d = Math.hypot(x, y);
      if (d > r) continue;
      px.set(cx + x, cy + y, d > r - 0.8 && edge ? edge : hex);
    }
  }
  if (core != null) px.set(cx, cy, core);
}

/** Frame + corner highlight over transparency: the glass recipe. */
function paintGlass(px, rng, hex, alpha = 44, opts = {}) {
  const edge = opts.edge ?? shade(hex, 0.35);
  px.rect(1, 1, S - 2, S - 2, hex, alpha);
  px.frame(0, 0, S, S, edge, opts.edgeAlpha ?? 170);
  // The classic diagonal glint in the top-left.
  px.line(2, 5, 5, 2, shade(edge, 0.4), 210);
  px.line(2, 6, 6, 2, shade(edge, 0.2), 120);
  px.set(11, 11, edge, 150);
  px.set(12, 12, edge, 110);
  if (opts.speck) px.speckle(rng, 6, edge, 0.4);
}

/** A metal grid — iron bars, chain links, cage bars. */
function paintBars(px, rng, base, opts = {}) {
  const light = shade(base, 0.28), dark = shade(base, -0.3);
  const cols = opts.cols ?? [6, 7, 8, 9];
  for (const x of cols) {
    for (let y = 0; y < S; y++) px.set(x, y, x === cols[0] ? light : x === cols[cols.length - 1] ? dark : base);
  }
  if (opts.rungs) for (const y of opts.rungs) px.hline(0, S - 1, y, base);
  px.grain(rng, 0.05);
}

/** Two-tone panelled machine face, the base for furnaces and dispensers. */
function paintMachineFace(px, rng, body, panel, opts = {}) {
  paintStoneish(px, rng, body, { grain: 0.05, clusters: 3 });
  const x0 = opts.x ?? 3, y0 = opts.y ?? 4, wd = opts.w ?? 10, ht = opts.h ?? 9;
  px.rect(x0, y0, wd, ht, panel);
  px.bevel(x0, y0, wd, ht, 0.05, 0.3);
  px.frame(x0 - 1, y0 - 1, wd + 2, ht + 2, shade(body, 0.16));
  return { x0, y0, wd, ht };
}

/** Generic speckled stone: base + noise + grain + darker flecks. */
function paintStoneish(px, rng, base, opts = {}) {
  noiseFill(px, rng, base, opts.amp ?? 0.1, opts.octaves ?? 3, opts.freq ?? 4);
  px.grain(rng, opts.grain ?? 0.055);
  clusters(px, rng, opts.clusters ?? 4, opts.fleck ?? shade(base, -0.24), 0.75);
  if (opts.lightFleck !== false) {
    clusters(px, rng, opts.lightClusters ?? 2, shade(base, 0.16), 0.5, 2);
  }
}

/** Register a family of six pillar faces from one side and one top painter. */
function pillar(side, top, sidePainter, topPainter) {
  tex(side, sidePainter);
  tex(top, topPainter);
}

// ---------------------------------------------------------------------------

let registered = false;

/** Install every block painter. Idempotent. */
export function registerBlockTextures() {
  if (registered) return;
  registered = true;
  // Each group registers independently: a group that fails (or was never
  // written) costs only its own textures, and the engine paints procedural
  // fallbacks for whatever is left unregistered.
  const groups = {
    stone: registerStone, ores: registerOres, soil: registerSoil,
    wood: registerWood, building: registerBuilding, colored: registerColored,
    plants: registerPlants, crops: registerCrops, fluids: registerFluids,
    utility: registerUtility,
  };
  for (const [name, fn] of Object.entries(groups)) {
    if (typeof fn !== 'function') continue;
    try {
      fn();
    } catch (e) {
      console.error(`[textures] ${name} group failed:`, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Stone and rock
// ---------------------------------------------------------------------------

/** A carved panel motif — chiselled bricks in every stone family share it. */
function paintChiseled(px, rng, base, opts = {}) {
  paintStoneish(px, rng, base, { grain: 0.04, clusters: 2, amp: 0.07 });
  px.frame(0, 0, S, S, shade(base, -0.3));
  px.rect(2, 2, 12, 12, shade(base, 0.06));
  px.bevel(2, 2, 12, 12, 0.2, 0.24);
  const acc = opts.accent ?? shade(base, -0.26);
  // A shallow relief: centre column flanked by notches.
  px.rect(6, 4, 4, 8, shade(base, -0.1));
  px.bevel(6, 4, 4, 8, 0.22, 0.26);
  px.vline(7, 5, 10, acc);
  px.vline(8, 5, 10, shade(base, 0.12));
  px.hline(4, 11, 3, acc);
  px.hline(4, 11, 12, acc);
  px.set(4, 4, acc); px.set(11, 4, acc);
  px.set(4, 11, acc); px.set(11, 11, acc);
  px.grain(rng, 0.03);
}

/** Vertically streaked stone — deepslate's side face and basalt columns. */
function paintStreaked(px, rng, base, dark, opts = {}) {
  for (let x = 0; x < S; x++) {
    const t = rng.next();
    for (let y = 0; y < S; y++) {
      const v = clamp(t + Math.sin(y * 0.55 + x * 1.7) * (opts.wave ?? 0.12)
        + (rng.next() - 0.5) * 0.18, 0, 1);
      px.set(x, y, mixHex(dark, base, v));
    }
  }
  for (let i = 0; i < (opts.seams ?? 3); i++) {
    const x = rng.int(S), y0 = rng.int(S), len = 4 + rng.int(10);
    for (let k = 0; k < len; k++) blendw(px, x, y0 + k, shade(dark, -0.25), 0.55);
  }
  px.grain(rng, opts.grain ?? 0.05);
}

/** A tapered dripstone segment on transparency. */
function dripstoneSegment(px, rng, wTop, wBot, opts = {}) {
  const base = P.stone.dripstone;
  for (let y = 0; y < S; y++) {
    const t = y / (S - 1);
    const width = lerp(wTop, wBot, t);
    const half = width / 2;
    for (let x = 0; x < S; x++) {
      const d = Math.abs(x + 0.5 - 8);
      if (d > half) continue;
      const edge = d / Math.max(half, 0.5);
      let c = mixHex(shade(base, 0.16), shade(base, -0.3), edge * 0.9);
      if (x + 0.5 < 8) c = shade(c, 0.1);
      px.set(x, y, shade(c, (rng.next() - 0.5) * 0.1));
    }
  }
  px.grain(rng, 0.05);
  if (opts.tip) {
    // Wet stone catches a highlight at the point.
    for (let y = S - 3; y < S; y++) px.shadePixel(8, y, 0.2);
  }
}

function registerStone() {
  tex('stone', (px, rng) => {
    paintStoneish(px, rng, P.stone.stone, { amp: 0.09, grain: 0.06, clusters: 5 });
  });
  tex('smooth_stone', (px, rng) => {
    noiseFill(px, rng, P.stone.smooth, 0.045, 2, 3);
    px.grain(rng, 0.028);
    frameBevel(px, 0.06, 0.08);
  });
  tex('cobblestone', (px, rng) => paintCobbles(px, rng, P.stone.cobble, { count: 11 }));
  derive('mossy_cobblestone', 'cobblestone', (px, rng) => mossOver(px, rng, { threshold: 0.48 }));

  tex('stone_bricks', (px, rng) => {
    const base = P.stone.brick;
    paintStoneish(px, rng, base, { amp: 0.07, grain: 0.045, clusters: 3 });
    const mortar = shade(base, -0.4);
    // 2x2 bricks with a 1px groove between them.
    px.hline(0, S - 1, 7, mortar);
    px.hline(0, S - 1, 15, mortar);
    px.vline(7, 0, 7, mortar);
    px.vline(15, 8, 15, mortar);
    px.bevel(0, 0, 8, 8, 0.16, 0.0);
    px.bevel(8, 0, 8, 8, 0.16, 0.0);
    px.bevel(0, 8, 8, 8, 0.16, 0.0);
    px.bevel(8, 8, 8, 8, 0.16, 0.0);
    px.grain(rng, 0.03);
  });
  derive('mossy_stone_bricks', 'stone_bricks', (px, rng) => mossOver(px, rng, { threshold: 0.5 }));
  derive('cracked_stone_bricks', 'stone_bricks', (px, rng) => {
    crackWalk(px, rng, 4, 12, shade(P.stone.brick, -0.5), 0.85);
  });
  tex('chiseled_stone_bricks', (px, rng) => paintChiseled(px, rng, P.stone.brick));

  tex('granite', (px, rng) => {
    paintStoneish(px, rng, P.stone.granite, { amp: 0.13, clusters: 6, freq: 3 });
    px.speckle(rng, 30, P.stone.graniteFleck, 0.55);
    px.speckle(rng, 16, shade(P.stone.granite, -0.32), 0.5);
  });
  tex('polished_granite', (px, rng) => {
    noiseFill(px, rng, P.stone.granitePolished, 0.05, 2, 3);
    px.speckle(rng, 20, P.stone.graniteFleck, 0.35);
    px.grain(rng, 0.03);
    frameBevel(px);
  });
  tex('diorite', (px, rng) => {
    paintStoneish(px, rng, P.stone.diorite, { amp: 0.09, clusters: 7, freq: 3 });
    px.speckle(rng, 36, P.stone.dioriteDark, 0.6);
    px.speckle(rng, 22, 0xffffff, 0.4);
  });
  tex('polished_diorite', (px, rng) => {
    noiseFill(px, rng, P.stone.dioritePolished, 0.04, 2, 3);
    px.speckle(rng, 18, P.stone.dioriteDark, 0.3);
    px.grain(rng, 0.025);
    frameBevel(px);
  });
  tex('andesite', (px, rng) => {
    paintStoneish(px, rng, P.stone.andesite, { amp: 0.11, clusters: 5, freq: 4 });
    px.speckle(rng, 28, P.stone.andesiteDark, 0.5);
    px.speckle(rng, 14, shade(P.stone.andesite, 0.2), 0.4);
  });
  tex('polished_andesite', (px, rng) => {
    noiseFill(px, rng, P.stone.andesitePolished, 0.05, 2, 3);
    px.speckle(rng, 16, P.stone.andesiteDark, 0.3);
    px.grain(rng, 0.028);
    frameBevel(px);
  });

  // --- deepslate ---
  tex('deepslate', (px, rng) => {
    paintStreaked(px, rng, P.stone.deepslate, P.stone.deepslateDark, { seams: 4 });
  });
  tex('deepslate_top', (px, rng) => {
    paintStoneish(px, rng, P.stone.deepslate, { amp: 0.13, clusters: 5, freq: 3 });
    clusters(px, rng, 3, P.stone.deepslateDark, 0.7, 4);
  });
  tex('cobbled_deepslate', (px, rng) => {
    paintCobbles(px, rng, P.stone.cobbledDeepslate, { count: 12, spread: 0.3 });
  });
  tex('polished_deepslate', (px, rng) => {
    noiseFill(px, rng, P.stone.polishedDeepslate, 0.06, 2, 3);
    px.grain(rng, 0.035);
    px.speckle(rng, 14, P.stone.deepslateDark, 0.4);
    frameBevel(px, 0.12, 0.14);
  });
  tex('deepslate_bricks', (px, rng) => {
    paintBrickCourse(px, rng, P.stone.deepslateBrick, shade(P.stone.deepslateBrick, -0.45),
      { rows: 4, perRow: 2, jitter: 0.1 });
    px.grain(rng, 0.04);
  });
  derive('cracked_deepslate_bricks', 'deepslate_bricks', (px, rng) => {
    crackWalk(px, rng, 4, 11, 0x1c1c20, 0.8);
  });
  tex('deepslate_tiles', (px, rng) => {
    const base = P.stone.deepslateTile;
    paintStoneish(px, rng, base, { amp: 0.07, grain: 0.04, clusters: 3 });
    const mortar = shade(base, -0.45);
    for (const g of [3, 7, 11, 15]) { px.hline(0, S - 1, g, mortar); px.vline(g, 0, S - 1, mortar); }
    for (let ty = 0; ty < 4; ty++) {
      for (let tx = 0; tx < 4; tx++) px.bevel(tx * 4, ty * 4, 4, 4, 0.14, 0.0);
    }
    px.grain(rng, 0.03);
  });
  derive('cracked_deepslate_tiles', 'deepslate_tiles', (px, rng) => {
    crackWalk(px, rng, 5, 9, 0x15151a, 0.8);
  });
  tex('chiseled_deepslate', (px, rng) => paintChiseled(px, rng, P.stone.deepslate));
  tex('reinforced_deepslate', (px, rng) => {
    paintStreaked(px, rng, P.stone.reinforced, shade(P.stone.reinforced, -0.4), { seams: 2 });
    // The bound sigil: a bright frame with corner studs.
    px.frame(2, 2, 12, 12, 0x8f9aa5);
    px.frame(3, 3, 10, 10, 0x2a2a2e);
    px.rect(6, 6, 4, 4, 0x6f7a86);
    px.bevel(6, 6, 4, 4, 0.2, 0.25);
    for (const [x, y] of [[2, 2], [13, 2], [2, 13], [13, 13]]) px.set(x, y, 0xc8d2dc);
    px.grain(rng, 0.03);
  });

  // --- tuff, calcite, dripstone ---
  tex('tuff', (px, rng) => {
    paintStoneish(px, rng, P.stone.tuff, { amp: 0.14, clusters: 6, freq: 3 });
    px.speckle(rng, 26, P.stone.tuffDark, 0.55);
    px.speckle(rng, 12, shade(P.stone.tuff, 0.2), 0.4);
  });
  tex('polished_tuff', (px, rng) => {
    noiseFill(px, rng, shade(P.stone.tuff, 0.06), 0.05, 2, 3);
    px.grain(rng, 0.03);
    px.speckle(rng, 12, P.stone.tuffDark, 0.35);
    frameBevel(px);
  });
  tex('tuff_bricks', (px, rng) => {
    paintBrickCourse(px, rng, P.stone.tuff, shade(P.stone.tuff, -0.42), { rows: 4, perRow: 2 });
    px.speckle(rng, 14, P.stone.tuffDark, 0.4);
    px.grain(rng, 0.035);
  });
  tex('chiseled_tuff', (px, rng) => paintChiseled(px, rng, P.stone.tuff));
  tex('chiseled_tuff_bricks', (px, rng) => paintChiseled(px, rng, shade(P.stone.tuff, 0.05)));
  tex('calcite', (px, rng) => {
    paintStoneish(px, rng, P.stone.calcite, { amp: 0.05, clusters: 4, freq: 5, grain: 0.045 });
    px.speckle(rng, 30, shade(P.stone.calcite, -0.14), 0.5);
    px.speckle(rng, 16, 0xffffff, 0.5);
  });
  tex('dripstone_block', (px, rng) => {
    paintStoneish(px, rng, P.stone.dripstone, { amp: 0.14, clusters: 5, freq: 3 });
    // Vertical drip runs.
    for (let i = 0; i < 6; i++) {
      const x = rng.int(S), y0 = rng.int(S), len = 3 + rng.int(6);
      for (let k = 0; k < len; k++) blendw(px, x, y0 + k, shade(P.stone.dripstone, -0.25), 0.5);
    }
    px.grain(rng, 0.06);
  });
  for (const dir of ['up', 'down']) {
    const parts = [['base', 13, 11], ['frustum', 11, 9], ['middle', 9, 6], ['tip', 6, 1]];
    for (const [part, a, b] of parts) {
      const [wTop, wBot] = dir === 'up' ? [b, a] : [a, b];
      tex(`pointed_dripstone_${dir}_${part}`,
        (px, rng) => dripstoneSegment(px, rng, wTop, wBot, { tip: part === 'tip' }));
    }
  }

  // --- gravel, clay, bedrock, obsidian ---
  tex('gravel', (px, rng) => {
    const field = cellField(rng, 20);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const f = field(x + 0.5, y + 0.5);
        const c = shade(P.stone.gravel, (f.cell.tone - 0.5) * 0.5);
        const b = clamp(-(f.ox + f.oy) / 6, -0.3, 0.3);
        px.set(x, y, shade(c, b * 0.5));
        if (f.gap < 0.5) px.set(x, y, shade(P.stone.gravel, -0.45));
      }
    }
    px.grain(rng, 0.09);
    px.speckle(rng, 20, 0x4a4644, 0.5);
  });
  tex('clay', (px, rng) => {
    noiseFill(px, rng, P.stone.clay, 0.07, 3, 5);
    px.grain(rng, 0.05);
    px.speckle(rng, 22, shade(P.stone.clay, -0.16), 0.5);
    px.speckle(rng, 12, shade(P.stone.clay, 0.14), 0.4);
  });
  tex('bedrock', (px, rng) => {
    paintStoneish(px, rng, P.stone.bedrock, { amp: 0.24, clusters: 8, freq: 3, grain: 0.1 });
    clusters(px, rng, 6, 0x1c1c1c, 0.9, 4);
    clusters(px, rng, 4, 0x8f8f8f, 0.6, 3);
  });
  tex('obsidian', (px, rng) => {
    noiseFill(px, rng, P.stone.obsidian, 0.3, 3, 4);
    px.grain(rng, 0.07);
    // Conchoidal facets: a few bright purple glints.
    for (let i = 0; i < 7; i++) {
      const x = rng.int(S), y = rng.int(S);
      px.blend(x, y, 0x6a4fa8, 0.7);
      if (rng.chance(0.5)) px.blend(w(x + 1), y, 0x40306a, 0.5);
    }
    px.speckle(rng, 18, 0x000000, 0.5);
  });
  derive('crying_obsidian', 'obsidian', (px, rng) => {
    for (let i = 0; i < 5; i++) {
      const x = rng.int(S), y = rng.int(S), len = 2 + rng.int(4);
      for (let k = 0; k < len; k++) {
        blendw(px, x, y + k, k === 0 ? 0x8f6ff5 : P.stone.obsidianCry, 0.85);
      }
      blendw(px, x, y + len, 0xa88ffa, 0.9);
    }
  });

  // --- basalt and blackstone ---
  tex('basalt_side', (px, rng) => {
    paintStreaked(px, rng, P.stone.basalt, P.stone.basaltDark, { seams: 5, wave: 0.06 });
  });
  tex('basalt_top', (px, rng) => {
    paintStoneish(px, rng, P.stone.basalt, { amp: 0.12, clusters: 4, freq: 4 });
    // The columnar joint pattern: a ring of dark cracks.
    const field = cellField(rng, 5);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (field(x + 0.5, y + 0.5).gap < 0.9) px.set(x, y, P.stone.basaltDark);
      }
    }
    px.grain(rng, 0.05);
  });
  tex('polished_basalt_side', (px, rng) => {
    noiseFill(px, rng, shade(P.stone.basalt, 0.08), 0.05, 2, 3);
    for (const x of [2, 5, 8, 11, 14]) px.vline(x, 0, S - 1, shade(P.stone.basalt, -0.22));
    for (const x of [3, 6, 9, 12]) px.vline(x, 0, S - 1, shade(P.stone.basalt, 0.16));
    px.grain(rng, 0.035);
  });
  tex('polished_basalt_top', (px, rng) => {
    noiseFill(px, rng, shade(P.stone.basalt, 0.08), 0.05, 2, 3);
    for (let r = 2; r < 9; r += 2) px.circle(7.5, 7.5, r, shade(P.stone.basalt, -0.2), 255, false);
    px.grain(rng, 0.035);
    frameBevel(px, 0.1, 0.12);
  });
  tex('smooth_basalt', (px, rng) => {
    noiseFill(px, rng, P.stone.smoothBasalt, 0.09, 3, 4);
    px.grain(rng, 0.045);
    px.speckle(rng, 18, shade(P.stone.smoothBasalt, -0.3), 0.5);
    px.speckle(rng, 8, shade(P.stone.smoothBasalt, 0.22), 0.4);
  });
  tex('blackstone', (px, rng) => {
    paintStoneish(px, rng, P.stone.blackstone, { amp: 0.2, clusters: 6, freq: 3, grain: 0.07 });
    px.speckle(rng, 22, P.stone.blackstoneDark, 0.6);
    px.speckle(rng, 10, 0x4a4048, 0.5);
  });
  derive('gilded_blackstone', 'blackstone', (px, rng) => {
    scatterMineral(px, rng, P.ore.gold, 5, 1.1, 1.8);
  });
  tex('polished_blackstone', (px, rng) => {
    noiseFill(px, rng, shade(P.stone.blackstone, 0.08), 0.07, 2, 3);
    px.grain(rng, 0.04);
    frameBevel(px, 0.12, 0.14);
    px.speckle(rng, 10, P.stone.blackstoneDark, 0.4);
  });
  tex('polished_blackstone_bricks', (px, rng) => {
    paintBrickCourse(px, rng, shade(P.stone.blackstone, 0.1),
      shade(P.stone.blackstone, -0.4), { rows: 4, perRow: 2 });
    px.grain(rng, 0.04);
  });
  derive('cracked_polished_blackstone_bricks', 'polished_blackstone_bricks', (px, rng) => {
    crackWalk(px, rng, 4, 11, 0x0d0a0e, 0.85);
  });
  tex('chiseled_polished_blackstone', (px, rng) => {
    paintChiseled(px, rng, shade(P.stone.blackstone, 0.1));
  });

  // --- prismarine ---
  tex('prismarine', (px, rng) => {
    // A loose mosaic of teal tiles, brighter toward the middle of each.
    const field = cellField(rng, 14);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const f = field(x + 0.5, y + 0.5);
        let c = shade(P.stone.prismarine, (f.cell.tone - 0.5) * 0.34);
        if (f.gap < 0.8) c = shade(P.stone.prismarineDark, 0.05);
        px.set(x, y, c);
      }
    }
    px.grain(rng, 0.05);
    px.speckle(rng, 12, 0x9fd8c8, 0.4);
  });
  tex('prismarine_bricks', (px, rng) => {
    noiseFill(px, rng, P.stone.prismarineBrick, 0.07, 2, 4);
    const mortar = shade(P.stone.prismarineBrick, -0.34);
    for (const g of [7, 15]) { px.hline(0, S - 1, g, mortar); px.vline(g, 0, S - 1, mortar); }
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        px.bevel(tx * 8, ty * 8, 8, 8, 0.18, 0.06);
        px.rect(tx * 8 + 3, ty * 8 + 3, 2, 2, shade(P.stone.prismarineBrick, 0.22));
      }
    }
    px.grain(rng, 0.035);
  });
  tex('dark_prismarine', (px, rng) => {
    noiseFill(px, rng, P.stone.prismarineDark, 0.1, 3, 6);
    px.grain(rng, 0.06);
    for (let y = 0; y < S; y += 2) {
      for (let x = (y >> 1) % 2; x < S; x += 2) {
        px.blend(x, y, shade(P.stone.prismarineDark, 0.18), 0.4);
      }
    }
    px.speckle(rng, 10, 0x6fa89a, 0.35);
  });

  // --- moss, sculk ---
  tex('moss_block', (px, rng) => {
    noiseFill(px, rng, P.stone.moss, 0.18, 3, 5);
    px.grain(rng, 0.09);
    clusters(px, rng, 6, P.stone.mossDark, 0.7, 4);
    clusters(px, rng, 4, shade(P.stone.moss, 0.24), 0.5, 3);
    px.speckle(rng, 14, 0x2c4416, 0.5);
  });
  tex('sculk', (px, rng) => {
    noiseFill(px, rng, P.stone.sculk, 0.3, 3, 4);
    px.grain(rng, 0.07);
    // Glowing filaments.
    for (let i = 0; i < 9; i++) {
      let x = rng.int(S), y = rng.int(S);
      for (let k = 0; k < 3 + rng.int(4); k++) {
        blendw(px, x, y, P.stone.sculkGlow, 0.55 + rng.next() * 0.35);
        x += rng.int(3) - 1; y += rng.int(3) - 1;
      }
    }
    px.speckle(rng, 14, 0x061a1f, 0.6);
  });
  tex('sculk_vein', (px, rng) => {
    // Tendrils on transparency, so it can lie over any face.
    for (let i = 0; i < 11; i++) {
      let x = rng.int(S), y = rng.int(S);
      for (let k = 0; k < 4 + rng.int(6); k++) {
        setw(px, x, y, rng.chance(0.25) ? P.stone.sculkGlow : P.stone.sculkVein);
        if (rng.chance(0.35)) setw(px, x + 1, y, shade(P.stone.sculkVein, -0.3));
        x += rng.int(3) - 1; y += rng.int(3) - 1;
      }
    }
  });
  derive('sculk_catalyst_bottom', 'sculk', (px, rng) => { px.scale(0.85); px.grain(rng, 0.05); });
  tex('sculk_catalyst_top', (px, rng) => {
    paintInto('sculk', px);
    // The bone-white crown of horns.
    for (let i = 0; i < 5; i++) {
      const x = 2 + rng.int(12), y = 2 + rng.int(12);
      px.set(x, y, P.misc.bone);
      px.set(w(x + 1), y, P.misc.boneDark);
      px.set(x, w(y + 1), P.misc.boneDark);
    }
    px.speckle(rng, 8, P.stone.sculkGlow, 0.5);
  });
  tex('sculk_catalyst_side', (px, rng) => {
    paintInto('sculk', px);
    for (let x = 0; x < S; x++) {
      const h = 2 + (rng.next() > 0.6 ? 1 : 0);
      for (let y = 0; y < h; y++) px.set(x, y, y === 0 ? P.misc.bone : P.misc.boneDark);
    }
    px.speckle(rng, 6, P.stone.sculkGlow, 0.5);
  });
  derive('sculk_catalyst_side_bloom', 'sculk_catalyst_side', (px, rng) => {
    for (let i = 0; i < 16; i++) px.blend(rng.int(S), 2 + rng.int(14), 0x4ff0e0, 0.6);
  });
  tex('sculk_sensor_top', (px, rng) => {
    paintInto('sculk', px);
    // Two tendrils reaching up out of the block.
    for (const cx of [4, 11]) {
      for (let k = 0; k < 5; k++) {
        px.set(w(cx + (k % 2)), 3 + k, k < 2 ? P.stone.sculkGlow : P.stone.sculkVein);
      }
    }
    px.rect(6, 6, 4, 4, 0x1c4a52);
    px.bevel(6, 6, 4, 4, 0.2, 0.2);
  });
  derive('sculk_sensor_side', 'sculk', (px, rng) => {
    for (let x = 0; x < S; x++) px.set(x, 0, rng.chance(0.4) ? P.stone.sculkGlow : P.stone.sculkVein);
    for (let x = 0; x < S; x++) px.set(x, 1, P.stone.sculkVein);
  });
  derive('sculk_sensor_bottom', 'sculk', (px) => px.scale(0.8));
  tex('sculk_shrieker_top', (px, rng) => {
    paintInto('sculk', px);
    for (let r = 6; r >= 2; r -= 2) {
      px.circle(7.5, 7.5, r, r === 6 ? 0x1c4a52 : shade(P.stone.sculkGlow, -0.3), 255, false);
    }
    px.circle(7.5, 7.5, 1.4, 0x0a1a1e);
    px.speckle(rng, 6, P.stone.sculkGlow, 0.5);
  });
  derive('sculk_shrieker_side', 'sculk', (px, rng) => {
    px.hline(0, S - 1, 0, P.misc.bone);
    px.hline(0, S - 1, 1, P.misc.boneDark);
    for (let i = 0; i < 5; i++) px.blend(rng.int(S), 2 + rng.int(13), P.stone.sculkGlow, 0.5);
  });
  derive('sculk_shrieker_bottom', 'sculk', (px) => px.scale(0.8));

  // --- amethyst ---
  tex('amethyst_block', (px, rng) => {
    noiseFill(px, rng, P.stone.amethyst, 0.16, 3, 4);
    // Facets: short bright and dark diagonals.
    for (let i = 0; i < 12; i++) {
      const x = rng.int(S), y = rng.int(S), len = 2 + rng.int(4);
      const c = rng.chance(0.5) ? P.stone.amethystBud : P.stone.amethystDeep;
      for (let k = 0; k < len; k++) blendw(px, x + k, y + k, c, 0.7);
    }
    px.grain(rng, 0.05);
  });
  derive('budding_amethyst', 'amethyst_block', (px, rng) => {
    // Four budding sites, one per quadrant.
    for (const [cx, cy] of [[4, 4], [11, 4], [4, 11], [11, 11]]) {
      px.circle(cx, cy, 2.2, P.stone.amethystDeep);
      px.circle(cx, cy, 1.2, shade(P.stone.amethystDeep, -0.35));
      px.set(cx - 1, cy - 1, P.stone.amethystBud);
    }
    px.grain(rng, 0.04);
  });
  const budSizes = { small: 3, medium: 5, large: 7 };
  for (const [size, h] of Object.entries(budSizes)) {
    tex(`${size}_amethyst_bud`, (px, rng) => {
      const top = S - h - 1;
      for (let y = top; y < S; y++) {
        const half = 1 + Math.round(((y - top) / h) * 1.6);
        for (let x = 8 - half; x <= 7 + half; x++) {
          px.set(x, y, x < 8 ? P.stone.amethystBud : P.stone.amethyst);
        }
      }
      px.set(8, top, shade(P.stone.amethystBud, 0.3));
      for (let y = top; y < S; y++) px.set(6 + (y % 2), y, P.stone.amethystDeep);
      px.grain(rng, 0.05);
    });
  }
  tex('amethyst_cluster', (px, rng) => {
    // Three crystals of different heights sharing a base.
    const spikes = [[5, 5], [8, 2], [11, 7]];
    for (const [cx, top] of spikes) {
      for (let y = top; y < S; y++) {
        const t = (y - top) / (S - top);
        const half = Math.max(0, Math.round(t * 2.2));
        for (let x = cx - half; x <= cx + half; x++) {
          px.set(x, y, x < cx ? P.stone.amethystBud : x > cx ? P.stone.amethystDeep : P.stone.amethyst);
        }
      }
      px.set(cx, top, 0xe0d0ff);
    }
    px.grain(rng, 0.05);
  });
}

// ---------------------------------------------------------------------------
// Ores and mineral blocks
// ---------------------------------------------------------------------------

/** A smooth ingot block: flat metal with a bevelled edge and a soft sheen. */
function paintMetalBlock(px, rng, base, dark) {
  noiseFill(px, rng, base, 0.05, 2, 3);
  px.grain(rng, 0.025);
  frameBevel(px, 0.14, 0.22);
  px.frame(1, 1, 14, 14, dark, 90);
  px.bevel(2, 2, 12, 12, 0.1, 0.12);
  // Sheen down the top-left diagonal.
  for (let i = 3; i < 8; i++) px.shadePixel(i, 10 - i, 0.22);
}

/** A block of cut gems: a lattice of little faceted stones. */
function paintGemBlock(px, rng, mid, light, dark) {
  noiseFill(px, rng, dark, 0.1, 2, 3);
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      const cx = gx * 8 + 4, cy = gy * 8 + 4;
      for (let y = -3; y <= 3; y++) {
        for (let x = -3; x <= 3; x++) {
          if (Math.abs(x) + Math.abs(y) > 3) continue;
          let c = mid;
          if (x + y < -1) c = light;
          else if (x + y > 1) c = shade(dark, 0.15);
          px.set(cx + x, cy + y, c);
        }
      }
      px.set(cx - 1, cy - 1, 0xffffff);
    }
  }
  px.grain(rng, 0.04);
}

/** Lumps of raw ore packed together — the raw metal blocks. */
function paintRawBlock(px, rng, base) {
  const field = cellField(rng, 7);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const f = field(x + 0.5, y + 0.5);
      let c = shade(base, (f.cell.tone - 0.5) * 0.3);
      c = shade(c, clamp(-(f.ox + f.oy) / 7, -0.3, 0.3) * 0.8);
      if (f.gap < 0.9) c = shade(base, -0.45);
      px.set(x, y, c);
    }
  }
  px.grain(rng, 0.06);
  px.speckle(rng, 14, shade(base, 0.3), 0.4);
}

function registerOres() {
  const overworld = [
    ['coal_ore', P.ore.coal, 5],
    ['iron_ore', P.ore.iron, 6],
    ['copper_ore', P.ore.copper, 7],
    ['gold_ore', P.ore.gold, 6],
    ['redstone_ore', P.ore.redstone, 7],
    ['lapis_ore', P.ore.lapis, 6],
    ['diamond_ore', P.ore.diamond, 5],
    ['emerald_ore', P.ore.emerald, 4],
  ];
  for (const [name, mineral, count] of overworld) {
    ore(name, 'stone', mineral, count);
    ore(`deepslate_${name}`, 'deepslate', mineral, count);
  }
  ore('nether_gold_ore', 'netherrack', P.ore.netherGold, 7, { minR: 1.1, maxR: 1.8 });
  ore('nether_quartz_ore', 'netherrack', P.ore.quartz, 6, { minR: 1.2, maxR: 2.0 });
  tex('ancient_debris', (px, rng) => {
    paintStoneish(px, rng, P.nether.ancientDebris, { amp: 0.18, clusters: 5, freq: 3 });
    scatterMineral(px, rng, P.ore.debris, 5, 1.6, 2.6);
    // The netherite scraps show as near-black flecks with a warm rim.
    for (let i = 0; i < 5; i++) {
      const x = rng.int(S), y = rng.int(S);
      px.set(x, y, P.metal.netheriteDark);
      px.blend(w(x + 1), y, 0x8f6a4a, 0.5);
    }
    px.grain(rng, 0.06);
  });

  tex('coal_block', (px, rng) => {
    noiseFill(px, rng, P.metal.coal, 0.5, 3, 4);
    px.grain(rng, 0.06);
    px.speckle(rng, 24, 0x2e2e2e, 0.6);
    px.speckle(rng, 10, 0x000000, 0.8);
  });
  tex('iron_block', (px, rng) => paintMetalBlock(px, rng, P.metal.iron, P.metal.ironDark));
  tex('gold_block', (px, rng) => paintMetalBlock(px, rng, P.metal.gold, P.metal.goldDark));
  tex('netherite_block', (px, rng) => {
    noiseFill(px, rng, P.metal.netherite, 0.14, 3, 4);
    px.grain(rng, 0.05);
    // The speckled "ingot grain" netherite is known for.
    for (let i = 0; i < 14; i++) {
      const x = rng.int(S), y = rng.int(S);
      px.set(x, y, P.metal.netheriteDark);
      if (rng.chance(0.4)) px.set(w(x + 1), y, 0x5c5257);
    }
    frameBevel(px, 0.08, 0.14);
  });
  tex('diamond_block', (px, rng) => paintGemBlock(px, rng, P.metal.diamond, 0xc8fffd, P.metal.diamondDark));
  tex('emerald_block', (px, rng) => paintGemBlock(px, rng, P.metal.emerald, 0x8ff7b4, P.metal.emeraldDark));
  tex('lapis_block', (px, rng) => {
    noiseFill(px, rng, P.metal.lapis, 0.22, 3, 4);
    clusters(px, rng, 6, P.metal.lapisDark, 0.7, 4);
    clusters(px, rng, 5, 0x6f9cf5, 0.6, 3);
    px.speckle(rng, 14, 0xd8d8d8, 0.35);
    px.grain(rng, 0.05);
  });
  tex('redstone_block', (px, rng) => {
    noiseFill(px, rng, P.metal.redstone, 0.22, 3, 5);
    px.grain(rng, 0.07);
    px.speckle(rng, 26, 0xf03a2a, 0.5);
    px.speckle(rng, 16, 0x5c0a0a, 0.6);
  });
  tex('raw_iron_block', (px, rng) => paintRawBlock(px, rng, P.metal.rawIron));
  tex('raw_gold_block', (px, rng) => paintRawBlock(px, rng, P.metal.rawGold));
  tex('raw_copper_block', (px, rng) => paintRawBlock(px, rng, P.metal.rawCopper));

  // --- copper and its four oxidation stages -------------------------------
  // Each step keeps the same underlying hammered-plate shape and grows a
  // greener patina over it, so a half-weathered wall reads as one material.
  const stages = [
    ['', P.metal.copper, P.metal.copperCut, 0],
    ['exposed_', P.metal.exposed, P.metal.exposedCut, 0.3],
    ['weathered_', P.metal.weathered, P.metal.weatheredCut, 0.62],
    ['oxidized_', P.metal.oxidized, P.metal.oxidizedCut, 0.9],
  ];
  for (const [prefix, block, cut, patina] of stages) {
    // Vanilla names the fresh stage `copper_block` but the rest `*_copper`.
    tex(prefix ? `${prefix}copper` : 'copper_block', (px, rng) => {
      noiseFill(px, rng, block, 0.1, 3, 4);
      px.grain(rng, 0.05);
      // Hammered dents.
      for (let i = 0; i < 9; i++) {
        const x = rng.int(S), y = rng.int(S);
        px.blend(x, y, shade(block, -0.22), 0.6);
        px.blend(w(x + 1), w(y + 1), shade(block, 0.2), 0.4);
      }
      if (patina > 0) copperPatina(px, rng, patina);
    });
    tex(`${prefix}cut_copper`, (px, rng) => {
      noiseFill(px, rng, cut, 0.07, 2, 3);
      const line = shade(cut, -0.3);
      px.hline(0, S - 1, 7, line);
      px.hline(0, S - 1, 15, line);
      px.vline(7, 0, 7, line);
      px.vline(15, 8, 15, line);
      for (const [bx, by] of [[0, 0], [8, 0], [0, 8], [8, 8]]) px.bevel(bx, by, 8, 8, 0.16, 0.0);
      px.grain(rng, 0.035);
      if (patina > 0) copperPatina(px, rng, patina);
    });
  }
}

/** Green corrosion spreading over copper; `amount` is 0..1 of full coverage. */
function copperPatina(px, rng, amount) {
  const n = fbm2(rng, S, 3, 4);
  const threshold = 1 - amount * 0.95;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = n[y * S + x];
      if (v < threshold - 0.25) continue;
      const t = clamp((v - (threshold - 0.25)) / 0.35, 0, 1);
      px.blend(x, y, mixHex(P.metal.patina, 0x86c7a4, rng.next() * 0.5), t * 0.9);
    }
  }
  px.speckle(rng, Math.round(10 * amount), 0x3f7d5f, 0.5);
  px.grain(rng, 0.04);
}

// ---------------------------------------------------------------------------
// Soil, sand, ice
// ---------------------------------------------------------------------------

/** Plain dirt: warm mid-brown with light and dark grain, no structure. */
function paintDirt(px, rng, base = P.soil.dirt, opts = {}) {
  noiseFill(px, rng, base, opts.amp ?? 0.11, 3, 4);
  px.grain(rng, opts.grain ?? 0.08);
  clusters(px, rng, opts.dark ?? 5, P.soil.dirtDark, 0.65, 3);
  clusters(px, rng, opts.light ?? 4, P.soil.dirtLight, 0.5, 3);
  px.speckle(rng, 12, shade(base, -0.3), 0.5);
}

/**
 * The ragged grass fringe that runs along the top of a grass block's side.
 * Vanilla draws this as a separate tinted overlay quad; we have no overlay
 * pass, so it is baked in already-green and the dirt beneath stays brown.
 * `onto` may be null to draw the fringe alone (the overlay texture).
 */
function grassFringe(px, rng, colors, opts = {}) {
  const min = opts.min ?? 3, max = opts.max ?? 5;
  const heights = [];
  for (let x = 0; x < S; x++) heights.push(min + rng.int(max - min + 1));
  // Smooth the profile so it looks like turf, not a bar chart.
  for (let i = 0; i < S; i++) {
    const a = heights[(i + S - 1) % S], b = heights[i], c = heights[(i + 1) % S];
    heights[i] = Math.round((a + b * 2 + c) / 4);
  }
  for (let x = 0; x < S; x++) {
    const h = heights[x];
    for (let y = 0; y < h; y++) {
      const t = y / Math.max(h - 1, 1);
      let col = mixHex(colors.light, colors.dark, t * 0.9);
      if (y === h - 1) col = colors.dark;
      px.set(x, y, shade(col, (rng.next() - 0.5) * 0.12));
    }
    // A stray blade below the main mass.
    if (rng.chance(0.3)) px.set(x, h, colors.dark);
  }
}

function registerSoil() {
  tex('dirt', (px, rng) => paintDirt(px, rng));
  tex('coarse_dirt', (px, rng) => {
    paintDirt(px, rng, P.soil.coarse, { amp: 0.16, grain: 0.11, dark: 7, light: 5 });
    // Grit: hard dark pixels that make it read rougher than plain dirt.
    px.speckle(rng, 30, 0x4a3220, 0.7);
    px.speckle(rng, 16, 0xb08a62, 0.5);
  });
  tex('rooted_dirt', (px, rng) => {
    paintDirt(px, rng, P.soil.rooted, { amp: 0.1 });
    for (let i = 0; i < 7; i++) {
      let x = rng.int(S), y = rng.int(S);
      for (let k = 0; k < 3 + rng.int(4); k++) {
        blendw(px, x, y, P.soil.root, 0.8);
        x += rng.int(3) - 1; y += rng.int(2);
      }
    }
  });

  tex('grass_block_top', (px, rng) => {
    // Deliberately pale: the chunk shader multiplies this by the biome colour.
    noiseFill(px, rng, P.grass.neutral, 0.09, 3, 6);
    px.grain(rng, 0.075);
    clusters(px, rng, 5, P.grass.neutralDark, 0.55, 3);
    clusters(px, rng, 4, shade(P.grass.neutral, 0.14), 0.45, 3);
    px.speckle(rng, 14, shade(P.grass.neutralDark, -0.1), 0.4);
  });
  tex('grass_block_side', (px, rng) => {
    paintDirt(px, rng);
    grassFringe(px, rng, { light: P.grass.fringeLight, dark: P.grass.fringeDark });
    // The very top row is fully turf.
    for (let x = 0; x < S; x++) px.set(x, 0, shade(P.grass.fringe, (rng.next() - 0.5) * 0.14));
  });
  tex('grass_block_side_overlay', (px, rng) => {
    // The tinted fringe on its own: alpha 0 everywhere the turf is not.
    grassFringe(px, rng, { light: P.grass.neutral, dark: P.grass.neutralDark });
    for (let x = 0; x < S; x++) px.set(x, 0, P.grass.neutral);
  });
  tex('grass_block_snow', (px, rng) => {
    paintDirt(px, rng);
    grassFringe(px, rng, { light: 0xffffff, dark: P.soil.snowShade }, { min: 4, max: 6 });
    for (let x = 0; x < S; x++) px.set(x, 0, 0xffffff);
  });

  tex('podzol_top', (px, rng) => {
    noiseFill(px, rng, P.soil.podzolTop, 0.16, 3, 5);
    px.grain(rng, 0.09);
    clusters(px, rng, 6, P.soil.podzolOrange, 0.7, 4);
    clusters(px, rng, 5, P.soil.podzol, 0.7, 3);
    px.speckle(rng, 18, 0x3a2410, 0.6);
    px.speckle(rng, 10, 0xa9701f, 0.5);
  });
  tex('podzol_side', (px, rng) => {
    paintDirt(px, rng);
    // A dark humus band under a rusty orange litter layer.
    grassFringe(px, rng, { light: P.soil.podzolOrange, dark: P.soil.podzol },
      { min: 3, max: 5 });
    for (let x = 0; x < S; x++) px.set(x, 0, shade(P.soil.podzolOrange, (rng.next() - 0.5) * 0.16));
    px.speckle(rng, 8, 0x2e1c0c, 0.5);
  });
  tex('mycelium_top', (px, rng) => {
    noiseFill(px, rng, P.soil.myceliumTop, 0.14, 3, 5);
    px.grain(rng, 0.08);
    clusters(px, rng, 6, P.soil.mycelium, 0.6, 3);
    px.speckle(rng, 22, P.soil.myceliumSpore, 0.6);
    px.speckle(rng, 10, 0x4a3f45, 0.5);
  });
  tex('mycelium_side', (px, rng) => {
    paintDirt(px, rng);
    grassFringe(px, rng, { light: P.soil.myceliumSpore, dark: P.soil.mycelium },
      { min: 2, max: 4 });
    for (let x = 0; x < S; x++) px.set(x, 0, shade(P.soil.myceliumTop, (rng.next() - 0.5) * 0.14));
  });

  tex('dirt_path_top', (px, rng) => {
    noiseFill(px, rng, P.soil.path, 0.1, 3, 5);
    px.grain(rng, 0.07);
    clusters(px, rng, 4, shade(P.soil.path, -0.24), 0.55, 3);
    px.speckle(rng, 14, shade(P.soil.path, 0.15), 0.4);
    // Trodden edge.
    px.frame(0, 0, S, S, shade(P.soil.path, -0.2), 120);
  });
  tex('dirt_path_side', (px, rng) => {
    paintDirt(px, rng);
    for (let x = 0; x < S; x++) {
      px.set(x, 0, shade(P.soil.path, (rng.next() - 0.5) * 0.14));
      px.blend(x, 1, P.soil.path, 0.6);
    }
  });
  tex('farmland', (px, rng) => {
    paintDirt(px, rng, P.soil.farmland, { amp: 0.09 });
    // Ploughed furrows.
    for (const y of [3, 7, 11, 15]) {
      for (let x = 0; x < S; x++) px.blend(x, y, shade(P.soil.farmland, -0.35), 0.8);
      for (let x = 0; x < S; x++) px.blend(x, w(y - 2), shade(P.soil.farmland, 0.18), 0.4);
    }
    px.grain(rng, 0.05);
  });
  derive('farmland_moist', 'farmland', (px, rng) => {
    px.tint(0x9a86c0, 0.5);
    px.scale(0.82);
    px.speckle(rng, 12, 0x2e1c10, 0.5);
  });

  tex('mud', (px, rng) => {
    noiseFill(px, rng, P.soil.mud, 0.16, 3, 4);
    px.grain(rng, 0.06);
    clusters(px, rng, 5, shade(P.soil.mud, -0.35), 0.7, 4);
    // Wet sheen.
    px.speckle(rng, 10, 0x6a5f66, 0.4);
  });
  tex('packed_mud', (px, rng) => {
    noiseFill(px, rng, P.soil.packedMud, 0.11, 3, 4);
    px.grain(rng, 0.07);
    px.speckle(rng, 22, shade(P.soil.packedMud, -0.28), 0.5);
    px.speckle(rng, 14, 0xc2a07f, 0.4);
    crackWalk(px, rng, 2, 7, shade(P.soil.packedMud, -0.4), 0.5);
  });
  tex('mud_bricks', (px, rng) => {
    paintBrickCourse(px, rng, P.soil.mudBrick, shade(P.soil.mudBrick, -0.38),
      { rows: 4, perRow: 2, jitter: 0.13 });
    px.speckle(rng, 16, shade(P.soil.mudBrick, 0.16), 0.4);
    px.grain(rng, 0.045);
  });
  tex('mangrove_roots_side', (px, rng) => {
    // Tangled roots with gaps of shadow between them.
    px.fill(0x2b1e15);
    for (let i = 0; i < 9; i++) {
      let x = rng.int(S);
      const c = shade(P.wood.mangrove.bark, (rng.next() - 0.5) * 0.3);
      for (let y = 0; y < S; y++) {
        setw(px, x, y, c);
        setw(px, x + 1, y, shade(c, -0.25));
        if (rng.chance(0.3)) x += rng.int(3) - 1;
      }
    }
    px.grain(rng, 0.07);
  });
  tex('mangrove_roots_top', (px, rng) => {
    px.fill(0x2b1e15);
    for (let i = 0; i < 7; i++) {
      const cx = rng.int(S), cy = rng.int(S), r = 1.4 + rng.next() * 1.4;
      for (let y = -3; y <= 3; y++) {
        for (let x = -3; x <= 3; x++) {
          const d = Math.hypot(x, y);
          if (d > r) continue;
          setw(px, cx + x, cy + y, d > r - 0.9 ? P.wood.mangrove.barkDark : P.wood.mangrove.core);
        }
      }
    }
    px.grain(rng, 0.06);
  });
  derive('muddy_mangrove_roots_side', 'mangrove_roots_side', (px, rng) => {
    noiseOverlay(px, rng, P.soil.mud, 0.4, 4, 0.85);
    px.grain(rng, 0.05);
  });
  derive('muddy_mangrove_roots_top', 'mangrove_roots_top', (px, rng) => {
    noiseOverlay(px, rng, P.soil.mud, 0.35, 4, 0.9);
    px.grain(rng, 0.05);
  });

  // --- sand and sandstone -------------------------------------------------
  tex('sand', (px, rng) => paintGrainy(px, rng, P.soil.sand, P.soil.sandDark, 0.06));
  tex('red_sand', (px, rng) => paintGrainy(px, rng, P.soil.redSand, P.soil.redSandDark, 0.07));

  const sandstones = [
    ['sandstone', P.soil.sandstone, P.soil.sandstoneTop, P.soil.sandstoneDark],
    ['red_sandstone', P.soil.redSandstone, P.soil.redSandstoneTop, P.soil.redSandstoneDark],
  ];
  for (const [name, base, top, dark] of sandstones) {
    tex(name, (px, rng) => {
      // The side face: horizontal strata with a capping band.
      noiseFill(px, rng, base, 0.06, 3, 6);
      for (let y = 0; y < S; y++) {
        const band = Math.sin(y * 0.9) * 0.5 + 0.5;
        for (let x = 0; x < S; x++) px.shadePixel(x, y, (band - 0.5) * 0.1);
      }
      px.hline(0, S - 1, 0, shade(top, 0.08));
      px.hline(0, S - 1, 1, top);
      px.hline(0, S - 1, 2, shade(dark, 0.1));
      px.hline(0, S - 1, S - 1, shade(dark, -0.08));
      px.grain(rng, 0.045);
      px.speckle(rng, 16, dark, 0.4);
    });
    tex(`${name}_top`, (px, rng) => paintGrainy(px, rng, top, dark, 0.05));
    tex(`${name}_bottom`, (px, rng) => {
      paintGrainy(px, rng, shade(base, -0.06), dark, 0.07);
      px.speckle(rng, 20, dark, 0.5);
    });
    tex(`cut_${name}`, (px, rng) => {
      noiseFill(px, rng, base, 0.05, 2, 4);
      px.frame(0, 0, S, S, shade(dark, -0.05));
      px.rect(1, 1, 14, 14, base);
      px.bevel(1, 1, 14, 14, 0.16, 0.2);
      px.rect(3, 3, 10, 10, shade(base, 0.04));
      px.bevel(3, 3, 10, 10, 0.06, 0.14);
      px.grain(rng, 0.035);
    });
    tex(`chiseled_${name}`, (px, rng) => {
      noiseFill(px, rng, base, 0.05, 2, 4);
      px.frame(0, 0, S, S, dark);
      px.rect(1, 1, 14, 14, shade(base, 0.04));
      px.bevel(1, 1, 14, 14, 0.14, 0.18);
      // A carved relief: the vanilla creeper/wither motif reduced to a glyph.
      const ink = shade(dark, -0.18);
      px.rect(6, 3, 4, 3, ink);
      px.set(5, 4, ink); px.set(10, 4, ink);
      px.rect(5, 7, 6, 5, ink);
      px.set(4, 8, ink); px.set(11, 8, ink);
      px.rect(7, 8, 2, 2, shade(base, 0.2));
      px.grain(rng, 0.03);
    });
  }

  // --- snow and ice -------------------------------------------------------
  tex('snow', (px, rng) => {
    noiseFill(px, rng, P.soil.snow, 0.035, 2, 5);
    px.grain(rng, 0.03);
    px.speckle(rng, 16, P.soil.snowShade, 0.4);
  });
  derive('snow_block', 'snow', (px, rng) => {
    px.speckle(rng, 10, 0xffffff, 0.5);
  });
  tex('powder_snow', (px, rng) => {
    noiseFill(px, rng, P.soil.powderSnow, 0.05, 3, 4);
    px.grain(rng, 0.045);
    // Soft drifts rather than flat white.
    clusters(px, rng, 5, 0xdfeaf5, 0.5, 4);
    px.speckle(rng, 14, 0xffffff, 0.6);
  });
  tex('ice', (px, rng) => {
    // Translucent: the pass behind it shows through.
    const n = fbm2(rng, S, 3, 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const v = n[y * S + x];
        px.set(x, y, mixHex(P.soil.ice, P.soil.iceLight, v), 178);
      }
    }
    crackWalk(px, rng, 4, 12, 0xffffff, 0.5);
    crackWalk(px, rng, 3, 9, 0x5f86c4, 0.4);
    px.frame(0, 0, S, S, 0xcfe4ff, 140);
    px.grain(rng, 0.03);
  });
  tex('packed_ice', (px, rng) => {
    noiseFill(px, rng, P.soil.packedIce, 0.1, 3, 4);
    crackWalk(px, rng, 5, 10, 0xc0d8ff, 0.45);
    px.grain(rng, 0.04);
    px.speckle(rng, 12, 0x6f92d8, 0.4);
  });
  tex('blue_ice', (px, rng) => {
    noiseFill(px, rng, P.soil.blueIce, 0.09, 3, 3);
    crackWalk(px, rng, 3, 12, 0xd0e4ff, 0.5);
    px.grain(rng, 0.03);
    frameBevel(px, 0.12, 0.1);
  });
  for (let i = 0; i < 4; i++) {
    derive(`frosted_ice_${i}`, 'ice', (px, rng) => {
      crackWalk(px, rng, 2 + i * 2, 8 + i * 3, 0x8fb4ea, 0.35 + i * 0.15);
      if (i >= 2) px.speckle(rng, i * 8, 0x6f93cc, 0.4);
    });
  }
}

// ---------------------------------------------------------------------------
// Wood
// ---------------------------------------------------------------------------

/** Species that grow leaves and saplings. Nether fungi are handled separately. */
const TREES = [
  { name: 'oak', sapling: 'oak_sapling' },
  { name: 'spruce', sapling: 'spruce_sapling', leaves: 'spruce' },
  { name: 'birch', sapling: 'birch_sapling', leaves: 'birch', dashes: true },
  { name: 'jungle', sapling: 'jungle_sapling' },
  { name: 'acacia', sapling: 'acacia_sapling' },
  { name: 'dark_oak', sapling: 'dark_oak_sapling' },
  { name: 'mangrove', sapling: 'mangrove_propagule' },
  { name: 'cherry', sapling: 'cherry_sapling', leaves: 'cherry' },
];

/** The two Nether fungi, which use stem/hyphae naming instead of log/wood. */
const FUNGI = [{ name: 'crimson' }, { name: 'warped' }];

/** A door leaf: framed planks with a panel, a window on the top half. */
function paintDoor(px, rng, sp, half) {
  const base = sp.planks;
  paintPlanks(px, rng, base, { rows: 4, jitter: 0.1, grain: 0.03 });
  // Hinge stile down the left, rail across the outer edge.
  px.rect(0, 0, 2, S, shade(base, -0.2));
  px.vline(1, 0, S - 1, shade(base, -0.32));
  px.frame(0, 0, S, S, shade(base, -0.3));
  if (half === 'top') {
    px.hline(0, S - 1, 0, shade(base, 0.14));
    // Window: four panes behind a muntin cross.
    px.rect(4, 3, 9, 7, 0x2e3a44);
    px.rect(5, 4, 7, 5, 0x6f96b0);
    px.vline(8, 4, 8, 0x2e3a44);
    px.hline(5, 11, 6, 0x2e3a44);
    px.set(5, 4, 0xa8c8dc); px.set(9, 4, 0xa8c8dc);
    px.frame(4, 3, 9, 7, shade(base, -0.38));
    px.hline(3, 13, 12, shade(base, -0.28));
  } else {
    px.hline(0, S - 1, S - 1, shade(base, -0.34));
    // Raised panel.
    px.rect(4, 2, 9, 12, shade(base, 0.06));
    px.bevel(4, 2, 9, 12, 0.2, 0.24);
    px.frame(3, 1, 11, 14, shade(base, -0.28));
    // Handle.
    px.set(12, 7, 0x3a3a3a); px.set(12, 8, 0x6a6a6a); px.set(13, 8, 0x3a3a3a);
  }
}

/** A trapdoor: three boards with narrow gaps you can see daylight through. */
function paintTrapdoor(px, rng, sp) {
  const base = sp.planks;
  for (let band = 0; band < 3; band++) {
    const y0 = band * 5 + (band > 0 ? 1 : 0);
    const h = band === 1 ? 5 : 5;
    const c = shade(base, (rng.next() - 0.5) * 0.12);
    px.rect(0, y0, S, Math.min(h, S - y0), c);
    for (let k = 0; k < 3; k++) {
      const gy = y0 + rng.int(Math.min(h, S - y0));
      const x0 = rng.int(S), len = 3 + rng.int(7);
      for (let i = 0; i < len; i++) blendw(px, x0 + i, gy, shade(c, -0.16), 0.55);
    }
  }
  // Cross battens.
  px.rect(1, 0, 3, S, shade(base, -0.12));
  px.rect(12, 0, 3, S, shade(base, -0.12));
  px.frame(1, 0, 3, S, shade(base, -0.3));
  px.frame(12, 0, 3, S, shade(base, -0.3));
  // Iron hinges.
  for (const y of [1, 13]) {
    px.rect(1, y, 14, 2, 0x5a5a5a);
    px.set(2, y, 0x8a8a8a); px.set(13, y + 1, 0x2e2e2e);
  }
  px.grain(rng, 0.035);
}

/** A sapling: thin trunk, a bushy crown, alpha everywhere else. */
function paintSapling(px, rng, leafLight, leafDark, trunk = 0x6b5334) {
  for (let y = 9; y < S; y++) {
    px.set(7, y, trunk);
    px.set(8, y, shade(trunk, -0.25));
  }
  const crown = [
    [6, 3, 4, 1], [5, 4, 6, 1], [4, 5, 8, 2], [3, 7, 10, 2],
    [4, 9, 8, 1], [5, 10, 6, 1],
  ];
  for (const [x, y, wd, ht] of crown) {
    for (let j = 0; j < ht; j++) {
      for (let i = 0; i < wd; i++) {
        if (rng.chance(0.14)) continue;
        px.set(x + i, y + j, rng.chance(0.4) ? leafDark : leafLight);
      }
    }
  }
  for (let i = 0; i < 5; i++) {
    const x = 3 + rng.int(10), y = 3 + rng.int(8);
    if (px.getAlpha(x, y)) px.blend(x, y, shade(leafDark, -0.3), 0.6);
  }
}

function registerWood() {
  for (const t of TREES) {
    const sp = P.wood[t.name];
    tex(`${t.name}_planks`, (px, rng) => paintPlanks(px, rng, sp.planks));
    tex(`${t.name}_log`, (px, rng) => paintBark(px, rng, sp, { dashes: t.dashes }));
    tex(`${t.name}_log_top`, (px, rng) => paintLogTop(px, rng, sp));
    tex(`stripped_${t.name}_log`, (px, rng) => paintStripped(px, rng, sp.stripped));
    tex(`stripped_${t.name}_log_top`, (px, rng) =>
      paintLogTop(px, rng, { ...sp, bark: sp.stripped, barkDark: shade(sp.stripped, -0.2) },
        { core: sp.stripped }));

    // Leaves. Species the block registry leaves untinted bake their own hue;
    // the rest stay near-neutral for the foliage multiply.
    const fixed = t.leaves;
    const light = fixed ? P.foliage[fixed] : P.foliage.neutralLight;
    const dark = fixed ? P.foliage[`${fixed}Dark`] : P.foliage.neutralDark;
    tex(`${t.name}_leaves`, (px, rng) => paintLeaves(px, rng, light, dark, {
      holes: t.name === 'spruce' ? 0.34 : 0.29,
      berry: t.name === 'cherry' ? 0xfbd7e4 : null,
    }));
    tex(t.sapling, (px, rng) => paintSapling(px, rng,
      fixed ? light : P.foliage.azalea,
      fixed ? dark : shade(P.foliage.azalea, -0.25),
      sp.bark));

    tex(`${t.name}_door_bottom`, (px, rng) => paintDoor(px, rng, sp, 'bottom'));
    tex(`${t.name}_door_top`, (px, rng) => paintDoor(px, rng, sp, 'top'));
    tex(`${t.name}_trapdoor`, (px, rng) => paintTrapdoor(px, rng, sp));
  }

  // The mangrove propagule hangs from leaves, so it is a dangling shoot.
  tex('mangrove_propagule', (px, rng) => {
    for (let y = 0; y < 6; y++) px.set(8, y, 0x6f8a3a);
    for (let y = 5; y < S; y++) {
      px.set(7, y, 0x8fa84a);
      px.set(8, y, 0x6f8a3a);
    }
    for (const [x, y] of [[6, 4], [9, 4], [5, 6], [10, 6]]) {
      px.set(x, y, 0x4a7a2c); px.set(x, y + 1, 0x5f8f34);
    }
    px.set(8, S - 1, 0x4a6a24);
    px.grain(rng, 0.05);
  });

  for (const f of FUNGI) {
    const sp = P.wood[f.name];
    tex(`${f.name}_planks`, (px, rng) => paintPlanks(px, rng, sp.planks));
    tex(`${f.name}_stem`, (px, rng) => paintBark(px, rng, sp, { knots: 1 }));
    tex(`${f.name}_stem_top`, (px, rng) => paintLogTop(px, rng, sp));
    tex(`stripped_${f.name}_stem`, (px, rng) => paintStripped(px, rng, sp.stripped));
    tex(`stripped_${f.name}_stem_top`, (px, rng) =>
      paintLogTop(px, rng, { ...sp, bark: sp.stripped, barkDark: shade(sp.stripped, -0.2) },
        { core: sp.stripped }));
    tex(`${f.name}_door_bottom`, (px, rng) => paintDoor(px, rng, sp, 'bottom'));
    tex(`${f.name}_door_top`, (px, rng) => paintDoor(px, rng, sp, 'top'));
    tex(`${f.name}_trapdoor`, (px, rng) => paintTrapdoor(px, rng, sp));
  }

  // Azalea leaves are their own species: dense green with flower flecks.
  tex('azalea_leaves', (px, rng) =>
    paintLeaves(px, rng, P.foliage.azalea, shade(P.foliage.azalea, -0.3), { holes: 0.26 }));
  derive('flowering_azalea_leaves', 'azalea_leaves', (px, rng) => {
    for (let i = 0; i < 9; i++) {
      const x = rng.int(S), y = rng.int(S);
      if (!px.getAlpha(x, y)) continue;
      px.set(x, y, P.foliage.azaleaFlower);
      if (rng.chance(0.5)) px.set(w(x + 1), y, shade(P.foliage.azaleaFlower, 0.25));
    }
  });
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function registerBuilding() {
  tex('bricks', (px, rng) => {
    // Staggered red bricks in pale mortar — four courses of two.
    paintBrickCourse(px, rng, 0x9b5a44, 0xb0aca2, { rows: 4, perRow: 2, jitter: 0.14 });
    px.speckle(rng, 18, 0x7d422f, 0.45);
    px.speckle(rng, 10, 0xb4735c, 0.4);
    px.grain(rng, 0.04);
  });

  // --- quartz -------------------------------------------------------------
  const q = P.stone.quartz, qd = P.stone.quartzDark;
  tex('quartz_block_side', (px, rng) => {
    noiseFill(px, rng, q, 0.05, 3, 5);
    px.grain(rng, 0.035);
    px.speckle(rng, 16, qd, 0.35);
    frameBevel(px, 0.1, 0.1);
  });
  derive('quartz_block_top', 'quartz_block_side', (px, rng) => px.speckle(rng, 10, 0xffffff, 0.4));
  derive('quartz_block_bottom', 'quartz_block_side', (px, rng) => { px.scale(0.96); px.speckle(rng, 10, qd, 0.4); });
  tex('quartz_pillar', (px, rng) => {
    noiseFill(px, rng, q, 0.04, 2, 4);
    for (const x of [1, 14]) px.vline(x, 0, S - 1, shade(qd, -0.05));
    px.rect(2, 0, 12, S, shade(q, 0.03));
    px.vline(2, 0, S - 1, shade(q, 0.14));
    px.vline(13, 0, S - 1, shade(qd, -0.02));
    px.grain(rng, 0.03);
  });
  tex('quartz_pillar_top', (px, rng) => {
    noiseFill(px, rng, q, 0.04, 2, 4);
    px.circle(7.5, 7.5, 6.4, shade(q, 0.05));
    px.circle(7.5, 7.5, 6.4, qd, 255, false);
    px.circle(7.5, 7.5, 3.2, qd, 255, false);
    px.grain(rng, 0.03);
  });
  tex('chiseled_quartz_block', (px, rng) => {
    noiseFill(px, rng, q, 0.04, 2, 4);
    px.frame(0, 0, S, S, qd);
    px.rect(2, 2, 12, 12, shade(q, 0.04));
    px.bevel(2, 2, 12, 12, 0.18, 0.2);
    for (const x of [4, 7, 10]) px.vline(x, 4, 11, shade(qd, -0.06));
    for (const x of [5, 8, 11]) px.vline(x, 4, 11, shade(q, 0.12));
    px.grain(rng, 0.028);
  });
  derive('chiseled_quartz_block_top', 'chiseled_quartz_block', (px) => px.rotate(1));
  tex('quartz_bricks', (px, rng) => {
    paintBrickCourse(px, rng, q, qd, { rows: 2, perRow: 2, jitter: 0.05 });
    px.grain(rng, 0.03);
  });

  // --- glass --------------------------------------------------------------
  tex('glass', (px, rng) => paintGlass(px, rng, P.misc.glass, 30, { edge: P.misc.glassEdge }));
  tex('tinted_glass', (px, rng) => {
    paintGlass(px, rng, P.misc.tintedGlass, 190, { edge: 0x6f5f6c, edgeAlpha: 230 });
    px.grain(rng, 0.03);
  });

  // --- organic building blocks -------------------------------------------
  tex('hay_block_side', (px, rng) => {
    noiseFill(px, rng, P.plant.hay, 0.1, 3, 6);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) if (rng.chance(0.3)) px.shadePixel(x, y, -0.12);
    }
    // Baling twine.
    for (const x of [3, 12]) {
      px.vline(x, 0, S - 1, 0x6f5a12);
      px.vline(x + 1, 0, S - 1, 0xa08c2a);
    }
    px.hline(0, S - 1, 0, shade(P.plant.hay, 0.16));
    px.hline(0, S - 1, S - 1, P.plant.hayDark);
    px.grain(rng, 0.06);
  });
  tex('hay_block_top', (px, rng) => {
    noiseFill(px, rng, P.plant.hay, 0.09, 3, 5);
    // Cut stalk ends.
    for (let i = 0; i < 40; i++) {
      const x = rng.int(S), y = rng.int(S);
      px.set(x, y, rng.chance(0.5) ? P.plant.hayDark : shade(P.plant.hay, 0.2));
    }
    px.grain(rng, 0.07);
    frameBevel(px, 0.08, 0.12);
  });
  tex('bone_block_side', (px, rng) => {
    noiseFill(px, rng, P.misc.bone, 0.05, 2, 4);
    for (const x of [2, 5, 10, 13]) px.vline(x, 0, S - 1, P.misc.boneDark);
    for (const x of [3, 11]) px.vline(x, 0, S - 1, 0xf4f2e4);
    px.hline(0, S - 1, 0, P.misc.boneDark);
    px.hline(0, S - 1, S - 1, P.misc.boneDark);
    px.grain(rng, 0.035);
  });
  tex('bone_block_top', (px, rng) => {
    noiseFill(px, rng, P.misc.bone, 0.05, 2, 4);
    px.circle(7.5, 7.5, 5.6, P.misc.boneDark);
    px.circle(7.5, 7.5, 4.4, shade(P.misc.bone, 0.05));
    px.circle(7.5, 7.5, 2.2, 0x9a9482);
    px.grain(rng, 0.035);
  });
  tex('honeycomb_block', (px, rng) => {
    noiseFill(px, rng, P.plant.honeycomb, 0.07, 2, 4);
    // A hex-ish cell grid drawn as offset rounded squares.
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 3; col++) {
        const cx = col * 6 + (row % 2) * 3 + 2, cy = row * 4 + 2;
        for (let y = -2; y <= 2; y++) {
          for (let x = -2; x <= 2; x++) {
            if (Math.abs(x) + Math.abs(y) > 3) continue;
            setw(px, cx + x, cy + y, Math.abs(x) + Math.abs(y) === 3
              ? shade(P.plant.honeycomb, -0.3) : shade(P.plant.honeycomb, 0.12));
          }
        }
      }
    }
    px.grain(rng, 0.04);
  });
  tex('honey_block', (px, rng) => {
    // Translucent amber with a bright rim.
    px.rect(0, 0, S, S, P.plant.honey, 205);
    noiseOverlay(px, rng, 0xffd35c, 0.5, 4, 0.6);
    px.frame(0, 0, S, S, 0xffdf8a, 235);
    px.frame(1, 1, 14, 14, 0xc88a12, 200);
    px.line(3, 6, 6, 3, 0xfff0b8, 220);
    px.grain(rng, 0.03);
  });
  tex('slime_block', (px, rng) => {
    px.rect(0, 0, S, S, P.plant.slime, 190);
    noiseOverlay(px, rng, 0x9fdd86, 0.48, 4, 0.7);
    px.frame(0, 0, S, S, 0x8fd07a, 225);
    px.frame(3, 3, 10, 10, 0x5c9a48, 150);
    // The little slime core.
    px.rect(6, 6, 4, 4, 0x4f8a3c, 210);
    px.line(4, 7, 6, 5, 0xd8f5c8, 200);
    px.grain(rng, 0.03);
  });
  tex('sponge', (px, rng) => {
    noiseFill(px, rng, P.plant.sponge, 0.14, 3, 5);
    // Pores.
    for (let i = 0; i < 22; i++) {
      const x = rng.int(S), y = rng.int(S);
      px.set(x, y, shade(P.plant.sponge, -0.4));
      if (rng.chance(0.4)) px.set(w(x + 1), y, shade(P.plant.sponge, -0.25));
    }
    px.grain(rng, 0.08);
  });
  derive('wet_sponge', 'sponge', (px, rng) => {
    px.tint(0x93a06a, 0.7);
    px.scale(0.88);
    px.speckle(rng, 10, 0x4f5c2a, 0.6);
  });
  tex('cobweb', (px, rng) => {
    // Radial silk from the centre plus two connecting rings.
    const c = P.plant.cobweb;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      px.line(8, 8, Math.round(8 + Math.cos(a) * 8), Math.round(8 + Math.sin(a) * 8), c, 235);
    }
    for (const r of [3.2, 6.0]) {
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * Math.PI * 2;
        px.set(Math.round(8 + Math.cos(a) * r), Math.round(8 + Math.sin(a) * r), c, 190);
      }
    }
    px.set(8, 8, c, 255);
    px.speckle(rng, 6, c, 0.4);
  });

  // --- metalwork ----------------------------------------------------------
  tex('iron_bars', (px, rng) => {
    paintBars(px, rng, P.misc.iron, { cols: [6, 7, 8, 9] });
    px.hline(6, 9, 0, P.misc.ironLight);
    px.hline(6, 9, S - 1, P.misc.ironDark);
  });
  tex('chain', (px, rng) => {
    // Alternating links seen edge-on and face-on.
    for (let y = 0; y < S; y++) {
      const link = (y >> 2) % 2 === 0;
      if (link) {
        px.set(6, y, P.misc.chain); px.set(9, y, shade(P.misc.chain, -0.3));
        px.set(7, y, shade(P.misc.chain, 0.25)); px.set(8, y, P.misc.chain);
      } else {
        px.set(7, y, shade(P.misc.chain, 0.2)); px.set(8, y, shade(P.misc.chain, -0.2));
      }
    }
    for (const y of [3, 7, 11, 15]) { px.set(6, y, 0x2e3238); px.set(9, y, 0x2e3238); }
    px.grain(rng, 0.05);
  });
  tex('ladder', (px, rng) => {
    const rail = 0x8a6a3a;
    for (const x of [2, 3, 12, 13]) {
      for (let y = 0; y < S; y++) px.set(x, y, x % 2 === 0 ? rail : shade(rail, -0.28));
    }
    for (const y of [1, 6, 11]) {
      px.rect(4, y, 8, 2, shade(rail, 0.12));
      px.hline(4, 11, y + 1, shade(rail, -0.2));
    }
    px.grain(rng, 0.05);
  });
  tex('scaffolding_top', (px, rng) => {
    px.fill(P.misc.scaffold);
    px.rect(2, 2, 12, 12, 0, 0);
    px.rect(4, 4, 8, 8, P.misc.scaffold);
    px.rect(5, 5, 6, 6, 0, 0);
    px.frame(0, 0, S, S, shade(P.misc.scaffold, -0.28));
    px.grain(rng, 0.05);
  });
  tex('scaffolding_side', (px, rng) => {
    for (const x of [0, 1, 14, 15]) {
      for (let y = 0; y < S; y++) px.set(x, y, x % 2 ? shade(P.misc.scaffold, -0.25) : P.misc.scaffold);
    }
    px.rect(0, 0, S, 2, P.misc.scaffold);
    px.rect(0, 14, S, 2, shade(P.misc.scaffold, -0.15));
    for (let y = 3; y < 13; y += 4) px.hline(2, 13, y, P.misc.scaffoldRope);
    px.grain(rng, 0.05);
  });
  tex('scaffolding_bottom', (px, rng) => {
    px.fill(shade(P.misc.scaffold, -0.14));
    for (const g of [3, 7, 11]) {
      px.hline(0, S - 1, g, P.misc.scaffoldRope);
      px.vline(g, 0, S - 1, P.misc.scaffoldRope);
    }
    px.frame(0, 0, S, S, shade(P.misc.scaffold, -0.32));
    px.grain(rng, 0.05);
  });

  // --- dried kelp ---------------------------------------------------------
  tex('dried_kelp_side', (px, rng) => {
    noiseFill(px, rng, P.plant.driedKelp, 0.16, 3, 5);
    for (let y = 2; y < S; y += 4) px.hline(0, S - 1, y, shade(P.plant.driedKelp, -0.3));
    px.speckle(rng, 16, 0x5a6f3a, 0.4);
    px.grain(rng, 0.07);
  });
  tex('dried_kelp_top', (px, rng) => {
    noiseFill(px, rng, shade(P.plant.driedKelp, 0.1), 0.14, 3, 5);
    px.speckle(rng, 24, 0x2a3620, 0.5);
    px.grain(rng, 0.08);
  });
  derive('dried_kelp_bottom', 'dried_kelp_top', (px) => px.scale(0.85));
}

// ---------------------------------------------------------------------------
// The sixteen dyed families
// ---------------------------------------------------------------------------

/** Wool: soft fibres, so noise at two scales and no hard edges anywhere. */
function paintWool(px, rng, base) {
  noiseFill(px, rng, base, 0.1, 3, 6);
  px.grain(rng, 0.075);
  // Tufts: 2x2 clumps a shade lighter or darker, the vanilla wool signature.
  for (let i = 0; i < 16; i++) {
    const x = rng.int(S), y = rng.int(S);
    const c = rng.chance(0.5) ? shade(base, 0.16) : shade(base, -0.16);
    setw(px, x, y, c);
    if (rng.chance(0.6)) setw(px, x + 1, y, c);
    if (rng.chance(0.6)) setw(px, x, y + 1, c);
  }
  px.speckle(rng, 12, shade(base, -0.26), 0.4);
}

/** Concrete: dead flat. Only the faintest grain, or it stops reading as cast. */
function paintConcrete(px, rng, base) {
  noiseFill(px, rng, base, 0.028, 2, 4);
  px.grain(rng, 0.022);
  px.speckle(rng, 8, shade(base, -0.1), 0.25);
}

/** Concrete powder: the same pigment, loose and granular. */
function paintConcretePowder(px, rng, base) {
  noiseFill(px, rng, base, 0.07, 3, 6);
  px.grain(rng, 0.085);
  px.speckle(rng, 22, shade(base, -0.16), 0.45);
  px.speckle(rng, 16, shade(base, 0.16), 0.4);
}

/** Terracotta: fired clay, so broad tonal swirls rather than pixel noise. */
function paintTerracotta(px, rng, base) {
  noiseFill(px, rng, base, 0.13, 3, 3);
  noiseOverlay(px, rng, shade(base, -0.2), 0.58, 4, 0.7);
  noiseOverlay(px, rng, shade(base, 0.16), 0.62, 6, 0.5);
  px.grain(rng, 0.045);
  px.speckle(rng, 10, shade(base, -0.3), 0.35);
}

/** Glazed terracotta: a hard glaze pattern over a pale slip. */
function paintGlazed(px, rng, base, variant) {
  const slip = mixHex(base, 0xffffff, 0.5);
  const ink = shade(base, -0.4);
  px.fill(slip);
  px.frame(0, 0, S, S, ink);
  px.frame(1, 1, 14, 14, base);
  switch (variant % 4) {
    case 0:
      for (let i = 0; i < S; i++) {
        px.set(i, i, base); setw(px, i, i + 1, base); setw(px, i + 1, i, ink);
        setw(px, i, i + 8, base);
      }
      break;
    case 1:
      px.circle(2, 2, 6, base, 255, false);
      px.circle(13, 13, 6, base, 255, false);
      px.circle(2, 2, 4, ink, 255, false);
      px.circle(13, 13, 4, ink, 255, false);
      break;
    case 2:
      px.rect(2, 2, 5, 5, base); px.rect(9, 9, 5, 5, base);
      px.rect(9, 2, 5, 5, ink); px.rect(2, 9, 5, 5, ink);
      px.rect(6, 6, 4, 4, mixHex(base, 0xffffff, 0.3));
      break;
    default:
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
          if (d > 4.5 && d < 6.6) px.set(x, y, base);
          else if (d < 2.6) px.set(x, y, ink);
        }
      }
      break;
  }
  px.grain(rng, 0.02);
}

/** A shulker shell: domed lid over a ridged body. */
function paintShulker(px, rng, base) {
  const dark = shade(base, -0.32), light = shade(base, 0.2);
  px.fill(base);
  px.rect(0, 0, S, 6, light);           // lid
  px.hline(0, S - 1, 6, dark);          // seam
  px.rect(0, 7, S, 9, base);
  for (const x of [2, 6, 10, 14]) px.vline(x, 7, S - 1, dark);
  for (const x of [3, 7, 11, 15]) px.vline(x, 7, S - 1, light);
  px.frame(0, 0, S, S, dark);
  px.rect(6, 1, 4, 4, dark);            // the little face plate
  px.rect(7, 2, 2, 2, light);
  px.grain(rng, 0.04);
}

/** A bed seen from above: pillow at the head, blanket over a wooden frame. */
function paintBed(px, rng, base) {
  px.fill(shade(base, -0.1));
  px.rect(0, 0, S, 5, 0xe8e8e8);        // pillow
  px.frame(0, 0, S, 5, 0xc8c8c8);
  px.rect(0, 5, S, 11, base);
  px.hline(0, S - 1, 5, shade(base, 0.22));
  px.hline(0, S - 1, S - 1, shade(base, -0.34));
  for (const x of [0, S - 1]) px.vline(x, 5, S - 1, shade(base, -0.24));
  // Quilting.
  for (let y = 8; y < S; y += 3) {
    for (let x = 1; x < S - 1; x += 3) px.blend(x, y, shade(base, -0.18), 0.55);
  }
  px.grain(rng, 0.04);
}

/** A candle stub with a wick; the lit form gets a flame and a warm glow. */
function paintCandle(px, rng, base, lit) {
  const top = 6;
  for (let y = top; y < S; y++) {
    px.set(7, y, shade(base, 0.18));
    px.set(8, y, base);
    px.set(9, y, shade(base, -0.22));
  }
  px.set(7, top, shade(base, 0.3));
  px.set(8, top, shade(base, 0.24));
  px.set(8, top - 1, 0x3a3028);           // wick
  if (lit) {
    px.set(8, top - 2, P.misc.torchFlame);
    px.set(8, top - 3, 0xffd45c);
    px.set(7, top - 2, 0xff9a2a, 190);
    px.set(9, top - 2, 0xff9a2a, 190);
    px.set(8, top - 4, 0xfff2c0, 200);
    for (let y = top; y < top + 3; y++) px.shadePixel(8, y, 0.2);
  }
  px.grain(rng, 0.03);
}

function registerColored() {
  DYE_ORDER.forEach((color, i) => {
    tex(`${color}_wool`, (px, rng) => paintWool(px, rng, P.wool[color]));
    tex(`${color}_concrete`, (px, rng) => paintConcrete(px, rng, P.concrete[color]));
    tex(`${color}_concrete_powder`, (px, rng) => paintConcretePowder(px, rng, P.concretePowder[color]));
    tex(`${color}_terracotta`, (px, rng) => paintTerracotta(px, rng, P.terracotta[color]));
    tex(`${color}_glazed_terracotta`, (px, rng) => paintGlazed(px, rng, P.glaze[color], i));
    tex(`${color}_stained_glass`, (px, rng) =>
      paintGlass(px, rng, P.stainedGlass[color], 118, {
        edge: shade(P.stainedGlass[color], 0.4), edgeAlpha: 200,
      }));
    tex(`${color}_shulker_box`, (px, rng) => paintShulker(px, rng, P.shulker[color]));
    tex(`${color}_bed`, (px, rng) => paintBed(px, rng, P.wool[color]));
    tex(`${color}_candle`, (px, rng) => paintCandle(px, rng, P.wool[color], false));
    tex(`${color}_candle_lit`, (px, rng) => paintCandle(px, rng, P.wool[color], true));
  });

  // The undyed members of each family.
  tex('terracotta', (px, rng) => paintTerracotta(px, rng, 0x975d43));
  tex('shulker_box', (px, rng) => paintShulker(px, rng, 0x9a6f9a));
  tex('candle', (px, rng) => paintCandle(px, rng, 0xe4dcc0, false));
  tex('candle_lit', (px, rng) => paintCandle(px, rng, 0xe4dcc0, true));
}

// ---------------------------------------------------------------------------
// Plants
// ---------------------------------------------------------------------------

/** Draw a flower head of one of a few stock shapes at the top of a stem. */
function drawHead(px, rng, cx, o) {
  const petal = o.petal, core = o.core ?? null, edge = o.edge ?? shade(petal, -0.28);
  const cy = o.headY ?? 5;
  switch (o.shape) {
    case 'pom':
      flowerHead(px, rng, cx, cy, o.r ?? 2.8, petal, core, edge);
      break;
    case 'cup':
      // Tulip: a closed bud on a straight stalk.
      px.rect(cx - 2, cy, 5, 4, petal);
      px.set(cx - 2, cy, edge); px.set(cx + 2, cy, edge);
      px.hline(cx - 2, cx + 2, cy + 4, edge);
      px.set(cx - 1, cy - 1, petal); px.set(cx + 1, cy - 1, petal);
      px.set(cx, cy - 2, petal);
      px.vline(cx - 1, cy + 1, cy + 3, shade(petal, 0.22));
      break;
    case 'daisy':
      for (const [dx, dy] of [[0, -2], [0, 2], [-2, 0], [2, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        px.set(cx + dx, cy + dy, petal);
      }
      px.set(cx, cy, core ?? petal);
      px.set(cx - 2, cy - 2, edge); px.set(cx + 2, cy + 2, edge);
      break;
    case 'cluster':
      for (let i = 0; i < (o.count ?? 7); i++) {
        const x = cx + rng.int(5) - 2, y = cy + rng.int(5) - 2;
        px.set(x, y, rng.chance(0.3) ? edge : petal);
      }
      if (core != null) px.set(cx, cy, core);
      break;
    case 'bells':
      for (const [dx, dy] of [[-2, 3], [2, 5], [-1, 7], [2, 9]]) {
        px.set(cx + dx, cy + dy, petal);
        px.set(cx + dx, cy + dy + 1, shade(petal, -0.15));
      }
      break;
    default:
      flowerHead(px, rng, cx, cy, 2.4, petal, core, edge);
  }
}

/** Register a cross-model flower. */
function flowerTex(name, o) {
  tex(name, (px, rng) => {
    crossPlant(px, rng, {
      stem: o.stem ?? P.plant.stem,
      stemDark: o.stemDark ?? P.plant.stemDark,
      base: o.base ?? 15,
      top: o.stemTop ?? 7,
      leaves: o.leafPairs ?? 2,
      draw: (p, r, cx) => drawHead(p, r, cx, o),
    });
    px.grain(rng, 0.035);
  });
}

/** Blades of grass rising from the bottom edge. */
function paintBlades(px, rng, light, dark, opts = {}) {
  const count = opts.count ?? 9;
  const minH = opts.minH ?? 5, maxH = opts.maxH ?? 12;
  for (let i = 0; i < count; i++) {
    let x = 1 + rng.int(S - 2);
    const h = minH + rng.int(maxH - minH + 1);
    const lean = rng.chance(0.5) ? 1 : -1;
    for (let k = 0; k < h; k++) {
      const y = S - 1 - k;
      const c = k > h - 3 ? light : mixHex(dark, light, k / h);
      setw(px, x, y, c);
      if (k < 2 && opts.thick !== false) setw(px, x + 1, y, dark);
      if (k > h * 0.55 && rng.chance(0.4)) x += lean;
    }
  }
  if (opts.floor) for (let x = 0; x < S; x++) px.set(x, S - 1, dark);
}

/** Hanging strands from the top edge — vines, roots, weeping growth. */
function paintHanging(px, rng, light, dark, opts = {}) {
  const count = opts.count ?? 8;
  for (let i = 0; i < count; i++) {
    let x = rng.int(S);
    const h = (opts.minH ?? 6) + rng.int((opts.maxH ?? 14) - (opts.minH ?? 6) + 1);
    for (let y = 0; y < h; y++) {
      setw(px, x, y, y > h - 3 ? dark : light);
      if (opts.wide && rng.chance(0.4)) setw(px, x + 1, y, dark);
      if (rng.chance(0.18)) x += rng.chance(0.5) ? 1 : -1;
    }
  }
  if (opts.cap) for (let x = 0; x < S; x++) px.set(x, 0, light);
}

function registerPlants() {
  const F = P.flower;
  flowerTex('dandelion', { petal: F.dandelion, core: 0xfff8b0, shape: 'cluster', count: 9, headY: 5 });
  flowerTex('poppy', { petal: F.poppy, core: 0x2e1a12, shape: 'pom', r: 2.4, headY: 5 });
  flowerTex('blue_orchid', { petal: F.blueOrchid, core: 0xd8f4ff, shape: 'cluster', count: 8, headY: 5 });
  flowerTex('allium', { petal: F.allium, core: 0xd8b0f5, shape: 'pom', r: 2.6, headY: 5 });
  flowerTex('azure_bluet', { petal: F.azureBluet, core: F.azureBluetCore, shape: 'cluster', count: 8, headY: 5 });
  flowerTex('red_tulip', { petal: F.redTulip, shape: 'cup', headY: 4, leafPairs: 3 });
  flowerTex('orange_tulip', { petal: F.orangeTulip, shape: 'cup', headY: 4, leafPairs: 3 });
  flowerTex('white_tulip', { petal: F.whiteTulip, shape: 'cup', headY: 4, leafPairs: 3 });
  flowerTex('pink_tulip', { petal: F.pinkTulip, shape: 'cup', headY: 4, leafPairs: 3 });
  flowerTex('oxeye_daisy', { petal: F.oxeye, core: F.oxeyeCore, shape: 'daisy', headY: 5 });
  flowerTex('cornflower', { petal: F.cornflower, core: 0x8fa8f0, shape: 'cluster', count: 10, headY: 5 });
  flowerTex('lily_of_the_valley', { petal: F.lilyOfTheValley, shape: 'bells', headY: 2, stemTop: 3 });
  flowerTex('wither_rose', {
    petal: F.witherRose, core: 0x4a4046, shape: 'pom', r: 2.4, headY: 5,
    stem: F.witherRoseStem, stemDark: 0x191517,
  });
  flowerTex('torchflower', {
    petal: F.torchflower, core: F.torchflowerCore, shape: 'pom', r: 2.6, headY: 5,
  });
  tex('spore_blossom', (px, rng) => {
    // Seen from below: a big pink bloom with spore strands trailing off it.
    px.circle(7.5, 7.5, 5.2, F.pitcher);
    px.circle(7.5, 7.5, 4.2, P.plant.sporeBlossom);
    px.circle(7.5, 7.5, 2.0, 0xf0a8cf);
    px.circle(7.5, 7.5, 0.9, 0xffe0f0);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      px.line(8, 8, Math.round(8 + Math.cos(a) * 6), Math.round(8 + Math.sin(a) * 6),
        shade(P.plant.sporeBlossom, -0.2));
    }
    for (let i = 0; i < 6; i++) {
      const x = rng.int(S), y = rng.int(S);
      if (Math.hypot(x - 7.5, y - 7.5) < 5.5) continue;
      px.set(x, y, 0x6f9c4a);
    }
    px.grain(rng, 0.04);
  });

  // --- tall two-block flowers --------------------------------------------
  tex('sunflower_bottom', (px, rng) => {
    paintBlades(px, rng, P.plant.stem, P.plant.stemDark, { count: 3, minH: 14, maxH: 16, thick: false });
    for (let y = 0; y < S; y++) { px.set(7, y, P.plant.stem); px.set(8, y, P.plant.stemDark); }
    for (const [x, y] of [[5, 6], [10, 9], [4, 11]]) {
      px.set(x, y, P.plant.stem); px.set(x, y + 1, P.plant.stemDark);
      px.set(x + (x < 8 ? 1 : -1), y, P.plant.stem);
    }
  });
  tex('sunflower_top', (px, rng) => {
    for (let y = 8; y < S; y++) { px.set(7, y, P.plant.stem); px.set(8, y, P.plant.stemDark); }
    px.circle(7.5, 6, 5.4, F.sunflower);
    px.circle(7.5, 6, 3.4, F.sunflowerCore);
    px.circle(7.5, 6, 2.0, 0x8f5f10);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      px.set(Math.round(7.5 + Math.cos(a) * 6), Math.round(6 + Math.sin(a) * 6), F.sunflower);
    }
    px.grain(rng, 0.035);
  });
  const tallFlowers = [
    ['lilac', F.lilac, 0xb086bd],
    ['rose_bush', F.roseBush, 0x8f2424],
    ['peony', F.peony, 0xc79ac7],
  ];
  for (const [name, petal, deep] of tallFlowers) {
    tex(`${name}_bottom`, (px, rng) => {
      paintBlades(px, rng, P.plant.stem, P.plant.stemDark, { count: 4, minH: 12, maxH: 16, thick: false });
      for (let y = 2; y < S; y++) { px.set(7, y, P.plant.stem); px.set(8, y, P.plant.stemDark); }
      for (const [x, y] of [[4, 5], [11, 8], [5, 11]]) {
        for (let k = 0; k < 3; k++) px.set(x + (x < 8 ? k : -k), y + (k > 1 ? 1 : 0), k === 2 ? P.plant.stemDark : P.plant.stem);
      }
    });
    tex(`${name}_top`, (px, rng) => {
      for (let y = 9; y < S; y++) { px.set(7, y, P.plant.stem); px.set(8, y, P.plant.stemDark); }
      for (let i = 0; i < 26; i++) {
        const x = 3 + rng.int(10), y = 2 + rng.int(8);
        px.set(x, y, rng.chance(0.35) ? deep : petal);
      }
      for (let i = 0; i < 7; i++) px.set(3 + rng.int(10), 8 + rng.int(3), P.plant.stemDark);
      px.grain(rng, 0.04);
    });
  }
  tex('pitcher_plant_bottom', (px, rng) => {
    paintBlades(px, rng, 0x4a7a3a, 0x33582a, { count: 5, minH: 11, maxH: 16 });
    for (let y = 4; y < S; y++) { px.set(7, y, 0x5f8f44); px.set(8, y, 0x44703a); }
    px.grain(rng, 0.04);
  });
  tex('pitcher_plant_top', (px, rng) => {
    for (let y = 8; y < S; y++) { px.set(7, y, 0x5f8f44); px.set(8, y, 0x44703a); }
    // Two pitchers.
    for (const [cx, top] of [[4, 3], [11, 5]]) {
      for (let y = top; y < top + 7; y++) {
        for (let x = cx - 2; x <= cx + 2; x++) {
          px.set(x, y, x === cx - 2 ? shade(F.pitcher, 0.2) : x === cx + 2 ? shade(F.pitcher, -0.25) : F.pitcher);
        }
      }
      px.hline(cx - 2, cx + 2, top, 0xd8b0f0);
      px.set(cx, top + 3, 0x4a2a6a);
    }
    px.grain(rng, 0.04);
  });

  // --- grasses and ferns --------------------------------------------------
  tex('short_grass', (px, rng) =>
    paintBlades(px, rng, P.grass.neutral, P.grass.neutralDark, { count: 10, minH: 5, maxH: 11 }));
  tex('fern', (px, rng) => {
    // A fern is a frond: a central rib with paired pinnae.
    for (let y = 4; y < S; y++) px.set(8, y, P.grass.neutralDark);
    for (let y = 4; y < S - 1; y += 2) {
      const spread = Math.round(((y - 3) / 12) * 5) + 1;
      for (let k = 1; k <= spread; k++) {
        px.set(8 - k, y, P.grass.neutral);
        px.set(8 + k, y + 1, P.grass.neutral);
      }
    }
    px.set(8, 3, P.grass.neutral);
    px.grain(rng, 0.04);
  });
  tex('tall_grass_bottom', (px, rng) =>
    paintBlades(px, rng, P.grass.neutral, P.grass.neutralDark, { count: 9, minH: 12, maxH: 16 }));
  tex('tall_grass_top', (px, rng) => {
    paintBlades(px, rng, P.grass.neutral, P.grass.neutralDark, { count: 8, minH: 8, maxH: 15 });
    // Nothing should touch the bottom edge — that is where the lower half is.
    for (let x = 0; x < S; x++) px.set(x, S - 1, 0, 0);
  });
  derive('large_fern_bottom', 'fern', (px, rng) => {
    for (let y = 0; y < 4; y++) for (let x = 6; x < 11; x++) if (rng.chance(0.5)) px.set(x, y, P.grass.neutralDark);
  });
  tex('large_fern_top', (px, rng) => {
    for (let y = 2; y < S; y++) px.set(8, y, P.grass.neutralDark);
    for (let y = 2; y < S - 1; y += 2) {
      const spread = Math.round(((S - y) / 14) * 5) + 1;
      for (let k = 1; k <= spread; k++) {
        px.set(8 - k, y, P.grass.neutral);
        px.set(8 + k, y + 1, P.grass.neutral);
      }
    }
    px.grain(rng, 0.04);
  });
  tex('dead_bush', (px, rng) => {
    for (let i = 0; i < 7; i++) {
      let x = 4 + rng.int(8), y = S - 1;
      const h = 6 + rng.int(8);
      for (let k = 0; k < h; k++) {
        setw(px, x, y, k > h - 3 ? shade(P.plant.deadBush, 0.2) : P.plant.deadBush);
        y--;
        if (rng.chance(0.45)) x += rng.chance(0.5) ? 1 : -1;
      }
    }
    px.grain(rng, 0.06);
  });

  // --- water plants -------------------------------------------------------
  tex('seagrass', (px, rng) =>
    paintBlades(px, rng, P.plant.seagrass, shade(P.plant.seagrass, -0.3), { count: 8, minH: 7, maxH: 14 }));
  tex('tall_seagrass_bottom', (px, rng) =>
    paintBlades(px, rng, P.plant.seagrass, shade(P.plant.seagrass, -0.3), { count: 7, minH: 13, maxH: 16 }));
  tex('tall_seagrass_top', (px, rng) => {
    paintBlades(px, rng, P.plant.seagrass, shade(P.plant.seagrass, -0.3), { count: 7, minH: 9, maxH: 16 });
    for (let x = 0; x < S; x++) px.set(x, S - 1, 0, 0);
  });
  tex('kelp', (px, rng) => {
    for (let y = 0; y < S; y++) {
      const x = 7 + Math.round(Math.sin(y * 0.5) * 1.6);
      px.set(x, y, P.plant.kelp);
      px.set(w(x + 1), y, P.plant.kelpDark);
      if (y % 3 === 0) {
        const dir = rng.chance(0.5) ? -1 : 1;
        for (let k = 1; k <= 3; k++) setw(px, x + dir * k, y + (k > 1 ? 1 : 0), P.plant.kelp);
      }
    }
    px.grain(rng, 0.05);
  });
  derive('kelp_plant', 'kelp', (px, rng) => {
    // The stem-only section: fewer fronds.
    for (let i = 0; i < 8; i++) {
      const x = rng.int(S), y = rng.int(S);
      if (Math.abs(x - 7) > 2) px.set(x, y, 0, 0);
    }
  });
  tex('lily_pad', (px, rng) => {
    // A round pad with a notch cut out of one side.
    px.circle(7.5, 7.5, 7.2, P.plant.lilyPad);
    px.circle(7.5, 7.5, 7.2, shade(P.plant.lilyPad, -0.28), 255, false);
    for (let y = 8; y < S; y++) {
      for (let x = 7; x < 10; x++) if (Math.abs(x - 8) <= (y - 8) / 3) px.set(x, y, 0, 0);
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      px.line(8, 8, Math.round(8 + Math.cos(a) * 6), Math.round(8 + Math.sin(a) * 6),
        shade(P.plant.lilyPad, -0.16));
    }
    px.grain(rng, 0.05);
  });

  // --- vines and climbers -------------------------------------------------
  tex('vine', (px, rng) =>
    paintHanging(px, rng, P.foliage.neutral, P.foliage.neutralDark,
      { count: 7, minH: 8, maxH: 16, wide: true, cap: true }));
  tex('glow_lichen', (px, rng) => {
    for (let i = 0; i < 13; i++) {
      let x = rng.int(S), y = rng.int(S);
      for (let k = 0; k < 4 + rng.int(6); k++) {
        setw(px, x, y, rng.chance(0.3) ? shade(P.plant.glowLichen, 0.3) : P.plant.glowLichen);
        x += rng.int(3) - 1; y += rng.int(3) - 1;
      }
    }
  });
  tex('hanging_roots', (px, rng) =>
    paintHanging(px, rng, P.plant.root, shade(P.plant.root, -0.3), { count: 9, minH: 4, maxH: 11, cap: true }));
  tex('cave_vines', (px, rng) => {
    paintHanging(px, rng, 0x5f7a3a, 0x445a28, { count: 6, minH: 8, maxH: 16, wide: true, cap: true });
    for (let i = 0; i < 5; i++) {
      const x = rng.int(S), y = 4 + rng.int(11);
      if (!px.getAlpha(x, y)) continue;
      px.set(x, y, P.plant.glowBerry);
      px.set(w(x + 1), y, shade(P.plant.glowBerry, -0.25));
      px.set(x, w(y + 1), 0xd88a2a);
    }
  });
  derive('cave_vines_plant', 'cave_vines', (px, rng) => {
    px.speckle(rng, 5, 0x445a28, 0.5);
  });
  tex('twisting_vines', (px, rng) => {
    for (let y = 0; y < S; y++) {
      const x = 7 + Math.round(Math.sin(y * 0.7) * 2.2);
      px.set(x, y, 0x2f8a7c);
      px.set(w(x + 1), y, 0x1e6155);
      if (y % 4 === 0) { px.set(w(x - 1), y, 0x3fae9c); px.set(w(x + 2), y, 0x1e6155); }
    }
    px.grain(rng, 0.05);
  });
  derive('twisting_vines_plant', 'twisting_vines', (px, rng) => px.speckle(rng, 6, 0x1e6155, 0.5));
  tex('weeping_vines', (px, rng) =>
    paintHanging(px, rng, 0xa8342a, 0x6f1d18, { count: 7, minH: 7, maxH: 16, wide: true, cap: true }));
  derive('weeping_vines_plant', 'weeping_vines', (px, rng) => px.speckle(rng, 6, 0x6f1d18, 0.5));
  tex('nether_sprouts', (px, rng) =>
    paintBlades(px, rng, 0x2fa8a0, 0x1c7a74, { count: 11, minH: 4, maxH: 9 }));
  tex('crimson_roots', (px, rng) =>
    paintBlades(px, rng, 0xa8244a, 0x6f1530, { count: 9, minH: 4, maxH: 10 }));
  tex('warped_roots', (px, rng) =>
    paintBlades(px, rng, 0x2fb0a0, 0x1c7a70, { count: 9, minH: 4, maxH: 10 }));

  // --- fungi --------------------------------------------------------------
  const mushroom = (name, cap, stem, spots) => tex(name, (px, rng) => {
    // Stalk.
    for (let y = 9; y < S; y++) { px.set(7, y, stem); px.set(8, y, shade(stem, -0.2)); }
    px.hline(6, 9, S - 1, shade(stem, -0.3));
    // Cap.
    for (let y = 4; y <= 9; y++) {
      const half = y < 6 ? 3 : y < 8 ? 5 : 4;
      for (let x = 7 - half; x <= 8 + half - 1; x++) {
        px.set(x, y, y === 9 ? shade(cap, -0.35) : x < 7 ? shade(cap, 0.14) : cap);
      }
    }
    if (spots) {
      for (const [x, y] of [[5, 6], [10, 6], [7, 5], [4, 8], [11, 8]]) px.set(x, y, spots);
    }
    px.grain(rng, 0.04);
  });
  mushroom('brown_mushroom', P.plant.mushroomBrown, 0xc8b8a0, null);
  mushroom('red_mushroom', P.plant.mushroomRed, 0xd8d0c0, 0xf0ece0);

  tex('brown_mushroom_block', (px, rng) => {
    noiseFill(px, rng, P.plant.mushroomBrown, 0.12, 3, 4);
    px.grain(rng, 0.06);
    px.speckle(rng, 20, shade(P.plant.mushroomBrown, -0.28), 0.5);
    px.speckle(rng, 10, shade(P.plant.mushroomBrown, 0.2), 0.4);
  });
  tex('red_mushroom_block', (px, rng) => {
    noiseFill(px, rng, P.plant.mushroomRed, 0.09, 3, 4);
    // The vanilla white spot pattern.
    for (const [cx, cy, r] of [[4, 4, 2.4], [11, 5, 1.8], [7, 10, 2.6], [13, 12, 1.6], [2, 11, 1.6]]) {
      px.circle(cx, cy, r, 0xf0e8e0);
      px.circle(cx, cy, r, 0xd8cfc4, 255, false);
    }
    px.grain(rng, 0.04);
  });
  tex('mushroom_stem', (px, rng) => {
    noiseFill(px, rng, P.plant.mushroomStem, 0.07, 2, 4);
    for (let i = 0; i < 8; i++) {
      const x = rng.int(S), y0 = rng.int(S), len = 4 + rng.int(9);
      for (let k = 0; k < len; k++) blendw(px, x, y0 + k, shade(P.plant.mushroomStem, -0.18), 0.5);
    }
    px.grain(rng, 0.05);
  });
  tex('mushroom_block_inside', (px, rng) => {
    noiseFill(px, rng, P.plant.mushroomPore, 0.1, 3, 5);
    px.grain(rng, 0.07);
    px.speckle(rng, 22, shade(P.plant.mushroomPore, -0.24), 0.5);
  });
  tex('crimson_fungus', (px, rng) => {
    for (let y = 9; y < S; y++) { px.set(7, y, 0xd8c8b0); px.set(8, y, 0xb0a088); }
    for (let y = 5; y <= 9; y++) {
      const half = y < 7 ? 3 : 4;
      for (let x = 7 - half; x <= 8 + half - 1; x++) px.set(x, y, x < 7 ? 0xc03a3a : 0x9c2424);
    }
    for (const [x, y] of [[5, 7], [10, 7], [7, 6]]) px.set(x, y, 0x6f1414);
    px.grain(rng, 0.04);
  });
  tex('warped_fungus', (px, rng) => {
    for (let y = 9; y < S; y++) { px.set(7, y, 0xd0c8a8); px.set(8, y, 0xa89f80); }
    for (let y = 5; y <= 9; y++) {
      const half = y < 7 ? 3 : 4;
      for (let x = 7 - half; x <= 8 + half - 1; x++) px.set(x, y, x < 7 ? 0x2fa89c : 0x1c7a70);
    }
    for (const [x, y] of [[5, 7], [10, 7], [7, 6]]) px.set(x, y, 0xf0a82a);
    px.grain(rng, 0.04);
  });

  // --- cactus, cane, bamboo ----------------------------------------------
  tex('cactus_side', (px, rng) => {
    noiseFill(px, rng, P.plant.cactus, 0.08, 2, 4);
    px.rect(0, 0, 1, S, shade(P.plant.cactus, -0.35));
    px.rect(15, 0, 1, S, shade(P.plant.cactus, -0.35));
    for (const x of [1, 14]) px.vline(x, 0, S - 1, shade(P.plant.cactus, 0.12));
    for (let y = 1; y < S; y += 4) {
      for (const x of [3, 7, 11]) {
        px.set(x, y, P.plant.cactusSpine);
        px.set(x, w(y + 1), shade(P.plant.cactusSpine, -0.3));
      }
    }
    px.grain(rng, 0.05);
  });
  tex('cactus_top', (px, rng) => {
    noiseFill(px, rng, P.plant.cactusTop, 0.07, 2, 4);
    px.circle(7.5, 7.5, 6.4, shade(P.plant.cactusTop, 0.1));
    px.circle(7.5, 7.5, 6.4, shade(P.plant.cactus, -0.3), 255, false);
    px.circle(7.5, 7.5, 2.4, shade(P.plant.cactus, -0.15));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      px.set(Math.round(7.5 + Math.cos(a) * 4.6), Math.round(7.5 + Math.sin(a) * 4.6), P.plant.cactusSpine);
    }
    px.grain(rng, 0.05);
  });
  tex('cactus_bottom', (px, rng) => {
    noiseFill(px, rng, shade(P.plant.cactus, -0.12), 0.08, 2, 4);
    px.circle(7.5, 7.5, 6.4, shade(P.plant.cactus, -0.22), 255, false);
    px.grain(rng, 0.06);
  });
  tex('sugar_cane', (px, rng) => {
    // Tinted by the grass colour, so keep it pale.
    for (let y = 0; y < S; y++) {
      px.set(6, y, shade(P.plant.sugarCane, 0.16));
      px.set(7, y, P.plant.sugarCane);
      px.set(8, y, shade(P.plant.sugarCane, -0.2));
      px.set(9, y, shade(P.plant.sugarCane, -0.35));
    }
    for (const y of [2, 7, 12]) px.hline(6, 9, y, shade(P.plant.sugarCane, -0.4));
    // Leaf blades peeling off the node.
    for (const [y, dir] of [[3, -1], [8, 1], [13, -1]]) {
      for (let k = 1; k <= 4; k++) {
        setw(px, (dir < 0 ? 6 : 9) + dir * k, y - k, shade(P.plant.sugarCane, -0.1));
      }
    }
    px.grain(rng, 0.04);
  });
  tex('bamboo_stalk', (px, rng) => {
    for (let y = 0; y < S; y++) {
      px.set(6, y, shade(P.plant.bamboo, 0.2));
      px.set(7, y, P.plant.bamboo);
      px.set(8, y, P.plant.bambooDark);
      px.set(9, y, shade(P.plant.bambooDark, -0.25));
    }
    for (const y of [1, 6, 11]) {
      px.hline(5, 10, y, shade(P.plant.bambooDark, -0.35));
      px.hline(5, 10, y + 1, shade(P.plant.bamboo, 0.24));
    }
    px.grain(rng, 0.04);
  });
  tex('bamboo_stage0', (px, rng) => {
    // A young shoot: two short blades from the ground.
    paintBlades(px, rng, P.plant.bamboo, P.plant.bambooDark, { count: 4, minH: 5, maxH: 9 });
    px.grain(rng, 0.04);
  });

  // --- azalea and dripleaf -----------------------------------------------
  tex('azalea_top', (px, rng) => {
    paintLeaves(px, rng, P.foliage.azalea, shade(P.foliage.azalea, -0.32), { holes: 0.18 });
    px.speckle(rng, 10, 0x7fb04a, 0.5);
  });
  tex('azalea_side', (px, rng) => {
    paintLeaves(px, rng, P.foliage.azalea, shade(P.foliage.azalea, -0.3), { holes: 0.2 });
    // The woody stem showing through at the bottom.
    for (let y = 11; y < S; y++) { px.set(7, y, 0x6b5334); px.set(8, y, 0x4a3821); }
  });
  derive('flowering_azalea_top', 'azalea_top', (px, rng) => {
    for (let i = 0; i < 10; i++) {
      const x = rng.int(S), y = rng.int(S);
      if (!px.getAlpha(x, y)) continue;
      px.set(x, y, P.foliage.azaleaFlower);
      if (rng.chance(0.5)) px.set(w(x + 1), y, P.foliage.flowering);
    }
  });
  derive('flowering_azalea_side', 'azalea_side', (px, rng) => {
    for (let i = 0; i < 9; i++) {
      const x = rng.int(S), y = rng.int(11);
      if (!px.getAlpha(x, y)) continue;
      px.set(x, y, P.foliage.azaleaFlower);
      if (rng.chance(0.5)) px.set(x, w(y + 1), P.foliage.flowering);
    }
  });
  tex('azalea_plant', (px, rng) => {
    // The interior stem column of an azalea bush.
    for (let y = 0; y < S; y++) {
      px.set(6, y, 0x7a5f3a); px.set(7, y, 0x6b5334);
      px.set(8, y, 0x4a3821); px.set(9, y, 0x3a2c19);
    }
    for (let i = 0; i < 10; i++) {
      const x = rng.int(S), y = rng.int(S);
      if (Math.abs(x - 7.5) < 2.5) continue;
      px.set(x, y, rng.chance(0.5) ? P.foliage.azalea : shade(P.foliage.azalea, -0.3));
    }
    px.grain(rng, 0.05);
  });
  tex('big_dripleaf_top', (px, rng) => {
    px.circle(7.5, 7.5, 7.4, P.plant.dripleaf);
    px.circle(7.5, 7.5, 7.4, shade(P.plant.dripleaf, -0.3), 255, false);
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI / 2 + (i - 3) * 0.42;
      px.line(8, 14, Math.round(8 + Math.cos(a) * 8), Math.round(14 + Math.sin(a) * 12),
        shade(P.plant.dripleaf, -0.18));
    }
    px.hline(6, 9, S - 1, P.plant.dripleafStem);
    px.grain(rng, 0.05);
  });
  tex('big_dripleaf_side', (px, rng) => {
    for (let x = 0; x < S; x++) {
      const h = 3 + Math.round(Math.sin(x * 0.4) * 1.6);
      for (let y = 4; y < 4 + h; y++) {
        px.set(x, y, y === 4 ? shade(P.plant.dripleaf, 0.18) : P.plant.dripleaf);
      }
      px.set(x, 4 + h, shade(P.plant.dripleaf, -0.3));
    }
    for (let y = 9; y < S; y++) { px.set(7, y, P.plant.dripleafStem); px.set(8, y, shade(P.plant.dripleafStem, -0.25)); }
    px.grain(rng, 0.05);
  });
  tex('big_dripleaf_stem', (px, rng) => {
    for (let y = 0; y < S; y++) {
      px.set(6, y, shade(P.plant.dripleafStem, 0.2));
      px.set(7, y, P.plant.dripleafStem);
      px.set(8, y, shade(P.plant.dripleafStem, -0.25));
    }
    for (let y = 1; y < S; y += 5) px.hline(6, 8, y, shade(P.plant.dripleafStem, -0.4));
    px.grain(rng, 0.04);
  });
  tex('small_dripleaf_top', (px, rng) => {
    for (const [cx, cy, r] of [[5, 6, 3.4], [11, 8, 3.0]]) {
      px.circle(cx, cy, r, P.plant.dripleaf);
      px.circle(cx, cy, r, shade(P.plant.dripleaf, -0.3), 255, false);
      px.set(cx, cy, shade(P.plant.dripleaf, 0.2));
    }
    for (let y = 9; y < S; y++) { px.set(7, y, P.plant.dripleafStem); px.set(8, y, shade(P.plant.dripleafStem, -0.25)); }
    px.grain(rng, 0.05);
  });
  tex('small_dripleaf_side', (px, rng) => {
    for (let y = 4; y < S; y++) { px.set(7, y, P.plant.dripleafStem); px.set(8, y, shade(P.plant.dripleafStem, -0.25)); }
    for (const [cx, cy] of [[4, 5], [11, 7]]) {
      for (let k = 0; k < 4; k++) {
        px.set(cx + (cx < 8 ? k : -k), cy, P.plant.dripleaf);
        px.set(cx + (cx < 8 ? k : -k), cy + 1, shade(P.plant.dripleaf, -0.25));
      }
    }
    px.grain(rng, 0.05);
  });

  // --- berries, cocoa, gourds --------------------------------------------
  for (let stage = 0; stage < 4; stage++) {
    tex(`sweet_berry_bush_stage${stage}`, (px, rng) => {
      const h = 5 + stage * 3;
      paintBlades(px, rng, P.plant.berryLeaf, shade(P.plant.berryLeaf, -0.3),
        { count: 5 + stage * 2, minH: Math.max(3, h - 3), maxH: h });
      if (stage >= 2) {
        for (let i = 0; i < (stage === 2 ? 3 : 6); i++) {
          const x = rng.int(S), y = S - 2 - rng.int(h - 2);
          if (!px.getAlpha(x, y)) continue;
          px.set(x, y, P.plant.berry);
          px.set(w(x + 1), y, shade(P.plant.berry, -0.3));
        }
      }
      px.grain(rng, 0.04);
    });
  }
  for (let stage = 0; stage < 3; stage++) {
    tex(`cocoa_stage${stage}`, (px, rng) => {
      const size = 4 + stage * 2;
      const x0 = 8 - Math.floor(size / 2), y0 = 4;
      for (let y = y0; y < y0 + size; y++) {
        for (let x = x0; x < x0 + size; x++) {
          const edge = x === x0 || x === x0 + size - 1 || y === y0 || y === y0 + size - 1;
          px.set(x, y, edge ? shade(P.plant.cocoa, -0.35)
            : x < x0 + 2 ? shade(P.plant.cocoa, 0.18) : P.plant.cocoa);
        }
      }
      if (stage === 2) px.rect(x0 + 1, y0 + 1, 2, 2, 0xd8a05c);
      // The stalk tying it to the log.
      px.rect(7, 0, 2, y0, 0x6b5334);
      px.grain(rng, 0.04);
    });
  }
  tex('melon_side', (px, rng) => {
    noiseFill(px, rng, P.plant.melonSkin, 0.09, 3, 4);
    for (let x = 0; x < S; x++) {
      if (((x >> 1) + (x >> 2)) % 2 === 0) continue;
      for (let y = 0; y < S; y++) px.blend(x, y, P.plant.melonStripe, 0.7);
    }
    px.hline(0, S - 1, 0, shade(P.plant.melonSkin, 0.2));
    px.hline(0, S - 1, S - 1, shade(P.plant.melonSkin, -0.3));
    px.grain(rng, 0.05);
  });
  tex('melon_top', (px, rng) => {
    noiseFill(px, rng, P.plant.melonStripe, 0.08, 3, 4);
    px.circle(7.5, 7.5, 6.6, P.plant.melonSkin);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      px.line(8, 8, Math.round(8 + Math.cos(a) * 6.6), Math.round(8 + Math.sin(a) * 6.6),
        P.plant.melonStripe);
    }
    px.circle(7.5, 7.5, 1.5, 0x8f6a2a);
    px.grain(rng, 0.05);
  });
  tex('pumpkin_side', (px, rng) => {
    noiseFill(px, rng, P.plant.pumpkin, 0.08, 3, 4);
    for (const x of [2, 6, 9, 13]) {
      px.vline(x, 0, S - 1, P.plant.pumpkinDark);
      px.vline(w(x + 1), 0, S - 1, shade(P.plant.pumpkin, 0.14));
    }
    px.hline(0, S - 1, 0, shade(P.plant.pumpkin, 0.2));
    px.hline(0, S - 1, S - 1, shade(P.plant.pumpkinDark, -0.2));
    px.grain(rng, 0.05);
  });
  tex('pumpkin_top', (px, rng) => {
    noiseFill(px, rng, P.plant.pumpkin, 0.08, 3, 4);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      px.line(8, 8, Math.round(8 + Math.cos(a) * 8), Math.round(8 + Math.sin(a) * 8),
        P.plant.pumpkinDark);
    }
    px.circle(7.5, 7.5, 2.6, P.plant.pumpkinStem);
    px.circle(7.5, 7.5, 1.4, shade(P.plant.pumpkinStem, 0.25));
    px.grain(rng, 0.05);
  });
  const pumpkinFace = (px, lit) => {
    const ink = lit ? P.plant.jackFlame : 0x2a1a0a;
    // Eyes.
    for (const ex of [3, 9]) {
      for (let y = 4; y < 7; y++) {
        for (let x = ex; x < ex + 4; x++) {
          if (y === 4 && (x === ex || x === ex + 3)) continue;
          px.set(x, y, ink);
        }
      }
    }
    // Mouth.
    px.rect(4, 9, 8, 2, ink);
    px.rect(3, 10, 10, 1, ink);
    for (const x of [5, 8, 11]) px.set(x, 9, P.plant.pumpkin);
    px.set(4, 11, ink); px.set(11, 11, ink);
    if (lit) {
      for (const [x, y] of [[4, 5], [10, 5], [7, 10]]) px.blend(x, y, 0xfff6c0, 0.8);
    }
  };
  derive('carved_pumpkin', 'pumpkin_side', (px) => pumpkinFace(px, false));
  derive('jack_o_lantern', 'pumpkin_side', (px) => pumpkinFace(px, true));

  const stemTex = (name, tipColor) => tex(name, (px, rng) => {
    for (let y = 4; y < S; y++) {
      const x = 7 + Math.round(Math.sin(y * 0.6) * 1.4);
      px.set(x, y, P.plant.stem);
      px.set(w(x + 1), y, P.plant.stemDark);
    }
    for (const y of [6, 10, 14]) {
      const dir = y % 4 === 2 ? -1 : 1;
      for (let k = 1; k <= 3; k++) setw(px, 7 + dir * k, y - k, P.plant.stem);
    }
    px.set(7, 4, tipColor);
    px.set(8, 4, shade(tipColor, -0.2));
    px.grain(rng, 0.04);
  });
  stemTex('pumpkin_stem', 0xc9a02a);
  stemTex('melon_stem', 0xc9a02a);
  const attachedStem = (name) => tex(name, (px, rng) => {
    // A stem that has bent over to meet the fruit beside it.
    for (let x = 0; x < 9; x++) px.set(x, 8, P.plant.stem);
    for (let x = 0; x < 9; x++) px.set(x, 9, P.plant.stemDark);
    for (let y = 9; y < S; y++) { px.set(8, y, P.plant.stem); px.set(9, y, P.plant.stemDark); }
    for (const [x, y] of [[3, 6], [6, 11], [1, 10]]) {
      px.set(x, y, P.plant.stem); px.set(x + 1, y - 1, P.plant.stemDark);
    }
    px.grain(rng, 0.04);
  });
  attachedStem('attached_pumpkin_stem');
  attachedStem('attached_melon_stem');
}

// ---------------------------------------------------------------------------
// Crops
// ---------------------------------------------------------------------------

/**
 * A crop row: four sprigs whose height and colour track `t` (0 = just planted,
 * 1 = ready to harvest). Vanilla crops are drawn on cross quads, so the tile is
 * transparent apart from the sprigs.
 */
function paintCrop(px, rng, t, o) {
  const cols = o.cols ?? [1, 5, 9, 13];
  const h = Math.round(lerp(o.minH ?? 3, o.maxH ?? 14, t));
  const stem = mixHex(o.young ?? P.plant.stem, o.ripe ?? P.plant.stem, t);
  const dark = shade(stem, -0.28);
  for (const x of cols) {
    for (let k = 0; k < h; k++) {
      const y = S - 1 - k;
      px.set(x, y, stem);
      px.set(x + 1, y, dark);
    }
    // Side leaves appear as the plant fills out.
    const leaves = Math.floor(t * 3);
    for (let i = 0; i < leaves; i++) {
      const y = S - 2 - Math.floor((i + 1) * (h / (leaves + 1)));
      const dir = i % 2 === 0 ? -1 : 1;
      setw(px, x + dir, y, stem);
      setw(px, x + dir * 2, y - 1, dark);
    }
    if (o.head && t > 0.65) o.head(px, rng, x, S - h);
  }
  px.grain(rng, 0.04);
}

function registerCrops() {
  for (let stage = 0; stage <= 7; stage++) {
    tex(`wheat_stage${stage}`, (px, rng) => {
      const t = stage / 7;
      paintCrop(px, rng, t, {
        young: P.plant.wheatYoung, ripe: P.plant.wheat, minH: 3, maxH: 15,
        head: (p, r, x, top) => {
          // Grain heads: paired kernels up the last few pixels.
          for (let k = 0; k < 4; k++) {
            p.set(x, top + k, P.plant.wheat);
            p.set(x + 1, top + k, shade(P.plant.wheat, -0.3));
            if (k % 2 === 0) setw(p, x - 1, top + k, shade(P.plant.wheat, 0.16));
          }
        },
      });
    });
  }
  for (let stage = 0; stage <= 3; stage++) {
    const t = (stage + 1) / 4;
    tex(`carrots_stage${stage}`, (px, rng) => {
      paintCrop(px, rng, t, { young: 0x4a7a2c, ripe: P.plant.carrotTop, minH: 4, maxH: 12 });
      if (stage === 3) {
        for (const x of [1, 5, 9, 13]) {
          px.set(x, S - 1, P.plant.carrot);
          px.set(x + 1, S - 1, shade(P.plant.carrot, -0.25));
          px.set(x, S - 2, shade(P.plant.carrot, 0.15));
        }
      }
    });
    tex(`potatoes_stage${stage}`, (px, rng) => {
      paintCrop(px, rng, t, { young: 0x4a7a2c, ripe: P.plant.potatoTop, minH: 4, maxH: 11 });
      if (stage === 3) {
        for (const x of [2, 10]) {
          px.set(x, S - 1, P.plant.potato);
          px.set(x + 1, S - 1, shade(P.plant.potato, -0.25));
        }
      }
    });
    tex(`beetroots_stage${stage}`, (px, rng) => {
      paintCrop(px, rng, t, { young: 0x4a8a34, ripe: P.plant.beetTop, minH: 3, maxH: 9 });
      if (stage === 3) {
        for (const x of [1, 5, 9, 13]) {
          px.set(x, S - 1, P.plant.beet);
          px.set(x + 1, S - 1, shade(P.plant.beet, -0.3));
        }
      }
    });
  }
  for (let stage = 0; stage <= 2; stage++) {
    tex(`nether_wart_stage${stage}`, (px, rng) => {
      const t = (stage + 1) / 3;
      paintCrop(px, rng, t, {
        young: 0x7a2424, ripe: P.nether.netherWart, minH: 4, maxH: 12,
        head: (p, r, x, top) => {
          for (let k = 0; k < 3; k++) {
            p.set(x, top + k, 0xb02a2a);
            setw(p, x - 1, top + k + 1, 0x6f1414);
            setw(p, x + 2, top + k, 0x6f1414);
          }
        },
      });
      if (stage === 2) px.speckle(rng, 8, 0xd8483a, 0.5);
    });
  }
  for (let stage = 0; stage <= 2; stage++) {
    tex(`torchflower_crop_stage${stage}`, (px, rng) => {
      const t = (stage + 1) / 3;
      paintCrop(px, rng, t, {
        young: 0x4a7a2c, ripe: 0x5f9c34, minH: 4, maxH: 11, cols: [3, 11],
      });
      if (stage === 2) {
        for (const x of [3, 11]) {
          px.set(x, 4, P.flower.torchflower);
          px.set(x + 1, 4, P.flower.torchflowerCore);
          px.set(x, 3, shade(P.flower.torchflower, 0.2));
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Animated fluids and flames
// ---------------------------------------------------------------------------

/**
 * Noise fields shared by every frame of an animation. Each frame gets its own
 * `Random`, so per-frame noise would boil; sampling one fixed field with a
 * moving offset is what makes water scroll instead of flicker.
 */
const fields = new Map();
function sharedField(key, octaves = 3, freq = 4) {
  let f = fields.get(key);
  if (!f) {
    f = fbm2(new Random(hashString(`field:${key}`)), S, octaves, freq);
    fields.set(key, f);
  }
  return f;
}

/** Sample a field at a wrapped, fractional y — bilinear so scrolling is smooth. */
function sampleY(field, x, y) {
  const yy = ((y % S) + S) % S;
  const y0 = Math.floor(yy), y1 = (y0 + 1) % S, f = yy - y0;
  return lerp(field[y0 * S + w(x)], field[y1 * S + w(x)], f);
}

/**
 * One frame of a scrolling fluid surface. `speed` must be a whole number of
 * tiles per cycle or the animation will not loop.
 */
function fluidFrame(px, frame, total, o) {
  const a = sharedField(`${o.key}a`, 3, o.freq ?? 4);
  const b = sharedField(`${o.key}b`, 2, o.freq2 ?? 7);
  const t = frame / total;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const va = sampleY(a, x, y + t * S * (o.speed ?? 1));
      const vb = sampleY(b, x, y - t * S * (o.speed2 ?? 1));
      let v = va * 0.62 + vb * 0.38;
      v += Math.sin((x / S) * Math.PI * 2 * (o.waves ?? 2) + t * Math.PI * 2) * (o.amp ?? 0.07);
      v = clamp((v - 0.5) * (o.contrast ?? 1.5) + 0.5, 0, 1);
      px.set(x, y, mixHex(o.dark, o.light, v));
    }
  }
  if (o.hot != null) {
    // Bright crests riding on top of the swell.
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const va = sampleY(a, x, y + t * S * (o.speed ?? 1));
        if (va > (o.hotThreshold ?? 0.72)) {
          px.blend(x, y, o.hot, clamp((va - 0.72) * 4, 0, 1));
        }
      }
    }
  }
}

function registerFluids() {
  // Water is multiplied by the biome water colour, so the texture itself is a
  // pale blue-white; the blue you see in game comes from the tint.
  registerAnimated('water_still', 32, (px, rng, frame, total) => {
    fluidFrame(px, frame, total, {
      key: 'water', dark: P.liquid.waterDeep, light: P.liquid.water,
      speed: 1, speed2: 1, waves: 2, amp: 0.06, contrast: 1.35,
      hot: P.liquid.waterFoam, hotThreshold: 0.78,
    });
  }, 2);
  registerAnimated('water_flow', 32, (px, rng, frame, total) => {
    fluidFrame(px, frame, total, {
      key: 'waterflow', dark: P.liquid.waterDeep, light: P.liquid.water,
      freq: 3, freq2: 8, speed: 3, speed2: 2, waves: 3, amp: 0.1, contrast: 1.7,
      hot: P.liquid.waterFoam, hotThreshold: 0.74,
    });
    // Streaks that read as falling water rather than a moving surface.
    const t = frame / total;
    for (let x = 0; x < S; x += 3) {
      for (let y = 0; y < S; y++) {
        px.blend(x, w(Math.round(y + t * S * 3)), P.liquid.waterFoam, 0.12);
      }
    }
  }, 1);
  tex('water_overlay', (px, rng) => {
    // Flat pane of water for the face touching glass — no waves, they would
    // fight with the still texture behind them.
    px.fill(P.liquid.water, 200);
    noiseOverlay(px, rng, P.liquid.waterDeep, 0.5, 5, 0.5);
    px.grain(rng, 0.02);
  });

  registerAnimated('lava_still', 32, (px, rng, frame, total) => {
    fluidFrame(px, frame, total, {
      key: 'lava', dark: P.liquid.lavaCool, light: P.liquid.lava,
      freq: 3, freq2: 5, speed: 1, speed2: 1, waves: 1, amp: 0.09, contrast: 1.6,
      hot: P.liquid.lavaHot, hotThreshold: 0.62,
    });
    // Convection: a few molten cells that pulse over the cycle.
    const ph = (frame / total) * Math.PI * 2;
    for (let i = 0; i < 5; i++) {
      const cx = (i * 3.1 + 1) % S, cy = (i * 5.7 + 2) % S;
      const r = 1.6 + Math.sin(ph + i) * 0.9;
      for (let y = -3; y <= 3; y++) {
        for (let x = -3; x <= 3; x++) {
          const d = Math.hypot(x, y);
          if (d > r) continue;
          blendw(px, cx + x, cy + y, P.liquid.lavaHot, (1 - d / r) * 0.7);
        }
      }
    }
  }, 3);
  registerAnimated('lava_flow', 32, (px, rng, frame, total) => {
    fluidFrame(px, frame, total, {
      key: 'lavaflow', dark: P.liquid.lavaCool, light: P.liquid.lava,
      freq: 3, freq2: 6, speed: 2, speed2: 1, waves: 2, amp: 0.12, contrast: 1.8,
      hot: P.liquid.lavaHot, hotThreshold: 0.6,
    });
    const t = frame / total;
    for (let x = 1; x < S; x += 4) {
      for (let y = 0; y < S; y++) {
        px.blend(x, w(Math.round(y + t * S * 2)), P.liquid.lavaHot, 0.2);
      }
    }
  }, 2);

  // --- fire ---------------------------------------------------------------
  const firePainter = (hot, mid, deep) => (px, rng, frame, total) => {
    const ph = (frame / total) * Math.PI * 2;
    for (let x = 0; x < S; x++) {
      // Each column licks up and down over the cycle.
      const base = 6 + Math.sin(x * 0.9) * 2.5;
      const h = Math.round(base + Math.sin(ph * 2 + x * 0.7) * 3 + Math.sin(ph + x * 1.9) * 2);
      const top = clamp(S - 1 - h, 0, S - 1);
      for (let y = top; y < S; y++) {
        const t = (y - top) / Math.max(S - 1 - top, 1);
        let c = t < 0.28 ? hot : t < 0.6 ? mid : deep;
        if (y === top) c = mixHex(hot, 0xffffff, 0.35);
        px.set(x, y, c);
      }
      // Detached embers above the flame front.
      if ((x + frame) % 5 === 0 && top > 1) px.set(x, top - 2, mid, 190);
    }
  };
  registerAnimated('fire_0', 16, firePainter(P.nether.fireHot, P.nether.fire, P.nether.fireDeep), 1);
  registerAnimated('fire_1', 16, (px, rng, frame, total) => {
    firePainter(P.nether.fireHot, P.nether.fire, P.nether.fireDeep)(px, rng, (frame + 5) % total, total);
    px.flipX();
  }, 1);
  registerAnimated('soul_fire_0', 16,
    firePainter(0xd8fbff, P.nether.soulFire, P.nether.soulFireDeep), 1);
  registerAnimated('campfire_fire', 16, (px, rng, frame, total) => {
    firePainter(P.nether.fireHot, P.nether.fire, P.nether.fireDeep)(px, rng, frame, total);
    // Campfire flames sit in the middle of the tile, not edge to edge.
    for (let y = 0; y < S; y++) {
      for (const x of [0, 1, 14, 15]) px.set(x, y, 0, 0);
    }
  }, 1);
  registerAnimated('soul_campfire_fire', 16, (px, rng, frame, total) => {
    firePainter(0xd8fbff, P.nether.soulFire, P.nether.soulFireDeep)(px, rng, frame, total);
    for (let y = 0; y < S; y++) {
      for (const x of [0, 1, 14, 15]) px.set(x, y, 0, 0);
    }
  }, 1);
}

// ---------------------------------------------------------------------------
// Utility blocks, machines and light sources
// ---------------------------------------------------------------------------

/** Oak planks, the substrate for most of the workstation blocks. */
function woodBase(px, rng, sp = P.wood.oak, opts = {}) {
  paintPlanks(px, rng, sp.planks, { rows: opts.rows ?? 4, jitter: 0.1, grain: 0.03 });
  return sp.planks;
}

/** A torch: a stick with a burning head, on transparency. */
function paintTorch(px, rng, flame, glow) {
  for (let y = 8; y < S; y++) {
    px.set(7, y, P.misc.torchWood);
    px.set(8, y, shade(P.misc.torchWood, -0.3));
  }
  px.set(7, S - 1, shade(P.misc.torchWood, -0.4));
  px.rect(7, 6, 2, 2, glow);
  px.set(7, 5, flame);
  px.set(8, 5, shade(flame, -0.15));
  px.set(7, 4, mixHex(flame, 0xffffff, 0.4), 220);
  px.blend(6, 6, glow, 0.5);
  px.blend(9, 6, glow, 0.5);
  px.grain(rng, 0.03);
}

/** A hanging lantern: iron cage over a glowing core. */
function paintLantern(px, rng, core, glow) {
  px.rect(5, 4, 6, 8, 0x4a4038);
  px.rect(6, 5, 4, 6, core);
  px.rect(6, 6, 4, 4, glow);
  px.frame(5, 4, 6, 8, 0x2e2822);
  for (const y of [5, 8, 10]) px.hline(5, 10, y, 0x5c5048, 150);
  px.rect(6, 12, 4, 2, 0x4a4038);      // base
  px.rect(6, 2, 4, 2, 0x4a4038);       // cap
  px.set(8, 1, 0x5c5048); px.set(8, 0, 0x5c5048);
  px.blend(4, 7, glow, 0.4); px.blend(11, 7, glow, 0.4);
  px.grain(rng, 0.03);
}

function registerUtility() {
  // --- crafting and storage ----------------------------------------------
  tex('crafting_table_top', (px, rng) => {
    const base = woodBase(px, rng);
    px.frame(0, 0, S, S, shade(base, -0.4));
    const grid = shade(base, -0.34);
    for (const g of [1, 6, 11, 15]) {
      px.hline(1, 14, g, grid);
      px.vline(g, 1, 14, grid);
    }
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) px.bevel(1 + gx * 5, 1 + gy * 5, 5, 5, 0.1, 0.14);
    }
    px.grain(rng, 0.03);
  });
  tex('crafting_table_front', (px, rng) => {
    const base = woodBase(px, rng);
    px.rect(2, 3, 12, 10, shade(base, -0.16));
    px.bevel(2, 3, 12, 10, 0.12, 0.2);
    // A hammer and a saw hanging on the front.
    px.rect(4, 5, 2, 6, 0x6a5238);
    px.rect(3, 4, 4, 2, 0x8a8a8a);
    px.line(9, 11, 12, 5, 0xb0b0b0);
    px.line(10, 11, 13, 5, 0x7a6a4a);
    px.grain(rng, 0.03);
  });
  tex('crafting_table_side', (px, rng) => {
    const base = woodBase(px, rng);
    px.rect(2, 2, 12, 12, shade(base, -0.12));
    px.bevel(2, 2, 12, 12, 0.12, 0.18);
    // Saw blade.
    px.line(3, 12, 12, 4, 0xb8b8b8);
    for (let i = 0; i < 8; i++) px.set(4 + i, 12 - i, 0xdcdcdc);
    px.rect(11, 3, 3, 3, 0x6a4a2a);
    px.grain(rng, 0.03);
  });
  tex('chest', (px, rng) => {
    noiseFill(px, rng, P.misc.chestWood, 0.09, 2, 4);
    for (const x of [0, 5, 10, 15]) px.vline(x, 0, S - 1, P.misc.chestDark);
    px.frame(0, 0, S, S, shade(P.misc.chestDark, -0.3));
    // Lid seam and iron band.
    px.rect(0, 5, S, 3, shade(P.misc.chestDark, -0.15));
    px.hline(0, S - 1, 5, 0x3a2a12);
    // Latch.
    px.rect(6, 5, 4, 4, 0x8a8a8a);
    px.rect(7, 6, 2, 2, P.misc.chestLatch);
    px.set(7, 7, 0x3a3a3a);
    px.grain(rng, 0.05);
  });
  tex('ender_chest', (px, rng) => {
    noiseFill(px, rng, P.misc.enderChest, 0.16, 3, 4);
    for (const x of [0, 5, 10, 15]) px.vline(x, 0, S - 1, 0x0f1a1a);
    px.frame(0, 0, S, S, 0x0a1212);
    px.rect(0, 5, S, 3, 0x142020);
    px.rect(6, 5, 4, 4, 0x2a3a3a);
    px.rect(7, 6, 2, 2, P.misc.enderPearl);
    px.blend(7, 6, 0xa8fff0, 0.6);
    px.speckle(rng, 10, 0x2ad4c0, 0.4);
    px.grain(rng, 0.04);
  });
  tex('barrel_side', (px, rng) => {
    noiseFill(px, rng, P.wood.spruce.planks, 0.09, 2, 5);
    for (let x = 0; x < S; x += 3) px.vline(x, 0, S - 1, shade(P.wood.spruce.planks, -0.3));
    for (let x = 1; x < S; x += 3) px.vline(x, 0, S - 1, shade(P.wood.spruce.planks, 0.12));
    for (const y of [2, 12]) {
      px.rect(0, y, S, 2, 0x5c5148);
      px.hline(0, S - 1, y, 0x8a7f70);
    }
    px.grain(rng, 0.04);
  });
  tex('barrel_top', (px, rng) => {
    noiseFill(px, rng, shade(P.wood.spruce.planks, 0.08), 0.08, 2, 4);
    px.circle(7.5, 7.5, 6.6, shade(P.wood.spruce.planks, 0.04));
    px.circle(7.5, 7.5, 6.6, 0x5c5148, 255, false);
    px.hline(1, 14, 7, shade(P.wood.spruce.planks, -0.28));
    px.vline(7, 1, 14, shade(P.wood.spruce.planks, -0.28));
    px.rect(6, 6, 4, 4, 0x6a5f52);
    px.bevel(6, 6, 4, 4, 0.2, 0.24);
    px.grain(rng, 0.04);
  });
  derive('barrel_top_open', 'barrel_top', (px, rng) => {
    px.circle(7.5, 7.5, 5.2, 0x1a1410);
    px.circle(7.5, 7.5, 5.2, 0x2e2419, 255, false);
    px.speckle(rng, 6, 0x3a2e20, 0.5);
  });
  derive('barrel_bottom', 'barrel_top', (px) => px.scale(0.86));
  tex('bookshelf', (px, rng) => {
    const base = woodBase(px, rng);
    px.rect(0, 0, S, 3, base);
    px.rect(0, 13, S, 3, base);
    px.hline(0, S - 1, 2, shade(base, -0.36));
    px.hline(0, S - 1, 13, shade(base, -0.36));
    px.rect(0, 3, S, 10, 0x3a2a18);
    const spines = [P.misc.bookRed, P.misc.bookGreen, P.misc.bookBlue, P.misc.bookYellow,
      0x8a5a2a, 0x6a3a8a, 0xb0b0a0];
    for (const [y0, h] of [[3, 5], [8, 5]]) {
      let x = 0;
      while (x < S) {
        const bw = 1 + rng.int(2);
        const c = rng.pick(spines);
        for (let i = 0; i < bw && x + i < S; i++) {
          for (let y = y0; y < y0 + h - 1; y++) {
            px.set(x + i, y, i === 0 ? shade(c, 0.18) : c);
          }
        }
        px.set(x, y0, mixHex(c, 0xffffff, 0.3));
        x += bw + 1;
      }
      px.hline(0, S - 1, y0 + h - 1, 0x2a1e10);
    }
    px.grain(rng, 0.04);
  });
  tex('chiseled_bookshelf_front', (px, rng) => {
    const base = woodBase(px, rng);
    px.frame(0, 0, S, S, shade(base, -0.4));
    // Six slots in two rows of three.
    for (let ry = 0; ry < 2; ry++) {
      for (let cx = 0; cx < 3; cx++) {
        const x0 = 1 + cx * 5, y0 = 1 + ry * 7;
        px.rect(x0, y0, 4, 6, 0x2e2114);
        const c = rng.pick([P.misc.bookRed, P.misc.bookGreen, P.misc.bookBlue, P.misc.bookYellow]);
        px.rect(x0 + 1, y0 + 1, 2, 4, c);
        px.set(x0 + 1, y0 + 1, mixHex(c, 0xffffff, 0.3));
        px.frame(x0, y0, 4, 6, shade(base, -0.28));
      }
    }
    px.grain(rng, 0.03);
  });
  tex('chiseled_bookshelf_side', (px, rng) => {
    const base = woodBase(px, rng);
    px.frame(0, 0, S, S, shade(base, -0.34));
    px.grain(rng, 0.03);
  });
  derive('chiseled_bookshelf_top', 'chiseled_bookshelf_side', (px) => px.rotate(1));

  // --- furnaces -----------------------------------------------------------
  const furnace = (prefix, body, panel, trimTop) => {
    tex(`${prefix}_side`, (px, rng) => {
      paintStoneish(px, rng, body, { grain: 0.05, clusters: 3 });
      px.frame(0, 0, S, S, shade(body, -0.28));
    });
    tex(`${prefix}_top`, (px, rng) => {
      paintStoneish(px, rng, body, { grain: 0.05, clusters: 3 });
      px.rect(3, 3, 10, 10, trimTop);
      px.bevel(3, 3, 10, 10, 0.06, 0.28);
      px.frame(2, 2, 12, 12, shade(body, 0.14));
      px.grain(rng, 0.03);
    });
    tex(`${prefix}_front`, (px, rng) => {
      const box = paintMachineFace(px, rng, body, panel);
      // Cold hearth: a dark arch with a grate.
      px.rect(box.x0 + 1, box.y0 + 1, box.wd - 2, box.ht - 2, P.misc.furnaceMouth);
      for (let y = box.y0 + 2; y < box.y0 + box.ht - 1; y += 2) {
        px.hline(box.x0 + 1, box.x0 + box.wd - 2, y, shade(P.misc.furnaceMouth, 0.22));
      }
      px.grain(rng, 0.03);
    });
    tex(`${prefix}_front_on`, (px, rng) => {
      const box = paintMachineFace(px, rng, body, panel);
      px.rect(box.x0 + 1, box.y0 + 1, box.wd - 2, box.ht - 2, 0x1a1008);
      // Flames licking up inside the firebox.
      for (let x = box.x0 + 1; x < box.x0 + box.wd - 1; x++) {
        const h = 3 + ((x * 7) % 4);
        for (let k = 0; k < h; k++) {
          const y = box.y0 + box.ht - 2 - k;
          px.set(x, y, k === 0 ? 0xffe08a : k < 2 ? P.misc.furnaceFire : 0xc24a10);
        }
      }
      px.blend(box.x0 + 2, box.y0 + 2, 0xff9a2a, 0.35);
      px.grain(rng, 0.03);
    });
  };
  furnace('furnace', P.misc.furnaceStone, 0x4a4a4a, 0x6a6a6a);
  furnace('blast_furnace', 0x6a6a6e, 0x3a3a40, 0x8a8a90);
  furnace('smoker', 0x6f5a3f, 0x3a2a18, 0x8a6f4a);
  // The smoker is wood-clad; give its sides a log look rather than stone.
  tex('smoker_side', (px, rng) => {
    paintBark(px, rng, P.wood.spruce, { knots: 1 });
    px.frame(0, 0, S, S, shade(P.wood.spruce.barkDark, -0.2));
  });
  tex('smoker_top', (px, rng) => {
    paintLogTop(px, rng, P.wood.spruce);
    px.rect(5, 5, 6, 6, 0x2e2118);
    px.bevel(5, 5, 6, 6, 0.05, 0.3);
  });
  tex('blast_furnace_top', (px, rng) => {
    paintStoneish(px, rng, 0x6a6a6e, { grain: 0.05, clusters: 3 });
    px.rect(3, 3, 10, 10, 0x3a3a40);
    px.bevel(3, 3, 10, 10, 0.06, 0.3);
    for (const [x, y] of [[3, 3], [12, 3], [3, 12], [12, 12]]) px.set(x, y, 0xb0b0b8);
    px.grain(rng, 0.03);
  });

  // --- workstations -------------------------------------------------------
  tex('smithing_table_top', (px, rng) => {
    noiseFill(px, rng, P.misc.smithing, 0.08, 2, 4);
    px.frame(0, 0, S, S, 0x22222a);
    px.rect(2, 2, 12, 12, 0x4a4a54);
    px.bevel(2, 2, 12, 12, 0.16, 0.2);
    // Hammer marks.
    px.speckle(rng, 14, 0x2e2e36, 0.5);
    px.rect(5, 6, 6, 3, 0x6a6a74);
    px.grain(rng, 0.04);
  });
  tex('smithing_table_side', (px, rng) => {
    paintPlanks(px, rng, P.wood.dark_oak.planks, { rows: 4, grain: 0.03 });
    px.rect(0, 0, S, 3, P.misc.smithing);
    px.hline(0, S - 1, 3, 0x22222a);
    px.grain(rng, 0.03);
  });
  tex('smithing_table_front', (px, rng) => {
    paintPlanks(px, rng, P.wood.dark_oak.planks, { rows: 4, grain: 0.03 });
    px.rect(0, 0, S, 3, P.misc.smithing);
    px.hline(0, S - 1, 3, 0x22222a);
    // Tongs and hammer hung on the front.
    px.line(4, 6, 4, 12, 0x8a8a92);
    px.line(6, 6, 6, 12, 0x8a8a92);
    px.rect(9, 6, 4, 2, 0x6a6a72);
    px.rect(10, 8, 2, 5, 0x6a4a2a);
    px.grain(rng, 0.03);
  });
  derive('smithing_table_bottom', 'smithing_table_side', (px) => px.scale(0.85));
  tex('cartography_table_top', (px, rng) => {
    noiseFill(px, rng, P.misc.paper, 0.05, 2, 4);
    px.frame(0, 0, S, S, 0xa89a78);
    // A rough coastline and a marker.
    px.line(2, 11, 6, 8, 0x7a9c5a);
    px.line(6, 8, 9, 10, 0x7a9c5a);
    px.line(9, 10, 13, 6, 0x7a9c5a);
    px.rect(3, 3, 3, 2, 0x9cb8d8);
    px.set(11, 12, P.misc.tnt); px.set(12, 12, P.misc.tnt);
    px.speckle(rng, 12, 0xd0c8ac, 0.4);
    px.grain(rng, 0.03);
  });
  tex('cartography_table_side1', (px, rng) => {
    paintPlanks(px, rng, P.wood.dark_oak.planks, { rows: 4, grain: 0.03 });
    px.rect(2, 4, 12, 8, P.misc.paper);
    px.frame(2, 4, 12, 8, 0xa89a78);
    px.line(3, 9, 7, 6, 0x7a9c5a);
    px.line(7, 6, 12, 9, 0x7a9c5a);
    px.grain(rng, 0.03);
  });
  tex('fletching_table_top', (px, rng) => {
    paintPlanks(px, rng, P.wood.birch.planks, { rows: 4, grain: 0.03 });
    // Arrow shafts laid out.
    for (const y of [4, 8, 12]) {
      px.hline(2, 12, y, 0x8a6a3a);
      px.set(13, y, 0xd8d8d8); px.set(2, y, 0xe0e0e0);
      px.set(1, y - 1, 0xe0e0e0); px.set(1, y + 1, 0xe0e0e0);
    }
    px.grain(rng, 0.03);
  });
  tex('fletching_table_side', (px, rng) => {
    paintPlanks(px, rng, P.wood.birch.planks, { rows: 4, grain: 0.03 });
    px.line(3, 12, 12, 3, 0x8a6a3a);
    px.set(12, 3, 0xd8d8d8);
    px.grain(rng, 0.03);
  });
  tex('loom_top', (px, rng) => {
    paintPlanks(px, rng, P.wood.oak.planks, { rows: 4, grain: 0.03 });
    px.rect(2, 2, 12, 12, shade(P.wood.oak.planks, -0.14));
    for (let x = 3; x < 13; x += 2) px.vline(x, 3, 12, P.misc.loomThread);
    px.frame(2, 2, 12, 12, shade(P.wood.oak.planks, -0.34));
    px.grain(rng, 0.03);
  });
  tex('loom_front', (px, rng) => {
    paintPlanks(px, rng, P.wood.oak.planks, { rows: 4, grain: 0.03 });
    px.rect(3, 2, 10, 11, 0x8a7050);
    px.frame(3, 2, 10, 11, shade(P.wood.oak.planks, -0.36));
    for (let x = 4; x < 12; x += 2) px.vline(x, 3, 11, P.misc.loomThread);
    px.hline(3, 12, 7, 0xd8c9a0);
    px.rect(6, 12, 4, 3, 0xb0a880);
    px.grain(rng, 0.03);
  });
  tex('loom_side', (px, rng) => {
    paintPlanks(px, rng, P.wood.oak.planks, { rows: 4, grain: 0.03 });
    px.vline(4, 0, S - 1, shade(P.wood.oak.planks, -0.3));
    px.vline(11, 0, S - 1, shade(P.wood.oak.planks, -0.3));
    px.hline(0, S - 1, 7, P.misc.loomThread);
    px.grain(rng, 0.03);
  });
  tex('lectern_top', (px, rng) => {
    paintPlanks(px, rng, P.wood.oak.planks, { rows: 4, grain: 0.03 });
    // An open book on a slanted desk.
    px.rect(2, 4, 12, 8, P.misc.paper);
    px.vline(8, 4, 11, 0xc0b8a0);
    px.frame(2, 4, 12, 8, 0x8a6a3a);
    for (const y of [6, 8, 10]) { px.hline(3, 7, y, 0xb8b0a0); px.hline(9, 13, y, 0xb8b0a0); }
    px.grain(rng, 0.03);
  });
  tex('lectern_sides', (px, rng) => {
    paintPlanks(px, rng, P.wood.oak.planks, { rows: 4, grain: 0.03 });
    px.rect(5, 0, 6, S, shade(P.wood.oak.planks, -0.16));
    px.frame(5, 0, 6, S, shade(P.wood.oak.planks, -0.34));
    px.grain(rng, 0.03);
  });
  tex('grindstone', (px, rng) => {
    paintPlanks(px, rng, P.wood.oak.planks, { rows: 4, grain: 0.03 });
    px.circle(7.5, 7.5, 6.4, P.misc.grindstone);
    px.circle(7.5, 7.5, 6.4, shade(P.misc.grindstone, -0.35), 255, false);
    px.circle(7.5, 7.5, 4.0, shade(P.misc.grindstone, 0.1));
    px.circle(7.5, 7.5, 1.4, 0x4a3a24);
    px.speckle(rng, 14, shade(P.misc.grindstone, -0.25), 0.4);
    px.grain(rng, 0.04);
  });
  tex('stonecutter_top', (px, rng) => {
    paintStoneish(px, rng, P.stone.smooth, { clusters: 3 });
    // The saw slot with a blade poking through.
    px.rect(7, 1, 2, 14, 0x2e2e2e);
    for (let y = 2; y < 14; y++) px.set(7 + (y % 2), y, 0xd0d0d0);
    px.frame(0, 0, S, S, shade(P.stone.smooth, -0.28));
    px.grain(rng, 0.035);
  });
  tex('stonecutter_side', (px, rng) => {
    paintStoneish(px, rng, P.stone.stone, { clusters: 3 });
    px.rect(0, 0, S, 3, P.stone.smooth);
    px.hline(0, S - 1, 3, shade(P.stone.stone, -0.3));
    px.rect(3, 5, 10, 8, 0x5a5a5a);
    px.bevel(3, 5, 10, 8, 0.1, 0.2);
    px.grain(rng, 0.04);
  });
  derive('stonecutter_bottom', 'stonecutter_side', (px) => px.scale(0.82));
  tex('composter_top', (px, rng) => {
    paintPlanks(px, rng, P.misc.composter, { rows: 4, grain: 0.04 });
    px.rect(2, 2, 12, 12, 0x2e2216);
    px.frame(2, 2, 12, 12, shade(P.misc.composter, -0.3));
    noiseOverlay(px, rng, P.misc.compost, 0.5, 5, 0.7);
    px.grain(rng, 0.05);
  });
  tex('composter_side', (px, rng) => {
    for (let x = 0; x < S; x += 4) {
      px.rect(x, 0, 3, S, shade(P.misc.composter, (rng.next() - 0.5) * 0.2));
      px.vline(x + 3, 0, S - 1, shade(P.misc.composter, -0.4));
    }
    px.hline(0, S - 1, 0, shade(P.misc.composter, 0.16));
    px.hline(0, S - 1, S - 1, shade(P.misc.composter, -0.3));
    px.grain(rng, 0.05);
  });
  derive('composter_bottom', 'composter_side', (px) => px.rotate(1));

  // --- decorative and functional -----------------------------------------
  tex('note_block', (px, rng) => {
    noiseFill(px, rng, P.misc.noteBlock, 0.09, 2, 5);
    px.frame(0, 0, S, S, shade(P.misc.noteBlock, -0.35));
    for (let i = 0; i < 26; i++) {
      const x = rng.int(S), y = rng.int(S);
      px.blend(x, y, P.misc.noteDot, 0.55);
    }
    // The quaver.
    px.rect(4, 9, 3, 3, 0x1a120a);
    px.vline(7, 4, 11, 0x1a120a);
    px.line(7, 4, 10, 6, 0x1a120a);
    px.grain(rng, 0.04);
  });
  tex('jukebox_side', (px, rng) => {
    noiseFill(px, rng, P.misc.jukebox, 0.09, 2, 5);
    px.rect(0, 0, S, 2, P.misc.jukeboxTop);
    px.rect(0, 14, S, 2, shade(P.misc.jukebox, -0.28));
    px.rect(3, 5, 10, 6, shade(P.misc.jukebox, -0.2));
    px.bevel(3, 5, 10, 6, 0.12, 0.2);
    px.speckle(rng, 12, P.misc.noteDot, 0.4);
    px.grain(rng, 0.04);
  });
  tex('jukebox_top', (px, rng) => {
    noiseFill(px, rng, P.misc.jukeboxTop, 0.07, 2, 4);
    px.frame(0, 0, S, S, shade(P.misc.jukebox, -0.3));
    px.circle(7.5, 7.5, 5.6, 0x1a1a1a);
    px.circle(7.5, 7.5, 5.6, 0x3a3a3a, 255, false);
    px.circle(7.5, 7.5, 2.2, 0xc23a3a);
    px.circle(7.5, 7.5, 0.8, 0x1a1a1a);
    px.grain(rng, 0.035);
  });
  tex('tnt_side', (px, rng) => {
    noiseFill(px, rng, P.misc.tnt, 0.07, 2, 4);
    px.rect(0, 5, S, 6, P.misc.tntBand);
    px.hline(0, S - 1, 5, 0xb0b0b0);
    px.hline(0, S - 1, 10, 0xb0b0b0);
    // "TNT" stencilled on the band.
    const ink = 0x2a2a2a;
    const letterT = (x) => { px.hline(x, x + 2, 6, ink); px.vline(x + 1, 6, 9, ink); };
    letterT(1); letterT(11);
    px.vline(6, 6, 9, ink); px.vline(9, 6, 9, ink);
    px.line(6, 6, 9, 9, ink);
    px.grain(rng, 0.035);
  });
  tex('tnt_top', (px, rng) => {
    noiseFill(px, rng, P.misc.tnt, 0.07, 2, 4);
    px.circle(7.5, 7.5, 5.4, 0x8f2a1e);
    px.circle(7.5, 7.5, 5.4, 0xd8a04a, 255, false);
    // Fuse.
    px.line(8, 8, 11, 4, 0x6a5a3a);
    px.set(11, 3, 0xffd45c);
    px.grain(rng, 0.035);
  });
  tex('tnt_bottom', (px, rng) => {
    noiseFill(px, rng, 0xb0864a, 0.09, 2, 4);
    px.frame(0, 0, S, S, 0x8a6432);
    px.speckle(rng, 16, 0x8a6432, 0.4);
    px.grain(rng, 0.045);
  });
  tex('spawner', (px, rng) => {
    // A cage: bars with gaps you can see the dark interior through.
    px.fill(P.misc.spawnerDark, 235);
    for (const x of [0, 4, 8, 12, 15]) px.vline(x, 0, S - 1, P.misc.spawner);
    for (const y of [0, 4, 8, 12, 15]) px.hline(0, S - 1, y, P.misc.spawner);
    for (let gy = 0; gy < 4; gy++) {
      for (let gx = 0; gx < 4; gx++) {
        for (let y = gy * 4 + 1; y < gy * 4 + 4; y++) {
          for (let x = gx * 4 + 1; x < gx * 4 + 4; x++) px.set(x, y, 0x0a0d10, 190);
        }
      }
    }
    for (const [x, y] of [[0, 0], [4, 4], [8, 8], [12, 12], [4, 12], [12, 4]]) {
      px.blend(x, y, 0x4a5560, 0.7);
    }
    px.grain(rng, 0.05);
  });
  tex('enchanting_table_top', (px, rng) => {
    noiseFill(px, rng, P.misc.enchant, 0.14, 3, 4);
    px.circle(7.5, 7.5, 6.2, 0x3f3350);
    px.circle(7.5, 7.5, 6.2, P.misc.enchantGem, 255, false);
    px.circle(7.5, 7.5, 3.6, 0x1e1828);
    // Glyphs around the ring.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      px.set(Math.round(7.5 + Math.cos(a) * 4.8), Math.round(7.5 + Math.sin(a) * 4.8), 0xc8b0f0);
    }
    px.circle(7.5, 7.5, 1.2, 0xe8dcff);
    px.grain(rng, 0.04);
  });
  tex('enchanting_table_side', (px, rng) => {
    noiseFill(px, rng, P.misc.enchant, 0.16, 3, 4);
    px.rect(0, 0, S, 4, P.misc.enchantCloth);
    px.hline(0, S - 1, 4, 0x6f1a1a);
    px.hline(0, S - 1, 0, 0xc03a3a);
    for (let i = 0; i < 6; i++) px.blend(rng.int(S), 6 + rng.int(9), 0x8f6fd8, 0.5);
    px.grain(rng, 0.05);
  });
  tex('enchanting_table_bottom', (px, rng) => {
    noiseFill(px, rng, 0x241c2c, 0.16, 3, 4);
    px.speckle(rng, 14, 0x120e18, 0.6);
    px.grain(rng, 0.05);
  });
  tex('brewing_stand', (px, rng) => {
    // The metal post and arms, on transparency.
    for (let y = 2; y < S; y++) { px.set(7, y, 0xb0b0b0); px.set(8, y, 0x707070); }
    px.set(7, 1, 0xd8d8d8); px.set(8, 1, 0x909090);
    for (const [y, dir] of [[6, -1], [9, 1]]) {
      for (let k = 1; k <= 4; k++) setw(px, 7 + dir * k, y + (k > 2 ? 1 : 0), 0x9a9a9a);
    }
    px.rect(6, 12, 4, 4, 0x8a8a8a);
    px.set(7, 13, 0xd8b0f0);
    px.grain(rng, 0.04);
  });
  tex('brewing_stand_base', (px, rng) => {
    paintStoneish(px, rng, P.stone.stone, { clusters: 3 });
    px.circle(7.5, 7.5, 5.6, 0x5a5a5a);
    px.circle(7.5, 7.5, 5.6, 0x8a8a8a, 255, false);
    for (const [x, y] of [[4, 4], [11, 4], [7, 11]]) {
      px.circle(x, y, 1.6, 0x3a3a3a);
      px.set(x, y, 0xb07fd8);
    }
    px.grain(rng, 0.04);
  });
  tex('cauldron_side', (px, rng) => {
    noiseFill(px, rng, 0x4a4a4a, 0.1, 2, 4);
    px.rect(0, 0, S, 2, 0x6a6a6a);
    px.rect(0, 13, S, 3, 0x3a3a3a);
    for (const x of [2, 13]) px.vline(x, 2, 12, 0x2e2e2e);
    px.speckle(rng, 14, 0x2e2e2e, 0.5);
    px.grain(rng, 0.05);
  });
  tex('cauldron_top', (px, rng) => {
    noiseFill(px, rng, 0x4a4a4a, 0.09, 2, 4);
    px.rect(2, 2, 12, 12, 0x2a2a2a);
    px.frame(2, 2, 12, 12, 0x6a6a6a);
    px.frame(0, 0, S, S, 0x5a5a5a);
    px.grain(rng, 0.04);
  });
  derive('cauldron_bottom', 'cauldron_side', (px) => px.scale(0.8));
  tex('anvil', (px, rng) => {
    noiseFill(px, rng, P.misc.anvil, 0.1, 2, 4);
    px.rect(0, 0, S, 2, shade(P.misc.anvil, 0.22));
    px.rect(0, 13, S, 3, P.misc.anvilDark);
    for (let i = 0; i < 8; i++) px.blend(rng.int(S), 3 + rng.int(9), P.misc.anvilDark, 0.5);
    px.grain(rng, 0.05);
  });
  tex('anvil_top', (px, rng) => {
    noiseFill(px, rng, shade(P.misc.anvil, 0.1), 0.08, 2, 4);
    px.rect(2, 1, 12, 14, P.misc.anvil);
    px.bevel(2, 1, 12, 14, 0.18, 0.24);
    px.rect(4, 3, 8, 10, shade(P.misc.anvil, 0.08));
    px.grain(rng, 0.04);
  });
  derive('chipped_anvil_top', 'anvil_top', (px, rng) => crackWalk(px, rng, 2, 7, 0x1a1a1a, 0.8));
  derive('damaged_anvil_top', 'anvil_top', (px, rng) => crackWalk(px, rng, 5, 10, 0x121212, 0.9));
  tex('lodestone', (px, rng) => {
    paintStoneish(px, rng, P.misc.lodestone, { clusters: 3, amp: 0.08 });
    px.frame(0, 0, S, S, 0x4a4f56);
    px.rect(3, 3, 10, 10, 0x5f666e);
    px.bevel(3, 3, 10, 10, 0.18, 0.22);
    // Chevrons pointing to the middle.
    for (const [x, y] of [[7, 4], [7, 11]]) {
      px.set(x, y, 0xd0d8e0); px.set(x + 1, y, 0xd0d8e0);
      px.set(x - 1, y + (y < 8 ? 1 : -1), 0xd0d8e0);
      px.set(x + 2, y + (y < 8 ? 1 : -1), 0xd0d8e0);
    }
    px.rect(7, 7, 2, 2, 0xa8b8c8);
    px.grain(rng, 0.04);
  });
  tex('conduit', (px, rng) => {
    noiseFill(px, rng, P.misc.conduit, 0.12, 2, 4);
    px.frame(0, 0, S, S, shade(P.misc.conduit, -0.35));
    px.circle(7.5, 7.5, 4.6, 0x3a3020);
    px.circle(7.5, 7.5, 3.0, P.misc.conduitEye);
    px.circle(7.5, 7.5, 1.4, 0x2a1a08);
    px.blend(6, 6, 0xffe8a0, 0.6);
    px.grain(rng, 0.04);
  });
  tex('beacon', (px, rng) => {
    noiseFill(px, rng, 0x1a1424, 0.2, 3, 4);
    px.rect(2, 2, 12, 12, 0x2e2a3a);
    px.frame(2, 2, 12, 12, 0x4a4460);
    px.rect(4, 4, 8, 8, P.misc.beacon);
    px.bevel(4, 4, 8, 8, 0.3, 0.2);
    px.rect(6, 6, 4, 4, P.misc.beaconGlass);
    px.blend(6, 6, 0xffffff, 0.5);
    px.grain(rng, 0.03);
  });
  tex('sea_lantern', (px, rng) => {
    noiseFill(px, rng, P.misc.seaLantern, 0.08, 2, 4);
    // A grid of brighter prismarine cells.
    for (const [x, y, s] of [[1, 1, 6], [9, 1, 6], [1, 9, 6], [9, 9, 6]]) {
      px.rect(x, y, s, s, P.misc.seaLanternGlow);
      px.frame(x, y, s, s, shade(P.misc.seaLantern, -0.2));
    }
    px.rect(6, 6, 4, 4, 0xffffff);
    px.speckle(rng, 12, 0xc8e8dc, 0.4);
    px.grain(rng, 0.03);
  });
  tex('daylight_detector_top', (px, rng) => {
    noiseFill(px, rng, 0x2e3a4a, 0.1, 2, 4);
    px.rect(1, 1, 14, 14, 0x1e2a3a, 220);
    // The glass pane over the photocell.
    for (let y = 2; y < 14; y += 3) px.hline(2, 13, y, 0x6f9cc8, 160);
    px.frame(0, 0, S, S, 0x7a6a4a);
    px.line(3, 4, 6, 2, 0xb0d8ff, 200);
    px.grain(rng, 0.03);
  });
  tex('daylight_detector_side', (px, rng) => {
    paintPlanks(px, rng, P.wood.oak.planks, { rows: 3, grain: 0.03 });
    px.rect(0, 0, S, 4, 0x2e3a4a);
    px.hline(0, S - 1, 4, 0x1a2028);
    px.hline(0, S - 1, 0, 0x6f9cc8);
    px.rect(0, 11, S, 5, P.stone.stone);
    px.grain(rng, 0.04);
  });

  // --- respawn anchor -----------------------------------------------------
  tex('respawn_anchor_bottom', (px, rng) => {
    noiseFill(px, rng, P.stone.blackstone, 0.16, 3, 4);
    px.speckle(rng, 14, P.stone.blackstoneDark, 0.5);
    px.grain(rng, 0.05);
  });
  tex('respawn_anchor_top_off', (px, rng) => {
    noiseFill(px, rng, P.misc.respawnAnchor, 0.14, 3, 4);
    px.rect(3, 3, 10, 10, 0x1a1428);
    px.frame(3, 3, 10, 10, 0x3a3055);
    px.grain(rng, 0.05);
  });
  tex('respawn_anchor_top', (px, rng) => {
    noiseFill(px, rng, P.misc.respawnAnchor, 0.14, 3, 4);
    px.rect(3, 3, 10, 10, 0x2a1a4a);
    px.frame(3, 3, 10, 10, P.misc.respawnAnchorGlow);
    px.rect(6, 6, 4, 4, 0xe89bff);
    px.blend(7, 7, 0xffffff, 0.6);
    px.grain(rng, 0.04);
  });
  for (let charge = 0; charge <= 4; charge++) {
    tex(`respawn_anchor_side${charge}`, (px, rng) => {
      noiseFill(px, rng, P.misc.respawnAnchor, 0.14, 3, 4);
      px.speckle(rng, 12, 0x150f22, 0.5);
      // The glowing crystal window fills from the bottom as it charges.
      px.rect(4, 3, 8, 10, 0x15102a);
      px.frame(4, 3, 8, 10, 0x3a3055);
      const filled = Math.round((charge / 4) * 8);
      for (let k = 0; k < filled; k++) {
        const y = 12 - k;
        px.hline(5, 10, y, k === filled - 1 ? 0xe89bff : P.misc.respawnAnchorGlow);
      }
      if (charge > 0) px.blend(5, 12, 0xffffff, 0.4);
      px.grain(rng, 0.04);
    });
  }

  // --- light sources ------------------------------------------------------
  tex('torch', (px, rng) => paintTorch(px, rng, P.misc.torchFlame, P.misc.torchGlow));
  tex('soul_torch', (px, rng) => paintTorch(px, rng, 0xd8fbff, P.misc.soulTorchFlame));
  tex('lantern', (px, rng) => paintLantern(px, rng, P.misc.lantern, 0xffe08a));
  tex('soul_lantern', (px, rng) => paintLantern(px, rng, 0x2f9ab0, 0x8ff0ff));
  tex('campfire_log', (px, rng) => {
    paintBark(px, rng, P.wood.oak, { knots: 1 });
    // Charred at both ends.
    for (let x = 0; x < 4; x++) for (let y = 0; y < S; y++) px.blend(x, y, 0x1a1410, 0.7 - x * 0.15);
    for (let x = 12; x < S; x++) for (let y = 0; y < S; y++) px.blend(x, y, 0x1a1410, 0.2 + (x - 12) * 0.16);
    px.speckle(rng, 10, 0x0f0c0a, 0.6);
  });

  // --- misc ---------------------------------------------------------------
  tex('flower_pot', (px, rng) => {
    noiseFill(px, rng, P.misc.flowerPot, 0.08, 2, 4);
    px.rect(0, 0, S, 3, shade(P.misc.flowerPot, 0.14));
    px.hline(0, S - 1, 3, shade(P.misc.flowerPot, -0.3));
    px.hline(0, S - 1, 0, shade(P.misc.flowerPot, 0.24));
    px.frame(0, 0, S, S, shade(P.misc.flowerPot, -0.34));
    px.speckle(rng, 12, shade(P.misc.flowerPot, -0.2), 0.4);
    px.grain(rng, 0.045);
  });
  tex('cake_top', (px, rng) => {
    noiseFill(px, rng, P.misc.cakeTop, 0.05, 2, 4);
    px.frame(0, 0, S, S, 0xd8ccb0);
    for (const [x, y] of [[3, 3], [8, 4], [12, 8], [5, 11], [10, 12]]) {
      px.set(x, y, P.misc.cakeBerry);
      px.set(x + 1, y, shade(P.misc.cakeBerry, -0.25));
      px.set(x, y + 1, shade(P.misc.cakeBerry, -0.25));
    }
    px.speckle(rng, 10, 0xffffff, 0.4);
    px.grain(rng, 0.03);
  });
  tex('cake_side', (px, rng) => {
    px.fill(P.misc.cake);
    px.rect(0, 0, S, 3, P.misc.cakeTop);
    px.hline(0, S - 1, 3, 0xd8ccb0);
    px.rect(0, 7, S, 3, P.misc.cakeInner);
    px.rect(0, 13, S, 3, shade(P.misc.cake, -0.14));
    px.grain(rng, 0.035);
  });
  derive('cake_bottom', 'cake_side', (px) => { px.rotate(2); px.scale(0.9); });
  tex('cake_inner', (px, rng) => {
    px.fill(P.misc.cakeInner);
    px.rect(0, 0, S, 3, P.misc.cakeTop);
    px.speckle(rng, 18, shade(P.misc.cakeInner, -0.2), 0.5);
    px.speckle(rng, 10, 0xf5d8d8, 0.4);
    px.grain(rng, 0.04);
  });
  tex('bell_top', (px, rng) => {
    noiseFill(px, rng, 0xc8a02a, 0.08, 2, 4);
    px.circle(7.5, 7.5, 6.2, 0xe8c04a);
    px.circle(7.5, 7.5, 6.2, 0x8f6a12, 255, false);
    px.circle(7.5, 7.5, 2.4, 0x8f6a12);
    px.blend(5, 5, 0xfff0a8, 0.6);
    px.grain(rng, 0.035);
  });
  tex('bell_bottom', (px, rng) => {
    noiseFill(px, rng, 0xb08a1a, 0.08, 2, 4);
    px.circle(7.5, 7.5, 6.6, 0xd8ae3a);
    px.circle(7.5, 7.5, 3.0, 0x6f5210);
    px.circle(7.5, 7.5, 1.4, 0x3a2a08);
    px.grain(rng, 0.035);
  });
  tex('lightning_rod', (px, rng) => {
    for (let y = 2; y < S; y++) {
      px.set(6, y, shade(P.metal.copper, 0.24));
      px.set(7, y, P.metal.copper);
      px.set(8, y, shade(P.metal.copper, -0.3));
    }
    px.rect(6, 0, 3, 3, shade(P.metal.copper, 0.14));
    px.set(7, 0, 0xffcf8a);
    for (const y of [5, 10]) px.hline(6, 8, y, shade(P.metal.copper, -0.4));
    px.grain(rng, 0.035);
  });
}

// __SECTIONS__

export default registerBlockTextures;
