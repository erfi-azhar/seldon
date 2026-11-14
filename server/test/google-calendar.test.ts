import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { refusal } from '../src/access.ts';
import { openDb } from '../src/db.ts';
import { getIntegration, updateIntegration } from '../src/features/integrations.ts';
import { describeTimes, setGoogleEndpointsForTests } from '../src/features/google-calendar.ts';
import { toolbox } from '../src/agent/tools.ts';
import { Store } from '../src/store.ts';

// A stand-in for Google's token endpoint and Calendar API.
interface Seen {
  method: string;
  path: string;
  auth: string;
  body: string;
}
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function fakeGoogle() {
  const seen: Seen[] = [];
  let tokens = 0;
  const events: Record<string, unknown>[] = [
    { id: 'e1', summary: 'Team stand-up', start: { dateTime: '2026-11-17T01:00:00Z' }, end: { dateTime: '2026-11-17T01:30:00Z' } },
    { id: 'e2', summary: 'Public holiday', start: { date: '2026-11-18' }, end: { date: '2026-11-19' } },
    { id: 'e3', summary: 'Cancelled thing', status: 'cancelled', start: { dateTime: '2026-11-18T02:00:00Z' }, end: { dateTime: '2026-11-18T03:00:00Z' } },
  ];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ method: req.method ?? '', path: url.pathname + url.search, auth: String(req.headers.authorization ?? ''), body });
      const json = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (url.pathname === '/token') {
        const p = new URLSearchParams(body);
        if (p.get('client_secret') !== 'shh') return json(401, { error: 'invalid_client' });
        if (p.get('grant_type') === 'authorization_code' && p.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' });
        tokens++;
        return json(200, { access_token: `at-${tokens}`, expires_in: 3600, ...(p.get('grant_type') === 'authorization_code' ? { refresh_token: 'rt-1' } : {}) });
      }
      if (url.pathname === '/revoke') return json(200, {});
      if (url.pathname === '/calendar/v3/calendars/primary/events') {
        if (!req.headers.authorization?.startsWith('Bearer at-')) return json(401, { error: { message: 'Invalid Credentials' } });
        if (req.method === 'POST') {
          const e = { id: `new-${events.length}`, htmlLink: 'https://calendar.google.com/event?eid=x', ...(JSON.parse(body) as object) };
          events.push(e);
          return json(200, e);
        }
        return json(200, { summary: 'sam@example.com', timeZone: 'Asia/Singapore', items: events });
      }
      json(404, { error: { message: 'Not found' } });
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setGoogleEndpointsForTests(base);
  return { seen, events };
}

