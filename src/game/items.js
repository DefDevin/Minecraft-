// Item registry and stacks.
//
// Every placeable block also has an item form; tools, armour, food and
// materials are items only. An `ItemStack` is a small mutable record — id,
// count, damage and an optional tag object for enchantments, custom names and
// container contents.

import { blocksByName, TOOL, TIER } from '../world/blocks.js';

export const items = [];
export const itemsByName = new Map();

/** Equipment slots an armour item can occupy. */
export const SLOT = { HEAD: 0, CHEST: 1, LEGS: 2, FEET: 3, MAIN: 4, OFF: 5 };

/** Rarity affects the colour of the item name in tooltips. */
export const RARITY = { COMMON: 0, UNCOMMON: 1, RARE: 2, EPIC: 3 };

/** Tool material stats, matching Minecraft's values. */
export const MATERIALS = {
  wood: { tier: TIER.WOOD, durability: 59, speed: 2, damage: 0, enchantability: 15, repair: 'oak_planks' },
  stone: { tier: TIER.STONE, durability: 131, speed: 4, damage: 1, enchantability: 5, repair: 'cobblestone' },
  iron: { tier: TIER.IRON, durability: 250, speed: 6, damage: 2, enchantability: 14, repair: 'iron_ingot' },
  gold: { tier: TIER.GOLD, durability: 32, speed: 12, damage: 0, enchantability: 22, repair: 'gold_ingot' },
  diamond: { tier: TIER.DIAMOND, durability: 1561, speed: 8, damage: 3, enchantability: 10, repair: 'diamond' },
  netherite: { tier: TIER.NETHERITE, durability: 2031, speed: 9, damage: 4, enchantability: 15, repair: 'netherite_ingot' },
};

/** Armour material stats: [helmet, chestplate, leggings, boots] defence points. */
export const ARMOR_MATERIALS = {
  leather: { durability: [55, 80, 75, 65], defense: [1, 3, 2, 1], toughness: 0, knockbackResistance: 0, enchantability: 15, repair: 'leather' },
  chainmail: { durability: [165, 240, 225, 195], defense: [2, 5, 4, 1], toughness: 0, knockbackResistance: 0, enchantability: 12, repair: 'iron_ingot' },
  iron: { durability: [165, 240, 225, 195], defense: [2, 6, 5, 2], toughness: 0, knockbackResistance: 0, enchantability: 9, repair: 'iron_ingot' },
  gold: { durability: [77, 112, 105, 91], defense: [2, 5, 3, 1], toughness: 0, knockbackResistance: 0, enchantability: 25, repair: 'gold_ingot' },
  diamond: { durability: [363, 528, 495, 429], defense: [3, 8, 6, 3], toughness: 2, knockbackResistance: 0, enchantability: 10, repair: 'diamond' },
  netherite: { durability: [407, 592, 555, 481], defense: [3, 8, 6, 3], toughness: 3, knockbackResistance: 0.1, enchantability: 15, repair: 'netherite_ingot' },
};

export class Item {
  constructor(name, opts = {}) {
    this.name = name;
    this.displayName = opts.displayName || titleCase(name);
    this.index = items.length;
    this.maxStack = opts.maxStack ?? 64;
    this.maxDamage = opts.maxDamage ?? 0;
    this.block = opts.block ?? null;         // block name this places
    this.tool = opts.tool ?? null;           // TOOL.*
    this.tier = opts.tier ?? TIER.HAND;
    this.material = opts.material ?? null;
    this.miningSpeed = opts.miningSpeed ?? 1;
    this.attackDamage = opts.attackDamage ?? 1;
    this.attackSpeed = opts.attackSpeed ?? 4;
    this.armorSlot = opts.armorSlot ?? null;
    this.defense = opts.defense ?? 0;
    this.toughness = opts.toughness ?? 0;
    this.knockbackResistance = opts.knockbackResistance ?? 0;
    this.food = opts.food ?? null;           // {hunger, saturation, eatTime, effects, alwaysEdible}
    this.fuelTicks = opts.fuelTicks ?? 0;
    this.enchantability = opts.enchantability ?? 0;
    this.rarity = opts.rarity ?? RARITY.COMMON;
    this.texture = opts.texture ?? name;
    this.render3d = opts.render3d ?? (this.block != null);  // held as a block model
    this.handheld = opts.handheld ?? (this.tool != null);   // angled tool pose
    this.creativeTab = opts.creativeTab ?? (this.block ? 'building' : 'materials');
    this.repairWith = opts.repairWith ?? null;
    this.onUse = opts.onUse ?? null;          // (world, player, stack, hit) => bool
    this.onUseOnBlock = opts.onUseOnBlock ?? null;
    this.onAttack = opts.onAttack ?? null;
    this.onCrafted = opts.onCrafted ?? null;
    this.tooltip = opts.tooltip ?? null;
    this.glint = opts.glint ?? false;
    this.equipSound = opts.equipSound ?? null;
    this.tags = new Set(opts.tags || []);
    this.craftRemainder = opts.craftRemainder ?? null;  // e.g. bucket from milk
    this.projectile = opts.projectile ?? null;
    this.useAnimation = opts.useAnimation ?? (this.food ? 'eat' : 'none');
    this.useDuration = opts.useDuration ?? (this.food ? 32 : 0);
    this.spawnEgg = opts.spawnEgg ?? null;
    this.color = opts.color ?? null;
  }

