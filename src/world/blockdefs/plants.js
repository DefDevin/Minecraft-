// Plants, crops, mushrooms, nether flora and flower pots.
//
// Most of these are cross-rendered and share three concerns: what they can
// stand on (`canSurvive`), how they grow (`onRandomTick`) and what happens when
// their support disappears. The factories below capture those three so each
// species is one line of data.

import {
  def, st, cube, pillar, axisPlacement, MAT, mat, boxesToModel, crossBlock,
  isWaterAt, fixedDrop, silkOnly, oreDrop, stateLight, NO_MODEL, faceFacing,
  PROP, getProp, withProp, stateOf, blockOf, RENDER, PASS, TINT, SOUND, TOOL,
  PUSH, T, SHAPE, HIDDEN,
} from './helpers.js';
import { getBlock } from '../blocks.js';
import {
  XP, MAP, DIRS, FACING_INDEX, POTTED, PLANTABLE, NYLIUM_LIKE,
  SUGAR_CANE_BASE,
} from './data.js';
import { plantableBelow } from './wood.js';
import { AABB, FACES, HORIZONTAL } from '../../core/math.js';

export function registerPlants() {
  registerGrasses();
  registerFlowers();
  registerWaterPlants();
  registerVines();
  registerMushrooms();
  registerNetherFlora();
  registerCaveFlora();
  registerGrowables();
  registerCrops();
  registerGourds();
  registerFlowerPots();
}

// ---------------------------------------------------------------------------
// Grasses and small plants
// ---------------------------------------------------------------------------

function registerGrasses() {
  smallPlant('short_grass', { tint: TINT.GRASS, replaceable: true, shears: 'short_grass' });
  smallPlant('fern', { tint: TINT.GRASS, replaceable: true, shears: 'fern' });
  smallPlant('dead_bush', {
    tint: TINT.NONE, replaceable: true, shears: 'dead_bush', mapColor: MAP.wood,
    support: (name) => PLANTABLE.has(name) || name === 'sand' || name === 'red_sand' ||
      name === 'terracotta' || name.endsWith('_terracotta'),
    drops: (world, x, y, z, state, tool, random) => {
      const item = tool && tool.item;
      if (item && item.tool === TOOL.SHEARS) return [{ item: 'dead_bush', count: 1 }];
      return random && random.chance(0.5) ? [{ item: 'stick', count: random.intRange(1, 2) }] : [];
    },
  });

  tallPlant('tall_grass', { tint: TINT.GRASS, replaceable: true, shears: 'short_grass' });
  tallPlant('large_fern', { tint: TINT.GRASS, replaceable: true, shears: 'fern' });
}

/**
 * A one-block cross plant.
 * `shears` names the item a shear-mined plant yields (grass drops seeds by hand).
 */
function smallPlant(name, o = {}) {
  const support = o.support || ((n) => PLANTABLE.has(n));
  const b = crossBlock(name, o.texture || name, mat(MAT.plant, {
    tint: o.tint ?? TINT.NONE,
    mapColor: o.mapColor ?? MAP.plant,
    replaceable: o.replaceable ?? false,
    properties: o.properties,
    defaultState: o.defaultState,
    randomTick: !!o.onRandomTick,
    onRandomTick: o.onRandomTick,
    canSurvive: (world, x, y, z) => support(world.getBlockName(x, y - 1, z), world, x, y, z),
    drops: o.drops || (o.shears ? (world, x, y, z, state, tool, random) => {
      const item = tool && tool.item;
      if (item && item.tool === TOOL.SHEARS) return [{ item: o.shears, count: 1 }];
      // Hand-broken grass occasionally drops wheat seeds.
      return random && random.chance(0.125) ? [{ item: 'wheat_seeds', count: 1 }] : [];
    } : undefined),
    creativeTab: 'natural',
  }));
  return b;
}

/** A two-block plant occupying `half` = bottom and top. */
function tallPlant(name, o = {}) {
  const support = o.support || ((n) => PLANTABLE.has(n));
  const b = crossBlock(name, (state) =>
    `${name}_${getProp(state, 'half') === 'top' ? 'top' : 'bottom'}`, mat(MAT.plant, {
    properties: [PROP.half],
    defaultState: { half: 'bottom' },
    tint: o.tint ?? TINT.NONE,
    mapColor: o.mapColor ?? MAP.plant,
    replaceable: o.replaceable ?? false,
    creativeTab: 'natural',
    canSurvive(world, x, y, z, state) {
      if (getProp(state, 'half') === 'top') {
        return blockOf(world.getBlock(x, y - 1, z)) === blockOf(state);
      }
      return support(world.getBlockName(x, y - 1, z));
    },
    onBreak(world, x, y, z, state) {
      const oy = getProp(state, 'half') === 'top' ? y - 1 : y + 1;
      if (blockOf(world.getBlock(x, oy, z)) === blockOf(state)) world.setBlock(x, oy, z, 0);
    },
    drops: o.drops || (o.shears ? (world, x, y, z, state, tool, random) => {
      // Only the lower half yields anything, exactly as in vanilla.
      if (getProp(state, 'half') === 'top') return [];
      const item = tool && tool.item;
      if (item && item.tool === TOOL.SHEARS) return [{ item: o.shears, count: 2 }];
      return random && random.chance(0.125) ? [{ item: 'wheat_seeds', count: 1 }] : [];
    } : (world, x, y, z, state) =>
      (getProp(state, 'half') === 'top' ? [] : [{ item: name, count: 1 }])),
  }), { isTallPlant: true });
  return b;
}

// ---------------------------------------------------------------------------
// Flowers
// ---------------------------------------------------------------------------

const SMALL_FLOWERS = [
  ['dandelion', MAP.yellow], ['poppy', MAP.red], ['blue_orchid', MAP.lightBlue],
  ['allium', MAP.magenta], ['azure_bluet', MAP.snow], ['red_tulip', MAP.red],
  ['orange_tulip', MAP.orange], ['white_tulip', MAP.snow], ['pink_tulip', MAP.pink],
  ['oxeye_daisy', MAP.snow], ['cornflower', MAP.blue],
  ['lily_of_the_valley', MAP.snow], ['torchflower', MAP.orange],
];

function registerFlowers() {
  for (const [name, color] of SMALL_FLOWERS) {
    smallPlant(name, { mapColor: color });
  }
  // The wither rose is the one flower that hurts whatever walks into it.
  smallPlant('wither_rose', {
    mapColor: MAP.black,
    onEntityInside(world, x, y, z, state, entity) {
      world.game?.effects?.applyWither?.(world, entity);
    },
  });

  tallPlant('sunflower', { mapColor: MAP.yellow });
  tallPlant('lilac', { mapColor: MAP.magenta });
  tallPlant('rose_bush', { mapColor: MAP.red });
  tallPlant('peony', { mapColor: MAP.pink });

  // Pitcher plant completes the sniffer set and reuses the tall-plant shape.
  tallPlant('pitcher_plant', { mapColor: MAP.cyan });
}

// ---------------------------------------------------------------------------
// Water plants
// ---------------------------------------------------------------------------

