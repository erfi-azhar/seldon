import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';
import { addDays, Invalid, NotFound, Store } from '../src/store.ts';

const TODAY = '2026-11-13';

function fresh(): Store {
  return new Store(openDb(':memory:'));
}

test('goal progress follows milestones, then a linked metric, then manual percent', () => {
  const s = fresh();
  const sphere = s.createSphere({ key: 'health' });

  const stepped = s.createGoal({ sphereId: sphere.id, title: 'Run 10 km', milestones: ['5 km', '8 km', '10 km', 'Race'] });
  assert.equal(stepped.progress, 0);
  assert.equal(stepped.progressSource, 'milestones');
  s.updateMilestone(stepped.milestones[0]!.id, { done: true });
  assert.equal(s.getGoal(stepped.id).progress, 0.25);

  const weight = s.createMetric({ sphereId: sphere.id, name: 'Weight', unit: 'kg', direction: 'down' });
  s.addMetricEntry(weight.id, { value: 80, date: addDays(TODAY, -10) });
  const measured = s.createGoal({ sphereId: sphere.id, title: 'Reach 75 kg', metricId: weight.id, targetValue: 75 });
  assert.equal(measured.startValue, 80, 'start defaults to the latest reading');
  assert.equal(measured.progress, 0);
  s.addMetricEntry(weight.id, { value: 78, date: TODAY });
  assert.equal(s.getGoal(measured.id).progress, 0.4);
  assert.equal(s.getGoal(measured.id).progressSource, 'metric');
  s.addMetricEntry(weight.id, { value: 70, date: addDays(TODAY, 1) });
  assert.equal(s.getGoal(measured.id).progress, 1, 'never past 100%');

  const manual = s.createGoal({ sphereId: sphere.id, title: 'Feel rested' });
  assert.equal(s.updateGoal(manual.id, { manualProgress: 30 }).progress, 0.3);
  const done = s.updateGoal(manual.id, { status: 'done' });
  assert.equal(done.progress, 1);
  assert.ok(done.completedAt);
});

test('logging a metric twice on one day replaces the value', () => {
  const s = fresh();
  const sphere = s.createSphere({ key: 'finances' });
  const m = s.createMetric({ sphereId: sphere.id, name: 'Savings' });
  s.addMetricEntry(m.id, { value: 100, date: TODAY });
  s.addMetricEntry(m.id, { value: 120, date: TODAY });
  const after = s.getMetric(m.id);
  assert.equal(after.entries.length, 1);
  assert.equal(after.latest, 120);
  assert.throws(() => s.addMetricEntry(m.id, { value: Number.NaN }), Invalid);
});

test('habit streaks: daily survives an unchecked today, weekly counts whole weeks on target', () => {
  const s = fresh();
  const sphere = s.createSphere({ key: 'faith' });

  const daily = s.createHabit({ sphereId: sphere.id, name: 'Prayer' });
  for (const back of [1, 2, 3]) s.setHabitLog(daily.id, addDays(TODAY, -back), true, TODAY);
  let h = s.getHabit(daily.id, TODAY);
  assert.equal(h.streak, 3, 'yesterday-anchored while today is still open');
  assert.equal(h.doneToday, false);
  h = s.setHabitLog(daily.id, TODAY, undefined, TODAY);
  assert.equal(h.streak, 4);
  assert.equal(h.weekCount, 4);
  h = s.setHabitLog(daily.id, TODAY, undefined, TODAY);
  assert.equal(h.doneToday, false, 'toggling again unchecks');

  const weekly = s.createHabit({ sphereId: sphere.id, name: 'Gym', cadence: 'weekly', targetPerWeek: 2 });
  for (const back of [0, 2, 8, 10, 15, 16]) s.setHabitLog(weekly.id, addDays(TODAY, -back), true, TODAY);
  assert.equal(s.getHabit(weekly.id, TODAY).streak, 3);
  assert.equal(s.getHabit(weekly.id, TODAY).targetPerWeek, 2);
});

test('sphere pulse blends habit check-ins with recency', () => {
  const s = fresh();
  const sphere = s.createSphere({ key: 'health' });
  const habit = s.createHabit({ sphereId: sphere.id, name: 'Walk' });
  assert.equal(s.getSphere(sphere.id, TODAY).stats.habitRate, 0);
  for (let i = 0; i < 7; i++) s.setHabitLog(habit.id, addDays(TODAY, -i), true, TODAY);
  const stats = s.getSphere(sphere.id, TODAY).stats;
  assert.equal(stats.habitRate, 1);
  assert.ok(stats.pulse > 0.9);

  const empty = s.createSphere({ name: 'Garden' });
  assert.equal(s.getSphere(empty.id, TODAY).stats.habitRate, null);
});

test('the agent’s writes are attributed and can be undone', () => {
  const s = fresh();
  const agent = s.as('agent');
  const sphere = s.createSphere({ key: 'work' });

  const task = agent.createTask({ title: 'Send the report', sphereId: sphere.id });
  const created = s.getActivity(agent.trail.at(-1)!)!;
  assert.equal(created.actor, 'agent');
  assert.equal(created.undoable, true);

  agent.updateTask(task.id, { done: true });
  const completed = agent.trail.at(-1)!;
  assert.equal(s.undo(completed), true);
  assert.equal(s.getTask(task.id).done, false, 'undoing a completion reopens the task');

  assert.equal(s.undo(created.id), true);
  assert.throws(() => s.getTask(task.id), NotFound);
  assert.equal(s.undo(created.id), false, 'cannot undo twice');

  const metric = s.createMetric({ sphereId: sphere.id, name: 'Deep work', unit: 'h' });
  agent.addMetricEntry(metric.id, { value: 3, date: TODAY });
  assert.equal(s.undo(agent.trail.at(-1)!), true);
  assert.equal(s.getMetric(metric.id).entries.length, 0);
});

