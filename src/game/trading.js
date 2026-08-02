// Villager trading.
//
// A villager has a profession, a level from 1 (novice) to 5 (master), and two
// offers unlocked per level, drawn at random from that level's pool. Trading
// gives the villager experience toward the next level and gradually raises the
// price of whatever is being bought heavily — the "demand" term — while a
// Hero of the Village discount pulls it back down.
//
// Trade pools reference items by name and are filtered against the item
// registry when they are built, so this module works with whatever subset of
// the item list is actually registered.

import { Random } from '../core/rng.js';
import { clamp } from '../core/math.js';
import { ItemStack, itemsByName } from './items.js';
import { levelOf } from './effects.js';
import { applyEnchantment, ENCHANTMENT_LIST, enchantWithLevels } from './enchanting.js';
import { spawnOrbs } from './experience.js';

/** Villager levels and the experience needed to reach each of them. */
export const LEVELS = [
  { level: 1, name: 'novice', xp: 0 },
  { level: 2, name: 'apprentice', xp: 10 },
  { level: 3, name: 'journeyman', xp: 70 },
  { level: 4, name: 'expert', xp: 150 },
  { level: 5, name: 'master', xp: 250 },
];

/** How many trades of each level a villager offers. */
export const TRADES_PER_LEVEL = 2;

/** Ticks between the two daily restocks a villager gets at its workstation. */
export const RESTOCK_INTERVAL = 12000;
/** How many times a villager will restock in one day. */
export const MAX_RESTOCKS_PER_DAY = 2;

// ---------------------------------------------------------------------------
// Trade entry helpers
//
// `sellFor(x, n)` — the villager buys n of item x, paying one emerald.
// `buyWith(n, x, m)` — the villager sells m of item x for n emeralds.
// ---------------------------------------------------------------------------

const E = 'emerald';

/** The villager buys `count` of `item` for one (or `price`) emerald(s). */
function sellFor(item, count, opts = {}) {
  return {
    buy: [{ item, count }],
    sell: { item: E, count: opts.emeralds ?? 1 },
    maxUses: opts.maxUses ?? 16,
    xp: opts.xp ?? 2,
    priceMultiplier: opts.priceMultiplier ?? 0.05,
  };
}

/** The villager sells `count` of `item` for `price` emeralds. */
function buyWith(price, item, count = 1, opts = {}) {
  return {
    buy: [{ item: E, count: price }, ...(opts.second ? [opts.second] : [])],
    sell: { item, count },
    maxUses: opts.maxUses ?? 12,
    xp: opts.xp ?? 1,
    priceMultiplier: opts.priceMultiplier ?? 0.05,
    enchant: opts.enchant ?? null,
  };
}

/** An enchanted-book trade whose price scales with the enchantment level. */
function enchantedBook(opts = {}) {
  return {
    buy: [{ item: E, count: opts.price ?? 12 }, { item: 'book', count: 1 }],
    sell: { item: 'enchanted_book', count: 1 },
    maxUses: 12,
    xp: opts.xp ?? 5,
    priceMultiplier: 0.2,
    enchant: { random: true, levels: opts.levels ?? [5, 19] },
  };
}

/** A tool or weapon the villager has enchanted itself. */
function enchantedTool(price, item, levels = [5, 19], xp = 15) {
  return {
    buy: [{ item: E, count: price }],
    sell: { item, count: 1 },
    maxUses: 3,
    xp,
    priceMultiplier: 0.2,
    enchant: { random: true, levels },
  };
}

// ---------------------------------------------------------------------------
// The professions
// ---------------------------------------------------------------------------

/**
 * Every profession, its workstation block, and the five trade pools.
 * Levels are indexed 0..4 for novice..master.
 */
