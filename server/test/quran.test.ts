import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { openDb } from '../src/db.ts';
import { addReflection, markStudied, moveTo, nextKey, reflections, setQuranFetch, studyState, tafsirBlocks, verse } from '../src/features/quran.ts';
import { Store } from '../src/store.ts';
import '../src/features/index.ts';

// A fake quran.com. Its text is placeholder, not Quran text: the shape is what is tested.
const counts = Array.from({ length: 114 }, (_, i) => (i === 0 ? 7 : i === 1 ? 286 : i === 113 ? 6 : 10));
const seen: string[] = [];
let down = false;
setQuranFetch((async (input: string | URL | Request) => {
  const url = String(input);
  seen.push(url);
  if (down) return new Response('busy', { status: 503 });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/chapters')) return json({ chapters: counts.map((n, i) => ({ id: i + 1, name_simple: `Surah ${i + 1}`, name_arabic: 'س', verses_count: n, translated_name: { name: `Meaning ${i + 1}` } })) });
  const v = /verses\/by_key\/(\d+:\d+)/.exec(url);
  if (v) return json({ verse: { text_uthmani: `ARABIC ${v[1]}`, translations: [{ text: `Translation of ${v[1]}<sup foot_note=1>1</sup> &amp; more` }] } });
  const t = /tafsirs\/(\d+)\/by_ayah\/(\d+:\d+)/.exec(url);
  if (t) return json({ tafsir: { verses: { [t[2]!]: {}, '2:4': {} }, text: `<h2>Heading ${t[1]}</h2><p>First &quot;paragraph&quot;.</p><p>الحمد لله</p><p></p>` } });
  return new Response('{}', { status: 404 });
}) as typeof fetch);
after(() => setQuranFetch(null));
beforeEach(() => {
  seen.length = 0;
  down = false;
});

function fresh(): Store {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['faith'] });
  return store;
}

test('tafsir HTML becomes plain blocks, with Arabic lines told apart', () => {
  assert.deepEqual(tafsirBlocks('<h2>Title</h2><p>Some <b>bold</b> &amp; text.</p><p>بِسْمِ ٱللَّهِ</p><p> </p>'), [
    { kind: 'h', text: 'Title' },
    { kind: 'p', text: 'Some bold & text.' },
    { kind: 'ar', text: 'بِسْمِ ٱللَّهِ' },
  ]);
  assert.deepEqual(tafsirBlocks('Plain text with no tags'), [{ kind: 'p', text: 'Plain text with no tags' }]);
});

test('a verse comes with its translation and tafsir, and is fetched once', async () => {
  const v = await verse('2:3', 169);
  assert.equal(v.arabic, 'ARABIC 2:3');
  assert.equal(v.translation, 'Translation of 2:3 & more', 'footnote markers and entities are cleaned');
  assert.equal(v.tafsir!.name, 'Ibn Kathir (Abridged)');
  assert.deepEqual(v.tafsir!.covers, ['2:3', '2:4']);
  assert.deepEqual(v.tafsir!.blocks.map((b) => b.kind), ['h', 'p', 'ar']);
  const calls = seen.length;
  await verse('2:3', 169);
  assert.equal(seen.length, calls, 'the second ask is served from memory');
  assert.equal((await verse('2:3', 999)).tafsir!.id, 169, 'an unknown tafsir falls back to the default');
  await assert.rejects(verse('2:287', 169), /286 ayat/);
  await assert.rejects(verse('115:1', 169), /114 surahs/);
});

test('studying moves through the mushaf and keeps count; reflections are notes on the ayah', async () => {
  const store = fresh();
  const today = '2026-11-18'; // a Wednesday
  assert.equal(studyState(store, today).key, '1:1');
  await moveTo(store, '1:7');
  await markStudied(store, '1:7', today);
  let s = studyState(store, today);
  assert.equal(s.key, '2:1', 'the last ayah of a surah leads into the next');
  assert.equal(s.total, 1);
  await markStudied(store, '2:1', today);
  await markStudied(store, '2:1', today);
  s = studyState(store, today);
  assert.equal(s.key, '2:2');
  assert.equal(s.total, 2, 'an ayah counts once a day');
  assert.equal(s.week, 2);
  assert.equal(s.streak, 1);
  // Studying an ayah away from your place doesn't move it.
  await markStudied(store, '3:1', today);
  assert.equal(studyState(store, today).key, '2:2');

  store.db.prepare("INSERT INTO quran_study_log VALUES ('2:5', '2026-11-17', 'x'), ('2:6', '2026-11-16', 'x'), ('2:7', '2026-11-14', 'x')").run();
  s = studyState(store, today);
  assert.equal(s.streak, 3, 'three days running; the gap on the 15th ends it');
  assert.equal(s.week, 5, 'Monday the 16th onwards');
  assert.equal(studyState(store, '2026-11-19').streak, 3, 'a streak stands until a day passes unstudied');

  const n = await addReflection(store, '2:2', 'Something I noticed.');
  assert.equal(n.title, 'Reflection on Surah 2 2:2');
  assert.equal(n.url, 'https://quran.com/2:2');
  assert.ok(n.sphereId, 'filed in the Faith sphere');
  assert.deepEqual(reflections(store, '2:2').map((x) => x.id), [n.id]);
  assert.deepEqual(reflections(store, '2:3'), []);
  await assert.rejects(addReflection(store, '2:2', '   '), /few words/);
});

test('the ayah after the last of the Quran is the first', () => {
  const list = counts.map((n, i) => ({ id: i + 1, name: '', nameArabic: '', meaning: '', verses: n }));
  assert.equal(nextKey(list, 2, 5), '2:6');
  assert.equal(nextKey(list, 114, 6), '1:1');
});

test('quran.com being down is reported, not crashed on', async () => {
  setQuranFetch(null);
  setQuranFetch((async () => new Response('busy', { status: 503 })) as typeof fetch);
  await assert.rejects(verse('1:1', 169), /could not be reached/);
});
