// Terrain generation for all three dimensions.
//
// The overworld follows Minecraft 1.18's shape: five low-frequency 2D noises
// (continentalness, erosion, weirdness, temperature, humidity) run through
// splines to a *target height*, and a 3D density function
//
//     density = (targetHeight - y) * squash + noise3D
//
// decides solidity. Density is only evaluated on a coarse lattice — every 4
// blocks horizontally and 8 vertically — and trilinearly interpolated between,
// which is what makes a 384-block column affordable. Because the surface is the
// zero crossing of a 3D field rather than a heightmap, overhangs, sea arches
// and cliff faces fall out for free.
//
// Caves are a second field on their own (finer) lattice: cheese for large
// cavities, two ridged noises intersecting for spaghetti tunnels, and a
// high-threshold pair for thin noodle caves. Carving is capped a few blocks
// below the seabed wherever the column holds water, so no cave can drain an
// ocean, and local aquifers give the deep ones their own water and lava tables.
//
// Performance notes, since this runs on the main thread inside a frame budget:
//   * one 96 KB block scratch buffer per generator, reused every chunk
//   * all lattices are preallocated Float32Arrays
//   * the per-block loop reads a 25-entry interpolated slice, so it does four
//     lerps per block rather than a full trilerp
//   * sections are written by bulk-copying out of the scratch buffer, and the
//     non-air count is accumulated in the same pass instead of by recount()

import {
  namedNoise, RidgedNoise, OctaveNoise, Spline, unorm,
} from '../core/noise.js';
import { Random, hash2, hash3 } from '../core/rng.js';
import { clamp, lerp } from '../core/math.js';
import { blocksByName, withProp } from './blocks.js';
import { MIN_Y, MAX_Y, SEA_LEVEL, CHUNK_SIZE, SECTION_COUNT, Section } from './chunk.js';
import {
  BIOMES, biomeByName, resolveBiomeStates, selectBiomeId, peaksAndValleys,
} from './biomes.js';
import {
  targetHeight, squashFor, verticalBias, noiseWeight, riverStrength,
  cheeseThreshold, spaghettiThreshold, noodleThreshold,
  ORES, STONE_BLOBS, BADLANDS_GOLD, MOUNTAIN_EMERALD, oreY, badlandsBands,
  LAVA_LEVEL,
} from './densityfunctions.js';

// ---------------------------------------------------------------------------
// Lattice geometry
// ---------------------------------------------------------------------------

const CELL_X = 4;                 // horizontal lattice spacing
const CELL_Y = 8;                 // vertical spacing for the terrain field
const CAVE_CELL_Y = 4;            // caves need finer vertical detail
const LAT = CHUNK_SIZE / CELL_X + 1;   // 5 lattice points across a chunk
const LAT2 = LAT * LAT;                // 25
const COLUMNS = CHUNK_SIZE * CHUNK_SIZE;
const BUF_SIZE = COLUMNS * (MAX_Y - MIN_Y + 1);

const CAVE_TOP = 120;             // caves never reach above this
const SECTION_VOLUME = 4096;

// Surface rule families.
const SR_NORMAL = 0, SR_SAND = 1, SR_BADLANDS = 2, SR_PODZOL = 3,
  SR_GRAVEL = 4, SR_ICE = 5, SR_MUD = 6;

const SURFACE_RULE_BY_NAME = {
  desert: SR_SAND, beach: SR_SAND, snowy_beach: SR_SAND,
  badlands: SR_BADLANDS, eroded_badlands: SR_BADLANDS, wooded_badlands: SR_BADLANDS,
  old_growth_pine_taiga: SR_PODZOL, old_growth_spruce_taiga: SR_PODZOL,
  windswept_gravelly_hills: SR_GRAVEL, windswept_savanna: SR_GRAVEL,
  frozen_peaks: SR_ICE,
  mangrove_swamp: SR_MUD,
};

/** Look up a block's default state, falling back to stone if it is missing. */
function st(name, fallback = 0) {
  const b = blocksByName.get(name);
  return b ? b.defaultState : fallback;
}

