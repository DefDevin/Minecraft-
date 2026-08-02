// The World: chunk lifecycle, block access, ticking, physics queries.
//
// A World owns one dimension. Block coordinates are absolute integers; chunk
// coordinates are `x >> 4`. Nothing here talks to WebGL — the renderer observes
// `dirtySections` and the entity list.

import {
  Chunk, CHUNK_SIZE, CHUNK_STATE, MIN_Y, MAX_Y, SEA_LEVEL, SECTION_COUNT,
  SECTION_HEIGHT, chunkKey, localIndex,
} from './chunk.js';
import { T, blockOf, getProp, FULL_AABB } from './blocks.js';
import { LightEngine } from './lighting.js';
import { AABB, FACES, clamp } from '../core/math.js';
import { Random, hash3 } from '../core/rng.js';

/** How many blocks of a chunk radius stay loaded beyond the render distance. */
export const CHUNK_KEEP_MARGIN = 2;

/** Block-update flags for `setBlock`. */
export const FLAG = {
  NONE: 0,
  NOTIFY_NEIGHBORS: 1,
  UPDATE_LIGHT: 2,
  MARK_DIRTY: 4,
  DROP_ITEMS: 8,
  PLAY_SOUND: 16,
  SKIP_SELF_UPDATE: 32,
  DEFAULT: 1 | 2 | 4,
  GENERATION: 0,
};

export class World {
  /**
   * @param {object} opts
   * @param {number} opts.seed
   * @param {string} opts.dimension 'overworld' | 'nether' | 'end'
   * @param {object} opts.generator implements generateChunk(chunk) / decorate(chunk)
   */
  constructor(opts) {
    this.seed = opts.seed | 0;
    this.dimension = opts.dimension || 'overworld';
    this.generator = opts.generator || null;
    this.game = opts.game || null;
    this.chunks = new Map();
    this.light = new LightEngine(this);
    this.entities = [];
    this.entitiesById = new Map();
    this.nextEntityId = 1;
    this.players = [];

    // Time & weather
    this.time = 1000;            // ticks; 0 = sunrise, 6000 = noon, 18000 = midnight
    this.dayLength = 24000;
    this.doDaylightCycle = true;
    this.rainLevel = 0;
    this.thunderLevel = 0;
    this.rainTime = 12000 + ((this.seed >>> 4) % 168000);
    this.thunderTime = 60000 + ((this.seed >>> 8) % 120000);
    this.raining = false;
    this.thundering = false;

    this.tickCount = 0;
    this.randomTickSpeed = 3;
    this.difficulty = 2;         // 0 peaceful, 1 easy, 2 normal, 3 hard
    this.random = new Random(this.seed ^ 0x9e3779b9);

    // Scheduled ticks: key -> {x,y,z,block,tick,priority}
    this.scheduled = new Map();
    this.scheduledQueue = [];
    this.pendingNeighborUpdates = [];

    this.hasSkylight = opts.hasSkylight ?? (this.dimension === 'overworld');
    this.ambientLight = opts.ambientLight ?? (this.dimension === 'nether' ? 0.1 : 0);
    this.ceiling = opts.ceiling ?? (this.dimension === 'nether');
    this.spawnPos = { x: 0, y: 80, z: 0 };

    this.listeners = { blockChange: [], chunkLoad: [], chunkUnload: [], sound: [], particle: [] };
    this.stats = { chunksLoaded: 0, blockUpdates: 0 };
  }

  // --- Events --------------------------------------------------------------

  on(evt, fn) { this.listeners[evt].push(fn); return this; }
  emit(evt, a, b, c, d, e) {
    const l = this.listeners[evt];
    for (let i = 0; i < l.length; i++) l[i](a, b, c, d, e);
  }

  // --- Chunk access --------------------------------------------------------

  getChunk(cx, cz) { return this.chunks.get(chunkKey(cx, cz)) || null; }
  getChunkAt(x, z) { return this.chunks.get(chunkKey(x >> 4, z >> 4)) || null; }
  isChunkLoaded(cx, cz) { return this.chunks.has(chunkKey(cx, cz)); }
  isChunkLoadedAt(x, z) { return this.chunks.has(chunkKey(x >> 4, z >> 4)); }

