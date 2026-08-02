// Structures: villages, dungeons, strongholds, fortresses, and their loot.
//
// Placement is a grid with hash jitter, exactly as Minecraft does it. The world
// is divided into `spacing`-chunk regions; one hash of (seed, regionX, regionZ)
// picks the origin chunk inside the region, a second decides whether the region
// gets a structure at all. Nothing consults the world to decide *where* a
// structure goes, so the answer is identical no matter which chunk the player
// walks into first — which is the whole point, because a village that shifted
// depending on approach direction would tear itself in half at the border.
//
// Building is clipped instead of deferred. A structure larger than a chunk is
// laid out in full every time any chunk it covers decorates, and a `Writer`
// throws away every block outside the chunk currently being decorated. Layouts
// are pure functions of (seed, origin) and are cached, so the repeated work is
// cheap and the result is seamless.
//
// The one thing that cannot come from a hash is the ground height a structure
// sits on. When generator.js exposes a height function we use it (fully
// deterministic); otherwise we read the terrain heightmap once per structure
// and remember it for the session.

import { MIN_Y, MAX_Y, SEA_LEVEL } from './chunk.js';
import { FLAG } from './world.js';
import { blocksByName, blockOf, T } from './blocks.js';
import { Random, hash2, hash3 } from '../core/rng.js';
import { ItemStack, itemsByName } from '../game/items.js';
import {
  B, S, firstOf, nameOf, put, groundY, terrainTopAt, biomeCategory,
} from './features.js';

const GEN = FLAG.GENERATION;

// ---------------------------------------------------------------------------
// Clipped writer
// ---------------------------------------------------------------------------

class Writer {
  constructor(world, chunk) {
    this.world = world;
    this.chunk = chunk;
    this.x0 = chunk.x0; this.z0 = chunk.z0;
    this.x1 = chunk.x0 + 15; this.z1 = chunk.z0 + 15;
    this.written = 0;
  }

  inside(x, z) { return x >= this.x0 && x <= this.x1 && z >= this.z0 && z <= this.z1; }

  /** True when a bounding box overlaps the chunk being decorated. */
  hits(bx0, bz0, bx1, bz1) {
    return !(bx1 < this.x0 || bx0 > this.x1 || bz1 < this.z0 || bz0 > this.z1);
  }

  set(x, y, z, state) {
    if (state < 0 || y < MIN_Y || y > MAX_Y) return false;
    if (!this.inside(x, z)) return false;
    this.world.setBlock(x, y, z, state, GEN);
    this.written++;
    return true;
  }

  /** Write only where the target is air or replaceable. */
  soft(x, y, z, state) {
    if (state < 0 || y < MIN_Y || y > MAX_Y || !this.inside(x, z)) return false;
    const cur = this.world.getBlock(x, y, z);
    if (cur !== 0 && !T.replaceable[cur]) return false;
    this.world.setBlock(x, y, z, state, GEN);
    this.written++;
    return true;
  }

  fill(x0, y0, z0, x1, y1, z1, state) {
    if (state < 0) return this;
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, z, state);
      }
    }
    return this;
  }

  /** A box with `wall` on the outside and `inner` (default air) inside. */
  hollow(x0, y0, z0, x1, y1, z1, wall, inner = 0) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const edge = x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1;
          this.set(x, y, z, edge ? wall : inner);
        }
      }
    }
    return this;
  }

  /** Fill with a two-tone mix (cobblestone / mossy cobblestone, for example). */
  fillMix(x0, y0, z0, x1, y1, z1, a, b, rng, bChance = 0.3) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          this.set(x, y, z, rng.chance(bChance) ? b : a);
        }
      }
    }
    return this;
  }

  clear(x0, y0, z0, x1, y1, z1) { return this.fill(x0, y0, z0, x1, y1, z1, 0); }
}

// ---------------------------------------------------------------------------
// Loot
// ---------------------------------------------------------------------------

/**
 * A stack for an item the item registry does not know about yet.
 *
 * itemdefs.js is optional content; loot tables name real Minecraft items and
 * should keep working (and keep being testable) before it lands. This shim
 * carries the same fields callers read off an ItemStack.
 */
class LootStack {
  constructor(name, count = 1, damage = 0, tag = null) {
    this.item = { name, displayName: name, maxStack: 64, maxDamage: 0 };
    this.count = count;
    this.damage = damage;
    this.tag = tag;
    this.unresolved = true;
  }
  get name() { return this.item.name; }
  get empty() { return this.count <= 0; }
  get maxStack() { return 64; }
  get displayName() { return this.tag?.name ?? this.item.name; }
  isItem(n) { return this.item.name === n; }
  clone() { return new LootStack(this.item.name, this.count, this.damage, this.tag); }
}

function makeStack(name, count, tag) {
  if (itemsByName.has(name)) return new ItemStack(name, count, 0, tag);
  return new LootStack(name, count, 0, tag);
}

const e = (item, weight, min = 1, max = min, tag = null) => ({ item, weight, min, max, tag });

/**
 * Loot tables. Each pool rolls `[min,max]` times over a weighted entry list,
 * the same shape Minecraft's data-driven tables use.
 */
export const LOOT_TABLES = {
  dungeon: {
    pools: [
      { rolls: [1, 3], entries: [
        e('saddle', 20), e('golden_apple', 15), e('enchanted_golden_apple', 2),
        e('music_disc_13', 15), e('music_disc_cat', 15), e('name_tag', 20),
        e('golden_horse_armor', 10), e('iron_horse_armor', 15),
        e('diamond_horse_armor', 5), e('book', 10), e('iron_ingot', 10, 1, 4),
        e('bread', 20, 1, 3), e('wheat', 20, 1, 4), e('bucket', 10),
      ] },
      { rolls: [1, 4], entries: [
        e('bone', 10, 1, 8), e('gunpowder', 10, 1, 8), e('rotten_flesh', 10, 1, 8),
        e('string', 10, 1, 8), e('redstone', 10, 1, 4), e('coal', 10, 1, 4),
        e('beetroot_seeds', 10, 2, 4), e('melon_seeds', 10, 2, 4),
        e('pumpkin_seeds', 10, 2, 4), e('wheat_seeds', 10, 2, 4),
      ] },
    ],
  },
  mineshaft: {
    pools: [
      { rolls: [1, 2], entries: [
        e('golden_apple', 20), e('enchanted_golden_apple', 1), e('name_tag', 30),
        e('book', 10), e('iron_pickaxe', 5), e('diamond', 3, 1, 2),
        e('gold_ingot', 10, 1, 3), e('iron_ingot', 10, 1, 5),
        e('emerald', 4, 1, 3), e('lapis_lazuli', 10, 4, 9),
      ] },
      { rolls: [2, 4], entries: [
        e('bread', 15, 1, 3), e('coal', 10, 3, 8), e('redstone', 10, 4, 9),
        e('rail', 20, 4, 8), e('powered_rail', 5, 1, 4), e('detector_rail', 5, 1, 4),
        e('activator_rail', 5, 1, 4), e('torch', 15, 1, 16),
        e('melon_seeds', 10, 2, 4), e('pumpkin_seeds', 10, 2, 4),
        e('beetroot_seeds', 10, 2, 4),
      ] },
    ],
  },
  village_blacksmith: {
    pools: [
      { rolls: [3, 8], entries: [
        e('diamond', 3, 1, 3), e('iron_ingot', 15, 1, 5), e('gold_ingot', 5, 1, 3),
        e('bread', 15, 1, 3), e('apple', 15, 1, 3), e('iron_pickaxe', 5),
        e('iron_sword', 5), e('iron_chestplate', 5), e('iron_helmet', 5),
        e('iron_leggings', 5), e('iron_boots', 5), e('obsidian', 5, 3, 7),
        e('oak_sapling', 5, 3, 7), e('saddle', 3), e('ink_sac', 5, 1, 3),
      ] },
    ],
  },
  village_house: {
    pools: [
      { rolls: [1, 4], entries: [
        e('bread', 20, 1, 3), e('wheat_seeds', 20, 1, 5), e('potato', 15, 1, 5),
        e('carrot', 15, 1, 5), e('beetroot_seeds', 10, 1, 5), e('emerald', 5, 1, 3),
        e('oak_sapling', 10, 1, 2), e('stick', 15, 1, 3), e('bowl', 10, 1, 2),
      ] },
    ],
  },
  desert_pyramid: {
    pools: [
      { rolls: [2, 4], entries: [
        e('diamond', 5, 1, 3), e('iron_ingot', 15, 1, 5), e('gold_ingot', 15, 2, 7),
        e('emerald', 15, 1, 3), e('bone', 25, 4, 6), e('rotten_flesh', 25, 3, 7),
        e('saddle', 20), e('iron_horse_armor', 15), e('golden_horse_armor', 10),
        e('diamond_horse_armor', 5), e('enchanted_book', 20),
        e('golden_apple', 20), e('enchanted_golden_apple', 2),
      ] },
      { rolls: [4, 4], entries: [e('bone', 10, 1, 3), e('sand', 10, 4, 8), e('gunpowder', 10, 1, 4)] },
    ],
  },
  jungle_temple: {
    pools: [
      { rolls: [2, 6], entries: [
        e('diamond', 3, 1, 3), e('iron_ingot', 10, 1, 5), e('gold_ingot', 15, 2, 7),
        e('emerald', 15, 1, 3), e('bamboo', 15, 1, 3), e('bone', 20, 4, 6),
        e('rotten_flesh', 16, 3, 7), e('saddle', 3), e('iron_horse_armor', 1),
        e('gold_horse_armor', 1), e('diamond_horse_armor', 1),
        e('enchanted_book', 10),
      ] },
    ],
  },
  stronghold_library: {
    pools: [
      { rolls: [2, 10], entries: [
        e('book', 20, 1, 3), e('paper', 20, 2, 7), e('map', 5), e('compass', 5),
        e('enchanted_book', 10), e('empty_map', 5), e('bread', 15, 1, 3),
      ] },
    ],
  },
  stronghold_corridor: {
    pools: [
      { rolls: [2, 3], entries: [
        e('ender_pearl', 10, 1, 1), e('diamond', 3), e('iron_ingot', 10, 1, 5),
        e('gold_ingot', 5, 1, 3), e('redstone', 5, 4, 9), e('bread', 15, 1, 3),
        e('apple', 15, 1, 3), e('iron_pickaxe', 5), e('book', 10),
        e('golden_apple', 5), e('enchanted_book', 5),
      ] },
    ],
  },
  stronghold_crossing: {
    pools: [
      { rolls: [1, 4], entries: [
        e('iron_ingot', 10, 1, 5), e('gold_ingot', 5, 1, 3), e('redstone', 5, 4, 9),
        e('coal', 10, 3, 8), e('bread', 15, 1, 3), e('apple', 15, 1, 3),
        e('iron_pickaxe', 5), e('book', 10), e('enchanted_book', 5),
      ] },
    ],
  },
  nether_fortress: {
    pools: [
      { rolls: [2, 4], entries: [
        e('diamond', 5, 1, 3), e('iron_ingot', 10, 1, 5), e('gold_ingot', 15, 1, 3),
        e('golden_sword', 5), e('golden_chestplate', 5), e('flint_and_steel', 5),
        e('nether_wart', 5, 3, 7), e('saddle', 10), e('golden_horse_armor', 8),
        e('obsidian', 5, 2, 4), e('gold_nugget', 15, 4, 12),
      ] },
    ],
  },
  bastion: {
    pools: [
      { rolls: [3, 5], entries: [
        e('netherite_ingot', 1), e('ancient_debris', 3, 1, 2),
        e('gold_ingot', 20, 2, 8), e('golden_apple', 10),
        e('enchanted_golden_apple', 2), e('gilded_blackstone', 10, 2, 5),
        e('crying_obsidian', 10, 1, 5), e('gold_nugget', 20, 4, 12),
        e('magma_cream', 10, 1, 3), e('spectral_arrow', 10, 4, 12),
        e('iron_ingot', 15, 1, 5), e('crossbow', 5),
      ] },
    ],
  },
  shipwreck_map: {
    pools: [
      { rolls: [1, 1], entries: [e('map', 12), e('paper', 8, 1, 3), e('compass', 4), e('clock', 4)] },
      { rolls: [3, 6], entries: [e('paper', 20, 1, 5), e('feather', 10, 1, 5), e('book', 5)] },
    ],
  },
  shipwreck_supply: {
    pools: [
      { rolls: [3, 10], entries: [
        e('paper', 20, 1, 12), e('potato', 20, 2, 6), e('poisonous_potato', 20, 2, 6),
        e('carrot', 20, 4, 8), e('wheat', 20, 8, 21), e('coal', 20, 2, 8),
        e('rotten_flesh', 10, 5, 24), e('leather_helmet', 3), e('leather_chestplate', 3),
        e('leather_leggings', 3), e('leather_boots', 3), e('bamboo', 10, 1, 3),
        e('gunpowder', 5, 1, 5), e('tnt', 3, 1, 2), e('pumpkin', 5, 1, 3),
      ] },
    ],
  },
  shipwreck_treasure: {
    pools: [
      { rolls: [3, 6], entries: [
        e('iron_ingot', 90, 1, 5), e('gold_ingot', 10, 1, 5), e('emerald', 40, 1, 5),
        e('diamond', 5), e('experience_bottle', 5, 1, 2), e('lapis_lazuli', 20, 1, 10),
        e('gold_nugget', 10, 1, 10), e('iron_nugget', 50, 1, 10),
      ] },
    ],
  },
  buried_treasure: {
    pools: [
      { rolls: [1, 1], entries: [e('heart_of_the_sea', 1)] },
      { rolls: [5, 8], entries: [
        e('iron_ingot', 20, 1, 4), e('gold_ingot', 10, 1, 4), e('tnt', 5, 1, 2),
        e('emerald', 5, 1, 4), e('diamond', 5, 1, 2), e('prismarine_crystals', 5, 1, 5),
        e('cooked_cod', 15, 2, 4), e('cooked_salmon', 15, 2, 4),
        e('leather_chestplate', 5), e('iron_sword', 5),
      ] },
    ],
  },
  ruined_portal: {
    pools: [
      { rolls: [4, 8], entries: [
        e('obsidian', 40, 1, 2), e('flint', 40, 1, 4), e('iron_nugget', 40, 9, 18),
        e('flint_and_steel', 40), e('fire_charge', 40), e('golden_apple', 15),
        e('gold_nugget', 40, 4, 24), e('gold_ingot', 15, 2, 8),
        e('golden_sword', 5), e('golden_axe', 5), e('golden_pickaxe', 5),
        e('golden_helmet', 5), e('golden_boots', 5), e('bell', 1),
        e('enchanted_golden_apple', 1), e('glistering_melon_slice', 5, 4, 12),
      ] },
    ],
  },
  igloo: {
    pools: [
      { rolls: [1, 1], entries: [e('golden_apple', 1)] },
      { rolls: [2, 8], entries: [
        e('coal', 15, 1, 4), e('apple', 15, 1, 3), e('gold_nugget', 10, 1, 3),
        e('stone_axe', 2), e('emerald', 1), e('wheat', 15, 2, 3),
      ] },
    ],
  },
  pillager_outpost: {
    pools: [
      { rolls: [2, 4], entries: [
        e('dark_oak_log', 30, 2, 3), e('crossbow', 5), e('iron_ingot', 15, 1, 3),
        e('potato', 20, 2, 5), e('wheat', 20, 3, 5), e('experience_bottle', 5, 1, 3),
        e('book', 10), e('arrow', 20, 2, 5), e('tripwire_hook', 5, 1, 2),
      ] },
    ],
  },
  end_city: {
    pools: [
      { rolls: [2, 6], entries: [
        e('diamond', 5, 2, 7), e('iron_ingot', 10, 4, 8), e('gold_ingot', 15, 2, 7),
        e('emerald', 2, 2, 6), e('beetroot_seeds', 5, 1, 10),
        e('saddle', 3), e('diamond_horse_armor', 3), e('iron_horse_armor', 3),
        e('golden_horse_armor', 3), e('diamond_sword', 3), e('diamond_boots', 3),
        e('diamond_chestplate', 3), e('diamond_pickaxe', 3), e('shulker_shell', 8, 1, 2),
      ] },
    ],
  },
};

