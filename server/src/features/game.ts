// The game plan: the life you refuse (anti-vision), the one you are building (vision), a
// one-year mission, this month's project, today's quests, and the rules you won't break; plus
// the one-day reset that produces them, and questions through the day to break autopilot.

import { z } from 'zod';
import { registerSnapshotSection } from '../agent/snapshot-hooks.ts';
import { tool } from '../agent/tools.ts';
import { read, today as todayOf } from '../http.ts';
import { addDays, Invalid, localDate, newId, nowIso, registerUndo, type Store } from '../store.ts';
import { DAY_PROMPTS, RESET_SECTIONS, SYNTHESIS_TO_PLAN, WEEKLY_STEER, type DayPrompt } from '../../../shared/game.ts';
import type { GamePlan, GameState, Quest, ResetDay } from '../../../shared/types.ts';
import { updateIntegration } from './integrations.ts';
import { pushAll } from './journey.ts';
import { registerFeature } from './registry.ts';

const EMPTY: GamePlan = {
  antiVision: '',
  vision: '',
  identity: '',
  enemy: '',
  mission: { text: '', by: null },
  project: { text: '', by: null },
  levers: [],
  rules: [],
  updatedAt: null,
};

const QUESTION_IDS = new Set(RESET_SECTIONS.flatMap((s) => s.questions.map((q) => q.id)));
const PROMPT_IDS = new Set([...DAY_PROMPTS.map((p) => p.id), WEEKLY_STEER.id]);

// ── Storage ─────────────────────────────────────────────────────────────────

const JOB = 'game-prompts';
/** The timed questions run once there is something to ask about. */
function enablePrompts(store: Store): void {
  updateIntegration(store, JOB, (r) => {
    r.enabled = true;
  });
}