function registerWaterPlants() {
  smallPlant('seagrass', {
    tint: TINT.NONE, mapColor: MAP.water, replaceable: true,
    support: (n) => n !== 'air' && n !== 'water',
  });
  tallPlant('tall_seagrass', {
    tint: TINT.NONE, mapColor: MAP.water, replaceable: true,
    support: (n) => n !== 'air' && n !== 'water',
  });

  // Kelp grows upward through water; the "plant" form is the stalk below the tip.
  const kelp = crossBlock('kelp', 'kelp', mat(MAT.plant, {
    properties: [PROP.age25],
    defaultState: { age: 0 },
    mapColor: MAP.water,
    sound: SOUND.WET_GRASS,
    randomTick: true,
    flammable: 0,
    burnTime: 0,
    creativeTab: 'natural',
    canSurvive: (world, x, y, z) => {
      const below = world.getBlockName(x, y - 1, z);
      return below === 'kelp_plant' || T.solid[world.getBlock(x, y - 1, z)] === 1;
    },
    onRandomTick(world, x, y, z, state, random) {
      const age = getProp(state, 'age');
      if (age >= 25 || !random.chance(0.14)) return;
      if (T.fluid[world.getBlock(x, y + 1, z)] !== 1) return;
      world.setBlock(x, y, z, st('kelp_plant'));
      world.setBlock(x, y + 1, z, withProp(state, 'age', age + 1));
    },
  }));
  crossBlock('kelp_plant', 'kelp_plant', mat(MAT.plant, {
    mapColor: MAP.water,
    sound: SOUND.WET_GRASS,
    flammable: 0,
    burnTime: 0,
    item: 'kelp',
    creativeTab: HIDDEN,
    canSurvive: (world, x, y, z) => {
      const below = world.getBlockName(x, y - 1, z);
      return below === 'kelp_plant' || T.solid[world.getBlock(x, y - 1, z)] === 1;
    },
  }));

  def('lily_pad', mat(MAT.plant, {
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    tint: TINT.FOLIAGE,
    mapColor: MAP.plant,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    flammable: 0,
    burnTime: 0,
    creativeTab: 'natural',
    textures: 'lily_pad',
    model: () => boxesToModel(LILY_PAD, 'lily_pad', { tint: TINT.FOLIAGE }),
    collision: () => LILY_PAD,
    canSurvive: (world, x, y, z) => {
      const below = world.getBlock(x, y - 1, z);
      return T.fluid[below] === 1 && T.fluidLevel[below] === 0;
    },
  }), { isPlant: true, noConnect: true });
}

const LILY_PAD = [new AABB(1 / 16, 0, 1 / 16, 15 / 16, 1.5 / 16, 15 / 16)];

// ---------------------------------------------------------------------------
// Vines and lichen
// ---------------------------------------------------------------------------

const SIDE_PROPS = [PROP.north, PROP.east, PROP.south, PROP.west, PROP.up, PROP.down];

/** Thin skin on whichever faces are set — vine, glow lichen, sculk vein. */
export function multifaceBlock(name, o = {}) {
  const props = o.noDown ? SIDE_PROPS.slice(0, 5) : SIDE_PROPS.slice();
  if (o.waterloggable) props.push(PROP.waterlogged);
  const defaults = {
    north: false, east: false, south: false, west: false, up: false,
  };
  if (!o.noDown) defaults.down = false;
  if (o.waterloggable) defaults.waterlogged = false;

  const b = def(name, mat(MAT.plant, {
    properties: props,
    defaultState: defaults,
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: o.hardness ?? 0.2,
    blastResistance: o.blastResistance ?? 0.2,
    tool: o.tool ?? TOOL.NONE,
    sound: o.sound ?? SOUND.GRASS,
    tint: o.tint ?? TINT.NONE,
    mapColor: o.mapColor ?? MAP.plant,
    solid: false,
    opaque: false,
    light: o.light ?? 0,
    emissive: o.emissive ?? 0,
    push: PUSH.DESTROY,
    flammable: o.flammable ?? 0,
    burnTime: o.burnTime ?? 0,
    climbable: o.climbable ?? false,
    creativeTab: 'natural',
    textures: name,
    model: (state) => boxesToModel(multifaceBoxes(state, o.noDown), name,
      { tint: o.tint || TINT.NONE, emissive: o.emissive || 0 }),
    collision: () => SHAPE.NONE,
    selection: (state) => multifaceBoxes(state, o.noDown),
    drops: o.drops,
    canSurvive(world, x, y, z, state) {
      // Survives as long as at least one of its faces still has a wall.
      for (let i = 0; i < 6; i++) {
        const p = i === 4 ? 'up' : i === 5 ? 'down' : DIRS[i];
        if (o.noDown && p === 'down') continue;
        if (!getProp(state, p)) continue;
        const f = FACES[FACE_FOR_SIDE[p]];
        if (T.solid[world.getBlock(x + f.dx, y + f.dy, z + f.dz)] === 1) return true;
        if (o.climbable && p !== 'up' && p !== 'down') {
          // Vines also hang from a vine directly above.
          if (blockOf(world.getBlock(x, y + 1, z)) === blockOf(state)) return true;
        }
      }
      return false;
    },
  }), { isMultiface: true, noConnect: true });
  return b;
}

/** Property name -> FACES index of the wall that side sticks to. */
const FACE_FOR_SIDE = { north: 4, east: 1, south: 5, west: 0, up: 3, down: 2 };

function multifaceBoxes(state, noDown) {
  const boxes = [];
  const t = 1 / 16;
  if (getProp(state, 'north')) boxes.push(new AABB(0, 0, 0, 1, 1, t));
  if (getProp(state, 'south')) boxes.push(new AABB(0, 0, 1 - t, 1, 1, 1));
  if (getProp(state, 'west')) boxes.push(new AABB(0, 0, 0, t, 1, 1));
  if (getProp(state, 'east')) boxes.push(new AABB(1 - t, 0, 0, 1, 1, 1));
  if (getProp(state, 'up')) boxes.push(new AABB(0, 1 - t, 0, 1, 1, 1));
  if (!noDown && getProp(state, 'down')) boxes.push(new AABB(0, 0, 0, 1, t, 1));
  return boxes.length ? boxes : [new AABB(0, 0, 0, 1, t, 1)];
}

function registerVines() {
  multifaceBlock('vine', {
    noDown: true,
    tint: TINT.FOLIAGE,
    climbable: true,
    hardness: 0.2,
    flammable: 15,
    burnTime: 100,
    drops: (world, x, y, z, state, tool) => {
      const item = tool && tool.item;
      return (item && item.tool === TOOL.SHEARS) ? [{ item: 'vine', count: 1 }] : [];
    },
  });

  multifaceBlock('glow_lichen', {
    waterloggable: true,
    light: 7,
    emissive: 7,
    mapColor: MAP.glowLichen,
    hardness: 0.2,
    drops: (world, x, y, z, state, tool) => {
      const item = tool && tool.item;
      return (item && item.tool === TOOL.SHEARS) ? [{ item: 'glow_lichen', count: 1 }] : [];
    },
  });
}

// ---------------------------------------------------------------------------
// Mushrooms
// ---------------------------------------------------------------------------

