// Every workstation and container screen.
//
// The block registry opens these by name: `world.game.ui.openMenu('anvil', …)`
// looks for `screenFor('anvil')` here, so this module is the whole catalogue of
// interactive blocks. Each screen is a `ContainerScreen` — the click protocol,
// slot drawing and tooltips come for free, and the code below is only the
// layout and whatever the station actually does to items.
//
// Stations degrade gracefully: where a dedicated module exists
// (recipes, enchanting, experience) it is used, and where it does not the
// screen falls back to a self-contained rule so the block is never a dead end.

import {
  ContainerScreen, CraftingGrid,
} from './inventoryscreen.js';
import {
  drawText, drawCenteredText, drawTooltip, panel, slotWell, blit, blitClipped,
  nineSlice, textWidth, Button, TextField, ScrollPanel, GUI, SLOT, ICON, FONT_HEIGHT,
} from './screen.js';
import { Container, Slot, HOTBAR_SIZE } from '../inventory.js';
import { ItemStack, itemsByName, MATERIALS } from '../items.js';
import { blockOf } from '../../world/blocks.js';

// ---------------------------------------------------------------------------
// Getting at a block's inventory
// ---------------------------------------------------------------------------

/**
 * Wrap whatever a block entity uses for storage in a `Container`, so screens
 * only ever see one interface. The container aliases the block entity's own
 * `slots` array, which keeps hoppers and furnaces working on the same data.
 */
export function adoptContainer(host, size, type, title) {
  if (!host) return null;
  if (host.container?.slots) return host.container;
  if (!Array.isArray(host.slots)) host.slots = new Array(size).fill(null);
  while (host.slots.length < size) host.slots.push(null);
  const c = new Container(0, { title, type });
  c.slots = host.slots;
  c.blockEntity = host;
  host.container = c;
  return c;
}

/**
 * The container for the block at (x,y,z). Uses the block entity when the block
 * entity module is loaded, and otherwise remembers a container per position on
 * the world so chests still hold their contents for the session.
 */
export function containerFor(game, world, x, y, z, size, type, title) {
  const be = world?.getBlockEntity?.(x, y, z);
  if (be) return adoptContainer(be, size, type, title);
  if (!world) return new Container(size, { type, title });
  const map = world.__uiContainers ?? (world.__uiContainers = new Map());
  const key = `${x},${y},${z}`;
  let host = map.get(key);
  if (!host) { host = { slots: new Array(size).fill(null) }; map.set(key, host); }
  return adoptContainer(host, size, type, title);
}

/** Size and type declared by the block definition, when it has one. */
function containerSpec(world, x, y, z, fallbackSize, fallbackType) {
  const def = world ? blockOf(world.getBlock(x, y, z)) : null;
  return {
    size: def?.container?.slots ?? fallbackSize,
    type: def?.container?.type ?? fallbackType,
    title: def?.displayName ?? null,
  };
}

// ---------------------------------------------------------------------------
// A generic "container above, inventory below" screen
// ---------------------------------------------------------------------------

export class SimpleContainerScreen extends ContainerScreen {
  constructor(game, container, opts = {}) {
    const rows = opts.rows ?? Math.ceil((container?.size ?? 27) / (opts.cols ?? 9));
    const cols = opts.cols ?? 9;
    super(game, {
      title: opts.title ?? container?.title ?? 'Container',
      width: opts.width ?? 176,
      height: opts.height ?? (114 + rows * SLOT),
      container,
      rows,
      cols,
      startY: opts.startY ?? 18,
      startX: opts.startX ?? 8,
      ...opts,
    });
  }

  build() {
    const c = this.opts.container;
    if (!c) return;
    const cols = this.opts.cols ?? 9;
    const from = this.menu.slots.length;
    this.menu.addContainer(c, {
      x: this.opts.startX ?? 8,
      y: this.opts.startY ?? 18,
      cols,
      group: 'container',
    });
    this.menu.section('container', from, this.menu.slots.length);
    this.addPlayerSlots(this.height - 82, this.height - 24);
  }
}

/** Chests, barrels and shulker boxes. Opened by `game.ui.openContainer`. */
export class ChestScreen extends SimpleContainerScreen {
  constructor(game, blockEntity, world, x, y, z) {
    const spec = containerSpec(world, x, y, z, 27, 'chest');
    const container = blockEntity
      ? adoptContainer(blockEntity, spec.size, spec.type, spec.title)
      : containerFor(game, world, x, y, z, spec.size, spec.type, spec.title);
    super(game, container, { title: spec.title ?? 'Chest' });
    this.world = world;
    this.pos = { x, y, z };
  }

  onOpen() {
    super.onOpen();
    this.world?.playSound?.('chest.open', this.pos.x + 0.5, this.pos.y + 0.5, this.pos.z + 0.5);
  }

  onClose() {
    super.onClose();
    this.world?.playSound?.('chest.close', this.pos.x + 0.5, this.pos.y + 0.5, this.pos.z + 0.5);
  }
}

export class ShulkerBoxScreen extends ChestScreen {}
export class BarrelScreen extends ChestScreen {}

/** Dispensers and droppers: a 3x3 block of slots. */
export class DispenserScreen extends SimpleContainerScreen {
  constructor(game, world, x, y, z) {
    super(game, containerFor(game, world, x, y, z, 9, 'dispenser'), {
      title: containerSpec(world, x, y, z, 9, 'dispenser').title ?? 'Dispenser',
      cols: 3, rows: 3, height: 166, startX: 62, startY: 17,
    });
  }
}

export class HopperScreen extends SimpleContainerScreen {
  constructor(game, world, x, y, z) {
    super(game, containerFor(game, world, x, y, z, 5, 'hopper'), {
      title: 'Hopper', cols: 5, rows: 1, height: 133, startX: 44, startY: 20,
    });
  }
}

// ---------------------------------------------------------------------------
// Crafting table
// ---------------------------------------------------------------------------

export class CraftingScreen extends ContainerScreen {
  constructor(game) {
    super(game, { title: 'Crafting', width: 176, height: 166 });
  }

