// Journey: what happens on a travel day. Your phone's tracker app (OwnTracks) reports where you
// are while a trip is on, so the trip remembers the route you took; and each phase of a travel day
// (time to leave, boarding, landing on the way, arrival) reaches your lock screen as a push
// notification. The phases themselves come from shared/journey.ts.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import webpush from 'web-push';
import { z } from 'zod';
import { read } from '../http.ts';
import { addDays, Invalid, localDate, newId, NotFound, nowIso, type Store } from '../store.ts';
import { journeyNotices, journeys, type JourneyNotice } from '../../../shared/journey.ts';
import type { JourneyStatus, Segment, TripTrack } from '../../../shared/types.ts';
import { updateIntegration } from './integrations.ts';
import { registerFeature } from './registry.ts';
import { listTrips } from './travel.ts';

const ID = 'journey';
const MIN = 60_000;
type Row = Record<string, unknown>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function setting<T>(store: Store, key: string): T | undefined {
  const r = store.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as T) : undefined;
}
function saveSetting(store: Store, key: string, value: unknown): void {
  store.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}
function dropSetting(store: Store, key: string): void {
  store.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

// ── Route recording (OwnTracks) ─────────────────────────────────────────────

/** A new key for the tracker app, replacing any old one. Shown once; only its hash is kept. */
export function newTrackKey(store: Store): string {
  const key = `tt_${randomBytes(24).toString('base64url')}`;
  saveSetting(store, 'track_key', sha(key));
  return key;
}

/**
 * True when a request carries the tracker key. OwnTracks signs in with a username and password
 * (HTTP Basic); the password is the key and the username can be anything.
 */
export function hasTrackKey(store: Store, c: Context): boolean {
  const header = c.req.header('authorization') ?? '';
  const basic = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/)?.[1];
  let key: string | undefined;
  if (basic) {
    const decoded = Buffer.from(basic, 'base64').toString('utf8');
    key = decoded.slice(decoded.indexOf(':') + 1);
  } else key = header.match(/^Bearer\s+(tt_[A-Za-z0-9_-]+)$/)?.[1];
  if (!key || !key.startsWith('tt_')) return false;
  const want = setting<string>(store, 'track_key');
  if (!want) return false;
  const a = Buffer.from(want);
  const b = Buffer.from(sha(key));
  return a.length === b.length && timingSafeEqual(a, b);
}

const ownTracksLocation = z.object({
  _type: z.literal('location'),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  tst: z.number().int().positive(),
  acc: z.number().optional(),
  alt: z.number().optional(),
  vel: z.number().optional(),
});

/** The trip a moment belongs to: one under way that day (a day's margin either side for travel days). */
function tripAt(store: Store, at: Date): string | null {
  const day = at.toISOString().slice(0, 10);
  const r = store.db
    .prepare('SELECT id FROM trips WHERE start_date <= ? AND end_date >= ? ORDER BY (start_date <= ? AND end_date >= ?) DESC, start_date DESC LIMIT 1')
    .get(addDays(day, 1), addDays(day, -1), day, day) as { id: string } | undefined;
  return r?.id ?? null;
}

/** Metres between two points. */
function metres(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * Keep a reported location if a trip is on at that moment; anything sent outside a trip is
 * dropped, so the app records journeys, not everyday life. Points hardly moved from the last one
 * within ten minutes are skipped.
 */
export function recordLocation(store: Store, msg: unknown): 'kept' | 'skipped' | 'no-trip' | 'ignored' {
  const p = ownTracksLocation.safeParse(msg);
  if (!p.success) return 'ignored';
  const at = new Date(p.data.tst * 1000);
  const tripId = tripAt(store, at);
  if (!tripId) return 'no-trip';
  const last = store.db.prepare('SELECT at, lat, lon FROM trip_track WHERE trip_id = ? AND at <= ? ORDER BY at DESC LIMIT 1').get(tripId, at.toISOString()) as
    | { at: string; lat: number; lon: number }
    | undefined;
  if (last && at.getTime() - Date.parse(last.at) < 10 * MIN && metres([last.lat, last.lon], [p.data.lat, p.data.lon]) < 25) return 'skipped';
  store.db
    .prepare('INSERT OR IGNORE INTO trip_track (trip_id, at, lat, lon, acc, alt, vel) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tripId, at.toISOString(), p.data.lat, p.data.lon, p.data.acc ?? null, p.data.alt ?? null, p.data.vel ?? null);
  saveSetting(store, 'track_last', at.toISOString());
  return 'kept';
}

/**
 * A trip's recorded route, day by day. A day runs by the sun where the point was (longitude / 15
 * hours from UTC), near enough to local time without knowing the zone. Long days are thinned.
 */
export function tripTrack(store: Store, tripId: string): TripTrack {
  const rows = store.db.prepare('SELECT at, lat, lon FROM trip_track WHERE trip_id = ? ORDER BY at').all(tripId) as { at: string; lat: number; lon: number }[];
  const byDay = new Map<string, [number, number, number][]>();
  for (const r of rows) {
    const t = Date.parse(r.at);
    const day = new Date(t + Math.round(r.lon / 15) * 3_600_000).toISOString().slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push([r.lat, r.lon, t]);
    byDay.set(day, list);
  }
  const days = [...byDay.entries()].map(([date, pts]) => {
    let km = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = metres([pts[i - 1]![0], pts[i - 1]![1]], [pts[i]![0], pts[i]![1]]);
      // A jump of hundreds of kilometres is a flight with the phone off, not ground covered.
      if (d < 300_000) km += d / 1000;
    }
    const step = Math.ceil(pts.length / 800);
    const points = step > 1 ? pts.filter((_, i) => i % step === 0 || i === pts.length - 1) : pts;
    return { date, points, km: Math.round(km * 10) / 10 };
  });
  return { days, points: rows.length };
}

// ── Push notifications ──────────────────────────────────────────────────────

interface Vapid {
  publicKey: string;
  privateKey: string;
}

function vapid(store: Store): Vapid {
  const have = setting<Vapid>(store, 'push_vapid');
  if (have) return have;
  const keys = webpush.generateVAPIDKeys();
  saveSetting(store, 'push_vapid', keys);
  return keys;
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

type Sender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, store: Store) => Promise<void>;

const webPushSender: Sender = async (sub, payload, store) => {
  const keys = vapid(store);
  const subject = setting<string>(store, 'push_subject') ?? 'https://localhost';
  await webpush.sendNotification(sub, payload, { vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600, urgency: 'high' });
};
let sender: Sender = webPushSender;
/** Tests swap the push service out. */
export function setPushSender(s: Sender | null): void {
  sender = s ?? webPushSender;
}

/** Send to every subscribed device; devices the push service no longer knows are forgotten. */
export async function pushAll(store: Store, msg: PushMessage): Promise<number> {
  const subs = store.db.prepare('SELECT * FROM push_subscriptions').all() as Row[];
  let sent = 0;
  for (const s of subs) {
    try {
      await sender({ endpoint: String(s.endpoint), keys: { p256dh: String(s.p256dh), auth: String(s.auth) } }, JSON.stringify(msg), store);
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) store.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(String(s.id));
    }
  }
  return sent;
}

