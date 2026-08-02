// A self-contained inventory and crafting screen.
//
// The full GUI toolkit lives elsewhere; this is the guaranteed-available
// version, drawn straight onto the 2D overlay with no dependencies beyond the
// item registry and the recipe lookup. It implements the parts of Minecraft's
// slot protocol people actually use: pick up, place one, place all, split a
// stack, shift-click to move between containers, and a working crafting grid.

import { ItemStack, itemsByName } from '../items.js';
import { texturePixels, layerOf } from '../../render/texgen.js';
import { blocksByName } from '../../world/blocks.js';

const SLOT = 18;      // slot pitch in GUI units
const PAD = 1;

/** Cached per-item canvases so icons are rasterised once. */
const iconCache = new Map();

/**
 * Rasterise an item icon. Block items get a cheap isometric composite of their
 * top and two side textures, which is how Minecraft's block icons read.
 */
export function itemIcon(stack) {
  if (!stack || stack.empty) return null;
  const key = stack.item.name;
  let c = iconCache.get(key);
  if (c !== undefined) return c;

  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const blockName = stack.item.block;
  if (blockName && blocksByName.has(blockName)) {
    drawBlockIcon(ctx, blocksByName.get(blockName), size);
  } else {
    const px = texturePixels(layerOf(stack.item.texture || stack.item.name));
    if (px) putPixels(ctx, px, 0, 0);
  }
  iconCache.set(key, canvas);
  return canvas;
}

function putPixels(ctx, px, ox, oy) {
  const img = new ImageData(new Uint8ClampedArray(px.data), px.size, px.size);
  ctx.putImageData(img, ox, oy);
}

/**
 * Draw a block as a 2:1 isometric cube: the top face as a diamond, the two
 * visible side faces as sheared parallelograms, each shaded like the 3D view.
 */
function drawBlockIcon(ctx, def, size) {
  const model = def.modelFor(def.defaultState);
  const faces = model?.[0]?.faces;
  if (!faces) return;
  const topPx = texturePixels(layerOf(faces[3]?.texture ?? def.name));
  const leftPx = texturePixels(layerOf(faces[4]?.texture ?? faces[3]?.texture ?? def.name));
  const rightPx = texturePixels(layerOf(faces[1]?.texture ?? faces[3]?.texture ?? def.name));
  if (!topPx) return;

  const src = document.createElement('canvas');
  src.width = 16; src.height = 16;
  const sctx = src.getContext('2d');

  const paint = (px, transform, shade) => {
    if (!px) return;
    sctx.clearRect(0, 0, 16, 16);
    putPixels(sctx, px, 0, 0);
    ctx.save();
    ctx.setTransform(...transform);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0);
    ctx.restore();
    if (shade > 0) {
      ctx.save();
      ctx.setTransform(...transform);
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = `rgba(0,0,0,${shade})`;
      ctx.fillRect(0, 0, 16, 16);
      ctx.restore();
    }
  };

  const s = size / 16;
  // Top face: a diamond formed by shearing in both axes.
  paint(topPx, [0.5 * s, 0.25 * s, -0.5 * s, 0.25 * s, 8 * s, 0.5 * s], 0);
  // Left face: sheared down-right.
  paint(leftPx, [0.5 * s, 0.25 * s, 0, 0.75 * s, 0 * s, 4.5 * s], 0.22);
  // Right face: sheared down-left.
  paint(rightPx, [0.5 * s, -0.25 * s, 0, 0.75 * s, 8 * s, 8.5 * s], 0.38);
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/** Minecraft's bevelled panel: light top/left, dark bottom/right. */
export function panel(ctx, x, y, w, h) {
  ctx.fillStyle = '#c6c6c6';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, w, 2);
  ctx.fillRect(x, y, 2, h);
  ctx.fillStyle = '#555555';
  ctx.fillRect(x, y + h - 2, w, 2);
  ctx.fillRect(x + w - 2, y, 2, h);
  ctx.fillStyle = '#8b8b8b';
  ctx.fillRect(x + w - 2, y, 2, 2);
  ctx.fillRect(x, y + h - 2, 2, 2);
}

