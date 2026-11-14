// Job alerts: watch the companies you would work for and hear when a role that fits
// opens. Most companies post through an applicant-tracking system with a public job
// board API — Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee — so Terminus reads
// those directly, no scraping and no account. Give it a careers page and it finds the
// board behind it.
//
// The first check of a company records what is already open without alerting; after
// that, each new role that matches your titles and places becomes a signal in Work.

import { z } from 'zod';
import { registerSnapshotSection } from '../agent/snapshot-hooks.ts';
import { wrapUntrusted } from '../agent/think.ts';
import { tool } from '../agent/tools.ts';
import { read } from '../http.ts';
import { Invalid, newId, NotFound, nowIso, registerUndo, type Store } from '../store.ts';
import type { JobBoardKind, JobPosting, JobPreferences, JobsState, JobWatch, SignalAction } from '../../../shared/types.ts';
import { FetchError, safeFetch } from './fetcher.ts';
import { getIntegration, updateIntegration } from './integrations.ts';
import { registerFeature } from './registry.ts';
import { addSignal } from './signals.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const ID = 'jobs';
const workSphere = (store: Store) => store.listSpheres().find((s) => s.key === 'work')?.id ?? null;

// ── Boards ──────────────────────────────────────────────────────────────────

export interface Board {
  ats: JobBoardKind;
  /** The board's name; "eu:acme" for a Greenhouse or Lever board hosted in their EU region. */
  board: string;
}

