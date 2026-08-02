// Pistons: what may be pushed, what is destroyed, and the two-tick move.
//
// A piston move is not instantaneous. When one fires, every block it is about
// to shift is replaced by `moving_piston` — an invisible placeholder carrying a
// block entity that remembers the state travelling through it and how far along
// it is. Two ticks later the placeholders resolve into real blocks. That is
// what gives the renderer something to interpolate, and it is also what stops
// half a dozen redstone components from reacting to a world that is mid-move.
//
// Redstone decides *when* a piston fires (see redstone.js); everything about
// *how* it moves lives here.

import { T, blockOf, getProp, withProp, stateOf, blocksByName, PUSH } from './blocks.js';
import { FLAG } from './world.js';
import { FACES, AABB } from '../core/math.js';

/** Vanilla's limit: a piston shifts at most twelve blocks. */
export const PUSH_LIMIT = 12;
/** Ticks a piston head takes to travel one block. */
export const MOVE_TICKS = 2;

const FACING_FACE = { west: 0, east: 1, down: 2, up: 3, north: 4, south: 5 };

const WORLD_STATE = new WeakMap();

function pistonState(world) {
  let s = WORLD_STATE.get(world);
  if (!s) {
    s = { moves: [], busy: new Set() };
    WORLD_STATE.set(world, s);
  }
  return s;
}

const key3 = (x, y, z) => `${x},${y},${z}`;

// ---------------------------------------------------------------------------
// Block lookups (resolved lazily: the registry is not frozen at import time)
// ---------------------------------------------------------------------------

let CACHE = null;
function blocks() {
  if (!CACHE) {
    CACHE = {
      head: blocksByName.get('piston_head') || null,
      moving: blocksByName.get('moving_piston') || null,
    };
  }
  return CACHE;
}

function movingState(face, sticky) {
  const b = blocks().moving;
  if (!b) return 0;
  return stateOf(b, { facing: FACES[face].name, type: sticky ? 'sticky' : 'normal' });
}

function headState(face, sticky) {
  const b = blocks().head;
  if (!b) return 0;
  return stateOf(b, {
    facing: FACES[face].name, type: sticky ? 'sticky' : 'normal', short: false,
  });
}

// ---------------------------------------------------------------------------
// Push rules
// ---------------------------------------------------------------------------

/**
 * May this block be shoved along by a piston?
 *
 * Three things stop a block moving: it declares `PUSH.BLOCK` (obsidian,
 * bedrock, another piston's head), it is indestructible (`hardness < 0`), or it
 * owns a block entity — chests, furnaces, spawners and signs all keep state
 * that cannot ride along inside a `moving_piston`.
 */
export function canPush(world, x, y, z, state) {
  if (state === 0) return false;
  const def = blockOf(state);
  if (!def) return false;
  if (def.push === PUSH.BLOCK) return false;
  if (def.hardness < 0) return false;
  if (def.hasEntity) return false;
  return true;
}

/** Is the cell free for a pushed block to move into? */
function isOpen(state) {
  if (state === 0) return true;
  if (T.fluid[state] !== 0) return true;
  return T.replaceable[state] === 1 && T.solid[state] !== 1;
}

/**
 * Walk forward from a piston collecting what a push would affect.
 * @returns {{move: object[], destroy: object[]}|null} null when the push is
 *          blocked — by an immovable block, or by more than twelve movable ones.
 */
