// Block state encoding.
//
// Like Minecraft's "flattening", every distinct combination of a block's
// properties gets its own 16-bit state id. Blocks reserve a contiguous id range
// at registration; lookup tables map an id straight back to its definition and
// property values with no allocation.

/** Maximum number of distinct block states. Stored in a Uint16Array. */
export const MAX_STATES = 65536;

/** stateId -> BlockDef */
export const stateToBlock = new Array(MAX_STATES).fill(null);
/** stateId -> index within the block's own state range */
export const stateToMeta = new Uint16Array(MAX_STATES);

let nextState = 0;

/** Reserve `count` consecutive state ids for `block`; returns the base id. */
export function allocStates(block, count) {
  if (nextState + count > MAX_STATES) {
    throw new Error(`block state space exhausted registering ${block.name}`);
  }
  const base = nextState;
  for (let i = 0; i < count; i++) {
    stateToBlock[base + i] = block;
    stateToMeta[base + i] = i;
  }
  nextState += count;
  return base;
}

export function statesUsed() { return nextState; }

/** The block definition for a state id. */
export const blockOf = (state) => stateToBlock[state];
/** The property index within the owning block's range. */
export const metaOf = (state) => stateToMeta[state];

/**
 * A property is a named, ordered set of values. Property objects are shared
 * between blocks so `PROP.facing` is identical everywhere it appears.
 */
export class Property {
  constructor(name, values) {
    this.name = name;
    this.values = values;
    this.count = values.length;
    this.index = new Map();
    values.forEach((v, i) => this.index.set(v, i));
  }
  indexOf(value) {
    const i = this.index.get(value);
    return i === undefined ? 0 : i;
  }
}

const boolProp = (name) => new Property(name, [false, true]);
const intProp = (name, min, max) => {
  const vals = [];
  for (let i = min; i <= max; i++) vals.push(i);
  return new Property(name, vals);
};

/** Shared property definitions. */
export const PROP = {
  facing: new Property('facing', ['north', 'east', 'south', 'west']),
  facingAll: new Property('facing', ['north', 'east', 'south', 'west', 'up', 'down']),
  axis: new Property('axis', ['y', 'x', 'z']),
  half: new Property('half', ['bottom', 'top']),
  slabType: new Property('type', ['bottom', 'top', 'double']),
  stairShape: new Property('shape', ['straight', 'inner_left', 'inner_right', 'outer_left', 'outer_right']),
  hinge: new Property('hinge', ['left', 'right']),
  open: boolProp('open'),
  powered: boolProp('powered'),
  lit: boolProp('lit'),
  waterlogged: boolProp('waterlogged'),
  snowy: boolProp('snowy'),
  persistent: boolProp('persistent'),
  extended: boolProp('extended'),
  attached: boolProp('attached'),
  occupied: boolProp('occupied'),
  bedPart: new Property('part', ['foot', 'head']),
  chestType: new Property('type', ['single', 'left', 'right']),
  age3: intProp('age', 0, 3),
  age7: intProp('age', 0, 7),
  age15: intProp('age', 0, 15),
  age25: intProp('age', 0, 25),
  level8: intProp('level', 0, 8),
  power: intProp('power', 0, 15),
  delay: intProp('delay', 1, 4),
  distance: intProp('distance', 1, 7),
  layers: intProp('layers', 1, 8),
  bites: intProp('bites', 0, 6),
  rotation16: intProp('rotation', 0, 15),
  moisture: intProp('moisture', 0, 7),
  eggs: intProp('eggs', 1, 4),
  hatch: intProp('hatch', 0, 2),
  charges: intProp('charges', 0, 4),
  mode: new Property('mode', ['compare', 'subtract']),
  pistonType: new Property('type', ['normal', 'sticky']),
  attach: new Property('face', ['floor', 'wall', 'ceiling']),
  north: boolProp('north'),
  east: boolProp('east'),
  south: boolProp('south'),
  west: boolProp('west'),
  up: boolProp('up'),
  down: boolProp('down'),
  wallNorth: new Property('north', ['none', 'low', 'tall']),
  wallEast: new Property('east', ['none', 'low', 'tall']),
  wallSouth: new Property('south', ['none', 'low', 'tall']),
  wallWest: new Property('west', ['none', 'low', 'tall']),
  redstoneNorth: new Property('north', ['none', 'side', 'up']),
  redstoneEast: new Property('east', ['none', 'side', 'up']),
  redstoneSouth: new Property('south', ['none', 'side', 'up']),
  redstoneWest: new Property('west', ['none', 'side', 'up']),
  railShape: new Property('shape', [
    'north_south', 'east_west', 'ascending_east', 'ascending_west',
    'ascending_north', 'ascending_south', 'south_east', 'south_west',
    'north_west', 'north_east']),
  poweredRailShape: new Property('shape', [
    'north_south', 'east_west', 'ascending_east', 'ascending_west',
    'ascending_north', 'ascending_south']),
  leavesType: new Property('variant', ['normal']),
  instrument: new Property('instrument', [
    'harp', 'basedrum', 'snare', 'hat', 'bass', 'flute', 'bell',
    'guitar', 'chime', 'xylophone']),
  note: intProp('note', 0, 24),
  thickness: new Property('thickness', ['tip', 'frustum', 'middle', 'base']),
  vertical: new Property('vertical_direction', ['up', 'down']),
  sculkPhase: new Property('sculk_sensor_phase', ['inactive', 'active', 'cooldown']),
  signal: intProp('signal', 0, 15),
  candles: intProp('candles', 1, 4),
  berries: boolProp('berries'),
  bottom: boolProp('bottom'),
  hanging: boolProp('hanging'),
  short: boolProp('short'),
  locked: boolProp('locked'),
  inWall: boolProp('in_wall'),
  triggered: boolProp('triggered'),
  unstable: boolProp('unstable'),
  disarmed: boolProp('disarmed'),
  conditional: boolProp('conditional'),
  drag: boolProp('drag'),
  hasBottle0: boolProp('has_bottle_0'),
  hasBottle1: boolProp('has_bottle_1'),
  hasBottle2: boolProp('has_bottle_2'),
  hasBook: boolProp('has_book'),
  hasRecord: boolProp('has_record'),
  honeyLevel: intProp('honey_level', 0, 5),
  pickles: intProp('pickles', 1, 4),
  stage: intProp('stage', 0, 1),
  leaves: new Property('leaves', ['none', 'small', 'large']),
  tilt: new Property('tilt', ['none', 'unstable', 'partial', 'full']),
  orientation: new Property('orientation', ['down_east', 'down_north', 'down_south', 'down_west', 'up_east', 'up_north', 'up_south', 'up_west', 'west_up', 'east_up', 'north_up', 'south_up']),
};

