// Chunk storage.
//
// A chunk is a 16x16 column split into 16-block-tall sections. Sections that
// contain nothing but a single state (usually air, sometimes bedrock-adjacent
// stone or water) store no array at all, which is what keeps a 384-block-tall
// world affordable in a browser — the vast majority of sections above and below
// the surface are uniform.

import { T } from './blocks.js';

export const CHUNK_SIZE = 16;
export const CHUNK_MASK = 15;
export const CHUNK_BITS = 4;
export const SECTION_HEIGHT = 16;
export const SECTION_VOLUME = CHUNK_SIZE * CHUNK_SIZE * SECTION_HEIGHT;

/** World vertical extent, matching modern Minecraft: y in [-64, 319]. */
export const MIN_Y = -64;
export const SECTION_COUNT = 24;
export const WORLD_HEIGHT = SECTION_COUNT * SECTION_HEIGHT; // 384
export const MAX_Y = MIN_Y + WORLD_HEIGHT - 1;              // 319
export const SEA_LEVEL = 63;

/** Section index (0..23) for a world Y, or -1 when out of bounds. */
export const sectionIndexOf = (y) => (y - MIN_Y) >> 4;
export const inWorldY = (y) => y >= MIN_Y && y <= MAX_Y;

/** Local index within a section from local coordinates. */
export const localIndex = (lx, ly, lz) => (ly << 8) | (lz << 4) | lx;

/** Pack a chunk coordinate pair into a map key. */
export const chunkKey = (cx, cz) => `${cx},${cz}`;

/**
 * One 16^3 cube of blocks plus its light data.
 *
 * `blocks` is null while the section is uniform; `uniform` then holds the state
 * every cell contains. The first write to a differing state materialises the
 * array. Light arrays are allocated on demand in the same way.
 */
export class Section {
  constructor(chunk, index, uniform = 0) {
    this.chunk = chunk;
    this.index = index;              // 0..SECTION_COUNT-1
    this.y = MIN_Y + index * SECTION_HEIGHT;
    this.blocks = null;              // Uint16Array(4096) of state ids
    this.uniform = uniform;          // valid while blocks === null
    this.skyLight = null;            // Uint8Array(4096), 0..15
    this.blockLight = null;          // Uint8Array(4096), 0..15
    this.uniformSky = 0;
    this.nonAir = 0;                 // count of non-air cells
    this.randomTickable = 0;         // count of cells wanting random ticks
    this.dirty = true;               // needs remesh
    this.mesh = null;                // renderer-owned GPU handle
    this.empty = uniform === 0;
  }

  get(lx, ly, lz) {
    return this.blocks ? this.blocks[localIndex(lx, ly, lz)] : this.uniform;
  }

  getIndex(i) {
    return this.blocks ? this.blocks[i] : this.uniform;
  }

  /** Materialise the backing array when a uniform section becomes mixed. */
  materialise() {
    if (this.blocks) return this.blocks;
    const arr = new Uint16Array(SECTION_VOLUME);
    if (this.uniform !== 0) arr.fill(this.uniform);
    this.blocks = arr;
    return arr;
  }

  set(lx, ly, lz, state) {
    return this.setIndex(localIndex(lx, ly, lz), state);
  }

  setIndex(i, state) {
    const prev = this.blocks ? this.blocks[i] : this.uniform;
    if (prev === state) return prev;
    if (!this.blocks) {
      if (state === this.uniform) return prev;
      this.materialise();
    }
    this.blocks[i] = state;
    if (prev === 0 && state !== 0) this.nonAir++;
    else if (prev !== 0 && state === 0) this.nonAir--;
    this.empty = this.nonAir === 0;
    this.dirty = true;
    return prev;
  }

  /** Bulk fill used by the generator before any light exists. */
  fillRange(y0, y1, state) {
    const arr = this.materialise();
    const from = y0 << 8, to = (y1 + 1) << 8;
    arr.fill(state, from, to);
    this.recount();
  }

  recount() {
    if (!this.blocks) { this.nonAir = this.uniform === 0 ? 0 : SECTION_VOLUME; }
    else {
      let n = 0;
      const a = this.blocks;
      for (let i = 0; i < SECTION_VOLUME; i++) if (a[i] !== 0) n++;
      this.nonAir = n;
    }
    this.empty = this.nonAir === 0;
    // Collapse back to uniform when the whole section became one state again.
    if (this.blocks) {
      const first = this.blocks[0];
      let same = true;
      for (let i = 1; i < SECTION_VOLUME; i++) {
        if (this.blocks[i] !== first) { same = false; break; }
      }
      if (same) { this.blocks = null; this.uniform = first; }
    }
  }

