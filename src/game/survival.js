// Survival: hunger, saturation, exhaustion, regeneration, and the damage maths.
//
// `tickPlayer` is the once-per-tick heartbeat the game loop calls after the
// player has moved. It reproduces Minecraft's `FoodData.tick` exactly:
//
//   * exhaustion above 4.0 spends one saturation point, or one hunger point
//     when saturation has run out;
//   * with saturation left and a full hunger bar, health regenerates every
//     10 ticks by min(saturation, 6)/6 and costs that much exhaustion;
//   * otherwise, with hunger ≥ 18, health regenerates 1 every 80 ticks for
//     6.0 exhaustion;
//   * with hunger at 0, starvation deals 1 damage every 80 ticks — down to
//     10 health on easy, 1 on normal, and all the way to death on hard.
//
// Everything else here is the damage pipeline (armour, enchantment protection,
// resistance, absorption) and the respawn-anchor behaviour.

import { clamp } from '../core/math.js';
import { blockOf, getProp, withProp, T } from '../world/blocks.js';
import { ItemStack, itemsByName } from './items.js';
import { GAMEMODE, rulesFor } from './gamemode.js';
import { tick as tickEffects, has as hasEffect, levelOf, apply as applyEffect } from './effects.js';
import { applyProtection, totalProtection } from './enchanting.js';
import { explode, EXPLOSION_POWER, fallDamage } from './combat.js';
import { dropOnDeath } from './experience.js';

/** Full hunger and health, in the game's half-shank/half-heart points. */
export const MAX_FOOD = 20;
export const MAX_HEALTH = 20;
/** Exhaustion consumed per saturation (then hunger) point. */
export const EXHAUSTION_THRESHOLD = 4;
/** Sprinting stops below this hunger level. */
export const SPRINT_HUNGER = 6;
/** Slow natural regeneration needs at least this much hunger. */
export const REGEN_HUNGER = 18;
/** Ticks between slow regeneration heals, and between starvation hits. */
export const SLOW_REGEN_TICKS = 80;
/** Ticks between saturation-powered regeneration heals. */
export const FAST_REGEN_TICKS = 10;

/** Difficulty ids, matching `world.difficulty`. */
export const DIFFICULTY = { PEACEFUL: 0, EASY: 1, NORMAL: 2, HARD: 3 };

/** The exhaustion each action costs, straight from the real game. */
export const EXHAUSTION = {
  walk: 0.0,          // walking itself is free; sprinting is not
  sprint: 0.1,        // per block
  swim: 0.01,         // per block
  jump: 0.05,
  sprintJump: 0.2,
  attack: 0.1,
  mine: 0.005,
  damage: 0.1,
  regen: 6.0,
};

// ---------------------------------------------------------------------------
// The per-tick heartbeat
// ---------------------------------------------------------------------------

/**
 * One survival tick for a player. Safe to call for any gamemode — creative,
 * adventure and spectator take the parts that apply to them and skip the rest.
 */
