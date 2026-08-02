// Particles.
//
// One system, one vertex buffer, at most two draw calls a frame.
//
// Particles live in a struct-of-arrays pool (`this.P`, a flat Float32Array with
// a fixed stride) so a frame's worth of integration never allocates and the
// whole pool stays in cache. Removal is a swap with the last live particle,
// which keeps the live range dense and makes the render pass a straight walk.
//
// Every particle is a camera-facing quad. `render` derives the camera's right
// and up vectors from the view matrix, writes four vertices per particle into
// one interleaved buffer, and issues a single indexed draw for the alpha-blended
// particles plus a second for the additive ones (flames, sparks, glints), which
// is what gives fire and enchantment glints their glow.
//
// Textures come from the same array as blocks: block crumbs sample a 4x4 pixel
// window of the broken block's own texture, everything else uses a sprite from
// render/textures/particles.js. A negative layer means "no texture, use the
// vertex colour" — the particle shader branches on it.

import { layerOf, hasTexture } from './texgen.js';
import { registerParticleTextures, GENERIC_FRAMES } from './textures/particles.js';
import { T, blockOf } from '../world/blocks.js';
import { clamp } from '../core/math.js';

// Sprites must be registered (and their layers reserved) before the renderer
// uploads the texture array, which happens right after the content modules are
// imported — so this runs at module scope on purpose.
registerParticleTextures();

// ---------------------------------------------------------------------------
// Behaviour flags
// ---------------------------------------------------------------------------

export const PF = {
  COLLIDE: 1 << 0,    // stops against blocks instead of falling through
  BOUNCE: 1 << 1,     // keeps a little energy when it lands
  GLOW: 1 << 2,       // ignores world light, always full brightness
  ADDITIVE: 1 << 3,   // drawn in the additive pass
  PULL: 1 << 4,       // eases toward the target point over its life
  SPIRAL: 1 << 5,     // orbits the target point while approaching it
  FLICKER: 1 << 6,    // brightness noise, for flames
  SWAY: 1 << 7,       // sinusoidal horizontal drift, for snow and petals
  ANIM: 1 << 8,       // walks the eight-frame generic puff sprite
  FADE: 1 << 9,       // alpha falls across the whole life, not just the tail
  SHRINK: 1 << 10,    // size falls to zero across the life
  GROW: 1 << 11,      // size grows across the life
  SPIN: 1 << 12,      // uses the per-particle roll angle
  UNDERWATER: 1 << 13, // only integrates while inside a fluid
};

// ---------------------------------------------------------------------------
// Type table
//
// size/life/speed are [min,max] ranges. `gravity` is blocks/s^2 (negative
// rises), `drag` is the fraction of velocity kept after one second, `color` is
// packed RGB, `jitter` randomises the colour per particle.
// ---------------------------------------------------------------------------

const G = PF;

