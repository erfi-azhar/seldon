import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { Store } from '../src/store.ts';
import { addAlert, addDebt, addHolding, addRecurring, addTransaction, checkAlerts, financeState, logTrade, markPaid, nthDate, payDebt, payoff, postDue, remindBills, skipNext, syncSymbols, updateRecurring } from '../src/features/finance.ts';
import { marketFor, parseTick, setMarketTransport, type MarketTransport } from '../src/features/markets.ts';
import '../src/features/index.ts';

const TODAY = '2026-11-15';

function fresh(): Store {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['finances'] });
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('finance', ?)").run(JSON.stringify({ currency: 'SGD', budgets: {}, watchlist: [] }));
  return store;
}

/** A fake network: each handler matches a URL and answers with JSON (or a status). */
type Handler = (url: string) => { status?: number; json?: unknown } | null;
let handlers: Handler[] = [];
const seen: string[] = [];
const fakeTransport: MarketTransport = {
  socket: null,
  fetch: (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    for (const h of handlers) {
      const r = h(url);
      if (r) return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{"message":"not found"}', { status: 404 });
  }) as typeof fetch,
};
setMarketTransport(fakeTransport);
after(() => setMarketTransport(null));
beforeEach(() => {
  handlers = [];
  seen.length = 0;
});

const binanceTicker = (symbol: string, last: number, open: number) => ({ symbol: `${symbol}USDT`, lastPrice: String(last), openPrice: String(open), highPrice: String(last * 1.02), lowPrice: String(open * 0.98), quoteVolume: '1000000' });

