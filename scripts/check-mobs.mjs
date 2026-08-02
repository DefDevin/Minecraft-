// Mob registry checks: every species builds, ticks and drops sanely.
import { blocksByName, T } from '../src/world/blocks.js';
import { Chunk, MIN_Y } from '../src/world/chunk.js';
import { World } from '../src/world/world.js';
import { itemsByName } from '../src/game/items.js';
const bd = await import('../src/world/blockdefs.js'); bd.registerAllBlocks();
const idf = await import('../src/game/itemdefs.js'); idf.registerAllItems();
const M = await import('../src/entity/mobs.js');
const models = await import('../src/entity/models.js');

let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  if (ok) { pass++; } else { fail++; console.log(`  FAIL  ${n}${d ? `  (${d})` : ''}`); }
};

const count = M.registerAllMobs();
console.log(`mobs: ${count}   models available: ${models.modelNames().length}`);

// Build a small flat world.
const world = new World({ seed: 1, dimension: 'overworld' });
const stone = blocksByName.get('stone').defaultState;
const grass = blocksByName.get('grass_block').defaultState;
for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
  const c = world.createChunk(cx, cz);
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    for (let y = 60; y < 64; y++) c.setBlock(lx, y, lz, y === 63 ? grass : stone);
  }
  c.recomputeHeightmaps();
  c.status = 4;
}
world.light.initialiseChunkLight(world.getChunk(0, 0));
world.light.process(200000);

// Every mob instantiates, ticks and stays finite.
let noModel = [], threw = [], nan = [];
for (const name of M.mobNames()) {
  let mob;
  try {
    mob = M.spawn(world, name, 8.5, 64, 8.5);
    if (!mob) { threw.push(`${name}: spawn returned null`); continue; }
  } catch (e) { threw.push(`${name}: ${e.message}`); continue; }
  if (!models.hasModel(mob.modelName)) noModel.push(name);
  try {
    for (let i = 0; i < 200; i++) mob.tick(world);
  } catch (e) { threw.push(`${name} tick: ${e.message}`); }
  if (!Number.isFinite(mob.x) || !Number.isFinite(mob.y) || !Number.isFinite(mob.z)) {
    nan.push(name);
  }
  world.removeEntity(mob);
}
check('every mob instantiates and ticks', threw.length === 0, threw.slice(0, 5).join(' | '));
check('no mob reaches a NaN position', nan.length === 0, nan.join(', '));
check('every mob has a model', noModel.length === 0, noModel.join(', '));

// Drops resolve to real items.
const badDrops = [];
for (const [name, d] of M.MOBS) {
  for (const drop of d.drops ?? []) {
    if (!itemsByName.has(drop.item)) badDrops.push(`${name}->${drop.item}`);
  }
}
check('every drop is a registered item', badDrops.length === 0, badDrops.join(', '));

// Categories and caps are known.
const badCat = [...M.MOBS.values()].filter((d) => !M.CATEGORY[d.category]).map((d) => d.name);
check('every mob has a known spawn category', badCat.length === 0, badCat.join(', '));

// Natural spawning produces mobs at night.
world.time = 18000;
const player = { x: 8.5, y: 64, z: 8.5, isPlayer: true, removed: false, dead: false };
world.players.push(player);
let spawned = 0;
for (let i = 0; i < 200 && spawned < 1; i++) spawned += M.trySpawnMobs(world, player);
check('natural spawning produces mobs', spawned > 0, `${spawned} spawned`);

// Caps are respected.
for (let i = 0; i < 400; i++) M.trySpawnMobs(world, player);
const monsters = world.entities.filter((e) => e.category === 'monster').length;
check('the hostile cap is respected', monsters <= M.CATEGORY.monster.cap, `${monsters} monsters`);

// Everything that spawned ticks cleanly in situ.
let tickErr = 0;
for (let i = 0; i < 100; i++) {
  for (const e of [...world.entities]) {
    if (e === player || e.removed) continue;
    try { e.tick(world); } catch { tickErr++; }
  }
}
check('spawned mobs tick cleanly', tickErr === 0, `${tickErr} errors`);

console.log(`\n${pass} passed, ${fail} failed  (${world.entities.length - 1} mobs alive)`);
process.exit(fail ? 1 : 0);
