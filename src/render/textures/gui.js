// The interface sheet.
//
// Every widget, icon and bar the UI draws is painted here once into a single
// 256x256 RGBA sheet, which `src/game/ui/screen.js` rasterises to a canvas and
// blits from. Keeping it in one sheet means the whole interface is described by
// the region table below — screens never hard-code colours or draw shapes.
//
// Regions are laid out by hand rather than packed, so the coordinates in `GUI`
// are the contract: change a painter freely, change a rectangle and you must
// change both.

import { registerSheet } from '../texgen.js';

export const GUI_SHEET = 'gui';
export const SHEET_SIZE = 256;

/** Every blittable rectangle in the sheet: {x, y, w, h}. */
export const GUI = {
  // -- HUD chrome ----------------------------------------------------------
  hotbar: { x: 0, y: 0, w: 182, h: 22 },
  hotbarSelect: { x: 184, y: 0, w: 24, h: 24 },
  slot: { x: 210, y: 0, w: 18, h: 18 },
  slotLocked: { x: 230, y: 0, w: 18, h: 18 },

  // -- Workstation widgets -------------------------------------------------
  arrowEmpty: { x: 0, y: 26, w: 24, h: 17 },
  arrowFull: { x: 26, y: 26, w: 24, h: 17 },
  flameEmpty: { x: 52, y: 26, w: 14, h: 14 },
  flameFull: { x: 68, y: 26, w: 14, h: 14 },
  brewBubbles: { x: 84, y: 26, w: 12, h: 28 },
  brewArrow: { x: 98, y: 26, w: 9, h: 28 },
  enchantLevel: { x: 110, y: 26, w: 16, h: 16 },
  effectFrame: { x: 128, y: 26, w: 24, h: 24 },
  anvilCross: { x: 154, y: 26, w: 14, h: 14 },
  glint: { x: 170, y: 26, w: 16, h: 16 },

  // -- Buttons -------------------------------------------------------------
  button: { x: 0, y: 60, w: 200, h: 20 },
  buttonHover: { x: 0, y: 80, w: 200, h: 20 },
  buttonDisabled: { x: 0, y: 100, w: 200, h: 20 },

  // -- Bars ----------------------------------------------------------------
  xpBarEmpty: { x: 0, y: 120, w: 182, h: 5 },
  xpBarFull: { x: 0, y: 125, w: 182, h: 5 },
  bossBarEmpty: { x: 0, y: 130, w: 182, h: 5 },
  bossBarFull: { x: 0, y: 135, w: 182, h: 5 },

  // -- Small widgets -------------------------------------------------------
  crosshair: { x: 0, y: 142, w: 15, h: 15 },
  checkbox: { x: 16, y: 142, w: 12, h: 12 },
  checkboxOn: { x: 30, y: 142, w: 12, h: 12 },
  sliderKnob: { x: 44, y: 142, w: 8, h: 20 },
  scrollThumb: { x: 56, y: 142, w: 12, h: 15 },
  scrollTrack: { x: 70, y: 142, w: 12, h: 15 },
  tab: { x: 84, y: 142, w: 28, h: 32 },
  tabSelected: { x: 114, y: 142, w: 28, h: 32 },
  searchBox: { x: 144, y: 142, w: 24, h: 18 },

  // -- Nine-slice sources (8px corners) ------------------------------------
  panel: { x: 0, y: 176, w: 24, h: 24, corner: 8 },
  tooltip: { x: 24, y: 176, w: 24, h: 24, corner: 8 },
  inset: { x: 48, y: 176, w: 24, h: 24, corner: 8 },
  darkPanel: { x: 72, y: 176, w: 24, h: 24, corner: 8 },

  // -- 9x9 status icons ----------------------------------------------------
  heartBg: { x: 0, y: 204, w: 9, h: 9 },
  heart: { x: 9, y: 204, w: 9, h: 9 },
  heartHalf: { x: 18, y: 204, w: 9, h: 9 },
  heartGold: { x: 27, y: 204, w: 9, h: 9 },
  heartGoldHalf: { x: 36, y: 204, w: 9, h: 9 },
  heartPoison: { x: 45, y: 204, w: 9, h: 9 },
  heartPoisonHalf: { x: 54, y: 204, w: 9, h: 9 },
  heartWither: { x: 63, y: 204, w: 9, h: 9 },
  heartWitherHalf: { x: 72, y: 204, w: 9, h: 9 },
  armorBg: { x: 81, y: 204, w: 9, h: 9 },
  armorHalf: { x: 90, y: 204, w: 9, h: 9 },
  armorFull: { x: 99, y: 204, w: 9, h: 9 },
  foodBg: { x: 108, y: 204, w: 9, h: 9 },
  foodHalf: { x: 117, y: 204, w: 9, h: 9 },
  foodFull: { x: 126, y: 204, w: 9, h: 9 },
  bubble: { x: 135, y: 204, w: 9, h: 9 },
  bubblePop: { x: 144, y: 204, w: 9, h: 9 },
  lockIcon: { x: 153, y: 204, w: 9, h: 9 },
};