export const PROFESSIONS = {
  farmer: {
    name: 'farmer', workstation: 'composter', hat: 'straw',
    tiers: [
      [sellFor('wheat', 20), sellFor('potato', 26), sellFor('carrot', 22),
        sellFor('beetroot', 15), buyWith(1, 'bread', 6)],
      [sellFor('pumpkin', 6), buyWith(1, 'pumpkin_pie', 4), buyWith(1, 'apple', 4)],
      [sellFor('melon', 4), buyWith(1, 'cookie', 18)],
      [buyWith(1, 'cake', 1), buyWith(1, 'suspicious_stew', 1)],
      [buyWith(3, 'golden_carrot', 3), buyWith(4, 'glistering_melon_slice', 3)],
    ],
  },
  fisherman: {
    name: 'fisherman', workstation: 'barrel', hat: 'none',
    tiers: [
      [sellFor('string', 20), sellFor('coal', 10), buyWith(1, 'cooked_cod', 6),
        { ...sellFor('cod', 6), second: null }],
      [sellFor('cod', 15), buyWith(1, 'campfire', 1), buyWith(1, 'cooked_salmon', 6)],
      [sellFor('salmon', 13), enchantedTool(8, 'fishing_rod', [5, 19], 10)],
      [sellFor('tropical_fish', 6), buyWith(3, 'oak_boat', 1)],
      [sellFor('pufferfish', 4)],
    ],
  },
  shepherd: {
    name: 'shepherd', workstation: 'loom', hat: 'none',
    tiers: [
      [sellFor('white_wool', 18), buyWith(2, 'shears', 1)],
      [sellFor('white_dye', 12), buyWith(1, 'white_wool', 1),
        buyWith(3, 'white_carpet', 4)],
      [sellFor('black_dye', 12), buyWith(3, 'white_bed', 1)],
      [sellFor('red_dye', 12), buyWith(3, 'white_banner', 1)],
      [buyWith(2, 'painting', 3)],
    ],
  },
  fletcher: {
    name: 'fletcher', workstation: 'fletching_table', hat: 'none',
    tiers: [
      [sellFor('stick', 32), buyWith(1, 'arrow', 16)],
      [sellFor('flint', 26), buyWith(2, 'bow', 1)],
      [sellFor('string', 14), buyWith(3, 'crossbow', 1)],
      [sellFor('feather', 24), buyWith(8, 'tipped_arrow', 5)],
      [sellFor('tripwire_hook', 8), enchantedTool(3, 'bow'),
        enchantedTool(3, 'crossbow')],
    ],
  },
  librarian: {
    name: 'librarian', workstation: 'lectern', hat: 'glasses',
    tiers: [
      [sellFor('paper', 24), enchantedBook({ price: 6 }), buyWith(9, 'bookshelf', 1)],
      [sellFor('book', 4), enchantedBook({ price: 12 }), buyWith(1, 'lantern', 1)],
      [sellFor('ink_sac', 5), enchantedBook({ price: 18 }), buyWith(1, 'glass', 4)],
      [sellFor('writable_book', 2), enchantedBook({ price: 24 }), buyWith(5, 'clock', 1),
        buyWith(4, 'compass', 1)],
      [buyWith(20, 'name_tag', 1)],
    ],
  },
  cartographer: {
    name: 'cartographer', workstation: 'cartography_table', hat: 'none',
    tiers: [
      [sellFor('paper', 24), buyWith(7, 'map', 1)],
      [sellFor('glass_pane', 11), buyWith(13, 'filled_map', 1,
        { second: { item: 'compass', count: 1 } })],
      [sellFor('compass', 1), buyWith(14, 'filled_map', 1,
        { second: { item: 'compass', count: 1 } })],
      [buyWith(7, 'item_frame', 1), buyWith(3, 'white_banner', 1)],
      [buyWith(8, 'globe_banner_pattern', 1)],
    ],
  },
  cleric: {
    name: 'cleric', workstation: 'brewing_stand', hat: 'none',
    tiers: [
      [sellFor('rotten_flesh', 32), buyWith(1, 'redstone', 2)],
      [sellFor('gold_ingot', 3), buyWith(1, 'lapis_lazuli', 1)],
      [sellFor('rabbit_foot', 2), buyWith(4, 'glowstone', 1)],
      [sellFor('scute', 4), sellFor('glass_bottle', 9), buyWith(5, 'ender_pearl', 1)],
      [sellFor('nether_wart', 22), buyWith(3, 'experience_bottle', 1)],
    ],
  },
  armorer: {
    name: 'armorer', workstation: 'blast_furnace', hat: 'none',
    tiers: [
      [sellFor('coal', 15), buyWith(7, 'iron_helmet', 1), buyWith(9, 'iron_chestplate', 1),
        buyWith(5, 'iron_leggings', 1), buyWith(4, 'iron_boots', 1)],
      [sellFor('iron_ingot', 4), buyWith(36, 'bell', 1), buyWith(1, 'chainmail_boots', 1)],
      [sellFor('lava_bucket', 1), sellFor('diamond', 1), buyWith(5, 'shield', 1),
        buyWith(1, 'chainmail_helmet', 1)],
      [enchantedTool(19, 'diamond_leggings', [5, 19], 30),
        enchantedTool(13, 'diamond_boots', [5, 19], 30)],
      [enchantedTool(13, 'diamond_helmet', [5, 19], 30),
        enchantedTool(21, 'diamond_chestplate', [5, 19], 30)],
    ],
  },
  weaponsmith: {
    name: 'weaponsmith', workstation: 'grindstone', hat: 'none',
    tiers: [
      [sellFor('coal', 15), buyWith(3, 'iron_axe', 1), enchantedTool(7, 'iron_sword', [5, 19], 5)],
      [sellFor('iron_ingot', 4), buyWith(36, 'bell', 1)],
      [sellFor('flint', 24)],
      [sellFor('diamond', 1), enchantedTool(12, 'diamond_axe', [5, 19], 30)],
      [enchantedTool(13, 'diamond_sword', [5, 19], 30)],
    ],
  },
  toolsmith: {
    name: 'toolsmith', workstation: 'smithing_table', hat: 'none',
    tiers: [
      [sellFor('coal', 15), buyWith(1, 'stone_axe', 1), buyWith(1, 'stone_shovel', 1),
        buyWith(1, 'stone_pickaxe', 1), buyWith(1, 'stone_hoe', 1)],
      [sellFor('iron_ingot', 4), buyWith(36, 'bell', 1)],
      [sellFor('flint', 30), enchantedTool(7, 'iron_axe', [5, 19], 5),
        enchantedTool(8, 'iron_shovel', [5, 19], 5),
        enchantedTool(36, 'iron_pickaxe', [5, 19], 5)],
      [sellFor('diamond', 1), enchantedTool(18, 'diamond_axe', [5, 19], 30)],
      [enchantedTool(19, 'diamond_shovel', [5, 19], 30),
        enchantedTool(22, 'diamond_pickaxe', [5, 19], 30)],
    ],
  },
  butcher: {
    name: 'butcher', workstation: 'smoker', hat: 'none',
    tiers: [
      [sellFor('chicken', 14), sellFor('porkchop', 7), sellFor('rabbit', 4),
        buyWith(1, 'rabbit_stew', 1)],
      [sellFor('coal', 15), buyWith(1, 'cooked_porkchop', 5),
        buyWith(1, 'cooked_chicken', 8)],
      [sellFor('mutton', 7), sellFor('beef', 10)],
      [sellFor('dried_kelp_block', 10)],
      [buyWith(1, 'cooked_beef', 4), buyWith(1, 'sweet_berries', 10)],
    ],
  },
  leatherworker: {
    name: 'leatherworker', workstation: 'cauldron', hat: 'none',
    tiers: [
      [sellFor('leather', 6), buyWith(3, 'leather_leggings', 1),
        buyWith(7, 'leather_chestplate', 1)],
      [sellFor('flint', 26), buyWith(5, 'leather_helmet', 1),
        buyWith(4, 'leather_boots', 1)],
      [sellFor('rabbit_hide', 9), buyWith(7, 'leather_chestplate', 1)],
      [sellFor('scute', 4), buyWith(6, 'leather_horse_armor', 1)],
      [buyWith(6, 'saddle', 1), buyWith(5, 'leather_helmet', 1)],
    ],
  },
  mason: {
    name: 'mason', workstation: 'stonecutter', hat: 'none',
    tiers: [
      [sellFor('clay_ball', 10), buyWith(1, 'brick', 10)],
      [sellFor('stone', 20), buyWith(1, 'chiseled_stone_bricks', 4)],
      [sellFor('granite', 16), sellFor('andesite', 16), sellFor('diorite', 16),
        buyWith(1, 'polished_andesite', 4), buyWith(1, 'polished_diorite', 4)],
      [buyWith(1, 'terracotta', 1), buyWith(1, 'white_glazed_terracotta', 1)],
      [buyWith(1, 'quartz_pillar', 1), buyWith(1, 'quartz_block', 1)],
    ],
  },
  nitwit: { name: 'nitwit', workstation: null, hat: 'none', tiers: [[], [], [], [], []] },
  none: { name: 'none', workstation: null, hat: 'none', tiers: [[], [], [], [], []] },
};

