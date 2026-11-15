// Builds the travel-mode demo: the real web app over a stand-in server that replays responses
// recorded from the real server at three moments of a demo trip.
//
//   npm run demo:travel   → dist/demo/travel/ (open index.html through any static server)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const out = resolve(root, 'dist/demo/travel');
const work = resolve(root, 'dist/demo/travel-work');
mkdirSync(work, { recursive: true });
const node = (args, env = {}) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { stdio: 'inherit', cwd: root, env: { ...process.env, ...env } });

const db = resolve(work, 'demo.db');
for (const f of readdirSync(work)) rmSync(resolve(work, f), { force: true });
node(['scripts/seed-demo.ts', db]);
node([resolve(here, 'todos.ts'), db]);
node([resolve(here, 'record.mjs'), db, resolve(work, 'recording.json')]);
execFileSync(resolve(root, 'node_modules/.bin/vite'), ['build', '-c', resolve(here, 'vite.config.ts')], { stdio: 'inherit', cwd: root });

// The Quran recitation model is not part of this demo.
for (const f of readdirSync(resolve(out, 'assets'))) if (/\.wasm$|quran-asr/.test(f)) rmSync(resolve(out, 'assets', f));
// A literal U+FFFD (inside a template string in the markdown parser) trips some hosts; escape it.
for (const f of readdirSync(resolve(out, 'assets'))) if (f.endsWith('.js')) {
  const p = resolve(out, 'assets', f);
  writeFileSync(p, readFileSync(p, 'utf8').replaceAll('\uFFFD', '\\uFFFD'));
}
cpSync(resolve(root, 'web/public/tails'), resolve(out, 'tails'), { recursive: true });

const data = readFileSync(resolve(work, 'recording.json'), 'utf8');
if (/<\/script/i.test(data)) throw new Error('The recording contains a closing script tag and cannot be inlined.');
const html = readFileSync(resolve(out, 'index.html'), 'utf8').replace('</body>', () => `<script type="application/json" id="demo-data">${data}</script>\n</body>`);
writeFileSync(resolve(out, 'index.html'), html);
rmSync(work, { recursive: true, force: true });
console.log(`Demo written to ${out}. Serve it (e.g. npx vite preview --outDir dist/demo/travel) and open it.`);