function registerMushrooms() {
  for (const kind of ['brown', 'red']) {
    const name = `${kind}_mushroom`;
    smallPlant(name, {
      mapColor: kind === 'brown' ? MAP.brown : MAP.red,
      support: (n, world, x, y, z) =>
        n === 'mycelium' || n === 'podzol' || n === 'nylium' ||
        n.endsWith('_nylium') || n === 'mud' ||
        (T.opaque[world.getBlock(x, y - 1, z)] === 1 && world.getLight(x, y, z) < 13),
      onRandomTick(world, x, y, z, state, random) {
        // Mushrooms creep to nearby dark blocks.
        if (!random.oneIn(25)) return;
        const nx = x + random.intRange(-2, 2);
        const ny = y + random.intRange(-1, 1);
        const nz = z + random.intRange(-2, 2);
        if (world.getBlock(nx, ny, nz) !== 0) return;
        if (world.getLight(nx, ny, nz) >= 13) return;
        if (T.opaque[world.getBlock(nx, ny - 1, nz)] !== 1) return;
        world.setBlock(nx, ny, nz, blockOf(state).defaultState);
      },
    });
    if (kind === 'brown') stateLight(getBlock(name), () => 1);
  }

  // Huge mushroom blocks: each face is either the cap texture or the pale inside.
  for (const [name, tex, color] of [
    ['brown_mushroom_block', 'brown_mushroom_block', MAP.dirt],
    ['red_mushroom_block', 'red_mushroom_block', MAP.red],
    ['mushroom_stem', 'mushroom_stem', MAP.wool],
  ]) {
    def(name, mat(MAT.wood, {
      properties: SIDE_PROPS.slice(),
      defaultState: {
        north: true, east: true, south: true, west: true, up: true, down: true,
      },
      render: RENDER.CUBE,
      hardness: 0.2,
      blastResistance: 0.2,
      tool: TOOL.AXE,
      sound: SOUND.WOOD,
      mapColor: color,
      creativeTab: 'natural',
      textures: (state) => [
        getProp(state, 'west') ? tex : 'mushroom_block_inside',
        getProp(state, 'east') ? tex : 'mushroom_block_inside',
        getProp(state, 'down') ? tex : 'mushroom_block_inside',
        getProp(state, 'up') ? tex : 'mushroom_block_inside',
        getProp(state, 'north') ? tex : 'mushroom_block_inside',
        getProp(state, 'south') ? tex : 'mushroom_block_inside',
      ],
      // Huge mushrooms only yield their small form; the stem yields nothing.
      drops: name === 'mushroom_stem'
        ? silkOnly(() => [])
        : silkOnly(oreDrop(
          name === 'brown_mushroom_block' ? 'brown_mushroom' : 'red_mushroom', 0, 2)),
    }), { noConnect: true });
  }
}

// ---------------------------------------------------------------------------
// Nether flora
// ---------------------------------------------------------------------------

function registerNetherFlora() {
  for (const kind of ['crimson', 'warped']) {
    const nylium = `${kind}_nylium`;
    def(nylium, mat(MAT.netherrack, {
      render: RENDER.CUBE,
      hardness: 0.4,
      blastResistance: 0.4,
      mapColor: kind === 'crimson' ? MAP.crimsonNylium : MAP.warpedNylium,
      textures: { top: `${nylium}_top`, side: `${nylium}_side`, bottom: 'netherrack' },
      drops: silkOnly(fixedDrop('netherrack')),
      creativeTab: 'natural',
    }), { plantableNylium: true });

    smallPlant(`${kind}_fungus`, {
      mapColor: kind === 'crimson' ? MAP.crimsonNylium : MAP.warpedNylium,
      support: (n) => NYLIUM_LIKE.has(n),
      onRandomTick(world, x, y, z, state, random) {
        // Bone meal drives huge fungus growth; natural spread is left to the
        // feature generator so tree shapes stay in one place.
        if (random.oneIn(64)) {
          world.game?.features?.growFungus?.(world, x, y, z, kind, random);
        }
      },
    });
    smallPlant(`${kind}_roots`, {
      mapColor: kind === 'crimson' ? MAP.crimsonNylium : MAP.warpedNylium,
      replaceable: true,
      support: (n) => NYLIUM_LIKE.has(n),
    });
  }

  smallPlant('nether_sprouts', {
    mapColor: MAP.warpedNylium,
    replaceable: true,
    support: (n) => NYLIUM_LIKE.has(n),
  });

  // Weeping vines hang from the ceiling; twisting vines climb from the floor.
  hangingVine('weeping_vines', 'weeping_vines_plant', -1, MAP.red);
  hangingVine('twisting_vines', 'twisting_vines_plant', 1, MAP.warpedNylium);

  cube('nether_wart_block', 'nether_wart_block', mat(MAT.wool, {
    hardness: 1, blastResistance: 1, tool: TOOL.HOE, sound: SOUND.WET_GRASS,
    mapColor: MAP.red, flammable: 0, burnTime: 0, creativeTab: 'natural',
  }));
  cube('warped_wart_block', 'warped_wart_block', mat(MAT.wool, {
    hardness: 1, blastResistance: 1, tool: TOOL.HOE, sound: SOUND.WET_GRASS,
    mapColor: MAP.warpedWartBlock, flammable: 0, burnTime: 0, creativeTab: 'natural',
  }));
  cube('shroomlight', 'shroomlight', mat(MAT.wool, {
    hardness: 1, blastResistance: 1, tool: TOOL.HOE, sound: SOUND.WET_GRASS,
    mapColor: MAP.orange, light: 15, emissive: 15, flammable: 0, burnTime: 0,
    creativeTab: 'natural',
  }));
}

/** A vine that extends one block at a time along `dir` (+1 up, -1 down). */
function hangingVine(tipName, bodyName, dir, color) {
  crossBlock(tipName, tipName, mat(MAT.plant, {
    properties: [PROP.age25],
    defaultState: { age: 0 },
    mapColor: color,
    climbable: true,
    randomTick: true,
    flammable: 0,
    burnTime: 0,
    creativeTab: 'natural',
    canSurvive(world, x, y, z, state) {
      const anchor = world.getBlock(x, y - dir, z);
      const ad = blockOf(anchor);
      if (ad && (ad.name === bodyName || ad.name === tipName)) return true;
      return T.solid[anchor] === 1;
    },
    onRandomTick(world, x, y, z, state, random) {
      const age = getProp(state, 'age');
      if (age >= 25 || !random.chance(0.1)) return;
      if (world.getBlock(x, y + dir, z) !== 0) return;
      world.setBlock(x, y, z, st(bodyName));
      world.setBlock(x, y + dir, z, withProp(state, 'age', age + 1));
    },
  }));
  crossBlock(bodyName, bodyName, mat(MAT.plant, {
    mapColor: color,
    climbable: true,
    flammable: 0,
    burnTime: 0,
    item: tipName,
    creativeTab: HIDDEN,
    canSurvive(world, x, y, z, state) {
      const anchor = world.getBlock(x, y - dir, z);
      const ad = blockOf(anchor);
      if (ad && (ad.name === bodyName || ad.name === tipName)) return true;
      return T.solid[anchor] === 1;
    },
  }));
}