/** Profession ids in a stable order, for spawning and the debug overlay. */
export const PROFESSION_NAMES = Object.keys(PROFESSIONS);

/** The profession a workstation block grants. */
export const WORKSTATIONS = (() => {
  const map = Object.create(null);
  for (const p of Object.values(PROFESSIONS)) {
    if (p.workstation) map[p.workstation] = p.name;
  }
  return Object.freeze(map);
})();

// ---------------------------------------------------------------------------
// Building a villager's offers
// ---------------------------------------------------------------------------

/** Turn a `{item, count}` descriptor into a stack, or null when unregistered. */
function toStack(desc) {
  if (!desc) return null;
  if (!itemsByName.has(desc.item)) return null;
  return new ItemStack(desc.item, desc.count);
}

/** Is every item a trade mentions actually registered? */
function tradeIsBuildable(entry) {
  if (!entry) return false;
  for (const b of entry.buy) if (!itemsByName.has(b.item)) return false;
  return itemsByName.has(entry.sell.item);
}

let nextOfferId = 1;

function buildOffer(entry, random) {
  const offer = {
    id: nextOfferId++,
    buyA: toStack(entry.buy[0]),
    buyB: entry.buy[1] ? toStack(entry.buy[1]) : null,
    sell: toStack(entry.sell),
    maxUses: entry.maxUses ?? 12,
    uses: 0,
    xp: entry.xp ?? 1,
    priceMultiplier: entry.priceMultiplier ?? 0.05,
    demand: 0,
    specialPrice: 0,
    rewardsExp: true,
    disabled: false,
  };
  if (entry.enchant?.random && offer.sell) {
    const [lo, hi] = entry.enchant.levels ?? [5, 19];
    const levels = random.intRange(lo, hi);
    const enchanted = enchantWithLevels(offer.sell, levels, random, true);
    if (enchanted) offer.sell = enchanted;
    // The price of an enchanted book scales with how good it turned out.
    if (offer.buyA?.item?.name === E) {
      offer.buyA.count = clamp(offer.buyA.count + Math.floor(levels / 2), 1, 64);
    }
  } else if (entry.enchant && offer.sell) {
    applyEnchantment(offer.sell, entry.enchant.id, entry.enchant.level ?? 1, { force: true });
  }
  return offer;
}