/** An inset slot well. */
export function slotWell(ctx, x, y) {
  ctx.fillStyle = '#8b8b8b';
  ctx.fillRect(x, y, SLOT - PAD, SLOT - PAD);
  ctx.fillStyle = '#373737';
  ctx.fillRect(x, y, SLOT - PAD, 1);
  ctx.fillRect(x, y, 1, SLOT - PAD);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y + SLOT - PAD - 1, SLOT - PAD, 1);
  ctx.fillRect(x + SLOT - PAD - 1, y, 1, SLOT - PAD);
}

export function drawStack(ctx, stack, x, y) {
  if (!stack || stack.empty) return;
  const icon = itemIcon(stack);
  if (icon) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(icon, x, y, 16, 16);
  }
  if (stack.count > 1) {
    ctx.font = 'bold 8px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#3f3f3f';
    ctx.fillText(String(stack.count), x + 17, y + 16);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(stack.count), x + 16, y + 15);
    ctx.textAlign = 'left';
  }
  if (stack.item.maxDamage > 0 && stack.damage > 0) {
    const frac = 1 - stack.damage / stack.item.maxDamage;
    ctx.fillStyle = '#000000';
    ctx.fillRect(x + 2, y + 13, 13, 2);
    // Green at full durability shifting to red as it wears out.
    ctx.fillStyle = `hsl(${Math.round(frac * 110)}, 90%, 45%)`;
    ctx.fillRect(x + 2, y + 13, Math.max(1, Math.round(13 * frac)), 1);
  }
}

// ---------------------------------------------------------------------------
// Slot model
// ---------------------------------------------------------------------------

/**
 * A slot binds a screen position to a place items live. `get`/`set` keep the
 * screen decoupled from whichever container backs it.
 */
class Slot {
  constructor(x, y, get, set, opts = {}) {
    this.x = x; this.y = y;
    this.get = get; this.set = set;
    this.output = !!opts.output;      // crafting result: take only
    this.onTake = opts.onTake || null;
    this.group = opts.group || 'main';
  }
  contains(mx, my) {
    return mx >= this.x && my >= this.y && mx < this.x + 16 && my < this.y + 16;
  }
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

export class FallbackInventoryScreen {
  /**
   * @param {Game} game
   * @param {number} gridSize 2 for the player's inventory, 3 for a crafting table
   */
  constructor(game, gridSize = 2) {
    this.game = game;
    this.gridSize = gridSize;
    this.title = gridSize === 3 ? 'Crafting' : 'Inventory';
    this.grid = new Array(gridSize * gridSize).fill(null);
    this.cursor = null;          // stack held by the mouse
    this.slots = [];
    this.width = 176;
    this.height = gridSize === 3 ? 166 : 166;
    this.hover = null;
    this.build();
  }

  get inv() { return this.game.player.inventory; }

  build() {
    const ox = 0, oy = 0;
    const inv = this.inv;
    this.slots.length = 0;

    // Main inventory: 3 rows of 9, then the hotbar.
    const mainY = this.height - 82;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 9; col++) {
        const i = 9 + row * 9 + col;
        this.slots.push(new Slot(8 + col * SLOT, mainY + row * SLOT,
          () => inv.slots[i], (s) => { inv.slots[i] = s; }, { group: 'inv' }));
      }
    }
    for (let col = 0; col < 9; col++) {
      const i = col;
      this.slots.push(new Slot(8 + col * SLOT, this.height - 24,
        () => inv.slots[i], (s) => { inv.slots[i] = s; }, { group: 'hotbar' }));
    }

    // Crafting grid and result.
    const g = this.gridSize;
    const gx = g === 3 ? 30 : 88;
    const gy = g === 3 ? 17 : 26;
    for (let row = 0; row < g; row++) {
      for (let col = 0; col < g; col++) {
        const i = row * g + col;
        this.slots.push(new Slot(gx + col * SLOT, gy + row * SLOT,
          () => this.grid[i], (s) => { this.grid[i] = s; }, { group: 'craft' }));
      }
    }
    this.resultSlot = new Slot(gx + g * SLOT + 26, gy + (g - 1) * SLOT / 2,
      () => this.craftResult(), () => {}, { output: true, group: 'result' });
    this.slots.push(this.resultSlot);

