// Procedural item icons.
//
// Every item that is not a block gets a 16x16 painter registered under its item
// name (block items borrow their block's textures and are drawn as isometric
// cubes by the inventory screen instead).
//
// The house style: draw a flat silhouette from a character map or a primitive,
// let `bevelShape` add the top-left highlight / bottom-right shadow that makes
// pixel art read as volume, then wrap the whole thing in a 1px dark outline
// with `Pixels.outline`. Families that differ only by material — tools, armour,
// buckets, boats, discs, spawn eggs — share one painter parameterised by
// colour, so an icon set of ~350 items is a few dozen shapes.

import { registerTexture, shade, mixHex } from '../texgen.js';
import { COLORS, COLOR_HEX, WOOD_TYPES } from '../../world/blockdefs/data.js';
import { MOB_EGGS, MUSIC_DISCS } from '../../game/itemdefs.js';

let registered = false;

/** The outline every item icon shares. */
const INK = 0x18140f;

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

/**
 * Paint a character map. Rows are strings; '.' is transparent and every other
 * character is looked up in `palette`. Rows shorter than 16 simply stop early,
 * which keeps the maps below readable.
 */
function paintMap(px, rows, palette) {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      const hex = palette[ch];
      if (hex === undefined) continue;
      px.set(x, y, hex);
    }
  }
  return px;
}

/**
 * Light the pixels whose up/left neighbour is empty and shade the ones whose
 * down/right neighbour is empty — a cheap directional bevel that works on any
 * silhouette, including the holes inside helmets and bow limbs.
 */
function bevelShape(px, light = 0.26, dark = 0.3) {
  const src = new Uint8ClampedArray(px.data);
  const alphaAt = (x, y) => (x < 0 || y < 0 || x >= px.size || y >= px.size)
    ? 0 : src[(y * px.size + x) * 4 + 3];
  for (let y = 0; y < px.size; y++) {
    for (let x = 0; x < px.size; x++) {
      if (alphaAt(x, y) === 0) continue;
      if (alphaAt(x - 1, y) === 0 || alphaAt(x, y - 1) === 0) px.shadePixel(x, y, light);
      else if (alphaAt(x + 1, y) === 0 || alphaAt(x, y + 1) === 0) px.shadePixel(x, y, -dark);
    }
  }
  return px;
}

/** Bevel then outline — the last call of nearly every painter. */
function finish(px, bevel = true) {
  if (bevel) bevelShape(px);
  px.outline(INK, 1);
  return px;
}

/** Filled ellipse. */
function ellipse(px, cx, cy, rx, ry, hex) {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1.02) px.set(x, y, hex);
    }
  }
  return px;
}

/** Scatter `n` pixels of `hex` inside the opaque part of the icon. */
function speckleInside(px, rng, n, hex) {
  for (let i = 0; i < n; i++) {
    const x = rng.int(px.size), y = rng.int(px.size);
    if (px.getAlpha(x, y) > 0) px.set(x, y, hex);
  }
  return px;
}

/** Register a painter, ignoring a second registration of the same name. */
const T = (name, painter) => registerTexture(name, painter);

// ---------------------------------------------------------------------------
// Shape maps
// ---------------------------------------------------------------------------

const INGOT = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '....#########...',
  '...##########...',
  '...#########....',
  '..##########....',
  '..#########.....',
];

const NUGGET = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '......####......',
  '.....######.....',
  '.....######.....',
  '......####......',
];

const GEM = [
  '................',
  '................',
  '......####......',
  '.....######.....',
  '....########....',
  '...##########...',
  '..############..',
  '..############..',
  '...##########...',
  '....########....',
  '.....######.....',
  '......####......',
];

const BLOB = [
  '................',
  '................',
  '................',
  '.......##.......',
  '.....######.....',
  '....########....',
  '...##########...',
  '..############..',
  '..############..',
  '...##########...',
  '....########....',
  '.....######.....',
];

const CHUNK = [
  '................',
  '................',
  '......###.......',
  '....######.#....',
  '...#########....',
  '..###########...',
  '..###########...',
  '.############...',
  '..##########....',
  '..#########.....',
  '...#######......',
  '....####........',
];

// -- Tools ------------------------------------------------------------------

const PICKAXE_HEAD = [
  '................',
  '.....######.....',
  '...##########...',
  '..###......###..',
  '..##........##..',
  '..#..........#..',
];

const AXE_HEAD = [
  '................',
  '......#####.....',
  '....#######.....',
  '...#######......',
  '...######.......',
  '...#####........',
  '....###.........',
  '.....#..........',
];

const SHOVEL_HEAD = [
  '................',
  '.........####...',
  '........######..',
  '........######..',
  '........######..',
  '.........####...',
  '..........##....',
];

const HOE_HEAD = [
  '................',
  '....########....',
  '....######......',
  '....###.........',
  '....##..........',
];

const SWORD = [
  '................',
  '...........###..',
  '..........###+..',
  '.........###+...',
  '........###+....',
  '.......###+.....',
  '......###+......',
  '.....###+.......',
  '....###+........',
  '..++++++........',
  '...hhh..........',
  '..hhh...........',
  '.hhh............',
  '.hh.............',
];

// -- Armour -----------------------------------------------------------------

const HELMET = [
  '................',
  '................',
  '...##########...',
  '..############..',
  '.##############.',
  '.##############.',
  '.####......####.',
  '.####......####.',
  '.##..........##.',
  '.##..........##.',
  '.###........###.',
  '..##........##..',
];

const CHESTPLATE = [
  '................',
  '................',
  '..##........##..',
  '.####......####.',
  '.##############.',
  '.##############.',
  '.##############.',
  '.##############.',
  '.##############.',
  '.##############.',
  '..############..',
  '..###......###..',
  '..##........##..',
];

const LEGGINGS = [
  '................',
  '.##############.',
  '.bbbbbbbbbbbbbb.',
  '.##############.',
  '.#####....#####.',
  '.#####....#####.',
  '.####......####.',
  '.####......####.',
  '.####......####.',
  '.####......####.',
  '.####......####.',
  '.####......####.',
  '..##........##..',
];

const BOOTS = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '.###......###...',
  '.###......###...',
  '.###......###...',
  '.###......###...',
  '.####....####...',
  '.#####..#####...',
  '.#####..#####...',
];

// -- Containers and vehicles -------------------------------------------------

const BUCKET = [
  '................',
  '................',
  '................',
  '..############..',
  '..#wwwwwwwwww#..',
  '..#wwwwwwwwww#..',
  '...#wwwwwwww#...',
  '...#wwwwwwww#...',
  '....#wwwwww#....',
  '....#wwwwww#....',
  '.....######.....',
];

const BOTTLE = [
  '................',
  '......cccc......',
  '......gggg......',
  '......gggg......',
  '.....gllllg.....',
  '....gllllllg....',
  '...gllllllllg...',
  '...gllllllllg...',
  '...gllllllllg...',
  '...gllllllllg...',
  '...gllllllllg...',
  '....gllllllg....',
  '.....gggggg.....',
];

