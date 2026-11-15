// Finances: money in and out (with monthly budgets), what you own, what you owe, and a
// crypto desk — live prices, a trade log that keeps positions and average cost, and price
// alerts that arrive as signals. Net worth falls out of the three, in your own currency.

import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { registerSnapshotSection } from '../agent/snapshot-hooks.ts';
import { tool } from '../agent/tools.ts';
import { read, today as todayOf } from '../http.ts';
import { Invalid, localDate, newId, NotFound, nowIso, prettyDay, registerUndo, type Store } from '../store.ts';
import type { Debt, DebtKind, FinanceState, Frequency, Holding, PlanBucket, PlanRules, SalaryPlan, HoldingKind, PriceAlert, Quote, Recurring, Trade, Transaction, TxKind, Upcoming } from '../../../shared/types.ts';
import { getIntegration, saveIntegration } from './integrations.ts';
import { convert, getJson, marketFor, normSymbol, refreshFx, STABLE, storedFx, symbolOk, type FxRates } from './markets.ts';
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
  plan?: Partial<PlanRules>;
}

export const PLAN_DEFAULTS: PlanRules = { emergencyMonths: 6, cryptoCapPct: 10, funPct: 5 };

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
  return { currency: saved.currency ?? guess, budgets: saved.budgets ?? {}, watchlist: saved.watchlist ?? ['BTC', 'ETH', 'SOL'], plan: saved.plan };
}

