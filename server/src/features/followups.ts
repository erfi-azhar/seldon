// Follow-ups: for each task, Seldon thinks one step ahead. "Book a surgeon consultation
// about my gallbladder" gets who to see, what to bring and a button that hands the booking
// to Seldon; "buy milk" gets nothing. The background brain reads the task with no tools, so
// a task that came from an email can shape the suggestions but cannot make Terminus act.
// Suggestions only become actions when the person taps one.
//
// A task is read when it is opened (if it has not been yet) and by a sweep over recently
// added tasks, so the ones Seldon or a signal created get suggestions too. Editing the
// title, notes or due date makes the suggestions stale, and they are thought through again.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NoBrain, think, wrapUntrusted } from '../agent/think.ts';
import { toolbox, toolSpecs } from '../agent/tools.ts';
import { Invalid, NotFound, nowIso, type Store } from '../store.ts';
import type { FollowupStep, Task, TaskFollowups } from '../../../shared/types.ts';
import { registerFeature } from './registry.ts';

const ID = 'followups';
const MAX_STEPS = 4;
/** The sweep looks at open tasks added within this many days… */
const SWEEP_DAYS = 14;
/** …and thinks about at most this many per run, so a backlog never floods the brain. */
const SWEEP_PER_RUN = 4;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Tasks being thought about right now, so one task is never read twice at once. */
const thinking = new Map<string, Promise<void>>();

/** What the suggestions were made from: when this changes, they are stale. */
export function fingerprint(t: Pick<Task, 'title' | 'notes' | 'dueDate'>): string {
  return createHash('sha256').update(`${t.title}\n${t.notes}\n${t.dueDate ?? ''}`).digest('hex').slice(0, 20);
}

const clip = (n: number) => z.string().transform((s) => s.trim().slice(0, n));

const Answer = z.object({
  relevant: z.boolean(),
  summary: clip(600).default(''),
  steps: z
    .array(
      z.object({
        title: clip(160).pipe(z.string().min(1)),
        detail: clip(500).default(''),
        ask: z.object({ label: clip(40).pipe(z.string().min(1)), prompt: clip(800).pipe(z.string().min(1)) }).nullable().optional(),
        task: z
          .object({
            title: clip(200).pipe(z.string().min(1)),
            due_date: z
              .string()
              .nullable()
              .optional()
              .transform((d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null)),
          })
          .nullable()
          .optional(),
      }),
    )
    .default([]),
});
export type FollowupAnswer = z.infer<typeof Answer>;

const TASK = `Someone added this task to their to-do list in Terminus, their personal life system. Think like a capable, well-connected friend: what would actually help them get it done? Decide whether it deserves follow-up suggestions.

Suggest follow-ups only when they add real value: the right kind of person or place to go to (which specialist, which office or service), what to prepare or bring, a sensible order of steps, or something Seldon, their assistant, can take off their hands. A task that is already simple and self-explanatory ("buy milk", "call mum", "pay the electricity bill") gets "relevant": false and no steps.

Rules:
- Be specific and practical, for where they live when you can tell (the timezone is a clue). Name the kind of professional, service or office, not a particular business you cannot be sure of.
- Health, money and legal matters: say what is generally done and when to see a professional; never diagnose. If the task's notes mention warning signs, keep that advice.
- At most ${MAX_STEPS} steps, most useful first. Each step has a short title and a one- or two-sentence detail, and can carry:
  - "ask": something to hand to Seldon. "prompt" is written in the first person, the way they would type it to Seldon, and stands on its own ("Help me book a consultation with a hepatobiliary surgeon: suggest a few times next week and draft the message to the clinic"). "label" is the button text, 2 to 5 words, starting with a verb ("Ask Seldon to book it"). Only ask for what Seldon can do with the abilities listed below.
  - "task": a concrete follow-up worth tracking on its own, with "due_date" (YYYY-MM-DD) when timing matters. Never repeat the task itself.
- When the task is about booking, scheduling or arranging something, one step must carry an "ask" for Seldon to help schedule it.
- Plain words, no markdown. "summary" is one or two sentences: the most useful thing to know. Empty when not relevant.

Reply with only this JSON:
{"relevant": boolean, "summary": string, "steps": [{"title": string, "detail": string, "ask": {"label": string, "prompt": string} | null, "task": {"title": string, "due_date": string | null} | null}]}`;

