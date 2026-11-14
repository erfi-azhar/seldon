import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { syncGravl } from '../src/features/gravl.ts';
import { healthState, logBody, logFood, logWorkout } from '../src/features/health.ts';
import { dateInZone, nowIso, Store } from '../src/store.ts';
import { anthropicMessage, fakeModel } from './helpers.ts';

const DAY = '2026-11-14';
const servers: HttpServer[] = [];
after(() => servers.forEach((s) => s.close()));

function setup() {
  const db = openDb(':memory:');
  const app = createApp({ db });
  const store = new Store(db);
  store.onboard({ userName: '', agentName: 'Seldon', sphereKeys: ['health'] });
  const call = (method: string, path: string, data?: object) =>
    app.request(`http://localhost:4321${path}`, { method, headers: { 'content-type': 'application/json', origin: 'http://localhost:4321' }, body: data && JSON.stringify(data) });
  const sphere = store.listSpheres()[0]!;
  return { store, call, sphere };
}

const noBody = { bodyFatPct: null, muscleKg: null, visceralFat: null, waterPct: null, bmr: null };

test('undoing or deleting a body reading takes its weight back out of the Weight metric and goal', async () => {
  const { store, call, sphere } = setup();
  const weight = store.createMetric({ sphereId: sphere.id, name: 'Weight', unit: 'kg', direction: 'down' });
  store.addMetricEntry(weight.id, { value: 80, date: '2026-11-01' });
  const goal = store.createGoal({ sphereId: sphere.id, title: 'Reach 76 kg', metricId: weight.id, targetValue: 76 });

  // A mistyped reading, undone from the feed.
  logBody(store, { date: DAY, weightKg: 70, ...noBody });
  assert.equal(store.getMetric(weight.id).latest, 70);
  const created = store.listActivity().find((a) => a.verb === 'created' && a.entityType === 'body_reading')!;
  assert.equal(store.undo(created.id), true);
  assert.equal(healthState(store, DAY).body.length, 0);
  assert.equal(store.getMetric(weight.id).latest, 80);
  assert.equal(store.getGoal(goal.id).progress, 0);
  assert.ok(!store.listActivity().some((a) => a.entityType === 'metric_entry' && /70 kg/.test(a.summary)), 'the paired "Logged Weight" row goes too');

  // A value typed by hand for the day comes back, rather than being lost.
  store.addMetricEntry(weight.id, { value: 79, date: DAY });
  logBody(store, { date: DAY, weightKg: 70, ...noBody });
  const id = healthState(store, DAY).body.at(-1)!.id;
  assert.equal((await call('DELETE', `/api/health/body/${id}`)).status, 200);
  assert.equal(store.getMetric(weight.id).latest, 79);

  // Something written to the day after the reading is left alone.
  logBody(store, { date: DAY, weightKg: 70, ...noBody });
  store.addMetricEntry(weight.id, { value: 78, date: DAY });
  const later = healthState(store, DAY).body.at(-1)!.id;
  assert.equal((await call('DELETE', `/api/health/body/${later}`)).status, 200);
  assert.equal(store.getMetric(weight.id).latest, 78);
  assert.equal((await call('DELETE', `/api/health/body/${later}`)).status, 404);
});

test('synced rows the person deletes are not imported again', async () => {
  const { store, call } = setup();
  logFood(store, DAY, '08:00', [{ name: 'Oats', kcal: 300 }], 'gravl', 'f1', true);
  logWorkout(store, { date: DAY, name: 'Run', type: 'run', durationMin: 30, distanceKm: 5, kcal: null, notes: '', exercises: [] }, 'gravl', 'w1', true);
  logBody(store, { date: DAY, weightKg: 78.4, ...noBody }, 'gravl', DAY, true);
  const h = healthState(store, DAY);
  assert.equal((await call('DELETE', `/api/health/food/${h.today.entries[0]!.id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/health/workouts/${h.workouts[0]!.id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/health/body/${h.body[0]!.id}`)).status, 200);

  assert.deepEqual(logFood(store, DAY, '08:00', [{ name: 'Oats', kcal: 300 }], 'gravl', 'f1', true), []);
  assert.equal(logWorkout(store, { date: DAY, name: 'Run', type: 'run', durationMin: 30, distanceKm: 5, kcal: null, notes: '', exercises: [] }, 'gravl', 'w1', true), null);
  assert.equal(logBody(store, { date: DAY, weightKg: 78.4, ...noBody }, 'gravl', DAY, true), null);
  const after = healthState(store, DAY);
  assert.deepEqual([after.today.entries.length, after.workouts.length, after.body.length], [0, 0, 0]);
  // Only that key: another Gravl entry still comes in.
  assert.equal(logFood(store, DAY, '12:00', [{ name: 'Rice', kcal: 400 }], 'gravl', 'f2', true).length, 1);
});

