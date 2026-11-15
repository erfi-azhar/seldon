import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { Store } from '../src/store.ts';
import '../src/features/index.ts';
import { addApproval, addPayment, bankruptcyState, tripWindow, updateCase } from '../src/features/bankruptcy.ts';

const TODAY = '2026-11-16';

function fresh(): Store {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['finances'] });
  return store;
}

/** The figures from a real case: declared liabilities, S$3,500 a month from Jan 2025, eight receipts. */
function aCase(): Store {
  const store = fresh();
  updateCase(store, { reference: 'HC/B/3364/2023', trustee: 'RSM Singapore', trusteeEmail: 'admin@ptib.rsmsingapore.sg', declaredLiabilities: 54_462.35, monthlyContribution: 3_500, targetMonths: 52, contributionsFrom: '2025-01' });
  for (const [date, amount] of [['2024-12-20', 1000], ['2025-03-28', 7000], ['2025-04-30', 3500], ['2025-05-30', 3500], ['2025-09-29', 15000], ['2026-01-29', 3500], ['2026-04-09', 3500], ['2026-08-15', 14000]] as const) {
    addPayment(store, { date, amount, reference: 'MinLaw receipt' });
  }
  return store;
}

let tripN = 0;
function trip(store: Store, title: string, start: string, end: string, flights: [depart: string, arrive: string][]): void {
  const id = `t${++tripN}`;
  store.db.prepare('INSERT INTO trips (id, title, start_date, end_date, created_at) VALUES (?,?,?,?,?)').run(id, title, start, end, new Date().toISOString());
  flights.forEach(([dep, arr], i) => {
    store.db.prepare("INSERT INTO trip_segments (id, trip_id, kind, start_local, end_local, start_utc, end_utc, created_at) VALUES (?,?,'flight',?,?,?,?,?)").run(`${id}-${i}`, id, dep, arr, `${dep}:00Z`, `${arr}:00Z`, new Date().toISOString());
  });
}

test('the two routes, this month and the schedule, from the payments on file', () => {
  const s = bankruptcyState(aCase(), TODAY);
  assert.equal(s.active, true);
  assert.equal(s.paid, 51_000);
  assert.deepEqual(s.settlement, { target: 54_462.35, estimated: true, remaining: 3_462.35 });
  assert.deepEqual(s.contribution, { target: 182_000, remaining: 131_000 });
  // January 2025 to November 2026 is 23 months of S$3,500.
  assert.deepEqual(s.schedule, { months: 23, expected: 80_500, behind: 29_500 });
  assert.deepEqual(s.thisMonth, { due: 3_500, paid: 0 });
  assert.equal(s.payments[0]!.date, '2026-08-15', 'newest first');
});

test("the trustee's settlement quote replaces the estimate; known fees add to it until then", () => {
  const store = aCase();
  updateCase(store, { feesKnown: 4_000 });
  assert.deepEqual(bankruptcyState(store, TODAY).settlement, { target: 58_462.35, estimated: true, remaining: 7_462.35 });
  updateCase(store, { settlementQuote: { amount: 9_800, asOf: '2026-11-20' } });
  assert.deepEqual(bankruptcyState(store, TODAY).settlement, { target: 9_800, estimated: false, remaining: 0 }, 'a quote is what is left, net of what was paid');
});

test('an early-morning flight counts from the evening before, when you clear the airport', () => {
  assert.deepEqual(tripWindow({ start_date: '2026-12-22', end_date: '2026-12-30' }, [{ start_local: '2026-12-22T00:30', end_local: '2026-12-22T09:00' }, { start_local: '2026-12-29T22:00', end_local: '2026-12-30T16:00' }]), { leave: '2026-12-21', back: '2026-12-30', earlyFlight: true });
  assert.deepEqual(tripWindow({ start_date: '2026-12-22', end_date: '2026-12-30' }, []), { leave: '2026-12-22', back: '2026-12-30', earlyFlight: false });
});

test('upcoming trips are checked against approvals: covered, outside (both ends), or none', () => {
  const store = aCase();
  // Like the Slovakia trip: a 00:30 departure on the day the approval starts.
  trip(store, 'Bratislava', '2026-12-22', '2027-01-05', [['2026-12-22T00:30', '2026-12-22T09:00'], ['2027-01-04T20:00', '2027-01-05T15:00']]);
  addApproval(store, { place: 'Slovakia', from: '2026-12-22', to: '2027-01-06' });
  // Like the Vietnam trip: back two days after the approval ends.
  trip(store, 'Hanoi', '2026-11-20', '2026-11-28', [['2026-11-20T09:00', '2026-11-20T12:00'], ['2026-11-28T13:00', '2026-11-28T17:00']]);
  addApproval(store, { place: 'Vietnam', from: '2026-11-19', to: '2026-11-26' });
  trip(store, 'Tokyo', '2027-02-10', '2027-02-15', [['2027-02-10T10:00', '2027-02-10T18:00'], ['2027-02-15T10:00', '2027-02-15T16:00']]);
  addApproval(store, { place: 'Japan', from: '2027-02-09', to: '2027-02-16' });
  trip(store, 'Seoul', '2027-03-01', '2027-03-05', []);
  // Past trips aren't checked.
  trip(store, 'Old trip', '2026-01-01', '2026-01-05', []);

  const checks = bankruptcyState(store, TODAY).trips;
  const by = Object.fromEntries(checks.map((t) => [t.title, t]));
  assert.equal(by.Bratislava!.status, 'outside');
  assert.match(by.Bratislava!.message, /you leave Mon 21 Dec \(an early flight: you clear the airport the evening before\) but approval starts Tue 22 Dec/);
  assert.equal(by.Hanoi!.status, 'outside');
  assert.match(by.Hanoi!.message, /you're back Sat 28 Nov but approval ends Thu 26 Nov/);
  assert.equal(by.Tokyo!.status, 'covered');
  assert.equal(by.Seoul!.status, 'none');
  assert.equal(by['Old trip'], undefined);
});

test('a payment can be taken back with undo; the API records and removes', async () => {
  const store = aCase();
  addPayment(store, { date: '2026-11-16', amount: 3_500, reference: 'TXN123' });
  assert.equal(bankruptcyState(store, TODAY).thisMonth!.paid, 3_500);
  const act = store.listActivity({ limit: 3 }).find((a) => a.summary.startsWith('Bankruptcy contribution'))!;
  assert.ok(store.undo(act.id));
  assert.equal(bankruptcyState(store, TODAY).paid, 51_000);

  const db = openDb(':memory:');
  const app = createApp({ db });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://localhost${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { active: boolean; paid: number; payments: { id: string }[]; approvals: unknown[] } };
  };
  assert.equal((await call('GET', `/api/bankruptcy?date=${TODAY}`)).body.active, false, 'nothing shows until a case is set up');
  await call('PUT', '/api/bankruptcy', { reference: 'HC/B/1/2026', declared_liabilities: 10_000, monthly_contribution: 500, contributions_from: '2026-01' });
  const paid = await call('POST', `/api/bankruptcy/payments?date=${TODAY}`, { date: '2026-11-01', amount: 500, reference: 'R1' });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.paid, 500);
  assert.equal((await call('POST', '/api/bankruptcy/approvals', { from: '2026-12-10', to: '2026-12-01' })).status, 400);
  assert.equal((await call('DELETE', `/api/bankruptcy/payments/${paid.body.payments[0]!.id}`)).body.paid, 0);
});
