import assert from 'node:assert/strict';
import { test } from 'node:test';
import { welcomeIn } from '../../shared/welcome.ts';
import { AIRPORTS } from '../src/features/airports.ts';

test('welcome follows the language where you land, and English places get none', () => {
  assert.deepEqual(welcomeIn('Asia/Tokyo'), { word: 'ようこそ', roman: 'Yōkoso', language: 'Japanese' });
  assert.equal(welcomeIn('Europe/Paris')?.word, 'Bienvenue');
  assert.equal(welcomeIn('Europe/Paris')?.roman, '');
  assert.equal(welcomeIn('Asia/Kuala_Lumpur')?.language, 'Malay');
  for (const tz of ['Europe/London', 'America/New_York', 'Australia/Sydney', 'Asia/Singapore', 'Nowhere/Special', '', null]) assert.equal(welcomeIn(tz), null, String(tz));
});

test('every non-English zone in the airport list has a welcome', () => {
  const english = new Set(['Europe/London', 'Europe/Dublin', 'Asia/Singapore', 'Africa/Johannesburg']);
  const missing = [...new Set(Object.values(AIRPORTS).map((a) => a.tz))].filter((tz) => !english.has(tz) && !/^(America\/(New_York|Chicago|Denver|Los_Angeles|Toronto|Vancouver)|Australia\/)/.test(tz) && !welcomeIn(tz));
  assert.deepEqual(missing, []);
});
