// The player: movement, camera, and block interaction.
//
// Movement reproduces Minecraft's feel closely — the same acceleration model,
// the same 0.6 friction on ground, sprint/sneak modifiers, step-up, swimming,
// ladders, and flight. It runs on a fixed 20 Hz tick with render-time
// interpolation, which is what keeps the motion stable regardless of frame rate.

import { AABB, clamp, lerp, wrapAngle } from '../core/math.js';
import { T, blockOf, TOOL } from '../world/blocks.js';
import { MIN_Y, MAX_Y, SEA_LEVEL } from '../world/chunk.js';
import { breakTime, isCorrectTool, canHarvest, ItemStack } from '../game/items.js';

export const GAMEMODE = { SURVIVAL: 0, CREATIVE: 1, ADVENTURE: 2, SPECTATOR: 3 };

const WIDTH = 0.6;
const HEIGHT = 1.8;
const SNEAK_HEIGHT = 1.5;
const SWIM_HEIGHT = 0.6;
const EYE_HEIGHT = 1.62;
const SNEAK_EYE = 1.27;
const SWIM_EYE = 0.4;

// Minecraft's per-tick constants (blocks/tick and blocks/tick^2).
const GRAVITY = 0.08;
const DRAG = 0.98;
const GROUND_FRICTION = 0.6;
const AIR_ACCEL = 0.02;
const JUMP_VELOCITY = 0.42;
const SPRINT_JUMP_BOOST = 0.2;
const WATER_GRAVITY = 0.02;
const WATER_DRAG = 0.8;
const LAVA_DRAG = 0.5;
const STEP_HEIGHT = 0.6;
const TERMINAL_VELOCITY = -3.92;

export class Player {
  constructor(world, opts = {}) {
    this.world = world;
    this.isPlayer = true;
    this.name = opts.name || 'Steve';

    this.x = opts.x ?? 0;
    this.y = opts.y ?? 80;
    this.z = opts.z ?? 0;
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.prevYaw = 0;
    this.prevPitch = 0;
    this.bodyYaw = 0;

    this.onGround = false;
    this.sneaking = false;
    this.sprinting = false;
    this.swimming = false;
    this.crawling = false;
    this.flying = false;
    this.canFly = false;
    this.inWater = false;
    this.inLava = false;
    this.underwater = false;
    this.onLadder = false;
    this.inCobweb = false;
    this.inPortal = false;
    this.portalTime = 0;
    this.fallDistance = 0;
    this.jumpCooldown = 0;
    this.airSupply = 300;
    this.maxAirSupply = 300;

    this.gamemode = opts.gamemode ?? GAMEMODE.SURVIVAL;
    this.health = 20;
    this.maxHealth = 20;
    this.absorption = 0;
    this.food = 20;
    this.saturation = 5;
    this.exhaustion = 0;
    this.xp = 0;
    this.xpLevel = 0;
    this.xpProgress = 0;
    this.dead = false;
    this.deathMessage = '';
    this.hurtTime = 0;
    this.invulnerableTime = 0;
    this.spawnPoint = null;
    this.effects = new Map();

    this.aabb = new AABB();
    this.reach = 5;
    this.perspective = 0;       // 0 first person, 1 back, 2 front
    this.selectedSlot = 0;
    this.inventory = null;      // set by the game once inventory.js is loaded

    // Interaction state
    this.breaking = null;       // {x,y,z,state,progress,total}
    this.breakCooldown = 0;
    this.placeCooldown = 0;
    this.attackCooldown = 0;
    this.attackStrength = 1;
    this.swingProgress = 0;
    this.swinging = false;
    this.usingItem = null;
    this.useTicks = 0;

    // Animation
    this.walkDist = 0;
    this.prevWalkDist = 0;
    this.bobbing = 0;
    this.tiltFov = 0;

    this.updateBounds();
  }

  // -- Geometry ------------------------------------------------------------

  get height() {
    if (this.swimming || this.crawling) return SWIM_HEIGHT;
    if (this.sneaking) return SNEAK_HEIGHT;
    return HEIGHT;
  }

  get eyeHeight() {
    if (this.swimming || this.crawling) return SWIM_EYE;
    if (this.sneaking) return SNEAK_EYE;
    return EYE_HEIGHT;
  }

  updateBounds() {
    const h = WIDTH / 2;
    this.aabb.set(this.x - h, this.y, this.z - h,
      this.x + h, this.y + this.height, this.z + h);
  }

