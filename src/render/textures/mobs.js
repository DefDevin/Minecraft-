// Procedural mob skins.
//
// Rather than hand-painting seventy sheets, each mob gets a palette and a small
// set of feature flags, and the painter derives the layout from the model
// itself: it asks models.js where each part's cubes live in UV space and paints
// the right rectangles. That way a skin always lines up with its model, even
// when the model's proportions differ from Minecraft's.

import { registerSheet, Sheet } from '../texgen.js';
import { getModel, modelNames } from '../../entity/models.js';
import { mixHex } from '../../core/math.js';

/**
 * @typedef {object} Palette
 * @property {number} body     main colour
 * @property {number} [head]   head colour, defaults to body
 * @property {number} [limbs]  arms and legs, defaults to body
 * @property {number} [accent] a second colour for clothing or markings
 * @property {number} [eyes]
 * @property {number} [mouth]
 */

const P = {
  // Hostile
  zombie: { body: 0x00afaf, head: 0x529b56, limbs: 0x00afaf, accent: 0x35379b,
    eyes: 0x2b4b2b, skinTone: 0x529b56 },
  zombie_villager: { body: 0x5b3f2c, head: 0x529b56, accent: 0x77563a, eyes: 0x2b4b2b },
  husk: { body: 0xb5a04b, head: 0xb5a04b, accent: 0x7d6c33, eyes: 0x3a3320 },
  drowned: { body: 0x3a6b62, head: 0x3f8a72, accent: 0x2c5148, eyes: 0x4ad0c0 },
  skeleton: { body: 0xc6c6c6, head: 0xd8d8d8, limbs: 0xbdbdbd, eyes: 0x1a1a1a },
  stray: { body: 0xc0cdd4, head: 0xd8e4ea, accent: 0x6f8b96, eyes: 0x1a1a1a },
  wither_skeleton: { body: 0x2f3232, head: 0x3a3d3d, eyes: 0x1a1a1a },
  creeper: { body: 0x4fa03a, head: 0x53a63e, mottle: 0x2f6a24, eyes: 0x0a0a0a,
    mouth: 0x0a0a0a },
  spider: { body: 0x372823, head: 0x4a342c, eyes: 0xaa1111 },
  cave_spider: { body: 0x0c424e, head: 0x145a68, eyes: 0xaa1111 },
  enderman: { body: 0x161016, head: 0x161016, eyes: 0xe079fa },
  witch: { body: 0x5b3a89, head: 0x7f6152, accent: 0x2f2440, eyes: 0x1a1a1a },
  slime: { body: 0x6fc05a, head: 0x6fc05a, eyes: 0x1a3a1a },
  magma_cube: { body: 0x8f3a10, head: 0xd4581c, eyes: 0xffd070 },
  silverfish: { body: 0x6d6d6d, head: 0x7c7c7c, eyes: 0x1a1a1a },
  endermite: { body: 0x2b2036, head: 0x3a2c49, eyes: 0xc07bd8 },
  blaze: { body: 0xf6b201, head: 0xffd94a, eyes: 0xfff6b0 },
  ghast: { body: 0xf0f0f0, head: 0xf7f7f7, eyes: 0x8f2020, mouth: 0x8f2020 },
  zombified_piglin: { body: 0x4c8a52, head: 0xd5a08b, accent: 0x2f5b34, eyes: 0x2b4b2b },
  piglin: { body: 0xd5a08b, head: 0xe0b09b, accent: 0x8a6a45, eyes: 0x2b1b12 },
  piglin_brute: { body: 0xd5a08b, head: 0xe0b09b, accent: 0x5b4530, eyes: 0x2b1b12 },
  hoglin: { body: 0x9b6b4b, head: 0xab7a58, eyes: 0x2b1b12 },
  zoglin: { body: 0xc09a86, head: 0xd0a894, eyes: 0x2b1b12 },
  phantom: { body: 0x3a4a68, head: 0x46587c, eyes: 0x6fe0f0 },
  guardian: { body: 0x5a8b83, head: 0x6ea79d, eyes: 0xd8a03a },
  elder_guardian: { body: 0x9aa79a, head: 0xa9b7a9, eyes: 0xd8a03a },
  shulker: { body: 0x946794, head: 0xa578a5, eyes: 0xd0c0d8 },
  vex: { body: 0x889aab, head: 0xcfd8e0, eyes: 0xc03030 },
  evoker: { body: 0x1f2a33, head: 0x9a8b7a, accent: 0xd8c9a5, eyes: 0x1a1a1a },
  vindicator: { body: 0x2c3b45, head: 0x9a8b7a, accent: 0x5a4a3a, eyes: 0x1a1a1a },
  pillager: { body: 0x2e3d47, head: 0x9a8b7a, accent: 0x4a5a3a, eyes: 0x1a1a1a },
  ravager: { body: 0x5b5147, head: 0x6c6156, eyes: 0xd04040 },
  warden: { body: 0x0e3b3f, head: 0x11474c, eyes: 0x2ee0d0, mottle: 0x1c6a63 },
  wither: { body: 0x2b2b2b, head: 0x3a3a3a, eyes: 0x4a4a4a },
  ender_dragon: { body: 0x171021, head: 0x1e1529, eyes: 0xd070f0 },
  // Passive
  pig: { body: 0xf0a5a2, head: 0xf3b0ad, accent: 0xd88c8c, eyes: 0x2b1b12 },
  cow: { body: 0x4b3722, head: 0x4b3722, accent: 0xdad3c8, eyes: 0x2b1b12 },
  mooshroom: { body: 0xa02b22, head: 0xa02b22, accent: 0xdad3c8, eyes: 0x2b1b12 },
  sheep: { body: 0xe7e7e7, head: 0xd8c6b0, accent: 0xf0f0f0, eyes: 0x2b1b12 },
  chicken: { body: 0xf2f2f2, head: 0xf7f7f7, accent: 0xd44b2b, beak: 0xe8b23a,
    eyes: 0x2b1b12 },
  rabbit: { body: 0xa08466, head: 0xb0937a, eyes: 0x883333 },
  wolf: { body: 0xcfc9bd, head: 0xd8d3c8, accent: 0x8a8378, eyes: 0xc03030 },
  cat: { body: 0x9a6a3a, head: 0xa87a48, accent: 0xd8c0a0, eyes: 0x6fd06f },
  ocelot: { body: 0xd8b25a, head: 0xe0bd68, accent: 0x8a6a30, eyes: 0x6fd06f },
  fox: { body: 0xd0763a, head: 0xdd8548, accent: 0xf0e5d8, eyes: 0x2b1b12 },
  panda: { body: 0xe8e8e8, head: 0xf0f0f0, accent: 0x1a1a1a, eyes: 0x1a1a1a },
  polar_bear: { body: 0xf0f0f0, head: 0xf7f7f7, eyes: 0x2b1b12 },
  goat: { body: 0xd8cfc0, head: 0xe0d8ca, accent: 0x8a8070, eyes: 0x2b1b12 },
  horse: { body: 0x8a6a48, head: 0x9a7a56, accent: 0x5a4028, eyes: 0x2b1b12 },
  donkey: { body: 0x6a5647, head: 0x7a6555, accent: 0x4a3a2c, eyes: 0x2b1b12 },
  mule: { body: 0x5a4636, head: 0x6a5545, accent: 0x3a2c20, eyes: 0x2b1b12 },
  llama: { body: 0xcbb08a, head: 0xd8bd96, accent: 0x8a7050, eyes: 0x2b1b12 },
  trader_llama: { body: 0xcbb08a, head: 0xd8bd96, accent: 0x2d5aa0, eyes: 0x2b1b12 },
  villager: { body: 0x8a6a4a, head: 0xc09a78, accent: 0x5b3f2c, nose: 0xa8815f,
    eyes: 0x2b1b12 },
  wandering_trader: { body: 0x2d5aa0, head: 0xc09a78, accent: 0x1e3f70,
    nose: 0xa8815f, eyes: 0x2b1b12 },
  iron_golem: { body: 0xcfcfcf, head: 0xd8d8d8, accent: 0x8a9a7a, nose: 0xb0b0b0,
    eyes: 0xc03030 },
  snow_golem: { body: 0xf2f7fa, head: 0xf7fbfd, accent: 0xd8e4ea, eyes: 0x1a1a1a },
  squid: { body: 0x1e3a68, head: 0x24457a, eyes: 0xd8d8d8 },
  glow_squid: { body: 0x1c4a52, head: 0x226070, eyes: 0x7ef0e0 },
  dolphin: { body: 0x8fa5b5, head: 0x9db2c0, accent: 0xf0f0f0, eyes: 0x1a1a1a },
  bat: { body: 0x4a3a2c, head: 0x5a4736, eyes: 0xc03030 },
  bee: { body: 0xe8b23a, head: 0xf0c04a, accent: 0x3a2c1a, eyes: 0x1a1a1a },
  allay: { body: 0x4a8fd8, head: 0x5aa0e8, eyes: 0xd8f0ff },
  turtle: { body: 0x4a8a5a, head: 0x8fc07a, accent: 0xd8d0b0, eyes: 0x1a1a1a },
  axolotl: { body: 0xf0b0d0, head: 0xf7c0da, accent: 0xd88ab0, eyes: 0x1a1a1a },
  frog: { body: 0x8ab04a, head: 0x9ac05a, accent: 0xd8a03a, eyes: 0xd8b83a },
  tadpole: { body: 0x3a3228, head: 0x4a4034, eyes: 0x1a1a1a },
  strider: { body: 0x9a3a4a, head: 0xaa4a58, accent: 0x6a2030, eyes: 0xf0d0a0 },
  sniffer: { body: 0x8a6ac0, head: 0x9a7ad0, accent: 0x6a4a9a, eyes: 0x1a1a1a },
  cod: { body: 0x9a8a6a, head: 0xaa9a78, accent: 0xd8cdb0, eyes: 0x1a1a1a },
  salmon: { body: 0x9a4a3a, head: 0xaa5a48, accent: 0xd8a090, eyes: 0x1a1a1a },
  tropical_fish: { body: 0xe8a02a, head: 0xf0b03a, accent: 0xd8d8d8, eyes: 0x1a1a1a },
  pufferfish: { body: 0xe8c02a, head: 0xf0cd3a, accent: 0xd8d8d8, eyes: 0x1a1a1a },
  illager: { body: 0x2c3b45, head: 0x9a8b7a, accent: 0x5a4a3a, eyes: 0x1a1a1a },
  fish: { body: 0x9a8a6a, head: 0xaa9a78, eyes: 0x1a1a1a },
};

