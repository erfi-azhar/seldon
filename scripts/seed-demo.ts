// Builds a demo database full of believable sample data, so you can look around before
// putting your own life in. It never touches your real database:
//
//   npm run seed:demo                     → writes data/demo.db
//   TERMINUS_DB=data/demo.db npm start      → run Terminus against it
//
// Everything is created through the same Store and agent loop the app uses, then
// timestamps are shifted into the past so trends and "quiet" spheres look lived-in.

import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { chat } from '../server/src/agent/index.ts';
import type { Provider, ProviderResponse } from '../server/src/agent/types.ts';
import { openDb } from '../server/src/db.ts';
import { addDays, localDate, Store } from '../server/src/store.ts';
import { addSignal } from '../server/src/features/signals.ts';
import { saveFile } from '../server/src/features/capture.ts';
import { logBody, logFood, logWorkout } from '../server/src/features/health.ts';
import { addItems, addSegment, createTrip, upsertLoyalty } from '../server/src/features/travel.ts';
import { setPreferences } from '../server/src/features/job-alerts.ts';
import { updateIntegration } from '../server/src/features/integrations.ts';
import { addAlert, addDebt, addHolding, addRecurring, addTransaction, logTrade, payDebt } from '../server/src/features/finance.ts';
import { deflateSync } from 'node:zlib';

const path = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'data/demo.db');
// Only ever replace a previous demo database, never a real one.
if (existsSync(path)) {
  let demo = false;
  try {
    const old = new DatabaseSync(path, { readOnly: true });
    demo = !!old.prepare("SELECT 1 AS x FROM settings WHERE key = 'demo'").get();
    old.close();
  } catch {
    demo = false;
  }
  if (!demo && !process.argv.includes('--force')) {
    console.error(`${path} exists and is not a demo database, so it was left alone. Pick another path (or add --force if you are sure).`);
    process.exit(1);
  }
}
for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });

const db = openDb(path);
db.prepare("INSERT INTO settings (key, value) VALUES ('demo', 'true')").run();
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