const BOAT = [
  '................',
  '................',
  '................',
  '.#............#.',
  '.#............#.',
  '.#...#....#...#.',
  '.##############.',
  '.##############.',
  '..############..',
  '...##########...',
  '.....######.....',
];

const MINECART = [
  '................',
  '................',
  '...#........#...',
  '...#........#...',
  '...#........#...',
  '...##########...',
  '...##########...',
  '...##########...',
  '....w......w....',
  '...www....www...',
  '...www....www...',
];

const EGG_SHAPE = [
  '................',
  '................',
  '......####......',
  '.....######.....',
  '....########....',
  '....########....',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '....########....',
  '....########....',
  '.....######.....',
];

const DISC = [
  '................',
  '................',
  '....########....',
  '..############..',
  '..############..',
  '.##############.',
  '.#####oooo#####.',
  '.#####oooo#####.',
  '.#####oooo#####.',
  '.#####oooo#####.',
  '.##############.',
  '..############..',
  '..############..',
  '....########....',
];

// -- Weapons ----------------------------------------------------------------

const BOW = [
  '...s............',
  '...s#...........',
  '...s.###........',
  '...s....##......',
  '...s......#.....',
  '...s.......#....',
  '...s.......#....',
  '...s........#...',
  '...s........#...',
  '...s.......#....',
  '...s.......#....',
  '...s......#.....',
  '...s....##......',
  '...s.###........',
  '...s#...........',
  '...s............',
];

const CROSSBOW = [
  '................',
  '................',
  '.#............#.',
  '.##..........##.',
  '..#####..#####..',
  '...#ssssssss#...',
  '......vvvv......',
  '......####......',
  '.......##.......',
  '.......##.......',
  '.......##.......',
  '......####......',
];

const ARROW = [
  '................',
  '..........#####.',
  '..........####..',
  '.........###s...',
  '.........ss.....',
  '........ss......',
  '.......ss.......',
  '......ss........',
  '.....ss.........',
  '....ss..........',
  '...ss...........',
  '..fss...........',
  '.ffs............',
  'fff.............',
  'ff..............',
];

const SHIELD = [
  '................',
  '..###########...',
  '..###########...',
  '..###########...',
  '..###########...',
  '..###########...',
  '..###########...',
  '...#########....',
  '...#########....',
  '....#######.....',
  '.....#####......',
  '......###.......',
  '.......#........',
];

const ELYTRA = [
  '................',
  '..##........##..',
  '.####......####.',
  '.#####....#####.',
  '.######..######.',
  '.######..######.',
  '..#####..#####..',
  '..####....####..',
  '...###....###...',
  '...##......##...',
  '....#......#....',
];

const TOTEM = [
  '................',
  '.....######.....',
  '....########....',
  '....#..##..#....',
  '....########....',
  '.....######.....',
  '...##########...',
  '..############..',
  '...##########...',
  '.....######.....',
  '......####......',
  '.......##.......',
];

// -- Food -------------------------------------------------------------------

const MEAT = [
  '................',
  '................',
  '....#######.....',
  '...#########....',
  '..###########...',
  '..###########...',
  '.############...',
  '.############...',
  '.############...',
  '..##########....',
  '..#########.....',
  '...#######......',
  '....####........',
];

const LOAF = [
  '................',
  '................',
  '................',
  '....########....',
  '..############..',
  '.##############.',
  '.##############.',
  '.##############.',
  '.##############.',
  '..############..',
  '....########....',
];

const HIDE = [
  '................',
  '................',
  '...##.....##....',
  '..############..',
  '.##############.',
  '.##############.',
  '.##############.',
  '.##############.',
  '.##############.',
  '..############..',
  '...##.....##....',
];

const BOOK = [
  '................',
  '................',
  '..############..',
  '..#cccccccccc#..',
  '..#c##pppppp#c..',
  '..#c##pppppp#c..',
  '..#c##pppppp#c..',
  '..#c##pppppp#c..',
  '..#c##pppppp#c..',
  '..#cccccccccc#..',
  '..############..',
];

const SHEET = [
  '................',
  '................',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
];

// ---------------------------------------------------------------------------
// Material palettes
// ---------------------------------------------------------------------------

const TOOL_COLOR = {
  wooden: 0x9c7248, stone: 0x7d7d7d, iron: 0xd8d8d8,
  golden: 0xf9d94b, diamond: 0x4aedd9, netherite: 0x50454a,
};

const ARMOR_COLOR = {
  leather: 0xa4643c, chainmail: 0x9a9a9a, iron: 0xd8d8d8,
  golden: 0xf9d94b, diamond: 0x4aedd9, netherite: 0x50454a,
};

