// A bankruptcy case, kept straight: contributions paid to the estate with their receipts, how far
// the estate is from being settled (the annulment route) and from the contribution target, whether
// this month's contribution is in, and the approved travel windows checked against planned trips.

import { z } from 'zod';
import { registerSnapshotSection } from '../agent/snapshot-hooks.ts';
import { tool } from '../agent/tools.ts';
import { read, today as todayOf } from '../http.ts';
import { addDays, Invalid, newId, NotFound, nowIso, registerUndo, type Store } from '../store.ts';
import type { BankruptcyCase, BankruptcyPayment, BankruptcyState, TravelApproval, TripCheck } from '../../../shared/types.ts';
import { registerFeature } from './registry.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const r2 = (n: number) => Math.round(n * 100) / 100;
const KEY = 'bankruptcy';
const DEFAULTS: BankruptcyCase = {
  reference: '',
  trustee: '',
  trusteeEmail: '',
  declaredLiabilities: null,
  feesKnown: null,
  settlementQuote: null,
  monthlyContribution: null,
  targetMonths: 52,
  contributionsFrom: null,
  status: 'active',
};

export function getCase(store: Store): BankruptcyCase {
  const r = store.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  return { ...DEFAULTS, ...(r ? (JSON.parse(r.value) as Partial<BankruptcyCase>) : {}) };
}

export function updateCase(store: Store, patch: Partial<BankruptcyCase>): BankruptcyCase {
  const next = { ...getCase(store), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as BankruptcyCase;
  store.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(next));
  return next;
}

const financesId = (store: Store) => store.listSpheres().find((s) => s.key === 'finances')?.id ?? null;

// ── Payments and approvals ──────────────────────────────────────────────────

const paymentFromRow = (r: Row): BankruptcyPayment => ({ id: r.id, date: r.date, amount: r.amount, reference: r.reference, note: r.note });
const approvalFromRow = (r: Row): TravelApproval => ({ id: r.id, place: r.place, from: r.from_date, to: r.to_date, reference: r.reference, note: r.note });

export function addPayment(store: Store, p: { date: string; amount: number; reference?: string; note?: string }): BankruptcyPayment {
  if (!(p.amount > 0)) throw new Invalid('A payment above zero');
  const id = newId();
  store.db.prepare('INSERT INTO bk_payments (id, date, amount, reference, note, created_at) VALUES (?,?,?,?,?,?)').run(id, p.date, r2(p.amount), (p.reference ?? '').slice(0, 80), (p.note ?? '').slice(0, 300), nowIso());
  store.record('created', 'bk_payment', id, financesId(store), `Bankruptcy contribution: S$${p.amount.toLocaleString('en')} on ${p.date}`);
  return paymentFromRow(store.db.prepare('SELECT * FROM bk_payments WHERE id = ?').get(id) as Row);
}

export function addApproval(store: Store, a: { place?: string; from: string; to: string; reference?: string; note?: string }): TravelApproval {
  if (a.to < a.from) throw new Invalid('The approval ends before it starts');
  const id = newId();
  store.db.prepare('INSERT INTO bk_approvals (id, place, from_date, to_date, reference, note, created_at) VALUES (?,?,?,?,?,?,?)').run(id, (a.place ?? '').slice(0, 80), a.from, a.to, (a.reference ?? '').slice(0, 80), (a.note ?? '').slice(0, 300), nowIso());
  store.record('created', 'bk_approval', id, financesId(store), `Travel approval: ${a.place || 'overseas'}, ${a.from} to ${a.to}`);
  return approvalFromRow(store.db.prepare('SELECT * FROM bk_approvals WHERE id = ?').get(id) as Row);
}

registerUndo('created:bk_payment', (db, id) => void db.prepare('DELETE FROM bk_payments WHERE id = ?').run(id));
registerUndo('created:bk_approval', (db, id) => void db.prepare('DELETE FROM bk_approvals WHERE id = ?').run(id));

// ── Trips against approvals ─────────────────────────────────────────────────

/** Flights leaving before this hour are cleared at the airport the evening before. */
const EARLY_HOUR = 6;

const nice = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * When a trip really leaves and returns: the first flight's departure (the evening before, for a
 * flight before 6am, since that's when you clear immigration) and the last flight's arrival. A trip
 * without flights uses its own dates.
 */
export function tripWindow(trip: Row, flights: Row[]): { leave: string; back: string; earlyFlight: boolean } {
  if (!flights.length) return { leave: trip.start_date, back: trip.end_date, earlyFlight: false };
  const first = flights[0]!;
  const last = flights.at(-1)!;
  const departDay = String(first.start_local).slice(0, 10);
  const hour = Number(String(first.start_local).slice(11, 13));
  const earlyFlight = Number.isFinite(hour) && hour < EARLY_HOUR;
  return { leave: earlyFlight ? addDays(departDay, -1) : departDay, back: String(last.end_local).slice(0, 10), earlyFlight };
}

