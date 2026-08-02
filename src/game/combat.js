// Combat: melee attacks, explosions, projectiles and knockback.
//
// The melee path reproduces the 1.9+ attack model — a cooldown that scales
// damage, critical hits while falling, sword sweeps, shield blocking — and the
// explosion path reproduces the ray-sampled block destruction and exposure
// falloff, which is what makes a TNT crater irregular and gives an entity
// behind a wall a partial reprieve.

import { AABB, clamp } from '../core/math.js';
import { blockOf, T } from '../world/blocks.js';
import { MIN_Y, MAX_Y } from '../world/chunk.js';
import {
  damageBonus, sweepingRatio, fireAspectTicks, knockbackBonus, lootingLevel,
  powerBonus, punchKnockback, hasFlame, thornsDamage, applyProtection,
} from './enchanting.js';
import { attackDamageBonus, has as hasEffect, levelOf } from './effects.js';

/** Explosion powers, straight from the real game. */
export const EXPLOSION_POWER = {
  creeper: 3,
  charged_creeper: 6,
  tnt: 4,
  bed_in_nether: 5,
  respawn_anchor: 5,
  ghast_fireball: 1,
  wither_skull: 1,
  end_crystal: 6,
  wither_spawn: 7,
  minecart_tnt: 4,
};

/** Base knockback of an ordinary melee hit, in blocks per tick. */
export const BASE_KNOCKBACK = 0.4;

// ---------------------------------------------------------------------------
// Melee
// ---------------------------------------------------------------------------

/** Mob tags used by smite / bane of arthropods / impaling. */
function tagsOf(entity) {
  if (entity?.tags instanceof Set) return entity.tags;
  const t = new Set();
  if (entity?.undead) t.add('undead');
  if (entity?.arthropod) t.add('arthropod');
  if (entity?.aquatic) t.add('aquatic');
  return t;
}

function armorPieces(entity) {
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

export function knockbackResistanceOf(entity) {
  let r = entity?.knockbackResistance ?? 0;
  for (const s of armorPieces(entity)) r += s.item.knockbackResistance || 0;
  return clamp(r, 0, 1);
}

/**
 * Push an entity away along (dirX, dirZ).
 * Matches `LivingEntity.knockback`: existing momentum is halved, the push is
 * added horizontally, and the vertical kick is capped at 0.4 when grounded.
 */
export function applyKnockback(target, dirX, dirZ, strength) {
  if (!target) return false;
  const s = strength * (1 - knockbackResistanceOf(target));
  if (s <= 0) return false;
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-6) return false;
  const nx = dirX / len, nz = dirZ / len;
  target.vx = (target.vx ?? 0) / 2 + nx * s;
  target.vz = (target.vz ?? 0) / 2 + nz * s;
  if (target.onGround) target.vy = Math.min(0.4, (target.vy ?? 0) / 2 + s);
  target.hasImpulse = true;
  return true;
}

/** Is the target holding up a shield toward the attacker? */
export function isBlocking(target, attackerX, attackerZ) {
  if (!target) return false;
  const using = target.usingItem ?? target.activeItem ?? null;
  const raised = target.blocking === true ||
    (using && using.item?.name === 'shield' && (target.useTicks ?? 0) >= 5);
  if (!raised) return false;
  // A shield only covers the frontal 180°.
  const dx = attackerX - target.x, dz = attackerZ - target.z;
  const look = { x: -Math.sin(target.yaw ?? 0), z: Math.cos(target.yaw ?? 0) };
  return dx * look.x + dz * look.z > 0;
}

/**
 * The player's swing at an entity.
 *
 * @param player the attacking player
 * @param target the entity being hit
 * @param world  the world both live in
 * @returns true when the target was actually damaged
 */
