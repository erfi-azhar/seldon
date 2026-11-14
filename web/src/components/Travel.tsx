// Travel: your KrisFlyer and Bonvoy standing, trips with their flights and stays, an
// editable day plan — and on Today, a travel-mode card that changes with the moment:
// the flight you are about to take and the lounge you can use, the layover and what to
// do with it, or the day you are on when away.

import { BedDouble, Briefcase, CalendarDays, Camera, ChevronDown, Clock, Hotel, ListChecks, Loader2, Palmtree, Pencil, Plane, PlaneTakeoff, Plus, Sofa, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import type { ItineraryItem, LoyaltyAccount, Segment, TravelState, Trip, TripPurpose } from '../../../shared/types.ts';
import { postForm, travelWrite, useTravel, useWrite } from '../api.ts';
import { cx, daysFrom, formatNumber, parseDay, parseNumber, plural, shortDay, todayStr } from '../lib.ts';
import { useApp } from '../state.tsx';
import { untilLabel, useNow } from './Prayer.tsx';
import { AddTask, TaskRow } from './rows.tsx';
import { Check, Field, Modal, Seg, Spinner } from './ui.tsx';

// ── Small helpers ───────────────────────────────────────────────────────────

const time = (local: string) => local.slice(11, 16);
const dayOf = (local: string) => local.slice(0, 10);
const weekday = (date: string) => parseDay(date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const dates = (from: string, to: string) => (from === to ? shortDay(from) : `${shortDay(from)} – ${shortDay(to)}`);
const duration = (s: Segment) => {
  const mins = Math.round((Date.parse(s.endUtc) - Date.parse(s.startUtc)) / 60_000);
  return mins > 0 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : '';
};
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
  });
  // Fields this form does not show are left out, so an edit keeps them (a hotel's brand, a train's operator).
  const body = () =>
    kind === 'flight'
      ? { kind, carrier: f.carrier, number: f.number, fromCode: f.fromCode, toCode: f.toCode, startLocal: f.startLocal, endLocal: f.endLocal, cabin: f.cabin, seat: f.seat, confirmation: f.confirmation }
      : kind === 'stay'
        ? { kind, title: f.title, address: f.address, startLocal: f.startLocal, endLocal: f.endLocal, confirmation: f.confirmation }
        : { kind, title: f.title, address: f.address, startLocal: f.startLocal, endLocal: f.endLocal, seat: f.seat, confirmation: f.confirmation };
  const save = useWrite(() => (segment ? travelWrite.patch(`/segments/${segment.id}`, body()) : travelWrite.post(`/trips/${trip.id}/segments`, body())));
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
          <button className="btn btn-primary btn-sm" onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
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
            <Field label="Departs (local)">
              <input className="input" type="datetime-local" value={f.startLocal} onChange={set('startLocal')} />
            </Field>
            <Field label="Arrives (local)">
              <input className="input" type="datetime-local" value={f.endLocal} onChange={set('endLocal')} />
            </Field>
          </div>
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

function LoungeList({ seg, notes }: { seg: Segment; notes?: string[] }) {
  if (notes?.length)
    return (
      <ul className="lounge-list">
        {notes.map((n) => (
          <li key={n}>
            <Sofa size={13} /> {n}
          </li>
        ))}
      </ul>
    );
  if (!seg.lounges.length) return <p className="hint lounge-none">No lounge from this fare or your status.</p>;
  return (
    <ul className="lounge-list">
      {seg.lounges.map((l) => (
        <li key={l.access}>
          <Sofa size={13} /> {l.access}
          <span className="faint"> · {l.basis}</span>
        </li>
      ))}
    </ul>
  );
}

