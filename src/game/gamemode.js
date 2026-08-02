// Game modes.
//
// Every "may I?" question the rest of the game asks — may I break this, may I
// be hurt, do I have a hunger bar, can I fly — is answered from one table here
// rather than by scattering `gamemode === 1` tests through the codebase.
//
// The ids match `GAMEMODE` in entity/player.js; they are repeated rather than
// imported so this module stays a leaf that anything can depend on.

export const GAMEMODE = { SURVIVAL: 0, CREATIVE: 1, ADVENTURE: 2, SPECTATOR: 3 };

export const GAMEMODE_NAMES = ['survival', 'creative', 'adventure', 'spectator'];

/**
 * The complete rule set for one mode.
 *
 * @typedef {object} GamemodeRules
 * @property {number}  id
 * @property {string}  name
 * @property {boolean} canBreak            may break blocks at all
 * @property {boolean} instantBreak        blocks break in one hit
 * @property {boolean} needsCorrectTool    harvest level is enforced
 * @property {boolean} canPlace            may place blocks
 * @property {boolean} requiresAdventureTag in adventure mode, only blocks the
 *                                          held item is tagged for
 * @property {boolean} canInteract         may use doors, chests, buttons
 * @property {boolean} canAttack           may damage entities
 * @property {boolean} takesDamage         may be damaged
 * @property {boolean} invulnerable        immune to everything but /kill
 * @property {boolean} hasHunger           the food bar ticks
 * @property {boolean} hasHealth           the health bar is shown and used
 * @property {boolean} dropsInventory      items spill on death
 * @property {boolean} canFly              flight is available
 * @property {boolean} alwaysFlying        flight cannot be switched off
 * @property {boolean} infiniteResources   placing does not consume the stack
 * @property {boolean} noClip              passes through blocks
 * @property {boolean} visibleToOthers     rendered for other players
 * @property {boolean} mobsTarget          hostile mobs notice them
 * @property {boolean} canPickUpItems      item entities are collected
 * @property {boolean} usesDurability      tools wear out
 * @property {number}  blockReach          block interaction distance
 * @property {number}  entityReach         attack distance
 */

const SURVIVAL = Object.freeze({
  id: GAMEMODE.SURVIVAL,
  name: 'survival',
  canBreak: true,
  instantBreak: false,
  needsCorrectTool: true,
  canPlace: true,
  requiresAdventureTag: false,
  canInteract: true,
  canAttack: true,
  takesDamage: true,
  invulnerable: false,
  hasHunger: true,
  hasHealth: true,
  dropsInventory: true,
  canFly: false,
  alwaysFlying: false,
  infiniteResources: false,
  noClip: false,
  visibleToOthers: true,
  mobsTarget: true,
  canPickUpItems: true,
  usesDurability: true,
  blockReach: 4.5,
  entityReach: 3,
});

const CREATIVE = Object.freeze({
  ...SURVIVAL,
  id: GAMEMODE.CREATIVE,
  name: 'creative',
  instantBreak: true,
  needsCorrectTool: false,
  takesDamage: false,
  invulnerable: true,
  hasHunger: false,
  dropsInventory: false,
  canFly: true,
  infiniteResources: true,
  mobsTarget: false,
  usesDurability: false,
  blockReach: 5,
  entityReach: 5,
});

const ADVENTURE = Object.freeze({
  ...SURVIVAL,
  id: GAMEMODE.ADVENTURE,
  name: 'adventure',
  canBreak: false,
  canPlace: false,
  requiresAdventureTag: true,
});

const SPECTATOR = Object.freeze({
  ...SURVIVAL,
  id: GAMEMODE.SPECTATOR,
  name: 'spectator',
  canBreak: false,
  canPlace: false,
  canInteract: false,
  canAttack: false,
  takesDamage: false,
  invulnerable: true,
  hasHunger: false,
  hasHealth: false,
  dropsInventory: false,
  canFly: true,
  alwaysFlying: true,
  infiniteResources: false,
  noClip: true,
  visibleToOthers: false,
  mobsTarget: false,
  canPickUpItems: false,
  usesDurability: false,
  blockReach: 0,
  entityReach: 0,
});