/**
 * Roll a loot table.
 * @returns {ItemStack[]} stacks; items the registry does not know yet come back
 *   as compatible placeholder stacks rather than throwing.
 */
export function generateLoot(tableName, random) {
  const table = LOOT_TABLES[tableName];
  const rng = random || new Random(0x10077);
  if (!table) return [];
  const out = [];
  for (const pool of table.pools) {
    const rolls = pool.rolls[0] === pool.rolls[1]
      ? pool.rolls[0] : rng.intRange(pool.rolls[0], pool.rolls[1]);
    let total = 0;
    for (const entry of pool.entries) total += entry.weight;
    for (let i = 0; i < rolls; i++) {
      let r = rng.next() * total;
      let chosen = pool.entries[pool.entries.length - 1];
      for (const entry of pool.entries) {
        r -= entry.weight;
        if (r <= 0) { chosen = entry; break; }
      }
      const count = chosen.min === chosen.max ? chosen.min
        : rng.intRange(chosen.min, chosen.max);
      if (count <= 0) continue;
      out.push(makeStack(chosen.item, count, chosen.tag));
    }
  }
  return out;
}

export const LOOT_TABLE_NAMES = Object.freeze(Object.keys(LOOT_TABLES));

// ---------------------------------------------------------------------------
// Block entities
// ---------------------------------------------------------------------------

/** Place a chest and fill it, degrading to a plain chest without the BE module. */
function chest(writer, x, y, z, facing, table, rng) {
  const state = S('chest', { facing, type: 'single', waterlogged: false });
  if (!writer.set(x, y, z, state)) return null;
  const loot = generateLoot(table, rng);
  const be = writer.world.getBlockEntity(x, y, z);
  if (be) {
    be.lootTable = table;
    if (Array.isArray(be.slots)) {
      const n = be.slots.length || 27;
      for (const stack of loot) {
        for (let t = 0; t < 12; t++) {
          const s = rng.int(n);
          if (!be.slots[s]) { be.slots[s] = stack; break; }
        }
      }
    } else {
      be.loot = loot;
    }
  }
  return loot;
}

function spawner(writer, x, y, z, entityType) {
  if (!writer.set(x, y, z, B('spawner'))) return false;
  const be = writer.world.getBlockEntity(x, y, z);
  if (be) { be.entityType = entityType; be.entity = entityType; be.mobType = entityType; }
  return true;
}

