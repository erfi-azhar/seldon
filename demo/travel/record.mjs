// Runs the real server against a demo database at each scenario's moment and records every
// API response the app asks for on Today, the trips and the Travels sphere.
//   node demo/travel/record.mjs <demo.db> <out.json>
import { spawn } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const [dbPath, outPath] = process.argv.slice(2);
const scenarios = JSON.parse(readFileSync(resolve(here, 'scenarios.json'), 'utf8'));
const db = new DatabaseSync(dbPath, { readOnly: true });
const trips = db.prepare('SELECT id, title FROM trips ORDER BY start_date').all();
const travels = db.prepare("SELECT id FROM spheres WHERE name LIKE 'Travel%'").get()?.id;
db.close();
const pages = ['/', ...trips.map((t) => `/trips/${t.id}`), ...(travels ? [`/spheres/${travels}`] : [])];

const out = { trips, travels, scenarios: {} };
const browser = await chromium.launch();
let port = 4400;
for (const s of scenarios) {
  const copy = `${dbPath}.${s.id}`;
  copyFileSync(dbPath, copy);
  // A moment can change its own copy first (a delayed flight, say).
  if (s.sql) {
    const d = new DatabaseSync(copy);
    d.exec(s.sql);
    d.close();
  }
  const p = ++port;
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', resolve(here, 'fake-now.mjs'), resolve(root, 'server/src/index.ts')], {
    env: { ...process.env, FAKE_NOW: s.now, TERMINUS_DB: copy, PORT: String(p) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((ok) => srv.stdout.on('data', (d) => String(d).includes('running') && ok()));
  const ctx = await browser.newContext({ viewport: { width: 430, height: 1200 }, timezoneId: 'Asia/Singapore' });
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(s.now) });
  const rec = {};
  page.on('response', async (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/') || r.request().method() !== 'GET' || !r.ok()) return;
    if (!(r.headers()['content-type'] ?? '').includes('json')) return;
    try { rec[u.pathname.slice(4)] = await r.json(); } catch {}
  });
  for (const path of pages) {
    await page.goto(`http://localhost:${p}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
  }
  out.scenarios[s.id] = rec;
  console.log(s.id, Object.keys(rec).length, 'responses; mode =', rec['/travel']?.context?.mode);
  await ctx.close();
  srv.kill();
}
await browser.close();
writeFileSync(outPath, JSON.stringify(out));
