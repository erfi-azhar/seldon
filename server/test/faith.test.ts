import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { adjustQada, faithState, logPrayer, methodForTimezone, ramadanFrom, timesFor } from '../src/features/faith.ts';
import { renderSnapshot } from '../src/agent/prompt.ts';
import { Store } from '../src/store.ts';
import type { PrayerSettings } from '../../shared/types.ts';

const SG: PrayerSettings = {
  lat: 1.3521,
  lng: 103.8198,
  label: 'Singapore',
  timezone: 'Asia/Singapore',
  method: 'Singapore',
  madhab: 'shafi',
  adjustments: { fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 },
  backlog: { fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 },
};
const local = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' });

test('prayer times for Singapore land where MUIS publishes them, and adjustments shift them', () => {
  const t = timesFor(SG, '2026-11-14')!;
  // MUIS 14 Nov 2026 is around 05:31 / 12:52 / 16:15 / 18:52 / 20:06; the method is within a few minutes.
  const near = (iso: string, hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    const [H, M] = local(iso).split(':').map(Number);
    return Math.abs(H! * 60 + M! - (h! * 60 + m!)) <= 6;
  };
  assert.ok(near(t.fajr, '05:31') && near(t.dhuhr, '12:52') && near(t.asr, '16:15') && near(t.maghrib, '18:52') && near(t.isha, '20:06'), JSON.stringify(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, local(v)]))));
  const shifted = timesFor({ ...SG, adjustments: { ...SG.adjustments, fajr: 4 } }, '2026-11-14')!;
  assert.equal(Date.parse(shifted.fajr) - Date.parse(t.fajr), 4 * 60_000);
  assert.equal(timesFor({ ...SG, lat: null }, '2026-11-14'), null);
});

test('methods follow the time zone; Ramadan is counted from the Umm al-Qura calendar', () => {
  assert.equal(methodForTimezone('Asia/Singapore'), 'Singapore');
  assert.equal(methodForTimezone('Asia/Riyadh'), 'UmmAlQura');
  assert.equal(methodForTimezone('America/New_York'), 'NorthAmerica');
  assert.equal(methodForTimezone('Europe/London'), 'MuslimWorldLeague');
  assert.deepEqual(ramadanFrom('2026-11-14'), { start: '2027-02-08', end: '2027-03-08', daysUntil: 86, inRamadan: false, day: null });
  const during = ramadanFrom('2027-02-20')!;
  assert.equal(during.inRamadan, true);
  assert.equal(during.start, '2027-02-08');
  assert.equal(during.end, '2027-03-08');
  assert.equal(during.day, 13);
});

test('current and next prayer, unmarked prayers, and the make-up ledger', () => {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['faith'] });
  // Tracking began at 07:00 Singapore time on the 14th, after that morning's Fajr had ended.
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('prayer', ?)").run(JSON.stringify({ ...SG, since: '2026-11-13T23:00:00.000Z', backlog: { fajr: 2, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 } }));

  // 17:00 Singapore time on the 14th: Asr's time, Maghrib next.
  const at5pm = new Date('2026-11-14T09:00:00Z');
  logPrayer(store, '2026-11-14', 'fajr', 'prayed');
  logPrayer(store, '2026-11-14', 'dhuhr', 'missed');
  let f = faithState(store, '2026-11-14', at5pm);
  assert.equal(f.current!.prayer, 'asr');
  assert.equal(f.next!.prayer, 'maghrib');
  assert.equal(f.week.length, 7);
  assert.deepEqual(f.autoMissed, [], 'nothing before tracking began counts, and Asr is still in its time');
  assert.deepEqual(f.owed, { fajr: 2, dhuhr: 1, asr: 0, maghrib: 0, isha: 0 });

  // After midnight, yesterday's Isha is still current until Fajr.
  f = faithState(store, '2026-11-15', new Date('2026-11-14T17:30:00Z'));
  assert.equal(f.current!.prayer, 'isha');
  assert.equal(f.next!.prayer, 'fajr');

  adjustQada(store, 'dhuhr', -1);
  adjustQada(store, 'fajr', -1);
  // By then Asr and Maghrib of the 14th had passed unmarked, so they count as missed too.
  assert.deepEqual(faithState(store, '2026-11-14', at5pm).owed, { fajr: 1, dhuhr: 0, asr: 1, maghrib: 1, isha: 0 });
  assert.throws(() => adjustQada(store, 'isha', -1), /No missed Isha/);
  logPrayer(store, '2026-11-14', 'dhuhr', 'late');
  assert.equal(faithState(store, '2026-11-14', at5pm).owed.dhuhr, 0, 'a miss later marked as prayed late is no longer owed');

  const snap = renderSnapshot(store, '2026-11-14');
  assert.match(snap, /PRAYER\nTimes today in Singapore \(Asia\/Singapore\): Fajr \d\d:\d\d \[prayed\]/);
  assert.match(snap, /Ramadan expected to begin around 2027-02-08 \(86 days/);
});

