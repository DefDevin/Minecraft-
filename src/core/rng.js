// Deterministic pseudo-random number generation.
//
// Everything in world generation must be reproducible from (seed, x, y, z) with
// no dependence on generation order, so chunks generate identically whether the
// player arrives from the north or the south. That rules out a single shared
// stream: instead we derive per-purpose, per-position seeds by hashing.

/** 32-bit integer hash (avalanche step from MurmurHash3). */
export function hash32(x) {
  x |= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Hash three coordinates plus a seed into a uint32. */
export function hash3(seed, x, y, z) {
  let h = seed | 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
  h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ (y | 0), 0x165667b1);
  h = (h << 17) | (h >>> 15);
  h = Math.imul(h ^ (z | 0), 0x9e3779b1);
  return hash32(h);
}

/** Hash two coordinates plus a seed into a uint32. */
export function hash2(seed, x, z) {
  let h = seed | 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
  h = (h << 15) | (h >>> 17);
  h = Math.imul(h ^ (z | 0), 0x9e3779b1);
  return hash32(h);
}

/** Hash a string into a 32-bit signed integer (used to name noise streams). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/** Uniform float in [0,1) from a uint32. */
export const toFloat = (u) => (u >>> 8) * (1 / 16777216);

/**
 * xoshiro128** — fast, high quality, 128-bit state. Deterministic and
 * serialisable, which matters for save/load of mob AI and world features.
 */
export class Random {
  constructor(seed = 0) { this.seed(seed); }

  seed(seed) {
    // SplitMix32 to spread a single integer over the four state words.
    let z = seed | 0;
    const next = () => {
      z = (z + 0x9e3779b9) | 0;
      let t = z;
      t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
      t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
      return (t ^ (t >>> 15)) >>> 0;
    };
    this.s0 = next(); this.s1 = next(); this.s2 = next(); this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
    return this;
  }

  /** Next raw uint32. */
  nextUint() {
    const s1 = this.s1;
    let r = Math.imul(s1, 5);
    r = ((r << 7) | (r >>> 25)) >>> 0;
    r = Math.imul(r, 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= s1;
    this.s1 = (s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;
    return r;
  }

  /** Float in [0,1). */
  next() { return toFloat(this.nextUint()); }

  /** Float in [min,max). */
  range(min, max) { return min + this.next() * (max - min); }

  /** Integer in [0,n). */
  int(n) { return n <= 0 ? 0 : (this.nextUint() % n) >>> 0; }

  /** Integer in [min,max] inclusive. */
  intRange(min, max) { return min + this.int(max - min + 1); }

  /** True with probability p. */
  chance(p) { return this.next() < p; }

  /** True with probability 1/n. */
  oneIn(n) { return this.int(n) === 0; }

  /** Approximately normal distribution (sum of 3 uniforms), mean 0 stddev ~1. */
  gaussian() {
    return (this.next() + this.next() + this.next() - 1.5) * 1.1547;
  }

  pick(arr) { return arr[this.int(arr.length)]; }

  /** Pick from `[{weight, ...}]`, returning the entry. */
  weighted(arr, weightKey = 'weight') {
    let total = 0;
    for (const e of arr) total += e[weightKey];
    let r = this.next() * total;
    for (const e of arr) { r -= e[weightKey]; if (r <= 0) return e; }
    return arr[arr.length - 1];
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** Serialise state so worlds reload bit-identically. */
  save() { return [this.s0, this.s1, this.s2, this.s3]; }
  load(s) { this.s0 = s[0]; this.s1 = s[1]; this.s2 = s[2]; this.s3 = s[3]; return this; }

  /** A child generator seeded deterministically from this one plus a label. */
  fork(label) { return new Random(this.nextUint() ^ hashString(String(label))); }
}

/** A shared scratch generator for cosmetic effects where determinism is moot. */
export const fx = new Random(0x5eed1e);

/** Seed a Random deterministically from a world seed and block position. */
export function positionalRandom(seed, x, y, z, salt = 0) {
  return new Random(hash3(seed ^ salt, x, y, z) | 0);
}

/** Convert an arbitrary user-entered seed string into a 32-bit integer. */
export function parseSeed(text) {
  if (text == null) return (Math.random() * 0x7fffffff) | 0;
  const t = String(text).trim();
  if (t === '') return (Math.random() * 0x7fffffff) | 0;
  if (/^-?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) return n | 0;
  }
  return hashString(t);
}
