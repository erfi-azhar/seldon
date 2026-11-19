// One piece of work: its breakdown, its raw materials, and the timeline of what to do.

import { ArrowLeft, Check, ChevronRight, ExternalLink, FileText, Link2, Mic, NotebookPen, Paperclip, PenTool, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import type { FigmaThread, WorkBreakdown, WorkMaterial, WorkMaterialKind, WorkStage, WorkStakeholder } from '../../../shared/types.ts';
import { useFigmaCard, useIntegration, useSpheres, useWorkBoard, useWorkCard, useWrite, write } from '../api.ts';
import { STAGE_LABEL, Timeline } from '../components/Work.tsx';
import { InlineEdit, Loading, useFolds } from '../components/ui.tsx';
import { cx, hueStyle, plural, shortDay, timeAgo, todayStr } from '../lib.ts';

const STAGES: WorkStage[] = ['intake', 'discovery', 'design', 'review', 'handoff', 'done'];

const KIND: Record<WorkMaterialKind, { label: string; icon: ReactNode }> = {
  prd: { label: 'PRD', icon: <FileText size={15} /> },
  notes: { label: 'Meeting notes', icon: <NotebookPen size={15} /> },
  recording: { label: 'Recording', icon: <Mic size={15} /> },
  figma: { label: 'Figma', icon: <PenTool size={15} /> },
  link: { label: 'Link', icon: <Link2 size={15} /> },
  file: { label: 'File', icon: <Paperclip size={15} /> },
};

const SECTIONS: { key: keyof WorkBreakdown; label: string }[] = [
  { key: 'goals', label: 'Goals' },
  { key: 'requirements', label: 'Requirements' },
  { key: 'ux', label: 'UX' },
  { key: 'ui', label: 'UI' },
  { key: 'product', label: 'Product design' },
  { key: 'questions', label: 'Open questions' },
];

export function WorkCardPage({ id }: { id: string }) {
  const { data, error } = useWorkCard(id);
  const { data: board } = useWorkBoard();
  const { data: spheres } = useSpheres();
  const [, navigate] = useLocation();
  const patch = useWrite((body: Record<string, unknown>) => write.patch(`/work/cards/${id}`, body));
  const remove = useWrite(() => write.del(`/work/cards/${id}`));
  // Breakdown sections you fold stay folded, on every card (Goals folded here is folded there).
  const sections = useFolds('work-card-folded-sections', (k) => SECTIONS.some((s) => s.key === k));
  const work = spheres?.find((s) => s.key === 'work');
  const back = work ? `/spheres/${work.id}` : '/spheres';
  if (error) return <div className="page"><p className="empty">{error.message}</p></div>;
  if (!data) return <Loading />;
  const { card, materials, tasks } = data;

  return (
    <div className="page tint" style={work ? hueStyle(work.hue) : undefined}>
      <Link href={back} className="back">
        <ArrowLeft size={15} /> Work
      </Link>

      <header className="wc-head">
        <InlineEdit label="Title" className="wc-title" value={card.title} onSave={(title) => title.trim() && patch.mutate({ title })} />
        <div className="wc-meta">
          <select className="select" aria-label="Project" value={card.projectId ?? ''} onChange={(e) => patch.mutate({ project: e.target.value || null })}>
            <option value="">No project</option>
            {(board?.projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <label className="wc-due">
            <span className="hint">Due</span>
            <input className="input" type="date" value={card.dueDate ?? ''} onChange={(e) => patch.mutate({ dueDate: e.target.value || null })} />
          </label>
          <div className="seg wc-stages" role="group" aria-label="Stage">
            {STAGES.map((s) => (
              <button key={s} type="button" aria-pressed={card.stage === s} onClick={() => patch.mutate({ stage: s })}>
                {STAGE_LABEL[s]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              if (window.confirm(`Take “${card.title}” off the board? Its materials go with it; its to-dos stay in your Work to-dos.`)) remove.mutate(undefined, { onSuccess: () => navigate(back) });
            }}
          >
            <Trash2 size={13} /> Remove
          </button>
        </div>
        {patch.error && <p className="error-text">{patch.error.message}</p>}
      </header>

      <div className="detail-grid">
        <div className="col">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Breakdown</h2>
            </div>
            <div className="wc-summary">
              <InlineEdit label="Summary" multiline value={card.summary} placeholder="What this work is, in two or three sentences" onSave={(summary) => patch.mutate({ summary })} />
            </div>
            {SECTIONS.map((s) => (
              <ListSection
                key={s.key}
                label={s.label}
                items={card.breakdown[s.key]}
                open={sections.isOpen(s.key)}
                onToggle={(open) => sections.toggle(s.key, open)}
                onSave={(items) => patch.mutate({ breakdown: { [s.key]: items } })}
              />
            ))}
          </section>
          <Materials cardId={id} materials={materials} />
        </div>
        <div className="col">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Timeline</h2>
              {tasks.length > 0 && <span className="hint">{tasks.filter((t) => t.done).length} of {plural(tasks.length, 'to-do')} done</span>}
            </div>
            <Timeline tasks={tasks} empty="No to-dos yet. Ask Seldon to plan this work, or add the first step below.">
              <AddStep cardId={id} />
            </Timeline>
          </section>
          {materials.some((m) => /figma\.com\//i.test(m.url)) && <FigmaComments cardId={id} />}
          <Stakeholders people={card.stakeholders} onSave={(stakeholders) => patch.mutate({ stakeholders })} />
        </div>
      </div>
    </div>
  );
}

/** A breakdown list: bullets to read, one per line to edit. Folds away to its heading. */
function ListSection({ label, items, open, onToggle, onSave }: { label: string; items: string[]; open: boolean; onToggle: (open: boolean) => void; onSave: (items: string[]) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Editing always shows the list, folded or not.
  const shown = open || editing;
  return (
    <div className={cx('wc-list', !shown && 'is-folded')}>
      <div className="wc-list-head">
        <button type="button" className="wc-list-toggle" aria-expanded={shown} onClick={() => onToggle(!shown)}>
          <ChevronRight size={14} className="todo-fold-chev" aria-hidden />
          <h3>{label}</h3>
          {!shown && items.length > 0 && <span className="todo-fold-meta">{items.length}</span>}
        </button>
        {!editing && (
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => {
              setDraft(items.join('\n'));
              setEditing(true);
            }}
          >
            {items.length ? 'Edit' : 'Add'}
          </button>
        )}
      </div>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave(draft.split('\n').map((x) => x.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean));
            setEditing(false);
          }}
        >
          <textarea className="input" rows={Math.max(3, Math.min(12, draft.split('\n').length + 1))} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="One per line" autoFocus />
          <div className="row" style={{ gap: 6, justifyContent: 'flex-end', marginTop: 6 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm">
              Save
            </button>
          </div>
        </form>
      ) : shown && items.length ? (
        <ul>
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Materials({ cardId, materials }: { cardId: string; materials: WorkMaterial[] }) {
  const [adding, setAdding] = useState(false);
  const remove = useWrite((mid: string) => write.del(`/work/materials/${mid}`));
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Materials</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
          <Plus size={14} /> Add
        </button>
      </div>
      {materials.length === 0 && !adding && <p className="empty">The PRD, meeting notes, recordings, Figma files and links for this work.</p>}
      <ul className="wc-materials">
        {materials.map((m) => (
          <li key={m.id}>
            <span className="wc-kind" title={KIND[m.kind].label}>
              {KIND[m.kind].icon}
            </span>
            <div className="grow">
              <div className="wc-mat-title">
                {m.url ? (
                  <a href={m.url} target="_blank" rel="noreferrer noopener">
                    {m.title} <ExternalLink size={11} aria-hidden />
                  </a>
                ) : (
                  <span>{m.title}</span>
                )}
              </div>
              <span className="faint">
                {KIND[m.kind].label} · {shortDay(todayStr(new Date(m.createdAt)))}
              </span>
              {m.body && (
                <details className="wc-body">
                  <summary>{m.body.length > 600 ? `Show text (${Math.round(m.body.length / 1000)}k characters)` : 'Show text'}</summary>
                  <div className="wc-text">{m.body}</div>
                </details>
              )}
            </div>
            <button type="button" className="icon-btn icon-btn-sm" aria-label={`Remove ${m.title}`} title="Remove" onClick={() => window.confirm(`Remove ${m.title}?`) && remove.mutate(m.id)}>
              <Trash2 size={13} />
            </button>
          </li>
        ))}
      </ul>
      {adding && <AddMaterial cardId={cardId} onDone={() => setAdding(false)} />}
    </section>
  );
}

function AddMaterial({ cardId, onDone }: { cardId: string; onDone: () => void }) {
  const [kind, setKind] = useState<WorkMaterialKind>('link');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [body, setBody] = useState('');
  const add = useWrite(() => write.post(`/work/cards/${cardId}/materials`, { kind, title, url, body }));
  return (
    <form
      className="wc-add"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(undefined, { onSuccess: onDone });
      }}
    >
      <div className="field-row">
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as WorkMaterialKind)} aria-label="Kind">
          {(Object.keys(KIND) as WorkMaterialKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND[k].label}
            </option>
          ))}
        </select>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" />
      </div>
      <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link (Figma, doc, recording…)" aria-label="Link" />
      <textarea className="input" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Or paste the text: the PRD, notes, a transcript" aria-label="Text" />
      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!(url.trim() || body.trim()) || add.isPending}>
          Add
        </button>
      </div>
      {add.error && <p className="error-text">{add.error.message}</p>}
    </form>
  );
}

function AddStep({ cardId }: { cardId: string }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const add = useWrite(() => write.post(`/work/cards/${cardId}/tasks`, { title: title.trim(), dueDate: due || null }));
  return (
    <form
      className={cx('add-row', 'wtl-add')}
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) add.mutate(undefined, { onSuccess: () => setTitle('') });
      }}
    >
      <Plus size={16} className="faint" aria-hidden />
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a step…" aria-label="New step" maxLength={200} />
      <input className="input wtl-add-date" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
      <button type="submit" className="btn btn-primary btn-sm" disabled={!title.trim() || add.isPending}>
        Add
      </button>
    </form>
  );
}

