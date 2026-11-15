import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSnapshot } from '../src/agent/prompt.ts';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { zonedToUtc } from '../src/features/airports.ts';
import { checkMail, setMailSource, type MailSource } from '../src/features/gmail.ts';
import { updateIntegration } from '../src/features/integrations.ts';
import { loungeAccess, stayPerks } from '../src/features/lounges.ts';
import type { MailMessage } from '../src/features/mail-types.ts';
import { listSignals } from '../src/features/signals.ts';
import { addSegment, applyExtraction, createTrip, getTrip, listLoyalty, prepareTravel, saveGuide, travelContext, upsertLoyalty, type Extracted } from '../src/features/travel.ts';
import { Store } from '../src/store.ts';
import type { LoyaltyAccount, Segment, TravelState } from '../../shared/types.ts';
import { anthropicMessage, fakeModel } from './helpers.ts';

const DAY = '2026-11-14';

function travelStore(): Store {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['travels', 'work'] });
  return store;
}

const reply = (obj: unknown) => ({ sse: anthropicMessage([{ type: 'text', text: JSON.stringify(obj) }], 'end_turn') });

const flight = (over: Partial<Segment> = {}): Segment => ({
  id: 's',
  tripId: null,
  kind: 'flight',
  title: '',
  carrier: 'SQ',
  number: '638',
  fromCode: 'SIN',
  fromName: '',
  toCode: 'HND',
  toName: '',
  startLocal: '2026-12-01T09:40',
  startTz: 'Asia/Singapore',
  endLocal: '2026-12-01T17:35',
  endTz: 'Asia/Tokyo',
  startUtc: '2026-12-01T01:40:00.000Z',
  endUtc: '2026-12-01T08:35:00.000Z',
  cabin: 'Economy',
  seat: '',
  confirmation: '',
  fromTerminal: '',
  toTerminal: '',
  address: '',
  notes: '',
  source: 'manual',
  lounges: [],
  perks: [],
  ...over,
});
const account = (program: string, tier: string, kind: LoyaltyAccount['kind'] = 'airline'): LoyaltyAccount => ({ id: program, program, kind, tier, points: null, progress: null, progressTarget: null, progressLabel: '', expires: null, memberSuffix: '', updatedAt: '', source: 'manual' });

