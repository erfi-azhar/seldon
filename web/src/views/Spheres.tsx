import { Archive, ArrowLeft, ArrowUpRight, ChevronRight, Pencil, Plane, Plus, Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { CATALOG_BY_KEY } from '../../../shared/catalog.ts';
import type { Project, Task } from '../../../shared/types.ts';
import { useHealth, useSphere, useSpheres, useTravel, useWrite, write } from '../api.ts';
import { Orb } from '../components/Orb.tsx';
import { AddTask, GoalRow, HabitRow, HabitWeekHead, HabitWeekLabel, MetricCard, TaskRow } from '../components/rows.tsx';
import { SignalsCard } from '../components/Signals.tsx';
import { FaithVerse, PrayerCard } from '../components/Prayer.tsx';
import { QuranStudyCard } from '../components/QuranStudy.tsx';
import { BodyCard, HealthToday, TrainingCard } from '../components/HealthPanels.tsx';
import { TravelLoyalty, TravelTrips, WorkTrips } from '../components/Travel.tsx';
import { JobAlertsCard } from '../components/Jobs.tsx';
import { ReadingList } from '../components/Reading.tsx';
import { BillsCard, CashflowCard, CryptoDesk, DebtsCard, MoneyHero, PlanCard, PortfolioCard } from '../components/Finance.tsx';
import { InlineEdit, Loading, Seg } from '../components/ui.tsx';
import { addDays, cx, dueLabel, hueStyle, parseDay, pct, plural, shortDay, todayStr } from '../lib.ts';
import { useApp } from '../state.tsx';
import { normalise, useScreenings } from './Screenings.tsx';
import { Lately } from './Today.tsx';

export function Spheres() {
  const { data: spheres } = useSpheres();
  const { openSheet } = useApp();
  if (!spheres) return <Loading />;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Spheres</h1>
          <p className="page-sub">The areas of life you're tending on purpose. The ring around each one is its pulse this week.</p>
        </div>
      </header>

      <div className="sphere-grid">
        {spheres.map((s) => {
          const quiet = s.stats.quietDays;
          return (
            <Link key={s.id} href={`/spheres/${s.id}`} className="sphere-card tint" style={hueStyle(s.hue)}>
              <Orb hue={s.hue} icon={s.icon} size={46} ring={s.stats.pulse} />
              {quiet !== null && quiet >= 7 && <span className="chip chip-bad quiet-flag">quiet {quiet}d</span>}
              <div>
                <h3>{s.name}</h3>
                <p className={cx('vision clamp-2', !s.vision && 'unset')} style={{ marginTop: 6 }}>
                  {s.vision || 'No vision written yet.'}
                </p>
              </div>
              <div className="sphere-stats">
                <div>
                  <b>{s.stats.activeGoals}</b>
                  {s.stats.activeGoals === 1 ? 'goal' : 'goals'}
                </div>
                <div>
                  <b>{s.stats.goalProgress === null ? '—' : pct(s.stats.goalProgress)}</b>
                  progress
                </div>
                <div>
                  <b>{s.stats.habitRate === null ? '—' : pct(s.stats.habitRate)}</b>
                  habits kept
                </div>
                <div>
                  <b>{s.stats.openTasks}</b>
                  open
                </div>
              </div>
            </Link>
          );
        })}
        <button type="button" className="sphere-add" onClick={() => openSheet({ kind: 'new-sphere' })}>
          <span className="row">
            <Plus size={17} /> Add a sphere
          </span>
        </button>
      </div>
    </div>
  );
}

/** The way into the screening record, shown on the Health sphere. */
function ScreeningsEntry({ sphereId }: { sphereId: string }) {
  const { data: doc } = useScreenings();
  const rows = (doc?.results ?? []).map(normalise).filter((r) => r.b != null);
  const n = (st: string) => rows.filter((r) => r.s === st).length;
  return (
    <Link href={`/spheres/${sphereId}/screenings`} className="card screenings-entry" style={{ marginBottom: 20 }}>
      <Stethoscope size={22} className="faint" />
      <span className="grow">
        <b>Health screenings</b>
        <span className="muted">
          {doc ? `${doc.visits.map((v) => v.label).join(' and ')} · ${n('ok')} in range, ${n('watch')} to watch, ${n('flag')} flagged` : 'Import a check-up record to see results, trends and an action plan.'}
        </span>
      </span>
      <ArrowUpRight size={16} className="faint" />
    </Link>
  );
}

