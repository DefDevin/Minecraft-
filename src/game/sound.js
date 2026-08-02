// Audio.
//
// The game ships no audio files. Every sound here is built at runtime out of
// oscillators, filtered noise and envelopes — the same way the textures are
// painted pixel by pixel — so the whole soundtrack is source code.
//
// Signal flow:
//
//   voice ─► panner (3D) ─► bus gain ─► master gain ─► compressor ─► out
//                       └─► reverb send ─► convolver ─► return ─► master
//
// There are eight buses (music, blocks, hostile, friendly, players, ambient,
// weather, ui) under one master, so the mix can be balanced per category and a
// settings screen can mute music without touching anything else. The convolver
// is fed a procedurally generated impulse response; the send level rises as the
// listener goes underground, which is what makes caves sound like caves.
//
// A sound is a *definition* — a bus, a level, a falloff range and a function
// that schedules nodes onto a destination — registered in a plain Map at module
// load. Nothing touches the Web Audio API until a `SoundEngine` is constructed,
// so this module imports cleanly in Node for the verification scripts.

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Mix buses. `master` is the root gain and is addressable by `setVolume`. */
export const BUSES = ['music', 'blocks', 'hostile', 'friendly', 'players',
  'ambient', 'weather', 'ui'];

/** The block sound families from world/blocks.js — every one needs three cues. */
export const SOUND_FAMILIES = ['stone', 'wood', 'gravel', 'grass', 'sand', 'snow',
  'cloth', 'glass', 'metal', 'slime', 'ladder', 'anvil', 'wet_grass', 'coral',
  'nether', 'bone', 'amethyst', 'powder_snow', 'candle'];

/** Note block instruments. */
export const NOTE_INSTRUMENTS = ['harp', 'bass', 'basedrum', 'snare', 'hat',
  'guitar', 'flute', 'bell', 'chime', 'xylophone'];

/** A note block spans two octaves: F#3 to F#5, 25 semitones. */
export const NOTE_COUNT = 25;

/** Mobs with a full ambient/hurt/death set. */
export const MOB_KINDS = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman',
  'cow', 'pig', 'sheep', 'chicken', 'wolf', 'cat', 'villager', 'ghast', 'blaze',
  'slime'];

const registry = new Map();

/**
 * Register a sound.
 * @param {string} name
 * @param {string} bus one of BUSES
 * @param {(V: object) => void} play schedules nodes onto `V.out`
 * @param {object} [opts] gain, range, priority, loop, grain
 */
function define(name, bus, play, opts = {}) {
  registry.set(name, {
    name,
    bus,
    play,
    gain: opts.gain ?? 1,
    range: opts.range ?? 16,
    priority: opts.priority ?? 1,
    loop: opts.loop || null,
    grain: opts.grain ?? 0,
    reverb: opts.reverb ?? 1,
  });
}

/** Alternative spellings, resolved by `get`. */
const ALIASES = {
  'tnt.explode': 'explosion',
  'block.bell': 'bell.use',
  'entity.player.hurt': 'player.hurt',
  'entity.player.death': 'player.death',
  'block.dig': 'dig.loop',
  'random.pop': 'item.pickup',
  'random.click': 'ui.click',
  'random.orb': 'xp.orb',
  'random.explode': 'explosion',
  'random.fuse': 'tnt.prime',
  'random.bow': 'bow.shoot',
  'random.bowhit': 'arrow.hit',
  'random.drink': 'player.drink',
  'random.eat': 'player.eat',
  'random.burp': 'player.burp',
  'random.levelup': 'player.levelup',
  'random.anvil_use': 'anvil.use',
  'liquid.splash': 'water.splash',
  'liquid.swim': 'water.swim',
  'liquid.lavapop': 'lava.pop',
  'fire.fire': 'fire.crackle',
  'portal.portal': 'portal.ambient',
  'ui.button.click': 'ui.click',
};

export function getSoundDef(name) {
  const d = registry.get(name);
  if (d) return d;
  const a = ALIASES[name];
  return a ? registry.get(a) || null : null;
}

export function hasSound(name) { return !!getSoundDef(name); }

/** Every registered name, sorted. Used by scripts/check-audio.mjs. */
export function soundNames() { return [...registry.keys()].sort(); }

export function soundAliases() { return { ...ALIASES }; }

export function soundCount() { return registry.size; }

// ---------------------------------------------------------------------------
// Synthesis primitives
//
// Each takes the voice context `V` = {ctx, out, t, pitch, rnd} and schedules
// nodes. `V.t` is the start time on the AudioContext clock; `V.pitch` scales
// every frequency so `opts.pitch` works uniformly across the whole library.
// ---------------------------------------------------------------------------

const MIN_GAIN = 0.0001;

/** ADSR-ish envelope: silence -> peak over `attack`, decay to silence by `dur`. */
function envelope(param, t0, peak, attack, dur, hold = 0, curve = 'exp') {
  const p = Math.max(MIN_GAIN, peak);
  param.setValueAtTime(MIN_GAIN, t0);
  param.linearRampToValueAtTime(p, t0 + Math.max(0.0005, attack));
  const decayStart = t0 + attack + hold;
  if (hold > 0) param.setValueAtTime(p, decayStart);
  const end = Math.max(decayStart + 0.01, t0 + dur);
  if (curve === 'lin') param.linearRampToValueAtTime(MIN_GAIN, end);
  else param.exponentialRampToValueAtTime(MIN_GAIN, end);
  return end;
}

/** A single oscillator with an amplitude envelope and an optional pitch sweep. */
function tone(V, o) {
  const ctx = V.ctx;
  const t0 = V.t + (o.delay || 0);
  const dur = o.dur ?? 0.2;
  const osc = ctx.createOscillator();
  osc.type = o.type || 'sine';
  const f0 = Math.max(8, (o.freq ?? 440) * V.pitch);
  osc.frequency.setValueAtTime(f0, t0);
  if (o.freq2 !== undefined) {
    const f1 = Math.max(8, o.freq2 * V.pitch);
    if (o.sweep === 'lin') osc.frequency.linearRampToValueAtTime(f1, t0 + dur);
    else osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  }
  if (o.detune) osc.detune.setValueAtTime(o.detune, t0);
  if (o.vibrato) {
    const lfo = ctx.createOscillator();
    const amt = ctx.createGain();
    lfo.frequency.value = o.vibrato.rate ?? 5;
    amt.gain.value = o.vibrato.depth ?? 6;
    lfo.connect(amt).connect(osc.detune);
    lfo.start(t0); lfo.stop(t0 + dur + 0.1);
  }

  const g = ctx.createGain();
  osc.connect(g);
  let node = g;
  if (o.filter) node = attachFilter(ctx, g, filterSpec(o), V.pitch, t0, dur);
  node.connect(o.out || V.out);
  const end = envelope(g.gain, t0, o.gain ?? 0.3, o.attack ?? 0.004, dur,
    o.hold ?? 0, o.curve);
  osc.start(t0);
  osc.stop(end + 0.02);
  return end + 0.02;
}

/**
 * Tonal generators take their oscillator pitch from `freq`/`freq2`, so a filter
 * on top needs its own frequencies — `filterFreq`/`filterFreq2`/`filterQ`.
 * Absent those, the filter sits well above the fundamental so it colours the
 * harmonics instead of swallowing the note.
 */
function filterSpec(o) {
  return {
    filter: o.filter,
    freq: o.filterFreq ?? (o.freq ?? 440) * 4,
    freq2: o.filterFreq2,
    q: o.filterQ ?? o.q ?? 1,
    sweep: o.filterSweep,
  };
}

/** Two-operator FM — the cheapest way to get bells, mallets and brassy horns. */
function fm(V, o) {
  const ctx = V.ctx;
  const t0 = V.t + (o.delay || 0);
  const dur = o.dur ?? 0.4;
  const carrier = ctx.createOscillator();
  carrier.type = o.type || 'sine';
  const f = Math.max(8, (o.freq ?? 440) * V.pitch);
  carrier.frequency.setValueAtTime(f, t0);

  const mod = ctx.createOscillator();
  mod.type = o.modType || 'sine';
  mod.frequency.setValueAtTime(f * (o.ratio ?? 2), t0);
  const modGain = ctx.createGain();
  // The modulation index falls faster than the amplitude, which is what makes
  // an FM bell start bright and settle into a pure tone.
  envelope(modGain.gain, t0, f * (o.index ?? 3), 0.002, dur * (o.modDecay ?? 0.4));
  mod.connect(modGain).connect(carrier.frequency);

  const g = ctx.createGain();
  carrier.connect(g);
  let node = g;
  if (o.filter) node = attachFilter(ctx, g, filterSpec(o), V.pitch, t0, dur);
  node.connect(o.out || V.out);
  const end = envelope(g.gain, t0, o.gain ?? 0.25, o.attack ?? 0.003, dur, o.hold ?? 0);
  carrier.start(t0); mod.start(t0);
  carrier.stop(end + 0.02); mod.stop(end + 0.02);
  return end + 0.02;
}

