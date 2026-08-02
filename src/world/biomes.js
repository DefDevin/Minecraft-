// Biome registry and the multi-noise climate lookup.
//
// A biome is pure data: colours, surface materials, weather, spawn lists and a
// feature manifest. Nothing here touches the world — the terrain generator asks
// `selectBiome()` which biome belongs to a point in *climate space*, and the
// feature/decoration pass reads the manifest to know what to plant on top.
//
// Climate space has six axes, exactly as in Minecraft 1.18:
//
//   temperature      -1 frozen .. +1 scorching
//   humidity         -1 arid   .. +1 sodden
//   continentalness  -1.2 deep ocean .. +1 far inland
//   erosion          -1 mountainous .. +1 flat
//   weirdness        -1 .. +1, also the source of peaks-and-valleys
//   depth             0 at the surface .. ~1.2 deep underground
//
// Every biome claims one or more *boxes* in that space. Lookup is a nearest
// match: the squared distance to a box is zero inside it and grows outside, so
// there are no gaps and no ties, and adding a biome never leaves a hole in the
// world. That is what makes the parameter table easy to extend — you never have
// to make the ranges tile perfectly.
//
// Blocks are named rather than resolved to state ids at module load, because
// this module is imported before the block registry is guaranteed to be frozen.
// `resolveBiomeStates()` fills in the numeric `*State` fields once; the terrain
// generator calls it from its constructor.

import { clamp, lerp } from '../core/math.js';
import { blocksByName } from './blocks.js';

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

const mixHex = (a, b, t) => {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return ((ar + (br - ar) * t) & 255) << 16 |
    ((ag + (bg - ag) * t) & 255) << 8 |
    ((ab + (bb - ab) * t) & 255);
};