export function tickPlayer(player, world) {
  if (!player || !world) return;
  const rules = rulesFor(player.gamemode);

  // Status effects still run in creative; only the food bar is exempt. The
  // player already aged its own effect durations in `Player.tickTimers`, so
  // this pass applies behaviour without advancing them a second time.
  tickEffects(player, world, { advance: false });

  tickItemUse(player, world);

  if (player.dead) return;
  if (!rules.hasHunger) {
    player.exhaustion = 0;
    player.foodTickTimer = 0;
    if (player.health < player.maxHealth && rules.invulnerable) {
      player.health = player.maxHealth;
    }
    return;
  }

  const difficulty = world.difficulty ?? DIFFICULTY.NORMAL;
  player.lastFood = player.food;

  // -- Exhaustion ---------------------------------------------------------
  while (player.exhaustion >= EXHAUSTION_THRESHOLD) {
    player.exhaustion -= EXHAUSTION_THRESHOLD;
    if (player.saturation > 0) {
      player.saturation = Math.max(0, player.saturation - 1);
    } else if (difficulty !== DIFFICULTY.PEACEFUL) {
      player.food = Math.max(0, player.food - 1);
    }
  }
  // Saturation can never exceed the hunger bar behind it.
  if (player.saturation > player.food) player.saturation = player.food;

  // -- Regeneration and starvation ----------------------------------------
  const hurt = player.health < player.maxHealth;
  const naturalRegen = world.naturalRegeneration !== false;
  player.foodTickTimer = player.foodTickTimer ?? 0;

  if (naturalRegen && player.saturation > 0 && hurt && player.food >= MAX_FOOD) {
    // Fast regeneration: a full bar plus saturation heals every half second.
    if (++player.foodTickTimer >= FAST_REGEN_TICKS) {
      const amount = Math.min(player.saturation, 6);
      player.heal(amount / 6);
      addExhaustion(player, amount);
      player.foodTickTimer = 0;
    }
  } else if (naturalRegen && player.food >= REGEN_HUNGER && hurt) {
    if (++player.foodTickTimer >= SLOW_REGEN_TICKS) {
      player.heal(1);
      addExhaustion(player, EXHAUSTION.regen);
      player.foodTickTimer = 0;
    }
  } else if (player.food <= 0) {
    if (++player.foodTickTimer >= SLOW_REGEN_TICKS) {
      if (canStarve(player.health, difficulty)) player.hurt(1, 'starve');
      player.foodTickTimer = 0;
    }
  } else {
    player.foodTickTimer = 0;
  }

  // Peaceful heals steadily and never lets the bar empty.
  if (difficulty === DIFFICULTY.PEACEFUL) {
    if (world.tickCount % 20 === 0 && player.health < player.maxHealth) player.heal(1);
    if (world.tickCount % 10 === 0 && player.food < MAX_FOOD) player.food++;
  }

  if (player.health <= 0 && !player.dead) player.die('generic');
}

/** Starvation stops at 10 health on easy and 1 on normal; hard can kill. */
export function canStarve(health, difficulty) {
  if (difficulty === DIFFICULTY.HARD) return true;
  if (difficulty === DIFFICULTY.NORMAL) return health > 1;
  if (difficulty === DIFFICULTY.EASY) return health > 10;
  return false;                                    // peaceful never starves
}

/** Can the player start (or keep) sprinting? */
export function canSprint(player) {
  if (!player) return false;
  if (player.gamemode !== GAMEMODE.SURVIVAL && player.gamemode !== GAMEMODE.ADVENTURE) {
    return true;
  }
  return player.food > SPRINT_HUNGER;
}

/**
 * Add exhaustion, spending saturation and then hunger as it crosses 4.0.
 * Mirrors `Player.addExhaustion` so both entry points behave identically.
 */
export function addExhaustion(player, amount) {
  if (!player || amount <= 0) return;
  if (!rulesFor(player.gamemode).hasHunger) return;
  player.exhaustion += amount;
  while (player.exhaustion >= EXHAUSTION_THRESHOLD) {
    player.exhaustion -= EXHAUSTION_THRESHOLD;
    if (player.saturation > 0) player.saturation = Math.max(0, player.saturation - 1);
    else player.food = Math.max(0, player.food - 1);
  }
}

// ---------------------------------------------------------------------------
// Eating
// ---------------------------------------------------------------------------

/** Advance a held-use animation (eating, drinking, drawing a bow). */
export function tickItemUse(player, world) {
  const stack = player.usingItem;
  if (!stack || stack.empty) { player.useTicks = 0; return; }
  if (player.useTicks > 0) {
    player.useTicks--;
    if (stack.item.food && player.useTicks % 4 === 0) {
      world.playSound('player.eat', player.x, player.y, player.z, 0.5,
        0.9 + world.random.next() * 0.2);
      world.spawnParticles('item', player.eyeX, player.eyeY - 0.2, player.eyeZ, 3,
        { item: stack.item.name });
    }
    return;
  }
  if (stack.item.food) finishEating(player, world, stack);
  player.usingItem = null;
}

