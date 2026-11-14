import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolbox } from '../src/agent/tools.ts';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { Store } from '../src/store.ts';

const servers: HttpServer[] = [];
after(() => servers.forEach((s) => s.close()));

const TOOLS = [
  { name: 'log_water', description: 'Log water drunk', inputSchema: { type: 'object', properties: { ml: { type: 'number' } }, required: ['ml'] }, annotations: { readOnlyHint: false } },
  { name: 'get_water', description: 'Read water for a day', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'delete_food_entry', description: 'Delete an entry', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } },
  { name: 'wipe_everything', description: 'Danger', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } },
];

function mcpServer() {
  const s = new Server({ name: 'fake-gravl', version: '1.0.0' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => ({ content: [{ type: 'text', text: `called ${req.params.name} with ${JSON.stringify(req.params.arguments)}` }] }));
  return s;
}

const body = (req: IncomingMessage) => new Promise<string>((ok) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => ok(raw));
});

/** An MCP server on /mcp; with `oauth`, also a minimal OAuth server guarding it. */
async function start(oauth: boolean) {
  const seen = { registered: 0, tokenRequests: [] as URLSearchParams[] };
  let base = '';
  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(data));
    if (oauth) {
      if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (url.pathname === '/.well-known/oauth-authorization-server')
        return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
      if (url.pathname === '/register') {
        seen.registered++;
        const meta = JSON.parse(await body(req));
        return json(201, { ...meta, client_id: 'client-123' });
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(await body(req));
        seen.tokenRequests.push(form);
        return json(200, { access_token: 'good-token', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh' });
      }
      if (url.pathname === '/mcp' && req.headers.authorization !== 'Bearer good-token') {
        return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      }
    }
    if (url.pathname === '/mcp') {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer().connect(transport);
      const raw = await body(req);
      return transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    }
    res.writeHead(404).end();
  });
  servers.push(http);
  await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
  base = `http://localhost:${(http.address() as AddressInfo).port}`;
  return { url: `${base}/mcp`, seen };
}

function setup() {
  const db = openDb(':memory:');
  const app = createApp({ db });
  const call = (method: string, path: string, data?: object) =>
    app.request(`http://localhost:4321${path}`, { method, headers: { 'content-type': 'application/json', origin: 'http://localhost:4321' }, body: data && JSON.stringify(data) });
  return { store: new Store(db), call };
}

test('an open MCP server: tools join Seldon\'s toolbox, minus anything destructive; modes narrow them', async () => {
  const { store, call } = setup();
  const srv = await start(false);
  const res = await call('POST', '/api/mcp/servers', { name: 'Gravl', url: srv.url });
  assert.equal(res.status, 201);
  const { server, authorizeUrl } = (await res.json()) as { server: { status: string; toolCount: number; withheld: string[] }; authorizeUrl: string | null };
  assert.equal(authorizeUrl, null);
  assert.equal(server.status, 'connected');
  assert.equal(server.toolCount, 2);
  assert.deepEqual(server.withheld.sort(), ['delete_food_entry', 'wipe_everything']);

  let box = await toolbox(store);
  const names = box.specs.map((s) => s.name);
  assert.ok(names.includes('gravl__log_water') && names.includes('gravl__get_water'));
  assert.ok(!names.some((n) => /delete_food_entry|wipe_everything/.test(n)), 'destructive tools are never offered');
  const run = await box.run('gravl__log_water', { ml: 500 }, { store, today: '2026-11-14' });
  assert.deepEqual(run, { content: 'called log_water with {"ml":500}', isError: false, summary: 'Gravl: log water' });

  await call('PATCH', '/api/mcp/servers/gravl', { mode: 'read' });
  box = await toolbox(store);
  assert.ok(box.specs.some((s) => s.name === 'gravl__get_water') && !box.specs.some((s) => s.name === 'gravl__log_water'));
  await call('PATCH', '/api/mcp/servers/gravl', { mode: 'off' });
  assert.ok(!(await toolbox(store)).specs.some((s) => s.name.startsWith('gravl__')));

  assert.equal((await call('POST', '/api/mcp/servers', { name: 'Bad', url: 'http://example.com/mcp' })).status, 400, 'plain http only for this machine');
});