// ---------------------------------------------------------------------------
// Lush cave flora
// ---------------------------------------------------------------------------

function registerCaveFlora() {
  cube('moss_block', 'moss_block', mat(MAT.plant, {
    hardness: 0.1, blastResistance: 0.1, tool: TOOL.HOE, sound: SOUND.GRASS,
    mapColor: MAP.green, flammable: 0, burnTime: 0, creativeTab: 'natural',
  }));
  def('moss_carpet', mat(MAT.plant, {
    render: RENDER.MODEL,
    hardness: 0.1,
    blastResistance: 0.1,
    tool: TOOL.HOE,
    sound: SOUND.GRASS,
    mapColor: MAP.green,
    solid: false,
    opaque: false,
    flammable: 0,
    burnTime: 0,
    creativeTab: 'natural',
    textures: 'moss_block',
    model: () => boxesToModel(SHAPE.carpet, 'moss_block'),
    collision: () => SHAPE.carpet,
    canSurvive: (world, x, y, z) => world.getBlock(x, y - 1, z) !== 0,
  }), { noConnect: true });

  for (const flowering of [false, true]) {
    const p = flowering ? 'flowering_' : '';
    cube(`${p}azalea_leaves`, `${p}azalea_leaves`, mat(MAT.leaves, {
      properties: [PROP.distance, PROP.persistent, PROP.waterlogged],
      defaultState: { distance: 7, persistent: false, waterlogged: false },
      pass: PASS.CUTOUT,
      opaque: false,
      lightFilter: 1,
      mapColor: flowering ? MAP.pink : MAP.plant,
      creativeTab: 'natural',
    }));
    // The azalea bush itself is a small two-part model rather than a cross.
    def(`${p}azalea`, mat(MAT.plant, {
      render: RENDER.MODEL,
      pass: PASS.CUTOUT,
      hardness: 0,
      blastResistance: 0,
      sound: SOUND.GRASS,
      mapColor: flowering ? MAP.pink : MAP.plant,
      solid: false,
      opaque: false,
      push: PUSH.DESTROY,
      randomTick: true,
      creativeTab: 'natural',
      textures: {
        top: `${p}azalea_top`, side: `${p}azalea_side`, bottom: 'azalea_plant',
      },
      model: () => boxesToModel([new AABB(0, 0, 0, 1, 1, 1)], {
        top: `${p}azalea_top`, side: `${p}azalea_side`, bottom: 'azalea_plant',
      }),
      collision: () => SHAPE.NONE,
      selection: () => SHAPE.FULL,
      canSurvive: (world, x, y, z) => plantableBelow(world, x, y, z) ||
        world.getBlockName(x, y - 1, z) === 'clay',
      onRandomTick(world, x, y, z, state, random) {
        if (random.oneIn(7)) {
          world.game?.features?.growTree?.(world, x, y, z, 'azalea', random);
        }
      },
    }), { isPlant: true, noConnect: true });
  }

  def('spore_blossom', mat(MAT.plant, {
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    mapColor: MAP.pink,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    flammable: 0,
    burnTime: 0,
    creativeTab: 'natural',
    textures: 'spore_blossom',
    model: () => boxesToModel([new AABB(2 / 16, 14 / 16, 2 / 16, 14 / 16, 1, 14 / 16)],
      'spore_blossom'),
    collision: () => SHAPE.NONE,
    selection: () => [new AABB(2 / 16, 13 / 16, 2 / 16, 14 / 16, 1, 14 / 16)],
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y + 1, z)] === 1,
  }), { isPlant: true, noConnect: true });

  crossBlock('hanging_roots', 'hanging_roots', mat(MAT.plant, {
    properties: [PROP.waterlogged],
    defaultState: { waterlogged: false },
    mapColor: MAP.dirt,
    sound: SOUND.GRASS,
    flammable: 0,
    burnTime: 0,
    creativeTab: 'natural',
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y + 1, z)] === 1,
  }));

  // Cave vines grow downward and light up once they carry glow berries.
  const caveVines = crossBlock('cave_vines', 'cave_vines', mat(MAT.plant, {
    properties: [PROP.age25, PROP.berries],
    defaultState: { age: 0, berries: false },
    mapColor: MAP.green,
    randomTick: true,
    flammable: 0,
    burnTime: 0,
    creativeTab: 'natural',
    textures: (state) => (getProp(state, 'berries') ? 'cave_vines_lit' : 'cave_vines'),
    canSurvive: (world, x, y, z) => {
      const above = world.getBlockName(x, y + 1, z);
      return above === 'cave_vines_plant' || above === 'cave_vines' ||
        T.solid[world.getBlock(x, y + 1, z)] === 1;
    },
    onUse(world, x, y, z, state) {
      if (!getProp(state, 'berries')) return false;
      world.setBlock(x, y, z, withProp(state, 'berries', false));
      world.game?.drops?.spawnItem?.(world, x, y, z, 'glow_berries', 1);
      return true;
    },
    onRandomTick(world, x, y, z, state, random) {
      const age = getProp(state, 'age');
      if (age >= 25 || !random.chance(0.11)) return;
      if (world.getBlock(x, y - 1, z) !== 0) return;
      world.setBlock(x, y, z, stateOf(getBlock('cave_vines_plant'),
        { berries: getProp(state, 'berries') }));
      world.setBlock(x, y - 1, z, stateOf(getBlock('cave_vines'),
        { age: age + 1, berries: random.chance(0.11) }));
    },
  }));
  stateLight(caveVines, (state) => (getProp(state, 'berries') ? 14 : 0));

  const caveVinesPlant = crossBlock('cave_vines_plant', 'cave_vines_plant', mat(MAT.plant, {
    properties: [PROP.berries],
    defaultState: { berries: false },
    mapColor: MAP.green,
    flammable: 0,
    burnTime: 0,
    item: 'glow_berries',
    creativeTab: HIDDEN,
    textures: (state) => (getProp(state, 'berries') ? 'cave_vines_plant_lit' : 'cave_vines_plant'),
    canSurvive: (world, x, y, z) => {
      const above = world.getBlockName(x, y + 1, z);
      return above === 'cave_vines_plant' || above === 'cave_vines' ||
        T.solid[world.getBlock(x, y + 1, z)] === 1;
    },
    onUse(world, x, y, z, state) {
      if (!getProp(state, 'berries')) return false;
      world.setBlock(x, y, z, withProp(state, 'berries', false));
      world.game?.drops?.spawnItem?.(world, x, y, z, 'glow_berries', 1);
      return true;
    },
  }));
  stateLight(caveVinesPlant, (state) => (getProp(state, 'berries') ? 14 : 0));

  registerDripleaf();
}

