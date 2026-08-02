// The base entity: position, velocity, a bounding box, ticking and save/load.
//
// Everything that exists in the world and is not a block is an Entity — mobs,
// dropped items, arrows, boats, TNT, falling sand. The class deliberately stays
// small: it owns the state the renderer and the physics solver need, plus the
// hooks (`tick`, `save`, `load`) the game loop calls. Behaviour lives in the
// subclasses.

import { AABB, clamp, lerp, wrapAngle, approachAngle } from '../core/math.js';
import { MIN_Y, MAX_Y } from '../world/chunk.js';
import { T, blockOf } from '../world/blocks.js';
import {
  moveEntity, updateEnvironment, applyBlockContacts, itemTravel,
  isSuffocating, GRAVITY,
} from './physics.js';

/**
 * Model space in the renderer has its front along -Z, while entity yaw
 * measures a look direction of (-sin yaw, 0, cos yaw). This converts one to
 * the other; see `Entity.updateRenderYaws`.
 */
export const renderYawOf = (yaw) => Math.PI - yaw;

export class Entity {
  constructor(world, x = 0, y = 0, z = 0, opts = {}) {
    this.world = world;
    this.id = 0;
    this.type = opts.type || 'entity';
    this.removed = false;
    this.age = 0;

    this.x = x; this.y = y; this.z = z;
    this.prevX = x; this.prevY = y; this.prevZ = z;
    this.vx = 0; this.vy = 0; this.vz = 0;

    // `yaw`/`pitch` are the look direction; `bodyRot` is where the torso
    // points. `bodyYaw` is the value the renderer consumes and is kept
    // continuous (never wrapped) so interpolation across ±PI cannot spin.
    this.yaw = opts.yaw ?? 0;
    this.pitch = opts.pitch ?? 0;
    this.prevYaw = this.yaw;
    this.prevPitch = this.pitch;
    this.bodyRot = this.yaw;
    this.prevBodyRot = this.yaw;
    this.bodyYaw = renderYawOf(this.yaw);
    this.prevBodyYaw = this.bodyYaw;

    this.width = opts.width ?? 0.6;
    this.height = opts.height ?? 1.8;
    this.scale = opts.scale ?? 1;
    this.aabb = new AABB();

    this.onGround = false;
    this.horizontalCollision = false;
    this.verticalCollision = false;
    this.noClip = false;
    this.stepHeight = opts.stepHeight ?? 0;
    this.gravityScale = 1;
    this.fallDistance = 0;
    this.jumpCooldown = 0;

    this.inWater = false;
    this.inLava = false;
    this.underwater = false;
    this.onLadder = false;
    this.inCobweb = false;
    this.slipperiness = 0.6;
    this.fireTicks = 0;
    this.freezeTicks = 0;
    this.immuneToFire = false;
    this.invulnerable = false;

    this.chunk = null;
    this.persistent = false;   // never despawns (spawn eggs, name tags)
    this.customName = null;
    this.glowing = false;
    this.invisible = false;
    this.noHit = false;         // ignored by the player's entity raycast
    this.blocksPlacement = false;
    this.passengers = [];
    this.vehicle = null;

    // Animation state consumed by models.js.
    this.limbSwing = 0;
    this.limbSwingAmount = 0;
    this.prevLimbSwingAmount = 0;
    this.hurtTime = 0;
    this.walkDist = 0;
    this.prevWalkDist = 0;

    this.updateBounds();
  }

  // -- Geometry ------------------------------------------------------------

  get eyeHeight() { return this.height * 0.85; }
  get eyeX() { return this.x; }
  get eyeY() { return this.y + this.eyeHeight; }
  get eyeZ() { return this.z; }

  updateBounds() {
    const h = (this.width * this.scale) / 2;
    this.aabb.set(this.x - h, this.y, this.z - h,
      this.x + h, this.y + this.height * this.scale, this.z + h);
    return this.aabb;
  }

