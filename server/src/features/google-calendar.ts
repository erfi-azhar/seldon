// Google Calendar: let Seldon see when you are free and put appointments on your calendar.
//
// Google only lets an app write to a calendar through OAuth, with a client registered in a
// Google Cloud project. Terminus is yours rather than a hosted service, so you register your
// own client (Settings walks you through it) and sign in once; Terminus keeps the refresh
// token with its other secrets. It asks only for calendar events, not settings or sharing.
//
// Seldon gets two tools while it is connected: one to read your events between two dates,
// and one to add an event. Adding an event reaches outside Terminus and cannot be undone
// with a tap, so the tool tells Seldon to agree the details with you first.

import type { Context } from 'hono';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { registerToolSource, type ExternalTool } from '../agent/tools.ts';
import { read } from '../http.ts';
import { Invalid, type Store } from '../store.ts';
import type { IntegrationStatus } from '../../../shared/types.ts';
import { utcToZoned, validZone, zonedToUtc } from './airports.ts';
import { getIntegration, integrationStatus, removeIntegration, updateIntegration, type IntegrationRecord } from './integrations.ts';
import { registerFeature } from './registry.ts';

const ID = 'gcal';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const CALLBACK = '/api/integrations/gcal/callback';

const endpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com/calendar/v3',
};

/** Point Terminus at a stand-in Google (tests). */
export function setGoogleEndpointsForTests(base: string): void {
  endpoints.authorize = `${base}/o/oauth2/v2/auth`;
  endpoints.token = `${base}/token`;
  endpoints.revoke = `${base}/revoke`;
  endpoints.api = `${base}/calendar/v3`;
}

export class CalendarError extends Error {}

const configured = (rec: IntegrationRecord) => !!rec.secrets.refreshToken;
const status = (store: Store): IntegrationStatus => integrationStatus(store, ID, false, configured);

// ── OAuth ───────────────────────────────────────────────────────────────────

/** Where Google sends you back; it must be how you reach Terminus, and registered with the client. */
const redirectFor = (origin: string) => `${origin}${CALLBACK}`;
const originOf = (c: Context) => c.req.header('origin') ?? new URL(c.req.url).origin;

async function tokenRequest(params: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
  let res: Response;
  try {
    res = await fetch(endpoints.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  } catch {
    throw new CalendarError('Could not reach Google.');
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    if (body.error === 'invalid_grant') throw new CalendarError('Google no longer accepts this sign-in. Reconnect Google Calendar in Settings.');
    if (body.error === 'invalid_client') throw new CalendarError('Google did not recognise the client ID and secret.');
    throw new CalendarError(`Google refused: ${body.error_description || body.error || res.status}`);
  }
  return { access_token: body.access_token, expires_in: body.expires_in ?? 3600, refresh_token: body.refresh_token };
}

/** A current access token, refreshed when it is about to run out. */
async function accessToken(store: Store): Promise<string> {
  const rec = getIntegration(store, ID);
  if (!rec.secrets.refreshToken) throw new CalendarError('Google Calendar is not connected.');
  if (rec.secrets.accessToken && Number(rec.secrets.accessExpiresAt ?? 0) > Date.now() + 60_000) return rec.secrets.accessToken;
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: rec.secrets.refreshToken, client_id: String(rec.settings.clientId), client_secret: rec.secrets.clientSecret ?? '' });
    updateIntegration(store, ID, (r) => {
      r.secrets = { ...r.secrets, accessToken: t.access_token, accessExpiresAt: String(Date.now() + t.expires_in * 1000) };
      r.lastError = null;
    });
    return t.access_token;
  } catch (err) {
    updateIntegration(store, ID, (r) => (r.lastError = err instanceof Error ? err.message : String(err)));
    throw err;
  }
}