function registerDripleaf() {
  const big = def('big_dripleaf', mat(MAT.plant, {
    properties: [PROP.facing, PROP.tilt, PROP.waterlogged],
    defaultState: { facing: 'north', tilt: 'none', waterlogged: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0.1,
    blastResistance: 0.1,
    sound: SOUND.GRASS,
    mapColor: MAP.plant,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    flammable: 0,
    burnTime: 0,
    creativeTab: 'natural',
    textures: { top: 'big_dripleaf_top', side: 'big_dripleaf_side' },
    model: (state) => boxesToModel(bigDripleafBoxes(state),
      { top: 'big_dripleaf_top', side: 'big_dripleaf_side' }),
    // A tilted leaf drops whatever stands on it, so its collision disappears.
    collision: (state) => (getProp(state, 'tilt') === 'full' ? SHAPE.NONE
      : bigDripleafBoxes(state)),
    canSurvive: (world, x, y, z) => {
      const below = world.getBlockName(x, y - 1, z);
      return below === 'big_dripleaf_stem' || below === 'big_dripleaf' ||
        T.solid[world.getBlock(x, y - 1, z)] === 1;
    },
    onEntityInside(world, x, y, z, state, entity) {
      if (getProp(state, 'tilt') !== 'none') return;
      world.setBlock(x, y, z, withProp(state, 'tilt', 'unstable'));
      world.scheduleTick(x, y, z, blockOf(state), 10);
    },
    onScheduledTick(world, x, y, z, state) {
      const tilt = getProp(state, 'tilt');
      const next = tilt === 'unstable' ? 'partial' : tilt === 'partial' ? 'full' : 'none';
      world.setBlock(x, y, z, withProp(state, 'tilt', next));
      if (next !== 'none') world.scheduleTick(x, y, z, blockOf(state), next === 'full' ? 100 : 10);
    },
  }), { isPlant: true, noConnect: true });
  big.stateForPlacement = (world, x, y, z, ctx) => stateOf(big, {
    facing: DIRS[faceFacing(ctx)], tilt: 'none', waterlogged: isWaterAt(world, x, y, z),
  });

  def('big_dripleaf_stem', mat(MAT.plant, {
    properties: [PROP.facing, PROP.waterlogged],
    defaultState: { facing: 'north', waterlogged: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0.1,
    blastResistance: 0.1,
    sound: SOUND.GRASS,
    mapColor: MAP.plant,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    item: 'big_dripleaf',
    creativeTab: HIDDEN,
    textures: 'big_dripleaf_stem',
    model: () => boxesToModel([new AABB(5 / 16, 0, 5 / 16, 11 / 16, 1, 11 / 16)],
      'big_dripleaf_stem'),
    collision: () => SHAPE.NONE,
    selection: () => [new AABB(5 / 16, 0, 5 / 16, 11 / 16, 1, 11 / 16)],
    canSurvive: (world, x, y, z) => {
      const above = world.getBlockName(x, y + 1, z);
      return above === 'big_dripleaf' || above === 'big_dripleaf_stem';
    },
  }), { isPlant: true, noConnect: true });

  const small = def('small_dripleaf', mat(MAT.plant, {
    properties: [PROP.facing, PROP.half, PROP.waterlogged],
    defaultState: { facing: 'north', half: 'bottom', waterlogged: false },
    render: RENDER.CROSS,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.GRASS,
    mapColor: MAP.plant,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    creativeTab: 'natural',
    textures: (state) => `small_dripleaf_${getProp(state, 'half') === 'top' ? 'top' : 'side'}`,
    model: NO_MODEL,
    collision: () => SHAPE.NONE,
    selection: () => [new AABB(2 / 16, 0, 2 / 16, 14 / 16, 1, 14 / 16)],
    canSurvive(world, x, y, z, state) {
      if (getProp(state, 'half') === 'top') {
        return blockOf(world.getBlock(x, y - 1, z)) === blockOf(state);
      }
      const below = world.getBlockName(x, y - 1, z);
      return below === 'clay' || below === 'moss_block' || PLANTABLE.has(below);
    },
    onBreak(world, x, y, z, state) {
      const oy = getProp(state, 'half') === 'top' ? y - 1 : y + 1;
      if (blockOf(world.getBlock(x, oy, z)) === blockOf(state)) world.setBlock(x, oy, z, 0);
    },
  }), { isPlant: true, isTallPlant: true, noConnect: true });
  small.stateForPlacement = (world, x, y, z, ctx) => stateOf(small, {
    facing: DIRS[faceFacing(ctx)], half: 'bottom', waterlogged: isWaterAt(world, x, y, z),
  });
}

function bigDripleafBoxes(state) {
  const tilt = getProp(state, 'tilt');
  const h = tilt === 'none' ? 15 / 16 : tilt === 'unstable' ? 15 / 16 : 11 / 16;
  return [new AABB(0, h - 1 / 16, 0, 1, h, 1)];
}

// ---------------------------------------------------------------------------
// Cactus, sugar cane, bamboo, berries
// ---------------------------------------------------------------------------

function registerGrowables() {
  def('cactus', {
    properties: [PROP.age15],
    defaultState: { age: 0 },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0.4,
    blastResistance: 0.4,
    sound: SOUND.CLOTH,
    mapColor: MAP.plant,
    solid: false,
    opaque: false,
    randomTick: true,
    push: PUSH.DESTROY,
    creativeTab: 'natural',
    textures: { top: 'cactus_top', bottom: 'cactus_bottom', side: 'cactus_side' },
    model: () => boxesToModel([new AABB(1 / 16, 0, 1 / 16, 15 / 16, 1, 15 / 16)],
      { top: 'cactus_top', bottom: 'cactus_bottom', side: 'cactus_side' }),
    collision: () => SHAPE.cactus,
    canSurvive(world, x, y, z) {
      const below = world.getBlockName(x, y - 1, z);
      if (below !== 'sand' && below !== 'red_sand' && below !== 'cactus') return false;
      // Anything solid touching a cactus side breaks it.
      for (let i = 0; i < 4; i++) {
        const d = HORIZONTAL[i];
        const ns = world.getBlock(x + d.dx, y, z + d.dz);
        if (T.solid[ns] === 1 || T.fluid[ns] !== 0) return false;
      }
      return true;
    },
    onEntityInside(world, x, y, z, state, entity) {
      world.game?.damage?.onCactusContact?.(world, entity, x, y, z);
    },
    onRandomTick: growColumn('cactus', 3),
  }, { noConnect: true });

  def('sugar_cane', {
    properties: [PROP.age15],
    defaultState: { age: 0 },
    render: RENDER.CROSS,
    pass: PASS.CUTOUT,
    tint: TINT.GRASS,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.GRASS,
    mapColor: MAP.plant,
    solid: false,
    opaque: false,
    randomTick: true,
    push: PUSH.DESTROY,
    creativeTab: 'natural',
    textures: 'sugar_cane',
    model: NO_MODEL,
    collision: () => SHAPE.NONE,
    selection: () => [new AABB(2 / 16, 0, 2 / 16, 14 / 16, 1, 14 / 16)],
    canSurvive(world, x, y, z) {
      const below = world.getBlockName(x, y - 1, z);
      if (below === 'sugar_cane') return true;
      if (!SUGAR_CANE_BASE.has(below)) return false;
      for (let i = 0; i < 4; i++) {
        const d = HORIZONTAL[i];
        const s = world.getBlock(x + d.dx, y - 1, z + d.dz);
        if (T.fluid[s] === 1) return true;
        if (world.getBlockName(x + d.dx, y - 1, z + d.dz) === 'frosted_ice') return true;
      }
      return false;
    },
    onRandomTick: growColumn('sugar_cane', 3),
  }, { noConnect: true });

  def('bamboo', {
    properties: [XP.age1, PROP.leaves, PROP.stage],
    defaultState: { age: 0, leaves: 'none', stage: 0 },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 1,
    blastResistance: 1,
    tool: TOOL.AXE,
    sound: SOUND.WOOD,
    mapColor: MAP.plant,
    solid: false,
    opaque: false,
    randomTick: true,
    push: PUSH.DESTROY,
    flammable: 5,
    burnTime: 5,
    fuelTicks: 50,
    creativeTab: 'natural',
    textures: (state) => (getProp(state, 'age') === 0 ? 'bamboo_stalk' : 'bamboo_stalk'),
    model: (state) => {
      const w = getProp(state, 'age') === 0 ? 2 / 16 : 2.5 / 16;
      return boxesToModel([new AABB(0.5 - w, 0, 0.5 - w, 0.5 + w, 1, 0.5 + w)], 'bamboo_stalk');
    },
    collision: () => [new AABB(6.5 / 16, 0, 6.5 / 16, 9.5 / 16, 1, 9.5 / 16)],
    canSurvive(world, x, y, z) {
      const below = world.getBlockName(x, y - 1, z);
      return below === 'bamboo' || below === 'bamboo_sapling' ||
        PLANTABLE.has(below) || below === 'sand' || below === 'red_sand' ||
        below === 'gravel';
    },
    onRandomTick(world, x, y, z, state, random) {
      if (getProp(state, 'stage') !== 0) return;
      if (!random.chance(0.12)) return;
      let height = 1;
      while (world.getBlockName(x, y - height, z) === 'bamboo') height++;
      if (height >= 16) return;
      if (world.getBlock(x, y + 1, z) !== 0) return;
      world.setBlock(x, y + 1, z, stateOf(getBlock('bamboo'),
        { age: height > 3 ? 1 : 0, leaves: 'small', stage: 0 }));
    },
  }, { noConnect: true });

  crossBlock('bamboo_sapling', 'bamboo_stage0', mat(MAT.plant, {
    hardness: 1,
    tool: TOOL.AXE,
    sound: SOUND.WOOD,
    mapColor: MAP.plant,
    randomTick: true,
    item: 'bamboo',
    creativeTab: HIDDEN,
    canSurvive: (world, x, y, z) => {
      const below = world.getBlockName(x, y - 1, z);
      return PLANTABLE.has(below) || below === 'sand' || below === 'red_sand' ||
        below === 'gravel';
    },
    onRandomTick(world, x, y, z, state, random) {
      if (!random.chance(0.12)) return;
      if (world.getBlock(x, y + 1, z) !== 0) return;
      world.setBlock(x, y, z, st('bamboo'));
      world.setBlock(x, y + 1, z, st('bamboo'));
    },
  }));

  crossBlock('sweet_berry_bush', (state) => `sweet_berry_bush_stage${getProp(state, 'age')}`,
    mat(MAT.plant, {
      properties: [PROP.age3],
      defaultState: { age: 0 },
      mapColor: MAP.green,
      randomTick: true,
      speedFactor: 0.8,
      creativeTab: 'natural',
      canSurvive: (world, x, y, z) => plantableBelow(world, x, y, z),
      drops: (world, x, y, z, state, tool, random) => {
        const age = getProp(state, 'age');
        if (age < 2) return [{ item: 'sweet_berries', count: 1 }];
        return [{ item: 'sweet_berries', count: (random ? random.intRange(1, 2) : 1) + (age === 3 ? 1 : 0) }];
      },
      onUse(world, x, y, z, state) {
        const age = getProp(state, 'age');
        if (age < 2) return false;
        world.setBlock(x, y, z, withProp(state, 'age', 1));
        world.game?.drops?.spawnItem?.(world, x, y, z, 'sweet_berries', age === 3 ? 3 : 1);
        return true;
      },
      onEntityInside(world, x, y, z, state, entity) {
        world.game?.damage?.onBerryBush?.(world, entity, x, y, z);
      },
      onRandomTick(world, x, y, z, state, random) {
        const age = getProp(state, 'age');
        if (age >= 3 || world.getLight(x, y + 1, z) < 9) return;
        if (random.chance(0.2)) world.setBlock(x, y, z, withProp(state, 'age', age + 1));
      },
    }));
}

/** Cactus / sugar cane growth: extend upward until `maxHeight` is reached. */
function growColumn(name, maxHeight) {
  return function (world, x, y, z, state, random) {
    if (world.getBlock(x, y + 1, z) !== 0) return;
    let height = 1;
    while (world.getBlockName(x, y - height, z) === name) height++;
    if (height >= maxHeight) return;
    const age = getProp(state, 'age');
    if (age < 15) { world.setBlock(x, y, z, withProp(state, 'age', age + 1)); return; }
    world.setBlock(x, y, z, withProp(state, 'age', 0));
    world.setBlock(x, y + 1, z, st(name));
  };
}

// ---------------------------------------------------------------------------
// Crops
// ---------------------------------------------------------------------------

/** Farmland-backed crop with an `age` property and stage textures. */
function cropBlock(name, ageProp, o = {}) {
  const maxAge = ageProp.count - 1;
  const stages = o.stages || ((age) => `${name}_stage${age}`);
  const b = def(name, {
    properties: [ageProp],
    defaultState: { age: 0 },
    render: RENDER.CROSS,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.GRASS,
    mapColor: MAP.plant,
    solid: false,
    opaque: false,
    randomTick: true,
    push: PUSH.DESTROY,
    creativeTab: 'natural',
    item: o.seed,
    textures: (state) => stages(getProp(state, 'age')),
    model: NO_MODEL,
    collision: () => SHAPE.NONE,
    selection: (state) => [new AABB(0, 0, 0,
      1, Math.max(2, (getProp(state, 'age') + 1) * 2) / 16, 1)],
    canSurvive: (world, x, y, z) => world.getBlockName(x, y - 1, z) === 'farmland',
    drops: (world, x, y, z, state, tool, random) => {
      const age = getProp(state, 'age');
      const out = [];
      if (age >= maxAge) {
        out.push({ item: o.crop, count: o.cropCount ? o.cropCount(random) : 1 });
        if (o.seed && o.seed !== o.crop) {
          out.push({ item: o.seed, count: random ? random.intRange(0, 3) : 1 });
        }
      } else {
        out.push({ item: o.seed || o.crop, count: 1 });
      }
      return out.filter((d) => d.count > 0);
    },
    onRandomTick(world, x, y, z, state, random) {
      const age = getProp(state, 'age');
      if (age >= maxAge) return;
      if (world.getLight(x, y + 1, z) < 9) return;
      // Growth speed scales with how well the surrounding farmland is tended.
      if (random.chance(1 / (Math.floor(25 / cropGrowthBonus(world, x, y, z)) + 1))) {
        world.setBlock(x, y, z, withProp(state, 'age', age + 1));
      }
    },
  }, { isCrop: true, maxAge, noConnect: true });
  return b;
}

/** Vanilla's farmland bonus: hydrated and unbroken rows grow fastest. */
function cropGrowthBonus(world, x, y, z) {
  let total = 1;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const st2 = world.getBlock(x + dx, y - 1, z + dz);
      const d = blockOf(st2);
      if (!d || d.name !== 'farmland') continue;
      let points = getProp(st2, 'moisture') > 0 ? 3 : 1;
      if (dx !== 0 || dz !== 0) points /= 4;
      total += points;
    }
  }
  return total;
}

