// Living entities: health, damage, knockback, status effects, armour and drops.
//
// This sits between the bare Entity and the AI-driven Mob. It owns everything
// that has hit points — the damage pipeline (armour, resistance, absorption,
// invulnerability frames), the effect list, breathing, fall damage, the death
// animation, and loot.

import { clamp, wrapAngle, approachAngle, AABB } from '../core/math.js';
import { T, blockOf } from '../world/blocks.js';
import { itemsByName, ItemStack } from '../game/items.js';
import { Entity } from './entity.js';
import {
  livingTravel, updateEnvironment, applyBlockContacts, isSuffocating, moveEntity,
} from './physics.js';

/** Damage sources that ignore armour entirely. */
export const BYPASSES_ARMOR = new Set([
  'void', 'starve', 'drown', 'suffocate', 'magic', 'wither', 'fall', 'freeze',
  'out_of_world', 'dragon_breath',
]);

/** Damage sources that ignore invulnerability frames. */
const BYPASSES_COOLDOWN = new Set(['void', 'out_of_world', 'starve', 'suffocate', 'drown']);

/** Sources a creative-mode-like `invulnerable` flag does not protect against. */
const ALWAYS_HURTS = new Set(['void', 'out_of_world']);

export class LivingEntity extends Entity {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);

    this.maxHealth = opts.maxHealth ?? 20;
    this.health = opts.health ?? this.maxHealth;
    this.absorption = 0;
    this.dead = false;
    this.deathTime = 0;
    this.deathSource = null;

    this.invulnerableTime = 0;
    this.hurtTime = 0;
    this.maxHurtTime = 10;
    this.lastDamage = 0;
    this.lastHurtBy = null;
    this.lastHurtByTime = 0;
    this.lastHurtMob = null;         // whom we last damaged
    this.attackTarget = null;

    this.armorValue = opts.armor ?? 0;
    this.armorToughness = opts.toughness ?? 0;
    this.knockbackResistance = opts.knockbackResistance ?? 0;

    this.effects = new Map();
    this.tags = new Set(opts.tags || []);

    this.airSupply = 300;
    this.maxAirSupply = 300;
    this.breathesWater = opts.breathesWater ?? false;
    this.breathesAir = opts.breathesAir ?? true;

    this.movementSpeed = opts.speed ?? 0.1;
    this.baseSpeed = this.movementSpeed;
    this.moveForward = 0;
    this.moveStrafe = 0;
    this.moveYaw = this.yaw;
    this.jumping = false;
    this.sprinting = false;
    this.sneaking = false;
    this.pushable = opts.pushable ?? true;
    this.stepHeight = opts.stepHeight ?? 0.6;
    this.fallDamageMultiplier = opts.fallDamage ?? 1;
    this.safeFallDistance = opts.safeFall ?? 3;

    this.attackDamageValue = opts.damage ?? 0;
    this.attackCooldown = 0;
    this.attackAnim = 0;
    this.prevAttackAnim = 0;
    this.swinging = false;

    this.headYawLimit = Math.PI * 0.42;
    this.headTurnSpeed = 0.6;
    this.bodyTurnSpeed = 0.25;

    this.xpReward = opts.xp ?? 0;
    this.lootTable = opts.drops ?? null;
    this.blocksPlacement = true;
  }

  get alive() { return !this.dead && this.health > 0; }

  // -- Damage --------------------------------------------------------------

  /**
   * Apply damage. Returns true when the hit actually landed, which is what the
   * attacker uses to decide whether to play a hit sound and apply knockback.
   */
  hurt(amount, source = 'generic', attacker = null) {
    if (this.removed) return false;
    if (this.dead && !ALWAYS_HURTS.has(source)) return false;
    if (this.invulnerable && !ALWAYS_HURTS.has(source)) return false;
    if (this.isImmuneTo(source)) return false;

    // Minecraft's invulnerability window: a stronger hit inside the window
    // still lands, but only for the difference.
    if (this.invulnerableTime > 0 && !BYPASSES_COOLDOWN.has(source)) {
      if (amount <= this.lastDamage) return false;
      amount -= this.lastDamage;
    }

    const reduced = this.applyArmor(amount, source);
    if (reduced <= 0) return false;
    this.lastDamage = amount;
    this.invulnerableTime = this.maxHurtTime;
    this.hurtTime = this.maxHurtTime;

    let remaining = reduced;
    if (this.absorption > 0) {
      const taken = Math.min(this.absorption, remaining);
      this.absorption -= taken;
      remaining -= taken;
    }
    this.health -= remaining;

    if (attacker) {
      this.lastHurtBy = attacker;
      this.lastHurtByTime = this.world?.tickCount ?? 0;
      this.onHurtBy(attacker, source, reduced);
    }
    this.world?.playSound(this.hurtSound(), this.x, this.y, this.z, 1,
      0.9 + Math.random() * 0.2);
    this.world?.spawnParticles('damage', this.x, this.y + this.height * 0.6, this.z, 3);

    if (this.health <= 0) this.die(source, attacker);
    return true;
  }

  isImmuneTo(source) {
    if (this.immuneToFire && (source === 'fire' || source === 'lava' ||
      source === 'hot_floor' || source === 'in_fire')) return true;
    if (this.breathesWater && source === 'drown') return true;
    if (source === 'fall' && this.fallDamageMultiplier === 0) return true;
    if (source === 'cactus' && this.tags.has('cactus_immune')) return true;
    return false;
  }

  /** Minecraft's armour formula, plus resistance and the toughness term. */
  applyArmor(amount, source) {
    let dmg = amount;
    if (!BYPASSES_ARMOR.has(source) && this.armorValue > 0) {
      const def = this.armorValue;
      const t = this.armorToughness;
      dmg = amount * (1 - Math.min(20,
        Math.max(def / 5, def - amount / (2 + t / 4))) / 25);
    }
    const res = this.effects.get('resistance');
    if (res && source !== 'void' && source !== 'out_of_world') {
      dmg *= Math.max(0, 1 - 0.2 * (res.amplifier + 1));
    }
    if (this.effects.has('fire_resistance') &&
      (source === 'fire' || source === 'lava' || source === 'in_fire')) return 0;
    return Math.max(0, dmg);
  }

  heal(amount) {
    if (this.dead) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  setHealth(v) { this.health = clamp(v, 0, this.maxHealth); }

  /** Push away from (x,z) with Minecraft's knockback curve. */
  knockback(strength, dx, dz) {
    strength *= 1 - this.knockbackResistance;
    if (strength <= 0) return;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    this.vx = this.vx / 2 - (dx / len) * strength;
    this.vz = this.vz / 2 - (dz / len) * strength;
    if (this.onGround) {
      this.vy = Math.min(0.4, this.vy / 2 + strength);
      this.onGround = false;
    }
  }

  onHurtBy(attacker, source, amount) {
    // Overridden by mobs that retaliate or panic.
  }

  hurtSound() { return `mob.${this.type}.hurt`; }
  deathSound() { return `mob.${this.type}.death`; }

  die(source, attacker) {
    if (this.dead) return;
    this.dead = true;
    this.health = 0;
    this.deathSource = source;
    this.deathTime = 0;
    this.attackTarget = null;
    this.world?.playSound(this.deathSound(), this.x, this.y, this.z);
    this.dropLoot(attacker);
    this.dropExperience(attacker);
    this.onDeath(source, attacker);
  }

  onDeath(source, attacker) {}

  // -- Loot ----------------------------------------------------------------

  /**
   * Spawn the entries of the loot table. Each entry is
   * `{item, min, max, chance, looting, requiresFire, cooked}`.
   */
  dropLoot(attacker) {
    const table = this.lootTable;
    if (!table || !this.world) return;
    const rng = this.world.random;
    const looting = attacker?.heldItem?.()?.getEnchantLevel?.('looting') ?? 0;
    for (const entry of table) {
      if (entry.playerOnly && !attacker?.isPlayer) continue;
      let chance = entry.chance ?? 1;
      if (looting > 0 && entry.lootingChance) chance += entry.lootingChance * looting;
      if (chance < 1 && !rng.chance(chance)) continue;
      let name = entry.item;
      if (entry.cooked && this.fireTicks > 0 && itemsByName.has(entry.cooked)) {
        name = entry.cooked;
      }
      const min = entry.min ?? 1;
      const max = (entry.max ?? min) + (looting > 0 ? (entry.looting ?? 0) * looting : 0);
      const count = max > min ? rng.intRange(min, max) : min;
      if (count <= 0) continue;
      this.spawnDrop(name, count);
    }
  }

  spawnDrop(itemName, count) {
    if (!itemsByName.has(itemName)) return null;
    const game = this.world?.game;
    const stack = new ItemStack(itemName, count);
    if (game?.spawnItem) {
      return game.spawnItem(this.world, this.x, this.y + this.height * 0.4, this.z, stack);
    }
    return null;
  }

  dropExperience(attacker) {
    if (!this.xpReward || !attacker?.isPlayer) return;
    const game = this.world?.game;
    const amount = this.xpReward;
    if (game?.modules?.experience?.spawnOrbs) {
      game.modules.experience.spawnOrbs(this.world, this.x, this.y + 0.5, this.z, amount);
    } else if (game?.drops?.spawnExperience) {
      game.drops.spawnExperience(this.world, this.x - 0.5, this.y, this.z - 0.5, amount);
    }
  }

  // -- Status effects ------------------------------------------------------

  addEffect(id, duration, amplifier = 0) {
    const cur = this.effects.get(id);
    if (cur && cur.amplifier > amplifier) return false;
    if (cur && cur.amplifier === amplifier && cur.duration > duration) return false;
    this.effects.set(id, { amplifier, duration });
    this.onEffectsChanged();
    return true;
  }

  removeEffect(id) {
    const had = this.effects.delete(id);
    if (had) this.onEffectsChanged();
    return had;
  }

  hasEffect(id) { return this.effects.has(id); }
  getEffect(id) { return this.effects.get(id) ?? null; }

  onEffectsChanged() {
    let speed = this.baseSpeed;
    const s = this.effects.get('speed');
    if (s) speed *= 1 + 0.2 * (s.amplifier + 1);
    const sl = this.effects.get('slowness');
    if (sl) speed *= Math.max(0, 1 - 0.15 * (sl.amplifier + 1));
    this.movementSpeed = speed;
  }

  tickEffects() {
    if (this.effects.size === 0) return;
    for (const [id, e] of this.effects) {
      if (--e.duration <= 0) { this.effects.delete(id); this.onEffectsChanged(); continue; }
      this.applyEffectTick(id, e);
    }
  }

  applyEffectTick(id, e) {
    const period = (n) => (this.world.tickCount % n) === 0;
    switch (id) {
      case 'regeneration':
        if (period(Math.max(1, 50 >> e.amplifier))) this.heal(1);
        break;
      case 'poison':
        if (period(Math.max(1, 25 >> e.amplifier)) && this.health > 1) {
          this.hurt(1, 'magic');
        }
        break;
      case 'wither':
        if (period(Math.max(1, 40 >> e.amplifier))) this.hurt(1, 'wither');
        break;
      case 'instant_damage':
        this.hurt(6 * (e.amplifier + 1), 'magic');
        this.effects.delete(id);
        break;
      case 'instant_health':
        this.heal(4 * (e.amplifier + 1));
        this.effects.delete(id);
        break;
      case 'levitation':
        this.vy += (0.05 * (e.amplifier + 1) - this.vy) * 0.2;
        break;
      default: break;
    }
  }

  // -- Ticking -------------------------------------------------------------

  tick(world) {
    world = world || this.world;
    this.baseTick(world);

    if (this.dead) { this.tickDeath(world); return; }

    this.tickEffects();
    this.tickBreath(world);
    this.tickEnvironmentDamage(world);

    this.prevAttackAnim = this.attackAnim;
    if (this.swinging) {
      this.attackAnim += 1 / 6;
      if (this.attackAnim >= 1) { this.attackAnim = 0; this.swinging = false; }
    }
    if (this.attackCooldown > 0) this.attackCooldown--;
    if (this.invulnerableTime > 0) this.invulnerableTime--;

    this.updateAI(world);
    this.travel(world);
    this.updateBounds();
    this.updateBodyRotation();
    this.updateLimbSwing();
    this.updateRenderYaws();
    applyBlockContacts(this, world);
    this.pushOutOfEntities(world);
  }

  /** Overridden by Mob to run goals and pathfinding. */
  updateAI(world) {}

  travel(world) {
    this.moveYaw = this.yaw;
    livingTravel(this, world);
  }

  tickDeath(world) {
    this.deathTime++;
    this.moveForward = 0; this.moveStrafe = 0; this.jumping = false;
    livingTravel(this, world);
    this.updateBounds();
    this.updateRenderYaws();
    if (this.deathTime >= 20) this.remove();
  }

  tickBreath(world) {
    if (this.breathesWater) {
      // Fish suffocate out of water instead.
      if (!this.inWater) {
        this.airSupply--;
        if (this.airSupply <= -20) { this.airSupply = 0; this.hurt(2, 'drown'); }
      } else {
        this.airSupply = this.maxAirSupply;
      }
      return;
    }
    if (!this.breathesAir) return;
    if (this.underwater && !this.effects.has('water_breathing')) {
      this.airSupply--;
      if (this.airSupply <= -20) { this.airSupply = 0; this.hurt(2, 'drown'); }
    } else if (this.airSupply < this.maxAirSupply) {
      this.airSupply = Math.min(this.maxAirSupply, this.airSupply + 4);
    }
  }

  tickEnvironmentDamage(world) {
    if (this.fireTicks > 0 && !this.immuneToFire && this.fireTicks % 20 === 0) {
      this.hurt(1, 'fire');
    }
    if (this.inLava && !this.immuneToFire && world.tickCount % 10 === 0) {
      this.hurt(4, 'lava');
    }
    if (world.tickCount % 4 === 0 && isSuffocating(this, world)) this.hurt(1, 'suffocate');
    if (this.y < -80) this.hurt(4, 'out_of_world');
  }

  onLand(fallDistance) {
    if (this.fallDamageMultiplier === 0) return;
    const reduce = this.effects.get('jump_boost')?.amplifier != null
      ? this.effects.get('jump_boost').amplifier + 1 : 0;
    const dmg = Math.floor((fallDistance - this.safeFallDistance - reduce) *
      this.fallDamageMultiplier);
    if (dmg > 0 && !this.inWater) this.hurt(dmg, 'fall');
    if (fallDistance > 0.6) {
      const def = blockOf(this.world.getBlock(Math.floor(this.x),
        Math.floor(this.y - 0.2), Math.floor(this.z)));
      if (def) this.world.playSound(`step.${def.sound}`, this.x, this.y, this.z, 0.4, 1);
    }
  }

  /**
   * The body lags behind the head and catches up as the entity walks — the
   * detail that makes a mob look like it is turning rather than sliding.
   */
  updateBodyRotation() {
    const moving = Math.hypot(this.x - this.prevX, this.z - this.prevZ) > 0.0025;
    if (moving) {
      const travelYaw = Math.atan2(-(this.x - this.prevX), this.z - this.prevZ);
      this.bodyRot = approachAngle(this.bodyRot, travelYaw, this.bodyTurnSpeed);
    }
    let delta = wrapAngle(this.yaw - this.bodyRot);
    if (Math.abs(delta) > this.headYawLimit) {
      this.bodyRot = approachAngle(this.bodyRot, this.yaw,
        Math.abs(delta) - this.headYawLimit);
      delta = wrapAngle(this.yaw - this.bodyRot);
    }
    this.bodyRot = wrapAngle(this.bodyRot);
  }

  // -- Attacking -----------------------------------------------------------

  swing() {
    if (!this.swinging) { this.swinging = true; this.attackAnim = 0; }
  }

  /** Melee another entity, applying damage, knockback and the swing animation. */
  doAttack(target, damage = this.attackDamageValue) {
    if (!target?.hurt) return false;
    this.swing();
    const hit = target.hurt(damage, this.isPlayer ? 'player' : 'mob', this);
    if (hit) {
      target.knockback?.(0.4, target.x - this.x, target.z - this.z);
      this.lastHurtMob = target;
      if (this.fireTicks > 0 && target.fireTicks !== undefined) {
        target.fireTicks = Math.max(target.fireTicks, 80);
      }
    }
    this.world?.playSound('entity.attack', this.x, this.y, this.z, 1, 1);
    return hit;
  }

  canSee(target) {
    if (!target || !this.world) return false;
    return this.world.canSee(this.eyeX, this.eyeY, this.eyeZ,
      target.x, target.y + (target.eyeHeight ?? target.height * 0.5), target.z);
  }

  // -- Persistence ---------------------------------------------------------

  save() {
    const d = super.save();
    d.health = this.health;
    d.maxHealth = this.maxHealth;
    d.absorption = this.absorption;
    d.airSupply = this.airSupply;
    d.effects = [...this.effects.entries()].map(([id, e]) =>
      ({ id, amplifier: e.amplifier, duration: e.duration }));
    return d;
  }

  load(d) {
    super.load(d);
    if (!d) return this;
    this.maxHealth = d.maxHealth ?? this.maxHealth;
    this.health = d.health ?? this.maxHealth;
    this.absorption = d.absorption ?? 0;
    this.airSupply = d.airSupply ?? this.maxAirSupply;
    this.effects.clear();
    for (const e of d.effects || []) {
      this.effects.set(e.id, { amplifier: e.amplifier, duration: e.duration });
    }
    this.onEffectsChanged();
    return this;
  }
}
