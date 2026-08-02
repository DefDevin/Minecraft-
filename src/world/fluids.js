// Fluids and fire.
//
// Water and lava are cellular: every fluid cell re-derives its own level from
// its neighbours on a scheduled tick, then hands the flow on. Nothing keeps a
// global list of "flows", which is what lets a lake fill a cave without any
// bookkeeping — and what lets the whole system pick up where it left off after
// a chunk reloads.
//
// Levels run 0..7. Level 0 is a source; higher numbers are thinner flows, and a
// cell whose computed level would exceed 7 dries up. Water thins by one per
// block (so it reaches seven), lava by two in the overworld (three blocks) and
// by one in the Nether (seven). A flow with the same fluid directly above it is
// *falling*: it renders as a full block and spreads sideways as though it were
// a source, which is why a waterfall still runs seven blocks across the floor.

import {
  T, blockOf, getProp, withProp, stateOf, blocksByName, PUSH,
} from './blocks.js';
import { FLAG } from './world.js';
import { FACES, HORIZONTAL } from '../core/math.js';

export const WATER = 1;
export const LAVA = 2;

/** Highest level a flow may reach before it dries up. */
export const MAX_LEVEL = 7;

/** Ticks between updates of one fluid cell. */
export function tickRate(world, fluid) {
  if (fluid === WATER) return 5;
  return world.dimension === 'nether' ? 10 : 30;
}

