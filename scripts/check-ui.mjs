// Unit tests for the inventory model.
//
// `src/game/inventory.js` is deliberately DOM-free, so the rules that decide
// where an item ends up — stack merging, shift-click routing, drag
// distribution, armour equipping and save/load — can be checked in node
// without a browser. The drawing code that sits on top of it lives in
// src/game/ui/ and is exercised by scripts/smoke.mjs instead.
//
//   node scripts/check-ui.mjs

import { defineItem, ItemStack, itemsByName } from '../src/game/items.js';
import {
  Container, PlayerInventory, ContainerMenu, Slot, transferStack,
  HOTBAR_SIZE, INVENTORY_SIZE, ARMOR, CLICK,
} from '../src/game/inventory.js';

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];
let group = '';

const section = (name) => { group = name; console.log(`\n${name}`); };

function ok(cond, what) {
  if (cond) {
    passed++;
    console.log(`  pass  ${what}`);
  } else {
    failures.push(`${group}: ${what}`);
    console.log(`  FAIL  ${what}`);
  }
}

const fmt = (v) => (v === null ? 'null' : v === undefined ? 'undefined' : String(v));

function eq(a, b, what) {
  ok(Object.is(a, b), Object.is(a, b) ? what : `${what} (got ${fmt(a)}, want ${fmt(b)})`);
}

function deep(a, b, what) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  ok(ja === jb, ja === jb ? what : `${what}\n        got  ${ja}\n        want ${jb}`);
}

// ---------------------------------------------------------------------------
// A handful of items to shuffle around
// ---------------------------------------------------------------------------

defineItem('test_stone', { maxStack: 64 });
defineItem('test_dirt', { maxStack: 64 });
defineItem('test_egg', { maxStack: 16 });
defineItem('test_sword', { maxStack: 1, maxDamage: 250, attackDamage: 7 });
defineItem('test_helmet', { maxStack: 1, maxDamage: 165, armorSlot: ARMOR.HEAD, defense: 2 });
defineItem('test_boots', { maxStack: 1, maxDamage: 195, armorSlot: ARMOR.FEET, defense: 1 });

const stack = (name, n = 1) => new ItemStack(name, n);
const counts = (c) => c.slots.map((s) => (s ? `${s.item.name}x${s.count}` : '-'));

// ---------------------------------------------------------------------------

section('addItem: stacking and overflow');
{
  const inv = new PlayerInventory();

  ok(inv.slots.length === INVENTORY_SIZE, `inventory has ${INVENTORY_SIZE} slots`);
  ok(inv.armorSlots.length === 4 && inv.offhand === null, 'four armour slots and an offhand');

  ok(inv.addItem(stack('test_stone', 30)), 'a fresh stack of 30 is accepted');
  eq(inv.slots[0].count, 30, 'it lands in the first hotbar slot');

  const more = stack('test_stone', 50);
  ok(inv.addItem(more), '50 more are accepted');
  eq(inv.slots[0].count, 64, 'the first slot fills to 64');
  eq(inv.slots[1].count, 16, 'the remaining 16 spill into the next slot');
  eq(more.count, 0, 'the source stack is emptied');

  // Items with a smaller stack limit must respect it.
  inv.addItem(stack('test_egg', 40));
  eq(inv.slots[2].count, 16, 'eggs cap at 16 per slot');
  eq(inv.slots[3].count, 16, 'and spill');
  eq(inv.slots[4].count, 8, 'and spill again');

  // Damaged tools never merge.
  const swordA = stack('test_sword', 1);
  const swordB = stack('test_sword', 1);
  swordB.damage = 40;
  inv.addItem(swordA);
  inv.addItem(swordB);
  ok(inv.slots[5].item.name === 'test_sword' && inv.slots[6].item.name === 'test_sword',
    'two swords take two slots');
  ok(!swordA.matches(swordB), 'stacks with different damage do not match');

  // Overflow: fill the whole inventory and check the leftovers come back.
  const full = new PlayerInventory();
  for (let i = 0; i < INVENTORY_SIZE; i++) full.slots[i] = stack('test_stone', 64);
  const extra = stack('test_stone', 100);
  ok(!full.addItem(extra), 'a full inventory rejects the stack');
  eq(extra.count, 100, 'and leaves every item in the caller\'s stack');

  full.slots[35] = stack('test_stone', 60);
  const partial = stack('test_stone', 10);
  ok(!full.addItem(partial), 'a nearly-full inventory reports the partial add');
  eq(partial.count, 6, 'after topping up the one slot with room');
  eq(full.slots[35].count, 64, 'which is now full');

  // The held slot is topped up before anything else.
  const held = new PlayerInventory();
  held.setSelectedSlot(4);
  held.slots[0] = stack('test_dirt', 60);
  held.slots[4] = stack('test_dirt', 10);
  held.addItem(stack('test_dirt', 3));
  eq(held.slots[4].count, 13, 'a pickup tops up the selected slot first');
  eq(held.slots[0].count, 60, 'leaving earlier slots alone');
}

