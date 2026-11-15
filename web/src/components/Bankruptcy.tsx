// The bankruptcy card on Finances: how close the estate is to settled, this month's contribution,
// the schedule, payments with receipts, and travel approvals checked against planned trips.

import { AlertTriangle, Check, ChevronRight, Mail, Pencil, Plus, Trash2 } from 'lucide-react';
import { Fragment, useState, type CSSProperties } from 'react';
import type { BankruptcyCase, BankruptcyState } from '../../../shared/types.ts';
import { bankruptcyWrite, useBankruptcy, useWrite } from '../api.ts';
import { cx, parseNumber, plural, shortDay, todayStr } from '../lib.ts';
import { useAmountsHidden } from '../privacy.ts';
import { money } from './Finance.tsx';
import { Field, Modal, ProgressBar } from './ui.tsx';

/** Whole dollars read more easily here; the payments list keeps any cents. */
const S = (n: number) => money(n, 'SGD').replace(/\.00$/, '');
const numOrNull = (s: string) => (s.trim() === '' ? null : parseNumber(s));
const bad = (...xs: string[]) => xs.some((s) => s.trim() !== '' && Number.isNaN(parseNumber(s)));

/**
 * A ready-to-send email asking the trustee for what decides the way out: the proved debts and the
 * bankruptcy expenses, which are what an annulment on full payment needs paid (section 393 IRDA),
 * net of what the estate already holds.
 */
