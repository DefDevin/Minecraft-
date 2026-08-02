// Block entities: the state a block cannot fit into sixteen bits.
//
// A chest's contents, a furnace's burn timer, a sign's text, a spawner's
// countdown — all of it hangs off the chunk in a `BlockEntity`, created and
// destroyed automatically with its block by `World.setBlock`. The registry
// marks such blocks with `hasEntity` and names the flavour in `blockEntity`;
// `createBlockEntity` maps that name onto a class here.
//
// One rule matters beyond this file: **every container exposes a `slots`
// array**. game/hooks.js hands any block entity with `slots` to the generic
// container screen, so a new storage block gets a working UI for free.

import { blockOf, getProp, withProp, blocksByName, T } from './blocks.js';
import { FLAG } from './world.js';
import { ItemStack, itemsByName } from '../game/items.js';
import { FACES, HORIZONTAL, AABB } from '../core/math.js';

/** Optional recipe module — furnaces fall back to a built-in table without it. */
let RECIPES = null;
import('../game/recipes.js').then((m) => { RECIPES = m; }).catch(() => { RECIPES = null; });

const FACING_FACE = { west: 0, east: 1, down: 2, up: 3, north: 4, south: 5 };

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

export class BlockEntity {
  constructor(type, x, y, z, state, def) {
    this.type = type;
    this.x = x; this.y = y; this.z = z;
    this.state = state;
    this.def = def || blockOf(state) || null;
    this.removed = false;
    /** Set false by inert entities so the tick loop can skip them cheaply. */
    this.needsTick = false;
    this.dirty = false;
  }

  /** The current block state, re-read from the world. */
  blockState(world) { return world.getBlock(this.x, this.y, this.z); }

  /** Called once a game tick while the chunk is loaded. */
  tick(world) {}

  /** Mark the chunk as needing a save and the section as needing a remesh. */
  setChanged(world) {
    this.dirty = true;
    if (!world) return;
    const c = world.getChunkAt(this.x, this.z);
    if (c) { c.needsSave = true; c.markDirty((this.y + 64) >> 4); }
  }

  /** Serialise to a plain object for the save file. */
  save() {
    return { type: this.type, x: this.x, y: this.y, z: this.z };
  }

  /** Restore from `save()` output. Subclasses extend, never replace. */
  load(data) {
    if (!data) return this;
    if (data.x != null) { this.x = data.x; this.y = data.y; this.z = data.z; }
    return this;
  }
}

/** Serialise a slot array; nulls stay nulls so indices are preserved. */
function saveSlots(slots) {
  return slots.map((s) => (s && s.count > 0 ? s.toJSON() : null));
}

function loadSlots(slots, data) {
  if (!Array.isArray(data)) return slots;
  for (let i = 0; i < slots.length; i++) {
    slots[i] = data[i] ? ItemStack.fromJSON(data[i]) : null;
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/** Anything with an inventory. `slots` is the contract the UI reads. */
export class ContainerBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def, size) {
    super(type, x, y, z, state, def);
    const n = size ?? def?.container?.slots ?? 27;
    this.slots = new Array(n).fill(null);
    this.viewers = 0;
  }

  get size() { return this.slots.length; }
  getItem(i) { return this.slots[i] || null; }
  setItem(i, stack) { this.slots[i] = stack && stack.count > 0 ? stack : null; }
  isEmpty() { return this.slots.every((s) => !s || s.count <= 0); }

  /** Merge `stack` in, returning what would not fit (or null). */
  addItem(stack, from = 0, to = this.slots.length) {
    if (!stack || stack.count <= 0) return null;
    for (let i = from; i < to; i++) {
      const s = this.slots[i];
      if (!s || !s.matches(stack)) continue;
      const room = Math.min(s.maxStack, 64) - s.count;
      if (room <= 0) continue;
      const move = Math.min(room, stack.count);
      s.count += move; stack.count -= move;
      if (stack.count <= 0) return null;
    }
    for (let i = from; i < to; i++) {
      if (this.slots[i]) continue;
      this.slots[i] = stack;
      return null;
    }
    return stack;
  }

  /** Take `count` items out of one slot. */
  removeItem(i, count) {
    const s = this.slots[i];
    if (!s) return null;
    const out = s.split(count);
    if (s.count <= 0) this.slots[i] = null;
    return out;
  }

  /** 0..15 for a comparator, on Minecraft's fullness curve. */
  comparatorOutput() {
    let fill = 0, used = 0;
    for (const s of this.slots) {
      if (!s || s.count <= 0) continue;
      used++;
      fill += s.count / Math.max(1, Math.min(64, s.maxStack));
    }
    if (used === 0) return 0;
    return Math.floor((fill / this.slots.length) * 14) + 1;
  }

  /** Scatter the contents when the block breaks. */
  dropContents(world) {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s || s.count <= 0) continue;
      world.game?.drops?.spawnStack?.(world, this.x, this.y, this.z, s);
      this.slots[i] = null;
    }
  }

  save() { return Object.assign(super.save(), { slots: saveSlots(this.slots) }); }
  load(data) { super.load(data); loadSlots(this.slots, data?.slots); return this; }
}

/** The lid animation and the open/close sounds shared by chests and barrels. */
class LiddedContainer extends ContainerBlockEntity {
  constructor(type, x, y, z, state, def, size) {
    super(type, x, y, z, state, def, size);
    this.lidAngle = 0;
    this.prevLidAngle = 0;
    this.needsTick = true;
    this.openSound = 'chest.open';
    this.closeSound = 'chest.close';
  }

