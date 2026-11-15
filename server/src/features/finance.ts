// Finances: money in and out (with monthly budgets), what you own, what you owe, and a
// crypto desk — live prices, a trade log that keeps positions and average cost, and price
// alerts that arrive as signals. Net worth falls out of the three, in your own currency.

import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { registerSnapshotSection } from '../agent/snapshot-hooks.ts';
import { tool } from '../agent/tools.ts';
import { read, today as todayOf } from '../http.ts';
import { Invalid, newId, NotFound, nowIso, registerUndo, type Store } from '../store.ts';
import type { Debt, DebtKind, FinanceState, Holding, HoldingKind, PriceAlert, Quote, Trade, Transaction, TxKind } from '../../../shared/types.ts';
import { getIntegration, saveIntegration } from './integrations.ts';
import { convert, marketFor, normSymbol, refreshFx, STABLE, storedFx, symbolOk, type FxRates } from './markets.ts';
import { registerFeature } from './registry.ts';
import { addSignal } from './signals.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const r2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 1e-9;

export const EXPENSE_CATEGORIES = ['Housing', 'Food', 'Groceries', 'Transport', 'Utilities', 'Shopping', 'Health', 'Entertainment', 'Travel', 'Subscriptions', 'Education', 'Family', 'Giving', 'Fees & interest', 'Other'];
export const INCOME_CATEGORIES = ['Salary', 'Bonus', 'Freelance', 'Business', 'Investments', 'Trading', 'Gifts', 'Refunds', 'Other'];

const financeSphere = (store: Store) => store.listSpheres().find((s) => s.key === 'finances') ?? null;

// ── Settings: currency, budgets, watchlist ──────────────────────────────────

interface FinanceSettings {
  currency: string;
  budgets: Record<string, number>;
  watchlist: string[];
}

