// Light propagation.
//
// Two independent 4-bit channels: skylight (falls straight down at full
// strength, spreads sideways losing one level per block) and block light
// (radiates from emitters, losing one level per block). Both use a flood fill
// over a packed queue; removal runs a "darkening" pass first that clears any
// cell whose light could only have come from the removed source, then re-floods
// from the boundary it exposed.

import { MIN_Y, MAX_Y, CHUNK_SIZE, SECTION_HEIGHT } from './chunk.js';
import { T } from './blocks.js';
import { FACES } from '../core/math.js';

/**
 * Queue entries pack a world position and a light level into two numbers.
 * Positions can be negative so x/z are biased into unsigned ranges.
 */
const POS_BIAS = 1 << 25;

class LightQueue {
  constructor() {
    this.x = new Int32Array(4096);
    this.y = new Int16Array(4096);
    this.z = new Int32Array(4096);
    this.v = new Uint8Array(4096);
    this.head = 0;
    this.tail = 0;
    this.cap = 4096;
  }

  get size() { return this.tail - this.head; }

  push(x, y, z, v) {
    if (this.tail === this.cap) this.compact();
    this.x[this.tail] = x;
    this.y[this.tail] = y;
    this.z[this.tail] = z;
    this.v[this.tail] = v;
    this.tail++;
  }

  compact() {
    const n = this.tail - this.head;
    if (this.head > 0 && n < this.cap * 0.75) {
      this.x.copyWithin(0, this.head, this.tail);
      this.y.copyWithin(0, this.head, this.tail);
      this.z.copyWithin(0, this.head, this.tail);
      this.v.copyWithin(0, this.head, this.tail);
    } else {
      const cap = this.cap * 2;
      const nx = new Int32Array(cap), ny = new Int16Array(cap);
      const nz = new Int32Array(cap), nv = new Uint8Array(cap);
      nx.set(this.x.subarray(this.head, this.tail));
      ny.set(this.y.subarray(this.head, this.tail));
      nz.set(this.z.subarray(this.head, this.tail));
      nv.set(this.v.subarray(this.head, this.tail));
      this.x = nx; this.y = ny; this.z = nz; this.v = nv;
      this.cap = cap;
    }
    this.tail = n;
    this.head = 0;
  }

  clear() { this.head = this.tail = 0; }
}

export class LightEngine {
  constructor(world) {
    this.world = world;
    this.blockAdd = new LightQueue();
    this.blockRemove = new LightQueue();
    this.skyAdd = new LightQueue();
    this.skyRemove = new LightQueue();
    this.touched = new Set();   // 'cx,cz,sy' keys needing a remesh
    this.enabled = true;
  }

  markSection(x, y, z) {
    const cx = x >> 4, cz = z >> 4;
    const sy = (y - MIN_Y) >> 4;
    this.touched.add(`${cx},${cz},${sy}`);
    // Light changes at a section edge alter the neighbour's baked vertex light.
    const lx = x & 15, lz = z & 15, ly = (y - MIN_Y) & 15;
    if (lx === 0) this.touched.add(`${cx - 1},${cz},${sy}`);
    else if (lx === 15) this.touched.add(`${cx + 1},${cz},${sy}`);
    if (lz === 0) this.touched.add(`${cx},${cz - 1},${sy}`);
    else if (lz === 15) this.touched.add(`${cx},${cz + 1},${sy}`);
    if (ly === 0 && sy > 0) this.touched.add(`${cx},${cz},${sy - 1}`);
    else if (ly === 15) this.touched.add(`${cx},${cz},${sy + 1}`);
  }

  // --- Block light ---------------------------------------------------------

  /** Called after a block change at (x,y,z) from `prev` to `next`. */
  onBlockChanged(x, y, z, prev, next) {
    if (!this.enabled) return;
    const world = this.world;
    const emitPrev = T.light[prev], emitNext = T.light[next];
    const opaquePrev = T.filter[prev], opaqueNext = T.filter[next];

    // Block light
    const cur = world.getBlockLight(x, y, z);
    if (emitPrev > 0 || opaqueNext !== opaquePrev || cur > 0) {
      if (cur > 0) {
        this.blockRemove.push(x, y, z, cur);
        world.setBlockLight(x, y, z, 0);
      }
    }
    if (emitNext > 0) {
      world.setBlockLight(x, y, z, emitNext);
      this.blockAdd.push(x, y, z, emitNext);
    }
    // Opening a hole lets neighbours flood back in.
    if (opaqueNext < opaquePrev) {
      for (const f of FACES) {
        const nx = x + f.dx, ny = y + f.dy, nz = z + f.dz;
        const l = world.getBlockLight(nx, ny, nz);
        if (l > 1) this.blockAdd.push(nx, ny, nz, l);
      }
    }

    // Sky light
    this.updateSkyColumn(x, y, z, prev, next);
  }

