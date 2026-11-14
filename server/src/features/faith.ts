// Faith, for a Muslim: prayer times for where you are, a prayer log that keeps count
// of missed prayers still to make up (qada), and a countdown to Ramadan.
//
// Times are calculated locally (the adhan library); nothing is looked up online.
// Ramadan's start is estimated from the Umm al-Qura calendar — the actual start is
// announced locally after the moon is sighted.

import { CalculationMethod, Coordinates, Madhab, PrayerTimes, type CalculationParameters } from 'adhan';
import { z } from 'zod';
import { registerSnapshotSection } from '../agent/snapshot-hooks.ts';
import { tool } from '../agent/tools.ts';
import { read, today as todayOf } from '../http.ts';
import { addDays, daysBetween, Invalid, nowIso, registerUndo, type Store } from '../store.ts';
import { PRAYERS, type FaithState, type PrayerDay, type PrayerName, type PrayerSettings, type PrayerStatus } from '../../../shared/types.ts';
import { registerFeature } from './registry.ts';

const zero = (): Record<PrayerName, number> => ({ fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 });

export const METHODS: Record<string, { label: string; make: () => CalculationParameters }> = {
  Singapore: { label: 'MUIS (Singapore), also used in Malaysia and Indonesia', make: () => CalculationMethod.Singapore() },
  MuslimWorldLeague: { label: 'Muslim World League', make: () => CalculationMethod.MuslimWorldLeague() },
  UmmAlQura: { label: 'Umm al-Qura (Makkah)', make: () => CalculationMethod.UmmAlQura() },
  Egyptian: { label: 'Egyptian General Authority', make: () => CalculationMethod.Egyptian() },
  Karachi: { label: 'University of Islamic Sciences, Karachi', make: () => CalculationMethod.Karachi() },
  Dubai: { label: 'Dubai', make: () => CalculationMethod.Dubai() },
  Qatar: { label: 'Qatar', make: () => CalculationMethod.Qatar() },
  Kuwait: { label: 'Kuwait', make: () => CalculationMethod.Kuwait() },
  Turkey: { label: 'Diyanet (Turkey)', make: () => CalculationMethod.Turkey() },
  Tehran: { label: 'Tehran', make: () => CalculationMethod.Tehran() },
  NorthAmerica: { label: 'ISNA (North America)', make: () => CalculationMethod.NorthAmerica() },
  MoonsightingCommittee: { label: 'Moonsighting Committee', make: () => CalculationMethod.MoonsightingCommittee() },
};

/** A sensible method for a time zone; the person can change it. */
export function methodForTimezone(tz: string): string {
  if (/^Asia\/(Singapore|Kuala_Lumpur|Kuching|Jakarta|Makassar|Jayapura|Pontianak|Brunei)$/.test(tz)) return 'Singapore';
  if (/^Asia\/Riyadh$/.test(tz)) return 'UmmAlQura';
  if (/^Asia\/(Dubai|Muscat)$/.test(tz)) return 'Dubai';
  if (/^Asia\/Qatar$/.test(tz)) return 'Qatar';
  if (/^Asia\/Kuwait$/.test(tz)) return 'Kuwait';
  if (/^Asia\/Karachi$/.test(tz)) return 'Karachi';
  if (/^Asia\/Tehran$/.test(tz)) return 'Tehran';
  if (/^(Europe|Asia)\/Istanbul$/.test(tz)) return 'Turkey';
  if (/^Africa\/Cairo$/.test(tz)) return 'Egyptian';
  if (/^America\//.test(tz)) return 'NorthAmerica';
  return 'MuslimWorldLeague';
}

const DEFAULTS: PrayerSettings = {
  lat: null,
  lng: null,
  label: '',
  timezone: 'UTC',
  method: 'MuslimWorldLeague',
  madhab: 'shafi',
  adjustments: zero(),
  backlog: zero(),
};

function getSettings(store: Store): PrayerSettings {
  const r = store.db.prepare("SELECT value FROM settings WHERE key = 'prayer'").get() as { value: string } | undefined;
  const saved = r ? (JSON.parse(r.value) as Partial<PrayerSettings>) : {};
  return { ...DEFAULTS, ...saved, timezone: saved.timezone || DEFAULTS.timezone, adjustments: { ...zero(), ...saved.adjustments }, backlog: { ...zero(), ...saved.backlog } };
}

function saveSettings(store: Store, s: PrayerSettings): void {
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('prayer', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));
}

const DAY_MS = 86_400_000;

