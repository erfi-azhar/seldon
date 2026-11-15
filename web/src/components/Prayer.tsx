// Prayer: today's times where you are, a log of each prayer, what is still to make
// up, and a countdown to Ramadan when it is near.

import { useQuery } from '@tanstack/react-query';
import { Check, ChevronRight, Clock, LocateFixed, MapPin, MoonStar, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PRAYERS, type FaithState, type PrayerDay, type PrayerName, type PrayerStatus } from '../../../shared/types.ts';
import { api, faithWrite, useFaith, useWrite } from '../api.ts';
import { addDays, cx, parseDay, plural, todayStr } from '../lib.ts';
import { Field, Modal } from './ui.tsx';
import { MUNJIYAT, VERSES, verseIndexFor } from './verses.ts';
import { arabicDigits, PlayIcon, RECITER, useRecitation, type Track } from './recitation.tsx';

const NAME: Record<PrayerName, string> = { fajr: 'Fajr', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };

const CITIES: { label: string; lat: number; lng: number; timezone: string }[] = [
  { label: 'Singapore', lat: 1.3521, lng: 103.8198, timezone: 'Asia/Singapore' },
  { label: 'Kuala Lumpur', lat: 3.139, lng: 101.6869, timezone: 'Asia/Kuala_Lumpur' },
  { label: 'Jakarta', lat: -6.2088, lng: 106.8456, timezone: 'Asia/Jakarta' },
  { label: 'Makkah', lat: 21.3891, lng: 39.8579, timezone: 'Asia/Riyadh' },
  { label: 'Madinah', lat: 24.5247, lng: 39.5692, timezone: 'Asia/Riyadh' },
  { label: 'Dubai', lat: 25.2048, lng: 55.2708, timezone: 'Asia/Dubai' },
  { label: 'Istanbul', lat: 41.0082, lng: 28.9784, timezone: 'Europe/Istanbul' },
  { label: 'London', lat: 51.5072, lng: -0.1276, timezone: 'Europe/London' },
  { label: 'New York', lat: 40.7128, lng: -74.006, timezone: 'America/New_York' },
  { label: 'Sydney', lat: -33.8688, lng: 151.2093, timezone: 'Australia/Sydney' },
  { label: 'Tokyo', lat: 35.6762, lng: 139.6503, timezone: 'Asia/Tokyo' },
];

const deviceTz = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const hhmm = (iso: string, tz?: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });

export function untilLabel(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** The day the current prayer belongs to: between midnight and Fajr it is yesterday's Isha. */
export function currentDay(faith: FaithState): PrayerDay | undefined {
  const cur = faith.current;
  if (!cur || !faith.today) return undefined;
  return cur.prayer === 'isha' && cur.endsAt === faith.today.times.fajr ? faith.week.at(-2) : faith.today;
}

/** Re-render every half minute so countdowns move. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function LocationSheet({ faith, onClose }: { faith: FaithState; onClose: () => void }) {
  const { data: methods = [] } = useQuery({ queryKey: ['faith-methods'], queryFn: () => api<{ id: string; label: string }[]>('GET', '/faith/methods') });
  const save = useWrite(faithWrite.settings);
  const [error, setError] = useState('');
  const [locating, setLocating] = useState(false);
  const s = faith.settings;

  const useMyLocation = () => {
    if (!navigator.geolocation) return setError('This browser cannot share its location. Pick a city instead.');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        save.mutate({ lat: Math.round(pos.coords.latitude * 1e4) / 1e4, lng: Math.round(pos.coords.longitude * 1e4) / 1e4, timezone: deviceTz(), label: deviceTz().split('/').pop()!.replaceAll('_', ' ') });
      },
      () => {
        setLocating(false);
        setError('Location was not shared. Pick a city instead.');
      },
      { timeout: 10_000 },
    );
  };

  return (
    <Modal title="Prayer times" onClose={onClose}>
      <div className="row-wrap">
        <button type="button" className="btn btn-primary" onClick={useMyLocation} disabled={locating}>
          <LocateFixed size={15} /> {locating ? 'Finding you…' : 'Use my location'}
        </button>
        {s.lat !== null && (
          <span className="hint">
            <MapPin size={12} style={{ verticalAlign: -1 }} /> {s.label || 'Saved location'} · {s.timezone}
          </span>
        )}
      </div>
      <Field label="Or pick a city">
        <div className="row-wrap" style={{ gap: 6 }}>
          {CITIES.map((c) => (
            <button key={c.label} type="button" className={cx('chip', s.label === c.label ? 'chip-on' : 'chip-outline')} onClick={() => save.mutate(c)}>
              {c.label}
            </button>
          ))}
        </div>
      </Field>
      <div className="field-row">
        <Field label="Calculation method">
          <select className="select" value={s.method} onChange={(e) => save.mutate({ method: e.target.value })}>
            {methods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Asr">
          <select className="select" value={s.madhab} onChange={(e) => save.mutate({ madhab: e.target.value })}>
            <option value="shafi">Standard (Shafi'i, Maliki, Hanbali)</option>
            <option value="hanafi">Hanafi (later Asr)</option>
          </select>
        </Field>
      </div>
      <Field label="Fine-tune to your local timetable (minutes)" hint="Official timetables, like MUIS's, can differ from the calculation by a few minutes.">
        <div className="adjust-row">
          {PRAYERS.map((p) => (
            <label key={p}>
              <span>{NAME[p]}</span>
              <input
                className="input num"
                type="number"
                min={-30}
                max={30}
                defaultValue={s.adjustments[p]}
                onBlur={(e) => Number(e.target.value) !== s.adjustments[p] && save.mutate({ adjustments: { [p]: Math.round(Number(e.target.value) || 0) } })}
              />
            </label>
          ))}
        </div>
      </Field>
      {(error || save.error) && <p className="error-text">{error || save.error?.message}</p>}
    </Modal>
  );
}

/** Prayed, late or missed for one prayer. */
function StatusButtons({ date, prayer, status, disabled }: { date: string; prayer: PrayerName; status: PrayerStatus | undefined; disabled?: boolean }) {
  const log = useWrite(faithWrite.log);
  const set = (next: PrayerStatus) => log.mutate({ date, prayer, status: status === next ? null : next });
  const pending = log.isPending ? (log.variables as { status: PrayerStatus | null }).status : undefined;
  const shown = log.isPending ? (pending ?? undefined) : status;
  return (
    <div className="prayer-buttons" role="group" aria-label={`${NAME[prayer]} on ${date}`}>
      <button type="button" className="pb pb-prayed" aria-pressed={shown === 'prayed'} disabled={disabled} onClick={() => set('prayed')} title="Prayed in its time">
        <Check size={13} strokeWidth={2.8} />
        <span className="sr-only">Prayed</span>
      </button>
      <button type="button" className="pb pb-late" aria-pressed={shown === 'late'} disabled={disabled} onClick={() => set('late')} title="Prayed after its time">
        <Clock size={13} strokeWidth={2.4} />
        <span className="sr-only">Prayed late</span>
      </button>
      <button type="button" className="pb pb-missed" aria-pressed={shown === 'missed'} disabled={disabled} onClick={() => set('missed')} title="Missed — add to prayers to make up">
        <X size={13} strokeWidth={2.8} />
        <span className="sr-only">Missed</span>
      </button>
    </div>
  );
}

const SAY: Record<PrayerStatus, string> = { prayed: 'prayed', late: 'prayed late', missed: 'missed' };
/** Tapping a dot steps through the statuses. A past prayer never goes back to unmarked:
 *  the server would only count it missed again. */
const NEXT: Record<PrayerStatus, PrayerStatus> = { prayed: 'late', late: 'missed', missed: 'prayed' };
const dayLabel = (d: string) => parseDay(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

function WeekDot({ day, prayer, now }: { day: PrayerDay; prayer: PrayerName; now: number }) {
  const log = useWrite(faithWrite.log);
  const status = log.isPending ? (log.variables as { status: PrayerStatus }).status : day.log[prayer];
  const started = Date.parse(day.times[prayer]) <= now;
  const next = status ? NEXT[status] : 'prayed';
  const state = status ? SAY[status] : 'not marked';
  return (
    <button
      type="button"
      className="pw-cell"
      disabled={!started}
      onClick={() => log.mutate({ date: day.date, prayer, status: next })}
      title={`${NAME[prayer]}, ${dayLabel(day.date)}: ${state}${started ? ` — tap to mark ${SAY[next]}` : ''}`}
    >
      <i className={cx('pw-dot', status && `pw-${status}`)} />
      <span className="sr-only">
        {NAME[prayer]}, {dayLabel(day.date)}: {state}
      </span>
    </button>
  );
}

/** The last seven days, one dot per prayer. Dots are buttons, so a past day is corrected here. */
function WeekGrid({ faith, now }: { faith: FaithState; now: number }) {
  const today = todayStr();
  return (
    <div className="prayer-week" role="group" aria-label="The last seven days">
      <span />
      {faith.week.map((d) => (
        <span key={d.date} className={cx('pw-day', d.date === today && 'is-today')}>
          {parseDay(d.date).toLocaleDateString(undefined, { weekday: 'narrow' })}
        </span>
      ))}
      {PRAYERS.map((p) => (
        <div key={p} style={{ display: 'contents' }}>
          <span className="pw-name">{NAME[p]}</span>
          {faith.week.map((d) => (
            <WeekDot key={d.date} day={d} prayer={p} now={now} />
          ))}
        </div>
      ))}
      <div className="pw-legend">
        <span>
          <i className="pw-dot pw-prayed" /> Prayed
        </span>
        <span>
          <i className="pw-dot pw-late" /> Late
        </span>
        <span>
          <i className="pw-dot pw-missed" /> Missed
        </span>
        <span className="pw-hint">Tap a dot to change it</span>
      </div>
    </div>
  );
}

/** Missed prayers still owed, by prayer. Folds to one line when nothing is owed. */
function QadaPanel({ owed }: { owed: FaithState['owed'] }) {
  const qada = useWrite(faithWrite.qada);
  const [open, setOpen] = useState(false);
  const [backlog, setBacklog] = useState<{ prayer: PrayerName; n: string } | null>(null);
  const total = PRAYERS.reduce((n, p) => n + owed[p], 0);
  const showGrid = total > 0 || open;
  return (
    <div className="prayer-qada">
      <div className="qada-head">
        <b>To make up</b>
        {total ? (
          <span className="hint">{plural(total, 'prayer')}</span>
        ) : showGrid ? (
          <span className="hint">Nothing owed</span>
        ) : (
          <span className="hint">
            Nothing owed ·{' '}
            <button type="button" className="link" onClick={() => setOpen(true)}>
              Add earlier misses
            </button>
          </span>
        )}
      </div>
      {showGrid && (
        <div className="qada-grid">
          {PRAYERS.map((p) => (
            <div key={p} className={cx('qada', !owed[p] && 'is-zero')}>
              <span className="qada-name">{NAME[p]}</span>
              <b className="num">{owed[p]}</b>
              <div className="qada-actions">
                <button type="button" className="pb" disabled={!owed[p] || qada.isPending} onClick={() => qada.mutate({ prayer: p, delta: -1 })} title="Made one up">
                  <Check size={13} strokeWidth={2.6} />
                  <span className="sr-only">Made up one {NAME[p]}</span>
                </button>
                <button type="button" className="pb" aria-pressed={backlog?.prayer === p} onClick={() => setBacklog(backlog?.prayer === p ? null : { prayer: p, n: '' })} title="Add earlier missed prayers">
                  <Plus size={13} strokeWidth={2.6} />
                  <span className="sr-only">Add earlier missed {NAME[p]}</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {backlog && (
        <form
          className="qada-add"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Math.round(Number(backlog.n));
            if (n > 0) qada.mutate({ prayer: backlog.prayer, delta: n }, { onSuccess: () => setBacklog(null) });
          }}
        >
          <span className="hint grow">Missed {NAME[backlog.prayer]} from before you started tracking:</span>
          <input className="input num" style={{ width: 80 }} type="number" min={1} autoFocus value={backlog.n} onChange={(e) => setBacklog({ ...backlog, n: e.target.value })} aria-label="How many" />
          <button type="submit" className="btn btn-sm" disabled={qada.isPending}>
            Add
          </button>
        </form>
      )}
      {qada.error && <p className="error-text">{qada.error.message}</p>}
    </div>
  );
}

// Imsak, the customary time to finish sahur: ten minutes before Subuh, as in the
// Singapore and Malaysian timetables. The fast itself begins at Subuh.
const IMSAK_MS = 10 * 60_000;

/**
 * During Ramadan: the fasting times that matter now. Until Maghrib that's today's fast;
 * from Maghrib, when today's fast has ended, it's tomorrow's (for sahur) and tonight's Isyak.
 */
function FastTimes({ faith, ramadan, now }: { faith: FaithState; ramadan: NonNullable<FaithState['ramadan']>; now: number }) {
  const today = faith.today!;
  const tz = faith.settings.timezone;
  const tomorrow = faith.tomorrow;
  const evening = now >= Date.parse(today.times.maghrib) && !!tomorrow && today.date < ramadan.end;
  const day = evening ? tomorrow : today.times;
  const imsak = hhmm(new Date(Date.parse(day.fajr) - IMSAK_MS).toISOString(), tz);
  const rows = [
    { label: 'Fast begins', at: day.fajr, sub: evening ? `Tomorrow · Imsak ${imsak}` : `Imsak ${imsak}` },
    { label: 'Fast ends', at: day.maghrib, sub: evening ? 'Tomorrow · iftar' : 'Maghrib · iftar' },
    { label: 'Isyak', at: today.times.isha, sub: evening ? 'Tonight · tarawih' : 'Then tarawih' },
  ];
  const upcoming = rows.filter((r) => Date.parse(r.at) > now);
  const next = upcoming.length ? upcoming.reduce((a, r) => (Date.parse(r.at) < Date.parse(a.at) ? r : a)) : null;
  return (
    <dl className="ramadan-dates ramadan-times">
      {rows.map((r) => (
        <div key={r.label} className={cx(r === next && 'is-next', Date.parse(r.at) <= now && 'is-past')}>
          <dt>{r.label}</dt>
          <dd className="ramadan-time">{hhmm(r.at, tz)}</dd>
          <dd className="ramadan-sub">{r === next ? `in ${untilLabel(r.at, now)}` : r.sub}</dd>
        </div>
      ))}
    </dl>
  );
}

function RamadanCountdown({ ramadan, faith, now }: { ramadan: NonNullable<FaithState['ramadan']>; faith: FaithState; now: number }) {
  const long = (d: string) => parseDay(d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const short = (d: string) => parseDay(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (ramadan.inRamadan)
    return (
      <div className="ramadan">
        <div className="ramadan-head">
          <span className="ramadan-count num">{ramadan.day}</span>
          {/* Read as the Hijri date, e.g. "5 Ramadan". */}
          <b>Ramadan</b>
          <MoonStar size={22} className="ramadan-moon" />
        </div>
        {faith.configured && faith.today && <FastTimes faith={faith} ramadan={ramadan} now={now} />}
        <p className="ramadan-note">
          Ramadan Mubarak — began {long(ramadan.start)}.{faith.configured ? ` Times for ${faith.settings.label || faith.settings.timezone.replaceAll('_', ' ')}.` : ''}
        </p>
      </div>
    );
  // Islamic days begin at sunset, so the first tarawih is prayed after Isha on the
  // evening before 1 Ramadan, and the first fast is 1 Ramadan itself.
  const tarawih = addDays(ramadan.start, -1);
  return (
    <div className="ramadan">
      <div className="ramadan-head">
        <span className="ramadan-count num">{ramadan.daysUntil}</span>
        <b>{ramadan.daysUntil === 1 ? 'day' : 'days'} until Ramadan</b>
        <MoonStar size={22} className="ramadan-moon" />
      </div>
      <dl className="ramadan-dates">
        <div>
          <dt>First tarawih</dt>
          <dd>{tarawih === todayStr() ? 'Tonight' : short(tarawih)}</dd>
          <dd className="ramadan-sub">Night, after Isha</dd>
        </div>
        <div>
          <dt>First fast</dt>
          <dd>{short(ramadan.start)}</dd>
          <dd className="ramadan-sub">Suhoor before Fajr</dd>
        </div>
      </dl>
      <p className="ramadan-note">Expected dates — confirmed by the local moon sighting.</p>
    </div>
  );
}

/**
 * The fast a niyyah can be made for right now: from Maghrib on the eve of a Ramadan
 * day until that day's Fajr, since the Islamic day begins at sunset.
 */
export function niyyahFast(faith: FaithState, now: number): { date: string; day: number; fajr: string | null } | null {
  const r = faith.ramadan;
  const today = faith.today;
  if (!faith.configured || !r || !today) return null;
  const t = today.times;
  let date: string;
  let fajr: string | null;
  if (now < Date.parse(t.fajr)) [date, fajr] = [today.date, t.fajr];
  // Tomorrow's Fajr isn't known here; a day after today's is near enough, and the
  // data is refetched each minute, so past midnight the branch above takes over.
  else if (now >= Date.parse(t.maghrib) && now < Date.parse(t.fajr) + 86_400_000) [date, fajr] = [addDays(today.date, 1), null];
  else return null;
  if (date < r.start || date > r.end) return null;
  return { date, day: Math.round((parseDay(date).getTime() - parseDay(r.start).getTime()) / 86_400_000) + 1, fajr };
}

const NIYYAH = {
  arabic: 'نَوَيْتُ صَوْمَ غَدٍ عَنْ أَدَاءِ فَرْضِ شَهْرِ رَمَضَانَ هٰذِهِ السَّنَةِ لِلّٰهِ تَعَالَى',
  transliteration: 'Nawaitu ṣauma ghadin ʿan adāʾi farḍi shahri Ramaḍāna hādhihis-sanati lillāhi taʿālā.',
  meaning: 'I intend to fast tomorrow, fulfilling the obligation of the month of Ramadan this year, for the sake of Allah the Most High.',
};

const niyyahKey = (date: string) => `niyyah-done:${date}`;
function readDone(date: string): boolean {
  try {
    return localStorage.getItem(niyyahKey(date)) === '1';
  } catch {
    return false;
  }
}

/** On each night before a Ramadan fast: the intention for tomorrow's fast. */
function NiyyahCard({ fast, now, tz }: { fast: { date: string; day: number; fajr: string | null }; now: number; tz: string }) {
  const [done, setDone] = useState(() => readDone(fast.date));
  useEffect(() => setDone(readDone(fast.date)), [fast.date]);
  const mark = (v: boolean) => {
    setDone(v);
    try {
      if (v) localStorage.setItem(niyyahKey(fast.date), '1');
      else localStorage.removeItem(niyyahKey(fast.date));
    } catch {
      /* the card still works for this visit */
    }
  };
  const when = fast.fajr ? `Before Fajr at ${hhmm(fast.fajr, tz)} · in ${untilLabel(fast.fajr, now)}` : 'Tonight, before Fajr';
  if (done)
    return (
      <div className="niyyah is-done">
        <Check size={15} strokeWidth={2.6} />
        <span>Niyyah made for the fast of {fast.day} Ramadan</span>
        <button type="button" className="link" onClick={() => mark(false)}>
          Show again
        </button>
      </div>
    );
  return (
    <section className="niyyah" aria-labelledby="niyyah-title">
      <div className="niyyah-head">
        <div>
          <span className="niyyah-eyebrow">{when}</span>
          <h2 id="niyyah-title">Niyyah for the fast of {fast.day} Ramadan</h2>
        </div>
        <MoonStar size={20} className="niyyah-moon" />
      </div>
      <p className="niyyah-arabic" lang="ar" dir="rtl">
        {NIYYAH.arabic}
      </p>
      <p className="niyyah-translit">{NIYYAH.transliteration}</p>
      <p className="niyyah-meaning">“{NIYYAH.meaning}”</p>
      <div className="niyyah-foot">
        <span>The intention is made in the heart; saying it is recommended.</span>
        <button type="button" className="btn btn-sm niyyah-done" onClick={() => mark(true)}>
          <Check size={14} strokeWidth={2.6} /> Done
        </button>
      </div>
    </section>
  );
}

/** The ayat of one entry in VERSES, in order. */
function tracksOf(index: number): Track[] {
  const v = VERSES[index]!;
  const [surah, range] = v.ref.split(':') as [string, string];
  const first = Number(range.split('-')[0]);
  return v.arabic.map((_, i) => ({ surah: Number(surah), ayah: first + i, verse: index }));
}

/** Outside Ramadan: a verse of encouragement and calm, a new one each day. */
function VerseCard({ date }: { date: string }) {
  const [offset, setOffset] = useState(0);
  const { pb, toggle, halt } = useRecitation();
  const active = pb.state === 'playing' || pb.state === 'paused' || pb.state === 'loading' ? pb : null;
  // While all seven saving verses are recited, the card shows the one being read.
  const index = active?.set === 'munjiyat' ? active.track.verse : (verseIndexFor(date) + offset) % VERSES.length;
  // Keep the card on the verse being recited, so it stays there when the set ends.
  const following = active?.set === 'munjiyat' ? active.track.verse : null;
  useEffect(() => {
    if (following !== null) setOffset((((following - verseIndexFor(date)) % VERSES.length) + VERSES.length) % VERSES.length);
  }, [following, date]);
  const v = VERSES[index]!;
  const tracks = tracksOf(index);
  const first = tracks[0]!.ayah;
  const reciting = active && active.track.verse === index ? active.track.ayah : null;
  const verseSet = `verse:${index}`;
  const stateOf = (set: string) => (active?.set === set ? (active.state === 'paused' ? 'other' : active.state) : 'other');
  const seventh = v.munjiyat ? MUNJIYAT.indexOf(index) + 1 : 0;
  // The translation is kept verbatim; only a trailing dash or comma, left where the
  // sentence runs on into the next ayah, is dropped for display.
  const english = v.english.replace(/[\s,;:\-–—]+$/, '');
  return (
    <section className="card verse-card" aria-label="Verse of the day">
      <div className="verse-head">
        <span className="verse-eyebrow">{seventh ? `Seven saving verses · ${seventh} of 7` : offset ? 'Another verse' : 'Verse for today'}</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            halt();
            // The verse after the one on show (which, mid-set, may not be today's plus the offset).
            setOffset((((index + 1 - verseIndexFor(date)) % VERSES.length) + VERSES.length) % VERSES.length);
          }}
        >
          Another <ChevronRight size={13} />
        </button>
      </div>
      <p className="verse-arabic" lang="ar" dir="rtl">
        {v.arabic.map((a, i) => (
          <span key={i} className={cx(v.arabic.length > 1 && reciting === first + i && 'is-reciting')}>
            {a} <span className="verse-end">﴿{arabicDigits(first + i)}﴾</span>{' '}
          </span>
        ))}
      </p>
      <p className="verse-english">{english.charAt(0).toUpperCase() + english.slice(1)}</p>
      <div className="verse-foot">
        <button
          type="button"
          className={cx('verse-play', stateOf(verseSet) === 'playing' && 'is-playing')}
          onClick={() => toggle(verseSet, tracks)}
          aria-label={stateOf(verseSet) === 'playing' ? 'Pause recitation' : 'Play recitation'}
        >
          <PlayIcon state={stateOf(verseSet)} />
        </button>
        <div className="verse-meta">
          <a href={`https://quran.com/${v.ref}`} target="_blank" rel="noreferrer">
            {v.surah} {v.ref.replace('-', '–')}
          </a>
          <span>{pb.state === 'error' ? 'Recitation couldn’t load — try again' : `Recited by ${RECITER} · Abdel Haleem translation`}</span>
        </div>
        {v.munjiyat && (
          <button
            type="button"
            className={cx('btn btn-ghost btn-sm verse-all', active?.set === 'munjiyat' && 'is-on')}
            onClick={() => toggle('munjiyat', MUNJIYAT.flatMap(tracksOf))}
            aria-label={stateOf('munjiyat') === 'playing' ? 'Pause the seven saving verses' : 'Play all seven saving verses'}
          >
            <PlayIcon state={stateOf('munjiyat')} /> {active?.set === 'munjiyat' ? `${seventh} of 7` : 'All seven'}
          </button>
        )}
      </div>
    </section>
  );
}

/** The verse card for the Faith sphere: outside Ramadan, and not while the niyyah card is up. */
export function FaithVerse() {
  const { data: faith } = useFaith();
  const now = useNow();
  if (!faith || faith.ramadan?.inRamadan || niyyahFast(faith, now)) return null;
  return <VerseCard date={faith.today?.date ?? todayStr()} />;
}

export function PrayerCard() {
  const { data: faith } = useFaith();
  const now = useNow();
  const [editing, setEditing] = useState(false);
  if (!faith) return null;
  const tz = faith.settings.timezone;
  const travelling = faith.configured && tz !== deviceTz();
  const curDay = currentDay(faith);
  const lastNight = curDay && curDay !== faith.today ? curDay : undefined;
  const fast = niyyahFast(faith, now);

  return (
    <>
      {fast && <NiyyahCard fast={fast} now={now} tz={tz} />}
      {faith.ramadan && (faith.ramadan.inRamadan || faith.ramadan.daysUntil <= 100) && <RamadanCountdown ramadan={faith.ramadan} faith={faith} now={now} />}
      <section className="card prayer-card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Prayer</h2>
            <span className="hint">{faith.hijri}</span>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
            {faith.configured ? (
              <>
                <MapPin size={13} /> {faith.settings.label || 'Location'} <Pencil size={12} />
              </>
            ) : (
              'Set location'
            )}
          </button>
        </div>

        {!faith.configured ? (
          <div className="card-body">
            <p className="muted">Set your location to see today's prayer times and keep track of each prayer.</p>
            <button type="button" className="btn btn-primary" style={{ marginTop: 10 }} onClick={() => setEditing(true)}>
              <LocateFixed size={15} /> Set location
            </button>
          </div>
        ) : (
          <>
            {travelling && (
              <p className="prayer-note">
                Your device is on {deviceTz().replaceAll('_', ' ')} time but prayer times are for {faith.settings.label || tz}.{' '}
                <button type="button" className="link" onClick={() => setEditing(true)}>
                  Update location
                </button>
              </p>
            )}
            <ul className="prayer-list">
              {lastNight && faith.current && (
                <li className="prayer-row is-current">
                  <span className="prayer-name">{NAME.isha}</span>
                  <span className="prayer-time num">{hhmm(lastNight.times.isha, tz)}</span>
                  <span className="prayer-when">last night · ends in {untilLabel(faith.current.endsAt, now)}</span>
                  <StatusButtons date={lastNight.date} prayer="isha" status={lastNight.log.isha} />
                </li>
              )}
              {PRAYERS.map((p) => {
                const isCurrent = faith.current?.prayer === p && curDay === faith.today;
                const isNext = faith.next?.prayer === p && Date.parse(faith.next.at) > now && Date.parse(faith.next.at) - now < 18 * 3_600_000 && faith.next.at === faith.today!.times[p];
                const started = Date.parse(faith.today!.times[p]) <= now;
                return (
                  <li key={p} className={cx('prayer-row', isCurrent && 'is-current')}>
                    <span className="prayer-name">{NAME[p]}</span>
                    <span className="prayer-time num">{hhmm(faith.today!.times[p], tz)}</span>
                    <span className="prayer-when">
                      {isCurrent && faith.current ? `ends in ${untilLabel(faith.current.endsAt, now)}` : isNext ? `in ${untilLabel(faith.next!.at, now)}` : ''}
                    </span>
                    <StatusButtons date={faith.today!.date} prayer={p} status={faith.today!.log[p]} disabled={!started} />
                  </li>
                );
              })}
            </ul>

            <WeekGrid faith={faith} now={now} />
          </>
        )}

        <QadaPanel owed={faith.owed} />
      </section>
      {editing && <LocationSheet faith={faith} onClose={() => setEditing(false)} />}
    </>
  );
}

/** A small pill for Today: the prayer whose time it is, or the next one. */
export function NextPrayerPill() {
  const { data: faith } = useFaith();
  const now = useNow();
  if (!faith?.configured || !faith.today) return null;
  const tz = faith.settings.timezone;
  const cur = faith.current;
  const unprayed = cur && !currentDay(faith)?.log[cur.prayer];
  const label = cur && unprayed ? `${NAME[cur.prayer]} · ends at ${hhmm(cur.endsAt, tz)} · in ${untilLabel(cur.endsAt, now)}` : faith.next ? `${NAME[faith.next.prayer]} at ${hhmm(faith.next.at, tz)} · in ${untilLabel(faith.next.at, now)}` : null;
  if (!label) return null;
  return (
    <span className="glass-pill">
      <MoonStar size={13} /> {label}
    </span>
  );
}