test('local times in a zone become the right instants, across daylight saving', () => {
  assert.equal(zonedToUtc('2026-12-01T09:40', 'Asia/Singapore').toISOString(), '2026-12-01T01:40:00.000Z');
  assert.equal(zonedToUtc('2026-07-01T09:00', 'Europe/London').toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-01T09:00', 'Europe/London').toISOString(), '2026-12-01T09:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-01T09:00', 'Not/AZone').toISOString(), '2026-12-01T09:00:00.000Z', 'an unknown zone falls back to UTC');
});

test('lounge eligibility follows the cabin, KrisFlyer tier and alliance; hotel perks follow the Bonvoy tier', () => {
  assert.deepEqual(loungeAccess(flight({ cabin: 'Business' }), []).map((l) => l.access), ['SilverKris Lounge, Business Class (Changi)']);
  assert.deepEqual(loungeAccess(flight({ cabin: 'Suites' }), [])[0]!.access, 'The Private Room, SilverKris Lounge (Changi T3)');
  assert.deepEqual(loungeAccess(flight(), []), [], 'economy with no status gets nothing');
  assert.match(loungeAccess(flight(), [account('KrisFlyer', 'Elite Gold')])[0]!.access, /KrisFlyer Gold Lounge/);
  assert.match(loungeAccess(flight({ carrier: 'LH', fromCode: 'FRA' }), [account('KrisFlyer', 'Elite Gold')])[0]!.access, /Star Alliance Gold/);
  assert.deepEqual(loungeAccess(flight({ carrier: 'TR' }), [account('KrisFlyer', 'Elite Gold')]), [], 'Scoot is not in Star Alliance');
  assert.deepEqual(loungeAccess(flight(), [account('KrisFlyer', 'Elite Silver')]), []);
  const pps = loungeAccess(flight(), [account('KrisFlyer', 'PPS Club'), account('Priority Pass', 'Prestige', 'lounge')]).map((l) => l.access);
  assert.deepEqual(pps, ['SilverKris Lounge, Business Class (Changi)', 'Star Alliance Gold lounges, plus one guest', 'Priority Pass lounges in your terminal']);
  assert.match(loungeAccess(flight(), [account('KrisFlyer', 'Solitaire PPS Club')])[0]!.access, /First Class section/);
  const revolut = loungeAccess(flight({ carrier: 'LH', fromCode: 'FRA' }), [account('KrisFlyer', 'Elite Silver'), account('Revolut Ultra', 'Ultra', 'lounge')]);
  assert.deepEqual(revolut, [{ access: 'LoungeKey lounges, free for you (guests pay)', basis: 'Revolut Ultra' }], 'Revolut Ultra opens LoungeKey lounges on any fare');

  const stay = flight({ kind: 'stay', title: 'The Westin Tokyo', carrier: '' });
  assert.deepEqual(stayPerks(stay, [account('Marriott Bonvoy', 'Platinum Elite', 'hotel')])[0], 'Executive lounge and breakfast');
  assert.deepEqual(stayPerks(flight({ kind: 'stay', title: 'Park Hyatt Tokyo' }), [account('Marriott Bonvoy', 'Platinum', 'hotel')]), [], 'not a Marriott hotel');
});

test('bookings resolve airports and zones, merge repeats, stretch the trip, and drive travel mode', () => {
  const store = travelStore();
  const trip = createTrip(store, { destination: 'Tokyo', purpose: 'leisure', startDate: '2026-12-01', endDate: '2026-12-05' });
  // Out via Hong Kong, a 3h40m connection.
  const a = addSegment(store, trip.id, { kind: 'flight', carrier: 'SQ', number: '890', fromCode: 'sin', toCode: 'HKG', startLocal: '2026-12-01T07:50', endLocal: '2026-12-01T11:50', cabin: 'Business' });
  assert.equal(a.created, true);
  assert.equal(a.segment.startTz, 'Asia/Singapore');
  assert.equal(a.segment.endTz, 'Asia/Hong_Kong');
  assert.equal(a.segment.fromName, 'Singapore Changi');
  assert.equal(a.segment.title, 'SQ 890');
  assert.match(a.segment.lounges[0]!.access, /SilverKris/);
  addSegment(store, trip.id, { kind: 'flight', carrier: 'NH', number: '860', fromCode: 'HKG', toCode: 'HND', startLocal: '2026-12-01T15:30', endLocal: '2026-12-01T20:30' });
  addSegment(store, trip.id, { kind: 'stay', title: 'The Westin Tokyo', toCode: 'HND', startLocal: '2026-12-01T22:00', endLocal: '2026-12-07T12:00', address: 'Ebisu' });
  const again = addSegment(store, trip.id, { kind: 'flight', carrier: 'SQ', number: '890', fromCode: 'SIN', toCode: 'HKG', startLocal: '2026-12-01T07:50', endLocal: '2026-12-01T11:50', seat: '14A' }, 'gmail', 'x');
  assert.equal(again.created, false, 'the same flight on the same day merges');
  assert.equal(again.segment.seat, '14A', 'and fills in what was missing');
  const t = getTrip(store, trip.id);
  assert.equal(t.segments.length, 3);
  assert.equal(t.endDate, '2026-12-07', 'the stay stretched the trip');

  // The night before: the first flight is within 36 hours.
  const eve = travelContext(store, '2026-11-30', new Date('2026-11-30T12:00:00Z'));
  assert.equal(eve.mode, 'departing');
  assert.equal(eve.flight!.number, '890');
  assert.equal(eve.flight!.departsInMin, 11 * 60 + 50);
  assert.deepEqual(eve.layovers.map((l) => [l.airport, l.hours, l.city]), [['HKG', 3.7, 'Hong Kong']]);

  // Mid-trip: away, day 3, at the Westin.
  const mid = travelContext(store, '2026-12-03', new Date('2026-12-03T03:00:00Z'));
  assert.equal(mid.mode, 'away');
  assert.equal(mid.dayOfTrip, 3);
  assert.equal(mid.tripDays, 7);
  assert.equal(mid.stay!.title, 'The Westin Tokyo');

  // A fortnight out: upcoming.
  assert.equal(travelContext(store, '2026-11-20', new Date('2026-11-20T03:00:00Z')).mode, 'upcoming');
  assert.equal(travelContext(store, '2026-10-01', new Date('2026-10-01T03:00:00Z')).mode, 'none');

  const snap = renderSnapshot(store, '2026-11-30');
  assert.match(snap, /TRAVEL/);
  assert.match(snap, /Trip \[.+\] Tokyo \(leisure\), 2026-12-01 to 2026-12-07: 3 bookings/);

  // Undo of a booking Seldon or the person added removes it.
  const act = store.listActivity().find((x) => /Added NH 860/.test(x.summary))!;
  assert.equal(store.undo(act.id), true);
  assert.equal(getTrip(store, trip.id).segments.length, 2);
});

test('loyalty: one account per programme, only the last four digits of a number, partial updates keep the rest', () => {
  const store = travelStore();
  upsertLoyalty(store, { program: 'Singapore Airlines KrisFlyer', tier: 'Elite Silver', points: 48210.4, progress: 31000, progressTarget: 50000, progressLabel: 'elite miles to Gold', memberSuffix: '8812345678' });
  upsertLoyalty(store, { program: 'KrisFlyer', points: 52000 });
  const [kf] = listLoyalty(store);
  assert.equal(kf!.program, 'KrisFlyer');
  assert.equal(kf!.kind, 'airline');
  assert.equal(kf!.points, 52000);
  assert.equal(kf!.tier, 'Elite Silver');
  assert.equal(kf!.progress, 31000);
  assert.equal(kf!.memberSuffix, '5678');
  assert.equal(listLoyalty(store).length, 1);
});

test('lounge cards are recognised by name: Revolut Ultra and LoungeKey join Priority Pass', () => {
  const store = travelStore();
  const r = upsertLoyalty(store, { program: 'revolut ultra card' });
  assert.equal(r.program, 'Revolut Ultra');
  assert.equal(r.kind, 'lounge');
});

test('a booking read from somewhere makes or joins a trip; a work booking lands in Work', () => {
  const store = travelStore();
  const x: Extracted = {
    kind: 'booking_and_loyalty',
    trip: { destination: 'London', purpose: 'work' },
    segments: [
      { kind: 'flight', title: '', carrier: 'SQ', number: '322', from_code: 'SIN', from_name: '', to_code: 'LHR', to_name: '', start_local: '2026-12-08T23:35', start_tz: null, end_local: '2026-12-09T06:25', end_tz: null, cabin: 'Business', seat: '', confirmation: 'ABC123', address: '' },
      { kind: 'flight', title: '', carrier: 'SQ', number: '317', from_code: 'LHR', from_name: '', to_code: 'SIN', to_name: '', start_local: '2026-12-12T11:30', start_tz: null, end_local: '2026-12-13T07:50', end_tz: null, cabin: 'Business', seat: '', confirmation: 'ABC123', address: '' },
    ],
    loyalty: [{ program: 'KrisFlyer', tier: 'Elite Gold', points: 80000, progress: null, progress_target: null, progress_label: '', expires: null, member_suffix: '1234' }],
  };
  const applied = applyExtraction(store, x, 'gmail', '<b1@sq>');
  assert.equal(applied.segments.length, 2);
  const trip = getTrip(store, applied.trips[0]!);
  assert.deepEqual([trip.title, trip.purpose, trip.startDate, trip.endDate], ['London', 'work', '2026-12-08', '2026-12-13']);
  assert.equal(trip.segments[0]!.endTz, 'Europe/London');
  // The same email again adds nothing; a hotel email for those dates joins the trip.
  assert.equal(applyExtraction(store, x, 'gmail', '<b1@sq>').segments.length, 0);
  const hotel = applyExtraction(store, { kind: 'booking', trip: null, loyalty: [], segments: [{ kind: 'stay', title: 'London Marriott Hotel County Hall', carrier: 'Marriott', number: '', from_code: '', from_name: '', to_code: 'LHR', to_name: '', start_local: '2026-12-09T15:00', start_tz: null, end_local: '2026-12-12T12:00', end_tz: null, cabin: '', seat: '', confirmation: '', address: 'Westminster Bridge Rd' }] }, 'gmail', '<h1@marriott>');
  assert.equal(hotel.trips[0], trip.id);
  assert.equal(getTrip(store, trip.id).segments[1]!.lounges.length, 0);
  assert.match(store.listActivity().find((a) => a.entityType === 'trip')!.summary, /Found a trip in your mail: London/);
  assert.equal(store.listActivity().find((a) => a.entityType === 'trip')!.sphereId, store.listSpheres().find((s) => s.key === 'work')!.id);
  assert.equal(applyExtraction(store, { kind: 'cancellation', trip: null, segments: [], loyalty: [] }, 'gmail', null).cancellation, true);
});

test('travel mail from Gmail is read for bookings; other mail is not sent for extraction', async () => {
  const store = travelStore();
  updateIntegration(store, 'gmail', (r) => {
    r.enabled = true;
    r.settings = { email: 'me@gmail.com', lookbackDays: 3 };
    r.secrets = { appPassword: 'abcdabcdabcdabcd' };
  });
  const mail = (uid: number, over: Partial<MailMessage>): MailMessage => ({ uid, messageId: `<t${uid}@x>`, from: { name: 'X', address: 'x@example.com' }, to: 'me@gmail.com', subject: 'Hello', date: '2026-11-14T01:00:00.000Z', important: false, labels: [], text: 'Hi', ...over });
  const inbox = [mail(1, { from: { name: 'Singapore Airlines', address: 'noreply@singaporeair.com.sg' }, subject: 'Your booking is confirmed', text: 'SQ 638 SIN-HND 1 Dec 09:40' }), mail(2, { subject: 'Lunch?' })];
  setMailSource((): MailSource => ({ verify: async () => undefined, fetchNew: async () => ({ messages: inbox, uidValidity: '1', maxUid: 2 }), saveDraft: async () => undefined }));
  const triage = { messages: inbox.map((m) => ({ uid: m.uid, important: false, priority: 0, category: 'fyi', summary: '', sphere: null, follow_up: { kind: 'none' } })) };
  const extraction = {
    kind: 'booking',
    trip: { destination: 'Tokyo', purpose: null },
    segments: [{ kind: 'flight', title: '', carrier: 'SQ', number: '638', from_code: 'SIN', from_name: '', to_code: 'HND', to_name: '', start_local: '2026-12-01T09:40', start_tz: null, end_local: '2026-12-01T17:35', end_tz: null, cabin: 'Economy', seat: '', confirmation: 'XYZ789', address: '' }],
    loyalty: [],
  };
  const model = await fakeModel([reply(triage), reply(extraction)]);
  store.addConnection({ provider: 'anthropic', baseUrl: model.url, apiKey: 'k' });
  await checkMail(store);
  assert.equal(model.seen.length, 2, 'one triage call and one extraction, for the airline mail only');
  assert.match(model.seen[1]!.body.messages[0].content, /<untrusted source="travel document">\nFrom: Singapore Airlines <noreply@singaporeair\.com\.sg>/);
  const sig = listSignals(store).find((s) => s.source === 'travel')!;
  assert.equal(sig.title, 'Added SQ 638 to Tokyo');
  assert.equal(createdTrips(store), 1);
});

const createdTrips = (store: Store) => (store.db.prepare('SELECT COUNT(*) AS n FROM trips').get() as { n: number }).n;

test('ahead of a trip Seldon drafts the plan and prepares the airport; without a brain the lounge still shows', async () => {
  const store = travelStore();
  upsertLoyalty(store, { program: 'KrisFlyer', tier: 'Elite Gold' });
  const trip = createTrip(store, { destination: 'Tokyo', startDate: '2026-11-15', endDate: '2026-11-16' });
  saveGuide(store, trip.id, [{ name: 'Tokyo', emergency: [], sections: [] }]); // the guide has its own test
  const seg = addSegment(store, trip.id, { kind: 'flight', carrier: 'SQ', number: '638', fromCode: 'SIN', toCode: 'HND', startLocal: '2026-11-15T09:40', endLocal: '2026-11-15T17:35' }).segment;
  const now = new Date('2026-11-14T12:00:00Z');

  // No brain: a flight signal with the rule-based lounge, no plan.
  await prepareTravel(store, now);
  let sig = listSignals(store).find((s) => s.kind === 'flight')!;
  assert.equal(sig.title, 'SQ 638 to Tokyo leaves 09:40');
  assert.match(sig.body, /KrisFlyer Gold Lounge/);
  assert.equal(getTrip(store, trip.id).itinerary.length, 0);

  const companion = {
    lounges: [
      { name: 'Priority Lounge', where: 'Terminal 1, landside', access: 'Revolut Ultra', reachable: false, note: 'Before security' },
      { name: 'KrisFlyer Gold Lounge', where: 'Terminal 3, level 3', access: 'KrisFlyer Elite Gold', reachable: true, note: 'Showers' },
    ],
    plan: ['Jewel’s Rain Vortex is 10 minutes away by Skytrain', 'The prayer room is near gate A1'],
  };
  const plan = {
    items: [
      { date: '2026-11-15', time: '19:30', title: 'Dinner at Halal Ramen Ouka', place: 'Shinjuku', notes: 'Muslim-friendly', kind: 'food' },
      { date: '2026-11-16', time: null, title: 'TeamLab Planets', place: 'Toyosu', notes: '', kind: 'activity' },
      { date: '2026-12-25', time: null, title: 'Out of range', place: '', notes: '', kind: 'activity' },
    ],
  };
  store.db.prepare('DELETE FROM signals').run();
  // The companion, the draft, then filling in the drafted stops' routes and details.
  const model = await fakeModel([reply(companion), reply(plan), reply({ items: [] })]);
  store.addConnection({ provider: 'anthropic', baseUrl: model.url, apiKey: 'k' });
  await prepareTravel(store, now);
  const t = getTrip(store, trip.id);
  assert.deepEqual(t.companion[seg.id]!.plan, companion.plan);
  assert.deepEqual(t.companion[seg.id]!.picks!.map((l) => l.name), ['KrisFlyer Gold Lounge', 'Priority Lounge'], 'lounges you can reach come first');
  assert.equal(t.companion[seg.id]!.lounges[0], 'KrisFlyer Gold Lounge — Terminal 3, level 3 · KrisFlyer Elite Gold');
  assert.match(t.companion[seg.id]!.lounges[1]!, /not on this connection/);
  assert.deepEqual(t.itinerary.map((i) => i.title), ['Dinner at Halal Ramen Ouka', 'TeamLab Planets'], 'items outside the trip are dropped');
  sig = listSignals(store).find((s) => s.kind === 'flight')!;
  assert.match(sig.body, /Terminal 3, level 3/);
  assert.ok(listSignals(store).some((s) => s.kind === 'itinerary'));
  assert.match(model.seen[1]!.body.messages[0].content, /halal|Muslim/i);

  // Running again does not ask the model again, re-draft, or ask about the same stops again.
  await prepareTravel(store, now);
  assert.equal(model.seen.length, 3);

  // The draft is one undoable step; items the person ticked off survive it.
  const done = t.itinerary[0]!;
  store.db.prepare('UPDATE itinerary_items SET done = 1 WHERE id = ?').run(done.id);
  const draft = store.listActivity().find((a) => a.entityType === 'itinerary_draft')!;
  assert.equal(store.undo(draft.id), true);
  assert.deepEqual(getTrip(store, trip.id).itinerary.map((i) => i.id), [done.id]);
});

test('travel API: trips, bookings, a plan you edit, settings; imports need a brain', async () => {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.onboard({ userName: '', agentName: 'Seldon', sphereKeys: ['travels'] });
  const app = createApp({ db });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://localhost/api${path}${path.includes('?') ? '&' : '?'}date=${DAY}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as TravelState & { created?: string; error?: string } };
  };
  const created = await call('POST', '/travel/trips', { title: 'Offsite in KL', purpose: 'work', destination: 'Kuala Lumpur', startDate: '2026-11-20', endDate: '2026-11-21' });
  assert.equal(created.status, 201);
  const id = created.json.created!;
  assert.equal((await call('POST', `/travel/trips/${id}/segments`, { kind: 'flight', carrier: 'SQ', number: '106', fromCode: 'SIN', toCode: 'KUL', startLocal: '2026-11-20T08:00', endLocal: '2026-11-20T09:05', cabin: 'Economy' })).status, 201);
  const bad = await call('POST', `/travel/trips/${id}/segments`, { kind: 'flight', startLocal: 'tomorrow' });
  assert.equal(bad.status, 400);
  await call('POST', `/travel/trips/${id}/itinerary`, { date: '2026-11-20', time: '10:30', title: 'Client workshop', kind: 'work' });
  let s = (await call('GET', '/travel')).json;
  const trip = s.trips.find((t) => t.id === id)!;
  assert.equal(trip.segments[0]!.fromName, 'Singapore Changi');
  assert.equal(s.context.mode, 'upcoming');
  const item = trip.itinerary[0]!;
  s = (await call('PATCH', `/travel/itinerary/${item.id}`, { done: true, time: '11:00' })).json;
  assert.deepEqual([s.trips[0]!.itinerary[0]!.done, s.trips[0]!.itinerary[0]!.time], [true, '11:00']);
  s = (await call('PUT', '/travel/settings', { homeAirport: 'kul' })).json;
  assert.equal(s.settings.homeAirport, 'KUL');
  s = (await call('PUT', '/travel/loyalty', { program: 'marriott bonvoy', tier: 'Gold Elite', points: 120000 })).json;
  assert.equal(s.loyalty[0]!.program, 'Marriott Bonvoy');
  const imp = await call('POST', '/travel/import', { text: 'Your Marriott stay is confirmed' });
  assert.equal(imp.status, 400);
  assert.match(imp.json.error!, /Connect a brain/);
  assert.equal((await call('POST', `/travel/trips/${id}/draft`)).status, 400);
  // Checking in is kept with the flight, for every device; a stay can't be checked in.
  const flightId = s.trips[0]!.segments.find((x) => x.kind === 'flight')!.id;
  assert.equal(s.trips[0]!.segments[0]!.checkedInAt, null);
  s = (await call('POST', `/travel/segments/${flightId}/checkin`, { checkedIn: true })).json;
  assert.ok(s.trips[0]!.segments.find((x) => x.id === flightId)!.checkedInAt);
  s = (await call('POST', `/travel/segments/${flightId}/checkin`, { checkedIn: false })).json;
  assert.equal(s.trips[0]!.segments.find((x) => x.id === flightId)!.checkedInAt, null);
  assert.equal((await call('POST', '/travel/segments/nope/checkin', { checkedIn: true })).status, 404);
  assert.equal((await call('POST', `/travel/segments/${flightId}/checkin`, {})).status, 400);
  // A delay is kept with the flight; Today follows the new times.
  s = (await call('POST', `/travel/segments/${flightId}/delay`, { minutes: 45 })).json;
  assert.equal(s.trips[0]!.segments.find((x) => x.id === flightId)!.delayMin, 45);
  s = (await call('POST', `/travel/segments/${flightId}/delay`, { minutes: 0 })).json;
  assert.equal(s.trips[0]!.segments.find((x) => x.id === flightId)!.delayMin, 0);
  assert.equal((await call('POST', `/travel/segments/${flightId}/delay`, { minutes: -5 })).status, 400);
  assert.equal((await call('DELETE', `/travel/trips/${id}`)).json.trips.length, 0);
});