/** A burst of filtered noise: footsteps, breaking, wind, splashes, hisses. */
function noise(V, o) {
  const ctx = V.ctx;
  const t0 = V.t + (o.delay || 0);
  const dur = o.dur ?? 0.15;
  const src = ctx.createBufferSource();
  src.buffer = V.engine.noiseBuffer(o.color || 'white');
  src.loop = true;
  // Start at a random offset so repeated hits never phase-cancel.
  const offset = V.rnd() * 1.5;
  src.playbackRate.value = o.rate ?? 1;

  const g = ctx.createGain();
  src.connect(g);
  let node = g;
  if (o.filter !== null) {
    node = attachFilter(ctx, g, {
      filter: o.filter || 'bandpass', freq: o.freq ?? 1200, freq2: o.freq2,
      q: o.q ?? 1, sweep: o.sweep,
    }, V.pitch, t0, dur);
  }
  node.connect(o.out || V.out);
  const end = envelope(g.gain, t0, o.gain ?? 0.3, o.attack ?? 0.002, dur,
    o.hold ?? 0, o.curve);
  src.start(t0, offset);
  src.stop(end + 0.02);
  return end + 0.02;
}

function attachFilter(ctx, input, o, pitch, t0, dur) {
  const bq = ctx.createBiquadFilter();
  bq.type = o.filter === true ? 'lowpass' : o.filter;
  const f0 = Math.max(20, (o.freq ?? 1000) * pitch);
  bq.frequency.setValueAtTime(Math.min(f0, 20000), t0);
  if (o.freq2 !== undefined) {
    const f1 = Math.max(20, Math.min(20000, o.freq2 * pitch));
    if (o.sweep === 'lin') bq.frequency.linearRampToValueAtTime(f1, t0 + dur);
    else bq.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  }
  bq.Q.value = o.q ?? 1;
  input.connect(bq);
  return bq;
}

/** A low sine thump — the body under an impact. */
function thump(V, freq, dur, gain) {
  return tone(V, { type: 'sine', freq, freq2: freq * 0.45, dur, gain, attack: 0.002 });
}

// ---------------------------------------------------------------------------
// Block sound families
//
// One parameter block per family drives all four cues (step, dig, break,
// place), so a new family is one line and every cue stays consistent with it.
// ---------------------------------------------------------------------------

const FAMILY = {
  //             noise colour  centre  Q     length  tonal  tone Hz  ring
  stone: { color: 'white', freq: 950, q: 0.9, dur: 0.15, tone: 0.16, toneFreq: 170 },
  wood: { color: 'brown', freq: 700, q: 1.5, dur: 0.16, tone: 0.42, toneFreq: 300, ring: 0.10 },
  gravel: { color: 'white', freq: 1600, q: 0.45, dur: 0.21, tone: 0.04, toneFreq: 130 },
  grass: { color: 'pink', freq: 2800, q: 0.4, dur: 0.14, tone: 0.03, toneFreq: 480 },
  sand: { color: 'pink', freq: 3600, q: 0.3, dur: 0.17, tone: 0.02, toneFreq: 300 },
  snow: { color: 'pink', freq: 1900, q: 0.55, dur: 0.15, tone: 0.06, toneFreq: 420 },
  cloth: { color: 'brown', freq: 900, q: 0.5, dur: 0.15, tone: 0.03, toneFreq: 210 },
  glass: { color: 'white', freq: 4400, q: 3.0, dur: 0.20, tone: 0.55, toneFreq: 2700, ring: 0.35 },
  metal: { color: 'white', freq: 2300, q: 4.0, dur: 0.28, tone: 0.55, toneFreq: 760, ring: 0.30 },
  slime: { color: 'brown', freq: 420, q: 2.2, dur: 0.24, tone: 0.62, toneFreq: 150, squelch: true },
  ladder: { color: 'brown', freq: 850, q: 2.0, dur: 0.13, tone: 0.32, toneFreq: 430, ring: 0.08 },
  anvil: { color: 'white', freq: 1750, q: 5.0, dur: 0.45, tone: 0.72, toneFreq: 250, ring: 0.55 },
  wet_grass: { color: 'pink', freq: 1500, q: 0.7, dur: 0.17, tone: 0.10, toneFreq: 330 },
  coral: { color: 'white', freq: 2500, q: 2.2, dur: 0.20, tone: 0.36, toneFreq: 900, ring: 0.18 },
  nether: { color: 'brown', freq: 760, q: 0.8, dur: 0.23, tone: 0.18, toneFreq: 190 },
  bone: { color: 'white', freq: 2000, q: 2.5, dur: 0.17, tone: 0.42, toneFreq: 640, ring: 0.15 },
  amethyst: { color: 'white', freq: 3300, q: 6.0, dur: 0.45, tone: 0.78, toneFreq: 1480, ring: 0.6 },
  powder_snow: { color: 'pink', freq: 1250, q: 0.4, dur: 0.21, tone: 0.02, toneFreq: 260 },
  candle: { color: 'pink', freq: 2100, q: 0.6, dur: 0.11, tone: 0.16, toneFreq: 620 },
};

/** Footstep: a short, soft, slightly random scuff. */
function familyStep(f) {
  return (V) => {
    const jit = 0.86 + V.rnd() * 0.28;
    noise(V, {
      color: f.color, filter: 'bandpass', freq: f.freq * jit * 0.8, freq2: f.freq * jit * 0.45,
      q: f.q + 0.4, dur: f.dur * 0.55, gain: 0.30, attack: 0.001,
    });
    if (f.tone > 0.05) {
      thump(V, f.toneFreq * jit, f.dur * 0.5, 0.14 * f.tone + 0.05);
    }
    if (f.squelch) {
      tone(V, { type: 'sine', freq: f.toneFreq * 1.4, freq2: f.toneFreq * 0.5,
        dur: f.dur * 0.7, gain: 0.14, delay: 0.01 });
    }
  };
}

/** Digging grain: quieter and shorter than breaking; looped while mining. */
function familyDig(f) {
  return (V) => {
    const jit = 0.8 + V.rnd() * 0.4;
    noise(V, {
      color: f.color, filter: 'bandpass', freq: f.freq * jit, freq2: f.freq * jit * 0.6,
      q: f.q + 1, dur: f.dur * 0.45, gain: 0.24, attack: 0.001,
    });
    if (f.tone > 0.2) thump(V, f.toneFreq * jit * 1.2, f.dur * 0.35, 0.10);
  };
}

/** Break: three overlapping grains so the block crumbles rather than clicks. */
function familyBreak(f) {
  return (V) => {
    for (let i = 0; i < 3; i++) {
      const jit = 0.7 + V.rnd() * 0.6;
      noise(V, {
        color: f.color, filter: 'bandpass',
        freq: f.freq * jit, freq2: f.freq * jit * 0.35,
        q: f.q, dur: f.dur * (0.7 + i * 0.25), gain: 0.30 / (1 + i * 0.7),
        delay: i * 0.035 * (0.6 + V.rnd()), attack: 0.001,
      });
    }
    thump(V, f.toneFreq, f.dur * 1.1, 0.16 + f.tone * 0.2);
    if (f.ring) {
      // Glass, metal, amethyst and anvils ring after the impact.
      fm(V, { freq: f.toneFreq * 4.2, ratio: 2.4, index: 4, dur: f.dur * 3.5,
        gain: 0.10 * f.ring * 3, delay: 0.005 });
    }
    if (f.squelch) {
      tone(V, { type: 'sine', freq: f.toneFreq * 2, freq2: f.toneFreq * 0.4,
        dur: 0.3, gain: 0.2, delay: 0.02 });
    }
  };
}

/** Place: one firm, tight impact. */
function familyPlace(f) {
  return (V) => {
    noise(V, {
      color: f.color, filter: 'bandpass', freq: f.freq * 0.75, freq2: f.freq * 0.3,
      q: f.q + 0.6, dur: f.dur * 0.7, gain: 0.34, attack: 0.001,
    });
    thump(V, f.toneFreq * 0.9, f.dur * 0.9, 0.22 + f.tone * 0.18);
    if (f.ring) {
      fm(V, { freq: f.toneFreq * 3.4, ratio: 2.1, index: 2.5, dur: f.dur * 2,
        gain: 0.07 * f.ring * 3 });
    }
  };
}

for (const [name, f] of Object.entries(FAMILY)) {
  define(`step.${name}`, 'players', familyStep(f), { gain: 0.55, range: 16, priority: 0 });
  define(`dig.${name}`, 'blocks', familyDig(f), { gain: 0.7, range: 16, priority: 0 });
  define(`break.${name}`, 'blocks', familyBreak(f), { gain: 1, range: 20 });
  define(`place.${name}`, 'blocks', familyPlace(f), { gain: 1, range: 20 });
}

/** Generic mining loop, retriggered as a grain train by `startLoop`. */
define('dig.loop', 'blocks', familyDig(FAMILY.stone), { gain: 0.6, range: 16, grain: 0.16 });

// ---------------------------------------------------------------------------
// Items, UI and interaction
// ---------------------------------------------------------------------------