function saveSettings(store: Store, next: FinanceSettings): void {
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('finance', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
}

function updateSettings(store: Store, patch: { currency?: string; budgets?: Record<string, number | null>; plan?: Partial<PlanRules> }): void {
  const s = getSettings(store);
  if (patch.currency) s.currency = patch.currency.toUpperCase();
  if (patch.plan) s.plan = { ...s.plan, ...Object.fromEntries(Object.entries(patch.plan).filter(([, v]) => v !== undefined)) };
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

const txFromRow = (r: Row): Transaction => ({ id: r.id, date: r.date, kind: r.kind, amount: r.amount, currency: r.currency, category: r.category, description: r.description, source: r.source, recurringId: r.recurring_id ?? null });

export interface TxInput {
  kind: TxKind;
  amount: number;
  category: string;
  description?: string;
  date: string;
  currency?: string;
}

/** Which recurring item (and which of its occurrences) a transaction came from. */
interface TxLink {
  id: string;
  n: number;
  /** Marked paid by hand: undo puts the occurrence back as unpaid. */
  paid: boolean;
}

export function addTransaction(store: Store, t: TxInput, source = 'manual', link: TxLink | null = null): Transaction {
  if (!(t.amount > 0)) throw new Invalid('An amount above zero');
  const id = newId();
  const currency = (t.currency ?? getSettings(store).currency).toUpperCase();
  const category = cleanCategory(t.category);
  const description = (t.description ?? '').trim().slice(0, 200);
  store.db
    .prepare('INSERT INTO fin_transactions (id, date, kind, amount, currency, category, description, source, recurring_id, recurring_n, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, t.date, t.kind, r2(t.amount), currency, category, description, source, link?.id ?? null, link?.n ?? null, nowIso());
  const what = description ? ` — ${description}` : '';
  store.record('created', link?.paid ? 'fin_rtx' : 'fin_tx', id, financeSphere(store)?.id ?? null, t.kind === 'income' ? `Income: ${money(t.amount, currency)} ${category}${what}` : `Spent ${money(t.amount, currency)} on ${category}${what}`);
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
  // Money that was paid into it has nowhere to go now.
  store.db.prepare('UPDATE fin_recurring SET active = 0 WHERE holding_id = ?').run(id);
  syncSymbols(store);
}

/** Holdings that money can be paid into: a cash balance, or one held at a value you set (CPF, property). */
const PAYABLE: ReadonlySet<string> = new Set(['cash', 'retirement', 'property', 'other']);

/**
 * Pay into a holding: a cash balance grows by the amount, a valued one is worth that much more.
 * Cost basis is left alone, since a payment might be a contribution or interest. False when the
 * holding is gone.
 */
function payIntoHolding(store: Store, id: string, amount: number, label: string): boolean {
  const h = store.db.prepare('SELECT * FROM fin_holdings WHERE id = ?').get(id) as Row | undefined;
  if (!h || !PAYABLE.has(h.kind)) return false;
  if (h.kind === 'cash') store.db.prepare('UPDATE fin_holdings SET quantity = quantity + ?, updated_at = ? WHERE id = ?').run(amount, nowIso(), id);
  else if (!(h.quantity > 0)) store.db.prepare('UPDATE fin_holdings SET quantity = 1, price = ?, updated_at = ? WHERE id = ?').run(r2(amount), nowIso(), id);
  else store.db.prepare('UPDATE fin_holdings SET price = ?, updated_at = ? WHERE id = ?').run((h.price ?? 0) + amount / h.quantity, nowIso(), id);
  store.record('updated', 'fin_holding', id, financeSphere(store)?.id ?? null, `${label}: ${money(amount, h.currency)} into ${h.name}`);
  return true;
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
  return store.tx(() => applyPayment(store, id, amount, date));
}

/** payDebt without its own transaction, for callers already inside one. */
function applyPayment(store: Store, id: string, amount: number, date: string): Row {
  const r = store.db.prepare('SELECT * FROM fin_debts WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Debt');
  if (!(amount > 0)) throw new Invalid('A payment above zero');
  const pid = newId();
  {
    // Paying more than is owed clears it; only what was owed counts as paid, so undo returns that.
    const applied = r2(Math.min(amount, r.balance));
    const balance = r2(r.balance - applied);
    store.db.prepare('INSERT INTO fin_debt_payments (id, debt_id, date, amount, created_at) VALUES (?,?,?,?,?)').run(pid, id, date, applied, nowIso());
    store.db.prepare('UPDATE fin_debts SET balance = ?, closed_at = ?, updated_at = ? WHERE id = ?').run(balance, balance <= 0 ? nowIso() : null, nowIso(), id);
    store.record('created', 'fin_payment', pid, financeSphere(store)?.id ?? null, balance <= 0 ? `Paid off ${r.name}` : `Paid ${money(applied, r.currency)} towards ${r.name} — ${money(balance, r.currency)} left`);
    return store.db.prepare('SELECT * FROM fin_debts WHERE id = ?').get(id) as Row;
  }
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

// ── Recurring: pay, bills, instalments ──────────────────────────────────────

const CADENCE_MONTHS: Partial<Record<Frequency, number>> = { monthly: 1, quarterly: 3, yearly: 12 };
const PER_MONTH: Record<Frequency, number> = { weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
/** At most this many missed occurrences are caught up in one go (a server off for months). */
const MAX_CATCH_UP = 24;
/** Bills you pay by hand are flagged this many days ahead. */
const REMIND_DAYS = 3;

const pad2 = (n: number) => String(n).padStart(2, '0');

function plusDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The nth occurrence, before any weekend move. Month-based cadences keep their day (31 → the month's last). */
export function nthDate(anchor: string, cadence: Frequency, day: number | null, n: number): string {
  const months = CADENCE_MONTHS[cadence];
  if (!months) return plusDays(anchor, n * (cadence === 'weekly' ? 7 : 14));
  const [y, m, d] = anchor.split('-').map(Number) as [number, number, number];
  const total = m - 1 + n * months;
  const yy = y + Math.floor(total / 12);
  const mm = (total % 12) + 1;
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return `${yy}-${pad2(mm)}-${pad2(Math.min(day ?? d, last))}`;
}

/** Move a date off a weekend or public holiday to the working day before or after. */
export function toWorkingDay(date: string, rule: Recurring['weekend'], holidays: ReadonlySet<string>): string {
  if (rule === 'none') return date;
  let d = date;
  // Two weeks is far more than any run of days off; it only guards against a bad holiday list.
  for (let i = 0; i < 14; i++) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(d)) return d;
    d = plusDays(d, rule === 'before' ? -1 : 1);
  }
  return date;
}

/** The date of occurrence n; null once past the end date. */
function occurrence(r: Row, n: number, hol: ReadonlySet<string>): string | null {
  const raw = nthDate(r.anchor, r.cadence, r.day, n);
  if (r.end_date && raw > r.end_date) return null;
  return toWorkingDay(raw, r.weekend, hol);
}

// ── Public holidays ──

/** Where the person is, for public holidays: from their time zone. */
const ZONE_COUNTRY: [RegExp, string][] = [
  [/^Asia\/Singapore$/, 'SG'],
  [/^Asia\/(Kuala_Lumpur|Kuching)$/, 'MY'],
  [/^Asia\/(Jakarta|Makassar|Jayapura|Pontianak)$/, 'ID'],
  [/^Asia\/Tokyo$/, 'JP'],
  [/^Asia\/Hong_Kong$/, 'HK'],
  [/^Europe\/London$/, 'GB'],
  [/^Europe\/Dublin$/, 'IE'],
  [/^Europe\/Berlin$/, 'DE'],
  [/^Europe\/Paris$/, 'FR'],
  [/^Europe\/Amsterdam$/, 'NL'],
  [/^Australia\//, 'AU'],
  [/^Pacific\/Auckland$/, 'NZ'],
  [/^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage)$/, 'US'],
  [/^America\/Toronto$/, 'CA'],
];

export const countryOf = (zone: string | null): string | null => ZONE_COUNTRY.find(([re]) => re.test(zone ?? ''))?.[1] ?? null;

/** Every public holiday we have on file, as dates. */
export function holidays(store: Store): Set<string> {
  const out = new Set<string>();
  for (const r of store.db.prepare("SELECT value FROM settings WHERE key LIKE 'holidays:%'").all() as Row[]) {
    for (const d of (JSON.parse(r.value as string) as { dates: string[] }).dates) out.add(d);
  }
  return out;
}

const HOLIDAYS_EVERY_MS = 30 * 24 * 60 * 60_000;

/**
 * Fetch this year's and next year's public holidays for where the person is (from Nager.Date, no
 * key) and keep them, refreshed monthly. Leaves what it has when the service can't be reached.
 */
export async function refreshHolidays(store: Store, today: string): Promise<void> {
  const cc = countryOf(store.zone());
  if (!cc) return;
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    const key = `holidays:${cc}:${y}`;
    const have = store.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (have && Date.now() - Date.parse((JSON.parse(have.value) as { at: string }).at) < HOLIDAYS_EVERY_MS) continue;
    try {
      const list = await getJson<{ date: string; global?: boolean; types?: string[] }[]>(`https://date.nager.at/api/v3/PublicHolidays/${y}/${cc}`);
      // National days off only: not regional ones, and not observances people still work on.
      const dates = list.filter((h) => h.global !== false && (!h.types || h.types.includes('Public') || h.types.includes('Bank'))).map((h) => h.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
      store.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify({ dates, at: new Date().toISOString() }));
    } catch {
      // Unreachable or unknown country: weekends alone still count.
    }
  }
}

const recurringFromRow = (r: Row, hol: ReadonlySet<string>): Recurring => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  amount: r.amount,
  currency: r.currency,
  category: r.category,
  cadence: r.cadence,
  anchor: r.anchor,
  day: r.day,
  weekend: r.weekend,
  auto: !!r.auto,
  endDate: r.end_date,
  debtId: r.debt_id,
  holdingId: r.holding_id ?? null,
  active: !!r.active,
  next: r.active ? occurrence(r, r.done, hol) : null,
  monthly: r2(r.amount * PER_MONTH[r.cadence as Frequency]),
});

/** How many occurrences fall before today: they are history, not something to log now. */
function pastCount(r: Row, today: string, hol: ReadonlySet<string>): number {
  let n = 0;
  for (; n < 2000; n++) {
    const d = occurrence(r, n, hol);
    if (!d || d >= today) break;
  }
  return n;
}

export interface RecurringInput {
  kind: TxKind;
  name: string;
  amount: number;
  category: string;
  cadence: Frequency;
  /** The next date it's due. */
  next: string;
  day?: number | null;
  weekend?: Recurring['weekend'];
  auto?: boolean;
  endDate?: string | null;
  debtId?: string | null;
  /** Paid into this holding instead of logged as income or spending. */
  holdingId?: string | null;
  currency?: string;
}

export function addRecurring(store: Store, input: RecurringInput, today: string): Recurring {
  if (!(input.amount > 0)) throw new Invalid('An amount above zero');
  if (input.debtId && !store.db.prepare('SELECT 1 AS x FROM fin_debts WHERE id = ?').get(input.debtId)) throw new NotFound('Debt');
  if (input.debtId && input.holdingId) throw new Invalid('Either a debt to pay down or a holding to pay into, not both');
  const holding = input.holdingId ? (store.db.prepare('SELECT kind, currency FROM fin_holdings WHERE id = ?').get(input.holdingId) as Row | undefined) : undefined;
  if (input.holdingId && !holding) throw new NotFound('Holding');
  if (holding && !PAYABLE.has(holding.kind)) throw new Invalid('Money can be paid into a cash, retirement, property or other holding');
  const monthBased = !!CADENCE_MONTHS[input.cadence];
  const id = newId();
  const row: Row = {
    id,
    kind: input.debtId ? 'expense' : holding ? 'income' : input.kind,
    name: input.name.trim().slice(0, 80) || input.category,
    amount: r2(input.amount),
    currency: (holding?.currency ?? input.currency ?? getSettings(store).currency).toUpperCase(),
    category: input.debtId ? 'Debt' : holding ? 'Savings' : cleanCategory(input.category),
    cadence: input.cadence,
    anchor: input.next,
    day: monthBased ? (input.day ?? Number(input.next.slice(8, 10))) : null,
    weekend: input.weekend ?? 'none',
    auto: input.auto ?? true,
    end_date: input.endDate ?? null,
    debt_id: input.debtId ?? null,
    holding_id: input.holdingId ?? null,
  };
  // It starts from the next date given, never by logging months gone by.
  const hol = holidays(store);
  row.done = pastCount(row, today, hol);
  store.db
    .prepare('INSERT INTO fin_recurring (id, kind, name, amount, currency, category, cadence, anchor, day, done, weekend, auto, end_date, debt_id, holding_id, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)')
    .run(id, row.kind, row.name, row.amount, row.currency, row.category, row.cadence, row.anchor, row.day, row.done, row.weekend, Number(row.auto), row.end_date, row.debt_id, row.holding_id, nowIso());
  const saved = recurringFromRow(store.db.prepare('SELECT * FROM fin_recurring WHERE id = ?').get(id) as Row, hol);
  store.record('created', 'fin_recurring', id, financeSphere(store)?.id ?? null, `${saved.holdingId ? 'Paying in' : saved.kind === 'income' ? 'Expecting' : 'Recurring'}: ${saved.name}, ${money(saved.amount, saved.currency)} ${saved.cadence}`);
  return saved;
}

registerUndo('created:fin_recurring', (db, id) => void db.prepare('DELETE FROM fin_recurring WHERE id = ?').run(id));

export function updateRecurring(store: Store, id: string, patch: Partial<Omit<RecurringInput, 'kind' | 'currency' | 'debtId' | 'holdingId'>> & { active?: boolean }, today: string): Recurring {
  const r = store.db.prepare('SELECT * FROM fin_recurring WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Recurring item');
  const hol = holidays(store);
  const next: Row = { ...r };
  if (patch.name !== undefined) next.name = patch.name.trim().slice(0, 80) || r.name;
  if (patch.amount !== undefined) {
    if (!(patch.amount > 0)) throw new Invalid('An amount above zero');
    next.amount = r2(patch.amount);
  }
  if (patch.category !== undefined && !r.debt_id && !r.holding_id) next.category = cleanCategory(patch.category);
  if (patch.weekend !== undefined) next.weekend = patch.weekend;
  if (patch.auto !== undefined) next.auto = Number(patch.auto);
  if (patch.endDate !== undefined) next.end_date = patch.endDate;
  if (patch.cadence !== undefined) next.cadence = patch.cadence;
  // A new next date or cadence starts the schedule again from there. Without a new date it starts
  // from the next occurrence as scheduled (before any weekend move), keeping its day of the month.
  const moved = patch.next !== undefined && patch.next !== occurrence(r, r.done, hol);
  const recadenced = patch.cadence !== undefined && patch.cadence !== r.cadence;
  const redayed = patch.day !== undefined && patch.day !== r.day;
  if (moved || recadenced || redayed) {
    next.anchor = moved ? patch.next : nthDate(r.anchor, r.cadence, r.day, r.done);
    const day = patch.day ?? (moved ? Number(patch.next!.slice(8, 10)) : (r.day ?? Number(String(next.anchor).slice(8, 10))));
    next.day = CADENCE_MONTHS[next.cadence as Frequency] ? day : null;
    next.done = 0;
    next.done = pastCount(next, today, hol);
  }
  if (patch.active !== undefined) {
    // Coming back from a pause picks up from today; the paused months aren't logged.
    if (patch.active && !r.active) next.done = Math.max(next.done, pastCount(next, today, hol));
    next.active = Number(patch.active);
  }
  store.db
    .prepare('UPDATE fin_recurring SET name = ?, amount = ?, category = ?, cadence = ?, anchor = ?, day = ?, done = ?, weekend = ?, auto = ?, end_date = ?, active = ? WHERE id = ?')
    .run(next.name, next.amount, next.category, next.cadence, next.anchor, next.day, next.done, next.weekend, next.auto, next.end_date, next.active, id);
  return recurringFromRow(store.db.prepare('SELECT * FROM fin_recurring WHERE id = ?').get(id) as Row, hol);
}

function deleteRecurring(store: Store, id: string): void {
  if (store.db.prepare('DELETE FROM fin_recurring WHERE id = ?').run(id).changes === 0) throw new NotFound('Recurring item');
}

/** Close the reminder for an occurrence once it's paid or skipped. */
function settleReminder(store: Store, id: string, date: string | null): void {
  if (date) store.db.prepare("UPDATE signals SET status = 'done' WHERE source = 'finance' AND external_id = ? AND status IN ('new', 'seen')").run(`bill:${id}:${date}`);
}

/**
 * Log occurrence n: a transaction, a payment on its debt, or money into its holding. Returns false
 * (and pauses the item) when its debt is gone or paid off, or its holding is gone. Runs inside the
 * caller's transaction.
 */
function post(store: Store, r: Row, n: number, date: string, amount: number, paid: boolean, hol: ReadonlySet<string>): boolean {
  if (r.holding_id) {
    if (!payIntoHolding(store, r.holding_id, amount, r.name)) {
      store.db.prepare('UPDATE fin_recurring SET active = 0 WHERE id = ?').run(r.id);
      return false;
    }
  } else if (r.debt_id) {
    const debt = store.db.prepare('SELECT balance, closed_at FROM fin_debts WHERE id = ?').get(r.debt_id) as Row | undefined;
    if (!debt || debt.closed_at || debt.balance <= 0) {
      store.db.prepare('UPDATE fin_recurring SET active = 0 WHERE id = ?').run(r.id);
      return false;
    }
    applyPayment(store, r.debt_id, amount, date);
  } else {
    addTransaction(store, { kind: r.kind, amount, category: r.category, description: r.name, date, currency: r.currency }, paid ? 'manual' : 'recurring', { id: r.id, n, paid });
  }
  store.db.prepare('UPDATE fin_recurring SET done = ? WHERE id = ?').run(n + 1, r.id);
  settleReminder(store, r.id, occurrence(r, n, hol));
  return true;
}

/** Log every automatic occurrence that has come due. Safe to call as often as you like. */
export function postDue(store: Store, today: string): number {
  let posted = 0;
  const hol = holidays(store);
  const rows = store.db.prepare('SELECT * FROM fin_recurring WHERE active = 1 AND auto = 1').all() as Row[];
  for (const row of rows) {
    store.tx(() => {
      let r = row;
      for (let i = 0; i < MAX_CATCH_UP; i++) {
        const date = occurrence(r, r.done, hol);
        if (!date || date > today) break;
        if (!post(store, r, r.done, date, r.amount, false, hol)) break;
        posted++;
        r = store.db.prepare('SELECT * FROM fin_recurring WHERE id = ?').get(r.id) as Row;
      }
      // Still behind after catching up the most allowed: let the rest go rather than flood the log.
      const behind = pastCount(r, today, hol);
      if (r.done < behind) store.db.prepare('UPDATE fin_recurring SET done = ? WHERE id = ?').run(behind, r.id);
    });
  }
  return posted;
}

/** Mark the next occurrence paid (or received), at the amount it actually came to. */
export function markPaid(store: Store, id: string, today: string, opts: { amount?: number; date?: string } = {}): Recurring {
  return store.tx(() => {
    const r = store.db.prepare('SELECT * FROM fin_recurring WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFound('Recurring item');
    const hol = holidays(store);
    if (!r.active || !occurrence(r, r.done, hol)) throw new Invalid(`${r.name} has nothing left to pay`);
    const amount = opts.amount ?? r.amount;
    if (!(amount > 0)) throw new Invalid('An amount above zero');
    if (!post(store, r, r.done, opts.date ?? today, amount, true, hol)) throw new Invalid(r.holding_id ? `${r.name}'s holding is gone` : `${r.name}'s debt is already paid off`);
    return recurringFromRow(store.db.prepare('SELECT * FROM fin_recurring WHERE id = ?').get(id) as Row, hol);
  });
}

/** Let the next occurrence pass without logging it (a bill waived, a month off). */
export function skipNext(store: Store, id: string): Recurring {
  const r = store.db.prepare('SELECT * FROM fin_recurring WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Recurring item');
  const hol = holidays(store);
  settleReminder(store, id, occurrence(r, r.done, hol));
  store.db.prepare('UPDATE fin_recurring SET done = done + 1 WHERE id = ?').run(id);
  return recurringFromRow(store.db.prepare('SELECT * FROM fin_recurring WHERE id = ?').get(id) as Row, hol);
}

// Undoing a "marked paid" takes the transaction back and leaves that occurrence waiting again.
registerUndo('created:fin_rtx', (db, id) => {
  const t = db.prepare('SELECT recurring_id, recurring_n FROM fin_transactions WHERE id = ?').get(id) as Row | undefined;
  if (t?.recurring_id) db.prepare('UPDATE fin_recurring SET done = ? WHERE id = ? AND done = ?').run(t.recurring_n, t.recurring_id, t.recurring_n + 1);
  db.prepare('DELETE FROM fin_transactions WHERE id = ?').run(id);
});

/** Occurrences still to come (or waiting to be paid) up to a date, oldest first. */
function pending(store: Store, until: string, today: string): Upcoming[] {
  const out: Upcoming[] = [];
  const hol = holidays(store);
  for (const r of store.db.prepare('SELECT * FROM fin_recurring WHERE active = 1').all() as Row[]) {
    for (let n = r.done, i = 0; i < 60; n++, i++) {
      const date = occurrence(r, n, hol);
      if (!date || date > until) break;
      out.push({ recurringId: r.id, name: r.name, kind: r.kind, amount: r.amount, currency: r.currency, date, auto: !!r.auto, debtId: r.debt_id, holdingId: r.holding_id ?? null, overdue: date < today });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

const dueWords = (date: string, today: string) => (date < today ? `was due ${prettyDay(date)}` : date === today ? 'due today' : date === plusDays(today, 1) ? 'due tomorrow' : `due ${new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}`);

/** A signal for each bill you pay by hand, a few days before it's due. Once per occurrence. */
export function remindBills(store: Store, today: string): number {
  let raised = 0;
  const sphereId = financeSphere(store)?.id ?? null;
  const hol = holidays(store);
  for (const r of store.db.prepare("SELECT * FROM fin_recurring WHERE active = 1 AND auto = 0 AND kind = 'expense'").all() as Row[]) {
    const date = occurrence(r, r.done, hol);
    if (!date || date > plusDays(today, REMIND_DAYS)) continue;
    const sig = addSignal(store, {
      source: 'finance',
      kind: 'bill',
      externalId: `bill:${r.id}:${date}`,
      title: `${r.name} ${dueWords(date, today)} — ${money(r.amount, r.currency)}`,
      body: `${r.name} comes round ${r.cadence}. Mark it paid on the Finances page once it's done, at what it actually came to.`,
      sphereId,
      priority: date <= today ? 2 : 1,
      actions: [{ type: 'task', label: 'Add as a task', title: `Pay ${r.name}`, dueDate: date, sphereId }],
      data: { recurringId: r.id, date, amount: r.amount },
    });
    if (sig) raised++;
  }
  return raised;
}

/** Today where the person is, for the background jobs. */
function zoneToday(store: Store): string {
  const zone = store.zone();
  try {
    if (zone) return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
  } catch {
    // An unknown zone falls back to the server's.
  }
  return localDate();
}

// ── Salary plan ─────────────────────────────────────────────────────────────
// Where a month's pay should go, as a waterfall: what has to be paid, then a cushion, then the
// costliest debt, then the emergency fund, then investing. Every number says why.

/**
 * A weekly-to-monthly item whose first occurrence is more than five weeks off hasn't started yet
 * (CPF at a new age band, a raise from next year). It doesn't count towards a typical month.
 */
export function notStarted(r: Recurring, today: string): boolean {
  return r.active && ['weekly', 'biweekly', 'monthly'].includes(r.cadence) && r.anchor > plusDays(today, 35);
}

/** Debt at or above this rate is cleared before investing: few investments reliably earn more. */
const HIGH_APR = 8;
const BILL_CADENCES = new Set(['weekly', 'biweekly', 'monthly']);

const whole = (n: number) => Math.round(n);
/** Plan amounts are rounded to whole units, and read that way. */
const m0 = (n: number, currency: string) => money(Math.round(n), currency).replace(/\.00$/, '');

/** "Rent, Phone plan and 3 more". */
function listOf(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

interface PlanInput {
  today: string;
  currency: string;
  recurring: Recurring[];
  holdings: Holding[];
  debts: Debt[];
  toBase: (amount: number, currency: string) => number | null;
}

/** The last n complete months before today's, as YYYY-MM. */
const completeMonths = (today: string, n: number) => lastMonths(today, n + 1).slice(0, n);

export function salaryPlan(store: Store, p: PlanInput): SalaryPlan | null {
  const rules: PlanRules = { ...PLAN_DEFAULTS, ...getSettings(store).plan };
  const c = p.currency;
  const base = (amount: number, currency: string) => p.toBase(amount, currency) ?? 0;
  const active = p.recurring.filter((r) => r.active && !notStarted(r, p.today));
  const notes: string[] = [];
  const months = completeMonths(p.today, 3);
  const since = `${months[0]}-01`;
  const until = `${months.at(-1)}-31`;

  // What comes in: recurring pay, else what came in on average lately.
  // Money paid straight into a holding (CPF contributions, interest) never reaches the bank, so it isn't pay to split.
  let pay = active.filter((r) => r.kind === 'income' && !r.debtId && !r.holdingId).reduce((n, r) => n + base(r.monthly, r.currency), 0);
  let payFrom: SalaryPlan['payFrom'] = 'recurring';
  if (pay <= 0) {
    const rows = store.db.prepare("SELECT substr(date, 1, 7) AS m, amount, currency FROM fin_transactions WHERE kind = 'income' AND date >= ? AND date <= ?").all(since, until) as Row[];
    const byMonth = new Map<string, number>();
    for (const r of rows) byMonth.set(r.m, (byMonth.get(r.m) ?? 0) + base(r.amount, r.currency));
    if (byMonth.size) pay = [...byMonth.values()].reduce((a, b) => a + b, 0) / byMonth.size;
    payFrom = 'history';
    if (pay > 0) notes.push(`Pay is the average of the last ${byMonth.size === 1 ? 'month' : `${byMonth.size} months`}. Add your salary under Bills & pay for an exact plan.`);
  }
  if (pay <= 0) return null;

  // What has to go out: bills, minimums on debts no recurring item pays, yearly bills spread out.
  const bills = active.filter((r) => r.kind === 'expense' && BILL_CADENCES.has(r.cadence));
  const yearly = active.filter((r) => r.kind === 'expense' && !BILL_CADENCES.has(r.cadence));
  const paidByRecurring = new Set(active.map((r) => r.debtId).filter(Boolean));
  const open = p.debts.filter((d) => !d.closedAt && d.balance > 0);
  const minimums = open.filter((d) => d.minPayment && !paidByRecurring.has(d.id));
  const billsAmount = bills.reduce((n, r) => n + base(r.monthly, r.currency), 0) + minimums.reduce((n, d) => n + base(Math.min(d.minPayment!, d.balance), d.currency), 0);
  const yearlyAmount = yearly.reduce((n, r) => n + base(r.monthly, r.currency), 0);

  // Everyday spending: recent months' spending that no recurring item accounts for.
  const recurringNames = new Set(active.map((r) => r.name.toLowerCase()));
  const spent = store.db.prepare("SELECT substr(date, 1, 7) AS m, amount, currency, description FROM fin_transactions WHERE kind = 'expense' AND recurring_id IS NULL AND date >= ? AND date <= ?").all(since, until) as Row[];
  const everydayByMonth = new Map<string, number>();
  for (const r of spent) {
    if (recurringNames.has(String(r.description).toLowerCase())) continue;
    everydayByMonth.set(r.m, (everydayByMonth.get(r.m) ?? 0) + base(r.amount, r.currency));
  }
  let everyday = 0;
  let everydayWhy = '';
  if (everydayByMonth.size) {
    everyday = [...everydayByMonth.values()].reduce((a, b) => a + b, 0) / everydayByMonth.size;
    everydayWhy = `What everything else came to, on average, over the last ${everydayByMonth.size === 1 ? 'month' : `${everydayByMonth.size} months`}`;
  } else {
    const budgets = getSettings(store).budgets;
    everyday = Object.values(budgets).reduce((a, b) => a + b, 0);
    everydayWhy = everyday > 0 ? 'Your monthly budgets added up' : '';
    if (!everyday) notes.push("There's no spending history or budget yet, so everyday spending is left out: the split assumes bills are all you spend. Log a month of spending, or set budgets, for a truer plan.");
  }

  const essentials = billsAmount + yearlyAmount + everyday;
  // With nothing known about spending, every split would be wrong in the same direction: an
  // emergency fund of zero and nearly all pay to invest. Say what's missing instead.
  if (essentials <= 0) {
    return { month: p.today.slice(0, 7), pay: whole(pay), payFrom, essentials: 0, emergency: { target: 0, have: 0 }, buckets: [], shortfall: null, rules, notes: [...notes.filter((n) => !n.startsWith("There's no spending history")), "There's nothing on file about what you spend yet, so there's no split to suggest. Add your bills under Bills & pay, set monthly budgets, or log a month of spending, and the plan fills in."] };
  }
  const cash = p.holdings.filter((h) => h.kind === 'cash').reduce((n, h) => n + (h.valueBase ?? 0), 0);
  const investments = p.holdings.filter((h) => h.kind === 'stock' || h.kind === 'fund' || h.kind === 'crypto').reduce((n, h) => n + (h.valueBase ?? 0), 0);
  const cryptoValue = p.holdings.filter((h) => h.kind === 'crypto').reduce((n, h) => n + (h.valueBase ?? 0), 0);
  const target = whole(rules.emergencyMonths * essentials);

  const buckets: PlanBucket[] = [];
  const add = (b: PlanBucket) => {
    if (b.amount >= 1) buckets.push({ ...b, amount: whole(b.amount) });
  };

  add({ key: 'bills', label: 'Bills and minimums', amount: billsAmount, reason: listOf([...bills.map((r) => r.name), ...minimums.map((d) => `the minimum on ${d.name}`)]) || 'Nothing recurring yet', action: null });
  add({ key: 'yearly', label: 'Set aside for yearly bills', amount: yearlyAmount, reason: `${listOf(yearly.map((r) => r.name))} ${yearly.length === 1 ? 'comes' : 'come'} round less than monthly; this much a month has ${yearly.length === 1 ? 'it' : 'them'} ready`, action: yearlyAmount >= 1 ? `Move ${m0((yearlyAmount), c)} to savings for yearly bills` : null });
  add({ key: 'everyday', label: 'Everyday spending', amount: everyday, reason: everydayWhy, action: null });

  const surplus = pay - essentials;
  let shortfall: number | null = null;
  if (surplus <= 0) {
    shortfall = whole(-surplus);
    notes.push(`Your pay falls ${m0(shortfall, c)} short of bills and everyday spending. Trim the everyday, or look at the biggest bills, before anything else.`);
    return { month: p.today.slice(0, 7), pay: whole(pay), payFrom, essentials: whole(essentials), emergency: { target, have: whole(cash) }, buckets, shortfall, rules, notes };
  }

  let left = surplus;
  // A little guilt-free money keeps a plan livable, but never more than a quarter of what's spare.
  const fun = Math.min((rules.funPct / 100) * pay, surplus * 0.25);
  left -= fun;

  // A first month of essentials in cash comes before anything else.
  const buffer = Math.min(Math.max(0, essentials - cash), left);
  left -= buffer;

  // Then the costliest debt, highest rate first: paying 26% off is a 26% return, guaranteed.
  const high = open.filter((d) => (d.apr ?? 0) >= HIGH_APR).sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0));
  let debt = 0;
  const debtParts: string[] = [];
  for (const d of high) {
    if (left < 1) break;
    // This month's scheduled payment is already in bills; the extra is on top of it.
    const instalment = active.filter((r) => r.debtId === d.id).reduce((n, r) => n + base(r.monthly, r.currency), 0);
    const scheduled = instalment || base(Math.min(d.minPayment ?? 0, d.balance), d.currency);
    const put = Math.min(Math.max(0, base(d.balance, d.currency) - scheduled), left);
    if (put < 1) continue;
    debt += put;
    left -= put;
    debtParts.push(`${m0((put), c)} on ${d.name} (${d.apr}%)`);
  }

  // The rest of the emergency fund, half of what's left at a time, so investing isn't put off for years.
  const gap = Math.max(0, target - cash - buffer);
  const emergency = Math.min(gap, left * 0.5);
  left -= emergency;

  // What's left is invested. Crypto gets at most its cap's share of this month's money, and none once
  // it already makes up more than the cap of everything invested.
  const capRoom = Math.max(0, (rules.cryptoCapPct / 100) * (investments + left) - cryptoValue);
  const crypto = Math.min(left * (rules.cryptoCapPct / 100), capRoom);
  const invest = left - crypto;

  const biggestCash = p.holdings.filter((h) => h.kind === 'cash').sort((a, b) => (b.valueBase ?? 0) - (a.valueBase ?? 0))[0];
  const biggestFund = p.holdings.filter((h) => h.kind === 'fund' || h.kind === 'stock').sort((a, b) => (b.valueBase ?? 0) - (a.valueBase ?? 0))[0];
  const savingsWhere = biggestCash ? ` (${biggestCash.name})` : '';

  add({ key: 'fun', label: 'Yours to spend', amount: fun, reason: `${rules.funPct}% of pay, no questions asked`, action: null });
  add({ key: 'buffer', label: 'First month of cash', amount: buffer, reason: `You have ${m0((cash), c)} in cash, less than a month of essentials (${m0((essentials), c)}). That cushion comes first.`, action: `Move ${m0((buffer), c)} into savings${savingsWhere}` });
  add({ key: 'debt', label: 'Pay down costly debt', amount: debt, reason: `${high.map((d) => `${d.name} charges ${d.apr}%`).join('; ')}. No investment reliably earns that, so it goes first.`, action: `Pay ${debtParts.join(', then ')} on top of the minimum` });
  const monthsToFull = emergency > 0 ? Math.ceil((gap - emergency) / emergency) + 1 : null;
  add({ key: 'emergency', label: 'Emergency fund', amount: emergency, reason: `${rules.emergencyMonths} months of essentials is ${m0(target, c)}; you have ${m0((cash), c)}. Half of what's spare goes here until it's full${monthsToFull ? `, about ${monthsToFull} month${monthsToFull === 1 ? '' : 's'} at this rate` : ''}.`, action: `Move ${m0((emergency), c)} into savings${savingsWhere}` });
  add({ key: 'crypto', label: 'Crypto', amount: crypto, reason: `At most ${rules.cryptoCapPct}% of what you invest, so crypto stays a small part of the whole`, action: `Up to ${m0((crypto), c)} for crypto this month` });
  add({ key: 'invest', label: 'Invest for the long run', amount: invest, reason: gap > emergency ? 'The other half of what’s spare: long-term money grows while the safety net fills' : 'Your safety net is in place, so what’s spare can work for you', action: `Invest ${m0((invest), c)}${biggestFund ? ` (into ${biggestFund.name}, say)` : ''}` });

  // Only worth saying when there's money to invest this month.
  if (left >= 1 && investments > 0 && cryptoValue / investments > rules.cryptoCapPct / 100 && crypto < 1) {
    notes.push(`Crypto is ${Math.round((cryptoValue / investments) * 100)}% of your investments, above your ${rules.cryptoCapPct}% cap, so no new money goes to it this month.`);
  }
  if (high.length && left < 1 && debt > 0) notes.push('Everything spare goes to costly debt this month; investing and the rest of the emergency fund pick up once it’s cleared.');

  return { month: p.today.slice(0, 7), pay: whole(pay), payFrom, essentials: whole(essentials), emergency: { target, have: whole(cash) }, buckets, shortfall, rules, notes };
}

/** Once a month, when pay has come in, the plan arrives under Needs you with the moves to make. */
export function planSignal(store: Store, today: string): boolean {
  const month = today.slice(0, 7);
  const paid = store.db.prepare("SELECT 1 AS x FROM fin_transactions WHERE kind = 'income' AND category = 'Salary' AND substr(date, 1, 7) = ? AND date <= ?").get(month, today);
  if (!paid) return false;
  const plan = financeState(store, today).plan;
  if (!plan || plan.shortfall !== null || plan.buckets.length === 0) return false;
  const c = getSettings(store).currency;
  const sphereId = financeSphere(store)?.id ?? null;
  const moves = plan.buckets.filter((b) => b.action && b.key !== 'yearly');
  const sig = addSignal(store, {
    source: 'finance',
    kind: 'plan',
    externalId: `plan:${month}`,
    title: `Your pay is in — where ${m0(plan.pay, c)} goes this month`,
    body: plan.buckets.map((b) => `${b.label}: ${m0(b.amount, c)}`).join('\n') + (plan.notes.length ? `\n\n${plan.notes.join(' ')}` : ''),
    sphereId,
    priority: 2,
    actions: moves.slice(0, 3).map((b) => ({ type: 'task' as const, label: 'Add as a task', title: b.action!, dueDate: plusDays(today, 2), sphereId })),
    data: { month },
  });
  return !!sig;
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

  // Recurring: what's still to come this month, the next five weeks, and the monthly shape.
  const [yy, mm] = today.split('-').map(Number) as [number, number];
  const monthEnd = `${thisMonth}-${pad2(new Date(Date.UTC(yy, mm, 0)).getUTCDate())}`;
  const horizon = plusDays(today, 35);
  const coming = pending(store, horizon > monthEnd ? horizon : monthEnd, today);
  const expected = { income: 0, expense: 0 };
  for (const u of coming) {
    // Money paid into a holding never passes through the bank account, so it isn't cash flow.
    if (u.date > monthEnd || u.debtId || u.holdingId) continue;
    expected[u.kind] += toBase(u.amount, u.currency) ?? 0;
  }
  const hol = holidays(store);
  const recurring = (store.db.prepare('SELECT * FROM fin_recurring ORDER BY active DESC, kind DESC, amount DESC').all() as Row[]).map((r) => recurringFromRow(r, hol));
  const recurringMonthly = { income: 0, expense: 0 };
  for (const r of recurring) if (r.active && !notStarted(r, today) && !r.debtId && !r.holdingId) recurringMonthly[r.kind] += toBase(r.monthly, r.currency) ?? 0;

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
      expected: { income: r2(expected.income), expense: r2(expected.expense), net: r2(cur.income - cur.expense + expected.income - expected.expense) },
    },
    months: [...series.values()].map((m) => ({ key: m.key, income: r2(m.income), expense: r2(m.expense) })),
    transactions: recent,
    recurring,
    upcoming: coming.filter((u) => u.date <= horizon),
    recurringMonthly: { income: r2(recurringMonthly.income), expense: r2(recurringMonthly.expense) },
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
    plan: salaryPlan(store, { today, currency: base, recurring, holdings, debts, toBase }),
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
  if (f.recurring.some((r) => r.active)) {
    lines.push(`Recurring, a month: in ${money(f.recurringMonthly.income, c)}, out ${money(f.recurringMonthly.expense, c)}. Still to come this month: in ${money(f.month.expected.income, c)}, out ${money(f.month.expected.expense, c)}, leaving about ${money(f.month.expected.net, c)}.`);
    const soon = f.upcoming.filter((u) => u.date <= plusDays(today, 7));
    if (soon.length) lines.push(`Next 7 days: ${soon.map((u) => `${u.name} ${money(u.amount, u.currency)} on ${u.date}${u.auto ? '' : u.overdue ? ' (overdue, not marked paid)' : ' (to mark paid)'}`).join('; ')}.`);
  }
  if (f.plan) lines.push(`Suggested split of ${money(f.plan.pay, c)} pay this month: ${f.plan.buckets.map((b) => `${b.label.toLowerCase()} ${money(b.amount, c)}`).join(', ')}${f.plan.shortfall !== null ? ` — ${money(f.plan.shortfall, c)} short of essentials` : ''}. Emergency fund ${money(f.plan.emergency.have, c)} of ${money(f.plan.emergency.target, c)}.`);
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
const planRules = z.object({
  emergencyMonths: z.number().int().min(1).max(24).optional(),
  cryptoCapPct: z.number().min(0).max(100).optional(),
  funPct: z.number().min(0).max(30).optional(),
});

const frequency = z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']);
const weekend = z.enum(['none', 'before', 'after']);
const recurringInput = z.object({
  kind: z.enum(['income', 'expense']),
  name: z.string().min(1).max(80),
  amount: z.number().positive().max(1e10),
  category: z.string().min(1).max(40),
  cadence: frequency,
  next: dateStr,
  day: z.number().int().min(1).max(31).nullable().optional(),
  weekend: weekend.optional(),
  auto: z.boolean().optional(),
  end_date: dateStr.nullable().optional(),
  debt_id: z.string().nullable().optional(),
  holding_id: z.string().nullable().optional(),
  currency: currency.optional(),
});
const recurringPatch = recurringInput.omit({ kind: true, currency: true, debt_id: true, holding_id: true }).partial().extend({ active: z.boolean().optional() });
const toRecurring = (r: z.infer<typeof recurringInput>): RecurringInput => ({ kind: r.kind, name: r.name, amount: r.amount, category: r.category, cadence: r.cadence, next: r.next, day: r.day, weekend: r.weekend, auto: r.auto, endDate: r.end_date, debtId: r.debt_id, holdingId: r.holding_id, currency: r.currency });
const toRecurringPatch = (r: z.infer<typeof recurringPatch>) => ({ name: r.name, amount: r.amount, category: r.category, cadence: r.cadence, next: r.next, day: r.day, weekend: r.weekend, auto: r.auto, endDate: r.end_date, active: r.active });

function findRecurring(store: Store, nameOrId: string): Row {
  const r = (store.db.prepare('SELECT * FROM fin_recurring WHERE id = ?').get(nameOrId) ?? store.db.prepare('SELECT * FROM fin_recurring WHERE lower(name) LIKE ? ORDER BY active DESC, amount DESC LIMIT 1').get(`%${nameOrId.toLowerCase()}%`)) as Row | undefined;
  if (!r) throw new NotFound('Recurring item');
  return r;
}

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
        syncNetWorth(store, zoneToday(store));
      },
    },
  ],
});

