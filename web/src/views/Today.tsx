import { useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Activity, Overview, Task } from '../../../shared/types.ts';
import { useOverview, useTravel, useWrite, write } from '../api.ts';
import { Orb } from '../components/Orb.tsx';
import { AddTask, HabitRow, TaskRow } from '../components/rows.tsx';
import { SignalsCard } from '../components/Signals.tsx';
import { Sky, type SkyTrip } from '../components/Sky.tsx';
import { TravelModeCard, TravelPill } from '../components/Travel.tsx';
import { NextPrayerPill } from '../components/Prayer.tsx';
import { Loading } from '../components/ui.tsx';
import { cx, greeting, hueStyle, monthDay, plural, relativeDay, timeAgo, todayStr, weekdayLong } from '../lib.ts';
import { useApp } from '../state.tsx';

/** Today's to-dos (due today or overdue, and done today), split into work and the rest. */
function TodayTodos({ overview: o }: { overview: Overview }) {
  const { spheres, agentName } = useApp();
  const today = todayStr();
  const work = spheres.find((s) => s.key === 'work') ?? spheres.find((s) => /^work$/i.test(s.name));
  const isWork = (t: Task) => !!work && t.sphereId === work.id;
  const open = o.tasks.due;
  const done = o.tasks.doneToday;
  const total = open.length + done.length;
  const column = (label: string, tasks: { open: Task[]; done: Task[] }, add: ReactNode, showSphere: boolean) => (
    <div className="todo-col">
      <div className="todo-col-head">
        <h3>{label}</h3>
        <span className="hint">{tasks.open.length === 0 ? (tasks.done.length ? 'all done' : 'nothing due') : `${tasks.open.length} to do`}</span>
      </div>
      {tasks.open.length + tasks.done.length > 0 && (
        <ul>
          {tasks.open.map((t) => (
            <TaskRow key={t.id} task={t} showSphere={showSphere} />
          ))}
          {tasks.done.map((t) => (
            <TaskRow key={t.id} task={t} showSphere={showSphere} />
          ))}
        </ul>
      )}
      {add}
    </div>
  );
  return (
    <section className="card today-todos">
      <div className="card-head">
        <h2 className="card-title">Today's to-dos</h2>
        <span className="hint">{total === 0 ? `Nothing due. Add one, or ask ${agentName}.` : `${done.length} of ${total} done`}</span>
      </div>
      <div className={cx('todo-split', !work && 'single')}>
        {work &&
          column(
            work.name,
            { open: open.filter(isWork), done: done.filter(isWork) },
            <AddTask sphereId={work.id} dueDate={today} placeholder={`Add a ${work.name.toLowerCase()} to-do for today…`} />,
            false,
          )}
        {column(
          work ? 'Everything else' : 'To do',
          { open: open.filter((t) => !isWork(t)), done: done.filter((t) => !isWork(t)) },
          <AddTask dueDate={today} placeholder="Add a to-do for today…" />,
          true,
        )}
      </div>
    </section>
  );
}

// Words typed into a day's journal that the server has not confirmed yet, kept in this
// browser so a failed save, a reload or a closed tab doesn't lose them. `base` is the
// entry they were typed over: if the server's entry has changed some other way since,
// the leftover is dropped rather than written over it.
interface Unsaved {
  body: string;
  base: string;
}
const unsavedKey = (date: string) => `terminus:journal:${date}`;

function readUnsaved(date: string): Unsaved | null {
  try {
    const raw = localStorage.getItem(unsavedKey(date));
    return raw ? (JSON.parse(raw) as Unsaved) : null;
  } catch {
    return null;
  }
}

function writeUnsaved(date: string, value: Unsaved | null): void {
  try {
    if (value) localStorage.setItem(unsavedKey(date), JSON.stringify(value));
    else localStorage.removeItem(unsavedKey(date));
  } catch {
    // Storage is off (private window): the words are kept only while the page is open.
  }
}