test('income and spending add up by month and category, against budgets', () => {
  const store = fresh();
  addTransaction(store, { kind: 'income', amount: 6000, category: 'salary', date: '2026-11-01' });
  addTransaction(store, { kind: 'expense', amount: 1800, category: 'Housing', description: 'Rent', date: '2026-11-02' });
  addTransaction(store, { kind: 'expense', amount: 12.5, category: 'food', description: 'Chicken rice', date: '2026-11-14' });
  addTransaction(store, { kind: 'expense', amount: 300, category: 'Food', date: '2026-10-20' });
  store.db.prepare("UPDATE settings SET value = ? WHERE key = 'finance'").run(JSON.stringify({ currency: 'SGD', budgets: { Food: 600, Transport: 150 }, watchlist: [] }));

  const f = financeState(store, TODAY);
  assert.equal(f.month.income, 6000);
  assert.equal(f.month.expense, 1812.5);
  assert.equal(f.month.net, 4187.5);
  assert.ok(Math.abs(f.month.savingsRate! - 4187.5 / 6000) < 1e-9);
  const food = f.month.byCategory.find((c) => c.category === 'Food')!;
  assert.deepEqual([food.amount, food.budget], [12.5, 600], 'categories are matched case-insensitively and carry their budget');
  assert.equal(f.month.byCategory.find((c) => c.category === 'Transport')!.amount, 0, 'a budget with no spending still shows');
  assert.equal(f.month.byCategory.find((c) => c.category === 'Salary')!.kind, 'income');
  assert.deepEqual(f.months.map((m) => m.key), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  assert.equal(f.months[4]!.expense, 300);
});

test('trades move the position at average cost and lock in realized P&L; undo puts it back', () => {
  const store = fresh();
  logTrade(store, { symbol: 'btc', side: 'buy', quantity: 0.1, price: 90_000, fee: 10, date: '2026-11-01' });
  logTrade(store, { symbol: 'BTC', side: 'buy', quantity: 0.1, price: 100_000, fee: 10, date: '2026-11-05' });
  let h = store.db.prepare("SELECT * FROM fin_holdings WHERE symbol = 'BTC'").get() as { quantity: number; cost_basis: number; currency: string };
  assert.ok(Math.abs(h.quantity - 0.2) < 1e-12);
  assert.equal(h.cost_basis, 19_020);
  assert.equal(h.currency, 'USD');

  const sale = logTrade(store, { symbol: 'BTC', side: 'sell', quantity: 0.05, price: 110_000, fee: 5, date: '2026-11-10' });
  // Average cost 95,100 a coin: 0.05 cost 4,755, sold for 5,500 less 5 in fees.
  assert.equal(sale.realized, 740);
  h = store.db.prepare("SELECT * FROM fin_holdings WHERE symbol = 'BTC'").get() as typeof h;
  assert.equal(h.cost_basis, 14_265);

  assert.throws(() => logTrade(store, { symbol: 'BTC', side: 'sell', quantity: 1, price: 1, date: TODAY }), /You hold/);
  assert.throws(() => logTrade(store, { symbol: 'DOGE', side: 'sell', quantity: 1, price: 1, date: TODAY }), /no DOGE position/);

  const act = store.listActivity({ limit: 10 }).find((a) => a.summary.startsWith('Sold'))!;
  assert.ok(store.undo(act.id));
  h = store.db.prepare("SELECT * FROM fin_holdings WHERE symbol = 'BTC'").get() as typeof h;
  assert.ok(Math.abs(h.quantity - 0.2) < 1e-12);
  assert.equal(h.cost_basis, 19_020, 'undoing the sale returns the coins at the cost they left with');
  assert.equal(financeState(store, TODAY).crypto!.realized, 0);
});

test('undoing the only buy of a coin removes the position it made', () => {
  const store = fresh();
  logTrade(store, { symbol: 'SOL', side: 'buy', quantity: 10, price: 150, date: TODAY });
  const act = store.listActivity({ limit: 5 }).find((a) => a.summary.startsWith('Bought'))!;
  assert.ok(store.undo(act.id));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM fin_holdings WHERE symbol = 'SOL'").get()!.n, 0);
});

test('debt payoff: months and interest at the minimum, and payments that can be taken back', () => {
  assert.deepEqual(payoff(1200, 0, 100), { months: 12, interest: 0 });
  assert.equal(payoff(10_000, 24, 150), null, 'a payment below the monthly interest never clears it');
  const p = payoff(5000, 26.9, 250)!;
  assert.equal(p.months, 27);
  assert.ok(p.interest > 1600 && p.interest < 1800, `interest ${p.interest}`);

  const store = fresh();
  const card = addDebt(store, { name: 'Citi card', kind: 'credit_card', balance: 5000, apr: 26.9, minPayment: 250, dueDay: 31 });
  const debt = financeState(store, '2026-11-15').debts[0]!;
  assert.equal(debt.nextDue, '2026-11-30', 'a due day past the month end falls on its last day');
  assert.equal(financeState(store, '2026-12-31').debts[0]!.nextDue, '2026-12-31');

  payDebt(store, card.id, 1000, TODAY);
  let f = financeState(store, TODAY);
  assert.equal(f.debts[0]!.balance, 4000);
  assert.ok(Math.abs(f.debts[0]!.paidOffPct! - 0.2) < 1e-9);
  payDebt(store, card.id, 5000, TODAY);
  f = financeState(store, TODAY);
  assert.equal(f.debts[0]!.balance, 0);
  assert.ok(f.debts[0]!.closedAt, 'paid off');
  const act = store.listActivity({ limit: 5 }).find((a) => a.summary.startsWith('Paid off'))!;
  assert.ok(store.undo(act.id));
  f = financeState(store, TODAY);
  assert.equal(f.debts[0]!.balance, 4000, 'what the payment cleared comes back onto the balance, not the overpayment');
  assert.equal(f.debts[0]!.closedAt, null);
});

test('prices: one batch from Binance, coins it lacks from Coinbase', async () => {
  const store = fresh();
  handlers.push((url) => {
    if (url.includes('binance') && url.includes('symbols=')) return { status: 400, json: { code: -1121, msg: 'Invalid symbol.' } };
    if (url.includes('binance') && url.includes('ticker/24hr?symbol=BTCUSDT')) return { json: binanceTicker('BTC', 100_000, 98_000) };
    if (url.includes('binance') && url.includes('ticker/24hr?symbol=')) return { status: 400, json: { code: -1121 } };
    if (url.includes('coinbase.com/products/XYZ-USD/stats')) return { json: { open: '2', high: '2.2', low: '1.9', last: '2.1', volume: '500' } };
    if (url.includes('klines')) return { json: [[0, '1', '1', '1', '99000'], [0, '1', '1', '1', '100000']] };
    if (url.includes('candles')) return { json: [[0, 1, 1, 1, 2.1, 1], [0, 1, 1, 1, 2.0, 1]] };
    return null;
  });
  const feed = marketFor(store);
  feed.setSymbols(['BTC', 'XYZ', 'USDT', 'NOPE']);
  await feed.refresh().catch(() => undefined);
  const st = feed.state();
  assert.equal(feed.quote('BTC')!.price, 100_000);
  assert.equal(feed.quote('BTC')!.source, 'binance');
  assert.ok(Math.abs(feed.quote('BTC')!.changePct - (2000 / 98_000) * 100) < 1e-9);
  assert.equal(feed.quote('XYZ')!.source, 'coinbase');
  assert.equal(feed.quote('XYZ')!.volume, 500 * 2.1);
  assert.equal(feed.quote('USDT')!.price, 1);
  assert.deepEqual(st.unknown, ['NOPE']);
  assert.deepEqual(st.sparks.BTC, [99_000, 100_000]);
  assert.deepEqual(st.sparks.XYZ, [2.0, 2.1], 'Coinbase candles come newest first');
  feed.stop();
});

test('prices: when Binance refuses the region, Coinbase prices everything', async () => {
  const store = fresh();
  handlers.push((url) => (url.includes('binance') ? { status: 451, json: { msg: 'Service unavailable from a restricted location' } } : null));
  handlers.push((url) => (url.includes('/products/ETH-USD/stats') ? { json: { open: '3000', high: '3100', low: '2950', last: '3050', volume: '10' } } : null));
  const feed = marketFor(store);
  feed.setSymbols(['ETH']);
  await feed.refresh();
  assert.equal(feed.quote('ETH')!.price, 3050);
  assert.equal(feed.quote('ETH')!.source, 'coinbase');
  feed.stop();
});

test('live coins are valued at the market and converted into the base currency', async () => {
  const store = fresh();
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('fx_rates', ?)").run(JSON.stringify({ rates: { USD: 1, SGD: 1.3 }, at: new Date().toISOString() }));
  handlers.push((url) => (url.includes('symbols=') ? { json: [binanceTicker('BTC', 100_000, 95_000)] } : null));
  logTrade(store, { symbol: 'BTC', side: 'buy', quantity: 0.5, price: 80_000, date: TODAY });
  addHolding(store, { kind: 'cash', name: 'DBS Multiplier', quantity: 20_000 });
  addHolding(store, { kind: 'stock', name: 'Apple', symbol: 'AAPL', quantity: 10, currency: 'USD' });
  addDebt(store, { name: 'Car loan', kind: 'car', balance: 30_000 });
  await marketFor(store).refresh();

  const f = financeState(store, TODAY);
  const btc = f.holdings.find((h) => h.symbol === 'BTC')!;
  assert.equal(btc.value, 50_000);
  assert.equal(btc.gain, 10_000);
  assert.equal(btc.valueBase, 65_000);
  assert.equal(btc.change24hPct, (5000 / 95_000) * 100);
  assert.equal(f.crypto!.change24h, 2500);
  assert.equal(f.netWorth.assets, 85_000);
  assert.equal(f.netWorth.debts, 30_000);
  assert.equal(f.netWorth.net, 55_000);
  assert.deepEqual(f.netWorth.unpriced, ['Apple'], 'a stock with no price is named rather than counted as zero');
  marketFor(store).stop();
});

test('a price alert fires once, as a signal in Finances', () => {
  const store = fresh();
  const a = addAlert(store, { symbol: 'BTC', price: 120_000, direction: 'above', note: 'Take some profit' });
  syncSymbols(store);
  assert.ok(marketFor(store).following().includes('BTC'), 'an alert follows its coin');
  const q = (price: number) => ({ symbol: 'BTC', price, open: 110_000, high: price, low: 109_000, changePct: 5, volume: 1, source: 'binance' as const, at: Date.now() });
  assert.equal(checkAlerts(store, [q(119_000)]), 0);
  assert.equal(checkAlerts(store, [q(121_000)]), 1);
  assert.equal(checkAlerts(store, [q(125_000)]), 0, 'only once');
  const sig = store.db.prepare("SELECT * FROM signals WHERE source = 'markets'").get() as { title: string; body: string; sphere_id: string };
  assert.match(sig.title, /BTC is above \$120,000/);
  assert.match(sig.body, /Take some profit/);
  assert.equal(sig.sphere_id, store.listSpheres().find((s) => s.key === 'finances')!.id);
  assert.ok(financeState(store, TODAY).alerts.find((x) => x.id === a.id)!.triggeredAt);
  marketFor(store).stop();
});

test('stream messages from both venues read as quotes', () => {
  const b = parseTick('binance', JSON.stringify({ stream: 'btcusdt@miniTicker', data: { e: '24hrMiniTicker', s: 'BTCUSDT', c: '101000', o: '100000', h: '102000', l: '99000', v: '10', q: '1000000' } }))!;
  assert.deepEqual([b.symbol, b.price, b.changePct, b.volume], ['BTC', 101_000, 1, 1_000_000]);
  const c = parseTick('coinbase', JSON.stringify({ type: 'ticker', product_id: 'SOL-USD', price: '150', open_24h: '120', high_24h: '155', low_24h: '119', volume_24h: '1000' }))!;
  assert.deepEqual([c.symbol, c.price, c.changePct, c.volume], ['SOL', 150, 25, 150_000]);
  assert.equal(parseTick('coinbase', JSON.stringify({ type: 'subscriptions' })), null);
  assert.equal(parseTick('binance', 'not json'), null);
});

test('the API: add, read and remove across the suite', async () => {
  const db = openDb(':memory:');
  const app = createApp({ db });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://localhost${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> & { [k: string]: never } };
  };
  await call('POST', '/api/onboarding', { userName: 'Sam', agentName: '', sphereKeys: ['finances'] });
  await call('PUT', `/api/finance/settings?date=${TODAY}`, { currency: 'SGD', budgets: { Food: 500 } });
  const tx = await call('POST', `/api/finance/transactions?date=${TODAY}`, { kind: 'expense', amount: 42, category: 'Food', description: 'Groceries' });
  assert.equal(tx.status, 201);
  const state = tx.json as unknown as { currency: string; month: { expense: number }; transactions: { id: string }[]; budgets: Record<string, number> };
  assert.equal(state.currency, 'SGD');
  assert.equal(state.month.expense, 42);
  assert.deepEqual(state.budgets, { Food: 500 });

  const bad = await call('POST', '/api/finance/trades', { symbol: 'BTC', side: 'sell', quantity: 1, price: 1 });
  assert.equal(bad.status, 400);

  const debt = (await call('POST', '/api/finance/debts', { name: 'Personal loan', kind: 'personal', balance: 8000, apr: 6.5, min_payment: 300 })).json as unknown as { debts: { id: string; payoff: { months: number } }[] };
  assert.ok(debt.debts[0]!.payoff.months > 0);
  const paid = (await call('POST', `/api/finance/debts/${debt.debts[0]!.id}/payments`, { amount: 500 })).json as unknown as { debts: { balance: number }[] };
  assert.equal(paid.debts[0]!.balance, 7500);

  const del = await call('DELETE', `/api/finance/transactions/${state.transactions[0]!.id}`);
  assert.equal((del.json as unknown as { transactions: unknown[] }).transactions.length, 0);
  assert.equal((await call('DELETE', '/api/finance/transactions/nope')).status, 404);
  marketFor(new Store(db)).stop();
});