define('item.pickup', 'players', (V) => {
  tone(V, { type: 'square', freq: 620, freq2: 1240, dur: 0.09, gain: 0.10,
    filter: 'lowpass', filterFreq: 2600, filterQ: 1 });
  tone(V, { type: 'sine', freq: 940, freq2: 1560, dur: 0.11, gain: 0.09, delay: 0.02 });
}, { gain: 0.8, range: 12 });

define('item.drop', 'players', (V) => {
  noise(V, { color: 'white', filter: 'bandpass', freq: 1600, freq2: 700, q: 1.2,
    dur: 0.1, gain: 0.16 });
  tone(V, { type: 'sine', freq: 320, freq2: 180, dur: 0.11, gain: 0.14 });
}, { gain: 0.7, range: 12 });

define('item.break', 'players', (V) => {
  for (let i = 0; i < 4; i++) {
    noise(V, { color: 'white', filter: 'bandpass', freq: 2600 - i * 400, q: 2.5,
      dur: 0.09, gain: 0.16, delay: i * 0.03 });
  }
  thump(V, 240, 0.16, 0.14);
}, { gain: 0.9, range: 14 });

define('xp.orb', 'players', (V) => {
  const base = 520 + V.rnd() * 180;
  fm(V, { freq: base, ratio: 3, index: 2.5, dur: 0.18, gain: 0.10 });
  fm(V, { freq: base * 1.5, ratio: 3, index: 2, dur: 0.16, gain: 0.07, delay: 0.05 });
}, { gain: 0.6, range: 12 });

define('player.levelup', 'players', (V) => {
  // A rising major arpeggio with a bell timbre.
  const steps = [0, 4, 7, 12, 16];
  steps.forEach((s, i) => {
    fm(V, { freq: 440 * Math.pow(2, s / 12), ratio: 2, index: 3.2,
      dur: 0.9 - i * 0.08, gain: 0.09, delay: i * 0.07, modDecay: 0.3 });
  });
}, { gain: 1, range: 24 });

define('ui.craft', 'ui', (V) => {
  noise(V, { color: 'white', filter: 'bandpass', freq: 2400, freq2: 1100, q: 1.6,
    dur: 0.12, gain: 0.16 });
  tone(V, { type: 'triangle', freq: 700, freq2: 980, dur: 0.12, gain: 0.10, delay: 0.03 });
  tone(V, { type: 'triangle', freq: 980, freq2: 1320, dur: 0.12, gain: 0.08, delay: 0.09 });
}, { gain: 0.8, range: 10, reverb: 0.2 });

define('ui.click', 'ui', (V) => {
  tone(V, { type: 'square', freq: 900, freq2: 640, dur: 0.05, gain: 0.09,
    filter: 'lowpass', filterFreq: 3200, filterQ: 0.7 });
}, { gain: 0.7, range: 8, reverb: 0 });

// --- doors, gates, chests, buttons ----------------------------------------

/** A creak: a filtered noise band whose centre slides, plus a wooden knock. */
function creak(up) {
  return (V) => {
    const a = up ? 320 : 520, b = up ? 520 : 300;
    noise(V, { color: 'brown', filter: 'bandpass', freq: a, freq2: b, q: 6,
      dur: 0.42, gain: 0.20, attack: 0.03, sweep: 'exp' });
    noise(V, { color: 'white', filter: 'bandpass', freq: 1800, q: 2, dur: 0.07,
      gain: 0.10, delay: 0.38 });
    thump(V, 150, 0.2, 0.16, 0.4);
  };
}

define('open.door', 'blocks', creak(true), { gain: 1, range: 20 });
define('close.door', 'blocks', creak(false), { gain: 1, range: 20 });
define('open.trapdoor', 'blocks', creak(true), { gain: 0.8, range: 16 });
define('close.trapdoor', 'blocks', creak(false), { gain: 0.8, range: 16 });
define('open.fence_gate', 'blocks', creak(true), { gain: 0.85, range: 18 });
define('close.fence_gate', 'blocks', creak(false), { gain: 0.85, range: 18 });

define('chest.open', 'blocks', (V) => {
  noise(V, { color: 'brown', filter: 'bandpass', freq: 700, freq2: 1500, q: 3,
    dur: 0.3, gain: 0.16, attack: 0.02 });
  noise(V, { color: 'white', filter: 'highpass', freq: 2000, q: 0.8, dur: 0.1,
    gain: 0.08, delay: 0.02 });
}, { gain: 0.9, range: 16 });

define('chest.close', 'blocks', (V) => {
  noise(V, { color: 'brown', filter: 'bandpass', freq: 1400, freq2: 500, q: 3,
    dur: 0.22, gain: 0.16 });
  thump(V, 170, 0.18, 0.24);
}, { gain: 0.9, range: 16 });

/** Lever/button/repeater clicks differ only in pitch and body. */
function clicker(freq, body, dur = 0.06) {
  return (V) => {
    noise(V, { color: 'white', filter: 'bandpass', freq, q: 6, dur, gain: 0.20 });
    tone(V, { type: 'square', freq: body, freq2: body * 0.6, dur: dur * 1.4, gain: 0.08 });
  };
}

define('click.on', 'blocks', clicker(2400, 620), { gain: 0.8, range: 14 });
define('click.off', 'blocks', clicker(1900, 480), { gain: 0.8, range: 14 });
define('click.button', 'blocks', clicker(2600, 700), { gain: 0.8, range: 14 });
define('click.lever', 'blocks', clicker(2200, 540), { gain: 0.8, range: 14 });
define('click.repeater', 'blocks', clicker(3000, 820, 0.05), { gain: 0.6, range: 12 });
define('click.comparator', 'blocks', clicker(3400, 900, 0.05), { gain: 0.6, range: 12 });

define('piston.extend', 'blocks', (V) => {
  noise(V, { color: 'brown', filter: 'bandpass', freq: 500, freq2: 1200, q: 2.5,
    dur: 0.18, gain: 0.22, attack: 0.01 });
  tone(V, { type: 'sawtooth', freq: 180, freq2: 300, dur: 0.16, gain: 0.07,
    filter: 'lowpass', freq2Filter: 0 });
  thump(V, 120, 0.12, 0.16, 0.16);
}, { gain: 0.9, range: 20 });

define('piston.retract', 'blocks', (V) => {
  noise(V, { color: 'brown', filter: 'bandpass', freq: 1100, freq2: 420, q: 2.5,
    dur: 0.18, gain: 0.22, attack: 0.01 });
  thump(V, 140, 0.14, 0.18);
}, { gain: 0.9, range: 20 });

define('bell.use', 'blocks', (V) => {
  fm(V, { freq: 523.25, ratio: 2.76, index: 6, dur: 4.5, gain: 0.22, modDecay: 0.12 });
  fm(V, { freq: 523.25 * 1.5, ratio: 3.01, index: 4, dur: 3.0, gain: 0.10,
    modDecay: 0.1, delay: 0.005 });
  noise(V, { color: 'white', filter: 'highpass', freq: 4000, dur: 0.05, gain: 0.10 });
}, { gain: 1.2, range: 64 });

define('anvil.use', 'blocks', (V) => {
  noise(V, { color: 'white', filter: 'bandpass', freq: 2600, q: 3, dur: 0.12, gain: 0.24 });
  fm(V, { freq: 220, ratio: 4.7, index: 8, dur: 1.1, gain: 0.18, modDecay: 0.15 });
  thump(V, 90, 0.3, 0.3);
}, { gain: 1, range: 24 });

define('anvil.land', 'blocks', (V) => {
  noise(V, { color: 'white', filter: 'bandpass', freq: 1800, q: 2, dur: 0.25, gain: 0.3 });
  fm(V, { freq: 160, ratio: 3.9, index: 10, dur: 1.6, gain: 0.24, modDecay: 0.2 });
  thump(V, 60, 0.5, 0.4);
}, { gain: 1.2, range: 40 });

define('anvil.break', 'blocks', (V) => {
  for (let i = 0; i < 5; i++) {
    noise(V, { color: 'white', filter: 'bandpass', freq: 3000 - i * 380, q: 4,
      dur: 0.16, gain: 0.2, delay: i * 0.04 });
  }
  fm(V, { freq: 130, ratio: 5.3, index: 9, dur: 1.2, gain: 0.2, modDecay: 0.2 });
}, { gain: 1.1, range: 32 });

// ---------------------------------------------------------------------------
// Note block
// ---------------------------------------------------------------------------

/** F#3 with `pitch` = 1 — the note block's lowest note. */
export const NOTE_BASE_FREQ = 184.997;

/** Frequency of note 0..24 for a note block. */
export function noteFrequency(note) {
  return NOTE_BASE_FREQ * Math.pow(2, (Math.max(0, Math.min(NOTE_COUNT - 1, note)) - 12) / 12);
}

