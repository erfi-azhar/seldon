// Travel: trips for work or leisure, their flights and stays, a day-by-day plan you can
// edit, and your Singapore Airlines (KrisFlyer) and Marriott Bonvoy standing.
//
// Neither airline nor hotel offers an API for members, so bookings and balances come
// from what already reaches you: confirmation and statement emails (through the Gmail
// hook), screenshots of the apps, and anything you or Seldon add by hand.
//
// When a trip is close, Seldon gets ahead of it: it drafts a plan for the destination,
// and before each flight works out the lounge you are eligible for, the layover you
// have, and what is worth doing with it — a small app for that moment, on Today.

import { z } from 'zod';
import { NoBrain, think, wrapUntrusted } from '../agent/think.ts';
import { registerSnapshotSection } from '../agent/snapshot-hooks.ts';
import { tool } from '../agent/tools.ts';
import { read, today as todayOf } from '../http.ts';
import { addDays, daysBetween, Invalid, localDate, newId, NotFound, nowIso, registerUndo, type Store } from '../store.ts';
import type { EliteNights, FlightOption, ItineraryItem, LoyaltyAccount, OptionLeg, Segment, StayOption, TravelContext, TravelSettings, TravelState, Trip, TripPurpose } from '../../../shared/types.ts';
import { airport, validZone, zonedToUtc } from './airports.ts';
import { getIntegration, updateIntegration } from './integrations.ts';
import { BONVOY_TIERS, isMarriott, loungeAccess, stayPerks } from './lounges.ts';
import type { MailMessage } from './mail-types.ts';
import { registerFeature } from './registry.ts';
import { addSignal } from './signals.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const ID = 'travel';
const HOUR = 3_600_000;

const sphereId = (store: Store, key: string) => store.listSpheres().find((s) => s.key === key)?.id ?? null;
const travelSphere = (store: Store) => sphereId(store, 'travels');

// ── Settings ────────────────────────────────────────────────────────────────

export function travelSettings(store: Store): TravelSettings {
  const s = getIntegration(store, ID).settings;
  return { homeAirport: typeof s.homeAirport === 'string' ? s.homeAirport : 'SIN' };
}

/** Travel's background work (plans, airport notes) runs once there is something to plan. */
function enableTravel(store: Store): void {
  if (!getIntegration(store, ID).enabled) updateIntegration(store, ID, (r) => void (r.enabled = true));
}

// ── Rows ────────────────────────────────────────────────────────────────────

function loyaltyFromRow(r: Row): LoyaltyAccount {
  return {
    id: r.id,
    program: r.program,
    kind: r.kind,
    tier: r.tier,
    points: r.points,
    progress: r.progress,
    progressTarget: r.progress_target,
    progressLabel: r.progress_label,
    expires: r.expires,
    memberSuffix: r.member_suffix,
    updatedAt: r.updated_at,
    source: r.source,
  };
}

export const listLoyalty = (store: Store): LoyaltyAccount[] => (store.db.prepare('SELECT * FROM loyalty_accounts ORDER BY kind, program').all() as Row[]).map(loyaltyFromRow);

const geo = (code: string): [number, number] | null => {
  const a = airport(code ?? '');
  return a ? [a.lat, a.lon] : null;
};

function segmentFromRow(r: Row, accounts: LoyaltyAccount[], stays?: MarriottStay[]): Segment {
  const s: Segment = {
    id: r.id,
    tripId: r.trip_id,
    kind: r.kind,
    title: r.title,
    carrier: r.carrier,
    number: r.number,
    fromCode: r.from_code,
    fromName: r.from_name,
    toCode: r.to_code,
    toName: r.to_name,
    startLocal: r.start_local,
    startTz: r.start_tz,
    endLocal: r.end_local,
    endTz: r.end_tz,
    startUtc: r.start_utc,
    endUtc: r.end_utc,
    cabin: r.cabin,
    seat: r.seat,
    confirmation: r.confirmation,
    address: r.address,
    notes: r.notes,
    source: r.source,
    fromCity: airport(r.from_code)?.city ?? '',
    toCity: airport(r.to_code)?.city ?? '',
    fromGeo: geo(r.from_code),
    toGeo: geo(r.to_code),
    lounges: [],
    perks: [],
  };
  s.lounges = loungeAccess(s, accounts);
  s.perks = stayPerks(s, accounts);
  if (stays && s.kind === 'stay' && isMarriott(s.title, s.carrier) && s.endLocal) s.eliteNights = eliteNights({ id: s.id, title: s.title, start: s.startLocal, end: s.endLocal }, stays, accounts);
  return s;
}

// ── Bonvoy elite nights ─────────────────────────────────────────────────────

interface MarriottStay {
  id: string;
  title: string;
  start: string;
  end: string;
}

/** Every stay at a Marriott-family hotel on any trip, in order: what elite nights are counted on from. */
function marriottStays(store: Store): MarriottStay[] {
  return (store.db.prepare("SELECT id, title, carrier, start_local, end_local FROM trip_segments WHERE kind = 'stay' AND end_local IS NOT NULL ORDER BY start_utc, id").all() as Row[])
    .filter((r) => isMarriott(r.title, r.carrier))
    .map((r) => ({ id: r.id, title: r.title, start: r.start_local, end: r.end_local }));
}

const nightsIn = (s: { start: string; end: string }) => Math.max(0, daysBetween(s.start.slice(0, 10), s.end.slice(0, 10)));

/**
 * The elite nights a stay earns and where they leave you: on from the nights last recorded on the Bonvoy card,
 * plus the Marriott stays since then that check out earlier in the same year. A stay that checked out before the
 * count was recorded is already in it. Nights count towards the year of check-out.
 */
export function eliteNights(stay: MarriottStay, all: MarriottStay[], accounts: LoyaltyAccount[]): EliteNights {
  const nights = nightsIn(stay);
  const year = Number(stay.end.slice(0, 4));
  const card = accounts.find((a) => /bonvoy|marriott/i.test(a.program));
  // Only a count of nights is something to count on from (not points, not a spend).
  const rec = card && card.progress !== null && /night/i.test(card.progressLabel) ? { nights: card.progress, asOf: card.updatedAt.slice(0, 10) } : null;
  const since = (s: MarriottStay) => !rec || s.end.slice(0, 10) >= rec.asOf;
  const none = { before: null, after: null, recorded: null, earlier: [], reaches: null, next: null };
  if (!rec) return { nights, year, counted: false, ...none };
  if (!since(stay)) return { nights, year, counted: true, ...none };
  const recorded = Number(rec.asOf.slice(0, 4)) === year ? rec : null;
  const earlier = all
    .filter((s) => s.id !== stay.id && since(s) && Number(s.end.slice(0, 4)) === year && (s.start < stay.start || (s.start === stay.start && s.id < stay.id)))
    .map((s) => ({ title: s.title, nights: nightsIn(s) }))
    .filter((s) => s.nights > 0);
  const before = (recorded?.nights ?? 0) + earlier.reduce((n, s) => n + s.nights, 0);
  const after = before + nights;
  return {
    nights,
    year,
    counted: false,
    before,
    after,
    recorded,
    earlier,
    reaches: BONVOY_TIERS.filter((t) => t.at > before && t.at <= after).at(-1)?.tier ?? null,
    next: BONVOY_TIERS.find((t) => t.at > after) ?? null,
  };
}

const itemFromRow = (r: Row): ItineraryItem => ({ id: r.id, tripId: r.trip_id, date: r.date, time: r.time, title: r.title, place: r.place, notes: r.notes, kind: r.kind, done: !!r.done });

function tripFromRow(store: Store, r: Row, accounts = listLoyalty(store), stays = marriottStays(store)): Trip {
  return {
    id: r.id,
    title: r.title,
    purpose: r.purpose,
    destination: r.destination,
    startDate: r.start_date,
    endDate: r.end_date,
    notes: r.notes,
    companion: JSON.parse(r.companion),
    segments: (store.db.prepare('SELECT * FROM trip_segments WHERE trip_id = ? ORDER BY start_utc').all(r.id) as Row[]).map((x) => segmentFromRow(x, accounts, stays)),
    itinerary: (store.db.prepare("SELECT * FROM itinerary_items WHERE trip_id = ? ORDER BY date, COALESCE(time, '99:99'), created_at").all(r.id) as Row[]).map(itemFromRow),
    todos: store.listTasks({ tripId: r.id, status: 'all', limit: 100 }),
    options: (store.db.prepare('SELECT * FROM trip_options WHERE trip_id = ? ORDER BY recommended DESC, position, created_at').all(r.id) as Row[]).map(optionFromRow),
    // Nearest first; ones without a distance after, in the order they were added.
    stayOptions: (store.db.prepare('SELECT * FROM trip_stay_options WHERE trip_id = ? ORDER BY distance_km IS NULL, distance_km, position, created_at').all(r.id) as Row[]).map(stayOptionFromRow),
  };
}

export function getTrip(store: Store, id: string): Trip {
  const r = store.db.prepare('SELECT * FROM trips WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Trip');
  return tripFromRow(store, r);
}