/** What Seldon can do in a chat, in a line, so its suggestions ask only for what it can deliver. */
async function abilities(store: Store): Promise<string> {
  const builtIn = new Set(toolSpecs().map((t) => t.name));
  let connected: string[] = [];
  try {
    connected = (await toolbox(store)).specs.map((t) => t.name).filter((n) => !builtIn.has(n));
  } catch {
    // A connected app being unreachable just means fewer abilities.
  }
  return [
    'Seldon can add and update tasks (with due dates), goals, habits, metrics, notes and journal entries; remember facts; search their Terminus; read their inbox of signals (important email, job openings, trips) and their travel plans; and write drafts and plans in the chat for them to send. It cannot browse the web, phone anyone or send email by itself.',
    connected.length ? `Tools from apps they connected: ${connected.slice(0, 40).join(', ')}.` : 'No other apps are connected.',
  ].join('\n');
}

async function context(store: Store, task: Task): Promise<string> {
  const zone = store.zone();
  const lines = [`Today: ${new Date().toISOString().slice(0, 10)}${zone ? ` (their timezone: ${zone})` : ''}`];
  if (task.sphereId) {
    try {
      lines.push(`Area of life: ${store.getSphere(task.sphereId).name}`);
    } catch {
      // The sphere went away; carry on without it.
    }
  }
  if (task.goalId) {
    try {
      lines.push(`Towards the goal: ${store.getGoal(task.goalId).title}`);
    } catch {
      // As above.
    }
  }
  if (task.dueDate) lines.push(`Due: ${task.dueDate}`);
  const memories = store
    .listMemories()
    .map((m) => `- ${m.content}`)
    .join('\n')
    .slice(0, 1500);
  if (memories) lines.push(`What Seldon knows about them:\n${memories}`);
  lines.push(await abilities(store));
  // Most tasks are typed by the person, but some come from email and other outside text.
  lines.push(wrapUntrusted('task', `title: ${task.title}${task.notes ? `\nnotes: ${task.notes}` : ''}`, 3000));
  return lines.join('\n\n');
}

function save(store: Store, taskId: string, fp: string, fields: { status: 'ready' | 'none' | 'failed'; summary?: string; steps?: FollowupStep[]; error?: string | null }): void {
  store.db
    .prepare(
      `INSERT INTO task_followups (task_id, fingerprint, status, summary, steps, error, created_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(task_id) DO UPDATE SET fingerprint = excluded.fingerprint, status = excluded.status, summary = excluded.summary,
         steps = excluded.steps, error = excluded.error, created_at = excluded.created_at`,
    )
    .run(taskId, fp, fields.status, fields.summary ?? '', JSON.stringify(fields.steps ?? []), fields.error ?? null, nowIso());
}

function rowFor(store: Store, taskId: string): Row | undefined {
  return store.db.prepare('SELECT * FROM task_followups WHERE task_id = ?').get(taskId) as Row | undefined;
}

function taskOrNull(store: Store, id: string): Task | null {
  try {
    return store.getTask(id);
  } catch (err) {
    if (err instanceof NotFound) return null;
    throw err;
  }
}

/** Turn the model's answer into steps we keep. */
export function toSteps(a: FollowupAnswer): FollowupStep[] {
  if (!a.relevant) return [];
  return a.steps.slice(0, MAX_STEPS).map((s) => ({
    title: s.title,
    detail: s.detail,
    ask: s.ask ?? null,
    task: s.task ? { title: s.task.title, dueDate: s.task.due_date ?? null } : null,
    added: false,
  }));
}

