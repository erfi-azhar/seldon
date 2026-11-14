// Regression tests for the agent-core review fixes: grouped chat undo, brains that no
// longer exist, per-client sign-in throttling, and parallel OpenAI calls all numbered 0.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeModel, oaChunk, oaText } from './helpers.ts';
import { chat } from '../src/agent/index.ts';
import type { Provider } from '../src/agent/types.ts';
import { openAiProvider } from '../src/agent/providers/openai.ts';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { healthState } from '../src/features/health.ts';
import { Store } from '../src/store.ts';
import type { AgentEvent } from '../../shared/types.ts';

const context = { date: '2026-11-14', time: '09:00', timezone: 'UTC', viewing: 'Today' };
const H = { 'content-type': 'application/json' };

test('a chat chip undoes everything its tool call logged', async () => {
  const db = openDb(':memory:');
  const app = createApp({ db });
  const store = new Store(db);
  store.onboard({ userName: 'S', agentName: 'Seldon', sphereKeys: ['health'] });
  const sphere = store.listSpheres()[0]!;
  store.createMetric({ sphereId: sphere.id, name: 'Weight', unit: 'kg' });

  let round = 0;
  const provider: Provider = {
    id: 'fake',
    model: 'x',
    async complete() {
      if (round++ > 0) return { text: 'done', toolCalls: [] };
      return {
        text: '',
        toolCalls: [
          { id: 'a', name: 'log_food', input: { items: [{ name: 'rice', kcal: 300 }, { name: 'chicken', kcal: 400 }] } },
          { id: 'b', name: 'log_body_composition', input: { weight_kg: 72.5, body_fat_pct: 20 } },
        ],
      };
    },
  } as Provider;
  const events: AgentEvent[] = [];
  const conversationId = await chat({ store, provider, message: 'rice and chicken; 72.5 on the scale', context, emit: (e) => events.push(e) });
  const ends = events.filter((e): e is Extract<AgentEvent, { type: 'tool_end' }> => e.type === 'tool_end');
  assert.equal(ends.length, 2);
  assert.ok(ends.every((e) => e.ok && e.undoable && e.activityId !== null));

  const before = healthState(store, context.date);
  assert.equal(before.today.entries.length, 2);
  assert.equal(before.body.length, 1);
  // The feed lists each part once; the row tying them together stays out of it.
  assert.ok(store.listActivity({ limit: 50 }).every((a) => a.entityType !== 'activity_group'));

  for (const e of ends) assert.equal((await app.request(`/api/activity/${e.activityId}/undo`, { method: 'POST' })).status, 200);
  const after = healthState(store, context.date);
  assert.deepEqual(after.today.entries, [], 'every food from the call is gone, not just the last');
  assert.equal(after.body.length, 0, 'the body reading goes with its weight entry');
  assert.equal(store.listMetrics(sphere.id)[0]!.entries.length, 0);

  // Reloaded, the chips no longer offer an undo, and a second undo is refused.
  const reloaded = store.getConversation(conversationId).messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool');
  assert.ok(reloaded.every((p) => p.type === 'tool' && p.call.undoable === false));
  assert.equal((await app.request(`/api/activity/${ends[0]!.activityId}/undo`, { method: 'POST' })).status, 409);
});

test('a single-row tool call keeps pointing at that row', async () => {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'S', agentName: 'Seldon', sphereKeys: ['health'] });
  let round = 0;
  const provider = {
    id: 'fake',
    model: 'x',
    async complete() {
      return round++ ? { text: 'ok', toolCalls: [] } : { text: '', toolCalls: [{ id: 'a', name: 'create_task', input: { title: 'Call mum' } }] };
    },
  } as Provider;
  const events: AgentEvent[] = [];
  await chat({ store, provider, message: 'remind me to call mum', context, emit: (e) => events.push(e) });
  const end = events.find((e) => e.type === 'tool_end') as Extract<AgentEvent, { type: 'tool_end' }>;
  assert.equal(store.getActivity(end.activityId!)!.entityType, 'task');
});

test('a conversation whose brain no longer exists falls back to the chat brain', async () => {
  // Machine A: a conversation on its own brain, exported.
  const a = new Store(openDb(':memory:'));
  a.onboard({ userName: 'S', agentName: 'Seldon', sphereKeys: ['health'] });
  const brainA = a.addConnection({ provider: 'openai-compatible', preset: 'ollama', baseUrl: 'http://127.0.0.1:1/v1', model: 'm' });
  const conv = a.createConversation('hello', 'sys', brainA.id);
  a.appendTurn(conv, { role: 'user', text: 'hi', display: 'hi' });
  a.appendTurn(conv, { role: 'assistant', text: 'hello', toolCalls: [] });
  const dump = a.exportAll();

  // Machine B: a fresh install with its own brain restores the export.
  const model = await fakeModel([{ sse: oaText('back again') }, { sse: oaText('still here') }]);
  const db = openDb(':memory:');
  const app = createApp({ db });
  const b = new Store(db);
  b.onboard({ userName: 'S', agentName: 'Seldon', sphereKeys: ['health'] });
  b.addConnection({ provider: 'openai-compatible', preset: 'ollama', baseUrl: `${model.url}/v1`, model: 'm' });
  assert.equal((await app.request('/api/import', { method: 'POST', headers: H, body: JSON.stringify(dump) })).status, 200);
  assert.equal(b.getConversationConnection(conv), null, 'an id from the other install is cleared on import');

  const send = (body: Record<string, unknown>) =>
    app.request('/api/agent/chat', { method: 'POST', headers: H, body: JSON.stringify({ conversationId: conv, message: 'again', context, ...body }) });
  const first = await send({});
  assert.equal(first.status, 200);
  assert.match(await first.text(), /back again/);

  // An open panel still holding a brain that was removed sends its id: answered by the chat brain.
  db.prepare('UPDATE conversations SET connection_id = ? WHERE id = ?').run('gone-brain', conv);
  const second = await send({ connectionId: 'removed-brain' });
  assert.equal(second.status, 200);
  assert.match(await second.text(), /still here/);
  assert.equal(b.getConversationConnection(conv), null, 'the stale id is not kept');
});