// The money itself: in and out over three months, what's owned, what's owed, a few trades.
db.prepare("INSERT INTO settings (key, value) VALUES ('finance', ?)").run(JSON.stringify({ currency: 'SGD', budgets: { Food: 700, Groceries: 450, Transport: 250, Shopping: 300, Entertainment: 200, Subscriptions: 80 }, watchlist: ['BTC', 'ETH', 'SOL', 'LINK'] }));
db.prepare("INSERT INTO settings (key, value) VALUES ('fx_rates', ?)").run(JSON.stringify({ rates: { USD: 1, SGD: 1.3, MYR: 4.4, EUR: 0.92 }, at: new Date().toISOString() }));
const firstOf = (monthsAgo: number, dayOfMonth: number) => {
  const d = new Date(`${today}T12:00:00`);
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  d.setDate(Math.min(dayOfMonth, 28));
  return d.toISOString().slice(0, 10);
};
for (let m = 2; m >= 0; m--) {
  const on = (dom: number) => firstOf(m, dom);
  const past = (date: string) => date <= today;
  const tx = (date: string, kind: 'income' | 'expense', amount: number, category: string, description: string) => {
    if (past(date)) addTransaction(store, { kind, amount, category, description, date }, 'demo');
  };
  tx(on(1), 'expense', 2400, 'Housing', 'Rent');
  tx(on(25), 'income', 7200, 'Salary', 'Salary');
  tx(on(3), 'expense', 168, 'Utilities', 'SP Group');
  tx(on(5), 'expense', 45.9, 'Subscriptions', 'Phone plan');
  tx(on(6), 'expense', 22.98, 'Subscriptions', 'Spotify + iCloud');
  if (m === 1) tx(on(14), 'income', 850, 'Freelance', 'Logo for a friend\'s café');
  for (let w = 0; w < 4; w++) {
    tx(on(2 + w * 7), 'expense', round(95 + rand() * 60, 2), 'Groceries', ['FairPrice', 'Sheng Siong', 'Cold Storage', 'FairPrice'][w]!);
    tx(on(4 + w * 7), 'expense', round(40 + rand() * 50, 2), 'Transport', 'Grab and MRT');
    for (const d of [1, 3, 5]) tx(on(Math.min(28, d + w * 7)), 'expense', round(6 + rand() * 18, 2), 'Food', ['Chicken rice', 'Nasi lemak', 'Mee rebus', 'Prata', 'Lunch with the team', 'Dinner out'][Math.floor(rand() * 6)]!);
  }
  tx(on(18), 'expense', round(120 + rand() * 260, 2), 'Shopping', ['Uniqlo', 'Shopee', 'IKEA'][m]!);
  tx(on(20), 'expense', 50, 'Giving', 'Monthly sadaqah');
  tx(on(22), 'expense', round(30 + rand() * 90, 2), 'Entertainment', 'Cinema and bowling');
}
addHolding(store, { kind: 'cash', name: 'DBS Multiplier', quantity: 14_600 });
addHolding(store, { kind: 'cash', name: 'Trust Bank savings', quantity: 3_250 });
addHolding(store, { kind: 'retirement', name: 'CPF Ordinary Account', quantity: 1, price: 61_400 });
addHolding(store, { kind: 'fund', name: 'Endowus Core 80/20', symbol: 'ENDOWUS', quantity: 1, price: 8_920, costBasis: 8_200 });
addHolding(store, { kind: 'stock', name: 'Vanguard S&P 500 ETF', symbol: 'VOO', quantity: 6, price: 548.2, costBasis: 2_910, currency: 'USD' });
logTrade(store, { symbol: 'BTC', side: 'buy', quantity: 0.04, price: 81_200, fee: 3.2, date: day(70), venue: 'Coinhako' }, 'demo');
logTrade(store, { symbol: 'ETH', side: 'buy', quantity: 1.2, price: 2_640, fee: 3.1, date: day(52), venue: 'Coinhako' }, 'demo');
logTrade(store, { symbol: 'SOL', side: 'buy', quantity: 18, price: 141.5, fee: 2.5, date: day(30), venue: 'OKX' }, 'demo');
logTrade(store, { symbol: 'BTC', side: 'buy', quantity: 0.02, price: 94_800, fee: 1.9, date: day(18), venue: 'Coinhako' }, 'demo');
logTrade(store, { symbol: 'SOL', side: 'sell', quantity: 6, price: 176.2, fee: 1.1, date: day(6), venue: 'OKX' }, 'demo');
addAlert(store, { symbol: 'BTC', price: 120_000, direction: 'above', note: 'Take a third off the table' });
addAlert(store, { symbol: 'ETH', price: 2_400, direction: 'below', note: 'Buy the dip with the bonus' });
const card = addDebt(store, { name: 'Citi Rewards card', kind: 'credit_card', lender: 'Citibank', balance: 3_840, original: 6_000, apr: 26.9, minPayment: 250, dueDay: 25 });
payDebt(store, card.id, 400, day(20));
const car = addDebt(store, { name: 'Car loan', kind: 'car', lender: 'Maybank', balance: 38_600, original: 62_000, apr: 2.78, minPayment: 980, dueDay: 8 });
addDebt(store, { name: 'Laptop instalments', kind: 'bnpl', lender: 'Atome', balance: 600, original: 1_800, apr: 0, minPayment: 300, dueDay: 15 });
// What comes round: pay and fixed bills log themselves, the utility bill waits to be marked paid.
const nextOn = (dom: number) => (firstOf(0, dom) >= today ? firstOf(0, dom) : firstOf(-1, dom));
addRecurring(store, { kind: 'income', name: 'Salary', amount: 7200, category: 'Salary', cadence: 'monthly', next: nextOn(25), weekend: 'before' }, today);
addRecurring(store, { kind: 'expense', name: 'Rent', amount: 2400, category: 'Housing', cadence: 'monthly', next: nextOn(1) }, today);
addRecurring(store, { kind: 'expense', name: 'Phone plan', amount: 45.9, category: 'Subscriptions', cadence: 'monthly', next: nextOn(5) }, today);
addRecurring(store, { kind: 'expense', name: 'Spotify + iCloud', amount: 22.98, category: 'Subscriptions', cadence: 'monthly', next: nextOn(6) }, today);
addRecurring(store, { kind: 'expense', name: 'Monthly sadaqah', amount: 50, category: 'Giving', cadence: 'monthly', next: nextOn(20) }, today);
addRecurring(store, { kind: 'expense', name: 'SP Group', amount: 170, category: 'Utilities', cadence: 'monthly', next: day(-2), auto: false }, today);
addRecurring(store, { kind: 'expense', name: 'Car loan instalment', amount: 980, category: 'Debt', cadence: 'monthly', next: nextOn(8), debtId: car.id }, today);
addRecurring(store, { kind: 'expense', name: 'Travel insurance', amount: 289, category: 'Travel', cadence: 'yearly', next: day(-24), auto: false }, today);
db.prepare("UPDATE activity SET ts = ? WHERE entity_type LIKE 'fin_%'").run(new Date(`${day(3)}T10:00:00`).toISOString());

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
  JSON.stringify({ lat: 1.3521, lng: 103.8198, label: 'Singapore', timezone: 'Asia/Singapore', method: 'Singapore', madhab: 'shafi', since: `${day(35)}T00:00:00.000Z`, backlog: { fajr: 3, dhuhr: 0, asr: 1, maghrib: 0, isha: 0 } }),
);
const rates = { fajr: 0.72, dhuhr: 0.9, asr: 0.84, maghrib: 0.97, isha: 0.9 } as const;
for (let ago = 1; ago <= 34; ago++) {
  for (const [prayer, rate] of Object.entries(rates)) {
    if (ago <= 6 && ago % 3 === 0 && prayer === 'asr') continue; // a few left unmarked, so they count as missed
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

// ── Food, training, body composition ───────────────────────────────────────
store.db.prepare("INSERT INTO settings (key, value) VALUES ('nutrition_targets', ?)").run(JSON.stringify({ kcal: 2200, protein: 160, carbs: 220, fat: 70 }));
const meals: [number, string, { name: string; amount: string; kcal: number; protein: number; carbs: number; fat: number }[]][] = [
  [0, '07:40', [{ name: 'Greek yoghurt with berries and oats', amount: '1 bowl', kcal: 420, protein: 32, carbs: 48, fat: 10 }, { name: 'Kopi C kosong', amount: '1 cup', kcal: 25, protein: 1, carbs: 2, fat: 1 }]],
  [0, '12:50', [{ name: 'Chicken rice (steamed)', amount: '1 plate', kcal: 610, protein: 34, carbs: 72, fat: 19 }]],
];
for (let ago = 1; ago <= 13; ago++) {
  const k = 1700 + Math.round(rand() * 900);
  meals.push([ago, '13:00', [{ name: 'Logged day', amount: '', kcal: k, protein: Math.round(k * 0.07), carbs: Math.round(k * 0.11), fat: Math.round(k * 0.035) }]]);
}
for (const [ago, time, items] of meals) at(ago, () => logFood(store, day(ago), time, items, ago === 0 ? 'estimate' : 'manual'), 13);
const sessions: [number, string, 'strength' | 'run', number, number | null][] = [[1, 'Push day', 'strength', 55, null], [3, 'Easy run', 'run', 32, 5.2], [6, 'Pull day', 'strength', 50, null], [8, 'Legs', 'strength', 60, null], [10, 'Tempo run', 'run', 28, 5.0], [13, 'Push day', 'strength', 52, null]];
for (const [ago, name, type, mins, km] of sessions) at(ago, () => logWorkout(store, { date: day(ago), name, type, durationMin: mins, distanceKm: km, kcal: null, notes: '', exercises: type === 'strength' ? [{ name: 'Bench press', sets: [{ reps: 8, weight: 70 }, { reps: 8, weight: 70 }, { reps: 6, weight: 72.5 }] }, { name: 'Overhead press', sets: [{ reps: 8, weight: 40 }, { reps: 8, weight: 40 }] }] : [] }), 7);
for (const [ago, w, bf, mm, vf] of [[56, 80.6, 29.4, 32.1, 13], [28, 79.6, 28.6, 32.4, 12], [7, 78.9, 27.9, 32.8, 12], [1, 78.6, 27.6, 33.0, 11]] as const) {
  at(ago, () => logBody(store, { date: day(ago), weightKg: w, bodyFatPct: bf, muscleKg: mm, visceralFat: vf, waterPct: null, bmr: 1680 + Math.round(mm * 4) }, 'scan'), 7);
}

// ── Saved links, as if shared from a phone ─────────────────────────────────
// Thumbnails are generated soft gradients: the demo never fetches the real pages.
function png(w: number, h: number, colour: (x: number, y: number) => [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set(colour(x, y), y * (w * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const gradient = (a: [number, number, number], b: [number, number, number], glow: [number, number, number]) =>
  png(320, 200, (x, y) => {
    const t = (x / 320) * 0.6 + (y / 200) * 0.4;
    const d = Math.max(0, 1 - Math.hypot(x - 230, y - 60) / 170);
    return [0, 1, 2].map((i) => Math.max(0, Math.min(255, Math.round(a[i]! * (1 - t) + b[i]! * t + (glow[i]! - 128) * d * 0.6)))) as [number, number, number];
  });
const saved = (ago: number, n: { url: string; title: string; summary: string; points?: string[]; kind: string; site: string; author?: string; tags: string[]; collection: string; sphere?: string; image?: Buffer; via: string }) => {
  const id = Math.random().toString(36).slice(2, 12);
  const ts = new Date(`${day(ago)}T19:30:00`).toISOString();
  const imageFileId = n.image ? saveFile(store, n.image, 'image/png', n.title) : null;
  const body = [n.summary, ...(n.points ?? []).map((p) => `• ${p}`)].join('\n');
  store.db.prepare("INSERT INTO notes (id, sphere_id, kind, title, body, url, created_at, updated_at, capture, status) VALUES (?,?,?,?,?,?,?,?,?, 'ready')").run(
    id, n.sphere ?? null, 'link', n.title, body, n.url, ts, ts,
    JSON.stringify({ kind: n.kind, site: n.site, author: n.author ?? '', imageFileId, summary: n.summary, keyPoints: n.points ?? [], tags: n.tags, collection: n.collection, via: n.via }),
  );
};
saved(5, { url: 'https://www.tiktok.com/@demo/video/1', title: '15-minute high-protein breakfast bowl', summary: 'Greek yoghurt, oats, berries and a scoop of whey — about 45 g of protein in a quarter of an hour.', points: ['Overnight oats save the morning rush', 'Swap honey for berries to cut sugar'], kind: 'video', site: 'TikTok', author: '@fitfoodie', tags: ['breakfast', 'protein', 'recipes'], collection: 'Recipes', sphere: sphere.health!, image: gradient([250, 196, 140], [232, 120, 92], [255, 236, 200]), via: 'share' });
saved(4, { url: 'https://x.com/demo/status/1', title: 'Do things that don’t scale', summary: 'A reminder that early products grow by hand-recruiting users one at a time, not by waiting for scale.', kind: 'tweet', site: 'X', author: 'Paul Graham', tags: ['startups', 'growth'], collection: 'Side project ideas', sphere: sphere['side-projects']!, via: 'shortcut' });
saved(3, { url: 'https://www.youtube.com/watch?v=demo', title: 'Tajweed for beginners — lesson 1', summary: 'The first lesson in a series on reciting the Quran with tajweed: makharij, the points where letters are pronounced.', points: ['Practise ten minutes after Fajr'], kind: 'video', site: 'YouTube', author: 'Quran Academy', tags: ['quran', 'tajweed', 'learning'], collection: 'Learning', sphere: sphere.faith!, image: gradient([120, 110, 200], [60, 70, 150], [220, 210, 255]), via: 'app' });
saved(2, { url: 'https://example.com/shelf.png', title: 'Floating oak shelves for the living room', summary: 'A wall of thin oak shelves with plants and books — the look for the reading corner.', kind: 'image', site: 'Pinterest', tags: ['home', 'interiors'], collection: 'Home ideas', image: gradient([200, 220, 205], [150, 180, 160], [240, 255, 240]), via: 'share' });
saved(1, { url: 'https://example.com/kyoto-autumn', title: 'Kyoto’s quiet temples in late autumn', summary: 'Five temples away from the crowds, best visited early on weekday mornings in late November.', points: ['Tofuku-ji before 8:30', 'Book the Okochi Sanso teahouse'], kind: 'article', site: 'Trail Notes', author: 'Mika Sato', tags: ['japan', 'kyoto', 'travel'], collection: 'Trips to plan', sphere: sphere.travels!, image: gradient([230, 150, 110], [170, 80, 90], [255, 220, 160]), via: 'shortcut' });

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

// Travel: KrisFlyer and Bonvoy standing, a Tokyo trip leaving tomorrow morning (so Today
// is in travel mode), and a work trip to London next month.
upsertLoyalty(store, { program: 'KrisFlyer', tier: 'Elite Gold', points: 86420, progress: 41250, progressTarget: 50000, progressLabel: 'elite miles to keep Gold', expires: '2027-06-30', memberSuffix: '4417' }, 'screenshot', true);
upsertLoyalty(store, { program: 'Marriott Bonvoy', tier: 'Platinum Elite', points: 212800, progress: 47, progressTarget: 75, progressLabel: 'nights to Titanium', memberSuffix: '0932' }, 'gmail', true);
upsertLoyalty(store, { program: 'Priority Pass', kind: 'lounge', tier: 'Prestige' }, 'manual', true);
const tokyo = createTrip(store, { title: 'Autumn in Tokyo', destination: 'Tokyo', purpose: 'leisure', startDate: addDays(today, 1), endDate: addDays(today, 6), notes: 'Momiji season. Want: good ramen (halal), a day trip to Nikko or Kamakura, coffee shops in Kiyosumi.' }, true);
const out = addSegment(store, tokyo.id, { kind: 'flight', carrier: 'SQ', number: '636', fromCode: 'SIN', toCode: 'HND', startLocal: `${addDays(today, 1)}T08:05`, endLocal: `${addDays(today, 1)}T15:55`, cabin: 'Premium Economy', seat: '31A', confirmation: 'K7XQ2M' }, 'gmail', 'demo-sq-1', true).segment;
addSegment(store, tokyo.id, { kind: 'stay', title: 'The Westin Tokyo', carrier: 'Marriott', toCode: 'HND', address: 'Yebisu Garden Place, Meguro', startLocal: `${addDays(today, 1)}T15:00`, endLocal: `${addDays(today, 6)}T12:00`, confirmation: '88213907' }, 'gmail', 'demo-mar-1', true);
addSegment(store, tokyo.id, { kind: 'flight', carrier: 'SQ', number: '633', fromCode: 'HND', toCode: 'SIN', startLocal: `${addDays(today, 6)}T11:05`, endLocal: `${addDays(today, 6)}T17:35`, cabin: 'Premium Economy', seat: '31A', confirmation: 'K7XQ2M' }, 'gmail', 'demo-sq-2', true);
db.prepare('UPDATE trips SET companion = ?, drafted = 1 WHERE id = ?').run(
  JSON.stringify({
    [out.id]: {
      lounges: ['KrisFlyer Gold Lounge, Terminal 3 (level 3, above the transfer area) — showers, and a quieter side towards the back', 'With Priority Pass: Plaza Premium Lounge in T3 if Gold is busy'],
      plan: ['Be at T3 by 06:30; check-in and immigration are quick that early', 'The musolla is in the transit area near gate A1 — pray Fajr there before boarding', 'Grab breakfast in the lounge; it is a 7-hour flight with one meal', 'Boarding starts around 07:25 — the A gates are a 10-minute walk from the lounge', 'Tokyo is an hour ahead: set your watch, and plan an early night'],
      generatedAt: new Date().toISOString(),
    },
  }),
  tokyo.id,
);
const d = (n: number) => addDays(today, n);
addItems(store, tokyo.id, [
  { date: d(1), time: '17:30', title: 'Check in at the Westin, walk Yebisu Garden Place', place: 'Ebisu', kind: 'rest' },
  { date: d(1), time: '19:30', title: 'Dinner: Halal Ramen Ouka', place: 'Shinjuku Gyoen', notes: 'Muslim-owned; go early, it queues', kind: 'food' },
  { date: d(2), time: '09:00', title: 'Meiji Jingu and Yoyogi Park for the autumn leaves', place: 'Harajuku', kind: 'activity' },
  { date: d(2), time: '12:30', title: 'Lunch at Gyumon (halal wagyu)', place: 'Shibuya', kind: 'food' },
  { date: d(2), time: '15:00', title: 'Coffee crawl: Blue Bottle, Allpress', place: 'Kiyosumi-Shirakawa', kind: 'activity' },
  { date: d(3), time: '08:00', title: 'Day trip to Nikko — Tobu Limited Express from Asakusa', place: 'Nikko', notes: 'Toshogu shrine, Kegon Falls; pack prayer mat', kind: 'transit' },
  { date: d(4), time: '11:00', title: 'Tokyo Camii for Jumu’ah', place: 'Yoyogi-Uehara', notes: 'Turkish mosque; arrive by 11:30', kind: 'activity' },
  { date: d(4), time: null, title: 'Free afternoon — Daikanyama bookshops', place: 'Daikanyama', kind: 'rest' },
  { date: d(5), time: '10:00', title: 'Kamakura: Great Buddha and the Hase-dera maples', place: 'Kamakura', kind: 'activity' },
  { date: d(6), time: '08:00', title: 'Check out, Limousine Bus to Haneda', place: 'Ebisu → HND', kind: 'transit' },
], true);

const london = createTrip(store, { title: 'London — design leadership summit', destination: 'London', purpose: 'work', startDate: addDays(today, 24), endDate: addDays(today, 29) }, true);
addSegment(store, london.id, { kind: 'flight', carrier: 'SQ', number: '322', fromCode: 'SIN', toCode: 'LHR', startLocal: `${addDays(today, 24)}T23:35`, endLocal: `${addDays(today, 25)}T06:25`, cabin: 'Business', seat: '14A', confirmation: 'R2PL9V' }, 'gmail', 'demo-sq-3', true);
addSegment(store, london.id, { kind: 'stay', title: 'London Marriott Hotel County Hall', carrier: 'Marriott', toCode: 'LHR', address: 'Westminster Bridge Rd', startLocal: `${addDays(today, 25)}T15:00`, endLocal: `${addDays(today, 29)}T12:00` }, 'gmail', 'demo-mar-2', true);
addSegment(store, london.id, { kind: 'flight', carrier: 'SQ', number: '317', fromCode: 'LHR', toCode: 'SIN', startLocal: `${addDays(today, 29)}T11:30`, endLocal: `${addDays(today, 30)}T07:50`, cabin: 'Business', confirmation: 'R2PL9V' }, 'gmail', 'demo-sq-4', true);
addSignal(store, {
  source: 'travel', kind: 'flight', externalId: `flight:${out.id}`, priority: 2, sphereId: sphere.travels!,
  title: 'SQ 636 to Tokyo leaves 08:05 tomorrow',
  body: 'Lounge: KrisFlyer Gold Lounge, Terminal 3. Seldon put together a plan for the morning.',
});

// Job alerts: a few companies, what counts as a fit, and some roles (two new).
{
  const companies: [string, string, string][] = [['Canva', 'lever', 'canva'], ['Airwallex', 'greenhouse', 'airwallex'], ['Linear', 'ashby', 'linear'], ['Grab', 'greenhouse', 'grab']];
  const ids: Record<string, string> = {};
  for (const [company, ats, board] of companies) {
    ids[company] = `jw-${board}`;
    db.prepare('INSERT INTO job_watches (id, company, careers_url, ats, board, last_checked_at, created_at) VALUES (?,?,?,?,?,?,?)').run(ids[company], company, '', ats, board, new Date(Date.now() - 2 * 3600_000).toISOString(), new Date(Date.now() - 20 * 86400_000).toISOString());
  }
  const roles: [string, string, string, string, boolean, string, number][] = [
    ['Canva', 'Senior Product Designer, Growth', 'Singapore', 'Design', false, 'new', 0],
    ['Airwallex', 'Lead Product Designer', 'Singapore', 'Design', false, 'new', 1],
    ['Linear', 'Product Designer', 'Remote (APAC)', 'Design', true, 'saved', 9],
    ['Grab', 'Design Lead, Financial Services', 'Singapore', 'Design', false, 'seen', 16],
    ['Canva', 'Principal Product Designer', 'Sydney', 'Design', false, 'seen', 12],
    ['Grab', 'Senior Backend Engineer', 'Singapore', 'Engineering', false, 'seen', 18],
    ['Airwallex', 'Product Design Intern', 'Singapore', 'Design', false, 'seen', 6],
  ];
  roles.forEach(([company, title, location, dept, remote, status, ago], i) => {
    const seen = new Date(Date.now() - ago * 86400_000).toISOString();
    db.prepare('INSERT INTO job_postings (id, watch_id, external_id, title, location, department, remote, url, posted_at, first_seen_at, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(`jp-${i}`, ids[company]!, `r${i}`, title, location, dept, Number(remote), `https://example.com/jobs/${i}`, seen, seen, status);
  });
  updateIntegration(store, 'jobs', (r) => void ((r.enabled = true), (r.lastRunAt = new Date(Date.now() - 2 * 3600_000).toISOString())));
  setPreferences(store, { keywords: ['product designer', 'design lead', 'head of design'], exclude: ['intern'], locations: ['Singapore'], remote: true });
  addSignal(store, {
    source: 'jobs', kind: 'opening', externalId: 'jw-airwallex:jp-1', priority: 2, sphereId: sphere.work!, occurredAt: new Date(Date.now() - 86400_000).toISOString(),
    title: 'Airwallex is hiring: Lead Product Designer', body: 'Singapore · Design',
    actions: [{ type: 'link', label: 'Open the posting', url: 'https://example.com/jobs/1' }, { type: 'task', label: 'Add as a task', title: 'Apply: Lead Product Designer at Airwallex', sphereId: sphere.work! }],
  });
}

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
