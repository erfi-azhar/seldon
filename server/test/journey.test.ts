import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeJourney, journeyNotices, journeys } from '../../shared/journey.ts';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { recordLocation, sendDueNotices, setPushSender, tripTrack } from '../src/features/journey.ts';
import { addSegment, createTrip, getTrip } from '../src/features/travel.ts';
import { Store } from '../src/store.ts';
import { anthropicMessage, fakeModel } from './helpers.ts';

function journeyStore(): Store {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['travels'] });
  return store;
}

/** SQ 326 Singapore → Frankfurt, then LH 506 on to São Paulo: one journey with a connection. */
function brazil(store: Store) {
  const trip = createTrip(store, { title: 'São Paulo', destination: 'São Paulo', startDate: '2026-11-29', endDate: '2026-12-12', purpose: 'work' });
  addSegment(store, trip.id, { kind: 'flight', carrier: 'SQ', number: '326', fromCode: 'SIN', toCode: 'FRA', startLocal: '2026-11-29T12:50', endLocal: '2026-11-29T19:25' });
  addSegment(store, trip.id, { kind: 'flight', carrier: 'LH', number: '506', fromCode: 'FRA', toCode: 'GRU', startLocal: '2026-11-29T21:55', endLocal: '2026-11-30T06:00' });
  return getTrip(store, trip.id);
}

test('a travel day runs before you leave, at the airport, in each flight and connection, then arrived', () => {
  const store = journeyStore();
  const trip = brazil(store);
  const [chain] = journeys(trip.segments);
  assert.equal(chain!.length, 2, 'the two flights connect');
  // An unrelated flight in between (the same day, elsewhere) doesn't break the chain.
  const other = { ...trip.segments[0]!, id: 'other', fromCode: 'SZX', toCode: 'SIN', startUtc: '2026-11-29T16:05:00.000Z', endUtc: '2026-11-29T20:20:00.000Z' };
  assert.deepEqual(journeys([...trip.segments, other]).map((j) => j.map((f) => f.id === 'other' ? 'other' : f.number)), [['326', '506'], ['other']]);

  const at = (iso: string) => Date.parse(iso);
  assert.equal(activeJourney(trip.segments, at('2026-11-27T00:00:00Z')), null, 'two days out it is not under way yet');
  const morning = activeJourney(trip.segments, at('2026-11-29T01:00:00Z'))!; // 09:00 in Singapore
  assert.deepEqual(morning.phases.map((p) => p.kind), ['before', 'airport', 'flight', 'connection', 'flight', 'arrived']);
  assert.equal(morning.current, -1, 'before it is time to set off');
  // SQ 326 leaves 12:50 Singapore (04:50Z): be at Changi 2h30 before, set off an hour before that.
  assert.equal(morning.phases[1]!.at, '2026-11-29T02:20:00.000Z');
  assert.equal(morning.phases[0]!.at, '2026-11-29T01:20:00.000Z');
  assert.equal(activeJourney(trip.segments, at('2026-11-29T10:00:00Z'))!.phases[activeJourney(trip.segments, at('2026-11-29T10:00:00Z'))!.current]!.kind, 'flight');
  const frankfurt = activeJourney(trip.segments, at('2026-11-29T19:00:00Z'))!;
  assert.equal(frankfurt.phases[frankfurt.current]!.label, 'Connecting in Frankfurt');
  assert.equal(activeJourney(trip.segments, at('2026-11-30T16:00:00Z')), null, 'well after landing it is over');
});

test('the notifications: leave, boarding for each flight, landing on the way, arrival; each once and never stale', async () => {
  const store = journeyStore();
  const trip = brazil(store);
  const notices = journeyNotices(journeys(trip.segments)[0]!);
  assert.deepEqual(
    notices.map((n) => n.key.split(':')[1]),
    ['leave', 'boarding', 'landed', 'boarding', 'arrived'],
  );
  assert.match(notices[0]!.title, /^Leave for Singapore airport by 09:20$/);
  assert.match(notices[2]!.title, /^Landed in Frankfurt: 2h 30m until LH 506$/);

  const sent: string[] = [];
  setPushSender(async (_sub, payload) => void sent.push(JSON.parse(payload).title));
  try {
    assert.deepEqual(await sendDueNotices(store, new Date('2026-11-29T01:10:00Z')), [], 'nothing goes out with no device subscribed');
    store.db.prepare("INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, created_at) VALUES ('d', 'https://push.example/1', 'k', 'a', 'Phone', '')").run();
    await sendDueNotices(store, new Date('2026-11-29T01:10:00Z'));
    assert.deepEqual(sent, ['Leave for Singapore airport by 09:20']);
    await sendDueNotices(store, new Date('2026-11-29T01:20:00Z'));
    assert.equal(sent.length, 1, 'sent once');
    // Boarding is 45 min before a long flight (04:05Z), announced 15 min earlier; asleep until long after, it stays quiet.
    await sendDueNotices(store, new Date('2026-11-29T06:00:00Z'));
    assert.equal(sent.length, 1, 'a notice more than 45 minutes late is dropped');
    await sendDueNotices(store, new Date('2026-11-29T18:40:00Z'));
    assert.deepEqual(sent.slice(1), ['Landed in Frankfurt: 2h 30m until LH 506']);
  } finally {
    setPushSender(null);
  }
});

