// Mob definitions, AI wiring and natural spawning.
//
// A `Mob` is a LivingEntity plus a goal selector, a navigator and a model name.
// Each species is described declaratively in `MOBS` — stats, drops, spawn rules
// and a `goals(mob)` function that installs its behaviour from the goal library
// in ai.js. Keeping the species table data-shaped is what makes seventy-odd mobs
// tractable.

import { LivingEntity } from './livingentity.js';
import {
  GoalSelector, PathNavigator, RandomStrollGoal, RandomSwimGoal, FloatGoal,
  PanicGoal, MeleeAttackGoal, RangedAttackGoal, LeapAtTargetGoal,
  FollowParentGoal, BreedGoal, TemptGoal, AvoidEntityGoal, FollowOwnerGoal,
  SitGoal, EatGrassGoal, LookAtPlayerGoal, RandomLookGoal, OpenDoorGoal,
  HurtByTargetGoal, NearestAttackableTargetGoal, LookedAtTargetGoal,
  DefendEntityGoal, StareAtTargetGoal, nearbyEntities, nearestEntity,
} from './ai.js';
import { ItemStack, itemsByName } from '../game/items.js';
import { T, blockOf } from '../world/blocks.js';
import { MIN_Y, MAX_Y, SEA_LEVEL } from '../world/chunk.js';
import { clamp } from '../core/math.js';

export const MOBS = new Map();

/** Spawn categories, with Minecraft's per-category caps. */
export const CATEGORY = {
  monster: { cap: 70, night: true },
  creature: { cap: 10, night: false },
  ambient: { cap: 15, night: false },
  water_creature: { cap: 5, night: false },
  water_ambient: { cap: 20, night: false },
  underground_water_creature: { cap: 5, night: false },
  misc: { cap: 0, night: false },
};

// ---------------------------------------------------------------------------
// Mob
// ---------------------------------------------------------------------------

export class Mob extends LivingEntity {
  constructor(world, x, y, z, def) {
    super(world, x, y, z, {
      type: def.name,
      width: def.width, height: def.height,
      maxHealth: def.health,
      armor: def.armor ?? 0,
      tags: def.tags ?? [],
      breathesWater: !!def.aquatic,
    });
    this.def = def;
    this.modelName = def.model ?? def.name;
    this.skin = def.skin ?? def.model ?? def.name;
    this.category = def.category;
    this.speed = def.speed ?? 0.23;
    this.attackDamage = def.damage ?? 0;
    this.followRange = def.followRange ?? 16;
    this.persistent = false;
    this.baby = false;
    this.age = 0;
    this.loveTicks = 0;
    this.tamed = false;
    this.sitting = false;
    this.owner = null;
    this.aquatic = !!def.aquatic;
    this.flying = !!def.flying;
    this.climbs = !!def.climbs;
    this.burnsInSunlight = !!def.burnsInSunlight;
    this.noGravity = !!def.flying;
    this.shadowRadius = Math.max(0.2, def.width * 0.5);

    this.goals = new GoalSelector(this);
    this.targets = new GoalSelector(this);
    this.navigator = new PathNavigator(this);
    if (def.goals) def.goals(this);
  }

  get isBaby() { return this.baby; }

  setBaby(v) {
    this.baby = v;
    this.scale = v ? 0.5 : 1;
    this.age = v ? -24000 : 0;
    this.updateBounds?.();
  }

  tick(world) {
    super.tick(world);
    if (this.dead || this.removed) return;

    this.goals.tick();
    this.targets.tick();
    this.navigator.tick();

    if (this.burnsInSunlight) this.tickSunlight(world);
    if (this.aquatic && !this.inWater) {
      // Fish suffocate out of water.
      if ((world.tickCount + this.id) % 20 === 0) this.hurt(1, 'dryout');
    }
    if (this.age < 0 && ++this.age === 0) this.setBaby(false);
    if (this.loveTicks > 0) {
      this.loveTicks--;
      if ((world.tickCount + this.id) % 10 === 0) {
        world.spawnParticles('heart', this.x, this.y + this.height * 0.8, this.z, 1);
      }
    }
    if (this.def.tick) this.def.tick(this, world);

    // Despawn far from every player, unless named or spawned by a player.
    if (!this.persistent && this.category !== 'misc' &&
      (world.tickCount + this.id) % 40 === 0) {
      const p = world.nearestPlayer(this.x, this.y, this.z);
      if (!p) return;
      const d2 = (p.x - this.x) ** 2 + (p.y - this.y) ** 2 + (p.z - this.z) ** 2;
      if (d2 > 128 * 128) world.removeEntity(this);
      else if (d2 > 32 * 32 && world.random.int(800) === 0) world.removeEntity(this);
    }
  }

  tickSunlight(world) {
    if (world.dimension !== 'overworld' || !world.isDay()) return;
    const head = Math.floor(this.y + this.height - 0.1);
    if (world.getSkyLight(Math.floor(this.x), head, Math.floor(this.z)) < 15) return;
    if (this.inWater) return;
    // Helmets protect zombies and skeletons from burning, as in the real game.
    if (this.equipment?.head) return;
    this.fireTicks = Math.max(this.fireTicks ?? 0, 160);
  }

