// Worked stone, bricks, terracotta, glass and the copper oxidation chain.
//
// The stairs / slab / wall triples are generated from STONE_FAMILIES; each
// derived block inherits its material stats and texture from the base block
// that is already registered, so hardness only ever gets written once.

import {
  def, st, cube, pillar, axisPlacement, MAT, mat, boxesToModel,
  stairsBlock, slabBlock, wallBlock, fenceBlock, paneBlock, isWaterAt,
  silkOnly, fixedDrop, oreDrop, stateLight, orientedFaces, faceFacing, lookFacing,
  PROP, getProp, withProp, stateOf, blockOf,
  RENDER, PASS, TINT, SOUND, TOOL, TIER, PUSH, T, SHAPE,
} from './helpers.js';
import { getBlock, box, faceTextures } from '../blocks.js';
import {
  STONE_FAMILIES, COLORS, COLOR_MAP, TERRACOTTA_MAP, MAP, DIRS, FACING_INDEX,
  FACING6, COPPER_STAGES, WEATHERING,
} from './data.js';
import { AABB, FACES } from '../../core/math.js';

export function registerBuilding() {
  registerWorkedStone();
  registerSandstone();
  registerQuartzAndPrismarine();
  registerNetherBricks();
  registerFamilies();
  registerTerracotta();
  registerGlass();
  registerCopper();
  registerAmethyst();
}

// ---------------------------------------------------------------------------
// Worked stone bases
// ---------------------------------------------------------------------------

function registerWorkedStone() {
  const s = MAT.stone;
  cube('cobblestone', 'cobblestone', mat(s, { hardness: 2, blastResistance: 6 }));
  cube('mossy_cobblestone', 'mossy_cobblestone', mat(s, {
    hardness: 2, blastResistance: 6, mapColor: MAP.plant,
  }));
  cube('smooth_stone', 'smooth_stone', mat(s, {}));
  cube('stone_bricks', 'stone_bricks', mat(s, {}));
  cube('mossy_stone_bricks', 'mossy_stone_bricks', mat(s, { mapColor: MAP.plant }));
  cube('cracked_stone_bricks', 'cracked_stone_bricks', mat(s, {}));
  cube('chiseled_stone_bricks', 'chiseled_stone_bricks', mat(s, {}));
  cube('bricks', 'bricks', mat(s, {
    hardness: 2, blastResistance: 6, mapColor: MAP.red,
  }));
  cube('packed_mud', 'packed_mud', mat(s, {
    hardness: 1, blastResistance: 3, sound: SOUND.GRAVEL, mapColor: MAP.dirt,
  }));
  cube('mud_bricks', 'mud_bricks', mat(s, {
    hardness: 1.5, blastResistance: 3, mapColor: MAP.dirt,
  }));
  cube('purpur_block', 'purpur_block', mat(s, {
    hardness: 1.5, blastResistance: 6, mapColor: MAP.magenta,
  }));
  axisPlacement(pillar('purpur_pillar', 'purpur_pillar', 'purpur_pillar_top',
    mat(s, { hardness: 1.5, blastResistance: 6, mapColor: MAP.magenta })));
  cube('end_stone_bricks', 'end_stone_bricks', mat(s, {
    hardness: 3, blastResistance: 9, mapColor: MAP.sand,
  }));
}

// ---------------------------------------------------------------------------
// Sandstone
// ---------------------------------------------------------------------------

function registerSandstone() {
  for (const red of [false, true]) {
    const p = red ? 'red_' : '';
    const color = red ? MAP.orange : MAP.sand;
    const m = mat(MAT.stone, { hardness: 0.8, blastResistance: 0.8, mapColor: color });
    cube(`${p}sandstone`, {
      top: `${p}sandstone_top`, bottom: `${p}sandstone_bottom`, side: `${p}sandstone`,
    }, m);
    cube(`chiseled_${p}sandstone`, {
      top: `${p}sandstone_top`, bottom: `${p}sandstone_top`,
      side: `chiseled_${p}sandstone`,
    }, m);
    cube(`cut_${p}sandstone`, {
      top: `${p}sandstone_top`, bottom: `${p}sandstone_top`, side: `cut_${p}sandstone`,
    }, m);
    cube(`smooth_${p}sandstone`, `${p}sandstone_top`, mat(m, {
      hardness: 2, blastResistance: 6,
    }));
  }
}

// ---------------------------------------------------------------------------
// Quartz, prismarine, purpur
// ---------------------------------------------------------------------------