test('locations are kept only while a trip is on, thinned, and grouped by day', () => {
  const store = journeyStore();
  const trip = brazil(store);
  const loc = (iso: string, lat: number, lon: number) => ({ _type: 'location', lat, lon, tst: Date.parse(iso) / 1000, acc: 10 });
  assert.equal(recordLocation(store, loc('2026-11-20T08:00:00Z', 1.3, 103.8)), 'no-trip', 'at home, nothing is recorded');
  assert.equal(recordLocation(store, { _type: 'transition' }), 'ignored');
  assert.equal(recordLocation(store, loc('2026-11-30T12:00:00Z', -23.5874, -46.6811)), 'kept');
  assert.equal(recordLocation(store, loc('2026-11-30T12:02:00Z', -23.58741, -46.68111)), 'skipped', 'standing still');
  assert.equal(recordLocation(store, loc('2026-11-30T12:30:00Z', -23.5613, -46.6565)), 'kept');
  const track = tripTrack(store, trip.id);
  assert.equal(track.points, 2);
  assert.equal(track.days.length, 1);
  assert.ok(track.days[0]!.km > 3 && track.days[0]!.km < 5, `about 3.8 km across São Paulo, got ${track.days[0]!.km}`);
});

test('over HTTP: OwnTracks posts with its own key and nothing else; the key opens no other door', async () => {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.onboard({ userName: '', agentName: 'Seldon', sphereKeys: ['travels'] });
  const trip = brazil(store);
  const app = createApp({ db, passphrase: 'pw' });
  const login = await app.request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'pw' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const { key } = (await (await app.request('http://localhost/api/journey/tracking/key', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).json()) as { key: string };
  assert.match(key, /^tt_/);

  const basic = (password: string) => `Basic ${Buffer.from(`terminus:${password}`).toString('base64')}`;
  const body = JSON.stringify({ _type: 'location', lat: -23.5874, lon: -46.6811, tst: Date.parse('2026-11-30T12:00:00Z') / 1000 });
  const post = (headers: Record<string, string>) => app.request('http://localhost/api/journey/owntracks', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: basic('tt_wrong') })).status, 401);
  const ok = await post({ authorization: basic(key) });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), [], 'OwnTracks expects an array back');
  assert.equal(tripTrack(store, trip.id).points, 1);
  assert.equal((await app.request('http://localhost/api/overview', { headers: { authorization: basic(key) } })).status, 401, 'the key only opens the tracker door');

  // Turning tracking off retires the key.
  await app.request('http://localhost/api/journey/tracking/off', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await post({ authorization: basic(key) })).status, 401);
});

test('a long layover is about time outside: Frankfurt’s 11 hours is worth going out for, Istanbul’s 3 is not, home is home', async () => {
  const { layoverPlan } = await import('../../web/src/layover.ts');
  const store = journeyStore();
  const trip = createTrip(store, { title: 'Home', destination: 'Singapore', startDate: '2026-12-11', endDate: '2026-12-13', purpose: 'work' });
  addSegment(store, trip.id, { kind: 'flight', carrier: 'LH', number: '507', fromCode: 'GRU', toCode: 'FRA', startLocal: '2026-12-11T18:10', endLocal: '2026-12-12T10:45' });
  addSegment(store, trip.id, { kind: 'flight', carrier: 'SQ', number: '325', fromCode: 'FRA', toCode: 'SIN', startLocal: '2026-12-12T21:40', endLocal: '2026-12-13T17:00' });
  const [lh, sq] = getTrip(store, trip.id).segments;
  const fra = layoverPlan(lh!, sq!, 'SIN');
  assert.equal(fra.wait, 655);
  // Out 45 min after landing, 15 min each way on the S-Bahn, back two hours before: 7h40 in town.
  assert.equal(fra.free, 460);
  assert.equal(fra.verdict, 'out');
  assert.ok(fra.ideas.some((i) => /Christmas/.test(i.title)), 'the Christmas market is on in mid-December');

  const ist = createTrip(store, { title: 'Via Istanbul', destination: 'Singapore', startDate: '2026-12-12', endDate: '2026-12-13', purpose: 'work' });
  addSegment(store, ist.id, { kind: 'flight', carrier: 'TK', number: '16', fromCode: 'GRU', toCode: 'IST', startLocal: '2026-12-12T04:10', endLocal: '2026-12-12T22:40' });
  addSegment(store, ist.id, { kind: 'flight', carrier: 'TK', number: '54', fromCode: 'IST', toCode: 'SIN', startLocal: '2026-12-13T01:55', endLocal: '2026-12-13T17:55' });
  const [tk16, tk54] = getTrip(store, ist.id).segments;
  assert.equal(layoverPlan(tk16!, tk54!, 'SIN').verdict, 'stay');

  const sz = createTrip(store, { title: 'Through home', destination: 'Frankfurt', startDate: '2026-11-28', endDate: '2026-11-28', purpose: 'work' });
  addSegment(store, sz.id, { kind: 'flight', carrier: 'SQ', number: '857', fromCode: 'SZX', toCode: 'SIN', startLocal: '2026-11-28T00:05', endLocal: '2026-11-28T04:20' });
  addSegment(store, sz.id, { kind: 'flight', carrier: 'SQ', number: '326', fromCode: 'SIN', toCode: 'FRA', startLocal: '2026-11-28T12:50', endLocal: '2026-11-28T19:25' });
  const [a, b] = getTrip(store, sz.id).segments;
  const sin = layoverPlan(a!, b!, 'SIN');
  assert.equal(sin.atHome, true);
  assert.equal(sin.verdict, 'out', '8½ hours at home airport: time to go home');
});