const WOOD_COLOR = {
  oak: 0xb08a4f, spruce: 0x7a5730, birch: 0xdccd93, jungle: 0xb1805c,
  acacia: 0xba6337, dark_oak: 0x4b3218, mangrove: 0x773934, cherry: 0xe2b1a5,
  crimson: 0x6a344b, warped: 0x2b6c68,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Register a painter for every non-block item. Idempotent. */
export function registerItemTextures() {
  if (registered) return;
  registered = true;

  registerMaterialIcons();
  registerToolIcons();
  registerArmorIcons();
  registerCombatIcons();
  registerBucketIcons();
  registerFoodIcons();
  registerDyeIcons();
  registerTransportIcons();
  registerUtilityIcons();
  registerSpawnEggIcons();
  registerDiscIcons();
  registerPotionIcons();
}

// ---------------------------------------------------------------------------
// 1. Materials
// ---------------------------------------------------------------------------

/** An ingot bar: a slanted rounded bar with a bright top edge. */
function ingot(name, color) {
  T(name, (px) => {
    paintMap(px, INGOT, { '#': color });
    finish(px);
  });
}

function nugget(name, color) {
  T(name, (px) => {
    paintMap(px, NUGGET, { '#': color });
    finish(px);
  });
}

/** A cut gem: hexagonal, with a bright facet in the upper left. */
function gem(name, color, facet = null) {
  T(name, (px) => {
    paintMap(px, GEM, { '#': color });
    const hi = facet ?? shade(color, 0.45);
    px.rect(5, 5, 3, 2, hi);
    px.set(4, 7, hi);
    px.rect(8, 9, 3, 2, shade(color, -0.25));
    finish(px);
  });
}

/** A pile of powder: a soft blob roughened with two tones of speckle. */
function dust(name, color) {
  T(name, (px, rng) => {
    paintMap(px, BLOB, { '#': color });
    speckleInside(px, rng, 26, shade(color, 0.3));
    speckleInside(px, rng, 18, shade(color, -0.28));
    // Nibble a few pixels off the edge so it reads as loose powder.
    for (let i = 0; i < 5; i++) {
      const x = rng.int(px.size), y = rng.int(px.size);
      if (px.getAlpha(x, y) && (px.getAlpha(x + 1, y) === 0 || px.getAlpha(x, y + 1) === 0)) {
        px.data[px.index(x, y) + 3] = 0;
      }
    }
    finish(px);
  });
}

/** A rough mineral chunk (coal, raw ore). */
function chunk(name, color, fleckColor) {
  T(name, (px, rng) => {
    paintMap(px, CHUNK, { '#': color });
    if (fleckColor !== undefined) {
      speckleInside(px, rng, 22, fleckColor);
      speckleInside(px, rng, 10, shade(color, -0.3));
    } else {
      speckleInside(px, rng, 16, shade(color, 0.22));
      speckleInside(px, rng, 12, shade(color, -0.3));
    }
    finish(px);
  });
}

/** A round ball, optionally with a highlight and a core. */
function ball(name, color, opts = {}) {
  T(name, (px, rng) => {
    ellipse(px, 7.5, 8, 5.2, 5.2, color);
    if (opts.core) ellipse(px, 7.5, 8, 2.4, 2.4, opts.core);
    px.rect(5, 5, 2, 2, shade(color, 0.42));
    if (opts.speckle) speckleInside(px, rng, opts.speckle, shade(color, -0.25));
    finish(px);
  });
}

/** A 45-degree shaft running from the top right to the bottom left. */
function shaft(px, color, y0 = 2, y1 = 13, offset = 13) {
  for (let y = y0; y <= y1; y++) {
    const x = offset - y;
    px.set(x, y, shade(color, 0.18));
    px.set(x + 1, y, color);
  }
}

function registerMaterialIcons() {
  T('stick', (px) => { shaft(px, 0x76552d, 3, 12, 14); finish(px); });
  T('bowl', (px) => {
    const w = 0x8b5a2b;
    px.rect(2, 7, 12, 2, shade(w, 0.2));
    px.rect(3, 9, 10, 2, w);
    px.rect(4, 11, 8, 1, shade(w, -0.2));
    px.rect(5, 12, 6, 1, shade(w, -0.35));
    finish(px);
  });

  chunk('coal', 0x2a2a2a, 0x4a4a4a);
  chunk('charcoal', 0x3a3128, 0x5c4c3a);
  chunk('raw_iron', 0xd8af93, 0xb08a6d);
  chunk('raw_copper', 0xc4703f, 0xe09a68);
  chunk('raw_gold', 0xf0c247, 0xc39a2c);
  chunk('flint', 0x50494a, 0x7d7375);
  chunk('netherite_scrap', 0x6b4b3f, 0x8f6a56);

  ingot('iron_ingot', 0xd8d8d8);
  ingot('gold_ingot', 0xf9d94b);
  ingot('copper_ingot', 0xe0784b);
  ingot('netherite_ingot', 0x50454a);
  ingot('brick', 0xa2564a);
  ingot('nether_brick', 0x4a2229);

  nugget('iron_nugget', 0xd8d8d8);
  nugget('gold_nugget', 0xf9d94b);

  gem('diamond', 0x4aedd9);
  gem('emerald', 0x22c460);
  gem('lapis_lazuli', 0x2a4ab0);
  gem('quartz', 0xece5dc);
  gem('amethyst_shard', 0x9a5cc6);
  gem('prismarine_crystals', 0xc8e0d2, 0xffffff);
  gem('echo_shard', 0x1d5e63, 0x63d6d0);
  gem('heart_of_the_sea', 0x2f7d9c, 0x8fdcea);

  T('prismarine_shard', (px) => {
    paintMap(px, [
      '................',
      '................',
      '.......##.......',
      '......####......',
      '.....######.....',
      '....########....',
      '...##########...',
      '....########....',
      '.....######.....',
      '......####......',
      '.......##.......',
    ], { '#': 0x7fbaa6 });
    px.rect(6, 5, 3, 3, 0xa9dcc9);
    finish(px);
  });

  T('clay_ball', (px, rng) => { ellipse(px, 7.5, 8, 4.6, 4.6, 0xa4a8b8); speckleInside(px, rng, 12, 0x8d92a4); finish(px); });
  ball('slime_ball', 0x87c072, { core: 0x6ba455, speckle: 8 });
  ball('magma_cream', 0x3a2417, { core: 0xe2761f });
  ball('snowball', 0xf0f8ff, { speckle: 6 });
  ball('ender_pearl', 0x1e8a7a, { core: 0x7ee3cd });
  ball('ender_eye', 0x1e8a7a, { core: 0x9cf24a });
  ball('ghast_tear', 0xd7f2ef, { core: 0xffffff });
  ball('ink_sac', 0x1c1c22, { core: 0x33333d });
  ball('glow_ink_sac', 0x1f4d4a, { core: 0x6cf0d0 });
  ball('chorus_fruit', 0x8b5f8b, { speckle: 10 });
  ball('popped_chorus_fruit', 0x9a7ba8, { speckle: 10 });

  T('egg', (px) => {
    ellipse(px, 7.5, 8.5, 4.2, 5.2, 0xd9cdb2);
    px.rect(5, 5, 2, 2, 0xf3ead6);
    finish(px);
  });

  T('feather', (px) => {
    const q = 0xd8d8d8, s = 0xf6f6f6, r = 0x9a9a9a;
    px.line(3, 13, 11, 3, r);
    for (let i = 0; i < 8; i++) {
      const x = 4 + i, y = 12 - i;
      px.hline(x, x + Math.max(1, 3 - Math.floor(i / 3)), y - 1, i % 2 ? s : q);
      px.set(x + 1, y - 2, q);
    }
    px.line(11, 3, 12, 2, s);
    finish(px);
  });

  T('leather', (px, rng) => { paintMap(px, HIDE, { '#': 0xa0653c }); speckleInside(px, rng, 14, 0x8a5330); finish(px); });
  T('rabbit_hide', (px, rng) => { paintMap(px, HIDE, { '#': 0xd6c199 }); speckleInside(px, rng, 14, 0xb9a17d); finish(px); });
  T('rabbit_foot', (px) => {
    px.rect(6, 2, 3, 7, 0xb6a184);
    px.rect(4, 9, 7, 4, 0xd6c6ad);
    px.rect(4, 12, 2, 1, 0xf0e6d2);
    px.rect(7, 12, 2, 1, 0xf0e6d2);
    finish(px);
  });

  T('string', (px) => {
    const c = 0xdedede;
    px.line(2, 3, 13, 5, c); px.line(13, 5, 3, 8, c);
    px.line(3, 8, 13, 11, c); px.line(13, 11, 4, 13, c);
    finish(px, false);
  });

  dust('gunpowder', 0x9b9b9b);
  dust('redstone', 0xd42a1c);
  dust('sugar', 0xf2f2f2);
  dust('blaze_powder', 0xf1a72a);
  dust('bone_meal', 0xe9e6d8);
  dust('glowstone_dust', 0xf5db8d);

  T('blaze_rod', (px, rng) => {
    shaft(px, 0xf0a90f, 2, 13, 14);
    for (let y = 2; y <= 13; y += 2) px.set(14 - y, y, 0xfde266);
    speckleInside(px, rng, 8, 0xffe9a0);
    finish(px);
  });
  T('bone', (px) => {
    const w = 0xe6e3d4;
    for (let y = 4; y <= 11; y++) {
      const x = 14 - y;
      px.set(x, y, w); px.set(x + 1, y, w); px.set(x + 2, y, shade(w, -0.16));
    }
    px.rect(10, 2, 4, 3, w);     // knuckle at the top
    px.rect(2, 11, 4, 3, w);     // knuckle at the bottom
    finish(px);
  });

  T('cocoa_beans', (px) => {
    ellipse(px, 6, 6.5, 2.8, 3.4, 0x8a4a20);
    ellipse(px, 10, 10, 2.8, 3.4, 0xa25a28);
    px.set(5, 5, 0xb8763f); px.set(9, 8, 0xc4854c);
    finish(px);
  });

  T('paper', (px) => { paintMap(px, SHEET, { '#': 0xf2f2f2 }); px.hline(5, 11, 6, 0xd0d0d0); px.hline(5, 11, 8, 0xd0d0d0); finish(px); });
  T('book', (px) => {
    paintMap(px, BOOK, { '#': 0x7a4a22, c: 0x9c6330, p: 0xf0e8d0 });
    finish(px);
  });

  T('nether_star', (px) => {
    const w = 0xf6f6ee;
    px.vline(7, 1, 14, w); px.vline(8, 1, 14, w);
    px.hline(1, 14, 7, w); px.hline(1, 14, 8, w);
    for (let i = 0; i < 5; i++) {
      px.set(3 + i, 3 + i, w); px.set(12 - i, 3 + i, w);
      px.set(3 + i, 12 - i, w); px.set(12 - i, 12 - i, w);
    }
    ellipse(px, 7.5, 7.5, 2.6, 2.6, 0xffffff);
    finish(px, false);
  });

  T('nautilus_shell', (px) => {
    const a = 0xe3d3b7, b = 0xc08a5c;
    ellipse(px, 8, 8, 6, 6, a);
    for (let t = 0; t < 60; t++) {
      const ang = t * 0.32, r = 0.6 + t * 0.095;
      px.set(Math.round(8 + Math.cos(ang) * r), Math.round(8 + Math.sin(ang) * r), b);
    }
    finish(px);
  });

  T('scute', (px) => {
    paintMap(px, [
      '................',
      '................',
      '................',
      '....########....',
      '...##########...',
      '..############..',
      '..############..',
      '..############..',
      '...##########...',
      '....########....',
      '.....######.....',
    ], { '#': 0x4f9d54 });
    px.rect(6, 5, 4, 4, 0x63bb68);
    finish(px);
  });

  T('phantom_membrane', (px, rng) => {
    paintMap(px, HIDE, { '#': 0xb9b0a2 });
    speckleInside(px, rng, 20, 0x8d8578);
    px.line(3, 4, 12, 11, 0x6f695f);
    finish(px);
  });

  T('shulker_shell', (px) => {
    paintMap(px, [
      '................',
      '................',
      '...##########...',
      '..############..',
      '.##############.',
      '.##############.',
      '.##############.',
      '..############..',
      '...##########...',
      '....########....',
      '.....######.....',
    ], { '#': 0x986a97 });
    px.rect(5, 5, 6, 3, 0xc4a0c2);
    finish(px);
  });

  T('honeycomb', (px) => {
    const a = 0xe0952a, b = 0xf2bd50;
    px.rect(2, 3, 12, 10, a);
    for (let cy = 4; cy < 13; cy += 4) {
      for (let cx = 3; cx < 14; cx += 4) {
        px.rect(cx, cy, 2, 2, b);
        px.rect(cx + 2, cy + 2, 2, 2, b);
      }
    }
    finish(px);
  });

  T('wheat', (px) => {
    const stalk = 0xa88b3d, grain = 0xdcbf6a;
    px.line(7, 14, 7, 4, stalk);
    for (let y = 4; y <= 11; y += 2) {
      px.set(5, y, grain); px.set(6, y - 1, grain);
      px.set(9, y, grain); px.set(8, y - 1, grain);
    }
    px.rect(7, 2, 2, 3, grain);
    finish(px);
  });

  const seed = (name, color, leaf) => T(name, (px, rng) => {
    for (let i = 0; i < 7; i++) {
      const x = 3 + rng.int(9), y = 4 + rng.int(8);
      px.rect(x, y, 2, 2, i % 2 ? color : leaf);
    }
    finish(px);
  });
  seed('wheat_seeds', 0x8aa63f, 0x6f8a30);
  seed('pumpkin_seeds', 0xe6dcc0, 0xc7bb9a);
  seed('melon_seeds', 0xdfd9b8, 0xbdb692);
  seed('beetroot_seeds', 0xb35a4a, 0x8c4438);
  seed('torchflower_seeds', 0xc98a3c, 0x9a6626);

  T('dragon_breath', (px) => {
    paintMap(px, BOTTLE, { c: 0x8a5ac0, g: 0xcfd6de, l: 0x7a3fb0 });
    finish(px);
  });
}

// ---------------------------------------------------------------------------
// 2. Tools
// ---------------------------------------------------------------------------

/** The wooden shaft every non-sword tool shares. */
function toolHandle(px) {
  for (let y = 2; y <= 12; y++) {
    const x = 13 - y;
    px.set(x, y, 0x8d6a3a);
    px.set(x + 1, y, 0x6b4a24);
  }
}

const HEAD_MAPS = {
  pickaxe: PICKAXE_HEAD, axe: AXE_HEAD, shovel: SHOVEL_HEAD, hoe: HOE_HEAD,
};

function registerToolIcons() {
  for (const [prefix, color] of Object.entries(TOOL_COLOR)) {
    for (const [type, map] of Object.entries(HEAD_MAPS)) {
      T(`${prefix}_${type}`, (px) => {
        toolHandle(px);
        paintMap(px, map, { '#': color });
        finish(px);
      });
    }
    T(`${prefix}_sword`, (px) => {
      paintMap(px, SWORD, {
        '#': color, '+': shade(color, -0.4), h: 0x6b4a24,
      });
      finish(px);
    });
  }

  T('shears', (px) => {
    const m = 0xd8d8d8, h = 0x9a9a9a;
    px.line(3, 12, 10, 3, m); px.line(4, 12, 11, 3, m);
    px.line(12, 12, 5, 3, m); px.line(11, 12, 4, 3, m);
    px.rect(2, 12, 3, 2, h); px.rect(11, 12, 3, 2, h);
    finish(px);
  });
  T('flint_and_steel', (px) => {
    // A steel striker (an open C on the right) beside a flint chip.
    px.rect(9, 2, 4, 2, 0xd8d8d8);
    px.rect(12, 3, 2, 8, 0xd8d8d8);
    px.rect(9, 10, 4, 2, 0xd8d8d8);
    px.rect(9, 4, 2, 2, 0xa8a8a8);
    px.rect(2, 6, 6, 5, 0x50494a);       // flint
    px.rect(3, 7, 3, 2, 0x6e6668);
    finish(px);
  });
  T('fishing_rod', (px) => {
    shaft(px, 0x76552d, 3, 12, 15);
    px.line(12, 3, 13, 8, 0xe4e4e4);
    px.line(13, 8, 11, 12, 0xe4e4e4);
    px.rect(10, 12, 2, 2, 0xd03030);
    px.rect(10, 11, 2, 1, 0xf0f0f0);
    finish(px, false);
  });
  T('brush', (px) => {
    shaft(px, 0x76552d, 6, 13, 15);
    px.rect(8, 3, 5, 3, 0xd0b070);       // ferrule
    px.rect(8, 1, 5, 2, 0xf0e2c0);       // bristles
    finish(px);
  });
  T('spyglass', (px) => {
    px.rect(3, 10, 5, 4, 0x9a7d4a);
    px.rect(6, 7, 5, 4, 0xc0a05a);
    px.rect(9, 3, 5, 5, 0xd8d8d8);
    px.rect(10, 3, 3, 2, 0x6fbdd8);
    finish(px);
  });
  T('lead', (px) => {
    const r = 0xa78a63;
    for (let t = 0; t < 44; t++) {
      const ang = t * 0.42, rad = 2 + t * 0.11;
      px.set(Math.round(8 + Math.cos(ang) * rad), Math.round(8 + Math.sin(ang) * rad * 0.9), r);
    }
    px.rect(10, 2, 3, 3, 0xd8d8d8);
    finish(px, false);
  });
  T('name_tag', (px) => {
    px.rect(3, 5, 11, 6, 0xd9c9a3);
    px.rect(4, 6, 9, 4, 0xefe3c4);
    px.hline(6, 11, 8, 0xb7a684);
    px.rect(1, 7, 3, 2, 0xa08a63);
    px.set(2, 8, 0x50442f);
    finish(px);
  });
  T('saddle', (px) => {
    px.rect(2, 5, 12, 6, 0x7a4a22);
    px.rect(4, 3, 8, 3, 0x9c6330);
    px.rect(2, 11, 12, 2, 0x50310f);
    px.rect(6, 4, 4, 2, 0xb98047);
    finish(px);
  });
}

// ---------------------------------------------------------------------------
// 3. Armour
// ---------------------------------------------------------------------------

const ARMOR_MAPS = {
  helmet: HELMET, chestplate: CHESTPLATE, leggings: LEGGINGS, boots: BOOTS,
};

function registerArmorIcons() {
  for (const [prefix, color] of Object.entries(ARMOR_COLOR)) {
    for (const [piece, map] of Object.entries(ARMOR_MAPS)) {
      T(`${prefix}_${piece}`, (px, rng) => {
        paintMap(px, map, { '#': color, b: shade(color, -0.35) });
        // Chainmail reads as a mesh; plate stays smooth.
        if (prefix === 'chainmail') {
          speckleInside(px, rng, 40, shade(color, -0.3));
          speckleInside(px, rng, 26, shade(color, 0.25));
        }
        finish(px);
      });
    }
  }

  T('turtle_helmet', (px) => {
    paintMap(px, HELMET, { '#': 0x4f9d54 });
    px.rect(4, 4, 8, 2, 0x63bb68);
    finish(px);
  });

  for (const [name, color] of [
    ['leather_horse_armor', 0xa4643c], ['iron_horse_armor', 0xd8d8d8],
    ['golden_horse_armor', 0xf9d94b], ['diamond_horse_armor', 0x4aedd9],
  ]) {
    T(name, (px) => {
      paintMap(px, [
        '................',
        '................',
        '...##########...',
        '..############..',
        '.##############.',
        '.####......####.',
        '.###........###.',
        '.###........###.',
        '.####......####.',
        '..###......###..',
        '..###......###..',
        '..##........##..',
      ], { '#': color });
      finish(px);
    });
  }

  T('elytra', (px) => { paintMap(px, ELYTRA, { '#': 0xb0a8b8 }); finish(px); });
  T('totem_of_undying', (px) => {
    paintMap(px, TOTEM, { '#': 0xf1c142 });
    px.set(6, 3, 0x2a6b3a); px.set(9, 3, 0x2a6b3a);
    px.rect(6, 5, 4, 1, 0x2a6b3a);
    finish(px);
  });
}

// ---------------------------------------------------------------------------
// 4. Weapons
// ---------------------------------------------------------------------------

function arrowIcon(name, headColor, fletchColor) {
  T(name, (px) => {
    paintMap(px, ARROW, { '#': headColor, s: 0x76552d, f: fletchColor });
    finish(px);
  });
}

function registerCombatIcons() {
  T('bow', (px) => { paintMap(px, BOW, { '#': 0x8a5f2c, s: 0xe8e8e8 }); finish(px, false); });
  T('crossbow', (px) => {
    paintMap(px, CROSSBOW, { '#': 0x8a5f2c, s: 0xe8e8e8, v: 0x9a9a9a });
    finish(px);
  });
  arrowIcon('arrow', 0xd0d0d0, 0xf0f0f0);
  arrowIcon('spectral_arrow', 0xf2d24a, 0xf7e79a);
  arrowIcon('tipped_arrow', 0xd8a0e8, 0xf0f0f0);

  T('trident', (px) => {
    const m = 0x4a7d78, h = 0x2f5652;
    px.vline(7, 3, 14, m); px.vline(8, 3, 14, h);
    px.vline(3, 1, 5, m); px.vline(12, 1, 5, m);
    px.vline(7, 1, 3, m); px.vline(8, 1, 3, m);
    px.hline(3, 12, 5, m);
    px.rect(6, 12, 4, 2, h);
    finish(px);
  });

  T('shield', (px) => {
    paintMap(px, SHIELD, { '#': 0x9c6330 });
    // A pale plate riveted to the face.
    px.rect(4, 3, 7, 5, 0xd0d0d0);
    px.set(3, 2, 0xd0d0d0); px.set(11, 2, 0xd0d0d0);
    finish(px);
  });

  T('firework_rocket', (px) => {
    px.rect(6, 4, 4, 9, 0xd8d8d8);
    px.rect(6, 4, 4, 2, 0xd03030);
    px.rect(6, 8, 4, 1, 0xd03030);
    px.line(10, 4, 13, 1, 0xa88b3d);
    finish(px);
  });
  T('firework_star', (px) => {
    const c = 0xe0e0e0;
    px.vline(7, 2, 13, c); px.vline(8, 2, 13, c);
    px.hline(2, 13, 7, c); px.hline(2, 13, 8, c);
    ellipse(px, 7.5, 7.5, 3, 3, 0xd8a020);
    ellipse(px, 7.5, 7.5, 1.4, 1.4, 0xf0e0a0);
    finish(px, false);
  });
  T('fire_charge', (px, rng) => {
    ellipse(px, 7.5, 8, 5.2, 5.2, 0xd2521c);
    ellipse(px, 7.5, 8, 3.2, 3.2, 0xf2a02a);
    ellipse(px, 7, 7.5, 1.6, 1.6, 0xf7e07a);
    speckleInside(px, rng, 10, 0xf7c04a);
    finish(px);
  });
}

// ---------------------------------------------------------------------------
// 5. Buckets and bottles
// ---------------------------------------------------------------------------

function bucketIcon(name, fluid, extra) {
  T(name, (px, rng) => {
    paintMap(px, BUCKET, { '#': 0xc9c9c9, w: fluid ?? 0x8f8f8f });
    if (fluid) speckleInside(px, rng, 8, shade(fluid, 0.3));
    if (extra) extra(px, rng);
    finish(px);
  });
}

function registerBucketIcons() {
  bucketIcon('bucket', null);
  bucketIcon('water_bucket', 0x3f76e4);
  bucketIcon('lava_bucket', 0xd45a12);
  bucketIcon('powder_snow_bucket', 0xf2f6fa);
  bucketIcon('milk_bucket', 0xf6f6f6);
  const fishInBucket = (name, water, body) => bucketIcon(name, water, (px) => {
    ellipse(px, 8, 8, 3, 2, body);
    px.set(11, 8, body); px.set(11, 7, body); px.set(11, 9, body);
    px.set(6, 7, 0x1a1a1a);
  });
  fishInBucket('cod_bucket', 0x3f76e4, 0xc3b393);
  fishInBucket('salmon_bucket', 0x3f76e4, 0xc0553f);
  fishInBucket('tropical_fish_bucket', 0x3f76e4, 0xef6915);
  fishInBucket('pufferfish_bucket', 0x3f76e4, 0xf2c12a);
  fishInBucket('axolotl_bucket', 0x3f76e4, 0xf7c1e0);
  fishInBucket('tadpole_bucket', 0x3f76e4, 0x574531);

  T('glass_bottle', (px) => {
    paintMap(px, BOTTLE, { c: 0x9c6330, g: 0xcfd6de, l: 0xa9c0cc });
    finish(px);
  });
  T('experience_bottle', (px) => {
    paintMap(px, BOTTLE, { c: 0x9c6330, g: 0xcfd6de, l: 0x84d13c });
    finish(px);
  });
  T('honey_bottle', (px) => {
    paintMap(px, BOTTLE, { c: 0x9c6330, g: 0xcfd6de, l: 0xe0952a });
    finish(px);
  });
}

// ---------------------------------------------------------------------------
// 6. Food
// ---------------------------------------------------------------------------

function meatIcon(name, base, fat) {
  T(name, (px, rng) => {
    paintMap(px, MEAT, { '#': base });
    speckleInside(px, rng, 14, fat);
    speckleInside(px, rng, 8, shade(base, -0.25));
    finish(px);
  });
}

function fishIcon(name, body, belly, stripe) {
  T(name, (px) => {
    ellipse(px, 6, 8, 4.9, 3.6, body);
    // Tail: three columns fanning out where the body ends.
    for (let i = 0; i < 3; i++) px.vline(10 + i, 8 - (1 + i), 8 + (1 + i), body);
    px.vline(6, 3, 4, shade(body, -0.2));    // dorsal fin
    px.rect(3, 9, 6, 2, belly);
    if (stripe !== undefined) {
      px.vline(5, 5, 10, stripe);
      px.vline(8, 5, 10, stripe);
    }
    px.set(3, 7, INK);                       // eye
    finish(px);
  });
}

function registerFoodIcons() {
  const apple = (name, body, shine) => T(name, (px) => {
    ellipse(px, 7.5, 9, 5.2, 4.8, body);
    px.rect(7, 3, 2, 3, 0x6b4a24);           // stem
    px.rect(9, 3, 3, 2, 0x4f8a2e);           // leaf
    px.rect(4, 6, 2, 2, shine);
    finish(px);
  });
  apple('apple', 0xc0392b, 0xe8776a);
  apple('golden_apple', 0xf1c142, 0xf8e08a);
  apple('enchanted_golden_apple', 0xf1c142, 0xfff0b0);

  T('bread', (px, rng) => {
    paintMap(px, LOAF, { '#': 0xc08c48 });
    for (let i = 0; i < 3; i++) px.line(4 + i * 3, 5, 6 + i * 3, 9, 0xd8a866);
    speckleInside(px, rng, 10, 0xa8783a);
    finish(px);
  });
  T('cookie', (px, rng) => {
    ellipse(px, 7.5, 8, 5.4, 5.4, 0xb8763f);
    for (let i = 0; i < 7; i++) {
      const x = 3 + rng.int(9), y = 4 + rng.int(9);
      if (px.getAlpha(x, y)) px.rect(x, y, 2, 1, 0x4a2c17);
    }
    finish(px);
  });
  T('pumpkin_pie', (px) => {
    ellipse(px, 7.5, 8.5, 6, 5, 0xc98a3c);
    ellipse(px, 7.5, 8, 4.6, 3.8, 0xe2a94a);
    px.rect(5, 6, 2, 1, 0xf3d090);
    px.rect(9, 9, 2, 1, 0xa86e2a);
    finish(px);
  });
  T('melon_slice', (px) => {
    // A wedge: green rind at the bottom, red flesh above, black pips.
    for (let y = 3; y <= 12; y++) {
      const half = Math.round((y - 2) * 0.7);
      px.hline(7 - half, 8 + half, y, y >= 11 ? 0x3f8f2f : 0xd8392b);
    }
    px.hline(2, 13, 13, 0x6fbf46);
    px.set(6, 7, 0x2a1a14); px.set(9, 9, 0x2a1a14); px.set(7, 10, 0x2a1a14);
    finish(px);
  });
  T('glistering_melon_slice', (px) => {
    for (let y = 3; y <= 12; y++) {
      const half = Math.round((y - 2) * 0.7);
      px.hline(7 - half, 8 + half, y, y >= 11 ? 0x3f8f2f : 0xd8392b);
    }
    px.hline(2, 13, 13, 0x6fbf46);
    for (const [x, y] of [[6, 7], [9, 9], [7, 10], [8, 6]]) px.rect(x, y, 2, 1, 0xf9d94b);
    finish(px);
  });

  T('carrot', (px) => {
    for (let i = 0; i < 9; i++) {
      const y = 5 + i, w = Math.max(1, 5 - Math.floor(i / 2));
      px.hline(7 - Math.floor(w / 2), 7 - Math.floor(w / 2) + w - 1, y, 0xf0851f);
    }
    px.rect(4, 2, 3, 3, 0x3f8f2f);
    px.rect(8, 2, 3, 3, 0x4faf3a);
    px.rect(7, 4, 2, 2, 0x3f8f2f);
    finish(px);
  });
  T('golden_carrot', (px) => {
    for (let i = 0; i < 9; i++) {
      const y = 5 + i, w = Math.max(1, 5 - Math.floor(i / 2));
      px.hline(7 - Math.floor(w / 2), 7 - Math.floor(w / 2) + w - 1, y, 0xf9d94b);
    }
    px.rect(4, 2, 3, 3, 0x3f8f2f);
    px.rect(8, 2, 3, 3, 0x4faf3a);
    px.rect(7, 4, 2, 2, 0x3f8f2f);
    finish(px);
  });

  const potato = (name, body, top) => T(name, (px, rng) => {
    ellipse(px, 7.5, 8.5, 5.4, 4.6, body);
    speckleInside(px, rng, 14, top);
    finish(px);
  });
  potato('potato', 0xb98c4e, 0x8f6b39);
  potato('baked_potato', 0xd0a05a, 0xf2d290);
  potato('poisonous_potato', 0xa8a83c, 0x6f9a2e);

  T('beetroot', (px) => {
    ellipse(px, 7.5, 9.5, 4.4, 4.2, 0x9c2a2a);
    px.rect(6, 3, 2, 3, 0x4f8a2e);
    px.rect(9, 4, 3, 2, 0x3f7a24);
    px.rect(4, 4, 3, 2, 0x4f8a2e);
    finish(px);
  });

  T('dried_kelp', (px, rng) => {
    px.rect(3, 3, 10, 11, 0x2f4a26);
    px.rect(4, 4, 8, 9, 0x3f6030);
    for (let y = 5; y < 13; y += 3) px.hline(4, 11, y, 0x28401f);
    speckleInside(px, rng, 12, 0x506f3a);
    finish(px);
  });

  const berries = (name, color, glow) => T(name, (px, rng) => {
    for (let i = 0; i < 5; i++) {
      const x = 3 + rng.int(9), y = 4 + rng.int(8);
      ellipse(px, x, y, 2.1, 2.1, color);
      px.set(x - 1, y - 1, glow);
    }
    finish(px);
  });
  berries('sweet_berries', 0xc0392b, 0xe8776a);
  berries('glow_berries', 0xe08a1f, 0xf9d266);

  meatIcon('beef', 0xc45a55, 0xe7938c);
  meatIcon('cooked_beef', 0x8a4a2a, 0xb87a4a);
  meatIcon('porkchop', 0xe08a8a, 0xf6c0bc);
  meatIcon('cooked_porkchop', 0xb87340, 0xdaa060);
  meatIcon('chicken', 0xe0b09a, 0xf2d8c4);
  meatIcon('cooked_chicken', 0xc08a48, 0xe2b070);
  meatIcon('mutton', 0xd06a6a, 0xefa0a0);
  meatIcon('cooked_mutton', 0x9c5a30, 0xc78a50);
  meatIcon('rabbit', 0xd07a70, 0xf0a8a0);
  meatIcon('cooked_rabbit', 0xa8663a, 0xcf9660);
  meatIcon('rotten_flesh', 0x74562f, 0x5c7a34);

  fishIcon('cod', 0xc3b393, 0xe3d8bd);
  fishIcon('cooked_cod', 0xb08a52, 0xd0b183);
  fishIcon('salmon', 0xc0553f, 0xe08a70, 0x8f3a2a);
  fishIcon('cooked_salmon', 0xa84a2a, 0xcf7a52, 0x7a3018);
  fishIcon('tropical_fish', 0xef6915, 0xf7d24a, 0xf9f9f9);
  T('pufferfish', (px) => {
    ellipse(px, 7.5, 8, 5.2, 5.2, 0xf2c12a);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      px.set(Math.round(7.5 + Math.cos(a) * 6.4), Math.round(8 + Math.sin(a) * 6.4), 0xd08a10);
    }
    px.set(5, 7, 0x1a1a1a); px.set(10, 7, 0x1a1a1a);
    finish(px);
  });

  const stew = (name, broth, bits) => T(name, (px, rng) => {
    const w = 0x8b5a2b;
    px.rect(2, 7, 12, 2, shade(w, 0.2));
    px.rect(3, 9, 10, 2, w);
    px.rect(4, 11, 8, 1, shade(w, -0.2));
    px.rect(5, 12, 6, 1, shade(w, -0.35));
    px.rect(3, 5, 10, 2, broth);
    px.rect(4, 4, 8, 1, broth);
    for (let i = 0; i < 5; i++) px.set(4 + rng.int(8), 4 + rng.int(3), bits);
    finish(px);
  });
  stew('mushroom_stew', 0xb07a3a, 0xd0483a);
  stew('rabbit_stew', 0xa2603a, 0xe08a3a);
  stew('beetroot_soup', 0x9c2a4a, 0xd04a6a);
  stew('suspicious_stew', 0x8a9a3a, 0x4f8a2e);

  T('spider_eye', (px) => {
    ellipse(px, 7.5, 8, 5.2, 5.2, 0x8a2a2a);
    ellipse(px, 7.5, 8, 2.6, 2.6, 0xd8382a);
    px.rect(6, 7, 2, 2, 0x1a1010);
    finish(px);
  });
  T('fermented_spider_eye', (px) => {
    ellipse(px, 7.5, 8, 5.2, 5.2, 0x5a3a6a);
    ellipse(px, 7.5, 8, 2.6, 2.6, 0x8a4a9a);
    px.rect(6, 7, 2, 2, 0x2a1a2a);
    finish(px);
  });
}