export function checkTrips(store: Store, today: string, approvals: TravelApproval[]): TripCheck[] {
  const trips = store.db.prepare('SELECT * FROM trips WHERE end_date >= ? ORDER BY start_date').all(today) as Row[];
  return trips.map((t) => {
    const flights = store.db.prepare("SELECT * FROM trip_segments WHERE trip_id = ? AND kind = 'flight' ORDER BY start_utc").all(t.id) as Row[];
    const { leave, back, earlyFlight } = tripWindow(t, flights);
    const covering = approvals.find((a) => a.from <= leave && a.to >= back);
    const overlapping = approvals.find((a) => a.from <= back && a.to >= leave);
    let status: TripCheck['status'] = covering ? 'covered' : overlapping ? 'outside' : 'none';
    let message: string;
    if (covering) message = `Covered by the approval for ${nice(covering.from)} to ${nice(covering.to)}.`;
    else if (overlapping) {
      const gaps = [overlapping.from > leave ? `you leave ${nice(leave)}${earlyFlight ? ' (an early flight: you clear the airport the evening before)' : ''} but approval starts ${nice(overlapping.from)}` : '', overlapping.to < back ? `you're back ${nice(back)} but approval ends ${nice(overlapping.to)}` : ''].filter(Boolean);
      message = `Outside the approval: ${gaps.join('; ')}. Ask your trustee to amend it before you go.`;
    } else {
      status = 'none';
      message = `No approval on file for ${nice(leave)} to ${nice(back)}${earlyFlight ? ' (counting the evening before your early flight)' : ''}. Get it approved before you travel.`;
    }
    return { tripId: t.id, title: t.title, leave, back, earlyFlight, status, message };
  });
}

// ── The whole picture ───────────────────────────────────────────────────────

const monthsBetween = (fromYm: string, toYm: string) => {
  const [fy, fm] = fromYm.split('-').map(Number) as [number, number];
  const [ty, tm] = toYm.split('-').map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm) + 1;
};

export function bankruptcyState(store: Store, today: string): BankruptcyState {
  const c = getCase(store);
  const payments = (store.db.prepare('SELECT * FROM bk_payments ORDER BY date DESC, created_at DESC').all() as Row[]).map(paymentFromRow);
  const approvals = (store.db.prepare('SELECT * FROM bk_approvals ORDER BY from_date DESC').all() as Row[]).map(approvalFromRow);
  const paid = r2(payments.reduce((n, p) => n + p.amount, 0));
  const active = !!(c.reference || c.declaredLiabilities || payments.length);
  const settleTarget = c.settlementQuote ? c.settlementQuote.amount : c.declaredLiabilities !== null ? c.declaredLiabilities + (c.feesKnown ?? 0) : null;
  const month = today.slice(0, 7);
  const months = c.contributionsFrom && c.contributionsFrom <= month ? monthsBetween(c.contributionsFrom, month) : 0;
  const expected = c.monthlyContribution ? r2(Math.min(months, c.targetMonths) * c.monthlyContribution) : 0;
  return {
    active,
    case: c,
    paid,
    payments,
    settlement: settleTarget === null ? null : { target: r2(settleTarget), estimated: !c.settlementQuote, remaining: r2(Math.max(0, settleTarget - paid)) },
    contribution: c.monthlyContribution ? { target: r2(c.monthlyContribution * c.targetMonths), remaining: r2(Math.max(0, c.monthlyContribution * c.targetMonths - paid)) } : null,
    schedule: c.monthlyContribution && c.contributionsFrom ? { months, expected, behind: r2(Math.max(0, expected - paid)) } : null,
    thisMonth: c.monthlyContribution ? { due: c.monthlyContribution, paid: r2(payments.filter((p) => p.date.slice(0, 7) === month).reduce((n, p) => n + p.amount, 0)) } : null,
    approvals,
    trips: c.status === 'active' ? checkTrips(store, today, approvals) : [],
  };
}

// ── Agent ───────────────────────────────────────────────────────────────────

const money = (n: number) => `S$${n.toLocaleString('en', { maximumFractionDigits: 2 })}`;

