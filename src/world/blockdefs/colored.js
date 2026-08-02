// The dyed block sets.
//
// Ten families times sixteen colours, plus the undyed shulker box, candle and
// banner. Everything is generated from COLORS so adding a colour is a one-line
// change and no family can accidentally miss one.

import {
  def, st, cube, MAT, mat, boxesToModel, paneBlock, isWaterAt, silkOnly,
  stateLight, faceFacing, lookFacing, PROP, getProp, withProp, stateOf,
  blockOf, RENDER, PASS, SOUND, TOOL, TIER, PUSH, T, SHAPE, HIDDEN,
} from './helpers.js';
import { COLORS, COLOR_MAP, MAP, DIRS, FACING_INDEX, FACING6 } from './data.js';
import { AABB, FACES, HORIZONTAL } from '../../core/math.js';

export function registerColored() {
  for (const c of COLORS) {
    woolAndCarpet(c);
    concreteSet(c);
    stainedGlass(c);
    bedBlock(c);
    shulkerBox(c);
    candleBlock(c);
    bannerBlocks(c);
  }
  shulkerBox(null);
  candleBlock(null);
}

// ---------------------------------------------------------------------------
// Wool and carpet
// ---------------------------------------------------------------------------

function woolAndCarpet(color) {
  cube(`${color}_wool`, `${color}_wool`, mat(MAT.wool, {
    mapColor: COLOR_MAP[color], creativeTab: 'colored',
  }));

  def(`${color}_carpet`, mat(MAT.wool, {
    render: RENDER.MODEL,
    hardness: 0.1,
    blastResistance: 0.1,
    mapColor: COLOR_MAP[color],
    solid: false,
    opaque: false,
    flammable: 60,
    burnTime: 20,
    creativeTab: 'colored',
    textures: `${color}_wool`,
    model: () => boxesToModel(SHAPE.carpet, `${color}_wool`),
    collision: () => SHAPE.carpet,
    canSurvive: (world, x, y, z) => world.getBlock(x, y - 1, z) !== 0,
  }), { noConnect: true });
}

// ---------------------------------------------------------------------------
// Concrete and concrete powder
// ---------------------------------------------------------------------------

function concreteSet(color) {
  cube(`${color}_concrete`, `${color}_concrete`, mat(MAT.stone, {
    hardness: 1.8, blastResistance: 1.8, tier: TIER.HAND, requiresTool: true,
    mapColor: COLOR_MAP[color], creativeTab: 'colored',
  }));

  cube(`${color}_concrete_powder`, `${color}_concrete_powder`, mat(MAT.sand, {
    hardness: 0.5, mapColor: COLOR_MAP[color], creativeTab: 'colored',
    // Powder solidifies the instant it touches water on any side.
    onNeighborChange(world, x, y, z, state) {
      for (let i = 0; i < 6; i++) {
        const f = FACES[i];
        if (T.fluid[world.getBlock(x + f.dx, y + f.dy, z + f.dz)] === 1) {
          world.setBlock(x, y, z, st(`${color}_concrete`));
          return;
        }
      }
    },
  }));
}

// ---------------------------------------------------------------------------
// Stained glass
// ---------------------------------------------------------------------------

function stainedGlass(color) {
  cube(`${color}_stained_glass`, `${color}_stained_glass`, mat(MAT.glass, {
    pass: PASS.TRANSLUCENT,
    opaque: false,
    lightFilter: 0,
    transparentToSelf: true,
    mapColor: COLOR_MAP[color],
    creativeTab: 'colored',
    drops: silkOnly(() => []),
  }));
  paneBlock(`${color}_stained_glass_pane`, `${color}_stained_glass`, mat(MAT.glass, {
    pass: PASS.TRANSLUCENT,
    paneGroup: 'glass',
    mapColor: COLOR_MAP[color],
    creativeTab: 'colored',
    drops: silkOnly(() => []),
  }));
}

// ---------------------------------------------------------------------------
// Beds
// ---------------------------------------------------------------------------