/** Spawn a mob through the optional mob module. Never throws. */
function spawnMob(world, type, x, y, z, opts) {
  try {
    return world.game?.mobs?.spawn?.(world, type, x + 0.5, y, z + 0.5, opts) ?? null;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Placement grid
// ---------------------------------------------------------------------------

/**
 * The origin chunk of the structure in region (rx,rz), or null when the region
 * rolled empty. Pure function of (seed, spec, rx, rz).
 */
function regionOrigin(seed, spec, rx, rz) {
  const range = Math.max(1, spec.spacing - spec.separation);
  const h = hash2(seed ^ spec.salt, rx, rz);
  const cx = rx * spec.spacing + (h % range);
  const cz = rz * spec.spacing + ((h >>> 13) % range);
  if (spec.chance !== undefined) {
    const roll = (hash2(seed ^ (spec.salt ^ 0x5bf03635), cx, cz) >>> 8) / 16777216;
    if (roll >= spec.chance) return null;
  }
  return { cx, cz };
}

/** Every candidate origin whose reach could touch chunk (cx,cz). */
function candidates(seed, spec, cx, cz, out) {
  const r = spec.reach || 1;
  const r0x = Math.floor((cx - r) / spec.spacing), r1x = Math.floor((cx + r) / spec.spacing);
  const r0z = Math.floor((cz - r) / spec.spacing), r1z = Math.floor((cz + r) / spec.spacing);
  for (let rz = r0z; rz <= r1z; rz++) {
    for (let rx = r0x; rx <= r1x; rx++) {
      const o = regionOrigin(seed, spec, rx, rz);
      if (!o) continue;
      if (Math.abs(o.cx - cx) > r || Math.abs(o.cz - cz) > r) continue;
      out.push(o);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layout cache
//
// A layout is a pure function of (seed, origin) plus a single terrain height
// sample. Caching it keeps a 9-chunk-wide village from being laid out 81 times.
// ---------------------------------------------------------------------------

const layoutCache = new Map();
const CACHE_LIMIT = 4096;

function cachedLayout(world, key, build) {
  let v = layoutCache.get(key);
  if (v === undefined) {
    v = build() ?? null;
    if (layoutCache.size >= CACHE_LIMIT) layoutCache.clear();
    layoutCache.set(key, v);
  }
  return v;
}

/** Drop cached layouts — used by tests that reuse the module across seeds. */
export function resetStructureCache() { layoutCache.clear(); }

/**
 * Ground height for a structure anchor. Prefers the generator's own height
 * function; falls back to the heightmap of a loaded chunk. Returns null when
 * neither is available, which defers the structure to a later chunk.
 */
function anchorHeight(world, generator, x, z) {
  const g = generator?.surfaceY?.(x, z) ?? generator?.heightAt?.(x, z) ??
    generator?.terrainHeight?.(x, z);
  if (typeof g === 'number' && Number.isFinite(g)) return Math.round(g);
  if (!world.isChunkLoadedAt(x, z)) return null;
  const h = groundY(world, x, z);
  return h < MIN_Y ? null : h;
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

const VILLAGE_STYLES = {
  plains: {
    wall: 'oak_planks', accent: 'oak_log', stairs: 'oak_stairs', slab: 'oak_slab',
    fence: 'oak_fence', door: 'oak_door', path: 'dirt_path', base: 'cobblestone',
    glass: 'glass_pane', light: 'torch', roofBlock: 'oak_planks', bed: 'red_bed',
  },
  desert: {
    wall: 'smooth_sandstone', accent: 'cut_sandstone', stairs: 'sandstone_stairs',
    slab: 'sandstone_slab', fence: 'oak_fence', door: 'acacia_door',
    path: 'smooth_sandstone', base: 'sandstone', glass: 'glass_pane',
    light: 'torch', roofBlock: 'smooth_sandstone', bed: 'orange_bed',
  },
  savanna: {
    wall: 'acacia_planks', accent: 'acacia_log', stairs: 'acacia_stairs',
    slab: 'acacia_slab', fence: 'acacia_fence', door: 'acacia_door',
    path: 'dirt_path', base: 'cobblestone', glass: 'glass_pane', light: 'torch',
    roofBlock: 'acacia_planks', bed: 'yellow_bed',
  },
  taiga: {
    wall: 'spruce_planks', accent: 'spruce_log', stairs: 'spruce_stairs',
    slab: 'spruce_slab', fence: 'spruce_fence', door: 'spruce_door',
    path: 'dirt_path', base: 'cobblestone', glass: 'glass_pane', light: 'torch',
    roofBlock: 'spruce_planks', bed: 'green_bed',
  },
  snowy: {
    wall: 'spruce_planks', accent: 'spruce_log', stairs: 'spruce_stairs',
    slab: 'spruce_slab', fence: 'spruce_fence', door: 'spruce_door',
    path: 'gravel', base: 'cobblestone', glass: 'glass_pane', light: 'torch',
    roofBlock: 'spruce_planks', bed: 'white_bed',
  },
};

const VILLAGE_BIOME_STYLE = {
  desert: 'desert', badlands: 'desert', savanna: 'savanna',
  taiga: 'taiga', snowy: 'snowy', ice_spikes: 'snowy',
  plains: 'plains', meadow: 'plains', sunflower_plains: 'plains',
  forest: 'plains', birch_forest: 'plains', flower_forest: 'plains',
  cherry_grove: 'plains', mountains: 'taiga',
};

const st = (name, props) => (props ? S(name, props) : B(name));

/** Stair state facing a horizontal direction. */
const stairs = (name, facing, half = 'bottom') =>
  S(name, { facing, half, shape: 'straight', waterlogged: false });

const slabOf = (name, type = 'bottom') => S(name, { type, waterlogged: false });

const FACINGS = ['north', 'east', 'south', 'west'];
const FDX = [0, 1, 0, -1];
const FDZ = [-1, 0, 1, 0];

// ---------------------------------------------------------------------------
// Shared building helpers
// ---------------------------------------------------------------------------

/** Sink a column of foundation blocks from `fromY` down to the terrain. */
function pillarDown(writer, world, x, z, fromY, state, limit = 24) {
  if (!writer.inside(x, z)) return;
  let n = 0;
  for (let y = fromY; y > MIN_Y + 1 && n < limit; y--, n++) {
    const cur = world.getBlock(x, y, z);
    if (cur !== 0 && !T.replaceable[cur] && T.solid[cur]) break;
    writer.set(x, y, z, state);
  }
}

/** Foundation pillars under a rectangular floor, plus space cleared above. */
function terraform(writer, world, x0, z0, x1, z1, floorY, height, base) {
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      if (!writer.inside(x, z)) continue;
      pillarDown(writer, world, x, z, floorY - 1, base);
      writer.clear(x, floorY, z, x, floorY + height, z);
    }
  }
}

function doorPair(writer, x, y, z, name, facing) {
  writer.set(x, y, z, S(name, { facing, half: 'bottom', hinge: 'left', open: false, powered: false }));
  writer.set(x, y + 1, z, S(name, { facing, half: 'top', hinge: 'left', open: false, powered: false }));
}

/** A simple gabled roof of stairs over a rectangular building. */
function gableRoof(writer, x0, z0, x1, z1, y, style) {
  const w = x1 - x0, d = z1 - z0;
  const alongX = w >= d;
  const half = Math.floor((alongX ? d : w) / 2);
  for (let i = 0; i <= half; i++) {
    const yy = y + i;
    if (alongX) {
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        writer.set(x, yy, z0 + i - 1, stairs(style.stairs, 'south'));
        writer.set(x, yy, z1 - i + 1, stairs(style.stairs, 'north'));
        if (i === half) writer.set(x, yy + 1, Math.floor((z0 + z1) / 2), B(style.roofBlock));
      }
    } else {
      for (let z = z0 - 1; z <= z1 + 1; z++) {
        writer.set(x0 + i - 1, yy, z, stairs(style.stairs, 'east'));
        writer.set(x1 - i + 1, yy, z, stairs(style.stairs, 'west'));
        if (i === half) writer.set(Math.floor((x0 + x1) / 2), yy + 1, z, B(style.roofBlock));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Structure specifications
// ---------------------------------------------------------------------------

const OVERWORLD_LAND = new Set(['plains', 'sunflower_plains', 'meadow', 'forest',
  'flower_forest', 'birch_forest', 'dark_forest', 'taiga', 'snowy', 'ice_spikes',
  'mountains', 'desert', 'badlands', 'savanna', 'jungle', 'sparse_jungle',
  'bamboo_jungle', 'swamp', 'mangrove_swamp', 'cherry_grove', 'mushroom_fields',
  'beach', 'lush_caves', 'dripstone_caves', 'deep_dark']);

const SPECS = [
  { name: 'village', dim: 'overworld', spacing: 34, separation: 8, salt: 0x0a5a1e, chance: 0.65, reach: 5 },
  { name: 'mineshaft', dim: 'overworld', spacing: 12, separation: 3, salt: 0x1b4e11, chance: 0.5, reach: 5 },
  { name: 'ravine', dim: 'overworld', spacing: 14, separation: 4, salt: 0x2c9d33, chance: 0.45, reach: 6 },
  { name: 'desert_pyramid', dim: 'overworld', spacing: 32, separation: 8, salt: 0x3d1177, chance: 0.85, reach: 2 },
  { name: 'jungle_temple', dim: 'overworld', spacing: 32, separation: 8, salt: 0x4e2288, chance: 0.85, reach: 2 },
  { name: 'witch_hut', dim: 'overworld', spacing: 32, separation: 8, salt: 0x5f3399, chance: 0.85, reach: 2 },
  { name: 'igloo', dim: 'overworld', spacing: 32, separation: 8, salt: 0x6044aa, chance: 0.75, reach: 2 },
  { name: 'pillager_outpost', dim: 'overworld', spacing: 32, separation: 8, salt: 0x7155bb, chance: 0.4, reach: 2 },
  { name: 'ruined_portal', dim: 'overworld', spacing: 24, separation: 10, salt: 0x8266cc, chance: 0.9, reach: 2 },
  { name: 'shipwreck', dim: 'overworld', spacing: 24, separation: 4, salt: 0x9377dd, chance: 0.7, reach: 2 },
  { name: 'ocean_monument', dim: 'overworld', spacing: 32, separation: 5, salt: 0xa488ee, chance: 0.8, reach: 3 },
  { name: 'nether_fortress', dim: 'nether', spacing: 27, separation: 4, salt: 0xb599ff, chance: 0.75, reach: 5 },
  { name: 'bastion', dim: 'nether', spacing: 27, separation: 4, salt: 0xc6aa01, chance: 0.55, reach: 3 },
  { name: 'nether_ruined_portal', dim: 'nether', spacing: 25, separation: 10, salt: 0xd7bb12, chance: 0.9, reach: 2 },
  { name: 'basalt_pillars', dim: 'nether', spacing: 6, separation: 2, salt: 0xe8cc23, chance: 0.35, reach: 1 },
  { name: 'end_city', dim: 'end', spacing: 20, separation: 11, salt: 0xf9dd34, chance: 0.6, reach: 3 },
];

const SPECS_BY_DIM = { overworld: [], nether: [], end: [] };
for (const spec of SPECS) SPECS_BY_DIM[spec.dim].push(spec);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Place every structure overlapping this chunk.
 * Called by the chunk streamer before feature decoration.
 */
export function placeStructures(world, chunk, generator, random) {
  const dim = world.dimension || 'overworld';
  const writer = new Writer(world, chunk);
  const placed = [];
  const seed = world.seed | 0;

  try {
    const list = SPECS_BY_DIM[dim] || [];
    const found = [];
    for (const spec of list) {
      found.length = 0;
      candidates(seed, spec, chunk.cx, chunk.cz, found);
      for (const origin of found) {
        const layout = layoutFor(world, generator, spec, origin);
        if (!layout) continue;
        if (!writer.hits(layout.x0, layout.z0, layout.x1, layout.z1)) continue;
        const rng = new Random(hash3(seed ^ spec.salt, origin.cx, 7, origin.cz) | 0);
        BUILDERS[spec.name](world, writer, layout, rng);
        placed.push({ type: spec.name, cx: origin.cx, cz: origin.cz });
      }
    }

    // Dungeons are scattered per chunk rather than on a grid, exactly as in the
    // real game — but still from a hash of (seed, cx, cz), never a shared stream.
    if (dim === 'overworld' || dim === 'nether') {
      const dRng = new Random(hash3(seed ^ 0xd06e04, chunk.cx, 3, chunk.cz) | 0);
      for (let attempt = 0; attempt < 9; attempt++) {
        const x = chunk.x0 + 3 + dRng.int(10);
        const z = chunk.z0 + 3 + dRng.int(10);
        const y = dim === 'nether' ? dRng.intRange(20, 100) : dRng.intRange(-52, 58);
        if (buildDungeon(world, writer, x, y, z, dRng, dim)) {
          placed.push({ type: 'dungeon', cx: chunk.cx, cz: chunk.cz, x, y, z });
          break;
        }
      }
    }

    // Strongholds sit in rings around the origin rather than on the region grid.
    if (dim === 'overworld') {
      for (const sh of strongholdSites(seed)) {
        if (Math.abs(sh.cx - chunk.cx) > 6 || Math.abs(sh.cz - chunk.cz) > 6) continue;
        const layout = strongholdLayout(world, generator, seed, sh);
        if (!layout || !writer.hits(layout.x0, layout.z0, layout.x1, layout.z1)) continue;
        const rng = new Random(hash3(seed ^ 0x57484c44, sh.cx, 9, sh.cz) | 0);
        buildStronghold(world, writer, layout, rng);
        placed.push({ type: 'stronghold', cx: sh.cx, cz: sh.cz });
      }
    }

    // The End's central pillars and dragon arena are a fixed, singular feature.
    if (dim === 'end' && Math.abs(chunk.cx) <= 5 && Math.abs(chunk.cz) <= 5) {
      buildEndArena(world, writer, seed);
      placed.push({ type: 'end_arena', cx: 0, cz: 0 });
    }
  } catch (err) {
    console.error('structure placement failed', chunk.cx, chunk.cz, err);
  }

  chunk.generatedStructures = placed.length ? placed : null;
  void random;
  return placed;
}

/** All structure origins that could reach a chunk — handy for maps and tests. */
export function structuresNear(seed, dimension, cx, cz) {
  const out = [];
  for (const spec of SPECS_BY_DIM[dimension] || []) {
    const found = candidates(seed, spec, cx, cz, []);
    for (const o of found) out.push({ type: spec.name, cx: o.cx, cz: o.cz });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

function layoutFor(world, generator, spec, origin) {
  const key = `${world.dimension}:${world.seed}:${spec.name}:${origin.cx},${origin.cz}`;
  return cachedLayout(world, key, () => LAYOUTS[spec.name](world, generator, spec, origin));
}

const bbox = (x, z, rx, rz) => ({ x0: x - rx, z0: z - rz, x1: x + rx, z1: z + rz });

const LAYOUTS = {
  village(world, generator, spec, origin) {
    const x = origin.cx * 16 + 8, z = origin.cz * 16 + 8;
    const y = anchorHeight(world, generator, x, z);
    if (y === null) return null;
    if (y < SEA_LEVEL + 1) return null;
    const cat = biomeCategoryAt(world, x, z);
    const styleName = VILLAGE_BIOME_STYLE[cat];
    if (!styleName) return null;
    const rng = new Random(hash3(world.seed ^ spec.salt, origin.cx, 1, origin.cz) | 0);
    const style = VILLAGE_STYLES[styleName];

    const buildings = [];
    const types = ['small_house', 'large_house', 'farm', 'library', 'blacksmith',
      'church', 'animal_pen', 'small_house', 'farm', 'small_house'];
    rng.shuffle(types);
    // Blacksmith and farm are what make a village feel like a village.
    if (!types.slice(0, 7).includes('blacksmith')) types[0] = 'blacksmith';
    if (!types.slice(0, 7).includes('farm')) types[1] = 'farm';

    const arms = 4;
    const count = rng.intRange(5, 8);
    const paths = [];
    for (let a = 0; a < arms; a++) {
      const len = rng.intRange(11, 20);
      paths.push({ dir: a, len });
    }
    for (let i = 0; i < count; i++) {
      const arm = paths[i % arms];
      const dist = 6 + rng.int(Math.max(2, arm.len - 4));
      const side = rng.chance(0.5) ? 1 : -1;
      const off = 4 + rng.int(4);
      const dx = FDX[arm.dir], dz = FDZ[arm.dir];
      const bx = x + dx * dist + (-dz) * side * off;
      const bz = z + dz * dist + (dx) * side * off;
      const type = types[i % types.length];
      const size = BUILDING_SIZE[type];
      buildings.push({
        type, x: bx - (size.w >> 1), z: bz - (size.d >> 1),
        w: size.w, d: size.d,
        facing: (arm.dir + 2) & 3,
      });
    }

    let x0 = x - 8, z0 = z - 8, x1 = x + 8, z1 = z + 8;
    for (const b of buildings) {
      x0 = Math.min(x0, b.x - 2); z0 = Math.min(z0, b.z - 2);
      x1 = Math.max(x1, b.x + b.w + 2); z1 = Math.max(z1, b.z + b.d + 2);
    }
    for (const p of paths) {
      x0 = Math.min(x0, x + FDX[p.dir] * p.len - 2);
      z0 = Math.min(z0, z + FDZ[p.dir] * p.len - 2);
      x1 = Math.max(x1, x + FDX[p.dir] * p.len + 2);
      z1 = Math.max(z1, z + FDZ[p.dir] * p.len + 2);
    }
    return { type: 'village', x, y, z, style, styleName, buildings, paths, x0, z0, x1, z1 };
  },

  mineshaft(world, generator, spec, origin) {
    const x = origin.cx * 16 + 8, z = origin.cz * 16 + 8;
    const surface = anchorHeight(world, generator, x, z);
    if (surface === null) return null;
    const rng = new Random(hash3(world.seed ^ spec.salt, origin.cx, 2, origin.cz) | 0);
    const y = Math.max(MIN_Y + 6, Math.min(surface - 18, rng.intRange(-48, 30)));
    const corridors = [];
    const open = [{ x, z, dir: rng.int(4), depth: 0 }];
    let x0 = x, z0 = z, x1 = x, z1 = z;
    let guard = 0;
    while (open.length && corridors.length < 26 && guard++ < 200) {
      const node = open.shift();
      const len = rng.intRange(5, 13);
      const dx = FDX[node.dir], dz = FDZ[node.dir];
      const ex = node.x + dx * len, ez = node.z + dz * len;
      const yy = y + (rng.oneIn(5) ? rng.intRange(-2, 2) : 0);
      const room = node.depth > 0 && rng.oneIn(7);
      corridors.push({ x: node.x, z: node.z, ex, ez, dir: node.dir, y: yy, room });
      x0 = Math.min(x0, node.x, ex); x1 = Math.max(x1, node.x, ex);
      z0 = Math.min(z0, node.z, ez); z1 = Math.max(z1, node.z, ez);
      if (node.depth >= 4) continue;
      const branches = rng.intRange(1, 3);
      for (let b = 0; b < branches; b++) {
        const nd = rng.chance(0.55) ? node.dir : (node.dir + (rng.chance(0.5) ? 1 : 3)) & 3;
        open.push({ x: ex, z: ez, dir: nd, depth: node.depth + 1 });
      }
    }
    return { type: 'mineshaft', x, y, z, corridors, x0: x0 - 3, z0: z0 - 3, x1: x1 + 3, z1: z1 + 3 };
  },

  ravine(world, generator, spec, origin) {
    const x = origin.cx * 16 + 8, z = origin.cz * 16 + 8;
    const surface = anchorHeight(world, generator, x, z);
    if (surface === null || surface < SEA_LEVEL - 6) return null;
    const rng = new Random(hash3(world.seed ^ spec.salt, origin.cx, 4, origin.cz) | 0);
    const angle = rng.next() * Math.PI * 2;
    const length = rng.intRange(50, 96);
    const depth = rng.intRange(24, 46);
    const top = Math.min(surface - 2, SEA_LEVEL + 20);
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const ex = Math.round(x + dx * length), ez = Math.round(z + dz * length);
    return {
      type: 'ravine', x, y: top, z, ex, ez, depth, angle,
      x0: Math.min(x, ex) - 10, z0: Math.min(z, ez) - 10,
      x1: Math.max(x, ex) + 10, z1: Math.max(z, ez) + 10,
    };
  },

  desert_pyramid: siteLayout('desert_pyramid', 11, 11,
    (cat) => cat === 'desert' || cat === 'badlands'),
  jungle_temple: siteLayout('jungle_temple', 7, 7,
    (cat) => cat === 'jungle' || cat === 'bamboo_jungle' || cat === 'sparse_jungle'),
  witch_hut: siteLayout('witch_hut', 5, 6,
    (cat) => cat === 'swamp' || cat === 'mangrove_swamp', { allowWater: true }),
  igloo: siteLayout('igloo', 5, 5,
    (cat) => cat === 'snowy' || cat === 'ice_spikes'),
  pillager_outpost: siteLayout('pillager_outpost', 6, 6,
    (cat) => OVERWORLD_LAND.has(cat) && cat !== 'mushroom_fields'),
  ruined_portal: siteLayout('ruined_portal', 6, 6, () => true, { anyHeight: true }),

  shipwreck(world, generator, spec, origin) {
    const x = origin.cx * 16 + 8, z = origin.cz * 16 + 8;
    const y = anchorHeight(world, generator, x, z);
    if (y === null) return null;
    const cat = biomeCategoryAt(world, x, z);
    const beached = y > SEA_LEVEL;
    if (beached && cat !== 'beach') return null;
    if (!beached && y > SEA_LEVEL - 3) return null;
    const rng = new Random(hash3(world.seed ^ spec.salt, origin.cx, 5, origin.cz) | 0);
    const dir = rng.int(4);
    return {
      type: 'shipwreck', x, y: y + 1, z, dir, beached,
      ...bbox(x, z, 12, 12),
    };
  },

  ocean_monument(world, generator, spec, origin) {
    const x = origin.cx * 16 + 8, z = origin.cz * 16 + 8;
    const y = anchorHeight(world, generator, x, z);
    if (y === null || y > SEA_LEVEL - 18) return null;
    return { type: 'ocean_monument', x, y: SEA_LEVEL - 22, z, ...bbox(x, z, 15, 15) };
  },

  nether_fortress(world, generator, spec, origin) {
    const x = origin.cx * 16 + 8, z = origin.cz * 16 + 8;
    const rng = new Random(hash3(world.seed ^ spec.salt, origin.cx, 6, origin.cz) | 0);
    const y = rng.intRange(48, 76);
    const arms = [];
    for (let i = 0; i < 4; i++) arms.push({ dir: i, len: rng.intRange(18, 40) });
    let x0 = x - 12, z0 = z - 12, x1 = x + 12, z1 = z + 12;
    for (const a of arms) {
      x0 = Math.min(x0, x + FDX[a.dir] * a.len - 4);
      z0 = Math.min(z0, z + FDZ[a.dir] * a.len - 4);
      x1 = Math.max(x1, x + FDX[a.dir] * a.len + 4);
      z1 = Math.max(z1, z + FDZ[a.dir] * a.len + 4);
    }
    return { type: 'nether_fortress', x, y, z, arms, x0, z0, x1, z1 };
  },

  bastion(world, generator, spec, origin) {
    const x = origin.cx * 16 + 8, z = origin.cz * 16 + 8;
    const rng = new Random(hash3(world.seed ^ spec.salt, origin.cx, 8, origin.cz) | 0);
    const y = rng.intRange(46, 72);
    return { type: 'bastion', x, y, z, ...bbox(x, z, 18, 18) };
  },

  nether_ruined_portal(world, generator, spec, origin) {
    const x = origin.cx * 16 + 8, z = origin.cz * 16 + 8;
    const rng = new Random(hash3(world.seed ^ spec.salt, origin.cx, 11, origin.cz) | 0);
    const y = rng.intRange(34, 92);
    return { type: 'nether_ruined_portal', x, y, z, ...bbox(x, z, 7, 7) };
  },

  basalt_pillars(world, generator, spec, origin) {
    const x = origin.cx * 16 + 8, z = origin.cz * 16 + 8;
    return { type: 'basalt_pillars', x, y: 0, z, ...bbox(x, z, 8, 8) };
  },

  end_city(world, generator, spec, origin) {
    const x = origin.cx * 16 + 8, z = origin.cz * 16 + 8;
    if (Math.hypot(x, z) < 900) return null;
    const y = anchorHeight(world, generator, x, z);
    if (y === null || y < MIN_Y + 8) return null;
    return { type: 'end_city', x, y: y + 1, z, ...bbox(x, z, 14, 14) };
  },
};

/** Shared layout for the small "one building on the surface" structures. */
function siteLayout(type, rx, rz, biomeOk, opts = {}) {
  return (world, generator, spec, origin) => {
    const x = origin.cx * 16 + 8, z = origin.cz * 16 + 8;
    const y = anchorHeight(world, generator, x, z);
    if (y === null) return null;
    if (!opts.anyHeight && !opts.allowWater && y < SEA_LEVEL) return null;
    const cat = biomeCategoryAt(world, x, z);
    if (!biomeOk(cat)) return null;
    return { type, x, y, z, cat, ...bbox(x, z, rx, rz) };
  };
}

/** Biome category at a column, tolerating unloaded chunks. */
function biomeCategoryAt(world, x, z) {
  if (!world.isChunkLoadedAt(x, z)) return 'plains';
  return biomeCategory(world, x, z);
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const BUILDING_SIZE = {
  small_house: { w: 7, d: 7 },
  large_house: { w: 9, d: 11 },
  farm: { w: 9, d: 9 },
  library: { w: 9, d: 9 },
  blacksmith: { w: 9, d: 8 },
  church: { w: 7, d: 9 },
  animal_pen: { w: 9, d: 7 },
};

const BUILDERS = {
  village: buildVillage,
  mineshaft: buildMineshaft,
  ravine: buildRavine,
  desert_pyramid: buildDesertPyramid,
  jungle_temple: buildJungleTemple,
  witch_hut: buildWitchHut,
  igloo: buildIgloo,
  pillager_outpost: buildPillagerOutpost,
  ruined_portal: (w, wr, l, r) => buildRuinedPortal(w, wr, l, r, false),
  shipwreck: buildShipwreck,
  ocean_monument: buildOceanMonument,
  nether_fortress: buildNetherFortress,
  bastion: buildBastion,
  nether_ruined_portal: (w, wr, l, r) => buildRuinedPortal(w, wr, l, r, true),
  basalt_pillars: buildBasaltPillars,
  end_city: buildEndCity,
};

// -- villages ----------------------------------------------------------------

function buildVillage(world, writer, layout, rng) {
  const style = layout.style;
  const pathState = B(style.path);

  // Well or meeting point at the centre.
  const cx = layout.x, cz = layout.z, cy = layout.y;
  if (writer.hits(cx - 4, cz - 4, cx + 4, cz + 4)) {
    const base = B(style.base);
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (Math.abs(dx) === 3 && Math.abs(dz) === 3) continue;
        writer.set(cx + dx, cy, cz + dz, base);
        writer.clear(cx + dx, cy + 1, cz + dz, cx + dx, cy + 4, cz + dz);
      }
    }
    if (layout.styleName === 'desert' || layout.styleName === 'plains') {
      // A well.
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const edge = Math.abs(dx) === 1 || Math.abs(dz) === 1;
          writer.set(cx + dx, cy, cz + dz, edge ? base : B('water'));
          writer.set(cx + dx, cy - 1, cz + dz, edge ? base : B('water'));
          writer.set(cx + dx, cy - 2, cz + dz, edge ? base : B('water'));
        }
      }
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        for (let h = 1; h <= 3; h++) writer.set(cx + dx, cy + h, cz + dz, base);
      }
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) writer.set(cx + dx, cy + 4, cz + dz, slabOf(style.slab, 'bottom'));
      }
    } else {
      // A meeting point: fire pit, logs to sit on, and a bell.
      writer.set(cx, cy + 1, cz, S('campfire',
        { facing: 'north', lit: true, signal_fire: false, waterlogged: false }));
      for (const [dx, dz] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
        writer.set(cx + dx, cy + 1, cz + dz, B(style.accent));
      }
      writer.set(cx + 3, cy + 1, cz, B('oak_fence'));
      writer.set(cx + 3, cy + 2, cz, B('bell'));
    }
  }

  // Paths radiating from the centre.
  for (const p of layout.paths) {
    const dx = FDX[p.dir], dz = FDZ[p.dir];
    for (let i = 2; i <= p.len; i++) {
      for (let w = -1; w <= 1; w++) {
        const px = cx + dx * i + (-dz) * w;
        const pz = cz + dz * i + dx * w;
        if (!writer.inside(px, pz)) continue;
        const gy = groundY(world, px, pz);
        if (gy < MIN_Y) continue;
        const on = nameOf(world.getBlock(gy >= MIN_Y ? px : px, gy, pz));
        if (on === 'water' || T.fluid[world.getBlock(px, gy, pz)]) continue;
        writer.set(px, gy, pz, pathState);
        writer.clear(px, gy + 1, pz, px, gy + 2, pz);
      }
    }
  }

  // Buildings.
  for (const b of layout.buildings) {
    if (!writer.hits(b.x - 1, b.z - 1, b.x + b.w, b.z + b.d)) continue;
    const bRng = new Random(hash3(world.seed ^ 0xb0117, b.x, 0, b.z) | 0);
    const floorY = buildingFloor(world, b, cy);
    VILLAGE_BUILDERS[b.type](world, writer, b, floorY, style, bRng);
  }

  // Villagers and a golem, only from the chunk containing the centre so each
  // spawns exactly once.
  if (writer.inside(cx, cz)) {
    const n = rng.intRange(4, 8);
    for (let i = 0; i < n; i++) {
      spawnMob(world, 'villager', cx + rng.intRange(-6, 6), cy + 1, cz + rng.intRange(-6, 6),
        { profession: rng.pick(['farmer', 'librarian', 'weaponsmith', 'cleric',
          'butcher', 'toolsmith', 'shepherd', 'fisherman']) });
    }
    spawnMob(world, 'iron_golem', cx + rng.intRange(-4, 4), cy + 1, cz + rng.intRange(-4, 4));
  }
}

/** Average the terrain across a building footprint so it sits level. */
function buildingFloor(world, b, fallback) {
  let sum = 0, n = 0;
  for (const [x, z] of [[b.x, b.z], [b.x + b.w - 1, b.z], [b.x, b.z + b.d - 1],
    [b.x + b.w - 1, b.z + b.d - 1], [b.x + (b.w >> 1), b.z + (b.d >> 1)]]) {
    if (!world.isChunkLoadedAt(x, z)) continue;
    const g = groundY(world, x, z);
    if (g < MIN_Y) continue;
    sum += g; n++;
  }
  return (n ? Math.round(sum / n) : fallback) + 1;
}

const VILLAGE_BUILDERS = {
  small_house(world, writer, b, floorY, style, rng) {
    const x0 = b.x, z0 = b.z, x1 = b.x + b.w - 1, z1 = b.z + b.d - 1;
    terraform(writer, world, x0, z0, x1, z1, floorY, 6, B(style.base));
    writer.fill(x0, floorY - 1, z0, x1, floorY - 1, z1, B(style.wall));
    writer.hollow(x0, floorY, z0, x1, floorY + 3, z1, B(style.wall), 0);
    // Corner posts and a window on each long side.
    for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      writer.fill(px, floorY, pz, px, floorY + 3, pz, B(style.accent));
    }
    const mid = Math.floor((z0 + z1) / 2);
    writer.set(x0, floorY + 2, mid, B(style.glass));
    writer.set(x1, floorY + 2, mid, B(style.glass));
    const dz = b.facing === 0 ? z0 : b.facing === 2 ? z1 : mid;
    const dx = b.facing === 3 ? x0 : b.facing === 1 ? x1 : Math.floor((x0 + x1) / 2);
    doorPair(writer, dx, floorY, dz, style.door, FACINGS[b.facing]);
    gableRoof(writer, x0, z0, x1, z1, floorY + 4, style);
    writer.set(x0 + 1, floorY, z0 + 1, S(style.bed, { facing: 'south', occupied: false, part: 'foot' }));
    writer.set(x0 + 1, floorY, z0 + 2, S(style.bed, { facing: 'south', occupied: false, part: 'head' }));
    writer.set(x1 - 1, floorY, z1 - 1, B('crafting_table'));
    writer.set(x1 - 1, floorY + 3, z1 - 2, B(style.light));
    if (rng.chance(0.6)) chest(writer, x1 - 1, floorY, z0 + 1, 'west', 'village_house', rng);
  },

  large_house(world, writer, b, floorY, style, rng) {
    const x0 = b.x, z0 = b.z, x1 = b.x + b.w - 1, z1 = b.z + b.d - 1;
    terraform(writer, world, x0, z0, x1, z1, floorY, 9, B(style.base));
    writer.fill(x0, floorY - 1, z0, x1, floorY - 1, z1, B(style.wall));
    writer.hollow(x0, floorY, z0, x1, floorY + 3, z1, B(style.wall), 0);
    writer.hollow(x0, floorY + 4, z0, x1, floorY + 6, z1, B(style.wall), 0);
    writer.fill(x0 + 1, floorY + 4, z0 + 1, x1 - 1, floorY + 4, z1 - 1, B(style.wall));
    for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      writer.fill(px, floorY, pz, px, floorY + 6, pz, B(style.accent));
    }
    const mid = Math.floor((z0 + z1) / 2);
    for (const y of [floorY + 2, floorY + 5]) {
      writer.set(x0, y, mid, B(style.glass));
      writer.set(x1, y, mid, B(style.glass));
      writer.set(Math.floor((x0 + x1) / 2), y, z0, B(style.glass));
    }
    doorPair(writer, Math.floor((x0 + x1) / 2), floorY, z1, style.door, 'north');
    // A ladder to the upper floor.
    writer.set(x0 + 1, floorY + 4, z0 + 1, 0);
    for (let y = floorY; y <= floorY + 4; y++) {
      writer.set(x0 + 1, y, z0 + 1, S('ladder', { facing: 'south', waterlogged: false }));
    }
    gableRoof(writer, x0, z0, x1, z1, floorY + 7, style);
    writer.set(x1 - 1, floorY + 4, z1 - 1, S(style.bed, { facing: 'north', occupied: false, part: 'foot' }));
    writer.set(x1 - 1, floorY + 4, z1 - 2, S(style.bed, { facing: 'north', occupied: false, part: 'head' }));
    writer.set(x0 + 2, floorY, z1 - 1, B('crafting_table'));
    writer.set(x0 + 3, floorY, z1 - 1, S('furnace', { facing: 'north', lit: false }));
    if (rng.chance(0.8)) chest(writer, x1 - 1, floorY, z0 + 1, 'west', 'village_house', rng);
  },

  farm(world, writer, b, floorY, style, rng) {
    const x0 = b.x, z0 = b.z, x1 = b.x + b.w - 1, z1 = b.z + b.d - 1;
    terraform(writer, world, x0, z0, x1, z1, floorY, 3, B(style.base));
    const fence = B(style.fence);
    const farmland = S('farmland', { moisture: 7 });
    const crops = ['wheat', 'carrots', 'potatoes', 'beetroots'];
    const crop = crops[rng.int(crops.length)];
    const mid = Math.floor((x0 + x1) / 2);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const edge = x === x0 || x === x1 || z === z0 || z === z1;
        if (edge) {
          writer.set(x, floorY - 1, z, B(style.base));
          writer.set(x, floorY, z, fence);
          continue;
        }
        if (x === mid) {
          // A water channel down the middle keeps the farmland hydrated.
          writer.set(x, floorY - 1, z, B('water'));
          writer.set(x, floorY, z, 0);
          continue;
        }
        writer.set(x, floorY - 1, z, farmland);
        const age = crop === 'beetroots' ? rng.int(4) : rng.int(8);
        writer.set(x, floorY, z, S(crop, { age }));
      }
    }
    // A gap in the fence to walk through.
    writer.set(mid + 1, floorY, z0, 0);
    if (rng.chance(0.5)) {
      writer.set(x0 + 1, floorY, z1 - 1, B('composter'));
    }
  },

  library(world, writer, b, floorY, style, rng) {
    const x0 = b.x, z0 = b.z, x1 = b.x + b.w - 1, z1 = b.z + b.d - 1;
    terraform(writer, world, x0, z0, x1, z1, floorY, 6, B(style.base));
    writer.fill(x0, floorY - 1, z0, x1, floorY - 1, z1, B(style.wall));
    writer.hollow(x0, floorY, z0, x1, floorY + 4, z1, B(style.wall), 0);
    for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      writer.fill(px, floorY, pz, px, floorY + 4, pz, B(style.accent));
    }
    const bookshelf = B('bookshelf');
    for (let z = z0 + 1; z <= z1 - 1; z++) {
      writer.set(x0 + 1, floorY, z, bookshelf);
      writer.set(x0 + 1, floorY + 1, z, bookshelf);
      writer.set(x1 - 1, floorY, z, bookshelf);
    }
    writer.set(Math.floor((x0 + x1) / 2), floorY, Math.floor((z0 + z1) / 2),
      S('lectern', { facing: 'north', has_book: true, powered: false }));
    for (let i = 0; i < 3; i++) {
      writer.set(x0 + 2 + i, floorY + 4, z0 + 2, B(style.light));
    }
    doorPair(writer, Math.floor((x0 + x1) / 2), floorY, z1, style.door, 'north');
    for (let x = x0 + 2; x <= x1 - 2; x += 2) writer.set(x, floorY + 2, z1, B(style.glass));
    gableRoof(writer, x0, z0, x1, z1, floorY + 5, style);
    if (rng.chance(0.7)) chest(writer, x1 - 1, floorY, z1 - 1, 'west', 'village_house', rng);
  },

  blacksmith(world, writer, b, floorY, style, rng) {
    const x0 = b.x, z0 = b.z, x1 = b.x + b.w - 1, z1 = b.z + b.d - 1;
    terraform(writer, world, x0, z0, x1, z1, floorY, 6, B(style.base));
    writer.fill(x0, floorY - 1, z0, x1, floorY - 1, z1, B('cobblestone'));
    writer.hollow(x0, floorY, z0, x1, floorY + 3, z1, B(style.wall), 0);
    // The forge half is open to the street.
    const split = Math.floor((x0 + x1) / 2);
    writer.clear(x0 + 1, floorY, z0 + 1, split - 1, floorY + 3, z1 - 1);
    writer.fill(split, floorY, z0 + 1, split, floorY + 3, z1 - 1, B(style.accent));
    writer.clear(x0, floorY, z0 + 2, x0, floorY + 2, z1 - 2);
    writer.set(x0 + 1, floorY, z0 + 1, S('furnace', { facing: 'east', lit: true }));
    writer.set(x0 + 1, floorY, z0 + 2, S('furnace', { facing: 'east', lit: false }));
    writer.set(x0 + 2, floorY, z1 - 1, B('smithing_table'));
    writer.set(x0 + 1, floorY, z1 - 1, B('anvil'));
    // The lava basin every blacksmith has.
    writer.set(x0 + 2, floorY - 1, z0 + 2, B('lava'));
    for (const [dx, dz] of [[1, 2], [3, 2], [2, 1], [2, 3]]) {
      writer.set(x0 + dx, floorY - 1, z0 + dz, B('cobblestone'));
    }
    doorPair(writer, x1 - 1, floorY, z1, style.door, 'north');
    writer.set(x1 - 1, floorY + 2, z0, B(style.glass));
    chest(writer, split + 1, floorY, z0 + 1, 'south', 'village_blacksmith', rng);
    gableRoof(writer, x0, z0, x1, z1, floorY + 4, style);
    writer.set(x0 + 1, floorY + 3, z0 + 1, B(style.light));
  },

  church(world, writer, b, floorY, style, rng) {
    const x0 = b.x, z0 = b.z, x1 = b.x + b.w - 1, z1 = b.z + b.d - 1;
    terraform(writer, world, x0, z0, x1, z1, floorY, 12, B(style.base));
    writer.fill(x0, floorY - 1, z0, x1, floorY - 1, z1, B('cobblestone'));
    writer.hollow(x0, floorY, z0, x1, floorY + 5, z1, B('cobblestone'), 0);
    // A tower over the north half.
    const tx0 = x0 + 1, tx1 = x1 - 1, tz0 = z0 + 1, tz1 = z0 + 3;
    writer.hollow(tx0, floorY + 5, tz0, tx1, floorY + 9, tz1, B('cobblestone'), 0);
    for (let x = tx0; x <= tx1; x++) {
      for (let z = tz0; z <= tz1; z++) writer.set(x, floorY + 10, z, slabOf('cobblestone_slab', 'bottom'));
    }
    for (const y of [floorY + 2, floorY + 4, floorY + 7]) {
      writer.set(x0, y, Math.floor((z0 + z1) / 2), B(style.glass));
      writer.set(x1, y, Math.floor((z0 + z1) / 2), B(style.glass));
    }
    doorPair(writer, Math.floor((x0 + x1) / 2), floorY, z1, style.door, 'north');
    writer.set(x0 + 2, floorY, z0 + 2, B('brewing_stand'));
    writer.set(x1 - 2, floorY, z0 + 2, B('cauldron'));
    for (let z = z0 + 4; z <= z1 - 2; z += 2) {
      writer.set(x0 + 1, floorY, z, stairs(style.stairs, 'north'));
      writer.set(x1 - 1, floorY, z, stairs(style.stairs, 'north'));
    }
    writer.set(Math.floor((x0 + x1) / 2), floorY + 5, Math.floor((z0 + z1) / 2), B(style.light));
    if (rng.chance(0.5)) chest(writer, x1 - 1, floorY, z0 + 1, 'west', 'village_house', rng);
  },

  animal_pen(world, writer, b, floorY, style, rng) {
    const x0 = b.x, z0 = b.z, x1 = b.x + b.w - 1, z1 = b.z + b.d - 1;
    terraform(writer, world, x0, z0, x1, z1, floorY, 3, B(style.base));
    const fence = B(style.fence);
    for (let x = x0; x <= x1; x++) {
      writer.set(x, floorY, z0, fence);
      writer.set(x, floorY, z1, fence);
    }
    for (let z = z0; z <= z1; z++) {
      writer.set(x0, floorY, z, fence);
      writer.set(x1, floorY, z, fence);
    }
    const gate = Math.floor((x0 + x1) / 2);
    writer.set(gate, floorY, z1, S(`${style.fence.replace('_fence', '')}_fence_gate`,
      { facing: 'north', open: false, powered: false, in_wall: false }));
    writer.set(x0 + 1, floorY, z0 + 1, B('hay_block'));
    const animal = ['cow', 'sheep', 'pig', 'chicken'][rng.int(4)];
    if (writer.inside(gate, z0 + 2)) {
      for (let i = 0; i < 3; i++) {
        spawnMob(world, animal, x0 + 2 + rng.int(Math.max(1, b.w - 4)), floorY,
          z0 + 2 + rng.int(Math.max(1, b.d - 4)));
      }
    }
  },
};

