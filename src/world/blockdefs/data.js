// Pure data tables shared by the block registration modules.
//
// Nothing here registers a block. Keeping the colour lists, wood species, stone
// families and the extra state properties in one place means world generation,
// recipes, the creative menu and the texture painter can all import the same
// tables instead of re-deriving them by parsing block names.

import { Property } from '../blockstate.js';

// ---------------------------------------------------------------------------
// Extra state properties
//
// blockstate.js predeclares the common ones; these are the stragglers. They are
// shared objects for the same reason PROP's are: two blocks with "the same"
// property must point at the identical Property instance so property lookups
// stay a pointer comparison.
// ---------------------------------------------------------------------------

function ints(name, min, max) {
  const v = [];
  for (let i = min; i <= max; i++) v.push(i);
  return new Property(name, v);
}
const flag = (name) => new Property(name, [false, true]);

export const XP = {
  age1: ints('age', 0, 1),          // bamboo
  age2: ints('age', 0, 2),          // cocoa, torchflower crop
  age4: ints('age', 0, 4),          // pitcher crop
  age5: ints('age', 0, 5),          // chorus flower
  level3: ints('level', 1, 3),      // cauldron contents
  level15: ints('level', 0, 15),    // light block
  distance0: ints('distance', 0, 7),// scaffolding
  inverted: flag('inverted'),       // daylight detector
  enabled: flag('enabled'),         // hopper
  signalFire: flag('signal_fire'),  // campfire under hay
  bloom: flag('bloom'),             // sculk catalyst
  shrieking: flag('shrieking'),
  canSummon: flag('can_summon'),
  cracked: flag('cracked'),         // turtle egg
  eye: flag('eye'),                 // end portal frame
  bellAttach: new Property('attachment',
    ['floor', 'ceiling', 'single_wall', 'double_wall']),
  slot0: flag('slot_0_occupied'),
  slot1: flag('slot_1_occupied'),
  slot2: flag('slot_2_occupied'),
  slot3: flag('slot_3_occupied'),
  slot4: flag('slot_4_occupied'),
  slot5: flag('slot_5_occupied'),
};

// ---------------------------------------------------------------------------
// Map colours — Minecraft's fixed 64-entry base palette, by name.
// ---------------------------------------------------------------------------

export const MAP = Object.freeze({
  none: 0x000000, grass: 0x7fb238, sand: 0xf7e9a3, wool: 0xc7c7c7,
  fire: 0xff0000, ice: 0xa0a0ff, metal: 0xa7a7a7, plant: 0x007c00,
  snow: 0xffffff, clay: 0xa4a8b8, dirt: 0x976d4d, stone: 0x707070,
  water: 0x4040ff, wood: 0x8f7748, quartz: 0xfffcf5,
  orange: 0xd87f33, magenta: 0xb24cd8, lightBlue: 0x6699d8, yellow: 0xe5e533,
  lightGreen: 0x7fcc19, pink: 0xf27fa5, gray: 0x4c4c4c, lightGray: 0x999999,
  cyan: 0x4c7f99, purple: 0x7f3fb2, blue: 0x334cb2, brown: 0x664c33,
  green: 0x667f33, red: 0x993333, black: 0x191919,
  gold: 0xfaee4d, diamond: 0x5cdbd5, lapis: 0x4a80ff, emerald: 0x00d93a,
  podzol: 0x815631, netherrack: 0x700200,
  terracottaWhite: 0xd1b1a1, terracottaOrange: 0x9f5224,
  terracottaMagenta: 0x95576c, terracottaLightBlue: 0x706c8a,
  terracottaYellow: 0xba8524, terracottaLightGreen: 0x677535,
  terracottaPink: 0xa04d4e, terracottaGray: 0x392923,
  terracottaLightGray: 0x876b62, terracottaCyan: 0x575c5c,
  terracottaPurple: 0x7a4958, terracottaBlue: 0x4c3e5c,
  terracottaBrown: 0x4c3223, terracottaGreen: 0x4c522a,
  terracottaRed: 0x8e3c2e, terracottaBlack: 0x251610,
  crimsonNylium: 0xbd3031, crimsonStem: 0x943f61, crimsonHyphae: 0x5c191d,
  warpedNylium: 0x167e86, warpedStem: 0x3a8e8c, warpedHyphae: 0x562c3e,
  warpedWartBlock: 0x14b485,
  deepslate: 0x646464, rawIron: 0xd8af93, glowLichen: 0x7fa796,
  sculk: 0x0d2f34, copper: 0xc07a55, copperExposed: 0x8f7a63,
  copperWeathered: 0x6a8a63, copperOxidized: 0x4b8b6a,
});