function registerCrops() {
  cropBlock('wheat', PROP.age7, {
    seed: 'wheat_seeds', crop: 'wheat',
  });
  cropBlock('carrots', PROP.age7, {
    seed: 'carrot', crop: 'carrot',
    cropCount: (r) => (r ? r.intRange(1, 4) : 1),
    stages: (age) => `carrots_stage${Math.min(3, age >> 1)}`,
  });
  cropBlock('potatoes', PROP.age7, {
    seed: 'potato', crop: 'potato',
    cropCount: (r) => (r ? r.intRange(1, 4) : 1),
    stages: (age) => `potatoes_stage${Math.min(3, age >> 1)}`,
  });
  cropBlock('beetroots', PROP.age3, {
    seed: 'beetroot_seeds', crop: 'beetroot',
    stages: (age) => `beetroots_stage${age}`,
  });
  cropBlock('torchflower_crop', XP.age2, {
    seed: 'torchflower_seeds', crop: 'torchflower',
    stages: (age) => `torchflower_crop_stage${age}`,
  });

  for (const gourd of ['melon', 'pumpkin']) {
    stemBlocks(gourd);
  }

  def('nether_wart', {
    properties: [PROP.age3],
    defaultState: { age: 0 },
    render: RENDER.CROSS,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.NETHER,
    mapColor: MAP.red,
    solid: false,
    opaque: false,
    randomTick: true,
    push: PUSH.DESTROY,
    item: 'nether_wart',
    creativeTab: 'natural',
    textures: (state) => `nether_wart_stage${Math.min(2, getProp(state, 'age'))}`,
    model: NO_MODEL,
    collision: () => SHAPE.NONE,
    selection: () => [new AABB(0, 0, 0, 1, 5 / 16, 1)],
    canSurvive: (world, x, y, z) => world.getBlockName(x, y - 1, z) === 'soul_sand',
    drops: (world, x, y, z, state, tool, random) => {
      const age = getProp(state, 'age');
      return [{ item: 'nether_wart', count: age >= 3 ? (random ? random.intRange(2, 4) : 2) : 1 }];
    },
    onRandomTick(world, x, y, z, state, random) {
      const age = getProp(state, 'age');
      if (age < 3 && random.oneIn(10)) world.setBlock(x, y, z, withProp(state, 'age', age + 1));
    },
  }, { isCrop: true, noConnect: true });

  // Cocoa grows on the side of a jungle log.
  const cocoa = def('cocoa', {
    properties: [PROP.facing, XP.age2],
    defaultState: { facing: 'north', age: 0 },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0.2,
    blastResistance: 3,
    tool: TOOL.AXE,
    sound: SOUND.WOOD,
    mapColor: MAP.plant,
    solid: false,
    opaque: false,
    randomTick: true,
    push: PUSH.DESTROY,
    item: 'cocoa_beans',
    creativeTab: 'natural',
    textures: (state) => `cocoa_stage${getProp(state, 'age')}`,
    model: (state) => boxesToModel(cocoaBoxes(state), `cocoa_stage${getProp(state, 'age')}`),
    collision: cocoaBoxes,
    canSurvive(world, x, y, z, state) {
      const d = HORIZONTAL[FACING_INDEX[getProp(state, 'facing')]];
      const support = blockOf(world.getBlock(x + d.dx, y, z + d.dz));
      return !!support && support.isLog && support.species === 'jungle';
    },
    drops: (world, x, y, z, state, tool, random) => [{
      item: 'cocoa_beans',
      count: getProp(state, 'age') >= 2 ? (random ? random.intRange(2, 3) : 3) : 1,
    }],
    onRandomTick(world, x, y, z, state, random) {
      const age = getProp(state, 'age');
      if (age < 2 && random.oneIn(5)) world.setBlock(x, y, z, withProp(state, 'age', age + 1));
    },
  }, { isCrop: true, noConnect: true });
  cocoa.stateForPlacement = (world, x, y, z, ctx) =>
    stateOf(cocoa, { facing: DIRS[faceFacing(ctx)], age: 0 });
}

