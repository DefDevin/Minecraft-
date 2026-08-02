// World features: everything that decorates generated terrain.
//
// A "feature" is a small, self-contained piece of content stamped onto terrain
// that already exists — a tree, a flower patch, a lake, a geode. Structures
// (villages, strongholds) live in structures.js; the split is the same one
// Minecraft makes, and it matters because structures need grid-based placement
// that never depends on chunk order while features are happy to be scattered
// by a per-chunk random.
//
// Determinism. `decorateChunk` never draws from a shared stream. Every feature
// pass forks its own generator from `hash3(seed ^ salt, cx, 0, cz)`, so adding
// or removing a pass cannot shift the output of the others, and a chunk
// decorates identically whether the player arrived from the north or south.
//
// Coupling. biomes.js and generator.js are optional: when they are loaded we
// read biome names and generator height functions through `?.`; when they are
// not, the surface blocks the generator actually placed tell us enough to pick
// biome-appropriate content. Blocks are looked up lazily by name so this module
// keeps working if a block is renamed away — the feature simply does not place.

import { MIN_Y, MAX_Y, SEA_LEVEL } from './chunk.js';
import { FLAG } from './world.js';
import { blocksByName, blockOf, T } from './blocks.js';
import { Random, hash2, hash3 } from '../core/rng.js';

/** Generation writes skip lighting, neighbour updates and remesh marking. */
const GEN = FLAG.GENERATION;

// ---------------------------------------------------------------------------
// Block lookup
//
// Nothing here may throw when a block is missing: content modules are allowed
// to load independently, and a feature referencing a block that does not exist
// should quietly not place rather than take down chunk decoration.
// ---------------------------------------------------------------------------

const stateCache = new Map();

/** Default state id for a block name, or -1 when the block is not registered. */
export function B(name) {
  let s = stateCache.get(name);
  if (s === undefined) {
    const b = blocksByName.get(name);
    s = b ? b.defaultState : -1;
    stateCache.set(name, s);
  }
  return s;
}

/** A state id built from a property map, or -1 when the block is missing. */
export function S(name, props) {
  const b = blocksByName.get(name);
  if (!b) return -1;
  return b.base + b.stateDef.metaFor(props);
}

/** The first of `names` that is registered, as a default state id (or -1). */
export function firstOf(...names) {
  for (const n of names) {
    const b = blocksByName.get(n);
    if (b) return b.defaultState;
  }
  return -1;
}

export const nameOf = (state) => (state > 0 ? (blockOf(state)?.name ?? 'air') : 'air');

// ---------------------------------------------------------------------------
// Derived state tables
//
// Built once, lazily, because the block registry is not frozen when this module
// is imported. `terrain` is the interesting one: it separates ground the world
// generator laid down from decoration that a previous feature added, which is
// what lets a second pass find the real surface under a tree.
// ---------------------------------------------------------------------------

let TERRAIN = null;      // Uint8Array: state is natural ground
let SOFT = null;         // Uint8Array: a feature may overwrite this state

const DECOR_SUFFIX = /_(log|wood|leaves|planks|stem|hyphae|slab|stairs|fence|wall|sign|door|trapdoor|button|pressure_plate|carpet|bed|banner|glass|glass_pane|rail)$/;
const DECOR_NAMES = new Set([
  'mushroom_stem', 'brown_mushroom_block', 'red_mushroom_block', 'cobweb',
  'nether_wart_block', 'warped_wart_block', 'shroomlight', 'melon', 'pumpkin',
  'carved_pumpkin', 'jack_o_lantern', 'hay_block', 'bookshelf', 'chest',
  'crafting_table', 'furnace', 'barrel', 'cauldron', 'lantern', 'torch',
  'bricks', 'glass', 'iron_bars', 'spawner', 'tnt', 'scaffolding', 'ladder',
  'moss_carpet', 'snow', 'ice', 'frosted_ice',
]);

function ensureTables() {
  if (TERRAIN) return;
  const n = T.solid ? T.solid.length : 0;
  TERRAIN = new Uint8Array(n);
  SOFT = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    const def = blockOf(s);
    if (!def) continue;
    const nm = def.name;
    if (T.solid[s] && !DECOR_SUFFIX.test(nm) && !DECOR_NAMES.has(nm) &&
      !def.isLeaves && !def.isPlant && !def.isSapling && !def.isCrop) {
      TERRAIN[s] = 1;
    }
    if (s === 0 || T.replaceable[s] || def.isPlant || def.isSapling ||
      def.isLeaves || nm === 'snow' || nm === 'vine' || nm === 'glow_lichen') {
      SOFT[s] = 1;
    }
  }
  SOFT[0] = 1;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Write a state, ignoring out-of-range writes and unloaded chunks. */
export function put(world, x, y, z, state) {
  if (state < 0 || y < MIN_Y || y > MAX_Y) return false;
  return world.setBlock(x, y, z, state, GEN) !== -1;
}

/** Write only into air or a replaceable block (grass, snow, water). */
export function putSoft(world, x, y, z, state) {
  if (state < 0 || y < MIN_Y || y > MAX_Y) return false;
  ensureTables();
  const cur = world.getBlock(x, y, z);
  if (!SOFT[cur]) return false;
  return world.setBlock(x, y, z, state, GEN) !== -1;
}

/** Write only into air. */
export function putAir(world, x, y, z, state) {
  if (state < 0 || y < MIN_Y || y > MAX_Y) return false;
  if (world.getBlock(x, y, z) !== 0) return false;
  return world.setBlock(x, y, z, state, GEN) !== -1;
}

// ---------------------------------------------------------------------------
// Terrain queries
// ---------------------------------------------------------------------------

/**
 * Highest natural ground block in a column, skipping anything a feature could
 * have placed on top of it. Returns MIN_Y-1 for an unloaded or empty column.
 */
export function groundY(world, x, z) {
  ensureTables();
  let y = world.heightAt(x, z);
  if (y < MIN_Y) return MIN_Y - 1;
  if (y > MAX_Y) y = MAX_Y;
  for (; y >= MIN_Y; y--) {
    const s = world.getBlock(x, y, z);
    if (s === 0) continue;
    if (TERRAIN[s]) return y;
  }
  return MIN_Y - 1;
}

/** Ground height, preferring the generator's own (order-independent) height. */
export function terrainTopAt(world, generator, x, z) {
  const g = generator?.surfaceY?.(x, z) ?? generator?.heightAt?.(x, z) ??
    generator?.terrainHeight?.(x, z);
  if (typeof g === 'number' && Number.isFinite(g)) return Math.round(g);
  return groundY(world, x, z);
}

/** The first air block above the ground (above water too, when flooded). */
export function openY(world, x, z) {
  let y = groundY(world, x, z);
  if (y < MIN_Y) return MIN_Y;
  y++;
  while (y <= MAX_Y && world.getBlock(x, y, z) !== 0) y++;
  return y;
}

/** Water depth above the ground in a column (0 when dry). */
export function waterDepth(world, x, z) {
  const g = groundY(world, x, z);
  if (g < MIN_Y) return 0;
  let d = 0;
  for (let y = g + 1; y <= MAX_Y; y++) {
    const s = world.getBlock(x, y, z);
    if (T.fluid[s] === 1) d++;
    else break;
  }
  return d;
}

const PLANT_SOIL = new Set([
  'grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'farmland', 'moss_block', 'mud', 'muddy_mangrove_roots',
]);

export const isSoil = (name) => PLANT_SOIL.has(name);

// ---------------------------------------------------------------------------
// Biome classification
//
// Feature content is chosen from a coarse category rather than a biome id, so
// this module does not have to be edited every time biomes.js gains a biome.
// The biome registry is consulted when it is loaded; when it is not, the
// surface block the generator placed is a surprisingly good proxy.
// ---------------------------------------------------------------------------

const NAME_RULES = [
  [/deep_dark|ancient_city/, 'deep_dark'],
  [/lush/, 'lush_caves'],
  [/dripstone/, 'dripstone_caves'],
  [/mushroom/, 'mushroom_fields'],
  [/bamboo/, 'bamboo_jungle'],
  [/sparse_jungle/, 'sparse_jungle'],
  [/jungle/, 'jungle'],
  [/mangrove/, 'mangrove_swamp'],
  [/swamp/, 'swamp'],
  [/cherry/, 'cherry_grove'],
  [/badlands|mesa/, 'badlands'],
  [/desert/, 'desert'],
  [/savanna/, 'savanna'],
  [/ice_spikes/, 'ice_spikes'],
  [/frozen_ocean|deep_frozen/, 'frozen_ocean'],
  [/frozen_river/, 'frozen_river'],
  [/snowy|grove|frozen/, 'snowy'],
  [/old_growth|taiga/, 'taiga'],
  [/dark_forest/, 'dark_forest'],
  [/birch/, 'birch_forest'],
  [/flower_forest/, 'flower_forest'],
  [/forest|grove/, 'forest'],
  [/warm_ocean/, 'warm_ocean'],
  [/lukewarm/, 'lukewarm_ocean'],
  [/ocean/, 'ocean'],
  [/river/, 'river'],
  [/beach|shore/, 'beach'],
  [/stony_peaks|jagged|peaks|windswept|mountain|slope|stony/, 'mountains'],
  [/meadow/, 'meadow'],
  [/sunflower/, 'sunflower_plains'],
  [/plains/, 'plains'],
  [/crimson/, 'crimson_forest'],
  [/warped/, 'warped_forest'],
  [/soul_sand|soul_valley/, 'soul_sand_valley'],
  [/basalt/, 'basalt_deltas'],
  [/nether|wastes/, 'nether_wastes'],
  [/end|void/, 'end'],
];

/** Cache biome id -> category so the regex list runs once per biome. */
const catById = new Map();

function categoryFromName(name) {
  for (const [re, cat] of NAME_RULES) if (re.test(name)) return cat;
  return null;
}

/** Coarse feature category for a column. Never throws, never returns null. */
export function biomeCategory(world, x, z) {
  const bid = world.getSurfaceBiomeAt(x, z);
  let cat = catById.get(bid);
  if (cat === undefined) {
    const rec = world.game?.modules?.biomes?.biomeById?.[bid] ??
      world.generator?.biomes?.biomeById?.[bid] ?? null;
    cat = rec?.name ? categoryFromName(String(rec.name)) : null;
    if (rec) catById.set(bid, cat);
  }
  if (cat) return cat;
  return categoryFromSurface(world, x, z);
}

/** Last-resort classification from the blocks the generator actually placed. */
function categoryFromSurface(world, x, z) {
  const g = groundY(world, x, z);
  if (g < MIN_Y) return 'plains';
  const nm = nameOf(world.getBlock(x, g, z));
  const above = world.getBlock(x, g + 1, z);
  const flooded = T.fluid[above] === 1;
  const frozen = nameOf(above) === 'ice' || nameOf(above) === 'packed_ice';
  if (flooded || frozen) {
    if (g < SEA_LEVEL - 12) return frozen ? 'frozen_ocean' : 'ocean';
    return frozen ? 'frozen_river' : 'river';
  }
  switch (nm) {
    case 'red_sand': return 'badlands';
    case 'sand': return g <= SEA_LEVEL + 2 ? 'beach' : 'desert';
    case 'snow_block': case 'powder_snow': return 'snowy';
    case 'podzol': return 'taiga';
    case 'mycelium': return 'mushroom_fields';
    case 'mud': case 'muddy_mangrove_roots': return 'mangrove_swamp';
    case 'moss_block': return 'lush_caves';
    case 'netherrack': case 'soul_sand': case 'soul_soil': return 'nether_wastes';
    case 'crimson_nylium': return 'crimson_forest';
    case 'warped_nylium': return 'warped_forest';
    case 'end_stone': return 'end';
    case 'terracotta': return 'badlands';
    default: break;
  }
  if (/terracotta$/.test(nm)) return 'badlands';
  if (nm === 'stone' || nm === 'gravel' || nm === 'calcite') {
    return g > SEA_LEVEL + 40 ? 'mountains' : 'plains';
  }
  if (nameOf(above) === 'snow') return 'snowy';
  return g > SEA_LEVEL + 55 ? 'mountains' : 'plains';
}

const OCEANIC = new Set(['ocean', 'warm_ocean', 'lukewarm_ocean', 'frozen_ocean',
  'river', 'frozen_river']);
export const isAquatic = (cat) => OCEANIC.has(cat);

// ---------------------------------------------------------------------------
// Per-category content
// ---------------------------------------------------------------------------

/**
 * `trees` is the expected number of trees per chunk (fractional values are
 * resolved by a random draw). `treeKinds` is a weighted list.
 */
