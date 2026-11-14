// Editors that open over the page. Simple things have a Save button; a goal is a small
// workspace of its own and saves as you go.

import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { CATALOG, CATALOG_BY_KEY, HORIZON_LABEL } from '../../../shared/catalog.ts';
import type { Cadence, Direction, Goal, Habit, Horizon, Metric, Note, Task } from '../../../shared/types.ts';
import { api, useGoal, useMetrics, useTasks, useWrite, write } from '../api.ts';
import { cx, formatNumber, hueStyle, monthDay, pct, shortDay, todayStr, weekdayLong } from '../lib.ts';
import { useApp, type Sheet } from '../state.tsx';
import { SPHERE_ICONS, SphereIcon } from './Icon.tsx';
import { Orb } from './Orb.tsx';
import { AddTask, TaskRow } from './rows.tsx';
import { AutoTextarea, Check, Field, InlineEdit, Loading, Modal, ProgressBar, Seg, SphereSelect } from './ui.tsx';

const HUES = [152, 118, 86, 54, 22, 352, 318, 284, 246, 208, 176];

/** A delete button that asks once before it acts. */
function ConfirmDelete({ onConfirm, label = 'Delete', sure = 'Delete for good?' }: { onConfirm: () => void; label?: string; sure?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button type="button" className="btn btn-danger btn-sm" onClick={() => (armed ? onConfirm() : setArmed(true))}>
      <Trash2 size={14} /> {armed ? sure : label}
    </button>
  );
}

// ── Goal ────────────────────────────────────────────────────────────────────

function GoalSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { sphere } = useApp();
  const { data: goal, isError } = useGoal(id);
  const { data: metrics = [] } = useMetrics();
  const { data: tasks = [] } = useTasks({ goalId: id, status: 'all' });
  const [step, setStep] = useState('');
  const today = todayStr();

  const patch = useWrite((body: Partial<Goal>) => write.patch(`/goals/${id}`, body));
  const addStep = useWrite((title: string) => write.post(`/goals/${id}/milestones`, { title }));
  const setStepDone = useWrite((v: { id: string; done: boolean }) => write.patch(`/milestones/${v.id}`, { done: v.done }));
  const removeStep = useWrite((mid: string) => write.del(`/milestones/${mid}`));
  const remove = useWrite(() => write.del(`/goals/${id}`));

  if (isError) return <Modal title="Goal" onClose={onClose}><p className="muted">This goal no longer exists.</p></Modal>;
  if (!goal) return <Modal title="Goal" onClose={onClose}><Loading /></Modal>;

  const s = sphere(goal.sphereId);
  const sphereMetrics = metrics.filter((m) => m.sphereId === goal.sphereId);
  const linked = metrics.find((m) => m.id === goal.metricId);
  const closed = goal.status !== 'active';

  const footer = (
    <>
      <ConfirmDelete onConfirm={() => remove.mutate(undefined, { onSuccess: onClose })} />
      <div className="row">
        {closed ? (
          <button className="btn btn-sm" onClick={() => patch.mutate({ status: 'active' })}>
            Pick back up
          </button>
        ) : (
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => patch.mutate({ status: 'dropped' })}>
              Let go
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => patch.mutate({ status: 'paused' })}>
              Pause
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => patch.mutate({ status: 'done' })}>
              Mark reached
            </button>
          </>
        )}
      </div>
    </>
  );

  return (
    <Modal title={s ? `Goal · ${s.name}` : 'Goal'} onClose={onClose} footer={footer} wide>
      <div className="tint stack" style={{ ...(s ? hueStyle(s.hue) : {}), gap: 16 }}>
        <InlineEdit label="Goal title" className="title-input" value={goal.title} onSave={(title) => title && patch.mutate({ title })} />

        <div className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="num" style={{ fontSize: 22 }}>
              {pct(goal.progress)}
            </span>
            <span className="hint">
              {goal.status === 'done'
                ? 'Reached'
                : goal.progressSource === 'metric' && linked
                  ? `${linked.name}: ${linked.latest === null ? 'no entries yet' : formatNumber(linked.latest)} → ${formatNumber(goal.targetValue ?? 0)}${linked.unit ? ` ${linked.unit}` : ''}`
                  : goal.progressSource === 'milestones'
                    ? `${goal.milestones.filter((m) => m.done).length} of ${goal.milestones.length} steps`
                    : 'Set by hand'}
            </span>
          </div>
          <ProgressBar value={goal.progress} />
          {goal.progressSource === 'manual' && goal.status === 'active' && (
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              defaultValue={goal.manualProgress}
              aria-label="Progress"
              style={{ accentColor: 'var(--sphere)' }}
              onPointerUp={(e) => patch.mutate({ manualProgress: Number(e.currentTarget.value) })}
              onKeyUp={(e) => patch.mutate({ manualProgress: Number(e.currentTarget.value) })}
            />
          )}
        </div>

        <InlineEdit label="Why this matters" multiline value={goal.why} placeholder="Why does this matter to you?" onSave={(why) => patch.mutate({ why })} className="muted" />

        <div className="field-row">
          <Field label="Target date">
            <input type="date" className="input" defaultValue={goal.targetDate ?? ''} onChange={(e) => patch.mutate({ targetDate: e.target.value || null })} />
          </Field>
          <Field label="Horizon">
            <select className="select" value={goal.horizon} onChange={(e) => patch.mutate({ horizon: e.target.value as Horizon })}>
              {Object.entries(HORIZON_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="stack" style={{ gap: 4 }}>
          <span className="label">Steps</span>
          <ul>
            {goal.milestones.map((m) => (
              <li key={m.id} className={cx('milestone', m.done && 'done')}>
                <Check checked={m.done} onChange={(done) => setStepDone.mutate({ id: m.id, done })} label={m.title} />
                <span>{m.title}</span>
                <button className="icon-btn icon-btn-sm" aria-label={`Remove step: ${m.title}`} onClick={() => removeStep.mutate(m.id)}>
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!step.trim()) return;
              addStep.mutate(step);
              setStep('');
            }}
          >
            <Plus size={16} className="faint" />
            <input className="input" style={{ border: 0, padding: '6px 0', boxShadow: 'none', background: 'transparent' }} value={step} onChange={(e) => setStep(e.target.value)} placeholder="Add a step…" aria-label="New step" maxLength={200} />
          </form>
        </div>

        {sphereMetrics.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="label">Or let a number drive progress</span>
            <div className="field-row">
              <select className="select" value={goal.metricId ?? ''} onChange={(e) => patch.mutate({ metricId: e.target.value || null })} aria-label="Linked metric">
                <option value="">Not linked</option>
                {sphereMetrics.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {goal.metricId && (
                <div className="row">
                  <input className="input num" inputMode="decimal" aria-label="Starting value" title="Starting value" defaultValue={goal.startValue ?? ''} key={`s${goal.startValue}`} placeholder="From" onBlur={(e) => e.target.value !== '' && patch.mutate({ startValue: Number(e.target.value) })} />
                  <span className="faint">→</span>
                  <input className="input num" inputMode="decimal" aria-label="Target value" title="Target value" defaultValue={goal.targetValue ?? ''} key={`t${goal.targetValue}`} placeholder="To" onBlur={(e) => e.target.value !== '' && patch.mutate({ targetValue: Number(e.target.value) })} />
                </div>
              )}
            </div>
          </div>
        )}

        <div className="stack" style={{ gap: 0 }}>
          <span className="label">Tasks toward this</span>
          <ul style={{ margin: '4px -20px 0' }}>
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} showSphere={false} />
            ))}
          </ul>
          <div style={{ margin: '0 -20px' }}>
            <AddTask goalId={goal.id} placeholder="Add a task toward this goal…" />
          </div>
        </div>
        {goal.completedAt && <span className="hint">Reached {shortDay(todayStr(new Date(goal.completedAt)))}.</span>}
        {!goal.completedAt && goal.targetDate && goal.targetDate < today && goal.status === 'active' && <span className="hint">The target date has passed — move it, or decide what to do with this goal.</span>}
      </div>
    </Modal>
  );
}