/**
 * The offers a villager currently has, building them on first use and caching
 * them on the entity. Levelling up adds two more without disturbing the old
 * ones, exactly as in the real game.
 */
export function tradesFor(villager) {
  if (!villager) return [];
  const profession = PROFESSIONS[villager.profession] ?? PROFESSIONS.none;
  const level = clamp(villager.villagerLevel ?? villager.level ?? 1, 1, 5);
  if (!villager.offers) villager.offers = [];
  const built = villager.builtTradeLevels ?? (villager.builtTradeLevels = 0);
  if (built >= level) return villager.offers;

  const random = new Random((villager.id ?? 0) * 2654435761 ^ (villager.tradeSeed ?? 0));
  for (let l = built; l < level; l++) {
    const pool = (profession.tiers[l] ?? []).filter(tradeIsBuildable);
    if (pool.length === 0) continue;
    const picks = [...pool];
    random.shuffle(picks);
    for (const entry of picks.slice(0, TRADES_PER_LEVEL)) {
      villager.offers.push(buildOffer(entry, random));
    }
  }
  villager.builtTradeLevels = level;
  return villager.offers;
}

/** Recompute a villager's level from its accumulated trading experience. */
export function levelFor(xp) {
  let level = 1;
  for (const l of LEVELS) if (xp >= l.xp) level = l.level;
  return level;
}

