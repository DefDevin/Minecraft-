// Functional blocks: workstations, containers, light sources, portals, sculk
// and the odds and ends that do not belong to any material family.
//
// Blocks that need a screen, a container or an inventory carry `hasEntity` plus
// either a `container` descriptor (storage) or a `menu` id (a workstation UI).
// The UI itself is opened through `world.game?.ui?.…` so this file never has to
// know whether an interface layer exists yet.

import {
  def, cube, MAT, mat, boxesToModel, isWaterAt, silkOnly, fixedDrop, oreDrop,
  stateLight, NO_MODEL, faceFacing, lookFacing, attachStateFor, PROP,
  getProp, withProp, stateOf, blockOf, RENDER, PASS, SOUND, TOOL, TIER, PUSH,
  T, SHAPE, HIDDEN,
} from './helpers.js';
import { getBlock } from '../blocks.js';
import { multifaceBlock } from './plants.js';
import { faceOfFacing6, facing6OfFace } from './redstone.js';
import { XP, MAP, DIRS, FACING_INDEX } from './data.js';
import { AABB, FACES, HORIZONTAL } from '../../core/math.js';

export function registerUtility() {
  registerWorkstations();
  registerContainers();
  registerLights();
  registerDecorations();
  registerSculk();
  registerFireAndPortals();
  registerEndBlocks();
}

/** Cube whose front face follows a horizontal `facing` property. */
function facingCube(name, spec, o = {}) {
  const b = def(name, mat(o, {
    properties: o.properties || [PROP.facing],
    defaultState: Object.assign({ facing: 'north' }, o.defaultState),
    creativeTab: o.creativeTab ?? 'functional',
    textures: (state) => {
      const resolved = typeof spec === 'function' ? spec(state) : spec;
      const side = resolved.side;
      const tex = [side, side, resolved.bottom ?? resolved.top ?? side,
        resolved.top ?? side, side, side];
      const f = [4, 1, 5, 0][FACING_INDEX[getProp(state, 'facing')]];
      tex[f] = resolved.front;
      tex[FACES[f].opposite] = resolved.back ?? side;
      return tex;
    },
  }), o.extra || null);
  b.stateForPlacement = (world, x, y, z, ctx) =>
    stateOf(b, Object.assign({}, o.placementDefaults, { facing: DIRS[faceFacing(ctx)] }));
  return b;
}

// ---------------------------------------------------------------------------
// Workstations
// ---------------------------------------------------------------------------

/** Open a workstation screen; every station shares this handler. */
function openMenu(menu) {
  return function (world, x, y, z, state, player) {
    world.game?.ui?.openMenu?.(menu, world, x, y, z, player);
    return true;
  };
}

