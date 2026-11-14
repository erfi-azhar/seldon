import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { buildDraft, checkMail, setMailSource, type MailSource } from '../src/features/gmail.ts';
import { updateIntegration } from '../src/features/integrations.ts';
import { listSignals } from '../src/features/signals.ts';
import type { MailMessage } from '../src/features/mail-types.ts';
import { Store } from '../src/store.ts';
import { anthropicMessage, fakeModel } from './helpers.ts';

const mail = (uid: number, over: Partial<MailMessage> = {}): MailMessage => ({
  uid,
  messageId: `<m${uid}@example.com>`,
  from: { name: 'Dana Lim', address: 'dana@example.com' },
  to: 'me@gmail.com',
  subject: `Subject ${uid}`,
  date: '2026-11-14T01:00:00.000Z',
  important: false,
  labels: [],
  text: `Body ${uid}`,
  ...over,
});

function fakeBox(inbox: MailMessage[]) {
  const drafts: string[] = [];
  const calls: (number | null)[] = [];
  const factory = (email: string, password: string): MailSource => ({
    async verify() {
      if (password !== 'abcdabcdabcdabcd') throw new Error('Gmail did not accept that address and app password.');
    },
    async fetchNew(sinceUid) {
      calls.push(sinceUid);
      const messages = inbox.filter((m) => sinceUid === null || m.uid > sinceUid);
      return { messages, uidValidity: '7', maxUid: Math.max(sinceUid ?? 0, ...inbox.map((m) => m.uid)) };
    },
    async saveDraft(raw) {
      drafts.push(raw);
    },
  });
  return { factory, drafts, calls };
}

function connected(): Store {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['work', 'finances'] });
  updateIntegration(store, 'gmail', (r) => {
    r.enabled = true;
    r.settings = { email: 'me@gmail.com', lookbackDays: 3 };
    r.secrets = { appPassword: 'abcdabcdabcdabcd' };
  });
  return store;
}

test('the background brain triages new mail; only what matters becomes a signal, once', async () => {
  const store = connected();
  const box = fakeBox([
    mail(1, { subject: 'Offsite dates', text: 'Can you confirm the 4th by Friday?' }),
    mail(2, { from: { name: 'Shop', address: 'deals@shop.example' }, subject: '50% off', labels: ['\\Important', 'CATEGORY_PROMOTIONS'] }),
  ]);
  setMailSource(box.factory);
  const verdicts = {
    messages: [
      { uid: 1, important: true, priority: 2, category: 'reply', summary: 'Dana needs you to confirm the offsite on the 4th by Friday.', sphere: 'Work', follow_up: { kind: 'reply', title: 'Reply to Dana about the offsite', due_date: '2026-11-20', reply: 'Hi Dana, the 4th works for me.' } },
      { uid: 2, important: false, priority: 0, category: 'promotion', summary: 'A sale.', sphere: null, follow_up: { kind: 'none' } },
    ],
  };
  const model = await fakeModel([{ sse: anthropicMessage([{ type: 'text', text: JSON.stringify(verdicts) }], 'end_turn') }]);
  store.addConnection({ provider: 'anthropic', baseUrl: model.url, apiKey: 'k', model: 'claude-opus-5-5' });

  assert.deepEqual(await checkMail(store), { checked: 2, surfaced: 1 });
  const [s] = listSignals(store);
  assert.equal(s!.title, 'Dana Lim: Offsite dates');
  assert.equal(s!.priority, 2);
  assert.equal(s!.sphereId, store.listSpheres().find((x) => x.name === 'Work')!.id);
  assert.deepEqual(s!.actions.map((a) => a.type), ['reply', 'task', 'link']);
  assert.match(s!.url, /mail\.google\.com\/mail\/u\/me%40gmail\.com\/#search\/rfc822msgid%3Am1%40example\.com/);

  // The model saw the mail as fenced, untrusted data and had no tools.
  const req = model.seen[0]!.body;
  assert.equal(req.tools, undefined);
  assert.match(req.messages[0].content, /<untrusted source="email">[\s\S]*Offsite dates/);

  // Next run asks only for newer mail and raises nothing twice.
  assert.deepEqual(await checkMail(store), { checked: 0, surfaced: 0 });
  assert.deepEqual(box.calls, [null, 2]);
});

test('with no brain connected, Gmail\'s own Important label decides', async () => {
  const store = connected();
  setMailSource(fakeBox([mail(5, { important: true, labels: ['\\Important'] }), mail(6, { important: true, labels: ['\\Important', 'CATEGORY_PROMOTIONS'] }), mail(7)]).factory);
  assert.deepEqual(await checkMail(store), { checked: 3, surfaced: 1 });
  assert.equal(listSignals(store)[0]!.data.triagedBy, 'gmail');
});

test('acting on a signal: a reply becomes a Gmail draft (never sent), a task becomes a task', async () => {
  const db = openDb(':memory:');
  const store = new Store(db);
  updateIntegration(store, 'gmail', (r) => {
    r.enabled = true;
    r.settings = { email: 'me@gmail.com' };
    r.secrets = { appPassword: 'abcdabcdabcdabcd' };
  });
  const box = fakeBox([mail(9, { important: true, labels: ['\\Important'], subject: 'Café — rendez-vous' })]);
  setMailSource(box.factory);
  await checkMail(store);
  const app = createApp({ db });
  const signal = listSignals(store)[0]!;
  const act = (index: number) =>
    app.request(`http://localhost/api/signals/${signal.id}/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index }) });
  const res = await act(0);
  assert.equal(res.status, 200);
  assert.equal(store.listTasks()[0]!.title, 'Follow up: Café — rendez-vous');
  assert.equal(listSignals(store).length, 0, 'acted-on signals leave the inbox');

  const raw = buildDraft('me@gmail.com', { type: 'reply', label: '', to: 'dana@example.com\r\nBcc: evil@x', subject: 'Re: Café', body: 'Merci!\nÀ bientôt', inReplyTo: '<m9@example.com>' });
  assert.match(raw, /^From: me@gmail\.com\r\nTo: dana@example\.com Bcc: evil@x\r\n/, 'no header injection');
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, /In-Reply-To: <m9@example\.com>/);
  assert.equal(Buffer.from(raw.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Merci!\r\nÀ bientôt');
});

test('connecting checks the app password first and never returns it', async () => {
  const db = openDb(':memory:');
  setMailSource(fakeBox([]).factory);
  const app = createApp({ db });
  const put = (body: object) => app.request('http://localhost/api/integrations/gmail', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put({ email: 'me@gmail.com', appPassword: 'wrong' })).status, 400);
  const ok = await put({ email: 'me@gmail.com', appPassword: 'abcd abcd abcd abcd' });
  assert.equal(ok.status, 200);
  const text = await (await app.request('http://localhost/api/integrations')).text();
  assert.ok(text.includes('"gmail"') && !text.includes('abcdabcd'));
});