const CONTENT = {
  plains: {
    trees: 0.15, treeKinds: [['oak', 9], ['fancy_oak', 1]],
    grass: 8, flowers: 4, flowerKinds: ['dandelion', 'poppy', 'azure_bluet',
      'oxeye_daisy', 'cornflower', 'red_tulip', 'orange_tulip', 'white_tulip',
      'pink_tulip'],
    tall: 1, pumpkins: 0.08,
  },
  sunflower_plains: {
    trees: 0.15, treeKinds: [['oak', 9], ['fancy_oak', 1]],
    grass: 10, flowers: 4, flowerKinds: ['dandelion', 'poppy'],
    tall: 3, tallKinds: ['sunflower'], pumpkins: 0.08,
  },
  meadow: {
    trees: 0.08, treeKinds: [['oak', 3], ['birch', 1]],
    grass: 12, flowers: 6, flowerKinds: ['allium', 'azure_bluet', 'cornflower',
      'oxeye_daisy', 'dandelion', 'poppy'],
    tall: 2,
  },
  forest: {
    trees: 10, treeKinds: [['oak', 8], ['birch', 2], ['fancy_oak', 1]],
    grass: 4, flowers: 2, flowerKinds: ['dandelion', 'poppy',
      'lily_of_the_valley'],
    tall: 2, tallKinds: ['lilac', 'rose_bush', 'peony'], mushrooms: 0.3,
    fallenLogs: 0.4,
  },
  flower_forest: {
    trees: 7, treeKinds: [['oak', 6], ['birch', 4]],
    grass: 4, flowers: 14, flowerKinds: ['dandelion', 'poppy', 'allium',
      'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
      'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'blue_orchid'],
    tall: 4, tallKinds: ['lilac', 'rose_bush', 'peony', 'sunflower'],
  },
  birch_forest: {
    trees: 10, treeKinds: [['birch', 8], ['tall_birch', 3]],
    grass: 4, flowers: 3, flowerKinds: ['lily_of_the_valley', 'dandelion'],
    tall: 2, tallKinds: ['lilac', 'peony'], mushrooms: 0.3, fallenLogs: 0.3,
  },
  dark_forest: {
    trees: 12, treeKinds: [['dark_oak', 7], ['oak', 2], ['birch', 1],
      ['huge_brown_mushroom', 1], ['huge_red_mushroom', 1]],
    grass: 2, flowers: 1, flowerKinds: ['lily_of_the_valley', 'poppy'],
    tall: 2, tallKinds: ['rose_bush', 'peony'], mushrooms: 1, fallenLogs: 0.5,
  },
  taiga: {
    trees: 9, treeKinds: [['spruce', 6], ['pine', 3], ['mega_spruce', 1]],
    grass: 6, ferns: 5, flowers: 0.5, flowerKinds: ['dandelion', 'poppy'],
    tall: 2, tallKinds: ['large_fern'], mushrooms: 0.8, berries: 1.2,
    fallenLogs: 0.6,
  },
  snowy: {
    trees: 3, treeKinds: [['spruce', 8], ['pine', 2]],
    grass: 1, ferns: 0.5, iceSpikes: 0, fallenLogs: 0.2,
  },
  ice_spikes: { trees: 0, grass: 0.5, iceSpikes: 3 },
  mountains: {
    trees: 1, treeKinds: [['spruce', 5], ['oak', 3]],
    grass: 3, flowers: 1, flowerKinds: ['dandelion', 'poppy', 'cornflower'],
  },
  desert: {
    trees: 0, grass: 0, deadBushes: 2, cactus: 1.4, wells: 0.002,
  },
  badlands: {
    trees: 0.02, treeKinds: [['oak', 1]],
    grass: 0.2, deadBushes: 2.5, cactus: 0.6,
  },
  savanna: {
    trees: 1.2, treeKinds: [['acacia', 8], ['oak', 2]],
    grass: 14, flowers: 0.4, flowerKinds: ['dandelion', 'torchflower'],
    tall: 1,
  },
  jungle: {
    trees: 30, treeKinds: [['jungle', 8], ['mega_jungle', 3], ['oak', 1]],
    grass: 20, ferns: 10, flowers: 3, flowerKinds: ['allium', 'blue_orchid'],
    tall: 6, tallKinds: ['tall_grass', 'large_fern'], melons: 0.6,
    bamboo: 1, mushrooms: 0.4, vines: 30,
  },
  sparse_jungle: {
    trees: 3, treeKinds: [['jungle', 9], ['oak', 1]],
    grass: 14, ferns: 6, melons: 0.3, bamboo: 0.3, vines: 12,
  },
  bamboo_jungle: {
    trees: 3, treeKinds: [['jungle', 6], ['mega_jungle', 1]],
    grass: 8, bamboo: 16, melons: 0.2, vines: 20,
  },
  swamp: {
    trees: 2.5, treeKinds: [['swamp_oak', 1]],
    grass: 5, flowers: 1, flowerKinds: ['blue_orchid'],
    mushrooms: 2, lilyPads: 4, sugarCane: 2, deadBushes: 0.5,
  },
  mangrove_swamp: {
    trees: 4, treeKinds: [['mangrove', 1]],
    grass: 2, lilyPads: 3, sugarCane: 1, mushrooms: 0.5,
  },
  cherry_grove: {
    trees: 3, treeKinds: [['cherry', 1]],
    grass: 10, flowers: 4, flowerKinds: ['allium', 'pink_tulip',
      'lily_of_the_valley'],
    tall: 2, tallKinds: ['peony', 'lilac'],
  },
  mushroom_fields: {
    trees: 0.6, treeKinds: [['huge_red_mushroom', 1], ['huge_brown_mushroom', 1]],
    grass: 0, mushrooms: 8,
  },
  beach: { trees: 0, grass: 0.2, sugarCane: 1.5, deadBushes: 0.2 },
  river: { trees: 0.05, treeKinds: [['oak', 1]], grass: 1, sugarCane: 2 },
  frozen_river: { grass: 0 },
  ocean: { seagrass: 12, kelp: 6 },
  lukewarm_ocean: { seagrass: 14, kelp: 2, coral: 0.4 },
  warm_ocean: { seagrass: 16, coral: 3 },
  frozen_ocean: { seagrass: 2, icebergs: 0.12 },
  lush_caves: { grass: 2, flowers: 1, flowerKinds: ['dandelion'] },
  dripstone_caves: { grass: 0.2 },
  deep_dark: {},
  crimson_forest: {},
  warped_forest: {},
  soul_sand_valley: {},
  basalt_deltas: {},
  nether_wastes: {},
  end: {},
};

const DEFAULT_CONTENT = CONTENT.plains;
const contentFor = (cat) => CONTENT[cat] || DEFAULT_CONTENT;

/** Resolve a fractional "per chunk" count into a whole number. */
function draw(rng, expected) {
  if (!expected) return 0;
  const whole = Math.floor(expected);
  return whole + (rng.next() < expected - whole ? 1 : 0);
}

function weightedPick(rng, pairs) {
  let total = 0;
  for (const p of pairs) total += p[1];
  let r = rng.next() * total;
  for (const p of pairs) { r -= p[1]; if (r <= 0) return p[0]; }
  return pairs[pairs.length - 1][0];
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

const LOG_AXIS = { y: 'y', x: 'x', z: 'z' };

/** Log state for a species with a given axis. Nether species use `_stem`. */
export function logState(species, axis = 'y') {
  const stem = species === 'crimson' || species === 'warped';
  return S(`${species}_${stem ? 'stem' : 'log'}`, { axis: LOG_AXIS[axis] || 'y' });
}

const leafCache = new Map();
/** Leaf states for a species, indexed 1..7 by hop distance to the trunk. */
function leafStates(species) {
  let arr = leafCache.get(species);
  if (!arr) {
    arr = [];
    for (let d = 0; d <= 7; d++) {
      arr[d] = S(`${species}_leaves`,
        { distance: Math.max(1, Math.min(7, d)), persistent: false, waterlogged: false });
    }
    leafCache.set(species, arr);
  }
  return arr;
}

/**
 * A tree under construction.
 *
 * Logs and leaves are collected first and committed together so leaf `distance`
 * (which decides whether a leaf decays) can be computed against the finished
 * trunk rather than guessed as each blob is drawn.
 */
class TreeBuilder {
  constructor(world, species) {
    this.world = world;
    this.species = species;
    this.logs = [];        // flat [x,y,z,axis…]
    this.leaves = new Map(); // key -> [x,y,z]
    this.extras = [];      // [x,y,z,state]
  }

  log(x, y, z, axis = 'y') { this.logs.push(x, y, z, axis); return this; }

  leaf(x, y, z) {
    const k = `${x},${y},${z}`;
    if (!this.leaves.has(k)) this.leaves.set(k, [x, y, z]);
    return this;
  }

  /** A leaf disc of the given radius, skipping the corners for a rounder look. */
  disc(cx, y, cz, radius, trimCorners = true) {
    const r2 = radius * radius + 0.6;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (trimCorners && dx * dx + dz * dz > r2) continue;
        this.leaf(cx + dx, y, cz + dz);
      }
    }
    return this;
  }

  extra(x, y, z, state) { if (state >= 0) this.extras.push(x, y, z, state); return this; }

  /** Commit to the world. Leaves never overwrite logs. */
  commit() {
    const w = this.world;
    const logs = this.logs;
    const occupied = new Set();
    for (let i = 0; i < logs.length; i += 4) {
      occupied.add(`${logs[i]},${logs[i + 1]},${logs[i + 2]}`);
    }
    for (let i = 0; i < logs.length; i += 4) {
      putSoft(w, logs[i], logs[i + 1], logs[i + 2],
        logState(this.species, logs[i + 3]));
    }
    const states = leafStates(this.species);
    for (const [k, p] of this.leaves) {
      if (occupied.has(k)) continue;
      let best = 7;
      for (let i = 0; i < logs.length; i += 4) {
        const d = Math.abs(logs[i] - p[0]) + Math.abs(logs[i + 1] - p[1]) +
          Math.abs(logs[i + 2] - p[2]);
        if (d < best) { best = d; if (best <= 1) break; }
      }
      if (best > 6) best = 6;
      const cur = w.getBlock(p[0], p[1], p[2]);
      if (cur !== 0 && !T.replaceable[cur]) continue;
      put(w, p[0], p[1], p[2], states[best]);
    }
    for (let i = 0; i < this.extras.length; i += 4) {
      putSoft(w, this.extras[i], this.extras[i + 1], this.extras[i + 2],
        this.extras[i + 3]);
    }
    return true;
  }
}

/** Is there room for a trunk of `height` and canopy of `radius` at (x,y,z)? */
function hasRoom(world, x, y, z, height, radius) {
  ensureTables();
  if (y + height > MAX_Y - 2) return false;
  for (let dy = 0; dy < height; dy++) {
    const r = dy < 2 ? 0 : radius;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const s = world.getBlock(x + dx, y + dy, z + dz);
        if (!SOFT[s]) return false;
      }
    }
  }
  return true;
}

/** Does this column have soil a tree can root in? */
function rootable(world, x, y, z, extra) {
  const below = nameOf(world.getBlock(x, y - 1, z));
  if (PLANT_SOIL.has(below)) return true;
  return !!extra && extra.has(below);
}

const SAND_ROOT = new Set(['sand', 'red_sand']);
const MUD_ROOT = new Set(['mud', 'muddy_mangrove_roots', 'clay']);

// -- individual species ------------------------------------------------------

export function treeOak(world, x, y, z, rng, opts = {}) {
  const species = opts.species || 'oak';
  const height = opts.height ?? rng.intRange(4, 6);
  if (!rootable(world, x, y, z) || !hasRoom(world, x, y, z, height + 2, 2)) return false;
  const t = new TreeBuilder(world, species);
  for (let i = 0; i < height; i++) t.log(x, y + i, z);
  const top = y + height - 1;
  t.disc(x, top - 1, z, 2);
  t.disc(x, top, z, 2);
  t.disc(x, top + 1, z, 1);
  t.disc(x, top + 2, z, 1, false);
  // Knock the very corners off the top so the crown is not a cube.
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    if (rng.chance(0.5)) t.leaves.delete(`${x + dx},${top + 2},${z + dz}`);
  }
  if (opts.vines) hangVines(t, x, z, top, 3, rng);
  t.commit();
  return true;
}

export function treeBirch(world, x, y, z, rng, tall = false) {
  return treeOak(world, x, y, z, rng, {
    species: 'birch',
    height: tall ? rng.intRange(7, 10) : rng.intRange(5, 7),
  });
}

/** The branching "fancy" oak: a tall trunk with clusters on angled limbs. */
export function treeFancyOak(world, x, y, z, rng, species = 'oak') {
  const height = rng.intRange(9, 14);
  if (!rootable(world, x, y, z) || !hasRoom(world, x, y, z, height + 3, 3)) return false;
  const t = new TreeBuilder(world, species);
  const trunkTop = y + height;
  for (let i = 0; i <= height; i++) t.log(x, y + i, z);
  t.disc(x, trunkTop, z, 2);
  t.disc(x, trunkTop + 1, z, 1);
  t.leaf(x, trunkTop + 2, z);

  const branches = rng.intRange(3, 6);
  for (let b = 0; b < branches; b++) {
    const baseY = y + Math.floor(height * (0.35 + rng.next() * 0.55));
    const angle = rng.next() * Math.PI * 2;
    const len = rng.intRange(2, 4);
    const ex = x + Math.round(Math.cos(angle) * len);
    const ez = z + Math.round(Math.sin(angle) * len);
    const ey = baseY + rng.intRange(1, 3);
    limb(t, x, baseY, z, ex, ey, ez);
    t.disc(ex, ey, ez, 2);
    t.disc(ex, ey + 1, ez, 1);
    t.disc(ex, ey - 1, ez, 1);
  }
  t.commit();
  return true;
}