export function playerAttack(player, target, world) {
  if (!player || !target || target.removed || player.dead) return false;
  if (player.gamemode === 3) return false;                 // spectator
  if (target === player || target.isXpOrb || target.noAttack) return false;

  const stack = player.heldItem?.() ?? null;
  const tags = tagsOf(target);

  // -- Damage -------------------------------------------------------------
  // Base damage scales with the cooldown as 0.2 + t²·0.8; the enchantment
  // bonus scales linearly with t. Both are the vanilla curves.
  const t = clamp(player.attackCooldown ?? 1, 0, 1);
  const cooldownScale = 0.2 + t * t * 0.8;

  let base = (stack && !stack.empty ? stack.item.attackDamage : 1) +
    attackDamageBonus(player);
  base = Math.max(0, base) * cooldownScale;
  const enchantBonus = damageBonus(stack, tags) * t;

  if (base <= 0 && enchantBonus <= 0) return false;

  const fullSwing = t > 0.9;
  const sprintKnockback = fullSwing && player.sprinting;
  // A critical hit needs a full swing while falling, and rules out sprinting.
  const critical = fullSwing && (player.fallDistance ?? 0) > 0 && !player.onGround &&
    !player.onLadder && !player.inWater && !hasEffect(player, 'blindness') &&
    !player.sprinting;
  if (critical) base *= 1.5;

  let damage = base + enchantBonus;

  // A sweep only happens on a stationary, grounded, full-strength sword swing.
  const walked = (player.walkDist ?? 0) - (player.prevWalkDist ?? 0);
  const isSword = stack?.item?.tool === 'sword';
  const sweeping = fullSwing && !critical && !sprintKnockback && player.onGround &&
    walked < 0.1 && isSword;

  // -- Shield -------------------------------------------------------------
  if (isBlocking(target, player.x, player.z)) {
    world.playSound('shield.block', target.x, target.y, target.z, 1, 0.9);
    // An axe smashes through and disables the shield for five seconds.
    if (stack?.item?.tool === 'axe') {
      target.shieldCooldown = 100;
      target.blocking = false;
      world.playSound('shield.break', target.x, target.y, target.z, 0.8, 0.8);
    }
    applyKnockback(target, target.x - player.x, target.z - player.z, 0.2);
    return false;
  }

  // -- Land the hit -------------------------------------------------------
  const before = target.health ?? 0;
  const hit = damageEntity(world, target, damage, 'player', player);
  if (!hit) return false;

  // -- Knockback ----------------------------------------------------------
  let knock = BASE_KNOCKBACK + knockbackBonus(stack);
  if (sprintKnockback) knock += 0.5;
  const dirX = -Math.sin(player.yaw), dirZ = Math.cos(player.yaw);
  applyKnockback(target, dirX, dirZ, knock);
  if (sprintKnockback) {
    player.vx *= 0.6; player.vz *= 0.6;
    player.sprinting = false;
    world.playSound('player.attack.knockback', player.x, player.y, player.z, 1, 1);
  }

  // -- Fire aspect --------------------------------------------------------
  const burn = fireAspectTicks(stack);
  if (burn > 0 && !hasEffect(target, 'fire_resistance')) {
    target.fireTicks = Math.max(target.fireTicks ?? 0, burn);
  }

  // -- Sweep --------------------------------------------------------------
  if (sweeping) {
    const sweepDamage = 1 + sweepingRatio(stack) * damage;
    const box = SWEEP_BOX.copyFrom(player.aabb).grow(1, 0.25, 1, SWEEP_BOX);
    sweepScratch.length = 0;
    for (const e of world.entitiesInBox(box, player, sweepScratch)) {
      if (e === target || e.removed || e.isXpOrb || !e.hurt) continue;
      const dx = e.x - player.x, dz = e.z - player.z;
      if (dx * dx + dz * dz >= 9) continue;                 // 3-block radius
      applyKnockback(e, dirX, dirZ, 0.4);
      damageEntity(world, e, sweepDamage, 'player', player);
    }
    world.playSound('player.attack.sweep', player.x, player.y, player.z, 1, 1);
    world.spawnParticles('sweep_attack', player.x - Math.sin(player.yaw) * 1.2,
      player.y + player.height * 0.5, player.z + Math.cos(player.yaw) * 1.2, 1);
  } else if (critical) {
    world.playSound('player.attack.crit', player.x, player.y, player.z, 1, 1);
    world.spawnParticles('crit', target.x, target.y + (target.height ?? 1) * 0.5,
      target.z, 8);
  } else {
    world.playSound('player.attack.strong', player.x, player.y, player.z, 1, 1);
  }

  // -- Thorns from the target's armour ------------------------------------
  for (const piece of armorPieces(target)) {
    const reflected = thornsDamage(piece, world.random);
    if (reflected > 0) {
      player.hurt?.(reflected, 'thorns');
      piece.damageBy?.(2, world.random);
      break;
    }
  }

  // -- Looting and tool wear ----------------------------------------------
  const looting = lootingLevel(stack);
  if (looting > 0) target.lootingLevel = looting;
  if ((target.health ?? 0) <= 0 && before > 0) {
    target.killedBy = player;
    target.lootingLevel = looting;
  }
  if (stack && !stack.empty && stack.item.maxDamage > 0) {
    if (stack.damageBy(1, world.random)) {
      world.playSound('item.break', player.x, player.y, player.z);
      player.inventory?.setSelected?.(null);
    }
  }
  return true;
}