function cocoaBoxes(state) {
  const age = getProp(state, 'age');
  const size = 4 + age * 2;            // 4, 6, 8 wide
  const h = 5 + age * 2;
  const f = FACING_INDEX[getProp(state, 'facing')];
  const half = size / 32;
  const depth = (size + 1) / 16;
  const top = 12 / 16, bottom = (12 - h) / 16;
  switch (f) {
    case 0: return [new AABB(0.5 - half, bottom, 1 - depth, 0.5 + half, top, 1)];
    case 1: return [new AABB(0, bottom, 0.5 - half, depth, top, 0.5 + half)];
    case 2: return [new AABB(0.5 - half, bottom, 0, 0.5 + half, top, depth)];
    default: return [new AABB(1 - depth, bottom, 0.5 - half, 1, top, 0.5 + half)];
  }
}

/** Melon and pumpkin stems, plus their attached form. */
function stemBlocks(gourd) {
  const stem = def(`${gourd}_stem`, {
    properties: [PROP.age7],
    defaultState: { age: 0 },
    render: RENDER.CROSS,
    pass: PASS.CUTOUT,
    tint: TINT.STEM,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.WOOD,
    mapColor: MAP.plant,
    solid: false,
    opaque: false,
    randomTick: true,
    push: PUSH.DESTROY,
    item: `${gourd}_seeds`,
    creativeTab: 'natural',
    textures: () => `${gourd}_stem`,
    model: NO_MODEL,
    collision: () => SHAPE.NONE,
    selection: (state) => [new AABB(7 / 16, 0, 7 / 16, 9 / 16,
      (getProp(state, 'age') + 1) * 2 / 16, 9 / 16)],
    canSurvive: (world, x, y, z) => world.getBlockName(x, y - 1, z) === 'farmland',
    drops: (world, x, y, z, state, tool, random) => [{
      item: `${gourd}_seeds`, count: random ? random.intRange(0, 3) : 1,
    }],
    onRandomTick(world, x, y, z, state, random) {
      if (world.getLight(x, y + 1, z) < 9) return;
      const age = getProp(state, 'age');
      if (!random.chance(1 / (Math.floor(25 / cropGrowthBonus(world, x, y, z)) + 1))) return;
      if (age < 7) { world.setBlock(x, y, z, withProp(state, 'age', age + 1)); return; }
      // Fully grown: try to place the fruit on a free adjacent farmland tile.
      const dir = random.int(4);
      const d = HORIZONTAL[dir];
      const fx = x + d.dx, fz = z + d.dz;
      if (world.getBlock(fx, y, fz) !== 0) return;
      const base = world.getBlockName(fx, y - 1, fz);
      if (base !== 'farmland' && !PLANTABLE.has(base)) return;
      world.setBlock(fx, y, fz, st(gourd));
      world.setBlock(x, y, z, stateOf(getBlock(`attached_${gourd}_stem`),
        { facing: DIRS[dir] }));
    },
  }, { isCrop: true, noConnect: true });

  def(`attached_${gourd}_stem`, {
    properties: [PROP.facing],
    defaultState: { facing: 'north' },
    render: RENDER.CROSS,
    pass: PASS.CUTOUT,
    tint: TINT.STEM,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.WOOD,
    mapColor: MAP.plant,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    item: `${gourd}_seeds`,
    creativeTab: HIDDEN,
    textures: () => `attached_${gourd}_stem`,
    model: NO_MODEL,
    collision: () => SHAPE.NONE,
    selection: () => [new AABB(7 / 16, 0, 7 / 16, 9 / 16, 1, 9 / 16)],
    canSurvive: (world, x, y, z) => world.getBlockName(x, y - 1, z) === 'farmland',
    drops: (world, x, y, z, state, tool, random) => [{
      item: `${gourd}_seeds`, count: random ? random.intRange(0, 3) : 1,
    }],
    onNeighborChange(world, x, y, z, state) {
      // Once the fruit is picked the stem detaches and can regrow.
      const d = HORIZONTAL[FACING_INDEX[getProp(state, 'facing')]];
      if (world.getBlockName(x + d.dx, y, z + d.dz) !== gourd) {
        world.setBlock(x, y, z, stateOf(getBlock(`${gourd}_stem`), { age: 7 }));
      }
    },
  }, { isCrop: true, noConnect: true });
  return stem;
}