// ── Recurring ──────────────────────────────────────────────────────────────

const recurringRow = (store: Store, id: string) => store.db.prepare('SELECT * FROM fin_recurring WHERE id = ?').get(id) as { done: number; active: number };
const txs = (store: Store) => store.db.prepare('SELECT date, kind, amount, description, source, recurring_id FROM fin_transactions ORDER BY date, created_at').all() as { date: string; kind: string; amount: number; description: string; source: string }[];

test('schedules keep their day: month ends, quarters, years and weeks', () => {
  assert.deepEqual([0, 1, 2, 3].map((n) => nthDate('2026-01-31', 'monthly', 31, n)), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual([0, 1, 2].map((n) => nthDate('2026-11-30', 'monthly', 31, n)), ['2026-11-30', '2026-12-31', '2027-01-31'], 'day 31 starting in a 30-day month still lands on the 31st after');
  assert.deepEqual([0, 1, 4].map((n) => nthDate('2026-11-15', 'quarterly', 15, n)), ['2026-11-15', '2027-02-15', '2027-11-15']);
  assert.deepEqual([0, 1, 2].map((n) => nthDate('2028-02-29', 'yearly', 29, n)), ['2028-02-29', '2029-02-28', '2030-02-28']);
  assert.deepEqual([0, 1].map((n) => nthDate('2026-12-28', 'biweekly', null, n)), ['2026-12-28', '2027-01-11']);
});

test('salary logs itself on pay day, a day early when that falls on a weekend', () => {
  const store = fresh();
  // 25 Dec 2026 is a Friday; 25 Apr 2027 is a Sunday, so that pay day moves to Friday the 23rd.
  const pay = addRecurring(store, { kind: 'income', name: 'Salary', amount: 7200, category: 'Salary', cadence: 'monthly', next: '2026-11-25', weekend: 'before' }, TODAY);
  assert.equal(pay.next, '2026-11-25');
  assert.equal(postDue(store, '2026-11-24'), 0);
  assert.equal(postDue(store, '2026-11-25'), 1);
  assert.equal(postDue(store, '2026-11-25'), 0, 'once');
  assert.deepEqual(txs(store).map((t) => [t.date, t.amount, t.source]), [['2026-11-25', 7200, 'recurring']]);
  // The server was off for months: everything missed is caught up, each on its own date.
  assert.equal(postDue(store, '2027-04-30'), 5);
  assert.deepEqual(txs(store).map((t) => t.date), ['2026-11-25', '2026-12-25', '2027-01-25', '2027-02-25', '2027-03-25', '2027-04-23']);

  // A deleted auto entry stays deleted: the schedule has moved past it.
  store.db.prepare("DELETE FROM fin_transactions WHERE date = '2027-04-23'").run();
  assert.equal(postDue(store, '2027-04-30'), 0);
});

test('starting from a date in the past logs nothing already gone by', () => {
  const store = fresh();
  const rent = addRecurring(store, { kind: 'expense', name: 'Rent', amount: 2400, category: 'Housing', cadence: 'monthly', next: '2026-01-01' }, TODAY);
  assert.equal(rent.next, '2026-12-01');
  assert.equal(postDue(store, TODAY), 0);
  assert.equal(txs(store).length, 0);
});

test('a bill paid by hand: reminded ahead once, marked paid at what it came to, undo puts it back', () => {
  const store = fresh();
  const bill = addRecurring(store, { kind: 'expense', name: 'SP Group', amount: 170, category: 'Utilities', cadence: 'monthly', next: '2026-11-20', auto: false }, TODAY);
  assert.equal(postDue(store, '2026-11-21'), 0, 'never logged by itself');
  assert.equal(remindBills(store, '2026-11-16'), 0, 'too early');
  assert.equal(remindBills(store, '2026-11-17'), 1);
  assert.equal(remindBills(store, '2026-11-18'), 0, 'once per bill');
  const sig = store.db.prepare("SELECT title, status, actions FROM signals WHERE source = 'finance'").get() as { title: string; status: string; actions: string };
  assert.match(sig.title, /SP Group due Friday — SGD/);
  assert.equal(JSON.parse(sig.actions)[0].dueDate, '2026-11-20');

  let f = financeState(store, '2026-11-22');
  assert.deepEqual(f.upcoming.filter((u) => u.overdue).map((u) => u.name), ['SP Group'], 'unpaid after its date: overdue');

  markPaid(store, bill.id, '2026-11-22', { amount: 183.4 });
  assert.deepEqual(txs(store).map((t) => [t.date, t.amount, t.description]), [['2026-11-22', 183.4, 'SP Group']]);
  assert.equal((store.db.prepare("SELECT status FROM signals WHERE source = 'finance'").get() as { status: string }).status, 'done', 'paying it closes the reminder');
  f = financeState(store, '2026-11-22');
  assert.equal(f.recurring[0]!.next, '2026-12-20');

  const act = store.listActivity({ limit: 5 }).find((a) => a.summary.startsWith('Spent'))!;
  assert.ok(store.undo(act.id));
  assert.equal(txs(store).length, 0);
  assert.equal(financeState(store, '2026-11-22').recurring[0]!.next, '2026-11-20', 'undo leaves it waiting to be paid again');

  skipNext(store, bill.id);
  assert.equal(financeState(store, '2026-11-22').recurring[0]!.next, '2026-12-20');
});

test('a loan instalment pays its debt down, and stops once the debt is cleared', () => {
  const store = fresh();
  const loan = addDebt(store, { name: 'Laptop', kind: 'bnpl', balance: 600, minPayment: 300 });
  const plan = addRecurring(store, { kind: 'expense', name: 'Laptop instalment', amount: 300, category: 'x', cadence: 'monthly', next: '2026-11-20', debtId: loan.id }, TODAY);
  assert.equal(postDue(store, '2027-02-01'), 2);
  const f = financeState(store, '2027-02-01');
  assert.equal(f.debts[0]!.balance, 0);
  assert.ok(f.debts[0]!.closedAt);
  assert.equal(txs(store).length, 0, 'a debt payment, not spending');
  assert.equal(recurringRow(store, plan.id).active, 0, 'nothing left to pay: it stops');
});

test('the month ahead: what is still to come and what it leaves', () => {
  const store = fresh();
  addTransaction(store, { kind: 'expense', amount: 1000, category: 'Food', date: '2026-11-03' });
  addRecurring(store, { kind: 'income', name: 'Salary', amount: 7200, category: 'Salary', cadence: 'monthly', next: '2026-11-25' }, TODAY);
  addRecurring(store, { kind: 'expense', name: 'Netflix', amount: 20, category: 'Subscriptions', cadence: 'monthly', next: '2026-11-28' }, TODAY);
  addRecurring(store, { kind: 'expense', name: 'Gym', amount: 15, category: 'Health', cadence: 'weekly', next: '2026-11-17' }, TODAY);
  addRecurring(store, { kind: 'expense', name: 'Insurance', amount: 1200, category: 'Health', cadence: 'yearly', next: '2027-03-01' }, TODAY);
  const f = financeState(store, TODAY);
  assert.deepEqual(f.month.expected, { income: 7200, expense: 20 + 15 * 2, net: -1000 + 7200 - 50 }, 'the gym comes round on the 17th and the 24th');
  assert.equal(f.recurringMonthly.income, 7200);
  assert.equal(f.recurringMonthly.expense, 20 + 65 + 100);
  assert.ok(f.upcoming.every((u) => u.date <= '2026-12-20'), 'five weeks ahead');
  assert.equal(f.upcoming[0]!.name, 'Gym');
});

test('a pause logs nothing while paused, and resuming picks up from today', () => {
  const store = fresh();
  const gym = addRecurring(store, { kind: 'expense', name: 'Gym', amount: 90, category: 'Health', cadence: 'monthly', next: '2026-11-20' }, TODAY);
  updateRecurring(store, gym.id, { active: false }, TODAY);
  assert.equal(postDue(store, '2027-01-25'), 0);
  const back = updateRecurring(store, gym.id, { active: true }, '2027-01-25');
  assert.equal(back.next, '2027-02-20');
  const raised = updateRecurring(store, gym.id, { amount: 110 }, '2027-01-25');
  assert.equal(raised.amount, 110);
  assert.equal(postDue(store, '2027-02-20'), 1);
  assert.equal(txs(store)[0]!.amount, 110);
});

test('the API: set up, mark paid, skip and remove recurring items', async () => {
  const db = openDb(':memory:');
  const app = createApp({ db });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://localhost${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as { recurring: { id: string; next: string }[]; transactions: unknown[]; upcoming: unknown[] } };
  };
  await call('POST', '/api/onboarding', { userName: 'Sam', agentName: '', sphereKeys: ['finances'] });
  const made = await call('POST', `/api/finance/recurring?date=${TODAY}`, { kind: 'expense', name: 'Rent', amount: 2400, category: 'Housing', cadence: 'monthly', next: TODAY });
  assert.equal(made.status, 201);
  assert.equal(made.json.transactions.length, 1, 'due today and automatic: logged straight away');
  const id = made.json.recurring[0]!.id;
  assert.equal(made.json.recurring[0]!.next, '2026-12-15');
  assert.equal((await call('POST', `/api/finance/recurring/${id}/skip?date=${TODAY}`)).json.recurring[0]!.next, '2027-01-15');
  assert.equal((await call('POST', `/api/finance/recurring/${id}/paid?date=${TODAY}`, { amount: 2450 })).json.transactions.length, 2);
  assert.equal((await call('POST', '/api/finance/recurring', { kind: 'expense', name: 'X', amount: 1, category: 'Food', cadence: 'daily', next: TODAY })).status, 400);
  assert.equal((await call('DELETE', `/api/finance/recurring/${id}`)).json.recurring.length, 0);
  assert.equal((await call('GET', `/api/finance?date=${TODAY}`)).json.transactions.length, 2, 'what it logged stays');
  marketFor(new Store(db)).stop();
});

