// What the agent can do. Every tool is a thin, validated wrapper over the same Store the
// app uses, so the agent can never do something the person couldn't do by hand — and it
// has no delete tools at all: it can add, log, update and complete, all of it undoable.

import { z } from 'zod';
import { addDays, formatValue, prettyDay, type Store } from '../store.ts';
import { renderSnapshot } from './prompt.ts';
import { wrapUntrusted } from './think.ts';
import type { ToolSpec } from './types.ts';
import type { Goal, Habit, Metric, Task } from '../../../shared/types.ts';

export interface ToolContext {
  /** A Store handle that attributes writes to the agent. */
  store: Store;
  today: string;
  signal?: AbortSignal;
}

export interface ToolOutput {
  /** Returned to the model (serialised to JSON unless already a string). */
  data: unknown;
  /** One line for the person watching. */
  summary: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodType;
  run: (input: never, ctx: ToolContext) => ToolOutput | Promise<ToolOutput>;
}

export function tool<S extends z.ZodType>(
  name: string,
  description: string,
  input: S,
  run: (input: z.infer<S>, ctx: ToolContext) => ToolOutput | Promise<ToolOutput>,
): ToolDef {
  return { name, description, input, run: run as ToolDef['run'] };
}

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s, 'Not a real calendar date')
  .describe('A calendar date, YYYY-MM-DD');
const id = (what: string) => z.string().min(1).describe(`The id of the ${what}, copied from the snapshot or a read tool`);

// ── Compact views: what the model needs, nothing more ───────────────────────

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function goalView(g: Goal, sphereName: string) {
  return {
    id: g.id,
    title: g.title,
    sphere: sphereName,
    status: g.status,
    progress: pct(g.progress),
    progress_from: g.progressSource,
    target_date: g.targetDate,
    why: g.why || undefined,
    milestones: g.milestones.map((m) => ({ id: m.id, title: m.title, done: m.done })),
  };
}

const taskView = (t: Task) => ({ id: t.id, title: t.title, due: t.dueDate, done: t.done, notes: t.notes || undefined, trip_id: t.tripId || undefined });

const habitView = (h: Habit) => ({
  id: h.id,
  name: h.name,
  cadence: h.cadence === 'daily' ? 'daily' : `${h.targetPerWeek}× a week`,
  this_week: `${h.weekCount}/${h.targetPerWeek}`,
  done_today: h.doneToday,
  streak: h.streak,
});

const metricView = (m: Metric) => ({
  id: m.id,
  name: m.name,
  unit: m.unit || undefined,
  latest: m.latest,
  latest_date: m.entries.at(-1)?.date ?? null,
});

// ── The tools ───────────────────────────────────────────────────────────────