const INSTRUMENT = {
  harp: (V) => {
    fm(V, { freq: 523.25, ratio: 2, index: 2.2, dur: 1.0, gain: 0.18, modDecay: 0.25 });
    fm(V, { freq: 1046.5, ratio: 3, index: 1.2, dur: 0.5, gain: 0.05 });
  },
  bass: (V) => {
    tone(V, { type: 'triangle', freq: 130.81, dur: 1.1, gain: 0.30,
      filter: 'lowpass', q: 2 });
    tone(V, { type: 'sine', freq: 65.4, dur: 1.0, gain: 0.20 });
  },
  basedrum: (V) => {
    tone(V, { type: 'sine', freq: 150, freq2: 42, dur: 0.35, gain: 0.42 });
    noise(V, { color: 'brown', filter: 'lowpass', freq: 400, dur: 0.1, gain: 0.12 });
  },
  snare: (V) => {
    noise(V, { color: 'white', filter: 'highpass', freq: 1400, dur: 0.19, gain: 0.26 });
    tone(V, { type: 'triangle', freq: 220, freq2: 150, dur: 0.1, gain: 0.12 });
  },
  hat: (V) => {
    noise(V, { color: 'white', filter: 'highpass', freq: 7000, dur: 0.07, gain: 0.20 });
    noise(V, { color: 'white', filter: 'bandpass', freq: 11000, q: 2, dur: 0.05, gain: 0.10 });
  },
  guitar: (V) => {
    tone(V, { type: 'sawtooth', freq: 261.63, dur: 0.8, gain: 0.16,
      filter: 'lowpass', freq: 2200, freq2: 500, q: 3 });
    noise(V, { color: 'white', filter: 'bandpass', freq: 3000, q: 3, dur: 0.03, gain: 0.08 });
  },
  flute: (V) => {
    tone(V, { type: 'sine', freq: 523.25, dur: 0.9, gain: 0.20, attack: 0.06,
      vibrato: { rate: 5.2, depth: 8 } });
    noise(V, { color: 'pink', filter: 'bandpass', freq: 2400, q: 1.2, dur: 0.25,
      gain: 0.05, attack: 0.05 });
  },
  bell: (V) => {
    fm(V, { freq: 1046.5, ratio: 2.76, index: 5, dur: 2.4, gain: 0.16, modDecay: 0.12 });
    fm(V, { freq: 1568, ratio: 3.4, index: 3, dur: 1.4, gain: 0.06 });
  },
  chime: (V) => {
    fm(V, { freq: 1567.98, ratio: 4.2, index: 3, dur: 2.0, gain: 0.12, modDecay: 0.1 });
    fm(V, { freq: 2093, ratio: 5.4, index: 2, dur: 1.2, gain: 0.05 });
  },
  xylophone: (V) => {
    fm(V, { freq: 1046.5, ratio: 3.0, index: 4, dur: 0.5, gain: 0.18, modDecay: 0.18 });
    noise(V, { color: 'white', filter: 'bandpass', freq: 5000, q: 4, dur: 0.03, gain: 0.08 });
  },
};

for (const name of NOTE_INSTRUMENTS) {
  define(`note.${name}`, 'blocks', INSTRUMENT[name], { gain: 1, range: 48 });
}

// ---------------------------------------------------------------------------
// Explosions, fire, lava
// ---------------------------------------------------------------------------

define('explosion', 'blocks', (V) => {
  noise(V, { color: 'brown', filter: 'lowpass', freq: 900, freq2: 90, q: 1,
    dur: 1.5, gain: 0.55, attack: 0.004, curve: 'exp' });
  noise(V, { color: 'white', filter: 'highpass', freq: 1800, freq2: 400,
    dur: 0.45, gain: 0.28 });
  tone(V, { type: 'sine', freq: 90, freq2: 28, dur: 1.0, gain: 0.5 });
  // Slap-back off the surroundings.
  noise(V, { color: 'brown', filter: 'lowpass', freq: 500, freq2: 120,
    dur: 0.9, gain: 0.14, delay: 0.12 });
}, { gain: 1.4, range: 96, priority: 3 });

define('tnt.prime', 'blocks', (V) => {
  noise(V, { color: 'white', filter: 'highpass', freq: 4500, dur: 0.5, gain: 0.14,
    attack: 0.02, curve: 'lin' });
  tone(V, { type: 'sine', freq: 1400, freq2: 2200, dur: 0.12, gain: 0.06 });
}, { gain: 0.9, range: 32, grain: 0.5 });

define('fire.ignite', 'blocks', (V) => {
  noise(V, { color: 'white', filter: 'bandpass', freq: 2600, freq2: 900, q: 1.4,
    dur: 0.3, gain: 0.22 });
  noise(V, { color: 'white', filter: 'highpass', freq: 5000, dur: 0.07, gain: 0.2 });
}, { gain: 0.9, range: 16 });

define('extinguish.fire', 'blocks', (V) => {
  noise(V, { color: 'white', filter: 'bandpass', freq: 5000, freq2: 800, q: 0.8,
    dur: 0.5, gain: 0.26, attack: 0.005 });
}, { gain: 0.9, range: 16 });

define('extinguish.candle', 'blocks', (V) => {
  noise(V, { color: 'pink', filter: 'bandpass', freq: 2400, freq2: 600, q: 0.9,
    dur: 0.2, gain: 0.16 });
}, { gain: 0.6, range: 12 });

define('fire.crackle', 'ambient', (V) => {
  // One crackle grain; the loop schedules a stream of them.
  noise(V, { color: 'brown', filter: 'bandpass', freq: 500 + V.rnd() * 2500,
    q: 2 + V.rnd() * 4, dur: 0.04 + V.rnd() * 0.06, gain: 0.10 + V.rnd() * 0.12 });
}, {
  gain: 0.7,
  range: 16,
  grain: 0.09,
  loop: (V) => {
    // Steady bed of filtered noise under the crackles.
    const ctx = V.ctx;
    const src = ctx.createBufferSource();
    src.buffer = V.engine.noiseBuffer('brown');
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.value = 0.16;
    src.connect(bp).connect(g).connect(V.out);
    src.start(V.t);
    return { sources: [src], gain: g };
  },
});

define('furnace.crackle', 'ambient', (V) => {
  noise(V, { color: 'brown', filter: 'bandpass', freq: 400 + V.rnd() * 1200,
    q: 3, dur: 0.05, gain: 0.08 });
}, {
  gain: 0.5,
  range: 12,
  grain: 0.17,
  loop: (V) => {
    const ctx = V.ctx;
    const src = ctx.createBufferSource();
    src.buffer = V.engine.noiseBuffer('brown');
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.1;
    src.connect(lp).connect(g).connect(V.out);
    src.start(V.t);
    return { sources: [src], gain: g };
  },
});

define('lava.pop', 'blocks', (V) => {
  tone(V, { type: 'sine', freq: 180 + V.rnd() * 220, freq2: 60, dur: 0.16, gain: 0.22 });
  noise(V, { color: 'brown', filter: 'lowpass', freq: 900, dur: 0.1, gain: 0.12 });
}, { gain: 0.8, range: 18 });

define('lava.ambient', 'ambient', (V) => {
  noise(V, { color: 'brown', filter: 'lowpass', freq: 320, dur: 0.6, gain: 0.06,
    attack: 0.2, curve: 'lin' });
}, {
  gain: 0.6,
  range: 16,
  grain: 0.7,
  loop: (V) => {
    const ctx = V.ctx;
    const src = ctx.createBufferSource();
    src.buffer = V.engine.noiseBuffer('brown');
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 240;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    src.connect(lp).connect(g).connect(V.out);
    src.start(V.t);
    return { sources: [src], gain: g };
  },
});

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

define('water.splash', 'players', (V) => {
  noise(V, { color: 'white', filter: 'bandpass', freq: 900, freq2: 3600, q: 0.6,
    dur: 0.35, gain: 0.30, attack: 0.004 });
  noise(V, { color: 'pink', filter: 'highpass', freq: 2500, dur: 0.25, gain: 0.16,
    delay: 0.03 });
  tone(V, { type: 'sine', freq: 420, freq2: 900, dur: 0.16, gain: 0.08 });
}, { gain: 1, range: 24 });

define('water.swim', 'players', (V) => {
  noise(V, { color: 'pink', filter: 'bandpass', freq: 700, freq2: 1800, q: 1.1,
    dur: 0.28, gain: 0.16, attack: 0.05 });
}, { gain: 0.7, range: 14, grain: 0.32 });

define('water.bubbles', 'ambient', (V) => {
  for (let i = 0; i < 3; i++) {
    tone(V, { type: 'sine', freq: 500 + V.rnd() * 900, freq2: 1400 + V.rnd() * 900,
      dur: 0.07, gain: 0.07, delay: i * 0.06 * V.rnd() });
  }
}, { gain: 0.6, range: 12, grain: 0.4 });

define('bubble.pop', 'ambient', (V) => {
  tone(V, { type: 'sine', freq: 700, freq2: 2000, dur: 0.05, gain: 0.09 });
}, { gain: 0.5, range: 10 });

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