// Each pattern captures an optional EU region marker (group "eu") and the board name (group "b").
const PATTERNS: [JobBoardKind, RegExp][] = [
  ['greenhouse', /(?:boards|job-boards)(?<eu>\.eu)?\.greenhouse\.io\/(?:embed\/job_(?:board(?:\/js)?|app)\?(?:[^"'\s<>]*?&(?:amp;)?)?for=)?(?<b>[A-Za-z0-9_-]+)/g],
  ['greenhouse', /boards-api(?<eu>\.eu)?\.greenhouse\.io\/v1\/boards\/(?<b>[A-Za-z0-9_-]+)/g],
  ['lever', /jobs(?<eu>\.eu)?\.lever\.co\/(?<b>[A-Za-z0-9_.-]+)/g],
  ['lever', /api(?<eu>\.eu)?\.lever\.co\/v0\/postings\/(?<b>[A-Za-z0-9_.-]+)/g],
  ['ashby', /jobs\.ashbyhq\.com\/(?<b>[A-Za-z0-9_.%-]+)/g],
  ['ashby', /api\.ashbyhq\.com\/posting-api\/job-board\/(?<b>[A-Za-z0-9_.%-]+)/g],
  // apply.workable.com/j/CODE is a shortlink to one job, not a board named "j".
  ['workable', /apply\.workable\.com\/(?:api\/v[13]\/(?:widget\/)?accounts\/)?(?!j\/)(?<b>[A-Za-z0-9_-]+)/g],
  ['smartrecruiters', /(?:jobs|careers)\.smartrecruiters\.com\/(?<b>[A-Za-z0-9_-]+)/g],
  ['smartrecruiters', /api\.smartrecruiters\.com\/v1\/companies\/(?<b>[A-Za-z0-9_-]+)/g],
  // Each Recruitee company is a subdomain; www, app and the like are Recruitee's own.
  ['recruitee', /(?<![A-Za-z0-9-])(?!(?:www|app|api|blog|help|support|status|cdn)\.)(?<b>[A-Za-z0-9-]+)\.recruitee\.com/g],
];
const NOT_BOARDS = new Set(['embed', 'api', 'v0', 'v1', 'js', 'oauth', 'static']);

/** "eu:acme" → the EU region and "acme". */
const boardParts = (board: string) => (board.startsWith('eu:') ? { eu: true, slug: board.slice(3) } : { eu: false, slug: board });

/** A job board in a URL or a page: "boards.greenhouse.io/stripe", "jobs.lever.co/acme", "greenhouse:stripe". */
export function findBoard(text: string): Board | null {
  const short = /^(greenhouse|lever|ashby|workable|smartrecruiters|recruitee):((?:eu:)?[A-Za-z0-9_.-]+)$/i.exec(text.trim());
  if (short) return { ats: short[1]!.toLowerCase() as JobBoardKind, board: short[2]! };
  for (const [ats, re] of PATTERNS) {
    // A page can name "embed" or a broken link first and the real board later on.
    for (const m of text.matchAll(re)) {
      let board: string;
      try {
        board = decodeURIComponent(m.groups!.b!);
      } catch {
        continue;
      }
      if (!board || NOT_BOARDS.has(board.toLowerCase())) continue;
      return { ats, board: m.groups!.eu ? `eu:${board}` : board };
    }
  }
  return null;
}

export interface RawPosting {
  externalId: string;
  title: string;
  location: string;
  department: string;
  remote: boolean;
  url: string;
  postedAt: string | null;
}

type Fetch = (url: string) => Promise<{ status: number; body: string }>;
let fetchText: Fetch = async (url) => {
  const res = await safeFetch(url, { maxBytes: 8_000_000, timeoutMs: 20_000, accept: 'application/json, text/html;q=0.8' });
  return { status: res.status, body: res.body.toString('utf8') };
};
/** Tests swap the network for a fake. */
export function setJobFetcher(f: Fetch): void {
  fetchText = f;
}

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
const isRemote = (...parts: unknown[]) => /\bremote\b|anywhere|work from home/i.test(parts.map(str).join(' '));

async function getJson(url: string): Promise<unknown> {
  const res = await fetchText(url);
  if (res.status === 404) throw new Invalid('That job board does not exist (any more). Check the company’s careers page.');
  if (res.status >= 400) throw new Error(`The job board answered ${res.status}`);
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error('The job board did not send JSON');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/** More than this many roles on one board, and only this many are recorded. */
const MAX_POSTINGS = 2000;

/** Greenhouse only names a job's department in the departments list (or the heavy content=true payload). */
async function greenhouseDepartments(base: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const j = (await getJson(`${base}/departments`)) as J;
    for (const d of (j?.departments ?? []) as J[]) {
      const name = str(d.name);
      if (!name || d.id === 0) continue; // id 0 is Greenhouse's "No Department"
      for (const job of (d.jobs ?? []) as J[]) if (!out.has(str(job.id))) out.set(str(job.id), name);
    }
  } catch {
    // Departments only sharpen "Leave out"; the roles themselves still count.
  }
  return out;
}

export async function fetchPostings(b: Board): Promise<RawPosting[]> {
  const { eu, slug } = boardParts(b.board);
  const id = encodeURIComponent(slug);
  switch (b.ats) {
    case 'greenhouse': {
      const base = `https://boards-api${eu ? '.eu' : ''}.greenhouse.io/v1/boards/${id}`;
      const j = (await getJson(`${base}/jobs`)) as J;
      const jobs = (j?.jobs ?? []) as J[];
      const departments = jobs.length ? await greenhouseDepartments(base) : new Map<string, string>();
      return jobs.map((x) => ({
        externalId: str(x.id),
        title: str(x.title),
        location: str(x.location?.name),
        department: str(x.departments?.[0]?.name) || departments.get(str(x.id)) || '',
        remote: isRemote(x.location?.name),
        url: str(x.absolute_url),
        postedAt: iso(x.first_published ?? x.updated_at),
      }));
    }
    case 'lever': {
      const j = (await getJson(`https://api${eu ? '.eu' : ''}.lever.co/v0/postings/${id}?mode=json`)) as J;
      return ((Array.isArray(j) ? j : []) as J[]).map((x) => ({
        externalId: str(x.id),
        title: str(x.text),
        location: [str(x.categories?.location), ...((x.categories?.allLocations ?? []) as unknown[]).map(str)].filter((v, i, a) => v && a.indexOf(v) === i).join(' · '),
        department: str(x.categories?.team ?? x.categories?.department),
        remote: x.workplaceType === 'remote' || isRemote(x.categories?.location),
        url: str(x.hostedUrl),
        postedAt: iso(x.createdAt),
      }));
    }
    case 'ashby': {
      const j = (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${id}`)) as J;
      return ((j?.jobs ?? []) as J[])
        .filter((x) => x.isListed !== false)
        .map((x) => ({
          externalId: str(x.id ?? x.jobUrl),
          title: str(x.title),
          location: [str(x.location), ...((x.secondaryLocations ?? []) as J[]).map((l) => str(l.location))].filter(Boolean).join(' · '),
          department: str(x.department ?? x.team),
          remote: !!x.isRemote || x.workplaceType === 'Remote' || isRemote(x.location),
          url: str(x.jobUrl),
          postedAt: iso(x.publishedAt),
        }));
    }
    case 'workable': {
      const j = (await getJson(`https://apply.workable.com/api/v1/widget/accounts/${id}`)) as J;
      return ((j?.jobs ?? []) as J[]).map((x) => ({
        externalId: str(x.shortcode ?? x.id),
        title: str(x.title),
        location: [str(x.city), str(x.country)].filter(Boolean).join(', '),
        department: str(x.department),
        remote: !!x.telecommuting || isRemote(x.city),
        url: str(x.url ?? x.shortlink),
        postedAt: iso(x.published_on ?? x.created_at),
      }));
    }
    case 'smartrecruiters': {
      // Paged, 100 at a time. Read one past the cap so checkWatch can tell the list was cut short.
      const all: J[] = [];
      for (let offset = 0; all.length <= MAX_POSTINGS; ) {
        const j = (await getJson(`https://api.smartrecruiters.com/v1/companies/${id}/postings?limit=100${offset ? `&offset=${offset}` : ''}`)) as J;
        const page = (j?.content ?? []) as J[];
        all.push(...page);
        offset += page.length;
        if (!page.length || offset >= Number(j?.totalFound ?? 0)) break;
      }
      return all.map((x) => ({
        externalId: str(x.id),
        title: str(x.name),
        location: [str(x.location?.city), str(x.location?.country)?.toUpperCase()].filter(Boolean).join(', '),
        department: str(x.department?.label),
        remote: !!x.location?.remote,
        url: `https://jobs.smartrecruiters.com/${id}/${encodeURIComponent(str(x.id))}`,
        postedAt: iso(x.releasedDate),
      }));
    }
    case 'recruitee': {
      const j = (await getJson(`https://${id}.recruitee.com/api/offers/`)) as J;
      return ((j?.offers ?? []) as J[])
        .filter((x) => !x.status || x.status === 'published')
        .map((x) => ({
          externalId: str(x.id ?? x.slug),
          title: str(x.title),
          location: str(x.location) || [str(x.city), str(x.country)].filter(Boolean).join(', '),
          department: str(x.department),
          remote: !!x.remote || isRemote(x.location),
          url: str(x.careers_url) || `https://${id}.recruitee.com/o/${encodeURIComponent(str(x.slug))}`,
          postedAt: iso(x.published_at ?? x.created_at),
        }));
    }
  }
}

// Job sites that list other companies' roles, and the boards themselves: their name says
// nothing about the company, and guessing it would watch the site's own board instead.
const NOT_COMPANY_HOSTS = /(^|\.)(linkedin|indeed|glassdoor|wellfound|angel|ziprecruiter|monster|jobstreet|mycareersfuture|seek|jobsdb|google|greenhouse|lever|ashbyhq|workable|smartrecruiters)\.[a-z.]+$/;

/** Board names worth trying for a company: "Acme Labs", acme-labs.com → acmelabs, acme-labs. */
export function slugGuesses(company: string, url: URL | null): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const v = s.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (v.length >= 2 && !out.includes(v)) out.push(v);
  };
  // The name the user gave comes first: it is what they meant.
  add(company.replace(/\s+/g, ''));
  add(company.trim().replace(/\s+/g, '-'));
  if (url && !NOT_COMPANY_HOSTS.test(url.hostname.toLowerCase())) {
    const parts = url.hostname.replace(/^www\./, '').split('.');
    const label = parts.length > 2 && /^(careers|jobs|work)$/.test(parts[0]!) ? parts[1]! : parts[0]!;
    add(label);
    add(label.replace(/-/g, ''));
  }
  return out.slice(0, 4);
}

/** How many roles a board lists, or null when there is no such board. */
async function boardSize(b: Board): Promise<number | null> {
  try {
    return (await fetchPostings(b)).length;
  } catch {
    return null;
  }
}

/**
 * The board behind a careers link: from the link itself, from the page it points to,
 * or — for careers pages drawn in the browser — by trying the company's name on the
 * boards that most companies use.
 */
export async function resolveBoard(input: string, company = ''): Promise<Board> {
  const direct = findBoard(input);
  if (direct) return direct;
  let url: URL | null = null;
  if (input.trim()) {
    try {
      url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
      if (!url.hostname.includes('.')) url = null;
    } catch {
      url = null;
    }
  }
  if (url) {
    try {
      const res = await fetchText(url.toString());
      const found = res.status < 400 ? findBoard(res.body) : null;
      if (found) return found;
    } catch (err) {
      if (!(err instanceof FetchError)) throw err;
    }
  }
  // A guessed name can land on a board someone left behind, or on another company's that
  // shares the name. One that lists roles is the likelier match, so an empty board is only
  // the fallback when nothing else turns up.
  let empty: Board | null = null;
  for (const slug of slugGuesses(company, url)) {
    for (const ats of ['greenhouse', 'lever', 'ashby', 'recruitee'] as const) {
      const size = await boardSize({ ats, board: slug });
      if (size) return { ats, board: slug };
      if (size === 0) empty ??= { ats, board: slug };
    }
  }
  if (empty) return empty;
  throw new Invalid('Could not find a Greenhouse, Lever, Ashby, Workable, SmartRecruiters or Recruitee board for that company. Open one of its job links and paste that instead.');
}

// ── Preferences and matching ────────────────────────────────────────────────

const DEFAULT_PREFS: JobPreferences = { keywords: [], exclude: [], locations: [], remote: true, highlight: [] };

export function jobPreferences(store: Store): JobPreferences {
  return { ...DEFAULT_PREFS, ...(getIntegration(store, ID).settings.preferences as Partial<JobPreferences> | undefined) };
}

const has = (hay: string, needle: string) => {
  const n = needle.trim().toLowerCase();
  if (!n) return false;
  // Whole words, so "PM" matches "Senior PM" but not "Bitpanda PMO" by accident of letters.
  return new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i').test(hay);
};

export function matches(p: Pick<RawPosting, 'title' | 'location' | 'remote' | 'department'>, prefs: JobPreferences): boolean {
  const what = `${p.title} ${p.department}`;
  if (prefs.keywords.length && !prefs.keywords.some((k) => has(p.title, k))) return false;
  if (prefs.exclude.some((k) => has(what, k))) return false;
  if (prefs.locations.length && !prefs.locations.some((l) => has(p.location, l)) && !(prefs.remote && p.remote)) return false;
  return true;
}

// ── Watches ─────────────────────────────────────────────────────────────────

/** A role worth putting first: its company, title or team names something on the highlight list. */
export function highlighted(p: Pick<JobPosting, 'company' | 'title' | 'department'>, prefs: JobPreferences): boolean {
  const where = `${p.company} ${p.title} ${p.department}`;
  return prefs.highlight.some((k) => has(where, k));
}

const postingFromRow = (r: Row, prefs: JobPreferences): JobPosting => ({
  id: r.id,
  watchId: r.watch_id,
  company: r.company,
  title: r.title,
  location: r.location,
  department: r.department,
  remote: !!r.remote,
  url: r.url,
  postedAt: r.posted_at,
  firstSeenAt: r.first_seen_at,
  status: r.status,
  highlighted: highlighted({ company: r.company, title: r.title, department: r.department }, prefs),
});

export function listWatches(store: Store): JobWatch[] {
  return (
    store.db
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM job_postings p WHERE p.watch_id = w.id AND p.closed_at IS NULL) AS openings,
                (SELECT COUNT(*) FROM job_postings p WHERE p.watch_id = w.id AND p.closed_at IS NULL AND p.matched = 1 AND p.status != 'dismissed') AS matching
         FROM job_watches w ORDER BY lower(w.company)`,
      )
      .all() as Row[]
  ).map((r) => ({ id: r.id, company: r.company, careersUrl: r.careers_url, ats: r.ats, board: r.board, lastCheckedAt: r.last_checked_at, lastError: r.last_error, openings: r.openings, matching: r.matching }));
}

/** Open roles that match: highlighted ones first, then new, saved and the rest, newest first within each. */
export function listPostings(store: Store, opts: { includeDismissed?: boolean; limit?: number } = {}): JobPosting[] {
  const prefs = jobPreferences(store);
  const rows = (
    store.db
      .prepare(
        `SELECT p.*, w.company FROM job_postings p JOIN job_watches w ON w.id = p.watch_id
         WHERE p.closed_at IS NULL AND p.matched = 1 ${opts.includeDismissed ? '' : "AND p.status != 'dismissed'"}
         ORDER BY CASE p.status WHEN 'new' THEN 0 WHEN 'saved' THEN 1 ELSE 2 END, COALESCE(p.posted_at, p.first_seen_at) DESC LIMIT ?`,
      )
      .all(opts.limit ?? 200) as Row[]
  ).map((r) => postingFromRow(r, prefs));
  // Highlighted first, and within that, roles in your places before remote ones elsewhere.
  // A stable sort keeps the status and date order inside each group.
  const near = (p: JobPosting) => Number(!prefs.locations.length || prefs.locations.some((l) => has(p.location, l)));
  return rows.sort((a, b) => Number(b.highlighted) - Number(a.highlighted) || near(b) - near(a));
}

export async function addWatch(store: Store, company: string, careersUrl: string, quiet = false): Promise<JobWatch> {
  const board = await resolveBoard(careersUrl.trim(), company);
  const existing = store.db.prepare('SELECT id FROM job_watches WHERE ats = ? AND board = ?').get(board.ats, board.board) as Row | undefined;
  if (existing) return listWatches(store).find((w) => w.id === existing.id)!;
  // Prove the board is real before saving it, and keep what it lists as the quiet first
  // look, saved with the watch: a second fetch that failed would leave a watch with no
  // baseline, and its next check would alert on every role already open.
  const raw = await fetchPostings(board);
  const id = newId();
  const name = company.trim().slice(0, 80) || boardParts(board.board).slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  store.tx(() => {
    store.db.prepare('INSERT INTO job_watches (id, company, careers_url, ats, board, created_at) VALUES (?,?,?,?,?,?)').run(id, name, careersUrl.trim().slice(0, 500), board.ats, board.board, nowIso());
    recordPostings(store, store.db.prepare('SELECT * FROM job_watches WHERE id = ?').get(id) as Row, raw);
  });
  if (!getIntegration(store, ID).enabled) updateIntegration(store, ID, (r) => void (r.enabled = true));
  if (!quiet) store.record('created', 'job_watch', id, workSphere(store), `Watching ${name} for openings`);
  return listWatches(store).find((w) => w.id === id)!;
}

/** Re-apply preferences to what is on file, without alerting. */
export function rematch(store: Store): void {
  const prefs = jobPreferences(store);
  const rows = store.db.prepare('SELECT id, title, location, department, remote FROM job_postings WHERE closed_at IS NULL').all() as Row[];
  const set = store.db.prepare('UPDATE job_postings SET matched = ? WHERE id = ?');
  for (const r of rows) set.run(Number(matches({ title: r.title, location: r.location, department: r.department, remote: !!r.remote }, prefs)), r.id);
}

export function setPreferences(store: Store, p: Partial<JobPreferences>): JobPreferences {
  const tidy = (xs: string[] | undefined) => xs?.map((x) => x.trim().slice(0, 60)).filter(Boolean).slice(0, 30);
  const next: JobPreferences = { ...jobPreferences(store), ...Object.fromEntries(Object.entries({ keywords: tidy(p.keywords), exclude: tidy(p.exclude), locations: tidy(p.locations), remote: p.remote, highlight: tidy(p.highlight) }).filter(([, v]) => v !== undefined)) };
  updateIntegration(store, ID, (r) => void (r.settings = { ...r.settings, preferences: next }));
  rematch(store);
  return next;
}

/** Fetch one company's board. Returns the newly opened roles that match. */
export async function checkWatch(store: Store, watchId: string): Promise<JobPosting[]> {
  const w = store.db.prepare('SELECT * FROM job_watches WHERE id = ?').get(watchId) as Row | undefined;
  if (!w) throw new NotFound('Company');
  let raw: RawPosting[];
  try {
    raw = await fetchPostings({ ats: w.ats, board: w.board });
  } catch (err) {
    store.db.prepare('UPDATE job_watches SET last_checked_at = ?, last_error = ? WHERE id = ?').run(nowIso(), err instanceof Error ? err.message : String(err), watchId);
    throw err;
  }
  const found = recordPostings(store, w, raw);
  alert(store, w, found);
  return found;
}

/** Bring the roles on file in line with what the board lists. Returns the newly opened roles that match. */
function recordPostings(store: Store, w: Row, raw: RawPosting[]): JobPosting[] {
  const watchId = w.id as string;
  const first = !w.last_checked_at;
  const prefs = jobPreferences(store);
  const now = nowIso();
  const fresh: string[] = [];
  const seen = new Set<string>();
  const find = store.db.prepare('SELECT id, closed_at FROM job_postings WHERE watch_id = ? AND external_id = ?');
  const insert = store.db.prepare(
    'INSERT INTO job_postings (id, watch_id, external_id, title, location, department, remote, url, posted_at, first_seen_at, matched, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const update = store.db.prepare('UPDATE job_postings SET title = ?, location = ?, department = ?, remote = ?, url = ?, closed_at = NULL, matched = ? WHERE id = ?');
  for (const p of raw.slice(0, MAX_POSTINGS)) {
    if (!p.externalId || !p.title || seen.has(p.externalId)) continue;
    seen.add(p.externalId);
    const m = matches(p, prefs);
    const row = find.get(watchId, p.externalId) as Row | undefined;
    const url = /^https:\/\//.test(p.url) ? p.url.slice(0, 500) : '';
    if (row) {
      update.run(p.title.slice(0, 200), p.location.slice(0, 200), p.department.slice(0, 120), Number(p.remote), url, Number(m), row.id);
    } else {
      const id = newId();
      insert.run(id, watchId, p.externalId.slice(0, 200), p.title.slice(0, 200), p.location.slice(0, 200), p.department.slice(0, 120), Number(p.remote), url, p.postedAt, now, Number(m), first ? 'seen' : 'new');
      if (m && !first) fresh.push(id);
    }
  }
  // Roles that are no longer listed have closed — unless the list was cut short, when a
  // role past the cut is still open.
  if (raw.length <= MAX_POSTINGS) {
    const open = store.db.prepare('SELECT id, external_id FROM job_postings WHERE watch_id = ? AND closed_at IS NULL').all(watchId) as Row[];
    const close = store.db.prepare('UPDATE job_postings SET closed_at = ? WHERE id = ?');
    for (const r of open) if (!seen.has(r.external_id)) close.run(now, r.id);
  }
  store.db.prepare('UPDATE job_watches SET last_checked_at = ?, last_error = NULL WHERE id = ?').run(now, watchId);

  return fresh.map((id) => postingFromRow({ ...(store.db.prepare('SELECT * FROM job_postings WHERE id = ?').get(id) as Row), company: w.company }, prefs));
}

function alert(store: Store, w: Row, found: JobPosting[]): void {
  if (!found.length) return;
  const sphereId = workSphere(store);
  // With a highlight list, the roles on it stay important and the rest step down to normal.
  const picky = jobPreferences(store).highlight.length > 0;
  const priority = (ps: JobPosting[]) => (!picky || ps.some((p) => p.highlighted) ? 2 : 1);
  if (found.length <= 3) {
    for (const p of found) {
      const actions: SignalAction[] = [];
      if (p.url) actions.push({ type: 'link', label: 'Open the posting', url: p.url });
      actions.push({ type: 'task', label: 'Add as a task', title: `Apply: ${p.title} at ${w.company}`, sphereId });
      addSignal(store, {
        source: ID,
        kind: 'opening',
        externalId: `${w.id}:${p.id}`,
        title: `${w.company} is hiring: ${p.title}`,
        body: [p.location, p.remote ? 'remote' : '', p.department].filter(Boolean).join(' · '),
        url: p.url,
        sphereId,
        priority: priority([p]),
        actions,
        data: { postingId: p.id },
      });
    }
  } else {
    addSignal(store, {
      source: ID,
      kind: 'openings',
      externalId: `${w.id}:batch:${found.map((p) => p.id).sort()[0]}`,
      title: `${found.length} new roles at ${w.company} that fit`,
      body: found
        .slice(0, 6)
        .map((p) => `${p.title}${p.location ? ` (${p.location})` : ''}`)
        .join('\n'),
      sphereId,
      priority: priority(found),
      actions: [{ type: 'task', label: 'Add as a task', title: `Look at the new ${w.company} roles`, sphereId }],
    });
  }
}

/** The background job: every company, one at a time, a failure on one does not stop the rest. */
export async function checkAll(store: Store): Promise<{ checked: number; found: number; failed: number }> {
  const ids = (store.db.prepare('SELECT id FROM job_watches ORDER BY last_checked_at').all() as Row[]).map((r) => r.id as string);
  let found = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      found += (await checkWatch(store, id)).length;
    } catch {
      failed++;
    }
  }
  if (failed && failed === ids.length) throw new Error('Could not reach any of the job boards');
  return { checked: ids.length, found, failed };
}

export function jobsState(store: Store, running = false): JobsState {
  return { preferences: jobPreferences(store), watches: listWatches(store), postings: listPostings(store), running, lastRunAt: getIntegration(store, ID).lastRunAt };
}

registerUndo('created:job_watch', (db, id) => void db.prepare('DELETE FROM job_watches WHERE id = ?').run(id));

// ── Agent ───────────────────────────────────────────────────────────────────

registerSnapshotSection<Store>('Job alerts', (store) => {
  const watches = listWatches(store);
  if (!watches.length) return null;
  const prefs = jobPreferences(store);
  const fresh = listPostings(store, { limit: 50 }).filter((p) => p.status === 'new' || p.status === 'saved');
  const lines = [`Watching ${watches.map((w) => w.company).join(', ')} for ${prefs.keywords.length ? prefs.keywords.join(' / ') : 'any role'}${prefs.locations.length ? ` in ${prefs.locations.join(' / ')}${prefs.remote ? ' or remote' : ''}` : ''}.`];
  // Titles and places come from the companies' job boards: outside text, fenced as such.
  if (prefs.highlight.length) lines.push(`Highlighting roles at or about: ${prefs.highlight.join(' / ')}.`);
  const roles = fresh.slice(0, 8).map((p) => `${p.status === 'saved' ? 'Saved' : 'New'}${p.highlighted ? ', highlighted' : ''}: ${p.title} at ${p.company}${p.location ? ` (${p.location})` : ''}.`);
  if (roles.length) lines.push(wrapUntrusted('job boards', roles.join('\n'), 4000));
  return lines.join('\n');
});

const list = z.array(z.string().max(60)).max(30);

registerFeature({
  id: ID,
  tables: ['job_watches', 'job_postings'],
  integration: { configured: () => true },
  jobs: [{ id: ID, everyMs: 6 * 3_600_000, run: async (store) => void (await checkAll(store)) }],
  tools: [
    tool(
      'list_job_openings',
      'Read the companies the user watches for jobs, their title and location preferences, and the open roles that match (new ones first).',
      z.object({}),
      (_, { store }) => {
        const s = jobsState(store);
        const mine = { preferences: s.preferences, companies: s.watches.map((w) => ({ company: w.company, openings: w.openings, matching: w.matching, error: w.lastError ?? undefined })) };
        // The roles are read from the companies' job boards: the agent sees them fenced as untrusted.
        const roles = s.postings.slice(0, 40).map((p) => ({ title: p.title, company: p.company, location: p.location, remote: p.remote || undefined, status: p.status, highlighted: p.highlighted || undefined, url: p.url, posted: p.postedAt?.slice(0, 10) }));
        return { data: `${JSON.stringify(mine)}\n\nOpen roles that match:\n${wrapUntrusted('job boards', JSON.stringify(roles), 16_000)}`, summary: 'Read job alerts' };
      },
    ),
    tool(
      'watch_company_for_jobs',
      'Start watching a company for openings. Give its careers page or job-board link (Greenhouse, Lever, Ashby, Workable, SmartRecruiters or Recruitee) when known; with only a name, Terminus tries the usual boards. Only for companies the user named.',
      z.object({ company: z.string().min(1).max(80), careers_url: z.string().max(500).default('') }),
      async ({ company, careers_url }, { store }) => {
        const w = await addWatch(store, company, careers_url);
        return { data: { ok: true, company: w.company, board: `${w.ats}:${w.board}`, openings: w.openings, matching: w.matching }, summary: `Watching ${w.company}` };
      },
    ),
    tool(
      'set_job_preferences',
      'Set which roles count: title keywords (any of), words to exclude, locations (any of), whether remote roles count anywhere, and what to highlight (companies, or words in a title or team, whose roles come first). Only what the user asked for.',
      z.object({ keywords: list.optional(), exclude: list.optional(), locations: list.optional(), remote: z.boolean().optional(), highlight: list.optional() }),
      (p, { store }) => ({ data: setPreferences(store, p), summary: 'Updated job preferences' }),
    ),
  ],
  routes: (app, { store, scheduler }) => {
    const state = () => jobsState(store, scheduler.isRunning(ID));
    app.get('/api/jobs', (c) => c.json(state()));
    app.put('/api/jobs/preferences', async (c) => {
      setPreferences(store, await read(c, z.object({ keywords: list, exclude: list, locations: list, remote: z.boolean(), highlight: list }).partial()));
      return c.json(state());
    });
    app.post('/api/jobs/watches', async (c) => {
      const { company, url } = await read(c, z.object({ company: z.string().max(80).default(''), url: z.string().max(500).default('') }).refine((v) => v.company.trim() || v.url.trim(), 'Give a company name or a careers link'));
      await addWatch(store, company, url);
      return c.json(state(), 201);
    });
    app.delete('/api/jobs/watches/:id', (c) => {
      if (!store.db.prepare('DELETE FROM job_watches WHERE id = ?').run(c.req.param('id')).changes) throw new NotFound('Company');
      return c.json(state());
    });
    app.patch('/api/jobs/postings/:id', async (c) => {
      const { status } = await read(c, z.object({ status: z.enum(['seen', 'saved', 'dismissed']) }));
      if (!store.db.prepare('UPDATE job_postings SET status = ? WHERE id = ?').run(status, c.req.param('id')).changes) throw new NotFound('Role');
      return c.json(state());
    });
  },
});
