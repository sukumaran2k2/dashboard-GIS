/** Third pass: projects, upload through the real file input, error messages, library filters, info panel, delete. */
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

const bad = join(SAMPLES, 'broken.tif'); writeFileSync(bad, Buffer.from('this is not a real tiff'.repeat(10)));
const dwg = join(SAMPLES, 'drawing.dwg'); writeFileSync(dwg, Buffer.from('AC1027'));
const name = 'verify3 ' + Date.now();

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
await ctx.addInitScript(() => { try { localStorage.setItem('geodash.basemap', 'none'); } catch {} });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));
const shot = (n) => page.screenshot({ path: join(SHOTS, `v3-${n}.png`) });

// dashboard
await page.goto(`${BASE}/#/`);
await page.waitForSelector('text=Dashboard', { timeout: 10000 });
await shot('1-dashboard');

// create a project through the UI
await page.goto(`${BASE}/#/projects`);
await page.getByRole('button', { name: /New project/ }).first().click();
await page.getByRole('textbox').last().fill(name);
await page.getByRole('button', { name: 'Create', exact: true }).click();
await page.waitForURL(/#\/project\/.+/, { timeout: 10000 });
await page.getByText(name).first().waitFor({ timeout: 10000 }).catch(() => {});
check('project created through the UI and opened', (await page.getByText(name).count()) > 0 && /#\/project\//.test(page.url()), page.url());

// upload through the real file input: one good, one corrupt, one unsupported
await page.setInputFiles('input[type=file]', [join(SAMPLES, 'ortho.tif'), bad, dwg, join(SAMPLES, 'unreferenced.zip')]);
await page.waitForFunction(() => { const s = [...document.querySelectorAll('.upload-status')]; return s.length === 4 && !s.some((e) => /Validating|Uploading/.test(e.textContent)); }, null, { timeout: 60000 });
await page.waitForTimeout(800);
const statuses = await page.locator('.upload-item, .up').allInnerTexts().catch(() => []);
const body = await page.locator('main, body').first().innerText();
check('good raster is reported as uploaded', /ortho\.tif/.test(body) && /(Uploaded|validated|Done)/i.test(body));
check('corrupt file shows the server message', /not a readable raster/i.test(body));
check('DWG is refused with the reason', /proprietary/i.test(body));
await shot('2-uploads');
await page.locator('table tbody tr').nth(1).waitFor({ timeout: 15000 }).catch(() => {});
const rows = await page.locator('table tbody tr').count();
check('dataset table lists the accepted files (2)', rows === 2, `${rows} rows`);
check('unreferenced dataset is flagged in the list', (await page.locator('.badge-unreferenced').count()) >= 1);

// dataset row actions
const pid = (await page.evaluate(() => location.hash)).split('/')[2];
const list = await j(`/api/datasets?project=${pid}`);
const ortho = list.find((d) => d.filename === 'ortho.tif');
await page.goto(`${BASE}/#/dataset/${ortho.id}`);
await page.waitForSelector('.side-tabs');

// info panel: integrity check and category change
await page.getByRole('button', { name: 'Verify file integrity' }).click();
await page.getByText(/File (unchanged|has been modified)/).waitFor({ timeout: 15000 }).catch(() => {});
check('integrity check says the original is unchanged', /File unchanged since upload/.test(await page.locator('.viewer-sidebar').innerText()));
await page.getByText('Edit', { exact: true }).first().click();
await page.getByLabel('Select category').selectOption('dsm');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.waitForTimeout(1200);
check('category change is stored', (await j(`/api/datasets/${ortho.id}`)).category === 'dsm');

// library: search and filter
await page.goto(`${BASE}/#/library`);
await page.waitForSelector('table');
const all = await page.locator('table tbody tr').count();
await page.getByPlaceholder(/Search/i).first().fill('unreferenced');
await page.waitForTimeout(800);
const filtered = await page.locator('table tbody tr').count();
check('library search narrows the list', filtered >= 1 && filtered < all, `${all} -> ${filtered}`);
await shot('3-library');

// delete with an in-page confirmation (no browser dialog)
await page.goto(`${BASE}/#/dataset/${ortho.id}`);
await page.waitForSelector('.side-tabs');
await page.getByRole('button', { name: 'Delete dataset' }).click();
await page.waitForTimeout(500);
await shot('4-delete-confirm');
check('delete asks for confirmation inside the page and nothing is deleted yet', (await fetch(`${BASE}/api/datasets/${ortho.id}`)).status === 200);
await page.locator('.modal, .modal-overlay').getByRole('button', { name: /Delete/ }).last().click();
await page.waitForTimeout(1500);
const after = await fetch(`${BASE}/api/datasets/${ortho.id}`);
check('dataset deleted after confirming', after.status === 404);

check('no console errors', errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
