// The canonical item registry.
//
// `registerAllItems()` runs once, after `registerAllBlocks()`, and fills
// `itemsByName` with three kinds of entry:
//
//   1. block items — one per placeable block, produced by `defineBlockItem`,
//      which copies the block's stack size, fuel value and creative tab;
//   2. materials, food, dyes and the rest of the "flat icon" items;
//   3. equipment — tools and armour generated from the `MATERIALS` and
//      `ARMOR_MATERIALS` tables in items.js so the stats stay in one place.
//
// Numbers here are Minecraft's real ones: durability, mining speed, attack
// damage and speed, hunger and saturation, furnace burn times. Anything that
// needs a system we have not built (potion effects, enchantment tables, mob
// spawning) is recorded as data on the item and left for that system to read.

import { blocks, TOOL, TIER } from '../world/blocks.js';
import {
  items, itemsByName, defineItem, defineBlockItem,
  MATERIALS, ARMOR_MATERIALS, SLOT, RARITY,
} from './items.js';
import { COLORS, COLOR_HEX, WOOD_TYPES } from '../world/blockdefs/data.js';

let registered = false;

/**
 * Blocks that exist only as machinery and must never have an item form.
 * Most technical blocks already declare a different `item` (a wall torch drops
 * a torch, a potted plant drops a flower pot), and those are filtered out by
 * the `b.item !== b.name` test below; this set catches the stragglers.
 */
const NO_ITEM = new Set(['light']);

