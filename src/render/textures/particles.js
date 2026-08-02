// Particle sprites.
//
// Every particle that is not a crumb of a broken block draws one of these
// 16x16 sprites. They are painted the same way as block textures — pixel by
// pixel into a `Pixels` buffer — and live in the same texture array, so the
// particle shader can sample them with a plain layer index.
//
// Sprites are drawn white (or near-white) wherever the particle system wants to
// tint them at runtime, and only carry colour where the colour is intrinsic
// (flame, cherry blossom, hearts). `Pixels.blend` takes 0..1 alpha, so building
// a sprite is mostly a matter of accumulating soft falloffs.

import { registerTexture, hasTexture, TEX_SIZE as S } from '../texgen.js';

/**
 * The eight-frame "generic" puff used by smoke, dust and explosion clouds.
 * These MUST stay contiguous in the texture array — the particle system
 * animates a puff by advancing the layer index — which they are, because
 * `registerParticleTextures` registers and resolves them in order.
 */
export const GENERIC_FRAMES = 8;

/** Every sprite this module registers, in registration order. */
export const PARTICLE_TEXTURES = [];

const push = (name, painter) => { PARTICLE_TEXTURES.push(name); registerTexture(name, painter); };

// --- painting helpers ------------------------------------------------------

/** Soft radial blob. `power` > 1 tightens the core. */
function blob(px, cx, cy, r, hex, power = 1.4, strength = 1) {
  const r2 = r * r;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const a = Math.pow(1 - Math.sqrt(d2) / r, power) * strength;
      if (a > 0.004) px.blend(x, y, hex, Math.min(1, a));
    }
  }
}

/** Hard-edged disc, for the chunky pixel-art look. */
function disc(px, cx, cy, r, hex, alpha = 1) {
  const r2 = r * r;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) px.blend(x, y, hex, alpha);
    }
  }
}

/** Ring of a given radius and thickness. */
function ring(px, cx, cy, r, thick, hex, alpha = 1) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const t = 1 - Math.min(1, Math.abs(d - r) / thick);
      if (t > 0.02) px.blend(x, y, hex, t * alpha);
    }
  }
}

/** Four-armed star (crit sparkles, happy villager). */
function star(px, cx, cy, r, hex, arms = 4, alpha = 1) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      if (d > r || d < 0.01) continue;
      const a = Math.atan2(dy, dx);
      // Petal function: spikes along `arms` directions, thin between them.
      const lobe = Math.pow(Math.abs(Math.cos(a * arms / 2)), 0.6);
      const reach = r * (0.28 + 0.72 * lobe);
      if (d > reach) continue;
      px.blend(x, y, hex, Math.min(1, (1 - d / reach) * 1.5) * alpha);
    }
  }
}

/** Filled polygon from a list of [x,y] points, sampled at pixel centres. */
function poly(px, pts, hex, alpha = 1) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!inside(pts, x + 0.5, y + 0.5)) continue;
      px.blend(x, y, hex, alpha);
    }
  }
}

function inside(pts, x, y) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Heart shape, used for breeding hearts and the damage indicator. */
function heart(px, cx, cy, r, hex, alpha = 1) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // Classic implicit heart, y flipped because texture space grows downward.
      const u = (x + 0.5 - cx) / r;
      const v = -(y + 0.5 - cy) / r;
      const f = Math.pow(u * u + v * v - 1, 3) - u * u * v * v * v;
      if (f <= 0) px.blend(x, y, hex, alpha);
    }
  }
}

// --- sprite registration ---------------------------------------------------

let registered = false;

