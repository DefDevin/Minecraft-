// Boot the game in a phone-sized touch context and drive the touch controls.
import { chromium, devices } from '/opt/node22/lib/node_modules/playwright/index.mjs';
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

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ ...devices['Pixel 7'] });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/404 \(Not Found\)/.test(m.text())) errs.push(m.text());
});

await page.goto(`http://127.0.0.1:${port}/?seed=mobile`, { waitUntil: 'load' });
await page.waitForFunction(() => window.game?.running, { timeout: 240000 });
await page.waitForTimeout(12000);

const out = [];
const check = async (name, fn) => {
  try { const [ok, detail] = await fn(); out.push([ok, name, detail ?? '']); }
  catch (e) { out.push([false, name, e.message]); }
};

await check('touch mode detected', async () =>
  [await page.evaluate(() => window.game.touchMode), '']);
await check('touch overlay is visible', async () =>
  [await page.evaluate(() => {
    const el = document.getElementById('touch-controls');
    return !!el && getComputedStyle(el).display !== 'none';
  }), '']);
await check('settings dropped for mobile', async () => {
  const s = await page.evaluate(() => window.game.settings);
  return [s.renderDistance <= 5 && s.renderScale < 1,
    `rd=${s.renderDistance} scale=${s.renderScale}`];
});

// Drag the virtual stick and confirm the player walks.
await check('virtual stick moves the player', async () => {
  const before = await page.evaluate(() => [window.game.player.x, window.game.player.z]);
  const box = await page.evaluate(() => {
    const r = document.getElementById('touch-controls').firstChild.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height * 0.7 };
  });
  await page.touchscreen.tap(box.x, box.y);   // wake the zone
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x, box.y - 70, { steps: 5 });
  await page.waitForTimeout(1500);
  await page.mouse.up();
  const after = await page.evaluate(() => [window.game.player.x, window.game.player.z]);
  const d = Math.hypot(after[0] - before[0], after[1] - before[1]);
  return [d > 0.5, `moved ${d.toFixed(2)} blocks`];
});

// Drag the look zone and confirm the camera turns.
await check('look drag turns the camera', async () => {
  const yaw0 = await page.evaluate(() => window.game.player.yaw);
  const vp = page.viewportSize();
  const x = vp.width * 0.75, y = vp.height * 0.45;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 120, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const yaw1 = await page.evaluate(() => window.game.player.yaw);
  return [Math.abs(yaw1 - yaw0) > 0.05, `yaw ${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)}`];
});

// Jump button.
await check('jump button works', async () => {
  const r = await page.evaluate(async () => {
    const btns = [...document.querySelectorAll('#touch-controls div')]
      .filter((d) => d.textContent === '▲');
    if (!btns.length) return { ok: false, why: 'no jump button' };
    const b = btns[0].getBoundingClientRect();
    const p = window.game.player;
    p.y = Math.round(p.y);
    const before = p.y;
    btns[0].dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 1, clientX: b.x + 10, clientY: b.y + 10 }));
    await new Promise((res) => setTimeout(res, 400));
    btns[0].dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    return { ok: window.game.player.y > before, y: window.game.player.y - before };
  });
  return [r.ok, r.why ?? `dy=${(r.y ?? 0).toFixed(2)}`];
});

await page.screenshot({ path: 'scratch/mobile.png' });
const info = await page.evaluate(() => ({
  fps: Math.round(window.game.fps), chunks: window.game.world.chunks.size,
  tris: Math.round(window.game.renderer.stats.triangles),
}));

console.log(`\n=== mobile: ${out.filter((o) => o[0]).length}/${out.length} ===`);
for (const [ok, name, d] of out) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${d ? `  (${d})` : ''}`);
console.log('perf:', JSON.stringify(info));
if (errs.length) console.log('errors:', errs.slice(0, 4).join(' | '));
await browser.close();
server.close();
process.exit(out.some((o) => !o[0]) ? 1 : 0);
