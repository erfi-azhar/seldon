// The agent, exercised end to end against stand-in model servers that speak the real
// wire formats (OpenAI chat-completions SSE and Anthropic Messages SSE).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicMessage, fakeModel, oaText, oaToolCall } from './helpers.ts';
import { chat } from '../src/agent/index.ts';
import { anthropicProvider } from '../src/agent/providers/anthropic.ts';
import { openAiProvider } from '../src/agent/providers/openai.ts';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { Store, type ModelConfig } from '../src/store.ts';
import type { AgentEvent, ChatContext } from '../../shared/types.ts';

const CONTEXT: ChatContext = { date: '2026-11-13', time: '09:15', timezone: 'UTC', viewing: 'Today' };

// ── Harness ─────────────────────────────────────────────────────────────────

function setup(): { store: Store; sphereId: string } {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['health', 'work'] });
  return { store, sphereId: store.listSpheres(CONTEXT.date)[0]!.id };
}

const config = (over: Partial<ModelConfig>): ModelConfig => ({
  provider: 'openai-compatible',
  preset: null,
  baseUrl: '',
  model: 'test-model',
  effort: 'auto',
  apiKey: '',
  ...over,
});

async function run(store: Store, provider: ReturnType<typeof openAiProvider>, message: string, conversationId?: string) {
  const events: AgentEvent[] = [];
  const id = await chat({ store, provider, message, conversationId, context: CONTEXT, emit: (e) => events.push(e) });
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  return { id, events, text };
}

// ── OpenAI-compatible ───────────────────────────────────────────────────────