const SWEEP_BOX = new AABB();
const sweepScratch = [];

/**
 * Deal damage to any entity, going through its own `hurt` when it has one so
 * armour, absorption and invulnerability frames are respected.
 */
export function damageEntity(world, target, amount, source = 'generic', attacker = null) {
  if (!target || amount <= 0) return false;
  if (target.hurt) return target.hurt(amount, source, attacker) !== false;
  if (typeof target.health === 'number') {
    target.health -= amount;
    if (target.health <= 0) target.dead = true;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Explosions
// ---------------------------------------------------------------------------

/**
 * Blow a hole in the world.
 *
 * Block destruction fires 16³ rays outward — only the ones starting on the
 * surface of the sampling cube, so 1352 in total — each carrying an intensity
 * of `power * (0.7 + rand * 0.6)`. Every 0.3-block step costs
 * `(blastResistance + 0.3) * 0.3` plus a flat 0.225, so soft blocks fall and
 * obsidian (resistance 1200) stops any ray dead.
 *
 * @param opts.fire        leave fires behind (charged creepers, ghast fireballs)
 * @param opts.source      the entity that caused it, spared from its own blast
 * @param opts.breakBlocks set false for a purely cosmetic bang
 * @param opts.dropChance  overrides the default 1/power drop chance
 */
export function explode(world, x, y, z, power = 4, opts = {}) {
  if (!world || power <= 0) return { blocks: [], entities: [] };
  const random = opts.random ?? world.random;
  const breakBlocks = opts.breakBlocks !== false;
  const dropChance = opts.dropChance ?? 1 / power;
  const affected = [];

  if (breakBlocks) {
    const seen = new Set();
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 16; j++) {
        for (let k = 0; k < 16; k++) {
          // Only rays that start on the surface of the sampling cube.
          if (i !== 0 && i !== 15 && j !== 0 && j !== 15 && k !== 0 && k !== 15) continue;
          let dx = i / 7.5 - 1, dy = j / 7.5 - 1, dz = k / 7.5 - 1;
          const len = Math.hypot(dx, dy, dz);
          if (len < 1e-6) continue;
          dx /= len; dy /= len; dz /= len;

          let intensity = power * (0.7 + random.next() * 0.6);
          let px = x, py = y, pz = z;
          while (intensity > 0) {
            const bx = Math.floor(px), by = Math.floor(py), bz = Math.floor(pz);
            if (by >= MIN_Y && by <= MAX_Y) {
              const state = world.getBlock(bx, by, bz);
              if (state !== 0) {
                const def = blockOf(state);
                const resistance = def ? def.blastResistance : 0;
                intensity -= (resistance + 0.3) * 0.3;
                if (intensity > 0 && (!def || def.hardness >= 0)) {
                  const key = (bx & 0x3fffff) * 4194304 + (bz & 0x3fffff) + (by + 64) * 1e12;
                  if (!seen.has(key)) { seen.add(key); affected.push([bx, by, bz]); }
                }
              }
            }
            px += dx * 0.3; py += dy * 0.3; pz += dz * 0.3;
            intensity -= 0.22500001;
          }
        }
      }
    }
  }

  // -- Entities -----------------------------------------------------------
  const radius = power * 2;
  const hurtBox = EXPLOSION_BOX.set(x - radius - 1, y - radius - 1, z - radius - 1,
    x + radius + 1, y + radius + 1, z + radius + 1);
  entityScratch.length = 0;
  const hurtEntities = [];
  if (opts.damageEntities !== false) {
    for (const e of world.entitiesInBox(hurtBox, null, entityScratch)) {
      if (e.removed || e.isXpOrb || e.explosionImmune) continue;
      if (e === opts.source && opts.hurtSource === false) continue;
      const ex = e.x - x;
      const ey = (e.y + (e.height ?? 1) * 0.5) - y;
      const ez = e.z - z;
      const dist = Math.hypot(ex, ey, ez);
      if (dist > radius || dist < 1e-6) continue;
      const d = dist / radius;
      const seenPct = exposure(world, x, y, z, e);
      const impact = (1 - d) * seenPct;
      const damage = Math.floor(((impact * impact + impact) / 2) * 7 * radius + 1);
      if (damage > 0) damageEntity(world, e, damage, 'explosion', opts.source ?? null);

      // Blast protection dampens the shove as well as the damage.
      let push = impact;
      if (e.inventory) {
        push = applyProtection(impact, armorPieces(e), 'explosion');
      }
      push *= 1 - knockbackResistanceOf(e);
      e.vx = (e.vx ?? 0) + (ex / dist) * push;
      e.vy = (e.vy ?? 0) + (ey / dist) * push;
      e.vz = (e.vz ?? 0) + (ez / dist) * push;
      hurtEntities.push(e);
    }
  }

  // -- Break the blocks ---------------------------------------------------
  for (const [bx, by, bz] of affected) {
    const state = world.getBlock(bx, by, bz);
    if (state === 0) continue;
    const drop = random.next() < dropChance;
    world.destroyBlock(bx, by, bz, drop, null);
    if (opts.fire && random.oneIn(3)) {
      const below = world.getBlock(bx, by - 1, bz);
      if (world.getBlock(bx, by, bz) === 0 && T.solid[below]) {
        const fire = world.game?.modules?.blockdefs
          ? blockStateByName(world, 'fire') : 0;
        if (fire) world.setBlock(bx, by, bz, fire);
      }
    }
  }

  world.playSound('explode', x, y, z, 4, (1 + (random.next() - random.next()) * 0.2) * 0.7);
  world.spawnParticles(power >= 2 ? 'explosion_huge' : 'explosion', x, y, z, 1,
    { power });

  return { blocks: affected, entities: hurtEntities };
}

