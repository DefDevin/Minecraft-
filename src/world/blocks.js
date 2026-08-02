// Block registry: definitions, models, collision, drops, and lookup tables.
//
// A `Block` describes a kind of block; a *state* is a 16-bit id identifying one
// specific property combination of that block (see blockstate.js). The mesher,
// physics, lighting and interaction code all read through the flat typed-array
// tables built here so hot loops never touch the object graph.

import {
  allocStates, blockOf, metaOf, stateToBlock, stateToMeta, statesUsed,
  StateDefinition, EMPTY_STATE_DEF, PROP, getProp, withProp, stateOf, stateName,
} from './blockstate.js';
import { AABB, FACES } from '../core/math.js';

export { PROP, getProp, withProp, stateOf, stateName, blockOf, metaOf };

// ---------------------------------------------------------------------------
// Render types
// ---------------------------------------------------------------------------

export const RENDER = {
  INVISIBLE: 0,   // air, structure voids
  CUBE: 1,        // full opaque cube — greedy-meshed fast path
  MODEL: 2,       // arbitrary box list (slabs, stairs, fences, torches, doors)
  CROSS: 3,       // two intersecting quads (flowers, saplings, grass)
  FLUID: 4,       // water and lava, with surface height from level
  LIQUID_LOGGED: 5, // reserved: block plus water in the same cell
};

/** Which render pass a block goes into. */
export const PASS = {
  SOLID: 0,        // opaque, alpha-tested off
  CUTOUT: 1,       // alpha-tested (leaves, glass panes, plants)
  TRANSLUCENT: 2,  // alpha-blended, depth-sorted (water, stained glass, ice)
};

/** Tint sources — resolved per-vertex against the biome colour maps. */
export const TINT = {
  NONE: 0,
  GRASS: 1,
  FOLIAGE: 2,
  WATER: 3,
  REDSTONE: 4,   // tinted by power level
  STEM: 5,       // melon/pumpkin stems shift green->orange with age
};

/** Sound families used by the procedural audio engine. */
export const SOUND = {
  STONE: 'stone', WOOD: 'wood', GRAVEL: 'gravel', GRASS: 'grass',
  SAND: 'sand', SNOW: 'snow', CLOTH: 'cloth', GLASS: 'glass',
  METAL: 'metal', SLIME: 'slime', LADDER: 'ladder', ANVIL: 'anvil',
  WET_GRASS: 'wet_grass', CORAL: 'coral', NETHER: 'nether', BONE: 'bone',
  AMETHYST: 'amethyst', POWDER_SNOW: 'powder_snow', CANDLE: 'candle',
};

/** Tool families for mining speed and drop eligibility. */
export const TOOL = {
  NONE: 'none', PICKAXE: 'pickaxe', AXE: 'axe', SHOVEL: 'shovel',
  HOE: 'hoe', SHEARS: 'shears', SWORD: 'sword',
};

/** Harvest tiers. Index matters: a tool harvests anything at or below its tier. */
export const TIER = {
  HAND: 0, WOOD: 1, STONE: 2, IRON: 3, DIAMOND: 4, NETHERITE: 5, GOLD: 1,
};

/** Push behaviour for pistons. */
export const PUSH = { NORMAL: 0, DESTROY: 1, BLOCK: 2 };

// ---------------------------------------------------------------------------
// Model geometry
// ---------------------------------------------------------------------------

/**
 * A model box in 1/16th-block units (0..16), matching Minecraft's model format.
 * `faces` maps a FACES index to `{texture, cull, uvRot, tint, shadeOverride}`;
 * a missing entry means the face is not drawn.
 */
export class ModelBox {
  constructor(from, to, faces) {
    this.from = from;   // [x,y,z] in 0..16
    this.to = to;
    this.faces = faces; // array of 6, entries may be null
  }
}

/** Build a box with the same texture on every side. */
export function box(from, to, texture, opts = {}) {
  const faces = new Array(6);
  for (let i = 0; i < 6; i++) {
    faces[i] = {
      texture: typeof texture === 'string' ? texture : texture[i],
      cull: opts.cull === undefined ? autoCull(from, to, i) : (opts.cull && autoCull(from, to, i)),
      tint: opts.tint || TINT.NONE,
      uvRot: opts.uvRot || 0,
      // Face UVs default to the slice of the texture the box actually covers,
      // which is what makes slabs and stairs line up with full blocks.
      uv: opts.uv ? opts.uv[i] : autoUV(from, to, i),
      emissive: opts.emissive || 0,
    };
  }
  return new ModelBox(from, to, faces);
}

