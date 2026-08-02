// Wood sets.
//
// One species produces ~16 blocks. The overworld trees and the nether fungi
// differ only in naming (log/wood vs stem/hyphae), whether leaves exist and
// whether the wood burns, so a single factory covers both.

import {
  def, cube, pillar, axisPlacement, MAT, mat, boxesToModel, stairsBlock,
  slabBlock, fenceBlock, fenceGateBlock, doorBlock, trapdoorBlock,
  buttonBlock, pressurePlateBlock, crossBlock, faceFacing, isWaterAt, PROP,
  getProp, withProp, stateOf, blockOf, RENDER, PASS, TINT, SOUND, TOOL, T,
  SHAPE, HIDDEN,
} from './helpers.js';
import { WOOD_TYPES, MAP, STRIPPED, DIRS, FACING_INDEX, PLANTABLE } from './data.js';
import { AABB, HORIZONTAL, FACES } from '../../core/math.js';

export function registerWood() {
  for (const w of WOOD_TYPES) woodSet(w);
  registerMangroveRoots();
}

/** Every block belonging to one species. */
function woodSet(w) {
  const nether = w.kind === 'stem';
  const logName = `${w.name}_${w.log}`;          // oak_log / crimson_stem
  const woodName = `${w.name}_${w.wood}`;        // oak_wood / crimson_hyphae
  const planks = `${w.name}_planks`;

  const woodMat = nether
    ? mat(MAT.netherWood, { mapColor: w.plankMap, flammable: 0, burnTime: 0, fuelTicks: 0 })
    : mat(MAT.wood, { mapColor: w.plankMap });
  const logMat = nether
    ? mat(MAT.netherWood, { hardness: 2, blastResistance: 2, mapColor: w.barkMap, flammable: 0, burnTime: 0, fuelTicks: 0 })
    : mat(MAT.log, { mapColor: w.barkMap });

  cube(planks, planks, woodMat);

  // Logs and stems: bark on the sides, rings on the ends.
  const logExtra = { extra: { isLog: true, species: w.name } };
  axisPlacement(pillar(logName, logName, `${logName}_top`, mat(logMat, logExtra)));
  axisPlacement(pillar(`stripped_${logName}`, `stripped_${logName}`,
    `stripped_${logName}_top`, mat(logMat, { mapColor: w.plankMap, ...logExtra })));
  // "Wood"/"hyphae" is the same log with bark on all six faces.
  axisPlacement(pillar(woodName, logName, logName, mat(logMat, logExtra)));
  axisPlacement(pillar(`stripped_${woodName}`, `stripped_${logName}`,
    `stripped_${logName}`, mat(logMat, { mapColor: w.plankMap, ...logExtra })));

  STRIPPED[logName] = `stripped_${logName}`;
  STRIPPED[woodName] = `stripped_${woodName}`;

  if (!nether) {
    leavesBlock(w);
    saplingBlock(w);
  }

  stairsBlock(`${w.name}_stairs`, planks, mat(woodMat, { family: w.name }));
  slabBlock(`${w.name}_slab`, planks,
    mat(woodMat, { family: w.name, fuelTicks: nether ? 0 : 150 }));
  // All wooden fences share one connection group; nether brick fence does not.
  fenceBlock(`${w.name}_fence`, planks,
    mat(woodMat, { family: w.name, fenceGroup: 'wood', fuelTicks: nether ? 0 : 300 }));
  fenceGateBlock(`${w.name}_fence_gate`, planks,
    mat(woodMat, { family: w.name, fuelTicks: nether ? 0 : 300 }));

  doorBlock(`${w.name}_door`, mat(woodMat, {
    family: w.name, hardness: 3, blastResistance: 3, fuelTicks: nether ? 0 : 200,
  }));
  trapdoorBlock(`${w.name}_trapdoor`, `${w.name}_trapdoor`, mat(woodMat, {
    family: w.name, hardness: 3, blastResistance: 3, fuelTicks: nether ? 0 : 300,
  }));
  buttonBlock(`${w.name}_button`, planks, mat(woodMat, {
    family: w.name, wooden: true, hardness: 0.5, blastResistance: 0.5,
    fuelTicks: nether ? 0 : 100,
  }));
  pressurePlateBlock(`${w.name}_pressure_plate`, planks, mat(woodMat, {
    family: w.name, hardness: 0.5, blastResistance: 0.5, weighted: 'entities',
    fuelTicks: nether ? 0 : 300,
  }));
  signBlocks(w.name, planks, mat(woodMat, { family: w.name, fuelTicks: nether ? 0 : 200 }));
}

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