function Journal({ date, initial }: { date: string; initial: string }) {
  const qc = useQueryClient();
  const [restored] = useState(() => {
    const left = readUnsaved(date);
    if (left && left.base === initial && left.body !== initial) return left.body;
    if (left) writeUnsaved(date, null);
    return null;
  });
  const [text, setText] = useState(restored ?? initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const dirty = useRef(restored !== null);
  const inFlight = useRef(false);
  // The entry as the server last had it.
  const server = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(text);
  latest.current = text;
  const confirmed = (body: string) => {
    server.current = body;
    if (readUnsaved(date)?.body === body) writeUnsaved(date, null);
  };
  const save = useWrite(async (body: string) => {
    inFlight.current = true;
    try {
      const result = await write.put(`/journal/${date}`, { body });
      confirmed(body);
      return result;
    } finally {
      inFlight.current = false;
    }
  });

  // Pick up changes made elsewhere (the agent writing an entry) unless mid-edit. While a
  // save is out, an overview fetched before it landed would bring back the older text.
  useEffect(() => {
    if (dirty.current || inFlight.current) return;
    server.current = initial;
    setText(initial);
  }, [initial]);

  const flush = () => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    // One save at a time, so they land in order; this one goes next.
    if (inFlight.current) {
      timer.current = setTimeout(flush, 300);
      return;
    }
    dirty.current = false;
    setStatus('saving');
    save.mutate(latest.current, {
      onSuccess: () => setStatus(dirty.current ? 'idle' : 'saved'),
      onError: () => {
        // Keep the text and try again: shortly, on blur, and on the way out.
        dirty.current = true;
        setStatus('failed');
        timer.current = setTimeout(flush, 5000);
      },
    });
  };

  // Leaving Today, hiding the tab or closing it: send what is left in a request that
  // outlives the page (keepalive caps the body at 64 KB, so long entries go normally). If
  // it is lost on the way, the copy kept in this browser is saved next time.
  const sendNow = () => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    const body = latest.current;
    const payload = JSON.stringify({ body });
    setStatus('saving');
    fetch(`/api/journal/${date}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: payload,
      credentials: 'same-origin',
      keepalive: payload.length < 60_000,
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        confirmed(body);
        setStatus('saved');
        void qc.invalidateQueries({ queryKey: ['overview'] });
      })
      .catch(() => {
        dirty.current = true;
        setStatus('failed');
      });
  };

  useEffect(() => {
    // Words left over from a save that never landed: try them again.
    if (dirty.current) flush();
    const onHide = () => document.visibilityState === 'hidden' && sendNow();
    window.addEventListener('pagehide', sendNow);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', sendNow);
      document.removeEventListener('visibilitychange', onHide);
      sendNow();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Journal</h2>
        <span className="saved">{status === 'failed' ? 'Could not save — will try again' : status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : ''}</span>
      </div>
      <textarea
        className="journal"
        value={text}
        placeholder="What happened today? What's on your mind?"
        aria-label="Today's journal"
        onChange={(e) => {
          setText(e.target.value);
          writeUnsaved(date, { body: e.target.value, base: server.current });
          dirty.current = true;
          if (status !== 'failed') setStatus('idle');
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
  const { agentName, toast } = useApp();
  return (
    <ul>
      {items.map((a) => (
        <li key={a.id} className="feed-item">
          <span className={cx('who', a.actor === 'agent' && 'by-agent')} title={a.actor === 'agent' ? `${agentName} did this` : 'You did this'}>
            {a.actor === 'agent' ? <Sparkles size={12} /> : '·'}
          </span>
          <span className="grow">{a.summary}</span>
          {a.actor === 'agent' && a.undoable && (
            <button type="button" className="link" style={{ fontSize: 12.5 }} onClick={() => undo.mutate(a.id, { onError: (e) => toast({ message: e.message }) })}>
              Undo
            </button>
          )}
          <time dateTime={a.ts}>{timeAgo(a.ts)}</time>
        </li>
      ))}
    </ul>
  );
}

/** A trip under two weeks away, for the plane that crosses the sky. */
function useSkyTrip(): SkyTrip | null {
  const { data: t } = useTravel();
  const trip = t?.context.trip;
  if (!t || !trip || (t.context.mode !== 'upcoming' && t.context.mode !== 'departing')) return null;
  const days = Math.round((Date.parse(trip.startDate) - Date.parse(todayStr())) / 86_400_000);
  if (days < 0 || days > 14) return null;
  return { id: trip.id, label: `${trip.title} · ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}` };
}

export function Today() {
  const { data: o } = useOverview();
  const skyTrip = useSkyTrip();
  const { openSheet, sphere } = useApp();
  const [showAll, setShowAll] = useState(false);
  if (!o) return <Loading />;

  const today = todayStr();
  const habitsOpen = o.habits.filter((h) => !h.doneToday && (h.cadence === 'daily' || h.weekCount < h.targetPerWeek)).length;
  const due = o.tasks.due.length;
  const anytime = showAll ? o.tasks.anytime : o.tasks.anytime.slice(0, 5);
  const horizon = o.goalsDue.length + o.tasks.upcoming.length > 0;

  return (
    <div className="page page-today">
      <Sky trip={skyTrip} />
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
        <div className="hero-side">
          <NextPrayerPill />
          <TravelPill />
        </div>
      </header>

      <TodayTodos overview={o} />

      <div className="today-grid">
        <div className="col">
          <TravelModeCard />
          <SignalsCard />
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Anytime</h2>
              <span className="hint">no date set</span>
            </div>
            {o.tasks.anytime.length === 0 ? (
              <p className="empty">Nothing waiting without a date.</p>
            ) : (
              <>
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

        </div>
      </div>
      {/* What changed lately: a quiet footnote, the rest (and Undo) one click away. */}
      {o.activity.length > 0 && <Lately items={o.activity} />}
    </div>
  );
}

/* A quiet footnote rather than a card: the latest change on one muted line, the rest one click away. */
export function Lately({ items }: { items: Activity[] }) {
  const [latest] = items;
  const more = items.length - 1;
  const line = (
    <span className="lately-line">
      Last change <span className="lately-text">{latest.summary}</span>
      <span aria-hidden="true">·</span>
      <time dateTime={latest.ts}>{timeAgo(latest.ts)}</time>
    </span>
  );
  // Only expandable when there is something behind it: older entries, or an Undo to reach.
  if (more === 0 && !(latest.actor === 'agent' && latest.undoable)) return <p className="lately">{line}</p>;
  return (
    <details className="lately">
      <summary>
        {line}
        <span className="lately-toggle" data-closed={more > 0 ? `${more} more` : 'Undo'} data-open="Hide" />
      </summary>
      <ActivityFeed items={items} />
    </details>
  );
}