test('a stranger guessing cannot lock the owner out of sign-in', async () => {
  const app = createApp({ db: openDb(':memory:'), passphrase: 'correct horse' });
  const login = (passphrase: string, peer: string, forwarded?: string) =>
    app.request(
      'http://localhost/api/auth/login',
      { method: 'POST', headers: { ...H, ...(forwarded ? { 'x-forwarded-for': forwarded } : {}) }, body: JSON.stringify({ passphrase }) },
      { incoming: { socket: { remoteAddress: peer } } },
    );

  // Directly exposed: the socket address is the client, and the header is ignored.
  for (let i = 0; i < 8; i++) assert.equal((await login(`guess-${i}`, '203.0.113.5', `198.51.100.${i}`)).status, 401);
  assert.equal((await login('correct horse', '203.0.113.5')).status, 429, 'the guesser stays throttled');
  assert.equal((await login('correct horse', '198.51.100.7')).status, 200, 'the owner elsewhere still signs in');

  // Behind a proxy: the address the proxy added counts, not what the client put before it.
  for (let i = 0; i < 8; i++) assert.equal((await login(`guess-${i}`, '10.0.0.2', `1.1.1.${i}, 203.0.113.9`)).status, 401);
  assert.equal((await login('correct horse', '10.0.0.2', '7.7.7.7, 203.0.113.9')).status, 429, 'rotating the forged part does not help');
  assert.equal((await login('correct horse', '10.0.0.2', '198.51.100.8')).status, 200);
});

test('sign-in failures from everyone together have a ceiling', async () => {
  const app = createApp({ db: openDb(':memory:'), passphrase: 'right' });
  const login = (passphrase: string, peer: string) =>
    app.request('http://localhost/api/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ passphrase }) }, { incoming: { socket: { remoteAddress: peer } } });
  let refused = 0;
  for (let i = 0; i < 70; i++) if ((await login('wrong', `203.0.113.${i}`)).status === 429) refused++;
  assert.ok(refused > 0, 'a spread-out guesser is still slowed down');
  assert.ok(refused <= 10);
});

test('parallel OpenAI calls all numbered 0 keep their own arguments', async () => {
  const sse =
    oaChunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'create_task', arguments: '' } }] }) +
    oaChunk({ tool_calls: [{ index: 0, function: { arguments: '{"title":"A"}' } }] }) +
    oaChunk({ tool_calls: [{ index: 0, id: 'b', type: 'function', function: { name: 'create_task', arguments: '' } }] }) +
    oaChunk({ tool_calls: [{ index: 0, function: { arguments: '{"title":' } }] }) +
    oaChunk({ tool_calls: [{ index: 0, function: { arguments: '"B"}' } }] }) +
    oaChunk({}, 'tool_calls') +
    'data: [DONE]\n\n';
  const model = await fakeModel([{ sse }]);
  const provider = openAiProvider({ provider: 'openai-compatible', preset: null, baseUrl: `${model.url}/v1`, model: 'm', effort: 'auto', apiKey: '' });
  const res = await provider.complete({ system: 's', turns: [{ role: 'user', text: 'hi', display: 'hi' }], tools: [], onText: () => {} });
  assert.deepEqual(res.toolCalls, [
    { id: 'a', name: 'create_task', input: { title: 'A' } },
    { id: 'b', name: 'create_task', input: { title: 'B' } },
  ]);
});

test('parallel OpenAI calls with their own indexes still stream in order', async () => {
  const sse =
    oaChunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'create_task', arguments: '' } }, { index: 1, id: 'b', type: 'function', function: { name: 'create_note', arguments: '' } }] }) +
    oaChunk({ tool_calls: [{ index: 1, function: { arguments: '{"title":"N"}' } }] }) +
    oaChunk({ tool_calls: [{ index: 0, function: { arguments: '{"title":"T"}' } }] }) +
    oaChunk({}, 'tool_calls') +
    'data: [DONE]\n\n';
  const model = await fakeModel([{ sse }]);
  const provider = openAiProvider({ provider: 'openai-compatible', preset: null, baseUrl: `${model.url}/v1`, model: 'm', effort: 'auto', apiKey: '' });
  const res = await provider.complete({ system: 's', turns: [{ role: 'user', text: 'hi', display: 'hi' }], tools: [], onText: () => {} });
  assert.deepEqual(res.toolCalls, [
    { id: 'a', name: 'create_task', input: { title: 'T' } },
    { id: 'b', name: 'create_note', input: { title: 'N' } },
  ]);
});
