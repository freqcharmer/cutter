// FantastiCut headless tests (Playwright + Chrome).
//
//   python3 -m http.server 8123        (in the repo root, in another terminal)
//   node tests/run.mjs [http://localhost:8123/] [path/to/playwright]
//
// Screenshots go to tests/out/. Exits with code 1 if any check fails.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const URL_ = process.argv[2] || 'http://localhost:8123/';
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[3] || process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright');
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

// Test files
const twoColorSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="4in" height="3in" viewBox="0 0 4 3">
  <rect x="0" y="0" width="2" height="2" fill="#ff0000"/><rect x="1.5" y="1" width="2" height="2" fill="#0000ff"/></svg>`;
const bigSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20in" height="40in" viewBox="0 0 20 40">
  <rect x="0" y="0" width="20" height="40" fill="#000"/><circle cx="10" cy="20" r="6" fill="#fff"/></svg>`;
writeFileSync(join(out, 'two-color.svg'), twoColorSVG);
writeFileSync(join(out, 'big.svg'), bigSVG);

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
// Failed requests to this app are errors; outside hosts (Google Fonts) may be blocked in a test sandbox.
page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(URL_)) errors.push(`${r.status()} ${r.url()}`); });
page.on('requestfailed', (r) => { if (!r.url().startsWith(URL_)) console.log(`note: outside request failed (ignored): ${r.url()}`); });

await page.goto(URL_);
await page.evaluate(async () => { localStorage.clear(); indexedDB.deleteDatabase('fantasticut'); });
await page.reload();
await page.waitForFunction(() => window.fc);
const fc = (fn, arg) => page.evaluate(fn, arg);
const count = () => fc(() => fc.doc.objects.length);
const shot = (n) => page.screenshot({ path: join(out, n + '.png') });

// ---------- text welds by default ----------
await page.click('#btn-text');
await page.waitForFunction(() => fc.doc.objects.length === 1);
await page.fill('#t-text', 'll');
await page.selectOption('#t-font', 'bundled:pacifico');
await page.waitForTimeout(500);
const welded = await fc(() => ({ weld: fc.doc.objects[0].text.weld, n: fc.doc.objects[0].paths.length, box: document.getElementById('t-weld').checked }));
await page.click('#t-weld');
await page.waitForTimeout(500);
const loose = await fc(() => fc.doc.objects[0].paths.length);
check('text welds letters by default', welded.weld === true && welded.box, JSON.stringify(welded));
check('unticking Weld letters separates script letters', loose > welded.n, `${welded.n} → ${loose} paths`);
await page.click('#t-weld');
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.click('#canvas', { position: { x: 700, y: 700 } });
await fc(() => { fc.doc.objects = []; fc.doc.commit('clear'); });

// ---------- import splits colors into layers ----------
await page.setInputFiles('#file-import', join(out, 'two-color.svg'));
await page.waitForFunction(() => fc.doc.objects.length === 2);
const colors = await fc(() => fc.doc.objects.map((o) => o.color));
check('two-color SVG imports as two color layers', colors.includes('#ff0000') && colors.includes('#0000ff'), colors.join(','));
const layerRows = await page.locator('#clayers li').count();
check('color layers panel lists both colors', layerRows === 2);

// ---------- weld and unweld ----------
const before = await fc(() => fc.doc.objects.map((o) => ({ id: o.id, x: o.x, y: o.y })));
await fc(() => fc.doc.select(fc.doc.objects.map((o) => o.id)));
await page.keyboard.press('Control+g');
await page.waitForTimeout(150);
const w = await fc(() => ({ n: fc.doc.objects.length, paths: fc.doc.objects[0].paths.length, weld: !!fc.doc.objects[0].weld }));
check('Ctrl+G welds two overlapping squares into one outline', w.n === 1 && w.paths === 1 && w.weld, JSON.stringify(w));
await fc(() => { const o = fc.doc.objects[0]; o.x += 1; fc.doc.commit('Move'); });
await page.keyboard.press('Control+Shift+g');
await page.waitForTimeout(150);
const after = await fc(() => fc.doc.objects.map((o) => ({ id: o.id, x: o.x, y: o.y })));
const moved = before.every((b) => after.some((a) => a.id === b.id && Math.abs(a.x - b.x - 1) < 1e-6 && Math.abs(a.y - b.y) < 1e-6));
check('Unweld restores the pieces (and keeps a move made after welding)', after.length === 2 && moved);