/** The rules table, indexed by gamemode id. */
export const GAMEMODE_RULES = Object.freeze([SURVIVAL, CREATIVE, ADVENTURE, SPECTATOR]);

/** Alias so callers can write `RULES.creative`. */
export const RULES = Object.freeze({
  survival: SURVIVAL, creative: CREATIVE, adventure: ADVENTURE, spectator: SPECTATOR,
});

/** Rules for a mode id (or a player). Unknown ids fall back to survival. */
export function rulesFor(mode) {
  const id = typeof mode === 'object' && mode !== null ? mode.gamemode : mode;
  return GAMEMODE_RULES[id] ?? SURVIVAL;
}

/** Look a mode up by name ('survival', 'c', '1', …). */
export function byName(name) {
  if (name == null) return null;
  const s = String(name).toLowerCase();
  const n = Number(s);
  if (Number.isInteger(n) && GAMEMODE_RULES[n]) return GAMEMODE_RULES[n];
  const exact = GAMEMODE_NAMES.indexOf(s);
  if (exact >= 0) return GAMEMODE_RULES[exact];
  const initial = GAMEMODE_NAMES.findIndex((g) => g[0] === s[0]);
  return initial >= 0 ? GAMEMODE_RULES[initial] : null;
}

export function nameOf(mode) { return rulesFor(mode).name; }

/**
 * Switch a player's mode and bring their flags into line with it: creative and
 * spectator gain flight, spectator is always flying, and leaving them lands
 * the player again.
 */
export function applyGamemode(player, mode) {
  const rules = rulesFor(mode);
  player.gamemode = rules.id;
  player.canFly = rules.canFly;
  if (rules.alwaysFlying) player.flying = true;
  else if (!rules.canFly) player.flying = false;
  player.reach = rules.blockReach;
  if (rules.invulnerable) {
    player.fireTicks = 0;
    player.fallDistance = 0;
  }
  if (!rules.hasHunger) {
    player.food = 20;
    player.saturation = 5;
    player.exhaustion = 0;
  }
  if (rules.id === GAMEMODE.SPECTATOR) player.dead = false;
  return rules;
}

// ---------------------------------------------------------------------------
// Permission queries
// ---------------------------------------------------------------------------

/** May this player break the block they are looking at? */
export function canBreakBlock(player, blockDef, stack) {
  const rules = rulesFor(player.gamemode);
  if (!rules.canBreak) return false;
  if (blockDef && blockDef.hardness < 0 && !rules.instantBreak) return false;
  if (rules.requiresAdventureTag) return canDestroyTagged(stack, blockDef);
  return true;
}

/** May this player place the block they are holding? */
export function canPlaceBlock(player, blockDef, stack) {
  const rules = rulesFor(player.gamemode);
  if (!rules.canPlace) return false;
  if (rules.requiresAdventureTag) return canPlaceTagged(stack, blockDef);
  return true;
}

/** Adventure mode honours `CanDestroy` on the held stack. */
function canDestroyTagged(stack, blockDef) {
  const list = stack?.tag?.canDestroy;
  return Array.isArray(list) && !!blockDef && list.includes(blockDef.name);
}

/** Adventure mode honours `CanPlaceOn` on the held stack. */
function canPlaceTagged(stack, blockDef) {
  const list = stack?.tag?.canPlaceOn;
  return Array.isArray(list) && !!blockDef && list.includes(blockDef.name);
}

export function canAttack(player) { return rulesFor(player.gamemode).canAttack; }
export function canInteract(player) { return rulesFor(player.gamemode).canInteract; }
export function takesDamage(player) { return rulesFor(player.gamemode).takesDamage; }
export function hasHunger(player) { return rulesFor(player.gamemode).hasHunger; }
export function consumesItems(player) { return !rulesFor(player.gamemode).infiniteResources; }
export function usesDurability(player) { return rulesFor(player.gamemode).usesDurability; }
export function isSpectator(player) { return player?.gamemode === GAMEMODE.SPECTATOR; }
export function isCreative(player) { return player?.gamemode === GAMEMODE.CREATIVE; }

/** Reach for blocks (4.5 in survival, 5 in creative, 0 for spectators). */
export function blockReach(player) { return rulesFor(player.gamemode).blockReach; }
export function entityReach(player) { return rulesFor(player.gamemode).entityReach; }