    // Armour column, if the inventory exposes one.
    if (inv.armorSlots) {
      for (let i = 0; i < 4; i++) {
        this.slots.push(new Slot(8, 8 + i * SLOT,
          () => inv.armorSlots[i], (s) => { inv.armorSlots[i] = s; },
          { group: 'armor' }));
      }
    }
  }

  craftResult() {
    const recipes = this.game.modules.recipes;
    if (!recipes?.findCraftingResult) return null;
    if (this.grid.every((s) => !s || s.empty)) return null;
    try {
      const r = recipes.findCraftingResult(this.grid, this.gridSize, this.gridSize);
      return r?.result ?? null;
    } catch (e) {
      console.warn('crafting lookup failed', e);
      return null;
    }
  }

  /** Consume one of each ingredient after a craft. */
  consumeGrid() {
    const recipes = this.game.modules.recipes;
    let remainder = null;
    try {
      remainder = recipes?.findCraftingResult?.(this.grid, this.gridSize, this.gridSize)?.remainder;
    } catch { /* fall through to the plain decrement */ }
    for (let i = 0; i < this.grid.length; i++) {
      const s = this.grid[i];
      if (!s || s.empty) continue;
      const left = remainder?.[i];
      if (left) { this.grid[i] = left; continue; }
      // Buckets and bottles leave their empty container behind.
      const rem = s.item.craftRemainder;
      s.count--;
      if (s.count <= 0) {
        this.grid[i] = rem && itemsByName.has(rem) ? new ItemStack(rem, 1) : null;
      }
    }
  }

  // -- Layout ---------------------------------------------------------------

  origin(w, h) {
    return { x: Math.floor((w - this.width) / 2), y: Math.floor((h - this.height) / 2) };
  }

  render(ctx, w, h, mouse) {
    const o = this.origin(w, h);
    const scale = this.game.guiScaleFactor / (window.devicePixelRatio || 1);
    const mx = mouse.x / scale - o.x;
    const my = mouse.y / scale - o.y;
    this.lastOrigin = o;

    // Dim the world behind the panel.
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(o.x, o.y);
    panel(ctx, 0, 0, this.width, this.height);

    ctx.fillStyle = '#3f3f3f';
    ctx.font = '8px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(this.title, 8, this.gridSize === 3 ? 6 : 6);
    ctx.fillText('Inventory', 8, this.height - 94);

    this.hover = null;
    for (const s of this.slots) {
      slotWell(ctx, s.x - 1, s.y - 1);
      const stack = s.get();
      if (stack && !stack.empty) drawStack(ctx, stack, s.x, s.y);
      if (s.contains(mx, my)) {
        this.hover = s;
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(s.x, s.y, 16, 16);
      }
    }

    // The arrow between the grid and the result.
    const g = this.gridSize;
    const gx = g === 3 ? 30 : 88;
    const gy = g === 3 ? 17 : 26;
    const ay = gy + (g - 1) * SLOT / 2 + 8;
    ctx.fillStyle = '#8b8b8b';
    ctx.fillRect(gx + g * SLOT + 4, ay - 1, 14, 3);
    ctx.beginPath();
    ctx.moveTo(gx + g * SLOT + 18, ay - 5);
    ctx.lineTo(gx + g * SLOT + 24, ay + 0.5);
    ctx.lineTo(gx + g * SLOT + 18, ay + 6);
    ctx.closePath();
    ctx.fill();

    if (this.cursor && !this.cursor.empty) {
      drawStack(ctx, this.cursor, mx - 8, my - 8);
    } else if (this.hover) {
      const stack = this.hover.get();
      if (stack && !stack.empty) this.tooltip(ctx, stack, mx, my);
    }
    ctx.restore();
  }

  tooltip(ctx, stack, mx, my) {
    const lines = [stack.displayName];
    if (stack.enchanted) {
      for (const [id, lvl] of Object.entries(stack.tag.enchantments)) {
        lines.push(`  ${id.replace(/_/g, ' ')} ${'I'.repeat(Math.min(lvl, 5))}`);
      }
    }
    if (stack.item.maxDamage > 0) {
      lines.push(`Durability: ${stack.item.maxDamage - stack.damage} / ${stack.item.maxDamage}`);
    }
    ctx.font = '8px ui-monospace, Menlo, Consolas, monospace';
    const wpx = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 8;
    const hpx = lines.length * 10 + 6;
    const tx = mx + 10, ty = my - 4;
    ctx.fillStyle = 'rgba(16,0,16,0.94)';
    ctx.fillRect(tx, ty, wpx, hpx);
    ctx.strokeStyle = 'rgba(80,0,180,0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(tx + 0.5, ty + 0.5, wpx - 1, hpx - 1);
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? '#ffffff' : '#a0a0c0';
      ctx.fillText(l, tx + 4, ty + 4 + i * 10);
    });
  }

  // -- Interaction ----------------------------------------------------------

  mouseDown(mx, my, button) {
    const o = this.lastOrigin || { x: 0, y: 0 };
    const x = mx - o.x, y = my - o.y;
    const slot = this.slots.find((s) => s.contains(x, y));
    if (!slot) {
      // Clicking outside the panel throws the held stack into the world.
      if (this.cursor && !this.cursor.empty) {
        this.game.spawnItem(this.game.world,
          this.game.player.eyeX, this.game.player.eyeY, this.game.player.eyeZ, this.cursor);
        this.cursor = null;
      }
      return;
    }
    if (this.game.input.down('sneak')) { this.quickMove(slot); return; }
    if (slot.output) { this.takeResult(button); return; }
    this.clickSlot(slot, button);
  }

  clickSlot(slot, button) {
    const held = slot.get();
    if (!this.cursor || this.cursor.empty) {
      if (!held || held.empty) return;
      if (button === 1) {
        // Right click picks up half, rounded up.
        const half = Math.ceil(held.count / 2);
        this.cursor = held.split(half);
        if (held.count <= 0) slot.set(null);
      } else {
        this.cursor = held;
        slot.set(null);
      }
      return;
    }
    if (!held || held.empty) {
      if (button === 1) {
        slot.set(this.cursor.split(1));
        if (this.cursor.count <= 0) this.cursor = null;
      } else {
        slot.set(this.cursor);
        this.cursor = null;
      }
      return;
    }
    if (held.matches(this.cursor)) {
      const room = held.maxStack - held.count;
      const move = button === 1 ? Math.min(1, room) : Math.min(this.cursor.count, room);
      held.count += move;
      this.cursor.count -= move;
      if (this.cursor.count <= 0) this.cursor = null;
      return;
    }
    // Different items: swap.
    slot.set(this.cursor);
    this.cursor = held;
  }

  takeResult(button) {
    const result = this.craftResult();
    if (!result) return;
    // Shift-click crafts as many as fit; a plain click crafts one.
    const times = this.game.input.down('sneak') ? 64 : 1;
    for (let n = 0; n < times; n++) {
      const r = this.craftResult();
      if (!r) break;
      if (this.cursor && !this.cursor.empty) {
        if (!this.cursor.matches(r) ||
          this.cursor.count + r.count > this.cursor.maxStack) break;
        this.cursor.count += r.count;
      } else if (times > 1) {
        if (!this.inv.addItem(r.clone())) break;
      } else {
        this.cursor = r.clone();
      }
      this.consumeGrid();
      this.game.world.playSound('ui.craft', this.game.player.x, this.game.player.y,
        this.game.player.z, 0.4);
    }
  }

  /** Shift-click: move between the hotbar, the main grid and the craft grid. */
  quickMove(slot) {
    const stack = slot.get();
    if (!stack || stack.empty) return;
    if (slot.output) { this.takeResult(0); return; }
    const inv = this.inv;
    const targetRange = slot.group === 'hotbar' ? [9, 36]
      : slot.group === 'inv' ? [0, 9]
        : [0, 36];
    if (this.mergeInto(stack, targetRange[0], targetRange[1])) {
      if (stack.count <= 0) slot.set(null);
      return;
    }
    // Fall back to anywhere in the inventory.
    if (slot.group === 'craft' || slot.group === 'armor' || slot.group === 'result') {
      if (inv.addItem(stack) && stack.count <= 0) slot.set(null);
    }
  }

  mergeInto(stack, from, to) {
    const inv = this.inv;
    let moved = false;
    for (let i = from; i < to && stack.count > 0; i++) {
      const s = inv.slots[i];
      if (s && s.matches(stack) && s.count < s.maxStack) {
        const n = Math.min(stack.count, s.maxStack - s.count);
        s.count += n; stack.count -= n; moved = true;
      }
    }
    for (let i = from; i < to && stack.count > 0; i++) {
      if (!inv.slots[i]) {
        inv.slots[i] = stack.split(stack.count);
        moved = true;
      }
    }
    return moved;
  }

  mouseUp() {}
  mouseMove() {}
  wheel() {}

  onClose() {
    // Anything left in the grid or on the cursor goes back to the player.
    const give = (s) => {
      if (!s || s.empty) return;
      if (!this.inv.addItem(s)) {
        this.game.spawnItem(this.game.world, this.game.player.eyeX,
          this.game.player.eyeY, this.game.player.eyeZ, s);
      }
    };
    for (let i = 0; i < this.grid.length; i++) { give(this.grid[i]); this.grid[i] = null; }
    give(this.cursor);
    this.cursor = null;
  }
}