export function levelName(level) {
  return LEVELS[clamp(level, 1, 5) - 1].name;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/**
 * What the player actually pays for an offer right now.
 *
 * Demand rises as an offer is used and decays when the villager restocks, and
 * a Hero of the Village discount takes 30% off per level.
 */
export function priceFor(offer, player = null) {
  if (!offer?.buyA) return 0;
  const base = offer.buyA.count;
  let price = base + Math.max(0, Math.floor(offer.demand * offer.priceMultiplier * base));
  price += offer.specialPrice;
  const hero = levelOf(player, 'hero_of_the_village');
  if (hero > 0) price -= Math.floor(price * 0.3 * hero);
  return clamp(price, 1, offer.buyA.maxStack);
}

/** True when the offer has been used up and needs a restock. */
export function isSoldOut(offer) { return offer.uses >= offer.maxUses; }

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

/** Does the player's inventory hold everything the offer wants? */
export function canAfford(player, offer) {
  if (!player?.inventory || !offer) return false;
  const price = priceFor(offer, player);
  if (countItem(player, offer.buyA.item.name) < price) return false;
  if (offer.buyB && countItem(player, offer.buyB.item.name) < offer.buyB.count) return false;
  return true;
}

function countItem(player, name) {
  const inv = player.inventory;
  const lists = [inv.slots, inv.armorSlots, inv.offhand ? [inv.offhand] : []];
  let n = 0;
  for (const list of lists) {
    if (!list) continue;
    for (const s of list) if (s && !s.empty && s.item.name === name) n += s.count;
  }
  return n;
}

function takeItem(player, name, count) {
  const inv = player.inventory;
  let left = count;
  for (const list of [inv.slots, inv.offhand ? [inv.offhand] : []]) {
    if (!list) continue;
    for (let i = 0; i < list.length && left > 0; i++) {
      const s = list[i];
      if (!s || s.empty || s.item.name !== name) continue;
      const take = Math.min(left, s.count);
      s.count -= take;
      left -= take;
      if (s.count <= 0) list[i] = null;
    }
  }
  return left === 0;
}

/**
 * Execute one trade.
 *
 * @returns {{sold: ItemStack, price: number}|null} the goods, or null when the
 *   trade was unaffordable, sold out, or malformed
 */
export function trade(villager, player, offer, world = null) {
  if (!villager || !player || !offer) return null;
  if (isSoldOut(offer) || offer.disabled) return null;
  if (player.gamemode !== 1 && !canAfford(player, offer)) return null;

  const price = priceFor(offer, player);
  const w = world ?? villager.world ?? player.world;

  if (player.gamemode !== 1) {
    if (!takeItem(player, offer.buyA.item.name, price)) return null;
    if (offer.buyB) takeItem(player, offer.buyB.item.name, offer.buyB.count);
  }

  const sold = offer.sell.clone();
  if (!player.inventory?.addItem?.(sold) && w) {
    w.game?.spawnItem?.(w, player.x, player.y + 1, player.z, sold);
  }

  offer.uses++;
  offer.demand++;

  // The villager gains trading experience and may level up.
  villager.tradeXp = (villager.tradeXp ?? 0) + offer.xp;
  const newLevel = levelFor(villager.tradeXp);
  if (newLevel > (villager.villagerLevel ?? 1)) {
    villager.villagerLevel = newLevel;
    villager.builtTradeLevels = villager.builtTradeLevels ?? 0;
    tradesFor(villager);
    w?.playSound?.('villager.levelup', villager.x, villager.y, villager.z, 1, 1);
    w?.spawnParticles?.('happy_villager', villager.x, villager.y + 1.8, villager.z, 12);
  }

  // The player gets a few experience points, as long as the offer still gives
  // them (a villager stops rewarding a trade it has been forced to repeat).
  if (offer.rewardsExp && w) {
    spawnOrbs(w, villager.x, villager.y + 0.5, villager.z, 3 + w.random.int(4));
  }
  w?.playSound?.('villager.yes', villager.x, villager.y, villager.z, 1, 1);
  villager.lastTradeTick = w?.tickCount ?? 0;
  return { sold, price };
}

/**
 * Restock a villager at its workstation: every offer becomes available again
 * and accumulated demand decays by one use per restock.
 */
export function restock(villager, world = null) {
  if (!villager?.offers) return 0;
  let refreshed = 0;
  for (const offer of villager.offers) {
    if (offer.uses > 0) refreshed++;
    offer.demand = Math.max(0, offer.demand - Math.max(1, Math.floor(offer.uses / 2)));
    offer.uses = 0;
    offer.disabled = false;
    offer.rewardsExp = true;
  }
  villager.restocksToday = (villager.restocksToday ?? 0) + 1;
  villager.lastRestock = world?.tickCount ?? 0;
  world?.playSound?.('villager.work', villager.x, villager.y, villager.z, 0.6, 1);
  return refreshed;
}

/** Should this villager restock right now? Twice a working day, at its job site. */
export function shouldRestock(villager, world) {
  if (!villager?.offers?.length) return false;
  if ((villager.restocksToday ?? 0) >= MAX_RESTOCKS_PER_DAY) return false;
  const since = (world?.tickCount ?? 0) - (villager.lastRestock ?? -RESTOCK_INTERVAL);
  if (since < RESTOCK_INTERVAL) return false;
  return villager.offers.some(isSoldOut);
}

/** A new day resets the restock allowance. */
export function newDay(villager) {
  villager.restocksToday = 0;
}

/** Give an unemployed villager a profession from the workstation it claimed. */
export function assignProfession(villager, workstationBlockName) {
  const profession = WORKSTATIONS[workstationBlockName];
  if (!profession) return false;
  villager.profession = profession;
  villager.villagerLevel = villager.villagerLevel ?? 1;
  villager.tradeXp = villager.tradeXp ?? 0;
  villager.offers = null;
  villager.builtTradeLevels = 0;
  return true;
}

/** Curing a zombie villager permanently discounts everything it sells. */
export function applyCureDiscount(villager, amount = 2) {
  for (const offer of tradesFor(villager)) {
    offer.specialPrice = -Math.max(1, Math.floor(offer.buyA.count / amount));
  }
  return villager.offers;
}

/** Every enchantment a librarian could roll, for the audit script. */
export function librarianBookPool() {
  return ENCHANTMENT_LIST.filter((e) => e.tradeable).map((e) => e.id);
}