const EXPLOSION_BOX = new AABB();
const entityScratch = [];

function blockStateByName(world, name) {
  const defs = world.game?.modules?.blockdefs;
  const b = defs?.blocksByName?.get?.(name);
  return b ? b.defaultState : 0;
}

/**
 * The fraction of an entity's bounding box with line of sight to the blast.
 * Samples a grid across the box exactly as `Explosion.getSeenPercent` does, so
 * cover genuinely helps.
 */
export function exposure(world, x, y, z, entity) {
  const box = entity.aabb;
  if (!box) return 1;
  const sx = 1 / ((box.maxX - box.minX) * 2 + 1);
  const sy = 1 / ((box.maxY - box.minY) * 2 + 1);
  const sz = 1 / ((box.maxZ - box.minZ) * 2 + 1);
  if (sx <= 0 || sy <= 0 || sz <= 0) return 0;
  const ox = (1 - Math.floor(1 / sx) * sx) / 2;
  const oz = (1 - Math.floor(1 / sz) * sz) / 2;
  let hits = 0, total = 0;
  for (let fx = 0; fx <= 1; fx += sx) {
    for (let fy = 0; fy <= 1; fy += sy) {
      for (let fz = 0; fz <= 1; fz += sz) {
        const px = box.minX + (box.maxX - box.minX) * fx + ox;
        const py = box.minY + (box.maxY - box.minY) * fy;
        const pz = box.minZ + (box.maxZ - box.minZ) * fz + oz;
        if (world.canSee(px, py, pz, x, y, z)) hits++;
        total++;
      }
    }
  }
  return total > 0 ? hits / total : 0;
}

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------

/** A flying arrow. Kept here so bows work without the entity module. */
export class Arrow {
  constructor(world, shooter, x, y, z, vx, vy, vz) {
    this.world = world;
    this.isArrow = true;
    this.shooter = shooter;
    this.x = x; this.y = y; this.z = z;
    this.prevX = x; this.prevY = y; this.prevZ = z;
    this.vx = vx; this.vy = vy; this.vz = vz;
    this.baseDamage = 2;
    this.knockback = 0;
    this.critical = false;
    this.fireTicks = 0;
    this.pierce = 0;
    this.pierced = new Set();
    this.inGround = false;
    this.age = 0;
    this.aabb = new AABB();
    this.updateBounds();
  }

  get height() { return 0.5; }

  updateBounds() {
    this.aabb.set(this.x - 0.25, this.y - 0.25, this.z - 0.25,
      this.x + 0.25, this.y + 0.25, this.z + 0.25);
  }

