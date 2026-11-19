import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { isReadTool } from '../src/access.ts';
import { createApp } from '../src/app.ts';
import { renderSnapshot } from '../src/agent/prompt.ts';
import { runTool } from '../src/agent/tools.ts';
import { openDb } from '../src/db.ts';
import { Scheduler } from '../src/jobs.ts';
import { Store } from '../src/store.ts';
import '../src/features/index.ts';
import { FigmaError, parseFigmaUrl, runFigma, setFigmaTransport } from '../src/features/figma.ts';
import { listSignals } from '../src/features/signals.ts';
import { addMaterial, createCard, getCard, updateCard } from '../src/features/work.ts';
import type { FigmaCardComments, IntegrationStatus, Task } from '../../shared/types.ts';

const TOKEN = 'figd_test-token-0123456789';
const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const OTHER = 'ZyXwVuTsRqPoNmLkJiHgFe';
const FILE_URL = `https://www.figma.com/design/${KEY}/Checkout-Flow?node-id=0-1`;
const TODAY = '2026-11-19';

// ── A fake Figma API: answers /v1/me and each file's comments from a script ──

type ApiComment = Record<string, unknown>;
const files: Record<string, ApiComment[] | number> = {};
const asked: URL[] = [];
let meAnswer: { status: number; json: unknown } = { status: 200, json: { id: 'me-1', handle: 'Sam Lee', email: 'sam@example.com' } };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

setFigmaTransport((async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  asked.push(url);
  const token = (init?.headers as Record<string, string>)['x-figma-token'];
  if (token !== TOKEN) return json(403, { status: 403, err: 'Invalid token' });
  if (url.pathname === '/v1/me') return json(meAnswer.status, meAnswer.json);
  const m = /^\/v1\/files\/([^/]+)\/comments$/.exec(url.pathname);
  const c = m ? files[m[1]!] : undefined;
  if (typeof c === 'number') return json(c, { status: c, err: c === 429 ? 'Rate limit exceeded' : 'Not found' });
  if (!c) return json(404, { status: 404, err: 'Not found' });
  return json(200, { comments: c });
}) as typeof fetch);
after(() => setFigmaTransport(null));

let clock = 0;
/** New comments land after the card is made (an hour from when the tests start). */
const START = Date.now() + 3_600_000;
const PEOPLE = { me: { id: 'me-1', handle: 'Sam Lee' }, ann: { id: 'u-ann', handle: 'Ann (PM)' }, raj: { id: 'u-raj', handle: 'Raj' } };
function comment(id: string, who: keyof typeof PEOPLE, message: string, opts: { parent?: string; resolved?: boolean; node?: string; at?: string } = {}): ApiComment {
  clock++;
  return {
    id,
    file_key: KEY,
    parent_id: opts.parent ?? '',
    user: { ...PEOPLE[who], img_url: 'https://example.com/a.png' },
    created_at: opts.at ?? new Date(START + clock * 60_000).toISOString(),
    resolved_at: opts.resolved ? '2026-11-19T01:00:00Z' : null,
    message,
    client_meta: opts.node ? { node_id: opts.node, node_offset: { x: 4, y: 8 } } : { x: 10, y: 20 },
    order_id: String(clock),
    reactions: [],
  };
}

/** The comments already on the file when Figma is connected. */
function startingComments(): ApiComment[] {
  return [
    comment('c1', 'ann', 'Make the CTA full width on mobile', { node: '1:2' }),
    comment('c2', 'ann', 'Can we try the lighter grey here?'),
    comment('c3', 'me', 'Done, take a look?', { parent: 'c2' }),
    comment('c4', 'raj', 'Spacing is off by 4px', { resolved: true }),
    comment('c5', 'me', 'Note to self: check the dark theme'),
    comment('c6', 'raj', 'The error state is clipped'),
    comment('c7', 'me', 'Fixed in v3', { parent: 'c6' }),
    comment('c8', 'raj', 'Still clipped on small screens', { parent: 'c6' }),
  ];
}

beforeEach(() => {
  for (const k of Object.keys(files)) delete files[k];
  asked.length = 0;
  meAnswer = { status: 200, json: { id: 'me-1', handle: 'Sam Lee', email: 'sam@example.com' } };
});