/** Can this food be eaten right now? Golden apples ignore a full bar. */
export function canEat(player, stack) {
  const food = stack?.item?.food;
  if (!food) return false;
  if (player.gamemode === GAMEMODE.CREATIVE) return true;
  return player.food < MAX_FOOD || food.alwaysEdible;
}

/** Apply a food item's nutrition and side effects, and consume it. */
export function finishEating(player, world, stack) {
  const food = stack?.item?.food;
  if (!food) return false;
  eat(player, food.hunger, food.saturation);
  for (const e of food.effects || []) {
    if (e.chance != null && world.random.next() > e.chance) continue;
    applyEffect(player, e.id, e.duration ?? 200, e.amplifier ?? 0);
  }
  world.playSound('player.burp', player.x, player.y, player.z, 0.5, 0.9);
  if (player.gamemode !== GAMEMODE.CREATIVE) {
    stack.count--;
    if (stack.count <= 0) player.inventory?.setSelected?.(null);
    // A bowl or bottle is left behind when the food is gone.
    if (stack.item.craftRemainder && itemsByName.has(stack.item.craftRemainder)) {
      player.inventory?.addItem?.(new ItemStack(stack.item.craftRemainder, 1));
    }
  }
  player.usingItem = null;
  player.useTicks = 0;
  return true;
}

/**
 * Restore hunger and saturation.
 * Saturation gained is `hunger * saturationModifier * 2`, capped by the hunger
 * bar — which is why steak is worth so much more than the bar alone suggests.
 */