section('selection and the hotbar');
{
  const inv = new PlayerInventory();
  inv.slots[3] = stack('test_stone', 5);
  inv.setSelectedSlot(3);
  eq(inv.getSelected().item.name, 'test_stone', 'getSelected reads the hotbar');
  inv.setSelected(stack('test_dirt', 2));
  eq(inv.slots[3].item.name, 'test_dirt', 'setSelected writes it back');
  eq(inv.scroll(1), 4, 'scrolling moves the cursor');
  eq(inv.scroll(-6), 7, 'and wraps around the nine slots');

  inv.slots[20] = stack('test_egg', 3);
  ok(inv.selectExisting('test_egg'), 'selectExisting finds an item in the main rows');
  eq(inv.getSelected().item.name, 'test_egg', 'and swaps it into the hotbar');
  ok(!inv.selectExisting('test_sword'), 'and reports failure when there is none');

  inv.setOffhand(stack('test_stone', 1));
  eq(inv.getOffhand().item.name, 'test_stone', 'offhand round-trips');
  inv.swapHands();
  eq(inv.getSelected().item.name, 'test_stone', 'swapHands exchanges main and offhand');
  eq(inv.getOffhand().item.name, 'test_egg', 'both ways');
}

section('shift-click transfer between two containers');
{
  const inv = new PlayerInventory();
  const chest = new Container(27, { title: 'Chest', type: 'chest' });

  inv.slots[0] = stack('test_stone', 64);
  ok(transferStack(inv, 0, chest), 'a full stack moves from the inventory to the chest');
  eq(inv.slots[0], null, 'the source slot is cleared');
  eq(chest.slots[0].count, 64, 'and the chest holds it');

  // Partial merge: the chest can only take some of it.
  chest.slots.fill(null);
  for (let i = 0; i < 27; i++) chest.slots[i] = stack('test_stone', 64);
  chest.slots[26] = stack('test_stone', 60);
  inv.slots[0] = stack('test_stone', 20);
  ok(transferStack(inv, 0, chest), 'a partial transfer still reports success');
  eq(chest.slots[26].count, 64, 'the chest slot with room is topped up');
  eq(inv.slots[0].count, 16, 'and the rest stays behind');

  // Through a menu, which is how a real screen does it.
  const menu = new ContainerMenu({ inventory: inv });
  const chest2 = new Container(27, { title: 'Chest', type: 'chest' });
  menu.addContainer(chest2, { x: 8, y: 18, group: 'container' });
  menu.addContainer(inv, { x: 8, y: 84, from: HOTBAR_SIZE, to: INVENTORY_SIZE, group: 'main' });
  menu.addContainer(inv, { x: 8, y: 142, from: 0, to: HOTBAR_SIZE, group: 'hotbar' });
  menu.section('container', 0, 27);
  menu.section('player', 27, 27 + INVENTORY_SIZE);

  inv.slots.fill(null);
  inv.slots[9] = stack('test_dirt', 32);
  ok(menu.quickMove(27), 'shift-clicking a player slot pushes into the chest');
  eq(chest2.slots[0].count, 32, 'the chest receives the stack');
  eq(inv.slots[9], null, 'the player slot is emptied');

  ok(menu.quickMove(0), 'shift-clicking the chest slot pushes it back');
  eq(chest2.slots[0], null, 'the chest slot is emptied');
  eq(inv.slots[9].count, 32, 'and the player has it again');

  // A container that cannot accept the item leaves everything alone.
  const fuelOnly = new Container(1, { filter: (_i, s) => s.item.name === 'test_egg' });
  const src = new Container(1);
  src.slots[0] = stack('test_stone', 4);
  ok(!transferStack(src, 0, fuelOnly), 'a filtered container refuses the wrong item');
  eq(src.slots[0].count, 4, 'and the source is untouched');
}

