// Status effects.
//
// An effect instance is the plain record the player and every mob already
// store: `{amplifier, duration}` keyed by effect id in an `effects` Map. This
// module owns the *behaviour* — how an amplifier scales, how often an effect
// fires, and what it does when it is added or wears off.
//
// Amplifier is zero-based: Speed II is `amplifier === 1`. The convenience
// accessor `levelOf()` returns the one-based level (0 when absent) because
// that is what damage and movement formulas want.

import { clamp } from '../core/math.js';

/** Effect categories, which decide the potion colour and milk/curse handling. */
export const CATEGORY = { BENEFICIAL: 0, HARMFUL: 1, NEUTRAL: 2 };

/** id -> Effect */
export const EFFECTS = Object.create(null);
/** Registration order, which is also the numeric id order. */
export const EFFECT_LIST = [];

let registered = false;

export class Effect {
  constructor(id, opts = {}) {
    this.id = id;
    this.numericId = opts.numericId ?? EFFECT_LIST.length + 1;
    this.name = opts.name || titleCase(id);
    this.category = opts.category ?? CATEGORY.NEUTRAL;
    this.color = opts.color ?? 0xffffff;
    this.instant = !!opts.instant;
    this.curative = opts.curative ?? (this.category === CATEGORY.HARMFUL);
    this.maxAmplifier = opts.maxAmplifier ?? 255;

    /** Ticks between periodic applications; 0 means "no periodic effect". */
    this.interval = opts.interval ?? null;
    /** Fired every `interval` ticks (or once, for instant effects). */
    this.onInterval = opts.onInterval ?? null;
    /** Fired on every tick the effect is present. */
    this.onTick = opts.onTick ?? null;
    this.onAdded = opts.onAdded ?? null;
    this.onRemoved = opts.onRemoved ?? null;

    // Passive modifiers other systems read rather than being pushed to.
    this.movement = opts.movement ?? null;        // (amp) => multiplier
    this.miningSpeed = opts.miningSpeed ?? null;  // (amp) => multiplier
    this.attackDamage = opts.attackDamage ?? null;// (amp) => flat bonus
    this.damageTaken = opts.damageTaken ?? null;  // (amp) => multiplier
    this.jump = opts.jump ?? null;                // (amp) => extra jump velocity
  }
}

export function defineEffect(id, opts = {}) {
  if (EFFECTS[id]) return EFFECTS[id];
  const e = new Effect(id, opts);
  EFFECTS[id] = e;
  EFFECT_LIST.push(e);
  return e;
}

export function getEffect(id) { return EFFECTS[id] || null; }

