// Shared collision / model shape helpers in block-local 0..1 space.

import { AABB } from '../core/math.js';

export const FULL = [new AABB(0, 0, 0, 1, 1, 1)];
export const NONE = [];

export const slabBottom = [new AABB(0, 0, 0, 1, 0.5, 1)];
export const slabTop = [new AABB(0, 0.5, 0, 1, 1, 1)];

export const carpet = [new AABB(0, 0, 0, 1, 1 / 16, 1)];
export const pressurePlate = [new AABB(1 / 16, 0, 1 / 16, 15 / 16, 1 / 32, 15 / 16)];
export const soulSand = [new AABB(0, 0, 0, 1, 7 / 8, 1)];
export const cactus = [new AABB(1 / 16, 0, 1 / 16, 15 / 16, 15 / 16, 15 / 16)];
export const cake = [new AABB(1 / 16, 0, 1 / 16, 15 / 16, 0.5, 15 / 16)];
export const bed = [new AABB(0, 0, 0, 1, 9 / 16, 1)];
export const enchantingTable = [new AABB(0, 0, 0, 1, 0.75, 1)];
export const grindstone = [new AABB(2 / 16, 4 / 16, 0, 14 / 16, 1, 1)];
export const lectern = [new AABB(0, 0, 0, 1, 1, 1)];
export const farmland = [new AABB(0, 0, 0, 1, 15 / 16, 1)];
export const chestShape = [new AABB(1 / 16, 0, 1 / 16, 15 / 16, 14 / 16, 15 / 16)];
export const enderChestShape = chestShape;
export const hopperShape = [
  new AABB(0, 10 / 16, 0, 1, 1, 1),
  new AABB(0, 0, 0, 1, 10 / 16, 2 / 16),
  new AABB(0, 0, 14 / 16, 1, 10 / 16, 1),
  new AABB(0, 0, 0, 2 / 16, 10 / 16, 1),
  new AABB(14 / 16, 0, 0, 1, 10 / 16, 1),
  new AABB(6 / 16, 4 / 16, 6 / 16, 10 / 16, 10 / 16, 10 / 16),
];
export const anvilShape = [new AABB(2 / 16, 0, 0, 14 / 16, 1, 1)];
export const brewingStand = [
  new AABB(0, 0, 0, 1, 2 / 16, 1),
  new AABB(7 / 16, 0, 7 / 16, 9 / 16, 14 / 16, 9 / 16),
];
export const cauldron = [
  new AABB(0, 0, 0, 1, 3 / 16, 1),
  new AABB(0, 0, 0, 2 / 16, 1, 1),
  new AABB(14 / 16, 0, 0, 1, 1, 1),
  new AABB(0, 0, 0, 1, 1, 2 / 16),
  new AABB(0, 0, 14 / 16, 1, 1, 1),
];
export const flowerPot = [new AABB(5 / 16, 0, 5 / 16, 11 / 16, 6 / 16, 11 / 16)];
export const endPortalFrame = [new AABB(0, 0, 0, 1, 13 / 16, 1)];
export const conduitShape = [new AABB(5 / 16, 5 / 16, 5 / 16, 11 / 16, 11 / 16, 11 / 16)];
export const lantern = [new AABB(5 / 16, 0, 5 / 16, 11 / 16, 7 / 16, 11 / 16)];
export const hangingLantern = [new AABB(5 / 16, 1 / 16, 5 / 16, 11 / 16, 8 / 16, 11 / 16)];
export const campfire = [new AABB(0, 0, 0, 1, 7 / 16, 1)];
export const snowLayer = (layers) => layers >= 8
  ? [new AABB(0, 0, 0, 1, 1, 1)]
  : [new AABB(0, 0, 0, 1, layers * 2 / 16, 1)];
export const scaffolding = [new AABB(0, 0, 0, 1, 2 / 16, 1)];
export const daylightDetector = [new AABB(0, 0, 0, 1, 6 / 16, 1)];
export const stonecutter = [new AABB(0, 0, 0, 1, 9 / 16, 1)];
export const composter = [
  new AABB(0, 0, 0, 1, 2 / 16, 1),
  new AABB(0, 0, 0, 2 / 16, 1, 1),
  new AABB(14 / 16, 0, 0, 1, 1, 1),
  new AABB(0, 0, 0, 1, 1, 2 / 16),
  new AABB(0, 0, 14 / 16, 1, 1, 1),
];

/** Ladder / wall-mounted plate against `facing` (0 N, 1 E, 2 S, 3 W). */
export function ladderShape(facing) {
  const t = 3 / 16;
  switch (facing) {
    case 0: return [new AABB(0, 0, 1 - t, 1, 1, 1)];
    case 1: return [new AABB(0, 0, 0, t, 1, 1)];
    case 2: return [new AABB(0, 0, 0, 1, 1, t)];
    default: return [new AABB(1 - t, 0, 0, 1, 1, 1)];
  }
}

/** Torch attached to a wall — a thin box hugging the opposite side. */
export function wallTorchShape(facing) {
  const w = 2 / 16;
  switch (facing) {
    case 0: return [new AABB(0.5 - w, 0.2, 1 - 5 / 16, 0.5 + w, 0.8, 1)];
    case 1: return [new AABB(0, 0.2, 0.5 - w, 5 / 16, 0.8, 0.5 + w)];
    case 2: return [new AABB(0.5 - w, 0.2, 0, 0.5 + w, 0.8, 5 / 16)];
    default: return [new AABB(1 - 5 / 16, 0.2, 0.5 - w, 1, 0.8, 0.5 + w)];
  }
}

