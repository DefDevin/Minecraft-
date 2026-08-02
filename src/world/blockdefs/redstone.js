// Redstone components, pistons and rails.
//
// No signal propagation happens here — that belongs to a redstone solver that
// does not exist yet. What lives here is everything that is purely a property
// of the block: its states, its shape, how it re-evaluates its own connections
// and what it does when the player right-clicks it. Anything needing a global
// signal view calls through `world.game?.redstone?.…` so the registry still
// works standalone.

import {
  def, st, cube, MAT, mat, boxesToModel, buttonBlock, pressurePlateBlock,
  attachStateFor, attachSupportOffset, isWaterAt, stateLight, faceFacing,
  lookFacing, fixedDrop, topHalf,
  PROP, getProp, withProp, stateOf, blockOf,
  RENDER, PASS, TINT, SOUND, TOOL, TIER, PUSH, T, SHAPE,
} from './helpers.js';
import { getBlock } from '../blocks.js';
import { XP, MAP, DIRS, FACING_INDEX, FACING6 } from './data.js';
import { AABB, FACES, HORIZONTAL } from '../../core/math.js';

export function registerRedstone() {
  registerWire();
  registerLogic();
  registerInputs();
  registerRails();
  registerPistons();
  registerMachines();
}

/** FACES index for a PROP.facingAll value. */
function faceOfFacing6(name) {
  switch (name) {
    case 'north': return 4;
    case 'east': return 1;
    case 'south': return 5;
    case 'west': return 0;
    case 'up': return 3;
    default: return 2;
  }
}

/** PROP.facingAll value for a FACES index. */
function facing6OfFace(face) {
  return FACING6[[3, 1, 5, 4, 0, 2][face]];
}

// ---------------------------------------------------------------------------
// Redstone wire
// ---------------------------------------------------------------------------

const WIRE_PROPS = [PROP.power, PROP.redstoneNorth, PROP.redstoneEast,
  PROP.redstoneSouth, PROP.redstoneWest];

function registerWire() {
  const b = def('redstone_wire', {
    properties: WIRE_PROPS,
    defaultState: { power: 0, north: 'none', east: 'none', south: 'none', west: 'none' },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    tint: TINT.REDSTONE,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.STONE,
    mapColor: MAP.fire,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    creativeTab: 'redstone',
    item: 'redstone',
    textures: 'redstone_dust',
    redstone: { component: true, wire: true, source: true },
    model: (state) => boxesToModel(wireBoxes(state), 'redstone_dust',
      { tint: TINT.REDSTONE }),
    collision: () => SHAPE.NONE,
    selection: () => [new AABB(0, 0, 0, 1, 1 / 16, 1)],
    drops: fixedDrop('redstone'),
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y - 1, z)] === 1,
    updateShape: (world, x, y, z, state) => wireShape(world, x, y, z, state),
    onNeighborChange(world, x, y, z, state) {
      world.game?.redstone?.updateWire?.(world, x, y, z, state);
    },
  }, { isWire: true, noConnect: true });

  b.stateForPlacement = (world, x, y, z) =>
    wireShape(world, x, y, z, b.defaultState);
  return b;
}

function wireShape(world, x, y, z, state) {
  let s = state;
  for (let i = 0; i < 4; i++) s = withProp(s, DIRS[i], wireConnection(world, x, y, z, i));
  return s;
}

/**
 * How the wire meets its neighbour in horizontal direction `dir`:
 * 'none', 'side' (flat) or 'up' (climbing the side of a block).
 */
function wireConnection(world, x, y, z, dir) {
  const d = HORIZONTAL[dir];
  const nx = x + d.dx, nz = z + d.dz;
  const ns = world.getBlock(nx, y, nz);
  const nd = blockOf(ns);
  const conductive = T.conductive[ns] === 1;

  if (nd && (nd.isWire || (nd.redstone && (nd.redstone.component || nd.redstone.source)))) {
    return 'side';
  }
  if (conductive) {
    // Wire climbs a solid block only when nothing caps it from above.
    if (T.solid[world.getBlock(x, y + 1, z)] !== 1) {
      const up = blockOf(world.getBlock(nx, y + 1, nz));
      if (up && up.isWire) return 'up';
    }
    return 'none';
  }
  const down = blockOf(world.getBlock(nx, y - 1, nz));
  return (down && down.isWire) ? 'side' : 'none';
}