async function setup() {
  const db = openDb(':memory:');
  const store = new Store(db);
  const scheduler = new Scheduler(store);
  const app = createApp({ db, scheduler });
  const call = async <T,>(method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://localhost${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as T };
  };
  /** Wait for the read that connecting starts in the background. */
  const settle = async () => {
    while (scheduler.isRunning('figma')) await new Promise((r) => setTimeout(r, 5));
  };
  await call('POST', '/api/onboarding', { userName: 'Sam', agentName: 'Seldon', sphereKeys: ['work'] });
  const card = createCard(store, { title: 'Checkout redesign', project: 'Payments', dueDate: '2026-12-04' });
  addMaterial(store, card.id, { kind: 'figma', title: 'Checkout Flow', url: FILE_URL });
  return { store, call, settle, scheduler, card };
}

async function connected() {
  const s = await setup();
  files[KEY] = startingComments();
  const res = await s.call<IntegrationStatus>('PUT', '/api/integrations/figma', { token: TOKEN });
  assert.equal(res.status, 200);
  await s.settle();
  return s;
}

const signals = (store: Store) => listSignals(store, { source: 'figma' });

// ── Links ───────────────────────────────────────────────────────────────────

test('Figma links name their file: design, FigJam, prototype and branch links; anything else is not one', () => {
  assert.deepEqual(parseFigmaUrl(`https://www.figma.com/design/${KEY}/Checkout-Flow?node-id=1-2&t=x`), { key: KEY, name: 'Checkout Flow' });
  assert.deepEqual(parseFigmaUrl(`https://figma.com/file/${KEY}`), { key: KEY, name: '' });
  assert.equal(parseFigmaUrl(`https://www.figma.com/board/${OTHER}/Retro`)?.key, OTHER);
  assert.equal(parseFigmaUrl(`https://www.figma.com/proto/${KEY}/Flow?page-id=0`)?.key, KEY);
  assert.deepEqual(parseFigmaUrl(`https://www.figma.com/design/${KEY}/branch/BrAnChKeY1234567/Checkout`), { key: 'BrAnChKeY1234567', name: 'Checkout' }, 'a branch link reads the branch');
  assert.equal(parseFigmaUrl(`https://example.com/design/${KEY}/X`), null);
  assert.equal(parseFigmaUrl('https://www.figma.com/community/file/1234567890123/kit'), null);
  assert.equal(parseFigmaUrl('https://www.figma.com/design/abc/KYC'), null, 'too short to be a file key');
});

// ── Connecting ──────────────────────────────────────────────────────────────