function registerQuartzAndPrismarine() {
  const q = MAT.quartz;
  cube('quartz_block', {
    top: 'quartz_block_top', bottom: 'quartz_block_bottom', side: 'quartz_block_side',
  }, q);
  cube('chiseled_quartz_block', {
    top: 'chiseled_quartz_block_top', bottom: 'chiseled_quartz_block_top',
    side: 'chiseled_quartz_block',
  }, q);
  axisPlacement(pillar('quartz_pillar', 'quartz_pillar', 'quartz_pillar_top', q));
  cube('quartz_bricks', 'quartz_bricks', q);
  cube('smooth_quartz', 'quartz_block_bottom', mat(q, {
    hardness: 2, blastResistance: 6,
  }));

  const pris = mat(MAT.stone, { hardness: 1.5, blastResistance: 6, mapColor: MAP.cyan });
  cube('prismarine', 'prismarine', pris);
  cube('prismarine_bricks', 'prismarine_bricks', pris);
  cube('dark_prismarine', 'dark_prismarine', mat(pris, { mapColor: MAP.terracottaCyan }));
  cube('sea_lantern', 'sea_lantern', mat(MAT.glass, {
    hardness: 0.3, blastResistance: 0.3, light: 15, emissive: 15,
    mapColor: MAP.quartz, drops: silkOnly(oreDrop('prismarine_crystals', 2, 3)),
  }));
}

// ---------------------------------------------------------------------------
// Nether bricks
// ---------------------------------------------------------------------------

function registerNetherBricks() {
  const nb = MAT.netherBrick;
  cube('nether_bricks', 'nether_bricks', nb);
  cube('cracked_nether_bricks', 'cracked_nether_bricks', nb);
  cube('chiseled_nether_bricks', 'chiseled_nether_bricks', nb);
  cube('red_nether_bricks', 'red_nether_bricks', mat(nb, { mapColor: MAP.red }));
  fenceBlock('nether_brick_fence', 'nether_bricks',
    mat(nb, { fenceGroup: 'nether_brick', family: 'nether_brick' }));
}

// ---------------------------------------------------------------------------
// Derived stairs / slabs / walls
// ---------------------------------------------------------------------------

/** Material stats copied from an already-registered base block. */
function inherit(baseName) {
  const b = getBlock(baseName);
  if (!b) throw new Error(`stone family base ${baseName} is not registered`);
  return {
    hardness: b.hardness, blastResistance: b.blastResistance, tool: b.tool,
    tier: b.tier, requiresTool: b.requiresTool, sound: b.sound,
    mapColor: b.mapColor, family: baseName,
  };
}

/** Texture spec of a base block; pillars expose a function, so fall back. */
function baseTexture(name) {
  const b = getBlock(name);
  const t = b && b.textures;
  return (t && typeof t !== 'function') ? t : name;
}

function registerFamilies() {
  for (const f of STONE_FAMILIES) {
    const m = inherit(f.base);
    const tex = baseTexture(f.base);
    if (f.stairs) stairsBlock(f.stairs, tex, m);
    if (f.slab) slabBlock(f.slab, tex, m);
    if (f.wall) wallBlock(f.wall, tex, m);
  }
}

// ---------------------------------------------------------------------------
// Terracotta
// ---------------------------------------------------------------------------

function registerTerracotta() {
  cube('terracotta', 'terracotta', MAT.terracotta);
  for (const c of COLORS) {
    cube(`${c}_terracotta`, `${c}_terracotta`,
      mat(MAT.terracotta, { mapColor: TERRACOTTA_MAP[c], creativeTab: 'colored' }));
  }
  for (const c of COLORS) glazedTerracotta(c);
}

/**
 * Glazed terracotta tiles into a larger pattern, so the texture rotates with
 * the block's facing instead of the model.
 */
function glazedTerracotta(color) {
  const name = `${color}_glazed_terracotta`;
  const b = def(name, mat(MAT.terracotta, {
    properties: [PROP.facing],
    defaultState: { facing: 'north' },
    hardness: 1.4,
    blastResistance: 1.4,
    mapColor: COLOR_MAP[color],
    creativeTab: 'colored',
    textures: name,
    push: PUSH.DESTROY,
    model: (state) => {
      const f = FACING_INDEX[getProp(state, 'facing')];
      const m = box([0, 0, 0], [16, 16, 16], name);
      m.faces[3].uvRot = (f * 90) % 360;
      m.faces[2].uvRot = ((4 - f) * 90) % 360;
      return [m];
    },
  }));
  b.stateForPlacement = (world, x, y, z, ctx) =>
    stateOf(b, { facing: DIRS[faceFacing(ctx)] });
  return b;
}

// ---------------------------------------------------------------------------
// Glass, panes, bars, chain
// ---------------------------------------------------------------------------

