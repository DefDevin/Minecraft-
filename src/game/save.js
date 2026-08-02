// Persistence: named worlds in IndexedDB.
//
// IndexedDB is the only browser store big enough for a voxel world, but every
// call is asynchronous and a transaction that overlaps a frame will stall it.
// So nothing here ever runs on the render path:
//
//   * reads are prefetched a few seconds ahead of the chunk streamer, driven by
//     an in-memory index of which chunks exist, and land in a buffer cache that
//     `loadChunkSync` can serve from without awaiting anything;
//   * writes are queued as chunk references, then serialised and committed in
//     small time-budgeted batches from an idle callback;
//   * the autosave timer only marks work as pending — it never does it inline.
//
// Four object stores: `worlds` (one record per save, holding seed, timestamps
// and per-dimension metadata), `chunks` (one packed buffer per chunk, keyed by
// world + dimension + coordinates), `players` and `inventories`.

import { serializeChunk, deserializeChunk, SAVE_VERSION } from '../world/serialization.js';
import { chunkKey, CHUNK_STATE } from '../world/chunk.js';
import { ItemStack } from './items.js';

export const DB_NAME = 'minecraft-worlds';
export const DB_VERSION = 1;

const STORE_WORLDS = 'worlds';
const STORE_CHUNKS = 'chunks';
const STORE_PLAYERS = 'players';
const STORE_INVENTORIES = 'inventories';
const ALL_STORES = [STORE_WORLDS, STORE_CHUNKS, STORE_PLAYERS, STORE_INVENTORIES];

/** How long between autosaves, and how much work a single flush may do. */
const DEFAULT_AUTOSAVE_MS = 30000;
const FLUSH_BUDGET_MS = 6;
const FLUSH_MAX_CHUNKS = 24;
const MAX_INFLIGHT_READS = 96;
const READ_BATCH = 64;
const CACHE_LIMIT = 1024;

// ---------------------------------------------------------------------------
// Low-level IndexedDB plumbing
// ---------------------------------------------------------------------------

const idb = () => (typeof indexedDB !== 'undefined' ? indexedDB : null);

/** True when this environment can persist at all (false in Node, or private mode). */
export function storageAvailable() { return !!idb(); }

let dbPromise = null;

function openDatabase() {
  if (dbPromise) return dbPromise;
  const impl = idb();
  if (!impl) return Promise.reject(new Error('IndexedDB is unavailable'));
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = impl.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_WORLDS)) {
        db.createObjectStore(STORE_WORLDS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        const store = db.createObjectStore(STORE_CHUNKS, { keyPath: 'k' });
        store.createIndex('world', 'world', { unique: false });
      }
      for (const name of [STORE_PLAYERS, STORE_INVENTORIES]) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'k' });
          store.createIndex('world', 'world', { unique: false });
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema must not leave this one holding a
      // stale connection that blocks it forever.
      db.onversionchange = () => { try { db.close(); } catch { /* closing */ } dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => { dbPromise = null; reject(new Error('database upgrade blocked')); };
  });
  return dbPromise;
}

function requestDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

async function storeGet(name, key) {
  const db = await openDatabase();
  const tx = db.transaction(name, 'readonly');
  return requestDone(tx.objectStore(name).get(key));
}

async function storePut(name, record) {
  const db = await openDatabase();
  const tx = db.transaction(name, 'readwrite');
  tx.objectStore(name).put(record);
  return transactionDone(tx);
}

async function storeAll(name) {
  const db = await openDatabase();
  const tx = db.transaction(name, 'readonly');
  return requestDone(tx.objectStore(name).getAll());
}

// ---------------------------------------------------------------------------
// World catalogue — the parts a menu needs without opening a save
// ---------------------------------------------------------------------------

/**
 * Every saved world, newest first.
 * @returns {Promise<Array<{id,name,seed,created,lastPlayed,gamemode,version}>>}
 */
