// Builds a demo database full of believable sample data, so you can look around before
// putting your own life in. It never touches your real database:
//
//   npm run seed:demo                     → writes data/demo.db
//   TERMINUS_DB=data/demo.db npm start      → run Terminus against it
//
// Everything is created through the same Store and agent loop the app uses, then
// timestamps are shifted into the past so trends and "quiet" spheres look lived-in.

import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { chat } from '../server/src/agent/index.ts';
import type { Provider, ProviderResponse } from '../server/src/agent/types.ts';
import { openDb } from '../server/src/db.ts';
import { addDays, localDate, Store } from '../server/src/store.ts';
import { addSignal } from '../server/src/features/signals.ts';

const path = resolve(process.argv[2] ?? 'data/demo.db');
for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });

const db = openDb(path);
const store = new Store(db);
const today = localDate();
const day = (ago: number): string => addDays(today, -ago);

// Deterministic randomness, so the demo looks the same every time.
let seed = 20261113;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const round = (n: number, places = 1): number => Math.round(n * 10 ** places) / 10 ** places;

/** Run some writes, then move the activity they logged to `ago` days in the past. */
function at<T>(ago: number, fn: () => T, hour = 9): T {
  const before = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM activity').get() as { id: number }).id;
  const out = fn();
  const ts = new Date(`${day(ago)}T${String(hour).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:00`).toISOString();
  db.prepare('UPDATE activity SET ts = ? WHERE id > ?').run(ts, before);
  return out;
}

function logHabit(habitId: string, daysAgo: number[]): void {
  for (const ago of daysAgo) at(ago, () => store.setHabitLog(habitId, day(ago), true, today), 7 + Math.floor(rand() * 12));
}
/** Days (as "days ago") on which a habit was done, at roughly `rate`, over `span` days. */
function often(rate: number, span = 34, skipToday = true): number[] {
  const out: number[] = [];
  for (let ago = skipToday ? 1 : 0; ago <= span; ago++) if (rand() < rate) out.push(ago);
  return out;
}
function logSeries(metricId: string, points: [ago: number, value: number][]): void {
  for (const [ago, value] of points) at(ago, () => store.addMetricEntry(metricId, { value, date: day(ago) }), 8);
}
function weekly(from: number, to: number, weeks: number, wobble: number, places = 1): [number, number][] {
  return Array.from({ length: weeks }, (_, i) => {
    const t = weeks === 1 ? 1 : i / (weeks - 1);
    const noise = i === weeks - 1 ? 0 : (rand() - 0.5) * wobble;
    return [(weeks - 1 - i) * 7 + 1, round(from + (to - from) * t + noise, places)] as [number, number];
  });
}

store.onboard({ userName: '', agentName: 'Seldon', sphereKeys: ['health', 'finances', 'work', 'side-projects', 'travels', 'faith', 'family'] });
const sphere = Object.fromEntries(store.listSpheres(today).map((s) => [s.key!, s.id])) as Record<string, string>;
db.prepare('UPDATE activity SET ts = ?').run(new Date(`${day(90)}T10:00:00`).toISOString());

// ── Health ──────────────────────────────────────────────────────────────────
at(88, () => store.updateSphere(sphere.health!, { vision: 'Strong enough to carry the kids, rested enough to enjoy them.' }));
const move = at(80, () => store.createHabit({ sphereId: sphere.health!, name: 'Move for 30 minutes' }));
const lights = at(80, () => store.createHabit({ sphereId: sphere.health!, name: 'Lights out by 11' }));
const strength = at(60, () => store.createHabit({ sphereId: sphere.health!, name: 'Strength training', cadence: 'weekly', targetPerWeek: 3 }));
logHabit(move.id, [1, 2, 3, ...often(0.72).filter((d) => d > 3)]);
logHabit(lights.id, often(0.55));
logHabit(strength.id, [1, 3, 6, 8, 10, 13, 15, 17, 20, 23, 27, 29, 31]);

