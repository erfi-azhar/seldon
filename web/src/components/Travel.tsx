// Travel: your KrisFlyer and Bonvoy standing, trips with their flights and stays, an
// editable day plan — and on Today, a travel-mode card that changes with the moment:
// the flight you are about to take and the lounge you can use, the layover and what to
// do with it, or the day you are on when away.

import { ArrowLeft, BedDouble, ShieldCheck, Briefcase, CalendarDays, Camera, Check as CheckIcon, ChevronDown, ChevronRight, Clock, Hotel, ListChecks, Loader2, MapPin, Palmtree, Pencil, Plane, PlaneTakeoff, Plus, Route, Sofa, Sparkles, Star, Trash2, Wand2 } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearch as useUrlSearch } from 'wouter';
import type { Cabin, EliteNights, FlightOption, ItineraryItem, LoungePick, LoyaltyAccount, Segment, StayOption, TravelState, Trip, TripPurpose } from '../../../shared/types.ts';
import { postForm, travelWrite, useTravel, useWrite } from '../api.ts';
import { cx, daysFrom, formatNumber, parseDay, parseNumber, plural, shortDay, todayStr } from '../lib.ts';
import { useApp } from '../state.tsx';
import { untilLabel, useNow } from './Prayer.tsx';
import { AddTask, TaskRow } from './rows.tsx';
import { AirlineTail } from './Tails.tsx';
import { NowPanel, RouteCard, WelcomeTitle } from './Journey.tsx';
import { ItemModules } from './ItemModules.tsx';
import { TripGuideBody } from './TripGuide.tsx';
import { activeJourney, boardsAt, checkInCloses, clock, delayOf, departs, lands, span, journeys, leaveBy, reachAirportBy, type Journey } from '../../../shared/journey.ts';
import { layoverPlan, type LayoverPlan } from '../layover.ts';
import { RouteGlobe, type GlobeLeg } from './Globe.tsx';
import { Check, Field, Modal, ScrollBlur, Seg, Spinner, useScrollEdges } from './ui.tsx';

// ── Small helpers ───────────────────────────────────────────────────────────

const time = (local: string) => local.slice(11, 16);
const dayOf = (local: string) => local.slice(0, 10);
const weekday = (date: string) => parseDay(date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const dates = (from: string, to: string) => (from === to ? shortDay(from) : `${shortDay(from)} – ${shortDay(to)}`);
const duration = (s: Segment) => {
  const mins = Math.round((Date.parse(s.endUtc) - Date.parse(s.startUtc)) / 60_000);
  return mins > 0 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : '';
};
const hm = (mins: number) => (mins > 0 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : '');
/** The time now in an airport's zone, "14:05"; the device's own when the zone is unknown. */
const clockIn = (tz: string, now: number) => {
  try {
    return new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || undefined });
  } catch {
    return new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
};
const minutesBetween = (fromUtc: string, toUtc: string) => Math.round((Date.parse(toUtc) - Date.parse(fromUtc)) / 60_000);
/** A hotel's everyday name: "The Mercury Garden Shenzhen Nanshan, A Tribute Portfolio Hotel" → before the comma. */
const shortStay = (title: string) => title.split(',')[0]!.trim() || title;
/** The airports a run of flights touches, in order: "SZX → SIN → FRA → GRU". */
const routeLine = (flights: Segment[]) =>
  flights
    .flatMap((f, i) => (i > 0 && flights[i - 1]!.toCode === f.fromCode ? [f.toCode] : [f.fromCode, f.toCode]))
    .filter(Boolean)
    .join(' → ');
const nightsOf = (s: Segment) => Math.max(0, daysFrom(dayOf(s.startLocal), dayOf(s.endLocal)));
const city = (name: string, code: string) => name.replace(/ (International|Airport)$/, '') || code;

function whenLabel(trip: Trip, today: string): string {
  if (trip.startDate > today) {
    const d = daysFrom(today, trip.startDate);
    return d === 1 ? 'tomorrow' : `in ${d} days`;
  }
  if (trip.endDate < today) return 'past';
  return `day ${daysFrom(trip.startDate, today) + 1} of ${daysFrom(trip.startDate, trip.endDate) + 1}`;
}

function PurposeChip({ purpose }: { purpose: TripPurpose }) {
  return (
    <span className={cx('chip', 'trip-purpose', `trip-${purpose}`)}>
      {purpose === 'work' ? <Briefcase size={11} /> : <Palmtree size={11} />} {purpose === 'work' ? 'Work' : 'Leisure'}
    </span>
  );
}

// ── Loyalty ─────────────────────────────────────────────────────────────────

const TIERS: Record<string, string[]> = {
  KrisFlyer: ['KrisFlyer', 'Elite Silver', 'Elite Gold', 'PPS Club', 'Solitaire PPS Club'],
  'Marriott Bonvoy': ['Member', 'Silver Elite', 'Gold Elite', 'Platinum Elite', 'Titanium Elite', 'Ambassador Elite'],
  'Priority Pass': ['Standard', 'Standard Plus', 'Prestige'],
};

/** A tone for the card from the tier: silver, gold, platinum-dark. */
function tierTone(a: LoyaltyAccount): string {
  const t = a.tier.toLowerCase();
  if (/solitaire|ambassador|titanium/.test(t)) return 'onyx';
  if (/pps|platinum/.test(t)) return 'navy';
  if (/gold/.test(t)) return 'gold';
  if (/silver/.test(t)) return 'silver';
  return a.kind === 'hotel' ? 'plum' : a.kind === 'lounge' ? 'slate' : 'sky';
}

function LoyaltySheet({ account, onClose }: { account: LoyaltyAccount | null; onClose: () => void }) {
  const [program, setProgram] = useState(account?.program ?? 'KrisFlyer');
  const [custom, setCustom] = useState(account && !TIERS[account.program] ? account.program : '');
  const [f, setF] = useState({
    tier: account?.tier ?? '',
    points: account?.points?.toString() ?? '',
    progress: account?.progress?.toString() ?? '',
    target: account?.progressTarget?.toString() ?? '',
    label: account?.progressLabel ?? '',
    expires: account?.expires ?? '',
    suffix: account?.memberSuffix ?? '',
  });
  const save = useWrite((b: object) => travelWrite.put('/loyalty', b));
  const remove = useWrite((id: string) => travelWrite.del(`/loyalty/${id}`));
  const num = (s: string) => (s.trim() === '' ? null : parseNumber(s));
  const name = program === 'other' ? custom : program;
  const tiers = TIERS[program];
  const defaults: Record<string, string> = { KrisFlyer: 'elite miles to next tier', 'Marriott Bonvoy': 'nights this year' };
  return (
    <Modal
      title={account ? account.program : 'Add a programme'}
      onClose={onClose}
      footer={
        <>
          {account ? (
            <button className="btn btn-ghost btn-sm danger" onClick={() => remove.mutate(account.id, { onSuccess: onClose })}>
              <Trash2 size={13} /> Remove
            </button>
          ) : (
            <span className="hint">Or send Seldon a screenshot of the app.</span>
          )}
          <button
            className="btn btn-primary btn-sm"
            disabled={!name.trim()}
            onClick={() =>
              save.mutate(
                { program: name, tier: f.tier, points: num(f.points), progress: num(f.progress), progressTarget: num(f.target), progressLabel: f.label || defaults[program] || '', expires: f.expires || null, memberSuffix: f.suffix },
                { onSuccess: onClose },
              )
            }
          >
            Save
          </button>
        </>
      }
    >
      {!account && (
        <Field label="Programme">
          <Seg
            label="Programme"
            value={program}
            onChange={setProgram}
            options={[
              { value: 'KrisFlyer', label: 'KrisFlyer' },
              { value: 'Marriott Bonvoy', label: 'Bonvoy' },
              { value: 'Priority Pass', label: 'Priority Pass' },
              { value: 'other', label: 'Other' },
            ]}
          />
        </Field>
      )}
      {program === 'other' && !account && (
        <Field label="Name">
          <input className="input" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. Qatar Privilege Club" />
        </Field>
      )}
      <div className="field-row">
        <Field label="Tier">
          {tiers ? (
            <select className="input" value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })}>
              <option value="">—</option>
              {tiers.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          ) : (
            <input className="input" value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })} />
          )}
        </Field>
        <Field label={program === 'KrisFlyer' ? 'Miles' : 'Points'}>
          <input className="input num" inputMode="numeric" value={f.points} onChange={(e) => setF({ ...f, points: e.target.value })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Towards next tier" hint={defaults[program] ?? 'Elite miles, nights or similar'}>
          <input className="input num" inputMode="numeric" value={f.progress} onChange={(e) => setF({ ...f, progress: e.target.value })} />
        </Field>
        <Field label="Out of">
          <input className="input num" inputMode="numeric" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Status or miles expire">
          <input className="input" type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} />
        </Field>
        <Field label="Member number" hint="Only the last four digits are kept.">
          <input className="input num" inputMode="numeric" value={f.suffix} onChange={(e) => setF({ ...f, suffix: e.target.value })} placeholder="•••• 1234" />
        </Field>
      </div>
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

function LoyaltyCard({ a, onEdit }: { a: LoyaltyAccount; onEdit: () => void }) {
  const unit = a.kind === 'airline' ? 'miles' : a.kind === 'hotel' ? 'points' : '';
  const frac = a.progress !== null && a.progressTarget ? Math.min(1, a.progress / a.progressTarget) : null;
  return (
    <button type="button" className={cx('loyalty-card', `tone-${tierTone(a)}`)} onClick={onEdit}>
      <div className="lc-top">
        <span className="lc-program">{a.program}</span>
        {a.memberSuffix && <span className="lc-number num">•••• {a.memberSuffix}</span>}
      </div>
      <div className="lc-tier">{a.tier || '—'}</div>
      <div className="lc-points">
        {a.points !== null ? (
          <>
            <b className="num">{formatNumber(a.points)}</b> {unit}
          </>
        ) : (
          <span className="faint">Add your balance</span>
        )}
      </div>
      {frac !== null && (
        <div className="lc-progress">
          <div className="lc-bar">
            <i style={{ width: `${frac * 100}%` }} />
          </div>
          <span>
            {formatNumber(a.progress!)} / {formatNumber(a.progressTarget!)} {a.progressLabel}
          </span>
        </div>
      )}
      <div className="lc-foot">
        {a.expires ? `Expires ${shortDay(a.expires)}` : ''}
        <span>Updated {shortDay(a.updatedAt.slice(0, 10))}</span>
      </div>
    </button>
  );
}

// ── Import ──────────────────────────────────────────────────────────────────

function ImportSheet({ onClose }: { onClose: () => void }) {
  const { toast, agentName } = useApp();
  const [text, setText] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const done = (r: TravelState & { imported?: { segments: number; loyalty: string[]; cancellation: boolean } }) => {
    const i = r.imported;
    const parts = [i?.segments ? plural(i.segments, 'booking') : '', i?.loyalty.length ? i.loyalty.join(' and ') : ''].filter(Boolean);
    toast({ message: i?.cancellation ? 'That looks like a cancellation — check the trip.' : parts.length ? `Added ${parts.join(', ')}` : 'Nothing new in that.' });
    onClose();
  };
  const fromText = useWrite(() => travelWrite.post('/import', { text }));
  const fromImage = useWrite((f: File) => {
    const form = new FormData();
    form.set('file', f);
    form.set('text', text);
    return postForm<TravelState>('/travel/import', form);
  });
  const busy = fromText.isPending || fromImage.isPending;
  const error = fromText.error ?? fromImage.error;
  return (
    <Modal
      title="Add from a confirmation"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-sm" disabled={busy} onClick={() => file.current?.click()}>
            <Camera size={14} /> Screenshot
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy || !text.trim()} onClick={() => fromText.mutate(undefined, { onSuccess: done })}>
            {busy ? <Spinner /> : 'Read it'}
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Paste a booking email, or send a screenshot — a boarding pass, a hotel confirmation, or the KrisFlyer or Bonvoy app showing your tier and balance. {agentName} files flights and stays onto the right trip and updates your standing. With Gmail connected this happens on its own.
      </p>
      <textarea className="input" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the confirmation here…" />
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) fromImage.mutate(f, { onSuccess: done });
          e.target.value = '';
        }}
      />
      {busy && (
        <p className="hint">
          <Loader2 size={12} className="spin" /> {agentName} is reading it…
        </p>
      )}
      {error && <p className="error-text">{error.message}</p>}
    </Modal>
  );
}

// ── Trips ───────────────────────────────────────────────────────────────────

