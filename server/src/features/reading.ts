// The reading list: books you want to read, are reading, or have read, in the Learning
// sphere. Name a book and Terminus looks it up on Open Library and Google Books (both
// free, no account) for its synopsis, ratings, cover and details, and works out where to
// buy it. When neither source has a synopsis, the background brain writes a short one
// from what it knows. Covers are fetched once and kept, so the shelf works offline.

import { z } from 'zod';
import { registerSnapshotSection } from '../agent/snapshot-hooks.ts';
import { NoBrain, think } from '../agent/think.ts';
import { tool } from '../agent/tools.ts';
import { read } from '../http.ts';
import { Invalid, newId, NotFound, nowIso, registerUndo, type Store } from '../store.ts';
import type { Book, BookCandidate, BookStatus } from '../../../shared/types.ts';
import { safeFetch } from './fetcher.ts';
import { registerFeature } from './registry.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// ── Sources ─────────────────────────────────────────────────────────────────

/** Tests swap the network for a fake. */
let net: typeof fetch = (...args) => fetch(...args);
export function setBooksFetch(f: typeof fetch | null): void {
  net = f ?? ((...args) => fetch(...args));
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await net(url, { signal: AbortSignal.timeout(9000), headers: { accept: 'application/json', 'user-agent': 'Terminus (personal reading list)' } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** What one source knows about a book. */
export interface Found {
  ref: string;
  title: string;
  author: string;
  year: number | null;
  pages: number | null;
  isbn: string;
  synopsis: string;
  rating: number | null;
  ratingsCount: number | null;
  coverUrl: string;
  thumb: string;
  infoUrl: string;
}

const OL = 'https://openlibrary.org';
const GB = 'https://www.googleapis.com/books/v1/volumes';
const gbKey = () => (process.env.GOOGLE_BOOKS_API_KEY ? `&key=${encodeURIComponent(process.env.GOOGLE_BOOKS_API_KEY)}` : '');

/** Descriptions arrive as HTML (Google) or Markdown with link footnotes (Open Library). */
export function cleanSynopsis(raw: string): string {
  let s = raw
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  // Open Library: a rule, then sources and "Also contained in" lists.
  s = s.split(/\n\s*[-*_]{4,}\s*\n/)[0]!;
  s = s.replace(/\[([^\]]+)\]\[\d+\]/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^\s*\[\d+\]:.*$/gm, '');
  s = s.replace(/\(\s*(?:source|from)\s*:?[^)]*\)\s*$/i, '');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > 2400 ? `${s.slice(0, 2400).replace(/\s+\S*$/, '')}…` : s;
}

const yearOf = (s: unknown): number | null => {
  const m = typeof s === 'string' ? /\d{4}/.exec(s) : null;
  return m ? Number(m[0]) : typeof s === 'number' ? s : null;
};
const https = (u: string | undefined): string => (u ? u.replace(/^http:\/\//, 'https://') : '');

interface OlDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  number_of_pages_median?: number;
  isbn?: string[];
  cover_i?: number;
  ratings_average?: number;
  ratings_count?: number;
}
const OL_FIELDS = 'key,title,author_name,first_publish_year,number_of_pages_median,isbn,cover_i,ratings_average,ratings_count';

function fromOl(d: OlDoc): Found | null {
  if (!d.key || !d.title) return null;
  const isbns = d.isbn ?? [];
  return {
    ref: `ol:${d.key.replace('/works/', '')}`,
    title: d.title,
    author: (d.author_name ?? []).slice(0, 3).join(', '),
    year: d.first_publish_year ?? null,
    pages: d.number_of_pages_median ?? null,
    isbn: isbns.find((i) => /^97[89]\d{10}$/.test(i)) ?? isbns.find((i) => /^\d{9}[\dX]$/.test(i)) ?? '',
    synopsis: '',
    rating: d.ratings_count ? round1(d.ratings_average ?? 0) : null,
    ratingsCount: d.ratings_count ?? null,
    coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg?default=false` : '',
    thumb: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-S.jpg` : '',
    infoUrl: `${OL}${d.key}`,
  };
}

interface GbVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publishedDate?: string;
    description?: string;
    pageCount?: number;
    averageRating?: number;
    ratingsCount?: number;
    industryIdentifiers?: { type: string; identifier: string }[];
    imageLinks?: Record<string, string>;
    infoLink?: string;
    canonicalVolumeLink?: string;
  };
}

