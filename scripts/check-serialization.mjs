#!/usr/bin/env node
// Round-trip test for chunk serialisation.
//
// Builds a synthetic chunk that exercises every branch of the format — uniform
// sections, mixed sections with small and large palettes, run-heavy sections,
// materialised-but-uniform sections, partial and full light arrays, biomes,
// all three heightmaps and a handful of block entities — then serialises it,
// deserialises it into a second world and asserts that every observable byte
// survived. Finally it reports how the buffer compares to the naive
// representation the chunk uses in memory.
//
// Run: node scripts/check-serialization.mjs [--verbose]

import { registerAllBlocks } from '../src/world/blockdefs.js';
import { blocksByName } from '../src/world/blocks.js';
import { World } from '../src/world/world.js';
import {
  Chunk, CHUNK_SIZE, SECTION_COUNT, SECTION_VOLUME, MIN_Y, MAX_Y, CHUNK_STATE,
  localIndex,
} from '../src/world/chunk.js';
import {
  serializeChunk, deserializeChunk, readChunkHeader, RAW_CHUNK_BYTES, SAVE_VERSION,
} from '../src/world/serialization.js';
import { Random } from '../src/core/rng.js';

const verbose = process.argv.includes('--verbose');
const problems = [];
let checks = 0;
const check = (cond, msg) => { checks++; if (!cond) problems.push(msg); };

registerAllBlocks();

const state = (name) => {
  const b = blocksByName.get(name);
  if (!b) throw new Error(`test needs the block ${name}`);
  return b.defaultState;
};

const AIR = 0;
const STONE = state('stone');
const DIRT = state('dirt');
const GRASS = state('grass_block');
const BEDROCK = state('bedrock');
const WATER = state('water');
const OAK_LOG = state('oak_log');
const OAK_LEAVES = state('oak_leaves');
const SAND = state('sand');
const GLOWSTONE = state('glowstone');
const TORCH = state('torch');

// ---------------------------------------------------------------------------
// Build a synthetic chunk
// ---------------------------------------------------------------------------

const source = new World({ seed: 1234, dimension: 'overworld' });
const target = new World({ seed: 1234, dimension: 'overworld' });

const chunk = source.createChunk(3, -7);
const rng = new Random(0xc0ffee);

// Section 0 (y -64..-49): bedrock floor, materialised and mixed.
for (let y = MIN_Y; y < MIN_Y + 4; y++) {
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      chunk.setBlock(lx, y, lz, y === MIN_Y ? BEDROCK : (rng.next() < 0.1 ? DIRT : STONE));
    }
  }
}

// Sections 1..7: solid stone, written as genuinely uniform sections (blocks
// stays null) — the run-length fast path.
for (let sy = 1; sy <= 7; sy++) {
  const s = chunk.section(sy, true);
  s.uniform = STONE;
  s.blocks = null;
  s.nonAir = SECTION_VOLUME;
  s.empty = false;
}

// A materialised section that happens to hold a single state: the writer should
// still collapse it to one palette entry and zero index bits.
{
  const s = chunk.section(8, true);
  s.materialise().fill(STONE);
  s.nonAir = SECTION_VOLUME;
  s.empty = false;
}

// Rolling terrain around y = 64..96 with a wide palette and plenty of runs.
const ORES = ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore',
  'lapis_ore', 'copper_ore', 'emerald_ore']
  .filter((n) => blocksByName.has(n)).map(state);

for (let lz = 0; lz < CHUNK_SIZE; lz++) {
  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    const h = 68 + Math.round(Math.sin(lx * 0.4) * 4 + Math.cos(lz * 0.3) * 5);
    for (let y = MIN_Y + 64; y <= h; y++) {
      let st = STONE;
      if (y > h - 4) st = DIRT;
      if (y === h) st = h < 66 ? SAND : GRASS;
      if (y < h - 6 && ORES.length && rng.next() < 0.03) {
        st = ORES[rng.int(ORES.length)];
      }
      chunk.setBlock(lx, y, lz, st);
    }
    // A lake in one corner, so water and waterlogging show up in the palette.
    if (lx < 5 && lz < 5) {
      for (let y = h + 1; y <= 66; y++) chunk.setBlock(lx, y, lz, WATER);
    }
  }
}