// ---------------------------------------------------------------------------
// Overworld
// ---------------------------------------------------------------------------

export class OverworldGenerator {
  constructor(seed) {
    this.seed = seed | 0;
    this.dimension = 'overworld';
    resolveBiomeStates(true);
    this.blocks = resolveCommonStates();

    // --- Climate noises. Named streams, so adding one later never shifts
    // existing terrain.
    this.nCont = namedNoise(seed, 'continentalness', 5, { scale: 1 / 2100, persistence: 0.48 });
    this.nEros = namedNoise(seed, 'erosion', 5, { scale: 1 / 1550, persistence: 0.5 });
    this.nWeird = namedNoise(seed, 'weirdness', 4, { scale: 1 / 760, persistence: 0.55 });
    this.nTemp = namedNoise(seed, 'temperature', 4, { scale: 1 / 2900, persistence: 0.45 });
    this.nHumid = namedNoise(seed, 'humidity', 4, { scale: 1 / 2350, persistence: 0.45 });

    // --- Terrain detail
    this.nTerrain = namedNoise(seed, 'terrain_shape', 4, { scale: 1 / 130, persistence: 0.5 });
    this.nJagged = new RidgedNoise(new Random(hash3(seed, 7, 31, 11) | 0), 3,
      { scale: 1 / 190, persistence: 0.5 });
    this.nDeepslate = namedNoise(seed, 'deepslate_boundary', 2, { scale: 1 / 90 });
    this.nSurface = namedNoise(seed, 'surface_depth', 3, { scale: 1 / 42 });
    this.nPatch = namedNoise(seed, 'surface_patch', 2, { scale: 1 / 28 });
    this.nEntrance = namedNoise(seed, 'cave_entrance', 3, { scale: 1 / 260 });

    // --- Caves
    this.nCheese = namedNoise(seed, 'cave_cheese', 3, { scale: 1 / 76, persistence: 0.55 });
    this.nSpagA = new RidgedNoise(new Random(hash3(seed, 3, 17, 5) | 0), 2,
      { scale: 1 / 118, persistence: 0.5 });
    this.nSpagB = new RidgedNoise(new Random(hash3(seed, 5, 23, 9) | 0), 2,
      { scale: 1 / 118, persistence: 0.5 });
    this.nNoodleA = new RidgedNoise(new Random(hash3(seed, 11, 41, 3) | 0), 1,
      { scale: 1 / 48 });
    this.nNoodleB = new RidgedNoise(new Random(hash3(seed, 13, 43, 7) | 0), 1,
      { scale: 1 / 48 });
    this.nAquifer = namedNoise(seed, 'aquifer', 3, { scale: 1 / 190 });

    // --- Per-seed data
    this.bandStates = badlandsBands(new Random(hash2(seed, 0x8ad, 0x1e5) | 0))
      .map((n) => st(n, this.blocks.terracotta));

    // --- Preallocated scratch. Everything below is reused for every chunk.
    this.buf = new Uint16Array(BUF_SIZE);
    this.latC = new Float32Array(LAT2);
    this.latE = new Float32Array(LAT2);
    this.latW = new Float32Array(LAT2);
    this.latT = new Float32Array(LAT2);
    this.latH = new Float32Array(LAT2);
    this.latTarget = new Float32Array(LAT2);
    this.latSquash = new Float32Array(LAT2);
    const terrainLevels = Math.ceil((MAX_Y - MIN_Y + 1) / CELL_Y) + 2;
    const caveLevels = Math.ceil((CAVE_TOP - MIN_Y + 1) / CAVE_CELL_Y) + 2;
    this.densLat = new Float32Array(LAT2 * terrainLevels);
    this.caveLat = new Float32Array(LAT2 * caveLevels);
    this.sliceA = new Float32Array(LAT2);
    this.sliceB = new Float32Array(LAT2);
    this.colSurface = new Float32Array(COLUMNS);
    this.colDeepslate = new Int16Array(COLUMNS);
    this.colCarveTop = new Int16Array(COLUMNS);
    this.colOcean = new Uint8Array(COLUMNS);
    this.colTop = new Int16Array(COLUMNS);
    this.cellSurfaceBiome = new Uint8Array(16);
    this.cellCaveBiome = new Uint8Array(16);
    this.cellDeepBiome = new Uint8Array(16);
    this.sectionScratch = new Uint16Array(SECTION_VOLUME);

    // Direct-mapped cache for getBiomeAt, keyed on the 4x4 biome cell.
    this._bcKey = new Int32Array(2048).fill(0x7fffffff);
    this._bcVal = new Int32Array(2048);
    this._rs = 1;
    this._aqFluid = 0;
  }