export function SphereDetail({ id }: { id: string }) {
  const { data, isError } = useSphere(id);
  const { openSheet, ask, agentName } = useApp();
  const [showClosed, setShowClosed] = useState(false);
  const saveVision = useWrite((vision: string) => write.patch(`/spheres/${id}`, { vision }));
  const addHabit = useWrite((body: object) => write.post('/habits', { ...body, sphereId: id }));
  const addMetric = useWrite((body: object) => write.post('/metrics', { ...body, sphereId: id }));

  if (isError)
    return (
      <div className="page">
        <Link href="/spheres" className="back">
          <ArrowLeft size={15} /> Spheres
        </Link>
        <div className="empty-block">
          <h3>This sphere isn't here</h3>
          <p>It may have been archived or deleted.</p>
        </div>
      </div>
    );
  if (!data) return <Loading />;

  const { sphere: s, goals, habits, metrics, tasks, projects, notes, activity } = data;
  const kit = s.key ? CATALOG_BY_KEY[s.key] : undefined;
  const active = goals.filter((g) => g.status === 'active');
  const closed = goals.filter((g) => g.status !== 'active');
  const habitNames = new Set(habits.map((h) => h.name.toLowerCase()));
  const metricNames = new Set(metrics.map((m) => m.name.toLowerCase()));
  const habitIdeas = (kit?.habits ?? []).filter((h) => !habitNames.has(h.name.toLowerCase()));
  const metricIdeas = (kit?.metrics ?? []).filter((m) => !metricNames.has(m.name.toLowerCase()));
  const quiet = s.stats.quietDays;
  // Spheres with a card you use every day: food, prayers, work to-dos and job alerts, money and markets.
  const hasDaily = s.key === 'health' || s.key === 'faith' || s.key === 'work' || s.key === 'finances';

  const habitsCard = (
    <section className="card">
      <div className="card-head">
        <div className="card-head-title">
          <h2 className="card-title">Habits</h2>
          {habits.length > 0 && <HabitWeekLabel />}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => openSheet({ kind: 'habit', sphereId: id })}>
          <Plus size={14} /> New habit
        </button>
      </div>
      {habits.length === 0 && <p className="empty">No habits yet.</p>}
      <ul style={{ paddingBottom: habitIdeas.length ? 6 : 12 }}>
        {habits.length > 0 && <HabitWeekHead />}
        {habits.map((h) => (
          <HabitRow key={h.id} habit={h} />
        ))}
      </ul>
      {habitIdeas.length > 0 && (
        <div className="suggest">
          <span className="hint">Ideas</span>
          {habitIdeas.map((h) => (
            <button key={h.name} type="button" className="chip chip-outline" onClick={() => addHabit.mutate(h)}>
              <Plus size={12} /> {h.name}
            </button>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className="page tint" style={hueStyle(s.hue)}>
      <Link href="/spheres" className="back">
        <ArrowLeft size={15} /> Spheres
      </Link>

      <header className="sphere-hero">
        <Orb hue={s.hue} icon={s.icon} size={78} ring={s.stats.pulse} />
        <div className="grow">
          <h1>{s.name}</h1>
          <InlineEdit label="Vision" multiline className="vision" value={s.vision} placeholder={kit?.visionPrompt ?? 'What does thriving here look like?'} onSave={(v) => saveVision.mutate(v)} />
          <div className="row-wrap" style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-tint btn-sm" onClick={() => ask(`Let's review my ${s.name} sphere. Read it in full, tell me honestly how it's going, and suggest what to focus on next.`)}>
              <span className="btn-text">Review with {agentName}</span> <ArrowUpRight size={14} />
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => openSheet({ kind: 'sphere', id })}>
              <Pencil size={13} /> Edit
            </button>
          </div>
        </div>
        <div className="hero-stats">
          <div>
            <b>{pct(s.stats.pulse)}</b>pulse
          </div>
          <div>
            <b>{quiet === null ? '—' : quiet === 0 ? 'today' : `${quiet}d`}</b>
            {quiet === null || quiet === 0 ? 'last touched' : 'since touched'}
          </div>
        </div>
      </header>

      {/* Today: what you act on most days. */}
      <div className="band-label">Today</div>
      {s.key === 'travels' && <TravelTrips />}
      {s.key === 'finances' && <MoneyHero />}
      {/* Work's to-dos are the heart of the sphere, so they get the full width. */}
      {s.key === 'work' && <WorkTodos sphereId={id} tasks={tasks} projects={projects} />}
      {/* Learning's reading list is a shelf, and a shelf wants the full width. */}
      {s.key === 'learning' && <ReadingList />}
      {/* With a daily card on the left, tasks join habits on the right so the columns even out. */}
      <div className="detail-grid">
        <div className="col">
          <SignalsCard sphereId={id} title={`Needs you in ${s.name}`} />
          {s.key === 'health' && <HealthToday />}
          {s.key === 'faith' && <PrayerCard />}
          {s.key === 'finances' && <CashflowCard />}
          {s.key === 'finances' && <PlanCard />}
          {(s.key === 'work' || s.key === 'finances') && habitsCard}
          {!hasDaily && (
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">Tasks</h2>
              </div>
              {tasks.length === 0 && <p className="empty">Nothing open in {s.name}.</p>}
              <ul>
                {tasks.map((t) => (
                  <TaskRow key={t.id} task={t} showSphere={false} />
                ))}
              </ul>
              <AddTask sphereId={id} placeholder={`Add a task to ${s.name}…`} />
            </section>
          )}
        </div>
        <div className="col">
          {s.key === 'faith' && <FaithVerse />}
          {s.key === 'faith' && <QuranStudyCard />}
          {s.key === 'work' ? <JobAlertsCard /> : s.key === 'finances' ? <CryptoDesk /> : habitsCard}
          {s.key === 'finances' && <BillsCard />}
          {hasDaily && s.key !== 'work' && (
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">Tasks</h2>
              </div>
              {tasks.length === 0 && <p className="empty">Nothing open in {s.name}.</p>}
              <ul>
                {tasks.map((t) => (
                  <TaskRow key={t.id} task={t} showSphere={false} />
                ))}
              </ul>
              <AddTask sphereId={id} placeholder={`Add a task to ${s.name}…`} />
            </section>
          )}
        </div>
      </div>

      {/* Progress: what you update now and then, and read for the trend. */}
      <div className="band-label">Progress</div>
      <div className="detail-grid">
        <div className="col">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Goals</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => openSheet({ kind: 'new-goal', sphereId: id })}>
                <Plus size={14} /> New goal
              </button>
            </div>
            {active.length === 0 && (
              <p className="empty">
                No active goals here.
                {kit?.goalIdeas[0] ? ` Something like “${kit.goalIdeas[0]}”?` : ''}
              </p>
            )}
            {active.map((g) => (
              <GoalRow key={g.id} goal={g} />
            ))}
            {closed.length > 0 && (
              <>
                <div className="card-foot">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowClosed((v) => !v)}>
                    {showClosed ? 'Hide' : 'Show'} {plural(closed.length, 'finished or parked goal')}
                  </button>
                </div>
                {showClosed && closed.map((g) => <GoalRow key={g.id} goal={g} />)}
              </>
            )}
          </section>
          {s.key === 'health' && <TrainingAndBody part="training" />}
          {s.key === 'finances' && <PortfolioCard />}
        </div>
        <div className="col">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Numbers</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => openSheet({ kind: 'metric', sphereId: id })}>
                <Plus size={14} /> New metric
              </button>
            </div>
            {metrics.length === 0 ? <p className="empty">Track anything you can count.</p> : (
              <div className="metric-grid">
                {metrics.map((m) => (
                  <MetricCard key={m.id} metric={m} />
                ))}
              </div>
            )}
            {metricIdeas.length > 0 && (
              <div className="suggest">
                <span className="hint">Ideas</span>
                {metricIdeas.map((m) => (
                  <button key={m.name} type="button" className="chip chip-outline" onClick={() => addMetric.mutate(m)}>
                    <Plus size={12} /> {m.name}
                  </button>
                ))}
              </div>
            )}
          </section>
          {s.key === 'health' && <TrainingAndBody part="body" />}
          {s.key === 'finances' && <DebtsCard />}
        </div>
      </div>

      {/* Reference: what you look things up in, and rarely change. */}
      <div className="band-label">Reference</div>
      {s.key === 'health' && <ScreeningsEntry sphereId={id} />}
      {s.key === 'travels' && <TravelLoyalty />}
      <div className={s.key === 'work' ? 'detail-grid' : undefined}>
        <div className="col">
          <section className="card" style={{ paddingBottom: 10 }}>
            <div className="card-head">
              <h2 className="card-title">Notes</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => openSheet({ kind: 'new-note', sphereId: id })}>
                <Plus size={14} /> New note
              </button>
            </div>
            {notes.length === 0 && <p className="empty">Ideas, references and links for {s.name} land here.</p>}
            {notes.map((n) => (
              <button key={n.id} type="button" className="horizon-item" onClick={() => openSheet({ kind: 'note', id: n.id })}>
                <span className="grow clamp-1">{n.title || n.body.slice(0, 80) || n.url}</span>
                <span className="faint" style={{ fontSize: 12.5 }}>
                  {shortDay(todayStr(new Date(n.updatedAt)))}
                </span>
              </button>
            ))}
          </section>
        </div>
        {s.key === 'work' && (
          <div className="col">
            <WorkTrips />
          </div>
        )}
      </div>
      {/* What changed lately: a quiet footnote, the rest one click away. */}
      {activity.length > 0 && <Lately items={activity} />}
    </div>
  );
}