  get eyeX() { return this.x; }
  get eyeY() { return this.y + this.eyeHeight; }
  get eyeZ() { return this.z; }

  /** Interpolated eye position for rendering between ticks. */
  renderEye(alpha, out = {}) {
    out.x = lerp(this.prevX, this.x, alpha);
    out.y = lerp(this.prevY, this.y, alpha) + this.eyeHeight;
    out.z = lerp(this.prevZ, this.z, alpha);
    return out;
  }

  lookVector(out = {}) {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    out.x = -Math.sin(this.yaw) * cp;
    out.y = sp;
    out.z = Math.cos(this.yaw) * cp;
    return out;
  }

  // -- Input ---------------------------------------------------------------

  applyLook(dYaw, dPitch) {
    this.yaw = wrapAngle(this.yaw + dYaw);
    this.pitch = clamp(this.pitch + dPitch, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
  }

  /**
   * One 20 Hz tick.
   * @param {object} cmd {forward, strafe, jump, sneak, sprint} with forward/strafe in -1..1
   */
  tick(cmd) {
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;
    this.prevYaw = this.yaw; this.prevPitch = this.pitch;
    this.prevWalkDist = this.walkDist;

    if (this.dead) { this.updateBounds(); return; }

    this.updateFluidState();
    this.updateStance(cmd);

    if (this.gamemode === GAMEMODE.SPECTATOR) {
      this.tickSpectator(cmd);
    } else if (this.flying) {
      this.tickFlying(cmd);
    } else if (this.inWater && !this.onLadder) {
      this.tickInWater(cmd);
    } else if (this.inLava) {
      this.tickInLava(cmd);
    } else {
      this.tickWalking(cmd);
    }

    this.updateBounds();
    this.tickTimers();
    this.applyBlockEffects();
  }

  updateStance(cmd) {
    const wasSneaking = this.sneaking;
    this.sneaking = !!cmd.sneak && this.onGround && !this.flying;
    // Sprinting stops when you run out of food, hit a wall, or start sneaking.
    if (cmd.sprint && cmd.forward > 0 && !this.sneaking &&
      (this.food > 6 || this.gamemode === GAMEMODE.CREATIVE)) {
      this.sprinting = true;
    }
    if (cmd.forward <= 0 || this.sneaking ||
      (this.food <= 6 && this.gamemode === GAMEMODE.SURVIVAL)) {
      this.sprinting = false;
    }
    this.swimming = this.inWater && this.underwater && this.sprinting;
    if (wasSneaking !== this.sneaking) this.updateBounds();
  }

  tickWalking(cmd) {
    const jumping = !!cmd.jump;

    if (this.onLadder) {
      // Climbing clamps vertical speed and lets you hold position by not moving.
      this.vy = clamp(this.vy, -0.15, jumping ? 0.2 : 0.15);
      if (this.sneaking && this.vy < 0) this.vy = 0;
    }

    if (jumping && this.jumpCooldown === 0) {
      if (this.onGround) {
        this.vy = JUMP_VELOCITY + this.jumpBoostBonus();
        if (this.sprinting) {
          this.vx -= Math.sin(this.yaw) * SPRINT_JUMP_BOOST;
          this.vz += Math.cos(this.yaw) * SPRINT_JUMP_BOOST;
        }
        this.jumpCooldown = 2;
        this.addExhaustion(this.sprinting ? 0.2 : 0.05);
      } else if (this.onLadder) {
        this.vy = 0.2;
      }
    }

    const blockBelow = this.world.getBlock(Math.floor(this.x),
      Math.floor(this.y - 0.2), Math.floor(this.z));
    const def = blockOf(blockBelow);
    const slip = this.onGround && def ? def.slipperiness : 0.6;
    const friction = this.onGround ? slip * GROUND_FRICTION : 1;
    // Minecraft's acceleration is inversely proportional to the cube of the
    // friction, which is why ice feels floaty rather than merely slippery.
    const accel = this.onGround
      ? this.moveSpeed() * (0.16277136 / (friction * friction * friction))
      : AIR_ACCEL * (this.sprinting ? 1.3 : 1);

    this.accelerate(cmd.forward, cmd.strafe, accel);

    if (!this.onLadder) {
      this.vy -= GRAVITY * this.gravityScale();
      this.vy *= DRAG;
      if (this.vy < TERMINAL_VELOCITY) this.vy = TERMINAL_VELOCITY;
    }

    this.moveWithCollision(this.vx, this.vy, this.vz);

    this.vx *= friction * (this.onGround ? 1 : 0.91);
    this.vz *= friction * (this.onGround ? 1 : 0.91);
    if (!this.onGround) { this.vx *= 0.91 / (friction || 1); this.vz *= 0.91 / (friction || 1); }
    if (this.inCobweb) { this.vx *= 0.25; this.vy *= 0.05; this.vz *= 0.25; }

    this.accumulateWalkDistance();
  }

  tickInWater(cmd) {
    const drag = WATER_DRAG + (this.depthStrider() * 0.054);
    let accel = 0.02 * (this.sprinting ? 1.3 : 1);
    if (this.swimming) accel = 0.03;
    this.accelerate(cmd.forward, cmd.strafe, accel);
    // Swimming forward while looking up/down moves you along the look vector.
    if (this.swimming) {
      const look = this.lookVector();
      this.vx += look.x * 0.01 * cmd.forward;
      this.vy += look.y * 0.02 * cmd.forward;
      this.vz += look.z * 0.01 * cmd.forward;
    }
    if (cmd.jump) this.vy += 0.04;
    else if (cmd.sneak) this.vy -= 0.04;
    this.vy -= WATER_GRAVITY;
    this.moveWithCollision(this.vx, this.vy, this.vz);
    this.vx *= Math.min(drag, 0.96);
    this.vy *= 0.8;
    this.vz *= Math.min(drag, 0.96);
    this.fallDistance = 0;
    this.accumulateWalkDistance();
  }

  tickInLava(cmd) {
    this.accelerate(cmd.forward, cmd.strafe, 0.02);
    if (cmd.jump) this.vy += 0.04;
    this.vy -= 0.02;
    this.moveWithCollision(this.vx, this.vy, this.vz);
    this.vx *= LAVA_DRAG;
    this.vy *= LAVA_DRAG;
    this.vz *= LAVA_DRAG;
    this.fallDistance = 0;
  }

  tickFlying(cmd) {
    const speed = (this.sprinting ? 0.22 : 0.11) * (this.flySpeedMultiplier ?? 1);
    this.accelerate(cmd.forward, cmd.strafe, speed);
    if (cmd.jump) this.vy = speed * 5.5;
    else if (cmd.sneak) this.vy = -speed * 5.5;
    else this.vy *= 0.6;
    this.moveWithCollision(this.vx, this.vy, this.vz);
    this.vx *= 0.6; this.vz *= 0.6;
    this.fallDistance = 0;
    if (this.onGround && !cmd.jump) this.flying = false;
  }

  tickSpectator(cmd) {
    const speed = this.sprinting ? 0.6 : 0.25;
    this.accelerate(cmd.forward, cmd.strafe, speed);
    if (cmd.jump) this.vy = speed * 4;
    else if (cmd.sneak) this.vy = -speed * 4;
    else this.vy *= 0.5;
    // Spectators pass through everything.
    this.x += this.vx; this.y += this.vy; this.z += this.vz;
    this.vx *= 0.5; this.vz *= 0.5;
    this.onGround = false;
  }

  moveSpeed() {
    let s = 0.1;
    if (this.sprinting) s *= 1.3;
    if (this.sneaking) s *= 0.3;
    const speedEffect = this.effects.get('speed');
    if (speedEffect) s *= 1 + 0.2 * (speedEffect.amplifier + 1);
    const slow = this.effects.get('slowness');
    if (slow) s *= Math.max(0, 1 - 0.15 * (slow.amplifier + 1));
    return s;
  }

  gravityScale() {
    if (this.effects.has('slow_falling') && this.vy < 0) return 0.0125 / GRAVITY;
    if (this.effects.has('levitation')) return -1;
    return 1;
  }

  jumpBoostBonus() {
    const e = this.effects.get('jump_boost');
    return e ? 0.1 * (e.amplifier + 1) : 0;
  }

  depthStrider() {
    return this.inventory?.getArmor?.(3)?.getEnchantLevel('depth_strider') ?? 0;
  }

  /** Convert forward/strafe input into world-space acceleration. */
  accelerate(forward, strafe, accel) {
    let f = forward, s = strafe;
    const len = Math.hypot(f, s);
    if (len < 0.01) return;
    if (len > 1) { f /= len; s /= len; }
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    this.vx += (-sin * f - cos * s) * accel;
    this.vz += (cos * f - sin * s) * accel;
  }

  // -- Collision -----------------------------------------------------------

  moveWithCollision(dx, dy, dz) {
    const world = this.world;
    const box = this.aabb;
    const startY = this.y;
    const wasOnGround = this.onGround;

    // Sneak edge-guard: shrink the horizontal move until it no longer walks the
    // player off the block they are standing on.
    if (this.sneaking && this.onGround && dy <= 0) {
      const step = 0.05;
      while (dx !== 0 && this.noGroundAt(box, dx, 0)) {
        dx = Math.abs(dx) < step ? 0 : dx - Math.sign(dx) * step;
      }
      while (dz !== 0 && this.noGroundAt(box, 0, dz)) {
        dz = Math.abs(dz) < step ? 0 : dz - Math.sign(dz) * step;
      }
      while (dx !== 0 && dz !== 0 && this.noGroundAt(box, dx, dz)) {
        dx = Math.abs(dx) < step ? 0 : dx - Math.sign(dx) * step;
        dz = Math.abs(dz) < step ? 0 : dz - Math.sign(dz) * step;
      }
    }

    const origDx = dx, origDy = dy, origDz = dz;
    const query = QUERY_BOX.copyFrom(box).expand(dx, dy, dz, QUERY_BOX);
    const boxes = world.getCollisionBoxes(query, collisionScratch);

    // Y first, then X and Z, matching Minecraft's resolution order.
    for (const b of boxes) dy = b.clipY(box, dy);
    box.minY += dy; box.maxY += dy;

    for (const b of boxes) dx = b.clipX(box, dx);
    box.minX += dx; box.maxX += dx;

    for (const b of boxes) dz = b.clipZ(box, dz);
    box.minZ += dz; box.maxZ += dz;

    // Step-up: if we were blocked horizontally while on the ground, retry the
    // whole move raised by up to STEP_HEIGHT and keep it if it goes further.
    const blocked = (origDx !== dx) || (origDz !== dz);
    if (blocked && wasOnGround && origDy <= 0) {
      const saved = { minX: box.minX, minY: box.minY, minZ: box.minZ,
        maxX: box.maxX, maxY: box.maxY, maxZ: box.maxZ };
      const savedDx = dx, savedDz = dz;

      box.set(saved.minX - dx, saved.minY - dy, saved.minZ - dz,
        saved.maxX - dx, saved.maxY - dy, saved.maxZ - dz);
      let sy = STEP_HEIGHT;
      const stepQuery = QUERY_BOX.copyFrom(box).expand(origDx, sy, origDz, QUERY_BOX);
      const stepBoxes = world.getCollisionBoxes(stepQuery, stepScratch);
      for (const b of stepBoxes) sy = b.clipY(box, sy);
      box.minY += sy; box.maxY += sy;

      let sdx = origDx, sdz = origDz;
      for (const b of stepBoxes) sdx = b.clipX(box, sdx);
      box.minX += sdx; box.maxX += sdx;
      for (const b of stepBoxes) sdz = b.clipZ(box, sdz);
      box.minZ += sdz; box.maxZ += sdz;

      // Settle back down onto the step.
      let down = -sy;
      for (const b of stepBoxes) down = b.clipY(box, down);
      box.minY += down; box.maxY += down;

      if (sdx * sdx + sdz * sdz > savedDx * savedDx + savedDz * savedDz) {
        dx = sdx; dz = sdz; dy = sy + down;
      } else {
        box.set(saved.minX, saved.minY, saved.minZ, saved.maxX, saved.maxY, saved.maxZ);
      }
    }

    this.x = box.centerX;
    this.y = box.minY;
    this.z = box.centerZ;

    this.onGround = origDy < 0 && dy !== origDy;
    if (this.onGround || dy !== origDy) {
      if (origDy < 0 && this.onGround) this.landed();
      this.vy = 0;
    }
    if (dx !== origDx) { this.vx = 0; if (this.sprinting && Math.abs(origDx) > 0.01) this.sprinting = false; }
    if (dz !== origDz) { this.vz = 0; if (this.sprinting && Math.abs(origDz) > 0.01) this.sprinting = false; }

    if (!this.onGround && this.vy < 0) this.fallDistance -= this.vy;
    this.world.updateEntityChunk(this);
  }

  /** True when moving by (dx,dz) would leave nothing solid under the player. */
  noGroundAt(box, dx, dz) {
    const probe = PROBE_BOX.set(box.minX + dx, box.minY - 0.02, box.minZ + dz,
      box.maxX + dx, box.minY, box.maxZ + dz);
    const found = this.world.getCollisionBoxes(probe, probeScratch);
    return found.length === 0;
  }

  landed() {
    if (this.fallDistance > 3 && this.gamemode === GAMEMODE.SURVIVAL &&
      !this.inWater && !this.effects.has('slow_falling')) {
      const feather = this.inventory?.getArmor?.(3)?.getEnchantLevel('feather_falling') ?? 0;
      const jump = this.effects.get('jump_boost');
      const reduce = jump ? (jump.amplifier + 1) : 0;
      let dmg = Math.floor(this.fallDistance - 3 - reduce);
      dmg = Math.floor(dmg * (1 - feather * 0.12));
      if (dmg > 0) this.hurt(dmg, 'fall');
    }
    if (this.fallDistance > 0.5) {
      const below = this.world.getBlock(Math.floor(this.x),
        Math.floor(this.y - 0.2), Math.floor(this.z));
      const def = blockOf(below);
      if (def) {
        this.world.playSound(`step.${def.sound}`, this.x, this.y, this.z, 0.5, 1);
        if (this.fallDistance > 3) {
          this.world.spawnParticles('block_dust', this.x, this.y, this.z,
            Math.min(20, Math.floor(this.fallDistance)), { state: below });
        }
      }
    }
    this.fallDistance = 0;
  }

  accumulateWalkDistance() {
    const dx = this.x - this.prevX, dz = this.z - this.prevZ;
    const d = Math.hypot(dx, dz);
    this.walkDist += d;
    if (this.gamemode === GAMEMODE.SURVIVAL && this.onGround && d > 0.001) {
      this.addExhaustion(this.sprinting ? 0.1 * d : (this.sneaking ? 0.0 : 0.01 * d));
    }
  }

  // -- Environment ---------------------------------------------------------

  updateFluidState() {
    const w = this.world;
    const box = this.aabb;
    this.inWater = w.isInFluid(box, 1);
    this.inLava = w.isInFluid(box, 2);
    const eyeState = w.getBlock(Math.floor(this.eyeX), Math.floor(this.eyeY), Math.floor(this.eyeZ));
    this.underwater = T.fluid[eyeState] === 1;
    this.eyeInLava = T.fluid[eyeState] === 2;

    const feet = w.getBlock(Math.floor(this.x), Math.floor(this.y + 0.1), Math.floor(this.z));
    const def = blockOf(feet);
    this.onLadder = !!def && def.climbable && !this.flying;
    this.inCobweb = def?.name === 'cobweb';
    const portal = def?.name === 'nether_portal';
    this.inPortal = portal;
    if (portal) this.portalTime = Math.min(1, this.portalTime + 0.02);
    else this.portalTime = Math.max(0, this.portalTime - 0.05);
  }

  get submergedIn() {
    if (this.underwater) return 'water';
    if (this.eyeInLava) return 'lava';
    return null;
  }

  applyBlockEffects() {
    if (this.gamemode !== GAMEMODE.SURVIVAL) return;
    const w = this.world;

    // Drowning
    if (this.underwater && !this.effects.has('water_breathing')) {
      const respiration = this.inventory?.getArmor?.(0)?.getEnchantLevel('respiration') ?? 0;
      if (respiration === 0 || w.random.int(respiration + 1) === 0) this.airSupply--;
      if (this.airSupply <= -20) { this.airSupply = 0; this.hurt(2, 'drown'); }
    } else if (this.airSupply < this.maxAirSupply) {
      this.airSupply = Math.min(this.maxAirSupply, this.airSupply + 4);
    }

    // Lava and fire
    if (this.inLava && !this.effects.has('fire_resistance')) {
      if (w.tickCount % 10 === 0) this.hurt(4, 'lava');
      this.fireTicks = Math.max(this.fireTicks || 0, 300);
    }
    if (this.fireTicks > 0) {
      this.fireTicks--;
      if (this.inWater || w.isRainingAt(Math.floor(this.x), Math.ceil(this.y), Math.floor(this.z))) {
        this.fireTicks = 0;
      } else if (!this.effects.has('fire_resistance') && this.fireTicks % 20 === 0) {
        this.hurt(1, 'fire');
      }
    }

    // Suffocation inside a block
    const head = w.getBlock(Math.floor(this.eyeX), Math.floor(this.eyeY), Math.floor(this.eyeZ));
    if (T.solid[head] && T.opaque[head]) this.hurt(1, 'suffocate');

    // Cactus and other contact damage
    const box = this.aabb.grow(-0.001, -0.001, -0.001, CONTACT_BOX);
    for (let y = Math.floor(box.minY); y <= Math.floor(box.maxY); y++) {
      for (let z = Math.floor(box.minZ); z <= Math.floor(box.maxZ); z++) {
        for (let x = Math.floor(box.minX); x <= Math.floor(box.maxX); x++) {
          const d = blockOf(w.getBlock(x, y, z));
          if (d?.onEntityInside) d.onEntityInside(w, x, y, z, this);
        }
      }
    }

    // The void
    if (this.y < MIN_Y - 18) this.hurt(4, 'void');
  }

  tickTimers() {
    if (this.jumpCooldown > 0) this.jumpCooldown--;
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.invulnerableTime > 0) this.invulnerableTime--;
    if (this.breakCooldown > 0) this.breakCooldown--;
    if (this.placeCooldown > 0) this.placeCooldown--;
    if (this.attackCooldown < 1) {
      this.attackCooldown = Math.min(1, this.attackCooldown + 1 / this.attackSpeedTicks());
    }
    if (this.swinging) {
      this.swingProgress += 1 / 6;
      if (this.swingProgress >= 1) { this.swingProgress = 0; this.swinging = false; }
    }
    for (const [id, e] of this.effects) {
      if (--e.duration <= 0) this.effects.delete(id);
    }
  }