function setup() {
  const db = openDb(':memory:');
  const app = createApp({ db });
  const store = new Store(db);
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['health'] });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`http://localhost:4321${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
  return { store, call };
}

async function connect(call: ReturnType<typeof setup>['call']) {
  const res = await call('PUT', '/api/integrations/gcal', { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'shh' });
  assert.equal(res.status, 200);
  const authorize = new URL(((await res.json()) as { authorizeUrl: string }).authorizeUrl);
  return authorize;
}

test('signing in: Google sends you back, and Terminus keeps lasting access', async () => {
  const google = await fakeGoogle();
  const { store, call } = setup();
  assert.equal(((await (await call('GET', '/api/integrations/gcal')).json()) as { configured: boolean }).configured, false);
  assert.deepEqual(await toolbox(store).then((t) => t.specs.filter((s) => s.name.startsWith('google_calendar')).length), 0, 'no tools until connected');

  const authorize = await connect(call);
  assert.equal(authorize.searchParams.get('redirect_uri'), 'http://localhost:4321/api/integrations/gcal/callback');
  assert.equal(authorize.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.events', 'events only');
  assert.equal(authorize.searchParams.get('access_type'), 'offline');
  const state = authorize.searchParams.get('state')!;

  // A forged return is refused.
  const forged = await call('GET', `/api/integrations/gcal/callback?code=good-code&state=nope`);
  assert.match(forged.headers.get('location')!, /gcal=failed/);

  const back = await call('GET', `/api/integrations/gcal/callback?code=good-code&state=${state}`);
  assert.equal(back.status, 302);
  assert.match(back.headers.get('location')!, /\/settings\?gcal=connected#connections/);
  const status = (await (await call('GET', '/api/integrations/gcal')).json()) as { configured: boolean; settings: Record<string, string> };
  assert.equal(status.configured, true);
  assert.equal(status.settings.account, 'sam@example.com');
  assert.equal(status.settings.timeZone, 'Asia/Singapore');
  assert.ok(!JSON.stringify(status).includes('rt-1') && !JSON.stringify(status).includes('shh'), 'secrets never reach the browser');

  const exchange = google.seen.find((s) => s.path === '/token')!;
  assert.match(exchange.body, /redirect_uri=http%3A%2F%2Flocalhost%3A4321%2Fapi%2Fintegrations%2Fgcal%2Fcallback/);

  const names = (await toolbox(store)).specs.map((s) => s.name).filter((n) => n.startsWith('google_calendar'));
  assert.deepEqual(names.sort(), ['google_calendar__create_event', 'google_calendar__list_events']);

  // Access tokens never reach this part of Terminus.
  const token = { id: 't', name: 'x', scope: 'write' as const, createdAt: '', expiresAt: null, lastUsedAt: null };
  assert.ok(refusal(token, 'PUT', '/api/integrations/gcal'));
  assert.ok(refusal(token, 'GET', '/api/integrations/gcal/callback'));

  assert.equal((await call('DELETE', '/api/integrations/gcal')).status, 200);
  assert.ok(google.seen.some((s) => s.path.startsWith('/revoke?token=rt-1')), 'Google is told to forget the access');
  assert.equal(getIntegration(store, 'gcal').secrets.refreshToken, undefined);
});

test('Seldon reads the week and adds an appointment, in the calendar\'s own time zone', async () => {
  const google = await fakeGoogle();
  const { store, call } = setup();
  const authorize = await connect(call);
  await call('GET', `/api/integrations/gcal/callback?code=good-code&state=${authorize.searchParams.get('state')}`);
  const tools = await toolbox(store);
  const agent = store.as('agent');

  const listed = await tools.run('google_calendar__list_events', { from: '2026-11-16', to: '2026-11-22' }, { store: agent, today: '2026-11-14' });
  assert.equal(listed.isError, false);
  assert.match(listed.content, /<untrusted source="google_calendar__list_events">/, 'event titles are outside text');
  assert.match(listed.content, /Tue 17 Nov 09:00–09:30: Team stand-up/, 'shown in Singapore time');
  assert.match(listed.content, /Wed 18 Nov \(all day\): Public holiday/);
  assert.doesNotMatch(listed.content, /Cancelled thing/);
  const query = new URL(`http://x${google.seen.findLast((s) => s.method === 'GET')!.path}`).searchParams;
  assert.equal(query.get('timeMin'), '2026-11-15T16:00:00.000Z', 'midnight on the 16th in Singapore');
  assert.equal(query.get('timeMax'), '2026-11-22T16:00:00.000Z', 'through the end of the 22nd');

  const made = await tools.run(
    'google_calendar__create_event',
    { title: 'Surgeon consultation (gallbladder)', start: '2026-11-19T10:30', location: 'Hepatobiliary clinic', description: 'Bring both ultrasound reports', reminderMinutes: 1440 },
    { store: agent, today: '2026-11-14' },
  );
  assert.equal(made.isError, false, made.content);
  assert.match(made.summary, /Added to your calendar: Surgeon consultation/);
  const posted = JSON.parse(google.seen.findLast((s) => s.method === 'POST' && s.path.includes('/events'))!.body) as Record<string, unknown>;
  assert.deepEqual(posted.start, { dateTime: '2026-11-19T10:30:00', timeZone: 'Asia/Singapore' });
  assert.deepEqual(posted.end, { dateTime: '2026-11-19T11:30:00', timeZone: 'Asia/Singapore' }, 'an hour by default');
  assert.deepEqual(posted.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 1440 }] });
  assert.equal(posted.description, 'Bring both ultrasound reports');
  const feed = store.listActivity({ limit: 5 })[0]!;
  assert.match(feed.summary, /Added to Google Calendar: Surgeon consultation \(gallbladder\), Thu 19 Nov 10:30–11:30/);
  assert.equal(feed.actor, 'agent');
  assert.equal(feed.undoable, false, 'it lives in Google, so it is not undone from Terminus');

  const allDay = await tools.run('google_calendar__create_event', { title: 'Recovery', start: '2026-11-20', end: '2026-11-21' }, { store: agent, today: '2026-11-14' });
  assert.equal(allDay.isError, false);
  const posted2 = JSON.parse(google.seen.findLast((s) => s.method === 'POST' && s.path.includes('/events'))!.body) as Record<string, unknown>;
  assert.deepEqual([posted2.start, posted2.end], [{ date: '2026-11-20' }, { date: '2026-11-22' }], 'the end date is exclusive in Google');

  const backwards = await tools.run('google_calendar__create_event', { title: 'x', start: '2026-11-19T10:00', end: '2026-11-19T09:00' }, { store: agent, today: '2026-11-14' });
  assert.equal(backwards.isError, true);
});

test('an expired access token is refreshed; a revoked sign-in says to reconnect', async () => {
  const google = await fakeGoogle();
  const { store, call } = setup();
  const authorize = await connect(call);
  await call('GET', `/api/integrations/gcal/callback?code=good-code&state=${authorize.searchParams.get('state')}`);
  updateIntegration(store, 'gcal', (r) => (r.secrets = { ...r.secrets, accessExpiresAt: '0' }));
  const tools = await toolbox(store);
  const ok = await tools.run('google_calendar__list_events', { from: '2026-11-16', to: '2026-11-16' }, { store: store.as('agent'), today: '2026-11-14' });
  assert.equal(ok.isError, false);
  assert.equal(google.seen.findLast((s) => s.method === 'GET')!.auth, 'Bearer at-2', 'a fresh token was fetched');

  updateIntegration(store, 'gcal', (r) => (r.secrets = { ...r.secrets, accessExpiresAt: '0', clientSecret: 'wrong' }));
  const bad = await tools.run('google_calendar__list_events', { from: '2026-11-16', to: '2026-11-16' }, { store: store.as('agent'), today: '2026-11-14' });
  assert.equal(bad.isError, true);
  assert.match(getIntegration(store, 'gcal').lastError ?? '', /client ID and secret/);
});

test('times read the way people say them', () => {
  assert.equal(describeTimes({ dateTime: '2026-11-19T02:30:00Z' }, { dateTime: '2026-11-19T03:30:00Z' }, 'Asia/Singapore'), 'Thu 19 Nov 10:30–11:30');
  assert.equal(describeTimes({ date: '2026-11-20' }, { date: '2026-11-23' }, 'Asia/Singapore'), 'Fri 20 Nov – Sun 22 Nov (all day)');
});