// ---------------------------------------------------------------------------
// 7. Dyes
// ---------------------------------------------------------------------------

function registerDyeIcons() {
  for (const c of COLORS) dust(`${c}_dye`, COLOR_HEX[c]);
}

// ---------------------------------------------------------------------------
// 8. Transport
// ---------------------------------------------------------------------------

function registerTransportIcons() {
  for (const w of WOOD_TYPES) {
    if (w.kind !== 'wood') continue;
    const color = WOOD_COLOR[w.name] ?? 0xb08a4f;
    T(`${w.name}_boat`, (px) => { paintMap(px, BOAT, { '#': color }); finish(px); });
    T(`${w.name}_chest_boat`, (px) => {
      paintMap(px, BOAT, { '#': color });
      px.rect(5, 4, 6, 5, 0x9c6330);
      px.rect(5, 6, 6, 1, 0x6b4118);
      px.set(7, 6, 0xd8d8d8); px.set(8, 6, 0xd8d8d8);
      finish(px);
    });
  }

  const cart = (name, extra) => T(name, (px) => {
    paintMap(px, MINECART, { '#': 0x9a9a9a, w: 0x4a4a4a });
    if (extra) extra(px);
    finish(px);
  });
  cart('minecart', null);
  cart('chest_minecart', (px) => { px.rect(5, 1, 6, 5, 0x9c6330); px.rect(5, 3, 6, 1, 0x6b4118); });
  cart('furnace_minecart', (px) => { px.rect(5, 1, 6, 5, 0x6f6f6f); px.rect(6, 3, 4, 2, 0x2a2a2a); });
  cart('hopper_minecart', (px) => { px.rect(4, 1, 8, 3, 0x3a3a3a); px.rect(6, 4, 4, 2, 0x3a3a3a); });
  cart('tnt_minecart', (px) => {
    px.rect(5, 1, 6, 5, 0xc0392b);
    px.rect(5, 2, 6, 2, 0xf0f0f0);
    px.set(7, 2, 0x2a2a2a); px.set(8, 3, 0x2a2a2a);
  });

  const onAStick = (name, bob, cord) => T(name, (px) => {
    shaft(px, 0x76552d, 3, 12, 15);
    px.line(12, 3, 13, 6, cord);
    ellipse(px, 12.5, 9, 2.4, 2.6, bob);
    finish(px);
  });
  onAStick('carrot_on_a_stick', 0xf0851f, 0xe4e4e4);
  onAStick('warped_fungus_on_a_stick', 0x2b6c68, 0xe4e4e4);
}