function registerGlass() {
  cube('glass', 'glass', mat(MAT.glass, {
    pass: PASS.CUTOUT, opaque: false, lightFilter: 0, transparentToSelf: true,
    drops: silkOnly(() => []),
  }));
  paneBlock('glass_pane', 'glass', mat(MAT.glass, {
    paneGroup: 'glass', drops: silkOnly(() => []),
  }));
  // Tinted glass is the one transparent block that still blocks all light.
  cube('tinted_glass', 'tinted_glass', mat(MAT.glass, {
    pass: PASS.TRANSLUCENT, opaque: false, lightFilter: 15,
    transparentToSelf: true, mapColor: MAP.gray,
  }));
  paneBlock('iron_bars', 'iron_bars', mat(MAT.metal, {
    hardness: 5, blastResistance: 6, tier: TIER.WOOD, paneGroup: 'iron_bars',
    thickness: 2 / 16,
  }));

  def('chain', mat(MAT.metal, {
    properties: [PROP.axis, PROP.waterlogged],
    defaultState: { axis: 'y', waterlogged: false },
    render: RENDER.MODEL,
    pass: PASS.CUTOUT,
    hardness: 5,
    blastResistance: 6,
    tier: TIER.WOOD,
    solid: false,
    opaque: false,
    creativeTab: 'decorations',
    textures: 'chain',
    model: (state) => boxesToModel(chainBoxes(getProp(state, 'axis')), 'chain'),
    collision: (state) => chainBoxes(getProp(state, 'axis')),
  }), { noConnect: true });
  const chain = getBlock('chain');
  chain.stateForPlacement = (world, x, y, z, ctx) => stateOf(chain, {
    axis: ctx && ctx.face < 2 ? 'x' : ctx && ctx.face > 3 ? 'z' : 'y',
    waterlogged: isWaterAt(world, x, y, z),
  });
}

function chainBoxes(axis) {
  const a = 6.5 / 16, b = 9.5 / 16;
  if (axis === 'x') return [new AABB(0, a, a, 1, b, b)];
  if (axis === 'z') return [new AABB(a, a, 0, b, b, 1)];
  return [new AABB(a, 0, a, b, 1, b)];
}

// ---------------------------------------------------------------------------
// Copper
// ---------------------------------------------------------------------------

/** Block id for an oxidation stage of a copper form. */
function copperName(stage, form, waxed) {
  const base = form === 'copper_block'
    ? (stage === '' ? 'copper_block' : `${stage}copper`)
    : `${stage}${form}`;
  return waxed ? `waxed_${base}` : base;
}

function registerCopper() {
  const stageMap = [MAP.copper, MAP.copperExposed, MAP.copperWeathered, MAP.copperOxidized];

  for (let waxed = 0; waxed < 2; waxed++) {
    for (let i = 0; i < COPPER_STAGES.length; i++) {
      const stage = COPPER_STAGES[i];
      const m = mat(MAT.copper, { mapColor: stageMap[i] });
      const solidName = copperName(stage, 'copper_block', waxed);
      const cutName = copperName(stage, 'cut_copper', waxed);
      const tex = stage === '' ? 'copper_block' : `${stage}copper`;
      const cutTex = `${stage}cut_copper`;

      const opts = mat(m, { randomTick: !waxed && i < 3 });
      if (!waxed && i < 3) opts.onRandomTick = weatherTick;
      cube(solidName, tex, opts);
      cube(cutName, cutTex, mat(opts, {}));
      stairsBlock(`${cutName}_stairs`, cutTex, mat(opts, { family: 'copper' }));
      slabBlock(`${cutName}_slab`, cutTex, mat(opts, { family: 'copper' }));

      // Record the weathering graph so the axe (de-wax, scrape) can use it.
      for (const form of ['copper_block', 'cut_copper', 'cut_copper_stairs', 'cut_copper_slab']) {
        const name = copperName(stage, form, waxed);
        WEATHERING[name] = {
          stage: i,
          waxed: !!waxed,
          next: i < 3 ? copperName(COPPER_STAGES[i + 1], form, waxed) : null,
          previous: i > 0 ? copperName(COPPER_STAGES[i - 1], form, waxed) : null,
          waxedForm: waxed ? name : copperName(stage, form, 1),
          unwaxedForm: waxed ? copperName(stage, form, 0) : name,
        };
      }
    }
  }
}

/**
 * Copper oxidises one stage at a time. Vanilla's rate depends on how many
 * nearby copper blocks are already more oxidised; approximating that with a
 * flat chance keeps the tick cheap and still spreads a build unevenly.
 */