  get isTool() { return this.tool != null; }
  get isArmor() { return this.armorSlot != null; }
  get stackable() { return this.maxStack > 1 && this.maxDamage === 0; }

  toString() { return this.name; }
}

export function defineItem(name, opts = {}) {
  if (itemsByName.has(name)) throw new Error(`duplicate item ${name}`);
  const it = new Item(name, opts);
  items.push(it);
  itemsByName.set(name, it);
  return it;
}

export function getItem(name) { return itemsByName.get(name) || null; }

/** Register the item form of a block. */
export function defineBlockItem(blockName, opts = {}) {
  const b = blocksByName.get(blockName);
  if (!b) throw new Error(`no such block ${blockName}`);
  return defineItem(blockName, {
    block: blockName,
    maxStack: b.maxStack,
    fuelTicks: b.fuelTicks,
    creativeTab: b.creativeTab,
    texture: b.itemTexture || null,
    displayName: b.displayName,
    ...opts,
  });
}

function titleCase(name) {
  return name.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ---------------------------------------------------------------------------
// ItemStack
// ---------------------------------------------------------------------------

export class ItemStack {
  /**
   * @param {string|Item} item
   * @param {number} count
   * @param {number} damage
   * @param {object|null} tag
   */
  constructor(item, count = 1, damage = 0, tag = null) {
    this.item = typeof item === 'string' ? itemsByName.get(item) : item;
    if (!this.item) throw new Error(`unknown item ${item}`);
    this.count = count;
    this.damage = damage;
    this.tag = tag;
  }

  static of(name, count = 1) { return new ItemStack(name, count); }

  get name() { return this.item.name; }
  get empty() { return this.count <= 0; }
  get maxStack() { return this.item.maxStack; }
  get maxDamage() { return this.item.maxDamage; }
  get broken() { return this.item.maxDamage > 0 && this.damage >= this.item.maxDamage; }
  get durability() {
    return this.item.maxDamage > 0 ? 1 - this.damage / this.item.maxDamage : 1;
  }

  get displayName() {
    if (this.tag?.name) return this.tag.name;
    return this.item.displayName;
  }

  clone() {
    return new ItemStack(this.item, this.count, this.damage,
      this.tag ? JSON.parse(JSON.stringify(this.tag)) : null);
  }

  /** True when two stacks can merge (same item, same damage, same tags). */
  matches(other) {
    if (!other) return false;
    if (this.item !== other.item) return false;
    if (this.damage !== other.damage) return false;
    return sameTag(this.tag, other.tag);
  }

  /** Ignores damage — used by recipes and creative search. */
  isItem(name) { return this.item.name === name; }

  split(n) {
    const take = Math.min(n, this.count);
    this.count -= take;
    return new ItemStack(this.item, take, this.damage,
      this.tag ? JSON.parse(JSON.stringify(this.tag)) : null);
  }

  /** Apply `n` points of damage; returns true when the item breaks. */
  damageBy(n, random) {
    if (this.item.maxDamage <= 0) return false;
    const unbreaking = this.getEnchantLevel('unbreaking');
    if (unbreaking > 0 && random) {
      let actual = 0;
      for (let i = 0; i < n; i++) {
        if (random.next() < 1 / (unbreaking + 1)) actual++;
      }
      n = actual;
    }
    this.damage += n;
    if (this.damage >= this.item.maxDamage) { this.count = 0; return true; }
    return false;
  }

  getEnchantLevel(id) {
    const e = this.tag?.enchantments;
    if (!e) return 0;
    return e[id] || 0;
  }

  addEnchantment(id, level) {
    if (!this.tag) this.tag = {};
    if (!this.tag.enchantments) this.tag.enchantments = {};
    this.tag.enchantments[id] = Math.max(this.tag.enchantments[id] || 0, level);
    return this;
  }

  get enchanted() {
    const e = this.tag?.enchantments;
    return !!e && Object.keys(e).length > 0;
  }

  toJSON() {
    const o = { id: this.item.name, count: this.count };
    if (this.damage) o.damage = this.damage;
    if (this.tag) o.tag = this.tag;
    return o;
  }

  static fromJSON(o) {
    if (!o || !itemsByName.has(o.id)) return null;
    return new ItemStack(o.id, o.count ?? 1, o.damage ?? 0, o.tag ?? null);
  }

  toString() { return `${this.count}x ${this.item.name}`; }
}

function sameTag(a, b) {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const va = a[k], vb = b[k];
    if (typeof va === 'object' && va && typeof vb === 'object' && vb) {
      if (!sameTag(va, vb)) return false;
    } else if (va !== vb) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Mining speed / harvest rules
// ---------------------------------------------------------------------------

/**
 * How long, in seconds, breaking `blockDef` takes with `stack` in hand.
 * Mirrors Minecraft's formula including efficiency, haste and underwater/air
 * penalties.
 */
export function breakTime(blockDef, stack, opts = {}) {
  if (blockDef.hardness < 0) return Infinity;  // bedrock, barrier
  if (blockDef.hardness === 0) return 0;
  let speed = 1;
  const item = stack?.item;
  const correct = isCorrectTool(blockDef, stack);
  if (item && item.tool && item.tool === blockDef.tool) {
    speed = item.miningSpeed;
  } else if (item && item.tool === TOOL.SWORD && blockDef.name === 'cobweb') {
    speed = 15;
  } else if (item && item.tool === TOOL.SHEARS) {
    if (blockDef.sound === 'cloth') speed = 5;
    else if (blockDef.name.endsWith('leaves') || blockDef.name === 'cobweb') speed = 15;
  }
  if (correct && stack) {
    const eff = stack.getEnchantLevel('efficiency');
    if (eff > 0) speed += eff * eff + 1;
  }
  if (opts.haste) speed *= 1 + 0.2 * opts.haste;
  if (opts.miningFatigue) speed *= Math.pow(0.3, Math.min(opts.miningFatigue, 4));
  if (opts.underwater && !opts.aquaAffinity) speed /= 5;
  if (opts.airborne) speed /= 5;

  const damage = speed / blockDef.hardness / (correct ? 30 : 100);
  if (damage >= 1) return 0;
  return 1 / damage / 20;
}

/** Does `stack` satisfy the block's harvest requirement? */
export function isCorrectTool(blockDef, stack) {
  if (blockDef.tool === TOOL.NONE) return true;
  const item = stack?.item;
  if (!item || item.tool !== blockDef.tool) return false;
  return item.tier >= blockDef.tier;
}

/** Will breaking this block yield its drops? */
export function canHarvest(blockDef, stack) {
  if (!blockDef.requiresTool) return true;
  return isCorrectTool(blockDef, stack);
}

/** Total attack damage of a held stack against a target. */
export function attackDamage(stack, targetTags = null) {
  if (!stack || stack.empty) return 1;
  let dmg = stack.item.attackDamage;
  const sharpness = stack.getEnchantLevel('sharpness');
  if (sharpness > 0) dmg += 0.5 * sharpness + 0.5;
  if (targetTags) {
    if (targetTags.has('undead')) {
      const smite = stack.getEnchantLevel('smite');
      if (smite > 0) dmg += 2.5 * smite;
    }
    if (targetTags.has('arthropod')) {
      const bane = stack.getEnchantLevel('bane_of_arthropods');
      if (bane > 0) dmg += 2.5 * bane;
    }
  }
  return dmg;
}
