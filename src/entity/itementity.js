// Non-living entities: dropped items, experience orbs, falling blocks, primed
// TNT and projectiles. These share the base Entity's physics but each has its
// own small behaviour, so they live together rather than in the mob registry.

import { Entity } from './entity.js';
import { ItemStack, itemsByName } from '../game/items.js';
import { T, blockOf, blocksByName } from '../world/blocks.js';
import { MIN_Y } from '../world/chunk.js';
import { AABB } from '../core/math.js';

/** Ticks a dropped item survives before despawning (5 minutes, as in vanilla). */
const ITEM_LIFETIME = 6000;

export class ItemEntity extends Entity {
  constructor(world, x, y, z, stack) {
    super(world, x, y, z, { type: 'item', width: 0.25, height: 0.25 });
    this.renderKind = 'item';
    this.itemStack = stack;
    this.pickupDelay = 10;
    this.ageTicks = 0;
    this.noHit = true;
    this.blocksPlacement = false;
    this.shadowRadius = 0.15;
    // A little scatter so a stack of drops does not stand in one column.
    this.vx = (world.random.next() - 0.5) * 0.1;
    this.vy = 0.2;
    this.vz = (world.random.next() - 0.5) * 0.1;
  }

  tick(world) {
    super.tick(world);
    if (this.removed) return;
    if (this.pickupDelay > 0) this.pickupDelay--;

    // Merge with nearby stacks so a mined vein does not become fifty entities.
    if ((world.tickCount + this.id) % 10 === 0) this.tryMerge(world);

    if (this.pickupDelay === 0) {
      const p = world.nearestPlayer(this.x, this.y, this.z, 2);
      if (p && !p.dead) this.tryPickup(world, p);
    }

    if (++this.ageTicks > ITEM_LIFETIME) world.removeEntity(this);
    if (this.y < MIN_Y - 8) world.removeEntity(this);
  }

  tryMerge(world) {
    for (const e of world.entities) {
      if (e === this || e.removed || !(e instanceof ItemEntity)) continue;
      if (!e.itemStack || !this.itemStack.matches(e.itemStack)) continue;
      const dx = e.x - this.x, dy = e.y - this.y, dz = e.z - this.z;
      if (dx * dx + dy * dy + dz * dz > 0.5 * 0.5) continue;
      const room = this.itemStack.maxStack - this.itemStack.count;
      if (room <= 0) continue;
      const move = Math.min(room, e.itemStack.count);
      this.itemStack.count += move;
      e.itemStack.count -= move;
      if (e.itemStack.count <= 0) world.removeEntity(e);
      this.pickupDelay = Math.max(this.pickupDelay, e.pickupDelay);
    }
  }

  tryPickup(world, player) {
    // Drift toward the player before being absorbed, as in the real game.
    const dx = player.x - this.x;
    const dy = (player.y + 0.6) - this.y;
    const dz = player.z - this.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > 1.4) {
      const pull = 0.06 / Math.max(0.4, d);
      this.vx += dx * pull; this.vy += dy * pull; this.vz += dz * pull;
      return;
    }
    const before = this.itemStack.count;
    const ok = player.inventory?.addItem?.(this.itemStack);
    if (ok === false && this.itemStack.count === before) return;
    if (this.itemStack.count <= 0 || ok === true) {
      world.playSound('item.pickup', this.x, this.y, this.z, 0.2,
        1.6 + world.random.next() * 0.4);
      world.spawnParticles('item_pickup', this.x, this.y, this.z, 1,
        { target: player });
      world.removeEntity(this);
    }
  }
}

export class ExperienceOrb extends Entity {
  constructor(world, x, y, z, value) {
    super(world, x, y, z, { type: 'xp_orb', width: 0.5, height: 0.5 });
    this.renderKind = 'xp_orb';
    this.value = value;
    this.ageTicks = 0;
    this.noHit = true;
    this.shadowRadius = 0.1;
    this.vy = 0.2;
    this.vx = (world.random.next() - 0.5) * 0.2;
    this.vz = (world.random.next() - 0.5) * 0.2;
  }

  tick(world) {
    super.tick(world);
    if (this.removed) return;
    const p = world.nearestPlayer(this.x, this.y, this.z, 8);
    if (p && !p.dead) {
      const dx = p.x - this.x, dy = (p.y + 0.8) - this.y, dz = p.z - this.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1) {
        world.playSound('orb.pickup', this.x, this.y, this.z, 0.15, 1.6);
        world.game?.modules?.experience?.addXp?.(p, this.value) ??
          (p.xp = (p.xp ?? 0) + this.value);
        world.removeEntity(this);
        return;
      }
      const pull = 0.1 / Math.max(1, d);
      this.vx += dx * pull; this.vy += dy * pull; this.vz += dz * pull;
    }
    if (++this.ageTicks > ITEM_LIFETIME) world.removeEntity(this);
  }
}

/** Split an XP amount into orbs of vanilla-ish denominations. */
export function spawnOrbs(world, x, y, z, amount) {
  const sizes = [17, 7, 3, 1];
  let left = Math.floor(amount);
  const out = [];
  while (left > 0) {
    const s = sizes.find((v) => v <= left) ?? 1;
    left -= s;
    out.push(world.addEntity(new ExperienceOrb(world, x, y, z, s)));
    if (out.length > 40) break;   // never flood the world with orbs
  }
  return out;
}

