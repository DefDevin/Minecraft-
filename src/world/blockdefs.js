// The canonical block registry.
//
// Every other system in the game refers to blocks by their Minecraft id
// ("grass_block", "polished_andesite_slab", "redstone_wire"), so this module is
// the contract they all depend on. Call `registerAllBlocks()` exactly once,
// before anything touches the block tables.
//
// Registration order matters in one place only: `air` is defined first so its
// default state id is 0, which the chunk storage, mesher and lighting all rely
// on ("state === 0" means empty).
//
// The per-category modules live in ./blockdefs/ and share the factories in
// ./blockdefs/helpers.js. Behaviour that is purely a property of a block —
// which surfaces a flower survives on, how stairs corner, what an ore drops —
// lives with the definition. Behaviour that needs a system we have not built
// yet (redstone signal propagation, container UIs, tree shapes) is dispatched
// through optional hooks on `world.game`, guarded with `?.`, so the registry
// works standalone and lights up as the rest of the game lands.

import { blocks, blocksByName, freezeBlocks, getBlock, T } from './blocks.js';
import { statesUsed } from './blockstate.js';
import { applyStateLight } from './blockdefs/helpers.js';
import { registerTerrain } from './blockdefs/terrain.js';
import { registerWood } from './blockdefs/wood.js';
import { registerBuilding } from './blockdefs/building.js';
import { registerColored } from './blockdefs/colored.js';
import { registerPlants } from './blockdefs/plants.js';
import { registerRedstone } from './blockdefs/redstone.js';
import { registerUtility } from './blockdefs/utility.js';
import {
  COLORS, COLOR_HEX, COLOR_MAP, TERRACOTTA_MAP, WOOD_TYPES, WOOD_NAMES,
  OVERWORLD_WOODS, STONE_FAMILIES, COPPER_STAGES, COPPER_FORMS, FLAMMABLE,
  POTTED, STRIPPED, WEATHERING, PLANTABLE, NYLIUM_LIKE, SUGAR_CANE_BASE,
  MAP, XP, DIRS, FACING_INDEX, FACING6, AXES,
} from './blockdefs/data.js';

export {
  COLORS, COLOR_HEX, COLOR_MAP, TERRACOTTA_MAP, WOOD_TYPES, WOOD_NAMES,
  OVERWORLD_WOODS, STONE_FAMILIES, COPPER_STAGES, COPPER_FORMS, FLAMMABLE,
  POTTED, STRIPPED, WEATHERING, PLANTABLE, NYLIUM_LIKE, SUGAR_CANE_BASE,
  MAP as MAP_COLORS, XP as EXTRA_PROPERTIES, DIRS, FACING_INDEX, FACING6, AXES,
};

/** Frozen array of every registered block name, in registration order. */
export let BLOCK_NAMES = Object.freeze([]);

/** Blocks grouped by creative tab, filled by registerAllBlocks(). */
export const CREATIVE_TABS = {};

let registered = false;

/**
 * Register every block, then build the flat lookup tables.
 * Idempotent: calling twice is a no-op rather than an error.
 */
export function registerAllBlocks() {
  if (registered) return BLOCK_NAMES;
  registered = true;

  registerTerrain();     // air first — its default state id must be 0
  registerWood();
  registerBuilding();
  registerColored();
  registerPlants();
  registerRedstone();
  registerUtility();

  const tables = freezeBlocks();
  // Light emission is stored per block, but candles, lit furnaces and glow
  // berries vary it per state; patch those entries now the table exists.
  applyStateLight(tables);

  buildDerivedTables();

  BLOCK_NAMES = Object.freeze(blocks.map((b) => b.name));
  return BLOCK_NAMES;
}

/** Data tables other systems read that are easier to derive than to write. */
function buildDerivedTables() {
  for (const b of blocks) {
    if (b.flammable > 0 || b.burnTime > 0) {
      FLAMMABLE[b.name] = { encouragement: b.burnTime, flammability: b.flammable };
    }
    const tab = b.creativeTab;
    if (!tab) continue;
    (CREATIVE_TABS[tab] || (CREATIVE_TABS[tab] = [])).push(b.name);
  }
  Object.freeze(FLAMMABLE);
  Object.freeze(POTTED);
  Object.freeze(STRIPPED);
  Object.freeze(WEATHERING);
  for (const k of Object.keys(CREATIVE_TABS)) Object.freeze(CREATIVE_TABS[k]);
  Object.freeze(CREATIVE_TABS);
}

/** Number of registered blocks (0 until registerAllBlocks runs). */
export const blockCount = () => blocks.length;
/** Number of allocated block states. */
export const stateCount = () => statesUsed();

/**
 * Every texture name referenced by any block model or `textures` spec.
 * The procedural texture generator uses this as its work list, so a missing
 * painter shows up as a named gap rather than a blank tile.
 */
export function blockTextureNames() {
  const names = new Set();
  const add = (t) => {
    if (typeof t === 'string') names.add(t);
    else if (Array.isArray(t)) t.forEach(add);
    else if (t && typeof t === 'object') Object.values(t).forEach(add);
  };
  for (const b of blocks) {
    for (let i = 0; i < b.stateCount; i++) {
      const s = b.base + i;
      const spec = typeof b.textures === 'function' ? b.textures(s) : b.textures;
      if (spec) add(spec);
      const model = b.modelFor(s);
      if (!model) continue;
      for (const bx of model) {
        for (const face of bx.faces) if (face && face.texture) names.add(face.texture);
      }
    }
  }
  return Object.freeze([...names].sort());
}

export { blocks, blocksByName, getBlock, T };
