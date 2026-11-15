// Finances sphere panels: net worth at a glance, this month's money in and out against
// budgets, a live crypto desk (prices, positions, trades, alerts), the portfolio, and debts.

import { ArrowDownLeft, ArrowUpRight, Bell, ChevronRight, Eye, EyeOff, Pencil, Plus, RefreshCw, Repeat, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Debt, DebtKind, FinanceState, Frequency, Holding, HoldingKind, MarketState, PlanBucketKey, PlanRules, Quote, Recurring, SalaryPlan, Transaction, TxKind, Upcoming } from '../../../shared/types.ts';
import { Link } from 'wouter';
import { amountsHidden, maskAmount, maskAmountsIn, useAmountsHidden } from '../privacy.ts';
import { financeWrite, useFinance, useMarket, useSpheres, useWrite } from '../api.ts';
import { addDays, cx, dueLabel, parseNumber, plural, relativeDay, shortDay, todayStr } from '../lib.ts';
import { useApp } from '../state.tsx';
import { Field, Modal, ProgressBar, Seg, Spinner } from './ui.tsx';

const EXPENSE = ['Housing', 'Food', 'Groceries', 'Transport', 'Utilities', 'Shopping', 'Health', 'Entertainment', 'Travel', 'Subscriptions', 'Education', 'Family', 'Giving', 'Fees & interest', 'Other'];
const INCOME = ['Salary', 'Bonus', 'Freelance', 'Business', 'Investments', 'Trading', 'Gifts', 'Refunds', 'Other'];
const KIND_LABEL: Record<HoldingKind, string> = { cash: 'Cash & bank', crypto: 'Crypto', stock: 'Stocks', fund: 'Funds', retirement: 'Retirement', property: 'Property', other: 'Other' };
const KIND_HUE: Record<HoldingKind, number> = { cash: 200, crypto: 62, stock: 265, fund: 300, retirement: 160, property: 25, other: 230 };
const DEBT_LABEL: Record<DebtKind, string> = { credit_card: 'Credit card', loan: 'Loan', mortgage: 'Mortgage', car: 'Car loan', student: 'Student loan', personal: 'Personal loan', bnpl: 'Buy now, pay later', other: 'Other' };

// ── Formatting ──────────────────────────────────────────────────────────────

/** An amount of yours, in a currency. Masked while amounts are hidden. */
export function money(n: number, currency: string, compact = false): string {
  const shown = formatMoney(n, currency, compact);
  return amountsHidden() ? maskAmount(shown) : shown;
}

function formatMoney(n: number, currency: string, compact: boolean): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, notation: compact && Math.abs(n) >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: compact || Math.abs(n) >= 1000 ? 0 : 2 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

/** A dollar amount of yours (a position, a gain): masked while amounts are hidden. Market prices use usd(). */
const usdMine = (n: number): string => (amountsHidden() ? maskAmount(usd(n)) : usd(n));

/** A coin price: cents for most, more digits for coins worth less than a dollar. */
export function usd(n: number): string {
  const digits = n >= 1000 ? 2 : n >= 1 ? 2 : n >= 0.01 ? 4 : 8;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: n >= 1 ? 2 : 0, maximumFractionDigits: digits })}`;
}

const signed = (s: string, n: number) => (n > 0 ? `+${s}` : n < 0 ? `−${s.replace('-', '')}` : s);
const pctText = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`;
/** A live price as a form starts it: enough digits to be right, not a float's worth. */
const priceText = (n: number) => String(Number(n.toFixed(n >= 100 ? 2 : n >= 1 ? 4 : 8)));
const qty = (n: number) => (amountsHidden() ? maskAmount('0') : qtyShown(n));
const qtyShown = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 8 : 4 });
const numOrNull = (s: string) => (s.trim() === '' ? null : parseNumber(s));
const bad = (...boxes: string[]) => boxes.some((s) => s.trim() !== '' && Number.isNaN(parseNumber(s)));
const NOT_A_NUMBER = 'Enter numbers only, like 1200 or 0.05.';

// ── Live repricing ──────────────────────────────────────────────────────────

/**
 * The page loads with prices as the server last saw them; the stream brings newer ones.
 * Reprice live coins (and everything that adds them up) from the newest quotes.
 */
function reprice(f: FinanceState, market: MarketState): FinanceState {
  const quotes = new Map(market.quotes.map((q) => [q.symbol, q]));
  const rate = f.currency === 'USD' ? 1 : f.fx?.rates[f.currency] ?? null;
  let delta = 0;
  const holdings = f.holdings.map((h): Holding => {
    const q = h.live ? quotes.get(h.symbol) : undefined;
    if (!q) return h;
    const value = h.quantity * q.price;
    const valueBase = rate === null ? null : value * rate;
    if (valueBase !== null) delta += valueBase - (h.valueBase ?? 0);
    const gain = h.costBasis > 0 ? value - h.costBasis : null;
    return { ...h, unitPrice: q.price, value, valueBase, gain, gainPct: gain !== null ? gain / h.costBasis : null, change24hPct: q.changePct };
  });
  const coins = holdings.filter((h) => h.live && h.quantity > 0);
  const crypto = f.crypto && {
    ...f.crypto,
    value: coins.reduce((n, h) => n + (h.value ?? 0), 0),
    gain: coins.reduce((n, h) => n + (h.gain ?? 0), 0),
    change24h: coins.reduce((n, h) => {
      const q = quotes.get(h.symbol);
      return n + (q ? h.quantity * (q.price - q.open) : 0);
    }, 0),
  };
  return { ...f, holdings, crypto, market, netWorth: { ...f.netWorth, assets: f.netWorth.assets + delta, net: f.netWorth.net + delta } };
}

/** The eye: hides every amount of yours across Finances, and remembers it on this device. */
export function HideAmounts() {
  const [hidden, toggle] = useAmountsHidden();
  return (
    <button type="button" className="icon-btn icon-btn-sm fin-eye" aria-pressed={hidden} aria-label={hidden ? 'Show amounts' : 'Hide amounts'} title={hidden ? 'Show amounts' : 'Hide amounts'} onClick={toggle}>
      {hidden ? <EyeOff size={15} /> : <Eye size={15} />}
    </button>
  );
}

/** The Finances data with live prices folded in. */
export function useLiveFinance(): FinanceState | undefined {
  // Every finance card reads through here, so a flip of "hide amounts" redraws them all.
  useAmountsHidden();
  const { data } = useFinance();
  const market = useMarket(data?.market);
  return useMemo(() => (data && market ? reprice(data, market) : data), [data, market]);
}

// ── Small parts ─────────────────────────────────────────────────────────────