  getSkyLight(i) {
    return this.skyLight ? this.skyLight[i] : this.uniformSky;
  }

  setSkyLight(i, v) {
    if (!this.skyLight) {
      if (v === this.uniformSky) return;
      this.skyLight = new Uint8Array(SECTION_VOLUME);
      if (this.uniformSky) this.skyLight.fill(this.uniformSky);
    }
    this.skyLight[i] = v;
  }

  getBlockLight(i) {
    return this.blockLight ? this.blockLight[i] : 0;
  }

  setBlockLight(i, v) {
    if (!this.blockLight) {
      if (v === 0) return;
      this.blockLight = new Uint8Array(SECTION_VOLUME);
    }
    this.blockLight[i] = v;
  }

  fillSkyLight(v) {
    this.skyLight = null;
    this.uniformSky = v;
  }
}

/** Chunk load lifecycle. Chunks advance through these in order. */
export const CHUNK_STATE = {
  EMPTY: 0,
  TERRAIN: 1,     // base blocks placed
  DECORATED: 2,   // features & structures placed (needs neighbours generated)
  LIT: 3,         // initial light computed
  READY: 4,       // meshed and renderable
};

export class Chunk {
  constructor(world, cx, cz) {
    this.world = world;
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKey(cx, cz);
    this.x0 = cx * CHUNK_SIZE;
    this.z0 = cz * CHUNK_SIZE;
    this.sections = new Array(SECTION_COUNT).fill(null);
    this.status = CHUNK_STATE.EMPTY;
    /** Highest non-air block per column (world Y), or MIN_Y-1 when empty. */
    this.heightmap = new Int16Array(CHUNK_SIZE * CHUNK_SIZE).fill(MIN_Y - 1);
    /** Highest block that blocks skylight — the skylight propagation start. */
    this.lightHeightmap = new Int16Array(CHUNK_SIZE * CHUNK_SIZE).fill(MIN_Y - 1);
    /** Highest solid surface for mob spawning / feature placement. */
    this.surfaceHeightmap = new Int16Array(CHUNK_SIZE * CHUNK_SIZE).fill(MIN_Y - 1);
    /** Biome id per 4x4x4 cell — 4*4*(SECTION_COUNT*4) entries. */
    this.biomes = new Uint8Array(4 * 4 * SECTION_COUNT * 4);
    this.blockEntities = new Map();   // localKey -> block entity object
    this.entities = new Set();
    this.dirtySections = new Set();
    this.needsSave = false;
    this.lastAccess = 0;
    this.generatedStructures = null;
    this.inhabitedTime = 0;
  }

  section(sy, create = false) {
    let s = this.sections[sy];
    if (!s && create) {
      s = new Section(this, sy);
      this.sections[sy] = s;
    }
    return s;
  }

  /** Read a state using chunk-local x/z (0..15) and absolute y. */
  getBlock(lx, y, lz) {
    if (y < MIN_Y || y > MAX_Y) return 0;
    const si = (y - MIN_Y) >> 4;
    const s = this.sections[si];
    if (!s) return 0;
    return s.get(lx, y & 15, lz);
  }

  setBlock(lx, y, lz, state) {
    if (y < MIN_Y || y > MAX_Y) return 0;
    const si = (y - MIN_Y) >> 4;
    let s = this.sections[si];
    if (!s) {
      if (state === 0) return 0;
      s = this.section(si, true);
    }
    const prev = s.set(lx, y & 15, lz, state);
    if (prev !== state) {
      this.needsSave = true;
      this.updateHeightmapOnSet(lx, y, lz, state, prev);
    }
    return prev;
  }

  updateHeightmapOnSet(lx, y, lz, state, prev) {
    const hi = lz * CHUNK_SIZE + lx;
    if (state !== 0) {
      if (y > this.heightmap[hi]) this.heightmap[hi] = y;
      if (T.filter[state] > 0 && y > this.lightHeightmap[hi]) this.lightHeightmap[hi] = y;
      if (T.solid[state] && y > this.surfaceHeightmap[hi]) this.surfaceHeightmap[hi] = y;
    } else if (y === this.heightmap[hi] || y === this.lightHeightmap[hi] ||
      y === this.surfaceHeightmap[hi]) {
      this.recomputeColumn(lx, lz);
    } else if (T.filter[prev] > 0 && y === this.lightHeightmap[hi]) {
      this.recomputeColumn(lx, lz);
    }
  }