  startOpen(world) {
    if (this.viewers === 0) world.playSound(this.openSound, this.x + 0.5, this.y + 0.5, this.z + 0.5);
    this.viewers++;
    this.onViewersChanged(world);
  }

  stopOpen(world) {
    this.viewers = Math.max(0, this.viewers - 1);
    if (this.viewers === 0) world.playSound(this.closeSound, this.x + 0.5, this.y + 0.5, this.z + 0.5);
    this.onViewersChanged(world);
  }

  onViewersChanged(world) {}

  tick(world) {
    this.prevLidAngle = this.lidAngle;
    const target = this.viewers > 0 ? 1 : 0;
    this.lidAngle += (target - this.lidAngle) * 0.35;
    if (Math.abs(this.lidAngle - target) < 0.002) this.lidAngle = target;
  }

  /** Interpolated lid angle for the renderer. */
  lidAt(alpha) {
    return this.prevLidAngle + (this.lidAngle - this.prevLidAngle) * alpha;
  }
}

export class ChestBlockEntity extends LiddedContainer {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def, 27);
  }

  /**
   * The other half of a double chest, or null.
   *
   * `type` on the block state already records which side we are, and the
   * partner is always at right angles to the way the pair faces.
   */
  partner(world) {
    const state = this.blockState(world);
    const def = blockOf(state);
    if (!def?.isChest) return null;
    const kind = getProp(state, 'type');
    if (kind === 'single') return null;
    const facing = { north: 0, east: 1, south: 2, west: 3 }[getProp(state, 'facing')];
    const side = kind === 'left' ? (facing + 1) & 3 : (facing + 3) & 3;
    const d = HORIZONTAL[side];
    const ns = world.getBlock(this.x + d.dx, this.y, this.z + d.dz);
    if (blockOf(ns) !== def) return null;
    return world.getBlockEntity(this.x + d.dx, this.y, this.z + d.dz);
  }

  /** Both halves of a double chest as one 54-slot view. */
  combinedSlots(world) {
    const other = this.partner(world);
    if (!other) return this.slots;
    const state = this.blockState(world);
    return getProp(state, 'type') === 'left'
      ? this.slots.concat(other.slots)
      : other.slots.concat(this.slots);
  }

  onViewersChanged(world) {
    const other = this.partner(world);
    if (other && other.viewers !== this.viewers) {
      other.viewers = this.viewers;
    }
    // A trapped chest is a redstone source, so the circuit has to be told.
    if (this.def?.name === 'trapped_chest') {
      world.game?.redstone?.update?.(world, this.x, this.y, this.z);
      world.game?.redstone?.update?.(world, this.x, this.y - 1, this.z);
    }
  }
}

export class BarrelBlockEntity extends LiddedContainer {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def, 27);
    this.openSound = 'barrel.open';
    this.closeSound = 'barrel.close';
  }

  onViewersChanged(world) {
    const state = this.blockState(world);
    const open = this.viewers > 0;
    if (getProp(state, 'open') !== open) {
      world.setBlock(this.x, this.y, this.z, withProp(state, 'open', open),
        FLAG.MARK_DIRTY);
    }
  }
}

export class EnderChestBlockEntity extends LiddedContainer {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def, 27);
    // The real contents live on the player; these slots exist so the generic
    // container screen still has something to render against.
    this.shared = true;
  }
  comparatorOutput() { return 0; }
  dropContents() {}
}

export class ShulkerBoxBlockEntity extends LiddedContainer {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def, 27);
    this.openSound = 'shulker.open';
    this.closeSound = 'shulker.close';
  }
  /** A shulker box keeps its contents when broken. */
  dropContents(world) {
    const stack = new ItemStack(this.def?.item || 'shulker_box', 1, 0,
      { items: saveSlots(this.slots) });
    world.game?.drops?.spawnStack?.(world, this.x, this.y, this.z, stack);
    this.slots.fill(null);
  }
}

// ---------------------------------------------------------------------------
// Furnaces
// ---------------------------------------------------------------------------

/** Enough of a smelting table to work before game/recipes.js lands. */
const FALLBACK_SMELTING = {
  iron_ore: 'iron_ingot', deepslate_iron_ore: 'iron_ingot', raw_iron: 'iron_ingot',
  gold_ore: 'gold_ingot', deepslate_gold_ore: 'gold_ingot', raw_gold: 'gold_ingot',
  copper_ore: 'copper_ingot', deepslate_copper_ore: 'copper_ingot', raw_copper: 'copper_ingot',
  ancient_debris: 'netherite_scrap',
  sand: 'glass', red_sand: 'glass', cobblestone: 'stone', stone: 'smooth_stone',
  clay_ball: 'brick', clay: 'terracotta', netherrack: 'nether_brick',
  cactus: 'green_dye', kelp: 'dried_kelp', sea_pickle: 'lime_dye',
  chorus_fruit: 'popped_chorus_fruit', wet_sponge: 'sponge',
  porkchop: 'cooked_porkchop', beef: 'cooked_beef', chicken: 'cooked_chicken',
  mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod',
  salmon: 'cooked_salmon', potato: 'baked_potato',
};

const SMELT_XP = {
  iron_ingot: 0.7, gold_ingot: 1, copper_ingot: 0.7, netherite_scrap: 2,
  glass: 0.1, stone: 0.1, smooth_stone: 0.1, brick: 0.3, nether_brick: 0.1,
};

const FOOD_ITEMS = new Set([
  'porkchop', 'beef', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'potato',
  'kelp', 'chorus_fruit',
]);