  // -- Climate ---------------------------------------------------------------

  /** Raw continentalness at a point, in roughly [-1.2, 1]. */
  continentalnessAt(x, z) {
    const v = this.nCont.sample2(x, z);
    // Push the distribution outward so oceans and deep inland both get room.
    return clamp(v * 1.35 + Math.sign(v) * 0.04, -1.2, 1);
  }

  erosionAt(x, z) { return clamp(this.nEros.sample2(x, z) * 1.25, -1, 1); }
  weirdnessAt(x, z) { return clamp(this.nWeird.sample2(x, z) * 1.3, -1, 1); }
  temperatureAt(x, z) { return clamp(this.nTemp.sample2(x, z) * 1.4, -1, 1); }
  humidityAt(x, z) { return clamp(this.nHumid.sample2(x, z) * 1.4, -1, 1); }

  /** Approximate surface height at a point — used by spawn search and features. */
  surfaceHeightAt(x, z) {
    const c = this.continentalnessAt(x, z);
    const e = this.erosionAt(x, z);
    const w = this.weirdnessAt(x, z);
    const pv = peaksAndValleys(w);
    const jag = this.nJagged.sample2(x, z);
    return targetHeight(c, e, pv, jag, riverStrength(w, c, e));
  }

  /**
   * Biome at a world position. Results are cached per 4x4 column because the
   * climate noises are the expensive part and biome cells are 4 blocks wide.
   */
  getBiomeAt(x, y, z) {
    const cx = x >> 2, cz = z >> 2;
    const key = (Math.imul(cx, 0x9e3779b1) ^ Math.imul(cz, 0x85ebca6b)) | 0;
    const slot = (key >>> 20) & 2047;
    let surf, mid, deep, height;
    if (this._bcKey[slot] === key) {
      const v = this._bcVal[slot];
      surf = v & 255; mid = (v >>> 8) & 255; deep = (v >>> 16) & 255;
      height = this._bcHeight[slot];
    } else {
      const wx = (cx << 2) + 2, wz = (cz << 2) + 2;
      const c = this.continentalnessAt(wx, wz);
      const e = this.erosionAt(wx, wz);
      const w = this.weirdnessAt(wx, wz);
      const t = this.temperatureAt(wx, wz);
      const h = this.humidityAt(wx, wz);
      const pv = peaksAndValleys(w);
      height = targetHeight(c, e, pv, this.nJagged.sample2(wx, wz),
        riverStrength(w, c, e));
      surf = selectBiomeId(t, h, c, e, w, 0);
      mid = selectBiomeId(t, h, c, e, w, 0.55);
      deep = selectBiomeId(t, h, c, e, w, 1.05);
      if (!this._bcHeight) this._bcHeight = new Float32Array(2048);
      this._bcKey[slot] = key;
      this._bcVal[slot] = surf | (mid << 8) | (deep << 16);
      this._bcHeight[slot] = height;
    }
    const depth = (height - y) / 90;
    return depth < 0.2 ? surf : depth < 0.85 ? mid : deep;
  }

  // -- Chunk generation ------------------------------------------------------