const RECURRING = 'recurring';

registerFeature({
  id: RECURRING,
  jobs: [
    {
      id: RECURRING,
      everyMs: 15 * 60_000,
      run: async (store) => {
        const today = zoneToday(store);
        // Holidays first, so pay due before a long weekend is logged on the right day.
        await refreshHolidays(store, today);
        postDue(store, today);
        remindBills(store, today);
        planSignal(store, today);
      },
    },
  ],
});

const watched = new WeakSet<object>();

registerFeature({
  id: 'finance',
  tables: ['fin_debts', 'fin_recurring', 'fin_transactions', 'fin_holdings', 'fin_trades', 'fin_debt_payments', 'fin_alerts'],
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
    tool(
      'add_recurring',
      "Set up money that comes round on a schedule: salary or other regular income, rent, bills, subscriptions, insurance, a loan instalment. `next` is the next date it's due; month-based cadences keep that day of the month (day 31 = the month's last day). `weekend`: 'before' moves a date that falls on a weekend or public holiday to the working day before (common for salary), 'after' to the working day after. For pay on the last working day of the month: cadence monthly, day 31, weekend 'before', next = the last day of this month (or next month if that has passed). `auto` true logs it by itself on the day (fixed amounts: salary, rent, subscriptions); false waits for the user to mark it paid and reminds them a few days ahead (bills that vary, like electricity). For a loan or card instalment, pass debt_id (from get_finances) and each payment pays that debt down instead of logging spending. For money paid straight into something the user owns (CPF contributions, CPF interest, a standing order into savings), pass holding_id (a cash, retirement, property or other holding from get_finances): each payment raises that holding's value and is not counted as income. Past occurrences are not logged.",
      recurringInput,
      (r, { store, today }) => {
        const saved = addRecurring(store, toRecurring(r), today);
        postDue(store, today);
        return { data: { ok: true, recurring: saved }, summary: `${saved.kind === 'income' ? 'Expecting' : 'Recurring'}: ${saved.name}, ${money(saved.amount, saved.currency)} ${saved.cadence}` };
      },
    ),
    tool(
      'update_recurring',
      'Change a recurring item (by id or name): a new amount (a pay rise, a price change), next date, cadence, whether it logs itself, or active false to pause it (true resumes from today).',
      recurringPatch.extend({ item: z.string().min(1) }),
      ({ item, ...p }, { store, today }) => {
        const saved = updateRecurring(store, findRecurring(store, item).id, toRecurringPatch(p), today);
        return { data: { ok: true, recurring: saved }, summary: `Updated ${saved.name}` };
      },
    ),
    tool(
      'mark_recurring_paid',
      "Mark the next occurrence of a recurring bill paid (or income received), by id or name, at what it actually came to. Use when the user says they've paid a bill that waits to be marked paid.",
      z.object({ item: z.string().min(1), amount: z.number().positive().max(1e10).optional(), date: dateStr.optional() }),
      ({ item, amount, date }, { store, today }) => {
        const r = findRecurring(store, item);
        const saved = markPaid(store, r.id, today, { amount, date });
        return { data: { ok: true, next: saved.next }, summary: `Marked ${saved.name} paid${amount ? ` — ${money(amount, saved.currency)}` : ''}` };
      },
    ),
    tool(
      'get_salary_plan',
      "This month's recommended split of the user's pay, worked out from their recurring pay and bills, recent spending, cash, debts and investments: bills and minimums, yearly set-asides, everyday spending, guilt-free money, a first month of cash, extra on high-interest debt (8% APR and up, highest rate first), half of what's spare to the emergency fund until it holds the set number of months, and the rest invested with crypto kept under its cap. Each bucket says why. Use it when they ask where their money should go; explain it in your own words and adjust for anything you know that it doesn't (a big purchase coming, a bonus). It's a rule of thumb, not regulated financial advice.",
      z.object({}),
      async (_input, { store, today }) => {
        const plan = financeState(store, today).plan;
        return { data: plan ?? { none: 'No income to plan yet: add their salary as recurring income, or log a month of income.' }, summary: plan ? `Read this month's plan for ${money(plan.pay, getSettings(store).currency)}` : 'No salary plan yet' };
      },
    ),
    tool(
      'set_salary_plan_rules',
      "Change the rules the salary plan follows: months of essentials to keep as an emergency fund (default 6), the most crypto may make up of their investments in percent (default 10), and the percent of pay kept as guilt-free spending (default 5). Only when the user agrees.",
      planRules,
      (rules, { store, today }) => {
        updateSettings(store, { plan: rules });
        return { data: financeState(store, today).plan, summary: 'Updated the salary plan rules' };
      },
    ),
  ],
  routes: (app, { store }) => {
    // The price job only runs while its integration is on; it is on from the start.
    for (const job of [MARKETS, RECURRING]) if (!store.db.prepare('SELECT 1 AS x FROM integrations WHERE id = ?').get(job)) saveIntegration(store, { ...getIntegration(store, job), enabled: true });
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
      // Pay and bills that came due since the job last ran are logged before the page sees them.
      if (postDue(store, todayOf(c))) planSignal(store, todayOf(c));
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
      const s = await read(c, z.object({ currency: currency.optional(), budgets: z.record(z.string().min(1).max(40), z.number().min(0).max(1e9).nullable()).optional(), plan: planRules.optional() }));
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

    app.post('/api/finance/recurring', async (c) => {
      addRecurring(store, toRecurring(await read(c, recurringInput)), todayOf(c));
      postDue(store, todayOf(c));
      return c.json(state(c), 201);
    });
    app.patch('/api/finance/recurring/:id', async (c) => {
      updateRecurring(store, c.req.param('id'), toRecurringPatch(await read(c, recurringPatch)), todayOf(c));
      postDue(store, todayOf(c));
      return c.json(state(c));
    });
    app.delete('/api/finance/recurring/:id', (c) => {
      deleteRecurring(store, c.req.param('id'));
      return c.json(state(c));
    });
    app.post('/api/finance/recurring/:id/paid', async (c) => {
      const p = await read(c, z.object({ amount: z.number().positive().max(1e10).optional(), date: dateStr.optional() }));
      markPaid(store, c.req.param('id'), todayOf(c), p);
      return c.json(state(c), 201);
    });
    app.post('/api/finance/recurring/:id/skip', (c) => {
      skipNext(store, c.req.param('id'));
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