function wireBoxes(state) {
  const h = 1 / 16;
  const boxes = [new AABB(5 / 16, 0, 5 / 16, 11 / 16, h, 11 / 16)];
  const arm = (dir, v) => {
    if (v === 'none') return;
    switch (dir) {
      case 0: boxes.push(new AABB(5 / 16, 0, 0, 11 / 16, h, 5 / 16)); break;
      case 1: boxes.push(new AABB(11 / 16, 0, 5 / 16, 1, h, 11 / 16)); break;
      case 2: boxes.push(new AABB(5 / 16, 0, 11 / 16, 11 / 16, h, 1)); break;
      default: boxes.push(new AABB(0, 0, 5 / 16, 5 / 16, h, 11 / 16)); break;
    }
    if (v !== 'up') return;
    switch (dir) {
      case 0: boxes.push(new AABB(5 / 16, 0, 0, 11 / 16, 1, h)); break;
      case 1: boxes.push(new AABB(1 - h, 0, 5 / 16, 1, 1, 11 / 16)); break;
      case 2: boxes.push(new AABB(5 / 16, 0, 1 - h, 11 / 16, 1, 1)); break;
      default: boxes.push(new AABB(0, 0, 5 / 16, h, 1, 11 / 16)); break;
    }
  };
  for (let i = 0; i < 4; i++) arm(i, getProp(state, DIRS[i]));
  return boxes;
}

// ---------------------------------------------------------------------------
// Repeater and comparator
// ---------------------------------------------------------------------------

const DIODE_SHAPE = [new AABB(0, 0, 0, 1, 2 / 16, 1)];

function registerLogic() {
  const repeater = def('repeater', {
    properties: [PROP.delay, PROP.facing, PROP.locked, PROP.powered],
    defaultState: { delay: 1, facing: 'north', locked: false, powered: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.STONE,
    mapColor: MAP.none,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    creativeTab: 'redstone',
    redstone: { component: true, diode: true, source: true },
    textures: (state) => (getProp(state, 'powered') ? 'repeater_on' : 'repeater_off'),
    model: (state) => boxesToModel(DIODE_SHAPE,
      getProp(state, 'powered') ? 'repeater_on' : 'repeater_off',
      { emissive: getProp(state, 'powered') ? 7 : 0 }),
    collision: () => DIODE_SHAPE,
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y - 1, z)] === 1,
    onUse(world, x, y, z, state) {
      const delay = getProp(state, 'delay');
      world.setBlock(x, y, z, withProp(state, 'delay', delay >= 4 ? 1 : delay + 1));
      world.playSound('click.repeater', x + 0.5, y + 0.5, z + 0.5);
      return true;
    },
    onNeighborChange(world, x, y, z, state) {
      world.game?.redstone?.updateDiode?.(world, x, y, z, state);
    },
    onScheduledTick(world, x, y, z, state) {
      world.game?.redstone?.tickDiode?.(world, x, y, z, state);
    },
  }, { isDiode: true, noConnect: true });
  repeater.stateForPlacement = (world, x, y, z, ctx) => stateOf(repeater, {
    delay: 1, facing: DIRS[faceFacing(ctx)], locked: false, powered: false,
  });

  const comparator = def('comparator', {
    properties: [PROP.facing, PROP.mode, PROP.powered],
    defaultState: { facing: 'north', mode: 'compare', powered: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.STONE,
    mapColor: MAP.none,
    solid: false,
    opaque: false,
    hasEntity: true,
    push: PUSH.DESTROY,
    creativeTab: 'redstone',
    redstone: { component: true, diode: true, source: true },
    textures: (state) => (getProp(state, 'powered') ? 'comparator_on' : 'comparator_off'),
    model: (state) => boxesToModel(DIODE_SHAPE,
      getProp(state, 'powered') ? 'comparator_on' : 'comparator_off',
      { emissive: getProp(state, 'powered') ? 7 : 0 }),
    collision: () => DIODE_SHAPE,
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y - 1, z)] === 1,
    onUse(world, x, y, z, state) {
      const mode = getProp(state, 'mode') === 'compare' ? 'subtract' : 'compare';
      world.setBlock(x, y, z, withProp(state, 'mode', mode));
      world.playSound('click.comparator', x + 0.5, y + 0.5, z + 0.5);
      return true;
    },
    onNeighborChange(world, x, y, z, state) {
      world.game?.redstone?.updateComparator?.(world, x, y, z, state);
    },
    onScheduledTick(world, x, y, z, state) {
      world.game?.redstone?.tickComparator?.(world, x, y, z, state);
    },
  }, { isDiode: true, blockEntity: 'comparator', noConnect: true });
  comparator.stateForPlacement = (world, x, y, z, ctx) => stateOf(comparator, {
    facing: DIRS[faceFacing(ctx)], mode: 'compare', powered: false,
  });
}

// ---------------------------------------------------------------------------
// Player inputs: lever, buttons, plates, tripwire, daylight detector
// ---------------------------------------------------------------------------

