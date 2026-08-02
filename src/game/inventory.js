// Inventories, containers and the slot-click protocol.
//
// Everything in this file is plain data and logic — no DOM, no canvas, no
// imports beyond the item registry — so the rules that decide where an item
// ends up can be unit-tested in node (scripts/check-ui.mjs) and shared by every
// screen in src/game/ui/.
//
// Layout follows Minecraft exactly: slots 0..8 are the hotbar, 9..35 the three
// main rows, plus four armour slots and one offhand slot on the side. Screens
// bind `Slot` objects to positions in a `ContainerMenu`, which owns the cursor
// stack and implements the click protocol (pick up, place one, split, quick
// move, hotbar swap, creative clone and drag-distribute).

import { ItemStack, itemsByName } from './items.js';

export const HOTBAR_SIZE = 9;
export const MAIN_ROWS = 3;
export const MAIN_SIZE = MAIN_ROWS * HOTBAR_SIZE;         // 27
export const INVENTORY_SIZE = HOTBAR_SIZE + MAIN_SIZE;    // 36
export const ARMOR_SIZE = 4;

/** Armour slot order, matching `Item.armorSlot`. */
export const ARMOR = { HEAD: 0, CHEST: 1, LEGS: 2, FEET: 3 };
export const ARMOR_NAMES = ['head', 'chest', 'legs', 'feet'];

/** Mouse buttons as the click protocol names them. */
export const CLICK = { LEFT: 0, RIGHT: 1, MIDDLE: 2 };

const empty = (s) => !s || s.count <= 0;
const orNull = (s) => (empty(s) ? null : s);

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

/**
 * A flat array of item slots. Chests, furnaces, crafting grids and the player's
 * own inventory are all containers; screens never care which.
 */
export class Container {
  constructor(size = 27, opts = {}) {
    this.slots = new Array(Math.max(0, size | 0)).fill(null);
    this.title = opts.title ?? 'Container';
    this.type = opts.type ?? 'generic';
    this.maxStack = opts.maxStack ?? 64;
    /** Optional per-slot filter: (index, stack) => boolean. */
    this.filter = opts.filter ?? null;
    this.listeners = [];
    this.dirty = 0;
  }

  get size() { return this.slots.length; }

  getStack(i) { return orNull(this.slots[i]); }

  setStack(i, stack) {
    if (i < 0 || i >= this.slots.length) return this;
    this.slots[i] = orNull(stack);
    this.changed();
    return this;
  }

  /** Register a change callback; returns an unsubscribe function. */
  onChange(fn) {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  changed() {
    this.dirty++;
    for (const fn of this.listeners) fn(this);
    return this;
  }

  /** May `stack` be placed in slot `i`? Overridden by furnaces, armour, … */
  mayPlace(i, stack) {
    if (!stack) return false;
    return this.filter ? !!this.filter(i, stack) : true;
  }

  mayPickup(_i) { return true; }

  /** Per-slot stack ceiling — hoppers and armour slots hold less than 64. */
  slotLimit(_i) { return this.maxStack; }

  isEmpty() { return this.slots.every(empty); }

  /** Total number of items of `name` held. */
  count(name) {
    let n = 0;
    for (const s of this.slots) if (!empty(s) && s.item.name === name) n += s.count;
    return n;
  }

  has(name, n = 1) { return this.count(name) >= n; }

  /** First slot index holding `name`, or -1. */
  indexOf(name) {
    for (let i = 0; i < this.slots.length; i++) {
      if (!empty(this.slots[i]) && this.slots[i].item.name === name) return i;
    }
    return -1;
  }

  firstEmpty(from = 0, to = this.size) {
    for (let i = from; i < to; i++) if (empty(this.slots[i])) return i;
    return -1;
  }

  /**
   * Move as much of `stack` into this container as fits, merging into partial
   * stacks first and then filling empty slots. Mutates `stack.count`.
   * @returns {number} how many items were moved
   */
  insert(stack, opts = {}) {
    if (empty(stack)) return 0;
    const from = Math.max(0, opts.from ?? 0);
    const to = Math.min(opts.to ?? this.size, this.size);
    if (to <= from) return 0;
    const order = [];
    for (let i = from; i < to; i++) order.push(opts.reverse ? from + to - 1 - i : i);

    let moved = 0;
    if (stack.maxStack > 1) {
      for (const i of order) {
        if (stack.count <= 0) break;
        const s = this.slots[i];
        if (empty(s) || !s.matches(stack)) continue;
        const room = Math.min(this.slotLimit(i), s.maxStack) - s.count;
        if (room <= 0) continue;
        const n = Math.min(room, stack.count);
        s.count += n;
        stack.count -= n;
        moved += n;
      }
    }
    for (const i of order) {
      if (stack.count <= 0) break;
      if (!empty(this.slots[i])) continue;
      if (!this.mayPlace(i, stack)) continue;
      const n = Math.min(Math.min(this.slotLimit(i), stack.maxStack), stack.count);
      if (n <= 0) continue;
      this.slots[i] = stack.split(n);
      moved += n;
    }
    if (moved > 0) this.changed();
    return moved;
  }

  /**
   * Add a stack. Returns true when the whole stack fitted; whatever is left is
   * still in `stack`, which the caller normally drops on the floor.
   */
  addItem(stack, opts = {}) {
    if (empty(stack)) return true;
    this.insert(stack, opts);
    return stack.count <= 0;
  }

  /** Would `stack` fit entirely? Does not modify anything. */
  canFit(stack) {
    if (empty(stack)) return true;
    let room = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (empty(s)) {
        if (this.mayPlace(i, stack)) room += Math.min(this.slotLimit(i), stack.maxStack);
      } else if (s.matches(stack)) {
        room += Math.max(0, Math.min(this.slotLimit(i), s.maxStack) - s.count);
      }
      if (room >= stack.count) return true;
    }
    return false;
  }

