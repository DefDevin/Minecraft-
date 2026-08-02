// Enchanting: the registry, the enchanting-table algorithm, and the anvil.
//
// Every enchantment carries the four numbers the game actually needs — max
// level, rarity weight, and the [minCost, maxCost] enchanting-power window per
// level — plus the set it cannot coexist with. Incompatibility is declared once
// as unordered pairs and expanded symmetrically, so the two halves can never
// drift apart.
//
// The table algorithm is Minecraft's: bookshelf power up to 15 produces three
// costs, each cost is jittered by the item's enchantability, and enchantments
// are drawn by weight with a diminishing chance of extra draws.

import { Random } from '../core/rng.js';
import { clamp } from '../core/math.js';
import { TOOL } from '../world/blocks.js';
import { itemsByName, ItemStack, MATERIALS, ARMOR_MATERIALS } from './items.js';

/** Rarity weights, exactly the vanilla values. */
export const RARITY = {
  COMMON: { name: 'common', weight: 10, anvilCost: 1 },
  UNCOMMON: { name: 'uncommon', weight: 5, anvilCost: 2 },
  RARE: { name: 'rare', weight: 2, anvilCost: 4 },
  VERY_RARE: { name: 'very_rare', weight: 1, anvilCost: 8 },
};

/** What an enchantment can be put on. */
export const TARGET = {
  ARMOR: 'armor',
  ARMOR_HEAD: 'armor_head',
  ARMOR_CHEST: 'armor_chest',
  ARMOR_LEGS: 'armor_legs',
  ARMOR_FEET: 'armor_feet',
  WEAPON: 'weapon',
  DIGGER: 'digger',
  FISHING_ROD: 'fishing_rod',
  TRIDENT: 'trident',
  BOW: 'bow',
  CROSSBOW: 'crossbow',
  WEARABLE: 'wearable',
  BREAKABLE: 'breakable',
  VANISHABLE: 'vanishable',
};

/** id -> Enchantment */
export const ENCHANTMENTS = Object.create(null);
/** Registration order. */
export const ENCHANTMENT_LIST = [];

let registered = false;

export class Enchantment {
  constructor(id, opts) {
    this.id = id;
    this.name = opts.name || titleCase(id);
    this.maxLevel = opts.maxLevel ?? 1;
    this.rarity = opts.rarity ?? RARITY.COMMON;
    this.weight = this.rarity.weight;
    this.target = opts.target ?? TARGET.VANISHABLE;
    this.treasure = !!opts.treasure;
    this.curse = !!opts.curse;
    /** Treasure enchantments never appear at an enchanting table. */
    this.discoverable = opts.discoverable ?? !opts.treasure;
    this.tradeable = opts.tradeable ?? true;
    this.minCost = opts.minCost || ((l) => 1 + (l - 1) * 10);
    this.maxCost = opts.maxCost || ((l) => this.minCost(l) + 50);
    /** Filled in by linkIncompatibilities(). */
    this.incompatible = new Set();
    /** Human-readable summary, handy for tooltips and the audit script. */
    this.description = opts.description || '';
  }

  /** Roman-numeral display level, blank for single-level enchantments. */
  levelName(level) {
    if (this.maxLevel === 1) return this.name;
    return `${this.name} ${ROMAN[level] ?? level}`;
  }

  /** Can this go on the given item (ignoring what is already on it)? */
  canEnchant(item) {
    if (!item) return false;
    if (item.name === 'enchanted_book' || item.name === 'book') return true;
    return targetAccepts(this.target, item);
  }

  /** Is `other` allowed alongside this one? */
  compatibleWith(other) {
    const id = typeof other === 'string' ? other : other.id;
    return id !== this.id && !this.incompatible.has(id);
  }
}

