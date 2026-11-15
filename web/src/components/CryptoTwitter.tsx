// Crypto Twitter: a card on the Finances sphere and a page of its own. The crypto accounts among the
// people you follow on X, what they're posting, triaged, and which coins are being talked about.

import { ArrowLeft, ArrowUpRight, ChevronRight, Pencil, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import type { Quote, XAccount, XCoinBuzz, XPost, XPostKind, XWatchState } from '../../../shared/types.ts';
import { useMarket, useFinance, useSpheres, useWrite, useXWatch, xwatchWrite } from '../api.ts';
import { cx, plural, timeAgo } from '../lib.ts';
import { useApp } from '../state.tsx';
import { Field, Loading, Modal, Spinner } from './ui.tsx';

const KIND_LABEL: Record<XPostKind, string> = {
  trade_idea: 'Trade idea',
  news: 'News',
  warning: 'Warning',
  launch: 'Launch',
  airdrop: 'Airdrop',
  macro: 'Macro',
  analysis: 'Analysis',
  opinion: 'Opinion',
  other: 'Post',
};

const dollars = (n: number) => `$${n.toFixed(2)}`;

/** The Finances sphere's id, for links back. */
function useFinancesId(): string | undefined {
  const { data } = useSpheres();
  return data?.find((s) => s.key === 'finances')?.id;
}

/** Live quotes for coins mentioned, from the same stream as the crypto desk. */
function useQuotes(): Map<string, Quote> {
  const { data } = useFinance();
  const market = useMarket(data?.market);
  return useMemo(() => new Map((market?.quotes ?? []).map((q) => [q.symbol, q])), [market]);
}

function CoinChip({ symbol, quote, mine, active, onClick }: { symbol: string; quote?: Quote; mine: boolean; active?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <b>{symbol}</b>
      {quote && <span className={cx('num', quote.changePct >= 0 ? 'is-up' : 'is-down')}>{`${quote.changePct >= 0 ? '+' : '−'}${Math.abs(quote.changePct).toFixed(1)}%`}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={cx('xw-coin', mine && 'is-mine', active && 'is-active')} onClick={onClick} aria-pressed={active} title={mine ? 'You hold or watch it' : undefined}>
      {body}
    </button>
  ) : (
    <span className={cx('xw-coin', mine && 'is-mine')} title={mine ? 'You hold or watch it' : undefined}>
      {body}
    </span>
  );
}

function PostItem({ p, quotes, compact = false, onCoin }: { p: XPost; quotes: Map<string, Quote>; compact?: boolean; onCoin?: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const t = p.triage;
  const coins = t?.coins ?? [];
  return (
    <li className={cx('xw-post', t && t.importance >= 3 && 'is-urgent', t?.kind === 'warning' && 'is-warning')}>
      <div className="xw-post-head">
        <span className="xw-avatar" aria-hidden>
          {p.author.username.slice(0, 1).toUpperCase()}
        </span>
        <span className="grow clamp-1">
          <b>@{p.author.username}</b>
          {!compact && p.author.name && <span className="faint"> · {p.author.name}</span>}
        </span>
        {t && t.kind !== 'other' && <span className={cx('chip', 'xw-kind', `xw-${t.kind}`)}>{KIND_LABEL[t.kind]}</span>}
        <span className="faint xw-time">{timeAgo(p.createdAt)}</span>
      </div>
      {t?.summary ? <p className="xw-summary">{t.summary}</p> : null}
      {!compact && (
        <p className={cx('xw-text', !open && t?.summary && 'clamp-2')} onClick={() => setOpen((v) => !v)}>
          {p.text}
        </p>
      )}
      {compact && !t?.summary && <p className="xw-text clamp-2">{p.text}</p>}
      <div className="xw-post-foot">
        {coins.map((c) => (
          <CoinChip key={c} symbol={c} quote={quotes.get(c)} mine={p.mine.includes(c)} onClick={onCoin ? () => onCoin(c) : undefined} />
        ))}
        {t && t.sentiment !== 'neutral' && coins.length > 0 && <span className={cx('xw-sent', t.sentiment === 'bullish' ? 'is-up' : 'is-down')}>{t.sentiment}</span>}
        <span className="grow" />
        {!compact && (p.likes > 0 || p.reposts > 0) && (
          <span className="faint num xw-metrics">
            {p.likes.toLocaleString()} likes · {p.reposts.toLocaleString()} reposts
          </span>
        )}
        <a className="xw-open" href={p.url} target="_blank" rel="noreferrer noopener">
          {compact ? <ArrowUpRight size={13} /> : <>Open on X <ArrowUpRight size={13} /></>}
        </a>
      </div>
    </li>
  );
}

// ── The card on Finances ────────────────────────────────────────────────────

export function CryptoTwitterCard() {
  const { data: x } = useXWatch();
  const quotes = useQuotes();
  const financesId = useFinancesId();
  if (!x || !financesId) return null;
  const href = `/spheres/${financesId}/crypto`;
  const since = Date.now() - 24 * 3_600_000;
  const top = x.posts.filter((p) => (p.triage?.importance ?? 0) >= 2 && Date.parse(p.createdAt) >= since).slice(0, 3);

  return (
    <section className="card xw-card">
      <div className="card-head">
        <h2 className="card-title">Crypto Twitter</h2>
        <Link href={href} className="btn btn-ghost btn-sm">
          Open the monitor <ArrowUpRight size={14} />
        </Link>
      </div>
      {!x.configured ? (
        <p className="empty">
          Watch the crypto accounts you follow on X: what they post, sorted into trade ideas, news and warnings, and which coins they're talking about. <Link href={href}>Set it up</Link>
        </p>
      ) : x.counts.monitored === 0 ? (
        <p className="empty">
          Connected as @{x.username}. <Link href={href}>Read your following</Link> to pick out the crypto accounts.
        </p>
      ) : (
        <>
          {x.buzz.length > 0 && (
            <div className="xw-buzz-row">
              {x.buzz.slice(0, 6).map((b) => (
                <CoinChip key={b.symbol} symbol={`${b.symbol} ${b.mentions}`} mine={b.mine} quote={quotes.get(b.symbol)} />
              ))}
            </div>
          )}
          {top.length === 0 ? (
            <p className="empty">Nothing that stood out in the last day.</p>
          ) : (
            <ul className="xw-feed is-compact">
              {top.map((p) => (
                <PostItem key={p.id} p={p} quotes={quotes} compact />
              ))}
            </ul>
          )}
          <p className="fin-foot hint">
            Watching {plural(x.counts.monitored, 'account')} · {dollars(x.spentUsd)} of {dollars(x.budgetUsd)} this month
            {x.lastPollAt && ` · checked ${timeAgo(x.lastPollAt)}`}
          </p>
        </>
      )}
    </section>
  );
}

// ── The page ────────────────────────────────────────────────────────────────

type Filter = 'signals' | 'mine' | 'warning' | 'trade_idea' | 'news' | 'all';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'signals', label: 'Worth reading' },
  { value: 'mine', label: 'Your coins' },
  { value: 'warning', label: 'Warnings' },
  { value: 'trade_idea', label: 'Trade ideas' },
  { value: 'news', label: 'News' },
  { value: 'all', label: 'Everything' },
];

export function CryptoMonitor({ sphereId }: { sphereId: string }) {
  const { data: x, isLoading } = useXWatch();
  const { toast } = useApp();
  const quotes = useQuotes();
  const [filter, setFilter] = useState<Filter>('signals');
  const [coin, setCoin] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const check = useWrite(xwatchWrite.check);
  const back = (
    <Link href={`/spheres/${sphereId}`} className="back">
      <ArrowLeft size={15} /> Finances
    </Link>
  );
  if (isLoading || !x) return <Loading />;

  if (!x.configured)
    return (
      <div className="page xw-page">
        {back}
        <header className="page-head">
          <div>
            <h1 className="page-title">Crypto Twitter</h1>
            <p className="page-sub">The crypto accounts you follow on X, what they post, triaged, and which coins they're talking about.</p>
          </div>
        </header>
        <SetupCard x={x} />
      </div>
    );

  const posts = x.posts.filter((p) => {
    const t = p.triage;
    if (coin && !(t?.coins ?? []).includes(coin)) return false;
    switch (filter) {
      case 'signals':
        return !!t && t.relevant && t.importance >= 1;
      case 'mine':
        return p.mine.length > 0;
      case 'all':
        return true;
      default:
        return t?.kind === filter;
    }
  });

  return (
    <div className="page xw-page">
      {back}
      <header className="page-head xw-head">
        <div>
          <h1 className="page-title">Crypto Twitter</h1>
          <p className="page-sub">
            @{x.username} · watching {plural(x.counts.monitored, 'account')}
            {x.lastPollAt ? ` · checked ${timeAgo(x.lastPollAt)}` : ''}
          </p>
        </div>
        <div className="xw-head-side">
          <div className="xw-spend" title={`Up to ${dollars(x.todayLeftUsd)} more today, pacing the budget over the month`}>
            <span className="fin-label">This month on X</span>
            <b className="num">
              {dollars(x.spentUsd)} <span className="faint">/ {dollars(x.budgetUsd)}</span>
            </b>
            <i className="xw-spend-bar">
              <i style={{ width: `${Math.min(100, (x.spentUsd / x.budgetUsd) * 100)}%` }} />
            </i>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" disabled={check.isPending || x.running || x.counts.monitored === 0} onClick={() => check.mutate(undefined, { onError: (e) => toast({ message: e.message }) })}>
            {check.isPending || x.running ? <Spinner /> : <RefreshCw size={13} />} Check now
          </button>
          <button type="button" className="icon-btn" aria-label="Crypto Twitter settings" onClick={() => setSettings(true)}>
            <Pencil size={15} />
          </button>
        </div>
      </header>
      {x.lastError && <p className="fin-tip is-bad">{x.lastError}</p>}

      {x.counts.following === 0 ? (
        <FollowingStep x={x} />
      ) : (
        <div className="xw-grid">
          <section className="card">
            <div className="xw-filters" role="group" aria-label="Show">
              {FILTERS.map((f) => (
                <button key={f.value} type="button" className={cx('chip', filter === f.value ? 'chip-tint' : 'chip-outline')} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
                  {f.label}
                </button>
              ))}
              {coin && (
                <button type="button" className="chip chip-tint" onClick={() => setCoin(null)}>
                  {coin} ✕
                </button>
              )}
            </div>
            {posts.length === 0 ? (
              <p className="empty">{x.posts.length === 0 ? `Nothing read yet. New posts are read every ${x.pollMinutes} minutes while the budget allows; "Check now" reads them straight away.` : 'Nothing here with this filter.'}</p>
            ) : (
              <ul className="xw-feed">
                {posts.map((p) => (
                  <PostItem key={p.id} p={p} quotes={quotes} onCoin={(c) => setCoin(c === coin ? null : c)} />
                ))}
              </ul>
            )}
            <p className="fin-foot hint">Posts are read from X and sorted by your background brain. They're claims, not advice: check before acting on them.</p>
          </section>
          <div className="col">
            <BuzzCard buzz={x.buzz} quotes={quotes} coin={coin} onCoin={(c) => setCoin(c === coin ? null : c)} />
            <AccountsCard x={x} />
          </div>
        </div>
      )}
      {settings && <SettingsSheet x={x} onClose={() => setSettings(false)} />}
    </div>
  );
}

function BuzzCard({ buzz, quotes, coin, onCoin }: { buzz: XCoinBuzz[]; quotes: Map<string, Quote>; coin: string | null; onCoin: (c: string) => void }) {
  const max = Math.max(1, ...buzz.map((b) => b.mentions));
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Talked about today</h2>
        <span className="hint">last 24 hours</span>
      </div>
      {buzz.length === 0 ? (
        <p className="empty">No coins mentioned yet.</p>
      ) : (
        <ul className="xw-buzz">
          {buzz.map((b) => {
            const q = quotes.get(b.symbol);
            return (
              <li key={b.symbol}>
                <button type="button" className={cx('xw-buzz-row-btn', coin === b.symbol && 'is-active')} onClick={() => onCoin(b.symbol)} aria-pressed={coin === b.symbol}>
                  <b className={cx('xw-buzz-sym', b.mine && 'is-mine')}>{b.symbol}</b>
                  <span className="xw-buzz-bar" aria-hidden>
                    <i className="is-up" style={{ width: `${(b.bullish / max) * 100}%` }} />
                    <i className="is-flat" style={{ width: `${((b.mentions - b.bullish - b.bearish) / max) * 100}%` }} />
                    <i className="is-down" style={{ width: `${(b.bearish / max) * 100}%` }} />
                  </span>
                  <span className="num xw-buzz-n">{b.mentions}</span>
                  <span className={cx('num', 'xw-buzz-q', q && (q.changePct >= 0 ? 'is-up' : 'is-down'))}>{q ? `${q.changePct >= 0 ? '+' : '−'}${Math.abs(q.changePct).toFixed(1)}%` : ''}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="fin-foot hint">Green bullish, red bearish. Coins you hold or watch are underlined.</p>
    </section>
  );
}

function AccountsCard({ x }: { x: XWatchState }) {
  const { toast } = useApp();
  const [q, setQ] = useState('');
  const set = useWrite(({ id, body }: { id: string; body: object }) => xwatchWrite.account(id, body));
  const reread = useWrite(xwatchWrite.following);
  const match = (a: XAccount) => !q || `${a.username} ${a.name}`.toLowerCase().includes(q.toLowerCase());
  const crypto = x.accounts.filter((a) => a.crypto && match(a));
  const other = x.accounts.filter((a) => a.crypto === false && match(a));
  return (
    <section className="card xw-accounts">
      <div className="card-head">
        <h2 className="card-title">Accounts</h2>
        <span className="hint">
          {x.counts.crypto} crypto of {x.counts.following}
          {x.counts.unclassified > 0 && ` · sorting ${x.counts.unclassified}`}
        </span>
      </div>
      <label className="describe xw-search">
        <Search size={14} className="faint" aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an account" aria-label="Find an account" />
      </label>
      <ul className="xw-acct-list">
        {crypto.map((a) => (
          <li key={a.id} className={cx(!a.monitored && 'is-off')}>
            <span className="grow">
              <a href={`https://x.com/${a.username}`} target="_blank" rel="noreferrer noopener" className="clamp-1">
                @{a.username}
              </a>
              <span className="faint clamp-1">{a.tags.length ? a.tags.join(' · ') : a.why}</span>
            </span>
            <button type="button" className={cx('chip', a.monitored ? 'chip-tint' : 'chip-outline')} aria-pressed={a.monitored} onClick={() => set.mutate({ id: a.id, body: { monitored: !a.monitored } })} title={a.monitored ? 'Stop watching' : 'Watch'}>
              {a.monitored ? 'Watching' : 'Watch'}
            </button>
          </li>
        ))}
      </ul>
      {other.length > 0 && (
        <details className="todo-fold">
          <summary>
            <ChevronRight size={14} className="todo-fold-chev" aria-hidden />
            <span className="grow">Not crypto</span>
            <span className="todo-fold-meta">{other.length}</span>
          </summary>
          <ul className="xw-acct-list">
            {other.map((a) => (
              <li key={a.id}>
                <span className="grow">
                  <span className="clamp-1">@{a.username}</span>
                  <span className="faint clamp-1">{a.why || a.name}</span>
                </span>
                <button type="button" className="chip chip-outline" onClick={() => set.mutate({ id: a.id, body: { crypto: true, monitored: true } })}>
                  It's crypto
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="card-foot">
        <button type="button" className="btn btn-ghost btn-sm" disabled={reread.isPending} onClick={() => reread.mutate(undefined, { onError: (e) => toast({ message: e.message }) })}>
          {reread.isPending ? <Spinner /> : <RefreshCw size={13} />} Re-read your following{x.followingCostUsd !== null ? ` (about ${dollars(x.followingCostUsd)})` : ''}
        </button>
      </div>
    </section>
  );
}

function FollowingStep({ x }: { x: XWatchState }) {
  const { toast } = useApp();
  const go = useWrite(xwatchWrite.following);
  const cost = x.followingCostUsd;
  return (
    <section className="card card-pad xw-step">
      <h2>Read who you follow</h2>
      <p className="muted">
        @{x.username} follows {x.followingCount ?? 'some'} accounts. Reading the list once costs about <b>{cost !== null ? dollars(cost) : '$0.01 an account'}</b> from your X credits, counted against this month's {dollars(x.budgetUsd)}. Then your background brain picks out the crypto accounts, at no X cost, and those are watched.
      </p>
      <button type="button" className="btn btn-primary btn-sm" disabled={go.isPending} onClick={() => go.mutate(undefined, { onError: (e) => toast({ message: e.message }) })}>
        {go.isPending ? <Spinner /> : null} Read my following{cost !== null ? ` (about ${dollars(cost)})` : ''}
      </button>
    </section>
  );
}

function SetupCard({ x }: { x: XWatchState }) {
  const [f, setF] = useState({ username: x.username, bearer: '', budget: String(x.budgetUsd) });
  const save = useWrite(() => xwatchWrite.settings({ username: f.username, bearer: f.bearer.trim(), budgetUsd: Number(f.budget) }));
  const ok = /^@?[A-Za-z0-9_]{1,15}$/.test(f.username) && f.bearer.trim().length >= 20 && Number(f.budget) >= 1;
  return (
    <section className="card card-pad xw-step">
      <h2>Connect X</h2>
      <ol className="xw-steps">
        <li>
          Sign in at <a href="https://console.x.com" target="_blank" rel="noreferrer noopener">console.x.com</a> and create an app.
        </li>
        <li>Add credits. The API is pay-per-use, about $0.005 a post and $0.01 an account read. Set a spend cap there too.</li>
        <li>Under the app's keys and tokens, copy the <b>Bearer token</b>.</li>
        <li>Paste it here with your handle. It stays on your server and never reaches the browser again.</li>
      </ol>
      <div className="field-row">
        <Field label="Your X handle">
          <input className="input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder="@yourname" data-autofocus />
        </Field>
        <Field label="Bearer token">
          <input className="input" type="password" autoComplete="off" value={f.bearer} onChange={(e) => setF({ ...f, bearer: e.target.value })} />
        </Field>
        <Field label="Monthly budget (US$)" hint="Terminus stops reading when it's used, paced across the month">
          <input className="input num" inputMode="decimal" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} />
        </Field>
      </div>
      {save.error && <p className="error-text">{save.error.message}</p>}
      <button type="button" className="btn btn-primary btn-sm" disabled={!ok || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? <Spinner /> : null} Connect
      </button>
      <p className="hint" style={{ marginTop: 10 }}>
        Connecting checks the token by looking up your account: one account read, about $0.01.
      </p>
    </section>
  );
}

function SettingsSheet({ x, onClose }: { x: XWatchState; onClose: () => void }) {
  const [f, setF] = useState({ username: x.username, bearer: '', budget: String(x.budgetUsd), every: String(x.pollMinutes) });
  const save = useWrite(() =>
    xwatchWrite.settings({ ...(f.username !== x.username && { username: f.username }), ...(f.bearer.trim() && { bearer: f.bearer.trim() }), budgetUsd: Number(f.budget), pollMinutes: Math.round(Number(f.every)) }),
  );
  const disconnect = useWrite(xwatchWrite.disconnect);
  const ok = /^@?[A-Za-z0-9_]{1,15}$/.test(f.username) && Number(f.budget) >= 1 && Number(f.every) >= 10;
  return (
    <Modal
      title="Crypto Twitter"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost btn-sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate(undefined, { onSuccess: onClose })}>
            Disconnect
          </button>
          <button className="btn btn-primary btn-sm" disabled={!ok || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Save
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="X handle">
          <input className="input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} data-autofocus />
        </Field>
        <Field label="New bearer token" hint="Leave empty to keep the one saved">
          <input className="input" type="password" autoComplete="off" value={f.bearer} onChange={(e) => setF({ ...f, bearer: e.target.value })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Monthly budget (US$)" hint={`${dollars(x.spentUsd)} spent this month`}>
          <input className="input num" inputMode="decimal" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} />
        </Field>
        <Field label="Check every (minutes)" hint="Each post is charged once, so checking more often finds posts sooner without costing more">
          <input className="input num" inputMode="numeric" value={f.every} onChange={(e) => setF({ ...f, every: e.target.value })} />
        </Field>
      </div>
      {(save.error ?? disconnect.error) && <p className="error-text">{(save.error ?? disconnect.error)!.message}</p>}
      <p className="hint">Disconnecting removes the token; the accounts and posts read so far stay.</p>
    </Modal>
  );
}