  /** Take up to `n` items out of slot `i`. */
  take(i, n = Infinity) {
    const s = this.slots[i];
    if (empty(s)) return null;
    const out = s.split(Math.min(n, s.count));
    if (s.count <= 0) this.slots[i] = null;
    this.changed();
    return out;
  }

  /** Remove `n` items named `name` from anywhere; returns how many went. */
  remove(name, n = 1) {
    let removed = 0;
    for (let i = 0; i < this.slots.length && removed < n; i++) {
      const s = this.slots[i];
      if (empty(s) || s.item.name !== name) continue;
      const take = Math.min(s.count, n - removed);
      s.count -= take;
      removed += take;
      if (s.count <= 0) this.slots[i] = null;
    }
    if (removed > 0) this.changed();
    return removed;
  }

  clear() {
    this.slots.fill(null);
    this.changed();
    return this;
  }

  /** Empty the container out, returning everything it held. */
  drain() {
    const out = [];
    for (let i = 0; i < this.slots.length; i++) {
      if (!empty(this.slots[i])) out.push(this.slots[i]);
      this.slots[i] = null;
    }
    this.changed();
    return out;
  }

  /** Swap two slots. */
  swap(a, b) {
    const t = this.slots[a];
    this.slots[a] = this.slots[b] ?? null;
    this.slots[b] = t ?? null;
    this.changed();
    return this;
  }

  /**
   * Shift-click one slot of this container into another container.
   * @returns {boolean} true when at least one item moved
   */
  transferTo(index, dest, opts = {}) {
    const stack = this.getStack(index);
    if (!stack || !dest) return false;
    const moved = dest.insert(stack, opts);
    if (moved <= 0) return false;
    if (stack.count <= 0) this.slots[index] = null;
    this.changed();
    return true;
  }

  save() { return { slots: this.slots.map(stackToJSON) }; }

  load(data) {
    this.slots.fill(null);
    const src = Array.isArray(data) ? data : (data?.slots ?? []);
    for (let i = 0; i < Math.min(src.length, this.slots.length); i++) {
      this.slots[i] = stackFromJSON(src[i]);
    }
    this.changed();
    return this;
  }
}

export function stackToJSON(stack) { return empty(stack) ? null : stack.toJSON(); }

export function stackFromJSON(data) {
  if (!data || !data.id || !itemsByName.has(data.id)) return null;
  const s = ItemStack.fromJSON(data);
  return orNull(s);
}