/** How much a flow thins per block travelled. */
export function decayRate(world, fluid) {
  if (fluid === WATER) return 1;
  return world.dimension === 'nether' ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Block lookups, resolved lazily (the registry is not frozen at import time)
// ---------------------------------------------------------------------------

let CACHE = null;
function B() {
  if (!CACHE) {
    const get = (n) => blocksByName.get(n) || null;
    CACHE = {
      water: get('water'), lava: get('lava'), fire: get('fire'),
      obsidian: get('obsidian'), cobblestone: get('cobblestone'),
      stone: get('stone'), basalt: get('basalt'),
      wetSponge: get('wet_sponge'),
      cauldron: get('cauldron'), waterCauldron: get('water_cauldron'),
      lavaCauldron: get('lava_cauldron'),
    };
  }
  return CACHE;
}

const idOf = (block, props) => (block ? (props ? stateOf(block, props) : block.defaultState) : 0);

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Is the same fluid sitting directly on top? Then this cell is falling. */
function fedFromAbove(world, x, y, z, fluid) {
  return T.fluid[world.getBlock(x, y + 1, z)] === fluid;
}

/** Level a cell counts as when it feeds its horizontal neighbours. */
function effectiveLevel(world, x, y, z, state, fluid) {
  if (fedFromAbove(world, x, y, z, fluid)) return 0;
  return T.fluidLevel[state];
}

/**
 * Can this fluid move into the cell? Air and other fluids yes; solid blocks no;
 * plants, torches and snow are washed away; stairs, slabs and fences take the
 * water inside themselves instead.
 */
function canFlowInto(world, x, y, z, fluid) {
  const state = world.getBlock(x, y, z);
  if (state === 0) return true;
  if (T.fluid[state] === fluid) return false;   // handled by the level compare
  if (T.fluid[state] !== 0) return true;        // the other fluid: they react
  const def = blockOf(state);
  if (!def) return false;
  if (fluid === WATER && def.stateDef.has('waterlogged')) {
    return getProp(state, 'waterlogged') !== true;
  }
  if (T.solid[state] === 1) return false;
  if (T.replaceable[state] === 1) return true;
  return def.push === PUSH.DESTROY;             // plants, dust, torches
}

/** Write a flow into a cell, waterlogging it or breaking what is in the way. */
function setFlow(world, x, y, z, fluid, level) {
  const existing = world.getBlock(x, y, z);
  const def = blockOf(existing);

  if (fluid === WATER && def && def.stateDef.has('waterlogged')) {
    if (getProp(existing, 'waterlogged') !== true) {
      world.setBlock(x, y, z, withProp(existing, 'waterlogged', true), FLAG.DEFAULT);
    }
    return false;
  }
  if (existing !== 0 && T.fluid[existing] === 0) {
    // Water carries loose blocks away rather than swallowing them silently.
    if (def && (def.push === PUSH.DESTROY || T.replaceable[existing] === 1)) {
      if (def.push === PUSH.DESTROY) world.destroyBlock(x, y, z, true);
    }
  }
  const block = fluid === WATER ? B().water : B().lava;
  if (!block) return false;
  const state = stateOf(block, { level });
  if (world.getBlock(x, y, z) === state) return false;
  world.setBlock(x, y, z, state, FLAG.DEFAULT);
  world.scheduleTick(x, y, z, block, tickRate(world, fluid));
  return true;
}

// ---------------------------------------------------------------------------
// The fluid tick
// ---------------------------------------------------------------------------

/**
 * Advance one fluid cell. Wired to `onScheduledTick` on both water and lava.
 */
export function tick(world, x, y, z, state) {
  const fluid = T.fluid[state];
  if (!fluid) return false;
  const block = blockOf(state);
  const level = T.fluidLevel[state];
  const decay = decayRate(world, fluid);

  // A flow (never a source) re-derives its own depth from what feeds it.
  if (level > 0) {
    // Two sources either side turn a flow into a source of its own — the rule
    // that makes a two-bucket water hole infinite.
    if (fluid === WATER && promoteToSource(world, x, y, z)) return true;
    const derived = deriveLevel(world, x, y, z, fluid, decay);
    if (derived < 0) {
      world.setBlock(x, y, z, 0, FLAG.DEFAULT);
      return true;
    }
    if (derived !== level) {
      state = withProp(state, 'level', derived);
      world.setBlock(x, y, z, state, FLAG.DEFAULT);
      world.scheduleTick(x, y, z, block, tickRate(world, fluid));
      return true;
    }
  }

  if (reactWithOtherFluid(world, x, y, z, state, fluid)) return true;
  if (fluid === LAVA) spreadFireFromLava(world, x, y, z, world.random);

  // Falling beats spreading: while there is somewhere to fall, a fluid stays
  // put rather than creeping sideways.
  const belowState = world.getBlock(x, y - 1, z);
  if (T.fluid[belowState] !== 0 && T.fluid[belowState] !== fluid) {
    reactAt(world, x, y - 1, z, fluid);
  } else if (canFlowInto(world, x, y - 1, z, fluid)) {
    setFlow(world, x, y - 1, z, fluid, Math.min(MAX_LEVEL, decay));
    return true;
  }

  const eff = effectiveLevel(world, x, y, z, state, fluid);
  const next = eff + decay;
  if (next > MAX_LEVEL) return false;

  let spread = false;
  for (let dir = 0; dir < 4; dir++) {
    const d = HORIZONTAL[dir];
    const nx = x + d.dx, nz = z + d.dz;
    const ns = world.getBlock(nx, y, nz);
    if (T.fluid[ns] === fluid) {
      // Already the same fluid: only deepen it if we are the stronger source.
      if (T.fluidLevel[ns] > next && !fedFromAbove(world, nx, y, nz, fluid)) {
        world.setBlock(nx, y, nz, withProp(ns, 'level', next), FLAG.DEFAULT);
        world.scheduleTick(nx, y, nz, blockOf(ns), tickRate(world, fluid));
        spread = true;
      }
      continue;
    }
    if (!canFlowInto(world, nx, y, nz, fluid)) continue;
    if (T.fluid[ns] !== 0) { reactAt(world, nx, y, nz, fluid); continue; }
    if (setFlow(world, nx, y, nz, fluid, next)) spread = true;
  }
  return spread;
}

/**
 * Depth a flow should have, from the shallowest thing feeding it.
 * @returns -1 when nothing feeds it any more and it should disappear.
 */
function deriveLevel(world, x, y, z, fluid, decay) {
  if (fedFromAbove(world, x, y, z, fluid)) return Math.min(MAX_LEVEL, decay);
  let best = MAX_LEVEL + 1;
  for (let dir = 0; dir < 4; dir++) {
    const d = HORIZONTAL[dir];
    const ns = world.getBlock(x + d.dx, y, z + d.dz);
    if (T.fluid[ns] !== fluid) continue;
    const eff = effectiveLevel(world, x + d.dx, y, z + d.dz, ns, fluid);
    if (eff + decay < best) best = eff + decay;
  }
  if (best > MAX_LEVEL) return -1;
  return best;
}

/**
 * Two source blocks either side of a flow turn it into a source of its own —
 * the rule that makes a two-bucket water hole infinite.
 */
function promoteToSource(world, x, y, z) {
  let sources = 0;
  for (let dir = 0; dir < 4; dir++) {
    const d = HORIZONTAL[dir];
    const ns = world.getBlock(x + d.dx, y, z + d.dz);
    if (T.fluid[ns] === WATER && T.fluidLevel[ns] === 0) sources++;
  }
  if (sources < 2) return false;
  const below = world.getBlock(x, y - 1, z);
  const supported = T.solid[below] === 1 ||
    (T.fluid[below] === WATER && T.fluidLevel[below] === 0);
  if (!supported) return false;
  world.setBlock(x, y, z, idOf(B().water, { level: 0 }), FLAG.DEFAULT);
  return true;
}

// ---------------------------------------------------------------------------
// Water meets lava
// ---------------------------------------------------------------------------

/**
 * Lava turns to stone when the two fluids touch: obsidian where the lava is a
 * source, stone where water falls onto flowing lava, cobblestone otherwise.
 */
function reactWithOtherFluid(world, x, y, z, state, fluid) {
  if (fluid === WATER) {
    // Water never solidifies itself; it resolves whatever lava it has reached.
    for (let f = 0; f < 6; f++) {
      const d = FACES[f];
      if (T.fluid[world.getBlock(x + d.dx, y + d.dy, z + d.dz)] === LAVA) {
        reactAt(world, x + d.dx, y + d.dy, z + d.dz, WATER);
      }
    }
    return false;
  }

  // Lava: look for water on any side or directly above.
  let touching = false, above = false;
  for (let f = 0; f < 6; f++) {
    const d = FACES[f];
    if (T.fluid[world.getBlock(x + d.dx, y + d.dy, z + d.dz)] !== WATER) continue;
    touching = true;
    if (f === 3) above = true;
  }
  if (!touching) return false;
  return solidify(world, x, y, z, state, above);
}

/** Resolve the lava cell at (x,y,z) that water has just reached. */
function reactAt(world, x, y, z, incoming) {
  const state = world.getBlock(x, y, z);
  if (incoming === WATER && T.fluid[state] === LAVA) {
    const above = T.fluid[world.getBlock(x, y + 1, z)] === WATER;
    return solidify(world, x, y, z, state, above);
  }
  if (incoming === LAVA && T.fluid[state] === WATER) {
    // Lava running into water leaves cobblestone behind it.
    world.setBlock(x, y, z, idOf(B().cobblestone), FLAG.DEFAULT);
    hiss(world, x, y, z);
    return true;
  }
  return false;
}

function solidify(world, x, y, z, state, waterAbove) {
  const source = T.fluidLevel[state] === 0;
  let result;
  if (source) result = idOf(B().obsidian);
  else if (waterAbove) result = idOf(B().stone);
  else result = idOf(B().cobblestone);
  if (!result) return false;
  world.setBlock(x, y, z, result, FLAG.DEFAULT);
  hiss(world, x, y, z);
  return true;
}

function hiss(world, x, y, z) {
  world.playSound('fizz', x + 0.5, y + 0.5, z + 0.5, 0.5, 2.6);
  world.spawnParticles('smoke', x + 0.5, y + 1, z + 0.5, 8);
}

// ---------------------------------------------------------------------------
// Sponges
// ---------------------------------------------------------------------------

/**
 * A sponge drinks up to 65 water blocks within six of itself, then turns wet.
 * Breadth-first so it soaks the nearest water rather than a random spur.
 */
export function absorb(world, x, y, z) {
  const queue = [[x, y, z, 0]];
  const seen = new Set([`${x},${y},${z}`]);
  let taken = 0;

  while (queue.length && taken < 65) {
    const [cx, cy, cz, dist] = queue.shift();
    if (dist >= 6) continue;
    for (let f = 0; f < 6; f++) {
      const d = FACES[f];
      const nx = cx + d.dx, ny = cy + d.dy, nz = cz + d.dz;
      const k = `${nx},${ny},${nz}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const st = world.getBlock(nx, ny, nz);
      if (T.fluid[st] === WATER) {
        world.setBlock(nx, ny, nz, 0, FLAG.DEFAULT);
        taken++;
        queue.push([nx, ny, nz, dist + 1]);
        if (taken >= 65) break;
      } else if (T.waterlogged[st] === 1) {
        world.setBlock(nx, ny, nz, withProp(st, 'waterlogged', false), FLAG.DEFAULT);
        taken++;
        queue.push([nx, ny, nz, dist + 1]);
      } else if (st === 0) {
        queue.push([nx, ny, nz, dist + 1]);
      }
    }
  }

  if (taken > 0 && B().wetSponge) {
    world.setBlock(x, y, z, idOf(B().wetSponge), FLAG.DEFAULT);
    world.playSound('block.sponge_absorb', x + 0.5, y + 0.5, z + 0.5);
  }
  return taken;
}

// ---------------------------------------------------------------------------
// Cauldrons
// ---------------------------------------------------------------------------

/**
 * Bucket and bottle interaction with a cauldron. Returns true when the click
 * was consumed.
 */
export function useCauldron(world, x, y, z, state, player, hand) {
  const stack = hand?.item ? hand : (player?.heldItem?.() ?? null);
  const name = stack?.item?.name;
  if (!name) return false;
  const def = blockOf(state);
  const level = def.stateDef.has('level') ? getProp(state, 'level') : 3;
  const contents = def.cauldronContents || null;

  const swap = (to) => {
    if (player && player.gamemode !== 1 && stack) {
      stack.count--;
      if (stack.count <= 0) player.inventory?.setSelected?.(null);
      if (to) world.game?.drops?.spawnItem?.(world, x, y + 1, z, to, 1);
    }
  };

  if (name === 'water_bucket' && contents !== 'water') {
    world.setBlock(x, y, z, stateOf(B().waterCauldron, { level: 3 }), FLAG.DEFAULT);
    world.playSound('bucket.empty', x + 0.5, y + 0.5, z + 0.5);
    swap('bucket');
    return true;
  }
  if (name === 'lava_bucket' && !contents) {
    world.setBlock(x, y, z, idOf(B().lavaCauldron), FLAG.DEFAULT);
    world.playSound('bucket.empty_lava', x + 0.5, y + 0.5, z + 0.5);
    swap('bucket');
    return true;
  }
  if (name === 'bucket' && contents === 'water' && level >= 3) {
    world.setBlock(x, y, z, idOf(B().cauldron), FLAG.DEFAULT);
    world.playSound('bucket.fill', x + 0.5, y + 0.5, z + 0.5);
    swap('water_bucket');
    return true;
  }
  if (name === 'bucket' && contents === 'lava') {
    world.setBlock(x, y, z, idOf(B().cauldron), FLAG.DEFAULT);
    world.playSound('bucket.fill_lava', x + 0.5, y + 0.5, z + 0.5);
    swap('lava_bucket');
    return true;
  }
  if (name === 'glass_bottle' && contents === 'water') {
    const next = level - 1;
    world.setBlock(x, y, z, next <= 0
      ? idOf(B().cauldron)
      : stateOf(B().waterCauldron, { level: next }), FLAG.DEFAULT);
    world.playSound('bottle.fill', x + 0.5, y + 0.5, z + 0.5);
    swap('potion');
    return true;
  }
  if (name === 'potion' && (contents === 'water' ? level < 3 : !contents)) {
    const next = contents === 'water' ? Math.min(3, level + 1) : 1;
    world.setBlock(x, y, z, stateOf(B().waterCauldron, { level: next }), FLAG.DEFAULT);
    world.playSound('bottle.empty', x + 0.5, y + 0.5, z + 0.5);
    swap('glass_bottle');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------

/** Encouragement (spread) and flammability (catch) for a block, 0 when inert. */
function burnRates(state) {
  const def = blockOf(state);
  if (!def) return null;
  if (!def.flammable && !def.burnTime) return null;
  return { spread: def.burnTime || 0, catch: def.flammable || 0 };
}

function hasFlammableNeighbor(world, x, y, z) {
  for (let f = 0; f < 6; f++) {
    const d = FACES[f];
    if (burnRates(world.getBlock(x + d.dx, y + d.dy, z + d.dz))) return true;
  }
  return false;
}

/** Light a fire at (x,y,z) if anything there will hold one. */
export function trySpreadFire(world, x, y, z) {
  const fire = B().fire;
  if (!fire) return false;
  const here = world.getBlock(x, y, z);
  if (here !== 0 && T.replaceable[here] !== 1) return false;
  if (T.fluid[here] !== 0) return false;
  const below = world.getBlock(x, y - 1, z);
  if (T.solid[below] !== 1 && !hasFlammableNeighbor(world, x, y, z)) return false;
  world.setBlock(x, y, z, fire.defaultState, FLAG.DEFAULT);
  world.playSound('fire.ignite', x + 0.5, y + 0.5, z + 0.5);
  return true;
}

/**
 * One random tick of a fire block: it ages, eats what it is standing on, and
 * jumps to nearby flammable blocks. Rain and a lack of fuel put it out.
 */
export function tickFire(world, x, y, z, state, random) {
  const r = random || world.random;
  const fire = blockOf(state);
  const age = getProp(state, 'age') | 0;
  const belowName = world.getBlockName(x, y - 1, z);
  const everlasting = belowName === 'netherrack' || belowName === 'magma_block';
  const onSolid = T.solid[world.getBlock(x, y - 1, z)] === 1;

  if (world.isRainingAt(x, y, z) && r.chance(0.2)) {
    world.setBlock(x, y, z, 0, FLAG.DEFAULT);
    return true;
  }
  if (!everlasting && !onSolid && !hasFlammableNeighbor(world, x, y, z)) {
    world.setBlock(x, y, z, 0, FLAG.DEFAULT);
    return true;
  }
  if (age < 15 && r.chance(0.6)) {
    world.setBlock(x, y, z, withProp(state, 'age', age + 1), FLAG.MARK_DIRTY);
  }
  if (!everlasting && age === 15 && !hasFlammableNeighbor(world, x, y, z) && r.chance(0.25)) {
    world.setBlock(x, y, z, 0, FLAG.DEFAULT);
    return true;
  }

  // Burn the six blocks touching the flame.
  for (let f = 0; f < 6; f++) {
    const d = FACES[f];
    const nx = x + d.dx, ny = y + d.dy, nz = z + d.dz;
    const rates = burnRates(world.getBlock(nx, ny, nz));
    if (!rates || rates.catch <= 0) continue;
    if (!r.chance(rates.catch / (f === 3 ? 250 : 300))) continue;
    if (r.chance(0.25) && !world.isRainingAt(nx, ny, nz)) {
      world.setBlock(nx, ny, nz, fire.defaultState, FLAG.DEFAULT);
    } else {
      world.setBlock(nx, ny, nz, 0, FLAG.DEFAULT);
    }
  }

  // …and try to jump a short distance to anything encouraging it.
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 4; dy++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (world.getBlock(nx, ny, nz) !== 0) continue;
        let encouragement = 0;
        for (let f = 0; f < 6; f++) {
          const d = FACES[f];
          const rates = burnRates(world.getBlock(nx + d.dx, ny + d.dy, nz + d.dz));
          if (rates) encouragement = Math.max(encouragement, rates.spread);
        }
        if (encouragement <= 0) continue;
        const chance = (encouragement + 40) / (300 + (dy > 1 ? (dy - 1) * 100 : 0));
        if (chance > r.next() * (age + 30)) {
          world.setBlock(nx, ny, nz, fire.defaultState, FLAG.DEFAULT);
        }
      }
    }
  }
  return true;
}

/** Lava sets light to whatever is sitting near it. */
export function spreadFireFromLava(world, x, y, z, random) {
  const r = random || world.random;
  if (world.dimension !== 'nether' && !r.oneIn(3)) return false;
  for (let i = 0; i < 3; i++) {
    const nx = x + r.intRange(-1, 1);
    const ny = y + r.intRange(0, 3);
    const nz = z + r.intRange(-1, 1);
    if (world.getBlock(nx, ny, nz) !== 0) continue;
    // Only if something around that cell can actually catch.
    if (!hasFlammableNeighbor(world, nx, ny, nz)) continue;
    if (trySpreadFire(world, nx, ny, nz)) return true;
  }
  return false;
}

export { canFlowInto, setFlow, promoteToSource, hasFlammableNeighbor };
