// Entity physics: swept-AABB movement against the world's collision boxes.
//
// Everything here reproduces Minecraft's per-tick movement model rather than a
// generic rigid-body solver: gravity is 0.08 blocks/tick^2 with 0.98 drag,
// collision is resolved one axis at a time (Y, then X, then Z), and horizontal
// friction depends on the block underfoot. Those specific numbers are what make
// jumping, sprinting and ice feel like the real game.
//
// The module is deliberately free of entity classes — it operates on any object
// exposing {world, x, y, z, vx, vy, vz, aabb, width, height, onGround}. That
// keeps item entities, arrows, boats and mobs on exactly the same solver.

import { AABB } from '../core/math.js';
import { T, blockOf } from '../world/blocks.js';
import { MIN_Y, MAX_Y } from '../world/chunk.js';

// --- Minecraft's movement constants (blocks/tick and blocks/tick^2) ---------

export const GRAVITY = 0.08;
export const DRAG = 0.98;
export const AIR_DRAG = 0.91;
export const GROUND_FRICTION = 0.6;
export const AIR_ACCEL = 0.02;
export const JUMP_VELOCITY = 0.42;
export const SPRINT_JUMP_BOOST = 0.2;
export const TERMINAL_VELOCITY = -3.92;
export const STEP_HEIGHT = 0.6;

export const WATER_GRAVITY = 0.02;
export const WATER_DRAG = 0.8;
export const WATER_ACCEL = 0.02;
export const LAVA_GRAVITY = 0.02;
export const LAVA_DRAG = 0.5;

export const ITEM_GRAVITY = 0.04;
export const PROJECTILE_GRAVITY = 0.03;
export const PROJECTILE_DRAG = 0.99;
export const PROJECTILE_WATER_DRAG = 0.6;

/** Below this speed a velocity component is snapped to zero. */
const EPSILON = 0.003;

// Scratch state. Movement never recurses, so module-level reuse is safe and
// keeps the hot path allocation-free.
const QUERY_BOX = new AABB();
const PROBE_BOX = new AABB();
const CONTACT_BOX = new AABB();
const collisionScratch = [];
const stepScratch = [];
const probeScratch = [];
const flowScratch = { x: 0, y: 0, z: 0 };

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

/**
 * Move `e` by (dx,dy,dz), sliding along whatever it hits.
 *
 * Axis order is Y, X, Z — the same order Minecraft resolves in, which is why
 * you can walk into a wall while falling and still land cleanly. When a
 * grounded entity is blocked horizontally the whole move is retried raised by
 * `e.stepHeight`, and the better of the two outcomes wins; that is the step-up
 * that lets mobs walk up slabs and stairs without jumping.
 *
 * Sets `e.onGround`, `e.horizontalCollision`, `e.verticalCollision` and
 * accumulates `e.fallDistance`.
 */
