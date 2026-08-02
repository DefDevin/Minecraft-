// Natural terrain: air and technical blocks, stone, dirt, ores, mineral blocks,
// sand, ice, snow and the two fluids.
//
// `air` is registered first and must stay first: its default state id is 0,
// which every hot loop in the engine assumes ("state === 0" means empty).

import {
  def, st, cube, pillar, axisPlacement, MAT, mat, boxesToModel, oreDrop,
  fixedDrop, silkOnly, stateLight, NO_MODEL,
  PROP, getProp, withProp, stateOf, blockOf,
  RENDER, PASS, TINT, SOUND, TOOL, TIER, PUSH, T, SHAPE,
} from './helpers.js';
import { XP, MAP } from './data.js';
import { AABB } from '../../core/math.js';

export function registerTerrain() {
  registerTechnical();
  registerStone();
  registerDirt();
  registerOres();
  registerMinerals();
  registerIceAndSnow();
  registerFluids();
}

// ---------------------------------------------------------------------------
// Air and technical blocks
// ---------------------------------------------------------------------------

function registerTechnical() {
  const airOpts = {
    render: RENDER.INVISIBLE,
    solid: false,
    opaque: false,
    replaceable: true,
    hardness: 0,
    blastResistance: 0,
    lightFilter: 0,
    push: PUSH.DESTROY,
    mapColor: MAP.none,
    canSpawnOn: false,
    collision: () => SHAPE.NONE,
    selection: () => SHAPE.NONE,
    drops: () => [],
    item: null,
    creativeTab: null,
  };
  // Registered first — `air.defaultState` must be 0.
  def('air', airOpts, { isAir: true, noConnect: true });
  def('cave_air', airOpts, { isAir: true, noConnect: true });
  def('void_air', airOpts, { isAir: true, noConnect: true });

  def('barrier', {
    render: RENDER.INVISIBLE,
    solid: true,
    opaque: false,
    hardness: -1,
    blastResistance: 3600000,
    lightFilter: 0,
    push: PUSH.BLOCK,
    mapColor: MAP.none,
    collision: () => SHAPE.FULL,
    drops: () => [],
    creativeTab: 'functional',
  }, { noConnect: true });

  def('structure_void', {
    render: RENDER.INVISIBLE,
    solid: false,
    opaque: false,
    replaceable: true,
    hardness: 0,
    blastResistance: 0,
    push: PUSH.DESTROY,
    mapColor: MAP.none,
    collision: () => SHAPE.NONE,
    selection: () => [new AABB(5 / 16, 5 / 16, 5 / 16, 11 / 16, 11 / 16, 11 / 16)],
    drops: () => [],
    creativeTab: 'functional',
  }, { noConnect: true });

  // The light block is invisible but emits its `level`; T.light is patched
  // per-state because the base table only stores one emission per block.
  const light = def('light', {
    properties: [XP.level15, PROP.waterlogged],
    defaultState: { level: 15, waterlogged: false },
    render: RENDER.INVISIBLE,
    solid: false,
    opaque: false,
    replaceable: true,
    hardness: -1,
    blastResistance: 3600000,
    light: 15,
    lightFilter: 0,
    push: PUSH.DESTROY,
    mapColor: MAP.none,
    collision: () => SHAPE.NONE,
    selection: () => SHAPE.NONE,
    drops: () => [],
    creativeTab: 'functional',
  }, { noConnect: true });
  stateLight(light, (state) => getProp(state, 'level'));
}

// ---------------------------------------------------------------------------
// Stone
// ---------------------------------------------------------------------------

