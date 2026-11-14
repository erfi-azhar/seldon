// The repeating pieces: a task, a habit, a metric, a goal.

import { ArrowDownRight, ArrowUpRight, Flame, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import type { Goal, Habit, Metric, Task } from '../../../shared/types.ts';
import { useWrite, write } from '../api.ts';
import { addDays, cx, dueLabel, formatNumber, hueStyle, parseDay, parseNumber, pct, relativeDay, todayStr } from '../lib.ts';
import { useApp } from '../state.tsx';
import { Check, ProgressBar, SphereSelect } from './ui.tsx';

// ── Tasks ───────────────────────────────────────────────────────────────────

export function TaskRow({ task, showSphere = true }: { task: Task; showSphere?: boolean }) {
  const { sphere, openSheet } = useApp();
  const today = todayStr();
  const s = sphere(task.sphereId);
  const toggle = useWrite((done: boolean) => write.patch(`/tasks/${task.id}`, { done }));
  const due = task.dueDate && !task.done ? dueLabel(task.dueDate, today) : null;
  // Shown immediately, before the server confirms.
  const done = toggle.isPending ? toggle.variables : task.done;

  return (
    <li className={cx('task', s && 'tint', done && 'done')} style={s ? hueStyle(s.hue) : undefined}>
      <Check checked={done} onChange={(next) => toggle.mutate(next)} label={`${done ? 'Reopen' : 'Complete'}: ${task.title}`} />
      <button type="button" className="task-title" style={{ textAlign: 'left' }} onClick={() => openSheet({ kind: 'task', id: task.id })}>
        {task.title}
        {/* The dot says which sphere by colour alone; say it in words as well. */}
        {showSphere && s && <span className="sr-only">, {s.name}</span>}
      </button>
      <span className="task-meta">
        {due && <span className={cx(due.late && 'late')}>{due.text}</span>}
        {showSphere && s && <span className="dot" title={s.name} aria-hidden />}
      </span>
    </li>
  );
}

export function AddTask({ sphereId, goalId, placeholder = 'Add a task…' }: { sphereId?: string; goalId?: string; placeholder?: string }) {
  const [title, setTitle] = useState('');
  const [sphere, setSphere] = useState<string | null>(null);
  const [due, setDue] = useState('');
  const add = useWrite((body: object) => write.post('/tasks', body));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    add.mutate({ title, sphereId: sphereId ?? sphere, goalId: goalId ?? null, dueDate: due || null });
    setTitle('');
    setDue('');
  };

  return (
    <form className="add-row" onSubmit={submit}>
      <Plus size={16} className="faint" aria-hidden />
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={placeholder} aria-label="New task" maxLength={200} />
      {title.trim() && (
        <>
          {!sphereId && !goalId && <SphereSelect className="mini-select" value={sphere} onChange={setSphere} noneLabel="Sphere" />}
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
          <button type="submit" className="btn btn-primary btn-sm">
            Add
          </button>
        </>
      )}
    </form>
  );
}

// ── Habits ──────────────────────────────────────────────────────────────────

export function HabitRow({ habit, showSphere = false }: { habit: Habit; showSphere?: boolean }) {
  const { sphere, openSheet } = useApp();
  const today = todayStr();
  const s = sphere(habit.sphereId);
  const log = useWrite((date: string) => write.post(`/habits/${habit.id}/log?date=${today}`, { date }));
  const done = new Set(habit.log);
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const cadence = habit.cadence === 'daily' ? 'Daily' : `${habit.weekCount} of ${habit.targetPerWeek} this week`;

  return (
    <li className="habit tint" style={s ? hueStyle(s.hue) : undefined}>
      <Check checked={habit.doneToday} onChange={() => log.mutate(today)} label={`${habit.doneToday ? 'Uncheck' : 'Check in'}: ${habit.name}`} />
      <button type="button" className="habit-name" style={{ textAlign: 'left' }} onClick={() => openSheet({ kind: 'habit', sphereId: habit.sphereId, id: habit.id })}>
        {habit.name}
        <small>
          {showSphere && s ? `${s.name} · ` : ''}
          {cadence}
        </small>
      </button>
      <div className="week" aria-label="Last seven days">
        {days.map((d) => (
          <button
            key={d}
            type="button"
            className={cx(d === today && 'is-today')}
            aria-pressed={done.has(d)}
            aria-label={`${parseDay(d).toLocaleDateString(undefined, { weekday: 'long' })}: ${done.has(d) ? 'done' : 'not done'}`}
            title={parseDay(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
            onClick={() => log.mutate(d)}
          />
        ))}
      </div>
      <span className="streak" title={habit.cadence === 'daily' ? 'Days in a row' : 'Weeks on target in a row'}>
        {habit.streak > 0 ? (
          <>
            <Flame size={12} style={{ verticalAlign: -1 }} aria-hidden /> <b>{habit.streak}</b>
          </>
        ) : (
          '—'
        )}
      </span>
    </li>
  );
}

// ── Metrics ─────────────────────────────────────────────────────────────────

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="spark" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * 100;
  const y = (v: number) => 36 - ((v - min) / span) * 32;
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' ');
  const last = values[values.length - 1]!;
  return (
    <div className="spark-wrap">
      <svg className="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
        <path className="area" d={`${line} L100 40 L0 40 Z`} />
        <path className="line" d={line} />
      </svg>
      {/* Drawn in HTML so it stays round while the chart stretches. */}
      <span className="spark-dot" style={{ left: '100%', top: `calc(6px + ${(y(last) / 40) * 44}px)` }} />
    </div>
  );
}