const ZONE_CURRENCY: [RegExp, string][] = [
  [/^Asia\/Singapore$/, 'SGD'],
  [/^Asia\/(Kuala_Lumpur|Kuching)$/, 'MYR'],
  [/^Asia\/(Jakarta|Makassar|Jayapura|Pontianak)$/, 'IDR'],
  [/^Asia\/(Dubai|Muscat)$/, 'AED'],
  [/^Asia\/Riyadh$/, 'SAR'],
  [/^Asia\/Tokyo$/, 'JPY'],
  [/^Asia\/(Hong_Kong)$/, 'HKD'],
  [/^Europe\/London$/, 'GBP'],
  [/^Europe\//, 'EUR'],
  [/^Australia\//, 'AUD'],
];

function getSettings(store: Store): FinanceSettings {
  const r = store.db.prepare("SELECT value FROM settings WHERE key = 'finance'").get() as { value: string } | undefined;
  const saved = r ? (JSON.parse(r.value) as Partial<FinanceSettings>) : {};
  const zone = store.zone() ?? '';
  const guess = ZONE_CURRENCY.find(([re]) => re.test(zone))?.[1] ?? 'USD';
  return { currency: saved.currency ?? guess, budgets: saved.budgets ?? {}, watchlist: saved.watchlist ?? ['BTC', 'ETH', 'SOL'] };
}

function saveSettings(store: Store, next: FinanceSettings): void {
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('finance', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
}

function updateSettings(store: Store, patch: { currency?: string; budgets?: Record<string, number | null> }): void {
  const s = getSettings(store);
  if (patch.currency) s.currency = patch.currency.toUpperCase();
  for (const [cat, amt] of Object.entries(patch.budgets ?? {})) {
    const name = cleanCategory(cat);
    if (amt === null || amt <= 0) delete s.budgets[name];
    else s.budgets[name] = r2(amt);
  }
  saveSettings(store, s);
}

export function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

const usd = (n: number) => {
  const digits = n >= 1000 ? 0 : n >= 1 ? 2 : 6;
  return `$${n.toLocaleString('en', { maximumFractionDigits: digits })}`;
};

const cleanCategory = (c: string): string => {
  const t = c.trim().slice(0, 40);
  if (!t) return 'Other';
  const known = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES].find((k) => k.toLowerCase() === t.toLowerCase());
  return known ?? t[0]!.toUpperCase() + t.slice(1);
};

// ── Which coins to follow ───────────────────────────────────────────────────

function followedSymbols(store: Store): string[] {
  const held = store.db.prepare("SELECT DISTINCT symbol FROM fin_holdings WHERE kind = 'crypto' AND symbol != '' AND price IS NULL").all() as Row[];
  const alerts = store.db.prepare('SELECT DISTINCT symbol FROM fin_alerts WHERE triggered_at IS NULL').all() as Row[];
  return [...new Set([...getSettings(store).watchlist, ...held.map((r) => r.symbol as string), ...alerts.map((r) => r.symbol as string)])];
}

/** Point the price feed at what's held, watched and alerted on. */
export function syncSymbols(store: Store): void {
  marketFor(store).setSymbols(followedSymbols(store));
}

function addToWatchlist(store: Store, raw: string): string {
  const symbol = normSymbol(raw);
  if (!symbolOk(symbol)) throw new Invalid('A coin is a short ticker like BTC or SOL');
  const s = getSettings(store);
  if (!s.watchlist.includes(symbol)) {
    if (s.watchlist.length >= 30) throw new Invalid('The watchlist holds 30 coins at most');
    s.watchlist.push(symbol);
    saveSettings(store, s);
  }
  syncSymbols(store);
  return symbol;
}

function removeFromWatchlist(store: Store, raw: string): void {
  const s = getSettings(store);
  s.watchlist = s.watchlist.filter((x) => x !== normSymbol(raw));
  saveSettings(store, s);
  syncSymbols(store);
}

// ── Transactions ────────────────────────────────────────────────────────────

const txFromRow = (r: Row): Transaction => ({ id: r.id, date: r.date, kind: r.kind, amount: r.amount, currency: r.currency, category: r.category, description: r.description, source: r.source });

export interface TxInput {
  kind: TxKind;
  amount: number;
  category: string;
  description?: string;
  date: string;
  currency?: string;
}

export function addTransaction(store: Store, t: TxInput, source = 'manual'): Transaction {
  if (!(t.amount > 0)) throw new Invalid('An amount above zero');
  const id = newId();
  const currency = (t.currency ?? getSettings(store).currency).toUpperCase();
  const category = cleanCategory(t.category);
  const description = (t.description ?? '').trim().slice(0, 200);
  store.db
    .prepare('INSERT INTO fin_transactions (id, date, kind, amount, currency, category, description, source, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, t.date, t.kind, r2(t.amount), currency, category, description, source, nowIso());
  const what = description ? ` — ${description}` : '';
  store.record('created', 'fin_tx', id, financeSphere(store)?.id ?? null, t.kind === 'income' ? `Income: ${money(t.amount, currency)} ${category}${what}` : `Spent ${money(t.amount, currency)} on ${category}${what}`);
  return txFromRow(store.db.prepare('SELECT * FROM fin_transactions WHERE id = ?').get(id) as Row);
}

registerUndo('created:fin_tx', (db, id) => void db.prepare('DELETE FROM fin_transactions WHERE id = ?').run(id));

// ── Holdings and valuation ──────────────────────────────────────────────────

export interface HoldingInput {
  kind: HoldingKind;
  name: string;
  symbol?: string;
  quantity: number;
  costBasis?: number;
  price?: number | null;
  currency?: string;
  notes?: string;
}

/** A coin you hold without a price of your own is priced live, in dollars. */
const isLive = (kind: string, symbol: string, price: number | null) => kind === 'crypto' && !!symbol && price === null;

export function addHolding(store: Store, h: HoldingInput): Row {
  const symbol = h.symbol ? normSymbol(h.symbol) : '';
  if (h.kind === 'crypto' && !symbolOk(symbol)) throw new Invalid('A coin needs its ticker, like BTC');
  const price = h.kind === 'cash' ? 1 : h.price ?? null;
  const currency = (h.kind === 'crypto' && price === null ? 'USD' : h.currency ?? getSettings(store).currency).toUpperCase();
  const id = newId();
  const now = nowIso();
  store.db
    .prepare('INSERT INTO fin_holdings (id, kind, name, symbol, quantity, cost_basis, price, currency, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, h.kind, (h.name.trim() || symbol || 'Holding').slice(0, 80), symbol, h.quantity, r2(h.costBasis ?? 0), price, currency, (h.notes ?? '').slice(0, 500), now, now);
  store.record('created', 'fin_holding', id, financeSphere(store)?.id ?? null, `Added ${h.name || symbol} to the portfolio`);
  syncSymbols(store);
  return store.db.prepare('SELECT * FROM fin_holdings WHERE id = ?').get(id) as Row;
}

registerUndo('created:fin_holding', (db, id) => void db.prepare('DELETE FROM fin_holdings WHERE id = ?').run(id));

export function updateHolding(store: Store, id: string, patch: { name?: string; quantity?: number; costBasis?: number; price?: number | null; notes?: string }): void {
  const row = store.db.prepare('SELECT * FROM fin_holdings WHERE id = ?').get(id) as Row | undefined;
  if (!row) throw new NotFound('Holding');
  const next = {
    name: patch.name?.trim().slice(0, 80) || row.name,
    quantity: patch.quantity ?? row.quantity,
    cost_basis: patch.costBasis !== undefined ? r2(patch.costBasis) : row.cost_basis,
    price: row.kind === 'cash' ? 1 : patch.price !== undefined ? patch.price : row.price,
    notes: patch.notes !== undefined ? patch.notes.slice(0, 500) : row.notes,
  };
  store.db.prepare('UPDATE fin_holdings SET name = ?, quantity = ?, cost_basis = ?, price = ?, notes = ?, updated_at = ? WHERE id = ?').run(next.name, next.quantity, next.cost_basis, next.price, next.notes, nowIso(), id);
  syncSymbols(store);
}

function deleteHolding(store: Store, id: string): void {
  if (store.db.prepare('DELETE FROM fin_holdings WHERE id = ?').run(id).changes === 0) throw new NotFound('Holding');
  syncSymbols(store);
}

function valueHolding(r: Row, quote: Quote | null, fx: FxRates | null, base: string): Holding {
  const live = isLive(r.kind, r.symbol, r.price);
  const unitPrice = live ? (quote?.price ?? null) : r.price;
  const value = unitPrice === null ? null : r2(r.quantity * unitPrice);
  const showsGain = value !== null && r.cost_basis > 0 && r.kind !== 'cash';
  const gain = showsGain ? r2(value - r.cost_basis) : null;
  const valueBase = value === null ? null : convert(value, r.currency, base, fx);
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    symbol: r.symbol,
    quantity: r.quantity,
    costBasis: r.cost_basis,
    price: r.price,
    currency: r.currency,
    notes: r.notes,
    updatedAt: r.updated_at,
    unitPrice,
    live,
    value,
    gain,
    gainPct: gain !== null ? gain / r.cost_basis : null,
    valueBase: valueBase === null ? null : r2(valueBase),
    change24hPct: live && quote ? quote.changePct : null,
  };
}

// ── Trades ──────────────────────────────────────────────────────────────────

const tradeFromRow = (r: Row): Trade => ({ id: r.id, holdingId: r.holding_id, symbol: r.symbol, side: r.side, quantity: r.quantity, price: r.price, fee: r.fee, realized: r.realized, date: r.date, venue: r.venue, notes: r.notes });

export interface TradeInput {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  /** Per coin, in dollars. */
  price: number;
  fee?: number;
  date: string;
  venue?: string;
  notes?: string;
}

/**
 * Log a trade and move the position with it: a buy adds coins at their cost (fee included),
 * a sale takes coins out at the average cost and locks in the difference as realized P&L.
 */
export function logTrade(store: Store, t: TradeInput, source = 'manual'): Trade {
  const symbol = normSymbol(t.symbol);
  if (!symbolOk(symbol)) throw new Invalid('A coin is a short ticker like BTC or SOL');
  if (!(t.quantity > 0) || !(t.price > 0)) throw new Invalid('A trade needs a quantity and a price above zero');
  const fee = Math.max(0, t.fee ?? 0);
  return store.tx(() => {
    let holding = store.db.prepare("SELECT * FROM fin_holdings WHERE kind = 'crypto' AND symbol = ? AND price IS NULL ORDER BY created_at LIMIT 1").get(symbol) as Row | undefined;
    let created = false;
    if (!holding) {
      if (t.side === 'sell') throw new Invalid(`There's no ${symbol} position to sell from. Log the buy first, or add it to the portfolio.`);
      const id = newId();
      const now = nowIso();
      store.db.prepare("INSERT INTO fin_holdings (id, kind, name, symbol, quantity, cost_basis, price, currency, notes, created_at, updated_at) VALUES (?, 'crypto', ?, ?, 0, 0, NULL, 'USD', '', ?, ?)").run(id, symbol, symbol, now, now);
      holding = store.db.prepare('SELECT * FROM fin_holdings WHERE id = ?').get(id) as Row;
      created = true;
    }
    let qty = holding.quantity as number;
    let cost = holding.cost_basis as number;
    let costOut = 0;
    let realized: number | null = null;
    if (t.side === 'buy') {
      qty += t.quantity;
      cost += t.quantity * t.price + fee;
    } else {
      if (t.quantity > qty + EPS) throw new Invalid(`You hold ${qty} ${symbol}; that sale is for ${t.quantity}.`);
      const avg = qty > 0 ? cost / qty : 0;
      costOut = t.quantity * avg;
      realized = r2(t.quantity * t.price - fee - costOut);
      qty = Math.max(0, qty - t.quantity);
      cost = qty < EPS ? 0 : cost - costOut;
    }
    store.db.prepare('UPDATE fin_holdings SET quantity = ?, cost_basis = ?, updated_at = ? WHERE id = ?').run(qty, r2(cost), nowIso(), holding.id);
    const id = newId();
    store.db
      .prepare('INSERT INTO fin_trades (id, holding_id, symbol, side, quantity, price, fee, cost_out, realized, date, venue, notes, created_holding, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, holding.id, symbol, t.side, t.quantity, t.price, fee, costOut, realized, t.date, (t.venue ?? '').slice(0, 40), (t.notes ?? '').slice(0, 300), Number(created), nowIso());
    const pnl = realized === null ? '' : ` (${realized >= 0 ? '+' : '−'}${usd(Math.abs(realized))} realized)`;
    store.record('created', 'fin_trade', id, financeSphere(store)?.id ?? null, `${t.side === 'buy' ? 'Bought' : 'Sold'} ${t.quantity} ${symbol} at ${usd(t.price)}${pnl}`);
    if (source !== 'sync') syncSymbols(store);
    return tradeFromRow(store.db.prepare('SELECT * FROM fin_trades WHERE id = ?').get(id) as Row);
  });
}

/** Take a trade back out of its position, then delete it. */
function reverseTrade(db: Store['db'], id: string): boolean {
  const t = db.prepare('SELECT * FROM fin_trades WHERE id = ?').get(id) as Row | undefined;
  if (!t) return false;
  const h = t.holding_id ? (db.prepare('SELECT * FROM fin_holdings WHERE id = ?').get(t.holding_id) as Row | undefined) : undefined;
  if (h) {
    let qty = h.quantity as number;
    let cost = h.cost_basis as number;
    if (t.side === 'buy') {
      if (t.quantity > qty + EPS) throw new Invalid(`Those ${t.symbol} were sold since. Remove the sale first.`);
      qty -= t.quantity;
      cost = qty < EPS ? 0 : Math.max(0, cost - (t.quantity * t.price + t.fee));
    } else {
      qty += t.quantity;
      cost += t.cost_out;
    }
    const others = (db.prepare('SELECT COUNT(*) AS n FROM fin_trades WHERE holding_id = ? AND id != ?').get(h.id, id) as Row).n as number;
    if (t.created_holding && qty < EPS && others === 0) db.prepare('DELETE FROM fin_holdings WHERE id = ?').run(h.id);
    else db.prepare('UPDATE fin_holdings SET quantity = ?, cost_basis = ?, updated_at = ? WHERE id = ?').run(Math.max(0, qty), r2(cost), nowIso(), h.id);
  }
  db.prepare('DELETE FROM fin_trades WHERE id = ?').run(id);
  return true;
}

registerUndo('created:fin_trade', (db, id) => void reverseTrade(db, id));

// ── Debts ───────────────────────────────────────────────────────────────────

export interface DebtInput {
  name: string;
  kind: DebtKind;
  lender?: string;
  balance: number;
  original?: number | null;
  apr?: number | null;
  minPayment?: number | null;
  dueDay?: number | null;
  currency?: string;
  notes?: string;
}

/** Months to clear a balance at a fixed monthly payment, and the interest on the way. */
export function payoff(balance: number, aprPct: number | null, payment: number | null): { months: number; interest: number } | null {
  if (balance <= 0) return { months: 0, interest: 0 };
  if (!payment || payment <= 0) return null;
  const r = (aprPct ?? 0) / 100 / 12;
  if (r === 0) return { months: Math.ceil(balance / payment), interest: 0 };
  if (payment <= balance * r) return null;
  const months = Math.ceil(-Math.log(1 - (r * balance) / payment) / Math.log(1 + r));
  // Walk it to get the interest exactly, final short payment included.
  let b = balance;
  let interest = 0;
  for (let i = 0; i < months && b > 0; i++) {
    const int = b * r;
    interest += int;
    b = b + int - payment;
  }
  return { months, interest: r2(interest) };
}

function nextDueDate(dueDay: number | null, today: string): string | null {
  if (!dueDay) return null;
  const [y, m] = today.split('-').map(Number) as [number, number];
  const make = (yy: number, mm: number) => {
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(dueDay, last)).padStart(2, '0')}`;
  };
  const thisMonth = make(y, m);
  return thisMonth >= today ? thisMonth : m === 12 ? make(y + 1, 1) : make(y, m + 1);
}

function addMonths(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

function debtFromRow(store: Store, r: Row, today: string): Debt {
  const p = payoff(r.balance, r.apr, r.min_payment);
  const payments = (store.db.prepare('SELECT id, date, amount FROM fin_debt_payments WHERE debt_id = ? ORDER BY date DESC, created_at DESC LIMIT 12').all(r.id) as Row[]).map((x) => ({ id: x.id as string, date: x.date as string, amount: x.amount as number }));
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    lender: r.lender,
    balance: r.balance,
    original: r.original,
    apr: r.apr,
    minPayment: r.min_payment,
    dueDay: r.due_day,
    currency: r.currency,
    notes: r.notes,
    closedAt: r.closed_at,
    payoff: p ? { ...p, date: addMonths(today, p.months) } : null,
    paidOffPct: r.original && r.original > 0 ? Math.max(0, Math.min(1, 1 - r.balance / r.original)) : null,
    nextDue: r.closed_at ? null : nextDueDate(r.due_day, today),
    payments,
  };
}

export function addDebt(store: Store, d: DebtInput): Row {
  if (!(d.balance >= 0)) throw new Invalid('A balance of zero or more');
  const id = newId();
  const now = nowIso();
  store.db
    .prepare('INSERT INTO fin_debts (id, name, kind, lender, balance, original, apr, min_payment, due_day, currency, notes, closed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)')
    .run(id, d.name.trim().slice(0, 80) || 'Debt', d.kind, (d.lender ?? '').slice(0, 80), r2(d.balance), d.original ?? d.balance, d.apr ?? null, d.minPayment ?? null, d.dueDay ?? null, (d.currency ?? getSettings(store).currency).toUpperCase(), (d.notes ?? '').slice(0, 500), now, now);
  store.record('created', 'fin_debt', id, financeSphere(store)?.id ?? null, `Tracking a debt: ${d.name}`);
  return store.db.prepare('SELECT * FROM fin_debts WHERE id = ?').get(id) as Row;
}

registerUndo('created:fin_debt', (db, id) => void db.prepare('DELETE FROM fin_debts WHERE id = ?').run(id));

export function updateDebt(store: Store, id: string, patch: Partial<Omit<DebtInput, 'kind' | 'currency'>> & { kind?: DebtKind }): void {
  const r = store.db.prepare('SELECT * FROM fin_debts WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Debt');
  const balance = patch.balance !== undefined ? r2(patch.balance) : r.balance;
  store.db
    .prepare('UPDATE fin_debts SET name = ?, kind = ?, lender = ?, balance = ?, original = ?, apr = ?, min_payment = ?, due_day = ?, notes = ?, closed_at = ?, updated_at = ? WHERE id = ?')
    .run(
      patch.name?.trim().slice(0, 80) || r.name,
      patch.kind ?? r.kind,
      patch.lender !== undefined ? patch.lender.slice(0, 80) : r.lender,
      balance,
      patch.original !== undefined ? patch.original : r.original,
      patch.apr !== undefined ? patch.apr : r.apr,
      patch.minPayment !== undefined ? patch.minPayment : r.min_payment,
      patch.dueDay !== undefined ? patch.dueDay : r.due_day,
      patch.notes !== undefined ? patch.notes.slice(0, 500) : r.notes,
      balance <= 0 ? (r.closed_at ?? nowIso()) : null,
      nowIso(),
      id,
    );
}

export function payDebt(store: Store, id: string, amount: number, date: string): Row {
  const r = store.db.prepare('SELECT * FROM fin_debts WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Debt');
  if (!(amount > 0)) throw new Invalid('A payment above zero');
  const pid = newId();
  return store.tx(() => {
    // Paying more than is owed clears it; only what was owed counts as paid, so undo returns that.
    const applied = r2(Math.min(amount, r.balance));
    const balance = r2(r.balance - applied);
    store.db.prepare('INSERT INTO fin_debt_payments (id, debt_id, date, amount, created_at) VALUES (?,?,?,?,?)').run(pid, id, date, applied, nowIso());
    store.db.prepare('UPDATE fin_debts SET balance = ?, closed_at = ?, updated_at = ? WHERE id = ?').run(balance, balance <= 0 ? nowIso() : null, nowIso(), id);
    store.record('created', 'fin_payment', pid, financeSphere(store)?.id ?? null, balance <= 0 ? `Paid off ${r.name}` : `Paid ${money(applied, r.currency)} towards ${r.name} — ${money(balance, r.currency)} left`);
    return store.db.prepare('SELECT * FROM fin_debts WHERE id = ?').get(id) as Row;
  });
}

/** Take a payment back: its amount returns to the balance. */
function reversePayment(db: Store['db'], pid: string): boolean {
  const p = db.prepare('SELECT * FROM fin_debt_payments WHERE id = ?').get(pid) as Row | undefined;
  if (!p) return false;
  db.prepare('UPDATE fin_debts SET balance = balance + ?, closed_at = NULL, updated_at = ? WHERE id = ?').run(p.amount, nowIso(), p.debt_id);
  db.prepare('DELETE FROM fin_debt_payments WHERE id = ?').run(pid);
  return true;
}

registerUndo('created:fin_payment', (db, id) => void reversePayment(db, id));

// ── Price alerts ────────────────────────────────────────────────────────────

const alertFromRow = (r: Row): PriceAlert => ({ id: r.id, symbol: r.symbol, direction: r.direction, price: r.price, note: r.note, triggeredAt: r.triggered_at });

export function addAlert(store: Store, input: { symbol: string; price: number; direction?: 'above' | 'below'; note?: string }): PriceAlert {
  const symbol = normSymbol(input.symbol);
  if (!symbolOk(symbol) || STABLE.has(symbol)) throw new Invalid('Alerts are for coins with a moving price, like BTC');
  if (!(input.price > 0)) throw new Invalid('A price above zero');
  const now = marketFor(store).quote(symbol)?.price;
  const direction = input.direction ?? (now !== undefined && input.price < now ? 'below' : 'above');
  const id = newId();
  store.db.prepare('INSERT INTO fin_alerts (id, symbol, direction, price, note, triggered_at, created_at) VALUES (?,?,?,?,?,NULL,?)').run(id, symbol, direction, input.price, (input.note ?? '').slice(0, 200), nowIso());
  syncSymbols(store);
  return alertFromRow(store.db.prepare('SELECT * FROM fin_alerts WHERE id = ?').get(id) as Row);
}

/** Fire every alert a price has crossed: each becomes a signal once, then rests. */
export function checkAlerts(store: Store, quotes: Quote[]): number {
  if (!quotes.length) return 0;
  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
  const open = store.db.prepare('SELECT * FROM fin_alerts WHERE triggered_at IS NULL').all() as Row[];
  let fired = 0;
  for (const a of open) {
    const q = bySymbol.get(a.symbol);
    if (!q || q.price <= 0) continue;
    const crossed = a.direction === 'above' ? q.price >= a.price : q.price <= a.price;
    if (!crossed) continue;
    store.db.prepare('UPDATE fin_alerts SET triggered_at = ? WHERE id = ? AND triggered_at IS NULL').run(nowIso(), a.id);
    addSignal(store, {
      source: 'markets',
      kind: 'price',
      externalId: `alert:${a.id}`,
      title: `${a.symbol} is ${a.direction} ${usd(a.price)} — now ${usd(q.price)}`,
      body: `${a.note ? `${a.note}\n\n` : ''}${a.symbol} ${q.changePct >= 0 ? 'up' : 'down'} ${Math.abs(q.changePct).toFixed(1)}% in 24 hours (high ${usd(q.high)}, low ${usd(q.low)}), from ${q.source === 'binance' ? 'Binance' : 'Coinbase'}.`,
      sphereId: financeSphere(store)?.id ?? null,
      priority: 2,
      url: q.source === 'binance' ? `https://www.binance.com/en/trade/${a.symbol}_USDT` : `https://www.coinbase.com/advanced-trade/spot/${a.symbol}-USD`,
      actions: [{ type: 'link', label: 'Open the chart', url: q.source === 'binance' ? `https://www.binance.com/en/trade/${a.symbol}_USDT` : `https://www.coinbase.com/advanced-trade/spot/${a.symbol}-USD` }],
      data: { symbol: a.symbol, price: q.price, target: a.price, direction: a.direction },
    });
    fired++;
  }
  if (fired) syncSymbols(store);
  return fired;
}