// -- dungeon -----------------------------------------------------------------

/** A mossy cobble room with a spawner and one or two chests. */
function buildDungeon(world, writer, x, y, z, rng, dim) {
  if (!writer.inside(x, z)) return false;
  const rx = rng.intRange(2, 3), rz = rng.intRange(2, 3);
  // The room has to be buried, with an opening onto a cave somewhere.
  let openings = 0;
  for (let dz = -rz - 1; dz <= rz + 1; dz++) {
    for (let dx = -rx - 1; dx <= rx + 1; dx++) {
      const edge = Math.abs(dx) === rx + 1 || Math.abs(dz) === rz + 1;
      if (!edge) continue;
      if (world.getBlock(x + dx, y, z + dz) === 0) openings++;
      if (world.getBlock(x + dx, y + 1, z + dz) === 0) openings++;
    }
  }
  if (openings < 1 || openings > 12) return false;
  if (world.getBlock(x, y - 1, z) === 0) return false;
  if (T.fluid[world.getBlock(x, y, z)]) return false;

  const wall = dim === 'nether' ? B('nether_bricks') : B('cobblestone');
  const mossy = dim === 'nether' ? B('red_nether_bricks') : B('mossy_cobblestone');
  for (let dy = -1; dy <= 4; dy++) {
    for (let dz = -rz - 1; dz <= rz + 1; dz++) {
      for (let dx = -rx - 1; dx <= rx + 1; dx++) {
        const shell = Math.abs(dx) === rx + 1 || Math.abs(dz) === rz + 1 ||
          dy === -1 || dy === 4;
        const px = x + dx, py = y + dy, pz = z + dz;
        if (shell) writer.set(px, py, pz, rng.chance(0.28) ? mossy : wall);
        else writer.set(px, py, pz, 0);
      }
    }
  }
  const mobs = dim === 'nether'
    ? ['blaze', 'magma_cube', 'wither_skeleton']
    : ['zombie', 'skeleton', 'spider'];
  spawner(writer, x, y, z, mobs[rng.int(mobs.length)]);
  const chests = rng.intRange(1, 2);
  for (let i = 0; i < chests; i++) {
    for (let t = 0; t < 8; t++) {
      const px = x + rng.intRange(-rx, rx), pz = z + rng.intRange(-rz, rz);
      if (px === x && pz === z) continue;
      if (world.getBlock(px, y, pz) !== 0) continue;
      chest(writer, px, y, pz, FACINGS[rng.int(4)], 'dungeon', rng);
      break;
    }
  }
  return true;
}