function weatherTick(world, x, y, z, state, random) {
  if (!random.chance(0.05688889)) return;
  const info = WEATHERING[blockOf(state).name];
  if (!info || !info.next) return;
  const nextBlock = getBlock(info.next);
  if (!nextBlock) return;
  // Preserve shared properties (stair facing, slab type) across the change.
  let ns = nextBlock.defaultState;
  for (const p of blockOf(state).stateDef.properties) {
    if (nextBlock.stateDef.has(p.name)) ns = withProp(ns, p.name, getProp(state, p.name));
  }
  world.setBlock(x, y, z, ns);
}

// ---------------------------------------------------------------------------
// Amethyst
// ---------------------------------------------------------------------------

function registerAmethyst() {
  cube('amethyst_block', 'amethyst_block', MAT.amethyst);
  cube('budding_amethyst', 'budding_amethyst', mat(MAT.amethyst, {
    randomTick: true,
    push: PUSH.BLOCK,
    drops: () => [],
    onRandomTick(world, x, y, z, state, random) {
      if (!random.oneIn(5)) return;
      const f = FACES[random.int(6)];
      const nx = x + f.dx, ny = y + f.dy, nz = z + f.dz;
      const target = world.getBlock(nx, ny, nz);
      const td = blockOf(target);
      let grow = null;
      if (target === 0 || (td && td.isFluid && td.name === 'water')) grow = 'small_amethyst_bud';
      else if (td && td.amethystStage != null && td.amethystStage < 3) {
        grow = ['medium_amethyst_bud', 'large_amethyst_bud', 'amethyst_cluster'][td.amethystStage];
      }
      if (!grow) return;
      const b = getBlock(grow);
      world.setBlock(nx, ny, nz, stateOf(b, {
        facing: FACING6[faceToFacing6(random ? f : f)],
        waterlogged: td != null && td.name === 'water',
      }));
    },
  }));

  const buds = [
    ['small_amethyst_bud', 1, 3 / 16, 4 / 16, 0],
    ['medium_amethyst_bud', 2, 4 / 16, 6 / 16, 1],
    ['large_amethyst_bud', 4, 5 / 16, 8 / 16, 2],
    ['amethyst_cluster', 5, 6 / 16, 7 / 16, 3],
  ];
  for (const [name, light, half, height, stage] of buds) {
    const b = def(name, mat(MAT.amethyst, {
      properties: [PROP.facingAll, PROP.waterlogged],
      defaultState: { facing: 'up', waterlogged: false },
      render: RENDER.MODEL,
      pass: PASS.CUTOUT,
      hardness: 1.5,
      blastResistance: 1.5,
      solid: false,
      opaque: false,
      light,
      emissive: light,
      push: PUSH.DESTROY,
      creativeTab: 'natural',
      textures: name,
      model: (state) => boxesToModel(budBoxes(state, half, height), name,
        { emissive: light }),
      collision: (state) => budBoxes(state, half, height),
      canSurvive(world, x, y, z, state) {
        const f = FACES[facing6ToFace(getProp(state, 'facing'))];
        return T.solid[world.getBlock(x - f.dx, y - f.dy, z - f.dz)] === 1;
      },
      drops: name === 'amethyst_cluster'
        ? oreDrop('amethyst_shard', 4, 4)
        : () => [],
    }), { amethystStage: stage });
    b.stateForPlacement = (world, x, y, z, ctx) => stateOf(b, {
      facing: FACING6[faceToFacing6(FACES[ctx ? ctx.face : 2])],
      waterlogged: isWaterAt(world, x, y, z),
    });
  }
}

/** FACES entry -> index into PROP.facingAll's value list. */
function faceToFacing6(face) {
  switch (face.name) {
    case 'north': return 0;
    case 'east': return 1;
    case 'south': return 2;
    case 'west': return 3;
    case 'up': return 4;
    default: return 5;
  }
}

/** PROP.facingAll value -> FACES index. */
export function facing6ToFace(name) {
  switch (name) {
    case 'north': return 4;
    case 'east': return 1;
    case 'south': return 5;
    case 'west': return 0;
    case 'up': return 3;
    default: return 2;
  }
}

function budBoxes(state, half, height) {
  const f = FACES[facing6ToFace(getProp(state, 'facing'))];
  const lo = 0.5 - half, hi = 0.5 + half;
  if (f.dx) return [f.dx > 0 ? new AABB(1 - height, lo, lo, 1, hi, hi) : new AABB(0, lo, lo, height, hi, hi)];
  if (f.dy) return [f.dy > 0 ? new AABB(lo, 1 - height, lo, hi, 1, hi) : new AABB(lo, 0, lo, hi, height, hi)];
  return [f.dz > 0 ? new AABB(lo, lo, 1 - height, hi, hi, 1) : new AABB(lo, lo, 0, hi, hi, height)];
}
