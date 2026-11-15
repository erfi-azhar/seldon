// Crypto prices, live. Binance's public market-data stream first (no key, every tick), Coinbase
// when Binance won't serve (it refuses some regions) or doesn't list a coin, and plain polling
// when no stream stays open. Every price is in US dollars; currency rates turn it into yours.

import type { MarketState, Quote } from '../../../shared/types.ts';
import type { DB } from '../db.ts';
import type { Store } from '../store.ts';

const BINANCE_REST = 'https://data-api.binance.vision/api/v3';
const BINANCE_WS = 'wss://data-stream.binance.vision/stream?streams=';
const COINBASE_REST = 'https://api.exchange.coinbase.com';
const COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com';
const FX_PRIMARY = 'https://api.frankfurter.dev/v1/latest?base=USD';
const FX_FALLBACK = 'https://open.er-api.com/v6/latest/USD';

/** Dollar stablecoins: priced at one dollar rather than looked up against themselves. */
export const STABLE = new Set(['USD', 'USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'PYUSD']);

const TIMEOUT_MS = 8_000;
const SPARK_EVERY_MS = 15 * 60_000;
const UNKNOWN_RETRY_MS = 30 * 60_000;
const BINANCE_COOLDOWN_MS = 15 * 60_000;
const FX_EVERY_MS = 12 * 60 * 60_000;
/** How long sockets stay open after the last viewer leaves. */
const LINGER_MS = 2 * 60_000;

export const symbolOk = (s: string): boolean => /^[A-Z0-9]{2,12}$/.test(s);
export const normSymbol = (s: string): string => s.trim().toUpperCase().replace(/[-/]?(USDT|USD)$/, '') || s.trim().toUpperCase();

// ── Transport (swapped for fakes in tests) ──────────────────────────────────

export interface SocketLike {
  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (e: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface MarketTransport {
  fetch: typeof fetch;
  /** Opens a WebSocket; null where live streams aren't wanted (tests, or no WebSocket). */
  socket: ((url: string) => SocketLike) | null;
}

const defaultTransport = (): MarketTransport => ({
  fetch: (...args) => globalThis.fetch(...args),
  socket: typeof globalThis.WebSocket === 'function' ? (url) => new globalThis.WebSocket(url) as unknown as SocketLike : null,
});

let transport: MarketTransport = defaultTransport();

/** For tests: route every market request through a fake. Pass null to restore the real network. */
export function setMarketTransport(t: MarketTransport | null): void {
  transport = t ?? defaultTransport();
}

class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await transport.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json', 'user-agent': 'terminus' } });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text.slice(0, 300));
  return JSON.parse(text) as T;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

function quoteOf(symbol: string, price: number, open: number, high: number, low: number, volumeUsd: number, source: Quote['source']): Quote {
  return { symbol, price, open, high, low, changePct: open > 0 ? ((price - open) / open) * 100 : 0, volume: volumeUsd, source, at: Date.now() };
}

// ── Venues ──────────────────────────────────────────────────────────────────

type BinanceTicker = { symbol: string; lastPrice: string; openPrice: string; highPrice: string; lowPrice: string; quoteVolume: string };

const fromBinance = (t: BinanceTicker): Quote =>
  quoteOf(t.symbol.replace(/USDT$/, ''), num(t.lastPrice), num(t.openPrice), num(t.highPrice), num(t.lowPrice), num(t.quoteVolume), 'binance');

/** 24h tickers from Binance. Coins it doesn't list are left out. Throws when Binance can't be reached at all. */
async function binanceTickers(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const pairs = symbols.map((s) => `${s}USDT`);
  try {
    const list = await getJson<BinanceTicker[]>(`${BINANCE_REST}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(pairs))}`);
    for (const t of list) out.set(t.symbol.replace(/USDT$/, ''), fromBinance(t));
    return out;
  } catch (err) {
    // One unlisted coin fails the whole batch ("Invalid symbol"): ask one at a time instead.
    if (!(err instanceof HttpError && err.status === 400)) throw err;
  }
  await Promise.all(
    symbols.map(async (s) => {
      try {
        out.set(s, fromBinance(await getJson<BinanceTicker>(`${BINANCE_REST}/ticker/24hr?symbol=${s}USDT`)));
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 400)) throw err;
      }
    }),
  );
  return out;
}

/** A Coinbase 24h quote; null when Coinbase doesn't list the coin. */
async function coinbaseQuote(symbol: string): Promise<Quote | null> {
  try {
    const s = await getJson<{ open: string; high: string; low: string; last: string; volume: string }>(`${COINBASE_REST}/products/${symbol}-USD/stats`);
    const last = num(s.last);
    return quoteOf(symbol, last, num(s.open), num(s.high), num(s.low), num(s.volume) * last, 'coinbase');
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

async function binanceSpark(symbol: string): Promise<number[]> {
  const k = await getJson<unknown[][]>(`${BINANCE_REST}/klines?symbol=${symbol}USDT&interval=1h&limit=24`);
  return k.map((row) => num(row[4]));
}

async function coinbaseSpark(symbol: string): Promise<number[]> {
  const k = await getJson<number[][]>(`${COINBASE_REST}/products/${symbol}-USD/candles?granularity=3600`);
  return k.slice(0, 24).map((row) => num(row[4])).reverse();
}

// ── The feed ────────────────────────────────────────────────────────────────

type Venue = 'binance' | 'coinbase' | 'none';
type Listener = (changed: Quote[]) => void;

interface LiveSocket {
  venue: 'binance' | 'coinbase';
  key: string;
  ws: SocketLike;
  heard: boolean;
  closed: boolean;
}

export class MarketFeed {
  private symbols = new Set<string>();
  private readonly quotes = new Map<string, Quote>();
  private readonly sparks = new Map<string, { at: number; closes: number[] }>();
  private readonly venue = new Map<string, { v: Venue; at: number }>();
  private binanceDownUntil = 0;
  /** The Binance stream failed to open again and again (a refused region): stream from Coinbase. */
  private binanceStreamDown = false;
  private sockets: LiveSocket[] = [];
  private readonly listeners = new Set<Listener>();
  private pending = new Map<string, Quote>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRefresh = 0;
  private lastError: string | null = null;
  private refreshing: Promise<void> | null = null;
  private viewers = 0;

  /** Coins to follow. Sockets follow the change when they are open. */
  setSymbols(list: Iterable<string>): void {
    const next = new Set([...list].map(normSymbol).filter(symbolOk));
    const same = next.size === this.symbols.size && [...next].every((s) => this.symbols.has(s));
    this.symbols = next;
    for (const s of [...this.quotes.keys()]) if (!next.has(s)) this.quotes.delete(s);
    if (!same && this.sockets.length) this.connect();
  }

  following(): string[] {
    return [...this.symbols].sort();
  }

  quote(symbol: string): Quote | null {
    return this.quotes.get(normSymbol(symbol)) ?? null;
  }

  /** Called with every batch of new prices: the alert check, and each viewer's stream. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Viewers keep sockets open; when the last one leaves they close a little later. */
  watch(fn: Listener): () => void {
    const off = this.subscribe(fn);
    this.viewers++;
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
    this.connect();
    return () => {
      off();
      this.viewers = Math.max(0, this.viewers - 1);
      if (this.viewers === 0) {
        this.lingerTimer = setTimeout(() => this.disconnect(), LINGER_MS);
        this.lingerTimer.unref?.();
      }
    };
  }

  hasViewers(): boolean {
    return this.viewers > 0;
  }

  /** Seconds since prices were last fetched or streamed. */
  ageMs(): number {
    const newest = Math.max(this.lastRefresh, ...[...this.quotes.values()].map((q) => q.at));
    return newest ? Date.now() - newest : Infinity;
  }

  state(): MarketState {
    const open = this.sockets.filter((s) => s.heard && !s.closed);
    const fresh = this.ageMs() < 3 * 60_000;
    const status: MarketState['status'] = this.symbols.size === 0 ? 'idle' : open.length ? 'live' : fresh ? 'polling' : this.lastError ? 'offline' : 'polling';
    const sources = [...new Set([...this.quotes.values()].map((q) => q.source).filter((s) => s !== 'fixed'))];
    return {
      quotes: this.following().map((s) => this.quotes.get(s)).filter((q): q is Quote => !!q),
      sparks: Object.fromEntries([...this.sparks].filter(([s]) => this.symbols.has(s)).map(([s, v]) => [s, v.closes])),
      status,
      source: sources.length ? sources.map((s) => (s === 'binance' ? 'Binance' : 'Coinbase')).join(' + ') : null,
      error: status === 'offline' ? this.lastError : null,
      unknown: this.following().filter((s) => this.venue.get(s)?.v === 'none'),
    };
  }

  /** Fetch every followed coin's 24h quote over REST. Shared while one is in flight. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** Refresh only when prices are older than maxAgeMs. */
  async fresh(maxAgeMs = 30_000): Promise<void> {
    const missing = this.following().some((s) => !this.quotes.has(s) && this.venue.get(s)?.v !== 'none');
    if (missing || this.ageMs() > maxAgeMs) await this.refresh().catch(() => undefined);
  }

  private routeOf(s: string): Venue | null {
    const r = this.venue.get(s);
    if (!r) return null;
    if (r.v === 'none' && Date.now() - r.at > UNKNOWN_RETRY_MS) return null;
    return r.v;
  }

  private async doRefresh(): Promise<void> {
    const changed: Quote[] = [];
    const set = (q: Quote) => {
      this.quotes.set(q.symbol, q);
      changed.push(q);
    };
    const want = this.following();
    for (const s of want.filter((s) => STABLE.has(s))) set(quoteOf(s, 1, 1, 1, 1, 0, 'fixed'));
    const coins = want.filter((s) => !STABLE.has(s) && this.routeOf(s) !== 'none');
    const errors: string[] = [];

    const binanceUp = Date.now() >= this.binanceDownUntil;
    const viaBinance = binanceUp ? coins.filter((s) => this.routeOf(s) !== 'coinbase') : [];
    if (viaBinance.length) {
      try {
        const got = await binanceTickers(viaBinance);
        for (const s of viaBinance) {
          const q = got.get(s);
          if (q) {
            set(q);
            this.venue.set(s, { v: 'binance', at: Date.now() });
          } else this.venue.set(s, { v: 'coinbase', at: Date.now() });
        }
      } catch (err) {
        this.binanceDownUntil = Date.now() + BINANCE_COOLDOWN_MS;
        errors.push(`Binance: ${(err as Error).message}`);
      }
    }
    // Coinbase prices what Binance doesn't list, and everything while Binance can't be reached.
    const binanceFailed = Date.now() < this.binanceDownUntil;
    const viaCoinbase = coins.filter((s) => !changed.some((q) => q.symbol === s) && (this.routeOf(s) === 'coinbase' || binanceFailed));
    await Promise.all(
      viaCoinbase.map(async (s) => {
        try {
          const q = await coinbaseQuote(s);
          if (q) {
            set(q);
            if (this.routeOf(s) !== 'binance') this.venue.set(s, { v: 'coinbase', at: Date.now() });
          } else if (this.routeOf(s) === 'coinbase') this.venue.set(s, { v: 'none', at: Date.now() });
        } catch (err) {
          errors.push(`Coinbase ${s}: ${(err as Error).message}`);
        }
      }),
    );

    await this.refreshSparks();
    this.lastRefresh = changed.length ? Date.now() : this.lastRefresh;
    this.lastError = errors.length && !changed.length ? errors.join('; ') : null;
    if (changed.length) this.emit(changed);
    if (errors.length && !changed.length && coins.length) throw new Error(this.lastError ?? 'No prices');
  }

  private async refreshSparks(): Promise<void> {
    const due = this.following().filter((s) => !STABLE.has(s) && this.quotes.has(s) && Date.now() - (this.sparks.get(s)?.at ?? 0) > SPARK_EVERY_MS);
    await Promise.all(
      due.map(async (s) => {
        try {
          const closes = this.quotes.get(s)!.source === 'binance' ? await binanceSpark(s) : await coinbaseSpark(s);
          this.sparks.set(s, { at: Date.now(), closes });
        } catch {
          // A missing sparkline is no reason to fail a refresh.
        }
      }),
    );
  }

  private emit(changed: Quote[]): void {
    for (const q of changed) this.pending.set(q.symbol, q);
    if (this.flushTimer) return;
    // Ticks arrive many times a second; hand them on at most once a second.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = [...this.pending.values()];
      this.pending = new Map();
      for (const fn of [...this.listeners]) {
        try {
          fn(batch);
        } catch {
          // One listener's failure must not stop the others.
        }
      }
    }, this.listeners.size ? 1_000 : 0);
    this.flushTimer.unref?.();
  }

  /** Flush pending prices now (tests, and the alert check after a refresh). */
  flush(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const batch = [...this.pending.values()];
    this.pending = new Map();
    for (const fn of [...this.listeners]) fn(batch);
  }

  // ── Streams ──

  /** Open (or re-aim) a socket per venue for the coins it carries. */
  private connect(): void {
    const open = transport.socket;
    if (!open) return;
    const coins = this.following().filter((s) => !STABLE.has(s));
    const binance = this.binanceStreamDown ? [] : coins.filter((s) => this.routeOf(s) !== 'coinbase' && this.routeOf(s) !== 'none');
    const coinbase = coins.filter((s) => !binance.includes(s) && this.routeOf(s) !== 'none');
    const want: { venue: 'binance' | 'coinbase'; syms: string[] }[] = [
      { venue: 'binance' as const, syms: binance },
      { venue: 'coinbase' as const, syms: coinbase },
    ].filter((w) => w.syms.length);
    for (const s of this.sockets) {
      const w = want.find((x) => x.venue === s.venue);
      if (!w || w.syms.join(',') !== s.key) this.closeSocket(s);
    }
    this.sockets = this.sockets.filter((s) => !s.closed);
    for (const w of want) {
      if (!this.sockets.some((s) => s.venue === w.venue)) this.openSocket(w.venue, w.syms);
    }
  }

  /** Failed opens in a row, per venue, for the backoff. */
  private readonly failures = { binance: 0, coinbase: 0 };

  private openSocket(venue: 'binance' | 'coinbase', syms: string[]): void {
    const open = transport.socket;
    if (!open || !syms.length) return;
    const url = venue === 'binance' ? BINANCE_WS + syms.map((s) => `${s.toLowerCase()}usdt@miniTicker`).join('/') : COINBASE_WS;
    let ws: SocketLike;
    try {
      ws = open(url);
    } catch (err) {
      this.lastError = `${venue} stream: ${(err as Error).message}`;
      return;
    }
    const sock: LiveSocket = { venue, key: syms.join(','), ws, heard: false, closed: false };
    this.sockets.push(sock);
    ws.addEventListener('open', () => {
      if (venue === 'coinbase') ws.send(JSON.stringify({ type: 'subscribe', product_ids: syms.map((s) => `${s}-USD`), channels: ['ticker'] }));
    });
    ws.addEventListener('message', (e) => {
      const q = parseTick(venue, e.data);
      if (!q || !this.symbols.has(q.symbol)) return;
      sock.heard = true;
      this.failures[venue] = 0;
      this.quotes.set(q.symbol, q);
      this.emit([q]);
    });
    const onDown = () => {
      if (sock.closed) return;
      sock.closed = true;
      this.sockets = this.sockets.filter((s) => s !== sock);
      if (!this.viewers) return;
      this.failures[venue] = sock.heard ? 1 : this.failures[venue] + 1;
      if (venue === 'binance' && !sock.heard && this.failures.binance >= 3) {
        // Three tries without a single tick: Binance won't stream here. Coinbase takes over.
        this.binanceStreamDown = true;
        this.connect();
        return;
      }
      const t = setTimeout(() => {
        if (this.viewers) this.connect();
      }, Math.min(60_000, 1_000 * 2 ** this.failures[venue]));
      t.unref?.();
    };
    ws.addEventListener('close', onDown);
    ws.addEventListener('error', onDown);
  }

  private closeSocket(s: LiveSocket): void {
    s.closed = true;
    try {
      s.ws.close();
    } catch {
      // Already closed.
    }
  }

  disconnect(): void {
    for (const s of this.sockets) this.closeSocket(s);
    this.sockets = [];
  }

  /** Stop everything (tests and shutdown). */
  stop(): void {
    this.disconnect();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.flushTimer = this.lingerTimer = null;
    this.listeners.clear();
    this.viewers = 0;
  }
}

/** One message from a venue's stream as a quote; null for anything else (subscriptions, heartbeats). */
export function parseTick(venue: 'binance' | 'coinbase', data: unknown): Quote | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(typeof data === 'string' ? data : String(data)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (venue === 'binance') {
    const d = (m.data ?? m) as Record<string, unknown>;
    if (d.e !== '24hrMiniTicker' || typeof d.s !== 'string' || !d.s.endsWith('USDT')) return null;
    return quoteOf(d.s.slice(0, -4), num(d.c), num(d.o), num(d.h), num(d.l), num(d.q), 'binance');
  }
  if (m.type !== 'ticker' || typeof m.product_id !== 'string' || !m.product_id.endsWith('-USD')) return null;
  const price = num(m.price);
  return quoteOf(m.product_id.slice(0, -4), price, num(m.open_24h), num(m.high_24h), num(m.low_24h), num(m.volume_24h) * price, 'coinbase');
}

const FEEDS = new WeakMap<DB, MarketFeed>();

/** The one feed for this database. */
export function marketFor(store: Store): MarketFeed {
  let f = FEEDS.get(store.db);
  if (!f) {
    f = new MarketFeed();
    FEEDS.set(store.db, f);
  }
  return f;
}

// ── Currency rates ──────────────────────────────────────────────────────────

export interface FxRates {
  rates: Record<string, number>;
  at: string;
}

export function storedFx(store: Store): FxRates | null {
  const r = store.db.prepare("SELECT value FROM settings WHERE key = 'fx_rates'").get() as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as FxRates) : null;
}

/** Rates from one US dollar, refreshed twice a day. Keeps the last good ones when both sources fail. */
export async function refreshFx(store: Store, force = false): Promise<FxRates | null> {
  const have = storedFx(store);
  if (!force && have && Date.now() - Date.parse(have.at) < FX_EVERY_MS) return have;
  let rates: Record<string, number> | null = null;
  try {
    const r = await getJson<{ rates: Record<string, number> }>(FX_PRIMARY);
    rates = r.rates;
  } catch {
    try {
      const r = await getJson<{ result: string; rates: Record<string, number> }>(FX_FALLBACK);
      if (r.result === 'success') rates = r.rates;
    } catch {
      // Both down: keep what we had.
    }
  }
  if (!rates) return have;
  const next: FxRates = { rates: { ...rates, USD: 1 }, at: new Date().toISOString() };
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('fx_rates', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  return next;
}

/** Convert between currencies through the dollar; null when a rate is missing. */
export function convert(amount: number, from: string, to: string, fx: FxRates | null): number | null {
  if (from === to) return amount;
  const rf = from === 'USD' ? 1 : fx?.rates[from];
  const rt = to === 'USD' ? 1 : fx?.rates[to];
  if (!rf || !rt) return null;
  return (amount / rf) * rt;
}