/** Draw a log line between two points (used for branches and prop roots). */
function limb(t, x0, y0, z0, x1, y1, z1) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  if (steps === 0) return;
  const axis = Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= Math.abs(dz) ? 'x'
    : Math.abs(dz) >= Math.abs(dy) ? 'z' : 'y';
  for (let i = 1; i <= steps; i++) {
    t.log(x0 + Math.round(dx * i / steps), y0 + Math.round(dy * i / steps),
      z0 + Math.round(dz * i / steps), axis);
  }
}

/** Conical spruce: a narrow cone of leaf rings that widens and narrows again. */
export function treeSpruce(world, x, y, z, rng) {
  const height = rng.intRange(7, 12);
  if (!rootable(world, x, y, z) || !hasRoom(world, x, y, z, height + 2, 3)) return false;
  const t = new TreeBuilder(world, 'spruce');
  for (let i = 0; i < height; i++) t.log(x, y + i, z);
  const bareBelow = rng.intRange(1, 3);
  let radius = 0;
  let sinceWiden = 0;
  for (let dy = height - 1; dy >= bareBelow; dy--) {
    t.disc(x, y + dy, z, radius);
    if (radius >= 3) { radius = 1; sinceWiden = 0; }
    else if (sinceWiden >= 1) { radius++; sinceWiden = 0; }
    else sinceWiden++;
  }
  t.leaf(x, y + height, z);
  t.commit();
  return true;
}

/** Pine: a bare trunk with a compact crown, as in old-growth taiga. */
export function treePine(world, x, y, z, rng) {
  const height = rng.intRange(9, 15);
  if (!rootable(world, x, y, z) || !hasRoom(world, x, y, z, height + 2, 3)) return false;
  const t = new TreeBuilder(world, 'spruce');
  for (let i = 0; i < height; i++) t.log(x, y + i, z);
  const crown = rng.intRange(3, 5);
  for (let i = 0; i < crown; i++) {
    const yy = y + height - 1 - i;
    const r = i === 0 ? 1 : (i === crown - 1 ? 1 : 2);
    t.disc(x, yy, z, r);
  }
  t.leaf(x, y + height, z);
  t.commit();
  return true;
}

/** 2x2 trunked mega spruce, with podzol spreading around the base. */
export function treeMegaSpruce(world, x, y, z, rng) {
  const height = rng.intRange(14, 22);
  if (!hasRoom(world, x, y, z, height + 3, 4)) return false;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dx = 0; dx <= 1; dx++) if (!rootable(world, x + dx, y, z + dz)) return false;
  }
  const t = new TreeBuilder(world, 'spruce');
  for (let i = 0; i < height; i++) {
    t.log(x, y + i, z).log(x + 1, y + i, z).log(x, y + i, z + 1).log(x + 1, y + i, z + 1);
  }
  let radius = 1;
  for (let dy = height - 1; dy >= Math.floor(height * 0.35); dy--) {
    const top = dy > height - 4;
    const r = top ? 1 : radius;
    for (let dz = -r; dz <= r + 1; dz++) {
      for (let dx = -r; dx <= r + 1; dx++) {
        if (dx * dx + dz * dz > (r + 1) * (r + 1) + 2) continue;
        t.leaf(x + dx, y + dy, z + dz);
      }
    }
    if (!top) radius = radius >= 3 ? 1 : radius + ((dy & 1) ? 1 : 0);
  }
  t.leaf(x, y + height, z).leaf(x + 1, y + height, z);
  t.commit();
  // Podzol carpet under a mega spruce, the way old-growth taiga floors look.
  const podzol = B('podzol');
  for (let dz = -3; dz <= 4; dz++) {
    for (let dx = -3; dx <= 4; dx++) {
      if (dx * dx + dz * dz > 12 || !rng.chance(0.7)) continue;
      const gx = x + dx, gz = z + dz;
      const gy = groundY(world, gx, gz);
      if (gy < MIN_Y) continue;
      if (PLANT_SOIL.has(nameOf(world.getBlock(gx, gy, gz)))) put(world, gx, gy, gz, podzol);
    }
  }
  return true;
}

export function treeJungle(world, x, y, z, rng) {
  const height = rng.intRange(6, 13);
  if (!rootable(world, x, y, z) || !hasRoom(world, x, y, z, height + 2, 2)) return false;
  const t = new TreeBuilder(world, 'jungle');
  for (let i = 0; i < height; i++) t.log(x, y + i, z);
  const top = y + height - 1;
  t.disc(x, top, z, 2);
  t.disc(x, top + 1, z, 1);
  t.disc(x, top - 1, z, 1);
  hangVines(t, x, z, top, 4, rng);
  t.commit();
  return true;
}

/** 2x2 jungle giant: buttressed trunk, canopy platform, vines and cocoa. */
export function treeMegaJungle(world, x, y, z, rng) {
  const height = rng.intRange(13, 22);
  if (!hasRoom(world, x, y, z, height + 3, 5)) return false;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dx = 0; dx <= 1; dx++) if (!rootable(world, x + dx, y, z + dz)) return false;
  }
  const t = new TreeBuilder(world, 'jungle');
  for (let i = 0; i < height; i++) {
    t.log(x, y + i, z).log(x + 1, y + i, z).log(x, y + i, z + 1).log(x + 1, y + i, z + 1);
  }
  const top = y + height;
  for (let dz = -3; dz <= 4; dz++) {
    for (let dx = -3; dx <= 4; dx++) {
      const d = (dx - 0.5) * (dx - 0.5) + (dz - 0.5) * (dz - 0.5);
      if (d <= 14) t.leaf(x + dx, top - 1, z + dz);
      if (d <= 8) t.leaf(x + dx, top, z + dz);
      if (d <= 3) t.leaf(x + dx, top + 1, z + dz);
    }
  }
  // Side branches, each with its own leaf platform.
  const branches = rng.intRange(2, 4);
  for (let b = 0; b < branches; b++) {
    const by = y + rng.intRange(Math.floor(height * 0.45), height - 3);
    const dir = rng.int(4);
    const dx = [0, 1, 0, -1][dir], dz = [-1, 0, 1, 0][dir];
    const len = rng.intRange(2, 4);
    const sx = x + (dx > 0 ? 1 : 0), sz = z + (dz > 0 ? 1 : 0);
    for (let i = 1; i <= len; i++) {
      t.log(sx + dx * i, by, sz + dz * i, dx !== 0 ? 'x' : 'z');
    }
    t.disc(sx + dx * len, by, sz + dz * len, 2);
    t.disc(sx + dx * len, by + 1, sz + dz * len, 1);
  }
  t.commit();
  // Vines up the trunk and cocoa pods on the outside faces.
  const vineDirs = [['north', 0, -1], ['east', 1, 0], ['south', 0, 1], ['west', -1, 0]];
  for (let i = 2; i < height - 1; i++) {
    for (const [face, ddx, ddz] of vineDirs) {
      if (!rng.chance(0.28)) continue;
      const bx = (ddx > 0 ? x + 1 : x) + ddx;
      const bz = (ddz > 0 ? z + 1 : z) + ddz;
      const vx = ddx !== 0 ? bx : x + rng.int(2);
      const vz = ddz !== 0 ? bz : z + rng.int(2);
      putAir(world, vx, y + i, vz, S('vine', {
        north: face === 'south', east: face === 'west',
        south: face === 'north', west: face === 'east', up: false,
      }));
    }
  }
  placeCocoa(world, x, y, z, height, rng);
  return true;
}

/** Cocoa pods hang off jungle log faces near the ground. */
export function placeCocoa(world, x, y, z, height, rng) {
  for (let i = 2; i < Math.min(height, 9); i++) {
    if (!rng.chance(0.18)) continue;
    const dir = rng.int(4);
    const dx = [0, 1, 0, -1][dir], dz = [-1, 0, 1, 0][dir];
    const px = x + (dx > 0 ? 2 : dx < 0 ? -1 : rng.int(2));
    const pz = z + (dz > 0 ? 2 : dz < 0 ? -1 : rng.int(2));
    const facing = ['south', 'west', 'north', 'east'][dir];
    const support = world.getBlock(px - dx, y + i, pz - dz);
    if (blockOf(support)?.isLog !== true) continue;
    putAir(world, px, y + i, pz,
      S('cocoa', { facing, age: rng.int(3) }));
  }
}

/** Acacia: a diagonal trunk that forks into flat canopy plates. */
export function treeAcacia(world, x, y, z, rng) {
  const height = rng.intRange(5, 8);
  if (!rootable(world, x, y, z, SAND_ROOT) || !hasRoom(world, x, y, z, height + 3, 4)) {
    return false;
  }
  const t = new TreeBuilder(world, 'acacia');
  const lean = rng.intRange(2, 4);
  const dir = rng.int(4);
  const dx = [0, 1, 0, -1][dir], dz = [-1, 0, 1, 0][dir];
  let cx = x, cz = z, cy = y;
  for (let i = 0; i < height; i++) { t.log(cx, cy, cz); cy++; }
  for (let i = 0; i < lean; i++) {
    cx += dx; cz += dz;
    t.log(cx, cy, cz, dx !== 0 ? 'x' : 'z');
    if (i % 2 === 1) { cy++; t.log(cx, cy, cz); }
  }
  flatCanopy(t, cx, cy, cz, 3);
  // A second, shorter fork going the other way is what gives acacias their
  // lopsided silhouette.
  if (rng.chance(0.7)) {
    const dir2 = (dir + (rng.chance(0.5) ? 1 : 3)) & 3;
    const ex = x + [0, 1, 0, -1][dir2] * 2;
    const ez = z + [-1, 0, 1, 0][dir2] * 2;
    const ey = y + height - 1 + rng.intRange(1, 2);
    limb(t, x, y + height - 2, z, ex, ey, ez);
    flatCanopy(t, ex, ey + 1, ez, 2);
  }
  t.commit();
  return true;
}

function flatCanopy(t, cx, cy, cz, radius) {
  t.disc(cx, cy, cz, radius);
  t.disc(cx, cy + 1, cz, radius - 1);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) t.leaf(cx + dx, cy - 1, cz + dz);
}

/** Dark oak: 2x2 trunk, low and very wide crown. */
export function treeDarkOak(world, x, y, z, rng) {
  const height = rng.intRange(6, 9);
  if (!hasRoom(world, x, y, z, height + 3, 4)) return false;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dx = 0; dx <= 1; dx++) if (!rootable(world, x + dx, y, z + dz)) return false;
  }
  const t = new TreeBuilder(world, 'dark_oak');
  for (let i = 0; i < height; i++) {
    t.log(x, y + i, z).log(x + 1, y + i, z).log(x, y + i, z + 1).log(x + 1, y + i, z + 1);
  }
  const top = y + height;
  for (let dz = -3; dz <= 4; dz++) {
    for (let dx = -3; dx <= 4; dx++) {
      const d = (dx - 0.5) * (dx - 0.5) + (dz - 0.5) * (dz - 0.5);
      if (d <= 13) { t.leaf(x + dx, top - 2, z + dz); t.leaf(x + dx, top - 1, z + dz); }
      if (d <= 6) t.leaf(x + dx, top, z + dz);
      if (d <= 2) t.leaf(x + dx, top + 1, z + dz);
    }
  }
  // Stubby side limbs poking out of the crown.
  for (let b = 0; b < rng.intRange(1, 3); b++) {
    const by = y + height - rng.intRange(1, 3);
    const dir = rng.int(4);
    const ddx = [0, 1, 0, -1][dir], ddz = [-1, 0, 1, 0][dir];
    for (let i = 1; i <= 2; i++) {
      t.log(x + (ddx > 0 ? 1 : 0) + ddx * i, by, z + (ddz > 0 ? 1 : 0) + ddz * i,
        ddx !== 0 ? 'x' : 'z');
    }
  }
  t.commit();
  return true;
}

/** Mangrove: arching prop roots, a short trunk, and hanging propagules. */
export function treeMangrove(world, x, y, z, rng) {
  const height = rng.intRange(5, 9);
  if (!hasRoom(world, x, y, z, height + 3, 3)) return false;
  const t = new TreeBuilder(world, 'mangrove');
  for (let i = 0; i < height; i++) t.log(x, y + i, z);
  const top = y + height - 1;
  t.disc(x, top, z, 3);
  t.disc(x, top + 1, z, 2);
  t.disc(x, top + 2, z, 1);
  t.disc(x, top - 1, z, 2);

  // Prop roots: from a ring around the trunk, angling down to the mud.
  const roots = B('mangrove_roots');
  const rootCount = rng.intRange(3, 6);
  for (let i = 0; i < rootCount; i++) {
    const a = (i / rootCount) * Math.PI * 2 + rng.next() * 0.5;
    const rx = x + Math.round(Math.cos(a) * rng.intRange(1, 3));
    const rz = z + Math.round(Math.sin(a) * rng.intRange(1, 3));
    const start = y + rng.intRange(1, 3);
    limb(t, x, start, z, rx, start, rz);
    for (let yy = start; yy > MIN_Y; yy--) {
      const below = world.getBlock(rx, yy - 1, rz);
      if (below !== 0 && T.fluid[below] !== 1) break;
      t.extra(rx, yy - 1, rz, roots);
      if (yy - 1 < start - 6) break;
    }
  }
  // Hanging propagules under the crown.
  const prop = S('mangrove_propagule',
    { age: rng.int(4), hanging: true, stage: 0, waterlogged: false });
  for (let i = 0; i < 6; i++) {
    const px = x + rng.intRange(-2, 2), pz = z + rng.intRange(-2, 2);
    if (!t.leaves.has(`${px},${top},${pz}`)) continue;
    t.extra(px, top - 1, pz, prop);
  }
  t.commit();
  return true;
}