export const PARTICLE_TYPES = {
  // -- blocks --------------------------------------------------------------
  block_break: {
    tex: '@block', size: [0.08, 0.16], life: [0.7, 1.9], speed: [0.8, 2.6],
    up: 1.8, gravity: 15, drag: 0.28, flags: G.COLLIDE | G.BOUNCE,
  },
  block_dust: {
    tex: '@block', size: [0.05, 0.11], life: [0.5, 1.1], speed: [0.2, 1.0],
    up: 0.5, gravity: 6, drag: 0.2, flags: G.COLLIDE | G.FADE,
  },

  // -- smoke & fire --------------------------------------------------------
  smoke: {
    tex: '@generic', size: [0.1, 0.2], life: [0.8, 1.8], speed: [0.05, 0.3],
    up: 0.35, gravity: -0.7, drag: 0.25, color: 0x3a3a3a, jitter: 0.12,
    flags: G.ANIM | G.FADE | G.GROW,
  },
  large_smoke: {
    tex: '@generic', size: [0.28, 0.55], life: [1.6, 3.4], speed: [0.05, 0.35],
    up: 0.5, gravity: -0.9, drag: 0.3, color: 0x30302f, jitter: 0.1,
    flags: G.ANIM | G.FADE | G.GROW,
  },
  campfire_smoke: {
    tex: '@generic', size: [0.5, 0.95], life: [5.0, 9.0], speed: [0.02, 0.12],
    up: 0.9, gravity: -1.1, drag: 0.55, color: 0x8d8b86, jitter: 0.08,
    flags: G.ANIM | G.FADE | G.GROW,
  },
  flame: {
    tex: 'particle_flame', size: [0.11, 0.19], life: [0.5, 1.1], speed: [0.02, 0.2],
    up: 0.15, gravity: -0.35, drag: 0.35, color: 0xffffff,
    flags: G.GLOW | G.ADDITIVE | G.FLICKER | G.SHRINK,
  },
  soul_flame: {
    tex: 'particle_soul', size: [0.13, 0.22], life: [0.7, 1.5], speed: [0.02, 0.18],
    up: 0.2, gravity: -0.45, drag: 0.35, color: 0x9dfff4,
    flags: G.GLOW | G.ADDITIVE | G.FLICKER | G.SHRINK,
  },
  lava_pop: {
    tex: 'particle_flame', size: [0.14, 0.26], life: [0.6, 1.3], speed: [1.5, 3.5],
    up: 3.0, gravity: 13, drag: 0.5, color: 0xffb14a,
    flags: G.GLOW | G.ADDITIVE | G.COLLIDE,
  },

  // -- drips & water -------------------------------------------------------
  dripping_lava: {
    tex: 'particle_drip', size: [0.07, 0.1], life: [1.2, 2.4], speed: [0, 0.05],
    gravity: 9, drag: 0.85, color: 0xff8c1a, flags: G.GLOW | G.COLLIDE,
  },
  dripping_water: {
    tex: 'particle_drip', size: [0.05, 0.08], life: [1.0, 2.2], speed: [0, 0.05],
    gravity: 9, drag: 0.85, color: 0x4a7ce8, flags: G.COLLIDE,
  },
  dripping_honey: {
    tex: 'particle_drip', size: [0.06, 0.09], life: [1.6, 3.0], speed: [0, 0.04],
    gravity: 5, drag: 0.9, color: 0xf6a418, flags: G.COLLIDE,
  },
  splash: {
    tex: 'particle_splash', size: [0.06, 0.13], life: [0.4, 0.9], speed: [0.8, 2.6],
    up: 2.2, gravity: 13, drag: 0.4, color: 0xc8ddff, flags: G.COLLIDE | G.FADE,
  },
  rain_splash: {
    tex: 'particle_splash', size: [0.04, 0.08], life: [0.25, 0.5], speed: [0.3, 1.1],
    up: 1.2, gravity: 11, drag: 0.4, color: 0xa8c4ea, flags: G.FADE,
  },
  bubble: {
    tex: 'particle_bubble', size: [0.05, 0.11], life: [0.6, 1.6], speed: [0.05, 0.5],
    up: 0.4, gravity: -3.2, drag: 0.6, color: 0xe8f4ff, flags: G.UNDERWATER,
  },
  underwater: {
    tex: 'particle_dust', size: [0.02, 0.05], life: [4.0, 12.0], speed: [0.01, 0.06],
    gravity: 0.02, drag: 0.9, color: 0xa8c0d8, jitter: 0.15, flags: G.FADE | G.SWAY,
  },

  // -- combat & magic ------------------------------------------------------
  crit: {
    tex: 'particle_crit', size: [0.1, 0.2], life: [0.4, 0.8], speed: [1.0, 3.0],
    gravity: 3.0, drag: 0.12, color: 0xf0d8a8, flags: G.FADE | G.SHRINK,
  },
  magic_crit: {
    tex: 'particle_crit', size: [0.1, 0.2], life: [0.4, 0.9], speed: [1.0, 3.0],
    gravity: 2.4, drag: 0.12, color: 0x6ad8ff,
    flags: G.FADE | G.SHRINK | G.GLOW | G.ADDITIVE,
  },
  enchant: {
    tex: '@glyph', size: [0.11, 0.22], life: [0.9, 1.6], speed: [0, 0],
    gravity: 0, drag: 1, color: 0xd6ccff, flags: G.PULL | G.FADE | G.GLOW,
  },
  sweep: {
    tex: 'particle_sweep', size: [1.1, 1.5], life: [0.2, 0.3], speed: [0, 0],
    gravity: 0, drag: 1, color: 0xffffff, flags: G.FADE | G.GROW,
  },
  damage_indicator: {
    tex: 'particle_damage', size: [0.2, 0.3], life: [0.6, 1.0], speed: [0.4, 1.2],
    up: 1.4, gravity: 5, drag: 0.4, color: 0xffffff, flags: G.FADE,
  },
  totem: {
    tex: 'particle_totem', size: [0.14, 0.26], life: [1.0, 2.0], speed: [0.8, 3.2],
    up: 1.0, gravity: 3.0, drag: 0.3, color: 0xffffff, flags: G.FADE | G.SPIN,
  },

  // -- dimensional ---------------------------------------------------------
  portal: {
    tex: 'particle_glint', size: [0.1, 0.24], life: [1.0, 2.2], speed: [0.4, 1.6],
    gravity: 0, drag: 0.7, color: 0x9b3ecf, jitter: 0.2,
    flags: G.SPIRAL | G.FADE | G.GLOW | G.ADDITIVE,
  },
  ender: {
    tex: 'particle_glint', size: [0.12, 0.28], life: [0.6, 1.4], speed: [0.6, 2.4],
    gravity: 0, drag: 0.45, color: 0x5e2f8c, jitter: 0.15,
    flags: G.FADE | G.GLOW | G.ADDITIVE,
  },
  end_rod: {
    tex: 'particle_end_rod', size: [0.05, 0.1], life: [2.0, 4.0], speed: [0.02, 0.2],
    gravity: -0.05, drag: 0.75, color: 0xece4ff,
    flags: G.GLOW | G.ADDITIVE | G.FADE,
  },
  sculk_soul: {
    tex: 'particle_sculk', size: [0.14, 0.26], life: [1.2, 2.4], speed: [0.1, 0.5],
    up: 0.5, gravity: -0.8, drag: 0.5, color: 0xbdfff2,
    flags: G.GLOW | G.ADDITIVE | G.FADE,
  },

  // -- explosions & fireworks ---------------------------------------------
  explosion: {
    tex: '@generic', size: [0.6, 1.6], life: [0.6, 1.4], speed: [0.2, 1.4],
    gravity: -0.4, drag: 0.15, color: 0xd8d4cc, jitter: 0.08,
    flags: G.ANIM | G.FADE | G.GROW,
  },
  firework: {
    tex: 'particle_spark', size: [0.08, 0.16], life: [0.7, 1.8], speed: [2.0, 6.0],
    gravity: 2.2, drag: 0.22, color: 0xffffff, jitter: 0.5,
    flags: G.GLOW | G.ADDITIVE | G.FADE | G.FLICKER,
  },

  // -- mood & feedback -----------------------------------------------------
  note: {
    tex: 'particle_note', size: [0.24, 0.32], life: [0.8, 1.1], speed: [0.02, 0.1],
    up: 1.1, gravity: 1.4, drag: 0.5, color: 0xffffff, flags: G.FADE,
  },
  heart: {
    tex: 'particle_heart', size: [0.2, 0.3], life: [0.9, 1.4], speed: [0.1, 0.35],
    up: 0.7, gravity: -0.4, drag: 0.6, color: 0xffffff, flags: G.FADE,
  },
  angry_villager: {
    tex: 'particle_angry', size: [0.22, 0.3], life: [0.9, 1.3], speed: [0.05, 0.2],
    up: 0.4, gravity: -0.3, drag: 0.6, color: 0xffffff, flags: G.FADE,
  },
  happy_villager: {
    tex: 'particle_happy', size: [0.12, 0.22], life: [0.7, 1.3], speed: [0.2, 0.9],
    up: 0.5, gravity: 1.2, drag: 0.3, color: 0x8fe06a, flags: G.FADE | G.SHRINK,
  },
  item_pickup: {
    tex: 'particle_glint', size: [0.1, 0.16], life: [0.22, 0.32], speed: [0, 0],
    gravity: 0, drag: 1, color: 0xffffff, flags: G.PULL | G.FADE | G.GLOW,
  },

  // -- weather & ambience --------------------------------------------------
  snowflake: {
    tex: 'particle_snowflake', size: [0.08, 0.15], life: [2.0, 5.0], speed: [0.05, 0.3],
    gravity: 1.1, drag: 0.55, color: 0xffffff, flags: G.COLLIDE | G.SWAY | G.FADE,
  },
  cherry: {
    tex: 'particle_cherry', size: [0.1, 0.18], life: [4.0, 9.0], speed: [0.05, 0.25],
    gravity: 0.55, drag: 0.6, color: 0xffffff,
    flags: G.COLLIDE | G.SWAY | G.SPIN | G.FADE,
  },
  mycelium: {
    tex: 'particle_spore', size: [0.03, 0.07], life: [2.0, 5.0], speed: [0.02, 0.1],
    gravity: 0.12, drag: 0.8, color: 0xb0a0c0, jitter: 0.12, flags: G.FADE | G.SWAY,
  },
};