test('flights carry each airport’s city and coordinates, for the flight cards and the route globe', () => {
  const store = travelStore();
  const trip = createTrip(store, { title: 'Shenzhen', startDate: '2026-11-24', endDate: '2026-11-29' });
  const { segment } = addSegment(store, trip.id, { kind: 'flight', carrier: 'SQ', number: '856', fromCode: 'SIN', toCode: 'SZX', startLocal: '2026-11-24T18:45', endLocal: '2026-11-24T23:00' });
  assert.equal(segment.fromCity, 'Singapore');
  assert.equal(segment.toCity, 'Shenzhen');
  assert.deepEqual(segment.fromGeo, [1.36, 103.99]);
  assert.deepEqual(segment.toGeo, [22.64, 113.81]);
  const unknown = addSegment(store, trip.id, { kind: 'flight', carrier: 'XX', number: '1', fromCode: 'ZZZ', toCode: 'SZX', startLocal: '2026-11-25T08:00' }).segment;
  assert.equal(unknown.fromGeo, null, 'an airport not in the table has no coordinates');
  assert.equal(unknown.fromCity, '');
});

test('on a trip, the context knows where you are now and where home is', () => {
  const store = travelStore();
  const trip = createTrip(store, { destination: 'Tokyo', purpose: 'leisure', startDate: '2026-12-01', endDate: '2026-12-05' });
  addSegment(store, trip.id, { kind: 'flight', carrier: 'SQ', number: '638', fromCode: 'SIN', toCode: 'HND', startLocal: '2026-12-01T09:40', endLocal: '2026-12-01T17:35' });
  addSegment(store, trip.id, { kind: 'stay', title: 'The Westin Tokyo', toCode: 'HND', startLocal: '2026-12-01T20:00', endLocal: '2026-12-05T12:00' });
  // Before take-off: nothing has happened yet, so no "here".
  assert.equal(travelContext(store, '2026-12-01', new Date('2026-12-01T00:30:00Z')).here, null);
  // In the air (left 01:40Z, lands 08:35Z): still not anywhere new.
  assert.equal(travelContext(store, '2026-12-01', new Date('2026-12-01T05:00:00Z')).here, null);
  // Landed: Tokyo.
  const landed = travelContext(store, '2026-12-01', new Date('2026-12-01T09:00:00Z'));
  assert.equal(landed.here?.tz, 'Asia/Tokyo');
  assert.equal(landed.here?.city, 'Tokyo');
  assert.equal(landed.home?.tz, 'Asia/Singapore');
  // Days later, staying at the hotel: still Tokyo.
  assert.equal(travelContext(store, '2026-12-03', new Date('2026-12-03T03:00:00Z')).here?.tz, 'Asia/Tokyo');
  // No trip: no "here".
  assert.equal(travelContext(store, '2026-12-20', new Date('2026-12-20T03:00:00Z')).here, null);
});