define('weather.rain', 'weather', (V) => {
  noise(V, { color: 'white', filter: 'highpass', freq: 1500, dur: 0.3, gain: 0.1 });
}, {
  gain: 1,
  range: 1e9,
  reverb: 0.3,
  loop: (V) => {
    const ctx = V.ctx;
    const src = ctx.createBufferSource();
    src.buffer = V.engine.noiseBuffer('white');
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.value = 0.3;
    // A second, slower layer gives the hiss some body and movement.
    const src2 = ctx.createBufferSource();
    src2.buffer = V.engine.noiseBuffer('pink');
    src2.loop = true;
    src2.playbackRate.value = 0.7;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.4;
    const g2 = ctx.createGain();
    g2.gain.value = 0.22;
    src.connect(hp).connect(lp).connect(g).connect(V.out);
    src2.connect(bp).connect(g2).connect(g);
    src.start(V.t); src2.start(V.t);
    return { sources: [src, src2], gain: g };
  },
});

define('weather.wind', 'weather', (V) => {
  noise(V, { color: 'pink', filter: 'bandpass', freq: 400, q: 0.6, dur: 1.5,
    gain: 0.08, attack: 0.6, curve: 'lin' });
}, {
  gain: 1,
  range: 1e9,
  loop: (V) => {
    const ctx = V.ctx;
    const src = ctx.createBufferSource();
    src.buffer = V.engine.noiseBuffer('pink');
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.value = 0.25;
    // Slow LFO on the filter so the wind gusts instead of droning.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 260;
    lfo.connect(lfoAmt).connect(bp.frequency);
    lfo.start(V.t);
    src.connect(bp).connect(g).connect(V.out);
    src.start(V.t);
    return { sources: [src], oscillators: [lfo], gain: g };
  },
});

define('weather.thunder', 'weather', (V) => {
  // The crack, then a long rumble that wanders in the low end.
  noise(V, { color: 'white', filter: 'highpass', freq: 2200, freq2: 500,
    dur: 0.35, gain: 0.30 });
  noise(V, { color: 'brown', filter: 'lowpass', freq: 600, freq2: 70, q: 0.8,
    dur: 3.2, gain: 0.55, attack: 0.02 });
  noise(V, { color: 'brown', filter: 'lowpass', freq: 260, freq2: 60,
    dur: 4.5, gain: 0.32, attack: 0.4, delay: 0.5, curve: 'lin' });
  tone(V, { type: 'sine', freq: 55, freq2: 26, dur: 2.4, gain: 0.34 });
}, { gain: 1.6, range: 1e9, priority: 4, reverb: 1.5 });

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

define('bow.shoot', 'players', (V) => {
  noise(V, { color: 'white', filter: 'bandpass', freq: 2600, freq2: 900, q: 1.2,
    dur: 0.18, gain: 0.22 });
  tone(V, { type: 'triangle', freq: 320, freq2: 140, dur: 0.16, gain: 0.10 });
}, { gain: 0.9, range: 20 });

define('arrow.hit', 'players', (V) => {
  noise(V, { color: 'white', filter: 'bandpass', freq: 1800, q: 3, dur: 0.09, gain: 0.2 });
  thump(V, 260, 0.1, 0.12);
}, { gain: 0.8, range: 16 });

define('sword.swing', 'players', (V) => {
  noise(V, { color: 'pink', filter: 'bandpass', freq: 900, freq2: 3000, q: 1.6,
    dur: 0.16, gain: 0.18, attack: 0.03 });
}, { gain: 0.7, range: 14 });

define('player.hurt', 'players', (V) => {
  tone(V, { type: 'sawtooth', freq: 300, freq2: 190, dur: 0.28, gain: 0.16,
    filter: 'lowpass', freq: 1400, freq2: 500, q: 2 });
  noise(V, { color: 'pink', filter: 'bandpass', freq: 700, q: 1.2, dur: 0.2, gain: 0.1 });
}, { gain: 1, range: 20 });

define('player.death', 'players', (V) => {
  tone(V, { type: 'sawtooth', freq: 320, freq2: 90, dur: 1.1, gain: 0.2,
    filter: 'lowpass', freq: 1600, freq2: 260, q: 2 });
  tone(V, { type: 'triangle', freq: 220, freq2: 70, dur: 1.3, gain: 0.14, delay: 0.08 });
}, { gain: 1.1, range: 24 });

define('player.eat', 'players', (V) => {
  for (let i = 0; i < 2; i++) {
    noise(V, { color: 'brown', filter: 'bandpass', freq: 600 + V.rnd() * 500, q: 2.2,
      dur: 0.09, gain: 0.14, delay: i * 0.1 });
  }
}, { gain: 0.6, range: 10, grain: 0.4 });

define('player.drink', 'players', (V) => {
  for (let i = 0; i < 3; i++) {
    tone(V, { type: 'sine', freq: 260 + i * 40, freq2: 150, dur: 0.1, gain: 0.12,
      delay: i * 0.12 });
    noise(V, { color: 'brown', filter: 'lowpass', freq: 700, dur: 0.08, gain: 0.07,
      delay: i * 0.12 });
  }
}, { gain: 0.6, range: 10 });

define('player.burp', 'players', (V) => {
  tone(V, { type: 'sawtooth', freq: 150, freq2: 90, dur: 0.35, gain: 0.18,
    filter: 'lowpass', freq: 900, freq2: 300, q: 4, vibrato: { rate: 22, depth: 60 } });
}, { gain: 0.7, range: 12 });

// ---------------------------------------------------------------------------
// Mobs
//
// Each kind gets a voice recipe; ambient/hurt/death are the same voice with
// different pitch envelopes and lengths, which is exactly how the real game's
// sounds relate to one another.
// ---------------------------------------------------------------------------

const MOB = {
  zombie: { type: 'sawtooth', f: 150, spread: 0.35, filt: 700, q: 4, growl: 14, noise: 0.5, dur: 0.9 },
  skeleton: { type: 'square', f: 420, spread: 0.2, filt: 2600, q: 6, growl: 0, noise: 1.2, dur: 0.4, rattle: true },
  creeper: { type: 'sine', f: 200, spread: 0.1, filt: 4000, q: 0.6, growl: 0, noise: 2.2, dur: 1.2, hiss: true },
  spider: { type: 'square', f: 900, spread: 0.5, filt: 3000, q: 8, growl: 30, noise: 1.0, dur: 0.35 },
  enderman: { type: 'sawtooth', f: 110, spread: 0.6, filt: 500, q: 8, growl: 5, noise: 0.6, dur: 1.4 },
  cow: { type: 'sawtooth', f: 160, spread: 0.15, filt: 900, q: 3, growl: 5, noise: 0.3, dur: 1.3 },
  pig: { type: 'square', f: 240, spread: 0.3, filt: 1400, q: 5, growl: 18, noise: 0.5, dur: 0.5 },
  sheep: { type: 'sawtooth', f: 330, spread: 0.2, filt: 1600, q: 4, growl: 24, noise: 0.4, dur: 0.8 },
  chicken: { type: 'square', f: 780, spread: 0.4, filt: 2600, q: 6, growl: 12, noise: 0.5, dur: 0.3 },
  wolf: { type: 'sawtooth', f: 260, spread: 0.3, filt: 1300, q: 4, growl: 10, noise: 0.6, dur: 0.5 },
  cat: { type: 'sawtooth', f: 620, spread: 0.25, filt: 2000, q: 5, growl: 6, noise: 0.4, dur: 0.7 },
  villager: { type: 'sawtooth', f: 190, spread: 0.25, filt: 1100, q: 6, growl: 9, noise: 0.4, dur: 0.6 },
  ghast: { type: 'triangle', f: 300, spread: 0.5, filt: 1500, q: 2, growl: 3, noise: 0.8, dur: 2.2 },
  blaze: { type: 'sawtooth', f: 130, spread: 0.2, filt: 800, q: 2, growl: 4, noise: 2.4, dur: 1.6 },
  slime: { type: 'sine', f: 180, spread: 0.4, filt: 700, q: 3, growl: 0, noise: 0.8, dur: 0.35, squish: true },
};

/**
 * Build one mob vocalisation.
 * @param {object} m recipe
 * @param {'ambient'|'hurt'|'death'} kind
 */
function mobVoice(m, kind) {
  return (V) => {
    const jitter = 1 + (V.rnd() - 0.5) * m.spread;
    const dur = m.dur * (kind === 'death' ? 1.7 : kind === 'hurt' ? 0.55 : 1);
    const level = kind === 'ambient' ? 0.16 : kind === 'hurt' ? 0.24 : 0.26;
    // Ambient calls drift; hurt jumps up then falls; death slides all the way down.
    const f0 = m.f * jitter * (kind === 'hurt' ? 1.35 : 1);
    const f1 = kind === 'death' ? m.f * jitter * 0.35
      : kind === 'hurt' ? m.f * jitter * 0.8
        : m.f * jitter * (V.rnd() > 0.5 ? 1.25 : 0.8);

    if (m.noise < 2) {
      tone(V, {
        type: m.type, freq: f0, freq2: f1, dur, gain: level,
        filter: 'lowpass', q: m.q, attack: 0.02,
        vibrato: m.growl ? { rate: m.growl, depth: 40 } : null,
      });
      tone(V, {
        type: m.type, freq: f0 * 1.5, freq2: f1 * 1.5, dur: dur * 0.7,
        gain: level * 0.4, filter: 'bandpass', q: m.q, delay: 0.01,
      });
    }
    if (m.noise > 0) {
      noise(V, {
        color: m.noise > 1.5 ? 'white' : 'pink', filter: 'bandpass',
        freq: m.filt * jitter, freq2: m.filt * jitter * (kind === 'death' ? 0.4 : 0.8),
        q: m.q * 0.5, dur: dur * 0.9, gain: level * 0.5 * m.noise,
        attack: m.hiss ? 0.12 : 0.01,
      });
    }
    if (m.rattle) {
      for (let i = 0; i < 4; i++) {
        noise(V, { color: 'white', filter: 'bandpass', freq: 2600 + V.rnd() * 1800,
          q: 12, dur: 0.05, gain: level * 0.5, delay: i * 0.055 });
      }
    }
    if (m.squish) {
      tone(V, { type: 'sine', freq: f0 * 2.4, freq2: f0 * 0.5, dur: dur * 1.4,
        gain: level * 0.7, delay: 0.02 });
    }
  };
}

