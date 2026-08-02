#!/usr/bin/env node
// Smoke test for the block registry.
//
// Registers every block, then reports the totals and a few invariants that the
// rest of the engine assumes: air is state 0, no state id escapes the 16-bit
// range, every block resolves a model and a collision shape for every one of
// its states, and no two blocks claim the same name.
//
// Run: node scripts/check-blocks.mjs [--verbose]

import {
  registerAllBlocks, BLOCK_NAMES, blocks, blockCount, stateCount,
  blockTextureNames, CREATIVE_TABS, FLAMMABLE, POTTED, STRIPPED, WEATHERING,
} from '../src/world/blockdefs.js';
import { MAX_STATES, stateToBlock } from '../src/world/blockstate.js';
import { T, blocksByName } from '../src/world/blocks.js';

const verbose = process.argv.includes('--verbose');
const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };

registerAllBlocks();

// --- invariants -------------------------------------------------------------

check(stateToBlock[0] && stateToBlock[0].name === 'air',
  `state 0 must be air, got ${stateToBlock[0] && stateToBlock[0].name}`);
check(blocksByName.get('air').defaultState === 0, 'air default state must be 0');
check(stateCount() <= MAX_STATES,
  `state space overflow: ${stateCount()} > ${MAX_STATES}`);
check(BLOCK_NAMES.length === blockCount(), 'BLOCK_NAMES length mismatch');
check(new Set(BLOCK_NAMES).size === BLOCK_NAMES.length, 'duplicate block name');

let statesVisited = 0;
for (const b of blocks) {
  check(/^[a-z0-9_]+$/.test(b.name), `bad block id: ${b.name}`);
  check(b.stateCount >= 1, `${b.name} has no states`);
  for (let i = 0; i < b.stateCount; i++) {
    const s = b.base + i;
    statesVisited++;
    check(stateToBlock[s] === b, `${b.name} state ${i} maps to the wrong block`);
    const model = b.modelFor(s);
    check(model === null || Array.isArray(model), `${b.name} model is not an array`);
    const col = b.collisionFor(s);
    check(Array.isArray(col), `${b.name} collision is not an array`);
    const sel = b.selectionFor(s);
    check(Array.isArray(sel), `${b.name} selection is not an array`);
  }
  if (b.container) {
    check(typeof b.container.slots === 'number' && typeof b.container.type === 'string',
      `${b.name} has a malformed container descriptor`);
    check(b.hasEntity, `${b.name} is a container but has no block entity`);
  }
  if (b.hardness < 0) check(b.name !== 'stone', 'sanity check failed');
}
check(statesVisited === stateCount(),
  `visited ${statesVisited} states but ${stateCount()} are allocated`);

// Tables must be filled for the whole state range.
check(T.opaque.length === stateCount(), 'T.opaque has the wrong length');
check(T.light[blocksByName.get('glowstone').defaultState] === 15,
  'glowstone should emit light 15');
check(T.fluid[blocksByName.get('water').defaultState] === 1, 'water must be fluid 1');
check(T.replaceable[0] === 1, 'air must be replaceable');

// --- report -----------------------------------------------------------------

const textures = blockTextureNames();
const withEntity = blocks.filter((b) => b.hasEntity).length;
const containers = blocks.filter((b) => b.container).length;
const randomTicked = blocks.filter((b) => b.randomTick).length;
const emitters = blocks.filter((b) => b.lightEmission > 0).length;

console.log(`blocks:        ${blockCount()}`);
console.log(`states:        ${stateCount()} / ${MAX_STATES} ` +
  `(${((stateCount() / MAX_STATES) * 100).toFixed(1)}% of the id space)`);
console.log(`textures:      ${textures.length} distinct names referenced`);
console.log(`block entities:${String(withEntity).padStart(4)}  containers: ${containers}`);
console.log(`random-ticked: ${String(randomTicked).padStart(4)}  light emitters: ${emitters}`);
console.log(`flammable:     ${Object.keys(FLAMMABLE).length}  potted: ${Object.keys(POTTED).length}` +
  `  strippable: ${Object.keys(STRIPPED).length}  weathering: ${Object.keys(WEATHERING).length}`);
console.log('creative tabs: ' + Object.entries(CREATIVE_TABS)
  .map(([k, v]) => `${k}=${v.length}`).join(' '));

if (verbose) {
  const widest = blocks.slice().sort((a, b) => b.stateCount - a.stateCount).slice(0, 12);
  console.log('\nwidest state spaces:');
  for (const b of widest) console.log(`  ${b.stateCount.toString().padStart(5)}  ${b.name}`);
  console.log('\ntextures:\n  ' + textures.join('\n  '));
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nOK');