export function MetricCard({ metric }: { metric: Metric }) {
  const { openSheet } = useApp();
  const [draft, setDraft] = useState('');
  const log = useWrite((value: number) => write.post(`/metrics/${metric.id}/entries?date=${todayStr()}`, { value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = parseNumber(draft);
    if (!Number.isFinite(value)) return;
    log.mutate(value);
    setDraft('');
  };

  const change = metric.change;
  const better = change === null || change === 0 || metric.direction === 'none' ? null : metric.direction === 'up' ? change > 0 : change < 0;
  const lastDate = metric.entries.at(-1)?.date;

  return (
    <div className="metric">
      <div className="metric-name">
        <span className="clamp-1">{metric.name}</span>
        <button type="button" className="icon-btn icon-btn-sm" aria-label={`Edit ${metric.name}`} onClick={() => openSheet({ kind: 'metric', sphereId: metric.sphereId, id: metric.id })}>
          <Pencil size={13} />
        </button>
      </div>
      <div className="metric-value">
        {metric.latest === null ? <span className="faint">—</span> : formatNumber(metric.latest)}
        {metric.unit && metric.latest !== null && <small>{metric.unit}</small>}
      </div>
      <div className={cx('metric-delta', better === true && 'good', better === false && 'bad')}>
        {change !== null && change !== 0 ? (
          <>
            {change > 0 ? <ArrowUpRight size={12} style={{ verticalAlign: -2 }} /> : <ArrowDownRight size={12} style={{ verticalAlign: -2 }} />}{' '}
            {formatNumber(Math.abs(change))} since {parseDay(metric.entries[0]!.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </>
        ) : lastDate ? (
          `Logged ${relativeDay(lastDate, todayStr())}`
        ) : (
          'Nothing logged yet'
        )}
      </div>
      <Sparkline values={metric.entries.map((e) => e.value)} />
      <form className="metric-log" onSubmit={submit}>
        <input inputMode="decimal" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Log today…" aria-label={`Log ${metric.name}`} />
        {draft.trim() && (
          <button type="submit" className="btn btn-primary btn-sm">
            Log
          </button>
        )}
      </form>
    </div>
  );
}

// ── Goals ───────────────────────────────────────────────────────────────────

export function GoalRow({ goal, showSphere = false }: { goal: Goal; showSphere?: boolean }) {
  const { sphere, openSheet } = useApp();
  const today = todayStr();
  const s = sphere(goal.sphereId);
  const steps = goal.milestones.length;
  const stepsDone = goal.milestones.filter((m) => m.done).length;
  const next = goal.milestones.find((m) => !m.done);
  const closed = goal.status !== 'active';
  const late = goal.status === 'active' && goal.targetDate !== null && goal.targetDate < today;

  return (
    <button type="button" className={cx('goal tint', closed && 'is-closed')} style={s ? hueStyle(s.hue) : undefined} onClick={() => openSheet({ kind: 'goal', id: goal.id })}>
      <div className="goal-top">
        <span className="goal-title">{goal.title}</span>
        {goal.status === 'active' ? <span className="goal-pct">{pct(goal.progress)}</span> : <span className="chip">{goal.status === 'done' ? 'Reached' : goal.status === 'paused' ? 'Paused' : 'Let go'}</span>}
      </div>
      {goal.status !== 'dropped' && <ProgressBar value={goal.progress} />}
      <div className="goal-meta">
        {showSphere && s && <span>{s.name}</span>}
        {goal.status === 'active' && goal.targetDate && <span className={cx(late && 'late')}>{late ? `Target passed ${relativeDay(goal.targetDate, today)}` : `Target ${relativeDay(goal.targetDate, today)}`}</span>}
        {steps > 0 && (
          <span>
            {stepsDone}/{steps} steps
          </span>
        )}
        {goal.status === 'active' && next && <span className="clamp-1">Next: {next.title}</span>}
      </div>
    </button>
  );
}