/** adhan's times for one date, or null when the sun doesn't rise or set that day. */
function calculate(s: PrayerSettings & { lat: number; lng: number }, date: string): PrayerDay['times'] | null {
  const params = (METHODS[s.method] ?? METHODS.MuslimWorldLeague!).make();
  params.madhab = s.madhab === 'hanafi' ? Madhab.Hanafi : Madhab.Shafi;
  params.adjustments = { ...params.adjustments, ...s.adjustments };
  const [y, m, d] = date.split('-').map(Number);
  // adhan reads only the calendar date from this value.
  const pt = new PrayerTimes(new Coordinates(s.lat, s.lng), new Date(y!, m! - 1, d!, 12), params);
  const times = { fajr: pt.fajr, sunrise: pt.sunrise, dhuhr: pt.dhuhr, asr: pt.asr, maghrib: pt.maghrib, isha: pt.isha };
  if (Object.values(times).some((t) => Number.isNaN(t.getTime()))) return null;
  return Object.fromEntries(Object.entries(times).map(([k, t]) => [k, t.toISOString()])) as PrayerDay['times'];
}

/**
 * Prayer times for a calendar date at the saved location. Near the poles, where the
 * sun stays up (or down) for weeks, it uses the nearest day that has a sunrise and
 * sunset, moved to this date. Null when unset, or when no day in the year has them.
 */
export function timesFor(s: PrayerSettings, date: string): PrayerDay['times'] | null {
  if (s.lat === null || s.lng === null) return null;
  const at = { ...s, lat: s.lat, lng: s.lng };
  for (let i = 0; i <= 183; i++) {
    for (const offset of i === 0 ? [0] : [-i, i]) {
      const t = calculate(at, addDays(date, offset));
      if (t) return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, new Date(Date.parse(v) - offset * DAY_MS).toISOString()])) as PrayerDay['times'];
    }
  }
  return null;
}

/** When a prayer's time ends: Fajr at sunrise, Isha at the next Fajr, the others at the next prayer. */
function endOf(s: PrayerSettings, date: string, prayer: PrayerName): string | null {
  const t = timesFor(s, date);
  if (!t) return null;
  if (prayer === 'fajr') return t.sunrise;
  if (prayer === 'isha') return timesFor(s, addDays(date, 1))!.fajr;
  return t[PRAYERS[PRAYERS.indexOf(prayer) + 1]!];
}

function logFor(store: Store, from: string, to: string): Map<string, Partial<Record<PrayerName, PrayerStatus>>> {
  const rows = store.db.prepare('SELECT date, prayer, status FROM prayer_log WHERE date >= ? AND date <= ?').all(from, to) as { date: string; prayer: PrayerName; status: PrayerStatus }[];
  const out = new Map<string, Partial<Record<PrayerName, PrayerStatus>>>();
  for (const r of rows) out.set(r.date, { ...out.get(r.date), [r.prayer]: r.status });
  return out;
}

function owed(store: Store, s: PrayerSettings): Record<PrayerName, number> {
  const out = { ...s.backlog };
  const rows = store.db.prepare("SELECT prayer, COUNT(*) AS n FROM prayer_log WHERE status = 'missed' AND made_up_at IS NULL GROUP BY prayer").all() as { prayer: PrayerName; n: number }[];
  for (const r of rows) out[r.prayer] += r.n;
  return out;
}

const hijriParts = (date: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' })
      .formatToParts(new Date(`${date}T12:00:00Z`))
      .map((p) => [p.type, p.value]),
  );

