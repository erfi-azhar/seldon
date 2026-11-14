// Calendar → Travel. Flight trackers such as Flighty keep each flight as an event in a
// calendar you choose, and move it when the time or gate changes. Neither Flighty nor
// most calendars offer an API, but Google Calendar and iCloud both publish a private
// iCalendar (.ics) address for a calendar. Terminus reads that address regularly and
// files each flight it finds onto the right trip, keeping its times in step.
//
// The address is a secret (anyone holding it can read the calendar), so it is kept with
// the other secrets: never sent to the browser, never exported, out of reach of tokens.
//
// Events are recognised by their flight number and route ("SQ 856 SIN → SZX"). An event
// that reads like a flight but not in a shape we know goes to the background brain, as
// untrusted text, with no tools. Flights you delete here stay deleted; a flight that
// disappears from the calendar is flagged, never removed for you.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NoBrain } from '../agent/think.ts';
import { read } from '../http.ts';
import { Invalid, type Store } from '../store.ts';
import type { Segment } from '../../../shared/types.ts';
import { airport, utcToZoned, validZone, zonedToUtc } from './airports.ts';
import { safeFetch } from './fetcher.ts';
import { getIntegration, integrationStatus, removeIntegration, updateIntegration, type IntegrationRecord } from './integrations.ts';
import { registerFeature } from './registry.ts';
import { addSignal } from './signals.ts';
import { extractTravel, fileSegment, travelSettings, updateSegment, type SegmentInput } from './travel.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const ID = 'calendar';
const DAY = 86_400_000;
const MAX_BRAIN_PER_RUN = 10;

// ── Reading iCalendar ───────────────────────────────────────────────────────

export interface Stamp {
  /** Wall-clock "YYYY-MM-DDTHH:MM" as written. */
  local: string;
  /** The IANA zone it was written in, when one was given and is known. */
  tz: string | null;
  /** Written in UTC ("…Z"). */
  utc: boolean;
  allDay: boolean;
}

export interface CalEvent {
  /** UID, plus RECURRENCE-ID for a changed occurrence of a repeating event. */
  key: string;
  summary: string;
  location: string;
  description: string;
  status: string;
  start: Stamp | null;
  end: Stamp | null;
}

const unescapeText = (v: string) => v.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

/** "Asia/Singapore", "/mozilla.org/20070129_1/Asia/Singapore" or a name Intl does not know. */
function zoneFrom(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const id = tzid.replace(/^"|"$/g, '');
  if (validZone(id) && id.includes('/')) return id;
  const tail = id.split('/').slice(-2).join('/');
  if (tail.includes('/') && validZone(tail)) return tail;
  const last3 = id.split('/').slice(-3).join('/');
  if (last3.split('/').length === 3 && validZone(last3)) return last3;
  return id === 'UTC' || id === 'GMT' ? 'UTC' : null;
}

function stampFrom(value: string, params: Record<string, string>): Stamp | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (!h) return { local: `${y}-${mo}-${d}T00:00`, tz: null, utc: false, allDay: true };
  return { local: `${y}-${mo}-${d}T${h}:${mi}`, tz: z ? null : zoneFrom(params.TZID), utc: !!z, allDay: false };
}

/** Split "NAME;PARAM=x;PARAM="a:b":value" at the first colon outside quotes. */
function splitLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) {
      const [name, ...rest] = line.slice(0, i).split(';');
      const params: Record<string, string> = {};
      for (const p of rest) {
        const eq = p.indexOf('=');
        if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
      }
      return { name: name!.toUpperCase(), params, value: line.slice(i + 1) };
    }
  }
  return null;
}