export function collectPush(world, x, y, z, face) {
  const d = FACES[face];
  const move = [];
  const destroy = [];
  let cx = x + d.dx, cy = y + d.dy, cz = z + d.dz;

  for (let i = 0; i <= PUSH_LIMIT + 1; i++) {
    const state = world.getBlock(cx, cy, cz);
    if (state === 0) return { move, destroy };
    const def = blockOf(state);
    if (!def) return null;
    // Torches, plants and dust are knocked out rather than carried along.
    if (def.push === PUSH.DESTROY) {
      destroy.push({ x: cx, y: cy, z: cz, state });
      return { move, destroy };
    }
    if (isOpen(state)) return { move, destroy };
    if (!canPush(world, cx, cy, cz, state)) return null;
    if (move.length >= PUSH_LIMIT) return null;
    move.push({ x: cx, y: cy, z: cz, state });
    cx += d.dx; cy += d.dy; cz += d.dz;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extension and retraction
// ---------------------------------------------------------------------------

/** Fire a piston. Returns false when the push is blocked. */
export function extendPiston(world, x, y, z, state, sticky) {
  const def = blockOf(state);
  if (!def || !def.isPiston || getProp(state, 'extended')) return false;
  const face = FACING_FACE[getProp(state, 'facing')];
  const d = FACES[face];
  const plan = collectPush(world, x, y, z, face);
  if (!plan) return false;

  const S = pistonState(world);
  for (const b of plan.destroy) world.destroyBlock(b.x, b.y, b.z, true);

  // Anything standing in the swept volume is carried one block along.
  pushEntitiesAlong(world, x, y, z, face, plan.move.length + 1);

  const placeholder = movingState(face, sticky);
  const cells = [];

  // Rewrite from the far end backwards so no source cell is clobbered before
  // it has been read.
  for (let i = plan.move.length - 1; i >= 0; i--) {
    const b = plan.move[i];
    const tx = b.x + d.dx, ty = b.y + d.dy, tz = b.z + d.dz;
    world.setBlock(b.x, b.y, b.z, 0, FLAG.MARK_DIRTY);
    world.setBlock(tx, ty, tz, placeholder, FLAG.MARK_DIRTY);
    attachMoveData(world, tx, ty, tz, b.state, face, true, false);
    cells.push({ x: tx, y: ty, z: tz, state: b.state });
  }

  // The head travels through the cell directly in front of the body.
  const hx = x + d.dx, hy = y + d.dy, hz = z + d.dz;
  world.setBlock(hx, hy, hz, placeholder, FLAG.MARK_DIRTY);
  attachMoveData(world, hx, hy, hz, headState(face, sticky), face, true, true);
  cells.push({ x: hx, y: hy, z: hz, state: headState(face, sticky) });

  world.setBlock(x, y, z, withProp(state, 'extended', true), FLAG.MARK_DIRTY);
  world.playSound('piston.extend', x + 0.5, y + 0.5, z + 0.5, 0.5, 0.6);

  S.moves.push({ at: world.tickCount + MOVE_TICKS, cells, piston: { x, y, z } });
  for (const c of cells) S.busy.add(key3(c.x, c.y, c.z));
  S.busy.add(key3(x, y, z));
  return true;
}

/** Pull a piston back in; a sticky one drags the block in front along. */
export function retractPiston(world, x, y, z, state, sticky) {
  const def = blockOf(state);
  if (!def || !def.isPiston || !getProp(state, 'extended')) return false;
  const face = FACING_FACE[getProp(state, 'facing')];
  const d = FACES[face];
  const hx = x + d.dx, hy = y + d.dy, hz = z + d.dz;

  const S = pistonState(world);
  const atHead = world.getBlock(hx, hy, hz);
  if (blockOf(atHead)?.name === 'piston_head') {
    world.setBlock(hx, hy, hz, 0, FLAG.MARK_DIRTY);
  }
  world.setBlock(x, y, z, withProp(state, 'extended', false), FLAG.MARK_DIRTY);

  const cells = [];
  if (sticky) {
    const px = hx + d.dx, py = hy + d.dy, pz = hz + d.dz;
    const pulled = world.getBlock(px, py, pz);
    if (canPush(world, px, py, pz, pulled) && blockOf(pulled).push !== PUSH.DESTROY) {
      world.setBlock(px, py, pz, 0, FLAG.MARK_DIRTY);
      world.setBlock(hx, hy, hz, movingState(face, sticky), FLAG.MARK_DIRTY);
      attachMoveData(world, hx, hy, hz, pulled, face, false, false);
      cells.push({ x: hx, y: hy, z: hz, state: pulled });
    }
  }
  world.playSound('piston.contract', x + 0.5, y + 0.5, z + 0.5, 0.5, 0.6);

  if (cells.length) {
    S.moves.push({ at: world.tickCount + MOVE_TICKS, cells, piston: { x, y, z } });
    for (const c of cells) S.busy.add(key3(c.x, c.y, c.z));
    S.busy.add(key3(x, y, z));
  } else {
    notifyAt(world, x, y, z);
    notifyAt(world, hx, hy, hz);
  }
  return true;
}

/**
 * Hand the renderer (and the physics) something to interpolate: the block
 * entity behind a `moving_piston` remembers what is travelling through it.
 */
function attachMoveData(world, x, y, z, source, face, extending, isHead) {
  const be = world.getBlockEntity(x, y, z);
  if (!be) return;
  be.sourceState = source;
  be.direction = face;
  be.extending = extending;
  be.isHead = isHead;
  be.progress = 0;
  be.lastProgress = 0;
  be.totalTicks = MOVE_TICKS;
}

/** True while a move is in flight at or around this position. */
export function isMoving(world, x, y, z) {
  const S = WORLD_STATE.get(world);
  if (!S) return false;
  return S.busy.has(key3(x, y, z));
}

/**
 * Advance in-flight piston moves. Called once a tick from `tickRedstone`, so
 * pistons keep step with the circuits driving them.
 */
export function tickPistons(world) {
  const S = WORLD_STATE.get(world);
  if (!S || S.moves.length === 0) return 0;

  // Animation progress for anything still travelling.
  for (const mv of S.moves) {
    for (const c of mv.cells) {
      const be = world.getBlockEntity(c.x, c.y, c.z);
      if (!be || be.progress == null) continue;
      be.lastProgress = be.progress;
      be.progress = Math.min(1, be.progress + 1 / MOVE_TICKS);
    }
  }

  const due = [], keep = [];
  for (const mv of S.moves) (mv.at <= world.tickCount ? due : keep).push(mv);
  S.moves = keep;
  if (due.length === 0) return 0;

  for (const mv of due) {
    for (const c of mv.cells) {
      S.busy.delete(key3(c.x, c.y, c.z));
      const here = world.getBlock(c.x, c.y, c.z);
      // Something may have broken the placeholder while it was in flight.
      if (blockOf(here)?.name !== 'moving_piston') continue;
      world.setBlock(c.x, c.y, c.z, c.state, FLAG.MARK_DIRTY | FLAG.UPDATE_LIGHT);
    }
    S.busy.delete(key3(mv.piston.x, mv.piston.y, mv.piston.z));
  }
  // Only once every cell holds its final block do the neighbours get told.
  for (const mv of due) {
    for (const c of mv.cells) notifyAt(world, c.x, c.y, c.z);
    notifyAt(world, mv.piston.x, mv.piston.y, mv.piston.z);
  }
  return due.length;
}

function notifyAt(world, x, y, z) {
  const st = world.getBlock(x, y, z);
  world.notifyNeighbors(x, y, z, st, st);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Shove every entity inside `box` by (dx,dy,dz). Exposed as game.physics.pushEntities. */
export function pushEntities(world, box, dx, dy, dz) {
  const list = world.entitiesInBox(box);
  for (const e of list) {
    if (e.noPush || e.removed) continue;
    e.x += dx; e.y += dy; e.z += dz;
    e.prevX = (e.prevX ?? e.x) + dx;
    e.prevY = (e.prevY ?? e.y) + dy;
    e.prevZ = (e.prevZ ?? e.z) + dz;
    e.updateBounds?.();
    world.updateEntityChunk?.(e);
    // A little residual velocity so the shove looks like a shove.
    e.vx = (e.vx ?? 0) + dx * 0.05;
    e.vy = (e.vy ?? 0) + dy * 0.05;
    e.vz = (e.vz ?? 0) + dz * 0.05;
  }
  return list.length;
}

/** The swept volume of a push, from the piston head out to the last block. */
function pushEntitiesAlong(world, x, y, z, face, length) {
  const d = FACES[face];
  const x0 = Math.min(x + d.dx, x + d.dx * length);
  const y0 = Math.min(y + d.dy, y + d.dy * length);
  const z0 = Math.min(z + d.dz, z + d.dz * length);
  const x1 = Math.max(x + d.dx, x + d.dx * length);
  const y1 = Math.max(y + d.dy, y + d.dy * length);
  const z1 = Math.max(z + d.dz, z + d.dz * length);
  const box = new AABB(x0, y0, z0, x1 + 1, y1 + 1, z1 + 1);
  return pushEntities(world, box, d.dx, d.dy, d.dz);
}

/** Number of moves still in flight — useful for tests and the debug overlay. */
export function pendingMoves(world) {
  return WORLD_STATE.get(world)?.moves.length ?? 0;
}