function hsvHex(h, s, v) {
  h = h - Math.floor(h);
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

/** Minecraft's sky hue: a blue that warms slightly as the biome heats up. */
export function skyColorFor(temperature) {
  return hsvHex(0.62222224 - clamp(temperature / 3, -1, 1) * 0.05, 0.5, 1.0);
}

/**
 * Stand-in for Minecraft's grass colormap. The image is a triangle indexed by
 * temperature and downfall; reproducing it as a two-step blend keeps every
 * biome's tint consistent with its climate without shipping the bitmap.
 */
export function grassColorFor(temperature, downfall) {
  const t = clamp(temperature, 0, 1);
  const d = clamp(downfall, 0, 1) * t;
  return mixHex(mixHex(0x80b497, 0x4c9e5a, d), mixHex(0xbfb755, 0x59c93c, d), t);
}

export function foliageColorFor(temperature, downfall) {
  const t = clamp(temperature, 0, 1);
  const d = clamp(downfall, 0, 1) * t;
  return mixHex(mixHex(0x6b9e70, 0x1f8f3a, d), mixHex(0xaea42a, 0x30bb0b, d), t);
}

// ---------------------------------------------------------------------------
// Spawn / feature shorthand
// ---------------------------------------------------------------------------

/** One entry in a spawn list: mob type, relative weight, and pack size. */
const sp = (type, weight, min = 1, max = 4) => ({ type, weight, min, max });

const PASSIVE_DEFAULT = [sp('sheep', 12, 2, 4), sp('pig', 10, 3, 4),
  sp('chicken', 10, 2, 4), sp('cow', 8, 4, 4)];
const PASSIVE_PLAINS = [...PASSIVE_DEFAULT, sp('horse', 5, 2, 6),
  sp('donkey', 1, 1, 3), sp('rabbit', 2, 2, 3)];
const PASSIVE_COLD = [sp('rabbit', 4, 2, 3), sp('polar_bear', 1, 1, 2)];
const PASSIVE_TAIGA = [sp('wolf', 8, 4, 4), sp('rabbit', 4, 2, 3),
  sp('fox', 8, 2, 4), sp('sheep', 12, 2, 4), sp('pig', 10, 3, 4),
  sp('chicken', 10, 2, 4), sp('cow', 8, 4, 4)];
const PASSIVE_JUNGLE = [sp('chicken', 10, 4, 4), sp('parrot', 40, 1, 2),
  sp('panda', 1, 1, 2), sp('ocelot', 2, 1, 3), sp('pig', 10, 3, 4),
  sp('cow', 8, 4, 4), sp('sheep', 12, 2, 4)];
const PASSIVE_SAVANNA = [sp('horse', 1, 2, 6), sp('donkey', 1, 1, 1),
  sp('sheep', 12, 2, 4), sp('cow', 8, 4, 4), sp('llama', 8, 4, 4)];
const PASSIVE_NONE = [];

const HOSTILE_DEFAULT = [sp('spider', 100, 4, 4), sp('zombie', 95, 4, 4),
  sp('zombie_villager', 5, 1, 1), sp('skeleton', 100, 4, 4),
  sp('creeper', 100, 4, 4), sp('slime', 100, 4, 4),
  sp('enderman', 10, 1, 4), sp('witch', 5, 1, 1)];
const HOSTILE_COLD = [...HOSTILE_DEFAULT.filter((e) => e.type !== 'skeleton'),
  sp('stray', 80, 4, 4), sp('skeleton', 20, 4, 4)];
const HOSTILE_OCEAN = [sp('drowned', 5, 1, 1), sp('slime', 20, 4, 4)];
const HOSTILE_DESERT = [...HOSTILE_DEFAULT.filter((e) => e.type !== 'zombie'),
  sp('husk', 80, 4, 4), sp('zombie', 19, 4, 4)];
const HOSTILE_SWAMP = [...HOSTILE_DEFAULT, sp('slime', 1, 1, 1)];
const HOSTILE_NONE = [];

const AMBIENT_DEFAULT = [sp('bat', 10, 8, 8)];
const AMBIENT_NONE = [];

const WATER_DEFAULT = [sp('squid', 2, 1, 4), sp('cod', 10, 3, 6)];
const WATER_WARM = [sp('squid', 10, 4, 4), sp('tropical_fish', 25, 8, 8),
  sp('dolphin', 2, 1, 2), sp('pufferfish', 15, 1, 3)];
const WATER_LUKEWARM = [sp('squid', 10, 4, 4), sp('cod', 15, 3, 6),
  sp('pufferfish', 5, 1, 3), sp('tropical_fish', 25, 8, 8), sp('dolphin', 2, 1, 2)];
const WATER_COLD = [sp('squid', 3, 1, 4), sp('cod', 15, 3, 6), sp('salmon', 15, 1, 5)];
const WATER_FROZEN = [sp('squid', 1, 1, 4), sp('salmon', 15, 1, 5)];
const WATER_RIVER = [sp('squid', 2, 1, 4), sp('salmon', 5, 1, 5)];
const WATER_NONE = [];

/** One entry in a tree manifest — the shape name plus a selection weight. */
const tr = (type, weight = 1) => ({ type, weight });

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

const B = [];

/**
 * Define a biome. Everything except `name` has a sensible default derived from
 * temperature and downfall, so most entries stay a handful of lines.
 */
function def(name, o = {}) {
  const temperature = o.temperature ?? 0.5;
  const downfall = o.downfall ?? 0.5;
  const precipitation = o.precipitation ??
    (downfall <= 0 ? 'none' : temperature < 0.15 ? 'snow' : 'rain');
  const b = {
    id: B.length,
    name,
    dimension: o.dimension || 'overworld',
    category: o.category || 'none',
    temperature,
    downfall,
    precipitation,

    grassColor: o.grassColor ?? grassColorFor(temperature, downfall),
    foliageColor: o.foliageColor ?? foliageColorFor(temperature, downfall),
    waterColor: o.waterColor ?? 0x3f76e4,
    waterFogColor: o.waterFogColor ?? 0x050533,
    skyColor: o.skyColor ?? skyColorFor(temperature),
    fogColor: o.fogColor ?? 0xc0d8ff,

    surfaceBlock: o.surfaceBlock ?? 'grass_block',
    subsurfaceBlock: o.subsurfaceBlock ?? 'dirt',
    underwaterBlock: o.underwaterBlock ?? 'gravel',
    // Resolved by resolveBiomeStates().
    surfaceState: 0, subsurfaceState: 0, underwaterState: 0,

    /** Extra vertical relief hint for the shaper, in blocks. */
    scale: o.scale ?? 0,

    spawns: {
      passive: o.passive ?? PASSIVE_DEFAULT,
      hostile: o.hostile ?? HOSTILE_DEFAULT,
      ambient: o.ambient ?? AMBIENT_DEFAULT,
      water: o.water ?? WATER_DEFAULT,
    },

    features: {
      trees: o.trees ?? [],
      treeDensity: o.treeDensity ?? 0,
      flowers: o.flowers ?? ['dandelion', 'poppy'],
      flowerDensity: o.flowerDensity ?? 0.1,
      grassDensity: o.grassDensity ?? 0.2,
      extra: o.extra ?? [],
    },
  };
  B.push(b);
  return b;
}

// --- Oceans ----------------------------------------------------------------

const OCEAN_COMMON = {
  category: 'ocean', passive: PASSIVE_NONE, hostile: HOSTILE_OCEAN,
  underwaterBlock: 'gravel', subsurfaceBlock: 'dirt', surfaceBlock: 'gravel',
  grassDensity: 0, flowerDensity: 0, flowers: [],
};

def('ocean', {
  ...OCEAN_COMMON, temperature: 0.5, downfall: 0.5, water: WATER_DEFAULT,
  extra: ['seagrass', 'kelp', 'clay_disk'],
});
def('deep_ocean', {
  ...OCEAN_COMMON, temperature: 0.5, downfall: 0.5, water: WATER_DEFAULT,
  extra: ['seagrass', 'kelp', 'clay_disk', 'ocean_monument'],
});
def('cold_ocean', {
  ...OCEAN_COMMON, temperature: 0.5, downfall: 0.5, water: WATER_COLD,
  waterColor: 0x3d57d6, waterFogColor: 0x050533, extra: ['seagrass', 'kelp', 'gravel_disk'],
});
def('deep_cold_ocean', {
  ...OCEAN_COMMON, temperature: 0.5, downfall: 0.5, water: WATER_COLD,
  waterColor: 0x3d57d6, extra: ['seagrass', 'kelp', 'gravel_disk', 'ocean_monument'],
});
def('frozen_ocean', {
  ...OCEAN_COMMON, temperature: 0.0, downfall: 0.5, precipitation: 'snow',
  water: WATER_FROZEN, waterColor: 0x3938c9, waterFogColor: 0x050533,
  passive: [sp('polar_bear', 1, 1, 2)], extra: ['iceberg', 'blue_ice_patch'],
});
def('deep_frozen_ocean', {
  ...OCEAN_COMMON, temperature: 0.5, downfall: 0.5, precipitation: 'rain',
  water: WATER_FROZEN, waterColor: 0x3938c9,
  passive: [sp('polar_bear', 1, 1, 2)], extra: ['iceberg', 'blue_ice_patch'],
});
def('lukewarm_ocean', {
  ...OCEAN_COMMON, temperature: 0.5, downfall: 0.5, water: WATER_LUKEWARM,
  surfaceBlock: 'sand', underwaterBlock: 'sand',
  waterColor: 0x45adf2, waterFogColor: 0x041f33, extra: ['seagrass', 'sand_disk'],
});
def('deep_lukewarm_ocean', {
  ...OCEAN_COMMON, temperature: 0.5, downfall: 0.5, water: WATER_LUKEWARM,
  surfaceBlock: 'sand', underwaterBlock: 'sand',
  waterColor: 0x45adf2, waterFogColor: 0x041f33, extra: ['seagrass', 'sand_disk'],
});
def('warm_ocean', {
  ...OCEAN_COMMON, temperature: 0.5, downfall: 0.5, water: WATER_WARM,
  surfaceBlock: 'sand', underwaterBlock: 'sand',
  waterColor: 0x43d5ee, waterFogColor: 0x041f33,
  extra: ['seagrass', 'sea_pickle', 'sand_disk'],
});

// --- Rivers & shores -------------------------------------------------------

def('river', {
  category: 'river', temperature: 0.5, downfall: 0.5,
  surfaceBlock: 'grass_block', underwaterBlock: 'sand',
  passive: PASSIVE_NONE, hostile: HOSTILE_OCEAN, water: WATER_RIVER,
  grassDensity: 0.1, extra: ['sugar_cane', 'clay_disk', 'sand_disk'],
});
def('frozen_river', {
  category: 'river', temperature: 0.0, downfall: 0.5, precipitation: 'snow',
  surfaceBlock: 'grass_block', underwaterBlock: 'gravel',
  waterColor: 0x3938c9, passive: PASSIVE_NONE, hostile: HOSTILE_COLD,
  water: WATER_FROZEN, grassDensity: 0, flowers: [], flowerDensity: 0,
});
def('beach', {
  category: 'beach', temperature: 0.8, downfall: 0.4,
  surfaceBlock: 'sand', subsurfaceBlock: 'sand', underwaterBlock: 'sand',
  passive: PASSIVE_NONE, water: WATER_NONE,
  grassDensity: 0, flowers: [], flowerDensity: 0, extra: ['sugar_cane', 'sandstone_shelf'],
});
def('snowy_beach', {
  category: 'beach', temperature: 0.05, downfall: 0.3, precipitation: 'snow',
  surfaceBlock: 'sand', subsurfaceBlock: 'sand', underwaterBlock: 'sand',
  passive: [sp('rabbit', 2, 2, 3)], hostile: HOSTILE_COLD, water: WATER_FROZEN,
  waterColor: 0x3d57d6, grassDensity: 0, flowers: [], flowerDensity: 0,
  extra: ['snow_layer'],
});
def('stony_shore', {
  category: 'beach', temperature: 0.2, downfall: 0.3,
  surfaceBlock: 'stone', subsurfaceBlock: 'stone', underwaterBlock: 'gravel',
  passive: PASSIVE_NONE, water: WATER_NONE, scale: 6,
  grassDensity: 0, flowers: [], flowerDensity: 0, extra: ['gravel_disk'],
});

// --- Flat & dry ------------------------------------------------------------

def('plains', {
  category: 'plains', temperature: 0.8, downfall: 0.4,
  passive: PASSIVE_PLAINS, trees: [tr('oak', 9), tr('big_oak', 1)], treeDensity: 0.08,
  flowers: ['dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower'],
  flowerDensity: 0.25, grassDensity: 0.55, extra: ['pumpkin', 'village_plains'],
});
def('sunflower_plains', {
  category: 'plains', temperature: 0.8, downfall: 0.4,
  passive: PASSIVE_PLAINS, trees: [tr('oak', 9), tr('big_oak', 1)], treeDensity: 0.05,
  flowers: ['sunflower', 'dandelion', 'poppy', 'oxeye_daisy'],
  flowerDensity: 0.55, grassDensity: 0.55, extra: ['pumpkin'],
});
def('snowy_plains', {
  category: 'icy', temperature: 0.0, downfall: 0.5, precipitation: 'snow',
  passive: [sp('rabbit', 4, 2, 3)], hostile: HOSTILE_COLD,
  trees: [tr('spruce', 1)], treeDensity: 0.01,
  flowers: [], flowerDensity: 0, grassDensity: 0.05,
  extra: ['snow_layer', 'ice_patch', 'igloo'],
});
def('ice_spikes', {
  category: 'icy', temperature: 0.0, downfall: 0.5, precipitation: 'snow',
  surfaceBlock: 'snow_block', subsurfaceBlock: 'dirt',
  passive: [sp('rabbit', 4, 2, 3)], hostile: HOSTILE_COLD,
  flowers: [], flowerDensity: 0, grassDensity: 0, scale: 4,
  extra: ['ice_spike', 'snow_layer', 'packed_ice_patch'],
});
def('desert', {
  category: 'desert', temperature: 2.0, downfall: 0.0, precipitation: 'none',
  surfaceBlock: 'sand', subsurfaceBlock: 'sandstone', underwaterBlock: 'sand',
  passive: PASSIVE_NONE, hostile: HOSTILE_DESERT, water: WATER_NONE,
  flowers: [], flowerDensity: 0, grassDensity: 0,
  extra: ['cactus', 'dead_bush', 'sugar_cane', 'desert_well', 'village_desert',
    'desert_pyramid'],
});
def('savanna', {
  category: 'savanna', temperature: 2.0, downfall: 0.0, precipitation: 'none',
  passive: PASSIVE_SAVANNA, trees: [tr('acacia', 4), tr('oak', 1)], treeDensity: 0.06,
  flowers: [], flowerDensity: 0.02, grassDensity: 0.7,
  extra: ['village_savanna', 'tall_grass_patch'],
});
def('savanna_plateau', {
  category: 'savanna', temperature: 2.0, downfall: 0.0, precipitation: 'none',
  passive: PASSIVE_SAVANNA, trees: [tr('acacia', 4), tr('oak', 1)], treeDensity: 0.03,
  flowers: [], flowerDensity: 0.02, grassDensity: 0.6, scale: 4,
  extra: ['village_savanna'],
});
def('windswept_savanna', {
  category: 'savanna', temperature: 2.0, downfall: 0.0, precipitation: 'none',
  passive: PASSIVE_SAVANNA, trees: [tr('acacia', 1)], treeDensity: 0.01,
  flowers: [], flowerDensity: 0, grassDensity: 0.4, scale: 14,
  extra: ['coarse_dirt_patch'],
});

// --- Forests ---------------------------------------------------------------

def('forest', {
  category: 'forest', temperature: 0.7, downfall: 0.8,
  passive: [...PASSIVE_DEFAULT, sp('wolf', 5, 4, 4)],
  trees: [tr('oak', 8), tr('birch', 2), tr('big_oak', 1)], treeDensity: 0.55,
  flowers: ['dandelion', 'poppy', 'lily_of_the_valley', 'lilac', 'rose_bush', 'peony'],
  flowerDensity: 0.2, grassDensity: 0.35, extra: ['mushroom_patch'],
});
def('flower_forest', {
  category: 'forest', temperature: 0.7, downfall: 0.8,
  passive: [...PASSIVE_DEFAULT, sp('rabbit', 4, 2, 3)],
  trees: [tr('oak', 6), tr('birch', 4)], treeDensity: 0.3,
  flowers: ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
    'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
    'cornflower', 'lily_of_the_valley', 'lilac', 'rose_bush', 'peony'],
  flowerDensity: 0.9, grassDensity: 0.3, extra: ['bee_nest'],
});
def('birch_forest', {
  category: 'forest', temperature: 0.6, downfall: 0.6,
  trees: [tr('birch', 1)], treeDensity: 0.5,
  flowers: ['dandelion', 'poppy', 'lily_of_the_valley'],
  flowerDensity: 0.2, grassDensity: 0.3, extra: ['mushroom_patch'],
});
def('old_growth_birch_forest', {
  category: 'forest', temperature: 0.6, downfall: 0.6,
  trees: [tr('tall_birch', 4), tr('birch', 1)], treeDensity: 0.6,
  flowers: ['dandelion', 'poppy', 'lily_of_the_valley'],
  flowerDensity: 0.25, grassDensity: 0.3, extra: ['bee_nest', 'mushroom_patch'],
});
def('dark_forest', {
  category: 'forest', temperature: 0.7, downfall: 0.8,
  grassColor: 0x507a32, foliageColor: 0x3d6b1f,
  trees: [tr('dark_oak', 8), tr('oak', 2), tr('birch', 1), tr('huge_red_mushroom', 1),
    tr('huge_brown_mushroom', 1)],
  treeDensity: 0.95, flowers: ['lily_of_the_valley', 'rose_bush', 'peony'],
  flowerDensity: 0.15, grassDensity: 0.25, extra: ['woodland_mansion', 'mushroom_patch'],
});
def('windswept_forest', {
  category: 'forest', temperature: 0.2, downfall: 0.3,
  trees: [tr('oak', 3), tr('spruce', 1)], treeDensity: 0.3, scale: 16,
  flowerDensity: 0.05, grassDensity: 0.2, extra: ['coarse_dirt_patch', 'boulder'],
});