  /** Right-click interaction: breeding, taming, shearing, milking. */
  interact(player, stack) {
    if (this.def.interact) return this.def.interact(this, player, stack);
    if (!stack || stack.empty) return false;
    const food = this.def.breedWith;
    if (food && food.includes(stack.item.name) && this.age === 0 && this.loveTicks === 0) {
      this.loveTicks = 600;
      if (player.gamemode === 0) stack.count--;
      this.world.spawnParticles('heart', this.x, this.y + this.height, this.z, 6);
      return true;
    }
    return false;
  }

  onDeath(source) {
    const world = this.world;
    const looting = source?.attacker?.heldItem?.()?.getEnchantLevel?.('looting') ?? 0;
    for (const drop of this.def.drops ?? []) {
      if (drop.chance !== undefined && world.random.next() > drop.chance) continue;
      let n = drop.min ?? 1;
      if (drop.max !== undefined) n = world.random.intRange(drop.min ?? 0, drop.max);
      n += looting > 0 ? world.random.int(looting + 1) : 0;
      if (n <= 0 || !itemsByName.has(drop.item)) continue;
      world.game?.spawnItem?.(world, this.x, this.y + this.height / 2, this.z,
        new ItemStack(drop.item, n));
    }
    const xp = this.def.xp ?? 0;
    if (xp > 0 && !this.baby) {
      world.game?.drops?.spawnExperience?.(world, this.x, this.y, this.z, xp);
    }
    if (this.def.onDeath) this.def.onDeath(this, world, source);
    super.onDeath?.(source);
  }
}

// ---------------------------------------------------------------------------
// Behaviour presets
// ---------------------------------------------------------------------------

/** Wander, look around, panic when hurt — the baseline for passive animals. */
function passiveGoals(mob, opts = {}) {
  mob.goals.add(0, new FloatGoal());
  mob.goals.add(1, new PanicGoal(opts.panicSpeed ?? 1.4));
  if (opts.breedWith) {
    mob.goals.add(2, new BreedGoal(1.0));
    mob.goals.add(3, new TemptGoal(1.1, opts.breedWith));
    mob.goals.add(4, new FollowParentGoal(1.1));
  }
  if (opts.eatsGrass) mob.goals.add(5, new EatGrassGoal());
  mob.goals.add(6, new RandomStrollGoal(opts.strollSpeed ?? 1.0));
  mob.goals.add(7, new LookAtPlayerGoal(6));
  mob.goals.add(8, new RandomLookGoal());
}

/** Chase and hit the nearest player. */
function meleeGoals(mob, opts = {}) {
  mob.goals.add(0, new FloatGoal());
  if (opts.leaps) mob.goals.add(1, new LeapAtTargetGoal(0.4));
  mob.goals.add(2, new MeleeAttackGoal(opts.speed ?? 1.0, opts.followWhileHurt !== false));
  if (opts.opensDoors) mob.goals.add(3, new OpenDoorGoal(true));
  if (opts.avoid) mob.goals.add(4, new AvoidEntityGoal(isType(opts.avoid), 6, 1.0, 1.2));
  mob.goals.add(7, new RandomStrollGoal(0.8));
  mob.goals.add(8, new LookAtPlayerGoal(8));
  mob.goals.add(9, new RandomLookGoal());
  mob.targets.add(1, new HurtByTargetGoal());
  mob.targets.add(2, new NearestAttackableTargetGoal(isPlayer, mob.followRange));
  if (opts.alsoTargets) {
    for (const t of opts.alsoTargets) {
      mob.targets.add(3, new NearestAttackableTargetGoal(isType(t), mob.followRange));
    }
  }
}

/** Keep distance and shoot. */
function rangedGoals(mob, projectile, opts = {}) {
  mob.goals.add(0, new FloatGoal());
  mob.goals.add(2, new RangedAttackGoal(opts.speed ?? 1.0,
    opts.interval ?? 20, opts.range ?? 15, projectile));
  mob.goals.add(7, new RandomStrollGoal(0.8));
  mob.goals.add(8, new LookAtPlayerGoal(8));
  mob.goals.add(9, new RandomLookGoal());
  mob.targets.add(1, new HurtByTargetGoal());
  mob.targets.add(2, new NearestAttackableTargetGoal(isPlayer, mob.followRange));
}

function aquaticGoals(mob) {
  mob.goals.add(0, new RandomSwimGoal(1.0));
  mob.goals.add(4, new LookAtPlayerGoal(6));
  mob.goals.add(5, new RandomLookGoal());
}

// ---------------------------------------------------------------------------
// Species table
// ---------------------------------------------------------------------------

const D = (item, min = 1, max = min, chance) => ({ item, min, max, chance });

/** Entity predicates, which is the shape the goal library expects. */
const isPlayer = (e) => !!e.isPlayer;
const isType = (type) => (e) => e.type === type;

/**
 * Spawn predicates. `surface` = on a solid block under open sky; `dark` = the
 * usual hostile-mob rule of block light below 8.
 */
