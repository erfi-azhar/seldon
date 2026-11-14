// Regression tests for findings from the code review.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openAiProvider } from '../src/agent/providers/openai.ts';
import { runTool } from '../src/agent/tools.ts';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { Store, type ModelConfig } from '../src/store.ts';
import { fakeModel, oaChunk } from './helpers.ts';

const DAY = '2026-11-14';

function fresh() {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['health', 'work'] });
  return { db, store, sphereId: store.listSpheres(DAY)[0]!.id };
}

test('undoing a same-day re-log puts the old value back instead of deleting the day', () => {
  const { store, sphereId } = fresh();
  const m = store.createMetric({ sphereId, name: 'Weight', unit: 'kg' });
  store.addMetricEntry(m.id, { value: 80, date: DAY, note: 'morning' });
  store.addMetricEntry(m.id, { value: 79.4, date: DAY });
  const relog = store.listActivity()[0]!;
  assert.equal(store.undo(relog.id), true);
  assert.equal(store.getMetric(m.id).latest, 80);
  const first = store.listActivity().find((a) => a.entityType === 'metric_entry')!;
  assert.equal(store.undo(first.id), true);
  assert.equal(store.getMetric(m.id).latest, null, 'undoing the first log removes the day');
});

test('a goal linked to an empty metric takes its first reading as the baseline', () => {
  const { store, sphereId } = fresh();
  const m = store.createMetric({ sphereId, name: 'Weight', unit: 'kg', direction: 'down' });
  const g = store.createGoal({ sphereId, title: 'Reach 75 kg', metricId: m.id, targetValue: 75 });
  store.addMetricEntry(m.id, { value: 80, date: '2026-11-01' });
  assert.equal(store.getGoal(g.id).progress, 0, 'not 100% on the first log');
  store.addMetricEntry(m.id, { value: 77.5, date: DAY });
  assert.equal(store.getGoal(g.id).progress, 0.5);
});

test("'done today' and quiet days use the browser's time zone", async () => {
  const { db, store, sphereId } = fresh();
  const app = createApp({ db });
  // Auckland is UTC+13 in November: 2026-11-14 09:00 there is 2026-11-13 20:00 UTC.
  await app.request(`http://localhost/api/overview?date=${DAY}`, { headers: { 'x-timezone': 'Pacific/Auckland' } });
  assert.equal(store.zone(), 'Pacific/Auckland');
  const t = store.createTask({ title: 'Morning run', sphereId });
  db.prepare('UPDATE tasks SET done = 1, done_at = ? WHERE id = ?').run('2026-11-13T20:00:00.000Z', t.id);
  db.prepare('UPDATE activity SET ts = ?').run('2026-11-13T20:00:00.000Z');
  const o = store.overview(DAY);
  assert.deepEqual(o.tasks.doneToday.map((x) => x.title), ['Morning run']);
  assert.equal(store.getSphere(sphereId, DAY).stats.quietDays, 0);
  store.setZone('Not/AZone');
  assert.equal(store.zone(), 'Pacific/Auckland', 'unknown zones are ignored');
});