function bedBlock(color) {
  const name = `${color}_bed`;
  const b = def(name, {
    properties: [PROP.facing, PROP.occupied, PROP.bedPart],
    defaultState: { facing: 'north', occupied: false, part: 'foot' },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0.2,
    blastResistance: 0.2,
    sound: SOUND.CLOTH,
    mapColor: COLOR_MAP[color],
    solid: false,
    opaque: false,
    hasEntity: true,
    maxStack: 1,
    push: PUSH.DESTROY,
    creativeTab: 'functional',
    textures: name,
    model: () => boxesToModel(SHAPE.bed, name),
    collision: () => SHAPE.bed,
    onUse(world, x, y, z, state, player) {
      // Sleeping lives in the player/time system; the block only forwards it.
      return !!world.game?.sleep?.trySleep?.(world, x, y, z, state, player);
    },
    onBreak(world, x, y, z, state) {
      const facing = FACING_INDEX[getProp(state, 'facing')];
      const d = HORIZONTAL[facing];
      const head = getProp(state, 'part') === 'head';
      const ox = head ? x - d.dx : x + d.dx;
      const oz = head ? z - d.dz : z + d.dz;
      if (blockOf(world.getBlock(ox, y, oz)) === blockOf(state)) world.setBlock(ox, y, oz, 0);
    },
    canSurvive(world, x, y, z, state) {
      const facing = FACING_INDEX[getProp(state, 'facing')];
      const d = HORIZONTAL[facing];
      const head = getProp(state, 'part') === 'head';
      const ox = head ? x - d.dx : x + d.dx;
      const oz = head ? z - d.dz : z + d.dz;
      const other = world.getBlock(ox, y, oz);
      return blockOf(other) === blockOf(state) &&
        getProp(other, 'part') !== getProp(state, 'part');
    },
  }, { isBed: true, blockEntity: 'bed', color });

  b.stateForPlacement = (world, x, y, z, ctx) => stateOf(b, {
    facing: DIRS[lookFacing(ctx)], occupied: false, part: 'foot',
  });
  return b;
}

// ---------------------------------------------------------------------------
// Shulker boxes
// ---------------------------------------------------------------------------

function shulkerBox(color) {
  const name = color ? `${color}_shulker_box` : 'shulker_box';
  const b = def(name, {
    properties: [PROP.facingAll],
    defaultState: { facing: 'up' },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 2,
    blastResistance: 2,
    tool: TOOL.PICKAXE,
    sound: SOUND.STONE,
    mapColor: color ? COLOR_MAP[color] : MAP.purple,
    solid: true,
    opaque: false,
    hasEntity: true,
    maxStack: 1,
    push: PUSH.BLOCK,
    container: { slots: 27, type: 'shulker_box' },
    creativeTab: color ? 'colored' : 'functional',
    textures: name,
    // A closed shulker box is a full cube; the lid animation is drawn by the
    // block entity renderer, so the static model stays simple.
    model: () => boxesToModel(SHAPE.FULL, name),
    collision: () => SHAPE.FULL,
    onUse(world, x, y, z, state, player) {
      world.game?.ui?.openContainer?.(world, x, y, z, player);
      return true;
    },
  }, { isShulkerBox: true, blockEntity: 'shulker_box', color });

  b.stateForPlacement = (world, x, y, z, ctx) => stateOf(b, {
    facing: FACING6[faceIndexToFacing6(ctx && ctx.face != null ? ctx.face : 3)],
  });
  return b;
}

/** FACES index -> index into PROP.facingAll's value list. */
function faceIndexToFacing6(face) {
  switch (face) {
    case 0: return 3;   // west
    case 1: return 1;   // east
    case 2: return 5;   // down
    case 3: return 4;   // up
    case 4: return 0;   // north
    default: return 2;  // south
  }
}

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