const weight = at(84, () => store.createMetric({ sphereId: sphere.health!, name: 'Weight', unit: 'kg', direction: 'down' }));
logSeries(weight.id, weekly(81.4, 78.9, 12, 0.5));
const sleep = at(40, () => store.createMetric({ sphereId: sphere.health!, name: 'Sleep', unit: 'h', direction: 'up' }));
logSeries(sleep.id, Array.from({ length: 21 }, (_, i) => [21 - i, round(6.2 + rand() * 1.5 + i * 0.02)] as [number, number]));
const heart = at(84, () => store.createMetric({ sphereId: sphere.health!, name: 'Resting heart rate', unit: 'bpm', direction: 'down' }));
logSeries(heart.id, weekly(65, 59, 10, 2, 0));

at(84, () => store.createGoal({ sphereId: sphere.health!, title: 'Reach 76 kg', why: 'Lighter on the knees, and a number the doctor stops raising an eyebrow at.', metricId: weight.id, startValue: 81.4, targetValue: 76, targetDate: day(-70), horizon: 'quarter' }));
const run = at(70, () => store.createGoal({ sphereId: sphere.health!, title: 'Run 10 km without stopping', why: 'I said I would at 30. Still want to.', targetDate: day(-120), milestones: ['Run 3 km', 'Run 5 km', 'Run 8 km', 'Run 10 km', 'Sign up for the spring 10K'] }));
at(48, () => store.updateMilestone(run.milestones[0]!.id, { done: true }));
at(12, () => store.updateMilestone(run.milestones[1]!.id, { done: true }));
at(6, () => store.createTask({ title: 'Book the annual check-up', sphereId: sphere.health!, dueDate: day(-3) }));
at(9, () => store.createTask({ title: 'Replace running shoes', sphereId: sphere.health!, goalId: run.id }));

// ── Finances ────────────────────────────────────────────────────────────────
at(88, () => store.updateSphere(sphere.finances!, { vision: 'Enough margin that money is a tool and not a worry — and generous by default.' }));
const review = at(70, () => store.createHabit({ sphereId: sphere.finances!, name: 'Review spending', cadence: 'weekly', targetPerWeek: 1 }));
logHabit(review.id, [2, 9, 16, 30]);
const fund = at(150, () => store.createMetric({ sphereId: sphere.finances!, name: 'Emergency fund', direction: 'up' }));
logSeries(fund.id, [[150, 9200], [120, 10100], [92, 11250], [61, 12400], [33, 13500], [2, 14600]]);
const spend = at(150, () => store.createMetric({ sphereId: sphere.finances!, name: 'Monthly spend', direction: 'down' }));
logSeries(spend.id, [[135, 4310], [105, 4120], [74, 4480], [44, 3960], [13, 3890]]);
at(150, () => store.createGoal({ sphereId: sphere.finances!, title: 'Six months of expenses saved', why: 'So a bad month is an inconvenience, not a crisis.', metricId: fund.id, startValue: 9200, targetValue: 24000, targetDate: day(-300) }));
const invest = at(40, () => store.createGoal({ sphereId: sphere.finances!, title: 'Put investing on autopilot', horizon: 'quarter', targetDate: day(-21), milestones: ['Open the brokerage account', 'Set up the monthly transfer', 'Decide the allocation', 'Review after three months'] }));
at(33, () => store.updateMilestone(invest.milestones[0]!.id, { done: true }));
at(2, () => store.updateMilestone(invest.milestones[1]!.id, { done: true }));
at(4, () => store.createTask({ title: 'Cancel the two subscriptions nobody uses', sphereId: sphere.finances!, dueDate: today }));
at(3, () => store.createTask({ title: 'Send documents to the accountant', sphereId: sphere.finances!, dueDate: day(-9) }));