function NewGoalSheet({ sphereId, onClose }: { sphereId?: string; onClose: () => void }) {
  const { spheres, openSheet } = useApp();
  const [title, setTitle] = useState('');
  const [sphere, setSphere] = useState<string | null>(sphereId ?? spheres[0]?.id ?? null);
  const [why, setWhy] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [horizon, setHorizon] = useState<Horizon>('year');
  const [steps, setSteps] = useState('');
  const create = useWrite((body: object) => write.post<Goal>('/goals', body));
  const picked = spheres.find((s) => s.id === sphere);
  const ideas = picked?.key ? (CATALOG_BY_KEY[picked.key]?.goalIdeas ?? []) : [];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !sphere) return;
    create.mutate(
      { title, sphereId: sphere, why, horizon, targetDate: targetDate || null, milestones: steps.split('\n').map((s) => s.trim()).filter(Boolean) },
      { onSuccess: (goal) => openSheet({ kind: 'goal', id: goal.id }) },
    );
  };

  return (
    <Modal title="New goal" onClose={onClose}>
      <form className="stack" style={{ gap: 16 }} onSubmit={submit}>
        <AutoTextarea className="title-input" value={title} onChange={setTitle} placeholder={ideas[0] ?? 'What do you want to be true?'} maxLength={200} data-autofocus onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} />
        <div className="field-row">
          <Field label="Sphere">
            <SphereSelect value={sphere} onChange={setSphere} allowNone={false} />
          </Field>
          <Field label="Horizon">
            <select className="select" value={horizon} onChange={(e) => setHorizon(e.target.value as Horizon)}>
              {Object.entries(HORIZON_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Why it matters">
          <AutoTextarea className="textarea" minRows={2} value={why} onChange={setWhy} placeholder="The reason you'll still care in three months." maxLength={600} />
        </Field>
        <Field label="Steps" hint="One per line. Progress follows the steps you tick off — or link a number later.">
          <AutoTextarea className="textarea" minRows={3} value={steps} onChange={setSteps} placeholder={'First step\nSecond step'} />
        </Field>
        <Field label="Target date">
          <input type="date" className="input" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </Field>
        {create.error && <p className="error-text">{create.error.message}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!title.trim() || !sphere || create.isPending}>
            Create goal
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Task ────────────────────────────────────────────────────────────────────

function TaskSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: task, isError } = useQuery({ queryKey: ['task', id], queryFn: () => api<Task>('GET', `/tasks/${id}`), retry: false });
  if (isError) return <Modal title="Task" onClose={onClose}><p className="muted">This task no longer exists.</p></Modal>;
  if (!task) return <Modal title="Task" onClose={onClose}><Loading /></Modal>;
  return <TaskForm key={task.id} task={task} onClose={onClose} />;
}

