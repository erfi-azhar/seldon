// Prayer: today's times where you are, a log of each prayer, what is still to make
// up, and a countdown to Ramadan when it is near.

import { useQuery } from '@tanstack/react-query';
import { Check, Clock, LocateFixed, MapPin, MoonStar, Pencil, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PRAYERS, type FaithState, type PrayerDay, type PrayerName, type PrayerStatus } from '../../../shared/types.ts';
import { api, faithWrite, useFaith, useWrite } from '../api.ts';
import { addDays, cx, parseDay, plural, todayStr } from '../lib.ts';
import { Field, Modal } from './ui.tsx';

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

function StatusButtons({ date, prayer, status, disabled, offerMissed = true }: { date: string; prayer: PrayerName; status: PrayerStatus | undefined; disabled?: boolean; offerMissed?: boolean }) {
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
      {offerMissed && (
        <button type="button" className="pb pb-missed" aria-pressed={shown === 'missed'} disabled={disabled} onClick={() => set('missed')} title="Missed — add to prayers to make up">
          <X size={13} strokeWidth={2.8} />
          <span className="sr-only">Missed</span>
        </button>
      )}
    </div>
  );
}

function RamadanCountdown({ ramadan }: { ramadan: NonNullable<FaithState['ramadan']> }) {
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
        <p className="ramadan-note">Ramadan Mubarak — began {long(ramadan.start)}.</p>
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

export function PrayerCard() {
  const { data: faith } = useFaith();
  const now = useNow();
  const [editing, setEditing] = useState(false);
  const qada = useWrite(faithWrite.qada);
  const [backlog, setBacklog] = useState<{ prayer: PrayerName; n: string } | null>(null);
  if (!faith) return null;
  const tz = faith.settings.timezone;
  const travelling = faith.configured && tz !== deviceTz();
  const owedTotal = PRAYERS.reduce((n, p) => n + faith.owed[p], 0);
  const today = todayStr();
  const curDay = currentDay(faith);
  const lastNight = curDay && curDay !== faith.today ? curDay : undefined;

  return (
    <>
      {faith.ramadan && (faith.ramadan.inRamadan || faith.ramadan.daysUntil <= 100) && <RamadanCountdown ramadan={faith.ramadan} />}
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

            <div className="prayer-week" aria-label="The last seven days">
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
                    <i key={d.date} className={cx('pw-dot', d.log[p] && `pw-${d.log[p]}`)} title={`${NAME[p]}, ${d.date}: ${d.log[p] ?? 'not marked'}`} />
                  ))}
                </div>
              ))}
            </div>

            {faith.autoMissed.length > 0 && (
              <div className="prayer-unmarked">
                <div className="list-label" style={{ padding: '0 0 4px' }}>
                  Missed — time passed
                </div>
                <ul>
                  {faith.autoMissed.slice(0, 6).map((u) => (
                    <li key={`${u.date}-${u.prayer}`} className="prayer-row">
                      <span className="prayer-name">{NAME[u.prayer]}</span>
                      <span className="prayer-when">{u.date === today ? 'today' : parseDay(u.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                      <span className="prayer-missed-tag">Missed</span>
                      {/* Prayed after all? Mark it, and it comes off the make-up count. */}
                      <StatusButtons date={u.date} prayer={u.prayer} status="missed" offerMissed={false} />
                    </li>
                  ))}
                </ul>
                {faith.autoMissed.length > 6 && <span className="hint">and {faith.autoMissed.length - 6} more earlier this week</span>}
              </div>
            )}
          </>
        )}

        <div className="prayer-qada">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>To make up</b>
            <span className="hint">{owedTotal ? plural(owedTotal, 'prayer') : 'Nothing owed'}</span>
          </div>
          <div className="qada-grid">
            {PRAYERS.map((p) => (
              <div key={p} className="qada">
                <span className="hint">{NAME[p]}</span>
                <b className="num">{faith.owed[p]}</b>
                <div className="row" style={{ gap: 2 }}>
                  <button type="button" className="icon-btn icon-btn-sm" disabled={!faith.owed[p] || qada.isPending} onClick={() => qada.mutate({ prayer: p, delta: -1 })} aria-label={`Made up one ${NAME[p]}`} title="Made one up">
                    <Check size={13} />
                  </button>
                  <button type="button" className="icon-btn icon-btn-sm" onClick={() => setBacklog({ prayer: p, n: '' })} aria-label={`Add earlier missed ${NAME[p]}`} title="Add earlier missed prayers">
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>
          {backlog && (
            <form
              className="row"
              style={{ marginTop: 10 }}
              onSubmit={(e) => {
                e.preventDefault();
                const n = Math.round(Number(backlog.n));
                if (n > 0) qada.mutate({ prayer: backlog.prayer, delta: n }, { onSuccess: () => setBacklog(null) });
              }}
            >
              <span className="hint grow">Missed {NAME[backlog.prayer]} prayers from before you started tracking:</span>
              <input className="input num" style={{ width: 90 }} type="number" min={1} autoFocus value={backlog.n} onChange={(e) => setBacklog({ ...backlog, n: e.target.value })} aria-label="How many" />
              <button type="submit" className="btn btn-sm">
                Add
              </button>
            </form>
          )}
        </div>
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
  const label = cur && unprayed ? `${NAME[cur.prayer]} · ends in ${untilLabel(cur.endsAt, now)}` : faith.next ? `${NAME[faith.next.prayer]} at ${hhmm(faith.next.at, tz)} · in ${untilLabel(faith.next.at, now)}` : null;
  if (!label) return null;
  return (
    <span className="glass-pill">
      <MoonStar size={13} /> {label}
      {faith.ramadan && !faith.ramadan.inRamadan && faith.ramadan.daysUntil <= 100 && <span className="faint"> · Ramadan in {faith.ramadan.daysUntil}d</span>}
    </span>
  );
}