function fromGb(v: GbVolume): Found | null {
  const i = v.volumeInfo;
  if (!v.id || !i?.title) return null;
  const ids = i.industryIdentifiers ?? [];
  const img = i.imageLinks ?? {};
  // The detail endpoint offers bigger sizes; search results only the thumbnail.
  const big = img.extraLarge ?? img.large ?? img.medium ?? img.small ?? (img.thumbnail ? img.thumbnail.replace(/&edge=curl/, '') : '');
  return {
    ref: `gb:${v.id}`,
    title: i.title,
    author: (i.authors ?? []).slice(0, 3).join(', '),
    year: yearOf(i.publishedDate),
    pages: i.pageCount || null,
    isbn: ids.find((x) => x.type === 'ISBN_13')?.identifier ?? ids.find((x) => x.type === 'ISBN_10')?.identifier ?? '',
    synopsis: i.description ? cleanSynopsis(i.description) : '',
    rating: i.ratingsCount ? round1(i.averageRating ?? 0) : null,
    ratingsCount: i.ratingsCount ?? null,
    coverUrl: https(big),
    thumb: https(img.smallThumbnail ?? img.thumbnail),
    infoUrl: https(i.canonicalVolumeLink ?? i.infoLink),
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

async function searchOl(params: Record<string, string>, limit: number): Promise<Found[]> {
  const q = new URLSearchParams({ ...params, limit: String(limit), fields: OL_FIELDS });
  const body = await getJson<{ docs?: OlDoc[] }>(`${OL}/search.json?${q}`);
  return (body?.docs ?? []).map(fromOl).filter((x): x is Found => !!x);
}

async function searchGb(q: string, limit: number): Promise<Found[]> {
  const body = await getJson<{ items?: GbVolume[] }>(`${GB}?q=${encodeURIComponent(q)}&maxResults=${limit}&printType=books${gbKey()}`);
  return (body?.items ?? []).map(fromGb).filter((x): x is Found => !!x);
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** A title without its subtitle or edition: "Dune: Deluxe Edition" → "dune". */
const mainTitle = (t: string) => norm(t.split(/:|\s[-–—]\s|\(/)[0]!);

/** The same book: the same main title and, when both are known, a shared author surname. */
export function sameBook(a: { title: string; author: string }, b: { title: string; author: string }): boolean {
  const ta = mainTitle(a.title);
  if (!ta || ta !== mainTitle(b.title)) return false;
  if (!a.author || !b.author) return true;
  const surnames = (s: string) => new Set(s.split(',').map((n) => norm(n).split(' ').pop() ?? '').filter(Boolean));
  const sa = surnames(a.author);
  return [...surnames(b.author)].some((n) => sa.has(n));
}

/** Matches for what was typed, from both sources, one per book. */
export async function searchBooks(q: string): Promise<BookCandidate[]> {
  const query = q.trim();
  if (!query) return [];
  const [ol, gb] = await Promise.all([searchOl({ q: query }, 8), searchGb(query, 8)]);
  const out: Found[] = [];
  // Open Library first (whole works, not editions), then what only Google knows.
  for (const f of [...ol, ...gb]) if (!out.some((o) => sameBook(o, f))) out.push(f);
  for (const f of out) remember(f);
  return out.slice(0, 8).map((f) => ({ ref: f.ref, title: f.title, author: f.author, year: f.year, thumb: f.thumb }));
}

/** Search results, kept briefly so adding one doesn't have to find it again. */
const recent = new Map<string, Found>();
function remember(f: Found): void {
  recent.delete(f.ref);
  recent.set(f.ref, f);
  if (recent.size > 200) recent.delete(recent.keys().next().value!);
}

async function olWork(ref: string, hint: { title: string; author: string }): Promise<Found | null> {
  const id = ref.slice(3);
  if (!/^OL\d+W$/.test(id)) return null;
  const [work, ratings] = await Promise.all([
    getJson<{ title?: string; description?: string | { value?: string } }>(`${OL}/works/${id}.json`),
    getJson<{ summary?: { average?: number; count?: number } }>(`${OL}/works/${id}/ratings.json`),
  ]);
  let base = recent.get(ref) ?? null;
  if (!base) {
    const title = work?.title ?? hint.title;
    base = (await searchOl(hint.author ? { title, author: hint.author } : { title }, 10)).find((f) => f.ref === ref) ?? null;
  }
  if (!base && !work?.title) return null;
  const f: Found = base ? { ...base } : { ref, title: work!.title!, author: hint.author, year: null, pages: null, isbn: '', synopsis: '', rating: null, ratingsCount: null, coverUrl: '', thumb: '', infoUrl: `${OL}/works/${id}` };
  const desc = typeof work?.description === 'string' ? work.description : work?.description?.value;
  if (desc) f.synopsis = cleanSynopsis(desc);
  if (ratings?.summary?.count && ratings.summary.count > (f.ratingsCount ?? 0)) {
    f.rating = round1(ratings.summary.average ?? 0);
    f.ratingsCount = ratings.summary.count;
  }
  return f;
}

async function gbVolume(ref: string): Promise<Found | null> {
  const id = ref.slice(3);
  if (!/^[\w-]+$/.test(id)) return null;
  const v = await getJson<GbVolume>(`${GB}/${id}?${gbKey().slice(1)}`);
  return v ? fromGb(v) : (recent.get(ref) ?? null);
}

export interface LookedUp {
  title: string;
  author: string;
  year: number | null;
  pages: number | null;
  isbn: string;
  synopsis: string;
  synopsisSource: string;
  rating: number | null;
  ratingsCount: number | null;
  ratingSource: string;
  coverUrl: string;
  infoUrl: string;
}

const SOURCE = { ol: 'Open Library', gb: 'Google Books' } as const;
const sourceOf = (f: Found) => SOURCE[f.ref.slice(0, 2) as 'ol' | 'gb'];

/**
 * Everything both sources know about a book, merged: the chosen match (or the best match
 * for a title and author) and the same book at the other source.
 */
export async function lookUpBook(want: { ref?: string; title: string; author?: string }): Promise<LookedUp | null> {
  const hint = { title: want.title.trim(), author: (want.author ?? '').trim() };
  let primary: Found | null = null;
  if (want.ref?.startsWith('ol:')) primary = await olWork(want.ref, hint);
  else if (want.ref?.startsWith('gb:')) primary = await gbVolume(want.ref);
  if (!primary && hint.title) {
    const olHit = (await searchOl(hint.author ? { title: hint.title, author: hint.author } : { title: hint.title }, 5)).find((f) => sameBook(hint, f));
    primary = olHit ? await olWork(olHit.ref, { title: olHit.title, author: olHit.author }) : null;
  }
  const other = primary?.ref.startsWith('ol:') ? 'gb' : 'ol';
  const key = primary ?? { title: hint.title, author: hint.author };
  if (!key.title) return null;
  let second: Found | null = null;
  if (other === 'gb') {
    const q = `intitle:${key.title.split(':')[0]}${key.author ? ` inauthor:${key.author.split(',')[0]}` : ''}`;
    second = (await searchGb(q, 5)).find((f) => sameBook(key, f)) ?? null;
  } else {
    const hit = (await searchOl(key.author ? { title: key.title.split(':')[0]!, author: key.author.split(',')[0]! } : { title: key.title }, 5)).find((f) => sameBook(key, f));
    second = hit ? await olWork(hit.ref, { title: hit.title, author: hit.author }) : null;
  }
  if (!primary) {
    primary = second;
    second = null;
  }
  if (!primary) return null;

  const ol = [primary, second].find((f) => f?.ref.startsWith('ol:')) ?? null;
  const gb = [primary, second].find((f) => f?.ref.startsWith('gb:')) ?? null;
  // Google's publisher blurbs read better; Open Library's are often a line or a quote.
  const blurb = [gb, ol].find((f) => f && f.synopsis.length >= 80) ?? [gb, ol].find((f) => f?.synopsis);
  const rated = [ol, gb].filter((f): f is Found => !!f?.ratingsCount).sort((a, b) => b.ratingsCount! - a.ratingsCount!)[0];
  return {
    title: primary.title,
    author: primary.author || second?.author || hint.author,
    // The first published year, which Open Library tracks; Google's is the edition's.
    year: ol?.year ?? gb?.year ?? null,
    pages: gb?.pages ?? ol?.pages ?? null,
    // Open Library's ISBNs span every edition, translations included; Google's is one edition's.
    isbn: gb?.isbn ?? '',
    synopsis: blurb?.synopsis ?? '',
    synopsisSource: blurb ? sourceOf(blurb) : '',
    rating: rated?.rating ?? null,
    ratingsCount: rated?.ratingsCount ?? null,
    ratingSource: rated ? sourceOf(rated) : '',
    // Open Library's large covers are sharper than Google's.
    coverUrl: ol?.coverUrl || gb?.coverUrl || '',
    infoUrl: primary.infoUrl,
  };
}

/** When no source has a synopsis: a short one from the background brain's own knowledge. */
async function writeSynopsis(store: Store, title: string, author: string): Promise<string> {
  try {
    const out = await think({
      store,
      task: `Write a synopsis of the book below for someone deciding whether to read it: two to four plain sentences on what it is about and why people read it, without spoilers. If you do not know this book, do not guess: answer {"synopsis": ""}. Reply as {"synopsis": "..."}.`,
      input: `Title: ${title}\nAuthor: ${author || 'unknown'}`,
      schema: z.object({ synopsis: z.string().max(1500) }),
      signal: AbortSignal.timeout(30_000),
    });
    return out.synopsis.trim();
  } catch (err) {
    if (!(err instanceof NoBrain)) console.warn('[reading] could not write a synopsis:', err instanceof Error ? err.message : err);
    return '';
  }
}

// ── Where to buy ────────────────────────────────────────────────────────────

const AMAZON_BY_ZONE: [RegExp, string][] = [
  [/^Asia\/Singapore$/, 'amazon.sg'],
  [/^Europe\/(London|Dublin|Belfast|Guernsey|Jersey|Isle_of_Man)$/, 'amazon.co.uk'],
  [/^Europe\/(Berlin|Vienna|Zurich|Busingen)$/, 'amazon.de'],
  [/^Europe\/(Paris|Brussels|Luxembourg|Monaco)$/, 'amazon.fr'],
  [/^Europe\/Madrid$|^Atlantic\/Canary$/, 'amazon.es'],
  [/^Europe\/(Rome|Vatican|San_Marino)$/, 'amazon.it'],
  [/^Europe\/Amsterdam$/, 'amazon.nl'],
  [/^Europe\/Stockholm$/, 'amazon.se'],
  [/^Europe\/Warsaw$/, 'amazon.pl'],
  [/^Europe\/Istanbul$/, 'amazon.com.tr'],
  [/^Australia\//, 'amazon.com.au'],
  [/^Asia\/Tokyo$/, 'amazon.co.jp'],
  [/^Asia\/(Kolkata|Calcutta)$/, 'amazon.in'],
  [/^Asia\/Dubai$/, 'amazon.ae'],
  [/^Asia\/Riyadh$/, 'amazon.sa'],
  [/^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax|St_Johns|Regina|Montreal)$/, 'amazon.ca'],
  [/^America\/(Mexico_City|Monterrey|Tijuana|Cancun|Merida)$/, 'amazon.com.mx'],
  [/^America\/Sao_Paulo$/, 'amazon.com.br'],
];

/** A search for the book at the Amazon store for where you are: by ISBN when known. */
export function buyLink(zone: string | null, book: { title: string; author: string; isbn: string }): string {
  const host = AMAZON_BY_ZONE.find(([re]) => re.test(zone ?? ''))?.[1] ?? 'amazon.com';
  const k = book.isbn || `${book.title} ${book.author.split(',')[0] ?? ''}`.trim();
  return `https://www.${host}/s?k=${encodeURIComponent(k)}&i=stripbooks`;
}

// ── Books ───────────────────────────────────────────────────────────────────

const SELECT = `SELECT b.*, c.source AS cover_source, c.bytes IS NULL AS cover_missing FROM reading_books b LEFT JOIN reading_covers c ON c.book_id = b.id`;

const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

function toBook(r: Row): Book {
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    year: r.year ?? null,
    pages: r.pages ?? null,
    isbn: r.isbn,
    synopsis: r.synopsis,
    synopsisSource: r.synopsis_source,
    rating: r.rating ?? null,
    ratingsCount: r.ratings_count ?? null,
    ratingSource: r.rating_source,
    // A cover that could not be fetched from the address it has now counts as none. The
    // address is in the link so a new cover is not hidden by the browser's copy of the old.
    cover: r.cover_url && !(r.cover_source === r.cover_url && r.cover_missing) ? `/api/books/${r.id}/cover?v=${hash(r.cover_url)}` : '',
    buyUrl: r.buy_url,
    infoUrl: r.info_url,
    color: r.color,
    status: r.status as BookStatus,
    note: r.note,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    createdAt: r.created_at,
  };
}

export function listBooks(store: Store): Book[] {
  return (store.db.prepare(`${SELECT} ORDER BY b.position, b.created_at DESC`).all() as Row[]).map(toBook);
}

export function getBook(store: Store, id: string): Book {
  const r = store.db.prepare(`${SELECT} WHERE b.id = ?`).get(id) as Row | undefined;
  if (!r) throw new NotFound('Book');
  return toBook(r);
}

const learningSphere = (store: Store) => store.listSpheres().find((s) => s.key === 'learning')?.id ?? null;

/** Add a book, looked up by its search match (ref) or by title and author. */
export async function addBook(store: Store, input: { ref?: string; title: string; author?: string; status?: BookStatus; synopsis?: string }): Promise<Book> {
  const title = input.title.trim();
  if (!title && !input.ref) throw new Invalid('Name the book to add.');
  const found = await lookUpBook({ ref: input.ref, title, author: input.author });
  const b = found ?? { title, author: (input.author ?? '').trim(), year: null, pages: null, isbn: '', synopsis: '', synopsisSource: '', rating: null, ratingsCount: null, ratingSource: '', coverUrl: '', infoUrl: '' };
  if (!b.title) throw new Invalid('That book could not be found. Try its title and author.');
  const dupe = listBooks(store).find((x) => sameBook(x, b));
  if (dupe) throw new Invalid(`“${dupe.title}” is already on your reading list.`);
  let { synopsis, synopsisSource } = b;
  if (input.synopsis?.trim() && !synopsis) {
    synopsis = input.synopsis.trim();
    synopsisSource = store.getProfile().agentName;
  }
  if (!synopsis) {
    synopsis = await writeSynopsis(store, b.title, b.author);
    if (synopsis) synopsisSource = store.getProfile().agentName;
  }
  const id = newId();
  const now = nowIso();
  const status = input.status ?? 'want';
  const first = (store.db.prepare('SELECT MIN(position) AS p FROM reading_books').get() as Row).p as number | null;
  store.db
    .prepare(
      `INSERT INTO reading_books (id, title, author, year, pages, isbn, synopsis, synopsis_source, rating, ratings_count, rating_source, cover_url, buy_url, info_url, status, position, started_at, finished_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, b.title, b.author, b.year, b.pages, b.isbn, synopsis, synopsisSource, b.rating, b.ratingsCount, b.ratingSource, b.coverUrl, buyLink(store.zone(), b), b.infoUrl, status, (first ?? 1) - 1, status === 'reading' ? now : null, status === 'read' ? now : null, now, now);
  store.record('created', 'book', id, learningSphere(store), `Added “${b.title}” to the reading list`);
  return getBook(store, id);
}

const patchSchema = z.object({
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().max(300),
  synopsis: z.string().trim().max(5000),
  status: z.enum(['want', 'reading', 'read']),
  note: z.string().max(5000),
  buyUrl: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]),
  coverUrl: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]),
  color: z.union([z.literal(''), z.string().regex(/^#[0-9a-f]{6}$/i)]),
}).partial();

export function updateBook(store: Store, id: string, patch: z.infer<typeof patchSchema>): Book {
  const cur = getBook(store, id);
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => (sets.push(`${col} = ?`), vals.push(v));
  if (patch.title !== undefined) set('title', patch.title);
  if (patch.author !== undefined) set('author', patch.author);
  if (patch.synopsis !== undefined && patch.synopsis !== cur.synopsis) {
    set('synopsis', patch.synopsis);
    set('synopsis_source', patch.synopsis ? 'you' : '');
  }
  if (patch.note !== undefined) set('note', patch.note);
  if (patch.buyUrl !== undefined) set('buy_url', patch.buyUrl || buyLink(store.zone(), cur));
  if (patch.coverUrl !== undefined) {
    set('cover_url', patch.coverUrl);
    set('color', '');
  } else if (patch.color !== undefined) set('color', patch.color.toLowerCase());
  if (patch.status !== undefined && patch.status !== cur.status) {
    const now = nowIso();
    set('status', patch.status);
    if (patch.status === 'reading') set('started_at', cur.startedAt ?? now);
    set('finished_at', patch.status === 'read' ? now : null);
    if (patch.status === 'read') store.record('finished', 'book', id, learningSphere(store), `Finished “${cur.title}”`);
  }
  if (!sets.length) return cur;
  set('updated_at', nowIso());
  store.db.prepare(`UPDATE reading_books SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getBook(store, id);
}

/** Look the book up again, keeping what you wrote and where you are with it. */
export async function refreshBook(store: Store, id: string): Promise<Book> {
  const cur = getBook(store, id);
  const found = await lookUpBook({ title: cur.title, author: cur.author });
  if (!found) throw new Invalid('Nothing more could be found for that book just now.');
  const mine = cur.synopsisSource === 'you';
  const synopsis = mine ? cur.synopsis : found.synopsis || cur.synopsis;
  const source = mine ? 'you' : found.synopsis ? found.synopsisSource : cur.synopsisSource;
  store.db
    .prepare('UPDATE reading_books SET year = ?, pages = ?, isbn = ?, synopsis = ?, synopsis_source = ?, rating = ?, ratings_count = ?, rating_source = ?, cover_url = ?, info_url = ?, color = CASE WHEN cover_url = ? THEN color ELSE \'\' END, updated_at = ? WHERE id = ?')
    .run(found.year, found.pages, found.isbn, synopsis, source, found.rating, found.ratingsCount, found.ratingSource, found.coverUrl || '', found.infoUrl, found.coverUrl || '', nowIso(), id);
  // A cover that failed before gets another go.
  store.db.prepare('DELETE FROM reading_covers WHERE book_id = ? AND bytes IS NULL').run(id);
  return getBook(store, id);
}

export function deleteBook(store: Store, id: string): void {
  if (!store.db.prepare('DELETE FROM reading_books WHERE id = ?').run(id).changes) throw new NotFound('Book');
}

// ── Covers ──────────────────────────────────────────────────────────────────

const RETRY_MS = 24 * 3_600_000;

/** The cover, fetched once and kept. Null when there is none to be had. */
export async function coverOf(store: Store, id: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
  const book = store.db.prepare('SELECT cover_url FROM reading_books WHERE id = ?').get(id) as Row | undefined;
  if (!book) throw new NotFound('Book');
  const url = book.cover_url as string;
  if (!url) return null;
  const kept = store.db.prepare('SELECT * FROM reading_covers WHERE book_id = ?').get(id) as Row | undefined;
  if (kept && kept.source === url) {
    if (kept.bytes) return { mime: kept.mime, bytes: kept.bytes as Uint8Array };
    if (Date.now() - Date.parse(kept.fetched_at) < RETRY_MS) return null;
  }
  let got: { mime: string; bytes: Uint8Array } | null = null;
  try {
    const res = await safeFetch(url, { maxBytes: 3_000_000, timeoutMs: 15_000, accept: 'image/*' });
    const mime = res.contentType.split(';')[0]!.trim().toLowerCase();
    // Google sends a tiny "image not available" placeholder; real covers are bigger than that.
    if (res.status === 200 && /^image\/(jpeg|png|webp|gif)$/.test(mime) && res.body.length > 1500) got = { mime, bytes: new Uint8Array(res.body) };
  } catch {
    // Kept as missing below, and tried again tomorrow.
  }
  store.db
    .prepare('INSERT INTO reading_covers (book_id, source, mime, bytes, fetched_at) VALUES (?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET source = excluded.source, mime = excluded.mime, bytes = excluded.bytes, fetched_at = excluded.fetched_at')
    .run(id, url, got?.mime ?? '', got?.bytes ?? null, nowIso());
  return got;
}

registerUndo('created:book', (db, id) => void db.prepare('DELETE FROM reading_books WHERE id = ?').run(id));

// ── Agent ───────────────────────────────────────────────────────────────────

registerSnapshotSection<Store>('Reading list', (store) => {
  const books = listBooks(store);
  if (!books.length) return null;
  const by = (s: BookStatus) => books.filter((b) => b.status === s);
  const name = (b: Book) => `${b.title}${b.author ? ` by ${b.author}` : ''}`;
  const lines: string[] = [];
  if (by('reading').length) lines.push(`Reading: ${by('reading').map(name).join('; ')}.`);
  const want = by('want');
  if (want.length) lines.push(`Want to read (${want.length}): ${want.slice(0, 12).map(name).join('; ')}${want.length > 12 ? '; …' : ''}.`);
  if (by('read').length) lines.push(`Finished: ${by('read').length}.`);
  return lines.join('\n');
});

const statusSchema = z.enum(['want', 'reading', 'read']).describe("'want' (want to read), 'reading' or 'read'");

registerFeature({
  id: 'reading',
  tables: ['reading_books'],
  tools: [
    tool(
      'list_reading_list',
      "Read the user's reading list: each book's id, title, author, status (want, reading, read), rating and note.",
      z.object({}),
      (_, { store }) => ({
        data: listBooks(store).map((b) => ({ id: b.id, title: b.title, author: b.author, status: b.status, year: b.year ?? undefined, rating: b.rating ?? undefined, note: b.note || undefined })),
        summary: 'Read the reading list',
      }),
    ),
    tool(
      'add_book_to_reading_list',
      'Add a book the user named to their reading list. Terminus looks up its cover, synopsis, ratings and where to buy it. Give the title and the author when known. Only pass a synopsis if you know the book well.',
      z.object({ title: z.string().min(1).max(300), author: z.string().max(300).default(''), status: statusSchema.default('want'), synopsis: z.string().max(1500).default('') }),
      async ({ title, author, status, synopsis }, { store }) => {
        const b = await addBook(store, { title, author, status, synopsis });
        return { data: { ok: true, id: b.id, title: b.title, author: b.author, year: b.year, rating: b.rating, found_cover: !!b.cover }, summary: `Added “${b.title}” to the reading list` };
      },
    ),
    tool(
      'update_book',
      'Move a book on the reading list to want, reading or read, or set its note.',
      z.object({ id: z.string().min(1).describe('The book id, from list_reading_list'), status: statusSchema.optional(), note: z.string().max(2000).optional() }),
      ({ id, status, note }, { store }) => {
        const b = updateBook(store, id, { status, note });
        return { data: { ok: true, title: b.title, status: b.status }, summary: status === 'read' ? `Finished “${b.title}”` : `Updated “${b.title}”` };
      },
    ),
  ],
  routes: (app, { store }) => {
    app.get('/api/books', (c) => c.json(listBooks(store)));
    app.post('/api/books/search', async (c) => {
      const { q } = await read(c, z.object({ q: z.string().max(200) }));
      return c.json(await searchBooks(q));
    });
    app.post('/api/books', async (c) => {
      const body = await read(c, z.object({ ref: z.string().max(80).optional(), title: z.string().max(300).default(''), author: z.string().max(300).default(''), status: statusSchema.optional() }));
      return c.json(await addBook(store, body), 201);
    });
    app.patch('/api/books/:id', async (c) => c.json(updateBook(store, c.req.param('id'), await read(c, patchSchema))));
    app.post('/api/books/:id/refresh', async (c) => c.json(await refreshBook(store, c.req.param('id'))));
    app.delete('/api/books/:id', (c) => {
      deleteBook(store, c.req.param('id'));
      return c.json({ ok: true });
    });
    app.get('/api/books/:id/cover', async (c) => {
      const cover = await coverOf(store, c.req.param('id'));
      if (!cover) return c.json({ error: 'No cover' }, 404);
      return c.body(cover.bytes as Uint8Array<ArrayBuffer>, 200, { 'content-type': cover.mime, 'cache-control': 'private, max-age=604800', 'x-content-type-options': 'nosniff' });
    });
  },
});
