// Job alerts, in the Work sphere: the open roles that fit come first, new ones on top.
// The companies behind them fold into one line; the full list, grouped by how each
// board is doing, lives in a sheet — so a long watch list never buries the roles.

import { Bookmark, BookmarkCheck, Briefcase, CircleAlert, ExternalLink, Plus, RefreshCw, Search, SlidersHorizontal, Star, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JobBoardKind, JobPosting, JobPreferences, JobsState, JobWatch } from '../../../shared/types.ts';
import { jobsWrite, useJobs, useWrite } from '../api.ts';
import { cx, plural, timeAgo } from '../lib.ts';
import { useApp } from '../state.tsx';
import { AutoTextarea, Check, Field, Modal, Spinner } from './ui.tsx';

const join = (xs: string[]) => xs.join(', ');
const split = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

const ATS: Record<JobBoardKind, string> = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable', smartrecruiters: 'SmartRecruiters', recruitee: 'Recruitee' };

/** The public page of a watched board, so a doubtful match can be checked by eye. */
function boardUrl(w: JobWatch): string {
  const eu = w.board.startsWith('eu:');
  const slug = encodeURIComponent(eu ? w.board.slice(3) : w.board);
  switch (w.ats) {
    case 'greenhouse':
      return `https://job-boards${eu ? '.eu' : ''}.greenhouse.io/${slug}`;
    case 'lever':
      return `https://jobs${eu ? '.eu' : ''}.lever.co/${slug}`;
    case 'ashby':
      return `https://jobs.ashbyhq.com/${slug}`;
    case 'workable':
      return `https://apply.workable.com/${slug}/`;
    case 'smartrecruiters':
      return `https://jobs.smartrecruiters.com/${slug}`;
    case 'recruitee':
      return `https://${slug}.recruitee.com/`;
  }
}

/** fits: has roles that match. watching: has roles, none match yet. quiet: lists nothing, or could not be read. */
type Health = 'fits' | 'watching' | 'quiet';
const health = (w: JobWatch): Health => (w.lastError || w.openings === 0 ? 'quiet' : w.matching > 0 ? 'fits' : 'watching');

function group(watches: JobWatch[]) {
  const by = (h: Health) => watches.filter((w) => health(w) === h);
  return { fits: by('fits').sort((a, b) => b.matching - a.matching || a.company.localeCompare(b.company)), watching: by('watching'), quiet: by('quiet') };
}

/** A two-step button: the first press asks, the second does it. It stands down after a few seconds. */
function useArmed(): [boolean, () => void, () => void] {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return [armed, () => setArmed(true), () => setArmed(false)];
}

/**
 * A box that scrolls on one axis, and which of its ends still hide something — so the
 * fade can sit only where there is more to see.
 */
function useScrollEdges<T extends HTMLElement>(axis: 'x' | 'y', deps: unknown[]) {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const [pos, size, total] = axis === 'y' ? [el.scrollTop, el.clientHeight, el.scrollHeight] : [el.scrollLeft, el.clientWidth, el.scrollWidth];
    const start = pos > 2;
    const end = pos + size < total - 2;
    setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
  }, [axis]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    // Rows wrap and grow with the width, so watch the content as well as the box.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update, ...deps]);
  const fade = cx(edges.start && 'fade-start', edges.end && 'fade-end');
  return { ref, onScroll: update, fade, scrolls: edges.start || edges.end };
}