/**
 * A property container attached to a block definition. Handles the arithmetic
 * between a property map and a state offset.
 */
export class StateDefinition {
  /** @param {Property[]} properties in a fixed order */
  constructor(properties) {
    this.properties = properties;
    this.count = 1;
    this.strides = [];
    // Later properties vary fastest, matching how the tables read.
    for (let i = properties.length - 1; i >= 0; i--) {
      this.strides[i] = this.count;
      this.count *= properties[i].count;
    }
    this.byName = new Map();
    properties.forEach((p, i) => this.byName.set(p.name, i));
  }

  /** Offset within the block's state range for a property value map. */
  metaFor(values) {
    let meta = 0;
    for (let i = 0; i < this.properties.length; i++) {
      const p = this.properties[i];
      const v = values ? values[p.name] : undefined;
      meta += (v === undefined ? 0 : p.indexOf(v)) * this.strides[i];
    }
    return meta;
  }

  /** Read one property value out of a meta offset. */
  get(meta, name) {
    const i = this.byName.get(name);
    if (i === undefined) return undefined;
    const p = this.properties[i];
    return p.values[Math.floor(meta / this.strides[i]) % p.count];
  }

  /** Return a new meta with one property replaced. */
  with(meta, name, value) {
    const i = this.byName.get(name);
    if (i === undefined) return meta;
    const p = this.properties[i];
    const cur = Math.floor(meta / this.strides[i]) % p.count;
    return meta + (p.indexOf(value) - cur) * this.strides[i];
  }

  /** Expand a meta offset into a plain object (debugging, save files). */
  toObject(meta) {
    const o = {};
    for (let i = 0; i < this.properties.length; i++) {
      const p = this.properties[i];
      o[p.name] = p.values[Math.floor(meta / this.strides[i]) % p.count];
    }
    return o;
  }

  has(name) { return this.byName.has(name); }
}

export const EMPTY_STATE_DEF = new StateDefinition([]);

// --- Free functions operating on raw state ids -------------------------------

/** Read a property value from a state id (undefined if the block lacks it). */
export function getProp(state, name) {
  const b = stateToBlock[state];
  if (!b) return undefined;
  return b.stateDef.get(stateToMeta[state], name);
}

/** Return the state id with one property changed (unchanged if not present). */
export function withProp(state, name, value) {
  const b = stateToBlock[state];
  if (!b || !b.stateDef.has(name)) return state;
  return b.base + b.stateDef.with(stateToMeta[state], name, value);
}

/** Build a state id for a block from a property map. */
export function stateOf(block, values) {
  return block.base + block.stateDef.metaFor(values);
}

/** Human readable form, e.g. `oak_stairs[facing=east,half=bottom]`. */
export function stateName(state) {
  const b = stateToBlock[state];
  if (!b) return `#${state}`;
  const props = b.stateDef.properties;
  if (!props.length) return b.name;
  const obj = b.stateDef.toObject(stateToMeta[state]);
  return `${b.name}[${props.map((p) => `${p.name}=${obj[p.name]}`).join(',')}]`;
}
