// Position the camera somewhere interesting and screenshot the world.
// Usage: node scripts/shot.mjs <seed> <height> <pitch> <out.png> [waitMs]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const body = await readFile(join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, '')));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const [seed = '1', height = '25', pitch = '-0.45', out = 'scratch/shot.png',
  wait = '20000'] = process.argv.slice(2);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(`${e.message}\n${(e.stack||'').split('\n').slice(1,5).join('\n')}`));
await page.goto(`http://127.0.0.1:${port}/?seed=${seed}&mode=creative`, { waitUntil: 'load' });
await page.waitForFunction(() => window.game?.running, { timeout: 180000 });

// Lift the camera clear of the ground and aim it across the landscape.
await page.evaluate(([h, p]) => {
  const g = window.game, pl = g.player;
  pl.gamemode = 1; pl.canFly = true; pl.flying = true;
  const surface = g.world.surfaceAt(Math.floor(pl.x), Math.floor(pl.z));
  pl.y = Math.max(surface, 63) + Number(h);
  pl.prevY = pl.y;
  pl.pitch = Number(p);
  pl.yaw = 0.7;
  pl.updateBounds();
  g.settings.renderDistance = 12;
}, [height, pitch]);

if (process.env.MOBS) {
  await page.evaluate(async (list) => {
    const g = window.game, p = g.player;
    const M = g.modules.mobs;
    const names = list.split(',');
    names.forEach((n, i) => {
      const a = (i / names.length) * Math.PI * 2;
      const x = p.x + Math.cos(a) * 6, z = p.z + Math.sin(a) * 6;
      const y = g.world.standingYAt(Math.floor(x), Math.floor(z), Math.floor(p.y) + 8);
      if (y != null) M.spawn(g.world, n, x, y, z, { persistent: true });
    });
  }, process.env.MOBS);
}

await page.waitForTimeout(Number(wait));
// Hide the HUD so the shot is just the world.
await page.evaluate(() => { document.getElementById('gui').style.display = 'none'; });
await page.waitForTimeout(400);
const info = await page.evaluate(() => {
  const g = window.game, p = g.player;
  const b = g.modules.biomes?.biomeById?.[g.world.getSurfaceBiomeAt(
    Math.floor(p.x), Math.floor(p.z))];
  return {
    pos: [Math.round(p.x), Math.round(p.y), Math.round(p.z)],
    biome: b?.name, chunks: g.world.chunks.size,
    tris: Math.round(g.renderer.stats.triangles), meshQueue: g.renderer.stats.meshQueue,
    entities: g.world.entities.length, fps: Math.round(g.fps),
    byType: Object.entries(g.world.entities.reduce((a, e) => {
      const k = e.renderKind ?? e.type ?? 'other'; a[k] = (a[k] ?? 0) + 1; return a;
    }, {})).sort((a, b) => b[1] - a[1]).slice(0, 6),
  };
});
await page.screenshot({ path: out });
console.log(JSON.stringify(info));
if (errs.length) console.log('errors:', errs.slice(0, 5).join(' | '));
await browser.close();
server.close();