test('empty ids mean none; unknown ids are a 404, not a database error', async () => {
  const { db, sphereId } = fresh();
  const app = createApp({ db });
  const post = (body: unknown) => app.request('http://localhost/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ok = await post({ title: 'A', sphereId: '', goalId: '' });
  assert.equal(ok.status, 201);
  assert.equal(((await ok.json()) as { sphereId: string | null }).sphereId, null);
  assert.equal((await post({ title: 'B', goalId: 'nope' })).status, 404);
  assert.equal((await post({ title: 'C', sphereId })).status, 201);
});

test('an opaque Origin is refused cleanly; sessions end when the passphrase changes', async () => {
  const { db } = fresh();
  const open = createApp({ db });
  const res = await open.request('http://localhost/api/tasks', { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json' }, body: '{"title":"x"}' });
  assert.equal(res.status, 403);

  const first = createApp({ db, passphrase: 'correct horse' });
  const login = await first.request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'correct horse' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await first.request('http://localhost/api/overview', { headers: { cookie } })).status, 200);
  assert.equal((await createApp({ db, passphrase: 'correct horse' }).request('http://localhost/api/overview', { headers: { cookie } })).status, 200, 'a restart keeps sessions');
  assert.equal((await createApp({ db, passphrase: 'battery staple' }).request('http://localhost/api/overview', { headers: { cookie } })).status, 401);
});

test('screenings that the page cannot draw are refused with the field named', async () => {
  const { db } = fresh();
  const app = createApp({ db });
  const put = (body: unknown) => app.request('http://localhost/api/screenings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const good = { title: 'Check-ups', visits: [{ label: '2025' }, { label: '2026' }], results: [{ g: 'Lipids', n: 'LDL', u: 'mmol/L', a: 3.4, b: '3.1', s: 'ok' }] };
  assert.equal((await put(good)).status, 200);
  const stored = (await (await app.request('http://localhost/api/screenings')).json()) as { results: { a: string }[] };
  assert.equal(stored.results[0]!.a, '3.4', 'numbers are kept as text');
  const bad = await put({ ...good, summary: 'not a list' });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /summary/);
  assert.equal((await put({ ...good, results: [{ g: 'x', n: 'y', a: null, b: null, s: 'great' }] })).status, 400);
});

test('search takes from each kind in turn, so notes are found among many goals', () => {
  const { store, sphereId } = fresh();
  for (let i = 0; i < 12; i++) store.createGoal({ sphereId, title: `Garden goal ${i}` });
  store.createNote({ title: 'Garden plan', body: 'tomatoes' });
  const hits = store.search('garden', 6);
  assert.ok(hits.some((h) => h.type === 'note'));
});

test('an import with no spheres or a damaged table changes nothing', () => {
  const { store } = fresh();
  const before = store.listSpheres(DAY).length;
  assert.throws(() => store.importAll({ format: 'terminus', version: 1, tables: {} }), /no spheres/);
  assert.throws(() => store.importAll({ format: 'terminus', version: 1, tables: { spheres: 'x' } }), /damaged/);
  const dump = store.exportAll();
  (dump.tables.tasks as unknown[]).push({ id: 'bad', title: 'x', sphere_id: 'no-such-sphere', created_at: 'now' });
  assert.throws(() => store.importAll(dump), /could not be read/);
  assert.equal(store.listSpheres(DAY).length, before);
});

test("undoing a new habit also retires its check-ins in the feed", () => {
  const { store, sphereId } = fresh();
  const h = store.createHabit({ sphereId, name: 'Walk' });
  store.setHabitLog(h.id, DAY, true, DAY);
  const created = store.listActivity().find((a) => a.verb === 'created' && a.entityType === 'habit')!;
  assert.equal(store.undo(created.id), true);
  assert.equal(store.listActivity().filter((a) => a.entityType === 'habit_log').length, 0);
});

test('agent tools: impossible dates are refused; "3 times a week" means a weekly habit', async () => {
  const { store, sphereId } = fresh();
  const ctx = { store: store.as('agent'), today: DAY };
  const bad = await runTool('create_task', { title: 'x', due_date: '2026-02-30' }, ctx);
  assert.equal(bad.isError, true);
  assert.match(bad.content, /real calendar date/);
  const h = await runTool('create_habit', { sphere_id: sphereId, name: 'Gym', times_per_week: 3 }, ctx);
  assert.equal(h.isError, false);
  assert.match(h.summary, /3× a week/);
});

const cfg = (baseUrl: string): ModelConfig => ({ provider: 'openai-compatible', preset: null, baseUrl, model: 'm', effort: 'auto', apiKey: '' });
const ask = (url: string) => openAiProvider(cfg(`${url}/v1`)).complete({ system: 's', turns: [{ role: 'user', text: 'hi', display: 'hi' }], tools: [], onText: () => undefined });

test('OpenAI streams: parallel calls all numbered 0, a last line with no newline, an error event', async () => {
  const parallel =
    oaChunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'one', arguments: '{"x":1}' } }] }) +
    oaChunk({ tool_calls: [{ index: 0, id: 'b', type: 'function', function: { name: 'two', arguments: '{"y":2}' } }] }) +
    oaChunk({}, 'tool_calls') +
    'data: [DONE]\n\n';
  const noIndex =
    oaChunk({ tool_calls: [{ id: 'c', type: 'function', function: { name: 'three', arguments: '{"z":' } }] }) +
    oaChunk({ tool_calls: [{ function: { arguments: '3}' } }] }) +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}`;
  const failing = oaChunk({ content: 'Hel' }) + `data: ${JSON.stringify({ error: { message: 'overloaded' } })}\n\n`;
  const model = await fakeModel([{ sse: parallel }, { sse: noIndex }, { sse: failing }, { sse: 'data: [DONE]\n\n' }]);
  const r1 = await ask(model.url);
  assert.deepEqual(r1.toolCalls.map((c) => [c.id, c.name, c.input]), [['a', 'one', { x: 1 }], ['b', 'two', { y: 2 }]]);
  const r2 = await ask(model.url);
  assert.deepEqual(r2.toolCalls.map((c) => [c.name, c.input]), [['three', { z: 3 }]]);
  await assert.rejects(ask(model.url), /overloaded/);
  await assert.rejects(ask(model.url), /without saying anything/);
});