const TOOLS: ToolDef[] = [
  tool(
    'get_overview',
    'Read the current state of everything: spheres, active goals, open tasks, habits, latest metric values, today\'s journal and your memories, with ids. Call this before acting whenever the snapshot from the start of the conversation could be stale — for example after several messages, or when the user says they changed something in the app.',
    z.object({}),
    (_input, { store, today }) => ({ data: renderSnapshot(store, today), summary: 'Looked over everything' }),
  ),

  tool(
    'get_sphere',
    'Read one sphere in full: its vision, every goal (including paused and finished ones), habits, metrics, open tasks, saved notes and recent activity. Call this when the user asks about a specific area in depth or before reviewing it.',
    z.object({ sphere_id: id('sphere') }),
    ({ sphere_id }, { store, today }) => {
      const d = store.sphereDetail(sphere_id, today);
      return {
        data: {
          id: d.sphere.id,
          name: d.sphere.name,
          vision: d.sphere.vision,
          quiet_days: d.sphere.stats.quietDays,
          goals: d.goals.map((g) => goalView(g, d.sphere.name)),
          habits: d.habits.map(habitView),
          metrics: d.metrics.map(metricView),
          open_tasks: d.tasks.map(taskView),
          // Saved links and pictures hold page text (or a model's summary of it): outside content.
          notes: d.notes.map((n) =>
            n.capture
              ? { id: n.id, saved_item: wrapUntrusted('saved item', `${n.title || n.body.slice(0, 60)}${n.url ? `\nlink: ${n.url}` : ''}`, 400) }
              : { id: n.id, title: n.title || n.body.slice(0, 60), url: n.url || undefined },
          ),
          recent_activity: d.activity.map((a) => `${a.ts.slice(0, 10)} ${a.summary}`),
        },
        summary: `Read the ${d.sphere.name} sphere`,
      };
    },
  ),

  tool(
    'set_sphere_vision',
    'Replace the vision statement of a sphere — the sentence or two describing what thriving in this area looks like. Only call this when the user has agreed on the wording.',
    z.object({ sphere_id: id('sphere'), vision: z.string().min(1).max(600) }),
    ({ sphere_id, vision }, { store }) => {
      const s = store.updateSphere(sphere_id, { vision });
      return { data: { ok: true }, summary: `Set the vision for ${s.name}` };
    },
  ),

  tool(
    'create_goal',
    'Create a goal inside a sphere. Use this when the user commits to an outcome (not a one-off to-do — that is a task, and not a recurring practice — that is a habit). Break it into milestones when the path is clear. To have progress follow a number instead, pass metric_id and target_value.',
    z.object({
      sphere_id: id('sphere'),
      title: z.string().min(1).max(200).describe('The outcome, stated so it is obvious when it has been reached'),
      why: z.string().max(600).optional().describe('Why this matters to the user, in their words'),
      horizon: z.enum(['quarter', 'year', 'someday']).optional(),
      target_date: date.optional(),
      milestones: z.array(z.string().min(1).max(200)).max(12).optional().describe('Ordered steps toward the goal'),
      metric_id: z.string().optional().describe('A metric whose value drives progress'),
      target_value: z.number().optional().describe('The metric value that means the goal is reached'),
    }),
    (i, { store }) => {
      const g = store.createGoal({
        sphereId: i.sphere_id,
        title: i.title,
        why: i.why,
        horizon: i.horizon,
        targetDate: i.target_date,
        milestones: i.milestones,
        metricId: i.metric_id,
        targetValue: i.target_value,
      });
      return { data: goalView(g, store.getSphere(g.sphereId).name), summary: `New goal: ${g.title}` };
    },
  ),

  tool(
    'update_goal',
    'Change a goal: retitle it, move its date, set manual progress (0–100, only for goals without milestones or a metric), or change status. Ask before changing status unless the user just told you to — "done" celebrates it, "paused" parks it, "dropped" lets it go.',
    z.object({
      goal_id: id('goal'),
      title: z.string().min(1).max(200).optional(),
      why: z.string().max(600).optional(),
      status: z.enum(['active', 'paused', 'done', 'dropped']).optional(),
      horizon: z.enum(['quarter', 'year', 'someday']).optional(),
      target_date: date.nullable().optional(),
      progress_percent: z.number().min(0).max(100).optional(),
    }),
    (i, { store }) => {
      const g = store.updateGoal(i.goal_id, {
        title: i.title,
        why: i.why,
        status: i.status,
        horizon: i.horizon,
        targetDate: i.target_date,
        manualProgress: i.progress_percent,
      });
      return { data: goalView(g, store.getSphere(g.sphereId).name), summary: `Updated goal: ${g.title}` };
    },
  ),

  tool(
    'add_milestone',
    'Add a step to an existing goal.',
    z.object({ goal_id: id('goal'), title: z.string().min(1).max(200) }),
    ({ goal_id, title }, { store }) => {
      const m = store.addMilestone(goal_id, title);
      return { data: { id: m.id, title: m.title, done: false }, summary: `Added a step: ${m.title}` };
    },
  ),

  tool(
    'set_milestone_done',
    'Tick (or untick) a milestone when the user says they finished that step.',
    z.object({ milestone_id: id('milestone'), done: z.boolean().optional().describe('Defaults to true') }),
    ({ milestone_id, done }, { store }) => {
      const m = store.updateMilestone(milestone_id, { done: done ?? true });
      return { data: { id: m.id, title: m.title, done: m.done }, summary: `${m.done ? 'Finished' : 'Reopened'}: ${m.title}` };
    },
  ),

  tool(
    'list_tasks',
    'List tasks. Use status "done" to see what was recently completed, or pass a sphere to narrow down.',
    z.object({ status: z.enum(['open', 'done']).optional(), sphere_id: z.string().optional() }),
    ({ status, sphere_id }, { store }) => {
      const tasks = store.listTasks({ status: status ?? 'open', sphereId: sphere_id, limit: 60 });
      return { data: tasks.map(taskView), summary: `Checked ${status === 'done' ? 'finished' : 'open'} tasks` };
    },
  ),

  tool(
    'create_task',
    'Capture a one-off to-do. Call this as soon as the user mentions something they need to do, even in passing — they can undo it. Attach the sphere it belongs to when that is clear, and a due date only when they gave or implied one.',
    z.object({
      title: z.string().min(1).max(200).describe('Short, starts with a verb'),
      sphere_id: z.string().optional(),
      goal_id: z.string().optional().describe('The goal this task advances, if any'),
      trip_id: z.string().optional().describe('The trip this to-do is for (book the hotel, check in online), from the Travel section; it then shows with the trip'),
      due_date: date.optional(),
      notes: z.string().max(1000).optional(),
    }),
    (i, { store }) => {
      const t = store.createTask({ title: i.title, sphereId: i.sphere_id, goalId: i.goal_id, tripId: i.trip_id, dueDate: i.due_date, notes: i.notes });
      return { data: taskView(t), summary: `Added task: ${t.title}${t.dueDate ? ` (due ${prettyDay(t.dueDate)})` : ''}` };
    },
  ),

  tool(
    'update_task',
    'Complete, reschedule or reword a task. Set done to true when the user says they did it.',
    z.object({
      task_id: id('task'),
      done: z.boolean().optional(),
      title: z.string().min(1).max(200).optional(),
      due_date: date.nullable().optional().describe('null clears the date'),
      notes: z.string().max(1000).optional(),
      trip_id: z.string().nullable().optional().describe('Attach to a trip, or null to detach'),
    }),
    (i, { store }) => {
      const t = store.updateTask(i.task_id, { done: i.done, title: i.title, dueDate: i.due_date, notes: i.notes, tripId: i.trip_id });
      const what = i.done === true ? 'Done' : i.due_date !== undefined ? 'Rescheduled' : 'Updated';
      return { data: taskView(t), summary: `${what}: ${t.title}` };
    },
  ),

  tool(
    'create_habit',
    'Start tracking a recurring practice in a sphere. Use "daily" for every day, or "weekly" with times_per_week for things done a few times a week.',
    z.object({
      sphere_id: id('sphere'),
      name: z.string().min(1).max(120),
      cadence: z.enum(['daily', 'weekly']).optional(),
      times_per_week: z.number().int().min(1).max(6).optional(),
    }),
    (i, { store, today }) => {
      // "3 times a week" without a cadence means weekly, not daily.
      const cadence = i.cadence ?? (i.times_per_week ? 'weekly' : 'daily');
      const h = store.createHabit({ sphereId: i.sphere_id, name: i.name, cadence, targetPerWeek: cadence === 'weekly' ? i.times_per_week : undefined });
      return { data: habitView(store.getHabit(h.id, today)), summary: `New habit: ${h.name} (${cadence === 'weekly' ? `${h.targetPerWeek}× a week` : 'daily'})` };
    },
  ),

  tool(
    'log_habit',
    'Check a habit in for a day when the user says they did it (or uncheck with done=false). Date defaults to today.',
    z.object({ habit_id: id('habit'), date: date.optional(), done: z.boolean().optional() }),
    ({ habit_id, date: d, done }, { store, today }) => {
      const h = store.setHabitLog(habit_id, d ?? today, done ?? true, today);
      return { data: habitView(h), summary: `${done === false ? 'Unchecked' : 'Checked in'}: ${h.name}` };
    },
  ),

  tool(
    'create_metric',
    'Start tracking a number over time in a sphere (weight, savings, pages read). direction says which way is better.',
    z.object({
      sphere_id: id('sphere'),
      name: z.string().min(1).max(120),
      unit: z.string().max(12).optional().describe('e.g. kg, h, km — leave empty for plain counts or money'),
      direction: z.enum(['up', 'down', 'none']).optional(),
    }),
    (i, { store }) => {
      const m = store.createMetric({ sphereId: i.sphere_id, name: i.name, unit: i.unit, direction: i.direction });
      return { data: metricView(m), summary: `Now tracking ${m.name}` };
    },
  ),

  tool(
    'log_metric',
    'Record a value for a metric whenever the user reports a number that matches one. One value per day: logging the same date again replaces it. Date defaults to today.',
    z.object({ metric_id: id('metric'), value: z.number(), date: date.optional(), note: z.string().max(300).optional() }),
    (i, { store, today }) => {
      const m = store.getMetric(i.metric_id);
      const e = store.addMetricEntry(i.metric_id, { value: i.value, date: i.date ?? today, note: i.note });
      return { data: { ok: true, date: e.date, value: e.value }, summary: `Logged ${formatValue(e.value, m.unit)} to ${m.name}` };
    },
  ),

  tool(
    'get_metric_history',
    'Read the logged values of a metric over a period. Call this before describing a trend — do not estimate trends from the latest value alone.',
    z.object({ metric_id: id('metric'), days: z.number().int().min(1).max(730).optional().describe('How far back; default 90') }),
    ({ metric_id, days }, { store, today }) => {
      const m = store.getMetric(metric_id);
      const since = addDays(today, -(days ?? 90));
      const entries = m.entries.filter((e) => e.date >= since);
      return {
        data: { name: m.name, unit: m.unit, better_when: m.direction, entries: entries.map((e) => [e.date, e.value]) },
        summary: `Read ${m.name} history`,
      };
    },
  ),

  tool(
    'get_health_screenings',
    'Read the user\'s health-screening record (lab results from their check-ups, with what is flagged, what changed between visits, and the action plan). Call this before discussing their health numbers, risks or medical follow-ups. You are not a doctor: relay what the record says and encourage reviewing it with their GP.',
    z.object({}),
    (_input, { store }) => {
      const s = store.getScreenings();
      if (!s) return { data: 'No screening record has been imported yet.', summary: 'Looked for health screenings' };
      const attention = s.results.filter((r) => r.s === 'flag' || r.s === 'watch');
      return {
        data: {
          visits: s.visits,
          summary: s.summary,
          actions: (s.actions ?? []).map((a) => ({ priority: a.p, title: a.t, detail: a.body })),
          needs_attention: attention.map((r) => ({ test: r.n, group: r.g, earlier: r.a, latest: r.b, unit: r.u, healthy: r.ref, status: r.s, trend: r.v, note: r.note })),
          in_range_count: s.results.filter((r) => r.s === 'ok').length,
          risks: s.risks,
        },
        summary: 'Read the health screenings',
      };
    },
  ),

  tool(
    'read_journal',
    'Read the user\'s journal entries for the last few days. Call this when planning the day, doing a review, or when they refer to something they wrote.',
    z.object({ days: z.number().int().min(1).max(60).optional().describe('How many days back, including today; default 7') }),
    ({ days }, { store, today }) => {
      const out: { date: string; text: string }[] = [];
      for (let i = 0; i < (days ?? 7); i++) {
        const j = store.getJournal(addDays(today, -i));
        if (j) out.push({ date: j.date!, text: j.body });
      }
      return { data: out, summary: 'Read the journal' };
    },
  ),

  tool(
    'write_journal',
    'Add to the user\'s journal for a day (today by default). Use this when they reflect on their day and want it kept, or ask you to note something down. Write in their voice and words, not yours. Always appends; it never overwrites what they wrote.',
    z.object({ text: z.string().min(1).max(4000), date: date.optional() }),
    ({ text, date: d }, { store, today }) => {
      const j = store.appendJournal(d ?? today, text);
      return { data: { ok: true, date: j.date }, summary: `Wrote in the journal for ${prettyDay(j.date!)}` };
    },
  ),

  tool(
    'create_note',
    'Save something to the library: an idea, a reference, a link worth keeping. Attach a sphere when it clearly belongs to one.',
    z.object({
      title: z.string().max(200).optional(),
      body: z.string().max(8000).optional(),
      url: z.string().max(2000).optional(),
      sphere_id: z.string().optional(),
    }),
    (i, { store }) => {
      const n = store.createNote({ title: i.title, body: i.body, url: i.url, sphereId: i.sphere_id });
      return { data: { id: n.id, title: n.title }, summary: `Saved: ${n.title || n.url || 'a note'}` };
    },
  ),

  tool(
    'search',
    'Search across goals, tasks, habits, metrics, notes and journal entries by text. Call this to find something the user refers to that is not in the snapshot.',
    z.object({ query: z.string().min(1).max(200) }),
    ({ query }, { store }) => {
      const captured = new Set((store.db.prepare('SELECT id FROM notes WHERE capture IS NOT NULL').all() as { id: string }[]).map((r) => r.id));
      const hits = store.search(query, 20).map((h) =>
        h.type === 'note' && captured.has(h.id) ? { ...h, title: wrapUntrusted('saved item', h.title, 300), snippet: wrapUntrusted('saved item', h.snippet, 600) } : h,
      );
      return { data: hits, summary: `Searched for “${query}”` };
    },
  ),

  tool(
    'remember',
    'Save a durable fact or preference about the user that will matter in future conversations (how they like to plan, constraints, important people and dates). Do not save things already stored as goals, tasks or notes, and do not save passing moods.',
    z.object({ fact: z.string().min(1).max(500).describe('One self-contained sentence') }),
    ({ fact }, { store }) => {
      const m = store.addMemory(fact);
      return { data: { id: m.id }, summary: `Remembered: ${m.content}` };
    },
  ),
];