export function moveEntity(e, dx, dy, dz) {
  const world = e.world;
  if (!world) return;

  if (e.noClip) {
    e.x += dx; e.y += dy; e.z += dz;
    e.updateBounds();
    world.updateEntityChunk(e);
    return;
  }

  // Cobwebs slow a move down before it is even attempted.
  if (e.inCobweb) { dx *= 0.25; dy *= 0.05; dz *= 0.25; }

  const box = e.aabb;
  const wasOnGround = e.onGround;
  const origDx = dx, origDy = dy, origDz = dz;

  const query = QUERY_BOX.copyFrom(box).expand(dx, dy, dz, QUERY_BOX);
  const boxes = world.getCollisionBoxes(query, collisionScratch);

  for (let i = 0; i < boxes.length; i++) dy = boxes[i].clipY(box, dy);
  box.minY += dy; box.maxY += dy;

  for (let i = 0; i < boxes.length; i++) dx = boxes[i].clipX(box, dx);
  box.minX += dx; box.maxX += dx;

  for (let i = 0; i < boxes.length; i++) dz = boxes[i].clipZ(box, dz);
  box.minZ += dz; box.maxZ += dz;

  const blocked = (origDx !== dx) || (origDz !== dz);
  const step = e.stepHeight ?? STEP_HEIGHT;
  if (blocked && step > 0 && (wasOnGround || e.onGround) && origDy <= 0) {
    const sMinX = box.minX, sMinY = box.minY, sMinZ = box.minZ;
    const sMaxX = box.maxX, sMaxY = box.maxY, sMaxZ = box.maxZ;
    const flatDx = dx, flatDz = dz;

    // Rewind to the pre-move box and try again lifted by `step`.
    box.set(sMinX - dx, sMinY - dy, sMinZ - dz, sMaxX - dx, sMaxY - dy, sMaxZ - dz);
    let sy = step;
    const stepQuery = QUERY_BOX.copyFrom(box).expand(origDx, sy, origDz, QUERY_BOX);
    const stepBoxes = world.getCollisionBoxes(stepQuery, stepScratch);
    for (let i = 0; i < stepBoxes.length; i++) sy = stepBoxes[i].clipY(box, sy);
    box.minY += sy; box.maxY += sy;

    let sdx = origDx, sdz = origDz;
    for (let i = 0; i < stepBoxes.length; i++) sdx = stepBoxes[i].clipX(box, sdx);
    box.minX += sdx; box.maxX += sdx;
    for (let i = 0; i < stepBoxes.length; i++) sdz = stepBoxes[i].clipZ(box, sdz);
    box.minZ += sdz; box.maxZ += sdz;

    // Settle back down onto whatever we stepped onto.
    let down = -sy;
    for (let i = 0; i < stepBoxes.length; i++) down = stepBoxes[i].clipY(box, down);
    box.minY += down; box.maxY += down;

    if (sdx * sdx + sdz * sdz > flatDx * flatDx + flatDz * flatDz) {
      dx = sdx; dz = sdz; dy = sy + down;
    } else {
      box.set(sMinX, sMinY, sMinZ, sMaxX, sMaxY, sMaxZ);
    }
  }

  e.x = (box.minX + box.maxX) / 2;
  e.y = box.minY;
  e.z = (box.minZ + box.maxZ) / 2;

  e.horizontalCollision = (dx !== origDx) || (dz !== origDz);
  e.verticalCollision = dy !== origDy;
  e.collidedX = dx !== origDx;
  e.collidedZ = dz !== origDz;
  e.onGround = origDy <= 0 && e.verticalCollision;

  if (e.verticalCollision) {
    if (e.onGround && origDy < 0) onLanded(e);
    e.vy = 0;
  }
  if (e.collidedX) e.vx = 0;
  if (e.collidedZ) e.vz = 0;

  if (!e.onGround && dy < 0) e.fallDistance = (e.fallDistance || 0) - dy;
  else if (e.onGround) e.fallDistance = 0;

  world.updateEntityChunk(e);
}

function onLanded(e) {
  const fall = e.fallDistance || 0;
  e.fallDistance = 0;
  if (fall > 0.5 && e.onLand) e.onLand(fall);
}

/** True when nothing solid sits directly under the box offset by (dx,dz). */
export function noGroundAt(world, box, dx, dz) {
  PROBE_BOX.set(box.minX + dx, box.minY - 0.06, box.minZ + dz,
    box.maxX + dx, box.minY, box.maxZ + dz);
  return world.getCollisionBoxes(PROBE_BOX, probeScratch).length === 0;
}

/** Is there room for a box of this size at (x, y, z)? */
export function isFree(world, x, y, z, width, height) {
  const h = width / 2;
  PROBE_BOX.set(x - h, y, z - h, x + h, y + height, z + h);
  return world.getCollisionBoxes(PROBE_BOX, probeScratch).length === 0;
}

// ---------------------------------------------------------------------------
// Environment sampling
// ---------------------------------------------------------------------------

/**
 * Refresh the environment flags an entity's movement depends on: fluids,
 * ladders, cobwebs, the slipperiness of the block underfoot, and whether the
 * eyes are submerged.
 */
export function updateEnvironment(e, world) {
  const box = e.aabb;
  e.wasInWater = e.inWater;
  e.inWater = world.isInFluid(box, 1);
  e.inLava = world.isInFluid(box, 2);

  const ex = Math.floor(e.x);
  const ey = Math.floor(e.y + (e.eyeHeight ?? e.height * 0.85));
  const ez = Math.floor(e.z);
  const eyeState = world.getBlock(ex, ey, ez);
  e.underwater = T.fluid[eyeState] === 1 || T.waterlogged[eyeState] === 1;
  e.eyeInLava = T.fluid[eyeState] === 2;

  const feetState = world.getBlock(ex, Math.floor(e.y + 0.1), ez);
  const feetDef = blockOf(feetState);
  e.onLadder = !!feetDef && feetDef.climbable === true;
  e.inCobweb = feetDef?.name === 'cobweb';
  e.inPowderSnow = feetDef?.name === 'powder_snow';

  const belowState = world.getBlock(ex, Math.floor(e.y - 0.2), ez);
  const belowDef = blockOf(belowState);
  e.slipperiness = (e.onGround && belowDef) ? belowDef.slipperiness : 0.6;
  e.blockSpeedFactor = belowDef?.speedFactor ?? 1;
  e.blockBelowName = belowDef?.name ?? 'air';

  if (e.y < MIN_Y - 20) e.inVoid = true;
  return e;
}

