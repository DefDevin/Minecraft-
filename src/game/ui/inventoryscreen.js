// The player's inventory screen, and the base class every container screen
// shares.
//
// `ContainerScreen` owns the parts that are identical everywhere: drawing slot
// wells and their stacks, the stack riding on the cursor, hover tooltips, and
// routing mouse and key events into the `ContainerMenu` that implements the
// click protocol. Subclasses only describe where the slots are and what the
// panel looks like.

import {
  Screen, panel, slotWell, drawStack, drawText, drawTooltip, stackTooltip,
  blit, blitClipped, nineSlice, GUI, SLOT, ICON, FONT_HEIGHT,
} from './screen.js';
import {
  Container, ContainerMenu, Slot, PlayerInventory,
  HOTBAR_SIZE, INVENTORY_SIZE, ARMOR_SIZE,
} from '../inventory.js';
import { ItemStack, itemsByName } from '../items.js';

// ---------------------------------------------------------------------------
// ContainerScreen
// ---------------------------------------------------------------------------

export class ContainerScreen extends Screen {
  constructor(game, opts = {}) {
    super(game, opts);
    this.inv = game.player?.inventory ?? null;
    this.menu = new ContainerMenu({
      inventory: this.inv,
      creative: game.player?.gamemode === 1,
      onDrop: (stack) => this.dropIntoWorld(stack),
    });
    this.hoverSlot = -1;
    this.invLabel = opts.invLabel ?? 'Inventory';
    this.titleY = opts.titleY ?? 6;
    // Subclass fields are not assigned yet when `build()` runs, so anything it
    // needs is passed through the options object.
    this.opts = opts;
    this.container = opts.container ?? null;
    this.blockEntity = opts.blockEntity ?? null;
    this.build();
  }

  /** Subclasses add their slots here; call `addPlayerSlots` for the bottom half. */
  build() {}

  /** The standard three rows plus hotbar, at Minecraft's offsets. */
  addPlayerSlots(y = this.height - 82, hotbarY = this.height - 24) {
    const inv = this.inv;
    if (!inv) return;
    this.mainFrom = this.menu.slots.length;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 9; col++) {
        const i = HOTBAR_SIZE + row * 9 + col;
        this.menu.addSlot(new Slot(inv, i, {
          x: 8 + col * SLOT, y: y + row * SLOT, group: 'inv',
        }));
      }
    }
    for (let col = 0; col < 9; col++) {
      this.menu.addSlot(new Slot(inv, col, { x: 8 + col * SLOT, y: hotbarY, group: 'hotbar' }));
    }
    this.menu.section('player', this.mainFrom, this.menu.slots.length);
  }

  dropIntoWorld(stack) {
    const game = this.game;
    const p = game.player;
    if (!p || !game.world) return;
    game.spawnItem(game.world, p.eyeX, p.eyeY - 0.3, p.eyeZ, stack);
  }

  // -- Frame ---------------------------------------------------------------

  renderContent(ctx, mx, my) {
    const o = this.origin;
    const lx = mx - o.x, ly = my - o.y;
    this.hoverSlot = this.menu.slotAt(lx, ly);

    ctx.save();
    ctx.translate(o.x, o.y);
    this.renderPanel(ctx, lx, ly);
    this.renderSlots(ctx, lx, ly);
    this.renderLabels(ctx);
    ctx.restore();
  }

  renderPanel(ctx) {
    panel(ctx, 0, 0, this.width, this.height);
  }

  renderLabels(ctx) {
    if (this.title) drawText(ctx, this.title, 8, this.titleY, 0x404040, { shadow: false });
    if (this.invLabel) {
      drawText(ctx, this.invLabel, 8, this.height - 94, 0x404040, { shadow: false });
    }
  }

  renderSlots(ctx, lx, ly) {
    for (let i = 0; i < this.menu.slots.length; i++) {
      const slot = this.menu.slots[i];
      if (!slot.visible) continue;
      slotWell(ctx, slot.x - 1, slot.y - 1);
      const stack = slot.get();
      if (stack) {
        drawStack(ctx, stack, slot.x, slot.y, { count: this.displayCount(i, stack) });
      } else if (slot.background) {
        this.renderSlotBackground(ctx, slot);
      }
      if (i === this.hoverSlot && slot.enabled) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(slot.x, slot.y, ICON, ICON);
      }
    }
  }

  /** During a drag the slots under the cursor preview what they will receive. */
  displayCount(index, stack) {
    const extra = this.menu.dragCount(index);
    return extra > 0 ? stack.count + extra : stack.count;
  }

  renderSlotBackground(ctx, slot) {
    const region = GUI[slot.background];
    if (region) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      blit(ctx, region, slot.x, slot.y, ICON, ICON);
      ctx.restore();
    }
  }

  renderForeground(ctx, mx, my) {
    const o = this.origin;
    const cursor = this.menu.cursor;
    if (cursor) {
      ctx.save();
      ctx.translate(o.x, o.y);
      const lx = mx - o.x, ly = my - o.y;
      const dragging = this.menu.isDragging();
      const held = dragging ? this.remainingCursorCount() : cursor.count;
      if (held > 0) drawStack(ctx, cursor, Math.round(lx - 8), Math.round(ly - 8), { count: held });
      ctx.restore();
      return;
    }
    if (this.hoverSlot >= 0) {
      const stack = this.menu.slots[this.hoverSlot].get();
      if (stack) {
        drawTooltip(ctx, stackTooltip(stack, { advanced: this.game.showDebug }),
          mx, my, this.screenW, this.screenH);
      }
    }
  }

  /** What is left on the cursor once the pending drag is applied. */
  remainingCursorCount() {
    const cursor = this.menu.cursor;
    if (!cursor) return 0;
    let used = 0;
    for (const i of this.menu.drag?.slots ?? []) used += this.menu.dragCount(i);
    return Math.max(0, cursor.count - used);
  }

  // -- Input ---------------------------------------------------------------

  mods() {
    const input = this.game.input;
    return {
      shift: !!input?.keyDown('ShiftLeft') || !!input?.keyDown('ShiftRight'),
      creative: this.game.player?.gamemode === 1,
    };
  }

  mouseDown(mx, my, button) {
    if (super.mouseDown(mx, my, button)) return true;
    const o = this.origin;
    const index = this.menu.slotAt(mx - o.x, my - o.y);
    const inPanel = mx >= o.x && my >= o.y &&
      mx < o.x + this.width && my < o.y + this.height;
    if (index < 0 && inPanel) return false;    // clicking the panel does nothing
    this.menu.pointerDown(index, button, this.mods());
    return true;
  }

  mouseUp(mx, my, button) {
    super.mouseUp(mx, my, button);
    const o = this.origin;
    const index = this.menu.slotAt(mx - o.x, my - o.y);
    this.menu.pointerUp(index, button, this.mods());
    return true;
  }

  mouseMove(mx, my) {
    super.mouseMove(mx, my);
    const o = this.origin;
    this.menu.pointerMove(this.menu.slotAt(mx - o.x, my - o.y));
  }

  onHotbarKey(index) {
    if (this.hoverSlot >= 0) this.menu.hotbarSwap(this.hoverSlot, index);
  }

  onDropKey(all) {
    if (this.hoverSlot >= 0) this.menu.dropSlot(this.hoverSlot, all);
  }

  onClose() {
    super.onClose();
    this.menu.returnCursor();
  }
}