// A tree, some light sources and scattered decoration high up, so the upper
// sections are sparse rather than empty.
for (let y = 80; y < 87; y++) chunk.setBlock(8, y, 8, OAK_LOG);
for (let dy = 0; dy < 3; dy++) {
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dz === 0 && dy < 2) continue;
      chunk.setBlock(8 + dx, 85 + dy, 8 + dz, OAK_LEAVES);
    }
  }
}
chunk.setBlock(2, 70, 2, GLOWSTONE);
chunk.setBlock(12, 71, 3, TORCH);
chunk.setBlock(1, 200, 1, GLOWSTONE);      // isolated high section

// Biomes: a couple of bands so the RLE has something to chew on.
for (let i = 0; i < chunk.biomes.length; i++) {
  chunk.biomes[i] = i < chunk.biomes.length / 2 ? 4 : (i % 3 === 0 ? 7 : 4);
}

chunk.recomputeHeightmaps();

// Light. Section 12 gets a fully populated pair of arrays, section 13 only
// block light, section 14 only sky light, and section 20 stays uniform-sky.
{
  const s = chunk.section(12, true);
  s.skyLight = new Uint8Array(SECTION_VOLUME);
  s.blockLight = new Uint8Array(SECTION_VOLUME);
  for (let i = 0; i < SECTION_VOLUME; i++) {
    s.skyLight[i] = (i * 7) % 16;
    s.blockLight[i] = i < 2048 ? 0 : 15 - ((i >> 4) % 16);
  }
}
{
  const s = chunk.section(13, true);
  s.blockLight = new Uint8Array(SECTION_VOLUME);
  s.blockLight.fill(9, 100, 900);
}
{
  const s = chunk.section(14, true);
  s.skyLight = new Uint8Array(SECTION_VOLUME);
  s.skyLight.fill(15);
  s.skyLight[0] = 3;
}
{
  const s = chunk.section(20, true);
  s.fillSkyLight(15);
}

// Block entities: a chest with items, a sign, a furnace mid-smelt.
chunk.setBlockEntity(4, 70, 6, {
  type: 'chest', id: 'minecraft:chest', lootSeed: 998,
  slots: [{ id: 'oak_planks', count: 12 }, null, { id: 'diamond', count: 3, damage: 0 }],
});
chunk.setBlockEntity(9, 71, 2, {
  type: 'sign', lines: ['Hello', 'from', 'the chunk', ''], glowing: true, color: 'orange',
});
chunk.setBlockEntity(11, 69, 13, {
  type: 'furnace', burnTime: 137, cookTime: 42, cookTotal: 200,
  slots: [{ id: 'raw_iron', count: 5 }, { id: 'coal', count: 2 }, null],
});
chunk.generatedStructures = ['village/house_2'];
chunk.status = CHUNK_STATE.READY;
chunk.inhabitedTime = 12345;

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

const t0 = process.hrtime.bigint();
const buffer = serializeChunk(chunk);
const t1 = process.hrtime.bigint();
const restored = deserializeChunk(target, 3, -7, buffer);
const t2 = process.hrtime.bigint();

const header = readChunkHeader(buffer);
check(header !== null, 'header probe failed');
check(header?.version === SAVE_VERSION, `header version ${header?.version}`);
check(header?.cx === 3 && header?.cz === -7,
  `header coords ${header?.cx},${header?.cz}`);

check(restored.cx === 3 && restored.cz === -7, 'restored chunk coordinates');
check(restored.status === chunk.status, `status ${restored.status} != ${chunk.status}`);
check(restored.inhabitedTime === chunk.inhabitedTime, 'inhabitedTime');

// --- every block ------------------------------------------------------------
let mismatched = 0, firstBad = null, nonAirBlocks = 0;
for (let y = MIN_Y; y <= MAX_Y; y++) {
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const a = chunk.getBlock(lx, y, lz);
      const b = restored.getBlock(lx, y, lz);
      if (a !== 0) nonAirBlocks++;
      if (a !== b) {
        mismatched++;
        if (!firstBad) firstBad = `${lx},${y},${lz}: ${a} != ${b}`;
      }
    }
  }
}
check(mismatched === 0, `${mismatched} block mismatches (first: ${firstBad})`);