/** A face can only be culled by a neighbour if it sits exactly on the boundary. */
function autoCull(from, to, face) {
  switch (face) {
    case 0: return from[0] <= 0;
    case 1: return to[0] >= 16;
    case 2: return from[1] <= 0;
    case 3: return to[1] >= 16;
    case 4: return from[2] <= 0;
    default: return to[2] >= 16;
  }
}

/** Derive [u0,v0,u1,v1] in 0..16 texture space from the box extents. */
function autoUV(from, to, face) {
  const [x0, y0, z0] = from, [x1, y1, z1] = to;
  switch (face) {
    case 0: return [z0, 16 - y1, z1, 16 - y0];        // west  (-X)
    case 1: return [16 - z1, 16 - y1, 16 - z0, 16 - y0]; // east (+X)
    case 2: return [x0, 16 - z1, x1, 16 - z0];        // down  (-Y)
    case 3: return [x0, z0, x1, z1];                  // up    (+Y)
    case 4: return [16 - x1, 16 - y1, 16 - x0, 16 - y0]; // north (-Z)
    default: return [x0, 16 - y1, x1, 16 - y0];       // south (+Z)
  }
}

const FULL_BOX_CACHE = new Map();
/** A full 16^3 cube model from a 6-entry texture list. */
export function cubeModel(textures, opts = {}) {
  const key = textures.join('|') + (opts.tint || 0) + (opts.emissive || 0);
  if (!opts.noCache && FULL_BOX_CACHE.has(key)) return FULL_BOX_CACHE.get(key);
  const m = [box([0, 0, 0], [16, 16, 16], textures, opts)];
  if (!opts.noCache) FULL_BOX_CACHE.set(key, m);
  return m;
}

/** Expand a shorthand texture spec into the 6-entry face array. */
export function faceTextures(spec) {
  if (typeof spec === 'string') return [spec, spec, spec, spec, spec, spec];
  if (Array.isArray(spec)) return spec;
  const side = spec.side ?? spec.all;
  return [
    spec.west ?? side, spec.east ?? side,
    spec.bottom ?? spec.all ?? side, spec.top ?? spec.all ?? side,
    spec.north ?? side, spec.south ?? side,
  ];
}

// ---------------------------------------------------------------------------
// Block definition
// ---------------------------------------------------------------------------

export const blocks = [];               // by numeric block index
export const blocksByName = new Map();  // 'minecraft-style' name -> Block

let registryFrozen = false;

export class Block {
  constructor(name, opts) {
    this.name = name;
    this.displayName = opts.displayName || titleCase(name);
    this.index = blocks.length;

    const props = opts.properties || [];
    this.stateDef = props.length ? new StateDefinition(props) : EMPTY_STATE_DEF;
    this.stateCount = this.stateDef.count;
    this.base = allocStates(this, this.stateCount);
    this.defaultMeta = opts.defaultState ? this.stateDef.metaFor(opts.defaultState) : 0;
    this.defaultState = this.base + this.defaultMeta;

    this.render = opts.render ?? RENDER.CUBE;
    this.pass = opts.pass ?? PASS.SOLID;
    this.tint = opts.tint ?? TINT.NONE;

    // Physical properties
    this.solid = opts.solid ?? (this.render === RENDER.CUBE);
    this.opaque = opts.opaque ?? (this.render === RENDER.CUBE && this.pass === PASS.SOLID);
    this.hardness = opts.hardness ?? 1;
    this.blastResistance = opts.blastResistance ?? this.hardness;
    this.tool = opts.tool ?? TOOL.NONE;
    this.tier = opts.tier ?? TIER.HAND;
    this.requiresTool = opts.requiresTool ?? false;
    this.lightEmission = opts.light ?? 0;
    this.lightFilter = opts.lightFilter ?? (this.opaque ? 15 : 0);
    this.replaceable = opts.replaceable ?? false;
    this.fluid = opts.fluid ?? null;      // 'water' | 'lava'
    this.gravity = opts.gravity ?? false;
    this.flammable = opts.flammable ?? 0;   // catch chance
    this.burnTime = opts.burnTime ?? 0;     // spread encouragement
    this.fuelTicks = opts.fuelTicks ?? 0;   // furnace fuel value
    this.slipperiness = opts.slipperiness ?? 0.6;
    this.jumpFactor = opts.jumpFactor ?? 1;
    this.speedFactor = opts.speedFactor ?? 1;
    this.sound = opts.sound ?? SOUND.STONE;
    this.push = opts.push ?? PUSH.NORMAL;
    this.climbable = opts.climbable ?? false;
    this.canSpawnOn = opts.canSpawnOn ?? this.solid;
    this.randomTick = opts.randomTick ?? false;
    this.hasEntity = opts.hasEntity ?? false;   // block entity (chest, furnace…)
    this.container = opts.container ?? null;    // container definition
    this.instrument = opts.instrument ?? 'harp';
    this.mapColor = opts.mapColor ?? 0x7f7f7f;
    this.particleTexture = opts.particleTexture ?? null;
    this.emissive = opts.emissive ?? 0;
    this.waterloggable = opts.waterloggable ?? this.stateDef.has('waterlogged');
    this.transparentToSelf = opts.transparentToSelf ?? false; // glass/leaves style culling

    // Redstone
    this.redstone = opts.redstone ?? null;  // {conductive, source, component}
    this.conductive = opts.conductive ?? (this.opaque && this.solid);

    // Behaviour hooks (all optional)
    this.getModel = opts.model || null;
    this.getCollision = opts.collision || null;
    this.getSelection = opts.selection || null;
    this.getDrops = opts.drops || null;
    this.onPlace = opts.onPlace || null;
    this.onBreak = opts.onBreak || null;
    this.onUse = opts.onUse || null;
    this.onNeighborChange = opts.onNeighborChange || null;
    this.onRandomTick = opts.onRandomTick || null;
    this.onScheduledTick = opts.onScheduledTick || null;
    this.onEntityInside = opts.onEntityInside || null;
    this.onSteppedOn = opts.onSteppedOn || null;
    this.canSurvive = opts.canSurvive || null;
    this.stateForPlacement = opts.stateForPlacement || null;
    this.updateShape = opts.updateShape || null;
    this.item = opts.item !== undefined ? opts.item : name; // item id dropped/placed
    this.itemTexture = opts.itemTexture || null;
    this.maxStack = opts.maxStack ?? 64;
    this.creativeTab = opts.creativeTab ?? 'building';
    this.textures = opts.textures ?? null;

    // Cached per-state data, filled lazily by `modelFor`.
    this._models = new Array(this.stateCount).fill(undefined);
    this._collision = new Array(this.stateCount).fill(undefined);
  }