/** Cherry: a forked trunk under a broad pink crown. */
export function treeCherry(world, x, y, z, rng) {
  const height = rng.intRange(7, 11);
  if (!rootable(world, x, y, z) || !hasRoom(world, x, y, z, height + 3, 4)) return false;
  const t = new TreeBuilder(world, 'cherry');
  const forkAt = rng.intRange(3, 5);
  for (let i = 0; i < forkAt; i++) t.log(x, y + i, z);
  const arms = rng.intRange(2, 3);
  for (let a = 0; a < arms; a++) {
    const dir = (a * 2 + rng.int(2)) & 3;
    const ddx = [0, 1, 0, -1][dir], ddz = [-1, 0, 1, 0][dir];
    const reach = rng.intRange(2, 4);
    const ex = x + ddx * reach, ez = z + ddz * reach;
    const ey = y + height - rng.intRange(0, 2);
    limb(t, x, y + forkAt - 1, z, ex, ey, ez);
    t.disc(ex, ey, ez, 3);
    t.disc(ex, ey + 1, ez, 2);
    t.disc(ex, ey - 1, ez, 2);
  }
  for (let i = forkAt; i < height; i++) t.log(x, y + i, z);
  t.disc(x, y + height, z, 3);
  t.disc(x, y + height + 1, z, 2);
  t.disc(x, y + height - 1, z, 3);
  t.commit();
  return true;
}

/** Azalea tree: rooted dirt below, oak trunk, azalea leaf crown. */
export function treeAzalea(world, x, y, z, rng) {
  if (!hasRoom(world, x, y, z, 8, 3)) return false;
  const height = rng.intRange(4, 6);
  const t = new TreeBuilder(world, 'oak');
  for (let i = 0; i < height; i++) t.log(x, y + i, z);
  if (rng.chance(0.5)) {
    const dir = rng.int(4);
    limb(t, x, y + height - 2, z,
      x + [0, 1, 0, -1][dir], y + height - 1, z + [-1, 0, 1, 0][dir]);
  }
  t.commit();
  // Azalea leaves are their own blocks, not the species' leaves.
  const plain = B('azalea_leaves');
  const flower = B('flowering_azalea_leaves');
  const top = y + height - 1;
  for (let dy = -1; dy <= 2; dy++) {
    const r = dy === 2 ? 1 : dy === -1 ? 2 : 2 + (dy === 0 ? 1 : 0);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r + 1) continue;
        putSoft(world, x + dx, top + dy, z + dz, rng.chance(0.25) ? flower : plain);
      }
    }
  }
  // Rooted dirt and hanging roots under the trunk, as if grown from a cave.
  const rooted = B('rooted_dirt');
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gy = groundY(world, x + dx, z + dz);
      if (gy >= MIN_Y && rng.chance(0.6)) put(world, x + dx, gy, z + dz, rooted);
    }
  }
  return true;
}

/** Swamp oak: a squat oak standing in shallow water, dripping with vines. */
export function treeSwampOak(world, x, y, z, rng) {
  const height = rng.intRange(5, 8);
  if (!hasRoom(world, x, y, z, height + 2, 3)) return false;
  const below = nameOf(world.getBlock(x, y - 1, z));
  if (!PLANT_SOIL.has(below) && below !== 'clay') return false;
  const t = new TreeBuilder(world, 'oak');
  for (let i = 0; i < height; i++) t.log(x, y + i, z);
  const top = y + height - 1;
  t.disc(x, top - 1, z, 3);
  t.disc(x, top, z, 2);
  t.disc(x, top + 1, z, 1);
  hangVines(t, x, z, top, 5, rng);
  t.commit();
  return true;
}

/** Vines dangling from the outside of a canopy. */
function hangVines(t, cx, cz, top, length, rng) {
  const faces = [['north', 0, -1], ['east', 1, 0], ['south', 0, 1], ['west', -1, 0]];
  for (let i = 0; i < 14; i++) {
    const dx = rng.intRange(-3, 3), dz = rng.intRange(-3, 3);
    if (Math.abs(dx) < 2 && Math.abs(dz) < 2) continue;
    const f = faces[rng.int(4)];
    const state = S('vine', {
      north: f[0] === 'north', east: f[0] === 'east',
      south: f[0] === 'south', west: f[0] === 'west', up: false,
    });
    const len = rng.intRange(1, length);
    for (let k = 0; k < len; k++) t.extra(cx + dx, top - k, cz + dz, state);
  }
}

/** A mossy fallen log lying on the ground. */
export function fallenLog(world, x, y, z, species, rng) {
  const len = rng.intRange(3, 6);
  const horizontal = rng.chance(0.5);
  const dx = horizontal ? 1 : 0, dz = horizontal ? 0 : 1;
  const axis = horizontal ? 'x' : 'z';
  const log = logState(species, axis);
  const stripped = S(`stripped_${species}_log`, { axis });
  if (log < 0) return false;
  for (let i = 0; i < len; i++) {
    const px = x + dx * i, pz = z + dz * i;
    const gy = groundY(world, px, pz);
    if (gy < MIN_Y || Math.abs(gy - y) > 1) return i > 2;
    putSoft(world, px, gy + 1, pz, (stripped >= 0 && rng.chance(0.2)) ? stripped : log);
    if (rng.chance(0.35)) {
      putSoft(world, px, gy + 2, pz, B(rng.chance(0.5) ? 'red_mushroom' : 'brown_mushroom'));
    }
  }
  return true;
}

const TREE_FNS = {
  oak: (w, x, y, z, r) => treeOak(w, x, y, z, r),
  fancy_oak: (w, x, y, z, r) => treeFancyOak(w, x, y, z, r),
  swamp_oak: (w, x, y, z, r) => treeSwampOak(w, x, y, z, r),
  birch: (w, x, y, z, r) => treeBirch(w, x, y, z, r, false),
  tall_birch: (w, x, y, z, r) => treeBirch(w, x, y, z, r, true),
  spruce: (w, x, y, z, r) => treeSpruce(w, x, y, z, r),
  pine: (w, x, y, z, r) => treePine(w, x, y, z, r),
  mega_spruce: (w, x, y, z, r) => treeMegaSpruce(w, x, y, z, r),
  jungle: (w, x, y, z, r) => treeJungle(w, x, y, z, r),
  mega_jungle: (w, x, y, z, r) => treeMegaJungle(w, x, y, z, r),
  acacia: (w, x, y, z, r) => treeAcacia(w, x, y, z, r),
  dark_oak: (w, x, y, z, r) => treeDarkOak(w, x, y, z, r),
  mangrove: (w, x, y, z, r) => treeMangrove(w, x, y, z, r),
  cherry: (w, x, y, z, r) => treeCherry(w, x, y, z, r),
  azalea: (w, x, y, z, r) => treeAzalea(w, x, y, z, r),
  huge_red_mushroom: (w, x, y, z, r) => hugeMushroom(w, x, y, z, 'red', r),
  huge_brown_mushroom: (w, x, y, z, r) => hugeMushroom(w, x, y, z, 'brown', r),
};

/** Place a named tree variant. Returns false when it did not fit. */
export function placeTree(world, x, y, z, kind, rng) {
  const fn = TREE_FNS[kind];
  return fn ? !!fn(world, x, y, z, rng) : false;
}

export const TREE_KINDS = Object.freeze(Object.keys(TREE_FNS));

// ---------------------------------------------------------------------------
// Huge mushrooms and nether fungi
// ---------------------------------------------------------------------------

/**
 * Set the six face properties of every mushroom block so the pale interior
 * texture shows only where the shape is actually open.
 */
function commitMushroom(world, cells) {
  const dirs = [['north', 0, 0, -1], ['east', 1, 0, 0], ['south', 0, 0, 1],
    ['west', -1, 0, 0], ['up', 0, 1, 0], ['down', 0, -1, 0]];
  for (const [key, entry] of cells) {
    const [x, y, z, name] = entry;
    const props = {};
    for (const [p, dx, dy, dz] of dirs) {
      props[p] = !cells.has(`${x + dx},${y + dy},${z + dz}`);
    }
    // The stem never shows a cap texture on its top or bottom.
    if (name === 'mushroom_stem') { props.up = false; props.down = false; }
    putSoft(world, x, y, z, S(name, props));
    void key;
  }
}

/** A huge red (domed) or brown (flat, wide) mushroom. */
export function hugeMushroom(world, x, y, z, kind, rng) {
  const height = kind === 'red' ? rng.intRange(5, 8) : rng.intRange(4, 6);
  if (!hasRoom(world, x, y, z, height + 2, 3)) return false;
  const below = nameOf(world.getBlock(x, y - 1, z));
  if (!PLANT_SOIL.has(below)) return false;
  const cap = `${kind}_mushroom_block`;
  if (B(cap) < 0) return false;
  const cells = new Map();
  const add = (px, py, pz, name) => cells.set(`${px},${py},${pz}`, [px, py, pz, name]);
  for (let i = 0; i < height; i++) add(x, y + i, z, 'mushroom_stem');
  const top = y + height;
  if (kind === 'brown') {
    const r = 3;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r) continue;
        add(x + dx, top, z + dz, cap);
      }
    }
  } else {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        add(x + dx, top, z + dz, cap);
      }
    }
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        add(x + dx, top - 1, z + dz, cap);
      }
    }
    add(x, top + 1, z, cap);
  }
  commitMushroom(world, cells);
  return true;
}