// --- section shape ----------------------------------------------------------
let shapeProblems = 0;
for (let sy = 0; sy < SECTION_COUNT; sy++) {
  const a = chunk.sections[sy], b = restored.sections[sy];
  if (!a !== !b) { shapeProblems++; continue; }
  if (!a) continue;
  if (!!a.blocks !== !!b.blocks) {
    shapeProblems++;
    if (verbose) console.log(`  section ${sy}: blocks array presence differs`);
  }
  if (!a.blocks && a.uniform !== b.uniform) shapeProblems++;
  if (a.nonAir !== b.nonAir) {
    shapeProblems++;
    if (verbose) console.log(`  section ${sy}: nonAir ${a.nonAir} != ${b.nonAir}`);
  }
  if (a.empty !== b.empty) shapeProblems++;
  if (a.uniformSky !== b.uniformSky) shapeProblems++;
}
check(shapeProblems === 0, `${shapeProblems} section-shape differences`);

// --- light ------------------------------------------------------------------
let lightProblems = 0, lightCells = 0, firstLightBad = null;
for (let sy = 0; sy < SECTION_COUNT; sy++) {
  const a = chunk.sections[sy], b = restored.sections[sy];
  if (!a || !b) continue;
  if (!!a.skyLight !== !!b.skyLight) {
    lightProblems++;
    if (verbose) console.log(`  section ${sy}: skyLight presence differs`);
  }
  if (!!a.blockLight !== !!b.blockLight) {
    lightProblems++;
    if (verbose) console.log(`  section ${sy}: blockLight presence differs`);
  }
  for (let i = 0; i < SECTION_VOLUME; i++) {
    lightCells += 2;
    if (a.getSkyLight(i) !== b.getSkyLight(i)) {
      lightProblems++;
      firstLightBad ??= `sky s${sy}[${i}] ${a.getSkyLight(i)} != ${b.getSkyLight(i)}`;
    }
    if (a.getBlockLight(i) !== b.getBlockLight(i)) {
      lightProblems++;
      firstLightBad ??= `block s${sy}[${i}] ${a.getBlockLight(i)} != ${b.getBlockLight(i)}`;
    }
  }
}
check(lightProblems === 0, `${lightProblems} light mismatches (first: ${firstLightBad})`);

// Also check through the chunk-level accessors, which fall back to the
// heightmap for absent sections.
let chunkLightProblems = 0;
for (let y = MIN_Y; y <= MAX_Y; y += 3) {
  for (let lz = 0; lz < CHUNK_SIZE; lz += 5) {
    for (let lx = 0; lx < CHUNK_SIZE; lx += 5) {
      if (chunk.getSkyLight(lx, y, lz) !== restored.getSkyLight(lx, y, lz)) chunkLightProblems++;
      if (chunk.getBlockLight(lx, y, lz) !== restored.getBlockLight(lx, y, lz)) chunkLightProblems++;
    }
  }
}
check(chunkLightProblems === 0, `${chunkLightProblems} chunk-level light mismatches`);

// --- heightmaps and biomes --------------------------------------------------
const sameArray = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
check(sameArray(chunk.heightmap, restored.heightmap), 'heightmap differs');
check(sameArray(chunk.lightHeightmap, restored.lightHeightmap), 'lightHeightmap differs');
check(sameArray(chunk.surfaceHeightmap, restored.surfaceHeightmap), 'surfaceHeightmap differs');
check(sameArray(chunk.biomes, restored.biomes), 'biomes differ');

// --- block entities ---------------------------------------------------------
check(restored.blockEntities.size === chunk.blockEntities.size,
  `block entity count ${restored.blockEntities.size} != ${chunk.blockEntities.size}`);
let beProblems = 0;
for (const [key, be] of chunk.blockEntities) {
  const other = restored.blockEntities.get(key);
  if (JSON.stringify(be) !== JSON.stringify(other)) {
    beProblems++;
    if (verbose) console.log(`  block entity ${key}: ${JSON.stringify(other)}`);
  }
}
check(beProblems === 0, `${beProblems} block entities did not round-trip`);
check(restored.getBlockEntity(4, 70, 6)?.type === 'chest',
  'chest block entity is not addressable at its original position');