  recomputeColumn(lx, lz) {
    const hi = lz * CHUNK_SIZE + lx;
    let h = MIN_Y - 1, lh = MIN_Y - 1, sh = MIN_Y - 1;
    for (let si = SECTION_COUNT - 1; si >= 0; si--) {
      const s = this.sections[si];
      if (!s || s.empty) continue;
      const baseY = MIN_Y + si * SECTION_HEIGHT;
      for (let ly = SECTION_HEIGHT - 1; ly >= 0; ly--) {
        const st = s.get(lx, ly, lz);
        if (st === 0) continue;
        const y = baseY + ly;
        if (h < MIN_Y) h = y;
        if (lh < MIN_Y && T.filter[st] > 0) lh = y;
        if (sh < MIN_Y && T.solid[st]) sh = y;
        if (h >= MIN_Y && lh >= MIN_Y && sh >= MIN_Y) break;
      }
      if (h >= MIN_Y && lh >= MIN_Y && sh >= MIN_Y) break;
    }
    this.heightmap[hi] = h;
    this.lightHeightmap[hi] = lh;
    this.surfaceHeightmap[hi] = sh;
  }

  recomputeHeightmaps() {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) this.recomputeColumn(lx, lz);
    }
  }

  /** Height of the highest non-air block in a column. */
  height(lx, lz) { return this.heightmap[lz * CHUNK_SIZE + lx]; }
  lightHeight(lx, lz) { return this.lightHeightmap[lz * CHUNK_SIZE + lx]; }
  surfaceHeight(lx, lz) { return this.surfaceHeightmap[lz * CHUNK_SIZE + lx]; }

  // --- Biomes (stored per 4x4x4 cell, as in modern Minecraft) --------------

  biomeIndex(lx, y, lz) {
    const by = Math.min(SECTION_COUNT * 4 - 1, Math.max(0, (y - MIN_Y) >> 2));
    return (by << 4) | ((lz >> 2) << 2) | (lx >> 2);
  }

  getBiome(lx, y, lz) { return this.biomes[this.biomeIndex(lx, y, lz)]; }
  setBiome(lx, y, lz, b) { this.biomes[this.biomeIndex(lx, y, lz)] = b; }

  /** The surface biome for a column — what feature placement and sky use. */
  getSurfaceBiome(lx, lz) {
    const h = Math.max(this.surfaceHeightmap[lz * CHUNK_SIZE + lx], MIN_Y);
    return this.getBiome(lx, h, lz);
  }

  // --- Light ---------------------------------------------------------------

  getSkyLight(lx, y, lz) {
    if (y > MAX_Y) return 15;
    if (y < MIN_Y) return 0;
    const s = this.sections[(y - MIN_Y) >> 4];
    if (!s) return this.lightHeightmap[lz * CHUNK_SIZE + lx] < y ? 15 : 0;
    return s.getSkyLight(localIndex(lx, y & 15, lz));
  }

  setSkyLight(lx, y, lz, v) {
    if (y < MIN_Y || y > MAX_Y) return;
    const s = this.section((y - MIN_Y) >> 4, true);
    s.setSkyLight(localIndex(lx, y & 15, lz), v);
  }

  getBlockLight(lx, y, lz) {
    if (y < MIN_Y || y > MAX_Y) return 0;
    const s = this.sections[(y - MIN_Y) >> 4];
    return s ? s.getBlockLight(localIndex(lx, y & 15, lz)) : 0;
  }

  setBlockLight(lx, y, lz, v) {
    if (y < MIN_Y || y > MAX_Y) return;
    const s = this.section((y - MIN_Y) >> 4, true);
    s.setBlockLight(localIndex(lx, y & 15, lz), v);
  }

  // --- Block entities ------------------------------------------------------

  static beKey(lx, y, lz) { return ((y - MIN_Y) << 8) | (lz << 4) | lx; }

  getBlockEntity(lx, y, lz) { return this.blockEntities.get(Chunk.beKey(lx, y, lz)) || null; }

  setBlockEntity(lx, y, lz, be) {
    const k = Chunk.beKey(lx, y, lz);
    if (be) this.blockEntities.set(k, be); else this.blockEntities.delete(k);
    this.needsSave = true;
  }

  markDirty(sy) {
    const s = this.sections[sy];
    if (s) s.dirty = true;
    this.dirtySections.add(sy);
  }

  markAllDirty() {
    for (let i = 0; i < SECTION_COUNT; i++) {
      if (this.sections[i]) { this.sections[i].dirty = true; this.dirtySections.add(i); }
    }
  }

  /** Release GPU resources; called when the chunk unloads. */
  dispose(renderer) {
    for (const s of this.sections) {
      if (s && s.mesh) { renderer?.releaseMesh(s.mesh); s.mesh = null; }
    }
  }
}