  build() {
    this.crafting = new CraftingGrid(this.game, 3);
    const from = this.menu.slots.length;
    for (let i = 0; i < 9; i++) {
      this.menu.addSlot(new Slot(this.crafting.input, i, {
        x: 30 + (i % 3) * SLOT, y: 17 + Math.floor(i / 3) * SLOT, group: 'craft',
      }));
    }
    this.menu.addSlot(new Slot(this.crafting.output, 0, {
      x: 124, y: 35, group: 'result', output: true,
      onTake: () => {
        this.crafting.consume();
        const p = this.game.player;
        this.game.world?.playSound?.('ui.craft', p.x, p.y, p.z, 0.35);
      },
    }));
    this.menu.section('craft', from, this.menu.slots.length, { priority: -1 });
    this.addPlayerSlots(84, 142);
  }

  renderPanel(ctx, lx, ly) {
    super.renderPanel(ctx, lx, ly);
    blit(ctx, GUI.arrowEmpty, 90, 35);
  }

  onClose() {
    for (const stack of this.crafting?.drain() ?? []) {
      if (!this.inv?.addItem(stack, { equipArmor: false })) this.dropIntoWorld(stack);
    }
    super.onClose();
  }
}

// ---------------------------------------------------------------------------
// Furnaces
// ---------------------------------------------------------------------------

/** True when the item can be burned as fuel. */
function isFuel(stack) {
  return !!stack && (stack.item.fuelTicks > 0 || stack.item.name === 'lava_bucket');
}

export class FurnaceScreen extends ContainerScreen {
  constructor(game, world, x, y, z, player, opts = {}) {
    const be = world?.getBlockEntity?.(x, y, z);
    super(game, {
      title: opts.title ?? containerSpec(world, x, y, z, 3, 'furnace').title ?? 'Furnace',
      width: 176,
      height: 166,
      container: containerFor(game, world, x, y, z, 3, 'furnace'),
      blockEntity: be,
    });
    this.world = world;
    this.pos = { x, y, z };
  }

  build() {
    const c = this.opts.container;
    if (!c) return;
    const from = this.menu.slots.length;
    this.menu.addSlot(new Slot(c, 0, { x: 56, y: 17, group: 'input' }));
    this.menu.addSlot(new Slot(c, 1, {
      x: 56, y: 53, group: 'fuel', filter: (s) => isFuel(s), background: 'flameFull',
    }));
    this.menu.addSlot(new Slot(c, 2, {
      x: 116, y: 35, group: 'result', filter: () => false,
      onTake: () => this.onSmeltTaken(),
    }));
    this.menu.section('furnace', from, this.menu.slots.length);
    this.addPlayerSlots(84, 142);
  }

  onSmeltTaken() {
    const be = this.blockEntity;
    const xp = be?.storedXp ?? 0;
    if (xp > 0 && this.game.modules.experience?.spawnOrbs) {
      this.game.modules.experience.spawnOrbs(this.world, this.pos.x + 0.5,
        this.pos.y + 0.5, this.pos.z + 0.5, Math.floor(xp));
      be.storedXp = 0;
    }
  }

  /** Progress comes from the block entity when there is one. */
  progress() {
    const be = this.blockEntity;
    if (!be) return { cook: 0, burn: 0 };
    const cook = be.cookTotal > 0 ? (be.cookTime ?? 0) / be.cookTotal : 0;
    const burn = be.burnTotal > 0 ? (be.burnTime ?? 0) / be.burnTotal : 0;
    return { cook: Math.max(0, Math.min(1, cook)), burn: Math.max(0, Math.min(1, burn)) };
  }

  renderPanel(ctx, lx, ly) {
    super.renderPanel(ctx, lx, ly);
    const { cook, burn } = this.progress();
    blit(ctx, GUI.flameEmpty, 56, 36);
    if (burn > 0) blitClipped(ctx, GUI.flameFull, 56, 36, burn, true);
    blit(ctx, GUI.arrowEmpty, 79, 34);
    if (cook > 0) blitClipped(ctx, GUI.arrowFull, 79, 34, cook);
  }
}

export class BlastFurnaceScreen extends FurnaceScreen {
  constructor(game, world, x, y, z, player) {
    super(game, world, x, y, z, player, { title: 'Blast Furnace' });
  }
}

export class SmokerScreen extends FurnaceScreen {
  constructor(game, world, x, y, z, player) {
    super(game, world, x, y, z, player, { title: 'Smoker' });
  }
}

// ---------------------------------------------------------------------------
// Brewing stand
// ---------------------------------------------------------------------------

export class BrewingStandScreen extends ContainerScreen {
  constructor(game, world, x, y, z) {
    super(game, {
      title: 'Brewing Stand',
      width: 176,
      height: 166,
      container: containerFor(game, world, x, y, z, 5, 'brewing_stand'),
      blockEntity: world?.getBlockEntity?.(x, y, z),
    });
    this.world = world;
  }

  build() {
    const c = this.opts.container;
    if (!c) return;
    const bottle = (s) => !!s && (s.item.name.includes('potion') || s.item.name === 'glass_bottle');
    const from = this.menu.slots.length;
    this.menu.addSlot(new Slot(c, 0, { x: 56, y: 51, group: 'bottle', filter: bottle }));
    this.menu.addSlot(new Slot(c, 1, { x: 79, y: 58, group: 'bottle', filter: bottle }));
    this.menu.addSlot(new Slot(c, 2, { x: 102, y: 51, group: 'bottle', filter: bottle }));
    this.menu.addSlot(new Slot(c, 3, { x: 79, y: 17, group: 'ingredient' }));
    this.menu.addSlot(new Slot(c, 4, {
      x: 17, y: 17, group: 'fuel',
      filter: (s) => s.item.name === 'blaze_powder',
    }));
    this.menu.section('brewing', from, this.menu.slots.length);
    this.addPlayerSlots(84, 142);
  }