function PreferencesSheet({ prefs, onClose }: { prefs: JobPreferences; onClose: () => void }) {
  const [f, setF] = useState({ keywords: join(prefs.keywords), exclude: join(prefs.exclude), locations: join(prefs.locations), remote: prefs.remote, highlight: join(prefs.highlight) });
  const save = useWrite(jobsWrite.preferences);
  return (
    <Modal
      title="Roles that fit"
      onClose={onClose}
      footer={
        <>
          <span className="hint">Separate with commas.</span>
          <button className="btn btn-primary btn-sm" onClick={() => save.mutate({ keywords: split(f.keywords), exclude: split(f.exclude), locations: split(f.locations), remote: f.remote, highlight: split(f.highlight) }, { onSuccess: onClose })}>
            Save
          </button>
        </>
      }
    >
      <Field label="Titles" hint="A role fits when its title has one of these. Empty means any role.">
        <AutoTextarea className="textarea" value={f.keywords} onChange={(keywords) => setF({ ...f, keywords })} placeholder="Product designer, Design lead, Head of design" data-autofocus />
      </Field>
      <Field label="Leave out" hint="Titles or teams with these words are skipped.">
        <AutoTextarea className="textarea" value={f.exclude} onChange={(exclude) => setF({ ...f, exclude })} placeholder="Intern, Contract" />
      </Field>
      <Field label="Places" hint="Empty means anywhere.">
        <input className="input" value={f.locations} onChange={(e) => setF({ ...f, locations: e.target.value })} placeholder="Singapore, APAC" />
      </Field>
      <label className="row" style={{ gap: 10, fontSize: 14 }}>
        <Check checked={f.remote} onChange={(remote) => setF({ ...f, remote })} label="Remote roles count" /> Remote roles count wherever they are
      </label>
      <Field label="Highlight" hint="Roles at these companies, or with these words in the title or team, come first and alert as important.">
        <AutoTextarea className="textarea" value={f.highlight} onChange={(highlight) => setF({ ...f, highlight })} placeholder="GovTech, Wise, Payments, Government" />
      </Field>
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

function WatchSheet({ known, onClose }: { known: JobWatch[]; onClose: () => void }) {
  const [company, setCompany] = useState('');
  const [url, setUrl] = useState('');
  // A board that lists nothing is often the wrong one: say so before it joins the list.
  const [empty, setEmpty] = useState<JobWatch | null>(null);
  const add = useWrite(jobsWrite.watch);
  const unwatch = useWrite(jobsWrite.unwatch);
  const submit = () =>
    add.mutate(
      { company, url },
      {
        onSuccess: (s) => {
          const added = s.watches.find((w) => !known.some((k) => k.id === w.id));
          if (added && added.openings === 0 && !added.lastError) setEmpty(added);
          else onClose();
        },
      },
    );

  if (empty)
    return (
      <Modal
        title="Watch a company"
        onClose={onClose}
        footer={
          <>
            <button className="btn btn-danger btn-sm" disabled={unwatch.isPending} onClick={() => unwatch.mutate(empty.id, { onSuccess: onClose })}>
              Remove it
            </button>
            <button className="btn btn-primary btn-sm" onClick={onClose} data-autofocus>
              Keep watching
            </button>
          </>
        }
      >
        <p className="jobs-empty-note">
          <CircleAlert size={16} />
          <span>
            Watching <b>{empty.company}</b>, but{' '}
            <a href={boardUrl(empty)} target="_blank" rel="noreferrer noopener">
              its {ATS[empty.ats]} board
            </a>{' '}
            lists no roles right now. It may be an old board, or another company's with the same name. To be sure, remove it and paste a link to one of its job posts.
          </span>
        </p>
      </Modal>
    );

  return (
    <Modal
      title="Watch a company"
      onClose={onClose}
      footer={
        <>
          <span className="hint">Checked every six hours.</span>
          <button className="btn btn-primary btn-sm" disabled={add.isPending || (!company.trim() && !url.trim())} onClick={submit}>
            {add.isPending ? <Spinner /> : 'Watch'}
          </button>
        </>
      }
    >
      <Field label="Company">
        <input className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Grab" data-autofocus />
      </Field>
      <Field label="Careers page or a job link" hint="Greenhouse, Lever, Ashby, Workable, SmartRecruiters and Recruitee boards work. With just a name, Terminus tries the usual boards.">
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://jobs.lever.co/… or the company's careers page" />
      </Field>
      {add.error && <p className="error-text">{add.error.message}</p>}
    </Modal>
  );
}

function watchNote(w: JobWatch): string {
  if (w.lastError) return `Could not read its board: ${w.lastError}`;
  if (w.openings === 0) return `Its ${ATS[w.ats]} board lists no roles — maybe an old board, or another company's.`;
  if (w.matching > 0) return `${w.matching} of ${plural(w.openings, 'open role')} fit`;
  return `${plural(w.openings, 'open role')}, none fit yet`;
}

function WatchRow({ w }: { w: JobWatch }) {
  const [armed, arm, disarm] = useArmed();
  const unwatch = useWrite(jobsWrite.unwatch);
  return (
    <li className="watch-row">
      <div className="grow">
        <a className="watch-name" href={boardUrl(w)} target="_blank" rel="noreferrer noopener" title={`Open its ${ATS[w.ats]} board`}>
          {w.company}
          <ExternalLink size={11} />
        </a>
        <div className={cx('watch-note', health(w) === 'quiet' && 'is-quiet')}>{watchNote(w)}</div>
      </div>
      {w.matching > 0 && <span className="chip chip-tint">{w.matching}</span>}
      {armed ? (
        <button type="button" className="btn btn-danger btn-sm" disabled={unwatch.isPending} onClick={() => unwatch.mutate(w.id)} onBlur={disarm} autoFocus>
          Stop watching
        </button>
      ) : (
        <button type="button" className="icon-btn icon-btn-sm" aria-label={`Stop watching ${w.company}`} onClick={arm}>
          <X size={15} />
        </button>
      )}
    </li>
  );
}

function WatchGroup({ title, hint, watches, action }: { title: string; hint?: string; watches: JobWatch[]; action?: ReactNode }) {
  if (!watches.length) return null;
  return (
    <section className="watch-group">
      <div className="watch-group-head">
        <h3>
          {title} <span className="faint">{watches.length}</span>
        </h3>
        {action}
      </div>
      {hint && <p className="hint">{hint}</p>}
      <ul>
        {watches.map((w) => (
          <WatchRow key={w.id} w={w} />
        ))}
      </ul>
    </section>
  );
}

function RemoveAll({ watches }: { watches: JobWatch[] }) {
  const [armed, arm, disarm] = useArmed();
  // One at a time: removing is quick, and a failure part way leaves the rest listed.
  const remove = useWrite(async (ids: string[]) => {
    for (const id of ids) await jobsWrite.unwatch(id);
  });
  if (remove.isPending) return <Spinner />;
  return armed ? (
    <button type="button" className="btn btn-danger btn-sm" onClick={() => remove.mutate(watches.map((w) => w.id))} onBlur={disarm} autoFocus>
      Remove {plural(watches.length, 'company', 'companies')}
    </button>
  ) : (
    <button type="button" className="btn btn-ghost btn-sm" onClick={arm}>
      Remove all
    </button>
  );
}

function CompaniesSheet({ watches, onAdd, onClose }: { watches: JobWatch[]; onAdd: () => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const shown = q.trim() ? watches.filter((w) => w.company.toLowerCase().includes(q.trim().toLowerCase())) : watches;
  const g = group(shown);
  return (
    <Modal
      title="Companies you watch"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="hint">Each board is checked every six hours.</span>
          <button type="button" className="btn btn-sm" onClick={onAdd}>
            <Plus size={13} /> Company
          </button>
        </>
      }
    >
      {watches.length > 8 && (
        <label className="watch-search">
          <Search size={14} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find among ${plural(watches.length, 'company', 'companies')}`} aria-label="Find a company" />
        </label>
      )}
      <WatchGroup title="Hiring for you" watches={g.fits} />
      <WatchGroup title="Watching" hint="Their boards have roles, none that fit yet." watches={g.watching} />
      <WatchGroup title="Not finding roles" hint="These boards list nothing or could not be read, so they will never alert. Open one to check it is the right company." watches={g.quiet} action={!q.trim() && g.quiet.length > 1 ? <RemoveAll watches={g.quiet} /> : undefined} />
      {shown.length === 0 && <p className="empty">No company by that name.</p>}
    </Modal>
  );
}

function Posting({ p }: { p: JobPosting }) {
  const mark = useWrite(({ status }: { status: 'seen' | 'saved' | 'dismissed' }) => jobsWrite.mark(p.id, status));
  // Opening a role is looking at it: it stops counting as new.
  const opened = () => p.status === 'new' && p.url && mark.mutate({ status: 'seen' });
  return (
    <li className={cx('job', p.status === 'new' && 'is-new', p.highlighted && 'is-highlight')}>
      <div className="grow">
        <a className="job-title" href={p.url || undefined} target="_blank" rel="noreferrer noopener" onClick={opened} onAuxClick={(e) => e.button === 1 && opened()}>
          {p.title}
          {p.url && <ExternalLink size={11} />}
        </a>
        <div className="job-meta">
          {p.highlighted && (
            <span className="job-star" title="Highlighted" role="img" aria-label="Highlighted">
              <Star size={11} fill="currentColor" />
            </span>
          )}
          <b>{p.company}</b>
          {p.location && ` · ${p.location}`}
          {p.remote && !/remote/i.test(p.location) && ' · remote'}
          {p.status === 'new' && <span className="job-new">new</span>}
        </div>
      </div>
      <button type="button" className="icon-btn icon-btn-sm" aria-label={p.status === 'saved' ? 'Unsave' : 'Save'} onClick={() => mark.mutate({ status: p.status === 'saved' ? 'seen' : 'saved' })}>
        {p.status === 'saved' ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
      </button>
      <button type="button" className="icon-btn icon-btn-sm" aria-label="Not for me" onClick={() => mark.mutate({ status: 'dismissed' })}>
        <X size={15} />
      </button>
    </li>
  );
}

type Filter = 'all' | 'highlighted' | 'place' | 'remote';

/** In one of your places, by its location; remote roles elsewhere are the other kind. */
const inPlace = (p: JobPosting, places: string[]) => places.some((l) => p.location.toLowerCase().includes(l.toLowerCase()));

function filterRoles(ps: JobPosting[], f: Filter, places: string[]): JobPosting[] {
  if (f === 'highlighted') return ps.filter((p) => p.highlighted);
  if (f === 'place') return ps.filter((p) => inPlace(p, places));
  if (f === 'remote') return ps.filter((p) => p.remote && !inPlace(p, places));
  return ps;
}

/** "Senior Product Designer, Staff Product Designer +11 · Singapore": the whole list lives under Fit. */
function prefLine(p: JobPreferences): string {
  const k = p.keywords;
  const what = !k.length ? 'Any role' : k.length <= 2 ? join(k) : `${join(k.slice(0, 2))} +${k.length - 2}`;
  const where = p.locations.length ? ` · ${join(p.locations)}${p.remote ? ' or remote' : ''}` : '';
  return what + where;
}

export function JobAlertsCard() {
  const { data } = useJobs();
  const { agentName, ask } = useApp();
  const [prefs, setPrefs] = useState(false);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const check = useWrite(jobsWrite.check);
  const list = useScrollEdges<HTMLUListElement>('y', [data, filter]);
  const fitsRow = useScrollEdges<HTMLDivElement>('x', [data]);
  if (!data) return null;
  const s: JobsState = data;
  const places = s.preferences.locations;
  const counts: [Filter, string, number][] = [
    ['all', 'All', s.postings.length],
    ['highlighted', 'Highlighted', filterRoles(s.postings, 'highlighted', places).length],
    ['place', places.length === 1 ? places[0]! : 'Your places', places.length ? filterRoles(s.postings, 'place', places).length : 0],
    ['remote', 'Remote', filterRoles(s.postings, 'remote', places).length],
  ];
  // Filters earn their place only when they split the list: each must be some, not all.
  const filters = counts.filter(([f, , n]) => f === 'all' || (n > 0 && n < s.postings.length));
  const active = filters.some(([f]) => f === filter) ? filter : 'all';
  const roles = filterRoles(s.postings, active, places);
  const fresh = s.postings.filter((p) => p.status === 'new').length;
  const g = group(s.watches);

  return (
    <section className="card jobs-card">
      <div className="card-head">
        <h2 className="card-title">
          Job alerts {fresh > 0 && <span className="chip chip-tint">{fresh} new</span>}
        </h2>
        <div className="row" style={{ gap: 2 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPrefs(true)}>
            <SlidersHorizontal size={13} /> Fit
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
            <Plus size={13} /> Company
          </button>
        </div>
      </div>
      {s.watches.length === 0 ? (
        <p className="empty">Name the companies you would join and what you are looking for. New roles that fit show up here, and in Needs you.</p>
      ) : (
        <>
          <button type="button" className="jobs-pref" onClick={() => setPrefs(true)} title={`${join(s.preferences.keywords) || 'Any role'} — change what fits`}>
            <Briefcase size={13} /> <span className="jobs-pref-text">{prefLine(s.preferences)}</span>
          </button>
          {filters.length > 1 && (
            <div className="jobs-filters" role="group" aria-label="Show roles">
              {filters.map(([f, label, n]) => (
                <button
                  key={f}
                  type="button"
                  className={cx('chip', active === f && 'chip-on')}
                  aria-pressed={active === f}
                  onClick={() => {
                    setFilter(f);
                    list.ref.current?.scrollTo({ top: 0 });
                  }}
                >
                  {f === 'highlighted' && <Star size={11} fill="currentColor" />}
                  {label} <span className="jobs-filter-n">{n}</span>
                </button>
              ))}
            </div>
          )}
          {s.postings.length === 0 ? (
            <p className="empty">Nothing open that fits right now. You'll hear when something does.</p>
          ) : (
            // Scrolls inside the card once the list outgrows it; focusable so the keys scroll it too.
            <ul ref={list.ref} onScroll={list.onScroll} className={cx('jobs-list', 'jobs-scroll', list.fade)} tabIndex={list.scrolls ? 0 : undefined} aria-label={`${plural(roles.length, 'open role')}`}>
              {roles.map((p) => (
                <Posting key={p.id} p={p} />
              ))}
            </ul>
          )}
          <div className="jobs-companies">
            <div className="jobs-companies-line">
              <span className="muted">Watching {plural(s.watches.length, 'company', 'companies')}</span>
              {g.fits.length > 0 && (
                <>
                  <span className="faint">·</span>
                  <span className="muted">hiring for you</span>
                </>
              )}
              <button type="button" className="link" onClick={() => setManaging(true)}>
                Manage
              </button>
            </div>
            {g.fits.length > 0 && (
              <div ref={fitsRow.ref} onScroll={fitsRow.onScroll} className={cx('jobs-fits', fitsRow.fade)}>
                {g.fits.map((w) => (
                  <span key={w.id} className="chip">
                    {w.company} <b>{w.matching}</b>
                  </span>
                ))}
              </div>
            )}
            {g.quiet.length > 0 && (
              <button type="button" className="jobs-warn" onClick={() => setManaging(true)}>
                <CircleAlert size={14} />
                {g.quiet.length === 1 ? `${g.quiet[0]!.company} isn't listing any roles.` : `${g.quiet.length} companies aren't listing any roles.`} <u>Review</u>
              </button>
            )}
          </div>
          <div className="card-foot jobs-foot">
            <span className="hint">{roles.length > 0 && plural(roles.length, 'role')}</span>
            <span className="hint">
              {s.lastRunAt ? `Checked ${timeAgo(s.lastRunAt)}` : ''}
              <button type="button" className="icon-btn icon-btn-sm" aria-label="Check now" disabled={check.isPending || s.running} onClick={() => check.mutate()}>
                <RefreshCw size={13} className={cx((check.isPending || s.running) && 'spin')} />
              </button>
              {s.postings.length > 0 && (
                <button type="button" className="link" onClick={() => ask('Look at the open roles in my job alerts. Which fit me best and why? Suggest how to approach the top one or two.')}>
                  Ask {agentName}
                </button>
              )}
            </span>
          </div>
        </>
      )}
      {prefs && <PreferencesSheet prefs={s.preferences} onClose={() => setPrefs(false)} />}
      {managing && !adding && (
<CompaniesSheet watches={s.watches} onAdd={() => setAdding(true)} onClose={() => setManaging(false)} />
      )}
      {adding && <WatchSheet known={s.watches} onClose={() => setAdding(false)} />}
    </section>
  );
}