export function hijriLabel(date: string): string {
  return new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

/** The next (or current) Ramadan by the Umm al-Qura calendar. */
export function ramadanFrom(date: string): FaithState['ramadan'] {
  const now = hijriParts(date);
  if (now.month === '9') {
    let start = date;
    while (hijriParts(addDays(start, -1)).month === '9') start = addDays(start, -1);
    return { start, daysUntil: 0, inRamadan: true, day: Number(now.day) };
  }
  for (let i = 1; i < 400; i++) {
    const d = addDays(date, i);
    const p = hijriParts(d);
    if (p.month === '9' && p.day === '1') return { start: d, daysUntil: i, inRamadan: false, day: null };
  }
  return null;
}

export function faithState(store: Store, today: string, now: Date = new Date()): FaithState {
  const s = getSettings(store);
  const configured = timesFor(s, today) !== null;
  const from = addDays(today, -6);
  const logs = logFor(store, addDays(from, -1), today);
  const week: PrayerDay[] = configured ? Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((d) => ({ date: d, times: timesFor(s, d)!, log: logs.get(d) ?? {} })) : [];
  const day = week.at(-1) ?? null;

  let current: FaithState['current'] = null;
  let next: FaithState['next'] = null;
  const unmarked: FaithState['unmarked'] = [];
  if (configured) {
    // Isha's time runs past midnight: yesterday's Isha may still be current.
    const yesterdayIsha = { date: addDays(today, -1), prayer: 'isha' as PrayerName };
    const candidates: { date: string; prayer: PrayerName }[] = [yesterdayIsha, ...PRAYERS.map((p) => ({ date: today, prayer: p }))];
    for (const c of candidates) {
      const start = Date.parse(timesFor(s, c.date)![c.prayer]);
      const end = Date.parse(endOf(s, c.date, c.prayer)!);
      if (now.getTime() >= start && now.getTime() < end) current = { prayer: c.prayer, endsAt: new Date(end).toISOString() };
    }
    const upcoming = [...PRAYERS.map((p) => ({ prayer: p, at: day!.times[p] })), { prayer: 'fajr' as PrayerName, at: timesFor(s, addDays(today, 1))!.fajr }].find(
      (x) => Date.parse(x.at) > now.getTime(),
    );
    next = upcoming ?? null;
    for (const d of week) {
      for (const p of PRAYERS) {
        if (d.log[p]) continue;
        if (Date.parse(endOf(s, d.date, p)!) <= now.getTime()) unmarked.push({ date: d.date, prayer: p });
      }
    }
  }

  return { configured, settings: s, today: day, current, next, week, unmarked, owed: owed(store, s), hijri: hijriLabel(today), ramadan: ramadanFrom(today) };
}

export function logPrayer(store: Store, date: string, prayer: PrayerName, status: PrayerStatus | null): void {
  if (status === null) {
    store.db.prepare('DELETE FROM prayer_log WHERE date = ? AND prayer = ?').run(date, prayer);
    return;
  }
  store.db
    .prepare(
      `INSERT INTO prayer_log (date, prayer, status, logged_at) VALUES (?,?,?,?)
       ON CONFLICT(date, prayer) DO UPDATE SET status = excluded.status, logged_at = excluded.logged_at,
         made_up_at = CASE WHEN excluded.status = 'missed' THEN prayer_log.made_up_at ELSE NULL END`,
    )
    .run(date, prayer, status, nowIso());
  if (status === 'missed') {
    const faith = store.listSpheres().find((x) => x.key === 'faith');
    store.record('missed', 'prayer', `${date}|${prayer}`, faith?.id ?? null, `Missed ${cap(prayer)}${date === todayDate(getSettings(store).timezone) ? '' : ` (${date})`} — added to prayers to make up`);
  }
}

/** Make up one missed prayer (oldest first), or add earlier misses to the backlog. */
export function adjustQada(store: Store, prayer: PrayerName, delta: number): Record<PrayerName, number> {
  const s = getSettings(store);
  const faith = store.listSpheres().find((x) => x.key === 'faith');
  if (delta > 0) {
    s.backlog[prayer] += delta;
    saveSettings(store, s);
  } else if (delta < 0) {
    const have = owed(store, s)[prayer];
    if (have < -delta) throw new Invalid(have ? `Only ${have} missed ${cap(prayer)} left to make up.` : `No missed ${cap(prayer)} left to make up.`);
    store.tx(() => {
      for (let i = 0; i < -delta; i++) {
        const oldest = store.db.prepare("SELECT date FROM prayer_log WHERE prayer = ? AND status = 'missed' AND made_up_at IS NULL ORDER BY date LIMIT 1").get(prayer) as { date: string } | undefined;
        if (oldest) store.db.prepare('UPDATE prayer_log SET made_up_at = ? WHERE date = ? AND prayer = ?').run(nowIso(), oldest.date, prayer);
        else s.backlog[prayer] -= 1;
      }
      saveSettings(store, s);
      store.record('made_up', 'prayer', `${prayer}|${nowIso()}`, faith?.id ?? null, `Made up ${-delta === 1 ? 'a missed' : `${-delta} missed`} ${cap(prayer)}`);
    });
  }
  return owed(store, s);
}

const cap = (p: string): string => p[0]!.toUpperCase() + p.slice(1);
/** Today where the person is. */
const todayDate = (tz: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

const timeIn = (iso: string, tz: string): string => new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });

registerSnapshotSection<Store>('Prayer', (store, today) => {
  const f = faithState(store, today);
  if (!f.configured || !f.today) return null;
  const tz = f.settings.timezone;
  const lines = [
    `Times today in ${f.settings.label || 'their location'} (${tz}): ${PRAYERS.map((p) => `${cap(p)} ${timeIn(f.today!.times[p], tz)}${f.today!.log[p] ? ` [${f.today!.log[p]}]` : ''}`).join(', ')}.`,
  ];
  const owedTotal = PRAYERS.reduce((n, p) => n + f.owed[p], 0);
  if (owedTotal) lines.push(`Missed prayers still to make up: ${PRAYERS.filter((p) => f.owed[p]).map((p) => `${cap(p)} ${f.owed[p]}`).join(', ')}.`);
  if (f.unmarked.length) lines.push(`${f.unmarked.length} past prayers this week not yet marked.`);
  lines.push(`Hijri date: ${f.hijri}.`);
  if (f.ramadan) lines.push(f.ramadan.inRamadan ? `It is Ramadan, day ${f.ramadan.day}.` : `Ramadan expected to begin around ${f.ramadan.start} (${f.ramadan.daysUntil} days, Umm al-Qura estimate; subject to local moon sighting).`);
  return lines.join('\n');
});