// -- mineshaft ---------------------------------------------------------------

function buildMineshaft(world, writer, layout, rng) {
  const plank = B('oak_planks');
  const fence = B('oak_fence');
  const rail = S('rail', { shape: 'north_south', waterlogged: false });
  const railEW = S('rail', { shape: 'east_west', waterlogged: false });
  const web = B('cobweb');
  const torch = B('torch');

  for (const c of layout.corridors) {
    const x0 = Math.min(c.x, c.ex) - 2, x1 = Math.max(c.x, c.ex) + 2;
    const z0 = Math.min(c.z, c.ez) - 2, z1 = Math.max(c.z, c.ez) + 2;
    if (!writer.hits(x0, z0, x1, z1)) continue;
    const cRng = new Random(hash3(world.seed ^ 0x91ne, c.x, c.y, c.z) | 0);
    const dx = FDX[c.dir], dz = FDZ[c.dir];
    const len = Math.abs(c.ex - c.x) + Math.abs(c.ez - c.z);
    const across = dx !== 0 ? [0, 1] : [1, 0];

    for (let i = 0; i <= len; i++) {
      const px = c.x + dx * i, pz = c.z + dz * i, py = c.y;
      // A 3-wide, 3-tall tunnel.
      for (let a = -1; a <= 1; a++) {
        const ax = px + across[0] * a, az = pz + across[1] * a;
        writer.clear(ax, py, az, ax, py + 2, az);
        if (world.getBlock(ax, py - 1, az) === 0 || T.fluid[world.getBlock(ax, py - 1, az)]) {
          writer.set(ax, py - 1, az, plank);
        }
      }
      // Support arches.
      if (i % 5 === 0 && i > 0) {
        for (const a of [-1, 1]) {
          const ax = px + across[0] * a, az = pz + across[1] * a;
          writer.set(ax, py, az, fence);
          writer.set(ax, py + 1, az, fence);
          writer.set(ax, py + 2, az, plank);
        }
        writer.set(px, py + 2, pz, plank);
        if (cRng.chance(0.3)) writer.set(px, py + 2, pz - 0, plank);
        if (cRng.chance(0.35)) writer.set(px + across[0], py + 2, pz + across[1], torch);
      }
      if (cRng.chance(0.55)) writer.set(px, py, pz, dx !== 0 ? railEW : rail);
      if (cRng.chance(0.06)) {
        writer.set(px + across[0] * cRng.intRange(-1, 1), py + cRng.int(2),
          pz + across[1] * cRng.intRange(-1, 1), web);
      }
      if (cRng.oneIn(80)) {
        chest(writer, px + across[0], py, pz + across[1], FACINGS[cRng.int(4)],
          'mineshaft', cRng);
      }
    }

    // Cave spider nests: a small web-choked room with a spawner.
    if (c.room) {
      const rxc = c.ex, rzc = c.ez, ry = c.y;
      for (let dy = 0; dy <= 3; dy++) {
        for (let ddz = -3; ddz <= 3; ddz++) {
          for (let ddx = -3; ddx <= 3; ddx++) {
            const shell = Math.abs(ddx) === 3 || Math.abs(ddz) === 3 || dy === 0 || dy === 3;
            if (shell) {
              if (world.getBlock(rxc + ddx, ry - 1 + dy, rzc + ddz) === 0) {
                writer.set(rxc + ddx, ry - 1 + dy, rzc + ddz, plank);
              }
            } else {
              writer.set(rxc + ddx, ry - 1 + dy, rzc + ddz,
                cRng.chance(0.25) ? web : 0);
            }
          }
        }
      }
      spawner(writer, rxc, ry, rzc, 'cave_spider');
      if (cRng.chance(0.6)) {
        chest(writer, rxc + 2, ry, rzc + 2, 'west', 'mineshaft', cRng);
      }
    }
  }
  void rng;
}

// -- ravine ------------------------------------------------------------------

function buildRavine(world, writer, layout, rng) {
  const steps = Math.round(Math.hypot(layout.ex - layout.x, layout.ez - layout.z));
  const dx = (layout.ex - layout.x) / Math.max(1, steps);
  const dz = (layout.ez - layout.z) / Math.max(1, steps);
  const lava = B('lava');
  for (let i = 0; i <= steps; i++) {
    const t = i / Math.max(1, steps);
    const cx = layout.x + dx * i;
    const cz = layout.z + dz * i;
    // Width tapers to a point at both ends, and wanders as it goes.
    const wobble = Math.sin(t * 9 + layout.angle) * 2;
    const half = (1 - Math.abs(t * 2 - 1)) * 4 + 1;
    const depth = Math.round(layout.depth * (0.4 + 0.6 * (1 - Math.abs(t * 2 - 1))));
    const px0 = Math.floor(cx - half - 1 + wobble), px1 = Math.ceil(cx + half + 1 + wobble);
    const pz0 = Math.floor(cz - half - 1 + wobble), pz1 = Math.ceil(cz + half + 1 + wobble);
    if (!writer.hits(px0, pz0, px1, pz1)) continue;
    for (let z = pz0; z <= pz1; z++) {
      for (let x = px0; x <= px1; x++) {
        const d = Math.hypot(x - cx - wobble, z - cz - wobble);
        if (d > half) continue;
        const bottom = layout.y - depth;
        for (let y = bottom; y <= layout.y; y++) {
          const shrink = (layout.y - y) / Math.max(1, depth);
          if (d > half * (1 - shrink * 0.55)) continue;
          const cur = world.getBlock(x, y, z);
          if (cur === 0) continue;
          if (nameOf(cur) === 'bedrock') continue;
          writer.set(x, y, z, y <= bottom + 1 && rng.chance(0.35) ? lava : 0);
        }
      }
    }
  }
}

// -- desert pyramid ----------------------------------------------------------