/** Feature modules add their own tools at startup. Order is kept stable. */
export function registerTools(defs: ToolDef[]): void {
  for (const d of defs) if (!TOOLS.some((t) => t.name === d.name)) TOOLS.push(d);
}

function specOf(t: ToolDef): ToolSpec {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
  return { name: t.name, description: t.description, schema };
}

/** A tool that lives elsewhere (a connected MCP server), described by JSON Schema. */
export interface ExternalTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  run: (input: unknown, ctx: ToolContext) => Promise<ToolOutput>;
}

type ToolSource = (store: Store) => Promise<ExternalTool[]>;
const SOURCES: ToolSource[] = [];
export function registerToolSource(source: ToolSource): void {
  SOURCES.push(source);
}

export interface ToolRun {
  content: string;
  isError: boolean;
  summary: string;
}

export interface Toolbox {
  specs: ToolSpec[];
  run: (name: string, input: unknown, ctx: ToolContext) => Promise<ToolRun>;
}

/** Everything the agent can use right now: built-in and feature tools, then connected servers'. */
export async function toolbox(store: Store): Promise<Toolbox> {
  const all = (await Promise.all(SOURCES.map((src) => src(store).catch(() => [] as ExternalTool[])))).flat();
  all.sort((a, b) => a.name.localeCompare(b.name));
  // Model APIs reject a request whose tool names repeat, so a clash would break every turn.
  const byName = new Map<string, ExternalTool>();
  for (const t of all) if (!byName.has(t.name) && !TOOLS.some((b) => b.name === t.name)) byName.set(t.name, t);
  const external = [...byName.values()];
  return {
    specs: [...TOOLS.map(specOf), ...external.map((t) => ({ name: t.name, description: t.description, schema: t.schema }))],
    run: async (name, input, ctx) => {
      const ext = byName.get(name);
      if (!ext) return runTool(name, input, ctx);
      // Whatever a connected server sends back is outside data, and so are its error messages.
      try {
        const out = await ext.run(input, ctx);
        return { content: wrapUntrusted(name, typeof out.data === 'string' ? out.data : JSON.stringify(out.data), 20_000), isError: false, summary: out.summary };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `Error: ${wrapUntrusted(name, message, 2000)}`, isError: true, summary: `Couldn't run ${name.replaceAll('_', ' ')}: ${message}` };
      }
    },
  };
}

export function toolSpecs(): ToolSpec[] {
  return TOOLS.map(specOf);
}

/** Validate and run one built-in tool. Never throws: failures come back as an error result the model can read. */
export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolRun> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { content: `Unknown tool "${name}".`, isError: true, summary: `Tried an unknown tool: ${name}` };

  const parsed = def.input.safeParse(input);
  if (!parsed.success) {
    // Streamed tool input is not validated server-side, so a cut-off or malformed input
    // lands here. Hand it back so the model can correct itself.
    return {
      content: JSON.stringify({ INVALID_INPUT: JSON.stringify(input), problems: z.prettifyError(parsed.error) }),
      isError: true,
      summary: `Couldn't run ${name.replaceAll('_', ' ')}`,
    };
  }

  try {
    const out = await def.run(parsed.data as never, ctx);
    return {
      content: typeof out.data === 'string' ? out.data : JSON.stringify(out.data),
      isError: false,
      summary: out.summary,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${message}`, isError: true, summary: `Couldn't run ${name.replaceAll('_', ' ')}: ${message}` };
  }
}
