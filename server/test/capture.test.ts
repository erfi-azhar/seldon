import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { capture, capturesSettled, decodeEntities, readableText } from '../src/features/capture.ts';
import { allowPrivateAddressesForTests, isPublicAddress, safeFetch } from '../src/features/fetcher.ts';
import { listSignals } from '../src/features/signals.ts';
import { Store } from '../src/store.ts';
import { anthropicMessage, fakeModel } from './helpers.ts';

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));
async function site(routes: Record<string, { type: string; body: string | Buffer; status?: number; location?: string }>): Promise<string> {
  const server = createServer((req, res) => {
    const r = routes[req.url ?? ''];
    if (!r) return res.writeHead(404).end();
    res.writeHead(r.status ?? 200, { 'content-type': r.type, ...(r.location ? { location: r.location } : {}) }).end(r.body);
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('public-address guard refuses this machine and private networks, including via redirects', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['1.1.1.1', '142.250.4.100', '2606:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);

  const local = await site({ '/': { type: 'text/html', body: 'secret' } });
  allowPrivateAddressesForTests(false);
  await assert.rejects(() => safeFetch(local), /not a public address/);
  await assert.rejects(() => safeFetch('http://localhost:1/'), /not a public address|Could not fetch/);
  await assert.rejects(() => safeFetch('file:///etc/passwd'), /Only http and https/);
  await assert.rejects(() => safeFetch('http://user:pw@example.com/'), /credentials/);
});

test('a saved article is read, its thumbnail kept locally, and Seldon files it — with a task when there is one', async () => {
  allowPrivateAddressesForTests(true);
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['travels', 'health'] });
  const base = await site({
    '/article': {
      type: 'text/html; charset=utf-8',
      body: `<html><head><title>ignored</title>
        <meta property="og:title" content="Walking the Kumano Kod&#333; in Autumn">
        <meta property="og:description" content="Four days on the Nakahechi route.">
        <meta property="og:site_name" content="Trail Notes"><meta property="og:type" content="article">
        <meta property="og:image" content="/thumb.png"></head>
        <body><nav>Menu</nav><article><h1>Kumano</h1><p>Inns forward your luggage.</p><script>evil()</script><p>Book by 1 December.</p></article><footer>©</footer></body></html>`,
    },
    '/thumb.png': { type: 'image/png', body: PNG },
  });
  const organised = { title: 'Walking the Kumano Kodō', kind: 'article', summary: 'A four-day guide to the Nakahechi route.', key_points: ['Inns forward luggage'], tags: ['Japan', 'hiking'], sphere: 'Travels', collection: 'Trips to plan', task: { title: 'Book Kumano inns', due_date: '2026-12-01' } };
  const model = await fakeModel([{ sse: anthropicMessage([{ type: 'text', text: JSON.stringify(organised) }], 'end_turn') }]);
  store.addConnection({ provider: 'anthropic', baseUrl: model.url, apiKey: 'k', model: 'claude-opus-5-5' });

  const pending = capture(store, { text: `for our spring trip ${base}/article` }, 'shortcut');
  assert.equal(pending.status, 'processing');
  assert.equal(pending.url, `${base}/article`, 'the link is found inside shared text');
  await capturesSettled();

  const n = store.getNote(pending.id);
  assert.equal(n.status, 'ready');
  assert.equal(n.title, 'Walking the Kumano Kodō');
  assert.equal(n.sphereId, store.listSpheres().find((s) => s.name === 'Travels')!.id);
  assert.deepEqual(n.capture!.tags, ['japan', 'hiking']);
  assert.equal(n.capture!.collection, 'Trips to plan');
  assert.equal(n.capture!.via, 'shortcut');
  assert.ok(n.capture!.imageFileId, 'thumbnail stored');
  assert.match(n.body, /for our spring trip/);
  assert.equal(listSignals(store)[0]!.title, 'From something you saved: Book Kumano inns');

  const sent = model.seen[0]!.body.messages[0].content as string;
  assert.match(sent, /Note from the user \(trusted\): for our spring trip/);
  assert.match(sent, /<untrusted source="saved item">[\s\S]*Inns forward your luggage[\s\S]*Book by 1 December/);
  assert.doesNotMatch(sent, /evil\(\)|Menu/);
});

test('without a brain, a link keeps what the page says about itself; a bad link fails softly', async () => {
  allowPrivateAddressesForTests(true);
  const store = new Store(openDb(':memory:'));
  const base = await site({ '/p': { type: 'text/html', body: '<meta name="description" content="Plain description"><title>A page</title><p>Hi</p>' } });
  const ok = capture(store, { url: `${base}/p` }, 'app');
  const bad = capture(store, { url: `${base}/missing` }, 'app');
  await capturesSettled();
  assert.equal(store.getNote(ok.id).title, 'A page');
  assert.equal(store.getNote(ok.id).capture!.summary, 'Plain description');
  assert.equal(store.getNote(bad.id).status, 'failed');
  assert.match(store.getNote(bad.id).capture!.error!, /404/);
  assert.throws(() => capture(store, { url: 'javascript:alert(1)' }, 'app'), /not a link/);
});

test('helpers: entities and readable text', () => {
  assert.equal(decodeEntities('Caf&eacute; &amp; &#x1F600; &#8212;'), 'Caf&eacute; & 😀 —');
  assert.equal(readableText('<body><header>H</header><main><p>One</p><p>Two</p></main><aside>x</aside></body>'), 'One\n\nTwo');
});

test('over HTTP: the capture token works without a session; uploads are served safely', async () => {
  allowPrivateAddressesForTests(true);
  const db = openDb(':memory:');
  const app = createApp({ db, passphrase: 'pw' });
  const login = await app.request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'pw' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const { token } = (await (await app.request('http://localhost/api/capture/token', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).json()) as { token: string };

  const post = (headers: Record<string, string>, body: string) => app.request('http://localhost/api/capture', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await post({}, JSON.stringify({ text: 'hello' }))).status, 401);
  assert.equal((await post({ authorization: 'Bearer tc_wrong' }, JSON.stringify({ text: 'hello' }))).status, 401);
  assert.equal((await post({ authorization: `Bearer ${token}` }, JSON.stringify({ text: 'Idea: a reading nook' }))).status, 201);
  // The token only opens the capture door.
  assert.equal((await app.request('http://localhost/api/overview', { headers: { authorization: `Bearer ${token}` } })).status, 401);

  const form = new FormData();
  form.set('file', new Blob([PNG], { type: 'image/png' }), 'pic.png');
  const up = await app.request('http://localhost/api/capture', { method: 'POST', headers: { cookie }, body: form });
  assert.equal(up.status, 201);
  await capturesSettled();
  const note = new Store(db).getNote(((await up.json()) as { id: string }).id);
  const file = await app.request(`http://localhost/api/files/${note.capture!.imageFileId}`, { headers: { cookie } });
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');

  const svg = new FormData();
  svg.set('file', new Blob(['<svg onload="alert(1)"/>'], { type: 'image/svg+xml' }), 'x.svg');
  assert.equal((await app.request('http://localhost/api/capture', { method: 'POST', headers: { cookie }, body: svg })).status, 400);
});
