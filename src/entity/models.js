// Entity models: trees of boxes, plus the animation that poses them.
//
// A model is a `ModelPart` hierarchy. Each part has a pivot, a rotation, and a
// list of cubes in 1/16-block units; the renderer bakes the cubes once and then
// only uploads per-part matrices, so animating a hundred mobs costs a hundred
// small matrix chains and no vertex work.
//
// Coordinate conventions (these matter, the renderer depends on them):
//   * +Y is up and the model origin sits at the entity's feet, so a 32-unit
//     tall humanoid spans y 0..32 — exactly 2 blocks.
//   * The model faces -Z. `entityrenderer.emitCube` unwraps a cube with the
//     face texture on -Z, which is where Minecraft's skin layout puts it.
//   * `rotX` is pitch (positive tilts the face upward and swings a limb
//     forward), `rotY` is yaw, `rotZ` is roll.
//
// Because one model instance is shared by every entity of its kind, `animate()`
// re-poses the same tree immediately before each draw. That is exactly how the
// renderer uses it, and it means models cost nothing per entity.

import { clamp, lerp, wrapAngle } from '../core/math.js';

const HALF_PI = Math.PI / 2;

export class ModelPart {
  constructor(name, pivotX = 0, pivotY = 0, pivotZ = 0) {
    this.name = name;
    this.pivotX = pivotX;
    this.pivotY = pivotY;
    this.pivotZ = pivotZ;
    this.rotX = 0; this.rotY = 0; this.rotZ = 0;
    this.defRotX = 0; this.defRotY = 0; this.defRotZ = 0;
    this.scaleX = 1; this.scaleY = 1; this.scaleZ = 1;
    this.visible = true;
    this.defVisible = true;
    this.children = [];
    this.cubes = [];
  }

  /** Add a cube. Coordinates are relative to this part's pivot. */
  cube(x, y, z, w, h, d, u, v, inflate = 0) {
    this.cubes.push({ x, y, z, w, h, d, u, v, inflate });
    return this;
  }

  /** Create, attach and return a child part; pivots are parent-relative. */
  child(name, px = 0, py = 0, pz = 0) {
    const p = new ModelPart(name, px, py, pz);
    this.children.push(p);
    return p;
  }

  add(part) { this.children.push(part); return part; }

  rotate(x = 0, y = 0, z = 0) {
    this.rotX = this.defRotX = x;
    this.rotY = this.defRotY = y;
    this.rotZ = this.defRotZ = z;
    return this;
  }

  hide() { this.visible = this.defVisible = false; return this; }

  /** Snapshot the current pose as the rest pose `reset()` returns to. */
  markDefault() {
    this.defRotX = this.rotX; this.defRotY = this.rotY; this.defRotZ = this.rotZ;
    this.defVisible = this.visible;
    for (const c of this.children) c.markDefault();
    return this;
  }

  reset() {
    this.rotX = this.defRotX; this.rotY = this.defRotY; this.rotZ = this.defRotZ;
    this.scaleX = this.scaleY = this.scaleZ = 1;
    this.visible = this.defVisible;
    const c = this.children;
    for (let i = 0; i < c.length; i++) c[i].reset();
  }

  find(name) {
    if (this.name === name) return this;
    for (const c of this.children) {
      const f = c.find(name);
      if (f) return f;
    }
    return null;
  }

  /** Flat map of every named part, used to give animators quick access. */
  collect(out = {}) {
    out[this.name] = this;
    for (const c of this.children) c.collect(out);
    return out;
  }
}

/** Convenience: a root part at the entity's origin. */
const root = () => new ModelPart('root', 0, 0, 0);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const builders = new Map();
const cache = new Map();

/**
 * Register a model builder.
 * @param {string} name
 * @param {() => {root: ModelPart, textureWidth?: number, textureHeight?: number,
 *                animator?: Function}} build
 */
export function registerModel(name, build) {
  builders.set(name, build);
  return name;
}

/** Build (once) and return the model definition for a name. */
export function getModel(name) {
  if (!name) return null;
  let def = cache.get(name);
  if (def !== undefined) return def;
  const build = builders.get(name);
  if (!build) { cache.set(name, null); return null; }
  def = build();
  def.name = name;
  def.textureWidth = def.textureWidth ?? 64;
  def.textureHeight = def.textureHeight ?? 32;
  def.root.markDefault();
  def.parts = def.root.collect();
  cache.set(name, def);
  return def;
}

export function hasModel(name) { return builders.has(name); }
export function modelNames() { return [...builders.keys()]; }

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

const ctx = {
  limbSwing: 0, limbAmount: 0, headYaw: 0, headPitch: 0,
  age: 0, attack: 0, time: 0, alpha: 0, baby: false,
};

/**
 * Pose `def`'s part tree for `entity`. Called by the renderer immediately
 * before drawing, so mutating the shared tree is safe and free.
 */
export function animate(def, entity, alpha = 1, time = 0) {
  if (!def || !def.root) return;
  def.root.reset();
  if (!entity) return;

  // `limbSwing` is the walk phase and `limbAmount` its magnitude — both are
  // accumulated per tick by the entity and interpolated here, so the stride
  // stays smooth at any frame rate.
  const prevAmount = entity.prevLimbSwingAmount ?? entity.limbSwingAmount ?? 0;
  ctx.limbAmount = lerp(prevAmount, entity.limbSwingAmount ?? 0, alpha);
  ctx.limbSwing = (entity.limbSwing ?? 0) - (entity.limbSwingAmount ?? 0) * (1 - alpha);
  ctx.headYaw = wrapAngle((entity.bodyRot ?? 0) - (entity.yaw ?? 0));
  ctx.headYaw = clamp(ctx.headYaw, -1.4, 1.4);
  ctx.headPitch = clamp(entity.pitch ?? 0, -1.3, 1.3);
  ctx.age = (entity.age ?? 0) + alpha;
  ctx.attack = lerp(entity.prevAttackAnim ?? 0, entity.attackAnim ?? 0, alpha);
  ctx.time = time;
  ctx.alpha = alpha;
  ctx.baby = !!entity.baby;

  if (def.animator) {
    try { def.animator(def.parts, entity, ctx, def); }
    catch (e) { animError(def, e); }
  }

  // Babies use a bigger head and a smaller body, the same trick Minecraft uses
  // rather than shipping a second model.
  if (ctx.baby && def.babyHead !== false) {
    const head = def.parts.head;
    if (head) { head.scaleX = head.scaleY = head.scaleZ = 1.5; }
  }

  if (entity.dead && entity.deathTime > 0) {
    // Topple over the course of the death animation.
    const t = Math.min(1, entity.deathTime / 20);
    def.root.rotZ = -t * 1.45;
  }
}