function registerInputs() {
  const lever = def('lever', {
    properties: [PROP.attach, PROP.facing, PROP.powered],
    defaultState: { face: 'wall', facing: 'north', powered: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0.5,
    blastResistance: 0.5,
    sound: SOUND.WOOD,
    mapColor: MAP.none,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    creativeTab: 'redstone',
    redstone: { component: true, source: true, power: 15 },
    textures: 'lever',
    model: (state) => boxesToModel(leverBoxes(state), 'lever'),
    collision: () => SHAPE.NONE,
    selection: leverBoxes,
    canSurvive(world, x, y, z, state) {
      const [dx, dy, dz] = attachSupportOffset(state);
      return T.solid[world.getBlock(x + dx, y + dy, z + dz)] === 1;
    },
    onUse(world, x, y, z, state) {
      const powered = !getProp(state, 'powered');
      world.setBlock(x, y, z, withProp(state, 'powered', powered));
      world.playSound(powered ? 'click.on' : 'click.off', x + 0.5, y + 0.5, z + 0.5);
      world.game?.redstone?.update?.(world, x, y, z);
      return true;
    },
  }, { noConnect: true });
  lever.stateForPlacement = (world, x, y, z, ctx) =>
    stateOf(lever, Object.assign({ powered: false }, attachStateFor(ctx)));

  buttonBlock('stone_button', 'stone', mat(MAT.stone, {
    hardness: 0.5, blastResistance: 0.5, requiresTool: false, family: 'stone',
  }));
  buttonBlock('polished_blackstone_button', 'polished_blackstone', mat(MAT.stone, {
    hardness: 0.5, blastResistance: 0.5, requiresTool: false,
    family: 'polished_blackstone', mapColor: MAP.black,
  }));

  pressurePlateBlock('stone_pressure_plate', 'stone', mat(MAT.stone, {
    hardness: 0.5, blastResistance: 0.5, weighted: 'mobs', family: 'stone',
  }));
  pressurePlateBlock('polished_blackstone_pressure_plate', 'polished_blackstone',
    mat(MAT.stone, {
      hardness: 0.5, blastResistance: 0.5, weighted: 'mobs',
      family: 'polished_blackstone', mapColor: MAP.black,
    }));
  pressurePlateBlock('light_weighted_pressure_plate', 'gold_block', mat(MAT.metal, {
    hardness: 0.5, blastResistance: 0.5, tier: TIER.WOOD, weighted: 'items_light',
    mapColor: MAP.gold,
  }));
  pressurePlateBlock('heavy_weighted_pressure_plate', 'iron_block', mat(MAT.metal, {
    hardness: 0.5, blastResistance: 0.5, tier: TIER.WOOD, weighted: 'items_heavy',
    mapColor: MAP.metal,
  }));

  // Tripwire is the string laid between two hooks.
  def('tripwire', {
    properties: [PROP.attached, PROP.disarmed, PROP.powered,
      PROP.north, PROP.east, PROP.south, PROP.west],
    defaultState: {
      attached: false, disarmed: false, powered: false,
      north: false, east: false, south: false, west: false,
    },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.CLOTH,
    mapColor: MAP.none,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    item: 'string',
    creativeTab: null,
    redstone: { component: true },
    textures: 'tripwire',
    model: (state) => boxesToModel(
      [new AABB(0, getProp(state, 'attached') ? 1.5 / 16 : 1 / 16, 0,
        1, getProp(state, 'attached') ? 2.5 / 16 : 2 / 16, 1)], 'tripwire'),
    collision: () => SHAPE.NONE,
    selection: () => [new AABB(0, 0, 0, 1, 2.5 / 16, 1)],
    drops: fixedDrop('string'),
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y - 1, z)] === 1,
    onEntityInside(world, x, y, z, state) {
      if (getProp(state, 'powered')) return;
      world.setBlock(x, y, z, withProp(state, 'powered', true));
      world.scheduleTick(x, y, z, blockOf(state), 10);
      world.game?.redstone?.update?.(world, x, y, z);
    },
    onScheduledTick(world, x, y, z, state) {
      const box = new AABB(x, y, z, x + 1, y + 0.5, z + 1);
      if (world.entitiesInBox(box).length > 0) {
        world.scheduleTick(x, y, z, blockOf(state), 10);
        return;
      }
      world.setBlock(x, y, z, withProp(state, 'powered', false));
      world.game?.redstone?.update?.(world, x, y, z);
    },
  }, { noConnect: true });

  const hook = def('tripwire_hook', {
    properties: [PROP.attached, PROP.facing, PROP.powered],
    defaultState: { attached: false, facing: 'north', powered: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.WOOD,
    mapColor: MAP.none,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    creativeTab: 'redstone',
    redstone: { component: true, source: true },
    textures: 'tripwire_hook',
    model: (state) => boxesToModel(hookBoxes(state), 'tripwire_hook'),
    collision: () => SHAPE.NONE,
    selection: hookBoxes,
    canSurvive(world, x, y, z, state) {
      const d = HORIZONTAL[(FACING_INDEX[getProp(state, 'facing')] + 2) & 3];
      return T.solid[world.getBlock(x + d.dx, y, z + d.dz)] === 1;
    },
  }, { noConnect: true });
  hook.stateForPlacement = (world, x, y, z, ctx) => stateOf(hook, {
    attached: false, facing: DIRS[faceFacing(ctx)], powered: false,
  });

  const detector = def('daylight_detector', mat(MAT.wood, {
    properties: [XP.inverted, PROP.power],
    defaultState: { inverted: false, power: 0 },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0.2,
    blastResistance: 0.2,
    solid: false,
    opaque: false,
    hasEntity: true,
    creativeTab: 'redstone',
    redstone: { component: true, source: true },
    textures: {
      top: 'daylight_detector_top', side: 'daylight_detector_side',
      bottom: 'daylight_detector_side',
    },
    model: () => boxesToModel(SHAPE.daylightDetector, {
      top: 'daylight_detector_top', side: 'daylight_detector_side',
      bottom: 'daylight_detector_side',
    }),
    collision: () => SHAPE.daylightDetector,
    onUse(world, x, y, z, state) {
      world.setBlock(x, y, z, withProp(state, 'inverted', !getProp(state, 'inverted')));
      return true;
    },
    onScheduledTick(world, x, y, z, state) {
      // Re-read the sky every couple of seconds; the redstone solver reads the
      // resulting `power` property like any other source.
      const sky = world.getSkyLight(x, y + 1, z);
      const day = Math.floor(sky * world.skyLightFactor());
      const power = getProp(state, 'inverted') ? 15 - day : day;
      if (power !== getProp(state, 'power')) {
        world.setBlock(x, y, z, withProp(state, 'power', power));
      }
      world.scheduleTick(x, y, z, blockOf(state), 20);
    },
    onPlace(world, x, y, z, state) {
      world.scheduleTick(x, y, z, blockOf(state), 1);
    },
  }), { noConnect: true });
  void detector;
}

