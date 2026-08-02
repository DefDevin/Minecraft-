// Terrain generation for all three dimensions.
//
// The overworld follows Minecraft 1.18's shape: five low-frequency 2D noises
// (continentalness, erosion, weirdness, temperature, humidity) run through
// splines to a *target height*, and a 3D density function
//
//     density = (targetHeight - y) * squash + noise3D
//
// decides solidity. Density is only evaluated on a coarse lattice — every 4
// blocks horizontally and 8 vertically — and interpolated between, which is
// what makes a 384-block column affordable. Because the surface is the zero
// crossing of a 3D field rather than a heightmap, overhangs, sea arches and
// cliff faces fall out for free.
//
// Caves are a second field on their own finer lattice: cheese noise for large
// cavities, two ridged noises intersecting for spaghetti tunnels, and a
// high-threshold pair for thin noodle caves. Carving is capped well below the
// seabed wherever the column holds water, so no cave can drain an ocean, and
// local aquifers give the deep ones their own water and lava tables.
//
// Performance notes, since this runs on the main thread inside a frame budget:
//   * one 192 KB block scratch buffer per generator, reused for every chunk,
//     laid out so a 4096-entry slice *is* a chunk section — writing a section
//     is a single typed-array copy
//   * every lattice and slice is preallocated; the per-block loop does one
//     lerp per block off a precomputed row rather than a full trilerp
//   * the non-air count is accumulated while copying instead of by recount()
//   * no allocation at all in generateChunk beyond the 24 subarray views

import { namedNoise, RidgedNoise } from '../core/noise.js';
import { Random, hash2, hash3 } from '../core/rng.js';
import { clamp, lerp } from '../core/math.js';
import { blocksByName, withProp } from './blocks.js';
import { MIN_Y, MAX_Y, SEA_LEVEL, CHUNK_SIZE, SECTION_COUNT } from './chunk.js';
import { BIOMES, resolveBiomeStates, selectBiomeId, peaksAndValleys } from './biomes.js';
import {
  targetHeight, squashFor, verticalBias, noiseWeight, riverStrength,
  cheeseThreshold, spaghettiThreshold, noodleThreshold,
  ORES, STONE_BLOBS, BADLANDS_GOLD, MOUNTAIN_EMERALD, oreY, badlandsBands,
  LAVA_LEVEL,
} from './densityfunctions.js';

// ---------------------------------------------------------------------------
// Geometry constants
// ---------------------------------------------------------------------------

const CELL_X = 4;                        // horizontal lattice spacing
const CELL_Y = 8;                        // vertical spacing, terrain field
const CAVE_CELL_Y = 4;                   // caves need finer vertical detail
const LAT = CHUNK_SIZE / CELL_X + 1;     // 5 lattice points across a chunk
const LAT2 = LAT * LAT;                  // 25
const COLUMNS = CHUNK_SIZE * CHUNK_SIZE; // 256
const WORLD_Y = MAX_Y - MIN_Y + 1;       // 384
const BUF_SIZE = COLUMNS * WORLD_Y;      // section-aligned: 4096 per section
const SECTION_VOLUME = 4096;
const CAVE_TOP = 124;                    // caves never reach above this

/** Buffer index for a chunk-local column and absolute y. */
const bufIndex = (y, ci) => (y - MIN_Y) * COLUMNS + ci;

// Surface rule families. Most biomes only need their three block names; these
// are the ones whose surface is a rule rather than a material.
const SR_NORMAL = 0, SR_SAND = 1, SR_BADLANDS = 2, SR_PODZOL = 3,
  SR_GRAVEL = 4, SR_ICE = 5, SR_MUD = 6;

const SURFACE_RULES = {
  desert: SR_SAND, beach: SR_SAND, snowy_beach: SR_SAND,
  badlands: SR_BADLANDS, eroded_badlands: SR_BADLANDS, wooded_badlands: SR_BADLANDS,
  old_growth_pine_taiga: SR_PODZOL, old_growth_spruce_taiga: SR_PODZOL,
  windswept_gravelly_hills: SR_GRAVEL, windswept_savanna: SR_GRAVEL,
  frozen_peaks: SR_ICE,
  mangrove_swamp: SR_MUD,
};

// Cave-biome floor treatments.
const CR_NONE = 0, CR_LUSH = 1, CR_DRIPSTONE = 2, CR_DEEP_DARK = 3;
const CAVE_RULES = {
  lush_caves: CR_LUSH, dripstone_caves: CR_DRIPSTONE, deep_dark: CR_DEEP_DARK,
};

/** Biomes whose exposed water surface freezes over. */
const FREEZING = new Set(['frozen_ocean', 'deep_frozen_ocean', 'frozen_river',
  'snowy_plains', 'ice_spikes', 'snowy_taiga', 'snowy_beach', 'frozen_peaks',
  'jagged_peaks', 'snowy_slopes', 'grove']);

/** Default state for a block name, tolerating an incomplete registry. */
function st(name, fallback = 0) {
  const b = blocksByName.get(name);
  return b ? b.defaultState : fallback;
}

/** The block palette every generator writes from. Resolved after registration. */
function commonStates() {
  const stone = st('stone', 1);
  const dirt = st('dirt', stone);
  const grass = st('grass_block', dirt);
  return {
    air: 0, stone,
    deepslate: st('deepslate', stone),
    tuff: st('tuff', stone),
    granite: st('granite', stone),
    diorite: st('diorite', stone),
    andesite: st('andesite', stone),
    bedrock: st('bedrock', stone),
    water: st('water', 0),
    lava: st('lava', 0),
    dirt,
    coarseDirt: st('coarse_dirt', dirt),
    grass,
    grassSnowy: withProp(grass, 'snowy', true),
    podzol: st('podzol', grass),
    mycelium: st('mycelium', grass),
    sand: st('sand', stone),
    redSand: st('red_sand', st('sand', stone)),
    sandstone: st('sandstone', stone),
    redSandstone: st('red_sandstone', stone),
    gravel: st('gravel', stone),
    clay: st('clay', dirt),
    mud: st('mud', dirt),
    terracotta: st('terracotta', stone),
    whiteTerracotta: st('white_terracotta', stone),
    snowBlock: st('snow_block', stone),
    snowLayer: st('snow', 0),
    powderSnow: st('powder_snow', stone),
    ice: st('ice', stone),
    packedIce: st('packed_ice', stone),
    blueIce: st('blue_ice', stone),
    moss: st('moss_block', dirt),
    dripstone: st('dripstone_block', stone),
    calcite: st('calcite', stone),
    sculk: st('sculk', stone),
    netherrack: st('netherrack', stone),
    soulSand: st('soul_sand', stone),
    soulSoil: st('soul_soil', stone),
    basalt: st('basalt', stone),
    blackstone: st('blackstone', stone),
    magma: st('magma_block', stone),
    crimsonNylium: st('crimson_nylium', stone),
    warpedNylium: st('warped_nylium', stone),
    glowstone: st('glowstone', stone),
    netherQuartz: st('nether_quartz_ore', stone),
    netherGold: st('nether_gold_ore', stone),
    endStone: st('end_stone', stone),
    obsidian: st('obsidian', stone),
  };
}

