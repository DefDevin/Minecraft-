// Factories and shared behaviour for the block registry.
//
// Every "shape family" in Minecraft — stairs, slabs, walls, fences, doors,
// buttons — has identical state properties, models, collision and interaction
// logic across dozens of materials. Building them from one factory each is the
// only way ~500 blocks stay reviewable, and it guarantees that (say) every
// stair in the game corners the same way.
//
// Model geometry is derived from the collision shape wherever the two agree
// (which is all of the above), so a shape is described exactly once.

import {
  defineBlock, getBlock, id, RENDER, PASS, TINT, SOUND, TOOL, TIER, PUSH,
  box, faceTextures, T, blockOf, PROP, getProp, withProp, stateOf,
} from '../blocks.js';
import * as SHAPE from '../shapes.js';
import { AABB, HORIZONTAL, HORIZ_TO_FACE, FACES } from '../../core/math.js';
import { MAP, DIRS, FACING_INDEX } from './data.js';

// ---------------------------------------------------------------------------
// Registration plumbing
// ---------------------------------------------------------------------------

/**
 * Register a block and stamp extra, registry-private fields onto it.
 *
 * `Block` only copies the option keys it knows about, so grouping data used by
 * the connection logic (`fenceGroup`, `paneGroup`, …) has to be assigned after
 * construction rather than passed through `opts`.
 */
export function def(name, opts = {}, extra = null) {
  const b = defineBlock(name, opts);
  if (extra) Object.assign(b, extra);
  return b;
}

/**
 * Creative tab for blocks that must never appear in the menu — air, wall
 * variants, piston heads, portal interiors. `Block` defaults an *undefined*
 * tab to 'building' via `??`, and `null` reads as undefined for that operator,
 * so a real sentinel value is the only way to opt out.
 */
export const HIDDEN = 'hidden';

const stateCache = new Map();
/** Cached default state id for a block name — hooks reference blocks by name. */
export function st(name) {
  let s = stateCache.get(name);
  if (s === undefined) { s = id(name); stateCache.set(name, s); }
  return s;
}

/** Blocks whose light emission varies per state (candles, lit furnaces, …). */
const perStateLight = [];

/**
 * Give a block a per-state light emission.
 *
 * `freezeBlocks` fills `T.light` from the single `lightEmission` field, which
 * cannot express "a lit furnace glows but an unlit one does not". Rather than
 * change blocks.js we patch the table afterwards; `applyStateLight` runs at the
 * end of registerAllBlocks().
 */
export function stateLight(block, fn) {
  block.lightFor = fn;
  block.lightEmission = Math.max(block.lightEmission, fn(block.defaultState));
  perStateLight.push(block);
  return block;
}