function leverBoxes(state) {
  const face = getProp(state, 'face');
  const f = FACING_INDEX[getProp(state, 'facing')];
  const w = 3 / 16, d = 6 / 16;
  if (face === 'floor') return [new AABB(0.5 - w, 0, 0.5 - w, 0.5 + w, d, 0.5 + w)];
  if (face === 'ceiling') return [new AABB(0.5 - w, 1 - d, 0.5 - w, 0.5 + w, 1, 0.5 + w)];
  switch (f) {
    case 0: return [new AABB(0.5 - w, 0.5 - w, 1 - d, 0.5 + w, 0.5 + w, 1)];
    case 1: return [new AABB(0, 0.5 - w, 0.5 - w, d, 0.5 + w, 0.5 + w)];
    case 2: return [new AABB(0.5 - w, 0.5 - w, 0, 0.5 + w, 0.5 + w, d)];
    default: return [new AABB(1 - d, 0.5 - w, 0.5 - w, 1, 0.5 + w, 0.5 + w)];
  }
}

function hookBoxes(state) {
  const f = FACING_INDEX[getProp(state, 'facing')];
  const t = 5 / 16;
  switch (f) {
    case 0: return [new AABB(5 / 16, 0, 1 - t, 11 / 16, 1, 1)];
    case 1: return [new AABB(0, 0, 5 / 16, t, 1, 11 / 16)];
    case 2: return [new AABB(5 / 16, 0, 0, 11 / 16, 1, t)];
    default: return [new AABB(1 - t, 0, 5 / 16, 1, 1, 11 / 16)];
  }
}

// ---------------------------------------------------------------------------
// Rails
// ---------------------------------------------------------------------------

const RAIL_SHAPE = [new AABB(0, 0, 0, 1, 1 / 16, 1)];
const RAIL_SLOPE = [new AABB(0, 0, 0, 1, 8 / 16, 1)];

function railBlock(name, o = {}) {
  const powered = !!o.powered;
  const shapeProp = powered ? PROP.poweredRailShape : PROP.railShape;
  const props = powered
    ? [PROP.powered, shapeProp, PROP.waterlogged]
    : [shapeProp, PROP.waterlogged];
  const defaults = powered
    ? { powered: false, shape: 'north_south', waterlogged: false }
    : { shape: 'north_south', waterlogged: false };

  const b = def(name, {
    properties: props,
    defaultState: defaults,
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0.7,
    blastResistance: 0.7,
    tool: TOOL.PICKAXE,
    sound: SOUND.METAL,
    mapColor: MAP.none,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    creativeTab: 'transportation',
    redstone: o.redstone || null,
    textures: (state) => railTexture(name, state, powered),
    model: (state) => boxesToModel(railBoxes(state),
      railTexture(name, state, powered)),
    collision: () => SHAPE.NONE,
    selection: (state) => railBoxes(state),
    canSurvive(world, x, y, z, state) {
      if (T.solid[world.getBlock(x, y - 1, z)] !== 1) return false;
      const shape = getProp(state, 'shape');
      // An ascending rail needs its high end supported too.
      if (shape.startsWith('ascending')) {
        const dir = { ascending_north: 0, ascending_east: 1, ascending_south: 2, ascending_west: 3 }[shape];
        const d = HORIZONTAL[dir];
        return T.solid[world.getBlock(x + d.dx, y, z + d.dz)] === 1 ||
          world.getBlock(x + d.dx, y, z + d.dz) === 0;
      }
      return true;
    },
    updateShape: (world, x, y, z, state) => railShapeFor(world, x, y, z, state, powered),
  }, { isRail: true, noConnect: true });

  b.stateForPlacement = (world, x, y, z, ctx) => {
    const base = stateOf(b, Object.assign({}, defaults, {
      waterlogged: isWaterAt(world, x, y, z),
    }));
    return railShapeFor(world, x, y, z, base, powered);
  };
  return b;
}

