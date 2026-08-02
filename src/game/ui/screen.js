// The GUI toolkit: fonts, nine-slice panels and widgets.
//
// Every screen in the game is a `Screen` subclass drawn onto the 2D overlay in
// GUI units — the canvas is already scaled by `game.guiScaleFactor`, so one
// unit here is one Minecraft interface pixel and all coordinates are integers.
//
// Text is canvas text with a hard one-pixel shadow rather than a bitmap font:
// it keeps the Minecraft look (no anti-aliased drop shadow, colour codes, the
// same shadow rule of `colour >> 2`) while still rendering any character the
// browser has a glyph for.

import { getSheet } from '../../render/texgen.js';
import { registerGuiTextures, GUI, effectIcon } from '../../render/textures/gui.js';
import { itemIcon } from './fallbackscreens.js';
import { RARITY } from '../items.js';

export { GUI, effectIcon };

/** Slot pitch and icon size, as in the original interface. */
export const SLOT = 18;
export const ICON = 16;
export const FONT_HEIGHT = 9;

const FONT_STACK = '"Minecraft", "Minecraftia", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

// ---------------------------------------------------------------------------
// The interface sheet
// ---------------------------------------------------------------------------

let sheetCanvas;

/** The GUI sheet rasterised to a canvas, or null when there is no DOM. */
export function guiSheet() {
  if (sheetCanvas !== undefined) return sheetCanvas;
  sheetCanvas = null;
  try {
    registerGuiTextures();
    const sheet = getSheet('gui');
    if (!sheet) return null;
    const c = document.createElement('canvas');
    c.width = sheet.width;
    c.height = sheet.height;
    const ctx = c.getContext('2d');
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(sheet.data), sheet.width, sheet.height), 0, 0);
    sheetCanvas = c;
  } catch (e) {
    console.warn('[ui] gui sheet unavailable:', e.message);
    sheetCanvas = null;
  }
  return sheetCanvas;
}

/** Blit one region of the sheet, optionally stretched. */
export function blit(ctx, region, x, y, w = region.w, h = region.h) {
  const sheet = guiSheet();
  if (!sheet || w <= 0 || h <= 0) return false;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sheet, region.x, region.y, region.w, region.h, x, y, w, h);
  return true;
}

/** Blit only the left `part` of a region — used for partially filled bars. */
export function blitClipped(ctx, region, x, y, fraction, vertical = false) {
  const f = Math.max(0, Math.min(1, fraction));
  if (f <= 0) return;
  if (vertical) {
    const h = Math.ceil(region.h * f);
    blit(ctx, { x: region.x, y: region.y + region.h - h, w: region.w, h }, x, y + region.h - h);
  } else {
    const w = Math.ceil(region.w * f);
    blit(ctx, { x: region.x, y: region.y, w, h: region.h }, x, y);
  }
}

/**
 * Nine-slice a region to any size: the corners stay put, the edges stretch
 * along one axis and the middle stretches both ways.
 */
