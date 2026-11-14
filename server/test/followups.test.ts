import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { followupsSettled, sweep } from '../src/features/followups.ts';
import { Store } from '../src/store.ts';
import type { TaskFollowups } from '../../shared/types.ts';
import { anthropicMessage, fakeModel } from './helpers.ts';

const reply = (answer: unknown) => ({ sse: anthropicMessage([{ type: 'text', text: JSON.stringify(answer) }], 'end_turn') });

const GALLBLADDER = {
  relevant: true,
  summary: 'Gallstones are usually seen by a general surgeon; one who focuses on the liver and gallbladder (hepatobiliary) is ideal.',
  steps: [
    { title: 'Get a referral', detail: 'A GP or polyclinic referral can make the visit subsidised.', ask: null, task: { title: 'Get a GP referral to a surgeon', due_date: '2026-11-18' } },
    { title: 'Book the consultation', detail: 'Ask for the earliest slot.', ask: { label: 'Ask Seldon to book it', prompt: 'Help me book a consultation with a hepatobiliary surgeon.' }, task: null },
  ],
};

function setup() {
  const db = openDb(':memory:');
  const app = createApp({ db });
  const store = new Store(db);
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['health'] });
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await app.request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { store, call };
}

test('a task gets suggestions from the background brain, with a step that becomes a task', async () => {
  const { store, call } = setup();
  const model = await fakeModel([reply(GALLBLADDER)]);
  store.addConnection({ provider: 'anthropic', baseUrl: model.url, apiKey: 'k', model: 'claude-opus-5-5' });
  const health = store.listSpheres()[0]!;
  const task = store.createTask({ title: 'Book a surgeon consultation about my gallbladder', notes: 'Bring both ultrasound reports.', sphereId: health.id, dueDate: '2026-11-21' });

  const first = await call<TaskFollowups>('GET', `/api/tasks/${task.id}/followups`);
  assert.equal(first.body.status, 'pending', 'opening a task starts Seldon thinking');
  await followupsSettled();

  const ready = await call<TaskFollowups>('GET', `/api/tasks/${task.id}/followups`);
  assert.equal(ready.body.status, 'ready');
  assert.match(ready.body.summary, /hepatobiliary/);
  assert.equal(ready.body.steps.length, 2);
  assert.equal(ready.body.steps[1]!.ask?.label, 'Ask Seldon to book it');
  assert.deepEqual(ready.body.steps[0]!.task, { title: 'Get a GP referral to a surgeon', dueDate: '2026-11-18' });

  const sent = JSON.stringify(model.seen[0]!.body);
  assert.match(sent, /Book a surgeon consultation/, 'the task is read');
  assert.match(sent, /untrusted source=\\"task\\"/, 'as data, not instructions');
  assert.match(sent, /Area of life: Health/);

  const added = await call<{ task: { title: string; sphereId: string; dueDate: string; notes: string }; followups: TaskFollowups }>('POST', `/api/tasks/${task.id}/followups/0/task`);
  assert.equal(added.status, 201);
  assert.equal(added.body.task.title, 'Get a GP referral to a surgeon');
  assert.equal(added.body.task.sphereId, health.id, 'the follow-up lands in the same sphere');
  assert.equal(added.body.task.dueDate, '2026-11-18');
  assert.equal(added.body.followups.steps[0]!.added, true);
  assert.equal((await call('POST', `/api/tasks/${task.id}/followups/0/task`)).status, 400, 'a step is added once');
  assert.equal((await call('POST', `/api/tasks/${task.id}/followups/1/task`)).status, 404, 'a step with no task has nothing to add');
});

test('simple tasks get nothing, edits make suggestions stale, and without a brain it says so', async () => {
  const { store, call } = setup();
  const task = store.createTask({ title: 'Buy milk' });
  assert.equal((await call<TaskFollowups>('GET', `/api/tasks/${task.id}/followups`)).body.status, 'unavailable');

  const model = await fakeModel([reply({ relevant: false, summary: '', steps: [] }), reply({ relevant: false, summary: '', steps: [] })]);
  store.addConnection({ provider: 'anthropic', baseUrl: model.url, apiKey: 'k', model: 'claude-opus-5-5' });
  await call('GET', `/api/tasks/${task.id}/followups`);
  await followupsSettled();
  assert.equal((await call<TaskFollowups>('GET', `/api/tasks/${task.id}/followups`)).body.status, 'none');
  assert.equal(model.seen.length, 1);

  // A sphere change does not change what the task asks for; a new title does.
  store.updateTask(task.id, { title: 'Buy oat milk' });
  assert.equal((await call<TaskFollowups>('GET', `/api/tasks/${task.id}/followups`)).body.status, 'pending');
  await followupsSettled();
  assert.equal(model.seen.length, 2);

  store.updateTask(task.id, { done: true });
  assert.equal((await call<TaskFollowups>('GET', `/api/tasks/${task.id}/followups`)).body.status, 'none', 'done tasks are left alone');
});

test('the sweep reads recent open tasks a few at a time, including ones Seldon added', async () => {
  const { store } = setup();
  const model = await fakeModel(Array.from({ length: 6 }, () => reply({ relevant: false, summary: '', steps: [] })));
  store.addConnection({ provider: 'anthropic', baseUrl: model.url, apiKey: 'k', model: 'claude-opus-5-5' });
  for (let i = 0; i < 6; i++) store.as('agent').createTask({ title: `Task ${i}` });
  const done = store.createTask({ title: 'Finished already' });
  store.updateTask(done.id, { done: true });

  await sweep(store);
  assert.equal(model.seen.length, 4, 'at most four per run');
  await sweep(store);
  assert.equal(model.seen.length, 6, 'the rest on the next run; done tasks are skipped');
  await sweep(store);
  assert.equal(model.seen.length, 6, 'nothing is read twice');
});

test('a failed answer is recorded and can be tried again', async () => {
  const { store, call } = setup();
  const model = await fakeModel([{ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } }, reply(GALLBLADDER)]);
  store.addConnection({ provider: 'anthropic', baseUrl: model.url, apiKey: 'k', model: 'claude-opus-5-5' });
  const task = store.createTask({ title: 'Book a surgeon consultation' });
  await call('GET', `/api/tasks/${task.id}/followups`);
  await followupsSettled();
  assert.equal((await call<TaskFollowups>('GET', `/api/tasks/${task.id}/followups`)).body.status, 'failed');
  await sweep(store);
  assert.equal(model.seen.length, 1, 'a failure is not retried on its own every minute');

  assert.equal((await call<TaskFollowups>('POST', `/api/tasks/${task.id}/followups/refresh`)).body.status, 'pending');
  await followupsSettled();
  assert.equal((await call<TaskFollowups>('GET', `/api/tasks/${task.id}/followups`)).body.status, 'ready');
});