function railTexture(name, state, powered) {
  if (!powered) return name;
  return getProp(state, 'powered') ? `${name}_on` : name;
}

function railBoxes(state) {
  return getProp(state, 'shape').startsWith('ascending') ? RAIL_SLOPE : RAIL_SHAPE;
}

/**
 * Pick a shape that links up with neighbouring rails.
 * Straight rails may curve; powered rails may not, matching vanilla.
 */
function railShapeFor(world, x, y, z, state, powered) {
  const links = [];
  for (let i = 0; i < 4; i++) {
    const d = HORIZONTAL[i];
    if (isRailAt(world, x + d.dx, y, z + d.dz) ||
      isRailAt(world, x + d.dx, y + 1, z + d.dz) ||
      isRailAt(world, x + d.dx, y - 1, z + d.dz)) links.push(i);
  }
  let shape = getProp(state, 'shape');
  if (links.length === 0) {
    shape = 'north_south';
  } else if (links.length === 1) {
    shape = (links[0] & 1) ? 'east_west' : 'north_south';
  } else {
    const a = links[0], b = links[1];
    if ((a & 1) === (b & 1)) shape = (a & 1) ? 'east_west' : 'north_south';
    else if (!powered) shape = cornerShape(a, b);
    else shape = (a & 1) ? 'east_west' : 'north_south';
  }
  // Rise toward a neighbour one block higher.
  for (const dir of links) {
    const d = HORIZONTAL[dir];
    if (isRailAt(world, x + d.dx, y + 1, z + d.dz)) {
      const asc = ['ascending_north', 'ascending_east', 'ascending_south', 'ascending_west'][dir];
      if ((dir & 1) === (shape === 'east_west' ? 1 : 0)) shape = asc;
      break;
    }
  }
  return withProp(state, 'shape', shape);
}

function cornerShape(a, b) {
  const set = new Set([a, b]);
  if (set.has(2) && set.has(1)) return 'south_east';
  if (set.has(2) && set.has(3)) return 'south_west';
  if (set.has(0) && set.has(3)) return 'north_west';
  return 'north_east';
}

function isRailAt(world, x, y, z) {
  const d = blockOf(world.getBlock(x, y, z));
  return !!d && d.isRail === true;
}

function registerRails() {
  railBlock('rail');
  railBlock('powered_rail', { powered: true, redstone: { component: true } });
  railBlock('detector_rail', {
    powered: true, redstone: { component: true, source: true },
  });
  railBlock('activator_rail', { powered: true, redstone: { component: true } });
}

// ---------------------------------------------------------------------------
// Pistons
// ---------------------------------------------------------------------------

function registerPistons() {
  for (const sticky of [false, true]) {
    const name = sticky ? 'sticky_piston' : 'piston';
    const b = def(name, mat(MAT.stone, {
      properties: [PROP.facingAll, PROP.extended],
      defaultState: { facing: 'north', extended: false },
      render: RENDER.MODEL,
      hardness: 1.5,
      blastResistance: 1.5,
      requiresTool: false,
      tool: TOOL.PICKAXE,
      mapColor: MAP.stone,
      opaque: false,
      push: PUSH.BLOCK,
      creativeTab: 'redstone',
      textures: (state) => pistonFaces(state, sticky),
      model: (state) => boxesToModel(
        getProp(state, 'extended') ? pistonBaseBoxes(state) : SHAPE.FULL,
        pistonFaces(state, sticky)),
      collision: (state) => (getProp(state, 'extended')
        ? pistonBaseBoxes(state) : SHAPE.FULL),
      onNeighborChange(world, x, y, z, state) {
        world.game?.redstone?.updatePiston?.(world, x, y, z, state, sticky);
      },
    }), { isPiston: true, sticky, noConnect: true });
    b.stateForPlacement = (world, x, y, z, ctx) => stateOf(b, {
      // A piston points away from the player, including straight up or down.
      facing: pistonFacing(ctx),
      extended: false,
    });
  }

  const head = def('piston_head', mat(MAT.stone, {
    properties: [PROP.facingAll, PROP.pistonType, PROP.short],
    defaultState: { facing: 'north', type: 'normal', short: false },
    render: RENDER.MODEL,
    hardness: 1.5,
    blastResistance: 1.5,
    requiresTool: false,
    tool: TOOL.PICKAXE,
    solid: false,
    opaque: false,
    push: PUSH.BLOCK,
    item: null,
    creativeTab: null,
    drops: () => [],
    textures: (state) => (getProp(state, 'type') === 'sticky'
      ? 'piston_top_sticky' : 'piston_top'),
    model: (state) => boxesToModel(pistonHeadBoxes(state),
      getProp(state, 'type') === 'sticky' ? 'piston_top_sticky' : 'piston_top'),
    collision: pistonHeadBoxes,
    canSurvive(world, x, y, z, state) {
      const f = FACES[faceOfFacing6(getProp(state, 'facing'))];
      const base = blockOf(world.getBlock(x - f.dx, y - f.dy, z - f.dz));
      return !!base && base.isPiston === true;
    },
  }), { noConnect: true });
  void head;

  // The moving piston is a placeholder holding the block entity that animates
  // whatever is being pushed; it never renders itself.
  def('moving_piston', mat(MAT.stone, {
    properties: [PROP.facingAll, PROP.pistonType],
    defaultState: { facing: 'north', type: 'normal' },
    render: RENDER.INVISIBLE,
    hardness: -1,
    blastResistance: -1,
    solid: false,
    opaque: false,
    push: PUSH.BLOCK,
    hasEntity: true,
    item: null,
    creativeTab: null,
    drops: () => [],
    collision: () => SHAPE.NONE,
    selection: () => SHAPE.NONE,
  }), { blockEntity: 'piston', noConnect: true });
}