function buildDesertPyramid(world, writer, layout, rng) {
  const x = layout.x, z = layout.z, base = layout.y - 4;
  const sandstone = B('sandstone');
  const cut = B('cut_sandstone');
  const chiseled = B('chiseled_sandstone');
  const orange = B('orange_terracotta');
  const size = 10;

  for (let level = 0; level <= size; level++) {
    const r = size - level;
    if (r < 0) break;
    const y = base + level;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const edge = Math.abs(dx) === r || Math.abs(dz) === r;
        if (level === 0) writer.set(x + dx, y, z + dz, sandstone);
        else if (edge) writer.set(x + dx, y, z + dz, rng.chance(0.15) ? cut : sandstone);
        else writer.set(x + dx, y, z + dz, 0);
      }
    }
  }
  // Two towers flanking the entrance.
  for (const sx of [-8, 8]) {
    for (let h = 0; h < 10; h++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          writer.set(x + sx + dx, base + h, z - 8 + dz,
            (h > 7 && (dx === 0 && dz === 0)) ? 0 : sandstone);
        }
      }
    }
  }

  // The hidden chamber under the floor, reached by breaking the blue pattern.
  const cy = base - 12;
  writer.hollow(x - 5, cy, z - 5, x + 5, cy + 4, z + 5, sandstone, 0);
  writer.fill(x - 1, cy, z - 1, x + 1, cy, z + 1, orange);
  writer.set(x, cy, z, S('stone_pressure_plate', { powered: false }));
  writer.fill(x - 1, cy - 3, z - 1, x + 1, cy - 1, z + 1, B('tnt'));
  const facings = ['east', 'west', 'south', 'north'];
  const spots = [[-4, 0], [4, 0], [0, -4], [0, 4]];
  for (let i = 0; i < 4; i++) {
    chest(writer, x + spots[i][0], cy + 1, z + spots[i][1], facings[i],
      'desert_pyramid', rng);
  }
  // A shaft from the pyramid floor down to the chamber, hidden by the pattern.
  writer.fill(x, cy + 5, z, x, base - 1, z, 0);
  writer.set(x, base, z, chiseled);
  // The decorative eye on the pyramid floor.
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) === 2 || Math.abs(dz) === 2) {
        writer.set(x + dx, base, z + dz, orange);
      }
    }
  }
}

// -- jungle temple -----------------------------------------------------------

function buildJungleTemple(world, writer, layout, rng) {
  const x = layout.x, z = layout.z, y = layout.y;
  const cobble = B('cobblestone');
  const mossy = B('mossy_cobblestone');
  const mix = (px, py, pz) => writer.set(px, py, pz, rng.chance(0.35) ? mossy : cobble);

  for (let dy = -4; dy <= 8; dy++) {
    for (let dz = -6; dz <= 6; dz++) {
      for (let dx = -5; dx <= 5; dx++) {
        const shell = Math.abs(dx) === 5 || Math.abs(dz) === 6 || dy === -4;
        const px = x + dx, py = y + dy, pz = z + dz;
        if (dy > 4) {
          // Stepped roof.
          const r = 5 - (dy - 4);
          if (Math.abs(dx) <= r && Math.abs(dz) <= r + 1) mix(px, py, pz);
          continue;
        }
        if (shell) mix(px, py, pz);
        else writer.set(px, py, pz, 0);
      }
    }
  }
  // Entrance and interior stairs.
  writer.clear(x - 1, y - 3, z + 6, x + 1, y - 1, z + 6);
  for (let i = 0; i < 3; i++) {
    writer.set(x - 1 + i, y - 3, z + 5, stairs('cobblestone_stairs', 'south'));
  }
  // Two puzzle chests behind tripwire, plus a lever puzzle wall.
  chest(writer, x - 3, y - 3, z - 4, 'east', 'jungle_temple', rng);
  chest(writer, x + 3, y - 3, z + 3, 'west', 'jungle_temple', rng);
  for (let i = 0; i < 3; i++) {
    writer.set(x - 2 + i, y - 2, z - 5, B('lever'));
  }
  writer.set(x, y - 3, z - 5, B('redstone_wire'));
  // Vines creeping over the outside.
  for (let i = 0; i < 40; i++) {
    const vx = x + rng.intRange(-6, 6), vz = z + rng.intRange(-7, 7);
    const vy = y + rng.intRange(-3, 6);
    writer.soft(vx, vy, vz, S('vine',
      { north: true, east: false, south: false, west: false, up: false }));
  }
}

// -- witch hut ---------------------------------------------------------------

function buildWitchHut(world, writer, layout, rng) {
  const x = layout.x, z = layout.z;
  const floorY = Math.max(layout.y + 3, SEA_LEVEL + 2);
  const plank = B('spruce_planks');
  const log = S('spruce_log', { axis: 'y' });
  const fence = B('spruce_fence');

  // Stilts down to whatever is below — mud, water or land.
  for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
    for (let y = floorY - 1; y > floorY - 12; y--) {
      const cur = world.getBlock(x + dx, y, z + dz);
      writer.set(x + dx, y, z + dz, log);
      if (cur !== 0 && !T.fluid[cur] && T.solid[cur]) break;
    }
  }
  writer.fill(x - 3, floorY, z - 3, x + 3, floorY, z + 3, plank);
  writer.hollow(x - 2, floorY + 1, z - 2, x + 2, floorY + 4, z + 2, plank, 0);
  // Open doorway and a window.
  writer.clear(x, floorY + 1, z + 2, x, floorY + 2, z + 2);
  writer.set(x - 2, floorY + 2, z, 0);
  for (let dx = -3; dx <= 3; dx++) {
    writer.set(x + dx, floorY + 5, z - 3, stairs('spruce_stairs', 'south'));
    writer.set(x + dx, floorY + 5, z + 3, stairs('spruce_stairs', 'north'));
  }
  writer.fill(x - 3, floorY + 5, z - 2, x + 3, floorY + 5, z + 2, plank);
  writer.set(x - 1, floorY + 1, z - 1, B('cauldron'));
  writer.set(x + 1, floorY + 1, z - 1, B('crafting_table'));
  writer.set(x + 1, floorY + 1, z + 1, B('brewing_stand'));
  writer.set(x - 1, floorY + 1, z + 1, fence);
  writer.set(x - 1, floorY + 2, z + 1, B('flower_pot'));
  if (writer.inside(x, z)) {
    spawnMob(world, 'witch', x, floorY + 1, z);
    spawnMob(world, 'cat', x + 1, floorY + 1, z);
  }
  void rng;
}

// -- igloo -------------------------------------------------------------------

function buildIgloo(world, writer, layout, rng) {
  const x = layout.x, z = layout.z, y = layout.y + 1;
  const snow = B('snow_block');
  const ice = B('ice');
  const r = 4;
  for (let dy = 0; dy <= r; dy++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > r) continue;
        writer.set(x + dx, y + dy, z + dz, d > r - 1 ? snow : 0);
      }
    }
  }
  writer.fill(x - r, y - 1, z - r, x + r, y - 1, z + r, snow);
  // Entrance tunnel.
  writer.clear(x, y, z + r - 1, x, y + 1, z + r + 1);
  writer.set(x, y, z + r + 1, B('snow_block'));
  writer.set(x - 1, y, z + r, snow); writer.set(x + 1, y, z + r, snow);
  writer.set(x, y + 2, z + r, snow);
  writer.set(x, y, z + r, S('oak_door',
    { facing: 'south', half: 'bottom', hinge: 'left', open: false, powered: false }));
  writer.set(x, y + 1, z + r, S('oak_door',
    { facing: 'south', half: 'top', hinge: 'left', open: false, powered: false }));

  writer.set(x - 2, y, z - 2, S('white_bed', { facing: 'east', occupied: false, part: 'head' }));
  writer.set(x - 1, y, z - 2, S('white_bed', { facing: 'east', occupied: false, part: 'foot' }));
  writer.set(x + 2, y, z - 2, S('furnace', { facing: 'west', lit: false }));
  writer.set(x + 2, y, z - 1, B('crafting_table'));
  writer.set(x, y, z - 3, B('redstone_torch'));
  for (let i = 0; i < 6; i++) {
    writer.set(x + rng.intRange(-2, 2), y - 1, z + rng.intRange(-2, 2), ice);
  }

  // A basement lab under a trapdoor, in about half of them.
  if (rng.chance(0.5)) {
    const bY = y - 9;
    writer.set(x + 1, y - 1, z + 1, S('oak_trapdoor',
      { facing: 'north', half: 'bottom', open: false, powered: false, waterlogged: false }));
    for (let yy = bY + 5; yy < y; yy++) {
      writer.set(x + 1, yy, z + 1, 0);
      writer.set(x + 1, yy, z + 2, S('ladder', { facing: 'south', waterlogged: false }));
    }
    writer.hollow(x - 4, bY, z - 4, x + 4, bY + 5, z + 4, B('stone_bricks'), 0);
    writer.fill(x - 3, bY + 1, z - 3, x + 3, bY + 1, z + 3, B('stone_bricks'));
    writer.clear(x - 3, bY + 2, z - 3, x + 3, bY + 4, z + 3);
    writer.set(x - 2, bY + 2, z - 2, B('brewing_stand'));
    writer.set(x - 2, bY + 2, z - 1, B('cauldron'));
    writer.set(x + 2, bY + 2, z - 2,
      S('red_bed', { facing: 'south', occupied: false, part: 'head' }));
    writer.set(x + 2, bY + 2, z - 1,
      S('red_bed', { facing: 'south', occupied: false, part: 'foot' }));
    writer.set(x + 2, bY + 2, z + 2,
      S('white_bed', { facing: 'north', occupied: false, part: 'head' }));
    writer.set(x + 2, bY + 2, z + 1,
      S('white_bed', { facing: 'north', occupied: false, part: 'foot' }));
    chest(writer, x - 2, bY + 2, z + 2, 'east', 'igloo', rng);
    for (let i = 0; i < 6; i++) {
      writer.set(x - 3 + rng.int(7), bY + 2, z - 3 + rng.int(7), B('cobweb'));
    }
    if (writer.inside(x + 2, z + 1)) {
      spawnMob(world, 'villager', x + 2, bY + 3, z + 1, { profession: 'cleric' });
      spawnMob(world, 'zombie_villager', x + 2, bY + 3, z - 1);
    }
  }
}

// -- pillager outpost --------------------------------------------------------

function buildPillagerOutpost(world, writer, layout, rng) {
  const x = layout.x, z = layout.z, y = layout.y + 1;
  const log = S('dark_oak_log', { axis: 'y' });
  const plank = B('dark_oak_planks');
  const fence = B('dark_oak_fence');

  terraform(writer, world, x - 3, z - 3, x + 3, z + 3, y, 16, B('cobblestone'));
  for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
    writer.fill(x + dx, y, z + dz, x + dx, y + 11, z + dz, log);
  }
  for (const floor of [4, 8, 12]) {
    writer.fill(x - 2, y + floor, z - 2, x + 2, y + floor, z + 2, plank);
  }
  // Walls of the top room.
  writer.hollow(x - 3, y + 12, z - 3, x + 3, y + 15, z + 3, plank, 0);
  writer.fill(x - 3, y + 12, z - 3, x + 3, y + 12, z + 3, plank);
  for (let i = -2; i <= 2; i++) {
    writer.set(x + i, y + 14, z - 3, 0);
    writer.set(x + i, y + 14, z + 3, 0);
    writer.set(x - 3, y + 14, z + i, 0);
    writer.set(x + 3, y + 14, z + i, 0);
  }
  // Ladder up the middle.
  for (let yy = y; yy < y + 12; yy++) {
    writer.set(x, yy, z, 0);
    writer.set(x, yy, z + 1, S('ladder', { facing: 'south', waterlogged: false }));
  }
  writer.set(x, y + 12, z, 0);
  chest(writer, x + 2, y + 13, z + 2, 'west', 'pillager_outpost', rng);
  // A caged iron golem hanging under the tower, as outposts have.
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      writer.set(x + 5 + dx, y, z + 5 + dz, B('dark_oak_planks'));
      writer.set(x + 5 + dx, y + 4, z + 5 + dz, fence);
      if (Math.abs(dx) === 1 || Math.abs(dz) === 1) {
        writer.fill(x + 5 + dx, y + 1, z + 5 + dz, x + 5 + dx, y + 3, z + 5 + dz, fence);
      }
    }
  }
  if (writer.inside(x, z)) {
    for (let i = 0; i < 3; i++) {
      spawnMob(world, 'pillager', x + rng.intRange(-3, 3), y + 1, z + rng.intRange(-3, 3));
    }
    spawnMob(world, 'iron_golem', x + 5, y + 1, z + 5);
  }
}

// -- ruined portal -----------------------------------------------------------

function buildRuinedPortal(world, writer, layout, rng, nether) {
  const x = layout.x, z = layout.z;
  const y = nether ? layout.y : layout.y + 1;
  const obsidian = B('obsidian');
  const crying = B('crying_obsidian');
  const netherrack = B('netherrack');
  const blackstone = B('blackstone');
  const gold = B('gold_block');
  const magma = B('magma_block');
  const axis = rng.chance(0.5) ? 'x' : 'z';
  const dx = axis === 'x' ? 1 : 0, dz = axis === 'z' ? 1 : 0;
  const width = rng.intRange(2, 4), height = rng.intRange(3, 5);

  // A cracked, half-collapsed frame.
  for (let i = -1; i <= width; i++) {
    for (let j = -1; j <= height; j++) {
      const onFrame = i === -1 || i === width || j === -1 || j === height;
      if (!onFrame) { writer.set(x + dx * i, y + j, z + dz * i, 0); continue; }
      if (rng.chance(0.28)) continue;         // missing block
      writer.set(x + dx * i, y + j, z + dz * i,
        rng.chance(0.12) ? crying : obsidian);
    }
  }
  // Rubble around the base.
  for (let i = 0; i < 60; i++) {
    const px = x + rng.intRange(-4, 6), pz = z + rng.intRange(-4, 6);
    const py = y - 1 + rng.int(2);
    const roll = rng.next();
    writer.soft(px, py, pz, roll < 0.5 ? netherrack : roll < 0.8 ? blackstone : magma);
  }
  if (rng.chance(0.3)) {
    writer.set(x + dx * Math.floor(width / 2), y + height, z + dz * Math.floor(width / 2), gold);
  }
  chest(writer, x - dz * 2 - dx, y, z - dx * 2 - dz, FACINGS[rng.int(4)],
    'ruined_portal', rng);
}

