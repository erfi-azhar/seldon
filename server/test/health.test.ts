import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSnapshot } from '../src/agent/prompt.ts';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { healthState, logBody, logFood, logWorkout, mealFor } from '../src/features/health.ts';
import { Store } from '../src/store.ts';
import { anthropicMessage, fakeModel } from './helpers.ts';

const DAY = '2026-11-14';

function healthStore(): Store {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['health'] });
  return store;
}

test('food: meals from the time, totals against targets, a fortnight of days, undo', () => {
  const store = healthStore();
  assert.equal(mealFor('07:30'), 'breakfast');
  assert.equal(mealFor('12:15'), 'lunch');
  assert.equal(mealFor('19:00'), 'dinner');
  assert.equal(mealFor('15:30'), 'snack');
  logFood(store, DAY, '08:00', [{ name: 'Kaya toast', kcal: 300, protein: 8, carbs: 40, fat: 12 }, { name: 'Kopi', kcal: 90.25, carbs: 12 }]);
  logFood(store, '2026-11-10', '13:00', [{ name: 'Chicken rice', kcal: 600, protein: 30, carbs: 70, fat: 20 }]);
  const h = healthState(store, DAY);
  assert.deepEqual(h.today.totals, { kcal: 390.3, protein: 8, carbs: 52, fat: 12 });
  assert.equal(h.today.entries[0]!.meal, 'breakfast');
  assert.equal(h.days.length, 14);
  assert.equal(h.days.find((d) => d.date === '2026-11-10')!.kcal, 600);
  const act = store.listActivity()[0]!;
  assert.match(act.summary, /^Logged Chicken rice — 600 kcal/);
  assert.equal(store.undo(act.id), true);
  assert.equal(healthState(store, DAY).days.find((d) => d.date === '2026-11-10')!.kcal, 0);
});

test('body composition keeps the Weight metric (and its goal) in step; workouts summarise the week', () => {
  const store = healthStore();
  const sphere = store.listSpheres()[0]!;
  const weight = store.createMetric({ sphereId: sphere.id, name: 'Weight', unit: 'kg', direction: 'down' });
  store.addMetricEntry(weight.id, { value: 80, date: '2026-11-01' });
  const goal = store.createGoal({ sphereId: sphere.id, title: 'Reach 76 kg', metricId: weight.id, targetValue: 76 });
  logBody(store, { date: DAY, weightKg: 78, bodyFatPct: 27.5, muscleKg: 33.1, visceralFat: 11, waterPct: null, bmr: 1690 });
  assert.equal(store.getMetric(weight.id).latest, 78);
  assert.equal(store.getGoal(goal.id).progress, 0.5);
  assert.throws(() => logBody(store, { date: DAY, weightKg: null, bodyFatPct: null, muscleKg: null, visceralFat: null, waterPct: null, bmr: null }), /at least one/);

  logWorkout(store, { date: DAY, name: 'Push day', type: 'strength', durationMin: 55, distanceKm: null, kcal: null, notes: '', exercises: [{ name: 'Bench press', sets: [{ reps: 8, weight: 70 }] }] });
  logWorkout(store, { date: '2026-11-12', name: 'Easy run', type: 'run', durationMin: 30, distanceKm: 5.2, kcal: null, notes: '', exercises: [] });
  logWorkout(store, { date: '2026-11-01', name: 'Old', type: 'run', durationMin: 30, distanceKm: 5, kcal: null, notes: '', exercises: [] });
  const h = healthState(store, DAY);
  assert.deepEqual(h.week, { sessions: 2, minutes: 85, strength: 1, cardio: 1 });
  assert.equal(h.workouts[0]!.exercises[0]!.sets[0]!.weight, 70);
  assert.equal(logWorkout(store, { date: DAY, name: 'Dup', type: 'run', durationMin: 1, distanceKm: null, kcal: null, notes: '', exercises: [] }, 'gravl', 'w1')!.name, 'Dup');
  assert.equal(logWorkout(store, { date: DAY, name: 'Dup', type: 'run', durationMin: 1, distanceKm: null, kcal: null, notes: '', exercises: [] }, 'gravl', 'w1'), null, 'synced items are imported once');

  const snap = renderSnapshot(store, DAY);
  assert.match(snap, /NUTRITION AND TRAINING/);
  assert.match(snap, /Latest body composition \(2026-11-14\): 78 kg, 27.5% body fat, 33.1 kg skeletal muscle/);
});

test('describe food: the background brain estimates the items; with no brain the app says so', async () => {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.onboard({ userName: '', agentName: 'Seldon', sphereKeys: ['health'] });
  const app = createApp({ db });
  const describe = () => app.request(`http://localhost/api/health/food/describe?date=${DAY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'nasi lemak with an egg and teh tarik', time: '08:10' }) });
  const none = await describe();
  assert.equal(none.status, 400);
  assert.match(((await none.json()) as { error: string }).error, /Connect a brain/);

  const estimate = { items: [{ name: 'Nasi lemak with egg', amount: '1 plate', kcal: 640, protein: 18, carbs: 78, fat: 28 }, { name: 'Teh tarik', amount: '1 cup', kcal: 150, protein: 4, carbs: 24, fat: 4 }] };
  const model = await fakeModel([{ sse: anthropicMessage([{ type: 'text', text: JSON.stringify(estimate) }], 'end_turn') }]);
  store.addConnection({ provider: 'anthropic', baseUrl: model.url, apiKey: 'k' });
  const res = await describe();
  assert.equal(res.status, 201);
  const h = (await res.json()) as { today: { totals: { kcal: number }; entries: { source: string; meal: string }[] } };
  assert.equal(h.today.totals.kcal, 790);
  assert.equal(h.today.entries[0]!.source, 'estimate');
  assert.equal(h.today.entries[0]!.meal, 'breakfast');
  assert.match(model.seen[0]!.body.messages[0].content, /<untrusted source="food description">\nnasi lemak/);
});