function TaskForm({ task, onClose }: { task: Task; onClose: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const [sphereId, setSphereId] = useState(task.sphereId);
  const [dueDate, setDueDate] = useState(task.dueDate ?? '');
  const save = useWrite((body: object) => write.patch(`/tasks/${task.id}`, body));
  const remove = useWrite(() => write.del(`/tasks/${task.id}`));

  return (
    <Modal
      title="Task"
      onClose={onClose}
      footer={
        <>
          <ConfirmDelete onConfirm={() => remove.mutate(undefined, { onSuccess: onClose })} />
          <div className="row">
            <button className="btn btn-ghost btn-sm" onClick={() => save.mutate({ done: !task.done }, { onSuccess: onClose })}>
              {task.done ? 'Reopen' : 'Mark done'}
            </button>
            <button className="btn btn-primary btn-sm" disabled={!title.trim()} onClick={() => save.mutate({ title, notes, sphereId, dueDate: dueDate || null }, { onSuccess: onClose })}>
              Save
            </button>
          </div>
        </>
      }
    >
      <AutoTextarea className="title-input" value={title} onChange={setTitle} maxLength={200} aria-label="Task" />
      <div className="field-row">
        <Field label="Due">
          <input type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Sphere">
          <SphereSelect value={sphereId} onChange={setSphereId} />
        </Field>
      </div>
      <Field label="Notes">
        <AutoTextarea className="textarea" minRows={3} value={notes} onChange={setNotes} maxLength={2000} placeholder="Anything worth remembering about this." />
      </Field>
      <span className="hint">Added {shortDay(todayStr(new Date(task.createdAt)))}.</span>
    </Modal>
  );
}

// ── Note ────────────────────────────────────────────────────────────────────

function NoteSheet({ id, sphereId, onClose }: { id?: string; sphereId?: string; onClose: () => void }) {
  const { data: note, isError } = useQuery({ queryKey: ['note', id], queryFn: () => api<Note>('GET', `/notes/${id}`), enabled: !!id, retry: false });
  if (id && isError) return <Modal title="Note" onClose={onClose}><p className="muted">This note no longer exists.</p></Modal>;
  if (id && !note) return <Modal title="Note" onClose={onClose}><Loading /></Modal>;
  return <NoteForm note={note ?? null} sphereId={sphereId} onClose={onClose} />;
}

function NoteForm({ note, sphereId, onClose }: { note: Note | null; sphereId?: string; onClose: () => void }) {
  const journal = note?.kind === 'journal';
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [url, setUrl] = useState(note?.url ?? '');
  const [sphere, setSphere] = useState<string | null>(note?.sphereId ?? sphereId ?? null);
  const save = useWrite(() => {
    if (journal) return write.put(`/journal/${note!.date}`, { body });
    const payload = { title, body, url, sphereId: sphere };
    return note ? write.patch(`/notes/${note.id}`, payload) : write.post('/notes', payload);
  });
  const remove = useWrite(() => (journal ? write.put(`/journal/${note!.date}`, { body: '' }) : write.del(`/notes/${note!.id}`)));
  const pin = useWrite((pinned: boolean) => write.patch(`/notes/${note!.id}`, { pinned }));
  const empty = !title.trim() && !body.trim() && !url.trim();

  return (
    <Modal
      wide
      title={journal ? 'Journal' : note ? 'Note' : 'New note'}
      onClose={onClose}
      footer={
        <>
          <div className="row">
            {note && <ConfirmDelete onConfirm={() => remove.mutate(undefined, { onSuccess: onClose })} />}
            {note && !journal && (
              <button className="btn btn-ghost btn-sm" onClick={() => pin.mutate(!note.pinned)}>
                {note.pinned ? 'Unpin' : 'Pin'}
              </button>
            )}
          </div>
          <button className="btn btn-primary btn-sm" disabled={empty || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Save
          </button>
        </>
      }
    >
      {note?.capture && (
        <>
          {note.capture.imageFileId && (
            <div className="capture-detail-image">
              <img src={`/api/files/${note.capture.imageFileId}`} alt="" />
            </div>
          )}
          <div className="row-wrap" style={{ gap: 6 }}>
            <span className="chip">
              {note.capture.site || note.capture.kind}
              {note.capture.author ? ` · ${note.capture.author}` : ''}
            </span>
            {note.capture.collection && <span className="chip chip-outline">{note.capture.collection}</span>}
            {note.capture.tags.map((t) => (
              <span key={t} className="tag-chip">
                #{t}
              </span>
            ))}
            {note.url && /^https?:\/\//i.test(note.url) && (
              <a className="btn btn-sm" href={note.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={13} /> Open original
              </a>
            )}
          </div>
        </>
      )}
      {journal ? (
        <h3 className="title-input">
          {weekdayLong(note!.date!)}, {monthDay(note!.date!)}
        </h3>
      ) : (
        <AutoTextarea className="title-input" value={title} onChange={setTitle} placeholder="Title" maxLength={200} data-autofocus={note ? undefined : true} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} />
      )}
      <AutoTextarea
        className="textarea"
        style={{ minHeight: 200, border: 0, padding: 0, boxShadow: 'none', ...(journal ? { fontFamily: 'var(--serif)', fontSize: 19 } : {}) }}
        value={body}
        onChange={setBody}
        placeholder={journal ? 'What happened? What is on your mind?' : 'Write, paste, think…'}
        aria-label="Body"
        minRows={8}
      />
      {!journal && (
        <div className="field-row">
          <Field label="Link">
            <div className="row">
              <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
              {/^https?:\/\//i.test(url.trim()) && (
                <a className="icon-btn" href={url.trim()} target="_blank" rel="noopener noreferrer" aria-label="Open link in a new tab" title="Open link">
                  <ExternalLink size={16} />
                </a>
              )}
            </div>
          </Field>
          <Field label="Sphere">
            <SphereSelect value={sphere} onChange={setSphere} />
          </Field>
        </div>
      )}
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

// ── Sphere ──────────────────────────────────────────────────────────────────

function LookPicker({ hue, icon, onHue, onIcon }: { hue: number; icon: string; onHue: (h: number) => void; onIcon: (i: string) => void }) {
  return (
    <>
      <Field label="Colour">
        <div className="swatches">
          {HUES.map((h) => (
            <button key={h} type="button" className="swatch" style={hueStyle(h)} aria-pressed={h === hue} aria-label={`Hue ${h}`} onClick={() => onHue(h)} />
          ))}
        </div>
      </Field>
      <Field label="Icon">
        <div className="icon-choices">
          {Object.keys(SPHERE_ICONS).map((name) => (
            <button key={name} type="button" aria-pressed={name === icon} aria-label={name} onClick={() => onIcon(name)}>
              <SphereIcon name={name} size={18} />
            </button>
          ))}
        </div>
      </Field>
    </>
  );
}

function SphereSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useApp().sphere(id);
  const [, navigate] = useLocation();
  const leave = () => {
    onClose();
    navigate('/spheres');
  };
  const [name, setName] = useState(s?.name ?? '');
  const [hue, setHue] = useState(s?.hue ?? 220);
  const [icon, setIcon] = useState(s?.icon ?? 'circle');
  const save = useWrite((body: object) => write.patch(`/spheres/${id}`, body));
  const remove = useWrite(() => write.del(`/spheres/${id}`));
  if (!s) return null;

  return (
    <Modal
      title="Edit sphere"
      onClose={onClose}
      footer={
        <>
          <div className="row">
            <ConfirmDelete sure="Delete it and everything in it?" onConfirm={() => remove.mutate(undefined, { onSuccess: leave })} />
            <button className="btn btn-ghost btn-sm" onClick={() => save.mutate({ archived: true }, { onSuccess: leave })}>
              Archive
            </button>
          </div>
          <button className="btn btn-primary btn-sm" disabled={!name.trim()} onClick={() => save.mutate({ name, hue, icon }, { onSuccess: onClose })}>
            Save
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 16 }}>
        <Orb hue={hue} icon={icon} size={56} />
        <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Sphere name" />
      </div>
      <LookPicker hue={hue} icon={icon} onHue={setHue} onIcon={setIcon} />
      <span className="hint">Archiving hides a sphere without deleting anything. Bring it back from Settings.</span>
    </Modal>
  );
}