// --- Taiga -----------------------------------------------------------------

def('taiga', {
  category: 'taiga', temperature: 0.25, downfall: 0.8,
  passive: PASSIVE_TAIGA, trees: [tr('spruce', 3), tr('pine', 1)], treeDensity: 0.5,
  flowers: ['dandelion', 'poppy'], flowerDensity: 0.05, grassDensity: 0.25,
  extra: ['sweet_berry_bush', 'mushroom_patch', 'village_taiga', 'boulder'],
});
def('snowy_taiga', {
  category: 'taiga', temperature: -0.5, downfall: 0.4, precipitation: 'snow',
  passive: PASSIVE_TAIGA, hostile: HOSTILE_COLD, water: WATER_FROZEN,
  waterColor: 0x3d57d6, trees: [tr('spruce', 3), tr('pine', 1)], treeDensity: 0.4,
  flowers: [], flowerDensity: 0, grassDensity: 0.1,
  extra: ['snow_layer', 'sweet_berry_bush', 'boulder'],
});
def('old_growth_pine_taiga', {
  category: 'taiga', temperature: 0.3, downfall: 0.8,
  surfaceBlock: 'podzol', subsurfaceBlock: 'dirt',
  passive: [...PASSIVE_TAIGA, sp('wolf', 8, 4, 4)],
  trees: [tr('mega_pine', 6), tr('pine', 2), tr('spruce', 1)], treeDensity: 0.7,
  flowers: [], flowerDensity: 0.02, grassDensity: 0.2,
  extra: ['podzol_patch', 'huge_brown_mushroom', 'sweet_berry_bush', 'boulder'],
});
def('old_growth_spruce_taiga', {
  category: 'taiga', temperature: 0.25, downfall: 0.8,
  surfaceBlock: 'podzol', subsurfaceBlock: 'dirt',
  passive: [...PASSIVE_TAIGA, sp('wolf', 8, 4, 4)],
  trees: [tr('mega_spruce', 6), tr('spruce', 2)], treeDensity: 0.75,
  flowers: [], flowerDensity: 0.02, grassDensity: 0.25,
  extra: ['podzol_patch', 'huge_red_mushroom', 'sweet_berry_bush', 'boulder'],
});