const ORE_ITEMS = new Set([
  'iron_ore', 'deepslate_iron_ore', 'raw_iron', 'gold_ore', 'deepslate_gold_ore',
  'raw_gold', 'copper_ore', 'deepslate_copper_ore', 'raw_copper', 'ancient_debris',
]);

/** Look a smelting result up, preferring the recipe module when it is loaded. */
function smeltingResult(kind, stack) {
  if (!stack || stack.count <= 0) return null;
  const name = stack.item.name;
  const viaModule = RECIPES?.smeltingFor?.(name, kind) ?? RECIPES?.findSmelting?.(name, kind);
  if (viaModule) return viaModule;
  if (kind === 'smoker' && !FOOD_ITEMS.has(name)) return null;
  if (kind === 'blast_furnace' && !ORE_ITEMS.has(name)) return null;
  const out = FALLBACK_SMELTING[name];
  if (!out || !itemsByName.has(out)) return null;
  return { item: out, count: 1, xp: SMELT_XP[out] ?? 0.1 };
}

/** Burn time of a fuel item, in ticks. */
export function fuelValue(stack) {
  if (!stack || stack.count <= 0) return 0;
  const item = stack.item;
  if (item.fuelTicks > 0) return item.fuelTicks;
  if (item.name === 'lava_bucket') return 20000;
  if (item.name === 'coal' || item.name === 'charcoal') return 1600;
  if (item.name === 'coal_block') return 16000;
  if (item.name === 'blaze_rod') return 2400;
  if (item.name === 'stick') return 100;
  const block = blocksByName.get(item.block || item.name);
  return block?.fuelTicks ?? 0;
}

/**
 * Furnaces, blast furnaces and smokers. Three slots — input, fuel, output —
 * and two independent clocks: how long the fuel lasts and how far the current
 * item has cooked.
 */
export class FurnaceBlockEntity extends ContainerBlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def, 3);
    this.kind = def?.name || 'furnace';
    this.burnTime = 0;         // ticks of fuel left
    this.burnDuration = 0;     // ticks the current fuel item lasted
    this.cookTime = 0;
    this.cookDuration = this.kind === 'furnace' ? 200 : 100;
    this.storedXp = 0;
    this.needsTick = true;
  }

  get input() { return this.slots[0]; }
  get fuel() { return this.slots[1]; }
  get output() { return this.slots[2]; }

  canAccept(result) {
    if (!result) return false;
    const out = this.slots[2];
    if (!out) return true;
    if (out.item.name !== result.item) return false;
    return out.count + result.count <= Math.min(64, out.maxStack);
  }

  tick(world) {
    const wasLit = this.burnTime > 0;
    if (this.burnTime > 0) this.burnTime--;

    const result = smeltingResult(this.kind, this.slots[0]);
    const canCook = this.canAccept(result);

    if (this.burnTime === 0 && canCook) {
      const value = fuelValue(this.slots[1]);
      if (value > 0) {
        this.burnTime = value;
        this.burnDuration = value;
        const fuel = this.slots[1];
        const remainder = fuel.item.craftRemainder;
        fuel.count--;
        if (fuel.count <= 0) {
          this.slots[1] = remainder && itemsByName.has(remainder)
            ? new ItemStack(remainder, 1) : null;
        }
      }
    }

    if (this.burnTime > 0 && canCook) {
      this.cookTime++;
      if (this.cookTime >= this.cookDuration) {
        this.cookTime = 0;
        this.finishCook(result);
      }
    } else if (this.cookTime > 0) {
      this.cookTime = Math.max(0, this.cookTime - 2);
    }

    const lit = this.burnTime > 0;
    if (lit !== wasLit) {
      const state = this.blockState(world);
      if (blockOf(state) === this.def && getProp(state, 'lit') !== lit) {
        world.setBlock(this.x, this.y, this.z, withProp(state, 'lit', lit),
          FLAG.MARK_DIRTY | FLAG.UPDATE_LIGHT);
      }
    }
  }

  finishCook(result) {
    const input = this.slots[0];
    input.count--;
    if (input.count <= 0) this.slots[0] = null;
    if (this.slots[2]) this.slots[2].count += result.count;
    else this.slots[2] = new ItemStack(result.item, result.count);
    this.storedXp += result.xp ?? 0.1;
  }

  /** Hand the accumulated experience to a player and reset the counter. */
  takeExperience(world, player) {
    const xp = Math.floor(this.storedXp);
    this.storedXp -= xp;
    if (xp > 0) world.game?.drops?.spawnExperience?.(world, this.x, this.y, this.z, xp);
    return xp;
  }

  save() {
    return Object.assign(super.save(), {
      burnTime: this.burnTime, burnDuration: this.burnDuration,
      cookTime: this.cookTime, xp: this.storedXp,
    });
  }

  load(data) {
    super.load(data);
    this.burnTime = data?.burnTime ?? 0;
    this.burnDuration = data?.burnDuration ?? 0;
    this.cookTime = data?.cookTime ?? 0;
    this.storedXp = data?.xp ?? 0;
    return this;
  }
}

// ---------------------------------------------------------------------------
// Hoppers
// ---------------------------------------------------------------------------

/**
 * Hoppers pull one item a tick from whatever sits above them and push one into
 * whatever they point at, with an eight-tick cooldown between transfers and a
 * hard stop while they are powered.
 */
