// A travel day as phases: before you leave, at the airport, in the air (and any connections),
// then arrived. Shared by the web, which shows where you are in it, and the server, which sends
// a notification as each phase comes round. Times come from the bookings alone.

import type { Segment } from './types.ts';

export type PhaseKind = 'before' | 'airport' | 'flight' | 'connection' | 'arrived';

export interface Phase {
  kind: PhaseKind;
  /** When the phase starts, as an instant (ISO). */
  at: string;
  /** The zone its time is shown in: the airport where it happens. */
  tz: string;
  label: string;
  /** The flight it belongs to (for a connection, the one landing). */
  leg: number;
}

export interface Journey {
  legs: Segment[];
  phases: Phase[];
  /** The phase you are in now: -1 before the first one starts. */
  current: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const ms = (iso: string) => Date.parse(iso);

/** A flight within one country (by its two ends sharing a zone), which needs less time at the airport. */
const domestic = (f: Segment) => !!f.startTz && f.startTz === f.endTz;

/** When to be at the airport: two and a half hours before an international flight, an hour and a half before a domestic one. */
export const reachAirportBy = (f: Segment): number => ms(f.startUtc) - (domestic(f) ? 90 : 150) * MIN;

/** When to set off: an hour before you need to be there. */
export const leaveBy = (f: Segment): number => reachAirportBy(f) - HOUR;

/** When a flight really leaves and lands: the booked times plus any delay. */
export const delayOf = (f: Segment): number => Math.max(0, f.delayMin ?? 0) * MIN;
export const departs = (f: Segment): number => ms(f.startUtc) + delayOf(f);
export const lands = (f: Segment): number => ms(f.endUtc) + delayOf(f);

/**
 * Check-in (bag drop) closes an hour before departure. Reaching the airport and check-in keep to
 * the booked time even when a flight is late, since a delay can shrink; boarding follows the delay.
 */
export const checkInCloses = (f: Segment): number => ms(f.startUtc) - HOUR;

/** Boarding: about 45 minutes before a long flight, 30 before a short one. */
export const boardsAt = (f: Segment): number => departs(f) - (ms(f.endUtc) - ms(f.startUtc) > 6 * HOUR ? 45 : 30) * MIN;

/**
 * Flights strung into journeys: each one leaving from where the last landed, less than a day later.
 * Flights may come from different trips (home from one, straight on to the next).
 */
export function journeys(segments: Segment[]): Segment[][] {
  const seen = new Set<string>();
  const flights = segments
    .filter((s) => s.kind === 'flight' && s.startUtc && s.endUtc && !seen.has(s.id) && (seen.add(s.id), true))
    .sort((a, b) => ms(a.startUtc) - ms(b.startUtc));
  const out: Segment[][] = [];
  for (const f of flights) {
    // Join the journey this flight connects from, even if an unrelated flight came in between.
    const joins = (j: Segment[]) => {
      const prev = j[j.length - 1]!;
      const gap = ms(f.startUtc) - ms(prev.endUtc);
      return !!prev.toCode && prev.toCode === f.fromCode && gap > 0 && gap < 24 * HOUR;
    };
    const j = [...out].reverse().find(joins);
    if (j) j.push(f);
    else out.push([f]);
  }
  return out.sort((a, b) => ms(a[0]!.startUtc) - ms(b[0]!.startUtc));
}

const place = (s: Segment, end: 'from' | 'to') => (end === 'from' ? s.fromCity || s.fromName || s.fromCode : s.toCity || s.toName || s.toCode);

/** The phases of one journey, in order. */
export function journeyPhases(legs: Segment[]): Phase[] {
  const first = legs[0]!;
  const last = legs[legs.length - 1]!;
  const iso = (t: number) => new Date(t).toISOString();
  const phases: Phase[] = [
    { kind: 'before', at: iso(leaveBy(first)), tz: first.startTz, label: 'Before you leave', leg: 0 },
    { kind: 'airport', at: iso(reachAirportBy(first)), tz: first.startTz, label: 'At the airport', leg: 0 },
  ];
  legs.forEach((f, i) => {
    phases.push({ kind: 'flight', at: iso(departs(f)), tz: f.startTz, label: legs.length > 1 ? `In flight · ${`${f.carrier} ${f.number}`.trim()}` : 'In flight', leg: i });
    if (i < legs.length - 1) phases.push({ kind: 'connection', at: iso(lands(f)), tz: f.endTz, label: `Connecting in ${place(f, 'to')}`, leg: i });
  });
  phases.push({ kind: 'arrived', at: iso(lands(last)), tz: last.endTz, label: 'Arrived', leg: legs.length - 1 });
  return phases;
}

/**
 * The journey under way at a moment, if any: from 18 hours before the first flight leaves until
 * 6 hours after the last one lands.
 */
export function activeJourney(segments: Segment[], now: number): Journey | null {
  for (const legs of journeys(segments)) {
    const start = ms(legs[0]!.startUtc) - 18 * HOUR;
    const end = lands(legs[legs.length - 1]!) + 6 * HOUR;
    if (now < start || now > end) continue;
    const phases = journeyPhases(legs);
    let current = -1;
    phases.forEach((p, i) => {
      if (ms(p.at) <= now) current = i;
    });
    return { legs, phases, current };
  }
  return null;
}

/** "14:05" in a zone. */
export function clock(at: number, tz: string): string {
  try {
    return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || undefined });
  } catch {
    return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
}