// --- Jungle ----------------------------------------------------------------

def('jungle', {
  category: 'jungle', temperature: 0.95, downfall: 0.9,
  passive: PASSIVE_JUNGLE,
  trees: [tr('jungle', 6), tr('mega_jungle', 2), tr('jungle_bush', 4), tr('oak', 1)],
  treeDensity: 0.9, flowers: ['dandelion', 'poppy', 'blue_orchid'],
  flowerDensity: 0.15, grassDensity: 0.8,
  extra: ['vines', 'melon', 'cocoa', 'bamboo_sparse', 'jungle_temple'],
});
def('sparse_jungle', {
  category: 'jungle', temperature: 0.95, downfall: 0.8,
  passive: PASSIVE_JUNGLE,
  trees: [tr('jungle', 3), tr('jungle_bush', 2), tr('oak', 1)], treeDensity: 0.2,
  flowers: ['dandelion', 'poppy'], flowerDensity: 0.1, grassDensity: 0.6,
  extra: ['vines', 'melon'],
});
def('bamboo_jungle', {
  category: 'jungle', temperature: 0.95, downfall: 0.9,
  passive: [...PASSIVE_JUNGLE, sp('panda', 80, 1, 2)],
  trees: [tr('jungle', 2), tr('jungle_bush', 3)], treeDensity: 0.35,
  flowers: ['dandelion'], flowerDensity: 0.05, grassDensity: 0.5,
  extra: ['bamboo_dense', 'vines', 'melon'],
});

// --- Wetlands --------------------------------------------------------------

def('swamp', {
  category: 'swamp', temperature: 0.8, downfall: 0.9,
  grassColor: 0x6a7039, foliageColor: 0x6a7039,
  waterColor: 0x617b64, waterFogColor: 0x232317, fogColor: 0xb5c9d1,
  underwaterBlock: 'dirt', subsurfaceBlock: 'dirt',
  hostile: HOSTILE_SWAMP, water: [sp('squid', 10, 1, 4), sp('cod', 5, 3, 6)],
  passive: [...PASSIVE_DEFAULT, sp('frog', 10, 2, 5)],
  trees: [tr('swamp_oak', 1)], treeDensity: 0.25,
  flowers: ['blue_orchid'], flowerDensity: 0.1, grassDensity: 0.4,
  extra: ['lily_pad', 'mushroom_patch', 'clay_disk', 'seagrass', 'witch_hut'],
});
def('mangrove_swamp', {
  category: 'swamp', temperature: 0.8, downfall: 0.9,
  grassColor: 0x6a7039, foliageColor: 0x8db127,
  waterColor: 0x3a7a6a, waterFogColor: 0x1a3d33, fogColor: 0xb5c9d1,
  surfaceBlock: 'mud', subsurfaceBlock: 'mud', underwaterBlock: 'mud',
  hostile: HOSTILE_SWAMP, water: [sp('tropical_fish', 25, 8, 8)],
  passive: [sp('frog', 10, 2, 5)],
  trees: [tr('mangrove', 1)], treeDensity: 0.5,
  flowers: [], flowerDensity: 0, grassDensity: 0.2,
  extra: ['mangrove_roots', 'mud_patch', 'lily_pad', 'seagrass', 'vines'],
});

// --- Badlands --------------------------------------------------------------

const BADLANDS_COMMON = {
  category: 'mesa', temperature: 2.0, downfall: 0.0, precipitation: 'none',
  grassColor: 0x90814d, foliageColor: 0x9e814d,
  surfaceBlock: 'red_sand', subsurfaceBlock: 'terracotta', underwaterBlock: 'red_sand',
  passive: PASSIVE_NONE, water: WATER_NONE,
  flowers: [], flowerDensity: 0, grassDensity: 0,
};
def('badlands', {
  ...BADLANDS_COMMON, scale: 8,
  extra: ['dead_bush', 'cactus', 'gold_extra', 'mineshaft_mesa'],
});
def('eroded_badlands', {
  ...BADLANDS_COMMON, scale: 22,
  extra: ['dead_bush', 'cactus', 'gold_extra', 'hoodoo', 'mineshaft_mesa'],
});
def('wooded_badlands', {
  ...BADLANDS_COMMON, downfall: 0.0, surfaceBlock: 'coarse_dirt',
  trees: [tr('oak', 1)], treeDensity: 0.25, grassDensity: 0.15, scale: 8,
  extra: ['dead_bush', 'gold_extra', 'coarse_dirt_patch'],
});

// --- Highlands -------------------------------------------------------------