// ---------------------------------------------------------------------------
// Crafting
// ---------------------------------------------------------------------------

/**
 * A crafting grid and its result slot, wired to whichever recipe module is
 * loaded. Without one the grid still works — it simply never produces
 * anything, which is what the fallback screen does too.
 */
export class CraftingGrid {
  constructor(game, size = 2) {
    this.game = game;
    this.size = size;
    this.input = new Container(size * size, { title: 'Crafting', type: 'crafting' });
    this.output = new Container(1, { title: 'Result', type: 'result' });
    this.input.onChange(() => this.update());
  }

  get recipes() { return this.game?.modules?.recipes ?? null; }

  find() {
    const r = this.recipes;
    if (!r?.findCraftingResult) return null;
    if (this.input.isEmpty()) return null;
    try {
      return r.findCraftingResult(this.input.slots, this.size, this.size) ?? null;
    } catch (e) {
      console.warn('[ui] crafting lookup failed:', e.message);
      return null;
    }
  }

  update() {
    const match = this.find();
    this.output.slots[0] = match?.result ? match.result.clone() : null;
    return this.output.slots[0];
  }

  /** Called when the player takes the result: spend one of each ingredient. */
  consume() {
    const match = this.find();
    const remainder = match?.remainder ?? null;
    const slots = this.input.slots;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s || s.count <= 0) continue;
      if (remainder?.[i]) { slots[i] = remainder[i]; continue; }
      const left = s.item.craftRemainder;
      s.count--;
      if (s.count <= 0) {
        slots[i] = left && itemsByName.has(left) ? new ItemStack(left, 1) : null;
      }
    }
    this.input.changed();
  }

  /** Everything still sitting in the grid, for when the screen closes. */
  drain() { return this.input.drain(); }
}

// ---------------------------------------------------------------------------
// InventoryScreen
// ---------------------------------------------------------------------------

/** Slot backgrounds for the empty armour and offhand slots. */
const ARMOR_BACKGROUNDS = ['armorFull', 'armorFull', 'armorFull', 'armorFull'];

export class InventoryScreen extends ContainerScreen {
  constructor(game) {
    super(game, { title: 'Crafting', width: 176, height: 166, titleY: 6 });
  }