/** Crimson or warped huge fungus: stem, wart cap, shroomlight and vines. */
export function hugeFungus(world, x, y, z, kind, rng) {
  const crimson = kind === 'crimson';
  const stem = B(`${kind}_stem`);
  const wart = B(crimson ? 'nether_wart_block' : 'warped_wart_block');
  const shroom = B('shroomlight');
  if (stem < 0 || wart < 0) return false;
  const height = rng.intRange(5, 13);
  if (!hasRoom(world, x, y, z, height + 3, 3)) return false;
  const nyl = nameOf(world.getBlock(x, y - 1, z));
  if (nyl !== `${kind}_nylium` && nyl !== 'netherrack' && !PLANT_SOIL.has(nyl)) return false;

  for (let i = 0; i < height; i++) putSoft(world, x, y + i, z, stem);
  const top = y + height;
  for (let dy = 0; dy <= 2; dy++) {
    const r = dy === 2 ? 1 : 2;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx === 0 && dz === 0 && dy < 2) continue;
        if (dx * dx + dz * dz > r * r + 1) continue;
        const s = (shroom >= 0 && rng.chance(0.1)) ? shroom : wart;
        putSoft(world, x + dx, top - 2 + dy, z + dz, s);
      }
    }
  }
  putSoft(world, x, top, z, wart);
  // Weeping vines under a crimson cap, twisting vines climbing a warped one.
  const vine = crimson ? 'weeping_vines' : 'twisting_vines';
  for (let i = 0; i < 8; i++) {
    const vx = x + rng.intRange(-2, 2), vz = z + rng.intRange(-2, 2);
    if (vx === x && vz === z) continue;
    const len = rng.intRange(1, 4);
    for (let k = 1; k <= len; k++) {
      const py = crimson ? top - 3 - k : y + k;
      if (!putAir(world, vx, py, vz, S(vine, { age: rng.int(20) }))) break;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Small plants
// ---------------------------------------------------------------------------

const TWO_BLOCK = new Set(['tall_grass', 'large_fern', 'sunflower', 'lilac',
  'rose_bush', 'peony', 'pitcher_plant']);

/** Place a one- or two-block plant if the column supports it. */
export function placePlant(world, x, y, z, name) {
  const base = B(name);
  if (base < 0) return false;
  if (!PLANT_SOIL.has(nameOf(world.getBlock(x, y - 1, z)))) return false;
  if (TWO_BLOCK.has(name)) {
    const lower = S(name, { half: 'bottom' });
    const upper = S(name, { half: 'top' });
    if (!putSoft(world, x, y, z, lower)) return false;
    if (!putSoft(world, x, y + 1, z, upper)) { put(world, x, y, z, 0); return false; }
    return true;
  }
  return putSoft(world, x, y, z, base);
}

/** A blob of one plant type scattered around a centre. */
export function plantPatch(world, cx, cz, name, rng, tries = 24, radius = 4) {
  let placed = 0;
  for (let i = 0; i < tries; i++) {
    const x = cx + rng.intRange(-radius, radius);
    const z = cz + rng.intRange(-radius, radius);
    const y = groundY(world, x, z);
    if (y < MIN_Y) continue;
    if (placePlant(world, x, y + 1, z, name)) placed++;
  }
  return placed;
}

/** Grass and fern ground cover, biased to the biome's usual mix. */
export function grassPatch(world, cx, cz, rng, fernRatio = 0) {
  return plantPatch(world, cx, cz, rng.next() < fernRatio ? 'fern' : 'short_grass',
    rng, 20, 5);
}

export function deadBushPatch(world, cx, cz, rng) {
  const bush = B('dead_bush');
  let n = 0;
  for (let i = 0; i < 8; i++) {
    const x = cx + rng.intRange(-4, 4), z = cz + rng.intRange(-4, 4);
    const y = groundY(world, x, z);
    if (y < MIN_Y) continue;
    const on = nameOf(world.getBlock(x, y, z));
    if (on !== 'sand' && on !== 'red_sand' && on !== 'terracotta' &&
      !on.endsWith('_terracotta') && on !== 'dirt' && on !== 'podzol' &&
      on !== 'coarse_dirt' && on !== 'grass_block') continue;
    if (putSoft(world, x, y + 1, z, bush)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Water-side and desert plants
// ---------------------------------------------------------------------------

const CANE_BASE = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt',
  'podzol', 'sand', 'red_sand', 'moss_block', 'mud']);

export function sugarCane(world, x, z, rng) {
  const y = groundY(world, x, z);
  if (y < MIN_Y) return false;
  if (!CANE_BASE.has(nameOf(world.getBlock(x, y, z)))) return false;
  let nearWater = false;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const s = world.getBlock(x + dx, y, z + dz);
    if (T.fluid[s] === 1 || nameOf(s) === 'frosted_ice') { nearWater = true; break; }
  }
  if (!nearWater) return false;
  const h = rng.intRange(2, 4);
  let placed = 0;
  for (let i = 0; i < h; i++) {
    if (!putSoft(world, x, y + 1 + i, z, S('sugar_cane', { age: i === h - 1 ? rng.int(8) : 0 }))) break;
    placed++;
  }
  return placed > 0;
}

export function cactus(world, x, z, rng) {
  const y = groundY(world, x, z);
  if (y < MIN_Y) return false;
  const on = nameOf(world.getBlock(x, y, z));
  if (on !== 'sand' && on !== 'red_sand') return false;
  // Cactus needs clear sides or it breaks immediately.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (world.getBlock(x + dx, y + 1, z + dz) !== 0) return false;
  }
  const h = rng.intRange(1, 4);
  const st = B('cactus');
  for (let i = 0; i < h; i++) if (!putSoft(world, x, y + 1 + i, z, st)) return i > 0;
  return true;
}

export function bambooStalk(world, x, z, rng) {
  const y = groundY(world, x, z);
  if (y < MIN_Y) return false;
  const on = nameOf(world.getBlock(x, y, z));
  if (!CANE_BASE.has(on) && on !== 'gravel') return false;
  const h = rng.intRange(5, 14);
  for (let i = 0; i < h; i++) {
    const leaves = i < 2 ? 'none' : (i > h - 4 ? 'large' : 'small');
    if (!putSoft(world, x, y + 1 + i, z,
      S('bamboo', { age: 1, leaves, stage: 0 }))) return i > 0;
  }
  return true;
}

/** A patch of pumpkins (or melons in the jungle) on grass. */
export function gourdPatch(world, cx, cz, rng, melon = false) {
  const gourd = B(melon ? 'melon' : 'pumpkin');
  if (gourd < 0) return 0;
  let n = 0;
  for (let i = 0; i < 12; i++) {
    const x = cx + rng.intRange(-4, 4), z = cz + rng.intRange(-4, 4);
    const y = groundY(world, x, z);
    if (y < MIN_Y) continue;
    if (!PLANT_SOIL.has(nameOf(world.getBlock(x, y, z)))) continue;
    if (putSoft(world, x, y + 1, z, gourd)) n++;
  }
  return n;
}

export function berryBush(world, x, z, rng) {
  const y = groundY(world, x, z);
  if (y < MIN_Y) return false;
  const on = nameOf(world.getBlock(x, y, z));
  if (on !== 'grass_block' && on !== 'podzol' && on !== 'coarse_dirt') return false;
  return putSoft(world, x, y + 1, z, S('sweet_berry_bush', { age: rng.intRange(1, 3) }));
}

export function lilyPad(world, x, z, rng) {
  const y = groundY(world, x, z);
  if (y < MIN_Y) return false;
  const depth = waterDepth(world, x, z);
  if (depth < 1 || depth > 3) return false;
  const surface = y + depth;
  if (world.getBlock(x, surface + 1, z) !== 0) return false;
  void rng;
  return putAir(world, x, surface + 1, z, B('lily_pad'));
}

export function seagrassPatch(world, cx, cz, rng) {
  const tall = S('tall_seagrass', { half: 'bottom' });
  const tallTop = S('tall_seagrass', { half: 'top' });
  const short = B('seagrass');
  let n = 0;
  for (let i = 0; i < 24; i++) {
    const x = cx + rng.intRange(-6, 6), z = cz + rng.intRange(-6, 6);
    const y = groundY(world, x, z);
    if (y < MIN_Y) continue;
    if (waterDepth(world, x, z) < 2) continue;
    if (T.fluid[world.getBlock(x, y + 1, z)] !== 1) continue;
    if (rng.chance(0.3) && T.fluid[world.getBlock(x, y + 2, z)] === 1) {
      if (put(world, x, y + 1, z, tall) && put(world, x, y + 2, z, tallTop)) n++;
    } else if (put(world, x, y + 1, z, short)) n++;
  }
  return n;
}

export function kelpColumn(world, x, z, rng) {
  const y = groundY(world, x, z);
  if (y < MIN_Y) return false;
  const depth = waterDepth(world, x, z);
  if (depth < 3) return false;
  const h = Math.min(depth - 1, rng.intRange(3, 20));
  const plant = B('kelp_plant');
  for (let i = 0; i < h - 1; i++) {
    if (T.fluid[world.getBlock(x, y + 1 + i, z)] !== 1) return i > 0;
    put(world, x, y + 1 + i, z, plant);
  }
  put(world, x, y + h, z, S('kelp', { age: rng.int(20) }));
  return true;
}

/**
 * A warm-ocean coral reef.
 *
 * The coral block family is optional content; when it is not registered the
 * reef still forms, built from prismarine and sea lanterns, which keeps warm
 * oceans visibly different from cold ones either way.
 */
export function coralReef(world, cx, cz, rng) {
  const palette = [
    firstOf('tube_coral_block', 'prismarine'),
    firstOf('brain_coral_block', 'prismarine_bricks'),
    firstOf('bubble_coral_block', 'dark_prismarine'),
    firstOf('fire_coral_block', 'prismarine'),
    firstOf('horn_coral_block', 'prismarine_bricks'),
  ].filter((s) => s >= 0);
  if (!palette.length) return false;
  const fans = [
    firstOf('tube_coral', 'seagrass'),
    firstOf('fire_coral', 'seagrass'),
    firstOf('horn_coral', 'seagrass'),
  ].filter((s) => s >= 0);
  const lantern = B('sea_lantern');

  const gy = groundY(world, cx, cz);
  if (gy < MIN_Y || waterDepth(world, cx, cz) < 4) return false;
  let placed = 0;
  const blobs = rng.intRange(3, 7);
  for (let b = 0; b < blobs; b++) {
    const bx = cx + rng.intRange(-5, 5), bz = cz + rng.intRange(-5, 5);
    const by = groundY(world, bx, bz);
    if (by < MIN_Y || waterDepth(world, bx, bz) < 3) continue;
    const r = rng.intRange(1, 3);
    const coral = palette[rng.int(palette.length)];
    for (let dy = 0; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy * 2 + dz * dz > r * r + 1) continue;
          if (T.fluid[world.getBlock(bx + dx, by + 1 + dy, bz + dz)] !== 1) continue;
          if (put(world, bx + dx, by + 1 + dy, bz + dz, coral)) placed++;
        }
      }
    }
    if (fans.length && rng.chance(0.6)) {
      put(world, bx, by + r + 2, bz, fans[rng.int(fans.length)]);
    }
    if (lantern >= 0 && rng.oneIn(6)) put(world, bx, by + 1, bz, lantern);
  }
  return placed > 0;
}

// ---------------------------------------------------------------------------
// Ice
// ---------------------------------------------------------------------------

export function iceSpike(world, x, z, rng) {
  const packed = B('packed_ice');
  if (packed < 0) return false;
  const y = groundY(world, x, z);
  if (y < MIN_Y) return false;
  const height = rng.intRange(7, 24);
  const radius = 1 + rng.int(2);
  if (!hasRoom(world, x, y + 1, z, height, radius + 1)) return false;
  for (let dy = 0; dy < height; dy++) {
    const t = dy / height;
    const r = Math.max(0, Math.round(radius * (1 - t * t)));
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r + 0.5) continue;
        putSoft(world, x + dx, y + 1 + dy, z + dz, packed);
      }
    }
  }
  // A stubby second spike alongside, the way ice spikes cluster.
  if (rng.chance(0.35)) {
    const sx = x + rng.intRange(-3, 3), sz = z + rng.intRange(-3, 3);
    const sy = groundY(world, sx, sz);
    if (sy >= MIN_Y) {
      const h2 = Math.floor(height * 0.5);
      for (let dy = 0; dy < h2; dy++) putSoft(world, sx, sy + 1 + dy, sz, packed);
    }
  }
  return true;
}

export function iceberg(world, x, z, rng) {
  const packed = B('packed_ice');
  const blue = B('blue_ice');
  if (packed < 0) return false;
  const gy = groundY(world, x, z);
  if (gy >= SEA_LEVEL - 4) return false;
  const above = rng.intRange(6, 22);
  const below = Math.floor(above * 0.6);
  const rx = rng.intRange(4, 11), rz = rng.intRange(4, 11);
  for (let dy = -below; dy <= above; dy++) {
    const t = dy < 0 ? 1 - dy / (below + 2) : 1 - dy / (above + 1);
    const ax = Math.max(1, Math.round(rx * t)), az = Math.max(1, Math.round(rz * t));
    const y = SEA_LEVEL + dy;
    if (y <= MIN_Y || y > MAX_Y) continue;
    for (let dz = -az; dz <= az; dz++) {
      for (let dx = -ax; dx <= ax; dx++) {
        if ((dx * dx) / (ax * ax) + (dz * dz) / (az * az) > 1) continue;
        const s = world.getBlock(x + dx, y, z + dz);
        if (s !== 0 && T.fluid[s] !== 1 && nameOf(s) !== 'ice') continue;
        put(world, x + dx, y, z + dz,
          (blue >= 0 && dy < -below + 2 && rng.chance(0.4)) ? blue : packed);
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Lakes, springs and disks
// ---------------------------------------------------------------------------

/** Carve an ellipsoid basin and fill it with water or lava. */
export function lake(world, x, y, z, fluid, rng) {
  const state = B(fluid === 'lava' ? 'lava' : 'water');
  if (state < 0) return false;
  const rx = rng.intRange(4, 7), rz = rng.intRange(4, 7), ry = rng.intRange(2, 3);
  const air = 0;
  const stone = B('stone');
  for (let dy = -ry; dy <= ry + 1; dy++) {
    for (let dz = -rz; dz <= rz; dz++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const d = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) + (dz * dz) / (rz * rz);
        if (d > 1) continue;
        const px = x + dx, py = y + dy, pz = z + dz;
        if (py < MIN_Y + 2 || py > MAX_Y - 1) continue;
        if (dy > 0) put(world, px, py, pz, air);
        else put(world, px, py, pz, state);
      }
    }
  }
  // Seal the rim so the fluid does not immediately drain into a cave.
  for (let dy = -ry - 1; dy <= ry + 1; dy++) {
    for (let dz = -rz - 1; dz <= rz + 1; dz++) {
      for (let dx = -rx - 1; dx <= rx + 1; dx++) {
        const d = (dx * dx) / ((rx + 1) * (rx + 1)) + (dy * dy) / ((ry + 1) * (ry + 1)) +
          (dz * dz) / ((rz + 1) * (rz + 1));
        if (d > 1) continue;
        const px = x + dx, py = y + dy, pz = z + dz;
        if (world.getBlock(px, py, pz) !== 0) continue;
        const inner = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) + (dz * dz) / (rz * rz);
        if (inner <= 1) continue;
        if (dy <= 0) put(world, px, py, pz, stone);
      }
    }
  }
  return true;
}

/** A single fluid source poking out of a cave wall. */
export function spring(world, x, y, z, fluid) {
  const state = B(fluid === 'lava' ? 'lava' : 'water');
  if (state < 0) return false;
  if (world.getBlock(x, y, z) !== 0) return false;
  ensureTables();
  if (!TERRAIN[world.getBlock(x, y + 1, z)]) return false;
  if (!TERRAIN[world.getBlock(x, y - 1, z)]) return false;
  let walls = 0, open = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const s = world.getBlock(x + dx, y, z + dz);
    if (s === 0) open++;
    else if (TERRAIN[s]) walls++;
  }
  if (walls !== 3 || open !== 1) return false;
  return put(world, x, y, z, state);
}

/** A flat disk of clay, sand or gravel in a lake or river bed. */
export function disk(world, x, z, blockName, rng, maxRadius = 4) {
  const state = B(blockName);
  if (state < 0) return false;
  const y = groundY(world, x, z);
  if (y < MIN_Y) return false;
  if (T.fluid[world.getBlock(x, y + 1, z)] !== 1) return false;
  const r = rng.intRange(2, maxRadius);
  let n = 0;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > r * r) continue;
      const px = x + dx, pz = z + dz;
      const py = groundY(world, px, pz);
      if (py < MIN_Y || Math.abs(py - y) > 2) continue;
      if (T.fluid[world.getBlock(px, py + 1, pz)] !== 1) continue;
      const cur = nameOf(world.getBlock(px, py, pz));
      if (cur !== 'dirt' && cur !== 'grass_block' && cur !== 'sand' &&
        cur !== 'gravel' && cur !== 'clay' && cur !== 'stone') continue;
      for (let d = 0; d < (blockName === 'clay' ? 2 : 3); d++) {
        if (put(world, px, py - d, pz, state)) n++;
      }
    }
  }
  return n > 0;
}

