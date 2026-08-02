// Crafting, smelting, stonecutting, smithing and brewing.
//
// Shaped recipes store their pattern as a compact grid and match anywhere in a
// larger crafting grid, in either mirror. Ingredients may be a single item name
// or a tag (`#planks`), which is how one recipe covers all ten wood types.

import { ItemStack, itemsByName } from './items.js';
import { blocksByName } from '../world/blocks.js';

export const RECIPES = [];
export const SMELTING = new Map();     // input -> {output, xp, time, kinds}
export const STONECUTTING = new Map(); // input -> [{output, count}]
export const SMITHING = [];
export const BREWING = [];
const byResult = new Map();            // item name -> recipe[]

// ---------------------------------------------------------------------------
// Ingredient tags
// ---------------------------------------------------------------------------

export const TAGS = new Map();

/** Define a tag from an explicit list, keeping only items that exist. */
function tag(name, names) {
  TAGS.set(name, names.filter((n) => itemsByName.has(n)));
  return `#${name}`;
}

/** Every item whose name matches a predicate — used for the big families. */
function tagWhere(name, pred) {
  return tag(name, [...itemsByName.keys()].filter(pred));
}

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak',
  'mangrove', 'cherry', 'crimson', 'warped'];
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime',
  'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green',
  'red', 'black'];

/** True when an ingredient spec is satisfied by a stack. */
function matches(spec, stack) {
  if (!spec) return !stack || stack.empty;
  if (!stack || stack.empty) return false;
  if (spec.charCodeAt(0) === 35 /* # */) {
    const list = TAGS.get(spec.slice(1));
    return !!list && list.includes(stack.item.name);
  }
  return stack.item.name === spec;
}

// ---------------------------------------------------------------------------
// Recipe types
// ---------------------------------------------------------------------------

class ShapedRecipe {
  /**
   * @param {string[]} pattern rows of key characters, ' ' for empty
   * @param {Record<string,string>} key character -> ingredient spec
   */
  constructor(pattern, key, result, count = 1, opts = {}) {
    this.type = 'shaped';
    this.height = pattern.length;
    this.width = Math.max(...pattern.map((r) => r.length));
    this.grid = [];
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        const ch = pattern[r][c] ?? ' ';
        this.grid.push(ch === ' ' ? null : key[ch]);
      }
    }
    this.result = result;
    this.count = count;
    this.group = opts.group ?? null;
    this.mirror = opts.mirror !== false;
  }

  /** Try to match at an offset; `flip` mirrors the pattern horizontally. */
  matchAt(grid, gw, gh, ox, oy, flip) {
    for (let r = 0; r < gh; r++) {
      for (let c = 0; c < gw; c++) {
        const pr = r - oy, pc = c - ox;
        let spec = null;
        if (pr >= 0 && pr < this.height && pc >= 0 && pc < this.width) {
          spec = this.grid[pr * this.width + (flip ? this.width - 1 - pc : pc)];
        }
        if (!matches(spec, grid[r * gw + c])) return false;
      }
    }
    return true;
  }

  match(grid, gw, gh) {
    if (this.width > gw || this.height > gh) return false;
    for (let oy = 0; oy <= gh - this.height; oy++) {
      for (let ox = 0; ox <= gw - this.width; ox++) {
        if (this.matchAt(grid, gw, gh, ox, oy, false)) return true;
        if (this.mirror && this.matchAt(grid, gw, gh, ox, oy, true)) return true;
      }
    }
    return false;
  }
}

class ShapelessRecipe {
  constructor(ingredients, result, count = 1) {
    this.type = 'shapeless';
    this.ingredients = ingredients;
    this.result = result;
    this.count = count;
  }

  match(grid, gw, gh) {
    const stacks = grid.filter((s) => s && !s.empty);
    if (stacks.length !== this.ingredients.length) return false;
    const used = new Array(stacks.length).fill(false);
    // Greedy assignment is enough: no vanilla shapeless recipe has two
    // ingredients where the greedy choice can strand a later one.
    for (const spec of this.ingredients) {
      let found = false;
      for (let i = 0; i < stacks.length; i++) {
        if (used[i] || !matches(spec, stacks[i])) continue;
        used[i] = true; found = true; break;
      }
      if (!found) return false;
    }
    return true;
  }
}

function add(recipe) {
  if (!itemsByName.has(recipe.result)) return null;
  RECIPES.push(recipe);
  if (!byResult.has(recipe.result)) byResult.set(recipe.result, []);
  byResult.get(recipe.result).push(recipe);
  return recipe;
}

/** Register a shaped recipe, skipping it if any ingredient does not exist. */
export function shaped(pattern, key, result, count = 1, opts) {
  for (const spec of Object.values(key)) {
    if (!specExists(spec)) return null;
  }
  return add(new ShapedRecipe(pattern, key, result, count, opts));
}

export function shapeless(ingredients, result, count = 1) {
  for (const spec of ingredients) if (!specExists(spec)) return null;
  return add(new ShapelessRecipe(ingredients, result, count));
}