function titleCase(s) {
  return s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Undead mobs take healing as damage and vice versa. */
function isUndead(entity) {
  return !!(entity?.tags?.has?.('undead') || entity?.undead);
}

function hurt(entity, amount, source) {
  if (entity?.hurt) entity.hurt(amount, source);
  else if (entity && typeof entity.health === 'number') entity.health -= amount;
}

function heal(entity, amount) {
  if (entity?.heal) entity.heal(amount);
  else if (entity && typeof entity.health === 'number') {
    entity.health = Math.min(entity.maxHealth ?? 20, entity.health + amount);
  }
}

// ---------------------------------------------------------------------------
// The effect list
// ---------------------------------------------------------------------------

/**
 * Register every status effect. Idempotent, so a double boot is harmless.
 */
export function registerAllEffects() {
  if (registered) return EFFECT_LIST;
  registered = true;

  defineEffect('speed', {
    numericId: 1, category: CATEGORY.BENEFICIAL, color: 0x7cafc6,
    movement: (amp) => 1 + 0.2 * (amp + 1),
  });
  defineEffect('slowness', {
    numericId: 2, category: CATEGORY.HARMFUL, color: 0x5a6c81,
    movement: (amp) => Math.max(0, 1 - 0.15 * (amp + 1)),
  });
  defineEffect('haste', {
    numericId: 3, category: CATEGORY.BENEFICIAL, color: 0xd9c043,
    miningSpeed: (amp) => 1 + 0.2 * (amp + 1),
    attackDamage: () => 0,
  });
  defineEffect('mining_fatigue', {
    numericId: 4, category: CATEGORY.HARMFUL, color: 0x4a4217,
    // Vanilla caps the stacking penalty at four levels.
    miningSpeed: (amp) => Math.pow(0.3, Math.min(amp + 1, 4)),
  });
  defineEffect('strength', {
    numericId: 5, category: CATEGORY.BENEFICIAL, color: 0x932423,
    attackDamage: (amp) => 3 * (amp + 1),
  });
  defineEffect('instant_health', {
    numericId: 6, category: CATEGORY.BENEFICIAL, color: 0xf82423, instant: true,
    onInterval(entity, amp) {
      const amount = 4 << amp;
      if (isUndead(entity)) hurt(entity, amount, 'magic');
      else heal(entity, amount);
    },
  });
  defineEffect('instant_damage', {
    numericId: 7, category: CATEGORY.HARMFUL, color: 0x430a09, instant: true,
    onInterval(entity, amp) {
      const amount = 6 << amp;
      if (isUndead(entity)) heal(entity, amount);
      else hurt(entity, amount, 'magic');
    },
  });
  defineEffect('jump_boost', {
    numericId: 8, category: CATEGORY.BENEFICIAL, color: 0x22ff4c,
    jump: (amp) => 0.1 * (amp + 1),
  });
  defineEffect('nausea', {
    numericId: 9, category: CATEGORY.HARMFUL, color: 0x551d4a,
  });
  defineEffect('regeneration', {
    numericId: 10, category: CATEGORY.BENEFICIAL, color: 0xcd5cab,
    interval: (amp) => Math.max(50 >> amp, 1),
    onInterval(entity) {
      if ((entity.health ?? 0) < (entity.maxHealth ?? 20)) heal(entity, 1);
    },
  });
  defineEffect('resistance', {
    numericId: 11, category: CATEGORY.BENEFICIAL, color: 0x9146f0,
    damageTaken: (amp) => Math.max(0, 1 - 0.2 * (amp + 1)),
  });
  defineEffect('fire_resistance', {
    numericId: 12, category: CATEGORY.BENEFICIAL, color: 0xff9900,
    onTick(entity) { if (entity.fireTicks > 0) entity.fireTicks = 0; },
  });
  defineEffect('water_breathing', {
    numericId: 13, category: CATEGORY.BENEFICIAL, color: 0x98dac0,
    onTick(entity) {
      if (entity.airSupply != null && entity.airSupply < (entity.maxAirSupply ?? 300)) {
        entity.airSupply = entity.maxAirSupply ?? 300;
      }
    },
  });
  defineEffect('invisibility', {
    numericId: 14, category: CATEGORY.BENEFICIAL, color: 0xf6f6f6,
    onAdded(entity) { entity.invisible = true; },
    onRemoved(entity) { entity.invisible = false; },
  });
  defineEffect('blindness', {
    numericId: 15, category: CATEGORY.HARMFUL, color: 0x1f1f23,
  });
  defineEffect('night_vision', {
    numericId: 16, category: CATEGORY.BENEFICIAL, color: 0x1f1fa1,
  });
  defineEffect('hunger', {
    numericId: 17, category: CATEGORY.HARMFUL, color: 0x587653,
    onTick(entity, amp) { entity.addExhaustion?.(0.005 * (amp + 1)); },
  });
  defineEffect('weakness', {
    numericId: 18, category: CATEGORY.HARMFUL, color: 0x484d48,
    attackDamage: (amp) => -4 * (amp + 1),
  });
  defineEffect('poison', {
    numericId: 19, category: CATEGORY.HARMFUL, color: 0x4e9331,
    interval: (amp) => Math.max(25 >> amp, 1),
    onInterval(entity) {
      // Poison alone can never kill.
      if ((entity.health ?? 0) > 1) hurt(entity, 1, 'poison');
    },
  });
  defineEffect('wither', {
    numericId: 20, category: CATEGORY.HARMFUL, color: 0x352a27,
    interval: (amp) => Math.max(40 >> amp, 1),
    onInterval(entity) { hurt(entity, 1, 'wither'); },
  });
  defineEffect('health_boost', {
    numericId: 21, category: CATEGORY.BENEFICIAL, color: 0xf87d23,
    onAdded(entity, amp) {
      entity.maxHealth = (entity.baseMaxHealth ?? entity.maxHealth ?? 20) + 4 * (amp + 1);
    },
    onRemoved(entity) {
      entity.maxHealth = entity.baseMaxHealth ?? 20;
      entity.health = Math.min(entity.health, entity.maxHealth);
    },
  });
  defineEffect('absorption', {
    numericId: 22, category: CATEGORY.BENEFICIAL, color: 0x2552a5,
    onAdded(entity, amp) { entity.absorption = 4 * (amp + 1); },
    onRemoved(entity) { entity.absorption = 0; },
  });
  defineEffect('saturation', {
    numericId: 23, category: CATEGORY.BENEFICIAL, color: 0xf82423, instant: true,
    onInterval(entity, amp) {
      if (entity.food == null) return;
      entity.food = Math.min(20, entity.food + (amp + 1));
      entity.saturation = Math.min(entity.food, entity.saturation + (amp + 1) * 2);
    },
  });
  defineEffect('glowing', {
    numericId: 24, category: CATEGORY.NEUTRAL, color: 0x94a061,
    onAdded(entity) { entity.glowing = true; },
    onRemoved(entity) { entity.glowing = false; },
  });
  defineEffect('levitation', {
    numericId: 25, category: CATEGORY.HARMFUL, color: 0xceffff,
    onTick(entity, amp) {
      // Vanilla nudges vertical velocity toward 0.05 * (amp + 1) each tick.
      const target = 0.05 * (amp + 1);
      entity.vy += (target - entity.vy) * 0.2;
      entity.fallDistance = 0;
    },
  });
  defineEffect('luck', {
    numericId: 26, category: CATEGORY.BENEFICIAL, color: 0x339900,
  });
  defineEffect('unluck', {
    numericId: 27, category: CATEGORY.HARMFUL, color: 0xc0a44d,
  });
  defineEffect('slow_falling', {
    numericId: 28, category: CATEGORY.BENEFICIAL, color: 0xf7f8e0,
    onTick(entity) { if (entity.vy < 0) entity.fallDistance = 0; },
  });
  defineEffect('conduit_power', {
    numericId: 29, category: CATEGORY.BENEFICIAL, color: 0x1dc2d1,
    miningSpeed: () => 1.2,
    onTick(entity) {
      if (entity.underwater && entity.airSupply != null) {
        entity.airSupply = Math.min(entity.maxAirSupply ?? 300, entity.airSupply + 4);
      }
    },
  });
  defineEffect('dolphins_grace', {
    numericId: 30, category: CATEGORY.BENEFICIAL, color: 0x88a3be,
    movement: (amp) => (amp >= 0 ? 1.4 : 1),
  });
  defineEffect('bad_omen', {
    numericId: 31, category: CATEGORY.NEUTRAL, color: 0x0b6138, maxAmplifier: 4,
  });
  defineEffect('hero_of_the_village', {
    numericId: 32, category: CATEGORY.BENEFICIAL, color: 0x44ff44,
  });
  defineEffect('darkness', {
    numericId: 33, category: CATEGORY.HARMFUL, color: 0x292721,
  });

  return EFFECT_LIST;
}

// ---------------------------------------------------------------------------
// Applying, querying and ticking
// ---------------------------------------------------------------------------

/** The Map an entity stores its effects in, created on demand. */
function mapOf(entity) {
  if (!entity) return null;
  if (!entity.effects) entity.effects = new Map();
  return entity.effects;
}

/**
 * Apply an effect, following Minecraft's upgrade rule: a stronger effect always
 * wins, an equal-strength one only extends the duration, and a weaker one is
 * ignored (its old value is not remembered — this is not the hidden-effect
 * stack, which only matters for beacons).
 *
 * @param entity any entity with an `effects` Map
 * @param id     effect id, e.g. 'regeneration'
 * @param duration ticks (ignored for instant effects)
 * @param amplifier zero-based level
 * @returns true when the entity's effects changed
 */
export function apply(entity, id, duration = 0, amplifier = 0, opts = {}) {
  const def = EFFECTS[id];
  const amp = clamp(Math.floor(amplifier) || 0, 0, def ? def.maxAmplifier : 255);
  if (!entity) return false;

  if (def && def.instant) {
    def.onInterval?.(entity, amp, entity.world ?? opts.world ?? null);
    return true;
  }

  const map = mapOf(entity);
  const ticks = Math.max(1, Math.floor(duration));
  const existing = map.get(id);
  if (existing) {
    if (existing.amplifier > amp) return false;
    if (existing.amplifier === amp && existing.duration >= ticks) return false;
    const stronger = amp > existing.amplifier;
    existing.amplifier = amp;
    existing.duration = ticks;
    // Only a stronger effect re-runs the add hook, so absorption and
    // health_boost do not reset their pools every time a potion is topped up.
    if (stronger) def?.onAdded?.(entity, amp);
    return true;
  }

  map.set(id, { amplifier: amp, duration: ticks, ambient: !!opts.ambient,
    showParticles: opts.showParticles !== false });
  if (def && def.onAdded) {
    // Remember the unmodified maximum so health_boost can restore it later.
    if (id === 'health_boost' && entity.baseMaxHealth == null) {
      entity.baseMaxHealth = entity.maxHealth ?? 20;
    }
    def.onAdded(entity, amp);
  }
  return true;
}

/** Remove one effect, running its removal hook. */
export function remove(entity, id) {
  const map = entity?.effects;
  if (!map || !map.has(id)) return false;
  map.delete(id);
  EFFECTS[id]?.onRemoved?.(entity);
  return true;
}

/** Remove every effect (death, respawn, drinking milk). */
export function clear(entity, onlyHarmful = false) {
  const map = entity?.effects;
  if (!map) return 0;
  let n = 0;
  for (const id of [...map.keys()]) {
    if (onlyHarmful && EFFECTS[id]?.category !== CATEGORY.HARMFUL) continue;
    remove(entity, id);
    n++;
  }
  return n;
}

export function has(entity, id) { return !!entity?.effects?.has(id); }

/** Zero-based amplifier, or -1 when the effect is absent. */
export function amplifierOf(entity, id) {
  const e = entity?.effects?.get(id);
  return e ? e.amplifier : -1;
}

/** One-based level, or 0 when the effect is absent. */
export function levelOf(entity, id) {
  const e = entity?.effects?.get(id);
  return e ? e.amplifier + 1 : 0;
}

export function durationOf(entity, id) {
  return entity?.effects?.get(id)?.duration ?? 0;
}

/**
 * Advance every effect on an entity by one tick.
 *
 * @param entity  the entity to tick
 * @param world   its world, used for damage sources and particles
 * @param opts.advance  decrement durations here. The player already ages its
 *   own effects in `Player.tickTimers`, so `survival.tickPlayer` passes false
 *   and only the periodic behaviour runs.
 */
export function tick(entity, world, opts = {}) {
  const map = entity?.effects;
  if (!map || map.size === 0) return;
  const advance = opts.advance !== false;

  for (const [id, inst] of [...map]) {
    const def = EFFECTS[id];
    if (advance) {
      inst.duration--;
      if (inst.duration <= 0) { map.delete(id); def?.onRemoved?.(entity); continue; }
    } else if (inst.duration <= 0) {
      map.delete(id);
      def?.onRemoved?.(entity);
      continue;
    }
    if (!def) continue;
    def.onTick?.(entity, inst.amplifier, inst.duration, world);
    if (def.interval && def.onInterval) {
      const every = Math.max(1, def.interval(inst.amplifier) | 0);
      if (inst.duration % every === 0) def.onInterval(entity, inst.amplifier, world);
    }
  }
}

// ---------------------------------------------------------------------------
// Derived modifiers — the numbers other systems ask for
// ---------------------------------------------------------------------------

/** Combined movement-speed multiplier from speed/slowness/dolphins_grace. */
export function movementMultiplier(entity) {
  let m = 1;
  for (const [id, inst] of entity?.effects ?? []) {
    const f = EFFECTS[id]?.movement;
    if (f) m *= f(inst.amplifier);
  }
  return m;
}

/** Combined mining-speed multiplier from haste/mining_fatigue/conduit_power. */
export function miningSpeedMultiplier(entity) {
  let m = 1;
  for (const [id, inst] of entity?.effects ?? []) {
    const f = EFFECTS[id]?.miningSpeed;
    if (f) m *= f(inst.amplifier);
  }
  return m;
}

/** Flat melee damage bonus from strength minus weakness. */
export function attackDamageBonus(entity) {
  let d = 0;
  for (const [id, inst] of entity?.effects ?? []) {
    const f = EFFECTS[id]?.attackDamage;
    if (f) d += f(inst.amplifier);
  }
  return d;
}

/** Incoming-damage multiplier from resistance (0 when fully immune). */
export function damageTakenMultiplier(entity) {
  let m = 1;
  for (const [id, inst] of entity?.effects ?? []) {
    const f = EFFECTS[id]?.damageTaken;
    if (f) m *= f(inst.amplifier);
  }
  return clamp(m, 0, 1);
}

/** Extra jump velocity from jump_boost. */
export function jumpBonus(entity) {
  const e = entity?.effects?.get('jump_boost');
  return e ? 0.1 * (e.amplifier + 1) : 0;
}

/** The blended particle colour of everything currently applied. */
export function effectColor(entity) {
  let r = 0, g = 0, b = 0, total = 0;
  for (const [id, inst] of entity?.effects ?? []) {
    const c = EFFECTS[id]?.color ?? 0xffffff;
    const w = inst.amplifier + 1;
    r += ((c >> 16) & 255) * w; g += ((c >> 8) & 255) * w; b += (c & 255) * w;
    total += w;
  }
  if (!total) return 0;
  return ((r / total) << 16) | ((g / total) << 8) | (b / total | 0);
}

// ---------------------------------------------------------------------------
// EffectHolder
// ---------------------------------------------------------------------------

/**
 * An object wrapper around an entity's effect Map, for mobs and any other
 * entity that would rather hold a component than call the free functions.
 * It reads and writes the same `entity.effects` Map the player uses, so the
 * two styles interoperate.
 */
export class EffectHolder {
  constructor(entity) {
    this.entity = entity;
    if (!entity.effects) entity.effects = new Map();
  }

  get map() { return this.entity.effects; }
  get size() { return this.entity.effects.size; }

  add(id, duration, amplifier = 0, opts) { return apply(this.entity, id, duration, amplifier, opts); }
  remove(id) { return remove(this.entity, id); }
  clear(onlyHarmful = false) { return clear(this.entity, onlyHarmful); }
  has(id) { return this.entity.effects.has(id); }
  get(id) { return this.entity.effects.get(id) ?? null; }
  level(id) { return levelOf(this.entity, id); }
  amplifier(id) { return amplifierOf(this.entity, id); }
  duration(id) { return durationOf(this.entity, id); }

  tick(world, advance = true) { tick(this.entity, world, { advance }); }

  get movement() { return movementMultiplier(this.entity); }
  get miningSpeed() { return miningSpeedMultiplier(this.entity); }
  get attackBonus() { return attackDamageBonus(this.entity); }
  get damageTaken() { return damageTakenMultiplier(this.entity); }
  get color() { return effectColor(this.entity); }

  save() {
    return [...this.entity.effects].map(([id, e]) =>
      ({ id, amplifier: e.amplifier, duration: e.duration }));
  }

  load(list) {
    this.entity.effects.clear();
    for (const e of list || []) {
      this.entity.effects.set(e.id, { amplifier: e.amplifier, duration: e.duration });
    }
    return this;
  }
}
