// Mob AI: a priority goal selector plus an A* pathfinder over the voxel grid.
//
// The design follows Minecraft's: a mob owns an ordered list of goals, each of
// which claims a set of control flags (movement, looking, jumping, targeting).
// Every tick the selector walks the list in priority order and grants flags to
// the highest-priority goal that wants them, starting and stopping goals as
// ownership changes. A goal never has to know about the others — it only has to
// answer `canUse()` honestly.
//
// Pathfinding is a bounded A* over standable cells. The search is capped by a
// node budget so a mob in an unreachable spot degrades to "walk toward the
// closest reachable point" instead of stalling the frame.

import { clamp, wrapAngle, approachAngle, AABB } from '../core/math.js';
import { T, blockOf, blocksByName } from '../world/blocks.js';
import { MIN_Y, MAX_Y } from '../world/chunk.js';

// ---------------------------------------------------------------------------
// Goal selector
// ---------------------------------------------------------------------------

/** Control channels a goal can claim. Two goals may not share a channel. */
export const FLAG = {
  MOVE: 1,
  LOOK: 2,
  JUMP: 4,
  TARGET: 8,
};

export class Goal {
  constructor() {
    this.flags = 0;
    this.mob = null;
    /** Ticks to wait before re-testing `canUse()` after it returns false. */
    this.interval = 0;
  }

  canUse() { return false; }
  canContinue() { return this.canUse(); }
  start() {}
  stop() {}
  tick() {}

  get world() { return this.mob.world; }
  get random() { return this.mob.world.random; }
}

export class GoalSelector {
  constructor(mob) {
    this.mob = mob;
    this.entries = [];
    this.tickCount = 0;
  }

  /** Lower priority numbers win, exactly as in Minecraft. */
  add(priority, goal) {
    goal.mob = this.mob;
    this.entries.push({ priority, goal, running: false, cooldown: 0 });
    this.entries.sort((a, b) => a.priority - b.priority);
    return goal;
  }

  remove(goal) {
    const i = this.entries.findIndex((e) => e.goal === goal);
    if (i < 0) return false;
    if (this.entries[i].running) goal.stop();
    this.entries.splice(i, 1);
    return true;
  }

  removeAll() {
    for (const e of this.entries) if (e.running) e.goal.stop();
    this.entries.length = 0;
  }

  has(goalClass) {
    return this.entries.some((e) => e.goal instanceof goalClass);
  }

  tick() {
    this.tickCount++;
    const entries = this.entries;
    let claimed = 0;

    // Pass 1: decide, in priority order, who gets to run this tick.
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      let want;
      if (e.running) {
        want = safeCall(e.goal, 'canContinue');
      } else if (e.cooldown > 0) {
        e.cooldown--;
        want = false;
      } else {
        want = safeCall(e.goal, 'canUse');
        if (!want) e.cooldown = e.goal.interval;
      }
      if (want && (claimed & e.goal.flags) !== 0) want = false;
      e.want = want;
      if (want) claimed |= e.goal.flags;
    }

    // Pass 2: start and stop.
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.want && !e.running) { e.running = true; safeRun(e.goal, 'start'); }
      else if (!e.want && e.running) { e.running = false; safeRun(e.goal, 'stop'); }
    }

    // Pass 3: run.
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].running) safeRun(entries[i].goal, 'tick');
    }
  }
}