/**
 * Copy the scratch buffer into a chunk's sections.
 *
 * The buffer's layout matches a section's local index exactly, so each section
 * is one `set()` — and because we count non-air blocks and detect uniformity in
 * the same pass, the chunk never has to run the O(2n) `recount()`.
 */
function writeSections(chunk, buf) {
  for (let si = 0; si < SECTION_COUNT; si++) {
    const off = si * SECTION_VOLUME;
    const first = buf[off];
    let same = true, n = first !== 0 ? 1 : 0;
    for (let i = 1; i < SECTION_VOLUME; i++) {
      const v = buf[off + i];
      if (v !== 0) n++;
      if (v !== first) same = false;
    }
    if (same && first === 0) { chunk.sections[si] = null; continue; }
    const s = chunk.section(si, true);
    if (same) {
      s.blocks = null;
      s.uniform = first;
    } else {
      const arr = s.materialise();
      arr.set(buf.subarray(off, off + SECTION_VOLUME));
    }
    s.nonAir = n;
    s.empty = n === 0;
    s.dirty = true;
  }
}

// ===========================================================================
// Overworld
// ===========================================================================

export class OverworldGenerator {
  constructor(seed) {
    this.seed = seed | 0;
    this.dimension = 'overworld';
    resolveBiomeStates(true);
    this.S = commonStates();

    // --- Climate fields. Named streams, so adding one later never shifts
    // terrain that already exists in a save.
    this.nCont = namedNoise(seed, 'continentalness', 5, { scale: 1 / 2100, persistence: 0.48 });
    this.nEros = namedNoise(seed, 'erosion', 5, { scale: 1 / 1550, persistence: 0.5 });
    this.nWeird = namedNoise(seed, 'weirdness', 4, { scale: 1 / 720, persistence: 0.55 });
    this.nTemp = namedNoise(seed, 'temperature', 4, { scale: 1 / 2900, persistence: 0.45 });
    this.nHumid = namedNoise(seed, 'humidity', 4, { scale: 1 / 2350, persistence: 0.45 });

    // --- Terrain detail
    this.nTerrain = namedNoise(seed, 'terrain_shape', 4, { scale: 1 / 140, persistence: 0.5 });
    this.nJagged = new RidgedNoise(new Random(hash3(seed, 7, 31, 11) | 0), 3,
      { scale: 1 / 190, persistence: 0.5 });
    this.nDeepslate = namedNoise(seed, 'deepslate_boundary', 2, { scale: 1 / 90 });
    this.nSurface = namedNoise(seed, 'surface_depth', 3, { scale: 1 / 46 });
    this.nPatch = namedNoise(seed, 'surface_patch', 2, { scale: 1 / 31 });
    this.nEntrance = namedNoise(seed, 'cave_entrance', 3, { scale: 1 / 240 });

    // --- Caves
    this.nCheese = namedNoise(seed, 'cave_cheese', 3, { scale: 1 / 78, persistence: 0.55 });
    this.nSpagA = new RidgedNoise(new Random(hash3(seed, 3, 17, 5) | 0), 2,
      { scale: 1 / 122, persistence: 0.5 });
    this.nSpagB = new RidgedNoise(new Random(hash3(seed, 5, 23, 9) | 0), 2,
      { scale: 1 / 122, persistence: 0.5 });
    this.nNoodleA = new RidgedNoise(new Random(hash3(seed, 11, 41, 3) | 0), 1,
      { scale: 1 / 52 });
    this.nNoodleB = new RidgedNoise(new Random(hash3(seed, 13, 43, 7) | 0), 1,
      { scale: 1 / 52 });

    // --- Per-seed and per-biome tables
    this.bands = badlandsBands(new Random(hash2(seed, 0x8ad, 0x1e5) | 0))
      .map((n) => st(n, this.S.terracotta));
    const nb = BIOMES.length;
    this.sfRule = new Uint8Array(nb);
    this.caveRule = new Uint8Array(nb);
    this.freezes = new Uint8Array(nb);
    this.snowy = new Uint8Array(nb);
    this.biomeTemp = new Float32Array(nb);
    for (const b of BIOMES) {
      this.sfRule[b.id] = SURFACE_RULES[b.name] ?? SR_NORMAL;
      this.caveRule[b.id] = CAVE_RULES[b.name] ?? CR_NONE;
      this.freezes[b.id] = FREEZING.has(b.name) ? 1 : 0;
      this.snowy[b.id] = b.precipitation === 'snow' ? 1 : 0;
      this.biomeTemp[b.id] = b.temperature;
    }
    this.ores = [...ORES, ...STONE_BLOBS].map(resolveOre);
    this.badlandsGold = resolveOre(BADLANDS_GOLD);
    this.mountainEmerald = resolveOre(MOUNTAIN_EMERALD);

    // --- Preallocated scratch, reused for every chunk.
    this.buf = new Uint16Array(BUF_SIZE);
    this.latC = new Float32Array(LAT2);
    this.latE = new Float32Array(LAT2);
    this.latW = new Float32Array(LAT2);
    this.latT = new Float32Array(LAT2);
    this.latH = new Float32Array(LAT2);
    this.latTarget = new Float32Array(LAT2);
    this.latSquash = new Float32Array(LAT2);
    this.densLat = new Float32Array(LAT2 * (Math.ceil(WORLD_Y / CELL_Y) + 2));
    this.caveLat = new Float32Array(LAT2 * (Math.ceil((CAVE_TOP - MIN_Y) / CAVE_CELL_Y) + 2));
    this.sliceA = new Float32Array(LAT2);
    this.sliceB = new Float32Array(LAT2);
    this.rowA = new Float32Array(LAT);
    this.rowB = new Float32Array(LAT);
    this.colSurface = new Float32Array(COLUMNS);
    this.colDeepslate = new Int16Array(COLUMNS);
    this.colCarveTop = new Int16Array(COLUMNS);
    this.colOcean = new Uint8Array(COLUMNS);
    this.colTop = new Int16Array(COLUMNS);
    this.cellSurfaceBiome = new Uint8Array(16);
    this.cellCaveBiome = new Uint8Array(16);
    this.cellDeepBiome = new Uint8Array(16);
    this.cellSurfaceY = new Float32Array(16);

    // Direct-mapped cache for getBiomeAt, keyed on the 4x4 biome cell.
    this._bcKey = new Int32Array(2048).fill(0x7fffffff);
    this._bcVal = new Int32Array(2048);
    this._bcHeight = new Float32Array(2048);
    this._rs = 1;
    this._aqFluid = 0;
    this._densYLo = 0; this._densYHi = 0; this._caveYHi = 0;
  }