/** Potion-effect icons, 18x18, in one strip. Index into `effectIcon()`. */
export const EFFECT_ICONS = [
  'speed', 'slowness', 'haste', 'mining_fatigue', 'strength', 'instant_health',
  'jump_boost', 'regeneration', 'resistance', 'fire_resistance',
  'water_breathing', 'invisibility', 'night_vision', 'hunger', 'weakness',
  'poison', 'wither', 'absorption',
];

const EFFECT_ROW_Y = 216;

/** Region for one status effect's icon, falling back to a neutral badge. */
export function effectIcon(id) {
  let i = EFFECT_ICONS.indexOf(id);
  if (i < 0) i = EFFECT_ICONS.length;         // the generic badge at the end
  return { x: i * 18, y: EFFECT_ROW_Y, w: 18, h: 18 };
}

// ---------------------------------------------------------------------------
// Painting helpers
// ---------------------------------------------------------------------------

/** Paint a character grid. `palette` maps each character to a colour or [hex, alpha]. */
function stencil(sheet, ox, oy, rows, palette) {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const c = palette[row[x]];
      if (c === undefined) continue;
      if (Array.isArray(c)) sheet.set(ox + x, oy + y, c[0], c[1]);
      else sheet.set(ox + x, oy + y, c);
    }
  }
}

/** Minecraft's bevelled box: light top/left, dark bottom/right. */
function bevelBox(sheet, x, y, w, h, base, light, dark, edge = 2) {
  sheet.rect(x, y, w, h, base);
  for (let i = 0; i < edge; i++) {
    sheet.rect(x + i, y + i, w - i * 2, 1, light);
    sheet.rect(x + i, y + i, 1, h - i * 2, light);
    sheet.rect(x + i, y + h - 1 - i, w - i * 2, 1, dark);
    sheet.rect(x + w - 1 - i, y + i, 1, h - i * 2, dark);
  }
  // The two corners where light meets dark get the midtone, as in the original.
  const mid = mix(light, dark, 0.5);
  sheet.rect(x + w - edge, y, edge, edge, mid);
  sheet.rect(x, y + h - edge, edge, edge, mid);
}

/** An inset well — the inverse bevel, used for slots and text fields. */
function insetBox(sheet, x, y, w, h, base, light, dark, edge = 1) {
  sheet.rect(x, y, w, h, base);
  for (let i = 0; i < edge; i++) {
    sheet.rect(x + i, y + i, w - i * 2, 1, dark);
    sheet.rect(x + i, y + i, 1, h - i * 2, dark);
    sheet.rect(x + i, y + h - 1 - i, w - i * 2, 1, light);
    sheet.rect(x + w - 1 - i, y + i, 1, h - i * 2, light);
  }
}

function mix(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t);
}

// Shared palette — the classic interface greys.
const C = {
  panel: 0xc6c6c6,
  panelLight: 0xffffff,
  panelDark: 0x555555,
  well: 0x8b8b8b,
  wellDark: 0x373737,
  button: 0x6a6a6a,
  buttonTop: 0x8b8b8b,
  buttonDark: 0x2b2b2b,
  hover: 0x7a86b8,
  text: 0x3f3f3f,
};

// ---------------------------------------------------------------------------
// Icon stencils
// ---------------------------------------------------------------------------

const HEART = [
  '.XX.XX...',
  'XXXXXXX..',
  'XXXXXXX..',
  'XXXXXXX..',
  '.XXXXX...',
  '..XXX....',
  '...X.....',
  '.........',
  '.........',
];