// ---------- right-click menu ----------
const sp = await fc(() => fc.view.toScreen([fc.doc.objects[0].x, fc.doc.objects[0].y]));
const cr = await page.locator('#canvas').boundingBox();
await page.mouse.click(cr.x + sp[0], cr.y + sp[1], { button: 'right' });
await page.waitForTimeout(150);
const menu = await fc(() => ({ open: !document.getElementById('ctx').hidden, items: [...document.querySelectorAll('#ctx button')].map((b) => b.textContent) }));
check('right-click opens the menu with Weld and Unweld', menu.open && menu.items.some((t) => t.startsWith('Weld')) && menu.items.some((t) => t.startsWith('Unweld')), menu.items.slice(0, 4).join(' | '));
await shot('01-context-menu');
await page.keyboard.press('Escape');
check('Escape closes the menu', await fc(() => document.getElementById('ctx').hidden));
// Right-drag still pans
const ox0 = await fc(() => fc.view.ox);
await page.mouse.move(cr.x + 900, cr.y + 600); await page.mouse.down({ button: 'right' });
await page.mouse.move(cr.x + 980, cr.y + 640, { steps: 5 }); await page.mouse.up({ button: 'right' });
check('right-drag still pans without opening the menu', (await fc(() => fc.view.ox)) - ox0 > 50 && await fc(() => document.getElementById('ctx').hidden));

// ---------- linked offset ----------
await fc(() => fc.doc.select([fc.doc.objects[0].id]));
await page.click('#b-offset');
const of = await fc(() => { const o = fc.doc.objects.find((x) => x.kind === 'offset'); return { ok: !!o, idx: fc.doc.objects.indexOf(o), linked: o?.offset.linked, panel: !document.getElementById('p-offset').hidden }; });
check('Offset adds a linked border behind the original', of.ok && of.idx === 0 && of.linked && of.panel, JSON.stringify(of));
const bw = async () => fc(() => { const o = fc.doc.objects.find((x) => x.kind === 'offset'); const ps = o.paths; let x0 = 1e9, x1 = -1e9; for (const p of ps) for (const [x] of p.pts) { x0 = Math.min(x0, x * o.sx); x1 = Math.max(x1, x * o.sx); } return x1 - x0; });
const w1 = await bw();
await page.fill('#of-dist', '0.5'); await page.press('#of-dist', 'Enter');
await page.waitForTimeout(100);
const w2 = await bw();
check('changing the offset distance regrows the border', Math.abs(w2 - w1 - 0.75) < 0.01, `${w1.toFixed(3)} → ${w2.toFixed(3)}`);
await page.selectOption('#of-join', 'sharp'); await page.waitForTimeout(100);
const sharpPts = await fc(() => fc.doc.objects.find((x) => x.kind === 'offset').paths[0].pts.length);
check('sharp corners give a 4-corner border around a square', sharpPts === 4, String(sharpPts));
// move the original: the border follows
const src = await fc(() => fc.doc.objects.find((x) => x.kind === 'offset').offset.src[0]);
const ox = await fc((id) => { const s = fc.doc.get(id); s.x += 2; s.sx *= 1.5; s.sy *= 1.5; fc.doc.commit('Resize'); const o = fc.doc.objects.find((x) => x.kind === 'offset'); return { x: o.x, sx: s.x, linked: o.offset?.linked }; }, src);
check('the border follows when the original moves and grows', Math.abs(ox.x - ox.sx) < 1e-6 && ox.linked, JSON.stringify(ox));
// drag the original with the mouse: border moves live
const s2 = await fc((id) => fc.view.toScreen([fc.doc.get(id).x, fc.doc.get(id).y]), src);
await fc((id) => fc.doc.select([id]), src);
await page.mouse.move(cr.x + s2[0], cr.y + s2[1]); await page.mouse.down();
await page.mouse.move(cr.x + s2[0] + 60, cr.y + s2[1] + 10, { steps: 6 });
const live = await fc((id) => { const o = fc.doc.objects.find((x) => x.kind === 'offset'); return Math.abs(o.x - fc.doc.get(id).x) < 1e-6; }, src);
await page.mouse.up();
check('the border moves live while dragging the original', live);
// move the border alone: it unlinks
await fc(() => { const o = fc.doc.objects.find((x) => x.kind === 'offset'); o.x += 3; fc.doc.commit('Move'); });
check('moving the border on its own unlinks it', await fc(() => !fc.doc.objects.some((x) => x.kind === 'offset')));
await page.keyboard.press('Control+z');
check('undo links it again', await fc(() => fc.doc.objects.some((x) => x.kind === 'offset' && x.offset.linked)));
await shot('02-offset');