/** "1h 37m" or "25m". */
export function span(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

export interface JourneyNotice {
  /** Stable per flight and moment, so each is sent once. */
  key: string;
  at: number;
  title: string;
  body: string;
  /** Where tapping it should open. */
  url: string;
}

/** The notifications a journey sends: time to leave, boarding, each landing on the way, arrival. */
export function journeyNotices(legs: Segment[]): JourneyNotice[] {
  const first = legs[0]!;
  const last = legs[legs.length - 1]!;
  const name = (f: Segment) => `${f.carrier} ${f.number}`.trim();
  const url = (f: Segment) => (f.tripId ? `/trips/${f.tripId}` : '/');
  const out: JourneyNotice[] = [
    {
      key: `${first.id}:leave`,
      at: leaveBy(first) - 15 * MIN,
      title: `Leave for ${place(first, 'from')} airport by ${clock(leaveBy(first), first.startTz)}`,
      body: `Reach ${first.fromName || first.fromCode} by ${clock(reachAirportBy(first), first.startTz)} for ${name(first)} at ${clock(ms(first.startUtc), first.startTz)}.`,
      url: url(first),
    },
  ];
  legs.forEach((f, i) => {
    out.push({
      key: `${f.id}:boarding`,
      at: boardsAt(f) - 15 * MIN,
      title: `${name(f)} boards around ${clock(boardsAt(f), f.startTz)}`,
      body: `To ${place(f, 'to')}, leaving ${clock(ms(f.startUtc), f.startTz)}. The gate is on your boarding pass.`,
      url: url(f),
    });
    const next = legs[i + 1];
    if (next) {
      out.push({
        key: `${f.id}:landed`,
        at: ms(f.endUtc) + 10 * MIN,
        title: `Landed in ${place(f, 'to')}: ${span((ms(next.startUtc) - ms(f.endUtc)) / MIN)} until ${name(next)}`,
        body: `It's ${clock(ms(f.endUtc) + 10 * MIN, f.endTz)} there. ${name(next)} to ${place(next, 'to')} leaves ${clock(ms(next.startUtc), next.startTz)}; open Terminus for the lounges.`,
        url: url(next),
      });
    }
  });
  out.push({
    key: `${last.id}:arrived`,
    at: ms(last.endUtc) + 10 * MIN,
    title: `Welcome to ${place(last, 'to')}`,
    body: `It's ${clock(ms(last.endUtc) + 10 * MIN, last.endTz)} there.`,
    url: url(last),
  });
  return out;
}
