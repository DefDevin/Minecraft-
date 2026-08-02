// Chunk serialisation.
//
// A chunk in memory is 24 sections of 4096 `Uint16` states — 192 KiB before you
// count light, heightmaps or biomes. Almost none of that is information: a
// section usually contains a handful of distinct states, so the format below
// stores a per-section palette of the states actually used and packs indices
// into it at ceil(log2(paletteSize)) bits per block. Four bits per block is the
// common case, and a section that is entirely one state (air above the surface,
// stone below it) collapses to three bytes.
//
// Layout, all little-endian:
//
//   header      magic, version, flags, cx, cz, status, inhabitedTime
//   heightmaps  three Int16[256] arrays, raw or run-length encoded
//   biomes      Uint8[1536], raw or run-length encoded
//   sections    24 records: presence flag, uniform skylight, blocks, sky, block
//   extras      a length-prefixed UTF-8 JSON tail (block entities, structures)
//
// Every encoded field carries a mode byte and the writer picks whichever mode
// is smallest, so the format degrades gracefully to a raw copy rather than ever
// growing past it.

import {
  Section, CHUNK_SIZE, SECTION_COUNT, SECTION_VOLUME, MIN_Y,
} from './chunk.js';

/** Bumped whenever the byte layout changes; older buffers are rejected. */
export const SAVE_VERSION = 1;

/** 'MCVX' — sanity check that a buffer really is a chunk. */
const MAGIC = 0x4d435658;

/** Size of the naive representation, for compression reporting. */
export const RAW_CHUNK_BYTES = SECTION_COUNT * SECTION_VOLUME * 2;

// Block-array encodings.
const BLOCK_UNIFORM = 0;   // section.blocks === null: one state, no array
const BLOCK_PALETTE = 1;   // palette + bit-packed indices
const BLOCK_RLE = 2;       // (runLength, state) pairs
const BLOCK_RAW = 3;       // straight Uint16 copy

// Light-array encodings.
const LIGHT_NONE = 0;      // array is null
const LIGHT_PACKED = 1;    // one nibble per cell
const LIGHT_RLE = 2;       // (runLength, value) pairs

// Generic array encodings, shared by the heightmaps and biomes.
const ARR_RAW = 0;
const ARR_RLE = 1;

const HEIGHTMAP_LEN = CHUNK_SIZE * CHUNK_SIZE;

/** Back-references that would make a block entity un-stringifiable. */
const BE_SKIP_KEYS = new Set(['world', 'chunk', 'game', 'level', 'renderer', 'mesh']);

const TEXT_ENC = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const TEXT_DEC = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

// ---------------------------------------------------------------------------
// Byte streams
// ---------------------------------------------------------------------------

class Writer {
  constructor(capacity = 1 << 14) {
    this.buf = new ArrayBuffer(capacity);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
    this.pos = 0;
  }

  need(n) {
    const want = this.pos + n;
    if (want <= this.buf.byteLength) return;
    let cap = this.buf.byteLength || 1024;
    while (cap < want) cap *= 2;
    const buf = new ArrayBuffer(cap);
    new Uint8Array(buf).set(this.bytes);
    this.buf = buf;
    this.view = new DataView(buf);
    this.bytes = new Uint8Array(buf);
  }