function registerStone() {
  const stone = MAT.stone;

  cube('stone', 'stone', mat(stone, {
    drops: silkOnly(fixedDrop('cobblestone')),
  }));
  cube('granite', 'granite', mat(stone, { mapColor: MAP.dirt }));
  cube('polished_granite', 'polished_granite', mat(stone, { mapColor: MAP.dirt }));
  cube('diorite', 'diorite', mat(stone, { mapColor: MAP.quartz }));
  cube('polished_diorite', 'polished_diorite', mat(stone, { mapColor: MAP.quartz }));
  cube('andesite', 'andesite', mat(stone, { mapColor: MAP.stone }));
  cube('polished_andesite', 'polished_andesite', mat(stone, { mapColor: MAP.stone }));

  axisPlacement(pillar('deepslate', 'deepslate', 'deepslate_top', mat(MAT.deepslate, {
    hardness: 3, blastResistance: 6,
    drops: silkOnly(fixedDrop('cobbled_deepslate')),
  })));
  cube('cobbled_deepslate', 'cobbled_deepslate', mat(MAT.deepslate, {
    hardness: 3.5, blastResistance: 6,
  }));
  cube('polished_deepslate', 'polished_deepslate', mat(MAT.deepslate, {
    hardness: 3.5, blastResistance: 6,
  }));
  cube('deepslate_bricks', 'deepslate_bricks', mat(MAT.deepslate, {
    hardness: 3.5, blastResistance: 6,
  }));
  cube('cracked_deepslate_bricks', 'cracked_deepslate_bricks', mat(MAT.deepslate, {
    hardness: 3.5, blastResistance: 6,
  }));
  cube('deepslate_tiles', 'deepslate_tiles', mat(MAT.deepslate, {
    hardness: 3.5, blastResistance: 6,
  }));
  cube('cracked_deepslate_tiles', 'cracked_deepslate_tiles', mat(MAT.deepslate, {
    hardness: 3.5, blastResistance: 6,
  }));
  cube('chiseled_deepslate', 'chiseled_deepslate', mat(MAT.deepslate, {
    hardness: 3.5, blastResistance: 6,
  }));
  cube('reinforced_deepslate', 'reinforced_deepslate', mat(MAT.deepslate, {
    hardness: 55, blastResistance: 1200, requiresTool: false, drops: () => [],
  }));

  cube('calcite', 'calcite', mat(stone, {
    hardness: 0.75, blastResistance: 0.75, mapColor: MAP.terracottaWhite,
  }));
  cube('tuff', 'tuff', mat(stone, { hardness: 1.5, blastResistance: 6, mapColor: MAP.gray }));
  cube('polished_tuff', 'polished_tuff', mat(stone, { mapColor: MAP.gray }));
  cube('tuff_bricks', 'tuff_bricks', mat(stone, { mapColor: MAP.gray }));
  cube('chiseled_tuff', 'chiseled_tuff', mat(stone, { mapColor: MAP.gray }));
  cube('chiseled_tuff_bricks', 'chiseled_tuff_bricks', mat(stone, { mapColor: MAP.gray }));
  cube('dripstone_block', 'dripstone_block', mat(stone, {
    hardness: 1.5, blastResistance: 1, mapColor: MAP.dirt,
  }));

  cube('smooth_basalt', 'smooth_basalt', mat(stone, {
    hardness: 1.25, blastResistance: 4.2, mapColor: MAP.black,
  }));
  axisPlacement(pillar('basalt', 'basalt_side', 'basalt_top', mat(stone, {
    hardness: 1.25, blastResistance: 4.2, mapColor: MAP.black,
  })));
  axisPlacement(pillar('polished_basalt', 'polished_basalt_side', 'polished_basalt_top',
    mat(stone, { hardness: 1.25, blastResistance: 4.2, mapColor: MAP.black })));

  cube('blackstone', 'blackstone', mat(stone, { mapColor: MAP.black }));
  cube('polished_blackstone', 'polished_blackstone', mat(stone, {
    hardness: 2, blastResistance: 6, mapColor: MAP.black,
  }));
  cube('chiseled_polished_blackstone', 'chiseled_polished_blackstone', mat(stone, {
    hardness: 1.5, blastResistance: 6, mapColor: MAP.black,
  }));
  cube('polished_blackstone_bricks', 'polished_blackstone_bricks', mat(stone, {
    hardness: 1.5, blastResistance: 6, mapColor: MAP.black,
  }));
  cube('cracked_polished_blackstone_bricks', 'cracked_polished_blackstone_bricks',
    mat(stone, { hardness: 1.5, blastResistance: 6, mapColor: MAP.black }));
  cube('gilded_blackstone', 'gilded_blackstone', mat(stone, {
    mapColor: MAP.black,
    drops: (world, x, y, z, state, tool, random) => {
      // 10% chance of dropping gold nuggets instead of the block itself.
      if (random && random.chance(0.1)) {
        return [{ item: 'gold_nugget', count: random.intRange(2, 5) }];
      }
      return [{ item: 'gilded_blackstone', count: 1 }];
    },
  }));

  cube('obsidian', 'obsidian', mat(stone, {
    hardness: 50, blastResistance: 1200, tier: TIER.DIAMOND, mapColor: MAP.black,
    push: PUSH.BLOCK,
  }));
  cube('crying_obsidian', 'crying_obsidian', mat(stone, {
    hardness: 50, blastResistance: 1200, tier: TIER.DIAMOND, mapColor: MAP.black,
    push: PUSH.BLOCK, light: 10,
  }));
  cube('bedrock', 'bedrock', mat(stone, {
    hardness: -1, blastResistance: 3600000, requiresTool: false,
    push: PUSH.BLOCK, drops: () => [],
  }));
  cube('netherrack', 'netherrack', mat(MAT.netherrack, {}));
  cube('end_stone', 'end_stone', mat(stone, {
    hardness: 3, blastResistance: 9, mapColor: MAP.sand,
  }));
  cube('magma_block', 'magma_block', mat(stone, {
    hardness: 0.5, blastResistance: 0.5, light: 3, mapColor: MAP.netherrack,
    onEntityInside(world, x, y, z, state, entity) {
      // Damage is applied by the entity system; announce the contact instead of
      // reaching into a combat module that does not exist yet.
      world.game?.damage?.onMagmaContact?.(world, entity, x, y, z);
    },
  }));

  // Pointed dripstone grows in both directions from a dripstone block.
  def('pointed_dripstone', {
    properties: [PROP.thickness, PROP.vertical, PROP.waterlogged],
    defaultState: { thickness: 'tip', vertical_direction: 'up', waterlogged: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 1.5,
    blastResistance: 3,
    tool: TOOL.PICKAXE,
    requiresTool: true,
    sound: SOUND.STONE,
    mapColor: MAP.dirt,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    randomTick: true,
    creativeTab: 'natural',
    textures: (state) =>
      `pointed_dripstone_${getProp(state, 'vertical_direction')}_${getProp(state, 'thickness')}`,
    model: (state) => boxesToModel(dripstoneBoxes(state),
      `pointed_dripstone_${getProp(state, 'vertical_direction')}_${getProp(state, 'thickness')}`),
    collision: dripstoneBoxes,
    canSurvive(world, x, y, z, state) {
      const up = getProp(state, 'vertical_direction') === 'up';
      const support = world.getBlock(x, up ? y - 1 : y + 1, z);
      const d = blockOf(support);
      if (d && d.name === 'pointed_dripstone') return true;
      return T.solid[support] === 1;
    },
  }, { noConnect: true });
}

function dripstoneBoxes(state) {
  const thickness = getProp(state, 'thickness');
  const up = getProp(state, 'vertical_direction') === 'up';
  const w = thickness === 'tip' ? 3 / 16 : thickness === 'frustum' ? 4 / 16 : 5 / 16;
  const h = thickness === 'tip' ? 11 / 16 : 1;
  return [up
    ? new AABB(0.5 - w, 0, 0.5 - w, 0.5 + w, h, 0.5 + w)
    : new AABB(0.5 - w, 1 - h, 0.5 - w, 0.5 + w, 1, 0.5 + w)];
}

// ---------------------------------------------------------------------------
// Dirt and soil
// ---------------------------------------------------------------------------

function registerDirt() {
  cube('dirt', 'dirt', mat(MAT.dirt, {}));
  cube('coarse_dirt', 'coarse_dirt', mat(MAT.dirt, {}));
  cube('rooted_dirt', 'rooted_dirt', mat(MAT.dirt, {
    hardness: 0.5, sound: SOUND.GRASS,
  }));

  // Grass-like surfaces share the "snowy" property and the top-face tint.
  surfaceBlock('grass_block', {
    top: 'grass_block_top', side: 'grass_block_side', bottom: 'dirt',
    tint: TINT.GRASS, mapColor: MAP.grass, hardness: 0.6,
    drops: silkOnly(fixedDrop('dirt')),
    spreads: true,
  });
  surfaceBlock('podzol', {
    top: 'podzol_top', side: 'podzol_side', bottom: 'dirt',
    tint: TINT.NONE, mapColor: MAP.podzol, hardness: 0.5,
    drops: silkOnly(fixedDrop('dirt')),
  });
  surfaceBlock('mycelium', {
    top: 'mycelium_top', side: 'mycelium_side', bottom: 'dirt',
    tint: TINT.NONE, mapColor: MAP.purple, hardness: 0.6,
    drops: silkOnly(fixedDrop('dirt')),
    spreads: true,
  });

  cube('mud', 'mud', mat(MAT.dirt, {
    hardness: 0.5, sound: SOUND.SLIME, mapColor: MAP.terracottaCyan,
    speedFactor: 0.9,
    collision: () => [new AABB(0, 0, 0, 1, 0.9, 1)],
  }));
  axisPlacement(pillar('muddy_mangrove_roots', 'muddy_mangrove_roots_side',
    'muddy_mangrove_roots_top', mat(MAT.dirt, {
      hardness: 0.7, sound: SOUND.WET_GRASS, mapColor: MAP.podzol,
    })));

  def('farmland', {
    properties: [PROP.moisture],
    defaultState: { moisture: 0 },
    render: RENDER.MODEL,
    hardness: 0.6,
    blastResistance: 0.6,
    tool: TOOL.SHOVEL,
    sound: SOUND.GRAVEL,
    mapColor: MAP.dirt,
    opaque: false,
    randomTick: true,
    creativeTab: 'natural',
    textures: (state) => [
      'dirt', 'dirt', 'dirt',
      getProp(state, 'moisture') > 0 ? 'farmland_moist' : 'farmland', 'dirt', 'dirt'],
    model: (state) => boxesToModel(SHAPE.farmland, [
      'dirt', 'dirt', 'dirt',
      getProp(state, 'moisture') > 0 ? 'farmland_moist' : 'farmland', 'dirt', 'dirt']),
    collision: () => SHAPE.farmland,
    drops: fixedDrop('dirt'),
    onRandomTick(world, x, y, z, state, random) {
      const moisture = getProp(state, 'moisture');
      const wet = hasWaterNearby(world, x, y, z);
      if (wet) {
        if (moisture < 7) world.setBlock(x, y, z, withProp(state, 'moisture', 7));
        return;
      }
      if (moisture > 0) { world.setBlock(x, y, z, withProp(state, 'moisture', moisture - 1)); return; }
      // Dry farmland reverts to dirt once nothing is growing on it.
      const above = blockOf(world.getBlock(x, y + 1, z));
      if (!above || !above.isCrop) world.setBlock(x, y, z, st('dirt'));
    },
    onSteppedOn(world, x, y, z, state, entity) {
      if (entity && entity.fallDistance > 0.5) world.setBlock(x, y, z, st('dirt'));
    },
  }, { noConnect: true });

  def('dirt_path', {
    render: RENDER.MODEL,
    hardness: 0.65,
    blastResistance: 0.65,
    tool: TOOL.SHOVEL,
    sound: SOUND.GRASS,
    mapColor: MAP.dirt,
    opaque: false,
    creativeTab: 'natural',
    textures: ['dirt_path_side', 'dirt_path_side', 'dirt', 'dirt_path_top',
      'dirt_path_side', 'dirt_path_side'],
    model: () => boxesToModel(SHAPE.farmland, ['dirt_path_side', 'dirt_path_side',
      'dirt', 'dirt_path_top', 'dirt_path_side', 'dirt_path_side']),
    collision: () => SHAPE.farmland,
    drops: fixedDrop('dirt'),
  }, { noConnect: true });

  cube('clay', 'clay', mat(MAT.dirt, {
    hardness: 0.6, mapColor: MAP.clay, drops: oreDrop('clay_ball', 4, 4),
  }));
  cube('gravel', 'gravel', mat(MAT.gravel, {
    drops: (world, x, y, z, state, tool, random) => {
      // Gravel yields flint one time in ten, and always with Fortune III.
      const fortune = tool && tool.getEnchantLevel ? tool.getEnchantLevel('fortune') : 0;
      const chance = [0.1, 0.14, 0.25, 1][Math.min(fortune, 3)];
      if (random && random.chance(chance)) return [{ item: 'flint', count: 1 }];
      return [{ item: 'gravel', count: 1 }];
    },
  }));
  cube('sand', 'sand', mat(MAT.sand, {}));
  cube('red_sand', 'red_sand', mat(MAT.sand, { mapColor: MAP.orange }));
  // Soul sand looks like a full cube but stands 1/8 short, which is what slows
  // walkers down and lets bubble columns form above it.
  cube('soul_sand', 'soul_sand', mat(MAT.sand, {
    gravity: false, hardness: 0.5, mapColor: MAP.brown, sound: SOUND.SAND,
    speedFactor: 0.4,
    collision: () => SHAPE.soulSand,
  }));
  cube('soul_soil', 'soul_soil', mat(MAT.sand, {
    gravity: false, hardness: 0.5, mapColor: MAP.brown, sound: SOUND.SAND,
  }));
}

/** Grass block / podzol / mycelium: dirt sides, distinct top, `snowy` flag. */
function surfaceBlock(name, o) {
  const b = def(name, {
    properties: [PROP.snowy],
    defaultState: { snowy: false },
    render: RENDER.CUBE,
    hardness: o.hardness,
    blastResistance: o.hardness,
    tool: TOOL.SHOVEL,
    sound: SOUND.GRASS,
    mapColor: o.mapColor,
    randomTick: !!o.spreads,
    creativeTab: 'natural',
    drops: o.drops,
    textures: (state) => {
      const snowy = getProp(state, 'snowy');
      const side = snowy ? 'grass_block_snow' : o.side;
      return [side, side, o.bottom, snowy ? 'snow' : o.top, side, side];
    },
    model: (state) => {
      const snowy = getProp(state, 'snowy');
      const side = snowy ? 'grass_block_snow' : o.side;
      const m = boxesToModel(SHAPE.FULL,
        [side, side, o.bottom, snowy ? 'snow' : o.top, side, side])[0];
      // Only the top face takes the biome tint. Vanilla tints a separate side
      // overlay quad; we have no overlay pass, so the painter bakes a green
      // fringe into `grass_block_side` and the dirt below it stays brown.
      if (!snowy && o.tint) m.faces[3].tint = o.tint;
      return [m];
    },
    updateShape(world, x, y, z, state) {
      const above = world.getBlockName(x, y + 1, z);
      const snowy = above === 'snow' || above === 'snow_block' || above === 'powder_snow';
      return withProp(state, 'snowy', snowy);
    },
    onRandomTick: o.spreads ? spreadSurface : null,
  }, { isSurface: true });
  return b;
}

/** Grass and mycelium creep onto neighbouring dirt that has enough light. */
function spreadSurface(world, x, y, z, state, random) {
  const self = blockOf(state);
  if (world.getSkyLight(x, y + 1, z) < 4 && world.getBlockLight(x, y + 1, z) < 4) {
    // Buried grass dies back to dirt.
    if (T.opaque[world.getBlock(x, y + 1, z)]) world.setBlock(x, y, z, st('dirt'));
    return;
  }
  for (let i = 0; i < 4; i++) {
    const nx = x + random.intRange(-1, 1);
    const ny = y + random.intRange(-3, 1);
    const nz = z + random.intRange(-1, 1);
    if (world.getBlockName(nx, ny, nz) !== 'dirt') continue;
    if (T.opaque[world.getBlock(nx, ny + 1, nz)]) continue;
    if (world.getLight(nx, ny + 1, nz) < 4) continue;
    world.setBlock(nx, ny, nz, self.defaultState);
  }
}

function hasWaterNearby(world, x, y, z) {
  for (let dy = 0; dy <= 1; dy++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (T.fluid[world.getBlock(x + dx, y + dy, z + dz)] === 1) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ores
// ---------------------------------------------------------------------------

function registerOres() {
  const stoneOre = { hardness: 3, blastResistance: 3 };
  const deepOre = { hardness: 4.5, blastResistance: 3, mapColor: MAP.deepslate };

  const ores = [
    ['coal_ore', 'coal', 1, 1, TIER.WOOD, [0, 2]],
    ['iron_ore', 'raw_iron', 1, 1, TIER.STONE, [0, 0]],
    ['copper_ore', 'raw_copper', 2, 5, TIER.STONE, [0, 0]],
    ['gold_ore', 'raw_gold', 1, 1, TIER.IRON, [0, 0]],
    ['diamond_ore', 'diamond', 1, 1, TIER.IRON, [3, 7]],
    ['emerald_ore', 'emerald', 1, 1, TIER.IRON, [3, 7]],
    ['lapis_ore', 'lapis_lazuli', 4, 9, TIER.STONE, [2, 5]],
  ];
  for (const [name, drop, min, max, tier, xp] of ores) {
    const opts = mat(MAT.stone, Object.assign({}, stoneOre, {
      tier, drops: oreDrop(drop, min, max),
    }));
    cube(name, name, opts).xpDrop = xp;
    const deep = mat(MAT.stone, Object.assign({}, deepOre, {
      tier, drops: oreDrop(drop, min, max),
    }));
    cube(`deepslate_${name}`, `deepslate_${name}`, deep).xpDrop = xp;
  }

  // Redstone ore lights up when disturbed, so it needs a `lit` state.
  for (const prefix of ['', 'deepslate_']) {
    const name = `${prefix}redstone_ore`;
    const b = def(name, mat(MAT.stone, {
      properties: [PROP.lit],
      defaultState: { lit: false },
      hardness: prefix ? 4.5 : 3,
      blastResistance: 3,
      tier: TIER.IRON,
      mapColor: prefix ? MAP.deepslate : MAP.stone,
      randomTick: true,
      textures: name,
      drops: oreDrop('redstone', 4, 5),
      onUse: lightRedstoneOre,
      onSteppedOn: lightRedstoneOre,
      onRandomTick(world, x, y, z, state) {
        if (getProp(state, 'lit')) world.setBlock(x, y, z, withProp(state, 'lit', false));
      },
    }));
    b.xpDrop = [1, 5];
    stateLight(b, (state) => (getProp(state, 'lit') ? 9 : 0));
  }

  cube('nether_gold_ore', 'nether_gold_ore', mat(MAT.stone, {
    hardness: 3, blastResistance: 3, sound: SOUND.NETHER, mapColor: MAP.netherrack,
    drops: oreDrop('gold_nugget', 2, 6),
  })).xpDrop = [0, 1];
  cube('nether_quartz_ore', 'nether_quartz_ore', mat(MAT.stone, {
    hardness: 3, blastResistance: 3, sound: SOUND.NETHER, mapColor: MAP.netherrack,
    drops: oreDrop('quartz', 1, 1),
  })).xpDrop = [2, 5];
  cube('ancient_debris', 'ancient_debris', mat(MAT.stone, {
    hardness: 30, blastResistance: 1200, tier: TIER.DIAMOND, mapColor: MAP.black,
    push: PUSH.BLOCK,
  }));
}

function lightRedstoneOre(world, x, y, z, state) {
  if (!getProp(state, 'lit')) world.setBlock(x, y, z, withProp(state, 'lit', true));
  return false;   // never consumes the interaction
}

// ---------------------------------------------------------------------------
// Mineral storage blocks
// ---------------------------------------------------------------------------

function registerMinerals() {
  cube('coal_block', 'coal_block', mat(MAT.stone, {
    hardness: 5, blastResistance: 6, mapColor: MAP.black,
    flammable: 5, burnTime: 5, fuelTicks: 16000,
  }));
  cube('raw_iron_block', 'raw_iron_block', mat(MAT.metal, {
    tier: TIER.STONE, mapColor: MAP.rawIron,
  }));
  cube('raw_copper_block', 'raw_copper_block', mat(MAT.metal, {
    tier: TIER.STONE, mapColor: MAP.copper,
  }));
  cube('raw_gold_block', 'raw_gold_block', mat(MAT.metal, {
    tier: TIER.IRON, mapColor: MAP.gold,
  }));
  cube('iron_block', 'iron_block', mat(MAT.metal, { tier: TIER.STONE }));
  cube('gold_block', 'gold_block', mat(MAT.metal, {
    hardness: 3, tier: TIER.IRON, mapColor: MAP.gold,
  }));
  cube('diamond_block', 'diamond_block', mat(MAT.metal, {
    tier: TIER.IRON, mapColor: MAP.diamond,
  }));
  cube('emerald_block', 'emerald_block', mat(MAT.metal, {
    tier: TIER.IRON, mapColor: MAP.emerald,
  }));
  cube('lapis_block', 'lapis_block', mat(MAT.stone, {
    hardness: 3, blastResistance: 3, tier: TIER.STONE, mapColor: MAP.lapis,
  }));
  cube('netherite_block', 'netherite_block', mat(MAT.metal, {
    hardness: 50, blastResistance: 1200, tier: TIER.DIAMOND, mapColor: MAP.black,
    push: PUSH.BLOCK,
  }));

  // Redstone block is a permanent power source.
  cube('redstone_block', 'redstone_block', mat(MAT.metal, {
    hardness: 5, blastResistance: 6, tier: TIER.WOOD, mapColor: MAP.red,
    redstone: { source: true, strong: false, power: 15 },
    creativeTab: 'redstone',
  }));

  axisPlacement(pillar('bone_block', 'bone_block_side', 'bone_block_top',
    mat(MAT.stone, {
      hardness: 2, blastResistance: 2, sound: SOUND.BONE, mapColor: MAP.sand,
    })));
}

// ---------------------------------------------------------------------------
// Ice and snow
// ---------------------------------------------------------------------------

function registerIceAndSnow() {
  def('ice', mat(MAT.ice, {
    render: RENDER.CUBE,
    pass: PASS.TRANSLUCENT,
    opaque: false,
    lightFilter: 3,
    transparentToSelf: true,
    textures: 'ice',
    randomTick: true,
    creativeTab: 'natural',
    drops: silkOnly(() => []),
    onRandomTick(world, x, y, z, state) {
      // Ice melts under a bright light source, leaving water in the overworld.
      if (world.getBlockLight(x, y + 1, z) <= 11 - 3) return;
      world.setBlock(x, y, z, world.dimension === 'nether' ? 0 : st('water'));
    },
  }));
  cube('packed_ice', 'packed_ice', mat(MAT.ice, {
    hardness: 0.5, drops: silkOnly(() => []),
  }));
  cube('blue_ice', 'blue_ice', mat(MAT.ice, {
    hardness: 2.8, slipperiness: 0.989, drops: silkOnly(() => []),
  }));

  def('frosted_ice', mat(MAT.ice, {
    properties: [PROP.age3],
    defaultState: { age: 0 },
    render: RENDER.CUBE,
    pass: PASS.TRANSLUCENT,
    opaque: false,
    lightFilter: 3,
    transparentToSelf: true,
    textures: (state) => `frosted_ice_${getProp(state, 'age')}`,
    randomTick: true,
    drops: () => [],
    creativeTab: null,
    onRandomTick(world, x, y, z, state, random) {
      const age = getProp(state, 'age');
      if (age < 3) { world.setBlock(x, y, z, withProp(state, 'age', age + 1)); return; }
      world.setBlock(x, y, z, st('water'));
    },
  }));

  def('snow', {
    properties: [PROP.layers],
    defaultState: { layers: 1 },
    render: RENDER.MODEL,
    hardness: 0.1,
    blastResistance: 0.1,
    tool: TOOL.SHOVEL,
    requiresTool: true,
    sound: SOUND.SNOW,
    mapColor: MAP.snow,
    solid: false,
    opaque: false,
    replaceable: true,
    randomTick: true,
    push: PUSH.DESTROY,
    creativeTab: 'natural',
    textures: 'snow',
    model: (state) => boxesToModel(SHAPE.snowLayer(getProp(state, 'layers')), 'snow'),
    collision: (state) => {
      const layers = getProp(state, 'layers');
      // A single layer is walked over rather than stepped onto.
      return layers <= 1 ? SHAPE.NONE : [new AABB(0, 0, 0, 1, (layers - 1) * 2 / 16, 1)];
    },
    selection: (state) => SHAPE.snowLayer(getProp(state, 'layers')),
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y - 1, z)] === 1 ||
      world.getBlockName(x, y - 1, z) === 'snow',
    drops: (world, x, y, z, state, tool) => {
      const layers = getProp(state, 'layers');
      const silk = tool && tool.getEnchantLevel && tool.getEnchantLevel('silk_touch') > 0;
      if (silk && layers === 8) return [{ item: 'snow_block', count: 1 }];
      return [{ item: 'snowball', count: layers }];
    },
    onRandomTick(world, x, y, z, state) {
      if (world.getBlockLight(x, y, z) > 11) world.setBlock(x, y, z, 0);
    },
  }, { noConnect: true });

  cube('snow_block', 'snow_block', mat(MAT.snow, {
    hardness: 0.2, drops: silkOnly(fixedDrop('snowball', 4)),
  }));

  def('powder_snow', {
    render: RENDER.CUBE,
    hardness: 0.25,
    blastResistance: 0.25,
    sound: SOUND.POWDER_SNOW,
    mapColor: MAP.snow,
    solid: false,
    opaque: true,
    lightFilter: 15,
    textures: 'powder_snow',
    creativeTab: 'natural',
    // Entities sink into powder snow, so it has no collision of its own.
    collision: () => SHAPE.NONE,
    selection: () => SHAPE.FULL,
    drops: () => [],
    onEntityInside(world, x, y, z, state, entity) {
      world.game?.effects?.onPowderSnow?.(world, entity, x, y, z);
    },
  }, { noConnect: true });
}

// ---------------------------------------------------------------------------
// Fluids
// ---------------------------------------------------------------------------

function registerFluids() {
  def('water', {
    properties: [PROP.level8],
    defaultState: { level: 0 },
    render: RENDER.FLUID,
    pass: PASS.TRANSLUCENT,
    tint: TINT.WATER,
    fluid: 'water',
    solid: false,
    opaque: false,
    // Light dims one step per block of depth rather than being blocked outright.
    lightFilter: 1,
    hardness: 100,
    blastResistance: 100,
    replaceable: true,
    push: PUSH.DESTROY,
    sound: SOUND.WET_GRASS,
    mapColor: MAP.water,
    canSpawnOn: false,
    textures: { still: 'water_still', flow: 'water_flow', overlay: 'water_overlay' },
    model: NO_MODEL,
    collision: () => SHAPE.NONE,
    selection: () => SHAPE.NONE,
    drops: () => [],
    item: 'water_bucket',
    creativeTab: null,
    onScheduledTick(world, x, y, z, state) {
      world.game?.fluids?.tick?.(world, x, y, z, state);
    },
    onNeighborChange(world, x, y, z, state) {
      world.scheduleTick(x, y, z, blockOf(state), 5);
    },
  }, { isFluid: true, noConnect: true });

  def('lava', {
    properties: [PROP.level8],
    defaultState: { level: 0 },
    render: RENDER.FLUID,
    pass: PASS.SOLID,
    fluid: 'lava',
    solid: false,
    opaque: false,
    lightFilter: 15,
    light: 15,
    emissive: 15,
    hardness: 100,
    blastResistance: 100,
    replaceable: true,
    push: PUSH.DESTROY,
    sound: SOUND.STONE,
    mapColor: MAP.fire,
    canSpawnOn: false,
    textures: { still: 'lava_still', flow: 'lava_flow' },
    model: NO_MODEL,
    collision: () => SHAPE.NONE,
    selection: () => SHAPE.NONE,
    drops: () => [],
    item: 'lava_bucket',
    creativeTab: null,
    randomTick: true,
    onScheduledTick(world, x, y, z, state) {
      world.game?.fluids?.tick?.(world, x, y, z, state);
    },
    onNeighborChange(world, x, y, z, state) {
      world.scheduleTick(x, y, z, blockOf(state), 30);
    },
    onRandomTick(world, x, y, z, state, random) {
      world.game?.fire?.spreadFromLava?.(world, x, y, z, random);
    },
    onEntityInside(world, x, y, z, state, entity) {
      world.game?.damage?.onLavaContact?.(world, entity, x, y, z);
    },
  }, { isFluid: true, noConnect: true });
}