  renderPanel(ctx, lx, ly) {
    super.renderPanel(ctx, lx, ly);
    const be = this.blockEntity;
    const brew = be?.brewTotal > 0 ? 1 - (be.brewTime ?? 0) / be.brewTotal : 0;
    const fuel = be?.fuelTotal > 0 ? (be.fuel ?? 0) / be.fuelTotal : 0;
    blit(ctx, GUI.brewArrow, 97, 16);
    if (brew > 0) blitClipped(ctx, GUI.brewArrow, 97, 16, brew, true);
    if (brew > 0) blitClipped(ctx, GUI.brewBubbles, 60, 44, brew);
    // The fuel gauge along the top left.
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(17, 12, 18, 4);
    ctx.fillStyle = '#f0a020';
    ctx.fillRect(17, 12, Math.round(18 * fuel), 4);
  }
}

// ---------------------------------------------------------------------------
// Anvil
// ---------------------------------------------------------------------------

/** Merge b's enchantments into a copy of a, Minecraft-style (max level, +1). */
function mergeEnchantments(target, source) {
  const src = source?.tag?.enchantments;
  if (!src) return 0;
  let cost = 0;
  for (const [id, level] of Object.entries(src)) {
    const have = target.getEnchantLevel(id);
    const next = have === level ? Math.min(level + 1, 5) : Math.max(have, level);
    if (next > have) {
      target.addEnchantment(id, next);
      cost += next;
    }
  }
  return cost;
}

export class AnvilScreen extends ContainerScreen {
  constructor(game, world, x, y, z) {
    super(game, { title: 'Repair & Name', width: 176, height: 166 });
    this.world = world;
    this.pos = { x, y, z };
  }

  build() {
    this.input = new Container(2, { title: 'Anvil', type: 'anvil' });
    this.output = new Container(1, { type: 'result' });
    this.customName = '';
    this.cost = 0;
    this.input.onChange(() => this.refresh());

    const from = this.menu.slots.length;
    this.menu.addSlot(new Slot(this.input, 0, { x: 27, y: 47, group: 'anvil' }));
    this.menu.addSlot(new Slot(this.input, 1, { x: 76, y: 47, group: 'anvil' }));
    this.menu.addSlot(new Slot(this.output, 0, {
      x: 134, y: 47, group: 'result', output: true, onTake: () => this.onTake(),
    }));
    this.menu.section('anvil', from, this.menu.slots.length);
    this.addPlayerSlots(84, 142);
  }

  layout() {
    const o = this.origin;
    this.nameField = this.addWidget(new TextField(o.x + 26, o.y + 24, 103, 12, {
      placeholder: 'Name',
      maxLength: 35,
      text: this.customName,
      onChange: (t) => { this.customName = t; this.refresh(); },
    }));
  }

  /** Work out what the two inputs combine into, and what it costs. */
  refresh() {
    const a = this.input.getStack(0);
    const b = this.input.getStack(1);
    this.cost = 0;
    if (!a) { this.output.setStack(0, null); return; }

    const out = a.clone();
    let cost = 0;

    if (b) {
      const repairMaterial = a.item.repairWith ??
        (a.item.material ? MATERIALS[a.item.material]?.repair : null);
      if (b.item === a.item && a.item.maxDamage > 0) {
        // Two of the same tool: durability adds up, plus a 12% bonus.
        const restored = Math.min(a.damage,
          (a.item.maxDamage - b.damage) + Math.floor(a.item.maxDamage * 0.12));
        out.damage = Math.max(0, a.damage - restored);
        cost += 2;
        cost += mergeEnchantments(out, b);
      } else if (repairMaterial && b.item.name === repairMaterial && a.item.maxDamage > 0) {
        // Repairing with the raw material: a quarter of full durability each.
        const per = Math.ceil(a.item.maxDamage / 4);
        const units = Math.min(b.count, Math.ceil(a.damage / per));
        if (units <= 0) { this.output.setStack(0, null); return; }
        out.damage = Math.max(0, a.damage - per * units);
        this.materialUsed = units;
        cost += units;
      } else if (b.item.name === 'enchanted_book' || b.enchanted) {
        cost += mergeEnchantments(out, b);
        if (cost === 0) { this.output.setStack(0, null); return; }
      } else {
        this.output.setStack(0, null);
        return;
      }
    }

    const named = this.customName.trim();
    if (named && named !== a.displayName) {
      out.tag = out.tag ?? {};
      out.tag.name = named;
      cost += 1;
    } else if (!named && out.tag?.name) {
      delete out.tag.name;
      cost += 1;
    }

    if (cost === 0) { this.output.setStack(0, null); return; }
    this.cost = cost;
    this.output.setStack(0, out);
  }

  get affordable() {
    const p = this.game.player;
    return p.gamemode === 1 || (p.xpLevel ?? 0) >= this.cost;
  }

  onTake() {
    const p = this.game.player;
    if (p.gamemode !== 1) p.xpLevel = Math.max(0, (p.xpLevel ?? 0) - this.cost);
    const b = this.input.getStack(1);
    if (b && this.materialUsed > 0 && b.item.name !== this.input.getStack(0)?.item.name) {
      b.count -= this.materialUsed;
      if (b.count <= 0) this.input.setStack(1, null);
    } else {
      this.input.setStack(1, null);
    }
    this.materialUsed = 0;
    this.input.setStack(0, null);
    this.world?.playSound?.('anvil.use', this.pos.x + 0.5, this.pos.y + 0.5, this.pos.z + 0.5);
  }

  renderPanel(ctx, lx, ly) {
    super.renderPanel(ctx, lx, ly);
    // A plus between the inputs and the arrow to the result.
    drawText(ctx, '+', 60, 51, 0x8b8b8b, { shadow: false });
    blit(ctx, GUI.arrowEmpty, 99, 45);
    if (this.cost > 0) {
      const color = this.affordable ? 0x80ff20 : 0xff6060;
      drawText(ctx, `Cost: ${this.cost}`, this.width - 8, 62, color, { align: 'right' });
      if (!this.affordable) blit(ctx, GUI.anvilCross, 134 + 1, 48);
    }
  }

  renderForeground(ctx, mx, my, dt) {
    // The name field is a widget, so it draws in screen space, not panel space.
    super.renderForeground(ctx, mx, my, dt);
  }

  onClose() {
    for (const stack of this.input.drain()) {
      if (!this.inv?.addItem(stack, { equipArmor: false })) this.dropIntoWorld(stack);
    }
    this.output.clear();
    super.onClose();
  }
}