/** Trips still to come or under way, then the most recent past ones. */
export function listTrips(store: Store, today: string): Trip[] {
  const accounts = listLoyalty(store);
  const current = store.db.prepare('SELECT * FROM trips WHERE end_date >= ? ORDER BY start_date').all(today) as Row[];
  const past = store.db.prepare('SELECT * FROM trips WHERE end_date < ? ORDER BY end_date DESC LIMIT 5').all(today) as Row[];
  const stays = marriottStays(store);
  return [...current, ...past].map((r) => tripFromRow(store, r, accounts, stays));
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface TripInput {
  title?: string;
  purpose?: TripPurpose;
  destination?: string;
  startDate: string;
  endDate: string;
  notes?: string;
}

export function createTrip(store: Store, t: TripInput, quiet = false): Trip {
  if (t.endDate < t.startDate) throw new Invalid('A trip cannot end before it starts');
  const id = newId();
  const destination = (t.destination ?? '').trim().slice(0, 120);
  const title = (t.title?.trim() || (destination ? `${destination}` : 'Trip')).slice(0, 120);
  store.db
    .prepare('INSERT INTO trips (id, title, purpose, destination, start_date, end_date, notes, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, title, t.purpose ?? 'leisure', destination, t.startDate, t.endDate, (t.notes ?? '').slice(0, 2000), nowIso());
  enableTravel(store);
  if (!quiet) store.record('created', 'trip', id, sphereFor(store, t.purpose ?? 'leisure'), `New ${t.purpose === 'work' ? 'work ' : ''}trip: ${title}`);
  return getTrip(store, id);
}

const sphereFor = (store: Store, purpose: TripPurpose) => (purpose === 'work' ? (sphereId(store, 'work') ?? travelSphere(store)) : travelSphere(store));

export function updateTrip(store: Store, id: string, p: Partial<TripInput>): Trip {
  const cur = getTrip(store, id);
  const destination = (p.destination ?? cur.destination).trim();
  // A cleared name falls back to the destination, as it does when the trip is made.
  const title = p.title === undefined ? cur.title : p.title.trim() || destination || cur.title;
  const next = { title, purpose: p.purpose ?? cur.purpose, destination, startDate: p.startDate ?? cur.startDate, endDate: p.endDate ?? cur.endDate, notes: p.notes ?? cur.notes };
  if (next.endDate < next.startDate) throw new Invalid('A trip cannot end before it starts');
  store.db.prepare('UPDATE trips SET title = ?, purpose = ?, destination = ?, start_date = ?, end_date = ?, notes = ? WHERE id = ?').run(next.title.slice(0, 120), next.purpose, next.destination.slice(0, 120), next.startDate, next.endDate, next.notes.slice(0, 2000), id);
  return getTrip(store, id);
}

export interface SegmentInput {
  kind: Segment['kind'];
  title?: string;
  carrier?: string;
  number?: string;
  fromCode?: string;
  fromName?: string;
  toCode?: string;
  toName?: string;
  startLocal: string;
  startTz?: string | null;
  endLocal?: string | null;
  endTz?: string | null;
  cabin?: string;
  seat?: string;
  confirmation?: string;
  address?: string;
  notes?: string;
}

const clean = (s: string | undefined | null, n = 120) => (s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);
const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Resolve codes, names and zones, and work out the instants for ordering. */
function normalise(s: SegmentInput, settings: TravelSettings) {
  const fromCode = clean(s.fromCode, 4).toUpperCase();
  const toCode = clean(s.toCode, 4).toUpperCase();
  const from = airport(fromCode);
  const to = airport(toCode);
  const home = airport(settings.homeAirport);
  const zone = (given: string | null | undefined, known: string | undefined) => known ?? (given && validZone(given) ? given : (home?.tz ?? 'UTC'));
  const startLocal = s.startLocal.slice(0, 16);
  if (!stamp.test(startLocal)) throw new Invalid('Times look like 2026-12-01T09:40');
  const endLocal = (s.endLocal ?? '').slice(0, 16) || startLocal;
  if (!stamp.test(endLocal)) throw new Invalid('Times look like 2026-12-01T09:40');
  const startTz = s.kind === 'flight' ? zone(s.startTz, from?.tz) : zone(s.startTz, to?.tz ?? from?.tz);
  const endTz = s.kind === 'flight' ? zone(s.endTz ?? s.startTz, to?.tz) : zone(s.endTz ?? s.startTz, to?.tz ?? from?.tz);
  const startUtc = zonedToUtc(startLocal, startTz);
  let endUtc = zonedToUtc(endLocal, endTz);
  if (endUtc < startUtc) endUtc = startUtc;
  let carrier = clean(s.carrier, 60);
  let number = clean(s.number, 12).toUpperCase().replace(/\s+/g, '');
  // "SQ638" and "SQ" + "638" are the same flight. Airline codes always hold a letter, so "638" stays whole.
  const coded = s.kind === 'flight' ? /^([A-Z]{2}|[A-Z]\d|\d[A-Z])(\d{1,4}[A-Z]?)$/.exec(number) : null;
  if (coded && (!carrier || carrier.toUpperCase() === coded[1])) {
    carrier ||= coded[1]!;
    number = coded[2]!;
  }
  return {
    kind: s.kind,
    title: clean(s.title) || (s.kind === 'flight' ? `${carrier} ${number}`.trim() : ''),
    carrier,
    number,
    fromCode,
    fromName: clean(s.fromName) || (from ? `${from.city} ${from.name}` : ''),
    toCode,
    toName: clean(s.toName) || (to ? `${to.city} ${to.name}` : ''),
    startLocal,
    startTz,
    endLocal,
    endTz,
    startUtc: startUtc.toISOString(),
    endUtc: endUtc.toISOString(),
    cabin: clean(s.cabin, 40),
    seat: clean(s.seat, 8),
    confirmation: clean(s.confirmation, 20),
    address: clean(s.address, 300),
    notes: clean(s.notes, 1000),
  };
}

/** The same flight or stay already on file for this trip (a booking, then its check-in reminder). */
function findSame(store: Store, tripId: string | null, n: ReturnType<typeof normalise>): Row | undefined {
  const day = n.startLocal.slice(0, 10);
  if (n.kind === 'flight' && n.number) {
    // Flight numbers repeat across airlines, so the carrier and departure airport must agree where both are known.
    return store.db
      .prepare(
        `SELECT * FROM trip_segments WHERE kind = 'flight' AND number IN (?, ?) AND substr(start_local, 1, 10) = ?
          AND (carrier = '' OR ? = '' OR upper(carrier) = upper(?)) AND (from_code = '' OR ? = '' OR from_code = ?) AND (? IS NULL OR trip_id = ?)`,
      )
      .get(n.number, `${n.carrier}${n.number}`.toUpperCase(), day, n.carrier, n.carrier, n.fromCode, n.fromCode, tripId, tripId) as Row | undefined;
  }
  if (n.kind === 'stay' && n.title) {
    return store.db.prepare("SELECT * FROM trip_segments WHERE kind = 'stay' AND lower(title) = lower(?) AND substr(start_local, 1, 10) = ? AND (? IS NULL OR trip_id = ?)").get(n.title, day, tripId, tripId) as Row | undefined;
  }
  return undefined;
}

/** The trip a segment belongs to: one whose dates hold it, else the nearest within a day of it. */
function tripFor(store: Store, date: string, endDate: string): Row | undefined {
  return store.db
    .prepare(
      `SELECT * FROM trips WHERE start_date <= ? AND end_date >= ?
        ORDER BY (start_date <= ? AND end_date >= ?) DESC, max(julianday(start_date) - julianday(?), julianday(?) - julianday(end_date), 0), (start_date <= ? AND end_date >= ?) DESC, start_date
        LIMIT 1`,
    )
    .get(addDays(endDate, 1), addDays(date, -1), date, endDate, endDate, date, date, date) as Row | undefined;
}

/** Stretch a trip's dates to cover a segment. */
function cover(store: Store, tripId: string, from: string, to: string): void {
  store.db.prepare('UPDATE trips SET start_date = min(start_date, ?), end_date = max(end_date, ?) WHERE id = ?').run(from, to, tripId);
}

export function addSegment(store: Store, tripId: string | null, input: SegmentInput, source = 'manual', externalId: string | null = null, quiet = false): { segment: Segment; created: boolean } {
  const n = normalise(input, travelSettings(store));
  const accounts = listLoyalty(store);
  const same = findSame(store, tripId, n);
  if (same) {
    // Fill gaps (a seat assigned at check-in, a terminal) without overwriting what is there.
    const fill = (k: string, v: string) => (v && !same[k] ? v : same[k]);
    store.db
      .prepare('UPDATE trip_segments SET cabin = ?, seat = ?, confirmation = ?, address = ?, from_name = ?, to_name = ? WHERE id = ?')
      .run(fill('cabin', n.cabin), fill('seat', n.seat), fill('confirmation', n.confirmation), fill('address', n.address), fill('from_name', n.fromName), fill('to_name', n.toName), same.id);
    return { segment: segmentFromRow(store.db.prepare('SELECT * FROM trip_segments WHERE id = ?').get(same.id) as Row, accounts), created: false };
  }
  if (tripId && !store.db.prepare('SELECT 1 AS x FROM trips WHERE id = ?').get(tripId)) throw new NotFound('Trip');
  const id = newId();
  store.db
    .prepare(
      `INSERT INTO trip_segments (id, trip_id, kind, title, carrier, number, from_code, from_name, to_code, to_name, start_local, start_tz, end_local, end_tz,
        start_utc, end_utc, cabin, seat, confirmation, address, notes, source, external_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, tripId, n.kind, n.title, n.carrier, n.number, n.fromCode, n.fromName, n.toCode, n.toName, n.startLocal, n.startTz, n.endLocal, n.endTz, n.startUtc, n.endUtc, n.cabin, n.seat, n.confirmation, n.address, n.notes, source, externalId, nowIso());
  if (tripId) cover(store, tripId, n.startLocal.slice(0, 10), n.endLocal.slice(0, 10));
  const label = n.kind === 'flight' ? `${n.title}${n.fromCode && n.toCode ? `, ${n.fromCode} → ${n.toCode}` : ''}` : n.title || n.kind;
  const trip = tripId ? (store.db.prepare('SELECT purpose FROM trips WHERE id = ?').get(tripId) as Row) : null;
  if (!quiet) store.record('created', 'trip_segment', id, trip ? sphereFor(store, trip.purpose) : travelSphere(store), `Added ${label} on ${n.startLocal.slice(0, 10)}`);
  return { segment: segmentFromRow(store.db.prepare('SELECT * FROM trip_segments WHERE id = ?').get(id) as Row, accounts), created: true };
}

/**
 * File one booking from outside (a calendar, say) onto the trip whose dates hold it, making a
 * trip when none does. The same flight already on file is matched, not duplicated.
 */
export function fileSegment(store: Store, input: SegmentInput, source: string, externalId: string | null, origin: string): { segment: Segment; created: boolean; tripId: string; newTrip: boolean } {
  const first = input.startLocal.slice(0, 10);
  const last = (input.endLocal || input.startLocal).slice(0, 10);
  let trip = tripFor(store, first, last < first ? first : last);
  const from = (input.fromCode ?? '').toUpperCase();
  if (!trip && input.kind === 'flight' && from) {
    // Leaving from where a trip's latest flight landed, within six weeks: that trip's onward or return leg.
    trip = store.db
      .prepare(
        `SELECT t.* FROM trips t JOIN trip_segments s ON s.trip_id = t.id
          WHERE s.kind = 'flight' AND s.to_code = ? AND substr(s.end_local, 1, 10) <= ? AND substr(s.end_local, 1, 10) >= ?
            AND NOT EXISTS (SELECT 1 FROM trip_segments l WHERE l.trip_id = t.id AND l.kind = 'flight' AND l.start_utc > s.start_utc)
          ORDER BY s.start_utc DESC LIMIT 1`,
      )
      .get(from, first, addDays(first, -45)) as Row | undefined;
  }
  let newTrip = false;
  if (!trip) {
    const home = travelSettings(store).homeAirport;
    // A flight home with no trip around it still belongs to a trip: the place it leaves from.
    const away = (input.toCode ?? '').toUpperCase() !== home ? input.toCode : input.fromCode;
    const name = input.toCode && away === input.toCode ? input.toName : input.fromName;
    const destination = (away && airport(away)?.city) || clean(name) || clean(input.address) || 'Trip';
    const created = createTrip(store, { destination, title: destination, purpose: 'leisure', startDate: first, endDate: last < first ? first : last }, true);
    store.record('created', 'trip', created.id, sphereFor(store, created.purpose), `Found a trip in your ${origin}: ${created.title}`);
    trip = store.db.prepare('SELECT * FROM trips WHERE id = ?').get(created.id) as Row;
    newTrip = true;
  }
  const { segment, created } = addSegment(store, trip!.id, input, source, externalId);
  return { segment, created, tripId: trip!.id, newTrip };
}

export function updateSegment(store: Store, id: string, p: Partial<SegmentInput>): Segment {
  const r = store.db.prepare('SELECT * FROM trip_segments WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Booking');
  const { lounges: _l, perks: _p, startUtc: _s, endUtc: _e, ...cur } = segmentFromRow(r, []);
  // Names and a flight's own title follow its codes and number: drop the stale ones so normalise derives them again.
  const changed = (k: 'fromCode' | 'toCode' | 'carrier' | 'number') => p[k] !== undefined && clean(p[k]).toUpperCase() !== cur[k].toUpperCase();
  if (changed('fromCode') && p.fromName === undefined) cur.fromName = '';
  if (changed('toCode') && p.toName === undefined) cur.toName = '';
  if (cur.kind === 'flight' && (changed('carrier') || changed('number')) && p.title === undefined && cur.title === `${cur.carrier} ${cur.number}`.trim()) cur.title = '';
  const n = normalise({ ...cur, ...p }, travelSettings(store));
  store.db
    .prepare(
      `UPDATE trip_segments SET kind = ?, title = ?, carrier = ?, number = ?, from_code = ?, from_name = ?, to_code = ?, to_name = ?, start_local = ?, start_tz = ?,
        end_local = ?, end_tz = ?, start_utc = ?, end_utc = ?, cabin = ?, seat = ?, confirmation = ?, address = ?, notes = ? WHERE id = ?`,
    )
    .run(n.kind, n.title, n.carrier, n.number, n.fromCode, n.fromName, n.toCode, n.toName, n.startLocal, n.startTz, n.endLocal, n.endTz, n.startUtc, n.endUtc, n.cabin, n.seat, n.confirmation, n.address, n.notes, id);
  if (r.trip_id) cover(store, r.trip_id, n.startLocal.slice(0, 10), n.endLocal.slice(0, 10));
  return segmentFromRow(store.db.prepare('SELECT * FROM trip_segments WHERE id = ?').get(id) as Row, listLoyalty(store));
}

// ── Flight options ──────────────────────────────────────────────────────────

/** Great-circle statute miles between two airports, 0 when either is unknown. */
function milesBetween(from: string, to: string): number {
  const a = airport(from);
  const b = airport(to);
  if (!a || !b) return 0;
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return Math.round(2 * 3958.8 * Math.asin(Math.sqrt(h)));
}

const optionFromRow = (r: Row): FlightOption => ({
  id: r.id,
  tripId: r.trip_id,
  title: r.title,
  summary: r.summary,
  // Options saved before distances were kept get them worked out here.
  legs: (JSON.parse(r.legs) as OptionLeg[]).map((l) => ({ ...l, miles: l.miles ?? milesBetween(l.fromCode, l.toCode), cabin: l.cabin ?? 'economy' })),
  notes: JSON.parse(r.notes),
  recommended: !!r.recommended,
  chosenAt: r.chosen_at,
  createdAt: r.created_at,
});

export interface OptionLegInput {
  carrier: string;
  number: string;
  cabin?: OptionLeg['cabin'];
  fromCode: string;
  toCode: string;
  startLocal: string;
  endLocal: string;
  startTz?: string | null;
  endTz?: string | null;
}

export interface OptionInput {
  title: string;
  summary?: string;
  notes?: string[];
  recommended?: boolean;
  legs: OptionLegInput[];
}

/** A leg with codes, cities and zones resolved, and its instants worked out, the way bookings are. */
function optionLeg(l: OptionLegInput, settings: TravelSettings): OptionLeg {
  const n = normalise({ kind: 'flight', carrier: l.carrier, number: l.number, fromCode: l.fromCode, toCode: l.toCode, startLocal: l.startLocal, endLocal: l.endLocal, startTz: l.startTz, endTz: l.endTz }, settings);
  return {
    carrier: n.carrier,
    number: n.number,
    fromCode: n.fromCode,
    toCode: n.toCode,
    fromCity: airport(n.fromCode)?.city ?? n.fromName,
    toCity: airport(n.toCode)?.city ?? n.toName,
    startLocal: n.startLocal,
    endLocal: n.endLocal,
    startTz: n.startTz,
    endTz: n.endTz,
    startUtc: n.startUtc,
    endUtc: n.endUtc,
    miles: milesBetween(n.fromCode, n.toCode),
    cabin: l.cabin ?? 'economy',
  };
}

export function addOption(store: Store, tripId: string, input: OptionInput, quiet = false): FlightOption {
  const trip = getTrip(store, tripId);
  if (!input.legs.length) throw new Invalid('An option needs at least one flight');
  const settings = travelSettings(store);
  const legs = input.legs.map((l) => optionLeg(l, settings));
  const id = newId();
  const position = (store.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM trip_options WHERE trip_id = ?').get(tripId) as Row).p;
  store.db
    .prepare('INSERT INTO trip_options (id, trip_id, title, summary, legs, notes, recommended, position, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, tripId, clean(input.title, 80) || 'Option', clean(input.summary, 300), JSON.stringify(legs), JSON.stringify((input.notes ?? []).map((x) => clean(x, 300)).filter(Boolean).slice(0, 8)), Number(!!input.recommended), position, nowIso());
  if (!quiet) store.record('created', 'trip_option', id, sphereFor(store, trip.purpose), `Flight option for ${trip.title}: ${clean(input.title, 60)}`);
  return optionFromRow(store.db.prepare('SELECT * FROM trip_options WHERE id = ?').get(id) as Row);
}

export function updateOption(store: Store, id: string, p: Partial<OptionInput>): FlightOption {
  const r = store.db.prepare('SELECT * FROM trip_options WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Option');
  if (p.legs !== undefined && !p.legs.length) throw new Invalid('An option needs at least one flight');
  // New legs are resolved the same way as when the option was made; a changed routing is no longer the one chosen.
  const legs = p.legs ? JSON.stringify(p.legs.map((l) => optionLeg(l, travelSettings(store)))) : r.legs;
  store.db
    .prepare('UPDATE trip_options SET title = ?, summary = ?, notes = ?, recommended = ?, legs = ?, chosen_at = ? WHERE id = ?')
    .run(
      p.title !== undefined ? clean(p.title, 80) || r.title : r.title,
      p.summary !== undefined ? clean(p.summary, 300) : r.summary,
      p.notes !== undefined ? JSON.stringify(p.notes.map((x) => clean(x, 300)).filter(Boolean).slice(0, 8)) : r.notes,
      p.recommended !== undefined ? Number(p.recommended) : r.recommended,
      legs,
      p.legs ? null : r.chosen_at,
      id,
    );
  return optionFromRow(store.db.prepare('SELECT * FROM trip_options WHERE id = ?').get(id) as Row);
}

/** Put an option's flights on its trip as planned flights (not booked yet), and mark it chosen. */
export function chooseOption(store: Store, id: string): Trip {
  const r = store.db.prepare('SELECT * FROM trip_options WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Option');
  const o = optionFromRow(r);
  if (o.chosenAt) return getTrip(store, o.tripId);
  const settings = travelSettings(store);
  const before = getTrip(store, o.tripId);
  const segments: string[] = [];
  for (const l of o.legs) {
    const cabin = { economy: 'Economy', premium: 'Premium Economy', business: 'Business' }[l.cabin ?? 'economy'];
    const input: SegmentInput = { kind: 'flight', carrier: l.carrier, number: l.number, fromCode: l.fromCode, toCode: l.toCode, startLocal: l.startLocal, endLocal: l.endLocal, startTz: l.startTz, endTz: l.endTz, cabin, notes: `Planned from the option “${o.title}”, not booked yet.` };
    // A flight already booked on any trip (SQ857 home from Shenzhen, say) stays where it is.
    if (findSame(store, null, normalise(input, settings))) continue;
    segments.push(addSegment(store, o.tripId, input, 'option').segment.id);
  }
  // Remember what was added, and the trip's dates before, so it can all be taken back.
  store.db
    .prepare('UPDATE trip_options SET chosen_at = ?, added = ? WHERE id = ?')
    .run(nowIso(), JSON.stringify({ segments, startDate: before.startDate, endDate: before.endDate }), id);
  return getTrip(store, o.tripId);
}

/**
 * Take back what choosing an option added: its planned flights come off the trip (unless another chosen option
 * still flies them) and the trip's dates go back to what they were. Flights you booked or edited by hand stay.
 */
export function unchooseOption(store: Store, id: string): Trip {
  const r = store.db.prepare('SELECT * FROM trip_options WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Option');
  const o = optionFromRow(r);
  if (!o.chosenAt) return getTrip(store, o.tripId);
  const added = JSON.parse(r.added || '{}') as { segments?: string[]; startDate?: string; endDate?: string };
  const key = (carrier: string, number: string, startLocal: string) => `${carrier}${number}|${startLocal.slice(0, 16)}`;
  // Other chosen options on this trip, and the flights they rely on.
  const others = (store.db.prepare('SELECT * FROM trip_options WHERE trip_id = ? AND id != ? AND chosen_at IS NOT NULL').all(o.tripId, id) as Row[]).map((x) => ({
    row: x,
    keys: new Set(optionFromRow(x).legs.map((l) => key(l.carrier, l.number, l.startLocal))),
  }));
  const planned = store.db.prepare("SELECT * FROM trip_segments WHERE trip_id = ? AND source = 'option'").all(o.tripId) as Row[];
  // Chosen before additions were recorded: the option's own planned flights, matched by flight and time.
  const mine = new Set(o.legs.map((l) => key(l.carrier, l.number, l.startLocal)));
  const ids = added.segments ?? planned.filter((s) => mine.has(key(s.carrier, s.number, s.start_local)) && String(s.notes).includes(`“${o.title}”`)).map((s) => s.id as string);
  const drop = store.db.prepare("DELETE FROM trip_segments WHERE id = ? AND source = 'option'");
  for (const sid of ids) {
    const s = planned.find((p) => p.id === sid);
    const heir = s && others.find((x) => x.keys.has(key(s.carrier, s.number, s.start_local)));
    if (heir) {
      // Still flown by another chosen option: it stays, and that option now owns it.
      // Choosing only ever widens a trip, so the narrowest dates on record are the trip's own: they go along too.
      const theirs = JSON.parse(heir.row.added || '{}') as { segments?: string[]; startDate?: string; endDate?: string };
      theirs.segments = [...new Set([...(theirs.segments ?? []), sid])];
      if (added.startDate) theirs.startDate = theirs.startDate && theirs.startDate > added.startDate ? theirs.startDate : added.startDate;
      if (added.endDate) theirs.endDate = theirs.endDate && theirs.endDate < added.endDate ? theirs.endDate : added.endDate;
      heir.row.added = JSON.stringify(theirs);
      store.db.prepare('UPDATE trip_options SET added = ? WHERE id = ?').run(heir.row.added, heir.row.id);
      continue;
    }
    drop.run(sid);
  }
  if (added.startDate && added.endDate) {
    // Back to the dates before, stretched only as far as the flights that remain need.
    const left = getTrip(store, o.tripId).segments;
    const start = left.reduce((m, s) => (s.startLocal.slice(0, 10) < m ? s.startLocal.slice(0, 10) : m), added.startDate);
    const end = left.reduce((m, s) => ((s.endLocal || s.startLocal).slice(0, 10) > m ? (s.endLocal || s.startLocal).slice(0, 10) : m), added.endDate);
    store.db.prepare('UPDATE trips SET start_date = ?, end_date = ? WHERE id = ?').run(start, end, o.tripId);
  }
  store.db.prepare("UPDATE trip_options SET chosen_at = NULL, added = '{}' WHERE id = ?").run(id);
  return getTrip(store, o.tripId);
}

// ── Hotel options ───────────────────────────────────────────────────────────

const stayOptionFromRow = (r: Row): StayOption => ({
  id: r.id,
  tripId: r.trip_id,
  name: r.name,
  brand: r.brand,
  address: r.address,
  area: r.area,
  distanceKm: r.distance_km,
  distanceFrom: r.distance_from,
  gettingThere: r.getting_there,
  summary: r.summary,
  notes: JSON.parse(r.notes),
  recommended: !!r.recommended,
  chosenAt: r.chosen_at,
  createdAt: r.created_at,
});

export interface StayOptionInput {
  name: string;
  brand?: string;
  address?: string;
  area?: string;
  distanceKm?: number | null;
  distanceFrom?: string;
  gettingThere?: string;
  summary?: string;
  notes?: string[];
  recommended?: boolean;
}

const stayNotes = (notes: string[]) => JSON.stringify(notes.map((x) => clean(x, 300)).filter(Boolean).slice(0, 8));
const km = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

export function addStayOption(store: Store, tripId: string, input: StayOptionInput, quiet = false): StayOption {
  const trip = getTrip(store, tripId);
  const name = clean(input.name, 120);
  if (!name) throw new Invalid('A hotel option needs a name');
  // Only one recommended at a time: the newest pick wins.
  if (input.recommended) store.db.prepare('UPDATE trip_stay_options SET recommended = 0 WHERE trip_id = ?').run(tripId);
  const id = newId();
  const position = (store.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM trip_stay_options WHERE trip_id = ?').get(tripId) as Row).p;
  store.db
    .prepare('INSERT INTO trip_stay_options (id, trip_id, name, brand, address, area, distance_km, distance_from, getting_there, summary, notes, recommended, position, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, tripId, name, clean(input.brand, 60), clean(input.address, 300), clean(input.area, 80), km(input.distanceKm), clean(input.distanceFrom, 80), clean(input.gettingThere, 80), clean(input.summary, 300), stayNotes(input.notes ?? []), Number(!!input.recommended), position, nowIso());
  if (!quiet) store.record('created', 'trip_stay_option', id, sphereFor(store, trip.purpose), `Hotel option for ${trip.title}: ${clean(name, 60)}`);
  return stayOptionFromRow(store.db.prepare('SELECT * FROM trip_stay_options WHERE id = ?').get(id) as Row);
}

export function updateStayOption(store: Store, id: string, p: Partial<StayOptionInput>): StayOption {
  const r = store.db.prepare('SELECT * FROM trip_stay_options WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Hotel option');
  if (p.recommended) store.db.prepare('UPDATE trip_stay_options SET recommended = 0 WHERE trip_id = ? AND id != ?').run(r.trip_id, id);
  const str = (v: string | undefined, col: string, n: number) => (v !== undefined ? clean(v, n) : r[col]);
  store.db
    .prepare('UPDATE trip_stay_options SET name = ?, brand = ?, address = ?, area = ?, distance_km = ?, distance_from = ?, getting_there = ?, summary = ?, notes = ?, recommended = ? WHERE id = ?')
    .run(
      p.name !== undefined ? clean(p.name, 120) || r.name : r.name,
      str(p.brand, 'brand', 60),
      str(p.address, 'address', 300),
      str(p.area, 'area', 80),
      p.distanceKm !== undefined ? km(p.distanceKm) : r.distance_km,
      str(p.distanceFrom, 'distance_from', 80),
      str(p.gettingThere, 'getting_there', 80),
      str(p.summary, 'summary', 300),
      p.notes !== undefined ? stayNotes(p.notes) : r.notes,
      p.recommended !== undefined ? Number(p.recommended) : r.recommended,
      id,
    );
  return stayOptionFromRow(store.db.prepare('SELECT * FROM trip_stay_options WHERE id = ?').get(id) as Row);
}

/** Put a hotel on its trip as a planned stay for the whole trip (not booked yet), and mark it chosen. */
export function chooseStayOption(store: Store, id: string): Trip {
  const r = store.db.prepare('SELECT * FROM trip_stay_options WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Hotel option');
  const o = stayOptionFromRow(r);
  if (o.chosenAt) return getTrip(store, o.tripId);
  const trip = getTrip(store, o.tripId);
  // Check in the day the flight out lands and check out the day the flight home leaves: the last flight landing
  // in the first half of the trip, and the first leaving in the second half. Without them, the trip's own dates.
  const mid = (Date.parse(trip.startDate) + Date.parse(trip.endDate)) / 2 + 12 * 3_600_000;
  const flights = trip.segments.filter((s) => s.kind === 'flight');
  const inbound = flights.filter((s) => Date.parse(s.endUtc) < mid).at(-1);
  const outbound = flights.find((s) => Date.parse(s.startUtc) >= mid);
  const tz = inbound?.endTz ?? outbound?.startTz ?? null;
  const input: SegmentInput = {
    kind: 'stay',
    title: o.name,
    carrier: o.brand || undefined,
    address: o.address || undefined,
    startLocal: `${inbound ? inbound.endLocal.slice(0, 10) : trip.startDate}T15:00`,
    startTz: tz,
    endLocal: `${outbound ? outbound.startLocal.slice(0, 10) : trip.endDate}T12:00`,
    endTz: tz,
    notes: `Planned from the hotel options, not booked yet.${o.gettingThere ? ` ${o.gettingThere}${o.distanceFrom ? ` to ${o.distanceFrom}` : ''}.` : ''}`,
  };
  // A hotel already booked under that name for these dates is not added twice, and is not ours to take back.
  const added = findSame(store, o.tripId, normalise(input, travelSettings(store))) ? null : addSegment(store, o.tripId, input, 'option').segment.id;
  store.db.prepare('UPDATE trip_stay_options SET chosen_at = ?, added_segment = ? WHERE id = ?').run(nowIso(), added, id);
  return getTrip(store, o.tripId);
}

/** Take back the planned stay choosing a hotel added. A stay you booked or edited since stays. */
export function unchooseStayOption(store: Store, id: string): Trip {
  const r = store.db.prepare('SELECT * FROM trip_stay_options WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Hotel option');
  if (r.added_segment) store.db.prepare("DELETE FROM trip_segments WHERE id = ? AND source = 'option'").run(r.added_segment);
  store.db.prepare('UPDATE trip_stay_options SET chosen_at = NULL, added_segment = NULL WHERE id = ?').run(id);
  return getTrip(store, r.trip_id);
}

export interface ItemInput {
  date: string;
  time?: string | null;
  title: string;
  place?: string;
  notes?: string;
  kind?: ItineraryItem['kind'];
}

export function addItems(store: Store, tripId: string, items: ItemInput[], quiet = false): ItineraryItem[] {
  const trip = getTrip(store, tripId);
  const out: ItineraryItem[] = [];
  for (const it of items) {
    const id = newId();
    store.db
      .prepare('INSERT INTO itinerary_items (id, trip_id, date, time, title, place, notes, kind, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, tripId, it.date, it.time ?? null, clean(it.title, 160), clean(it.place, 160), clean(it.notes, 600), it.kind ?? 'activity', nowIso());
    if (!quiet) store.record('created', 'itinerary', id, sphereFor(store, trip.purpose), `Planned “${clean(it.title, 80)}” for ${it.date} in ${trip.title}`);
    out.push(itemFromRow(store.db.prepare('SELECT * FROM itinerary_items WHERE id = ?').get(id) as Row));
  }
  return out;
}

export function updateItem(store: Store, id: string, p: Partial<ItemInput> & { done?: boolean }): ItineraryItem {
  const r = store.db.prepare('SELECT * FROM itinerary_items WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Plan item');
  const cur = itemFromRow(r);
  const n = { ...cur, ...p };
  store.db
    .prepare('UPDATE itinerary_items SET date = ?, time = ?, title = ?, place = ?, notes = ?, kind = ?, done = ? WHERE id = ?')
    .run(n.date, n.time ?? null, clean(n.title, 160), clean(n.place, 160), clean(n.notes, 600), n.kind, Number(n.done), id);
  return itemFromRow(store.db.prepare('SELECT * FROM itinerary_items WHERE id = ?').get(id) as Row);
}

export interface LoyaltyInput {
  program: string;
  kind?: LoyaltyAccount['kind'];
  tier?: string;
  points?: number | null;
  progress?: number | null;
  progressTarget?: number | null;
  progressLabel?: string;
  expires?: string | null;
  memberSuffix?: string;
}

/** Programme names as people write them, folded to one account each. */
export function canonicalProgram(name: string): { program: string; kind: LoyaltyAccount['kind'] } | null {
  if (/kris ?flyer|pps club|singapore airlines/i.test(name)) return { program: 'KrisFlyer', kind: 'airline' };
  if (/bonvoy|marriott/i.test(name)) return { program: 'Marriott Bonvoy', kind: 'hotel' };
  if (/priority pass/i.test(name)) return { program: 'Priority Pass', kind: 'lounge' };
  if (/revolut/i.test(name)) return { program: 'Revolut Ultra', kind: 'lounge' };
  if (/lounge ?key/i.test(name)) return { program: 'LoungeKey', kind: 'lounge' };
  return null;
}

export function upsertLoyalty(store: Store, input: LoyaltyInput, source = 'manual', quiet = false): LoyaltyAccount {
  const known = canonicalProgram(input.program);
  const program = known?.program ?? clean(input.program, 60);
  if (!program) throw new Invalid('Name the programme');
  const cur = store.db.prepare('SELECT * FROM loyalty_accounts WHERE program = ?').get(program) as Row | undefined;
  const kind: LoyaltyAccount['kind'] = input.kind ?? cur?.kind ?? known?.kind ?? 'airline';
  const pick = <T>(v: T | undefined, k: string): T => (v === undefined ? (cur?.[k] ?? null) : v) as T;
  // Only ever keep the last four digits of a membership number.
  const suffix = input.memberSuffix !== undefined ? input.memberSuffix.replace(/\D/g, '').slice(-4) : (cur?.member_suffix ?? '');
  const row = {
    tier: clean(pick(input.tier, 'tier') ?? '', 40),
    points: pick(input.points, 'points'),
    progress: pick(input.progress, 'progress'),
    progressTarget: pick(input.progressTarget, 'progress_target'),
    progressLabel: clean(pick(input.progressLabel, 'progress_label') ?? '', 60),
    expires: pick(input.expires, 'expires'),
  };
  const now = nowIso();
  if (cur) {
    store.db
      .prepare('UPDATE loyalty_accounts SET kind = ?, tier = ?, points = ?, progress = ?, progress_target = ?, progress_label = ?, expires = ?, member_suffix = ?, source = ?, updated_at = ? WHERE id = ?')
      .run(kind, row.tier, row.points === null ? null : Math.round(row.points), row.progress, row.progressTarget, row.progressLabel, row.expires, suffix, source, now, cur.id);
  } else {
    store.db
      .prepare('INSERT INTO loyalty_accounts (id, program, kind, tier, points, progress, progress_target, progress_label, expires, member_suffix, source, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(newId(), program, kind, row.tier, row.points === null ? null : Math.round(row.points), row.progress, row.progressTarget, row.progressLabel, row.expires, suffix, source, now);
  }
  const saved = loyaltyFromRow(store.db.prepare('SELECT * FROM loyalty_accounts WHERE program = ?').get(program) as Row);
  if (!quiet) store.record('updated', 'loyalty', saved.id, travelSphere(store), `${program}: ${[saved.tier, saved.points !== null ? `${saved.points.toLocaleString('en')} ${kind === 'airline' ? 'miles' : 'points'}` : ''].filter(Boolean).join(', ')}`);
  return saved;
}

// ── Where you are now ───────────────────────────────────────────────────────

export function travelContext(store: Store, today: string, now: Date = new Date()): TravelContext {
  const trips = listTrips(store, today).filter((t) => t.endDate >= today);
  const t = now.getTime();
  const flights = trips
    .flatMap((trip) => trip.segments.filter((s) => s.kind === 'flight').map((s) => ({ s, trip, at: zonedToUtc(s.startLocal, s.startTz).getTime() })))
    .sort((a, b) => a.at - b.at);
  const next = flights.find((f) => f.at > t - 0.25 * HOUR && f.at - t <= 36 * HOUR) ?? null;
  const active = trips.find((x) => x.startDate <= today && x.endDate >= today) ?? null;
  const soon = trips.find((x) => x.startDate > today && daysBetween(today, x.startDate) <= 14) ?? null;
  const trip = next?.trip ?? active ?? soon;
  const mode: TravelContext['mode'] = next ? 'departing' : active ? 'away' : soon ? 'upcoming' : 'none';

  const layovers: TravelContext['layovers'] = [];
  if (trip) {
    const legs = trip.segments.filter((s) => s.kind === 'flight');
    for (let i = 1; i < legs.length; i++) {
      const a = legs[i - 1]!;
      const b = legs[i]!;
      if (!a.toCode || a.toCode !== b.fromCode) continue;
      const gap = (zonedToUtc(b.startLocal, b.startTz).getTime() - zonedToUtc(a.endLocal, a.endTz).getTime()) / HOUR;
      if (gap > 0 && gap < 24 && zonedToUtc(b.startLocal, b.startTz).getTime() > t) {
        layovers.push({ airport: a.toCode, city: airport(a.toCode)?.city ?? a.toName, hours: Math.round(gap * 10) / 10, afterSegmentId: a.id, nextSegmentId: b.id });
      }
    }
  }

  const stay = active
    ? (active.segments.find((s) => s.kind === 'stay' && s.startLocal.slice(0, 10) <= today && s.endLocal.slice(0, 10) > today) ??
      active.segments.find((s) => s.kind === 'stay' && s.startLocal.slice(0, 10) === today) ??
      null)
    : null;

  return {
    mode,
    trip,
    flight: next ? { ...next.s, departsInMin: Math.round((next.at - t) / 60_000) } : null,
    stay,
    layovers,
    dayOfTrip: active ? daysBetween(active.startDate, today) + 1 : null,
    tripDays: trip ? daysBetween(trip.startDate, trip.endDate) + 1 : null,
  };
}

export function travelState(store: Store, today: string, now?: Date): TravelState {
  return { settings: travelSettings(store), trips: listTrips(store, today), loyalty: listLoyalty(store), context: travelContext(store, today, now) };
}

// ── Seldon's preparation ────────────────────────────────────────────────────

const describeSegment = (s: Segment) =>
  s.kind === 'flight'
    ? `Flight ${s.carrier} ${s.number} ${s.fromCode || s.fromName} → ${s.toCode || s.toName}, departs ${s.startLocal.replace('T', ' ')} (${s.startTz}), arrives ${s.endLocal.replace('T', ' ')} (${s.endTz})${s.cabin ? `, ${s.cabin}` : ''}`
    : `${s.kind === 'stay' ? 'Stay' : s.kind} ${s.title}${s.address ? `, ${s.address}` : ''}, ${s.startLocal.replace('T', ' ')} to ${s.endLocal.replace('T', ' ')}`;

const Companion = z.object({
  lounges: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        where: z.string().max(140),
        access: z.string().max(80),
        reachable: z.boolean(),
        note: z.string().max(220),
      }),
    )
    .max(6),
  plan: z.array(z.string().max(300)).max(8),
});

/** The connection before a flight on the same trip: the previous flight landing where this one leaves, under a day earlier. */
function connectionBefore(trip: Trip, seg: Segment): { airport: string; hours: number } | undefined {
  const flights = trip.segments.filter((x) => x.kind === 'flight');
  const prev = flights[flights.findIndex((x) => x.id === seg.id) - 1];
  if (!prev || !prev.toCode || prev.toCode !== seg.fromCode) return undefined;
  const hours = (Date.parse(seg.startUtc) - Date.parse(prev.endUtc)) / 3_600_000;
  return hours > 0 && hours < 24 ? { airport: seg.fromCode, hours: Math.round(hours * 10) / 10 } : undefined;
}

/** The airport app for one flight: the lounges to use there and what to do with the time. */
export async function buildCompanion(store: Store, segmentId: string, now: Date = new Date()): Promise<Trip> {
  const r = store.db.prepare('SELECT * FROM trip_segments WHERE id = ?').get(segmentId) as Row | undefined;
  if (!r || r.kind !== 'flight' || !r.trip_id) throw new NotFound('Flight');
  const trip = getTrip(store, r.trip_id);
  const seg = trip.segments.find((s) => s.id === segmentId)!;
  const layover = connectionBefore(trip, seg) ?? travelContext(store, localDate(now), now).layovers.find((l) => l.nextSegmentId === segmentId);
  const flights = trip.segments.filter((x) => x.kind === 'flight');
  const arriving = layover ? flights[flights.findIndex((x) => x.id === seg.id) - 1] : undefined;
  const where = airport(seg.fromCode);
  const res = await think({
    store,
    task: `You are preparing a short airport companion for someone about to fly. Using what you know of ${where ? `${where.name} airport in ${where.city}` : `the departure airport (${seg.fromCode || seg.fromName})`}:
- "lounges": up to 5 lounges, best first, each {"name", "where", "access", "reachable", "note"}. "where" is the terminal, concourse or gates and whether airside or landside. "access" is how they get in, matching the eligibility given ("Revolut Ultra", "Business fare", "Star Alliance Gold"), or "Pay at the door, about €40" for a pay-in option. "reachable" is true only if they can actually use it on this flight: on a connection, airside in the terminal and area they land in and leave from (with the departure gates' passport and security rules in mind), and open at that hour. Revolut Ultra and LoungeKey mean the LoungeKey network; Priority Pass its own. Include a card lounge that is landside or in another terminal with "reachable": false and say why in "note", so they know. If nothing they are eligible for is reachable, add the best pay-in lounge they can reach. "note" is one line worth knowing (showers, quiet, the better of two).
- "plan": 3 to 6 concrete suggestions that fit the time they have${layover ? ` (a ${layover.hours}-hour layover)` : ' before boarding'}, e.g. what to see or eat (halal options), where the prayer room (musolla) is, whether there is time to leave the airport, and when to head to the gate. They are Muslim; on a long journey mention that a traveller may shorten and combine prayers.
Be specific and brief. If you are unsure of a detail, such as which concourse a flight leaves from, say so in the note. Reply {"lounges": [...], "plan": [...]}.`,
    input: [
      `Trip purpose: ${trip.purpose}.`,
      wrapUntrusted('booking', `Trip: ${trip.title}\n${describeSegment(seg)}${arriving ? `\nArriving on: ${describeSegment(arriving)}` : ''}`, 2400),
      `Eligibility from their fare and status: ${seg.lounges.length ? seg.lounges.map((l) => `${l.access} (${l.basis})`).join('; ') : 'none known'}.`,
      layover ? `This is a connection: ${layover.hours} hours at ${layover.airport}${arriving ? ', arriving on the flight given above' : ''}.` : `Departing from ${seg.fromCode}.`,
    ].join('\n'),
    schema: Companion,
  });
  // Plain lines for the places that show a lounge as text (Today's card, the departure notice), usable ones first.
  const picks = [...res.lounges].sort((a, b) => Number(b.reachable) - Number(a.reachable));
  const lines = picks.map((l) => `${l.name} — ${[l.where, l.reachable ? '' : 'not on this connection'].filter(Boolean).join(', ')} · ${l.access}`);
  const companion = { ...trip.companion, [segmentId]: { lounges: lines.slice(0, 5), plan: res.plan, picks, generatedAt: nowIso() } };
  store.db.prepare('UPDATE trips SET companion = ? WHERE id = ?').run(JSON.stringify(companion), trip.id);
  return getTrip(store, trip.id);
}

const Plan = z.object({
  items: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
        title: z.string().max(160),
        place: z.string().max(160),
        notes: z.string().max(600),
        kind: z.enum(['activity', 'food', 'transit', 'work', 'rest']),
      }),
    )
    .max(60),
});

/** A first plan for the trip, day by day, for the person to edit. Days that already have plans are left alone. */
export async function draftItinerary(store: Store, tripId: string): Promise<Trip> {
  const trip = getTrip(store, tripId);
  const planned = new Set(trip.itinerary.map((i) => i.date));
  const days = Array.from({ length: daysBetween(trip.startDate, trip.endDate) + 1 }, (_, i) => addDays(trip.startDate, i)).filter((d) => !planned.has(d));
  if (days.length === 0) return trip;
  const res = await think({
    store,
    task: `Draft a realistic day-by-day plan for this ${trip.purpose} trip, to the destination given below, for these dates only: ${days.join(', ')}.
- Fit around the flights and hotel: nothing before landing or after the last departure; leave time to get to and from the airport (a "transit" item).
- ${trip.purpose === 'work' ? 'It is a work trip: keep working hours as "work" blocks (title "Work" unless the notes say what), and suggest a few things for evenings and any free day.' : 'It is a leisure trip: two or three anchors a day with room to breathe, mixing sights, local experiences and rest.'}
- They are Muslim: suggest halal or Muslim-friendly places to eat, and on a Friday, Jumu'ah at a nearby mosque around midday.
- Use real, specific places. Times are local, "HH:MM", or null for flexible items.
Reply {"items": [{"date", "time", "title", "place", "notes", "kind": "activity"|"food"|"transit"|"work"|"rest"}]}.`,
    input: [
      `Trip dates: ${trip.startDate} to ${trip.endDate}, purpose ${trip.purpose}.`,
      wrapUntrusted('trip', `Name: ${trip.title}\nDestination: ${trip.destination || 'not given'}`, 400),
      trip.segments.length ? wrapUntrusted('bookings', trip.segments.map(describeSegment).join('\n'), 6000) : 'No bookings on file yet.',
      trip.notes ? wrapUntrusted('their notes for the trip', trip.notes, 2000) : '',
    ]
      .filter(Boolean)
      .join('\n'),
    schema: Plan,
  });
  const wanted = new Set(days);
  const added = addItems(store, tripId, res.items.filter((i) => wanted.has(i.date)), true);
  store.db.prepare('UPDATE trips SET drafted = 1 WHERE id = ?').run(tripId);
  // Each draft is its own entry, holding the ids it made, so undo takes back only those.
  const activity = store.record('created', 'itinerary_draft', newId(), sphereFor(store, trip.purpose), `Drafted a plan for ${trip.title}`);
  store.db.prepare('UPDATE activity SET undo_data = ? WHERE id = ?').run(JSON.stringify({ tripId, items: added.map((i) => i.id) }), activity);
  return getTrip(store, tripId);
}

/** Every half hour: get ahead of flights in the next day and trips in the next week. */
export async function prepareTravel(store: Store, now: Date = new Date()): Promise<void> {
  const today = localDate(now);
  const ctx = travelContext(store, today, now);
  for (const trip of listTrips(store, today).filter((t) => t.endDate >= today)) {
    for (const seg of trip.segments.filter((s) => s.kind === 'flight')) {
      const at = zonedToUtc(seg.startLocal, seg.startTz).getTime();
      const until = at - now.getTime();
      if (until <= 0 || until > 24 * HOUR) continue;
      let lounges = seg.lounges.map((l) => l.access);
      if (!trip.companion[seg.id] && due(`companion:${seg.id}`, now)) {
        try {
          const t = await buildCompanion(store, seg.id, now);
          lounges = t.companion[seg.id]?.lounges ?? lounges;
        } catch (err) {
          failed(`companion:${seg.id}`, err, now);
        }
      }
      const layover = ctx.layovers.find((l) => l.nextSegmentId === seg.id);
      addSignal(store, {
        source: ID,
        kind: 'flight',
        externalId: `flight:${seg.id}`,
        title: `${seg.carrier} ${seg.number} to ${airport(seg.toCode)?.city ?? seg.toName} leaves ${seg.startLocal.slice(11)}${layover ? ` — ${layover.hours} h at ${layover.airport}` : ''}`,
        body: lounges.length ? `Lounge: ${lounges[0]}` : 'No lounge from your fare or status on this one.',
        sphereId: sphereFor(store, trip.purpose),
        priority: 2,
        data: { tripId: trip.id, segmentId: seg.id },
      });
    }
    const startsIn = daysBetween(today, trip.startDate);
    const r = store.db.prepare('SELECT drafted FROM trips WHERE id = ?').get(trip.id) as Row;
    if (startsIn >= 0 && startsIn <= 7 && !r.drafted && trip.itinerary.length === 0 && due(`draft:${trip.id}`, now)) {
      try {
        await draftItinerary(store, trip.id);
        addSignal(store, {
          source: ID,
          kind: 'itinerary',
          externalId: `itinerary:${trip.id}`,
          title: `A first plan for ${trip.title} is ready`,
          body: `Seldon drafted ${daysBetween(trip.startDate, trip.endDate) + 1} days. Edit anything — it is yours.`,
          sphereId: sphereFor(store, trip.purpose),
          priority: 1,
          data: { tripId: trip.id },
        });
      } catch (err) {
        failed(`draft:${trip.id}`, err, now);
      }
    }
  }
}

// A model that is down or answering badly should not hold up the rule-based flight signal
// or the other trips, nor be asked again every half hour.
const RETRY_AFTER = 3 * HOUR;
const failures = new Map<string, number>();
const due = (key: string, now: Date) => (failures.get(key) ?? -Infinity) + RETRY_AFTER <= now.getTime();
function failed(key: string, err: unknown, now: Date): void {
  if (err instanceof NoBrain) return;
  failures.set(key, now.getTime());
  console.warn(`[${ID}] ${key} failed:`, err instanceof Error ? err.message : err);
}

// ── Reading bookings and statements ─────────────────────────────────────────

const ExtractedSegment = z.object({
  kind: z.enum(['flight', 'stay', 'train', 'car', 'event']),
  title: z.string().max(160).describe('Hotel name for stays; empty for flights'),
  carrier: z.string().max(60).describe('Airline IATA code for flights ("SQ"), hotel brand for stays'),
  number: z.string().max(12).describe('Flight number without the carrier, e.g. "638"'),
  from_code: z.string().max(4),
  from_name: z.string().max(120),
  to_code: z.string().max(4),
  to_name: z.string().max(120),
  start_local: z.string().regex(stamp),
  start_tz: z.string().max(40).nullable(),
  end_local: z.string().regex(stamp).nullable(),
  end_tz: z.string().max(40).nullable(),
  cabin: z.string().max(40),
  seat: z.string().max(8),
  confirmation: z.string().max(20),
  address: z.string().max(300),
});

const Extraction = z.object({
  kind: z.enum(['booking', 'cancellation', 'loyalty', 'booking_and_loyalty', 'none']),
  trip: z.object({ destination: z.string().max(120), purpose: z.enum(['work', 'leisure']).nullable() }).nullable(),
  segments: z.array(ExtractedSegment).max(12),
  loyalty: z
    .array(
      z.object({
        program: z.string().max(60),
        tier: z.string().max(40),
        points: z.number().nullable(),
        progress: z.number().nullable(),
        progress_target: z.number().nullable(),
        progress_label: z.string().max(60),
        expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
        member_suffix: z.string().max(4),
      }),
    )
    .max(4),
});

const EXTRACT_TASK = `Read this travel document (an email or a screenshot) and pull out bookings and loyalty-programme standing.
- "kind": "booking" for a confirmation, itinerary, e-ticket, boarding pass or check-in notice; "cancellation" when it cancels something; "loyalty" for a statement or app screen showing tier, miles or points; "booking_and_loyalty" for both; "none" otherwise (newsletters, offers, surveys).
- "segments": each flight (one per leg; airline code in "carrier", digits in "number"; airport IATA codes) and each hotel stay (check-in as start, check-out as end; hotel name in "title"). Times are local wall-clock "YYYY-MM-DDTHH:MM"; for a stay without times use 15:00 and 12:00. Zones are IANA names when you can tell, else null.
- "trip": the destination city and whether it reads as work (a company booking, a conference) or leisure; null purpose when unclear.
- "loyalty": for KrisFlyer give tier (KrisFlyer, Elite Silver, Elite Gold, PPS Club, Solitaire PPS Club), miles in "points", elite miles or PPS value towards the next tier in "progress" with its target and a label like "elite miles to Gold"; for Marriott Bonvoy give tier (Member, Silver, Gold, Platinum, Titanium, Ambassador), points, and nights this year in "progress" with the next tier's nights as target. Only the last four digits of a membership number.
Only report what the document says. Reply as JSON with keys kind, trip, segments, loyalty.`;

export type Extracted = z.infer<typeof Extraction>;

const toSegmentInput = (s: Extracted['segments'][number]): SegmentInput => ({
  kind: s.kind,
  title: s.title,
  carrier: s.carrier,
  number: s.number,
  fromCode: s.from_code,
  fromName: s.from_name,
  toCode: s.to_code,
  toName: s.to_name,
  startLocal: s.start_local,
  startTz: s.start_tz,
  endLocal: s.end_local,
  endTz: s.end_tz,
  cabin: s.cabin,
  seat: s.seat,
  confirmation: s.confirmation,
  address: s.address,
});

export interface Applied {
  trips: string[];
  segments: Segment[];
  loyalty: LoyaltyAccount[];
  cancellation: boolean;
}

/** File what was read: bookings onto the right trip (making one when needed), standing onto its account. */
export function applyExtraction(store: Store, x: Extracted, source: string, externalId: string | null): Applied {
  const out: Applied = { trips: [], segments: [], loyalty: [], cancellation: x.kind === 'cancellation' };
  if (x.kind === 'none' || x.kind === 'cancellation') return out;
  const settings = travelSettings(store);
  const segs = [...x.segments].sort((a, b) => a.start_local.localeCompare(b.start_local));
  if (segs.length) {
    const first = segs[0]!.start_local.slice(0, 10);
    const last = segs.reduce((m, s) => ((s.end_local ?? s.start_local).slice(0, 10) > m ? (s.end_local ?? s.start_local).slice(0, 10) : m), first);
    let trip = tripFor(store, first, last);
    if (!trip) {
      const away = segs.find((s) => s.kind === 'flight' && s.to_code.toUpperCase() !== settings.homeAirport);
      const destination = x.trip?.destination || (away ? (airport(away.to_code)?.city ?? away.to_name) : (segs.find((s) => s.kind === 'stay')?.address ?? ''));
      const created = createTrip(store, { destination, title: destination || 'Trip', purpose: x.trip?.purpose ?? 'leisure', startDate: first, endDate: last }, true);
      trip = store.db.prepare('SELECT * FROM trips WHERE id = ?').get(created.id) as Row;
      store.record('created', 'trip', created.id, sphereFor(store, created.purpose), `Found a trip in your ${source === 'gmail' ? 'mail' : 'screenshot'}: ${created.title}`);
    }
    out.trips.push(trip!.id);
    segs.forEach((s, i) => {
      try {
        const { segment, created } = addSegment(store, trip!.id, toSegmentInput(s), source, externalId ? `${externalId}#${i}` : null, true);
        if (created) out.segments.push(segment);
      } catch {
        /* a leg the model garbled; the rest still count */
      }
    });
  }
  for (const l of x.loyalty) {
    if (!l.program) continue;
    out.loyalty.push(
      upsertLoyalty(
        store,
        {
          program: l.program,
          tier: l.tier || undefined,
          points: l.points ?? undefined,
          progress: l.progress ?? undefined,
          progressTarget: l.progress_target ?? undefined,
          progressLabel: l.progress_label || undefined,
          expires: l.expires ?? undefined,
          memberSuffix: l.member_suffix || undefined,
        },
        source,
      ),
    );
  }
  return out;
}

