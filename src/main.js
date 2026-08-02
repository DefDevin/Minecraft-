// Entry point: registers content, generates textures, and starts the game.
//
// Content modules load optionally. If one is missing or throws, the game logs it
// and continues with a reduced feature set rather than showing a blank screen —
// which keeps the engine testable while content is still being built.

import { freezeBlocks, blocks, defineBlock, RENDER, PASS, TOOL, TIER, SOUND }
  from './world/blocks.js';
import { statesUsed } from './world/blockstate.js';
import { registerTexture, generateAll, Pixels, textureCount, hasTexture }
  from './render/texgen.js';
import { itemsByName, defineItem, ItemStack } from './game/items.js';
import { setBiomeColorProvider } from './render/mesher.js';
import { Game } from './game/game.js';
import { GAMEMODE } from './entity/player.js';
import { Random } from './core/rng.js';

const boot = window.__boot ?? { step() {}, fail(e) { throw e; }, done() {} };

/** Import a module, returning null (and warning) if it is unavailable. */
async function optional(path, label) {
  try {
    return await import(path);
  } catch (e) {
    console.warn(`[content] ${label ?? path} unavailable: ${e.message}`);
    return null;
  }
}

export async function boot_() { return start(); }

export async function start() {
  const canvas = document.getElementById('gl');
  const guiCanvas = document.getElementById('gui');

  // --- 1. Blocks --------------------------------------------------------
  boot.step('registering blocks…', 0.05);
  const blockdefs = await optional('./world/blockdefs.js', 'block definitions');
  if (blockdefs?.registerAllBlocks) {
    blockdefs.registerAllBlocks();
  } else {
    registerMinimalBlocks();
    freezeBlocks();
  }
  console.info(`[blocks] ${blocks.length} blocks, ${statesUsed()} states`);

  // --- 2. Items ---------------------------------------------------------
  boot.step('registering items…', 0.15);
  const itemdefs = await optional('./game/itemdefs.js', 'item definitions');
  if (itemdefs?.registerAllItems) itemdefs.registerAllItems();
  else registerMinimalItems();
  console.info(`[items] ${itemsByName.size} items`);

  const recipes = await optional('./game/recipes.js', 'recipes');
  if (recipes?.registerAllRecipes) recipes.registerAllRecipes();

  // --- 3. Textures ------------------------------------------------------
  boot.step('painting textures…', 0.25);
  const blockTex = await optional('./render/textures/blocks.js', 'block textures');
  blockTex?.registerBlockTextures?.();
  const itemTex = await optional('./render/textures/items.js', 'item textures');
  itemTex?.registerItemTextures?.();
  const guiTex = await optional('./render/textures/gui.js', 'gui textures');
  guiTex?.registerGuiTextures?.();
  const mobTex = await optional('./render/textures/mobs.js', 'mob textures');
  mobTex?.registerMobTextures?.();
  registerFallbackTextures();

  const layers = generateAll();
  console.info(`[textures] ${layers} layers generated`);
  boot.step(`generated ${layers} textures…`, 0.45);
  await nextFrame();

  // --- 4. Remaining content --------------------------------------------
  boot.step('loading world generator…', 0.5);
  const modules = {
    blockdefs, itemdefs, recipes,
    biomes: await optional('./world/biomes.js', 'biomes'),
    generator: await optional('./world/generator.js', 'terrain generator'),
    features: await optional('./world/features.js', 'features'),
    structures: await optional('./world/structures.js', 'structures'),
    redstone: await optional('./world/redstone.js', 'redstone'),
    fluids: await optional('./world/fluids.js', 'fluid simulation'),
    blockEntity: await optional('./world/blockentity.js', 'block entities'),
    pistons: await optional('./world/pistons.js', 'pistons'),
    mobs: await optional('./entity/mobs.js', 'mobs'),
    models: await optional('./entity/models.js', 'entity models'),
    itemEntity: await optional('./entity/itementity.js', 'item entities'),
    ai: await optional('./entity/ai.js', 'mob AI'),
    inventory: await optional('./game/inventory.js', 'inventory'),
    inventoryScreen: await optional('./game/ui/inventoryscreen.js', 'inventory screen'),
    containers: await optional('./game/ui/containers.js', 'container screens'),
    hud: await optional('./game/ui/hud.js', 'HUD'),
    menus: await optional('./game/ui/menus.js', 'menus'),
    sound: await optional('./game/sound.js', 'audio'),
    particles: await optional('./render/particles.js', 'particles'),
    weather: await optional('./render/weather.js', 'weather'),
    survival: await optional('./game/survival.js', 'survival systems'),
    effects: await optional('./game/effects.js', 'status effects'),
    enchanting: await optional('./game/enchanting.js', 'enchanting'),
    experience: await optional('./game/experience.js', 'experience'),
    combat: await optional('./game/combat.js', 'combat'),
    farming: await optional('./game/farming.js', 'farming'),
    trading: await optional('./game/trading.js', 'villager trading'),
    save: await optional('./game/save.js', 'save system'),
    mobTextures: mobTex,
    entityRenderer: await optional('./render/entityrenderer.js', 'entity renderer'),
  };
  // Terrain tint colours are baked per block by the mesher, so it needs a way
  // to ask what colour a biome is.
  if (modules.biomes?.biomeById) {
    const table = modules.biomes.biomeById;
    setBiomeColorProvider((biomeId) => {
      const b = table[biomeId];
      return b ? {
        grass: b.grassColor ?? 0x7cbd6b,
        foliage: b.foliageColor ?? 0x59ae30,
        water: b.waterColor ?? 0x3f76e4,
      } : null;
    });
  }
  modules.effects?.registerAllEffects?.();
  modules.enchanting?.registerAllEnchantments?.();
  modules.mobs?.registerAllMobs?.();

  // --- 5. Renderer ------------------------------------------------------
  boot.step('starting renderer…', 0.7);
  const game = new Game({ canvas, guiCanvas, modules });
  game.renderer.uploadTextures();

  // --- 6. World ---------------------------------------------------------
  boot.step('generating world…', 0.8);
  const params = new URLSearchParams(location.search);
  const seed = params.get('seed') ?? String(Math.floor(Math.random() * 2 ** 31));
  const mode = params.get('mode') === 'creative' ? GAMEMODE.CREATIVE : GAMEMODE.SURVIVAL;
  await game.createWorld(seed, { gamemode: mode });

  // Preload the chunks immediately around spawn so the first frame has terrain.
  boot.step('building terrain…', 0.88);
  const p = game.player;
  const pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
  for (let r = 0; r <= 2; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        game.loader.generateChunkNow(pcx + dx, pcz + dz);
      }
    }
    await nextFrame();
    boot.step('building terrain…', 0.88 + r * 0.02);
  }
  // Drop the player onto the surface in case decoration raised the ground.
  const surface = game.world.surfaceAt(Math.floor(p.x), Math.floor(p.z));
  if (surface > MIN_SAFE_Y) { p.y = surface + 1; p.prevY = p.y; p.updateBounds(); }

  if (game.player.gamemode === GAMEMODE.CREATIVE) {
    game.player.canFly = true;
  } else {
    giveStarterItems(game);
  }

  boot.step('ready', 1);
  game.start();
  window.game = game;    // handy for the console
  await nextFrame();
  boot.done();
  return game;
}