for (const kind of MOB_KINDS) {
  const m = MOB[kind];
  const bus = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'blaze', 'slime', 'ghast']
    .includes(kind) ? 'hostile' : 'friendly';
  define(`mob.${kind}.ambient`, bus, mobVoice(m, 'ambient'), { gain: 0.8, range: 20 });
  define(`mob.${kind}.hurt`, bus, mobVoice(m, 'hurt'), { gain: 1, range: 20 });
  define(`mob.${kind}.death`, bus, mobVoice(m, 'death'), { gain: 1, range: 24 });
}

// The three signature one-offs.
define('mob.creeper.hiss', 'hostile', (V) => {
  noise(V, { color: 'white', filter: 'highpass', freq: 3800, dur: 1.4, gain: 0.34,
    attack: 0.25, curve: 'lin' });
  noise(V, { color: 'pink', filter: 'bandpass', freq: 1600, freq2: 3200, q: 0.8,
    dur: 1.4, gain: 0.16, attack: 0.3 });
}, { gain: 1.1, range: 28, priority: 3 });

define('mob.enderman.teleport', 'hostile', (V) => {
  tone(V, { type: 'sine', freq: 900, freq2: 120, dur: 0.4, gain: 0.16 });
  tone(V, { type: 'sine', freq: 1400, freq2: 200, dur: 0.35, gain: 0.10, delay: 0.02 });
  noise(V, { color: 'white', filter: 'bandpass', freq: 3000, freq2: 300, q: 2,
    dur: 0.5, gain: 0.16 });
}, { gain: 1, range: 32 });

define('mob.enderman.scream', 'hostile', (V) => {
  tone(V, { type: 'sawtooth', freq: 320, freq2: 90, dur: 1.5, gain: 0.24,
    filter: 'lowpass', freq: 1400, freq2: 300, q: 6,
    vibrato: { rate: 7, depth: 90 } });
  tone(V, { type: 'square', freq: 180, freq2: 60, dur: 1.7, gain: 0.14, delay: 0.05 });
  noise(V, { color: 'white', filter: 'bandpass', freq: 900, freq2: 300, q: 1.5,
    dur: 1.5, gain: 0.12 });
}, { gain: 1.2, range: 40, priority: 3 });

// ---------------------------------------------------------------------------
// Portals
// ---------------------------------------------------------------------------

define('portal.ambient', 'ambient', (V) => {
  tone(V, { type: 'sine', freq: 90 + V.rnd() * 40, freq2: 60, dur: 1.6, gain: 0.06,
    attack: 0.5, curve: 'lin' });
}, {
  gain: 0.8,
  range: 16,
  grain: 1.1,
  loop: (V) => {
    const ctx = V.ctx;
    const g = ctx.createGain();
    g.gain.value = 0.14;
    g.connect(V.out);
    const oscs = [];
    // Three detuned saws through a slowly sweeping lowpass: the classic
    // wobbling portal drone.
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 55 * (i + 1) * 0.5 + 3;
      o.detune.value = (i - 1) * 14;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 240 + i * 60;
      lp.Q.value = 6;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.13 + i * 0.07;
      const amt = ctx.createGain();
      amt.gain.value = 120;
      lfo.connect(amt).connect(lp.frequency);
      o.connect(lp).connect(g);
      o.start(V.t); lfo.start(V.t);
      oscs.push(o, lfo);
    }
    return { oscillators: oscs, gain: g };
  },
});

define('portal.travel', 'ambient', (V) => {
  tone(V, { type: 'sine', freq: 60, freq2: 900, dur: 1.4, gain: 0.2 });
  noise(V, { color: 'white', filter: 'bandpass', freq: 300, freq2: 4000, q: 1.5,
    dur: 1.4, gain: 0.2 });
}, { gain: 1, range: 24 });

define('portal.trigger', 'ambient', (V) => {
  tone(V, { type: 'sine', freq: 1200, freq2: 200, dur: 0.6, gain: 0.18 });
  fm(V, { freq: 320, ratio: 1.41, index: 6, dur: 1.2, gain: 0.12 });
}, { gain: 1, range: 24 });

// ---------------------------------------------------------------------------
// Procedural ambient music
// ---------------------------------------------------------------------------

/**
 * Moods. Each is a key centre, a pentatonic scale, a chord palette and a
 * timbre. Changing mood does not cut anything off — the pads already sounding
 * run out their 15-second release while the new mood's pads fade up underneath,
 * so a walk into a cave slides from one to the other over half a minute.
 */
export const MUSIC_MOODS = {
  day: {
    root: 261.63, scale: [0, 2, 4, 7, 9],
    chords: [[0, 4, 7], [0, 5, 9], [-3, 2, 5], [0, 4, 9]],
    padWave: 'triangle', padFilter: 1100, padGain: 0.10, padLen: [14, 22],
    noteGain: 0.075, noteRate: 2.1, density: 0.42, octaves: [0, 1, 2], bright: 1,
  },
  night: {
    root: 196.0, scale: [0, 2, 3, 7, 9],
    chords: [[0, 3, 7], [-2, 3, 5], [0, 5, 10], [-5, 0, 7]],
    padWave: 'sine', padFilter: 620, padGain: 0.11, padLen: [18, 28],
    noteGain: 0.06, noteRate: 3.0, density: 0.3, octaves: [0, 1], bright: 0.6,
  },
  cave: {
    root: 130.81, scale: [0, 2, 3, 5, 8],
    chords: [[0, 3, 8], [0, 5, 6], [-4, 1, 6], [0, 2, 7]],
    padWave: 'sine', padFilter: 380, padGain: 0.13, padLen: [22, 34],
    noteGain: 0.05, noteRate: 5.5, density: 0.22, octaves: [1, 2], bright: 0.3,
  },
  nether: {
    root: 116.54, scale: [0, 1, 4, 6, 8],
    chords: [[0, 1, 6], [0, 6, 11], [-1, 4, 8], [0, 3, 6]],
    padWave: 'sawtooth', padFilter: 300, padGain: 0.12, padLen: [20, 30],
    noteGain: 0.05, noteRate: 4.5, density: 0.26, octaves: [0, 1], bright: 0.25,
  },
  end: {
    root: 155.56, scale: [0, 2, 5, 7, 10],
    chords: [[0, 5, 10], [0, 2, 7], [-2, 5, 9], [0, 7, 14]],
    padWave: 'triangle', padFilter: 700, padGain: 0.12, padLen: [24, 36],
    noteGain: 0.055, noteRate: 4.0, density: 0.3, octaves: [1, 2], bright: 0.5,
  },
};

class MusicGenerator {
  constructor(engine) {
    this.engine = engine;
    this.mood = 'day';
    this.enabled = true;
    this.running = false;
    this.nextPad = 0;
    this.nextNote = 0;
    this.chordIndex = 0;
    this.timer = null;
    this.lookahead = 2.0;
    // Long silences between "tracks" are part of the aesthetic.
    this.restUntil = 0;
  }

  setMood(name) {
    if (!MUSIC_MOODS[name] || name === this.mood) return;
    this.mood = name;
    // Bring the next pad forward so the new colour arrives within a few
    // seconds, then let the old pads release naturally over it.
    const now = this.engine.now();
    this.nextPad = Math.min(this.nextPad, now + 2.5);
  }