test('a later Gravl weigh-in for the same day corrects the reading and the Weight metric', () => {
  const { store, sphere } = setup();
  const weight = store.createMetric({ sphereId: sphere.id, name: 'Weight', unit: 'kg', direction: 'down' });
  assert.ok(logBody(store, { date: DAY, weightKg: 78.4, ...noBody }, 'gravl', DAY, true));
  const fixed = logBody(store, { date: DAY, weightKg: 77.9, ...noBody, bodyFatPct: 24 }, 'gravl', DAY, true);
  assert.deepEqual([fixed?.weightKg, fixed?.bodyFatPct], [77.9, 24]);
  assert.equal(logBody(store, { date: DAY, weightKg: 77.9, ...noBody }, 'gravl', DAY, true), null, 'the same answer again changes nothing');
  const body = healthState(store, DAY).body;
  assert.deepEqual(body.map((b) => [b.weightKg, b.bodyFatPct]), [[77.9, 24]]);
  assert.equal(store.getMetric(weight.id).latest, 77.9);
});

test('weight from body composition is converted for a Weight metric kept in pounds', () => {
  const { store, sphere } = setup();
  const weight = store.createMetric({ sphereId: sphere.id, name: 'Weight', unit: 'lb', direction: 'down' });
  store.addMetricEntry(weight.id, { value: 185, date: '2026-11-01' });
  const goal = store.createGoal({ sphereId: sphere.id, title: 'Reach 170 lb', metricId: weight.id, targetValue: 170 });
  const reading = logBody(store, { date: DAY, weightKg: 83, ...noBody })!;
  assert.equal(store.getMetric(weight.id).latest, 183);
  assert.ok(store.getGoal(goal.id).progress < 0.2);
  // And undoing it still finds the converted entry.
  const created = store.listActivity().find((a) => a.verb === 'created' && a.entityType === 'body_reading' && a.entityId === reading.id)!;
  store.undo(created.id);
  assert.equal(store.getMetric(weight.id).latest, 185);

  const stone = store.createMetric({ sphereId: sphere.id, name: 'Body weight', unit: 'st', direction: 'down' });
  logBody(store, { date: DAY, weightKg: 83, ...noBody });
  assert.equal(store.getMetric(stone.id).latest, null, 'a unit we cannot convert to is left alone');
});

test('food logged without a time gets the time where the person is, not the server clock', async () => {
  const { store, call } = setup();
  const zone = 'Pacific/Kiritimati';
  store.setZone(zone);
  const clock = () => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const before = clock();
  const res = await call('POST', `/api/health/food?date=${dateInZone(nowIso(), zone)}`, { items: [{ name: 'Kaya toast', kcal: 300 }] });
  assert.equal(res.status, 201);
  const entry = ((await res.json()) as { today: { entries: { time: string }[] } }).today.entries[0]!;
  assert.ok([before, clock()].includes(entry.time), `${entry.time} is ${zone} time`);
});

const body = (req: IncomingMessage) => new Promise<string>((ok) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => ok(raw));
});

test('the Gravl sync asks for the person\'s today, not the server\'s', async () => {
  const http = createServer(async (req, res) => {
    const s = new Server({ name: 'fake-gravl', version: '1.0.0' }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'get_food_log', description: 'Food', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] }));
    s.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: 'text', text: `called ${r.params.name} with ${JSON.stringify(r.params.arguments)}` }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await s.connect(t);
    const raw = await body(req);
    await t.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  servers.push(http);
  await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
  const { store, call } = setup();
  await call('POST', '/api/mcp/servers', { name: 'Gravl', url: `http://localhost:${(http.address() as AddressInfo).port}/mcp` });
  const model = await fakeModel([{ sse: anthropicMessage([{ type: 'text', text: JSON.stringify({ food: [], workouts: [], body: [] }) }], 'end_turn') }]);
  store.addConnection({ provider: 'anthropic', baseUrl: model.url, apiKey: 'k' });
  const zone = 'Pacific/Kiritimati';
  store.setZone(zone);
  const today = dateInZone(nowIso(), zone);
  await syncGravl(store);
  const sent = model.seen[0]!.body;
  assert.match(JSON.stringify(sent), new RegExp(`Today is ${today}`));
  assert.match(sent.messages[0].content as string, new RegExp(`called get_food_log with \\{"date":"${today}"`));
});
