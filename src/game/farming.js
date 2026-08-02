// Farming: composting, bone meal, animal breeding, and the per-tick upkeep.
//
// Crop growth itself lives with the block definitions, because it is driven by
// random ticks. What is left over — the things that need a schedule or two
// entities to agree — lives here: composter fill levels, bone meal on every
// kind of plant, and the love/cooldown/age cycle that turns two animals and a
// handful of wheat into a third animal.

import { Random } from '../core/rng.js';
import {
  blockOf, blocksByName, getProp, withProp, stateOf, T,
} from '../world/blocks.js';
import { ItemStack, itemsByName } from './items.js';
import { spawnOrbs } from './experience.js';

/** How full a composter is when it is ready to be emptied. */
export const COMPOSTER_READY = 8;
/** Ticks between a composter filling up and turning into bone meal. */
export const COMPOSTER_DELAY = 20;

/** Ticks an animal stays in love mode after being fed. */
export const LOVE_TICKS = 600;
/** Ticks before an animal can breed again. */
export const BREED_COOLDOWN = 6000;
/** Ticks for a baby to grow up. */
export const BABY_TICKS = 24000;
/** Range within which two animals in love find each other. */
export const BREED_RANGE = 8;

/**
 * Chance that one item raises the composter by a level. These are Minecraft's
 * values: leaves and seeds are poor, cooked food and hay are excellent.
 */
export const COMPOSTABLE = {
  // 30%
  beetroot_seeds: 0.3, dried_kelp: 0.3, glow_berries: 0.3, short_grass: 0.3,
  hanging_roots: 0.3, kelp: 0.3, melon_seeds: 0.3, pumpkin_seeds: 0.3,
  seagrass: 0.3, sweet_berries: 0.3, wheat_seeds: 0.3, moss_carpet: 0.3,
  pink_petals: 0.3, small_dripleaf: 0.3, torchflower_seeds: 0.3,
  pitcher_pod: 0.3, oak_leaves: 0.3, spruce_leaves: 0.3, birch_leaves: 0.3,
  jungle_leaves: 0.3, acacia_leaves: 0.3, dark_oak_leaves: 0.3,
  mangrove_leaves: 0.3, cherry_leaves: 0.3, azalea_leaves: 0.3,
  flowering_azalea_leaves: 0.3, oak_sapling: 0.3, spruce_sapling: 0.3,
  birch_sapling: 0.3, jungle_sapling: 0.3, acacia_sapling: 0.3,
  dark_oak_sapling: 0.3, cherry_sapling: 0.3, mangrove_propagule: 0.3,
  // 50%
  cactus: 0.5, dried_kelp_block: 0.5, glow_lichen: 0.5, melon_slice: 0.5,
  nether_sprouts: 0.5, sugar_cane: 0.5, tall_grass: 0.5, twisting_vines: 0.5,
  vine: 0.5, weeping_vines: 0.5, azalea: 0.5, big_dripleaf: 0.5, fern: 0.5,
  large_fern: 0.5, crimson_roots: 0.5, warped_roots: 0.5, mangrove_roots: 0.5,
  // 65%
  apple: 0.65, beetroot: 0.65, carrot: 0.65, cocoa_beans: 0.65, lily_pad: 0.65,
  melon: 0.65, potato: 0.65, pumpkin: 0.65, sea_pickle: 0.65, wheat: 0.65,
  brown_mushroom: 0.65, red_mushroom: 0.65, nether_wart: 0.65, shroomlight: 0.65,
  crimson_fungus: 0.65, warped_fungus: 0.65, sunflower: 0.65, lilac: 0.65,
  rose_bush: 0.65, peony: 0.65, dandelion: 0.65, poppy: 0.65, blue_orchid: 0.65,
  allium: 0.65, azure_bluet: 0.65, red_tulip: 0.65, orange_tulip: 0.65,
  white_tulip: 0.65, pink_tulip: 0.65, oxeye_daisy: 0.65, cornflower: 0.65,
  lily_of_the_valley: 0.65, wither_rose: 0.65, torchflower: 0.65,
  flowering_azalea: 0.65, moss_block: 0.65, nether_wart_block: 0.65,
  warped_wart_block: 0.65, mushroom_stem: 0.65,
  // 85%
  baked_potato: 0.85, bread: 0.85, cookie: 0.85, hay_block: 0.85,
  brown_mushroom_block: 0.85, red_mushroom_block: 0.85,
  // 100%
  cake: 1, pumpkin_pie: 1,
};