// Wider, rounder body than the outline above; drawn 9x9 with a shine pixel.
const HEART_SHAPE = [
  '.XX.XX...',
  'XXXXXXX..',
  'XXXXXXXX.',
  'XXXXXXXX.',
  'XXXXXXXX.',
  '.XXXXXX..',
  '..XXXX...',
  '...XX....',
  '.........',
];

const HEART_SHINE = [
  '.........',
  '.SS......',
  '.S.......',
  '.........',
  '.........',
  '.........',
  '.........',
  '.........',
  '.........',
];

const ARMOR = [
  '..XXXXX..',
  '.XXXXXXX.',
  'XXX...XXX',
  'XXX...XXX',
  'XXXXXXXXX',
  'XXXXXXXXX',
  'XXXXXXXXX',
  '.XXXXXXX.',
  '..XXXXX..',
];

const FOOD = [
  '...XXX...',
  '..XXXXX..',
  '.XXXXXXX.',
  '.XXXXXX..',
  '..XXXXX..',
  '...XXX...',
  '...XX....',
  '..XX.....',
  '.XX......',
];

const BUBBLE = [
  '..XXX....',
  '.XSXXX...',
  'XXXXXXX..',
  'XXXXXXX..',
  'XXXXXXX..',
  '.XXXXX...',
  '..XXX....',
  '.........',
  '.........',
];

/** Paint one 9x9 icon from a stencil, with an outline and optional half mask. */
function icon9(sheet, x, y, shape, fill, shineHex, half = 0) {
  const pal = { X: fill, S: shineHex ?? mix(fill, 0xffffff, 0.55) };
  // Outline first so the shape reads against the world behind it.
  for (let j = 0; j < shape.length; j++) {
    for (let i = 0; i < shape[j].length; i++) {
      if (shape[j][i] === '.') continue;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = i + dx, ny = j + dy;
        const inside = shape[ny]?.[nx] && shape[ny][nx] !== '.';
        if (!inside) sheet.set(x + nx, y + ny, 0x000000, 200);
      }
    }
  }
  stencil(sheet, x, y, shape, pal);
  if (half > 0) {
    // Blank the right-hand side so a half icon can be drawn over the empty one.
    for (let j = 0; j < 9; j++) {
      for (let i = half; i < 9; i++) sheet.set(x + i, y + j, 0, 0);
    }
  }
  if (shape === HEART_SHAPE && shineHex !== null) {
    stencil(sheet, x, y, HEART_SHINE, { S: [0xffffff, 210] });
  }
}

// ---------------------------------------------------------------------------

let registered = false;

/** Register the interface sheet. Safe to call more than once. */
export function registerGuiTextures() {
  if (registered) return GUI_SHEET;
  registered = true;

  registerSheet(GUI_SHEET, SHEET_SIZE, SHEET_SIZE, (s, rng) => {
    paintHud(s, rng);
    paintWorkstations(s);
    paintButtons(s, rng);
    paintBars(s);
    paintWidgets(s);
    paintNineSlices(s, rng);
    paintIcons(s);
    paintEffects(s);
  });

  return GUI_SHEET;
}

function paintHud(s, rng) {
  // Hotbar: a dark translucent bar with a lighter inner edge.
  const h = GUI.hotbar;
  s.rect(h.x, h.y, h.w, h.h, 0x000000, 150);
  s.rect(h.x, h.y, h.w, 1, 0xffffff, 60);
  s.rect(h.x, h.y + h.h - 1, h.w, 1, 0x000000, 190);
  for (let i = 0; i < 9; i++) {
    const x = h.x + 1 + i * 20;
    s.frame(x, h.y + 1, 20, 20, 0xffffff, 26);
  }

  // Selection frame: a bright 24x24 ring.
  const f = GUI.hotbarSelect;
  s.frame(f.x, f.y, f.w, f.h, 0xdddddd, 245);
  s.frame(f.x + 1, f.y + 1, f.w - 2, f.h - 2, 0xffffff, 255);
  s.frame(f.x + 2, f.y + 2, f.w - 4, f.h - 4, 0x9a9a9a, 160);

  // A plain slot well, used by every container screen.
  const sl = GUI.slot;
  insetBox(s, sl.x, sl.y, sl.w, sl.h, C.well, 0xffffff, C.wellDark, 1);
  s.grainRect(rng, sl.x + 1, sl.y + 1, sl.w - 2, sl.h - 2, 0.04);

  const lk = GUI.slotLocked;
  insetBox(s, lk.x, lk.y, lk.w, lk.h, 0x6d6d6d, 0xb0b0b0, 0x2f2f2f, 1);
  s.rect(lk.x + 4, lk.y + 8, 10, 6, 0x4a4a4a);
  s.rect(lk.x + 6, lk.y + 5, 6, 3, 0x4a4a4a);
}