function candleBlock(color) {
  const name = color ? `${color}_candle` : 'candle';
  const b = def(name, {
    properties: [PROP.candles, PROP.lit, PROP.waterlogged],
    defaultState: { candles: 1, lit: false, waterlogged: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0.1,
    blastResistance: 0.1,
    sound: SOUND.CANDLE,
    mapColor: color ? COLOR_MAP[color] : MAP.sand,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    creativeTab: color ? 'colored' : 'functional',
    textures: (state) => (getProp(state, 'lit') ? `${name}_lit` : name),
    model: (state) => boxesToModel(candleBoxes(getProp(state, 'candles')),
      getProp(state, 'lit') ? `${name}_lit` : name,
      { emissive: getProp(state, 'lit') ? 12 : 0 }),
    collision: () => SHAPE.NONE,
    selection: (state) => candleBoxes(getProp(state, 'candles')),
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y - 1, z)] === 1,
    drops: (world, x, y, z, state) => [{ item: name, count: getProp(state, 'candles') }],
    onUse(world, x, y, z, state, player, hand, hit) {
      // Empty hand snuffs a lit candle; flint and steel is handled by the item.
      if (getProp(state, 'lit')) {
        world.setBlock(x, y, z, withProp(state, 'lit', false));
        world.playSound('extinguish.candle', x + 0.5, y + 0.5, z + 0.5);
        return true;
      }
      return false;
    },
  }, { isCandle: true, color });

  // Four candles at three light levels each; a waterlogged candle cannot burn.
  stateLight(b, (state) => (getProp(state, 'lit') && !getProp(state, 'waterlogged')
    ? getProp(state, 'candles') * 3 : 0));

  b.stateForPlacement = (world, x, y, z, ctx) => {
    const here = world.getBlock(x, y, z);
    if (blockOf(here) === b) {
      const n = getProp(here, 'candles');
      return n < 4 ? withProp(here, 'candles', n + 1) : here;
    }
    return stateOf(b, { candles: 1, lit: false, waterlogged: isWaterAt(world, x, y, z) });
  };
  return b;
}

function candleBoxes(count) {
  const boxes = [];
  const spots = [[7, 7], [5, 8], [9, 6], [7, 10]];
  for (let i = 0; i < count; i++) {
    const [sx, sz] = spots[i];
    boxes.push(new AABB(sx / 16, 0, sz / 16, (sx + 2) / 16, 6 / 16, (sz + 2) / 16));
  }
  return boxes;
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

const BANNER_POST = [new AABB(7 / 16, 0, 7 / 16, 9 / 16, 1, 9 / 16)];

function bannerBlocks(color) {
  const standing = def(`${color}_banner`, mat(MAT.wood, {
    properties: [PROP.rotation16],
    defaultState: { rotation: 0 },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 1,
    blastResistance: 1,
    sound: SOUND.WOOD,
    mapColor: COLOR_MAP[color],
    solid: false,
    opaque: false,
    hasEntity: true,
    maxStack: 16,
    push: PUSH.DESTROY,
    creativeTab: 'colored',
    textures: `${color}_wool`,
    // The cloth itself is drawn by the banner block entity (it waves); the
    // block model is just the post so the world still occludes correctly.
    model: () => boxesToModel(BANNER_POST, `${color}_wool`),
    collision: () => SHAPE.NONE,
    selection: () => BANNER_POST,
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y - 1, z)] === 1,
  }), { isBanner: true, blockEntity: 'banner', color });
  standing.stateForPlacement = (world, x, y, z, ctx) => stateOf(standing, {
    rotation: Math.round(((ctx && ctx.yaw ? ctx.yaw : 0) / (Math.PI * 2)) * 16 + 8) & 15,
  });

  const wall = def(`${color}_wall_banner`, mat(MAT.wood, {
    properties: [PROP.facing],
    defaultState: { facing: 'north' },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 1,
    blastResistance: 1,
    sound: SOUND.WOOD,
    mapColor: COLOR_MAP[color],
    solid: false,
    opaque: false,
    hasEntity: true,
    maxStack: 16,
    push: PUSH.DESTROY,
    item: `${color}_banner`,
    creativeTab: HIDDEN,
    textures: `${color}_wool`,
    model: () => [],
    collision: () => SHAPE.NONE,
    selection: (state) => wallBannerBox(state),
    canSurvive(world, x, y, z, state) {
      const d = HORIZONTAL[(FACING_INDEX[getProp(state, 'facing')] + 2) & 3];
      return T.solid[world.getBlock(x + d.dx, y, z + d.dz)] === 1;
    },
  }), { isBanner: true, blockEntity: 'banner', color });
  wall.stateForPlacement = (world, x, y, z, ctx) =>
    stateOf(wall, { facing: DIRS[faceFacing(ctx)] });
  return [standing, wall];
}

function wallBannerBox(state) {
  const f = FACING_INDEX[getProp(state, 'facing')];
  switch (f) {
    case 0: return [new AABB(0, 0, 14 / 16, 1, 1, 1)];
    case 1: return [new AABB(0, 0, 0, 2 / 16, 1, 1)];
    case 2: return [new AABB(0, 0, 0, 1, 1, 2 / 16)];
    default: return [new AABB(14 / 16, 0, 0, 1, 1, 1)];
  }
}