section('the click protocol');
{
  const inv = new PlayerInventory();
  const menu = new ContainerMenu({ inventory: inv, creative: true });
  menu.addContainer(inv, { x: 8, y: 8, from: 0, to: INVENTORY_SIZE });
  menu.section('player', 0, INVENTORY_SIZE);

  inv.slots[0] = stack('test_stone', 10);
  menu.click(0, CLICK.LEFT);
  eq(menu.cursor.count, 10, 'left click picks the whole stack up');
  eq(inv.slots[0], null, 'leaving the slot empty');

  menu.click(1, CLICK.RIGHT);
  eq(inv.slots[1].count, 1, 'right click places one');
  eq(menu.cursor.count, 9, 'and keeps the rest on the cursor');

  menu.click(1, CLICK.LEFT);
  eq(inv.slots[1].count, 10, 'left click places the remainder');
  eq(menu.cursor, null, 'and empties the cursor');

  menu.click(1, CLICK.RIGHT);
  eq(menu.cursor.count, 5, 'right click on a stack of 10 takes half');
  eq(inv.slots[1].count, 5, 'leaving half behind');

  inv.slots[2] = stack('test_dirt', 3);
  menu.click(2, CLICK.LEFT);
  eq(menu.cursor.item.name, 'test_dirt', 'clicking a different item swaps');
  eq(inv.slots[2].item.name, 'test_stone', 'the cursor stack lands in the slot');

  menu.cursor = null;
  menu.click(1, CLICK.MIDDLE, { creative: true });
  eq(menu.cursor.count, 64, 'middle click clones a full stack in creative');

  menu.cursor = null;
  inv.slots[8] = null;
  inv.slots[3] = stack('test_egg', 4);
  menu.hotbarSwap(3, 8);
  eq(inv.slots[8].item.name, 'test_egg', 'number keys swap into the hotbar slot');
  eq(inv.slots[3], null, 'and clear the source');

  // Clicking outside the panel throws the cursor away.
  const dropped = [];
  menu.onDrop = (s) => dropped.push(s);
  menu.cursor = stack('test_stone', 7);
  menu.clickOutside(CLICK.RIGHT);
  eq(dropped[0].count, 1, 'right click outside drops one');
  menu.clickOutside(CLICK.LEFT);
  eq(dropped[1].count, 6, 'left click outside drops the rest');
  eq(menu.cursor, null, 'and the cursor is empty');
}

section('drag distribution');
{
  const inv = new PlayerInventory();
  const menu = new ContainerMenu({ inventory: inv, creative: true });
  menu.addContainer(inv, { x: 8, y: 8, from: 0, to: INVENTORY_SIZE });
  menu.section('player', 0, INVENTORY_SIZE);

  // Left drag: split evenly, remainder stays on the cursor.
  menu.cursor = stack('test_stone', 10);
  menu.beginDrag(CLICK.LEFT, 0);
  menu.dragOver(1);
  menu.dragOver(2);
  eq(menu.dragCount(1), 3, 'the preview shows three per slot');
  ok(menu.finishDrag(), 'the drag places items');
  deep([inv.slots[0].count, inv.slots[1].count, inv.slots[2].count], [3, 3, 3],
    'ten items over three slots is three each');
  eq(menu.cursor.count, 1, 'and one is left on the cursor');

  // Right drag: one per slot.
  menu.cursor = stack('test_dirt', 5);
  menu.beginDrag(CLICK.RIGHT, 10);
  menu.dragOver(11);
  menu.dragOver(12);
  menu.finishDrag();
  deep([inv.slots[10].count, inv.slots[11].count, inv.slots[12].count], [1, 1, 1],
    'a right drag places exactly one per slot');
  eq(menu.cursor.count, 2, 'and keeps the rest');

  // A drag over a slot holding something else must skip it.
  inv.slots[20] = stack('test_egg', 1);
  menu.cursor = stack('test_stone', 8);
  menu.beginDrag(CLICK.LEFT, 18);
  menu.dragOver(19);
  ok(!menu.dragOver(20), 'a slot holding a different item is not dragged over');
  menu.finishDrag();
  deep([inv.slots[18].count, inv.slots[19].count, inv.slots[20].count], [4, 4, 1],
    'the incompatible slot is left alone');

  // Dragging onto occupied matching slots tops them up.
  menu.cursor = stack('test_stone', 4);
  menu.beginDrag(CLICK.LEFT, 18);
  menu.dragOver(19);
  menu.finishDrag();
  deep([inv.slots[18].count, inv.slots[19].count], [6, 6], 'a second drag adds to both');

  // Press and release without moving is an ordinary click, not a drag.
  menu.cursor = stack('test_dirt', 6);
  menu.pointerDown(30, CLICK.LEFT, {});
  menu.pointerUp(30, CLICK.LEFT, {});
  eq(inv.slots[30].count, 6, 'a click in place places the whole stack');
  eq(menu.cursor, null, 'and clears the cursor');
}