test('an OAuth-protected server: register, sign in with PKCE and state, then use the tools', async () => {
  const { store, call } = setup();
  const srv = await start(true);
  const res = await call('POST', '/api/mcp/servers', { name: 'Gravl', url: srv.url });
  const { server, authorizeUrl } = (await res.json()) as { server: { status: string }; authorizeUrl: string };
  assert.equal(server.status, 'needs_auth');
  const auth = new URL(authorizeUrl);
  assert.equal(auth.pathname, '/authorize');
  assert.equal(auth.searchParams.get('client_id'), 'client-123');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), 'http://localhost:4321/api/mcp/callback?server=gravl');
  assert.equal(srv.seen.registered, 1);
  const state = auth.searchParams.get('state')!;

  // A callback with the wrong state is refused.
  const forged = await call('GET', `/api/mcp/callback?server=gravl&code=abc&state=nope`);
  assert.equal(forged.headers.get('location'), '/settings?mcp=failed#connections');

  const back = await call('GET', `/api/mcp/callback?server=gravl&code=abc&state=${state}`);
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/settings?mcp=connected#connections');
  assert.equal(srv.seen.tokenRequests[0]!.get('code'), 'abc');
  assert.ok(srv.seen.tokenRequests[0]!.get('code_verifier'), 'PKCE verifier sent');

  const list = (await (await call('GET', '/api/mcp/servers')).json()) as { servers: { status: string; toolCount: number }[] };
  assert.equal(list.servers[0]!.status, 'connected');
  assert.equal(list.servers[0]!.toolCount, 2);
  const run = await (await toolbox(store)).run('gravl__get_water', {}, { store, today: '2026-11-14' });
  assert.equal(run.isError, false);
  // Tokens never leave the server.
  assert.ok(!JSON.stringify(list).includes('good-token'));
});

test('Gravl sync: the background brain turns Gravl\'s answers into Health rows, imported once', async () => {
  const { syncGravl } = await import('../src/features/gravl.ts');
  const { healthState } = await import('../src/features/health.ts');
  const { anthropicMessage, fakeModel } = await import('./helpers.ts');
  const { store, call } = setup();
  store.onboard({ userName: '', agentName: 'Seldon', sphereKeys: ['health'] });
  const srv = await start(false);
  await call('POST', '/api/mcp/servers', { name: 'Gravl', url: srv.url });
  const rows = {
    food: [{ external_id: 'f1', date: '2026-11-14', time: '08:00', name: 'Oats', amount: '80 g', kcal: 300, protein: 10, carbs: 54, fat: 6 }],
    workouts: [{ external_id: 'w1', date: '2026-11-13', name: 'Upper body', type: 'strength', duration_min: 50, distance_km: null, kcal: null, exercises: [{ name: 'Bench Press', sets: [{ reps: 8, weight: 70 }] }] }],
    body: [{ date: '2026-11-14', weight_kg: 78.4, body_fat_pct: null, muscle_kg: null }],
  };
  const reply = { sse: anthropicMessage([{ type: 'text', text: JSON.stringify(rows) }], 'end_turn') };
  const model = await fakeModel([reply, { ...reply }]);
  store.addConnection({ provider: 'anthropic', baseUrl: model.url, apiKey: 'k' });

  assert.deepEqual(await syncGravl(store, '2026-11-14'), { food: 1, workouts: 1, body: 1 });
  assert.deepEqual(await syncGravl(store, '2026-11-14'), { food: 0, workouts: 0, body: 0 }, 'the second sync imports nothing new');
  const h = healthState(store, '2026-11-14');
  assert.equal(h.today.totals.kcal, 300);
  assert.equal(h.workouts[0]!.source, 'gravl');
  assert.equal(h.body.at(-1)!.weightKg, 78.4);
  assert.equal(store.listActivity().filter((a) => /Oats|Upper body/.test(a.summary)).length, 0, 'synced rows stay out of the feed');
  const sent = model.seen[0]!.body.messages[0].content as string;
  assert.match(sent, /<untrusted source="gravl list_workouts">\ncalled list_workouts/);
});
