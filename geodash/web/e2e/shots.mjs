/** Seeds sample projects and screenshots each page (desktop + phone) into .testdata/shots. Backend must be running. */
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.GEODASH_URL ?? 'http://127.0.0.1:8765';
const S = join(here, '..', '.testdata', 'samples');
const OUT = join(here, '..', '.testdata', 'shots'); mkdirSync(OUT, { recursive: true });
const j = async (p, i) => { const r = await fetch(BASE + p, i); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
const mk = async (name) => (await j('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).id;
const up = async (pid, f) => { const fd = new FormData(); fd.append('file', new Blob([readFileSync(join(S, f))]), f); return j(`/api/projects/${pid}/upload`, { method: 'POST', body: fd }); };

let seeded = (await j('/api/projects')).length > 0;
let first;
if (!seeded) {
  const a = await mk('Chennai Port approach survey'); first = await up(a, 'ortho.tif'); await up(a, 'unreferenced.zip');
  await new Promise((r) => setTimeout(r, 1100));
  const b = await mk('Ennore coastal LiDAR'); await up(b, 'local.las');
  await new Promise((r) => setTimeout(r, 1100));
  await mk('Kattupalli waterway study');
}
const ds = await j('/api/datasets'); first = ds.find((d) => d.kind === 'raster');
const lidar = ds.find((d) => d.kind === 'pointcloud');
const pid = first.project_id;

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const [tag, vp] of [['d', { width: 1440, height: 900 }], ['m', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp });
  await ctx.addInitScript(() => { try { localStorage.setItem('geodash.basemap', 'none'); } catch {} });
  const page = await ctx.newPage();
  const shots = [['dashboard', '#/'], ['projects', '#/projects'], ['project', `#/project/${pid}`], ['library', '#/library'],
    ['viewer', `#/dataset/${first.id}`], ['lidar', `#/dataset/${lidar.id}`], ['map', `#/project/${pid}/map`]];
  for (const [name, hash] of shots) {
    await page.goto(`${BASE}/${hash}`); await page.waitForTimeout(2800);
    await page.screenshot({ path: join(OUT, `ui-${tag}-${name}.png`), fullPage: tag === 'm' && ['dashboard', 'projects', 'project', 'library'].includes(name) });
  }
  await ctx.close();
}
await browser.close();
console.log('ok');