export async function listWorlds() {
  if (!storageAvailable()) return [];
  try {
    const rows = await storeAll(STORE_WORLDS);
    return rows
      .map((r) => ({
        id: r.id,
        name: r.name ?? r.id,
        seed: r.seed ?? 0,
        created: r.created ?? 0,
        lastPlayed: r.lastPlayed ?? r.created ?? 0,
        gamemode: r.gamemode ?? 0,
        dimension: r.dimension ?? 'overworld',
        version: r.version ?? 0,
        chunks: r.chunks ?? 0,
      }))
      .sort((a, b) => b.lastPlayed - a.lastPlayed);
  } catch (e) {
    console.warn('[save] could not list worlds:', e.message);
    return [];
  }
}

/** True when at least one world has been saved — for a "Continue" button. */
export async function hasSaves() {
  if (!storageAvailable()) return false;
  const worlds = await listWorlds();
  return worlds.length > 0;
}

/** Remove a world and everything belonging to it. */
export async function deleteWorld(id) {
  if (!storageAvailable() || !id) return false;
  try {
    const db = await openDatabase();
    const tx = db.transaction(ALL_STORES, 'readwrite');
    tx.objectStore(STORE_WORLDS).delete(id);
    for (const name of [STORE_CHUNKS, STORE_PLAYERS, STORE_INVENTORIES]) {
      const index = tx.objectStore(name).index('world');
      const cursorReq = index.openKeyCursor(IDBKeyRange.only(id));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        tx.objectStore(name).delete(cursor.primaryKey);
        cursor.continue();
      };
    }
    await transactionDone(tx);
    return true;
  } catch (e) {
    console.warn('[save] delete failed:', e.message);
    return false;
  }
}

/** How many bytes this origin is using, when the browser will say. */
export async function storageEstimate() {
  try {
    const est = await navigator?.storage?.estimate?.();
    return est ? { usage: est.usage ?? 0, quota: est.quota ?? 0 } : null;
  } catch {
    return null;
  }
}