function paintWorkstations(s) {
  // The crafting/smelting arrow, empty then filled.
  for (const [reg, body, tip] of [
    [GUI.arrowEmpty, 0x8b8b8b, 0x6a6a6a],
    [GUI.arrowFull, 0xffffff, 0xdddddd],
  ]) {
    s.rect(reg.x, reg.y + 6, 16, 5, body);
    for (let i = 0; i < 8; i++) {
      const half = 8 - i;
      s.rect(reg.x + 16 + i, reg.y + 8 - half, 1, half * 2 + 1, i < 4 ? body : tip);
    }
  }

  // The furnace flame.
  const flame = [
    '......XX......',
    '.....XXXX.....',
    '....XXXXXX....',
    '....XXXXXX....',
    '...XXXXXXXX...',
    '..XXXXXXXXXX..',
    '..XXXXXXXXXX..',
    '.XXXXXXXXXXXX.',
    '.XXXXXXXXXXXX.',
    'XXXXXXXXXXXXXX',
    'XXXXXXXXXXXXXX',
    'XXXXXXXXXXXXXX',
    '.XXXXXXXXXXXX.',
    '..XXXXXXXXXX..',
  ];
  stencil(s, GUI.flameEmpty.x, GUI.flameEmpty.y, flame, { X: 0x484848 });
  stencil(s, GUI.flameFull.x, GUI.flameFull.y, flame, { X: 0xffb020 });
  // Hotter core.
  for (let y = 5; y < 13; y++) {
    for (let x = 4; x < 10; x++) s.set(GUI.flameFull.x + x, GUI.flameFull.y + y, 0xffe870);
  }

  // Brewing stand bubbles and the drip arrow.
  const b = GUI.brewBubbles;
  for (let i = 0; i < 6; i++) {
    const y = b.y + 2 + i * 4;
    s.rect(b.x + 2 + (i % 3), y, 3, 3, 0x5fa4ff, 220);
    s.set(b.x + 2 + (i % 3), y, 0xbfe0ff, 220);
  }
  const a = GUI.brewArrow;
  s.rect(a.x + 3, a.y, 3, a.h - 5, 0xd8d8d8);
  for (let i = 0; i < 5; i++) s.rect(a.x + i, a.y + a.h - 5 + i, 9 - i * 2, 1, 0xd8d8d8);

  // The enchanting table's "level" badge and the anvil's error cross.
  const e = GUI.enchantLevel;
  s.rect(e.x, e.y, e.w, e.h, 0x2b1a4d);
  s.frame(e.x, e.y, e.w, e.h, 0x7a5cc0);
  const x2 = GUI.anvilCross;
  for (let i = 0; i < 14; i++) {
    s.rect(x2.x + i, x2.y + i, 2, 2, 0xd83c3c);
    s.rect(x2.x + 13 - i, x2.y + i, 2, 2, 0xd83c3c);
  }
  // A diagonal shimmer used to tint enchanted items.
  const g = GUI.glint;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = (x + y * 2) % 8;
      if (v < 2) s.set(g.x + x, g.y + y, 0xb060ff, 120 - v * 40);
    }
  }
}