export class HopperBlockEntity extends ContainerBlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def, 5);
    this.cooldown = 0;
    this.needsTick = true;
  }

  tick(world) {
    const state = this.blockState(world);
    if (blockOf(state) !== this.def) return;
    if (getProp(state, 'enabled') === false) return;   // powered: locked
    if (this.cooldown > 0) { this.cooldown--; return; }

    let moved = false;
    if (this.pushOut(world, state)) moved = true;
    if (this.pullIn(world)) moved = true;
    if (moved) { this.cooldown = 8; this.setChanged(world); }
  }

  /** Move one item into whatever the hopper faces. */
  pushOut(world, state) {
    const face = FACING_FACE[getProp(state, 'facing')];
    const d = FACES[face];
    const target = world.getBlockEntity(this.x + d.dx, this.y + d.dy, this.z + d.dz);
    if (!target || !Array.isArray(target.slots)) return false;
    if (target === this) return false;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s || s.count <= 0) continue;
      const one = s.split(1);
      // Hoppers feed a furnace's fuel slot rather than its input from the side.
      const left = target instanceof FurnaceBlockEntity
        ? this.insertIntoFurnace(target, one, face)
        : target.addItem(one);
      if (left && left.count > 0) { s.count += left.count; continue; }
      if (s.count <= 0) this.slots[i] = null;
      return true;
    }
    return false;
  }

  insertIntoFurnace(furnace, stack, face) {
    if (face === 2) return furnace.addItem(stack, 0, 1);          // from above
    if (face === 3) return furnace.addItem(stack, 2, 3);          // from below
    return furnace.addItem(stack, 1, 2);                          // from a side
  }

  /** Take one item from the container above, or swallow a dropped item. */
  pullIn(world) {
    const above = world.getBlockEntity(this.x, this.y + 1, this.z);
    if (above && Array.isArray(above.slots)) {
      const from = above instanceof FurnaceBlockEntity ? 2 : 0;
      const to = above instanceof FurnaceBlockEntity ? 3 : above.slots.length;
      for (let i = from; i < to; i++) {
        const s = above.slots[i];
        if (!s || s.count <= 0) continue;
        const one = s.split(1);
        const left = this.addItem(one);
        if (left && left.count > 0) { s.count += left.count; continue; }
        if (s.count <= 0) above.slots[i] = null;
        return true;
      }
    }
    // Loose items resting on top get sucked in whole.
    const box = new AABB(this.x, this.y + 1, this.z, this.x + 1, this.y + 2, this.z + 1);
    for (const e of world.entitiesInBox(box)) {
      if (!e.stack || e.removed || e.pickupDelay > 0) continue;
      const left = this.addItem(e.stack);
      if (!left || left.count <= 0) { world.removeEntity(e); return true; }
    }
    return false;
  }

  save() { return Object.assign(super.save(), { cooldown: this.cooldown }); }
  load(data) { super.load(data); this.cooldown = data?.cooldown ?? 0; return this; }
}

// ---------------------------------------------------------------------------
// Dispensers and droppers
// ---------------------------------------------------------------------------

export class DispenserBlockEntity extends ContainerBlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def, 9);
    this.isDropper = (def?.name || type) === 'dropper';
  }

  /** Pick a random occupied slot and throw one item out of the front face. */
  dispense(world) {
    const state = this.blockState(world);
    if (blockOf(state) !== this.def) return false;
    const candidates = [];
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i] && this.slots[i].count > 0) candidates.push(i);
    }
    if (candidates.length === 0) {
      world.playSound('dispenser.fail', this.x + 0.5, this.y + 0.5, this.z + 0.5);
      return false;
    }
    const slot = candidates[world.random.int(candidates.length)];
    const stack = this.slots[slot];
    const one = stack.split(1);
    if (stack.count <= 0) this.slots[slot] = null;

    const d = FACES[FACING_FACE[getProp(state, 'facing')]];
    const tx = this.x + d.dx, ty = this.y + d.dy, tz = this.z + d.dz;

    // A dropper always just drops; a dispenser prefers to *use* the item.
    if (!this.isDropper && world.game?.dispense?.(world, tx, ty, tz, one, d, this)) {
      this.setChanged(world);
      return true;
    }
    // Feed a container in front instead of littering the floor.
    const target = world.getBlockEntity(tx, ty, tz);
    if (target && Array.isArray(target.slots)) {
      const left = target.addItem(one);
      if (!left || left.count <= 0) { this.setChanged(world); return true; }
    }
    const e = world.game?.drops?.spawnStack?.(world, tx, ty, tz, one);
    if (e) {
      e.vx = d.dx * 0.25 + (world.random.next() - 0.5) * 0.02;
      e.vy = d.dy * 0.25 + 0.1;
      e.vz = d.dz * 0.25 + (world.random.next() - 0.5) * 0.02;
    }
    world.playSound(this.isDropper ? 'dispenser.dispense' : 'dispenser.launch',
      this.x + 0.5, this.y + 0.5, this.z + 0.5);
    world.spawnParticles('smoke', tx + 0.5, ty + 0.5, tz + 0.5, 6);
    this.setChanged(world);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Brewing
// ---------------------------------------------------------------------------

const BREW_TIME = 400;