  // -- Climate fields --------------------------------------------------------

  /** Continentalness, stretched so both deep ocean and far inland get room. */
  continentalnessAt(x, z) {
    return clamp(this.nCont.sample2(x, z) * 1.45, -1.2, 1);
  }

  erosionAt(x, z) { return clamp(this.nEros.sample2(x, z) * 1.35, -1, 1); }
  weirdnessAt(x, z) { return clamp(this.nWeird.sample2(x, z) * 1.45, -1, 1); }
  temperatureAt(x, z) { return clamp(this.nTemp.sample2(x, z) * 1.5, -1, 1); }
  humidityAt(x, z) { return clamp(this.nHumid.sample2(x, z) * 1.5, -1, 1); }

  /** Target surface height at a point, before 3D noise perturbs it. */
  surfaceHeightAt(x, z) {
    const c = this.continentalnessAt(x, z);
    const e = this.erosionAt(x, z);
    const w = this.weirdnessAt(x, z);
    return targetHeight(c, e, peaksAndValleys(w), this.nJagged.sample2(x, z),
      riverStrength(w, c, e));
  }

  /**
   * Biome at a world position.
   *
   * Cached per 4x4 column: the five climate noises are the expensive part and
   * biome cells are 4 blocks wide, so a direct-mapped cache turns repeated
   * queries (feature placement, mob spawning, the debug overlay) into a hash.
   */
  getBiomeAt(x, y, z) {
    const cx = x >> 2, cz = z >> 2;
    const key = (Math.imul(cx, 0x9e3779b1) ^ Math.imul(cz, 0x85ebca6b)) | 0;
    const slot = (key >>> 19) & 2047;
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
      height = targetHeight(c, e, peaksAndValleys(w), this.nJagged.sample2(wx, wz),
        riverStrength(w, c, e));
      surf = selectBiomeId(t, h, c, e, w, 0);
      mid = selectBiomeId(t, h, c, e, w, 0.55);
      deep = selectBiomeId(t, h, c, e, w, 1.05);
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
    this.buf.fill(0);
    this.sampleClimate(x0, z0);
    this.computeCellBiomes();
    this.resolveColumns(x0, z0);
    this.buildDensityLattice(x0, z0);
    this.buildCaveLattice(x0, z0);
    this.fillTerrain(x0, z0);
    this.applySurface(x0, z0);
    this.placeBedrock(x0, z0);
    this.placeOres(chunk.cx, chunk.cz);
    writeSections(chunk, this.buf);
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
        this.latC[k] = c; this.latE[k] = e; this.latW[k] = w;
        this.latT[k] = this.temperatureAt(wx, wz);
        this.latH[k] = this.humidityAt(wx, wz);
        this.latTarget[k] = targetHeight(c, e, peaksAndValleys(w),
          this.nJagged.sample2(wx, wz), riverStrength(w, c, e));
        this.latSquash[k] = squashFor(e);
      }
    }
  }

  /**
   * Pick the surface, cave and deep biome for each of the chunk's sixteen
   * 4x4 biome cells by averaging the four lattice corners around the cell.
   * Three lookups per cell instead of one per 4x4x4 voxel is the difference
   * between 48 and 1536 nearest-match searches per chunk.
   */
  computeCellBiomes() {
    for (let cz = 0; cz < 4; cz++) {
      for (let cx = 0; cx < 4; cx++) {
        const k = cz * LAT + cx;
        const k2 = k + LAT;
        const c = (this.latC[k] + this.latC[k + 1] + this.latC[k2] + this.latC[k2 + 1]) * 0.25;
        const e = (this.latE[k] + this.latE[k + 1] + this.latE[k2] + this.latE[k2 + 1]) * 0.25;
        const w = (this.latW[k] + this.latW[k + 1] + this.latW[k2] + this.latW[k2 + 1]) * 0.25;
        const t = (this.latT[k] + this.latT[k + 1] + this.latT[k2] + this.latT[k2 + 1]) * 0.25;
        const h = (this.latH[k] + this.latH[k + 1] + this.latH[k2] + this.latH[k2 + 1]) * 0.25;
        const y = (this.latTarget[k] + this.latTarget[k + 1] +
          this.latTarget[k2] + this.latTarget[k2 + 1]) * 0.25;
        const cell = cz * 4 + cx;
        this.cellSurfaceBiome[cell] = selectBiomeId(t, h, c, e, w, 0);
        this.cellCaveBiome[cell] = selectBiomeId(t, h, c, e, w, 0.55);
        this.cellDeepBiome[cell] = selectBiomeId(t, h, c, e, w, 1.05);
        this.cellSurfaceY[cell] = y;
      }
    }
  }

  /**
   * Per-column values interpolated from the lattice: approximate surface,
   * whether the column holds water, how high caves may reach, and the
   * deepslate boundary.
   */
  resolveColumns(x0, z0) {
    const T = this.latTarget;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const row = (lz >> 2) * LAT, fz = (lz & 3) * 0.25;
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const i = (lx >> 2), fx = (lx & 3) * 0.25;
        const h = lerp(
          lerp(T[row + i], T[row + i + 1], fx),
          lerp(T[row + LAT + i], T[row + LAT + i + 1], fx), fz);
        const ci = lz * CHUNK_SIZE + lx;
        this.colSurface[ci] = h;
        const wx = x0 + lx, wz = z0 + lz;
        this.colDeepslate[ci] = Math.round(-3 + this.nDeepslate.sample2(wx, wz) * 6);
        if (h <= SEA_LEVEL + 1) {
          // A column that holds water keeps a thick seal beneath the seabed,
          // which is what stops a cave from draining the ocean into itself.
          this.colOcean[ci] = 1;
          this.colCarveTop[ci] = Math.round(h) - 11;
        } else {
          this.colOcean[ci] = 0;
          // Where the entrance field runs high, tunnels are allowed to break
          // daylight — that is what makes caves findable from the surface.
          const ent = this.nEntrance.sample2(wx, wz);
          const reach = ent > 0.40 ? (ent - 0.40) * 60 : 0;
          this.colCarveTop[ci] = Math.round(Math.min(h + 2, h - 8 + reach));
        }
      }
    }
  }

  /**
   * Fill the terrain density lattice over the band of heights the surface can
   * actually reach. Below that everything is solid and above it everything is
   * open, so there is no point sampling noise there.
   */
  buildDensityLattice(x0, z0) {
    let minT = Infinity, maxT = -Infinity;
    for (let k = 0; k < LAT2; k++) {
      const t = this.latTarget[k];
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    const yLo = Math.max(MIN_Y, Math.floor((minT - 48) / CELL_Y) * CELL_Y);
    const yHi = Math.min(MAX_Y + 1, Math.ceil((maxT + 36) / CELL_Y) * CELL_Y);
    this._densYLo = yLo;
    this._densYHi = yHi;
    const levels = Math.floor((yHi - yLo) / CELL_Y) + 1;
    this._densLevels = levels;

    const lat = this.densLat, n = this.nTerrain;
    let o = 0;
    for (let l = 0; l < levels; l++) {
      const y = yLo + l * CELL_Y;
      const bias = verticalBias(y);
      for (let j = 0; j < LAT; j++) {
        const wz = z0 + j * CELL_X;
        for (let i = 0; i < LAT; i++, o++) {
          const k = j * LAT + i;
          const target = this.latTarget[k];
          // Squashing the y coordinate keeps 3D features wide and layered
          // rather than columnar.
          const nv = n.sample3(x0 + i * CELL_X, y * 0.62, wz);
          lat[o] = (target - y) * this.latSquash[k] + nv * noiseWeight(y, target) + bias;
        }
      }
    }
  }

  /** The cave field, on its own finer lattice and capped below the build limit. */
  buildCaveLattice(x0, z0) {
    const maxTop = Math.min(CAVE_TOP, Math.ceil(this._densYHi));
    const yHi = Math.ceil(maxTop / CAVE_CELL_Y) * CAVE_CELL_Y;
    this._caveYHi = yHi;
    const levels = Math.floor((yHi - MIN_Y) / CAVE_CELL_Y) + 1;
    this._caveLevels = levels;
    const lat = this.caveLat;
    let o = 0;
    for (let l = 0; l < levels; l++) {
      const y = MIN_Y + l * CAVE_CELL_Y;
      const chT = cheeseThreshold(y);
      const spT = spaghettiThreshold(y);
      const noT = noodleThreshold(y);
      for (let j = 0; j < LAT; j++) {
        const wz = z0 + j * CELL_X;
        for (let i = 0; i < LAT; i++, o++) {
          const wx = x0 + i * CELL_X;
          let v = -4;
          if (chT < 1.5) v = this.nCheese.sample3(wx, y * 1.35, wz) - chT;
          if (spT < 1.5) {
            // Two ridged fields intersecting: solid everywhere except along
            // the crest lines they share, which reads as winding tunnels.
            const a = this.nSpagA.sample3(wx, y * 1.9, wz);
            if (a > spT) {
              const b = this.nSpagB.sample3(wz * 0.93 + 311, y * 1.9, wx * 0.93 - 177);
              const s = Math.min(a, b) - spT;
              if (s > v) v = s;
            }
          }
          if (noT < 1.5) {
            const a = this.nNoodleA.sample3(wx, y * 2.6, wz);
            if (a > noT) {
              const b = this.nNoodleB.sample3(wz + 91, y * 2.6, wx - 53);
              const s = (Math.min(a, b) - noT) * 4;
              if (s > v) v = s;
            }
          }
          lat[o] = v;
        }
      }
    }
  }

  /** Interpolate one lattice level pair into a 5x5 slice. */
  static slice(lat, l, ty, out) {
    const a = l * LAT2, b = a + LAT2;
    for (let k = 0; k < LAT2; k++) out[k] = lat[a + k] + (lat[b + k] - lat[a + k]) * ty;
  }

  /** Turn density and cave fields into blocks. */
  fillTerrain(x0, z0) {
    const buf = this.buf, S = this.S;
    const yLo = this._densYLo, yHi = this._densYHi;
    const sA = this.sliceA, sB = this.sliceB, rowA = this.rowA, rowB = this.rowB;
    const surf = this.colSurface, deepY = this.colDeepslate;
    const carveTop = this.colCarveTop, ocean = this.colOcean, colTop = this.colTop;
    colTop.fill(MIN_Y - 1);
    const yTop = Math.max(yHi, SEA_LEVEL + 1);

    for (let y = MIN_Y; y <= yTop; y++) {
      const base = (y - MIN_Y) * COLUMNS;
      const inBand = y >= yLo && y <= yHi;
      if (inBand) {
        const f = (y - yLo) / CELL_Y;
        let l = Math.floor(f);
        if (l >= this._densLevels - 1) l = this._densLevels - 2;
        OverworldGenerator.slice(this.densLat, l, f - l, sA);
      }
      const caveOn = y <= this._caveYHi;
      if (caveOn) {
        const f = (y - MIN_Y) / CAVE_CELL_Y;
        let l = Math.floor(f);
        if (l >= this._caveLevels - 1) l = this._caveLevels - 2;
        OverworldGenerator.slice(this.caveLat, l, f - l, sB);
      }

      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const j = lz >> 2, fz = (lz & 3) * 0.25;
        const r0 = j * LAT, r1 = r0 + LAT;
        if (inBand) for (let i = 0; i < LAT; i++) rowA[i] = sA[r0 + i] + (sA[r1 + i] - sA[r0 + i]) * fz;
        if (caveOn) for (let i = 0; i < LAT; i++) rowB[i] = sB[r0 + i] + (sB[r1 + i] - sB[r0 + i]) * fz;
        const zoff = lz * CHUNK_SIZE;

        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const ci = zoff + lx;
          let dens;
          if (inBand) {
            const i = lx >> 2, fx = (lx & 3) * 0.25;
            dens = rowA[i] + (rowA[i + 1] - rowA[i]) * fx;
          } else {
            dens = y < yLo ? 1 : -1;
          }

          if (dens > 0) {
            let state = y < deepY[ci] ? S.deepslate : S.stone;
            if (caveOn && y <= carveTop[ci]) {
              const i = lx >> 2, fx = (lx & 3) * 0.25;
              if (rowB[i] + (rowB[i + 1] - rowB[i]) * fx > 0) {
                state = this.carvedState(x0 + lx, y, z0 + lz);
              }
            }
            buf[base + ci] = state;
            if (state === S.stone || state === S.deepslate) colTop[ci] = y;
          } else if (ocean[ci] && y <= SEA_LEVEL) {
            buf[base + ci] = S.water;
          } else if (y <= LAVA_LEVEL) {
            buf[base + ci] = S.lava;
          }
        }
      }
      void surf;
    }
  }

  /** What a carved cell becomes: lava sheet, local aquifer, or plain air. */
  carvedState(x, y, z) {
    if (y <= LAVA_LEVEL) return this.S.lava;
    if (y < 34) {
      const level = this.aquiferLevel(x, y, z);
      if (y <= level) return this._aqFluid;
    }
    return 0;
  }

  /**
   * Local water table. The world is divided into 16x12x16 cells; a minority
   * hold a fluid at a level jittered inside the cell, and the deepest of those
   * hold lava instead. Cave systems that cut through one flood up to its level,
   * which is what gives underground lakes without any flood-fill simulation.
   */
  aquiferLevel(x, y, z) {
    const cy = Math.floor((y - MIN_Y) / 12);
    const h = hash3(this.seed ^ 0x41515545, x >> 4, cy, z >> 4);
    if ((h & 7) > 2) return -1e9;
    const level = MIN_Y + cy * 12 + ((h >>> 8) % 12);
    this._aqFluid = (level < -34 && ((h >>> 20) & 3) === 0) ? this.S.lava : this.S.water;
    return level;
  }

  // -- Surface rules ---------------------------------------------------------

  applySurface(x0, z0) {
    const buf = this.buf, S = this.S;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const ci = lz * CHUNK_SIZE + lx;
        const top = this.colTop[ci];
        if (top < MIN_Y) continue;
        const wx = x0 + lx, wz = z0 + lz;
        const cell = (lz >> 2) * 4 + (lx >> 2);
        const bid = this.cellSurfaceBiome[cell];
        const cid = this.cellCaveBiome[cell];
        const biome = BIOMES[bid];
        const rule = this.sfRule[bid];
        const caveRule = this.caveRule[cid];
        const dn = this.nSurface.sample2(wx, wz);
        const pn = this.nPatch.sample2(wx, wz);
        const soil = 3 + (dn > 0.12 ? 1 : 0) + (dn > 0.5 ? 1 : 0);
        const maxRun = rule === SR_BADLANDS ? 15 : soil + 1;
        const caveY = this.colSurface[ci] - 14;

        let run = -1, above = 0, underwater = false;
        const yStart = Math.min(top, MAX_Y);
        for (let y = yStart; y >= MIN_Y + 6; y--) {
          const idx = bufIndex(y, ci);
          const s = buf[idx];
          if (s !== S.stone && s !== S.deepslate) { run = -1; above = s; continue; }
          if (run < 0) { run = 0; underwater = above === S.water; }
          if (y < caveY) {
            if (run === 0 && caveRule !== CR_NONE && !underwater) {
              const cs = this.caveFloorState(caveRule, pn);
              if (cs) buf[idx] = cs;
            } else if (run === 0 && caveRule === CR_LUSH && underwater) {
              buf[idx] = S.clay;
            }
          } else if (run < maxRun) {
            const ns = this.surfaceStateFor(rule, biome, run, soil, y, underwater, pn);
            if (ns) buf[idx] = ns;
          }
          run++;
          above = s;
        }

        this.capColumn(ci, top, bid, biome, pn);
      }
    }
  }

  /** Material for one block of a surface run, or 0 to leave the stone alone. */
  surfaceStateFor(rule, b, run, soil, y, underwater, pn) {
    const S = this.S;
    switch (rule) {
      case SR_SAND: {
        if (run < soil + 1) return underwater && run === 0 ? b.underwaterState : b.surfaceState;
        if (run < soil + 4) return b.surfaceState === S.redSand ? S.redSandstone : S.sandstone;
        return 0;
      }
      case SR_BADLANDS: {
        if (y >= 78 && !underwater) {
          if (run < 2) return S.redSand;
          if (run < 4) return S.whiteTerracotta;
        }
        if (run === 0 && underwater) return S.redSand;
        if (run < 15) return this.bands[((y % 64) + 64) & 63];
        return 0;
      }
      case SR_PODZOL: {
        if (run === 0) return underwater ? b.underwaterState
          : (pn > 0.32 ? S.coarseDirt : S.podzol);
        if (run < soil) return S.dirt;
        return 0;
      }
      case SR_GRAVEL: {
        const gravelly = pn > 0.05;
        if (run === 0) return underwater || gravelly ? S.gravel : b.surfaceState;
        if (run < soil) return gravelly ? S.gravel : S.dirt;
        return 0;
      }
      case SR_ICE: {
        if (run < soil) return pn > 0.45 ? S.blueIce : b.surfaceState;
        return 0;
      }
      case SR_MUD: {
        if (run < soil + 2) return S.mud;
        if (run < soil + 4) return S.dirt;
        return 0;
      }
      default: {
        if (run === 0) return underwater ? b.underwaterState : b.surfaceState;
        if (run < soil) return underwater ? b.subsurfaceState : b.subsurfaceState;
        return 0;
      }
    }
  }

  /** Cave-biome floor treatment, applied well below the daylight surface. */
  caveFloorState(rule, pn) {
    const S = this.S;
    if (rule === CR_LUSH) return pn > -0.35 ? S.moss : 0;
    if (rule === CR_DRIPSTONE) return pn > 0.15 ? S.dripstone : 0;
    if (rule === CR_DEEP_DARK) return pn > -0.1 ? S.sculk : 0;
    return 0;
  }

  /**
   * Snow layers, frozen water and powder snow — the parts of the surface rules
   * that sit *above* the terrain rather than in it.
   */
  capColumn(ci, top, bid, biome, pn) {
    const buf = this.buf, S = this.S;
    // Ice over exposed water.
    if (this.freezes[bid]) {
      const wIdx = bufIndex(SEA_LEVEL, ci);
      if (buf[wIdx] === S.water && buf[wIdx + COLUMNS] === 0) buf[wIdx] = S.ice;
    }
    if (top < SEA_LEVEL - 1 || top >= MAX_Y) return;
    const idx = bufIndex(top, ci);
    if (buf[idx + COLUMNS] !== 0) return;    // something already sits on top
    // Altitude lapse rate: high enough, even a temperate biome gets a snow cap.
    const t = this.biomeTemp[bid] - Math.max(0, top - 80) * 0.0075;
    if (!this.snowy[bid] && t >= 0.15) return;
    const host = buf[idx];
    if (host === S.water || host === S.lava || host === 0) return;
    if (host === S.grass) buf[idx] = S.grassSnowy;
    if (host === S.snowBlock && pn > 0.55) { buf[idx] = S.powderSnow; return; }
    const layers = pn > 0.3 ? 2 : 1;
    buf[idx + COLUMNS] = layers === 1 ? S.snowLayer
      : withProp(S.snowLayer, 'layers', 2);
    void biome;
  }

  // -- Bedrock & ores --------------------------------------------------------

  placeBedrock(x0, z0) {
    const buf = this.buf, S = this.S;
    const base = 0;   // y === MIN_Y
    for (let ci = 0; ci < COLUMNS; ci++) buf[base + ci] = S.bedrock;
    for (let d = 1; d <= 4; d++) {
      const y = MIN_Y + d;
      const p = 1 - d / 5;
      const off = d * COLUMNS;
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const h = hash3(this.seed ^ 0xb3d51e, x0 + lx, y, z0 + lz);
          if ((h >>> 8) * (1 / 16777216) < p) buf[off + lz * CHUNK_SIZE + lx] = S.bedrock;
        }
      }
    }
  }

  placeOres(cx, cz) {
    let salt = 0;
    for (let i = 0; i < this.ores.length; i++) this.placeVeins(this.ores[i], cx, cz, salt++);
    let mesa = false, mountain = false;
    for (let i = 0; i < 16; i++) {
      const cat = BIOMES[this.cellSurfaceBiome[i]].category;
      if (cat === 'mesa') mesa = true;
      else if (cat === 'mountain') mountain = true;
    }
    if (mesa) this.placeVeins(this.badlandsGold, cx, cz, 60);
    if (mountain) this.placeVeins(this.mountainEmerald, cx, cz, 61);
  }

  /** Seed the inline xorshift used for ore placement. */
  _seed(v) { this._rs = (v | 0) || 0x9e3779b9; }

  _rand() {
    let s = this._rs;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this._rs = s | 0;
    return (s >>> 0) * 2.3283064365386963e-10;
  }

  /**
   * Place one ore's veins in this chunk. Veins are ellipsoids sized so their
   * volume matches Minecraft's vein size, walked over their bounding box; the
   * deepslate variant is chosen from the host block rather than from y, so the
   * ore boundary is exactly as noisy as the deepslate boundary itself.
   */
  placeVeins(cfg, cx, cz, salt) {
    const buf = this.buf, S = this.S;
    this._seed(hash3(this.seed ^ 0x0e5f11, cx, cz, salt));
    const baseR = Math.cbrt(cfg.size) * 0.62;
    for (let v = 0; v < cfg.tries; v++) {
      const px = this._rand() * CHUNK_SIZE;
      const pz = this._rand() * CHUNK_SIZE;
      const y = oreY(cfg, this._rand(), this._rand());
      if (y < MIN_Y + 1 || y > MAX_Y - 1) continue;
      const rx = baseR * (0.75 + this._rand() * 0.5);
      const ry = baseR * (0.60 + this._rand() * 0.6);
      const rz = baseR * (0.75 + this._rand() * 0.5);
      const bx0 = Math.max(0, Math.ceil(px - rx - 0.5));
      const bx1 = Math.min(CHUNK_SIZE - 1, Math.floor(px + rx - 0.5));
      const bz0 = Math.max(0, Math.ceil(pz - rz - 0.5));
      const bz1 = Math.min(CHUNK_SIZE - 1, Math.floor(pz + rz - 0.5));
      const by0 = Math.max(MIN_Y + 1, Math.ceil(y - ry));
      const by1 = Math.min(MAX_Y, Math.floor(y + ry));
      for (let by = by0; by <= by1; by++) {
        const dy = (by - y) / ry;
        const dy2 = dy * dy;
        if (dy2 > 1) continue;
        const rowBase = (by - MIN_Y) * COLUMNS;
        for (let bz = bz0; bz <= bz1; bz++) {
          const dz = (bz + 0.5 - pz) / rz;
          const dz2 = dz * dz;
          if (dy2 + dz2 > 1) continue;
          for (let bx = bx0; bx <= bx1; bx++) {
            const dx = (bx + 0.5 - px) / rx;
            if (dy2 + dz2 + dx * dx > 1) continue;
            const idx = rowBase + bz * CHUNK_SIZE + bx;
            const host = buf[idx];
            if (host === S.stone || host === S.granite || host === S.diorite ||
              host === S.andesite) {
              buf[idx] = cfg.state;
            } else if (host === S.deepslate || host === S.tuff) {
              buf[idx] = cfg.deepState || cfg.state;
            }
          }
        }
      }
    }
  }

  // -- Biomes ----------------------------------------------------------------

  writeBiomes(chunk) {
    const b = chunk.biomes;
    for (let cz = 0; cz < 4; cz++) {
      for (let cx = 0; cx < 4; cx++) {
        const cell = cz * 4 + cx;
        const surf = this.cellSurfaceBiome[cell];
        const mid = this.cellCaveBiome[cell];
        const deep = this.cellDeepBiome[cell];
        const surfY = this.cellSurfaceY[cell];
        const col = (cz << 2) | cx;
        for (let by = 0; by < SECTION_COUNT * 4; by++) {
          const d = (surfY - (MIN_Y + by * 4 + 2)) / 90;
          b[(by << 4) | col] = d < 0.2 ? surf : d < 0.85 ? mid : deep;
        }
      }
    }
  }
}