function TripSheet({ trip, onClose }: { trip: Trip | null; onClose: () => void }) {
  const today = todayStr();
  const [f, setF] = useState({ title: trip?.title ?? '', destination: trip?.destination ?? '', purpose: trip?.purpose ?? ('leisure' as TripPurpose), startDate: trip?.startDate ?? today, endDate: trip?.endDate ?? today, notes: trip?.notes ?? '' });
  const save = useWrite((b: typeof f) => (trip ? travelWrite.patch(`/trips/${trip.id}`, b) : travelWrite.post('/trips', b)));
  const remove = useWrite(() => travelWrite.del(`/trips/${trip!.id}`));
  return (
    <Modal
      title={trip ? 'Edit trip' : 'New trip'}
      onClose={onClose}
      footer={
        <>
          {trip ? (
            <button className="btn btn-ghost btn-sm danger" onClick={() => confirm(`Delete ${trip.title} and its bookings and plan?`) && remove.mutate(undefined, { onSuccess: onClose })}>
              <Trash2 size={13} /> Delete trip
            </button>
          ) : (
            <span />
          )}
          <button className="btn btn-primary btn-sm" disabled={!f.destination.trim() && !f.title.trim()} onClick={() => save.mutate(f, { onSuccess: onClose })}>
            Save
          </button>
        </>
      }
    >
      <Field label="Where to">
        <input className="input" value={f.destination} onChange={(e) => setF({ ...f, destination: e.target.value })} placeholder="Tokyo" data-autofocus />
      </Field>
      <Field label="Name" hint="Defaults to the destination.">
        <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={f.destination || 'Autumn in Tokyo'} />
      </Field>
      <Field label="Purpose">
        <Seg label="Purpose" value={f.purpose} onChange={(purpose) => setF({ ...f, purpose })} options={[{ value: 'leisure', label: 'Leisure' }, { value: 'work', label: 'Work' }]} />
      </Field>
      <div className="field-row">
        <Field label="From">
          <input className="input" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} />
        </Field>
        <Field label="To">
          <input className="input" type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
        </Field>
      </div>
      <Field label="Notes for Seldon" hint="What it's for, who you're meeting, what you'd love to do.">
        <textarea className="input" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </Field>
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

/** A local wall time ("2026-11-16T08:05") moved later by some minutes, as "08:50", or "00:20 +1" past midnight. */
function laterBy(local: string, minutes: number): string {
  const t = Date.parse(`${local}:00Z`);
  if (Number.isNaN(t)) return '—';
  const moved = new Date(t + minutes * 60_000).toISOString();
  const days = daysFrom(local.slice(0, 10), moved.slice(0, 10));
  return `${moved.slice(11, 16)}${days > 0 ? ` +${days}` : ''}`;
}

function BookingSheet({ trip, segment, onClose }: { trip: Trip; segment: Segment | null; onClose: () => void }) {
  const day = trip.startDate;
  // An existing booking keeps its own kind: a train or event edited here must not turn into a flight.
  const [kind, setKind] = useState<Segment['kind']>(segment?.kind ?? 'flight');
  const [f, setF] = useState({
    carrier: segment?.carrier ?? 'SQ',
    number: segment?.number ?? '',
    fromCode: segment?.fromCode ?? '',
    toCode: segment?.toCode ?? '',
    title: segment?.title ?? '',
    address: segment?.address ?? '',
    startLocal: segment?.startLocal ?? `${day}T${kind === 'stay' ? '15:00' : '09:00'}`,
    endLocal: segment?.endLocal ?? `${day}T${kind === 'stay' ? '12:00' : '12:00'}`,
    cabin: segment?.cabin ?? 'Economy',
    seat: segment?.seat ?? '',
    confirmation: segment?.confirmation ?? '',
    fromTerminal: segment?.fromTerminal ?? '',
    toTerminal: segment?.toTerminal ?? '',
  });
  // Fields this form does not show are left out, so an edit keeps them (a hotel's brand, a train's operator).
  const body = () =>
    kind === 'flight'
      ? { kind, carrier: f.carrier, number: f.number, fromCode: f.fromCode, toCode: f.toCode, startLocal: f.startLocal, endLocal: f.endLocal, cabin: f.cabin, seat: f.seat, confirmation: f.confirmation, fromTerminal: f.fromTerminal, toTerminal: f.toTerminal }
      : kind === 'stay'
        ? { kind, title: f.title, address: f.address, startLocal: f.startLocal, endLocal: f.endLocal, confirmation: f.confirmation }
        : { kind, title: f.title, address: f.address, startLocal: f.startLocal, endLocal: f.endLocal, seat: f.seat, confirmation: f.confirmation };
  // A booked flight can run late: minutes, kept apart from the booking's own times.
  const [delay, setDelay] = useState(String(segment?.delayMin ?? 0));
  const delayMin = /^\d{1,4}$/.test(delay.trim()) ? Number(delay.trim()) : NaN;
  const delayBad = !(delayMin >= 0 && delayMin <= 1440);
  const save = useWrite(async () => {
    if (!segment) return travelWrite.post(`/trips/${trip.id}/segments`, body());
    const saved = await travelWrite.patch(`/segments/${segment.id}`, body());
    if (kind === 'flight' && delayMin !== (segment.delayMin ?? 0)) return travelWrite.post(`/segments/${segment.id}/delay`, { minutes: delayMin });
    return saved;
  });
  const remove = useWrite(() => travelWrite.del(`/segments/${segment!.id}`));
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal
      title={segment ? 'Edit booking' : `Add to ${trip.title}`}
      onClose={onClose}
      footer={
        <>
          {segment ? (
            <button className="btn btn-ghost btn-sm danger" onClick={() => remove.mutate(undefined, { onSuccess: onClose })}>
              <Trash2 size={13} /> Remove
            </button>
          ) : (
            <span className="hint">Times are local to each airport or hotel.</span>
          )}
          <button className="btn btn-primary btn-sm" disabled={kind === 'flight' && !!segment && delayBad} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Save
          </button>
        </>
      }
    >
      {!segment && (
        <Field label="What">
          <Seg<Segment['kind']> label="Booking type" value={kind} onChange={setKind} options={[{ value: 'flight', label: 'Flight' }, { value: 'stay', label: 'Hotel' }]} />
        </Field>
      )}
      {kind !== 'flight' && kind !== 'stay' ? (
        <>
          <Field label={kind === 'train' ? 'Train' : kind === 'car' ? 'Car' : 'Event'}>
            <input className="input" value={f.title} onChange={set('title')} data-autofocus />
          </Field>
          <Field label="Address">
            <input className="input" value={f.address} onChange={set('address')} />
          </Field>
          <div className="field-row">
            <Field label="Starts (local)">
              <input className="input" type="datetime-local" value={f.startLocal} onChange={set('startLocal')} />
            </Field>
            <Field label="Ends (local)">
              <input className="input" type="datetime-local" value={f.endLocal} onChange={set('endLocal')} />
            </Field>
          </div>
          <div className="field-row">
            <Field label="Seat">
              <input className="input num" value={f.seat} onChange={set('seat')} />
            </Field>
            <Field label="Booking reference">
              <input className="input num" value={f.confirmation} onChange={set('confirmation')} />
            </Field>
          </div>
        </>
      ) : kind === 'flight' ? (
        <>
          <div className="field-row">
            <Field label="Airline">
              <input className="input num" value={f.carrier} onChange={set('carrier')} placeholder="SQ" maxLength={3} />
            </Field>
            <Field label="Flight">
              <input className="input num" value={f.number} onChange={set('number')} placeholder="638" data-autofocus />
            </Field>
            <Field label="Cabin">
              <select className="input" value={f.cabin} onChange={set('cabin')}>
                {['Economy', 'Premium Economy', 'Business', 'First', 'Suites'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="field-row">
            <Field label="From (airport code)">
              <input className="input num" value={f.fromCode} onChange={set('fromCode')} placeholder="SIN" maxLength={3} />
            </Field>
            <Field label="To">
              <input className="input num" value={f.toCode} onChange={set('toCode')} placeholder="HND" maxLength={3} />
            </Field>
          </div>
          <div className="field-row">
            <Field label="Departure terminal">
              <input className="input num" value={f.fromTerminal} onChange={set('fromTerminal')} placeholder="3" maxLength={12} />
            </Field>
            <Field label="Arrival terminal">
              <input className="input num" value={f.toTerminal} onChange={set('toTerminal')} placeholder="1" maxLength={12} />
            </Field>
          </div>
          <div className="field-row">
            <Field label="Departs (local)">
              <input className="input" type="datetime-local" value={f.startLocal} onChange={set('startLocal')} />
            </Field>
            <Field label="Arrives (local)">
              <input className="input" type="datetime-local" value={f.endLocal} onChange={set('endLocal')} />
            </Field>
          </div>
          {segment && (
            <Field label="Delay (minutes)" hint={delayBad ? 'Whole minutes, up to 1440 (a day).' : delayMin > 0 ? `Now leaves ${laterBy(f.startLocal, delayMin)} · lands ${laterBy(f.endLocal, delayMin)}` : 'On time. Enter how late it now leaves; arrival moves with it.'}>
              <input className="input num" type="number" inputMode="numeric" min={0} max={1440} step={5} value={delay} onChange={(e) => setDelay(e.target.value)} placeholder="0" aria-invalid={delayBad || undefined} />
            </Field>
          )}
          <div className="field-row">
            <Field label="Seat">
              <input className="input num" value={f.seat} onChange={set('seat')} placeholder="14A" />
            </Field>
            <Field label="Booking reference">
              <input className="input num" value={f.confirmation} onChange={set('confirmation')} />
            </Field>
          </div>
        </>
      ) : (
        <>
          <Field label="Hotel">
            <input className="input" value={f.title} onChange={set('title')} placeholder="The Westin Tokyo" data-autofocus />
          </Field>
          <Field label="Address">
            <input className="input" value={f.address} onChange={set('address')} />
          </Field>
          <div className="field-row">
            <Field label="Check in">
              <input className="input" type="datetime-local" value={f.startLocal} onChange={set('startLocal')} />
            </Field>
            <Field label="Check out">
              <input className="input" type="datetime-local" value={f.endLocal} onChange={set('endLocal')} />
            </Field>
          </div>
          <Field label="Confirmation">
            <input className="input num" value={f.confirmation} onChange={set('confirmation')} />
          </Field>
        </>
      )}
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

const KINDS: { value: ItineraryItem['kind']; label: string }[] = [
  { value: 'activity', label: 'Do' },
  { value: 'food', label: 'Eat' },
  { value: 'transit', label: 'Move' },
  { value: 'work', label: 'Work' },
  { value: 'rest', label: 'Rest' },
];

function ItemSheet({ trip, item, date, onClose }: { trip: Trip; item: ItineraryItem | null; date: string; onClose: () => void }) {
  const [f, setF] = useState({ date: item?.date ?? date, time: item?.time ?? '', title: item?.title ?? '', place: item?.place ?? '', notes: item?.notes ?? '', kind: item?.kind ?? ('activity' as ItineraryItem['kind']) });
  const body = () => ({ ...f, time: f.time || null });
  const save = useWrite(() => (item ? travelWrite.patch(`/itinerary/${item.id}`, body()) : travelWrite.post(`/trips/${trip.id}/itinerary`, body())));
  const remove = useWrite(() => travelWrite.del(`/itinerary/${item!.id}`));
  return (
    <Modal
      title={item ? 'Edit plan' : `Add to ${weekday(date)}`}
      onClose={onClose}
      footer={
        <>
          {item ? (
            <button className="btn btn-ghost btn-sm danger" onClick={() => remove.mutate(undefined, { onSuccess: onClose })}>
              <Trash2 size={13} /> Remove
            </button>
          ) : (
            <span />
          )}
          <button className="btn btn-primary btn-sm" disabled={!f.title.trim()} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Save
          </button>
        </>
      }
    >
      <Field label="What">
        <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Tsukiji outer market" data-autofocus />
      </Field>
      <Seg label="Kind" value={f.kind} onChange={(kind) => setF({ ...f, kind })} options={KINDS} />
      <div className="field-row" style={{ marginTop: 12 }}>
        <Field label="Day">
          <input className="input" type="date" value={f.date} min={trip.startDate} max={trip.endDate} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label="Time" hint="Leave empty for anytime.">
          <input className="input" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
        </Field>
      </div>
      <Field label="Where">
        <input className="input" value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} />
      </Field>
      <Field label="Notes">
        <textarea className="input" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </Field>
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

/** Flights whose airports are known, as legs for the route globe. */
function globeLegs(flights: Segment[]): GlobeLeg[] {
  return flights
    .filter((s) => s.kind === 'flight' && s.fromGeo && s.toGeo)
    .map((s) => ({
      from: { code: s.fromCode, lat: s.fromGeo![0], lon: s.fromGeo![1] },
      to: { code: s.toCode, lat: s.toGeo![0], lon: s.toGeo![1] },
      minutes: Math.max(0, Math.round((Date.parse(s.endUtc) - Date.parse(s.startUtc)) / 60_000)) || undefined,
      carrier: s.carrier,
      id: s.id,
    }));
}

/** Airline names for the codes a Singapore-based traveller meets most; others show their code. */
const AIRLINES: Record<string, string> = {
  SQ: 'Singapore Airlines', TR: 'Scoot', MH: 'Malaysia Airlines', AK: 'AirAsia', OD: 'Batik Air', GA: 'Garuda Indonesia', TG: 'Thai Airways',
  VN: 'Vietnam Airlines', PR: 'Philippine Airlines', CX: 'Cathay Pacific', BR: 'EVA Air', CI: 'China Airlines', CZ: 'China Southern', MU: 'China Eastern',
  CA: 'Air China', NH: 'ANA', JL: 'Japan Airlines', KE: 'Korean Air', OZ: 'Asiana', AI: 'Air India', '6E': 'IndiGo', UL: 'SriLankan Airlines',
  EK: 'Emirates', QR: 'Qatar Airways', EY: 'Etihad', SV: 'Saudia', TK: 'Turkish Airlines', LH: 'Lufthansa', LX: 'Swiss', OS: 'Austrian',
  BA: 'British Airways', AF: 'Air France', KL: 'KLM', ET: 'Ethiopian Airlines', QF: 'Qantas', NZ: 'Air New Zealand', UA: 'United', AA: 'American Airlines',
  DL: 'Delta', AC: 'Air Canada', LA: 'LATAM', G3: 'GOL', AD: 'Azul', TP: 'TAP Air Portugal', IB: 'Iberia',
};

/** A flight as a card: the airline, the two times with the journey between them, then seat and booking reference. */
function FlightRow({ s, onEdit }: { s: Segment; onEdit: () => void }) {
  const until = daysFrom(todayStr(), dayOf(s.startLocal));
  const airline = AIRLINES[s.carrier.toUpperCase()] ?? (s.carrier || 'Flight');
  return (
    <button type="button" className={cx('flight-card', until < 0 && 'is-past')} onClick={onEdit} aria-label={`${airline} ${s.carrier} ${s.number}, ${s.fromCode} to ${s.toCode}, ${weekday(dayOf(s.startLocal))} at ${time(s.startLocal)}. Edit`}>
      <FlightFace s={s} />
    </button>
  );
}

/** In the air, the flight card's route as a live timeline: the time left, and a small plane moving along it each second. */
function LiveTrack({ start, end }: { start: number; end: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const k = Math.min(1, Math.max(0, (now - start) / Math.max(1, end - start)));
  return (
    <>
      <span className="fc-dur">{span((end - now) / 60_000)} left</span>
      <span className="fc-track" role="img" aria-label={`${Math.round(k * 100)}% of the way`}>
        <i className="fc-dot is-done" />
        <span className="fc-live-rail">
          <span className="fc-live-flown" style={{ width: `${k * 100}%` }} />
          <Plane size={14} fill="currentColor" strokeWidth={1.25} className="fc-live-plane" style={{ left: `${k * 100}%` }} />
        </span>
        <i className="fc-dot" />
      </span>
    </>
  );
}

/**
 * A flight as the trip page shows it: the airline and its tail, the times and places at each end,
 * then check-in, boarding, cabin and booking reference. The badge says when it is, unless given.
 */
function FlightFace({ s, badge }: { s: Segment; badge?: { label: string; tone: 'soon' | 'past' | 'late' | 'live' | '' } }) {
  const today = todayStr();
  const day = dayOf(s.startLocal);
  const plus = daysFrom(day, dayOf(s.endLocal));
  const until = daysFrom(today, day);
  const late = until >= 0 ? delayOf(s) : 0;
  const now = Date.now();
  const flying = now >= departs(s) && now < lands(s);
  const when = flying ? { label: 'In flight', tone: 'live' as const } : late > 0 ? { label: `Delayed ${span(late / 60_000)}`, tone: 'late' as const } : (badge ?? { label: until < 0 ? 'Flown' : until === 0 ? 'Today' : until === 1 ? 'Tomorrow' : weekday(day), tone: until < 0 ? 'past' : until <= 1 ? 'soon' : '' });
  // A late flight shows its new times, the booked ones struck through beside them.
  const shown = (local: string, tz: string, utc: string) =>
    late > 0 ? (
      <>
        <s className="fc-was">{time(local)}</s> {clock(Date.parse(utc) + late, tz)}
      </>
    ) : (
      time(local)
    );
  const code = s.carrier.toUpperCase();
  const airline = AIRLINES[code] ?? (s.carrier || 'Flight');
  const place = (c: string, city: string | undefined, name: string) => [c, city || name].filter(Boolean).join(' · ') || '—';
  const details = [s.cabin, s.seat && `Seat ${s.seat}`].filter(Boolean).join(' · ');
  const elite = flightElite(s);
  return (
    <>
      <span className="fc-head">
        <span className="fc-logo" aria-hidden>
          <AirlineTail code={code} size={40} />
        </span>
        <span className="fc-airline">
          <b>{airline}</b>
          <span>{`${s.carrier} ${s.number}`.trim()}</span>
        </span>
        <span className={cx('fc-badge', when.tone === 'past' ? 'is-past' : when.tone === 'soon' ? 'is-soon' : when.tone === 'late' ? 'is-late' : when.tone === 'live' ? 'is-live' : '')}>{when.label}</span>
      </span>
      <span className="fc-route">
        <span className="fc-end">
          <b className="fc-time">{shown(s.startLocal, s.startTz, s.startUtc)}</b>
          <span className="fc-place">{place(s.fromCode, s.fromCity, s.fromName)}</span>
          {s.fromTerminal && <span className="fc-terminal">Terminal {s.fromTerminal}</span>}
        </span>
        <span className="fc-mid">
          {flying ? (
            <LiveTrack start={departs(s)} end={lands(s)} />
          ) : (
            <>
              <span className="fc-dur">{duration(s)}</span>
              <span className="fc-track" aria-hidden>
                <i className="fc-dot" />
                <i className="fc-rule" />
                <Plane size={13} />
                <i className="fc-rule" />
                <i className="fc-dot" />
              </span>
            </>
          )}
          <span className="fc-stops">Nonstop</span>
        </span>
        <span className="fc-end is-arrival">
          <b className="fc-time">
            {shown(s.endLocal, s.endTz, s.endUtc)}
            {plus > 0 && <sup>+{plus}</sup>}
          </b>
          <span className="fc-place">{place(s.toCode, s.toCity, s.toName)}</span>
          {s.toTerminal && <span className="fc-terminal">Terminal {s.toTerminal}</span>}
        </span>
      </span>
      <span className="fc-facts">
        {until >= 0 && (
          <>
            <span className="fc-fact">
              <small>Check-in closes</small>
              <b className="num">{clock(checkInCloses(s), s.startTz)}</b>
            </span>
            <span className="fc-fact">
              <small>Boards</small>
              <b className="num">~{clock(boardsAt(s), s.startTz)}</b>
            </span>
          </>
        )}
        <span className="fc-fact">
          <small>{s.cabin ? 'Cabin' : 'Seat'}</small>
          <b>{details || (until >= 0 ? <span className="fc-add">Add cabin and seat</span> : '—')}</b>
        </span>
        {elite && (
          <span className="fc-fact" title={elite.why}>
            <small>Elite miles</small>
            <b className="num">{elite.elite ? `≈ ${elite.elite.toLocaleString()}` : 'None'}</b>
          </span>
        )}
        {s.confirmation && (
          <span className="fc-fact">
            <small>Booking ref</small>
            <b className="num">{s.confirmation}</b>
          </span>
        )}
      </span>
    </>
  );
}

function StayRow({ s, onEdit }: { s: Segment; onEdit: () => void }) {
  const n = nightsOf(s);
  return (
    <button type="button" className="seg-row" onClick={onEdit}>
      <span className="seg-icon">
        <BedDouble size={15} />
      </span>
      <div className="grow">
        <div className="seg-title">{s.title || 'Hotel'}</div>
        <div className="seg-meta">
          {dates(dayOf(s.startLocal), dayOf(s.endLocal))} · {plural(n, 'night')}
          {s.address && ` · ${s.address}`}
        </div>
        {s.perks.length > 0 && (
          <div className="seg-perks">
            {s.perks.slice(0, 3).map((p) => (
              <span key={p} className="chip chip-tint">
                {p}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

/**
 * A connection, opened from its layover pill. The two flights and the wait at the top; then whether
 * your ticket and status or a lounge card get you in; then the lounge to head for, which Seldon
 * looks up as the sheet opens (lounges you can reach airside first, ones you can't flagged).
 */
export function LayoverSheet({ trip, from, to, loyalty, onClose }: { trip: Trip; from: Segment; to: Segment; loyalty: LoyaltyAccount[]; onClose: () => void }) {
  const { agentName } = useApp();
  const find = useWrite(() => travelWrite.post(`/segments/${to.id}/companion`));
  const notes = trip.companion[to.id];
  // Look the lounges up as soon as the sheet opens, once, unless they already are.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || notes) return;
    asked.current = true;
    find.mutate(undefined);
  }, [notes, find]);

  const wait = minutesBetween(from.endUtc, to.startUtc);
  const city = to.fromCity || to.fromName || to.fromCode;
  const now = useNow();
  // On the day: the time it is at the connecting airport, from a day before landing until departure.
  const onTheDay = now > Date.parse(from.endUtc) - 24 * 3_600_000 && now < Date.parse(to.startUtc);
  const outOfCredit = /\b402\b|credit/i.test(find.error?.message ?? '');
  const { data: travel } = useTravel();
  const plan = layoverPlan(from, to, travel?.settings.homeAirport ?? 'SIN');
  const flight = (x: Segment) => `${x.carrier} ${x.number}`.trim();
  const kf = loyalty.find((a) => a.program === 'KrisFlyer');
  const cards = loyalty.filter((a) => a.kind === 'lounge');
  const star = KRISFLYER_ELITE.has(to.carrier.toUpperCase()) && to.carrier.toUpperCase() !== 'TR';
  const byTicket = to.lounges.filter((l) => !cards.some((c) => c.program === l.basis));
  const byCard = to.lounges.filter((l) => cards.some((c) => c.program === l.basis));
  // Lounges as the agent found them; older notes were plain lines, "Name — details · access".
  const picks: LoungePick[] =
    notes?.picks ??
    (notes?.lounges ?? []).map((line) => {
      const [name, rest = ''] = line.split(' — ');
      const at = rest.lastIndexOf(' · ');
      return { name: name!, where: at > 0 ? rest.slice(0, at) : rest, access: at > 0 ? rest.slice(at + 3) : '', reachable: !/not (on|reachable)/i.test(line), note: '' };
    });
  const usable = picks.filter((p) => p.reachable);
  const other = picks.filter((p) => !p.reachable);
  const best = usable[0];

  return (
    <Modal title={`Layover in ${city}`} onClose={onClose}>
      <div className="lx-route" aria-label={`${hm(wait)} in ${city} between ${flight(from)} and ${flight(to)}`}>
        <div className="lx-leg">
          <AirlineTail code={from.carrier} size={28} />
          <span>
            <b>{flight(from)}</b>
            <small>lands {time(from.endLocal)}</small>
          </span>
        </div>
        <div className={cx('lx-wait', wait < 60 && 'is-tight')}>
          <i aria-hidden />
          <span>
            <Clock size={12} aria-hidden /> {hm(wait)}
          </span>
          <i aria-hidden />
        </div>
        <div className="lx-leg is-out">
          <span>
            <b>{flight(to)}</b>
            <small>leaves {time(to.startLocal)}</small>
          </span>
          <AirlineTail code={to.carrier} size={28} />
        </div>
      </div>
      {onTheDay && (
        <p className="lx-clock">
          <Clock size={12} aria-hidden /> It’s <b className="num">{clockIn(to.startTz, now)}</b> in {city} now
        </p>
      )}

      {plan.verdict === 'out' && <BeyondAirport plan={plan} to={to} city={city} />}

      <section className="lx-block">
        <h3 className="lx-h">Lounge for you</h3>
        {find.isPending && !notes ? (
          <div className="lx-finding">
            <Spinner />
            <span>
              {agentName} is finding the lounges you can reach in {city} on this connection…
            </span>
          </div>
        ) : best ? (
          <div className="lx-best">
            <span className="lx-best-tag">
              <Sofa size={12} aria-hidden /> Head here
            </span>
            <b className="lx-best-name">{best.name}</b>
            {best.where && (
              <span className="lx-where">
                <MapPin size={12} aria-hidden /> {best.where}
              </span>
            )}
            {best.access && <span className="lx-access">{best.access}</span>}
            {best.note && <p className="lx-note">{best.note}</p>}
          </div>
        ) : notes ? (
          <div className="lx-best is-none">
            <b className="lx-best-name">No lounge you can reach on this connection</b>
            <p className="lx-note">Your ticket, status and cards don’t open a lounge you can get to here.{other.length ? ' What’s nearby is below.' : ''}</p>
          </div>
        ) : (
          <div className="lx-finding">
            <span>{outOfCredit ? `${agentName}’s model is out of credit. Top it up with your model provider, or choose another model in Settings, then try again.` : find.error ? find.error.message : `${agentName} can find the lounge for you.`}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => find.mutate(undefined)}>
              <Sparkles size={13} /> {find.error ? 'Try again' : 'Find it'}
            </button>
          </div>
        )}
        {usable.length > 1 && (
          <ul className="lx-list">
            {usable.slice(1).map((p) => (
              <LoungePickRow key={p.name} p={p} />
            ))}
          </ul>
        )}
        {other.length > 0 && (
          <>
            <p className="lx-sub">Not on this connection</p>
            <ul className="lx-list is-off">
              {other.map((p) => (
                <LoungePickRow key={p.name} p={p} />
              ))}
            </ul>
          </>
        )}
      </section>

      {plan.verdict === 'tight' && <BeyondAirport plan={plan} to={to} city={city} />}

      <section className="lx-block">
        <h3 className="lx-h">Your way in</h3>
        <ul className="lx-access-list">
          <li className={cx(byTicket.length ? 'is-yes' : 'is-no')}>
            <span className="lx-mark" aria-hidden>
              {byTicket.length ? <CheckIcon size={12} /> : <span>×</span>}
            </span>
            <span>
              <b>
                {to.cabin || 'Economy'} on {flight(to)}
                {kf ? ` · KrisFlyer ${kf.tier}` : ''}
              </b>
              <small>{byTicket.length ? byTicket.map((l) => l.access).join('; ') : star ? 'No lounge. Business on this flight or KrisFlyer Elite Gold would.' : 'No lounge. A Business fare would.'}</small>
            </span>
          </li>
          {byCard.map((l) => (
            <li key={l.basis} className="is-yes">
              <span className="lx-mark" aria-hidden>
                <CheckIcon size={12} />
              </span>
              <span>
                <b>{l.basis}</b>
                <small>{l.access}</small>
              </span>
            </li>
          ))}
          {cards.length === 0 && (
            <li className="is-no">
              <span className="lx-mark" aria-hidden>
                <span>×</span>
              </span>
              <span>
                <b>No lounge card</b>
                <small>Add Priority Pass or Revolut Ultra under Loyalty.</small>
              </span>
            </li>
          )}
        </ul>
      </section>

      {notes && notes.plan.length > 0 && (
        <section className="lx-block">
          <h3 className="lx-h">With {hm(wait)}</h3>
          <ul className="lx-plan">
            {notes.plan.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      )}

      <footer className="lx-foot">
        <span>The lounge desk has the final word.{cards.some((c) => /revolut/i.test(c.program)) && ' Revolut passes: Lifestyle → Lounges in the app.'}</span>
        {notes && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={find.isPending} onClick={() => find.mutate(undefined)}>
            {find.isPending ? <Spinner /> : <Sparkles size={13} />} Look again
          </button>
        )}
      </footer>
    </Modal>
  );
}

/** Time enough to leave the airport: when to be out and back, how to get in, and what to do there. */
function BeyondAirport({ plan, to, city }: { plan: LayoverPlan; to: Segment; city: string }) {
  const at = (t: number) => clockIn(to.startTz, t);
  const g = plan.guide;
  const where = plan.atHome ? 'at home' : `in ${g?.city ?? city}`;
  return (
    <section className={cx('lx-block lx-out', plan.verdict === 'tight' && 'is-tight')}>
      <h3 className="lx-h">{plan.atHome ? 'You’re home' : 'Beyond the airport'}</h3>
      <p className="lx-out-verdict">
        {plan.verdict === 'out'
          ? plan.atHome
            ? `Time to go home: about ${hm(plan.free)} there before heading back.`
            : `Worth leaving the airport: about ${hm(plan.free)} ${where}.`
          : `Possible, but tight: about ${hm(plan.free)} ${where}. Only if you clear passport control quickly.`}
      </p>
      <ol className="lx-out-times">
        <li>
          <small>Out of the airport</small>
          <b className="num">{at(plan.outBy)}</b>
        </li>
        <li>
          <small>{plan.atHome ? 'Leave home' : 'Head back'}</small>
          <b className="num">{at(plan.leaveCity)}</b>
        </li>
        <li>
          <small>At the airport</small>
          <b className="num">{at(plan.backBy)}</b>
        </li>
      </ol>
      {plan.atHome && (
        <p className="lx-out-how">
          <MapPin size={13} aria-hidden />
          Home is about 40 minutes away by taxi. Check in online for {`${to.carrier} ${to.number}`.trim()} before you land, so on the way back it’s bag drop at most, then straight through.
        </p>
      )}
      {!plan.atHome && (
        <p className="lx-out-how">
          <MapPin size={13} aria-hidden />
          {g ? `${g.toCity.how}: about ${g.toCity.minutes} min to ${g.toCity.to}.` : 'Allow about 45 minutes each way to the centre.'}
        </p>
      )}
      {!plan.atHome && plan.ideas.length > 0 && (
        <ul className="lx-ideas">
          {plan.ideas.map((i) => (
            <li key={i.title}>
              <b>{i.title}</b>
              <span>{i.note}</span>
            </li>
          ))}
        </ul>
      )}
      {g?.dayRoom && !plan.atHome && (
        <p className="lx-out-note">
          <b>Rather rest?</b> {g.dayRoom}
        </p>
      )}
      {!plan.atHome && <p className="lx-out-note faint">{g?.entry ?? 'Whether you can leave the airport depends on your passport and the country’s entry rules; check before you go.'}</p>}
    </section>
  );
}

function LoungePickRow({ p }: { p: LoungePick }) {
  return (
    <li>
      <b>{p.name}</b>
      <span className="lx-row-meta">{[p.where, p.access].filter(Boolean).join(' · ')}</span>
      {p.note && <span className="lx-row-note">{p.note}</span>}
    </li>
  );
}

const dow = (date: string) => parseDay(date).toLocaleDateString(undefined, { weekday: 'short' });

/** "2pm late checkout" → "2pm": the late checkout a perk promises, if it names a time. */
const lateCheckout = (perks: string[]) => perks.map((p) => p.match(/^(\d{1,2}\s?[ap]m) late checkout/i)?.[1]).find(Boolean);

/** Whether a stay's elite nights and benefits are open: closed until you open them, then remembered on this device. */
function useStayStatusOpen(): [boolean, (v: boolean) => void] {
  const KEY = 'terminus.stayStatus';
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY) === 'open';
    } catch {
      return false;
    }
  });
  const set = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(KEY, v ? 'open' : 'closed');
    } catch {
      /* private mode: remembered for this visit only */
    }
  };
  return [open, set];
}

/**
 * A hotel stay on its trip: the name and whether it is booked, the three facts that decide a day (in, out,
 * nights), then, folded away, the Bonvoy elite nights it earns and what your status gets you there.
 */
function StayCard({ s, tier, onEdit }: { s: Segment; tier: string; onEdit: () => void }) {
  const n = nightsOf(s);
  const [name, ...rest] = (s.title || 'Hotel').split(',');
  const brand = rest.join(',').trim().replace(/^an?\s+/i, '');
  const planned = s.source === 'option' || /not booked/i.test(s.notes);
  const late = lateCheckout(s.perks);
  const perks = s.perks.filter((p) => !/late checkout/i.test(p) || !late);
  const map = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([name, s.address].filter(Boolean).join(', '))}`;
  const [statusOpen, setStatusOpen] = useStayStatusOpen();
  return (
    <article className="stay-card">
      <header className="stay-card-head">
        <span className="stay-card-icon" aria-hidden>
          <BedDouble size={16} />
        </span>
        <div className="stay-card-title">
          <h3>{name!.trim()}</h3>
          {(brand || s.eliteNights) && <p>{brand || 'Marriott Bonvoy'}</p>}
        </div>
        {planned ? (
          <span className="stay-status is-planned" title="Added from the hotel options; book it, then add the confirmation">
            Planned
          </span>
        ) : (
          s.confirmation && <span className="stay-status">#{s.confirmation}</span>
        )}
        <button type="button" className="icon-btn icon-btn-sm" onClick={onEdit} aria-label={`Edit the stay at ${name}`} title="Edit">
          <Pencil size={14} />
        </button>
      </header>

      <dl className="opt-stats stay-card-stats">
        <div>
          <dt>Check-in</dt>
          <dd>{shortDay(dayOf(s.startLocal))}</dd>
          <dd className="opt-stat-sub">
            {dow(dayOf(s.startLocal))} · {time(s.startLocal)}
          </dd>
        </div>
        <div>
          <dt>Check-out</dt>
          <dd>{shortDay(dayOf(s.endLocal))}</dd>
          <dd className="opt-stat-sub" title={late ? `Late checkout to ${late} with your status (standard ${time(s.endLocal)})` : undefined}>
            {dow(dayOf(s.endLocal))} · {late ? `${late} late` : time(s.endLocal)}
          </dd>
        </div>
        <div>
          <dt>Nights</dt>
          <dd>{n}</dd>
          <dd className="opt-stat-sub">{planned ? 'planned' : 'booked'}</dd>
        </div>
      </dl>

      {(s.eliteNights || perks.length > 0) && (
        <details className="stay-fold" open={statusOpen} onToggle={(e) => setStatusOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>
            <span className="stay-card-label">{s.eliteNights ? 'Bonvoy status' : tier ? `${tier} benefits` : 'Your benefits'}</span>
            <span className="stay-fold-gist">
              {s.eliteNights
                ? [`+${plural(s.eliteNights.nights, 'night')}`, s.eliteNights.reaches && `reaches ${s.eliteNights.reaches}`].filter(Boolean).join(' · ')
                : plural(perks.length, 'benefit')}
            </span>
            <ChevronDown size={15} className="stay-fold-chev" aria-hidden />
          </summary>
          <div className="stay-fold-body">
            {s.eliteNights && <BonvoyNights e={s.eliteNights} />}

            {perks.length > 0 && (
              <div className="stay-card-perks">
                <span className="stay-card-label">{tier ? `${tier} benefits` : 'Your benefits'}</span>
                <ul>
                  {perks.map((p) => (
                    <li key={p}>
                      <CheckIcon size={13} aria-hidden /> {p}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}

      {s.address && (
        <a className="stay-card-address" href={map} target="_blank" rel="noreferrer">
          <MapPin size={13} aria-hidden /> <span>{s.address}</span>
        </a>
      )}
    </article>
  );
}

/** Bonvoy tiers by elite nights in a year (as the server counts them). */
const BONVOY_TIERS = [
  { tier: 'Silver Elite', at: 10 },
  { tier: 'Gold Elite', at: 25 },
  { tier: 'Platinum Elite', at: 50 },
  { tier: 'Titanium Elite', at: 75 },
  { tier: 'Ambassador Elite', at: 100 },
];

/** The Bonvoy elite nights a stay earns: a bar of the year's nights, this stay's share in colour, up to the next tier. */
function BonvoyNights({ e }: { e: EliteNights }) {
  if (e.after === null || e.before === null) {
    return (
      <div className="stay-bonvoy">
        <div className="stay-bonvoy-head">
          <span className="stay-card-label">Bonvoy elite nights</span>
          <b className="stay-bonvoy-add">+{e.nights}</b>
        </div>
        <p className="stay-bonvoy-note">{e.counted ? 'Already in the nights on your Bonvoy card.' : 'Add your nights this year to the Bonvoy card to see where this leaves you.'}</p>
      </div>
    );
  }
  const scale = Math.max(e.next?.at ?? e.after, e.after, 1);
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const ticks = BONVOY_TIERS.filter((t) => t.at < scale);
  const passed = BONVOY_TIERS.filter((t) => t.at <= e.before!).at(-1)?.tier;
  const from = [e.recorded && `${e.recorded.nights} on your Bonvoy card (${shortDay(e.recorded.asOf)})`, ...e.earlier.map((x) => `${x.nights} at ${shortStay(x.title)}`)].filter(Boolean);
  return (
    <div className="stay-bonvoy">
      <div className="stay-bonvoy-head">
        <span className="stay-card-label">Bonvoy elite nights</span>
        <b className="stay-bonvoy-add">+{e.nights}</b>
      </div>
      <div
        className="stay-bonvoy-bar"
        role="img"
        aria-label={`${e.before} nights before this stay, ${e.nights} from it: ${e.after} in ${e.year}${e.next ? `, ${e.next.at - e.after} short of ${e.next.tier}` : ''}`}
      >
        <span className="is-before" style={{ width: pct(e.before) }} />
        <span className="is-stay" style={{ left: pct(e.before), width: `calc(${pct(e.after)} - ${pct(e.before)})` }} />
        {ticks.map((t) => (
          <i key={t.at} style={{ left: pct(t.at) }} title={`${t.tier}: ${t.at} nights`} />
        ))}
      </div>
      <div className="stay-bonvoy-foot">
        <span>
          {e.before} → <b>{e.after}</b> nights in {e.year}
        </span>
        <span>{e.next ? `${e.next.at - e.after} more to ${e.next.tier}` : 'Top tier by nights'}</span>
      </div>
      {(e.reaches || passed) && (
        <p className="stay-bonvoy-tier">
          <Star size={12} aria-hidden /> {e.reaches ? `Reaches ${e.reaches} on this stay` : `${passed} reached before this stay`}
        </p>
      )}
      {from.length > 0 && <p className="stay-bonvoy-note">Counted on from {from.join(' and ')}.</p>}
    </div>
  );
}

/** A remembered preference on this device (folded cards, folded days), falling back to the visit when storage is blocked. */
function useStored<T>(key: string, initial: () => T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      /* storage blocked or unreadable */
    }
    return initial();
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* remembered for this visit only */
    }
  };
  return [value, set];
}

/** A trip-page card that folds to its header: the title with a short summary, any actions, and a chevron. */
function FoldCard({ id, icon, title, peek, extra, className, children }: { id: string; icon: ReactNode; title: string; peek?: ReactNode; extra?: ReactNode; className?: string; children: ReactNode }) {
  const [open, setOpen] = useStored(`terminus.card.${id}`, () => true);
  return (
    <section className={cx('card trip-section fold-card', !open && 'is-folded', className)}>
      <div className="card-head fold-head">
        <button type="button" className="fold-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="card-title">
            {icon} {title}
          </span>
          {peek && <span className="fold-peek">{peek}</span>}
        </button>
        {open && extra}
        <button type="button" className="icon-btn icon-btn-sm fold-chev-btn" aria-label={open ? `Fold ${title}` : `Open ${title}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronDown size={15} className="fold-chev" aria-hidden />
        </button>
      </div>
      {open && <div className="trip-section-body">{children}</div>}
    </section>
  );
}

type TripSection = 'flights' | 'route' | 'options' | 'guide' | 'stay' | 'todos' | 'plan';
type TripStageName = 'planning' | 'soon' | 'out-day' | 'away' | 'return-day' | 'past';

/** What a trip's page leads with at each stage: what you need now first, what's done with last. */
const SECTION_ORDER: Record<TripStageName, TripSection[]> = {
  // Weeks out: getting it booked.
  planning: ['flights', 'options', 'stay', 'todos', 'guide', 'plan', 'route'],
  // The last two weeks: getting ready.
  soon: ['todos', 'guide', 'flights', 'options', 'stay', 'plan', 'route'],
  // Flying out: the flight, then where you're headed.
  'out-day': ['flights', 'stay', 'todos', 'guide', 'plan', 'options', 'route'],
  // Landed: the days themselves; the flights are behind you.
  away: ['plan', 'stay', 'guide', 'todos', 'route', 'flights', 'options'],
  // Flying home: the flight back, and checking out.
  'return-day': ['flights', 'stay', 'todos', 'plan', 'route', 'guide', 'options'],
  // Afterwards: what you did and where you went.
  past: ['plan', 'route', 'stay', 'flights', 'todos', 'guide', 'options'],
};

/**
 * Where a trip is now. A journey under way decides it (flying out, or home), until you land: landing
 * out turns the trip to its days, landing home to what's past. Otherwise the dates and Today's context.
 * `live` is whether Today shows this trip's card, which the page then mirrors at its top.
 */
function tripStage(trip: Trip, state: TravelState, homeward: Set<string>, now: number): { stage: TripStageName; journey: Journey | null; live: boolean } {
  const today = todayStr();
  const all = activeJourney(state.trips.flatMap((t) => t.segments), now);
  const journey = all && all.legs.some((f) => f.tripId === trip.id) ? all : null;
  const c = state.context;
  const ours = c.trip?.id === trip.id;
  const live = !!journey || (ours && (c.mode === 'departing' || c.mode === 'away'));
  if (journey) {
    const landed = journey.phases[Math.max(journey.current, 0)]!.kind === 'arrived';
    const home = journey.legs.some((f) => homeward.has(f.id));
    return { stage: home ? (landed ? 'past' : 'return-day') : landed ? 'away' : 'out-day', journey, live };
  }
  if (trip.endDate < today) return { stage: 'past', journey: null, live };
  if (ours && c.mode === 'departing') return { stage: c.flight && homeward.has(c.flight.id) ? 'return-day' : 'out-day', journey: null, live };
  if (trip.startDate <= today) return { stage: 'away', journey: null, live };
  return { stage: daysFrom(today, trip.startDate) <= 14 ? 'soon' : 'planning', journey: null, live };
}

/**
 * Today's travel-day card, as cards of their own, at the top of the trip's page: only while there is
 * something to do before a flight (getting there, the airport, a connection). In the air the Flights
 * card tracks it on the globe; once you've landed, and while you're away, the page's own cards serve.
 */
function TripNow({ trip, journey }: { trip: Trip; journey: Journey | null }) {
  const { data: t } = useTravel();
  if (!t) return null;
  const c = t.context;
  if (journey) {
    const kind = journey.phases[Math.max(journey.current, 0)]!.kind;
    return kind === 'before' || kind === 'airport' || kind === 'connection' ? <TripDayCards trip={trip} journey={journey} /> : null;
  }
  return c.mode === 'departing' && c.trip?.id === trip.id ? <TripDayCards trip={trip} journey={null} /> : null;
}

/**
 * Everything about a trip, as separate cards: flights (the globe beside them), flight options, the stay,
 * to-dos and the day-by-day plan. The page's head, with the trip's actions, comes first.
 */
function TripDetail({ trip, state, head }: { trip: Trip; state: TravelState; head: ReactNode }) {
  const { agentName, ask } = useApp();
  const now = useNow();
  const today = todayStr();
  const [editing, setEditing] = useState(false);
  const [booking, setBooking] = useState<Segment | 'new' | null>(null);
  const [item, setItem] = useState<{ item: ItineraryItem | null; date: string } | null>(null);
  const [connection, setConnection] = useState<{ from: Segment; to: Segment } | null>(null);
  const draft = useWrite(() => travelWrite.post(`/trips/${trip.id}/draft`));
  const toggle = useWrite((i: ItineraryItem) => travelWrite.patch(`/itinerary/${i.id}`, { done: !i.done }));
  const days = Array.from({ length: daysFrom(trip.startDate, trip.endDate) + 1 }, (_, i) => {
    const d = parseDay(trip.startDate);
    d.setDate(d.getDate() + i);
    return todayStr(d);
  });
  const past = trip.endDate < today;
  const allFlights = trip.segments.filter((s) => s.kind === 'flight');
  const others = trip.segments.filter((s) => s.kind !== 'flight');
  // The way home is a journey of flights ending back at the home airport; the rest are the way out.
  const home = state.settings.homeAirport;
  const homeward = new Set(journeys(allFlights).filter((j) => j[j.length - 1]!.toCode === home && j[0]!.fromCode !== home).flat().map((f) => f.id));
  const outbound = allFlights.filter((f) => !homeward.has(f.id));
  const inbound = allFlights.filter((f) => homeward.has(f.id));
  const twoWays = outbound.length > 0 && inbound.length > 0;
  // What matters now: the way out until you've landed, then the way home. A switch shows the other.
  const landed = outbound.length > 0 && Date.now() > Math.max(...outbound.map((f) => Date.parse(f.endUtc)));
  const [way, setWay] = useState<'out' | 'back'>(() => (landed ? 'back' : 'out'));
  const flights = !twoWays ? allFlights : way === 'back' ? inbound : outbound;
  const legs = globeLegs(flights);
  // The flight in the air now, if it's one of these: the globe tracks it.
  const airborne = flights.find((f) => now >= departs(f) && now < lands(f));
  const airborneLeg = airborne ? legs.findIndex((l) => l.id === airborne.id) : -1;
  const live = airborne && airborneLeg >= 0 ? { leg: airborneLeg, start: departs(airborne), end: lands(airborne) } : null;
  const openTodos = trip.todos.filter((x) => !x.done).length;
  const bonvoyTier = state.loyalty.find((a) => /bonvoy|marriott/i.test(a.program))?.tier ?? '';
  // Each day folds on its own; days already past start folded. Choices are remembered per trip on this device.
  const [dayFolds, setDayFolds] = useStored<Record<string, boolean>>(`terminus.plan.${trip.id}`, () => ({}));
  const dayOpen = (d: string) => dayFolds[d] ?? !(d < today && !past);
  const setDay = (d: string, open: boolean) => setDayFolds({ ...dayFolds, [d]: open });
  const allOpen = days.every(dayOpen);
  const setAllDays = (open: boolean) => setDayFolds(Object.fromEntries(days.map((d) => [d, open])));
  // Connections reach across trips (home from one, straight on to the next), so look at every flight.
  const chains = journeys(state.trips.flatMap((t) => t.segments.filter((x) => x.kind === 'flight')));
  const neighbour = (f: Segment, step: -1 | 1) => {
    const c = chains.find((j) => j.some((x) => x.id === f.id));
    const i = c ? c.findIndex((x) => x.id === f.id) : -1;
    return c && i >= 0 ? c[i + step] : undefined;
  };
  const tripName = (f: Segment) => state.trips.find((t) => t.id === f.tripId)?.title;

  /** The wait between two connecting flights, as a pill that opens the layover sheet. */
  const gap = (a: Segment, b: Segment, caption?: string) => {
    const wait = minutesBetween(a.endUtc, b.startUtc);
    if (!(wait > 0 && wait < 24 * 60)) return null;
    // Long enough to leave the airport, by the same reckoning as the layover sheet.
    const plan = layoverPlan(a, b, home);
    const long = plan.verdict === 'out';
    return (
      <div className={cx('layover-gap', wait < 60 && 'is-tight', long && 'is-long', caption && 'is-cross')}>
        {caption && <span className="layover-caption">{caption}</span>}
        <button type="button" className="layover-pill" onClick={() => setConnection({ from: a, to: b })} aria-haspopup="dialog">
          <Clock size={12} aria-hidden />
          <b>{hm(wait)}</b> layover in {a.toCity || a.toName || a.toCode}
          {wait < 60 ? ' · tight' : long ? (plan.atHome ? ' · time to go home' : ' · time to go out') : ''}
          <Sofa size={12} className="layover-lounge" aria-label="See lounges" />
        </button>
      </div>
    );
  };

  const row = (s: Segment) => {
    if (s.kind === 'stay') return <StayCard key={s.id} s={s} tier={bonvoyTier} onEdit={() => setBooking(s)} />;
    if (s.kind !== 'flight') return <StayRow key={s.id} s={s} onEdit={() => setBooking(s)} />;
    const i = flights.indexOf(s);
    const next = flights[i + 1];
    // The first and last flights shown may connect to a flight on another trip.
    const from = i === 0 ? neighbour(s, -1) : undefined;
    const onward = i === flights.length - 1 ? neighbour(s, 1) : undefined;
    return (
      <Fragment key={s.id}>
        {from && from.tripId !== trip.id && gap(from, s, `From ${`${from.carrier} ${from.number}`.trim()}${tripName(from) ? ` · ${tripName(from)}` : ''}`)}
        <FlightRow s={s} onEdit={() => setBooking(s)} />
        {next && s.toCode && s.toCode === next.fromCode && gap(s, next)}
        {onward && onward.tripId !== trip.id && gap(s, onward, `Then ${`${onward.carrier} ${onward.number}`.trim()} to ${onward.toCity || onward.toCode}${tripName(onward) ? ` · ${tripName(onward)}` : ''}`)}
      </Fragment>
    );
  };

  // Each section, then the order the trip's stage calls for (see tripStage).
  const sections: Record<TripSection, ReactNode> = {
    flights: (
      <FoldCard
        id={`${trip.id}.flights`}
        icon={<Plane size={15} />}
        title="Flights"
        peek={allFlights.length > 0 && (twoWays ? `Out ${routeLine(outbound)} · home ${routeLine(inbound)}` : `${plural(allFlights.length, 'flight')} · ${routeLine(allFlights)}`)}
      >
          {twoWays && (
            <div className="opt-dir">
              <Seg
                label="Which way"
                value={way}
                onChange={setWay}
                options={[
                  { value: 'out', label: `Departing · ${outbound.length}` },
                  { value: 'back', label: `Returning · ${inbound.length}` },
                ]}
              />
            </div>
          )}
          {allFlights.length === 0 ? (
            <p className="empty">{trip.options.length ? 'Nothing booked yet. Compare the options below.' : 'No flights yet. Add them, paste a confirmation, or let Gmail bring them in.'}</p>
          ) : legs.length ? (
            <div className={cx('flight-pair', live && 'is-live')}>
              {/* Beside the flights, touring them; in the air, above them on the card, tracking the one flying. */}
              <div className={live ? 'flight-globe' : 'globe-card'}>
                <RouteGlobe key={`${way}${live ? '-live' : ''}`} legs={legs} fill live={live} />
              </div>
              <div className="flight-stack">{flights.map(row)}</div>
            </div>
          ) : (
            <div className="seg-list">{flights.map(row)}</div>
          )}
      </FoldCard>
    ),
    route: <RouteCard trip={trip} />,
    options: trip.options.length > 0 ? <FlightOptions trip={trip} /> : null,
    guide: (
      <FoldCard
        id={`${trip.id}.guide`}
        icon={<ShieldCheck size={15} />}
        title="Know before you go"
        peek={trip.guide ? trip.guide.cities.map((c) => c.name).join(' · ') : 'Not written yet'}
      >
        <TripGuideBody trip={trip} />
      </FoldCard>
    ),
    stay: (
      <FoldCard
        id={`${trip.id}.stay`}
        icon={<BedDouble size={15} />}
        title="Stay"
        peek={others.length ? others.map((o) => shortStay(o.title || 'Hotel')).join(', ') : trip.stayOptions.length ? plural(trip.stayOptions.length, 'hotel option') : 'No hotel yet'}
      >
          {others.length > 0 && <div className="seg-list">{others.map(row)}</div>}
          {trip.stayOptions.length > 0 ? (
            <StayOptions trip={trip} booked={others.some((s) => s.kind === 'stay')} />
          ) : (
            !others.length && (
              <p className="empty">
                No hotel yet.{' '}
                <button type="button" className="link" onClick={() => setBooking('new')}>
                  Add one
                </button>
              </p>
            )
          )}
      </FoldCard>
    ),
    todos: (
      <FoldCard id={`${trip.id}.todos`} icon={<ListChecks size={15} />} title="To-dos" peek={openTodos > 0 ? plural(openTodos, 'open', 'open') : trip.todos.length ? 'All done' : 'None yet'}>
          <TripTodos trip={trip} past={past} />
      </FoldCard>
    ),
    plan: (
      <FoldCard
        id={`${trip.id}.plan`}
        icon={<CalendarDays size={15} />}
        title="Plan"
        peek={`${plural(days.length, 'day')} · ${trip.itinerary.length ? plural(trip.itinerary.length, 'plan') : 'nothing planned yet'}`}
        extra={
          <span className="fold-actions">
            {days.length > 1 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAllDays(!allOpen)}>
                {allOpen ? 'Fold all days' : 'Open all days'}
              </button>
            )}
            {!past && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={draft.isPending} onClick={() => draft.mutate()}>
                {draft.isPending ? <Spinner /> : <Wand2 size={13} />} {trip.itinerary.length ? 'Fill empty days' : `Draft with ${agentName}`}
              </button>
            )}
          </span>
        }
      >
          {draft.error && <p className="error-text">{draft.error.message}</p>}
          <div className="plan-days">
            {days.map((d) => {
              const items = trip.itinerary.filter((i) => i.date === d);
              const open = dayOpen(d);
              const left = items.filter((i) => !i.done).length;
              return (
                <div key={d} className={cx('plan-day', d === today && 'is-today', !open && 'is-folded')}>
                  <div className="plan-date">
                    <button type="button" className="plan-date-toggle" aria-expanded={open} onClick={() => setDay(d, !open)}>
                      <ChevronRight size={14} className="plan-date-chev" aria-hidden />
                      <b>{weekday(d)}</b>
                      {!open && (
                        <span className="plan-date-peek">
                          {items.length === 0 ? 'Free' : `${plural(items.length, 'plan')}${left < items.length ? ` · ${left ? `${left} to go` : 'all done'}` : ''} · ${items.map((i) => i.title).join(', ')}`}
                        </span>
                      )}
                    </button>
                    <button type="button" className="icon-btn icon-btn-sm" aria-label={`Add to ${weekday(d)}`} onClick={() => setItem({ item: null, date: d })}>
                      <Plus size={14} />
                    </button>
                  </div>
                  {open && items.length === 0 && <p className="plan-empty">Free</p>}
                  {open && items.length > 0 && (
                    <ul>
                      {items.map((i, n) => (
                        <li key={i.id} className={cx('plan-item', `pk-${i.kind}`, i.done && 'is-done')}>
                          <Check checked={i.done} onChange={() => toggle.mutate(i)} label={`Done: ${i.title}`} />
                          <div className="plan-item-main">
                            <button type="button" className="plan-item-body" onClick={() => setItem({ item: i, date: d })}>
                              <span className="plan-time num">{i.time ?? '·'}</span>
                              <span className="grow">
                                <span className="plan-title">{i.title}</span>
                                {(i.place || i.notes) && <span className="plan-place">{[i.place, i.notes].filter(Boolean).join(' — ')}</span>}
                              </span>
                            </button>
                            <ItemModules item={i} before={items.slice(0, n).reverse().find((x) => x.place)?.place} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
      </FoldCard>
    ),
  };
  const stage = tripStage(trip, state, homeward, now);
  const order = SECTION_ORDER[stage.stage];
  // Stay and to-dos side by side when they come together; apart when the stage puts them apart.
  const placed: ReactNode[] = [];
  for (let i = 0; i < order.length; i++) {
    const k = order[i]!;
    const n = order[i + 1];
    if ((k === 'stay' && n === 'todos') || (k === 'todos' && n === 'stay')) {
      placed.push(
        <div key="pair" className="trip-section-pair">
          <Fragment key={k}>{sections[k]}</Fragment>
          <Fragment key={n}>{sections[n]}</Fragment>
        </div>,
      );
      i++;
    } else placed.push(<Fragment key={k}>{sections[k]}</Fragment>);
  }

  return (
    <div className="trip-detail">
      <header className="page-head trip-page-head">
        {head}
        <div className="trip-actions">
          <button type="button" className="btn btn-sm" onClick={() => setBooking('new')}>
            <Plus size={13} /> Flight or hotel
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
            <Pencil size={12} /> Edit
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => ask(`Help me with my ${trip.purpose} trip "${trip.title}" (${trip.startDate} to ${trip.endDate}). Look at the bookings and the plan, then tell me what is missing or could be better.`)}>
            <Sparkles size={13} /> Ask {agentName}
          </button>
        </div>
      </header>

      {stage.live && <TripNow trip={trip} journey={stage.journey} />}
      {placed}

      {editing && <TripSheet trip={trip} onClose={() => setEditing(false)} />}
      {booking && <BookingSheet trip={trip} segment={booking === 'new' ? null : booking} onClose={() => setBooking(null)} />}
      {item && <ItemSheet trip={trip} item={item.item} date={item.date} onClose={() => setItem(null)} />}
      {connection && (
        <LayoverSheet trip={state.trips.find((t) => t.id === connection.to.tripId) ?? trip} from={connection.from} to={connection.to} loyalty={state.loyalty} onClose={() => setConnection(null)} />
      )}
    </div>
  );
}

/** A trip at a glance, for the list in the Travels sphere: tap for its page. Three labelled columns — flights,
 * stay, to-dos — so each fact sits where the eye expects it. */
function TripSummary({ trip }: { trip: Trip }) {
  const today = todayStr();
  const flights = trip.segments.filter((s) => s.kind === 'flight');
  const shown = flights.length > 2 ? [flights[0]!, flights[flights.length - 1]!] : flights;
  const stays = trip.segments.filter((s) => s.kind === 'stay');
  const open = trip.todos.filter((x) => !x.done);
  const next = open.find((x) => x.dueDate) ?? open[0];
  const days = daysFrom(today, trip.startDate);
  const countdown = trip.endDate < today ? 'Past' : days <= 0 ? 'Now' : days === 1 ? 'Tomorrow' : `${days} days`;
  return (
    <Link href={`/trips/${trip.id}`} className={cx('trip-summary', trip.endDate < today && 'is-past')}>
      <span className="ts-head">
        <span className="ts-title-block">
          <span className="trip-title">{trip.title}</span>
          <span className="ts-dates">{dates(trip.startDate, trip.endDate)}</span>
        </span>
        <span className="ts-head-end">
          <PurposeChip purpose={trip.purpose} />
          <span className="ts-countdown">{countdown}</span>
          <ChevronRight size={18} className="trip-chev" />
        </span>
      </span>
      <span className="ts-grid">
        <span className="ts-cell">
          <span className="ts-label">Flights{flights.length > 2 ? ` · ${flights.length}` : ''}</span>
          {shown.length ? (
            shown.map((f) => (
              <span key={f.id} className="ts-flight">
                <AirlineTail code={f.carrier} size={22} />
                <span className="ts-flight-text">
                  <b>
                    {f.fromCode} → {f.toCode}
                  </b>
                  <span>
                    {`${f.carrier} ${f.number}`.trim()} · {weekday(dayOf(f.startLocal))}, {time(f.startLocal)}
                  </span>
                </span>
              </span>
            ))
          ) : (
            <span className="ts-empty">{trip.options.length ? `${plural(trip.options.length, 'option')} to compare` : 'Not booked yet'}</span>
          )}
        </span>
        <span className="ts-cell">
          <span className="ts-label">Stay</span>
          {stays.length ? (
            stays.slice(0, 2).map((st) => (
              <span key={st.id} className="ts-value">
                <b>{shortStay(st.title || 'Hotel')}</b>
                <span>
                  {plural(nightsOf(st), 'night')} · from {weekday(dayOf(st.startLocal))}
                </span>
              </span>
            ))
          ) : (
            <span className="ts-empty">{trip.stayOptions.length ? `${plural(trip.stayOptions.length, 'hotel')} to compare` : 'Not booked yet'}</span>
          )}
        </span>
        <span className="ts-cell">
          <span className="ts-label">To do</span>
          {open.length ? (
            <span className="ts-value">
              <b>{plural(open.length, 'open', 'open')}</b>
              {next && <span>Next: {next.title}</span>}
            </span>
          ) : (
            <span className="ts-empty">All done</span>
          )}
        </span>
      </span>
    </Link>
  );
}

/**
 * KrisFlyer elite miles: a share of the distance flown, set by cabin and fare. On Singapore Airlines that is, from
 * Lite to Flexi: Economy 50%–100% (Standard 75%), Premium Economy 100%–125% (Standard 100%), Business 125%–150%
 * (Standard 125%). Star Alliance partners such as Lufthansa and SWISS credit on a similar scale by booking class.
 * Other airlines (LATAM, say) credit nothing. The estimate uses Standard, with the range from Lite to Flexi.
 */
const ELITE_RATE: Record<Cabin, { low: number; mid: number; high: number }> = {
  economy: { low: 0.5, mid: 0.75, high: 1 },
  premium: { low: 1, mid: 1, high: 1.25 },
  business: { low: 1.25, mid: 1.25, high: 1.5 },
};
const CABIN_NAME: Record<Cabin, string> = { economy: 'Economy', premium: 'Premium Economy', business: 'Business' };
const KRISFLYER_ELITE = new Set(['SQ', 'TR', 'A3', 'AC', 'AI', 'AV', 'BR', 'CA', 'CM', 'ET', 'LH', 'LO', 'LX', 'MS', 'NH', 'NZ', 'OS', 'OU', 'OZ', 'SA', 'SK', 'SN', 'TG', 'TK', 'TP', 'UA', 'ZH']);
const earnsElite = (carrier: string) => KRISFLYER_ELITE.has(carrier.toUpperCase());
function eliteMiles(o: FlightOption) {
  const sum = (k: 'low' | 'mid' | 'high') => Math.round(o.legs.reduce((n, l) => n + (earnsElite(l.carrier) ? l.miles * ELITE_RATE[l.cabin ?? 'economy'][k] : 0), 0));
  return { low: sum('low'), mid: sum('mid'), high: sum('high') };
}
/** Booking classes and the share of the distance each earns in KrisFlyer, per airline, from KrisFlyer's accrual chart (Jan 2026). */
type FareRate = { cabin: Cabin; rate: number; fare: string };
const fares = (cabin: Cabin, rate: number, fare: string, classes: string): Record<string, FareRate> =>
  Object.fromEntries([...classes].map((c) => [c, { cabin, rate, fare }]));
const CLASS_RATES: Record<string, Record<string, FareRate>> = {
  SQ: {
    ...fares('business', 1.5, 'Flexi', 'AFJCD'),
    ...fares('business', 1.25, 'Standard', 'UZ'),
    ...fares('business', 1.25, 'Lite', 'I'),
    ...fares('premium', 1.25, 'Flexi', 'ST'),
    ...fares('premium', 1, 'Standard', 'LP'),
    ...fares('premium', 1, 'Lite', 'R'),
    ...fares('economy', 1, 'Flexi', 'YBE'),
    ...fares('economy', 0.75, 'Standard', 'MHW'),
    ...fares('economy', 0.5, 'Value', 'QN'),
    ...fares('economy', 0.5, 'Lite', 'VK'),
  },
  LH: {
    ...fares('business', 2, 'First', 'AF'),
    ...fares('business', 1.5, 'Business', 'CDJ'),
    ...fares('business', 1.25, 'Business', 'ZP'),
    ...fares('premium', 1, 'Premium Economy', 'GEN'),
    ...fares('economy', 1, 'Economy', 'BY'),
    ...fares('economy', 0.75, 'Economy', 'MUH'),
    ...fares('economy', 0.5, 'Economy', 'QVWS'),
    ...fares('economy', 0.1, 'Economy', 'T'),
  },
};
CLASS_RATES.TR = CLASS_RATES.SQ!;
const cabinOf = (text: string): Cabin => (/business|first|suite/i.test(text) ? 'business' : /premium/i.test(text) ? 'premium' : 'economy');

/**
 * A booked flight's KrisFlyer elite miles: the distance times the rate for its fare. KrisFlyer credits by the
 * airline flying it, so a Lufthansa flight sold under an SQ number earns at Lufthansa's rate for its class. With
 * the booking class on the ticket ("Economy (W)") and that airline's chart known, the rate is exact; otherwise
 * the cabin's Standard rate, with its range in the hint.
 */
function flightElite(s: Pick<Segment, 'carrier' | 'cabin' | 'miles'>): { elite: number; why: string } | null {
  if (!s.miles) return null;
  const flown = `${s.miles.toLocaleString()} miles flown`;
  if (!earnsElite(s.carrier)) return { elite: 0, why: `${s.carrier || 'This airline'} doesn't earn KrisFlyer elite miles` };
  const cabin = cabinOf(s.cabin);
  const letter = /\(([A-Z])\)|\bclass\s+([A-Z])\b/i.exec(s.cabin);
  const code = letter ? (letter[1] ?? letter[2]!).toUpperCase() : '';
  const known = code ? CLASS_RATES[s.carrier.toUpperCase()]?.[code] : undefined;
  if (known && known.cabin === cabin) {
    const fare = known.fare === CABIN_NAME[cabin] ? known.fare : `${CABIN_NAME[cabin]} ${known.fare}`;
    return { elite: Math.round(s.miles * known.rate), why: `${Math.round(known.rate * 100)}% of ${flown} (${fare}, class ${code})` };
  }
  const r = ELITE_RATE[cabin];
  return { elite: Math.round(s.miles * r.mid), why: `${Math.round(r.mid * 100)}% of ${flown} on a Standard fare; ${Math.round(r.low * 100)}–${Math.round(r.high * 100)}% by fare` };
}

/** The cabin an option is really about: the one on its longest flight. */
const mainCabin = (o: FlightOption): Cabin => [...o.legs].sort((a, b) => b.miles - a.miles)[0]?.cabin ?? 'economy';
const roughly = (n: number) => (n >= 1000 ? `${(Math.round(n / 100) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 })}k` : String(n));

/** Ways to make the journey, to weigh before booking: each option's flights, connections and trade-offs. */
function FlightOptions({ trip }: { trip: Trip }) {
  const { data: t } = useTravel();
  const choose = useWrite((id: string) => travelWrite.post(`/options/${id}/choose`));
  const unchoose = useWrite((id: string) => travelWrite.post(`/options/${id}/unchoose`));
  const remove = useWrite((id: string) => travelWrite.del(`/options/${id}`));
  // Folded or open, remembered per trip on this device; folded by default once an option is on the trip.
  const foldKey = `terminus.options.${trip.id}`;
  const [open, setOpenState] = useState(() => {
    try {
      const v = localStorage.getItem(foldKey);
      if (v) return v === 'open';
    } catch {
      /* storage blocked */
    }
    return !trip.options.some((o) => o.chosenAt);
  });
  const setOpen = (v: boolean) => {
    setOpenState(v);
    try {
      localStorage.setItem(foldKey, v ? 'open' : 'closed');
    } catch {
      /* remembered for this visit only */
    }
  };
  // Options that land back at the home airport are the way home; the rest are the way out.
  const home = t?.settings.homeAirport ?? 'SIN';
  const isReturn = (o: FlightOption) => o.legs[o.legs.length - 1]?.toCode === home;
  const outCount = trip.options.filter((o) => !isReturn(o)).length;
  const backCount = trip.options.length - outCount;
  const split = outCount > 0 && backCount > 0;
  // Which way is shown, remembered per trip; once the way out is chosen, the way home comes first.
  const [dir, setDir] = useStored<'out' | 'back'>(`terminus.options.dir.${trip.id}`, () =>
    trip.options.some((o) => !isReturn(o) && o.chosenAt) && !trip.options.some((o) => isReturn(o) && o.chosenAt) ? 'back' : 'out',
  );
  const peek = useScrollEdges<HTMLDivElement>('x', [open, trip.options.length]);
  const grid = useScrollEdges<HTMLDivElement>('x', [open, trip.options.length, dir]);
  const chosen = trip.options.filter((o) => o.chosenAt).length;
  const best = [...trip.options].sort((a, b) => eliteMiles(b).mid - eliteMiles(a).mid)[0];
  // How far there is still to go for the next KrisFlyer tier, to show what each option does for it.
  const kf = t?.loyalty.find((a) => a.program === 'KrisFlyer');
  const toGo = kf && kf.progress !== null && kf.progressTarget ? Math.max(0, kf.progressTarget - kf.progress) : null;
  const goal = kf?.progressLabel?.match(/to (Elite \w+|PPS Club)/i)?.[1] ?? 'the next tier';
  // The recommended option first, then the ones that earn the most elite miles.
  const ordered = [...trip.options].sort((a, b) => Number(b.recommended) - Number(a.recommended) || eliteMiles(b).mid - eliteMiles(a).mid);
  const departing = ordered.filter((o) => !isReturn(o));
  const returning = ordered.filter(isReturn);
  const shown = !split ? ordered : dir === 'back' ? returning : departing;
  const added = (list: FlightOption[]) => list.some((o) => o.chosenAt);
  const chip = (o: FlightOption) => {
    const last = o.legs[o.legs.length - 1]!;
    return (
      <button key={o.id} type="button" className={cx('opt-peek-chip', o.chosenAt && 'is-added')} onClick={() => { if (split) setDir(isReturn(o) ? 'back' : 'out'); setOpen(true); }}>
        <span className={cx('opt-peek-dot', `is-${mainCabin(o)}`)} aria-hidden />
        <b>{CABIN_NAME[mainCabin(o)]}</b>
        <span>
          lands {weekday(dayOf(last.endLocal))} {time(last.endLocal)} · ≈ {roughly(eliteMiles(o).mid)}
        </span>
        {o.chosenAt && <CheckIcon size={12} className="opt-peek-check" aria-label="added to the trip" />}
      </button>
    );
  };
  return (
    <section className={cx('card trip-section fold-card trip-options', !open && 'is-folded')}>
      <div className="card-head fold-head">
        <button type="button" className="fold-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="card-title">
            <Route size={15} /> Flight options
          </span>
          <span className="fold-peek opt-fold-peek">
            {split ? `${outCount} departing · ${backCount} returning` : plural(trip.options.length, 'option')} · {chosen ? `${chosen} added to the trip` : 'nothing booked yet'}
            {best && <span className="opt-bar-best"> · most elite miles: {CABIN_NAME[mainCabin(best)]}, ≈ {roughly(eliteMiles(best).mid)}</span>}
          </span>
        </button>
        <button type="button" className="icon-btn icon-btn-sm fold-chev-btn" aria-label={open ? 'Fold flight options' : 'Open flight options'} aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronDown size={15} className="fold-chev" aria-hidden />
        </button>
      </div>
      {!open && (
        <div className="blur-wrap">
        <div ref={peek.ref} onScroll={peek.onScroll} className="opt-peek">
          {split ? (
            <>
              <span className="opt-peek-group">Departing</span>
              {departing.map(chip)}
              <span className="opt-peek-group">Returning</span>
              {returning.map(chip)}
            </>
          ) : (
            ordered.map(chip)
          )}
        </div>
        <ScrollBlur axis="x" edges={peek.edges} />
        </div>
      )}
      {open && (
        <div className="trip-section-body">
          {split && (
            <div className="opt-dir">
              <Seg
                label="Which way"
                value={dir}
                onChange={setDir}
                options={[
                  { value: 'out', label: `Departing · ${outCount}${added(departing) ? ' ✓' : ''}` },
                  { value: 'back', label: `Returning · ${backCount}${added(returning) ? ' ✓' : ''}` },
                ]}
              />
            </div>
          )}
          <div className="blur-wrap opt-grid-wrap">
          <div ref={grid.ref} onScroll={grid.onScroll} className="opt-grid">
            {shown.map((o) => (
              <OptionCard
                key={o.id}
                o={o}
                toGo={toGo}
                goal={goal}
                onToggle={() => (o.chosenAt ? unchoose.mutate(o.id) : choose.mutate(o.id))}
                onRemove={() => window.confirm(`Remove the option “${o.title}”?`) && remove.mutate(o.id)}
                busy={(choose.isPending && choose.variables === o.id) || (unchoose.isPending && unchoose.variables === o.id)}
              />
            ))}
          </div>
          <ScrollBlur axis="x" edges={grid.edges} />
          </div>
        </div>
      )}
      {(choose.error || unchoose.error) && <p className="error-text">{(choose.error ?? unchoose.error)!.message}</p>}
    </section>
  );
}

/** One way to make the journey: three numbers that decide it, the route as a timeline of airports, then the fine print. */
function OptionCard({ o, toGo, goal, onToggle, onRemove, busy }: { o: FlightOption; toGo: number | null; goal: string; onToggle: () => void; onRemove: () => void; busy: boolean }) {
  const elite = eliteMiles(o);
  const first = o.legs[0]!;
  const last = o.legs[o.legs.length - 1]!;
  const total = minutesBetween(first.startUtc, last.endUtc);
  const stops = o.legs.slice(0, -1).map((l, i) => ({ code: l.toCode, wait: minutesBetween(l.endUtc, o.legs[i + 1]!.startUtc) }));
  const plusDays = (from: string, to: string) => daysFrom(dayOf(from), dayOf(to));
  return (
    <article className={cx('opt-card', o.recommended && 'is-recommended', o.chosenAt && 'is-chosen')}>
      <header className="opt-head">
        <span className="opt-title-row">
          <span className="opt-title">{o.title}</span>
          <span className={cx('opt-cabin', `is-${mainCabin(o)}`)}>{CABIN_NAME[mainCabin(o)]}</span>
        </span>
        {o.chosenAt ? (
          <span className="opt-badge is-chosen">
            <CheckIcon size={12} /> Added
          </span>
        ) : (
          o.recommended && (
            <span className="opt-badge">
              <Star size={12} /> Recommended
            </span>
          )
        )}
      </header>
      {o.summary && <p className="opt-summary">{o.summary}</p>}

      <dl className="opt-stats">
        <div>
          <dt>Lands</dt>
          <dd>{time(last.endLocal)}</dd>
          <dd className="opt-stat-sub">{weekday(dayOf(last.endLocal))}</dd>
        </div>
        <div>
          <dt>Journey</dt>
          <dd>{hm(total)}</dd>
          <dd className="opt-stat-sub">{plural(o.legs.length, 'flight')}</dd>
        </div>
        <div>
          <dt>{stops.length === 1 ? 'Stop' : 'Stops'}</dt>
          <dd>{stops.length ? stops.map((x) => x.code).join(' · ') : 'Nonstop'}</dd>
          <dd className="opt-stat-sub">{stops.length ? `${hm(stops.reduce((n, x) => n + x.wait, 0))} wait` : '—'}</dd>
        </div>
      </dl>

      <div className="opt-elite">
        <span className="opt-elite-label">KrisFlyer elite miles</span>
        <b>≈ {elite.mid.toLocaleString()}</b>
        <span className="opt-elite-sub">
          {elite.high ? `${roughly(elite.low)}–${roughly(elite.high)} by fare (Lite to Flexi)` : 'None: these airlines don’t credit KrisFlyer elite miles'}
          {toGo !== null && elite.mid > 0 && (toGo - elite.mid > 0 ? ` · ${roughly(toGo - elite.mid)} to ${goal} after` : ` · enough for ${goal}`)}
        </span>
      </div>

      <ol className="opt-journey">
        {o.legs.map((l, i) => (
          <li key={i} className="opt-segment">
            {i === 0 ? (
              <div className="opt-stop">
                <span className="opt-time">{time(l.startLocal)}</span>
                <span className="opt-dot" aria-hidden />
                <span className="opt-place">
                  <b>{l.fromCode}</b> {l.fromCity}
                </span>
                <span className="opt-day">{weekday(dayOf(l.startLocal))}</span>
              </div>
            ) : (
              <div className="opt-stop is-onward">
                <span className="opt-time">{time(l.startLocal)}</span>
                <span className="opt-dot is-small" aria-hidden />
                <span className="opt-place faint">departs</span>
                <span className="opt-day">{dayOf(l.startLocal) !== dayOf(o.legs[i - 1]!.endLocal) ? weekday(dayOf(l.startLocal)) : ''}</span>
              </div>
            )}
            <div className="opt-flight">
              <span />
              <span className="opt-rail" aria-hidden />
              <span className="opt-flight-body">
                <AirlineTail code={l.carrier} size={22} />
                <span>
                  {`${l.carrier} ${l.number}`.trim()} · {hm(minutesBetween(l.startUtc, l.endUtc))}
                  {l.miles > 0 && ` · ${l.miles.toLocaleString()} mi`}
                  {(l.cabin ?? 'economy') !== mainCabin(o) && ` · ${CABIN_NAME[l.cabin ?? 'economy']}`}
                </span>
                {!earnsElite(l.carrier) && <span className="opt-no-elite">no elite miles</span>}
              </span>
            </div>
            <div className="opt-stop is-arrival">
              <span className="opt-time">
                {time(l.endLocal)}
                {plusDays(l.startLocal, l.endLocal) > 0 && <sup>+{plusDays(l.startLocal, l.endLocal)}</sup>}
              </span>
              <span className={cx('opt-dot', i === o.legs.length - 1 && 'is-end')} aria-hidden />
              <span className="opt-place">
                <b>{l.toCode}</b> {l.toCity}
              </span>
              {i < o.legs.length - 1 ? <span className="opt-wait">{hm(stops[i]!.wait)} connection</span> : <span className="opt-day">{weekday(dayOf(l.endLocal))}</span>}
            </div>
          </li>
        ))}
      </ol>

      {o.notes.length > 0 && (
        <details className="opt-notes">
          <summary>{plural(o.notes.length, 'thing', 'things')} to know</summary>
          <ul>
            {o.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </details>
      )}

      <footer className="opt-foot">
        <button
          type="button"
          className={cx('btn btn-sm opt-choose', o.recommended && !o.chosenAt && 'btn-primary', o.chosenAt && 'is-added')}
          disabled={busy}
          aria-pressed={!!o.chosenAt}
          onClick={onToggle}
          title={o.chosenAt ? 'Take these planned flights off the trip' : 'Adds these flights to the trip as planned flights; book them separately'}
        >
          {busy ? <Spinner /> : o.chosenAt ? <CheckIcon size={13} className="opt-added-icon" /> : <Plus size={13} />}
          {o.chosenAt ? (
            <span className="opt-added-label">
              <span className="is-rest">Flights added to the trip</span>
              <span className="is-hover">Take them off the trip</span>
            </span>
          ) : (
            'Use these flights'
          )}
        </button>
        <button type="button" className="icon-btn icon-btn-sm opt-remove" onClick={onRemove} aria-label={`Remove the option ${o.title}`} title="Remove this option">
          <Trash2 size={14} />
        </button>
      </footer>
    </article>
  );
}

/** "1 km", "850 m", "25 km": close distances in metres, the rest in kilometres. */
const distanceLabel = (km: number) => (km < 1 ? `${Math.round((km * 1000) / 50) * 50} m` : `${km < 10 ? Math.round(km * 10) / 10 : Math.round(km)} km`);

/** Hotels to weigh before booking, nearest to where the days are spent first, each one tap from the trip. */
function StayOptions({ trip, booked }: { trip: Trip; booked: boolean }) {
  const choose = useWrite((id: string) => travelWrite.post(`/stay-options/${id}/choose`));
  const unchoose = useWrite((id: string) => travelWrite.post(`/stay-options/${id}/unchoose`));
  const remove = useWrite((id: string) => travelWrite.del(`/stay-options/${id}`));
  const froms = [...new Set(trip.stayOptions.map((o) => o.distanceFrom).filter(Boolean))];
  const byDistance = trip.stayOptions.some((o) => o.distanceKm != null);
  return (
    <div className={cx('stay-options', booked && 'is-after-booking')}>
      <p className="stay-options-head">
        {plural(trip.stayOptions.length, 'option')}
        {byDistance && (froms.length === 1 ? `, nearest to ${froms[0]} first` : ', nearest first')} · not booked
      </p>
      <ol className="stay-list">
        {trip.stayOptions.map((o, i) => (
          <StayOptionRow
            key={o.id}
            o={o}
            rank={i + 1}
            showFrom={froms.length > 1}
            busy={(choose.isPending && choose.variables === o.id) || (unchoose.isPending && unchoose.variables === o.id)}
            onToggle={() => (o.chosenAt ? unchoose.mutate(o.id) : choose.mutate(o.id))}
            onRemove={() => window.confirm(`Remove the hotel option “${o.name}”?`) && remove.mutate(o.id)}
          />
        ))}
      </ol>
      {(choose.error || unchoose.error) && <p className="error-text">{(choose.error ?? unchoose.error)!.message}</p>}
    </div>
  );
}

function StayOptionRow({ o, rank, showFrom, busy, onToggle, onRemove }: { o: StayOption; rank: number; showFrom: boolean; busy: boolean; onToggle: () => void; onRemove: () => void }) {
  const more = o.notes.length > 0 || !!o.address;
  return (
    <li className={cx('stay-opt', o.recommended && 'is-recommended', o.chosenAt && 'is-chosen')}>
      <span className="stay-rank num" aria-hidden>
        {rank}
      </span>
      <div className="stay-body">
        <div className="stay-title-row">
          <span className="stay-name">{o.name}</span>
          {o.chosenAt ? (
            <span className="opt-badge is-chosen">
              <CheckIcon size={12} /> Added
            </span>
          ) : (
            o.recommended && (
              <span className="opt-badge">
                <Star size={12} /> Recommended
              </span>
            )
          )}
        </div>
        <div className="stay-meta">
          {o.distanceKm != null && (
            <b className="stay-distance">
              <MapPin size={12} /> {distanceLabel(o.distanceKm)}
              {showFrom && o.distanceFrom ? ` to ${o.distanceFrom}` : ''}
            </b>
          )}
          {[o.gettingThere, o.area].filter(Boolean).map((x) => (
            <span key={x}>{x}</span>
          ))}
        </div>
        {o.summary && <p className="stay-summary">{o.summary}</p>}
        <div className="stay-foot">
          {more ? (
            <details className="stay-notes">
              <summary>{o.notes.length ? plural(o.notes.length, 'thing', 'things') + ' to know' : 'Address'}</summary>
              <ul>
                {o.address && <li>{o.address}</li>}
                {o.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </details>
          ) : (
            <span className="grow" />
          )}
          <button
            type="button"
            className={cx('btn btn-sm opt-choose stay-choose', o.recommended && !o.chosenAt && 'btn-primary', o.chosenAt && 'is-added')}
            disabled={busy}
            aria-pressed={!!o.chosenAt}
            onClick={onToggle}
            title={o.chosenAt ? 'Take this planned stay off the trip' : 'Adds this hotel to the trip as a planned stay; book it separately'}
          >
            {busy ? <Spinner /> : o.chosenAt ? <CheckIcon size={13} className="opt-added-icon" /> : <Plus size={13} />}
            {o.chosenAt ? (
              <span className="opt-added-label">
                <span className="is-rest">Added to the trip</span>
                <span className="is-hover">Take it off the trip</span>
              </span>
            ) : (
              'Use this hotel'
            )}
          </button>
          <button type="button" className="icon-btn icon-btn-sm opt-remove" onClick={onRemove} aria-label={`Remove the hotel option ${o.name}`} title="Remove this option">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </li>
  );
}

/** A trip's own page: everything about it, at /trips/:id. */
export function TripPage({ id }: { id: string }) {
  const { data: t, isError } = useTravel();
  const { spheres } = useApp();
  const travels = spheres.find((s) => s.key === 'travels');
  const backTo = travels ? { href: `/spheres/${travels.id}`, label: travels.name } : { href: '/spheres', label: 'Spheres' };
  const trip = t?.trips.find((x) => x.id === id);
  const back = (
    <Link href={backTo.href} className="back">
      <ArrowLeft size={15} /> {backTo.label}
    </Link>
  );
  if (!t && !isError) return <div className="page">{back}</div>;
  if (!trip)
    return (
      <div className="page">
        {back}
        <div className="empty-block">
          <h3>This trip isn't here</h3>
          <p>It may have been deleted, or it ended a while ago.</p>
        </div>
      </div>
    );
  const today = todayStr();
  return (
    <div className="page trip-page">
      {back}
      <TripDetail
        trip={trip}
        state={t!}
        head={
          <div>
            <h1 className="page-title">{trip.title}</h1>
            <div className="trip-sub">
              <PurposeChip purpose={trip.purpose} />
              <span>{dates(trip.startDate, trip.endDate)}</span>
              <span className="faint">· {whenLabel(trip, today)}</span>
            </div>
          </div>
        }
      />
    </div>
  );
}

// ── The Travels sphere ──────────────────────────────────────────────────────

/** Trips, with their bookings and plans: what you work with in the Travels sphere. */
export function TravelTrips() {
  const { data: t } = useTravel();
  const [newTrip, setNewTrip] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const row = useScrollEdges<HTMLDivElement>('x', [t?.trips.length, showPast]);
  // Older links to a trip (?trip=…) now go to its own page.
  const wanted = new URLSearchParams(useUrlSearch()).get('trip');
  const [, navigate] = useLocation();
  useEffect(() => {
    if (wanted) navigate(`/trips/${wanted}`, { replace: true });
  }, [wanted, navigate]);
  if (!t) return null;
  const today = todayStr();
  const upcoming = t.trips.filter((x) => x.endDate >= today);
  const past = t.trips.filter((x) => x.endDate < today);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Trips</h2>
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setImporting(true)}>
            <Camera size={13} /> From a confirmation
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNewTrip(true)}>
            <Plus size={13} /> New trip
          </button>
        </div>
      </div>
      {upcoming.length === 0 && <p className="empty">Nothing booked. Start a trip, or send a confirmation.</p>}
      {/* One row, side by side, scrolled sideways: the next trip first. */}
      <div className="blur-wrap trip-row-wrap">
        <div ref={row.ref} onScroll={row.onScroll} className="trip-list is-row">
          {upcoming.map((trip) => (
            <TripSummary key={trip.id} trip={trip} />
          ))}
          {showPast && past.map((trip) => <TripSummary key={trip.id} trip={trip} />)}
        </div>
        <ScrollBlur axis="x" edges={row.edges} />
      </div>
      {past.length > 0 && (
        <button type="button" className="link trip-past-toggle" onClick={() => setShowPast((v) => !v)}>
          {showPast ? 'Hide past trips' : `Past trips (${past.length})`}
        </button>
      )}
      {newTrip && <TripSheet trip={null} onClose={() => setNewTrip(false)} />}
      {importing && <ImportSheet onClose={() => setImporting(false)} />}
    </section>
  );
}

/** Tier, miles and points: something you look up more than you change. */
export function TravelLoyalty() {
  const { data: t } = useTravel();
  const [loyalty, setLoyalty] = useState<LoyaltyAccount | 'new' | null>(null);
  if (!t) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Status &amp; points</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLoyalty('new')}>
          <Plus size={13} /> Programme
        </button>
      </div>
      {t.loyalty.length === 0 ? (
        <p className="empty">Add KrisFlyer and Marriott Bonvoy to see your tier, miles and points here — and the lounges they get you into.</p>
      ) : (
        <div className="loyalty-row">
          {t.loyalty.map((a) => (
            <LoyaltyCard key={a.id} a={a} onEdit={() => setLoyalty(a)} />
          ))}
        </div>
      )}
      {loyalty && <LoyaltySheet account={loyalty === 'new' ? null : loyalty} onClose={() => setLoyalty(null)} />}
    </section>
  );
}

/** Work trips, shown in the Work sphere. */
export function WorkTrips() {
  const { data: t } = useTravel();
  const today = todayStr();
  const trips = t?.trips.filter((x) => x.purpose === 'work' && x.endDate >= today) ?? [];
  if (!trips.length) return null;
  return (
    <section className="card" style={{ paddingBottom: 10 }}>
      <div className="card-head">
        <h2 className="card-title">Work travel</h2>
      </div>
      {trips.map((trip) => {
        const f = trip.segments.find((s) => s.kind === 'flight' && s.endUtc > new Date().toISOString());
        return (
          <Link key={trip.id} href={`/trips/${trip.id}`} className="horizon-item horizon-link">
            <Briefcase size={14} className="faint" />
            <span className="grow clamp-1">
              {trip.title} <span className="faint">· {dates(trip.startDate, trip.endDate)}</span>
            </span>
            <span className="faint" style={{ fontSize: 12.5 }}>
              {f ? `${f.carrier} ${f.number} ${weekday(dayOf(f.startLocal))}` : whenLabel(trip, today)}
            </span>
            <ChevronRight size={14} className="faint" />
          </Link>
        );
      })}
    </section>
  );
}

// ── Travel mode, on Today ───────────────────────────────────────────────────

function Block({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="tm-block">
      <div className="tm-label">
        {icon} {title}
      </div>
      {children}
    </div>
  );
}

/** A trip's to-dos: open ones to tick off, the done ones folded away, and a line to add another. */
function TripTodos({ trip, past = false }: { trip: Trip; past?: boolean }) {
  const open = trip.todos.filter((t) => !t.done);
  const done = trip.todos.filter((t) => t.done);
  return (
    <div className="trip-todos">
      {open.length > 0 && (
        <ul>
          {open.map((t) => (
            <TaskRow key={t.id} task={t} showSphere={false} />
          ))}
        </ul>
      )}
      {done.length > 0 && (
        <details className="trip-todos-done">
          <summary>{plural(done.length, 'done', 'done')}</summary>
          <ul>
            {done.map((t) => (
              <TaskRow key={t.id} task={t} showSphere={false} />
            ))}
          </ul>
        </details>
      )}
      {!past && <AddTask tripId={trip.id} placeholder={open.length || done.length ? 'Add a to-do…' : `Add a to-do for ${trip.title}…`} />}
    </div>
  );
}

/** Whether the trip card's to-dos are shown: a per-device preference, remembered when the browser allows. */
function useTodosShown(): [boolean, (v: boolean) => void] {
  const KEY = 'terminus.tripTodos';
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== 'hidden';
    } catch {
      return true;
    }
  });
  const set = (v: boolean) => {
    setShown(v);
    try {
      localStorage.setItem(KEY, v ? 'shown' : 'hidden');
    } catch {
      /* private mode: remembered for this visit only */
    }
  };
  return [shown, set];
}

const weekdayShort = (d: string) => parseDay(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/** One trip ahead, in the manner of the Ramadan countdown: days to go, the way out and back, then what is left to do. */
function TripCountdown({ trip }: { trip: Trip }) {
  const { agentName } = useApp();
  const openTrip = useOpenTrip();
  const draft = useWrite(() => travelWrite.post(`/trips/${trip.id}/draft`));
  const today = todayStr();
  const days = daysFrom(today, trip.startDate);
  const flights = trip.segments.filter((s) => s.kind === 'flight');
  const stays = trip.segments.filter((s) => s.kind === 'stay');
  const { data: travel } = useTravel();
  const home = travel?.settings.homeAirport ?? 'SIN';
  const out = flights[0];
  // The way home is a flight back to your home airport (or to where the trip began), not just the last flight booked.
  const back = flights
    .slice(1)
    .reverse()
    .find((f) => f.toCode === home || (!!out && f.toCode === out.fromCode));
  const openTodos = trip.todos.filter((x) => !x.done).length;
  const legs = globeLegs(flights);
  const [showTodos, toggleTodos] = useTodosShown();
  const leg = (s: Segment) => `${`${s.carrier} ${s.number}`.trim()} · ${s.startLocal.slice(11, 16)} from ${s.fromCode || s.fromName}`;

  return (
    <section className={cx('trip-hero', 'is-link', trip.purpose === 'work' ? 'is-work' : 'is-leisure')} onClick={(e) => onCardItself(e) && openTrip(trip)}>
      <div className="trip-hero-head">
        {days > 0 ? (
          <>
            <span className="trip-hero-count num">{days}</span>
            <b>
              {days === 1 ? 'day' : 'days'} until {trip.title}
            </b>
          </>
        ) : (
          <b>{trip.title} starts today</b>
        )}
        <span className="trip-hero-tag">
          <PlaneTakeoff size={13} aria-hidden /> {trip.purpose === 'work' ? 'Work' : 'Personal'}
        </span>
      </div>
      {legs.length > 0 && (
        <div className="trip-hero-globe">
          <RouteGlobe legs={legs} />
        </div>
      )}
      <dl className="trip-hero-legs">
        <div>
          <dt>{out ? 'Flies out' : 'Starts'}</dt>
          <dd>{weekdayShort(out ? out.startLocal.slice(0, 10) : trip.startDate)}</dd>
          <dd className="trip-hero-sub">{out ? leg(out) : 'No flight booked yet'}</dd>
        </div>
        <div>
          <dt>{back || out ? 'Flies home' : 'Ends'}</dt>
          <dd>{weekdayShort(back ? back.startLocal.slice(0, 10) : trip.endDate)}</dd>
          <dd className="trip-hero-sub">{back ? leg(back) : out ? 'Return not booked yet' : stays[0]?.title || plural(daysFrom(trip.startDate, trip.endDate) + 1, 'day')}</dd>
        </div>
      </dl>
      {!trip.itinerary.length && trip.segments.length > 0 && (
        <button type="button" className="btn btn-sm trip-hero-btn" disabled={draft.isPending} onClick={() => draft.mutate()}>
          {draft.isPending ? <Spinner /> : <Wand2 size={13} />} Draft a plan with {agentName}
        </button>
      )}
      {draft.error && <p className="trip-hero-note">{draft.error.message}</p>}
      <div className={cx('trip-hero-todos', !showTodos && 'is-collapsed')}>
        <div className="trip-hero-todos-head">
          <button type="button" className="trip-hero-label trip-hero-toggle" aria-expanded={showTodos} onClick={() => toggleTodos(!showTodos)}>
            To do{openTodos > 0 && <span className="trip-hero-badge num">{openTodos}</span>}
            <ChevronDown size={14} className="trip-hero-chev" aria-hidden />
          </button>
          <button type="button" className="trip-hero-open" onClick={() => openTrip(trip)}>
            Full plan <ChevronRight size={14} aria-hidden />
          </button>
        </div>
        {showTodos && <TripTodos trip={trip} />}
      </div>
    </section>
  );
}

/** Trips that follow on within a week: each starts no more than seven days after the one before it ends. */
export function followingTrips(featured: Trip, rest: Trip[]): Trip[] {
  const out: Trip[] = [];
  let end = featured.endDate;
  for (const x of [...rest].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
    if (daysFrom(end, x.startDate) > 7) break;
    out.push(x);
    if (x.endDate > end) end = x.endDate;
  }
  return out;
}

/**
 * Whether today is a travel day: a journey is under way (from 18 hours before the flight to 6
 * after landing) or a flight leaves within 36 hours. Today then leads with the travel card.
 */
export function useTravelDay(): boolean {
  const { data: t } = useTravel();
  const now = useNow();
  const segments = useMemo(() => t?.trips.flatMap((x) => x.segments) ?? [], [t]);
  const journey = useMemo(() => activeJourney(segments, now), [segments, now]);
  if (!t) return false;
  return (!!journey && t.trips.some((x) => x.id === journey.legs[0]!.tripId)) || (t.context.mode === 'departing' && !!t.context.trip);
}

/**
 * Travel on Today features one trip: the one under way (a flight today, or away now), else the
 * next one ahead. The trip that follows on within a week tucks beneath it as a notch that
 * opens it in the Travels sphere. Trips after that wait there until their turn.
 */
export function TravelModeCard() {
  const { data: t } = useTravel();
  const now = useNow();
  // A notch brings its trip up into the card; the one it replaces drops into a notch.
  const [chosen, setChosen] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);
  const segments = useMemo(() => t?.trips.flatMap((x) => x.segments) ?? [], [t]);
  const journey = useMemo(() => activeJourney(segments, now), [segments, now]);
  if (!t) return null;
  const today = todayStr();
  const c = t.context;
  // On a travel day the card follows the journey, even into the hours after you land.
  const travelDay = journey ? t.trips.find((x) => x.id === journey.legs[0]!.tripId) ?? null : null;
  const dayTrip = travelDay ?? (c.mode === 'departing' && c.trip ? c.trip : null);
  const current = dayTrip ?? (c.mode === 'away' && c.trip ? c.trip : null);
  const ahead = t.trips.filter((x) => x.endDate >= today && x.id !== current?.id).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const featured = current ?? ahead[0];
  if (!featured) return null;
  // Only the next trip tucks beneath it; the rest wait in the Travels sphere.
  const group = [featured, ...followingTrips(featured, ahead.filter((x) => x.id !== featured.id)).slice(0, 1)];
  const shown = group.find((x) => x.id === chosen) ?? featured;
  return (
    <div className="trip-feature">
      <div key={shown.id} className={cx('trip-swap', picked && 'is-swapped')}>
        {current && shown.id === current.id ? (
          dayTrip ? (
            <TravelDayCard trip={dayTrip} journey={travelDay ? journey : null} />
          ) : (
            <TravelNowCard />
          )
        ) : (
          <TripCountdown trip={shown} />
        )}
      </div>
      {group
        .filter((x) => x.id !== shown.id)
        .map((x) => (
          <TripNotch key={x.id} trip={x} label={current?.id === x.id ? 'Now' : x.startDate < shown.startDate ? 'Before' : 'Then'} onPick={() => (setPicked(true), setChosen(x.id === featured.id ? null : x.id))} />
        ))}
    </div>
  );
}

/** Open a trip's own page, with its full plan. */
function useOpenTrip() {
  const [, navigate] = useLocation();
  return (trip: Trip) => navigate(`/trips/${trip.id}`);
}

/** A click on the card itself, not on one of its controls (a to-do, the add line, a button). */
const onCardItself = (e: React.MouseEvent) => !(e.target as HTMLElement).closest('button, a, input, textarea, select, label, summary, details, [role="checkbox"], .add-row, .task');

/** A trip that follows the featured one, as a tab beneath its card. Opens the trip in the Travels sphere. */
function TripNotch({ trip, label, onPick }: { trip: Trip; label: string; onPick: () => void }) {
  const open = trip.todos.filter((x) => !x.done).length;
  const flights = trip.segments.filter((s) => s.kind === 'flight').length;
  const detail = open ? plural(open, 'to-do') : flights ? plural(flights, 'flight') : 'nothing booked yet';
  return (
    <button
      type="button"
      className={cx('trip-notch', trip.purpose === 'work' ? 'is-work' : 'is-leisure')}
      onClick={onPick}
      aria-label={`${label} ${trip.title}, ${dates(trip.startDate, trip.endDate)}. Show this trip`}
    >
      <span className="trip-notch-label">{label}</span>
      <span className="trip-notch-body">
        <b>{trip.title}</b>
        <span className="trip-notch-meta">
          {dates(trip.startDate, trip.endDate)} · {detail}
        </span>
      </span>
      <ChevronRight size={16} className="trip-notch-chev" />
    </button>
  );
}

/** Which of the travel card's folds are open: a per-device preference, remembered when the browser allows. */
function useOpenFolds(): [Set<string>, (id: string, open: boolean) => void] {
  const KEY = 'terminus.travelDay.open';
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const set = (id: string, on: boolean) =>
    setOpen((prev) => {
      if (prev.has(id) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      try {
        localStorage.setItem(KEY, JSON.stringify([...next]));
      } catch {
        /* private mode: remembered for this visit only */
      }
      return next;
    });
  return [open, set];
}

/** One line of the travel card that opens to show more: what it is, the gist, and a chevron. */
function Fold({ id, icon, title, gist, open, onToggle, children }: { id: string; icon: ReactNode; title: string; gist: ReactNode; open: boolean; onToggle: (id: string, open: boolean) => void; children: ReactNode }) {
  return (
    <details className="td-fold" open={open} onToggle={(e) => onToggle(id, (e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="td-fold-icon" aria-hidden>
          {icon}
        </span>
        <span className="td-fold-title">{title}</span>
        <span className="td-fold-gist">{gist}</span>
        <ChevronDown size={15} className="td-fold-chev" aria-hidden />
      </summary>
      <div className="td-fold-body">{children}</div>
    </details>
  );
}

/** A lounge note's name, without the directions and asides that follow it. */
interface LoungeLine {
  name: string;
  /** How you get in, when it is not your own status: "Priority Pass". */
  via: string;
  /** Where it is: terminal, level, nearby gates. */
  where: string;
  /** One thing worth knowing. */
  note: string;
}

const capital = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

/**
 * A lounge as Seldon wrote it ("With Priority Pass: Plaza Premium Lounge in T3 if Gold is busy",
 * "KrisFlyer Gold Lounge, Terminal 3 (level 3, above the transfer area) — showers") split into
 * its name, how you get in, where it is and what to know. Anything it can't place stays in the note.
 */
function loungeLine(text: string): LoungeLine {
  let rest = text.trim();
  let via = '';
  const v = rest.match(/^(?:with|via|using|on)\s+([^:]{2,40}):\s*/i);
  if (v) {
    via = v[1]!.trim();
    rest = rest.slice(v[0].length);
  }
  const [head = '', ...tail] = rest.split(/\s+[—–]\s+|\s+-\s+/);
  let note = tail.join(' — ');
  const cut = head.search(/,\s|\s\(|\s(?:in|at|on|near|by)\s/);
  const name = (cut > 0 ? head.slice(0, cut) : head).trim();
  let where = cut > 0 ? head.slice(cut).replace(/^,\s*/, '').trim() : '';
  // "Terminal 3 (level 3, above the transfer area)" reads as "Terminal 3 · level 3, above the transfer area".
  where = where.replace(/\s*\(([^)]*)\)/g, ' · $1').trim();
  // A trailing condition ("in T3 if Gold is busy") is a note, not a place.
  const cond = where.match(/^(.*?)\s+(if|when|unless|for)\s+(.*)$/i);
  if (cond) {
    where = cond[1]!.trim();
    note = [capital(`${cond[2]} ${cond[3]}`), note].filter(Boolean).join(' · ');
  }
  where = where.replace(/^(?:in|at|on)\s+/i, '').replace(/\bT(\d+[A-Z]?)\b/g, 'Terminal $1');
  return { name: name || text, via, where: where && capital(where), note: note && capital(note) };
}

/** The lounges for a flight, one to a block: the name, how you get in, where it is, what to know. */
function LoungeOptions({ seg, notes }: { seg: Segment; notes?: string[] }) {
  const lines: LoungeLine[] = notes?.length ? notes.map(loungeLine) : seg.lounges.map((l) => ({ name: l.access, via: l.basis, where: '', note: '' }));
  if (!lines.length) return <p className="hint lounge-none">No lounge from this fare or your status.</p>;
  return (
    <ul className="lounge-options">
      {lines.map((l) => (
        <li key={`${l.name}-${l.via}`}>
          <div className="lounge-option-head">
            <b>{l.name}</b>
            {l.via && <span className="lounge-option-via">{l.via}</span>}
          </div>
          {l.where && <span className="lounge-option-where">{l.where}</span>}
          {l.note && <span className="lounge-option-note">{l.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/** The day's phases as a row of stops, the one you're in lit. */
function DaySteps({ journey }: { journey: Journey }) {
  const focus = Math.max(journey.current, 0);
  return (
    <ol className="td-steps" aria-label="Your travel day">
      {journey.phases.map((p, i) => (
        <li key={`${p.kind}-${i}`} className={cx(i < focus && 'is-done', i === focus && 'is-now')} aria-current={i === focus ? 'step' : undefined}>
          <i aria-hidden />
          <span className="td-step-time num">{clock(Date.parse(p.at), p.tz)}</span>
          <span className="td-step-label">{p.label}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Today on a travel day, in one card: what to do now and where you are in the day, the flight at a
 * glance, then the lounge, Seldon's plan and the trip's to-dos folded into a line each. From 36 hours
 * before a flight; the day's steps join 18 hours out and stay until 6 hours after you land.
 */
/** The phase a travel day is in, and the flight the moment is about: on a connection, the one you're waiting for. */
function travelDayFlight(t: TravelState, journey: Journey | null): { phase: Journey['phases'][number] | null; f: Segment | null } {
  const phase = journey ? journey.phases[Math.max(journey.current, 0)]! : null;
  const f = journey && phase ? journey.legs[phase.kind === 'connection' ? phase.leg + 1 : phase.leg]! : t.context.flight;
  return { phase, f };
}

/** What to do now on a travel day and where you are in it: the headline, its line and action, the day's steps. */
function TravelDayNow({ t, journey, f, now, onLounges }: { t: TravelState; journey: Journey | null; f: Segment; now: number; onLounges: (c: { from: Segment; to: Segment }) => void }) {
  return (
    <div className="td-now">
      {journey ? (
        <NowPanel journey={journey} focus={Math.max(journey.current, 0)} now={now} trips={t.trips} home={t.settings.homeAirport} onLounges={onLounges} />
      ) : (
        <div className="journey-now">
          <b className="jn-title">
            {f.carrier} {f.number} leaves {dayOf(f.startLocal) === todayStr() ? 'today' : weekday(dayOf(f.startLocal))} at {time(f.startLocal)}
          </b>
          <span className="jn-sub">
            Be at {f.fromTerminal ? `Terminal ${f.fromTerminal}, ${city(f.fromName, f.fromCode)}` : city(f.fromName, f.fromCode)} by {clock(reachAirportBy(f), f.startTz)} · set off by {clock(leaveBy(f), f.startTz)}
          </span>
        </div>
      )}
      {journey && <DaySteps journey={journey} />}
    </div>
  );
}

/** A flight's airport plan from Seldon, or a button to have one written. */
function AirportPlan({ trip, f }: { trip: Trip; f: Segment }) {
  const { agentName } = useApp();
  const prepare = useWrite((id: string) => travelWrite.post(`/segments/${id}/companion`));
  const plan = trip.companion[f.id]?.plan ?? [];
  if (plan.length)
    return (
      <ul className="tm-plan">
        {plan.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    );
  return (
    <>
      <button type="button" className="btn btn-sm" disabled={prepare.isPending} onClick={() => prepare.mutate(f.id)}>
        {prepare.isPending ? <Spinner /> : <Sparkles size={13} />} Prepare this airport with {agentName}
      </button>
      {prepare.error && <p className="error-text">{prepare.error.message}</p>}
    </>
  );
}

/**
 * On a trip's page, Today's travel-day card comes apart into cards of its own: what to do now (with
 * the day's steps), then the lounge and Seldon's plan, each open. The flight and the to-dos are
 * left to the page's own Flights and To-dos cards.
 */
function TripDayCards({ trip, journey }: { trip: Trip; journey: Journey | null }) {
  const { data: t } = useTravel();
  const { agentName, ask } = useApp();
  const now = useNow();
  const [lounges, setLounges] = useState<{ from: Segment; to: Segment } | null>(null);
  if (!t) return null;
  const { f } = travelDayFlight(t, journey);
  if (!f) return null;
  const beforeTakeoff = now < departs(f);
  const notes = trip.companion[f.id];
  const loungeNotes = notes?.lounges?.length ? notes.lounges : f.lounges.map((l) => l.access);
  const loungeTrip = lounges ? t.trips.find((x) => x.id === lounges.to.tripId) : undefined;
  return (
    <>
      <section className="card travel-mode travel-day">
        <TravelDayNow t={t} journey={journey} f={f} now={now} onLounges={setLounges} />
        <div className="td-foot">
          <button type="button" className="link" onClick={() => ask(`I'm flying ${f.carrier} ${f.number} from ${f.fromCode} to ${f.toCode}. What should I do before boarding, and what should I know on arrival?`)}>
            Ask {agentName} about this flight
          </button>
        </div>
      </section>
      {beforeTakeoff && (
        <FoldCard id={`${trip.id}.lounge`} icon={<Sofa size={15} />} title="Lounge" peek={loungeNotes.length ? `${loungeLine(loungeNotes[0]!).name}${loungeNotes.length > 1 ? ` · +${loungeNotes.length - 1}` : ''}` : 'None on this fare'}>
          <LoungeOptions seg={f} notes={notes?.lounges} />
        </FoldCard>
      )}
      {beforeTakeoff && (
        <FoldCard id={`${trip.id}.airport-plan`} icon={<Sparkles size={15} />} title={`${agentName}'s plan`} peek={notes?.plan?.length ? plural(notes.plan.length, 'step') : 'Not written yet'}>
          <AirportPlan trip={trip} f={f} />
        </FoldCard>
      )}
      {lounges && loungeTrip && <LayoverSheet trip={loungeTrip} from={lounges.from} to={lounges.to} loyalty={t.loyalty} onClose={() => setLounges(null)} />}
    </>
  );
}

function TravelDayCard({ trip, journey }: { trip: Trip; journey: Journey | null }) {
  const { data: t } = useTravel();
  const { agentName, ask } = useApp();
  const openTrip = useOpenTrip();
  const now = useNow();
  const prepare = useWrite((id: string) => travelWrite.post(`/segments/${id}/companion`));
  const [folds, setFold] = useOpenFolds();
  const [lounges, setLounges] = useState<{ from: Segment; to: Segment } | null>(null);
  if (!t) return null;
  const { phase, f } = travelDayFlight(t, journey);
  if (!f) return null;
  const takesOff = departs(f);
  const beforeTakeoff = now < takesOff;
  const notes = trip.companion[f.id];
  const loungeNotes = notes?.lounges?.length ? notes.lounges : f.lounges.map((l) => l.access);
  const openTodos = trip.todos.filter((x) => !x.done).length;
  const loungeTrip = lounges ? t.trips.find((x) => x.id === lounges.to.tripId) : undefined;

  return (
    <section className="card travel-mode travel-day is-link" onClick={(e) => onCardItself(e) && openTrip(trip)}>
      <div className="tm-head">
        <span className="tm-kicker">
          <Plane size={13} aria-hidden /> {trip.title}
        </span>
        <PurposeChip purpose={trip.purpose} />
      </div>

      <TravelDayNow t={t} journey={journey} f={f} now={now} onLounges={setLounges} />

      {/* In the air and after landing, the panel above already draws the flight. */}
      {!(phase && (phase.kind === 'flight' || phase.kind === 'arrived')) && (
        <div className="flight-card is-inline">
          <FlightFace s={f} badge={beforeTakeoff ? { label: `Leaves in ${untilLabel(new Date(departs(f)).toISOString(), now)}`, tone: 'soon' } : undefined} />
        </div>
      )}

      {(beforeTakeoff || openTodos > 0) && (
        <div className="td-folds">
          {beforeTakeoff && (
            <Fold id="lounge" icon={<Sofa size={14} />} title="Lounge" gist={loungeNotes.length ? `${loungeLine(loungeNotes[0]!).name}${loungeNotes.length > 1 ? ` · +${loungeNotes.length - 1}` : ''}` : 'None on this fare'} open={folds.has('lounge')} onToggle={setFold}>
              <LoungeOptions seg={f} notes={notes?.lounges} />
            </Fold>
          )}
          {beforeTakeoff &&
            (notes?.plan?.length ? (
              <Fold id="plan" icon={<Sparkles size={14} />} title={`${agentName}'s plan`} gist={plural(notes.plan.length, 'step')} open={folds.has('plan')} onToggle={setFold}>
                <ul className="tm-plan">
                  {notes.plan.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Fold>
            ) : (
              <button type="button" className="td-fold-action" disabled={prepare.isPending} onClick={() => prepare.mutate(f.id)}>
                <span className="td-fold-icon" aria-hidden>
                  {prepare.isPending ? <Spinner /> : <Sparkles size={14} />}
                </span>
                <span className="td-fold-title">Prepare this airport with {agentName}</span>
              </button>
            ))}
          {openTodos > 0 && (
            <Fold id="todos" icon={<ListChecks size={14} />} title="Still to do" gist={plural(openTodos, 'to-do')} open={folds.has('todos')} onToggle={setFold}>
              <TripTodos trip={trip} past />
            </Fold>
          )}
        </div>
      )}
      {prepare.error && <p className="error-text">{prepare.error.message}</p>}

      <div className="td-foot">
        <button type="button" className="link" onClick={() => ask(`I'm flying ${f.carrier} ${f.number} from ${f.fromCode} to ${f.toCode}. What should I do before boarding, and what should I know on arrival?`)}>
          Ask {agentName} about this flight
        </button>
        <button type="button" className="trip-hero-open" onClick={() => openTrip(trip)}>
          Full plan <ChevronRight size={14} aria-hidden />
        </button>
      </div>
      {lounges && loungeTrip && <LayoverSheet trip={loungeTrip} from={lounges.from} to={lounges.to} loyalty={t.loyalty} onClose={() => setLounges(null)} />}
    </section>
  );
}

function TravelNowCard() {
  const { data: t } = useTravel();
  const { agentName, ask } = useApp();
  const openTrip = useOpenTrip();
  const now = useNow();
  const toggle = useWrite((i: ItineraryItem) => travelWrite.patch(`/itinerary/${i.id}`, { done: !i.done }));
  if (!t || t.context.mode !== 'away' || !t.context.trip) return null;
  const { context: c } = t;
  const trip = c.trip!;
  const today = todayStr();

  // Away.
  const items = trip.itinerary.filter((i) => i.date === today);
  const hhmmNow = new Date(now).toTimeString().slice(0, 5);
  const nextItem = items.find((i) => !i.done && (i.time ?? '99:99') >= hhmmNow);
  return (
    <section className="card travel-mode tm-away is-link" onClick={(e) => onCardItself(e) && openTrip(trip)}>
      <div className="tm-head">
        <span className="tm-kicker">
          <Palmtree size={13} /> {trip.title} · day {c.dayOfTrip} of {c.tripDays}
        </span>
        <PurposeChip purpose={trip.purpose} />
      </div>
      <div className="journey-now tm-welcome">
        <WelcomeTitle tz={c.here?.tz ?? c.stay?.startTz} city={c.here?.city || trip.destination || trip.title} />
      </div>
      {c.stay && (
        <div className="tm-stay">
          <Hotel size={15} />
          <div className="grow">
            <b>{c.stay.title}</b>
            {c.stay.perks.length > 0 && <span className="faint"> · {c.stay.perks.slice(0, 2).join(' · ')}</span>}
          </div>
        </div>
      )}
      <Block icon={<CalendarDays size={13} />} title="Today">
        {items.length === 0 ? (
          <p className="tm-small">
            Nothing planned.{' '}
            <button type="button" className="link" onClick={() => ask(`I'm in ${trip.destination || trip.title} today with nothing planned. Suggest a good day nearby — halal food included — and add it to my trip plan.`)}>
              Ask {agentName} for a day
            </button>
          </p>
        ) : (
          <ul className="tm-today">
            {items.map((i) => (
              <li key={i.id} className={cx(i.done && 'is-done', nextItem?.id === i.id && 'is-next')}>
                <Check checked={i.done} onChange={() => toggle.mutate(i)} label={`Done: ${i.title}`} />
                <span className="plan-time num">{i.time ?? '·'}</span>
                <span className="grow">
                  {i.title}
                  {i.place && <span className="faint"> · {i.place}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>
      {/* Once every trip to-do is done, the section goes; the trip's page still has them. */}
      {trip.todos.some((x) => !x.done) && (
        <Block icon={<ListChecks size={13} />} title="Trip to-dos">
          <TripTodos trip={trip} />
        </Block>
      )}
    </section>
  );
}

/** One line in the Today header when a trip is near or under way. */
export function TravelPill() {
  const { data: t } = useTravel();
  const now = useNow();
  if (!t || t.context.mode === 'none' || !t.context.trip) return null;
  const c = t.context;
  const label = c.flight ? `${c.flight.carrier} ${c.flight.number} in ${untilLabel(c.flight.startUtc, now)}` : c.mode === 'away' ? `${c.trip!.title} · day ${c.dayOfTrip}` : `${c.trip!.title} ${whenLabel(c.trip!, todayStr())}`;
  return (
    <span className="glass-pill">
      <Plane size={13} /> {label}
    </span>
  );
}