  /** Create an empty chunk record. Generation is driven by the ChunkLoader. */
  createChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    let c = this.chunks.get(key);
    if (c) return c;
    c = new Chunk(this, cx, cz);
    this.chunks.set(key, c);
    this.stats.chunksLoaded++;
    return c;
  }

  unloadChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    const c = this.chunks.get(key);
    if (!c) return;
    this.emit('chunkUnload', c);
    for (const e of c.entities) this.removeEntity(e, true);
    this.chunks.delete(key);
    this.stats.chunksLoaded--;
  }

  // --- Block access --------------------------------------------------------

  /** State id at a position; 0 (air) outside loaded chunks or vertical bounds. */
  getBlock(x, y, z) {
    if (y < MIN_Y || y > MAX_Y) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return 0;
    const s = c.sections[(y - MIN_Y) >> 4];
    if (!s) return 0;
    return s.blocks ? s.blocks[localIndex(x & 15, (y - MIN_Y) & 15, z & 15)] : s.uniform;
  }

  /** The Block definition at a position. */
  getBlockDef(x, y, z) { return blockOf(this.getBlock(x, y, z)); }

  getBlockName(x, y, z) {
    const b = blockOf(this.getBlock(x, y, z));
    return b ? b.name : 'air';
  }

  isSolid(x, y, z) { return T.solid[this.getBlock(x, y, z)] === 1; }
  isOpaque(x, y, z) { return T.opaque[this.getBlock(x, y, z)] === 1; }
  isAirAt(x, y, z) { return this.getBlock(x, y, z) === 0; }
  isReplaceable(x, y, z) { return T.replaceable[this.getBlock(x, y, z)] === 1; }

  /**
   * Write a block state.
   * @returns the previous state, or -1 when the write was rejected.
   */
  setBlock(x, y, z, state, flags = FLAG.DEFAULT) {
    if (y < MIN_Y || y > MAX_Y) return -1;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return -1;
    const lx = x & 15, lz = z & 15;
    const prev = c.setBlock(lx, y, lz, state);
    if (prev === state) return prev;

    const sy = (y - MIN_Y) >> 4;
    if (flags & FLAG.MARK_DIRTY) {
      this.markDirtyAround(x, y, z, c, sy);
    }

    // Block entities are created/destroyed with their block.
    const prevDef = blockOf(prev), nextDef = blockOf(state);
    if (prevDef && prevDef.hasEntity && (!nextDef || !nextDef.hasEntity ||
      prevDef !== nextDef)) {
      c.setBlockEntity(lx, y, lz, null);
    }
    if (nextDef && nextDef.hasEntity && !c.getBlockEntity(lx, y, lz)) {
      const be = this.game?.createBlockEntity?.(nextDef, x, y, z, state);
      if (be) c.setBlockEntity(lx, y, lz, be);
    }

    if (flags & FLAG.UPDATE_LIGHT) this.light.onBlockChanged(x, y, z, prev, state);
    if (flags & FLAG.NOTIFY_NEIGHBORS) this.notifyNeighbors(x, y, z, state, prev);

    this.stats.blockUpdates++;
    this.emit('blockChange', x, y, z, state, prev);
    return prev;
  }

  markDirtyAround(x, y, z, c, sy) {
    c.markDirty(sy);
    const lx = x & 15, lz = z & 15, ly = (y - MIN_Y) & 15;
    const cx = x >> 4, cz = z >> 4;
    if (lx === 0) this.getChunk(cx - 1, cz)?.markDirty(sy);
    else if (lx === 15) this.getChunk(cx + 1, cz)?.markDirty(sy);
    if (lz === 0) this.getChunk(cx, cz - 1)?.markDirty(sy);
    else if (lz === 15) this.getChunk(cx, cz + 1)?.markDirty(sy);
    if (ly === 0 && sy > 0) c.markDirty(sy - 1);
    else if (ly === 15 && sy < SECTION_COUNT - 1) c.markDirty(sy + 1);
    // Diagonals matter for ambient occlusion sampling at corners.
    if ((lx === 0 || lx === 15) && (lz === 0 || lz === 15)) {
      this.getChunk(cx + (lx === 0 ? -1 : 1), cz + (lz === 0 ? -1 : 1))?.markDirty(sy);
    }
  }

  /** Convenience wrapper used constantly by generation code. */
  setBlockFast(x, y, z, state) { return this.setBlock(x, y, z, state, FLAG.MARK_DIRTY); }

  getBlockEntity(x, y, z) {
    const c = this.getChunkAt(x, z);
    return c ? c.getBlockEntity(x & 15, y, z & 15) : null;
  }

  setBlockEntity(x, y, z, be) {
    const c = this.getChunkAt(x, z);
    if (c) c.setBlockEntity(x & 15, y, z & 15, be);
  }

  // --- Light ---------------------------------------------------------------

  getSkyLight(x, y, z) {
    if (y > MAX_Y) return this.hasSkylight ? 15 : 0;
    if (y < MIN_Y) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return this.hasSkylight ? 15 : 0;
    return c.getSkyLight(x & 15, y, z & 15);
  }

  setSkyLight(x, y, z, v) {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (c) c.setSkyLight(x & 15, y, z & 15, v);
  }

  getBlockLight(x, y, z) {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    return c ? c.getBlockLight(x & 15, y, z & 15) : 0;
  }

  setBlockLight(x, y, z, v) {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (c) c.setBlockLight(x & 15, y, z & 15, v);
  }

  /** Combined 0..15 light used for mob spawning and rendering entities. */
  getLight(x, y, z) {
    const sky = Math.floor(this.getSkyLight(x, y, z) * this.skyLightFactor());
    return Math.max(sky, this.getBlockLight(x, y, z));
  }

  /** Fraction of full skylight reaching the ground right now. */
  skyLightFactor() {
    const a = this.celestialAngle();
    // Brightness curve: full daylight, sharp dusk, ~0.2 at night.
    let f = 1 - (Math.cos(a * Math.PI * 2) * 2 + 0.5);
    f = 1 - clamp(f, 0, 1);
    f = f * (1 - this.rainLevel * 0.3) * (1 - this.thunderLevel * 0.4);
    return 0.2 + f * 0.8;
  }

  /**
   * Minecraft's celestial angle: 0 at noon, 0.25 at sunset, 0.5 at midnight,
   * 0.75 at sunrise. The easing term is what makes the sun linger near the
   * horizon at dawn and dusk instead of sweeping past at a constant rate.
   */
  celestialAngle() {
    const t = ((this.time % this.dayLength) + this.dayLength) % this.dayLength;
    let a = t / this.dayLength - 0.25;
    if (a < 0) a += 1;
    // Minecraft's sun eases near the horizon rather than moving linearly.
    const eased = 0.5 - Math.cos(a * Math.PI) / 2;
    return (a * 2 + eased) / 3;
  }

  isDay() { const t = this.time % this.dayLength; return t < 12000 || t > 23000; }
  isNight() { return !this.isDay(); }
  moonPhase() { return Math.floor(this.time / this.dayLength) % 8; }

  // --- Neighbour & scheduled updates ---------------------------------------

  notifyNeighbors(x, y, z, state, prev) {
    for (let f = 0; f < 6; f++) {
      const d = FACES[f];
      this.updateNeighbor(x + d.dx, y + d.dy, z + d.dz, x, y, z, d.opposite);
    }
  }

  updateNeighbor(x, y, z, fromX, fromY, fromZ, fromFace) {
    const st = this.getBlock(x, y, z);
    if (st === 0) return;
    const def = blockOf(st);
    if (!def) return;
    if (def.canSurvive && !def.canSurvive(this, x, y, z, st)) {
      this.destroyBlock(x, y, z, true);
      return;
    }
    if (def.updateShape) {
      const ns = def.updateShape(this, x, y, z, st, fromFace);
      if (ns !== undefined && ns !== st) {
        this.setBlock(x, y, z, ns, FLAG.DEFAULT);
        return;
      }
    }
    if (def.onNeighborChange) {
      def.onNeighborChange(this, x, y, z, st, fromX, fromY, fromZ);
    }
  }

  /** Schedule a block tick `delay` ticks from now. */
  scheduleTick(x, y, z, blockDef, delay, priority = 0) {
    const key = `${x},${y},${z}`;
    const existing = this.scheduled.get(key);
    const at = this.tickCount + Math.max(1, delay);
    if (existing && existing.at <= at && existing.block === blockDef) return;
    const entry = { x, y, z, block: blockDef, at, priority };
    this.scheduled.set(key, entry);
    this.scheduledQueue.push(entry);
  }

  isTickScheduled(x, y, z) { return this.scheduled.has(`${x},${y},${z}`); }

  runScheduledTicks() {
    if (this.scheduledQueue.length === 0) return;
    const due = [];
    const keep = [];
    for (const e of this.scheduledQueue) {
      if (e.at <= this.tickCount) due.push(e); else keep.push(e);
    }
    this.scheduledQueue = keep;
    due.sort((a, b) => a.priority - b.priority || a.at - b.at);
    for (const e of due) {
      const key = `${e.x},${e.y},${e.z}`;
      if (this.scheduled.get(key) === e) this.scheduled.delete(key);
      const st = this.getBlock(e.x, e.y, e.z);
      const def = blockOf(st);
      if (def && def === e.block && def.onScheduledTick) {
        def.onScheduledTick(this, e.x, e.y, e.z, st, this.random);
      }
    }
  }

  // --- Ticking -------------------------------------------------------------

  tick(dt) {
    this.tickCount++;
    if (this.doDaylightCycle) this.time++;
    this.tickWeather();
    this.runScheduledTicks();
    this.runRandomTicks();
    this.light.process(this.dimension === 'overworld' ? 32000 : 16000);
  }

  tickWeather() {
    if (this.dimension !== 'overworld') return;
    if (--this.rainTime <= 0) {
      this.raining = !this.raining;
      this.rainTime = this.raining
        ? 6000 + this.random.int(6000)
        : 24000 + this.random.int(144000);
    }
    if (--this.thunderTime <= 0) {
      this.thundering = !this.thundering;
      this.thunderTime = this.thundering
        ? 3600 + this.random.int(9000)
        : 24000 + this.random.int(144000);
    }
    const targetRain = this.raining ? 1 : 0;
    this.rainLevel += (targetRain - this.rainLevel) * 0.008;
    const targetThunder = (this.thundering && this.raining) ? 1 : 0;
    this.thunderLevel += (targetThunder - this.thunderLevel) * 0.008;
    if (this.rainLevel < 0.001) this.rainLevel = 0;
    if (this.thunderLevel < 0.001) this.thunderLevel = 0;
  }

  /**
   * Random ticks drive crop growth, grass spread, leaf decay, fire and ice.
   * Minecraft picks `randomTickSpeed` cells per section per tick.
   */
  runRandomTicks() {
    if (this.randomTickSpeed <= 0) return;
    const r = this.random;
    for (const chunk of this.chunks.values()) {
      if (chunk.status < CHUNK_STATE.READY) continue;
      if (!this.isChunkTicking(chunk)) continue;
      for (let sy = 0; sy < SECTION_COUNT; sy++) {
        const s = chunk.sections[sy];
        if (!s || s.empty) continue;
        const baseY = MIN_Y + sy * SECTION_HEIGHT;
        for (let i = 0; i < this.randomTickSpeed; i++) {
          const v = r.nextUint();
          const lx = v & 15, lz = (v >> 4) & 15, ly = (v >> 8) & 15;
          const st = s.get(lx, ly, lz);
          if (st === 0) continue;
          const def = blockOf(st);
          if (def && def.randomTick && def.onRandomTick) {
            def.onRandomTick(this, chunk.x0 + lx, baseY + ly, chunk.z0 + lz, st, r);
          }
        }
      }
    }
  }

  /** Chunks tick only near a player, as in the real game's simulation distance. */
  isChunkTicking(chunk) {
    for (const p of this.players) {
      const dx = (p.x >> 4) - chunk.cx, dz = (p.z >> 4) - chunk.cz;
      if (dx * dx + dz * dz <= this.simulationDistance * this.simulationDistance) return true;
    }
    return false;
  }

  get simulationDistance() { return this._simDist ?? 8; }
  set simulationDistance(v) { this._simDist = v; }

  // --- Entities ------------------------------------------------------------

  addEntity(e) {
    e.id = this.nextEntityId++;
    e.world = this;
    this.entities.push(e);
    this.entitiesById.set(e.id, e);
    if (e.isPlayer) this.players.push(e);
    const c = this.getChunkAt(Math.floor(e.x), Math.floor(e.z));
    if (c) { c.entities.add(e); e.chunk = c; }
    e.onAdded?.();
    return e;
  }

  removeEntity(e, silent = false) {
    const i = this.entities.indexOf(e);
    if (i >= 0) this.entities.splice(i, 1);
    this.entitiesById.delete(e.id);
    if (e.isPlayer) {
      const pi = this.players.indexOf(e);
      if (pi >= 0) this.players.splice(pi, 1);
    }
    e.chunk?.entities.delete(e);
    e.removed = true;
    if (!silent) e.onRemoved?.();
  }

  /** Move an entity between chunk buckets after it moves. */
  updateEntityChunk(e) {
    const c = this.getChunkAt(Math.floor(e.x), Math.floor(e.z));
    if (c !== e.chunk) {
      e.chunk?.entities.delete(e);
      if (c) c.entities.add(e);
      e.chunk = c || null;
    }
  }

  /** Entities whose bounding box intersects `aabb`, excluding `except`. */
  entitiesInBox(aabb, except = null, out = []) {
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (e === except || e.removed) continue;
      if (e.aabb.intersects(aabb)) out.push(e);
    }
    return out;
  }

  nearestPlayer(x, y, z, maxDist = Infinity) {
    let best = null, bestD = maxDist * maxDist;
    for (const p of this.players) {
      if (p.removed || p.isSpectator || p.dead) continue;
      const dx = p.x - x, dy = p.y - y, dz = p.z - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  // --- Physics queries -----------------------------------------------------

  /**
   * Collect world collision boxes overlapping `aabb` into `out` (AABBs in world
   * space). Reused arrays keep this allocation-free in the movement hot path.
   */
  getCollisionBoxes(aabb, out = []) {
    out.length = 0;
    const x0 = Math.floor(aabb.minX - 1), x1 = Math.floor(aabb.maxX + 1);
    const y0 = Math.floor(aabb.minY - 1), y1 = Math.floor(aabb.maxY + 1);
    const z0 = Math.floor(aabb.minZ - 1), z1 = Math.floor(aabb.maxZ + 1);
    for (let y = y0; y <= y1; y++) {
      if (y < MIN_Y || y > MAX_Y) continue;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const st = this.getBlock(x, y, z);
          if (st === 0) continue;
          if (T.solid[st]) {
            const b = scratchAABB(out);
            b.set(x, y, z, x + 1, y + 1, z + 1);
            if (!b.intersects(aabb)) out.pop();
            continue;
          }
          const def = blockOf(st);
          if (!def) continue;
          const boxes = def.collisionFor(st);
          for (let i = 0; i < boxes.length; i++) {
            const s = boxes[i];
            const b = scratchAABB(out);
            b.set(x + s.minX, y + s.minY, z + s.minZ, x + s.maxX, y + s.maxY, z + s.maxZ);
            if (!b.intersects(aabb)) out.pop();
          }
        }
      }
    }
    return out;
  }

  /** True when any block overlapping `aabb` reports the given fluid. */
  isInFluid(aabb, fluidId) {
    const x0 = Math.floor(aabb.minX), x1 = Math.floor(aabb.maxX);
    const y0 = Math.floor(aabb.minY), y1 = Math.floor(aabb.maxY);
    const z0 = Math.floor(aabb.minZ), z1 = Math.floor(aabb.maxZ);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const st = this.getBlock(x, y, z);
          // A waterlogged block (fence, stair, slab with water in it) is water
          // for the purposes of swimming, drowning and buoyancy.
          const logged = fluidId === 1 && T.waterlogged[st] === 1;
          if (T.fluid[st] !== fluidId && !logged) continue;
          const level = logged ? 0 : T.fluidLevel[st];
          const height = level === 0 ? 1 : (8 - level) / 9;
          if (aabb.minY < y + height) return true;
        }
      }
    }
    return false;
  }

  /** Net flow direction of a fluid at a position, for current push. */
  fluidFlow(x, y, z, fluidId, out) {
    let fx = 0, fz = 0;
    const here = this.fluidHeight(x, y, z, fluidId);
    for (let i = 0; i < 4; i++) {
      const d = FACES[i < 2 ? i : i + 2];
      const nx = x + d.dx, nz = z + d.dz;
      const nh = this.fluidHeight(nx, y, nz, fluidId);
      if (nh < 0) {
        if (!T.solid[this.getBlock(nx, y, nz)]) {
          const below = this.fluidHeight(nx, y - 1, nz, fluidId);
          if (below >= 0) {
            const diff = here - (below - 8 / 9);
            fx += d.dx * diff; fz += d.dz * diff;
          }
        }
        continue;
      }
      const diff = here - nh;
      fx += d.dx * diff; fz += d.dz * diff;
    }
    const len = Math.hypot(fx, fz);
    if (len > 1e-4) { out.x = fx / len; out.z = fz / len; } else { out.x = 0; out.z = 0; }
    out.y = 0;
    return out;
  }

  fluidHeight(x, y, z, fluidId) {
    const st = this.getBlock(x, y, z);
    if (T.fluid[st] !== fluidId) return -1;
    const level = T.fluidLevel[st];
    return level === 0 ? 1 : (8 - level) / 8;
  }

  // --- Raycasting ----------------------------------------------------------

  /**
   * Voxel traversal (Amanatides & Woo) hitting block model shapes.
   * @returns {{x,y,z,face,state,dist,px,py,pz}|null}
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 5, opts = {}) {
    const includeFluids = opts.fluids || false;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-9) return null;
    dx /= len; dy /= len; dz /= len;

    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / dx), tDeltaY = Math.abs(1 / dy), tDeltaZ = Math.abs(1 / dz);
    let tMaxX = intBound(ox, dx), tMaxY = intBound(oy, dy), tMaxZ = intBound(oz, dz);
    let t = 0;
    let face = -1;

    while (t <= maxDist) {
      if (y >= MIN_Y && y <= MAX_Y) {
        const st = this.getBlock(x, y, z);
        if (st !== 0) {
          const def = blockOf(st);
          const isFluid = T.fluid[st] !== 0;
          if (def && (!isFluid || includeFluids)) {
            const shapes = opts.collision
              ? def.collisionFor(st)
              : def.selectionFor(st);
            let bestT = Infinity, bestFace = face;
            for (let i = 0; i < shapes.length; i++) {
              const s = shapes[i];
              const b = RAY_BOX.set(x + s.minX, y + s.minY, z + s.minZ,
                x + s.maxX, y + s.maxY, z + s.maxZ);
              const hit = b.rayIntersect(ox, oy, oz, dx, dy, dz, maxDist);
              if (hit && hit.t < bestT) { bestT = hit.t; bestFace = hit.face; }
            }
            if (bestT < Infinity) {
              return {
                x, y, z, face: bestFace, state: st, dist: bestT,
                px: ox + dx * bestT, py: oy + dy * bestT, pz: oz + dz * bestT,
              };
            }
          }
        }
      }
      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += tDeltaX; face = stepX > 0 ? 0 : 1; }
        else { z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; face = stepZ > 0 ? 4 : 5; }
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; face = stepY > 0 ? 2 : 3;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; face = stepZ > 0 ? 4 : 5;
      }
    }
    return null;
  }

  /** Straight line-of-sight test used by mob AI. */
  canSee(ox, oy, oz, tx, ty, tz) {
    const dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return true;
    const hit = this.raycast(ox, oy, oz, dx, dy, dz, d, { collision: true });
    return !hit;
  }

  // --- Terrain queries -----------------------------------------------------

  /** Highest non-air Y in a column, or MIN_Y-1. */
  heightAt(x, z) {
    const c = this.getChunkAt(x, z);
    return c ? c.height(x & 15, z & 15) : MIN_Y - 1;
  }

  /** Highest solid surface Y in a column. */
  surfaceAt(x, z) {
    const c = this.getChunkAt(x, z);
    return c ? c.surfaceHeight(x & 15, z & 15) : MIN_Y - 1;
  }

  /** Y a mob could stand on above `fromY`, or null. */
  standingYAt(x, z, fromY = MAX_Y) {
    for (let y = Math.min(fromY, MAX_Y); y > MIN_Y; y--) {
      if (T.solid[this.getBlock(x, y, z)] &&
        !T.solid[this.getBlock(x, y + 1, z)] &&
        !T.solid[this.getBlock(x, y + 2, z)]) return y + 1;
    }
    return null;
  }

  getBiomeAt(x, y, z) {
    const c = this.getChunkAt(x, z);
    return c ? c.getBiome(x & 15, y, z & 15) : 0;
  }

  getSurfaceBiomeAt(x, z) {
    const c = this.getChunkAt(x, z);
    return c ? c.getSurfaceBiome(x & 15, z & 15) : 0;
  }

  /** Can precipitation reach this column? (Used for rain, snow, lightning.) */
  isRainingAt(x, y, z) {
    if (!this.raining) return false;
    const c = this.getChunkAt(x, z);
    if (!c) return false;
    if (c.lightHeight(x & 15, z & 15) >= y) return false;
    return true;
  }

  playSound(name, x, y, z, volume = 1, pitch = 1) {
    this.emit('sound', name, x, y, z, { volume, pitch });
  }

  spawnParticles(type, x, y, z, count, opts) {
    this.emit('particle', type, x, y, z, count, opts);
  }

  /** Break a block, optionally dropping items. */
  destroyBlock(x, y, z, drop = true, tool = null) {
    const st = this.getBlock(x, y, z);
    if (st === 0) return false;
    const def = blockOf(st);
    this.emit('particle', 'block_break', x + 0.5, y + 0.5, z + 0.5, 12, { state: st });
    if (def) this.playSound(`break.${def.sound}`, x + 0.5, y + 0.5, z + 0.5);
    if (def?.onBreak) def.onBreak(this, x, y, z, st);
    this.setBlock(x, y, z, 0, FLAG.DEFAULT);
    if (drop && this.game) this.game.dropBlockLoot(this, x, y, z, st, tool);
    return true;
  }

  /** Serialise the parts of world state that belong in a save file. */
  saveMeta() {
    return {
      seed: this.seed, time: this.time, dimension: this.dimension,
      raining: this.raining, thundering: this.thundering,
      rainTime: this.rainTime, thunderTime: this.thunderTime,
      difficulty: this.difficulty, spawnPos: this.spawnPos,
      tickCount: this.tickCount,
    };
  }

  loadMeta(m) {
    if (!m) return;
    this.time = m.time ?? this.time;
    this.raining = !!m.raining;
    this.thundering = !!m.thundering;
    this.rainTime = m.rainTime ?? this.rainTime;
    this.thunderTime = m.thunderTime ?? this.thunderTime;
    this.difficulty = m.difficulty ?? this.difficulty;
    this.spawnPos = m.spawnPos ?? this.spawnPos;
    this.tickCount = m.tickCount ?? 0;
    this.rainLevel = this.raining ? 1 : 0;
    this.thunderLevel = this.thundering ? 1 : 0;
  }
}

// --- helpers ---------------------------------------------------------------

const RAY_BOX = new AABB();

/**
 * Push a pooled AABB onto `out` so repeated collision queries never allocate.
 * The pool hangs off the destination array and is indexed by position, so a
 * `pop()` (box did not actually overlap) simply frees the slot for reuse.
 */
function scratchAABB(out) {
  const pool = out._pool || (out._pool = []);
  const n = out.length;
  const b = pool[n] || (pool[n] = new AABB());
  out.push(b);
  return b;
}

function intBound(s, ds) {
  if (ds === 0) return Infinity;
  if (ds > 0) return (Math.floor(s) + 1 - s) / ds;
  return (s - Math.floor(s)) / -ds;
}