export function nineSlice(ctx, region, x, y, w, h, corner = region.corner ?? 8) {
  const sheet = guiSheet();
  if (!sheet) return false;
  const c = Math.min(corner, Math.floor(w / 2), Math.floor(h / 2), Math.floor(region.w / 2));
  const { x: sx, y: sy, w: sw, h: sh } = region;
  const mw = sw - c * 2, mh = sh - c * 2;         // source middle
  const dw = w - c * 2, dh = h - c * 2;           // destination middle
  ctx.imageSmoothingEnabled = false;
  const put = (a, b, cw, ch, dx, dy, ddw, ddh) => {
    if (ddw <= 0 || ddh <= 0 || cw <= 0 || ch <= 0) return;
    ctx.drawImage(sheet, a, b, cw, ch, dx, dy, ddw, ddh);
  };
  put(sx, sy, c, c, x, y, c, c);
  put(sx + sw - c, sy, c, c, x + w - c, y, c, c);
  put(sx, sy + sh - c, c, c, x, y + h - c, c, c);
  put(sx + sw - c, sy + sh - c, c, c, x + w - c, y + h - c, c, c);
  put(sx + c, sy, mw, c, x + c, y, dw, c);
  put(sx + c, sy + sh - c, mw, c, x + c, y + h - c, dw, c);
  put(sx, sy + c, c, mh, x, y + c, c, dh);
  put(sx + sw - c, sy + c, c, mh, x + w - c, y + c, c, dh);
  put(sx + c, sy + c, mw, mh, x + c, y + c, dw, dh);
  return true;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/** The classic bevelled interface panel. */
export function panel(ctx, x, y, w, h) {
  if (nineSlice(ctx, GUI.panel, x, y, w, h)) return;
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

/** A dark translucent panel, for HUD-adjacent overlays. */
export function darkPanel(ctx, x, y, w, h) {
  if (nineSlice(ctx, GUI.darkPanel, x, y, w, h)) return;
  ctx.fillStyle = 'rgba(16,16,16,0.86)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/** An inset well the size of one slot; `x,y` is the well, icons sit at +1. */
export function slotWell(ctx, x, y, size = SLOT) {
  if (nineSlice(ctx, GUI.inset, x, y, size, size, 2)) return;
  ctx.fillStyle = '#8b8b8b';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#373737';
  ctx.fillRect(x, y, size, 1);
  ctx.fillRect(x, y, 1, size);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y + size - 1, size, 1);
  ctx.fillRect(x + size - 1, y, 1, size);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export const COLORS = {
  0: 0x000000, 1: 0x0000aa, 2: 0x00aa00, 3: 0x00aaaa,
  4: 0xaa0000, 5: 0xaa00aa, 6: 0xffaa00, 7: 0xaaaaaa,
  8: 0x555555, 9: 0x5555ff, a: 0x55ff55, b: 0x55ffff,
  c: 0xff5555, d: 0xff55ff, e: 0xffff55, f: 0xffffff,
};

export const RARITY_COLOR = [0xffffff, 0xffff55, 0x55ffff, 0xff55ff];

export function hex(color) {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Minecraft's shadow rule: a quarter of the colour, rounded down per channel. */
export function shadowColor(color) { return (color & 0xfcfcfc) >> 2; }

export function setFont(ctx, size = 8, bold = false) {
  ctx.font = `${bold ? 'bold ' : ''}${size}px ${FONT_STACK}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.imageSmoothingEnabled = false;
}

/** Split a string on `§x` colour codes into runs. */
function runs(text, color) {
  const out = [];
  let cur = color;
  let buf = '';
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '§' && i + 1 < s.length) {
      const c = COLORS[s[i + 1].toLowerCase()];
      if (c !== undefined) {
        if (buf) out.push({ text: buf, color: cur });
        buf = '';
        cur = c;
        i++;
        continue;
      }
    }
    buf += s[i];
  }
  if (buf) out.push({ text: buf, color: cur });
  return out;
}

/** Width of `text` in GUI units, ignoring colour codes. */
export function textWidth(ctx, text, size = 8) {
  setFont(ctx, size);
  let w = 0;
  for (const r of runs(text, 0)) w += ctx.measureText(r.text).width;
  return w;
}

/**
 * Draw a line of text with a hard one-pixel shadow.
 * @param {object} opts {shadow, align: 'left'|'center'|'right', size, alpha, bold}
 */
export function drawText(ctx, text, x, y, color = 0xffffff, opts = {}) {
  const size = opts.size ?? 8;
  setFont(ctx, size, opts.bold);
  const parts = runs(text, color);
  let total = 0;
  for (const r of parts) total += ctx.measureText(r.text).width;
  let cx = x;
  if (opts.align === 'center') cx = Math.round(x - total / 2);
  else if (opts.align === 'right') cx = Math.round(x - total);
  const alpha = opts.alpha ?? 1;
  if (alpha <= 0) return total;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = prevAlpha * alpha;
  for (const r of parts) {
    if (opts.shadow !== false) {
      ctx.fillStyle = hex(shadowColor(r.color));
      ctx.fillText(r.text, cx + 1, y + 1);
    }
    ctx.fillStyle = hex(r.color);
    ctx.fillText(r.text, cx, y);
    cx += ctx.measureText(r.text).width;
  }
  ctx.globalAlpha = prevAlpha;
  return total;
}

export function drawCenteredText(ctx, text, cx, y, color, opts = {}) {
  return drawText(ctx, text, cx, y, color, { ...opts, align: 'center' });
}

/** Break `text` into lines no wider than `maxWidth`. */
export function wrapText(ctx, text, maxWidth, size = 8) {
  setFont(ctx, size);
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth || !line) line = test;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------------
// Item stacks
// ---------------------------------------------------------------------------

/** Draw an item icon, its count and its durability bar at `x,y` (16x16). */
export function drawStack(ctx, stack, x, y, opts = {}) {
  if (!stack || stack.count <= 0) return;
  const icon = itemIcon(stack);
  if (icon) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(icon, x, y, ICON, ICON);
  } else {
    ctx.fillStyle = '#b060c0';
    ctx.fillRect(x + 2, y + 2, 12, 12);
  }
  if (stack.enchanted) {
    // A faint violet wash stands in for the animated glint.
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#8a4cff';
    ctx.fillRect(x, y, ICON, ICON);
    ctx.restore();
  }
  const count = opts.count ?? stack.count;
  if (count > 1 || opts.forceCount) {
    drawText(ctx, String(count), x + ICON + 1, y + ICON - 8, 0xffffff, { align: 'right' });
  }
  if (opts.label) {
    drawText(ctx, opts.label, x + ICON + 1, y + ICON - 8, opts.labelColor ?? 0xffff55,
      { align: 'right' });
  }
  if (stack.item.maxDamage > 0 && stack.damage > 0) {
    const frac = Math.max(0, 1 - stack.damage / stack.item.maxDamage);
    ctx.fillStyle = '#000000';
    ctx.fillRect(x + 2, y + 13, 13, 2);
    ctx.fillStyle = `hsl(${Math.round(frac * 110)}, 90%, 45%)`;
    ctx.fillRect(x + 2, y + 13, Math.max(1, Math.round(13 * frac)), 1);
  }
  if (opts.cooldown > 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(x, y + ICON - Math.round(ICON * opts.cooldown), ICON,
      Math.round(ICON * opts.cooldown));
  }
}

/** The lines a tooltip shows for a stack. */
export function stackTooltip(stack, opts = {}) {
  const lines = [{ text: stack.displayName, color: RARITY_COLOR[stack.item.rarity] ?? 0xffffff }];
  if (stack.enchanted) {
    for (const [id, lvl] of Object.entries(stack.tag.enchantments)) {
      lines.push({ text: `${titleCase(id)} ${roman(lvl)}`, color: 0xaaaaaa });
    }
  }
  if (stack.item.tooltip) {
    for (const t of [].concat(stack.item.tooltip)) lines.push({ text: t, color: 0x9a9a9a });
  }
  if (stack.item.maxDamage > 0 && stack.damage > 0) {
    lines.push({
      text: `Durability: ${stack.item.maxDamage - stack.damage} / ${stack.item.maxDamage}`,
      color: 0xaaaaaa,
    });
  }
  if (opts.advanced) {
    lines.push({ text: stack.item.name, color: 0x555555 });
  }
  return lines;
}

function titleCase(s) {
  return String(s).split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function roman(n) {
  const table = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  return table[n] ?? String(n);
}

/** Draw a tooltip box, kept inside the screen. */
export function drawTooltip(ctx, lines, mx, my, screenW, screenH) {
  const rows = lines.map((l) => (typeof l === 'string' ? { text: l, color: 0xffffff } : l));
  if (rows.length === 0) return;
  let w = 0;
  for (const r of rows) w = Math.max(w, textWidth(ctx, r.text));
  w = Math.ceil(w) + 8;
  const h = rows.length * (FONT_HEIGHT + 1) + 7;
  let x = Math.round(mx) + 10;
  let y = Math.round(my) - 8;
  if (x + w > screenW) x = Math.max(2, screenW - w - 2);
  if (y + h > screenH) y = Math.max(2, screenH - h - 2);
  if (y < 2) y = 2;
  if (!nineSlice(ctx, GUI.tooltip, x, y, w, h)) {
    ctx.fillStyle = 'rgba(16,0,16,0.94)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(80,0,180,0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }
  rows.forEach((r, i) => {
    drawText(ctx, r.text, x + 4, y + 4 + i * (FONT_HEIGHT + 1), r.color ?? 0xffffff);
  });
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

export class Widget {
  constructor(x, y, w, h, opts = {}) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.visible = opts.visible !== false;
    this.enabled = opts.enabled !== false;
    this.tooltip = opts.tooltip ?? null;
    this.id = opts.id ?? null;
    this.hovered = false;
  }

  contains(mx, my) {
    return this.visible && mx >= this.x && my >= this.y &&
      mx < this.x + this.w && my < this.y + this.h;
  }

  render(_ctx, _mx, _my, _dt) {}
  mouseDown(_mx, _my, _button) { return false; }
  mouseUp(_mx, _my, _button) { return false; }
  mouseMove(_mx, _my) {}
  wheel(_dir, _mx, _my) { return false; }
  textInput(_e) { return false; }
}

export class Button extends Widget {
  constructor(x, y, w, h, label, onClick, opts = {}) {
    super(x, y, w, h, opts);
    this.label = label;
    this.onClick = onClick ?? null;
    this.color = opts.color ?? 0xe0e0e0;
    this.pressed = false;
  }

  render(ctx, mx, my) {
    if (!this.visible) return;
    this.hovered = this.contains(mx, my);
    const region = !this.enabled ? GUI.buttonDisabled
      : this.hovered ? GUI.buttonHover : GUI.button;
    if (!nineSlice(ctx, region, this.x, this.y, this.w, this.h, 4)) {
      ctx.fillStyle = !this.enabled ? '#4a4a4a' : this.hovered ? '#7d86b0' : '#6a6a6a';
      ctx.fillRect(this.x, this.y, this.w, this.h);
      ctx.strokeStyle = '#2f2f2f';
      ctx.lineWidth = 1;
      ctx.strokeRect(this.x + 0.5, this.y + 0.5, this.w - 1, this.h - 1);
    }
    const color = !this.enabled ? 0xa0a0a0 : this.hovered ? 0xffffa0 : this.color;
    drawCenteredText(ctx, this.label, this.x + this.w / 2,
      this.y + Math.floor((this.h - FONT_HEIGHT) / 2) + 1, color);
  }

  mouseDown(mx, my, button) {
    if (!this.enabled || !this.contains(mx, my) || button !== 0) return false;
    this.pressed = true;
    this.onClick?.(this);
    return true;
  }

  mouseUp() { this.pressed = false; return false; }
}

/** A button that cycles through a list of values. */
export class CycleButton extends Button {
  constructor(x, y, w, h, label, values, index, onChange, opts = {}) {
    super(x, y, w, h, '', null, opts);
    this.baseLabel = label;
    this.values = values;
    this.index = Math.max(0, index);
    this.onChange = onChange;
    this.format = opts.format ?? ((v) => String(v));
    this.sync();
  }

  sync() { this.label = `${this.baseLabel}: ${this.format(this.values[this.index])}`; }

  get value() { return this.values[this.index]; }

  mouseDown(mx, my, button) {
    if (!this.enabled || !this.contains(mx, my)) return false;
    this.index = (this.index + (button === 1 ? this.values.length - 1 : 1)) % this.values.length;
    this.sync();
    this.onChange?.(this.value, this);
    return true;
  }
}

export class Slider extends Widget {
  constructor(x, y, w, h, label, min, max, value, onChange, opts = {}) {
    super(x, y, w, h, opts);
    this.label = label;
    this.min = min;
    this.max = max;
    this.step = opts.step ?? 0;
    this.format = opts.format ?? ((v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)));
    this.onChange = onChange ?? null;
    this.dragging = false;
    this.setValue(value);
  }

  get fraction() { return (this.value - this.min) / (this.max - this.min || 1); }

  setValue(v, notify = false) {
    let x = Math.max(this.min, Math.min(this.max, v));
    if (this.step > 0) x = this.min + Math.round((x - this.min) / this.step) * this.step;
    // Kill floating-point dust so 0.1 steps show as 0.1 and not 0.30000000004.
    this.value = Math.round(x * 1e6) / 1e6;
    if (notify) this.onChange?.(this.value, this);
    return this.value;
  }

  setFromMouse(mx) {
    const t = Math.max(0, Math.min(1, (mx - this.x - 4) / Math.max(1, this.w - 8)));
    this.setValue(this.min + t * (this.max - this.min), true);
  }

  render(ctx, mx, my) {
    if (!this.visible) return;
    this.hovered = this.contains(mx, my);
    if (!nineSlice(ctx, GUI.buttonDisabled, this.x, this.y, this.w, this.h, 4)) {
      ctx.fillStyle = '#4a4a4a';
      ctx.fillRect(this.x, this.y, this.w, this.h);
    }
    const kx = Math.round(this.x + 1 + this.fraction * (this.w - 10));
    if (!nineSlice(ctx, GUI.button, kx, this.y + 1, 8, this.h - 2, 3)) {
      ctx.fillStyle = this.hovered ? '#9aa4d0' : '#8b8b8b';
      ctx.fillRect(kx, this.y + 1, 8, this.h - 2);
    }
    drawCenteredText(ctx, `${this.label}: ${this.format(this.value)}`,
      this.x + this.w / 2, this.y + Math.floor((this.h - FONT_HEIGHT) / 2) + 1,
      this.enabled ? 0xffffff : 0xa0a0a0);
  }

  mouseDown(mx, my, button) {
    if (!this.enabled || !this.contains(mx, my) || button !== 0) return false;
    this.dragging = true;
    this.setFromMouse(mx);
    return true;
  }

  mouseMove(mx) { if (this.dragging) this.setFromMouse(mx); }

  mouseUp() { this.dragging = false; return false; }

  wheel(dir, mx, my) {
    if (!this.contains(mx, my)) return false;
    const step = this.step || (this.max - this.min) / 20;
    this.setValue(this.value - dir * step, true);
    return true;
  }
}

export class Checkbox extends Widget {
  constructor(x, y, label, checked, onChange, opts = {}) {
    super(x, y, opts.w ?? 150, 12, opts);
    this.label = label;
    this.checked = !!checked;
    this.onChange = onChange ?? null;
  }

  render(ctx, mx, my) {
    if (!this.visible) return;
    this.hovered = this.contains(mx, my);
    const region = this.checked ? GUI.checkboxOn : GUI.checkbox;
    if (!blit(ctx, region, this.x, this.y)) {
      ctx.fillStyle = '#2b2b2b';
      ctx.fillRect(this.x, this.y, 12, 12);
      if (this.checked) {
        ctx.fillStyle = '#8bf05a';
        ctx.fillRect(this.x + 3, this.y + 3, 6, 6);
      }
    }
    drawText(ctx, this.label, this.x + 16, this.y + 2,
      this.hovered ? 0xffffa0 : 0xe0e0e0);
  }

  mouseDown(mx, my, button) {
    if (!this.enabled || !this.contains(mx, my) || button !== 0) return false;
    this.checked = !this.checked;
    this.onChange?.(this.checked, this);
    return true;
  }
}

export class TextField extends Widget {
  constructor(x, y, w, h, opts = {}) {
    super(x, y, w, h, opts);
    this.text = opts.text ?? '';
    this.placeholder = opts.placeholder ?? '';
    this.maxLength = opts.maxLength ?? 64;
    this.cursor = this.text.length;
    this.focused = !!opts.focused;
    this.onChange = opts.onChange ?? null;
    this.onSubmit = opts.onSubmit ?? null;
    this.filter = opts.filter ?? null;       // (char) => boolean
    this.color = opts.color ?? 0xe0e0e0;
    this.blink = 0;
    this.drawBox = opts.drawBox !== false;
  }

  setText(t, notify = true) {
    this.text = String(t).slice(0, this.maxLength);
    this.cursor = Math.min(this.cursor, this.text.length);
    if (notify) this.onChange?.(this.text, this);
  }

  render(ctx, mx, my, dt = 0) {
    if (!this.visible) return;
    this.hovered = this.contains(mx, my);
    this.blink += dt ?? 0;
    if (this.drawBox && !nineSlice(ctx, GUI.searchBox, this.x, this.y, this.w, this.h, 2)) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(this.x, this.y, this.w, this.h);
      ctx.strokeStyle = this.focused ? '#ffffff' : '#6a6a6a';
      ctx.lineWidth = 1;
      ctx.strokeRect(this.x + 0.5, this.y + 0.5, this.w - 1, this.h - 1);
    }
    const ty = this.y + Math.floor((this.h - FONT_HEIGHT) / 2) + 1;
    const shown = this.text || (this.focused ? '' : this.placeholder);
    const color = this.text ? this.color : 0x808080;
    drawText(ctx, shown, this.x + 4, ty, color);
    if (this.focused && Math.floor(this.blink * 2) % 2 === 0) {
      const cx = this.x + 4 + textWidth(ctx, this.text.slice(0, this.cursor));
      ctx.fillStyle = '#e0e0e0';
      ctx.fillRect(Math.round(cx), ty - 1, 1, FONT_HEIGHT);
    }
  }

  mouseDown(mx, my, button) {
    if (!this.enabled || button !== 0) return false;
    const inside = this.contains(mx, my);
    this.focused = inside;
    if (inside) this.blink = 0;
    return inside;
  }

  /** Handle a raw keydown while focused. Returns true when consumed. */
  textInput(e) {
    if (!this.focused) return false;
    const key = e.key;
    if (key === 'Backspace') {
      if (this.cursor > 0) {
        this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
        this.cursor--;
        this.onChange?.(this.text, this);
      }
      return true;
    }
    if (key === 'Delete') {
      this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
      this.onChange?.(this.text, this);
      return true;
    }
    if (key === 'ArrowLeft') { this.cursor = Math.max(0, this.cursor - 1); return true; }
    if (key === 'ArrowRight') { this.cursor = Math.min(this.text.length, this.cursor + 1); return true; }
    if (key === 'Home') { this.cursor = 0; return true; }
    if (key === 'End') { this.cursor = this.text.length; return true; }
    if (key === 'Enter') { this.onSubmit?.(this.text, this); return true; }
    if (key === 'Escape') { this.focused = false; return true; }
    if (key.length === 1 && !e.ctrlKey && !e.metaKey) {
      if (this.filter && !this.filter(key)) return true;
      if (this.text.length >= this.maxLength) return true;
      this.text = this.text.slice(0, this.cursor) + key + this.text.slice(this.cursor);
      this.cursor++;
      this.onChange?.(this.text, this);
      return true;
    }
    return false;
  }
}

/**
 * A clipped, scrollable viewport. The owner draws into it through
 * `panel.view(ctx, (ctx) => …)`, in content coordinates.
 */
export class ScrollPanel extends Widget {
  constructor(x, y, w, h, opts = {}) {
    super(x, y, w, h, opts);
    this.scroll = 0;
    this.contentHeight = opts.contentHeight ?? 0;
    this.rowHeight = opts.rowHeight ?? 18;
    this.barWidth = opts.barWidth ?? 6;
    this.dragging = false;
  }

  get maxScroll() { return Math.max(0, this.contentHeight - this.h); }

  setScroll(v) { this.scroll = Math.max(0, Math.min(this.maxScroll, v)); return this.scroll; }

  /** 0..1 scroll position, which is what a scrollbar drag produces. */
  setFraction(f) { return this.setScroll(f * this.maxScroll); }

  get fraction() { return this.maxScroll > 0 ? this.scroll / this.maxScroll : 0; }

  /** Run `draw` with the canvas clipped and translated to the content origin. */
  view(ctx, draw) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.x, this.y, this.w, this.h);
    ctx.clip();
    ctx.translate(this.x, this.y - Math.round(this.scroll));
    draw(ctx);
    ctx.restore();
  }

  /** Convert a screen point into content coordinates. */
  toContent(mx, my) {
    return { x: mx - this.x, y: my - this.y + Math.round(this.scroll) };
  }

  renderScrollbar(ctx) {
    if (this.maxScroll <= 0) return;
    const bx = this.x + this.w + 2;
    if (!blit(ctx, GUI.scrollTrack, bx, this.y, this.barWidth, this.h)) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx, this.y, this.barWidth, this.h);
    }
    const th = Math.max(10, Math.round(this.h * (this.h / this.contentHeight)));
    const ty = this.y + Math.round((this.h - th) * this.fraction);
    if (!blit(ctx, GUI.scrollThumb, bx, ty, this.barWidth, th)) {
      ctx.fillStyle = '#c6c6c6';
      ctx.fillRect(bx, ty, this.barWidth, th);
    }
  }

  wheel(dir, mx, my) {
    if (!this.contains(mx, my) && !this.containsBar(mx, my)) return false;
    this.setScroll(this.scroll + dir * this.rowHeight);
    return true;
  }

  containsBar(mx, my) {
    const bx = this.x + this.w + 2;
    return mx >= bx && mx < bx + this.barWidth && my >= this.y && my < this.y + this.h;
  }

  mouseDown(mx, my, button) {
    if (button !== 0 || !this.containsBar(mx, my)) return false;
    this.dragging = true;
    this.setFraction((my - this.y) / this.h);
    return true;
  }

  mouseMove(mx, my) { if (this.dragging) this.setFraction((my - this.y) / this.h); }

  mouseUp() { this.dragging = false; return false; }
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/** Splice a listener out of the input's array, which has no removal API. */
export function bindTextInput(game, handler) {
  const list = game?.input?.listeners?.text;
  if (!list) return () => {};
  list.push(handler);
  return () => {
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  };
}

/**
 * Base class for everything on the screen stack.
 *
 * The game calls `render(ctx, w, h, mouse)` every frame and forwards mouse
 * events in GUI units. Key presses are polled from `game.input` during render,
 * because the screen stack has no keyboard channel of its own.
 */
export class Screen {
  constructor(game, opts = {}) {
    this.game = game;
    this.title = opts.title ?? '';
    this.widgets = [];
    this.width = opts.width ?? 176;
    this.height = opts.height ?? 166;
    this.dimBackground = opts.dim !== false;
    this.closeOnInventoryKey = opts.closeOnInventoryKey !== false;
    this.pausesGame = !!opts.pausesGame;
    this.origin = { x: 0, y: 0 };
    this.screenW = 0;
    this.screenH = 0;
    this.mouseX = 0;
    this.mouseY = 0;
    this.focused = null;
    this.hoverTooltip = null;
    this._laidOut = false;
    this._unbindText = null;
  }

  // -- Lifecycle -----------------------------------------------------------

  onOpen() {
    this._unbindText = bindTextInput(this.game, (e) => this.onTextInput(e));
  }

  onClose() {
    this._unbindText?.();
    this._unbindText = null;
    this.setFocus(null);
  }

  close() { this.game.closeScreen(); }

  /** Build widgets. Called once, and again whenever the window resizes. */
  layout(_w, _h) {}

  addWidget(widget) { this.widgets.push(widget); return widget; }

  clearWidgets() { this.widgets.length = 0; }

  // -- Focus and typing ----------------------------------------------------

  setFocus(field) {
    for (const w of this.widgets) if (w instanceof TextField) w.focused = w === field;
    this.focused = field ?? null;
    if (this.game?.input) this.game.input.textTarget = field ?? null;
  }

  onTextInput(e) {
    if (!this.focused) return false;
    const consumed = this.focused.textInput(e);
    if (e.key === 'Escape' || (e.key === 'Enter' && this.focused.onSubmit == null)) {
      this.setFocus(null);
    }
    return consumed;
  }

  // -- Geometry ------------------------------------------------------------

  get scale() {
    return (this.game?.guiScaleFactor ?? 1) / (typeof window !== 'undefined'
      ? (window.devicePixelRatio || 1) : 1);
  }

  computeOrigin(w, h) {
    this.origin.x = Math.floor((w - this.width) / 2);
    this.origin.y = Math.floor((h - this.height) / 2);
    return this.origin;
  }

  /** Mouse position in panel-local units. */
  local(mx, my) {
    return { x: mx - this.origin.x, y: my - this.origin.y };
  }

  // -- Frame ---------------------------------------------------------------

  render(ctx, w, h, mouse) {
    if (!this._laidOut || w !== this.screenW || h !== this.screenH) {
      this.screenW = w;
      this.screenH = h;
      this.computeOrigin(w, h);
      this.clearWidgets();
      this.layout(w, h);
      this._laidOut = true;
    }
    this.computeOrigin(w, h);

    const scale = this.scale || 1;
    this.mouseX = (mouse?.x ?? 0) / scale;
    this.mouseY = (mouse?.y ?? 0) / scale;
    const dt = 1 / 60;

    this.pollKeys();
    this.hoverTooltip = null;

    ctx.save();
    this.renderBackground(ctx, w, h);
    this.renderContent(ctx, this.mouseX, this.mouseY, dt);
    for (const widget of this.widgets) {
      widget.render(ctx, this.mouseX, this.mouseY, dt);
      if (widget.tooltip && widget.contains(this.mouseX, this.mouseY)) {
        this.hoverTooltip = [].concat(widget.tooltip);
      }
    }
    this.renderForeground(ctx, this.mouseX, this.mouseY, dt);
    if (this.hoverTooltip) {
      drawTooltip(ctx, this.hoverTooltip, this.mouseX, this.mouseY, w, h);
    }
    ctx.restore();
  }

  renderBackground(ctx, w, h) {
    if (!this.dimBackground) return;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, w, h);
  }

  /** Draw the panel and its contents. Subclasses override. */
  renderContent(_ctx, _mx, _my, _dt) {}

  /** Drawn after the widgets — held stacks, tooltips, overlays. */
  renderForeground(_ctx, _mx, _my, _dt) {}

  /** Poll keys the screen stack does not forward. */
  pollKeys() {
    const input = this.game?.input;
    if (!input || this.focused) return;
    for (let n = 1; n <= 9; n++) {
      if (input.justPressed(`hotbar${n}`)) this.onHotbarKey(n - 1);
    }
    if (input.justPressed('drop')) this.onDropKey(input.keyDown('ControlLeft'));
  }

  onHotbarKey(_index) {}
  onDropKey(_all) {}

  // -- Mouse ---------------------------------------------------------------

  mouseDown(mx, my, button) {
    for (let i = this.widgets.length - 1; i >= 0; i--) {
      const w = this.widgets[i];
      if (!w.visible) continue;
      if (w.mouseDown(mx, my, button)) {
        if (w instanceof TextField) this.setFocus(w);
        else if (this.focused) this.setFocus(null);
        return true;
      }
    }
    // Clicking away from a text field gives up focus.
    if (this.focused && !this.focused.contains(mx, my)) this.setFocus(null);
    return false;
  }

  mouseUp(mx, my, button) {
    let used = false;
    for (const w of this.widgets) used = w.mouseUp(mx, my, button) || used;
    return used;
  }

  mouseMove(mx, my) {
    this.mouseX = mx;
    this.mouseY = my;
    for (const w of this.widgets) w.mouseMove(mx, my);
  }

  wheel(dir) {
    for (let i = this.widgets.length - 1; i >= 0; i--) {
      if (this.widgets[i].wheel(dir, this.mouseX, this.mouseY)) return true;
    }
    return false;
  }
}

export { itemIcon };
export default Screen;