const DEFAULT = { body: 0x8a8a8a, head: 0x9a9a9a, eyes: 0x1a1a1a };

/**
 * Paint one mob's sheet. Every cube of every part is filled with its part's
 * colour, then the head's front face gets eyes and a mouth so the mob has a
 * readable face from the direction it walks.
 */
function paintMob(sheet, rng, name, model) {
  const pal = { ...DEFAULT, ...(P[name] ?? {}) };
  const head = pal.head ?? pal.body;
  const limbs = pal.limbs ?? pal.body;

  // Transparent by default: only the model's own cubes get painted, so unused
  // sheet space never bleeds into a face through mipmapping.
  const parts = [];
  const walk = (part, depth) => {
    parts.push({ part, depth });
    for (const c of part.children ?? []) walk(c, depth + 1);
  };
  if (model?.root) walk(model.root, 0);

  for (const { part } of parts) {
    const n = (part.name ?? '').toLowerCase();
    let color = pal.body;
    if (/head|snout|nose|beak|horn|ear|mane/.test(n)) color = head;
    else if (/leg|arm|wing|tentacle|fin|tail|foot|paw|claw/.test(n)) color = limbs;
    else if (/wool|fleece|jacket|robe|coat|saddle|shell|armor/.test(n)) {
      color = pal.accent ?? pal.body;
    }
    for (const cube of part.cubes ?? []) {
      const w = cube.w, h = cube.h, d = cube.d, u = cube.u, v = cube.v;
      // Minecraft's box unwrap: a 2*(d+w) by (d+h) footprint.
      sheet.rect(u, v, 2 * (d + w), d + h, color);
      // Shade the two "side" columns so limbs read as round-ish.
      sheet.shadeRect(u, v + d, d, h, -0.12);
      sheet.shadeRect(u + d + w, v + d, d, h, 0.08);
      sheet.grainRect(rng, u, v, 2 * (d + w), d + h, 0.055);
      if (pal.mottle) {
        // Creeper/warden style blotches.
        for (let i = 0; i < Math.max(2, (w * h) / 12); i++) {
          const bx = u + rng.int(2 * (d + w)), by = v + rng.int(d + h);
          sheet.rect(bx, by, 1 + rng.int(2), 1 + rng.int(2), pal.mottle);
        }
      }
    }
  }

  // Face on the head's front (-Z) face, which sits at (u+d, v+d, w, h).
  const headPart = parts.find(({ part }) => /^head$/i.test(part.name ?? ''))?.part
    ?? parts.find(({ part }) => /head/i.test(part.name ?? ''))?.part;
  const cube = headPart?.cubes?.[0];
  if (cube) {
    const fx = cube.u + cube.d, fy = cube.v + cube.d;
    const fw = cube.w, fh = cube.h;
    if (fw >= 4 && fh >= 4) {
      const eyeY = fy + Math.floor(fh * 0.32);
      const eyeW = Math.max(1, Math.floor(fw / 8));
      const inset = Math.max(1, Math.floor(fw / 5));
      const eye = pal.eyes ?? 0x1a1a1a;
      sheet.rect(fx + inset, eyeY, eyeW + 1, Math.max(1, Math.floor(fh / 8)), eye);
      sheet.rect(fx + fw - inset - eyeW - 1, eyeY, eyeW + 1,
        Math.max(1, Math.floor(fh / 8)), eye);
      if (pal.mouth) {
        sheet.rect(fx + Math.floor(fw / 3), fy + Math.floor(fh * 0.6),
          Math.ceil(fw / 3), Math.max(1, Math.floor(fh / 6)), pal.mouth);
      }
      if (pal.nose) {
        sheet.rect(fx + Math.floor(fw / 2) - 1, eyeY + 1, 2,
          Math.max(2, Math.floor(fh / 4)), pal.nose);
      }
      if (pal.beak) {
        sheet.rect(fx + Math.floor(fw / 2) - 1, fy + Math.floor(fh * 0.55), 2, 2,
          pal.beak);
      }
      // A slightly darker brow band gives every face some depth.
      sheet.shadeRect(fx, fy, fw, Math.max(1, Math.floor(fh / 6)), -0.1);
    }
  }
}

let registered = false;

export function registerMobTextures() {
  if (registered) return 0;
  registered = true;
  let n = 0;
  for (const name of modelNames()) {
    const model = getModel(name);
    const w = model?.textureWidth ?? 64;
    const h = model?.textureHeight ?? 64;
    registerSheet(name, w, h, (sheet, rng) => paintMob(sheet, rng, name, model));
    n++;
  }
  return n;
}

/** Sheep and wool-bearing mobs are recoloured per individual at render time. */
export function woolColorFor(color) {
  const map = {
    white: 0xe9ecec, orange: 0xf07613, magenta: 0xbd44b3, light_blue: 0x3ab3da,
    yellow: 0xf8c627, lime: 0x70b919, pink: 0xed8dac, gray: 0x3e4447,
    light_gray: 0x8e8e86, cyan: 0x158991, purple: 0x792aac, blue: 0x35399d,
    brown: 0x724728, green: 0x546d1b, red: 0xa12722, black: 0x141519,
  };
  return map[color] ?? map.white;
}

export { P as MOB_PALETTES };
