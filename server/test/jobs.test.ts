import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSnapshot } from '../src/agent/prompt.ts';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { addWatch, checkAll, fetchPostings, findBoard, slugGuesses, listPostings, matches, setJobFetcher, setPreferences } from '../src/features/job-alerts.ts';
import { listSignals } from '../src/features/signals.ts';
import { Store } from '../src/store.ts';
import type { JobsState } from '../../shared/types.ts';

function jobsStore(): Store {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['work'] });
  return store;
}

/** A fake internet of job boards. */
function boards(pages: Record<string, unknown>) {
  const asked: string[] = [];
  setJobFetcher(async (url) => {
    asked.push(url);
    const hit = pages[url];
    if (hit === undefined) return { status: 404, body: 'not found' };
    return { status: 200, body: typeof hit === 'string' ? hit : JSON.stringify(hit) };
  });
  return asked;
}

const gh = (jobs: { id: number; title: string; location: string }[]) => ({ jobs: jobs.map((j) => ({ ...j, location: { name: j.location }, absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${j.id}`, updated_at: '2026-11-10T00:00:00Z' })) });
const GH = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs';

test('finds the job board in a link or a careers page', () => {
  assert.deepEqual(findBoard('https://boards.greenhouse.io/stripe/jobs/123'), { ats: 'greenhouse', board: 'stripe' });
  assert.deepEqual(findBoard('https://job-boards.greenhouse.io/anthropic'), { ats: 'greenhouse', board: 'anthropic' });
  assert.deepEqual(findBoard('<script src="https://boards.greenhouse.io/embed/job_board/js?for=grab"></script>'), { ats: 'greenhouse', board: 'grab' });
  assert.deepEqual(findBoard('https://jobs.lever.co/shopback/abc-123'), { ats: 'lever', board: 'shopback' });
  assert.deepEqual(findBoard('https://jobs.ashbyhq.com/linear'), { ats: 'ashby', board: 'linear' });
  assert.deepEqual(findBoard('https://apply.workable.com/carousell/'), { ats: 'workable', board: 'carousell' });
  assert.deepEqual(findBoard('https://jobs.smartrecruiters.com/Visa/7438'), { ats: 'smartrecruiters', board: 'Visa' });
  assert.deepEqual(findBoard('lever:figma'), { ats: 'lever', board: 'figma' });
  assert.equal(findBoard('https://example.com/careers'), null);
  assert.deepEqual(slugGuesses('Acme Labs', new URL('https://careers.acme-labs.com/open-roles')), ['acme-labs', 'acmelabs']);
});

test('matching: title keywords as whole words, exclusions, places, remote anywhere', () => {
  const prefs = { keywords: ['product designer', 'design lead'], exclude: ['intern'], locations: ['Singapore'], remote: true };
  assert.equal(matches({ title: 'Senior Product Designer', location: 'Singapore', department: 'Design', remote: false }, prefs), true);
  assert.equal(matches({ title: 'Product Designer', location: 'London', department: '', remote: false }, prefs), false);
  assert.equal(matches({ title: 'Product Designer', location: 'Anywhere', department: '', remote: true }, prefs), true);
  assert.equal(matches({ title: 'Product Designer Intern', location: 'Singapore', department: '', remote: false }, prefs), false);
  assert.equal(matches({ title: 'Software Engineer', location: 'Singapore', department: '', remote: false }, prefs), false);
  assert.equal(matches({ title: 'Anything', location: 'Mars', department: '', remote: false }, { keywords: [], exclude: [], locations: [], remote: false }), true);
});

test('each board API is read into the same shape', async () => {
  boards({
    'https://api.lever.co/v0/postings/acme?mode=json': [{ id: 'l1', text: 'Design Lead', hostedUrl: 'https://jobs.lever.co/acme/l1', categories: { location: 'Singapore', team: 'Design' }, createdAt: 1_762_000_000_000, workplaceType: 'hybrid' }],
    'https://api.ashbyhq.com/posting-api/job-board/acme': { jobs: [{ id: 'a1', title: 'Staff Designer', location: 'Remote — APAC', department: 'Design', jobUrl: 'https://jobs.ashbyhq.com/acme/a1', publishedAt: '2026-11-01T00:00:00Z', isRemote: true }, { id: 'a2', title: 'Hidden', isListed: false }] },
    'https://apply.workable.com/api/v1/widget/accounts/acme': { jobs: [{ shortcode: 'W1', title: 'UX Researcher', city: 'Singapore', country: 'Singapore', url: 'https://apply.workable.com/j/W1', published_on: '2026-11-02' }] },
    'https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100': { content: [{ id: '743', name: 'Design Manager', location: { city: 'Singapore', country: 'sg', remote: false }, department: { label: 'Design' }, releasedDate: '2026-11-03T00:00:00Z' }] },
  });
  const [lever] = await fetchPostings({ ats: 'lever', board: 'acme' });
  assert.deepEqual(lever, { externalId: 'l1', title: 'Design Lead', location: 'Singapore', department: 'Design', remote: false, url: 'https://jobs.lever.co/acme/l1', postedAt: new Date(1_762_000_000_000).toISOString() });
  const ashby = await fetchPostings({ ats: 'ashby', board: 'acme' });
  assert.equal(ashby.length, 1, 'unlisted roles are skipped');
  assert.equal(ashby[0]!.remote, true);
  assert.equal((await fetchPostings({ ats: 'workable', board: 'acme' }))[0]!.location, 'Singapore, Singapore');
  const sr = (await fetchPostings({ ats: 'smartrecruiters', board: 'acme' }))[0]!;
  assert.equal(sr.url, 'https://jobs.smartrecruiters.com/acme/743');
  assert.equal(sr.location, 'Singapore, SG');
  await assert.rejects(fetchPostings({ ats: 'greenhouse', board: 'nobody' }), /does not exist/);
});

test('the first check records what is open quietly; later, new roles that fit become signals; closed roles drop off', async () => {
  const store = jobsStore();
  setPreferences(store, { keywords: ['designer'], locations: ['Singapore'], remote: true });
  const pages: Record<string, unknown> = {
    'https://acme.example/careers': '<a href="https://boards.greenhouse.io/acme/jobs/1">Jobs</a>',
    [GH]: gh([
      { id: 1, title: 'Product Designer', location: 'Singapore' },
      { id: 2, title: 'Backend Engineer', location: 'Singapore' },
    ]),
  };
  boards(pages);
  const w = await addWatch(store, 'Acme', 'https://acme.example/careers');
  assert.deepEqual([w.ats, w.board, w.openings, w.matching], ['greenhouse', 'acme', 2, 1]);
  assert.equal(listSignals(store).length, 0, 'nothing alerts on the first look');
  assert.equal(listPostings(store)[0]!.status, 'seen');

  pages[GH] = gh([
    { id: 2, title: 'Backend Engineer', location: 'Singapore' },
    { id: 3, title: 'Senior Product Designer', location: 'Singapore' },
    { id: 4, title: 'Designer, Growth', location: 'Remote' },
    { id: 5, title: 'Designer', location: 'Berlin' },
  ]);
  assert.deepEqual(await checkAll(store), { checked: 1, found: 2, failed: 0 });
  const sigs = listSignals(store);
  assert.deepEqual(sigs.map((s) => s.title).sort(), ['Acme is hiring: Designer, Growth', 'Acme is hiring: Senior Product Designer']);
  assert.equal(sigs[0]!.sphereId, store.listSpheres()[0]!.id);
  assert.deepEqual(sigs[0]!.actions.map((a) => a.type), ['link', 'task']);
  const open = listPostings(store);
  assert.deepEqual(open.map((p) => p.title).sort(), ['Designer, Growth', 'Senior Product Designer'], 'role 1 closed; Berlin does not fit');
  assert.ok(open.every((p) => p.status === 'new'));
  assert.equal(await checkAll(store).then((r) => r.found), 0, 'the same roles do not alert twice');

  // Widening the places re-sorts what is on file without new alerts.
  setPreferences(store, { locations: ['Singapore', 'Berlin'] });
  assert.equal(listPostings(store).length, 3);
  assert.equal(listSignals(store).length, 2);

  const snap = renderSnapshot(store, '2026-11-14');
  assert.match(snap, /JOB ALERTS/);
  assert.match(snap, /Watching Acme for designer in Singapore \/ Berlin or remote/);
});

test('many new roles at once become one signal', async () => {
  const store = jobsStore();
  const pages: Record<string, unknown> = { [GH]: gh([]) };
  boards(pages);
  await addWatch(store, '', 'greenhouse:acme');
  pages[GH] = gh([1, 2, 3, 4, 5].map((id) => ({ id, title: `Role ${id}`, location: 'Singapore' })));
  await checkAll(store);
  const sigs = listSignals(store);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0]!.title, '5 new roles at Acme that fit');
});

test('jobs API: add by careers link, preferences, save and dismiss, remove; a page with no board says so', async () => {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.onboard({ userName: '', agentName: 'Seldon', sphereKeys: ['work'] });
  const app = createApp({ db });
  boards({
    [GH]: gh([{ id: 1, title: 'Design Lead', location: 'Singapore' }]),
    'https://nothing.example/careers': '<html>We are hiring! Email us.</html>',
    'https://api.lever.co/v0/postings/shopback?mode=json': [],
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://localhost/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as JobsState & { error?: string } };
  };
  const added = await call('POST', '/jobs/watches', { company: 'Acme', url: 'https://boards.greenhouse.io/acme' });
  assert.equal(added.status, 201);
  assert.equal(added.json.watches[0]!.company, 'Acme');
  assert.equal(added.json.postings[0]!.title, 'Design Lead');
  const none = await call('POST', '/jobs/watches', { company: 'Nothing', url: 'https://nothing.example/careers' });
  assert.equal(none.status, 400);
  assert.match(none.json.error!, /Could not find a Greenhouse/);
  // A careers page drawn in the browser: the company's name is tried on the usual boards.
  const lever = await call('POST', '/jobs/watches', { company: 'Shop Back', url: '' });
  assert.equal(lever.status, 201);
  assert.deepEqual(lever.json.watches.map((w) => `${w.ats}:${w.board}`).sort(), ['greenhouse:acme', 'lever:shopback']);
  let s = (await call('PUT', '/jobs/preferences', { keywords: ['engineer'] })).json;
  assert.equal(s.postings.length, 0);
  s = (await call('PUT', '/jobs/preferences', { keywords: [] })).json;
  const id = s.postings[0]!.id;
  s = (await call('PATCH', `/jobs/postings/${id}`, { status: 'saved' })).json;
  assert.equal(s.postings[0]!.status, 'saved');
  s = (await call('PATCH', `/jobs/postings/${id}`, { status: 'dismissed' })).json;
  assert.equal(s.postings.length, 0);
  s = (await call('DELETE', `/jobs/watches/${s.watches[0]!.id}`)).json;
  assert.deepEqual(s.watches.map((w) => w.company), ['Shop Back']);
});