function paintButtons(s, rng) {
  const variants = [
    [GUI.button, 0x6a6a6a, 0x8f8f8f, 0x2f2f2f],
    [GUI.buttonHover, 0x7d86b0, 0xa5aede, 0x353a52],
    [GUI.buttonDisabled, 0x4a4a4a, 0x5c5c5c, 0x2a2a2a],
  ];
  for (const [reg, base, light, dark] of variants) {
    // A vertical gradient, then a hard 1px outline and a bevel.
    for (let y = 0; y < reg.h; y++) {
      const t = y / (reg.h - 1);
      s.rect(reg.x, reg.y + y, reg.w, 1, mix(light, base, t * 0.9));
    }
    s.frame(reg.x, reg.y, reg.w, reg.h, dark);
    s.rect(reg.x + 1, reg.y + 1, reg.w - 2, 1, mix(light, 0xffffff, 0.35));
    s.rect(reg.x + 1, reg.y + reg.h - 2, reg.w - 2, 1, mix(dark, base, 0.4));
    s.grainRect(rng, reg.x + 1, reg.y + 1, reg.w - 2, reg.h - 2, 0.035);
  }
}

function paintBars(s) {
  // Experience: an empty dark trough and a bright green fill.
  const e = GUI.xpBarEmpty, f = GUI.xpBarFull;
  s.rect(e.x, e.y, e.w, e.h, 0x000000, 190);
  s.rect(e.x, e.y, e.w, 1, 0x2a2a2a, 220);
  s.rect(e.x, e.y + e.h - 1, e.w, 1, 0x555555, 160);
  s.rect(f.x, f.y, f.w, f.h, 0x7ee02a);
  s.rect(f.x, f.y, f.w, 1, 0xa9f76a);
  s.rect(f.x, f.y + f.h - 1, f.w, 1, 0x4f9a12);

  // Boss bars are tinted at draw time, so paint them white-on-dark.
  const be = GUI.bossBarEmpty, bf = GUI.bossBarFull;
  s.rect(be.x, be.y, be.w, be.h, 0x101010, 200);
  s.frame(be.x, be.y, be.w, be.h, 0x3a3a3a, 220);
  s.rect(bf.x, bf.y, bf.w, bf.h, 0xffffff);
  s.rect(bf.x, bf.y, bf.w, 1, 0xffffff, 160);
  s.rect(bf.x, bf.y + bf.h - 1, bf.w, 1, 0x000000, 60);
}

function paintWidgets(s) {
  // Crosshair: drawn with difference blending, so pure white is right.
  const c = GUI.crosshair;
  s.rect(c.x + 7, c.y + 1, 1, 13, 0xffffff);
  s.rect(c.x + 1, c.y + 7, 13, 1, 0xffffff);

  for (const [reg, on] of [[GUI.checkbox, false], [GUI.checkboxOn, true]]) {
    insetBox(s, reg.x, reg.y, reg.w, reg.h, 0x2b2b2b, 0x8b8b8b, 0x101010, 1);
    if (!on) continue;
    const tick = [
      '..........',
      '........X.',
      '.......XX.',
      '.X....XX..',
      '.XX..XX...',
      '..XXXX....',
      '...XX.....',
      '..........',
    ];
    stencil(s, reg.x + 1, reg.y + 2, tick, { X: 0x8bf05a });
  }

  const k = GUI.sliderKnob;
  bevelBox(s, k.x, k.y, k.w, k.h, C.button, C.buttonTop, C.buttonDark, 1);

  const th = GUI.scrollThumb;
  bevelBox(s, th.x, th.y, th.w, th.h, 0xc6c6c6, 0xffffff, 0x555555, 1);
  const tr = GUI.scrollTrack;
  s.rect(tr.x, tr.y, tr.w, tr.h, 0x101010, 190);

  // Creative tabs: a rounded-ish plate, lighter when selected.
  for (const [reg, base, light] of [
    [GUI.tab, 0x8b8b8b, 0xb4b4b4],
    [GUI.tabSelected, 0xc6c6c6, 0xffffff],
  ]) {
    s.rect(reg.x + 1, reg.y, reg.w - 2, reg.h - 1, base);
    s.rect(reg.x, reg.y + 2, reg.w, reg.h - 4, base);
    s.rect(reg.x + 1, reg.y + 1, reg.w - 2, 1, light);
    s.rect(reg.x + 1, reg.y + 1, 1, reg.h - 3, light);
    s.rect(reg.x + reg.w - 2, reg.y + 2, 1, reg.h - 4, 0x555555);
    s.rect(reg.x + 1, reg.y + reg.h - 2, reg.w - 2, 1, 0x555555);
  }

  const sb = GUI.searchBox;
  insetBox(s, sb.x, sb.y, sb.w, sb.h, 0x000000, 0x6a6a6a, 0x1a1a1a, 1);
}