/** Bone-meal-able plants that simply advance an age property. */
const AGE_GROWN = new Set(['nether_wart', 'cocoa', 'sweet_berry_bush']);

/** What each animal eats to enter love mode. */
export const BREEDING_FOOD = {
  cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds',
    'torchflower_seeds', 'pitcher_pod'],
  wolf: ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cooked_beef',
    'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit'],
  cat: ['cod', 'salmon'], ocelot: ['cod', 'salmon'],
  rabbit: ['carrot', 'golden_carrot', 'dandelion'],
  horse: ['golden_carrot', 'golden_apple', 'enchanted_golden_apple'],
  donkey: ['golden_carrot', 'golden_apple'],
  llama: ['hay_block'], turtle: ['seagrass'], panda: ['bamboo'],
  fox: ['sweet_berries', 'glow_berries'], bee: ['dandelion', 'poppy', 'sunflower'],
  strider: ['warped_fungus'], hoglin: ['crimson_fungus'],
  axolotl: ['tropical_fish_bucket'], frog: ['slime_ball'],
  sniffer: ['torchflower_seeds'], camel: ['cactus'], armadillo: ['spider_eye'],
};

// ---------------------------------------------------------------------------
// Per-world scratch state
// ---------------------------------------------------------------------------

const worldState = new WeakMap();