const MIN_SAFE_Y = -60;

function giveStarterItems(game) {
  // A small starting kit so a new survival world is immediately playable.
  const kit = [
    ['wooden_pickaxe', 1], ['wooden_axe', 1], ['wooden_shovel', 1],
    ['bread', 8], ['torch', 32], ['oak_planks', 16], ['crafting_table', 1],
  ];
  for (const [name, count] of kit) {
    const item = itemsByName.get(name);
    if (item) game.player.inventory.addItem?.(new ItemStack(item, count));
  }
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// ---------------------------------------------------------------------------
// Fallbacks — enough of a world to prove the engine works on its own
// ---------------------------------------------------------------------------

function registerMinimalBlocks() {
  defineBlock('air', { render: RENDER.INVISIBLE, solid: false, opaque: false,
    replaceable: true, hardness: 0, item: null });
  const simple = (name, opts = {}) => defineBlock(name, {
    hardness: 1.5, tool: TOOL.PICKAXE, sound: SOUND.STONE, textures: name, ...opts,
  });
  simple('stone');
  simple('dirt', { hardness: 0.5, tool: TOOL.SHOVEL, sound: SOUND.GRAVEL });
  simple('grass_block', {
    hardness: 0.6, tool: TOOL.SHOVEL, sound: SOUND.GRASS,
    textures: { top: 'grass_block_top', bottom: 'dirt', side: 'grass_block_side' },
  });
  simple('bedrock', { hardness: -1 });
  simple('cobblestone');
  simple('oak_planks', { hardness: 2, tool: TOOL.AXE, sound: SOUND.WOOD });
  simple('oak_log', { hardness: 2, tool: TOOL.AXE, sound: SOUND.WOOD,
    textures: { top: 'oak_log_top', bottom: 'oak_log_top', side: 'oak_log' } });
  simple('sand', { hardness: 0.5, tool: TOOL.SHOVEL, sound: SOUND.SAND, gravity: true });
  simple('glass', { hardness: 0.3, sound: SOUND.GLASS, pass: PASS.CUTOUT,
    opaque: false, transparentToSelf: true });
}

function registerMinimalItems() {
  for (const b of blocks) {
    if (!b.item || itemsByName.has(b.name)) continue;
    defineItem(b.name, { block: b.name, displayName: b.displayName });
  }
}

/**
 * Painters for anything content modules did not supply, so a missing texture
 * never turns into a magenta checkerboard in a shipped build.
 */
function registerFallbackTextures() {
  const need = new Set();
  // Walking every state would build (and cache) tens of thousands of models at
  // boot. Textures rarely vary across states, and where they do — crop age,
  // furnace lit, copper oxidation — the state count is small, so sampling up to
  // 24 states per block covers the variation for a fraction of the work.
  const SAMPLE_CAP = 24;
  for (const b of blocks) {
    const step = Math.max(1, Math.ceil(b.stateCount / SAMPLE_CAP));
    for (let i = 0; i < b.stateCount; i += step) {
      const model = b.modelFor(b.base + i);
      if (!model) continue;
      for (const bx of model) {
        for (const f of bx.faces) if (f?.texture) need.add(f.texture);
      }
    }
    // Always include the last state — copper/crop chains often end there.
    if (b.stateCount > 1) {
      const model = b.modelFor(b.base + b.stateCount - 1);
      if (model) {
        for (const bx of model) {
          for (const f of bx.faces) if (f?.texture) need.add(f.texture);
        }
      }
    }
    // Plants and fluids have no box model; their textures live on the block.
    collectDeclaredTextures(b, need);
  }
  for (const item of itemsByName.values()) {
    if (item.texture) need.add(item.texture);
  }
  for (let i = 0; i <= 9; i++) need.add(`destroy_stage_${i}`);

  let missing = 0;
  for (const name of need) {
    if (hasTexture(name)) continue;
    missing++;
    if (name.startsWith('destroy_stage_')) {
      const stage = parseInt(name.slice('destroy_stage_'.length), 10);
      registerTexture(name, (px, rng) => paintCracks(px, rng, stage));
      continue;
    }
    registerTexture(name, (px, rng) => paintGeneric(px, rng, name));
  }
  if (missing > 0) console.warn(`[textures] ${missing} fallback textures generated`);
}

/**
 * Gather texture names a block declares directly (rather than through a model).
 * The spec may be a string, a six-entry array, or an object of named faces, and
 * it may be a function of the block state.
 */
function collectDeclaredTextures(block, out) {
  const specs = [];
  if (typeof block.textures === 'function') {
    const step = Math.max(1, Math.ceil(block.stateCount / 12));
    for (let i = 0; i < block.stateCount; i += step) {
      try { specs.push(block.textures(block.base + i)); } catch { /* state-specific */ }
    }
  } else if (block.textures) {
    specs.push(block.textures);
  }
  for (const spec of specs) {
    if (!spec) continue;
    if (typeof spec === 'string') out.add(spec);
    else if (Array.isArray(spec)) { for (const t of spec) if (typeof t === 'string') out.add(t); }
    else for (const t of Object.values(spec)) if (typeof t === 'string') out.add(t);
  }
}

/** A plausible stone-ish texture derived from the name, so nothing looks broken. */
function paintGeneric(px, rng, name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const hue = ((h >>> 8) % 360) / 360;
  const sat = 0.12 + ((h >>> 3) % 30) / 200;
  const val = 0.42 + ((h >>> 16) % 40) / 140;
  const base = hsvToHex(hue, sat, val);
  px.fill(base);
  px.grain(rng, 0.12);
  px.blotches(rng, 4, shadeHex(base, -0.18), 2.5, 0.5);
  px.blotches(rng, 3, shadeHex(base, 0.16), 2, 0.4);
}

/** The block-breaking crack overlay, ten progressively worse stages. */
function paintCracks(px, rng, stage) {
  px.clear();
  const cracks = 1 + stage;
  for (let i = 0; i < cracks; i++) {
    let x = rng.int(16), y = rng.int(16);
    const len = 3 + stage * 1.2 + rng.int(4);
    for (let s = 0; s < len; s++) {
      px.set(x, y, 0x000000, 200);
      if (rng.chance(0.4)) px.set(x + 1, y, 0x000000, 110);
      if (rng.chance(0.4)) px.set(x, y + 1, 0x000000, 110);
      x += rng.int(3) - 1;
      y += rng.int(3) - 1;
      if (x < 0 || x > 15 || y < 0 || y > 15) break;
    }
  }
}

function hsvToHex(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

function shadeHex(hex, t) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const m = t >= 0 ? (c) => c + (255 - c) * t : (c) => c * (1 + t);
  return (Math.round(m(r)) << 16) | (Math.round(m(g)) << 8) | Math.round(m(b));
}

export { start as boot };