/** Shift-click semantics between two arbitrary containers. */
export function transferStack(src, index, dst, opts = {}) {
  return src.transferTo(index, dst, opts);
}

// ---------------------------------------------------------------------------
// Armour and offhand
// ---------------------------------------------------------------------------

/** Four slots that only accept the matching armour piece. */
class ArmorContainer extends Container {
  constructor() { super(ARMOR_SIZE, { title: 'Armor', type: 'armor', maxStack: 1 }); }
  mayPlace(i, stack) {
    if (empty(stack)) return false;
    const slot = stack.item.armorSlot;
    if (slot === i) return true;
    // Carved pumpkins and mob heads go on your head, as in the real game.
    return i === ARMOR.HEAD && stack.item.tags?.has?.('wearable_head');
  }
  slotLimit() { return 1; }
}

// ---------------------------------------------------------------------------
// PlayerInventory
// ---------------------------------------------------------------------------

export class PlayerInventory extends Container {
  constructor(player = null) {
    super(INVENTORY_SIZE, { title: 'Inventory', type: 'player' });
    this.player = player;
    this.armor = new ArmorContainer();
    this.offhandSlot = new Container(1, { title: 'Offhand', type: 'offhand' });
    this.enderChest = new Container(27, { title: 'Ender Chest', type: 'ender_chest' });
    this.selected = 0;
  }

  /** The raw armour array, so `inv.armorSlots[i] = stack` keeps working. */
  get armorSlots() { return this.armor.slots; }

  get offhand() { return orNull(this.offhandSlot.slots[0]); }
  set offhand(stack) { this.offhandSlot.slots[0] = orNull(stack); }

  get hotbar() { return this.slots.slice(0, HOTBAR_SIZE); }

  // -- Selection -----------------------------------------------------------

  getSelected() { return this.getStack(this.selected); }

  setSelected(stack) {
    this.slots[this.selected] = orNull(stack);
    this.changed();
    return this;
  }