/** Patch T.light for every block registered through `stateLight`. */
export function applyStateLight(tables) {
  for (const b of perStateLight) {
    for (let i = 0; i < b.stateCount; i++) {
      tables.light[b.base + i] = b.lightFor(b.base + i) | 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Material presets
// ---------------------------------------------------------------------------

export const MAT = Object.freeze({
  stone: {
    hardness: 1.5, blastResistance: 6, tool: TOOL.PICKAXE, tier: TIER.WOOD,
    requiresTool: true, sound: SOUND.STONE, mapColor: MAP.stone,
  },
  deepslate: {
    hardness: 3, blastResistance: 6, tool: TOOL.PICKAXE, tier: TIER.WOOD,
    requiresTool: true, sound: SOUND.STONE, mapColor: MAP.deepslate,
  },
  netherrack: {
    hardness: 0.4, blastResistance: 0.4, tool: TOOL.PICKAXE, tier: TIER.WOOD,
    requiresTool: true, sound: SOUND.NETHER, mapColor: MAP.netherrack,
  },
  netherBrick: {
    hardness: 2, blastResistance: 6, tool: TOOL.PICKAXE, tier: TIER.WOOD,
    requiresTool: true, sound: SOUND.NETHER, mapColor: MAP.netherrack,
  },
  metal: {
    hardness: 5, blastResistance: 6, tool: TOOL.PICKAXE, tier: TIER.STONE,
    requiresTool: true, sound: SOUND.METAL, mapColor: MAP.metal,
  },
  wood: {
    hardness: 2, blastResistance: 3, tool: TOOL.AXE, tier: TIER.HAND,
    requiresTool: false, sound: SOUND.WOOD, mapColor: MAP.wood,
    flammable: 5, burnTime: 20, fuelTicks: 300,
  },
  log: {
    hardness: 2, blastResistance: 2, tool: TOOL.AXE, sound: SOUND.WOOD,
    mapColor: MAP.wood, flammable: 5, burnTime: 5, fuelTicks: 300,
  },
  netherWood: {
    hardness: 2, blastResistance: 3, tool: TOOL.AXE, sound: SOUND.WOOD,
    mapColor: MAP.crimsonStem,
  },
  dirt: {
    hardness: 0.5, blastResistance: 0.5, tool: TOOL.SHOVEL,
    sound: SOUND.GRAVEL, mapColor: MAP.dirt,
  },
  grass: {
    hardness: 0.6, blastResistance: 0.6, tool: TOOL.SHOVEL,
    sound: SOUND.GRASS, mapColor: MAP.grass,
  },
  sand: {
    hardness: 0.5, blastResistance: 0.5, tool: TOOL.SHOVEL,
    sound: SOUND.SAND, mapColor: MAP.sand, gravity: true,
  },
  gravel: {
    hardness: 0.6, blastResistance: 0.6, tool: TOOL.SHOVEL,
    sound: SOUND.GRAVEL, mapColor: MAP.stone, gravity: true,
  },
  wool: {
    hardness: 0.8, blastResistance: 0.8, tool: TOOL.SHEARS, sound: SOUND.CLOTH,
    mapColor: MAP.wool, flammable: 30, burnTime: 60,
  },
  glass: {
    hardness: 0.3, blastResistance: 0.3, tool: TOOL.NONE, sound: SOUND.GLASS,
    mapColor: MAP.none,
  },
  plant: {
    hardness: 0, blastResistance: 0, tool: TOOL.NONE, sound: SOUND.GRASS,
    mapColor: MAP.plant, flammable: 60, burnTime: 100,
  },
  leaves: {
    hardness: 0.2, blastResistance: 0.2, tool: TOOL.HOE, sound: SOUND.GRASS,
    mapColor: MAP.plant, flammable: 30, burnTime: 60,
  },
  ice: {
    hardness: 0.5, blastResistance: 0.5, tool: TOOL.PICKAXE, sound: SOUND.GLASS,
    mapColor: MAP.ice, slipperiness: 0.98,
  },
  snow: {
    hardness: 0.2, blastResistance: 0.2, tool: TOOL.SHOVEL, requiresTool: true,
    sound: SOUND.SNOW, mapColor: MAP.snow,
  },
  terracotta: {
    hardness: 1.25, blastResistance: 4.2, tool: TOOL.PICKAXE, tier: TIER.WOOD,
    requiresTool: true, sound: SOUND.STONE, mapColor: MAP.terracottaWhite,
  },
  quartz: {
    hardness: 0.8, blastResistance: 0.8, tool: TOOL.PICKAXE, tier: TIER.WOOD,
    requiresTool: true, sound: SOUND.STONE, mapColor: MAP.quartz,
  },
  amethyst: {
    hardness: 1.5, blastResistance: 1.5, tool: TOOL.PICKAXE, tier: TIER.WOOD,
    requiresTool: true, sound: SOUND.AMETHYST, mapColor: MAP.purple,
  },
  sculk: {
    hardness: 0.2, blastResistance: 0.2, tool: TOOL.HOE, sound: SOUND.STONE,
    mapColor: MAP.sculk,
  },
  copper: {
    hardness: 3, blastResistance: 6, tool: TOOL.PICKAXE, tier: TIER.STONE,
    requiresTool: true, sound: SOUND.METAL, mapColor: MAP.copper,
  },
});

/** Shallow-merge a material preset with per-block overrides. */
export const mat = (base, over) => Object.assign({}, base, over);

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Convert 0..1 shape AABBs into 0..16 model boxes sharing one texture spec. */
export function boxesToModel(boxes, tex, opts = {}) {
  const t = faceTextures(tex);
  const out = new Array(boxes.length);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    out[i] = box(
      [b.minX * 16, b.minY * 16, b.minZ * 16],
      [b.maxX * 16, b.maxY * 16, b.maxZ * 16], t, opts);
  }
  return out;
}

/** Six-entry face texture list for a pillar oriented along `axis`. */
export function axisFaces(side, end, axis) {
  if (axis === 'x') return [end, end, side, side, side, side];
  if (axis === 'z') return [side, side, side, side, end, end];
  return [side, side, end, end, side, side];
}

/**
 * Face textures for a horizontally facing block.
 * `spec` = {front, side, top, bottom, back}; `facing` is 0..3 (N,E,S,W).
 */
export function orientedFaces(spec, facing) {
  const side = spec.side ?? spec.front;
  const tex = [side, side, spec.bottom ?? spec.top ?? side,
    spec.top ?? side, side, side];
  const f = HORIZ_TO_FACE[facing];
  tex[f] = spec.front;
  tex[FACES[f].opposite] = spec.back ?? side;
  return tex;
}

/** A cross-render block draws from `textures`, never from a model. */
export const NO_MODEL = () => null;

// ---------------------------------------------------------------------------
// Placement context helpers
//
// The interaction system builds a context object and hands it to
// `stateForPlacement(world, x, y, z, ctx)`:
//   face      FACES index of the clicked face (the side the block attaches to)
//   hitX/Y/Z  0..1 position within the clicked face
//   yaw,pitch placer's look angles in radians
//   sneaking  boolean
//   player    the placing entity (may be null for world generation)
//   stack     the ItemStack being placed (may be null)
// ---------------------------------------------------------------------------

/**
 * Horizontal facing index the given yaw looks toward.
 *
 * math.js ships `yawToFacing`, but its convention disagrees with the
 * `HORIZONTAL` table it sits next to; inverting HORIZONTAL keeps every block in
 * this file consistent with the direction vectors used for neighbour lookups.
 */
export function yawFacing(yaw) {
  return (Math.round((yaw || 0) / (Math.PI / 2)) + 2) & 3;
}

/** The direction the placer is looking (used by stairs, logs, terracotta). */
export const lookFacing = (ctx) => yawFacing(ctx && ctx.yaw);
/** The direction facing back at the placer (furnaces, chests, pumpkins). */
export const faceFacing = (ctx) => (yawFacing(ctx && ctx.yaw) + 2) & 3;

/** Is the target cell already a water source? Drives auto-waterlogging. */
export function isWaterAt(world, x, y, z) {
  const s = world.getBlock(x, y, z);
  return T.fluid[s] === 1 && T.fluidLevel[s] === 0;
}

/** Whether a placement should land in the top half of the block. */
export function topHalf(ctx) {
  if (!ctx) return false;
  if (ctx.face === 2) return true;       // clicked the underside of a block
  if (ctx.face === 3) return false;      // clicked a top face
  return (ctx.hitY ?? 0) > 0.5;
}

// ---------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------

const enchant = (tool, name) =>
  (tool && tool.getEnchantLevel ? tool.getEnchantLevel(name) : 0);

/** Drop the block itself — the default when no `drops` hook is present. */
export function selfDrop(state) {
  const b = blockOf(state);
  return [{ item: b.item || b.name, count: 1 }];
}

/**
 * An ore-style drop: a different item, silk-touchable, fortune-multiplied.
 * `random` may be omitted by callers that only want the deterministic minimum.
 */
export function oreDrop(item, min = 1, max = min, opts = {}) {
  return function (world, x, y, z, state, tool, random) {
    if (enchant(tool, 'silk_touch') > 0) return selfDrop(state);
    let count = min === max ? min
      : (random ? random.intRange(min, max) : min);
    const fortune = enchant(tool, 'fortune');
    if (fortune > 0 && opts.fortune !== false && random) {
      // Vanilla's "ore bonus": a uniform multiplier in 1..fortune+1.
      count *= Math.max(1, random.intRange(0, fortune + 1));
    }
    return count > 0 ? [{ item, count }] : [];
  };
}

/** Drop a fixed item list; used for blocks that never drop themselves. */
export function fixedDrop(item, count = 1) {
  return () => (count > 0 ? [{ item, count }] : []);
}

/** Drop nothing unless mined with silk touch. */
export function silkOnly(fallback = null) {
  return function (world, x, y, z, state, tool, random) {
    if (enchant(tool, 'silk_touch') > 0) return selfDrop(state);
    return fallback ? fallback(world, x, y, z, state, tool, random) : [];
  };
}

// ---------------------------------------------------------------------------
// Connection predicates
// ---------------------------------------------------------------------------

/** A full opaque cube that fences, walls and panes may attach to. */
function isAttachableCube(state) {
  const d = blockOf(state);
  if (!d || d.noConnect) return false;
  return T.fullCube[state] === 1 && d.solid && d.pass === PASS.SOLID;
}

/** Does a fence at `self` connect to the block at (x,y,z) in horizontal `dir`? */
export function fenceConnects(world, x, y, z, dir, self) {
  const ns = world.getBlock(x, y, z);
  if (ns === 0) return false;
  const nd = blockOf(ns);
  if (!nd) return false;
  if (nd.fenceGroup && nd.fenceGroup === self.fenceGroup) return true;
  // A gate connects on its hinge sides, i.e. perpendicular to the way it faces.
  if (nd.isFenceGate) return (FACING_INDEX[getProp(ns, 'facing')] & 1) !== (dir & 1);
  return isAttachableCube(ns);
}

/** Walls additionally connect to any other wall, regardless of material. */
export function wallConnects(world, x, y, z, dir) {
  const ns = world.getBlock(x, y, z);
  if (ns === 0) return false;
  const nd = blockOf(ns);
  if (!nd) return false;
  if (nd.isWall) return true;
  if (nd.isFenceGate) return (FACING_INDEX[getProp(ns, 'facing')] & 1) !== (dir & 1);
  return isAttachableCube(ns);
}

/** Panes and iron bars connect to each other and to solid cubes. */
export function paneConnects(world, x, y, z) {
  const ns = world.getBlock(x, y, z);
  if (ns === 0) return false;
  const nd = blockOf(ns);
  if (!nd) return false;
  if (nd.isPane) return true;
  return isAttachableCube(ns);
}

// ---------------------------------------------------------------------------
// Stairs
// ---------------------------------------------------------------------------

const STAIR_PROPS = [PROP.facing, PROP.half, PROP.stairShape, PROP.waterlogged];
const STAIR_DEFAULT = {
  facing: 'north', half: 'bottom', shape: 'straight', waterlogged: false,
};

const isStairsState = (s) => {
  const d = blockOf(s);
  return !!d && d.isStairs === true;
};

/** Vanilla's corner rule: look in front and behind for a perpendicular stair. */
function stairShapeAt(world, x, y, z, state) {
  const facing = FACING_INDEX[getProp(state, 'facing')];
  const half = getProp(state, 'half');
  const f = HORIZONTAL[facing];

  const front = world.getBlock(x + f.dx, y, z + f.dz);
  if (isStairsState(front) && getProp(front, 'half') === half) {
    const ff = FACING_INDEX[getProp(front, 'facing')];
    if ((ff & 1) !== (facing & 1)) {
      const side = HORIZONTAL[(ff + 2) & 3];
      const opp = world.getBlock(x + side.dx, y, z + side.dz);
      if (!matchingStair(opp, state, facing, half)) {
        return ff === ((facing + 3) & 3) ? 'outer_left' : 'outer_right';
      }
    }
  }
  const back = world.getBlock(x - f.dx, y, z - f.dz);
  if (isStairsState(back) && getProp(back, 'half') === half) {
    const bf = FACING_INDEX[getProp(back, 'facing')];
    if ((bf & 1) !== (facing & 1)) {
      const side = HORIZONTAL[bf];
      const opp = world.getBlock(x + side.dx, y, z + side.dz);
      if (!matchingStair(opp, state, facing, half)) {
        return bf === ((facing + 3) & 3) ? 'inner_left' : 'inner_right';
      }
    }
  }
  return 'straight';
}

function matchingStair(other, state, facing, half) {
  if (!isStairsState(other)) return false;
  return FACING_INDEX[getProp(other, 'facing')] === facing &&
    getProp(other, 'half') === half;
}

/**
 * @param {string} name       block id, e.g. 'polished_andesite_stairs'
 * @param {string|object} tex texture spec for every face
 * @param {object} o          material options (see MAT)
 */
export function stairsBlock(name, tex, o = {}) {
  const b = def(name, mat(o, {
    properties: STAIR_PROPS,
    defaultState: STAIR_DEFAULT,
    render: RENDER.MODEL,
    pass: o.pass ?? PASS.SOLID,
    solid: false,
    opaque: false,
    creativeTab: o.creativeTab ?? 'building',
    model: (state) => boxesToModel(stairBoxes(state), tex, { tint: o.tint || TINT.NONE }),
    collision: (state) => stairBoxes(state),
    updateShape(world, x, y, z, state) {
      const shape = stairShapeAt(world, x, y, z, state);
      return withProp(state, 'shape', shape);
    },
  }), { isStairs: true, family: o.family || null });

  b.stateForPlacement = (world, x, y, z, ctx) => {
    let s = stateOf(b, {
      facing: DIRS[lookFacing(ctx)],
      half: topHalf(ctx) ? 'top' : 'bottom',
      shape: 'straight',
      waterlogged: isWaterAt(world, x, y, z),
    });
    return withProp(s, 'shape', stairShapeAt(world, x, y, z, s));
  };
  return b;
}

function stairBoxes(state) {
  return SHAPE.stairShape(
    FACING_INDEX[getProp(state, 'facing')],
    getProp(state, 'half'),
    getProp(state, 'shape'));
}

// ---------------------------------------------------------------------------
// Slabs
// ---------------------------------------------------------------------------

export function slabBlock(name, tex, o = {}) {
  const b = def(name, mat(o, {
    properties: [PROP.slabType, PROP.waterlogged],
    defaultState: { type: 'bottom', waterlogged: false },
    render: RENDER.MODEL,
    pass: o.pass ?? PASS.SOLID,
    solid: false,
    opaque: false,
    creativeTab: o.creativeTab ?? 'building',
    model: (state) => boxesToModel(slabBoxes(state), tex, { tint: o.tint || TINT.NONE }),
    collision: (state) => slabBoxes(state),
  }), { isSlab: true, family: o.family || null });

  b.stateForPlacement = (world, x, y, z, ctx) => {
    // Clicking the flat face of an existing matching slab fills the block.
    const here = world.getBlock(x, y, z);
    if (blockOf(here) === b && getProp(here, 'type') !== 'double') {
      return withProp(here, 'type', 'double');
    }
    return stateOf(b, {
      type: topHalf(ctx) ? 'top' : 'bottom',
      waterlogged: isWaterAt(world, x, y, z),
    });
  };
  return b;
}

function slabBoxes(state) {
  const type = getProp(state, 'type');
  if (type === 'double') return SHAPE.FULL;
  return type === 'top' ? SHAPE.slabTop : SHAPE.slabBottom;
}

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

const WALL_PROPS = [PROP.wallNorth, PROP.wallEast, PROP.wallSouth,
  PROP.wallWest, PROP.up, PROP.waterlogged];
const WALL_DEFAULT = {
  north: 'none', east: 'none', south: 'none', west: 'none',
  up: true, waterlogged: false,
};

function wallBoxes(state, postH, lowH, tallH) {
  const boxes = [];
  if (getProp(state, 'up')) boxes.push(new AABB(4 / 16, 0, 4 / 16, 12 / 16, postH, 12 / 16));
  const t = 3 / 16;
  const h = (v) => (v === 'tall' ? tallH : lowH);
  const n = getProp(state, 'north'), e = getProp(state, 'east');
  const s = getProp(state, 'south'), w = getProp(state, 'west');
  if (n !== 'none') boxes.push(new AABB(0.5 - t, 0, 0, 0.5 + t, h(n), 0.5 + t));
  if (s !== 'none') boxes.push(new AABB(0.5 - t, 0, 0.5 - t, 0.5 + t, h(s), 1));
  if (w !== 'none') boxes.push(new AABB(0, 0, 0.5 - t, 0.5 + t, h(w), 0.5 + t));
  if (e !== 'none') boxes.push(new AABB(0.5 - t, 0, 0.5 - t, 1, h(e), 0.5 + t));
  return boxes.length ? boxes : [new AABB(4 / 16, 0, 4 / 16, 12 / 16, postH, 12 / 16)];
}

/** Recompute a wall's four sides and centre post from its neighbours. */
export function wallUpdate(world, x, y, z, state) {
  // A wall goes "tall" on a side when something sits directly above it, so the
  // wall reaches the block it is supporting instead of leaving a gap.
  const above = world.getBlock(x, y + 1, z);
  const aboveSolid = isAttachableCube(above) ||
    (blockOf(above) && blockOf(above).isWall);
  let s = state;
  let count = 0, axisMask = 0;
  for (let i = 0; i < 4; i++) {
    const d = HORIZONTAL[i];
    const con = wallConnects(world, x + d.dx, y, z + d.dz, i);
    let v = 'none';
    if (con) {
      count++;
      axisMask |= 1 << (i & 1);
      const cornerAbove = world.getBlock(x + d.dx, y + 1, z + d.dz);
      v = (aboveSolid || isAttachableCube(cornerAbove)) ? 'tall' : 'low';
    }
    s = withProp(s, DIRS[i], v);
  }
  // The post is dropped only for a clean straight run through the block.
  const straight = count === 2 && (axisMask === 1 || axisMask === 2) &&
    getProp(s, DIRS[0]) === getProp(s, DIRS[2]) &&
    getProp(s, DIRS[1]) === getProp(s, DIRS[3]);
  return withProp(s, 'up', aboveSolid || !straight);
}

export function wallBlock(name, tex, o = {}) {
  const b = def(name, mat(o, {
    properties: WALL_PROPS,
    defaultState: WALL_DEFAULT,
    render: RENDER.MODEL,
    solid: false,
    opaque: false,
    creativeTab: o.creativeTab ?? 'building',
    model: (state) => boxesToModel(wallBoxes(state, 1, 14 / 16, 1), tex),
    collision: (state) => wallBoxes(state, 1.5, 1.5, 1.5),
    updateShape: wallUpdate,
  }), { isWall: true, family: o.family || null });

  b.stateForPlacement = (world, x, y, z, ctx) =>
    wallUpdate(world, x, y, z,
      stateOf(b, { ...WALL_DEFAULT, waterlogged: isWaterAt(world, x, y, z) }));
  return b;
}

// ---------------------------------------------------------------------------
// Fences and fence gates
// ---------------------------------------------------------------------------

const FENCE_PROPS = [PROP.north, PROP.east, PROP.south, PROP.west, PROP.waterlogged];

function fenceModelBoxes(state) {
  const boxes = [new AABB(6 / 16, 0, 6 / 16, 10 / 16, 1, 10 / 16)];
  const rail = (a, b) => boxes.push(a, b);
  if (getProp(state, 'north')) {
    rail(new AABB(7 / 16, 6 / 16, 0, 9 / 16, 9 / 16, 6 / 16),
      new AABB(7 / 16, 12 / 16, 0, 9 / 16, 15 / 16, 6 / 16));
  }
  if (getProp(state, 'south')) {
    rail(new AABB(7 / 16, 6 / 16, 10 / 16, 9 / 16, 9 / 16, 1),
      new AABB(7 / 16, 12 / 16, 10 / 16, 9 / 16, 15 / 16, 1));
  }
  if (getProp(state, 'west')) {
    rail(new AABB(0, 6 / 16, 7 / 16, 6 / 16, 9 / 16, 9 / 16),
      new AABB(0, 12 / 16, 7 / 16, 6 / 16, 15 / 16, 9 / 16));
  }
  if (getProp(state, 'east')) {
    rail(new AABB(10 / 16, 6 / 16, 7 / 16, 1, 9 / 16, 9 / 16),
      new AABB(10 / 16, 12 / 16, 7 / 16, 1, 15 / 16, 9 / 16));
  }
  return boxes;
}

export function fenceUpdate(world, x, y, z, state) {
  const self = blockOf(state);
  let s = state;
  for (let i = 0; i < 4; i++) {
    const d = HORIZONTAL[i];
    s = withProp(s, DIRS[i], fenceConnects(world, x + d.dx, y, z + d.dz, i, self));
  }
  return s;
}

export function fenceBlock(name, tex, o = {}) {
  const b = def(name, mat(o, {
    properties: FENCE_PROPS,
    defaultState: { north: false, east: false, south: false, west: false, waterlogged: false },
    render: RENDER.MODEL,
    solid: false,
    opaque: false,
    creativeTab: o.creativeTab ?? 'decorations',
    model: (state) => boxesToModel(fenceModelBoxes(state), tex),
    collision: (state) => SHAPE.connectedShape(
      getProp(state, 'north'), getProp(state, 'east'),
      getProp(state, 'south'), getProp(state, 'west'), 4 / 16, 1.5, 4 / 16),
    updateShape: fenceUpdate,
  }), { isFence: true, fenceGroup: o.fenceGroup || 'wood', family: o.family || null });

  b.stateForPlacement = (world, x, y, z, ctx) => fenceUpdate(world, x, y, z,
    stateOf(b, { waterlogged: isWaterAt(world, x, y, z) }));
  return b;
}

function gateBoxes(state) {
  if (getProp(state, 'open')) {
    // Open gates leave the doorway clear; only the two posts remain.
    return gatePosts(FACING_INDEX[getProp(state, 'facing')]);
  }
  const facing = FACING_INDEX[getProp(state, 'facing')];
  const boxes = gatePosts(facing);
  if (facing & 1) boxes.push(new AABB(6 / 16, 0, 0, 10 / 16, 1, 1));
  else boxes.push(new AABB(0, 0, 6 / 16, 1, 1, 10 / 16));
  return boxes;
}

function gatePosts(facing) {
  if (facing & 1) {  // east/west: posts on the north and south edges
    return [new AABB(6 / 16, 0, 0, 10 / 16, 1, 2 / 16),
      new AABB(6 / 16, 0, 14 / 16, 10 / 16, 1, 1)];
  }
  return [new AABB(0, 0, 6 / 16, 2 / 16, 1, 10 / 16),
    new AABB(14 / 16, 0, 6 / 16, 1, 1, 10 / 16)];
}

export function fenceGateBlock(name, tex, o = {}) {
  const b = def(name, mat(o, {
    properties: [PROP.facing, PROP.open, PROP.powered, PROP.inWall],
    defaultState: { facing: 'north', open: false, powered: false, in_wall: false },
    render: RENDER.MODEL,
    solid: false,
    opaque: false,
    creativeTab: o.creativeTab ?? 'decorations',
    model: (state) => boxesToModel(gateBoxes(state), tex),
    // An open gate is walkable; a closed one blocks like a fence (1.5 tall).
    collision: (state) => (getProp(state, 'open') ? SHAPE.NONE
      : gateBoxes(state).map((a) => new AABB(a.minX, a.minY, a.minZ, a.maxX, 1.5, a.maxZ))),
    onUse(world, x, y, z, state, player) {
      const open = !getProp(state, 'open');
      let s = withProp(state, 'open', open);
      // Opening while standing behind the gate swings it away from the player.
      if (open && player) {
        const facing = FACING_INDEX[getProp(state, 'facing')];
        const d = HORIZONTAL[facing];
        const dx = (player.x ?? x + 0.5) - (x + 0.5);
        const dz = (player.z ?? z + 0.5) - (z + 0.5);
        if (dx * d.dx + dz * d.dz < 0) s = withProp(s, 'facing', DIRS[(facing + 2) & 3]);
      }
      world.setBlock(x, y, z, s);
      world.playSound(open ? 'open.fence_gate' : 'close.fence_gate', x + 0.5, y + 0.5, z + 0.5);
      return true;
    },
    onNeighborChange(world, x, y, z, state) {
      const powered = !!world.game?.redstone?.hasSignal?.(world, x, y, z);
      if (powered !== getProp(state, 'powered')) {
        world.setBlock(x, y, z, withProp(withProp(state, 'powered', powered), 'open', powered));
      }
    },
  }), { isFenceGate: true, family: o.family || null });

  b.stateForPlacement = (world, x, y, z, ctx) => stateOf(b, {
    facing: DIRS[lookFacing(ctx)], open: false, powered: false, in_wall: false,
  });
  return b;
}

// ---------------------------------------------------------------------------
// Doors and trapdoors
// ---------------------------------------------------------------------------

export function doorBlock(name, o = {}) {
  const texBottom = o.textureBottom || `${name}_bottom`;
  const texTop = o.textureTop || `${name}_top`;
  const b = def(name, mat(o, {
    properties: [PROP.facing, PROP.half, PROP.hinge, PROP.open, PROP.powered],
    defaultState: {
      facing: 'north', half: 'bottom', hinge: 'left', open: false, powered: false,
    },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    solid: false,
    opaque: false,
    transparentToSelf: true,
    creativeTab: o.creativeTab ?? 'decorations',
    maxStack: 64,
    model: (state) => boxesToModel(doorBoxes(state),
      getProp(state, 'half') === 'top' ? texTop : texBottom),
    collision: doorBoxes,
    canSurvive(world, x, y, z, state) {
      if (getProp(state, 'half') === 'top') {
        const below = world.getBlock(x, y - 1, z);
        return blockOf(below) === blockOf(state);
      }
      return T.solid[world.getBlock(x, y - 1, z)] === 1;
    },
    onUse(world, x, y, z, state, player) {
      if (o.locked) return false;   // iron doors only respond to redstone
      toggleDoor(world, x, y, z, state, !getProp(state, 'open'));
      return true;
    },
    onBreak(world, x, y, z, state) {
      const other = getProp(state, 'half') === 'top' ? y - 1 : y + 1;
      if (blockOf(world.getBlock(x, other, z)) === blockOf(state)) {
        world.setBlock(x, other, z, 0);
      }
    },
    onNeighborChange(world, x, y, z, state) {
      const powered = !!world.game?.redstone?.hasSignal?.(world, x, y, z) ||
        !!world.game?.redstone?.hasSignal?.(world, x,
          getProp(state, 'half') === 'top' ? y - 1 : y + 1, z);
      if (powered !== getProp(state, 'powered')) toggleDoor(world, x, y, z, state, powered);
    },
  }), { isDoor: true, family: o.family || null });

  b.stateForPlacement = (world, x, y, z, ctx) => {
    const facing = faceFacing(ctx);
    return stateOf(b, {
      facing: DIRS[facing], half: 'bottom',
      hinge: doorHinge(world, x, y, z, facing, ctx),
      open: false, powered: false,
    });
  };
  // The upper half is placed by the item logic; expose the helper it needs.
  b.upperHalf = (state) => withProp(state, 'half', 'top');
  return b;
}

function doorBoxes(state) {
  return SHAPE.doorShape(FACING_INDEX[getProp(state, 'facing')],
    getProp(state, 'open'), getProp(state, 'hinge'));
}

function toggleDoor(world, x, y, z, state, open) {
  const half = getProp(state, 'half');
  const otherY = half === 'top' ? y - 1 : y + 1;
  const other = world.getBlock(x, otherY, z);
  world.setBlock(x, y, z, withProp(state, 'open', open));
  if (blockOf(other) === blockOf(state)) {
    world.setBlock(x, otherY, z, withProp(other, 'open', open));
  }
  world.playSound(open ? 'open.door' : 'close.door', x + 0.5, y + 0.5, z + 0.5);
}

/** Hinge side: prefer an adjacent identical door, else the half clicked. */
function doorHinge(world, x, y, z, facing, ctx) {
  const left = HORIZONTAL[(facing + 3) & 3];
  const right = HORIZONTAL[(facing + 1) & 3];
  const ls = world.getBlock(x + left.dx, y, z + left.dz);
  const rs = world.getBlock(x + right.dx, y, z + right.dz);
  const ld = blockOf(ls), rd = blockOf(rs);
  if (ld && ld.isDoor && getProp(ls, 'facing') === DIRS[facing]) return 'right';
  if (rd && rd.isDoor && getProp(rs, 'facing') === DIRS[facing]) return 'left';
  if (!ctx) return 'left';
  const hx = ctx.hitX ?? 0.5, hz = ctx.hitZ ?? 0.5;
  switch (facing) {
    case 0: return hx > 0.5 ? 'right' : 'left';
    case 1: return hz > 0.5 ? 'right' : 'left';
    case 2: return hx < 0.5 ? 'right' : 'left';
    default: return hz < 0.5 ? 'right' : 'left';
  }
}

export function trapdoorBlock(name, tex, o = {}) {
  const b = def(name, mat(o, {
    properties: [PROP.facing, PROP.half, PROP.open, PROP.powered, PROP.waterlogged],
    defaultState: {
      facing: 'north', half: 'bottom', open: false, powered: false, waterlogged: false,
    },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    solid: false,
    opaque: false,
    creativeTab: o.creativeTab ?? 'decorations',
    model: (state) => boxesToModel(trapdoorBoxes(state), tex),
    collision: trapdoorBoxes,
    onUse(world, x, y, z, state) {
      if (o.locked) return false;
      const open = !getProp(state, 'open');
      world.setBlock(x, y, z, withProp(state, 'open', open));
      world.playSound(open ? 'open.trapdoor' : 'close.trapdoor', x + 0.5, y + 0.5, z + 0.5);
      return true;
    },
    onNeighborChange(world, x, y, z, state) {
      const powered = !!world.game?.redstone?.hasSignal?.(world, x, y, z);
      if (powered !== getProp(state, 'powered')) {
        world.setBlock(x, y, z,
          withProp(withProp(state, 'powered', powered), 'open', powered));
      }
    },
  }), { isTrapdoor: true, family: o.family || null });

  b.stateForPlacement = (world, x, y, z, ctx) => stateOf(b, {
    facing: DIRS[faceFacing(ctx)],
    half: topHalf(ctx) ? 'top' : 'bottom',
    open: false, powered: false, waterlogged: isWaterAt(world, x, y, z),
  });
  return b;
}

function trapdoorBoxes(state) {
  return SHAPE.trapdoorShape(FACING_INDEX[getProp(state, 'facing')],
    getProp(state, 'open'), getProp(state, 'half'));
}

// ---------------------------------------------------------------------------
// Buttons, pressure plates, levers
// ---------------------------------------------------------------------------

/** Attachment face + facing for anything that mounts on a clicked surface. */
export function attachStateFor(ctx) {
  const face = ctx ? ctx.face : 3;
  if (face === 3) return { face: 'floor', facing: DIRS[faceFacing(ctx)] };
  if (face === 2) return { face: 'ceiling', facing: DIRS[faceFacing(ctx)] };
  // Wall mount: the block faces away from the surface it is stuck to.
  const dir = face === 4 ? 0 : face === 1 ? 1 : face === 5 ? 2 : 3;
  return { face: 'wall', facing: DIRS[dir] };
}

/** The block a wall/floor/ceiling mounted device is stuck to. */
export function attachSupportOffset(state) {
  const face = getProp(state, 'face');
  if (face === 'floor') return [0, -1, 0];
  if (face === 'ceiling') return [0, 1, 0];
  const d = HORIZONTAL[(FACING_INDEX[getProp(state, 'facing')] + 2) & 3];
  return [d.dx, 0, d.dz];
}

export function buttonBlock(name, tex, o = {}) {
  const ticks = o.pressTicks ?? (o.wooden ? 30 : 20);
  const b = def(name, mat(o, {
    properties: [PROP.attach, PROP.facing, PROP.powered],
    defaultState: { face: 'wall', facing: 'north', powered: false },
    render: RENDER.MODEL,
    hardness: o.hardness ?? 0.5,
    blastResistance: o.blastResistance ?? 0.5,
    solid: false,
    opaque: false,
    creativeTab: 'redstone',
    model: (state) => boxesToModel(buttonBoxes(state), tex),
    collision: () => SHAPE.NONE,
    selection: (state) => buttonBoxes(state),
    redstone: { source: true, component: true, power: 15 },
    canSurvive(world, x, y, z, state) {
      const [dx, dy, dz] = attachSupportOffset(state);
      return T.solid[world.getBlock(x + dx, y + dy, z + dz)] === 1;
    },
    onUse(world, x, y, z, state) {
      if (getProp(state, 'powered')) return true;
      world.setBlock(x, y, z, withProp(state, 'powered', true));
      world.playSound('click.on', x + 0.5, y + 0.5, z + 0.5);
      world.scheduleTick(x, y, z, blockOf(state), ticks);
      world.game?.redstone?.update?.(world, x, y, z);
      return true;
    },
    onScheduledTick(world, x, y, z, state) {
      if (!getProp(state, 'powered')) return;
      world.setBlock(x, y, z, withProp(state, 'powered', false));
      world.playSound('click.off', x + 0.5, y + 0.5, z + 0.5);
      world.game?.redstone?.update?.(world, x, y, z);
    },
  }), { isButton: true, family: o.family || null });

  b.stateForPlacement = (world, x, y, z, ctx) => stateOf(b, {
    ...attachStateFor(ctx), powered: false,
  });
  return b;
}

function buttonBoxes(state) {
  return SHAPE.buttonShape(getProp(state, 'face'),
    FACING_INDEX[getProp(state, 'facing')], getProp(state, 'powered'));
}

export function pressurePlateBlock(name, tex, o = {}) {
  const b = def(name, mat(o, {
    properties: [PROP.powered],
    defaultState: { powered: false },
    render: RENDER.MODEL,
    hardness: o.hardness ?? 0.5,
    blastResistance: o.blastResistance ?? 0.5,
    solid: false,
    opaque: false,
    creativeTab: 'redstone',
    model: () => boxesToModel(SHAPE.pressurePlate, tex),
    collision: () => SHAPE.NONE,
    selection: () => SHAPE.pressurePlate,
    redstone: { source: true, component: true },
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y - 1, z)] === 1 ||
      blockOf(world.getBlock(x, y - 1, z))?.isFence === true,
    onEntityInside(world, x, y, z, state, entity) {
      if (getProp(state, 'powered')) return;
      world.setBlock(x, y, z, withProp(state, 'powered', true));
      world.playSound('click.on', x + 0.5, y + 0.1, z + 0.5);
      world.scheduleTick(x, y, z, blockOf(state), 20);
      world.game?.redstone?.update?.(world, x, y, z);
    },
    onScheduledTick(world, x, y, z, state) {
      if (!getProp(state, 'powered')) return;
      const box = new AABB(x + 0.06, y, z + 0.06, x + 0.94, y + 0.25, z + 0.94);
      if (world.entitiesInBox(box).length > 0) {
        world.scheduleTick(x, y, z, blockOf(state), 10);
        return;
      }
      world.setBlock(x, y, z, withProp(state, 'powered', false));
      world.playSound('click.off', x + 0.5, y + 0.1, z + 0.5);
      world.game?.redstone?.update?.(world, x, y, z);
    },
  }), { isPressurePlate: true, weighted: o.weighted || null, family: o.family || null });
  return b;
}

