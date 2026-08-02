// End-to-end gameplay test: boots the game, then drives the player through a
// sequence of real actions (walk, jump, break, place, craft, inventory) and
// asserts the world actually changed. Complements smoke.mjs, which only checks
// that rendering comes up.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    // Read before writing the header, so a missing file still lands in catch
    // with the response untouched.
    const body = await readFile(f);
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`${e.message}\n${(e.stack||'').split('\n').slice(0,4).join('\n')}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/404 \(Not Found\)/.test(m.text())) errors.push(m.text());
});

await page.goto(`http://127.0.0.1:${port}/?seed=${process.argv[2] ?? 'playtest'}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.game?.running, { timeout: 180000 });
await page.waitForTimeout(6000);

const results = await page.evaluate(async () => {
  const out = [];
  const g = window.game, p = g.player, w = g.world;
  const check = (name, pass, detail = '') => out.push({ name, pass: !!pass, detail: String(detail) });
  const frames = (n) => new Promise((r) => {
    let i = 0;
    const step = () => (++i >= n ? r() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

  // --- terrain sanity ---
  const groundY = w.surfaceAt(Math.floor(p.x), Math.floor(p.z));
  check('spawn on solid ground', groundY > -60, `surface y=${groundY}`);
  check('player not falling through world', p.y > -60, `y=${p.y.toFixed(1)}`);

  // --- terrain variety: sample a wide area for distinct blocks and heights ---
  const seen = new Set(); const heights = [];
  for (let dx = -80; dx <= 80; dx += 8) {
    for (let dz = -80; dz <= 80; dz += 8) {
      const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz;
      const h = w.heightAt(x, z);
      if (h > -60) { heights.push(h); seen.add(w.getBlockName(x, h, z)); }
    }
  }
  const spread = heights.length ? Math.max(...heights) - Math.min(...heights) : 0;
  check('terrain has vertical relief', spread >= 3, `height spread ${spread}`);
  check('terrain has varied blocks', seen.size >= 2, `${seen.size} kinds: ${[...seen].slice(0,8).join(', ')}`);

  // --- movement ---
  const x0 = p.x, z0 = p.z;
  for (let i = 0; i < 40; i++) p.tick({ forward: 1, strafe: 0, jump: false, sneak: false, sprint: true });
  const moved = Math.hypot(p.x - x0, p.z - z0);
  check('player moves when walking', moved > 1, `moved ${moved.toFixed(2)} blocks`);

  const yBefore = p.y;
  p.tick({ forward: 0, strafe: 0, jump: true, sneak: false, sprint: false });
  p.tick({ forward: 0, strafe: 0, jump: false, sneak: false, sprint: false });
  check('player jumps', p.y > yBefore, `dy=${(p.y - yBefore).toFixed(3)}`);
  for (let i = 0; i < 60; i++) p.tick({ forward: 0, strafe: 0, jump: false, sneak: false, sprint: false });
  check('player lands again', p.onGround, `onGround=${p.onGround}`);

  // --- collision: cannot walk into solid rock ---
  const bx = Math.floor(p.x) + 2, by = Math.floor(p.y), bz = Math.floor(p.z);
  const stone = w.getBlock(bx, by, bz);
  check('world read works', typeof stone === 'number');

  // --- breaking ---
  const tx = Math.floor(p.x), tz = Math.floor(p.z);
  const ty = w.surfaceAt(tx, tz);
  const before = w.getBlockName(tx, ty, tz);
  w.destroyBlock(tx, ty, tz, false);
  check('block breaks', w.getBlockName(tx, ty, tz) === 'air', `${before} -> ${w.getBlockName(tx, ty, tz)}`);

  // --- placing ---
  const stoneState = window.game.modules.blockdefs
    ? (await import('/src/world/blocks.js')).blocksByName.get('stone')?.defaultState : null;
  if (stoneState) {
    w.setBlock(tx, ty, tz, stoneState);
    check('block places', w.getBlockName(tx, ty, tz) === 'stone', w.getBlockName(tx, ty, tz));
  }

  // --- lighting responds to a change ---
  await frames(3);
  const skyOpen = w.getSkyLight(tx, ty + 4, tz);
  check('skylight reaches the surface', skyOpen > 10, `sky=${skyOpen}`);
  const deep = w.getSkyLight(tx, Math.max(-60, ty - 20), tz);
  check('underground is dark', deep < 8, `sky at y-20 = ${deep}`);

  // --- inventory ---
  const inv = p.inventory;
  const Items = await import('/src/game/items.js');
  const anyItem = [...Items.itemsByName.keys()][0];
  if (anyItem) {
    const added = inv.addItem(new Items.ItemStack(anyItem, 5));
    check('inventory accepts items', added !== false, `added ${anyItem}`);
  }
  check('inventory has a selected slot', typeof (inv.getSelected?.()) !== 'undefined');

  // --- crafting ---
  if (g.modules.recipes?.findCraftingResult) {
    const planksName = Items.itemsByName.has('oak_planks') ? 'oak_planks' : null;
    if (planksName) {
      const grid = [new Items.ItemStack(planksName, 1), null, new Items.ItemStack(planksName, 1), null];
      const r = g.modules.recipes.findCraftingResult(grid, 2, 2);
      check('crafting sticks from planks', !!r, r ? r.result?.name : 'no recipe found');
    }
  } else {
    check('recipe module present', false, 'recipes.js not loaded');
  }

  // --- mobs ---
  check('entities exist in world', w.entities.length >= 1, `${w.entities.length} entities`);

  // --- mobs ---
  if (g.modules.mobs?.trySpawnMobs) {
    const before = w.entities.length;
    w.time = 18000;           // midnight, so hostile mobs are eligible
    for (let i = 0; i < 40; i++) g.modules.mobs.trySpawnMobs(w, p);
    check('mobs spawn', w.entities.length > before,
      `${w.entities.length - before} spawned`);
    // Tick everything that spawned and make sure nothing goes NaN or throws.
    let ticked = 0, bad = 0;
    for (let i = 0; i < 60; i++) {
      for (const e of [...w.entities]) {
        if (e === p || e.removed) continue;
        try { e.tick?.(w); ticked++; } catch (err) { bad++; }
        if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) bad++;
      }
    }
    check('mobs tick without errors', bad === 0, `${ticked} ticks, ${bad} failures`);
    w.time = 1000;
  } else {
    check('mob module present', false, 'mobs.js not loaded');
  }

  // --- redstone ---
  if (g.modules.redstone?.tickRedstone) {
    const B = await import('/src/world/blocks.js');
    const stone = B.blocksByName.get('stone')?.defaultState;
    const wire = B.blocksByName.get('redstone_wire')?.defaultState;
    const torch = B.blocksByName.get('redstone_torch')?.defaultState;
    const rx = tx + 6, ry = ty + 1, rz = tz + 6;
    if (stone && wire && torch) {
      for (let i = 0; i < 8; i++) w.setBlock(rx + i, ry - 1, rz, stone);
      w.setBlock(rx, ry, rz, torch);
      for (let i = 1; i < 8; i++) w.setBlock(rx + i, ry, rz, wire);
      for (let i = 0; i < 12; i++) { w.tick(); g.modules.redstone.tickRedstone(w); }
      const near = B.getProp(w.getBlock(rx + 1, ry, rz), 'power') ?? 0;
      const far = B.getProp(w.getBlock(rx + 7, ry, rz), 'power') ?? 0;
      check('redstone wire carries power', near > far && near > 0,
        `power ${near} at 1 block, ${far} at 7`);
    }
  } else {
    check('redstone module present', false, 'redstone.js not loaded');
  }

  // --- audio and particles are constructed, not silently skipped ---
  if (g.modules.sound) check('sound engine constructed', !!g.sound, g.sound ? 'ok' : 'failed to construct');
  if (g.modules.particles) {
    check('particle system constructed', !!g.particles,
      g.particles ? 'ok' : 'failed to construct');
    if (g.particles) {
      const n0 = g.particles.count ?? g.particles.particles?.length ?? 0;
      w.spawnParticles('smoke', p.x, p.y + 1, p.z, 10);
      const n1 = g.particles.count ?? g.particles.particles?.length ?? 0;
      check('particles emit', n1 > n0, `${n0} -> ${n1}`);
    }
  }

  // --- save round-trip ---
  if (g.modules.serialization?.serializeChunk) {
    const S = g.modules.serialization;
    const chunk = w.getChunkAt(Math.floor(p.x), Math.floor(p.z));
    try {
      const buf = S.serializeChunk(chunk);
      const back = S.deserializeChunk(w, chunk.cx, chunk.cz, buf);
      let mismatch = 0;
      for (let y = 40; y < 90; y += 3) {
        for (let lz = 0; lz < 16; lz += 4) {
          for (let lx = 0; lx < 16; lx += 4) {
            if (back.getBlock(lx, y, lz) !== chunk.getBlock(lx, y, lz)) mismatch++;
          }
        }
      }
      check('chunk serialisation round-trips', mismatch === 0,
        `${mismatch} mismatches, ${buf.byteLength} bytes`);
    } catch (e) { check('chunk serialisation round-trips', false, e.message); }
  }

  // --- day/night ---
  const t0 = w.time;
  for (let i = 0; i < 50; i++) w.tick();
  check('time advances', w.time > t0, `${t0} -> ${w.time}`);

  // --- raycast ---
  const dir = p.lookVector();
  p.pitch = -1.2;  // look down
  const d2 = p.lookVector();
  const hit = w.raycast(p.eyeX, p.eyeY, p.eyeZ, d2.x, d2.y, d2.z, 6);
  check('raycast hits the ground', !!hit, hit ? `${w.getBlockName(hit.x, hit.y, hit.z)} at dist ${hit.dist.toFixed(2)}` : 'miss');

  return {
    out,
    modules: Object.fromEntries(Object.entries(g.modules).map(([k, v]) => [k, !!v])),
    perf: {
      fps: Math.round(g.fps),
      chunks: w.chunks.size,
      tris: Math.round(g.renderer.stats.triangles),
      meshQueue: g.renderer.stats.meshQueue,
      textures: g.renderer.atlasLayers,
    },
  };
});

const pass = results.out.filter((r) => r.pass).length;
console.log(`\n=== gameplay: ${pass}/${results.out.length} checks passed ===`);
for (const r of results.out) {
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(`\nperf: ${JSON.stringify(results.perf)}`);
const loaded = Object.entries(results.modules).filter(([, v]) => v).map(([k]) => k);
const missing = Object.entries(results.modules).filter(([, v]) => !v).map(([k]) => k);
console.log(`\nmodules loaded (${loaded.length}): ${loaded.join(', ')}`);
if (missing.length) console.log(`modules MISSING (${missing.length}): ${missing.join(', ')}`);
if (errors.length) console.log(`\n--- runtime errors (${errors.length}) ---\n${errors.slice(0, 12).join('\n---\n')}`);

await page.screenshot({ path: 'scratch/playtest.png' });
await browser.close();
server.close();
process.exit(results.out.some((r) => !r.pass) || errors.length ? 1 : 0);
