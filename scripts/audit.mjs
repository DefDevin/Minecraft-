// Content audit: loads every registry that exists and reports consistency
// problems the browser would only surface as visual glitches.
import { blocks, blocksByName, T, freezeBlocks, RENDER, PASS } from '../src/world/blocks.js';
import { statesUsed } from '../src/world/blockstate.js';

const problems = [];
const note = (sev, msg) => problems.push({ sev, msg });

const mod = async (p) => { try { return await import(p); } catch (e) { return { __err: e }; } };

const blockdefs = await mod('../src/world/blockdefs.js');
if (blockdefs.__err) { console.error('blockdefs failed to load:', blockdefs.__err.message); process.exit(1); }
blockdefs.registerAllBlocks();
console.log(`blocks: ${blocks.length}   states: ${statesUsed()}`);

// --- texture references -----------------------------------------------------
const texgen = await mod('../src/render/texgen.js');
const blockTex = await mod('../src/render/textures/blocks.js');
if (!blockTex.__err) {
  try { blockTex.registerBlockTextures?.(); }
  catch (e) { note('ERROR', `block textures threw during registration: ${e.message}`); }
}
const itemTex = await mod('../src/render/textures/items.js');

const referenced = new Set();
for (const b of blocks) {
  for (let i = 0; i < b.stateCount; i++) {
    const m = b.modelFor(b.base + i);
    if (!m) continue;
    for (const bx of m) for (const f of bx.faces) if (f?.texture) referenced.add(f.texture);
    if (b.stateCount > 24 && i > 24) break;
  }
  const spec = typeof b.textures === 'function'
    ? (() => { try { return b.textures(b.defaultState); } catch { return null; } })()
    : b.textures;
  if (typeof spec === 'string') referenced.add(spec);
  else if (Array.isArray(spec)) for (const t of spec) if (typeof t === 'string') referenced.add(t);
  else if (spec) for (const t of Object.values(spec)) if (typeof t === 'string') referenced.add(t);
}
console.log(`textures referenced by block models: ${referenced.size}`);
if (!texgen.__err && !blockTex.__err) {
  const missing = [...referenced].filter((t) => !texgen.hasTexture(t));
  if (missing.length) note('WARN', `${missing.length} block textures have no painter: ${missing.slice(0, 15).join(', ')}${missing.length > 15 ? ' …' : ''}`);
  else console.log('all block textures have painters');
}

// --- items ------------------------------------------------------------------
const items = await mod('../src/game/items.js');
const itemdefs = await mod('../src/game/itemdefs.js');
if (!itemdefs.__err) {
  try { itemdefs.registerAllItems?.(); }
  catch (e) { note('ERROR', `itemdefs threw during registration: ${e.message}`); }
  console.log(`items: ${items.itemsByName.size}`);
  const noItem = blocks.filter((b) => b.item && !items.itemsByName.has(b.item))
    .map((b) => b.name);
  if (noItem.length) note('WARN', `${noItem.length} blocks drop an item that is not registered: ${noItem.slice(0, 12).join(', ')}`);
} else {
  note('INFO', 'itemdefs.js not present yet');
}

// --- recipes ----------------------------------------------------------------
const recipes = await mod('../src/game/recipes.js');
if (!recipes.__err) {
  try { recipes.registerAllRecipes?.(); }
  catch (e) { note('ERROR', `recipes threw during registration: ${e.message}`); }
  const all = recipes.allRecipes?.() ?? recipes.RECIPES ?? [];
  console.log(`recipes: ${Array.isArray(all) ? all.length : 'unknown count'}`);
} else {
  note('INFO', 'recipes.js not present yet');
}

// --- engine-level consistency ----------------------------------------------
freezeBlocks();
let cubeButNotFull = 0, opaqueButTransparentPass = 0, noModel = 0, badTool = 0;
const TOOLS = new Set(['none', 'pickaxe', 'axe', 'shovel', 'hoe', 'shears', 'sword']);
for (const b of blocks) {
  const s = b.defaultState;
  if (b.render === RENDER.CUBE && !T.fullCube[s] && b.name !== 'air') cubeButNotFull++;
  if (b.opaque && b.pass !== PASS.SOLID) opaqueButTransparentPass++;
  // CROSS and FLUID geometry is built by the mesher, so those legitimately
  // have no box model — they only need a texture spec.
  if (b.render !== RENDER.INVISIBLE && !b.modelFor(s) &&
      b.render !== RENDER.CROSS && b.render !== RENDER.FLUID) noModel++;
  if ((b.render === RENDER.CROSS || b.render === RENDER.FLUID) && !b.textures) {
    note('ERROR', `${b.name} is a ${b.render === RENDER.CROSS ? 'cross' : 'fluid'} block with no texture spec`);
  }
  if (!TOOLS.has(b.tool)) badTool++;
}
if (cubeButNotFull) note('WARN', `${cubeButNotFull} blocks declare RENDER.CUBE but their model is not a full cube`);
if (opaqueButTransparentPass) note('WARN', `${opaqueButTransparentPass} blocks are opaque but render in a blended pass`);
if (noModel) note('ERROR', `${noModel} visible blocks have no model`);
if (badTool) note('ERROR', `${badTool} blocks name an unknown tool`);

// Light/opacity sanity: an opaque block must fully filter skylight.
let lightBad = 0;
for (const b of blocks) {
  if (b.opaque && b.lightFilter < 15 && !b.fluid) lightBad++;
}
if (lightBad) note('WARN', `${lightBad} opaque blocks let skylight through (lightFilter < 15)`);

// --- worldgen ---------------------------------------------------------------
const biomes = await mod('../src/world/biomes.js');
if (!biomes.__err) {
  const list = biomes.BIOMES ?? [];
  console.log(`biomes: ${list.length}`);
  const missingColor = list.filter((b) => b.grassColor == null).map((b) => b.name);
  if (missingColor.length) note('WARN', `${missingColor.length} biomes have no grassColor`);
} else note('INFO', 'biomes.js not present yet');

const gen = await mod('../src/world/generator.js');
if (!gen.__err) {
  console.log(`generators: ${['OverworldGenerator','NetherGenerator','EndGenerator'].filter((k) => gen[k]).join(', ')}`);
} else note('INFO', 'generator.js not present yet');

// --- report -----------------------------------------------------------------
console.log('');
const bySev = { ERROR: [], WARN: [], INFO: [] };
for (const p of problems) bySev[p.sev].push(p.msg);
for (const sev of ['ERROR', 'WARN', 'INFO']) {
  for (const m of bySev[sev]) console.log(`${sev}: ${m}`);
}
if (!problems.length) console.log('no problems found');
process.exit(bySev.ERROR.length ? 1 : 0);