export function eat(player, hunger, saturationModifier) {
  player.food = Math.min(MAX_FOOD, player.food + hunger);
  player.saturation = Math.min(player.food,
    player.saturation + hunger * saturationModifier * 2);
  return player.food;
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

/** Damage sources that ignore armour entirely. */
export const BYPASSES_ARMOR = new Set([
  'void', 'starve', 'drown', 'suffocate', 'magic', 'wither', 'fall', 'fly_into_wall',
  'freeze', 'dragon_breath', 'out_of_world',
]);

/** Damage sources nothing can protect against. */
export const BYPASSES_EVERYTHING = new Set(['void', 'out_of_world', 'generic_kill']);

/**
 * Minecraft's armour formula.
 *
 *   damage × (1 − min(20, max(defense/5, defense − damage/(2 + toughness/4))) / 25)
 *
 * The first term is the 4% floor every armour point always gives; the second is
 * the toughness-moderated term that lets heavy hits punch through. A full
 * diamond set (20 defence, 8 toughness) turns a 10-damage hit into 3.
 */
export function armorReduction(damage, defense, toughness = 0) {
  if (defense <= 0) return damage;
  const effective = Math.min(20,
    Math.max(defense / 5, defense - damage / (2 + toughness / 4)));
  return damage * (1 - effective / 25);
}

/** Total armour points worn. */
export function defenseOf(entity) {
  let d = entity?.baseDefense ?? 0;
  for (const s of armorOf(entity)) d += s.item.defense || 0;
  return d;
}

/** Total armour toughness worn. */
export function toughnessOf(entity) {
  let t = entity?.baseToughness ?? 0;
  for (const s of armorOf(entity)) t += s.item.toughness || 0;
  return t;
}

function armorOf(entity) {
  const inv = entity?.inventory;
  if (!inv) return [];
  if (inv.armorSlots) return inv.armorSlots.filter(Boolean);
  const out = [];
  for (let i = 0; i < 4; i++) {
    const s = inv.getArmor?.(i);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Run an amount of incoming damage through the full pipeline:
 * armour → enchantment protection (EPF, capped at 20) → resistance.
 */
export function computeDamage(entity, amount, source = 'generic') {
  if (BYPASSES_EVERYTHING.has(source)) return amount;
  let dmg = amount;
  if (!BYPASSES_ARMOR.has(source)) {
    dmg = armorReduction(dmg, defenseOf(entity), toughnessOf(entity));
  }
  dmg = applyProtection(dmg, armorOf(entity), source);
  const resistance = levelOf(entity, 'resistance');
  if (resistance > 0) dmg *= Math.max(0, 1 - 0.2 * resistance);
  if (hasEffect(entity, 'fire_resistance') && isFireDamage(source)) dmg = 0;
  return Math.max(0, dmg);
}

/** Enchantment protection factor for an entity against a source, capped at 20. */
export function protectionFactor(entity, source) {
  return totalProtection(armorOf(entity), source);
}

const FIRE_DAMAGE = new Set(['fire', 'lava', 'in_fire', 'on_fire', 'hot_floor', 'campfire']);
export function isFireDamage(source) { return FIRE_DAMAGE.has(source); }

/**
 * Apply damage to an entity that has no `hurt` of its own, honouring
 * absorption and invulnerability frames.
 */
export function hurtEntity(entity, amount, source, world) {
  if (!entity || entity.dead) return false;
  if ((entity.invulnerableTime ?? 0) > 0 && !BYPASSES_EVERYTHING.has(source)) return false;
  const dmg = computeDamage(entity, amount, source);
  if (dmg <= 0) return false;
  let left = dmg;
  if (entity.absorption > 0) {
    const taken = Math.min(entity.absorption, left);
    entity.absorption -= taken;
    left -= taken;
  }
  entity.health -= left;
  entity.hurtTime = 10;
  entity.invulnerableTime = 10;
  if (entity.isPlayer) addExhaustion(entity, EXHAUSTION.damage);
  world?.playSound?.('entity.hurt', entity.x, entity.y, entity.z);
  if (entity.health <= 0) entity.die?.(source);
  return true;
}

/** Fall damage for an entity, after jump boost and feather falling. */
export function fallDamageFor(entity, distance) {
  return fallDamage(entity, distance);
}

/** Fall distance at which damage first appears, given the entity's effects. */
export function fallDamageThreshold(entity) {
  return 3 + levelOf(entity, 'jump_boost');
}

/** Drowning: two damage every second once the air bar is exhausted. */
export function drowningDamage() { return 2; }

// ---------------------------------------------------------------------------
// Death and respawn
// ---------------------------------------------------------------------------

/**
 * Everything that happens when a player dies: experience drops, the inventory
 * spills, and effects clear.
 */
export function onPlayerDeath(world, player, game) {
  if (!player) return;
  const rules = rulesFor(player.gamemode);
  if (rules.dropsInventory && world.keepInventory !== true) {
    dropInventory(world, player, game);
  }
  dropOnDeath(world, player);
  player.effects.clear();
  player.absorption = 0;
}

function dropInventory(world, player, game) {
  const inv = player.inventory;
  if (!inv || !game?.spawnItem) return;
  const lists = [inv.slots, inv.armorSlots, inv.offhand ? [inv.offhand] : []];
  for (const list of lists) {
    if (!list) continue;
    for (let i = 0; i < list.length; i++) {
      const stack = list[i];
      if (!stack || stack.empty) continue;
      // Curse of vanishing destroys the item instead of dropping it.
      if (stack.getEnchantLevel?.('curse_of_vanishing') > 0) { list[i] = null; continue; }
      game.spawnItem(world, player.x, player.y + 1, player.z, stack);
      list[i] = null;
    }
  }
  if (inv.offhand) inv.offhand = null;
}

/**
 * Choose where a player comes back. Prefers their bed or charged respawn
 * anchor, falling back to the world spawn when the spot has been destroyed.
 */
export function respawnPlayer(world, player, game) {
  const point = player.spawnPoint;
  let target = null;
  if (point) {
    if (point.anchor) target = consumeAnchorCharge(world, point) ? point : null;
    else target = isSpawnUsable(world, point) ? point : null;
  }
  if (!target) target = world.spawnPos ?? { x: 0.5, y: 80, z: 0.5 };
  player.respawn(target.x, target.y, target.z);
  player.foodTickTimer = 0;
  player.absorption = 0;
  player.invulnerableTime = 60;
  game?.chat?.(point && !target ? 'Your home bed was missing or obstructed' : '');
  return target;
}

function isSpawnUsable(world, point) {
  const x = Math.floor(point.x), y = Math.floor(point.y), z = Math.floor(point.z);
  return !T.solid[world.getBlock(x, y, z)] && !T.solid[world.getBlock(x, y + 1, z)];
}

function consumeAnchorCharge(world, point) {
  const x = Math.floor(point.x), y = Math.floor(point.y - 1), z = Math.floor(point.z);
  const state = world.getBlock(x, y, z);
  const def = blockOf(state);
  if (def?.name !== 'respawn_anchor') return false;
  const charges = getProp(state, 'charges');
  if (charges <= 0) return false;
  world.setBlock(x, y, z, withProp(state, 'charges', charges - 1));
  world.playSound('respawn_anchor.deplete', x + 0.5, y + 0.5, z + 0.5, 1, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Respawn anchor
// ---------------------------------------------------------------------------

/**
 * Right-clicking a respawn anchor: glowstone charges it up to four times;
 * a charged anchor sets the spawn point in the Nether and detonates anywhere
 * else, exactly like a bed in the wrong dimension.
 */
export function useRespawnAnchor(world, x, y, z, state, player, hand) {
  const def = blockOf(state);
  if (!def || def.name !== 'respawn_anchor') return false;
  const charges = getProp(state, 'charges');
  const stack = hand && hand.item ? hand : (player?.heldItem?.() ?? null);

  // Charging.
  if (stack && !stack.empty && stack.item.name === 'glowstone' && charges < 4) {
    world.setBlock(x, y, z, withProp(state, 'charges', charges + 1));
    if (player && player.gamemode !== GAMEMODE.CREATIVE) {
      stack.count--;
      if (stack.count <= 0) player.inventory?.setSelected?.(null);
    }
    world.playSound('respawn_anchor.charge', x + 0.5, y + 0.5, z + 0.5, 1, 1);
    world.spawnParticles('reverse_portal', x + 0.5, y + 1, z + 0.5, 10);
    return true;
  }

  if (charges <= 0) return false;

  if (world.dimension !== 'nether') {
    // Outside the Nether it behaves like a bed: it explodes.
    world.setBlock(x, y, z, 0);
    explode(world, x + 0.5, y + 0.5, z + 0.5, EXPLOSION_POWER.respawn_anchor,
      { fire: true, source: player, breakBlocks: true });
    return true;
  }

  if (player) {
    player.spawnPoint = {
      x: x + 0.5, y: y + 1, z: z + 0.5, dimension: 'nether', anchor: true,
    };
    world.game?.chat?.('Respawn point set');
    world.playSound('respawn_anchor.set_spawn', x + 0.5, y + 0.5, z + 0.5, 1, 1);
  }
  return true;
}

/** Sleeping in a bed outside the Overworld detonates it. */
export function explodeBed(world, x, y, z, player) {
  world.setBlock(x, y, z, 0);
  explode(world, x + 0.5, y + 0.5, z + 0.5, EXPLOSION_POWER.bed_in_nether,
    { fire: true, source: player });
  return true;
}

/** Air-supply drain, for callers that want it outside `Player`. */
export function tickAir(player, world) {
  if (!rulesFor(player.gamemode).takesDamage) return;
  if (player.underwater && !hasEffect(player, 'water_breathing')) {
    const respiration = player.inventory?.getArmor?.(0)?.getEnchantLevel?.('respiration') ?? 0;
    if (respiration === 0 || world.random.int(respiration + 1) === 0) player.airSupply--;
    if (player.airSupply <= -20) { player.airSupply = 0; player.hurt(drowningDamage(), 'drown'); }
  } else if (player.airSupply < player.maxAirSupply) {
    player.airSupply = Math.min(player.maxAirSupply, player.airSupply + 4);
  }
}

/** Clamp a value into the health bar, for HUD code and tests. */
export function clampHealth(v, max = MAX_HEALTH) { return clamp(v, 0, max); }