  /** Move the hotbar cursor; keeps `player.selectedSlot` in step. */
  setSelectedSlot(i) {
    this.selected = ((i % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    if (this.player) this.player.selectedSlot = this.selected;
    return this.selected;
  }

  scroll(dir) { return this.setSelectedSlot(this.selected + dir); }

  getOffhand() { return this.offhand; }
  setOffhand(stack) { this.offhand = stack; this.offhandSlot.changed(); return this; }

  swapHands() {
    const held = this.getSelected();
    this.setSelected(this.offhand);
    this.offhand = held;
    return this;
  }

  getArmor(i) { return this.armor.getStack(i); }
  setArmor(i, stack) { this.armor.setStack(i, stack); return this; }

  /**
   * Select a hotbar slot already holding `itemName`; if it is in the main
   * inventory instead, swap it down into the hotbar first (pick-block).
   */
  selectExisting(itemName) {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      if (this.slots[i]?.item.name === itemName) { this.setSelectedSlot(i); return true; }
    }
    for (let i = HOTBAR_SIZE; i < this.size; i++) {
      if (this.slots[i]?.item.name !== itemName) continue;
      const target = this.firstEmpty(0, HOTBAR_SIZE);
      const dest = target >= 0 ? target : this.selected;
      this.swap(i, dest);
      this.setSelectedSlot(dest);
      return true;
    }
    return false;
  }

  // -- Adding --------------------------------------------------------------

  /**
   * Pick an item up. Tops up the held slot first (as the real game does), then
   * the rest of the hotbar and main rows.
   * @param {ItemStack} stack mutated in place; leftovers stay in it
   * @param {{equipArmor?: boolean}} opts
   * @returns {boolean} true when the whole stack fitted
   */
  addItem(stack, opts = {}) {
    if (empty(stack)) return true;
    if (opts.equipArmor !== false && this.autoEquip(stack) && stack.count <= 0) return true;

    const held = this.slots[this.selected];
    if (!empty(held) && held.matches(stack) && stack.maxStack > 1) {
      const room = held.maxStack - held.count;
      const n = Math.min(room, stack.count);
      if (n > 0) { held.count += n; stack.count -= n; this.changed(); }
    }
    this.insert(stack);
    return stack.count <= 0;
  }

  /**
   * Put a piece of armour on if its slot is free. Returns true when equipped.
   * Used by picking armour up in creative, right-clicking it, and shift-clicking.
   */
  autoEquip(stack) {
    if (empty(stack)) return false;
    const slot = stack.item.armorSlot;
    if (slot == null || slot < 0 || slot >= ARMOR_SIZE) return false;
    if (!empty(this.armor.slots[slot])) return false;
    if (!this.armor.mayPlace(slot, stack)) return false;
    this.armor.slots[slot] = stack.maxStack === 1 && stack.count > 1
      ? stack.split(1) : stack.split(stack.count);
    this.armor.changed();
    return true;
  }

  /** Right-click an armour piece in the inventory: equip it, swapping out. */
  equipArmor(stack) {
    if (empty(stack)) return null;
    const slot = stack.item.armorSlot;
    if (slot == null) return null;
    const prev = this.armor.slots[slot] ?? null;
    this.armor.slots[slot] = stack;
    this.armor.changed();
    return prev;
  }

  // -- Removing ------------------------------------------------------------

  /**
   * Drop `all ? the whole stack : one item` out of slot `i`.
   * @returns {ItemStack|null} what left the inventory
   */
  drop(i = this.selected, all = false) {
    const s = this.getStack(i);
    if (!s) return null;
    const out = s.split(all ? s.count : 1);
    if (s.count <= 0) this.slots[i] = null;
    this.changed();
    return orNull(out);
  }

  dropSelected(all = false) { return this.drop(this.selected, all); }

  /** Everything the player was carrying, for a death drop. */
  dropAll() {
    const out = [
      ...this.drain(),
      ...this.armor.drain(),
      ...this.offhandSlot.drain(),
    ];
    return out;
  }

  /** Shift-click from within the player's own inventory. */
  quickMove(index, dest = null) {
    const stack = this.getStack(index);
    if (!stack) return false;
    if (dest) return this.transferTo(index, dest);
    // Armour goes on first, then hotbar <-> main rows.
    if (stack.item.armorSlot != null && this.autoEquip(stack)) {
      if (stack.count <= 0) this.slots[index] = null;
      this.changed();
      return true;
    }
    const inHotbar = index < HOTBAR_SIZE;
    const from = inHotbar ? HOTBAR_SIZE : 0;
    const to = inHotbar ? INVENTORY_SIZE : HOTBAR_SIZE;
    const moved = this.insert(stack, { from, to });
    if (moved <= 0) return false;
    if (stack.count <= 0) this.slots[index] = null;
    this.changed();
    return true;
  }

  // -- Derived stats -------------------------------------------------------

  get armorValue() {
    let n = 0;
    for (const s of this.armor.slots) if (!empty(s)) n += s.item.defense || 0;
    return n;
  }

  get armorToughness() {
    let n = 0;
    for (const s of this.armor.slots) if (!empty(s)) n += s.item.toughness || 0;
    return n;
  }

  /** Wear the armour down by `amount` points each; drops broken pieces. */
  damageArmor(amount, random = null) {
    for (let i = 0; i < ARMOR_SIZE; i++) {
      const s = this.armor.slots[i];
      if (empty(s) || s.item.maxDamage <= 0) continue;
      if (s.damageBy(Math.max(1, Math.floor(amount)), random)) this.armor.slots[i] = null;
    }
    this.armor.changed();
  }

  /** Total damage the player can take off before armour is gone. */
  hasItem(name, n = 1) { return this.count(name) >= n; }

  // -- Persistence ---------------------------------------------------------

  save() {
    return {
      slots: this.slots.map(stackToJSON),
      armor: this.armor.slots.map(stackToJSON),
      offhand: stackToJSON(this.offhand),
      selected: this.selected,
      enderChest: this.enderChest.save().slots,
    };
  }

  load(data) {
    if (!data) return this;
    const src = Array.isArray(data) ? { slots: data } : data;
    this.slots.fill(null);
    for (let i = 0; i < Math.min(src.slots?.length ?? 0, this.size); i++) {
      this.slots[i] = stackFromJSON(src.slots[i]);
    }
    this.armor.slots.fill(null);
    for (let i = 0; i < Math.min(src.armor?.length ?? 0, ARMOR_SIZE); i++) {
      this.armor.slots[i] = stackFromJSON(src.armor[i]);
    }
    this.offhand = stackFromJSON(src.offhand);
    this.setSelectedSlot(src.selected ?? 0);
    if (src.enderChest) this.enderChest.load(src.enderChest);
    this.changed();
    return this;
  }

  static fromJSON(data, player = null) {
    return new PlayerInventory(player).load(data);
  }
}

// ---------------------------------------------------------------------------
// Slots and menus
// ---------------------------------------------------------------------------

/**
 * A slot binds a screen position to one index of some container. Screens set
 * `x`/`y`; the click protocol only ever talks to `get`/`set`.
 */
export class Slot {
  constructor(container, index, opts = {}) {
    this.container = container;
    this.index = index;
    this.x = opts.x ?? 0;
    this.y = opts.y ?? 0;
    this.group = opts.group ?? 'main';
    /** Crafting results: take-only, and taking consumes the ingredients. */
    this.output = !!opts.output;
    this.filter = opts.filter ?? null;
    this.max = opts.max ?? null;
    this.background = opts.background ?? null;   // icon drawn when empty
    this.onTake = opts.onTake ?? null;           // (stack, menu, count) => void
    this.onChanged = opts.onChanged ?? null;
    this.enabled = opts.enabled !== false;
    this.visible = opts.visible !== false;
    this.menu = null;
    this.id = -1;
  }