// ---------------------------------------------------------------------------
// 9. Utility items
// ---------------------------------------------------------------------------

function registerUtilityIcons() {
  const bookIcon = (name, cover, page, mark) => T(name, (px) => {
    paintMap(px, BOOK, { '#': shade(cover, -0.35), c: cover, p: page });
    if (mark) mark(px);
    finish(px);
  });
  bookIcon('writable_book', 0x9c6330, 0xf0e8d0, (px) => {
    px.line(9, 8, 13, 2, 0xf0f0f0);
    px.set(13, 1, 0xd8d8d8);
  });
  bookIcon('written_book', 0x8a4a22, 0xf0e8d0, (px) => {
    px.rect(6, 5, 4, 4, 0xf9d94b);
  });
  bookIcon('enchanted_book', 0xa02a2a, 0xf0e8d0, (px) => {
    px.rect(6, 5, 4, 4, 0xc8a0f0);
    px.set(5, 4, 0xe8d8ff); px.set(10, 9, 0xe8d8ff);
  });

  const mapIcon = (name, ink) => T(name, (px) => {
    paintMap(px, SHEET, { '#': 0xd9c9a3 });
    px.frame(3, 2, 10, 11, 0x7d6a48);
    if (ink) {
      px.rect(5, 5, 3, 2, 0x6f8a3a);
      px.rect(9, 7, 3, 3, 0x4a6fa8);
      px.set(7, 9, 0xa02a2a);
    }
    finish(px);
  });
  mapIcon('map', false);
  mapIcon('filled_map', true);

  T('compass', (px) => {
    ellipse(px, 7.5, 8, 5.6, 5.6, 0xb0b0b0);
    ellipse(px, 7.5, 8, 4.2, 4.2, 0x2a3a5a);
    px.rect(7, 4, 2, 4, 0xd03030);
    px.rect(7, 8, 2, 4, 0xf0f0f0);
    finish(px);
  });
  T('recovery_compass', (px) => {
    ellipse(px, 7.5, 8, 5.6, 5.6, 0x2a3038);
    ellipse(px, 7.5, 8, 4.2, 4.2, 0x14202a);
    px.rect(7, 4, 2, 4, 0x4fd0d8);
    px.rect(7, 8, 2, 4, 0x1a5a62);
    finish(px);
  });
  T('clock', (px) => {
    ellipse(px, 7.5, 8, 5.8, 5.8, 0xf9d94b);
    ellipse(px, 7.5, 8, 4.4, 4.4, 0x2a4a8a);
    ellipse(px, 7.5, 6.5, 2.0, 2.0, 0xf6e9a0);
    finish(px);
  });

  T('painting', (px) => {
    px.rect(1, 3, 14, 10, 0x8a5a2a);
    px.rect(3, 5, 10, 6, 0x3a5a8a);
    px.rect(4, 8, 4, 2, 0x4f8a2e);
    px.rect(9, 6, 2, 2, 0xf2e08a);
    finish(px);
  });
  const frame = (name, glow) => T(name, (px) => {
    px.rect(2, 2, 12, 12, 0x9c6330);
    px.rect(4, 4, 8, 8, 0xd9c9a3);
    if (glow) px.frame(4, 4, 8, 8, 0xd8f0a0);
    finish(px);
  });
  frame('item_frame', false);
  frame('glow_item_frame', true);

  T('armor_stand', (px) => {
    const w = 0xb08a4f;
    px.rect(7, 2, 2, 4, w);
    px.rect(3, 6, 10, 2, w);
    px.rect(7, 8, 2, 4, w);
    px.rect(4, 12, 8, 2, 0x8a6a3a);
    finish(px);
  });

  T('disc_fragment_5', (px) => {
    paintMap(px, [
      '................',
      '................',
      '.......###......',
      '......#####.....',
      '.....######.....',
      '....######......',
      '...#####........',
      '...####.........',
      '....##..........',
    ], { '#': 0x3a3a3a });
    px.set(7, 4, 0x8a8a8a); px.set(6, 6, 0x8a8a8a);
    finish(px);
  });
}

