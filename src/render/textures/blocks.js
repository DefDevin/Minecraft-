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

// __SECTIONS__

export default registerBlockTextures;