test('journal: one entry per day, append keeps what was written, empty removes it', () => {
  const s = fresh();
  s.putJournal(TODAY, 'Slept badly.');
  s.appendJournal(TODAY, 'Good run at lunch.');
  assert.equal(s.getJournal(TODAY)!.body, 'Slept badly.\n\nGood run at lunch.');
  assert.equal(s.listNotes({ kind: 'journal' }).length, 1);
  s.putJournal(TODAY, '   ');
  assert.equal(s.getJournal(TODAY), null);
});

test('search treats % and _ literally', () => {
  const s = fresh();
  const sphere = s.createSphere({ key: 'finances' });
  s.createGoal({ sphereId: sphere.id, title: 'Save 20% of income' });
  s.createGoal({ sphereId: sphere.id, title: 'Pay off the car' });
  assert.deepEqual(s.search('20%').map((h) => h.title), ['Save 20% of income']);
  assert.equal(s.search('%').length, 1);
  assert.equal(s.search('_').length, 0);
});

test('overview sorts tasks into due, upcoming and anytime', () => {
  const s = fresh();
  s.createTask({ title: 'overdue', dueDate: addDays(TODAY, -2) });
  s.createTask({ title: 'today', dueDate: TODAY });
  s.createTask({ title: 'soon', dueDate: addDays(TODAY, 3) });
  s.createTask({ title: 'far', dueDate: addDays(TODAY, 30) });
  s.createTask({ title: 'whenever' });
  const o = s.overview(TODAY);
  assert.deepEqual(o.tasks.due.map((t) => t.title), ['overdue', 'today']);
  assert.deepEqual(o.tasks.upcoming.map((t) => t.title), ['soon']);
  assert.deepEqual(o.tasks.anytime.map((t) => t.title), ['whenever']);
});

test('settings never expose the key, and a key does not follow a change of endpoint', () => {
  const s = fresh();
  s.updateSettings({ model: { provider: 'openai-compatible', preset: 'openai', baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-secret-123456' } });
  const shown = s.getSettings();
  assert.equal(shown.model.hasApiKey, true);
  assert.equal(shown.model.baseUrl, 'https://api.openai.com/v1');
  assert.ok(!JSON.stringify(shown).includes('sk-secret-123456'));
  assert.equal(s.getModelConfig()!.apiKey, 'sk-secret-123456');

  s.updateSettings({ model: { model: 'gpt-x' } });
  assert.equal(s.getModelConfig()!.apiKey, 'sk-secret-123456', 'unrelated edits keep the key');

  s.updateSettings({ model: { baseUrl: 'https://elsewhere.example/v1' } });
  assert.equal(s.getModelConfig()!.apiKey, '', 'a new host must not receive the old key');
});

test('export → import round-trips everything except secrets', () => {
  const a = fresh();
  a.onboard({ userName: 'Sam', agentName: 'North', sphereKeys: ['health', 'family', 'nonsense'] });
  a.updateSettings({ model: { provider: 'anthropic', apiKey: 'sk-ant-secret' } });
  const sphere = a.listSpheres(TODAY)[0]!;
  const habit = a.createHabit({ sphereId: sphere.id, name: 'Walk' });
  a.setHabitLog(habit.id, TODAY, true, TODAY);
  a.createGoal({ sphereId: sphere.id, title: 'Hike', milestones: ['Boots'] });
  a.putJournal(TODAY, 'hello');
  a.addMemory('Prefers mornings');

  const dump = JSON.parse(JSON.stringify(a.exportAll()));
  assert.ok(!JSON.stringify(dump).includes('sk-ant-secret'));

  const b = fresh();
  b.importAll(dump);
  assert.equal(b.listSpheres(TODAY).length, 2);
  assert.equal(b.listHabits(TODAY)[0]!.doneToday, true);
  assert.equal(b.listGoals()[0]!.milestones.length, 1);
  assert.equal(b.getJournal(TODAY)!.body, 'hello');
  assert.equal(b.listMemories().length, 1);
  assert.equal(b.getProfile().userName, 'Sam');
  assert.equal(b.getModelConfig(), null);

  assert.throws(() => b.importAll({ nope: true }), Invalid);
  assert.equal(b.listSpheres(TODAY).length, 2, 'a bad file leaves the data alone');
});

test('deleting a sphere removes what lives in it and frees what merely pointed at it', () => {
  const s = fresh();
  const sphere = s.createSphere({ key: 'travels' });
  s.createGoal({ sphereId: sphere.id, title: 'Japan' });
  const task = s.createTask({ title: 'Renew passport', sphereId: sphere.id });
  s.deleteSphere(sphere.id);
  assert.equal(s.listGoals({ status: 'all' }).length, 0);
  assert.equal(s.getTask(task.id).sphereId, null);
});