async function google<T>(store: Store, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const token = await accessToken(store);
  let res: Response;
  try {
    res = await fetch(`${endpoints.api}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch {
    throw new CalendarError('Could not reach Google Calendar.');
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new CalendarError(`Google Calendar said: ${json.error?.message ?? res.status}`);
  return json;
}

// ── Times ───────────────────────────────────────────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function zoneOf(store: Store): string {
  const tz = String(getIntegration(store, ID).settings.timeZone ?? '') || store.zone() || 'UTC';
  return validZone(tz) ? tz : 'UTC';
}

/** Wall-clock arithmetic on "YYYY-MM-DDTHH:MM" (or a date), staying in wall-clock terms. */
function addMinutes(local: string, minutes: number): string {
  return new Date(Date.parse(`${local.slice(0, 16)}:00Z`) + minutes * 60_000).toISOString().slice(0, 16);
}
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

interface GoogleTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}
interface GoogleEvent {
  id: string;
  summary?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  transparency?: string;
}

/** "Tue 18 Nov 10:00–11:00", in the calendar's zone. */
export function describeTimes(start: GoogleTime | undefined, end: GoogleTime | undefined, zone: string): string {
  const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  if (start?.date) {
    const last = end?.date ? addDays(end.date, -1) : start.date;
    return last > start.date ? `${day(start.date)} – ${day(last)} (all day)` : `${day(start.date)} (all day)`;
  }
  if (!start?.dateTime) return 'time unknown';
  const s = utcToZoned(new Date(start.dateTime), zone);
  const e = end?.dateTime ? utcToZoned(new Date(end.dateTime), zone) : null;
  return `${day(s.slice(0, 10))} ${s.slice(11, 16)}${e ? `–${e.slice(0, 10) === s.slice(0, 10) ? e.slice(11, 16) : `${day(e.slice(0, 10))} ${e.slice(11, 16)}`}` : ''}`;
}

// ── What Seldon can do ──────────────────────────────────────────────────────

const ListInput = z.object({
  from: z.string().regex(DATE).describe('First day, YYYY-MM-DD'),
  to: z.string().regex(DATE).describe('Last day, YYYY-MM-DD (inclusive). At most 31 days after from.'),
});

const CreateInput = z.object({
  title: z.string().min(1).max(200),
  start: z.string().describe('Local start, "YYYY-MM-DDTHH:MM", or "YYYY-MM-DD" for an all-day event'),
  end: z.string().optional().describe('Local end in the same form. Defaults to an hour after the start, or the same day for all-day events.'),
  location: z.string().max(300).optional(),
  description: z.string().max(4000).optional().describe('Notes for the event: what to bring, who it is with, a booking reference'),
  reminderMinutes: z.number().int().min(0).max(40_320).optional().describe('A pop-up reminder this many minutes before. Leave out for the calendar default.'),
});

export async function listEvents(store: Store, input: z.infer<typeof ListInput>, signal?: AbortSignal): Promise<string> {
  const { from, to } = ListInput.parse(input);
  if (to < from) throw new Invalid('"to" is before "from".');
  if (Date.parse(to) - Date.parse(from) > 31 * 86_400_000) throw new Invalid('Ask for at most 31 days at a time.');
  const zone = zoneOf(store);
  const q = new URLSearchParams({
    timeMin: zonedToUtc(`${from}T00:00`, zone).toISOString(),
    timeMax: zonedToUtc(`${addDays(to, 1)}T00:00`, zone).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '150',
  });
  const res = await google<{ items?: GoogleEvent[]; timeZone?: string }>(store, 'GET', `/calendars/primary/events?${q}`, undefined, signal);
  const events = (res.items ?? []).filter((e) => e.status !== 'cancelled');
  if (events.length === 0) return `No events between ${from} and ${to} (times in ${zone}).`;
  const lines = events.map((e) => `- ${describeTimes(e.start, e.end, zone)}: ${e.summary || '(no title)'}${e.location ? ` @ ${e.location}` : ''}${e.transparency === 'transparent' ? ' [shown as free]' : ''}`);
  return `Events between ${from} and ${to}, times in ${zone}:\n${lines.join('\n')}`;
}

export async function createEvent(store: Store, input: z.infer<typeof CreateInput>, signal?: AbortSignal): Promise<{ id: string; link: string; when: string }> {
  const e = CreateInput.parse(input);
  const zone = zoneOf(store);
  const allDay = DATE.test(e.start);
  if (!allDay && !DATETIME.test(e.start)) throw new Invalid('Give the start as "YYYY-MM-DDTHH:MM", or a date for an all-day event.');
  let start: GoogleTime;
  let end: GoogleTime;
  if (allDay) {
    const last = e.end && DATE.test(e.end) ? e.end : e.start;
    if (last < e.start) throw new Invalid('The event ends before it starts.');
    start = { date: e.start };
    end = { date: addDays(last, 1) };
  } else {
    const endLocal = e.end && DATETIME.test(e.end) ? e.end.slice(0, 16) : addMinutes(e.start, 60);
    if (endLocal <= e.start.slice(0, 16)) throw new Invalid('The event ends before it starts.');
    start = { dateTime: `${e.start.slice(0, 16)}:00`, timeZone: zone };
    end = { dateTime: `${endLocal}:00`, timeZone: zone };
  }
  const created = await google<GoogleEvent>(
    store,
    'POST',
    '/calendars/primary/events',
    {
      summary: e.title,
      location: e.location,
      description: e.description,
      start,
      end,
      ...(e.reminderMinutes === undefined ? {} : { reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: e.reminderMinutes }] } }),
    },
    signal,
  );
  const when = allDay ? describeTimes(start, end, zone) : describeTimes({ dateTime: zonedToUtc(start.dateTime!, zone).toISOString() }, { dateTime: zonedToUtc(end.dateTime!, zone).toISOString() }, zone);
  // It shows in the activity feed like anything else Seldon does, but lives in Google, so it
  // is removed there rather than with Undo.
  store.record('created', 'calendar_event', created.id, null, `Added to Google Calendar: ${e.title}, ${when}`);
  return { id: created.id, link: created.htmlLink ?? '', when };
}

function schemaOf(s: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(s) as Record<string, unknown>;
  return schema;
}

registerToolSource(async (store): Promise<ExternalTool[]> => {
  const rec = getIntegration(store, ID);
  if (!rec.enabled || !configured(rec)) return [];
  return [
    {
      name: 'google_calendar__list_events',
      description:
        "Read the user's Google Calendar between two dates: each event's day, times and title. Use it before suggesting or booking a time, so what you propose fits around what is already there. Event titles can come from other people's invitations.",
      schema: schemaOf(ListInput),
      run: async (input, ctx) => ({ data: await listEvents(ctx.store, input as z.infer<typeof ListInput>, ctx.signal), summary: 'Checked your calendar' }),
    },
    {
      name: 'google_calendar__create_event',
      description:
        "Add an event to the user's Google Calendar (their main calendar, in its own time zone). This writes outside Terminus and cannot be undone with a tap, so only call it once the user has agreed the title, day and time in this conversation — propose first, then add it when they say yes. Use it for appointments, consultations, calls and reminders tied to a time; put what to bring or a booking reference in the description.",
      schema: schemaOf(CreateInput),
      run: async (input, ctx) => {
        const out = await createEvent(ctx.store, input as z.infer<typeof CreateInput>, ctx.signal);
        return { data: { ok: true, when: out.when, link: out.link }, summary: `Added to your calendar: ${(input as { title: string }).title}` };
      },
    },
  ];
});

// ── Settings ────────────────────────────────────────────────────────────────

registerFeature({
  id: ID,
  integration: { configured },
  routes: (app, { store }) => {
    app.get('/api/integrations/gcal', (c) => c.json(status(store)));

    // Save your OAuth client and start signing in. Returns Google's sign-in page.
    app.put('/api/integrations/gcal', async (c) => {
      const input = await read(c, z.object({ clientId: z.string().trim().min(10).max(300), clientSecret: z.string().trim().max(300).optional() }));
      const current = getIntegration(store, ID);
      const secret = input.clientSecret || (current.settings.clientId === input.clientId ? current.secrets.clientSecret : undefined);
      if (!secret) throw new Invalid('Add the client secret Google gave you.');
      const state = randomBytes(24).toString('base64url');
      const redirectUrl = redirectFor(originOf(c));
      // A different client can't refresh the old client's tokens, so they go with it.
      const sameClient = current.settings.clientId === input.clientId;
      updateIntegration(store, ID, (r) => {
        r.settings = { ...(sameClient ? r.settings : {}), clientId: input.clientId, redirectUrl };
        r.secrets = { ...(sameClient ? r.secrets : {}), clientSecret: secret, state };
        r.lastError = null;
      });
      const url = new URL(endpoints.authorize);
      url.search = new URLSearchParams({
        client_id: input.clientId,
        redirect_uri: redirectUrl,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        // Without consent Google only gives a refresh token the first time you ever sign in.
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
      }).toString();
      return c.json({ authorizeUrl: url.toString() });
    });

    // Google's sign-in page sends you back here (a top-level navigation).
    app.get(CALLBACK, async (c) => {
      const back = (result: string) => c.redirect(`/settings?gcal=${encodeURIComponent(result)}#connections`, 302);
      const rec = getIntegration(store, ID);
      const code = c.req.query('code');
      if (!code || !rec.settings.clientId) return back('cancelled');
      if (!rec.secrets.state || c.req.query('state') !== rec.secrets.state) return back('failed');
      try {
        const t = await tokenRequest({
          grant_type: 'authorization_code',
          code,
          client_id: String(rec.settings.clientId),
          client_secret: rec.secrets.clientSecret ?? '',
          redirect_uri: String(rec.settings.redirectUrl),
        });
        const refreshToken = t.refresh_token ?? rec.secrets.refreshToken;
        if (!refreshToken) throw new CalendarError('Google did not give Terminus lasting access. Remove Terminus at myaccount.google.com/permissions and connect again.');
        updateIntegration(store, ID, (r) => {
          r.enabled = true;
          r.secrets = { clientSecret: r.secrets.clientSecret ?? '', refreshToken, accessToken: t.access_token, accessExpiresAt: String(Date.now() + t.expires_in * 1000) };
          r.lastError = null;
        });
        // Which calendar this is (its name is your address) and the zone it keeps time in.
        const now = new Date().toISOString();
        const cal = await google<{ summary?: string; timeZone?: string }>(store, 'GET', `/calendars/primary/events?maxResults=1&timeMin=${encodeURIComponent(now)}`);
        updateIntegration(store, ID, (r) => {
          r.settings = { ...r.settings, account: cal.summary ?? '', timeZone: cal.timeZone ?? '' };
          r.lastOkAt = new Date().toISOString();
        });
        return back('connected');
      } catch (err) {
        updateIntegration(store, ID, (r) => (r.lastError = err instanceof Error ? err.message : String(err)));
        return back('failed');
      }
    });

    app.delete('/api/integrations/gcal', async (c) => {
      const token = getIntegration(store, ID).secrets.refreshToken;
      // Tell Google to forget the access too; if it can't be reached, removing it here still stops Terminus.
      if (token) await fetch(`${endpoints.revoke}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => undefined);
      removeIntegration(store, ID);
      return c.json({ ok: true });
    });
  },
});