/** Push an entity along the flow of the fluid it is standing in. */
export function applyFluidFlow(e, world, fluidId, strength = 0.014) {
  const box = e.aabb;
  const x0 = Math.floor(box.minX), x1 = Math.floor(box.maxX);
  const y0 = Math.floor(box.minY), y1 = Math.floor(box.maxY);
  const z0 = Math.floor(box.minZ), z1 = Math.floor(box.maxZ);
  let fx = 0, fz = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (T.fluid[world.getBlock(x, y, z)] !== fluidId) continue;
        world.fluidFlow(x, y, z, fluidId, flowScratch);
        fx += flowScratch.x; fz += flowScratch.z;
        n++;
      }
    }
  }
  if (n === 0) return false;
  const len = Math.hypot(fx, fz);
  if (len > 1e-5) {
    e.vx += (fx / len) * strength;
    e.vz += (fz / len) * strength;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The living-entity movement model
// ---------------------------------------------------------------------------

/**
 * Convert forward/strafe input (in -1..1, relative to `yaw`) into world-space
 * acceleration. Diagonal input is normalised so strafing is never faster.
 */
export function accelerate(e, forward, strafe, accel, yaw) {
  const len = Math.hypot(forward, strafe);
  if (len < 0.01 || accel === 0) return;
  let f = forward, s = strafe;
  if (len > 1) { f /= len; s /= len; }
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  e.vx += (-sin * f - cos * s) * accel;
  e.vz += (cos * f - sin * s) * accel;
}

/**
 * One tick of walking/swimming/climbing for a living entity.
 *
 * The caller sets `e.moveForward`, `e.moveStrafe`, `e.jumping` and
 * `e.movementSpeed` (blocks/tick at full input, 0.1 for a player walking); this
 * turns those into a completed, collided move.
 */
export function livingTravel(e, world) {
  const forward = e.moveForward || 0;
  const strafe = e.moveStrafe || 0;
  const yaw = e.moveYaw ?? e.yaw ?? 0;
  const gravity = GRAVITY * (e.gravityScale ?? 1);

  if (e.inWater && !e.onLadder) {
    const drag = e.waterDrag ?? WATER_DRAG;
    accelerate(e, forward, strafe, (e.waterSpeed ?? WATER_ACCEL) * (e.swimSpeed ?? 1), yaw);
    if (e.jumping) e.vy += 0.04;
    else if (e.sinks) e.vy -= 0.02;
    e.vy -= WATER_GRAVITY * (e.buoyancy ?? 1);
    moveEntity(e, e.vx, e.vy, e.vz);
    e.vx *= drag; e.vz *= drag;
    e.vy *= 0.8;
    if (!e.floats) e.vy -= 0.003;
    e.fallDistance = 0;
  } else if (e.inLava) {
    accelerate(e, forward, strafe, 0.02, yaw);
    if (e.jumping) e.vy += 0.04;
    e.vy -= LAVA_GRAVITY;
    moveEntity(e, e.vx, e.vy, e.vz);
    e.vx *= LAVA_DRAG; e.vy *= LAVA_DRAG; e.vz *= LAVA_DRAG;
    e.fallDistance = 0;
  } else if (e.flyingMob) {
    accelerate(e, forward, strafe, e.movementSpeed ?? 0.02, yaw);
    moveEntity(e, e.vx, e.vy, e.vz);
    const d = e.flyDrag ?? 0.91;
    e.vx *= d; e.vy *= d; e.vz *= d;
    e.fallDistance = 0;
  } else {
    // Ladders and vines clamp vertical speed, and let a climbing mob hold still.
    if (e.onLadder) {
      e.vy = Math.max(e.vy, -0.15);
      if (e.jumping || (e.horizontalCollision && e.climbs)) e.vy = 0.2;
      e.fallDistance = 0;
    }

    if (e.jumping && e.onGround && (e.jumpCooldown ?? 0) <= 0) {
      e.vy = JUMP_VELOCITY * (e.jumpPower ?? 1) + jumpBoost(e);
      const b = blockOf(world.getBlock(Math.floor(e.x), Math.floor(e.y - 0.2), Math.floor(e.z)));
      if (b) e.vy *= b.jumpFactor ?? 1;
      if (e.sprinting) {
        e.vx -= Math.sin(yaw) * SPRINT_JUMP_BOOST;
        e.vz += Math.cos(yaw) * SPRINT_JUMP_BOOST;
      }
      e.jumpCooldown = 10;
    }

    const slip = e.onGround ? e.slipperiness ?? 0.6 : 0.6;
    const friction = e.onGround ? slip * GROUND_FRICTION : 1;
    // Minecraft's ground acceleration is inversely proportional to the cube of
    // friction, which is what makes ice floaty rather than merely slippery.
    const accel = e.onGround
      ? (e.movementSpeed ?? 0.1) * (0.16277136 / (friction * friction * friction))
      : AIR_ACCEL * (e.sprinting ? 1.3 : 1) * (e.airControl ?? 1);

    accelerate(e, forward, strafe, accel, yaw);

    if (!e.onLadder) {
      e.vy -= gravity;
      e.vy *= DRAG;
      if (e.vy < TERMINAL_VELOCITY) e.vy = TERMINAL_VELOCITY;
    }

    moveEntity(e, e.vx, e.vy, e.vz);

    const horizontal = e.onGround ? slip * GROUND_FRICTION : AIR_DRAG;
    e.vx *= horizontal;
    e.vz *= horizontal;
  }

  if (Math.abs(e.vx) < EPSILON) e.vx = 0;
  if (Math.abs(e.vy) < EPSILON) e.vy = 0;
  if (Math.abs(e.vz) < EPSILON) e.vz = 0;
  if ((e.jumpCooldown ?? 0) > 0) e.jumpCooldown--;
}

function jumpBoost(e) {
  const eff = e.effects?.get?.('jump_boost');
  return eff ? 0.1 * (eff.amplifier + 1) : 0;
}

/**
 * Ballistic motion for thrown things: gravity, air drag, water drag, and no
 * step-up. Returns true when the entity is resting on the ground.
 */
export function projectileTravel(e, gravity = PROJECTILE_GRAVITY, drag = PROJECTILE_DRAG) {
  moveEntity(e, e.vx, e.vy, e.vz);
  const d = e.inWater ? PROJECTILE_WATER_DRAG : drag;
  e.vx *= d; e.vy *= d; e.vz *= d;
  e.vy -= gravity;
  return e.onGround;
}

/**
 * The bobbing, drifting motion of dropped items and experience orbs: they sink
 * slowly, slide off blocks, and come to rest with a little friction.
 */
export function itemTravel(e) {
  e.vy -= ITEM_GRAVITY * (e.gravityScale ?? 1);
  if (e.inWater) {
    e.vy += 0.06;          // items float up to the surface
    e.vx *= 0.99; e.vz *= 0.99;
    if (e.vy > 0.06) e.vy = 0.06;
  } else if (e.inLava) {
    e.vy += 0.05;
    e.vx *= 0.95; e.vz *= 0.95;
  }
  moveEntity(e, e.vx, e.vy, e.vz);
  let f = 0.98;
  if (e.onGround) {
    const b = blockOf(e.world.getBlock(Math.floor(e.x), Math.floor(e.y - 0.2), Math.floor(e.z)));
    f = (b ? b.slipperiness : 0.6) * 0.98;
  }
  e.vx *= f; e.vz *= f;
  if (e.onGround) e.vy *= -0.5;
  if (Math.abs(e.vx) < 1e-4) e.vx = 0;
  if (Math.abs(e.vz) < 1e-4) e.vz = 0;
}

// ---------------------------------------------------------------------------
// Contact effects
// ---------------------------------------------------------------------------

/**
 * Run `onEntityInside` for every block overlapping the entity — cactus damage,
 * berry-bush slowdown, portal entry, magma burns and so on all hang off this.
 */
export function applyBlockContacts(e, world) {
  const box = e.aabb.grow(-0.001, -0.001, -0.001, CONTACT_BOX);
  const x0 = Math.floor(box.minX), x1 = Math.floor(box.maxX);
  const y0 = Math.floor(box.minY), y1 = Math.floor(box.maxY);
  const z0 = Math.floor(box.minZ), z1 = Math.floor(box.maxZ);
  for (let y = y0; y <= y1; y++) {
    if (y < MIN_Y || y > MAX_Y) continue;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const st = world.getBlock(x, y, z);
        if (st === 0) continue;
        const def = blockOf(st);
        if (def?.onEntityInside) {
          try { def.onEntityInside(world, x, y, z, st, e); } catch { /* content bug */ }
        }
      }
    }
  }
}

/** Is the entity's head inside a solid opaque block? */
export function isSuffocating(e, world) {
  const st = world.getBlock(Math.floor(e.x),
    Math.floor(e.y + (e.eyeHeight ?? e.height * 0.85)), Math.floor(e.z));
  return T.solid[st] === 1 && T.opaque[st] === 1;
}

/** Exposed to open sky right now (used for zombies burning at dawn). */
export function isInDaylight(e, world) {
  if (!world.hasSkylight || !world.isDay()) return false;
  if (world.rainLevel > 0.4) return false;
  const x = Math.floor(e.x), z = Math.floor(e.z);
  const y = Math.floor(e.y + e.height * 0.5);
  return world.getSkyLight(x, y, z) >= 15;
}
