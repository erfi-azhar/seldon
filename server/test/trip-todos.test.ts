import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSnapshot } from '../src/agent/prompt.ts';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { addSegment, createTrip, getTrip, listTrips } from '../src/features/travel.ts';
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

test('an option’s flights can be changed: resolved again, and no longer marked as added', async () => {
  const { store } = setup();
  const trip = createTrip(store, { title: 'São Paulo', purpose: 'work', startDate: '2026-11-29', endDate: '2026-12-12' });
  const { addOption, chooseOption, updateOption } = await import('../src/features/travel.ts');
  const o = addOption(store, trip.id, { title: 'Via Frankfurt', legs: [{ carrier: 'SQ', number: '893', fromCode: 'HKG', toCode: 'SIN', startLocal: '2026-11-28T15:40', endLocal: '2026-11-28T19:25' }] });
  chooseOption(store, o.id);
  const changed = updateOption(store, o.id, { legs: [{ carrier: 'ZH', number: '229', fromCode: 'SZX', toCode: 'SIN', startLocal: '2026-11-28T13:55', endLocal: '2026-11-28T18:00' }] });
  assert.equal(changed.legs[0]!.fromCity, 'Shenzhen');
  assert.equal(changed.legs[0]!.startUtc, '2026-11-28T05:55:00.000Z');
  assert.equal(changed.chosenAt, null);
  assert.equal(updateOption(store, o.id, { title: 'Via Frankfurt, from Shenzhen' }).legs[0]!.number, '229', 'other edits keep the legs');
});

test('option legs carry their distance in miles, and choosing skips a flight already booked on any trip', async () => {
  const { store } = setup();
  const { addOption, chooseOption } = await import('../src/features/travel.ts');
  const szx = createTrip(store, { title: 'Shenzhen', purpose: 'work', startDate: '2026-11-24', endDate: '2026-11-29' });
  addSegment(store, szx.id, { kind: 'flight', carrier: 'SQ', number: '857', fromCode: 'SZX', toCode: 'SIN', startLocal: '2026-11-29T00:05', endLocal: '2026-11-29T04:20' });
  const gru = createTrip(store, { title: 'São Paulo', purpose: 'work', startDate: '2026-11-29', endDate: '2026-12-12' });
  const o = addOption(store, gru.id, {
    title: 'Sunday via Frankfurt',
    legs: [
      { carrier: 'SQ', number: '857', fromCode: 'SZX', toCode: 'SIN', startLocal: '2026-11-29T00:05', endLocal: '2026-11-29T04:20' },
      { carrier: 'SQ', number: '326', fromCode: 'SIN', toCode: 'FRA', startLocal: '2026-11-29T12:50', endLocal: '2026-11-29T19:25' },
      { carrier: 'LH', number: '506', fromCode: 'FRA', toCode: 'GRU', startLocal: '2026-11-29T21:55', endLocal: '2026-11-30T06:00' },
    ],
  });
  const miles = o.legs.map((l) => l.miles);
  assert.ok(miles[0]! > 1550 && miles[0]! < 1650, `SZX–SIN ≈ 1,610 mi, got ${miles[0]}`);
  assert.ok(miles[1]! > 6300 && miles[1]! < 6450, `SIN–FRA ≈ 6,380 mi, got ${miles[1]}`);
  assert.ok(miles[2]! > 6000 && miles[2]! < 6200, `FRA–GRU ≈ 6,100 mi, got ${miles[2]}`);
  const t = chooseOption(store, o.id);
  assert.deepEqual(t.segments.map((s) => `${s.carrier}${s.number}`), ['SQ326', 'LH506'], 'SQ857 stays on the Shenzhen trip');
  assert.equal(getTrip(store, szx.id).segments.length, 1);
});

test('choosing an option can be taken back: its planned flights come off and the trip’s dates return', async () => {
  const { store } = setup();
  const { addOption, chooseOption, unchooseOption } = await import('../src/features/travel.ts');
  const gru = createTrip(store, { title: 'São Paulo', purpose: 'work', startDate: '2026-11-29', endDate: '2026-12-12' });
  const legs = (day: string) => [
    { carrier: 'SQ', number: '326', fromCode: 'SIN', toCode: 'FRA', startLocal: `2026-11-${day}T12:50`, endLocal: `2026-11-${day}T19:25` },
    { carrier: 'LH', number: '506', fromCode: 'FRA', toCode: 'GRU', startLocal: `2026-11-${day}T21:55`, endLocal: `2026-11-${Number(day) + 1}T06:00` },
  ];
  const sat = addOption(store, gru.id, { title: 'Saturday via Frankfurt', legs: legs('28') });
  const satBiz = addOption(store, gru.id, { title: 'Saturday via Frankfurt', legs: legs('28').map((l) => ({ ...l, cabin: 'business' as const })) });
  chooseOption(store, sat.id);
  assert.equal(getTrip(store, gru.id).startDate, '2026-11-28');
  chooseOption(store, satBiz.id); // the same flights: nothing new added
  assert.equal(getTrip(store, gru.id).segments.length, 2);

  // Another chosen option still flies them, so they stay.
  unchooseOption(store, sat.id);
  assert.equal(getTrip(store, gru.id).segments.length, 2);
  assert.equal(getTrip(store, gru.id).options.find((o) => o.id === sat.id)!.chosenAt, null);

  // Chose them back and take both off: flights gone, dates back.
  chooseOption(store, sat.id);
  unchooseOption(store, satBiz.id);
  unchooseOption(store, sat.id);
  const t = getTrip(store, gru.id);
  assert.equal(t.segments.length, 0);
  assert.equal(t.startDate, '2026-11-29');
  assert.ok(t.options.every((o) => !o.chosenAt));
});