// Undoing a "missed" mark clears it, as if it had never been logged.
registerUndo('missed:prayer', (db, entityId) => {
  const [date, prayer] = entityId.split('|');
  db.prepare("DELETE FROM prayer_log WHERE date = ? AND prayer = ? AND status = 'missed'").run(date!, prayer!);
});

const prayerName = z.enum(PRAYERS);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

registerFeature({
  id: 'faith',
  tables: ['prayer_log'],
  tools: [
    tool(
      'log_prayer',
      'Record whether the user prayed a given prayer: "prayed" (in its time), "late" (after its time had ended), or "missed" (not prayed — it is added to the prayers they owe). Call it when they tell you, e.g. "prayed Asr", "missed Fajr this morning". Date defaults to today.',
      z.object({ prayer: prayerName, status: z.enum(['prayed', 'late', 'missed']), date: dateStr.optional() }),
      ({ prayer, status, date }, { store, today }) => {
        logPrayer(store, date ?? today, prayer, status);
        return { data: { ok: true, owed: faithState(store, today).owed }, summary: `${status === 'missed' ? 'Marked missed' : status === 'late' ? 'Marked prayed late' : 'Marked prayed'}: ${cap(prayer)}` };
      },
    ),
    tool(
      'make_up_prayer',
      'Record that the user made up (prayed qada for) one or more missed prayers.',
      z.object({ prayer: prayerName, count: z.number().int().min(1).max(50).optional() }),
      ({ prayer, count }, { store }) => {
        const left = adjustQada(store, prayer, -(count ?? 1));
        return { data: { ok: true, owed: left }, summary: `Made up ${count ?? 1} ${cap(prayer)}` };
      },
    ),
  ],
  routes: (app, { store }) => {
    app.get('/api/faith', (c) => c.json(faithState(store, todayOf(c))));
    app.get('/api/faith/methods', (c) => c.json(Object.entries(METHODS).map(([id, m]) => ({ id, label: m.label }))));
    app.put('/api/faith/settings', async (c) => {
      const input = await read(
        c,
        z.object({
          lat: z.number().min(-90).max(90).optional(),
          lng: z.number().min(-180).max(180).optional(),
          label: z.string().max(80).optional(),
          timezone: z.string().min(1).max(60).optional(),
          method: z.string().refine((m) => m in METHODS, 'Unknown method').optional(),
          madhab: z.enum(['shafi', 'hanafi']).optional(),
          adjustments: z.partialRecord(prayerName, z.number().int().min(-30).max(30)).optional(),
        }),
      );
      const s = getSettings(store);
      const first = s.lat === null;
      const next: PrayerSettings = { ...s, ...input, adjustments: { ...s.adjustments, ...input.adjustments } };
      if (input.timezone !== undefined) {
        try {
          new Intl.DateTimeFormat('en', { timeZone: input.timezone });
        } catch {
          throw new Invalid('Unknown time zone');
        }
      }
      // First time: pick the method people use where you are.
      if (first && !input.method && input.timezone) next.method = methodForTimezone(input.timezone);
      if (next.lat !== null && next.lng !== null && !timesFor(next, todayOf(c))) throw new Invalid("Prayer times can't be calculated this close to the pole.");
      saveSettings(store, next);
      return c.json(faithState(store, todayOf(c)));
    });
    app.post('/api/faith/log', async (c) => {
      const { date, prayer, status } = await read(c, z.object({ date: dateStr, prayer: prayerName, status: z.enum(['prayed', 'late', 'missed']).nullable() }));
      if (daysBetween(date, todayOf(c)) < 0) throw new Invalid("That prayer hasn't come yet.");
      logPrayer(store, date, prayer, status);
      return c.json(faithState(store, todayOf(c)));
    });
    app.post('/api/faith/qada', async (c) => {
      const { prayer, delta } = await read(c, z.object({ prayer: prayerName, delta: z.number().int().min(-50).max(5000).refine((n) => n !== 0) }));
      adjustQada(store, prayer, delta);
      return c.json(faithState(store, todayOf(c)));
    });
  },
});
