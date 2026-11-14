// What Seldon suggests doing next for a task: who to see, what to bring, and a button that
// hands the next step to Seldon or adds it as a task of its own.

import { Check, Plus, RotateCw } from 'lucide-react';
import { Link } from 'wouter';
import type { FollowupStep, Task } from '../../../shared/types.ts';
import { useTaskFollowups, useWrite, write } from '../api.ts';
import { shortDay } from '../lib.ts';
import { useApp } from '../state.tsx';
import { AgentOrb } from './Orb.tsx';

type Draft = Pick<Task, 'title' | 'notes' | 'dueDate'>;

/** What Seldon is sent: the step's request, with the task it is about stated plainly. */
export function askPrompt(task: Draft, prompt: string): string {
  const about = [`About my task “${task.title}”`, task.dueDate ? ` (due ${shortDay(task.dueDate)})` : ''].join('');
  const notes = task.notes.trim() ? `\nMy notes on it: ${task.notes.trim().slice(0, 800)}` : '';
  return `${prompt}\n\n${about}.${notes}`;
}

function Step({ step, index, task, draft, onAsk }: { step: FollowupStep; index: number; task: Task; draft: Draft; onAsk: (prompt: string) => void }) {
  const { toast } = useApp();
  const add = useWrite(() => write.post<{ task: Task }>(`/tasks/${task.id}/followups/${index}/task`));
  return (
    <li className="followup-step">
      <span className="followup-num" aria-hidden>
        {index + 1}
      </span>
      <div className="grow">
        <b>{step.title}</b>
        {step.detail && <p className="followup-detail">{step.detail}</p>}
        {(step.ask || step.task) && (
          <div className="row-wrap" style={{ gap: 6, marginTop: 8 }}>
            {step.ask && (
              <button type="button" className="chip chip-ask" title={step.ask.prompt} onClick={() => onAsk(askPrompt(draft, step.ask!.prompt))}>
                <AgentOrb size={12} /> {step.ask.label}
              </button>
            )}
            {step.task &&
              (step.added ? (
                <span className="chip">
                  <Check size={12} /> Added: {step.task.title}
                </span>
              ) : (
                <button
                  type="button"
                  className="chip chip-act"
                  disabled={add.isPending}
                  title={`Add “${step.task.title}” as a task`}
                  onClick={() => add.mutate(undefined, { onSuccess: (r) => toast({ message: `Added task: ${r.task.title}` }), onError: (e) => toast({ message: e.message }) })}
                >
                  <Plus size={12} /> <span>{step.task.title}</span>
                  {step.task.dueDate && <span className="faint" style={{ whiteSpace: 'nowrap' }}>· {shortDay(step.task.dueDate)}</span>}
                </button>
              ))}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Seldon's suggestions for an open task. draft is the task as edited in the sheet, so what Seldon
 * is told matches what is on screen; onAsk should save, close the sheet and hand the prompt over.
 */
export function TaskFollowupsPanel({ task, draft = task, onAsk }: { task: Task; draft?: Draft; onAsk: (prompt: string) => void }) {
  const { agentName, closeSheet } = useApp();
  const { data } = useTaskFollowups(task.id, !task.done);
  const refresh = useWrite(() => write.post(`/tasks/${task.id}/followups/refresh`, {}));
  if (task.done || !data || data.status === 'none') return null;

  if (data.status === 'unavailable') {
    return (
      <p className="hint">
        Connect a background brain in{' '}
        <Link href="/settings#brains" onClick={closeSheet}>
          Settings
        </Link>{' '}
        and {agentName} will suggest next steps for tasks like this.
      </p>
    );
  }

  return (
    <section className="followups" aria-live="polite">
      <div className="followups-head">
        <span className="label row" style={{ gap: 6 }}>
          <AgentOrb size={14} thinking={data.status === 'pending'} /> {data.status === 'pending' ? `${agentName} is thinking this through…` : `${agentName} suggests`}
        </span>
        {data.status !== 'pending' && (
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Think again" title="Think again" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            <RotateCw size={13} />
          </button>
        )}
      </div>
      {data.status === 'failed' && <p className="hint">{agentName} couldn't think this one through just now. Try again in a moment.</p>}
      {data.status === 'ready' && (
        <>
          {data.summary && <p className="followups-summary">{data.summary}</p>}
          {data.steps.length > 0 && (
            <ol className="followup-steps">
              {data.steps.map((s, i) => (
                <Step key={i} step={s} index={i} task={task} draft={draft} onAsk={onAsk} />
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