  start() {
    if (this.running || !this.engine.ctx) return;
    this.running = true;
    const now = this.engine.now();
    this.nextPad = now + 1.5;
    this.nextNote = now + 4;
    this.timer = setInterval(() => this.schedule(), 250);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  schedule() {
    const E = this.engine;
    if (!this.running || !this.enabled || !E.ctx || E.ctx.state !== 'running') return;
    const now = E.now();
    const until = now + this.lookahead;
    const m = MUSIC_MOODS[this.mood] || MUSIC_MOODS.day;

    while (this.nextPad < until) {
      if (this.nextPad > now - 1) this.pad(m, this.nextPad);
      const len = m.padLen[0] + Math.random() * (m.padLen[1] - m.padLen[0]);
      // Overlap the pads slightly so the bed never gaps.
      this.nextPad += len * 0.72;
      this.chordIndex = (this.chordIndex + 1) % m.chords.length;
      // Every few chords, take a breath.
      if (Math.random() < 0.14) this.nextPad += 12 + Math.random() * 20;
    }

    while (this.nextNote < until) {
      if (this.nextNote > now - 0.5 && Math.random() < m.density) {
        this.pluck(m, this.nextNote);
      }
      this.nextNote += m.noteRate * (0.6 + Math.random() * 0.9);
    }
  }

  /** A slow chord: three detuned oscillators through a gentle lowpass. */
  pad(m, t) {
    const E = this.engine;
    const ctx = E.ctx;
    const chord = m.chords[this.chordIndex];
    const len = m.padLen[0] + Math.random() * (m.padLen[1] - m.padLen[0]);
    const out = E.buses.music;
    for (let i = 0; i < chord.length; i++) {
      for (let d = 0; d < 2; d++) {
        const o = ctx.createOscillator();
        o.type = m.padWave;
        o.frequency.value = m.root * Math.pow(2, chord[i] / 12);
        o.detune.value = (d ? 7 : -7) + (Math.random() - 0.5) * 6;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(m.padFilter * 0.5, t);
        // The filter opens as the pad swells and closes as it fades — the
        // whole reason a static chord still feels alive.
        lp.frequency.linearRampToValueAtTime(m.padFilter, t + len * 0.45);
        lp.frequency.linearRampToValueAtTime(m.padFilter * 0.45, t + len);
        lp.Q.value = 0.9;
        const g = ctx.createGain();
        const peak = m.padGain / chord.length * (d ? 0.7 : 1);
        g.gain.setValueAtTime(MIN_GAIN, t);
        g.gain.linearRampToValueAtTime(peak, t + len * 0.35);
        g.gain.setValueAtTime(peak, t + len * 0.55);
        g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + len);
        o.connect(lp).connect(g).connect(out);
        E.sendReverb(g, 0.7);
        o.start(t);
        o.stop(t + len + 0.1);
      }
    }
  }