/** Older / alternative spellings accepted by `emit`. */
export const PARTICLE_ALIASES = {
  crumb: 'block_break', dust: 'block_dust', block_crack: 'block_break',
  smoke_normal: 'smoke', smoke_large: 'large_smoke', cloud: 'large_smoke',
  fire: 'flame', soul_fire_flame: 'soul_flame', lava: 'lava_pop',
  drip_lava: 'dripping_lava', drip_water: 'dripping_water',
  drip_honey: 'dripping_honey', water_splash: 'splash',
  water_bubble: 'bubble', bubble_pop: 'bubble', suspended: 'underwater',
  crit_magic: 'magic_crit', enchanted_hit: 'magic_crit', magic: 'magic_crit',
  enchant_glyph: 'enchant', enchantment_table: 'enchant',
  sweep_attack: 'sweep', damage: 'damage_indicator', heart_break: 'damage_indicator',
  villager_happy: 'happy_villager', villager_angry: 'angry_villager',
  portal_travel: 'portal', teleport: 'ender', reverse_portal: 'portal',
  explode: 'explosion', explosion_puff: 'explosion', firework_spark: 'firework',
  snow: 'snowflake', petal: 'cherry', cherry_leaves: 'cherry',
  spore: 'mycelium', mycelium_spore: 'mycelium', soul: 'sculk_soul',
  pickup: 'item_pickup', rain: 'rain_splash',
};