section('armour');
{
  const inv = new PlayerInventory();

  const helmet = stack('test_helmet', 1);
  ok(inv.autoEquip(helmet), 'a helmet equips into the head slot');
  eq(inv.getArmor(ARMOR.HEAD).item.name, 'test_helmet', 'and is readable through getArmor');
  eq(inv.armorValue, 2, 'armour points add up');

  ok(!inv.autoEquip(stack('test_helmet', 1)), 'a second helmet does not displace the first');
  ok(!inv.autoEquip(stack('test_stone', 1)), 'a non-armour item never equips');

  const boots = stack('test_boots', 1);
  inv.autoEquip(boots);
  eq(inv.armorValue, 3, 'boots add their point');

  // Shift-clicking armour out of the inventory puts it on.
  const inv2 = new PlayerInventory();
  inv2.slots[10] = stack('test_boots', 1);
  ok(inv2.quickMove(10), 'shift-clicking boots equips them');
  eq(inv2.slots[10], null, 'the inventory slot is emptied');
  eq(inv2.getArmor(ARMOR.FEET).item.name, 'test_boots', 'and the feet slot is filled');

  // The armour container refuses the wrong piece.
  ok(!inv2.armor.mayPlace(ARMOR.HEAD, stack('test_boots', 1)),
    'boots may not go in the head slot');
  ok(inv2.armor.mayPlace(ARMOR.HEAD, stack('test_helmet', 1)),
    'a helmet may');

  // Through a menu, an armour slot only accepts its own piece.
  const menu = new ContainerMenu({ inventory: inv2 });
  const headSlot = menu.addSlot(new Slot(inv2.armor, ARMOR.HEAD, { x: 8, y: 8, group: 'armor' }));
  menu.cursor = stack('test_boots', 1);
  menu.click(0, CLICK.LEFT);
  eq(headSlot.get(), null, 'clicking boots into the head slot does nothing');
  menu.cursor = stack('test_helmet', 1);
  menu.click(0, CLICK.LEFT);
  eq(headSlot.get().item.name, 'test_helmet', 'a helmet goes straight in');

  // Wearing armour down.
  inv2.damageArmor(200);
  eq(inv2.getArmor(ARMOR.FEET), null, 'armour that runs out of durability breaks');
}

section('drop and death');
{
  const inv = new PlayerInventory();
  inv.slots[0] = stack('test_stone', 5);
  const one = inv.drop(0, false);
  eq(one.count, 1, 'drop takes a single item');
  eq(inv.slots[0].count, 4, 'and leaves the rest');
  const rest = inv.drop(0, true);
  eq(rest.count, 4, 'dropping all takes the stack');
  eq(inv.slots[0], null, 'clearing the slot');

  inv.slots[1] = stack('test_dirt', 3);
  inv.autoEquip(stack('test_helmet', 1));
  inv.setOffhand(stack('test_egg', 2));
  const all = inv.dropAll();
  eq(all.length, 3, 'dropAll returns held, worn and offhand items');
  ok(inv.isEmpty() && inv.getArmor(ARMOR.HEAD) === null && inv.offhand === null,
    'and empties the inventory');
}

section('save / load round-trip');
{
  const inv = new PlayerInventory();
  inv.slots[0] = stack('test_stone', 64);
  inv.slots[5] = stack('test_egg', 7);
  inv.slots[17] = stack('test_sword', 1);
  inv.slots[17].damage = 12;
  inv.slots[17].addEnchantment('sharpness', 3);
  inv.slots[35] = stack('test_dirt', 1);
  inv.autoEquip(stack('test_helmet', 1));
  inv.setOffhand(stack('test_dirt', 9));
  inv.setSelectedSlot(6);
  inv.enderChest.slots[4] = stack('test_stone', 12);

  const json = JSON.parse(JSON.stringify(inv.save()));
  const back = PlayerInventory.fromJSON(json);

  deep(counts(back), counts(inv), 'every main slot survives the round-trip');
  eq(back.selected, 6, 'the selected slot survives');
  eq(back.getArmor(ARMOR.HEAD).item.name, 'test_helmet', 'worn armour survives');
  eq(back.getOffhand().count, 9, 'the offhand survives');
  eq(back.enderChest.slots[4].count, 12, 'the ender chest survives');
  eq(back.slots[17].damage, 12, 'tool damage survives');
  eq(back.slots[17].getEnchantLevel('sharpness'), 3, 'enchantments survive');
  deep(back.save(), inv.save(), 'saving the reloaded inventory gives identical JSON');

  // Unknown items are dropped rather than throwing.
  const dodgy = { slots: [{ id: 'no_such_item', count: 3 }, null], armor: [], selected: 0 };
  const loaded = PlayerInventory.fromJSON(dodgy);
  eq(loaded.slots[0], null, 'an unknown item id loads as an empty slot');

  // Plain containers too.
  const chest = new Container(9);
  chest.slots[2] = stack('test_egg', 5);
  const chest2 = new Container(9).load(JSON.parse(JSON.stringify(chest.save())));
  deep(counts(chest2), counts(chest), 'a plain container round-trips');
}

section('registry sanity');
{
  ok(itemsByName.has('test_stone'), 'test items registered into the shared registry');
  ok(new Container(0).isEmpty(), 'a zero-slot container is empty');
}

// ---------------------------------------------------------------------------

console.log('');
if (failures.length === 0) {
  console.log(`all ${passed} assertions passed`);
  process.exit(0);
}
console.log(`${passed} passed, ${failures.length} failed:`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