  get() { return this.container ? this.container.getStack(this.index) : null; }

  set(stack) {
    if (!this.container) return this;
    this.container.setStack(this.index, stack);
    this.onChanged?.(this);
    return this;
  }

  mayPlace(stack) {
    if (this.output || !this.enabled || empty(stack)) return false;
    if (this.filter && !this.filter(stack)) return false;
    return this.container ? this.container.mayPlace(this.index, stack) : true;
  }

  mayPickup() {
    if (!this.enabled) return false;
    return this.container ? this.container.mayPickup(this.index) : true;
  }

  /** How many items this slot may hold of `stack`. */
  limit(stack) {
    const containerMax = this.container ? this.container.slotLimit(this.index) : 64;
    const itemMax = stack ? stack.maxStack : 64;
    return Math.min(this.max ?? Infinity, containerMax, itemMax);
  }

  contains(mx, my) {
    return this.visible && mx >= this.x && my >= this.y &&
      mx < this.x + 16 && my < this.y + 16;
  }
}

/**
 * The interactive layer over a set of slots: owns the cursor stack and
 * implements Minecraft's click protocol.
 *
 *  left click      pick up / place all / merge / swap
 *  right click     pick up half / place one
 *  shift click     quick-move to the other section
 *  middle click    clone the stack (creative)
 *  1..9            swap the slot with that hotbar slot
 *  left drag       spread the cursor evenly over the dragged slots
 *  right drag      one item per dragged slot
 *  middle drag     fill every dragged slot (creative)
 */
export class ContainerMenu {
  constructor(opts = {}) {
    this.slots = [];
    this.sections = [];
    this.cursor = null;
    this.inventory = opts.inventory ?? null;
    this.creative = !!opts.creative;
    /** Called with a stack that should be thrown into the world. */
    this.onDrop = opts.onDrop ?? null;
    this.onCraft = opts.onCraft ?? null;
    this.drag = null;
  }

  addSlot(slot) {
    slot.menu = this;
    slot.id = this.slots.length;
    this.slots.push(slot);
    return slot;
  }

  /** Bind a whole container into a rectangular block of slots. */
  addContainer(container, opts = {}) {
    const cols = opts.cols ?? 9;
    const x = opts.x ?? 8;
    const y = opts.y ?? 18;
    const from = opts.from ?? 0;
    const to = opts.to ?? container.size;
    const pitch = opts.pitch ?? 18;
    const made = [];
    for (let i = from; i < to; i++) {
      const n = i - from;
      made.push(this.addSlot(new Slot(container, i, {
        x: x + (n % cols) * pitch,
        y: y + Math.floor(n / cols) * pitch,
        group: opts.group ?? container.type,
        filter: opts.filter ?? null,
      })));
    }
    return made;
  }

