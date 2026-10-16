/** Second independent verification pass: export UI, XSS safety, assign-CRS flow, Google basemap path (mocked), auto-zoom, project map. */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.GEODASH_URL ?? 'http://127.0.0.1:8765';
const SAMPLES = join(here, '..', '.testdata', 'samples');
const SHOTS = join(here, '..', '.testdata', 'shots'); mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const j = async (path, init) => { const r = await fetch(BASE + path, init); if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); return r.json(); };
const uploadBuf = async (pid, name, buf) => { const fd = new FormData(); fd.append('file', new Blob([buf]), name); return j(`/api/projects/${pid}/upload`, { method: 'POST', body: fd }); };
const upload = (pid, f) => uploadBuf(pid, f, readFileSync(join(SAMPLES, f)));

const poly = (lon, lat, d) => ({ type: 'Polygon', coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] });
const xssGeo = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: poly(77.5940, 12.9710, 0.002), properties: { name: '<img src=x onerror="window.__xss=1">', val: 1 } }] };

const pid = (await j('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'verify2 ' + Date.now() }) })).id;
const ortho = await upload(pid, 'ortho.tif');
const shp = await upload(pid, 'unreferenced.zip');
const las = await upload(pid, 'local.las');
const xss = await uploadBuf(pid, 'xss.geojson', Buffer.from(JSON.stringify(xssGeo)));

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
await ctx.addInitScript(() => { try { localStorage.setItem('geodash.basemap', 'none'); } catch {} });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));
const shot = (n) => page.screenshot({ path: join(SHOTS, `v2-${n}.png`) });
const analyse = async (buf) => page.evaluate(async (b64) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const t = document.createElement('canvas'); t.width = img.width; t.height = img.height;
  const x = t.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, t.width, t.height).data; let coloured = 0;
  for (let i = 0; i < d.length; i += 4) { if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 40) coloured++; }
  return coloured;
}, buf.toString('base64'));
const openGeoref = async () => {
  await page.waitForSelector('.side-tabs');
  if (!(await page.getByRole('button', { name: 'Assign CRS' }).count())) await page.getByRole('tab', { name: 'Georeference' }).click();
  await page.getByRole('button', { name: 'Assign CRS' }).waitFor();
};
const openExport = async () => { await page.getByRole('tab', { name: 'Export' }).click(); await page.waitForSelector('.export-target'); };
const runExport = async (label) => {
  await page.locator('.export-target', { hasText: label }).first().click();
  const lossy = page.getByLabel('I understand this conversion is lossy');
  if (await lossy.count()) await lossy.check();
  await page.getByRole('button', { name: 'Start export' }).click();
  await page.waitForSelector('[data-overall]', { timeout: 120000 });
  return { overall: await page.locator('[data-overall]').getAttribute('data-overall'), text: await page.locator('[data-overall]').innerText() };
};

// ── export UI: raster GeoTIFF must read "Validated"
await page.goto(`${BASE}/#/dataset/${ortho.id}`);
await openExport();
let r = await runExport('GeoTIFF');
check('raster GeoTIFF export shows PASS headline', r.overall === 'PASS' && /Validated: all \d+ checks passed/.test(r.text), r.text);
check('download link appears for a validated export', (await page.locator('a[href*="/api/jobs/"]').count()) === 1);
await shot('1-export-pass');

// ── rotating the raster makes COG unavailable and the UI notices (targets refetch on georef change)
await j(`/api/datasets/${ortho.id}/georef`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'place', anchor: { lon: 77.5946, lat: 12.9716 }, rotation_deg: 15 }) });
await page.goto(`${BASE}/#/library`); await page.goto(`${BASE}/#/dataset/${ortho.id}`);
await openExport();
const cog = page.locator('.export-target', { hasText: 'Cloud-Optimized' });
check('rotated raster: COG is disabled with a reason', (await cog.getAttribute('aria-disabled')) === 'true' && /north-up/.test(await cog.innerText()));

// ── assign a CRS to the unreferenced shapefile through the UI, then see it on the map
await page.goto(`${BASE}/#/dataset/${shp.id}`);
await openGeoref();
await page.getByLabel('Search CRS').fill('32643');
await page.locator('.crs-list-item', { hasText: 'EPSG:32643' }).first().click();
await page.getByRole('button', { name: 'Preview' }).click();
await page.waitForSelector('.crs-result', { timeout: 10000 });
await page.getByRole('button', { name: 'Save georeferencing' }).click();
await page.waitForTimeout(2500);
const gs = await j(`/api/datasets/${shp.id}`);
check('assign CRS via UI saved', gs.effective_status === 'ready' && gs.georef.crs === 'EPSG:32643', `${gs.effective_status} ${gs.georef.crs}`);
check('badge now reads Ready', (await page.locator('.badge-ready').count()) > 0 && (await page.locator('.badge-unreferenced').count()) === 0);
const vecPx = await analyse(await page.locator('.map-box').screenshot());
check('vector features are drawn after georeferencing', vecPx > 2000, `${vecPx} coloured px`);
await shot('2-vector');
// export a DXF: attributes and CRS cannot be stored, so it must say WARN, never "Validated"
await openExport();
r = await runExport('DXF');
check('DXF export is reported as WARN (limitations stated), not validated', r.overall === 'WARN' && /warnings/.test(r.text), r.text);
await shot('3-export-warn');