test('over HTTP: set the location by time zone, log a prayer, undo a miss', async () => {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.onboard({ userName: '', agentName: 'Seldon', sphereKeys: ['faith'] });
  const app = createApp({ db });
  const call = (method: string, path: string, body?: object) =>
    app.request(`http://localhost${path}?date=2026-11-14`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const set = (await (await call('PUT', '/api/faith/settings', { lat: 1.35, lng: 103.82, label: 'Singapore', timezone: 'Asia/Singapore' })).json()) as { settings: { method: string }; configured: boolean };
  assert.equal(set.settings.method, 'Singapore');
  assert.equal(set.configured, true);
  assert.equal((await call('PUT', '/api/faith/settings', { timezone: 'Mars/Olympus' })).status, 400);
  assert.equal((await call('POST', '/api/faith/log', { date: '2026-11-15', prayer: 'fajr', status: 'prayed' })).status, 400);
  await call('POST', '/api/faith/log', { date: '2026-11-14', prayer: 'asr', status: 'missed' });
  const missed = store.listActivity()[0]!;
  assert.match(missed.summary, /^Missed Asr/);
  assert.equal(store.undo(missed.id), true);
  assert.equal(faithState(store, '2026-11-14').owed.asr, 0);
});

const httpApp = () => {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.onboard({ userName: '', agentName: 'Seldon', sphereKeys: ['faith'] });
  const app = createApp({ db });
  const call = (method: string, path: string, body?: object, date = '2026-11-14') =>
    app.request(`http://localhost${path}?date=${date}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { store, call };
};

test('fine-tuning one prayer saves just that adjustment', async () => {
  const { call } = httpApp();
  await call('PUT', '/api/faith/settings', { lat: 1.35, lng: 103.82, label: 'Singapore', timezone: 'Asia/Singapore' });
  const r = await call('PUT', '/api/faith/settings', { adjustments: { fajr: 2 } });
  assert.equal(r.status, 200, await r.clone().text());
  const after = (await r.json()) as { settings: PrayerSettings };
  assert.deepEqual(after.settings.adjustments, { fajr: 2, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 });
  const again = (await (await call('PUT', '/api/faith/settings', { adjustments: { isha: -3 } })).json()) as { settings: PrayerSettings };
  assert.deepEqual(again.settings.adjustments, { fajr: 2, dhuhr: 0, asr: 0, maghrib: 0, isha: -3 });
  assert.equal((await call('PUT', '/api/faith/settings', { adjustments: { fajr: 31 } })).status, 400);
});

test('making up more prayers than are owed changes nothing', () => {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['faith'] });
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('prayer', ?)").run(JSON.stringify({ ...SG, backlog: { ...SG.backlog, fajr: 1 } }));
  logPrayer(store, '2026-11-10', 'fajr', 'missed');
  const activity = store.listActivity().length;
  assert.equal(faithState(store, '2026-11-14').owed.fajr, 2);
  assert.throws(() => adjustQada(store, 'fajr', -3), /Only 2 missed Fajr/);
  assert.equal(faithState(store, '2026-11-14').owed.fajr, 2, 'neither the logged miss nor the backlog is touched');
  assert.equal(store.listActivity().length, activity);
  // Exactly what is owed works, logged misses first, and is recorded once.
  assert.deepEqual(adjustQada(store, 'fajr', -2).fajr, 0);
  assert.equal(store.listActivity().length, activity + 1);
  assert.match(store.listActivity()[0]!.summary, /Made up 2 missed Fajr/);
});

test("after midnight the current Isha is yesterday's, and its log is yesterday's", () => {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['faith'] });
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('prayer', ?)").run(JSON.stringify(SG));
  logPrayer(store, '2026-11-14', 'isha', 'prayed');
  // 01:30 Singapore time on the 15th. The card and pill tell yesterday's Isha apart
  // from today's by its end: it ends at today's Fajr (currentDay in Prayer.tsx).
  const f = faithState(store, '2026-11-15', new Date('2026-11-14T17:30:00Z'));
  assert.equal(f.current!.prayer, 'isha');
  assert.equal(f.current!.endsAt, f.today!.times.fajr);
  assert.equal(f.today!.log.isha, undefined);
  const yesterday = f.week.at(-2)!;
  assert.equal(yesterday.date, '2026-11-14');
  assert.equal(yesterday.log.isha, 'prayed');
  // In the evening, today's Isha ends at tomorrow's Fajr instead.
  const evening = faithState(store, '2026-11-14', new Date('2026-11-14T13:00:00Z'));
  assert.equal(evening.current!.prayer, 'isha');
  assert.notEqual(evening.current!.endsAt, evening.today!.times.fajr);
});

test('above the Arctic Circle, days without sunset borrow the nearest day that has one', async () => {
  const tromso: PrayerSettings = { ...SG, lat: 69.65, lng: 18.96, label: 'Tromsø', timezone: 'Europe/Oslo', method: 'MuslimWorldLeague' };
  for (const date of ['2026-06-14', '2026-12-20']) {
    const t = timesFor(tromso, date)!;
    assert.ok(t, date);
    const order = (['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'] as const).map((k) => Date.parse(t[k]));
    assert.ok(order.every((n) => !Number.isNaN(n)), date);
    // Every time is moved onto the asked-for date.
    assert.equal(new Date(t.dhuhr).toISOString().slice(0, 10), date);
  }
  assert.equal(timesFor({ ...SG, lat: 89.9 }, '2026-06-21'), null);

  const { call } = httpApp();
  assert.equal((await call('PUT', '/api/faith/settings', { lat: 69.65, lng: 18.96, label: 'Tromsø', timezone: 'Europe/Oslo' })).status, 200);
  const r = await call('GET', '/api/faith', undefined, '2026-06-14');
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(((await r.json()) as { configured: boolean }).configured, true);
  assert.equal((await call('PUT', '/api/faith/settings', { lat: 89.9, lng: 0 })).status, 400);
});

test('an empty time zone is refused, and a saved one falls back to UTC', async () => {
  const { store, call } = httpApp();
  assert.equal((await call('PUT', '/api/faith/settings', { lat: 1.35, lng: 103.82, timezone: '' })).status, 400);
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('prayer', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ ...SG, timezone: '' }));
  const r = await call('POST', '/api/faith/log', { date: '2026-11-13', prayer: 'asr', status: 'missed' });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(store.listActivity()[0]!.summary, /^Missed Asr/);
});

test('a prayer whose time passes unmarked counts as missed, and can still be marked prayed', () => {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['faith'] });
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('prayer', ?)").run(JSON.stringify({ ...SG, since: '2026-11-13T23:00:00.000Z' }));
  logPrayer(store, '2026-11-14', 'dhuhr', 'prayed');
  // 00:30 on the 15th in Singapore: Asr and Maghrib of the 14th have ended unmarked; Isha is still in its time.
  const lateNight = new Date('2026-11-14T16:30:00Z');
  let f = faithState(store, '2026-11-15', lateNight);
  assert.deepEqual(f.autoMissed, [{ date: '2026-11-14', prayer: 'maghrib' }, { date: '2026-11-14', prayer: 'asr' }]);
  assert.deepEqual(f.owed, { fajr: 0, dhuhr: 0, asr: 1, maghrib: 1, isha: 0 });
  assert.equal(f.week.find((d) => d.date === '2026-11-14')!.log.asr, 'missed');
  // Reading again settles nothing twice.
  f = faithState(store, '2026-11-15', lateNight);
  assert.equal(f.autoMissed.length, 2);

  // Prayed Asr late after all: it leaves the missed list and the make-up count.
  logPrayer(store, '2026-11-14', 'asr', 'late');
  f = faithState(store, '2026-11-15', lateNight);
  assert.deepEqual(f.autoMissed, [{ date: '2026-11-14', prayer: 'maghrib' }]);
  assert.equal(f.owed.asr, 0);
  // Making one up works the same as for a miss you marked yourself.
  adjustQada(store, 'maghrib', -1);
  assert.deepEqual(faithState(store, '2026-11-15', lateNight).autoMissed, []);

  // An install from before this: tracking starts from now, so earlier days are never counted.
  const fresh = new Store(openDb(':memory:'));
  fresh.onboard({ userName: '', agentName: 'Seldon', sphereKeys: ['faith'] });
  fresh.db.prepare("INSERT INTO settings (key, value) VALUES ('prayer', ?)").run(JSON.stringify(SG));
  assert.deepEqual(faithState(fresh, '2026-11-15', lateNight).autoMissed, []);
});