export async function extractTravel(store: Store, text: string, image?: { data: Buffer; mime: string }): Promise<Extracted> {
  return think({
    store,
    task: EXTRACT_TASK,
    input: wrapUntrusted('travel document', text || 'See the image.', 20_000),
    images: image ? [{ mediaType: image.mime, data: image.data.toString('base64') }] : undefined,
    schema: Extraction,
  });
}

const TRAVEL_SENDERS = /singaporeair|krisflyer|marriott|bonvoy|scoot|booking\.com|agoda|expedia|airbnb|trip\.com|hotels\.com|klook|emirates|qatarairways|cathaypacific|ana\.co\.jp|jal\.co|lufthansa|united\.com|britishairways|airasia|malaysiaairlines|garuda|thaiairways|turkishairlines|hilton|hyatt|ihg|accor|shangri-la|pan pacific|concur|navan|tripactions|egencia/i;
const TRAVEL_SUBJECT = /\b(flight|itinerary|e-?ticket|boarding pass|check[- ]?in|booking (confirm|reference)|reservation|your (stay|trip)|elite|statement|miles|points summary)\b/i;

export const looksLikeTravel = (m: MailMessage) => TRAVEL_SENDERS.test(m.from.address) || TRAVEL_SUBJECT.test(m.subject);