  setPosition(x, y, z) {
    this.x = x; this.y = y; this.z = z;
    this.updateBounds();
    this.world?.updateEntityChunk(this);
    return this;
  }

  /** Teleport without interpolating through the intervening space. */
  moveTo(x, y, z, yaw = this.yaw, pitch = this.pitch) {
    this.setPosition(x, y, z);
    this.prevX = x; this.prevY = y; this.prevZ = z;
    this.yaw = this.prevYaw = yaw;
    this.pitch = this.prevPitch = pitch;
    this.bodyRot = this.prevBodyRot = yaw;
    this.bodyYaw = this.prevBodyYaw = renderYawOf(yaw);
    return this;
  }

  distanceToSq(other) {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    const dz = this.z - other.z;
    return dx * dx + dy * dy + dz * dz;
  }

  distanceTo(other) { return Math.sqrt(this.distanceToSq(other)); }

  distanceToPosSq(x, y, z) {
    const dx = this.x - x, dy = this.y - y, dz = this.z - z;
    return dx * dx + dy * dy + dz * dz;
  }

  lookVector(out = {}) {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    out.x = -Math.sin(this.yaw) * cp;
    out.y = sp;
    out.z = Math.cos(this.yaw) * cp;
    return out;
  }

  /** Point the head (and optionally the body) at a world position. */
  lookAt(x, y, z, maxYawStep = Math.PI, maxPitchStep = Math.PI) {
    const dx = x - this.x;
    const dy = y - (this.y + this.eyeHeight);
    const dz = z - this.z;
    const flat = Math.hypot(dx, dz);
    const targetYaw = Math.atan2(-dx, dz);
    const targetPitch = Math.atan2(dy, flat);
    this.yaw = approachAngle(this.yaw, targetYaw, maxYawStep);
    this.pitch = clamp(approachAngle(this.pitch, targetPitch, maxPitchStep),
      -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  }

  // -- Ticking -------------------------------------------------------------

  /** Called once per world tick by the game loop. */
  tick(world) {
    this.baseTick(world || this.world);
  }

  baseTick(world) {
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;
    this.prevYaw = this.yaw; this.prevPitch = this.pitch;
    this.prevBodyRot = this.bodyRot;
    this.prevWalkDist = this.walkDist;
    this.prevLimbSwingAmount = this.limbSwingAmount;
    this.age++;
    if (this.hurtTime > 0) this.hurtTime--;

    updateEnvironment(this, world);
    this.tickFire(world);

    if (this.y < MIN_Y - 24) this.onOutOfWorld();
  }

  tickFire(world) {
    if (this.inLava && !this.immuneToFire) {
      this.fireTicks = Math.max(this.fireTicks, 300);
    }
    if (this.fireTicks > 0) {
      if (this.immuneToFire) { this.fireTicks = 0; return; }
      this.fireTicks--;
      if (this.inWater || world.isRainingAt(Math.floor(this.x),
        Math.ceil(this.y), Math.floor(this.z))) {
        this.fireTicks = 0;
      }
    }
  }

  onOutOfWorld() { this.remove(); }

  /** Refresh the render yaws after the body rotation has been updated. */
  updateRenderYaws() {
    this.prevBodyYaw = this.bodyYaw;
    const target = renderYawOf(this.bodyRot);
    this.bodyYaw = this.bodyYaw + wrapAngle(target - this.bodyYaw);
  }

  /** Accumulate the limb-swing phase models.js animates walk cycles from. */
  updateLimbSwing() {
    const dx = this.x - this.prevX;
    const dz = this.z - this.prevZ;
    const d = Math.hypot(dx, dz);
    this.walkDist += d;
    let amount = Math.min(1, d * 4);
    this.limbSwingAmount += (amount - this.limbSwingAmount) * 0.4;
    this.limbSwing += this.limbSwingAmount;
  }

  move(dx, dy, dz) { moveEntity(this, dx, dy, dz); }

  /** Simple item-like physics; used by drops, orbs and loose entities. */
  tickItemPhysics() { itemTravel(this); }

  applyContacts(world) { applyBlockContacts(this, world); }

  isSuffocating(world) { return isSuffocating(this, world || this.world); }

  // -- Interaction ---------------------------------------------------------

  /** Push this entity away from (x,z) — used by knockback and crowding. */
  push(dx, dy, dz) {
    this.vx += dx; this.vy += dy; this.vz += dz;
  }

  /** Mobs shove each other apart so a spawn pack does not stack in one cell. */
  pushOutOfEntities(world, strength = 0.05, max = 12) {
    const found = world.entitiesInBox(this.aabb, this, PUSH_SCRATCH);
    const n = Math.min(found.length, max);
    for (let i = 0; i < n; i++) {
      const o = found[i];
      if (!o.pushable || o.removed) continue;
      let dx = o.x - this.x, dz = o.z - this.z;
      let d = Math.hypot(dx, dz);
      if (d < 1e-4) { dx = (i % 2) ? 0.01 : -0.01; dz = 0.01; d = Math.hypot(dx, dz); }
      if (d > 2.5) continue;
      const f = (strength / Math.max(d, 0.2));
      this.vx -= (dx / d) * f;
      this.vz -= (dz / d) * f;
    }
    PUSH_SCRATCH.length = 0;
  }

  /** Right-click interaction; return true when the click was consumed. */
  interact(player, stack) { return false; }

  hurt(amount, source, attacker) { return false; }

  remove() {
    if (this.removed) return;
    this.removed = true;
    this.world?.removeEntity(this);
  }

  onAdded() {}
  onRemoved() {}

  // -- Persistence ---------------------------------------------------------

  save() {
    return {
      type: this.type,
      x: this.x, y: this.y, z: this.z,
      vx: this.vx, vy: this.vy, vz: this.vz,
      yaw: this.yaw, pitch: this.pitch, bodyRot: this.bodyRot,
      age: this.age, fireTicks: this.fireTicks,
      fallDistance: this.fallDistance,
      persistent: this.persistent,
      customName: this.customName,
    };
  }

  load(d) {
    if (!d) return this;
    this.x = d.x ?? this.x; this.y = d.y ?? this.y; this.z = d.z ?? this.z;
    this.vx = d.vx ?? 0; this.vy = d.vy ?? 0; this.vz = d.vz ?? 0;
    this.yaw = d.yaw ?? 0; this.pitch = d.pitch ?? 0;
    this.bodyRot = d.bodyRot ?? this.yaw;
    this.age = d.age ?? 0;
    this.fireTicks = d.fireTicks ?? 0;
    this.fallDistance = d.fallDistance ?? 0;
    this.persistent = !!d.persistent;
    this.customName = d.customName ?? null;
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;
    this.prevYaw = this.yaw; this.prevPitch = this.pitch;
    this.prevBodyRot = this.bodyRot;
    this.bodyYaw = this.prevBodyYaw = renderYawOf(this.bodyRot);
    this.updateBounds();
    return this;
  }

  toString() { return `${this.type}#${this.id}`; }
}

const PUSH_SCRATCH = [];

/**
 * Every entity kind registers a factory here so saved worlds can be rebuilt
 * and `/summon`-style commands work without importing every module.
 */
export const entityFactories = new Map();

export function registerEntityType(name, factory) {
  entityFactories.set(name, factory);
  return name;
}

export function createEntity(name, world, x, y, z, opts) {
  const f = entityFactories.get(name);
  return f ? f(world, x, y, z, opts) : null;
}

export function entityFromSave(world, data) {
  if (!data?.type) return null;
  const e = createEntity(data.type, world, data.x ?? 0, data.y ?? 0, data.z ?? 0);
  if (!e) return null;
  e.load(data);
  return e;
}