// ---------------------------------------------------------------------------
// The sixteen dye colours, in Minecraft's canonical order.
// ---------------------------------------------------------------------------

export const COLORS = Object.freeze([
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
]);

/** Approximate wool/dye RGB for each colour, used by the texture painter. */
export const COLOR_HEX = Object.freeze({
  white: 0xf9fffe, orange: 0xf9801d, magenta: 0xc74ebd, light_blue: 0x3ab3da,
  yellow: 0xfed83d, lime: 0x80c71f, pink: 0xf38baa, gray: 0x474f52,
  light_gray: 0x9d9d97, cyan: 0x169c9c, purple: 0x8932b8, blue: 0x3c44aa,
  brown: 0x835432, green: 0x5e7c16, red: 0xb02e26, black: 0x1d1d21,
});

/** Map colour used by wool / concrete / terracotta of each dye colour. */
export const COLOR_MAP = Object.freeze({
  white: MAP.snow, orange: MAP.orange, magenta: MAP.magenta,
  light_blue: MAP.lightBlue, yellow: MAP.yellow, lime: MAP.lightGreen,
  pink: MAP.pink, gray: MAP.gray, light_gray: MAP.lightGray, cyan: MAP.cyan,
  purple: MAP.purple, blue: MAP.blue, brown: MAP.brown, green: MAP.green,
  red: MAP.red, black: MAP.black,
});

export const TERRACOTTA_MAP = Object.freeze({
  white: MAP.terracottaWhite, orange: MAP.terracottaOrange,
  magenta: MAP.terracottaMagenta, light_blue: MAP.terracottaLightBlue,
  yellow: MAP.terracottaYellow, lime: MAP.terracottaLightGreen,
  pink: MAP.terracottaPink, gray: MAP.terracottaGray,
  light_gray: MAP.terracottaLightGray, cyan: MAP.terracottaCyan,
  purple: MAP.terracottaPurple, blue: MAP.terracottaBlue,
  brown: MAP.terracottaBrown, green: MAP.terracottaGreen,
  red: MAP.terracottaRed, black: MAP.terracottaBlack,
});

// ---------------------------------------------------------------------------
// Wood species
//
// `kind` splits the overworld trees (log / wood / leaves / sapling) from the
// nether fungi (stem / hyphae / nylium / fungus / roots). Everything else in
// the wood set is identical, which is why one factory can build both.
// ---------------------------------------------------------------------------

export const WOOD_TYPES = Object.freeze([
  {
    name: 'oak', kind: 'wood', log: 'log', wood: 'wood',
    plankMap: MAP.wood, barkMap: MAP.wood, leafMap: MAP.plant,
    sapling: 'oak_sapling', flammable: true, sound: 'wood',
  },
  {
    name: 'spruce', kind: 'wood', log: 'log', wood: 'wood',
    plankMap: MAP.podzol, barkMap: MAP.brown, leafMap: MAP.plant,
    sapling: 'spruce_sapling', flammable: true, sound: 'wood',
  },
  {
    name: 'birch', kind: 'wood', log: 'log', wood: 'wood',
    plankMap: MAP.sand, barkMap: MAP.quartz, leafMap: MAP.plant,
    sapling: 'birch_sapling', flammable: true, sound: 'wood',
  },
  {
    name: 'jungle', kind: 'wood', log: 'log', wood: 'wood',
    plankMap: MAP.dirt, barkMap: MAP.podzol, leafMap: MAP.plant,
    sapling: 'jungle_sapling', flammable: true, sound: 'wood',
  },
  {
    name: 'acacia', kind: 'wood', log: 'log', wood: 'wood',
    plankMap: MAP.orange, barkMap: MAP.stone, leafMap: MAP.plant,
    sapling: 'acacia_sapling', flammable: true, sound: 'wood',
  },
  {
    name: 'dark_oak', kind: 'wood', log: 'log', wood: 'wood',
    plankMap: MAP.brown, barkMap: MAP.brown, leafMap: MAP.plant,
    sapling: 'dark_oak_sapling', flammable: true, sound: 'wood',
  },
  {
    name: 'mangrove', kind: 'wood', log: 'log', wood: 'wood',
    plankMap: MAP.red, barkMap: MAP.podzol, leafMap: MAP.plant,
    sapling: 'mangrove_propagule', flammable: true, sound: 'wood',
  },
  {
    name: 'cherry', kind: 'wood', log: 'log', wood: 'wood',
    plankMap: MAP.terracottaWhite, barkMap: MAP.terracottaGray,
    leafMap: MAP.pink, sapling: 'cherry_sapling', flammable: true,
    sound: 'wood',
  },
  {
    name: 'crimson', kind: 'stem', log: 'stem', wood: 'hyphae',
    plankMap: MAP.crimsonStem, barkMap: MAP.crimsonHyphae, leafMap: MAP.none,
    sapling: 'crimson_fungus', flammable: false, sound: 'wood',
  },
  {
    name: 'warped', kind: 'stem', log: 'stem', wood: 'hyphae',
    plankMap: MAP.warpedStem, barkMap: MAP.warpedHyphae, leafMap: MAP.none,
    sapling: 'warped_fungus', flammable: false, sound: 'wood',
  },
]);