export class FallingBlockEntity extends Entity {
  constructor(world, x, y, z, state) {
    super(world, x, y, z, { type: 'falling_block', width: 0.98, height: 0.98 });
    this.renderKind = 'falling_block';
    this.blockState = state;
    this.blockName = blockOf(state)?.name ?? 'sand';
    this.noHit = true;
    this.fallTicks = 0;
  }

  tick(world) {
    super.tick(world);
    if (this.removed) return;
    this.fallTicks++;
    const bx = Math.floor(this.x), by = Math.floor(this.y), bz = Math.floor(this.z);
    // Land as soon as there is something solid directly beneath.
    if (this.onGround || T.solid[world.getBlock(bx, by - 1, bz)]) {
      const here = world.getBlock(bx, by, bz);
      if (here === 0 || T.replaceable[here]) {
        world.setBlock(bx, by, bz, this.blockState);
      } else {
        // Nowhere to settle: drop it as an item instead of losing it.
        const def = blockOf(this.blockState);
        if (def?.item && itemsByName.has(def.item)) {
          world.game?.spawnItem?.(world, this.x, this.y, this.z,
            new ItemStack(def.item, 1));
        }
      }
      world.playSound(`place.${blockOf(this.blockState)?.sound ?? 'sand'}`,
        this.x, this.y, this.z);
      world.removeEntity(this);
      return;
    }
    if (this.fallTicks > 600 || this.y < MIN_Y - 8) world.removeEntity(this);
  }
}

export class PrimedTnt extends Entity {
  constructor(world, x, y, z, igniter, fuse = 80) {
    super(world, x, y, z, { type: 'tnt', width: 0.98, height: 0.98 });
    this.renderKind = 'falling_block';
    this.blockName = 'tnt';
    this.blockState = blocksByName.get('tnt')?.defaultState ?? 0;
    this.fuse = fuse;
    this.igniter = igniter ?? null;
    this.noHit = true;
    this.vy = 0.2;
    this.vx = (world.random.next() - 0.5) * 0.04;
    this.vz = (world.random.next() - 0.5) * 0.04;
  }

  tick(world) {
    super.tick(world);
    if (this.removed) return;
    world.spawnParticles('smoke', this.x, this.y + 0.6, this.z, 1);
    if (--this.fuse <= 0) {
      world.removeEntity(this);
      const explode = world.game?.modules?.combat?.explode;
      if (explode) explode(world, this.x, this.y + 0.5, this.z, 4, { fire: false });
      else world.playSound('explosion', this.x, this.y, this.z, 4, 1);
    }
  }
}

/**
 * Arrows, snowballs, eggs, ender pearls, fireballs — anything that flies in a
 * straight line and does something on impact.
 */