function resolveOre(cfg) {
  return {
    ...cfg,
    state: st(cfg.name, st('stone', 1)),
    deepState: cfg.deep ? st(cfg.deep, st(cfg.name, st('stone', 1))) : 0,
  };
}

// ===========================================================================
// Nether
// ===========================================================================

const NETHER_FLOOR = 0;
const NETHER_CEIL = 127;
const NETHER_LAVA = 31;

/** Nether biomes as points in a two-axis climate, nearest match with offsets. */
const NETHER_POINTS = [
  { name: 'nether_wastes', t: 0.0, h: 0.0, off: 0.0 },
  { name: 'soul_sand_valley', t: 0.0, h: -0.5, off: 0.0 },
  { name: 'crimson_forest', t: 0.4, h: 0.0, off: 0.0 },
  { name: 'warped_forest', t: 0.0, h: 0.5, off: 0.375 },
  { name: 'basalt_deltas', t: -0.5, h: 0.0, off: 0.175 },
];

export class NetherGenerator {
  constructor(seed) {
    this.seed = (seed ^ 0x4e455448) | 0;
    this.dimension = 'nether';
    resolveBiomeStates(true);
    this.S = commonStates();

    const s = this.seed;
    this.nFloor = namedNoise(s, 'nether_floor', 4, { scale: 1 / 210, persistence: 0.5 });
    this.nCeil = namedNoise(s, 'nether_ceiling', 3, { scale: 1 / 170, persistence: 0.5 });
    this.nDetail = namedNoise(s, 'nether_detail', 4, { scale: 1 / 86, persistence: 0.5 });
    this.nCave = namedNoise(s, 'nether_cave', 3, { scale: 1 / 64, persistence: 0.55 });
    this.nTemp = namedNoise(s, 'nether_temperature', 3, { scale: 1 / 640 });
    this.nHumid = namedNoise(s, 'nether_humidity', 3, { scale: 1 / 520 });
    this.nPatch = namedNoise(s, 'nether_patch', 2, { scale: 1 / 26 });
    this.nDelta = namedNoise(s, 'nether_delta', 3, { scale: 1 / 34 });

    this.biomeIds = NETHER_POINTS.map((p) =>
      BIOMES.find((b) => b.name === p.name)?.id ?? 0);
    this.buf = new Uint16Array(BUF_SIZE);
    this.floorH = new Float32Array(COLUMNS);
    this.ceilH = new Float32Array(COLUMNS);
    this.colBiome = new Uint8Array(COLUMNS);
    this.densLat = new Float32Array(LAT2 * (Math.ceil(128 / CELL_Y) + 2));
    this.sliceA = new Float32Array(LAT2);
    this.rowA = new Float32Array(LAT);
    this._rs = 1;
    this.ores = [
      { name: 'nether_quartz_ore', tries: 16, size: 14, minY: 10, maxY: 117, dist: 'uniform' },
      { name: 'nether_gold_ore', tries: 10, size: 10, minY: 10, maxY: 117, dist: 'uniform' },
      { name: 'gravel', tries: 2, size: 33, minY: 5, maxY: 41, dist: 'uniform' },
      { name: 'magma_block', tries: 4, size: 33, minY: 27, maxY: 36, dist: 'uniform' },
      { name: 'soul_sand', tries: 12, size: 12, minY: 5, maxY: 41, dist: 'uniform' },
    ].map((c) => ({ ...c, state: st(c.name, this.S.netherrack), deepState: 0 }));
  }