export function parseIcs(text: string): { name: string; events: CalEvent[] } {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Invalid('That link did not return a calendar.');
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events: CalEvent[] = [];
  let name = '';
  let cur: Row | null = null;
  let depth = 0; // VALARMs and the like nest inside events
  for (const line of lines) {
    const p = splitLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      if (p.value.toUpperCase() === 'VEVENT') {
        cur = { uid: '', recurrence: '', summary: '', location: '', description: '', status: '', start: null, end: null };
        depth = 0;
      } else if (cur) depth++;
      continue;
    }
    if (p.name === 'END') {
      if (p.value.toUpperCase() === 'VEVENT' && cur) {
        if (cur.uid) events.push({ key: cur.recurrence ? `${cur.uid}|${cur.recurrence}` : cur.uid, summary: cur.summary, location: cur.location, description: cur.description, status: cur.status, start: cur.start, end: cur.end });
        cur = null;
      } else if (cur && depth > 0) depth--;
      continue;
    }
    if (!cur) {
      if (p.name === 'X-WR-CALNAME') name = unescapeText(p.value).trim().slice(0, 80);
      continue;
    }
    if (depth > 0) continue;
    switch (p.name) {
      case 'UID':
        cur.uid = p.value.trim().slice(0, 300);
        break;
      case 'RECURRENCE-ID':
        cur.recurrence = p.value.trim();
        break;
      case 'SUMMARY':
        cur.summary = unescapeText(p.value).slice(0, 300);
        break;
      case 'LOCATION':
        cur.location = unescapeText(p.value).slice(0, 300);
        break;
      case 'DESCRIPTION':
        cur.description = unescapeText(p.value).slice(0, 4000);
        break;
      case 'STATUS':
        cur.status = p.value.trim().toUpperCase();
        break;
      case 'DTSTART':
        cur.start = stampFrom(p.value, p.params);
        break;
      case 'DTEND':
        cur.end = stampFrom(p.value, p.params);
        break;
    }
  }
  return { name, events };
}

/** The instant a stamp names; floating times are read in `fallback`. */
export function instant(s: Stamp, fallback: string): Date {
  if (s.utc) return new Date(`${s.local}:00Z`);
  return zonedToUtc(s.local, s.tz ?? fallback);
}

// ── Recognising flights ─────────────────────────────────────────────────────

// Airline codes always hold a letter. "SQ856" and "SQ 856"; a space only after two letters,
// so terminals and quarters ("T3 18:45", "Q4 2026") are not read as flights.
const NUMBER = [/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])(\d{1,4})\b(?!:)/, /\b([A-Z]{2}) (\d{1,4})\b(?!:)/];
const ROUTE = /\b([A-Z]{3})\b\s*(?:→|->|➝|➔|⇀|>|✈️?|–|—|-|to)\s*\b([A-Z]{3})\b/;

function findNumber(texts: string[]): { carrier: string; number: string } | null {
  for (const t of texts) {
    for (const re of NUMBER) {
      const m = re.exec(t);
      if (m) return { carrier: m[1]!, number: m[2]! };
    }
  }
  return null;
}

function findRoute(texts: string[]): { from: string; to: string } | null {
  for (const t of texts) {
    const m = ROUTE.exec(t);
    if (m && m[1] !== m[2] && (airport(m[1]!) || airport(m[2]!) || /✈|→|->|flight/i.test(t))) return { from: m[1]!, to: m[2]! };
  }
  return null;
}

const looksLikeFlight = (e: CalEvent) => /✈|\bflight\b|\bflug\b|\bvol\b/i.test(e.summary) || !!findNumber([e.summary]);