/** Health's training and body cards, placed separately in the Progress band. */
function TrainingAndBody({ part }: { part: 'training' | 'body' }) {
  const { data: h } = useHealth();
  if (!h) return null;
  return part === 'training' ? <TrainingCard h={h} /> : <BodyCard h={h} />;
}

/**
 * The Work sphere's lead card: the work on your plate. To-dos filed to a trip (book the
 * hotel, check in online) are logistics rather than work, so they fold into one line per
 * trip below, still a tap away and still on time.
 */
type TodoView = 'project' | 'day';
const VIEW_KEY = 'work-todos-view';
function readView(): TodoView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'day' ? 'day' : 'project';
  } catch {
    return 'project';
  }
}

/** Earliest due date first; to-dos with no date sort after every dated one. */
const byDue = (a: Task, b: Task) => (a.dueDate ?? '9999') < (b.dueDate ?? '9999') ? -1 : (a.dueDate ?? '9999') > (b.dueDate ?? '9999') ? 1 : 0;

function WorkTodos({ sphereId, tasks, projects }: { sphereId: string; tasks: Task[]; projects: Project[] }) {
  const { data: travel } = useTravel();
  const [view, setViewState] = useState<TodoView>(readView);
  const setView = (v: TodoView) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* the choice just isn't remembered */
    }
  };
  const today = todayStr();
  const work = tasks.filter((t) => !t.tripId);
  const byTrip = new Map<string, Task[]>();
  for (const t of tasks) if (t.tripId) byTrip.set(t.tripId, [...(byTrip.get(t.tripId) ?? []), t]);
  const tripTitle = (tripId: string) => travel?.trips.find((x) => x.id === tripId)?.title ?? 'a trip';
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const lateCount = work.filter((t) => t.dueDate && t.dueDate < today).length;
  // A trip's logistics start folded away; the ones you open stay open.
  const tripFolds = useFolds('work-todos-open-trips', (k) => byTrip.has(k), false);

  return (
    <section className="card work-todos">
      <div className="card-head">
        <div className="row" style={{ gap: 10 }}>
          <h2 className="card-title">To-dos</h2>
          {work.length > 0 && (
            <span className="hint">
              {plural(work.length, 'open', 'open')}
              {lateCount > 0 && <span className="late"> · {lateCount} late</span>}
            </span>
          )}
        </div>
        <Seg
          label="Group to-dos"
          value={view}
          onChange={setView}
          options={[
            { value: 'project', label: 'Projects' },
            { value: 'day', label: 'By day' },
          ]}
        />
      </div>
      {view === 'project' ? (
        <ProjectGroups sphereId={sphereId} work={work} projects={projects} today={today} />
      ) : (
        <DayGroups tasks={tasks} today={today} label={(t) => (t.tripId ? `✈ ${tripTitle(t.tripId)}` : t.projectId ? projectName.get(t.projectId) : undefined)} />
      )}
      <AddTask sphereId={sphereId} projects={projects} placeholder="Add a work to-do…" />
      {view === 'project' &&
        [...byTrip].map(([tripId, list]) => {
          const next = list.find((t) => t.dueDate)?.dueDate;
          const due = next ? dueLabel(next, today) : null;
          return (
            <details key={tripId} className="todo-fold" open={tripFolds.isOpen(tripId)} onToggle={(e) => tripFolds.toggle(tripId, e.currentTarget.open)}>
              <summary>
                <ChevronRight size={14} className="todo-fold-chev" aria-hidden />
                <Plane size={14} className="faint" aria-hidden />
                <span className="grow clamp-1">For {tripTitle(tripId)}</span>
                <span className={cx('todo-fold-meta', due?.late && 'late')}>
                  {plural(list.length, 'to-do')}
                  {due && ` · next ${due.text}`}
                </span>
              </summary>
              <ul>
                {list.map((t) => (
                  <TaskRow key={t.id} task={t} showSphere={false} />
                ))}
              </ul>
            </details>
          );
        })}
    </section>
  );
}