function registerWorkstations() {
  cube('crafting_table', {
    top: 'crafting_table_top', bottom: 'oak_planks', side: 'crafting_table_side',
    north: 'crafting_table_front', south: 'crafting_table_front',
  }, mat(MAT.wood, {
    hardness: 2.5, blastResistance: 2.5, creativeTab: 'functional',
    onUse: openMenu('crafting'),
    extra: { menu: 'crafting' },
  }));

  for (const [name, hardness, tex] of [
    ['furnace', 3.5, 'furnace'], ['blast_furnace', 3.5, 'blast_furnace'],
    ['smoker', 3.5, 'smoker'],
  ]) {
    const b = facingCube(name, (state) => ({
      front: getProp(state, 'lit') ? `${tex}_front_on` : `${tex}_front`,
      side: `${tex}_side`,
      top: `${tex}_top`,
      bottom: `${tex}_top`,
    }), mat(MAT.stone, {
      properties: [PROP.facing, PROP.lit],
      defaultState: { facing: 'north', lit: false },
      hardness,
      blastResistance: hardness,
      hasEntity: true,
      container: { slots: 3, type: 'furnace' },
      onUse: openMenu(name),
      extra: { menu: name, blockEntity: 'furnace' },
    }));
    stateLight(b, (state) => (getProp(state, 'lit') ? 13 : 0));
  }

  cube('smithing_table', {
    top: 'smithing_table_top', bottom: 'smithing_table_bottom',
    side: 'smithing_table_side', north: 'smithing_table_front',
    south: 'smithing_table_front',
  }, mat(MAT.wood, {
    hardness: 2.5, blastResistance: 2.5, creativeTab: 'functional',
    onUse: openMenu('smithing'), extra: { menu: 'smithing' },
  }));
  cube('fletching_table', {
    top: 'fletching_table_top', bottom: 'birch_planks', side: 'fletching_table_side',
  }, mat(MAT.wood, {
    hardness: 2.5, blastResistance: 2.5, creativeTab: 'functional',
  }));
  cube('cartography_table', {
    top: 'cartography_table_top', bottom: 'dark_oak_planks',
    side: 'cartography_table_side1',
  }, mat(MAT.wood, {
    hardness: 2.5, blastResistance: 2.5, creativeTab: 'functional',
    onUse: openMenu('cartography'), extra: { menu: 'cartography' },
  }));
  facingCube('loom', {
    front: 'loom_front', side: 'loom_side', top: 'loom_top', bottom: 'oak_planks',
  }, mat(MAT.wood, {
    hardness: 2.5, blastResistance: 2.5,
    onUse: openMenu('loom'), extra: { menu: 'loom' },
  }));

  def('enchanting_table', mat(MAT.stone, {
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 5,
    blastResistance: 1200,
    tier: TIER.WOOD,
    light: 7,
    mapColor: MAP.red,
    solid: false,
    opaque: false,
    hasEntity: true,
    creativeTab: 'functional',
    textures: {
      top: 'enchanting_table_top', bottom: 'enchanting_table_bottom',
      side: 'enchanting_table_side',
    },
    model: () => boxesToModel(SHAPE.enchantingTable, {
      top: 'enchanting_table_top', bottom: 'enchanting_table_bottom',
      side: 'enchanting_table_side',
    }),
    collision: () => SHAPE.enchantingTable,
    onUse: openMenu('enchanting'),
  }), { menu: 'enchanting', blockEntity: 'enchanting_table' });

  // Anvils fall and wear out; all three tiers share one shape.
  for (const [name, damage] of [['anvil', 0], ['chipped_anvil', 1], ['damaged_anvil', 2]]) {
    const b = def(name, mat(MAT.metal, {
      properties: [PROP.facing],
      defaultState: { facing: 'north' },
      render: RENDER.MODEL,
      hardness: 5,
      blastResistance: 1200,
      tier: TIER.WOOD,
      sound: SOUND.ANVIL,
      gravity: true,
      solid: false,
      opaque: false,
      push: PUSH.DESTROY,
      creativeTab: 'functional',
      textures: { top: `${name}_top`, side: 'anvil' },
      model: (state) => boxesToModel(anvilBoxes(state),
        { top: `${name}_top`, side: 'anvil' }),
      collision: anvilBoxes,
      onUse: openMenu('anvil'),
    }), { menu: 'anvil', anvilDamage: damage });
    // The anvil's long axis is perpendicular to the way the player faces.
    b.stateForPlacement = (world, x, y, z, ctx) =>
      stateOf(b, { facing: DIRS[(lookFacing(ctx) + 1) & 3] });
  }

  const grindstone = def('grindstone', mat(MAT.stone, {
    properties: [PROP.attach, PROP.facing],
    defaultState: { face: 'floor', facing: 'north' },
    render: RENDER.MODEL,
    hardness: 2,
    blastResistance: 6,
    solid: false,
    opaque: false,
    creativeTab: 'functional',
    textures: 'grindstone',
    model: () => boxesToModel(SHAPE.grindstone, 'grindstone'),
    collision: () => SHAPE.grindstone,
    onUse: openMenu('grindstone'),
  }), { menu: 'grindstone' });
  grindstone.stateForPlacement = (world, x, y, z, ctx) =>
    stateOf(grindstone, attachStateFor(ctx));

  const stonecutter = def('stonecutter', mat(MAT.stone, {
    properties: [PROP.facing],
    defaultState: { facing: 'north' },
    render: RENDER.MODEL,
    hardness: 3.5,
    blastResistance: 3.5,
    solid: false,
    opaque: false,
    creativeTab: 'functional',
    textures: { top: 'stonecutter_top', side: 'stonecutter_side', bottom: 'stonecutter_bottom' },
    model: () => boxesToModel(SHAPE.stonecutter, {
      top: 'stonecutter_top', side: 'stonecutter_side', bottom: 'stonecutter_bottom',
    }),
    collision: () => SHAPE.stonecutter,
    onUse: openMenu('stonecutter'),
  }), { menu: 'stonecutter' });
  stonecutter.stateForPlacement = (world, x, y, z, ctx) =>
    stateOf(stonecutter, { facing: DIRS[faceFacing(ctx)] });

  const lectern = def('lectern', mat(MAT.wood, {
    properties: [PROP.facing, PROP.hasBook, PROP.powered],
    defaultState: { facing: 'north', has_book: false, powered: false },
    render: RENDER.MODEL,
    hardness: 2.5,
    blastResistance: 2.5,
    solid: false,
    opaque: false,
    hasEntity: true,
    creativeTab: 'functional',
    redstone: { component: true, source: true },
    textures: { top: 'lectern_top', side: 'lectern_sides', bottom: 'oak_planks' },
    model: () => boxesToModel(LECTERN_SHAPE, {
      top: 'lectern_top', side: 'lectern_sides', bottom: 'oak_planks',
    }),
    collision: () => LECTERN_SHAPE,
    onUse(world, x, y, z, state, player) {
      if (!getProp(state, 'has_book')) return false;
      world.game?.ui?.openLectern?.(world, x, y, z, player);
      return true;
    },
  }), { blockEntity: 'lectern' });
  lectern.stateForPlacement = (world, x, y, z, ctx) =>
    stateOf(lectern, { facing: DIRS[faceFacing(ctx)], has_book: false, powered: false });

  def('composter', mat(MAT.wood, {
    properties: [PROP.level8],
    defaultState: { level: 0 },
    render: RENDER.MODEL,
    hardness: 0.6,
    blastResistance: 0.6,
    solid: false,
    opaque: false,
    creativeTab: 'functional',
    redstone: { component: true, source: true },
    textures: {
      top: 'composter_top', side: 'composter_side', bottom: 'composter_bottom',
    },
    model: (state) => {
      const boxes = SHAPE.composter.slice();
      const level = getProp(state, 'level');
      // The compost inside rises with the fill level.
      if (level > 0) boxes.push(new AABB(2 / 16, 3 / 16, 2 / 16, 14 / 16, (3 + level * 1.5) / 16, 14 / 16));
      return boxesToModel(boxes, {
        top: 'composter_top', side: 'composter_side', bottom: 'composter_bottom',
      });
    },
    collision: () => SHAPE.composter,
    onUse(world, x, y, z, state, player, hand) {
      return !!world.game?.crafting?.compost?.(world, x, y, z, state, player, hand);
    },
  }), { noConnect: true });

  def('brewing_stand', mat(MAT.stone, {
    properties: [PROP.hasBottle0, PROP.hasBottle1, PROP.hasBottle2],
    defaultState: { has_bottle_0: false, has_bottle_1: false, has_bottle_2: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0.5,
    blastResistance: 0.5,
    light: 1,
    solid: false,
    opaque: false,
    hasEntity: true,
    container: { slots: 5, type: 'brewing_stand' },
    creativeTab: 'functional',
    textures: { all: 'brewing_stand_base', top: 'brewing_stand' },
    model: () => boxesToModel(SHAPE.brewingStand,
      { all: 'brewing_stand_base', top: 'brewing_stand' }),
    collision: () => SHAPE.brewingStand,
    onUse: openMenu('brewing_stand'),
  }), { menu: 'brewing_stand', blockEntity: 'brewing_stand' });

  registerCauldrons();
}

const LECTERN_SHAPE = [
  new AABB(0, 0, 0, 1, 2 / 16, 1),
  new AABB(4 / 16, 2 / 16, 4 / 16, 12 / 16, 1, 12 / 16),
];

function anvilBoxes(state) {
  const f = FACING_INDEX[getProp(state, 'facing')];
  return (f & 1)
    ? [new AABB(0, 0, 2 / 16, 1, 1, 14 / 16)]
    : [new AABB(2 / 16, 0, 0, 14 / 16, 1, 1)];
}

function registerCauldrons() {
  const base = {
    render: RENDER.MODEL,
    hardness: 2,
    blastResistance: 2,
    tool: TOOL.PICKAXE,
    requiresTool: true,
    sound: SOUND.METAL,
    mapColor: MAP.stone,
    solid: false,
    opaque: false,
    item: 'cauldron',
    creativeTab: 'functional',
    textures: {
      top: 'cauldron_top', bottom: 'cauldron_bottom', side: 'cauldron_side',
    },
    model: () => boxesToModel(SHAPE.cauldron, {
      top: 'cauldron_top', bottom: 'cauldron_bottom', side: 'cauldron_side',
    }),
    collision: () => SHAPE.cauldron,
  };

  def('cauldron', Object.assign({}, base, { creativeTab: 'functional' }),
    { noConnect: true });
  def('water_cauldron', Object.assign({}, base, {
    properties: [XP.level3],
    defaultState: { level: 1 },
    creativeTab: HIDDEN,
    onUse(world, x, y, z, state, player, hand) {
      return !!world.game?.fluids?.useCauldron?.(world, x, y, z, state, player, hand);
    },
  }), { noConnect: true, cauldronContents: 'water' });
  def('lava_cauldron', Object.assign({}, base, {
    light: 15,
    emissive: 15,
    creativeTab: HIDDEN,
    onUse(world, x, y, z, state, player, hand) {
      return !!world.game?.fluids?.useCauldron?.(world, x, y, z, state, player, hand);
    },
  }), { noConnect: true, cauldronContents: 'lava' });
  def('powder_snow_cauldron', Object.assign({}, base, {
    properties: [XP.level3],
    defaultState: { level: 1 },
    creativeTab: HIDDEN,
  }), { noConnect: true, cauldronContents: 'powder_snow' });
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

function registerContainers() {
  for (const name of ['chest', 'trapped_chest']) {
    const b = def(name, mat(MAT.wood, {
      properties: [PROP.facing, PROP.chestType, PROP.waterlogged],
      defaultState: { facing: 'north', type: 'single', waterlogged: false },
      render: RENDER.MODEL,
      pass: PASS.CUTOUT,
      hardness: 2.5,
      blastResistance: 2.5,
      solid: false,
      opaque: false,
      hasEntity: true,
      container: { slots: 27, type: 'chest' },
      creativeTab: 'functional',
      redstone: name === 'trapped_chest' ? { component: true, source: true } : null,
      // The chest body is drawn by its block entity (the lid opens); the model
      // is the plain box so lighting and occlusion still behave.
      textures: 'chest',
      model: () => boxesToModel(SHAPE.chestShape, 'chest'),
      collision: () => SHAPE.chestShape,
      onUse(world, x, y, z, state, player) {
        world.game?.ui?.openContainer?.(world, x, y, z, player);
        return true;
      },
      updateShape: (world, x, y, z, state) => chestPairing(world, x, y, z, state),
    }), { isChest: true, blockEntity: 'chest', noConnect: true });
    b.stateForPlacement = (world, x, y, z, ctx) => chestPairing(world, x, y, z,
      stateOf(b, {
        facing: DIRS[faceFacing(ctx)], type: 'single',
        waterlogged: isWaterAt(world, x, y, z),
      }));
  }

  const ender = def('ender_chest', mat(MAT.stone, {
    properties: [PROP.facing, PROP.waterlogged],
    defaultState: { facing: 'north', waterlogged: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 22.5,
    blastResistance: 600,
    tier: TIER.WOOD,
    light: 7,
    mapColor: MAP.black,
    solid: false,
    opaque: false,
    hasEntity: true,
    container: { slots: 27, type: 'ender_chest' },
    creativeTab: 'functional',
    textures: 'ender_chest',
    model: () => boxesToModel(SHAPE.enderChestShape, 'ender_chest'),
    collision: () => SHAPE.enderChestShape,
    drops: silkOnly(fixedDrop('obsidian', 8)),
    onUse(world, x, y, z, state, player) {
      world.game?.ui?.openEnderChest?.(world, player);
      return true;
    },
  }), { blockEntity: 'ender_chest', noConnect: true });
  ender.stateForPlacement = (world, x, y, z, ctx) => stateOf(ender, {
    facing: DIRS[faceFacing(ctx)], waterlogged: isWaterAt(world, x, y, z),
  });

  const barrel = def('barrel', mat(MAT.wood, {
    properties: [PROP.facingAll, PROP.open],
    defaultState: { facing: 'up', open: false },
    hardness: 2.5,
    blastResistance: 2.5,
    hasEntity: true,
    container: { slots: 27, type: 'barrel' },
    creativeTab: 'functional',
    textures: (state) => {
      const f = faceOfFacing6(getProp(state, 'facing'));
      const tex = ['barrel_side', 'barrel_side', 'barrel_side', 'barrel_side',
        'barrel_side', 'barrel_side'];
      tex[f] = getProp(state, 'open') ? 'barrel_top_open' : 'barrel_top';
      tex[FACES[f].opposite] = 'barrel_bottom';
      return tex;
    },
    onUse(world, x, y, z, state, player) {
      world.game?.ui?.openContainer?.(world, x, y, z, player);
      return true;
    },
  }), { blockEntity: 'barrel' });
  barrel.stateForPlacement = (world, x, y, z, ctx) => stateOf(barrel, {
    facing: facing6OfFace(ctx && ctx.face != null ? ctx.face : 3), open: false,
  });

  const hopper = def('hopper', mat(MAT.metal, {
    properties: [XP.enabled, PROP.facingAll],
    defaultState: { enabled: true, facing: 'down' },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 3,
    blastResistance: 4.8,
    tier: TIER.WOOD,
    solid: false,
    opaque: false,
    hasEntity: true,
    container: { slots: 5, type: 'hopper' },
    creativeTab: 'redstone',
    redstone: { component: true },
    textures: {
      top: 'hopper_top', side: 'hopper_outside', bottom: 'hopper_outside',
    },
    model: () => boxesToModel(SHAPE.hopperShape, {
      top: 'hopper_top', side: 'hopper_outside', bottom: 'hopper_outside',
    }),
    collision: () => SHAPE.hopperShape,
    onUse(world, x, y, z, state, player) {
      world.game?.ui?.openContainer?.(world, x, y, z, player);
      return true;
    },
    onNeighborChange(world, x, y, z, state) {
      const powered = !!world.game?.redstone?.hasSignal?.(world, x, y, z);
      if (powered === getProp(state, 'enabled')) {
        world.setBlock(x, y, z, withProp(state, 'enabled', !powered));
      }
    },
  }), { blockEntity: 'hopper', noConnect: true });
  hopper.stateForPlacement = (world, x, y, z, ctx) => stateOf(hopper, {
    enabled: true,
    // A hopper points at whatever face was clicked, never up.
    facing: (!ctx || ctx.face === 3 || ctx.face === 2) ? 'down'
      : facing6OfFace(FACES[ctx.face].opposite),
  });

  // A jukebox holds exactly one record and reports it to comparators.
  def('jukebox', mat(MAT.wood, {
    properties: [PROP.hasRecord],
    defaultState: { has_record: false },
    hardness: 2,
    blastResistance: 6,
    hasEntity: true,
    container: { slots: 1, type: 'jukebox' },
    creativeTab: 'functional',
    redstone: { component: true },
    textures: { top: 'jukebox_top', side: 'jukebox_side', bottom: 'jukebox_side' },
    onUse(world, x, y, z, state, player, hand) {
      return !!world.game?.audio?.useJukebox?.(world, x, y, z, state, player, hand);
    },
  }), { blockEntity: 'jukebox' });

  cube('bookshelf', {
    top: 'oak_planks', bottom: 'oak_planks', side: 'bookshelf',
  }, mat(MAT.wood, {
    hardness: 1.5, blastResistance: 1.5, flammable: 30, burnTime: 20,
    creativeTab: 'building', drops: silkOnly(fixedDrop('book', 3)),
  }));

  const shelf = def('chiseled_bookshelf', mat(MAT.wood, {
    properties: [PROP.facing, XP.slot0, XP.slot1, XP.slot2, XP.slot3, XP.slot4, XP.slot5],
    defaultState: {
      facing: 'north', slot_0_occupied: false, slot_1_occupied: false,
      slot_2_occupied: false, slot_3_occupied: false, slot_4_occupied: false,
      slot_5_occupied: false,
    },
    hardness: 1.5,
    blastResistance: 1.5,
    hasEntity: true,
    container: { slots: 6, type: 'bookshelf' },
    creativeTab: 'functional',
    redstone: { component: true, source: true },
    textures: (state) => {
      const f = [4, 1, 5, 0][FACING_INDEX[getProp(state, 'facing')]];
      const tex = ['chiseled_bookshelf_side', 'chiseled_bookshelf_side',
        'chiseled_bookshelf_top', 'chiseled_bookshelf_top',
        'chiseled_bookshelf_side', 'chiseled_bookshelf_side'];
      tex[f] = 'chiseled_bookshelf_front';
      tex[FACES[f].opposite] = 'chiseled_bookshelf_side';
      return tex;
    },
    onUse(world, x, y, z, state, player, hand, hit) {
      return !!world.game?.ui?.useBookshelf?.(world, x, y, z, state, player, hit);
    },
  }), { blockEntity: 'chiseled_bookshelf' });
  shelf.stateForPlacement = (world, x, y, z, ctx) =>
    withProp(shelf.defaultState, 'facing', DIRS[faceFacing(ctx)]);

  def('spawner', mat(MAT.metal, {
    render: RENDER.CUBE,
    pass: PASS.CUTOUT,
    hardness: 5,
    blastResistance: 5,
    tier: TIER.WOOD,
    opaque: false,
    hasEntity: true,
    mapColor: MAP.stone,
    textures: 'spawner',
    transparentToSelf: true,
    creativeTab: 'functional',
    drops: () => [],
  }), { blockEntity: 'spawner', noConnect: true }).xpDrop = [15, 43];

  def('beacon', mat(MAT.glass, {
    render: RENDER.CUBE,
    pass: PASS.CUTOUT,
    hardness: 3,
    blastResistance: 3,
    light: 15,
    emissive: 15,
    opaque: false,
    hasEntity: true,
    mapColor: MAP.diamond,
    textures: 'beacon',
    creativeTab: 'functional',
    onUse: openMenu('beacon'),
  }), { menu: 'beacon', blockEntity: 'beacon', noConnect: true });

  def('conduit', mat(MAT.metal, {
    properties: [PROP.waterlogged],
    defaultState: { waterlogged: true },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 3,
    blastResistance: 3,
    tier: TIER.WOOD,
    light: 15,
    emissive: 15,
    solid: false,
    opaque: false,
    hasEntity: true,
    mapColor: MAP.diamond,
    creativeTab: 'functional',
    textures: 'conduit',
    model: () => boxesToModel(SHAPE.conduitShape, 'conduit', { emissive: 15 }),
    collision: () => SHAPE.conduitShape,
  }), { blockEntity: 'conduit', noConnect: true });

  const anchor = def('respawn_anchor', mat(MAT.stone, {
    properties: [PROP.charges],
    defaultState: { charges: 0 },
    hardness: 50,
    blastResistance: 1200,
    tier: TIER.DIAMOND,
    mapColor: MAP.black,
    creativeTab: 'functional',
    textures: (state) => ({
      top: `respawn_anchor_top${getProp(state, 'charges') > 0 ? '' : '_off'}`,
      bottom: 'respawn_anchor_bottom',
      side: `respawn_anchor_side${getProp(state, 'charges')}`,
    }),
    onUse(world, x, y, z, state, player, hand) {
      return !!world.game?.spawn?.useRespawnAnchor?.(world, x, y, z, state, player, hand);
    },
  }));
  stateLight(anchor, (state) => {
    const c = getProp(state, 'charges');
    return c === 0 ? 0 : c * 4 - 1;   // 3, 7, 11, 15
  });

  cube('lodestone', 'lodestone', mat(MAT.stone, {
    hardness: 3.5, blastResistance: 3.5, tier: TIER.WOOD, mapColor: MAP.metal,
    creativeTab: 'functional',
    textures: { top: 'lodestone_top', side: 'lodestone_side' },
  }));
}

/** Chests join into a double chest with an adjacent chest facing the same way. */
function chestPairing(world, x, y, z, state) {
  const facing = FACING_INDEX[getProp(state, 'facing')];
  const self = blockOf(state);
  for (const side of [1, 3]) {          // right of the facing, then left
    const d = HORIZONTAL[(facing + side) & 3];
    const ns = world.getBlock(x + d.dx, y, z + d.dz);
    if (blockOf(ns) !== self) continue;
    if (FACING_INDEX[getProp(ns, 'facing')] !== facing) continue;
    return withProp(state, 'type', side === 1 ? 'left' : 'right');
  }
  return withProp(state, 'type', 'single');
}

// ---------------------------------------------------------------------------
// Light sources
// ---------------------------------------------------------------------------

function registerLights() {
  cube('glowstone', 'glowstone', mat(MAT.glass, {
    hardness: 0.3, blastResistance: 0.3, light: 15, emissive: 15,
    mapColor: MAP.sand, sound: SOUND.GLASS,
    drops: silkOnly(oreDrop('glowstone_dust', 2, 4)),
  }));

  torchPair('torch', 'wall_torch', 14, MAP.none);
  torchPair('soul_torch', 'soul_wall_torch', 10, MAP.none);

  for (const [name, light] of [['lantern', 15], ['soul_lantern', 10]]) {
    const lantern = def(name, mat(MAT.metal, {
      properties: [PROP.hanging, PROP.waterlogged],
      defaultState: { hanging: false, waterlogged: false },
      render: RENDER.MODEL,
      pass: PASS.CUTOUT,
      hardness: 3.5,
      blastResistance: 3.5,
      tier: TIER.WOOD,
      light,
      emissive: light,
      solid: false,
      opaque: false,
      creativeTab: 'functional',
      textures: name,
      model: (state) => boxesToModel(
        getProp(state, 'hanging') ? SHAPE.hangingLantern : SHAPE.lantern, name,
        { emissive: light }),
      collision: (state) => (getProp(state, 'hanging')
        ? SHAPE.hangingLantern : SHAPE.lantern),
      canSurvive(world, x, y, z, state) {
        return getProp(state, 'hanging')
          ? world.getBlock(x, y + 1, z) !== 0
          : T.solid[world.getBlock(x, y - 1, z)] === 1;
      },
    }), { noConnect: true });
    // Clicking the underside of a block hangs the lantern from it.
    lantern.stateForPlacement = (world, x, y, z, ctx) => stateOf(lantern, {
      hanging: !!ctx && ctx.face === 2,
      waterlogged: isWaterAt(world, x, y, z),
    });
  }

  for (const [name, light, soul] of [['campfire', 15, false], ['soul_campfire', 10, true]]) {
    const b = def(name, mat(MAT.wood, {
      properties: [PROP.facing, PROP.lit, XP.signalFire, PROP.waterlogged],
      defaultState: { facing: 'north', lit: true, signal_fire: false, waterlogged: false },
      render: RENDER.MODEL,
      pass: PASS.CUTOUT,
      hardness: 2,
      blastResistance: 2,
      solid: false,
      opaque: false,
      hasEntity: true,
      flammable: 0,
      burnTime: 0,
      creativeTab: 'functional',
      textures: (state) => (getProp(state, 'lit')
        ? { top: `${name}_fire`, side: 'campfire_log', bottom: 'campfire_log' }
        : { all: 'campfire_log' }),
      model: (state) => boxesToModel(SHAPE.campfire, getProp(state, 'lit')
        ? { top: `${name}_fire`, side: 'campfire_log', bottom: 'campfire_log' }
        : { all: 'campfire_log' }, { emissive: getProp(state, 'lit') ? light : 0 }),
      collision: () => SHAPE.campfire,
      drops: (world, x, y, z, state, tool, random) => {
        if (tool && tool.getEnchantLevel && tool.getEnchantLevel('silk_touch') > 0) {
          return [{ item: name, count: 1 }];
        }
        return [{ item: soul ? 'soul_soil' : 'charcoal', count: soul ? 1 : 2 }];
      },
      onEntityInside(world, x, y, z, state, entity) {
        if (getProp(state, 'lit')) world.game?.damage?.onCampfire?.(world, entity, soul);
      },
      onUse(world, x, y, z, state, player, hand) {
        return !!world.game?.crafting?.useCampfire?.(world, x, y, z, state, player, hand);
      },
    }), { blockEntity: 'campfire', noConnect: true });
    stateLight(b, (state) => (getProp(state, 'lit') ? light : 0));
    b.stateForPlacement = (world, x, y, z, ctx) => stateOf(b, {
      facing: DIRS[faceFacing(ctx)], lit: true, signal_fire: false,
      waterlogged: isWaterAt(world, x, y, z),
    });
  }

  const endRod = def('end_rod', mat(MAT.stone, {
    properties: [PROP.facingAll],
    defaultState: { facing: 'up' },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    requiresTool: false,
    tool: TOOL.NONE,
    light: 14,
    emissive: 14,
    mapColor: MAP.quartz,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    creativeTab: 'decorations',
    textures: 'end_rod',
    model: (state) => boxesToModel(endRodBoxes(state), 'end_rod', { emissive: 14 }),
    collision: endRodBoxes,
  }), { noConnect: true });
  endRod.stateForPlacement = (world, x, y, z, ctx) => stateOf(endRod, {
    facing: facing6OfFace(ctx && ctx.face != null ? ctx.face : 3),
  });
}

function endRodBoxes(state) {
  const f = FACES[faceOfFacing6(getProp(state, 'facing'))];
  const a = 6 / 16, b = 10 / 16;
  if (f.dx) return [new AABB(0, a, a, 1, b, b)];
  if (f.dy) return [new AABB(a, 0, a, b, 1, b)];
  return [new AABB(a, a, 0, b, b, 1)];
}

/** A floor torch plus its wall-mounted twin. */
function torchPair(name, wallName, light, mapColor) {
  const floor = def(name, {
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.WOOD,
    mapColor,
    light,
    emissive: light,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    creativeTab: 'decorations',
    textures: name,
    model: () => boxesToModel(SHAPE.torchShape, name, { emissive: light }),
    collision: () => SHAPE.NONE,
    selection: () => SHAPE.torchShape,
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y - 1, z)] === 1,
  }, { isTorch: true, noConnect: true });

  const wall = def(wallName, {
    properties: [PROP.facing],
    defaultState: { facing: 'north' },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.WOOD,
    mapColor,
    light,
    emissive: light,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    item: name,
    creativeTab: HIDDEN,
    textures: name,
    model: (state) => boxesToModel(
      SHAPE.wallTorchShape(FACING_INDEX[getProp(state, 'facing')]), name,
      { emissive: light }),
    collision: () => SHAPE.NONE,
    selection: (state) => SHAPE.wallTorchShape(FACING_INDEX[getProp(state, 'facing')]),
    canSurvive(world, x, y, z, state) {
      const d = HORIZONTAL[(FACING_INDEX[getProp(state, 'facing')] + 2) & 3];
      return T.solid[world.getBlock(x + d.dx, y, z + d.dz)] === 1;
    },
  }, { isTorch: true, noConnect: true });
  wall.stateForPlacement = (world, x, y, z, ctx) => {
    const face = ctx ? ctx.face : 4;
    const dir = face === 4 ? 0 : face === 1 ? 1 : face === 5 ? 2 : 3;
    return stateOf(wall, { facing: DIRS[dir] });
  };
  return [floor, wall];
}

// ---------------------------------------------------------------------------
// Decorations and oddities
// ---------------------------------------------------------------------------

function registerDecorations() {
  const ladder = def('ladder', mat(MAT.wood, {
    properties: [PROP.facing, PROP.waterlogged],
    defaultState: { facing: 'north', waterlogged: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0.4,
    blastResistance: 0.4,
    sound: SOUND.LADDER,
    mapColor: MAP.none,
    solid: false,
    opaque: false,
    climbable: true,
    creativeTab: 'decorations',
    textures: 'ladder',
    model: (state) => boxesToModel(
      SHAPE.ladderShape(FACING_INDEX[getProp(state, 'facing')]), 'ladder'),
    collision: () => SHAPE.NONE,
    selection: (state) => SHAPE.ladderShape(FACING_INDEX[getProp(state, 'facing')]),
    canSurvive(world, x, y, z, state) {
      const d = HORIZONTAL[(FACING_INDEX[getProp(state, 'facing')] + 2) & 3];
      return T.solid[world.getBlock(x + d.dx, y, z + d.dz)] === 1;
    },
  }), { noConnect: true });
  ladder.stateForPlacement = (world, x, y, z, ctx) => stateOf(ladder, {
    facing: DIRS[faceFacing(ctx)], waterlogged: isWaterAt(world, x, y, z),
  });

  const scaffold = def('scaffolding', mat(MAT.wood, {
    properties: [XP.distance0, PROP.waterlogged, PROP.bottom],
    defaultState: { distance: 7, waterlogged: false, bottom: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.WOOD,
    mapColor: MAP.sand,
    solid: false,
    opaque: false,
    climbable: true,
    push: PUSH.DESTROY,
    creativeTab: 'decorations',
    textures: {
      top: 'scaffolding_top', side: 'scaffolding_side', bottom: 'scaffolding_bottom',
    },
    model: () => boxesToModel(SCAFFOLD_MODEL, {
      top: 'scaffolding_top', side: 'scaffolding_side', bottom: 'scaffolding_bottom',
    }),
    // Walking on top is solid; the inside is hollow so you can climb through.
    collision: (state) => (getProp(state, 'bottom') ? SHAPE.NONE : SHAPE.scaffolding),
    selection: () => SHAPE.FULL,
    canSurvive: (world, x, y, z, state) => getProp(state, 'distance') < 7 ||
      T.solid[world.getBlock(x, y - 1, z)] === 1,
    updateShape(world, x, y, z, state) {
      // Distance counts hops back to a supported column, as with leaves.
      let best = 7;
      if (T.solid[world.getBlock(x, y - 1, z)] === 1) best = 0;
      for (let i = 0; i < 4 && best > 0; i++) {
        const d = HORIZONTAL[i];
        const ns = world.getBlock(x + d.dx, y, z + d.dz);
        if (blockOf(ns) === blockOf(state)) best = Math.min(best, getProp(ns, 'distance') + 1);
      }
      const below = world.getBlock(x, y - 1, z);
      return withProp(withProp(state, 'distance', Math.min(best, 7)),
        'bottom', blockOf(below) !== blockOf(state) && T.solid[below] !== 1);
    },
  }), { noConnect: true });
  void scaffold;

  def('cobweb', mat(MAT.wool, {
    render: RENDER.CROSS,
    pass: PASS.CUTOUT,
    hardness: 4,
    blastResistance: 4,
    tool: TOOL.SHEARS,
    requiresTool: true,
    sound: SOUND.CLOTH,
    mapColor: MAP.wool,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    flammable: 0,
    burnTime: 0,
    speedFactor: 0.25,
    creativeTab: 'decorations',
    textures: 'cobweb',
    model: NO_MODEL,
    collision: () => SHAPE.NONE,
    selection: () => SHAPE.FULL,
    drops: (world, x, y, z, state, tool) => {
      const item = tool && tool.item;
      if (item && (item.tool === TOOL.SHEARS || item.tool === TOOL.SWORD)) {
        return [{ item: 'string', count: 1 }];
      }
      return [];
    },
    onEntityInside(world, x, y, z, state, entity) {
      world.game?.physics?.onCobweb?.(world, entity);
    },
  }), { noConnect: true });

  cube('slime_block', 'slime_block', mat(MAT.wool, {
    hardness: 0, blastResistance: 0, tool: TOOL.NONE, sound: SOUND.SLIME,
    mapColor: MAP.grass, pass: PASS.TRANSLUCENT, opaque: false,
    flammable: 0, burnTime: 0, slipperiness: 0.8, jumpFactor: 1,
    push: PUSH.NORMAL, creativeTab: 'functional',
    onEntityInside(world, x, y, z, state, entity) {
      world.game?.physics?.onSlime?.(world, entity);
    },
  }));
  cube('honey_block', 'honey_block', mat(MAT.wool, {
    hardness: 0, blastResistance: 0, tool: TOOL.NONE, sound: SOUND.SLIME,
    mapColor: MAP.orange, pass: PASS.TRANSLUCENT, opaque: false,
    flammable: 0, burnTime: 0, speedFactor: 0.4, jumpFactor: 0.5,
    creativeTab: 'functional',
    collision: () => [new AABB(1 / 16, 0, 1 / 16, 15 / 16, 15 / 16, 15 / 16)],
    onEntityInside(world, x, y, z, state, entity) {
      world.game?.physics?.onHoney?.(world, entity);
    },
  }));
  cube('honeycomb_block', 'honeycomb_block', mat(MAT.wool, {
    hardness: 0.6, blastResistance: 0.6, tool: TOOL.NONE, sound: SOUND.CLOTH,
    mapColor: MAP.orange, flammable: 0, burnTime: 0, creativeTab: 'building',
  }));

  def('tnt', mat(MAT.plant, {
    render: RENDER.CUBE,
    hardness: 0,
    blastResistance: 0,
    tool: TOOL.NONE,
    sound: SOUND.GRASS,
    mapColor: MAP.fire,
    properties: [PROP.unstable],
    defaultState: { unstable: false },
    flammable: 15,
    burnTime: 100,
    creativeTab: 'redstone',
    textures: { top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' },
    onNeighborChange(world, x, y, z, state) {
      if (world.game?.redstone?.hasSignal?.(world, x, y, z)) {
        world.game?.explosions?.primeTnt?.(world, x, y, z);
      }
    },
  }), { noConnect: true });

  def('cake', {
    properties: [PROP.bites],
    defaultState: { bites: 0 },
    render: RENDER.MODEL,
    hardness: 0.5,
    blastResistance: 0.5,
    sound: SOUND.CLOTH,
    mapColor: MAP.snow,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    maxStack: 1,
    creativeTab: 'functional',
    redstone: { component: true },
    textures: {
      top: 'cake_top', bottom: 'cake_bottom', side: 'cake_side',
      west: 'cake_side', east: 'cake_side', north: 'cake_side', south: 'cake_side',
    },
    model: (state) => boxesToModel(cakeBoxes(state), {
      top: 'cake_top', bottom: 'cake_bottom', side: 'cake_side',
      west: getProp(state, 'bites') > 0 ? 'cake_inner' : 'cake_side',
    }),
    collision: cakeBoxes,
    drops: () => [],
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y - 1, z)] === 1,
    onUse(world, x, y, z, state, player) {
      const bites = getProp(state, 'bites');
      if (!world.game?.food?.eatCake?.(world, player)) return false;
      if (bites >= 6) world.setBlock(x, y, z, 0);
      else world.setBlock(x, y, z, withProp(state, 'bites', bites + 1));
      return true;
    },
  }, { noConnect: true });

  const bell = def('bell', mat(MAT.metal, {
    properties: [XP.bellAttach, PROP.facing, PROP.powered],
    defaultState: { attachment: 'floor', facing: 'north', powered: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 5,
    blastResistance: 5,
    tier: TIER.WOOD,
    mapColor: MAP.gold,
    solid: false,
    opaque: false,
    creativeTab: 'functional',
    hasEntity: true,
    textures: { all: 'bell_bottom', top: 'bell_top' },
    model: () => boxesToModel(BELL_SHAPE, { all: 'bell_bottom', top: 'bell_top' }),
    collision: () => BELL_SHAPE,
    onUse(world, x, y, z, state) {
      world.playSound('bell.use', x + 0.5, y + 0.5, z + 0.5);
      world.game?.ui?.ringBell?.(world, x, y, z, state);
      return true;
    },
  }), { blockEntity: 'bell', noConnect: true });
  bell.stateForPlacement = (world, x, y, z, ctx) => {
    const a = attachStateFor(ctx);
    return stateOf(bell, {
      attachment: a.face === 'floor' ? 'floor' : a.face === 'ceiling' ? 'ceiling' : 'single_wall',
      facing: a.facing,
      powered: false,
    });
  };

  const dragonEgg = def('dragon_egg', mat(MAT.stone, {
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 3,
    blastResistance: 9,
    requiresTool: false,
    light: 1,
    mapColor: MAP.black,
    solid: false,
    opaque: false,
    gravity: true,
    push: PUSH.DESTROY,
    creativeTab: 'functional',
    textures: 'dragon_egg',
    model: () => boxesToModel(DRAGON_EGG_SHAPE, 'dragon_egg'),
    collision: () => DRAGON_EGG_SHAPE,
    onUse(world, x, y, z, state, player) {
      // Punching or using the egg teleports it a short distance away.
      world.game?.effects?.teleportDragonEgg?.(world, x, y, z, state);
      return true;
    },
  }), { noConnect: true });
  void dragonEgg;
}

const SCAFFOLD_MODEL = [
  new AABB(0, 14 / 16, 0, 1, 1, 1),
  new AABB(0, 0, 0, 2 / 16, 14 / 16, 2 / 16),
  new AABB(14 / 16, 0, 0, 1, 14 / 16, 2 / 16),
  new AABB(0, 0, 14 / 16, 2 / 16, 14 / 16, 1),
  new AABB(14 / 16, 0, 14 / 16, 1, 14 / 16, 1),
];

const BELL_SHAPE = [new AABB(5 / 16, 6 / 16, 5 / 16, 11 / 16, 1, 11 / 16)];
const DRAGON_EGG_SHAPE = [new AABB(1 / 16, 0, 1 / 16, 15 / 16, 1, 15 / 16)];

function cakeBoxes(state) {
  const bites = getProp(state, 'bites');
  return [new AABB((1 + bites * 2) / 16, 0, 1 / 16, 15 / 16, 0.5, 15 / 16)];
}

// ---------------------------------------------------------------------------
// Sculk
// ---------------------------------------------------------------------------

function registerSculk() {
  cube('sculk', 'sculk', mat(MAT.sculk, { mapColor: MAP.sculk })).xpDrop = [1, 1];

  const sensor = def('sculk_sensor', mat(MAT.sculk, {
    properties: [PROP.sculkPhase, PROP.power, PROP.waterlogged],
    defaultState: { sculk_sensor_phase: 'inactive', power: 0, waterlogged: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 1.5,
    blastResistance: 1.5,
    mapColor: MAP.sculk,
    solid: false,
    opaque: false,
    creativeTab: 'redstone',
    redstone: { component: true, source: true },
    textures: {
      top: 'sculk_sensor_top', side: 'sculk_sensor_side', bottom: 'sculk_sensor_bottom',
    },
    model: () => boxesToModel(SCULK_SENSOR_SHAPE, {
      top: 'sculk_sensor_top', side: 'sculk_sensor_side', bottom: 'sculk_sensor_bottom',
    }),
    collision: () => SCULK_SENSOR_SHAPE,
    drops: silkOnly(() => []),
    onScheduledTick(world, x, y, z, state) {
      const phase = getProp(state, 'sculk_sensor_phase');
      if (phase === 'active') {
        world.setBlock(x, y, z, withProp(withProp(state, 'sculk_sensor_phase', 'cooldown'), 'power', 0));
        world.scheduleTick(x, y, z, blockOf(state), 10);
      } else if (phase === 'cooldown') {
        world.setBlock(x, y, z, withProp(state, 'sculk_sensor_phase', 'inactive'));
      }
    },
  }), { isSculk: true, noConnect: true });
  stateLight(sensor, (state) =>
    (getProp(state, 'sculk_sensor_phase') === 'active' ? 1 : 0));

  def('sculk_catalyst', mat(MAT.sculk, {
    properties: [XP.bloom],
    defaultState: { bloom: false },
    hardness: 3,
    blastResistance: 3,
    light: 6,
    mapColor: MAP.sculk,
    creativeTab: 'natural',
    textures: (state) => ({
      top: 'sculk_catalyst_top',
      bottom: 'sculk_catalyst_bottom',
      side: getProp(state, 'bloom') ? 'sculk_catalyst_side_bloom' : 'sculk_catalyst_side',
    }),
    drops: silkOnly(() => []),
  }), { isSculk: true }).xpDrop = [5, 5];

  const shrieker = def('sculk_shrieker', mat(MAT.sculk, {
    properties: [XP.canSummon, XP.shrieking, PROP.waterlogged],
    defaultState: { can_summon: false, shrieking: false, waterlogged: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 3,
    blastResistance: 3,
    mapColor: MAP.sculk,
    solid: false,
    opaque: false,
    creativeTab: 'natural',
    textures: {
      top: 'sculk_shrieker_top', side: 'sculk_shrieker_side',
      bottom: 'sculk_shrieker_bottom',
    },
    model: () => boxesToModel(SCULK_SHRIEKER_SHAPE, {
      top: 'sculk_shrieker_top', side: 'sculk_shrieker_side',
      bottom: 'sculk_shrieker_bottom',
    }),
    collision: () => SCULK_SHRIEKER_SHAPE,
    drops: silkOnly(() => []),
    onScheduledTick(world, x, y, z, state) {
      if (getProp(state, 'shrieking')) {
        world.setBlock(x, y, z, withProp(state, 'shrieking', false));
        world.game?.warden?.onShriekEnd?.(world, x, y, z, state);
      }
    },
    onSteppedOn(world, x, y, z, state, entity) {
      if (getProp(state, 'shrieking')) return;
      world.setBlock(x, y, z, withProp(state, 'shrieking', true));
      world.scheduleTick(x, y, z, blockOf(state), 90);
      world.game?.warden?.onShriek?.(world, x, y, z, state, entity);
    },
  }), { isSculk: true, noConnect: true });
  shrieker.xpDrop = [5, 5];

  multifaceBlock('sculk_vein', {
    waterloggable: true,
    hardness: 0.2,
    blastResistance: 0.2,
    tool: TOOL.HOE,
    sound: SOUND.STONE,
    mapColor: MAP.sculk,
    drops: silkOnly(() => []),
  });
}

const SCULK_SENSOR_SHAPE = [new AABB(0, 0, 0, 1, 8 / 16, 1)];
const SCULK_SHRIEKER_SHAPE = [new AABB(0, 0, 0, 1, 8 / 16, 1)];

// ---------------------------------------------------------------------------
// Fire and portals
// ---------------------------------------------------------------------------

function registerFireAndPortals() {
  const fire = def('fire', {
    properties: [PROP.age15, PROP.north, PROP.east, PROP.south, PROP.west, PROP.up],
    defaultState: {
      age: 0, north: false, east: false, south: false, west: false, up: false,
    },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    light: 15,
    emissive: 15,
    sound: SOUND.CLOTH,
    mapColor: MAP.fire,
    solid: false,
    opaque: false,
    replaceable: true,
    randomTick: true,
    push: PUSH.DESTROY,
    item: null,
    creativeTab: HIDDEN,
    textures: 'fire_0',
    model: (state) => boxesToModel(fireBoxes(state), 'fire_0', { emissive: 15 }),
    collision: () => SHAPE.NONE,
    selection: () => SHAPE.NONE,
    drops: () => [],
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y - 1, z)] === 1 ||
      hasFlammableNeighbor(world, x, y, z),
    onEntityInside(world, x, y, z, state, entity) {
      world.game?.damage?.onFire?.(world, entity, x, y, z);
    },
    onRandomTick(world, x, y, z, state, random) {
      world.game?.fire?.tick?.(world, x, y, z, state, random);
    },
    updateShape(world, x, y, z, state) {
      let s = state;
      for (let i = 0; i < 4; i++) {
        const d = HORIZONTAL[i];
        s = withProp(s, DIRS[i], isFlammableAt(world, x + d.dx, y, z + d.dz));
      }
      return withProp(s, 'up', isFlammableAt(world, x, y + 1, z));
    },
  }, { isFire: true, noConnect: true });
  void fire;

  def('soul_fire', {
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    light: 10,
    emissive: 10,
    sound: SOUND.CLOTH,
    mapColor: MAP.lightBlue,
    solid: false,
    opaque: false,
    replaceable: true,
    push: PUSH.DESTROY,
    item: null,
    creativeTab: HIDDEN,
    textures: 'soul_fire_0',
    model: () => boxesToModel([new AABB(0, 0, 0, 1, 1, 1)], 'soul_fire_0', { emissive: 10 }),
    collision: () => SHAPE.NONE,
    selection: () => SHAPE.NONE,
    drops: () => [],
    canSurvive: (world, x, y, z) => {
      const below = world.getBlockName(x, y - 1, z);
      return below === 'soul_sand' || below === 'soul_soil';
    },
    onEntityInside(world, x, y, z, state, entity) {
      world.game?.damage?.onFire?.(world, entity, x, y, z, true);
    },
  }, { isFire: true, noConnect: true });

  const portal = def('nether_portal', {
    properties: [PROP.axis],
    defaultState: { axis: 'x' },
    render: RENDER.MODEL,
    pass: PASS.TRANSLUCENT,
    hardness: -1,
    blastResistance: 0,
    light: 11,
    emissive: 11,
    sound: SOUND.GLASS,
    mapColor: MAP.purple,
    solid: false,
    opaque: false,
    push: PUSH.BLOCK,
    item: null,
    creativeTab: HIDDEN,
    textures: 'nether_portal',
    model: (state) => boxesToModel(portalBoxes(getProp(state, 'axis')),
      'nether_portal', { emissive: 11 }),
    collision: () => SHAPE.NONE,
    selection: (state) => portalBoxes(getProp(state, 'axis')),
    drops: () => [],
    onEntityInside(world, x, y, z, state, entity) {
      world.game?.dimensions?.onPortal?.(world, entity, 'nether');
    },
  }, { noConnect: true });
  void portal;

  def('end_portal', {
    render: RENDER.MODEL,
    pass: PASS.TRANSLUCENT,
    hardness: -1,
    blastResistance: 3600000,
    light: 15,
    emissive: 15,
    mapColor: MAP.black,
    solid: false,
    opaque: false,
    push: PUSH.BLOCK,
    hasEntity: true,
    item: null,
    creativeTab: HIDDEN,
    textures: 'end_portal',
    model: () => boxesToModel([new AABB(0, 0, 0, 1, 12 / 16, 1)], 'end_portal',
      { emissive: 15 }),
    collision: () => SHAPE.NONE,
    selection: () => [new AABB(0, 0, 0, 1, 12 / 16, 1)],
    drops: () => [],
    onEntityInside(world, x, y, z, state, entity) {
      world.game?.dimensions?.onPortal?.(world, entity, 'end');
    },
  }, { blockEntity: 'end_portal', noConnect: true });

  const frame = def('end_portal_frame', mat(MAT.stone, {
    properties: [XP.eye, PROP.facing],
    defaultState: { eye: false, facing: 'north' },
    render: RENDER.MODEL,
    hardness: -1,
    blastResistance: 3600000,
    light: 1,
    mapColor: MAP.plant,
    solid: false,
    opaque: false,
    push: PUSH.BLOCK,
    creativeTab: 'functional',
    drops: () => [],
    textures: {
      top: 'end_portal_frame_top', side: 'end_portal_frame_side',
      bottom: 'end_stone',
    },
    model: (state) => {
      const boxes = [new AABB(0, 0, 0, 1, 13 / 16, 1)];
      if (getProp(state, 'eye')) boxes.push(new AABB(4 / 16, 13 / 16, 4 / 16, 12 / 16, 1, 12 / 16));
      return boxesToModel(boxes, {
        top: 'end_portal_frame_top', side: 'end_portal_frame_side', bottom: 'end_stone',
      });
    },
    collision: (state) => (getProp(state, 'eye')
      ? [new AABB(0, 0, 0, 1, 13 / 16, 1), new AABB(4 / 16, 13 / 16, 4 / 16, 12 / 16, 1, 12 / 16)]
      : SHAPE.endPortalFrame),
  }), { noConnect: true });
  frame.stateForPlacement = (world, x, y, z, ctx) =>
    stateOf(frame, { eye: false, facing: DIRS[faceFacing(ctx)] });

  def('end_gateway', {
    render: RENDER.INVISIBLE,
    hardness: -1,
    blastResistance: 3600000,
    light: 15,
    mapColor: MAP.black,
    solid: false,
    opaque: false,
    push: PUSH.BLOCK,
    hasEntity: true,
    item: null,
    creativeTab: HIDDEN,
    collision: () => SHAPE.NONE,
    selection: () => SHAPE.NONE,
    drops: () => [],
    onEntityInside(world, x, y, z, state, entity) {
      world.game?.dimensions?.onGateway?.(world, entity, x, y, z);
    },
  }, { blockEntity: 'end_gateway', noConnect: true });
}

function fireBoxes(state) {
  const boxes = [];
  const t = 1 / 16;
  if (getProp(state, 'up')) boxes.push(new AABB(0, 1 - t, 0, 1, 1, 1));
  if (getProp(state, 'north')) boxes.push(new AABB(0, 0, 0, 1, 1, t));
  if (getProp(state, 'south')) boxes.push(new AABB(0, 0, 1 - t, 1, 1, 1));
  if (getProp(state, 'west')) boxes.push(new AABB(0, 0, 0, t, 1, 1));
  if (getProp(state, 'east')) boxes.push(new AABB(1 - t, 0, 0, 1, 1, 1));
  return boxes.length ? boxes : [new AABB(0, 0, 0, 1, 1, 1)];
}

function portalBoxes(axis) {
  const t = 3 / 16;
  return axis === 'z'
    ? [new AABB(0.5 - t / 2, 0, 0, 0.5 + t / 2, 1, 1)]
    : [new AABB(0, 0, 0.5 - t / 2, 1, 1, 0.5 + t / 2)];
}

function isFlammableAt(world, x, y, z) {
  const d = blockOf(world.getBlock(x, y, z));
  return !!d && d.flammable > 0;
}

function hasFlammableNeighbor(world, x, y, z) {
  for (let i = 0; i < 6; i++) {
    const f = FACES[i];
    if (isFlammableAt(world, x + f.dx, y + f.dy, z + f.dz)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// End blocks
// ---------------------------------------------------------------------------

function registerEndBlocks() {
  def('chorus_plant', mat(MAT.wood, {
    properties: [PROP.north, PROP.east, PROP.south, PROP.west, PROP.up, PROP.down],
    defaultState: {
      north: false, east: false, south: false, west: false, up: false, down: false,
    },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0.4,
    blastResistance: 0.4,
    tool: TOOL.AXE,
    sound: SOUND.WOOD,
    mapColor: MAP.purple,
    solid: false,
    opaque: false,
    flammable: 0,
    burnTime: 0,
    push: PUSH.DESTROY,
    creativeTab: 'natural',
    textures: 'chorus_plant',
    model: (state) => boxesToModel(chorusBoxes(state), 'chorus_plant'),
    collision: chorusBoxes,
    drops: (world, x, y, z, state, tool, random) =>
      (random && random.chance(0.5) ? [{ item: 'chorus_fruit', count: 1 }] : []),
    canSurvive: (world, x, y, z) => chorusSupported(world, x, y, z),
    updateShape(world, x, y, z, state) {
      let s = state;
      for (let i = 0; i < 4; i++) {
        const d = HORIZONTAL[i];
        s = withProp(s, DIRS[i], isChorus(world, x + d.dx, y, z + d.dz));
      }
      s = withProp(s, 'up', isChorus(world, x, y + 1, z));
      const below = world.getBlockName(x, y - 1, z);
      return withProp(s, 'down', isChorus(world, x, y - 1, z) || below === 'end_stone');
    },
  }), { isChorus: true, noConnect: true });

  def('chorus_flower', mat(MAT.wood, {
    properties: [XP.age5],
    defaultState: { age: 0 },
    render: RENDER.CUBE,
    pass: PASS.CUTOUT,
    hardness: 0.4,
    blastResistance: 0.4,
    tool: TOOL.AXE,
    sound: SOUND.WOOD,
    mapColor: MAP.purple,
    opaque: false,
    flammable: 0,
    burnTime: 0,
    randomTick: true,
    push: PUSH.DESTROY,
    creativeTab: 'natural',
    textures: (state) => (getProp(state, 'age') >= 5 ? 'chorus_flower_dead' : 'chorus_flower'),
    drops: () => [{ item: 'chorus_flower', count: 1 }],
    canSurvive: (world, x, y, z) => {
      const below = world.getBlockName(x, y - 1, z);
      return below === 'end_stone' || below === 'chorus_plant' ||
        world.getBlock(x, y - 1, z) === 0;
    },
    onRandomTick(world, x, y, z, state, random) {
      world.game?.features?.growChorus?.(world, x, y, z, state, random);
    },
  }), { noConnect: true });
}

function isChorus(world, x, y, z) {
  const d = blockOf(world.getBlock(x, y, z));
  return !!d && (d.isChorus === true || d.name === 'chorus_flower');
}

function chorusSupported(world, x, y, z) {
  if (world.getBlockName(x, y - 1, z) === 'end_stone') return true;
  if (isChorus(world, x, y - 1, z)) return true;
  // A horizontal branch is held up by a neighbouring stem that itself has air
  // beneath it, which is what gives chorus trees their gangly shape.
  for (let i = 0; i < 4; i++) {
    const d = HORIZONTAL[i];
    if (isChorus(world, x + d.dx, y, z + d.dz) &&
      world.getBlock(x + d.dx, y - 1, z + d.dz) === 0) return true;
  }
  return false;
}

function chorusBoxes(state) {
  const a = 2 / 16, b = 14 / 16;
  const boxes = [new AABB(a, a, a, b, b, b)];
  if (getProp(state, 'north')) boxes.push(new AABB(a, a, 0, b, b, a));
  if (getProp(state, 'south')) boxes.push(new AABB(a, a, b, b, b, 1));
  if (getProp(state, 'west')) boxes.push(new AABB(0, a, a, a, b, b));
  if (getProp(state, 'east')) boxes.push(new AABB(b, a, a, 1, b, b));
  if (getProp(state, 'up')) boxes.push(new AABB(a, b, a, b, 1, b));
  if (getProp(state, 'down')) boxes.push(new AABB(a, 0, a, b, a, b));
  return boxes;
}