/** Just the species names, in registration order. */
export const WOOD_NAMES = Object.freeze(WOOD_TYPES.map((w) => w.name));

/** Species that grow leaves and saplings (i.e. not the nether fungi). */
export const OVERWORLD_WOODS = Object.freeze(
  WOOD_TYPES.filter((w) => w.kind === 'wood').map((w) => w.name));

// ---------------------------------------------------------------------------
// Stone families
//
// Each entry drives the stairs / slab / wall factory in building.js. `stairs`
// and `slab` name the derived block explicitly because Minecraft is not
// consistent: `stone_bricks` becomes `stone_brick_stairs`, singular.
// ---------------------------------------------------------------------------

export const STONE_FAMILIES = Object.freeze([
  { base: 'stone', stairs: 'stone_stairs', slab: 'stone_slab', wall: null },
  { base: 'cobblestone', stairs: 'cobblestone_stairs', slab: 'cobblestone_slab', wall: 'cobblestone_wall' },
  { base: 'mossy_cobblestone', stairs: 'mossy_cobblestone_stairs', slab: 'mossy_cobblestone_slab', wall: 'mossy_cobblestone_wall' },
  { base: 'smooth_stone', stairs: null, slab: 'smooth_stone_slab', wall: null },
  { base: 'stone_bricks', stairs: 'stone_brick_stairs', slab: 'stone_brick_slab', wall: 'stone_brick_wall' },
  { base: 'mossy_stone_bricks', stairs: 'mossy_stone_brick_stairs', slab: 'mossy_stone_brick_slab', wall: 'mossy_stone_brick_wall' },
  { base: 'granite', stairs: 'granite_stairs', slab: 'granite_slab', wall: 'granite_wall' },
  { base: 'polished_granite', stairs: 'polished_granite_stairs', slab: 'polished_granite_slab', wall: null },
  { base: 'diorite', stairs: 'diorite_stairs', slab: 'diorite_slab', wall: 'diorite_wall' },
  { base: 'polished_diorite', stairs: 'polished_diorite_stairs', slab: 'polished_diorite_slab', wall: null },
  { base: 'andesite', stairs: 'andesite_stairs', slab: 'andesite_slab', wall: 'andesite_wall' },
  { base: 'polished_andesite', stairs: 'polished_andesite_stairs', slab: 'polished_andesite_slab', wall: null },
  { base: 'cobbled_deepslate', stairs: 'cobbled_deepslate_stairs', slab: 'cobbled_deepslate_slab', wall: 'cobbled_deepslate_wall' },
  { base: 'polished_deepslate', stairs: 'polished_deepslate_stairs', slab: 'polished_deepslate_slab', wall: 'polished_deepslate_wall' },
  { base: 'deepslate_bricks', stairs: 'deepslate_brick_stairs', slab: 'deepslate_brick_slab', wall: 'deepslate_brick_wall' },
  { base: 'deepslate_tiles', stairs: 'deepslate_tile_stairs', slab: 'deepslate_tile_slab', wall: 'deepslate_tile_wall' },
  { base: 'tuff', stairs: 'tuff_stairs', slab: 'tuff_slab', wall: 'tuff_wall' },
  { base: 'polished_tuff', stairs: 'polished_tuff_stairs', slab: 'polished_tuff_slab', wall: 'polished_tuff_wall' },
  { base: 'tuff_bricks', stairs: 'tuff_brick_stairs', slab: 'tuff_brick_slab', wall: 'tuff_brick_wall' },
  { base: 'bricks', stairs: 'brick_stairs', slab: 'brick_slab', wall: 'brick_wall' },
  { base: 'mud_bricks', stairs: 'mud_brick_stairs', slab: 'mud_brick_slab', wall: 'mud_brick_wall' },
  { base: 'sandstone', stairs: 'sandstone_stairs', slab: 'sandstone_slab', wall: 'sandstone_wall' },
  { base: 'smooth_sandstone', stairs: 'smooth_sandstone_stairs', slab: 'smooth_sandstone_slab', wall: null },
  { base: 'red_sandstone', stairs: 'red_sandstone_stairs', slab: 'red_sandstone_slab', wall: 'red_sandstone_wall' },
  { base: 'smooth_red_sandstone', stairs: 'smooth_red_sandstone_stairs', slab: 'smooth_red_sandstone_slab', wall: null },
  { base: 'prismarine', stairs: 'prismarine_stairs', slab: 'prismarine_slab', wall: 'prismarine_wall' },
  { base: 'prismarine_bricks', stairs: 'prismarine_brick_stairs', slab: 'prismarine_brick_slab', wall: null },
  { base: 'dark_prismarine', stairs: 'dark_prismarine_stairs', slab: 'dark_prismarine_slab', wall: null },
  { base: 'nether_bricks', stairs: 'nether_brick_stairs', slab: 'nether_brick_slab', wall: 'nether_brick_wall' },
  { base: 'red_nether_bricks', stairs: 'red_nether_brick_stairs', slab: 'red_nether_brick_slab', wall: 'red_nether_brick_wall' },
  { base: 'quartz_block', stairs: 'quartz_stairs', slab: 'quartz_slab', wall: null },
  { base: 'smooth_quartz', stairs: 'smooth_quartz_stairs', slab: 'smooth_quartz_slab', wall: null },
  { base: 'purpur_block', stairs: 'purpur_stairs', slab: 'purpur_slab', wall: null },
  { base: 'end_stone_bricks', stairs: 'end_stone_brick_stairs', slab: 'end_stone_brick_slab', wall: 'end_stone_brick_wall' },
  { base: 'blackstone', stairs: 'blackstone_stairs', slab: 'blackstone_slab', wall: 'blackstone_wall' },
  { base: 'polished_blackstone', stairs: 'polished_blackstone_stairs', slab: 'polished_blackstone_slab', wall: 'polished_blackstone_wall' },
  { base: 'polished_blackstone_bricks', stairs: 'polished_blackstone_brick_stairs', slab: 'polished_blackstone_brick_slab', wall: 'polished_blackstone_brick_wall' },
  { base: 'cut_sandstone', stairs: null, slab: 'cut_sandstone_slab', wall: null },
  { base: 'cut_red_sandstone', stairs: null, slab: 'cut_red_sandstone_slab', wall: null },
]);