test('plan items carry the way there: stored, kept through other edits, dropped when empty', async () => {
  const { addItems, updateItem } = await import('../src/features/travel.ts');
  const store = journeyStore();
  const trip = brazil(store);
  const route = { from: 'Frankfurt Airport, Terminal 1', mode: 'transit' as const, minutes: 20, steps: ['S8 or S9 towards Hanau or Offenbach from the regional station under Terminal 1', 'Get off at Konstablerwache (about 15 min)', 'Walk 3 min to Schwedenkronenplatz'] };
  const [item] = addItems(store, trip.id, [{ date: '2026-12-12', time: '12:00', title: 'Metropol Sauna', place: 'Schwedenkronenplatz', route }]);
  assert.deepEqual(item!.route, route);
  assert.deepEqual(updateItem(store, item!.id, { notes: 'Check the hours' }).route, route, 'other edits keep the route');
  assert.equal(updateItem(store, item!.id, { route: { ...route, minutes: 0 } }).route, null, 'a route of no minutes is no route');
  assert.equal(getTrip(store, trip.id).itinerary[0]!.route, null);
  const details = [
    { kind: 'hours' as const, label: 'Hours unconfirmed', text: 'Check before going.' },
    { kind: 'heads-up' as const, label: 'Bags', text: 'Left luggage in Terminal 1.', url: 'javascript:alert(1)' },
    { kind: 'tip' as const, label: '', text: '' },
  ];
  const withDetails = updateItem(store, item!.id, { details });
  assert.equal(withDetails.details.length, 2, 'empty modules are dropped');
  assert.equal(withDetails.details[1]!.url, undefined, 'only https links are kept');
});

test('stops added without their route and details get them filled in, once each; online ones are left alone', async () => {
  const { addItems, completeItinerary } = await import('../src/features/travel.ts');
  const store = journeyStore();
  const trip = brazil(store);
  const [masp, , done] = addItems(store, trip.id, [
    { date: '2026-12-05', time: '10:00', title: 'MASP', place: 'MASP, Av. Paulista 1578' },
    { date: '2026-12-05', time: '23:00', title: 'Daily sync with Beijing', place: 'Online' },
    { date: '2026-12-05', time: '12:00', title: 'Already planned', place: 'Somewhere', details: [{ kind: 'tip', label: 'Known', text: 'x' }] },
  ]);
  const reply = (obj: unknown) => ({ sse: anthropicMessage([{ type: 'text', text: JSON.stringify(obj) }], 'end_turn') });
  const answer = { items: [{ id: masp!.id, route: { from: 'The hotel', mode: 'transit', minutes: 25, steps: ['Line 4 to Paulista', 'Line 2 to Trianon-MASP'] }, details: [{ kind: 'hours', label: 'Open 10:00–18:00', text: 'Free on Tuesdays.' }] }] };
  const model = await fakeModel([reply(answer)]);
  store.addConnection({ provider: 'anthropic', baseUrl: model.url, apiKey: 'k' });
  assert.equal(await completeItinerary(store, trip.id), 1);
  const items = getTrip(store, trip.id).itinerary;
  const got = items.find((i) => i.id === masp!.id)!;
  assert.equal(got.route?.minutes, 25);
  assert.equal(got.details[0]!.label, 'Open 10:00–18:00');
  assert.match(model.seen[0]!.body.messages[0].content, /MASP/);
  assert.doesNotMatch(model.seen[0]!.body.messages[0].content, /Daily sync/, 'online items are not asked about');
  assert.doesNotMatch(model.seen[0]!.body.messages[0].content, /Already planned/, 'items with details are left alone');
  assert.equal(items.find((i) => i.id === done!.id)!.details[0]!.label, 'Known');
  assert.equal(await completeItinerary(store, trip.id), 0, 'nothing left to ask about');
  assert.equal(model.seen.length, 1);
});