  /** Resolved model (array of ModelBox) for a state; null for invisible. */
  modelFor(state) {
    const meta = state - this.base;
    let m = this._models[meta];
    if (m === undefined) {
      m = this.getModel ? this.getModel(state, this) : defaultModel(this, state);
      this._models[meta] = m;
    }
    return m;
  }

  /** Collision boxes in block-local 0..1 units. Empty array = pass-through. */
  collisionFor(state) {
    const meta = state - this.base;
    let c = this._collision[meta];
    if (c === undefined) {
      c = this.getCollision ? this.getCollision(state, this) : defaultCollision(this, state);
      this._collision[meta] = c;
    }
    return c;
  }

  /** Selection outline boxes; defaults to the collision shape. */
  selectionFor(state) {
    if (this.getSelection) return this.getSelection(state, this);
    const c = this.collisionFor(state);
    return c.length ? c : (this.render === RENDER.INVISIBLE ? [] : [FULL_AABB]);
  }

  toString() { return this.name; }
}

const FULL_AABB = new AABB(0, 0, 0, 1, 1, 1);
export { FULL_AABB };

function defaultModel(block, state) {
  if (block.render === RENDER.INVISIBLE) return null;
  const tex = typeof block.textures === 'function' ? block.textures(state) : block.textures;
  const faces = faceTextures(tex || block.name);
  return cubeModel(faces, { tint: block.tint, emissive: block.emissive });
}

function defaultCollision(block, state) {
  if (!block.solid) return EMPTY_COLLISION;
  return [FULL_AABB];
}

const EMPTY_COLLISION = [];
export { EMPTY_COLLISION };

