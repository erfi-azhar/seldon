// Job alerts: watch the companies you would work for and hear when a role that fits
// opens. Most companies post through an applicant-tracking system with a public job
// board API — Greenhouse, Lever, Ashby, Workable, SmartRecruiters — so Terminus reads
// those directly, no scraping and no account. Give it a careers page and it finds the
// board behind it.
//
// The first check of a company records what is already open without alerting; after
// that, each new role that matches your titles and places becomes a signal in Work.

import { z } from 'zod';
import { registerSnapshotSection } from '../agent/snapshot-hooks.ts';
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
  board: string;
}

const PATTERNS: [JobBoardKind, RegExp][] = [
  ['greenhouse', /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([A-Za-z0-9_-]+)/],
  ['greenhouse', /boards-api\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9_-]+)/],
  ['lever', /jobs\.(?:eu\.)?lever\.co\/([A-Za-z0-9_.-]+)/],
  ['lever', /api\.lever\.co\/v0\/postings\/([A-Za-z0-9_.-]+)/],
  ['ashby', /jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)/],
  ['ashby', /api\.ashbyhq\.com\/posting-api\/job-board\/([A-Za-z0-9_.%-]+)/],
  ['workable', /apply\.workable\.com\/(?:api\/v[13]\/(?:widget\/)?accounts\/)?([A-Za-z0-9_-]+)/],
  ['smartrecruiters', /(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/],
  ['smartrecruiters', /api\.smartrecruiters\.com\/v1\/companies\/([A-Za-z0-9_-]+)/],
];
const NOT_BOARDS = new Set(['embed', 'api', 'v0', 'v1', 'js', 'oauth', 'static']);

/** A job board in a URL or a page: "boards.greenhouse.io/stripe", "jobs.lever.co/acme", "greenhouse:stripe". */
export function findBoard(text: string): Board | null {
  const short = /^(greenhouse|lever|ashby|workable|smartrecruiters):([A-Za-z0-9_.-]+)$/i.exec(text.trim());
  if (short) return { ats: short[1]!.toLowerCase() as JobBoardKind, board: short[2]! };
  for (const [ats, re] of PATTERNS) {
    const m = re.exec(text);
    if (m && !NOT_BOARDS.has(m[1]!.toLowerCase())) return { ats, board: decodeURIComponent(m[1]!) };
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

export async function fetchPostings(b: Board): Promise<RawPosting[]> {
  const id = encodeURIComponent(b.board);
  switch (b.ats) {
    case 'greenhouse': {
      const j = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${id}/jobs`)) as J;
      return ((j?.jobs ?? []) as J[]).map((x) => ({
        externalId: str(x.id),
        title: str(x.title),
        location: str(x.location?.name),
        department: str(x.departments?.[0]?.name),
        remote: isRemote(x.location?.name),
        url: str(x.absolute_url),
        postedAt: iso(x.first_published ?? x.updated_at),
      }));
    }
    case 'lever': {
      const j = (await getJson(`https://api.lever.co/v0/postings/${id}?mode=json`)) as J;
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
      const j = (await getJson(`https://api.smartrecruiters.com/v1/companies/${id}/postings?limit=100`)) as J;
      return ((j?.content ?? []) as J[]).map((x) => ({
        externalId: str(x.id),
        title: str(x.name),
        location: [str(x.location?.city), str(x.location?.country)?.toUpperCase()].filter(Boolean).join(', '),
        department: str(x.department?.label),
        remote: !!x.location?.remote,
        url: `https://jobs.smartrecruiters.com/${id}/${encodeURIComponent(str(x.id))}`,
        postedAt: iso(x.releasedDate),
      }));
    }
  }
}

/** Board names worth trying for a company: "Acme Labs", acme-labs.com → acmelabs, acme-labs. */
export function slugGuesses(company: string, url: URL | null): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const v = s.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (v.length >= 2 && !out.includes(v)) out.push(v);
  };
  if (url) {
    const parts = url.hostname.replace(/^www\./, '').split('.');
    const label = parts.length > 2 && /^(careers|jobs|work)$/.test(parts[0]!) ? parts[1]! : parts[0]!;
    add(label);
    add(label.replace(/-/g, ''));
  }
  add(company.replace(/\s+/g, ''));
  add(company.trim().replace(/\s+/g, '-'));
  return out.slice(0, 4);
}

