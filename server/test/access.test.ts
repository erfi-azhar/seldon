import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { createToken } from '../src/access.ts';
import { Store } from '../src/store.ts';

const DAY = '2026-11-14';

function setup(passphrase = 'correct horse battery') {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['health', 'work'] });
  const app = createApp({ db, passphrase });
  const as = (token: string | null) => async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const send = body !== undefined && method !== 'GET' && method !== 'HEAD';
    const res = await app.request(`http://localhost/api${path}${path.includes('?') ? '&' : '?'}date=${DAY}`, { method, headers, body: send ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { db, store, app, as };
}

test('a write token acts as Seldon: reads, runs tools, and its changes are attributed to Seldon and undoable', async () => {
  const { store, as } = setup();
  const { token } = createToken(store, 'Claude Code', 'write', 90);
  const call = as(token);
  const snap = await call('GET', '/agent/snapshot');
  assert.equal(snap.status, 200);
  assert.match(snap.json.snapshot, /Health/);
  const tools = await call('GET', '/agent/tools');
  assert.ok(tools.json.some((t: { name: string }) => t.name === 'create_task'));
  assert.ok(!tools.json.some((t: { name: string }) => /^delete/.test(t.name)), 'there are no delete tools to offer');

  const run = await call('POST', '/agent/tools/create_task', { input: { title: 'Book the dentist' } });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  assert.equal(run.json.ok, true);
  const act = store.listActivity()[0]!;
  assert.equal(act.actor, 'agent');
  assert.equal(act.undoable, true);
  // Plain API writes through a token are Seldon's too.
  const viaApi = await call('POST', '/tasks', { title: 'Renew passport' });
  assert.equal(viaApi.status, 201);
  assert.equal(store.listActivity()[0]!.actor, 'agent');
  // Bad tool input comes back as a 400 the caller can read.
  const bad = await call('POST', '/agent/tools/create_task', { input: { title: '' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.ok, false);
});

test('tokens never reach secrets, tokens, export, import or deletes; read-only tokens only read', async () => {
  const { store, as } = setup();
  const write = as(createToken(store, 'w', 'write', null).token);
  const readOnly = as(createToken(store, 'r', 'read', 30).token);
  for (const [method, path] of [
    ['GET', '/settings'],
    ['GET', '/connections'],
    ['GET', '/tokens'],
    ['POST', '/tokens'],
    ['GET', '/export'],
    ['POST', '/import'],
    ['PUT', '/integrations/gmail'],
    ['PUT', '/integrations/figma'],
    ['GET', '/integrations/figma'],
    ['GET', '/mcp/servers'],
    ['POST', '/capture/token'],
    ['POST', '/auth/logout'],
  ] as const) {
    assert.equal((await write(method, path, {})).status, 403, `${method} ${path}`);
  }
  const t = store.createTask({ title: 'Keep me' });
  assert.equal((await write('DELETE', `/tasks/${t.id}`)).status, 403);
  assert.equal(store.getTask(t.id).title, 'Keep me');

  assert.equal((await readOnly('GET', '/overview')).status, 200);
  assert.equal((await readOnly('POST', '/agent/tools/get_overview', { input: {} })).status, 200);
  assert.equal((await readOnly('POST', '/agent/tools/search', { input: { query: 'Keep' } })).status, 200);
  const refused = await readOnly('POST', '/agent/tools/create_task', { input: { title: 'x' } });
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /read-only/);
  assert.equal((await readOnly('POST', '/tasks', { title: 'x' })).status, 403);
});

test('unknown, revoked and expired tokens are refused; the owner manages tokens with a session', async () => {
  const { db, store, app, as } = setup();
  assert.equal((await as('tmn_not-a-real-token')('GET', '/overview')).status, 401);
  assert.equal((await as(null)('GET', '/overview')).status, 401, 'no token and no session');

  // Sign in as the owner and manage tokens.
  const login = await app.request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'correct horse battery' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const owner = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://localhost/api${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const made = await owner('POST', '/tokens', { name: 'Claude Code', scope: 'write', days: 90 });
  assert.equal(made.status, 201);
  assert.match(made.json.token, /^tmn_/);
  const listed = await owner('GET', '/tokens');
  assert.equal(listed.json.length, 1);
  assert.equal(JSON.stringify(listed.json).includes(made.json.token), false, 'the value is never listed');
  const stored = db.prepare('SELECT token_hash FROM access_tokens').get() as { token_hash: string };
  assert.notEqual(stored.token_hash, made.json.token, 'only a hash is stored');

  const call = as(made.json.token);
  assert.equal((await call('GET', '/overview')).status, 200);
  assert.ok((await owner('GET', '/tokens')).json[0].lastUsedAt, 'use is noted');
  assert.equal((await owner('DELETE', `/tokens/${made.json.record.id}`)).status, 200);
  assert.equal((await call('GET', '/overview')).status, 401, 'revoked at once');

  const old = createToken(store, 'old', 'read', 30);
  db.prepare('UPDATE access_tokens SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', old.record.id);
  assert.equal((await as(old.token)('GET', '/overview')).status, 401);
});

test('Seldon is told to file lasting answers as notes in their sphere', async () => {
  const { buildSystemPrompt } = await import('../src/agent/prompt.ts');
  const prompt = buildSystemPrompt({ userName: 'Sam', agentName: 'Seldon', onboarded: true } as never);
  assert.match(prompt, /save it as a note in the sphere it belongs to/);
});
