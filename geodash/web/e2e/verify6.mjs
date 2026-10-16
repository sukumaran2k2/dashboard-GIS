/** New features: command palette, theme, quick upload, notes/rename, measure, coordinates, location links, exports card, tabs. */
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.GEODASH_URL ?? 'http://127.0.0.1:8765';
const S = join(here, '..', '.testdata', 'samples');
const SHOTS = join(here, '..', '.testdata', 'shots'); mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  - ' + d : ''}`); };
const j = async (p, i) => { const r = await fetch(BASE + p, i); if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`); return r.json(); };
const mk = async (name) => (await j('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).id;
const up = async (pid, f) => { const fd = new FormData(); fd.append('file', new Blob([readFileSync(join(S, f))]), f); return j(`/api/projects/${pid}/upload`, { method: 'POST', body: fd }); };
const fmtLength = (m) => (m < 1000 ? `${m.toFixed(m < 10 ? 2 : 1)} m` : `${(m / 1000).toFixed(3)} km`);

const tag = Date.now() % 100000;
const pid = await mk(`Harbour mapping ${tag}`);
const ortho = await up(pid, 'ortho.tif');
const zip = await up(pid, 'unreferenced.zip');

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
await ctx.addInitScript(() => { try { localStorage.setItem('geodash.basemap', 'none'); if (!sessionStorage.getItem('seeded')) { localStorage.setItem('geodash.theme', 'light'); sessionStorage.setItem('seeded', '1'); } } catch {} });
const page = await ctx.newPage();
const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', (e) => errs.push(e.message));

// ── command palette
await page.goto(`${BASE}/#/`); await page.waitForSelector('.project-panel');
await page.keyboard.press('Control+k');
await page.waitForSelector('.palette');
check('Ctrl+K opens the command palette', await page.locator('.palette').isVisible());
await page.keyboard.type(`Harbour mapping ${tag}`);
await page.waitForTimeout(300);
check('palette finds the project by name', (await page.locator('.palette-item', { hasText: `Harbour mapping ${tag}` }).count()) >= 1);
await page.locator('.palette-item', { hasText: `Harbour mapping ${tag}` }).first().click();
await page.waitForURL(new RegExp(`#/project/${pid}`));
check('choosing a project opens it', page.url().includes(`/project/${pid}`));
await page.keyboard.press('Control+k');
await page.keyboard.type('unreferenced.zip');
await page.waitForTimeout(300);
await page.keyboard.press('Enter');
await page.waitForURL(/#\/dataset\//);
check('Enter opens the first matching dataset', page.url().includes('/dataset/'));
await page.keyboard.press('Control+k');
const newName = `Created from palette ${tag}`;
await page.keyboard.type(newName);
await page.locator('.palette-item', { hasText: 'Create project' }).click();
await page.waitForURL(/#\/project\//);
check('palette can create a project', (await j('/api/projects')).some((p) => p.name === newName));
await page.keyboard.press('Control+k'); await page.keyboard.press('Escape');
check('Escape closes the palette', (await page.locator('.palette').count()) === 0);

// ── theme toggle persists
await page.getByRole('button', { name: 'Switch to dark theme' }).click();
check('theme switches to dark', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
await page.reload(); await page.waitForSelector('.app-header');
check('dark theme is remembered after reload', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check('dark theme really changes the page colours', bg !== 'rgb(243, 245, 250)', bg);
await page.goto(`${BASE}/#/`); await page.waitForSelector('.project-panel'); await page.waitForTimeout(800);
await page.screenshot({ path: join(SHOTS, 'v6-dark-dashboard.png') });
await page.goto(`${BASE}/#/dataset/${ortho.id}`); await page.waitForTimeout(2000);
await page.screenshot({ path: join(SHOTS, 'v6-dark-viewer.png') });
await page.getByRole('button', { name: 'Switch to light theme' }).click();

// ── quick upload from the header
await page.goto(`${BASE}/#/`); await page.waitForSelector('.project-panel');
await page.locator('.app-header').getByRole('button', { name: 'Upload' }).click();
await page.waitForSelector('.modal');
await page.locator('#qu-project').selectOption(pid);
await page.locator('.modal input[type=file]').setInputFiles(join(S, 'local.las'));
await page.waitForFunction(() => /Uploaded and validated/.test(document.querySelector('.modal')?.textContent ?? ''), null, { timeout: 60000 });
check('quick upload adds the file to the chosen project', (await j(`/api/datasets?project=${pid}`)).some((d) => d.filename === 'local.las'));
await page.locator('.modal').getByRole('button', { name: 'Done' }).click();

// ── viewer tabs, rename and notes
await page.goto(`${BASE}/#/dataset/${zip.id}`); await page.waitForSelector('.side-tabs');
check('unreferenced dataset opens on the Georeference tab', (await page.getByRole('tab', { name: 'Georeference' }).getAttribute('aria-selected')) === 'true');
await page.goto(`${BASE}/#/dataset/${ortho.id}`); await page.waitForSelector('.side-tabs');
check('georeferenced dataset opens on the Details tab', (await page.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')) === 'true');
await page.getByRole('button', { name: 'Rename dataset' }).click();
await page.getByLabel('Dataset name').fill('Pier ortho.tif');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.waitForTimeout(800);
check('rename is saved', (await j(`/api/datasets/${ortho.id}`)).filename === 'Pier ortho.tif');
await page.getByRole('button', { name: 'Add notes' }).click();
await page.getByLabel('Dataset notes').fill('Flown 12 Oct 2026, DJI M300, 80 m AGL');
await page.getByRole('button', { name: 'Save notes' }).click();
await page.waitForTimeout(800);
check('notes are saved', (await j(`/api/datasets/${ortho.id}`)).notes === 'Flown 12 Oct 2026, DJI M300, 80 m AGL');

// ── location links come from the server's georeference
const g = await j(`/api/datasets/${ortho.id}/georef`);
const [clon, clat] = g.effective.center_wgs84;
const href = await page.getByRole('link', { name: 'Google Maps' }).getAttribute('href');
check('Google Maps link points at the dataset centre', href.includes(`${clat.toFixed(7)},${clon.toFixed(7)}`), href);
await page.getByRole('button', { name: 'Copy', exact: true }).click();
check('coordinates are copied as "lat, lon"', (await page.evaluate(() => navigator.clipboard.readText())) === `${clat.toFixed(6)}, ${clon.toFixed(6)}`);

// ── measure tool: displayed values are the server's geodesic results
const measures = [];
page.on('response', async (r) => { if (r.url().endsWith('/api/measure') && r.ok()) measures.push(await r.json()); });
await page.getByRole('button', { name: 'Measure' }).click();
const box = await page.locator('.map-box .maplibregl-canvas').boundingBox();
for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7]]) { await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy); await page.waitForTimeout(250); }
await page.waitForTimeout(800);
const last = measures[measures.length - 1];
const card = await page.locator('.measure-card').innerText();
check('measure shows the server-computed distance', !!last && card.includes(fmtLength(last.length_m)), `${card.split('\n')[1] ?? ''} vs ${last && fmtLength(last.length_m)}`);
check('measure shows an enclosed area once there are 3 points', !!last?.area_m2 && /Enclosed area/.test(card));
await page.screenshot({ path: join(SHOTS, 'v6-measure.png') });
await page.getByRole('button', { name: 'Done' }).click();
check('measure clears when finished', (await page.locator('.measure-card').count()) === 0);
// cursor readout
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.waitForTimeout(300);
const coordText = await page.locator('.map-coords').innerText();
check('cursor coordinates are shown', /Lat -?\d+\.\d{6} · Lon -?\d+\.\d{6}/.test(coordText), coordText);

// ── dashboard: recent exports, notes and warning indicator
const jid = (await j(`/api/datasets/${ortho.id}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'geotiff' }) })).job_id;
for (let i = 0; i < 100; i++) { const s = (await j(`/api/jobs/${jid}`)).state; if (s === 'done' || s === 'failed') break; await new Promise((r) => setTimeout(r, 200)); }
await page.goto(`${BASE}/#/`); await page.waitForSelector('.project-panel'); await page.waitForTimeout(1200);
const exportsCard = page.locator('.aside-card', { hasText: 'Recent exports' });
check('recent exports card lists the validated export', /Validated/.test(await exportsCard.innerText()) && (await exportsCard.locator(`a[href*="/api/jobs/${jid}/download"]`).count()) === 1);
const panel = page.locator('.project-panel', { hasText: `Harbour mapping ${tag}` });
check('dataset notes appear on the dashboard', (await panel.locator('.ds-note', { hasText: 'DJI M300' }).count()) === 1);
check('datasets with warnings are flagged', (await panel.locator('.ds-row', { hasText: 'unreferenced.zip' }).locator('.warn-icon').count()) === 1);
await page.screenshot({ path: join(SHOTS, 'v6-dashboard.png') });

check('no console errors', errs.filter((e) => !/Failed to load resource/.test(e)).length === 0, errs.slice(0, 2).join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