function titleCase(name) {
  return name.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Register a block. Returns the Block so callers can keep a handle. */
export function defineBlock(name, opts = {}) {
  if (registryFrozen) throw new Error('block registry is frozen');
  if (blocksByName.has(name)) throw new Error(`duplicate block ${name}`);
  const b = new Block(name, opts);
  blocks.push(b);
  blocksByName.set(name, b);
  return b;
}

export function getBlock(name) { return blocksByName.get(name) || null; }

/** Default state id for a block name — the common way to reference a block. */
export function id(name) {
  const b = blocksByName.get(name);
  if (!b) throw new Error(`unknown block ${name}`);
  return b.defaultState;
}

// ---------------------------------------------------------------------------
// Flat lookup tables — built once by `freezeBlocks()` after all definitions
// load. Hot paths (mesher, lighting, physics) index these directly by state id.
// ---------------------------------------------------------------------------

export const T = {
  opaque: null,       // Uint8Array: fully blocks light and hides neighbour faces
  solid: null,        // Uint8Array: has a full-cube collision box
  render: null,       // Uint8Array: RENDER.*
  pass: null,         // Uint8Array: PASS.*
  light: null,        // Uint8Array: emission 0..15
  filter: null,       // Uint8Array: skylight attenuation 0..15
  fluid: null,        // Uint8Array: 0 none, 1 water, 2 lava
  fluidLevel: null,   // Uint8Array: 0 (source) .. 8
  replaceable: null,  // Uint8Array
  block: null,        // Int16Array: block index for a state
  tint: null,         // Uint8Array
  conductive: null,   // Uint8Array
  cullGroup: null,    // Uint16Array: states with the same group cull each other
  fullCube: null,     // Uint8Array: model is exactly one 16^3 box
  emissive: null,     // Uint8Array
  waterlogged: null,  // Uint8Array: the cell also holds a water source
};

export function freezeBlocks() {
  if (registryFrozen) return;
  registryFrozen = true;
  const n = statesUsed();
  T.opaque = new Uint8Array(n);
  T.solid = new Uint8Array(n);
  T.render = new Uint8Array(n);
  T.pass = new Uint8Array(n);
  T.light = new Uint8Array(n);
  T.filter = new Uint8Array(n);
  T.fluid = new Uint8Array(n);
  T.fluidLevel = new Uint8Array(n);
  T.replaceable = new Uint8Array(n);
  T.block = new Int16Array(n);
  T.tint = new Uint8Array(n);
  T.conductive = new Uint8Array(n);
  T.cullGroup = new Uint16Array(n);
  T.fullCube = new Uint8Array(n);
  T.waterlogged = new Uint8Array(n);
  T.emissive = new Uint8Array(n);

  for (let s = 0; s < n; s++) {
    const b = stateToBlock[s];
    if (!b) continue;
    T.block[s] = b.index;
    T.render[s] = b.render;
    T.pass[s] = b.pass;
    T.light[s] = b.lightEmission;
    T.filter[s] = b.lightFilter;
    T.replaceable[s] = b.replaceable ? 1 : 0;
    T.tint[s] = b.tint;
    T.conductive[s] = b.conductive ? 1 : 0;
    T.emissive[s] = b.emissive;
    if (b.fluid === 'water') T.fluid[s] = 1;
    else if (b.fluid === 'lava') T.fluid[s] = 2;
    if (b.fluid) {
      const lvl = b.stateDef.has('level') ? b.stateDef.get(s - b.base, 'level') : 0;
      T.fluidLevel[s] = lvl;
    }
    const col = b.collisionFor(s);
    T.solid[s] = (col.length === 1 && col[0].minX <= 0 && col[0].minY <= 0 &&
      col[0].minZ <= 0 && col[0].maxX >= 1 && col[0].maxY >= 1 && col[0].maxZ >= 1) ? 1 : 0;

    const model = b.modelFor(s);
    let full = 0;
    if (model && model.length === 1) {
      const bx = model[0];
      if (bx.from[0] <= 0 && bx.from[1] <= 0 && bx.from[2] <= 0 &&
        bx.to[0] >= 16 && bx.to[1] >= 16 && bx.to[2] >= 16) full = 1;
    }
    T.fullCube[s] = full;
    T.opaque[s] = (b.opaque && full) ? 1 : 0;
    // Blocks that hide their own internal faces (glass, leaves in fancy=off)
    // share a cull group; group 0 means "never cull against a different state".
    T.cullGroup[s] = b.transparentToSelf ? (b.index + 1) : 0;
    T.waterlogged[s] = (b.stateDef.has('waterlogged') &&
      b.stateDef.get(s - b.base, 'waterlogged') === true) ? 1 : 0;
  }
  return T;
}

/**
 * Should the face `dir` of `state` be drawn given the neighbouring state?
 * Called for every candidate face, so it stays branch-light and table-driven.
 */
export function shouldRenderFace(state, neighbor, dir) {
  if (T.opaque[neighbor]) return false;
  if (state === neighbor && T.cullGroup[state]) return false;
  if (T.cullGroup[state] && T.cullGroup[state] === T.cullGroup[neighbor]) return false;
  // Fluids hide faces against other fluids of the same kind.
  if (T.fluid[state] && T.fluid[state] === T.fluid[neighbor]) return false;
  return true;
}

/** Convenience: is this state air? */
export const isAir = (state) => state === 0;