const SPAWN = {
  surfaceAnimal: (w, x, y, z) =>
    T.solid[w.getBlock(x, y - 1, z)] && w.getSkyLight(x, y, z) >= 9 &&
    blockOf(w.getBlock(x, y - 1, z))?.name === 'grass_block',
  ground: (w, x, y, z) => T.solid[w.getBlock(x, y - 1, z)],
  dark: (w, x, y, z) =>
    T.solid[w.getBlock(x, y - 1, z)] && w.getBlockLight(x, y, z) < 8 &&
    (w.dimension !== 'overworld' || w.getSkyLight(x, y, z) < 8 || w.isNight()),
  water: (w, x, y, z) => T.fluid[w.getBlock(x, y, z)] === 1,
  nether: (w, x, y, z) => T.solid[w.getBlock(x, y - 1, z)] && w.dimension === 'nether',
  cave: (w, x, y, z) =>
    T.solid[w.getBlock(x, y - 1, z)] && y < SEA_LEVEL && w.getBlockLight(x, y, z) < 8,
};

function def(name, o) { MOBS.set(name, { name, ...o }); }

let registered = false;

export function registerAllMobs() {
  if (registered) return MOBS.size;
  registered = true;

  // --- passive animals -----------------------------------------------------
  def('pig', {
    category: 'creature', health: 10, width: 0.9, height: 0.9, xp: 3,
    speed: 0.25, breedWith: ['carrot', 'potato', 'beetroot'], spawn: SPAWN.surfaceAnimal,
    weight: 10, packMin: 3, packMax: 4,
    drops: [D('porkchop', 1, 3)],
    goals: (m) => passiveGoals(m, { breedWith: ['carrot', 'potato', 'beetroot'] }),
  });
  def('cow', {
    category: 'creature', health: 10, width: 0.9, height: 1.4, xp: 3,
    speed: 0.2, breedWith: ['wheat'], spawn: SPAWN.surfaceAnimal,
    weight: 8, packMin: 4, packMax: 4,
    drops: [D('beef', 1, 3), D('leather', 0, 2)],
    goals: (m) => passiveGoals(m, { breedWith: ['wheat'] }),
    interact(mob, player, stack) {
      // Milking returns a bucket of milk and consumes the empty bucket.
      if (stack?.item?.name === 'bucket' && itemsByName.has('milk_bucket')) {
        stack.count--;
        player.inventory.addItem?.(new ItemStack('milk_bucket', 1));
        mob.world.playSound('mob.cow.milk', mob.x, mob.y, mob.z);
        return true;
      }
      return false;
    },
  });
  def('mooshroom', {
    category: 'creature', health: 10, width: 0.9, height: 1.4, xp: 3, model: 'mooshroom',
    speed: 0.2, breedWith: ['wheat'], spawn: SPAWN.surfaceAnimal, weight: 8,
    drops: [D('beef', 1, 3), D('leather', 0, 2)],
    goals: (m) => passiveGoals(m, { breedWith: ['wheat'] }),
  });
  def('sheep', {
    category: 'creature', health: 8, width: 0.9, height: 1.3, xp: 3,
    speed: 0.23, breedWith: ['wheat'], spawn: SPAWN.surfaceAnimal,
    weight: 12, packMin: 4, packMax: 4,
    drops: [D('mutton', 1, 2)],
    goals: (m) => passiveGoals(m, { breedWith: ['wheat'], eatsGrass: true }),
    tick(mob) {
      // Eating grass regrows a sheared fleece.
      if (mob.sheared && mob.ateGrass) { mob.sheared = false; mob.ateGrass = false; }
    },
    interact(mob, player, stack) {
      if (stack?.item?.name === 'shears' && !mob.sheared) {
        mob.sheared = true;
        const color = mob.woolColor ?? 'white';
        mob.world.game?.spawnItem?.(mob.world, mob.x, mob.y + 1, mob.z,
          new ItemStack(`${color}_wool`, mob.world.random.intRange(1, 3)));
        mob.world.playSound('mob.sheep.shear', mob.x, mob.y, mob.z);
        stack.damageBy?.(1, mob.world.random);
        return true;
      }
      const dye = stack?.item?.name?.match(/^(\w+)_dye$/);
      if (dye) { mob.woolColor = dye[1]; if (player.gamemode === 0) stack.count--; return true; }
      return false;
    },
  });
  def('chicken', {
    category: 'creature', health: 4, width: 0.4, height: 0.7, xp: 3,
    speed: 0.25, breedWith: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds'],
    spawn: SPAWN.surfaceAnimal, weight: 10, packMin: 4, packMax: 4,
    drops: [D('chicken', 1, 1), D('feather', 0, 2)],
    goals: (m) => passiveGoals(m, {
      breedWith: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds'] }),
    tick(mob, world) {
      // Lays an egg every 5-10 minutes.
      if (mob.baby) return;
      mob.eggTimer = (mob.eggTimer ?? world.random.intRange(6000, 12000)) - 1;
      if (mob.eggTimer <= 0) {
        mob.eggTimer = world.random.intRange(6000, 12000);
        if (itemsByName.has('egg')) {
          world.game?.spawnItem?.(world, mob.x, mob.y, mob.z, new ItemStack('egg', 1));
        }
      }
    },
  });
  def('rabbit', {
    category: 'creature', health: 3, width: 0.4, height: 0.5, xp: 1,
    speed: 0.3, breedWith: ['carrot', 'golden_carrot', 'dandelion'],
    spawn: SPAWN.surfaceAnimal, weight: 4, packMin: 2, packMax: 3,
    drops: [D('rabbit', 0, 1), D('rabbit_hide', 0, 1)],
    goals: (m) => {
      passiveGoals(m, { breedWith: ['carrot', 'golden_carrot', 'dandelion'] });
      m.goals.add(2, new AvoidEntityGoal(isType('wolf'), 10, 2.2, 2.2));
    },
  });
  def('squid', {
    category: 'water_creature', health: 10, width: 0.8, height: 0.8, xp: 1,
    aquatic: true, spawn: SPAWN.water, weight: 10, packMin: 2, packMax: 4,
    drops: [D('ink_sac', 1, 3)],
    goals: aquaticGoals,
  });
  def('glow_squid', {
    category: 'water_creature', health: 10, width: 0.8, height: 0.8, xp: 1,
    aquatic: true, spawn: SPAWN.water, weight: 4,
    drops: [D('glow_ink_sac', 1, 3)], goals: aquaticGoals,
  });
  for (const fish of ['cod', 'salmon', 'tropical_fish', 'pufferfish']) {
    def(fish, {
      category: 'water_ambient', health: 3, width: 0.5, height: 0.4, xp: 1,
      aquatic: true, spawn: SPAWN.water, weight: 8, packMin: 3, packMax: 6,
      drops: [D(itemsByName.has(fish) ? fish : 'cod', 1)],
      goals: aquaticGoals,
    });
  }
  def('bat', {
    category: 'ambient', health: 6, width: 0.5, height: 0.9, xp: 0,
    flying: true, spawn: SPAWN.cave, weight: 10,
    goals: (m) => { m.goals.add(1, new RandomStrollGoal(0.8)); m.goals.add(2, new RandomLookGoal()); },
  });
  def('wolf', {
    category: 'creature', health: 8, width: 0.6, height: 0.85, xp: 3, damage: 4,
    speed: 0.3, breedWith: ['beef', 'porkchop', 'chicken', 'mutton'],
    spawn: SPAWN.surfaceAnimal, weight: 5, packMin: 4, packMax: 4, tags: ['tameable'],
    goals: (m) => {
      m.goals.add(0, new FloatGoal());
      m.goals.add(1, new SitGoal());
      m.goals.add(2, new FollowOwnerGoal(1.2, 10, 2));
      m.goals.add(3, new MeleeAttackGoal(1.2));
      m.goals.add(6, new RandomStrollGoal(1.0));
      m.goals.add(8, new LookAtPlayerGoal(8));
      m.targets.add(1, new HurtByTargetGoal());
      m.targets.add(2, new DefendEntityGoal((e) => e === m.owner, () => true, 16));
    },
    interact(mob, player, stack) {
      if (!mob.tamed && stack?.item?.name === 'bone') {
        if (player.gamemode === 0) stack.count--;
        if (mob.world.random.int(3) === 0) {
          mob.tamed = true; mob.owner = player;
          mob.world.spawnParticles('heart', mob.x, mob.y + 1, mob.z, 7);
        } else {
          mob.world.spawnParticles('smoke', mob.x, mob.y + 1, mob.z, 7);
        }
        return true;
      }
      if (mob.tamed && mob.owner === player && (!stack || stack.empty)) {
        mob.sitting = !mob.sitting;
        return true;
      }
      return false;
    },
  });
  def('cat', {
    category: 'creature', health: 10, width: 0.6, height: 0.7, xp: 3, damage: 3,
    speed: 0.3, breedWith: ['cod', 'salmon'], spawn: SPAWN.surfaceAnimal, weight: 2,
    tags: ['tameable'],
    goals: (m) => {
      m.goals.add(0, new FloatGoal());
      m.goals.add(1, new SitGoal());
      m.goals.add(2, new FollowOwnerGoal(1.0, 10, 2));
      m.goals.add(3, new TemptGoal(1.0, ['cod', 'salmon']));
      m.goals.add(6, new RandomStrollGoal(0.8));
      m.goals.add(8, new LookAtPlayerGoal(8));
    },
  });
  def('ocelot', {
    category: 'creature', health: 10, width: 0.6, height: 0.7, xp: 3,
    speed: 0.3, breedWith: ['cod', 'salmon'], spawn: SPAWN.surfaceAnimal, weight: 2,
    goals: (m) => passiveGoals(m, { breedWith: ['cod', 'salmon'] }),
  });
  def('fox', {
    category: 'creature', health: 10, width: 0.6, height: 0.7, xp: 3, damage: 2,
    speed: 0.3, breedWith: ['sweet_berries', 'glow_berries'],
    spawn: SPAWN.surfaceAnimal, weight: 4,
    goals: (m) => passiveGoals(m, { breedWith: ['sweet_berries', 'glow_berries'] }),
  });
  for (const [name, hp, w, h] of [['horse', 22, 1.4, 1.6], ['donkey', 20, 1.4, 1.5],
    ['mule', 20, 1.4, 1.6], ['llama', 22, 0.9, 1.9], ['trader_llama', 22, 0.9, 1.9]]) {
    def(name, {
      category: 'creature', health: hp, width: w, height: h, xp: 3, speed: 0.3,
      breedWith: ['golden_carrot', 'golden_apple'], spawn: SPAWN.surfaceAnimal,
      weight: name === 'horse' ? 5 : 1, packMin: 2, packMax: 6,
      drops: [D('leather', 0, 2)],
      goals: (m) => passiveGoals(m, { breedWith: ['golden_carrot'] }),
    });
  }
  for (const [name, hp, w, h, food] of [
    ['panda', 20, 1.3, 1.25, ['bamboo']], ['polar_bear', 30, 1.4, 1.4, ['cod']],
    ['goat', 10, 0.9, 1.3, ['wheat']], ['turtle', 30, 1.2, 0.4, ['seagrass']],
    ['axolotl', 14, 0.75, 0.42, ['tropical_fish']], ['frog', 10, 0.5, 0.5, ['slime_ball']],
    ['sniffer', 14, 1.9, 1.75, ['torchflower_seeds']], ['dolphin', 10, 0.9, 0.6, ['cod']],
    ['bee', 10, 0.7, 0.6, ['dandelion']], ['allay', 20, 0.35, 0.6, []],
    ['strider', 20, 0.9, 1.7, ['warped_fungus']], ['tadpole', 6, 0.4, 0.3, []],
  ]) {
    def(name, {
      category: name === 'dolphin' || name === 'axolotl' ? 'water_creature' : 'creature',
      health: hp, width: w, height: h, xp: 3, speed: 0.25,
      breedWith: food, flying: name === 'bee' || name === 'allay',
      aquatic: name === 'dolphin' || name === 'tadpole',
      spawn: name === 'strider' ? SPAWN.nether : SPAWN.surfaceAnimal,
      weight: 2,
      goals: (m) => passiveGoals(m, { breedWith: food.length ? food : null }),
    });
  }
  def('villager', {
    category: 'creature', health: 20, width: 0.6, height: 1.95, xp: 0,
    speed: 0.25, spawn: null, tags: ['villager'],
    goals: (m) => {
      m.goals.add(0, new FloatGoal());
      m.goals.add(1, new PanicGoal(1.5));
      m.goals.add(2, new AvoidEntityGoal(isType('zombie'), 8, 1.6, 1.6));
      m.goals.add(6, new RandomStrollGoal(0.6));
      m.goals.add(8, new LookAtPlayerGoal(8));
    },
    interact(mob, player) {
      mob.world.game?.ui?.openMenu?.('villager_trade', mob.world,
        Math.floor(mob.x), Math.floor(mob.y), Math.floor(mob.z), player);
      return true;
    },
  });
  def('wandering_trader', {
    category: 'creature', health: 20, width: 0.6, height: 1.95, xp: 0,
    speed: 0.25, spawn: null,
    goals: (m) => passiveGoals(m),
  });
  def('iron_golem', {
    category: 'misc', health: 100, width: 1.4, height: 2.7, xp: 0, damage: 15,
    speed: 0.25, armor: 0, spawn: null, tags: ['golem'],
    drops: [D('iron_ingot', 3, 5), D('poppy', 0, 2)],
    goals: (m) => {
      m.goals.add(0, new FloatGoal());
      m.goals.add(2, new MeleeAttackGoal(1.0));
      m.goals.add(6, new RandomStrollGoal(0.6));
      m.targets.add(1, new HurtByTargetGoal());
      m.targets.add(2, new NearestAttackableTargetGoal(
        (e) => e.category === 'monster', 24));
    },
  });
  def('snow_golem', {
    category: 'misc', health: 4, width: 0.7, height: 1.9, xp: 0, speed: 0.2,
    spawn: null, drops: [D('snowball', 0, 15)],
    goals: (m) => rangedGoals(m, 'snowball', { interval: 20, range: 10 }),
  });

  // --- hostile -------------------------------------------------------------
  def('zombie', {
    category: 'monster', health: 20, width: 0.6, height: 1.95, xp: 5, damage: 3,
    speed: 0.23, armor: 2, spawn: SPAWN.dark, weight: 100, packMin: 1, packMax: 4,
    burnsInSunlight: true, tags: ['undead'],
    drops: [D('rotten_flesh', 0, 2), D('iron_ingot', 1, 1, 0.025)],
    goals: (m) => meleeGoals(m, { opensDoors: true, alsoTargets: ['villager', 'iron_golem'] }),
  });
  def('husk', {
    category: 'monster', health: 20, width: 0.6, height: 1.95, xp: 5, damage: 3,
    speed: 0.23, armor: 2, spawn: SPAWN.dark, weight: 20, tags: ['undead'],
    drops: [D('rotten_flesh', 0, 2)], goals: (m) => meleeGoals(m),
  });
  def('drowned', {
    category: 'monster', health: 20, width: 0.6, height: 1.95, xp: 5, damage: 3,
    speed: 0.23, armor: 2, spawn: SPAWN.water, weight: 10, aquatic: true,
    tags: ['undead'], drops: [D('rotten_flesh', 0, 2)], goals: (m) => meleeGoals(m),
  });
  def('zombie_villager', {
    category: 'monster', health: 20, width: 0.6, height: 1.95, xp: 5, damage: 3,
    speed: 0.23, spawn: SPAWN.dark, weight: 5, burnsInSunlight: true, tags: ['undead'],
    drops: [D('rotten_flesh', 0, 2)], goals: (m) => meleeGoals(m, { opensDoors: true }),
  });
  def('skeleton', {
    category: 'monster', health: 20, width: 0.6, height: 1.99, xp: 5, damage: 2,
    speed: 0.25, spawn: SPAWN.dark, weight: 80, burnsInSunlight: true, tags: ['undead'],
    drops: [D('bone', 0, 2), D('arrow', 0, 2)],
    goals: (m) => rangedGoals(m, 'arrow', { interval: 20, range: 15 }),
  });
  def('stray', {
    category: 'monster', health: 20, width: 0.6, height: 1.99, xp: 5, damage: 2,
    speed: 0.25, spawn: SPAWN.dark, weight: 10, burnsInSunlight: true, tags: ['undead'],
    drops: [D('bone', 0, 2), D('arrow', 0, 2)],
    goals: (m) => rangedGoals(m, 'arrow'),
  });
  def('wither_skeleton', {
    category: 'monster', health: 20, width: 0.7, height: 2.4, xp: 5, damage: 8,
    speed: 0.25, spawn: SPAWN.nether, weight: 8, tags: ['undead'],
    drops: [D('bone', 0, 2), D('coal', 0, 1)],
    goals: (m) => meleeGoals(m),
  });
  def('creeper', {
    category: 'monster', health: 20, width: 0.6, height: 1.7, xp: 5, damage: 0,
    speed: 0.25, spawn: SPAWN.dark, weight: 100,
    drops: [D('gunpowder', 0, 2)],
    goals: (m) => {
      meleeGoals(m, { avoid: 'cat' });
      m.fuse = -1;
    },
    tick(mob, world) {
      // Fuse when close to the target; explode when it runs out.
      const t = mob.attackTarget;
      const close = t && (t.x - mob.x) ** 2 + (t.z - mob.z) ** 2 < 9;
      if (close && mob.fuse < 0) {
        mob.fuse = 30;
        world.playSound('mob.creeper.fuse', mob.x, mob.y, mob.z);
      } else if (!close && mob.fuse >= 0) {
        mob.fuse = -1;
      }
      mob.swell = mob.fuse >= 0 ? 1 - mob.fuse / 30 : 0;
      if (mob.fuse >= 0 && --mob.fuse <= 0) {
        world.game?.modules?.combat?.explode?.(world, mob.x, mob.y, mob.z,
          mob.charged ? 6 : 3, { fire: false });
        world.removeEntity(mob);
      }
    },
  });
  def('spider', {
    category: 'monster', health: 16, width: 1.4, height: 0.9, xp: 5, damage: 2,
    speed: 0.3, spawn: SPAWN.dark, weight: 100, climbs: true, tags: ['arthropod'],
    drops: [D('string', 0, 2), D('spider_eye', 0, 1, 0.33)],
    goals: (m) => meleeGoals(m, { leaps: true }),
    tick(mob, world) {
      // Spiders are neutral in bright light.
      if (world.getLight(Math.floor(mob.x), Math.floor(mob.y), Math.floor(mob.z)) > 11) {
        mob.attackTarget = null;
      }
    },
  });
  def('cave_spider', {
    category: 'monster', health: 12, width: 0.7, height: 0.5, xp: 5, damage: 2,
    speed: 0.3, spawn: SPAWN.cave, weight: 10, climbs: true, tags: ['arthropod'],
    drops: [D('string', 0, 2)], goals: (m) => meleeGoals(m, { leaps: true }),
  });
  def('enderman', {
    category: 'monster', health: 40, width: 0.6, height: 2.9, xp: 5, damage: 7,
    speed: 0.3, spawn: SPAWN.dark, weight: 10,
    drops: [D('ender_pearl', 0, 1)],
    goals: (m) => {
      meleeGoals(m);
      m.goals.add(1, new StareAtTargetGoal());
      m.targets.add(1, new LookedAtTargetGoal());
    },
    tick(mob, world) {
      if (mob.inWater) mob.hurt(1, 'drown');
      // Teleport away when hurt or stuck.
      if (mob.hurtTime === 9 && world.random.int(2) === 0) teleportRandom(mob, world);
    },
  });
  def('witch', {
    category: 'monster', health: 26, width: 0.6, height: 1.95, xp: 5, damage: 0,
    speed: 0.25, spawn: SPAWN.dark, weight: 5,
    drops: [D('glass_bottle', 0, 2), D('redstone', 0, 2), D('gunpowder', 0, 2),
      D('spider_eye', 0, 2), D('sugar', 0, 2), D('stick', 0, 2)],
    goals: (m) => rangedGoals(m, 'splash_potion', { interval: 60, range: 10 }),
  });
  def('slime', {
    category: 'monster', health: 4, width: 0.5, height: 0.5, xp: 1, damage: 2,
    speed: 0.2, spawn: SPAWN.cave, weight: 10,
    drops: [D('slime_ball', 0, 2)],
    goals: (m) => meleeGoals(m, { leaps: true }),
    onDeath(mob, world) {
      // Split into smaller slimes.
      const size = mob.slimeSize ?? 2;
      if (size <= 1) return;
      for (let i = 0; i < 2 + world.random.int(2); i++) {
        const child = spawn(world, 'slime', mob.x + world.random.range(-0.5, 0.5),
          mob.y, mob.z + world.random.range(-0.5, 0.5));
        if (child) {
          child.slimeSize = size - 1;
          child.scale = 0.5 * (size - 1);
          child.maxHealth = child.health = size - 1;
        }
      }
    },
  });
  def('magma_cube', {
    category: 'monster', health: 4, width: 0.5, height: 0.5, xp: 1, damage: 3,
    speed: 0.2, spawn: SPAWN.nether, weight: 10,
    drops: [D('magma_cream', 0, 1)], goals: (m) => meleeGoals(m, { leaps: true }),
  });
  def('silverfish', {
    category: 'monster', health: 8, width: 0.4, height: 0.3, xp: 5, damage: 1,
    speed: 0.25, spawn: SPAWN.cave, weight: 2, tags: ['arthropod'],
    goals: (m) => meleeGoals(m),
  });
  def('endermite', {
    category: 'monster', health: 8, width: 0.4, height: 0.3, xp: 3, damage: 2,
    speed: 0.25, spawn: null, tags: ['arthropod'], goals: (m) => meleeGoals(m),
  });
  def('blaze', {
    category: 'monster', health: 20, width: 0.6, height: 1.8, xp: 10, damage: 6,
    speed: 0.23, spawn: SPAWN.nether, weight: 6, flying: true,
    drops: [D('blaze_rod', 0, 1)],
    goals: (m) => rangedGoals(m, 'small_fireball', { interval: 30, range: 16 }),
  });
  def('ghast', {
    category: 'monster', health: 10, width: 4, height: 4, xp: 5, damage: 0,
    speed: 0.15, spawn: SPAWN.nether, weight: 20, flying: true,
    drops: [D('ghast_tear', 0, 1), D('gunpowder', 0, 2)],
    goals: (m) => rangedGoals(m, 'fireball', { interval: 60, range: 48 }),
  });
  def('zombified_piglin', {
    category: 'monster', health: 20, width: 0.6, height: 1.95, xp: 5, damage: 5,
    speed: 0.23, spawn: SPAWN.nether, weight: 100, tags: ['undead'],
    drops: [D('rotten_flesh', 0, 1), D('gold_nugget', 0, 1)],
    // Zombified piglins are neutral: they only retaliate.
    goals: (m) => {
      m.goals.add(0, new FloatGoal());
      m.goals.add(2, new MeleeAttackGoal(1.0));
      m.goals.add(7, new RandomStrollGoal(0.8));
      m.goals.add(8, new LookAtPlayerGoal(8));
      m.targets.add(1, new HurtByTargetGoal());
    },
  });
  for (const [name, hp, dmg] of [['piglin', 16, 5], ['piglin_brute', 50, 7],
    ['hoglin', 40, 6], ['zoglin', 40, 6]]) {
    def(name, {
      category: 'monster', health: hp, width: 0.9, height: 1.95, xp: 5, damage: dmg,
      speed: 0.25, spawn: SPAWN.nether, weight: 15,
      drops: name.startsWith('hog') || name === 'zoglin' ? [D('porkchop', 2, 4)] : [],
      goals: (m) => meleeGoals(m),
    });
  }
  def('phantom', {
    category: 'monster', health: 20, width: 0.9, height: 0.5, xp: 5, damage: 2,
    speed: 0.3, spawn: null, flying: true, burnsInSunlight: true, tags: ['undead'],
    drops: [D('phantom_membrane', 0, 1)], goals: (m) => meleeGoals(m),
  });
  def('guardian', {
    category: 'monster', health: 30, width: 0.85, height: 0.85, xp: 10, damage: 6,
    speed: 0.2, spawn: SPAWN.water, weight: 2, aquatic: true,
    drops: [D('prismarine_shard', 0, 2), D('cod', 0, 1)],
    goals: (m) => rangedGoals(m, 'guardian_beam', { interval: 60, range: 15 }),
  });
  def('elder_guardian', {
    category: 'monster', health: 80, width: 2, height: 2, xp: 10, damage: 8,
    speed: 0.2, spawn: null, aquatic: true,
    drops: [D('prismarine_shard', 0, 2), D('prismarine_crystals', 0, 1)],
    goals: (m) => rangedGoals(m, 'guardian_beam'),
  });
  def('shulker', {
    category: 'monster', health: 30, width: 1, height: 1, xp: 5, damage: 4,
    speed: 0, spawn: null, drops: [D('shulker_shell', 0, 1, 0.5)],
    goals: (m) => rangedGoals(m, 'shulker_bullet', { interval: 40, range: 16 }),
  });
  for (const [name, hp, dmg, w, h] of [
    ['vex', 14, 9, 0.4, 0.8], ['evoker', 24, 6, 0.6, 1.95],
    ['vindicator', 24, 13, 0.6, 1.95], ['pillager', 24, 5, 0.6, 1.95],
    ['ravager', 100, 12, 1.95, 2.2], ['warden', 500, 30, 0.9, 2.9]]) {
    def(name, {
      category: 'monster', health: hp, width: w, height: h, xp: 5, damage: dmg,
      speed: name === 'ravager' ? 0.3 : 0.35, spawn: null,
      flying: name === 'vex', model: name === 'warden' ? 'warden' : name,
      drops: name === 'pillager' ? [D('arrow', 0, 2)] : [],
      goals: (m) => (name === 'pillager'
        ? rangedGoals(m, 'arrow', { interval: 40, range: 16 })
        : meleeGoals(m)),
    });
  }
  def('wither', {
    category: 'misc', health: 300, width: 0.9, height: 3.5, xp: 50, damage: 8,
    speed: 0.6, spawn: null, flying: true, armor: 4, tags: ['undead', 'boss'],
    drops: [D('nether_star', 1)],
    goals: (m) => rangedGoals(m, 'wither_skull', { interval: 20, range: 40 }),
  });
  def('ender_dragon', {
    category: 'misc', health: 200, width: 16, height: 8, xp: 500, damage: 10,
    speed: 0.6, spawn: null, flying: true, tags: ['boss'],
    goals: (m) => { m.goals.add(1, new RandomStrollGoal(1.0)); },
  });

  return MOBS.size;
}

function teleportRandom(mob, world) {
  for (let i = 0; i < 16; i++) {
    const nx = Math.floor(mob.x) + world.random.intRange(-32, 32);
    const nz = Math.floor(mob.z) + world.random.intRange(-32, 32);
    const ny = world.standingYAt(nx, nz, Math.floor(mob.y) + 16);
    if (ny == null) continue;
    world.spawnParticles('portal', mob.x, mob.y + 1, mob.z, 16);
    mob.x = nx + 0.5; mob.y = ny; mob.z = nz + 0.5;
    mob.prevX = mob.x; mob.prevY = mob.y; mob.prevZ = mob.z;
    mob.updateBounds?.();
    world.playSound('mob.enderman.teleport', mob.x, mob.y, mob.z);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/** Create and add one mob of `type` at a position, or null if unknown. */
export function spawn(world, type, x, y, z, opts = {}) {
  const d = MOBS.get(type);
  if (!d) return null;
  const mob = new Mob(world, x, y, z, d);
  if (opts.baby) mob.setBaby(true);
  if (opts.persistent) mob.persistent = true;
  world.addEntity(mob);
  if (d.onSpawn) d.onSpawn(mob, world);
  return mob;
}

/** Count live mobs per spawn category. */
function categoryCounts(world) {
  const counts = {};
  for (const e of world.entities) {
    if (!(e instanceof Mob)) continue;
    counts[e.category] = (counts[e.category] ?? 0) + 1;
  }
  return counts;
}

/**
 * One natural-spawning attempt round. Mirrors Minecraft's rules: candidate
 * positions between 24 and 128 blocks from a player, pack spawning, per-category
 * caps, and a per-mob placement predicate.
 */
export function trySpawnMobs(world, player) {
  if (world.difficulty === 0) return 0;
  const counts = categoryCounts(world);
  const rng = world.random;
  let spawned = 0;

  const eligible = [...MOBS.values()].filter((d) => d.spawn && d.weight);
  if (eligible.length === 0) return 0;
  const totalWeight = eligible.reduce((a, d) => a + d.weight, 0);

  for (let attempt = 0; attempt < 16; attempt++) {
    // A random column in the simulation ring around the player.
    const angle = rng.next() * Math.PI * 2;
    const dist = 24 + rng.next() * 80;
    const x = Math.floor(player.x + Math.cos(angle) * dist);
    const z = Math.floor(player.z + Math.sin(angle) * dist);
    if (!world.isChunkLoadedAt(x, z)) continue;

    // Pick a species first, then test whether this spot suits it.
    let r = rng.next() * totalWeight;
    let d = eligible[0];
    for (const cand of eligible) { r -= cand.weight; if (r <= 0) { d = cand; break; } }

    const cap = CATEGORY[d.category]?.cap ?? 0;
    if (cap === 0 || (counts[d.category] ?? 0) >= cap) continue;

    const y = d.spawn === SPAWN.water
      ? rng.intRange(SEA_LEVEL - 12, SEA_LEVEL - 1)
      : world.standingYAt(x, z, MAX_Y);
    if (y == null || y <= MIN_Y + 1) continue;
    if (!fits(world, x, y, z, d)) continue;
    if (!d.spawn(world, x, y, z)) continue;

    // Pack spawning: a small group appears together.
    const packMin = d.packMin ?? 1, packMax = d.packMax ?? 1;
    const n = packMin === packMax ? packMin : rng.intRange(packMin, packMax);
    for (let i = 0; i < n; i++) {
      const px = x + (i === 0 ? 0 : rng.intRange(-4, 4));
      const pz = z + (i === 0 ? 0 : rng.intRange(-4, 4));
      const py = d.spawn === SPAWN.water ? y : world.standingYAt(px, pz, y + 4);
      if (py == null || !fits(world, px, py, pz, d)) continue;
      if (!d.spawn(world, px, py, pz)) continue;
      const mob = spawn(world, d.name, px + 0.5, py, pz + 0.5, {
        baby: d.category === 'creature' && rng.int(20) === 0,
      });
      if (mob) { spawned++; counts[d.category] = (counts[d.category] ?? 0) + 1; }
    }
    if (spawned > 0) break;   // one successful pack per round, as in vanilla
  }
  return spawned;
}

/** Is there room for a mob of this size, clear of blocks and fluid? */
function fits(world, x, y, z, d) {
  const h = Math.ceil(d.height);
  const wide = Math.ceil(d.width) - 1;
  for (let dy = 0; dy < h; dy++) {
    for (let dz = -wide; dz <= wide; dz++) {
      for (let dx = -wide; dx <= wide; dx++) {
        const s = world.getBlock(x + dx, y + dy, z + dz);
        if (T.solid[s]) return false;
        if (d.aquatic ? T.fluid[s] !== 1 : T.fluid[s] !== 0) return false;
      }
    }
  }
  return true;
}

/** Used by spawn eggs and by structures placing their inhabitants. */
export function spawnFromEgg(world, type, x, y, z) {
  return spawn(world, type, x, y, z, { persistent: true });
}

export function mobNames() { return [...MOBS.keys()]; }
export function mobDef(name) { return MOBS.get(name) ?? null; }
