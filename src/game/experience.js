// Experience: the level curve, orbs, and spending levels.
//
// Minecraft's XP curve is piecewise quadratic. The cost of advancing *from*
// level L is
//
//     L < 16      2L + 7      (7, 9, 11, … 37)
//     16 ≤ L < 31 5L - 38     (42, 47, … 112)
//     L ≥ 31      9L - 158    (121, 130, …)
//
// which integrates to the cumulative totals below. Everything else here —
// orb splitting, pickup, the death penalty — follows from those two functions.

import { AABB, clamp } from '../core/math.js';
import { T } from '../world/blocks.js';

/** Experience needed to advance from `level` to `level + 1`. */
export function xpForLevel(level) {
  const l = Math.max(0, Math.floor(level));
  if (l < 16) return 2 * l + 7;
  if (l < 31) return 5 * l - 38;
  return 9 * l - 158;
}

/**
 * Total experience accumulated on reaching `level` from zero.
 * L ≤ 16:  L² + 6L
 * 17..31:  2.5L² - 40.5L + 360
 * 32+:     4.5L² - 162.5L + 2220
 */
export function totalXpForLevel(level) {
  const l = Math.max(0, Math.floor(level));
  if (l <= 16) return l * l + 6 * l;
  if (l <= 31) return Math.round(2.5 * l * l - 40.5 * l + 360);
  return Math.round(4.5 * l * l - 162.5 * l + 2220);
}

/** The level a given total amount of experience buys. */
export function levelForXp(total) {
  let xp = Math.max(0, Math.floor(total));
  // Closed-form inverse of each branch, then a short correction loop so the
  // three pieces meet exactly at 352 (level 16) and 1507 (level 31).
  let level;
  if (xp <= 352) level = Math.floor(Math.sqrt(xp + 9) - 3);
  else if (xp <= 1507) level = Math.floor(8.1 + Math.sqrt(0.4 * (xp - 195.975)));
  else level = Math.floor(18.055 + Math.sqrt((2 / 9) * (xp - 752.985)));
  level = Math.max(0, level);
  while (totalXpForLevel(level + 1) <= xp) level++;
  while (level > 0 && totalXpForLevel(level) > xp) level--;
  return level;
}

/** Total experience a player is currently carrying. */
export function totalXpOf(player) {
  const level = Math.max(0, player.xpLevel | 0);
  const progress = clamp(player.xpProgress || 0, 0, 1);
  return totalXpForLevel(level) + Math.round(progress * xpForLevel(level));
}

/** Write a total back onto a player as level + progress + total. */
export function setTotalXp(player, total) {
  const t = Math.max(0, Math.floor(total));
  const level = levelForXp(t);
  const into = t - totalXpForLevel(level);
  player.xp = t;
  player.xpLevel = level;
  player.xpProgress = clamp(into / xpForLevel(level), 0, 1);
  return level;
}

/**
 * Grant (or, with a negative amount, remove) raw experience.
 * @returns the player's level afterwards.
 */
export function addXp(player, amount) {
  if (!player || !amount) return player ? player.xpLevel : 0;
  return setTotalXp(player, totalXpOf(player) + amount);
}

/** Grant whole levels, keeping the progress bar where it was. */
export function addLevels(player, levels) {
  if (!player || !levels) return player ? player.xpLevel : 0;
  const level = Math.max(0, (player.xpLevel | 0) + Math.floor(levels));
  const progress = clamp(player.xpProgress || 0, 0, 1);
  player.xpLevel = level;
  player.xpProgress = progress;
  player.xp = totalXpForLevel(level) + Math.round(progress * xpForLevel(level));
  return level;
}

/**
 * Pay `levels` experience levels for an enchantment or anvil operation.
 * Creative mode is free. Returns false (and changes nothing) when the player
 * cannot afford it.
 */
export function spendXp(player, levels) {
  const cost = Math.max(0, Math.floor(levels));
  if (!player) return false;
  if (player.gamemode === 1) return true;      // creative
  if (cost === 0) return true;
  if ((player.xpLevel | 0) < cost) return false;
  addLevels(player, -cost);
  return true;
}

/** Can the player afford `levels`? */
export function canAfford(player, levels) {
  return player?.gamemode === 1 || (player?.xpLevel | 0) >= Math.max(0, Math.floor(levels));
}

/** Experience dropped when a player dies: 7 per level, capped at 100. */
export function xpOnDeath(player) {
  return Math.min(100, (player?.xpLevel | 0) * 7);
}

// ---------------------------------------------------------------------------
// Orbs
// ---------------------------------------------------------------------------

/** The denominations an orb can carry, largest first. */
export const ORB_VALUES = [2477, 1237, 617, 307, 149, 73, 37, 17, 7, 3, 1];

/** Split an amount into the same orb sizes the real game uses. */
export function orbValues(amount) {
  const out = [];
  let left = Math.max(0, Math.floor(amount));
  while (left > 0) {
    let v = 1;
    for (const c of ORB_VALUES) { if (left >= c) { v = c; break; } }
    out.push(v);
    left -= v;
  }
  return out;
}