/** Think about one task, unless it is done, gone, or already has suggestions for what it says now. */
export function evaluate(store: Store, taskId: string, signal?: AbortSignal): Promise<void> {
  const running = thinking.get(taskId);
  if (running) return running;
  const job = (async () => {
    const task = taskOrNull(store, taskId);
    if (!task || task.done) return;
    const fp = fingerprint(task);
    if (rowFor(store, taskId)?.fingerprint === fp) return;
    if (!store.getModelConfig('background')) return;
    let answer: FollowupAnswer;
    try {
      answer = await think({ store, task: TASK, input: await context(store, task), schema: Answer, signal });
    } catch (err) {
      if (err instanceof NoBrain || signal?.aborted) return;
      if (taskOrNull(store, taskId)) save(store, taskId, fp, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
      return;
    }
    // Edited or deleted while Seldon was thinking: these suggestions are for something else now.
    const now = taskOrNull(store, taskId);
    if (!now || fingerprint(now) !== fp) return;
    const steps = toSteps(answer);
    save(store, taskId, fp, steps.length || (answer.relevant && answer.summary) ? { status: 'ready', summary: answer.summary, steps } : { status: 'none' });
  })().finally(() => thinking.delete(taskId));
  thinking.set(taskId, job);
  return job;
}

/** Resolves once every task being thought about has been (for tests). */
export async function followupsSettled(): Promise<void> {
  while (thinking.size) await Promise.allSettled([...thinking.values()]);
}

/** What Seldon suggests for a task, starting it thinking when it has not yet. */
export function getFollowups(store: Store, taskId: string): TaskFollowups {
  const task = store.getTask(taskId);
  const row = rowFor(store, taskId);
  if (row && row.fingerprint === fingerprint(task)) {
    return { status: row.status, summary: row.summary, steps: JSON.parse(row.steps) as FollowupStep[], error: row.error };
  }
  const empty = { summary: '', steps: [], error: null };
  if (task.done) return { status: 'none', ...empty };
  if (!thinking.has(taskId)) {
    if (!store.getModelConfig('background')) return { status: 'unavailable', ...empty };
    void evaluate(store, taskId);
  }
  return { status: 'pending', ...empty };
}

/** Recently added open tasks that have no suggestions for what they say now. */
export async function sweep(store: Store, signal?: AbortSignal): Promise<void> {
  if (!store.getModelConfig('background')) return;
  const since = new Date(Date.now() - SWEEP_DAYS * 86_400_000).toISOString();
  const rows = store.db
    .prepare(
      `SELECT t.id, t.title, t.notes, t.due_date, f.fingerprint FROM tasks t LEFT JOIN task_followups f ON f.task_id = t.id
       WHERE t.done = 0 AND t.created_at >= ? ORDER BY t.created_at DESC LIMIT 50`,
    )
    .all(since) as Row[];
  let n = 0;
  for (const r of rows) {
    if (n >= SWEEP_PER_RUN || signal?.aborted) break;
    if (r.fingerprint === fingerprint({ title: r.title, notes: r.notes, dueDate: r.due_date }) || thinking.has(r.id)) continue;
    n++;
    await evaluate(store, r.id, signal);
  }
}

/** Add a suggested follow-up as a task of its own, alongside the one it came from. */
export function addStepTask(store: Store, taskId: string, index: number): { task: Task; followups: TaskFollowups } {
  const parent = store.getTask(taskId);
  const current = getFollowups(store, taskId);
  const step = current.steps[index];
  if (current.status !== 'ready' || !step?.task) throw new NotFound('Suggestion');
  if (step.added) throw new Invalid('That one has already been added.');
  const task = store.tx(() => {
    const t = store.createTask({
      title: step.task!.title,
      dueDate: step.task!.dueDate,
      sphereId: parent.sphereId,
      goalId: parent.goalId,
      tripId: parent.tripId,
      notes: `Follow-up to: ${parent.title}`,
    });
    const steps = current.steps.map((s, i) => (i === index ? { ...s, added: true } : s));
    store.db.prepare('UPDATE task_followups SET steps = ? WHERE task_id = ?').run(JSON.stringify(steps), taskId);
    return t;
  });
  return { task, followups: getFollowups(store, taskId) };
}

registerFeature({
  id: ID,
  jobs: [{ id: ID, everyMs: 60_000, run: sweep }],
  routes: (app, { store }) => {
    // Jobs run only while their integration is on; this one has nothing to set up, so it starts on.
    store.db.prepare('INSERT OR IGNORE INTO integrations (id, enabled) VALUES (?, 1)').run(ID);

    app.get('/api/tasks/:id/followups', (c) => c.json(getFollowups(store, c.req.param('id'))));
    app.post('/api/tasks/:id/followups/refresh', (c) => {
      const id = c.req.param('id');
      store.getTask(id);
      if (!thinking.has(id)) store.db.prepare('DELETE FROM task_followups WHERE task_id = ?').run(id);
      return c.json(getFollowups(store, id));
    });
    app.post('/api/tasks/:id/followups/:index/task', (c) => {
      const index = Number(c.req.param('index'));
      if (!Number.isInteger(index) || index < 0) throw new NotFound('Suggestion');
      return c.json(addStepTask(store, c.req.param('id'), index), 201);
    });
  },
});