// ---------------------------------------------------------------------------
// Cave decoration
// ---------------------------------------------------------------------------

/** Moss, glow berries, dripleaf, spore blossoms and azalea in a cave pocket. */
export function lushCaveSpot(world, x, y, z, rng) {
  ensureTables();
  if (world.getBlock(x, y, z) !== 0) return false;
  const floor = world.getBlock(x, y - 1, z);
  const ceiling = world.getBlock(x, y + 1, z);
  let did = false;

  if (TERRAIN[floor]) {
    put(world, x, y - 1, z, B('moss_block'));
    did = true;
    const roll = rng.next();
    if (roll < 0.28) putAir(world, x, y, z, B('moss_carpet'));
    else if (roll < 0.4) putAir(world, x, y, z, B('short_grass'));
    else if (roll < 0.48) {
      putAir(world, x, y, z, S('big_dripleaf',
        { facing: ['north', 'east', 'south', 'west'][rng.int(4)], tilt: 'none', waterlogged: false }));
    } else if (roll < 0.56) putAir(world, x, y, z, B('small_dripleaf'));
    else if (roll < 0.62) putAir(world, x, y, z, B(rng.chance(0.5) ? 'azalea' : 'flowering_azalea'));
    // Moss creeps outward across the floor.
    for (let i = 0; i < 6; i++) {
      const mx = x + rng.intRange(-3, 3), mz = z + rng.intRange(-3, 3);
      const my = y - 1;
      if (TERRAIN[world.getBlock(mx, my, mz)] && world.getBlock(mx, my + 1, mz) === 0) {
        put(world, mx, my, mz, B('moss_block'));
      }
    }
  }
  if (TERRAIN[ceiling]) {
    if (rng.chance(0.35)) {
      putAir(world, x, y, z, B('spore_blossom'));
      did = true;
    } else {
      // Cave vines: a stem chain ending in a berry-bearing tip.
      const len = rng.intRange(2, 8);
      const plant = B('cave_vines_plant');
      for (let i = 0; i < len; i++) {
        const py = y - i;
        const tip = i === len - 1;
        const st = tip
          ? S('cave_vines', { age: rng.int(25), berries: rng.chance(0.35) })
          : plant;
        if (!putAir(world, x, py, z, st)) break;
        did = true;
      }
    }
    put(world, x, y + 1, z, B('moss_block'));
  }
  return did;
}

/** Stalactites hanging from a cave roof and stalagmites rising from its floor. */
export function dripstoneSpot(world, x, y, z, rng) {
  ensureTables();
  if (world.getBlock(x, y, z) !== 0) return false;
  const up = TERRAIN[world.getBlock(x, y + 1, z)];
  const down = TERRAIN[world.getBlock(x, y - 1, z)];
  const thickness = ['tip', 'frustum', 'middle', 'base'];
  let did = false;
  if (up) {
    const len = rng.intRange(1, 5);
    for (let i = 0; i < len; i++) {
      const th = thickness[Math.min(3, len - 1 - i)];
      if (!putAir(world, x, y - i, z,
        S('pointed_dripstone', { thickness: th, vertical_direction: 'down', waterlogged: false }))) break;
      did = true;
    }
  } else if (down) {
    const len = rng.intRange(1, 4);
    for (let i = 0; i < len; i++) {
      const th = thickness[Math.min(3, len - 1 - i)];
      if (!putAir(world, x, y + i, z,
        S('pointed_dripstone', { thickness: th, vertical_direction: 'up', waterlogged: false }))) break;
      did = true;
    }
  }
  if (did && rng.chance(0.4)) {
    const blob = B('dripstone_block');
    const cy = up ? y + 1 : y - 1;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (TERRAIN[world.getBlock(x + dx, cy, z + dz)] && rng.chance(0.6)) {
          put(world, x + dx, cy, z + dz, blob);
        }
      }
    }
  }
  return did;
}

/** An amethyst geode: basalt shell, calcite lining, budding crystal interior. */
export function geode(world, x, y, z, rng) {
  const inner = B('amethyst_block');
  const budding = B('budding_amethyst');
  const calcite = B('calcite');
  const shell = B('smooth_basalt');
  if (inner < 0 || calcite < 0 || shell < 0) return false;
  const r = rng.intRange(4, 6);
  // Reject anything intersecting open air or fluid: geodes are sealed pockets.
  for (let dy = -r - 1; dy <= r + 1; dy++) {
    for (let dz = -r - 1; dz <= r + 1; dz++) {
      for (let dx = -r - 1; dx <= r + 1; dx++) {
        if (dx * dx + dy * dy + dz * dz > (r + 1) * (r + 1)) continue;
        const s = world.getBlock(x + dx, y + dy, z + dz);
        if (s === 0 || T.fluid[s]) return false;
      }
    }
  }
  const buds = ['small_amethyst_bud', 'medium_amethyst_bud', 'large_amethyst_bud',
    'amethyst_cluster'];
  for (let dy = -r - 1; dy <= r + 1; dy++) {
    for (let dz = -r - 1; dz <= r + 1; dz++) {
      for (let dx = -r - 1; dx <= r + 1; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + rng.next() * 0.6 - 0.3;
        const px = x + dx, py = y + dy, pz = z + dz;
        if (d > r + 1) continue;
        if (d > r) put(world, px, py, pz, shell);
        else if (d > r - 1) put(world, px, py, pz, calcite);
        else if (d > r - 2) put(world, px, py, pz, rng.chance(0.12) && budding >= 0 ? budding : inner);
        else put(world, px, py, pz, 0);
      }
    }
  }
  // Crystals growing inward off the amethyst lining.
  const faces = [['up', 0, -1, 0], ['down', 0, 1, 0], ['north', 0, 0, 1],
    ['south', 0, 0, -1], ['west', 1, 0, 0], ['east', -1, 0, 0]];
  for (let i = 0; i < 40; i++) {
    const a = rng.next() * Math.PI * 2, b = rng.next() * Math.PI - Math.PI / 2;
    const rr = r - 2;
    const px = x + Math.round(Math.cos(a) * Math.cos(b) * rr);
    const py = y + Math.round(Math.sin(b) * rr);
    const pz = z + Math.round(Math.sin(a) * Math.cos(b) * rr);
    if (world.getBlock(px, py, pz) !== 0) continue;
    const f = faces[rng.int(6)];
    const support = world.getBlock(px + f[1], py + f[2], pz + f[3]);
    if (support !== inner && support !== budding) continue;
    putAir(world, px, py, pz, S(buds[rng.int(buds.length)],
      { facing: f[0], waterlogged: false }));
  }
  return true;
}

/** A buried skeleton of bone blocks, the way fossils appear in deserts. */
export function fossil(world, x, y, z, rng) {
  const bone = B('bone_block');
  const coal = B('coal_ore');
  if (bone < 0) return false;
  const horizontal = rng.chance(0.5);
  const len = rng.intRange(6, 12);
  const ribs = rng.intRange(3, 6);
  let placed = 0;
  ensureTables();
  const spineAxis = horizontal ? 'x' : 'z';
  const spine = S('bone_block', { axis: spineAxis });
  for (let i = 0; i < len; i++) {
    const px = x + (horizontal ? i : 0), pz = z + (horizontal ? 0 : i);
    const s = world.getBlock(px, y, pz);
    if (s === 0 || T.fluid[s]) continue;
    if (put(world, px, y, pz, rng.chance(0.1) && coal >= 0 ? coal : spine)) placed++;
  }
  const ribAxis = horizontal ? 'z' : 'x';
  const rib = S('bone_block', { axis: ribAxis });
  for (let r = 0; r < ribs; r++) {
    const at = rng.int(len);
    const bx = x + (horizontal ? at : 0), bz = z + (horizontal ? 0 : at);
    for (const side of [-1, 1]) {
      for (let i = 1; i <= rng.intRange(1, 3); i++) {
        const px = bx + (horizontal ? 0 : side * i), pz = bz + (horizontal ? side * i : 0);
        const py = y + (i > 1 ? 1 : 0);
        const s = world.getBlock(px, py, pz);
        if (s === 0 || T.fluid[s]) continue;
        if (put(world, px, py, pz, rib)) placed++;
      }
    }
  }
  return placed > 4;
}