// ── Work ────────────────────────────────────────────────────────────────────
at(88, () => store.updateSphere(sphere.work!, { vision: "Do work I'm proud to sign, and still leave at a decent hour." }));
const deep = at(60, () => store.createHabit({ sphereId: sphere.work!, name: 'Deep-work block', cadence: 'weekly', targetPerWeek: 5 }));
logHabit(deep.id, [1, 2, 3, 6, 7, 8, 9, 10, 13, 14, 16, 17, 20, 21, 22, 23, 24, 27, 28, 30]);
const weekReview = at(60, () => store.createHabit({ sphereId: sphere.work!, name: 'Weekly review', cadence: 'weekly', targetPerWeek: 1 }));
logHabit(weekReview.id, [5, 12, 19, 26, 33]);
const hours = at(63, () => store.createMetric({ sphereId: sphere.work!, name: 'Deep-work hours', unit: 'h', direction: 'up' }));
logSeries(hours.id, weekly(6.5, 12.5, 9, 3));
const redesign = at(55, () => store.createGoal({ sphereId: sphere.work!, title: 'Ship the onboarding redesign', why: 'The first five minutes decide whether people stay.', horizon: 'quarter', targetDate: day(-24), milestones: ['Synthesise the research', 'Prototype the new flow', 'Run a usability round', 'Build it', 'Launch to everyone'] }));
at(41, () => store.updateMilestone(redesign.milestones[0]!.id, { done: true }));
at(27, () => store.updateMilestone(redesign.milestones[1]!.id, { done: true }));
at(8, () => store.updateMilestone(redesign.milestones[2]!.id, { done: true }));
const talk = at(30, () => store.createGoal({ sphereId: sphere.work!, title: 'Give a talk at a local meetup', horizon: 'someday' }));
at(14, () => store.updateGoal(talk.id, { manualProgress: 20 }));
at(2, () => store.createTask({ title: 'Reply to Dana about the offsite', sphereId: sphere.work!, dueDate: day(1) }));
at(1, () => store.createTask({ title: 'Prepare notes for the 1:1', sphereId: sphere.work!, dueDate: today }));
at(1, () => store.createTask({ title: 'Review the roadmap draft', sphereId: sphere.work!, goalId: redesign.id, dueDate: day(-2) }));

// ── Side projects ───────────────────────────────────────────────────────────
at(88, () => store.updateSphere(sphere['side-projects']!, { vision: 'Small things, finished, and used by real people.' }));
const build = at(50, () => store.createHabit({ sphereId: sphere['side-projects']!, name: 'Build session', cadence: 'weekly', targetPerWeek: 3 }));
logHabit(build.id, [5, 8, 9, 12, 15, 16, 19, 23, 26, 29]);
const readers = at(50, () => store.createMetric({ sphereId: sphere['side-projects']!, name: 'Subscribers', direction: 'up' }));
logSeries(readers.id, [[47, 0], [40, 4], [33, 9], [26, 14], [19, 17], [12, 21], [5, 23]]);
const letter = at(50, () => store.createGoal({ sphereId: sphere['side-projects']!, title: 'Get the newsletter to 100 readers', metricId: readers.id, startValue: 0, targetValue: 100, targetDate: day(-110) }));
at(8, () => store.createTask({ title: 'Write the landing page', sphereId: sphere['side-projects']!, goalId: letter.id }));
at(5, () => store.createTask({ title: 'Fix the broken image uploads', sphereId: sphere['side-projects']! }));

// ── Travels (deliberately neglected, to show what a quiet sphere looks like) ─
at(88, () => store.updateSphere(sphere.travels!, { vision: 'One new place a year, slowly, with people I love.' }));
const tripFund = at(120, () => store.createMetric({ sphereId: sphere.travels!, name: 'Travel fund', direction: 'up' }));
logSeries(tripFund.id, [[118, 1200], [88, 1650], [57, 2100], [26, 2550], [16, 2850]]);
const japan = at(60, () => store.createGoal({ sphereId: sphere.travels!, title: 'Two weeks in Japan in spring', why: "We've talked about it for six years.", targetDate: day(-150), milestones: ['Agree the dates', 'Book flights', 'Reserve the ryokan in Kyoto', 'Plan the walking days', 'Renew passports'] }));
at(30, () => store.updateMilestone(japan.milestones[0]!.id, { done: true }));
at(16, () => store.createTask({ title: 'Renew passports', sphereId: sphere.travels!, goalId: japan.id, dueDate: day(-12) }));