  attackSpeedTicks() {
    const stack = this.heldItem();
    const speed = stack?.item?.attackSpeed ?? 4;
    return Math.max(1, 20 / speed);
  }

  // -- Health & food -------------------------------------------------------

  hurt(amount, source = 'generic') {
    if (this.dead || this.gamemode === GAMEMODE.CREATIVE ||
      this.gamemode === GAMEMODE.SPECTATOR) return false;
    if (this.invulnerableTime > 0 && source !== 'void') return false;
    const reduced = this.applyArmor(amount, source);
    if (this.absorption > 0) {
      const taken = Math.min(this.absorption, reduced);
      this.absorption -= taken;
      this.health -= reduced - taken;
    } else {
      this.health -= reduced;
    }
    this.hurtTime = 10;
    this.invulnerableTime = 10;
    this.world.playSound('player.hurt', this.x, this.y, this.z);
    if (this.health <= 0) this.die(source);
    return true;
  }

  applyArmor(amount, source) {
    if (BYPASSES_ARMOR.has(source)) return amount;
    const inv = this.inventory;
    let defense = 0, toughness = 0;
    if (inv?.armorSlots) {
      for (const s of inv.armorSlots) {
        if (!s) continue;
        defense += s.item.defense || 0;
        toughness += s.item.toughness || 0;
      }
    }
    const resistance = this.effects.get('resistance');
    let dmg = amount * (1 - Math.min(20,
      Math.max(defense / 5, defense - amount / (2 + toughness / 4))) / 25);
    if (resistance) dmg *= 1 - 0.2 * (resistance.amplifier + 1);
    return Math.max(0, dmg);
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  addExhaustion(n) {
    if (this.gamemode !== GAMEMODE.SURVIVAL) return;
    this.exhaustion += n;
    while (this.exhaustion >= 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.food = Math.max(0, this.food - 1);
    }
  }

  die(source) {
    this.dead = true;
    this.health = 0;
    this.deathMessage = deathMessageFor(this.name, source);
    this.world.playSound('player.death', this.x, this.y, this.z);
  }

  respawn(x, y, z) {
    this.dead = false;
    this.health = this.maxHealth;
    this.food = 20;
    this.saturation = 5;
    this.exhaustion = 0;
    this.airSupply = this.maxAirSupply;
    this.fireTicks = 0;
    this.fallDistance = 0;
    this.effects.clear();
    this.vx = this.vy = this.vz = 0;
    this.x = x; this.y = y; this.z = z;
    this.prevX = x; this.prevY = y; this.prevZ = z;
    this.updateBounds();
  }

  // -- Items ---------------------------------------------------------------

  heldItem() { return this.inventory?.getSelected?.() ?? null; }
  offhandItem() { return this.inventory?.getOffhand?.() ?? null; }

  swing() {
    if (!this.swinging) { this.swinging = true; this.swingProgress = 0; }
  }

  /** Break progress, in 0..1, for the currently targeted block. */
  updateBreaking(hit, dt) {
    if (!hit) { this.breaking = null; return; }
    if (this.gamemode === GAMEMODE.CREATIVE) {
      this.breaking = { x: hit.x, y: hit.y, z: hit.z, progress: 1, total: 0 };
      return;
    }
    const def = blockOf(hit.state);
    if (!def) { this.breaking = null; return; }
    if (!this.breaking || this.breaking.x !== hit.x || this.breaking.y !== hit.y ||
      this.breaking.z !== hit.z) {
      const total = breakTime(def, this.heldItem(), {
        haste: this.effects.get('haste')?.amplifier != null
          ? this.effects.get('haste').amplifier + 1 : 0,
        miningFatigue: this.effects.get('mining_fatigue')?.amplifier != null
          ? this.effects.get('mining_fatigue').amplifier + 1 : 0,
        underwater: this.underwater,
        aquaAffinity: (this.inventory?.getArmor?.(0)?.getEnchantLevel('aqua_affinity') ?? 0) > 0,
        airborne: !this.onGround,
      });
      this.breaking = { x: hit.x, y: hit.y, z: hit.z, state: hit.state, progress: 0, total };
    }
    if (this.breaking.total === Infinity) return;
    if (this.breaking.total <= 0) { this.breaking.progress = 1; return; }
    this.breaking.progress = Math.min(1, this.breaking.progress + dt / this.breaking.total);
  }

  get breakStage() {
    if (!this.breaking || this.breaking.progress <= 0) return -1;
    return Math.min(9, Math.floor(this.breaking.progress * 10));
  }

  // -- Persistence ---------------------------------------------------------

  save() {
    return {
      x: this.x, y: this.y, z: this.z, yaw: this.yaw, pitch: this.pitch,
      health: this.health, food: this.food, saturation: this.saturation,
      exhaustion: this.exhaustion, xp: this.xp, xpLevel: this.xpLevel,
      xpProgress: this.xpProgress, gamemode: this.gamemode,
      selectedSlot: this.selectedSlot, spawnPoint: this.spawnPoint,
      airSupply: this.airSupply, flying: this.flying,
      effects: [...this.effects.entries()].map(([id, e]) =>
        ({ id, amplifier: e.amplifier, duration: e.duration })),
    };
  }

  load(d) {
    if (!d) return;
    Object.assign(this, {
      x: d.x, y: d.y, z: d.z, yaw: d.yaw, pitch: d.pitch,
      health: d.health ?? 20, food: d.food ?? 20,
      saturation: d.saturation ?? 5, exhaustion: d.exhaustion ?? 0,
      xp: d.xp ?? 0, xpLevel: d.xpLevel ?? 0, xpProgress: d.xpProgress ?? 0,
      gamemode: d.gamemode ?? GAMEMODE.SURVIVAL,
      selectedSlot: d.selectedSlot ?? 0, spawnPoint: d.spawnPoint ?? null,
      airSupply: d.airSupply ?? 300, flying: !!d.flying,
    });
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;
    this.effects.clear();
    for (const e of d.effects || []) {
      this.effects.set(e.id, { amplifier: e.amplifier, duration: e.duration });
    }
    this.updateBounds();
  }
}

const QUERY_BOX = new AABB();
const PROBE_BOX = new AABB();
const CONTACT_BOX = new AABB();
const collisionScratch = [];
const stepScratch = [];
const probeScratch = [];

const BYPASSES_ARMOR = new Set(['void', 'starve', 'drown', 'suffocate', 'magic', 'wither', 'fall']);

function deathMessageFor(name, source) {
  switch (source) {
    case 'fall': return `${name} fell from a high place`;
    case 'lava': return `${name} tried to swim in lava`;
    case 'fire': return `${name} went up in flames`;
    case 'drown': return `${name} drowned`;
    case 'suffocate': return `${name} suffocated in a wall`;
    case 'void': return `${name} fell out of the world`;
    case 'starve': return `${name} starved to death`;
    case 'cactus': return `${name} was pricked to death`;
    case 'explosion': return `${name} blew up`;
    case 'arrow': return `${name} was shot`;
    case 'freeze': return `${name} froze to death`;
    default: return `${name} died`;
  }
}