async function onMail(store: Store, m: MailMessage): Promise<void> {
  if (!looksLikeTravel(m)) return;
  let x: Extracted;
  try {
    x = await extractTravel(store, `From: ${m.from.name} <${m.from.address}>\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.text}`);
  } catch (err) {
    if (err instanceof NoBrain) return;
    throw err;
  }
  const applied = applyExtraction(store, x, 'gmail', m.messageId);
  const trip = applied.trips[0] ? getTrip(store, applied.trips[0]) : null;
  if (applied.cancellation) {
    addSignal(store, { source: ID, kind: 'cancellation', externalId: `mail:${m.messageId}`, title: `Looks like a cancellation: ${m.subject}`, body: 'Check your trips — Terminus leaves bookings in place until you remove them.', sphereId: travelSphere(store), priority: 2, occurredAt: m.date });
  } else if (applied.segments.length && trip) {
    const what = applied.segments.map((s) => (s.kind === 'flight' ? `${s.carrier} ${s.number}` : s.title)).join(', ');
    addSignal(store, { source: ID, kind: 'booking', externalId: `mail:${m.messageId}`, title: `Added ${what} to ${trip.title}`, body: `From “${m.subject}”.`, sphereId: sphereFor(store, trip.purpose), priority: 1, occurredAt: m.date, data: { tripId: trip.id } });
  }
}

