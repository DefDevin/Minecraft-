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
  registerStone();
  registerOres();
  registerSoil();
  registerWood();
  registerBuilding();
  registerColored();
  registerPlants();
  registerCrops();
  registerFluids();
  registerUtility();
  registerRedstone();
  registerNether();
  registerEnd();
  registerOverlays();
}

// __SECTIONS__

export default registerBlockTextures;