/** Per-block item tweaks that do not follow from the block definition. */
const BLOCK_ITEM_OPTS = {
  barrier: { rarity: RARITY.EPIC, tooltip: 'Creative only' },
  structure_void: { rarity: RARITY.EPIC, tooltip: 'Creative only' },
  spawner: { rarity: RARITY.EPIC },
  dragon_egg: { rarity: RARITY.EPIC },
  beacon: { rarity: RARITY.RARE },
  conduit: { rarity: RARITY.RARE },
  budding_amethyst: { rarity: RARITY.RARE },
  reinforced_deepslate: { rarity: RARITY.RARE },
  bedrock: { rarity: RARITY.EPIC },
  end_portal_frame: { rarity: RARITY.EPIC },
  frosted_ice: { creativeTab: null },
  enchanting_table: { rarity: RARITY.RARE },
  netherite_block: { rarity: RARITY.RARE },
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Register every item. Idempotent. */
export function registerAllItems() {
  if (registered) return items;
  registered = true;

  registerBlockItems();
  registerMaterials();
  registerTools();
  registerArmor();
  registerCombat();
  registerBuckets();
  registerFood();
  registerDyes();
  registerTransport();
  registerTooling();
  registerSpawnEggs();
  registerMusicDiscs();
  registerBrewingItems();

  return items;
}

/** Number of registered items (0 before registerAllItems runs). */
export const itemCount = () => items.length;

/** Every item name, in registration order. */
export function itemNames() { return items.map((i) => i.name); }

// ---------------------------------------------------------------------------
// 1. Block items
// ---------------------------------------------------------------------------

function registerBlockItems() {
  for (const b of blocks) {
    // `b.item` names what the block gives you. When it differs from the block
    // name the block is a secondary state of something else — a wall torch, an
    // attached stem, a filled cauldron, a crop — and the item already exists (or
    // will be defined below) under the other name.
    if (!b.item || b.item !== b.name) continue;
    if (NO_ITEM.has(b.name)) continue;
    if (itemsByName.has(b.name)) continue;
    defineBlockItem(b.name, BLOCK_ITEM_OPTS[b.name] || {});
  }
}

// ---------------------------------------------------------------------------
// 2. Raw materials
// ---------------------------------------------------------------------------

function registerMaterials() {
  const mat = (name, opts = {}) => defineItem(name, { creativeTab: 'materials', ...opts });

  mat('stick', { fuelTicks: 100 });
  mat('bowl', { fuelTicks: 200 });

  mat('coal', { fuelTicks: 1600 });
  mat('charcoal', { fuelTicks: 1600 });

  mat('raw_iron');
  mat('raw_copper');
  mat('raw_gold');

  mat('iron_ingot');
  mat('copper_ingot');
  mat('gold_ingot');
  mat('netherite_scrap');
  mat('netherite_ingot', { rarity: RARITY.UNCOMMON });

  mat('iron_nugget');
  mat('gold_nugget');

  mat('diamond');
  mat('emerald');
  mat('lapis_lazuli');
  mat('redstone');
  mat('quartz');
  mat('amethyst_shard');

  mat('clay_ball');
  mat('brick');
  mat('nether_brick');
  mat('flint');

  mat('feather');
  mat('leather');
  mat('rabbit_hide');
  mat('rabbit_foot');
  mat('string');
  mat('gunpowder');
  mat('glowstone_dust');

  mat('blaze_rod', { fuelTicks: 2400 });
  mat('blaze_powder');
  mat('ghast_tear');
  mat('magma_cream');
  mat('slime_ball');
  mat('ender_pearl', { maxStack: 16, useAnimation: 'throw' });
  mat('ender_eye');

  mat('bone');
  mat('bone_meal', { creativeTab: 'materials' });
  mat('ink_sac');
  mat('glow_ink_sac');
  mat('cocoa_beans');

  mat('sugar');
  mat('paper');
  mat('book');
  mat('nether_star', { rarity: RARITY.RARE, glint: true });
  mat('prismarine_shard');
  mat('prismarine_crystals');
  mat('nautilus_shell', { rarity: RARITY.UNCOMMON });
  mat('heart_of_the_sea', { rarity: RARITY.UNCOMMON });
  mat('scute');
  mat('phantom_membrane');
  mat('echo_shard', { rarity: RARITY.UNCOMMON });
  mat('shulker_shell');
  mat('honeycomb');
  mat('snowball', { maxStack: 16, useAnimation: 'throw' });
  mat('egg', { maxStack: 16, useAnimation: 'throw' });
  mat('dragon_breath', { rarity: RARITY.UNCOMMON, craftRemainder: 'glass_bottle' });

  mat('wheat_seeds', { creativeTab: 'natural', block: null });
  mat('pumpkin_seeds', { creativeTab: 'natural' });
  mat('melon_seeds', { creativeTab: 'natural' });
  mat('beetroot_seeds', { creativeTab: 'natural' });
  mat('torchflower_seeds', { creativeTab: 'natural' });
  mat('wheat');

  mat('popped_chorus_fruit');
}

// ---------------------------------------------------------------------------
// 3. Tools
// ---------------------------------------------------------------------------

/**
 * Per-tool-type stats. `damage` and `speed` are the vanilla per-type modifiers;
 * the final attack damage is `damage + material.damage + 1` (the +1 is the bare
 * hand's base), which reproduces every displayed value in the game.
 */
const TOOL_TYPES = {
  pickaxe: { tool: TOOL.PICKAXE, damage: 1, speed: 1.2 },
  axe: {
    tool: TOOL.AXE,
    damage: { wood: 6, stone: 7, iron: 6, gold: 6, diamond: 5, netherite: 5 },
    speed: { wood: 0.8, stone: 0.8, iron: 0.9, gold: 1.0, diamond: 1.0, netherite: 1.0 },
  },
  shovel: { tool: TOOL.SHOVEL, damage: 1.5, speed: 1.0 },
  hoe: {
    tool: TOOL.HOE,
    damage: { wood: 0, stone: -1, iron: -2, gold: 0, diamond: -3, netherite: -4 },
    speed: { wood: 1.0, stone: 2.0, iron: 3.0, gold: 1.0, diamond: 4.0, netherite: 4.0 },
  },
  sword: { tool: TOOL.SWORD, damage: 3, speed: 1.6 },
};

/** Item-name prefix for each material — Minecraft says "golden", not "gold". */
const MATERIAL_PREFIX = {
  wood: 'wooden', stone: 'stone', iron: 'iron',
  gold: 'golden', diamond: 'diamond', netherite: 'netherite',
};

/** Wooden tools burn; nothing else does. */
const TOOL_FUEL = { wood: 200 };

function pick(v, material) { return typeof v === 'object' ? v[material] : v; }

function registerTools() {
  for (const [material, m] of Object.entries(MATERIALS)) {
    const prefix = MATERIAL_PREFIX[material];
    for (const [type, t] of Object.entries(TOOL_TYPES)) {
      defineItem(`${prefix}_${type}`, {
        maxStack: 1,
        maxDamage: m.durability,
        tool: t.tool,
        tier: m.tier,
        material,
        miningSpeed: m.speed,
        attackDamage: pick(t.damage, material) + m.damage + 1,
        attackSpeed: pick(t.speed, material),
        enchantability: m.enchantability,
        repairWith: m.repair,
        fuelTicks: TOOL_FUEL[material] || 0,
        creativeTab: 'tools',
        handheld: true,
        rarity: material === 'netherite' ? RARITY.UNCOMMON : RARITY.COMMON,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Armour
// ---------------------------------------------------------------------------

const ARMOR_PIECES = [
  { suffix: 'helmet', slot: SLOT.HEAD, index: 0 },
  { suffix: 'chestplate', slot: SLOT.CHEST, index: 1 },
  { suffix: 'leggings', slot: SLOT.LEGS, index: 2 },
  { suffix: 'boots', slot: SLOT.FEET, index: 3 },
];

const ARMOR_PREFIX = {
  leather: 'leather', chainmail: 'chainmail', iron: 'iron',
  gold: 'golden', diamond: 'diamond', netherite: 'netherite',
};

function registerArmor() {
  for (const [material, m] of Object.entries(ARMOR_MATERIALS)) {
    const prefix = ARMOR_PREFIX[material];
    for (const p of ARMOR_PIECES) {
      defineItem(`${prefix}_${p.suffix}`, {
        maxStack: 1,
        maxDamage: m.durability[p.index],
        armorSlot: p.slot,
        defense: m.defense[p.index],
        toughness: m.toughness,
        knockbackResistance: m.knockbackResistance,
        enchantability: m.enchantability,
        repairWith: m.repair,
        material,
        creativeTab: 'combat',
        equipSound: material === 'leather' ? 'armor.equip_leather' : `armor.equip_${material}`,
        // Leather armour is the only dyeable set.
        color: material === 'leather' ? 0xa06540 : null,
        rarity: material === 'netherite' ? RARITY.UNCOMMON : RARITY.COMMON,
      });
    }
  }

  // Turtle shell — a helmet that is not part of a full set.
  defineItem('turtle_helmet', {
    maxStack: 1,
    maxDamage: 275,
    armorSlot: SLOT.HEAD,
    defense: 2,
    toughness: 0,
    enchantability: 9,
    repairWith: 'scute',
    creativeTab: 'combat',
    equipSound: 'armor.equip_turtle',
  });

  // Horse armour: no durability, no player slot, worn by a horse.
  const horse = (name, defense, rarity = RARITY.COMMON) => defineItem(name, {
    maxStack: 1, defense, creativeTab: 'combat', rarity,
  });
  horse('leather_horse_armor', 3);
  horse('iron_horse_armor', 5);
  horse('golden_horse_armor', 7);
  horse('diamond_horse_armor', 11, RARITY.UNCOMMON);

  defineItem('elytra', {
    maxStack: 1,
    maxDamage: 432,
    armorSlot: SLOT.CHEST,
    defense: 0,
    enchantability: 15,
    repairWith: 'phantom_membrane',
    creativeTab: 'combat',
    rarity: RARITY.UNCOMMON,
    equipSound: 'armor.equip_elytra',
  });

  defineItem('totem_of_undying', {
    maxStack: 1, creativeTab: 'combat', rarity: RARITY.UNCOMMON,
  });
}

// ---------------------------------------------------------------------------
// 5. Weapons and projectiles
// ---------------------------------------------------------------------------

function registerCombat() {
  defineItem('bow', {
    maxStack: 1, maxDamage: 384, enchantability: 1, fuelTicks: 300,
    creativeTab: 'combat', handheld: true, useAnimation: 'bow', useDuration: 72000,
    repairWith: 'string',
  });
  defineItem('crossbow', {
    maxStack: 1, maxDamage: 465, enchantability: 1,
    creativeTab: 'combat', handheld: true, useAnimation: 'crossbow', useDuration: 25,
    repairWith: 'string',
  });
  defineItem('arrow', { creativeTab: 'combat', projectile: 'arrow' });
  defineItem('spectral_arrow', {
    creativeTab: 'combat', projectile: 'arrow', glint: false,
    tooltip: 'Glowing',
  });
  defineItem('tipped_arrow', {
    creativeTab: 'combat', projectile: 'arrow', rarity: RARITY.UNCOMMON,
  });
  defineItem('trident', {
    maxStack: 1, maxDamage: 250, attackDamage: 9, attackSpeed: 1.1,
    enchantability: 1, creativeTab: 'combat', handheld: true,
    useAnimation: 'spear', useDuration: 72000, rarity: RARITY.UNCOMMON,
  });
  defineItem('shield', {
    maxStack: 1, maxDamage: 336, enchantability: 9, repairWith: 'oak_planks',
    creativeTab: 'combat', useAnimation: 'block', useDuration: 72000,
  });
  defineItem('firework_rocket', { creativeTab: 'combat', useAnimation: 'rocket' });
  defineItem('firework_star', { creativeTab: 'combat' });
  defineItem('fire_charge', { creativeTab: 'combat' });
}

// ---------------------------------------------------------------------------
// 6. Buckets and bottles
// ---------------------------------------------------------------------------

function registerBuckets() {
  defineItem('bucket', { maxStack: 16, creativeTab: 'tools' });
  const filled = (name, opts = {}) => defineItem(name, {
    maxStack: 1, craftRemainder: 'bucket', creativeTab: 'tools', ...opts,
  });
  filled('water_bucket');
  filled('lava_bucket', { fuelTicks: 20000 });
  filled('powder_snow_bucket');
  filled('milk_bucket', { useAnimation: 'drink', useDuration: 32 });
  for (const fish of ['cod', 'salmon', 'tropical_fish', 'pufferfish', 'axolotl', 'tadpole']) {
    filled(`${fish}_bucket`);
  }

  defineItem('glass_bottle', { creativeTab: 'brewing' });
  defineItem('experience_bottle', {
    creativeTab: 'brewing', rarity: RARITY.UNCOMMON, useAnimation: 'throw',
  });
  defineItem('honey_bottle', {
    maxStack: 16, craftRemainder: 'glass_bottle', creativeTab: 'food',
    useAnimation: 'drink', useDuration: 40,
    food: { hunger: 6, saturation: 1.2, effects: [{ id: 'cure_poison' }] },
  });
}

// ---------------------------------------------------------------------------
// 7. Food
//
// `hunger` is in half-shanks, `saturation` is the raw saturation value (not the
// modifier). `effects` are applied on eating; `chance` defaults to 1.
// ---------------------------------------------------------------------------

function registerFood() {
  const food = (name, hunger, saturation, opts = {}) => {
    const { effects, ...rest } = opts;
    return defineItem(name, {
      creativeTab: 'food',
      food: { hunger, saturation, effects: effects || null, alwaysEdible: !!opts.alwaysEdible },
      ...rest,
    });
  };

  // -- Crops ---------------------------------------------------------------
  food('apple', 4, 2.4);
  food('golden_apple', 4, 9.6, {
    rarity: RARITY.RARE, alwaysEdible: true, glint: true,
    effects: [
      { id: 'regeneration', duration: 100, amplifier: 1 },
      { id: 'absorption', duration: 2400, amplifier: 0 },
    ],
  });
  food('enchanted_golden_apple', 4, 9.6, {
    rarity: RARITY.EPIC, alwaysEdible: true, glint: true,
    effects: [
      { id: 'regeneration', duration: 400, amplifier: 1 },
      { id: 'absorption', duration: 2400, amplifier: 3 },
      { id: 'resistance', duration: 6000, amplifier: 0 },
      { id: 'fire_resistance', duration: 6000, amplifier: 0 },
    ],
  });
  food('bread', 5, 6);
  food('carrot', 3, 3.6);
  food('golden_carrot', 6, 14.4);
  food('potato', 1, 0.6);
  food('baked_potato', 5, 6);
  food('poisonous_potato', 2, 1.2, {
    effects: [{ id: 'poison', duration: 100, amplifier: 0, chance: 0.6 }],
  });
  food('beetroot', 1, 1.2);
  food('melon_slice', 2, 1.2);
  defineItem('glistering_melon_slice', { creativeTab: 'materials' });
  food('cookie', 2, 0.4);
  food('pumpkin_pie', 8, 4.8);
  food('dried_kelp', 1, 0.6, { useDuration: 16 });
  food('sweet_berries', 2, 0.4);
  food('glow_berries', 2, 0.4);
  food('chorus_fruit', 4, 2.4, {
    alwaysEdible: true, useDuration: 32,
    effects: [{ id: 'teleport', duration: 0, amplifier: 0 }],
  });

  // -- Meat ----------------------------------------------------------------
  food('beef', 3, 1.8);
  food('cooked_beef', 8, 12.8);
  food('porkchop', 3, 1.8);
  food('cooked_porkchop', 8, 12.8);
  food('chicken', 2, 1.2, {
    effects: [{ id: 'hunger', duration: 600, amplifier: 0, chance: 0.3 }],
  });
  food('cooked_chicken', 6, 7.2);
  food('mutton', 2, 1.2);
  food('cooked_mutton', 6, 9.6);
  food('rabbit', 3, 1.8);
  food('cooked_rabbit', 5, 6);
  food('rotten_flesh', 4, 0.8, {
    effects: [{ id: 'hunger', duration: 600, amplifier: 0, chance: 0.8 }],
  });

  // -- Fish ----------------------------------------------------------------
  food('cod', 2, 0.4);
  food('cooked_cod', 5, 6);
  food('salmon', 2, 0.4);
  food('cooked_salmon', 6, 9.6);
  food('tropical_fish', 1, 0.2);
  food('pufferfish', 1, 0.2, {
    effects: [
      { id: 'poison', duration: 1200, amplifier: 1 },
      { id: 'hunger', duration: 300, amplifier: 2 },
      { id: 'nausea', duration: 300, amplifier: 0 },
    ],
  });

  // -- Bowls ---------------------------------------------------------------
  const stew = (name, hunger, saturation, opts = {}) => food(name, hunger, saturation, {
    maxStack: 1, craftRemainder: 'bowl', ...opts,
  });
  stew('mushroom_stew', 6, 7.2);
  stew('rabbit_stew', 10, 12);
  stew('beetroot_soup', 6, 7.2);
  stew('suspicious_stew', 6, 7.2, { rarity: RARITY.UNCOMMON });

  // -- Odds and ends -------------------------------------------------------
  food('spider_eye', 2, 3.2, {
    creativeTab: 'materials',
    effects: [{ id: 'poison', duration: 80, amplifier: 0 }],
  });
  defineItem('fermented_spider_eye', { creativeTab: 'brewing' });
}

// ---------------------------------------------------------------------------
// 8. Dyes
// ---------------------------------------------------------------------------

function registerDyes() {
  for (const c of COLORS) {
    defineItem(`${c}_dye`, {
      creativeTab: 'ingredients',
      color: COLOR_HEX[c],
      tags: ['dye'],
    });
  }
}

// ---------------------------------------------------------------------------
// 9. Transport
// ---------------------------------------------------------------------------

/** Wood species that have a boat (the nether fungi do not). */
const BOAT_WOODS = WOOD_TYPES.filter((w) => w.kind === 'wood').map((w) => w.name);

function registerTransport() {
  for (const w of BOAT_WOODS) {
    defineItem(`${w}_boat`, {
      maxStack: 1, creativeTab: 'transportation', fuelTicks: 1200,
    });
    defineItem(`${w}_chest_boat`, {
      maxStack: 1, creativeTab: 'transportation', fuelTicks: 1200,
    });
  }
  defineItem('minecart', { maxStack: 1, creativeTab: 'transportation' });
  for (const kind of ['chest', 'furnace', 'hopper', 'tnt']) {
    defineItem(`${kind}_minecart`, { maxStack: 1, creativeTab: 'transportation' });
  }
  defineItem('saddle', { maxStack: 1, creativeTab: 'transportation' });
  defineItem('lead', { creativeTab: 'tools' });
  defineItem('carrot_on_a_stick', {
    maxStack: 1, maxDamage: 25, creativeTab: 'transportation', handheld: true,
  });
  defineItem('warped_fungus_on_a_stick', {
    maxStack: 1, maxDamage: 100, creativeTab: 'transportation', handheld: true,
  });
}

// ---------------------------------------------------------------------------
// 10. Tools that are not weapons, and decorations that are not blocks
// ---------------------------------------------------------------------------

function registerTooling() {
  defineItem('shears', {
    maxStack: 1, maxDamage: 238, tool: TOOL.SHEARS, tier: TIER.HAND,
    miningSpeed: 1, enchantability: 15, repairWith: 'iron_ingot',
    creativeTab: 'tools', handheld: true,
  });
  defineItem('flint_and_steel', {
    maxStack: 1, maxDamage: 64, creativeTab: 'tools', handheld: true,
  });
  defineItem('fishing_rod', {
    maxStack: 1, maxDamage: 64, enchantability: 1, fuelTicks: 300,
    creativeTab: 'tools', handheld: true,
  });
  defineItem('brush', {
    maxStack: 1, maxDamage: 64, creativeTab: 'tools', handheld: true,
    useAnimation: 'brush', useDuration: 200,
  });
  defineItem('spyglass', {
    maxStack: 1, creativeTab: 'tools', useAnimation: 'spyglass', useDuration: 1200,
  });
  defineItem('compass', { creativeTab: 'tools' });
  defineItem('recovery_compass', { creativeTab: 'tools', rarity: RARITY.UNCOMMON });
  defineItem('clock', { creativeTab: 'tools' });
  defineItem('map', { creativeTab: 'tools' });
  defineItem('filled_map', { creativeTab: 'tools' });
  defineItem('name_tag', { creativeTab: 'tools' });

  defineItem('writable_book', { maxStack: 1, creativeTab: 'tools' });
  defineItem('written_book', { maxStack: 16, creativeTab: 'tools', rarity: RARITY.UNCOMMON });
  defineItem('enchanted_book', {
    maxStack: 1, creativeTab: 'tools', rarity: RARITY.UNCOMMON, glint: true,
  });

  defineItem('painting', { creativeTab: 'decorations' });
  defineItem('item_frame', { creativeTab: 'decorations' });
  defineItem('glow_item_frame', { creativeTab: 'decorations' });
  defineItem('armor_stand', { maxStack: 16, creativeTab: 'decorations' });
}

// ---------------------------------------------------------------------------
// 11. Spawn eggs
//
// `base`/`spots` are the two egg colours Minecraft uses for each mob, which the
// texture painter reads straight off the item.
// ---------------------------------------------------------------------------

export const MOB_EGGS = Object.freeze([
  ['allay', 0x00daff, 0x00adff], ['armadillo', 0xa17658, 0xd0c1a3],
  ['axolotl', 0xfbc1e3, 0xa62e74], ['bat', 0x4c3e30, 0x0f0f0f],
  ['bee', 0xedc343, 0x43241b], ['blaze', 0xf6b201, 0xfff87e],
  ['camel', 0xfcc369, 0xcf9b5d], ['cat', 0xefc38c, 0x957527],
  ['cave_spider', 0x0c424e, 0xa80e0e], ['chicken', 0xa1a1a1, 0xff0000],
  ['cod', 0xc1c1c1, 0xe5c48b], ['cow', 0x443626, 0xa1a1a1],
  ['creeper', 0x0da70b, 0x000000], ['dolphin', 0x223b4d, 0xf9f9f9],
  ['donkey', 0x534539, 0x99958f], ['drowned', 0x8ff1d7, 0x799c65],
  ['elder_guardian', 0xceccba, 0x747693], ['ender_dragon', 0x1c1c1c, 0xcf76f7],
  ['enderman', 0x161616, 0x000000], ['endermite', 0x161616, 0x6d6d6d],
  ['evoker', 0x959b9b, 0x1e1c1a], ['fox', 0xd5b69f, 0xcc6920],
  ['frog', 0xd07444, 0xffe5c8], ['ghast', 0xf9f9f9, 0xbcbcbc],
  ['glow_squid', 0x095656, 0x86f4ce], ['goat', 0xa5a29a, 0xdcd5cd],
  ['guardian', 0x5a8272, 0xf17d31], ['hoglin', 0xc66e55, 0x5f6464],
  ['horse', 0xc09e7d, 0xeee500], ['husk', 0x7f7550, 0xe6cd9b],
  ['iron_golem', 0xdbcfc0, 0x8e7f6f], ['llama', 0xc09e7d, 0x995f40],
  ['magma_cube', 0x340000, 0xfcfc00], ['mooshroom', 0xa00f10, 0xb7b7b7],
  ['mule', 0x1b0200, 0x51331d], ['ocelot', 0xefde7d, 0x564434],
  ['panda', 0xe7e7e7, 0x1b1b1b], ['parrot', 0x0da70b, 0xff0000],
  ['phantom', 0x43518a, 0x88ff00], ['pig', 0xf0a5a2, 0xdb635f],
  ['piglin', 0x995f40, 0xf9f3a4], ['piglin_brute', 0x592a10, 0xf9f3a4],
  ['pillager', 0x532f36, 0x9b9b9b], ['polar_bear', 0xf2f2f2, 0x959590],
  ['pufferfish', 0xf6b201, 0x38a3d8], ['rabbit', 0x995f40, 0x734831],
  ['ravager', 0x757470, 0x5b5049], ['salmon', 0xa00f10, 0x0e8474],
  ['sheep', 0xe7e7e7, 0xffb5b5], ['shulker', 0x946794, 0x4d3852],
  ['silverfish', 0x6e6e6e, 0x303030], ['skeleton', 0xc1c1c1, 0x494949],
  ['skeleton_horse', 0x68684f, 0xe5e5d8], ['slime', 0x51a03e, 0x7ebf6e],
  ['sniffer', 0x8f6c4b, 0xd3c4a5], ['snow_golem', 0xededed, 0xa1a1a1],
  ['spider', 0x342d27, 0xa80e0e], ['squid', 0x223b4d, 0x708899],
  ['stray', 0x617677, 0xdddddd], ['strider', 0x9c3436, 0x4d494d],
  ['tadpole', 0x6d5f43, 0x1a1a1a], ['trader_llama', 0xeaa430, 0x456296],
  ['tropical_fish', 0xef6915, 0xf9f9f9], ['turtle', 0xe7e7e7, 0x00afaf],
  ['vex', 0x7a90a4, 0xe8edf1], ['villager', 0x563c33, 0xbd8b72],
  ['vindicator', 0x959b9b, 0x275e61], ['wandering_trader', 0x456296, 0xeaa430],
  ['warden', 0x0f4649, 0x39d6e0], ['witch', 0x340000, 0x51a03e],
  ['wither', 0x141414, 0x474d4d], ['wither_skeleton', 0x141414, 0x474d4d],
  ['wolf', 0xd7d3d3, 0xceaf96], ['zoglin', 0xc66e55, 0xe6e6e6],
  ['zombie', 0x00afaf, 0x799c65], ['zombie_horse', 0x315234, 0x97c284],
  ['zombie_villager', 0x563c33, 0x799c65], ['zombified_piglin', 0xea9393, 0x4c7129],
]);

function registerSpawnEggs() {
  for (const [mob, base, spots] of MOB_EGGS) {
    defineItem(`${mob}_spawn_egg`, {
      creativeTab: 'spawn_eggs',
      spawnEgg: mob,
      color: base,
      tags: ['spawn_egg'],
      tooltip: 'Creative only',
      // The painter reads both colours off the item.
      texture: `${mob}_spawn_egg`,
    }).eggColors = [base, spots];
  }
}

// ---------------------------------------------------------------------------
// 12. Music discs
// ---------------------------------------------------------------------------

export const MUSIC_DISCS = Object.freeze([
  ['13', 0x9a7d5e], ['cat', 0x5eb04a], ['blocks', 0xd48b3a],
  ['chirp', 0xc0392b], ['far', 0x7fbf4a], ['mall', 0x3f7fbf],
  ['mellohi', 0xa855c9], ['stal', 0x4f4f4f], ['strad', 0xe0c04a],
  ['ward', 0x2e8b57], ['11', 0x2b2b2b], ['wait', 0x2fa8a0],
  ['otherside', 0x6a4fc9], ['5', 0x3a3a3a], ['pigstep', 0xd4708f],
  ['relic', 0xc98b4a],
]);

function registerMusicDiscs() {
  for (const [id, color] of MUSIC_DISCS) {
    defineItem(`music_disc_${id}`, {
      maxStack: 1,
      creativeTab: 'tools',
      rarity: RARITY.RARE,
      color,
      tooltip: `C418 - ${id}`,
    });
  }
  defineItem('disc_fragment_5', { creativeTab: 'materials' });
}

// ---------------------------------------------------------------------------
// 13. Potions
//
// The three potion items all share one texture and take their colour and effect
// list from `tag.potion`; the brewing graph in recipes.js decides which is
// which, so there is exactly one item per delivery form.
// ---------------------------------------------------------------------------

function registerBrewingItems() {
  defineItem('potion', {
    maxStack: 1, craftRemainder: 'glass_bottle', creativeTab: 'brewing',
    useAnimation: 'drink', useDuration: 32,
  });
  defineItem('splash_potion', {
    maxStack: 1, creativeTab: 'brewing', useAnimation: 'throw',
  });
  defineItem('lingering_potion', {
    maxStack: 1, creativeTab: 'brewing', useAnimation: 'throw',
    rarity: RARITY.UNCOMMON,
  });
}