function leavesBlock(w) {
  const name = `${w.name}_leaves`;
  // Spruce, birch and cherry leaves use a fixed colour in vanilla rather than
  // the biome foliage map, so the painter bakes their colour into the texture.
  const tinted = !['spruce', 'birch', 'cherry'].includes(w.name);
  const b = def(name, mat(MAT.leaves, {
    properties: [PROP.distance, PROP.persistent, PROP.waterlogged],
    defaultState: { distance: 7, persistent: false, waterlogged: false },
    render: RENDER.CUBE,
    pass: PASS.CUTOUT,
    opaque: false,
    lightFilter: 1,
    tint: tinted ? TINT.FOLIAGE : TINT.NONE,
    mapColor: w.leafMap,
    randomTick: true,
    textures: name,
    creativeTab: 'natural',
    drops: leafDrops(w),
    onRandomTick(world, x, y, z, state) {
      if (getProp(state, 'persistent')) return;
      if (getProp(state, 'distance') < 7) return;
      world.destroyBlock(x, y, z, true);
    },
    updateShape(world, x, y, z, state) {
      if (getProp(state, 'persistent')) return state;
      const d = leafDistance(world, x, y, z);
      return withProp(state, 'distance', d);
    },
  }), { isLeaves: true, noConnect: true, species: w.name });
  return b;
}

/** Shortest hop count to a log, capped at 7 (7 means "will decay"). */
function leafDistance(world, x, y, z) {
  let best = 7;
  for (let i = 0; i < 6; i++) {
    const d = FACES[i];
    const ns = world.getBlock(x + d.dx, y + d.dy, z + d.dz);
    const nd = blockOf(ns);
    if (!nd) continue;
    if (nd.isLog) return 1;
    if (nd.isLeaves) best = Math.min(best, getProp(ns, 'distance') + 1);
  }
  return Math.min(best, 7);
}