function paintNineSlices(s, rng) {
  const p = GUI.panel;
  bevelBox(s, p.x, p.y, p.w, p.h, C.panel, C.panelLight, C.panelDark, 2);
  s.grainRect(rng, p.x + 2, p.y + 2, p.w - 4, p.h - 4, 0.03);

  const t = GUI.tooltip;
  s.rect(t.x, t.y, t.w, t.h, 0x100010, 244);
  s.frame(t.x + 1, t.y + 1, t.w - 2, t.h - 2, 0x2d0a5e, 255);
  s.frame(t.x, t.y, t.w, t.h, 0x000000, 255);
  // The purple inner border fades from top to bottom in the original.
  s.rect(t.x + 1, t.y + 1, t.w - 2, 1, 0x5028a0, 255);
  s.rect(t.x + 1, t.y + t.h - 2, t.w - 2, 1, 0x28104f, 255);

  const i = GUI.inset;
  insetBox(s, i.x, i.y, i.w, i.h, C.well, 0xffffff, C.wellDark, 1);
  s.grainRect(rng, i.x + 1, i.y + 1, i.w - 2, i.h - 2, 0.04);

  const d = GUI.darkPanel;
  s.rect(d.x, d.y, d.w, d.h, 0x1a1a1a, 220);
  s.frame(d.x, d.y, d.w, d.h, 0x000000, 235);
  s.rect(d.x + 1, d.y + 1, d.w - 2, 1, 0x3c3c3c, 200);
}

function paintIcons(s) {
  const y = GUI.heartBg.y;
  const hearts = [
    [GUI.heartBg, 0x3b0000, 0],
    [GUI.heart, 0xd82626, 0],
    [GUI.heartHalf, 0xd82626, 5],
    [GUI.heartGold, 0xf0c020, 0],
    [GUI.heartGoldHalf, 0xf0c020, 5],
    [GUI.heartPoison, 0x6f9a1e, 0],
    [GUI.heartPoisonHalf, 0x6f9a1e, 5],
    [GUI.heartWither, 0x2a2a2a, 0],
    [GUI.heartWitherHalf, 0x2a2a2a, 5],
  ];
  for (const [reg, hex, half] of hearts) {
    icon9(s, reg.x, reg.y, HEART_SHAPE, hex, hex === 0x3b0000 ? null : undefined, half);
  }

  icon9(s, GUI.armorBg.x, y, ARMOR, 0x2b2b2b, null);
  icon9(s, GUI.armorHalf.x, y, ARMOR, 0xdedede, 0xffffff, 5);
  icon9(s, GUI.armorFull.x, y, ARMOR, 0xdedede, 0xffffff);

  icon9(s, GUI.foodBg.x, y, FOOD, 0x2b1a0c, null);
  icon9(s, GUI.foodHalf.x, y, FOOD, 0xc07a2a, 0xe0a050, 5);
  icon9(s, GUI.foodFull.x, y, FOOD, 0xc07a2a, 0xe0a050);

  icon9(s, GUI.bubble.x, y, BUBBLE, 0x9fd8ff, 0xffffff);
  icon9(s, GUI.bubblePop.x, y, BUBBLE, 0x5f8faf, 0xbfd8ef);
  // The popping bubble is smaller: knock the outer ring out.
  for (let j = 0; j < 9; j++) {
    for (let i = 0; i < 9; i++) {
      if (i === 0 || j === 0 || i > 6 || j > 6) s.set(GUI.bubblePop.x + i, y + j, 0, 0);
    }
  }

  const lk = GUI.lockIcon;
  s.rect(lk.x + 1, lk.y + 4, 7, 5, 0xdddddd);
  s.rect(lk.x + 2, lk.y + 1, 5, 3, 0xaaaaaa);
  s.set(lk.x + 4, lk.y + 6, 0x555555);

  // Restore the empty-heart look: no shine, darker rim.
  const bg = GUI.heartBg;
  stencil(s, bg.x, bg.y, HEART, { X: 0x4a0d0d });
}

/**
 * The status-effect strip. Each icon is a simple emblem on a tinted disc —
 * enough to tell them apart at 18x18, which is all the HUD needs.
 */