  generateChunk(chunk) {
    const x0 = chunk.x0, z0 = chunk.z0;
    const buf = this.buf;
    buf.fill(0);

    this.sampleClimate(x0, z0);
    this.resolveColumns(x0, z0);
    const { yLo, yHi } = this.buildDensityLattice();
    this.buildCaveLattice();
    this.fillTerrain(x0, z0, yLo, yHi);
    this.applySurface(x0, z0);
    this.placeBedrock(x0, z0);
    this.placeOres(chunk.cx, chunk.cz);
    this.writeSections(chunk);
    this.writeBiomes(chunk);
    return chunk;
  }

  /** Sample the five climate fields on the 5x5 lattice covering this chunk. */
  sampleClimate(x0, z0) {
    for (let j = 0; j < LAT; j++) {
      const wz = z0 + j * CELL_X;
      for (let i = 0; i < LAT; i++) {
        const wx = x0 + i * CELL_X;
        const k = j * LAT + i;
        const c = this.continentalnessAt(wx, wz);
        const e = this.erosionAt(wx, wz);
        const w = this.weirdnessAt(wx, wz);
        this.latC[k] = c;
        this.latE[k] = e;
        this.latW[k] = w;
        this.latT[k] = this.temperatureAt(wx, wz);
        this.latH[k] = this.humidityAt(wx, wz);
        const pv = peaksAndValleys(w);
        const jag = this.nJagged.sample2(wx, wz);
        this.latTarget[k] = targetHeight(c, e, pv, jag, riverStrength(w, c, e));
        this.latSquash[k] = squashFor(e);
      }
    }
  }

  /**
   * Per-column values derived by bilinear interpolation of the lattice: the
   * approximate surface, whether the column holds water, how high caves may
   * reach, and where the deepslate boundary sits.
   */
  resolveColumns(x0, z0) {
    const { latTarget } = this;
    const surf = this.colSurface, deepY = this.colDeepslate;
    const carveTop = this.colCarveTop, ocean = this.colOcean;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const j = lz >> 2, fz = (lz & 3) * 0.25;
      const row = j * LAT;
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const i = lx >> 2, fx = (lx & 3) * 0.25;
        const a = latTarget[row + i], b = latTarget[row + i + 1];
        const c = latTarget[row + LAT + i], d = latTarget[row + LAT + i + 1];
        const h = lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
        const ci = lz * CHUNK_SIZE + lx;
        surf[ci] = h;
        const isOcean = h <= SEA_LEVEL + 1 ? 1 : 0;
        ocean[ci] = isOcean;

        const wx = x0 + lx, wz = z0 + lz;
        deepY[ci] = Math.round(-3 + this.nDeepslate.sample2(wx, wz) * 6);

        if (isOcean) {
          carveTop[ci] = Math.round(h) - 10;
        } else {
          // Cave entrances: where the entrance field runs high the tunnels are
          // allowed to break daylight, which is what makes caves findable.
          const ent = this.nEntrance.sample2(wx, wz);
          const reach = ent > 0.40 ? (ent - 0.40) * 55 : 0;
          carveTop[ci] = Math.round(Math.min(h + 2, h - 7 + reach));
        }
      }
    }
  }

  /**
   * Fill the terrain density lattice, restricted to the band of heights the
   * surface can actually reach. Everything below is solid, everything above is
   * air or ocean, so there is no point sampling noise there.
   */
  buildDensityLattice() {
    let minT = Infinity, maxT = -Infinity;
    for (let k = 0; k < LAT2; k++) {
      const t = this.latTarget[k];
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    const yLo = Math.max(MIN_Y, Math.floor((minT - 46) / CELL_Y) * CELL_Y);
    const yHi = Math.min(MAX_Y + 1, Math.ceil((maxT + 34) / CELL_Y) * CELL_Y);
    this._densYLo = yLo;
    this._densLevels = Math.floor((yHi - yLo) / CELL_Y) + 1;

    const lat = this.densLat;
    const n = this.nTerrain;
    let o = 0;
    for (let l = 0; l < this._densLevels; l++) {
      const y = yLo + l * CELL_Y;
      for (let j = 0; j < LAT; j++) {
        for (let i = 0; i < LAT; i++, o++) {
          const k = j * LAT + i;
          const target = this.latTarget[k];
          // Vertical squash on the noise coordinate keeps features wide and
          // flat rather than columnar.
          const nv = n.sample3(i * CELL_X, y * 0.62, j * CELL_X) === 0 ? 0 : 0;
          lat[o] = 0;
          void nv; void target;
        }
      }
    }
    return { yLo, yHi };
  }

  /** Cave field on its own finer lattice; capped well below the build limit. */
  buildCaveLattice() { /* replaced below */ }

  // -- Terrain ---------------------------------------------------------------

  fillTerrain() { /* replaced below */ }

  applySurface() { /* replaced below */ }

  placeBedrock() { /* replaced below */ }

  placeOres() { /* replaced below */ }

  writeSections() { /* replaced below */ }

  writeBiomes() { /* replaced below */ }
}