def('meadow', {
  category: 'mountain', temperature: 0.5, downfall: 0.8,
  waterColor: 0x0e4ecf, passive: [...PASSIVE_PLAINS, sp('donkey', 2, 1, 2)],
  trees: [tr('oak', 1), tr('birch', 1)], treeDensity: 0.02,
  flowers: ['dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower',
    'allium', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip'],
  flowerDensity: 0.7, grassDensity: 0.75, extra: ['bee_nest', 'village_plains'],
});
def('cherry_grove', {
  category: 'mountain', temperature: 0.5, downfall: 0.8,
  grassColor: 0xb6db61, foliageColor: 0xb6db61, waterColor: 0x5db7ef,
  fogColor: 0xf3adbd, skyColor: 0x7bb8ff,
  passive: [...PASSIVE_PLAINS, sp('pig', 10, 3, 4)],
  trees: [tr('cherry', 1)], treeDensity: 0.15,
  flowers: ['pink_petals', 'dandelion', 'poppy', 'allium'],
  flowerDensity: 0.6, grassDensity: 0.6, extra: ['bee_nest'],
});
def('grove', {
  category: 'mountain', temperature: -0.2, downfall: 0.8, precipitation: 'snow',
  surfaceBlock: 'snow_block', subsurfaceBlock: 'dirt',
  passive: [sp('rabbit', 4, 2, 3), sp('wolf', 8, 4, 4), sp('fox', 8, 2, 4)],
  hostile: HOSTILE_COLD, trees: [tr('spruce', 3), tr('pine', 1)], treeDensity: 0.45,
  flowers: [], flowerDensity: 0, grassDensity: 0.05,
  extra: ['snow_layer', 'powder_snow_patch'],
});
def('snowy_slopes', {
  category: 'mountain', temperature: -0.3, downfall: 0.9, precipitation: 'snow',
  surfaceBlock: 'snow_block', subsurfaceBlock: 'dirt',
  passive: [sp('rabbit', 4, 2, 3), sp('goat', 5, 1, 3)], hostile: HOSTILE_COLD,
  flowers: [], flowerDensity: 0, grassDensity: 0, scale: 10,
  extra: ['snow_layer', 'powder_snow_patch'],
});
def('jagged_peaks', {
  category: 'mountain', temperature: -0.7, downfall: 0.9, precipitation: 'snow',
  surfaceBlock: 'snow_block', subsurfaceBlock: 'stone', underwaterBlock: 'stone',
  passive: [sp('goat', 5, 1, 3)], hostile: HOSTILE_COLD,
  flowers: [], flowerDensity: 0, grassDensity: 0, scale: 34,
  extra: ['snow_layer'],
});
def('frozen_peaks', {
  category: 'mountain', temperature: -0.7, downfall: 0.9, precipitation: 'snow',
  surfaceBlock: 'packed_ice', subsurfaceBlock: 'packed_ice', underwaterBlock: 'packed_ice',
  passive: [sp('goat', 5, 1, 3)], hostile: HOSTILE_COLD,
  flowers: [], flowerDensity: 0, grassDensity: 0, scale: 30,
  extra: ['ice_patch', 'blue_ice_patch'],
});
def('stony_peaks', {
  category: 'mountain', temperature: 1.0, downfall: 0.3,
  surfaceBlock: 'stone', subsurfaceBlock: 'stone', underwaterBlock: 'stone',
  passive: PASSIVE_NONE, flowers: [], flowerDensity: 0, grassDensity: 0, scale: 28,
  extra: ['calcite_patch', 'gravel_disk'],
});
def('windswept_hills', {
  category: 'mountain', temperature: 0.2, downfall: 0.3,
  passive: [...PASSIVE_DEFAULT, sp('llama', 5, 4, 6)],
  trees: [tr('spruce', 2), tr('oak', 1)], treeDensity: 0.06,
  flowerDensity: 0.05, grassDensity: 0.2, scale: 18,
  extra: ['boulder', 'ore_emerald', 'gravel_disk'],
});
def('windswept_gravelly_hills', {
  category: 'mountain', temperature: 0.2, downfall: 0.3,
  surfaceBlock: 'gravel', subsurfaceBlock: 'gravel',
  passive: [...PASSIVE_DEFAULT, sp('llama', 5, 4, 6)],
  trees: [tr('spruce', 2), tr('oak', 1)], treeDensity: 0.04,
  flowerDensity: 0.02, grassDensity: 0.1, scale: 20,
  extra: ['boulder', 'ore_emerald', 'gravel_disk'],
});

// --- Rare ------------------------------------------------------------------

def('mushroom_fields', {
  category: 'mushroom', temperature: 0.9, downfall: 1.0,
  surfaceBlock: 'mycelium', subsurfaceBlock: 'dirt',
  passive: [sp('mooshroom', 8, 4, 8)], hostile: HOSTILE_NONE,
  flowers: [], flowerDensity: 0, grassDensity: 0,
  trees: [tr('huge_red_mushroom', 1), tr('huge_brown_mushroom', 1)], treeDensity: 0.3,
  extra: ['mushroom_patch'],
});

// --- Cave biomes -----------------------------------------------------------

def('dripstone_caves', {
  category: 'underground', temperature: 0.8, downfall: 0.4,
  surfaceBlock: 'stone', subsurfaceBlock: 'stone', underwaterBlock: 'stone',
  passive: PASSIVE_NONE, flowers: [], flowerDensity: 0, grassDensity: 0,
  extra: ['dripstone_cluster', 'pointed_dripstone', 'water_pool'],
});
def('lush_caves', {
  category: 'underground', temperature: 0.5, downfall: 0.5,
  grassColor: 0x60c93c, foliageColor: 0x60c93c,
  surfaceBlock: 'moss_block', subsurfaceBlock: 'dirt', underwaterBlock: 'clay',
  passive: [sp('axolotl', 10, 4, 6), sp('tropical_fish', 25, 8, 8)],
  water: [sp('axolotl', 10, 4, 6), sp('tropical_fish', 25, 8, 8)],
  flowers: [], flowerDensity: 0, grassDensity: 0.3,
  trees: [tr('azalea', 1)], treeDensity: 0.1,
  extra: ['moss_patch', 'clay_pool', 'cave_vines', 'spore_blossom',
    'big_dripleaf', 'small_dripleaf', 'rooted_dirt'],
});
def('deep_dark', {
  category: 'underground', temperature: 0.8, downfall: 0.4,
  surfaceBlock: 'deepslate', subsurfaceBlock: 'deepslate', underwaterBlock: 'deepslate',
  passive: PASSIVE_NONE, hostile: HOSTILE_NONE, ambient: AMBIENT_NONE,
  flowers: [], flowerDensity: 0, grassDensity: 0,
  extra: ['sculk_patch', 'sculk_vein', 'ancient_city'],
});

// --- Nether ----------------------------------------------------------------

const NETHER_COMMON = {
  dimension: 'nether', category: 'nether', temperature: 2.0, downfall: 0.0,
  precipitation: 'none', passive: PASSIVE_NONE, ambient: AMBIENT_NONE,
  water: WATER_NONE, flowers: [], flowerDensity: 0, grassDensity: 0,
  skyColor: 0x000000,
};
def('nether_wastes', {
  ...NETHER_COMMON, fogColor: 0x330808, waterColor: 0x905957, waterFogColor: 0x905957,
  surfaceBlock: 'netherrack', subsurfaceBlock: 'netherrack', underwaterBlock: 'netherrack',
  hostile: [sp('zombified_piglin', 50, 4, 4), sp('ghast', 50, 4, 4),
    sp('magma_cube', 2, 4, 4), sp('enderman', 1, 4, 4), sp('piglin', 15, 4, 4),
    sp('strider', 60, 1, 2)],
  extra: ['glowstone_blob', 'nether_fire', 'brown_mushroom', 'crimson_roots',
    'nether_fortress', 'nether_quartz', 'nether_gold', 'lava_spring'],
});
def('soul_sand_valley', {
  ...NETHER_COMMON, fogColor: 0x1b4745, waterColor: 0x905957, waterFogColor: 0x905957,
  surfaceBlock: 'soul_sand', subsurfaceBlock: 'soul_soil', underwaterBlock: 'soul_soil',
  hostile: [sp('skeleton', 20, 5, 5), sp('ghast', 50, 4, 4),
    sp('enderman', 1, 4, 4), sp('strider', 60, 1, 2), sp('magma_cube', 2, 4, 4)],
  extra: ['soul_fire', 'basalt_pillar', 'nether_fossil', 'glowstone_blob',
    'nether_sprouts', 'soul_lantern_cluster'],
});
def('crimson_forest', {
  ...NETHER_COMMON, fogColor: 0x330303, waterColor: 0x905957, waterFogColor: 0x905957,
  surfaceBlock: 'crimson_nylium', subsurfaceBlock: 'netherrack',
  underwaterBlock: 'netherrack',
  hostile: [sp('zombified_piglin', 1, 2, 4), sp('hoglin', 9, 3, 4),
    sp('piglin', 5, 3, 4), sp('strider', 60, 1, 2)],
  trees: [tr('crimson_fungus_huge', 1)], treeDensity: 0.6,
  extra: ['crimson_roots', 'weeping_vines', 'shroomlight', 'nether_gold',
    'glowstone_blob'],
});
def('warped_forest', {
  ...NETHER_COMMON, fogColor: 0x1a051a, waterColor: 0x905957, waterFogColor: 0x905957,
  surfaceBlock: 'warped_nylium', subsurfaceBlock: 'netherrack',
  underwaterBlock: 'netherrack',
  hostile: [sp('enderman', 1, 4, 4), sp('strider', 60, 1, 2)],
  trees: [tr('warped_fungus_huge', 1)], treeDensity: 0.6,
  extra: ['warped_roots', 'twisting_vines', 'nether_sprouts', 'shroomlight',
    'glowstone_blob'],
});
def('basalt_deltas', {
  ...NETHER_COMMON, fogColor: 0x685f70, waterColor: 0x3f76e4, waterFogColor: 0x050533,
  surfaceBlock: 'basalt', subsurfaceBlock: 'basalt', underwaterBlock: 'basalt',
  hostile: [sp('ghast', 40, 1, 1), sp('magma_cube', 100, 2, 5),
    sp('strider', 60, 1, 2)],
  extra: ['basalt_delta', 'blackstone_blob', 'magma_blob', 'glowstone_blob',
    'nether_fire', 'lava_spring'],
});

// --- The End ---------------------------------------------------------------

const END_COMMON = {
  dimension: 'end', category: 'the_end', temperature: 0.5, downfall: 0.5,
  precipitation: 'none', passive: PASSIVE_NONE, ambient: AMBIENT_NONE,
  water: WATER_NONE, flowers: [], flowerDensity: 0, grassDensity: 0,
  surfaceBlock: 'end_stone', subsurfaceBlock: 'end_stone', underwaterBlock: 'end_stone',
  skyColor: 0x000000, fogColor: 0xa080a0, grassColor: 0x8080ff, foliageColor: 0x8080ff,
};
def('the_end', {
  ...END_COMMON, hostile: [sp('enderman', 10, 4, 4)],
  extra: ['end_spike', 'ender_dragon_fight'],
});
def('end_highlands', {
  ...END_COMMON, hostile: [sp('enderman', 10, 4, 4)],
  trees: [tr('chorus', 1)], treeDensity: 0.6, extra: ['chorus_plant', 'end_city'],
});
def('end_midlands', {
  ...END_COMMON, hostile: [sp('enderman', 10, 4, 4)], extra: [],
});
def('end_barrens', {
  ...END_COMMON, hostile: [sp('enderman', 10, 4, 4)], extra: [],
});
def('small_end_islands', {
  ...END_COMMON, hostile: [sp('enderman', 10, 4, 4)],
  trees: [tr('chorus', 1)], treeDensity: 0.2, extra: ['chorus_plant'],
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** Every biome, in id order. */
export const BIOMES = B;
/** Indexed by biome id — the table the renderer and mesher read. */
export const biomeById = B;
/** Name -> biome. */
export const biomeByName = new Map(B.map((b) => [b.name, b]));

/** Convenience: numeric id from a name (throws on typos, which is the point). */
export function biomeId(name) {
  const b = biomeByName.get(name);
  if (!b) throw new Error(`unknown biome ${name}`);
  return b.id;
}

let statesResolved = false;
/**
 * Turn the `*Block` names into block state ids. Safe to call repeatedly; the
 * terrain generator calls it once the block registry exists.
 */
export function resolveBiomeStates(force = false) {
  if (statesResolved && !force) return BIOMES;
  const state = (name, fallback) => {
    const b = blocksByName.get(name);
    return b ? b.defaultState : fallback;
  };
  const stone = state('stone', 1);
  for (const b of BIOMES) {
    b.surfaceState = state(b.surfaceBlock, stone);
    b.subsurfaceState = state(b.subsurfaceBlock, stone);
    b.underwaterState = state(b.underwaterBlock, stone);
  }
  statesResolved = blocksByName.size > 0;
  return BIOMES;
}

// ---------------------------------------------------------------------------
// Climate space
// ---------------------------------------------------------------------------

/**
 * Peaks-and-valleys, derived from weirdness exactly as Minecraft does it.
 * pv = -1 at w=0 (river valleys), +1 at |w|=2/3 (ridge crests), 0 at |w|=1.
 */
export function peaksAndValleys(w) {
  return -(Math.abs(Math.abs(w) - 0.6666667) - 0.33333334) * 3.0;
}

const FULL = [-1, 1];
const T_BANDS = [[-1, -0.45], [-0.45, -0.15], [-0.15, 0.2], [0.2, 0.55], [0.55, 1]];
const H_BANDS = [[-1, -0.35], [-0.35, -0.1], [-0.1, 0.1], [0.1, 0.3], [0.3, 1]];

const C_MUSHROOM = [-1.2, -1.05];
const C_DEEP_OCEAN = [-1.05, -0.455];
const C_OCEAN = [-0.455, -0.19];
const C_COAST = [-0.19, -0.11];
const C_NEAR_MID = [-0.11, 0.3];
const C_FAR = [0.3, 1.0];
const C_INLAND = [-0.11, 1.0];

// Erosion bands, merged from Minecraft's seven into the five that actually
// change which biome you get here.
const E_PEAKS = [-1.0, -0.78];
const E_HIGH = [-0.78, -0.375];
const E_MID = [-0.375, 0.05];
const E_LOW = [0.05, 0.45];
const E_FLAT = [0.45, 1.0];

const W_LO = [-1, 0];
const W_HI = [0, 1];
// Weirdness bands that map onto peaks-and-valleys. |w| ~ 2/3 is a crest.
const W_PEAK_LO = [-0.79, -0.56];
const W_PEAK_HI = [0.56, 0.79];
const W_SLOPE_LO = [-0.56, -0.4];
const W_SLOPE_HI = [0.4, 0.56];
const W_SLOPE2_LO = [-0.94, -0.79];
const W_SLOPE2_HI = [0.79, 0.94];

const D_SURFACE = [0, 0.2];
const D_DEEP = [0.2, 1.4];
const D_VERY_DEEP = [0.85, 1.4];

const entries = [];

/**
 * Claim a box of climate space for a biome.
 * Ranges are `[min,max]`; `off` is a tie-break penalty (larger = less eager).
 */
function claim(name, t, h, c, e, w, d, off = 0) {
  const b = biomeByName.get(name);
  if (!b) throw new Error(`climate entry for unknown biome ${name}`);
  entries.push({ id: b.id, t, h, c, e, w, d, off });
}

/** The 5x5 temperature x humidity grids Minecraft uses for inland terrain. */
const MIDDLE = [
  ['snowy_plains', 'snowy_plains', 'snowy_plains', 'snowy_taiga', 'taiga'],
  ['plains', 'plains', 'forest', 'taiga', 'old_growth_spruce_taiga'],
  ['plains', 'plains', 'forest', 'birch_forest', 'dark_forest'],
  ['savanna', 'savanna', 'forest', 'jungle', 'jungle'],
  ['desert', 'desert', 'desert', 'desert', 'desert'],
];
const MIDDLE_VARIANT = [
  ['ice_spikes', null, null, 'snowy_taiga', null],
  [null, null, null, null, null],
  ['flower_forest', 'sunflower_plains', 'forest', 'old_growth_birch_forest', null],
  [null, null, 'plains', 'sparse_jungle', 'bamboo_jungle'],
  [null, null, null, null, null],
];
const PLATEAU = [
  ['snowy_plains', 'snowy_plains', 'snowy_plains', 'snowy_taiga', 'snowy_taiga'],
  ['meadow', 'meadow', 'forest', 'taiga', 'old_growth_spruce_taiga'],
  ['meadow', 'meadow', 'meadow', 'meadow', 'dark_forest'],
  ['savanna_plateau', 'savanna_plateau', 'forest', 'forest', 'jungle'],
  ['badlands', 'badlands', 'badlands', 'wooded_badlands', 'wooded_badlands'],
];
const PLATEAU_VARIANT = [
  ['ice_spikes', null, null, null, null],
  ['cherry_grove', null, 'meadow', 'meadow', 'old_growth_pine_taiga'],
  ['cherry_grove', 'cherry_grove', 'forest', 'birch_forest', null],
  [null, null, null, null, null],
  ['eroded_badlands', 'eroded_badlands', null, null, null],
];
const SHATTERED = [
  ['windswept_gravelly_hills', 'windswept_gravelly_hills', 'windswept_hills',
    'windswept_forest', 'windswept_forest'],
  ['windswept_gravelly_hills', 'windswept_gravelly_hills', 'windswept_hills',
    'windswept_forest', 'windswept_forest'],
  ['windswept_hills', 'windswept_hills', 'windswept_hills',
    'windswept_forest', 'windswept_forest'],
  ['windswept_savanna', 'windswept_savanna', 'windswept_savanna',
    'windswept_savanna', 'windswept_savanna'],
  ['desert', 'desert', 'desert', 'desert', 'desert'],
];
const PEAKS = ['jagged_peaks', 'jagged_peaks', 'stony_peaks', 'stony_peaks', 'badlands'];
const PEAKS_HI = ['frozen_peaks', 'frozen_peaks', 'stony_peaks', 'stony_peaks', 'badlands'];
const SLOPES = ['snowy_slopes', 'snowy_slopes', 'grove', 'meadow', 'badlands'];

/**
 * Add a whole grid at once. Where the weirdness variant matches the base the
 * entry is widened to the full weirdness range instead of being duplicated,
 * which keeps the table (and therefore the lookup) about a third smaller.
 */
function claimGrid(base, variant, c, e, d = D_SURFACE, off = 0) {
  for (let t = 0; t < 5; t++) {
    for (let h = 0; h < 5; h++) {
      const lo = base[t][h];
      const hi = (variant && variant[t][h]) || lo;
      if (lo === hi) {
        claim(lo, T_BANDS[t], H_BANDS[h], c, e, FULL, d, off);
      } else {
        claim(lo, T_BANDS[t], H_BANDS[h], c, e, W_LO, d, off);
        claim(hi, T_BANDS[t], H_BANDS[h], c, e, W_HI, d, off);
      }
    }
  }
}

function claimRow(row, c, e, w, d = D_SURFACE, off = 0) {
  for (let t = 0; t < 5; t++) claim(row[t], T_BANDS[t], FULL, c, e, w, d, off);
}

// -- Oceans ------------------------------------------------------------------
const DEEP_OCEANS = ['deep_frozen_ocean', 'deep_cold_ocean', 'deep_ocean',
  'deep_lukewarm_ocean', 'warm_ocean'];
const OCEANS = ['frozen_ocean', 'cold_ocean', 'ocean', 'lukewarm_ocean', 'warm_ocean'];
claimRow(DEEP_OCEANS, C_DEEP_OCEAN, FULL, FULL);
claimRow(OCEANS, C_OCEAN, FULL, FULL);

// -- Mushroom fields: the one biome keyed purely on extreme continentalness. --
claim('mushroom_fields', FULL, FULL, C_MUSHROOM, FULL, FULL, D_SURFACE);

// -- Coast -------------------------------------------------------------------
claimRow(['stony_shore', 'stony_shore', 'stony_shore', 'stony_shore', 'stony_shore'],
  C_COAST, [-1, -0.2225], FULL);
claimRow(['snowy_beach', 'beach', 'beach', 'beach', 'desert'],
  C_COAST, [-0.2225, 1.0], FULL);

// -- Rivers: weirdness near zero is the bottom of the peaks-and-valleys curve.
claim('frozen_river', T_BANDS[0], FULL, [-0.19, 1.0], [-0.2225, 1.0], [-0.07, 0.07], D_SURFACE);
for (let t = 1; t < 5; t++) {
  claim('river', T_BANDS[t], FULL, [-0.19, 1.0], [-0.2225, 1.0], [-0.07, 0.07], D_SURFACE);
}

// -- Mountains: erosion bands 0-1 split by peaks-and-valleys ------------------
claimRow(PEAKS, C_INLAND, E_PEAKS, W_PEAK_LO);
claimRow(PEAKS_HI, C_INLAND, E_PEAKS, W_PEAK_HI);
claimRow(SLOPES, C_INLAND, E_PEAKS, W_SLOPE_LO);
claimRow(SLOPES, C_INLAND, E_PEAKS, W_SLOPE_HI);
claimRow(SLOPES, C_INLAND, E_PEAKS, W_SLOPE2_LO);
claimRow(SLOPES, C_INLAND, E_PEAKS, W_SLOPE2_HI);
claimGrid(PLATEAU, PLATEAU_VARIANT, C_INLAND, E_PEAKS, D_SURFACE, 0.06);

claimRow(PEAKS, C_INLAND, E_HIGH, W_PEAK_LO);
claimRow(SLOPES, C_INLAND, E_HIGH, W_SLOPE_LO);
claimRow(SLOPES, C_INLAND, E_HIGH, W_SLOPE2_LO);
// Erosion band 1 with positive weirdness is Minecraft's "shattered" strip.
claimGrid(SHATTERED, null, C_INLAND, E_HIGH, D_SURFACE, 0.02);
claimGrid(MIDDLE, MIDDLE_VARIANT, C_INLAND, E_HIGH, D_SURFACE, 0.08);

// -- Ordinary inland ---------------------------------------------------------
for (const e of [E_MID, E_LOW]) {
  claimGrid(MIDDLE, MIDDLE_VARIANT, C_NEAR_MID, e);
  claimGrid(PLATEAU, PLATEAU_VARIANT, C_FAR, e);
}
claimGrid(MIDDLE, MIDDLE_VARIANT, C_NEAR_MID, E_FLAT, D_SURFACE, 0.02);
claimGrid(PLATEAU, PLATEAU_VARIANT, C_FAR, E_FLAT, D_SURFACE, 0.02);

// -- Wetlands: the flattest, wettest, warmest inland corner ------------------
claim('swamp', T_BANDS[2], H_BANDS[3], C_NEAR_MID, E_FLAT, FULL, D_SURFACE);
claim('swamp', T_BANDS[2], H_BANDS[4], C_NEAR_MID, E_FLAT, FULL, D_SURFACE);
claim('swamp', T_BANDS[3], H_BANDS[3], C_NEAR_MID, E_FLAT, FULL, D_SURFACE);
claim('swamp', T_BANDS[3], H_BANDS[4], C_NEAR_MID, E_FLAT, W_LO, D_SURFACE);
claim('mangrove_swamp', T_BANDS[3], H_BANDS[4], C_NEAR_MID, E_FLAT, W_HI, D_SURFACE);
claim('mangrove_swamp', T_BANDS[4], H_BANDS[4], [-0.19, 0.3], E_FLAT, FULL, D_SURFACE);

// -- Underground -------------------------------------------------------------
claim('dripstone_caves', FULL, FULL, [0.55, 1.0], FULL, FULL, D_DEEP);
claim('lush_caves', FULL, [0.45, 1.0], FULL, FULL, FULL, D_DEEP);
claim('deep_dark', FULL, FULL, FULL, [-1.0, -0.32], FULL, D_VERY_DEEP);

// ---------------------------------------------------------------------------
// Flattened table + nearest-match lookup
// ---------------------------------------------------------------------------

const STRIDE = 13;
const CLIMATE = new Float32Array(entries.length * STRIDE);
const CLIMATE_ID = new Int32Array(entries.length);
for (let i = 0; i < entries.length; i++) {
  const e = entries[i], o = i * STRIDE;
  CLIMATE[o] = e.t[0]; CLIMATE[o + 1] = e.t[1];
  CLIMATE[o + 2] = e.h[0]; CLIMATE[o + 3] = e.h[1];
  CLIMATE[o + 4] = e.c[0]; CLIMATE[o + 5] = e.c[1];
  CLIMATE[o + 6] = e.e[0]; CLIMATE[o + 7] = e.e[1];
  CLIMATE[o + 8] = e.w[0]; CLIMATE[o + 9] = e.w[1];
  CLIMATE[o + 10] = e.d[0]; CLIMATE[o + 11] = e.d[1];
  CLIMATE[o + 12] = e.off * e.off;
  CLIMATE_ID[i] = e.id;
}

/** Number of climate boxes in the table — handy for tests and tuning. */
export const climateEntryCount = entries.length;

/**
 * Nearest-match over the six climate axes.
 * Distance to a box is zero inside it and grows quadratically outside, so the
 * whole space is covered with no gaps and biome borders land where the noise
 * fields cross a box edge.
 *
 * Hot path: called ~50 times per chunk, so it reads the flat table directly and
 * allocates nothing.
 */
export function selectBiomeId(temperature, humidity, continentalness, erosion,
  weirdness, depth) {
  const A = CLIMATE;
  let best = 0, bestD = Infinity;
  for (let i = 0, o = 0; i < CLIMATE_ID.length; i++, o += STRIDE) {
    let d = A[o + 12];
    if (d >= bestD) continue;

    let v = temperature < A[o] ? A[o] - temperature
      : temperature > A[o + 1] ? temperature - A[o + 1] : 0;
    d += v * v;
    if (d >= bestD) continue;

    v = humidity < A[o + 2] ? A[o + 2] - humidity
      : humidity > A[o + 3] ? humidity - A[o + 3] : 0;
    d += v * v;
    if (d >= bestD) continue;

    v = continentalness < A[o + 4] ? A[o + 4] - continentalness
      : continentalness > A[o + 5] ? continentalness - A[o + 5] : 0;
    d += v * v;
    if (d >= bestD) continue;

    v = erosion < A[o + 6] ? A[o + 6] - erosion
      : erosion > A[o + 7] ? erosion - A[o + 7] : 0;
    d += v * v;
    if (d >= bestD) continue;

    v = weirdness < A[o + 8] ? A[o + 8] - weirdness
      : weirdness > A[o + 9] ? weirdness - A[o + 9] : 0;
    d += v * v;
    if (d >= bestD) continue;

    v = depth < A[o + 10] ? A[o + 10] - depth
      : depth > A[o + 11] ? depth - A[o + 11] : 0;
    d += v * v;
    if (d >= bestD) continue;

    bestD = d;
    best = CLIMATE_ID[i];
  }
  return best;
}

/**
 * Object-shaped entry point.
 * @param {{temperature?:number, humidity?:number, continentalness?:number,
 *          erosion?:number, weirdness?:number, depth?:number}} params
 * @returns {object} the matching biome
 */
export function selectBiome(params) {
  return BIOMES[selectBiomeId(
    params.temperature ?? 0, params.humidity ?? 0, params.continentalness ?? 0,
    params.erosion ?? 0, params.weirdness ?? 0, params.depth ?? 0)];
}

/** Biome ids grouped by dimension, for generators that bypass the climate search. */
export const NETHER_BIOMES = BIOMES.filter((b) => b.dimension === 'nether').map((b) => b.id);
export const END_BIOMES = BIOMES.filter((b) => b.dimension === 'end').map((b) => b.id);

/** True when a biome's water freezes and its rain falls as snow. */
export const isSnowy = (b) => b.precipitation === 'snow';

/**
 * Temperature adjusted for altitude, the way Minecraft decides whether rain
 * falls as snow high up in an otherwise temperate biome.
 */
export function temperatureAt(biome, y) {
  if (y <= 80) return biome.temperature;
  return biome.temperature - (y - 80) * 0.0035;
}

/** Linear colour blend, exported so the mesher can share one implementation. */
export const blendColor = (a, b, t) => mixHex(a, b, clamp(t, 0, 1));

export { lerp };