// ---------- step and repeat ----------
await fc(() => { fc.doc.objects = fc.doc.objects.slice(0, 0); fc.doc.commit('clear'); });
await page.setInputFiles('#file-import', join(out, 'two-color.svg'));
await page.waitForFunction(() => fc.doc.objects.length === 2);
await fc(() => fc.doc.select(fc.doc.objects.map((o) => o.id)));
await page.click('#b-repeat');
await page.fill('#r-rows', '2'); await page.fill('#r-cols', '3'); await page.fill('#r-gap', '0.5');
await page.check('#r-weed');
await page.dispatchEvent('#r-cols', 'input');
await shot('03-repeat-dialog');
await page.click('#r-ok');
const rep = await fc(() => ({ n: fc.doc.objects.length, weed: fc.doc.objects.filter((o) => o.name === 'Weed lines').length }));
check('step and repeat makes 2 × 3 copies plus weed lines', rep.n === 13 && rep.weed === 1, JSON.stringify(rep));
await page.click('#zoom-fit');

// ---------- cut window: color layers, weeding ----------
await page.click('#btn-cut');
await page.waitForTimeout(200);
let plan = await fc(() => fc.plan().sheets.map((s) => s.label));
check('one sheet when cutting all colors together', plan.length === 1, plan.join(' | '));
await page.check('#c-bycolor');
await page.waitForTimeout(150);
plan = await fc(() => fc.plan().sheets.map((s) => ({ l: s.label, marks: s.ordered.filter((p) => p.kind === 'mark').length })));
check('One color at a time gives one step per color, each with registration marks', plan.length === 2 && plan.every((p) => p.marks === 8), JSON.stringify(plan));
const label = await page.textContent('#c-send');
check('send button names the step', /step 1 of 2/.test(label), label);
await page.click('summary:has-text("Weeding")');
await page.check('#c-border');
await page.selectOption('#c-wlines', 'both');
await page.waitForTimeout(150);
const weeds = await fc(() => fc.plan().sheets[0].ordered.map((p) => p.kind));
check('weed border and weed lines are added, cut after the design', weeds.includes('weed') && weeds.at(-1) === 'weed' && weeds.indexOf('weed') > weeds.lastIndexOf('design'));
// weed lines never cross the design
const crosses = await fc(() => {
  const sh = fc.plan().sheets[0];
  const design = sh.ordered.filter((p) => p.kind === 'design');
  const lines = sh.ordered.filter((p) => p.kind === 'weed' && !p.closed);
  const segX = (a, b, c, d) => { const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0; };
  let n = 0;
  for (const l of lines) for (let i = 1; i < l.pts.length; i++) for (const d of design) {
    const P = d.closed ? [...d.pts, d.pts[0]] : d.pts;
    for (let j = 1; j < P.length; j++) if (segX(l.pts[i - 1], l.pts[i], P[j - 1], P[j])) n++;
  }
  return { lines: lines.length, n };
});
check('weed lines never cross the design', crosses.lines > 0 && crosses.n === 0, JSON.stringify(crosses));
await shot('04-cut-by-color-weeding');
await page.uncheck('#c-border'); await page.selectOption('#c-wlines', 'none'); await page.uncheck('#c-bycolor');
await page.keyboard.press('Escape');