export class BrewingStandBlockEntity extends ContainerBlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def, 5);   // 0..2 bottles, 3 ingredient, 4 fuel
    this.brewTime = 0;
    this.fuel = 0;
    this.needsTick = true;
  }

  tick(world) {
    if (this.fuel <= 0 && this.slots[4]?.item.name === 'blaze_powder') {
      this.fuel = 20;
      this.removeItem(4, 1);
    }
    const ingredient = this.slots[3];
    const hasBottles = this.slots.slice(0, 3).some((s) => s && s.count > 0);
    if (ingredient && hasBottles && this.fuel > 0) {
      if (this.brewTime === 0) { this.brewTime = BREW_TIME; this.fuel--; }
      else if (--this.brewTime === 0) this.finishBrew(world);
    } else if (this.brewTime !== 0) {
      this.brewTime = 0;
    }
    this.syncBottles(world);
  }

  finishBrew(world) {
    const ingredient = this.slots[3];
    if (!ingredient) return;
    for (let i = 0; i < 3; i++) {
      const bottle = this.slots[i];
      if (!bottle || bottle.count <= 0) continue;
      const result = RECIPES?.brewingFor?.(bottle, ingredient);
      if (result && itemsByName.has(result.item)) {
        this.slots[i] = new ItemStack(result.item, 1, 0, result.tag ?? null);
      } else if (bottle.item.name === 'potion') {
        // Without a recipe table, record the ingredient on the potion's tag.
        bottle.tag = Object.assign({}, bottle.tag, { brewedWith: ingredient.item.name });
      }
    }
    ingredient.count--;
    if (ingredient.count <= 0) this.slots[3] = null;
    world.playSound('brewing_stand.brew', this.x + 0.5, this.y + 0.5, this.z + 0.5);
    this.setChanged(world);
  }

  /** The model shows which of the three arms is holding a bottle. */
  syncBottles(world) {
    const state = this.blockState(world);
    if (blockOf(state) !== this.def) return;
    let next = state;
    for (let i = 0; i < 3; i++) {
      next = withProp(next, `has_bottle_${i}`, !!(this.slots[i] && this.slots[i].count > 0));
    }
    if (next !== state) world.setBlock(this.x, this.y, this.z, next, FLAG.MARK_DIRTY);
  }

  comparatorOutput() {
    let n = 0;
    for (let i = 0; i < 3; i++) if (this.slots[i]) n++;
    return n * 5;
  }

  save() { return Object.assign(super.save(), { brewTime: this.brewTime, fuel: this.fuel }); }
  load(data) {
    super.load(data);
    this.brewTime = data?.brewTime ?? 0;
    this.fuel = data?.fuel ?? 0;
    return this;
  }
}

// ---------------------------------------------------------------------------
// Signs, lecterns, jukeboxes and note blocks
// ---------------------------------------------------------------------------

export class SignBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def);
    this.lines = ['', '', '', ''];
    this.backLines = ['', '', '', ''];
    this.color = 'black';
    this.glowing = false;
    this.editable = true;
  }
  setLine(i, text) { this.lines[i] = String(text ?? '').slice(0, 24); this.dirty = true; }
  save() {
    return Object.assign(super.save(), {
      lines: this.lines.slice(), backLines: this.backLines.slice(),
      color: this.color, glowing: this.glowing,
    });
  }
  load(data) {
    super.load(data);
    if (data?.lines) this.lines = data.lines.slice(0, 4);
    if (data?.backLines) this.backLines = data.backLines.slice(0, 4);
    this.color = data?.color ?? 'black';
    this.glowing = !!data?.glowing;
    return this;
  }
}

export class LecternBlockEntity extends ContainerBlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def, 1);
    this.page = 0;
    this.pages = [];
  }
  get book() { return this.slots[0]; }
  setPage(world, page) {
    this.page = Math.max(0, Math.min(Math.max(0, this.pages.length - 1), page));
    world.game?.redstone?.update?.(world, this.x, this.y, this.z);
  }
  comparatorOutput() {
    if (!this.slots[0] || this.pages.length === 0) return 0;
    return Math.floor((this.page / Math.max(1, this.pages.length - 1)) * 14) + 1;
  }
  save() { return Object.assign(super.save(), { page: this.page, pages: this.pages }); }
  load(data) {
    super.load(data);
    this.page = data?.page ?? 0;
    this.pages = data?.pages ?? [];
    return this;
  }
}

export class JukeboxBlockEntity extends ContainerBlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def, 1);
    this.playing = false;
    this.startedAt = 0;
  }
  get record() { return this.slots[0]; }
  comparatorOutput() {
    const r = this.slots[0];
    if (!r) return 0;
    // Records report their position in the disc list, as in the real game.
    return Math.max(1, Math.min(15, (r.item.discNumber ?? 1)));
  }
  save() { return Object.assign(super.save(), { playing: this.playing }); }
  load(data) { super.load(data); this.playing = !!data?.playing; return this; }
}

/** Put a record in, or knock the current one out. */
export function useJukebox(world, x, y, z, state, player, hand) {
  const be = world.getBlockEntity(x, y, z);
  if (!be) return false;
  const stack = hand?.item ? hand : (player?.heldItem?.() ?? null);

  if (be.slots[0]) {
    const disc = be.slots[0];
    be.slots[0] = null;
    be.playing = false;
    world.setBlock(x, y, z, withProp(state, 'has_record', false), FLAG.DEFAULT);
    world.game?.drops?.spawnStack?.(world, x, y + 1, z, disc);
    world.playSound('jukebox.stop', x + 0.5, y + 0.5, z + 0.5);
    return true;
  }
  if (!stack || stack.count <= 0) return false;
  if (!stack.item.tags?.has?.('music_disc') && !stack.item.name.startsWith('music_disc')) {
    return false;
  }
  be.slots[0] = stack.split(1);
  be.playing = true;
  be.startedAt = world.tickCount;
  world.setBlock(x, y, z, withProp(state, 'has_record', true), FLAG.DEFAULT);
  world.playSound(`record.${be.slots[0].item.name}`, x + 0.5, y + 0.5, z + 0.5, 4, 1);
  return true;
}

