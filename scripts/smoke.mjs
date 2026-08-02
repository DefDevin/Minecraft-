// Headless browser smoke test: boots the game in Chromium, waits for the world
// to generate, captures a screenshot, and reports console errors and stats.
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
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl',
         '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [], warns = [], logs = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') { if (!/404 \(Not Found\)/.test(t)) errors.push(t); }
  else if (m.type() === 'warning') warns.push(t);
  else logs.push(t);
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}\n${e.stack ?? ''}`));

const seed = process.argv[2] ?? '12345';
const mode = process.argv[3] ?? 'survival';
await page.goto(`http://127.0.0.1:${port}/?seed=${seed}&mode=${mode}`, { waitUntil: 'load' });

// Wait for boot, then let the world stream in.
let ready = false;
try {
  await page.waitForFunction(() => window.game && window.game.running, { timeout: 120000 });
  ready = true;
} catch { /* report below */ }

if (ready) await page.waitForTimeout(Number(process.argv[4] ?? 9000));

const status = await page.evaluate(() => {
  const boot = document.getElementById('boot-step')?.textContent;
  const err = document.getElementById('boot-err')?.textContent;
  const g = window.game;
  if (!g) return { boot, err, ready: false };
  const p = g.player;
  return {
    boot, err, ready: true,
    fps: Math.round(g.fps),
    pos: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)],
    onGround: p.onGround,
    chunks: g.world.chunks.size,
    entities: g.world.entities.length,
    sections: g.renderer.stats.sections,
    drawn: g.renderer.stats.drawnSections,
    tris: Math.round(g.renderer.stats.triangles),
    drawCalls: g.renderer.stats.drawCalls,
    meshQueue: g.renderer.stats.meshQueue,
    blocks: g.world.getBlockName(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)),
    biome: g.world.getSurfaceBiomeAt(Math.floor(p.x), Math.floor(p.z)),
    time: g.world.time,
    textures: g.renderer.atlasLayers,
    maxTextureLayers: g.renderer.maxTextureLayers,
    tickMs: +g.tickTime.toFixed(2),
  };
});

await page.screenshot({ path: process.argv[5] ?? 'scratch/smoke.png' });
console.log(JSON.stringify(status, null, 2));
if (warns.length) console.log('\n--- warnings (%d) ---\n%s', warns.length, warns.slice(0, 25).join('\n'));
if (errors.length) console.log('\n--- ERRORS (%d) ---\n%s', errors.length, errors.slice(0, 25).join('\n'));
const info = logs.filter((l) => l.startsWith('[')).slice(0, 20);
if (info.length) console.log('\n--- info ---\n%s', info.join('\n'));

await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