  u8(v) { this.need(1); this.view.setUint8(this.pos, v & 255); this.pos += 1; }
  u16(v) { this.need(2); this.view.setUint16(this.pos, v & 65535, true); this.pos += 2; }
  i16(v) { this.need(2); this.view.setInt16(this.pos, v, true); this.pos += 2; }
  u32(v) { this.need(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  i32(v) { this.need(4); this.view.setInt32(this.pos, v | 0, true); this.pos += 4; }

  raw(src) {
    this.need(src.length);
    this.bytes.set(src, this.pos);
    this.pos += src.length;
  }

  finish() { return this.buf.slice(0, this.pos); }
}

class Reader {
  constructor(source) {
    const buf = source instanceof ArrayBuffer ? source : source.buffer;
    const off = source instanceof ArrayBuffer ? 0 : source.byteOffset;
    const len = source instanceof ArrayBuffer ? source.byteLength : source.byteLength;
    this.view = new DataView(buf, off, len);
    this.bytes = new Uint8Array(buf, off, len);
    this.pos = 0;
  }

  u8() { return this.view.getUint8(this.pos++); }
  u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }

  /** A view over the next `n` bytes, without copying. */
  slice(n) {
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
}

// ---------------------------------------------------------------------------
// Bit packing
// ---------------------------------------------------------------------------

/** Bits needed to index a palette of `n` entries; 0 when there is only one. */
function bitsFor(n) {
  if (n <= 1) return 0;
  return 32 - Math.clz32(n - 1);
}

function packedByteLength(count, bits) {
  return ((count * bits) + 7) >> 3;
}

/** LSB-first bit packing; values may straddle byte boundaries. */
function packBits(values, count, bits) {
  const out = new Uint8Array(packedByteLength(count, bits));
  if (bits === 0) return out;
  let bit = 0;
  for (let i = 0; i < count; i++) {
    let v = values[i];
    let left = bits;
    while (left > 0) {
      const off = bit & 7;
      const take = Math.min(8 - off, left);
      out[bit >> 3] |= (v & ((1 << take) - 1)) << off;
      v >>>= take;
      left -= take;
      bit += take;
    }
  }
  return out;
}

function unpackBits(src, count, bits, out) {
  if (bits === 0) { out.fill(0); return out; }
  let bit = 0;
  for (let i = 0; i < count; i++) {
    let v = 0, got = 0, left = bits;
    while (left > 0) {
      const off = bit & 7;
      const take = Math.min(8 - off, left);
      v |= ((src[bit >> 3] >> off) & ((1 << take) - 1)) << got;
      got += take;
      left -= take;
      bit += take;
    }
    out[i] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run-length helpers
// ---------------------------------------------------------------------------

function countRuns(arr, len) {
  let runs = 1;
  for (let i = 1; i < len; i++) if (arr[i] !== arr[i - 1]) runs++;
  return runs;
}

/** Heightmaps: Int16[256], raw or run-length encoded, whichever is smaller. */
function writeI16Array(w, arr) {
  const len = arr.length;
  const runs = countRuns(arr, len);
  if (2 + runs * 4 < len * 2) {
    w.u8(ARR_RLE);
    w.u16(runs);
    let start = 0;
    for (let i = 1; i <= len; i++) {
      if (i === len || arr[i] !== arr[start]) {
        w.u16(i - start);
        w.i16(arr[start]);
        start = i;
      }
    }
  } else {
    w.u8(ARR_RAW);
    for (let i = 0; i < len; i++) w.i16(arr[i]);
  }
}

function readI16Array(r, out) {
  const mode = r.u8();
  if (mode === ARR_RAW) {
    for (let i = 0; i < out.length; i++) out[i] = r.i16();
    return out;
  }
  const runs = r.u16();
  let at = 0;
  for (let i = 0; i < runs; i++) {
    const n = r.u16();
    const v = r.i16();
    for (let j = 0; j < n && at < out.length; j++) out[at++] = v;
  }
  return out;
}

/** Biomes: Uint8[1536], raw or run-length encoded. */
function writeU8Array(w, arr) {
  const len = arr.length;
  const runs = countRuns(arr, len);
  if (2 + runs * 3 < len) {
    w.u8(ARR_RLE);
    w.u16(runs);
    let start = 0;
    for (let i = 1; i <= len; i++) {
      if (i === len || arr[i] !== arr[start]) {
        w.u16(i - start);
        w.u8(arr[start]);
        start = i;
      }
    }
  } else {
    w.u8(ARR_RAW);
    w.raw(arr);
  }
}

function readU8Array(r, out) {
  const mode = r.u8();
  if (mode === ARR_RAW) { out.set(r.slice(out.length)); return out; }
  const runs = r.u16();
  let at = 0;
  for (let i = 0; i < runs; i++) {
    const n = r.u16();
    const v = r.u8();
    for (let j = 0; j < n && at < out.length; j++) out[at++] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const scratchIndices = new Uint16Array(SECTION_VOLUME);

function writeBlocks(w, section) {
  // A section that never materialised its array is one state, full stop. This
  // is the common case by a wide margin and costs three bytes.
  if (!section.blocks) {
    w.u8(BLOCK_UNIFORM);
    w.u16(section.uniform);
    return;
  }

  const blocks = section.blocks;
  const lookup = new Map();
  const palette = [];
  let runs = 1;
  for (let i = 0; i < SECTION_VOLUME; i++) {
    const state = blocks[i];
    let idx = lookup.get(state);
    if (idx === undefined) {
      idx = palette.length;
      palette.push(state);
      lookup.set(state, idx);
    }
    scratchIndices[i] = idx;
    if (i > 0 && state !== blocks[i - 1]) runs++;
  }

  // Sizes exclude the shared mode byte, so they compare like for like.
  const bits = bitsFor(palette.length);
  const paletteBytes = 3 + palette.length * 2 + packedByteLength(SECTION_VOLUME, bits);
  const rleBytes = 2 + runs * 4;
  const rawBytes = SECTION_VOLUME * 2;

  if (paletteBytes <= rleBytes && paletteBytes <= rawBytes) {
    w.u8(BLOCK_PALETTE);
    w.u8(bits);
    w.u16(palette.length);
    for (let i = 0; i < palette.length; i++) w.u16(palette[i]);
    w.raw(packBits(scratchIndices, SECTION_VOLUME, bits));
  } else if (rleBytes <= rawBytes) {
    w.u8(BLOCK_RLE);
    w.u16(runs);
    let start = 0;
    for (let i = 1; i <= SECTION_VOLUME; i++) {
      if (i === SECTION_VOLUME || blocks[i] !== blocks[start]) {
        w.u16(i - start);
        w.u16(blocks[start]);
        start = i;
      }
    }
  } else {
    w.u8(BLOCK_RAW);
    for (let i = 0; i < SECTION_VOLUME; i++) w.u16(blocks[i]);
  }
}

function readBlocks(r, section) {
  const mode = r.u8();
  if (mode === BLOCK_UNIFORM) {
    section.blocks = null;
    section.uniform = r.u16();
    return;
  }
  const blocks = new Uint16Array(SECTION_VOLUME);
  if (mode === BLOCK_PALETTE) {
    const bits = r.u8();
    const paletteLen = r.u16();
    const palette = new Uint16Array(paletteLen);
    for (let i = 0; i < paletteLen; i++) palette[i] = r.u16();
    const packed = r.slice(packedByteLength(SECTION_VOLUME, bits));
    unpackBits(packed, SECTION_VOLUME, bits, scratchIndices);
    for (let i = 0; i < SECTION_VOLUME; i++) blocks[i] = palette[scratchIndices[i]];
  } else if (mode === BLOCK_RLE) {
    const runs = r.u16();
    let at = 0;
    for (let i = 0; i < runs; i++) {
      const n = r.u16();
      const state = r.u16();
      for (let j = 0; j < n && at < SECTION_VOLUME; j++) blocks[at++] = state;
    }
  } else if (mode === BLOCK_RAW) {
    for (let i = 0; i < SECTION_VOLUME; i++) blocks[i] = r.u16();
  } else {
    throw new Error(`unknown block encoding ${mode}`);
  }
  section.blocks = blocks;
  section.uniform = blocks[0];
}

function writeLight(w, arr) {
  if (!arr) { w.u8(LIGHT_NONE); return; }
  const runs = countRuns(arr, SECTION_VOLUME);
  const rleBytes = 2 + runs * 3;
  const packedBytes = SECTION_VOLUME >> 1;
  if (rleBytes < packedBytes) {
    w.u8(LIGHT_RLE);
    w.u16(runs);
    let start = 0;
    for (let i = 1; i <= SECTION_VOLUME; i++) {
      if (i === SECTION_VOLUME || arr[i] !== arr[start]) {
        w.u16(i - start);
        w.u8(arr[start]);
        start = i;
      }
    }
  } else {
    w.u8(LIGHT_PACKED);
    const out = new Uint8Array(packedBytes);
    for (let i = 0; i < SECTION_VOLUME; i += 2) {
      out[i >> 1] = (arr[i] & 15) | ((arr[i + 1] & 15) << 4);
    }
    w.raw(out);
  }
}

function readLight(r) {
  const mode = r.u8();
  if (mode === LIGHT_NONE) return null;
  const out = new Uint8Array(SECTION_VOLUME);
  if (mode === LIGHT_PACKED) {
    const packed = r.slice(SECTION_VOLUME >> 1);
    for (let i = 0; i < SECTION_VOLUME; i += 2) {
      const b = packed[i >> 1];
      out[i] = b & 15;
      out[i + 1] = (b >> 4) & 15;
    }
  } else if (mode === LIGHT_RLE) {
    const runs = r.u16();
    let at = 0;
    for (let i = 0; i < runs; i++) {
      const n = r.u16();
      const v = r.u8();
      for (let j = 0; j < n && at < SECTION_VOLUME; j++) out[at++] = v;
    }
  } else {
    throw new Error(`unknown light encoding ${mode}`);
  }
  return out;
}

/**
 * Restore the derived counters a Section keeps. Deliberately does not collapse
 * a materialised array back to `uniform` the way `Section.recount()` does —
 * that would change the shape of the chunk across a save/load round trip.
 */
function recountSection(section) {
  if (!section.blocks) {
    section.nonAir = section.uniform === 0 ? 0 : SECTION_VOLUME;
  } else {
    let n = 0;
    const a = section.blocks;
    for (let i = 0; i < SECTION_VOLUME; i++) if (a[i] !== 0) n++;
    section.nonAir = n;
  }
  section.empty = section.nonAir === 0;
}

// ---------------------------------------------------------------------------
// Block entities and other JSON tails
// ---------------------------------------------------------------------------

function beReplacer(key, value) {
  if (BE_SKIP_KEYS.has(key)) return undefined;
  return value;
}

function encodeJson(value) {
  const text = JSON.stringify(value, beReplacer);
  if (!text) return new Uint8Array(0);
  if (TEXT_ENC) return TEXT_ENC.encode(text);
  // Fallback for environments without TextEncoder: UTF-16 code units are only
  // safe for ASCII, which is all the format ever writes on this path.
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 255;
  return out;
}

function decodeJson(bytes) {
  if (!bytes.length) return null;
  let text;
  if (TEXT_DEC) text = TEXT_DEC.decode(bytes);
  else text = String.fromCharCode(...bytes);
  try { return JSON.parse(text); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pack a chunk into a standalone buffer.
 * @param {import('./chunk.js').Chunk} chunk
 * @returns {ArrayBuffer}
 */
export function serializeChunk(chunk) {
  const w = new Writer(1 << 15);

  w.u32(MAGIC);
  w.u16(SAVE_VERSION);
  w.u16(0);                       // flags, reserved
  w.i32(chunk.cx);
  w.i32(chunk.cz);
  w.u8(chunk.status | 0);
  w.u8(SECTION_COUNT);
  w.u16(0);                       // reserved
  w.u32(Math.max(0, chunk.inhabitedTime | 0));

  writeI16Array(w, chunk.heightmap);
  writeI16Array(w, chunk.lightHeightmap);
  writeI16Array(w, chunk.surfaceHeightmap);
  writeU8Array(w, chunk.biomes);

  for (let sy = 0; sy < SECTION_COUNT; sy++) {
    const s = chunk.sections[sy];
    if (!s) { w.u8(0); continue; }
    w.u8(1);
    w.u8(s.uniformSky & 15);
    writeBlocks(w, s);
    writeLight(w, s.skyLight);
    writeLight(w, s.blockLight);
  }

  // Block entities keep their local key so they land back on the same block.
  const entities = [];
  for (const [key, be] of chunk.blockEntities) {
    if (be == null) continue;
    entities.push([key, be]);
  }
  const extras = {};
  if (entities.length) extras.be = entities;
  if (chunk.generatedStructures) extras.st = chunk.generatedStructures;
  const json = (entities.length || chunk.generatedStructures) ? encodeJson(extras)
    : new Uint8Array(0);
  w.u32(json.length);
  w.raw(json);

  return w.finish();
}

/**
 * Rebuild a chunk from a buffer produced by `serializeChunk`.
 *
 * The chunk is fetched through `world.createChunk`, so restoring over a chunk
 * that is already loaded overwrites it in place. Callers doing that should
 * `chunk.dispose(renderer)` first — section meshes are transferred where the
 * indices line up, but sections that disappear take their handles with them.
 *
 * @param {import('./world.js').World} world
 * @param {number} cx
 * @param {number} cz
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {import('./chunk.js').Chunk}
 */
export function deserializeChunk(world, cx, cz, buffer) {
  const r = new Reader(buffer);

  if (r.u32() !== MAGIC) throw new Error('not a chunk buffer');
  const version = r.u16();
  if (version > SAVE_VERSION) {
    throw new Error(`chunk was saved by a newer version (${version} > ${SAVE_VERSION})`);
  }
  r.u16();                        // flags
  r.i32();                        // stored cx — the caller's coordinates win
  r.i32();                        // stored cz
  const status = r.u8();
  const sectionCount = r.u8();
  if (sectionCount !== SECTION_COUNT) {
    throw new Error(`chunk has ${sectionCount} sections, expected ${SECTION_COUNT}`);
  }
  r.u16();                        // reserved
  const inhabitedTime = r.u32();

  const chunk = world.createChunk(cx, cz);
  const previous = chunk.sections;
  chunk.sections = new Array(SECTION_COUNT).fill(null);
  chunk.status = status;
  chunk.inhabitedTime = inhabitedTime;

  readI16Array(r, chunk.heightmap);
  readI16Array(r, chunk.lightHeightmap);
  readI16Array(r, chunk.surfaceHeightmap);
  readU8Array(r, chunk.biomes);

  for (let sy = 0; sy < SECTION_COUNT; sy++) {
    if (r.u8() === 0) continue;
    const s = new Section(chunk, sy, 0);
    s.uniformSky = r.u8();
    readBlocks(r, s);
    s.skyLight = readLight(r);
    s.blockLight = readLight(r);
    recountSection(s);
    s.dirty = true;
    // Keep the GPU handle where one already existed so it can be replaced
    // rather than orphaned.
    const old = previous[sy];
    if (old && old.mesh) s.mesh = old.mesh;
    chunk.sections[sy] = s;
  }

  chunk.blockEntities.clear();
  const jsonLength = r.u32();
  const extras = jsonLength ? decodeJson(r.slice(jsonLength)) : null;
  if (extras?.be) {
    const factory = world.game?.modules?.blockEntity?.fromJSON ?? null;
    for (const [key, data] of extras.be) {
      let be = data;
      if (factory) {
        const y = (key >> 8) + MIN_Y;
        const lx = key & 15, lz = (key >> 4) & 15;
        try {
          be = factory(data, chunk.x0 + lx, y, chunk.z0 + lz, world) ?? data;
        } catch { be = data; }
      }
      chunk.blockEntities.set(key, be);
    }
  }
  chunk.generatedStructures = extras?.st ?? null;

  chunk.markAllDirty();
  chunk.needsSave = false;
  return chunk;
}

/** Header-only probe: `{ version, cx, cz, status }`, or null when unreadable. */
export function readChunkHeader(buffer) {
  try {
    const r = new Reader(buffer);
    if (r.u32() !== MAGIC) return null;
    const version = r.u16();
    r.u16();
    const cx = r.i32(), cz = r.i32();
    const status = r.u8();
    return { version, cx, cz, status };
  } catch {
    return null;
  }
}

export { HEIGHTMAP_LEN };
