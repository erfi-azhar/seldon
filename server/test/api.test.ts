import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, type AppOptions } from '../src/app.ts';
import { openDb } from '../src/db.ts';

function app(opts: Partial<AppOptions> = {}) {
  const a = createApp({ db: openDb(':memory:'), ...opts });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, host = 'localhost') =>
    a.request(`http://${host}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call };
}

test('the everyday flow: onboard, add things, read them back', async () => {
  const { call } = app();
  const settings = (await (await call('POST', '/api/onboarding', { userName: 'Sam', agentName: '', sphereKeys: ['health', 'faith'] })).json()) as {
    profile: { agentName: string; onboarded: boolean };
  };
  assert.equal(settings.profile.onboarded, true);
  assert.equal(settings.profile.agentName, 'Seldon', 'a blank agent name falls back to the default');

  const spheres = (await (await call('GET', '/api/spheres?date=2026-11-13')).json()) as { id: string; name: string }[];
  assert.deepEqual(spheres.map((s) => s.name), ['Health', 'Faith']);

  const habit = (await (await call('POST', '/api/habits', { sphereId: spheres[1]!.id, name: 'Prayer' })).json()) as { id: string };
  const logged = (await (await call('POST', `/api/habits/${habit.id}/log?date=2026-11-13`, {})).json()) as { doneToday: boolean };
  assert.equal(logged.doneToday, true);

  const created = await call('POST', '/api/tasks', { title: 'Call mum', dueDate: '2026-11-13' });
  assert.equal(created.status, 201);

  const overview = (await (await call('GET', '/api/overview?date=2026-11-13')).json()) as {
    tasks: { due: unknown[] };
    habits: { doneToday: boolean }[];
  };
  assert.equal(overview.tasks.due.length, 1);
  assert.equal(overview.habits[0]!.doneToday, true);

  await call('PUT', '/api/journal/2026-11-13', { body: 'A good day.' });
  const journal = (await (await call('GET', '/api/journal/2026-11-13')).json()) as { body: string };
  assert.equal(journal.body, 'A good day.');
});

test('bad input is a 400 with a reason, missing things are a 404', async () => {
  const { call } = app();
  const bad = await call('POST', '/api/tasks', { title: 42 });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /title/);
  assert.equal((await call('POST', '/api/goals', { sphereId: 'nope', title: 'x' })).status, 404);
  assert.equal((await call('GET', '/api/goals/nope')).status, 404);
  assert.equal((await call('GET', '/api/journal/not-a-date')).status, 400);
  assert.equal((await call('GET', '/api/whatever')).status, 404);
  assert.equal((await call('POST', '/api/import', { nope: 1 })).status, 400);
});

test('other websites cannot change anything', async () => {
  const { call } = app();
  const body = { title: 'planted' };
  assert.equal((await call('POST', '/api/tasks', body, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('POST', '/api/tasks', body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/tasks', body, { 'sec-fetch-site': 'same-origin' })).status, 201);
  assert.equal((await call('POST', '/api/tasks', body, { origin: 'http://localhost' })).status, 201);
  // A name that merely resolves to this machine is refused (DNS rebinding).
  assert.equal((await call('GET', '/api/overview', undefined, {}, 'rebind.evil.example')).status, 403);
});

test('extra hostnames can be allowed explicitly', async () => {
  assert.equal((await app({ allowedHosts: ['lifeos.tailnet.ts.net'] }).call('GET', '/api/overview', undefined, {}, 'lifeos.tailnet.ts.net')).status, 200);
  assert.equal((await app({ allowedHosts: ['*'] }).call('GET', '/api/overview', undefined, {}, 'anything.example')).status, 200);
});

test('with a passphrase, nothing is readable until you sign in', async () => {
  const { call } = app({ passphrase: 'correct horse' });
  assert.equal((await call('GET', '/api/overview', undefined, {}, 'my.server.example')).status, 401);
  assert.deepEqual(await (await call('GET', '/api/auth/status')).json(), { required: true, authenticated: false });

  assert.equal((await call('POST', '/api/auth/login', { passphrase: 'wrong' })).status, 401);
  const ok = await call('POST', '/api/auth/login', { passphrase: 'correct horse' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  const session = cookie.split(';')[0]!;

  assert.equal((await call('GET', '/api/overview', undefined, { cookie: session }, 'my.server.example')).status, 200);
  assert.equal((await call('GET', '/api/overview', undefined, { cookie: 'lifeos_session=forged' })).status, 401);

  await call('POST', '/api/auth/logout', {}, { cookie: session });
  assert.equal((await call('GET', '/api/overview', undefined, { cookie: session })).status, 401);
});

test('repeated wrong passphrases are throttled', async () => {
  const { call } = app({ passphrase: 'right' });
  for (let i = 0; i < 8; i++) assert.equal((await call('POST', '/api/auth/login', { passphrase: `guess-${i}` })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { passphrase: 'right' })).status, 429);
});

test('undo over the API', async () => {
  const { call } = app();
  await call('POST', '/api/tasks', { title: 'Temp' });
  const activity = (await (await call('GET', '/api/activity')).json()) as { id: number; undoable: boolean }[];
  assert.equal(activity[0]!.undoable, true);
  assert.equal((await call('POST', `/api/activity/${activity[0]!.id}/undo`, {})).status, 200);
  assert.equal((await call('POST', `/api/activity/${activity[0]!.id}/undo`, {})).status, 409);
  assert.deepEqual(await (await call('GET', '/api/tasks')).json(), []);
});