  build() {
    const inv = this.inv;
    if (!inv) return;
    this.crafting = new CraftingGrid(this.game, 2);

    // Crafting grid, top right, with the result beyond the arrow.
    const from = this.menu.slots.length;
    for (let i = 0; i < 4; i++) {
      this.menu.addSlot(new Slot(this.crafting.input, i, {
        x: 98 + (i % 2) * SLOT, y: 18 + Math.floor(i / 2) * SLOT, group: 'craft',
      }));
    }
    this.menu.addSlot(new Slot(this.crafting.output, 0, {
      x: 154, y: 28, group: 'result', output: true,
      onTake: () => {
        this.crafting.consume();
        this.game.world?.playSound?.('ui.craft', this.game.player.x,
          this.game.player.y, this.game.player.z, 0.35);
      },
    }));
    this.menu.section('craft', from, this.menu.slots.length, { priority: -1 });

    // Armour column and the offhand slot.
    const armorFrom = this.menu.slots.length;
    for (let i = 0; i < ARMOR_SIZE; i++) {
      this.menu.addSlot(new Slot(inv.armor, i, {
        x: 8, y: 8 + i * SLOT, group: 'armor', background: ARMOR_BACKGROUNDS[i],
      }));
    }
    this.menu.addSlot(new Slot(inv.offhandSlot, 0, { x: 77, y: 62, group: 'offhand' }));
    this.menu.section('equipment', armorFrom, this.menu.slots.length, { priority: -2 });

    this.addPlayerSlots(84, 142);
  }

  renderPanel(ctx, lx, ly) {
    super.renderPanel(ctx, lx, ly);
    // The recipe arrow between grid and result.
    if (!blit(ctx, GUI.arrowEmpty, 128, 29)) {
      ctx.fillStyle = '#8b8b8b';
      ctx.fillRect(128, 34, 16, 5);
    }
    // The paper doll, in its inset well.
    this.renderPlayerPreview(ctx, 26, 8, 44, 62, lx, ly);
  }

  /**
   * A small front-facing figure standing in for Minecraft's 3D player model:
   * skin-toned limbs, tinted by whatever armour is being worn.
   */
  renderPlayerPreview(ctx, x, y, w, h, lx, ly) {
    nineSlice(ctx, GUI.inset, x, y, w, h, 2);
    const inv = this.inv;
    const cx = x + w / 2;
    const top = y + 8;
    const armor = (i) => inv?.getArmor?.(i) ?? null;
    const tintOf = (stack, fallback) => {
      if (!stack) return fallback;
      const name = stack.item.name;
      if (name.startsWith('leather')) return '#8a5a3b';
      if (name.startsWith('gold')) return '#e8d06a';
      if (name.startsWith('diamond')) return '#5ae0d0';
      if (name.startsWith('netherite')) return '#4a4045';
      if (name.startsWith('chainmail')) return '#9a9a9a';
      return '#d0d0d0';
    };
    // Look toward the mouse, which is what the real screen does.
    const lean = Math.max(-2, Math.min(2, Math.round((lx - cx) / 12)));

    ctx.fillStyle = tintOf(armor(0), '#c68642');           // head
    ctx.fillRect(cx - 5 + lean, top, 10, 9);
    ctx.fillStyle = '#3b2a1c';
    ctx.fillRect(cx - 5 + lean, top, 10, 3);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - 3 + lean, top + 4, 2, 2);
    ctx.fillRect(cx + 1 + lean, top + 4, 2, 2);

    ctx.fillStyle = tintOf(armor(1), '#3a68c0');           // torso
    ctx.fillRect(cx - 5, top + 10, 10, 13);
    ctx.fillStyle = tintOf(armor(1), '#c68642');           // arms
    ctx.fillRect(cx - 8, top + 10, 3, 12);
    ctx.fillRect(cx + 5, top + 10, 3, 12);
    ctx.fillStyle = tintOf(armor(2), '#2f3b6b');           // legs
    ctx.fillRect(cx - 5, top + 23, 4, 12);
    ctx.fillRect(cx + 1, top + 23, 4, 12);
    ctx.fillStyle = tintOf(armor(3), '#4a4a4a');           // boots
    ctx.fillRect(cx - 5, top + 35, 4, 3);
    ctx.fillRect(cx + 1, top + 35, 4, 3);
  }

  renderLabels(ctx) {
    drawText(ctx, 'Crafting', 98, 8, 0x404040, { shadow: false });
    drawText(ctx, this.invLabel, 8, 72, 0x404040, { shadow: false });
  }

  onClose() {
    // Anything left in the crafting grid goes back to the player.
    for (const stack of this.crafting?.drain() ?? []) {
      if (!this.inv?.addItem(stack, { equipArmor: false })) this.dropIntoWorld(stack);
    }
    super.onClose();
  }
}

export default InventoryScreen;