test('openai-compatible: a tool round trip changes the data, and history is append-only', async () => {
  const { store, sphereId } = setup();
  const model = await fakeModel([
    { sse: oaToolCall('call_1', 'create_task', { title: 'Book the dentist', sphere_id: sphereId, due_date: '2026-11-20' }) },
    { sse: oaText('Added it ', 'for the 20th.') },
    { sse: oaText('You have one task.') },
  ]);
  const provider = openAiProvider(config({ baseUrl: `${model.url}/v1`, apiKey: 'k-123' }));

  const first = await run(store, provider, 'I need to book the dentist next Friday');
  assert.equal(first.text, 'Added it for the 20th.');
  assert.deepEqual(first.events.map((e) => e.type), ['meta', 'tool_start', 'tool_end', 'text', 'text', 'done']);

  const tasks = store.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.title, 'Book the dentist');
  assert.equal(tasks[0]!.dueDate, '2026-11-20');
  assert.equal(tasks[0]!.sphereId, sphereId);

  const end = first.events.find((e) => e.type === 'tool_end')!;
  assert.equal(end.type === 'tool_end' && end.ok, true);
  assert.equal(end.type === 'tool_end' && end.undoable, true);
  const activity = store.getActivity((end as { activityId: number }).activityId)!;
  assert.equal(activity.actor, 'agent');

  // What the model was sent.
  const [req1, req2] = model.seen;
  assert.equal(req1!.path, '/v1/chat/completions');
  assert.equal(req1!.headers.authorization, 'Bearer k-123');
  assert.equal(req1!.body.messages[0].role, 'system');
  assert.match(req1!.body.messages[0].content, /You are Seldon/);
  assert.match(req1!.body.messages[1].content, /<terminus_snapshot/);
  assert.match(req1!.body.messages[1].content, new RegExp(`\\[sphere ${sphereId}\\]`));
  assert.ok(req1!.body.tools.some((t: { function: { name: string } }) => t.function.name === 'create_task'));
  assert.deepEqual(req2!.body.messages.map((m: { role: string }) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(req2!.body.messages[2].tool_calls[0].id, 'call_1');
  assert.equal(req2!.body.messages[3].tool_call_id, 'call_1');

  // A follow-up in the same conversation only appends.
  const second = await run(store, provider, 'What do I have open?', first.id);
  assert.equal(second.id, first.id);
  const req3 = model.seen[2]!;
  assert.deepEqual(req3.body.messages.slice(0, 4), [...req2!.body.messages]);
  assert.equal(req3.body.messages.length, 6);
  assert.match(req3.body.messages[5].content, /^<now>/);
  assert.doesNotMatch(req3.body.messages[5].content, /terminus_snapshot/);

  // And the person sees one reply per question, with the tool call folded in.
  const view = store.getConversation(first.id).messages;
  assert.deepEqual(view.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(view[0]!.parts, [{ type: 'text', text: 'I need to book the dentist next Friday' }]);
  assert.deepEqual(view[1]!.parts.map((p) => p.type), ['tool', 'text']);
  const part = view[1]!.parts[0]!;
  assert.equal(part.type === 'tool' && part.call.summary, 'Added task: Book the dentist (due Nov 20)');
});

test('bad tool input is never run: the model gets the problem back and can correct itself', async () => {
  const { store } = setup();
  const model = await fakeModel([
    { sse: oaToolCall('call_1', 'log_metric', { metric_id: 'does-not-exist', value: 'seventy' }) },
    { sse: oaToolCall('call_2', 'no_such_tool', {}) },
    { sse: oaText('Sorry — I could not log that.') },
  ]);
  const { events } = await run(store, openAiProvider(config({ baseUrl: `${model.url}/v1` })), 'log my weight');
  const ends = events.filter((e) => e.type === 'tool_end');
  assert.equal(ends.length, 2);
  assert.ok(ends.every((e) => e.type === 'tool_end' && !e.ok && e.activityId === null));
  assert.match(model.seen[1]!.body.messages[3].content, /INVALID_INPUT/);
  assert.match(model.seen[2]!.body.messages[5].content, /Unknown tool/);
});

test('openai-compatible: an unreachable or unhappy server becomes a readable error', async () => {
  const { store } = setup();
  const down = await run(store, openAiProvider(config({ baseUrl: 'http://127.0.0.1:9/v1' })), 'hello');
  const err = down.events.at(-1)!;
  assert.equal(err.type, 'error');
  assert.match((err as { message: string }).message, /Could not reach http:\/\/127\.0\.0\.1:9\/v1/);

  const model = await fakeModel([{ status: 401, json: { error: { message: 'bad key' } } }]);
  const denied = await run(store, openAiProvider(config({ baseUrl: `${model.url}/v1`, apiKey: 'nope' })), 'hello');
  assert.match((denied.events.at(-1) as { message: string }).message, /did not accept the API key/);
});

// ── Anthropic ───────────────────────────────────────────────────────────────

test('anthropic: reasoning blocks are replayed untouched, system stays frozen, results return together', async () => {
  const { store, sphereId } = setup();
  const habit = store.createHabit({ sphereId, name: 'Morning walk' });
  const model = await fakeModel([
    {
      sse: anthropicMessage(
        [
          { type: 'thinking', signature: 'sig-abc' },
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', id: 'toolu_1', name: 'log_habit', input: { habit_id: habit.id } },
          { type: 'tool_use', id: 'toolu_2', name: 'remember', input: { fact: 'Walks before breakfast.' } },
        ],
        'tool_use',
      ),
    },
    { sse: anthropicMessage([{ type: 'text', text: 'Checked in your walk.' }], 'end_turn') },
    { sse: anthropicMessage([{ type: 'text', text: 'Still done.' }], 'end_turn') },
  ]);
  const provider = anthropicProvider(config({ provider: 'anthropic', model: '', apiKey: 'sk-ant-test', effort: 'low' }), model.url);
  assert.equal(provider.model, 'claude-opus-5-5');

  const first = await run(store, provider, 'did my walk this morning');
  assert.equal(first.text, 'On it.Checked in your walk.');
  assert.equal(store.getHabit(habit.id, CONTEXT.date).doneToday, true);
  assert.equal(store.listMemories()[0]!.content, 'Walks before breakfast.');

  const [req1, req2] = model.seen;
  assert.match(req1!.path, /^\/v1\/messages/);
  assert.equal(req1!.headers.authorization, 'Bearer sk-ant-test');
  assert.match(String(req1!.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  assert.equal(req1!.body.model, 'claude-opus-5-5');
  assert.equal(req1!.body.fallbacks, 'default');
  assert.deepEqual(req1!.body.output_config, { effort: 'low' });
  assert.equal(req1!.body.thinking, undefined, 'thinking is left to the model default');
  assert.equal(req1!.body.tool_choice, undefined);
  assert.ok(req1!.body.tools.every((t: { eager_input_streaming?: boolean }) => t.eager_input_streaming === true));
  assert.equal(req1!.body.stream, true);

  // Round two: the assistant turn comes back exactly as it was sent to us.
  const replayed = req2!.body.messages[1];
  assert.equal(replayed.role, 'assistant');
  assert.deepEqual(replayed.content.map((b: { type: string }) => b.type), ['thinking', 'text', 'tool_use', 'tool_use']);
  assert.equal(replayed.content[0].signature, 'sig-abc');
  const results = req2!.body.messages[2];
  assert.equal(results.role, 'user');
  assert.deepEqual(results.content.map((b: { tool_use_id: string }) => b.tool_use_id), ['toolu_1', 'toolu_2']);
  assert.deepEqual(req2!.body.system, req1!.body.system);
  assert.deepEqual(req2!.body.tools, req1!.body.tools);

  // A later message, after the person's name changed: the stored system prompt still wins.
  store.updateSettings({ profile: { userName: 'Samantha' } });
  await run(store, provider, 'and now?', first.id);
  const req3 = model.seen[2]!;
  assert.deepEqual(req3.body.system, req1!.body.system);
  assert.deepEqual(req3.body.messages.slice(0, 3), req2!.body.messages);
});

test('anthropic: a custom endpoint gets no beta fields', async () => {
  const { store } = setup();
  const model = await fakeModel([{ sse: anthropicMessage([{ type: 'text', text: 'hi' }], 'end_turn') }]);
  await run(store, anthropicProvider(config({ provider: 'anthropic', baseUrl: model.url, apiKey: 'k' })), 'hello');
  const req = model.seen[0]!;
  assert.equal(req.body.fallbacks, undefined);
  assert.equal(req.headers['anthropic-beta'], undefined);
  assert.equal(req.body.output_config, undefined);
  assert.ok(req.body.tools.every((t: Record<string, unknown>) => !('eager_input_streaming' in t)));
});

test('anthropic: if earlier reasoning is rejected, it is dropped and the request retried once', async () => {
  const { store } = setup();
  const model = await fakeModel([
    { sse: anthropicMessage([{ type: 'thinking', signature: 's1' }, { type: 'tool_use', id: 'toolu_1', name: 'get_overview', input: {} }], 'tool_use') },
    { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'thinking block prefix mismatch' } } },
    { sse: anthropicMessage([{ type: 'text', text: 'All good.' }], 'end_turn') },
  ]);
  const { text, events } = await run(store, anthropicProvider(config({ provider: 'anthropic', apiKey: 'k' }), model.url), 'check in');
  assert.equal(text, 'All good.');
  assert.equal(events.at(-1)!.type, 'done');
  assert.deepEqual(model.seen[1]!.body.messages[1].content.map((b: { type: string }) => b.type), ['thinking', 'tool_use']);
  assert.deepEqual(model.seen[2]!.body.messages[1].content.map((b: { type: string }) => b.type), ['tool_use']);
});

test('anthropic: a refusal runs no tools; a cut-off tool call runs no tools', async () => {
  const { store } = setup();
  const refused = await fakeModel([
    {
      sse: anthropicMessage([{ type: 'tool_use', id: 'toolu_1', name: 'create_task', input: { title: 'x' } }], 'refusal', {
        stop_details: { type: 'refusal', category: null, explanation: 'Not something I can help with.' },
      }),
    },
  ]);
  const a = await run(store, anthropicProvider(config({ provider: 'anthropic', apiKey: 'k' }), refused.url), 'hmm');
  assert.match(a.text, /declined to respond/);
  assert.equal(store.listTasks().length, 0);

  const cut = await fakeModel([
    { sse: anthropicMessage([{ type: 'tool_use', id: 'toolu_1', name: 'create_task', rawInput: '{"title": "Half a ti' }], 'max_tokens') },
  ]);
  const b = await run(store, anthropicProvider(config({ provider: 'anthropic', apiKey: 'k' }), cut.url), 'add a task');
  assert.match(b.text, /cut off/);
  assert.equal(store.listTasks().length, 0);
});

test('anthropic: a rejected key is explained, not dumped', async () => {
  const { store } = setup();
  const model = await fakeModel([{ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }]);
  const { events } = await run(store, anthropicProvider(config({ provider: 'anthropic', apiKey: 'bad' }), model.url), 'hello');
  assert.deepEqual(events.at(-1), { type: 'error', message: 'Anthropic did not accept the API key. Check it in Settings → Model.' });
});

// ── Through the HTTP API ────────────────────────────────────────────────────

test('POST /api/agent/chat streams events, and says so plainly when no model is connected', async () => {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.onboard({ userName: '', agentName: 'Seldon', sphereKeys: ['health'] });
  const app = createApp({ db });
  const body = JSON.stringify({ message: 'hello', context: CONTEXT });
  const post = () => app.request('http://localhost/api/agent/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body });

  const none = await post();
  assert.equal(none.status, 409);
  assert.equal(((await none.json()) as { code: string }).code, 'no_model');

  const model = await fakeModel([{ sse: oaText('Hello there.') }]);
  store.updateSettings({ model: { provider: 'openai-compatible', baseUrl: `${model.url}/v1`, model: 'm' } });
  const res = await post();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const events = (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as AgentEvent);
  assert.deepEqual(events.map((e) => e.type), ['meta', 'text', 'done']);
  assert.equal(store.listConversations().length, 1);
});