  updateSkyColumn(x, y, z, prev, next) {
    const world = this.world;
    const chunk = world.getChunkAt(x, z);
    if (!chunk) return;
    const lx = x & 15, lz = z & 15;
    const hi = lz * CHUNK_SIZE + lx;
    const oldTop = chunk.lightHeightmap[hi];
    chunk.recomputeColumn(lx, lz);
    const newTop = chunk.lightHeightmap[hi];

    if (newTop < oldTop) {
      // A blocker was removed: everything from newTop+1..oldTop sees the sky.
      for (let yy = newTop + 1; yy <= oldTop; yy++) {
        if (world.getSkyLight(x, yy, z) !== 15) {
          world.setSkyLight(x, yy, z, 15);
          this.skyAdd.push(x, yy, z, 15);
        }
      }
      const cur = world.getSkyLight(x, y, z);
      if (cur > 0) this.skyAdd.push(x, y, z, cur);
      for (const f of FACES) {
        const l = world.getSkyLight(x + f.dx, y + f.dy, z + f.dz);
        if (l > 1) this.skyAdd.push(x + f.dx, y + f.dy, z + f.dz, l);
      }
    } else if (newTop > oldTop) {
      // A blocker was added: the column below it loses direct sky.
      for (let yy = oldTop + 1; yy <= newTop; yy++) {
        const cur = world.getSkyLight(x, yy, z);
        if (cur > 0) {
          this.skyRemove.push(x, yy, z, cur);
          world.setSkyLight(x, yy, z, 0);
        }
      }
    } else {
      const cur = world.getSkyLight(x, y, z);
      const filterNext = T.filter[next];
      if (filterNext >= 15 && cur > 0) {
        this.skyRemove.push(x, y, z, cur);
        world.setSkyLight(x, y, z, 0);
      } else if (T.filter[prev] > T.filter[next]) {
        for (const f of FACES) {
          const l = world.getSkyLight(x + f.dx, y + f.dy, z + f.dz);
          if (l > 1) this.skyAdd.push(x + f.dx, y + f.dy, z + f.dz, l);
        }
      } else if (cur > 0 && T.filter[next] > T.filter[prev]) {
        this.skyRemove.push(x, y, z, cur);
        world.setSkyLight(x, y, z, 0);
      }
    }
    this.markSection(x, y, z);
  }

  /** Queue an emitter, e.g. when a torch is placed by world generation. */
  addBlockLight(x, y, z, level) {
    if (level <= 0) return;
    if (this.world.getBlockLight(x, y, z) >= level) return;
    this.world.setBlockLight(x, y, z, level);
    this.blockAdd.push(x, y, z, level);
  }

  // --- Flood fill ----------------------------------------------------------

  /** Run at most `budget` cell visits; returns true when all queues drained. */
  process(budget = 24000) {
    let work = 0;
    work += this.processRemove(this.blockRemove, this.blockAdd, false, budget - work);
    work += this.processAdd(this.blockAdd, false, budget - work);
    work += this.processRemove(this.skyRemove, this.skyAdd, true, budget - work);
    work += this.processAdd(this.skyAdd, true, budget - work);
    return this.blockAdd.size === 0 && this.blockRemove.size === 0 &&
      this.skyAdd.size === 0 && this.skyRemove.size === 0;
  }

  processAdd(queue, sky, budget) {
    const world = this.world;
    let n = 0;
    while (queue.size > 0 && n < budget) {
      const i = queue.head++;
      const x = queue.x[i], y = queue.y[i], z = queue.z[i], level = queue.v[i];
      n++;
      const actual = sky ? world.getSkyLight(x, y, z) : world.getBlockLight(x, y, z);
      if (actual !== level) continue;   // superseded by a later update
      if (level <= 1) continue;
      for (let f = 0; f < 6; f++) {
        const d = FACES[f];
        const nx = x + d.dx, ny = y + d.dy, nz = z + d.dz;
        if (ny < MIN_Y || ny > MAX_Y) continue;
        if (!world.isChunkLoadedAt(nx, nz)) continue;
        const st = world.getBlock(nx, ny, nz);
        const filter = Math.max(1, T.filter[st]);
        if (filter >= 15 && T.opaque[st]) continue;
        // Skylight travelling straight down through fully transparent blocks
        // keeps its level, which is what makes deep shafts bright.
        let next;
        if (sky && d.dy === -1 && level === 15 && T.filter[st] === 0) next = 15;
        else next = level - filter;
        if (next <= 0) continue;
        const cur = sky ? world.getSkyLight(nx, ny, nz) : world.getBlockLight(nx, ny, nz);
        if (cur >= next) continue;
        if (sky) world.setSkyLight(nx, ny, nz, next);
        else world.setBlockLight(nx, ny, nz, next);
        this.markSection(nx, ny, nz);
        queue.push(nx, ny, nz, next);
      }
    }
    if (queue.head > 8192) queue.compact();
    return n;
  }