function Spark({ values, up }: { values: number[] | undefined; up: boolean }) {
  if (!values || values.length < 2) return <span className="fin-spark" aria-hidden />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - lo) / span) * 26}`).join(' ');
  return (
    <svg className={cx('fin-spark', up ? 'is-up' : 'is-down')} viewBox="0 -1 100 30" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A price that flashes green or red as it ticks. */
function TickPrice({ price }: { price: number }) {
  const prev = useRef(price);
  const [flash, setFlash] = useState<{ dir: 'up' | 'down'; n: number } | null>(null);
  useEffect(() => {
    if (price !== prev.current) {
      setFlash((f) => ({ dir: price > prev.current ? 'up' : 'down', n: (f?.n ?? 0) + 1 }));
      prev.current = price;
    }
  }, [price]);
  return (
    <b key={flash?.n ?? 0} className={cx('num fin-price', flash && `flash-${flash.dir}`)}>
      {usd(price)}
    </b>
  );
}

function Delta({ n, children }: { n: number; children: ReactNode }) {
  return <span className={cx('fin-delta num', n > 0 && 'is-up', n < 0 && 'is-down')}>{children}</span>;
}

function LiveDot({ m }: { m: MarketState }) {
  const label = m.status === 'live' ? `Live from ${m.source ?? 'the exchange'}` : m.status === 'polling' ? `Updated every minute${m.source ? ` from ${m.source}` : ''}` : m.status === 'offline' ? `Prices unavailable${m.error ? `: ${m.error}` : ''}` : 'Nothing to price yet';
  return (
    <span className={cx('fin-live', `is-${m.status}`)} title={label}>
      <i aria-hidden />
      {m.status === 'live' ? 'Live' : m.status === 'polling' ? 'Delayed' : m.status === 'offline' ? 'Offline' : 'Idle'}
    </span>
  );
}

// ── Net worth ───────────────────────────────────────────────────────────────

export function MoneyHero() {
  const f = useLiveFinance();
  const [settings, setSettings] = useState(false);
  if (!f) return null;
  const c = f.currency;
  const nothing = !f.holdings.length && !f.debts.length && !f.transactions.length;
  return (
    <section className="card fin-hero">
      <div className="fin-hero-main">
        <span className="fin-label">Net worth</span>
        <b className="fin-big num">{nothing ? '—' : money(f.netWorth.net, c)}</b>
        <span className="muted fin-sub">
          {money(f.netWorth.assets, c, true)} owned · {money(f.netWorth.debts, c, true)} owed
          {f.netWorth.unpriced.length > 0 && <span title={`No price for ${f.netWorth.unpriced.join(', ')}`}> · {plural(f.netWorth.unpriced.length, 'holding')} unpriced</span>}
        </span>
      </div>
      <div className="fin-hero-stats">
        <div>
          <span className="fin-label">In this month</span>
          <b className="num">{money(f.month.income, c, true)}</b>
        </div>
        <div>
          <span className="fin-label">Out this month</span>
          <b className="num">{money(f.month.expense, c, true)}</b>
        </div>
        <div>
          <span className="fin-label">Saved</span>
          <b className={cx('num', f.month.net < 0 && 'is-down')}>{f.month.savingsRate === null ? '—' : `${Math.round(f.month.savingsRate * 100)}%`}</b>
        </div>
        {f.crypto && (
          <div>
            <span className="fin-label">Crypto 24h</span>
            <Delta n={f.crypto.change24h}>{signed(usdMine(Math.abs(f.crypto.change24h)), f.crypto.change24h)}</Delta>
          </div>
        )}
      </div>
      <div className="fin-hero-tools">
        <HideAmounts />
        <button type="button" className="btn btn-ghost btn-sm fin-currency" onClick={() => setSettings(true)} title="Base currency">
          {c}
        </button>
      </div>
      {settings && <CurrencySheet current={c} onClose={() => setSettings(false)} />}
    </section>
  );
}

const CURRENCIES = ['SGD', 'USD', 'MYR', 'IDR', 'EUR', 'GBP', 'AUD', 'JPY', 'HKD', 'AED', 'SAR', 'CNY', 'INR', 'THB', 'PHP'];

function CurrencySheet({ current, onClose }: { current: string; onClose: () => void }) {
  const [cur, setCur] = useState(current);
  const save = useWrite(() => financeWrite.put('/settings', { currency: cur }));
  return (
    <Modal
      title="Base currency"
      onClose={onClose}
      footer={
        <>
          <span className="hint">Totals and net worth are shown in this. Crypto stays in US dollars.</span>
          <button className="btn btn-primary btn-sm" disabled={!/^[A-Z]{3}$/.test(cur) || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Save
          </button>
        </>
      }
    >
      <Field label="Currency">
        <input className="input" list="fin-currencies" value={cur} onChange={(e) => setCur(e.target.value.toUpperCase().slice(0, 3))} data-autofocus />
      </Field>
      <datalist id="fin-currencies">
        {CURRENCIES.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

// ── This month ──────────────────────────────────────────────────────────────

export function CashflowCard() {
  const f = useLiveFinance();
  const { agentName } = useApp();
  const [adding, setAdding] = useState<TxKind | null>(null);
  const [budgets, setBudgets] = useState(false);
  const [all, setAll] = useState(false);
  const [repeat, setRepeat] = useState<Transaction | null>(null);
  const remove = useWrite((id: string) => financeWrite.del(`/transactions/${id}`));
  if (!f) return null;
  const c = f.currency;
  const spend = f.month.byCategory.filter((x) => x.kind === 'expense');
  const maxMonth = Math.max(1, ...f.months.flatMap((m) => [m.income, m.expense]));
  const list = all ? f.transactions : f.transactions.slice(0, 6);
  const monthName = new Date(`${f.month.key}-15T12:00:00`).toLocaleDateString(undefined, { month: 'long' });

  return (
    <section className="card fin-cash">
      <div className="card-head">
        <h2 className="card-title">{monthName}</h2>
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding('income')}>
            <ArrowDownLeft size={13} /> Income
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding('expense')}>
            <ArrowUpRight size={13} /> Spent
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBudgets(true)}>
            <Pencil size={12} /> Budgets
          </button>
        </div>
      </div>

      <div className="fin-flow">
        <div>
          <span className="fin-label">In</span>
          <b className="num is-up">{money(f.month.income, c)}</b>
        </div>
        <div>
          <span className="fin-label">Out</span>
          <b className="num">{money(f.month.expense, c)}</b>
        </div>
        <div>
          <span className="fin-label">Left</span>
          <b className={cx('num', f.month.net < 0 && 'is-down')}>{money(f.month.net, c)}</b>
        </div>
      </div>

      {(f.month.expected.income > 0 || f.month.expected.expense > 0) && (
        <p className="fin-expect">
          <Repeat size={13} aria-hidden />
          <span>
            Still to come this month{f.month.expected.income > 0 && <> <b className="num is-up">+{money(f.month.expected.income, c)}</b></>}
            {f.month.expected.expense > 0 && <> <b className="num">−{money(f.month.expected.expense, c)}</b></>}, leaving about{' '}
            <b className={cx('num', f.month.expected.net < 0 && 'is-down')}>{money(f.month.expected.net, c)}</b>
          </span>
        </p>
      )}

      {spend.length > 0 && (
        <ul className="fin-cats">
          {spend.map((x) => {
            const over = x.budget !== null && x.amount > x.budget;
            return (
              <li key={x.category} className={cx(over && 'is-over')}>
                <div className="fin-cat-line">
                  <span className="grow">{x.category}</span>
                  <span className="num">
                    {money(x.amount, c)}
                    {x.budget !== null && <span className="faint"> / {money(x.budget, c)}</span>}
                  </span>
                </div>
                {x.budget !== null && <ProgressBar value={x.budget ? x.amount / x.budget : 0} />}
              </li>
            );
          })}
        </ul>
      )}

      <div className="fin-months" aria-label="Income and spending, last six months">
        {f.months.map((m) => (
          <div key={m.key} className={cx('fin-month', m.key === f.month.key && 'is-now')} title={`${m.key}: in ${money(m.income, c)}, out ${money(m.expense, c)}`}>
            <div className="fin-month-bars">
              <i className="in" style={{ height: `${(m.income / maxMonth) * 100}%` }} />
              <i className="out" style={{ height: `${(m.expense / maxMonth) * 100}%` }} />
            </div>
            <span>{new Date(`${m.key}-15T12:00:00`).toLocaleDateString(undefined, { month: 'narrow' })}</span>
          </div>
        ))}
      </div>

      {f.transactions.length === 0 ? (
        <p className="empty">Nothing recorded yet. Add income or spending, or tell {agentName} — “spent $14 on lunch”.</p>
      ) : (
        <ul className="fin-tx">
          {list.map((t) => (
            <li key={t.id}>
              <span className={cx('fin-tx-icon', t.kind === 'income' ? 'is-in' : 'is-out')} aria-hidden>
                {t.kind === 'income' ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
              </span>
              <span className="grow clamp-1">
                {t.description || t.category}
                <span className="faint"> · {t.description ? `${t.category} · ` : ''}{shortDay(t.date)}</span>
              </span>
              <span className={cx('num', t.kind === 'income' && 'is-up')}>
                {t.kind === 'income' ? '+' : '−'}
                {money(t.amount, t.currency)}
              </span>
              {t.recurringId ? (
                <span className="fin-tx-rep" title="From a recurring item">
                  <Repeat size={12} aria-label="Recurring" />
                </span>
              ) : (
                <button type="button" className="icon-btn icon-btn-sm fin-tx-make" aria-label={`Make ${t.description || t.category} repeat`} title="Make it repeat" onClick={() => setRepeat(t)}>
                  <Repeat size={13} />
                </button>
              )}
              <button type="button" className="icon-btn icon-btn-sm" aria-label={`Remove ${t.description || t.category}`} onClick={() => remove.mutate(t.id)}>
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {f.transactions.length > 6 && (
        <div className="card-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `Show all ${f.transactions.length}`}
          </button>
        </div>
      )}
      {adding && <TxSheet kind={adding} currency={c} onClose={() => setAdding(null)} />}
      {budgets && <BudgetSheet f={f} onClose={() => setBudgets(false)} />}
      {repeat && <RecurringSheet f={f} item={null} from={repeat} onClose={() => setRepeat(null)} />}
    </section>
  );
}

function TxSheet({ kind: initial, currency, onClose }: { kind: TxKind; currency: string; onClose: () => void }) {
  const [kind, setKind] = useState<TxKind>(initial);
  const [t, setT] = useState({ amount: '', category: initial === 'income' ? 'Salary' : 'Food', description: '', date: todayStr() });
  const save = useWrite(() => financeWrite.post('/transactions', { kind, amount: parseNumber(t.amount), category: t.category, description: t.description, date: t.date }));
  const cats = kind === 'income' ? INCOME : EXPENSE;
  const amount = parseNumber(t.amount);
  return (
    <Modal
      title={kind === 'income' ? 'Money in' : 'Money out'}
      onClose={onClose}
      footer={
        <>
          <span className="hint">In {currency}</span>
          <button className="btn btn-primary btn-sm" disabled={!(amount > 0) || !t.category.trim() || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Add
          </button>
        </>
      }
    >
      <Seg
        label="Kind"
        value={kind}
        onChange={(k) => {
          setKind(k);
          setT({ ...t, category: k === 'income' ? 'Salary' : 'Food' });
        }}
        options={[
          { value: 'expense', label: 'Spent' },
          { value: 'income', label: 'Income' },
        ]}
      />
      <div className="field-row" style={{ marginTop: 14 }}>
        <Field label="Amount">
          <input className="input num" inputMode="decimal" value={t.amount} onChange={(e) => setT({ ...t, amount: e.target.value })} data-autofocus />
        </Field>
        <Field label="Date">
          <input className="input" type="date" value={t.date} onChange={(e) => setT({ ...t, date: e.target.value })} />
        </Field>
      </div>
      <Field label={kind === 'income' ? 'From' : 'What for'}>
        <input className="input" value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} placeholder={kind === 'income' ? 'November salary' : 'Lunch at the hawker centre'} />
      </Field>
      <div className="fin-chips" role="group" aria-label="Category">
        {cats.map((x) => (
          <button key={x} type="button" className={cx('chip', t.category === x ? 'chip-tint' : 'chip-outline')} aria-pressed={t.category === x} onClick={() => setT({ ...t, category: x })}>
            {x}
          </button>
        ))}
      </div>
      {bad(t.amount) && <p className="error-text">{NOT_A_NUMBER}</p>}
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

function BudgetSheet({ f, onClose }: { f: FinanceState; onClose: () => void }) {
  const cats = [...new Set([...Object.keys(f.budgets), ...f.month.byCategory.filter((x) => x.kind === 'expense').map((x) => x.category), ...EXPENSE.slice(0, 8)])];
  const [b, setB] = useState<Record<string, string>>(Object.fromEntries(cats.map((x) => [x, f.budgets[x]?.toString() ?? ''])));
  const save = useWrite(() => financeWrite.put('/settings', { budgets: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, numOrNull(v)])) }));
  const wrong = bad(...Object.values(b));
  return (
    <Modal
      title="Monthly budgets"
      onClose={onClose}
      footer={
        <>
          <span className="hint">In {f.currency}. Leave a box empty for no budget.</span>
          <button className="btn btn-primary btn-sm" disabled={wrong || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Save
          </button>
        </>
      }
    >
      <div className="fin-budgets">
        {cats.map((x) => (
          <label key={x}>
            <span>{x}</span>
            <input className="input num" inputMode="decimal" value={b[x] ?? ''} onChange={(e) => setB({ ...b, [x]: e.target.value })} />
          </label>
        ))}
      </div>
      {wrong && <p className="error-text">{NOT_A_NUMBER}</p>}
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

// ── Where your pay goes ─────────────────────────────────────────────────────

const PLAN_HUE: Record<PlanBucketKey, number> = { bills: 255, yearly: 285, everyday: 220, fun: 330, buffer: 175, debt: 25, emergency: 155, relief: 300, crypto: 62, invest: 135 };
/** Sentences the server wrote, with their amounts masked while amounts are hidden. */
const hide = (text: string) => (amountsHidden() ? maskAmountsIn(text) : text);

const planColor = (key: PlanBucketKey) => `oklch(0.7 0.13 ${PLAN_HUE[key]})`;
/** Plan amounts are whole units; they read without cents. */
const whole = (n: number, c: string) => money(n, c).replace(/[.,]00(?=\D*$)/, '');
const share = (part: number, of: number) => (part / of < 0.005 ? '<1%' : `${Math.round((part / of) * 100)}%`);

/** This month's recommended split of pay, bucket by bucket, each saying why. */
export function PlanCard() {
  const f = useLiveFinance();
  const { ask, agentName } = useApp();
  const [rules, setRules] = useState(false);
  const [recording, setRecording] = useState(false);
  if (!f) return null;
  const c = f.currency;
  const p = f.plan;
  const r = p?.relief ?? null;
  const monthName = new Date(`${f.month.key}-15T12:00:00`).toLocaleDateString(undefined, { month: 'long' });

  return (
    <section className="card fin-plan">
      <div className="card-head">
        <h2 className="card-title">Where your pay goes</h2>
        {p && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRules(true)}>
            <Pencil size={12} /> Rules
          </button>
        )}
      </div>
      {!p ? (
        <p className="empty">Add your salary under Bills &amp; pay, or log a month of income, and a split for each month's pay appears here.</p>
      ) : (
        <>
          <div className="fin-total">
            <b className="num">{whole(p.pay, c)}</b>
            <span className="muted">
              {monthName}'s pay{p.payFrom === 'history' ? ', from recent months' : ''}
            </span>
          </div>
          {p.buckets.length > 0 && (
          <div className="fin-plan-bar" aria-hidden>
            {p.buckets.map((b) => (
              <i key={b.key} style={{ flexGrow: b.amount, background: planColor(b.key) }} title={`${b.label}: ${whole(b.amount, c)}`} />
            ))}
          </div>
          )}
          {p.shortfall !== null && <p className="fin-tip is-bad">{whole(p.shortfall, c)} short of bills and everyday spending this month.</p>}
          {p.buckets.length > 0 && (
          <ol className="fin-plan-list">
            {p.buckets.map((b) => (
              <li key={b.key}>
                <i className="fin-kind" style={{ background: planColor(b.key) }} aria-hidden />
                <div className="grow">
                  <div className="fin-plan-line">
                    <b>{b.label}</b>
                    <span className="num">{whole(b.amount, c)}</span>
                    <span className="faint num fin-plan-pct">{share(b.amount, p.pay)}</span>
                  </div>
                  {b.reason && <p className="fin-plan-why">{hide(b.reason)}</p>}
                  {b.action && b.key !== 'yearly' && <p className="fin-plan-do">→ {hide(b.action)}</p>}
                </div>
              </li>
            ))}
          </ol>
          )}
          {p.notes.map((n) => (
            <p key={n} className="fin-tip">
              {hide(n)}
            </p>
          ))}
          {r && (
            <div className="fin-relief">
              <div className="fin-relief-head">
                <b>Tax relief {r.year}</b>
                <span className="hint">due 31 Dec</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRecording(true)}>
                  <Plus size={13} /> Record
                </button>
              </div>
              <div className="fin-relief-row">
                <span>SRS</span>
                <ProgressBar value={r.srs.cap ? r.srs.done / r.srs.cap : 0} />
                <span className="num">
                  {whole(r.srs.done, c)} <span className="faint">/ {whole(r.srs.cap, c)}</span>
                </span>
              </div>
              {r.cpf && (
                <div className="fin-relief-row">
                  <span>CPF top-up</span>
                  <ProgressBar value={r.cpf.cap ? r.cpf.done / r.cpf.cap : 0} />
                  <span className="num">
                    {whole(r.cpf.done, c)} <span className="faint">/ {whole(r.cpf.cap, c)}</span>
                  </span>
                </div>
              )}
              <p className="hint">
                {r.srs.left + (r.cpf?.left ?? 0) >= 1
                  ? `Using the rest saves about ${whole(r.saving, c)} on next year's tax, at a top rate of about ${Math.round(r.rate * 1000) / 10}% (estimated from your pay; a bonus or RSUs make it more).`
                  : 'All used for this year.'}
              </p>
            </div>
          )}
          <div className="fin-plan-foot">
            <span className="hint">
              {p.emergency.target > 0 && `Emergency fund ${money(p.emergency.have, c, true)} of ${money(p.emergency.target, c, true)} · `}a rule of thumb, not financial advice
            </span>
            <button type="button" className="btn btn-tint btn-sm" onClick={() => ask(`Look at my salary plan for ${monthName} and talk me through it. Is anything off given what you know about me, and what would you change?`)}>
              <span className="btn-text">Talk it through with {agentName}</span> <ArrowUpRight size={14} />
            </button>
          </div>
        </>
      )}
      {rules && p && <PlanRulesSheet rules={p.rules} onClose={() => setRules(false)} />}
      {recording && r && <ReliefSheet relief={r} currency={c} onClose={() => setRecording(false)} />}
    </section>
  );
}

