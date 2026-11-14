// Health screenings: two check-ups side by side — what changed, what it means, what to
// do next. The record is one JSON document you import; nothing here is hard-coded.

import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Check, Minus, Plus, Sparkles, TriangleAlert, Upload } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import type { ScreenResult, Screenings as Doc, ScreenStatus, ScreenTrend } from '../../../shared/types.ts';
import { api, useWrite, write } from '../api.ts';
import { Loading, Seg } from '../components/ui.tsx';
import { cx, hueStyle, parseDay } from '../lib.ts';
import { useApp } from '../state.tsx';

export const useScreenings = () => useQuery({ queryKey: ['screenings'], queryFn: () => api<Doc | null>('GET', '/screenings') });

type Row = ScreenResult & { s25: ScreenStatus; s: ScreenStatus; v: ScreenTrend; ref: string };

const num = (s: string | null): number | null => (s != null && /^\d+(\.\d+)?\*?$/.test(s) ? parseFloat(s) : null);
const decimals = (s: string): number => s.replace('*', '').match(/\.(\d+)/)?.[1]?.length ?? 0;
const signed = (d: number, dp: number): string => (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d).toFixed(dp);
const longDate = (d?: string): string => (d ? parseDay(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** Fill in what a result leaves implicit: in range unless said otherwise. */
export function normalise(r: ScreenResult): Row {
  return {
    ...r,
    s25: r.s25 ?? (r.a != null ? 'ok' : 'na'),
    s: r.s ?? (r.b != null ? 'ok' : 'na'),
    v: r.v ?? (r.a != null && r.b != null ? 'same' : r.b != null ? 'new' : 'na'),
    ref: r.ref ?? (r.lo != null && r.hi != null ? `${r.lo}–${r.hi}` : r.hi != null ? `under ${r.hi}` : r.lo != null ? `${r.lo} or more` : ''),
  };
}

const STATUS_LABEL: Record<ScreenStatus, string> = { ok: 'In range', watch: 'Watch', flag: 'Flag', na: 'Not tested' };
const TREND_LABEL: Record<ScreenTrend, string> = { better: 'better', worse: 'worse', same: 'steady', new: 'new test', na: 'not repeated' };

function Tag({ status, children }: { status: ScreenStatus | 'info'; children?: ReactNode }) {
  const icon = status === 'ok' ? <Check size={11} strokeWidth={3} /> : status === 'watch' ? <TriangleAlert size={11} /> : status === 'flag' ? <ArrowUp size={11} strokeWidth={3} /> : status === 'na' ? <Minus size={11} /> : null;
  return (
    <span className={cx('hs-tag', `hs-${status}`)}>
      {icon}
      {children ?? STATUS_LABEL[status as ScreenStatus]}
    </span>
  );
}

/** **bold** only — the record is plain text. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))}
    </>
  );
}

function Ring({ value, total, label, note, tone }: { value: number; total: number; label: string; note: string; tone: 'ok' | 'watch' | 'flag' }) {
  const C = 2 * Math.PI * 40;
  // A record can have no current results (one visit, or none filled in yet): no share to show.
  const frac = total > 0 ? value / total : 0;
  const shown = tone === 'ok' ? (total > 0 ? `${Math.round(frac * 100)}%` : '—') : String(value);
  return (
    <div className="hs-ring">
      <div className="hs-ring-g" role="img" aria-label={`${label}: ${shown} — ${note}`}>
        <svg viewBox="0 0 100 100" aria-hidden>
          <circle cx="50" cy="50" r="40" className="hs-ring-track" />
          <circle cx="50" cy="50" r="40" className={`hs-ring-arc hs-${tone}`} strokeDasharray={`${Math.max(0.02, frac) * C} ${C}`} />
        </svg>
        <span className="num">{shown}</span>
      </div>
      <b>{label}</b>
      <small>{note}</small>
    </div>
  );
}

function RangeBar({ r, labels }: { r: Row; labels: [string, string] }) {
  const A = num(r.a);
  const B = num(r.b);
  if ((A == null && B == null) || (r.lo == null && r.hi == null)) return <span className="faint">—</span>;
  let d0: number;
  let d1: number;
  if (r.lo != null && r.hi != null) {
    const span = r.hi - r.lo;
    d0 = r.lo - span * 0.6;
    d1 = r.hi + span * 0.6;
  } else if (r.hi != null) {
    d0 = 0;
    d1 = r.hi * 1.6;
  } else {
    d0 = r.lo! * 0.45;
    d1 = r.lo! * 1.45;
  }
  const pad = (d1 - d0) * 0.08;
  for (const v of [A, B]) {
    if (v == null) continue;
    d0 = Math.min(d0, v - pad);
    d1 = Math.max(d1, v + pad);
  }
  d0 = Math.max(0, d0);
  const P = (v: number): number => Math.max(0, Math.min(100, ((v - d0) / (d1 - d0)) * 100));
  const bl = r.lo != null ? P(r.lo) : 0;
  const bh = r.hi != null ? P(r.hi) : 100;
  const tip = `${r.n}: ${labels[0]} ${r.a ?? 'not tested'} · ${labels[1]} ${r.b ?? 'not tested'}${r.u ? ` ${r.u}` : ''}. Healthy: ${r.ref}`;
  return (
    <div className="hs-rb" role="img" aria-label={tip} title={tip}>
      <span className="hs-rb-track" />
      <span className="hs-rb-band" style={{ left: `${bl}%`, width: `${bh - bl}%` }} />
      {A != null && B != null && <span className="hs-rb-link" style={{ left: `${Math.min(P(A), P(B))}%`, width: `${Math.abs(P(A) - P(B))}%` }} />}
      {A != null && <span className="hs-dot hs-was" style={{ left: `${P(A)}%` }} />}
      {B != null && <span className="hs-dot hs-now" style={{ left: `${P(B)}%` }} />}
    </div>
  );
}

function Change({ r }: { r: Row }) {
  const A = num(r.a);
  const B = num(r.b);
  if (r.v === 'na' || r.v === 'new') return <td className={cx('hs-ch', `hs-t-${r.v}`)}>{TREND_LABEL[r.v]}</td>;
  if (A != null && B != null) {
    const d = B - A;
    const label = r.chl ?? (r.v !== 'same' ? TREND_LABEL[r.v] : '');
    return (
      <td className={cx('hs-ch num', `hs-t-${r.v}`)}>
        {Math.abs(d) < 1e-9 ? 'no change' : signed(d, Math.max(decimals(r.a!), decimals(r.b!)))}
        {label && ` · ${label}`}
      </td>
    );
  }
  return <td className={cx('hs-ch', `hs-t-${r.v}`)}>{TREND_LABEL[r.v]}</td>;
}

function Value({ value, unit, status }: { value: string | null; unit?: string; status: ScreenStatus }) {
  if (value == null) return <td className="hs-v faint">not tested</td>;
  const text = num(value) == null && !value.startsWith('<');
  return (
    <td className={cx('hs-v', !text && 'num', text && 'hs-text', status === 'flag' && 'hs-c-flag', status === 'watch' && 'hs-c-watch')}>
      {value}
      {!text && unit && <span className="hs-u">{unit}</span>}
    </td>
  );
}

function ImportButton({ label, primary }: { label: string; primary?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const { toast } = useApp();
  const save = useWrite((doc: unknown) => write.put('/screenings', doc));
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      save.mutate(JSON.parse(await file.text()), {
        onSuccess: () => toast({ message: 'Screening record imported.' }),
        onError: (err) => toast({ message: `Could not import: ${err.message}` }),
      });
    } catch {
      toast({ message: 'That file is not valid JSON.' });
    } finally {
      if (input.current) input.current.value = '';
    }
  };
  return (
    <>
      <button type="button" className={cx('btn', primary && 'btn-primary')} onClick={() => input.current?.click()} disabled={save.isPending}>
        <Upload size={15} /> {label}
      </button>
      <input ref={input} type="file" accept="application/json,.json" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
    </>
  );
}

type Filter = 'all' | 'needs' | 'changed';

export function Screenings({ sphereId }: { sphereId: string }) {
  const { data: doc, isLoading } = useScreenings();
  const { sphere, ask, agentName, toast } = useApp();
  const s = sphere(sphereId);
  const [filter, setFilter] = useState<Filter>('all');
  const [added, setAdded] = useState<Set<number>>(new Set());
  const addTask = useWrite((body: object) => write.post('/tasks', body));
  const remove = useWrite(() => write.del('/screenings'));

  const rows = useMemo(() => (doc?.results ?? []).map(normalise), [doc]);
  const back = (
    <Link href={`/spheres/${sphereId}`} className="back">
      <ArrowLeft size={15} /> {s?.name ?? 'Sphere'}
    </Link>
  );

  if (isLoading) return <Loading />;
  if (!doc)
    return (
      <div className="page">
        {back}
        <div className="empty-block">
          <h3>No screening record yet</h3>
          <p style={{ maxWidth: '48ch' }}>Import a screening record (JSON) to see your check-ups side by side: what's in range, what moved, and what to do next. It stays in your own database.</p>
          <ImportButton label="Import a record" primary />
        </div>
      </div>
    );

  const [wasLabel, nowLabel] = [doc.visits[0]!.label, (doc.visits[1] ?? doc.visits[0]!).label];
  const labels: [string, string] = [wasLabel, nowLabel];
  const tested = rows.filter((r) => r.b != null);
  const count = (st: ScreenStatus): number => tested.filter((r) => r.s === st).length;
  const needs = (r: Row): boolean => r.s === 'watch' || r.s === 'flag' || (r.b == null && (r.s25 === 'flag' || r.s25 === 'watch'));
  const changed = (r: Row): boolean => r.v === 'better' || r.v === 'worse';
  const shown = rows.filter(filter === 'needs' ? needs : filter === 'changed' ? changed : () => true);
  let group = '';

  return (
    <div className="page hs tint" style={s ? hueStyle(s.hue) : undefined}>
      {back}

      <header className="hs-hero">
        <div>
          <p className="eyebrow">Health screening record{doc.updated ? ` · updated ${longDate(doc.updated)}` : ''}</p>
          <h1 className="page-title">{doc.title}</h1>
          {doc.subtitle && <p className="page-sub">{doc.subtitle}</p>}
          <ul className="hs-visits" aria-label="Screening timeline">
            {doc.visits.map((v, i) => (
              <li key={v.label}>
                <i className={cx('hs-dot-s', i === doc.visits.length - 1 ? 'hs-now' : 'hs-was')} />
                {longDate(v.date) || v.label}
                {v.place && <span> · {v.place}</span>}
              </li>
            ))}
            {doc.next && (
              <li>
                <i className="hs-dot-s hs-next" />
                Next <span> · {longDate(doc.next)}</span>
              </li>
            )}
          </ul>
          <div className="row-wrap" style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-tint btn-sm" onClick={() => ask('Read my health screenings and walk me through what matters most and what I should do first.')}>
              Go through it with {agentName}
            </button>
            <a className="btn btn-ghost btn-sm" href="#hs-actions">
              Action plan
            </a>
          </div>
        </div>
        <div className="card hs-rings">
          <Ring tone="ok" value={count('ok')} total={tested.length} label="In range" note={`${count('ok')} of ${tested.length} results`} />
          <Ring tone="watch" value={count('watch')} total={tested.length} label="To watch" note={doc.ringNotes?.watch ?? ''} />
          <Ring tone="flag" value={count('flag')} total={tested.length} label="Flagged" note={doc.ringNotes?.flag ?? ''} />
        </div>
      </header>

      {(doc.summary || doc.tiles) && (
        <section className="hs-section">
          <h2>The short version</h2>
          <div className="hs-overview">
            {doc.summary && (
              <div className="card hs-story">
                <div className="hs-insight">
                  <Sparkles size={15} /> Summary
                </div>
                {doc.summary.map((p, i) => (
                  <p key={i}>
                    <Rich text={p} />
                  </p>
                ))}
              </div>
            )}
            <div className="hs-tiles">
              {(doc.tiles ?? []).map((t) => {
                const lo = Math.min(t.a, t.b);
                const hi = Math.max(t.a, t.b);
                const pad = (hi - lo) * 0.4 || 1;
                const y = (v: number): number => 4 + (1 - (v - (lo - pad)) / (hi + pad - (lo - pad))) * 26;
                return (
                  <div key={t.lab} className="card hs-tile">
                    <div className="hs-tile-top">
                      <span>{t.lab}</span>
                      <span className={cx('hs-trend', `hs-tr-${t.v}`)} role="img" aria-label={`${t.dir === 'up' ? 'Up' : 'Down'} since ${wasLabel}, ${t.v === 'watch' ? 'worth watching' : t.v}`}>
                        {t.dir === 'up' ? <ArrowUp size={12} strokeWidth={3} /> : <ArrowDown size={12} strokeWidth={3} />}
                      </span>
                    </div>
                    <div className="hs-tile-row">
                      <div className="hs-tile-val num">
                        {t.val}
                        <small>{t.u}</small>
                      </div>
                      <svg className={cx('hs-spark', `hs-tr-${t.v}`)} width="76" height="34" viewBox="0 0 76 34" aria-hidden>
                        <line x1="6" y1={y(t.a)} x2="68" y2={y(t.b)} />
                        <circle cx="6" cy={y(t.a)} r="3.5" className="hs-was-c" />
                        <circle cx="68" cy={y(t.b)} r="4.5" />
                      </svg>
                    </div>
                    <div className={cx('hs-tile-status', `hs-c-${t.st}`)}>{t.stt}</div>
                    <div className="hs-tile-sub">{t.sub}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {doc.actions && doc.actions.length > 0 && (
        <section className="hs-section" id="hs-actions">
          <h2>What to do next</h2>
          <p className="hs-lede">Ordered by priority. Each item says where it came from.</p>
          <ol className="hs-actions">
            {doc.actions.map((a, i) => (
              <li key={a.t} className={cx('card hs-action', `hs-p-${a.p}`)}>
                <span className="hs-num num" aria-hidden>
                  {i + 1}
                </span>
                <div>
                  <div className="hs-action-head">
                    <h3>{a.t}</h3>
                    <Tag status={a.p === 'high' ? 'flag' : a.p === 'medium' ? 'watch' : 'info'}>{a.p === 'high' ? 'High priority' : a.p === 'medium' ? 'Medium' : 'Low'}</Tag>
                  </div>
                  <p className="hs-body">{a.body}</p>
                  {a.also && <p className="hs-also">{a.also}</p>}
                  <div className="hs-action-foot">
                    {a.src && <span className="hs-src">Source: {a.src}</span>}
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={added.has(i)}
                      onClick={() =>
                        addTask.mutate(
                          { title: a.t, notes: a.body.slice(0, 1900), sphereId },
                          {
                            onSuccess: () => {
                              setAdded((prev) => new Set(prev).add(i));
                              toast({ message: 'Added to your tasks.' });
                            },
                          },
                        )
                      }
                    >
                      {added.has(i) ? (
                        <>
                          <Check size={14} /> Added
                        </>
                      ) : (
                        <>
                          <Plus size={14} /> Add as task
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {(doc.moved || doc.slopes) && (
        <section className="hs-section">
          <h2>How things moved</h2>
          <p className="hs-lede">
            Comparing {wasLabel} with {nowLabel}.
          </p>
          <div className="hs-moved">
            {(doc.moved ?? []).map((m) => (
              <div key={m.h} className="card">
                <div className="hs-moved-head">
                  <i className={cx('hs-dot-s', `hs-bg-${m.s}`)} />
                  <h3>{m.h}</h3>
                  <span className="chip">{m.items.length}</span>
                </div>
                <ul>
                  {m.items.map(([name, figure, why]) => (
                    <li key={name}>
                      <span>{name}</span>
                      <span className="hs-fig num">{figure}</span>
                      {why && <span className="hs-why">{why}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {doc.slopes && doc.slopes.length > 0 && (
            <>
              <div className="hs-legend" aria-hidden>
                <span>
                  <i className="hs-dot-s hs-was" />
                  {wasLabel}
                </span>
                <span>
                  <i className="hs-dot-s hs-now" />
                  {nowLabel}
                </span>
                <span>
                  <i className="hs-band-key" />
                  Healthy range
                </span>
              </div>
              <div className="hs-slopes">
                {doc.slopes.map((sl) => {
                  const span = sl.d[1] - sl.d[0] || 1;
                  const Y = (v: number): number => (1 - (v - sl.d[0]) / span) * 100;
                  const top = Y(sl.band[1]);
                  const fa = sl.a.toFixed(sl.dp);
                  const fb = sl.b.toFixed(sl.dp);
                  return (
                    <figure key={sl.n} className="card hs-slope">
                      <div className="hs-slope-head">
                        <div>
                          <div className="muted">{sl.n}</div>
                          <div className="hs-slope-val num">
                            {fb}
                            <small>{sl.u}</small>
                          </div>
                          <div className="hs-tile-sub">
                            {nowLabel} · was {fa} ({signed(sl.b - sl.a, sl.dp)})
                          </div>
                        </div>
                        <div className="hs-slope-range">
                          <b>Healthy range</b>
                          <span>{sl.rng}</span>
                          <Tag status={sl.st}>{sl.stt}</Tag>
                        </div>
                      </div>
                      <div className="hs-plot" role="img" aria-label={`${sl.n} went from ${fa} to ${fb} ${sl.u}. Healthy range ${sl.rng}.`}>
                        <div className="hs-plot-band" style={{ top: `${top}%`, height: `${Y(sl.band[0]) - top}%` }} />
                        {sl.ref != null && (
                          <>
                            <div className="hs-refline" style={{ top: `${Y(sl.ref)}%` }} />
                            <div className="hs-reflab" style={{ top: `${Y(sl.ref)}%` }}>
                              {sl.refl}
                            </div>
                          </>
                        )}
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
                          <line x1="24" y1={Y(sl.a)} x2="76" y2={Y(sl.b)} vectorEffect="non-scaling-stroke" />
                        </svg>
                        <span className="hs-dot hs-was" style={{ left: '24%', top: `${Y(sl.a)}%` }} />
                        <span className="hs-dot hs-now" style={{ left: '76%', top: `${Y(sl.b)}%` }} />
                        <span className="hs-vlab hs-l num" style={{ left: '24%', top: `${Y(sl.a)}%` }}>
                          {fa}
                        </span>
                        <span className="hs-vlab hs-r num" style={{ left: '76%', top: `${Y(sl.b)}%` }}>
                          {fb}
                        </span>
                      </div>
                      <div className="hs-xlabs" aria-hidden>
                        <span style={{ left: '24%' }}>{wasLabel}</span>
                        <span style={{ left: '76%' }}>{nowLabel}</span>
                      </div>
                      {sl.note && <figcaption>{sl.note}</figcaption>}
                    </figure>
                  );
                })}
              </div>
            </>
          )}
        </section>
      )}

      {doc.scans && doc.scans.length > 0 && (
        <section className="hs-section">
          <h2>Scans and tests</h2>
          <div className="hs-scans">
            {doc.scans.map((c) => (
              <article key={c.t} className="card hs-scan">
                <div className="hs-scan-head">
                  <div>
                    <h3>{c.t}</h3>
                    <div className="row-wrap" style={{ gap: 6, marginTop: 6 }}>
                      {c.tags.map((t) => (
                        <Tag key={t} status="info">
                          {t}
                        </Tag>
                      ))}
                    </div>
                  </div>
                  <Tag status={c.s}>{c.lbl}</Tag>
                </div>
                {c.compare && (
                  <div className="hs-cmp">
                    {c.compare.map((text, i) => (
                      <div key={i}>
                        <span className={cx('hs-yr', i === 1 && 'hs-yr-now')}>{labels[i]}</span>
                        <span>{text}</span>
                      </div>
                    ))}
                  </div>
                )}
                {c.bars && (
                  <div className="hs-bars">
                    {c.bars.map((b) => (
                      <div key={b.name} role="img" aria-label={`${b.name}: ${b.a}% of predicted in ${wasLabel}, ${b.b}% in ${nowLabel}. 80% or more is normal.`}>
                        <div className="hs-bar-top">
                          <span>{b.name}</span>
                          <span className="num">
                            {b.a}% → {b.b}% of predicted
                          </span>
                        </div>
                        {[b.a, b.b].map((v, i) => (
                          <div key={i} className="hs-bar-row">
                            <span>{labels[i]}</span>
                            <div className="hs-bar">
                              <i className={i === 0 ? 'hs-was' : 'hs-now'} style={{ width: `${(v / 110) * 100}%` }} />
                              <span className="hs-bar-th" style={{ left: `${(80 / 110) * 100}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                    {c.barNote && <div className="hs-tile-sub">▏{c.barNote}</div>}
                  </div>
                )}
                {c.facts && (
                  <ul className="hs-facts">
                    {c.facts.map(([k, v]) => (
                      <li key={k}>
                        <span>{k}</span>
                        <span className="num">{v}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {c.read && (
                  <div className="hs-read">
                    <div className="hs-insight">
                      <Sparkles size={14} /> Reading
                    </div>
                    {c.read}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      {doc.risks && doc.risks.length > 0 && (
        <section className="hs-section">
          <h2>Risk outlook</h2>
          {doc.riskNote && <p className="hs-lede">{doc.riskNote}</p>}
          <div className="card hs-risk">
            {doc.risks.map((r) => {
              const L0 = Math.log10(0.1);
              const L1 = Math.log10(5);
              const P = (m: number): number => Math.max(0, Math.min(100, ((Math.log10(m) - L0) / (L1 - L0)) * 100));
              const mult = r.mult >= 1 ? `${r.mult.toFixed(1)}× average` : `${(1 / r.mult).toFixed(1)}× below average`;
              const tip = `${r.n}: ${r.now}% vs ${r.avg}% average (${mult}). At target weight: ${r.tgt}%.`;
              return (
                <div key={r.n} className="hs-risk-row">
                  <div>
                    <b>{r.n}</b>
                    <span className="hs-tile-sub">{r.h}</span>
                  </div>
                  <div className="hs-risk-track" role="img" aria-label={tip} title={tip}>
                    <div className="hs-risk-bar" />
                    <span className="hs-risk-avg" style={{ left: `${P(1)}%` }} />
                    <span className="hs-risk-avg-l" style={{ left: `${P(1)}%` }}>
                      average
                    </span>
                    <span className="hs-risk-tgt" style={{ left: `${P(r.tgt / r.avg)}%` }} />
                    <span className="hs-risk-now" style={{ left: `${P(r.mult)}%` }} />
                  </div>
                  <div className="hs-risk-val">
                    <b className="num">{r.now}%</b>
                    <span>
                      {mult} ({r.avg}%)
                    </span>
                    <span>At target weight: {r.tgt}%</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="hs-legend" aria-hidden>
            <span>
              <i className="hs-key-now" />
              Your risk now, as a multiple of average
            </span>
            <span>
              <i className="hs-key-tgt" />
              At the report's target weight
            </span>
          </div>
        </section>
      )}

      <section className="hs-section">
        <h2>Every result</h2>
        <p className="hs-lede">All results from both reports, grouped by body system.</p>
        <div className="row-wrap" style={{ marginBottom: 14, justifyContent: 'space-between' }}>
          <Seg
            label="Filter results"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All ${rows.length}` },
              { value: 'needs', label: `Needs attention ${rows.filter(needs).length}` },
              { value: 'changed', label: `Changed ${rows.filter(changed).length}` },
            ]}
          />
          <div className="hs-legend" aria-hidden style={{ margin: 0 }}>
            <span>
              <i className="hs-dot-s hs-was" />
              {wasLabel}
            </span>
            <span>
              <i className="hs-dot-s hs-now" />
              {nowLabel}
            </span>
            <span>
              <i className="hs-band-key" />
              Healthy range
            </span>
          </div>
        </div>
        <div className="card hs-table-card">
          <div className="hs-table-wrap" tabIndex={0} role="region" aria-label="All results">
            <table>
              <thead>
                <tr>
                  <th scope="col">Test</th>
                  <th scope="col">{wasLabel}</th>
                  <th scope="col">{nowLabel}</th>
                  <th scope="col">Change</th>
                  <th scope="col">Healthy range</th>
                  <th scope="col">Where it sits</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">
                      No results match this filter.
                    </td>
                  </tr>
                )}
                {shown.flatMap((r) => {
                  const out: ReactNode[] = [];
                  if (r.g !== group) {
                    group = r.g;
                    out.push(
                      <tr key={`g-${r.g}`} className="hs-grp">
                        <th colSpan={7} scope="colgroup">
                          {r.g}
                        </th>
                      </tr>,
                    );
                  }
                  out.push(
                    <tr key={`${r.g}-${r.n}`}>
                      <td className="hs-nm">
                        <b>{r.n}</b>
                        {r.sub && <span className="hs-tile-sub">{r.sub}</span>}
                        {r.note && <span className="hs-note">{r.note}</span>}
                      </td>
                      <Value value={r.a} unit={r.u} status={r.s25} />
                      <Value value={r.b} unit={r.u} status={r.s} />
                      <Change r={r} />
                      <td className="hs-ref">{r.ref || '—'}</td>
                      <td className="hs-barcell">
                        <RangeBar r={r} labels={labels} />
                      </td>
                      <td>
                        {r.b == null && r.s25 !== 'ok' && r.s25 !== 'na' ? (
                          <>
                            <Tag status="na" /> <span className="hs-tile-sub">(earlier: {STATUS_LABEL[r.s25].toLowerCase()})</span>
                          </>
                        ) : (
                          <Tag status={r.s} />
                        )}
                      </td>
                    </tr>,
                  );
                  return out;
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {doc.notes && doc.notes.length > 0 && (
        <section className="hs-section">
          <h2>Notes on reading this</h2>
          <div className="card hs-notes">
            {doc.notes.map(([head, body]) => (
              <p key={head}>
                <b>{head}</b> {body}
              </p>
            ))}
          </div>
        </section>
      )}

      <footer className="hs-footer">
        {(doc.footer ?? []).map((line) => (
          <p key={line}>{line}</p>
        ))}
        <div className="row-wrap" style={{ justifyContent: 'center', marginTop: 10 }}>
          <ImportButton label="Replace with a new record" />
          <button type="button" className="btn btn-danger" onClick={() => window.confirm('Remove the screening record from Terminus?') && remove.mutate()}>
            Remove
          </button>
        </div>
      </footer>
    </div>
  );
}