  getBiomeAt(x, y, z) {
    const t = this.nTemp.sample2(x, z);
    const h = this.nHumid.sample2(x, z);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < NETHER_POINTS.length; i++) {
      const p = NETHER_POINTS[i];
      const dt = t - p.t, dh = h - p.h;
      const d = dt * dt + dh * dh + p.off * p.off;
      if (d < bestD) { bestD = d; best = this.biomeIds[i]; }
    }
    void y;
    return best;
  }

  generateChunk(chunk) {
    const x0 = chunk.x0, z0 = chunk.z0;
    const buf = this.buf, S = this.S;
    buf.fill(0);

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const ci = lz * CHUNK_SIZE + lx;
        const wx = x0 + lx, wz = z0 + lz;
        this.floorH[ci] = 36 + this.nFloor.sample2(wx, wz) * 22;
        this.ceilH[ci] = 100 + this.nCeil.sample2(wx, wz) * 16;
        this.colBiome[ci] = this.getBiomeAt(wx, 64, wz);
      }
    }

    // Detail noise on the usual coarse lattice.
    const levels = Math.floor(128 / CELL_Y) + 1;
    let o = 0;
    for (let l = 0; l < levels; l++) {
      const y = l * CELL_Y;
      for (let j = 0; j < LAT; j++) {
        for (let i = 0; i < LAT; i++, o++) {
          this.densLat[o] = this.nDetail.sample3(x0 + i * CELL_X, y * 0.8, z0 + j * CELL_X);
          this.densLat[o] += this.nCave.sample3(x0 + i * CELL_X, y * 1.5, z0 + j * CELL_X) * 0.6;
        }
      }
    }

    const sA = this.sliceA, rowA = this.rowA;
    for (let y = NETHER_FLOOR; y <= NETHER_CEIL; y++) {
      const base = (y - MIN_Y) * COLUMNS;
      const f = y / CELL_Y;
      let l = Math.floor(f);
      if (l >= levels - 1) l = levels - 2;
      OverworldGenerator.slice(this.densLat, l, f - l, sA);
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const j = lz >> 2, fz = (lz & 3) * 0.25;
        const r0 = j * LAT, r1 = r0 + LAT;
        for (let i = 0; i < LAT; i++) rowA[i] = sA[r0 + i] + (sA[r1 + i] - sA[r0 + i]) * fz;
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const ci = lz * CHUNK_SIZE + lx;
          const i = lx >> 2, fx = (lx & 3) * 0.25;
          const n = rowA[i] + (rowA[i + 1] - rowA[i]) * fx;
          const below = y < this.floorH[ci] + n * 9;
          const above = y > this.ceilH[ci] + n * 7;
          if (below || above) buf[base + ci] = S.netherrack;
          else if (y <= NETHER_LAVA) buf[base + ci] = S.lava;
        }
      }
    }

    this.applySurface(x0, z0);
    this.placeNetherBedrock(x0, z0);
    for (let i = 0; i < this.ores.length; i++) {
      this.placeVeins(this.ores[i], chunk.cx, chunk.cz, i);
    }
    writeSections(chunk, buf);

    const b = chunk.biomes;
    for (let cz = 0; cz < 4; cz++) {
      for (let cx = 0; cx < 4; cx++) {
        const id = this.colBiome[(cz * 4 + 2) * CHUNK_SIZE + cx * 4 + 2];
        const col = (cz << 2) | cx;
        for (let by = 0; by < SECTION_COUNT * 4; by++) b[(by << 4) | col] = id;
      }
    }
    return chunk;
  }

  applySurface(x0, z0) {
    const buf = this.buf, S = this.S;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const ci = lz * CHUNK_SIZE + lx;
        const b = BIOMES[this.colBiome[ci]];
        const wx = x0 + lx, wz = z0 + lz;
        const pn = this.nPatch.sample2(wx, wz);
        const dl = this.nDelta.sample2(wx, wz);
        let run = -1, above = 0;
        for (let y = NETHER_CEIL; y >= NETHER_FLOOR; y--) {
          const idx = bufIndex(y, ci);
          const s = buf[idx];
          if (s !== S.netherrack) { run = -1; above = s; continue; }
          if (run < 0) run = 0;
          if (run < 4 && above !== S.netherrack) {
            let ns = 0;
            switch (b.name) {
              case 'soul_sand_valley':
                ns = run === 0 ? (pn > 0 ? S.soulSand : S.soulSoil)
                  : (pn > 0.2 ? S.soulSoil : S.soulSand);
                break;
              case 'crimson_forest':
                ns = run === 0 ? S.crimsonNylium : 0; break;
              case 'warped_forest':
                ns = run === 0 ? S.warpedNylium : 0; break;
              case 'basalt_deltas':
                ns = dl > 0.25 ? S.basalt : (dl > -0.1 ? S.blackstone : S.basalt);
                if (run === 0 && pn > 0.6) ns = S.magma;
                break;
              default:
                if (run === 0 && pn > 0.62) ns = S.soulSand;
                else if (run === 0 && pn < -0.62) ns = this.S.gravelState ?? 0;
                break;
            }
            if (ns) buf[idx] = ns;
          }
          run++;
          above = s;
        }
      }
    }
  }

  placeNetherBedrock(x0, z0) {
    const buf = this.buf, S = this.S;
    for (let ci = 0; ci < COLUMNS; ci++) {
      buf[bufIndex(NETHER_FLOOR, ci)] = S.bedrock;
      buf[bufIndex(NETHER_CEIL, ci)] = S.bedrock;
    }
    for (let d = 1; d <= 4; d++) {
      const p = 1 - d / 5;
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const ci = lz * CHUNK_SIZE + lx;
          const wx = x0 + lx, wz = z0 + lz;
          if ((hash3(this.seed ^ 0xb3d, wx, d, wz) >>> 8) * (1 / 16777216) < p) {
            buf[bufIndex(NETHER_FLOOR + d, ci)] = S.bedrock;
          }
          if ((hash3(this.seed ^ 0xc4e, wx, d, wz) >>> 8) * (1 / 16777216) < p) {
            buf[bufIndex(NETHER_CEIL - d, ci)] = S.bedrock;
          }
        }
      }
    }
  }

  _seed(v) { this._rs = (v | 0) || 0x9e3779b9; }

  _rand() {
    let s = this._rs;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this._rs = s | 0;
    return (s >>> 0) * 2.3283064365386963e-10;
  }

  placeVeins(cfg, cx, cz, salt) {
    const buf = this.buf, S = this.S;
    this._seed(hash3(this.seed ^ 0x0e5f11, cx, cz, salt));
    const baseR = Math.cbrt(cfg.size) * 0.62;
    for (let v = 0; v < cfg.tries; v++) {
      const px = this._rand() * CHUNK_SIZE;
      const pz = this._rand() * CHUNK_SIZE;
      const y = oreY(cfg, this._rand(), this._rand());
      const r = baseR * (0.8 + this._rand() * 0.4);
      const by0 = Math.max(NETHER_FLOOR + 1, Math.ceil(y - r));
      const by1 = Math.min(NETHER_CEIL - 1, Math.floor(y + r));
      for (let by = by0; by <= by1; by++) {
        const dy = (by - y) / r, dy2 = dy * dy;
        if (dy2 > 1) continue;
        for (let bz = 0; bz < CHUNK_SIZE; bz++) {
          const dz = (bz + 0.5 - pz) / r, dz2 = dz * dz;
          if (dy2 + dz2 > 1) continue;
          for (let bx = 0; bx < CHUNK_SIZE; bx++) {
            const dx = (bx + 0.5 - px) / r;
            if (dy2 + dz2 + dx * dx > 1) continue;
            const idx = bufIndex(by, bz * CHUNK_SIZE + bx);
            if (buf[idx] === S.netherrack) buf[idx] = cfg.state;
          }
        }
      }
    }
  }
}