test('editing a recurring item leaves its schedule alone unless the date or frequency changes', () => {
  const store = fresh();
  // 25 Apr 2027 is a Sunday: shown as Friday the 23rd.
  const pay = addRecurring(store, { kind: 'income', name: 'Salary', amount: 7200, category: 'Salary', cadence: 'monthly', next: '2027-04-25', weekend: 'before' }, '2027-04-01');
  assert.equal(pay.next, '2027-04-23');
  updateRecurring(store, pay.id, { amount: 7500, next: '2027-04-23' }, '2027-04-01');
  let r = financeState(store, '2027-04-01').recurring[0]!;
  assert.deepEqual([r.next, r.day, r.amount], ['2027-04-23', 25, 7500], 'still the 25th underneath');
  updateRecurring(store, pay.id, { cadence: 'quarterly' }, '2027-04-01');
  r = financeState(store, '2027-04-01').recurring[0]!;
  assert.deepEqual([r.anchor, r.day, r.cadence], ['2027-04-25', 25, 'quarterly']);

  const bill = addRecurring(store, { kind: 'expense', name: 'Water', amount: 40, category: 'Utilities', cadence: 'monthly', next: '2027-04-10', auto: false }, '2027-04-01');
  updateRecurring(store, bill.id, { amount: 45 }, '2027-04-20');
  assert.equal(financeState(store, '2027-04-20').recurring.find((x) => x.id === bill.id)!.next, '2027-04-10', 'an overdue bill stays waiting after an edit');
});
