// Redstone: signal propagation, components, and the tick-ordered update queue.
//
// The block registry knows what a repeater *is*; this module knows what the
// whole circuit is doing. Every block that needs a global view of power calls
// in through `world.game.redstone.…` (see game/hooks.js), and everything here
// works purely through the public World API — getBlock/setBlock, scheduleTick,
// notifyNeighbors — so it can be loaded, dropped or unit-tested on its own.
//
// Two conventions run through the file and are worth reading before the code:
//
//   * A **face** is an index into `FACES` (0 -X, 1 +X, 2 -Y, 3 +Y, 4 -Z, 5 +Z).
//     When a function takes a `toFace` it means "the direction pointing from the
//     block emitting power toward the block receiving it". Minecraft's own
//     sources use the opposite convention, which is a reliable source of sign
//     errors, so everything here is stated in the emitting direction.
//
//   * **Weak** power lights lamps, opens doors and drives pistons but does not
//     re-enter redstone dust. **Strong** power is what a conductive block
//     re-emits to everything around it. Repeaters, comparators, torches, levers,
//     buttons and plates strongly power exactly one block each; dust strongly
//     powers nothing.
//
// Propagation is queued rather than recursive. `update()` and the various
// `updateX()` hooks only ever mark work; `tickRedstone(world)`, called once per
// game tick from the main loop, drains the queue. Dust settles within a single
// drain (as in the real game); torches, repeaters, comparators and observers
// re-enter the queue through `world.scheduleTick`, so a pulse takes real ticks
// to travel down a chain of components.

import { T, blockOf, getProp, withProp, blocksByName } from './blocks.js';
import { FLAG } from './world.js';
import { FACES, HORIZONTAL, AABB } from '../core/math.js';
import { extendPiston, retractPiston, tickPistons, isMoving } from './pistons.js';

/** Highest redstone signal level. */
export const MAX_POWER = 15;

/** How many dust blocks one solve will walk before giving up. */
const MAX_NETWORK = 4096;
/** Safety valves for the drain loop. */
const MAX_ROUNDS = 32;
const MAX_UPDATES = 8192;

// FACES indices, named.
const F_WEST = 0, F_EAST = 1, F_DOWN = 2, F_UP = 3, F_NORTH = 4, F_SOUTH = 5;

/** Horizontal facing index (N,E,S,W) -> FACES index. */
const HORIZ_FACE = [F_NORTH, F_EAST, F_SOUTH, F_WEST];
/** FACES index -> horizontal facing index, or -1 for up/down. */
const FACE_HORIZ = [3, 1, -1, -1, 0, 2];
/** Property value of `facing` / `facingAll` -> FACES index. */
const FACING_FACE = {
  north: F_NORTH, east: F_EAST, south: F_SOUTH, west: F_WEST,
  up: F_UP, down: F_DOWN,
};
const HORIZ_INDEX = { north: 0, east: 1, south: 2, west: 3 };
const DIR_NAMES = ['north', 'east', 'south', 'west'];

const opposite = (face) => FACES[face].opposite;
const key3 = (x, y, z) => `${x},${y},${z}`;

// ---------------------------------------------------------------------------
// Per-world state
// ---------------------------------------------------------------------------

const WORLD_STATE = new WeakMap();