/** Note blocks have no block entity in the registry; this backs the API. */
export class NoteBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def);
    this.note = getProp(state, 'note') ?? 0;
    this.instrument = getProp(state, 'instrument') ?? 'harp';
  }
  play(world) {
    world.game?.audio?.playNote?.(world, this.x, this.y, this.z,
      this.instrument, this.note);
  }
}

// ---------------------------------------------------------------------------
// Beacons, spawners, enchanting tables and conduits
// ---------------------------------------------------------------------------

const BEACON_BASE = new Set([
  'iron_block', 'gold_block', 'emerald_block', 'diamond_block', 'netherite_block',
]);

export class BeaconBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def);
    this.levels = 0;
    this.primary = null;
    this.secondary = null;
    this.needsTick = true;
    this.beamHeight = 0;
  }

  tick(world) {
    if (world.tickCount % 80 !== 0) return;
    this.levels = this.pyramidLevels(world);
    this.beamHeight = this.levels > 0 ? this.clearSky(world) : 0;
    if (this.levels > 0 && this.primary) this.applyEffects(world);
  }

  /** Count the complete pyramid layers underneath, up to four. */
  pyramidLevels(world) {
    for (let level = 1; level <= 4; level++) {
      const y = this.y - level;
      for (let dz = -level; dz <= level; dz++) {
        for (let dx = -level; dx <= level; dx++) {
          const name = world.getBlockName(this.x + dx, y, this.z + dz);
          if (!BEACON_BASE.has(name)) return level - 1;
        }
      }
    }
    return 4;
  }

  /** How far the beam reaches before something opaque stops it. */
  clearSky(world) {
    let h = 0;
    for (let y = this.y + 1; y < this.y + 160; y++) {
      if (T.opaque[world.getBlock(this.x, y, this.z)] === 1) break;
      h++;
    }
    return h;
  }

  applyEffects(world) {
    const range = this.levels * 10 + 10;
    const duration = 180 + this.levels * 40;
    for (const p of world.players) {
      const dx = p.x - this.x, dy = p.y - this.y, dz = p.z - this.z;
      if (dx * dx + dy * dy + dz * dz > range * range) continue;
      world.game?.effects?.apply?.(p, this.primary, duration, 0);
      if (this.levels >= 4 && this.secondary) {
        world.game?.effects?.apply?.(p, this.secondary, duration, 0);
      }
    }
  }

  save() {
    return Object.assign(super.save(), {
      levels: this.levels, primary: this.primary, secondary: this.secondary,
    });
  }
  load(data) {
    super.load(data);
    this.levels = data?.levels ?? 0;
    this.primary = data?.primary ?? null;
    this.secondary = data?.secondary ?? null;
    return this;
  }
}

export class SpawnerBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def);
    this.entityId = 'pig';
    this.spawnDelay = 20;
    this.minDelay = 200;
    this.maxDelay = 800;
    this.spawnCount = 4;
    this.maxNearby = 6;
    this.requiredPlayerRange = 16;
    this.spawnRange = 4;
    /** Rotation of the little model inside, for the renderer. */
    this.rotation = 0;
    this.prevRotation = 0;
    this.needsTick = true;
  }

  playerNearby(world) {
    return !!world.nearestPlayer(this.x + 0.5, this.y + 0.5, this.z + 0.5,
      this.requiredPlayerRange);
  }

  tick(world) {
    if (!this.playerNearby(world)) return;
    this.prevRotation = this.rotation;
    this.rotation = (this.rotation + 0.06) % (Math.PI * 2);
    if (this.spawnDelay > 0) { this.spawnDelay--; return; }
    this.spawn(world);
    this.spawnDelay = this.minDelay +
      world.random.int(Math.max(1, this.maxDelay - this.minDelay));
  }

  spawn(world) {
    const spawner = world.game?.modules?.mobs?.spawnAt;
    let spawned = 0;
    for (let i = 0; i < this.spawnCount; i++) {
      const x = this.x + 0.5 + (world.random.next() - world.random.next()) * this.spawnRange;
      const y = this.y + world.random.int(3) - 1;
      const z = this.z + 0.5 + (world.random.next() - world.random.next()) * this.spawnRange;
      if (T.solid[world.getBlock(Math.floor(x), y, Math.floor(z))] === 1) continue;
      if (spawner && spawner(world, this.entityId, x, y, z)) spawned++;
      world.spawnParticles('flame', x, y + 0.5, z, 2);
    }
    if (spawned > 0) world.playSound('spawner.spawn', this.x + 0.5, this.y + 0.5, this.z + 0.5);
  }

  save() {
    return Object.assign(super.save(), {
      entityId: this.entityId, spawnDelay: this.spawnDelay,
    });
  }
  load(data) {
    super.load(data);
    this.entityId = data?.entityId ?? 'pig';
    this.spawnDelay = data?.spawnDelay ?? 20;
    return this;
  }
}