function specExists(spec) {
  if (spec.charCodeAt(0) === 35) {
    const list = TAGS.get(spec.slice(1));
    return !!list && list.length > 0;
  }
  return itemsByName.has(spec);
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Find what `grid` crafts into.
 * @param {(ItemStack|null)[]} grid row-major, length gw*gh
 * @returns {{recipe, result: ItemStack, remainder: (ItemStack|null)[]}|null}
 */
export function findCraftingResult(grid, gw, gh) {
  if (!grid || grid.every((s) => !s || s.empty)) return null;
  for (const r of RECIPES) {
    if (r.match(grid, gw, gh)) {
      return {
        recipe: r,
        result: new ItemStack(r.result, r.count),
        remainder: remainderFor(grid),
      };
    }
  }
  return null;
}

/** Buckets and bottles stay behind when their contents are consumed. */
function remainderFor(grid) {
  let any = false;
  const out = grid.map((s) => {
    if (!s || s.empty) return null;
    const rem = s.item.craftRemainder;
    if (rem && itemsByName.has(rem) && s.count === 1) { any = true; return new ItemStack(rem, 1); }
    return null;
  });
  return any ? out : null;
}

export function findRecipesFor(itemName) { return byResult.get(itemName) ?? []; }
export function allRecipes() { return RECIPES; }

// ---------------------------------------------------------------------------
// Smelting, stonecutting, smithing, brewing
// ---------------------------------------------------------------------------

export function smelt(input, output, xp = 0.1, time = 200, kinds = ['furnace']) {
  if (!itemsByName.has(input) || !itemsByName.has(output)) return;
  SMELTING.set(input, { output, xp, time, kinds });
}

/** @param {'furnace'|'blast_furnace'|'smoker'|'campfire'} kind */
export function smeltingResult(input, kind = 'furnace') {
  const r = SMELTING.get(input);
  if (!r) return null;
  if (!r.kinds.includes(kind)) return null;
  // Blast furnaces and smokers run at double speed on their own inputs.
  const time = kind === 'furnace' || kind === 'campfire' ? r.time : r.time / 2;
  return { output: r.output, xp: r.xp, time };
}

export function stonecut(input, output, count = 1) {
  if (!itemsByName.has(input) || !itemsByName.has(output)) return;
  if (!STONECUTTING.has(input)) STONECUTTING.set(input, []);
  STONECUTTING.get(input).push({ output, count });
}

export function stonecuttingFor(input) { return STONECUTTING.get(input) ?? []; }

/** Furnace fuel value in ticks. */
export function fuelValue(itemName) {
  const item = itemsByName.get(itemName);
  if (!item) return 0;
  if (item.fuelTicks) return item.fuelTicks;
  // Anything wooden burns even if its definition forgot to say so.
  const b = item.block ? blocksByName.get(item.block) : null;
  if (b?.fuelTicks) return b.fuelTicks;
  if (item.block && /_planks$|_log$|_wood$|_slab$|_stairs$|_fence|_door$|_sapling$/.test(item.block)) {
    return item.block.endsWith('_slab') ? 150 : 300;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let registered = false;

export function registerAllRecipes() {
  if (registered) return RECIPES.length;
  registered = true;

  buildTags();
  woodRecipes();
  stoneRecipes();
  toolsAndArmour();
  utilityRecipes();
  redstoneRecipes();
  foodRecipes();
  dyeRecipes();
  transportRecipes();
  compactingRecipes();
  smeltingRecipes();
  stonecuttingRecipes();
  smithingAndBrewing();

  return RECIPES.length;
}

function buildTags() {
  tagWhere('planks', (n) => n.endsWith('_planks'));
  tagWhere('logs', (n) => /_(log|stem|wood|hyphae)$/.test(n));
  tagWhere('wool', (n) => n.endsWith('_wool'));
  tagWhere('stone_crafting', (n) =>
    ['stone', 'cobblestone', 'granite', 'diorite', 'andesite', 'cobbled_deepslate',
      'blackstone', 'tuff'].includes(n));
  tagWhere('coals', (n) => n === 'coal' || n === 'charcoal');
  tagWhere('sand', (n) => n === 'sand' || n === 'red_sand');
  tagWhere('leaves', (n) => n.endsWith('_leaves'));
  tag('wooden_slabs', WOODS.map((w) => `${w}_slab`));
  // Each wood family gets its own tag so planks stay type-consistent.
  for (const w of WOODS) {
    const logs = [`${w}_log`, `${w}_stem`, `${w}_wood`, `${w}_hyphae`,
      `stripped_${w}_log`, `stripped_${w}_stem`, `stripped_${w}_wood`,
      `stripped_${w}_hyphae`];
    tag(`${w}_logs`, logs);
  }
}

// --- wood -------------------------------------------------------------------

function woodRecipes() {
  for (const w of WOODS) {
    const planks = `${w}_planks`;
    if (!itemsByName.has(planks)) continue;
    shapeless([`#${w}_logs`], planks, 4);
    const log = itemsByName.has(`${w}_log`) ? `${w}_log` : `${w}_stem`;
    const wood = itemsByName.has(`${w}_wood`) ? `${w}_wood` : `${w}_hyphae`;
    shaped(['LL', 'LL'], { L: log }, wood, 3);
    if (itemsByName.has(`stripped_${log}`)) {
      shaped(['LL', 'LL'], { L: `stripped_${log}` },
        `stripped_${wood}`, 3);
    }
    plankFamily(w, planks);
  }
  shaped(['P', 'P'], { P: '#planks' }, 'stick', 4);
  shaped(['BB', 'BB'], { B: '#planks' }, 'crafting_table');
}

/** Stairs, slabs, fences, gates, doors, trapdoors, buttons, plates, signs. */
function plankFamily(w, planks) {
  shaped(['  P', ' PP', 'PPP'], { P: planks }, `${w}_stairs`, 4);
  shaped(['PPP'], { P: planks }, `${w}_slab`, 6);
  shaped(['PSP', 'PSP'], { P: planks, S: 'stick' }, `${w}_fence`, 3);
  shaped(['SPS', 'SPS'], { P: planks, S: 'stick' }, `${w}_fence_gate`);
  shaped(['PP', 'PP', 'PP'], { P: planks }, `${w}_door`, 3);
  shaped(['PPP', 'PPP'], { P: planks }, `${w}_trapdoor`, 2);
  shapeless([planks], `${w}_button`);
  shaped(['PP'], { P: planks }, `${w}_pressure_plate`);
  shaped(['PPP', 'PPP', ' S '], { P: planks, S: 'stick' }, `${w}_sign`, 3);
  if (itemsByName.has(`${w}_boat`)) {
    shaped(['P P', 'PPP'], { P: planks }, `${w}_boat`);
  }
  if (itemsByName.has(`${w}_chest_boat`) && itemsByName.has('chest')) {
    shapeless([`${w}_boat`, 'chest'], `${w}_chest_boat`);
  }
}

// --- stone ------------------------------------------------------------------

/** stairs (4), slabs (6), walls (6) from one base block. */
function stoneFamily(base, prefix = base) {
  shaped(['  B', ' BB', 'BBB'], { B: base }, `${prefix}_stairs`, 4);
  shaped(['BBB'], { B: base }, `${prefix}_slab`, 6);
  shaped(['BBB', 'BBB'], { B: base }, `${prefix}_wall`, 6);
}

function stoneRecipes() {
  const families = [
    ['cobblestone'], ['stone'], ['smooth_stone'], ['stone_bricks'],
    ['mossy_cobblestone'], ['mossy_stone_bricks'], ['granite'],
    ['polished_granite'], ['diorite'], ['polished_diorite'], ['andesite'],
    ['polished_andesite'], ['deepslate'], ['cobbled_deepslate'],
    ['polished_deepslate'], ['deepslate_bricks'], ['deepslate_tiles'],
    ['bricks', 'brick'], ['sandstone'], ['smooth_sandstone'], ['cut_sandstone'],
    ['red_sandstone'], ['smooth_red_sandstone'], ['nether_bricks', 'nether_brick'],
    ['red_nether_bricks', 'red_nether_brick'], ['quartz_block', 'quartz'],
    ['smooth_quartz'], ['purpur_block', 'purpur'], ['prismarine'],
    ['prismarine_bricks'], ['dark_prismarine'], ['end_stone_bricks'],
    ['blackstone'], ['polished_blackstone'], ['polished_blackstone_bricks'],
    ['mud_bricks'], ['tuff'], ['calcite'],
  ];
  for (const [base, prefix] of families) {
    if (itemsByName.has(base)) stoneFamily(base, prefix ?? base);
  }

  shaped(['SS', 'SS'], { S: 'stone' }, 'stone_bricks', 4);
  shaped(['SS', 'SS'], { S: 'granite' }, 'polished_granite', 4);
  shaped(['SS', 'SS'], { S: 'diorite' }, 'polished_diorite', 4);
  shaped(['SS', 'SS'], { S: 'andesite' }, 'polished_andesite', 4);
  shaped(['SS', 'SS'], { S: 'cobbled_deepslate' }, 'polished_deepslate', 4);
  shaped(['SS', 'SS'], { S: 'polished_deepslate' }, 'deepslate_bricks', 4);
  shaped(['SS', 'SS'], { S: 'deepslate_bricks' }, 'deepslate_tiles', 4);
  shaped(['SS', 'SS'], { S: 'blackstone' }, 'polished_blackstone', 4);
  shaped(['SS', 'SS'], { S: 'polished_blackstone' }, 'polished_blackstone_bricks', 4);
  shaped(['SS', 'SS'], { S: 'sand' }, 'sandstone');
  shaped(['SS', 'SS'], { S: 'red_sand' }, 'red_sandstone');
  shaped(['SS', 'SS'], { S: 'brick' }, 'bricks');
  shaped(['SS', 'SS'], { S: 'nether_brick' }, 'nether_bricks');
  shaped(['SS', 'SS'], { S: 'quartz' }, 'quartz_block');
  shaped(['SS', 'SS'], { S: 'clay_ball' }, 'clay');
  shaped(['SS', 'SS'], { S: 'packed_mud' }, 'mud_bricks');
  shapeless(['diorite', 'cobblestone'], 'andesite', 2);
  shapeless(['diorite', 'quartz'], 'granite');
  shapeless(['cobblestone', 'quartz'], 'diorite', 2);
  shapeless(['mud', 'wheat'], 'packed_mud');
  shapeless(['cobblestone', 'vine'], 'mossy_cobblestone');
  shapeless(['stone_bricks', 'vine'], 'mossy_stone_bricks');
  shaped(['SS', 'SS'], { S: 'stone_bricks' }, 'chiseled_stone_bricks');
  shaped(['S', 'S'], { S: 'stone_brick_slab' }, 'chiseled_stone_bricks');
  shaped(['S', 'S'], { S: 'quartz_slab' }, 'chiseled_quartz_block');
  shaped(['QQ', 'QQ'], { Q: 'quartz_block' }, 'quartz_pillar', 2);
  shaped(['QQ', 'QQ'], { Q: 'quartz_block' }, 'quartz_bricks');
  shaped(['PP', 'PP'], { P: 'popped_chorus_fruit' }, 'purpur_block', 4);
  shaped(['P', 'P'], { P: 'purpur_slab' }, 'purpur_pillar');
  shaped(['EE', 'EE'], { E: 'end_stone' }, 'end_stone_bricks', 4);
}

// --- tools & armour ---------------------------------------------------------

const TOOL_MATERIALS = [
  ['wooden', '#planks'], ['stone', '#stone_crafting'], ['iron', 'iron_ingot'],
  ['golden', 'gold_ingot'], ['diamond', 'diamond'],
];

const ARMOR_MATERIALS = [
  ['leather', 'leather'], ['iron', 'iron_ingot'], ['golden', 'gold_ingot'],
  ['diamond', 'diamond'], ['chainmail', 'iron_nugget'],
];

function toolsAndArmour() {
  for (const [mat, ing] of TOOL_MATERIALS) {
    shaped(['MMM', ' S ', ' S '], { M: ing, S: 'stick' }, `${mat}_pickaxe`);
    shaped(['MM', 'MS', ' S'], { M: ing, S: 'stick' }, `${mat}_axe`);
    shaped(['M', 'S', 'S'], { M: ing, S: 'stick' }, `${mat}_shovel`);
    shaped(['MM', ' S', ' S'], { M: ing, S: 'stick' }, `${mat}_hoe`);
    shaped(['M', 'M', 'S'], { M: ing, S: 'stick' }, `${mat}_sword`);
  }
  for (const [mat, ing] of ARMOR_MATERIALS) {
    shaped(['MMM', 'M M'], { M: ing }, `${mat}_helmet`);
    shaped(['M M', 'MMM', 'MMM'], { M: ing }, `${mat}_chestplate`);
    shaped(['MMM', 'M M', 'M M'], { M: ing }, `${mat}_leggings`);
    shaped(['M M', 'M M'], { M: ing }, `${mat}_boots`);
  }
  shaped(['I I', ' I '], { I: 'iron_ingot' }, 'shears');
  shaped(['I', 'F'], { I: 'iron_ingot', F: 'flint' }, 'flint_and_steel');
  shaped([' SS', 'S T', ' SS'], { S: 'stick', T: 'string' }, 'bow');
  shaped(['F', 'S', 'P'], { F: 'flint', S: 'stick', P: 'feather' }, 'arrow', 4);
  shaped(['S S', 'STS', ' S '],
    { S: 'stick', T: 'tripwire_hook' }, 'crossbow');
  shaped([' S ', 'SIS', ' S '], { S: 'string', I: 'stick' }, 'fishing_rod');
  shaped(['III', ' I ', ' I '], { I: 'iron_ingot' }, 'bucket');
  shaped(['WIW', 'WWW', ' W '], { W: '#planks', I: 'iron_ingot' }, 'shield');
  shaped(['SS', 'SS', 'SS'], { S: 'string' }, 'white_wool');
}

// --- utility ----------------------------------------------------------------

function utilityRecipes() {
  shaped(['C', 'S'], { C: '#coals', S: 'stick' }, 'torch', 4);
  shaped(['C', 'S'], { C: 'soul_sand', S: 'torch' }, 'soul_torch', 4);
  shaped(['S S', 'SSS', 'S S'], { S: 'stick' }, 'ladder', 3);
  shaped(['SSS', 'S S', 'SSS'], { S: '#stone_crafting' }, 'furnace');
  shaped(['PPP', 'P P', 'PPP'], { P: '#planks' }, 'chest');
  shaped(['PPP', 'PSP', 'PPP'], { P: '#planks', S: '#wooden_slabs' }, 'barrel');
  shaped(['G', 'G', 'G'], { G: 'glass' }, 'glass_pane', 16);
  shaped(['SSS', 'SSS'], { S: 'glass' }, 'glass_pane', 16);
  shaped(['III', 'III'], { I: 'iron_ingot' }, 'iron_bars', 16);
  shaped(['I', 'I'], { I: 'iron_nugget' }, 'chain');
  shaped([' T ', 'TIT', ' T '], { T: 'iron_nugget', I: 'torch' }, 'lantern');
  shaped([' T ', 'TIT', ' T '], { T: 'iron_nugget', I: 'soul_torch' }, 'soul_lantern');
  shaped([' S ', 'SCS', 'LLL'],
    { S: 'stick', C: '#coals', L: '#logs' }, 'campfire');
  shaped(['BBB', 'PPP', 'PPP'], { B: 'book', P: '#planks' }, 'bookshelf');
  shaped(['G', 'P'], { G: 'gunpowder', P: 'paper' }, 'firework_rocket', 3);
  shaped(['PPP'], { P: 'sugar_cane' }, 'paper', 3);
  shapeless(['paper', 'paper', 'paper', 'leather'], 'book');
  shaped(['GGG', 'GGG', 'GGG'], { G: 'glowstone_dust' }, 'glowstone');
  shaped([' G ', 'GGG'], { G: 'glass' }, 'glass_bottle', 3);
  shaped(['B B', 'BBB'], { B: 'iron_ingot' }, 'cauldron');
  shaped(['BBB', ' I ', 'III'], { B: 'iron_block', I: 'iron_ingot' }, 'anvil');
  shaped([' I ', 'IRI', ' I '], { I: 'iron_ingot', R: 'redstone' }, 'compass');
  shaped(['SSS', 'SWS', 'SSS'], { S: 'stick', W: '#wool' }, 'painting');
  shaped(['SSS', 'SLS', 'SSS'], { S: 'stick', L: 'leather' }, 'item_frame');
  shaped(['SSS', 'SIS'], { S: 'bamboo', I: 'string' }, 'scaffolding', 6);
  shaped(['PSP', 'PPP'], { P: '#planks', S: 'flint' }, 'fletching_table');
  shaped([' B ', 'CCC'], { B: 'blaze_rod', C: 'cobblestone' }, 'brewing_stand');
  shaped([' I ', 'IRI', ' I '], { I: 'iron_ingot', R: 'redstone' }, 'compass');
  shaped([' G ', 'GRG', ' G '], { G: 'gold_ingot', R: 'redstone' }, 'clock');
  shaped(['SS', 'SS', 'A '], { S: 'amethyst_shard', A: 'copper_ingot' }, 'spyglass');
  shaped(['SS', 'SS'], { S: 'string' }, 'loom');
  shaped(['GGG', 'ONO', 'OOO'],
    { G: 'glass', N: 'nether_star', O: 'obsidian' }, 'beacon');
  shaped(['WWW', 'PPP'], { W: '#wool', P: '#planks' }, 'white_bed');
  shaped(['SSS', 'S S'], { S: '#planks' }, 'composter');
  shaped(['PPP', ' S ', ' S '], { P: '#planks', S: 'stick' }, 'armor_stand');
  shaped(['NNN', 'NNN', 'NNN'], { N: 'iron_nugget' }, 'iron_ingot');
  shaped(['NNN', 'NNN', 'NNN'], { N: 'gold_nugget' }, 'gold_ingot');
  shaped(['SSS', 'SSS', 'SSS'], { S: 'snowball' }, 'snow_block');
  shaped(['SS', 'SS'], { S: 'snow_block' }, 'snow', 6);
  shaped(['SSS', 'SSS'], { S: 'snow_block' }, 'snow', 6);
  shaped(['BB', 'BB'], { B: 'honeycomb' }, 'honeycomb_block');
}

// --- redstone ---------------------------------------------------------------

function redstoneRecipes() {
  shaped(['R', 'S'], { R: 'redstone', S: 'stick' }, 'redstone_torch');
  shaped(['S', 'C'], { S: 'stick', C: 'cobblestone' }, 'lever');
  shapeless(['stone'], 'stone_button');
  shaped(['SS'], { S: 'stone' }, 'stone_pressure_plate');
  shaped(['SS'], { S: 'iron_ingot' }, 'heavy_weighted_pressure_plate');
  shaped(['SS'], { S: 'gold_ingot' }, 'light_weighted_pressure_plate');
  shaped(['TRT', 'SSS'],
    { T: 'redstone_torch', R: 'redstone', S: 'stone' }, 'repeater');
  shaped([' T ', 'TQT', 'SSS'],
    { T: 'redstone_torch', Q: 'quartz', S: 'stone' }, 'comparator');
  shaped(['CCC', 'RRQ', 'CCC'],
    { C: 'cobblestone', R: 'redstone', Q: 'quartz' }, 'observer');
  shaped(['WWW', 'CIC', 'CRC'],
    { W: '#planks', C: 'cobblestone', I: 'iron_ingot', R: 'redstone' }, 'piston');
  shapeless(['piston', 'slime_ball'], 'sticky_piston');
  shaped(['CCC', 'CBC', 'CRC'],
    { C: 'cobblestone', B: 'bow', R: 'redstone' }, 'dispenser');
  shaped(['CCC', 'C C', 'CRC'],
    { C: 'cobblestone', R: 'redstone' }, 'dropper');
  shaped(['I I', 'ICI', ' I '],
    { I: 'iron_ingot', C: 'chest' }, 'hopper');
  shaped(['RRR', 'RRR', 'RRR'], { R: 'redstone' }, 'redstone_block');
  shaped([' R ', 'RGR', ' R '],
    { R: 'redstone', G: 'glowstone' }, 'redstone_lamp');
  shaped(['SSS', 'SGS', 'SSS'],
    { S: '#planks', G: 'redstone' }, 'note_block');
  shaped(['SSS', 'SDS', 'SSS'],
    { S: '#planks', D: 'diamond' }, 'jukebox');
  shaped(['GGG', 'QQQ', 'WWW'],
    { G: 'glass', Q: 'quartz', W: '#wooden_slabs' }, 'daylight_detector');
  shaped([' R ', 'RHR', ' R '],
    { R: 'redstone', H: 'hay_block' }, 'target');
  shaped(['C', 'C', 'C'], { C: 'copper_ingot' }, 'lightning_rod');
  shaped(['GGG', 'GSG', 'GGG'],
    { G: 'gunpowder', S: 'sand' }, 'tnt');
  shaped(['I I', 'ISI', 'IRI'],
    { I: 'iron_ingot', S: 'stick', R: 'redstone' }, 'rail', 16);
  shaped(['G G', 'GSG', 'GRG'],
    { G: 'gold_ingot', S: 'stick', R: 'redstone' }, 'powered_rail', 6);
  shaped(['I I', 'ISI', 'IRI'],
    { I: 'iron_ingot', S: 'stone_pressure_plate', R: 'redstone' }, 'detector_rail', 6);
  shaped(['I I', 'ISI', 'ISI'],
    { I: 'iron_ingot', S: 'redstone_torch' }, 'activator_rail', 6);
  shaped(['SIS'], { S: 'stick', I: 'iron_ingot' }, 'tripwire_hook', 2);
}

// --- food -------------------------------------------------------------------

function foodRecipes() {
  shaped(['WWW'], { W: 'wheat' }, 'bread');
  shaped(['WWW', 'WWW', 'WWW'], { W: 'wheat' }, 'hay_block');
  shapeless(['wheat', 'wheat', 'cocoa_beans'], 'cookie', 8);
  shaped(['MMM', 'SES', 'WWW'],
    { M: 'milk_bucket', S: 'sugar', E: 'egg', W: 'wheat' }, 'cake');
  shapeless(['pumpkin', 'sugar', 'egg'], 'pumpkin_pie');
  shapeless(['baked_potato', 'cooked_rabbit', 'carrot', 'brown_mushroom', 'bowl'],
    'rabbit_stew');
  shapeless(['red_mushroom', 'brown_mushroom', 'bowl'], 'mushroom_stew');
  shapeless(['beetroot', 'beetroot', 'beetroot', 'beetroot', 'beetroot',
    'beetroot', 'bowl'], 'beetroot_soup');
  shaped(['GGG', 'GAG', 'GGG'],
    { G: 'gold_ingot', A: 'apple' }, 'golden_apple');
  shaped(['GGG', 'GCG', 'GGG'],
    { G: 'gold_nugget', C: 'carrot' }, 'golden_carrot');
  shaped(['GGG', 'GMG', 'GGG'],
    { G: 'gold_nugget', M: 'melon_slice' }, 'glistering_melon_slice');
  shaped(['P P', ' P '], { P: '#planks' }, 'bowl', 4);
  shaped(['MMM', 'MMM', 'MMM'], { M: 'melon_slice' }, 'melon');
  shaped(['M'], { M: 'melon' }, 'melon_seeds');
  shaped(['P'], { P: 'pumpkin' }, 'pumpkin_seeds', 4);
  shaped(['B'], { B: 'beetroot' }, 'beetroot_seeds');
  shapeless(['sugar_cane'], 'sugar');
  shapeless(['bone'], 'bone_meal', 3);
  shapeless(['bone_block'], 'bone_meal', 9);
  shaped(['DDD', 'DDD', 'DDD'], { D: 'dried_kelp' }, 'dried_kelp_block');
  shapeless(['carved_pumpkin', 'torch'], 'jack_o_lantern');
  shapeless(['pumpkin', 'shears'], 'carved_pumpkin');
}

// --- dyes & colour ----------------------------------------------------------

const DYE_SOURCES = {
  white: ['bone_meal', 'lily_of_the_valley'],
  orange: ['orange_tulip'],
  magenta: ['allium', 'lilac'],
  light_blue: ['blue_orchid'],
  yellow: ['dandelion', 'sunflower'],
  lime: [],
  pink: ['pink_tulip', 'peony'],
  gray: [],
  light_gray: ['azure_bluet', 'oxeye_daisy', 'white_tulip'],
  cyan: [],
  purple: [],
  blue: ['cornflower', 'lapis_lazuli'],
  brown: ['cocoa_beans'],
  green: [],
  red: ['poppy', 'rose_bush', 'red_tulip', 'beetroot'],
  black: ['ink_sac', 'wither_rose'],
};

const DYE_MIXES = [
  ['lime', 'green', 'white'], ['gray', 'black', 'white'],
  ['light_gray', 'gray', 'white'], ['cyan', 'blue', 'green'],
  ['purple', 'blue', 'red'], ['magenta', 'purple', 'pink'],
  ['pink', 'red', 'white'], ['orange', 'red', 'yellow'],
  ['light_blue', 'blue', 'white'],
];

function dyeRecipes() {
  for (const [color, sources] of Object.entries(DYE_SOURCES)) {
    for (const src of sources) {
      // Tall flowers give two dye; everything else gives one.
      const two = ['sunflower', 'lilac', 'peony', 'rose_bush'].includes(src);
      shapeless([src], `${color}_dye`, two ? 2 : 1);
    }
  }
  for (const [out, a, b] of DYE_MIXES) shapeless([`${a}_dye`, `${b}_dye`], `${out}_dye`, 2);

  for (const c of COLORS) {
    const dye = `${c}_dye`;
    shapeless(['#wool', dye], `${c}_wool`);
    shaped(['WW'], { W: `${c}_wool` }, `${c}_carpet`, 3);
    shaped(['GGG', 'GDG', 'GGG'], { G: 'glass', D: dye }, `${c}_stained_glass`, 8);
    shaped(['GGG', 'GGG'], { G: `${c}_stained_glass` }, `${c}_stained_glass_pane`, 16);
    shaped(['TTT', 'TDT', 'TTT'], { T: 'terracotta', D: dye }, `${c}_terracotta`, 8);
    shaped(['SSS', 'SDS', 'SSS'],
      { S: 'sand', D: dye }, `${c}_concrete_powder`, 8);
    shapeless(['#wool', 'stick', dye], `${c}_banner`);
    shapeless([`${c}_dye`, 'white_bed'], `${c}_bed`);
    shapeless([dye, 'candle'], `${c}_candle`);
  }
  shapeless(['honeycomb', 'string'], 'candle');
}

// --- transport --------------------------------------------------------------

function transportRecipes() {
  shaped(['I I', 'III'], { I: 'iron_ingot' }, 'minecart');
  shapeless(['minecart', 'chest'], 'chest_minecart');
  shapeless(['minecart', 'furnace'], 'furnace_minecart');
  shapeless(['minecart', 'hopper'], 'hopper_minecart');
  shapeless(['minecart', 'tnt'], 'tnt_minecart');
  shaped(['CS', 'S '], { C: 'carrot', S: 'fishing_rod' }, 'carrot_on_a_stick');
  shapeless(['fishing_rod', 'warped_fungus'], 'warped_fungus_on_a_stick');
}

// --- 9<->1 compacting -------------------------------------------------------

const COMPACT = [
  ['coal', 'coal_block'], ['iron_ingot', 'iron_block'], ['gold_ingot', 'gold_block'],
  ['diamond', 'diamond_block'], ['emerald', 'emerald_block'],
  ['redstone', 'redstone_block'], ['lapis_lazuli', 'lapis_block'],
  ['netherite_ingot', 'netherite_block'], ['copper_ingot', 'copper_block'],
  ['raw_iron', 'raw_iron_block'], ['raw_copper', 'raw_copper_block'],
  ['raw_gold', 'raw_gold_block'], ['amethyst_shard', 'amethyst_block'],
  ['slime_ball', 'slime_block'], ['wheat', 'hay_block'],
  ['bone_meal', 'bone_block'], ['snowball', 'snow_block'],
];

function compactingRecipes() {
  for (const [item, block] of COMPACT) {
    shaped(['III', 'III', 'III'], { I: item }, block);
    shapeless([block], item, 9);
  }
  shapeless(['iron_ingot'], 'iron_nugget', 9);
  shapeless(['gold_ingot'], 'gold_nugget', 9);
  shaped(['HH', 'HH'], { H: 'honey_bottle' }, 'honey_block');
  shapeless(['honey_block'], 'honey_bottle', 4);
}

// --- smelting ---------------------------------------------------------------

function smeltingRecipes() {
  const ORE = ['furnace', 'blast_furnace'];
  const FOOD = ['furnace', 'smoker', 'campfire'];
  const pairs = [
    ['iron_ore', 'iron_ingot', 0.7], ['deepslate_iron_ore', 'iron_ingot', 0.7],
    ['raw_iron', 'iron_ingot', 0.7],
    ['gold_ore', 'gold_ingot', 1.0], ['deepslate_gold_ore', 'gold_ingot', 1.0],
    ['nether_gold_ore', 'gold_ingot', 1.0], ['raw_gold', 'gold_ingot', 1.0],
    ['copper_ore', 'copper_ingot', 0.7], ['deepslate_copper_ore', 'copper_ingot', 0.7],
    ['raw_copper', 'copper_ingot', 0.7],
    ['coal_ore', 'coal', 0.1], ['deepslate_coal_ore', 'coal', 0.1],
    ['diamond_ore', 'diamond', 1.0], ['deepslate_diamond_ore', 'diamond', 1.0],
    ['emerald_ore', 'emerald', 1.0], ['deepslate_emerald_ore', 'emerald', 1.0],
    ['lapis_ore', 'lapis_lazuli', 0.2], ['deepslate_lapis_ore', 'lapis_lazuli', 0.2],
    ['redstone_ore', 'redstone', 0.7], ['deepslate_redstone_ore', 'redstone', 0.7],
    ['nether_quartz_ore', 'quartz', 0.2],
    ['ancient_debris', 'netherite_scrap', 2.0],
  ];
  for (const [a, b, xp] of pairs) smelt(a, b, xp, 200, ORE);

  for (const [a, b] of [
    ['beef', 'cooked_beef'], ['porkchop', 'cooked_porkchop'],
    ['chicken', 'cooked_chicken'], ['mutton', 'cooked_mutton'],
    ['rabbit', 'cooked_rabbit'], ['cod', 'cooked_cod'], ['salmon', 'cooked_salmon'],
    ['potato', 'baked_potato'], ['kelp', 'dried_kelp'],
  ]) smelt(a, b, 0.35, 200, FOOD);

  const MISC = [
    ['cobblestone', 'stone', 0.1], ['stone', 'smooth_stone', 0.1],
    ['sand', 'glass', 0.1], ['red_sand', 'glass', 0.1],
    ['clay_ball', 'brick', 0.3], ['clay', 'terracotta', 0.35],
    ['netherrack', 'nether_brick', 0.1], ['cactus', 'green_dye', 0.2],
    ['sandstone', 'smooth_sandstone', 0.1],
    ['red_sandstone', 'smooth_red_sandstone', 0.1],
    ['quartz_block', 'smooth_quartz', 0.1], ['stone_bricks', 'cracked_stone_bricks', 0.1],
    ['deepslate_bricks', 'cracked_deepslate_bricks', 0.1],
    ['nether_bricks', 'cracked_nether_bricks', 0.1],
    ['basalt', 'smooth_basalt', 0.1], ['cobbled_deepslate', 'deepslate', 0.1],
    ['wet_sponge', 'sponge', 0.15], ['sea_pickle', 'lime_dye', 0.1],
    ['chorus_fruit', 'popped_chorus_fruit', 0.1],
    ['ancient_debris', 'netherite_scrap', 2.0],
  ];
  for (const [a, b, xp] of MISC) smelt(a, b, xp, 200);

  // Every log smelts to charcoal.
  for (const n of TAGS.get('logs') ?? []) smelt(n, 'charcoal', 0.15, 200);
}

// --- stonecutting -----------------------------------------------------------

function stonecuttingRecipes() {
  const families = [
    ['stone', ['stone_stairs', 'stone_slab', 'stone_bricks', 'smooth_stone']],
    ['cobblestone', ['cobblestone_stairs', 'cobblestone_slab', 'cobblestone_wall']],
    ['stone_bricks', ['stone_brick_stairs', 'stone_brick_slab', 'stone_brick_wall',
      'chiseled_stone_bricks']],
    ['sandstone', ['sandstone_stairs', 'sandstone_slab', 'sandstone_wall',
      'cut_sandstone', 'chiseled_sandstone']],
    ['red_sandstone', ['red_sandstone_stairs', 'red_sandstone_slab',
      'red_sandstone_wall', 'cut_red_sandstone', 'chiseled_red_sandstone']],
    ['deepslate', ['polished_deepslate', 'deepslate_bricks', 'deepslate_tiles']],
    ['blackstone', ['polished_blackstone', 'blackstone_stairs', 'blackstone_slab',
      'blackstone_wall']],
    ['quartz_block', ['quartz_stairs', 'quartz_slab', 'quartz_pillar',
      'quartz_bricks', 'chiseled_quartz_block']],
    ['bricks', ['brick_stairs', 'brick_slab', 'brick_wall']],
    ['nether_bricks', ['nether_brick_stairs', 'nether_brick_slab',
      'nether_brick_wall', 'chiseled_nether_bricks']],
    ['purpur_block', ['purpur_stairs', 'purpur_slab', 'purpur_pillar']],
    ['end_stone_bricks', ['end_stone_brick_stairs', 'end_stone_brick_slab',
      'end_stone_brick_wall']],
    ['prismarine', ['prismarine_stairs', 'prismarine_slab', 'prismarine_wall']],
    ['copper_block', ['cut_copper', 'cut_copper_stairs', 'cut_copper_slab']],
  ];
  for (const [base, outs] of families) {
    for (const o of outs) stonecut(base, o, o.endsWith('_slab') ? 2 : 1);
  }
}

// --- smithing & brewing -----------------------------------------------------

function smithingAndBrewing() {
  for (const kind of ['sword', 'pickaxe', 'axe', 'shovel', 'hoe',
    'helmet', 'chestplate', 'leggings', 'boots']) {
    const from = `diamond_${kind}`, to = `netherite_${kind}`;
    if (itemsByName.has(from) && itemsByName.has(to)) {
      SMITHING.push({ base: from, addition: 'netherite_ingot', result: to,
        template: 'netherite_upgrade_smithing_template' });
    }
  }
  shapeless(['netherite_scrap', 'netherite_scrap', 'netherite_scrap',
    'netherite_scrap', 'gold_ingot', 'gold_ingot', 'gold_ingot', 'gold_ingot'],
  'netherite_ingot');

  // potion type -> {from, ingredient}
  const potions = [
    ['awkward', 'water', 'nether_wart'],
    ['night_vision', 'awkward', 'golden_carrot'],
    ['invisibility', 'night_vision', 'fermented_spider_eye'],
    ['leaping', 'awkward', 'rabbit_foot'],
    ['fire_resistance', 'awkward', 'magma_cream'],
    ['swiftness', 'awkward', 'sugar'],
    ['slowness', 'swiftness', 'fermented_spider_eye'],
    ['water_breathing', 'awkward', 'pufferfish'],
    ['healing', 'awkward', 'glistering_melon_slice'],
    ['harming', 'healing', 'fermented_spider_eye'],
    ['poison', 'awkward', 'spider_eye'],
    ['regeneration', 'awkward', 'ghast_tear'],
    ['strength', 'awkward', 'blaze_powder'],
    ['weakness', 'water', 'fermented_spider_eye'],
    ['slow_falling', 'awkward', 'phantom_membrane'],
    ['turtle_master', 'awkward', 'turtle_helmet'],
  ];
  for (const [result, from, ingredient] of potions) {
    BREWING.push({ result, from, ingredient });
  }
  // Modifiers
  BREWING.push({ modifier: 'redstone', effect: 'extend' });
  BREWING.push({ modifier: 'glowstone_dust', effect: 'amplify' });
  BREWING.push({ modifier: 'gunpowder', effect: 'splash' });
  BREWING.push({ modifier: 'dragon_breath', effect: 'lingering' });
}

/** The brewing step for a base potion plus an ingredient, or null. */
export function brewingResult(basePotion, ingredient) {
  for (const b of BREWING) {
    if (b.result && b.from === basePotion && b.ingredient === ingredient) return b;
  }
  return null;
}

/** The smithing upgrade for a base item plus an addition, or null. */
export function smithingResult(base, addition) {
  return SMITHING.find((s) => s.base === base && s.addition === addition) ?? null;
}