/** Confirmation, seat and cabin, when the event's notes say so plainly. */
function extras(text: string): Pick<SegmentInput, 'confirmation' | 'seat' | 'cabin'> {
  const out: Pick<SegmentInput, 'confirmation' | 'seat' | 'cabin'> = {};
  const conf = /(?:confirmation|reservation|booking|record locator|pnr)(?:\s*(?:code|number|no\.?|#|ref(?:erence)?))?\s*[:#]?\s*([A-Za-z0-9]{6})\b/i.exec(text);
  if (conf && /^[A-Z0-9]{6}$/.test(conf[1]!) && /[A-Z]/.test(conf[1]!)) out.confirmation = conf[1];
  const seat = /\bseat\s*[:#]?\s*(\d{1,2}[A-K])\b/i.exec(text);
  if (seat) out.seat = seat[1]!.toUpperCase();
  const cabin = /\b(premium economy|economy|business|first|suites)\s+class\b|\bcabin\s*[:#]?\s*(premium economy|economy|business|first|suites)\b/i.exec(text);
  if (cabin) {
    const c = (cabin[1] ?? cabin[2])!.toLowerCase();
    out.cabin = c.replace(/\b\w/g, (x) => x.toUpperCase());
  }
  return out;
}

/** A flight as Travel stores it: local times at each end, in each airport's own zone. */
export function buildFlight(e: CalEvent, f: { carrier: string; number: string; from: string; to: string }, homeTz: string): SegmentInput | null {
  if (!e.start || e.start.allDay) return null;
  const depTz = airport(f.from)?.tz ?? e.start.tz ?? homeTz;
  const floating = e.start.tz ?? depTz;
  const start = instant(e.start, depTz);
  const end = e.end && !e.end.allDay ? instant(e.end, e.end.tz ?? floating) : null;
  const arrTz = airport(f.to)?.tz ?? e.end?.tz ?? depTz;
  return {
    kind: 'flight',
    carrier: f.carrier,
    number: f.number,
    fromCode: f.from,
    toCode: f.to,
    startLocal: utcToZoned(start, depTz),
    startTz: depTz,
    endLocal: end && end > start ? utcToZoned(end, arrTz) : null,
    endTz: arrTz,
    ...extras(`${e.description}\n${e.location}`),
  };
}

/** The flight in an event by its own words, or null when it does not say plainly. */
export function flightFromEvent(e: CalEvent, homeTz: string): SegmentInput | null {
  const texts = [e.summary, e.location, e.description];
  const number = findNumber([e.summary, e.description]);
  const route = findRoute(texts);
  if (!number || !route) return null;
  return buildFlight(e, { ...number, ...route }, homeTz);
}

/** For events that read like a flight in a shape we do not know: ask the background brain. */
async function flightByBrain(store: Store, e: CalEvent, homeTz: string): Promise<SegmentInput | null> {
  const when = (s: Stamp | null) => (s ? `${s.local.replace('T', ' ')}${s.utc ? ' UTC' : s.tz ? ` (${s.tz})` : ''}` : 'not given');
  const x = await extractTravel(store, `A calendar event.\nTitle: ${e.summary}\nLocation: ${e.location}\nStarts: ${when(e.start)}\nEnds: ${when(e.end)}\nNotes:\n${e.description}`);
  const seg = x.segments.find((s) => s.kind === 'flight');
  if (!seg || !seg.number || !seg.from_code || !seg.to_code) return null;
  const carrier = seg.carrier.length <= 3 ? seg.carrier.toUpperCase() : (findNumber([e.summary])?.carrier ?? seg.carrier);
  // The event's own times are the ones the tracker keeps up to date.
  return buildFlight(e, { carrier, number: seg.number.replace(/^[A-Z]{2}/i, ''), from: seg.from_code.toUpperCase(), to: seg.to_code.toUpperCase() }, homeTz);
}

// ── Syncing ─────────────────────────────────────────────────────────────────

interface Seen {
  /** Hash of what the event said when it was last read. */
  h: string;
  /** The booking it became; null when it is not a flight. */
  seg: string | null;
  /** When it starts, for forgetting old events and noticing removed ones. */
  at: string;
  /** The booking was deleted here: leave it deleted. */
  dropped?: boolean;
}

type Fetcher = (url: string) => Promise<string>;
const defaultFetcher: Fetcher = async (url) => {
  const r = await safeFetch(url, { maxBytes: 10_000_000, timeoutMs: 25_000, accept: 'text/calendar,text/plain;q=0.9,*/*;q=0.5' });
  if (r.status === 404 || r.status === 403 || r.status === 401) throw new Invalid(`The calendar link answered ${r.status}. It may have been reset: copy the private address again.`);
  if (r.status !== 200) throw new Error(`The calendar answered ${r.status}`);
  return r.body.toString('utf8');
};
let fetchFeed: Fetcher = defaultFetcher;
/** Tests swap in a fake calendar. */
export function setCalendarFetcher(f: Fetcher | null): void {
  fetchFeed = f ?? defaultFetcher;
}

/** webcal:// links (iCloud's public calendars) are https underneath. */
export function feedUrl(raw: string): string {
  const s = raw.trim().replace(/^webcals?:\/\//i, 'https://');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Invalid('That is not a link. Paste the calendar’s private iCal address.');
  }
  if (u.protocol !== 'https:') throw new Invalid('Use the https (or webcal) address of the calendar.');
  return u.toString();
}

const hash = (e: CalEvent) => createHash('sha256').update(JSON.stringify([e.summary, e.location, e.description, e.status, e.start, e.end])).digest('hex').slice(0, 20);
const label = (s: Segment) => `${s.carrier} ${s.number}`.trim() || s.title;
const hhmm = (local: string) => local.slice(11, 16);
const dayOf = (local: string) => new Date(`${local.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function segmentRow(store: Store, id: string): Row | undefined {
  return store.db.prepare('SELECT * FROM trip_segments WHERE id = ?').get(id) as Row | undefined;
}

export interface SyncResult {
  added: number;
  updated: number;
  flights: number;
}

export async function syncCalendar(store: Store, now: Date = new Date()): Promise<SyncResult> {
  const rec = getIntegration(store, ID);
  const url = rec.secrets.url;
  if (!url) throw new Invalid('Add a calendar link first (Settings → Connections).');
  const feed = parseIcs(await fetchFeed(url));
  const homeTz = airport(travelSettings(store).homeAirport)?.tz ?? store.zone() ?? 'UTC';
  const seen = { ...((rec.state.events ?? {}) as Record<string, Seen>) };
  const t = now.getTime();
  const added: Segment[] = [];
  let updated = 0;
  let asked = 0;
  const keys = new Set(feed.events.map((e) => e.key));
  // In time order, so a trip's outbound flight is filed before its return.
  const ordered = feed.events.filter((e) => e.start && !e.start.allDay).sort((a, b) => instant(a.start!, a.start!.tz ?? homeTz).getTime() - instant(b.start!, b.start!.tz ?? homeTz).getTime());

  for (const e of ordered) {
    if (!e.start || e.start.allDay) continue;
    const startAt = instant(e.start, e.start.tz ?? homeTz).getTime();
    const endAt = e.end && !e.end.allDay ? instant(e.end, e.end.tz ?? e.start.tz ?? homeTz).getTime() : startAt;
    if (endAt < t - DAY || startAt > t + 400 * DAY) continue;
    const h = hash(e);
    const prev = seen[e.key];
    if (prev && prev.h === h) continue;

    if (e.status === 'CANCELLED') {
      if (prev?.seg && !prev.dropped) flagGone(store, prev.seg, 'is marked cancelled in your calendar');
      seen[e.key] = { h, seg: prev?.seg ?? null, at: new Date(startAt).toISOString(), dropped: prev?.dropped };
      continue;
    }

    let input = flightFromEvent(e, homeTz);
    if (!input && looksLikeFlight(e) && asked < MAX_BRAIN_PER_RUN) {
      asked++;
      try {
        input = await flightByBrain(store, e, homeTz);
      } catch (err) {
        // Without a brain, or with one that failed, try again on a later run.
        if (!(err instanceof NoBrain)) console.warn(`[${ID}] could not read “${e.summary.slice(0, 60)}”:`, err instanceof Error ? err.message : err);
        continue;
      }
    }
    const at = new Date(startAt).toISOString();
    if (!input) {
      seen[e.key] = { h, seg: null, at };
      continue;
    }

    try {
      if (prev?.seg) {
        // A flight already on file: follow the calendar, unless it was deleted here.
        const row = prev.dropped ? undefined : segmentRow(store, prev.seg);
        if (!row) {
          seen[e.key] = { ...prev, h, at, dropped: true };
          continue;
        }
        const after = updateSegment(store, prev.seg, input);
        updated++;
        noteMove(store, row, after);
        seen[e.key] = { h, seg: prev.seg, at };
        continue;
      }
      const filed = fileSegment(store, input, 'calendar', `calendar:${e.key}`.slice(0, 300), 'calendar');
      if (filed.created) added.push(filed.segment);
      // The same flight was already here (added by hand, or from mail): the calendar keeps its times current.
      else updateSegment(store, filed.segment.id, { startLocal: input.startLocal, startTz: input.startTz, endLocal: input.endLocal, endTz: input.endTz });
      seen[e.key] = { h, seg: filed.segment.id, at };
    } catch (err) {
      console.warn(`[${ID}] could not file “${e.summary.slice(0, 60)}”:`, err instanceof Error ? err.message : err);
      seen[e.key] = { h, seg: null, at };
    }
  }

  // Flights still to come that left the calendar. An empty feed is more likely a hiccup than a clear-out.
  for (const [key, s] of Object.entries(seen)) {
    const when = Date.parse(s.at);
    if (when < t - 30 * DAY) {
      delete seen[key];
      continue;
    }
    if (keys.has(key) || !feed.events.length) continue;
    if (s.seg && !s.dropped && when > t && segmentRow(store, s.seg)) flagGone(store, s.seg, 'is no longer in your calendar');
    delete seen[key];
  }

  if (added.length) {
    const names = added.slice(0, 3).map(label).join(', ') + (added.length > 3 ? ` and ${added.length - 3} more` : '');
    addSignal(store, {
      source: ID,
      kind: 'booking',
      externalId: `added:${now.toISOString()}`,
      title: `Added ${names} from your calendar`,
      body: added.map((s) => `${label(s)} ${s.fromCode} → ${s.toCode}, ${dayOf(s.startLocal)} ${hhmm(s.startLocal)}`).join('\n'),
      sphereId: store.listSpheres().find((x) => x.key === 'travels')?.id ?? null,
      priority: 1,
      data: { tripId: added[0]!.tripId },
    });
  }

  const flights = Object.values(seen).filter((s) => s.seg && !s.dropped && Date.parse(s.at) > t).length;
  updateIntegration(store, ID, (r) => {
    r.state = { ...r.state, events: seen };
    r.settings = { ...r.settings, name: feed.name || r.settings.name || '', flights };
  });
  return { added: added.length, updated, flights };
}

/** A synced flight whose departure moved by five minutes or more. */
function noteMove(store: Store, before: Row, after: Segment): void {
  if (Math.abs(Date.parse(after.startUtc) - Date.parse(before.start_utc)) < 5 * 60_000) return;
  const sameDay = after.startLocal.slice(0, 10) === String(before.start_local).slice(0, 10);
  addSignal(store, {
    source: ID,
    kind: 'flight-change',
    externalId: `moved:${after.id}:${after.startUtc}`,
    title: `${label(after)} now leaves ${sameDay ? '' : `${dayOf(after.startLocal)} `}${hhmm(after.startLocal)} (was ${hhmm(before.start_local)})`,
    body: `Updated from your calendar. ${after.fromCode} → ${after.toCode}${after.endLocal ? `, arriving ${hhmm(after.endLocal)}` : ''}.`,
    sphereId: store.listSpheres().find((x) => x.key === 'travels')?.id ?? null,
    priority: 2,
    data: { tripId: after.tripId, segmentId: after.id },
  });
}

function flagGone(store: Store, segmentId: string, why: string): void {
  const r = segmentRow(store, segmentId);
  if (!r) return;
  addSignal(store, {
    source: ID,
    kind: 'cancellation',
    externalId: `gone:${segmentId}`,
    title: `${`${r.carrier} ${r.number}`.trim() || r.title} on ${dayOf(r.start_local)} ${why}`,
    body: 'If the flight was cancelled or changed, remove it from the trip. Terminus leaves bookings in place until you do.',
    sphereId: store.listSpheres().find((x) => x.key === 'travels')?.id ?? null,
    priority: 2,
    data: { tripId: r.trip_id, segmentId },
  });
}

// ── Feature ─────────────────────────────────────────────────────────────────

const configured = (r: IntegrationRecord) => !!r.secrets.url;

registerFeature({
  id: ID,
  integration: { configured },
  jobs: [{ id: ID, everyMs: 15 * 60_000, run: async (store) => void (await syncCalendar(store)) }],
  routes: (app, { store, scheduler }) => {
    app.get('/api/integrations/calendar', (c) => c.json(integrationStatus(store, ID, scheduler.isRunning(ID), configured)));
    app.put('/api/integrations/calendar', async (c) => {
      const url = feedUrl((await read(c, z.object({ url: z.string().min(8).max(2000) }))).url);
      let name = '';
      try {
        name = parseIcs(await fetchFeed(url)).name;
      } catch (err) {
        if (err instanceof Invalid) throw new Invalid(`${err.message} Use the calendar’s private iCal address (it usually ends in .ics).`);
        throw new Invalid(`Could not read that calendar: ${err instanceof Error ? err.message : String(err)}`);
      }
      updateIntegration(store, ID, (r) => {
        const same = r.secrets.url === url;
        if (!same) r.state = {};
        r.enabled = true;
        r.secrets = { url };
        r.settings = { host: new URL(url).hostname, name, flights: same ? (r.settings.flights ?? 0) : 0 };
        r.lastError = null;
      });
      void scheduler.runNow(ID).catch(() => undefined);
      return c.json(integrationStatus(store, ID, scheduler.isRunning(ID), configured));
    });
    app.delete('/api/integrations/calendar', (c) => {
      removeIntegration(store, ID);
      return c.json({ ok: true });
    });
  },
});