// ---------------------------------------------------------------------------
// Grindstone
// ---------------------------------------------------------------------------

export class GrindstoneScreen extends ContainerScreen {
  constructor(game, world, x, y, z) {
    super(game, { title: 'Repair & Disenchant', width: 176, height: 166 });
    this.world = world;
  }

  build() {
    this.input = new Container(2, { title: 'Grindstone', type: 'grindstone' });
    this.output = new Container(1, { type: 'result' });
    this.xp = 0;
    this.input.onChange(() => this.refresh());

    const from = this.menu.slots.length;
    this.menu.addSlot(new Slot(this.input, 0, { x: 49, y: 19, group: 'grindstone' }));
    this.menu.addSlot(new Slot(this.input, 1, { x: 49, y: 40, group: 'grindstone' }));
    this.menu.addSlot(new Slot(this.output, 0, {
      x: 129, y: 34, group: 'result', output: true, onTake: () => this.onTake(),
    }));
    this.menu.section('grindstone', from, this.menu.slots.length);
    this.addPlayerSlots(84, 142);
  }

  refresh() {
    const a = this.input.getStack(0);
    const b = this.input.getStack(1);
    this.xp = 0;
    if (!a && !b) { this.output.setStack(0, null); return; }
    const base = a ?? b;
    const out = base.clone();
    // Grinding strips every enchantment except curses, and returns the levels.
    if (out.tag?.enchantments) {
      for (const [id, lvl] of Object.entries(out.tag.enchantments)) {
        if (id.startsWith('curse_')) continue;
        this.xp += lvl * 2 + 1;
        delete out.tag.enchantments[id];
      }
      if (Object.keys(out.tag.enchantments).length === 0) delete out.tag.enchantments;
    }
    if (a && b && a.item === b.item && a.item.maxDamage > 0) {
      const total = (a.item.maxDamage - a.damage) + (a.item.maxDamage - b.damage) +
        Math.floor(a.item.maxDamage * 0.05);
      out.damage = Math.max(0, a.item.maxDamage - Math.min(a.item.maxDamage, total));
      out.count = 1;
    } else if (a && b) {
      this.output.setStack(0, null);
      return;
    }
    this.output.setStack(0, out);
  }

  onTake() {
    if (this.xp > 0) {
      const p = this.game.player;
      if (this.game.modules.experience?.give) this.game.modules.experience.give(p, this.xp);
      else p.xp = (p.xp ?? 0) + this.xp;
    }
    this.input.clear();
    this.xp = 0;
  }

  renderPanel(ctx, lx, ly) {
    super.renderPanel(ctx, lx, ly);
    blit(ctx, GUI.arrowEmpty, 92, 33);
  }

  onClose() {
    for (const stack of this.input.drain()) {
      if (!this.inv?.addItem(stack, { equipArmor: false })) this.dropIntoWorld(stack);
    }
    super.onClose();
  }
}

// ---------------------------------------------------------------------------
// Enchanting table
// ---------------------------------------------------------------------------

const ENCHANT_POOLS = {
  pickaxe: ['efficiency', 'unbreaking', 'fortune', 'silk_touch', 'mending'],
  axe: ['efficiency', 'unbreaking', 'fortune', 'sharpness', 'mending'],
  shovel: ['efficiency', 'unbreaking', 'fortune', 'silk_touch', 'mending'],
  hoe: ['efficiency', 'unbreaking', 'fortune', 'mending'],
  sword: ['sharpness', 'smite', 'bane_of_arthropods', 'looting', 'knockback',
    'fire_aspect', 'unbreaking', 'sweeping'],
  bow: ['power', 'punch', 'flame', 'infinity', 'unbreaking'],
  armor: ['protection', 'fire_protection', 'blast_protection', 'projectile_protection',
    'unbreaking', 'thorns', 'mending'],
  boots: ['protection', 'feather_falling', 'depth_strider', 'unbreaking', 'mending'],
  helmet: ['protection', 'respiration', 'aqua_affinity', 'unbreaking', 'mending'],
  book: ['unbreaking', 'mending', 'efficiency', 'sharpness', 'protection', 'fortune'],
};

function poolFor(stack) {
  if (!stack) return [];
  const item = stack.item;
  if (item.name === 'book') return ENCHANT_POOLS.book;
  if (item.armorSlot === 0) return ENCHANT_POOLS.helmet;
  if (item.armorSlot === 3) return ENCHANT_POOLS.boots;
  if (item.armorSlot != null) return ENCHANT_POOLS.armor;
  if (item.tool && ENCHANT_POOLS[item.tool]) return ENCHANT_POOLS[item.tool];
  if (item.name.includes('bow')) return ENCHANT_POOLS.bow;
  return [];
}

export class EnchantingScreen extends ContainerScreen {
  constructor(game, world, x, y, z) {
    super(game, { title: 'Enchant', width: 176, height: 166 });
    this.world = world;
    this.pos = { x, y, z };
    this.bookshelves = this.countBookshelves();
    this.offers = [];
    this.seed = Math.floor(Math.random() * 0x7fffffff);
  }

  build() {
    this.input = new Container(2, { title: 'Enchant', type: 'enchanting' });
    this.input.onChange(() => this.rollOffers());
    const from = this.menu.slots.length;
    this.menu.addSlot(new Slot(this.input, 0, { x: 15, y: 47, group: 'enchant' }));
    this.menu.addSlot(new Slot(this.input, 1, {
      x: 35, y: 47, group: 'lapis',
      filter: (s) => s.item.name === 'lapis_lazuli',
    }));
    this.menu.section('enchant', from, this.menu.slots.length);
    this.addPlayerSlots(84, 142);
  }