/** Pistons and observers aim along the player's full look direction. */
function pistonFacing(ctx) {
  const pitch = (ctx && ctx.pitch) || 0;
  if (pitch < -Math.PI / 3) return 'down';
  if (pitch > Math.PI / 3) return 'up';
  return DIRS[(lookFacing(ctx) + 2) & 3];
}

function pistonFaces(state, sticky) {
  const f = faceOfFacing6(getProp(state, 'facing'));
  const tex = ['piston_side', 'piston_side', 'piston_side', 'piston_side',
    'piston_side', 'piston_side'];
  tex[f] = getProp(state, 'extended') ? 'piston_inner'
    : (sticky ? 'piston_top_sticky' : 'piston_top');
  tex[FACES[f].opposite] = 'piston_bottom';
  return tex;
}

function pistonBaseBoxes(state) {
  const f = FACES[faceOfFacing6(getProp(state, 'facing'))];
  const d = 4 / 16;
  if (f.dx) return [f.dx > 0 ? new AABB(0, 0, 0, 1 - d, 1, 1) : new AABB(d, 0, 0, 1, 1, 1)];
  if (f.dy) return [f.dy > 0 ? new AABB(0, 0, 0, 1, 1 - d, 1) : new AABB(0, d, 0, 1, 1, 1)];
  return [f.dz > 0 ? new AABB(0, 0, 0, 1, 1, 1 - d) : new AABB(0, 0, d, 1, 1, 1)];
}

function pistonHeadBoxes(state) {
  const f = FACES[faceOfFacing6(getProp(state, 'facing'))];
  const plate = 4 / 16, rodHalf = 2 / 16;
  const boxes = [];
  // Head plate at the far end plus the rod reaching back to the piston body.
  if (f.dx) {
    boxes.push(f.dx > 0 ? new AABB(1 - plate, 0, 0, 1, 1, 1) : new AABB(0, 0, 0, plate, 1, 1));
    boxes.push(new AABB(f.dx > 0 ? 0 : plate, 0.5 - rodHalf, 0.5 - rodHalf,
      f.dx > 0 ? 1 - plate : 1, 0.5 + rodHalf, 0.5 + rodHalf));
  } else if (f.dy) {
    boxes.push(f.dy > 0 ? new AABB(0, 1 - plate, 0, 1, 1, 1) : new AABB(0, 0, 0, 1, plate, 1));
    boxes.push(new AABB(0.5 - rodHalf, f.dy > 0 ? 0 : plate, 0.5 - rodHalf,
      0.5 + rodHalf, f.dy > 0 ? 1 - plate : 1, 0.5 + rodHalf));
  } else {
    boxes.push(f.dz > 0 ? new AABB(0, 0, 1 - plate, 1, 1, 1) : new AABB(0, 0, 0, 1, 1, plate));
    boxes.push(new AABB(0.5 - rodHalf, 0.5 - rodHalf, f.dz > 0 ? 0 : plate,
      0.5 + rodHalf, 0.5 + rodHalf, f.dz > 0 ? 1 - plate : 1));
  }
  return boxes;
}

// ---------------------------------------------------------------------------
// Machines: dispensers, observers, note blocks, lamps, torches
// ---------------------------------------------------------------------------