/** A filesystem-safe, collision-resistant id for a new world name. */
export function worldIdFor(name) {
  const slug = String(name || 'world').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 32) || 'world';
  return `${slug}-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// SaveManager
// ---------------------------------------------------------------------------

export class SaveManager {
  /**
   * @param {object} game the Game, or `{ game, id, name, autosaveMs }`
   * @param {object} [opts]
   */
  constructor(game, opts = {}) {
    if (game && !game.worlds && game.game) { opts = game; game = game.game; }
    this.game = game ?? null;

    this.id = opts.id ?? game?.saveId ?? 'world';
    this.name = opts.name ?? game?.saveName ?? 'New World';
    this.seed = opts.seed ?? game?.world?.seed ?? game?.seed ?? 0;
    this.autosaveMs = opts.autosaveMs ?? DEFAULT_AUTOSAVE_MS;
    this.enabled = opts.enabled ?? storageAvailable();

    this.db = null;
    this.opening = null;
    this.ready = false;
    this.created = 0;

    /** Keys of chunks known to exist on disk — avoids pointless reads. */
    this.index = new Set();
    /** key -> ArrayBuffer, filled by prefetching, drained by loadChunkSync. */
    this.cache = new Map();
    this.inflight = new Set();
    this.readQueue = [];
    this.readTimer = null;
    /** key -> { chunk, dim }, chunks waiting to be written. */
    this.dirty = new Map();
    this.flushHandle = null;
    this.flushIsIdle = false;
    this.flushing = false;

    this.ticks = 0;
    this.lastAutosave = Date.now();
    this.stats = { chunksWritten: 0, chunksRead: 0, restores: 0, lateRestores: 0, errors: 0 };
    this.hooked = false;

    if (this.enabled) this.open().catch(() => { /* reported in open() */ });
  }

  // -- lifecycle ------------------------------------------------------------

  open() {
    if (this.db) return Promise.resolve(this.db);
    if (!this.enabled) return Promise.reject(new Error('saving is disabled'));
    this.opening ??= this.doOpen().catch((e) => {
      this.opening = null;
      this.enabled = false;
      console.warn('[save] disabled:', e.message);
      throw e;
    });
    return this.opening;
  }

  async doOpen() {
    const db = await openDatabase();
    this.db = db;

    let record = await storeGet(STORE_WORLDS, this.id);
    if (!record) {
      record = {
        id: this.id, name: this.name, seed: this.seed | 0,
        created: Date.now(), lastPlayed: Date.now(),
        version: SAVE_VERSION, dimension: this.game?.world?.dimension ?? 'overworld',
        gamemode: this.game?.player?.gamemode ?? 0, dimensions: {}, chunks: 0,
      };
      await storePut(STORE_WORLDS, record);
    }
    this.created = record.created ?? Date.now();
    this.name = record.name ?? this.name;
    if (record.seed != null) this.seed = record.seed;

    // The key index tells `loadChunkSync` whether a chunk is worth waiting for
    // without touching the database on the hot path.
    const tx = db.transaction(STORE_CHUNKS, 'readonly');
    const keys = await requestDone(
      tx.objectStore(STORE_CHUNKS).index('world').getAllKeys(IDBKeyRange.only(this.id)));
    this.index = new Set(keys);

    this.ready = true;
    this.installUnloadHooks();
    return db;
  }

  /** Stop autosaving and release listeners. Pending writes still flush. */
  dispose() {
    this.cancelFlush();
    if (this.readTimer != null) { clearTimeout(this.readTimer); this.readTimer = null; }
    if (this.hooked && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
      window.removeEventListener('pagehide', this.onPageHide);
      this.hooked = false;
    }
    this.enabled = false;
  }

  // -- keys -----------------------------------------------------------------

  chunkId(dimension, cx, cz) { return `${this.id}/${dimension}/${cx},${cz}`; }
  playerId() { return `${this.id}/local`; }

  worldFor(dimension) {
    return this.game?.worlds?.get?.(dimension) ??
      (this.game?.world?.dimension === dimension ? this.game.world : null);
  }

  // -- chunk reads ----------------------------------------------------------

  /**
   * Hand back a saved chunk if its buffer is already in memory. Returns null
   * when the chunk was never saved, or when its read has not landed yet — the
   * caller generates instead, and `restoreLate` patches it up when the read
   * finishes.
   *
   * @returns {import('../world/chunk.js').Chunk|null}
   */
  loadChunkSync(cx, cz, dimension) {
    if (!this.ready) return null;
    const world = dimension ? this.worldFor(dimension) : this.game?.world;
    if (!world) return null;
    const dim = dimension ?? world.dimension;
    const key = this.chunkId(dim, cx, cz);

    const buffer = this.cache.get(key);
    if (!buffer) {
      if (this.index.has(key)) this.prefetch(dim, cx, cz);
      return null;
    }
    this.cache.delete(key);
    try {
      const chunk = deserializeChunk(world, cx, cz, buffer);
      chunk.needsSave = false;
      this.stats.restores++;
      return chunk;
    } catch (e) {
      this.index.delete(key);
      this.stats.errors++;
      console.warn(`[save] could not restore chunk ${key}:`, e.message);
      return null;
    }
  }

  /** Queue a read for a saved chunk. Cheap and idempotent. */
  prefetch(dimension, cx, cz) {
    if (!this.ready) return;
    const key = this.chunkId(dimension, cx, cz);
    if (!this.index.has(key) || this.cache.has(key) || this.inflight.has(key)) return;
    if (this.inflight.size >= MAX_INFLIGHT_READS) return;
    this.inflight.add(key);
    this.readQueue.push({ key, dim: dimension, cx, cz });
    if (this.readTimer == null) this.readTimer = setTimeout(this.runReads, 0);
  }

  /** Read whatever the streamer is about to ask for, a little ahead of time. */
  prefetchAhead(limit = 32) {
    const loader = this.game?.loader;
    const world = this.game?.world;
    if (!loader?.queue || !world || this.index.size === 0) return;
    const dim = world.dimension;
    // Only the head of the queue matters: it is distance-sorted, and this runs
    // several times a second.
    const scan = Math.min(loader.queue.length, 256);
    let queued = 0;
    for (let i = 0; i < scan && queued < limit; i++) {
      const job = loader.queue[i];
      const key = this.chunkId(dim, job.cx, job.cz);
      if (!this.index.has(key) || this.cache.has(key) || this.inflight.has(key)) continue;
      this.prefetch(dim, job.cx, job.cz);
      queued++;
    }
  }

  runReads = async () => {
    this.readTimer = null;
    const jobs = this.readQueue.splice(0, READ_BATCH);
    if (jobs.length === 0) return;
    try {
      const db = await this.open();
      const tx = db.transaction(STORE_CHUNKS, 'readonly');
      const store = tx.objectStore(STORE_CHUNKS);
      // Every request is issued before the first await, so the transaction
      // stays alive for the whole batch.
      const results = await Promise.all(jobs.map((j) => requestDone(store.get(j.key))));
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const record = results[i];
        this.inflight.delete(job.key);
        if (!record?.data) { this.index.delete(job.key); continue; }
        this.cache.set(job.key, record.data);
        this.stats.chunksRead++;
        this.restoreLate(job);
      }
      this.trimCache();
    } catch (e) {
      for (const job of jobs) this.inflight.delete(job.key);
      this.stats.errors++;
      console.warn('[save] chunk read failed:', e.message);
    }
    if (this.readQueue.length && this.readTimer == null) {
      this.readTimer = setTimeout(this.runReads, 0);
    }
  };

  /**
   * A read that arrived after the streamer already generated the chunk. Drop
   * the generated terrain on the floor and put the saved blocks back, then send
   * the chunk around the pipeline again so it re-lights and re-meshes.
   */
  restoreLate({ key, dim, cx, cz }) {
    const world = this.worldFor(dim);
    if (!world) return;
    const existing = world.chunks.get(chunkKey(cx, cz));
    if (!existing || existing.status === CHUNK_STATE.EMPTY) return;  // loadChunkSync will get it
    const buffer = this.cache.get(key);
    if (!buffer) return;
    this.cache.delete(key);
    try {
      existing.dispose(this.game?.renderer);
      deserializeChunk(world, cx, cz, buffer);
      existing.needsSave = false;
      existing.status = CHUNK_STATE.DECORATED;
      this.stats.lateRestores++;
      // Back onto the streamer's queue so it re-lights and re-meshes. The
      // queue tolerates duplicates — a chunk that is already READY is simply
      // shifted off again.
      const loader = this.game?.loader;
      if (loader?.queue) {
        loader.queue.push({ cx, cz, d2: 0 });
        loader.queued?.add(chunkKey(cx, cz));
      }
    } catch (e) {
      this.index.delete(key);
      this.stats.errors++;
      console.warn(`[save] late restore of ${key} failed:`, e.message);
    }
  }

  trimCache() {
    if (this.cache.size <= CACHE_LIMIT) return;
    // Map iterates in insertion order, so the oldest buffers go first.
    const drop = this.cache.size - CACHE_LIMIT;
    let n = 0;
    for (const key of this.cache.keys()) {
      this.cache.delete(key);
      if (++n >= drop) break;
    }
  }

  // -- chunk writes ---------------------------------------------------------

  /**
   * Mark a chunk for persistence. Only the reference is taken here; the packing
   * happens later, off the render path. Safe to call immediately before
   * unloading the chunk — the object stays alive until it has been written.
   */
  saveChunk(chunk, dimension) {
    if (!this.enabled || !chunk) return;
    const dim = dimension ?? chunk.world?.dimension ?? this.game?.world?.dimension ?? 'overworld';
    this.dirty.set(this.chunkId(dim, chunk.cx, chunk.cz), { chunk, dim });
    chunk.needsSave = false;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushHandle != null || this.flushing || this.dirty.size === 0) return;
    const run = () => { this.flushHandle = null; this.flush().catch(() => {}); };
    if (typeof requestIdleCallback === 'function') {
      this.flushIsIdle = true;
      this.flushHandle = requestIdleCallback(run, { timeout: 2000 });
    } else {
      this.flushIsIdle = false;
      this.flushHandle = setTimeout(run, 250);
    }
  }

  cancelFlush() {
    if (this.flushHandle == null) return;
    if (this.flushIsIdle && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(this.flushHandle);
    } else if (!this.flushIsIdle) {
      clearTimeout(this.flushHandle);
    }
    this.flushHandle = null;
  }

  /**
   * Pack and commit pending chunks. Bounded by both a count and a time budget
   * so a big autosave spreads over several idle slices instead of one long one.
   */
  async flush({ limit = FLUSH_MAX_CHUNKS, budgetMs = FLUSH_BUDGET_MS, all = false } = {}) {
    if (this.flushing || this.dirty.size === 0 || !this.enabled) return 0;
    this.flushing = true;
    let written = 0;
    try {
      const db = await this.open();
      const records = [];
      const started = now();
      for (const [key, entry] of this.dirty) {
        this.dirty.delete(key);
        try {
          records.push({
            k: key, world: this.id, dim: entry.dim,
            cx: entry.chunk.cx, cz: entry.chunk.cz,
            data: serializeChunk(entry.chunk), saved: Date.now(),
          });
        } catch (e) {
          this.stats.errors++;
          console.warn(`[save] could not pack chunk ${key}:`, e.message);
        }
        if (!all && (records.length >= limit || now() - started > budgetMs)) break;
      }
      if (records.length) {
        const tx = db.transaction(STORE_CHUNKS, 'readwrite');
        const store = tx.objectStore(STORE_CHUNKS);
        for (const record of records) {
          store.put(record);
          this.index.add(record.k);
        }
        await transactionDone(tx);
        written = records.length;
        this.stats.chunksWritten += written;
      }
    } catch (e) {
      this.stats.errors++;
      console.warn('[save] flush failed:', e.message);
    } finally {
      this.flushing = false;
      if (this.dirty.size) this.scheduleFlush();
    }
    return written;
  }

  // -- world / player / inventory -------------------------------------------

  async saveWorldMeta() {
    if (!this.enabled) return;
    const game = this.game;
    const dimensions = {};
    if (game?.worlds) {
      for (const [name, world] of game.worlds) dimensions[name] = world.saveMeta?.() ?? null;
    } else if (game?.world) {
      dimensions[game.world.dimension] = game.world.saveMeta?.() ?? null;
    }
    try {
      await storePut(STORE_WORLDS, {
        id: this.id,
        name: this.name,
        seed: (game?.world?.seed ?? this.seed) | 0,
        created: this.created || Date.now(),
        lastPlayed: Date.now(),
        version: SAVE_VERSION,
        dimension: game?.world?.dimension ?? 'overworld',
        gamemode: game?.player?.gamemode ?? 0,
        settings: game?.settings ? { ...game.settings } : null,
        chunks: this.index.size,
        dimensions,
      });
    } catch (e) {
      this.stats.errors++;
      console.warn('[save] world metadata failed:', e.message);
    }
  }

  async loadWorldMeta() {
    if (!this.enabled) return null;
    try {
      const record = await storeGet(STORE_WORLDS, this.id);
      if (!record) return null;
      this.created = record.created ?? this.created;
      this.name = record.name ?? this.name;
      this.seed = record.seed ?? this.seed;
      const game = this.game;
      if (game?.worlds && record.dimensions) {
        for (const [name, meta] of Object.entries(record.dimensions)) {
          game.worlds.get(name)?.loadMeta?.(meta);
        }
      } else if (game?.world && record.dimensions) {
        game.world.loadMeta?.(record.dimensions[game.world.dimension]);
      }
      return record;
    } catch (e) {
      console.warn('[save] world metadata unreadable:', e.message);
      return null;
    }
  }

  async savePlayer(player = this.game?.player) {
    if (!this.enabled || !player?.save) return;
    try {
      const data = player.save();
      data.dimension = player.world?.dimension ?? 'overworld';
      await storePut(STORE_PLAYERS, { k: this.playerId(), world: this.id, data });
    } catch (e) {
      this.stats.errors++;
      console.warn('[save] player save failed:', e.message);
    }
  }

  async loadPlayer(player = this.game?.player) {
    if (!this.enabled || !player?.load) return false;
    try {
      const record = await storeGet(STORE_PLAYERS, this.playerId());
      if (!record?.data) return false;
      player.load(record.data);
      return true;
    } catch (e) {
      console.warn('[save] player load failed:', e.message);
      return false;
    }
  }

  async saveInventory(inventory = this.game?.player?.inventory) {
    if (!this.enabled || !inventory) return;
    try {
      const data = serializeInventory(inventory);
      if (!data) return;
      await storePut(STORE_INVENTORIES, { k: this.playerId(), world: this.id, data });
    } catch (e) {
      this.stats.errors++;
      console.warn('[save] inventory save failed:', e.message);
    }
  }

  async loadInventory(inventory = this.game?.player?.inventory) {
    if (!this.enabled || !inventory) return false;
    try {
      const record = await storeGet(STORE_INVENTORIES, this.playerId());
      if (!record?.data) return false;
      return restoreInventory(inventory, record.data);
    } catch (e) {
      console.warn('[save] inventory load failed:', e.message);
      return false;
    }
  }

  // -- autosave -------------------------------------------------------------

  /** Called once per game tick. Does bookkeeping only — never I/O inline. */
  tick() {
    if (!this.enabled) return;
    this.ticks++;
    if (this.ready && (this.ticks & 3) === 0) this.prefetchAhead();
    if (this.autosaveMs > 0 && Date.now() - this.lastAutosave >= this.autosaveMs) {
      this.lastAutosave = Date.now();
      this.autosave();
    }
  }

  /** Mark everything that changed. The flush loop does the actual work. */
  autosave() {
    if (!this.enabled) return;
    this.markDirtyChunks();
    this.saveWorldMeta().catch(() => {});
    this.savePlayer().catch(() => {});
    this.saveInventory().catch(() => {});
  }

  markDirtyChunks(force = false) {
    const game = this.game;
    if (!game) return 0;
    const worlds = game.worlds?.size ? [...game.worlds.values()]
      : (game.world ? [game.world] : []);
    let marked = 0;
    for (const world of worlds) {
      for (const chunk of world.chunks.values()) {
        if (!force && !chunk.needsSave) continue;
        if (chunk.status < CHUNK_STATE.TERRAIN) continue;
        this.saveChunk(chunk, world.dimension);
        marked++;
      }
    }
    return marked;
  }

  // -- whole-game save / load ----------------------------------------------

  /** Persist everything and wait for it to land. */
  async save() {
    if (!this.enabled) return false;
    this.markDirtyChunks();
    await Promise.all([
      this.saveWorldMeta(),
      this.savePlayer(),
      this.saveInventory(),
    ]);
    while (this.dirty.size > 0) {
      const written = await this.flush({ all: true });
      if (written === 0) break;
    }
    this.lastAutosave = Date.now();
    return true;
  }

  /**
   * Restore world metadata, the player and their inventory, and warm the chunk
   * cache around wherever the player came back to. Chunk blocks themselves
   * stream in through `loadChunkSync`.
   */
  async load() {
    if (!this.enabled) return false;
    try { await this.open(); } catch { return false; }
    const meta = await this.loadWorldMeta();
    const player = await this.loadPlayer();
    await this.loadInventory();
    if (player && this.game?.player) {
      const p = this.game.player;
      this.game.world?.updateEntityChunk?.(p);
      this.prefetchAround(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4);
    }
    return !!(meta || player);
  }

  /** Warm the cache for a square of chunks, nearest first. */
  prefetchAround(cx, cz, radius = 6, dimension) {
    const dim = dimension ?? this.game?.world?.dimension ?? 'overworld';
    const jobs = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) jobs.push([dx, dz, dx * dx + dz * dz]);
    }
    jobs.sort((a, b) => a[2] - b[2]);
    for (const [dx, dz] of jobs) this.prefetch(dim, cx + dx, cz + dz);
  }

  // -- shutdown -------------------------------------------------------------

  installUnloadHooks() {
    if (this.hooked || typeof document === 'undefined' || typeof window === 'undefined') return;
    // `beforeunload` is unreliable on mobile and is skipped entirely when a tab
    // is discarded, so the pair below is what actually fires.
    this.onVisibility = () => {
      if (document.visibilityState === 'hidden') this.flushOnExit();
    };
    this.onPageHide = () => this.flushOnExit();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    this.hooked = true;
  }

  /**
   * Last chance to persist. Everything is queued into one transaction straight
   * away: the page may never get another task, but a transaction that has
   * already been opened normally completes.
   */
  flushOnExit() {
    if (!this.enabled || !this.db) return;
    this.markDirtyChunks();
    this.cancelFlush();
    this.savePlayer().catch(() => {});
    this.saveInventory().catch(() => {});
    this.saveWorldMeta().catch(() => {});
    if (this.dirty.size === 0 || this.flushing) return;
    try {
      const tx = this.db.transaction(STORE_CHUNKS, 'readwrite');
      const store = tx.objectStore(STORE_CHUNKS);
      for (const [key, entry] of this.dirty) {
        try {
          store.put({
            k: key, world: this.id, dim: entry.dim,
            cx: entry.chunk.cx, cz: entry.chunk.cz,
            data: serializeChunk(entry.chunk), saved: Date.now(),
          });
          this.index.add(key);
        } catch { /* one bad chunk must not lose the rest */ }
      }
      this.dirty.clear();
    } catch (e) {
      console.warn('[save] exit flush failed:', e.message);
    }
  }

  // -- catalogue passthroughs ----------------------------------------------

  listWorlds() { return listWorlds(); }

  async deleteWorld(id = this.id) {
    const ok = await deleteWorld(id);
    if (ok && id === this.id) {
      this.index.clear();
      this.cache.clear();
      this.dirty.clear();
    }
    return ok;
  }
}

// ---------------------------------------------------------------------------
// Inventory serialisation
//
// PlayerInventory carries its own save()/load(); anything simpler (the
// fallback inventory in game.js, a plain container) is handled field by field
// so the save system does not depend on the inventory module being present.
// ---------------------------------------------------------------------------

const stackToJSON = (s) => (s && !s.empty ? s.toJSON() : null);

function stackFromJSON(o) {
  if (!o) return null;
  try { return ItemStack.fromJSON(o); } catch { return null; }
}

export function serializeInventory(inventory) {
  if (!inventory) return null;
  if (typeof inventory.save === 'function') {
    return { format: 'inventory', data: inventory.save() };
  }
  return {
    format: 'slots',
    slots: (inventory.slots ?? []).map(stackToJSON),
    armor: (inventory.armorSlots ?? inventory.armor?.slots ?? []).map(stackToJSON),
    offhand: stackToJSON(inventory.offhand),
    ender: (inventory.enderChest?.slots ?? []).map(stackToJSON),
    selected: inventory.selected ?? 0,
  };
}

export function restoreInventory(inventory, data) {
  if (!inventory || !data) return false;
  if (data.format === 'inventory' && typeof inventory.load === 'function') {
    inventory.load(data.data);
    return true;
  }
  if (typeof inventory.load === 'function' && data.format !== 'slots') {
    inventory.load(data.data ?? data);
    return true;
  }
  const put = (target, list) => {
    if (!target || !list) return;
    for (let i = 0; i < Math.min(target.length, list.length); i++) {
      target[i] = stackFromJSON(list[i]);
    }
  };
  put(inventory.slots, data.slots);
  put(inventory.armorSlots ?? inventory.armor?.slots, data.armor);
  if (inventory.enderChest?.slots) put(inventory.enderChest.slots, data.ender);
  inventory.offhand = stackFromJSON(data.offhand);
  if (typeof data.selected === 'number') {
    if (typeof inventory.setSelectedSlot === 'function') inventory.setSelectedSlot(data.selected);
    else inventory.selected = data.selected;
  }
  inventory.changed?.();
  return true;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export default SaveManager;