// ── Undo ────────────────────────────────────────────────────────────────────

registerUndo('created:trip', (db, id) => void db.prepare('DELETE FROM trips WHERE id = ?').run(id));
registerUndo('created:trip_segment', (db, id) => void db.prepare('DELETE FROM trip_segments WHERE id = ?').run(id));
registerUndo('created:itinerary', (db, id) => void db.prepare('DELETE FROM itinerary_items WHERE id = ?').run(id));
registerUndo('created:trip_option', (db, id) => void db.prepare('DELETE FROM trip_options WHERE id = ?').run(id));
registerUndo('created:trip_stay_option', (db, id) => void db.prepare('DELETE FROM trip_stay_options WHERE id = ?').run(id));
// Takes back the draft's own items that are not ticked off. The trip stays marked as drafted,
// so the half-hourly job does not draft it again; "Draft with Seldon" still can.
registerUndo('created:itinerary_draft', (db, id) => {
  const a = db.prepare("SELECT ts, undo_data FROM activity WHERE verb = 'created' AND entity_type = 'itinerary_draft' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(id) as Row | undefined;
  const made = a?.undo_data ? (JSON.parse(a.undo_data) as { items: string[] }).items : null;
  if (made) {
    const drop = db.prepare('DELETE FROM itinerary_items WHERE id = ? AND done = 0');
    for (const item of made) drop.run(item);
  } else if (a) {
    // Drafts logged before ids were kept: entity_id is the trip, and its items were added just before the entry.
    db.prepare('DELETE FROM itinerary_items WHERE trip_id = ? AND done = 0 AND created_at <= ? AND created_at >= ?').run(id, a.ts, new Date(Date.parse(a.ts) - 60_000).toISOString());
  }
});

// ── Agent ───────────────────────────────────────────────────────────────────

registerSnapshotSection<Store>('Travel', (store, today) => {
  const ctx = travelContext(store, today);
  const trips = listTrips(store, today).filter((t) => t.endDate >= today).slice(0, 3);
  const loyalty = listLoyalty(store);
  if (!trips.length && !loyalty.length) return null;
  const lines: string[] = [];
  if (ctx.flight) {
    const f = ctx.flight;
    lines.push(`Next flight: ${f.carrier} ${f.number} ${f.fromCode} → ${f.toCode}, ${f.startLocal.replace('T', ' ')} local, in ${Math.round(f.departsInMin / 6) / 10} h${f.cabin ? `, ${f.cabin}` : ''}. Lounge: ${f.lounges[0]?.access ?? 'none from fare or status'}.`);
  }
  for (const l of ctx.layovers) lines.push(`Layover: ${l.hours} h at ${l.airport}.`);
  if (ctx.mode === 'away' && ctx.trip) lines.push(`Away now: day ${ctx.dayOfTrip} of ${ctx.tripDays} in ${ctx.trip.title}${ctx.stay ? `, staying at ${ctx.stay.title}` : ''}.`);
  for (const t of trips) {
    const open = t.todos.filter((x) => !x.done);
    lines.push(`Trip [${t.id}] ${t.title} (${t.purpose}), ${t.startDate} to ${t.endDate}: ${t.segments.length} bookings, ${t.itinerary.length} plan items, ${open.length} open to-dos${t.options.length ? `, ${t.options.length} flight options` : ''}${t.stayOptions.length ? `, ${t.stayOptions.length} hotel options` : ''}.`);
    for (const o of t.options.slice(0, 4)) lines.push(`  Option [${o.id}] ${o.title}${o.recommended ? ' (recommended)' : ''}${o.chosenAt ? ' (added to the trip)' : ''}: ${o.legs.map((l) => `${l.carrier}${l.number} ${l.fromCode}-${l.toCode} ${l.startLocal.replace('T', ' ')}`).join(', ')}`);
    for (const h of t.stayOptions.slice(0, 8)) lines.push(`  Hotel option [${h.id}] ${h.name}${h.recommended ? ' (recommended)' : ''}${h.chosenAt ? ' (added to the trip)' : ''}${h.distanceKm != null ? `: ${h.distanceKm} km${h.distanceFrom ? ` to ${h.distanceFrom}` : ''}` : ''}${h.gettingThere ? `, ${h.gettingThere}` : ''}`);
    for (const x of open.slice(0, 8)) lines.push(`  To-do [${x.id}] ${x.title}${x.dueDate ? ` (due ${x.dueDate})` : ''}`);
  }
  for (const a of loyalty) lines.push(`${a.program}: ${[a.tier, a.points !== null ? `${a.points.toLocaleString('en')} ${a.kind === 'airline' ? 'miles' : 'points'}` : '', a.progress !== null && a.progressTarget ? `${a.progress}/${a.progressTarget} ${a.progressLabel}` : ''].filter(Boolean).join(', ')} (as of ${a.updatedAt.slice(0, 10)}).`);
  // Names of trips, hotels, carriers and programmes are often copied out of mail and screenshots.
  return wrapUntrusted('travel bookings and loyalty, partly read from mail and screenshots', lines.join('\n'), 8000);
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^\d{2}:\d{2}$/);
const purpose = z.enum(['work', 'leisure']);
const tripInput = z.object({ title: z.string().max(120).optional(), purpose: purpose.optional(), destination: z.string().max(120).optional(), startDate: dateStr, endDate: dateStr, notes: z.string().max(2000).optional() });
const segmentInput = z.object({
  kind: z.enum(['flight', 'stay', 'train', 'car', 'event']),
  title: z.string().max(160).optional(),
  carrier: z.string().max(60).optional(),
  number: z.string().max(12).optional(),
  fromCode: z.string().max(4).optional(),
  fromName: z.string().max(120).optional(),
  toCode: z.string().max(4).optional(),
  toName: z.string().max(120).optional(),
  startLocal: z.string().regex(stamp),
  startTz: z.string().max(40).nullable().optional(),
  endLocal: z.string().regex(stamp).nullable().optional(),
  endTz: z.string().max(40).nullable().optional(),
  cabin: z.string().max(40).optional(),
  seat: z.string().max(8).optional(),
  confirmation: z.string().max(20).optional(),
  address: z.string().max(300).optional(),
  notes: z.string().max(1000).optional(),
});
const optionLegInput = z.object({
  cabin: z.enum(['economy', 'premium', 'business']).optional(),
  carrier: z.string().min(1).max(4),
  number: z.string().min(1).max(8),
  fromCode: z.string().length(3),
  toCode: z.string().length(3),
  startLocal: z.string().regex(stamp),
  endLocal: z.string().regex(stamp),
  startTz: z.string().max(40).nullable().optional(),
  endTz: z.string().max(40).nullable().optional(),
});
const optionInput = z.object({
  title: z.string().min(1).max(80),
  summary: z.string().max(300).optional(),
  notes: z.array(z.string().max(300)).max(8).optional(),
  recommended: z.boolean().optional(),
  legs: z.array(optionLegInput).min(1).max(6),
});
const stayOptionInput = z.object({
  name: z.string().min(1).max(120),
  brand: z.string().max(60).optional(),
  address: z.string().max(300).optional(),
  area: z.string().max(80).optional(),
  distanceKm: z.number().min(0).max(20000).nullable().optional(),
  distanceFrom: z.string().max(80).optional(),
  gettingThere: z.string().max(80).optional(),
  summary: z.string().max(300).optional(),
  notes: z.array(z.string().max(300)).max(8).optional(),
  recommended: z.boolean().optional(),
});
const itemInput = z.object({ date: dateStr, time: time.nullable().optional(), title: z.string().min(1).max(160), place: z.string().max(160).optional(), notes: z.string().max(600).optional(), kind: z.enum(['activity', 'food', 'transit', 'work', 'rest']).optional() });
const loyaltyInput = z.object({
  program: z.string().min(1).max(60),
  kind: z.enum(['airline', 'hotel', 'lounge']).optional(),
  tier: z.string().max(40).optional(),
  points: z.number().min(0).max(1e9).nullable().optional(),
  progress: z.number().min(0).max(1e9).nullable().optional(),
  progressTarget: z.number().min(0).max(1e9).nullable().optional(),
  progressLabel: z.string().max(60).optional(),
  expires: dateStr.nullable().optional(),
  memberSuffix: z.string().max(20).optional(),
});

async function imageFrom(form: FormData) {
  const f = form.get('file');
  if (!f || typeof f === 'string') return undefined;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) throw new Invalid('Screenshots must be PNG, JPEG, WebP or GIF');
  if (f.size > 5_000_000) throw new Invalid('That image is too large (5 MB at most)');
  return { data: Buffer.from(await f.arrayBuffer()), mime: f.type };
}

const compactTrip = (t: Trip) => ({
  ...t,
  segments: t.segments.map((s) => ({ id: s.id, kind: s.kind, what: describeSegment(s), seat: s.seat || undefined, confirmation: s.confirmation || undefined, lounges: s.lounges.length ? s.lounges : undefined, perks: s.perks.length ? s.perks : undefined,
    bonvoyEliteNights: s.eliteNights ? (s.eliteNights.after !== null ? `+${s.eliteNights.nights}, ${s.eliteNights.before} → ${s.eliteNights.after} in ${s.eliteNights.year}${s.eliteNights.reaches ? `, reaches ${s.eliteNights.reaches}` : ''}${s.eliteNights.next ? `, ${s.eliteNights.next.at - s.eliteNights.after} more to ${s.eliteNights.next.tier}` : ''}` : `+${s.eliteNights.nights}${s.eliteNights.counted ? ' (already counted)' : ''}`) : undefined })),
  todos: t.todos.map((x) => ({ id: x.id, title: x.title, due: x.dueDate, done: x.done })),
});

registerFeature({
  id: ID,
  tables: ['trips', 'trip_segments', 'itinerary_items', 'loyalty_accounts', 'trip_options', 'trip_stay_options'],
  integration: { configured: () => true },
  jobs: [{ id: ID, everyMs: 30 * 60_000, run: async (store) => prepareTravel(store) }],
  mail: async (store, m) => onMail(store, m),
  tools: [
    tool(
      'get_travel',
      'Read the user\'s trips (bookings, plan items, airport notes), their KrisFlyer / Marriott Bonvoy / lounge standing, and what is happening now: next flight with lounge eligibility, layovers, the current stay.',
      z.object({}),
      (_, { store, today }) => {
        const s = travelState(store, today);
        return { data: { context: { ...s.context, trip: s.context.trip?.id ?? null }, trips: s.trips.slice(0, 6).map(compactTrip), loyalty: s.loyalty, homeAirport: s.settings.homeAirport }, summary: 'Read travel' };
      },
    ),
    tool(
      'create_trip',
      'Create a trip. Purpose is "work" (also shows in the Work sphere) or "leisure". Add flights and stays with add_trip_booking afterwards.',
      tripInput,
      (t, { store }) => {
        const trip = createTrip(store, t);
        return { data: { ok: true, id: trip.id }, summary: `Created trip ${trip.title}` };
      },
    ),
    tool(
      'add_trip_booking',
      'Add a flight, hotel stay, train, car or event to a trip. Times are local wall-clock "YYYY-MM-DDTHH:MM" at each end; airports as IATA codes; airline code in carrier and digits in number. The same flight on the same day is merged, not duplicated.',
      segmentInput.extend({ trip_id: z.string().min(1) }),
      ({ trip_id, ...s }, { store }) => {
        const { segment, created } = addSegment(store, trip_id, s, 'seldon');
        return { data: { ok: true, id: segment.id, merged: !created, lounges: segment.lounges, perks: segment.perks }, summary: `${created ? 'Added' : 'Updated'} ${segment.title || segment.kind}` };
      },
    ),
    tool(
      'add_flight_option',
      'Save a flight routing for the user to weigh on the trip\'s page, before anything is booked: a short title ("Via Johannesburg"), one line on when it lands, the legs (airline code, flight number, IATA codes, local times "YYYY-MM-DDTHH:MM" at each end, and the cabin: economy, premium or business), and short notes on what speaks for and against it. Mark at most one recommended. Use real schedules you have checked; say in the notes what to confirm.',
      optionInput.extend({ trip_id: z.string().min(1) }),
      ({ trip_id, ...o }, { store }) => {
        const opt = addOption(store, trip_id, o);
        return { data: { ok: true, id: opt.id }, summary: `Saved the option “${opt.title}”` };
      },
    ),
    tool(
      'add_hotel_option',
      'Save a hotel for the user to weigh on the trip\'s page, before anything is booked. Give its name, brand ("Marriott" for any Bonvoy hotel, so status perks show), address and neighbourhood, the distance in km to where they will spend their days (distance_from: "the office", "the venue") and how long it takes ("12 min walk", "15 min by car"), one line on why, and short notes. The page lists them nearest first. Mark at most one recommended. Say in the notes what is estimated.',
      stayOptionInput.extend({ trip_id: z.string().min(1) }),
      ({ trip_id, ...o }, { store }) => {
        const opt = addStayOption(store, trip_id, o);
        return { data: { ok: true, id: opt.id }, summary: `Saved the hotel option “${opt.name}”` };
      },
    ),
    tool(
      'add_itinerary_items',
      'Add items to a trip\'s day-by-day plan (the user can edit them). For a fresh plan, use real places, fit around flights, suggest halal food, and Jumu\'ah on Fridays. Kinds: activity, food, transit, work, rest.',
      z.object({ trip_id: z.string().min(1), items: z.array(itemInput).min(1).max(40) }),
      ({ trip_id, items }, { store }) => {
        const added = addItems(store, trip_id, items);
        return { data: { ok: true, ids: added.map((i) => i.id) }, summary: `Added ${added.length} plan item${added.length === 1 ? '' : 's'}` };
      },
    ),
    tool(
      'update_itinerary_item',
      'Change or tick off an item in a trip plan.',
      itemInput.partial().extend({ id: z.string().min(1), done: z.boolean().optional() }),
      ({ id, ...p }, { store }) => {
        const it = updateItem(store, id, p);
        return { data: { ok: true }, summary: `Updated “${it.title}”` };
      },
    ),
    tool(
      'save_airport_companion',
      'Save notes for a flight that show on Today as it approaches: the specific lounges to use at the departure airport (given their eligibility) and 3–6 suggestions for the time they have (layover ideas, halal food, prayer room, when to go to the gate).',
      z.object({ segment_id: z.string().min(1), lounges: z.array(z.string().max(200)).max(5), plan: z.array(z.string().max(300)).max(8) }),
      ({ segment_id, lounges, plan }, { store }) => {
        const r = store.db.prepare('SELECT trip_id FROM trip_segments WHERE id = ?').get(segment_id) as Row | undefined;
        if (!r?.trip_id) throw new NotFound('Flight');
        const trip = getTrip(store, r.trip_id);
        store.db.prepare('UPDATE trips SET companion = ? WHERE id = ?').run(JSON.stringify({ ...trip.companion, [segment_id]: { lounges, plan, generatedAt: nowIso() } }), trip.id);
        return { data: { ok: true }, summary: 'Saved airport notes' };
      },
    ),
    tool(
      'update_loyalty_account',
      'Record the user\'s standing in a loyalty programme (KrisFlyer, Marriott Bonvoy, Priority Pass or another): tier, miles or points, progress to the next tier, expiry. Only the last four digits of a membership number.',
      loyaltyInput,
      (l, { store }) => {
        const a = upsertLoyalty(store, l, 'seldon');
        return { data: { ok: true, account: a }, summary: `Updated ${a.program}` };
      },
    ),
  ],
  routes: (app, { store }) => {
    const state = (c: Parameters<typeof todayOf>[0]) => travelState(store, todayOf(c));
    app.get('/api/travel', (c) => c.json(state(c)));
    app.put('/api/travel/settings', async (c) => {
      const s = await read(c, z.object({ homeAirport: z.string().regex(/^[A-Za-z]{3}$/) }));
      updateIntegration(store, ID, (r) => void (r.settings = { ...r.settings, homeAirport: s.homeAirport.toUpperCase() }));
      return c.json(state(c));
    });
    app.post('/api/travel/trips', async (c) => {
      const trip = createTrip(store, await read(c, tripInput));
      return c.json({ ...state(c), created: trip.id }, 201);
    });
    app.patch('/api/travel/trips/:id', async (c) => {
      updateTrip(store, c.req.param('id'), await read(c, tripInput.partial()));
      return c.json(state(c));
    });
    app.delete('/api/travel/trips/:id', (c) => {
      if (!store.db.prepare('DELETE FROM trips WHERE id = ?').run(c.req.param('id')).changes) throw new NotFound('Trip');
      return c.json(state(c));
    });
    app.post('/api/travel/trips/:id/segments', async (c) => {
      addSegment(store, c.req.param('id'), await read(c, segmentInput));
      return c.json(state(c), 201);
    });
    app.patch('/api/travel/segments/:id', async (c) => {
      updateSegment(store, c.req.param('id'), await read(c, segmentInput.partial()));
      return c.json(state(c));
    });
    app.delete('/api/travel/segments/:id', (c) => {
      if (!store.db.prepare('DELETE FROM trip_segments WHERE id = ?').run(c.req.param('id')).changes) throw new NotFound('Booking');
      return c.json(state(c));
    });
    app.post('/api/travel/trips/:id/options', async (c) => {
      addOption(store, c.req.param('id'), await read(c, optionInput));
      return c.json(state(c), 201);
    });
    app.patch('/api/travel/options/:id', async (c) => {
      updateOption(store, c.req.param('id'), await read(c, optionInput.partial()));
      return c.json(state(c));
    });
    app.post('/api/travel/options/:id/choose', (c) => {
      chooseOption(store, c.req.param('id'));
      return c.json(state(c));
    });
    app.post('/api/travel/options/:id/unchoose', (c) => {
      unchooseOption(store, c.req.param('id'));
      return c.json(state(c));
    });
    app.delete('/api/travel/options/:id', (c) => {
      if (!store.db.prepare('DELETE FROM trip_options WHERE id = ?').run(c.req.param('id')).changes) throw new NotFound('Option');
      return c.json(state(c));
    });
    app.post('/api/travel/trips/:id/stay-options', async (c) => {
      addStayOption(store, c.req.param('id'), await read(c, stayOptionInput));
      return c.json(state(c), 201);
    });
    app.patch('/api/travel/stay-options/:id', async (c) => {
      updateStayOption(store, c.req.param('id'), await read(c, stayOptionInput.partial()));
      return c.json(state(c));
    });
    app.post('/api/travel/stay-options/:id/choose', (c) => {
      chooseStayOption(store, c.req.param('id'));
      return c.json(state(c));
    });
    app.post('/api/travel/stay-options/:id/unchoose', (c) => {
      unchooseStayOption(store, c.req.param('id'));
      return c.json(state(c));
    });
    app.delete('/api/travel/stay-options/:id', (c) => {
      if (!store.db.prepare('DELETE FROM trip_stay_options WHERE id = ?').run(c.req.param('id')).changes) throw new NotFound('Hotel option');
      return c.json(state(c));
    });
    app.post('/api/travel/trips/:id/itinerary', async (c) => {
      addItems(store, c.req.param('id'), [await read(c, itemInput)], true);
      return c.json(state(c), 201);
    });
    app.patch('/api/travel/itinerary/:id', async (c) => {
      updateItem(store, c.req.param('id'), await read(c, itemInput.partial().extend({ done: z.boolean().optional() })));
      return c.json(state(c));
    });
    app.delete('/api/travel/itinerary/:id', (c) => {
      if (!store.db.prepare('DELETE FROM itinerary_items WHERE id = ?').run(c.req.param('id')).changes) throw new NotFound('Plan item');
      return c.json(state(c));
    });
    const needsBrain = async <T>(fn: () => Promise<T>, what: string) => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof NoBrain) throw new Invalid(`Connect a brain in Settings so Seldon can ${what}.`);
        throw err;
      }
    };
    app.post('/api/travel/trips/:id/draft', async (c) => {
      await needsBrain(() => draftItinerary(store.as('agent'), c.req.param('id')), 'draft a plan');
      return c.json(state(c));
    });
    app.post('/api/travel/segments/:id/companion', async (c) => {
      await needsBrain(() => buildCompanion(store, c.req.param('id')), 'prepare airport notes');
      return c.json(state(c));
    });
    app.put('/api/travel/loyalty', async (c) => {
      upsertLoyalty(store, await read(c, loyaltyInput));
      return c.json(state(c));
    });
    app.delete('/api/travel/loyalty/:id', (c) => {
      if (!store.db.prepare('DELETE FROM loyalty_accounts WHERE id = ?').run(c.req.param('id')).changes) throw new NotFound('Account');
      return c.json(state(c));
    });
    // A screenshot (boarding pass, booking, the KrisFlyer or Bonvoy app) or pasted text.
    app.post('/api/travel/import', async (c) => {
      const type = c.req.header('content-type') ?? '';
      let text = '';
      let image: { data: Buffer; mime: string } | undefined;
      if (type.includes('multipart/form-data')) {
        const form = await c.req.formData();
        text = String(form.get('text') ?? '').slice(0, 20_000);
        image = await imageFrom(form);
      } else {
        text = (await read(c, z.object({ text: z.string().min(1).max(20_000) }))).text;
      }
      if (!text && !image) throw new Invalid('Add a screenshot or paste the confirmation');
      const x = await needsBrain(() => extractTravel(store, text, image), 'read bookings');
      const applied = applyExtraction(store.as('agent'), x, image ? 'screenshot' : 'paste', null);
      if (x.kind === 'none') throw new Invalid('Seldon could not find a booking or a loyalty balance in that.');
      return c.json({ ...state(c), imported: { segments: applied.segments.length, loyalty: applied.loyalty.map((a) => a.program), trips: applied.trips, cancellation: applied.cancellation } });
    });
  },
});
