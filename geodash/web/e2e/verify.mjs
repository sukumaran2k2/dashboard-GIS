/** Independent verification of the interactive features. Run with a test backend on :8765 (set GEODASH_URL to override); never point it at a server holding real data. */
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.GEODASH_URL ?? 'http://127.0.0.1:8765';
const SAMPLES = join(here, '..', '.testdata', 'samples');
const SHOTS = join(here, '..', '.testdata', 'shots'); mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };

const j = async (path, init) => { const r = await fetch(BASE + path, init); if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); return r.json(); };
const upload = async (pid, file) => { const fd = new FormData(); fd.append('file', new Blob([readFileSync(join(SAMPLES, file))]), file); return j(`/api/projects/${pid}/upload`, { method: 'POST', body: fd }); };
const pid = (await j('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'verify ' + Date.now() }) })).id;
const ortho = await upload(pid, 'ortho.tif');
const las = await upload(pid, 'local.las');
const png = await upload(pid, 'noref.png');

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
await ctx.addInitScript(() => { try { localStorage.setItem('geodash.basemap', 'none'); } catch {} });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message.slice(0, 200)));
const shot = (n) => page.screenshot({ path: join(SHOTS, `v-${n}.png`) });
// open the Georeference panel only if it is not already open (it opens by default for unreferenced data)
const openGeoref = async () => {
  await page.waitForSelector('.side-tabs');
  const mode = page.getByRole('button', { name: 'Assign CRS' });
  if (!(await mode.count())) await page.getByRole('tab', { name: 'Georeference' }).click();
  await page.getByRole('button', { name: 'Assign CRS' }).waitFor();
};
// analyse a real screenshot (WebGL canvases cannot be read back) for coloured pixels and their bounding box
const analyse = async (buf) => page.evaluate(async (b64) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const t = document.createElement('canvas'); t.width = img.width; t.height = img.height;
  const x = t.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, t.width, t.height).data;
  let coloured = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
  for (let i = 0; i < d.length; i += 4) {
    const sat = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    if (sat > 110) { const p = i / 4, X = p % t.width, Y = (p / t.width) | 0; coloured++; if (X < minX) minX = X; if (X > maxX) maxX = X; if (Y < minY) minY = Y; if (Y > maxY) maxY = Y; }
  }
  return { coloured, w: maxX - minX + 1, h: maxY - minY + 1, cw: t.width, ch: t.height };
}, buf.toString('base64'));

// ── 1. raster viewer shows the raster, filling the expected footprint (None basemap so only our tiles are drawn)
await page.goto(`${BASE}/#/dataset/${ortho.id}`);
await page.waitForSelector('.maplibregl-canvas');
await page.waitForTimeout(2500);
await shot('1-raster');
const px = await analyse(await page.locator('.map-box').screenshot());
check('raster is drawn on the map', px.coloured > 5000, `${px.coloured} coloured px`);
check('raster footprint has the right shape (4:3)', px.coloured > 5000 && Math.abs(px.w / px.h - 4 / 3) < 0.08, `${px.w} x ${px.h} => ${(px.w / px.h).toFixed(2)}`);
check('raster fills the view after load (fit to bounds)', px.w > px.cw * 0.4, `width ${px.w} of ${px.cw}`);
check('basemap selector present', (await page.locator('select[aria-label="Basemap"]').count()) === 1);
const opts = await page.locator('select[aria-label="Basemap"] option').evaluateAll((o) => o.map((x) => ({ v: x.value, d: x.disabled })));
check('Google options listed but disabled without a key', opts.filter((o) => o.v.startsWith('google')).length === 4 && opts.filter((o) => o.v.startsWith('google')).every((o) => o.d));

// ── 2. 3D: top-down orthographic toggle really switches the camera
await page.goto(`${BASE}/#/dataset/${las.id}`);
await page.waitForSelector('.viewer3d-hud');
await page.waitForTimeout(2500);
const snap = () => page.locator('.viewer3d-hud').locator('xpath=..').screenshot();
const a = await snap();
await page.getByLabel('Top-down (orthographic)').check();
await page.waitForTimeout(800);
const b = await snap();
await shot('2-ortho');
check('top-down toggle changes the rendered view', Buffer.compare(a, b) !== 0);
check('scale bar and north arrow appear in top-down view', (await page.locator('.scale-bar-line').count()) === 1 && (await page.locator('.north-arrow').count()) === 1);
const label = await page.locator('.scale-bar-line').getAttribute('data-label');
check('scale bar has a length label', /\d/.test(label ?? ''), String(label));