/** All flights on recent and coming trips. */
function allFlights(store: Store, now: Date): Segment[] {
  return listTrips(store, addDays(localDate(now), -2)).flatMap((t) => t.segments.filter((s) => s.kind === 'flight'));
}

/**
 * Send the travel-day notifications that are due: each once, and only within 45 minutes of its
 * moment, so a server that was asleep doesn't send a stale "leave now" hours late.
 */
export async function sendDueNotices(store: Store, now: Date = new Date()): Promise<JourneyNotice[]> {
  if (!(store.db.prepare('SELECT 1 FROM push_subscriptions LIMIT 1').get() as unknown)) return [];
  const t = now.getTime();
  const due = journeys(allFlights(store, now))
    .flatMap((legs) => journeyNotices(legs))
    .filter((n) => n.at <= t && t < n.at + 45 * MIN)
    .filter((n) => !store.db.prepare('SELECT 1 FROM push_sent WHERE key = ?').get(n.key));
  for (const n of due) {
    store.db.prepare('INSERT OR IGNORE INTO push_sent (key, sent_at) VALUES (?, ?)').run(n.key, nowIso());
    await pushAll(store, { title: n.title, body: n.body, url: n.url, tag: n.key });
  }
  return due;
}

export function journeyStatus(store: Store): JourneyStatus {
  const devices = store.db.prepare('SELECT label, created_at FROM push_subscriptions ORDER BY created_at').all() as { label: string; created_at: string }[];
  return {
    push: { publicKey: vapid(store).publicKey, devices: devices.map((d) => ({ label: d.label, since: d.created_at })) },
    tracking: { on: !!setting<string>(store, 'track_key'), lastAt: setting<string>(store, 'track_last') ?? null },
  };
}

const subscription = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  label: z.string().max(80).optional(),
});

registerFeature({
  id: ID,
  tables: ['trip_track'],
  integration: { configured: () => true },
  jobs: [{ id: ID, everyMs: 60_000, run: async (store) => void (await sendDueNotices(store)) }],
  routes: (app, { store }) => {
    app.get('/api/journey/status', (c) => c.json(journeyStatus(store)));

    // OwnTracks posts each location here; it expects a JSON array back (messages for the phone).
    app.post('/api/journey/owntracks', async (c) => {
      const body = (await c.req.json().catch(() => null)) as unknown;
      for (const msg of Array.isArray(body) ? body : [body]) recordLocation(store, msg);
      return c.json([]);
    });
    app.post('/api/journey/tracking/key', (c) => c.json({ key: newTrackKey(store), status: journeyStatus(store) }));
    app.post('/api/journey/tracking/off', (c) => {
      dropSetting(store, 'track_key');
      return c.json(journeyStatus(store));
    });
    app.get('/api/journey/trips/:id/track', (c) => {
      const id = c.req.param('id');
      if (!store.db.prepare('SELECT 1 FROM trips WHERE id = ?').get(id)) throw new NotFound('Trip');
      return c.json(tripTrack(store, id));
    });

    app.post('/api/journey/push/subscribe', async (c) => {
      const sub = await read(c, subscription);
      // The push service wants a way to reach whoever runs the server: this server's own address.
      const origin = c.req.header('origin');
      if (origin?.startsWith('https://')) saveSetting(store, 'push_subject', origin);
      store.db
        .prepare(
          'INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label',
        )
        .run(newId(), sub.endpoint, sub.keys.p256dh, sub.keys.auth, sub.label ?? '', nowIso());
      updateIntegration(store, ID, (r) => {
        r.enabled = true;
      });
      return c.json(journeyStatus(store), 201);
    });
    app.post('/api/journey/push/unsubscribe', async (c) => {
      const { endpoint } = await read(c, z.object({ endpoint: z.string().max(1000) }));
      store.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
      return c.json(journeyStatus(store));
    });
    app.post('/api/journey/push/test', async (c) => {
      const sent = await pushAll(store, { title: 'Travel notifications are on', body: 'Terminus will tell you when to leave, when you board and when you land.', url: '/', tag: 'test' });
      if (!sent) throw new Invalid('No device is subscribed, or the push service turned the message away.');
      return c.json({ sent });
    });
  },
});