export class EnchantingTableBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def);
    this.bookshelves = 0;
    this.pageAngle = 0;
    this.prevPageAngle = 0;
    this.open = 0;
    this.needsTick = true;
  }

  tick(world) {
    if (world.tickCount % 20 === 0) this.bookshelves = this.countBookshelves(world);
    this.prevPageAngle = this.pageAngle;
    const player = world.nearestPlayer(this.x + 0.5, this.y + 0.5, this.z + 0.5, 4);
    this.open += ((player ? 1 : 0) - this.open) * 0.2;
    this.pageAngle += 0.02 + this.open * 0.06;
  }

  /**
   * Bookshelves count when they sit two blocks out, at the same height or one
   * above, with clear air between them and the table.
   */
  countBookshelves(world) {
    let n = 0;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;
        for (const dy of [0, 1]) {
          if (world.getBlockName(this.x + dx, this.y + dy, this.z + dz) !== 'bookshelf') continue;
          // The line of sight has to be clear.
          const mx = this.x + Math.sign(dx), mz = this.z + Math.sign(dz);
          if (world.getBlock(mx, this.y + dy, mz) !== 0) continue;
          n++;
        }
      }
    }
    return Math.min(15, n);
  }

  save() { return Object.assign(super.save(), { bookshelves: this.bookshelves }); }
}

export class ConduitBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def);
    this.active = false;
    this.frames = 0;
    this.rotation = 0;
    this.needsTick = true;
  }

  tick(world) {
    this.rotation += 0.06;
    if (world.tickCount % 40 !== 0) return;
    this.frames = this.countFrame(world);
    this.active = this.frames >= 16 && this.inWater(world);
    if (!this.active) return;
    const range = Math.min(16, Math.floor(this.frames / 7) * 16);
    for (const p of world.players) {
      const dx = p.x - this.x, dy = p.y - this.y, dz = p.z - this.z;
      if (dx * dx + dy * dy + dz * dz > range * range) continue;
      world.game?.effects?.apply?.(p, 'conduit_power', 260, 0);
    }
  }

  inWater(world) { return T.fluid[world.getBlock(this.x, this.y, this.z)] === 1 ||
    T.waterlogged[world.getBlock(this.x, this.y, this.z)] === 1; }

  /** Prismarine and sea lanterns arranged in the frame around the conduit. */
  countFrame(world) {
    let n = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (Math.abs(dx) !== 2 && Math.abs(dy) !== 2 && Math.abs(dz) !== 2) continue;
          const name = world.getBlockName(this.x + dx, this.y + dy, this.z + dz);
          if (name === 'prismarine' || name === 'prismarine_bricks' ||
            name === 'dark_prismarine' || name === 'sea_lantern') n++;
        }
      }
    }
    return n;
  }
}

// ---------------------------------------------------------------------------
// Campfires, composters, cauldrons, beds, banners, comparators, pistons
// ---------------------------------------------------------------------------

export class CampfireBlockEntity extends ContainerBlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def, 4);
    this.cookTime = [0, 0, 0, 0];
    this.cookTotal = [600, 600, 600, 600];
    this.needsTick = true;
  }

  tick(world) {
    const state = this.blockState(world);
    if (!getProp(state, 'lit')) {
      for (let i = 0; i < 4; i++) this.cookTime[i] = Math.max(0, this.cookTime[i] - 2);
      return;
    }
    for (let i = 0; i < 4; i++) {
      const s = this.slots[i];
      if (!s || s.count <= 0) continue;
      if (++this.cookTime[i] < this.cookTotal[i]) continue;
      this.cookTime[i] = 0;
      const result = smeltingResult('smoker', s);
      this.slots[i] = null;
      if (result) {
        world.game?.drops?.spawnItem?.(world, this.x, this.y + 1, this.z, result.item, 1);
      }
      this.setChanged(world);
    }
    if (world.tickCount % 20 === 0) {
      world.spawnParticles('campfire_smoke', this.x + 0.5, this.y + 1, this.z + 0.5, 1);
    }
  }

  /** Put one food item on a free corner of the fire. */
  place(world, stack) {
    for (let i = 0; i < 4; i++) {
      if (this.slots[i]) continue;
      if (!smeltingResult('smoker', stack)) return false;
      this.slots[i] = stack.split(1);
      this.cookTime[i] = 0;
      this.setChanged(world);
      world.playSound('campfire.place', this.x + 0.5, this.y + 0.5, this.z + 0.5);
      return true;
    }
    return false;
  }

  save() { return Object.assign(super.save(), { cookTime: this.cookTime.slice() }); }
  load(data) {
    super.load(data);
    if (Array.isArray(data?.cookTime)) this.cookTime = data.cookTime.slice(0, 4);
    return this;
  }
}

/** Right-clicking a campfire with food puts it on to cook. */
export function useCampfire(world, x, y, z, state, player, hand) {
  const be = world.getBlockEntity(x, y, z);
  if (!be || !getProp(state, 'lit')) return false;
  const stack = hand?.item ? hand : (player?.heldItem?.() ?? null);
  if (!stack || stack.count <= 0) return false;
  return be.place(world, stack);
}

export class ComposterBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def);
    this.level = getProp(state, 'level') ?? 0;
  }
  comparatorOutput() { return this.level; }
}

export class CauldronBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def);
    this.contents = def?.cauldronContents ?? null;
    this.level = def?.stateDef?.has('level') ? (getProp(state, 'level') ?? 0) : 0;
  }
  comparatorOutput() { return this.contents ? Math.max(1, this.level) : 0; }
}

export class BedBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def);
    this.color = def?.color ?? 'red';
  }
  save() { return Object.assign(super.save(), { color: this.color }); }
  load(data) { super.load(data); this.color = data?.color ?? this.color; return this; }
}