  countBookshelves() {
    const w = this.world;
    if (!w || !this.pos) return 0;
    let n = 0;
    const { x, y, z } = this.pos;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;
        for (let dy = 0; dy <= 1; dy++) {
          const def = blockOf(w.getBlock(x + dx, y + dy, z + dz));
          if (def?.name === 'bookshelf') n++;
        }
      }
    }
    return Math.min(15, n);
  }

  rollOffers() {
    const stack = this.input.getStack(0);
    this.offers = [];
    if (!stack || (stack.enchanted && stack.item.name !== 'book')) return;

    const mod = this.game.modules.enchanting;
    if (mod?.rollOffers) {
      try {
        this.offers = mod.rollOffers(stack, this.bookshelves, this.world?.random) ?? [];
        return;
      } catch (e) { console.warn('[ui] enchant offers failed:', e.message); }
    }
    const pool = poolFor(stack);
    if (pool.length === 0) return;
    const rnd = (n) => (this.world?.random ? this.world.random.int(n) : Math.floor(Math.random() * n));
    for (let row = 0; row < 3; row++) {
      const base = Math.max(1, Math.floor((this.bookshelves * 2 + 3) * (row + 1) / 3));
      const id = pool[rnd(pool.length)];
      const level = Math.max(1, Math.min(5, 1 + Math.floor(base / 8) + (row > 1 ? 1 : 0)));
      this.offers.push({ cost: base, id, level });
    }
  }

  layout() {
    const o = this.origin;
    this.offerButtons = [];
    for (let i = 0; i < 3; i++) {
      const btn = this.addWidget(new Button(o.x + 60, o.y + 14 + i * 19, 108, 19, '',
        () => this.applyOffer(i)));
      btn.visible = false;
      this.offerButtons.push(btn);
    }
  }

  canAfford(offer, index) {
    const p = this.game.player;
    if (!offer) return false;
    if (p.gamemode === 1) return true;
    const lapis = this.input.getStack(1)?.count ?? 0;
    return (p.xpLevel ?? 0) >= offer.cost && lapis >= index + 1;
  }

  applyOffer(index) {
    const offer = this.offers[index];
    const stack = this.input.getStack(0);
    if (!offer || !stack || !this.canAfford(offer, index)) return;
    const p = this.game.player;
    if (p.gamemode !== 1) {
      p.xpLevel = Math.max(0, (p.xpLevel ?? 0) - offer.cost);
      const lapis = this.input.getStack(1);
      if (lapis) {
        lapis.count -= index + 1;
        if (lapis.count <= 0) this.input.setStack(1, null);
      }
    }
    const result = stack.item.name === 'book' && itemsByName.has('enchanted_book')
      ? new ItemStack('enchanted_book', 1) : stack;
    result.addEnchantment(offer.id, offer.level);
    // Modules may add extra rolls on top of the advertised one.
    this.game.modules.enchanting?.applyExtra?.(result, offer, this.world?.random);
    this.input.setStack(0, result);
    this.world?.playSound?.('enchant.use', this.pos.x + 0.5, this.pos.y + 0.5, this.pos.z + 0.5);
    this.rollOffers();
  }

  renderPanel(ctx, lx, ly) {
    super.renderPanel(ctx, lx, ly);
    // The offer rows draw their own text over the buttons.
    for (let i = 0; i < 3; i++) {
      const offer = this.offers[i];
      const btn = this.offerButtons?.[i];
      if (btn) btn.visible = !!offer;
      if (!offer) continue;
      const y = 14 + i * 19;
      blit(ctx, GUI.enchantLevel, 62, y + 2, 16, 16);
      const ok = this.canAfford(offer, i);
      drawText(ctx, String(offer.cost), 70, y + 6, ok ? 0x80ff20 : 0xff6060,
        { align: 'center' });
      drawText(ctx, `${offer.id.replace(/_/g, ' ')} ${'I'.repeat(Math.min(offer.level, 5))}`,
        82, y + 6, ok ? 0xdcd0a0 : 0x807050);
    }
    if (this.offers.length === 0) {
      drawText(ctx, `Bookshelves: ${this.bookshelves}`, 60, 34, 0x707070, { shadow: false });
    }
  }

  onClose() {
    for (const stack of this.input.drain()) {
      if (!this.inv?.addItem(stack, { equipArmor: false })) this.dropIntoWorld(stack);
    }
    super.onClose();
  }
}

// ---------------------------------------------------------------------------
// Beacon
// ---------------------------------------------------------------------------

const BEACON_EFFECTS = [
  ['speed', 'haste'],
  ['resistance', 'jump_boost'],
  ['strength'],
];

const BEACON_PAYMENT = new Set(['iron_ingot', 'gold_ingot', 'emerald', 'diamond', 'netherite_ingot']);

export class BeaconScreen extends ContainerScreen {
  constructor(game, world, x, y, z) {
    super(game, { title: 'Beacon', width: 230, height: 219, invLabel: null });
    this.world = world;
    this.pos = { x, y, z };
    this.level = this.pyramidLevel();
    this.primary = this.blockEntityData()?.primary ?? null;
    this.secondary = this.blockEntityData()?.secondary ?? null;
  }

  blockEntityData() { return this.world?.getBlockEntity?.(this.pos.x, this.pos.y, this.pos.z); }

  build() {
    this.payment = new Container(1, {
      type: 'beacon',
      filter: (_i, s) => BEACON_PAYMENT.has(s.item.name),
    });
    const from = this.menu.slots.length;
    this.menu.addSlot(new Slot(this.payment, 0, { x: 136, y: 110, group: 'beacon' }));
    this.menu.section('beacon', from, this.menu.slots.length);
    this.addPlayerSlots(this.height - 82, this.height - 24);
  }

  /** How many complete layers of mineral blocks sit under the beacon. */
  pyramidLevel() {
    const w = this.world;
    if (!w) return 0;
    const { x, y, z } = this.pos;
    for (let level = 1; level <= 4; level++) {
      for (let dz = -level; dz <= level; dz++) {
        for (let dx = -level; dx <= level; dx++) {
          const def = blockOf(w.getBlock(x + dx, y - level, z + dz));
          if (!def || !/^(iron|gold|diamond|emerald|netherite)_block$/.test(def.name)) {
            return level - 1;
          }
        }
      }
    }
    return 4;
  }

  layout() {
    const o = this.origin;
    this.buttons = [];
    for (let tier = 0; tier < 3; tier++) {
      BEACON_EFFECTS[tier].forEach((id, i) => {
        const btn = this.addWidget(new Button(
          o.x + 24 + tier * 56 + i * 26, o.y + 30, 24, 24, id[0].toUpperCase(),
          () => { this.primary = id; },
          { tooltip: id.replace(/_/g, ' '), enabled: this.level > tier },
        ));
        btn.effectId = id;
        this.buttons.push(btn);
      });
    }
    this.confirm = this.addWidget(new Button(o.x + 90, o.y + 140, 50, 20, 'Done',
      () => this.apply(), { enabled: false }));
  }