function NewSphereSheet({ onClose }: { onClose: () => void }) {
  const { spheres } = useApp();
  const used = new Set(spheres.map((s) => s.key).filter(Boolean));
  const available = CATALOG.filter((c) => !used.has(c.key));
  const [custom, setCustom] = useState(available.length === 0);
  const [name, setName] = useState('');
  const [hue, setHue] = useState(208);
  const [icon, setIcon] = useState('star');
  const create = useWrite((body: object) => write.post('/spheres', body));

  return (
    <Modal title="Add a sphere" onClose={onClose} wide>
      {!custom ? (
        <>
          <p className="muted">A sphere is an area of life you want to tend on purpose. Start from one of these, or make your own.</p>
          <div className="pick-grid">
            {available.map((c) => (
              <button key={c.key} type="button" className="pick tint" style={hueStyle(c.hue)} onClick={() => create.mutate({ key: c.key }, { onSuccess: onClose })}>
                <Orb hue={c.hue} icon={c.icon} size={34} />
                <span>
                  <strong>{c.name}</strong>
                  <small>{c.blurb}</small>
                </span>
              </button>
            ))}
          </div>
          <div>
            <button type="button" className="btn" onClick={() => setCustom(true)}>
              <Plus size={15} /> Make your own
            </button>
          </div>
        </>
      ) : (
        <form
          className="stack"
          style={{ gap: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate({ name, hue, icon }, { onSuccess: onClose });
          }}
        >
          <div className="row" style={{ gap: 16 }}>
            <Orb hue={hue} icon={icon} size={56} />
            <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name it" maxLength={60} data-autofocus aria-label="Sphere name" />
          </div>
          <LookPicker hue={hue} icon={icon} onHue={setHue} onIcon={setIcon} />
          {create.error && <p className="error-text">{create.error.message}</p>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {available.length > 0 && (
              <button type="button" className="btn btn-ghost" onClick={() => setCustom(false)}>
                Back
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
              Add sphere
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ── Habit & metric ──────────────────────────────────────────────────────────

function HabitSheet({ sphereId, id, onClose }: { sphereId: string; id?: string; onClose: () => void }) {
  const { data: existing, isError } = useQuery({ queryKey: ['habit', id], queryFn: () => api<Habit>('GET', `/habits/${id}?date=${todayStr()}`), enabled: !!id, retry: false });
  if (id && isError) return <Modal title="Habit" onClose={onClose}><p className="muted">This habit no longer exists.</p></Modal>;
  if (id && !existing) return <Modal title="Habit" onClose={onClose}><Loading /></Modal>;
  return <HabitForm key={existing?.id ?? 'new'} habit={existing} sphereId={sphereId} onClose={onClose} />;
}

function HabitForm({ habit, sphereId, onClose }: { habit?: Habit; sphereId: string; onClose: () => void }) {
  const [name, setName] = useState(habit?.name ?? '');
  const [cadence, setCadence] = useState<Cadence>(habit?.cadence ?? 'daily');
  const [perWeek, setPerWeek] = useState(habit && habit.cadence === 'weekly' ? habit.targetPerWeek : 3);
  const save = useWrite(() => {
    const body = { name, cadence, targetPerWeek: cadence === 'daily' ? 7 : perWeek };
    return habit ? write.patch(`/habits/${habit.id}`, body) : write.post('/habits', { ...body, sphereId });
  });
  const remove = useWrite(() => write.del(`/habits/${habit!.id}`));

  return (
    <Modal
      title={habit ? 'Habit' : 'New habit'}
      onClose={onClose}
      footer={
        <>
          {habit ? <ConfirmDelete sure="Delete it and its history?" onConfirm={() => remove.mutate(undefined, { onSuccess: onClose })} /> : <span />}
          <button className="btn btn-primary btn-sm" disabled={!name.trim() || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            {habit ? 'Save' : 'Add habit'}
          </button>
        </>
      }
    >
      <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="What will you practise?" maxLength={120} data-autofocus aria-label="Habit name" />
      <Field label="How often">
        <div className="row-wrap">
          <Seg label="Cadence" value={cadence} onChange={setCadence} options={[{ value: 'daily', label: 'Every day' }, { value: 'weekly', label: 'A few times a week' }]} />
          {cadence === 'weekly' && (
            <select className="select" style={{ width: 'auto' }} value={perWeek} onChange={(e) => setPerWeek(Number(e.target.value))} aria-label="Times per week">
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}× a week
                </option>
              ))}
            </select>
          )}
        </div>
      </Field>
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

function MetricSheet({ sphereId, id, onClose }: { sphereId: string; id?: string; onClose: () => void }) {
  const { data: metrics } = useMetrics();
  const existing = id ? metrics?.find((m) => m.id === id) : undefined;
  if (id && !metrics) return <Modal title="Metric" onClose={onClose}><Loading /></Modal>;
  return <MetricForm key={existing?.id ?? 'new'} metric={existing} sphereId={sphereId} onClose={onClose} />;
}

function MetricForm({ metric, sphereId, onClose }: { metric?: Metric; sphereId: string; onClose: () => void }) {
  const [name, setName] = useState(metric?.name ?? '');
  const [unit, setUnit] = useState(metric?.unit ?? '');
  const [direction, setDirection] = useState<Direction>(metric?.direction ?? 'up');
  const save = useWrite(() => {
    const body = { name, unit, direction };
    return metric ? write.patch(`/metrics/${metric.id}`, body) : write.post('/metrics', { ...body, sphereId });
  });
  const remove = useWrite(() => write.del(`/metrics/${metric!.id}`));
  const removeEntry = useWrite((entryId: string) => write.del(`/metric-entries/${entryId}`));
  const recent = metric ? [...metric.entries].reverse().slice(0, 8) : [];

  return (
    <Modal
      title={metric ? 'Metric' : 'New metric'}
      onClose={onClose}
      footer={
        <>
          {metric ? <ConfirmDelete sure="Delete it and its history?" onConfirm={() => remove.mutate(undefined, { onSuccess: onClose })} /> : <span />}
          <button className="btn btn-primary btn-sm" disabled={!name.trim() || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            {metric ? 'Save' : 'Start tracking'}
          </button>
        </>
      }
    >
      <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="What are you measuring?" maxLength={120} data-autofocus aria-label="Metric name" />
      <div className="field-row">
        <Field label="Unit" hint="kg, h, km — or leave empty.">
          <input className="input" value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={12} />
        </Field>
        <Field label="Which way is better">
          <Seg label="Direction" value={direction} onChange={setDirection} options={[{ value: 'up', label: 'Higher' }, { value: 'down', label: 'Lower' }, { value: 'none', label: 'Neither' }]} />
        </Field>
      </div>
      {recent.length > 0 && (
        <div className="stack" style={{ gap: 0 }}>
          <span className="label">Recent entries</span>
          {recent.map((e) => (
            <div key={e.id} className="list-row">
              <span className="grow muted">{shortDay(e.date)}</span>
              <span className="num">
                {formatNumber(e.value)} {metric!.unit}
              </span>
              <button className="icon-btn icon-btn-sm" aria-label={`Remove entry for ${e.date}`} onClick={() => removeEntry.mutate(e.id)}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

// ── Host ────────────────────────────────────────────────────────────────────

export function Sheets({ sheet, onClose }: { sheet: Sheet | null; onClose: () => void }) {
  // Keep a stable callback so an open editor's effects don't re-run on every render.
  const close = useRef(onClose);
  close.current = onClose;
  const [stableClose] = useState(() => () => close.current());
  if (!sheet) return null;
  switch (sheet.kind) {
    case 'goal':
      return <GoalSheet key={sheet.id} id={sheet.id} onClose={stableClose} />;
    case 'new-goal':
      return <NewGoalSheet sphereId={sheet.sphereId} onClose={stableClose} />;
    case 'task':
      return <TaskSheet key={sheet.id} id={sheet.id} onClose={stableClose} />;
    case 'note':
      return <NoteSheet key={sheet.id} id={sheet.id} onClose={stableClose} />;
    case 'new-note':
      return <NoteSheet sphereId={sheet.sphereId} onClose={stableClose} />;
    case 'sphere':
      return <SphereSheet key={sheet.id} id={sheet.id} onClose={stableClose} />;
    case 'new-sphere':
      return <NewSphereSheet onClose={stableClose} />;
    case 'habit':
      return <HabitSheet sphereId={sheet.sphereId} id={sheet.id} onClose={stableClose} />;
    case 'metric':
      return <MetricSheet sphereId={sheet.sphereId} id={sheet.id} onClose={stableClose} />;
  }
}