const ROMAN = [null, 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

function titleCase(s) {
  return s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

const DIGGERS = new Set([TOOL.PICKAXE, TOOL.AXE, TOOL.SHOVEL, TOOL.HOE]);

/** Does `item` fall into the given target category? */
export function targetAccepts(target, item) {
  if (!item) return false;
  switch (target) {
    case TARGET.ARMOR: return item.armorSlot != null;
    case TARGET.ARMOR_HEAD: return item.armorSlot === 0;
    case TARGET.ARMOR_CHEST: return item.armorSlot === 1;
    case TARGET.ARMOR_LEGS: return item.armorSlot === 2;
    case TARGET.ARMOR_FEET: return item.armorSlot === 3;
    case TARGET.WEAPON: return item.tool === TOOL.SWORD;
    case TARGET.DIGGER: return DIGGERS.has(item.tool);
    case TARGET.FISHING_ROD: return item.name === 'fishing_rod';
    case TARGET.TRIDENT: return item.name === 'trident';
    case TARGET.BOW: return item.name === 'bow';
    case TARGET.CROSSBOW: return item.name === 'crossbow';
    case TARGET.WEARABLE:
      return item.armorSlot != null || WEARABLES.has(item.name);
    case TARGET.BREAKABLE: return (item.maxDamage ?? 0) > 0;
    default: return true;
  }
}

const WEARABLES = new Set([
  'elytra', 'carved_pumpkin', 'skeleton_skull', 'wither_skeleton_skull',
  'zombie_head', 'player_head', 'creeper_head', 'dragon_head', 'turtle_helmet',
]);

export function defineEnchantment(id, opts) {
  if (ENCHANTMENTS[id]) return ENCHANTMENTS[id];
  const e = new Enchantment(id, opts);
  ENCHANTMENTS[id] = e;
  ENCHANTMENT_LIST.push(e);
  return e;
}

export function getEnchantment(id) { return ENCHANTMENTS[id] || null; }

/**
 * Mutually exclusive groups. Declaring them as groups rather than per-side
 * lists is what makes `incompatible` symmetric by construction.
 */
export const EXCLUSIVE_GROUPS = [
  ['protection', 'fire_protection', 'blast_protection', 'projectile_protection'],
  ['sharpness', 'smite', 'bane_of_arthropods'],
  ['depth_strider', 'frost_walker'],
  ['silk_touch', 'fortune'],
  ['infinity', 'mending'],
  ['riptide', 'loyalty'],
  ['riptide', 'channeling'],
  ['multishot', 'piercing'],
];

function linkIncompatibilities() {
  for (const group of EXCLUSIVE_GROUPS) {
    for (const a of group) {
      for (const b of group) {
        if (a === b) continue;
        ENCHANTMENTS[a]?.incompatible.add(b);
        ENCHANTMENTS[b]?.incompatible.add(a);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** Register every enchantment. Idempotent. */
export function registerAllEnchantments() {
  if (registered) return ENCHANTMENT_LIST;
  registered = true;

  const step = (start, per) => (l) => start + (l - 1) * per;
  const window = (start, per, width) => ({
    minCost: step(start, per),
    maxCost: (l) => start + (l - 1) * per + width,
  });

  // -- Armour -------------------------------------------------------------
  defineEnchantment('protection', {
    maxLevel: 4, rarity: RARITY.COMMON, target: TARGET.ARMOR,
    ...window(1, 11, 11),
    description: 'Reduces most damage; 1 EPF per level.',
  });
  defineEnchantment('fire_protection', {
    maxLevel: 4, rarity: RARITY.UNCOMMON, target: TARGET.ARMOR,
    ...window(10, 8, 8),
    description: 'Reduces fire damage and burn time; 2 EPF per level.',
  });
  defineEnchantment('feather_falling', {
    maxLevel: 4, rarity: RARITY.UNCOMMON, target: TARGET.ARMOR_FEET,
    ...window(5, 6, 6),
    description: 'Reduces fall damage; 3 EPF per level.',
  });
  defineEnchantment('blast_protection', {
    maxLevel: 4, rarity: RARITY.RARE, target: TARGET.ARMOR,
    ...window(5, 8, 8),
    description: 'Reduces explosion damage and knockback; 2 EPF per level.',
  });
  defineEnchantment('projectile_protection', {
    maxLevel: 4, rarity: RARITY.UNCOMMON, target: TARGET.ARMOR,
    ...window(3, 6, 6),
    description: 'Reduces projectile damage; 2 EPF per level.',
  });
  defineEnchantment('respiration', {
    maxLevel: 3, rarity: RARITY.RARE, target: TARGET.ARMOR_HEAD,
    minCost: (l) => 10 * l, maxCost: (l) => 10 * l + 30,
    description: 'Extends underwater breathing time.',
  });
  defineEnchantment('aqua_affinity', {
    maxLevel: 1, rarity: RARITY.RARE, target: TARGET.ARMOR_HEAD,
    minCost: () => 1, maxCost: () => 41,
    description: 'Removes the underwater mining penalty.',
  });
  defineEnchantment('thorns', {
    maxLevel: 3, rarity: RARITY.VERY_RARE, target: TARGET.ARMOR,
    minCost: (l) => 10 + 20 * (l - 1), maxCost: (l) => 10 + 20 * (l - 1) + 50,
    description: 'Reflects damage onto attackers.',
  });
  defineEnchantment('depth_strider', {
    maxLevel: 3, rarity: RARITY.RARE, target: TARGET.ARMOR_FEET,
    minCost: (l) => 10 * l, maxCost: (l) => 10 * l + 15,
    description: 'Reduces the underwater movement penalty.',
  });
  defineEnchantment('frost_walker', {
    maxLevel: 2, rarity: RARITY.RARE, target: TARGET.ARMOR_FEET, treasure: true,
    minCost: (l) => 10 * l, maxCost: (l) => 10 * l + 15,
    description: 'Freezes water into frosted ice as you walk.',
  });
  defineEnchantment('soul_speed', {
    maxLevel: 3, rarity: RARITY.VERY_RARE, target: TARGET.ARMOR_FEET, treasure: true,
    minCost: (l) => 10 * l, maxCost: (l) => 10 * l + 15,
    description: 'Move faster on soul sand and soul soil.',
  });
  defineEnchantment('curse_of_binding', {
    maxLevel: 1, rarity: RARITY.VERY_RARE, target: TARGET.WEARABLE,
    treasure: true, curse: true,
    minCost: () => 25, maxCost: () => 50,
    description: 'The item cannot be removed once worn.',
  });

  // -- Swords -------------------------------------------------------------
  defineEnchantment('sharpness', {
    maxLevel: 5, rarity: RARITY.COMMON, target: TARGET.WEAPON,
    minCost: (l) => 1 + (l - 1) * 11, maxCost: (l) => 1 + (l - 1) * 11 + 20,
    description: '+0.5 damage per level above the first, +1 for level one.',
  });
  defineEnchantment('smite', {
    maxLevel: 5, rarity: RARITY.UNCOMMON, target: TARGET.WEAPON,
    minCost: (l) => 5 + (l - 1) * 8, maxCost: (l) => 5 + (l - 1) * 8 + 20,
    description: '+2.5 damage per level against undead.',
  });
  defineEnchantment('bane_of_arthropods', {
    maxLevel: 5, rarity: RARITY.UNCOMMON, target: TARGET.WEAPON,
    minCost: (l) => 5 + (l - 1) * 8, maxCost: (l) => 5 + (l - 1) * 8 + 20,
    description: '+2.5 damage per level against arthropods, plus slowness.',
  });
  defineEnchantment('knockback', {
    maxLevel: 2, rarity: RARITY.UNCOMMON, target: TARGET.WEAPON,
    minCost: (l) => 5 + (l - 1) * 20, maxCost: (l) => 5 + (l - 1) * 20 + 50,
    description: 'Extra knockback of 0.5 blocks-per-tick per level.',
  });
  defineEnchantment('fire_aspect', {
    maxLevel: 2, rarity: RARITY.RARE, target: TARGET.WEAPON,
    minCost: (l) => 10 + (l - 1) * 20, maxCost: (l) => 10 + (l - 1) * 20 + 50,
    description: 'Sets targets alight for four seconds per level.',
  });
  defineEnchantment('looting', {
    maxLevel: 3, rarity: RARITY.RARE, target: TARGET.WEAPON,
    minCost: (l) => 15 + (l - 1) * 9, maxCost: (l) => 15 + (l - 1) * 9 + 50,
    description: 'More mob drops and a better rare-drop chance.',
  });
  defineEnchantment('sweeping_edge', {
    maxLevel: 3, rarity: RARITY.RARE, target: TARGET.WEAPON,
    minCost: (l) => 5 + (l - 1) * 9, maxCost: (l) => 5 + (l - 1) * 9 + 15,
    description: 'Sweep attacks carry level/(level+1) of the hit damage.',
  });

  // -- Tools --------------------------------------------------------------
  defineEnchantment('efficiency', {
    maxLevel: 5, rarity: RARITY.COMMON, target: TARGET.DIGGER,
    minCost: (l) => 1 + 10 * (l - 1), maxCost: (l) => 1 + 10 * (l - 1) + 50,
    description: 'Mining speed bonus of level² + 1.',
  });
  defineEnchantment('silk_touch', {
    maxLevel: 1, rarity: RARITY.VERY_RARE, target: TARGET.DIGGER,
    minCost: () => 15, maxCost: () => 65,
    description: 'Blocks drop themselves rather than their usual loot.',
  });
  defineEnchantment('unbreaking', {
    maxLevel: 3, rarity: RARITY.UNCOMMON, target: TARGET.BREAKABLE,
    minCost: (l) => 5 + (l - 1) * 8, maxCost: (l) => 5 + (l - 1) * 8 + 50,
    description: 'Each durability point has a 1/(level+1) chance to be spent.',
  });
  defineEnchantment('fortune', {
    maxLevel: 3, rarity: RARITY.RARE, target: TARGET.DIGGER,
    minCost: (l) => 15 + (l - 1) * 9, maxCost: (l) => 15 + (l - 1) * 9 + 50,
    description: 'More drops from ores and crops.',
  });
  defineEnchantment('mending', {
    maxLevel: 1, rarity: RARITY.RARE, target: TARGET.BREAKABLE, treasure: true,
    minCost: (l) => l * 25, maxCost: (l) => l * 25 + 50,
    description: 'Experience repairs the item at two durability per point.',
  });
  defineEnchantment('curse_of_vanishing', {
    maxLevel: 1, rarity: RARITY.VERY_RARE, target: TARGET.VANISHABLE,
    treasure: true, curse: true,
    minCost: () => 25, maxCost: () => 50,
    description: 'The item is destroyed on death.',
  });

  // -- Bows ---------------------------------------------------------------
  defineEnchantment('power', {
    maxLevel: 5, rarity: RARITY.COMMON, target: TARGET.BOW,
    minCost: (l) => 1 + (l - 1) * 10, maxCost: (l) => 1 + (l - 1) * 10 + 15,
    description: 'Arrow damage +25% per level, plus 25%.',
  });
  defineEnchantment('punch', {
    maxLevel: 2, rarity: RARITY.RARE, target: TARGET.BOW,
    minCost: (l) => 12 + (l - 1) * 20, maxCost: (l) => 12 + (l - 1) * 20 + 25,
    description: 'Arrows knock targets back further.',
  });
  defineEnchantment('flame', {
    maxLevel: 1, rarity: RARITY.RARE, target: TARGET.BOW,
    minCost: () => 20, maxCost: () => 50,
    description: 'Arrows are ignited and set targets on fire.',
  });
  defineEnchantment('infinity', {
    maxLevel: 1, rarity: RARITY.VERY_RARE, target: TARGET.BOW, treasure: true,
    minCost: () => 20, maxCost: () => 50,
    description: 'Shooting costs no arrows as long as one is carried.',
  });

  // -- Fishing ------------------------------------------------------------
  defineEnchantment('luck_of_the_sea', {
    maxLevel: 3, rarity: RARITY.RARE, target: TARGET.FISHING_ROD,
    minCost: (l) => 15 + (l - 1) * 9, maxCost: (l) => 15 + (l - 1) * 9 + 50,
    description: 'Better loot from fishing.',
  });
  defineEnchantment('lure', {
    maxLevel: 3, rarity: RARITY.RARE, target: TARGET.FISHING_ROD,
    minCost: (l) => 15 + (l - 1) * 9, maxCost: (l) => 15 + (l - 1) * 9 + 50,
    description: 'Fish bite five seconds sooner per level.',
  });

  // -- Tridents -----------------------------------------------------------
  defineEnchantment('loyalty', {
    maxLevel: 3, rarity: RARITY.UNCOMMON, target: TARGET.TRIDENT,
    minCost: (l) => 5 + l * 7, maxCost: () => 50,
    description: 'The trident returns to the thrower.',
  });
  defineEnchantment('impaling', {
    maxLevel: 5, rarity: RARITY.RARE, target: TARGET.TRIDENT,
    minCost: (l) => 1 + (l - 1) * 8, maxCost: (l) => 1 + (l - 1) * 8 + 20,
    description: '+2.5 damage per level against aquatic mobs.',
  });
  defineEnchantment('riptide', {
    maxLevel: 3, rarity: RARITY.RARE, target: TARGET.TRIDENT,
    minCost: (l) => 10 + l * 7, maxCost: () => 50,
    description: 'Launches the thrower when wet.',
  });
  defineEnchantment('channeling', {
    maxLevel: 1, rarity: RARITY.VERY_RARE, target: TARGET.TRIDENT,
    minCost: () => 25, maxCost: () => 50,
    description: 'Summons lightning onto the target during a thunderstorm.',
  });

  // -- Crossbows ----------------------------------------------------------
  defineEnchantment('multishot', {
    maxLevel: 1, rarity: RARITY.RARE, target: TARGET.CROSSBOW,
    minCost: () => 20, maxCost: () => 50,
    description: 'Fires three arrows for the price of one.',
  });
  defineEnchantment('quick_charge', {
    maxLevel: 3, rarity: RARITY.UNCOMMON, target: TARGET.CROSSBOW,
    minCost: (l) => 12 + (l - 1) * 20, maxCost: () => 50,
    description: 'Reloads 0.25 seconds faster per level.',
  });
  defineEnchantment('piercing', {
    maxLevel: 4, rarity: RARITY.COMMON, target: TARGET.CROSSBOW,
    minCost: (l) => 1 + (l - 1) * 10, maxCost: () => 50,
    description: 'Bolts pass through one extra target per level.',
  });

  linkIncompatibilities();
  return ENCHANTMENT_LIST;
}

// ---------------------------------------------------------------------------
// Applying enchantments
// ---------------------------------------------------------------------------

/**
 * Put an enchantment on a stack, respecting max level and the incompatible
 * set. `force` skips the item-category check (used by creative and commands).
 * @returns true when the stack changed.
 */
export function applyEnchantment(stack, id, level = 1, opts = {}) {
  const ench = ENCHANTMENTS[id];
  if (!stack || stack.empty || !ench) return false;
  const lvl = clamp(Math.floor(level), 1, opts.allowOverLevel ? 255 : ench.maxLevel);
  if (!opts.force && !ench.canEnchant(stack.item)) return false;
  if (!opts.force && !canCoexist(stack, id)) return false;
  if (stack.getEnchantLevel(id) >= lvl) return false;
  stack.addEnchantment(id, lvl);
  return true;
}

/** Does `id` conflict with anything already on the stack? */
export function canCoexist(stack, id) {
  const ench = ENCHANTMENTS[id];
  if (!ench) return false;
  const existing = stack?.tag?.enchantments;
  if (!existing) return true;
  for (const other of Object.keys(existing)) {
    if (other === id) continue;
    if (!ench.compatibleWith(other)) return false;
  }
  return true;
}

/** Every enchantment on a stack, as `[{enchantment, level}]`. */
export function enchantmentsOn(stack) {
  const map = stack?.tag?.enchantments;
  if (!map) return [];
  const out = [];
  for (const [id, level] of Object.entries(map)) {
    const e = ENCHANTMENTS[id];
    if (e) out.push({ enchantment: e, id, level });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The enchanting table
// ---------------------------------------------------------------------------

/** Bookshelf power tops out at 15 shelves, the classic full ring plus one. */
export const MAX_BOOKSHELVES = 15;

/**
 * The three offers an enchanting table shows for `stack`.
 *
 * Reproduces `EnchantmentMenu.slotsChanged`: a single base roll produces the
 * three level costs, then each slot rolls its own enchantment list from the
 * player's enchantment seed offset by the slot index — which is why the offers
 * only change when the seed does.
 *
 * @param {ItemStack} stack the item on the table
 * @param {number} bookshelves how many powered bookshelves surround it
 * @param {number} seed the player's enchantment seed
 * @returns {Array<null|{slot, cost, level, enchantments, preview, label}>}
 */
export function enchantmentOffers(stack, bookshelves = 0, seed = 0) {
  const offers = [null, null, null];
  if (!stack || stack.empty) return offers;
  const enchantability = stack.item.enchantability ?? 0;
  if (enchantability <= 0 && stack.item.name !== 'book') return offers;

  const power = clamp(Math.floor(bookshelves), 0, MAX_BOOKSHELVES);
  const base = new Random(seed);
  const roll = base.int(8) + 1 + (power >> 1) + base.int(power + 1);
  const costs = [
    Math.max(Math.floor(roll / 3), 1),
    Math.floor((roll * 2) / 3) + 1,
    Math.max(roll, power * 2),
  ];

  for (let slot = 0; slot < 3; slot++) {
    let cost = costs[slot];
    // A slot whose cost is below its own level requirement stays empty.
    if (cost < slot + 1) { offers[slot] = null; continue; }
    const list = selectEnchantments(new Random((seed + slot) | 0), stack, cost, false);
    if (list.length === 0) { offers[slot] = null; continue; }
    const preview = list[0];
    offers[slot] = {
      slot,
      cost,                       // levels the player pays and needs
      level: cost,
      enchantments: list,
      preview,
      label: preview ? ENCHANTMENTS[preview.id].levelName(preview.level) : '',
    };
  }
  return offers;
}

/**
 * Roll the enchantment list for one offer.
 * Mirrors `EnchantmentHelper.selectEnchantment`.
 */
export function selectEnchantments(random, stack, cost, allowTreasure = false) {
  const enchantability = stack?.item?.enchantability ?? 0;
  if (enchantability <= 0) return [];

  const quarter = Math.floor(enchantability / 4) + 1;
  let level = cost + 1 + random.int(quarter) + random.int(quarter);
  const jitter = (random.next() + random.next() - 1) * 0.15;
  level = clamp(Math.round(level + level * jitter), 1, Number.MAX_SAFE_INTEGER);

  let pool = availableEnchantments(level, stack, allowTreasure);
  const chosen = [];
  if (pool.length === 0) return chosen;

  chosen.push(weightedPick(random, pool));
  while (random.int(50) <= level) {
    const last = chosen[chosen.length - 1];
    pool = pool.filter((c) => c.id !== last.id &&
      ENCHANTMENTS[last.id].compatibleWith(c.id) &&
      chosen.every((k) => ENCHANTMENTS[k.id].compatibleWith(c.id)));
    if (pool.length === 0) break;
    chosen.push(weightedPick(random, pool));
    level = Math.floor(level / 2);
  }
  return chosen;
}

/** Every (enchantment, level) whose cost window contains `level`. */
export function availableEnchantments(level, stack, allowTreasure = false) {
  const item = stack?.item;
  const isBook = item?.name === 'book' || item?.name === 'enchanted_book';
  const out = [];
  for (const e of ENCHANTMENT_LIST) {
    if (e.treasure && !allowTreasure) continue;
    if (!e.discoverable && !allowTreasure) continue;
    if (!isBook && !e.canEnchant(item)) continue;
    for (let l = e.maxLevel; l >= 1; l--) {
      if (level >= e.minCost(l) && level <= e.maxCost(l)) {
        out.push({ id: e.id, enchantment: e, level: l, weight: e.weight });
        break;
      }
    }
  }
  return out;
}

function weightedPick(random, pool) {
  let total = 0;
  for (const c of pool) total += c.weight;
  let r = random.int(Math.max(1, total));
  for (const c of pool) {
    r -= c.weight;
    if (r < 0) return c;
  }
  return pool[pool.length - 1];
}

/**
 * Enchant a stack as though it came off the table (or out of loot) with an
 * effective level of `levels`.
 */
export function enchantWithLevels(stack, levels, random = new Random(0), allowTreasure = false) {
  const list = selectEnchantments(random, stack, levels, allowTreasure);
  const isBook = stack.item.name === 'book';
  let target = stack;
  if (isBook && itemsByName.has('enchanted_book')) {
    target = new ItemStack('enchanted_book', 1);
  }
  for (const c of list) applyEnchantment(target, c.id, c.level, { force: true });
  return target;
}

/** Take the enchanting-table offer in `slot`, paying its cost. */
export function applyOffer(stack, offer, player, experience) {
  if (!offer) return false;
  if (player && experience && !experience.spendXp(player, offer.cost)) return false;
  for (const c of offer.enchantments) applyEnchantment(stack, c.id, c.level, { force: true });
  return true;
}

// ---------------------------------------------------------------------------
// The anvil
// ---------------------------------------------------------------------------

/** Anvils refuse anything costing this many levels or more (outside creative). */
export const ANVIL_LEVEL_LIMIT = 40;

/** Prior-work penalty stored on the stack; doubles with every use. */
export function repairCostOf(stack) { return stack?.tag?.repairCost ?? 0; }

export function setRepairCost(stack, cost) {
  if (!stack.tag) stack.tag = {};
  stack.tag.repairCost = cost;
  return stack;
}

/** The next prior-work penalty: 2n + 1. */
export function increasedRepairCost(cost) { return cost * 2 + 1; }

/** The item name a material must have to repair `stack` by hand. */
export function repairMaterialFor(item) {
  if (!item) return null;
  if (item.repairWith) return item.repairWith;
  if (item.material && MATERIALS[item.material]) return MATERIALS[item.material].repair;
  if (item.material && ARMOR_MATERIALS[item.material]) return ARMOR_MATERIALS[item.material].repair;
  return null;
}

/**
 * Combine two stacks on an anvil.
 *
 * Reproduces `AnvilMenu.createResult`, including the three ways an anvil can be
 * used — repair with material, repair/merge with a like item or book, and
 * rename — and the level costs each one adds.
 *
 * @param {ItemStack} a the left slot (the item being worked on)
 * @param {ItemStack|null} b the right slot (material, like item, or book)
 * @param {string|null} name a new name, or null/'' to leave it alone
 * @returns {{result: ItemStack, cost: number, materialCost: number,
 *            tooExpensive: boolean}|null}
 */
export function anvilCombine(a, b, name = null) {
  if (!a || a.empty) return null;

  const result = a.clone();
  let cost = 0;
  let materialCost = 0;
  const priorWork = repairCostOf(a) + (b && !b.empty ? repairCostOf(b) : 0);

  let didSomething = false;

  if (b && !b.empty) {
    const isBook = b.item.name === 'enchanted_book' && enchantmentsOn(b).length > 0;
    const material = repairMaterialFor(a.item);

    if (!isBook && material && b.item.name === material &&
      a.item.maxDamage > 0 && a.damage > 0) {
      // -- Repair with raw material: each unit mends a quarter of the bar.
      let unit = Math.min(result.damage, Math.floor(a.item.maxDamage / 4));
      if (unit <= 0) return null;
      let used = 0;
      while (unit > 0 && used < b.count) {
        result.damage = Math.max(0, result.damage - unit);
        cost++;
        used++;
        unit = Math.min(result.damage, Math.floor(a.item.maxDamage / 4));
      }
      materialCost = used;
      didSomething = used > 0;
    } else {
      if (!isBook && (a.item !== b.item || a.item.maxDamage <= 0)) {
        // Two unlike, non-book items cannot be combined at all.
        if (!name) return null;
      } else {
        // -- Repair by sacrificing a like item.
        if (a.item.maxDamage > 0 && !isBook) {
          const remainingA = a.item.maxDamage - a.damage;
          const remainingB = b.item.maxDamage - b.damage;
          const bonus = remainingB + Math.floor((a.item.maxDamage * 12) / 100);
          const combined = remainingA + bonus;
          let newDamage = a.item.maxDamage - combined;
          if (newDamage < 0) newDamage = 0;
          if (newDamage < result.damage) {
            result.damage = newDamage;
            cost += 2;
            didSomething = true;
          }
        }

        // -- Merge enchantments.
        const target = enchantmentsOn(a);
        let anyApplied = false;
        let anyRejected = false;
        for (const { id, level } of enchantmentsOn(b)) {
          const ench = ENCHANTMENTS[id];
          const own = result.getEnchantLevel(id);
          let merged = own === level ? level + 1 : Math.max(level, own);
          let allowed = ench.canEnchant(a.item) || a.item.name === 'enchanted_book';
          for (const other of target) {
            if (other.id === id) continue;
            if (!ench.compatibleWith(other.id)) { allowed = false; cost++; }
          }
          if (!allowed) { anyRejected = true; continue; }
          anyApplied = true;
          if (merged > ench.maxLevel) merged = ench.maxLevel;
          if (merged > own) {
            result.addEnchantment(id, merged);
            didSomething = true;
          }
          let per = ench.rarity.anvilCost;
          if (isBook) per = Math.max(1, Math.floor(per / 2));
          cost += per * merged;
          if (a.count > 1) cost = ANVIL_LEVEL_LIMIT;
        }
        if (anyRejected && !anyApplied && !didSomething && !name) return null;
      }
    }
  }

  // -- Rename ---------------------------------------------------------------
  const currentName = a.tag?.name ?? null;
  if (name != null && name !== '') {
    if (name !== (currentName ?? a.item.displayName)) {
      cost += 1;
      if (!result.tag) result.tag = {};
      result.tag.name = name;
      didSomething = true;
    }
  } else if (name === '' && currentName) {
    cost += 1;
    delete result.tag.name;
    didSomething = true;
  }

  if (!didSomething) return null;

  const total = cost + priorWork;
  // The output's own prior-work penalty is the larger input's, doubled.
  setRepairCost(result, increasedRepairCost(
    Math.max(repairCostOf(a), b && !b.empty ? repairCostOf(b) : 0)));

  return {
    result,
    cost: total,
    materialCost,
    tooExpensive: total >= ANVIL_LEVEL_LIMIT,
  };
}

// ---------------------------------------------------------------------------
// Effect hooks — the numbers combat, mining and movement read
// ---------------------------------------------------------------------------

/** Enchantment protection factor for one armour piece against a damage source. */
export function protectionOf(stack, source) {
  if (!stack || stack.empty) return 0;
  let epf = 0;
  epf += stack.getEnchantLevel('protection') * 1;
  if (isFireSource(source)) epf += stack.getEnchantLevel('fire_protection') * 2;
  if (source === 'fall') epf += stack.getEnchantLevel('feather_falling') * 3;
  if (source === 'explosion') epf += stack.getEnchantLevel('blast_protection') * 2;
  if (isProjectileSource(source)) epf += stack.getEnchantLevel('projectile_protection') * 2;
  return epf;
}

const FIRE_SOURCES = new Set(['fire', 'lava', 'in_fire', 'on_fire', 'hot_floor', 'campfire']);
const PROJECTILE_SOURCES = new Set(['arrow', 'projectile', 'trident', 'fireball', 'thrown']);

export function isFireSource(s) { return FIRE_SOURCES.has(s); }
export function isProjectileSource(s) { return PROJECTILE_SOURCES.has(s); }

/**
 * Total EPF across a set of armour pieces, capped at 20 — which is the 80%
 * reduction ceiling the real game enforces.
 */
export function totalProtection(stacks, source) {
  let epf = 0;
  for (const s of stacks) epf += protectionOf(s, source);
  return clamp(epf, 0, 20);
}

/** Damage remaining after enchantment protection. */
export function applyProtection(damage, stacks, source) {
  return damage * (1 - totalProtection(stacks, source) * 0.04);
}

/** Extra melee damage from sharpness/smite/bane/impaling. */
export function damageBonus(stack, tags = null) {
  if (!stack || stack.empty) return 0;
  let d = 0;
  const sharp = stack.getEnchantLevel('sharpness');
  if (sharp > 0) d += 0.5 * sharp + 0.5;
  if (tags) {
    const smite = stack.getEnchantLevel('smite');
    if (smite > 0 && tags.has('undead')) d += 2.5 * smite;
    const bane = stack.getEnchantLevel('bane_of_arthropods');
    if (bane > 0 && tags.has('arthropod')) d += 2.5 * bane;
    const impaling = stack.getEnchantLevel('impaling');
    if (impaling > 0 && tags.has('aquatic')) d += 2.5 * impaling;
  }
  return d;
}

/** Sweeping edge carries level/(level+1) of the main hit into the sweep. */
export function sweepingRatio(stack) {
  const l = stack?.getEnchantLevel?.('sweeping_edge') ?? 0;
  return l > 0 ? l / (l + 1) : 0;
}

/** Fire aspect burn time in ticks (four seconds per level). */
export function fireAspectTicks(stack) {
  return (stack?.getEnchantLevel?.('fire_aspect') ?? 0) * 80;
}

export function knockbackBonus(stack) {
  return (stack?.getEnchantLevel?.('knockback') ?? 0) * 0.5;
}

export function lootingLevel(stack) { return stack?.getEnchantLevel?.('looting') ?? 0; }
export function fortuneLevel(stack) { return stack?.getEnchantLevel?.('fortune') ?? 0; }
export function hasSilkTouch(stack) { return (stack?.getEnchantLevel?.('silk_touch') ?? 0) > 0; }

/** Efficiency adds level² + 1 to mining speed on the correct tool. */
export function efficiencyBonus(stack) {
  const l = stack?.getEnchantLevel?.('efficiency') ?? 0;
  return l > 0 ? l * l + 1 : 0;
}

/** Chance that a durability point is actually spent. */
export function unbreakingChance(stack, isArmor = false) {
  const l = stack?.getEnchantLevel?.('unbreaking') ?? 0;
  if (l <= 0) return 1;
  // Armour only rolls unbreaking 60% of the time in the real game.
  if (isArmor) return 0.6 + 0.4 / (l + 1);
  return 1 / (l + 1);
}

/** Arrow damage bonus: 25% per level plus a flat 25%. */
export function powerBonus(stack, base) {
  const l = stack?.getEnchantLevel?.('power') ?? 0;
  return l > 0 ? base * (0.25 * (l + 1)) : 0;
}

export function punchKnockback(stack) { return stack?.getEnchantLevel?.('punch') ?? 0; }
export function hasFlame(stack) { return (stack?.getEnchantLevel?.('flame') ?? 0) > 0; }
export function hasInfinity(stack) { return (stack?.getEnchantLevel?.('infinity') ?? 0) > 0; }
export function hasChanneling(stack) { return (stack?.getEnchantLevel?.('channeling') ?? 0) > 0; }
export function hasMultishot(stack) { return (stack?.getEnchantLevel?.('multishot') ?? 0) > 0; }
export function piercingLevel(stack) { return stack?.getEnchantLevel?.('piercing') ?? 0; }
export function loyaltyLevel(stack) { return stack?.getEnchantLevel?.('loyalty') ?? 0; }
export function riptideLevel(stack) { return stack?.getEnchantLevel?.('riptide') ?? 0; }

/** Crossbow reload time: 25 ticks, a quarter second faster per level. */
export function quickChargeTicks(stack) {
  const l = stack?.getEnchantLevel?.('quick_charge') ?? 0;
  return Math.max(0, 25 - 5 * l);
}

/** Thorns: 15% chance per level to reflect 1..4 damage. */
export function thornsDamage(stack, random) {
  const l = stack?.getEnchantLevel?.('thorns') ?? 0;
  if (l <= 0) return 0;
  const roll = random ? random.next() : Math.random();
  if (roll >= l * 0.15) return 0;
  if (l > 10) return l - 10;
  return 1 + (random ? random.int(4) : 0);
}

/** Depth strider removes a third of the water drag per level. */
export function depthStriderFactor(stack) {
  return clamp((stack?.getEnchantLevel?.('depth_strider') ?? 0) / 3, 0, 1);
}

/** Frost walker freezes a radius of level + 2 blocks. */
export function frostWalkerRadius(stack) {
  const l = stack?.getEnchantLevel?.('frost_walker') ?? 0;
  return l > 0 ? Math.min(16, l + 2) : 0;
}

export function soulSpeedBonus(stack) {
  const l = stack?.getEnchantLevel?.('soul_speed') ?? 0;
  return l > 0 ? 0.03 * (l * 0.35 + 1.3) : 0;
}

/** Respiration: 1/(level+1) chance of losing air each tick underwater. */
export function respirationLevel(stack) { return stack?.getEnchantLevel?.('respiration') ?? 0; }
export function hasAquaAffinity(stack) { return (stack?.getEnchantLevel?.('aqua_affinity') ?? 0) > 0; }
export function hasMending(stack) { return (stack?.getEnchantLevel?.('mending') ?? 0) > 0; }
export function hasBindingCurse(stack) { return (stack?.getEnchantLevel?.('curse_of_binding') ?? 0) > 0; }
export function hasVanishingCurse(stack) { return (stack?.getEnchantLevel?.('curse_of_vanishing') ?? 0) > 0; }

/** Fishing: lure shortens the wait, luck of the sea improves the loot table. */
export function lureLevel(stack) { return stack?.getEnchantLevel?.('lure') ?? 0; }
export function luckOfTheSeaLevel(stack) { return stack?.getEnchantLevel?.('luck_of_the_sea') ?? 0; }