const animErrors = new Set();
function animError(def, e) {
  if (animErrors.has(def.name)) return;
  animErrors.add(def.name);
  console.warn(`[models] animator for "${def.name}" threw: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Shared animators
// ---------------------------------------------------------------------------

/** Head look plus the standard four-limb walk cycle. */
export function bipedAnimator(p, e, c) {
  if (p.head) { p.head.rotY = c.headYaw; p.head.rotX = c.headPitch; }
  if (p.hat) { p.hat.rotY = c.headYaw; p.hat.rotX = c.headPitch; }
  const swing = Math.cos(c.limbSwing * 0.6662) * 1.4 * c.limbAmount;
  if (p.rightLeg) p.rightLeg.rotX = swing;
  if (p.leftLeg) p.leftLeg.rotX = -swing;
  if (p.rightArm) { p.rightArm.rotX = -swing * 0.75; p.rightArm.rotZ = 0; }
  if (p.leftArm) { p.leftArm.rotX = swing * 0.75; p.leftArm.rotZ = 0; }

  // Idle sway so a standing mob is never rigid.
  const idle = Math.sin(c.age * 0.067) * 0.05;
  if (p.rightArm) { p.rightArm.rotZ += idle; p.rightArm.rotX += idle; }
  if (p.leftArm) { p.leftArm.rotZ -= idle; p.leftArm.rotX -= idle; }

  if (e.armsRaised) {
    const wobble = Math.sin(c.age * 0.09) * 0.05;
    if (p.rightArm) { p.rightArm.rotX = -HALF_PI + wobble; p.rightArm.rotZ = -0.05; }
    if (p.leftArm) { p.leftArm.rotX = -HALF_PI - wobble; p.leftArm.rotZ = 0.05; }
  }
  if (c.attack > 0 && p.rightArm) {
    const a = Math.sin(c.attack * Math.PI);
    p.rightArm.rotX = -a * 2.2;
    p.rightArm.rotY = -0.2 * a;
  }
  if (e.sitting || e.riding) {
    if (p.rightLeg) { p.rightLeg.rotX = -1.4; p.rightLeg.rotY = -0.3; }
    if (p.leftLeg) { p.leftLeg.rotX = -1.4; p.leftLeg.rotY = 0.3; }
  }
}

/** Four legs moving in diagonal pairs, plus a head that tracks the look. */
export function quadrupedAnimator(p, e, c) {
  if (p.head) {
    p.head.rotY = c.headYaw;
    p.head.rotX = c.headPitch + (e.eatTicks > 0 ? 0.9 : 0);
  }
  const swing = Math.cos(c.limbSwing * 0.6662) * 1.4 * c.limbAmount;
  if (p.legFrontRight) p.legFrontRight.rotX = swing;
  if (p.legFrontLeft) p.legFrontLeft.rotX = -swing;
  if (p.legBackRight) p.legBackRight.rotX = -swing;
  if (p.legBackLeft) p.legBackLeft.rotX = swing;
  if (p.tail) p.tail.rotY = Math.sin(c.age * 0.12) * 0.2;
}

/** Wings beating, body tilting into the motion. */
export function flyerAnimator(p, e, c) {
  const flap = Math.sin(c.age * 0.6) * 0.6;
  if (p.rightWing) p.rightWing.rotZ = -flap - 0.2;
  if (p.leftWing) p.leftWing.rotZ = flap + 0.2;
  if (p.head) { p.head.rotY = c.headYaw; p.head.rotX = c.headPitch; }
  if (p.body) p.body.rotX = clamp(-(e.vy ?? 0) * 0.6, -0.4, 0.4);
}

/** Fish and other swimmers: the whole body serpentines. */
export function swimmerAnimator(p, e, c) {
  const speed = Math.hypot(e.vx ?? 0, e.vz ?? 0);
  const wave = Math.sin(c.age * (0.4 + speed * 8)) * (0.2 + speed * 2);
  if (p.tail) p.tail.rotY = wave;
  if (p.tailFin) p.tailFin.rotY = wave * 1.4;
  if (p.body) p.body.rotY = wave * 0.15;
  if (p.head) { p.head.rotY = c.headYaw * 0.5; p.head.rotX = c.headPitch * 0.5; }
  if (p.rightFin) p.rightFin.rotZ = -0.3 - Math.sin(c.age * 0.3) * 0.2;
  if (p.leftFin) p.leftFin.rotZ = 0.3 + Math.sin(c.age * 0.3) * 0.2;
}

// ---------------------------------------------------------------------------
// Humanoid family
// ---------------------------------------------------------------------------

/**
 * A Minecraft-proportioned humanoid, 32 units tall.
 * @param {object} o limbWidth, sheet size, and per-part UV offsets
 */
function buildBiped(o = {}) {
  const lw = o.limbWidth ?? 4;          // arm/leg thickness
  const half = lw / 2;
  const r = root();

  const head = r.child('head', 0, 24, 0);
  head.cube(-4, 0, -4, 8, 8, 8, o.headUV?.[0] ?? 0, o.headUV?.[1] ?? 0);
  if (o.hat !== false) {
    const hat = r.child('hat', 0, 24, 0);
    hat.cube(-4, 0, -4, 8, 8, 8, o.hatUV?.[0] ?? 32, o.hatUV?.[1] ?? 0, 0.5);
  }

  const body = r.child('body', 0, 24, 0);
  body.cube(-4, -12, -2, 8, 12, 4, o.bodyUV?.[0] ?? 16, o.bodyUV?.[1] ?? 16);

  const rightArm = r.child('rightArm', -(4 + half), 22, 0);
  rightArm.cube(-half, -10, -2, lw, 12, 4, o.armUV?.[0] ?? 40, o.armUV?.[1] ?? 16);
  const leftArm = r.child('leftArm', 4 + half, 22, 0);
  leftArm.cube(-half, -10, -2, lw, 12, 4,
    o.armLUV?.[0] ?? o.armUV?.[0] ?? 40, o.armLUV?.[1] ?? o.armUV?.[1] ?? 16);

  const rightLeg = r.child('rightLeg', -half - 0.1, 12, 0);
  rightLeg.cube(-half, -12, -2, lw, 12, 4, o.legUV?.[0] ?? 0, o.legUV?.[1] ?? 16);
  const leftLeg = r.child('leftLeg', half + 0.1, 12, 0);
  leftLeg.cube(-half, -12, -2, lw, 12, 4,
    o.legLUV?.[0] ?? o.legUV?.[0] ?? 0, o.legLUV?.[1] ?? o.legUV?.[1] ?? 16);

  if (o.extra) o.extra(r, { head, body, rightArm, leftArm, rightLeg, leftLeg });

  return {
    root: r,
    textureWidth: o.sheetW ?? 64,
    textureHeight: o.sheetH ?? 64,
    animator: o.animator ?? bipedAnimator,
  };
}

registerModel('zombie', () => buildBiped({
  armLUV: [40, 32], legLUV: [0, 32],
  animator(p, e, c) {
    bipedAnimator(p, e, c);
    // Zombies walk with their arms out in front.
    if (!e.baby || true) {
      const wobble = Math.sin(c.age * 0.09) * 0.05;
      p.rightArm.rotX = -HALF_PI + wobble + Math.cos(c.limbSwing * 0.6662) * 0.3 * c.limbAmount;
      p.leftArm.rotX = -HALF_PI - wobble - Math.cos(c.limbSwing * 0.6662) * 0.3 * c.limbAmount;
      p.rightArm.rotZ = -0.06;
      p.leftArm.rotZ = 0.06;
    }
    if (c.attack > 0) p.rightArm.rotX = -HALF_PI - Math.sin(c.attack * Math.PI) * 1.2;
  },
}));

registerModel('skeleton', () => buildBiped({
  limbWidth: 2, sheetH: 32, hat: false,
  armUV: [40, 16], legUV: [0, 16],
  animator(p, e, c) {
    bipedAnimator(p, e, c);
    if (e.aiming) {
      p.rightArm.rotX = -1.6 + c.headPitch;
      p.rightArm.rotY = -0.35;
      p.leftArm.rotX = -1.5 + c.headPitch;
      p.leftArm.rotY = 0.35;
    }
  },
}));

registerModel('villager', () => {
  const r = root();
  const head = r.child('head', 0, 24, 0);
  head.cube(-4, 0, -4, 8, 10, 8, 0, 0);
  const nose = head.child('nose', 0, 1, -4);
  nose.cube(-1, 0, -2, 2, 4, 2, 24, 0);
  const brim = r.child('hat', 0, 24, 0);
  brim.cube(-4, 0, -4, 8, 10, 8, 32, 0, 0.5);

  const body = r.child('body', 0, 24, 0);
  body.cube(-4, -12, -3, 8, 12, 6, 16, 20);
  const robe = r.child('robe', 0, 24, 0);
  robe.cube(-4, -12, -3, 8, 18, 6, 0, 38, 0.5);

  const rightArm = r.child('rightArm', -4, 22, 0);
  rightArm.cube(-4, -10, -2, 4, 12, 4, 44, 22);
  const leftArm = r.child('leftArm', 4, 22, 0);
  leftArm.cube(0, -10, -2, 4, 12, 4, 44, 22);

  const rightLeg = r.child('rightLeg', -2, 12, 0);
  rightLeg.cube(-2, -12, -2, 4, 12, 4, 0, 22);
  const leftLeg = r.child('leftLeg', 2, 12, 0);
  leftLeg.cube(-2, -12, -2, 4, 12, 4, 0, 22);

  return {
    root: r, textureWidth: 64, textureHeight: 64,
    animator(p, e, c) {
      p.head.rotY = c.headYaw; p.head.rotX = c.headPitch;
      p.hat.rotY = c.headYaw; p.hat.rotX = c.headPitch;
      const swing = Math.cos(c.limbSwing * 0.6662) * 1.4 * c.limbAmount;
      p.rightLeg.rotX = swing;
      p.leftLeg.rotX = -swing;
      // Villagers keep their arms folded across the chest.
      p.rightArm.rotX = -0.75 + Math.sin(c.age * 0.05) * 0.05;
      p.leftArm.rotX = -0.75 - Math.sin(c.age * 0.05) * 0.05;
      if (e.working) {
        p.rightArm.rotX = -1.2 + Math.sin(c.age * 0.4) * 0.4;
      }
    },
  };
});

registerModel('illager', () => {
  const def = buildBiped({
    sheetH: 64, armLUV: [40, 32], legLUV: [0, 32],
    extra(r) {
      const head = r.find('head');
      const nose = head.child('nose', 0, 1, -4);
      nose.cube(-1, 0, -2, 2, 4, 2, 24, 0);
    },
  });
  def.animator = (p, e, c) => {
    bipedAnimator(p, e, c);
    if (e.armsCrossed) {
      p.rightArm.rotX = -0.9; p.rightArm.rotZ = -0.3;
      p.leftArm.rotX = -0.9; p.leftArm.rotZ = 0.3;
    }
    if (e.casting) {
      p.rightArm.rotX = -1.9 + Math.sin(c.age * 0.3) * 0.2;
      p.leftArm.rotX = -1.9 - Math.sin(c.age * 0.3) * 0.2;
      p.rightArm.rotZ = -0.4; p.leftArm.rotZ = 0.4;
    }
  };
  return def;
});

registerModel('witch', () => {
  const def = buildBiped({
    sheetH: 128, hat: false,
    extra(r) {
      const head = r.find('head');
      const nose = head.child('nose', 0, 2, -4);
      nose.cube(-1, 0, -2, 2, 4, 2, 0, 0);
      const hat = head.child('wizardHat', 0, 8, 0);
      hat.cube(-5, 0, -5, 10, 2, 10, 0, 64);
      const hat2 = hat.child('hat2', 0, 2, 0).rotate(-0.05, 0, 0.02);
      hat2.cube(-4, 0, -4, 8, 4, 8, 0, 76);
      const hat3 = hat2.child('hat3', 0, 4, 0).rotate(-0.1, 0, 0.05);
      hat3.cube(-2, 0, -2, 4, 6, 4, 0, 88);
    },
  });
  def.textureHeight = 128;
  def.animator = (p, e, c) => {
    bipedAnimator(p, e, c);
    if (e.drinking) {
      p.rightArm.rotX = -2.4;
      p.rightArm.rotZ = -0.3;
      p.head.rotX = -0.6;
    }
  };
  return def;
});

// ---------------------------------------------------------------------------
// Quadruped family
// ---------------------------------------------------------------------------

/**
 * Build a four-legged animal.
 *
 * The torso is authored upright and rotated a quarter turn so its UV footprint
 * stays inside a 64x32 sheet — the same trick Minecraft's QuadrupedModel uses.
 */
function buildQuadruped(o) {
  const legH = o.legH ?? 12, legW = o.legW ?? 4;
  const bodyW = o.bodyW ?? 10, bodyT = o.bodyT ?? 10, bodyL = o.bodyL ?? 16;
  const bodyY = legH + bodyT;
  const legX = o.legX ?? (bodyW / 2 - legW / 2);
  const legZ = o.legZ ?? (bodyL / 2 - legW / 2 - 1);
  const r = root();

  const body = r.child('body', 0, bodyY, 0).rotate(HALF_PI, 0, 0);
  body.cube(-bodyW / 2, -bodyL / 2, 0, bodyW, bodyL, bodyT,
    o.bodyUV?.[0] ?? 18, o.bodyUV?.[1] ?? 4);
  if (o.bodyExtra) o.bodyExtra(body, r);

  const headY = o.headY ?? (bodyY - 2);
  const headZ = o.headZ ?? (-bodyL / 2);
  const head = r.child('head', 0, headY, headZ);
  const hw = o.headW ?? 8, hh = o.headH ?? 8, hl = o.headL ?? 8;
  head.cube(-hw / 2, o.headOY ?? -hh / 2, -hl, hw, hh, hl,
    o.headUV?.[0] ?? 0, o.headUV?.[1] ?? 0);
  if (o.headExtra) o.headExtra(head, r);

  const lu = o.legUV?.[0] ?? 0, lv = o.legUV?.[1] ?? 16;
  const mk = (name, x, z) => {
    const p = r.child(name, x, legH, z);
    p.cube(-legW / 2, -legH, -legW / 2, legW, legH, legW, lu, lv);
    return p;
  };
  mk('legFrontRight', -legX, -legZ);
  mk('legFrontLeft', legX, -legZ);
  mk('legBackRight', -legX, legZ);
  mk('legBackLeft', legX, legZ);

  if (o.extra) o.extra(r);

  return {
    root: r,
    textureWidth: o.sheetW ?? 64,
    textureHeight: o.sheetH ?? 32,
    animator: o.animator ?? quadrupedAnimator,
  };
}

registerModel('pig', () => buildQuadruped({
  legH: 6, legW: 4, bodyW: 10, bodyT: 8, bodyL: 16,
  headW: 8, headH: 8, headL: 8, headY: 12, headZ: -6,
  headExtra(head) { head.cube(-2, -2, -9, 4, 3, 1, 16, 16); },   // snout
}));

registerModel('cow', () => buildQuadruped({
  legH: 12, legW: 4, bodyW: 12, bodyT: 10, bodyL: 18,
  headW: 8, headH: 8, headL: 6, headY: 18, headZ: -8,
  headExtra(head) {
    head.cube(-5, 0, -5, 2, 3, 2, 22, 0);      // horns
    head.cube(3, 0, -5, 2, 3, 2, 22, 0);
  },
}));

registerModel('sheep', () => buildQuadruped({
  legH: 12, legW: 4, bodyW: 8, bodyT: 8, bodyL: 16,
  headW: 6, headH: 6, headL: 8, headY: 18, headZ: -6,
  sheetH: 64,
  extra(r) {
    // The wool layer is a second, inflated skin the shearing code hides.
    const woolBody = r.find('body').child('wool', 0, 0, 0);
    woolBody.cube(-4, -8, 0, 8, 16, 8, 28, 40, 1.75);
    const head = r.find('head');
    const woolHead = head.child('woolHead', 0, 0, 0);
    woolHead.cube(-3, -3, -8, 6, 6, 6, 0, 0, 0.6);
    for (const n of ['legFrontRight', 'legFrontLeft', 'legBackRight', 'legBackLeft']) {
      const leg = r.find(n);
      leg.child(`${n}Wool`, 0, 0, 0).cube(-2, -12, -2, 4, 6, 4, 0, 16, 0.5);
    }
  },
  animator(p, e, c) {
    quadrupedAnimator(p, e, c);
    const sheared = !!e.sheared;
    for (const n of ['wool', 'woolHead', 'legFrontRightWool', 'legFrontLeftWool',
      'legBackRightWool', 'legBackLeftWool']) {
      if (p[n]) p[n].visible = !sheared;
    }
    if (e.eatTicks > 0) {
      const t = 1 - Math.abs(e.eatTicks - 20) / 20;
      p.head.rotX = 0.3 + t * 0.9;
    }
  },
}));

registerModel('horse', () => buildQuadruped({
  legH: 14, legW: 4, bodyW: 10, bodyT: 10, bodyL: 22,
  headW: 6, headH: 12, headL: 7, headY: 24, headZ: -10, headOY: -4,
  sheetW: 64, sheetH: 64, bodyUV: [0, 32], headUV: [0, 0], legUV: [48, 21],
  headExtra(head) {
    head.child('earL', -2, 8, -2).cube(-1, 0, -1, 2, 3, 2, 19, 16);
    head.child('earR', 2, 8, -2).cube(-1, 0, -1, 2, 3, 2, 19, 16);
    head.cube(-2.5, -8, -11, 5, 5, 5, 24, 18);   // muzzle
  },
  extra(r) {
    const tail = r.child('tail', 0, 22, 11).rotate(0.6, 0, 0);
    tail.cube(-1.5, -2, 0, 3, 14, 4, 42, 36);
  },
}));

registerModel('llama', () => buildQuadruped({
  legH: 14, legW: 4, bodyW: 12, bodyT: 12, bodyL: 18,
  headW: 8, headH: 18, headL: 6, headY: 30, headZ: -8, headOY: -16,
  sheetW: 128, sheetH: 64, bodyUV: [29, 0], headUV: [0, 0], legUV: [29, 29],
  headExtra(head) {
    head.child('earL', -3.5, 2, 0).cube(-1.5, 0, -1, 3, 4, 2, 17, 0);
    head.child('earR', 3.5, 2, 0).cube(-1.5, 0, -1, 3, 4, 2, 17, 0);
  },
  extra(r) {
    const chest = r.child('chestRight', -8, 21, 3).rotate(0, HALF_PI, 0);
    chest.cube(-3, -4, 0, 8, 8, 3, 45, 28);
    const chest2 = r.child('chestLeft', 8, 21, 3).rotate(0, HALF_PI, 0);
    chest2.cube(-3, -4, 0, 8, 8, 3, 45, 41);
  },
  animator(p, e, c) {
    quadrupedAnimator(p, e, c);
    if (p.chestRight) p.chestRight.visible = !!e.hasChest;
    if (p.chestLeft) p.chestLeft.visible = !!e.hasChest;
  },
}));

registerModel('wolf', () => buildQuadruped({
  legH: 8, legW: 2, bodyW: 6, bodyT: 6, bodyL: 14,
  headW: 6, headH: 6, headL: 6, headY: 13.5, headZ: -5, headOY: -3,
  bodyUV: [18, 14], headUV: [0, 0], legUV: [0, 18],
  headExtra(head) {
    head.cube(-3, -3, -8, 6, 3, 3, 0, 10);           // snout
    head.child('earR', -2.5, 3, -3).cube(-1.5, 0, -1, 3, 3, 1, 16, 14);
    head.child('earL', 2.5, 3, -3).cube(-1.5, 0, -1, 3, 3, 1, 16, 14);
  },
  extra(r) {
    const tail = r.child('tail', 0, 14, 7).rotate(0.6, 0, 0);
    tail.cube(-1, -8, -1, 2, 8, 2, 9, 18);
    const mane = r.child('mane', 0, 14, -1).rotate(HALF_PI, 0, 0);
    mane.cube(-4, -6, 0, 8, 12, 7, 21, 0);
  },
  animator(p, e, c) {
    quadrupedAnimator(p, e, c);
    if (e.sitting) {
      p.body.rotX = HALF_PI - 0.6;
      p.legBackRight.rotX = -1.4; p.legBackLeft.rotX = -1.4;
      p.legFrontRight.rotX = -0.2; p.legFrontLeft.rotX = -0.2;
      if (p.mane) p.mane.rotX = HALF_PI - 0.6;
    }
    if (p.tail) {
      p.tail.rotY = Math.sin(c.age * 0.3) * (e.angry ? 0.6 : 0.25);
      p.tail.rotX = e.angry ? 0.2 : 0.6;
    }
    if (e.shaking) p.body.rotZ = Math.sin(c.age * 1.2) * 0.2;
  },
}));

registerModel('cat', () => buildQuadruped({
  legH: 8, legW: 2, bodyW: 4, bodyT: 5, bodyL: 14,
  headW: 5, headH: 4, headL: 5, headY: 11, headZ: -5, headOY: -2,
  bodyUV: [20, 0], headUV: [0, 0], legUV: [8, 13],
  headExtra(head) {
    head.cube(-1.5, -2.5, -6, 3, 2, 2, 0, 24);
    head.child('earR', -2, 2, -1.5).cube(-1, 0, -0.5, 2, 2, 1, 0, 10);
    head.child('earL', 2, 2, -1.5).cube(-1, 0, -0.5, 2, 2, 1, 6, 10);
  },
  extra(r) {
    const tail = r.child('tail', 0, 12, 7).rotate(0.9, 0, 0);
    tail.cube(-0.5, -8, -0.5, 1, 8, 1, 0, 15);
    const tail2 = tail.child('tail2', 0, -8, 0).rotate(-0.2, 0, 0);
    tail2.cube(-0.5, -8, -0.5, 1, 8, 1, 4, 15);
  },
  animator(p, e, c) {
    quadrupedAnimator(p, e, c);
    if (e.sitting) {
      p.body.rotX = HALF_PI - 0.5;
      p.legBackRight.rotX = -1.5; p.legBackLeft.rotX = -1.5;
      p.legFrontRight.rotX = -0.1; p.legFrontLeft.rotX = -0.1;
    }
    if (p.tail) p.tail.rotY = Math.sin(c.age * 0.2) * 0.3;
  },
}));

registerModel('ocelot', () => getModelBuilderClone('cat'));

registerModel('fox', () => buildQuadruped({
  legH: 6, legW: 2, bodyW: 6, bodyT: 6, bodyL: 11,
  headW: 8, headH: 6, headL: 6, headY: 12, headZ: -4, headOY: -3,
  bodyUV: [24, 15], headUV: [1, 5], legUV: [13, 24],
  headExtra(head) {
    head.cube(-2, -3, -8, 4, 2, 3, 6, 18);
    head.child('earR', -3, 3, -1).cube(-2, 0, -0.5, 2, 2, 1, 8, 1);
    head.child('earL', 3, 3, -1).cube(0, 0, -0.5, 2, 2, 1, 15, 1);
  },
  extra(r) {
    const tail = r.child('tail', 0, 10, 5).rotate(0.6, 0, 0);
    tail.cube(-2, -11, -2, 4, 11, 4, 30, 0);
  },
  animator(p, e, c) {
    quadrupedAnimator(p, e, c);
    if (e.sleeping) { p.body.rotZ = HALF_PI; p.head.rotZ = HALF_PI; }
    if (p.tail) p.tail.rotY = Math.sin(c.age * 0.15) * 0.3;
  },
}));

registerModel('rabbit', () => buildQuadruped({
  legH: 4, legW: 2, bodyW: 6, bodyT: 5, bodyL: 8,
  headW: 5, headH: 5, headL: 4, headY: 9, headZ: -3, headOY: -2,
  bodyUV: [0, 0], headUV: [32, 0], legUV: [16, 24],
  headExtra(head) {
    head.child('earR', -1.5, 3, 0).cube(-1, 0, -0.5, 2, 5, 1, 52, 0);
    head.child('earL', 1.5, 3, 0).cube(-1, 0, -0.5, 2, 5, 1, 58, 0);
    head.cube(-2, -3, -6, 4, 2, 2, 32, 9);
  },
  extra(r) {
    r.child('tail', 0, 8, 5).cube(-1.5, -2, 0, 3, 3, 2, 52, 6);
  },
  animator(p, e, c) {
    // Rabbits hop rather than walk.
    const hop = Math.max(0, Math.sin(c.limbSwing * 0.5)) * c.limbAmount;
    p.head.rotY = c.headYaw; p.head.rotX = c.headPitch;
    p.legBackRight.rotX = -hop * 1.4;
    p.legBackLeft.rotX = -hop * 1.4;
    p.legFrontRight.rotX = hop * 1.2;
    p.legFrontLeft.rotX = hop * 1.2;
    if (p.body) p.body.rotX = HALF_PI - hop * 0.3;
  },
}));

registerModel('panda', () => buildQuadruped({
  legH: 10, legW: 6, bodyW: 13, bodyT: 14, bodyL: 20,
  headW: 11, headH: 10, headL: 9, headY: 22, headZ: -8, headOY: -6,
  sheetW: 64, sheetH: 64, bodyUV: [0, 25], headUV: [0, 6], legUV: [40, 0],
  headExtra(head) {
    head.child('earR', -5, 5, 1).cube(-2, 0, -1, 3, 3, 2, 26, 0);
    head.child('earL', 5, 5, 1).cube(-1, 0, -1, 3, 3, 2, 26, 0);
    head.cube(-2, -5, -10, 4, 3, 3, 45, 16);
  },
  animator(p, e, c) {
    quadrupedAnimator(p, e, c);
    if (e.sitting || e.lying) {
      p.body.rotX = HALF_PI + 0.4;
      p.legFrontRight.rotX = -1.5; p.legFrontLeft.rotX = -1.5;
      p.legBackRight.rotX = -1.5; p.legBackLeft.rotX = -1.5;
    }
  },
}));

registerModel('polar_bear', () => buildQuadruped({
  legH: 14, legW: 5, bodyW: 14, bodyT: 14, bodyL: 22,
  headW: 8, headH: 8, headL: 8, headY: 26, headZ: -10, headOY: -5,
  sheetW: 128, sheetH: 64, bodyUV: [0, 19], headUV: [0, 0], legUV: [50, 22],
  headExtra(head) {
    head.cube(-2.5, -5, -11, 5, 3, 3, 0, 44);
    head.child('earR', -3.5, 3, -3).cube(-1, 0, -0.5, 2, 2, 1, 26, 0);
    head.child('earL', 3.5, 3, -3).cube(-1, 0, -0.5, 2, 2, 1, 26, 0);
  },
  animator(p, e, c) {
    quadrupedAnimator(p, e, c);
    if (e.standing) {
      p.body.rotX = HALF_PI - 1.0;
      p.legFrontRight.rotX = -1.2; p.legFrontLeft.rotX = -1.2;
    }
  },
}));

registerModel('goat', () => buildQuadruped({
  legH: 10, legW: 4, bodyW: 9, bodyT: 10, bodyL: 16,
  headW: 6, headH: 6, headL: 8, headY: 20, headZ: -6, headOY: -3,
  bodyUV: [1, 1], headUV: [34, 46], legUV: [1, 47], sheetW: 64, sheetH: 64,
  headExtra(head) {
    head.child('hornR', -3, 4, 1).cube(-1, 0, -1, 2, 5, 2, 12, 55);
    head.child('hornL', 3, 4, 1).cube(-1, 0, -1, 2, 5, 2, 12, 55);
    head.cube(-2, -4, -10, 4, 3, 2, 40, 40);
  },
}));

registerModel('hoglin', () => buildQuadruped({
  legH: 12, legW: 6, bodyW: 14, bodyT: 14, bodyL: 22,
  headW: 10, headH: 10, headL: 12, headY: 24, headZ: -9, headOY: -8,
  sheetW: 128, sheetH: 64, bodyUV: [1, 1], headUV: [61, 1], legUV: [21, 45],
  headExtra(head) {
    head.child('tuskR', -6, -4, -10).cube(-1, -3, -1, 2, 5, 2, 4, 16);
    head.child('tuskL', 6, -4, -10).cube(-1, -3, -1, 2, 5, 2, 4, 16);
    head.child('earR', -7, 2, -2).rotate(0, 0, -0.6).cube(-3, -1, -1, 3, 2, 6, 10, 13);
    head.child('earL', 7, 2, -2).rotate(0, 0, 0.6).cube(0, -1, -1, 3, 2, 6, 10, 13);
  },
}));

registerModel('strider', () => buildQuadruped({
  legH: 10, legW: 4, bodyW: 16, bodyT: 14, bodyL: 16,
  headW: 8, headH: 6, headL: 6, headY: 22, headZ: -6, headOY: -4,
  sheetW: 64, sheetH: 128, bodyUV: [0, 0], headUV: [0, 55], legUV: [0, 32],
  animator(p, e, c) {
    quadrupedAnimator(p, e, c);
    if (p.body) p.body.rotZ = Math.sin(c.limbSwing * 0.33) * 0.12 * c.limbAmount;
  },
}));

registerModel('sniffer', () => buildQuadruped({
  legH: 12, legW: 6, bodyW: 18, bodyT: 18, bodyL: 26,
  headW: 12, headH: 10, headL: 12, headY: 28, headZ: -12, headOY: -8,
  sheetW: 128, sheetH: 128, bodyUV: [0, 0], headUV: [8, 70], legUV: [0, 46],
  headExtra(head) {
    head.child('nose', 0, -6, -12).cube(-6, -3, -4, 12, 3, 4, 8, 111);
  },
}));

// ---------------------------------------------------------------------------
// One-off hostile models
// ---------------------------------------------------------------------------

registerModel('creeper', () => {
  const r = root();
  const head = r.child('head', 0, 18, 0);
  head.cube(-4, 0, -4, 8, 8, 8, 0, 0);
  const body = r.child('body', 0, 18, 0);
  body.cube(-4, -12, -2, 8, 12, 4, 16, 16);
  const mk = (name, x, z, u) => {
    const p = r.child(name, x, 6, z);
    p.cube(-2, -6, -2, 4, 6, 4, 0, 16);
    return p;
  };
  mk('legFrontRight', -2, -4);
  mk('legFrontLeft', 2, -4);
  mk('legBackRight', -2, 4);
  mk('legBackLeft', 2, 4);
  return {
    root: r, textureWidth: 64, textureHeight: 32,
    animator(p, e, c) {
      p.head.rotY = c.headYaw; p.head.rotX = c.headPitch;
      const swing = Math.cos(c.limbSwing * 0.6662) * 1.4 * c.limbAmount;
      p.legFrontRight.rotX = swing; p.legFrontLeft.rotX = -swing;
      p.legBackRight.rotX = -swing; p.legBackLeft.rotX = swing;
      // Swelling before the explosion.
      const f = e.swelling ?? 0;
      if (f > 0) {
        const s = 1 + Math.sin(f * 44) * f * 0.08;
        p.body.scaleX = s; p.body.scaleZ = s;
        p.head.scaleX = s; p.head.scaleY = s; p.head.scaleZ = s;
      }
    },
  };
});

registerModel('spider', () => {
  const r = root();
  const head = r.child('head', 0, 9, -3);
  head.cube(-4, -4, -8, 8, 8, 8, 32, 4);
  const body = r.child('body', 0, 9, 0);
  body.cube(-3, -3, 0, 6, 6, 6, 0, 0);
  const abdomen = r.child('abdomen', 0, 9, 9);
  abdomen.cube(-5, -5, -6, 10, 8, 12, 0, 12);
  for (let i = 0; i < 8; i++) {
    const side = i < 4 ? -1 : 1;
    const n = i % 4;
    const leg = r.child(`leg${i}`, side * 3, 9, (n - 1.5) * 3);
    leg.cube(side < 0 ? -16 : 0, -1, -1, 16, 2, 2, 18, 0);
    leg.rotate(0, side * (n - 1.5) * 0.3, side * (0.3 + n * 0.12));
  }
  return {
    root: r, textureWidth: 64, textureHeight: 32,
    babyHead: false,
    animator(p, e, c) {
      p.head.rotY = c.headYaw; p.head.rotX = c.headPitch;
      for (let i = 0; i < 8; i++) {
        const leg = p[`leg${i}`];
        if (!leg) continue;
        const side = i < 4 ? -1 : 1;
        const n = i % 4;
        const phase = c.limbSwing * 0.6662 + (n + (side < 0 ? 0 : 0.5)) * Math.PI * 0.5;
        leg.rotY = leg.defRotY + Math.cos(phase) * 0.4 * c.limbAmount * side;
        leg.rotZ = leg.defRotZ + Math.abs(Math.sin(phase)) * 0.4 * c.limbAmount * side;
      }
    },
  };
});

registerModel('enderman', () => {
  const r = root();
  const head = r.child('head', 0, 38, 0);
  head.cube(-4, 0, -4, 8, 8, 8, 0, 0);
  const hat = r.child('hat', 0, 38, 0);
  hat.cube(-4, 0, -4, 8, 8, 8, 0, 16, -0.5);
  const body = r.child('body', 0, 38, 0);
  body.cube(-4, -12, -2, 8, 12, 4, 32, 16);
  const rightArm = r.child('rightArm', -5, 36, 0);
  rightArm.cube(-1, -30, -1, 2, 30, 2, 56, 0);
  const leftArm = r.child('leftArm', 5, 36, 0);
  leftArm.cube(-1, -30, -1, 2, 30, 2, 56, 0);
  const rightLeg = r.child('rightLeg', -2, 26, 0);
  rightLeg.cube(-1, -26, -1, 2, 30, 2, 56, 0);
  const leftLeg = r.child('leftLeg', 2, 26, 0);
  leftLeg.cube(-1, -26, -1, 2, 30, 2, 56, 0);
  return {
    root: r, textureWidth: 64, textureHeight: 32,
    animator(p, e, c) {
      bipedAnimator(p, e, c);
      if (e.carriedBlock) {
        p.rightArm.rotX = -0.5; p.leftArm.rotX = -0.5;
        p.rightArm.rotZ = -0.05; p.leftArm.rotZ = 0.05;
      }
      if (e.angry) { p.head.rotX -= 0.3; }
    },
  };
});

registerModel('slime', () => {
  const r = root();
  const body = r.child('body', 0, 0, 0);
  body.cube(-4, 0, -4, 8, 8, 8, 0, 16);
  const outer = r.child('outer', 0, 0, 0);
  outer.cube(-4, 0, -4, 8, 8, 8, 0, 0, 0.25);
  const eyeR = body.child('eyeRight', -3.25, 4, -3.5);
  eyeR.cube(0, 0, 0, 2, 2, 1, 32, 0);
  const eyeL = body.child('eyeLeft', 1.25, 4, -3.5);
  eyeL.cube(0, 0, 0, 2, 2, 1, 32, 4);
  const mouth = body.child('mouth', -0.5, 2, -3.5);
  mouth.cube(0, 0, 0, 1, 1, 1, 32, 8);
  return {
    root: r, textureWidth: 64, textureHeight: 32, babyHead: false,
    animator(p, e, c) {
      // Squash and stretch driven by the squish value the mob maintains.
      const squish = e.squish ?? 0;
      const s = 1 / (Math.abs(squish) * 0.5 + 1);
      p.body.scaleX = s; p.body.scaleZ = s;
      p.body.scaleY = 1 / s;
      p.outer.scaleX = s; p.outer.scaleZ = s;
      p.outer.scaleY = 1 / s;
    },
  };
});

registerModel('magma_cube', () => {
  const def = getModel('slime');
  // Magma cubes reuse the slime shape but show their inner core segments.
  const r = root();
  const core = r.child('body', 0, 0, 0);
  core.cube(-4, 1, -4, 8, 6, 8, 0, 16);
  const outer = r.child('outer', 0, 0, 0);
  outer.cube(-4, 0, -4, 8, 8, 8, 0, 0, 0.25);
  for (let i = 0; i < 3; i++) {
    const seg = r.child(`segment${i}`, 0, i * 2, 0);
    seg.cube(-4, 0, -4, 8, 2, 8, 0, 0, 0.1 + i * 0.05);
  }
  return {
    root: r, textureWidth: 64, textureHeight: 32, babyHead: false,
    animator(p, e, c) {
      const squish = e.squish ?? 0;
      const s = 1 / (Math.abs(squish) * 0.5 + 1);
      for (let i = 0; i < 3; i++) {
        const seg = p[`segment${i}`];
        if (seg) { seg.pivotY = i * 2 * (1 / s); seg.scaleX = s; seg.scaleZ = s; }
      }
      p.body.scaleX = s; p.body.scaleZ = s; p.body.scaleY = 1 / s;
      p.outer.scaleX = s; p.outer.scaleZ = s; p.outer.scaleY = 1 / s;
    },
  };
});

registerModel('silverfish', () => {
  const r = root();
  const segments = [
    [0, 1.5, -3.5, 3, 2, 2, 0, 0],
    [0, 2, -1.5, 4, 3, 3, 0, 4],
    [0, 2.5, 1.5, 6, 4, 4, 0, 11],
    [0, 2, 5, 3, 3, 3, 0, 19],
  ];
  segments.forEach((s, i) => {
    const p = r.child(`seg${i}`, s[0], s[1], s[2]);
    p.cube(-s[3] / 2, -s[4] / 2, -s[5] / 2, s[3], s[4], s[5], s[6], s[7]);
  });
  for (let i = 0; i < 3; i++) {
    const spike = r.child(`spike${i}`, 0, 3.5 + i * 0.2, -2 + i * 3);
    spike.cube(-3, 0, -1, 6, 1, 2, 20, 0);
  }
  return {
    root: r, textureWidth: 64, textureHeight: 32, babyHead: false,
    animator(p, e, c) {
      for (let i = 0; i < 4; i++) {
        const seg = p[`seg${i}`];
        if (seg) seg.rotY = Math.sin(c.limbSwing * 0.9 + i * 0.9) * 0.35 * (0.3 + c.limbAmount);
      }
    },
  };
});

registerModel('endermite', () => {
  const r = root();
  const body = r.child('body', 0, 2, 0);
  body.cube(-3, -2, -4, 6, 4, 8, 0, 0);
  const tail = r.child('tail', 0, 2, 4);
  tail.cube(-2, -1.5, 0, 4, 3, 4, 0, 12);
  return {
    root: r, textureWidth: 32, textureHeight: 16, babyHead: false,
    animator(p, e, c) {
      p.tail.rotY = Math.sin(c.limbSwing * 0.9) * 0.4 * (0.3 + c.limbAmount);
    },
  };
});

registerModel('blaze', () => {
  const r = root();
  const head = r.child('head', 0, 20, 0);
  head.cube(-4, -4, -4, 8, 8, 8, 0, 0);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const ring = Math.floor(i / 4);
    const rad = 4.5 + ring * 0.5;
    const rod = r.child(`rod${i}`, Math.cos(a) * rad, 14 + ring * 4, Math.sin(a) * rad);
    rod.cube(-1, -4, -1, 2, 8, 2, 0, 16);
  }
  return {
    root: r, textureWidth: 64, textureHeight: 32, babyHead: false,
    animator(p, e, c) {
      p.head.rotY = c.headYaw; p.head.rotX = c.headPitch;
      for (let i = 0; i < 12; i++) {
        const rod = p[`rod${i}`];
        if (!rod) continue;
        const a = (i / 12) * Math.PI * 2 + c.age * 0.05;
        const ring = Math.floor(i / 4);
        const rad = 4.5 + ring * 0.5;
        rod.pivotX = Math.cos(a) * rad;
        rod.pivotZ = Math.sin(a) * rad;
        rod.pivotY = 14 + ring * 4 + Math.sin(c.age * 0.2 + i) * 0.6;
      }
    },
  };
});

registerModel('ghast', () => {
  const r = root();
  const body = r.child('body', 0, 12, 0);
  body.cube(-8, -8, -8, 16, 16, 16, 0, 0);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const t = r.child(`tentacle${i}`, Math.cos(a) * 5, 4, Math.sin(a) * 5);
    t.cube(-1, -8 - (i % 3) * 2, -1, 2, 8 + (i % 3) * 2, 2, 0, 0);
  }
  return {
    root: r, textureWidth: 64, textureHeight: 32, babyHead: false,
    animator(p, e, c) {
      for (let i = 0; i < 9; i++) {
        const t = p[`tentacle${i}`];
        if (t) t.rotX = 0.2 * Math.sin(c.age * 0.06 + i) + 0.4;
      }
      if (p.body) p.body.rotX = Math.sin(c.age * 0.02) * 0.05;
    },
  };
});

registerModel('phantom', () => {
  const r = root();
  const body = r.child('body', 0, 6, 0);
  body.cube(-3, -2, -8, 5, 3, 12, 0, 8);
  const head = body.child('head', 0, 0, -8);
  head.cube(-4, -2, -5, 7, 3, 5, 0, 0);
  const rightWing = body.child('rightWing', -3, 1, -3).rotate(0, 0, -0.1);
  rightWing.cube(-9, -1, 0, 9, 1, 6, 23, 12);
  const rightWingTip = rightWing.child('rightWingTip', -9, 0, 0);
  rightWingTip.cube(-13, -0.5, 0, 13, 1, 9, 16, 24);
  const leftWing = body.child('leftWing', 2, 1, -3).rotate(0, 0, 0.1);
  leftWing.cube(0, -1, 0, 9, 1, 6, 23, 12);
  const leftWingTip = leftWing.child('leftWingTip', 9, 0, 0);
  leftWingTip.cube(0, -0.5, 0, 13, 1, 9, 16, 24);
  const tail = body.child('tail', 0, 0, 4);
  tail.cube(-2, -1, 0, 3, 2, 6, 3, 20);
  return {
    root: r, textureWidth: 64, textureHeight: 64, babyHead: false,
    animator(p, e, c) {
      const flap = Math.sin(c.age * 0.35);
      p.rightWing.rotZ = -0.1 - flap * 0.4;
      p.leftWing.rotZ = 0.1 + flap * 0.4;
      p.rightWingTip.rotZ = -flap * 0.4;
      p.leftWingTip.rotZ = flap * 0.4;
      p.tail.rotX = Math.sin(c.age * 0.2) * 0.15;
      p.head.rotX = c.headPitch * 0.5;
    },
  };
});

registerModel('vex', () => {
  const def = buildBiped({ sheetH: 64, armLUV: [40, 32], legLUV: [0, 32] });
  const r = def.root;
  const rightWing = r.child('rightWing', -1.5, 22, 2);
  rightWing.cube(-10, -1, 0, 10, 10, 1, 0, 32);
  const leftWing = r.child('leftWing', 1.5, 22, 2);
  leftWing.cube(0, -1, 0, 10, 10, 1, 0, 32);
  def.animator = (p, e, c) => {
    bipedAnimator(p, e, c);
    const flap = Math.sin(c.age * 0.9) * 0.4;
    p.rightWing.rotY = -0.5 - flap;
    p.leftWing.rotY = 0.5 + flap;
    // Vexes glide with their legs together.
    p.rightLeg.rotX = 0.2; p.leftLeg.rotX = 0.2;
  };
  return def;
});

registerModel('guardian', () => {
  const r = root();
  const body = r.child('body', 0, 8, 0);
  body.cube(-6, -6, -8, 12, 12, 16, 0, 0);
  const eye = body.child('eye', 0, 0, -8);
  eye.cube(-1, -1, -0.5, 2, 2, 1, 8, 0);
  for (let i = 0; i < 12; i++) {
    const spike = body.child(`spike${i}`, 0, 0, 0);
    const a = (i / 12) * Math.PI * 2;
    spike.pivotX = Math.cos(a) * 6;
    spike.pivotY = Math.sin(a) * 6;
    spike.rotZ = a;
    spike.cube(-1, 0, -1, 2, 9, 2, 0, 0);
  }
  const tail = body.child('tail', 0, 0, 8);
  tail.cube(-2, -2, 0, 4, 4, 8, 40, 0);
  return {
    root: r, textureWidth: 64, textureHeight: 64, babyHead: false,
    animator(p, e, c) {
      p.tail.rotY = Math.sin(c.age * 0.12) * 0.4;
      for (let i = 0; i < 12; i++) {
        const spike = p[`spike${i}`];
        if (spike) {
          const out = e.attackTarget ? 1 : 0.4 + Math.sin(c.age * 0.05 + i) * 0.1;
          spike.scaleY = out;
        }
      }
      if (p.eye) p.eye.rotY = c.headYaw * 0.3;
    },
  };
});

registerModel('shulker', () => {
  const r = root();
  const base = r.child('base', 0, 0, 0);
  base.cube(-8, 0, -8, 16, 8, 16, 0, 28);
  const lid = r.child('lid', 0, 4, 0);
  lid.cube(-8, 0, -8, 16, 12, 16, 0, 0);
  const head = r.child('head', 0, 8, 0);
  head.cube(-3, 0, -3, 6, 6, 6, 0, 52);
  return {
    root: r, textureWidth: 64, textureHeight: 64, babyHead: false,
    animator(p, e, c) {
      const open = e.peekAmount ?? 0;
      p.lid.pivotY = 4 + open * 8;
      p.head.pivotY = 8 + open * 4;
      p.head.visible = open > 0.05;
      p.head.rotY = c.headYaw;
    },
  };
});

registerModel('ravager', () => {
  const r = root();
  const body = r.child('body', 0, 22, 0).rotate(HALF_PI, 0, 0);
  body.cube(-7, -14, 0, 14, 28, 16, 0, 55);
  const neck = r.child('neck', 0, 26, -12);
  neck.cube(-5, -6, -6, 10, 10, 18, 68, 73);
  const head = neck.child('head', 0, 0, -6);
  head.cube(-8, -10, -14, 16, 16, 14, 0, 0);
  head.child('mouth', 0, -10, -14).cube(-4, -4, -2, 8, 4, 4, 0, 36);
  head.child('hornR', -10, 4, -6).rotate(0, 0, -0.4).cube(-2, 0, -1, 2, 8, 2, 74, 55);
  head.child('hornL', 10, 4, -6).rotate(0, 0, 0.4).cube(0, 0, -1, 2, 8, 2, 74, 55);
  const mk = (name, x, z) => {
    const leg = r.child(name, x, 12, z);
    leg.cube(-4, -12, -4, 8, 12, 8, 96, 0);
    return leg;
  };
  mk('legFrontRight', -8, -8);
  mk('legFrontLeft', 8, -8);
  mk('legBackRight', -8, 8);
  mk('legBackLeft', 8, 8);
  return {
    root: r, textureWidth: 128, textureHeight: 128, babyHead: false,
    animator(p, e, c) {
      quadrupedAnimator(p, e, c);
      if (p.neck) p.neck.rotX = clamp(c.headPitch, -0.4, 0.4);
      if (p.head) p.head.rotY = c.headYaw;
      if (e.stunned) {
        p.head.rotX = 0.6;
        p.neck.rotX = 0.4;
      }
      if (e.roaring) p.head.rotX = -0.5 + Math.sin(c.age * 0.6) * 0.1;
    },
  };
});

registerModel('warden', () => {
  const r = root();
  const body = r.child('body', 0, 21, 0);
  body.cube(-9, -12, -6, 18, 21, 11, 0, 105);
  const head = r.child('head', 0, 42, 0);
  head.cube(-8, 0, -5, 16, 10, 10, 0, 0);
  head.child('ribcage', 0, 0, 0);
  const rightArm = r.child('rightArm', -13, 38, 1);
  rightArm.cube(-4, -25, -4, 8, 25, 8, 0, 46);
  const leftArm = r.child('leftArm', 13, 38, 1);
  leftArm.cube(-4, -25, -4, 8, 25, 8, 40, 46);
  const rightLeg = r.child('rightLeg', -5, 13, 0);
  rightLeg.cube(-3, -13, -3, 6, 13, 6, 76, 48);
  const leftLeg = r.child('leftLeg', 5, 13, 0);
  leftLeg.cube(-3, -13, -3, 6, 13, 6, 100, 48);
  return {
    root: r, textureWidth: 128, textureHeight: 128, babyHead: false,
    animator(p, e, c) {
      bipedAnimator(p, e, c);
      // A heavy, lumbering swing — half speed, twice the reach.
      const swing = Math.cos(c.limbSwing * 0.4) * 1.0 * c.limbAmount;
      p.rightLeg.rotX = swing; p.leftLeg.rotX = -swing;
      p.rightArm.rotX = -swing * 0.6; p.leftArm.rotX = swing * 0.6;
      if (e.roaring) {
        p.rightArm.rotX = -2.2; p.leftArm.rotX = -2.2;
        p.head.rotX = -0.5;
      }
      const pulse = Math.sin(c.age * 0.1) * 0.03;
      p.body.scaleX = 1 + pulse; p.body.scaleZ = 1 + pulse;
    },
  };
});

registerModel('wither', () => {
  const r = root();
  const body = r.child('body', 0, 24, 0);
  body.cube(-10, -12, -2, 20, 12, 4, 0, 16);
  const spine1 = r.child('spine1', 0, 24, 0);
  spine1.cube(-2, -22, -2, 4, 10, 4, 0, 32);
  const spine2 = r.child('spine2', 0, 14, 0);
  spine2.cube(-6, -6, -1, 12, 6, 2, 0, 45);
  const spine3 = r.child('spine3', 0, 8, 0);
  spine3.cube(-4, -6, -1, 8, 6, 2, 0, 54);
  const centre = r.child('head', 0, 30, 0);
  centre.cube(-4, 0, -4, 8, 8, 8, 0, 0);
  const left = r.child('headLeft', 9, 28, 0);
  left.cube(-3, 0, -3, 6, 6, 6, 32, 0);
  const right = r.child('headRight', -9, 28, 0);
  right.cube(-3, 0, -3, 6, 6, 6, 32, 0);
  return {
    root: r, textureWidth: 64, textureHeight: 64, babyHead: false,
    animator(p, e, c) {
      p.head.rotY = c.headYaw; p.head.rotX = c.headPitch;
      p.headLeft.rotY = Math.sin(c.age * 0.05) * 0.5;
      p.headRight.rotY = Math.cos(c.age * 0.045) * 0.5;
      const float = Math.sin(c.age * 0.08) * 0.5;
      p.spine1.rotZ = float * 0.05;
      p.spine2.rotZ = -float * 0.06;
      p.spine3.rotZ = float * 0.08;
    },
  };
});

registerModel('ender_dragon', () => {
  const r = root();
  const body = r.child('body', 0, 12, 0);
  body.cube(-12, -12, -24, 24, 24, 48, 0, 0);
  const neck = body.child('neck', 0, 4, -24);
  neck.cube(-5, -5, -22, 10, 10, 22, 112, 30);
  const head = neck.child('head', 0, 0, -22);
  head.cube(-6, -6, -16, 12, 10, 16, 176, 44);
  head.child('jaw', 0, -6, -16).cube(-6, -4, 0, 12, 4, 16, 176, 65);
  head.child('hornR', -6, 4, -10).cube(-2, 0, -2, 4, 6, 4, 112, 30);
  head.child('hornL', 6, 4, -10).cube(-2, 0, -2, 4, 6, 4, 112, 30);
  const rightWing = body.child('rightWing', -12, 10, -6);
  rightWing.cube(-56, -2, -8, 56, 4, 16, 112, 88);
  rightWing.child('rightWingTip', -56, 0, 0).cube(-56, -1, -8, 56, 2, 16, 112, 136);
  const leftWing = body.child('leftWing', 12, 10, -6);
  leftWing.cube(0, -2, -8, 56, 4, 16, 112, 88);
  leftWing.child('leftWingTip', 56, 0, 0).cube(0, -1, -8, 56, 2, 16, 112, 136);
  let tail = body;
  for (let i = 0; i < 4; i++) {
    const seg = tail.child(`tail${i}`, 0, i === 0 ? 2 : 0, i === 0 ? 24 : 16);
    seg.cube(-4 + i * 0.5, -4 + i * 0.5, 0, 8 - i, 8 - i, 16, 192, 104);
    tail = seg;
  }
  return {
    root: r, textureWidth: 256, textureHeight: 256, babyHead: false,
    animator(p, e, c) {
      const flap = Math.sin(c.age * 0.12);
      p.rightWing.rotZ = -0.12 - flap * 0.5;
      p.leftWing.rotZ = 0.12 + flap * 0.5;
      p.rightWingTip.rotZ = -flap * 0.4;
      p.leftWingTip.rotZ = flap * 0.4;
      p.neck.rotX = clamp(c.headPitch * 0.5, -0.4, 0.4) + Math.sin(c.age * 0.06) * 0.06;
      p.head.rotY = c.headYaw * 0.4;
      for (let i = 0; i < 4; i++) {
        const seg = p[`tail${i}`];
        if (seg) seg.rotY = Math.sin(c.age * 0.09 - i * 0.6) * 0.18;
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Birds, bugs and aquatic life
// ---------------------------------------------------------------------------

registerModel('chicken', () => {
  const r = root();
  const body = r.child('body', 0, 10, 0).rotate(HALF_PI, 0, 0);
  body.cube(-3, -6, 0, 6, 8, 6, 0, 9);
  const head = r.child('head', 0, 13, -4);
  head.cube(-2, 0, -3, 4, 6, 3, 0, 0);
  head.child('beak', 0, 2, -3).cube(-2, 0, -2, 4, 2, 2, 14, 0);
  head.child('wattle', 0, 0, -3).cube(-1, 0, -2, 2, 2, 2, 14, 4);
  head.child('comb', 0, 6, -2).cube(-1, 0, -1, 2, 2, 4, 22, 0);
  const rightLeg = r.child('legRight', -2, 5, 1);
  rightLeg.cube(-1, -5, -3, 3, 5, 3, 26, 0);
  const leftLeg = r.child('legLeft', 2, 5, 1);
  leftLeg.cube(-1, -5, -3, 3, 5, 3, 26, 0);
  const rightWing = r.child('wingRight', -4, 13, 0);
  rightWing.cube(-1, -6, -3, 1, 6, 6, 24, 13);
  const leftWing = r.child('wingLeft', 4, 13, 0);
  leftWing.cube(0, -6, -3, 1, 6, 6, 24, 13);
  return {
    root: r, textureWidth: 64, textureHeight: 32,
    animator(p, e, c) {
      p.head.rotY = c.headYaw; p.head.rotX = c.headPitch;
      const swing = Math.cos(c.limbSwing * 0.6662) * 1.4 * c.limbAmount;
      p.legRight.rotX = swing;
      p.legLeft.rotX = -swing;
      const flap = e.onGround ? Math.sin(c.age * 0.2) * 0.1 : (c.age % 20) / 20 * 2;
      p.wingRight.rotZ = -flap;
      p.wingLeft.rotZ = flap;
    },
  };
});

registerModel('bat', () => {
  const r = root();
  const body = r.child('body', 0, 8, 0);
  body.cube(-3, -6, -3, 6, 12, 6, 0, 0);
  const head = r.child('head', 0, 14, 0);
  head.cube(-3, -3, -3, 6, 6, 6, 0, 0);
  head.child('earR', -3, 3, 0).cube(-2, 0, -1, 3, 5, 1, 24, 0);
  head.child('earL', 3, 3, 0).cube(-1, 0, -1, 3, 5, 1, 24, 0);
  const rightWing = r.child('rightWing', -3, 14, 0);
  rightWing.cube(-10, -8, 0, 10, 16, 1, 42, 0);
  const leftWing = r.child('leftWing', 3, 14, 0);
  leftWing.cube(0, -8, 0, 10, 16, 1, 42, 0);
  return {
    root: r, textureWidth: 64, textureHeight: 64, babyHead: false,
    animator(p, e, c) {
      const flap = Math.sin(c.age * 0.8);
      p.rightWing.rotY = -0.4 - flap * 0.8;
      p.leftWing.rotY = 0.4 + flap * 0.8;
      if (e.hanging) {
        p.root && (p.root.rotZ = Math.PI);
        p.rightWing.rotY = -0.15;
        p.leftWing.rotY = 0.15;
      }
      p.head.rotY = c.headYaw; p.head.rotX = c.headPitch;
    },
  };
});

registerModel('bee', () => {
  const r = root();
  const body = r.child('body', 0, 6, 0);
  body.cube(-3.5, -3, -5, 7, 7, 10, 0, 0);
  body.child('stinger', 0, -1, 5).cube(0, 0, 0, 0, 1, 2, 26, 7);
  body.child('antennaR', -1.5, 3, -5).cube(-1, 0, -2, 1, 2, 3, 2, 0);
  body.child('antennaL', 1.5, 3, -5).cube(0, 0, -2, 1, 2, 3, 2, 3);
  const rightWing = body.child('rightWing', -1.5, 3, -3).rotate(0, -0.2, 0);
  rightWing.cube(-9, 0, 0, 9, 0, 6, 0, 18);
  const leftWing = body.child('leftWing', 1.5, 3, -3).rotate(0, 0.2, 0);
  leftWing.cube(0, 0, 0, 9, 0, 6, 0, 18);
  const mkLeg = (name, x, z) => body.child(name, x, -3, z).cube(-0.5, -2, -0.5, 1, 2, 1, 26, 1);
  mkLeg('legFrontRight', -2, -4);
  mkLeg('legFrontLeft', 2, -4);
  mkLeg('legMidRight', -2, 0);
  mkLeg('legMidLeft', 2, 0);
  mkLeg('legBackRight', -2, 4);
  mkLeg('legBackLeft', 2, 4);
  return {
    root: r, textureWidth: 64, textureHeight: 64,
    animator(p, e, c) {
      const flap = Math.sin(c.age * 2.1) * 0.6;
      p.rightWing.rotZ = -flap; p.rightWing.rotY = -0.25;
      p.leftWing.rotZ = flap; p.leftWing.rotY = 0.25;
      p.body.rotX = clamp((e.vy ?? 0) * -0.5, -0.3, 0.3);
      const legAngle = e.onGround ? 0 : -0.6;
      for (const n of ['legFrontRight', 'legFrontLeft', 'legMidRight',
        'legMidLeft', 'legBackRight', 'legBackLeft']) {
        if (p[n]) p[n].rotX = legAngle;
      }
    },
  };
});

registerModel('allay', () => {
  const r = root();
  const body = r.child('body', 0, 8, 0);
  body.cube(-1.5, -4, -1, 3, 4, 2, 0, 0);
  const head = r.child('head', 0, 12, 0);
  head.cube(-2.5, 0, -2.5, 5, 5, 5, 0, 6);
  const rightArm = body.child('rightArm', -1.5, 0, 0);
  rightArm.cube(-1, -5, -1, 1, 5, 2, 23, 0);
  const leftArm = body.child('leftArm', 1.5, 0, 0);
  leftArm.cube(0, -5, -1, 1, 5, 2, 23, 0);
  const rightWing = body.child('rightWing', -1.5, -1, 1);
  rightWing.cube(-1, -4, 0, 1, 8, 4, 16, 14);
  const leftWing = body.child('leftWing', 1.5, -1, 1);
  leftWing.cube(0, -4, 0, 1, 8, 4, 16, 14);
  return {
    root: r, textureWidth: 32, textureHeight: 32,
    animator(p, e, c) {
      const flap = Math.sin(c.age * 0.9) * 0.5;
      p.rightWing.rotY = -0.5 - flap;
      p.leftWing.rotY = 0.5 + flap;
      p.head.rotY = c.headYaw; p.head.rotX = c.headPitch;
      p.rightArm.rotX = e.holding ? -1.2 : -0.2;
      p.leftArm.rotX = e.holding ? -1.2 : -0.2;
      p.body.pivotY = 8 + Math.sin(c.age * 0.12) * 0.6;
    },
  };
});

registerModel('squid', () => {
  const r = root();
  const body = r.child('body', 0, 8, 0);
  body.cube(-6, -8, -6, 12, 16, 12, 0, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const t = r.child(`tentacle${i}`, Math.cos(a) * 5, 0, Math.sin(a) * 5);
    t.rotY = -a;
    t.cube(-1, 0, -1, 2, 18, 2, 48, 0);
    t.pivotY = 0;
  }
  return {
    root: r, textureWidth: 64, textureHeight: 32, babyHead: false,
    animator(p, e, c) {
      for (let i = 0; i < 8; i++) {
        const t = p[`tentacle${i}`];
        if (t) t.rotX = Math.sin(c.age * 0.15) * 0.3 + 0.2;
      }
      p.body.rotX = Math.sin(c.age * 0.1) * 0.1;
    },
  };
});

registerModel('dolphin', () => {
  const r = root();
  const body = r.child('body', 0, 7, 0);
  body.cube(-4, -3, -8, 8, 7, 13, 22, 0);
  const head = body.child('head', 0, 0, -8);
  head.cube(-4, -3, -5, 8, 7, 6, 0, 0);
  head.child('snout', 0, -3, -5).cube(-1, 0, -4, 2, 2, 4, 0, 13);
  const tail = body.child('tail', 0, 0, 5);
  tail.cube(-2, -2, 0, 4, 5, 11, 0, 19);
  const fin = tail.child('tailFin', 0, 0, 11);
  fin.cube(-5, -0.5, 0, 10, 1, 4, 19, 20);
  body.child('dorsalFin', 0, 4, -2).cube(-0.5, 0, 0, 1, 3, 5, 51, 0);
  body.child('rightFin', -4, 0, -4).rotate(0, 0, -1.0).cube(-6, -0.5, 0, 6, 1, 4, 48, 8);
  body.child('leftFin', 4, 0, -4).rotate(0, 0, 1.0).cube(0, -0.5, 0, 6, 1, 4, 48, 8);
  return {
    root: r, textureWidth: 64, textureHeight: 64, babyHead: false,
    animator(p, e, c) {
      const speed = Math.hypot(e.vx ?? 0, e.vz ?? 0);
      const wave = Math.sin(c.age * (0.3 + speed * 6));
      p.tail.rotX = wave * 0.3;
      p.tailFin.rotX = wave * 0.4;
      p.body.rotX = clamp(-(e.vy ?? 0) * 1.5, -0.6, 0.6);
      p.head.rotY = c.headYaw * 0.4;
    },
  };
});

registerModel('fish', () => {
  const r = root();
  const body = r.child('body', 0, 3, 0);
  body.cube(-1, -2, -3, 2, 4, 6, 0, 0);
  const head = body.child('head', 0, 0, -3);
  head.cube(-1, -2, -3, 2, 4, 3, 0, 10);
  const tail = body.child('tail', 0, 0, 3);
  tail.cube(0, -2, 0, 0, 4, 5, 20, 1);
  body.child('rightFin', -1, -1, -2).rotate(0, 0, -0.8).cube(-2, 0, 0, 2, 0, 2, 24, 4);
  body.child('leftFin', 1, -1, -2).rotate(0, 0, 0.8).cube(0, 0, 0, 2, 0, 2, 24, 4);
  body.child('topFin', 0, 2, -1).cube(0, 0, 0, 0, 2, 5, 14, 0);
  return {
    root: r, textureWidth: 32, textureHeight: 32, babyHead: false,
    animator: swimmerAnimator,
  };
});

registerModel('pufferfish', () => {
  const r = root();
  const body = r.child('body', 0, 4, 0);
  body.cube(-2.5, -2.5, -2.5, 5, 5, 5, 0, 0);
  body.child('eyeR', -2.5, 0, -2.5).cube(0, 0, 0, 1, 1, 1, 24, 0);
  body.child('eyeL', 1.5, 0, -2.5).cube(0, 0, 0, 1, 1, 1, 28, 0);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const spike = body.child(`spike${i}`, Math.cos(a) * 2.5, Math.sin(a) * 2.5, 0);
    spike.rotZ = a;
    spike.cube(-0.5, 0, -0.5, 1, 3, 1, 20, 5);
  }
  const tail = body.child('tail', 0, 0, 2.5);
  tail.cube(0, -1.5, 0, 0, 3, 3, 20, 5);
  return {
    root: r, textureWidth: 32, textureHeight: 32, babyHead: false,
    animator(p, e, c) {
      const puff = e.puffState ?? 0;
      const s = 1 + puff * 0.5;
      p.body.scaleX = s; p.body.scaleY = s; p.body.scaleZ = s;
      for (let i = 0; i < 6; i++) {
        const spike = p[`spike${i}`];
        if (spike) spike.scaleY = puff;
      }
      p.tail.rotY = Math.sin(c.age * 0.3) * 0.4;
    },
  };
});

registerModel('axolotl', () => {
  const r = root();
  const body = r.child('body', 0, 4, 0);
  body.cube(-4, -2, -6, 8, 4, 11, 0, 11);
  const head = body.child('head', 0, 0, -6);
  head.cube(-4, -2, -5, 8, 5, 5, 0, 1);
  head.child('gillsTop', 0, 3, -1).cube(-4, 0, 0, 8, 3, 0, 3, 37);
  head.child('gillsRight', -4, 0, -1).cube(-3, -2, 0, 3, 4, 0, 0, 40);
  head.child('gillsLeft', 4, 0, -1).cube(0, -2, 0, 3, 4, 0, 11, 40);
  const tail = body.child('tail', 0, 0, 5);
  tail.cube(0, -2, 0, 0, 5, 12, 2, 19);
  body.child('legFrontRight', -4, -2, -4).cube(-1, -3, -1, 2, 3, 2, 2, 13);
  body.child('legFrontLeft', 4, -2, -4).cube(-1, -3, -1, 2, 3, 2, 2, 13);
  body.child('legBackRight', -4, -2, 3).cube(-1, -3, -1, 2, 3, 2, 2, 13);
  body.child('legBackLeft', 4, -2, 3).cube(-1, -3, -1, 2, 3, 2, 2, 13);
  return {
    root: r, textureWidth: 64, textureHeight: 64,
    animator(p, e, c) {
      const wave = Math.sin(c.age * 0.25);
      p.tail.rotY = wave * 0.5;
      p.head.rotY = c.headYaw * 0.5;
      if (e.playingDead) { p.body.rotZ = Math.PI * 0.9; }
      const legSwing = Math.cos(c.limbSwing * 0.6662) * 0.8 * c.limbAmount;
      p.legFrontRight.rotX = legSwing; p.legFrontLeft.rotX = -legSwing;
      p.legBackRight.rotX = -legSwing; p.legBackLeft.rotX = legSwing;
    },
  };
});

registerModel('turtle', () => buildQuadruped({
  legH: 3, legW: 4, bodyW: 18, bodyT: 6, bodyL: 20,
  headW: 6, headH: 5, headL: 6, headY: 6, headZ: -9, headOY: -2,
  sheetW: 128, sheetH: 64, bodyUV: [7, 37], headUV: [3, 0], legUV: [1, 23],
  extra(r) {
    const shell = r.find('body').child('shell', 0, 0, 0);
    shell.cube(-9.5, -10, -1, 19, 20, 2, 70, 33);
  },
  animator(p, e, c) {
    quadrupedAnimator(p, e, c);
    // Turtles paddle in water and shuffle on land.
    if (e.inWater) {
      const paddle = Math.sin(c.age * 0.3);
      p.legFrontRight.rotY = paddle; p.legFrontLeft.rotY = -paddle;
      p.legBackRight.rotY = -paddle * 0.5; p.legBackLeft.rotY = paddle * 0.5;
    }
  },
}));

registerModel('frog', () => {
  const r = root();
  const body = r.child('body', 0, 3, 0);
  body.cube(-3.5, 0, -4, 7, 3, 9, 3, 1);
  const head = body.child('head', 0, 3, -4);
  head.cube(-3.5, -3, -4, 7, 3, 5, 23, 25);
  head.child('eyeR', -2.5, 0, -2).cube(-1, 0, -1, 2, 2, 2, 0, 16);
  head.child('eyeL', 2.5, 0, -2).cube(-1, 0, -1, 2, 2, 2, 0, 20);
  head.child('tongue', 0, -3, -4).cube(-2, 0, 0, 4, 0, 3, 17, 13);
  const mk = (name, x, z, front) => {
    const leg = body.child(name, x, 0, z);
    leg.cube(-1, -3, front ? -2 : -1, 2, 3, 3, 0, 6);
    return leg;
  };
  mk('legFrontRight', -3.5, -2, true);
  mk('legFrontLeft', 3.5, -2, true);
  mk('legBackRight', -3.5, 4, false);
  mk('legBackLeft', 3.5, 4, false);
  return {
    root: r, textureWidth: 48, textureHeight: 48,
    animator(p, e, c) {
      p.head.rotY = c.headYaw; p.head.rotX = c.headPitch;
      const croak = Math.sin(c.age * 0.1) * 0.05;
      p.body.scaleZ = 1 + croak;
      if (!e.onGround) {
        p.legBackRight.rotX = -1.0; p.legBackLeft.rotX = -1.0;
        p.legFrontRight.rotX = 0.6; p.legFrontLeft.rotX = 0.6;
      } else {
        const hop = Math.max(0, Math.sin(c.limbSwing * 0.5)) * c.limbAmount;
        p.legBackRight.rotX = -hop; p.legBackLeft.rotX = -hop;
      }
      if (p.tongue) p.tongue.visible = !!e.tongueOut;
    },
  };
});

registerModel('tadpole', () => {
  const r = root();
  const body = r.child('body', 0, 2, 0);
  body.cube(-1.5, -1.5, -2, 3, 3, 4, 0, 0);
  const tail = body.child('tail', 0, 0, 2);
  tail.cube(0, -1.5, 0, 0, 3, 5, 0, 7);
  return {
    root: r, textureWidth: 16, textureHeight: 16, babyHead: false,
    animator: swimmerAnimator,
  };
});

registerModel('iron_golem', () => {
  const r = root();
  const head = r.child('head', 0, 33, -2);
  head.cube(-4, 0, -6, 8, 10, 8, 0, 0);
  head.child('nose', 0, 1, -6).cube(-1, 0, -2, 2, 4, 2, 24, 0);
  const body = r.child('body', 0, 33, 0);
  body.cube(-9, -21, -6, 18, 12, 11, 0, 40);
  body.cube(-4.5, -12, -3, 9, 5, 6, 0, 70);
  const rightArm = r.child('rightArm', -10, 32, 0);
  rightArm.cube(-4, -30, -3, 4, 30, 6, 60, 21);
  const leftArm = r.child('leftArm', 10, 32, 0);
  leftArm.cube(0, -30, -3, 4, 30, 6, 60, 58);
  const rightLeg = r.child('rightLeg', -4, 12, 0);
  rightLeg.cube(-3, -12, -3, 6, 12, 5, 37, 0);
  const leftLeg = r.child('leftLeg', 4, 12, 0);
  leftLeg.cube(-3, -12, -3, 6, 12, 5, 60, 0);
  return {
    root: r, textureWidth: 128, textureHeight: 128, babyHead: false,
    animator(p, e, c) {
      p.head.rotY = c.headYaw; p.head.rotX = c.headPitch;
      const swing = Math.cos(c.limbSwing * 0.4) * 1.0 * c.limbAmount;
      p.rightLeg.rotX = swing; p.leftLeg.rotX = -swing;
      // Arms swing in the opposite phase and stay heavy.
      p.rightArm.rotX = (-0.2 + 1.5 * triangleWave(c.limbSwing, 13)) * c.limbAmount;
      p.leftArm.rotX = (-0.2 - 1.5 * triangleWave(c.limbSwing, 13)) * c.limbAmount;
      if (e.attackTicks > 0) {
        const t = e.attackTicks / 10;
        p.rightArm.rotX = -2.0 + 1.5 * t;
        p.leftArm.rotX = -2.0 + 1.5 * t;
      }
      if (e.offerTicks > 0) {
        p.rightArm.rotX = -0.8; p.leftArm.rotX = -0.8;
        p.head.rotX = 0.5;
      }
    },
  };
});

registerModel('snow_golem', () => {
  const r = root();
  const head = r.child('head', 0, 20, 0);
  head.cube(-4, 0, -4, 8, 8, 8, 0, 0);
  head.child('pumpkin', 0, 0, 0).cube(-4, 0, -4, 8, 8, 8, 32, 0, 0.4);
  const upper = r.child('body', 0, 10, 0);
  upper.cube(-5, 0, -5, 10, 10, 10, 0, 16);
  const lower = r.child('base', 0, 0, 0);
  lower.cube(-6, 0, -6, 12, 10, 12, 0, 36);
  const rightArm = r.child('rightArm', -5, 18, 0).rotate(0, 0, -0.4);
  rightArm.cube(-8, -1, -1, 8, 2, 2, 32, 0);
  const leftArm = r.child('leftArm', 5, 18, 0).rotate(0, 0, 0.4);
  leftArm.cube(0, -1, -1, 8, 2, 2, 32, 0);
  return {
    root: r, textureWidth: 64, textureHeight: 64, babyHead: false,
    animator(p, e, c) {
      p.head.rotY = c.headYaw; p.head.rotX = c.headPitch;
      p.pumpkin.rotY = c.headYaw; p.pumpkin.rotX = c.headPitch;
      p.pumpkin.visible = e.pumpkin !== false;
      p.rightArm.rotX = Math.sin(c.age * 0.06) * 0.05;
      p.leftArm.rotX = -Math.sin(c.age * 0.06) * 0.05;
    },
  };
});

function triangleWave(v, period) {
  return (Math.abs((v % period) - period * 0.5) - period * 0.25) / (period * 0.25);
}

/** Register a model that is geometrically identical to another. */
function getModelBuilderClone(name) {
  const src = builders.get(name);
  if (!src) return { root: root(), textureWidth: 64, textureHeight: 32 };
  return src();
}

/** Models whose only difference from another is the skin. */
const ALIASES = {
  husk: 'zombie', drowned: 'zombie', zombie_villager: 'zombie',
  zombified_piglin: 'zombie', piglin: 'zombie', piglin_brute: 'zombie',
  stray: 'skeleton', wither_skeleton: 'skeleton',
  evoker: 'illager', vindicator: 'illager', pillager: 'illager',
  wandering_trader: 'villager',
  cave_spider: 'spider',
  elder_guardian: 'guardian',
  mooshroom: 'cow',
  donkey: 'horse', mule: 'horse', trader_llama: 'llama',
  cod: 'fish', salmon: 'fish', tropical_fish: 'fish',
  glow_squid: 'squid',
  zoglin: 'hoglin',
};

for (const [alias, source] of Object.entries(ALIASES)) {
  registerModel(alias, () => getModelBuilderClone(source));
}

export { ALIASES as MODEL_ALIASES };