// ---------------------------------------------------------------------------
// 10. Spawn eggs
// ---------------------------------------------------------------------------

function registerSpawnEggIcons() {
  for (const [mob, base, spots] of MOB_EGGS) {
    T(`${mob}_spawn_egg`, (px, rng) => {
      paintMap(px, EGG_SHAPE, { '#': base });
      for (let i = 0; i < 16; i++) {
        const x = 3 + rng.int(10), y = 3 + rng.int(11);
        if (px.getAlpha(x, y)) px.rect(x, y, 2, 2, spots);
      }
      // Re-apply the silhouette so the spots never bleed outside the egg.
      const shell = new Set();
      for (let y = 0; y < EGG_SHAPE.length; y++) {
        for (let x = 0; x < EGG_SHAPE[y].length; x++) {
          if (EGG_SHAPE[y][x] !== '.') shell.add(y * 16 + x);
        }
      }
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          if (!shell.has(y * 16 + x)) px.data[px.index(x, y) + 3] = 0;
        }
      }
      finish(px);
    });
  }
}

// ---------------------------------------------------------------------------
// 11. Music discs
// ---------------------------------------------------------------------------

function registerDiscIcons() {
  for (const [id, color] of MUSIC_DISCS) {
    T(`music_disc_${id}`, (px) => {
      paintMap(px, DISC, { '#': 0x232323, o: color });
      px.rect(7, 7, 2, 2, 0x0d0d0d);
      px.set(4, 4, 0x4a4a4a); px.set(11, 11, 0x141414);
      finish(px);
    });
  }
}

// ---------------------------------------------------------------------------
// 12. Potions
// ---------------------------------------------------------------------------

function registerPotionIcons() {
  T('potion', (px) => {
    paintMap(px, BOTTLE, { c: 0x9c6330, g: 0xcfd6de, l: 0xd53a9d });
    finish(px);
  });
  T('splash_potion', (px) => {
    paintMap(px, BOTTLE, { c: 0x9c6330, g: 0xcfd6de, l: 0xd53a9d });
    // Round-bottomed flask: shave the base corners.
    px.data[px.index(3, 12) + 3] = 0;
    px.data[px.index(12, 12) + 3] = 0;
    px.rect(6, 1, 4, 1, 0xcfd6de);
    finish(px);
  });
  T('lingering_potion', (px) => {
    paintMap(px, BOTTLE, { c: 0x9c6330, g: 0xcfd6de, l: 0x7a3fb0 });
    px.hline(3, 12, 13, mixHex(0x7a3fb0, 0xffffff, 0.4));
    px.hline(4, 11, 14, mixHex(0x7a3fb0, 0xffffff, 0.55));
    finish(px);
  });
}