/**
 * The comment threads on this card's Figma files: those waiting on you (someone else had the
 * last word) up front, those waiting on others folded away.
 */
function FigmaComments({ cardId }: { cardId: string }) {
  const { data } = useFigmaCard(cardId);
  const { data: status } = useIntegration('figma');
  const run = useWrite(() => write.post('/integrations/figma/run'));
  const todo = useWrite((threadId: string) => write.post(`/figma/threads/${threadId}/todo`, { cardId }));
  if (!data) return null;
  const needs = data.threads.filter((t) => t.status === 'needs-you');
  const waiting = data.threads.filter((t) => t.status === 'waiting');
  const read = data.files.map((f) => f.syncedAt).filter((d): d is string => !!d).sort()[0];
  const many = data.files.length > 1;
  const thread = (t: FigmaThread) => <FigmaThreadRow key={t.id} t={t} file={many ? t.fileName : null} pending={todo.isPending && todo.variables === t.id} onToDo={() => todo.mutate(t.id)} />;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Figma comments</h2>
        {data.connected && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => run.mutate()} disabled={status?.running || run.isPending}>
            <RefreshCw size={13} /> {status?.running || run.isPending ? 'Checking…' : 'Check now'}
          </button>
        )}
      </div>
      {!data.connected ? (
        <p className="empty">
          Connect Figma in <Link href="/settings#connections">Settings → Connections</Link> and the comments on this card's Figma file show here: what reviewers asked to change, and what's waiting on them.
        </p>
      ) : (
        <>
          {data.files
            .filter((f) => f.error)
            .map((f) => (
              <p key={f.key} className="error-text fc-note">
                {many ? `${f.name}: ` : ''}
                {f.error}
              </p>
            ))}
          {run.error && <p className="error-text fc-note">{run.error.message}</p>}
          {needs.length === 0 && <p className="empty">{read ? 'Nothing in Figma is waiting on you.' : 'Not read yet. Terminus reads Figma every quarter hour, or check now.'}</p>}
          {needs.length > 0 && <ul className="fc-threads">{needs.map(thread)}</ul>}
          {waiting.length > 0 && (
            <details className="todo-fold">
              <summary>
                <ChevronRight size={14} className="todo-fold-chev" aria-hidden />
                <span className="grow">Waiting on others</span>
                <span className="todo-fold-meta">{waiting.length}</span>
              </summary>
              <ul className="fc-threads">{waiting.map(thread)}</ul>
            </details>
          )}
          {todo.error && <p className="error-text fc-note">{todo.error.message}</p>}
          {(read || data.resolved > 0) && <p className="fc-foot faint">{[read ? `Read ${timeAgo(read)}` : '', data.resolved ? `${data.resolved} resolved` : ''].filter(Boolean).join(' · ')}</p>}
        </>
      )}
    </section>
  );
}