// ── Faith ───────────────────────────────────────────────────────────────────
at(88, () => store.updateSphere(sphere.faith!, { vision: 'Five prayers on time, the Quran every day, and a heart that remembers between them.' }));
// Prayers live in the prayer tracker, at Singapore's times.
store.db.prepare("INSERT INTO settings (key, value) VALUES ('prayer', ?)").run(
  JSON.stringify({ lat: 1.3521, lng: 103.8198, label: 'Singapore', timezone: 'Asia/Singapore', method: 'Singapore', madhab: 'shafi', backlog: { fajr: 3, dhuhr: 0, asr: 1, maghrib: 0, isha: 0 } }),
);
const rates = { fajr: 0.72, dhuhr: 0.9, asr: 0.84, maghrib: 0.97, isha: 0.9 } as const;
for (let ago = 1; ago <= 34; ago++) {
  for (const [prayer, rate] of Object.entries(rates)) {
    if (ago <= 6 && ago % 3 === 0 && prayer === 'asr') continue; // a few left unmarked
    const r = rand();
    const status = r < rate ? 'prayed' : r < rate + 0.06 ? 'late' : 'missed';
    store.db.prepare('INSERT INTO prayer_log (date, prayer, status, logged_at, made_up_at) VALUES (?,?,?,?,?)').run(day(ago), prayer, status, new Date().toISOString(), status === 'missed' && ago > 20 ? new Date().toISOString() : null);
  }
}
store.db.prepare("INSERT INTO prayer_log (date, prayer, status, logged_at) VALUES (?, 'fajr', 'prayed', ?)").run(today, new Date().toISOString());
const reading = at(80, () => store.createHabit({ sphereId: sphere.faith!, name: 'Quran reading' }));
logHabit(reading.id, [0, 1, ...often(0.6).filter((d) => d > 2)]);
const fasting = at(40, () => store.createHabit({ sphereId: sphere.faith!, name: 'Fast Monday and Thursday', cadence: 'weekly', targetPerWeek: 2 }));
logHabit(fasting.id, [1, 4, 8, 11, 18, 22, 25]);
const pages = at(80, () => store.createMetric({ sphereId: sphere.faith!, name: 'Quran pages read', unit: 'pp', direction: 'up' }));
logSeries(pages.id, weekly(212, 388, 11, 8, 0));
const giving = at(150, () => store.createMetric({ sphereId: sphere.faith!, name: 'Sadaqah given', direction: 'up' }));
logSeries(giving.id, [[150, 240], [120, 310], [91, 420], [60, 495], [31, 610], [3, 700]]);
at(80, () => store.createGoal({ sphereId: sphere.faith!, title: 'Complete a khatm before Ramadan', metricId: pages.id, startValue: 0, targetValue: 604, targetDate: day(-95) }));
const umrah = at(60, () => store.createGoal({ sphereId: sphere.faith!, title: 'Go for Umrah', why: 'To stand there at least once while I am able.', horizon: 'year', targetDate: day(-240), milestones: ['Set the budget', 'Choose the dates', 'Book with an agent', 'Learn the rites'] }));
at(20, () => store.updateMilestone(umrah.milestones[0]!.id, { done: true }));

// ── Family ──────────────────────────────────────────────────────────────────
at(88, () => store.updateSphere(sphere.family!, { vision: 'Be the one who shows up: present at dinner, patient at bedtime.' }));
const dinner = at(60, () => store.createHabit({ sphereId: sphere.family!, name: 'Device-free dinner' }));
const parents = at(60, () => store.createHabit({ sphereId: sphere.family!, name: 'Call Mum and Dad', cadence: 'weekly', targetPerWeek: 1 }));
logHabit(dinner.id, [1, 2, ...often(0.68).filter((d) => d > 2)]);
logHabit(parents.id, [4, 11, 19, 25, 32]);
const weekend = at(21, () => store.createGoal({ sphereId: sphere.family!, title: 'A weekend away, just the two of us', horizon: 'quarter', targetDate: day(-35), milestones: ['Ask the grandparents to babysit', 'Pick somewhere', 'Book it'] }));
at(10, () => store.updateMilestone(weekend.milestones[0]!.id, { done: true }));
const pancakes = at(75, () => store.createGoal({ sphereId: sphere.family!, title: 'Make Sunday pancakes a tradition', milestones: ['Four Sundays in a row'] }));
at(26, () => store.updateMilestone(pancakes.milestones[0]!.id, { done: true }));
at(26, () => store.updateGoal(pancakes.id, { status: 'done' }));
db.prepare('UPDATE goals SET completed_at = ? WHERE id = ?').run(new Date(`${day(26)}T10:00:00`).toISOString(), pancakes.id);
at(1, () => store.createTask({ title: 'Sign the school trip form', sphereId: sphere.family!, dueDate: today }));
at(3, () => store.createTask({ title: "Order the photo book for Mum's birthday", sphereId: sphere.family!, dueDate: day(-5) }));