export class BannerBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def);
    this.color = def?.color ?? 'white';
    this.patterns = [];
  }
  save() { return Object.assign(super.save(), { color: this.color, patterns: this.patterns }); }
  load(data) {
    super.load(data);
    this.color = data?.color ?? this.color;
    this.patterns = data?.patterns ?? [];
    return this;
  }
}

export class BellBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def);
    this.ringTicks = 0;
    this.ringFace = 0;
    this.needsTick = true;
  }
  tick() { if (this.ringTicks > 0) this.ringTicks--; }
}

/** A comparator remembers the level it is putting out between ticks. */
export class ComparatorBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def);
    this.output = 0;
  }
  save() { return Object.assign(super.save(), { output: this.output }); }
  load(data) { super.load(data); this.output = data?.output ?? 0; return this; }
}

/**
 * The placeholder a block sits inside while a piston carries it.
 * pistons.js fills these fields in and resolves the block when the move ends;
 * everything here exists so the renderer can interpolate the travel.
 */
export class MovingPistonBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def);
    this.sourceState = 0;
    this.direction = 3;
    this.extending = true;
    this.isHead = false;
    this.progress = 0;
    this.lastProgress = 0;
    this.totalTicks = 2;
  }
  /** Offset in blocks, for the renderer, at a sub-tick position. */
  offsetAt(alpha) {
    const p = this.lastProgress + (this.progress - this.lastProgress) * alpha;
    const d = FACES[this.direction];
    const t = this.extending ? p - 1 : 1 - p;
    return { x: d.dx * t, y: d.dy * t, z: d.dz * t };
  }
}

export class ChiseledBookshelfBlockEntity extends ContainerBlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def, 6);
    this.lastUsedSlot = -1;
  }
  comparatorOutput() { return this.lastUsedSlot + 1; }
}

export class EndPortalBlockEntity extends BlockEntity {}
export class EndGatewayBlockEntity extends BlockEntity {
  constructor(type, x, y, z, state, def) {
    super(type, x, y, z, state, def);
    this.age = 0;
    this.needsTick = true;
  }
  tick() { this.age++; }
}

export class DaylightDetectorBlockEntity extends BlockEntity {}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const TYPES = {
  chest: ChestBlockEntity,
  trapped_chest: ChestBlockEntity,
  ender_chest: EnderChestBlockEntity,
  barrel: BarrelBlockEntity,
  shulker_box: ShulkerBoxBlockEntity,
  furnace: FurnaceBlockEntity,
  hopper: HopperBlockEntity,
  dispenser: DispenserBlockEntity,
  dropper: DispenserBlockEntity,
  brewing_stand: BrewingStandBlockEntity,
  sign: SignBlockEntity,
  lectern: LecternBlockEntity,
  jukebox: JukeboxBlockEntity,
  note_block: NoteBlockEntity,
  beacon: BeaconBlockEntity,
  spawner: SpawnerBlockEntity,
  enchanting_table: EnchantingTableBlockEntity,
  conduit: ConduitBlockEntity,
  campfire: CampfireBlockEntity,
  composter: ComposterBlockEntity,
  cauldron: CauldronBlockEntity,
  bed: BedBlockEntity,
  banner: BannerBlockEntity,
  bell: BellBlockEntity,
  comparator: ComparatorBlockEntity,
  piston: MovingPistonBlockEntity,
  chiseled_bookshelf: ChiseledBookshelfBlockEntity,
  end_portal: EndPortalBlockEntity,
  end_gateway: EndGatewayBlockEntity,
  daylight_detector: DaylightDetectorBlockEntity,
};

/** Every block-entity class, by type name — useful for save/load dispatch. */
export const BLOCK_ENTITY_TYPES = TYPES;

/**
 * Build the block entity for a block that declares `hasEntity`.
 * Called by `World.setBlock` through `game.createBlockEntity`.
 */
export function createBlockEntity(def, x, y, z, state) {
  if (!def) return null;
  const type = def.blockEntity || def.container?.type || def.name;
  let Cls = TYPES[type];
  if (!Cls) Cls = def.container ? ContainerBlockEntity : BlockEntity;
  const be = new Cls(type, x, y, z, state, def);
  // A block entity declared as a container must expose slots even when it fell
  // through to a class that does not size itself from the registry.
  if (def.container && !Array.isArray(be.slots)) {
    be.slots = new Array(def.container.slots).fill(null);
  }
  return be;
}

/**
 * Tick every block entity in every loaded chunk. Called once per game tick.
 * @returns how many were ticked, for the debug overlay.
 */
export function tickBlockEntities(world) {
  let n = 0;
  for (const chunk of world.chunks.values()) {
    if (chunk.blockEntities.size === 0) continue;
    for (const be of chunk.blockEntities.values()) {
      if (be.removed || !be.needsTick) continue;
      try { be.tick(world); n++; } catch (e) {
        console.error(`block entity ${be.type} failed at ${be.x},${be.y},${be.z}`, e);
        be.needsTick = false;
      }
    }
  }
  return n;
}

/** Restore a block entity from `save()` output. */
export function loadBlockEntity(world, data) {
  if (!data) return null;
  const state = world.getBlock(data.x, data.y, data.z);
  const def = blockOf(state);
  const be = createBlockEntity(def, data.x, data.y, data.z, state);
  if (!be) return null;
  be.load(data);
  world.setBlockEntity(data.x, data.y, data.z, be);
  return be;
}

/** Drop the contents of any container at a position — used when it breaks. */
export function dropContentsAt(world, x, y, z) {
  const be = world.getBlockEntity(x, y, z);
  if (be && typeof be.dropContents === 'function') be.dropContents(world);
}
