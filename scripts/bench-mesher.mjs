// Mesher benchmark. Builds a synthetic chunk that looks like real terrain
// (stone below, dirt/grass on top, ore pockets, caves, a water pool and plants)
// and times meshSection over it. Meshing runs on the main thread inside a
// per-frame budget, so per-section cost is the number that matters.
import { blocksByName, freezeBlocks, T } from '../src/world/blocks.js';
import { Chunk, MIN_Y, SECTION_COUNT, SECTION_HEIGHT } from '../src/world/chunk.js';
import { meshSection } from '../src/render/mesher.js';
import { Random } from '../src/core/rng.js';
import { OctaveNoise } from '../src/core/noise.js';

const bd = await import('../src/world/blockdefs.js');
bd.registerAllBlocks();

const id = (n) => blocksByName.get(n)?.defaultState ?? 0;
const STONE = id('stone'), DIRT = id('dirt'), GRASS = id('grass_block');
const WATER = id('water'), COAL = id('coal_ore'), IRON = id('iron_ore');
const LOG = id('oak_log'), LEAVES = id('oak_leaves'), FLOWER = id('poppy');
const TORCH = id('torch');

// A minimal world façade: the mesher only needs these four methods.
class FakeWorld {
  constructor() { this.chunks = new Map(); }
  getChunkAt(x, z) { return this.chunks.get(`${x >> 4},${z >> 4}`) ?? null; }
  getSurfaceBiomeAt() { return 0; }
  getBlock(x, y, z) {
    const c = this.getChunkAt(x, z);
    return c ? c.getBlock(x & 15, y, z & 15) : 0;
  }
  getSkyLight(x, y, z) { return y > 70 ? 15 : Math.max(0, 15 - (70 - y)); }
  getBlockLight(x, y, z) { return 0; }
}

const world = new FakeWorld();
const rng = new Random(7);
const surfaceNoise = new OctaveNoise(new Random(11), 4, { scale: 0.02 });
const caveNoise = new OctaveNoise(new Random(13), 3, { scale: 0.06 });

// Build a 3x3 block of chunks so border lookups hit real data.
for (let cz = -1; cz <= 1; cz++) {
  for (let cx = -1; cx <= 1; cx++) {
    const chunk = new Chunk(world, cx, cz);
    world.chunks.set(`${cx},${cz}`, chunk);
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const wx = cx * 16 + lx, wz = cz * 16 + lz;
        const h = 64 + Math.round(surfaceNoise.sample2(wx, wz) * 14);
        for (let y = MIN_Y; y <= h; y++) {
          if (y > MIN_Y + 4 && caveNoise.sample3(wx, y, wz) > 0.55) continue;  // cave
          let b = STONE;
          if (y === h) b = h < 62 ? DIRT : GRASS;
          else if (y > h - 4) b = DIRT;
          else if (rng.next() < 0.004) b = rng.chance(0.6) ? COAL : IRON;
          chunk.setBlock(lx, y, lz, b);
        }
        for (let y = h + 1; y <= 62; y++) chunk.setBlock(lx, y, lz, WATER);
        if (h >= 62 && rng.next() < 0.06) chunk.setBlock(lx, h + 1, lz, FLOWER);
        if (h >= 62 && rng.next() < 0.004) {
          for (let t = 1; t <= 5; t++) chunk.setBlock(lx, h + t, lz, LOG);
          for (let dy = 4; dy <= 6; dy++) {
            for (let dz = -2; dz <= 2; dz++) {
              for (let dx = -2; dx <= 2; dx++) {
                if (lx + dx < 0 || lx + dx > 15 || lz + dz < 0 || lz + dz > 15) continue;
                if (chunk.getBlock(lx + dx, h + dy, lz + dz) === 0) {
                  chunk.setBlock(lx + dx, h + dy, lz + dz, LEAVES);
                }
              }
            }
          }
        }
        if (rng.next() < 0.001) chunk.setBlock(lx, Math.max(MIN_Y + 6, h - 20), lz, TORCH);
      }
    }
    chunk.recomputeHeightmaps();
  }
}

const chunk = world.chunks.get('0,0');
let nonEmpty = 0;
for (let sy = 0; sy < SECTION_COUNT; sy++) {
  if (chunk.sections[sy] && !chunk.sections[sy].empty) nonEmpty++;
}

// Warm up, then time.
for (let sy = 0; sy < SECTION_COUNT; sy++) meshSection(world, chunk, sy);

const RUNS = 20;
let tris = 0;
const t0 = performance.now();
for (let r = 0; r < RUNS; r++) {
  for (let sy = 0; sy < SECTION_COUNT; sy++) {
    const m = meshSection(world, chunk, sy);
    if (r === 0 && m) {
      for (const p of [m.solid, m.cutout, m.translucent]) if (p) tris += p.indexCount / 3;
    }
  }
}
const total = performance.now() - t0;

console.log(`non-empty sections: ${nonEmpty} / ${SECTION_COUNT}`);
console.log(`triangles per chunk column: ${tris.toLocaleString()}`);
console.log(`mesh time per chunk column: ${(total / RUNS).toFixed(2)} ms`);
console.log(`mesh time per section:      ${(total / RUNS / nonEmpty).toFixed(3)} ms`);
console.log(`at a 6 ms/frame budget: ${(6 / (total / RUNS)).toFixed(1)} chunk columns per frame`);
