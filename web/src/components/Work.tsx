// The Work board: a kanban of the pieces of work in hand (one card per PRD or requirement),
// and the vertical timeline their to-dos are laid out on.

import { CalendarDays, Paperclip, Plus } from 'lucide-react';
import { useState, type DragEvent, type ReactNode } from 'react';
import { Link } from 'wouter';
import type { Project, Task, WorkCard, WorkStage } from '../../../shared/types.ts';
import { useWorkBoard, useWrite, write } from '../api.ts';
import { cx, dueLabel, parseDay, plural, todayStr } from '../lib.ts';
import { TaskRow } from './rows.tsx';

export const STAGE_LABEL: Record<WorkStage, string> = { intake: 'Intake', discovery: 'Discovery', design: 'Design', review: 'Review', handoff: 'Handoff', done: 'Done' };

// ── The board ───────────────────────────────────────────────────────────────

export function WorkBoard() {
  const { data } = useWorkBoard();
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<WorkStage | null>(null);
  const move = useWrite((v: { id: string; stage: WorkStage; position?: number }) => write.patch(`/work/cards/${v.id}`, { stage: v.stage, position: v.position }));
  if (!data) return null;
  const today = todayStr();
  const byStage = (s: WorkStage) => data.cards.filter((c) => c.stage === s);

  /** Dropped on a card: it goes just above that card. Dropped on the column: to its end. */
  const drop = (e: DragEvent, stage: WorkStage, before?: WorkCard) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    const id = e.dataTransfer.getData('text/x-work-card') || dragging;
    setDragging(null);
    if (!id || id === before?.id) return;
    const col = byStage(stage).filter((c) => c.id !== id);
    if (!before) {
      if (data.cards.find((c) => c.id === id)?.stage !== stage) move.mutate({ id, stage });
      return;
    }
    const i = col.findIndex((c) => c.id === before.id);
    const prev = col[i - 1];
    move.mutate({ id, stage, position: prev ? (prev.position + before.position) / 2 : before.position - 1 });
  };

  return (
    <section className="card wb">
      <div className="card-head">
        <div className="row" style={{ gap: 10 }}>
          <h2 className="card-title">Board</h2>
          {data.cards.length > 0 && <span className="hint">{plural(data.cards.filter((c) => c.stage !== 'done').length, 'in hand', 'in hand')}</span>}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
          <Plus size={14} /> New work
        </button>
      </div>
      {data.cards.length === 0 && !adding && (
        <p className="empty">Each piece of work gets a card here: its PRD, notes, recordings and Figma files, and a timeline of what you need to do. Start one with the new-work skill, ask Seldon, or add it yourself.</p>
      )}
      <div className="wb-board">
        {data.stages.map((stage) => {
          const cards = byStage(stage);
          return (
            <div
              key={stage}
              className={cx('wb-col', over === stage && 'is-over', stage === 'done' && 'is-done')}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                setOver(stage);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
              }}
              onDrop={(e) => drop(e, stage)}
            >
              <div className="wb-col-head">
                <span>{STAGE_LABEL[stage]}</span>
                <span className="todo-fold-meta">{cards.length || ''}</span>
              </div>
              {stage === 'intake' && adding && <NewCard projects={data.projects} onDone={() => setAdding(false)} />}
              {cards.map((c) => (
                <BoardCard
                  key={c.id}
                  card={c}
                  today={today}
                  dragging={dragging === c.id}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/x-work-card', c.id);
                    e.dataTransfer.effectAllowed = 'move';
                    setDragging(c.id);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onDrop={(e) => drop(e, stage, c)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BoardCard({ card, today, dragging, onDragStart, onDragEnd, onDrop }: { card: WorkCard; today: string; dragging: boolean; onDragStart: (e: DragEvent) => void; onDragEnd: () => void; onDrop: (e: DragEvent) => void }) {
  const total = card.tasksOpen + card.tasksDone;
  const due = card.dueDate && card.stage !== 'done' ? dueLabel(card.dueDate, today) : null;
  return (
    <Link
      href={`/work/${card.id}`}
      className={cx('wb-card', dragging && 'is-dragging')}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e: DragEvent) => e.preventDefault()}
      onDrop={onDrop}
    >
      {card.projectName && <span className="wb-project clamp-1">{card.projectName}</span>}
      <span className="wb-title">{card.title}</span>
      {card.nextTask && card.stage !== 'done' && <span className="wb-next clamp-1">Next: {card.nextTask.title}</span>}
      <span className="wb-meta">
        {due && (
          <span className={cx(due.late && 'late')}>
            <CalendarDays size={12} aria-hidden /> {due.text}
          </span>
        )}
        {total > 0 && (
          <span className="wb-progress" title={`${card.tasksDone} of ${total} to-dos done`}>
            <i style={{ width: `${Math.round((card.tasksDone / total) * 100)}%` }} />
            <b>
              {card.tasksDone}/{total}
            </b>
          </span>
        )}
        {card.materials > 0 && (
          <span title={plural(card.materials, 'material')}>
            <Paperclip size={12} aria-hidden /> {card.materials}
          </span>
        )}
      </span>
    </Link>
  );
}

function NewCard({ projects, onDone }: { projects: Project[]; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [project, setProject] = useState(projects[0]?.id ?? '');
  const [due, setDue] = useState('');
  const create = useWrite(() => write.post('/work/cards', { title: title.trim(), project: project || null, dueDate: due || null }));
  return (
    <form
      className="wb-new"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) create.mutate(undefined, { onSuccess: onDone });
      }}
    >
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What's the work?" aria-label="Title" autoFocus onKeyDown={(e) => e.key === 'Escape' && onDone()} />
      <select className="select" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
        <option value="">No project</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!title.trim() || create.isPending}>
          Add
        </button>
      </div>
      {create.error && <p className="error-text">{create.error.message}</p>}
    </form>
  );
}

// ── The timeline ────────────────────────────────────────────────────────────

/**
 * To-dos down a vertical line, a node per day: late ones first in red, then each day, then
 * those with no date. Done to-dos (when given) follow, quieter.
 */
export function Timeline({ tasks, tag, empty, children }: { tasks: Task[]; tag?: (t: Task) => ReactNode; empty?: string; children?: ReactNode }) {
  const today = todayStr();
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const groups = new Map<string, Task[]>();
  for (const t of open) {
    const key = t.dueDate ?? 'none';
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === 'none' ? 1 : b === 'none' ? -1 : a.localeCompare(b)));
  const label = (key: string) => {
    if (key === 'none') return { day: 'No date', sub: '' };
    const d = dueLabel(key, today);
    const day = parseDay(key);
    // Under the date: how late, today or tomorrow, and otherwise the weekday.
    const sub = d.late || d.text === 'today' || d.text === 'tomorrow' ? d.text : day.toLocaleDateString(undefined, { weekday: 'short' });
    return { day: day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), sub, late: d.late };
  };
  return (
    <div className="wtl">
      {!open.length && !done.length && empty && <p className="empty">{empty}</p>}
      <ol>
        {keys.map((key) => {
          const l = label(key);
          return (
            <li key={key} className={cx('wtl-day', l.late && 'is-late', key === today && 'is-today')}>
              <div className="wtl-when">
                <b>{l.day}</b>
                {l.sub && <span>{l.sub}</span>}
              </div>
              <span className="wtl-node" aria-hidden />
              <ul>
                {groups.get(key)!.map((t) => (
                  <TaskRow key={t.id} task={t} showSphere={false} showDue={false} tag={tag?.(t)} />
                ))}
              </ul>
            </li>
          );
        })}
        {done.length > 0 && (
          <li className="wtl-day is-done">
            <div className="wtl-when">
              <b>Done</b>
              <span>{done.length}</span>
            </div>
            <span className="wtl-node" aria-hidden />
            <ul>
              {done.map((t) => (
                <TaskRow key={t.id} task={t} showSphere={false} showDue={false} tag={tag?.(t)} />
              ))}
            </ul>
          </li>
        )}
      </ol>
      {children}
    </div>
  );
}