registerSnapshotSection<Store>('Bankruptcy', (store, today) => {
  const s = bankruptcyState(store, today);
  if (!s.active || s.case.status !== 'active') return null;
  const parts = [`Bankruptcy case ${s.case.reference || ''} with ${s.case.trustee || 'a trustee'}: ${money(s.paid)} paid in contributions.`];
  if (s.settlement) parts.push(`${s.settlement.estimated ? 'Estimated' : 'Quoted'} left to settle the estate (annulment): ${money(s.settlement.remaining)}${s.settlement.estimated ? ' before fees not yet known' : ''}.`);
  if (s.thisMonth) parts.push(`This month: ${money(s.thisMonth.paid)} of ${money(s.thisMonth.due)} recorded.`);
  const bad = s.trips.filter((t) => t.status !== 'covered');
  if (bad.length) parts.push(`Trips without matching travel approval: ${bad.map((t) => `${t.title} (${t.leave} to ${t.back})`).join('; ')}. Remind them before they travel.`);
  return parts.join(' ');
});

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const caseInput = z.object({
  reference: z.string().max(60).optional(),
  trustee: z.string().max(80).optional(),
  trustee_email: z.string().max(120).optional(),
  declared_liabilities: z.number().min(0).max(1e9).nullable().optional(),
  fees_known: z.number().min(0).max(1e9).nullable().optional(),
  settlement_quote: z.object({ amount: z.number().min(0).max(1e9), as_of: date }).nullable().optional(),
  monthly_contribution: z.number().min(0).max(1e7).nullable().optional(),
  target_months: z.number().int().min(1).max(240).optional(),
  contributions_from: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  status: z.enum(['active', 'annulled', 'discharged']).optional(),
});
const toCase = (i: z.infer<typeof caseInput>): Partial<BankruptcyCase> => ({
  reference: i.reference,
  trustee: i.trustee,
  trusteeEmail: i.trustee_email,
  declaredLiabilities: i.declared_liabilities,
  feesKnown: i.fees_known,
  settlementQuote: i.settlement_quote === undefined ? undefined : i.settlement_quote && { amount: i.settlement_quote.amount, asOf: i.settlement_quote.as_of },
  monthlyContribution: i.monthly_contribution,
  targetMonths: i.target_months,
  contributionsFrom: i.contributions_from,
  status: i.status,
});
const paymentInput = z.object({ date, amount: z.number().positive().max(1e9), reference: z.string().max(80).optional(), note: z.string().max(300).optional() });
const approvalInput = z.object({ place: z.string().max(80).optional(), from: date, to: date, reference: z.string().max(80).optional(), note: z.string().max(300).optional() });

registerFeature({
  id: 'bankruptcy',
  tables: ['bk_payments', 'bk_approvals'],
  tools: [
    tool(
      'get_bankruptcy_case',
      "The user's bankruptcy case: contributions paid (with receipt references), how much is left to settle the estate (the trustee's quote, or an estimate from declared liabilities plus known fees), progress to the contribution target, this month's contribution, how far behind the monthly schedule it is, approved travel windows, and upcoming trips checked against them.",
      z.object({}),
      (_i, { store, today }) => ({ data: bankruptcyState(store, today), summary: 'Read the bankruptcy case' }),
    ),
    tool(
      'set_bankruptcy_case',
      "Set the case's figures: reference, trustee and their email, declared liabilities (Statement of Affairs), known trustee/estate fees, the trustee's settlement quote for annulment (amount and as-of date) once they give one, the monthly contribution, target months (52 for a first-time bankrupt), the first month contributions were due (YYYY-MM), and status (annulled or discharged when it ends).",
      caseInput,
      (i, { store }) => ({ data: updateCase(store, toCase(i)), summary: 'Updated the bankruptcy case' }),
    ),
    tool(
      'record_bankruptcy_payment',
      'Record a contribution paid to the bankruptcy estate, with its date, amount and the receipt or transaction reference.',
      paymentInput,
      (p, { store }) => {
        const saved = addPayment(store, p);
        return { data: saved, summary: `Recorded a bankruptcy contribution: ${money(saved.amount)}` };
      },
    ),
    tool(
      'add_travel_approval',
      "Record an overseas travel approval from the trustee: where, the approved dates, and its reference. Upcoming trips are checked against these; a trip leaving before 6am counts from the evening before, when they'd clear the airport.",
      approvalInput,
      (a, { store }) => {
        const saved = addApproval(store, a);
        return { data: saved, summary: `Recorded a travel approval: ${saved.from} to ${saved.to}` };
      },
    ),
  ],
  routes: (app, { store }) => {
    const state = (c: Parameters<typeof todayOf>[0]) => bankruptcyState(store, todayOf(c));
    app.get('/api/bankruptcy', (c) => c.json(state(c)));
    app.put('/api/bankruptcy', async (c) => {
      updateCase(store, toCase(await read(c, caseInput)));
      return c.json(state(c));
    });
    app.post('/api/bankruptcy/payments', async (c) => {
      addPayment(store, await read(c, paymentInput));
      return c.json(state(c), 201);
    });
    app.delete('/api/bankruptcy/payments/:id', (c) => {
      if (store.db.prepare('DELETE FROM bk_payments WHERE id = ?').run(c.req.param('id')).changes === 0) throw new NotFound('Payment');
      return c.json(state(c));
    });
    app.post('/api/bankruptcy/approvals', async (c) => {
      addApproval(store, await read(c, approvalInput));
      return c.json(state(c), 201);
    });
    app.delete('/api/bankruptcy/approvals/:id', (c) => {
      if (store.db.prepare('DELETE FROM bk_approvals WHERE id = ?').run(c.req.param('id')).changes === 0) throw new NotFound('Approval');
      return c.json(state(c));
    });
  },
});