function leafDrops(w) {
  const apple = w.name === 'oak' || w.name === 'dark_oak';
  return function (world, x, y, z, state, tool, random) {
    const item = tool && tool.item;
    if (item && (item.tool === TOOL.SHEARS || (tool.getEnchantLevel &&
      tool.getEnchantLevel('silk_touch') > 0))) {
      return [{ item: `${w.name}_leaves`, count: 1 }];
    }
    const out = [];
    const fortune = tool && tool.getEnchantLevel ? tool.getEnchantLevel('fortune') : 0;
    const saplingChance = [0.05, 0.0625, 0.083, 0.1][Math.min(fortune, 3)];
    if (random && random.chance(w.name === 'jungle' ? saplingChance * 0.5 : saplingChance)) {
      out.push({ item: w.sapling, count: 1 });
    }
    if (random && random.chance([0.02, 0.022, 0.025, 0.033][Math.min(fortune, 3)])) {
      out.push({ item: 'stick', count: random.intRange(1, 2) });
    }
    if (apple && random && random.chance([0.005, 0.0055, 0.00625, 0.0083][Math.min(fortune, 3)])) {
      out.push({ item: 'apple', count: 1 });
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Saplings
// ---------------------------------------------------------------------------

function saplingBlock(w) {
  // Mangroves drop a propagule that also hangs from leaves; keep the real id.
  const name = w.sapling;
  const b = crossBlock(name, name, mat(MAT.plant, {
    properties: name === 'mangrove_propagule'
      ? [PROP.age3, PROP.hanging, PROP.stage, PROP.waterlogged]
      : [PROP.stage],
    defaultState: name === 'mangrove_propagule'
      ? { age: 0, hanging: false, stage: 0, waterlogged: false }
      : { stage: 0 },
    mapColor: MAP.plant,
    randomTick: true,
    flammable: 0,
    burnTime: 0,
    creativeTab: 'natural',
    canSurvive(world, x, y, z, state) {
      if (name === 'mangrove_propagule' && getProp(state, 'hanging')) {
        const above = blockOf(world.getBlock(x, y + 1, z));
        return !!above && above.isLeaves;
      }
      return plantableBelow(world, x, y, z);
    },
    onRandomTick(world, x, y, z, state, random) {
      if (world.getLight(x, y + 1, z) < 9) return;
      if (!random.oneIn(7)) return;
      if (getProp(state, 'stage') === 0) {
        world.setBlock(x, y, z, withProp(state, 'stage', 1));
        return;
      }
      // Tree shapes live in the feature generator; ask it politely.
      world.game?.features?.growTree?.(world, x, y, z, w.name, random);
    },
  }), { isSapling: true, species: w.name });
  return b;
}

/** Shared support test for saplings, flowers and small plants. */
export function plantableBelow(world, x, y, z) {
  return PLANTABLE.has(world.getBlockName(x, y - 1, z));
}

// ---------------------------------------------------------------------------
// Signs
// ---------------------------------------------------------------------------

const SIGN_POST = [new AABB(7 / 16, 0, 7 / 16, 9 / 16, 9 / 16, 9 / 16)];

function signBlocks(species, tex, o) {
  const standing = def(`${species}_sign`, mat(o, {
    properties: [PROP.rotation16, PROP.waterlogged],
    defaultState: { rotation: 0, waterlogged: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 1,
    blastResistance: 1,
    solid: false,
    opaque: false,
    hasEntity: true,
    maxStack: 16,
    creativeTab: 'functional',
    // Signs rotate in 22.5° steps, which axis-aligned model boxes cannot
    // express; the board is drawn on the nearest cardinal and the sign's block
    // entity renderer applies the true angle.
    model: (state) => boxesToModel(signBoxes(getProp(state, 'rotation')), tex),
    collision: () => SHAPE.NONE,
    selection: (state) => signBoxes(getProp(state, 'rotation')),
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y - 1, z)] === 1,
    onUse(world, x, y, z, state, player) {
      world.game?.ui?.openSignEditor?.(world, x, y, z, player);
      return true;
    },
  }), { isSign: true, blockEntity: 'sign', species });
  standing.stateForPlacement = (world, x, y, z, ctx) => stateOf(standing, {
    rotation: Math.round(((ctx && ctx.yaw ? ctx.yaw : 0) / (Math.PI * 2)) * 16 + 8) & 15,
    waterlogged: isWaterAt(world, x, y, z),
  });

  const wall = def(`${species}_wall_sign`, mat(o, {
    properties: [PROP.facing, PROP.waterlogged],
    defaultState: { facing: 'north', waterlogged: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 1,
    blastResistance: 1,
    solid: false,
    opaque: false,
    hasEntity: true,
    maxStack: 16,
    item: `${species}_sign`,
    creativeTab: HIDDEN,
    model: (state) => boxesToModel(wallSignBoxes(state), tex),
    collision: () => SHAPE.NONE,
    selection: wallSignBoxes,
    canSurvive(world, x, y, z, state) {
      const d = HORIZONTAL[(FACING_INDEX[getProp(state, 'facing')] + 2) & 3];
      return T.solid[world.getBlock(x + d.dx, y, z + d.dz)] === 1;
    },
    onUse(world, x, y, z, state, player) {
      world.game?.ui?.openSignEditor?.(world, x, y, z, player);
      return true;
    },
  }), { isSign: true, blockEntity: 'sign', species });
  wall.stateForPlacement = (world, x, y, z, ctx) => stateOf(wall, {
    facing: DIRS[faceFacing(ctx)], waterlogged: isWaterAt(world, x, y, z),
  });
  return [standing, wall];
}

function signBoxes(rotation) {
  const boxes = SIGN_POST.slice();
  // Nearest cardinal: 0 = south in vanilla's rotation table.
  const cardinal = Math.round(rotation / 4) & 3;
  boxes.push(cardinal & 1
    ? new AABB(7 / 16, 9 / 16, 0, 9 / 16, 1, 1)
    : new AABB(0, 9 / 16, 7 / 16, 1, 1, 9 / 16));
  return boxes;
}

function wallSignBoxes(state) {
  const f = FACING_INDEX[getProp(state, 'facing')];
  const t = 2 / 16;
  switch (f) {
    case 0: return [new AABB(0, 4 / 16, 1 - t, 1, 12 / 16, 1)];
    case 1: return [new AABB(0, 4 / 16, 0, t, 12 / 16, 1)];
    case 2: return [new AABB(0, 4 / 16, 0, 1, 12 / 16, t)];
    default: return [new AABB(1 - t, 4 / 16, 0, 1, 12 / 16, 1)];
  }
}

// ---------------------------------------------------------------------------
// Mangrove roots — the one wood block that is not part of the standard set.
// ---------------------------------------------------------------------------

function registerMangroveRoots() {
  def('mangrove_roots', mat(MAT.log, {
    properties: [PROP.waterlogged],
    defaultState: { waterlogged: false },
    render: RENDER.CUBE,
    pass: PASS.CUTOUT,
    opaque: false,
    lightFilter: 0,
    hardness: 0.7,
    blastResistance: 0.7,
    sound: SOUND.WET_GRASS,
    mapColor: MAP.wood,
    textures: { side: 'mangrove_roots_side', top: 'mangrove_roots_top' },
    creativeTab: 'natural',
  }), { noConnect: true });
}