/** A simple chest/container screen backed by any object with a `slots` array. */
export class FallbackContainerScreen extends FallbackInventoryScreen {
  constructor(game, container, title = 'Container') {
    super(game, 0);
    this.container = container;
    this.title = title;
    this.rows = Math.ceil((container.slots?.length ?? 27) / 9);
    this.height = 114 + this.rows * SLOT;
    this.buildContainer();
  }

  buildContainer() {
    const inv = this.inv;
    this.slots.length = 0;
    const c = this.container;
    for (let i = 0; i < (c.slots?.length ?? 0); i++) {
      const row = Math.floor(i / 9), col = i % 9;
      this.slots.push(new Slot(8 + col * SLOT, 18 + row * SLOT,
        () => c.slots[i], (s) => { c.slots[i] = s; }, { group: 'container' }));
    }
    const mainY = this.height - 82;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 9; col++) {
        const i = 9 + row * 9 + col;
        this.slots.push(new Slot(8 + col * SLOT, mainY + row * SLOT,
          () => inv.slots[i], (s) => { inv.slots[i] = s; }, { group: 'inv' }));
      }
    }
    for (let col = 0; col < 9; col++) {
      const i = col;
      this.slots.push(new Slot(8 + col * SLOT, this.height - 24,
        () => inv.slots[i], (s) => { inv.slots[i] = s; }, { group: 'hotbar' }));
    }
    this.resultSlot = null;
  }

  craftResult() { return null; }

  render(ctx, w, h, mouse) {
    // Reuse the parent's drawing but skip the crafting arrow.
    const o = this.origin(w, h);
    const scale = this.game.guiScaleFactor / (window.devicePixelRatio || 1);
    const mx = mouse.x / scale - o.x;
    const my = mouse.y / scale - o.y;
    this.lastOrigin = o;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(o.x, o.y);
    panel(ctx, 0, 0, this.width, this.height);
    ctx.fillStyle = '#3f3f3f';
    ctx.font = '8px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(this.title, 8, 6);
    ctx.fillText('Inventory', 8, this.height - 94);
    this.hover = null;
    for (const s of this.slots) {
      slotWell(ctx, s.x - 1, s.y - 1);
      const stack = s.get();
      if (stack && !stack.empty) drawStack(ctx, stack, s.x, s.y);
      if (s.contains(mx, my)) {
        this.hover = s;
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(s.x, s.y, 16, 16);
      }
    }
    if (this.cursor && !this.cursor.empty) drawStack(ctx, this.cursor, mx - 8, my - 8);
    else if (this.hover) {
      const stack = this.hover.get();
      if (stack && !stack.empty) this.tooltip(ctx, stack, mx, my);
    }
    ctx.restore();
  }

  onClose() {
    if (this.cursor && !this.cursor.empty) {
      if (!this.inv.addItem(this.cursor)) {
        this.game.spawnItem(this.game.world, this.game.player.eyeX,
          this.game.player.eyeY, this.game.player.eyeZ, this.cursor);
      }
      this.cursor = null;
    }
  }
}
