// The data layer. Every read and write — from the HTTP API and from the agent's tools —
// goes through a Store, so both see the same rules and every change lands in the
// activity log with who made it.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { DB } from './db.ts';
import type { Turn } from './agent/types.ts';
import { CATALOG_BY_KEY } from '../../shared/catalog.ts';
import type {
  Activity,
  Actor,
  Cadence,
  ChatMessage,
  Conversation,
  ConversationSummary,
  Direction,
  Goal,
  GoalStatus,
  Habit,
  Horizon,
  Memory,
  Metric,
  MetricEntry,
  Milestone,
  ModelSettings,
  Brains,
  ConnectionInput,
  ConnectionView,
  Note,
  NoteKind,
  Overview,
  Profile,
  Screenings,
  ProviderKind,
  SearchHit,
  Settings,
  SettingsUpdate,
  Sphere,
  SphereDetail,
  SphereStats,
  SphereWithStats,
  Project,
  Task,
  ToolCallView,
} from '../../shared/types.ts';

// ── Small helpers ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type SqlValue = string | number | bigint | null;

export class NotFound extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFound';
  }
}

export class Invalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Invalid';
  }
}

export const nowIso = (): string => new Date().toISOString();

/** YYYY-MM-DD in the server's local timezone. */
export function localDate(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** YYYY-MM-DD of an instant in an IANA zone (the server's own zone when none is given). */
export function dateInZone(iso: string, zone: string | null): string {
  if (!zone) return localDate(new Date(iso));
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  } catch {
    return localDate(new Date(iso));
  }
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Monday that starts the calendar week holding this date. */
export function weekMonday(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** Whole days from a to b (b − a). Accepts dates or ISO timestamps. */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b.slice(0, 10)}T12:00:00Z`) - Date.parse(`${a.slice(0, 10)}T12:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** "Nov 19" — for text people read. Anything a model reads keeps the ISO date. */
export function prettyDay(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export function newId(): string {
  // 10 lowercase base-36 characters: short enough for a model to copy reliably.
  return BigInt(`0x${randomBytes(8).toString('hex')}`).toString(36).padStart(10, '0').slice(-10);
}

/** Format a metric value the way a person would write it. */
export function formatValue(value: number, unit: string): string {
  const n = Number.isInteger(value) ? value.toLocaleString('en-US') : String(Math.round(value * 100) / 100);
  return unit ? `${n} ${unit}` : n;
}

/**
 * Feature modules register how to reverse their own logged actions, keyed
 * "verb:entity_type". Runs inside the undo transaction.
 */
const UNDO_HANDLERS = new Map<string, (db: DB, entityId: string) => void>();
export function registerUndo(key: string, handler: (db: DB, entityId: string) => void): void {
  UNDO_HANDLERS.set(key, handler);
}

/** Tables owned by feature modules, included in export and import (secrets excluded). */
const FEATURE_TABLES: string[] = [];
export function registerDataTable(table: string): void {
  if (!FEATURE_TABLES.includes(table)) FEATURE_TABLES.push(table);
}

/** Entity type of the row that ties several rows from one action together. */
const GROUP = 'activity_group';

const UNDOABLE = new Set([
  'created:goal',
  'created:task',
  'created:project',
  'created:habit',
  'created:metric',
  'created:note',
  'created:milestone',
  'created:memory',
  'logged:metric_entry',
  'checked:habit_log',
  'completed:task',
  'completed:milestone',
]);

const DEFAULT_PROFILE: Profile = { userName: '', agentName: 'Seldon', onboarded: false };

interface StoredModel {
  provider: ProviderKind | null;
  preset: string | null;
  baseUrl: string;
  model: string;
  effort: ModelSettings['effort'];
  apiKey: string;
}
const DEFAULT_MODEL: StoredModel = {
  provider: null,
  preset: null,
  baseUrl: '',
  model: '',
  effort: 'auto',
  apiKey: '',
};

export interface ModelConfig extends StoredModel {
  provider: ProviderKind;
}

interface StoredConnection extends ModelConfig {
  id: string;
  label: string;
}

/** Anthropic falls back to ANTHROPIC_API_KEY from the environment when no key is saved. */
function withEnvKey(c: ModelConfig): ModelConfig {
  const apiKey = c.apiKey || (c.provider === 'anthropic' ? (process.env.ANTHROPIC_API_KEY ?? '') : '');
  return { provider: c.provider, preset: c.preset, baseUrl: c.baseUrl, model: c.model, effort: c.effort, apiKey };
}

function defaultLabel(provider: ProviderKind, preset: string | null): string {
  const names: Record<string, string> = { anthropic: 'Claude', openai: 'OpenAI', openrouter: 'OpenRouter', ollama: 'Ollama', lmstudio: 'LM Studio', custom: 'Custom model' };
  return names[preset ?? ''] ?? (provider === 'anthropic' ? 'Claude' : 'Model');
}

// ── Store ───────────────────────────────────────────────────────────────────

/** Who a request acts as, when not the person at the app: a program using an access token is Seldon. */
const ACTING = new AsyncLocalStorage<Actor>();
export function actingAs<T>(actor: Actor, fn: () => T): T {
  return ACTING.run(actor, fn);
}

export class Store {
  readonly db: DB;
  readonly actor: Actor;
  /** Ids of activity rows written through this handle, oldest first. */
  readonly trail: number[] = [];

  constructor(db: DB, actor: Actor = 'user') {
    this.db = db;
    this.actor = actor;
  }

  /** A handle that attributes its writes to someone else (the agent). */
  as(actor: Actor): Store {
    return new Store(this.db, actor);
  }

  private all(sql: string, ...params: SqlValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private get(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private run(sql: string, ...params: SqlValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  private patch(table: string, id: string, fields: Record<string, SqlValue | undefined>): void {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined) as [string, SqlValue][];
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    this.run(`UPDATE ${table} SET ${sets} WHERE id = ?`, ...entries.map(([, v]) => v), id);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Log an action from a feature module, attributed to this handle's actor. */
  record(verb: string, entityType: string, entityId: string, sphereId: string | null, summary: string): number {
    return this.log(verb, entityType, entityId, sphereId, summary);
  }

  private log(verb: string, entityType: string, entityId: string, sphereId: string | null, summary: string, undoData: unknown = null): number {
    const r = this.run(
      'INSERT INTO activity (ts, actor, verb, entity_type, entity_id, sphere_id, summary, undo_data) VALUES (?,?,?,?,?,?,?,?)',
      nowIso(),
      ACTING.getStore() ?? this.actor,
      verb,
      entityType,
      entityId,
      sphereId,
      summary,
      undoData === null ? null : JSON.stringify(undoData),
    );
    const id = Number(r.lastInsertRowid);
    this.trail.push(id);
    return id;
  }

  // ── Spheres ───────────────────────────────────────────────────────────────

  private sphereFromRow(r: Row): Sphere {
    return {
      id: r.id,
      key: r.key,
      name: r.name,
      icon: r.icon,
      hue: r.hue,
      vision: r.vision,
      position: r.position,
      archived: !!r.archived,
      createdAt: r.created_at,
    };
  }

  private sphereStats(sphereId: string, today: string): SphereStats {
    const goals = this.listGoals({ sphereId, status: 'active' });
    const habits = this.listHabits(today, sphereId);
    const openTasks = this.get('SELECT COUNT(*) AS n FROM tasks WHERE sphere_id = ? AND done = 0', sphereId)!.n as number;
    const lastActivityAt =
      (this.get('SELECT MAX(ts) AS ts FROM activity WHERE sphere_id = ? AND undone = 0', sphereId)?.ts as string | null) ??
      null;

    const goalProgress = goals.length ? goals.reduce((s, g) => s + g.progress, 0) / goals.length : null;
    // The pulse looks at the trailing seven days, so it isn't low every Monday just
    // because the calendar week has only begun.
    const since = addDays(today, -6);
    const habitRate = habits.length
      ? habits.reduce((s, h) => s + Math.min(h.log.filter((d) => d >= since).length, h.targetPerWeek) / h.targetPerWeek, 0) / habits.length
      : null;
    const quietDays = lastActivityAt ? Math.max(0, daysBetween(dateInZone(lastActivityAt, this.zone()), today)) : null;
    const recency = quietDays === null ? 0 : clamp01(1 - quietDays / 14);
    const pulse = habitRate === null ? recency : 0.6 * habitRate + 0.4 * recency;

    return {
      activeGoals: goals.length,
      goalProgress,
      habits: habits.length,
      habitRate,
      openTasks,
      lastActivityAt,
      quietDays,
      pulse: clamp01(pulse),
    };
  }

  listSpheres(today: string = localDate(), includeArchived = false): SphereWithStats[] {
    const rows = this.all(
      `SELECT * FROM spheres ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY archived, position, created_at`,
    );
    return rows.map((r) => ({ ...this.sphereFromRow(r), stats: this.sphereStats(r.id, today) }));
  }

  getSphere(id: string, today: string = localDate()): SphereWithStats {
    const r = this.get('SELECT * FROM spheres WHERE id = ?', id);
    if (!r) throw new NotFound('Sphere');
    return { ...this.sphereFromRow(r), stats: this.sphereStats(id, today) };
  }

  createSphere(input: { key?: string | null; name?: string; icon?: string; hue?: number; vision?: string }): Sphere {
    const preset = input.key ? CATALOG_BY_KEY[input.key] : undefined;
    const name = (input.name ?? preset?.name ?? '').trim();
    if (!name) throw new Invalid('A sphere needs a name');
    const id = newId();
    const position = (this.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM spheres')!.p as number) ?? 0;
    this.run(
      'INSERT INTO spheres (id, key, name, icon, hue, vision, position, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id,
      preset ? preset.key : null,
      name,
      input.icon ?? preset?.icon ?? 'circle',
      Math.round(((input.hue ?? preset?.hue ?? 220) % 360 + 360) % 360),
      input.vision ?? '',
      position,
      nowIso(),
    );
    this.log('created', 'sphere', id, id, `Added the ${name} sphere`);
    return this.sphereFromRow(this.get('SELECT * FROM spheres WHERE id = ?', id)!);
  }

  updateSphere(
    id: string,
    patch: { name?: string; icon?: string; hue?: number; vision?: string; archived?: boolean; position?: number },
  ): SphereWithStats {
    const before = this.getSphere(id);
    this.patch('spheres', id, {
      name: patch.name?.trim() || undefined,
      icon: patch.icon,
      hue: patch.hue,
      vision: patch.vision,
      archived: patch.archived === undefined ? undefined : Number(patch.archived),
      position: patch.position,
    });
    if (patch.vision !== undefined && patch.vision !== before.vision) {
      this.log('updated', 'sphere', id, id, `Rewrote the vision for ${before.name}`);
    }
    return this.getSphere(id);
  }

  reorderSpheres(ids: string[]): void {
    this.tx(() => ids.forEach((id, i) => this.run('UPDATE spheres SET position = ? WHERE id = ?', i, id)));
  }

  deleteSphere(id: string): void {
    this.getSphere(id);
    this.tx(() => {
      this.run('DELETE FROM activity WHERE sphere_id = ?', id);
      this.run('DELETE FROM spheres WHERE id = ?', id);
    });
  }

  // ── Goals ─────────────────────────────────────────────────────────────────

  private milestoneFromRow(r: Row): Milestone {
    return { id: r.id, goalId: r.goal_id, title: r.title, done: !!r.done, position: r.position, doneAt: r.done_at };
  }

  private latestMetricValue(metricId: string): number | null {
    const r = this.get('SELECT value FROM metric_entries WHERE metric_id = ? ORDER BY date DESC, created_at DESC LIMIT 1', metricId);
    return r ? (r.value as number) : null;
  }

  private goalFromRow(r: Row): Goal {
    const milestones = this.all('SELECT * FROM milestones WHERE goal_id = ? ORDER BY position, rowid', r.id).map((m) =>
      this.milestoneFromRow(m),
    );
    let progress = 0;
    let progressSource: Goal['progressSource'] = 'manual';
    if (r.status === 'done') {
      progress = 1;
      progressSource = 'done';
    } else if (r.metric_id && r.target_value !== null) {
      progressSource = 'metric';
      const latest = this.latestMetricValue(r.metric_id);
      // With no baseline (the metric was empty when linked), the first reading becomes it.
      const start = (r.start_value as number | null) ?? ((this.get('SELECT value FROM metric_entries WHERE metric_id = ? ORDER BY date, created_at LIMIT 1', r.metric_id)?.value as number | undefined) ?? null);
      const span = start === null ? 0 : (r.target_value as number) - start;
      if (latest !== null && start !== null && span !== 0) progress = clamp01((latest - start) / span);
    } else if (milestones.length > 0) {
      progressSource = 'milestones';
      progress = milestones.filter((m) => m.done).length / milestones.length;
    } else {
      progress = clamp01((r.manual_progress as number) / 100);
    }
    return {
      id: r.id,
      sphereId: r.sphere_id,
      title: r.title,
      why: r.why,
      status: r.status,
      horizon: r.horizon,
      targetDate: r.target_date,
      metricId: r.metric_id,
      startValue: r.start_value,
      targetValue: r.target_value,
      manualProgress: r.manual_progress,
      progress,
      progressSource,
      milestones,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      completedAt: r.completed_at,
    };
  }

  listGoals(filter: { sphereId?: string; status?: GoalStatus | 'all' } = {}): Goal[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.sphereId) {
      where.push('g.sphere_id = ?');
      params.push(filter.sphereId);
    }
    if (filter.status && filter.status !== 'all') {
      where.push('g.status = ?');
      params.push(filter.status);
    }
    where.push('s.archived = 0');
    const rows = this.all(
      `SELECT g.* FROM goals g JOIN spheres s ON s.id = g.sphere_id
       WHERE ${where.join(' AND ')}
       ORDER BY CASE g.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
                s.position, g.target_date IS NULL, g.target_date, g.created_at`,
      ...params,
    );
    return rows.map((r) => this.goalFromRow(r));
  }

  getGoal(id: string): Goal {
    const r = this.get('SELECT * FROM goals WHERE id = ?', id);
    if (!r) throw new NotFound('Goal');
    return this.goalFromRow(r);
  }

  createGoal(input: {
    sphereId: string;
    title: string;
    why?: string;
    horizon?: Horizon;
    targetDate?: string | null;
    metricId?: string | null;
    startValue?: number | null;
    targetValue?: number | null;
    milestones?: string[];
  }): Goal {
    const sphere = this.getSphere(input.sphereId);
    const title = input.title.trim();
    if (!title) throw new Invalid('A goal needs a title');
    const id = newId();
    const now = nowIso();
    let startValue = input.startValue ?? null;
    if (input.metricId != null) {
      const metric = this.getMetric(input.metricId);
      if (startValue === null) startValue = metric.latest ?? null;
    }
    this.tx(() => {
      this.run(
        `INSERT INTO goals (id, sphere_id, title, why, horizon, target_date, metric_id, start_value, target_value, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        sphere.id,
        title,
        input.why ?? '',
        input.horizon ?? 'year',
        input.targetDate ?? null,
        input.metricId ?? null,
        startValue,
        input.targetValue ?? null,
        now,
        now,
      );
      (input.milestones ?? []).forEach((m, i) => {
        if (m.trim()) this.run('INSERT INTO milestones (id, goal_id, title, position) VALUES (?,?,?,?)', newId(), id, m.trim(), i);
      });
    });
    this.log('created', 'goal', id, sphere.id, `New goal in ${sphere.name}: ${title}`);
    return this.getGoal(id);
  }

  updateGoal(
    id: string,
    patch: {
      title?: string;
      why?: string;
      status?: GoalStatus;
      horizon?: Horizon;
      targetDate?: string | null;
      metricId?: string | null;
      startValue?: number | null;
      targetValue?: number | null;
      manualProgress?: number;
      sphereId?: string;
    },
  ): Goal {
    const before = this.getGoal(id);
    if (patch.sphereId != null) this.getSphere(patch.sphereId);
    let startValue = patch.startValue;
    if (patch.metricId != null && patch.metricId !== before.metricId) {
      const metric = this.getMetric(patch.metricId);
      if (startValue === undefined || startValue === null) startValue = metric.latest ?? null;
    }
    const statusChanged = patch.status !== undefined && patch.status !== before.status;
    this.patch('goals', id, {
      title: patch.title?.trim() || undefined,
      why: patch.why,
      status: patch.status,
      horizon: patch.horizon,
      target_date: patch.targetDate,
      metric_id: patch.metricId,
      start_value: startValue,
      target_value: patch.targetValue,
      manual_progress:
        patch.manualProgress === undefined ? undefined : Math.round(clamp01(patch.manualProgress / 100) * 100),
      sphere_id: patch.sphereId,
      updated_at: nowIso(),
      completed_at: statusChanged ? (patch.status === 'done' ? nowIso() : null) : undefined,
    });
    const after = this.getGoal(id);
    if (statusChanged) {
      const verb = patch.status === 'done' ? 'completed' : 'updated';
      const phrase =
        patch.status === 'done'
          ? `Reached a goal: ${after.title}`
          : patch.status === 'active'
            ? `Picked back up: ${after.title}`
            : patch.status === 'paused'
              ? `Paused: ${after.title}`
              : `Let go of: ${after.title}`;
      this.log(verb, 'goal', id, after.sphereId, phrase);
    } else if (patch.manualProgress !== undefined && patch.manualProgress !== before.manualProgress) {
      this.log('updated', 'goal', id, after.sphereId, `${after.title} is at ${Math.round(after.progress * 100)}%`);
    }
    return after;
  }

  deleteGoal(id: string): void {
    this.getGoal(id);
    this.run('DELETE FROM goals WHERE id = ?', id);
  }

  addMilestone(goalId: string, title: string): Milestone {
    const goal = this.getGoal(goalId);
    if (!title.trim()) throw new Invalid('A milestone needs a title');
    const id = newId();
    this.run('INSERT INTO milestones (id, goal_id, title, position) VALUES (?,?,?,?)', id, goalId, title.trim(), goal.milestones.length);
    this.log('created', 'milestone', id, goal.sphereId, `Added a step to ${goal.title}: ${title.trim()}`);
    return this.milestoneFromRow(this.get('SELECT * FROM milestones WHERE id = ?', id)!);
  }

  updateMilestone(id: string, patch: { title?: string; done?: boolean }): Milestone {
    const r = this.get('SELECT * FROM milestones WHERE id = ?', id);
    if (!r) throw new NotFound('Milestone');
    const goal = this.getGoal(r.goal_id);
    this.patch('milestones', id, {
      title: patch.title?.trim() || undefined,
      done: patch.done === undefined ? undefined : Number(patch.done),
      done_at: patch.done === undefined ? undefined : patch.done ? nowIso() : null,
    });
    if (patch.done !== undefined && patch.done !== !!r.done) {
      this.run('UPDATE goals SET updated_at = ? WHERE id = ?', nowIso(), goal.id);
      if (patch.done) this.log('completed', 'milestone', id, goal.sphereId, `${goal.title}: finished “${r.title}”`);
    }
    return this.milestoneFromRow(this.get('SELECT * FROM milestones WHERE id = ?', id)!);
  }

  deleteMilestone(id: string): void {
    this.run('DELETE FROM milestones WHERE id = ?', id);
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  private taskFromRow(r: Row): Task {
    return {
      id: r.id,
      title: r.title,
      notes: r.notes,
      sphereId: r.sphere_id,
      goalId: r.goal_id,
      tripId: r.trip_id ?? null,
      projectId: r.project_id ?? null,
      dueDate: r.due_date,
      done: !!r.done,
      doneAt: r.done_at,
      createdAt: r.created_at,
    };
  }

  listTasks(filter: { status?: 'open' | 'done' | 'all'; sphereId?: string; goalId?: string; tripId?: string; projectId?: string; limit?: number } = {}): Task[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    const status = filter.status ?? 'open';
    if (status !== 'all') where.push(`done = ${status === 'done' ? 1 : 0}`);
    if (filter.sphereId) {
      where.push('sphere_id = ?');
      params.push(filter.sphereId);
    }
    if (filter.goalId) {
      where.push('goal_id = ?');
      params.push(filter.goalId);
    }
    if (filter.tripId) {
      where.push('trip_id = ?');
      params.push(filter.tripId);
    }
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    const order = status === 'done' ? 'done_at DESC' : 'done, due_date IS NULL, due_date, created_at';
    const rows = this.all(
      `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`,
      ...params,
      filter.limit ?? 500,
    );
    return rows.map((r) => this.taskFromRow(r));
  }

  getTask(id: string): Task {
    const r = this.get('SELECT * FROM tasks WHERE id = ?', id);
    if (!r) throw new NotFound('Task');
    return this.taskFromRow(r);
  }

  private checkTrip(id: string): void {
    if (!this.get('SELECT 1 AS x FROM trips WHERE id = ?', id)) throw new NotFound('Trip');
  }

  createTask(input: { title: string; notes?: string; sphereId?: string | null; goalId?: string | null; tripId?: string | null; projectId?: string | null; dueDate?: string | null }): Task {
    const title = input.title.trim();
    if (!title) throw new Invalid('A task needs a title');
    let sphereId = input.sphereId ?? null;
    // A project's to-do lives in the project's sphere.
    if (input.projectId != null) sphereId = this.getProject(input.projectId).sphereId;
    if (input.goalId != null) {
      const goal = this.getGoal(input.goalId);
      sphereId = sphereId ?? goal.sphereId;
    }
    if (input.tripId != null) {
      this.checkTrip(input.tripId);
      // A trip's to-do lives in the sphere the trip shows in, unless one was chosen.
      if (sphereId == null) {
        const t = this.get('SELECT purpose FROM trips WHERE id = ?', input.tripId)!;
        sphereId = this.get('SELECT id FROM spheres WHERE key = ? AND archived = 0', t.purpose === 'work' ? 'work' : 'travels')?.id ?? this.get("SELECT id FROM spheres WHERE key = 'travels' AND archived = 0")?.id ?? null;
      }
    }
    if (sphereId != null) this.getSphere(sphereId);
    const id = newId();
    this.run(
      'INSERT INTO tasks (id, title, notes, sphere_id, goal_id, trip_id, project_id, due_date, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id,
      title,
      input.notes ?? '',
      sphereId,
      input.goalId ?? null,
      input.tripId ?? null,
      input.projectId ?? null,
      input.dueDate ?? null,
      nowIso(),
    );
    this.log('created', 'task', id, sphereId, `Added a task: ${title}`);
    return this.getTask(id);
  }

  updateTask(
    id: string,
    patch: { title?: string; notes?: string; sphereId?: string | null; goalId?: string | null; tripId?: string | null; projectId?: string | null; dueDate?: string | null; done?: boolean },
  ): Task {
    const before = this.getTask(id);
    if (patch.sphereId != null) this.getSphere(patch.sphereId);
    if (patch.goalId != null) this.getGoal(patch.goalId);
    if (patch.tripId != null) this.checkTrip(patch.tripId);
    // Moving into a project moves the to-do into the project's sphere; moving to another
    // sphere takes it out of a project that isn't there.
    let projectId = patch.projectId;
    let sphereId = patch.sphereId;
    if (projectId != null) sphereId = this.getProject(projectId).sphereId;
    else if (sphereId !== undefined && projectId === undefined && before.projectId) {
      const p = this.get('SELECT sphere_id FROM projects WHERE id = ?', before.projectId);
      if (!p || p.sphere_id !== sphereId) projectId = null;
    }
    this.patch('tasks', id, {
      title: patch.title?.trim() || undefined,
      notes: patch.notes,
      sphere_id: sphereId,
      goal_id: patch.goalId,
      trip_id: patch.tripId,
      project_id: projectId,
      due_date: patch.dueDate,
      done: patch.done === undefined ? undefined : Number(patch.done),
      done_at: patch.done === undefined ? undefined : patch.done ? nowIso() : null,
    });
    const after = this.getTask(id);
    if (patch.done === true && !before.done) this.log('completed', 'task', id, after.sphereId, `Done: ${after.title}`);
    return after;
  }

  deleteTask(id: string): void {
    this.getTask(id);
    this.run('DELETE FROM tasks WHERE id = ?', id);
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  private projectFromRow(r: Row): Project {
    return { id: r.id, sphereId: r.sphere_id, name: r.name, archived: !!r.archived, createdAt: r.created_at };
  }

  listProjects(filter: { sphereId?: string; archived?: boolean } = {}): Project[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.sphereId) {
      where.push('sphere_id = ?');
      params.push(filter.sphereId);
    }
    if (!filter.archived) where.push('archived = 0');
    return this.all(`SELECT * FROM projects ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`, ...params).map((r) => this.projectFromRow(r));
  }

  getProject(id: string): Project {
    const r = this.get('SELECT * FROM projects WHERE id = ?', id);
    if (!r) throw new NotFound('Project');
    return this.projectFromRow(r);
  }

  createProject(input: { sphereId: string; name: string }): Project {
    const name = input.name.trim();
    if (!name) throw new Invalid('A project needs a name');
    const sphere = this.getSphere(input.sphereId);
    // Asking for a project that already exists (by name, in this sphere) hands that one back.
    const same = this.get('SELECT * FROM projects WHERE sphere_id = ? AND lower(name) = lower(?)', sphere.id, name);
    if (same) {
      if (same.archived) this.run('UPDATE projects SET archived = 0 WHERE id = ?', same.id);
      return this.getProject(same.id);
    }
    const id = newId();
    this.run('INSERT INTO projects (id, sphere_id, name, created_at) VALUES (?,?,?,?)', id, sphere.id, name, nowIso());
    this.log('created', 'project', id, sphere.id, `New project in ${sphere.name}: ${name}`);
    return this.getProject(id);
  }

  updateProject(id: string, patch: { name?: string; archived?: boolean }): Project {
    this.getProject(id);
    if (patch.name !== undefined && !patch.name.trim()) throw new Invalid('A project needs a name');
    this.patch('projects', id, { name: patch.name?.trim(), archived: patch.archived === undefined ? undefined : Number(patch.archived) });
    return this.getProject(id);
  }

  /** Deletes the project; its to-dos stay, with no project. */
  deleteProject(id: string): void {
    this.getProject(id);
    this.run('DELETE FROM projects WHERE id = ?', id);
  }

  // ── Habits ────────────────────────────────────────────────────────────────

  private habitFromRow(r: Row, today: string): Habit {
    const dates = this.all(
      'SELECT date FROM habit_logs WHERE habit_id = ? AND date >= ? AND date <= ? ORDER BY date',
      r.id,
      addDays(today, -400),
      today,
    ).map((x) => x.date as string);
    const set = new Set(dates);
    // Weeks are calendar weeks, Monday to Sunday.
    const weekStart = weekMonday(today);
    const weekCount = (monday: string): number => {
      let n = 0;
      for (let i = 0; i < 7; i++) if (set.has(addDays(monday, i))) n++;
      return n;
    };

    let streak = 0;
    if (r.cadence === 'daily') {
      // A streak survives until the end of today: start from yesterday if today is still open.
      let cursor = set.has(today) ? today : addDays(today, -1);
      while (set.has(cursor)) {
        streak++;
        cursor = addDays(cursor, -1);
      }
    } else {
      // Whole weeks on target, counting this week once it is on target and last week
      // back otherwise, since this week is still open.
      let monday = weekCount(weekStart) >= r.target_per_week ? weekStart : addDays(weekStart, -7);
      while (streak < 60 && weekCount(monday) >= r.target_per_week) {
        streak++;
        monday = addDays(monday, -7);
      }
    }

    return {
      id: r.id,
      sphereId: r.sphere_id,
      name: r.name,
      cadence: r.cadence,
      targetPerWeek: r.target_per_week,
      archived: !!r.archived,
      createdAt: r.created_at,
      log: dates.filter((d) => d >= addDays(today, -34)),
      doneToday: set.has(today),
      weekCount: weekCount(weekStart),
      streak,
    };
  }

  listHabits(today: string = localDate(), sphereId?: string, includeArchived = false): Habit[] {
    const where = ['s.archived = 0'];
    const params: SqlValue[] = [];
    if (!includeArchived) where.push('h.archived = 0');
    if (sphereId) {
      where.push('h.sphere_id = ?');
      params.push(sphereId);
    }
    const rows = this.all(
      `SELECT h.* FROM habits h JOIN spheres s ON s.id = h.sphere_id
       WHERE ${where.join(' AND ')} ORDER BY s.position, h.created_at`,
      ...params,
    );
    return rows.map((r) => this.habitFromRow(r, today));
  }

  getHabit(id: string, today: string = localDate()): Habit {
    const r = this.get('SELECT * FROM habits WHERE id = ?', id);
    if (!r) throw new NotFound('Habit');
    return this.habitFromRow(r, today);
  }

  createHabit(input: { sphereId: string; name: string; cadence?: Cadence; targetPerWeek?: number }): Habit {
    const sphere = this.getSphere(input.sphereId);
    const name = input.name.trim();
    if (!name) throw new Invalid('A habit needs a name');
    const cadence = input.cadence ?? 'daily';
    const target = cadence === 'daily' ? 7 : Math.min(6, Math.max(1, Math.round(input.targetPerWeek ?? 1)));
    const id = newId();
    this.run(
      'INSERT INTO habits (id, sphere_id, name, cadence, target_per_week, created_at) VALUES (?,?,?,?,?,?)',
      id,
      sphere.id,
      name,
      cadence,
      target,
      nowIso(),
    );
    this.log('created', 'habit', id, sphere.id, `New habit in ${sphere.name}: ${name}`);
    return this.getHabit(id);
  }

  updateHabit(id: string, patch: { name?: string; cadence?: Cadence; targetPerWeek?: number; archived?: boolean }): Habit {
    const before = this.getHabit(id);
    const cadence = patch.cadence ?? before.cadence;
    const target =
      cadence === 'daily' ? 7 : Math.min(6, Math.max(1, Math.round(patch.targetPerWeek ?? Math.min(before.targetPerWeek, 6))));
    this.patch('habits', id, {
      name: patch.name?.trim() || undefined,
      cadence: patch.cadence,
      target_per_week: target,
      archived: patch.archived === undefined ? undefined : Number(patch.archived),
    });
    return this.getHabit(id);
  }

  deleteHabit(id: string): void {
    this.getHabit(id);
    this.run('DELETE FROM habits WHERE id = ?', id);
  }

  /** Check a habit in or out for a day. `done` omitted toggles. */
  setHabitLog(id: string, date: string, done?: boolean, today: string = localDate()): Habit {
    const habit = this.getHabit(id, today);
    const exists = !!this.get('SELECT 1 AS x FROM habit_logs WHERE habit_id = ? AND date = ?', id, date);
    const want = done ?? !exists;
    if (want && !exists) {
      this.run('INSERT INTO habit_logs (habit_id, date) VALUES (?, ?)', id, date);
      this.log('checked', 'habit_log', `${id}|${date}`, habit.sphereId, `Checked in: ${habit.name}${date === today ? '' : ` (${prettyDay(date)})`}`);
    } else if (!want && exists) {
      this.run('DELETE FROM habit_logs WHERE habit_id = ? AND date = ?', id, date);
      this.run(
        "UPDATE activity SET undone = 1 WHERE entity_type = 'habit_log' AND entity_id = ? AND undone = 0",
        `${id}|${date}`,
      );
    }
    return this.getHabit(id, today);
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  private entryFromRow(r: Row): MetricEntry {
    return { id: r.id, metricId: r.metric_id, date: r.date, value: r.value, note: r.note };
  }

  private metricFromRow(r: Row): Metric {
    const entries = this.all(
      `SELECT * FROM (SELECT * FROM metric_entries WHERE metric_id = ? ORDER BY date DESC, created_at DESC LIMIT 120)
       ORDER BY date, created_at`,
      r.id,
    ).map((e) => this.entryFromRow(e));
    const latest = entries.length ? entries[entries.length - 1]!.value : null;
    const change = entries.length > 1 ? latest! - entries[0]!.value : null;
    return {
      id: r.id,
      sphereId: r.sphere_id,
      name: r.name,
      unit: r.unit,
      direction: r.direction,
      createdAt: r.created_at,
      entries,
      latest,
      change,
    };
  }

  listMetrics(sphereId?: string): Metric[] {
    const rows = sphereId
      ? this.all('SELECT * FROM metrics WHERE sphere_id = ? ORDER BY created_at', sphereId)
      : this.all(
          `SELECT m.* FROM metrics m JOIN spheres s ON s.id = m.sphere_id
           WHERE s.archived = 0 ORDER BY s.position, m.created_at`,
        );
    return rows.map((r) => this.metricFromRow(r));
  }

  getMetric(id: string): Metric {
    const r = this.get('SELECT * FROM metrics WHERE id = ?', id);
    if (!r) throw new NotFound('Metric');
    return this.metricFromRow(r);
  }

  createMetric(input: { sphereId: string; name: string; unit?: string; direction?: Direction }): Metric {
    const sphere = this.getSphere(input.sphereId);
    const name = input.name.trim();
    if (!name) throw new Invalid('A metric needs a name');
    const id = newId();
    this.run(
      'INSERT INTO metrics (id, sphere_id, name, unit, direction, created_at) VALUES (?,?,?,?,?,?)',
      id,
      sphere.id,
      name,
      (input.unit ?? '').trim(),
      input.direction ?? 'up',
      nowIso(),
    );
    this.log('created', 'metric', id, sphere.id, `Now tracking ${name} in ${sphere.name}`);
    return this.getMetric(id);
  }

  updateMetric(id: string, patch: { name?: string; unit?: string; direction?: Direction }): Metric {
    this.getMetric(id);
    this.patch('metrics', id, { name: patch.name?.trim() || undefined, unit: patch.unit?.trim(), direction: patch.direction });
    return this.getMetric(id);
  }

  deleteMetric(id: string): void {
    this.getMetric(id);
    this.run('DELETE FROM metrics WHERE id = ?', id);
  }

  /** One value per metric per day: logging again on the same date replaces it. */
  addMetricEntry(metricId: string, input: { value: number; date?: string; note?: string }): MetricEntry {
    const metric = this.getMetric(metricId);
    if (!Number.isFinite(input.value)) throw new Invalid('A metric entry needs a number');
    const date = input.date ?? localDate();
    const existing = this.get('SELECT id, value, note FROM metric_entries WHERE metric_id = ? AND date = ?', metricId, date);
    let id: string;
    if (existing) {
      id = existing.id;
      this.run('UPDATE metric_entries SET value = ?, note = ? WHERE id = ?', input.value, input.note ?? '', id);
    } else {
      id = newId();
      this.run(
        'INSERT INTO metric_entries (id, metric_id, date, value, note, created_at) VALUES (?,?,?,?,?,?)',
        id,
        metricId,
        date,
        input.value,
        input.note ?? '',
        nowIso(),
      );
    }
    // Re-logging a day replaces its value; undo puts the old one back rather than deleting the day.
    const replaced = existing ? { value: existing.value as number, note: existing.note as string } : null;
    this.log('logged', 'metric_entry', id, metric.sphereId, `Logged ${metric.name}: ${formatValue(input.value, metric.unit)}`, replaced);
    return this.entryFromRow(this.get('SELECT * FROM metric_entries WHERE id = ?', id)!);
  }

  deleteMetricEntry(id: string): void {
    this.run('DELETE FROM metric_entries WHERE id = ?', id);
  }

  // ── Notes & journal ───────────────────────────────────────────────────────

  private noteFromRow(r: Row): Note {
    return {
      id: r.id,
      sphereId: r.sphere_id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      url: r.url,
      date: r.date,
      pinned: !!r.pinned,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      capture: r.capture ? (JSON.parse(r.capture) as Note['capture']) : null,
      status: r.status ?? 'ready',
    };
  }

  listNotes(filter: { kind?: NoteKind; sphereId?: string; q?: string; limit?: number; saved?: boolean; collection?: string } = {}): Note[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.sphereId) {
      where.push('sphere_id = ?');
      params.push(filter.sphereId);
    }
    if (filter.saved) where.push('capture IS NOT NULL');
    if (filter.collection) {
      where.push("json_extract(capture, '$.collection') = ?");
      params.push(filter.collection);
    }
    if (filter.q?.trim()) {
      where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
      const like = likePattern(filter.q);
      params.push(like, like);
    }
    const rows = this.all(
      `SELECT * FROM notes ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY pinned DESC, COALESCE(date, updated_at) DESC LIMIT ?`,
      ...params,
      filter.limit ?? 1000,
    );
    return rows.map((r) => this.noteFromRow(r));
  }

  getNote(id: string): Note {
    const r = this.get('SELECT * FROM notes WHERE id = ?', id);
    if (!r) throw new NotFound('Note');
    return this.noteFromRow(r);
  }

  createNote(input: { kind?: 'note' | 'link'; title?: string; body?: string; url?: string; sphereId?: string | null }): Note {
    const url = (input.url ?? '').trim();
    const title = (input.title ?? '').trim();
    const body = input.body ?? '';
    if (!title && !body.trim() && !url) throw new Invalid('A note needs a title, some text or a link');
    if (input.sphereId != null) this.getSphere(input.sphereId);
    const id = newId();
    const now = nowIso();
    this.run(
      'INSERT INTO notes (id, sphere_id, kind, title, body, url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      id,
      input.sphereId ?? null,
      input.kind ?? (url ? 'link' : 'note'),
      title,
      body,
      url,
      now,
      now,
    );
    this.log('created', 'note', id, input.sphereId ?? null, `Saved ${url ? 'a link' : 'a note'}: ${title || url || body.slice(0, 60)}`);
    return this.getNote(id);
  }

  updateNote(id: string, patch: { title?: string; body?: string; url?: string; sphereId?: string | null; pinned?: boolean }): Note {
    this.getNote(id);
    if (patch.sphereId != null) this.getSphere(patch.sphereId);
    this.patch('notes', id, {
      title: patch.title,
      body: patch.body,
      url: patch.url,
      sphere_id: patch.sphereId,
      pinned: patch.pinned === undefined ? undefined : Number(patch.pinned),
      updated_at: nowIso(),
    });
    return this.getNote(id);
  }

  deleteNote(id: string): void {
    this.getNote(id);
    this.run('DELETE FROM notes WHERE id = ?', id);
  }

  getJournal(date: string): Note | null {
    const r = this.get("SELECT * FROM notes WHERE kind = 'journal' AND date = ?", date);
    return r ? this.noteFromRow(r) : null;
  }

  /** Replace the day's entry. An empty body removes it. */
  putJournal(date: string, body: string): Note | null {
    const existing = this.getJournal(date);
    if (!body.trim()) {
      if (existing) this.run('DELETE FROM notes WHERE id = ?', existing.id);
      return null;
    }
    const now = nowIso();
    if (existing) {
      this.run('UPDATE notes SET body = ?, updated_at = ? WHERE id = ?', body, now, existing.id);
    } else {
      const id = newId();
      this.run(
        "INSERT INTO notes (id, kind, title, body, date, created_at, updated_at) VALUES (?, 'journal', ?, ?, ?, ?, ?)",
        id,
        date,
        body,
        date,
        now,
        now,
      );
      this.log('wrote', 'journal', id, null, date === localDate() ? 'Wrote in the journal' : `Wrote in the journal for ${prettyDay(date)}`);
    }
    return this.getJournal(date);
  }

  appendJournal(date: string, text: string): Note {
    const existing = this.getJournal(date);
    const body = existing?.body.trim() ? `${existing.body.trimEnd()}\n\n${text.trim()}` : text.trim();
    const note = this.putJournal(date, body);
    if (!note) throw new Invalid('Nothing to write');
    if (existing) this.log('wrote', 'journal', note.id, null, date === localDate() ? 'Added to the journal' : `Added to the journal for ${prettyDay(date)}`);
    return note;
  }

  // ── Health screenings ─────────────────────────────────────────────────────

  getScreenings(): Screenings | null {
    const r = this.get("SELECT data FROM screenings WHERE id = 'main'");
    return r ? (JSON.parse(r.data) as Screenings) : null;
  }

  /** Replace the screening record (null removes it). */
  putScreenings(data: Screenings | null): void {
    if (data === null) {
      this.run("DELETE FROM screenings WHERE id = 'main'");
      return;
    }
    this.run(
      "INSERT INTO screenings (id, data, updated_at) VALUES ('main', ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      JSON.stringify(data),
      nowIso(),
    );
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  listMemories(): Memory[] {
    return this.all('SELECT * FROM memories ORDER BY created_at').map((r) => ({
      id: r.id,
      content: r.content,
      createdAt: r.created_at,
    }));
  }

  addMemory(content: string): Memory {
    const text = content.trim();
    if (!text) throw new Invalid('Nothing to remember');
    const id = newId();
    const createdAt = nowIso();
    this.run('INSERT INTO memories (id, content, created_at) VALUES (?,?,?)', id, text, createdAt);
    this.log('created', 'memory', id, null, `Remembered: ${text}`);
    return { id, content: text, createdAt };
  }

  deleteMemory(id: string): void {
    this.run('DELETE FROM memories WHERE id = ?', id);
  }

  // ── Activity ──────────────────────────────────────────────────────────────

  private activityFromRow(r: Row): Activity {
    return {
      id: r.id,
      ts: r.ts,
      actor: r.actor,
      verb: r.verb,
      entityType: r.entity_type,
      entityId: r.entity_id,
      sphereId: r.sphere_id,
      summary: r.summary,
      undone: !!r.undone,
      undoable:
        !r.undone &&
        (r.entity_type === GROUP
          ? this.groupMembers(r.id).some((id) => this.getActivity(id)?.undoable)
          : UNDOABLE.has(`${r.verb}:${r.entity_type}`) || UNDO_HANDLERS.has(`${r.verb}:${r.entity_type}`)),
    };
  }

  /**
   * Ties the rows one action wrote (a meal of several foods, a reading plus its weight)
   * together so a single undo reverses all of them. Returns the id to undo. The group
   * row itself stays out of the feed, which already shows each part.
   */
  group(ids: number[], summary: string): number | null {
    if (ids.length <= 1) return ids[0] ?? null;
    return this.log('grouped', GROUP, newId(), null, summary, { ids });
  }

  private groupMembers(id: number): number[] {
    const raw = this.get('SELECT undo_data FROM activity WHERE id = ?', id)?.undo_data as string | null | undefined;
    return raw ? ((JSON.parse(raw) as { ids?: number[] }).ids ?? []) : [];
  }

  listActivity(filter: { sphereId?: string; limit?: number } = {}): Activity[] {
    const rows = filter.sphereId
      ? this.all('SELECT * FROM activity WHERE sphere_id = ? AND undone = 0 ORDER BY ts DESC, id DESC LIMIT ?', filter.sphereId, filter.limit ?? 30)
      : this.all('SELECT * FROM activity WHERE undone = 0 AND entity_type != ? ORDER BY ts DESC, id DESC LIMIT ?', GROUP, filter.limit ?? 30);
    return rows.map((r) => this.activityFromRow(r));
  }

  getActivity(id: number): Activity | null {
    const r = this.get('SELECT * FROM activity WHERE id = ?', id);
    return r ? this.activityFromRow(r) : null;
  }

  /** Mark the activity of records that no longer exist as undone. */
  private retire(entityType: string, ids: string[]): void {
    for (const id of ids) this.run('UPDATE activity SET undone = 1 WHERE entity_type = ? AND entity_id = ?', entityType, id);
  }

  /** Reverse one logged action (or group). Returns false when it cannot (or can no longer) be undone. */
  undo(activityId: number): boolean {
    const a = this.getActivity(activityId);
    if (!a || !a.undoable) return false;
    this.tx(() => {
      if (a.entityType !== GROUP) return this.reverse(a);
      // Newest first, the reverse of the order they were made in. Each is looked up again
      // because reversing one can take another with it.
      for (const id of this.groupMembers(a.id).reverse()) {
        const part = this.getActivity(id);
        if (part?.undoable) this.reverse(part);
      }
      this.run('UPDATE activity SET undone = 1 WHERE id = ?', a.id);
    });
    return true;
  }

  private reverse(a: Activity): void {
    switch (`${a.verb}:${a.entityType}`) {
      case 'created:goal':
        // What happened to its steps goes with it, so the feed does not offer to undo those too.
        this.retire('milestone', this.all('SELECT id FROM milestones WHERE goal_id = ?', a.entityId).map((r) => r.id as string));
        this.run("UPDATE activity SET undone = 1 WHERE entity_type = 'goal' AND entity_id = ?", a.entityId);
        this.run('DELETE FROM goals WHERE id = ?', a.entityId);
        break;
      case 'created:task':
        this.run('DELETE FROM tasks WHERE id = ?', a.entityId);
        break;
      case 'created:project':
        // Its to-dos stay, with no project.
        this.run('DELETE FROM projects WHERE id = ?', a.entityId);
        break;
      case 'created:habit':
        this.run("UPDATE activity SET undone = 1 WHERE entity_type = 'habit_log' AND entity_id LIKE ? ESCAPE '\\'", `${likeEscape(a.entityId)}|%`);
        this.run("UPDATE activity SET undone = 1 WHERE entity_type = 'habit' AND entity_id = ?", a.entityId);
        this.run('DELETE FROM habits WHERE id = ?', a.entityId);
        break;
      case 'created:metric':
        this.retire('metric_entry', this.all('SELECT id FROM metric_entries WHERE metric_id = ?', a.entityId).map((r) => r.id as string));
        this.run("UPDATE activity SET undone = 1 WHERE entity_type = 'metric' AND entity_id = ?", a.entityId);
        this.run('DELETE FROM metrics WHERE id = ?', a.entityId);
        break;
      case 'created:note':
        this.run('DELETE FROM notes WHERE id = ?', a.entityId);
        break;
      case 'created:milestone':
        this.run('DELETE FROM milestones WHERE id = ?', a.entityId);
        break;
      case 'created:memory':
        this.run('DELETE FROM memories WHERE id = ?', a.entityId);
        break;
      case 'logged:metric_entry': {
        const raw = this.get('SELECT undo_data FROM activity WHERE id = ?', a.id)?.undo_data as string | null | undefined;
        const prev = raw ? (JSON.parse(raw) as { value: number; note: string }) : null;
        if (prev) this.run('UPDATE metric_entries SET value = ?, note = ? WHERE id = ?', prev.value, prev.note, a.entityId);
        else this.run('DELETE FROM metric_entries WHERE id = ?', a.entityId);
        break;
      }
      case 'checked:habit_log': {
        const [habitId, date] = a.entityId.split('|');
        this.run('DELETE FROM habit_logs WHERE habit_id = ? AND date = ?', habitId!, date!);
        break;
      }
      case 'completed:task':
        this.run('UPDATE tasks SET done = 0, done_at = NULL WHERE id = ?', a.entityId);
        break;
      case 'completed:milestone':
        this.run('UPDATE milestones SET done = 0, done_at = NULL WHERE id = ?', a.entityId);
        break;
      default:
        UNDO_HANDLERS.get(`${a.verb}:${a.entityType}`)?.(this.db, a.entityId);
    }
    // Anything logged against the same entity goes with it (e.g. a goal's "created" row).
    this.run('UPDATE activity SET undone = 1 WHERE id = ? OR (entity_type = ? AND entity_id = ? AND id >= ?)', a.id, a.entityType, a.entityId, a.id);
  }

  // ── Search ────────────────────────────────────────────────────────────────

  search(query: string, limit = 30): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const like = likePattern(q);
    const hits: SearchHit[] = [];
    const push = (type: SearchHit['type'], rows: Row[]): void => {
      for (const r of rows) {
        const title = r.journal_date ? `Journal · ${prettyDay(r.journal_date)}` : r.title;
        hits.push({ type, id: r.id, title, snippet: snippet(r.text ?? '', q), sphereId: r.sphere_id ?? null });
      }
    };
    push('sphere', this.all("SELECT id, name AS title, vision AS text, id AS sphere_id FROM spheres WHERE archived = 0 AND (name LIKE ? ESCAPE '\\' OR vision LIKE ? ESCAPE '\\') LIMIT 5", like, like));
    push('goal', this.all("SELECT id, title, why AS text, sphere_id FROM goals WHERE title LIKE ? ESCAPE '\\' OR why LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 10", like, like));
    push('task', this.all("SELECT id, title, notes AS text, sphere_id FROM tasks WHERE title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' ORDER BY done, created_at DESC LIMIT 10", like, like));
    push('habit', this.all("SELECT id, name AS title, '' AS text, sphere_id FROM habits WHERE archived = 0 AND name LIKE ? ESCAPE '\\' LIMIT 5", like));
    push('metric', this.all("SELECT id, name AS title, unit AS text, sphere_id FROM metrics WHERE name LIKE ? ESCAPE '\\' LIMIT 5", like));
    push(
      'note',
      this.all(
        "SELECT id, CASE WHEN title = '' THEN substr(body, 1, 60) ELSE title END AS title, CASE WHEN kind = 'journal' THEN date END AS journal_date, body AS text, sphere_id FROM notes WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 12",
        like,
        like,
        like,
      ),
    );
    // Take from each kind in turn, so a query that matches many goals still finds notes.
    const groups = new Map<SearchHit['type'], SearchHit[]>();
    for (const h of hits) groups.set(h.type, [...(groups.get(h.type) ?? []), h]);
    const out: SearchHit[] = [];
    while (out.length < limit && [...groups.values()].some((g) => g.length)) {
      for (const g of groups.values()) if (g.length && out.length < limit) out.push(g.shift()!);
    }
    return out;
  }

  // ── Composite reads ───────────────────────────────────────────────────────

  overview(date: string = localDate()): Overview {
    const open = this.listTasks({ status: 'open' });
    const weekAhead = addDays(date, 7);
    // Any zone is within ±14h of UTC, so a two-day window always holds the local day.
    const zone = this.zone();
    const doneToday = this.all('SELECT * FROM tasks WHERE done = 1 AND done_at >= ? ORDER BY done_at DESC LIMIT 60', `${addDays(date, -1)}T00:00:00.000Z`)
      .map((r) => this.taskFromRow(r))
      .filter((t) => t.doneAt !== null && dateInZone(t.doneAt, zone) === date)
      .slice(0, 20);
    const soon = addDays(date, 30);
    return {
      date,
      profile: this.getProfile(),
      spheres: this.listSpheres(date),
      tasks: {
        due: open.filter((t) => t.dueDate !== null && t.dueDate <= date),
        anytime: open.filter((t) => t.dueDate === null),
        upcoming: open.filter((t) => t.dueDate !== null && t.dueDate > date && t.dueDate <= weekAhead),
        doneToday,
      },
      habits: this.listHabits(date),
      journal: this.getJournal(date),
      goalsDue: this.listGoals({ status: 'active' }).filter((g) => g.targetDate !== null && g.targetDate <= soon),
      activity: this.listActivity({ limit: 14 }),
    };
  }

  sphereDetail(id: string, today: string = localDate()): SphereDetail {
    return {
      sphere: this.getSphere(id, today),
      goals: this.listGoals({ sphereId: id, status: 'all' }),
      habits: this.listHabits(today, id),
      metrics: this.listMetrics(id),
      tasks: this.listTasks({ sphereId: id, status: 'open' }),
      projects: this.listProjects({ sphereId: id }),
      notes: this.listNotes({ sphereId: id, limit: 50 }),
      activity: this.listActivity({ sphereId: id, limit: 12 }),
    };
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  private readSetting<T>(key: string, fallback: T): T {
    const r = this.get('SELECT value FROM settings WHERE key = ?', key);
    return r ? { ...fallback, ...(JSON.parse(r.value) as Partial<T>) } : fallback;
  }
  private writeSetting(key: string, value: unknown): void {
    this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  /** The person's time zone, as their browser last reported it; null means the server's. */
  zone(): string | null {
    const r = this.get("SELECT value FROM settings WHERE key = 'timezone'");
    return r ? (JSON.parse(r.value) as string) : null;
  }

  setZone(tz: string): void {
    if (tz === this.zone()) return;
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      return;
    }
    this.writeSetting('timezone', tz);
  }

  getProfile(): Profile {
    return this.readSetting('profile', DEFAULT_PROFILE);
  }

  // ── Brains (model connections) ────────────────────────────────────────────

  private readRaw<T>(key: string): T | null {
    const r = this.get('SELECT value FROM settings WHERE key = ?', key);
    return r ? (JSON.parse(r.value) as T) : null;
  }

  /** Every connection as stored, keys included. Never send these to the client. */
  private storedConnections(): StoredConnection[] {
    const list = this.readRaw<StoredConnection[]>('connections');
    if (list) return list;
    // Before brains, there was one "model" setting: carry it over as the first brain.
    const legacy = this.readSetting('model', DEFAULT_MODEL);
    if (!legacy.provider) return [];
    const first: StoredConnection = { ...legacy, provider: legacy.provider, id: newId(), label: defaultLabel(legacy.provider, legacy.preset) };
    this.writeSetting('connections', [first]);
    this.writeSetting('brains', { chat: first.id, background: first.id });
    return [first];
  }

  private saveConnections(list: StoredConnection[]): void {
    this.writeSetting('connections', list);
  }

  getBrains(): Brains {
    const list = this.storedConnections();
    const saved = this.readRaw<Brains>('brains') ?? { chat: null, background: null };
    const valid = (id: string | null) => (id && list.some((c) => c.id === id) ? id : (list[0]?.id ?? null));
    return { chat: valid(saved.chat), background: valid(saved.background) };
  }

  setBrains(next: Partial<Brains>): Brains {
    const list = this.storedConnections();
    for (const id of Object.values(next)) if (id && !list.some((c) => c.id === id)) throw new NotFound('Connection');
    this.writeSetting('brains', { ...this.getBrains(), ...next });
    return this.getBrains();
  }

  private viewConnection(c: StoredConnection): ConnectionView {
    const key = withEnvKey(c).apiKey;
    return {
      id: c.id,
      label: c.label,
      provider: c.provider,
      preset: c.preset,
      baseUrl: c.baseUrl,
      model: c.model,
      effort: c.effort,
      hasApiKey: key.length > 0,
      apiKeyHint: key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key ? '••••' : '',
    };
  }

  listConnections(): ConnectionView[] {
    return this.storedConnections().map((c) => this.viewConnection(c));
  }

  /** A connection as the providers need it, key included. */
  getConnectionConfig(id: string): ModelConfig | null {
    const c = this.storedConnections().find((x) => x.id === id);
    return c ? withEnvKey(c) : null;
  }

  /** The brain for a job: "chat" for conversations, "background" for quiet work. */
  getModelConfig(role: keyof Brains = 'chat'): ModelConfig | null {
    const id = this.getBrains()[role];
    return id ? this.getConnectionConfig(id) : null;
  }

  addConnection(input: ConnectionInput): ConnectionView {
    const list = this.storedConnections();
    const c: StoredConnection = {
      id: newId(),
      label: input.label?.trim() || defaultLabel(input.provider, input.preset ?? null),
      provider: input.provider,
      preset: input.preset ?? null,
      baseUrl: (input.baseUrl ?? '').trim().replace(/\/+$/, ''),
      model: (input.model ?? '').trim(),
      effort: input.effort ?? 'auto',
      apiKey: input.apiKey ?? '',
    };
    this.saveConnections([...list, c]);
    // The first brain does everything until there is a second.
    if (list.length === 0) this.writeSetting('brains', { chat: c.id, background: c.id });
    return this.viewConnection(c);
  }

  updateConnection(id: string, patch: Partial<ConnectionInput>): ConnectionView {
    const list = this.storedConnections();
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) throw new NotFound('Connection');
    const current = list[i]!;
    const { apiKey, ...rest } = patch;
    const next: StoredConnection = { ...current, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
    next.baseUrl = next.baseUrl.trim().replace(/\/+$/, '');
    next.model = next.model.trim();
    next.label = next.label.trim() || defaultLabel(next.provider, next.preset);
    // A key must never follow a change of provider or endpoint to a different host.
    if (apiKey !== undefined) next.apiKey = apiKey ?? '';
    else if (next.provider !== current.provider || next.baseUrl !== current.baseUrl.trim().replace(/\/+$/, '')) next.apiKey = '';
    list[i] = next;
    this.saveConnections(list);
    return this.viewConnection(next);
  }

  removeConnection(id: string): void {
    const list = this.storedConnections();
    if (!list.some((c) => c.id === id)) throw new NotFound('Connection');
    const brains = this.getBrains();
    this.saveConnections(list.filter((c) => c.id !== id));
    this.run('UPDATE conversations SET connection_id = NULL WHERE connection_id = ?', id);
    this.writeSetting('brains', {
      chat: brains.chat === id ? null : brains.chat,
      background: brains.background === id ? null : brains.background,
    });
  }

  getSettings(): Settings {
    const brains = this.getBrains();
    const connections = this.listConnections();
    const chat = connections.find((c) => c.id === brains.chat);
    return {
      profile: this.getProfile(),
      model: chat
        ? { provider: chat.provider, preset: chat.preset, baseUrl: chat.baseUrl, model: chat.model, effort: chat.effort, hasApiKey: chat.hasApiKey, apiKeyHint: chat.apiKeyHint }
        : { provider: null, preset: null, baseUrl: '', model: '', effort: 'auto', hasApiKey: false, apiKeyHint: '' },
      connections,
      brains,
    };
  }

  updateSettings(update: SettingsUpdate): Settings {
    if (update.profile) {
      const next = { ...this.getProfile(), ...update.profile };
      next.agentName = next.agentName.trim() || DEFAULT_PROFILE.agentName;
      next.userName = next.userName.trim();
      this.writeSetting('profile', next);
    }
    if (update.model) {
      // Older clients edit "the model": that is the chat brain.
      const { provider, ...rest } = update.model;
      const chat = this.getBrains().chat;
      if (provider === null) {
        if (chat) this.removeConnection(chat);
      } else if (chat) {
        this.updateConnection(chat, { ...rest, ...(provider ? { provider } : {}) });
      } else if (provider) {
        this.addConnection({ ...rest, provider });
      }
    }
    return this.getSettings();
  }

  /** First-run setup: names plus the chosen spheres. */
  onboard(input: { userName: string; agentName: string; sphereKeys: string[] }): Settings {
    this.tx(() => {
      const existing = new Set(this.all('SELECT key FROM spheres WHERE key IS NOT NULL').map((r) => r.key as string));
      for (const key of input.sphereKeys) {
        if (CATALOG_BY_KEY[key] && !existing.has(key)) this.createSphere({ key });
      }
    });
    return this.updateSettings({ profile: { userName: input.userName, agentName: input.agentName, onboarded: true } });
  }

  // ── Conversations ─────────────────────────────────────────────────────────

  createConversation(title: string, systemPrompt: string, connectionId: string | null = null): string {
    const id = newId();
    const now = nowIso();
    this.run(
      'INSERT INTO conversations (id, title, system_prompt, created_at, updated_at, connection_id) VALUES (?,?,?,?,?,?)',
      id,
      title,
      systemPrompt,
      now,
      now,
      connectionId,
    );
    return id;
  }

  getConversationConnection(id: string): string | null {
    const r = this.get('SELECT connection_id FROM conversations WHERE id = ?', id);
    if (!r) throw new NotFound('Conversation');
    return r.connection_id;
  }

  setConversationConnection(id: string, connectionId: string | null): void {
    if (connectionId && !this.getConnectionConfig(connectionId)) throw new NotFound('Connection');
    this.getConversationConnection(id);
    this.run('UPDATE conversations SET connection_id = ? WHERE id = ?', connectionId, id);
  }

  getConversationSystem(id: string): string {
    const r = this.get('SELECT system_prompt FROM conversations WHERE id = ?', id);
    if (!r) throw new NotFound('Conversation');
    return r.system_prompt;
  }

  appendTurn(conversationId: string, turn: Turn): void {
    const now = nowIso();
    this.run('INSERT INTO messages (conversation_id, turn, created_at) VALUES (?,?,?)', conversationId, JSON.stringify(turn), now);
    this.run('UPDATE conversations SET updated_at = ? WHERE id = ?', now, conversationId);
  }

  getTurns(conversationId: string): Turn[] {
    return this.all('SELECT turn FROM messages WHERE conversation_id = ? ORDER BY id', conversationId).map(
      (r) => JSON.parse(r.turn) as Turn,
    );
  }

  listConversations(limit = 30): ConversationSummary[] {
    return this.all('SELECT id, title, updated_at, connection_id FROM conversations ORDER BY updated_at DESC LIMIT ?', limit).map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at,
      connectionId: r.connection_id,
    }));
  }

  getConversation(id: string): Conversation {
    const r = this.get('SELECT id, title, updated_at, connection_id FROM conversations WHERE id = ?', id);
    if (!r) throw new NotFound('Conversation');
    return { id: r.id, title: r.title, updatedAt: r.updated_at, connectionId: r.connection_id, messages: this.viewTurns(this.getTurns(id)) };
  }

  deleteConversation(id: string): void {
    this.run('DELETE FROM conversations WHERE id = ?', id);
  }

  /** Fold the model-facing turns into what a person sees: one reply per question. */
  viewTurns(turns: Turn[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    let reply: ChatMessage | null = null;
    const calls = new Map<string, ToolCallView>();
    for (const turn of turns) {
      if (turn.role === 'user') {
        out.push({ role: 'user', parts: [{ type: 'text', text: turn.display }] });
        reply = null;
      } else if (turn.role === 'assistant') {
        if (!reply) {
          reply = { role: 'assistant', parts: [] };
          out.push(reply);
        }
        if (turn.text.trim()) reply.parts.push({ type: 'text', text: turn.text.trim() });
        for (const call of turn.toolCalls) {
          const view: ToolCallView = { id: call.id, name: call.name, input: call.input };
          calls.set(call.id, view);
          reply.parts.push({ type: 'tool', call: view });
        }
      } else {
        for (const result of turn.results) {
          const view = calls.get(result.toolCallId);
          if (!view) continue;
          view.ok = !result.isError;
          view.summary = result.summary;
          view.activityId = result.activityId;
          view.undoable = result.activityId !== null && (this.getActivity(result.activityId)?.undoable ?? false);
        }
      }
    }
    return out;
  }

  // ── Export / import ───────────────────────────────────────────────────────

  private static dataTables(): string[] {
    return [...Store.CORE_TABLES, ...FEATURE_TABLES];
  }

  private static readonly CORE_TABLES = [
    'spheres',
    'metrics',
    'metric_entries',
    'goals',
    'milestones',
    'projects',
    'tasks',
    'habits',
    'habit_logs',
    'notes',
    'memories',
    'screenings',
    'activity',
    'conversations',
    'messages',
  ] as const;

  /** Everything you own, as plain JSON. API keys and login sessions stay out. */
  exportAll(): { format: 'terminus'; version: 1; exportedAt: string; profile: Profile; tables: Record<string, Row[]> } {
    const tables: Record<string, Row[]> = {};
    for (const t of Store.dataTables()) tables[t] = this.all(`SELECT * FROM ${t}`).map((r) => ({ ...r }));
    return { format: 'terminus', version: 1, exportedAt: nowIso(), profile: this.getProfile(), tables };
  }

  /** Replace all data with an export. All-or-nothing. */
  importAll(dump: unknown): void {
    const d = dump as { format?: string; version?: number; profile?: Profile; tables?: Record<string, Row[]> };
    // 'lifeos' is the format name from before the rename.
    if ((d?.format !== 'terminus' && d?.format !== 'lifeos') || d.version !== 1 || typeof d.tables !== 'object' || d.tables === null) {
      throw new Invalid('That file is not a Terminus export');
    }
    const tables = d.tables;
    // A damaged or hand-edited file must not wipe everything and report success.
    for (const [t, rows] of Object.entries(tables)) if (!Array.isArray(rows)) throw new Invalid(`That export is damaged (${t} is not a list)`);
    if (!Array.isArray(tables.spheres) || tables.spheres.length === 0) throw new Invalid('That export has no spheres in it, so nothing was changed');
    this.tx(() => {
      // Rows arrive table by table, and core rows can point at feature rows (a to-do at its trip):
      // check references once everything is in, at commit.
      this.db.exec('PRAGMA defer_foreign_keys = ON');
      for (const t of [...Store.dataTables()].reverse()) this.run(`DELETE FROM ${t}`);
      for (const t of Store.dataTables()) {
        const columns = new Set(this.all(`PRAGMA table_info(${t})`).map((c) => c.name as string));
        for (const row of tables[t] ?? []) {
          const keys = Object.keys(row).filter((k) => columns.has(k));
          if (keys.length === 0) continue;
          try {
            this.run(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => toSql(row[k])));
          } catch (err) {
            throw new Invalid(`That export could not be read (${t}: ${err instanceof Error ? err.message : String(err)}). Nothing was changed.`);
          }
        }
      }
      if (d.profile) this.writeSetting('profile', { ...DEFAULT_PROFILE, ...d.profile });
      // Brains are not exported, so an id from the exporting install means nothing here:
      // those conversations go back to the chat brain.
      const brains = this.storedConnections().map((c) => c.id);
      this.run(
        `UPDATE conversations SET connection_id = NULL WHERE connection_id IS NOT NULL AND connection_id NOT IN (${brains.map(() => '?').join(', ')})`,
        ...brains,
      );
      const broken = this.all('PRAGMA foreign_key_check')[0];
      if (broken) throw new Invalid(`That export could not be read (${broken.table}: a row points at something that is not there). Nothing was changed.`);
    });
  }
}

function toSql(v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return Number(v);
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  return JSON.stringify(v);
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function likePattern(q: string): string {
  return `%${likeEscape(q.trim())}%`;
}

function snippet(text: string, q: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return flat.slice(0, 90);
  const start = Math.max(0, at - 30);
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + 110)}`;
}