// ── 3. place the unreferenced cloud on the map by click + drag, then save and verify what the server stored
await page.goto(`${BASE}/#/dataset/${las.id}`);
await openGeoref();
await page.getByRole('button', { name: 'Place on map' }).click();
await page.waitForSelector('.map-box .maplibregl-canvas');
await page.getByRole('button', { name: 'Enlarge map' }).click();
await page.waitForTimeout(500);
const big = page.locator('.map-box.fullscreen');
const bb = await big.locator('.maplibregl-canvas').boundingBox();
// the unreferenced dataset has no location: world view. Zoom to Bengaluru by typing the anchor in the panel is hidden, so click map first.
await page.mouse.click(bb.x + bb.width * 0.5, bb.y + bb.height * 0.5);
await page.waitForSelector('[title="Drag to move"]');
await page.waitForTimeout(1200);
await shot('3a-placed-click');
const readout = await big.locator('.place-big-header').innerText();
check('clicking the map sets an anchor', /\d+\.\d+, -?\d+\.\d+/.test(readout), readout.split('\n').slice(-2).join(' '));
const rotH = page.locator('[title="Drag to rotate"]');
const cenH = page.locator('[title="Drag to move"]');
check('rotate handle sits away from the centre', (await rotH.boundingBox()).y < (await cenH.boundingBox()).y - 10);

// rotate by dragging the handle a quarter turn clockwise around the centre (screen space)
const c0 = await cenH.boundingBox(), r0 = await rotH.boundingBox();
const cx = c0.x + c0.width / 2, cy = c0.y + c0.height / 2;
const rx = r0.x + r0.width / 2, ry = r0.y + r0.height / 2;
const radius = Math.hypot(rx - cx, ry - cy);
await page.mouse.move(rx, ry); await page.mouse.down();
for (let k = 1; k <= 12; k++) { const ang = Math.atan2(rx - cx, -(ry - cy)) + (Math.PI / 2) * (k / 12); await page.mouse.move(cx + radius * Math.sin(ang), cy - radius * Math.cos(ang)); }
await page.mouse.up();
await page.waitForTimeout(900);
const rotVal = parseFloat(await big.getByLabel('Rotation in degrees').inputValue());
check('dragging the handle clockwise by 90 degrees gives about -90 (counter-clockwise positive)', Math.abs(rotVal + 90) < 3, `rotation field = ${rotVal}`);
await shot('3b-rotated');

// move the centre by dragging it
const c1 = await cenH.boundingBox();
await page.mouse.move(c1.x + c1.width / 2, c1.y + c1.height / 2); await page.mouse.down();
await page.mouse.move(c1.x + 120, c1.y + 60, { steps: 10 }); await page.mouse.up();
await page.waitForTimeout(900);
const rotAfterMove = parseFloat(await big.getByLabel('Rotation in degrees').inputValue());
check('moving the centre keeps the rotation (no stale-state reset)', Math.abs(rotAfterMove - rotVal) < 0.2, `${rotVal} -> ${rotAfterMove}`);
const readout2 = (await big.locator('.place-big-header').innerText());
const m2 = readout2.match(/(-?\d+\.\d+), (-?\d+\.\d+)/);
const finalLon = parseFloat(m2[1]), finalLat = parseFloat(m2[2]);
await shot('3c-moved');
await big.getByRole('button', { name: 'Done' }).click();
await page.getByRole('button', { name: 'Save georeferencing' }).click();
await page.waitForTimeout(1500);

const g = await j(`/api/datasets/${las.id}/georef`);
check('server stored a placement', g.status === 'ready' && g.method === 'placed', `${g.status}/${g.method}`);
const [sl, sa] = g.effective.center_wgs84;
check('stored anchor equals the final dragged position', Math.abs(sl - finalLon) < 2e-6 && Math.abs(sa - finalLat) < 2e-6, `${sl.toFixed(7)},${sa.toFixed(7)} vs ${finalLon},${finalLat}`);
check('stored rotation equals the field value', Math.abs(g.effective.rotation_deg - rotAfterMove) < 0.05, `${g.effective.rotation_deg.toFixed(3)} vs ${rotAfterMove}`);
check('server round-trip verification passed', g.override.verification.passed === true);