  apply() {
    const stack = this.payment.getStack(0);
    if (!stack || !this.primary) return;
    stack.count--;
    if (stack.count <= 0) this.payment.setStack(0, null);
    const be = this.blockEntityData();
    if (be) { be.primary = this.primary; be.secondary = this.secondary; be.level = this.level; }
    const duration = (9 + this.level * 2) * 20;
    this.game.effects?.apply?.(this.game.player, this.primary, duration, this.level >= 4 ? 1 : 0);
    this.world?.playSound?.('beacon.power', this.pos.x + 0.5, this.pos.y + 0.5, this.pos.z + 0.5);
    this.close();
  }

  renderContent(ctx, mx, my) {
    super.renderContent(ctx, mx, my);
    const o = this.origin;
    ctx.save();
    ctx.translate(o.x, o.y);
    drawCenteredText(ctx, `Pyramid level ${this.level}`, this.width / 2, 18, 0x404040,
      { shadow: false });
    drawCenteredText(ctx, this.primary ? `Effect: ${this.primary.replace(/_/g, ' ')}` : 'Choose an effect',
      this.width / 2, 68, 0x404040, { shadow: false });
    drawCenteredText(ctx, 'Pay with an ingot, emerald or diamond',
      this.width / 2, 96, 0x707070, { shadow: false });
    ctx.restore();
    if (this.confirm) {
      this.confirm.enabled = !!this.primary && !!this.payment.getStack(0);
    }
    for (const b of this.buttons ?? []) {
      b.color = b.effectId === this.primary ? 0x80ff80 : 0xe0e0e0;
    }
  }

  onClose() {
    for (const stack of this.payment.drain()) {
      if (!this.inv?.addItem(stack, { equipArmor: false })) this.dropIntoWorld(stack);
    }
    super.onClose();
  }
}

// ---------------------------------------------------------------------------
// Stonecutter
// ---------------------------------------------------------------------------

export class StonecutterScreen extends ContainerScreen {
  constructor(game, world, x, y, z) {
    super(game, { title: 'Stonecutter', width: 176, height: 166 });
    this.world = world;
    this.choice = 0;
  }

  build() {
    this.input = new Container(1, { type: 'stonecutter' });
    this.output = new Container(1, { type: 'result' });
    this.results = [];
    this.input.onChange(() => this.refresh());

    const from = this.menu.slots.length;
    this.menu.addSlot(new Slot(this.input, 0, { x: 20, y: 33, group: 'stonecutter' }));
    this.menu.addSlot(new Slot(this.output, 0, {
      x: 143, y: 33, group: 'result', output: true, onTake: () => this.onTake(),
    }));
    this.menu.section('stonecutter', from, this.menu.slots.length);
    this.addPlayerSlots(84, 142);
  }

  layout() {
    const o = this.origin;
    this.list = this.addWidget(new ScrollPanel(o.x + 52, o.y + 14, 72, 54, { rowHeight: 18 }));
  }

  /** Ask the recipe module what this block can be cut into. */
  refresh() {
    const stack = this.input.getStack(0);
    this.results = [];
    this.choice = 0;
    if (stack) {
      const r = this.game.modules.recipes;
      try {
        const list = r?.stonecuttingFor?.(stack) ?? r?.findStonecutting?.(stack) ?? [];
        this.results = list.map((e) => (e instanceof ItemStack ? e : e.result)).filter(Boolean);
      } catch (e) { console.warn('[ui] stonecutting lookup failed:', e.message); }
    }
    if (this.list) this.list.contentHeight = Math.ceil(this.results.length / 4) * 18;
    this.updateOutput();
  }

  updateOutput() {
    const pick = this.results[this.choice];
    this.output.setStack(0, pick ? pick.clone() : null);
  }

  onTake() {
    const stack = this.input.getStack(0);
    if (!stack) return;
    stack.count--;
    if (stack.count <= 0) this.input.setStack(0, null);
    this.input.changed();
    this.world?.playSound?.('ui.stonecutter', this.game.player.x, this.game.player.y,
      this.game.player.z, 0.4);
  }

  mouseDown(mx, my, button) {
    if (this.list && this.list.contains(mx, my) && this.results.length) {
      const p = this.list.toContent(mx, my);
      const col = Math.floor(p.x / 18), row = Math.floor(p.y / 18);
      const index = row * 4 + col;
      if (col >= 0 && col < 4 && index >= 0 && index < this.results.length) {
        this.choice = index;
        this.updateOutput();
        return true;
      }
    }
    return super.mouseDown(mx, my, button);
  }

  renderContent(ctx, mx, my) {
    super.renderContent(ctx, mx, my);
    if (!this.list) return;
    this.list.view(ctx, (c) => {
      for (let i = 0; i < this.results.length; i++) {
        const x = (i % 4) * 18, y = Math.floor(i / 4) * 18;
        slotWell(c, x, y);
        if (i === this.choice) {
          c.fillStyle = 'rgba(255,255,255,0.35)';
          c.fillRect(x + 1, y + 1, ICON, ICON);
        }
        drawStackSafe(c, this.results[i], x + 1, y + 1);
      }
    });
    this.list.renderScrollbar(ctx);
  }

  onClose() {
    for (const stack of this.input.drain()) {
      if (!this.inv?.addItem(stack, { equipArmor: false })) this.dropIntoWorld(stack);
    }
    super.onClose();
  }
}

/** drawStack is imported lazily here to keep the module graph shallow. */
function drawStackSafe(ctx, stack, x, y) {
  if (!stack) return;
  // eslint-disable-next-line no-use-before-define
  import('./screen.js').then((m) => m.drawStack(ctx, stack, x, y)).catch(() => {});
}

// ---------------------------------------------------------------------------
// Loom, smithing and cartography
// ---------------------------------------------------------------------------