// ===========================================================================
// The End
// ===========================================================================

const END_CENTER_Y = 58;

export class EndGenerator {
  constructor(seed) {
    this.seed = (seed ^ 0x454e4421) | 0;
    this.dimension = 'end';
    resolveBiomeStates(true);
    this.S = commonStates();
    const s = this.seed;
    this.nIsland = namedNoise(s, 'end_islands', 3, { scale: 1 / 820, persistence: 0.5 });
    this.nSmall = namedNoise(s, 'end_small_islands', 2, { scale: 1 / 180 });
    this.nDetail = namedNoise(s, 'end_detail', 3, { scale: 1 / 62, persistence: 0.5 });
    this.buf = new Uint16Array(BUF_SIZE);
    this.colValue = new Float32Array(COLUMNS);
    this.densLat = new Float32Array(LAT2 * 20);
    this.sliceA = new Float32Array(LAT2);
    this.rowA = new Float32Array(LAT);
    this.ids = {
      the_end: idOf('the_end'), end_highlands: idOf('end_highlands'),
      end_midlands: idOf('end_midlands'), end_barrens: idOf('end_barrens'),
      small_end_islands: idOf('small_end_islands'),
    };
  }

  /**
   * Island strength at a point: a cone for the central island, plus outer
   * islands lifted out of two noise fields beyond the void ring.
   */
  islandValue(x, z) {
    const d = Math.sqrt(x * x + z * z);
    let v = 100 - d * 0.9;
    if (d > 560) {
      const n = this.nIsland.sample2(x, z);
      const outer = (n - 0.16) * 280;
      if (outer > v) v = outer;
      const small = (this.nSmall.sample2(x, z) - 0.62) * 90;
      if (small > v) v = small;
    }
    return clamp(v, -120, 110);
  }

