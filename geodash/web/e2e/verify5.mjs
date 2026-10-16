/** Dashboard: panels, search, filter, sort, expand/collapse, rename, delete. Backend must be running with sample files generated. */
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

const tag = Date.now() % 100000;
const a = await mk(`Highway survey ${tag}`); await up(a, 'ortho.tif'); await up(a, 'unreferenced.zip');
await new Promise((r) => setTimeout(r, 1100));
const b = await mk(`Campus LiDAR ${tag}`); await up(b, 'local.las');
await new Promise((r) => setTimeout(r, 1100));
const c = await mk(`Empty site ${tag}`);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${BASE}/#/`);
await page.waitForSelector('.project-panel');
await page.waitForTimeout(1200);
await page.screenshot({ path: join(SHOTS, 'v5-dashboard.png') });

const mine = (t) => page.locator('.project-panel', { hasText: `${t} ${tag}` });
check('project panels are listed', (await mine('Highway survey').count()) === 1 && (await mine('Campus LiDAR').count()) === 1);
check('dataset rows are shown inside an expanded panel', (await mine('Campus LiDAR').locator('.ds-row').count()) + (await mine('Highway survey').locator('.ds-row').count()) >= 1);
check('summary shows how many datasets need georeferencing', /\d+\s*Need georeferencing/.test((await page.locator('.dash-stats').innerText()).replace('\n', '')));

// newest first by default
const names = await page.locator('.project-name').allInnerTexts();
const idx = (t) => names.findIndex((n) => n.includes(`${t} ${tag}`));
check('default sort is newest first', idx('Empty site') < idx('Campus LiDAR') && idx('Campus LiDAR') < idx('Highway survey'));
await page.selectOption('select[aria-label="Sort projects"]', 'name');
await page.waitForTimeout(300);
const byName = await page.locator('.project-name').allInnerTexts();
check('sort by name works', byName.findIndex((n) => n.includes(`Campus LiDAR ${tag}`)) < byName.findIndex((n) => n.includes(`Empty site ${tag}`)));
await page.selectOption('select[aria-label="Sort projects"]', 'newest');

// search by project name and by dataset file name
await page.getByLabel('Search projects and datasets').fill(`Campus LiDAR ${tag}`);
await page.waitForTimeout(300);
check('search by project name', (await page.locator('.project-panel').count()) === 1);
await page.getByLabel('Search projects and datasets').fill('unreferenced.zip');
await page.waitForTimeout(300);
check('search by dataset file name finds its project', (await mine('Highway survey').count()) === 1);
await page.getByLabel('Search projects and datasets').fill('');

// filter
await page.getByLabel('Needs georeferencing', { exact: false }).first().check().catch(() => {});
await page.locator('.dash-filter input').check();
await page.waitForTimeout(300);
check('filter keeps only projects with unreferenced data', (await mine('Empty site').count()) === 0 && (await mine('Campus LiDAR').count()) === 1);
await page.locator('.dash-filter input').uncheck();

// collapse / expand
const camp = mine('Campus LiDAR');
const was = await camp.locator('.ds-row').count();
await camp.locator('.project-panel-toggle').click();
const collapsed = await camp.locator('.ds-row').count();
await camp.locator('.project-panel-toggle').click();
check('panel collapses and expands', was >= 1 && collapsed === 0 && (await camp.locator('.ds-row').count()) === was);

// unreferenced dataset: badge + Georeference action leads to its viewer
await camp.locator('.ds-geo').first().click();
await page.waitForURL(/#\/dataset\//);
check('Georeference action opens the dataset', /#\/dataset\//.test(page.url()));
await page.goto(`${BASE}/#/`); await page.waitForSelector('.project-panel');

// rename
const empty = mine('Empty site');
await empty.getByRole('button', { name: /More actions/ }).click();
await page.getByRole('menuitem', { name: 'Rename' }).click();
await page.getByLabel('Project name').fill(`Renamed site ${tag}`);
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.waitForTimeout(800);
check('rename works', (await mine('Renamed site').count()) === 1 && (await j('/api/projects')).some((p) => p.name === `Renamed site ${tag}`));

// delete asks first, then deletes
const ren = mine('Renamed site');
await ren.getByRole('button', { name: /More actions/ }).click();
await page.getByRole('menuitem', { name: 'Delete project' }).click();
check('delete asks for confirmation first', (await j('/api/projects')).some((p) => p.id === c));
await ren.getByRole('button', { name: 'Yes, delete' }).click();
await page.waitForTimeout(800);
check('project is deleted after confirming', !(await j('/api/projects')).some((p) => p.id === c));

check('no console errors', errs.filter((e) => !/Failed to load resource/.test(e)).length === 0, errs.slice(0, 2).join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