// ---------------------------------------------------------------------------
// Panes (glass panes, iron bars)
// ---------------------------------------------------------------------------

function paneBoxes(state, thin) {
  const t = thin / 2;
  const n = getProp(state, 'north'), e = getProp(state, 'east');
  const s = getProp(state, 'south'), w = getProp(state, 'west');
  if (!n && !e && !s && !w) {
    // An isolated pane renders as a plus, matching the vanilla model.
    return [new AABB(0.5 - t, 0, 0, 0.5 + t, 1, 1),
      new AABB(0, 0, 0.5 - t, 1, 1, 0.5 + t)];
  }
  const boxes = [new AABB(0.5 - t, 0, 0.5 - t, 0.5 + t, 1, 0.5 + t)];
  if (n) boxes.push(new AABB(0.5 - t, 0, 0, 0.5 + t, 1, 0.5 + t));
  if (s) boxes.push(new AABB(0.5 - t, 0, 0.5 - t, 0.5 + t, 1, 1));
  if (w) boxes.push(new AABB(0, 0, 0.5 - t, 0.5 + t, 1, 0.5 + t));
  if (e) boxes.push(new AABB(0.5 - t, 0, 0.5 - t, 1, 1, 0.5 + t));
  return boxes;
}

export function paneUpdate(world, x, y, z, state) {
  let s = state;
  for (let i = 0; i < 4; i++) {
    const d = HORIZONTAL[i];
    s = withProp(s, DIRS[i], paneConnects(world, x + d.dx, y, z + d.dz));
  }
  return s;
}