  /** A sparse piano-ish note from the mood's pentatonic scale. */
  pluck(m, t) {
    const E = this.engine;
    const deg = m.scale[(Math.random() * m.scale.length) | 0];
    const oct = m.octaves[(Math.random() * m.octaves.length) | 0];
    const freq = m.root * Math.pow(2, deg / 12 + oct);
    const V = E.voice(E.buses.music, t, 1);
    fm(V, {
      freq, ratio: 3.0, index: 1.4 + m.bright * 2.2, dur: 2.6 + Math.random() * 2,
      gain: m.noteGain, modDecay: 0.14, attack: 0.006,
    });
    // A quiet octave partial gives the note a piano's body.
    tone(V, {
      type: 'sine', freq: freq * 2, dur: 1.4, gain: m.noteGain * 0.35, attack: 0.01,
    });
    if (Math.random() < 0.35) {
      // Occasional grace note a fifth or fourth away.
      const V2 = E.voice(E.buses.music, t + 0.14 + Math.random() * 0.2, 1);
      fm(V2, {
        freq: freq * (Math.random() < 0.5 ? 1.5 : 1.335), ratio: 3, index: 1.6,
        dur: 2.0, gain: m.noteGain * 0.6, modDecay: 0.14,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export class SoundEngine {
  /**
   * @param {object} [opts] master, music and per-bus levels, maxVoices
   */
  constructor(opts = {}) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) throw new Error('Web Audio is not available');
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.maxVoices = opts.maxVoices ?? 42;
    this.activeVoices = 0;
    this.muted = false;

    const ctx = this.ctx;
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 6;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.22;
    this.compressor.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = opts.master ?? 1;
    this.master.connect(this.compressor);

    /** @type {Record<string, GainNode>} */
    this.buses = {};
    for (const name of BUSES) {
      const g = ctx.createGain();
      g.gain.value = opts[name] ?? DEFAULT_BUS_LEVEL[name] ?? 1;
      g.connect(this.master);
      this.buses[name] = g;
    }
    if (opts.music !== undefined) this.buses.music.gain.value = opts.music;

    // Reverb: one convolver on a send, fed a generated impulse response.
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = makeImpulseResponse(ctx, 2.6, 2.4, 0.4);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.06;
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.9;
    this.reverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.master);

    // A second, much longer IR is swapped in underground.
    this._caveIR = null;
    this._openIR = this.convolver.buffer;
    this._irMode = 'open';

    this._noise = new Map();
    this._rand = 0x1234567 >>> 0;
    this.listener = { x: 0, y: 0, z: 0, set: false, t: 0 };
    this.environment = { enclosed: 0, submerged: null, dimension: 'overworld' };
    this.loops = new Set();

    // Underwater muffling sits between the buses and the master.
    this.muffle = null;

    this.music = new MusicGenerator(this);
    this.musicEnabled = opts.musicEnabled ?? true;

    this.stats = { played: 0, skipped: 0 };
  }

  // -- lifecycle -----------------------------------------------------------

  get ready() { return this.ctx && this.ctx.state === 'running'; }

  now() { return this.ctx.currentTime; }

  /** Browsers start an AudioContext suspended; call this from a gesture. */
  resume() {
    if (!this.ctx) return Promise.resolve(false);
    const p = this.ctx.state === 'running'
      ? Promise.resolve()
      : this.ctx.resume().catch(() => {});
    return Promise.resolve(p).then(() => {
      if (this.musicEnabled) this.music.start();
      return this.ctx.state === 'running';
    });
  }

  suspend() {
    this.music.stop();
    return this.ctx ? this.ctx.suspend().catch(() => {}) : Promise.resolve();
  }

  /** @param {string} bus one of BUSES, or 'master' */
  setVolume(bus, v) {
    const value = Math.max(0, Math.min(2, v));
    const node = bus === 'master' ? this.master : this.buses[bus];
    if (!node) return false;
    node.gain.setTargetAtTime(value, this.now(), 0.02);
    if (bus === 'music') this.music.enabled = value > 0.001;
    return true;
  }

  getVolume(bus) {
    const node = bus === 'master' ? this.master : this.buses[bus];
    return node ? node.gain.value : 0;
  }

  setMusicEnabled(on) {
    this.musicEnabled = !!on;
    if (on) this.music.start(); else this.music.stop();
  }

  setMood(name) { this.music.setMood(name); }

  // -- listener & environment ----------------------------------------------

  /**
   * Position the listener. Everything positional is relative to this, so the
   * caller should push the camera here once a frame.
   * @param {{x,y,z}} pos
   * @param {{x,y,z}} [forward]
   * @param {{x,y,z}} [up]
   */
  setListener(pos, forward, up) {
    if (!pos) return;
    const L = this.ctx.listener;
    const t = this.now();
    this.listener.x = pos.x; this.listener.y = pos.y; this.listener.z = pos.z;
    this.listener.set = true;
    this.listener.t = t;
    if (L.positionX) {
      L.positionX.setTargetAtTime(pos.x, t, 0.02);
      L.positionY.setTargetAtTime(pos.y, t, 0.02);
      L.positionZ.setTargetAtTime(pos.z, t, 0.02);
    } else if (L.setPosition) {
      L.setPosition(pos.x, pos.y, pos.z);
    }
    if (!forward) return;
    const u = up || UP;
    if (L.forwardX) {
      L.forwardX.setTargetAtTime(forward.x, t, 0.02);
      L.forwardY.setTargetAtTime(forward.y, t, 0.02);
      L.forwardZ.setTargetAtTime(forward.z, t, 0.02);
      L.upX.setTargetAtTime(u.x, t, 0.02);
      L.upY.setTargetAtTime(u.y, t, 0.02);
      L.upZ.setTargetAtTime(u.z, t, 0.02);
    } else if (L.setOrientation) {
      L.setOrientation(forward.x, forward.y, forward.z, u.x, u.y, u.z);
    }
  }

  /**
   * Describe the space around the listener.
   * @param {{enclosed?: number, submerged?: string|null, dimension?: string}} e
   *   `enclosed` is 0 (open sky) to 1 (deep underground) and drives the wet mix.
   */
  setEnvironment(e) {
    const env = this.environment;
    if (e.enclosed !== undefined) env.enclosed = Math.max(0, Math.min(1, e.enclosed));
    if (e.submerged !== undefined) env.submerged = e.submerged;
    if (e.dimension !== undefined) env.dimension = e.dimension;
    const t = this.now();
    // Caves are wetter and, past halfway, get the longer impulse response.
    const wet = 0.05 + env.enclosed * 0.55;
    this.reverbSend.gain.setTargetAtTime(wet, t, 1.5);
    const wantCave = env.enclosed > 0.55;
    if (wantCave && this._irMode !== 'cave') {
      if (!this._caveIR) this._caveIR = makeImpulseResponse(this.ctx, 4.5, 1.6, 0.62);
      this.convolver.buffer = this._caveIR;
      this._irMode = 'cave';
    } else if (!wantCave && this._irMode !== 'open') {
      this.convolver.buffer = this._openIR;
      this._irMode = 'open';
    }
  }

  // -- playback ------------------------------------------------------------

  /** Non-positional playback: UI, music stings, the player's own actions. */
  play(name, opts = {}) {
    const def = getSoundDef(name);
    if (!def) return null;
    const bus = this.buses[opts.bus || def.bus] || this.buses.blocks;
    return this.spawn(def, bus, null, opts);
  }

  /**
   * Positional playback. `opts` may carry {volume, pitch, bus, delay}.
   * This is what world.playSound reaches through game.setupWorldEvents.
   */
  playAt(name, x, y, z, opts = {}) {
    const def = getSoundDef(name);
    if (!def) return null;
    const o = opts || {};
    const volume = o.volume ?? 1;
    // Cheap distance cull before any node is created.
    if (this.listener.set) {
      const dx = x - this.listener.x, dy = y - this.listener.y, dz = z - this.listener.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const reach = def.range * Math.max(0.4, volume);
      if (d2 > reach * reach) { this.stats.skipped++; return null; }
    }
    const bus = this.buses[o.bus || def.bus] || this.buses.blocks;
    return this.spawn(def, bus, { x, y, z }, o);
  }

  /** Shared body of play/playAt. */
  spawn(def, bus, pos, opts) {
    if (!this.ctx || this.ctx.state === 'closed') return null;
    if (this.muted) return null;
    if (this.activeVoices >= this.maxVoices && def.priority < 2) {
      this.stats.skipped++;
      return null;
    }
    const ctx = this.ctx;
    const t = this.now() + (opts.delay || 0) + 0.005;
    const gain = ctx.createGain();
    gain.gain.value = (opts.volume ?? 1) * def.gain;

    let head = gain;
    if (pos) {
      const panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 2.5;
      panner.rolloffFactor = 1.1;
      panner.maxDistance = def.range;
      if (panner.positionX) {
        panner.positionX.value = pos.x;
        panner.positionY.value = pos.y;
        panner.positionZ.value = pos.z;
      } else if (panner.setPosition) {
        panner.setPosition(pos.x, pos.y, pos.z);
      }
      gain.connect(panner);
      panner.connect(bus);
      head = panner;
      // Muffle anything heard from underwater.
      if (this.environment.submerged === 'water') {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 700;
        panner.disconnect();
        panner.connect(lp);
        lp.connect(bus);
        head = lp;
      }
    } else {
      gain.connect(bus);
    }
    if (def.reverb > 0) this.sendReverb(head, def.reverb);

    const V = this.voice(gain, t, opts.pitch ?? 1);
    this.activeVoices++;
    try {
      def.play(V);
    } catch (e) {
      this.activeVoices--;
      if (!this._warned) { this._warned = true; console.warn('sound failed:', def.name, e); }
      return null;
    }
    this.stats.played++;
    const ttl = (opts.ttl ?? 5) * 1000;
    setTimeout(() => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
      try { gain.disconnect(); head.disconnect(); } catch { /* already gone */ }
    }, ttl);
    return { gain, node: head };
  }

  /** Build the voice context handed to a sound definition. */
  voice(out, t, pitch) {
    return { ctx: this.ctx, out, t, pitch: pitch || 1, engine: this, rnd: () => this.rnd() };
  }

  sendReverb(node, amount) {
    if (amount <= 0) return;
    if (amount === 1) { node.connect(this.reverbSend); return; }
    const g = this.ctx.createGain();
    g.gain.value = amount;
    node.connect(g);
    g.connect(this.reverbSend);
  }

  // -- loops ---------------------------------------------------------------

  /**
   * Start a sustained sound. Returns a handle with setVolume / setPosition /
   * setPitch / stop. Sounds without a dedicated loop builder are looped by
   * retriggering their one-shot on a grain interval, which is exactly right for
   * digging, fire crackle and bubbling lava.
   * @returns {{setVolume(v: number): void, setPosition(x,y,z): void,
   *            stop(fade?: number): void, running: boolean}|null}
   */
  startLoop(name, opts = {}) {
    const def = getSoundDef(name);
    if (!def || !this.ctx) return null;
    const ctx = this.ctx;
    const bus = this.buses[opts.bus || def.bus] || this.buses.ambient;
    const outGain = ctx.createGain();
    outGain.gain.value = (opts.volume ?? 1) * def.gain;

    let target = outGain;
    let panner = null;
    if (opts.x !== undefined) {
      panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 3;
      panner.rolloffFactor = 1;
      panner.maxDistance = def.range;
      setPannerPos(panner, opts.x, opts.y, opts.z);
      outGain.connect(panner);
      panner.connect(bus);
      target = panner;
    } else {
      outGain.connect(bus);
    }
    if (def.reverb > 0) this.sendReverb(target, def.reverb * 0.6);

    const state = { sources: [], oscillators: [], timer: null };
    if (def.loop) {
      const V = this.voice(outGain, this.now() + 0.02, opts.pitch ?? 1);
      const built = def.loop(V) || {};
      state.sources = built.sources || [];
      state.oscillators = built.oscillators || [];
      state.inner = built.gain || null;
    }
    if (def.grain > 0) {
      // Grain train: retrigger the one-shot with a little random spacing.
      const period = (opts.grain ?? def.grain) * 1000;
      const fire = () => {
        if (!handle.running) return;
        if (this.ctx.state === 'running' && !this.muted) {
          const V = this.voice(outGain, this.now() + 0.01, opts.pitch ?? 1);
          try { def.play(V); } catch { /* keep the loop alive */ }
        }
        state.timer = setTimeout(fire, period * (0.6 + Math.random() * 0.8));
      };
      state.timer = setTimeout(fire, period * Math.random());
    }

    const engine = this;
    const handle = {
      running: true,
      name: def.name,
      setVolume(v) {
        outGain.gain.setTargetAtTime(Math.max(0, v) * def.gain, engine.now(), 0.15);
      },
      setPitch(p) {
        for (const s of state.sources) {
          if (s.playbackRate) s.playbackRate.setTargetAtTime(p, engine.now(), 0.2);
        }
      },
      setPosition(x, y, z) { if (panner) setPannerPos(panner, x, y, z); },
      stop(fade = 0.3) {
        if (!handle.running) return;
        handle.running = false;
        if (state.timer) clearTimeout(state.timer);
        const t = engine.now();
        outGain.gain.setTargetAtTime(MIN_GAIN, t, Math.max(0.01, fade / 3));
        const end = t + fade + 0.1;
        for (const s of state.sources) { try { s.stop(end); } catch { /* stopped */ } }
        for (const o of state.oscillators) { try { o.stop(end); } catch { /* stopped */ } }
        setTimeout(() => {
          try { outGain.disconnect(); } catch { /* gone */ }
          if (panner) { try { panner.disconnect(); } catch { /* gone */ } }
        }, (fade + 0.3) * 1000);
        engine.loops.delete(handle);
      },
    };
    this.loops.add(handle);
    return handle;
  }

  stopAll() {
    for (const h of [...this.loops]) h.stop(0.1);
    this.music.stop();
  }

  // -- helpers -------------------------------------------------------------

  /** Cached looping noise buffers: white (flat), pink (-3dB), brown (-6dB). */
  noiseBuffer(color = 'white') {
    let buf = this._noise.get(color);
    if (buf) return buf;
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 2);
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    if (color === 'brown') {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    } else if (color === 'pink') {
      // Voss-McCartney, three octaves — close enough and very cheap.
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    this._noise.set(color, buf);
    return buf;
  }

  rnd() {
    let x = this._rand;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this._rand = x;
    return x / 4294967296;
  }

  /** Play a note-block note. `note` is 0..24. */
  playNote(instrument, note, x, y, z, opts = {}) {
    const name = `note.${NOTE_INSTRUMENTS.includes(instrument) ? instrument : 'harp'}`;
    const pitch = Math.pow(2, (Math.max(0, Math.min(NOTE_COUNT - 1, note)) - 12) / 12);
    return this.playAt(name, x, y, z, { ...opts, pitch });
  }
}

const UP = { x: 0, y: 1, z: 0 };

const DEFAULT_BUS_LEVEL = {
  music: 0.35, blocks: 1, hostile: 0.9, friendly: 0.9, players: 1,
  ambient: 0.7, weather: 0.8, ui: 0.8,
};

function setPannerPos(p, x, y, z) {
  if (p.positionX) {
    p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
  } else if (p.setPosition) {
    p.setPosition(x, y, z);
  }
}

/**
 * Build a reverb impulse response: exponentially decaying noise with a
 * progressive low-pass (air absorption) and a handful of discrete early
 * reflections, which is what stops it sounding like a plain noise swell.
 */
function makeImpulseResponse(ctx, seconds = 2.6, decay = 2.4, damp = 0.4) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const n = Math.random() * 2 - 1;
      // Coefficient shrinks with time: the tail loses its highs as it decays.
      lp += (n - lp) * (1 - damp * t);
      d[i] = lp * Math.pow(1 - t, decay);
    }
    const taps = [0.009, 0.017, 0.026, 0.037, 0.053, 0.071];
    for (let k = 0; k < taps.length; k++) {
      const idx = Math.floor(taps[k] * rate * (1 + ch * 0.06));
      if (idx < len) d[idx] += (ch ? -1 : 1) * 0.42 * Math.pow(1 - idx / len, 1.5);
    }
  }
  return buf;
}

export { makeImpulseResponse };