/** The little sandstone well found in deserts. */
export function desertWell(world, x, z) {
  const y = groundY(world, x, z);
  if (y < MIN_Y) return false;
  const on = nameOf(world.getBlock(x, y, z));
  if (on !== 'sand' && on !== 'red_sand') return false;
  const sandstone = B('sandstone');
  const slab = S('sandstone_slab', { type: 'bottom', waterlogged: false });
  const water = B('water');
  if (sandstone < 0) return false;
  const base = y + 1;
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
      put(world, x + dx, base - 1, z + dz, sandstone);
      put(world, x + dx, base, z + dz, 0);
    }
  }
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const edge = Math.abs(dx) === 1 || Math.abs(dz) === 1;
      put(world, x + dx, base, z + dz, edge ? sandstone : water);
      if (!edge) put(world, x + dx, base - 1, z + dz, water);
    }
  }
  // Four pillars and a slab roof.
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    for (let h = 1; h <= 3; h++) put(world, x + dx, base + h, z + dz, sandstone);
  }
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) put(world, x + dx, base + 4, z + dz, sandstone);
  }
  if (slab >= 0) {
    for (const [dx, dz] of [[0, -2], [0, 2], [-2, 0], [2, 0]]) {
      put(world, x + dx, base, z + dz, slab);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Registry-driven growth (called from block behaviour through world.game)
// ---------------------------------------------------------------------------

/** Count matching saplings in a 2x2 with (x,z) at the given corner. */
function saplingSquare(world, x, y, z, name) {
  for (const [ox, oz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
    let ok = true;
    for (let dz = 0; dz <= 1 && ok; dz++) {
      for (let dx = 0; dx <= 1 && ok; dx++) {
        if (nameOf(world.getBlock(x + ox + dx, y, z + oz + dz)) !== name) ok = false;
      }
    }
    if (ok) return { x: x + ox, z: z + oz };
  }
  return null;
}

/** Clear the 2x2 of saplings a mega tree is about to replace. */
function clearSquare(world, x, y, z) {
  for (let dz = 0; dz <= 1; dz++) {
    for (let dx = 0; dx <= 1; dx++) put(world, x + dx, y, z + dz, 0);
  }
}

/**
 * Grow the tree a sapling turns into.
 * Called by the block registry as `world.game.features.growTree(...)`.
 */
export function growTree(world, x, y, z, kind, random) {
  const rng = random || new Random(hash3(world.seed, x, y, z));
  const species = String(kind || 'oak').replace(/_sapling$/, '');
  const sapling = species === 'mangrove' ? 'mangrove_propagule' : `${species}_sapling`;

  // Mega variants need four saplings in a square.
  if (species === 'spruce' || species === 'jungle' || species === 'dark_oak') {
    const sq = saplingSquare(world, x, y, z, sapling);
    if (sq) {
      clearSquare(world, sq.x, y, sq.z);
      const fn = species === 'spruce' ? treeMegaSpruce
        : species === 'jungle' ? treeMegaJungle : treeDarkOak;
      if (fn(world, sq.x, y, sq.z, rng)) return true;
      // Put the saplings back if the giant did not fit.
      const s = B(sapling);
      for (let dz = 0; dz <= 1; dz++) {
        for (let dx = 0; dx <= 1; dx++) put(world, sq.x + dx, y, sq.z + dz, s);
      }
      if (species === 'dark_oak') return false;
    } else if (species === 'dark_oak') {
      return false;     // dark oak only grows as a 2x2
    }
  }

  put(world, x, y, z, 0);
  let ok = false;
  switch (species) {
    case 'oak':
      ok = rng.oneIn(10) ? treeFancyOak(world, x, y, z, rng) : treeOak(world, x, y, z, rng);
      break;
    case 'birch':
      ok = treeBirch(world, x, y, z, rng, rng.oneIn(6));
      break;
    case 'spruce':
      ok = rng.oneIn(3) ? treePine(world, x, y, z, rng) : treeSpruce(world, x, y, z, rng);
      break;
    case 'jungle': ok = treeJungle(world, x, y, z, rng); break;
    case 'acacia': ok = treeAcacia(world, x, y, z, rng); break;
    case 'mangrove': ok = treeMangrove(world, x, y, z, rng); break;
    case 'cherry': ok = treeCherry(world, x, y, z, rng); break;
    case 'azalea': ok = treeAzalea(world, x, y, z, rng); break;
    case 'dark_oak': ok = false; break;
    default: ok = treeOak(world, x, y, z, rng, { species }); break;
  }
  if (!ok) put(world, x, y, z, B(sapling));
  return ok;
}

/** Grow a huge crimson or warped fungus from a small one. */
export function growFungus(world, x, y, z, kind, random) {
  const rng = random || new Random(hash3(world.seed, x, y, z));
  const k = String(kind || 'crimson').replace(/_fungus$/, '');
  put(world, x, y, z, 0);
  const ok = hugeFungus(world, x, y, z, k, rng);
  if (!ok) put(world, x, y, z, B(`${k}_fungus`));
  return ok;
}

const CHORUS_FACES = ['north', 'east', 'south', 'west'];

function chorusConnections(world, x, y, z) {
  const props = { north: false, east: false, south: false, west: false, up: false, down: false };
  const dirs = [['north', 0, 0, -1], ['east', 1, 0, 0], ['south', 0, 0, 1],
    ['west', -1, 0, 0], ['up', 0, 1, 0], ['down', 0, -1, 0]];
  for (const [p, dx, dy, dz] of dirs) {
    const n = nameOf(world.getBlock(x + dx, y + dy, z + dz));
    if (n === 'chorus_plant' || n === 'chorus_flower' ||
      (p === 'down' && n === 'end_stone')) props[p] = true;
  }
  return props;
}

/** One growth step of a chorus flower: rise, branch, or wither. */
export function growChorus(world, x, y, z, state, random) {
  const rng = random || new Random(hash3(world.seed, x, y, z));
  const flower = blocksByName.get('chorus_flower');
  if (!flower) return false;
  const age = flower.stateDef.get(state - flower.base, 'age') ?? 0;
  if (age >= 5) return false;

  // How tall is the stalk under this flower?
  let height = 0;
  while (height < 6 && nameOf(world.getBlock(x, y - 1 - height, z)) === 'chorus_plant') height++;
  const onEndStone = nameOf(world.getBlock(x, y - 1 - height, z)) === 'end_stone';

  const above = world.getBlock(x, y + 1, z);
  const canRise = above === 0 && y + 1 < MAX_Y - 1 && height < (onEndStone ? 4 : 3);
  if (canRise && rng.chance(0.85 - height * 0.15)) {
    put(world, x, y, z, S('chorus_plant', chorusConnections(world, x, y, z)));
    put(world, x, y + 1, z, S('chorus_flower', { age }));
    put(world, x, y, z, S('chorus_plant', chorusConnections(world, x, y, z)));
    return true;
  }

  // Otherwise branch sideways, or die back.
  let branched = false;
  const order = rng.shuffle([0, 1, 2, 3]);
  const branches = rng.intRange(0, 3);
  for (let i = 0; i < branches; i++) {
    const d = order[i];
    const dx = [0, 1, 0, -1][d], dz = [-1, 0, 1, 0][d];
    const bx = x + dx, bz = z + dz;
    if (world.getBlock(bx, y, bz) !== 0) continue;
    if (world.getBlock(bx, y - 1, bz) !== 0) continue;
    let neighbours = 0;
    for (const f of CHORUS_FACES) {
      const fi = CHORUS_FACES.indexOf(f);
      const nx = bx + [0, 1, 0, -1][fi], nz = bz + [-1, 0, 1, 0][fi];
      const n = nameOf(world.getBlock(nx, y, nz));
      if (n === 'chorus_plant' || n === 'chorus_flower') neighbours++;
    }
    if (neighbours > 1) continue;
    put(world, bx, y, bz, S('chorus_flower', { age: age + 1 }));
    branched = true;
  }
  if (branched) {
    put(world, x, y, z, S('chorus_plant', chorusConnections(world, x, y, z)));
  } else {
    put(world, x, y, z, S('chorus_flower', { age: 5 }));
  }
  return true;
}

/** A whole chorus plant grown from scratch, for End decoration. */
export function chorusPlant(world, x, y, z, rng) {
  if (nameOf(world.getBlock(x, y - 1, z)) !== 'end_stone') return false;
  if (world.getBlock(x, y, z) !== 0) return false;
  const trunk = rng.intRange(2, 6);
  for (let i = 0; i < trunk; i++) {
    if (!putAir(world, x, y + i, z, B('chorus_plant'))) break;
  }
  put(world, x, y + trunk, z, S('chorus_flower', { age: 0 }));
  const arms = rng.intRange(0, 3);
  for (let a = 0; a < arms; a++) {
    const at = y + rng.intRange(1, Math.max(1, trunk - 1));
    const d = rng.int(4);
    const dx = [0, 1, 0, -1][d], dz = [-1, 0, 1, 0][d];
    const len = rng.intRange(1, 3);
    for (let i = 1; i <= len; i++) putAir(world, x + dx * i, at, z + dz * i, B('chorus_plant'));
    putAir(world, x + dx * len, at + 1, z + dz * len, S('chorus_flower', { age: 0 }));
  }
  // Fix up connections now the whole plant exists.
  for (let dy = -1; dy <= trunk + 2; dy++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const px = x + dx, py = y + dy, pz = z + dz;
        if (nameOf(world.getBlock(px, py, pz)) !== 'chorus_plant') continue;
        put(world, px, py, pz, S('chorus_plant', chorusConnections(world, px, py, pz)));
      }
    }
  }
  return true;
}

/**
 * Light an obsidian portal frame containing (x,y,z).
 * Returns true when a valid frame was found and filled.
 */
export function lightNetherPortal(world, x, y, z) {
  for (const axis of ['x', 'z']) {
    const frame = findPortalFrame(world, x, y, z, axis);
    if (!frame) continue;
    const state = S('nether_portal', { axis });
    if (state < 0) return false;
    const dx = axis === 'x' ? 1 : 0, dz = axis === 'z' ? 1 : 0;
    for (let i = 0; i < frame.width; i++) {
      for (let j = 0; j < frame.height; j++) {
        world.setBlock(frame.x + dx * i, frame.y + j, frame.z + dz * i, state,
          FLAG.UPDATE_LIGHT | FLAG.MARK_DIRTY);
      }
    }
    world.playSound?.('portal.trigger', x + 0.5, y + 0.5, z + 0.5, 0.6, 1);
    return true;
  }
  return false;
}

const PORTAL_EMPTY = new Set(['air', 'fire', 'nether_portal', 'soul_fire']);

function findPortalFrame(world, x, y, z, axis) {
  const dx = axis === 'x' ? 1 : 0, dz = axis === 'z' ? 1 : 0;
  const empty = (px, py, pz) => PORTAL_EMPTY.has(nameOf(world.getBlock(px, py, pz)));
  const frame = (px, py, pz) => nameOf(world.getBlock(px, py, pz)) === 'obsidian';
  if (!empty(x, y, z)) return null;

  // Walk to the bottom-left interior corner.
  let by = y;
  while (by > MIN_Y + 1 && empty(x, by - 1, z)) { by--; if (y - by > 22) return null; }
  if (!frame(x, by - 1, z)) return null;
  let bx = x, bz = z;
  while (empty(bx - dx, by, bz - dz)) {
    bx -= dx; bz -= dz;
    if (Math.abs(bx - x) + Math.abs(bz - z) > 22) return null;
  }
  if (!frame(bx - dx, by, bz - dz)) return null;

  let width = 0;
  while (width < 21 && empty(bx + dx * width, by, bz + dz * width)) width++;
  if (width < 2 || width > 21) return null;
  if (!frame(bx + dx * width, by, bz + dz * width)) return null;

  let height = 0;
  while (height < 21) {
    let row = true;
    for (let i = 0; i < width; i++) {
      if (!empty(bx + dx * i, by + height, bz + dz * i)) { row = false; break; }
    }
    if (!row) break;
    if (!frame(bx - dx, by + height, bz - dz)) return null;
    if (!frame(bx + dx * width, by + height, bz + dz * width)) return null;
    height++;
  }
  if (height < 3 || height > 21) return null;
  for (let i = 0; i < width; i++) {
    if (!frame(bx + dx * i, by + height, bz + dz * i)) return null;
    if (!frame(bx + dx * i, by - 1, bz + dz * i)) return null;
  }
  return { x: bx, y: by, z: bz, width, height };
}

// ---------------------------------------------------------------------------
// Chunk decoration
// ---------------------------------------------------------------------------

/** A forked generator for one decoration pass. Order-independent by design. */
function pass(world, chunk, salt) {
  return new Random(hash3(world.seed ^ salt, chunk.cx, salt, chunk.cz) | 0);
}

/**
 * Decorate one chunk. Called by the chunk streamer after every neighbour has
 * terrain, so features may safely spill a few blocks across the border.
 */
export function decorateChunk(world, chunk, generator, random) {
  ensureTables();
  const dim = world.dimension || 'overworld';
  try {
    if (dim === 'nether') decorateNether(world, chunk, generator, random);
    else if (dim === 'end') decorateEnd(world, chunk, generator, random);
    else decorateOverworld(world, chunk, generator, random);
  } catch (e) {
    console.error('feature decoration failed', chunk.cx, chunk.cz, e);
  }
  return chunk;
}

const SALT = {
  lake: 0x1a2b3c, spring: 0x2b3c4d, disk: 0x3c4d5e, geode: 0x4d5e6f,
  fossil: 0x5e6f70, cave: 0x6f7081, tree: 0x708192, plant: 0x8192a3,
  water: 0x92a3b4, ice: 0xa3b4c5, special: 0xb4c5d6, nether: 0xc5d6e7,
  end: 0xd6e7f8,
};

function decorateOverworld(world, chunk, generator, random) {
  const x0 = chunk.x0, z0 = chunk.z0;
  const centreCat = biomeCategory(world, x0 + 8, z0 + 8);
  const content = contentFor(centreCat);

  undergroundPass(world, chunk, generator);

  // -- lakes ---------------------------------------------------------------
  const lakeRng = pass(world, chunk, SALT.lake);
  if (!isAquatic(centreCat) && lakeRng.oneIn(48)) {
    const lx = x0 + lakeRng.int(16), lz = z0 + lakeRng.int(16);
    const ly = groundY(world, lx, lz);
    if (ly > SEA_LEVEL - 2) lake(world, lx, ly - 1, lz, 'water', lakeRng);
  }
  if (lakeRng.oneIn(90)) {
    const lx = x0 + lakeRng.int(16), lz = z0 + lakeRng.int(16);
    const ly = lakeRng.chance(0.75)
      ? lakeRng.intRange(-54, 10)
      : groundY(world, lx, lz) - 1;
    if (ly > MIN_Y + 4) lake(world, lx, ly, lz, 'lava', lakeRng);
  }

  // -- riverbed disks ------------------------------------------------------
  const diskRng = pass(world, chunk, SALT.disk);
  for (const [name, tries] of [['clay', 1], ['sand', 3], ['gravel', 2]]) {
    for (let i = 0; i < tries; i++) {
      if (!diskRng.chance(0.55)) continue;
      disk(world, x0 + diskRng.int(16), z0 + diskRng.int(16), name, diskRng,
        name === 'clay' ? 3 : 5);
    }
  }

  // -- ice -----------------------------------------------------------------
  const iceRng = pass(world, chunk, SALT.ice);
  const spikes = draw(iceRng, content.iceSpikes || 0);
  for (let i = 0; i < spikes; i++) {
    iceSpike(world, x0 + iceRng.int(16), z0 + iceRng.int(16), iceRng);
  }
  if (iceRng.next() < (content.icebergs || 0)) {
    iceberg(world, x0 + iceRng.int(16), z0 + iceRng.int(16), iceRng);
  }

  // -- trees ---------------------------------------------------------------
  const treeRng = pass(world, chunk, SALT.tree);
  const trees = draw(treeRng, content.trees || 0);
  const kinds = content.treeKinds || [['oak', 1]];
  for (let i = 0; i < trees; i++) {
    const tx = x0 + treeRng.int(16), tz = z0 + treeRng.int(16);
    const ty = groundY(world, tx, tz);
    if (ty < MIN_Y || ty < SEA_LEVEL - 2) continue;
    if (world.getBlock(tx, ty + 1, tz) !== 0) continue;
    placeTree(world, tx, ty + 1, tz, weightedPick(treeRng, kinds), treeRng);
  }
  const logs = draw(treeRng, content.fallenLogs || 0);
  for (let i = 0; i < logs; i++) {
    const lx = x0 + treeRng.int(16), lz = z0 + treeRng.int(16);
    const ly = groundY(world, lx, lz);
    if (ly < SEA_LEVEL) continue;
    const species = weightedPick(treeRng, kinds).replace(/^(fancy_|swamp_|tall_|mega_)/, '');
    if (blocksByName.has(`${species}_log`)) fallenLog(world, lx, ly, lz, species, treeRng);
  }

  // -- ground cover --------------------------------------------------------
  const plantRng = pass(world, chunk, SALT.plant);
  const grass = draw(plantRng, content.grass || 0);
  const fernRatio = (content.ferns || 0) / Math.max(1, (content.grass || 0) + (content.ferns || 0));
  for (let i = 0; i < grass; i++) {
    grassPatch(world, x0 + plantRng.int(16), z0 + plantRng.int(16), plantRng, fernRatio);
  }
  const flowers = draw(plantRng, content.flowers || 0);
  const flowerKinds = content.flowerKinds || ['dandelion', 'poppy'];
  for (let i = 0; i < flowers; i++) {
    const kind = flowerKinds[plantRng.int(flowerKinds.length)];
    plantPatch(world, x0 + plantRng.int(16), z0 + plantRng.int(16), kind, plantRng, 20, 4);
  }
  const talls = draw(plantRng, content.tall || 0);
  const tallKinds = content.tallKinds || ['tall_grass'];
  for (let i = 0; i < talls; i++) {
    plantPatch(world, x0 + plantRng.int(16), z0 + plantRng.int(16),
      tallKinds[plantRng.int(tallKinds.length)], plantRng, 8, 3);
  }
  const bushes = draw(plantRng, content.deadBushes || 0);
  for (let i = 0; i < bushes; i++) {
    deadBushPatch(world, x0 + plantRng.int(16), z0 + plantRng.int(16), plantRng);
  }
  const shrooms = draw(plantRng, content.mushrooms || 0);
  for (let i = 0; i < shrooms; i++) {
    plantPatch(world, x0 + plantRng.int(16), z0 + plantRng.int(16),
      plantRng.chance(0.5) ? 'red_mushroom' : 'brown_mushroom', plantRng, 6, 3);
  }
  // Rare curiosities so every flower in the registry can be found somewhere.
  if (plantRng.oneIn(220)) {
    plantPatch(world, x0 + plantRng.int(16), z0 + plantRng.int(16),
      plantRng.chance(0.5) ? 'pitcher_plant' : 'torchflower', plantRng, 4, 2);
  }
  if (plantRng.oneIn(900)) {
    plantPatch(world, x0 + plantRng.int(16), z0 + plantRng.int(16), 'wither_rose', plantRng, 3, 2);
  }

  // -- crops and water plants ----------------------------------------------
  const waterRng = pass(world, chunk, SALT.water);
  const canes = draw(waterRng, content.sugarCane || 0.25);
  for (let i = 0; i < canes; i++) {
    const cx = x0 + waterRng.int(16), cz = z0 + waterRng.int(16);
    for (let k = 0; k < 8; k++) {
      sugarCane(world, cx + waterRng.intRange(-3, 3), cz + waterRng.intRange(-3, 3), waterRng);
    }
  }
  const cacti = draw(waterRng, content.cactus || 0);
  for (let i = 0; i < cacti; i++) {
    for (let k = 0; k < 6; k++) {
      cactus(world, x0 + waterRng.int(16), z0 + waterRng.int(16), waterRng);
    }
  }
  const bamboos = draw(waterRng, content.bamboo || 0);
  for (let i = 0; i < bamboos; i++) {
    const bx = x0 + waterRng.int(16), bz = z0 + waterRng.int(16);
    for (let k = 0; k < 8; k++) {
      bambooStalk(world, bx + waterRng.intRange(-4, 4), bz + waterRng.intRange(-4, 4), waterRng);
    }
  }
  if (waterRng.next() < (content.pumpkins || 0)) {
    gourdPatch(world, x0 + waterRng.int(16), z0 + waterRng.int(16), waterRng, false);
  }
  if (waterRng.next() < (content.melons || 0)) {
    gourdPatch(world, x0 + waterRng.int(16), z0 + waterRng.int(16), waterRng, true);
  }
  const berries = draw(waterRng, content.berries || 0);
  for (let i = 0; i < berries; i++) {
    for (let k = 0; k < 6; k++) {
      berryBush(world, x0 + waterRng.int(16), z0 + waterRng.int(16), waterRng);
    }
  }
  const pads = draw(waterRng, content.lilyPads || 0);
  for (let i = 0; i < pads; i++) {
    lilyPad(world, x0 + waterRng.int(16), z0 + waterRng.int(16), waterRng);
  }
  const grasses = draw(waterRng, content.seagrass || 0);
  for (let i = 0; i < grasses; i++) {
    seagrassPatch(world, x0 + waterRng.int(16), z0 + waterRng.int(16), waterRng);
  }
  const kelps = draw(waterRng, content.kelp || 0);
  for (let i = 0; i < kelps; i++) {
    kelpColumn(world, x0 + waterRng.int(16), z0 + waterRng.int(16), waterRng);
  }
  if (waterRng.next() < (content.coral || 0)) {
    coralReef(world, x0 + waterRng.int(16), z0 + waterRng.int(16), waterRng);
  }

  // -- specials ------------------------------------------------------------
  const specialRng = pass(world, chunk, SALT.special);
  if (specialRng.next() < (content.wells || 0)) {
    desertWell(world, x0 + specialRng.int(16), z0 + specialRng.int(16));
  }
  // Vines creeping up jungle cliff faces.
  const vines = draw(specialRng, content.vines || 0);
  for (let i = 0; i < vines; i++) {
    vineOnWall(world, x0 + specialRng.int(16), z0 + specialRng.int(16), specialRng);
  }
  void generator; void random;
}

function vineOnWall(world, x, z, rng) {
  const y = groundY(world, x, z) + rng.intRange(1, 12);
  if (world.getBlock(x, y, z) !== 0) return false;
  const dirs = [['north', 0, -1], ['east', 1, 0], ['south', 0, 1], ['west', -1, 0]];
  for (const [face, dx, dz] of dirs) {
    if (!T.solid[world.getBlock(x + dx, y, z + dz)]) continue;
    const st = S('vine', {
      north: face === 'north', east: face === 'east',
      south: face === 'south', west: face === 'west', up: false,
    });
    for (let i = 0; i < rng.intRange(2, 8); i++) {
      if (!putAir(world, x, y - i, z, st)) break;
    }
    return true;
  }
  return false;
}

/** Springs, cave decoration, geodes and fossils, all below the surface. */
function undergroundPass(world, chunk, generator) {
  const x0 = chunk.x0, z0 = chunk.z0;

  const springRng = pass(world, chunk, SALT.spring);
  for (let i = 0; i < 24; i++) {
    spring(world, x0 + springRng.int(16), springRng.intRange(-52, 60),
      z0 + springRng.int(16), 'water');
  }
  for (let i = 0; i < 16; i++) {
    spring(world, x0 + springRng.int(16), springRng.intRange(-54, 8),
      z0 + springRng.int(16), 'lava');
  }

  // Lush and dripstone caves cluster into regions rather than sprinkling
  // evenly, which is what makes finding one feel like finding somewhere.
  const caveRng = pass(world, chunk, SALT.cave);
  const region = hash2(world.seed ^ 0x10c5e, chunk.cx >> 2, chunk.cz >> 2) % 11;
  const lush = region === 0;
  const drip = region === 1 || region === 2;
  if (lush || drip) {
    for (let i = 0; i < 40; i++) {
      const px = x0 + caveRng.int(16);
      const pz = z0 + caveRng.int(16);
      const py = caveRng.intRange(-56, 44);
      if (lush) lushCaveSpot(world, px, py, pz, caveRng);
      else dripstoneSpot(world, px, py, pz, caveRng);
    }
  } else {
    for (let i = 0; i < 6; i++) {
      dripstoneSpot(world, x0 + caveRng.int(16), caveRng.intRange(-56, 30),
        z0 + caveRng.int(16), caveRng);
    }
  }

  const geoRng = pass(world, chunk, SALT.geode);
  if (geoRng.oneIn(26)) {
    geode(world, x0 + geoRng.int(16), geoRng.intRange(-54, 26), z0 + geoRng.int(16), geoRng);
  }
  const fossilRng = pass(world, chunk, SALT.fossil);
  if (fossilRng.oneIn(28)) {
    fossil(world, x0 + fossilRng.int(16), fossilRng.intRange(-52, 2),
      z0 + fossilRng.int(16), fossilRng);
  }
  void generator;
}

// -- nether ------------------------------------------------------------------

function decorateNether(world, chunk, generator, random) {
  const x0 = chunk.x0, z0 = chunk.z0;
  const rng = pass(world, chunk, SALT.nether);
  const cat = biomeCategory(world, x0 + 8, z0 + 8);

  // Glowstone blobs hanging from the ceiling.
  const glow = B('glowstone');
  for (let i = 0; i < 10; i++) {
    const gx = x0 + rng.int(16), gz = z0 + rng.int(16);
    const gy = rng.intRange(4, 120);
    if (world.getBlock(gx, gy, gz) !== 0) continue;
    if (nameOf(world.getBlock(gx, gy + 1, gz)) !== 'netherrack') continue;
    const r = rng.intRange(1, 3);
    for (let dy = 0; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy + dz * dz > r * r) continue;
          putAir(world, gx + dx, gy - dy, gz + dz, glow);
        }
      }
    }
  }

  // Fire, magma and lava trickles.
  for (let i = 0; i < 8; i++) {
    const fx = x0 + rng.int(16), fz = z0 + rng.int(16);
    const fy = openY(world, fx, fz);
    if (nameOf(world.getBlock(fx, fy - 1, fz)) === 'netherrack' && rng.chance(0.3)) {
      putAir(world, fx, fy, fz, B('fire'));
    }
  }

  const isCrimson = cat === 'crimson_forest';
  const isWarped = cat === 'warped_forest';
  if (isCrimson || isWarped) {
    const kind = isCrimson ? 'crimson' : 'warped';
    const nylium = B(`${kind}_nylium`);
    for (let i = 0; i < 48; i++) {
      const px = x0 + rng.int(16), pz = z0 + rng.int(16);
      const py = groundY(world, px, pz);
      if (py < MIN_Y) continue;
      if (nameOf(world.getBlock(px, py, pz)) === 'netherrack') put(world, px, py, pz, nylium);
      const roll = rng.next();
      if (roll < 0.25) putAir(world, px, py + 1, pz, B(`${kind}_roots`));
      else if (roll < 0.32) putAir(world, px, py + 1, pz, B(`${kind}_fungus`));
      else if (roll < 0.36 && isWarped) putAir(world, px, py + 1, pz, B('nether_sprouts'));
    }
    const fungi = rng.intRange(1, 4);
    for (let i = 0; i < fungi; i++) {
      const px = x0 + rng.int(16), pz = z0 + rng.int(16);
      const py = groundY(world, px, pz);
      if (py > MIN_Y) hugeFungus(world, px, py + 1, pz, kind, rng);
    }
  }

  if (cat === 'soul_sand_valley') {
    for (let i = 0; i < 10; i++) {
      const px = x0 + rng.int(16), pz = z0 + rng.int(16);
      const py = groundY(world, px, pz);
      if (py > MIN_Y && rng.chance(0.4)) putAir(world, px, py + 1, pz, B('soul_fire'));
    }
    if (rng.oneIn(3)) {
      fossil(world, x0 + rng.int(16), groundY(world, x0 + 8, z0 + 8) - rng.intRange(1, 5),
        z0 + rng.int(16), rng);
    }
  }

  if (cat === 'basalt_deltas') basaltDeltas(world, chunk, rng);
  void generator; void random;
}