function FigmaThreadRow({ t, file, pending, onToDo }: { t: FigmaThread; file: string | null; pending: boolean; onToDo: () => void }) {
  const shown = t.replies.slice(-2);
  const earlier = t.replies.length - shown.length;
  return (
    <li>
      <span className="wc-avatar" aria-hidden>
        {initials(t.author)}
      </span>
      <div className="grow">
        <div className="fc-by">
          <b>{t.mine ? 'You' : t.author}</b>
          <span className="faint">{timeAgo(t.createdAt)}</span>
          {file && <span className="task-tag">{file}</span>}
        </div>
        <p className="fc-msg">{t.message}</p>
        {t.replies.length > 0 && (
          <ul className="fc-replies">
            {earlier > 0 && <li className="faint">{plural(earlier, 'earlier reply', 'earlier replies')}</li>}
            {shown.map((r) => (
              <li key={r.id}>
                <b>{r.mine ? 'You' : r.author}</b> {r.message}
              </li>
            ))}
          </ul>
        )}
        <div className="fc-actions">
          <a className="chip chip-outline" href={t.link} target="_blank" rel="noreferrer noopener">
            <ExternalLink size={12} aria-hidden /> Open in Figma
          </a>
          {t.taskId ? (
            <span className="chip chip-tint">
              <Check size={12} aria-hidden /> {t.taskDone ? 'To-do done' : 'On the timeline'}
            </span>
          ) : (
            <button type="button" className="chip chip-act" onClick={onToDo} disabled={pending}>
              <Plus size={12} aria-hidden /> Add to-do
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** Roles offered while typing; any other role can be written in. */
const ROLES = ['PM', 'RD', 'FE', 'BE', 'QA', 'Designer', 'UX writer', 'Localization', 'DA', 'DS', 'DE', 'Legal', 'Compliance Ops', 'Compliance Strategy', 'FCC Advisory', 'BPO'];

/** "Ann Tan" → AT; "Mei (UX writing)" → M: what's in brackets is a note, not a name. */
const initials = (name: string) =>
  name
    .replace(/\(.*?\)/g, ' ')
    .split(/\s+/)
    .map((w) => w.match(/[\p{L}\p{N}]/u)?.[0])
    .filter((c): c is string => !!c)
    .slice(0, 2)
    .join('')
    .toUpperCase();

/** Who the work involves: read as a list, edited as rows. */
function Stakeholders({ people, onSave }: { people: WorkStakeholder[]; onSave: (people: WorkStakeholder[]) => void }) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<WorkStakeholder[]>([]);
  const blank: WorkStakeholder = { name: '', role: '', team: '', note: '' };
  const set = (i: number, patch: Partial<WorkStakeholder>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Stakeholders</h2>
        {!editing && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setRows(people.length ? people : [blank]);
              setEditing(true);
            }}
          >
            {people.length ? (
              'Edit'
            ) : (
              <>
                <Plus size={14} /> Add
              </>
            )}
          </button>
        )}
      </div>
      {!editing && people.length === 0 && <p className="empty">PM, RD, QA, Ops, the UX writer: who this work involves, and what you need from them.</p>}
      {!editing && people.length > 0 && (
        <ul className="wc-people">
          {people.map((p, i) => (
            <li key={i}>
              <span className="wc-avatar" aria-hidden>
                {initials(p.name)}
              </span>
              <div className="grow">
                <div className="wc-person">
                  <b>{p.name}</b>
                  {p.role && <span className="task-tag">{p.role}</span>}
                </div>
                {(p.team || p.note) && <span className="faint">{[p.team, p.note].filter(Boolean).join(' · ')}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <form
          className="wc-people-edit"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(rows.map((r) => ({ name: r.name.trim(), role: r.role.trim(), team: r.team.trim(), note: r.note.trim() })).filter((r) => r.name));
            setEditing(false);
          }}
        >
          <datalist id="wc-roles">
            {ROLES.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
          {rows.map((r, i) => (
            <div key={i} className="wc-person-row">
              <input className="input" value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Name" aria-label="Name" autoFocus={i === rows.length - 1 && !r.name} />
              <input className="input" value={r.role} onChange={(e) => set(i, { role: e.target.value })} placeholder="Role" aria-label="Role" list="wc-roles" />
              <input className="input" value={r.team} onChange={(e) => set(i, { team: e.target.value })} placeholder="Team" aria-label="Team" />
              <input className="input" value={r.note} onChange={(e) => set(i, { note: e.target.value })} placeholder="Note (what they own, what you need)" aria-label="Note" />
              <button type="button" className="icon-btn icon-btn-sm" aria-label={`Remove ${r.name || 'this person'}`} title="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <div className="row" style={{ gap: 6, justifyContent: 'space-between' }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows([...rows, blank])}>
              <Plus size={14} /> Person
            </button>
            <span className="row" style={{ gap: 6 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary btn-sm">
                Save
              </button>
            </span>
          </div>
        </form>
      )}
    </section>
  );
}