function registerMachines() {
  for (const name of ['dispenser', 'dropper']) {
    const b = def(name, mat(MAT.stone, {
      properties: [PROP.facingAll, PROP.triggered],
      defaultState: { facing: 'north', triggered: false },
      hardness: 3.5,
      blastResistance: 3.5,
      hasEntity: true,
      container: { slots: 9, type: name },
      creativeTab: 'redstone',
      textures: (state) => {
        const f = faceOfFacing6(getProp(state, 'facing'));
        const side = name === 'dispenser' ? 'furnace_side' : 'furnace_side';
        const tex = [side, side, side, side, side, side];
        tex[f] = f === 3 || f === 2 ? `${name}_front_vertical` : `${name}_front`;
        tex[FACES[f].opposite] = 'furnace_top';
        return tex;
      },
      onUse(world, x, y, z, state, player) {
        world.game?.ui?.openContainer?.(world, x, y, z, player);
        return true;
      },
      onNeighborChange(world, x, y, z, state) {
        world.game?.redstone?.updateDispenser?.(world, x, y, z, state);
      },
    }), { blockEntity: name });
    b.stateForPlacement = (world, x, y, z, ctx) =>
      stateOf(b, { facing: pistonFacing(ctx), triggered: false });
  }

  const observer = def('observer', mat(MAT.stone, {
    properties: [PROP.facingAll, PROP.powered],
    defaultState: { facing: 'south', powered: false },
    hardness: 3,
    blastResistance: 3,
    creativeTab: 'redstone',
    redstone: { component: true, source: true },
    textures: (state) => {
      const f = faceOfFacing6(getProp(state, 'facing'));
      const tex = ['observer_side', 'observer_side', 'observer_top', 'observer_top',
        'observer_side', 'observer_side'];
      tex[f] = 'observer_front';
      tex[FACES[f].opposite] = getProp(state, 'powered') ? 'observer_back_on' : 'observer_back';
      return tex;
    },
    onNeighborChange(world, x, y, z, state) {
      world.game?.redstone?.updateObserver?.(world, x, y, z, state);
    },
    onScheduledTick(world, x, y, z, state) {
      if (getProp(state, 'powered')) {
        world.setBlock(x, y, z, withProp(state, 'powered', false));
      }
      world.game?.redstone?.update?.(world, x, y, z);
    },
  }), { noConnect: true });
  observer.stateForPlacement = (world, x, y, z, ctx) => stateOf(observer, {
    // An observer watches whatever the player was looking at.
    facing: facing6OfFace(ctx && ctx.face != null ? FACES[ctx.face].opposite : 5),
    powered: false,
  });

  const noteBlock = def('note_block', mat(MAT.wood, {
    properties: [PROP.instrument, PROP.note, PROP.powered],
    defaultState: { instrument: 'harp', note: 0, powered: false },
    hardness: 0.8,
    blastResistance: 0.8,
    creativeTab: 'redstone',
    textures: 'note_block',
    onUse(world, x, y, z, state) {
      const note = (getProp(state, 'note') + 1) % 25;
      world.setBlock(x, y, z, withProp(state, 'note', note));
      world.game?.audio?.playNote?.(world, x, y, z, getProp(state, 'instrument'), note);
      return true;
    },
    onNeighborChange(world, x, y, z, state) {
      // The instrument follows whatever material sits underneath.
      const below = blockOf(world.getBlock(x, y - 1, z));
      const instrument = below ? (below.instrument || 'harp') : 'harp';
      if (instrument !== getProp(state, 'instrument')) {
        world.setBlock(x, y, z, withProp(state, 'instrument', instrument));
      }
    },
  }), { noConnect: true });
  void noteBlock;

  const lamp = def('redstone_lamp', mat(MAT.glass, {
    properties: [PROP.lit],
    defaultState: { lit: false },
    hardness: 0.3,
    blastResistance: 0.3,
    sound: SOUND.GLASS,
    mapColor: MAP.sand,
    creativeTab: 'redstone',
    textures: (state) => (getProp(state, 'lit') ? 'redstone_lamp_on' : 'redstone_lamp'),
    onNeighborChange(world, x, y, z, state) {
      const powered = !!world.game?.redstone?.hasSignal?.(world, x, y, z);
      if (powered !== getProp(state, 'lit')) {
        world.setBlock(x, y, z, withProp(state, 'lit', powered));
      }
    },
  }));
  stateLight(lamp, (state) => (getProp(state, 'lit') ? 15 : 0));

  redstoneTorches();

  const target = def('target', mat(MAT.wool, {
    properties: [PROP.power],
    defaultState: { power: 0 },
    hardness: 0.5,
    blastResistance: 0.5,
    tool: TOOL.NONE,
    sound: SOUND.GRASS,
    mapColor: MAP.quartz,
    flammable: 0,
    burnTime: 0,
    creativeTab: 'redstone',
    redstone: { component: true, source: true },
    textures: { top: 'target_top', side: 'target_side', bottom: 'target_top' },
    onScheduledTick(world, x, y, z, state) {
      if (getProp(state, 'power') !== 0) world.setBlock(x, y, z, withProp(state, 'power', 0));
    },
  }));
  void target;

  const rod = def('lightning_rod', mat(MAT.copper, {
    properties: [PROP.facingAll, PROP.powered, PROP.waterlogged],
    defaultState: { facing: 'up', powered: false, waterlogged: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 3,
    blastResistance: 6,
    solid: false,
    opaque: false,
    creativeTab: 'functional',
    redstone: { component: true, source: true },
    textures: 'lightning_rod',
    model: (state) => boxesToModel(rodBoxes(state), 'lightning_rod'),
    collision: rodBoxes,
    onScheduledTick(world, x, y, z, state) {
      if (getProp(state, 'powered')) {
        world.setBlock(x, y, z, withProp(state, 'powered', false));
      }
    },
  }), { noConnect: true });
  rod.stateForPlacement = (world, x, y, z, ctx) => stateOf(rod, {
    facing: facing6OfFace(ctx && ctx.face != null ? ctx.face : 3),
    powered: false,
    waterlogged: isWaterAt(world, x, y, z),
  });
}

function rodBoxes(state) {
  const f = FACES[faceOfFacing6(getProp(state, 'facing'))];
  const a = 6 / 16, b = 10 / 16;
  if (f.dx) return [f.dx > 0 ? new AABB(0, a, a, b, b, b) : new AABB(a, a, a, 1, b, b)];
  if (f.dy) return [f.dy > 0 ? new AABB(a, 0, a, b, b, b) : new AABB(a, a, a, b, 1, b)];
  return [f.dz > 0 ? new AABB(a, a, 0, b, b, b) : new AABB(a, a, a, b, b, 1)];
}

function redstoneTorches() {
  const torch = def('redstone_torch', {
    properties: [PROP.lit],
    defaultState: { lit: true },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.WOOD,
    mapColor: MAP.none,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    creativeTab: 'redstone',
    redstone: { component: true, source: true, power: 15 },
    textures: (state) => (getProp(state, 'lit') ? 'redstone_torch' : 'redstone_torch_off'),
    model: (state) => boxesToModel(SHAPE.torchShape,
      getProp(state, 'lit') ? 'redstone_torch' : 'redstone_torch_off',
      { emissive: getProp(state, 'lit') ? 7 : 0 }),
    collision: () => SHAPE.NONE,
    selection: () => SHAPE.torchShape,
    canSurvive: (world, x, y, z) => T.solid[world.getBlock(x, y - 1, z)] === 1,
    onNeighborChange(world, x, y, z, state) {
      world.game?.redstone?.updateTorch?.(world, x, y, z, state);
    },
    onScheduledTick(world, x, y, z, state) {
      world.game?.redstone?.tickTorch?.(world, x, y, z, state);
    },
  }, { isTorch: true, noConnect: true });
  stateLight(torch, (state) => (getProp(state, 'lit') ? 7 : 0));

  const wall = def('redstone_wall_torch', {
    properties: [PROP.facing, PROP.lit],
    defaultState: { facing: 'north', lit: true },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 0,
    blastResistance: 0,
    sound: SOUND.WOOD,
    mapColor: MAP.none,
    solid: false,
    opaque: false,
    push: PUSH.DESTROY,
    item: 'redstone_torch',
    creativeTab: null,
    redstone: { component: true, source: true, power: 15 },
    textures: (state) => (getProp(state, 'lit') ? 'redstone_torch' : 'redstone_torch_off'),
    model: (state) => boxesToModel(
      SHAPE.wallTorchShape(FACING_INDEX[getProp(state, 'facing')]),
      getProp(state, 'lit') ? 'redstone_torch' : 'redstone_torch_off',
      { emissive: getProp(state, 'lit') ? 7 : 0 }),
    collision: () => SHAPE.NONE,
    selection: (state) => SHAPE.wallTorchShape(FACING_INDEX[getProp(state, 'facing')]),
    canSurvive(world, x, y, z, state) {
      const d = HORIZONTAL[(FACING_INDEX[getProp(state, 'facing')] + 2) & 3];
      return T.solid[world.getBlock(x + d.dx, y, z + d.dz)] === 1;
    },
    onNeighborChange(world, x, y, z, state) {
      world.game?.redstone?.updateTorch?.(world, x, y, z, state);
    },
    onScheduledTick(world, x, y, z, state) {
      world.game?.redstone?.tickTorch?.(world, x, y, z, state);
    },
  }, { isTorch: true, noConnect: true });
  stateLight(wall, (state) => (getProp(state, 'lit') ? 7 : 0));
  wall.stateForPlacement = (world, x, y, z, ctx) =>
    stateOf(wall, { facing: DIRS[wallTorchFacing(ctx)], lit: true });
}

/** A wall torch points away from the surface it was placed against. */
function wallTorchFacing(ctx) {
  const face = ctx ? ctx.face : 4;
  switch (face) {
    case 4: return 0;   // clicked a north face -> torch faces north
    case 1: return 1;
    case 5: return 2;
    case 0: return 3;
    default: return 0;
  }
}

export { faceOfFacing6, facing6OfFace, pistonFacing };