/**
 * Folds you opened or closed, kept in this browser like the view choice. What's saved is the
 * groups you turned away from how they start (closed ones when they start open, and the other
 * way round). `keep` lets go of keys that no longer mean anything (a day gone by, a project
 * archived, a trip with nothing left to do), so the list doesn't grow forever.
 */
function useFolds(storageKey: string, keep: (key: string) => boolean, startOpen = true) {
  const [changed, setChanged] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      return new Set(Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string' && keep(k)) : []);
    } catch {
      return new Set();
    }
  });
  const isOpen = (key: string) => changed.has(key) !== startOpen;
  const toggle = (key: string, open: boolean) =>
    setChanged((prev) => {
      if (open === (prev.has(key) !== startOpen)) return prev;
      const next = new Set(prev);
      if (open === startOpen) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* the folds just aren't remembered */
      }
      return next;
    });
  return { isOpen, toggle };
}

/** To-dos under their projects, the project with the most pressing to-do first. */
function ProjectGroups({ sphereId, work, projects, today }: { sphereId: string; work: Task[]; projects: Project[]; today: string }) {
  const [adding, setAdding] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const known = new Set(projects.map((p) => p.id));
  const { isOpen, toggle } = useFolds('work-todos-folded-projects', (k) => k === 'none' || known.has(k));
  const groups = [
    ...projects.map((p) => ({ id: p.id, project: p as Project | null, name: p.name, list: work.filter((t) => t.projectId === p.id).sort(byDue) })),
    { id: 'none', project: null, name: 'No project', list: work.filter((t) => !t.projectId || !known.has(t.projectId)).sort(byDue) },
  ]
    // Projects with nothing open stay out of the way (they can still be picked when adding
    // a to-do), except the one being added to, such as a project just made.
    .filter((g) => g.list.length > 0 || g.id === adding)
    // Most urgent first: the earliest due date leads; undated work, then an empty project, go last.
    .sort((a, b) => {
      const ka = a.list.length ? (a.list[0]!.dueDate ?? '9999') : '~';
      const kb = b.list.length ? (b.list[0]!.dueDate ?? '9999') : '~';
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  return (
    <div className="todo-groups">
      {groups.map((g) => {
        const next = g.list.find((t) => t.dueDate)?.dueDate;
        const due = next ? dueLabel(next, today) : null;
        const late = g.list.filter((t) => t.dueDate && t.dueDate < today).length;
        return (
          <details
            key={g.id}
            className={cx('todo-group', !g.list.length && 'is-empty')}
            // Open while adding to it; otherwise open unless you folded it (an empty one stays shut).
            open={adding === g.id || (g.list.length > 0 && isOpen(g.id))}
            onToggle={(e) => g.list.length > 0 && adding !== g.id && toggle(g.id, e.currentTarget.open)}
          >
            <summary>
              <ChevronRight size={14} className="todo-fold-chev" aria-hidden />
              <span className="todo-group-name clamp-1">{g.name}</span>
              <span className={cx('todo-fold-meta', late > 0 && 'late')}>
                {g.list.length ? plural(g.list.length, 'to-do') : 'Nothing open'}
                {late > 0 ? ` · ${late} late` : due ? ` · next ${due.text}` : ''}
              </span>
              {g.project && <ProjectActions project={g.project} onAdd={() => setAdding(g.id)} />}
            </summary>
            <ul>
              {g.list.map((t) => (
                <TaskRow key={t.id} task={t} showSphere={false} />
              ))}
            </ul>
            {adding === g.id && g.project && (
              <div className="todo-group-add">
                <AddTask sphereId={sphereId} projectId={g.project.id} placeholder={`Add to ${g.project.name}…`} autoFocus />
              </div>
            )}
          </details>
        );
      })}
      {naming ? (
        <NewProject
          sphereId={sphereId}
          onDone={(created) => {
            setNaming(false);
            if (created) setAdding(created.id);
          }}
        />
      ) : (
        <button type="button" className="todo-new-project" onClick={() => setNaming(true)}>
          <Plus size={13} /> New project
        </button>
      )}
    </div>
  );
}

function ProjectActions({ project, onAdd }: { project: Project; onAdd: () => void }) {
  const rename = useWrite((name: string) => write.patch(`/projects/${project.id}`, { name }));
  const archive = useWrite(() => write.patch(`/projects/${project.id}`, { archived: true }));
  // The buttons sit inside the fold's summary, so a click must not also open or close it.
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  return (
    <span className="todo-group-actions">
      <button type="button" className="icon-btn" title={`Add a to-do to ${project.name}`} aria-label={`Add a to-do to ${project.name}`} onClick={act(onAdd)}>
        <Plus size={14} />
      </button>
      <button
        type="button"
        className="icon-btn"
        title="Rename"
        aria-label={`Rename ${project.name}`}
        onClick={act(() => {
          const next = window.prompt('Rename project', project.name)?.trim();
          if (next && next !== project.name) rename.mutate(next);
        })}
      >
        <Pencil size={13} />
      </button>
      <button
        type="button"
        className="icon-btn"
        title="Archive"
        aria-label={`Archive ${project.name}`}
        onClick={act(() => {
          if (window.confirm(`Archive ${project.name}? Its to-dos stay, under No project.`)) archive.mutate();
        })}
      >
        <Archive size={13} />
      </button>
    </span>
  );
}

function NewProject({ sphereId, onDone }: { sphereId: string; onDone: (created?: Project) => void }) {
  const [name, setName] = useState('');
  const create = useWrite((n: string) => write.post<Project>('/projects', { sphereId, name: n }));
  return (
    <form
      className="add-row todo-new-project-form"
      onSubmit={(e) => {
        e.preventDefault();
        const n = name.trim();
        if (n) create.mutate(n, { onSuccess: (p) => onDone(p) });
      }}
    >
      <Plus size={16} className="faint" aria-hidden />
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" aria-label="Project name" maxLength={80} autoFocus onKeyDown={(e) => e.key === 'Escape' && onDone()} />
      <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim() || create.isPending}>
        Add
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onDone()}>
        Cancel
      </button>
    </form>
  );
}