function get<T>(store: Store, key: string): T | undefined {
  const r = store.db.prepare('SELECT value FROM game_state WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as T) : undefined;
}
function put(store: Store, key: string, value: unknown): void {
  store.db
    .prepare('INSERT INTO game_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), nowIso());
}

export function gamePlan(store: Store): GamePlan {
  const p = get<Partial<GamePlan>>(store, 'plan') ?? {};
  return { ...EMPTY, ...p, mission: { ...EMPTY.mission, ...p.mission }, project: { ...EMPTY.project, ...p.project } };
}

const isPlanEmpty = (p: GamePlan) => !p.vision && !p.antiVision && !p.mission.text && !p.project.text;

const clean = (s: string | undefined, max = 600) => (s ?? '').trim().slice(0, max);
const cleanList = (xs: string[] | undefined) => (xs ?? []).map((x) => clean(x, 200)).filter(Boolean).slice(0, 8);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const planPatch = z.object({
  antiVision: z.string().max(600).optional(),
  vision: z.string().max(600).optional(),
  identity: z.string().max(400).optional(),
  enemy: z.string().max(400).optional(),
  mission: z.object({ text: z.string().max(400), by: day.nullable().optional() }).optional(),
  project: z.object({ text: z.string().max(400), by: day.nullable().optional() }).optional(),
  levers: z.array(z.string().max(200)).max(8).optional(),
  rules: z.array(z.string().max(200)).max(8).optional(),
});
export type PlanPatch = z.infer<typeof planPatch>;

/** Change parts of the game plan. The previous plan is kept so the change can be undone. */
export function updatePlan(store: Store, patch: PlanPatch, summary = 'Updated the game plan'): GamePlan {
  const before = gamePlan(store);
  const next: GamePlan = {
    antiVision: patch.antiVision !== undefined ? clean(patch.antiVision) : before.antiVision,
    vision: patch.vision !== undefined ? clean(patch.vision) : before.vision,
    identity: patch.identity !== undefined ? clean(patch.identity, 400) : before.identity,
    enemy: patch.enemy !== undefined ? clean(patch.enemy, 400) : before.enemy,
    mission: patch.mission ? { text: clean(patch.mission.text, 400), by: patch.mission.by ?? null } : before.mission,
    project: patch.project ? { text: clean(patch.project.text, 400), by: patch.project.by ?? null } : before.project,
    levers: patch.levers ? cleanList(patch.levers) : before.levers,
    rules: patch.rules ? cleanList(patch.rules) : before.rules,
    updatedAt: nowIso(),
  };
  put(store, 'plan', next);
  enablePrompts(store);
  const id = store.record('updated', 'game_plan', 'plan', null, summary);
  store.db.prepare('UPDATE activity SET undo_data = ? WHERE id = ?').run(JSON.stringify({ before }), id);
  return next;
}

registerUndo('updated:game_plan', (db) => {
  const a = db.prepare("SELECT undo_data FROM activity WHERE verb = 'updated' AND entity_type = 'game_plan' AND undone = 0 ORDER BY id DESC LIMIT 1").get() as { undo_data: string | null } | undefined;
  const before = a?.undo_data ? (JSON.parse(a.undo_data) as { before: GamePlan }).before : null;
  if (before) db.prepare("UPDATE game_state SET value = ?, updated_at = ? WHERE key = 'plan'").run(JSON.stringify(before), nowIso());
});

// ── Quests ──────────────────────────────────────────────────────────────────

export function quests(store: Store, date: string): Quest[] {
  return get<Quest[]>(store, `quests:${date}`) ?? [];
}

const questInput = z.object({ title: z.string().min(1).max(160), time: z.string().regex(/^(\d{2}:\d{2})?$/).optional() });

/** Set the day's quests (two or three is the point; five at most). */
export function setQuests(store: Store, date: string, items: { title: string; time?: string }[]): Quest[] {
  if (items.length > 5) throw new Invalid('Keep it to two or three quests, five at most');
  const before = quests(store, date);
  const kept = new Map(before.map((q) => [q.title.toLowerCase(), q]));
  const next = items
    .map((i) => ({ title: clean(i.title, 160), time: i.time ?? '' }))
    .filter((i) => i.title)
    .map((i) => ({ id: kept.get(i.title.toLowerCase())?.id ?? newId(), title: i.title, time: i.time, done: kept.get(i.title.toLowerCase())?.done ?? false }))
    .sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  put(store, `quests:${date}`, next);
  const id = store.record('updated', 'quests', date, null, `Set ${next.length === 1 ? 'a quest' : `${next.length} quests`} for ${date}`);
  store.db.prepare('UPDATE activity SET undo_data = ? WHERE id = ?').run(JSON.stringify({ before }), id);
  return next;
}

registerUndo('updated:quests', (db, date) => {
  const a = db.prepare("SELECT undo_data FROM activity WHERE verb = 'updated' AND entity_type = 'quests' AND entity_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1").get(date) as { undo_data: string | null } | undefined;
  const before = a?.undo_data ? (JSON.parse(a.undo_data) as { before: Quest[] }).before : null;
  if (before) db.prepare('UPDATE game_state SET value = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(before), nowIso(), `quests:${date}`);
});

export function toggleQuest(store: Store, date: string, id: string): Quest[] {
  const list = quests(store, date).map((q) => (q.id === id ? { ...q, done: !q.done } : q));
  put(store, `quests:${date}`, list);
  return list;
}

// ── The one-day reset ───────────────────────────────────────────────────────

export function resetDay(store: Store): ResetDay | null {
  return get<ResetDay>(store, 'reset') ?? null;
}

export function startReset(store: Store, date: string): ResetDay {
  const cur = resetDay(store);
  if (cur && cur.date === date && !cur.finishedAt) return cur;
  // Keep the previous reset's answers, so a year from now you can read what you wrote.
  if (cur) put(store, `reset:${cur.date}`, cur);
  const r: ResetDay = { date, answers: {}, finishedAt: null };
  put(store, 'reset', r);
  enablePrompts(store);
  store.record('created', 'reset_day', date, null, 'Started a reset day');
  return r;
}

export function answerReset(store: Store, id: string, text: string): ResetDay {
  if (!QUESTION_IDS.has(id) && !PROMPT_IDS.has(id)) throw new Invalid('Unknown question');
  const r = resetDay(store);
  if (!r) throw new Invalid('Start a reset day first');
  const answers = { ...r.answers };
  if (text.trim()) answers[id] = text.slice(0, 4000);
  else delete answers[id];
  const next = { ...r, answers };
  put(store, 'reset', next);
  return next;
}

/** Turn the evening answers into the game plan, and the "tomorrow" answer into tomorrow's quests. */
export function finishReset(store: Store, date: string): { plan: GamePlan; reset: ResetDay } {
  const r = resetDay(store);
  if (!r) throw new Invalid('Start a reset day first');
  const a = r.answers;
  const lines = (s: string | undefined) =>
    (s ?? '')
      .split(/\n|;|•/)
      .map((x) => x.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
      .filter(Boolean);
  const patch: PlanPatch = {};
  for (const [qid, field] of Object.entries(SYNTHESIS_TO_PLAN)) {
    const v = a[qid]?.trim();
    if (!v) continue;
    if (field === 'mission') patch.mission = { text: v, by: addDays(r.date, 365) };
    else if (field === 'project') patch.project = { text: v, by: addDays(r.date, 30) };
    else if (field === 'rules') patch.rules = lines(v);
    else patch[field] = v;
  }
  const plan = Object.keys(patch).length ? updatePlan(store, patch, 'Turned the reset day into a game plan') : gamePlan(store);
  const tomorrow = lines(a.tomorrow).slice(0, 3);
  if (tomorrow.length) setQuests(store, addDays(date, 1), tomorrow.map((title) => ({ title })));
  const reset = { ...r, finishedAt: nowIso() };
  put(store, 'reset', reset);
  return { plan, reset };
}

// ── Questions through the day ───────────────────────────────────────────────

type Prompts = GameState['prompts'];
export function promptSettings(store: Store): Prompts {
  return { daily: false, weekly: true, ...get<Partial<Prompts>>(store, 'prompts') };
}

/** Today's answers to the timed questions. */
function answered(store: Store, date: string): Record<string, string> {
  return get<Record<string, string>>(store, `answers:${date}`) ?? {};
}

/** Keep an answer to a timed question; on a reset day it joins the reset's answers too. */
export function answerPrompt(store: Store, date: string, id: string, text: string): Record<string, string> {
  if (!PROMPT_IDS.has(id)) throw new Invalid('Unknown question');
  const all = { ...answered(store, date) };
  if (text.trim()) all[id] = text.slice(0, 2000);
  else delete all[id];
  put(store, `answers:${date}`, all);
  const r = resetDay(store);
  if (r && r.date === date && !r.finishedAt) answerReset(store, id, text);
  return all;
}

/** The questions that apply on a date: all of them on a reset day, a few on ordinary days if asked for. */
export function promptsFor(store: Store, date: string): DayPrompt[] {
  const r = resetDay(store);
  if (r && r.date === date && !r.finishedAt) return DAY_PROMPTS;
  const s = promptSettings(store);
  const out = s.daily ? DAY_PROMPTS.filter((p) => p.daily) : [];
  if (s.weekly && new Date(`${date}T12:00:00Z`).getUTCDay() === 0) out.push(WEEKLY_STEER);
  return out;
}

const hhmm = (d: Date, tz: string | null) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(tz ? { timeZone: tz } : {}) }).format(d);
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Send the questions that are due now: each once a day, and only within 30 minutes of its time. */
export async function sendDuePrompts(store: Store, now: Date = new Date()): Promise<string[]> {
  const tz = store.zone();
  const date = tz ? new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now) : localDate(now);
  const nowMin = toMin(hhmm(now, tz));
  const sentKey = `sent:${date}`;
  const sent = new Set(get<string[]>(store, sentKey) ?? []);
  const due = promptsFor(store, date).filter((p) => !sent.has(p.id) && nowMin >= toMin(p.at) && nowMin - toMin(p.at) <= 30);
  for (const p of due) {
    await pushAll(store, { title: p.id === WEEKLY_STEER.id ? 'Weekly steer' : 'Pause', body: p.text, url: `/game?q=${p.id}`, tag: `game-${p.id}` });
    sent.add(p.id);
  }
  if (due.length) put(store, sentKey, [...sent]);
  return due.map((p) => p.id);
}

// ── State ───────────────────────────────────────────────────────────────────

export function gameState(store: Store, date: string): GameState {
  const pushes = (store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'push_subscriptions'").get() as { n: number }).n
    ? (store.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }).n
    : 0;
  return { date, plan: gamePlan(store), quests: quests(store, date), reset: resetDay(store), prompts: promptSettings(store), push: pushes > 0, answered: answered(store, date) };
}

registerSnapshotSection<Store>('Game plan', (store, today) => {
  const p = gamePlan(store);
  const q = quests(store, today);
  const r = resetDay(store);
  if (isPlanEmpty(p) && !q.length && !r) return null;
  const lines: string[] = [];
  if (p.vision) lines.push(`Vision (how they win): ${p.vision}`);
  if (p.antiVision) lines.push(`Anti-vision (what is at stake): ${p.antiVision}`);
  if (p.identity) lines.push(`Identity they are growing into: ${p.identity}`);
  if (p.enemy) lines.push(`The pattern to beat: ${p.enemy}`);
  if (p.mission.text) lines.push(`One-year mission${p.mission.by ? ` (by ${p.mission.by})` : ''}: ${p.mission.text}`);
  if (p.project.text) lines.push(`This month's project, the boss fight${p.project.by ? ` (by ${p.project.by})` : ''}: ${p.project.text}`);
  if (p.levers.length) lines.push(`Daily levers: ${p.levers.join('; ')}`);
  if (p.rules.length) lines.push(`Rules they won't break: ${p.rules.join('; ')}`);
  lines.push(q.length ? `Today's quests: ${q.map((x) => `${x.time ? `${x.time} ` : ''}${x.title}${x.done ? ' (done)' : ''}`).join('; ')}` : "Today's quests: none set yet");
  if (r && !r.finishedAt) lines.push(`A reset day is under way (${r.date}), ${Object.keys(r.answers).length} answers written. Do not answer its questions for them.`);
  return lines.join('\n');
});

// ── Feature ─────────────────────────────────────────────────────────────────

registerFeature({
  id: 'game',
  tables: ['game_state'],
  jobs: [{ id: JOB, everyMs: 60_000, run: async (store) => void (await sendDuePrompts(store)) }],
  tools: [
    tool(
      'get_game_plan',
      "Read the game plan: anti-vision, vision, identity, the pattern to beat, the one-year mission, this month's project, daily levers, rules, today's quests, and any reset day in progress.",
      z.object({}),
      (_i, { store, today }) => ({ data: gameState(store, today), summary: 'Read the game plan' }),
    ),
    tool(
      'update_game_plan',
      'Change parts of the game plan. Only after the user has agreed to the exact wording: these are their words about their own life. Undoable.',
      planPatch,
      (patch, { store }) => {
        const plan = updatePlan(store, patch);
        return { data: plan, summary: 'Updated the game plan' };
      },
    ),
    tool(
      'set_quests',
      "Set a day's quests: two or three needle-moving actions, each with an optional HH:MM time block. Replaces that day's list. Undoable.",
      z.object({ date: day.optional(), quests: z.array(questInput).min(1).max(5) }),
      ({ date, quests: items }, { store, today }) => {
        const d = date ?? today;
        const list = setQuests(store, d, items);
        return { data: list, summary: `Set ${list.length === 1 ? 'a quest' : `${list.length} quests`} for ${d === today ? 'today' : d}` };
      },
    ),
  ],
  routes: (app, { store }) => {
    app.get('/api/game', (c) => c.json(gameState(store, todayOf(c))));
    app.put('/api/game/plan', async (c) => {
      updatePlan(store, await read(c, planPatch));
      return c.json(gameState(store, todayOf(c)));
    });
    app.put('/api/game/quests', async (c) => {
      const body = await read(c, z.object({ date: day.optional(), quests: z.array(questInput).max(5) }));
      setQuests(store, body.date ?? todayOf(c), body.quests);
      return c.json(gameState(store, todayOf(c)));
    });
    app.post('/api/game/quests/:id/toggle', (c) => {
      toggleQuest(store, todayOf(c), c.req.param('id'));
      return c.json(gameState(store, todayOf(c)));
    });
    app.post('/api/game/reset', (c) => {
      startReset(store, todayOf(c));
      return c.json(gameState(store, todayOf(c)), 201);
    });
    app.put('/api/game/reset/answers/:id', async (c) => {
      const { text } = await read(c, z.object({ text: z.string().max(4000) }));
      answerReset(store, c.req.param('id'), text);
      return c.json(gameState(store, todayOf(c)));
    });
    app.post('/api/game/reset/finish', (c) => {
      finishReset(store, todayOf(c));
      return c.json(gameState(store, todayOf(c)));
    });
    app.put('/api/game/prompts/:id', async (c) => {
      const { text } = await read(c, z.object({ text: z.string().max(2000) }));
      answerPrompt(store, todayOf(c), c.req.param('id'), text);
      return c.json(gameState(store, todayOf(c)));
    });
    app.put('/api/game/prompt-settings', async (c) => {
      const body = await read(c, z.object({ daily: z.boolean().optional(), weekly: z.boolean().optional() }));
      put(store, 'prompts', { ...promptSettings(store), ...body });
      enablePrompts(store);
      return c.json(gameState(store, todayOf(c)));
    });
  },
});
