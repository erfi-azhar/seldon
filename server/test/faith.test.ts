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
  assert.deepEqual(ramadanFrom('2026-11-14'), { start: '2027-02-08', daysUntil: 86, inRamadan: false, day: null });
  const during = ramadanFrom('2027-02-20')!;
  assert.equal(during.inRamadan, true);
  assert.equal(during.start, '2027-02-08');
  assert.equal(during.day, 13);
});

test('current and next prayer, unmarked prayers, and the make-up ledger', () => {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['faith'] });
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('prayer', ?)").run(JSON.stringify({ ...SG, backlog: { fajr: 2, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 } }));

  // 17:00 Singapore time on the 14th: Asr's time, Maghrib next.
  const at5pm = new Date('2026-11-14T09:00:00Z');
  logPrayer(store, '2026-11-14', 'fajr', 'prayed');
  logPrayer(store, '2026-11-14', 'dhuhr', 'missed');
  let f = faithState(store, '2026-11-14', at5pm);
  assert.equal(f.current!.prayer, 'asr');
  assert.equal(f.next!.prayer, 'maghrib');
  assert.equal(f.week.length, 7);
  assert.ok(!f.unmarked.some((u) => u.date === '2026-11-14'), 'Asr is still in its time, so it is not unmarked');
  assert.equal(f.unmarked.filter((u) => u.date === '2026-11-13').length, 5);
  assert.deepEqual(f.owed, { fajr: 2, dhuhr: 1, asr: 0, maghrib: 0, isha: 0 });

  // After midnight, yesterday's Isha is still current until Fajr.
  f = faithState(store, '2026-11-15', new Date('2026-11-14T17:30:00Z'));
  assert.equal(f.current!.prayer, 'isha');
  assert.equal(f.next!.prayer, 'fajr');

  adjustQada(store, 'dhuhr', -1);
  adjustQada(store, 'fajr', -1);
  assert.deepEqual(faithState(store, '2026-11-14', at5pm).owed, { fajr: 1, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 });
  assert.throws(() => adjustQada(store, 'asr', -1), /No missed Asr/);
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
