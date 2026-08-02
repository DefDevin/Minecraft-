// Block-behaviour adapters.
//
// Block definitions stay free of UI, audio and entity dependencies by calling
// through optional namespaces on `world.game` — `world.game?.ui?.openMenu?.(…)`.
// This file supplies those namespaces, routing each call to whichever system is
// actually loaded and degrading quietly when one is not.

import { ItemStack, itemsByName } from './items.js';
import { blockOf, blocksByName, T } from '../world/blocks.js';
import {
  FallbackInventoryScreen, FallbackContainerScreen,
} from './ui/fallbackscreens.js';

/** Workstation menus that are really just a crafting grid. */
const CRAFTING_MENUS = new Set(['crafting']);

export function installHooks(game) {
  const M = game.modules;

  // -- UI ------------------------------------------------------------------

  game.ui = {
    /** Open a workstation screen (crafting table, furnace, anvil, …). */
    openMenu(menu, world, x, y, z, player) {
      const screens = M.containers;
      const Screen = screens?.screenFor?.(menu) ?? screens?.[menuClassName(menu)];
      if (Screen) {
        game.pushScreen(new Screen(game, world, x, y, z, player));
        return true;
      }
      if (CRAFTING_MENUS.has(menu)) {
        game.pushScreen(new FallbackInventoryScreen(game, 3));
        return true;
      }
      // Anything with a block entity that exposes slots can use the generic
      // container screen rather than silently doing nothing.
      const be = world.getBlockEntity(x, y, z);
      if (be?.slots) {
        game.pushScreen(new FallbackContainerScreen(game, be, titleFor(menu)));
        return true;
      }
      game.chat(`${titleFor(menu)} needs the container UI module`);
      return false;
    },

    openContainer(world, x, y, z, player) {
      const be = world.getBlockEntity(x, y, z);
      const Screen = M.containers?.ChestScreen;
      if (Screen && be) { game.pushScreen(new Screen(game, be, world, x, y, z)); return true; }
      if (be?.slots) {
        const def = blockOf(world.getBlock(x, y, z));
        game.pushScreen(new FallbackContainerScreen(game, be, def?.displayName ?? 'Container'));
        world.playSound('chest.open', x + 0.5, y + 0.5, z + 0.5);
        return true;
      }
      return false;
    },

    openEnderChest(world, player) {
      const inv = player.inventory;
      if (!inv.enderChest) inv.enderChest = { slots: new Array(27).fill(null) };
      game.pushScreen(new FallbackContainerScreen(game, inv.enderChest, 'Ender Chest'));
      return true;
    },

    openLectern(world, x, y, z, player) {
      const be = world.getBlockEntity(x, y, z);
      if (M.containers?.LecternScreen && be) {
        game.pushScreen(new M.containers.LecternScreen(game, be));
        return true;
      }
      return false;
    },

    useBookshelf(world, x, y, z, state, player, hit) {
      return M.containers?.useChiseledBookshelf?.(world, x, y, z, state, player, hit) ?? false;
    },

    /** Put a plant into a flower pot, or take it out. */
    potPlant(world, x, y, z, player) {
      const stack = player.heldItem?.();
      const state = world.getBlock(x, y, z);
      const def = blockOf(state);
      const potted = M.blockdefs?.potted;
      if (!potted) return false;
      if (def?.name === 'flower_pot' && stack && !stack.empty) {
        const target = potted[stack.item.name];
        if (!target || !blocksByName.has(target)) return false;
        world.setBlock(x, y, z, blocksByName.get(target).defaultState);
        if (player.gamemode === 0) {
          stack.count--;
          if (stack.count <= 0) player.inventory.setSelected?.(null);
        }
        world.playSound('place.stone', x + 0.5, y + 0.5, z + 0.5);
        return true;
      }
      // Emptying: find which plant this potted block holds.
      for (const [plant, pot] of Object.entries(potted)) {
        if (pot === def?.name) {
          world.setBlock(x, y, z, blocksByName.get('flower_pot').defaultState);
          game.spawnItem(world, x + 0.5, y + 0.5, z + 0.5, new ItemStack(plant, 1));
          return true;
        }
      }
      return false;
    },
  };

  // -- Drops ---------------------------------------------------------------

  game.drops = {
    spawnItem(world, x, y, z, itemName, count = 1, damage = 0) {
      if (!itemsByName.has(itemName) || count <= 0) return null;
      return game.spawnItem(world, x + 0.5, y + 0.5, z + 0.5,
        new ItemStack(itemName, count, damage));
    },
    spawnStack(world, x, y, z, stack) {
      return game.spawnItem(world, x + 0.5, y + 0.5, z + 0.5, stack);
    },
    spawnExperience(world, x, y, z, amount) {
      M.experience?.spawnOrbs?.(world, x + 0.5, y + 0.5, z + 0.5, amount);
    },
  };

  // -- Damage & contact effects --------------------------------------------

  const hurt = (entity, amount, source) => {
    if (entity?.hurt) entity.hurt(amount, source);
  };

  game.damage = {
    onCactusContact(world, entity) { hurt(entity, 1, 'cactus'); },
    onBerryBush(world, entity) {
      // Only damages you if you are actually moving through it.
      if (Math.abs(entity.vx ?? 0) + Math.abs(entity.vz ?? 0) > 0.003) hurt(entity, 1, 'berry_bush');
    },
    onMagmaContact(world, entity) {
      if (entity?.sneaking) return;
      if (entity?.effects?.has?.('fire_resistance')) return;
      hurt(entity, 1, 'fire');
    },
    onLavaContact(world, entity) {
      if (entity?.effects?.has?.('fire_resistance')) return;
      hurt(entity, 4, 'lava');
      if (entity) entity.fireTicks = Math.max(entity.fireTicks ?? 0, 300);
    },
    onCampfire(world, entity, soul) {
      if (entity?.effects?.has?.('fire_resistance')) return;
      hurt(entity, soul ? 2 : 1, 'fire');
    },
    onSweetBerry(world, entity) { hurt(entity, 1, 'berry_bush'); },
    generic(world, entity, amount, source) { hurt(entity, amount, source); },
    explode(world, x, y, z, power, opts) {
      M.combat?.explode?.(world, x, y, z, power, opts);
    },
  };

  // -- Status effects ------------------------------------------------------

  game.effects = {
    applyWither(world, entity) {
      if (M.effects?.apply) M.effects.apply(entity, 'wither', 40, 0);
      else if (entity?.effects) entity.effects.set('wither', { amplifier: 0, duration: 40 });
    },
    onPowderSnow(world, entity) {
      // Powder snow freezes you unless you are wearing leather boots.
      const boots = entity?.inventory?.getArmor?.(3);
      if (boots?.item?.name?.startsWith('leather_')) return;
      entity.freezeTicks = (entity.freezeTicks ?? 0) + 1;
      if (entity.freezeTicks > 140 && entity.freezeTicks % 40 === 0) hurt(entity, 1, 'freeze');
    },
    apply(entity, id, duration, amplifier) {
      if (M.effects?.apply) M.effects.apply(entity, id, duration, amplifier);
      else if (entity?.effects) entity.effects.set(id, { amplifier, duration });
    },
  };

  // -- Audio ---------------------------------------------------------------

  game.audio = {
    playNote(world, x, y, z, instrument, note) {
      world.playSound(`note.${instrument}`, x + 0.5, y + 0.5, z + 0.5, 3,
        Math.pow(2, (note - 12) / 12));
      world.spawnParticles('note', x + 0.5, y + 1.2, z + 0.5, 1, { note });
    },
    useJukebox(world, x, y, z, state, player, hand) {
      return M.blockEntity?.useJukebox?.(world, x, y, z, state, player, hand) ?? false;
    },
  };

  // -- Systems that live in their own modules ------------------------------

  game.redstone = M.redstone?.hooks ?? M.redstone ?? null;
  game.fluids = M.fluids?.hooks ?? M.fluids ?? null;
  game.features = M.features ?? null;
  game.physics = {
    /** Start a falling-block entity for sand, gravel and concrete powder. */
    startFalling(world, x, y, z, state) {
      const E = M.itemEntity?.FallingBlockEntity;
      if (!E) return false;
      world.setBlock(x, y, z, 0);
      world.addEntity(new E(world, x + 0.5, y, z + 0.5, state));
      return true;
    },
    pushEntities: M.pistons?.pushEntities ?? null,
  };
  game.dimensions = {
    travel(world, entity, target) {
      return game.travelToDimension?.(entity, target) ?? false;
    },
    lightPortal(world, x, y, z) {
      return M.features?.lightNetherPortal?.(world, x, y, z) ?? false;
    },
  };
  game.crafting = {
    compost(world, x, y, z, state, player, hand) {
      return M.farming?.compost?.(world, x, y, z, state, player, hand) ?? false;
    },
  };
  game.fire = {
    trySpread(world, x, y, z) { return M.fluids?.trySpreadFire?.(world, x, y, z) ?? false; },
  };
  game.spawn = {
    setRespawn(player, x, y, z) { player.spawnPoint = { x: x + 0.5, y: y + 1, z: z + 0.5 }; },
  };
  game.sleep = {
    trySleep(world, x, y, z, player) {
      if (world.isDay()) { game.chat('You can only sleep at night'); return false; }
      player.spawnPoint = { x: x + 0.5, y: y + 1, z: z + 0.5 };
      // Skip to dawn and clear the weather, as sleeping does in the real game.
      world.time = Math.floor(world.time / 24000) * 24000 + 24000;
      world.raining = false; world.thundering = false;
      game.chat('Good morning.');
      return true;
    },
  };
  game.food = {
    eat(world, player, stack) { game.startEating(stack); return true; },
  };
  game.explosions = game.damage;
  game.warden = {
    onShriek() { /* the warden module wires itself in when present */ },
    onSculkSensor() {},
  };

  return game;
}

function menuClassName(menu) {
  return `${menu.split('_').map((s) => s[0].toUpperCase() + s.slice(1)).join('')}Screen`;
}

function titleFor(menu) {
  return menu.split('_').map((s) => s[0].toUpperCase() + s.slice(1)).join(' ');
}