export const PARTICLE_NAMES = Object.keys(PARTICLE_TYPES);

/** Resolve a type name through the alias table; null when unknown. */
export function resolveType(name) {
  if (PARTICLE_TYPES[name]) return name;
  const a = PARTICLE_ALIASES[name];
  return a && PARTICLE_TYPES[a] ? a : null;
}

// ---------------------------------------------------------------------------
// Texture layers
//
// Resolved once at import, before the renderer packs the array — a layer
// allocated after `uploadTextures()` would not exist on the GPU.
// ---------------------------------------------------------------------------

const GENERIC_BASE = layerOf('particle_generic_0');
const GENERIC_CONTIGUOUS =
  layerOf(`particle_generic_${GENERIC_FRAMES - 1}`) === GENERIC_BASE + GENERIC_FRAMES - 1;
const GLYPH_LAYERS = [0, 1, 2, 3].map((i) => layerOf(`particle_glyph_${i}`));
const SPRITE_LAYER = new Map();
for (const t of Object.values(PARTICLE_TYPES)) {
  if (typeof t.tex === 'string' && t.tex[0] !== '@') SPRITE_LAYER.set(t.tex, layerOf(t.tex));
}
/** Exposed so the weather renderer can share the same atlas layers. */
export const RAIN_LAYER = layerOf('particle_rain');
export const SNOW_LAYER = layerOf('particle_snowflake');

/** Cache of state id -> {layer, color} for block crumbs. */
const blockTexCache = new Map();

/** Faces are searched side-first so crumbs look like the block's flanks. */
const FACE_ORDER = [4, 5, 0, 1, 3, 2];

function blockAppearance(state) {
  let hit = blockTexCache.get(state);
  if (hit) return hit;
  const def = blockOf(state);
  let name = null;
  if (def) {
    if (def.particleTexture) name = def.particleTexture;
    if (!name) {
      const model = safe(() => def.modelFor(state));
      if (model) {
        for (const f of FACE_ORDER) {
          for (const bx of model) {
            const face = bx.faces && bx.faces[f];
            if (face && face.texture) { name = face.texture; break; }
          }
          if (name) break;
        }
      }
    }
    if (!name) {
      const spec = typeof def.textures === 'function'
        ? safe(() => def.textures(state)) : def.textures;
      if (typeof spec === 'string') name = spec;
      else if (Array.isArray(spec)) name = spec.find((t) => typeof t === 'string') || null;
      else if (spec) {
        name = spec.side || spec.north || spec.all || spec.top ||
          Object.values(spec).find((t) => typeof t === 'string') || null;
      }
    }
  }
  hit = name && hasTexture(name)
    ? { layer: layerOf(name), color: 0xffffff }
    : { layer: -1, color: def ? def.mapColor : 0x808080 };
  blockTexCache.set(state, hit);
  return hit;
}

function safe(fn) { try { return fn(); } catch { return null; } }

// ---------------------------------------------------------------------------
// Pool layout
// ---------------------------------------------------------------------------

const X = 0, Y = 1, Z = 2, VX = 3, VY = 4, VZ = 5, GRAV = 6, DRAG = 7,
  SIZE = 8, SIZE0 = 9, R = 10, GG = 11, B = 12, A = 13, AGE = 14, LIFE = 15,
  ROT = 16, ROTV = 17, U0 = 18, V0 = 19, U1 = 20, V1 = 21, LAYER = 22,
  FLAGS = 23, OX = 24, OY = 25, OZ = 26, SEED = 27;
const STRIDE = 28;

const FLOATS_PER_VERTEX = 10;   // pos3 + uv2 + rgba4 + layer1

// ---------------------------------------------------------------------------