test('connecting checks the token with Figma, keeps it secret and never keeps the email', async () => {
  const { call, settle } = await setup();
  const bad = await call<{ error: string }>('PUT', '/api/integrations/figma', { token: 'figd_wrong' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /turned the access token down/);
  assert.equal((await call<IntegrationStatus>('GET', '/api/integrations/figma')).body.configured, false, 'a refused token is not saved');

  meAnswer = { status: 403, json: { status: 403, err: 'Invalid scope(s): current_user:read. This endpoint requires the current_user:read scope' } };
  const scope = await call<{ error: string }>('PUT', '/api/integrations/figma', { token: TOKEN });
  assert.equal(scope.status, 400);
  assert.match(scope.body.error, /missing a permission.*current_user:read/);

  meAnswer = { status: 200, json: { id: 'me-1', handle: 'Sam Lee', email: 'sam@example.com' } };
  files[KEY] = [];
  const ok = await call<IntegrationStatus>('PUT', '/api/integrations/figma', { token: TOKEN });
  assert.equal(ok.status, 200);
  await settle();
  const st = await call<IntegrationStatus>('GET', '/api/integrations/figma');
  assert.equal(st.body.configured, true);
  assert.equal(st.body.settings.handle, 'Sam Lee');
  assert.equal(st.body.settings.watching, 1);
  const everything = JSON.stringify([st.body, (await call('GET', '/api/integrations')).body]);
  assert.ok(!everything.includes(TOKEN), 'the token is never sent back');
  assert.ok(!everything.includes('sam@example.com'), 'the email is not kept');

  const noToken = await call<{ error: string }>('PUT', '/api/integrations/figma', { files: ['https://example.com/not-figma'] });
  assert.equal(noToken.status, 400);
  assert.match(noToken.body.error, /isn't a link to a Figma file/);
});

// ── Reading ─────────────────────────────────────────────────────────────────

test('the first read takes stock without a signal; threads sort into needing you, waiting on others and resolved', async () => {
  const { store, call, card } = await connected();
  assert.equal(signals(store).length, 0, 'what was already there is not news');

  const res = await call<FigmaCardComments>('GET', `/api/figma/cards/${card.id}`);
  const v = res.body;
  assert.equal(v.connected, true);
  assert.equal(v.files.length, 1);
  assert.equal(v.files[0]!.name, 'Checkout Flow');
  assert.ok(v.files[0]!.syncedAt);
  assert.deepEqual(
    v.threads.map((t) => [t.id, t.status]),
    [
      ['c6', 'needs-you'],
      ['c1', 'needs-you'],
      ['c5', 'waiting'],
      ['c2', 'waiting'],
    ],
    'needing you first, newest activity first; resolved ones left out',
  );
  assert.equal(v.resolved, 1);
  const c1 = v.threads.find((t) => t.id === 'c1')!;
  assert.equal(c1.link, `https://www.figma.com/design/${KEY}/Checkout-Flow?node-id=1-2#c1`, 'opens the comment on its layer');
  assert.equal(c1.author, 'Ann (PM)');
  const c6 = v.threads.find((t) => t.id === 'c6')!;
  assert.deepEqual(c6.replies.map((r) => [r.author, r.mine]), [['Sam Lee', true], ['Raj', false]]);

  assert.deepEqual((await call('GET', '/api/figma/board')).body, { [card.id]: 2 });
  const snapshot = renderSnapshot(store, TODAY);
  assert.match(snapshot, /Checkout Flow \(Checkout redesign, card [\w-]+\): 2 threads need you/);
  assert.ok(!snapshot.includes('full width'), 'comment text stays out of the snapshot');
});

test("new comments from others on open threads raise one signal per file; the owner's own and resolved threads don't", async () => {
  const { store } = await connected();
  files[KEY] = [
    ...startingComments(),
    comment('c9', 'ann', 'Typo in the header: "Chekout"'),
    comment('c10', 'raj', 'Looks good but the icon is blurry', { parent: 'c2' }),
    comment('c11', 'me', 'Reminder: export assets'),
    comment('c12', 'raj', 'Thanks!', { parent: 'c4' }),
  ];
  const r = await runFigma(store);
  assert.deepEqual(r, { files: 1, fresh: 2 });
  const s = signals(store);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.title, '2 new Figma comments on Checkout Flow');
  assert.match(s[0]!.body, /Ann \(PM\): Typo in the header/);
  assert.match(s[0]!.body, /Raj: Looks good but the icon is blurry/);
  assert.match(s[0]!.body, /For Checkout redesign\./);
  assert.ok(!s[0]!.body.includes('export assets') && !s[0]!.body.includes('Thanks!'));
  assert.equal(s[0]!.sphereId, store.listSpheres(TODAY).find((x) => x.key === 'work')!.id, 'filed under Work');
  assert.deepEqual(s[0]!.actions, [{ type: 'link', label: 'Open in Figma', url: FILE_URL }]);

  await runFigma(store);
  assert.equal(signals(store).length, 1, 'read again, nothing new: no second signal');

  files[KEY] = [...(files[KEY] as ApiComment[]), comment('c13', 'ann', 'One more: align the totals right', { node: '4:5' })];
  await runFigma(store);
  const one = signals(store).find((x) => x.title.startsWith('Ann (PM) on Checkout Flow'))!;
  assert.equal(one.title, 'Ann (PM) on Checkout Flow: One more: align the totals right');
  assert.equal(one.url, `https://www.figma.com/design/${KEY}/Checkout-Flow?node-id=4-5#c13`, 'a single comment links straight to it');
});

test('a thread becomes a to-do on the card once, and is ticked off when it is resolved in Figma', async () => {
  const { store, call, card } = await connected();
  const made = await call<Task>('POST', '/api/figma/threads/c1/todo', { cardId: card.id });
  assert.equal(made.status, 201);
  assert.equal(made.body.title, 'Figma: Make the CTA full width on mobile');
  assert.match(made.body.notes, /Ann \(PM\) in Figma: “Make the CTA full width on mobile”/);
  assert.match(made.body.notes, /node-id=1-2#c1/);
  assert.ok(getCard(store, card.id).tasks.some((t) => t.id === made.body.id), "on the card's timeline");

  const again = await call<Task>('POST', '/api/figma/threads/c1/todo', { cardId: card.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, made.body.id, 'no second to-do for the same thread');

  const other = createCard(store, { title: 'Unrelated work' });
  const wrong = await call<{ error: string }>('POST', '/api/figma/threads/c1/todo', { cardId: other.id });
  assert.equal(wrong.status, 400, "a card that doesn't link the file can't take its comments");

  let v = (await call<FigmaCardComments>('GET', `/api/figma/cards/${card.id}`)).body;
  assert.deepEqual([v.threads.find((t) => t.id === 'c1')!.taskId, v.threads.find((t) => t.id === 'c1')!.taskDone], [made.body.id, false]);

  files[KEY] = startingComments().map((c) => (c.id === 'c1' ? { ...c, resolved_at: '2026-11-19T02:00:00Z' } : c));
  await runFigma(store);
  assert.equal(store.getTask(made.body.id).done, true, 'resolved in Figma, done here');
  v = (await call<FigmaCardComments>('GET', `/api/figma/cards/${card.id}`)).body;
  assert.ok(!v.threads.some((t) => t.id === 'c1'));
  assert.equal(v.resolved, 2);
});

test("Seldon reads threads fenced as untrusted, and plans them as to-dos titled with the change", async () => {
  const { store, card } = await connected();
  assert.ok(isReadTool('list_figma_comments'), 'a read-only token may read comments');
  assert.ok(!isReadTool('add_figma_to_dos'));

  const read = await runTool('list_figma_comments', { card_id: card.id }, { store, today: TODAY });
  assert.equal(read.isError, false);
  assert.match(read.content, /^2 threads need the user; 2 wait on others\./);
  assert.match(read.content, /"thread_id":"c1","status":"needs-you"/);
  assert.match(read.content, /<untrusted source="figma comment thread">\nAnn \(PM\): Make the CTA full width on mobile\n<\/untrusted>/);
  assert.ok(!read.content.includes('Note to self'), 'threads waiting on others only when asked');
  const all = await runTool('list_figma_comments', { include_waiting: true }, { store, today: TODAY });
  assert.ok(all.content.includes('Note to self'));

  const plan = await runTool('add_figma_to_dos', { card_id: card.id, to_dos: [{ thread_id: 'c6', title: 'Unclip the error state on small screens', due_date: '2026-11-24' }] }, { store, today: TODAY });
  assert.equal(plan.isError, false, plan.content);
  const step = getCard(store, card.id).tasks.find((t) => t.title === 'Unclip the error state on small screens')!;
  assert.equal(step.dueDate, '2026-11-24');
  assert.match(step.notes, /Raj in Figma: “The error state is clipped”/);
});

test('when Figma is not connected, Seldon is told where to connect it', async () => {
  const { store, call, card } = await setup();
  const r = await runTool('list_figma_comments', {}, { store, today: TODAY });
  assert.match(r.content, /not connected.*Settings → Connections/);
  assert.equal((await call<FigmaCardComments>('GET', `/api/figma/cards/${card.id}`)).body.connected, false);
  assert.deepEqual((await call('GET', '/api/figma/board')).body, {});
  assert.ok(!renderSnapshot(store, TODAY).includes('Figma comments'));
});

// ── Which files ─────────────────────────────────────────────────────────────

test("in a file shared for years, only threads since the card was made, or ones you've joined, count", async () => {
  const s = await setup();
  files[KEY] = [
    ...startingComments(),
    comment('old1', 'raj', 'Different loading states', { at: '2025-11-24T09:25:18Z' }),
    comment('old2', 'ann', 'This version looks hmmm', { at: '2026-08-21T08:15:16Z' }),
    comment('old3', 'raj', 'It is okay, can do an AB test', { parent: 'old2', at: '2026-08-21T08:18:36Z' }),
    comment('old4', 'ann', 'Use the link style for Add', { at: '2025-10-31T04:29:47Z' }),
    comment('old5', 'me', "I'll check with the PI team", { parent: 'old4', at: '2025-10-31T05:00:00Z' }),
    comment('old6', 'ann', 'Any update?', { parent: 'old4', at: '2025-11-02T05:00:00Z' }),
  ];
  assert.equal((await s.call('PUT', '/api/integrations/figma', { token: TOKEN })).status, 200);
  await s.settle();

  const v = (await s.call<FigmaCardComments>('GET', `/api/figma/cards/${s.card.id}`)).body;
  const ids = v.threads.map((t) => t.id);
  assert.ok(!ids.includes('old1') && !ids.includes('old2'), "old threads between other people don't count");
  assert.equal(v.threads.find((t) => t.id === 'old4')?.status, 'needs-you', "an old thread you joined still counts when it's your turn");
  assert.equal(v.resolved, 1);
  assert.deepEqual((await s.call('GET', '/api/figma/board')).body, { [s.card.id]: 3 });
  const read = await runTool('list_figma_comments', { card_id: s.card.id }, { store: s.store, today: TODAY });
  assert.ok(!read.content.includes('looks hmmm') && read.content.includes('Any update?'));

  // A new reply on an old thread you're not in is not news; on one you joined, it is.
  files[KEY] = [...(files[KEY] as ApiComment[]), comment('new1', 'raj', 'Still hmmm', { parent: 'old2' }), comment('new2', 'ann', 'Ping', { parent: 'old4' })];
  assert.deepEqual(await runFigma(s.store), { files: 1, fresh: 1 });
  assert.deepEqual(signals(s.store).map((x) => x.title), ['Ann (PM) on Checkout Flow: Ping']);
});

test("finished cards' files are not read; extra files from Settings are; files nothing links to are forgotten", async () => {
  const { store, call, card, settle } = await connected();
  const done = createCard(store, { title: 'Old flow', stage: 'done' });
  addMaterial(store, done.id, { kind: 'link', url: `https://www.figma.com/design/${OTHER}/Old` });
  asked.length = 0;
  await runFigma(store);
  assert.ok(!asked.some((u) => u.pathname.includes(OTHER)), "a done card's file isn't read");

  files[OTHER] = [comment('o1', 'ann', 'Archive this page')];
  const saved = await call<IntegrationStatus>('PUT', '/api/integrations/figma', { files: [`https://www.figma.com/board/${OTHER}/Old`, `https://www.figma.com/board/${OTHER}/Old-again`] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.settings.files, [`https://www.figma.com/board/${OTHER}/Old`], 'one link per file');
  await settle();
  assert.ok(asked.some((u) => u.pathname === `/v1/files/${OTHER}/comments`), 'listed in Settings, so read');

  // The card is finished and its link removed: its comments go.
  updateCard(store, card.id, { stage: 'done' });
  store.db.prepare('DELETE FROM work_materials WHERE card_id = ?').run(card.id);
  await runFigma(store);
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM figma_comments WHERE file_key = ?').get(KEY) as { n: number }).n, 0);
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM figma_comments WHERE file_key = ?').get(OTHER) as { n: number }).n, 1);
});

// ── When Figma says no ──────────────────────────────────────────────────────

test('one unreadable file is reported on its own; a dead token or a rate limit stops the round', async () => {
  const { store, call, card } = await connected();
  addMaterial(store, card.id, { kind: 'figma', url: `https://www.figma.com/design/${OTHER}/Private` });
  files[OTHER] = 404;
  await runFigma(store);
  const v = (await call<FigmaCardComments>('GET', `/api/figma/cards/${card.id}`)).body;
  assert.match(v.files.find((f) => f.key === OTHER)!.error!, /no file at this link/);
  assert.equal(v.files.find((f) => f.key === KEY)!.error, null);
  const st = (await call<IntegrationStatus>('GET', '/api/integrations/figma')).body;
  assert.deepEqual((st.settings.problems as { name: string }[]).map((p) => p.name), ['Private']);

  files[KEY] = 429;
  await assert.rejects(runFigma(store), (e: unknown) => e instanceof FigmaError && e.kind === 'rate');

  store.db.prepare("UPDATE integrations SET secrets = ? WHERE id = 'figma'").run(JSON.stringify({ token: 'figd_expired' }));
  const run = await call<{ error: string }>('POST', '/api/integrations/figma/run');
  assert.equal(run.status, 400);
  assert.match(run.body.error, /may have expired/);
  assert.match((await call<IntegrationStatus>('GET', '/api/integrations/figma')).body.lastError ?? '', /may have expired/);
});

test('disconnecting deletes the token and the comments; to-dos made from them stay', async () => {
  const { store, call, card } = await connected();
  const made = await call<Task>('POST', '/api/figma/threads/c1/todo', { cardId: card.id });
  assert.equal((await call('DELETE', '/api/integrations/figma')).status, 200);
  assert.equal((await call<IntegrationStatus>('GET', '/api/integrations/figma')).body.configured, false);
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM figma_comments').get() as { n: number }).n, 0);
  assert.equal(store.getTask(made.body.id).title, 'Figma: Make the CTA full width on mobile');
});