export function paneBlock(name, tex, o = {}) {
  const thin = o.thickness ?? 2 / 16;
  const b = def(name, mat(o, {
    properties: FENCE_PROPS,
    defaultState: { north: false, east: false, south: false, west: false, waterlogged: false },
    render: RENDER.MODEL,
    pass: o.pass ?? PASS.CUTOUT,
    solid: false,
    opaque: false,
    transparentToSelf: o.transparentToSelf ?? true,
    creativeTab: o.creativeTab ?? 'decorations',
    model: (state) => boxesToModel(paneBoxes(state, thin), tex, { tint: o.tint || TINT.NONE }),
    collision: (state) => paneBoxes(state, thin),
    updateShape: paneUpdate,
  }), { isPane: true, paneGroup: o.paneGroup || 'glass', family: o.family || null });

  b.stateForPlacement = (world, x, y, z, ctx) => paneUpdate(world, x, y, z,
    stateOf(b, { waterlogged: isWaterAt(world, x, y, z) }));
  return b;
}

// ---------------------------------------------------------------------------
// Simple shapes
// ---------------------------------------------------------------------------

/** A plain full cube. `tex` may be a name, an array or a {top,side,…} spec. */
export function cube(name, tex, o = {}) {
  return def(name, mat(o, {
    textures: tex || name,
    render: RENDER.CUBE,
    creativeTab: o.creativeTab ?? 'building',
  }), o.extra || null);
}

