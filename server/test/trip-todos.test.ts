import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSnapshot } from '../src/agent/prompt.ts';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { createTrip, getTrip, listTrips } from '../src/features/travel.ts';
import { Store } from '../src/store.ts';
import type { TravelState } from '../../shared/types.ts';

const DAY = '2026-11-14';

function setup() {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['travels', 'work'] });
  return { db, store };
}

test('a to-do can belong to a trip: it shows with the trip, in the trip’s sphere, and outlives it', () => {
  const { store } = setup();
  const work = createTrip(store, { title: 'São Paulo', purpose: 'work', startDate: '2026-11-29', endDate: '2026-12-12' });
  const leisure = createTrip(store, { title: 'Bali', purpose: 'leisure', startDate: '2027-01-10', endDate: '2027-01-14' });
  const sphere = (key: string) => store.listSpheres().find((s) => s.key === key)!.id;

  const book = store.createTask({ title: 'Book the hotel', tripId: work.id, dueDate: '2026-11-20' });
  const visa = store.createTask({ title: 'Check entry rules', tripId: work.id, dueDate: '2026-11-17' });
  const villa = store.createTask({ title: 'Book a villa', tripId: leisure.id });
  store.createTask({ title: 'Unrelated', sphereId: sphere('work') });
  assert.equal(book.sphereId, sphere('work'), 'a work trip’s to-do lands in Work');
  assert.equal(villa.sphereId, sphere('travels'), 'a leisure trip’s to-do lands in Travels');

  store.updateTask(book.id, { done: true });
  const trip = getTrip(store, work.id);
  assert.deepEqual(trip.todos.map((t) => t.title), ['Check entry rules', 'Book the hotel'], 'open first, by due date; then done');
  assert.equal(listTrips(store, DAY).find((t) => t.id === leisure.id)!.todos.length, 1);

  // Moved to another trip, then detached.
  assert.equal(store.updateTask(villa.id, { tripId: work.id }).tripId, work.id);
  assert.equal(store.updateTask(villa.id, { tripId: null }).tripId, null);
  assert.throws(() => store.createTask({ title: 'x', tripId: 'nope' }), /Trip/);

  // A deleted trip leaves its to-dos in place, unattached.
  store.db.prepare('DELETE FROM trips WHERE id = ?').run(work.id);
  assert.equal(store.getTask(visa.id).tripId, null);
});

test('Seldon sees each trip’s open to-dos and can attach one with create_task', async () => {
  const { store } = setup();
  const trip = createTrip(store, { title: 'Shenzhen', purpose: 'work', startDate: '2026-11-24', endDate: '2026-11-29' });
  store.createTask({ title: 'Set up Alipay', tripId: trip.id, dueDate: '2026-11-21' });
  const snap = renderSnapshot(store, DAY);
  assert.match(snap, /Trip \[\w+\] Shenzhen \(work\), 2026-11-24 to 2026-11-29: 0 bookings, 0 plan items, 1 open to-dos\./);
  assert.match(snap, /To-do \[\w+\] Set up Alipay \(due 2026-11-21\)/);
});

test('the API takes a trip on tasks, travel state carries the to-dos, and export/import keeps the link', async () => {
  const { db, store } = setup();
  const app = createApp({ db });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://localhost/api${path}?date=${DAY}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as any };
  };
  const trip = createTrip(store, { title: 'Shenzhen', purpose: 'work', startDate: '2026-11-24', endDate: '2026-11-29' });
  const made = await call('POST', '/tasks', { title: 'Online check-in for SQ856', tripId: trip.id, dueDate: '2026-11-22' });
  assert.equal(made.status, 201);
  assert.equal(made.json.tripId, trip.id);
  const loose = await call('POST', '/tasks', { title: 'Buy an eSIM' });
  assert.equal((await call('PATCH', `/tasks/${loose.json.id}`, { tripId: trip.id })).json.tripId, trip.id);
  assert.equal((await call('POST', '/tasks', { title: 'x', tripId: 'missing' })).status, 404);

  const state = (await call('GET', '/travel')).json as TravelState;
  assert.deepEqual(state.trips[0]!.todos.map((t) => t.title).sort(), ['Buy an eSIM', 'Online check-in for SQ856']);

  // Tasks are restored before trips; the link survives.
  const dump = store.exportAll();
  store.importAll(dump);
  assert.equal(getTrip(store, trip.id).todos.length, 2);
});

test('flight options: legs resolved like bookings, shown on the trip, and chosen into planned flights', async () => {
  const { db, store } = setup();
  const app = createApp({ db });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://localhost/api${path}?date=${DAY}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as any };
  };
  const trip = createTrip(store, { title: 'São Paulo', purpose: 'work', startDate: '2026-11-29', endDate: '2026-12-12' });
  const made = await call('POST', `/travel/trips/${trip.id}/options`, {
    title: 'Via Johannesburg',
    recommended: true,
    notes: ['Confirm LA8059 flies that Sunday.'],
    legs: [
      { carrier: 'SQ', number: '893', fromCode: 'HKG', toCode: 'SIN', startLocal: '2026-11-28T15:40', endLocal: '2026-11-28T19:25' },
      { carrier: 'SQ', number: '478', fromCode: 'SIN', toCode: 'JNB', startLocal: '2026-11-29T01:15', endLocal: '2026-11-29T06:10' },
      { carrier: 'LA', number: '8059', fromCode: 'JNB', toCode: 'GRU', startLocal: '2026-11-29T15:05', endLocal: '2026-11-29T20:35' },
    ],
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const opt = (made.json as TravelState).trips[0]!.options[0]!;
  assert.equal(opt.recommended, true);
  assert.equal(opt.legs[0]!.fromCity, 'Hong Kong');
  assert.equal(opt.legs[2]!.toCity, 'São Paulo');
  assert.equal(opt.legs[0]!.startUtc, '2026-11-28T07:40:00.000Z', 'local times read in each airport’s zone');
  assert.equal(opt.legs[2]!.endUtc, '2026-11-29T23:35:00.000Z');
  assert.match(renderSnapshot(store, DAY), /Option \[\w+\] Via Johannesburg \(recommended\): SQ893 HKG-SIN 2026-11-28 15:40/);

  const chosen = (await call('POST', `/travel/options/${opt.id}/choose`)).json as TravelState;
  const t = chosen.trips.find((x) => x.id === trip.id)!;
  assert.deepEqual(t.segments.map((s) => `${s.carrier}${s.number}`), ['SQ893', 'SQ478', 'LA8059']);
  assert.match(t.segments[0]!.notes, /not booked yet/);
  assert.ok(t.options[0]!.chosenAt);
  assert.equal(t.startDate, '2026-11-28', 'the trip stretches to the first flight');

  assert.equal((await call('DELETE', `/travel/options/${opt.id}`)).status, 200);
  assert.equal(getTrip(store, trip.id).options.length, 0);
});