export class ParticleSystem {
  /**
   * @param {import('./renderer.js').Renderer} renderer
   * @param {{max?: number}} [opts]
   */
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.gl = renderer ? renderer.gl : null;
    this.max = opts.max ?? 6000;
    this.count = 0;
    this.density = 1;          // scaled down by the particle quality setting
    this.world = null;
    this.time = 0;

    this.P = new Float32Array(this.max * STRIDE);
    this.vertices = new Float32Array(this.max * 4 * FLOATS_PER_VERTEX);
    this.additiveIdx = new Int32Array(this.max);

    this.stats = { alive: 0, drawn: 0, emitted: 0, dropped: 0 };
    this.vao = null;
    this._rand = 0x2f6e2b1 >>> 0;
  }

  /** xorshift — deterministic-ish, and far cheaper than Math.random here. */
  rnd() {
    let x = this._rand;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this._rand = x;
    return x / 4294967296;
  }

  range(r) { return r[0] + (r[1] - r[0]) * this.rnd(); }

  clear() { this.count = 0; }

  // -- emission ------------------------------------------------------------

  /**
   * Spawn `count` particles of `type` at (x,y,z).
   * @param {string} type
   * @param {object} [opts] state, color, note, target/tx/ty/tz, velocity,
   *   spread, scale, life, count multiplier.
   */
  emit(type, x, y, z, count = 1, opts) {
    const key = resolveType(type);
    if (!key) return 0;
    const def = PARTICLE_TYPES[key];
    const o = opts || EMPTY;
    let n = Math.max(1, Math.round((count || 1) * this.density * (o.scale ?? 1)));
    if (n > 256) n = 256;

    // Block-derived appearance is resolved once for the whole burst.
    let layer = -1, baseColor = def.color ?? 0xffffff, sub = false;
    if (def.tex === '@block') {
      const app = blockAppearance(o.state | 0);
      layer = app.layer; baseColor = app.color === 0xffffff ? 0xffffff : app.color;
      sub = app.layer >= 0;
    } else if (def.tex === '@generic') {
      layer = GENERIC_BASE;
    } else if (def.tex === '@glyph') {
      layer = GLYPH_LAYERS[0];
    } else if (typeof def.tex === 'string') {
      layer = SPRITE_LAYER.get(def.tex) ?? -1;
    }
    if (o.texture && hasTexture(o.texture)) layer = layerOf(o.texture);
    if (key === 'note') baseColor = noteColor(o.note ?? this.rnd() * 24);
    if (o.color !== undefined) baseColor = o.color;

    const light = this.lightAt(x, y, z);
    const spread = o.spread ?? 0.5;
    let made = 0;
    for (let i = 0; i < n; i++) {
      if (this.count >= this.max) { this.stats.dropped++; break; }
      const p = this.count * STRIDE;
      const P = this.P;

      P[p + X] = x + (this.rnd() - 0.5) * spread;
      P[p + Y] = y + (this.rnd() - 0.5) * spread;
      P[p + Z] = z + (this.rnd() - 0.5) * spread;

      const speed = def.speed ? this.range(def.speed) : 0;
      // Random direction on a sphere, then the type's upward bias on top.
      const th = this.rnd() * Math.PI * 2;
      const ph = Math.acos(2 * this.rnd() - 1);
      const st = Math.sin(ph);
      P[p + VX] = Math.cos(th) * st * speed + (o.vx ?? 0);
      P[p + VY] = Math.cos(ph) * speed + (def.up ? this.rnd() * def.up : 0) + (o.vy ?? 0);
      P[p + VZ] = Math.sin(th) * st * speed + (o.vz ?? 0);

      P[p + GRAV] = o.gravity ?? def.gravity ?? 0;
      P[p + DRAG] = def.drag ?? 0.5;

      const size = (o.size ?? this.range(def.size)) * (o.sizeScale ?? 1);
      P[p + SIZE] = size;
      P[p + SIZE0] = size;

      let col = baseColor;
      if (def.jitter) col = jitter(col, def.jitter, this.rnd(), this.rnd(), this.rnd());
      let r = ((col >> 16) & 255) / 255, g = ((col >> 8) & 255) / 255, b = (col & 255) / 255;
      if (!(def.flags & G.GLOW)) { r *= light; g *= light; b *= light; }
      P[p + R] = r; P[p + GG] = g; P[p + B] = b;
      P[p + A] = o.alpha ?? 1;

      P[p + AGE] = 0;
      P[p + LIFE] = o.life ?? this.range(def.life);
      P[p + ROT] = (def.flags & G.SPIN) ? this.rnd() * Math.PI * 2 : 0;
      P[p + ROTV] = (def.flags & G.SPIN) ? (this.rnd() - 0.5) * 4 : 0;

      // Crumbs take a random 4x4 pixel window of the source texture; sprites
      // use the whole thing.
      if (sub) {
        const a = (this.rnd() * 4) | 0, b2 = (this.rnd() * 4) | 0;
        P[p + U0] = a * 0.25; P[p + V0] = b2 * 0.25;
        P[p + U1] = a * 0.25 + 0.25; P[p + V1] = b2 * 0.25 + 0.25;
      } else {
        P[p + U0] = 0; P[p + V0] = 0; P[p + U1] = 1; P[p + V1] = 1;
      }

      let l = layer;
      if (def.tex === '@glyph') l = GLYPH_LAYERS[(this.rnd() * GLYPH_LAYERS.length) | 0];
      P[p + LAYER] = l;
      P[p + FLAGS] = def.flags | (o.flags ?? 0);

      // Targets: enchantment glyphs and pickups fly to a point, portal
      // particles orbit their origin.
      const t = o.target;
      P[p + OX] = o.tx ?? (t ? t.x : x);
      P[p + OY] = o.ty ?? (t ? t.y : y);
      P[p + OZ] = o.tz ?? (t ? t.z : z);
      if ((def.flags & G.PULL) && o.radius) {
        // Glyphs stream in from a shell around the emitter (a bookshelf) and
        // converge on the target (the enchanting table).
        P[p + X] = x + (this.rnd() - 0.5) * 2 * o.radius;
        P[p + Y] = y + (this.rnd() - 0.5) * 2 * o.radius;
        P[p + Z] = z + (this.rnd() - 0.5) * 2 * o.radius;
      }
      P[p + SEED] = this.rnd() * 100;

      this.count++;
      made++;
    }
    this.stats.emitted += made;
    return made;
  }

  /** Convenience: the classic "block broke here" burst. */
  emitBlockBreak(state, x, y, z, count = 16) {
    return this.emit('block_break', x, y, z, count, { state, spread: 0.8 });
  }

  lightAt(x, y, z) {
    const w = this.world;
    if (!w || !w.getLight) return 1;
    const l = w.getLight(Math.floor(x), Math.floor(y), Math.floor(z));
    return 0.22 + (l / 15) * 0.78;
  }

  // -- simulation ----------------------------------------------------------

  /**
   * Integrate every live particle.
   * @param {number} dt seconds
   * @param {import('../world/world.js').World} world
   */
  update(dt, world) {
    if (world) this.world = world;
    if (dt <= 0) return;
    if (dt > 0.1) dt = 0.1;
    this.time += dt;
    const P = this.P;
    const solid = T.solid;
    const canCollide = !!(world && solid);

    let i = 0;
    while (i < this.count) {
      const p = i * STRIDE;
      const age = P[p + AGE] + dt;
      const life = P[p + LIFE];
      if (age >= life) { this.removeAt(i); continue; }
      P[p + AGE] = age;
      const t = age / life;
      const flags = P[p + FLAGS];

      if (flags & G.PULL) {
        // Ease-in toward the target so the last stretch is the fastest.
        const k = t * t;
        const step = dt / Math.max(1e-4, life - age + dt);
        P[p + X] += (P[p + OX] - P[p + X]) * Math.min(1, step * (1 + k * 6));
        P[p + Y] += (P[p + OY] - P[p + Y]) * Math.min(1, step * (1 + k * 6));
        P[p + Z] += (P[p + OZ] - P[p + Z]) * Math.min(1, step * (1 + k * 6));
      } else {
        let vx = P[p + VX], vy = P[p + VY], vz = P[p + VZ];
        vy -= P[p + GRAV] * dt;
        const damp = Math.pow(P[p + DRAG], dt);
        vx *= damp; vy *= damp; vz *= damp;

        if (flags & G.SPIRAL) {
          // Orbit the origin while drifting inward, like a nether portal.
          const dx = P[p + X] - P[p + OX], dz = P[p + Z] - P[p + OZ];
          vx += (-dz * 1.6 - dx * 0.8) * dt;
          vz += (dx * 1.6 - dz * 0.8) * dt;
          vy += (P[p + OY] - P[p + Y]) * 0.9 * dt;
        }
        if (flags & G.SWAY) {
          const ph = this.time * 1.3 + P[p + SEED];
          vx += Math.cos(ph) * 0.55 * dt;
          vz += Math.sin(ph * 0.8) * 0.55 * dt;
        }

        let nx = P[p + X] + vx * dt;
        let ny = P[p + Y] + vy * dt;
        let nz = P[p + Z] + vz * dt;

        if (canCollide && (flags & G.COLLIDE)) {
          const half = P[p + SIZE] * 0.5;
          if (isSolid(world, solid, nx + Math.sign(vx) * half, P[p + Y], P[p + Z])) {
            nx = P[p + X]; vx = 0; vz *= 0.7;
          }
          if (isSolid(world, solid, P[p + X], ny + Math.sign(vy) * half, P[p + Z])) {
            ny = P[p + Y];
            if (flags & G.BOUNCE) { vy = -vy * 0.28; if (Math.abs(vy) < 0.4) vy = 0; }
            else vy = 0;
            // Ground friction: crumbs skid to a halt instead of sliding away.
            vx *= 0.55; vz *= 0.55;
          }
          if (isSolid(world, solid, P[p + X], P[p + Y], nz + Math.sign(vz) * half)) {
            nz = P[p + Z]; vz = 0; vx *= 0.7;
          }
        }

        P[p + X] = nx; P[p + Y] = ny; P[p + Z] = nz;
        P[p + VX] = vx; P[p + VY] = vy; P[p + VZ] = vz;
      }

      if (flags & G.SPIN) P[p + ROT] += P[p + ROTV] * dt;

      // Size envelope
      if (flags & G.SHRINK) P[p + SIZE] = P[p + SIZE0] * (1 - t);
      else if (flags & G.GROW) P[p + SIZE] = P[p + SIZE0] * (0.55 + t * 0.9);

      i++;
    }
    this.stats.alive = this.count;
  }

  /** Swap-remove, keeping the live range dense. */
  removeAt(i) {
    const last = this.count - 1;
    if (i !== last) {
      this.P.copyWithin(i * STRIDE, last * STRIDE, last * STRIDE + STRIDE);
    }
    this.count = last;
  }

  // -- rendering -----------------------------------------------------------

  ensureBuffers() {
    if (this.vao) return;
    const gl = this.gl;
    if (!gl) return;
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.ibo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
    const S4 = FLOATS_PER_VERTEX * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S4, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, S4, 20);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, S4, 36);

    const idx = new Uint32Array(this.max * 6);
    for (let q = 0; q < this.max; q++) {
      const v = q * 4, o = q * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  /**
   * Build camera-facing quads for every visible particle and draw them.
   * Alpha-blended particles go first, additive ones second, so glowing
   * particles read through the smoke in front of them.
   */
  render(renderer) {
    const r = renderer || this.renderer;
    const gl = this.gl || (r && r.gl);
    if (!gl || !r || this.count === 0) { this.stats.drawn = 0; return; }
    this.ensureBuffers();

    // Camera basis: rows 0 and 1 of the view matrix are right and up.
    const v = r.view;
    const rx = v[0], ry = v[4], rz = v[8];
    const ux = v[1], uy = v[5], uz = v[9];
    const cam = r.cameraPos;
    const frustum = r.frustum;
    const out = this.vertices;
    const P = this.P;

    let n1 = 0;                       // alpha quads, written from the front
    const additive = this.additiveIdx;
    let addCount = 0;

    for (let i = 0; i < this.count; i++) {
      const p = i * STRIDE;
      if (P[p + FLAGS] & G.ADDITIVE) {
        if (addCount < additive.length) additive[addCount++] = i;
        continue;
      }
      if (this.writeQuad(out, n1, p, rx, ry, rz, ux, uy, uz, frustum)) n1++;
    }
    let n2 = 0;
    for (let k = 0; k < addCount; k++) {
      const p = additive[k] * STRIDE;
      if (this.writeQuad(out, n1 + n2, p, rx, ry, rz, ux, uy, uz, frustum)) n2++;
    }

    const total = n1 + n2;
    this.stats.drawn = total;
    if (total === 0) return;

    const P2 = r.programs.particle;
    gl.useProgram(P2.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0,
      out.subarray(0, total * 4 * FLOATS_PER_VERTEX));

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, r.atlas);
    gl.uniform1i(P2.uniforms.uAtlas, 0);
    gl.uniformMatrix4fv(P2.uniforms.uViewProj, false, r.viewProj);
    gl.uniform3f(P2.uniforms.uCameraPos, cam.x, cam.y, cam.z);
    gl.uniform3fv(P2.uniforms.uFogColor, hexArray(r.fogColor));
    gl.uniform1f(P2.uniforms.uFogEnd, Math.max(24, r.fogEnd || 256));

    gl.enable(gl.BLEND);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (n1 > 0) {
      gl.drawElements(gl.TRIANGLES, n1 * 6, gl.UNSIGNED_INT, 0);
      r.stats.drawCalls++;
      r.stats.triangles += n1 * 2;
    }
    if (n2 > 0) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.drawElements(gl.TRIANGLES, n2 * 6, gl.UNSIGNED_INT, n1 * 6 * 4);
      r.stats.drawCalls++;
      r.stats.triangles += n2 * 2;
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
  }

  /** Write one billboard. Returns false when the particle was culled. */
  writeQuad(out, slot, p, rx, ry, rz, ux, uy, uz, frustum) {
    const P = this.P;
    const size = P[p + SIZE];
    if (size <= 0.0005) return false;
    const x = P[p + X], y = P[p + Y], z = P[p + Z];
    const half = size * 0.5;
    if (frustum && !frustum.intersectsSphere(x, y, z, half * 1.8)) return false;

    const flags = P[p + FLAGS];
    const t = P[p + AGE] / P[p + LIFE];
    let alpha = P[p + A];
    if (flags & G.FADE) alpha *= 1 - t;
    else if (t > 0.7) alpha *= 1 - (t - 0.7) / 0.3;
    if (flags & G.FLICKER) {
      alpha *= 0.72 + 0.28 * Math.sin(this.time * 34 + P[p + SEED] * 11);
    }
    if (alpha <= 0.01) return false;

    // Screen-space roll for petals and totem sparks.
    let ax = rx, ay = ry, az = rz, bx = ux, by = uy, bz = uz;
    if (flags & G.SPIN) {
      const c = Math.cos(P[p + ROT]), s = Math.sin(P[p + ROT]);
      ax = rx * c + ux * s; ay = ry * c + uy * s; az = rz * c + uz * s;
      bx = ux * c - rx * s; by = uy * c - ry * s; bz = uz * c - rz * s;
    }
    ax *= half; ay *= half; az *= half;
    bx *= half; by *= half; bz *= half;

    let layer = P[p + LAYER];
    if ((flags & G.ANIM) && GENERIC_CONTIGUOUS && layer >= 0) {
      layer += Math.min(GENERIC_FRAMES - 1, (t * GENERIC_FRAMES) | 0);
    }

    const r = P[p + R], g = P[p + GG], b = P[p + B];
    const u0 = P[p + U0], v0 = P[p + V0], u1 = P[p + U1], v1 = P[p + V1];
    let o = slot * 4 * FLOATS_PER_VERTEX;
    // (0,0) is the top-left of the sprite, so V is flipped against world up.
    writeVertex(out, o, x - ax - bx, y - ay - by, z - az - bz, u0, v1, r, g, b, alpha, layer);
    o += FLOATS_PER_VERTEX;
    writeVertex(out, o, x + ax - bx, y + ay - by, z + az - bz, u1, v1, r, g, b, alpha, layer);
    o += FLOATS_PER_VERTEX;
    writeVertex(out, o, x + ax + bx, y + ay + by, z + az + bz, u1, v0, r, g, b, alpha, layer);
    o += FLOATS_PER_VERTEX;
    writeVertex(out, o, x - ax + bx, y - ay + by, z - az + bz, u0, v0, r, g, b, alpha, layer);
    return true;
  }

  dispose() {
    const gl = this.gl;
    if (!gl || !this.vao) return;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    this.vao = null;
  }
}

