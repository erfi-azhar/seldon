import { ArrowUpRight, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import type { Activity, Overview } from '../../../shared/types.ts';
import { useOverview, useWrite, write } from '../api.ts';
import { Orb } from '../components/Orb.tsx';
import { AddTask, HabitRow, TaskRow } from '../components/rows.tsx';
import { SignalsCard } from '../components/Signals.tsx';
import { Loading } from '../components/ui.tsx';
import { cx, greeting, hueStyle, monthDay, plural, relativeDay, timeAgo, todayStr, weekdayLong } from '../lib.ts';
import { useApp } from '../state.tsx';

function SphereStrip({ overview }: { overview: Overview }) {
  return (
    <nav className="card sphere-strip" aria-label="Your spheres this week">
      {overview.spheres.map((s) => {
        const quiet = s.stats.quietDays;
        const meta = quiet === null ? 'new' : quiet === 0 ? 'today' : quiet === 1 ? 'yesterday' : `${quiet}d quiet`;
        return (
          <Link key={s.id} href={`/spheres/${s.id}`} className="strip-item" title={`${s.name}: ${Math.round(s.stats.pulse * 100)}% pulse this week`}>
            <Orb hue={s.hue} icon={s.icon} size={40} ring={s.stats.pulse} />
            <span className="strip-name">{s.name}</span>
            <span className={cx('strip-meta', quiet !== null && quiet >= 7 && 'quiet')}>{meta}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function Journal({ date, initial }: { date: string; initial: string }) {
  const [text, setText] = useState(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(text);
  latest.current = text;
  const save = useWrite((body: string) => write.put(`/journal/${date}`, { body }));

  // Pick up changes made elsewhere (the agent writing an entry) unless mid-edit.
  useEffect(() => {
    if (!dirty.current) setText(initial);
  }, [initial]);

  const flush = () => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    setStatus('saving');
    save.mutate(latest.current, { onSuccess: () => setStatus('saved'), onError: () => setStatus('idle') });
  };
  // Save on the way out.
  useEffect(() => flush, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Journal</h2>
        <span className="saved">{save.isError ? 'Could not save' : status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : ''}</span>
      </div>
      <textarea
        className="journal"
        value={text}
        placeholder="What happened today? What's on your mind?"
        aria-label="Today's journal"
        onChange={(e) => {
          setText(e.target.value);
          dirty.current = true;
          setStatus('idle');
          clearTimeout(timer.current);
          timer.current = setTimeout(flush, 900);
        }}
        onBlur={flush}
      />
    </section>
  );
}

export function ActivityFeed({ items }: { items: Activity[] }) {
  const undo = useWrite((id: number) => write.post(`/activity/${id}/undo`));
  const { agentName } = useApp();
  return (
    <ul>
      {items.map((a) => (
        <li key={a.id} className="feed-item">
          <span className={cx('who', a.actor === 'agent' && 'by-agent')} title={a.actor === 'agent' ? `${agentName} did this` : 'You did this'}>
            {a.actor === 'agent' ? <Sparkles size={12} /> : '·'}
          </span>
          <span className="grow">{a.summary}</span>
          {a.actor === 'agent' && a.undoable && (
            <button type="button" className="link" style={{ fontSize: 12.5 }} onClick={() => undo.mutate(a.id)}>
              Undo
            </button>
          )}
          <time dateTime={a.ts}>{timeAgo(a.ts)}</time>
        </li>
      ))}
    </ul>
  );
}

export function Today() {
  const { data: o } = useOverview();
  const { ask, agentName, openSheet, sphere } = useApp();
  const [showAll, setShowAll] = useState(false);
  if (!o) return <Loading />;

  const today = todayStr();
  const habitsOpen = o.habits.filter((h) => !h.doneToday && (h.cadence === 'daily' || h.weekCount < h.targetPerWeek)).length;
  const due = o.tasks.due.length;
  const anytime = showAll ? o.tasks.anytime : o.tasks.anytime.slice(0, 5);
  const nothing = due + o.tasks.anytime.length + o.tasks.doneToday.length === 0;
  const horizon = o.goalsDue.length + o.tasks.upcoming.length > 0;

  return (
    <div className="page">
      <header className="hero">
        <div>
          <div className="hero-day">{weekdayLong(today)}</div>
          <h1 className="hero-date">{monthDay(today)}</h1>
          <p className="hero-line">
            {greeting()}
            {o.profile.userName ? `, ${o.profile.userName}` : ''}.{' '}
            {due === 0 && habitsOpen === 0 ? (
              'Nothing is waiting on you — a good day to move something that matters.'
            ) : (
              <>
                {due > 0 && <b>{plural(due, 'task')} due</b>}
                {due > 0 && habitsOpen > 0 && ' and '}
                {habitsOpen > 0 && <b>{plural(habitsOpen, 'habit')} still open</b>}.
              </>
            )}
          </p>
        </div>
        <button type="button" className="btn" onClick={() => ask('Help me plan today. Look at what is due, my habits and how each sphere has been going, then suggest a realistic plan.')}>
          Plan today with {agentName} <ArrowUpRight size={15} />
        </button>
      </header>

      {o.spheres.length > 0 && <SphereStrip overview={o} />}

      <div className="today-grid">
        <div className="col">
          <SignalsCard />
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">On your plate</h2>
            </div>
            {nothing && <p className="empty">Nothing here. Add what's on your mind, or tell {agentName}.</p>}
            {due > 0 && (
              <>
                <div className="list-label">Due</div>
                <ul>
                  {o.tasks.due.map((t) => (
                    <TaskRow key={t.id} task={t} />
                  ))}
                </ul>
              </>
            )}
            {o.tasks.anytime.length > 0 && (
              <>
                <div className="list-label">Anytime</div>
                <ul>
                  {anytime.map((t) => (
                    <TaskRow key={t.id} task={t} />
                  ))}
                </ul>
                {o.tasks.anytime.length > 5 && (
                  <button type="button" className="link" style={{ margin: '6px 20px 0', fontSize: 13 }} onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'Show fewer' : `Show all ${o.tasks.anytime.length}`}
                  </button>
                )}
              </>
            )}
            {o.tasks.doneToday.length > 0 && (
              <>
                <div className="list-label">Done today</div>
                <ul>
                  {o.tasks.doneToday.map((t) => (
                    <TaskRow key={t.id} task={t} />
                  ))}
                </ul>
              </>
            )}
            <AddTask />
          </section>

          <Journal key={o.date} date={o.date} initial={o.journal?.body ?? ''} />
        </div>

        <div className="col">
          <section className="card" style={{ paddingBottom: 10 }}>
            <div className="card-head">
              <h2 className="card-title">Habits</h2>
              <span className="hint">last 7 days</span>
            </div>
            {o.habits.length === 0 ? (
              <p className="empty">No habits yet. Open a sphere to start one.</p>
            ) : (
              <ul>
                {o.habits.map((h) => (
                  <HabitRow key={h.id} habit={h} showSphere />
                ))}
              </ul>
            )}
          </section>

          {horizon && (
            <section className="card" style={{ paddingBottom: 10 }}>
              <div className="card-head">
                <h2 className="card-title">On the horizon</h2>
              </div>
              {o.goalsDue.map((g) => {
                const s = sphere(g.sphereId);
                const late = g.targetDate! < today;
                return (
                  <button key={g.id} type="button" className="horizon-item tint" style={s ? hueStyle(s.hue) : undefined} onClick={() => openSheet({ kind: 'goal', id: g.id })}>
                    {s && <Orb hue={s.hue} size={22} />}
                    <span className="grow clamp-1">{g.title}</span>
                    <span className={cx('chip', late && 'chip-bad')}>{late ? `passed ${relativeDay(g.targetDate!, today)}` : relativeDay(g.targetDate!, today)}</span>
                  </button>
                );
              })}
              {o.tasks.upcoming.length > 0 && (
                <ul>
                  {o.tasks.upcoming.map((t) => (
                    <TaskRow key={t.id} task={t} />
                  ))}
                </ul>
              )}
            </section>
          )}

          {o.activity.length > 0 && (
            <section className="card" style={{ paddingBottom: 12 }}>
              <div className="card-head">
                <h2 className="card-title">Lately</h2>
              </div>
              <ActivityFeed items={o.activity.slice(0, 9)} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
