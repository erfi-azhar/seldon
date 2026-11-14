// Builds the welcome-stage demo into one self-contained HTML file: dist/demo/welcome.html.
// The demo runs the app's own particle engine (web/src/components/Vault.tsx) with a mock
// of the sign-in and onboarding screens around it, and a small panel of controls.
//
//   npm run demo:welcome

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const out = resolve(root, 'dist/demo');
mkdirSync(out, { recursive: true });

const bundle = resolve(out, 'welcome.js');
execFileSync(resolve(root, 'node_modules/.bin/rolldown'), [resolve(here, 'entry.ts'), '-f', 'iife', '-m', '-o', bundle], { stdio: 'inherit' });

const js = readFileSync(bundle, 'utf8');
if (/<\/script/i.test(js)) throw new Error('The bundle contains a closing script tag and cannot be inlined.');
const html = readFileSync(resolve(here, 'template.html'), 'utf8').replace('/*BUNDLE*/', () => js);
writeFileSync(resolve(out, 'welcome.html'), html);
console.log(`Demo written to ${resolve(out, 'welcome.html')} (${Math.round(html.length / 1024)} KB). Open it in a browser.`);