function statementRequest(c: BankruptcyCase): string {
  const ref = c.reference ? ` – ${c.reference}` : '';
  const subject = `Request for full-payment annulment assessment (section 393 IRDA)${ref}`;
  const body = [
    'Dear Sir/Madam,',
    '',
    `I would like to know what is needed to annul my bankruptcy${c.reference ? ` (${c.reference})` : ''} on full payment under section 393 of the Insolvency, Restructuring and Dissolution Act 2018. Could you please let me have:`,
    '',
    '1. The creditors who have filed proofs of debt, with the amounts claimed and admitted.',
    '2. Trustee remuneration and other bankruptcy expenses, incurred and expected.',
    '3. A statement of all contributions received and credited to the estate, and any other funds it holds.',
    '4. The exact amount still needed for the proved debts and expenses to be paid in full.',
    '5. Anything else outstanding that would hold up an annulment, including any contribution arrears.',
    '6. The steps and timing once that amount is paid, and how removal from the Insolvency Search will be confirmed.',
    '',
    'Thank you.',
  ].join('\n');
  return `mailto:${encodeURIComponent(c.trusteeEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

const MONTH_LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const monthAt = (fromYm: string, i: number) => {
  const [y, m] = fromYm.split('-').map(Number) as [number, number];
  const n = y * 12 + (m - 1) + i;
  return { year: Math.floor(n / 12), month: n % 12 };
};
const monthName = (year: number, month: number, style: 'long' | 'short' = 'long') => new Date(Date.UTC(year, month, 15)).toLocaleDateString('en-GB', { month: style, year: 'numeric', timeZone: 'UTC' });
const daysUntil = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const inDays = (n: number) => (n <= 0 ? 'now' : n === 1 ? 'tomorrow' : `in ${n} days`);
const tenths = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en', { maximumFractionDigits: 1 });

export function BankruptcyCard() {
  const { data: b } = useBankruptcy();
  useAmountsHidden();
  const [sheet, setSheet] = useState<'case' | 'pay' | 'approve' | null>(null);
  const unpay = useWrite(bankruptcyWrite.unpay);
  const unapprove = useWrite(bankruptcyWrite.unapprove);
  if (!b?.active) return null;
  const c = b.case;
  const today = todayStr();

  return (
    <section className="card bk-card">
      <div className="card-head">
        <h2 className="card-title">
          Bankruptcy {c.reference && <span className="faint bk-ref">{c.reference}</span>}
        </h2>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Edit the case" title="Edit the case" onClick={() => setSheet('case')}>
          <Pencil size={13} />
        </button>
      </div>

      {c.status !== 'active' ? (
        <p className="empty">The case is {c.status}. {S(b.paid)} was paid in contributions.</p>
      ) : (
        <>
          <Settle b={b} />
          <Contributions b={b} today={today} onRecord={() => setSheet('pay')} />
          <Travel b={b} today={today} onApprove={() => setSheet('approve')} />

          {b.approvals.length > 0 && (
            <details className="todo-fold">
              <summary>
                <ChevronRight size={14} className="todo-fold-chev" aria-hidden />
                <span className="grow">Approvals on file</span>
                <span className="todo-fold-meta">{b.approvals.length}</span>
              </summary>
              <ul className="bk-list">
                {b.approvals.map((a) => (
                  <li key={a.id}>
                    <span className="grow">
                      {a.place || 'Overseas'} <span className="faint">{shortDay(a.from)} – {shortDay(a.to)}{a.to < today ? ' · past' : ''}{a.reference ? ` · ${a.reference}` : ''}</span>
                    </span>
                    <button type="button" className="icon-btn icon-btn-sm" aria-label="Remove this approval" onClick={() => unapprove.mutate(a.id)}>
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <details className="todo-fold">
            <summary>
              <ChevronRight size={14} className="todo-fold-chev" aria-hidden />
              <span className="grow">Payments</span>
              <span className="todo-fold-meta">
                {plural(b.payments.length, 'payment')} · {S(b.paid)}
              </span>
            </summary>
            <ul className="bk-list">
              {b.payments.map((p) => (
                <li key={p.id}>
                  <span className="num bk-pay-amt">{S(p.amount)}</span>
                  <span className="grow faint">
                    {shortDay(p.date)}
                    {p.date.slice(0, 4) !== today.slice(0, 4) ? ` ${p.date.slice(0, 4)}` : ''}
                    {p.reference ? ` · ${p.reference}` : ''}
                  </span>
                  <button type="button" className="icon-btn icon-btn-sm" aria-label="Remove this payment" onClick={() => unpay.mutate(p.id)}>
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          </details>

          <div className="bk-foot">
            {c.trusteeEmail ? (
              <a className="btn btn-ghost btn-sm" href={statementRequest(c)}>
                <Mail size={13} /> Ask {c.trustee || 'the trustee'} what it takes to annul
              </a>
            ) : (
              <span className="hint">Add your trustee's email to ask what it takes to annul, in one tap.</span>
            )}
          </div>
        </>
      )}
      {sheet === 'case' && <CaseSheet b={b} onClose={() => setSheet(null)} />}
      {sheet === 'pay' && <PaySheet monthly={c.monthlyContribution} onClose={() => setSheet(null)} />}
      {sheet === 'approve' && <ApproveSheet onClose={() => setSheet(null)} />}
    </section>
  );
}

/**
 * The two ways out on one bar. It runs to the full contribution term (monthly × target months),
 * fills with what's been paid, and marks the amount that settles the estate: the declared
 * liabilities (plus known fees), or the trustee's quote once there is one.
 */
function Settle({ b }: { b: BankruptcyState }) {
  const s = b.settlement;
  if (!s) return null;
  const c = b.case;
  const covered = s.remaining <= 0;
  // A quote is what's left to pay; on the bar it sits on top of what's already been paid.
  const settleAt = s.estimated ? s.target : b.paid + s.target;
  const full = b.contribution?.target ?? 0;
  const scale = Math.max(full, settleAt, b.paid) || 1;
  const pct = (n: number) => Math.min(100, (n / scale) * 100);
  const end = c.contributionsFrom ? monthAt(c.contributionsFrom, c.targetMonths - 1) : null;
  return (
    <div className="bk-settle">
      <div className="bk-settle-line">
        {covered && s.estimated ? <b className="bk-covered">Declared debts covered</b> : <b className="num">{S(s.remaining)}</b>}
        <span className="muted">{covered ? (s.estimated ? 'ask for the settlement figure, with fees' : 'the quoted amount is paid') : 'left to settle in full'}</span>
        <span className={cx('chip', s.estimated ? 'chip-outline' : 'chip-tint')} title={s.estimated ? 'From the declared liabilities and any fees you know of. Ask your trustee for the real figure.' : undefined}>
          {s.estimated ? (c.feesKnown === null ? 'estimate, before fees' : 'estimate') : `quoted ${shortDay(c.settlementQuote!.asOf)}`}
        </span>
      </div>
      {full > 0 ? (
        <div className="bk-bar">
          <div className="bk-bar-row is-top">
            <Mark at={pct(settleAt)} label={s.estimated ? (c.feesKnown === null ? 'Declared' : 'Declared + fees') : 'Settlement'} value={S(settleAt)} />
            <Mark at={100} label={`Target${end ? ` · ${monthName(end.year, end.month, 'short')}` : ''}`} value={S(full)} />
          </div>
          <div className="bk-track" role="img" aria-label={`${S(b.paid)} paid. ${S(settleAt)} settles the estate; the contribution target for discharge is ${S(full)}.`}>
            <i className="bk-fill" style={{ width: `${pct(b.paid)}%` }} />
            <i className="bk-tick" style={{ left: `${pct(settleAt)}%` }} />
          </div>
          <div className="bk-bar-row">
            <Mark at={pct(b.paid)} label="Paid" value={S(b.paid)} strong />
          </div>
        </div>
      ) : (
        <ProgressBar value={s.target ? Math.min(1, b.paid / s.target) : 0} />
      )}
      <span className="hint">
        Paying the proved debts and expenses ends the case by annulment{s.estimated ? ' (the declared figure stands in until the trustee confirms them)' : ''}.
        {full > 0 && ` The ${S(full)} target is for discharge instead, which comes no sooner than three years in.`}
      </span>
    </div>
  );
}

/** A label pinned to a point on the bar, sliding so it never runs off either end. */
function Mark({ at, label, value, strong }: { at: number; label: string; value: string; strong?: boolean }) {
  return (
    <span className={cx('bk-mark', strong && 'is-strong')} style={{ left: `${at}%`, transform: `translateX(-${at}%)` }}>
      <span className="bk-mark-l">{label}</span>
      <span className="num">{value}</span>
    </span>
  );
}

/**
 * The monthly contributions as a calendar: one cell per month of the target, a row per year,
 * filled as far as the money paid reaches. Months that were due and aren't covered show red, so
 * how far behind (and why) reads at a glance.
 */
function Contributions({ b, today, onRecord }: { b: BankruptcyState; today: string; onRecord: () => void }) {
  const c = b.case;
  const sch = b.schedule;
  const monthly = c.monthlyContribution;
  if (!monthly) return null;
  const head = (
    <div className="bk-section-head">
      <span className="fin-label">Monthly contributions</span>
      <button type="button" className="btn btn-tint btn-sm" onClick={onRecord}>
        <Plus size={13} /> Record
      </button>
    </div>
  );
  if (!sch || !c.contributionsFrom) {
    return (
      <div className="bk-section">
        {head}
        <p className="hint bk-pad">Set the first month contributions were due to see the schedule.</p>
      </div>
    );
  }
  const from = c.contributionsFrom;
  const worth = b.paid / monthly; // months' worth paid
  const due = Math.min(sch.months, c.targetMonths);
  const first = monthAt(from, 0);
  const now = monthAt(from, sch.months - 1);
  const thisMonth = b.thisMonth;
  const nowName = new Date(Date.UTC(now.year, now.month, 15)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  const lastOut = sch.months >= 2 ? monthAt(from, sch.months - 2) : null;

  const rows: { year: number; cells: ({ i: number; fill: number; state: 'paid' | 'behind' | 'now' | 'later'; label: string } | null)[] }[] = [];
  for (let i = 0; i < c.targetMonths; i++) {
    const { year, month } = monthAt(from, i);
    let row = rows.at(-1);
    if (!row || row.year !== year) rows.push((row = { year, cells: Array(12).fill(null) }));
    const fill = Math.max(0, Math.min(1, worth - i));
    const state = fill >= 1 ? 'paid' : i < due - 1 ? 'behind' : i === due - 1 && i === sch.months - 1 ? 'now' : 'later';
    const label = `${monthName(year, month)}: ${fill >= 1 ? 'paid' : fill > 0 ? `${Math.round(fill * 100)}% paid` : state === 'behind' ? 'not paid' : state === 'now' ? 'due this month' : 'to come'}`;
    row.cells[month] = { i, fill, state, label };
  }

  return (
    <div className="bk-section">
      {head}
      <div className="bk-sched-line">
        {sch.behind > 0 ? (
          <>
            <b className="num is-bad">{S(sch.behind)}</b>
            <span className="muted">behind, counting {nowName}</span>
          </>
        ) : (
          <>
            <b className="bk-covered">On schedule</b>
            {worth > due && <span className="muted">{tenths(worth - due)} months ahead</span>}
          </>
        )}
      </div>
      <div className="bk-cal" role="img" aria-label={`${tenths(worth)} months' contributions paid of ${due} due so far, out of ${c.targetMonths}`}>
        <span />
        {MONTH_LETTERS.map((l, i) => (
          <span key={i} className="bk-cal-m">
            {l}
          </span>
        ))}
        {rows.map((r) => (
          <Fragment key={r.year}>
            <span className="bk-cal-y">{r.year}</span>
            {r.cells.map((cell, m) =>
              cell ? <span key={m} className={cx('bk-cell', `is-${cell.state}`)} style={{ '--fill': cell.fill } as CSSProperties} title={cell.label} /> : <span key={m} />,
            )}
          </Fragment>
        ))}
      </div>
      <ul className="bk-why">
        <li>
          <span className="bk-key is-paid" aria-hidden />
          <span>
            <b className="num">{S(b.paid)}</b> paid, enough for {tenths(worth)} of the {due} months due since {monthName(first.year, first.month)}
          </span>
        </li>
        {sch.overdue > 0 && lastOut && (
          <li>
            <span className="bk-key is-behind" aria-hidden />
            <span>
              <b className="num">{S(sch.overdue)}</b> overdue, for months up to {monthName(lastOut.year, lastOut.month, 'short')}
            </span>
          </li>
        )}
        {thisMonth && (
          <li>
            <span className="bk-key is-now" aria-hidden />
            <span>
              {thisMonth.paid >= thisMonth.due ? (
                <>
                  {nowName}'s <b className="num">{S(thisMonth.due)}</b> is in
                </>
              ) : (
                <>
                  <b className="num">{S(thisMonth.due - thisMonth.paid)}</b> due for {nowName}
                  {thisMonth.paid > 0 && `, ${S(thisMonth.paid)} in so far`}
                </>
              )}
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}

const TRAVEL_KEY = 'terminus:bk-travel-closed';
const readClosed = () => {
  try {
    return localStorage.getItem(TRAVEL_KEY) === '1';
  } catch {
    return false;
  }
};

/** Upcoming trips against the approvals on file, folding away to a one-line summary. */
function Travel({ b, today, onApprove }: { b: BankruptcyState; today: string; onApprove: () => void }) {
  const [closed, setClosed] = useState(readClosed);
  const toggle = () => {
    const next = !closed;
    setClosed(next);
    try {
      if (next) localStorage.setItem(TRAVEL_KEY, '1');
      else localStorage.removeItem(TRAVEL_KEY);
    } catch {
      // Blocked storage: it still holds for this visit.
    }
  };
  const open = b.trips.filter((t) => t.status !== 'covered');
  const next = open[0];
  return (
    <div className={cx('bk-section bk-travel', closed && 'is-closed')}>
      <div className="bk-section-head">
        <button type="button" className="bk-fold" aria-expanded={!closed} onClick={toggle}>
          <ChevronRight size={14} className="bk-fold-chev" aria-hidden />
          <span className="fin-label">Travel</span>
          {open.length > 0 ? (
            <span className="chip chip-bad">{open.length} need approval</span>
          ) : b.trips.length > 0 ? (
            <span className="chip chip-good">
              <Check size={12} aria-hidden /> All approved
            </span>
          ) : null}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onApprove}>
          <Plus size={13} /> Approval
        </button>
      </div>
      {!closed &&
        (b.trips.length === 0 ? (
          <p className="hint bk-pad">No upcoming trips. Get each one approved, with a day's margin at both ends.</p>
        ) : (
          <>
            {next && (
              <p className="bk-alert">
                <AlertTriangle size={14} aria-hidden />
                <span>
                  {open.length === 1 ? 'This trip needs' : `These ${open.length} trips need`} approval before you go. {open.length === 1 ? 'It leaves' : `The first, ${next.title}, leaves`} {inDays(daysUntil(today, next.leave))}.
                </span>
              </p>
            )}
            <ul className="bk-trips">
              {b.trips.map((t) => (
                <li key={t.tripId} className={cx(`is-${t.status}`)}>
                  <span className="bk-trip-main">
                    <b>{t.title}</b>
                    <span className="faint">
                      {shortDay(t.leave)} – {shortDay(t.back)} · {inDays(daysUntil(today, t.leave))}
                    </span>
                    {t.status === 'outside' && <span className="bk-trip-msg">{t.message.replace(/^Outside the approval: /, '')}</span>}
                    {t.status === 'none' && t.earlyFlight && <span className="bk-trip-msg">Early flight: approval should start the evening before.</span>}
                  </span>
                  <span className={cx('chip', t.status === 'covered' ? 'chip-good' : 'chip-bad')}>
                    {t.status === 'covered' && <Check size={12} aria-hidden />}
                    {t.status === 'covered' ? 'Approved' : t.status === 'outside' ? 'Dates outside' : 'No approval'}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ))}
    </div>
  );
}

/** The quiet way in, at the foot of the Debts card, for anyone with a case to track. */
export function TrackCaseLink() {
  const { data: b } = useBankruptcy();
  const [open, setOpen] = useState(false);
  if (!b || b.active) return null;
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        In bankruptcy or a court repayment plan? Track the case
      </button>
      {open && <CaseSheet b={b} onClose={() => setOpen(false)} />}
    </>
  );
}

export function CaseSheet({ b, onClose }: { b: BankruptcyState; onClose: () => void }) {
  const c = b.case;
  const s = (n: number | null) => (n === null ? '' : String(n));
  const [f, setF] = useState({
    reference: c.reference,
    trustee: c.trustee,
    email: c.trusteeEmail,
    declared: s(c.declaredLiabilities),
    monthly: s(c.monthlyContribution),
    from: c.contributionsFrom ?? '',
    months: String(c.targetMonths),
    fees: s(c.feesKnown),
    quote: s(c.settlementQuote?.amount ?? null),
    quoteAsOf: c.settlementQuote?.asOf ?? todayStr(),
    status: c.status,
  });
  const save = useWrite(() =>
    bankruptcyWrite.setCase({
      reference: f.reference.trim(),
      trustee: f.trustee.trim(),
      trustee_email: f.email.trim(),
      declared_liabilities: numOrNull(f.declared),
      monthly_contribution: numOrNull(f.monthly),
      contributions_from: f.from || null,
      target_months: Math.max(1, Math.round(parseNumber(f.months) || 52)),
      fees_known: numOrNull(f.fees),
      settlement_quote: numOrNull(f.quote) === null ? null : { amount: numOrNull(f.quote), as_of: f.quoteAsOf },
      status: f.status,
    }),
  );
  const wrong = bad(f.declared, f.monthly, f.months, f.fees, f.quote);
  return (
    <Modal
      title="The case"
      onClose={onClose}
      footer={
        <>
          <span className="hint">In S$. Kept in your own Terminus.</span>
          <button className="btn btn-primary btn-sm" disabled={wrong || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Save
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Case reference">
          <input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="HC/B/1234/2023" data-autofocus />
        </Field>
        <Field label="Trustee">
          <input className="input" value={f.trustee} onChange={(e) => setF({ ...f, trustee: e.target.value })} placeholder="Official Assignee, or a private trustee" />
        </Field>
        <Field label="Trustee's email">
          <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Declared liabilities" hint="From your Statement of Affairs">
          <input className="input num" inputMode="decimal" value={f.declared} onChange={(e) => setF({ ...f, declared: e.target.value })} />
        </Field>
        <Field label="Monthly contribution">
          <input className="input num" inputMode="decimal" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} />
        </Field>
        <Field label="Contributions from" hint="The first month they were due">
          <input className="input" type="month" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </Field>
        <Field label="Target (months)" hint="52 for a first bankruptcy">
          <input className="input num" inputMode="numeric" value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Fees known" hint="Trustee and estate fees, once you know them">
          <input className="input num" inputMode="decimal" value={f.fees} onChange={(e) => setF({ ...f, fees: e.target.value })} />
        </Field>
        <Field label="Settlement quote" hint="The trustee's figure to settle the estate in full">
          <input className="input num" inputMode="decimal" value={f.quote} onChange={(e) => setF({ ...f, quote: e.target.value })} />
        </Field>
        <Field label="Quote as of">
          <input className="input" type="date" value={f.quoteAsOf} onChange={(e) => setF({ ...f, quoteAsOf: e.target.value })} />
        </Field>
        <Field label="Status">
          <select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as BankruptcyCase['status'] })}>
            <option value="active">Active</option>
            <option value="annulled">Annulled</option>
            <option value="discharged">Discharged</option>
          </select>
        </Field>
      </div>
      {wrong && <p className="error-text">Enter numbers only.</p>}
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

function PaySheet({ monthly, onClose }: { monthly: number | null; onClose: () => void }) {
  const [f, setF] = useState({ date: todayStr(), amount: monthly ? String(monthly) : '', reference: '' });
  const save = useWrite(() => bankruptcyWrite.pay({ date: f.date, amount: parseNumber(f.amount), reference: f.reference.trim() }));
  return (
    <Modal
      title="Record a contribution"
      onClose={onClose}
      footer={
        <>
          <span className="hint">Keep the receipt; send your trustee proof without waiting to be asked.</span>
          <button className="btn btn-primary btn-sm" disabled={!(parseNumber(f.amount) > 0) || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Record
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Amount (S$)">
          <input className="input num" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} data-autofocus />
        </Field>
        <Field label="Paid on">
          <input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label="Receipt or transaction reference">
          <input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </Field>
      </div>
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

function ApproveSheet({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ place: '', from: todayStr(), to: todayStr(), reference: '' });
  const save = useWrite(() => bankruptcyWrite.approve({ place: f.place.trim(), from: f.from, to: f.to, reference: f.reference.trim() }));
  return (
    <Modal
      title="Travel approval"
      onClose={onClose}
      footer={
        <>
          <span className="hint">Trips in Terminus are checked against it.</span>
          <button className="btn btn-primary btn-sm" disabled={!f.from || !f.to || f.to < f.from || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Add
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Where">
          <input className="input" value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} placeholder="Vietnam" data-autofocus />
        </Field>
        <Field label="Approved from">
          <input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </Field>
        <Field label="Approved to">
          <input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </Field>
        <Field label="Reference">
          <input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </Field>
      </div>
      <p className="hint">For a flight before 6am, ask for approval from the day before: you clear the airport that evening.</p>
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}