// ---------------------------------------------------------------------------
// Copper oxidation
// ---------------------------------------------------------------------------

/** Oxidation stages in order; '' is the fresh stage. */
export const COPPER_STAGES = Object.freeze(['', 'exposed_', 'weathered_', 'oxidized_']);

/**
 * Copper block families. Each entry is a suffix appended after the stage
 * prefix, e.g. stage 'exposed_' + form 'cut_copper' = 'exposed_cut_copper'.
 * `waxed_` is prepended for the waxed variants.
 */
export const COPPER_FORMS = Object.freeze([
  'copper_block', 'cut_copper', 'cut_copper_stairs', 'cut_copper_slab',
  'chiseled_copper', 'copper_grate', 'copper_bulb', 'copper_door',
  'copper_trapdoor',
]);

// ---------------------------------------------------------------------------
// Direction helpers
// ---------------------------------------------------------------------------

/** Horizontal property names in facing-index order (0 N, 1 E, 2 S, 3 W). */
export const DIRS = Object.freeze(['north', 'east', 'south', 'west']);
export const FACING_INDEX = Object.freeze({ north: 0, east: 1, south: 2, west: 3 });
/** All six facing names, matching PROP.facingAll's value order. */
export const FACING6 = Object.freeze(['north', 'east', 'south', 'west', 'up', 'down']);
export const AXES = Object.freeze(['y', 'x', 'z']);

// ---------------------------------------------------------------------------
// Block groups other systems need
// ---------------------------------------------------------------------------

/** Blocks a normal plant (flower, sapling, crop stem) can sit on. */
export const PLANTABLE = Object.freeze(new Set([
  'grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'farmland', 'moss_block', 'mud', 'muddy_mangrove_roots',
]));

/** Blocks the nether fungi and roots can sit on. */
export const NYLIUM_LIKE = Object.freeze(new Set([
  'crimson_nylium', 'warped_nylium', 'soul_soil', 'soul_sand', 'netherrack',
  'mycelium', 'grass_block', 'dirt', 'coarse_dirt', 'podzol', 'farmland',
  'moss_block',
]));

/** Blocks sugar cane accepts as a base (it also needs adjacent water). */
export const SUGAR_CANE_BASE = Object.freeze(new Set([
  'grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'sand',
  'red_sand', 'moss_block', 'mud',
]));

/** Filled by registerAllBlocks: block name -> {encouragement, flammability}. */
export const FLAMMABLE = {};

/** Filled by plants.js: plant block name -> potted block name. */
export const POTTED = {};

/** Filled by wood.js: log/wood block name -> stripped block name. */
export const STRIPPED = {};

/** Filled by building.js: copper block name -> weathering relations. */
export const WEATHERING = {};
