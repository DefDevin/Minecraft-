// Recipe registry checks: everything resolves, and known recipes actually craft.
import { blocksByName } from '../src/world/blocks.js';
import { ItemStack, itemsByName } from '../src/game/items.js';
const bd = await import('../src/world/blockdefs.js'); bd.registerAllBlocks();
const idf = await import('../src/game/itemdefs.js'); idf.registerAllItems();
const R = await import('../src/game/recipes.js');
R.registerAllRecipes();

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  pass  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
};

console.log(`recipes: ${R.RECIPES.length}   smelting: ${R.SMELTING.size}   ` +
  `stonecutting: ${R.STONECUTTING.size}   smithing: ${R.SMITHING.length}   ` +
  `brewing: ${R.BREWING.length}\n`);

// Every ingredient and result resolves.
let badResult = 0, badIngredient = 0;
for (const r of R.RECIPES) {
  if (!itemsByName.has(r.result)) badResult++;
  const specs = r.type === 'shaped' ? r.grid.filter(Boolean) : r.ingredients;
  for (const s of specs) {
    if (s.startsWith('#')) { if (!(R.TAGS.get(s.slice(1)) || []).length) badIngredient++; }
    else if (!itemsByName.has(s)) badIngredient++;
  }
}
check('every recipe result is a registered item', badResult === 0, `${badResult} bad`);
check('every ingredient resolves', badIngredient === 0, `${badIngredient} bad`);

const grid = (w, h, cells) => {
  const g = new Array(w * h).fill(null);
  for (const [i, name] of Object.entries(cells)) g[+i] = new ItemStack(name, 1);
  return g;
};
const craft = (w, h, cells) => R.findCraftingResult(grid(w, h, cells), w, h);

// 2x2: two planks stacked vertically make sticks.
let r = craft(2, 2, { 0: 'oak_planks', 2: 'oak_planks' });
check('2 planks -> 4 sticks', r?.result.name === 'stick' && r.result.count === 4,
  r ? `${r.result.count}x ${r.result.name}` : 'no match');

// 2x2: four planks make a crafting table.
r = craft(2, 2, { 0: 'oak_planks', 1: 'oak_planks', 2: 'oak_planks', 3: 'oak_planks' });
check('4 planks -> crafting table', r?.result.name === 'crafting_table',
  r ? r.result.name : 'no match');

// Shaped recipe placed in the top-left of a 3x3.
r = craft(3, 3, { 0: 'oak_planks', 1: 'oak_planks', 2: 'oak_planks',
  4: 'stick', 7: 'stick' });
check('wooden pickaxe, top-left of a 3x3', r?.result.name === 'wooden_pickaxe',
  r ? r.result.name : 'no match');

// The same recipe must not match when shifted off its anchor.
r = craft(3, 3, { 0: 'oak_planks', 1: 'oak_planks', 2: 'oak_planks', 4: 'stick' });
check('an incomplete pickaxe does not craft', r === null, r ? r.result.name : 'ok');

// Tag ingredients: any wood works.
r = craft(2, 2, { 0: 'spruce_planks', 2: 'spruce_planks' });
check('tags accept any wood type', r?.result.name === 'stick', r ? r.result.name : 'no match');

// Shapeless with a specific count.
r = craft(2, 2, { 0: 'oak_log' });
check('1 log -> 4 planks', r?.result.name === 'oak_planks' && r.result.count === 4,
  r ? `${r.result.count}x ${r.result.name}` : 'no match');

// Torches.
r = craft(2, 2, { 0: 'coal', 2: 'stick' });
check('coal over stick -> 4 torches', r?.result.name === 'torch' && r.result.count === 4,
  r ? `${r.result.count}x ${r.result.name}` : 'no match');

// Furnace: 8 cobblestone round the edge of a 3x3.
r = craft(3, 3, { 0: 'cobblestone', 1: 'cobblestone', 2: 'cobblestone',
  3: 'cobblestone', 5: 'cobblestone', 6: 'cobblestone', 7: 'cobblestone', 8: 'cobblestone' });
check('8 cobblestone -> furnace', r?.result.name === 'furnace', r ? r.result.name : 'no match');

// Smelting.
check('iron ore smelts to an ingot',
  R.smeltingResult('iron_ore', 'furnace')?.output === 'iron_ingot');
check('a blast furnace is twice as fast on ore',
  R.smeltingResult('iron_ore', 'blast_furnace')?.time === 100);
check('a blast furnace refuses food', R.smeltingResult('beef', 'blast_furnace') === null);
check('a smoker cooks food', R.smeltingResult('beef', 'smoker')?.output === 'cooked_beef');
check('logs smelt to charcoal', R.smeltingResult('oak_log')?.output === 'charcoal');

// Fuel.
check('coal burns for 1600 ticks', R.fuelValue('coal') === 1600, String(R.fuelValue('coal')));
check('planks are fuel', R.fuelValue('oak_planks') > 0, String(R.fuelValue('oak_planks')));
check('stone is not fuel', R.fuelValue('stone') === 0);

// Compacting round-trip.
r = craft(3, 3, Object.fromEntries([...Array(9).keys()].map((i) => [i, 'iron_ingot'])));
check('9 ingots -> iron block', r?.result.name === 'iron_block', r ? r.result.name : 'no match');
r = craft(2, 2, { 0: 'iron_block' });
check('iron block -> 9 ingots', r?.result.name === 'iron_ingot' && r.result.count === 9,
  r ? `${r.result.count}x ${r.result.name}` : 'no match');

// Dyes and smithing.
r = craft(2, 2, { 0: 'blue_dye', 1: 'white_dye' });
check('blue + white -> light blue dye', r?.result.name === 'light_blue_dye',
  r ? r.result.name : 'no match');
check('netherite upgrade exists',
  !!R.smithingResult('diamond_pickaxe', 'netherite_ingot'));
check('brewing awkward -> healing',
  !!R.brewingResult('awkward', 'glistering_melon_slice'));

// Coverage of the big families.
const covered = (n) => R.findRecipesFor(n).length > 0;
const families = ['oak_stairs', 'oak_slab', 'oak_fence', 'oak_door', 'oak_trapdoor',
  'oak_button', 'oak_pressure_plate', 'stone_stairs', 'stone_slab',
  'cobblestone_wall', 'diamond_sword', 'iron_chestplate', 'golden_boots',
  'bread', 'cake', 'torch', 'ladder', 'chest', 'hopper', 'piston', 'repeater',
  'comparator', 'minecart', 'oak_boat', 'red_wool', 'lime_dye', 'bookshelf',
  'anvil', 'tnt', 'rail', 'glass_pane', 'iron_bars', 'lantern'];
const missing = families.filter((f) => itemsByName.has(f) && !covered(f));
check('every headline family has a recipe', missing.length === 0,
  missing.join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