/**
 * Every open to-do by its due day: late ones together, then each day in turn, then undated.
 * Each day folds like a project does, and the ones you fold stay folded next time.
 */
function DayGroups({ tasks, today, label }: { tasks: Task[]; today: string; label: (t: Task) => string | undefined }) {
  // A day that has passed joins Late, so its fold is let go.
  const { isOpen, toggle } = useFolds('work-todos-folded-days', (k) => k === 'late' || k === 'none' || k >= today);
  const groups = new Map<string, Task[]>();
  for (const t of [...tasks].sort(byDue)) {
    const key = !t.dueDate ? 'none' : t.dueDate < today ? 'late' : t.dueDate;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const heading = (key: string) => {
    if (key === 'late') return 'Late';
    if (key === 'none') return 'No date';
    if (key === today) return 'Today';
    if (key === addDays(today, 1)) return 'Tomorrow';
    return parseDay(key).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  };
  if (!tasks.length) return null;
  return (
    <div className="todo-groups">
      {[...groups].map(([key, list]) => (
        <details key={key} className={cx('todo-group', key === 'late' && 'is-late')} open={isOpen(key)} onToggle={(e) => toggle(key, e.currentTarget.open)}>
          <summary>
            <ChevronRight size={14} className="todo-fold-chev" aria-hidden />
            <span className="todo-group-name clamp-1">{heading(key)}</span>
            <span className={cx('todo-fold-meta', key === 'late' && 'late')}>{plural(list.length, 'to-do')}</span>
          </summary>
          <ul>
            {list.map((t) => (
              <TaskRow key={t.id} task={t} showSphere={false} showDue={key === 'late'} tag={label(t)} />
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