// ── XSS: attribute values with HTML must be shown as text
await page.goto(`${BASE}/#/dataset/${xss.id}`);
await page.waitForSelector('.maplibregl-canvas'); await page.waitForTimeout(2500);
const cb = await page.locator('.maplibregl-canvas').boundingBox();
await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
await page.waitForSelector('.maplibregl-popup', { timeout: 8000 });
const popupText = await page.locator('.maplibregl-popup').innerText();
check('popup shows the attribute text literally', popupText.includes('<img'), popupText.replace(/\n/g, ' ').slice(0, 60));
check('HTML in attribute values is not executed', (await page.evaluate(() => window.__xss)) === undefined && (await page.locator('.maplibregl-popup img').count()) === 0);
await shot('4-popup');

// ── placing a dataset with no location: the footprint must become visible (auto-zoom) after the first click
await page.goto(`${BASE}/#/dataset/${las.id}`);
await openGeoref();
await page.getByRole('button', { name: 'Place on map' }).click();
await page.getByRole('button', { name: 'Enlarge map' }).click();
const big = page.locator('.map-box.fullscreen'); const bb = await big.locator('.maplibregl-canvas').boundingBox();
const before = await analyse(await big.screenshot());
await page.mouse.click(bb.x + bb.width * 0.5, bb.y + bb.height * 0.5);
await page.waitForTimeout(2000);
const after = await analyse(await big.screenshot());
check('footprint becomes visible after the first click (auto-zoom)', after > before + 3000, `${before} -> ${after} coloured px`);
// the go-to box places the centre at typed coordinates
await big.getByLabel('Go to latitude and longitude').fill('12.9716, 77.5946');
await big.getByRole('button', { name: 'Set centre' }).click();
await page.waitForTimeout(1200);
check('go-to sets the anchor to the typed position', /77\.594600, 12\.971600|77\.5946, 12\.9716/.test(await big.locator('.place-big-header').innerText()), (await big.locator('.place-big-header').innerText()).split('\n').pop());
await shot('5-place-goto');
await page.keyboard.press('Escape');

// ── project map
await page.goto(`${BASE}/#/project/${pid}/map`);
await page.waitForSelector('.layer-item'); await page.waitForTimeout(3500);
check('project map lists every dataset', (await page.locator('.layer-item').count()) === 4, String(await page.locator('.layer-item').count()));
const pmPx = await analyse(await page.locator('.map-box').screenshot());
check('project map draws the georeferenced layers', pmPx > 2000, `${pmPx} coloured px`);
await shot('6-project-map');
// reorder control really reorders: moving the first layer down changes which item is first
const firstName = await page.locator('.layer-item-name').first().innerText();
await page.getByRole('button', { name: 'Move down' }).first().click();
check('move down changes the layer order', (await page.locator('.layer-item-name').first().innerText()) !== firstName);

// ── Google basemap code path with the server endpoints mocked (no API key here: real Google tiles are NOT tested)
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
let gHits = 0, sessionFail = false;
await ctx2.route('**/api/config', (route) => route.fulfill({ json: { google_maps: true, max_upload_gb: 20 } }));
await ctx2.route('**/api/google/session*', (route) => sessionFail
  ? route.fulfill({ status: 502, json: { detail: 'Google Maps rejected the request: API key not valid.' } })
  : route.fulfill({ json: { tiles: `${BASE}/api/_mock_google/{z}/{x}/{y}.png`, attribution: 'Map data © Google (mock)', expiry: 'x' } }));
await ctx2.route('**/api/_mock_google/**', (route) => { gHits++; route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') }); });
const p2 = await ctx2.newPage();
await p2.goto(`${BASE}/#/dataset/${ortho.id}`);
await p2.waitForSelector('select[aria-label="Basemap"]'); await p2.waitForTimeout(1500);
const enabled = await p2.locator('select[aria-label="Basemap"] option').evaluateAll((o) => o.filter((x) => x.value.startsWith('google')).map((x) => !x.disabled));
check('with a key configured the Google options are enabled', enabled.length === 4 && enabled.every(Boolean));
await p2.selectOption('select[aria-label="Basemap"]', 'google-satellite');
await p2.waitForTimeout(2500);
check('selecting Google requests its session and loads its tiles', gHits > 0, `${gHits} tile requests`);
check('Google attribution is shown', (await p2.locator('.maplibregl-ctrl-attrib').innerText()).includes('Google'));
sessionFail = true;
await ctx2.unroute('**/api/google/session*'); await ctx2.route('**/api/google/session*', (route) => route.fulfill({ status: 502, json: { detail: 'Google Maps rejected the request: API key not valid.' } }));
await p2.selectOption('select[aria-label="Basemap"]', 'google-hybrid');
await p2.waitForTimeout(1500);
check('a Google failure is shown to the user and falls back to OpenStreetMap', (await p2.locator('.toast-error', { hasText: 'API key not valid' }).count()) > 0 && (await p2.locator('select[aria-label="Basemap"]').inputValue()) === 'osm');
await ctx2.close();

check('no console errors during the whole run', errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