  /** Name a run of slots so quick-move knows where things should go. */
  section(name, from, to, opts = {}) {
    this.sections.push({ name, from, to, reverse: !!opts.reverse, priority: opts.priority ?? 0 });
    return this;
  }

  sectionOf(index) {
    for (const s of this.sections) if (index >= s.from && index < s.to) return s;
    return null;
  }

  slotAt(mx, my) {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].contains(mx, my)) return i;
    }
    return -1;
  }

  // -- Click protocol ------------------------------------------------------

  /**
   * @param {number} index slot index
   * @param {number} button 0 left, 1 right, 2 middle
   * @param {{shift?: boolean, creative?: boolean}} mods
   */
  click(index, button = CLICK.LEFT, mods = {}) {
    const slot = this.slots[index];
    if (!slot || !slot.enabled) return false;

    if (mods.shift) return this.quickMove(index);
    if (button === CLICK.MIDDLE) return this.cloneSlot(index, mods);
    if (slot.output) return this.takeOutput(index, false);

    const held = slot.get();
    const cursor = this.cursor;

    // Empty hand: pick the slot up (right click takes half, rounded up).
    if (empty(cursor)) {
      if (empty(held) || !slot.mayPickup()) return false;
      const take = button === CLICK.RIGHT ? Math.ceil(held.count / 2) : held.count;
      this.cursor = held.split(take);
      if (held.count <= 0) slot.set(null); else slot.set(held);
      slot.onTake?.(this.cursor, this, this.cursor.count);
      return true;
    }

    // Holding something and the slot is free: place all, or one on right click.
    if (empty(held)) {
      if (!slot.mayPlace(cursor)) return false;
      const room = slot.limit(cursor);
      const n = Math.min(button === CLICK.RIGHT ? 1 : cursor.count, room);
      if (n <= 0) return false;
      slot.set(cursor.split(n));
      if (cursor.count <= 0) this.cursor = null;
      return true;
    }

    // Same item: top the slot up.
    if (held.matches(cursor)) {
      if (!slot.mayPlace(cursor)) return false;
      const room = Math.min(slot.limit(held), held.maxStack) - held.count;
      if (room <= 0) {
        // Full: a left click with a partial cursor pulls the stack instead.
        return false;
      }
      const n = Math.min(button === CLICK.RIGHT ? 1 : cursor.count, room);
      held.count += n;
      cursor.count -= n;
      if (cursor.count <= 0) this.cursor = null;
      slot.set(held);
      return true;
    }

    // Different items: swap, if the slot will take what we are holding.
    if (!slot.mayPlace(cursor) || !slot.mayPickup()) return false;
    if (cursor.count > slot.limit(cursor)) return false;
    slot.set(cursor);
    this.cursor = held;
    return true;
  }

  /** Shift-click. */
  quickMove(index) {
    const slot = this.slots[index];
    if (!slot) return false;
    const stack = slot.get();
    if (empty(stack) || !slot.mayPickup()) return false;
    if (slot.output) return this.takeOutput(index, true);

    const before = stack.count;
    for (const target of this.transferTargets(index)) {
      if (stack.count <= 0) break;
      this.moveInto(stack, target.from, target.to, target.reverse);
    }
    const moved = before - stack.count;
    if (moved <= 0) return false;
    if (stack.count <= 0) slot.set(null); else slot.set(stack);
    slot.onTake?.(stack, this, moved);
    return true;
  }

  /** Where shift-clicking `index` should send items, in priority order. */
  transferTargets(index) {
    const own = this.sectionOf(index);
    const out = [];
    const rest = this.sections.filter((s) => s !== own);
    rest.sort((a, b) => b.priority - a.priority);
    for (const s of rest) out.push({ from: s.from, to: s.to, reverse: s.reverse });
    if (out.length === 0) out.push({ from: 0, to: this.slots.length, reverse: false });
    return out;
  }

  /** Merge `stack` into menu slots [from,to), matching stacks first. */
  moveInto(stack, from, to, reverse = false) {
    if (empty(stack)) return 0;
    const order = [];
    for (let i = from; i < to; i++) order.push(reverse ? from + to - 1 - i : i);
    let moved = 0;
    if (stack.maxStack > 1) {
      for (const i of order) {
        if (stack.count <= 0) break;
        const slot = this.slots[i];
        if (!slot || slot.output || !slot.enabled) continue;
        const s = slot.get();
        if (empty(s) || !s.matches(stack)) continue;
        const room = Math.min(slot.limit(s), s.maxStack) - s.count;
        if (room <= 0) continue;
        const n = Math.min(room, stack.count);
        s.count += n;
        stack.count -= n;
        moved += n;
        slot.set(s);
      }
    }
    for (const i of order) {
      if (stack.count <= 0) break;
      const slot = this.slots[i];
      if (!slot || slot.output || !slot.enabled) continue;
      if (!empty(slot.get())) continue;
      if (!slot.mayPlace(stack)) continue;
      const n = Math.min(slot.limit(stack), stack.count);
      if (n <= 0) continue;
      slot.set(stack.split(n));
      moved += n;
    }
    return moved;
  }

  /** Take a crafting result: once, or as many as fit when shift-clicked. */
  takeOutput(index, all = false) {
    const slot = this.slots[index];
    if (!slot) return false;
    let took = 0;
    for (let guard = 0; guard < (all ? 64 : 1); guard++) {
      const result = slot.get();
      if (empty(result)) break;
      const made = result.clone();
      if (all) {
        // Straight into the inventory; stop when it will not fit.
        const target = this.inventory;
        if (!target) break;
        if (!target.canFit(made)) break;
        target.addItem(made, { equipArmor: false });
      } else if (empty(this.cursor)) {
        this.cursor = made;
      } else if (this.cursor.matches(made) &&
        this.cursor.count + made.count <= this.cursor.maxStack) {
        this.cursor.count += made.count;
      } else {
        break;
      }
      took += result.count;
      slot.onTake?.(result, this, result.count);
      this.onCraft?.(result, this);
    }
    return took > 0;
  }

  /** Middle click in creative: fill the cursor with a copy of the stack. */
  cloneSlot(index, mods = {}) {
    if (!(this.creative || mods.creative)) return false;
    if (!empty(this.cursor)) return false;
    const slot = this.slots[index];
    const stack = slot?.get();
    if (empty(stack)) return false;
    const copy = stack.clone();
    copy.count = copy.maxStack;
    this.cursor = copy;
    return true;
  }

  /** Number keys 1-9: swap the slot with that hotbar slot. */
  hotbarSwap(index, hotbar) {
    const inv = this.inventory;
    const slot = this.slots[index];
    if (!inv || !slot || hotbar < 0 || hotbar >= HOTBAR_SIZE) return false;
    const inHotbar = inv.getStack(hotbar);
    if (slot.output) {
      if (!empty(inHotbar)) return false;
      const result = slot.get();
      if (empty(result)) return false;
      inv.setStack(hotbar, result.clone());
      slot.onTake?.(result, this, result.count);
      this.onCraft?.(result, this);
      return true;
    }
    const inSlot = slot.get();
    if (!empty(inSlot) && !slot.mayPickup()) return false;
    if (!empty(inHotbar) && !slot.mayPlace(inHotbar)) return false;
    slot.set(inHotbar);
    inv.setStack(hotbar, inSlot);
    return true;
  }

  /** Q over a slot. */
  dropSlot(index, all = false) {
    const slot = this.slots[index];
    if (!slot || !slot.mayPickup()) return false;
    const stack = slot.get();
    if (empty(stack)) return false;
    const out = stack.split(all ? stack.count : 1);
    if (stack.count <= 0) slot.set(null); else slot.set(stack);
    slot.onTake?.(out, this, out.count);
    this.throwOut(out);
    return true;
  }

  /** Clicking off the panel throws the held stack away. */
  clickOutside(button = CLICK.LEFT) {
    if (empty(this.cursor)) return false;
    const out = button === CLICK.RIGHT
      ? this.cursor.split(1) : this.cursor.split(this.cursor.count);
    if (this.cursor.count <= 0) this.cursor = null;
    this.throwOut(out);
    return true;
  }

  throwOut(stack) {
    if (empty(stack)) return;
    if (this.onDrop) this.onDrop(stack);
    else if (this.inventory) this.inventory.addItem(stack, { equipArmor: false });
  }

  // -- Drag distribute -----------------------------------------------------

  beginDrag(button = CLICK.LEFT, origin = -1) {
    if (empty(this.cursor)) return false;
    this.drag = { button, origin, slots: [], started: false };
    if (origin >= 0) this.dragOver(origin);
    return true;
  }

  /** Add a slot to the current drag if it can take the held item. */
  dragOver(index) {
    const d = this.drag;
    if (!d || index < 0) return false;
    if (d.slots.includes(index)) return false;
    const slot = this.slots[index];
    if (!slot || slot.output || !slot.enabled) return false;
    if (!slot.mayPlace(this.cursor)) return false;
    const held = slot.get();
    if (!empty(held) && !held.matches(this.cursor)) return false;
    if (!empty(held) && held.count >= slot.limit(held)) return false;
    d.slots.push(index);
    if (d.slots.length > 1 || index !== d.origin) d.started = true;
    return true;
  }

  /** How many items would land in `index` if the drag ended now. */
  dragCount(index) {
    const d = this.drag;
    if (!d || !d.started || empty(this.cursor)) return 0;
    if (!d.slots.includes(index)) return 0;
    const slot = this.slots[index];
    const held = slot.get();
    const room = Math.min(slot.limit(this.cursor), this.cursor.maxStack) -
      (empty(held) ? 0 : held.count);
    if (d.button === CLICK.RIGHT) return Math.min(1, room);
    if (d.button === CLICK.MIDDLE) return Math.max(0, room);
    return Math.min(Math.floor(this.cursor.count / d.slots.length), room);
  }

  /** Release: spread the cursor over every slot collected during the drag. */
  finishDrag() {
    const d = this.drag;
    this.drag = null;
    if (!d || !d.started || empty(this.cursor)) return false;
    const n = d.slots.length;
    if (n === 0) return false;
    const cursor = this.cursor;
    const creative = d.button === CLICK.MIDDLE && this.creative;
    const per = d.button === CLICK.RIGHT ? 1
      : creative ? Infinity
        : Math.floor(cursor.count / n);
    if (per <= 0) return false;

    let placed = 0;
    for (const i of d.slots) {
      if (!creative && cursor.count <= 0) break;
      const slot = this.slots[i];
      const held = slot.get();
      const room = Math.min(slot.limit(cursor), cursor.maxStack) -
        (empty(held) ? 0 : held.count);
      const give = Math.min(per, room, creative ? room : cursor.count);
      if (give <= 0) continue;
      if (empty(held)) {
        const s = cursor.clone();
        s.count = give;
        slot.set(s);
      } else {
        held.count += give;
        slot.set(held);
      }
      if (!creative) cursor.count -= give;
      placed += give;
    }
    if (cursor.count <= 0) this.cursor = null;
    return placed > 0;
  }

  cancelDrag() { this.drag = null; }

  isDragging() { return !!this.drag && this.drag.started; }

  // -- Pointer state machine ----------------------------------------------
  //
  // Mouse-down with a full cursor may be the start of a drag; it only becomes
  // one once a second slot is touched, so a press-and-release in place still
  // behaves as an ordinary click.

  pointerDown(index, button, mods = {}) {
    if (!empty(this.cursor) && !mods.shift && button !== CLICK.MIDDLE) {
      this.beginDrag(button, index);
      return true;
    }
    if (index >= 0) return this.click(index, button, mods);
    return this.clickOutside(button);
  }

  pointerMove(index) {
    if (this.drag && index >= 0) this.dragOver(index);
  }

  pointerUp(index, button, mods = {}) {
    const d = this.drag;
    if (!d || d.button !== button) return false;
    if (d.started) return this.finishDrag();
    this.drag = null;
    if (d.origin >= 0) return this.click(d.origin, button, mods);
    return this.clickOutside(button);
  }

  /** Give everything on the cursor back when the screen closes. */
  returnCursor() {
    if (empty(this.cursor)) return;
    const stack = this.cursor;
    this.cursor = null;
    if (this.inventory && this.inventory.addItem(stack, { equipArmor: false })) return;
    this.throwOut(stack);
  }
}

export default PlayerInventory;