  getBiomeAt(x, y, z) {
    void y;
    const d = Math.sqrt(x * x + z * z);
    if (d < 640) return this.ids.the_end;
    const v = this.islandValue(x, z);
    if (v > 45) return this.ids.end_highlands;
    if (v > 18) return this.ids.end_midlands;
    if (v > 0) return this.ids.end_barrens;
    return this.ids.small_end_islands;
  }

  generateChunk(chunk) {
    const x0 = chunk.x0, z0 = chunk.z0;
    const buf = this.buf, S = this.S;
    buf.fill(0);

    let maxV = -Infinity;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const v = this.islandValue(x0 + lx, z0 + lz);
        this.colValue[lz * CHUNK_SIZE + lx] = v;
        if (v > maxV) maxV = v;
      }
    }

    if (maxV > 0) {
      const yLo = END_CENTER_Y - 32, yHi = END_CENTER_Y + 32;
      const levels = Math.floor((yHi - yLo) / CELL_Y) + 1;
      let o = 0;
      for (let l = 0; l < levels; l++) {
        const y = yLo + l * CELL_Y;
        for (let j = 0; j < LAT; j++) {
          for (let i = 0; i < LAT; i++, o++) {
            this.densLat[o] = this.nDetail.sample3(x0 + i * CELL_X, y * 0.9, z0 + j * CELL_X);
          }
        }
      }
      const sA = this.sliceA, rowA = this.rowA;
      for (let y = yLo; y <= yHi; y++) {
        const base = (y - MIN_Y) * COLUMNS;
        const f = (y - yLo) / CELL_Y;
        let l = Math.floor(f);
        if (l >= levels - 1) l = levels - 2;
        OverworldGenerator.slice(this.densLat, l, f - l, sA);
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const j = lz >> 2, fz = (lz & 3) * 0.25;
          const r0 = j * LAT, r1 = r0 + LAT;
          for (let i = 0; i < LAT; i++) rowA[i] = sA[r0 + i] + (sA[r1 + i] - sA[r0 + i]) * fz;
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const ci = lz * CHUNK_SIZE + lx;
            const v = this.colValue[ci];
            if (v <= 0) continue;
            const i = lx >> 2, fx = (lx & 3) * 0.25;
            const n = rowA[i] + (rowA[i + 1] - rowA[i]) * fx;
            // Lens-shaped islands: thick in the middle, tapering to the rim.
            const half = 3 + v * 0.17;
            if (half - Math.abs(y - END_CENTER_Y) + n * 4 > 0) buf[base + ci] = S.endStone;
          }
        }
      }
    }

    writeSections(chunk, buf);
    const b = chunk.biomes;
    for (let cz = 0; cz < 4; cz++) {
      for (let cx = 0; cx < 4; cx++) {
        const id = this.getBiomeAt(x0 + cx * 4 + 2, END_CENTER_Y, z0 + cz * 4 + 2);
        const col = (cz << 2) | cx;
        for (let by = 0; by < SECTION_COUNT * 4; by++) b[(by << 4) | col] = id;
      }
    }
    return chunk;
  }
}

function idOf(name) {
  const b = BIOMES.find((x) => x.name === name);
  return b ? b.id : 0;
}

export { commonStates, st as blockState };
