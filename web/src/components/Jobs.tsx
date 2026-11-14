// Job alerts, in the Work sphere: the companies you watch, what counts as a fit, and
// the open roles that match — new ones first.

import { Bookmark, BookmarkCheck, Briefcase, ExternalLink, Plus, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import { useState } from 'react';
import type { JobPosting, JobPreferences, JobsState } from '../../../shared/types.ts';
import { jobsWrite, useJobs, useWrite } from '../api.ts';
import { cx, plural, timeAgo } from '../lib.ts';
import { useApp } from '../state.tsx';
import { Check, Field, Modal, Spinner } from './ui.tsx';

const join = (xs: string[]) => xs.join(', ');
const split = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

function PreferencesSheet({ prefs, onClose }: { prefs: JobPreferences; onClose: () => void }) {
  const [f, setF] = useState({ keywords: join(prefs.keywords), exclude: join(prefs.exclude), locations: join(prefs.locations), remote: prefs.remote });
  const save = useWrite(jobsWrite.preferences);
  return (
    <Modal
      title="Roles that fit"
      onClose={onClose}
      footer={
        <>
          <span className="hint">Separate with commas.</span>
          <button className="btn btn-primary btn-sm" onClick={() => save.mutate({ keywords: split(f.keywords), exclude: split(f.exclude), locations: split(f.locations), remote: f.remote }, { onSuccess: onClose })}>
            Save
          </button>
        </>
      }
    >
      <Field label="Titles" hint="A role fits when its title has one of these. Empty means any role.">
        <input className="input" value={f.keywords} onChange={(e) => setF({ ...f, keywords: e.target.value })} placeholder="Product designer, Design lead, Head of design" data-autofocus />
      </Field>
      <Field label="Leave out" hint="Titles or teams with these words are skipped.">
        <input className="input" value={f.exclude} onChange={(e) => setF({ ...f, exclude: e.target.value })} placeholder="Intern, Contract" />
      </Field>
      <Field label="Places" hint="Empty means anywhere.">
        <input className="input" value={f.locations} onChange={(e) => setF({ ...f, locations: e.target.value })} placeholder="Singapore, APAC" />
      </Field>
      <label className="row" style={{ gap: 10, fontSize: 14 }}>
        <Check checked={f.remote} onChange={(remote) => setF({ ...f, remote })} label="Remote roles count" /> Remote roles count wherever they are
      </label>
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

function WatchSheet({ onClose }: { onClose: () => void }) {
  const [company, setCompany] = useState('');
  const [url, setUrl] = useState('');
  const add = useWrite(jobsWrite.watch);
  return (
    <Modal
      title="Watch a company"
      onClose={onClose}
      footer={
        <>
          <span className="hint">Checked every six hours.</span>
          <button className="btn btn-primary btn-sm" disabled={add.isPending || (!company.trim() && !url.trim())} onClick={() => add.mutate({ company, url }, { onSuccess: onClose })}>
            {add.isPending ? <Spinner /> : 'Watch'}
          </button>
        </>
      }
    >
      <Field label="Company">
        <input className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Grab" data-autofocus />
      </Field>
      <Field label="Careers page or a job link" hint="Greenhouse, Lever, Ashby, Workable and SmartRecruiters boards work. With just a name, Terminus tries the usual boards.">
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://jobs.lever.co/… or the company's careers page" />
      </Field>
      {add.error && <p className="error-text">{add.error.message}</p>}
    </Modal>
  );
}

function Posting({ p }: { p: JobPosting }) {
  const mark = useWrite(({ status }: { status: 'seen' | 'saved' | 'dismissed' }) => jobsWrite.mark(p.id, status));
  // Opening a role is looking at it: it stops counting as new.
  const opened = () => p.status === 'new' && p.url && mark.mutate({ status: 'seen' });
  return (
    <li className={cx('job', p.status === 'new' && 'is-new')}>
      <div className="grow">
        <a className="job-title" href={p.url || undefined} target="_blank" rel="noreferrer noopener" onClick={opened} onAuxClick={(e) => e.button === 1 && opened()}>
          {p.title}
          {p.url && <ExternalLink size={11} />}
        </a>
        <div className="job-meta">
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

function prefLine(p: JobPreferences): string {
  const what = p.keywords.length ? join(p.keywords) : 'Any role';
  const where = p.locations.length ? ` in ${join(p.locations)}${p.remote ? ' or remote' : ''}` : '';
  return what + where;
}

export function JobAlertsCard() {
  const { data } = useJobs();
  const { agentName, ask } = useApp();
  const [prefs, setPrefs] = useState(false);
  const [adding, setAdding] = useState(false);
  const [all, setAll] = useState(false);
  const unwatch = useWrite(jobsWrite.unwatch);
  const check = useWrite(jobsWrite.check);
  if (!data) return null;
  const s: JobsState = data;
  const shown = all ? s.postings : s.postings.slice(0, 6);
  const fresh = s.postings.filter((p) => p.status === 'new').length;

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
          <button type="button" className="jobs-pref" onClick={() => setPrefs(true)}>
            <Briefcase size={13} /> {prefLine(s.preferences)}
          </button>
          <div className="jobs-watches">
            {s.watches.map((w) => (
              <span key={w.id} className={cx('chip', 'job-watch', w.lastError && 'chip-bad')} title={w.lastError ?? `${w.openings} open roles on ${w.ats}`}>
                {w.company}
                <span className="faint">{w.lastError ? '!' : w.matching}</span>
                <button type="button" aria-label={`Stop watching ${w.company}`} onClick={() => confirm(`Stop watching ${w.company}?`) && unwatch.mutate(w.id)}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
          {s.postings.length === 0 ? (
            <p className="empty">Nothing open that fits right now. You'll hear when something does.</p>
          ) : (
            <ul className="jobs-list">
              {shown.map((p) => (
                <Posting key={p.id} p={p} />
              ))}
            </ul>
          )}
          <div className="card-foot jobs-foot">
            {s.postings.length > 6 ? (
              <button type="button" className="link" onClick={() => setAll((v) => !v)}>
                {all ? 'Show fewer' : `All ${plural(s.postings.length, 'role')}`}
              </button>
            ) : (
              <span />
            )}
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
      {adding && <WatchSheet onClose={() => setAdding(false)} />}
    </section>
  );
}