test('an option chosen before additions were recorded still comes off, matched by its flights', async () => {
  const { store } = setup();
  const { addOption, chooseOption, unchooseOption } = await import('../src/features/travel.ts');
  const gru = createTrip(store, { title: 'São Paulo', purpose: 'work', startDate: '2026-11-29', endDate: '2026-12-12' });
  addSegment(store, gru.id, { kind: 'flight', carrier: 'TK', number: '15', fromCode: 'IST', toCode: 'GRU', startLocal: '2026-11-29T21:00', endLocal: '2026-11-30T05:10' });
  const o = addOption(store, gru.id, { title: 'Sunday via Frankfurt', legs: [{ carrier: 'SQ', number: '326', fromCode: 'SIN', toCode: 'FRA', startLocal: '2026-11-29T12:50', endLocal: '2026-11-29T19:25' }] });
  chooseOption(store, o.id);
  store.db.prepare("UPDATE trip_options SET added = '{}' WHERE id = ?").run(o.id); // as saved before this change
  unchooseOption(store, o.id);
  assert.deepEqual(getTrip(store, gru.id).segments.map((s) => `${s.carrier}${s.number}`), ['TK15'], 'only the planned flight goes; a flight added by hand stays');
});

test('hotel options: listed nearest first, one recommended, and choosing puts a planned stay on the trip once', async () => {
  const { db, store } = setup();
  const app = createApp({ db });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://localhost/api${path}?date=${DAY}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as any };
  };
  const trip = createTrip(store, { title: 'São Paulo', purpose: 'work', startDate: '2026-11-29', endDate: '2026-12-12' });
  addSegment(store, trip.id, { kind: 'flight', carrier: 'LH', number: '506', fromCode: 'FRA', toCode: 'GRU', startLocal: '2026-11-28T21:55', endLocal: '2026-11-29T06:00' });
  const add = (body: object) => call('POST', `/travel/trips/${trip.id}/stay-options`, body);
  assert.equal((await add({ name: 'JW Marriott São Paulo', brand: 'Marriott', distanceKm: 4.5, distanceFrom: 'the office' })).status, 201);
  await add({ name: 'The Westin São Paulo', brand: 'Marriott', distanceKm: 1.3, distanceFrom: 'the office', gettingThere: '15–18 min walk', recommended: true, notes: ['Where the team stayed'] });
  await add({ name: 'Somewhere unmeasured' });
  const last = await add({ name: 'W São Paulo', brand: 'Marriott', distanceKm: 1, distanceFrom: 'the office', recommended: true });
  assert.equal((await add({ name: '' })).status, 400);

  let t = (last.json as TravelState).trips.find((x) => x.id === trip.id)!;
  assert.deepEqual(t.stayOptions.map((o) => o.name), ['W São Paulo', 'The Westin São Paulo', 'JW Marriott São Paulo', 'Somewhere unmeasured'], 'nearest first, unmeasured last');
  assert.deepEqual(t.stayOptions.filter((o) => o.recommended).map((o) => o.name), ['W São Paulo'], 'only the newest recommendation stands');
  assert.match(renderSnapshot(store, DAY), /Hotel option \[\w+\] W São Paulo \(recommended\): 1 km to the office/);

  const westin = t.stayOptions[1]!;
  t = ((await call('POST', `/travel/stay-options/${westin.id}/choose`)).json as TravelState).trips.find((x) => x.id === trip.id)!;
  const stay = t.segments.find((s) => s.kind === 'stay')!;
  assert.equal(stay.title, 'The Westin São Paulo');
  assert.equal(stay.startLocal, '2026-11-29T15:00');
  assert.equal(stay.endLocal, '2026-12-12T12:00');
  assert.equal(stay.startTz, 'America/Sao_Paulo', 'the zone comes from the flight that lands there');
  assert.match(stay.notes, /not booked yet/);
  assert.ok(t.stayOptions.find((o) => o.id === westin.id)!.chosenAt);
  await call('POST', `/travel/stay-options/${westin.id}/choose`);
  assert.equal(getTrip(store, trip.id).segments.filter((s) => s.kind === 'stay').length, 1, 'choosing again adds nothing twice');

  t = ((await call('POST', `/travel/stay-options/${westin.id}/unchoose`)).json as TravelState).trips.find((x) => x.id === trip.id)!;
  assert.equal(t.segments.filter((s) => s.kind === 'stay').length, 0, 'taking it back removes the planned stay');
  assert.equal(t.stayOptions.find((o) => o.id === westin.id)!.chosenAt, null);
  addSegment(store, trip.id, { kind: 'stay', title: 'The Westin São Paulo', startLocal: '2026-11-29T15:00', endLocal: '2026-12-12T12:00' });
  await call('POST', `/travel/stay-options/${westin.id}/choose`);
  await call('POST', `/travel/stay-options/${westin.id}/unchoose`);
  assert.equal(getTrip(store, trip.id).segments.filter((s) => s.kind === 'stay').length, 1, 'a stay booked by hand is not taken off');

  const edited = (await call('PATCH', `/travel/stay-options/${westin.id}`, { distanceKm: 0.8 })).json as TravelState;
  assert.equal(edited.trips.find((x) => x.id === trip.id)!.stayOptions[0]!.name, 'The Westin São Paulo', 'a new distance re-sorts');
  assert.equal((await call('DELETE', `/travel/stay-options/${westin.id}`)).status, 200);
  assert.equal(getTrip(store, trip.id).stayOptions.length, 3);
});