/** Typical experience rewards, for callers that would otherwise hard-code them. */
export const XP_REWARDS = {
  coal_ore: [0, 2], diamond_ore: [3, 7], emerald_ore: [3, 7], lapis_ore: [2, 5],
  nether_quartz_ore: [2, 5], nether_gold_ore: [0, 1], redstone_ore: [1, 5],
  spawner: [15, 43], smelting: 0.1, bottle_o_enchanting: [3, 11],
  hostile_mob: 5, passive_mob: [1, 3], baby: 0, blaze: 10, enderman: 5,
  wither: 50, ender_dragon: 12000, villager_trade: [3, 6],
};

/**
 * A floating experience orb. Item entities live in their own module; this one
 * ships with the experience system so orbs work even without it.
 */
export class ExperienceOrb {
  constructor(world, x, y, z, value) {
    this.world = world;
    this.isXpOrb = true;
    this.noHit = true;              // not targetable by the crosshair
    this.value = Math.max(1, Math.floor(value));
    this.x = x; this.y = y; this.z = z;
    this.prevX = x; this.prevY = y; this.prevZ = z;
    const r = world?.random;
    this.vx = r ? (r.next() - 0.5) * 0.2 : 0;
    this.vy = r ? r.next() * 0.2 : 0.1;
    this.vz = r ? (r.next() - 0.5) * 0.2 : 0;
    this.age = 0;
    this.maxAge = 6000;             // five minutes, like the real game
    this.pickupDelay = 10;
    this.onGround = false;
    this.aabb = new AABB();
    this.updateBounds();
  }

  updateBounds() {
    this.aabb.set(this.x - 0.25, this.y, this.z - 0.25,
      this.x + 0.25, this.y + 0.5, this.z + 0.25);
  }

  tick(world) {
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;
    if (this.pickupDelay > 0) this.pickupDelay--;

    // Orbs are pulled toward a nearby player, accelerating as they close in.
    const player = world.nearestPlayer(this.x, this.y, this.z, 8);
    if (player && this.pickupDelay === 0 && !player.dead) {
      const dx = player.x - this.x;
      const dy = player.y + player.height * 0.5 - this.y;
      const dz = player.z - this.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 8 && d > 1e-4) {
        const pull = (1 - d / 8) * 0.1;
        this.vx += (dx / d) * pull;
        this.vy += (dy / d) * pull;
        this.vz += (dz / d) * pull;
      }
      if (d < 1.0) { this.collect(world, player); return; }
    }

    this.vy -= 0.03;
    this.x += this.vx; this.y += this.vy; this.z += this.vz;

    // Cheap collision: stop at the first solid block underneath.
    const bx = Math.floor(this.x), bz = Math.floor(this.z);
    const by = Math.floor(this.y - 0.01);
    if (T.solid && T.solid[world.getBlock(bx, by, bz)]) {
      this.y = by + 1;
      if (this.vy < 0) this.vy = -this.vy * 0.3;
      this.onGround = true;
      this.vx *= 0.7; this.vz *= 0.7;
    } else {
      this.onGround = false;
    }
    this.vx *= 0.98; this.vy *= 0.98; this.vz *= 0.98;
    this.updateBounds();
    world.updateEntityChunk(this);

    if (++this.age >= this.maxAge) world.removeEntity(this);
  }

  collect(world, player) {
    world.playSound('orb.pickup', this.x, this.y, this.z, 0.2,
      0.9 + (world.random ? world.random.next() * 0.2 : 0.1));
    // Mending spends the orb repairing gear before it reaches the bar.
    const left = repairWithMending(player, this.value, world);
    if (left > 0) addXp(player, left);
    world.removeEntity(this);
  }
}

/**
 * Mending: an orb repairs a damaged enchanted item at two durability per point
 * before any of it reaches the experience bar.
 */
function repairWithMending(player, value, world) {
  const inv = player?.inventory;
  if (!inv) return value;
  const candidates = [
    inv.getSelected?.(), inv.getOffhand?.(),
    inv.getArmor?.(0), inv.getArmor?.(1), inv.getArmor?.(2), inv.getArmor?.(3),
  ];
  for (const stack of candidates) {
    if (!stack || stack.empty) continue;
    if (!stack.getEnchantLevel?.('mending')) continue;
    if (!stack.damage || stack.damage <= 0) continue;
    const repair = Math.min(stack.damage, value * 2);
    stack.damage -= repair;
    const used = Math.ceil(repair / 2);
    world?.spawnParticles?.('mending', player.x, player.y + 1, player.z, 3);
    return Math.max(0, value - used);
  }
  return value;
}

/**
 * Scatter `amount` experience at a point as orbs of the standard sizes.
 * This is the entry point `game.dropBlockLoot` and mob death call.
 */
export function spawnOrbs(world, x, y, z, amount) {
  const n = Math.max(0, Math.floor(amount));
  if (!world || n <= 0) return [];
  const OrbClass = world.game?.modules?.itemEntity?.ExperienceOrb ?? ExperienceOrb;
  const out = [];
  for (const v of orbValues(n)) {
    const orb = new OrbClass(world, x, y, z, v);
    world.addEntity(orb);
    out.push(orb);
  }
  return out;
}

/** Drop a player's death penalty at their feet and clear their bar. */
export function dropOnDeath(world, player) {
  const amount = xpOnDeath(player);
  if (amount > 0) spawnOrbs(world, player.x, player.y + 0.5, player.z, amount);
  player.xp = 0;
  player.xpLevel = 0;
  player.xpProgress = 0;
  return amount;
}