/** Mutable redstone bookkeeping for one world. */
export function redstoneState(world) {
  let s = WORLD_STATE.get(world);
  if (!s) {
    s = {
      queue: [],            // [{x,y,z,at,priority,seq,key}]
      queued: new Map(),    // key -> earliest queued tick
      actions: [],          // [{at, fn}] — deferred work (piston moves, dispensers)
      toggles: new Map(),   // torch position -> recent toggle tick list
      burnout: new Map(),   // torch position -> tick it may relight
      observed: new Map(),  // observer position -> last seen state of its target
      plates: new Map(),    // weighted plate position -> emitted level
      seq: 0,
      draining: false,
      stats: { updates: 0, wireSolves: 0 },
    };
    WORLD_STATE.set(world, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Power queries
// ---------------------------------------------------------------------------

/**
 * Power the block at (x,y,z) emits toward its neighbour in direction `toFace`.
 *
 * @param {boolean} strong  ask for strong (block-carried) power instead of weak
 * @param {boolean} noWire  treat dust as unpowered — used while solving a dust
 *                          network so wires do not feed their own inputs
 */
function emitted(world, x, y, z, state, toFace, strong, noWire) {
  const def = blockOf(state);
  if (!def) return 0;
  const r = def.redstone;
  if (!r || !r.source) return 0;

  // --- redstone dust ---
  if (def.isWire) {
    if (strong || noWire) return 0;
    const power = getProp(state, 'power') | 0;
    if (power === 0) return 0;
    if (toFace === F_DOWN) return power;      // the block beneath is powered
    if (toFace === F_UP) return 0;            // the one above never is
    const dir = FACE_HORIZ[toFace];
    if (dir < 0) return 0;
    // A dust with no connections at all renders (and behaves) as a cross and
    // powers all four sides; otherwise only the sides it actually points into.
    let any = 0;
    for (let i = 0; i < 4; i++) if (wireConnection(world, x, y, z, i)) any++;
    if (any === 0) return power;
    return wireConnection(world, x, y, z, dir) ? power : 0;
  }

  // --- redstone torches ---
  if (def.isTorch) {
    if (!getProp(state, 'lit')) return 0;
    if (strong) return toFace === F_UP ? MAX_POWER : 0;
    if (def.stateDef.has('facing')) {
      // A wall torch never powers the block it hangs from.
      const wall = opposite(FACING_FACE[getProp(state, 'facing')]);
      return toFace === wall ? 0 : MAX_POWER;
    }
    return toFace === F_DOWN ? 0 : MAX_POWER;  // …nor a standing torch its floor
  }

  // --- repeaters and comparators ---
  if (def.isDiode) {
    if (!getProp(state, 'powered')) return 0;
    // `facing` names the input side, so the output leaves through its opposite.
    if (toFace !== opposite(FACING_FACE[getProp(state, 'facing')])) return 0;
    if (def.name === 'comparator') {
      const be = world.getBlockEntity(x, y, z);
      const out = be && be.output != null ? be.output : MAX_POWER;
      return Math.max(0, Math.min(MAX_POWER, out));
    }
    return MAX_POWER;
  }

  // --- observers ---
  if (def.name === 'observer') {
    if (!getProp(state, 'powered')) return 0;
    return toFace === opposite(FACING_FACE[getProp(state, 'facing')]) ? MAX_POWER : 0;
  }

  // --- levers and buttons: strong into whatever they are stuck to ---
  if (def.isButton || def.name === 'lever') {
    if (!getProp(state, 'powered')) return 0;
    if (!strong) return MAX_POWER;
    return toFace === attachFace(state) ? MAX_POWER : 0;
  }

  // --- pressure plates: strong into the block below ---
  if (def.isPressurePlate) {
    if (!getProp(state, 'powered')) return 0;
    const level = redstoneState(world).plates.get(key3(x, y, z)) ?? MAX_POWER;
    if (!strong) return level;
    return toFace === F_DOWN ? level : 0;
  }

  // --- tripwire hook: strong into its wall ---
  if (def.name === 'tripwire_hook') {
    if (!getProp(state, 'powered')) return 0;
    if (!strong) return MAX_POWER;
    const support = HORIZ_FACE[(HORIZ_INDEX[getProp(state, 'facing')] + 2) & 3];
    return toFace === support ? MAX_POWER : 0;
  }

  // --- detector rail: strong into the block below ---
  if (def.isRail) {
    if (!def.stateDef.has('powered') || !getProp(state, 'powered')) return 0;
    if (def.name !== 'detector_rail') return 0;
    if (!strong) return MAX_POWER;
    return toFace === F_DOWN ? MAX_POWER : 0;
  }

  // --- trapped chest: scales with the number of players looking inside ---
  if (def.name === 'trapped_chest') {
    const be = world.getBlockEntity(x, y, z);
    const viewers = Math.min(MAX_POWER, (be && be.viewers) | 0);
    if (viewers === 0) return 0;
    if (!strong) return viewers;
    return toFace === F_DOWN ? viewers : 0;
  }

  // --- everything else is described by its state or its registry entry ---
  if (strong) return 0;
  if (def.stateDef.has('power')) return getProp(state, 'power') | 0;
  if (def.stateDef.has('powered')) {
    return getProp(state, 'powered') ? (r.power ?? MAX_POWER) : 0;
  }
  return r.power ?? 0;
}

/** FACES index pointing from a wall/floor/ceiling device toward its support. */
function attachFace(state) {
  const face = getProp(state, 'face');
  if (face === 'floor') return F_DOWN;
  if (face === 'ceiling') return F_UP;
  return HORIZ_FACE[(HORIZ_INDEX[getProp(state, 'facing')] + 2) & 3];
}

/** Strongest strong-power arriving at (x,y,z) from any of its six neighbours. */
function strongInto(world, x, y, z, noWire) {
  let best = 0;
  for (let f = 0; f < 6; f++) {
    const d = FACES[f];
    const nx = x + d.dx, ny = y + d.dy, nz = z + d.dz;
    const ns = world.getBlock(nx, ny, nz);
    if (ns === 0) continue;
    const p = emitted(world, nx, ny, nz, ns, d.opposite, true, noWire);
    if (p > best) { best = p; if (best >= MAX_POWER) return MAX_POWER; }
  }
  return best;
}

/**
 * Signal the block at (x,y,z) presents to a neighbour lying in direction
 * `toFace` — its own weak output, or, if it is a conductive block, whatever
 * strong power is being pushed into it.
 */
function signalFrom(world, x, y, z, toFace, noWire) {
  const state = world.getBlock(x, y, z);
  if (state === 0) return 0;
  let p = emitted(world, x, y, z, state, toFace, false, noWire);
  if (p < MAX_POWER && T.conductive[state] === 1) {
    p = Math.max(p, strongInto(world, x, y, z, noWire));
  }
  return p;
}

/** Strongest signal any of the six neighbours of (x,y,z) delivers to it. */
export function neighborSignal(world, x, y, z, noWire = false) {
  let best = 0;
  for (let f = 0; f < 6; f++) {
    const d = FACES[f];
    const p = signalFrom(world, x + d.dx, y + d.dy, z + d.dz, d.opposite, noWire);
    if (p > best) { best = p; if (best >= MAX_POWER) return MAX_POWER; }
  }
  return best;
}

/** Signal level at a position — what lamps, doors and TNT ask for. */
export function signalAt(world, x, y, z) {
  return neighborSignal(world, x, y, z, false);
}

/** Is this block being powered at all? (The registry's `hasSignal` hook.) */
export function hasSignal(world, x, y, z) {
  return neighborSignal(world, x, y, z, false) > 0;
}

/** Power arriving from one specific side, ignoring the rest. */
export function signalFromSide(world, x, y, z, face) {
  const d = FACES[face];
  return signalFrom(world, x + d.dx, y + d.dy, z + d.dz, d.opposite, false);
}

// ---------------------------------------------------------------------------
// Redstone dust
// ---------------------------------------------------------------------------

/**
 * How the dust at (x,y,z) meets its horizontal neighbour `dir`:
 * 0 none, 1 side, 2 up (climbing the side of a solid block).
 *
 * This mirrors the state machine in blockdefs/redstone.js deliberately rather
 * than reading the block's connection properties, so the solver stays correct
 * even when a neighbour has changed but its shape update has not run yet.
 */
export function wireConnection(world, x, y, z, dir) {
  const d = HORIZONTAL[dir];
  const nx = x + d.dx, nz = z + d.dz;
  const ns = world.getBlock(nx, y, nz);
  const nd = blockOf(ns);
  if (nd && (nd.isWire || (nd.redstone && (nd.redstone.component || nd.redstone.source)))) {
    return 1;
  }
  if (T.conductive[ns] === 1) {
    // Dust climbs the side of a block only when nothing caps it from above.
    if (T.solid[world.getBlock(x, y + 1, z)] !== 1) {
      const up = blockOf(world.getBlock(nx, y + 1, nz));
      if (up && up.isWire) return 2;
    }
    return 0;
  }
  const down = blockOf(world.getBlock(nx, y - 1, nz));
  return (down && down.isWire) ? 1 : 0;
}

/** Positions of the dust blocks this dust is electrically joined to. */
function wireNeighbors(world, x, y, z, out) {
  out.length = 0;
  for (let dir = 0; dir < 4; dir++) {
    const c = wireConnection(world, x, y, z, dir);
    if (c === 0) continue;
    const d = HORIZONTAL[dir];
    const nx = x + d.dx, nz = z + d.dz;
    if (c === 2) {
      if (blockOf(world.getBlock(nx, y + 1, nz))?.isWire) out.push(nx, y + 1, nz);
      continue;
    }
    if (blockOf(world.getBlock(nx, y, nz))?.isWire) { out.push(nx, y, nz); continue; }
    if (blockOf(world.getBlock(nx, y - 1, nz))?.isWire) out.push(nx, y - 1, nz);
  }
  return out;
}

/**
 * Recompute every dust block electrically connected to (x,y,z).
 *
 * Each node takes the strongest signal from the non-dust blocks around it, then
 * the network relaxes outward one level per step — which is exactly the 15..1
 * gradient a line of dust shows in the real game. Solving the whole component
 * at once (instead of recursing per block) keeps a long line from re-entering
 * the update machinery hundreds of times.
 */
export function solveWireNetwork(world, x0, y0, z0) {
  const first = world.getBlock(x0, y0, z0);
  if (!blockOf(first)?.isWire) return 0;

  const S = redstoneState(world);
  S.stats.wireSolves++;

  const nodes = [];
  const index = new Map();
  const stack = [x0, y0, z0];
  const scratch = [];

  while (stack.length && nodes.length < MAX_NETWORK) {
    const z = stack.pop(), y = stack.pop(), x = stack.pop();
    const k = key3(x, y, z);
    if (index.has(k)) continue;
    const st = world.getBlock(x, y, z);
    if (!blockOf(st)?.isWire) continue;
    const node = { x, y, z, state: st, power: 0, links: null };
    index.set(k, node);
    nodes.push(node);
    wireNeighbors(world, x, y, z, scratch);
    for (let i = 0; i < scratch.length; i++) stack.push(scratch[i]);
  }
  if (nodes.length === 0) return 0;

  // Resolve links once, now that every node exists.
  for (const n of nodes) {
    wireNeighbors(world, n.x, n.y, n.z, scratch);
    const links = [];
    for (let i = 0; i < scratch.length; i += 3) {
      const m = index.get(key3(scratch[i], scratch[i + 1], scratch[i + 2]));
      if (m && m !== n) links.push(m);
    }
    n.links = links;
  }

  // Seed from external sources, then relax by one level per hop.
  const buckets = [];
  for (let i = 0; i <= MAX_POWER; i++) buckets.push([]);
  for (const n of nodes) {
    n.power = neighborSignal(world, n.x, n.y, n.z, true);
    if (n.power > 0) buckets[n.power].push(n);
  }
  for (let p = MAX_POWER; p >= 2; p--) {
    const bucket = buckets[p];
    for (let i = 0; i < bucket.length; i++) {
      const n = bucket[i];
      if (n.power !== p) continue;
      for (const m of n.links) {
        if (m.power < p - 1) { m.power = p - 1; buckets[p - 1].push(m); }
      }
    }
  }

  // Write the whole network first, notify afterwards: a half-updated network
  // would otherwise feed stale levels back into the blocks still to be written.
  const changed = [];
  for (const n of nodes) {
    if ((getProp(n.state, 'power') | 0) === n.power) continue;
    world.setBlock(n.x, n.y, n.z, withProp(n.state, 'power', n.power),
      FLAG.UPDATE_LIGHT | FLAG.MARK_DIRTY);
    changed.push(n);
  }
  for (const n of changed) notifyAround(world, n.x, n.y, n.z);
  return changed.length;
}

// ---------------------------------------------------------------------------
// The update queue
// ---------------------------------------------------------------------------

/** Mark a position as having changed the power around it. */
export function update(world, x, y, z) {
  enqueue(world, x, y, z, 0, 0);
}

function enqueue(world, x, y, z, delay = 0, priority = 0) {
  const S = redstoneState(world);
  const k = key3(x, y, z);
  const at = world.tickCount + delay;
  const prev = S.queued.get(k);
  if (prev !== undefined && prev <= at) return;
  S.queued.set(k, at);
  S.queue.push({ x, y, z, at, priority, seq: S.seq++, key: k });
}

/** Run `fn` once, `delay` ticks from now, from inside the redstone tick. */
function defer(world, delay, fn) {
  const S = redstoneState(world);
  S.actions.push({ at: world.tickCount + delay, fn });
}

function runActions(world, S) {
  if (S.actions.length === 0) return;
  const due = [], keep = [];
  for (const a of S.actions) (a.at <= world.tickCount ? due : keep).push(a);
  S.actions = keep;
  for (const a of due) {
    try { a.fn(); } catch (e) { console.error('redstone action failed', e); }
  }
}

/**
 * Drain the redstone queue. Called once per game tick by the main loop.
 * @returns the number of positions processed, for the debug overlay.
 */
export function tickRedstone(world) {
  const S = redstoneState(world);
  S.draining = true;
  let processed = 0;
  try {
    runActions(world, S);
    for (let round = 0; round < MAX_ROUNDS && processed < MAX_UPDATES; round++) {
      if (S.queue.length === 0) break;
      const due = [], keep = [];
      for (const e of S.queue) (e.at <= world.tickCount ? due : keep).push(e);
      S.queue = keep;
      if (due.length === 0) break;
      due.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      for (const e of due) {
        if (S.queued.get(e.key) === e.at) S.queued.delete(e.key);
        processed++;
        applyUpdate(world, e.x, e.y, e.z);
      }
    }
    runActions(world, S);
    tickPistons(world);
  } finally {
    S.draining = false;
  }
  S.stats.updates += processed;
  return processed;
}

/** Re-evaluate one position and tell its neighbours the power there moved. */
function applyUpdate(world, x, y, z) {
  const state = world.getBlock(x, y, z);
  const def = blockOf(state);
  if (def) {
    if (def.isWire) { solveWireNetwork(world, x, y, z); return; }
    if (def.isPressurePlate) refreshPressurePlate(world, x, y, z, state);
  }
  notifyAround(world, x, y, z);
}

/**
 * Tell the six blocks around (x,y,z) that something changed here.
 *
 * `world.notifyNeighbors` drives every registry-level reaction (lamps, doors,
 * torches, diodes, pistons, hoppers, TNT); `componentUpdate` covers the handful
 * of blocks whose definition has no neighbour hook of its own.
 */
function notifyAround(world, x, y, z) {
  const st = world.getBlock(x, y, z);
  world.notifyNeighbors(x, y, z, st, st);
  for (let f = 0; f < 6; f++) {
    const d = FACES[f];
    componentUpdate(world, x + d.dx, y + d.dy, z + d.dz);
  }
}

/** Notify a block *and* everything around it — how strong power spreads. */
function notifyDeep(world, x, y, z) {
  notifyAround(world, x, y, z);
  for (let f = 0; f < 6; f++) {
    const d = FACES[f];
    notifyAround(world, x + d.dx, y + d.dy, z + d.dz);
  }
}

/** Reactions the block definitions do not implement themselves. */
function componentUpdate(world, x, y, z) {
  const state = world.getBlock(x, y, z);
  if (state === 0) return;
  const def = blockOf(state);
  if (!def) return;
  if (def.isWire) { enqueue(world, x, y, z, 0, 1); return; }
  if (def.name === 'note_block') { updateNoteBlock(world, x, y, z, state); return; }
  if (def.isRail && def.stateDef.has('powered') && def.name !== 'detector_rail') {
    updateRail(world, x, y, z, state);
  }
}

// ---------------------------------------------------------------------------
// Torches
// ---------------------------------------------------------------------------

/** Signal arriving at a torch from the block it is mounted on. */
function torchSupportPowered(world, x, y, z, state) {
  const def = blockOf(state);
  const face = def.stateDef.has('facing')
    ? opposite(FACING_FACE[getProp(state, 'facing')])   // wall torch: behind it
    : F_DOWN;                                           // standing torch: below
  const d = FACES[face];
  return signalFrom(world, x + d.dx, y + d.dy, z + d.dz, d.opposite, false) > 0;
}

export function updateTorch(world, x, y, z, state) {
  const lit = getProp(state, 'lit');
  // Schedule only when the torch disagrees with what it should be: lit while
  // its support is powered, or dark while it is not.
  if (lit === torchSupportPowered(world, x, y, z, state)) {
    world.scheduleTick(x, y, z, blockOf(state), 2);
  }
}

export function tickTorch(world, x, y, z, state) {
  const S = redstoneState(world);
  const k = key3(x, y, z);
  const powered = torchSupportPowered(world, x, y, z, state);
  const lit = getProp(state, 'lit');
  if (lit === !powered) return;   // already correct

  if (lit) {
    setTorch(world, x, y, z, state, false);
    if (recordToggle(world, S, k)) {
      // Burned out: it stays dark for a while and puffs smoke, as in vanilla.
      S.burnout.set(k, world.tickCount + 60);
      world.spawnParticles('smoke', x + 0.5, y + 0.6, z + 0.5, 5);
      world.playSound('fizz', x + 0.5, y + 0.5, z + 0.5, 0.5, 2.6);
    }
    return;
  }
  const until = S.burnout.get(k) ?? 0;
  if (world.tickCount < until) {
    world.scheduleTick(x, y, z, blockOf(state), 20);
    return;
  }
  S.burnout.delete(k);
  recordToggle(world, S, k);
  setTorch(world, x, y, z, state, true);
}

function setTorch(world, x, y, z, state, lit) {
  world.setBlock(x, y, z, withProp(state, 'lit', lit),
    FLAG.UPDATE_LIGHT | FLAG.MARK_DIRTY);
  // A torch strongly powers the block above it, so that block's own neighbours
  // have to be told as well.
  notifyDeep(world, x, y, z);
  enqueue(world, x, y, z, 0, 0);
}

/** Remember a toggle; returns true once the torch has flickered too often. */
function recordToggle(world, S, k) {
  let list = S.toggles.get(k);
  if (!list) { list = []; S.toggles.set(k, list); }
  while (list.length && world.tickCount - list[0] > 60) list.shift();
  list.push(world.tickCount);
  return list.length > 8;
}

// ---------------------------------------------------------------------------
// Repeaters
// ---------------------------------------------------------------------------

/** Power entering a diode through its back face. */
function diodeInput(world, x, y, z, state) {
  const face = FACING_FACE[getProp(state, 'facing')];
  const d = FACES[face];
  return signalFrom(world, x + d.dx, y + d.dy, z + d.dz, d.opposite, false);
}

/**
 * A repeater or comparator pointing into this one's side locks it, freezing
 * whatever it was outputting. Only diodes can lock; dust and torches cannot.
 */
function diodeSideInput(world, x, y, z, state) {
  const dir = HORIZ_INDEX[getProp(state, 'facing')];
  let best = 0;
  for (const side of [(dir + 1) & 3, (dir + 3) & 3]) {
    const d = HORIZONTAL[side];
    const nx = x + d.dx, nz = z + d.dz;
    const ns = world.getBlock(nx, y, nz);
    const nd = blockOf(ns);
    if (!nd || !nd.isDiode) continue;
    const out = opposite(FACING_FACE[getProp(ns, 'facing')]);
    // Does its output actually point at us?
    if (out !== opposite(HORIZ_FACE[side])) continue;
    best = Math.max(best, emitted(world, nx, y, nz, ns, out, false, false));
  }
  return best;
}

export function updateDiode(world, x, y, z, state) {
  const def = blockOf(state);
  if (!def) return;
  if (def.name === 'comparator') { updateComparator(world, x, y, z, state); return; }

  const locked = diodeSideInput(world, x, y, z, state) > 0;
  if (locked !== getProp(state, 'locked')) {
    state = withProp(state, 'locked', locked);
    world.setBlock(x, y, z, state, FLAG.MARK_DIRTY);
  }
  if (locked) return;

  const powered = getProp(state, 'powered');
  const shouldPower = diodeInput(world, x, y, z, state) > 0;
  if (powered !== shouldPower && !world.isTickScheduled(x, y, z)) {
    // Turning on is more urgent than turning off — this is the priority trick
    // that makes back-to-back repeaters behave in the real game.
    world.scheduleTick(x, y, z, def, getProp(state, 'delay') * 2,
      shouldPower ? -1 : 1);
  }
}

export function tickDiode(world, x, y, z, state) {
  const def = blockOf(state);
  if (!def) return;
  if (def.name === 'comparator') { tickComparator(world, x, y, z, state); return; }
  if (getProp(state, 'locked')) return;

  const powered = getProp(state, 'powered');
  const shouldPower = diodeInput(world, x, y, z, state) > 0;
  if (powered === shouldPower) return;

  world.setBlock(x, y, z, withProp(state, 'powered', shouldPower), FLAG.MARK_DIRTY);
  notifyDiodeOutput(world, x, y, z, state);
  if (!shouldPower) return;
  // Still on but the input has already gone: queue the falling edge.
  if (!world.isTickScheduled(x, y, z)) {
    world.scheduleTick(x, y, z, def, getProp(state, 'delay') * 2, 1);
  }
}

/** A diode strongly powers the block in front, so that block's side matters. */
function notifyDiodeOutput(world, x, y, z, state) {
  const out = FACES[opposite(FACING_FACE[getProp(state, 'facing')])];
  notifyDeep(world, x + out.dx, y + out.dy, z + out.dz);
  enqueue(world, x, y, z, 0, 0);
}

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

/**
 * The analog value a comparator reads out of the block behind it: how full a
 * container is, how many bites are left in a cake, how deep a cauldron is.
 */
export function comparatorOutput(world, x, y, z) {
  const state = world.getBlock(x, y, z);
  if (state === 0) return 0;
  const def = blockOf(state);
  if (!def) return 0;

  if (def.name === 'cake') return (6 - (getProp(state, 'bites') | 0)) * 2 + 2;
  if (def.name === 'water_cauldron' || def.name === 'powder_snow_cauldron') {
    return getProp(state, 'level') | 0;
  }
  if (def.name === 'lava_cauldron') return 3;
  if (def.name === 'cauldron') return 0;
  if (def.name === 'composter') return getProp(state, 'level') | 0;
  if (def.stateDef.has('power')) return getProp(state, 'power') | 0;

  const be = world.getBlockEntity(x, y, z);
  if (be) {
    if (typeof be.comparatorOutput === 'function') return be.comparatorOutput();
    if (Array.isArray(be.slots)) return containerFullness(be.slots);
  }
  return 0;
}

/** Minecraft's container-fullness curve: 0, then 1..15 across the inventory. */
export function containerFullness(slots) {
  if (!slots || slots.length === 0) return 0;
  let fill = 0, used = 0;
  for (const s of slots) {
    if (!s || s.count <= 0) continue;
    used++;
    fill += s.count / Math.max(1, Math.min(64, s.maxStack ?? 64));
  }
  if (used === 0) return 0;
  return Math.floor((fill / slots.length) * 14) + 1;
}

/** Total input to a comparator: redstone power, or the container behind it. */
function comparatorInput(world, x, y, z, state) {
  let power = diodeInput(world, x, y, z, state);
  const d = FACES[FACING_FACE[getProp(state, 'facing')]];
  const bx = x + d.dx, by = y + d.dy, bz = z + d.dz;
  const analog = comparatorOutput(world, bx, by, bz);
  if (analog > 0) power = Math.max(power, analog);
  return power;
}

/** Highest signal on either side of a comparator (dust, diodes, solid blocks). */
function comparatorSides(world, x, y, z, state) {
  const dir = HORIZ_INDEX[getProp(state, 'facing')];
  let best = 0;
  for (const side of [(dir + 1) & 3, (dir + 3) & 3]) {
    const d = HORIZONTAL[side];
    const face = HORIZ_FACE[side];
    best = Math.max(best,
      signalFrom(world, x + d.dx, y, z + d.dz, opposite(face), false));
  }
  return best;
}

function comparatorValue(world, x, y, z, state) {
  const input = comparatorInput(world, x, y, z, state);
  const side = comparatorSides(world, x, y, z, state);
  if (getProp(state, 'mode') === 'subtract') return Math.max(0, input - side);
  return side > input ? 0 : input;
}

export function updateComparator(world, x, y, z, state) {
  const be = world.getBlockEntity(x, y, z);
  const value = comparatorValue(world, x, y, z, state);
  const current = be && be.output != null
    ? be.output : (getProp(state, 'powered') ? MAX_POWER : 0);
  if (value !== current && !world.isTickScheduled(x, y, z)) {
    world.scheduleTick(x, y, z, blockOf(state), 2, value > 0 ? -1 : 0);
  }
}

export function tickComparator(world, x, y, z, state) {
  const value = comparatorValue(world, x, y, z, state);
  const be = world.getBlockEntity(x, y, z);
  const previous = be && be.output != null
    ? be.output : (getProp(state, 'powered') ? MAX_POWER : 0);
  if (value === previous) return;
  if (be) be.output = value;
  if ((value > 0) !== getProp(state, 'powered')) {
    world.setBlock(x, y, z, withProp(state, 'powered', value > 0), FLAG.MARK_DIRTY);
  }
  notifyDiodeOutput(world, x, y, z, state);
}

// ---------------------------------------------------------------------------
// Observers
// ---------------------------------------------------------------------------

/**
 * Observers fire on a *change* in the block they face. The neighbour hook the
 * registry gives us does not say which neighbour moved, so each observer
 * remembers the state it last saw and compares.
 */
export function updateObserver(world, x, y, z, state) {
  const S = redstoneState(world);
  const k = key3(x, y, z);
  const d = FACES[FACING_FACE[getProp(state, 'facing')]];
  const watched = world.getBlock(x + d.dx, y + d.dy, z + d.dz);
  const seen = S.observed.get(k);
  S.observed.set(k, watched);
  if (seen === undefined || seen === watched) return;
  if (getProp(state, 'powered')) return;   // already mid-pulse
  world.setBlock(x, y, z, withProp(state, 'powered', true), FLAG.MARK_DIRTY);
  // A two-tick pulse: the block definition clears `powered` on its own tick.
  world.scheduleTick(x, y, z, blockOf(state), 2);
  const back = FACES[opposite(FACING_FACE[getProp(state, 'facing')])];
  notifyDeep(world, x + back.dx, y + back.dy, z + back.dz);
  enqueue(world, x, y, z, 0, 0);
}

// ---------------------------------------------------------------------------
// Pistons
// ---------------------------------------------------------------------------

/** A piston reads power from every side except the one its head comes out of. */
function pistonPowered(world, x, y, z, face) {
  for (let f = 0; f < 6; f++) {
    if (f === face) continue;
    const d = FACES[f];
    if (signalFrom(world, x + d.dx, y + d.dy, z + d.dz, d.opposite, false) > 0) return true;
  }
  return false;
}

export function updatePiston(world, x, y, z, state, sticky) {
  const def = blockOf(state);
  if (!def || !def.isPiston) return;
  if (isMoving(world, x, y, z)) return;

  const face = FACING_FACE[getProp(state, 'facing')];
  const extended = getProp(state, 'extended');
  const powered = pistonPowered(world, x, y, z, face);
  if (powered === extended) return;

  // Deferred so the move happens between neighbour notifications rather than
  // in the middle of one — a piston that rewrites the world underneath a
  // running notification loop is how you get half-moved blocks.
  defer(world, 0, () => {
    const now = world.getBlock(x, y, z);
    const d = blockOf(now);
    if (!d || !d.isPiston) return;
    const f = FACING_FACE[getProp(now, 'facing')];
    const isExtended = getProp(now, 'extended');
    const stillPowered = pistonPowered(world, x, y, z, f);
    if (stillPowered === isExtended) return;
    if (stillPowered) extendPiston(world, x, y, z, now, !!d.sticky);
    else retractPiston(world, x, y, z, now, !!d.sticky);
  });
}

// ---------------------------------------------------------------------------
// Dispensers and droppers
// ---------------------------------------------------------------------------

export function updateDispenser(world, x, y, z, state) {
  const powered = hasSignal(world, x, y, z) || hasSignal(world, x, y + 1, z);
  const triggered = getProp(state, 'triggered');
  if (powered === triggered) return;
  world.setBlock(x, y, z, withProp(state, 'triggered', powered), FLAG.MARK_DIRTY);
  if (!powered) return;
  defer(world, 4, () => {
    const be = world.getBlockEntity(x, y, z);
    if (be && typeof be.dispense === 'function') be.dispense(world);
  });
}

// ---------------------------------------------------------------------------
// Note blocks, rails, pressure plates
// ---------------------------------------------------------------------------

function updateNoteBlock(world, x, y, z, state) {
  const powered = hasSignal(world, x, y, z);
  if (powered === getProp(state, 'powered')) return;
  world.setBlock(x, y, z, withProp(state, 'powered', powered), FLAG.MARK_DIRTY);
  if (!powered) return;
  if (world.getBlock(x, y + 1, z) !== 0) return;   // muffled by a block on top
  world.game?.audio?.playNote?.(world, x, y, z,
    getProp(state, 'instrument'), getProp(state, 'note'));
}

/**
 * A powered/activator rail turns on when it, or a rail up to eight blocks away
 * along the same track, is receiving a signal.
 */
function updateRail(world, x, y, z, state) {
  const powered = hasSignal(world, x, y, z) ||
    railChainPowered(world, x, y, z, state, 0) ||
    railChainPowered(world, x, y, z, state, 1);
  if (powered === getProp(state, 'powered')) return;
  world.setBlock(x, y, z, withProp(state, 'powered', powered), FLAG.MARK_DIRTY);
  // Let the rest of the track re-evaluate on the next pass.
  for (let dir = 0; dir < 4; dir++) {
    const d = HORIZONTAL[dir];
    for (const dy of [0, 1, -1]) {
      const nd = blockOf(world.getBlock(x + d.dx, y + dy, z + d.dz));
      if (nd && nd.isRail) enqueue(world, x + d.dx, y + dy, z + d.dz, 0, 2);
    }
  }
}

function railChainPowered(world, x, y, z, state, way) {
  const shape = getProp(state, 'shape');
  const axis = shape === 'east_west' || shape === 'ascending_east' ||
    shape === 'ascending_west' ? 1 : 0;
  const dir = axis === 1 ? (way === 0 ? 1 : 3) : (way === 0 ? 0 : 2);
  const d = HORIZONTAL[dir];
  let cx = x, cy = y, cz = z;
  for (let i = 0; i < 8; i++) {
    cx += d.dx; cz += d.dz;
    let st = world.getBlock(cx, cy, cz);
    let nd = blockOf(st);
    if (!nd?.isRail && blockOf(world.getBlock(cx, cy + 1, cz))?.isRail) {
      cy += 1; st = world.getBlock(cx, cy, cz); nd = blockOf(st);
    } else if (!nd?.isRail && blockOf(world.getBlock(cx, cy - 1, cz))?.isRail) {
      cy -= 1; st = world.getBlock(cx, cy, cz); nd = blockOf(st);
    }
    if (!nd?.isRail || !nd.stateDef.has('powered')) return false;
    if (nd.name !== blockOf(state).name) return false;
    if (hasSignal(world, cx, cy, cz)) return true;
  }
  return false;
}

/**
 * Recompute a pressure plate from what is standing on it.
 *
 * The block definition can only say "an entity touched me"; the rules about
 * *which* entities count, and how a weighted plate scales, live here.
 */
function refreshPressurePlate(world, x, y, z, state) {
  const def = blockOf(state);
  const kind = def.weighted || 'entities';
  const box = new AABB(x + 0.06, y, z + 0.06, x + 0.94, y + 0.25, z + 0.94);
  const list = world.entitiesInBox(box);

  let level = 0;
  if (kind === 'items_light' || kind === 'items_heavy') {
    const max = kind === 'items_light' ? 15 : 150;
    let count = 0;
    for (const e of list) count += e.stack?.count ?? 1;
    if (count > 0) level = Math.ceil((Math.min(count, max) * MAX_POWER) / max);
  } else {
    for (const e of list) {
      // Stone plates ignore dropped items and arrows; wooden ones do not.
      if (kind === 'mobs' && !(e.isPlayer || e.isMob || e.isLiving)) continue;
      level = MAX_POWER;
      break;
    }
  }

  const S = redstoneState(world);
  const k = key3(x, y, z);
  if (level > 0) S.plates.set(k, level); else S.plates.delete(k);

  if ((level > 0) !== getProp(state, 'powered')) {
    world.setBlock(x, y, z, withProp(state, 'powered', level > 0), FLAG.MARK_DIRTY);
    notifyDeep(world, x, y, z);
  }
}

// ---------------------------------------------------------------------------
// Miscellaneous entry points used by other systems
// ---------------------------------------------------------------------------

/** Dust changed shape or was placed/broken — resolve its network. */
export function updateWire(world, x, y, z, state) {
  enqueue(world, x, y, z, 0, 1);
}

/** A lightning rod was struck: pulse it for 8 ticks. */
export function strikeLightningRod(world, x, y, z) {
  const state = world.getBlock(x, y, z);
  if (blockOf(state)?.name !== 'lightning_rod') return false;
  if (!getProp(state, 'powered')) {
    world.setBlock(x, y, z, withProp(state, 'powered', true), FLAG.MARK_DIRTY);
    world.scheduleTick(x, y, z, blockOf(state), 8);
    update(world, x, y, z);
  }
  return true;
}

/** A projectile hit a target block: pulse it proportionally to the accuracy. */
export function hitTarget(world, x, y, z, accuracy = 1) {
  const state = world.getBlock(x, y, z);
  if (blockOf(state)?.name !== 'target') return 0;
  const power = Math.max(1, Math.round(accuracy * MAX_POWER));
  world.setBlock(x, y, z, withProp(state, 'power', power), FLAG.MARK_DIRTY);
  world.scheduleTick(x, y, z, blockOf(state), 20);
  update(world, x, y, z);
  return power;
}

/** Debug helper: the power level a dust block currently carries. */
export function wirePower(world, x, y, z) {
  const state = world.getBlock(x, y, z);
  return blockOf(state)?.isWire ? (getProp(state, 'power') | 0) : 0;
}

export { notifyAround, notifyDeep, enqueue as enqueueUpdate, defer as deferAction };
