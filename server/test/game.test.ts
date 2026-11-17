import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSnapshot } from '../src/agent/prompt.ts';
import { openDb } from '../src/db.ts';
import '../src/features/index.ts';
import { answerPrompt, answerReset, finishReset, gamePlan, gameState, promptsFor, quests, sendDuePrompts, setQuests, startReset, toggleQuest, updatePlan } from '../src/features/game.ts';
import { setPushSender } from '../src/features/journey.ts';
import { Store } from '../src/store.ts';
import { DAY_PROMPTS, RESET_SECTIONS } from '../../shared/game.ts';

const DAY = '2026-11-17'; // a Tuesday

function fresh(): Store {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['health', 'work'] });
  return store;
}

test('the game plan saves in parts, and an update can be undone', () => {
  const store = fresh();
  assert.equal(gamePlan(store).vision, '');
  updatePlan(store, { vision: 'Strong, present, building my own thing', mission: { text: 'Ship the product', by: '2027-11-17' } });
  updatePlan(store, { rules: ['Salah first', '', 'Dinner with family'] });
  const p = gamePlan(store);
  assert.equal(p.vision, 'Strong, present, building my own thing');
  assert.equal(p.mission.by, '2027-11-17');
  assert.deepEqual(p.rules, ['Salah first', 'Dinner with family'], 'blank rules are dropped');

  const last = store.listActivity()[0]!;
  assert.equal(last.undoable, true);
  store.undo(last.id);
  assert.deepEqual(gamePlan(store).rules, [], 'undo restores the plan as it was');
  assert.equal(gamePlan(store).vision, 'Strong, present, building my own thing');
});

test('quests: two or three for the day, sorted by time, ticked off, never more than five', () => {
  const store = fresh();
  const list = setQuests(store, DAY, [{ title: 'Write 500 words', time: '09:00' }, { title: 'Gym', time: '07:00' }, { title: 'Read' }]);
  assert.deepEqual(list.map((q) => q.title), ['Gym', 'Write 500 words', 'Read']);
  toggleQuest(store, DAY, list[0]!.id);
  assert.equal(quests(store, DAY)[0]!.done, true);
  // Setting the list again keeps what was ticked off.
  setQuests(store, DAY, [{ title: 'gym', time: '07:00' }, { title: 'Call Mum' }]);
  assert.equal(quests(store, DAY).find((q) => q.title === 'gym')!.done, true);
  assert.throws(() => setQuests(store, DAY, Array.from({ length: 6 }, (_, i) => ({ title: `q${i}` }))), /five at most/);
});

test('a reset day collects answers, then becomes the game plan and tomorrow’s quests', () => {
  const store = fresh();
  startReset(store, DAY);
  assert.throws(() => answerReset(store, 'not-a-question', 'x'), /Unknown question/);
  answerReset(store, 'tolerate', 'Feeling tired by 3pm every day');
  answerReset(store, 'identity_new', 'I am the kind of person who keeps promises to myself');
  answerReset(store, 'anti_vision', 'Forty, heavier, still talking about the business I never started');
  answerReset(store, 'vision_mvp', 'Fit, calm, and running something of my own');
  answerReset(store, 'enemy', 'Waiting to feel ready');
  answerReset(store, 'one_year', 'Ten paying customers');
  answerReset(store, 'one_month', 'A working prototype in front of five people');
  answerReset(store, 'tomorrow', '- Gym before work\n- Two hours on the prototype\n- Fajr on time');
  answerReset(store, 'rules', 'Salah on time; Evenings with family');
  const { plan, reset } = finishReset(store, DAY);
  assert.ok(reset.finishedAt);
  assert.equal(plan.vision, 'Fit, calm, and running something of my own');
  assert.equal(plan.antiVision, 'Forty, heavier, still talking about the business I never started');
  assert.equal(plan.identity, 'I am the kind of person who keeps promises to myself');
  assert.equal(plan.enemy, 'Waiting to feel ready');
  assert.deepEqual(plan.mission, { text: 'Ten paying customers', by: '2027-11-17' });
  assert.deepEqual(plan.project, { text: 'A working prototype in front of five people', by: '2026-12-17' });
  assert.deepEqual(plan.rules, ['Salah on time', 'Evenings with family']);
  assert.deepEqual(quests(store, '2026-11-18').map((q) => q.title), ['Gym before work', 'Two hours on the prototype', 'Fajr on time']);
  // The answers are kept with the reset.
  assert.equal(gameState(store, DAY).reset!.answers.tolerate, 'Feeling tired by 3pm every day');
});

test('timed questions: all six on a reset day, a couple when daily prompts are on, each sent once', async () => {
  const store = fresh();
  store.setZone('Asia/Singapore');
  assert.deepEqual(promptsFor(store, DAY), [], 'nothing on an ordinary weekday by default');
  assert.deepEqual(promptsFor(store, '2026-11-22').map((p) => p.id), ['steer'], 'Sunday brings the weekly steer');
  startReset(store, DAY);
  assert.equal(promptsFor(store, DAY).length, DAY_PROMPTS.length);

  store.db.prepare('INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, created_at) VALUES (?,?,?,?,?,?)').run('s1', 'https://push.example/1', 'k', 'a', 'phone', new Date().toISOString());
  const sent: string[] = [];
  setPushSender(async (_sub, payload) => void sent.push(JSON.parse(payload).body));
  try {
    // 11:05 in Singapore is 03:05Z: the 11:00 question is due.
    assert.deepEqual(await sendDuePrompts(store, new Date('2026-11-17T03:05:00Z')), ['avoiding']);
    assert.deepEqual(await sendDuePrompts(store, new Date('2026-11-17T03:10:00Z')), [], 'not twice');
    // An hour late is too late to ask.
    assert.deepEqual(await sendDuePrompts(store, new Date('2026-11-17T06:45:00Z')), [], '13:30 question at 14:45 is skipped');
    assert.equal(sent.length, 1);
  } finally {
    setPushSender(null);
  }
  // An answer to a timed question on reset day joins the reset's answers.
  answerPrompt(store, DAY, 'avoiding', 'Writing the deck');
  assert.equal(gameState(store, DAY).reset!.answers.avoiding, 'Writing the deck');
  assert.equal(gameState(store, DAY).answered.avoiding, 'Writing the deck');
});

test('Seldon sees the game plan in its snapshot, and is told not to answer a reset for them', () => {
  const store = fresh();
  assert.doesNotMatch(renderSnapshot(store, DAY), /Game plan/);
  updatePlan(store, { vision: 'Running my own studio', project: { text: 'Five client calls', by: '2026-12-17' } });
  setQuests(store, DAY, [{ title: 'Two calls', time: '10:00' }]);
  startReset(store, DAY);
  const snap = renderSnapshot(store, DAY);
  assert.match(snap, /Running my own studio/);
  assert.match(snap, /boss fight \(by 2026-12-17\): Five client calls/);
  assert.match(snap, /10:00 Two calls/);
  assert.match(snap, /Do not answer its questions for them/);
});

test('every reset question has a unique id', () => {
  const ids = RESET_SECTIONS.flatMap((s) => s.questions.map((q) => q.id));
  assert.equal(new Set(ids).size, ids.length);
});