function safeCall(goal, method) {
  try { return !!goal[method](); } catch (e) { warnOnce(goal, method, e); return false; }
}
function safeRun(goal, method) {
  try { goal[method](); } catch (e) { warnOnce(goal, method, e); }
}
const warned = new Set();
function warnOnce(goal, method, e) {
  const key = `${goal.constructor.name}.${method}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[ai] ${key} threw: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Pathfinding
// ---------------------------------------------------------------------------

/**
 * The search volume, centred on the start node. 49x25x49 cells covers every
 * follow range a mob uses and is small enough to index with flat typed arrays
 * that are reused between searches — no allocation per path, ever.
 */
const RX = 24, RY = 12;
const DX = RX * 2 + 1, DY = RY * 2 + 1, DZ = RX * 2 + 1;
const CELLS = DX * DY * DZ;

const gScore = new Float32Array(CELLS);
const fScore = new Float32Array(CELLS);
const cameFrom = new Int32Array(CELLS);
const stamp = new Int32Array(CELLS);
const closedGen = new Int32Array(CELLS);
/** Bumped per search so the arrays never need clearing. */
let generation = 0;

/** Binary min-heap over cell indices keyed by fScore. */
const heap = new Int32Array(CELLS);
let heapSize = 0;

function heapPush(i) {
  let n = heapSize++;
  heap[n] = i;
  while (n > 0) {
    const p = (n - 1) >> 1;
    if (fScore[heap[p]] <= fScore[heap[n]]) break;
    const t = heap[p]; heap[p] = heap[n]; heap[n] = t;
    n = p;
  }
}

function heapPop() {
  const top = heap[0];
  heap[0] = heap[--heapSize];
  let n = 0;
  for (;;) {
    const l = n * 2 + 1, r = l + 1;
    let m = n;
    if (l < heapSize && fScore[heap[l]] < fScore[heap[m]]) m = l;
    if (r < heapSize && fScore[heap[r]] < fScore[heap[m]]) m = r;
    if (m === n) break;
    const t = heap[m]; heap[m] = heap[n]; heap[n] = t;
    n = m;
  }
  return top;
}

const cellIndex = (lx, ly, lz) => ((ly + RY) * DZ + (lz + RX)) * DX + (lx + RX);

/** Movement costs, mirroring Minecraft's path "malus" values. */
export const PATH_COST = {
  WATER: 8,
  DANGER: 16,
  JUMP: 0.7,
  DROP: 0.4,
  DOOR: 1.5,
  OPEN: 0,
};

/**
 * How an entity may traverse the world. `swim` mobs treat water as free and
 * air as impassable; `fly` mobs ignore floors entirely.
 */
export function pathContext(mob) {
  return {
    height: Math.max(1, Math.ceil(mob.height * (mob.scale ?? 1) - 0.01)),
    width: Math.max(1, Math.ceil(mob.width * (mob.scale ?? 1) - 0.01)),
    canSwim: !!mob.canSwim,
    aquatic: !!mob.aquatic,
    flies: !!mob.flies,
    canOpenDoors: !!mob.canOpenDoors,
    avoidWater: !!mob.avoidsWater,
    avoidSun: !!mob.avoidsSun,
    fireproof: !!mob.immuneToFire,
    maxDrop: mob.maxPathDrop ?? 3,
    climbs: !!mob.climbs,
  };
}

/** Is this cell free of collision for a walking entity? */
function passable(world, x, y, z, ctx) {
  if (y < MIN_Y || y > MAX_Y) return false;
  const st = world.getBlock(x, y, z);
  if (st === 0) return true;
  if (T.solid[st]) {
    const def = blockOf(st);
    if (ctx.canOpenDoors && def?.isDoor) return true;
    return false;
  }
  const fluid = T.fluid[st];
  if (fluid === 2 && !ctx.fireproof) return false;
  const def = blockOf(st);
  if (!def) return true;
  if (def.name === 'cactus' || def.name === 'sweet_berry_bush' ||
    def.name === 'fire' || def.name === 'soul_fire' ||
    def.name === 'magma_block' || def.name === 'wither_rose') {
    return ctx.fireproof && def.name !== 'cactus';
  }
  // Anything with a partial collision box smaller than a step is walkable.
  const boxes = def.collisionFor(st);
  if (boxes.length === 0) return true;
  let maxY = 0;
  for (const b of boxes) if (b.maxY > maxY) maxY = b.maxY;
  return maxY <= 0.6;
}

function isWater(world, x, y, z) {
  const st = world.getBlock(x, y, z);
  return T.fluid[st] === 1 || T.waterlogged[st] === 1;
}

function solidFloor(world, x, y, z) {
  const st = world.getBlock(x, y - 1, z);
  if (T.solid[st]) return true;
  const def = blockOf(st);
  if (!def) return false;
  const boxes = def.collisionFor(st);
  for (const b of boxes) if (b.maxY >= 0.9) return true;
  return false;
}

/**
 * Extra cost of standing at a cell, or -1 when the entity cannot stand there.
 * A land mob needs a floor; a swimming mob needs water; a flier needs neither.
 */
function standCost(world, x, y, z, ctx) {
  for (let i = 0; i < ctx.height; i++) {
    if (!passable(world, x, y + i, z, ctx)) return -1;
  }
  const water = isWater(world, x, y, z);
  if (ctx.aquatic) return water ? 0 : -1;
  if (ctx.flies) return water ? PATH_COST.WATER : 0;
  if (water) {
    if (!ctx.canSwim) return -1;
    return ctx.avoidWater ? PATH_COST.WATER : 1;
  }
  if (!solidFloor(world, x, y, z)) return -1;
  let extra = 0;
  const below = blockOf(world.getBlock(x, y - 1, z));
  if (below) {
    if (below.name === 'magma_block' && !ctx.fireproof) extra += PATH_COST.DANGER;
    if (below.name === 'ice' || below.name === 'blue_ice') extra += 0.5;
  }
  const here = blockOf(world.getBlock(x, y, z));
  if (here?.isDoor) extra += PATH_COST.DOOR;
  if (ctx.avoidSun && world.hasSkylight && world.isDay() &&
    world.getSkyLight(x, y, z) >= 15) extra += 4;
  return extra;
}

const NEIGHBORS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * A* from (sx,sy,sz) to (tx,ty,tz) over standable cells.
 *
 * Returns an array of `{x,y,z}` waypoints (block coordinates, the entity's feet
 * cell) or null. When the goal is unreachable within `maxNodes`, the path to
 * the closest node explored is returned instead, which is what keeps a mob
 * pushing against a wall in roughly the right direction rather than giving up.
 */
export function findPath(world, sx, sy, sz, tx, ty, tz, ctx, opts = {}) {
  const maxNodes = opts.maxNodes ?? 320;
  const reach = opts.reach ?? 1;

  sx = Math.floor(sx); sy = Math.floor(sy); sz = Math.floor(sz);
  tx = Math.floor(tx); ty = Math.floor(ty); tz = Math.floor(tz);

  // Snap the start down onto the floor the entity is actually standing on.
  if (!ctx.flies && !ctx.aquatic && standCost(world, sx, sy, sz, ctx) < 0) {
    let found = false;
    for (let d = 1; d <= 2 && !found; d++) {
      if (standCost(world, sx, sy - d, sz, ctx) >= 0) { sy -= d; found = true; }
      else if (standCost(world, sx, sy + d, sz, ctx) >= 0) { sy += d; found = true; }
    }
    if (!found) return null;
  }

  // Clamp the target into the search volume.
  tx = clamp(tx, sx - RX + 1, sx + RX - 1);
  ty = clamp(ty, sy - RY + 1, sy + RY - 1);
  tz = clamp(tz, sz - RX + 1, sz + RX - 1);

  generation++;
  heapSize = 0;
  const gen = generation;

  const start = cellIndex(0, 0, 0);
  stamp[start] = gen;
  gScore[start] = 0;
  cameFrom[start] = -1;
  fScore[start] = heuristic(sx, sy, sz, tx, ty, tz);
  heapPush(start);

  let best = start;
  let bestH = fScore[start];
  let expanded = 0;

  while (heapSize > 0 && expanded < maxNodes) {
    const cur = heapPop();
    if (closedGen[cur] === gen) continue;
    closedGen[cur] = gen;
    expanded++;

    const clx = (cur % DX) - RX;
    const clz = (Math.floor(cur / DX) % DZ) - RX;
    const cly = Math.floor(cur / (DX * DZ)) - RY;
    const cx = sx + clx, cy = sy + cly, cz = sz + clz;

    const h = heuristic(cx, cy, cz, tx, ty, tz);
    if (h < bestH) { bestH = h; best = cur; }
    if (Math.abs(cx - tx) <= reach && Math.abs(cz - tz) <= reach &&
      Math.abs(cy - ty) <= Math.max(1, reach)) {
      return buildPath(cur, sx, sy, sz);
    }

    for (let n = 0; n < NEIGHBORS.length; n++) {
      const ox = NEIGHBORS[n][0], oz = NEIGHBORS[n][1];
      const diagonal = ox !== 0 && oz !== 0;
      const nx = cx + ox, nz = cz + oz;
      if (Math.abs(nx - sx) > RX - 1 || Math.abs(nz - sz) > RX - 1) continue;

      // Corners may not be cut through solid blocks.
      if (diagonal) {
        if (standCost(world, cx + ox, cy, cz, ctx) < 0 &&
          standCost(world, cx, cy, cz + oz, ctx) < 0) continue;
      }

      // Scan the column from a one-block step up down to the biggest safe
      // drop, and take the first cell the entity could actually stand in.
      const lowest = diagonal ? 0 : -ctx.maxDrop;
      const highest = diagonal ? 0 : 1;
      for (let dy = highest; dy >= lowest; dy--) {
        const ny = cy + dy;
        if (Math.abs(ny - sy) > RY - 1) continue;
        if (dy > 0) {
          // Jumping needs headroom above the cell we are leaving, too.
          if (!passable(world, cx, cy + ctx.height, cz, ctx)) continue;
          if (ctx.aquatic && !isWater(world, nx, ny, nz)) continue;
        }
        const extra = standCost(world, nx, ny, nz, ctx);
        if (extra < 0) continue;

        let cost = diagonal ? 1.4142 : 1;
        cost += extra;
        if (dy > 0) cost += PATH_COST.JUMP;
        else if (dy < 0) cost += PATH_COST.DROP * -dy;

        const idx = cellIndex(nx - sx, ny - sy, nz - sz);
        if (closedGen[idx] === gen) break;
        if (stamp[idx] !== gen) {
          stamp[idx] = gen;
          gScore[idx] = Infinity;
        }
        const tentative = gScore[cur] + cost;
        if (tentative < gScore[idx]) {
          gScore[idx] = tentative;
          cameFrom[idx] = cur;
          fScore[idx] = tentative + heuristic(nx, ny, nz, tx, ty, tz);
          heapPush(idx);
        }
        break;   // the first standable cell in this column wins
      }
    }
  }

  if (best === start) return null;
  return buildPath(best, sx, sy, sz);
}

function heuristic(x, y, z, tx, ty, tz) {
  const dx = Math.abs(x - tx), dy = Math.abs(y - ty), dz = Math.abs(z - tz);
  const lo = Math.min(dx, dz), hi = Math.max(dx, dz);
  return hi + lo * 0.4142 + dy * 1.2;
}

function buildPath(end, sx, sy, sz) {
  const out = [];
  let cur = end;
  let guard = 0;
  while (cur >= 0 && guard++ < 4096) {
    const lx = (cur % DX) - RX;
    const lz = (Math.floor(cur / DX) % DZ) - RX;
    const ly = Math.floor(cur / (DX * DZ)) - RY;
    out.push({ x: sx + lx, y: sy + ly, z: sz + lz });
    cur = cameFrom[cur];
  }
  out.reverse();
  return out.length > 1 ? out : null;
}

/**
 * Drop waypoints that lie on a straight, unobstructed run between their
 * neighbours. Fewer nodes means the mob walks in long diagonal lines instead of
 * stair-stepping around every corner.
 */
export function smoothPath(world, path, ctx) {
  if (!path || path.length <= 2) return path;
  const out = [path[0]];
  let anchor = 0;
  for (let i = 2; i < path.length; i++) {
    if (!clearLine(world, path[anchor], path[i], ctx)) {
      out.push(path[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(path[path.length - 1]);
  return out;
}

function clearLine(world, a, b, ctx) {
  if (a.y !== b.y) return false;
  const dx = b.x - a.x, dz = b.z - a.z;
  const steps = Math.max(Math.abs(dx), Math.abs(dz));
  if (steps === 0) return true;
  if (steps > 12) return false;
  for (let i = 1; i < steps; i++) {
    const x = Math.round(a.x + (dx * i) / steps);
    const z = Math.round(a.z + (dz * i) / steps);
    if (standCost(world, x, a.y, z, ctx) < 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Drives a mob along a path: steers, jumps over one-block rises, repaths when
 * the destination moves, and gives up when it stops making progress.
 */
export class PathNavigator {
  constructor(mob) {
    this.mob = mob;
    this.path = null;
    this.index = 0;
    this.speed = 1;
    this.target = null;          // {x,y,z}
    this.followEntity = null;
    this.repathCooldown = 0;
    this.stuckTicks = 0;
    this.lastX = mob.x;
    this.lastZ = mob.z;
    this.ctx = pathContext(mob);
    this.maxNodes = mob.pathBudget ?? 320;
  }

  get isDone() { return this.path === null; }

  stop() {
    this.path = null;
    this.index = 0;
    this.followEntity = null;
    this.target = null;
    this.mob.moveForward = 0;
  }

  /** Path to a block position. Returns false when nothing was found. */
  moveTo(x, y, z, speed = 1) {
    const mob = this.mob;
    this.ctx = pathContext(mob);
    this.speed = speed;
    this.target = { x, y, z };
    const raw = findPath(mob.world, mob.x, mob.y + 0.01, mob.z, x, y, z, this.ctx,
      { maxNodes: this.maxNodes });
    if (!raw) { this.path = null; return false; }
    this.path = smoothPath(mob.world, raw, this.ctx);
    this.index = 1;
    this.stuckTicks = 0;
    return true;
  }

  moveToEntity(entity, speed = 1) {
    if (!entity) return false;
    this.followEntity = entity;
    const ok = this.moveTo(Math.floor(entity.x), Math.floor(entity.y),
      Math.floor(entity.z), speed);
    this.followEntity = entity;
    return ok;
  }

  tick() {
    const mob = this.mob;
    if (this.repathCooldown > 0) this.repathCooldown--;

    // Chase a moving target by repathing on a cooldown.
    if (this.followEntity) {
      if (this.followEntity.removed || this.followEntity.dead) { this.stop(); return; }
      if (this.repathCooldown === 0) {
        const t = this.followEntity;
        const moved = !this.target ||
          Math.abs(t.x - this.target.x) > 1.5 || Math.abs(t.z - this.target.z) > 1.5 ||
          Math.abs(t.y - this.target.y) > 1.5;
        if (moved || !this.path) {
          this.repathCooldown = 10;
          const keep = this.followEntity;
          this.moveTo(Math.floor(t.x), Math.floor(t.y), Math.floor(t.z), this.speed);
          this.followEntity = keep;
        }
      }
    }

    if (!this.path) return;
    if (this.index >= this.path.length) { this.stop(); return; }

    const node = this.path[this.index];
    const nx = node.x + 0.5, nz = node.z + 0.5;
    const dx = nx - mob.x, dz = nz - mob.z;
    const distSq = dx * dx + dz * dz;
    const dy = node.y - mob.y;

    // Reached this waypoint?
    const reach = Math.max(0.35, mob.width * 0.6);
    if (distSq < reach * reach && Math.abs(dy) < 1.2) {
      this.index++;
      if (this.index >= this.path.length) { this.stop(); return; }
      this.stuckTicks = 0;
      return;
    }

    mob.moveYaw = Math.atan2(-dx, dz);
    mob.moveForward = 1;
    mob.movementSpeed = mob.baseSpeed * this.speed;
    if (mob.lookControlIdle !== false) {
      mob.yaw = approachAngle(mob.yaw, mob.moveYaw, 0.35);
    }

    // Jump for a rise, or when wedged against something at head height.
    if (this.ctx.aquatic || this.ctx.flies) {
      mob.vy += clamp(dy, -1, 1) * 0.02;
    } else if (dy > 0.4 && mob.onGround) {
      mob.jumping = true;
    } else if (mob.horizontalCollision && mob.onGround) {
      mob.jumping = true;
    }

    // Stuck detection: no real progress for a while means the path is stale.
    const moved = Math.hypot(mob.x - this.lastX, mob.z - this.lastZ);
    this.lastX = mob.x; this.lastZ = mob.z;
    if (moved < 0.008) {
      if (++this.stuckTicks > 40) { this.stop(); this.repathCooldown = 20; }
    } else if (this.stuckTicks > 0) {
      this.stuckTicks--;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers used by goals
// ---------------------------------------------------------------------------

const NEAR_SCRATCH = [];

/** Entities within `radius` of `mob` matching `filter`, nearest first. */
export function nearbyEntities(world, mob, radius, filter, out = []) {
  out.length = 0;
  const r2 = radius * radius;
  const list = world.entities;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e === mob || e.removed) continue;
    if (e.dead) continue;
    const dx = e.x - mob.x, dy = e.y - mob.y, dz = e.z - mob.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    if (filter && !filter(e)) continue;
    e.__d2 = d2;
    out.push(e);
  }
  out.sort((a, b) => a.__d2 - b.__d2);
  return out;
}

export function nearestEntity(world, mob, radius, filter) {
  let best = null, bestD = radius * radius;
  const list = world.entities;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e === mob || e.removed || e.dead) continue;
    const dx = e.x - mob.x, dy = e.y - mob.y, dz = e.z - mob.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= bestD) continue;
    if (filter && !filter(e)) continue;
    bestD = d2; best = e;
  }
  return best;
}

/** A random standable spot within (dx, dy, dz) of the mob, or null. */
export function randomPos(mob, dx = 10, dy = 7, dz = 10, biasX = 0, biasZ = 0) {
  const world = mob.world;
  const r = world.random;
  const ctx = pathContext(mob);
  for (let attempt = 0; attempt < 10; attempt++) {
    let x = Math.floor(mob.x) + r.intRange(-dx, dx);
    let z = Math.floor(mob.z) + r.intRange(-dz, dz);
    if (biasX || biasZ) {
      x = Math.floor(mob.x + biasX * (0.4 + r.next() * 0.8) + r.intRange(-3, 3));
      z = Math.floor(mob.z + biasZ * (0.4 + r.next() * 0.8) + r.intRange(-3, 3));
    }
    const y0 = Math.floor(mob.y) + r.intRange(-dy, dy);
    for (let d = 0; d <= 4; d++) {
      for (const y of (d === 0 ? [y0] : [y0 - d, y0 + d])) {
        if (standCost(world, x, y, z, ctx) >= 0) return { x, y, z };
      }
    }
  }
  return null;
}

/** A random water cell near the mob (used by fish and squid). */
export function randomWaterPos(mob, dx = 8, dy = 4) {
  const world = mob.world;
  const r = world.random;
  for (let attempt = 0; attempt < 12; attempt++) {
    const x = Math.floor(mob.x) + r.intRange(-dx, dx);
    const y = Math.floor(mob.y) + r.intRange(-dy, dy);
    const z = Math.floor(mob.z) + r.intRange(-dx, dx);
    if (isWater(world, x, y, z)) return { x, y, z };
  }
  return null;
}

export { standCost, passable, isWater, solidFloor };

// ---------------------------------------------------------------------------
// Movement goals
// ---------------------------------------------------------------------------

/** Wander to a random reachable spot every so often. */
export class RandomStrollGoal extends Goal {
  constructor(speed = 1, chance = 120, opts = {}) {
    super();
    this.flags = FLAG.MOVE;
    this.speed = speed;
    this.chance = chance;
    this.avoidWater = opts.avoidWater ?? true;
    this.range = opts.range ?? 10;
    this.dest = null;
    this.interval = 10;
  }

  canUse() {
    const mob = this.mob;
    if (mob.attackTarget) return false;
    if (this.random.int(this.chance) !== 0) return false;
    this.dest = randomPos(mob, this.range, 7, this.range);
    return this.dest !== null;
  }

  canContinue() { return !this.mob.navigator.isDone; }

  start() {
    if (this.dest) this.mob.navigator.moveTo(this.dest.x, this.dest.y, this.dest.z, this.speed);
  }

  stop() { this.mob.navigator.stop(); }
}

/** Swim aimlessly. Fish and squid use this instead of strolling. */
export class RandomSwimGoal extends Goal {
  constructor(speed = 1, chance = 60) {
    super();
    this.flags = FLAG.MOVE;
    this.speed = speed;
    this.chance = chance;
    this.dest = null;
    this.interval = 5;
  }

  canUse() {
    if (!this.mob.inWater) return false;
    if (this.random.int(this.chance) !== 0) return false;
    this.dest = randomWaterPos(this.mob);
    return this.dest !== null;
  }

  canContinue() { return !this.mob.navigator.isDone && this.mob.inWater; }
  start() { this.mob.navigator.moveTo(this.dest.x, this.dest.y, this.dest.z, this.speed); }
  stop() { this.mob.navigator.stop(); }
}

/** Keep a non-swimmer's head above water. */
export class FloatGoal extends Goal {
  constructor() { super(); this.flags = FLAG.JUMP; }
  canUse() { return this.mob.inWater || this.mob.inLava; }
  canContinue() { return this.canUse(); }
  tick() {
    if (this.random.chance(0.8)) this.mob.jumping = true;
    this.mob.fallDistance = 0;
  }
}

/** Run away after being hurt or set alight. */
export class PanicGoal extends Goal {
  constructor(speed = 1.25) {
    super();
    this.flags = FLAG.MOVE;
    this.speed = speed;
    this.dest = null;
  }

  shouldPanic() {
    const mob = this.mob;
    if (mob.fireTicks > 0) return true;
    return mob.lastHurtByTime > 0 &&
      (mob.world.tickCount - mob.lastHurtByTime) < 100;
  }

  canUse() {
    if (!this.shouldPanic()) return false;
    const mob = this.mob;
    const src = mob.lastHurtBy;
    const bx = src ? mob.x - src.x : 0;
    const bz = src ? mob.z - src.z : 0;
    this.dest = randomPos(mob, 12, 5, 12, bx, bz) ?? randomPos(mob, 8, 4, 8);
    return this.dest !== null;
  }

  canContinue() { return !this.mob.navigator.isDone; }
  start() {
    this.mob.panicking = true;
    this.mob.navigator.moveTo(this.dest.x, this.dest.y, this.dest.z, this.speed);
  }
  stop() { this.mob.panicking = false; this.mob.navigator.stop(); }
}

/** Charge the current target and hit it when in range. */
export class MeleeAttackGoal extends Goal {
  constructor(speed = 1, followWhenOutOfSight = true) {
    super();
    this.flags = FLAG.MOVE | FLAG.LOOK;
    this.speed = speed;
    this.follow = followWhenOutOfSight;
    this.repath = 0;
    this.cooldown = 0;
  }

  canUse() {
    const t = this.mob.attackTarget;
    return !!t && !t.removed && !t.dead;
  }

  canContinue() {
    const t = this.mob.attackTarget;
    if (!t || t.removed || t.dead) return false;
    if (this.mob.distanceToSq(t) > 32 * 32) return false;
    return this.follow || this.mob.canSee(t);
  }

  start() { this.repath = 0; this.mob.navigator.moveToEntity(this.mob.attackTarget, this.speed); }
  stop() { this.mob.navigator.stop(); this.mob.attackTicks = 0; }

  tick() {
    const mob = this.mob;
    const t = mob.attackTarget;
    if (!t) return;
    mob.lookAt(t.x, t.y + (t.eyeHeight ?? 1.5), t.z, 0.5, 0.5);
    if (--this.repath <= 0) {
      this.repath = 6 + this.random.int(6);
      mob.navigator.moveToEntity(t, this.speed);
    }
    if (this.cooldown > 0) this.cooldown--;
    const reach = mob.attackReach ?? (mob.width * mob.scale + t.width * 0.5 + 1.4);
    const dx = t.x - mob.x, dz = t.z - mob.z;
    const dy = Math.abs(t.y - mob.y);
    if (dx * dx + dz * dz <= reach * reach && dy < 2.2 && this.cooldown <= 0) {
      this.cooldown = mob.attackInterval ?? 20;
      if (mob.canSee(t)) mob.performAttack(t);
    }
  }
}

/** Keep distance while firing a projectile — the skeleton's strafing dance. */
export class RangedAttackGoal extends Goal {
  constructor(speed = 1, interval = 40, range = 15) {
    super();
    this.flags = FLAG.MOVE | FLAG.LOOK;
    this.speed = speed;
    this.interval = 0;
    this.attackInterval = interval;
    this.range = range;
    this.attackTime = -1;
    this.seeTime = 0;
    this.strafeTime = -1;
    this.strafeBack = false;
    this.strafeRight = false;
  }

  canUse() {
    const t = this.mob.attackTarget;
    return !!t && !t.removed && !t.dead;
  }
  canContinue() { return this.canUse(); }
  start() { this.attackTime = -1; }
  stop() {
    this.mob.navigator.stop();
    this.mob.strafeForward = 0;
    this.mob.strafeSide = 0;
    this.seeTime = 0;
  }

  tick() {
    const mob = this.mob;
    const t = mob.attackTarget;
    if (!t) return;
    const d2 = mob.distanceToSq(t);
    const canSee = mob.canSee(t);
    if (canSee) this.seeTime++; else this.seeTime = 0;

    if (d2 <= this.range * this.range && this.seeTime >= 5) {
      mob.navigator.stop();
      this.strafeTime++;
    } else {
      mob.navigator.moveToEntity(t, this.speed);
      this.strafeTime = -1;
    }

    if (this.strafeTime >= 20) {
      if (this.random.chance(0.3)) this.strafeRight = !this.strafeRight;
      if (this.random.chance(0.3)) this.strafeBack = !this.strafeBack;
      this.strafeTime = 0;
    }
    if (this.strafeTime > -1) {
      const near = d2 < (this.range * 0.75) * (this.range * 0.75);
      mob.moveForward = near ? -0.5 : 0.5;
      mob.moveStrafe = this.strafeRight ? 0.5 : -0.5;
      mob.moveYaw = Math.atan2(-(t.x - mob.x), t.z - mob.z);
    }

    mob.lookAt(t.x, t.y + (t.eyeHeight ?? 1.5), t.z, 0.6, 0.6);

    if (--this.attackTime === 0) {
      if (!canSee) return;
      const power = clamp(Math.sqrt(d2) / this.range, 0.1, 1);
      mob.performRangedAttack(t, power);
      this.attackTime = this.attackInterval;
    } else if (this.attackTime < 0) {
      this.attackTime = this.attackInterval;
    }
  }
}

/** Leap at the target from a short distance — spiders and wolves. */
export class LeapAtTargetGoal extends Goal {
  constructor(power = 0.4) {
    super();
    this.flags = FLAG.MOVE | FLAG.JUMP;
    this.power = power;
  }

  canUse() {
    const mob = this.mob;
    const t = mob.attackTarget;
    if (!t || !mob.onGround || mob.riding) return false;
    const d2 = mob.distanceToSq(t);
    if (d2 < 4 || d2 > 16) return false;
    return this.random.chance(0.08);
  }

  canContinue() { return !this.mob.onGround; }

  start() {
    const mob = this.mob;
    const t = mob.attackTarget;
    let dx = t.x - mob.x, dz = t.z - mob.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return;
    mob.vx += (dx / d) * 0.4 + mob.vx * 0.2;
    mob.vz += (dz / d) * 0.4 + mob.vz * 0.2;
    mob.vy = this.power;
  }
}

/** Babies stay near an adult of the same kind. */
export class FollowParentGoal extends Goal {
  constructor(speed = 1.1) {
    super();
    this.flags = FLAG.MOVE;
    this.speed = speed;
    this.parent = null;
    this.interval = 20;
  }

  canUse() {
    const mob = this.mob;
    if (!mob.baby) return false;
    this.parent = nearestEntity(mob.world, mob, 12,
      (e) => e.type === mob.type && !e.baby);
    return !!this.parent;
  }

  canContinue() {
    if (!this.parent || this.parent.removed) return false;
    const d2 = this.mob.distanceToSq(this.parent);
    return d2 > 9 && d2 < 256;
  }

  start() { this.mob.navigator.moveToEntity(this.parent, this.speed); }
  stop() { this.parent = null; this.mob.navigator.stop(); }
  tick() {
    if (this.mob.world.tickCount % 10 === 0 && this.parent) {
      this.mob.navigator.moveToEntity(this.parent, this.speed);
    }
  }
}

/** Two animals in love walk together and produce a baby. */
export class BreedGoal extends Goal {
  constructor(speed = 1) {
    super();
    this.flags = FLAG.MOVE | FLAG.LOOK;
    this.speed = speed;
    this.partner = null;
    this.timer = 0;
    this.interval = 10;
  }

  canUse() {
    const mob = this.mob;
    if (!mob.inLove) return false;
    this.partner = nearestEntity(mob.world, mob, 8,
      (e) => e.type === mob.type && e.inLove && !e.baby && e !== mob);
    return !!this.partner;
  }

  canContinue() {
    return this.partner && !this.partner.removed && this.partner.inLove &&
      this.timer < 60 && this.mob.inLove;
  }

  start() { this.timer = 0; }
  stop() { this.partner = null; this.timer = 0; this.mob.navigator.stop(); }

  tick() {
    const mob = this.mob;
    mob.lookAt(this.partner.x, this.partner.y + 0.5, this.partner.z, 0.5, 0.5);
    mob.navigator.moveToEntity(this.partner, this.speed);
    if (++this.timer >= 50 && mob.distanceToSq(this.partner) < 9) {
      mob.breedWith(this.partner);
      this.timer = 0;
    }
  }
}

/** Follow a player holding food this animal likes. */
export class TemptGoal extends Goal {
  constructor(speed = 1.1, items = [], canScare = true) {
    super();
    this.flags = FLAG.MOVE | FLAG.LOOK;
    this.speed = speed;
    this.items = new Set(items);
    this.canScare = canScare;
    this.player = null;
    this.cooldown = 0;
    this.interval = 5;
  }

  matches(stack) { return !!stack && this.items.has(stack.item?.name); }

  canUse() {
    if (this.cooldown > 0) { this.cooldown--; return false; }
    const mob = this.mob;
    this.player = nearestEntity(mob.world, mob, 10, (e) => e.isPlayer &&
      (this.matches(e.heldItem?.()) || this.matches(e.offhandItem?.())));
    return !!this.player;
  }

  canContinue() {
    if (!this.player || this.player.removed) return false;
    if (this.canScare && this.mob.distanceToSq(this.player) < 6.25 &&
      Math.hypot(this.player.vx, this.player.vz) > 0.25) return false;
    return this.matches(this.player.heldItem?.()) || this.matches(this.player.offhandItem?.());
  }

  start() { this.mob.tempted = true; }
  stop() {
    this.player = null;
    this.mob.tempted = false;
    this.mob.navigator.stop();
    this.cooldown = 100;
  }

  tick() {
    const mob = this.mob;
    mob.lookAt(this.player.eyeX ?? this.player.x, this.player.eyeY ?? this.player.y,
      this.player.eyeZ ?? this.player.z, 0.6, 0.6);
    if (mob.distanceToSq(this.player) < 6.25) mob.navigator.stop();
    else if (mob.world.tickCount % 8 === 0) mob.navigator.moveToEntity(this.player, this.speed);
  }
}

/** Run from a kind of entity (creepers from cats, villagers from zombies). */
export class AvoidEntityGoal extends Goal {
  constructor(filter, distance = 8, walkSpeed = 1, sprintSpeed = 1.3) {
    super();
    this.flags = FLAG.MOVE;
    this.filter = filter;
    this.distance = distance;
    this.walkSpeed = walkSpeed;
    this.sprintSpeed = sprintSpeed;
    this.threat = null;
    this.dest = null;
    this.interval = 5;
  }

  canUse() {
    const mob = this.mob;
    this.threat = nearestEntity(mob.world, mob, this.distance, this.filter);
    if (!this.threat) return false;
    this.dest = randomPos(mob, 16, 7, 16, mob.x - this.threat.x, mob.z - this.threat.z);
    if (!this.dest) return false;
    // Only run if the escape route actually increases the distance.
    const cur = mob.distanceToSq(this.threat);
    const dx = this.dest.x - this.threat.x, dz = this.dest.z - this.threat.z;
    return dx * dx + dz * dz > cur;
  }

  canContinue() { return !this.mob.navigator.isDone; }
  start() { this.mob.navigator.moveTo(this.dest.x, this.dest.y, this.dest.z, this.walkSpeed); }
  stop() { this.threat = null; this.mob.navigator.stop(); }
  tick() {
    const mob = this.mob;
    if (this.threat && mob.distanceToSq(this.threat) < 49) {
      mob.navigator.speed = this.sprintSpeed;
    } else {
      mob.navigator.speed = this.walkSpeed;
    }
  }
}

/** Follow the entity that tamed this one. */
export class FollowOwnerGoal extends Goal {
  constructor(speed = 1.1, min = 3, max = 20) {
    super();
    this.flags = FLAG.MOVE | FLAG.LOOK;
    this.speed = speed;
    this.min = min;
    this.max = max;
    this.interval = 10;
  }

  owner() {
    const mob = this.mob;
    if (!mob.ownerId || mob.sitting) return null;
    return mob.world.entitiesById.get(mob.ownerId) ?? null;
  }

  canUse() {
    const o = this.owner();
    if (!o) return false;
    return this.mob.distanceToSq(o) > this.min * this.min;
  }

  canContinue() {
    const o = this.owner();
    if (!o) return false;
    return this.mob.distanceToSq(o) > (this.min * this.min) * 0.6;
  }

  start() { this.mob.navigator.moveToEntity(this.owner(), this.speed); }
  stop() { this.mob.navigator.stop(); }

  tick() {
    const mob = this.mob;
    const o = this.owner();
    if (!o) return;
    mob.lookAt(o.x, o.y + 1.4, o.z, 0.5, 0.5);
    const d2 = mob.distanceToSq(o);
    // Teleport when hopelessly far behind, exactly like a real wolf.
    if (d2 > this.max * this.max * 4) {
      mob.moveTo(o.x + this.random.range(-1, 1), o.y, o.z + this.random.range(-1, 1));
      mob.navigator.stop();
      return;
    }
    if (mob.world.tickCount % 10 === 0) mob.navigator.moveToEntity(o, this.speed);
  }
}

/** Tamed animals stay put when told to sit. */
export class SitGoal extends Goal {
  constructor() { super(); this.flags = FLAG.MOVE | FLAG.JUMP; }
  canUse() { return !!this.mob.sitting; }
  canContinue() { return !!this.mob.sitting; }
  start() { this.mob.navigator.stop(); }
  tick() { this.mob.moveForward = 0; this.mob.moveStrafe = 0; this.mob.jumping = false; }
}

/** Sheep crop grass and turn it to dirt, regrowing their wool. */
export class EatGrassGoal extends Goal {
  constructor() { super(); this.flags = FLAG.MOVE | FLAG.LOOK; this.timer = 0; this.interval = 10; }

  canUse() {
    const mob = this.mob;
    if (mob.baby ? this.random.int(50) !== 0 : this.random.int(1000) !== 0) return false;
    return this.targetBlock() !== null;
  }

  targetBlock() {
    const mob = this.mob;
    const x = Math.floor(mob.x), y = Math.floor(mob.y), z = Math.floor(mob.z);
    const name = mob.world.getBlockName(x, y, z);
    if (name === 'short_grass' || name === 'grass' || name === 'tall_grass' ||
      name === 'fern') return { x, y, z, tall: true };
    if (mob.world.getBlockName(x, y - 1, z) === 'grass_block') {
      return { x, y: y - 1, z, tall: false };
    }
    return null;
  }

  canContinue() { return this.timer > 0; }
  start() { this.timer = 40; this.mob.eatTicks = 40; this.mob.navigator.stop(); }
  stop() { this.timer = 0; this.mob.eatTicks = 0; }

  tick() {
    this.timer--;
    this.mob.eatTicks = this.timer;
    if (this.timer !== 4) return;
    const t = this.targetBlock();
    if (!t) return;
    const world = this.mob.world;
    if (t.tall) {
      world.destroyBlock(t.x, t.y, t.z, false);
    } else if (blockOf(world.getBlock(t.x, t.y, t.z))?.name === 'grass_block') {
      const dirt = blocksByName.get('dirt');
      if (dirt) world.setBlock(t.x, t.y, t.z, dirt.defaultState);
    }
    world.spawnParticles('block_dust', this.mob.x, this.mob.y, this.mob.z, 8);
    this.mob.onAteGrass?.();
  }
}

// ---------------------------------------------------------------------------
// Look goals
// ---------------------------------------------------------------------------

export class LookAtPlayerGoal extends Goal {
  constructor(range = 8, chance = 0.02, targetFilter = null) {
    super();
    this.flags = FLAG.LOOK;
    this.range = range;
    this.chance = chance;
    this.filter = targetFilter;
    this.target = null;
    this.timer = 0;
    this.interval = 5;
  }

  canUse() {
    if (this.mob.attackTarget) {
      this.target = this.mob.attackTarget;
    } else {
      if (!this.random.chance(this.chance)) return false;
      this.target = nearestEntity(this.mob.world, this.mob, this.range,
        this.filter ?? ((e) => e.isPlayer));
    }
    return !!this.target;
  }

  canContinue() {
    if (!this.target || this.target.removed) return false;
    if (this.mob.distanceToSq(this.target) > this.range * this.range) return false;
    return this.timer > 0;
  }

  start() { this.timer = 40 + this.random.int(40); }
  stop() { this.target = null; }

  tick() {
    this.timer--;
    const t = this.target;
    this.mob.lookAt(t.x, (t.eyeY ?? t.y + t.height * 0.85), t.z, 0.4, 0.4);
  }
}

/** Idle head movement so a standing mob is never perfectly still. */
export class RandomLookGoal extends Goal {
  constructor() {
    super();
    this.flags = FLAG.LOOK;
    this.dx = 0; this.dz = 0;
    this.timer = 0;
    this.interval = 5;
  }

  canUse() { return this.random.chance(0.02); }
  canContinue() { return this.timer >= 0; }

  start() {
    const a = this.random.range(0, Math.PI * 2);
    this.dx = Math.cos(a);
    this.dz = Math.sin(a);
    this.timer = 20 + this.random.int(20);
  }

  tick() {
    this.timer--;
    this.mob.lookAt(this.mob.x + this.dx, this.mob.y + this.mob.eyeHeight,
      this.mob.z + this.dz, 0.2, 0.2);
  }
}

// ---------------------------------------------------------------------------
// Interaction goals
// ---------------------------------------------------------------------------

/** Open a door blocking the path, and (optionally) close it again behind. */
export class OpenDoorGoal extends Goal {
  constructor(closeAfter = true) {
    super();
    this.flags = 0;              // runs alongside movement
    this.closeAfter = closeAfter;
    this.door = null;
    this.timer = 0;
    this.interval = 4;
  }

  findDoor() {
    const mob = this.mob;
    const nav = mob.navigator;
    if (!nav.path) return null;
    const world = mob.world;
    for (let i = nav.index; i < Math.min(nav.path.length, nav.index + 2); i++) {
      const n = nav.path[i];
      for (let dy = 0; dy <= 1; dy++) {
        const st = world.getBlock(n.x, n.y + dy, n.z);
        const def = blockOf(st);
        if (def?.isDoor && !def.name.startsWith('iron')) {
          return { x: n.x, y: n.y + dy, z: n.z, state: st, def };
        }
      }
    }
    return null;
  }

  canUse() {
    if (!this.mob.canOpenDoors) return false;
    this.door = this.findDoor();
    return !!this.door;
  }

  canContinue() { return this.timer > 0; }

  start() {
    this.timer = 20;
    const d = this.door;
    const world = this.mob.world;
    try { d.def.onUse?.(world, d.x, d.y, d.z, world.getBlock(d.x, d.y, d.z), this.mob); }
    catch { /* door content may be partial */ }
  }

  tick() { this.timer--; }

  stop() {
    if (!this.closeAfter || !this.door) { this.door = null; return; }
    const d = this.door;
    const world = this.mob.world;
    try { d.def.onUse?.(world, d.x, d.y, d.z, world.getBlock(d.x, d.y, d.z), this.mob); }
    catch { /* ignore */ }
    this.door = null;
  }
}

// ---------------------------------------------------------------------------
// Target goals
// ---------------------------------------------------------------------------

/** Fight back against whatever hurt us, and optionally call for help. */
export class HurtByTargetGoal extends Goal {
  constructor(alertSameType = false, alertTypes = []) {
    super();
    this.flags = FLAG.TARGET;
    this.alertSameType = alertSameType;
    this.alertTypes = new Set(alertTypes);
    this.timestamp = 0;
  }

  canUse() {
    const mob = this.mob;
    const by = mob.lastHurtBy;
    if (!by || by.removed || by.dead) return false;
    if (by === mob) return false;
    if (mob.lastHurtByTime === this.timestamp) return false;
    return true;
  }

  start() {
    const mob = this.mob;
    this.timestamp = mob.lastHurtByTime;
    mob.setTarget(mob.lastHurtBy);
    if (this.alertSameType || this.alertTypes.size) this.alertOthers();
  }

  alertOthers() {
    const mob = this.mob;
    const found = nearbyEntities(mob.world, mob, 12, (e) =>
      (this.alertSameType && e.type === mob.type) || this.alertTypes.has(e.type));
    for (const other of found) {
      if (other.attackTarget || !other.setTarget) continue;
      if (other.baby) continue;
      other.setTarget(mob.lastHurtBy);
    }
    found.length = 0;
  }
}

/** Acquire the nearest matching entity as a target. */
export class NearestAttackableTargetGoal extends Goal {
  constructor(filter, range = 16, opts = {}) {
    super();
    this.flags = FLAG.TARGET;
    this.filter = filter;
    this.range = range;
    this.requiresSight = opts.requiresSight ?? true;
    this.chance = opts.chance ?? 1;
    this.interval = opts.interval ?? 10;
    this.target = null;
  }

  canUse() {
    const mob = this.mob;
    if (this.chance < 1 && !this.random.chance(this.chance)) return false;
    this.target = nearestEntity(mob.world, mob, this.range, (e) => {
      if (!this.filter(e)) return false;
      if (this.requiresSight && !mob.canSee(e)) return false;
      return true;
    });
    return !!this.target;
  }

  canContinue() {
    const t = this.mob.attackTarget;
    if (!t || t.removed || t.dead) return false;
    if (t.isPlayer && (t.gamemode === 1 || t.gamemode === 3)) return false;
    const d2 = this.mob.distanceToSq(t);
    if (d2 > (this.range + 8) * (this.range + 8)) return false;
    return true;
  }

  start() { this.mob.setTarget(this.target); }
  stop() { this.mob.setTarget(null); this.target = null; }
}

/** Target players who are looking at this mob — the enderman's aggression. */
export class LookedAtTargetGoal extends Goal {
  constructor(range = 64) {
    super();
    this.flags = FLAG.TARGET;
    this.range = range;
    this.target = null;
    this.interval = 5;
  }

  isStaring(player) {
    const mob = this.mob;
    const dx = mob.x - player.x;
    const dy = (mob.y + mob.eyeHeight) - (player.eyeY ?? player.y + 1.6);
    const dz = mob.z - player.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return false;
    const look = player.lookVector ? player.lookVector(LOOK_SCRATCH) : null;
    if (!look) return false;
    const dot = (look.x * dx + look.y * dy + look.z * dz) / len;
    // Roughly a 5-degree cone, scaled by distance as in the real game.
    return dot > 1 - 0.025 / Math.max(1, len / 8) && mob.canSee(player);
  }

  canUse() {
    const mob = this.mob;
    this.target = nearestEntity(mob.world, mob, this.range,
      (e) => e.isPlayer && e.gamemode !== 1 && e.gamemode !== 3 && this.isStaring(e));
    return !!this.target;
  }

  canContinue() {
    const t = this.mob.attackTarget;
    return !!t && !t.removed && !t.dead && this.mob.distanceToSq(t) < 64 * 64;
  }

  start() {
    this.mob.setTarget(this.target);
    this.mob.onProvoked?.(this.target);
  }
  stop() { this.mob.setTarget(null); }
}

const LOOK_SCRATCH = {};

/** Defend a category of entity: iron golems protecting villagers. */
export class DefendEntityGoal extends Goal {
  constructor(protectedFilter, attackerFilter, range = 16) {
    super();
    this.flags = FLAG.TARGET;
    this.protectedFilter = protectedFilter;
    this.attackerFilter = attackerFilter;
    this.range = range;
    this.target = null;
    this.interval = 10;
  }

  canUse() {
    const mob = this.mob;
    const friends = nearbyEntities(mob.world, mob, this.range, this.protectedFilter, NEAR_SCRATCH);
    for (const f of friends) {
      const by = f.lastHurtBy;
      if (!by || by.removed || by.dead) continue;
      if ((mob.world.tickCount - (f.lastHurtByTime ?? 0)) > 200) continue;
      if (!this.attackerFilter(by)) continue;
      this.target = by;
      NEAR_SCRATCH.length = 0;
      return true;
    }
    NEAR_SCRATCH.length = 0;
    return false;
  }

  canContinue() {
    const t = this.mob.attackTarget;
    return !!t && !t.removed && !t.dead && this.mob.distanceToSq(t) < 40 * 40;
  }

  start() { this.mob.setTarget(this.target); }
  stop() { this.mob.setTarget(null); }
}

/** Sit still and stare (shulkers, guardians) while still acquiring targets. */
export class StareAtTargetGoal extends Goal {
  constructor() { super(); this.flags = FLAG.LOOK; }
  canUse() { return !!this.mob.attackTarget; }
  tick() {
    const t = this.mob.attackTarget;
    if (t) this.mob.lookAt(t.x, t.y + 1, t.z, 0.35, 0.35);
  }
}