export class ProjectileEntity extends Entity {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, {
      type: opts.type ?? 'arrow', width: 0.25, height: 0.25,
    });
    this.renderKind = opts.renderKind ?? 'item';
    this.itemStack = opts.stack ?? null;
    this.owner = opts.owner ?? null;
    this.damage = opts.damage ?? 2;
    this.gravityScale = opts.gravityScale ?? 1;
    this.knockback = opts.knockback ?? 0;
    this.fire = !!opts.fire;
    this.onImpact = opts.onImpact ?? null;
    this.pickupable = opts.pickupable ?? false;
    this.noHit = true;
    this.ageTicks = 0;
    this.stuck = false;
  }

  /** Launch along a direction with a given speed and inaccuracy. */
  shoot(dx, dy, dz, speed, spread = 0) {
    const len = Math.hypot(dx, dy, dz) || 1;
    const r = this.world.random;
    this.vx = dx / len * speed + (spread ? r.gaussian() * spread : 0);
    this.vy = dy / len * speed + (spread ? r.gaussian() * spread : 0);
    this.vz = dz / len * speed + (spread ? r.gaussian() * spread : 0);
    return this;
  }

  tick(world) {
    if (this.stuck) {
      // A stuck arrow can be picked up for a while, then despawns.
      if (++this.ageTicks > 1200) world.removeEntity(this);
      if (this.pickupable) {
        const p = world.nearestPlayer(this.x, this.y, this.z, 1.5);
        if (p && p.inventory?.addItem?.(new ItemStack('arrow', 1))) {
          world.playSound('item.pickup', this.x, this.y, this.z, 0.2, 1.8);
          world.removeEntity(this);
        }
      }
      return;
    }

    // Sweep from the current position to the next for a hit, so fast
    // projectiles cannot tunnel through a target or a wall.
    const nx = this.x + this.vx, ny = this.y + this.vy, nz = this.z + this.vz;
    const hitEntity = this.sweepEntities(world, nx, ny, nz);
    if (hitEntity) { this.impactEntity(world, hitEntity); return; }

    const hit = world.raycast(this.x, this.y, this.z, this.vx, this.vy, this.vz,
      Math.hypot(this.vx, this.vy, this.vz), { collision: true });
    if (hit) { this.impactBlock(world, hit); return; }

    this.x = nx; this.y = ny; this.z = nz;
    this.vy -= 0.05 * this.gravityScale;
    this.vx *= 0.99; this.vy *= 0.99; this.vz *= 0.99;
    this.updateBounds?.();
    world.updateEntityChunk(this);

    if (++this.ageTicks > 1200 || this.y < MIN_Y - 8) world.removeEntity(this);
  }

  sweepEntities(world, nx, ny, nz) {
    SWEEP.set(Math.min(this.x, nx) - 0.3, Math.min(this.y, ny) - 0.3,
      Math.min(this.z, nz) - 0.3, Math.max(this.x, nx) + 0.3,
      Math.max(this.y, ny) + 0.3, Math.max(this.z, nz) + 0.3);
    let best = null, bestD = Infinity;
    for (const e of world.entities) {
      if (e === this || e === this.owner || e.removed || e.noHit) continue;
      if (!e.aabb || !e.aabb.intersects(SWEEP)) continue;
      const d = (e.x - this.x) ** 2 + (e.y - this.y) ** 2 + (e.z - this.z) ** 2;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  impactEntity(world, target) {
    if (target.hurt) {
      target.hurt(this.damage, this.type, this.owner);
      if (this.fire) target.fireTicks = Math.max(target.fireTicks ?? 0, 100);
      if (this.knockback) {
        const len = Math.hypot(this.vx, this.vz) || 1;
        target.vx += (this.vx / len) * this.knockback * 0.6;
        target.vz += (this.vz / len) * this.knockback * 0.6;
      }
    }
    world.playSound('arrow.hit', this.x, this.y, this.z, 0.5, 1.2);
    this.onImpact?.(world, this, { entity: target });
    world.removeEntity(this);
  }

  impactBlock(world, hit) {
    this.x = hit.px; this.y = hit.py; this.z = hit.pz;
    this.vx = this.vy = this.vz = 0;
    this.stuck = true;
    this.ageTicks = 0;
    world.playSound('arrow.hit', this.x, this.y, this.z, 0.4, 1.0);
    this.onImpact?.(world, this, { block: hit });
    if (!this.pickupable) world.removeEntity(this);
  }
}

const SWEEP = new AABB();

/** Fire an arrow from a shooter's eye along its look direction. */
export function shootArrow(world, shooter, opts = {}) {
  const dir = shooter.lookVector ? shooter.lookVector() : { x: 0, y: 0, z: 1 };
  const e = new ProjectileEntity(world,
    shooter.eyeX ?? shooter.x, shooter.eyeY ?? shooter.y + 1.4, shooter.eyeZ ?? shooter.z, {
      type: 'arrow', owner: shooter, damage: opts.damage ?? 2,
      pickupable: opts.pickupable ?? true, fire: opts.fire,
      knockback: opts.knockback ?? 0,
      stack: itemsByName.has('arrow') ? new ItemStack('arrow', 1) : null,
    });
  e.shoot(dir.x, dir.y, dir.z, opts.speed ?? 2.4, opts.spread ?? 0);
  world.addEntity(e);
  world.playSound('bow.shoot', shooter.x, shooter.y, shooter.z);
  return e;
}

/** Ranged mob attacks route through here, so every projectile behaves alike. */
export function shootAt(world, shooter, target, kind = 'arrow') {
  const sx = shooter.x, sy = shooter.y + (shooter.height ?? 1.8) * 0.6, sz = shooter.z;
  const tx = target.x, ty = target.y + (target.height ?? 1.8) * 0.5, tz = target.z;
  const dx = tx - sx, dz = tz - sz;
  const dist = Math.hypot(dx, dz);
  // Aim slightly high so gravity brings the shot down onto the target.
  const dy = (ty - sy) + dist * 0.12;

  const spec = {
    arrow: { damage: 3, speed: 1.6, spread: 0.02, gravityScale: 1, pickupable: true },
    snowball: { damage: 0, speed: 1.2, spread: 0.03, gravityScale: 1 },
    small_fireball: { damage: 5, speed: 1.0, spread: 0.05, gravityScale: 0, fire: true },
    fireball: { damage: 6, speed: 0.8, spread: 0.04, gravityScale: 0, fire: true },
    wither_skull: { damage: 8, speed: 1.2, spread: 0.02, gravityScale: 0 },
    shulker_bullet: { damage: 4, speed: 0.6, spread: 0, gravityScale: 0 },
    guardian_beam: { damage: 6, speed: 2.0, spread: 0, gravityScale: 0 },
    splash_potion: { damage: 1, speed: 0.9, spread: 0.03, gravityScale: 1 },
  }[kind] ?? { damage: 2, speed: 1.4, spread: 0.03, gravityScale: 1 };

  const e = new ProjectileEntity(world, sx, sy, sz, {
    type: kind, owner: shooter, ...spec,
    stack: itemsByName.has(kind) ? new ItemStack(kind, 1) : null,
  });
  e.shoot(dx, dy, dz, spec.speed, spec.spread);
  world.addEntity(e);
  return e;
}

export { ITEM_LIFETIME };