// -- shipwreck ---------------------------------------------------------------

function buildShipwreck(world, writer, layout, rng) {
  const x = layout.x, z = layout.z, y = layout.y;
  const plank = B('oak_planks');
  const dark = B('dark_oak_planks');
  const alongX = layout.dir % 2 === 0;
  const len = 14, wide = 5;
  const tilt = rng.chance(0.5) ? 1 : 0;

  for (let i = 0; i < len; i++) {
    // The hull narrows to a point at bow and stern.
    const t = Math.abs(i - (len - 1) / 2) / ((len - 1) / 2);
    const half = Math.max(0, Math.round((wide / 2) * (1 - t * t)));
    const yy = y + (tilt ? Math.round((i / len) * 2) : 0);
    for (let a = -half; a <= half; a++) {
      const px = alongX ? x + i - (len >> 1) : x + a;
      const pz = alongX ? z + a : z + i - (len >> 1);
      writer.set(px, yy, pz, plank);
      if (Math.abs(a) === half) {
        writer.set(px, yy + 1, pz, dark);
        if (rng.chance(0.6)) writer.set(px, yy + 2, pz, dark);
      }
      // Hull damage.
      if (rng.chance(0.12)) writer.set(px, yy, pz, 0);
    }
  }
  // Deck, mast and cabin.
  const mx = alongX ? x + 3 : x, mz = alongX ? z : z + 3;
  for (let h = 1; h <= 6; h++) writer.set(mx, y + h + tilt, mz, S('oak_log', { axis: 'y' }));
  const cx = alongX ? x - 4 : x, cz = alongX ? z : z - 4;
  writer.hollow(cx - 1, y + 1, cz - 1, cx + 1, y + 3, cz + 1, dark, 0);

  const tables = ['shipwreck_map', 'shipwreck_supply', 'shipwreck_treasure'];
  for (let i = 0; i < 3; i++) {
    const px = alongX ? x - 5 + i * 5 : x + (i - 1);
    const pz = alongX ? z + (i - 1) : z - 5 + i * 5;
    chest(writer, px, y + 1 + tilt, pz, FACINGS[rng.int(4)], tables[i], rng);
  }
  // Buried treasure marks the map's X, a short walk away.
  const tx = x + rng.intRange(-40, 40), tz = z + rng.intRange(-40, 40);
  if (writer.inside(tx, tz)) {
    const ty = groundY(world, tx, tz);
    if (ty > MIN_Y) chest(writer, tx, ty, tz, 'north', 'buried_treasure', rng);
  }
}

// -- ocean monument ----------------------------------------------------------

function buildOceanMonument(world, writer, layout, rng) {
  const x = layout.x, z = layout.z, y = layout.y;
  const pris = B('prismarine');
  const bricks = B('prismarine_bricks');
  const dark = B('dark_prismarine');
  const lantern = B('sea_lantern');
  const gold = B('gold_block');
  const water = B('water');
  const r = 14;

  // Foundation reaching the sea floor.
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (Math.abs(dx) + Math.abs(dz) > r + 8) continue;
      const px = x + dx, pz = z + dz;
      if (!writer.inside(px, pz)) continue;
      const g = groundY(world, px, pz);
      for (let py = Math.max(MIN_Y + 1, g); py < y; py++) writer.set(px, py, pz, pris);
    }
  }
  // The main block: a stepped prismarine hall.
  writer.hollow(x - r, y, z - r, x + r, y + 8, z + r, bricks, water);
  writer.hollow(x - 8, y + 8, z - 8, x + 8, y + 14, z + 8, bricks, water);
  writer.hollow(x - 4, y + 14, z - 4, x + 4, y + 18, z + 4, dark, water);
  // Interior rooms and pillars.
  for (const [ox, oz] of [[-8, -8], [8, -8], [-8, 8], [8, 8]]) {
    writer.hollow(x + ox - 3, y + 1, z + oz - 3, x + ox + 3, y + 6, z + oz + 3, pris, water);
    writer.set(x + ox, y + 5, z + oz, lantern);
    writer.clear(x + ox, y + 2, z + oz - 3, x + ox, y + 3, z + oz - 3);
  }
  for (let i = -r + 2; i <= r - 2; i += 4) {
    writer.fill(x + i, y + 1, z - r + 1, x + i, y + 7, z - r + 1, pris);
    writer.fill(x + i, y + 1, z + r - 1, x + i, y + 7, z + r - 1, pris);
  }
  // The treasure: eight gold blocks in the top chamber.
  for (let dz = -1; dz <= 0; dz++) {
    for (let dx = -1; dx <= 0; dx++) {
      writer.set(x + dx, y + 15, z + dz, gold);
      writer.set(x + dx, y + 16, z + dz, gold);
    }
  }
  for (let i = 0; i < 24; i++) {
    writer.set(x + rng.intRange(-r + 1, r - 1), y + rng.intRange(1, 7),
      z + rng.intRange(-r + 1, r - 1), rng.chance(0.2) ? lantern : water);
  }
  if (writer.inside(x, z)) {
    spawnMob(world, 'elder_guardian', x, y + 16, z);
    for (let i = 0; i < 6; i++) {
      spawnMob(world, 'guardian', x + rng.intRange(-10, 10), y + rng.intRange(2, 10),
        z + rng.intRange(-10, 10));
    }
  }
}

// -- strongholds -------------------------------------------------------------

const strongholdCache = new Map();

/** Three strongholds in a ring around the origin, from the world seed alone. */
export function strongholdSites(seed) {
  let sites = strongholdCache.get(seed);
  if (sites) return sites;
  const rng = new Random(seed ^ 0x5748ea41);
  sites = [];
  let angle = rng.next() * Math.PI * 2;
  for (let i = 0; i < 3; i++) {
    const dist = 1120 + rng.int(880);
    const bx = Math.round(Math.cos(angle) * dist);
    const bz = Math.round(Math.sin(angle) * dist);
    sites.push({ cx: bx >> 4, cz: bz >> 4 });
    angle += (Math.PI * 2) / 3 + (rng.next() - 0.5) * 0.5;
  }
  strongholdCache.set(seed, sites);
  return sites;
}

const SH_CORRIDOR = { w: 5, h: 5, d: 9 };

function strongholdLayout(world, generator, seed, site) {
  const key = `sh:${seed}:${site.cx},${site.cz}`;
  return cachedLayout(world, key, () => {
    const x = site.cx * 16 + 8, z = site.cz * 16 + 8;
    const surface = anchorHeight(world, generator, x, z);
    if (surface === null) return null;
    const rng = new Random(hash3(seed ^ 0x5748, site.cx, 0, site.cz) | 0);
    const y = Math.max(MIN_Y + 8, Math.min(surface - 26, rng.intRange(-40, 16)));
    const pieces = [];
    const open = [{ x, y, z, dir: rng.int(4) }];
    let portalPlaced = false;
    let libraryPlaced = false;
    let x0 = x, z0 = z, x1 = x, z1 = z;
    let guard = 0;

    const fits = (b) => {
      for (const p of pieces) {
        if (b.x0 <= p.x1 && b.x1 >= p.x0 && b.z0 <= p.z1 && b.z1 >= p.z0 &&
          b.y0 <= p.y1 && b.y1 >= p.y0) return false;
      }
      return true;
    };

    while (open.length && pieces.length < 22 && guard++ < 160) {
      const node = open.shift();
      let kind = rng.pick(['corridor', 'corridor', 'crossing', 'room', 'stairs']);
      if (!libraryPlaced && pieces.length >= 5 && rng.chance(0.5)) kind = 'library';
      if (!portalPlaced && pieces.length >= 8 && rng.chance(0.45)) kind = 'portal';
      const size = kind === 'library' ? { w: 13, h: 10, d: 13 }
        : kind === 'portal' ? { w: 11, h: 8, d: 11 }
          : kind === 'room' ? { w: 9, h: 6, d: 9 }
            : kind === 'crossing' ? { w: 7, h: 6, d: 7 }
              : SH_CORRIDOR;
      const dx = FDX[node.dir], dz = FDZ[node.dir];
      const cx = node.x + dx * Math.ceil(size.d / 2);
      const cz = node.z + dz * Math.ceil(size.d / 2);
      const cy = kind === 'stairs' ? node.y - 4 : node.y;
      const b = {
        kind, x: cx, y: cy, z: cz, dir: node.dir, size,
        x0: cx - (size.w >> 1) - 1, x1: cx + (size.w >> 1) + 1,
        z0: cz - (size.d >> 1) - 1, z1: cz + (size.d >> 1) + 1,
        y0: cy - 1, y1: cy + size.h + 1,
      };
      if (!fits(b)) continue;
      pieces.push(b);
      if (kind === 'library') libraryPlaced = true;
      if (kind === 'portal') { portalPlaced = true; continue; }
      x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1);
      z0 = Math.min(z0, b.z0); z1 = Math.max(z1, b.z1);
      const exits = kind === 'crossing' ? 3 : kind === 'corridor' ? 1 : 2;
      for (let i = 0; i < exits; i++) {
        const nd = i === 0 ? node.dir : (node.dir + (rng.chance(0.5) ? 1 : 3)) & 3;
        open.push({
          x: cx + FDX[nd] * ((size.d >> 1) + 1), y: cy,
          z: cz + FDZ[nd] * ((size.d >> 1) + 1), dir: nd,
        });
      }
    }
    // Exactly one portal room: force it onto the last piece if none was chosen.
    if (!portalPlaced && pieces.length) {
      const last = pieces[pieces.length - 1];
      last.kind = 'portal';
      last.size = { w: 11, h: 8, d: 11 };
    }
    if (!pieces.length) return null;
    return { type: 'stronghold', x, y, z, pieces, x0: x0 - 2, z0: z0 - 2, x1: x1 + 2, z1: z1 + 2 };
  });
}

function buildStronghold(world, writer, layout, rng) {
  const brick = B('stone_bricks');
  const mossy = B('mossy_stone_bricks');
  const cracked = B('cracked_stone_bricks');
  const stoneMix = (px, py, pz, r) => writer.set(px, py, pz,
    r.chance(0.2) ? mossy : r.chance(0.15) ? cracked : brick);

  for (const p of layout.pieces) {
    if (!writer.hits(p.x0, p.z0, p.x1, p.z1)) continue;
    const pRng = new Random(hash3(world.seed ^ 0x5348, p.x, p.y, p.z) | 0);
    const hw = p.size.w >> 1, hd = p.size.d >> 1;
    const x0 = p.x - hw, x1 = p.x + hw, z0 = p.z - hd, z1 = p.z + hd;
    const y0 = p.y, y1 = p.y + p.size.h;

    for (let y = y0 - 1; y <= y1; y++) {
      for (let z = z0 - 1; z <= z1 + 1; z++) {
        for (let x = x0 - 1; x <= x1 + 1; x++) {
          const shell = x < x0 || x > x1 || z < z0 || z > z1 || y === y0 - 1 || y === y1;
          if (shell) stoneMix(x, y, z, pRng);
          else writer.set(x, y, z, 0);
        }
      }
    }
    // Doorways on every side so the pieces connect.
    for (let d = 0; d < 4; d++) {
      const dx = FDX[d], dz = FDZ[d];
      const ax = p.x + dx * (hw + 1), az = p.z + dz * (hd + 1);
      writer.clear(ax, y0, az, ax, y0 + 2, az);
      writer.clear(ax + (dz ? 1 : 0), y0, az + (dx ? 1 : 0),
        ax + (dz ? 1 : 0), y0 + 2, az + (dx ? 1 : 0));
    }

    if (p.kind === 'stairs') {
      for (let i = 0; i < 5; i++) {
        writer.set(p.x, y0 + i, z0 + i, stairs('stone_brick_stairs', 'south'));
        writer.clear(p.x, y0 + i + 1, z0 + i, p.x, y0 + i + 3, z0 + i);
      }
    } else if (p.kind === 'library') {
      buildStrongholdLibrary(writer, p, x0, y0, z0, x1, y1, z1, pRng);
    } else if (p.kind === 'portal') {
      buildPortalRoom(writer, p, pRng);
    } else if (p.kind === 'crossing') {
      chest(writer, x0 + 1, y0, z0 + 1, 'east', 'stronghold_crossing', pRng);
      writer.set(p.x, y0 + p.size.h - 1, p.z, B('torch'));
    } else if (p.kind === 'room' && pRng.chance(0.5)) {
      chest(writer, p.x, y0, z0 + 1, 'south', 'stronghold_corridor', pRng);
      writer.set(x1 - 1, y0, z1 - 1, B('crafting_table'));
    }
    if (pRng.chance(0.4)) {
      writer.set(p.x + pRng.intRange(-hw + 1, hw - 1), y0 + 1,
        p.z + pRng.intRange(-hd + 1, hd - 1), B('cobweb'));
    }
    if (pRng.chance(0.25)) {
      spawner(writer, p.x + pRng.intRange(-1, 1), y0, p.z + pRng.intRange(-1, 1), 'silverfish');
    }
  }
  void rng;
}

function buildStrongholdLibrary(writer, p, x0, y0, z0, x1, y1, z1, rng) {
  const shelf = B('bookshelf');
  const plank = B('oak_planks');
  const fence = B('oak_fence');
  const mid = Math.floor((y0 + y1) / 2);
  // A mezzanine floor with a fence railing.
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const edge = x <= x0 + 1 || x >= x1 - 1 || z <= z0 + 1 || z >= z1 - 1;
      if (edge) writer.set(x, mid, z, plank);
      if (x === x0 + 2 || x === x1 - 2 || z === z0 + 2 || z === z1 - 2) {
        writer.set(x, mid + 1, z, fence);
      }
    }
  }
  for (let y of [y0, mid + 1]) {
    for (let z = z0 + 1; z <= z1 - 1; z += 3) {
      for (let x = x0 + 1; x <= x1 - 1; x++) {
        if (x === p.x) continue;
        writer.set(x, y, z, shelf);
        writer.set(x, y + 1, z, shelf);
      }
    }
  }
  for (let i = 0; i < 14; i++) {
    writer.set(x0 + 1 + rng.int(x1 - x0 - 1), y0 + rng.int(3),
      z0 + 1 + rng.int(z1 - z0 - 1), B('cobweb'));
  }
  writer.set(p.x, mid + 1, p.z, B('torch'));
  chest(writer, x1 - 1, y0, p.z, 'west', 'stronghold_library', rng);
  chest(writer, x0 + 1, mid + 1, p.z, 'east', 'stronghold_library', rng);
  // Ladder between the two floors.
  for (let y = y0; y <= mid; y++) {
    writer.set(x0 + 1, y, z0 + 1, S('ladder', { facing: 'south', waterlogged: false }));
  }
  writer.set(x0 + 1, mid, z0 + 1, 0);
}