function FlightRow({ s, onEdit }: { s: Segment; onEdit: () => void }) {
  return (
    <button type="button" className="seg-row seg-flight" onClick={onEdit}>
      <span className="seg-icon">
        <Plane size={15} />
      </span>
      <div className="grow">
        <div className="seg-route">
          <span>
            <b className="num">{s.fromCode || '—'}</b> <span className="num">{time(s.startLocal)}</span>
          </span>
          <span className="seg-line">
            <i />
            <em>{duration(s)}</em>
            <i />
          </span>
          <span>
            <b className="num">{s.toCode || '—'}</b> <span className="num">{time(s.endLocal)}</span>
            {dayOf(s.endLocal) !== dayOf(s.startLocal) && <sup>+{daysFrom(dayOf(s.startLocal), dayOf(s.endLocal))}</sup>}
          </span>
        </div>
        <div className="seg-meta">
          {weekday(dayOf(s.startLocal))} · {s.carrier} {s.number}
          {s.cabin && ` · ${s.cabin}`}
          {s.seat && ` · seat ${s.seat}`}
          {s.confirmation && <span className="faint num"> · {s.confirmation}</span>}
        </div>
        {s.lounges[0] && (
          <div className="seg-perk">
            <Sofa size={12} /> {s.lounges[0].access}
          </div>
        )}
      </div>
    </button>
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

function TripCard({ trip, state, open, onToggle }: { trip: Trip; state: TravelState; open: boolean; onToggle: () => void }) {
  const { agentName, ask } = useApp();
  const today = todayStr();
  const [editing, setEditing] = useState(false);
  const [booking, setBooking] = useState<Segment | 'new' | null>(null);
  const [item, setItem] = useState<{ item: ItineraryItem | null; date: string } | null>(null);
  const draft = useWrite(() => travelWrite.post(`/trips/${trip.id}/draft`));
  const toggle = useWrite((i: ItineraryItem) => travelWrite.patch(`/itinerary/${i.id}`, { done: !i.done }));
  const days = Array.from({ length: daysFrom(trip.startDate, trip.endDate) + 1 }, (_, i) => {
    const d = parseDay(trip.startDate);
    d.setDate(d.getDate() + i);
    return todayStr(d);
  });
  const layovers = state.context.trip?.id === trip.id ? state.context.layovers : [];
  const past = trip.endDate < today;
  const flights = trip.segments.filter((s) => s.kind === 'flight');

  return (
    <article className={cx('trip-card', open && 'is-open', past && 'is-past')}>
      <button type="button" className="trip-head" onClick={onToggle} aria-expanded={open}>
        <div className="grow">
          <div className="trip-title">{trip.title}</div>
          <div className="trip-sub">
            <PurposeChip purpose={trip.purpose} />
            <span>{dates(trip.startDate, trip.endDate)}</span>
            <span className="faint">· {whenLabel(trip, today)}</span>
            {!open && flights.length > 0 && <span className="faint">· {plural(flights.length, 'flight')}</span>}
          </div>
        </div>
        <ChevronDown size={16} className="trip-chev" />
      </button>

      {open && (
        <div className="trip-body">
          <div className="trip-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBooking('new')}>
              <Plus size={13} /> Flight or hotel
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
              <Pencil size={12} /> Edit
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => ask(`Help me with my ${trip.purpose} trip "${trip.title}" (${trip.startDate} to ${trip.endDate}). Look at the bookings and the plan, then tell me what is missing or could be better.`)}>
              <Sparkles size={13} /> Ask {agentName}
            </button>
          </div>

          {trip.segments.length === 0 ? (
            <p className="empty">No bookings yet. Add them, paste a confirmation, or let Gmail bring them in.</p>
          ) : (
            <div className="seg-list">
              {trip.segments.map((s) => {
                const lay = layovers.find((l) => l.afterSegmentId === s.id);
                return (
                  <div key={s.id}>
                    {s.kind === 'flight' ? <FlightRow s={s} onEdit={() => setBooking(s)} /> : <StayRow s={s} onEdit={() => setBooking(s)} />}
                    {lay && (
                      <div className="layover">
                        <Clock size={12} /> {lay.hours} h connection in {lay.city}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="plan-head">
            <h3>
              <ListChecks size={14} /> To-dos
            </h3>
          </div>
          <TripTodos trip={trip} past={past} />

          <div className="plan-head">
            <h3>
              <CalendarDays size={14} /> Plan
            </h3>
            {!past && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={draft.isPending} onClick={() => draft.mutate()}>
                {draft.isPending ? <Spinner /> : <Wand2 size={13} />} {trip.itinerary.length ? 'Fill empty days' : `Draft with ${agentName}`}
              </button>
            )}
          </div>
          {draft.error && <p className="error-text">{draft.error.message}</p>}
          <div className="plan-days">
            {days.map((d) => {
              const items = trip.itinerary.filter((i) => i.date === d);
              return (
                <div key={d} className={cx('plan-day', d === today && 'is-today')}>
                  <div className="plan-date">
                    <b>{weekday(d)}</b>
                    <button type="button" className="icon-btn icon-btn-sm" aria-label={`Add to ${weekday(d)}`} onClick={() => setItem({ item: null, date: d })}>
                      <Plus size={14} />
                    </button>
                  </div>
                  {items.length === 0 && <p className="plan-empty">Free</p>}
                  <ul>
                    {items.map((i) => (
                      <li key={i.id} className={cx('plan-item', `pk-${i.kind}`, i.done && 'is-done')}>
                        <Check checked={i.done} onChange={() => toggle.mutate(i)} label={`Done: ${i.title}`} />
                        <button type="button" className="plan-item-body" onClick={() => setItem({ item: i, date: d })}>
                          <span className="plan-time num">{i.time ?? '·'}</span>
                          <span className="grow">
                            <span className="plan-title">{i.title}</span>
                            {(i.place || i.notes) && <span className="plan-place">{[i.place, i.notes].filter(Boolean).join(' — ')}</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {editing && <TripSheet trip={trip} onClose={() => setEditing(false)} />}
      {booking && <BookingSheet trip={trip} segment={booking === 'new' ? null : booking} onClose={() => setBooking(null)} />}
      {item && <ItemSheet trip={trip} item={item.item} date={item.date} onClose={() => setItem(null)} />}
    </article>
  );
}

// ── The Travels sphere ──────────────────────────────────────────────────────

/** Trips, with their bookings and plans: what you work with in the Travels sphere. */
export function TravelTrips() {
  const { data: t } = useTravel();
  const [newTrip, setNewTrip] = useState(false);
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState<string | null | undefined>(undefined);
  const [showPast, setShowPast] = useState(false);
  if (!t) return null;
  const today = todayStr();
  const upcoming = t.trips.filter((x) => x.endDate >= today);
  const past = t.trips.filter((x) => x.endDate < today);
  const openId = open === undefined ? (upcoming[0]?.id ?? null) : open;

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
      <div className="trip-list">
        {upcoming.map((trip) => (
          <TripCard key={trip.id} trip={trip} state={t} open={openId === trip.id} onToggle={() => setOpen(openId === trip.id ? null : trip.id)} />
        ))}
        {past.length > 0 && (
          <button type="button" className="link trip-past-toggle" onClick={() => setShowPast((v) => !v)}>
            {showPast ? 'Hide past trips' : `Past trips (${past.length})`}
          </button>
        )}
        {showPast && past.map((trip) => <TripCard key={trip.id} trip={trip} state={t} open={openId === trip.id} onToggle={() => setOpen(openId === trip.id ? null : trip.id)} />)}
      </div>
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
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Work travel</h2>
      </div>
      {trips.map((trip) => {
        const f = trip.segments.find((s) => s.kind === 'flight' && s.endUtc > new Date().toISOString());
        return (
          <div key={trip.id} className="horizon-item">
            <Briefcase size={14} className="faint" />
            <span className="grow clamp-1">
              {trip.title} <span className="faint">· {dates(trip.startDate, trip.endDate)}</span>
            </span>
            <span className="faint" style={{ fontSize: 12.5 }}>
              {f ? `${f.carrier} ${f.number} ${weekday(dayOf(f.startLocal))}` : whenLabel(trip, today)}
            </span>
          </div>
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

/** Every trip still ahead, each as its own countdown card with its flights and to-dos. */
function TripsAhead({ trips }: { trips: Trip[] }) {
  return (
    <>
      {trips.map((trip) => (
        <TripCountdown key={trip.id} trip={trip} />
      ))}
    </>
  );
}

const weekdayShort = (d: string) => parseDay(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/** One trip ahead, in the manner of the Ramadan countdown: days to go, the way out and back, then what is left to do. */
function TripCountdown({ trip }: { trip: Trip }) {
  const { agentName } = useApp();
  const draft = useWrite(() => travelWrite.post(`/trips/${trip.id}/draft`));
  const today = todayStr();
  const days = daysFrom(today, trip.startDate);
  const flights = trip.segments.filter((s) => s.kind === 'flight');
  const stays = trip.segments.filter((s) => s.kind === 'stay');
  const out = flights[0];
  const back = flights.length > 1 ? flights[flights.length - 1] : undefined;
  const leg = (s: Segment) => `${`${s.carrier} ${s.number}`.trim()} · ${s.startLocal.slice(11, 16)} from ${s.fromCode || s.fromName}`;
  const summary = [
    trip.purpose === 'work' ? 'Work trip' : 'Leisure',
    flights.length || stays.length ? `${plural(flights.length, 'flight')}, ${plural(stays.length, 'stay')}` : 'nothing booked yet',
    trip.itinerary.length ? `${plural(trip.itinerary.length, 'thing')} planned` : 'no plan yet',
  ].join(' · ');

  return (
    <section className={cx('trip-hero', trip.purpose === 'work' ? 'is-work' : 'is-leisure')}>
      <div className="trip-hero-top">
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
          <PlaneTakeoff size={22} className="trip-hero-icon" />
        </div>
        <p className="trip-hero-note">{summary}</p>
      </div>
      <dl className="trip-hero-legs">
        <div>
          <dt>{out ? 'Flies out' : 'Starts'}</dt>
          <dd>{weekdayShort(out ? out.startLocal.slice(0, 10) : trip.startDate)}</dd>
          <dd className="trip-hero-sub">{out ? leg(out) : 'No flight booked yet'}</dd>
        </div>
        <div>
          <dt>{back ? 'Flies home' : 'Ends'}</dt>
          <dd>{weekdayShort(back ? back.startLocal.slice(0, 10) : trip.endDate)}</dd>
          <dd className="trip-hero-sub">{back ? leg(back) : stays[0]?.title || plural(daysFrom(trip.startDate, trip.endDate) + 1, 'day')}</dd>
        </div>
      </dl>
      {!trip.itinerary.length && trip.segments.length > 0 && (
        <button type="button" className="btn btn-sm trip-hero-btn" disabled={draft.isPending} onClick={() => draft.mutate()}>
          {draft.isPending ? <Spinner /> : <Wand2 size={13} />} Draft a plan with {agentName}
        </button>
      )}
      {draft.error && <p className="trip-hero-note">{draft.error.message}</p>}
      <div className="trip-hero-todos">
        <div className="trip-hero-label">To do</div>
        <TripTodos trip={trip} />
      </div>
    </section>
  );
}

/**
 * Travel on Today: the moment you are in (a flight today, a trip under way) as its own card,
 * then every trip still ahead with its to-dos.
 */
export function TravelModeCard() {
  const { data: t } = useTravel();
  if (!t) return null;
  const today = todayStr();
  const c = t.context;
  const current = (c.mode === 'departing' || c.mode === 'away') && c.trip ? c.trip : null;
  const ahead = t.trips.filter((x) => x.endDate >= today && x.id !== current?.id).sort((a, b) => a.startDate.localeCompare(b.startDate));
  return (
    <>
      {current && <TravelNowCard />}
      {ahead.length > 0 && <TripsAhead trips={ahead} />}
    </>
  );
}

function TravelNowCard() {
  const { data: t } = useTravel();
  const { agentName, ask } = useApp();
  const now = useNow();
  const prepare = useWrite((id: string) => travelWrite.post(`/segments/${id}/companion`));
  const toggle = useWrite((i: ItineraryItem) => travelWrite.patch(`/itinerary/${i.id}`, { done: !i.done }));
  if (!t || t.context.mode === 'none' || !t.context.trip) return null;
  const { context: c } = t;
  const trip = c.trip!;
  const today = todayStr();

  if (c.mode === 'departing' && c.flight) {
    const f = c.flight;
    const notes = trip.companion[f.id];
    const leaves = untilLabel(f.startUtc, now);
    const lay = c.layovers.find((l) => l.nextSegmentId === f.id) ?? c.layovers.find((l) => l.afterSegmentId === f.id);
    return (
      <section className="card travel-mode tm-departing">
        <div className="tm-head">
          <span className="tm-kicker">
            <Plane size={13} /> Travel mode · {trip.title}
          </span>
          <PurposeChip purpose={trip.purpose} />
        </div>
        <div className="tm-route">
          <div>
            <b className="num">{f.fromCode}</b>
            <span>{city(f.fromName, f.fromCode)}</span>
          </div>
          <div className="tm-plane">
            <span className="num">{time(f.startLocal)}</span>
            <i />
            <Plane size={16} />
            <i />
            <span className="num">{time(f.endLocal)}</span>
          </div>
          <div className="right">
            <b className="num">{f.toCode}</b>
            <span>{city(f.toName, f.toCode)}</span>
          </div>
        </div>
        <p className="tm-line">
          <b>
            {f.carrier} {f.number}
          </b>{' '}
          leaves in <b>{leaves}</b>
          {f.cabin && ` · ${f.cabin}`}
          {f.seat && ` · seat ${f.seat}`}
          {f.confirmation && <span className="faint num"> · {f.confirmation}</span>}
        </p>
        <div className="tm-grid">
          <Block icon={<Sofa size={13} />} title="Your lounge">
            <LoungeList seg={f} notes={notes?.lounges} />
          </Block>
          {lay && (
            <Block icon={<Clock size={13} />} title={`${lay.hours} h in ${lay.city}`}>
              <p className="tm-small">
                {lay.hours >= 5.5 && lay.airport === 'SIN' ? 'Long enough to leave the airport — Jewel, or a free Singapore tour if you have 5½ hours or more.' : lay.hours >= 6 ? 'Long enough to step out, if your visa allows.' : 'Time for the lounge, a proper meal and a prayer.'}
              </p>
            </Block>
          )}
        </div>
        {notes?.plan?.length ? (
          <Block icon={<Sparkles size={13} />} title={`${agentName}'s suggestions`}>
            <ul className="tm-plan">
              {notes.plan.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Block>
        ) : (
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-sm" disabled={prepare.isPending} onClick={() => prepare.mutate(f.id)}>
              {prepare.isPending ? <Spinner /> : <Sparkles size={13} />} Prepare this airport with {agentName}
            </button>
          </div>
        )}
        {prepare.error && <p className="error-text">{prepare.error.message}</p>}
        {trip.todos.some((x) => !x.done) && (
          <Block icon={<ListChecks size={13} />} title="Still to do">
            <TripTodos trip={trip} past />
          </Block>
        )}
        <div className="tm-foot">
          <button type="button" className="link" onClick={() => ask(`I'm flying ${f.carrier} ${f.number} from ${f.fromCode} to ${f.toCode} soon. What should I do before boarding, and what should I know on arrival?`)}>
            Ask {agentName} about this flight
          </button>
        </div>
      </section>
    );
  }

  // Away.
  const items = trip.itinerary.filter((i) => i.date === today);
  const hhmmNow = new Date(now).toTimeString().slice(0, 5);
  const nextItem = items.find((i) => !i.done && (i.time ?? '99:99') >= hhmmNow);
  return (
    <section className="card travel-mode tm-away">
      <div className="tm-head">
        <span className="tm-kicker">
          <Palmtree size={13} /> {trip.title} · day {c.dayOfTrip} of {c.tripDays}
        </span>
        <PurposeChip purpose={trip.purpose} />
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
      <Block icon={<ListChecks size={13} />} title="Trip to-dos">
        <TripTodos trip={trip} />
      </Block>
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