export const torchShape = [new AABB(7 / 16, 0, 7 / 16, 9 / 16, 10 / 16, 9 / 16)];

/** Stair collision: a slab plus the step quadrant(s). */
export function stairShape(facing, half, shape) {
  const boxes = [];
  boxes.push(half === 'top'
    ? new AABB(0, 0.5, 0, 1, 1, 1)
    : new AABB(0, 0, 0, 1, 0.5, 1));
  const y0 = half === 'top' ? 0 : 0.5;
  const y1 = y0 + 0.5;
  // The upper step covers the half of the block on the `facing` side.
  const strip = stripFor(facing);
  if (shape === 'straight') {
    boxes.push(new AABB(strip[0], y0, strip[1], strip[2], y1, strip[3]));
  } else if (shape === 'inner_left' || shape === 'inner_right') {
    boxes.push(new AABB(strip[0], y0, strip[1], strip[2], y1, strip[3]));
    const side = stripFor(rotate(facing, shape === 'inner_left' ? -1 : 1));
    boxes.push(new AABB(side[0], y0, side[1], side[2], y1, side[3]));
  } else {
    // Outer: only the quarter shared by facing and the adjacent side.
    const a = stripFor(facing);
    const b = stripFor(rotate(facing, shape === 'outer_left' ? -1 : 1));
    boxes.push(new AABB(
      Math.max(a[0], b[0]), y0, Math.max(a[1], b[1]),
      Math.min(a[2], b[2]), y1, Math.min(a[3], b[3])));
  }
  return boxes;
}

const rotate = (facing, d) => (facing + d + 4) % 4;

/** Half-block strip [x0,z0,x1,z1] on the side a stair faces. */
function stripFor(facing) {
  switch (facing) {
    case 0: return [0, 0, 1, 0.5];      // north
    case 1: return [0.5, 0, 1, 1];      // east
    case 2: return [0, 0.5, 1, 1];      // south
    default: return [0, 0, 0.5, 1];     // west
  }
}

/** Fence / wall / pane collision from connection flags. */
export function connectedShape(n, e, s, w, thickness, height, postSize = thickness) {
  const boxes = [];
  const h = postSize / 2;
  boxes.push(new AABB(0.5 - h, 0, 0.5 - h, 0.5 + h, height, 0.5 + h));
  const t = thickness / 2;
  if (n) boxes.push(new AABB(0.5 - t, 0, 0, 0.5 + t, height, 0.5));
  if (s) boxes.push(new AABB(0.5 - t, 0, 0.5, 0.5 + t, height, 1));
  if (w) boxes.push(new AABB(0, 0, 0.5 - t, 0.5, height, 0.5 + t));
  if (e) boxes.push(new AABB(0.5, 0, 0.5 - t, 1, height, 0.5 + t));
  return boxes;
}

/** Door collision: a 3/16 slab against one edge, or the hinge side when open. */
export function doorShape(facing, open, hinge) {
  const t = 3 / 16;
  let dir = facing;
  if (open) dir = (facing + (hinge === 'right' ? 1 : 3)) % 4;
  switch (dir) {
    case 0: return [new AABB(0, 0, 0, 1, 1, t)];
    case 1: return [new AABB(1 - t, 0, 0, 1, 1, 1)];
    case 2: return [new AABB(0, 0, 1 - t, 1, 1, 1)];
    default: return [new AABB(0, 0, 0, t, 1, 1)];
  }
}

export function trapdoorShape(facing, open, half) {
  const t = 3 / 16;
  if (!open) {
    return half === 'top'
      ? [new AABB(0, 1 - t, 0, 1, 1, 1)]
      : [new AABB(0, 0, 0, 1, t, 1)];
  }
  switch (facing) {
    case 0: return [new AABB(0, 0, 1 - t, 1, 1, 1)];
    case 1: return [new AABB(0, 0, 0, t, 1, 1)];
    case 2: return [new AABB(0, 0, 0, 1, 1, t)];
    default: return [new AABB(1 - t, 0, 0, 1, 1, 1)];
  }
}

/** Button on a face; `face` is 'floor' | 'wall' | 'ceiling'. */
export function buttonShape(face, facing, pressed) {
  const d = pressed ? 1 / 16 : 2 / 16;
  const w = 3 / 16, h = 2 / 16;
  if (face === 'floor') return [new AABB(0.5 - w, 0, 0.5 - h, 0.5 + w, d, 0.5 + h)];
  if (face === 'ceiling') return [new AABB(0.5 - w, 1 - d, 0.5 - h, 0.5 + w, 1, 0.5 + h)];
  switch (facing) {
    case 0: return [new AABB(0.5 - w, 0.5 - h, 1 - d, 0.5 + w, 0.5 + h, 1)];
    case 1: return [new AABB(0, 0.5 - h, 0.5 - w, d, 0.5 + h, 0.5 + w)];
    case 2: return [new AABB(0.5 - w, 0.5 - h, 0, 0.5 + w, 0.5 + h, d)];
    default: return [new AABB(1 - d, 0.5 - h, 0.5 - w, 1, 0.5 + h, 0.5 + w)];
  }
}

/** Fluid collision height from a level value (0 = source, 8 = falling). */
export function fluidHeight(level) {
  return level === 0 ? 1 : (8 - level) / 9;
}