/** Basalt columns and magma pockets, the signature of the basalt deltas. */
export function basaltDeltas(world, chunk, rng) {
  const basalt = B('basalt');
  const magma = B('magma_block');
  const blackstone = B('blackstone');
  if (basalt < 0) return 0;
  let n = 0;
  const count = rng.intRange(2, 8);
  for (let i = 0; i < count; i++) {
    const px = chunk.x0 + rng.int(16), pz = chunk.z0 + rng.int(16);
    const py = groundY(world, px, pz);
    if (py < MIN_Y) continue;
    const h = rng.intRange(2, 9);
    const r = rng.int(2);
    for (let dy = 0; dy < h; dy++) {
      const rr = dy > h - 3 ? 0 : r;
      for (let dz = -rr; dz <= rr; dz++) {
        for (let dx = -rr; dx <= rr; dx++) {
          if (putAir(world, px + dx, py + 1 + dy, pz + dz, basalt)) n++;
        }
      }
    }
    if (magma >= 0 && rng.chance(0.3)) put(world, px, py, pz, magma);
    if (blackstone >= 0 && rng.chance(0.4)) put(world, px + 1, py, pz, blackstone);
  }
  return n;
}

// -- end ---------------------------------------------------------------------

function decorateEnd(world, chunk, generator, random) {
  const rng = pass(world, chunk, SALT.end);
  const x0 = chunk.x0, z0 = chunk.z0;
  const dist = Math.hypot(x0 + 8, z0 + 8);
  if (dist < 1000) return;            // the central island stays bare
  const plants = rng.intRange(0, 3);
  for (let i = 0; i < plants; i++) {
    const px = x0 + rng.int(16), pz = z0 + rng.int(16);
    const py = groundY(world, px, pz);
    if (py < MIN_Y) continue;
    chorusPlant(world, px, py + 1, pz, rng);
  }
  void generator; void random;
}

// ---------------------------------------------------------------------------
// Bone-meal style helpers other systems reuse
// ---------------------------------------------------------------------------

/** Scatter grass and flowers around a point, as bone meal on grass does. */
export function boneMealGrass(world, x, y, z, random) {
  const rng = random || new Random(hash3(world.seed, x, y, z));
  const cat = biomeCategory(world, x, z);
  const content = contentFor(cat);
  const flowers = content.flowerKinds || ['dandelion', 'poppy'];
  let n = 0;
  for (let i = 0; i < 24; i++) {
    const px = x + rng.intRange(-3, 3), pz = z + rng.intRange(-3, 3);
    const py = groundY(world, px, pz);
    if (py < MIN_Y) continue;
    const name = rng.chance(0.12) ? flowers[rng.int(flowers.length)] : 'short_grass';
    if (placePlant(world, px, py + 1, pz, name)) n++;
  }
  return n;
}

export default {
  decorateChunk, growTree, growFungus, growChorus, lightNetherPortal,
};