check(restored.getBlockEntity(4, 70, 6)?.slots?.[2]?.count === 3,
  'nested item data lost');
check(JSON.stringify(restored.generatedStructures) ===
  JSON.stringify(chunk.generatedStructures), 'generatedStructures differ');

// --- a second round trip must be byte-identical ------------------------------
const buffer2 = serializeChunk(restored);
check(buffer2.byteLength === buffer.byteLength,
  `re-serialised size ${buffer2.byteLength} != ${buffer.byteLength}`);
check(sameArray(new Uint8Array(buffer), new Uint8Array(buffer2)),
  're-serialising the restored chunk produced different bytes');

// --- an empty chunk still round-trips ---------------------------------------
{
  const emptyWorld = new World({ seed: 1, dimension: 'overworld' });
  const emptyTarget = new World({ seed: 1, dimension: 'overworld' });
  const empty = emptyWorld.createChunk(0, 0);
  const buf = serializeChunk(empty);
  const back = deserializeChunk(emptyTarget, 0, 0, buf);
  check(back.sections.every((s) => s === null), 'empty chunk gained sections');
  check(back.heightmap[0] === MIN_Y - 1, 'empty chunk heightmap wrong');
  check(buf.byteLength < 512, `empty chunk took ${buf.byteLength} bytes`);
  if (verbose) console.log(`  empty chunk: ${buf.byteLength} bytes`);
}

// --- a rejected buffer must throw rather than corrupt a world ----------------
{
  let threw = false;
  try {
    deserializeChunk(target, 0, 0, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer);
  } catch { threw = true; }
  check(threw, 'a garbage buffer was accepted');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const packed = buffer.byteLength;

// What the same data costs uncompressed: the block arrays every section would
// need as a plain Uint16Array, plus the light nibble arrays, heightmaps and
// biomes as they sit in memory.
const rawBlocks = RAW_CHUNK_BYTES;
const rawLight = SECTION_COUNT * SECTION_VOLUME * 2;      // sky + block, one byte each
const rawHeightmaps = CHUNK_SIZE * CHUNK_SIZE * 2 * 3;
const rawBiomes = chunk.biomes.length;
const rawTotal = rawBlocks + rawLight + rawHeightmaps + rawBiomes;

const sectionsPresent = chunk.sections.filter(Boolean).length;
const sectionsUniform = chunk.sections.filter((s) => s && !s.blocks).length;

console.log(`chunk:          ${sectionsPresent}/${SECTION_COUNT} sections present, ` +
  `${sectionsUniform} uniform, ${nonAirBlocks} non-air blocks`);
console.log(`block entities: ${chunk.blockEntities.size}`);
console.log(`serialised:     ${packed.toLocaleString()} bytes ` +
  `(encode ${(Number(t1 - t0) / 1e6).toFixed(2)} ms, ` +
  `decode ${(Number(t2 - t1) / 1e6).toFixed(2)} ms)`);
console.log(`raw blocks:     ${rawBlocks.toLocaleString()} bytes (Uint16 x ${SECTION_COUNT} sections)`);
console.log(`raw everything: ${rawTotal.toLocaleString()} bytes (blocks + light + heightmaps + biomes)`);
console.log('');
console.log(`compression vs raw block array: ${(rawBlocks / packed).toFixed(2)}x ` +
  `(${(100 - (packed / rawBlocks) * 100).toFixed(1)}% smaller)`);
console.log(`compression vs full in-memory:  ${(rawTotal / packed).toFixed(2)}x ` +
  `(${(100 - (packed / rawTotal) * 100).toFixed(1)}% smaller)`);
console.log(`bytes per non-air block:        ${(packed / Math.max(1, nonAirBlocks)).toFixed(2)}`);

check(packed < rawBlocks / 4,
  `only ${(rawBlocks / packed).toFixed(2)}x smaller than the raw block array`);
check(lightCells > 0, 'no light cells were compared');

console.log('');
if (problems.length) {
  console.error(`${problems.length} of ${checks} checks failed:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`all ${checks} checks passed`);