// ---------------------------------------------------------------------------

const EMPTY = {};

function writeVertex(out, o, x, y, z, u, v, r, g, b, a, layer) {
  out[o] = x; out[o + 1] = y; out[o + 2] = z;
  out[o + 3] = u; out[o + 4] = v;
  out[o + 5] = r; out[o + 6] = g; out[o + 7] = b; out[o + 8] = a;
  out[o + 9] = layer;
}

function isSolid(world, solid, x, y, z) {
  const st = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
  return st !== 0 && solid[st] === 1;
}

function jitter(hex, amount, a, b, c) {
  const r = clamp(((hex >> 16) & 255) * (1 + (a - 0.5) * 2 * amount), 0, 255);
  const g = clamp(((hex >> 8) & 255) * (1 + (b - 0.5) * 2 * amount), 0, 255);
  const bl = clamp((hex & 255) * (1 + (c - 0.5) * 2 * amount), 0, 255);
  return (r << 16) | (g << 8) | bl;
}

/** Note blocks colour their particle by pitch, sweeping the whole hue wheel. */
export function noteColor(note) {
  const h = ((note % 25) / 24) * 6;
  const i = Math.floor(h) % 6, f = h - Math.floor(h);
  const q = 1 - f;
  let r, g, b;
  switch (i) {
    case 0: r = 1; g = f; b = 0; break;
    case 1: r = q; g = 1; b = 0; break;
    case 2: r = 0; g = 1; b = f; break;
    case 3: r = 0; g = q; b = 1; break;
    case 4: r = f; g = 0; b = 1; break;
    default: r = 1; g = 0; b = q; break;
  }
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

function hexArray(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