/** The portal room: a 12-frame End portal over a lava pit, plus a spawner. */
function buildPortalRoom(writer, p, rng) {
  const brick = B('stone_bricks');
  const y0 = p.y;
  const cx = p.x, cz = p.z;

  // Lava pit under the portal.
  writer.fill(cx - 3, y0 - 3, cz - 3, cx + 3, y0 - 1, cz + 3, B('lava'));
  writer.fill(cx - 4, y0 - 4, cz - 4, cx + 4, y0 - 4, cz + 4, brick);
  // The raised platform holding the frame.
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
      writer.set(cx + dx, y0, cz + dz, edge ? brick : 0);
    }
  }
  // Twelve frames around a 3x3 interior; each has a chance of holding an eye.
  const frames = [];
  for (let i = -1; i <= 1; i++) {
    frames.push([i, -2, 'south'], [i, 2, 'north'], [-2, i, 'east'], [2, i, 'west']);
  }
  for (const [dx, dz, facing] of frames) {
    writer.set(cx + dx, y0 + 1, cz + dz,
      S('end_portal_frame', { eye: rng.chance(0.1), facing }));
  }
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) writer.set(cx + dx, y0 + 1, cz + dz, 0);
  }
  // Stairs down into the pit chamber and a silverfish spawner watching it.
  for (let i = 0; i < 3; i++) {
    writer.set(cx - 3 - i, y0 + 1 + i, cz, stairs('stone_brick_stairs', 'east'));
  }
  spawner(writer, cx + 4, y0 + 1, cz, 'silverfish');
  writer.set(cx, y0 + p.size.h - 1, cz, B('torch'));
}

// -- nether ------------------------------------------------------------------

function buildNetherFortress(world, writer, layout, rng) {
  const brick = B('nether_bricks');
  const fence = B('nether_brick_fence');
  const stair = 'nether_brick_stairs';
  const x = layout.x, z = layout.z, y = layout.y;

  // Central hall.
  writer.hollow(x - 5, y, z - 5, x + 5, y + 6, z + 5, brick, 0);
  writer.fill(x - 4, y, z - 4, x + 4, y, z + 4, brick);

  for (const arm of layout.arms) {
    const dx = FDX[arm.dir], dz = FDZ[arm.dir];
    for (let i = 4; i <= arm.len; i++) {
      const px = x + dx * i, pz = z + dz * i;
      const across = dx !== 0 ? [0, 1] : [1, 0];
      if (!writer.hits(px - 3, pz - 3, px + 3, pz + 3)) continue;
      // Bridge deck, five wide, with railings.
      for (let a = -2; a <= 2; a++) {
        const ax = px + across[0] * a, az = pz + across[1] * a;
        writer.set(ax, y, az, brick);
        writer.clear(ax, y + 1, az, ax, y + 4, az);
        if (Math.abs(a) === 2) {
          writer.set(ax, y + 1, az, fence);
          if (i % 4 === 0) {
            writer.fill(ax, y + 1, az, ax, y + 4, az, brick);
            writer.set(ax, y + 5, az, brick);
          }
        }
      }
      if (i % 4 === 0) {
        for (let a = -2; a <= 2; a++) {
          const ax = px + across[0] * a, az = pz + across[1] * a;
          writer.set(ax, y + 5, az, brick);
        }
      }
      // Support columns dropping toward the lava sea.
      if (i % 6 === 0) {
        for (const a of [-2, 2]) {
          const ax = px + across[0] * a, az = pz + across[1] * a;
          for (let yy = y - 1; yy > y - 22; yy--) {
            const cur = world.getBlock(ax, yy, az);
            writer.set(ax, yy, az, brick);
            if (cur !== 0 && T.solid[cur]) break;
          }
        }
      }
    }
    // Each arm ends in a room.
    const ex = x + dx * arm.len, ez = z + dz * arm.len;
    if (!writer.hits(ex - 6, ez - 6, ex + 6, ez + 6)) continue;
    const kind = rng.int(3);
    if (kind === 0) {
      // Blaze spawner platform.
      writer.hollow(ex - 4, y, ez - 4, ex + 4, y + 6, ez + 4, brick, 0);
      writer.fill(ex - 3, y, ez - 3, ex + 3, y, ez + 3, brick);
      for (let i = 0; i < 3; i++) {
        writer.fill(ex - 2 + i, y + 1, ez - 2 + i, ex + 2 - i, y + 1 + i, ez + 2 - i, brick);
      }
      spawner(writer, ex, y + 4, ez, 'blaze');
      for (let i = 0; i < 4; i++) {
        writer.set(ex + rng.intRange(-3, 3), y + 1, ez + rng.intRange(-3, 3), fence);
      }
    } else if (kind === 1) {
      // Nether wart garden.
      writer.hollow(ex - 4, y, ez - 4, ex + 4, y + 5, ez + 4, brick, 0);
      const soul = B('soul_sand');
      for (let dz2 = -2; dz2 <= 2; dz2++) {
        for (let dx2 = -2; dx2 <= 2; dx2++) {
          writer.set(ex + dx2, y, ez + dz2, soul);
          writer.set(ex + dx2, y + 1, ez + dz2, S('nether_wart', { age: rng.int(4) }));
        }
      }
      for (let dx2 = -3; dx2 <= 3; dx2++) {
        writer.set(ex + dx2, y + 1, ez - 3, stairs(stair, 'south'));
        writer.set(ex + dx2, y + 1, ez + 3, stairs(stair, 'north'));
      }
      chest(writer, ex + 3, y + 1, ez, 'west', 'nether_fortress', rng);
    } else {
      // A treasure corner with a chest and a lava trickle.
      writer.hollow(ex - 3, y, ez - 3, ex + 3, y + 5, ez + 3, brick, 0);
      chest(writer, ex, y + 1, ez, FACINGS[rng.int(4)], 'nether_fortress', rng);
      writer.set(ex + 2, y + 4, ez + 2, B('lava'));
    }
    if (writer.inside(ex, ez)) {
      for (let i = 0; i < 2; i++) {
        spawnMob(world, 'wither_skeleton', ex + rng.intRange(-2, 2), y + 1,
          ez + rng.intRange(-2, 2));
      }
    }
  }
}

function buildBastion(world, writer, layout, rng) {
  const x = layout.x, z = layout.z, y = layout.y;
  const black = B('blackstone');
  const polished = B('polished_blackstone');
  const pbrick = B('polished_blackstone_bricks');
  const cracked = B('cracked_polished_blackstone_bricks');
  const gilded = B('gilded_blackstone');
  const basalt = S('basalt', { axis: 'y' });
  const mix = (px, py, pz) => writer.set(px, py, pz,
    rng.chance(0.08) ? gilded : rng.chance(0.2) ? cracked : pbrick);

  // A blocky fortress on a blackstone plinth.
  for (let dz = -12; dz <= 12; dz++) {
    for (let dx = -12; dx <= 12; dx++) {
      if (Math.abs(dx) > 11 && Math.abs(dz) > 11) continue;
      for (let dy = -4; dy <= 0; dy++) writer.set(x + dx, y + dy, z + dz, black);
    }
  }
  for (let dz = -12; dz <= 12; dz++) {
    for (let dx = -12; dx <= 12; dx++) {
      const edge = Math.abs(dx) === 12 || Math.abs(dz) === 12;
      if (!edge) continue;
      for (let dy = 1; dy <= 7; dy++) mix(x + dx, y + dy, z + dz);
    }
  }
  // Inner keep.
  writer.hollow(x - 6, y + 1, z - 6, x + 6, y + 10, z + 6, pbrick, 0);
  writer.fill(x - 5, y + 5, z - 5, x + 5, y + 5, z + 5, polished);
  for (const [dx, dz] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) {
    writer.fill(x + dx, y + 1, z + dz, x + dx, y + 14, z + dz, basalt);
  }
  writer.clear(x, y + 1, z - 6, x, y + 3, z - 6);
  // Lava moat below the plinth.
  for (let dz = -14; dz <= 14; dz++) {
    for (let dx = -14; dx <= 14; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== 14) continue;
      writer.set(x + dx, y - 5, z + dz, B('lava'));
    }
  }
  for (let i = 0; i < 3; i++) {
    chest(writer, x + rng.intRange(-4, 4), y + 6, z + rng.intRange(-4, 4),
      FACINGS[rng.int(4)], 'bastion', rng);
  }
  for (let i = 0; i < 20; i++) {
    writer.soft(x + rng.intRange(-11, 11), y + 1 + rng.int(6),
      z + rng.intRange(-11, 11), B('magma_block'));
  }
  if (writer.inside(x, z)) {
    for (let i = 0; i < 4; i++) {
      spawnMob(world, 'piglin', x + rng.intRange(-5, 5), y + 6, z + rng.intRange(-5, 5));
    }
    spawnMob(world, 'piglin_brute', x, y + 6, z);
  }
}

function buildBasaltPillars(world, writer, layout, rng) {
  const basalt = S('basalt', { axis: 'y' });
  const magma = B('magma_block');
  const count = rng.intRange(2, 6);
  for (let i = 0; i < count; i++) {
    const px = layout.x + rng.intRange(-7, 7), pz = layout.z + rng.intRange(-7, 7);
    if (!writer.inside(px, pz)) continue;
    const g = groundY(world, px, pz);
    if (g < MIN_Y) continue;
    const h = rng.intRange(3, 14);
    const r = rng.int(2);
    for (let dy = 1; dy <= h; dy++) {
      const rr = dy > h - 3 ? 0 : r;
      for (let dz = -rr; dz <= rr; dz++) {
        for (let dx = -rr; dx <= rr; dx++) writer.soft(px + dx, g + dy, pz + dz, basalt);
      }
    }
    if (rng.chance(0.3)) writer.set(px, g, pz, magma);
  }
}

// -- end ---------------------------------------------------------------------

function buildEndCity(world, writer, layout, rng) {
  const purpur = B('purpur_block');
  const pillar = S('purpur_pillar', { axis: 'y' });
  const endBrick = B('end_stone_bricks');
  const rod = S('end_rod', { facing: 'up' });
  const x = layout.x, z = layout.z, y = layout.y;

  const levels = rng.intRange(2, 4);
  for (let level = 0; level < levels; level++) {
    const by = y + level * 5;
    const r = 4 - Math.floor(level / 2);
    writer.hollow(x - r, by, z - r, x + r, by + 4, z + r, purpur, 0);
    writer.fill(x - r + 1, by, z - r + 1, x + r - 1, by, z + r - 1, endBrick);
    for (const [dx, dz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) {
      writer.fill(x + dx, by, z + dz, x + dx, by + 4, z + dz, pillar);
    }
    writer.clear(x, by + 1, z - r, x, by + 2, z - r);
    writer.set(x + r - 1, by + 1, z + r - 1, rod);
    if (level === levels - 1) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) writer.set(x + dx, by + 5, z + dz, purpur);
      }
      chest(writer, x, by + 1, z, FACINGS[rng.int(4)], 'end_city', rng);
      if (writer.inside(x, z)) spawnMob(world, 'shulker', x + r - 1, by + 1, z);
    }
  }
  // The tower stands on a plinth reaching the island surface.
  for (let dz = -5; dz <= 5; dz++) {
    for (let dx = -5; dx <= 5; dx++) {
      if (!writer.inside(x + dx, z + dz)) continue;
      const g = groundY(world, x + dx, z + dz);
      for (let py = Math.max(MIN_Y + 1, g + 1); py < y; py++) {
        writer.set(x + dx, py, z + dz, endBrick);
      }
    }
  }
}

/** The obsidian pillars and exit portal at the centre of the End. */
function buildEndArena(world, writer, seed) {
  const obsidian = B('obsidian');
  const bedrock = B('bedrock');
  const endStone = B('end_stone');
  const rng = new Random(seed ^ 0x454e4421);

  // The flat central island.
  for (let dz = -40; dz <= 40; dz++) {
    for (let dx = -40; dx <= 40; dx++) {
      if (dx * dx + dz * dz > 40 * 40) continue;
      if (!writer.inside(dx, dz)) continue;
      for (let y = 40; y <= 48; y++) writer.set(dx, y, dz, endStone);
      writer.clear(dx, 49, dz, dx, 90, dz);
    }
  }

  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = 43;
    const px = Math.round(Math.cos(a) * r), pz = Math.round(Math.sin(a) * r);
    const height = 76 + rng.int(20);
    const rad = 2 + (i % 4);
    if (!writer.hits(px - rad - 1, pz - rad - 1, px + rad + 1, pz + rad + 1)) continue;
    for (let dz = -rad; dz <= rad; dz++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (dx * dx + dz * dz > rad * rad) continue;
        for (let y = 48; y <= height; y++) writer.set(px + dx, y, pz + dz, obsidian);
      }
    }
    // The bedrock cap with its crystal cage.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) writer.set(px + dx, height + 1, pz + dz, bedrock);
    }
    if (writer.inside(px, pz)) spawnMob(world, 'ender_crystal', px, height + 2, pz);
  }

  // The exit portal plinth.
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
      writer.set(dx, 49, dz, bedrock);
      writer.set(dx, 50, dz, dx === 0 && dz === 0 ? B('end_portal') : 0);
    }
  }
  for (const [dx, dz] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
    writer.fill(dx, 50, dz, dx, 52, dz, bedrock);
    writer.set(dx, 53, dz, B('torch'));
  }
  writer.set(0, 51, 0, B('dragon_egg'));
  if (writer.inside(0, 0)) spawnMob(world, 'ender_dragon', 0, 80, 0);
}

export default { placeStructures, generateLoot };