// ── The whole picture ───────────────────────────────────────────────────────

const monthKey = (date: string) => date.slice(0, 7);

function lastMonths(today: string, n: number): string[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

export function financeState(store: Store, today: string): FinanceState {
  const settings = getSettings(store);
  const base = settings.currency;
  const fx = storedFx(store);
  const feed = marketFor(store);
  const toBase = (amount: number, currency: string) => convert(amount, currency, base, fx);

  // Cash flow.
  const months = lastMonths(today, 6);
  const txRows = store.db.prepare('SELECT * FROM fin_transactions WHERE date >= ? ORDER BY date DESC, created_at DESC').all(`${months[0]}-01`) as Row[];
  const series = new Map(months.map((k) => [k, { key: k, income: 0, expense: 0 }]));
  const cats = new Map<string, { category: string; kind: TxKind; amount: number }>();
  const thisMonth = monthKey(today);
  for (const r of txRows) {
    const v = toBase(r.amount, r.currency);
    if (v === null) continue;
    const m = series.get(monthKey(r.date));
    if (m) m[r.kind as TxKind] += v;
    if (monthKey(r.date) === thisMonth && r.date <= today) {
      const key = `${r.kind}|${r.category}`;
      const c = cats.get(key) ?? { category: r.category, kind: r.kind, amount: 0 };
      c.amount += v;
      cats.set(key, c);
    }
  }
  for (const cat of Object.keys(settings.budgets)) if (!cats.has(`expense|${cat}`)) cats.set(`expense|${cat}`, { category: cat, kind: 'expense', amount: 0 });
  const cur = series.get(thisMonth)!;
  const recent = (store.db.prepare('SELECT * FROM fin_transactions ORDER BY date DESC, created_at DESC LIMIT 60').all() as Row[]).map(txFromRow);

  // Portfolio.
  const holdings = (store.db.prepare('SELECT * FROM fin_holdings ORDER BY kind, name').all() as Row[]).map((r) => valueHolding(r, isLive(r.kind, r.symbol, r.price) ? feed.quote(r.symbol) : null, fx, base));
  holdings.sort((a, b) => (b.valueBase ?? -1) - (a.valueBase ?? -1));
  const alloc = new Map<HoldingKind, number>();
  for (const h of holdings) if (h.valueBase !== null && h.valueBase > 0) alloc.set(h.kind, (alloc.get(h.kind) ?? 0) + h.valueBase);

  // The crypto desk, in dollars.
  const coins = holdings.filter((h) => h.live && h.quantity > EPS);
  const trades = (store.db.prepare('SELECT * FROM fin_trades ORDER BY date DESC, created_at DESC LIMIT 50').all() as Row[]).map(tradeFromRow);
  const realized = (store.db.prepare('SELECT COALESCE(SUM(realized), 0) AS n FROM fin_trades').get() as Row).n as number;
  const crypto = coins.length || trades.length
    ? {
        value: r2(coins.reduce((n, h) => n + (h.value ?? 0), 0)),
        cost: r2(coins.reduce((n, h) => n + h.costBasis, 0)),
        gain: r2(coins.reduce((n, h) => n + (h.gain ?? 0), 0)),
        realized: r2(realized),
        change24h: r2(coins.reduce((n, h) => {
          const q = feed.quote(h.symbol);
          return n + (q ? h.quantity * (q.price - q.open) : 0);
        }, 0)),
      }
    : null;

  // Debts, open first, the costliest rate first.
  const debts = (store.db.prepare('SELECT * FROM fin_debts ORDER BY closed_at IS NOT NULL, COALESCE(apr, 0) DESC, balance DESC').all() as Row[]).map((r) => debtFromRow(store, r, today));
  const owed = debts.filter((d) => !d.closedAt).reduce((n, d) => n + (toBase(d.balance, d.currency) ?? 0), 0);
  const assets = holdings.reduce((n, h) => n + (h.valueBase ?? 0), 0);

  return {
    date: today,
    currency: base,
    fx,
    month: {
      key: thisMonth,
      income: r2(cur.income),
      expense: r2(cur.expense),
      net: r2(cur.income - cur.expense),
      savingsRate: cur.income > 0 ? (cur.income - cur.expense) / cur.income : null,
      byCategory: [...cats.values()].map((c) => ({ ...c, amount: r2(c.amount), budget: c.kind === 'expense' ? (settings.budgets[c.category] ?? null) : null })).sort((a, b) => b.amount - a.amount),
    },
    months: [...series.values()].map((m) => ({ key: m.key, income: r2(m.income), expense: r2(m.expense) })),
    transactions: recent,
    budgets: settings.budgets,
    holdings,
    allocation: [...alloc].map(([kind, value]) => ({ kind, value: r2(value) })).sort((a, b) => b.value - a.value),
    trades,
    crypto,
    debts,
    alerts: (store.db.prepare('SELECT * FROM fin_alerts ORDER BY triggered_at IS NOT NULL, created_at DESC LIMIT 30').all() as Row[]).map(alertFromRow),
    watchlist: settings.watchlist,
    netWorth: { assets: r2(assets), debts: r2(owed), net: r2(assets - owed), unpriced: holdings.filter((h) => h.valueBase === null && h.quantity > EPS).map((h) => h.name) },
    market: feed.state(),
  };
}

/** Once a day, the Net worth number (when the sphere tracks one) follows the portfolio. */
function syncNetWorth(store: Store, today: string): void {
  const done = store.db.prepare("SELECT value FROM settings WHERE key = 'finance_networth_day'").get() as { value: string } | undefined;
  if (done?.value === today) return;
  const sphere = financeSphere(store);
  const metric = sphere && store.listMetrics(sphere.id).find((m) => /^net ?worth$/i.test(m.name));
  if (!metric) return;
  const f = financeState(store, today);
  if (!f.holdings.length && !f.debts.length) return;
  if (f.netWorth.unpriced.length) return;
  store.addMetricEntry(metric.id, { value: Math.round(f.netWorth.net), date: today, note: 'from finances' });
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('finance_networth_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(today);
}

// ── Agent ───────────────────────────────────────────────────────────────────

registerSnapshotSection<Store>('Money', (store, today) => {
  const f = financeState(store, today);
  if (!f.transactions.length && !f.holdings.length && !f.debts.length) return null;
  const c = f.currency;
  const lines = [`Base currency ${c}. This month: income ${money(f.month.income, c)}, spending ${money(f.month.expense, c)}${f.month.savingsRate !== null ? `, saving ${Math.round(f.month.savingsRate * 100)}%` : ''}.`];
  const over = f.month.byCategory.filter((x) => x.budget && x.amount > x.budget);
  if (over.length) lines.push(`Over budget: ${over.map((x) => `${x.category} ${money(x.amount, c)} of ${money(x.budget!, c)}`).join('; ')}.`);
  if (f.holdings.length || f.debts.length) lines.push(`Net worth ${money(f.netWorth.net, c)} (assets ${money(f.netWorth.assets, c)}, debts ${money(f.netWorth.debts, c)})${f.netWorth.unpriced.length ? `; unpriced: ${f.netWorth.unpriced.join(', ')}` : ''}.`);
  if (f.crypto) lines.push(`Crypto: ${usd(f.crypto.value)}, unrealized ${f.crypto.gain >= 0 ? '+' : '−'}${usd(Math.abs(f.crypto.gain))}, realized ${f.crypto.realized >= 0 ? '+' : '−'}${usd(Math.abs(f.crypto.realized))}. Positions: ${f.holdings.filter((h) => h.live && h.quantity > EPS).map((h) => `${h.quantity} ${h.symbol}${h.unitPrice ? ` @ ${usd(h.unitPrice)}` : ''}`).join(', ') || 'none'}.`);
  const open = f.debts.filter((d) => !d.closedAt);
  if (open.length) lines.push(`Debts: ${open.map((d) => `${d.name} ${money(d.balance, d.currency)}${d.apr ? ` at ${d.apr}%` : ''}`).join('; ')}.`);
  return lines.join('\n');
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const currency = z.string().regex(/^[A-Za-z]{3}$/, 'A three-letter currency code, like SGD');
const symbol = z.string().min(2).max(16);
const txInput = z.object({
  kind: z.enum(['income', 'expense']),
  amount: z.number().positive().max(1e10),
  category: z.string().min(1).max(40),
  description: z.string().max(200).optional(),
  date: dateStr.optional(),
  currency: currency.optional(),
});
const holdingKind = z.enum(['cash', 'crypto', 'stock', 'fund', 'retirement', 'property', 'other']);
const holdingInput = z.object({
  kind: holdingKind,
  name: z.string().max(80).default(''),
  symbol: z.string().max(16).optional(),
  quantity: z.number().min(0).max(1e12),
  cost_basis: z.number().min(0).max(1e12).optional(),
  price: z.number().min(0).max(1e12).nullable().optional(),
  currency: currency.optional(),
  notes: z.string().max(500).optional(),
});
const holdingPatch = z.object({ name: z.string().max(80).optional(), quantity: z.number().min(0).max(1e12).optional(), cost_basis: z.number().min(0).max(1e12).optional(), price: z.number().min(0).max(1e12).nullable().optional(), notes: z.string().max(500).optional() });
const tradeInput = z.object({
  symbol,
  side: z.enum(['buy', 'sell']),
  quantity: z.number().positive().max(1e12),
  price: z.number().positive().max(1e9),
  fee: z.number().min(0).max(1e9).optional(),
  date: dateStr.optional(),
  venue: z.string().max(40).optional(),
  notes: z.string().max(300).optional(),
});
const debtKind = z.enum(['credit_card', 'loan', 'mortgage', 'car', 'student', 'personal', 'bnpl', 'other']);
const debtInput = z.object({
  name: z.string().min(1).max(80),
  kind: debtKind,
  lender: z.string().max(80).optional(),
  balance: z.number().min(0).max(1e10),
  original: z.number().min(0).max(1e10).nullable().optional(),
  apr: z.number().min(0).max(100).nullable().optional(),
  min_payment: z.number().min(0).max(1e9).nullable().optional(),
  due_day: z.number().int().min(1).max(31).nullable().optional(),
  currency: currency.optional(),
  notes: z.string().max(500).optional(),
});
const debtPatch = debtInput.partial().omit({ currency: true });
const alertInput = z.object({ symbol, price: z.number().positive().max(1e9), direction: z.enum(['above', 'below']).optional(), note: z.string().max(200).optional() });

const toHolding = (h: z.infer<typeof holdingInput>): HoldingInput => ({ kind: h.kind, name: h.name, symbol: h.symbol, quantity: h.quantity, costBasis: h.cost_basis, price: h.price, currency: h.currency, notes: h.notes });
const toDebt = (d: z.infer<typeof debtPatch>) => ({ name: d.name, kind: d.kind, lender: d.lender, balance: d.balance, original: d.original, apr: d.apr, minPayment: d.min_payment, dueDay: d.due_day, notes: d.notes });

function findDebt(store: Store, nameOrId: string): Row {
  const r = (store.db.prepare('SELECT * FROM fin_debts WHERE id = ?').get(nameOrId) ?? store.db.prepare('SELECT * FROM fin_debts WHERE closed_at IS NULL AND lower(name) LIKE ? ORDER BY balance DESC LIMIT 1').get(`%${nameOrId.toLowerCase()}%`)) as Row | undefined;
  if (!r) throw new NotFound('Debt');
  return r;
}

/** Every followed coin's quote, fetched now when the ones we have are stale. */
async function quotesNow(store: Store, extra: string[] = []): Promise<Quote[]> {
  const feed = marketFor(store);
  if (extra.length) feed.setSymbols([...followedSymbols(store), ...extra]);
  await feed.fresh(20_000);
  const out = feed.state().quotes;
  checkAlerts(store, out);
  return out;
}

const MARKETS = 'markets';

registerFeature({
  id: MARKETS,
  jobs: [
    {
      id: MARKETS,
      everyMs: 60_000,
      run: async (store) => {
        syncSymbols(store);
        await refreshFx(store).catch(() => undefined);
        const feed = marketFor(store);
        const alerts = (store.db.prepare('SELECT COUNT(*) AS n FROM fin_alerts WHERE triggered_at IS NULL').get() as Row).n as number;
        // Poll every minute while alerts wait or someone watches; otherwise every ten.
        if (feed.following().length && (alerts > 0 || feed.hasViewers() || feed.ageMs() > 10 * 60_000)) {
          await feed.refresh();
          checkAlerts(store, feed.state().quotes);
        }
        const zone = store.zone();
        const today = zone ? new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date()) : new Date().toISOString().slice(0, 10);
        syncNetWorth(store, today);
      },
    },
  ],
});

const watched = new WeakSet<object>();

registerFeature({
  id: 'finance',
  tables: ['fin_transactions', 'fin_holdings', 'fin_trades', 'fin_debts', 'fin_debt_payments', 'fin_alerts'],
  tools: [
    tool(
      'log_transaction',
      `Record money coming in (income) or going out (expense), in the user's base currency unless they name another. Categories for spending: ${EXPENSE_CATEGORIES.join(', ')}; for income: ${INCOME_CATEGORIES.join(', ')} (others are fine). Date defaults to today. Log several at once when they list several.`,
      z.object({ items: z.array(txInput).min(1).max(30) }),
      ({ items }, { store, today }) => {
        const saved = store.tx(() => items.map((t) => addTransaction(store, { ...t, date: t.date ?? today }, 'seldon')));
        const f = financeState(store, today);
        return { data: { ok: true, logged: saved.length, month: { income: f.month.income, expense: f.month.expense, currency: f.currency } }, summary: saved.length === 1 ? `Logged ${saved[0]!.kind === 'income' ? 'income' : 'spending'}: ${money(saved[0]!.amount, saved[0]!.currency)} ${saved[0]!.category}` : `Logged ${saved.length} transactions` };
      },
    ),
    tool(
      'get_finances',
      "Read the user's finances: this month's income and spending by category against budgets, the last six months, recent transactions, the portfolio (crypto priced live), crypto P&L and recent trades, debts with payoff projections, price alerts, and net worth. Call this before advising on money.",
      z.object({}),
      async (_input, { store, today }) => {
        await quotesNow(store).catch(() => undefined);
        const f = financeState(store, today);
        return { data: { ...f, transactions: f.transactions.slice(0, 25), trades: f.trades.slice(0, 15), market: { ...f.market, sparks: undefined } }, summary: 'Read your finances' };
      },
    ),
    tool(
      'set_budget',
      'Set (or clear with null) monthly spending budgets by category, in the base currency. Only when the user agrees on the numbers.',
      z.object({ budgets: z.record(z.string().min(1).max(40), z.number().min(0).max(1e9).nullable()) }),
      ({ budgets }, { store }) => {
        updateSettings(store, { budgets });
        return { data: { ok: true, budgets: getSettings(store).budgets }, summary: `Updated budgets: ${Object.keys(budgets).join(', ')}` };
      },
    ),
    tool(
      'add_holding',
      "Add something the user owns to the portfolio: a bank or cash balance (kind cash, quantity = the balance), a coin (kind crypto, symbol like BTC, priced live in USD; cost_basis is the total paid in USD), a stock or fund (symbol, quantity, price per unit), retirement (e.g. CPF), property or other (quantity 1, price = its value). For a coin they're actively trading, prefer log_crypto_trade so cost and P&L stay right.",
      holdingInput,
      (h, { store }) => {
        const row = addHolding(store, toHolding(h));
        return { data: { ok: true, id: row.id }, summary: `Added ${row.name} to the portfolio` };
      },
    ),
    tool(
      'update_holding',
      'Update a holding: a new balance for an account (quantity), a new value or unit price, quantity or cost basis. Find ids with get_finances.',
      holdingPatch.extend({ id: z.string() }),
      ({ id, ...p }, { store }) => {
        updateHolding(store, id, { name: p.name, quantity: p.quantity, costBasis: p.cost_basis, price: p.price, notes: p.notes });
        return { data: { ok: true }, summary: 'Updated a holding' };
      },
    ),
    tool(
      'log_crypto_trade',
      'Log a crypto buy or sale: coin ticker, quantity, price per coin in USD, fee in USD. The position and average cost update with it, and a sale records its realized profit or loss. Date defaults to today.',
      tradeInput,
      (t, { store, today }) => {
        const saved = logTrade(store, { ...t, date: t.date ?? today }, 'seldon');
        return { data: { ok: true, trade: saved }, summary: `${saved.side === 'buy' ? 'Bought' : 'Sold'} ${saved.quantity} ${saved.symbol} at ${usd(saved.price)}` };
      },
    ),
    tool(
      'get_crypto_prices',
      'Live crypto prices in USD with 24h change, high, low and volume, from Binance (Coinbase as a fallback). Give tickers to look up coins beyond the ones the user follows.',
      z.object({ symbols: z.array(symbol).max(20).optional() }),
      async ({ symbols }, { store }) => {
        const extra = (symbols ?? []).map(normSymbol).filter(symbolOk);
        const quotes = await quotesNow(store, extra);
        const st = marketFor(store).state();
        const want = extra.length ? quotes.filter((q) => extra.includes(q.symbol)) : quotes;
        return { data: { quotes: want.map(({ symbol: s, price, changePct, high, low, volume, source }) => ({ symbol: s, price, change_24h_pct: Math.round(changePct * 100) / 100, high, low, volume_usd: Math.round(volume), source })), unknown: st.unknown, status: st.status, error: st.error }, summary: `Checked prices: ${want.map((q) => `${q.symbol} ${usd(q.price)}`).join(', ') || 'none found'}` };
      },
    ),
    tool(
      'watch_crypto',
      "Add a coin to the user's watchlist so its live price shows on the Finances page.",
      z.object({ symbol }),
      ({ symbol: s }, { store }) => ({ data: { ok: true, symbol: addToWatchlist(store, s) }, summary: `Watching ${normSymbol(s)}` }),
    ),
    tool(
      'set_price_alert',
      'Alert the user when a coin crosses a price (USD). Direction is worked out from the current price when not given. The alert arrives as a signal under Needs you, once.',
      alertInput,
      (a, { store }) => {
        const saved = addAlert(store, a);
        return { data: { ok: true, alert: saved }, summary: `Alert: ${saved.symbol} ${saved.direction} ${usd(saved.price)}` };
      },
    ),
    tool(
      'add_debt',
      'Track a debt: credit card, loan, mortgage, car, student, personal, buy-now-pay-later. Balance in the base currency unless they name another; APR as a percentage; minimum monthly payment; due day of the month.',
      debtInput,
      (d, { store }) => {
        const row = addDebt(store, { ...toDebt(d), name: d.name, kind: d.kind, balance: d.balance, currency: d.currency });
        return { data: { ok: true, id: row.id }, summary: `Tracking ${row.name}` };
      },
    ),
    tool(
      'log_debt_payment',
      'Record a payment towards a debt (by id or by name). The balance goes down by the amount.',
      z.object({ debt: z.string().min(1), amount: z.number().positive().max(1e10), date: dateStr.optional() }),
      ({ debt, amount, date }, { store, today }) => {
        const r = payDebt(store, findDebt(store, debt).id, amount, date ?? today);
        return { data: { ok: true, balance: r.balance, paid_off: r.balance <= 0 }, summary: r.balance <= 0 ? `Paid off ${r.name}` : `Paid ${money(amount, r.currency)} towards ${r.name}` };
      },
    ),
  ],
  routes: (app, { store }) => {
    // The price job only runs while its integration is on; it is on from the start.
    if (!store.db.prepare('SELECT 1 AS x FROM integrations WHERE id = ?').get(MARKETS)) saveIntegration(store, { ...getIntegration(store, MARKETS), enabled: true });
    syncSymbols(store);
    const feed = marketFor(store);
    if (!watched.has(feed)) {
      watched.add(feed);
      // Alerts fire on live ticks too, not only on the minute.
      feed.subscribe((q) => {
        try {
          checkAlerts(store, q);
        } catch {
          // The database may be closing.
        }
      });
    }
    const state = (c: Parameters<typeof todayOf>[0]) => financeState(store, todayOf(c));

    app.get('/api/finance', (c) => {
      // Stale prices refresh in the background; the stream brings them in.
      if (feed.ageMs() > 60_000) void feed.refresh().catch(() => undefined);
      return c.json(state(c));
    });
    app.post('/api/finance/refresh', async (c) => {
      await Promise.all([feed.refresh().catch(() => undefined), refreshFx(store, true).catch(() => undefined)]);
      checkAlerts(store, feed.state().quotes);
      return c.json(state(c));
    });
    app.put('/api/finance/settings', async (c) => {
      const s = await read(c, z.object({ currency: currency.optional(), budgets: z.record(z.string().min(1).max(40), z.number().min(0).max(1e9).nullable()).optional() }));
      updateSettings(store, s);
      if (s.currency) await refreshFx(store).catch(() => undefined);
      return c.json(state(c));
    });

    app.post('/api/finance/transactions', async (c) => {
      const t = await read(c, txInput);
      addTransaction(store, { ...t, date: t.date ?? todayOf(c) });
      return c.json(state(c), 201);
    });
    app.delete('/api/finance/transactions/:id', (c) => {
      if (store.db.prepare('DELETE FROM fin_transactions WHERE id = ?').run(c.req.param('id')).changes === 0) throw new NotFound('Transaction');
      return c.json(state(c));
    });

    app.post('/api/finance/holdings', async (c) => {
      addHolding(store, toHolding(await read(c, holdingInput)));
      return c.json(state(c), 201);
    });
    app.patch('/api/finance/holdings/:id', async (c) => {
      const p = await read(c, holdingPatch);
      updateHolding(store, c.req.param('id'), { name: p.name, quantity: p.quantity, costBasis: p.cost_basis, price: p.price, notes: p.notes });
      return c.json(state(c));
    });
    app.delete('/api/finance/holdings/:id', (c) => {
      deleteHolding(store, c.req.param('id'));
      return c.json(state(c));
    });

    app.post('/api/finance/trades', async (c) => {
      const t = await read(c, tradeInput);
      logTrade(store, { ...t, date: t.date ?? todayOf(c) });
      return c.json(state(c), 201);
    });
    app.delete('/api/finance/trades/:id', (c) => {
      if (!store.tx(() => reverseTrade(store.db, c.req.param('id')))) throw new NotFound('Trade');
      syncSymbols(store);
      return c.json(state(c));
    });

    app.post('/api/finance/debts', async (c) => {
      const d = await read(c, debtInput);
      addDebt(store, { ...toDebt(d), name: d.name, kind: d.kind, balance: d.balance, currency: d.currency });
      return c.json(state(c), 201);
    });
    app.patch('/api/finance/debts/:id', async (c) => {
      updateDebt(store, c.req.param('id'), toDebt(await read(c, debtPatch)));
      return c.json(state(c));
    });
    app.delete('/api/finance/debts/:id', (c) => {
      if (store.db.prepare('DELETE FROM fin_debts WHERE id = ?').run(c.req.param('id')).changes === 0) throw new NotFound('Debt');
      return c.json(state(c));
    });
    app.post('/api/finance/debts/:id/payments', async (c) => {
      const p = await read(c, z.object({ amount: z.number().positive().max(1e10), date: dateStr.optional() }));
      payDebt(store, c.req.param('id'), p.amount, p.date ?? todayOf(c));
      return c.json(state(c), 201);
    });
    app.delete('/api/finance/payments/:id', (c) => {
      if (!store.tx(() => reversePayment(store.db, c.req.param('id')))) throw new NotFound('Payment');
      return c.json(state(c));
    });

    app.post('/api/finance/watchlist', async (c) => {
      addToWatchlist(store, (await read(c, z.object({ symbol }))).symbol);
      void feed.refresh().catch(() => undefined);
      return c.json(state(c), 201);
    });
    app.delete('/api/finance/watchlist/:symbol', (c) => {
      removeFromWatchlist(store, c.req.param('symbol'));
      return c.json(state(c));
    });

    app.post('/api/finance/alerts', async (c) => {
      addAlert(store, await read(c, alertInput));
      return c.json(state(c), 201);
    });
    app.delete('/api/finance/alerts/:id', (c) => {
      if (store.db.prepare('DELETE FROM fin_alerts WHERE id = ?').run(c.req.param('id')).changes === 0) throw new NotFound('Alert');
      syncSymbols(store);
      return c.json(state(c));
    });

    // Live prices: the market as it stands, then every change, at most once a second.
    app.get('/api/finance/stream', (c) =>
      streamSSE(c, async (stream) => {
        let queue: Promise<unknown> = Promise.resolve();
        const send = () => {
          queue = queue.then(() => stream.writeSSE({ event: 'market', data: JSON.stringify(feed.state()) })).catch(() => undefined);
        };
        const stop = feed.watch(send);
        send();
        void feed.fresh(15_000).then(send);
        const ping = setInterval(() => {
          queue = queue.then(() => stream.writeSSE({ event: 'ping', data: '' })).catch(() => undefined);
        }, 25_000);
        await new Promise<void>((resolve) => stream.onAbort(resolve));
        clearInterval(ping);
        stop();
      }),
    );

  },
});