/** A pillar with an `axis` property (logs, quartz pillar, basalt, bone block). */
export function pillar(name, side, end, o = {}) {
  return def(name, mat(o, {
    properties: [PROP.axis],
    defaultState: { axis: 'y' },
    render: RENDER.CUBE,
    creativeTab: o.creativeTab ?? 'building',
    textures: (state) => axisFaces(side, end, getProp(state, 'axis')),
  }), Object.assign({ isPillar: true }, o.extra || null));
}

/** Axis chosen from the face that was clicked. */
export function axisPlacement(b) {
  b.stateForPlacement = (world, x, y, z, ctx) => {
    const face = ctx ? ctx.face : 3;
    const axis = face < 2 ? 'x' : face < 4 ? 'y' : 'z';
    return stateOf(b, { axis });
  };
  return b;
}

/** A cross-shaped plant. `tex` may be a string or (state) => string. */
export function crossBlock(name, tex, o = {}) {
  return def(name, mat(o, {
    textures: tex,
    render: RENDER.CROSS,
    pass: PASS.CUTOUT,
    hardness: o.hardness ?? 0,
    blastResistance: o.blastResistance ?? 0,
    solid: false,
    opaque: false,
    replaceable: o.replaceable ?? false,
    push: o.push ?? PUSH.DESTROY,
    sound: o.sound ?? SOUND.GRASS,
    mapColor: o.mapColor ?? MAP.plant,
    creativeTab: o.creativeTab ?? 'natural',
    model: NO_MODEL,
    collision: () => SHAPE.NONE,
    selection: () => [new AABB(2 / 16, 0, 2 / 16, 14 / 16, 14 / 16, 14 / 16)],
  }), Object.assign({ isPlant: true }, o.extra || null));
}

/** Standard "must stand on dirt" survival check. */
export function needsSupport(test) {
  return function (world, x, y, z) {
    return test(world.getBlockName(x, y - 1, z), world, x, y, z);
  };
}

export { PROP, getProp, withProp, stateOf, blockOf, RENDER, PASS, TINT, SOUND, TOOL, TIER, PUSH, T, SHAPE };