  processRemove(queue, addQueue, sky, budget) {
    const world = this.world;
    let n = 0;
    while (queue.size > 0 && n < budget) {
      const i = queue.head++;
      const x = queue.x[i], y = queue.y[i], z = queue.z[i], level = queue.v[i];
      n++;
      for (let f = 0; f < 6; f++) {
        const d = FACES[f];
        const nx = x + d.dx, ny = y + d.dy, nz = z + d.dz;
        if (ny < MIN_Y || ny > MAX_Y) continue;
        if (!world.isChunkLoadedAt(nx, nz)) continue;
        const cur = sky ? world.getSkyLight(nx, ny, nz) : world.getBlockLight(nx, ny, nz);
        if (cur === 0) continue;
        const downFullSky = sky && d.dy === -1 && level === 15;
        if (cur < level || downFullSky) {
          // This cell was lit by the removed source (or is directly beneath a
          // now-blocked sky column) — clear it and keep unwinding.
          if (sky) world.setSkyLight(nx, ny, nz, 0);
          else world.setBlockLight(nx, ny, nz, 0);
          this.markSection(nx, ny, nz);
          queue.push(nx, ny, nz, cur === 0 ? level : cur);
        } else {
          // Brighter than the removed source: it becomes a re-flood seed.
          addQueue.push(nx, ny, nz, cur);
        }
      }
    }
    if (queue.head > 8192) queue.compact();
    return n;
  }

  /**
   * Seed skylight for a freshly generated chunk. Columns are filled from the
   * top down to the first light-blocking block, then edges are queued so light
   * can spread sideways into neighbouring chunks.
   */
  initialiseChunkLight(chunk) {
    const world = this.world;
    const x0 = chunk.x0, z0 = chunk.z0;
    // Fully-lit sections above the tallest column need no per-cell storage.
    let maxTop = MIN_Y - 1;
    for (let i = 0; i < chunk.lightHeightmap.length; i++) {
      if (chunk.lightHeightmap[i] > maxTop) maxTop = chunk.lightHeightmap[i];
    }
    const topSection = Math.min(23, ((maxTop - MIN_Y) >> 4) + 1);
    for (let sy = topSection + 1; sy < 24; sy++) {
      const s = chunk.section(sy, true);
      s.fillSkyLight(15);
    }
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const top = chunk.lightHeightmap[lz * CHUNK_SIZE + lx];
        const startY = (topSection + 1) * SECTION_HEIGHT + MIN_Y - 1;
        for (let y = startY; y > top; y--) {
          chunk.setSkyLight(lx, y, lz, 15);
        }
        // Queue the lowest sky-lit cell of the column so it spreads sideways.
        if (top >= MIN_Y - 1) {
          const y = top + 1;
          if (y <= startY) this.skyAdd.push(x0 + lx, y, z0 + lz, 15);
        }
      }
    }
    // Block emitters placed by generation (lava, glowstone, torches in rooms).
    for (let sy = 0; sy < 24; sy++) {
      const s = chunk.sections[sy];
      if (!s || s.empty) continue;
      if (!s.blocks) {
        if (T.light[s.uniform] > 0) {
          const baseY = MIN_Y + sy * 16;
          for (let ly = 0; ly < 16; ly++) {
            for (let lz = 0; lz < 16; lz++) {
              for (let lx = 0; lx < 16; lx++) {
                this.addBlockLight(x0 + lx, baseY + ly, z0 + lz, T.light[s.uniform]);
              }
            }
          }
        }
        continue;
      }
      const arr = s.blocks;
      const baseY = MIN_Y + sy * 16;
      for (let i = 0; i < arr.length; i++) {
        const e = T.light[arr[i]];
        if (e > 0) {
          const lx = i & 15, lz = (i >> 4) & 15, ly = i >> 8;
          this.addBlockLight(x0 + lx, baseY + ly, z0 + lz, e);
        }
      }
    }
  }

  /** Re-queue light at the seam when a neighbouring chunk appears. */
  relightBorder(chunk, dx, dz) {
    const world = this.world;
    const x0 = chunk.x0, z0 = chunk.z0;
    const xs = dx === -1 ? [0] : dx === 1 ? [15] : [0, 15];
    const zs = dz === -1 ? [0] : dz === 1 ? [15] : [0, 15];
    const cells = [];
    if (dx !== 0) for (let lz = 0; lz < 16; lz++) cells.push([xs[0], lz]);
    if (dz !== 0) for (let lx = 0; lx < 16; lx++) cells.push([lx, zs[0]]);
    for (const [lx, lz] of cells) {
      const x = x0 + lx, z = z0 + lz;
      for (let y = MIN_Y; y <= MAX_Y; y++) {
        const sl = world.getSkyLight(x, y, z);
        if (sl > 1) this.skyAdd.push(x, y, z, sl);
        const bl = world.getBlockLight(x, y, z);
        if (bl > 1) this.blockAdd.push(x, y, z, bl);
      }
    }
  }

  /** Drain and return the set of sections whose light changed. */
  takeTouched() {
    if (this.touched.size === 0) return null;
    const t = this.touched;
    this.touched = new Set();
    return t;
  }
}