function stateFor(world) {
  let s = worldState.get(world);
  if (!s) {
    s = { composters: new Map(), random: new Random((world.seed ^ 0x5eaf00d) | 0) };
    worldState.set(world, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/**
 * One farming tick, called once per world tick by the game loop.
 * Deliberately cheap: composters are a short pending map, and the animal pass
 * only touches entities that are actually in love, on cooldown, or babies.
 */
export function tick(world) {
  if (!world) return;
  const s = stateFor(world);
  tickComposters(world, s);
  tickAnimals(world, s);
}

function tickComposters(world, s) {
  if (s.composters.size === 0) return;
  for (const [key, due] of [...s.composters]) {
    if (world.tickCount < due) continue;
    s.composters.delete(key);
    const [x, y, z] = key.split(',').map(Number);
    const state = world.getBlock(x, y, z);
    const def = blockOf(state);
    if (def?.name !== 'composter') continue;
    if (getProp(state, 'level') !== COMPOSTER_READY - 1) continue;
    world.setBlock(x, y, z, withProp(state, 'level', COMPOSTER_READY));
    world.playSound('composter.ready', x + 0.5, y + 0.5, z + 0.5, 1, 1);
  }
}

/**
 * Love mode, breeding cooldowns and babies growing up.
 * Entities opt in simply by having the fields — nothing here requires the mob
 * module to exist.
 */
function tickAnimals(world, s) {
  const entities = world.entities;
  const pairing = world.tickCount % 10 === 0;
  const inLove = pairing ? [] : null;

  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (e.removed || e.isPlayer) continue;

    if (e.breedCooldown > 0) e.breedCooldown--;
    if (e.age < 0) {
      // Babies age toward zero; feeding them speeds it up elsewhere.
      e.age++;
      if (e.age === 0) e.baby = false;
    }
    if (e.loveTicks > 0) {
      e.loveTicks--;
      if (world.tickCount % 8 === 0) {
        world.spawnParticles('heart', e.x, e.y + (e.height ?? 1) * 0.8, e.z, 1);
      }
      if (inLove && e.loveTicks > 0 && (e.age ?? 0) >= 0) inLove.push(e);
    }
  }

  if (!inLove || inLove.length < 2) return;
  for (let i = 0; i < inLove.length; i++) {
    const a = inLove[i];
    if (a.loveTicks <= 0 || a.removed) continue;
    for (let j = i + 1; j < inLove.length; j++) {
      const b = inLove[j];
      if (b.loveTicks <= 0 || b.removed) continue;
      if (!canBreedWith(a, b)) continue;
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      if (dx * dx + dy * dy + dz * dz > BREED_RANGE * BREED_RANGE) continue;
      breed(world, a, b);
      break;
    }
  }
}

function canBreedWith(a, b) {
  if (a === b) return false;
  const ta = a.type ?? a.name, tb = b.type ?? b.name;
  if (!ta || ta !== tb) return false;
  if ((a.age ?? 0) < 0 || (b.age ?? 0) < 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Composting
// ---------------------------------------------------------------------------

/** Chance an item raises the composter, 0 when it is not compostable. */
export function compostChance(itemName) { return COMPOSTABLE[itemName] ?? 0; }

/**
 * Right-clicking a composter: feed it, or empty it once it is ready.
 * Called through `game.crafting.compost` by the block definition.
 *
 * @returns true when the interaction did something
 */
export function compost(world, x, y, z, state, player, hand) {
  const def = blockOf(state);
  if (def?.name !== 'composter') return false;
  const s = stateFor(world);
  const level = getProp(state, 'level');

  // Ready: hand over the bone meal and reset.
  if (level >= COMPOSTER_READY) {
    world.setBlock(x, y, z, withProp(state, 'level', 0));
    world.playSound('composter.empty', x + 0.5, y + 0.5, z + 0.5, 1, 1);
    if (itemsByName.has('bone_meal')) {
      const stack = new ItemStack('bone_meal', 1);
      if (!player?.inventory?.addItem?.(stack)) {
        world.game?.spawnItem?.(world, x + 0.5, y + 1, z + 0.5, stack);
      }
    }
    return true;
  }

  const stack = hand && hand.item ? hand : (player?.heldItem?.() ?? null);
  if (!stack || stack.empty) return false;
  const chance = compostChance(stack.item.name);
  if (chance <= 0) return false;

  if (player && player.gamemode !== 1) {
    stack.count--;
    if (stack.count <= 0) player.inventory?.setSelected?.(null);
  }

  // A composter always accepts the first item; after that it is a dice roll.
  const succeeded = level === 0 || s.random.next() < chance;
  if (!succeeded) {
    world.playSound('composter.fill', x + 0.5, y + 0.5, z + 0.5, 1, 1);
    return true;
  }

  const next = level + 1;
  world.setBlock(x, y, z, withProp(state, 'level', next));
  world.spawnParticles('composter', x + 0.5, y + 0.6, z + 0.5, 8);
  world.playSound('composter.fill_success', x + 0.5, y + 0.5, z + 0.5, 1, 1);
  if (next === COMPOSTER_READY - 1) {
    // The last layer settles for a second before it becomes bone meal.
    s.composters.set(`${x},${y},${z}`, world.tickCount + COMPOSTER_DELAY);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Bone meal
// ---------------------------------------------------------------------------

/**
 * Apply bone meal at a position.
 *
 * Crops jump 2–5 growth stages, saplings advance (or become a tree) 45% of the
 * time, grass blocks sprout a patch of grass and flowers, and column plants
 * such as sugar cane and cactus grow their remaining height.
 *
 * @returns true when something grew, in which case the caller consumes one
 *          bone meal
 */
export function bonemeal(world, x, y, z, player = null, stack = null) {
  const state = world.getBlock(x, y, z);
  const def = blockOf(state);
  if (!def) return false;
  const random = stateFor(world).random;
  let grew = false;

  if (def.isCrop && def.maxAge != null) {
    const age = getProp(state, 'age');
    if (age >= def.maxAge) return false;
    // Nether wart and cocoa take one stage; ordinary crops take two to five.
    const step = AGE_GROWN.has(def.name) ? 1 : random.intRange(2, 5);
    world.setBlock(x, y, z, withProp(state, 'age', Math.min(def.maxAge, age + step)));
    grew = true;
  } else if (def.isSapling) {
    if (random.next() < 0.45) {
      if (def.stateDef?.has?.('stage') && getProp(state, 'stage') === 0) {
        world.setBlock(x, y, z, withProp(state, 'stage', 1));
      } else {
        world.game?.features?.growTree?.(world, x, y, z, def.species, random);
      }
      grew = true;
    } else {
      grew = true;               // the bone meal is still spent
    }
  } else if (def.name === 'grass_block') {
    grew = spreadGrass(world, x, y, z, random);
  } else if (def.name === 'sugar_cane' || def.name === 'cactus' ||
             def.name === 'bamboo' || def.name === 'kelp' ||
             def.name === 'twisting_vines' || def.name === 'weeping_vines') {
    grew = growColumn(world, x, y, z, def, random);
  } else if (def.name === 'sea_pickle' || def.name === 'nether_wart') {
    const age = getProp(state, 'age');
    const max = (def.stateDef?.props?.[0]?.count ?? 4) - 1;
    if (age < max) { world.setBlock(x, y, z, withProp(state, 'age', age + 1)); grew = true; }
  } else if (def.name === 'crimson_fungus' || def.name === 'warped_fungus') {
    if (random.next() < 0.4) {
      world.game?.features?.growTree?.(world, x, y, z, def.name.split('_')[0], random);
    }
    grew = true;
  }

  if (!grew) return false;
  world.spawnParticles('happy_villager', x + 0.5, y + 0.5, z + 0.5, 15);
  if (stack && player && player.gamemode !== 1) {
    stack.count--;
    if (stack.count <= 0) player.inventory?.setSelected?.(null);
  }
  return true;
}

/** Bone meal on a grass block: scatter grass, ferns and flowers around it. */
function spreadGrass(world, x, y, z, random) {
  const grassState = blocksByName.get('short_grass')?.defaultState;
  if (grassState == null) return false;
  const flowers = ['dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower']
    .map((n) => blocksByName.get(n)?.defaultState).filter((s) => s != null);

  let placed = 0;
  for (let attempt = 0; attempt < 128; attempt++) {
    let px = x, py = y + 1, pz = z;
    // A short random walk outward, which is what gives the patch its shape.
    for (let step = 0; step < 3; step++) {
      px += random.intRange(-1, 1);
      pz += random.intRange(-1, 1);
      const below = blockOf(world.getBlock(px, py - 1, pz));
      if (!below || (below.name !== 'grass_block' && below.name !== 'dirt')) break;
      if (world.getBlock(px, py, pz) !== 0) break;
      if (step < 2) continue;
      const useFlower = flowers.length > 0 && random.next() < 0.1;
      world.setBlock(px, py, pz, useFlower ? random.pick(flowers) : grassState);
      placed++;
    }
  }
  return placed > 0;
}

/** Bone meal on a column plant: add height up to its natural maximum. */
function growColumn(world, x, y, z, def, random) {
  const maxHeight = def.name === 'bamboo' ? 16 : 3;
  let base = y;
  while (blockOf(world.getBlock(x, base - 1, z))?.name === def.name) base--;
  let top = y;
  while (blockOf(world.getBlock(x, top + 1, z))?.name === def.name) top++;
  const height = top - base + 1;
  const add = Math.min(random.intRange(1, 2), maxHeight - height);
  let grew = false;
  for (let i = 1; i <= add; i++) {
    if (world.getBlock(x, top + i, z) !== 0) break;
    world.setBlock(x, top + i, z, blocksByName.get(def.name).defaultState);
    grew = true;
  }
  return grew;
}

// ---------------------------------------------------------------------------
// Breeding
// ---------------------------------------------------------------------------

/** Does this item put this animal into love mode? */
export function isBreedingFood(entity, stack) {
  const type = entity?.type ?? entity?.name;
  const list = BREEDING_FOOD[type];
  if (!list || !stack || stack.empty) return false;
  return list.includes(stack.item.name);
}

/**
 * Feed an animal. Adults enter love mode; babies grow up 10% of their
 * remaining time per item, which is exactly the real game's rule.
 */
export function feed(world, entity, player, stack) {
  if (!isBreedingFood(entity, stack)) return false;
  if ((entity.age ?? 0) < 0) {
    entity.age = Math.min(0, entity.age + Math.floor(-entity.age * 0.1));
    world.spawnParticles('happy_villager', entity.x, entity.y + 0.5, entity.z, 6);
  } else {
    if (entity.breedCooldown > 0 || entity.loveTicks > 0) return false;
    entity.loveTicks = LOVE_TICKS;
    world.spawnParticles('heart', entity.x, entity.y + 1, entity.z, 6);
  }
  if (player && player.gamemode !== 1 && stack) {
    stack.count--;
    if (stack.count <= 0) player.inventory?.setSelected?.(null);
  }
  return true;
}

/**
 * Two animals in love produce a baby, drop 1–7 experience, and go on cooldown
 * for five minutes.
 *
 * @returns the baby entity, or null when no child could be made
 */
export function breed(world, a, b) {
  if (!world || !a || !b || a === b) return null;
  a.loveTicks = 0; b.loveTicks = 0;
  a.breedCooldown = BREED_COOLDOWN;
  b.breedCooldown = BREED_COOLDOWN;
  a.age = Math.max(0, a.age ?? 0);
  b.age = Math.max(0, b.age ?? 0);

  const baby = createChild(world, a, b);
  if (baby) {
    baby.age = -BABY_TICKS;
    baby.baby = true;
    baby.x = (a.x + b.x) / 2;
    baby.y = (a.y + b.y) / 2;
    baby.z = (a.z + b.z) / 2;
    baby.prevX = baby.x; baby.prevY = baby.y; baby.prevZ = baby.z;
    baby.updateBounds?.();
    if (!baby.id) world.addEntity(baby);
  }

  world.spawnParticles('heart', a.x, a.y + 1, a.z, 8);
  spawnOrbs(world, a.x, a.y + 0.5, a.z, world.random.intRange(1, 7));
  return baby;
}

function createChild(world, a, b) {
  if (typeof a.createChild === 'function') return a.createChild(world, b);
  const mobs = world.game?.modules?.mobs;
  const type = a.type ?? a.name;
  if (mobs?.createMob) return mobs.createMob(world, type, a.x, a.y, a.z, { baby: true });
  if (mobs?.spawnMob) return mobs.spawnMob(world, type, a.x, a.y, a.z, { baby: true });
  return null;
}

// ---------------------------------------------------------------------------
// Tilling and planting, for hoes and seeds
// ---------------------------------------------------------------------------

/** Blocks a hoe turns into farmland. */
const TILLABLE = new Set(['grass_block', 'dirt', 'coarse_dirt', 'dirt_path',
  'rooted_dirt', 'podzol', 'mycelium']);

/** Turn a block into farmland (or coarse dirt into plain dirt). */
export function till(world, x, y, z, player) {
  const def = blockOf(world.getBlock(x, y, z));
  if (!def || !TILLABLE.has(def.name)) return false;
  if (world.getBlock(x, y + 1, z) !== 0) return false;
  const target = def.name === 'coarse_dirt' || def.name === 'rooted_dirt'
    ? 'dirt' : 'farmland';
  const block = blocksByName.get(target);
  if (!block) return false;
  world.setBlock(x, y, z, block.defaultState);
  world.playSound('hoe.till', x + 0.5, y + 0.5, z + 0.5, 1, 1);
  return true;
}

/** Plant a seed item on farmland. */
export function plant(world, x, y, z, cropName, player, stack) {
  const block = blocksByName.get(cropName);
  if (!block) return false;
  if (world.getBlock(x, y, z) !== 0) return false;
  const state = block.stateDef?.has?.('age')
    ? stateOf(block, { age: 0 }) : block.defaultState;
  if (block.canSurvive && !block.canSurvive(world, x, y, z, state)) return false;
  world.setBlock(x, y, z, state);
  world.playSound('place.grass', x + 0.5, y + 0.5, z + 0.5, 1, 1);
  if (player && player.gamemode !== 1 && stack) {
    stack.count--;
    if (stack.count <= 0) player.inventory?.setSelected?.(null);
  }
  return true;
}

/** True when the crop at a position is ready to harvest. */
export function isMature(world, x, y, z) {
  const state = world.getBlock(x, y, z);
  const def = blockOf(state);
  if (!def?.isCrop || def.maxAge == null) return false;
  return getProp(state, 'age') >= def.maxAge;
}
