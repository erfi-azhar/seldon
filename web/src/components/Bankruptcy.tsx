// The bankruptcy card on Finances: how close the estate is to settled, this month's contribution,
// the schedule, payments with receipts, and travel approvals checked against planned trips.

import { AlertTriangle, Check, ChevronRight, Mail, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
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

/** A ready-to-send email asking the trustee for the figures that decide the way out. */
function statementRequest(c: BankruptcyCase): string {
  const subject = `Statement of account${c.reference ? ` – ${c.reference}` : ''}`;
  const body = [
    'Dear Sir/Madam,',
    '',
    `I would like a statement of account for my bankruptcy${c.reference ? ` (${c.reference})` : ''} as at today, showing:`,
    '',
    '1. All contributions credited to the estate, with dates and amounts.',
    '2. Any contribution arrears.',
    '3. The admitted creditor claims.',
    '4. Trustee remuneration and estate expenses to date.',
    '5. The amount needed to fund an annulment application, and the steps and timing after payment.',
    '6. Any restrictions currently recorded against the case.',
    '',
    'Thank you.',
  ].join('\n');
  return `mailto:${encodeURIComponent(c.trusteeEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function BankruptcyCard() {
  const { data: b } = useBankruptcy();
  useAmountsHidden();
  const [sheet, setSheet] = useState<'case' | 'pay' | 'approve' | null>(null);
  const unpay = useWrite(bankruptcyWrite.unpay);
  const unapprove = useWrite(bankruptcyWrite.unapprove);
  if (!b?.active) return null;
  const c = b.case;
  const closed = c.status !== 'active';
  const today = todayStr();
  const due = b.thisMonth;
  const owing = due && due.paid < due.due;

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

      {closed ? (
        <p className="empty">The case is {c.status}. {S(b.paid)} was paid in contributions.</p>
      ) : (
        <>
          {b.settlement && (
            <div className="bk-settle">
              <div className="bk-settle-line">
                {b.settlement.remaining <= 0 && b.settlement.estimated ? (
                  <>
                    <b className="bk-covered">Declared debts covered</b>
                    <span className="muted">fees still to confirm: ask for the settlement figure</span>
                  </>
                ) : (
                  <>
                    <b className="num">{S(b.settlement.remaining)}</b>
                    <span className="muted">{b.settlement.remaining <= 0 ? 'left: the quoted amount is paid' : 'left to settle the estate'}</span>
                  </>
                )}
                <span className={cx('chip', b.settlement.estimated ? 'chip-outline' : 'chip-tint')} title={b.settlement.estimated ? 'From the declared liabilities and any fees you know of. Ask your trustee for the real figure.' : undefined}>
                  {b.settlement.estimated ? (c.feesKnown === null ? 'estimate · before fees' : 'estimate') : `quoted ${shortDay(c.settlementQuote!.asOf)}`}
                </span>
              </div>
              <ProgressBar value={b.settlement.target ? b.paid / b.settlement.target : 0} />
              <span className="hint">
                {S(b.paid)} paid of {S(b.settlement.target)} {b.settlement.estimated ? 'declared' : 'quoted'}
              </span>
            </div>
          )}

          <div className="bk-stats">
            {due && (
              <div className={cx(owing && 'is-owing')}>
                <span className="fin-label">This month</span>
                <b className="num">{S(due.paid)}</b>
                <span className="hint">of {S(due.due)} {due.paid >= due.due ? 'paid' : 'due'}</span>
                <button type="button" className="btn btn-tint btn-sm" onClick={() => setSheet('pay')}>
                  <Plus size={13} /> Record
                </button>
              </div>
            )}
            {b.schedule && (
              <div className={cx(b.schedule.behind > 0 && 'is-owing')} title={`${plural(b.schedule.months, 'month')} at ${S(c.monthlyContribution ?? 0)} since ${c.contributionsFrom}: ${S(b.schedule.expected)} expected`}>
                <span className="fin-label">Behind schedule</span>
                <b className="num">{S(b.schedule.behind)}</b>
                <span className="hint">vs {S(b.schedule.expected)} due so far</span>
              </div>
            )}
            {b.contribution && (
              <div>
                <span className="fin-label">Contribution target</span>
                <b className="num">{Math.round((b.paid / b.contribution.target) * 100)}%</b>
                <span className="hint">of {S(b.contribution.target)}</span>
              </div>
            )}
          </div>

          <div className="bk-section">
            <div className="list-label bk-section-head">
              <span>Travel</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSheet('approve')}>
                <Plus size={13} /> Approval
              </button>
            </div>
            {b.trips.length === 0 ? (
              <p className="hint bk-pad">No upcoming trips. Get each one approved, with a day's margin at both ends.</p>
            ) : (
              <ul className="bk-trips">
                {b.trips.map((t) => (
                  <li key={t.tripId} className={cx(`is-${t.status}`)}>
                    {t.status === 'covered' ? <Check size={14} className="bk-ok" aria-hidden /> : <AlertTriangle size={14} className="bk-warn" aria-hidden />}
                    <span className="grow">
                      <b>{t.title}</b> <span className="faint">{shortDay(t.leave)} – {shortDay(t.back)}</span>
                      <span className="bk-trip-msg">{t.message}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
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
          </div>

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
                  <span className="grow">
                    <span className="num">{S(p.amount)}</span> <span className="faint">{shortDay(p.date)}{p.date.slice(0, 4) !== today.slice(0, 4) ? ` ${p.date.slice(0, 4)}` : ''}{p.reference ? ` · ${p.reference}` : ''}</span>
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
                <Mail size={13} /> Ask {c.trustee || 'the trustee'} for a statement of account
              </a>
            ) : (
              <span className="hint">Add your trustee's email to ask for a statement of account in one tap.</span>
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