  tick(world) {
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;
    if (this.inGround) {
      if (++this.age > 1200) world.removeEntity(this);
      return;
    }
    const speed = Math.hypot(this.vx, this.vy, this.vz);
    const hit = world.raycast(this.x, this.y, this.z, this.vx, this.vy, this.vz,
      speed, { collision: true });
    if (hit) {
      this.x = hit.px; this.y = hit.py; this.z = hit.pz;
      this.inGround = true;
      this.vx = this.vy = this.vz = 0;
      world.playSound('arrow.hit', this.x, this.y, this.z, 1, 1.2);
      this.updateBounds();
      return;
    }

    this.x += this.vx; this.y += this.vy; this.z += this.vz;
    this.updateBounds();

    // Entity hits: anything overlapping the swept box that is not the shooter.
    arrowScratch.length = 0;
    for (const e of world.entitiesInBox(this.aabb, this.shooter, arrowScratch)) {
      if (e.removed || e.isXpOrb || e.isArrow) continue;
      if (this.pierced.has(e)) continue;
      this.onHitEntity(world, e, speed);
      if (this.pierce <= this.pierced.size) { world.removeEntity(this); return; }
    }

    this.vy -= 0.05;                                  // arrow gravity
    this.vx *= 0.99; this.vy *= 0.99; this.vz *= 0.99;
    world.updateEntityChunk(this);
    if (++this.age > 1200) world.removeEntity(this);
  }

  onHitEntity(world, target, speed) {
    let damage = Math.ceil(clamp(speed * this.baseDamage, 0, 1e9));
    if (this.critical) damage += world.random.int(Math.floor(damage / 2) + 2);
    damageEntity(world, target, damage, 'arrow', this.shooter);
    if (this.fireTicks > 0 && !hasEffect(target, 'fire_resistance')) {
      target.fireTicks = Math.max(target.fireTicks ?? 0, this.fireTicks);
    }
    if (this.knockback > 0) {
      applyKnockback(target, this.vx, this.vz, this.knockback * 0.6);
    } else {
      applyKnockback(target, this.vx, this.vz, 0.2);
    }
    this.pierced.add(target);
  }
}

const arrowScratch = [];

/**
 * Fire an arrow from `shooter`.
 *
 * @param charge 0..1 bow draw (1 = fully drawn, three blocks per tick)
 * @param opts.bow the bow/crossbow stack, for power/punch/flame/piercing
 * @param opts.spread inaccuracy in blocks per tick (0 for a player's bow)
 */
export function shootArrow(world, shooter, charge = 1, opts = {}) {
  if (!world || !shooter) return null;
  const bow = opts.bow ?? shooter.heldItem?.() ?? null;
  const power = clamp(charge, 0, 1) * 3;
  const look = shooter.lookVector ? shooter.lookVector() : { x: 0, y: 0, z: 1 };
  const spread = opts.spread ?? 0;
  const r = world.random;

  const ArrowClass = world.game?.modules?.itemEntity?.Arrow ?? Arrow;
  const arrow = new ArrowClass(world, shooter,
    shooter.eyeX ?? shooter.x, (shooter.eyeY ?? shooter.y + 1.5) - 0.1, shooter.eyeZ ?? shooter.z,
    look.x * power + (spread ? r.gaussian() * spread : 0),
    look.y * power + (spread ? r.gaussian() * spread : 0),
    look.z * power + (spread ? r.gaussian() * spread : 0));

  arrow.baseDamage = opts.baseDamage ?? 2;
  const bonus = powerBonus(bow, 1);
  if (bonus > 0) arrow.baseDamage += bonus + 0.5;
  arrow.knockback = punchKnockback(bow);
  if (hasFlame(bow)) arrow.fireTicks = 100;
  arrow.critical = charge >= 1;
  arrow.pierce = opts.pierce ?? 0;

  world.addEntity(arrow);
  world.playSound('bow.shoot', shooter.x, shooter.y, shooter.z, 1,
    1 / (r.next() * 0.4 + 1.2) + charge * 0.5);
  return arrow;
}

/**
 * Damage from falling: one heart per block past three, reduced by jump boost
 * and by feather falling (three EPF per level).
 */
export function fallDamage(entity, fallDistance) {
  const jump = levelOf(entity, 'jump_boost');
  const raw = Math.floor(fallDistance - 3 - jump);
  if (raw <= 0) return 0;
  const boots = entity?.inventory?.getArmor?.(3) ?? null;
  const feather = boots?.getEnchantLevel?.('feather_falling') ?? 0;
  return Math.max(0, Math.floor(raw * (1 - feather * 0.12)));
}