// ---------- tiling ----------
await fc(() => { fc.doc.objects = []; fc.doc.commit('clear'); });
await page.setInputFiles('#file-import', join(out, 'big.svg'));
await page.waitForFunction(() => fc.doc.objects.length >= 1);
// imports are scaled to fit; scale back up to 40" tall to test tiling
await fc(() => { const sel = fc.doc.objects; const b = sel.map((o) => o); for (const o of b) { o.sx *= 40 / 30.5; o.sy *= 40 / 30.5; } fc.doc.commit('big'); });
await page.click('#btn-cut');
await page.waitForTimeout(200);
const warn = await page.textContent('#c-warn');
check('a design wider than the roll suggests tiling', /Tiling/.test(warn));
await page.click('summary:has-text("Tiling")');
await page.check('#c-tile');
await page.waitForTimeout(200);
const tiles = await fc(() => ({ labels: fc.plan().sheets.map((s) => s.label), fit: fc.plan().sheets.every((s) => s.placed.y1 <= fc.settings().cutWidth + 1e-6), warn: fc.plan().warnings }));
check('tiling cuts it in panels that each fit the roll', tiles.labels.length === 2 && tiles.fit && !tiles.warn.length, JSON.stringify(tiles));
await shot('05-tiling');
await page.keyboard.press('Escape');

// ---------- undo everything, redo everything ----------
const steps = await fc(() => fc.doc.undoStack.length);
for (let i = 0; i < steps; i++) await page.keyboard.press('Control+z');
check('undo all the way back to an empty design', (await count()) === 0);
for (let i = 0; i < steps; i++) await page.keyboard.press('Control+Shift+z');
check('redo all the way forward', (await count()) >= 1);

// ---------- autosave keeps layer names ----------
await fc(() => { fc.doc.layers['#000000'] = { name: 'Matte black' }; fc.doc.commit('Rename layer'); return fc.doc.saveNow(); });
await page.reload();
await page.waitForFunction(() => window.fc && fc.doc.objects.length > 0);
check('autosave restores layer names', await fc(() => fc.doc.layers['#000000']?.name === 'Matte black'));

// ---------- touch long-press opens the menu ----------
const tpage = await browser.newPage({ viewport: { width: 900, height: 700 }, hasTouch: true });
tpage.on('pageerror', (e) => errors.push(e.message));
await tpage.goto(URL_);
await tpage.waitForFunction(() => window.fc);
await tpage.setInputFiles('#file-import', join(out, 'two-color.svg'));
await tpage.waitForFunction(() => fc.doc.objects.length > 0);
await tpage.evaluate(() => fc.doc.clearSelection());
const tsp = await tpage.evaluate(() => fc.view.toScreen([fc.doc.objects[0].x, fc.doc.objects[0].y]));
const tcr = await tpage.locator('#canvas').boundingBox();
const cdp = await tpage.context().newCDPSession(tpage);
const tp = { x: tcr.x + tsp[0], y: tcr.y + tsp[1] };
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp] });
await tpage.waitForTimeout(800);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await tpage.waitForTimeout(100);
check('press and hold (touch) opens the menu', await tpage.evaluate(() => !document.getElementById('ctx').hidden));
await tpage.screenshot({ path: join(out, '06-touch-menu.png') });

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' / '));
await browser.close();
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