// reload: the panel must come back showing the saved placement, not blank values
await page.reload();
await openGeoref();
await page.getByRole('button', { name: 'Place on map' }).click();
await page.waitForTimeout(800);
const lonField = parseFloat(await page.locator('#a-lon').inputValue()), rotField = parseFloat(await page.locator('#p-rot').inputValue());
check('after reload the panel is prefilled with the saved anchor', Math.abs(lonField - sl) < 1e-6, String(lonField));
check('after reload the panel is prefilled with the saved rotation', Math.abs(rotField - rotAfterMove) < 0.05, String(rotField));
await shot('3d-reloaded');

// ── 4. control points on an image with no ground coordinates
await page.goto(`${BASE}/#/dataset/${png.id}`);
await openGeoref();
await page.getByRole('button', { name: 'Control points' }).click();
await page.getByRole('button', { name: 'Open control-point editor' }).click();
await page.waitForSelector('.gcp-workspace');
await page.waitForTimeout(1000);
const img = await page.locator('.gcp-image canvas').boundingBox();
// the image is letter-boxed inside the pane: click inside the picture itself (120 x 80 px source, fitted at 96 %)
const fitS = Math.min(img.width / 120, img.height / 80) * 0.96;
const imgBox = { x: img.x + (img.width - 120 * fitS) / 2, y: img.y + (img.height - 80 * fitS) / 2, w: 120 * fitS, h: 80 * fitS };
for (const [fx, fy] of [[0.12, 0.15], [0.88, 0.2], [0.85, 0.85], [0.15, 0.8]]) { await page.mouse.click(imgBox.x + imgBox.w * fx, imgBox.y + imgBox.h * fy); await page.waitForTimeout(120); }
check('four image clicks add four control points', (await page.locator('.gcp-table tbody tr').count()) === 4);
check('new points have NO ground position (not faked as 0,0)', (await page.locator('.gcp-table tbody tr').first().locator('input').first().inputValue()) === '');
check('fit is disabled until points have ground positions', await page.getByRole('button', { name: /Check fit/ }).isDisabled());
// type ground coordinates (UTM 43N) for a 0.25 m/px image 120x80 px: corners are ~ (cols*0.25, rows*0.25) apart
await page.locator('.gcp-workspace input[aria-label="Ground CRS"]').fill('EPSG:32643');
const E0 = 777000, N0 = 1435000;
const pts = await page.evaluate(() => 0);
const rows = page.locator('.gcp-table tbody tr');
const meta = png.meta;
for (let i = 0; i < 4; i++) {
  const colTxt = parseFloat(await rows.nth(i).locator('td').nth(1).innerText());
  const rowTxt = parseFloat(await rows.nth(i).locator('td').nth(2).innerText());
  await rows.nth(i).getByLabel(`Point ${i + 1} ground X`).fill(String(E0 + colTxt * 0.25));
  await rows.nth(i).getByLabel(`Point ${i + 1} ground Y`).fill(String(N0 - rowTxt * 0.25));
}
await page.getByRole('button', { name: /Check fit/ }).click();
await page.waitForTimeout(800);
const rm = await page.locator('.place-big-header').innerText();
check('fit reports an RMSE close to zero for consistent points', /RMSE 0\.000 m/.test(rm), rm.match(/RMSE [\d.]+ m/)?.[0]);
await shot('4-gcp');
await page.locator('.gcp-workspace').getByRole('button', { name: 'Save georeferencing' }).click();
await page.waitForTimeout(1500);
const gp = await j(`/api/datasets/${png.id}/georef`);
check('control-point georeference saved', gp.status === 'ready' && gp.method === 'gcp', `${gp.status}/${gp.method}`);
check('stored transform recovers 0.25 m pixels', Math.abs(gp.override.gcp.pixel_size[0] - 0.25) < 1e-6, JSON.stringify(gp.override.gcp.pixel_size));

check('no console errors during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