/** Register every particle sprite painter. Safe to call more than once. */
export function registerParticleTextures() {
  if (registered) return PARTICLE_TEXTURES;
  registered = true;

  // Generic puff, eight frames: a soft cloud that erodes into wisps. Smoke,
  // block dust, explosion clouds and campfire smoke all use these tinted.
  for (let f = 0; f < GENERIC_FRAMES; f++) {
    push(`particle_generic_${f}`, (px, rng) => {
      const t = f / (GENERIC_FRAMES - 1);
      px.clear();
      blob(px, 8, 8, 6.5 - t * 1.2, 0xffffff, 1.1 + t * 1.4, 1 - t * 0.15);
      // Erode the edge progressively so the puff dissolves instead of shrinking.
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const a = px.getAlpha(x, y);
          if (a === 0) continue;
          const n = rng.next();
          const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8) / 7;
          const keep = 1 - t * 0.85 * d * d;
          if (n > keep) px.set(x, y, 0xffffff, Math.floor(a * 0.25));
        }
      }
    });
  }

  // Flame: a warm teardrop, brightest at the base.
  push('particle_flame', (px, rng) => {
    px.clear();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (x + 0.5 - 8) / 5.2;
        // The flame narrows toward the top of the sprite (low y).
        const h = (S - 1 - y) / 15;
        const w = 0.35 + h * 0.95 - h * h * 0.75;
        const d = Math.abs(dx) / Math.max(0.12, w);
        if (d > 1 || h > 0.98) continue;
        const core = (1 - d) * (1 - Math.pow(Math.abs(h - 0.32) / 0.7, 1.6));
        if (core <= 0) continue;
        const hex = core > 0.72 ? 0xfff6c8 : core > 0.42 ? 0xffd257 : 0xf07a17;
        px.blend(x, y, hex, Math.min(1, core * 1.9 + 0.2));
      }
    }
    px.grain(rng, 0.05);
  });

  // Soul flame / soul particle: a wispy tadpole with a pale core.
  push('particle_soul', (px, rng) => {
    px.clear();
    blob(px, 8, 9.5, 5.2, 0x3ddbd0, 1.3, 0.95);
    blob(px, 8, 9.5, 2.8, 0xdcfffb, 1.6, 1);
    // Tail
    for (let y = 0; y <= 6; y++) {
      const w = 2.4 - y * 0.3;
      for (let x = 0; x < S; x++) {
        const d = Math.abs(x + 0.5 - 8) / Math.max(0.4, w);
        if (d > 1) continue;
        px.blend(x, y, 0x35b7b3, (1 - d) * (0.15 + y * 0.09));
      }
    }
    px.grain(rng, 0.06);
  });

  // Sculk soul: the same silhouette in the deep-dark blue-green.
  push('particle_sculk', (px, rng) => {
    px.clear();
    blob(px, 8, 9, 5.6, 0x0f4a55, 1.2, 0.9);
    blob(px, 8, 9, 3.0, 0x2ad8c8, 1.5, 1);
    blob(px, 8, 9, 1.4, 0xcbfff6, 2.0, 1);
    for (let y = 0; y <= 7; y++) {
      const w = 2.0 - y * 0.24;
      for (let x = 0; x < S; x++) {
        const d = Math.abs(x + 0.5 - 8) / Math.max(0.4, w);
        if (d > 1) continue;
        px.blend(x, y, 0x1c8f92, (1 - d) * (0.12 + y * 0.08));
      }
    }
    px.grain(rng, 0.05);
  });

  // Water splash: a small teardrop pointing up.
  push('particle_splash', (px) => {
    px.clear();
    disc(px, 8, 10, 3.4, 0xffffff, 0.95);
    poly(px, [[8, 2.5], [10.4, 10], [5.6, 10]], 0xffffff, 0.9);
    blob(px, 7, 9, 2.2, 0xffffff, 1.8, 0.6);
  });

  // Bubble: a ring with a highlight.
  push('particle_bubble', (px) => {
    px.clear();
    ring(px, 8, 8, 5.4, 2.2, 0xffffff, 0.9);
    disc(px, 8, 8, 3.6, 0xffffff, 0.14);
    disc(px, 6, 6, 1.3, 0xffffff, 0.95);
  });

  // Falling / hanging drip: a fat drop.
  push('particle_drip', (px) => {
    px.clear();
    disc(px, 8, 9.5, 4.0, 0xffffff, 0.95);
    poly(px, [[8, 2], [10.6, 9.5], [5.4, 9.5]], 0xffffff, 0.9);
    disc(px, 6.5, 8, 1.2, 0xffffff, 0.5);
  });

  // Critical hit: a chunky four-point star.
  push('particle_crit', (px) => {
    px.clear();
    star(px, 8, 8, 7.4, 0xffffff, 4, 1);
    disc(px, 8, 8, 2.0, 0xffffff, 1);
  });

  // Enchantment glyphs: four rune-like marks drawn on a 5x5 grid.
  const RUNES = [
    ['..#..', '.###.', '#.#.#', '..#..', '..#..'],
    ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
    ['#####', '..#..', '.###.', '..#..', '#...#'],
    ['.###.', '#....', '.###.', '....#', '.###.'],
  ];
  RUNES.forEach((rune, i) => {
    push(`particle_glyph_${i}`, (px) => {
      px.clear();
      for (let ry = 0; ry < 5; ry++) {
        for (let rx = 0; rx < 5; rx++) {
          if (rune[ry][rx] !== '#') continue;
          px.rect(3 + rx * 2, 3 + ry * 2, 2, 2, 0xffffff, 235);
        }
      }
    });
  });

  // Note: a quaver. Tinted per-note by the particle system.
  push('particle_note', (px) => {
    px.clear();
    disc(px, 6, 11, 3.4, 0xffffff, 1);
    px.rect(8, 3, 2, 9, 0xffffff, 255);
    poly(px, [[10, 3], [13.5, 5.5], [13.5, 8], [10, 6]], 0xffffff, 1);
  });

  push('particle_heart', (px) => { px.clear(); heart(px, 8, 7.5, 6.2, 0xff2f4f, 1); heart(px, 6.4, 6.2, 2.1, 0xff9bb0, 0.9); });
  push('particle_damage', (px) => { px.clear(); heart(px, 8, 7.5, 6.2, 0x4a0a0a, 1); heart(px, 6.4, 6.2, 2.0, 0x8c1414, 0.9); });

  // Angry villager: a spiked thought-cloud.
  push('particle_angry', (px) => {
    px.clear();
    disc(px, 8, 8, 5.0, 0xffffff, 1);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      disc(px, 8 + Math.cos(a) * 6.2, 8 + Math.sin(a) * 6.2, 1.8, 0xffffff, 1);
    }
    disc(px, 8, 8, 2.6, 0x000000, 0.55);
  });

  // Happy villager: a bright six-armed sparkle.
  push('particle_happy', (px) => {
    px.clear();
    star(px, 8, 8, 7.2, 0xffffff, 6, 1);
    disc(px, 8, 8, 1.8, 0xffffff, 1);
  });

  // Sweep attack: a crescent arc.
  push('particle_sweep', (px) => {
    px.clear();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = x + 0.5 - 8, dy = y + 0.5 - 14.5;
        const d = Math.hypot(dx, dy);
        if (dy > 0) continue;
        const band = 1 - Math.min(1, Math.abs(d - 11.5) / 3.2);
        if (band <= 0.02) continue;
        const taper = Math.pow(Math.max(0, 1 - Math.abs(dx) / 9.5), 0.7);
        px.blend(x, y, 0xffffff, band * taper * 0.95);
      }
    }
  });

  // Totem of undying: a gold-green spark shaped like a diamond.
  push('particle_totem', (px) => {
    px.clear();
    poly(px, [[8, 1.5], [12.5, 8], [8, 14.5], [3.5, 8]], 0x1fd07a, 1);
    poly(px, [[8, 4.0], [10.8, 8], [8, 12.0], [5.2, 8]], 0xf6e27a, 1);
    disc(px, 8, 8, 1.6, 0xfffbe0, 1);
  });

  // Snowflake: a six-armed crystal.
  push('particle_snowflake', (px) => {
    px.clear();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const ex = 8 + Math.cos(a) * 7, ey = 8 + Math.sin(a) * 7;
      px.line(8, 8, Math.round(ex), Math.round(ey), 0xffffff, 240);
      const bx = 8 + Math.cos(a) * 4.2, by = 8 + Math.sin(a) * 4.2;
      px.line(Math.round(bx), Math.round(by),
        Math.round(bx + Math.cos(a + 1.05) * 2.6), Math.round(by + Math.sin(a + 1.05) * 2.6),
        0xffffff, 190);
      px.line(Math.round(bx), Math.round(by),
        Math.round(bx + Math.cos(a - 1.05) * 2.6), Math.round(by + Math.sin(a - 1.05) * 2.6),
        0xffffff, 190);
    }
    disc(px, 8, 8, 1.4, 0xffffff, 1);
  });

  // Cherry blossom petal.
  push('particle_cherry', (px, rng) => {
    px.clear();
    poly(px, [[8, 1.5], [12.5, 5.5], [13, 11], [8, 14.5], [3, 11], [3.5, 5.5]], 0xffc4dd, 1);
    poly(px, [[8, 3.5], [11, 6.5], [8, 12.5], [5, 6.5]], 0xfff0f6, 0.75);
    px.grain(rng, 0.07);
    px.outline(0xd98cb4, 0.5);
  });

  // End rod: a hard bright dot with a faint halo.
  push('particle_end_rod', (px) => {
    px.clear();
    blob(px, 8, 8, 7.5, 0xd8ccff, 2.6, 0.55);
    disc(px, 8, 8, 2.4, 0xffffff, 1);
  });

  // Firework / totem spark: a small hot point with a soft corona.
  push('particle_spark', (px) => {
    px.clear();
    blob(px, 8, 8, 7.0, 0xffffff, 2.8, 0.5);
    disc(px, 8, 8, 1.8, 0xffffff, 1);
  });

  // Portal / enchant sparkle: a soft four-point glint.
  push('particle_glint', (px) => {
    px.clear();
    star(px, 8, 8, 7.6, 0xffffff, 4, 0.85);
    blob(px, 8, 8, 4.0, 0xffffff, 1.6, 0.7);
  });

  // Generic square speck — mycelium spores, honey specks, misc dust.
  push('particle_dust', (px, rng) => {
    px.clear();
    px.rect(5, 5, 6, 6, 0xffffff, 255);
    px.grain(rng, 0.1);
    px.set(5, 5, 0xffffff, 140);
    px.set(10, 10, 0xffffff, 140);
  });

  // Mycelium spore: a fuzzy mote.
  push('particle_spore', (px) => {
    px.clear();
    blob(px, 8, 8, 6.0, 0xffffff, 2.0, 0.85);
  });

  // Rain streak: a tall thin drop, drawn on a vertical billboard.
  push('particle_rain', (px) => {
    px.clear();
    for (let y = 0; y < S; y++) {
      const w = y < 3 ? 0.8 : 1.6 + (y / S) * 0.8;
      for (let x = 0; x < S; x++) {
        const d = Math.abs(x + 0.5 - 8) / w;
        if (d > 1) continue;
        px.blend(x, y, 0xd8e6ff, (1 - d * d) * (0.35 + (y / S) * 0.55));
      }
    }
  });

  return PARTICLE_TEXTURES;
}

/** True when every sprite has a painter (used by the audit script). */
export function particleTexturesReady() {
  return PARTICLE_TEXTURES.every((n) => hasTexture(n));
}