function ReliefSheet({ relief, currency, onClose }: { relief: NonNullable<SalaryPlan['relief']>; currency: string; onClose: () => void }) {
  const [v, setV] = useState({ srs: String(relief.srs.done || ''), cpf: String(relief.cpf?.done || '') });
  const save = useWrite(() => financeWrite.put('/relief', { srs: numOrNull(v.srs) ?? 0, ...(relief.cpf ? { cpf: numOrNull(v.cpf) ?? 0 } : {}) }));
  const wrong = bad(v.srs, v.cpf);
  return (
    <Modal
      title={`Tax relief so far in ${relief.year}`}
      onClose={onClose}
      footer={
        <>
          <span className="hint">Totals for the year, in {currency}. The plan paces what's left.</span>
          <button className="btn btn-primary btn-sm" disabled={wrong || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Save
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label={`Into SRS (of ${whole(relief.srs.cap, currency)})`}>
          <input className="input num" inputMode="decimal" value={v.srs} onChange={(e) => setV({ ...v, srs: e.target.value })} placeholder="0" data-autofocus />
        </Field>
        {relief.cpf && (
          <Field label={`CPF top-up to your SA (of ${whole(relief.cpf.cap, currency)})`}>
            <input className="input num" inputMode="decimal" value={v.cpf} onChange={(e) => setV({ ...v, cpf: e.target.value })} placeholder="0" />
          </Field>
        )}
      </div>
      {wrong && <p className="error-text">{NOT_A_NUMBER}</p>}
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

function PlanRulesSheet({ rules, onClose }: { rules: PlanRules; onClose: () => void }) {
  const [r, setR] = useState({ emergencyMonths: String(rules.emergencyMonths), cryptoCapPct: String(rules.cryptoCapPct), funPct: String(rules.funPct), reliefs: rules.reliefs, srsCap: rules.srsCap });
  const save = useWrite(() => financeWrite.put('/settings', { plan: { emergencyMonths: Math.round(parseNumber(r.emergencyMonths)), cryptoCapPct: parseNumber(r.cryptoCapPct), funPct: parseNumber(r.funPct), reliefs: r.reliefs, srsCap: r.srsCap } }));
  const months = parseNumber(r.emergencyMonths);
  const cap = parseNumber(r.cryptoCapPct);
  const fun = parseNumber(r.funPct);
  const ok = months >= 1 && months <= 24 && cap >= 0 && cap <= 100 && fun >= 0 && fun <= 30;
  return (
    <Modal
      title="Rules for the plan"
      onClose={onClose}
      footer={
        <>
          <span className="hint">The order stays: bills, a first month of cash, costly debt, the emergency fund, then investing.</span>
          <button className="btn btn-primary btn-sm" disabled={!ok || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Save
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Emergency fund (months)" hint="Of bills and everyday spending. 3 to 6 is usual; more if your income is uneven">
          <input className="input num" inputMode="numeric" value={r.emergencyMonths} onChange={(e) => setR({ ...r, emergencyMonths: e.target.value })} data-autofocus />
        </Field>
        <Field label="Crypto cap (% of investments)" hint="New money stops going to crypto above this">
          <input className="input num" inputMode="decimal" value={r.cryptoCapPct} onChange={(e) => setR({ ...r, cryptoCapPct: e.target.value })} />
        </Field>
        <Field label="Yours to spend (% of pay)" hint="Guilt-free money, up to 30%">
          <input className="input num" inputMode="decimal" value={r.funPct} onChange={(e) => setR({ ...r, funPct: e.target.value })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Tax relief (Singapore)" hint="Paced so the year's room is used by 31 December">
          <select className="select" value={r.reliefs} onChange={(e) => setR({ ...r, reliefs: e.target.value as PlanRules['reliefs'] })}>
            <option value="auto">SRS when my top tax rate is 11.5% or more</option>
            <option value="srs">Always SRS</option>
            <option value="srs+cpf">SRS, then a CPF top-up to my Special Account</option>
            <option value="off">Off</option>
          </select>
        </Field>
        <Field label="SRS cap">
          <select className="select" value={r.srsCap} onChange={(e) => setR({ ...r, srsCap: Number(e.target.value) })}>
            <option value={15300}>S$15,300 (citizen or PR)</option>
            <option value={35700}>S$35,700 (foreigner)</option>
          </select>
        </Field>
      </div>
      {!ok && <p className="error-text">Months from 1 to 24, crypto from 0 to 100%, spending money from 0 to 30%.</p>}
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

// ── Bills and pay ───────────────────────────────────────────────────────────

const FREQ: { value: Frequency; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
];

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${s}`;
}

/** "Monthly on the 25th", "Every two weeks", "Yearly on Mar 1". */
export function scheduleText(r: Recurring): string {
  const day = r.day === 31 ? (r.weekend === 'before' ? 'the last working day' : 'the last day') : r.day ? `the ${ordinal(r.day)}` : '';
  switch (r.cadence) {
    case 'weekly':
      return `Every ${new Date(`${r.anchor}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' })}`;
    case 'biweekly':
      return 'Every two weeks';
    case 'monthly':
      return `Monthly on ${day}`;
    case 'quarterly':
      return `Quarterly on ${day}`;
    case 'yearly':
      return `Yearly on ${shortDay(r.anchor)}`;
  }
}

// Grouping: CPF and the like arrive as several items that differ only by a bracketed part —
// "CPF contribution (OA)", "(SA)", "(MA)" — and come round together. They read as one row, with
// the parts as chips.

/** "CPF contribution (OA)" → ["CPF contribution", "OA"]; a name without a bracketed end stays whole. */
function splitName(name: string): [string, string | null] {
  const m = /^(.*\S)\s*\(([^()]{1,24})\)$/.exec(name.trim());
  return m ? [m[1]!, m[2]!] : [name.trim(), null];
}

interface Grouped<T> {
  key: string;
  name: string;
  items: T[];
  /** The bracketed part of each item's name, or its whole name when it has none. */
  label: (t: T) => string;
}

/** Group items whose names share a stem and whose `sameWhen` key matches; order is kept, by first member. */
function groupItems<T extends { name: string }>(items: T[], sameWhen: (t: T) => string | null): Grouped<T>[] {
  const out: Grouped<T>[] = [];
  const byKey = new Map<string, Grouped<T>>();
  for (const t of items) {
    const [stem, part] = splitName(t.name);
    const when = part ? sameWhen(t) : null;
    const key = when === null ? `one:${out.length}` : `${stem}|${when}`;
    const g = byKey.get(key);
    if (g) g.items.push(t);
    else {
      const fresh: Grouped<T> = { key, name: stem, items: [t], label: (x) => splitName(x.name)[1] ?? x.name };
      byKey.set(key, fresh);
      out.push(fresh);
    }
  }
  // A group of one reads by its full name.
  return out.map((g) => (g.items.length === 1 ? { ...g, name: g.items[0]!.name } : g));
}

const sumOf = <T extends { amount: number }>(items: T[]) => items.reduce((n, t) => n + t.amount, 0);

// CPF's own order for its accounts; anything else alphabetically after.
const PART_ORDER = ['OA', 'SA', 'MA', 'RA'];
const partRank = (label: string) => {
  const i = PART_ORDER.indexOf(label.toUpperCase());
  return i < 0 ? PART_ORDER.length : i;
};
function inPartOrder<T extends { name: string }>(g: Grouped<T>): T[] {
  return [...g.items].sort((a, b) => partRank(g.label(a)) - partRank(g.label(b)) || g.label(a).localeCompare(g.label(b)));
}

/** Matches the server: a weekly-to-monthly item more than five weeks from its first date hasn't started. */
const notYet = (r: Recurring, today: string) => r.active && (r.cadence === 'weekly' || r.cadence === 'biweekly' || r.cadence === 'monthly') && r.anchor > addDays(today, 35);

/** "into CPF" when every holding shares a first word, else "into your holdings". */
function intoWords(names: string[]): string {
  const first = new Set(names.map((n) => n.split(/\s+/)[0]));
  return first.size === 1 && names.length ? `into ${[...first][0]}` : 'into your holdings';
}

export function BillsCard() {
  const f = useLiveFinance();
  const { agentName } = useApp();
  const [editing, setEditing] = useState<Recurring | 'new' | null>(null);
  const [paying, setPaying] = useState<Upcoming | null>(null);
  const skip = useWrite((id: string) => financeWrite.post(`/recurring/${id}/skip`));
  if (!f) return null;
  const c = f.currency;
  const today = todayStr();
  const soon = addDays(today, 3);
  const byId = new Map(f.recurring.map((r) => [r.id, r]));
  const holdingName = new Map(f.holdings.map((h) => [h.id, h.name]));
  const rate = (cur: string) => (cur === c ? 1 : f.fx?.rates[cur] && f.fx.rates[c] ? f.fx.rates[c] / f.fx.rates[cur] : null);

  // One line per item (its next date), then items that come round together as one line.
  const seen = new Set<string>();
  const next = f.upcoming.filter((u) => !seen.has(u.recurringId) && (seen.add(u.recurringId), true));
  const upcoming = groupItems(next, (u) => (u.auto && u.holdingId ? `${u.date}|into` : null));

  const later = f.recurring.filter((r) => notYet(r, today));
  const active = f.recurring.filter((r) => r.active && !notYet(r, today));
  const into = active.filter((r) => r.holdingId);
  const intoMonthly = into.reduce((n, r) => n + r.monthly * (rate(r.currency) ?? 0), 0);
  const intoLabel = intoWords(into.map((r) => holdingName.get(r.holdingId!) ?? ''));
  const sections: { title: string; items: Recurring[] }[] = [
    { title: 'Pay and income', items: active.filter((r) => r.kind === 'income' && !r.holdingId) },
    { title: 'Bills and payments', items: active.filter((r) => r.kind === 'expense') },
    { title: `Paid ${intoLabel}`, items: into },
    { title: 'Starting later', items: later },
    { title: 'Paused', items: f.recurring.filter((r) => !r.active) },
  ].filter((x) => x.items.length);
  const rows = (items: Recurring[]) => groupItems(items, (r) => (r.holdingId ? `${r.cadence}|${r.next ?? ''}|${r.active}` : null));
  const rowCount = sections.reduce((n, x) => n + rows(x.items).length, 0);
  // The fold earns its place only when it holds something the list above doesn't:
  // a paused item, or one not due in the next five weeks (a yearly renewal, say).
  const hidden = f.recurring.some((r) => !r.active || !seen.has(r.id));
  const { income, expense } = f.recurringMonthly;

  return (
    <section className="card fin-bills">
      <div className="card-head">
        <h2 className="card-title">Bills &amp; pay</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing('new')}>
          <Plus size={14} /> Add
        </button>
      </div>
      {f.recurring.length === 0 ? (
        <p className="empty">Salary, rent, bills, subscriptions, instalments — set them up once and they log themselves, or remind you to pay. Or tell {agentName}: “my salary is $7,200 on the 25th”.</p>
      ) : (
        <>
          <div className="fin-bills-sum">
            {income > 0 && (
              <div>
                <span className="fin-label">Pay</span>
                <b className="num is-up">+{money(income, c, true)}</b>
              </div>
            )}
            {expense > 0 && (
              <div>
                <span className="fin-label">Bills</span>
                <b className="num">−{money(expense, c, true)}</b>
              </div>
            )}
            {income > 0 && expense > 0 && (
              <div>
                <span className="fin-label">{income >= expense ? 'Leaves' : 'Short by'}</span>
                <b className={cx('num', income < expense && 'is-down')}>{money(Math.abs(income - expense), c, true)}</b>
              </div>
            )}
            {intoMonthly >= 1 && (
              <div>
                <span className="fin-label">{intoLabel[0]!.toUpperCase() + intoLabel.slice(1)}</span>
                <b className="num fin-into">{money(intoMonthly, c, true)}</b>
              </div>
            )}
          </div>
          <p className="fin-bills-note hint">A typical month{intoMonthly >= 1 ? `; what goes ${intoLabel} never reaches your bank` : ''}.</p>

          {upcoming.length === 0 && <p className="empty">Nothing due in the next five weeks.</p>}
          <ul className="fin-upcoming">
            {upcoming.map((g) => {
              const u = g.items[0]!;
              const r = byId.get(u.recurringId);
              const due = dueLabel(u.date, today);
              const waiting = g.items.length === 1 && !u.auto && u.date <= soon;
              const grouped = g.items.length > 1;
              const meta = grouped
                ? [r && scheduleText(r), `${intoWords(g.items.map((x) => holdingName.get(x.holdingId!) ?? ''))} · ${inPartOrder(g).map(g.label).join(', ')}`]
                : [r && scheduleText(r), u.holdingId ? intoWords([holdingName.get(u.holdingId) ?? '']) : u.debtId ? 'pays down a debt' : u.auto ? 'logs itself' : !waiting && 'mark it paid'];
              return (
                <li key={g.key} className={cx(u.overdue && 'is-late')}>
                  <span className={cx('fin-due', due.late && 'late')}>{due.text}</span>
                  <button type="button" className="fin-up-name" onClick={() => r && setEditing(r)}>
                    <span className="clamp-1">{g.name}</span>
                    <span className="faint clamp-1">{meta.filter(Boolean).join(' · ')}</span>
                  </button>
                  <span className={cx('num', u.holdingId ? 'fin-into' : u.kind === 'income' && 'is-up')}>
                    {u.kind === 'income' ? '+' : '−'}
                    {money(sumOf(g.items), u.currency)}
                  </span>
                  {waiting && (
                    <span className="fin-up-acts">
                      <button type="button" className="btn btn-tint btn-sm" aria-label={`Mark ${u.name} ${u.kind === 'income' ? 'received' : 'paid'}`} onClick={() => setPaying(u)}>
                        {u.kind === 'income' ? 'Received' : 'Paid'}
                      </button>
                      <button type="button" className="icon-btn icon-btn-sm" aria-label={`Skip ${u.name} this time`} title="Skip this time" onClick={() => skip.mutate(u.recurringId)}>
                        <X size={13} />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          {hidden && (
            <details className="todo-fold">
              <summary>
                <ChevronRight size={14} className="todo-fold-chev" aria-hidden />
                <span className="grow">Everything recurring</span>
                <span className="todo-fold-meta">{plural(rowCount, 'entry', 'entries')}</span>
              </summary>
              {sections.map((sec) => (
                <div key={sec.title} className="fin-rec-section">
                  <div className="list-label">{sec.title}</div>
                  <ul>
                    {rows(sec.items).map((g) => {
                      const r = g.items[0]!;
                      const grouped = g.items.length > 1;
                      return (
                        <li key={g.key} className={cx('fin-rec', !r.active && 'is-paused')}>
                          <button type="button" className="fin-rec-main" onClick={() => setEditing(r)} disabled={grouped} aria-label={grouped ? undefined : `Edit ${r.name}`}>
                            <span className="grow">
                              <span className="clamp-1">{g.name}</span>
                              <span className="faint clamp-1">
                                {r.active ? scheduleText(r) : 'Paused'}
                                {r.active && r.next && (notYet(r, today) ? ` · starts ${shortDay(r.next)}` : ` · next ${shortDay(r.next)}`)}
                                {!grouped && r.holdingId && ` · ${intoWords([holdingName.get(r.holdingId) ?? ''])}`}
                              </span>
                            </span>
                            <span className={cx('num', r.holdingId ? 'fin-into' : r.kind === 'income' && 'is-up')}>{money(sumOf(g.items), r.currency)}</span>
                          </button>
                          {grouped && (
                            <span className="fin-rec-parts">
                              {inPartOrder(g).map((x) => (
                                <button key={x.id} type="button" className="chip chip-outline" onClick={() => setEditing(x)} aria-label={`Edit ${x.name}`}>
                                  {g.label(x)} <span className="num">{money(x.amount, x.currency, true)}</span>
                                </button>
                              ))}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </details>
          )}
        </>
      )}
      {editing && <RecurringSheet f={f} item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {paying && <PaidSheet item={paying} onClose={() => setPaying(null)} />}
    </section>
  );
}

function PaidSheet({ item, onClose }: { item: Upcoming; onClose: () => void }) {
  const [amount, setAmount] = useState(String(item.amount));
  const [date, setDate] = useState(todayStr());
  const save = useWrite(() => financeWrite.post(`/recurring/${item.recurringId}/paid`, { amount: parseNumber(amount), date }));
  const a = parseNumber(amount);
  return (
    <Modal
      title={`${item.name} — ${item.kind === 'income' ? 'received' : 'paid'}`}
      onClose={onClose}
      footer={
        <>
          <span className="hint">Due {shortDay(item.date)}, usually {money(item.amount, item.currency)}</span>
          <button className="btn btn-primary btn-sm" disabled={!(a > 0) || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Record it
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label={`What it came to (${item.currency})`}>
          <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-autofocus />
        </Field>
        <Field label="Paid on">
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      {bad(amount) && <p className="error-text">{NOT_A_NUMBER}</p>}
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

/** The next date a day of the month comes round, from today. */
function nextDay(day: number, today: string): string {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const at = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(day, new Date(yy, mm, 0).getDate())).padStart(2, '0')}`;
  const here = at(y, m);
  return here >= today ? here : m === 12 ? at(y + 1, 1) : at(y, m + 1);
}

/** Which day of the month a monthly or quarterly item falls on. */
type DayMode = 'date' | 'last' | 'lastWorking';

const dayModeOf = (item: Recurring | null): DayMode => (item?.day === 31 ? (item.weekend === 'before' ? 'lastWorking' : 'last') : 'date');

/** The last day of the month a date is in, or of this month when that has passed. */
function monthEnd(date: string, today: string): string {
  const [y, m] = (date >= today ? date : today).split('-').map(Number) as [number, number];
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
}

function RecurringSheet({ f, item, from, onClose }: { f: FinanceState; item: Recurring | null; from?: Transaction; onClose: () => void }) {
  const today = todayStr();
  const startKind: TxKind = item?.kind ?? from?.kind ?? 'expense';
  const [kind, setKind] = useState<TxKind>(startKind);
  const [on, setOn] = useState<DayMode>(dayModeOf(item));
  const [r, setR] = useState({
    name: item?.name ?? from?.description ?? '',
    amount: item ? String(item.amount) : from ? String(from.amount) : '',
    category: item?.category ?? from?.category ?? (startKind === 'income' ? 'Salary' : 'Housing'),
    cadence: (item?.cadence ?? 'monthly') as Frequency,
    next: item?.next ?? (from ? nextDay(Number(from.date.slice(8, 10)), addDays(today, 1)) : today),
    auto: item?.auto ?? true,
    weekend: item?.weekend ?? (startKind === 'income' ? 'before' : 'none'),
    endDate: item?.endDate ?? '',
    debtId: item?.debtId ?? '',
    holdingId: item?.holdingId ?? '',
  });
  // "Last day" and "last working day" only make sense for items that come round by the month.
  const byMonth = r.cadence === 'monthly' || r.cadence === 'quarterly';
  const mode: DayMode = byMonth ? on : 'date';
  const chooseMode = (next: DayMode) => {
    setOn(next);
    if (next === 'date') return;
    // Day 31 is each month's last day; the working-day rule then steps back past weekends and holidays.
    setR({ ...r, next: monthEnd(r.next, today), weekend: next === 'lastWorking' ? 'before' : r.weekend === 'before' && on === 'lastWorking' ? 'none' : r.weekend });
  };
  const body = () => ({
    name: r.name,
    amount: parseNumber(r.amount),
    category: r.category,
    cadence: r.cadence,
    next: r.next,
    day: mode !== 'date' ? 31 : r.cadence === 'monthly' || r.cadence === 'quarterly' || r.cadence === 'yearly' ? Number(r.next.slice(8, 10)) : null,
    auto: r.auto,
    weekend: mode === 'lastWorking' ? 'before' : r.weekend,
    end_date: r.endDate || null,
  });
  // An edit sends the schedule only when it changed, so a weekend-shifted date never becomes the new day.
  const save = useWrite(() => {
    if (!item) return financeWrite.post('/recurring', { ...body(), kind, debt_id: r.debtId || null, holding_id: r.holdingId || null });
    const { next, day, cadence, ...rest } = body();
    const rescheduled = r.next !== item.next || mode !== dayModeOf(item);
    return financeWrite.patch(`/recurring/${item.id}`, { ...rest, ...(rescheduled ? { next, day } : {}), ...(r.cadence !== item.cadence ? { cadence } : {}) });
  });
  const pause = useWrite(() => financeWrite.patch(`/recurring/${item!.id}`, { active: !item!.active }));
  const remove = useWrite(() => financeWrite.del(`/recurring/${item!.id}`));
  const debts = f.debts.filter((d) => !d.closedAt);
  const forDebt = !!(item?.debtId ?? r.debtId);
  // Somewhere to pay money into: a cash balance, or a holding at a value you set (CPF, property).
  const payable = f.holdings.filter((h) => h.kind === 'cash' || h.kind === 'retirement' || h.kind === 'property' || h.kind === 'other');
  const intoId = item?.holdingId ?? r.holdingId;
  const intoHolding = intoId ? f.holdings.find((h) => h.id === intoId) : undefined;
  const linked = forDebt || !!intoId;
  const cats = kind === 'income' ? INCOME : EXPENSE;
  const a = parseNumber(r.amount);
  const err = save.error ?? pause.error ?? remove.error;

  return (
    <Modal
      title={item ? item.name : from ? 'Make it repeat' : 'Something that comes round'}
      onClose={onClose}
      footer={
        <>
          {item ? (
            <span className="row" style={{ gap: 4 }}>
              <button className="btn btn-ghost btn-sm" disabled={pause.isPending} onClick={() => pause.mutate(undefined, { onSuccess: onClose })}>
                {item.active ? 'Pause' : 'Resume'}
              </button>
              <button className="btn btn-ghost btn-sm" disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: onClose })}>
                <Trash2 size={13} /> Remove
              </button>
            </span>
          ) : (
            <span className="hint">From {shortDay(r.next)} on; nothing earlier is logged.</span>
          )}
          <button className="btn btn-primary btn-sm" disabled={!r.name.trim() || !(a > 0) || !r.next || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            {item ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      {!item && !linked && (
        <Seg
          label="Kind"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setR({ ...r, category: k === 'income' ? 'Salary' : 'Housing', weekend: k === 'income' ? 'before' : 'none' });
          }}
          options={[
            { value: 'expense', label: 'A bill or payment' },
            { value: 'income', label: 'Pay or income' },
          ]}
        />
      )}
      <div className="field-row" style={{ marginTop: item || linked ? 0 : 14 }}>
        <Field label="Name">
          <input className="input" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder={kind === 'income' ? 'Salary' : 'Rent, SP Group, Netflix…'} data-autofocus />
        </Field>
        <Field label={`Amount (${item?.currency ?? intoHolding?.currency ?? f.currency})`} hint={!r.auto ? 'What it usually comes to' : undefined}>
          <input className="input num" inputMode="decimal" value={r.amount} onChange={(e) => setR({ ...r, amount: e.target.value })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="How often">
          <select className="select" value={r.cadence} onChange={(e) => setR({ ...r, cadence: e.target.value as Frequency })}>
            {FREQ.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </Field>
        {byMonth && (
          <Field label="On">
            <select className="select" value={mode} onChange={(e) => chooseMode(e.target.value as DayMode)}>
              <option value="date">A date</option>
              <option value="last">The last day of the month</option>
              <option value="lastWorking">The last working day</option>
            </select>
          </Field>
        )}
        <Field
          label={mode === 'date' ? 'Next on' : 'Starting'}
          hint={mode === 'lastWorking' ? 'Earlier when the month ends on a weekend or public holiday' : mode === 'date' && r.cadence === 'monthly' && Number(r.next.slice(8, 10)) >= 29 ? 'Shorter months use their last day' : undefined}
        >
          <input className="input" type="date" value={r.next} onChange={(e) => setR({ ...r, next: mode === 'date' ? e.target.value : monthEnd(e.target.value, today) })} />
        </Field>
      </div>
      {mode !== 'lastWorking' && (
        <div className="field-row">
          <Field label="On a weekend or public holiday">
            <select className="select" value={r.weekend} onChange={(e) => setR({ ...r, weekend: e.target.value as Recurring['weekend'] })}>
              <option value="none">Keep the date</option>
              <option value="before">The working day before</option>
              <option value="after">The working day after</option>
            </select>
          </Field>
        </div>
      )}
      <Seg
        label="How it's recorded"
        value={r.auto ? 'auto' : 'manual'}
        onChange={(v) => setR({ ...r, auto: v === 'auto' })}
        options={[
          { value: 'auto', label: 'Log it by itself' },
          { value: 'manual', label: kind === 'income' ? "I'll mark it received" : "I'll mark it paid" },
        ]}
      />
      <p className="hint" style={{ marginTop: 6 }}>
        {r.auto ? 'For fixed amounts: logged on the day, at this amount.' : `For amounts that change: a reminder ${kind === 'income' ? 'on the day' : 'three days before'}, then you record what it came to.`}
      </p>
      {!item && kind === 'expense' && debts.length > 0 && (
        <Field label="Pays down a debt" hint="Each payment lowers that debt's balance instead of counting as spending">
          <select className="select" value={r.debtId} onChange={(e) => setR({ ...r, debtId: e.target.value })}>
            <option value="">No</option>
            {debts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!item && kind === 'income' && payable.length > 0 && (
        <Field label="Pays into" hint="Each payment adds to that holding instead of counting as income — CPF contributions and interest, a standing order into savings">
          <select className="select" value={r.holdingId} onChange={(e) => setR({ ...r, holdingId: e.target.value })}>
            <option value="">No, it comes to me</option>
            {payable.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {item && intoHolding && <p className="hint">Each payment adds to {intoHolding.name}.</p>}
      {!linked && (
        <div className="fin-chips" role="group" aria-label="Category">
          {cats.map((x) => (
            <button key={x} type="button" className={cx('chip', r.category === x ? 'chip-tint' : 'chip-outline')} aria-pressed={r.category === x} onClick={() => setR({ ...r, category: x })}>
              {x}
            </button>
          ))}
        </div>
      )}
      <div className="field-row" style={{ marginTop: 12 }}>
        <Field label="Ends" hint="Optional: the last date it's due">
          <input className="input" type="date" value={r.endDate} onChange={(e) => setR({ ...r, endDate: e.target.value })} />
        </Field>
      </div>
      {bad(r.amount) && <p className="error-text">{NOT_A_NUMBER}</p>}
      {err && <p className="error-text">{err.message}</p>}
    </Modal>
  );
}

// ── Crypto desk ─────────────────────────────────────────────────────────────
// Two cards share these parts: the whole desk on the Finances sphere, and a smaller one on Today.

interface CryptoView {
  market: MarketState;
  /** Coins held, by ticker. */
  held: Map<string, Holding>;
  /** Held coins first, then the watchlist. */
  symbols: string[];
  quotes: Map<string, Quote>;
}

function cryptoView(f: FinanceState): CryptoView {
  const held = new Map(f.holdings.filter((h) => h.live && h.quantity > 0).map((h) => [h.symbol, h]));
  return { market: f.market, held, symbols: [...new Set([...held.keys(), ...f.watchlist])], quotes: new Map(f.market.quotes.map((q) => [q.symbol, q])) };
}

type TradeInit = { symbol?: string; side?: 'buy' | 'sell' };

/** An alert for a coin with no quote yet starts from a blank one. */
const noQuote = (symbol: string): Quote => ({ symbol, price: 0, open: 0, high: 0, low: 0, changePct: 0, volume: 0, source: 'binance', at: 0 });

/** The trade and alert sheets a crypto card opens. */
function useCryptoSheets() {
  const [trade, setTrade] = useState<TradeInit | null>(null);
  const [alert, setAlert] = useState<Quote | null | undefined>(undefined);
  return {
    openTrade: (init: TradeInit = {}) => setTrade(init),
    openAlert: (quote: Quote | null = null) => setAlert(quote),
    render: (v: CryptoView) => (
      <>
        {trade && <TradeSheet init={trade} quotes={v.quotes} held={v.held} onClose={() => setTrade(null)} />}
        {alert !== undefined && <AlertSheet quote={alert} onClose={() => setAlert(undefined)} />}
      </>
    ),
  };
}

type CryptoSheets = ReturnType<typeof useCryptoSheets>;

/** Title, live status, Trade and Alert; `children` fills the corner. */
function CryptoHead({ market, sheets, children }: { market: MarketState; sheets: CryptoSheets; children: ReactNode }) {
  return (
    <div className="card-head">
      <h2 className="card-title">
        Crypto <LiveDot m={market} />
      </h2>
      <div className="row" style={{ gap: 4 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => sheets.openTrade()}>
          <Plus size={13} /> Trade
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => sheets.openAlert()}>
          <Bell size={13} /> Alert
        </button>
        {children}
      </div>
    </div>
  );
}

function CryptoSummary({ crypto }: { crypto: FinanceState['crypto'] }) {
  if (!crypto) return null;
  const cells: [string, number, boolean][] = [
    ['Holdings', crypto.value, false],
    ['Unrealized', crypto.gain, true],
    ['Realized', crypto.realized, true],
    ['24h', crypto.change24h, true],
  ];
  return (
    <div className="fin-desk-sum">
      {cells.map(([label, n, delta]) => (
        <div key={label}>
          <span className="fin-label">{label}</span>
          {delta ? <Delta n={n}>{signed(usdMine(Math.abs(n)), n)}</Delta> : <b className="num">{usdMine(n)}</b>}
        </div>
      ))}
    </div>
  );
}

/** A row per coin: price as it ticks, the day's line, the position. `onUnwatch` adds a way off the watchlist. */
function CryptoTicker({ v, sheets, onUnwatch }: { v: CryptoView; sheets: CryptoSheets; onUnwatch?: (symbol: string) => void }) {
  return (
    <ul className="fin-ticker">
      {v.symbols.map((s) => {
        const q = v.quotes.get(s);
        const h = v.held.get(s);
        return (
          <li key={s}>
            <span className="fin-sym">
              <b>{s}</b>
              {h ? <span className="faint num">{qty(h.quantity)}</span> : <span className="faint">watching</span>}
            </span>
            <Spark values={v.market.sparks[s]} up={(q?.changePct ?? 0) >= 0} />
            <span className="fin-quote">
              {q ? <TickPrice price={q.price} /> : <b className="faint">{v.market.unknown.includes(s) ? 'not listed' : '…'}</b>}
              {q && <Delta n={q.changePct}>{pctText(q.changePct)}</Delta>}
            </span>
            <span className="fin-pos">
              {h && h.value !== null && (
                <>
                  <span className="num">{usdMine(h.value)}</span>
                  {h.gain !== null && <Delta n={h.gain}>{signed(usdMine(Math.abs(h.gain)), h.gain)}</Delta>}
                </>
              )}
            </span>
            <span className="fin-row-acts">
              <button type="button" className="icon-btn icon-btn-sm" aria-label={`Trade ${s}`} title="Log a trade" onClick={() => sheets.openTrade({ symbol: s })}>
                <Plus size={13} />
              </button>
              <button type="button" className="icon-btn icon-btn-sm" aria-label={`Alert on ${s}`} title="Price alert" onClick={() => sheets.openAlert(q ?? noQuote(s))}>
                <Bell size={13} />
              </button>
              {onUnwatch && !h && (
                <button type="button" className="icon-btn icon-btn-sm" aria-label={`Stop watching ${s}`} title="Stop watching" onClick={() => onUnwatch(s)}>
                  <X size={13} />
                </button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The whole desk, on the Finances sphere: prices, positions, the watchlist, alerts and the trade log. */
export function CryptoDesk() {
  const f = useLiveFinance();
  const { toast } = useApp();
  const sheets = useCryptoSheets();
  const [coin, setCoin] = useState('');
  const watch = useWrite((symbol: string) => financeWrite.post('/watchlist', { symbol }));
  const unwatch = useWrite((symbol: string) => financeWrite.del(`/watchlist/${symbol}`));
  const refresh = useWrite(() => financeWrite.post('/refresh'));
  const removeTrade = useWrite((id: string) => financeWrite.del(`/trades/${id}`));
  const removeAlert = useWrite((id: string) => financeWrite.del(`/alerts/${id}`));
  if (!f) return null;
  const v = cryptoView(f);
  const openAlerts = f.alerts.filter((a) => !a.triggeredAt);

  return (
    <section className="card fin-desk">
      <CryptoHead market={v.market} sheets={sheets}>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Refresh prices" title="Refresh prices" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? <Spinner /> : <RefreshCw size={13} />}
        </button>
      </CryptoHead>
      <CryptoSummary crypto={f.crypto} />
      {v.symbols.length === 0 ? <p className="empty">Add a coin to watch its price live.</p> : <CryptoTicker v={v} sheets={sheets} onUnwatch={(s) => unwatch.mutate(s)} />}

      <form
        className="describe"
        onSubmit={(e) => {
          e.preventDefault();
          if (coin.trim()) watch.mutate(coin.trim(), { onSuccess: () => setCoin(''), onError: (err) => toast({ message: err.message }) });
        }}
      >
        <input value={coin} onChange={(e) => setCoin(e.target.value.toUpperCase())} placeholder="Watch a coin — PEPE, SUI, LINK…" aria-label="Coin to watch" maxLength={12} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!coin.trim() || watch.isPending}>
          Watch
        </button>
      </form>

      {openAlerts.length > 0 && (
        <div className="fin-alerts">
          {openAlerts.map((a) => (
            <span key={a.id} className="chip chip-outline">
              <Bell size={11} /> {a.symbol} {a.direction === 'above' ? '≥' : '≤'} {usd(a.price)}
              <button type="button" className="fin-chip-x" aria-label={`Remove the ${a.symbol} alert`} onClick={() => removeAlert.mutate(a.id)}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {f.trades.length > 0 && (
        <details className="todo-fold fin-trades">
          <summary>
            <ChevronRight size={14} className="todo-fold-chev" aria-hidden />
            <span className="grow">Trades</span>
            <span className="todo-fold-meta">{plural(f.trades.length, 'trade')}</span>
          </summary>
          <ul>
            {f.trades.map((t) => (
              <li key={t.id} className="fin-trade">
                <span className={cx('chip', t.side === 'buy' ? 'fin-buy' : 'fin-sell')}>{t.side}</span>
                <span className="grow clamp-1 num">
                  {qty(t.quantity)} {t.symbol} @ {usdMine(t.price)}
                  <span className="faint"> · {shortDay(t.date)}{t.venue ? ` · ${t.venue}` : ''}</span>
                </span>
                {t.realized !== null && <Delta n={t.realized}>{signed(usdMine(Math.abs(t.realized)), t.realized)}</Delta>}
                <button type="button" className="icon-btn icon-btn-sm" aria-label="Remove this trade" onClick={() => removeTrade.mutate(t.id, { onError: (err) => toast({ message: err.message }) })}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="fin-foot hint">Prices in US dollars from {v.market.source ?? 'Binance, or Coinbase where Binance is unavailable'}.</p>
      {sheets.render(v)}
    </section>
  );
}

/**
 * The desk at a glance, on Today: live prices, positions and quick Trade and Alert. The watchlist
 * box, alerts and trade log stay on Finances, a tap away. Absent until a coin is held or watched.
 */
export function TodayCrypto() {
  const f = useLiveFinance();
  const sheets = useCryptoSheets();
  const { data: spheres } = useSpheres();
  const financesId = spheres?.find((x) => x.key === 'finances')?.id;
  if (!f) return null;
  const v = cryptoView(f);
  if (v.symbols.length === 0) return null;

  return (
    <section className="card fin-desk fin-desk-today">
      <CryptoHead market={v.market} sheets={sheets}>
        <HideAmounts />
        {financesId && (
          <Link href={`/spheres/${financesId}`} className="icon-btn icon-btn-sm" aria-label="Open the crypto desk in Finances" title="Watchlist, trades and alerts in Finances">
            <ArrowUpRight size={14} />
          </Link>
        )}
      </CryptoHead>
      <CryptoSummary crypto={f.crypto} />
      <CryptoTicker v={v} sheets={sheets} />
      {sheets.render(v)}
    </section>
  );
}

function TradeSheet({ init, quotes, held, onClose }: { init: { symbol?: string; side?: 'buy' | 'sell' }; quotes: Map<string, Quote>; held: Map<string, Holding>; onClose: () => void }) {
  const [side, setSide] = useState<'buy' | 'sell'>(init.side ?? 'buy');
  const [t, setT] = useState({ symbol: init.symbol ?? '', quantity: '', price: init.symbol && quotes.get(init.symbol) ? priceText(quotes.get(init.symbol)!.price) : '', fee: '', venue: '', date: todayStr() });
  const save = useWrite(() => financeWrite.post('/trades', { symbol: t.symbol, side, quantity: parseNumber(t.quantity), price: parseNumber(t.price), fee: numOrNull(t.fee) ?? 0, venue: t.venue, date: t.date }));
  const q = parseNumber(t.quantity);
  const p = parseNumber(t.price);
  const h = held.get(t.symbol.toUpperCase());
  const total = q > 0 && p > 0 ? q * p : null;
  return (
    <Modal
      title="Log a trade"
      onClose={onClose}
      footer={
        <>
          <span className="hint">{total !== null ? `${side === 'buy' ? 'Cost' : 'Proceeds'} ${usd(total)}` : 'Prices in US dollars'}</span>
          <button className="btn btn-primary btn-sm" disabled={!t.symbol.trim() || !(q > 0) || !(p > 0) || bad(t.fee) || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Log {side}
          </button>
        </>
      }
    >
      <Seg
        label="Side"
        value={side}
        onChange={setSide}
        options={[
          { value: 'buy', label: 'Buy' },
          { value: 'sell', label: 'Sell' },
        ]}
      />
      <div className="field-row" style={{ marginTop: 14 }}>
        <Field label="Coin">
          <input
            className="input"
            value={t.symbol}
            onChange={(e) => {
              const symbol = e.target.value.toUpperCase().slice(0, 12);
              const live = quotes.get(symbol);
              setT({ ...t, symbol, price: live && !t.price ? priceText(live.price) : t.price });
            }}
            placeholder="BTC"
            data-autofocus={!init.symbol || undefined}
          />
        </Field>
        <Field label="Quantity" hint={side === 'sell' && h ? `You hold ${qty(h.quantity)}` : undefined}>
          <input className="input num" inputMode="decimal" value={t.quantity} onChange={(e) => setT({ ...t, quantity: e.target.value })} data-autofocus={init.symbol ? true : undefined} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Price per coin (USD)">
          <input className="input num" inputMode="decimal" value={t.price} onChange={(e) => setT({ ...t, price: e.target.value })} />
        </Field>
        <Field label="Fee (USD)">
          <input className="input num" inputMode="decimal" value={t.fee} onChange={(e) => setT({ ...t, fee: e.target.value })} placeholder="0" />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Exchange">
          <input className="input" value={t.venue} onChange={(e) => setT({ ...t, venue: e.target.value })} placeholder="Binance, Coinbase, OKX…" />
        </Field>
        <Field label="Date">
          <input className="input" type="date" value={t.date} onChange={(e) => setT({ ...t, date: e.target.value })} />
        </Field>
      </div>
      {bad(t.quantity, t.price, t.fee) && <p className="error-text">{NOT_A_NUMBER}</p>}
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

function AlertSheet({ quote, onClose }: { quote: Quote | null; onClose: () => void }) {
  const [a, setA] = useState({ symbol: quote?.symbol ?? '', price: '', note: '' });
  const save = useWrite(() => financeWrite.post('/alerts', { symbol: a.symbol, price: parseNumber(a.price), note: a.note }));
  const p = parseNumber(a.price);
  const now = quote && quote.price > 0 && quote.symbol === a.symbol.toUpperCase() ? quote.price : null;
  return (
    <Modal
      title="Price alert"
      onClose={onClose}
      footer={
        <>
          <span className="hint">{now && p > 0 ? `When it ${p >= now ? 'rises to' : 'falls to'} ${usd(p)} (${pctText(((p - now) / now) * 100)})` : 'It arrives under Needs you, once.'}</span>
          <button className="btn btn-primary btn-sm" disabled={!a.symbol.trim() || !(p > 0) || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Set alert
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Coin">
          <input className="input" value={a.symbol} onChange={(e) => setA({ ...a, symbol: e.target.value.toUpperCase().slice(0, 12) })} placeholder="BTC" data-autofocus={!quote || undefined} />
        </Field>
        <Field label="Price (USD)" hint={now ? `Now ${usd(now)}` : undefined}>
          <input className="input num" inputMode="decimal" value={a.price} onChange={(e) => setA({ ...a, price: e.target.value })} data-autofocus={quote ? true : undefined} />
        </Field>
      </div>
      <Field label="Note to self">
        <input className="input" value={a.note} onChange={(e) => setA({ ...a, note: e.target.value })} placeholder="Take profit on a third" />
      </Field>
      {bad(a.price) && <p className="error-text">{NOT_A_NUMBER}</p>}
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

// ── Portfolio ───────────────────────────────────────────────────────────────

export function PortfolioCard() {
  const f = useLiveFinance();
  const [editing, setEditing] = useState<Holding | 'new' | null>(null);
  if (!f) return null;
  const c = f.currency;
  const total = f.allocation.reduce((n, a) => n + a.value, 0);
  return (
    <section className="card fin-portfolio">
      <div className="card-head">
        <h2 className="card-title">Portfolio</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing('new')}>
          <Plus size={14} /> Add
        </button>
      </div>
      {f.holdings.length === 0 ? (
        <p className="empty">Your accounts, coins, stocks, CPF and property. Add a bank balance to start.</p>
      ) : (
        <>
          <div className="fin-total">
            <b className="num">{money(f.netWorth.assets, c)}</b>
            <span className="muted">across {plural(f.holdings.filter((h) => h.quantity > 0).length, 'holding')}</span>
          </div>
          {total > 0 && (
            <>
              <div className="fin-alloc" aria-label="Allocation">
                {f.allocation.map((a) => (
                  <i key={a.kind} style={{ flexGrow: a.value, background: `oklch(0.7 0.13 ${KIND_HUE[a.kind]})` }} title={`${KIND_LABEL[a.kind]}: ${Math.round((a.value / total) * 100)}%`} />
                ))}
              </div>
              <div className="fin-legend">
                {f.allocation.map((a) => (
                  <span key={a.kind}>
                    <i style={{ background: `oklch(0.7 0.13 ${KIND_HUE[a.kind]})` }} />
                    {KIND_LABEL[a.kind]} <b className="num">{Math.round((a.value / total) * 100)}%</b>
                  </span>
                ))}
              </div>
            </>
          )}
          <ul className="fin-holdings">
            {f.holdings
              .filter((h) => h.quantity > 0 || !h.live)
              .map((h) => (
                <li key={h.id}>
                  <button type="button" className="fin-holding" onClick={() => setEditing(h)}>
                    <i className="fin-kind" style={{ background: `oklch(0.7 0.13 ${KIND_HUE[h.kind]})` }} aria-hidden />
                    <span className="grow">
                      <span className="clamp-1">{h.name}</span>
                      <span className="faint fin-holding-sub">
                        {h.kind === 'cash' ? KIND_LABEL.cash : h.symbol ? `${qty(h.quantity)} ${h.symbol}` : KIND_LABEL[h.kind]}
                        {h.live && ' · live'}
                        {!h.live && h.kind !== 'cash' && ` · updated ${relativeDay(h.updatedAt.slice(0, 10), todayStr())}`}
                      </span>
                    </span>
                    <span className="fin-holding-val">
                      <span className="num">{h.valueBase !== null ? money(h.valueBase, c) : h.value !== null ? money(h.value, h.currency) : 'no price'}</span>
                      {h.gain !== null && h.gainPct !== null && <Delta n={h.gain}>{pctText(h.gainPct * 100)}</Delta>}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </>
      )}
      {editing && <HoldingSheet holding={editing === 'new' ? null : editing} currency={c} onClose={() => setEditing(null)} />}
    </section>
  );
}

function HoldingSheet({ holding, currency, onClose }: { holding: Holding | null; currency: string; onClose: () => void }) {
  const [kind, setKind] = useState<HoldingKind>(holding?.kind ?? 'cash');
  const [h, setH] = useState({
    name: holding?.name ?? '',
    symbol: holding?.symbol ?? '',
    quantity: holding ? String(holding.quantity) : '',
    price: holding?.price != null ? String(holding.price) : '',
    cost: holding?.costBasis ? String(holding.costBasis) : '',
    currency: holding?.currency ?? currency,
  });
  // Cash is its balance; property and the like are one thing at a value; the rest are units at a price.
  const shape = kind === 'cash' ? 'balance' : kind === 'property' || kind === 'retirement' || kind === 'other' ? 'value' : 'units';
  const body = () => {
    if (shape === 'balance') return { kind, name: h.name, quantity: parseNumber(h.quantity), currency: h.currency };
    if (shape === 'value') return { kind, name: h.name, quantity: 1, price: parseNumber(h.price), cost_basis: numOrNull(h.cost) ?? 0, currency: h.currency };
    return { kind, name: h.name || h.symbol, symbol: h.symbol, quantity: parseNumber(h.quantity), price: kind === 'crypto' ? null : numOrNull(h.price), cost_basis: numOrNull(h.cost) ?? 0, currency: kind === 'crypto' ? 'USD' : h.currency };
  };
  const save = useWrite(() => {
    const b = body() as Record<string, unknown>;
    if (!holding) return financeWrite.post('/holdings', b);
    const { kind: _k, symbol: _s, currency: _c, ...patch } = b;
    return financeWrite.patch(`/holdings/${holding.id}`, patch);
  });
  const remove = useWrite(() => financeWrite.del(`/holdings/${holding!.id}`));
  const needs = shape === 'balance' ? [h.quantity] : shape === 'value' ? [h.price] : [h.quantity];
  const ready = (shape === 'units' ? !!h.symbol.trim() || !!h.name.trim() : !!h.name.trim()) && needs.every((x) => parseNumber(x) >= 0) && !bad(h.quantity, h.price, h.cost);
  const unit = kind === 'crypto' ? 'USD' : h.currency;

  return (
    <Modal
      title={holding ? holding.name : 'Add to the portfolio'}
      onClose={onClose}
      footer={
        <>
          {holding ? (
            <button className="btn btn-ghost btn-sm" disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: onClose })}>
              <Trash2 size={13} /> Remove
            </button>
          ) : (
            <span />
          )}
          <button className="btn btn-primary btn-sm" disabled={!ready || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            {holding ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      {!holding && (
        <div className="fin-chips" role="group" aria-label="Kind">
          {(Object.keys(KIND_LABEL) as HoldingKind[]).map((k) => (
            <button key={k} type="button" className={cx('chip', kind === k ? 'chip-tint' : 'chip-outline')} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      )}
      <div className="field-row" style={{ marginTop: holding ? 0 : 14 }}>
        <Field label="Name">
          <input className="input" value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} placeholder={kind === 'cash' ? 'DBS Multiplier' : kind === 'retirement' ? 'CPF Ordinary' : kind === 'property' ? 'HDB flat' : kind === 'crypto' ? 'Bitcoin' : 'S&P 500 ETF'} data-autofocus />
        </Field>
        {shape === 'units' && !holding && (
          <Field label="Ticker">
            <input className="input" value={h.symbol} onChange={(e) => setH({ ...h, symbol: e.target.value.toUpperCase().slice(0, 12) })} placeholder={kind === 'crypto' ? 'BTC' : 'VOO'} />
          </Field>
        )}
      </div>
      <div className="field-row">
        {shape === 'balance' && (
          <Field label={`Balance (${h.currency})`}>
            <input className="input num" inputMode="decimal" value={h.quantity} onChange={(e) => setH({ ...h, quantity: e.target.value })} />
          </Field>
        )}
        {shape === 'value' && (
          <Field label={`Value (${h.currency})`}>
            <input className="input num" inputMode="decimal" value={h.price} onChange={(e) => setH({ ...h, price: e.target.value })} />
          </Field>
        )}
        {shape === 'units' && (
          <Field label="Quantity">
            <input className="input num" inputMode="decimal" value={h.quantity} onChange={(e) => setH({ ...h, quantity: e.target.value })} />
          </Field>
        )}
        {shape === 'units' && kind !== 'crypto' && (
          <Field label={`Price per unit (${unit})`} hint="Update it now and then">
            <input className="input num" inputMode="decimal" value={h.price} onChange={(e) => setH({ ...h, price: e.target.value })} />
          </Field>
        )}
        {shape !== 'balance' && (
          <Field label={`Total cost (${unit})`} hint="For gain and loss; optional">
            <input className="input num" inputMode="decimal" value={h.cost} onChange={(e) => setH({ ...h, cost: e.target.value })} />
          </Field>
        )}
        {!holding && kind !== 'crypto' && (
          <Field label="Currency">
            <input className="input" value={h.currency} onChange={(e) => setH({ ...h, currency: e.target.value.toUpperCase().slice(0, 3) })} />
          </Field>
        )}
      </div>
      {kind === 'crypto' && <p className="hint">Priced live. If you trade it, log trades on the Crypto card instead so average cost and P&amp;L stay right.</p>}
      {bad(h.quantity, h.price, h.cost) && <p className="error-text">{NOT_A_NUMBER}</p>}
      {(save.error ?? remove.error) && <p className="error-text">{(save.error ?? remove.error)!.message}</p>}
    </Modal>
  );
}

// ── Debts ───────────────────────────────────────────────────────────────────

export function DebtsCard() {
  const f = useLiveFinance();
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<Debt | null>(null);
  const [editing, setEditing] = useState<Debt | null>(null);
  const [closed, setClosed] = useState(false);
  if (!f) return null;
  const c = f.currency;
  const open = f.debts.filter((d) => !d.closedAt);
  const done = f.debts.filter((d) => d.closedAt);
  const monthly = open.reduce((n, d) => n + (d.minPayment ?? 0), 0);
  // The avalanche: extra money goes to the highest rate first.
  const target = open.filter((d) => d.apr).sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0))[0];
  const today = todayStr();

  return (
    <section className="card fin-debts">
      <div className="card-head">
        <h2 className="card-title">Debts</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
          <Plus size={14} /> Add
        </button>
      </div>
      {open.length === 0 ? (
        <p className="empty">{done.length ? 'Nothing owed. Well done.' : 'Cards, loans, a mortgage, buy-now-pay-later — anything you owe.'}</p>
      ) : (
        <>
          <div className="fin-total">
            <b className="num">{money(f.netWorth.debts, c)}</b>
            <span className="muted">owed{monthly > 0 ? ` · ${money(monthly, c)} a month at the minimums` : ''}</span>
          </div>
          {target && open.length > 1 && (
            <p className="fin-tip">
              Anything extra goes furthest on <b>{target.name}</b> — the highest rate, at {target.apr}%.
            </p>
          )}
          <ul className="fin-debt-list">
            {open.map((d) => {
              const due = d.nextDue ? relativeDay(d.nextDue, today) : null;
              return (
                <li key={d.id}>
                  <div className="fin-debt-top">
                    <button type="button" className="fin-debt-name" onClick={() => setEditing(d)}>
                      <b className="clamp-1">{d.name}</b>
                      <span className="faint">
                        {DEBT_LABEL[d.kind]}
                        {d.lender && ` · ${d.lender}`}
                        {d.apr !== null && ` · ${d.apr}%`}
                      </span>
                    </button>
                    <b className="num">{money(d.balance, d.currency)}</b>
                    <button type="button" className="btn btn-tint btn-sm" onClick={() => setPaying(d)}>
                      Pay
                    </button>
                  </div>
                  {d.paidOffPct !== null && <ProgressBar value={d.paidOffPct} />}
                  <div className="fin-debt-meta hint">
                    {d.paidOffPct !== null && <span>{Math.round(d.paidOffPct * 100)}% paid off</span>}
                    {d.payoff ? (
                      <span>
                        clear in {plural(d.payoff.months, 'month')} at the minimum{d.payoff.interest > 0 && `, ${money(d.payoff.interest, d.currency)} in interest`}
                      </span>
                    ) : d.minPayment ? (
                      <span className="late">the minimum doesn't cover the interest</span>
                    ) : (
                      <span>add a monthly payment to see when it clears</span>
                    )}
                    {due && <span className={cx(d.nextDue! <= today && 'late')}>due {due}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {done.length > 0 && (
        <div className="card-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setClosed((v) => !v)}>
            {closed ? 'Hide' : 'Show'} {plural(done.length, 'paid-off debt')}
          </button>
          {closed && (
            <ul className="fin-done">
              {done.map((d) => (
                <li key={d.id}>
                  <span className="grow">{d.name}</span>
                  <span className="faint">paid off {shortDay(d.closedAt!.slice(0, 10))}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {adding && <DebtSheet debt={null} currency={c} onClose={() => setAdding(false)} />}
      {editing && <DebtSheet debt={editing} currency={c} onClose={() => setEditing(null)} />}
      {paying && <PaySheet debt={paying} onClose={() => setPaying(null)} />}
    </section>
  );
}

function DebtSheet({ debt, currency, onClose }: { debt: Debt | null; currency: string; onClose: () => void }) {
  const [kind, setKind] = useState<DebtKind>(debt?.kind ?? 'credit_card');
  const [d, setD] = useState({
    name: debt?.name ?? '',
    lender: debt?.lender ?? '',
    balance: debt ? String(debt.balance) : '',
    original: debt?.original != null ? String(debt.original) : '',
    apr: debt?.apr != null ? String(debt.apr) : '',
    min: debt?.minPayment != null ? String(debt.minPayment) : '',
    due: debt?.dueDay != null ? String(debt.dueDay) : '',
  });
  const body = () => ({ name: d.name, kind, lender: d.lender, balance: parseNumber(d.balance), original: numOrNull(d.original), apr: numOrNull(d.apr), min_payment: numOrNull(d.min), due_day: numOrNull(d.due) });
  const save = useWrite(() => (debt ? financeWrite.patch(`/debts/${debt.id}`, body()) : financeWrite.post('/debts', body())));
  const remove = useWrite(() => financeWrite.del(`/debts/${debt!.id}`));
  const dueBad = d.due.trim() !== '' && !(Number.isInteger(parseNumber(d.due)) && parseNumber(d.due) >= 1 && parseNumber(d.due) <= 31);
  const wrong = bad(d.balance, d.original, d.apr, d.min, d.due);
  const cur = debt?.currency ?? currency;
  return (
    <Modal
      title={debt ? debt.name : 'Track a debt'}
      onClose={onClose}
      footer={
        <>
          {debt ? (
            <button className="btn btn-ghost btn-sm" disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: onClose })}>
              <Trash2 size={13} /> Remove
            </button>
          ) : (
            <span className="hint">In {cur}</span>
          )}
          <button className="btn btn-primary btn-sm" disabled={!d.name.trim() || !(parseNumber(d.balance) >= 0) || wrong || dueBad || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            {debt ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <div className="fin-chips" role="group" aria-label="Kind">
        {(Object.keys(DEBT_LABEL) as DebtKind[]).map((k) => (
          <button key={k} type="button" className={cx('chip', kind === k ? 'chip-tint' : 'chip-outline')} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {DEBT_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="field-row" style={{ marginTop: 14 }}>
        <Field label="Name">
          <input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Citi Rewards card" data-autofocus />
        </Field>
        <Field label="Lender">
          <input className="input" value={d.lender} onChange={(e) => setD({ ...d, lender: e.target.value })} placeholder="Citibank" />
        </Field>
      </div>
      <div className="field-row">
        <Field label={`Balance now (${cur})`}>
          <input className="input num" inputMode="decimal" value={d.balance} onChange={(e) => setD({ ...d, balance: e.target.value })} />
        </Field>
        <Field label="Started at" hint="To show how much is paid off">
          <input className="input num" inputMode="decimal" value={d.original} onChange={(e) => setD({ ...d, original: e.target.value })} placeholder={d.balance} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Interest (APR %)">
          <input className="input num" inputMode="decimal" value={d.apr} onChange={(e) => setD({ ...d, apr: e.target.value })} placeholder={kind === 'credit_card' ? '26.9' : ''} />
        </Field>
        <Field label="Monthly payment">
          <input className="input num" inputMode="decimal" value={d.min} onChange={(e) => setD({ ...d, min: e.target.value })} />
        </Field>
        <Field label="Due day">
          <input className="input num" inputMode="numeric" value={d.due} onChange={(e) => setD({ ...d, due: e.target.value })} placeholder="25" />
        </Field>
      </div>
      {(wrong || dueBad) && <p className="error-text">{dueBad && !wrong ? 'The due day is a day of the month, 1 to 31.' : NOT_A_NUMBER}</p>}
      {(save.error ?? remove.error) && <p className="error-text">{(save.error ?? remove.error)!.message}</p>}
    </Modal>
  );
}

function PaySheet({ debt, onClose }: { debt: Debt; onClose: () => void }) {
  const [amount, setAmount] = useState(debt.minPayment ? String(Math.min(debt.minPayment, debt.balance)) : '');
  const [date, setDate] = useState(todayStr());
  const save = useWrite(() => financeWrite.post(`/debts/${debt.id}/payments`, { amount: parseNumber(amount), date }));
  const removePayment = useWrite((id: string) => financeWrite.del(`/payments/${id}`));
  const a = parseNumber(amount);
  return (
    <Modal
      title={`Pay ${debt.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="hint">{a > 0 ? `${money(Math.max(0, debt.balance - a), debt.currency)} left after this` : `${money(debt.balance, debt.currency)} owed`}</span>
          <button className="btn btn-primary btn-sm" disabled={!(a > 0) || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Record payment
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label={`Amount (${debt.currency})`}>
          <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-autofocus />
        </Field>
        <Field label="Date">
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <div className="fin-chips">
        {debt.minPayment ? (
          <button type="button" className="chip chip-outline" onClick={() => setAmount(String(Math.min(debt.minPayment!, debt.balance)))}>
            Minimum {money(debt.minPayment, debt.currency)}
          </button>
        ) : null}
        <button type="button" className="chip chip-outline" onClick={() => setAmount(String(debt.balance))}>
          All of it {money(debt.balance, debt.currency)}
        </button>
      </div>
      {debt.payments.length > 0 && (
        <>
          <div className="list-label" style={{ padding: '14px 0 4px' }}>
            Recent payments
          </div>
          <ul className="fin-done">
            {debt.payments.map((p) => (
              <li key={p.id}>
                <span className="grow num">{money(p.amount, debt.currency)}</span>
                <span className="faint">{shortDay(p.date)}</span>
                <button type="button" className="icon-btn icon-btn-sm" aria-label="Take back this payment" onClick={() => removePayment.mutate(p.id, { onSuccess: onClose })}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {bad(amount) && <p className="error-text">{NOT_A_NUMBER}</p>}
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}
