import { ArrowLeft, ArrowUpRight, Pencil, Plus, Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { CATALOG_BY_KEY } from '../../../shared/catalog.ts';
import { useSphere, useSpheres, useWrite, write } from '../api.ts';
import { Orb } from '../components/Orb.tsx';
import { AddTask, GoalRow, HabitRow, MetricCard, TaskRow } from '../components/rows.tsx';
import { SignalsCard } from '../components/Signals.tsx';
import { PrayerCard } from '../components/Prayer.tsx';
import { HealthPanels } from '../components/HealthPanels.tsx';
import { InlineEdit, Loading } from '../components/ui.tsx';
import { cx, hueStyle, pct, plural, shortDay, todayStr } from '../lib.ts';
import { useApp } from '../state.tsx';
import { normalise, useScreenings } from './Screenings.tsx';
import { ActivityFeed } from './Today.tsx';

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

  const { sphere: s, goals, habits, metrics, tasks, notes, activity } = data;
  const kit = s.key ? CATALOG_BY_KEY[s.key] : undefined;
  const active = goals.filter((g) => g.status === 'active');
  const closed = goals.filter((g) => g.status !== 'active');
  const habitNames = new Set(habits.map((h) => h.name.toLowerCase()));
  const metricNames = new Set(metrics.map((m) => m.name.toLowerCase()));
  const habitIdeas = (kit?.habits ?? []).filter((h) => !habitNames.has(h.name.toLowerCase()));
  const metricIdeas = (kit?.metrics ?? []).filter((m) => !metricNames.has(m.name.toLowerCase()));
  const quiet = s.stats.quietDays;

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
              Review with {agentName} <ArrowUpRight size={14} />
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

      {s.key === 'health' && <ScreeningsEntry sphereId={id} />}
      {s.key === 'health' && <HealthPanels />}

      <div className="detail-grid">
        <div className="col">
          <SignalsCard sphereId={id} title={`Needs you in ${s.name}`} />
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

        <div className="col">
          {s.key === 'faith' && <PrayerCard />}
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Habits</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => openSheet({ kind: 'habit', sphereId: id })}>
                <Plus size={14} /> New habit
              </button>
            </div>
            {habits.length === 0 && <p className="empty">No habits yet.</p>}
            <ul style={{ paddingBottom: habitIdeas.length ? 6 : 12 }}>
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

          {activity.length > 0 && (
            <section className="card" style={{ paddingBottom: 12 }}>
              <div className="card-head">
                <h2 className="card-title">Lately in {s.name}</h2>
              </div>
              <ActivityFeed items={activity} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