/** A three-in, one-out station with a shared result pipeline. */
class TransformScreen extends ContainerScreen {
  constructor(game, opts) {
    super(game, { width: 176, height: 166, ...opts });
  }

  buildSlots(specs) {
    this.input = new Container(specs.length, { type: this.opts.type ?? 'transform' });
    this.output = new Container(1, { type: 'result' });
    this.input.onChange(() => this.refresh());
    const from = this.menu.slots.length;
    specs.forEach((spec, i) => {
      this.menu.addSlot(new Slot(this.input, i, {
        x: spec.x, y: spec.y, group: spec.group ?? 'station', filter: spec.filter ?? null,
      }));
    });
    this.menu.addSlot(new Slot(this.output, 0, {
      x: this.opts.outX, y: this.opts.outY, group: 'result', output: true,
      onTake: () => this.onTake(),
    }));
    this.menu.section('station', from, this.menu.slots.length);
    this.addPlayerSlots(84, 142);
  }

  refresh() { this.output.setStack(0, this.compute()); }

  compute() { return null; }

  /** Default: spend one of each input. */
  onTake() {
    for (let i = 0; i < this.input.size; i++) {
      const s = this.input.getStack(i);
      if (!s) continue;
      s.count--;
      if (s.count <= 0) this.input.slots[i] = null;
    }
    this.input.changed();
  }

  onClose() {
    for (const stack of this.input.drain()) {
      if (!this.inv?.addItem(stack, { equipArmor: false })) this.dropIntoWorld(stack);
    }
    super.onClose();
  }
}

const DYES = new Set(['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime',
  'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']);

const LOOM_PATTERNS = ['stripe', 'cross', 'border', 'gradient', 'bricks', 'creeper',
  'skull', 'flower', 'mojang', 'globe'];

export class LoomScreen extends TransformScreen {
  constructor(game, world, x, y, z) {
    super(game, { title: 'Loom', type: 'loom', outX: 143, outY: 58 });
    this.world = world;
  }

  build() {
    this.pattern = 0;
    this.buildSlots([
      { x: 13, y: 26, filter: (s) => s.item.name.endsWith('banner') },
      { x: 33, y: 26, filter: (s) => DYES.has(s.item.name.replace(/_dye$/, '')) },
      { x: 23, y: 45, filter: (s) => s.item.name.endsWith('banner_pattern') },
    ]);
  }

  compute() {
    const banner = this.input.getStack(0);
    const dye = this.input.getStack(1);
    if (!banner || !dye) return null;
    const out = banner.clone();
    out.count = 1;
    out.tag = out.tag ?? {};
    out.tag.patterns = [...(out.tag.patterns ?? []),
      { pattern: LOOM_PATTERNS[this.pattern] ?? 'stripe', color: dye.item.name.replace(/_dye$/, '') }];
    return out;
  }

  layout() {
    const o = this.origin;
    this.prev = this.addWidget(new Button(o.x + 60, o.y + 20, 20, 20, '<',
      () => { this.pattern = (this.pattern + LOOM_PATTERNS.length - 1) % LOOM_PATTERNS.length; this.refresh(); }));
    this.next = this.addWidget(new Button(o.x + 110, o.y + 20, 20, 20, '>',
      () => { this.pattern = (this.pattern + 1) % LOOM_PATTERNS.length; this.refresh(); }));
  }

  renderPanel(ctx, lx, ly) {
    super.renderPanel(ctx, lx, ly);
    drawCenteredText(ctx, LOOM_PATTERNS[this.pattern], 95, 45, 0x404040, { shadow: false });
  }
}

const SMITHING_UPGRADES = { diamond: 'netherite' };

export class SmithingScreen extends TransformScreen {
  constructor(game, world, x, y, z) {
    super(game, { title: 'Upgrade Gear', type: 'smithing', outX: 98, outY: 48 });
    this.world = world;
  }

  build() {
    this.buildSlots([
      { x: 8, y: 48, filter: (s) => s.item.name.includes('template') },
      { x: 26, y: 48 },
      { x: 44, y: 48 },
    ]);
  }

  compute() {
    const base = this.input.getStack(1);
    const addition = this.input.getStack(2);
    if (!base || !addition) return null;
    // Netherite upgrade: diamond gear plus an ingot becomes the netherite item.
    const material = base.item.material;
    const upgrade = SMITHING_UPGRADES[material];
    if (!upgrade || addition.item.name !== `${upgrade}_ingot`) return null;
    const targetName = base.item.name.replace(new RegExp(`^${material}_`), `${upgrade}_`);
    const target = itemsByName.get(targetName);
    if (!target) return null;
    const out = new ItemStack(target, 1, 0, base.tag ? JSON.parse(JSON.stringify(base.tag)) : null);
    out.damage = Math.min(base.damage, target.maxDamage);
    return out;
  }

  renderPanel(ctx, lx, ly) {
    super.renderPanel(ctx, lx, ly);
    blit(ctx, GUI.arrowEmpty, 66, 46);
  }
}

export class CartographyScreen extends TransformScreen {
  constructor(game, world, x, y, z) {
    super(game, { title: 'Cartography Table', type: 'cartography', outX: 145, outY: 39 });
    this.world = world;
  }

  build() {
    this.buildSlots([
      { x: 15, y: 15, filter: (s) => s.item.name.includes('map') },
      { x: 15, y: 52 },
    ]);
  }

  compute() {
    const map = this.input.getStack(0);
    const extra = this.input.getStack(1);
    if (!map || !extra) return null;
    const out = map.clone();
    out.count = 1;
    out.tag = out.tag ?? {};
    if (extra.item.name === 'paper') out.tag.scale = Math.min(4, (out.tag.scale ?? 0) + 1);
    else if (extra.item.name === 'glass_pane') out.tag.locked = true;
    else if (extra.item.name === 'map') out.count = 2;
    else return null;
    return out;
  }

  renderPanel(ctx, lx, ly) {
    super.renderPanel(ctx, lx, ly);
    blit(ctx, GUI.arrowEmpty, 100, 38);
  }
}

// ---------------------------------------------------------------------------
// Lectern and signs
// ---------------------------------------------------------------------------