// ── Loose tasks, notes, journal, memory ─────────────────────────────────────
at(2, () => store.createTask({ title: 'Descale the coffee machine' }));
const done = at(1, () => store.createTask({ title: 'Pay the electricity bill', sphereId: sphere.finances! }));
at(0, () => store.updateTask(done.id, { done: true }), 8);

const note = (ago: number, input: Parameters<Store['createNote']>[0]) => {
  const n = at(ago, () => store.createNote(input));
  const ts = new Date(`${day(ago)}T18:00:00`).toISOString();
  db.prepare('UPDATE notes SET created_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, n.id);
  return n;
};
note(18, { title: 'Walking the Kumano Kodō', url: 'https://en.wikipedia.org/wiki/Kumano_Kod%C5%8D', body: 'The Nakahechi route looks right for four days. Luggage forwarding between inns exists, so we can walk with day packs.', sphereId: sphere.travels! });
note(11, { title: 'What the usability round taught us', body: 'Nobody read the second screen. Three of five people looked for a "skip" that wasn\'t there. The progress dots made it feel longer, not shorter.\n\nCut it to two steps and let people finish setup later.', sphereId: sphere.work! });
note(9, { title: 'Why a boring index fund', url: 'https://en.wikipedia.org/wiki/Index_fund', body: 'Low fees, no decisions, and I never have to have an opinion about a company.', sphereId: sphere.finances! });
note(6, { title: 'Gift ideas', body: 'Mum — the photo book, and the blue enamel teapot she pointed at in October.\nDad — new secateurs. His are older than me.', sphereId: sphere.family! });
const pinned = note(4, { title: 'A rule for the week', body: "Three things that matter, written down on Sunday night. If it isn't one of the three, it can wait or it can go." });
store.updateNote(pinned.id, { pinned: true });
note(3, { title: 'Run log', body: 'Tue — 5.2 km, easy, 6:05/km. Legs fine.\nSat — 4 km with hills. Walked twice. Still counts.', sphereId: sphere.health! });

const journal = (ago: number, body: string) => {
  at(ago, () => store.putJournal(day(ago), body), 21);
  const ts = new Date(`${day(ago)}T21:15:00`).toISOString();
  db.prepare("UPDATE notes SET created_at = ?, updated_at = ? WHERE kind = 'journal' AND date = ?").run(ts, ts, day(ago));
};
journal(6, "Took the kids to the river instead of doing the shopping. Nobody will remember the shopping.\n\nNoticed I checked my phone four times at dinner. Tomorrow it stays in the hallway.");
journal(3, 'Usability round done. Humbling, useful. The thing I was proudest of is the thing nobody understood.');
journal(1, "Long day, short fuse. Ran anyway and felt like a different person by the second kilometre. Wrote the three things for the week — haven't looked at the Japan plan in a fortnight and it's starting to nag.");

at(20, () => store.addMemory('Plans the week on Sunday evenings and likes three priorities, not ten.'));
at(15, () => store.addMemory('Runs in the morning before work; evenings are for family.'));
at(6, () => store.addMemory("Mum's birthday is in early December."));

// ── One real exchange with the agent ────────────────────────────────────────
// A scripted "model" drives the genuine agent loop, so the tools really run and the
// activity really is attributed to the agent — it is just not a live model deciding.
function scripted(steps: ProviderResponse[]): Provider {
  return {
    id: 'demo-script',
    model: 'demo',
    complete: async (req) => {
      const step = steps.shift() ?? { text: '', toolCalls: [] };
      if (step.text) req.onText(step.text);
      return step;
    },
  };
}
await chat({
  store,
  provider: scripted([
    {
      text: '',
      toolCalls: [
        { id: 'demo_1', name: 'log_habit', input: { habit_id: move.id } },
        { id: 'demo_2', name: 'log_metric', input: { metric_id: weight.id, value: 78.6 } },
        { id: 'demo_3', name: 'create_task', input: { title: 'Book the dentist', sphere_id: sphere.health, due_date: day(-6) } },
      ],
    },
    {
      text: "Logged the run and 78.6 kg. That's 2.8 kg down since you started, which puts **Reach 76 kg** just past halfway.\n\nThe dentist is on your list for next week. One thing while I'm here: Travels has been quiet for over two weeks, and passports need renewing before you can book flights for Japan. Want me to put that on today?",
      toolCalls: [],
    },
  ]),
  message: 'Morning run done, 5.2 km. Weighed in at 78.6. And remind me to book the dentist next week.',
  context: { date: today, time: '07:42', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, viewing: 'Today' },
  emit: () => undefined,
});

// ── A few signals, as if Gmail had been watching ───────────────────────────
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
addSignal(store, {
  source: 'gmail', kind: 'reply', externalId: '<demo-1@example.com>', priority: 2, sphereId: sphere.work!, occurredAt: ago(2),
  title: 'Dana Lim: Offsite — can you confirm the 4th?',
  body: 'Dana needs you to confirm the 4 December offsite by Friday so she can book the venue.',
  actions: [
    { type: 'reply', label: 'Save reply as a Gmail draft', to: 'dana@example.com', subject: 'Re: Offsite — can you confirm the 4th?', body: "Hi Dana,\n\nThe 4th works for me — please go ahead and book.\n\nThanks!", inReplyTo: '<demo-1@example.com>' },
    { type: 'task', label: 'Add as a task', title: 'Reply to Dana about the offsite', dueDate: addDays(today, 6), sphereId: sphere.work! },
  ],
});
addSignal(store, {
  source: 'gmail', kind: 'deadline', externalId: '<demo-2@example.com>', priority: 2, sphereId: sphere.finances!, occurredAt: ago(20),
  title: 'IRAS: Your income tax bill is ready',
  body: 'Your 2026 tax bill is $4,180, payable by 13 December. GIRO instalments are available.',
  actions: [{ type: 'task', label: 'Add as a task', title: 'Pay income tax or set up GIRO', dueDate: addDays(today, 29), sphereId: sphere.finances! }],
});
addSignal(store, {
  source: 'gmail', kind: 'family', externalId: '<demo-3@example.com>', priority: 1, sphereId: sphere.family!, occurredAt: ago(30),
  title: "Mum: Lunch on Sunday?",
  body: 'Mum asks whether you can all come for lunch this Sunday at 12:30.',
  actions: [{ type: 'reply', label: 'Save reply as a Gmail draft', to: 'mum@example.com', subject: 'Re: Lunch on Sunday?', body: 'Hi Mum, we would love to — see you at 12:30!', inReplyTo: '<demo-3@example.com>' }],
});

at(0, () => store.putJournal(today, 'Ran before anyone else was up. 5.2 km and it felt easy for the first time.'), 7);

const counts = db
  .prepare(
    `SELECT (SELECT COUNT(*) FROM spheres) AS spheres, (SELECT COUNT(*) FROM goals) AS goals, (SELECT COUNT(*) FROM habits) AS habits,
            (SELECT COUNT(*) FROM habit_logs) AS checkins, (SELECT COUNT(*) FROM metric_entries) AS readings, (SELECT COUNT(*) FROM tasks) AS tasks,
            (SELECT COUNT(*) FROM notes) AS notes`,
  )
  .get() as Record<string, number>;
db.close();

console.log(`Demo data written to ${path}`);
console.log(Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · '));
console.log(`\nRun it:  TERMINUS_DB=${path} npm start`);