function paintEffects(s) {
  const y = EFFECT_ROW_Y;
  const specs = {
    speed: [0x7cafc6, 'arrow'],
    slowness: [0x5a6c81, 'arrow_down'],
    haste: [0xd9c043, 'pick'],
    mining_fatigue: [0x4a4217, 'pick'],
    strength: [0x932423, 'fist'],
    instant_health: [0xf82423, 'plus'],
    jump_boost: [0x22ff4c, 'up'],
    regeneration: [0xcd5cab, 'plus'],
    resistance: [0x9146f0, 'shield'],
    fire_resistance: [0xe49a3a, 'shield'],
    water_breathing: [0x2e5299, 'drop'],
    invisibility: [0x7f8392, 'ghost'],
    night_vision: [0x1f1fa1, 'eye'],
    hunger: [0x587653, 'fork'],
    weakness: [0x484d48, 'fist'],
    poison: [0x4e9331, 'skull'],
    wither: [0x352a27, 'skull'],
    absorption: [0x2552a5, 'plus'],
  };
  const emblems = {
    arrow: ['....X.....', '...XX.....', '..XXXXXX..', '.XXXXXXXX.', '..XXXXXX..', '...XX.....', '....X.....'],
    arrow_down: ['....X.....', '....XX....', '..XXXXXX..', '.XXXXXXXX.', '..XXXXXX..', '....XX....', '....X.....'],
    pick: ['..XXXXX...', '.XX...XX..', 'X..XXX..X.', '...XX.....', '..XX......', '.XX.......', 'XX........'],
    fist: ['..XXXX....', '.XXXXXX...', 'XXXXXXXX..', 'XXXXXXXX..', '.XXXXXXX..', '..XXXXX...', '...XXX....'],
    plus: ['...XX.....', '...XX.....', 'XXXXXXXX..', 'XXXXXXXX..', '...XX.....', '...XX.....', '..........'],
    up: ['...XX.....', '..XXXX....', '.XXXXXX...', 'XXXXXXXX..', '...XX.....', '...XX.....', '...XX.....'],
    shield: ['.XXXXXXX..', '.XXXXXXX..', '.XXXXXXX..', '..XXXXX...', '..XXXXX...', '...XXX....', '....X.....'],
    drop: ['....X.....', '...XXX....', '..XXXXX...', '.XXXXXXX..', '.XXXXXXX..', '..XXXXX...', '...XXX....'],
    ghost: ['..XXXX....', '.XXXXXX...', 'XXXXXXXX..', 'XX.XX.XX..', 'XXXXXXXX..', 'XXXXXXXX..', 'X.X.X.X...'],
    eye: ['..XXXX....', '.XXXXXX...', 'XX.XX.XX..', 'XX.XX.XX..', '.XXXXXX...', '..XXXX....', '..........'],
    fork: ['X..X..X...', 'X..X..X...', 'XXXXXXX...', '...X......', '...X......', '...X......', '...X......'],
    skull: ['.XXXXXX...', 'XXXXXXXX..', 'XX.XX.XX..', 'XXXXXXXX..', '.XXXXXX...', '.X.XX.X...', '..........'],
  };

  let i = 0;
  for (const id of EFFECT_ICONS) {
    const [tint, emblem] = specs[id] ?? [0x808080, 'plus'];
    const x = i * 18;
    // Rounded badge.
    s.rect(x + 1, y, 16, 18, tint);
    s.rect(x, y + 1, 18, 16, tint);
    s.rect(x + 1, y + 1, 16, 1, mix(tint, 0xffffff, 0.4));
    s.rect(x + 1, y + 16, 16, 1, mix(tint, 0x000000, 0.4));
    stencil(s, x + 4, y + 5, emblems[emblem] ?? emblems.plus,
      { X: mix(tint, 0xffffff, 0.85) });
    i++;
  }
  // A neutral badge at the end for effects we have no emblem for.
  const x = i * 18;
  s.rect(x + 1, y, 16, 18, 0x707070);
  s.rect(x, y + 1, 18, 16, 0x707070);
  s.rect(x + 1, y + 1, 16, 1, 0x9a9a9a);
  stencil(s, x + 4, y + 5, emblems.plus, { X: 0xdddddd });
}

export default registerGuiTextures;