export class LecternScreen extends ContainerScreen {
  constructor(game, blockEntity) {
    super(game, { title: 'Lectern', width: 192, height: 192, invLabel: null });
    this.be = blockEntity ?? null;
    this.page = 0;
  }

  build() {}

  get pages() {
    const book = this.be?.book ?? this.be?.slots?.[0] ?? null;
    const raw = book?.tag?.pages;
    if (Array.isArray(raw) && raw.length) return raw;
    return ['This book has no pages.'];
  }

  layout() {
    const o = this.origin;
    this.addWidget(new Button(o.x + 20, o.y + 160, 40, 20, '<',
      () => { this.page = Math.max(0, this.page - 1); }));
    this.addWidget(new Button(o.x + 132, o.y + 160, 40, 20, '>',
      () => { this.page = Math.min(this.pages.length - 1, this.page + 1); }));
    this.addWidget(new Button(o.x + 66, o.y + 160, 60, 20, 'Take Book',
      () => this.takeBook()));
  }

  takeBook() {
    const book = this.be?.book ?? null;
    if (book && this.inv?.addItem(book, { equipArmor: false })) this.be.book = null;
    this.close();
  }

  renderContent(ctx) {
    const o = this.origin;
    ctx.save();
    ctx.translate(o.x, o.y);
    panel(ctx, 0, 0, this.width, this.height);
    drawCenteredText(ctx, `Page ${this.page + 1} of ${this.pages.length}`,
      this.width / 2, 12, 0x404040, { shadow: false });
    const text = String(this.pages[this.page] ?? '');
    let y = 28;
    for (const line of text.split('\n')) {
      for (const wrapped of wrapLines(ctx, line, this.width - 32)) {
        drawText(ctx, wrapped, 16, y, 0x202020, { shadow: false });
        y += FONT_HEIGHT + 2;
      }
    }
    ctx.restore();
  }
}

function wrapLines(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (textWidth(ctx, test) <= maxWidth || !line) line = test;
    else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

export class SignEditScreen extends ContainerScreen {
  constructor(game, blockEntity, x, y, z) {
    super(game, { title: 'Edit Sign', width: 176, height: 130, invLabel: null, dim: true });
    this.be = blockEntity ?? null;
    this.pos = { x, y, z };
    if (this.be && !Array.isArray(this.be.lines)) this.be.lines = ['', '', '', ''];
    this.lines = this.be?.lines ?? ['', '', '', ''];
  }

  build() {}

  layout() {
    const o = this.origin;
    this.fields = [];
    for (let i = 0; i < 4; i++) {
      const field = this.addWidget(new TextField(o.x + 18, o.y + 20 + i * 16, 140, 14, {
        text: this.lines[i] ?? '',
        maxLength: 15,
        drawBox: true,
        onChange: (t) => { this.lines[i] = t; if (this.be) this.be.lines = this.lines; },
        onSubmit: () => this.focusNext(i),
      }));
      this.fields.push(field);
    }
    this.addWidget(new Button(o.x + 58, o.y + 96, 60, 20, 'Done', () => this.close()));
    this.setFocus(this.fields[0]);
  }

  focusNext(i) { this.setFocus(this.fields[(i + 1) % this.fields.length]); }

  renderContent(ctx) {
    const o = this.origin;
    ctx.save();
    ctx.translate(o.x, o.y);
    panel(ctx, 0, 0, this.width, this.height);
    drawCenteredText(ctx, 'Edit Sign', this.width / 2, 6, 0x404040, { shadow: false });
    ctx.restore();
  }

  onClose() {
    if (this.be) this.be.lines = this.lines.slice();
    super.onClose();
  }
}

// ---------------------------------------------------------------------------
// Chiselled bookshelf — no screen, it swaps books in place
// ---------------------------------------------------------------------------

/**
 * Put a book into (or take one out of) the shelf slot the player clicked.
 * Called from `game.ui.useBookshelf`.
 */
export function useChiseledBookshelf(world, x, y, z, state, player, hit) {
  const game = world?.game;
  const container = containerFor(game, world, x, y, z, 6, 'bookshelf', 'Chiseled Bookshelf');
  if (!container) return false;
  // Six compartments: two rows of three across the clicked face.
  const u = hit ? clamp01((hit.px ?? x) - x) : 0.5;
  const v = hit ? clamp01((hit.py ?? y) - y) : 0.5;
  const col = Math.min(2, Math.floor(u * 3));
  const row = v < 0.5 ? 1 : 0;
  const index = row * 3 + col;

  const held = player?.inventory?.getSelected?.();
  const inShelf = container.getStack(index);
  if (inShelf) {
    if (player?.inventory?.addItem(inShelf, { equipArmor: false })) {
      container.setStack(index, null);
    }
    world.playSound?.('bookshelf.take', x + 0.5, y + 0.5, z + 0.5);
    return true;
  }
  if (held && /book/.test(held.item.name)) {
    container.setStack(index, held.split(1));
    if (held.count <= 0) player.inventory.setSelected(null);
    world.playSound?.('bookshelf.put', x + 0.5, y + 0.5, z + 0.5);
    return true;
  }
  return false;
}

const clamp01 = (v) => Math.max(0, Math.min(0.999, v));

// ---------------------------------------------------------------------------
// Menu lookup
// ---------------------------------------------------------------------------

const MENUS = {
  crafting: CraftingScreen,
  furnace: FurnaceScreen,
  blast_furnace: BlastFurnaceScreen,
  smoker: SmokerScreen,
  brewing_stand: BrewingStandScreen,
  anvil: AnvilScreen,
  chipped_anvil: AnvilScreen,
  damaged_anvil: AnvilScreen,
  grindstone: GrindstoneScreen,
  enchanting: EnchantingScreen,
  enchanting_table: EnchantingScreen,
  beacon: BeaconScreen,
  stonecutter: StonecutterScreen,
  loom: LoomScreen,
  smithing: SmithingScreen,
  cartography: CartographyScreen,
  dispenser: DispenserScreen,
  dropper: DispenserScreen,
  hopper: HopperScreen,
};

/** Resolve a menu id to its screen class; `game.ui.openMenu` calls this first. */
export function screenFor(menu) {
  return MENUS[menu] ?? null;
}

export { drawTooltip, drawText };
export default screenFor;