// ---------------------------------------------------------------------------
// Melons, pumpkins and the blocks made from crops
// ---------------------------------------------------------------------------

function registerGourds() {
  cube('melon', { top: 'melon_top', side: 'melon_side' }, mat(MAT.wood, {
    hardness: 1, blastResistance: 1, tool: TOOL.AXE, mapColor: MAP.lightGreen,
    flammable: 0, burnTime: 0, fuelTicks: 0, creativeTab: 'natural',
    drops: oreDrop('melon_slice', 3, 7),
  }));
  cube('pumpkin', { top: 'pumpkin_top', side: 'pumpkin_side' }, mat(MAT.wood, {
    hardness: 1, blastResistance: 1, tool: TOOL.AXE, mapColor: MAP.orange,
    flammable: 0, burnTime: 0, fuelTicks: 0, creativeTab: 'natural',
  }));

  for (const [name, light] of [['carved_pumpkin', 0], ['jack_o_lantern', 15]]) {
    const b = def(name, mat(MAT.wood, {
      properties: [PROP.facing],
      defaultState: { facing: 'north' },
      hardness: 1,
      blastResistance: 1,
      tool: TOOL.AXE,
      mapColor: MAP.orange,
      light,
      emissive: light,
      flammable: 0,
      burnTime: 0,
      fuelTicks: 0,
      creativeTab: 'natural',
      textures: (state) => {
        const f = FACING_INDEX[getProp(state, 'facing')];
        const tex = ['pumpkin_side', 'pumpkin_side', 'pumpkin_top', 'pumpkin_top',
          'pumpkin_side', 'pumpkin_side'];
        tex[[4, 1, 5, 0][f]] = name;
        return tex;
      },
    }), { noConnect: true, wearable: name === 'carved_pumpkin' });
    b.stateForPlacement = (world, x, y, z, ctx) =>
      stateOf(b, { facing: DIRS[faceFacing(ctx)] });
  }

  axisPlacement(pillar('hay_block', 'hay_block_side', 'hay_block_top', mat(MAT.plant, {
    hardness: 0.5, blastResistance: 0.5, tool: TOOL.HOE, sound: SOUND.GRASS,
    mapColor: MAP.yellow, flammable: 60, burnTime: 20, creativeTab: 'natural',
  })));
  cube('dried_kelp_block', {
    top: 'dried_kelp_top', bottom: 'dried_kelp_bottom', side: 'dried_kelp_side',
  }, mat(MAT.plant, {
    hardness: 0.5, blastResistance: 2.5, tool: TOOL.HOE, sound: SOUND.GRASS,
    mapColor: MAP.green, flammable: 30, burnTime: 60, fuelTicks: 4000,
    creativeTab: 'natural',
  }));
  cube('sponge', 'sponge', mat(MAT.plant, {
    hardness: 0.6, blastResistance: 0.6, tool: TOOL.HOE, sound: SOUND.GRASS,
    mapColor: MAP.yellow, flammable: 0, burnTime: 0, creativeTab: 'building',
    onPlace(world, x, y, z) {
      world.game?.fluids?.absorb?.(world, x, y, z);
    },
  }));
  cube('wet_sponge', 'wet_sponge', mat(MAT.plant, {
    hardness: 0.6, blastResistance: 0.6, tool: TOOL.HOE, sound: SOUND.GRASS,
    mapColor: MAP.yellow, flammable: 0, burnTime: 0, creativeTab: 'building',
  }));
}

// ---------------------------------------------------------------------------
// Flower pots
// ---------------------------------------------------------------------------

/** Plants that have a potted variant, in registration order. */
const POTTABLE = [
  'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'mangrove_propagule',
  'fern', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'wither_rose', 'torchflower',
  'red_mushroom', 'brown_mushroom', 'dead_bush', 'cactus', 'bamboo',
  'crimson_fungus', 'warped_fungus', 'crimson_roots', 'warped_roots',
  'azalea_bush', 'flowering_azalea_bush',
];

function registerFlowerPots() {
  const potMat = {
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.STONE,
    mapColor: MAP.red,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    creativeTab: 'decorations',
    collision: () => SHAPE.NONE,
    selection: () => SHAPE.flowerPot,
  };

  def('flower_pot', Object.assign({}, potMat, {
    textures: 'flower_pot',
    model: () => boxesToModel(SHAPE.flowerPot, 'flower_pot'),
    onUse(world, x, y, z, state, player, hand, hit) {
      // Potting is driven by the held item; the block just reports readiness.
      return !!world.game?.ui?.potPlant?.(world, x, y, z, player);
    },
  }), { isFlowerPot: true, noConnect: true });

  for (const plant of POTTABLE) {
    // Vanilla names the potted azaleas without the "_bush" suffix on the plant.
    const source = plant === 'azalea_bush' ? 'azalea'
      : plant === 'flowering_azalea_bush' ? 'flowering_azalea' : plant;
    const name = `potted_${plant}`;
    def(name, Object.assign({}, potMat, {
      textures: 'flower_pot',
      item: 'flower_pot',
      creativeTab: HIDDEN,
      model: () => boxesToModel(SHAPE.flowerPot, 'flower_pot'),
      drops: () => [{ item: 'flower_pot', count: 1 }, { item: source, count: 1 }],
      onUse(world, x, y, z) {
        world.setBlock(x, y, z, st('flower_pot'));
        world.game?.drops?.spawnItem?.(world, x, y, z, source, 1);
        return true;
      },
    }), { isFlowerPot: true, noConnect: true, pottedPlant: source });
    POTTED[source] = name;
  }
}