async function boardExists(b: Board): Promise<boolean> {
  try {
    await fetchPostings(b);
    return true;
  } catch {
    return false;
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
  for (const slug of slugGuesses(company, url)) {
    for (const ats of ['greenhouse', 'lever', 'ashby'] as const) {
      if (await boardExists({ ats, board: slug })) return { ats, board: slug };
    }
  }
  throw new Invalid('Could not find a Greenhouse, Lever, Ashby, Workable or SmartRecruiters board for that company. Open one of its job links and paste that instead.');
}

// ── Preferences and matching ────────────────────────────────────────────────

const DEFAULT_PREFS: JobPreferences = { keywords: [], exclude: [], locations: [], remote: true };

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

const postingFromRow = (r: Row): JobPosting => ({
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

export function listPostings(store: Store, opts: { includeDismissed?: boolean; limit?: number } = {}): JobPosting[] {
  return (
    store.db
      .prepare(
        `SELECT p.*, w.company FROM job_postings p JOIN job_watches w ON w.id = p.watch_id
         WHERE p.closed_at IS NULL AND p.matched = 1 ${opts.includeDismissed ? '' : "AND p.status != 'dismissed'"}
         ORDER BY CASE p.status WHEN 'new' THEN 0 WHEN 'saved' THEN 1 ELSE 2 END, COALESCE(p.posted_at, p.first_seen_at) DESC LIMIT ?`,
      )
      .all(opts.limit ?? 200) as Row[]
  ).map(postingFromRow);
}

export async function addWatch(store: Store, company: string, careersUrl: string, quiet = false): Promise<JobWatch> {
  const board = await resolveBoard(careersUrl.trim(), company);
  const existing = store.db.prepare('SELECT id FROM job_watches WHERE ats = ? AND board = ?').get(board.ats, board.board) as Row | undefined;
  if (existing) return listWatches(store).find((w) => w.id === existing.id)!;
  // Prove the board is real before saving it.
  await fetchPostings(board);
  const id = newId();
  const name = company.trim().slice(0, 80) || board.board.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  store.db.prepare('INSERT INTO job_watches (id, company, careers_url, ats, board, created_at) VALUES (?,?,?,?,?,?)').run(id, name, careersUrl.trim().slice(0, 500), board.ats, board.board, nowIso());
  if (!getIntegration(store, ID).enabled) updateIntegration(store, ID, (r) => void (r.enabled = true));
  if (!quiet) store.record('created', 'job_watch', id, workSphere(store), `Watching ${name} for openings`);
  await checkWatch(store, id);
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
  const next: JobPreferences = { ...jobPreferences(store), ...Object.fromEntries(Object.entries({ keywords: tidy(p.keywords), exclude: tidy(p.exclude), locations: tidy(p.locations), remote: p.remote }).filter(([, v]) => v !== undefined)) };
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
  for (const p of raw.slice(0, 2000)) {
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
  // Roles that are no longer listed have closed.
  const open = store.db.prepare('SELECT id, external_id FROM job_postings WHERE watch_id = ? AND closed_at IS NULL').all(watchId) as Row[];
  const close = store.db.prepare('UPDATE job_postings SET closed_at = ? WHERE id = ?');
  for (const r of open) if (!seen.has(r.external_id)) close.run(now, r.id);
  store.db.prepare('UPDATE job_watches SET last_checked_at = ?, last_error = NULL WHERE id = ?').run(now, watchId);

  const found = fresh.map((id) => postingFromRow({ ...(store.db.prepare('SELECT * FROM job_postings WHERE id = ?').get(id) as Row), company: w.company }));
  alert(store, w, found);
  return found;
}

function alert(store: Store, w: Row, found: JobPosting[]): void {
  if (!found.length) return;
  const sphereId = workSphere(store);
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
        priority: 2,
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
      priority: 2,
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
  for (const p of fresh.slice(0, 8)) lines.push(`${p.status === 'saved' ? 'Saved' : 'New'}: ${p.title} at ${p.company}${p.location ? ` (${p.location})` : ''}.`);
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
        return { data: { preferences: s.preferences, companies: s.watches.map((w) => ({ company: w.company, openings: w.openings, matching: w.matching, error: w.lastError ?? undefined })), roles: s.postings.slice(0, 40).map((p) => ({ title: p.title, company: p.company, location: p.location, remote: p.remote || undefined, status: p.status, url: p.url, posted: p.postedAt?.slice(0, 10) })) }, summary: 'Read job alerts' };
      },
    ),
    tool(
      'watch_company_for_jobs',
      'Start watching a company for openings. Give its careers page or job-board link (Greenhouse, Lever, Ashby, Workable or SmartRecruiters) when known; with only a name, Terminus tries the usual boards. Only for companies the user named.',
      z.object({ company: z.string().min(1).max(80), careers_url: z.string().max(500).default('') }),
      async ({ company, careers_url }, { store }) => {
        const w = await addWatch(store, company, careers_url);
        return { data: { ok: true, company: w.company, board: `${w.ats}:${w.board}`, openings: w.openings, matching: w.matching }, summary: `Watching ${w.company}` };
      },
    ),
    tool(
      'set_job_preferences',
      'Set which roles count: title keywords (any of), words to exclude, locations (any of), and whether remote roles count anywhere. Only what the user asked for.',
      z.object({ keywords: list.optional(), exclude: list.optional(), locations: list.optional(), remote: z.boolean().optional() }),
      (p, { store }) => ({ data: setPreferences(store, p), summary: 'Updated job preferences' }),
    ),
  ],
  routes: (app, { store, scheduler }) => {
    const state = () => jobsState(store, scheduler.isRunning(ID));
    app.get('/api/jobs', (c) => c.json(state()));
    app.put('/api/jobs/preferences', async (c) => {
      setPreferences(store, await read(c, z.object({ keywords: list, exclude: list, locations: list, remote: z.boolean() }).partial()));
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