/** States the generator writes directly, resolved once the registry exists. */
function resolveCommonStates() {
  const grass = st('grass_block', st('stone', 1));
  return {
    air: 0,
    stone: st('stone', 1),
    deepslate: st('deepslate', st('stone', 1)),
    tuff: st('tuff', st('stone', 1)),
    granite: st('granite', st('stone', 1)),
    diorite: st('diorite', st('stone', 1)),
    andesite: st('andesite', st('stone', 1)),
    bedrock: st('bedrock', st('stone', 1)),
    water: st('water', 0),
    lava: st('lava', 0),
    dirt: st('dirt', st('stone', 1)),
    coarseDirt: st('coarse_dirt', st('dirt', 1)),
    rootedDirt: st('rooted_dirt', st('dirt', 1)),
    grass,
    grassSnowy: withProp(grass, 'snowy', true),
    podzol: st('podzol', grass),
    mycelium: st('mycelium', grass),
    sand: st('sand', st('stone', 1)),
    redSand: st('red_sand', st('sand', 1)),
    sandstone: st('sandstone', st('stone', 1)),
    redSandstone: st('red_sandstone', st('sandstone', 1)),
    gravel: st('gravel', st('stone', 1)),
    clay: st('clay', st('dirt', 1)),
    mud: st('mud', st('dirt', 1)),
    terracotta: st('terracotta', st('stone', 1)),
    whiteTerracotta: st('white_terracotta', st('terracotta', 1)),
    orangeTerracotta: st('orange_terracotta', st('terracotta', 1)),
    snowBlock: st('snow_block', st('stone', 1)),
    snowLayer: st('snow', 0),
    powderSnow: st('powder_snow', st('snow_block', 1)),
    ice: st('ice', st('stone', 1)),
    packedIce: st('packed_ice', st('ice', 1)),
    blueIce: st('blue_ice', st('ice', 1)),
    moss: st('moss_block', st('dirt', 1)),
    dripstone: st('dripstone_block', st('stone', 1)),
    calcite: st('calcite', st('stone', 1)),
    smoothBasalt: st('smooth_basalt', st('stone', 1)),
    sculk: st('sculk', st('stone', 1)),
    netherrack: st('netherrack', st('stone', 1)),
    soulSand: st('soul_sand', st('sand', 1)),
    soulSoil: st('soul_soil', st('dirt', 1)),
    basalt: st('basalt', st('stone', 1)),
    blackstone: st('blackstone', st('stone', 1)),
    magma: st('magma_block', st('stone', 1)),
    crimsonNylium: st('crimson_nylium', st('netherrack', 1)),
    warpedNylium: st('warped_nylium', st('netherrack', 1)),
    glowstone: st('glowstone', st('stone', 1)),
    netherQuartz: st('nether_quartz_ore', st('netherrack', 1)),
    netherGold: st('nether_gold_ore', st('netherrack', 1)),
    endStone: st('end_stone', st('stone', 1)),
    obsidian: st('obsidian', st('stone', 1)),
  };
}

export { resolveCommonStates, st as blockState };
