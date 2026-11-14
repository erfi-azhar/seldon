// Gravl → Health. While Gravl is connected over MCP, Terminus regularly reads your
// recent workouts, food log and body measurements and files them into the Health
// panels, so everything shows in one place. Gravl's tools answer in prose, so the
// background brain turns each answer into rows; rows are imported once each.

import { z } from 'zod';
import { NoBrain, think, wrapUntrusted } from '../agent/think.ts';
import { addDays, Invalid, localDate, type Store } from '../store.ts';
import type { Workout } from '../../../shared/types.ts';
import { logBody, logFood, logWorkout } from './health.ts';
import { getIntegration, updateIntegration } from './integrations.ts';
import { callTool } from './mcp.ts';
import { registerFeature } from './registry.ts';

const SERVER = 'mcp:gravl';
const ID = 'gravl';

const Rows = z.object({
  food: z.array(
    z.object({
      external_id: z.string().nullable(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
      name: z.string().max(120),
      amount: z.string().max(60).nullable(),
      kcal: z.number().min(0),
      protein: z.number().min(0).nullable(),
      carbs: z.number().min(0).nullable(),
      fat: z.number().min(0).nullable(),
    }),
  ),
  workouts: z.array(
    z.object({
      external_id: z.string().nullable(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      name: z.string().max(120),
      type: z.enum(['strength', 'run', 'walk', 'cycle', 'swim', 'cardio', 'mobility', 'sport', 'other']),
      duration_min: z.number().nullable(),
      distance_km: z.number().nullable(),
      kcal: z.number().nullable(),
      exercises: z.array(z.object({ name: z.string(), sets: z.array(z.object({ reps: z.number().nullable(), weight: z.number().nullable() })) })),
    }),
  ),
  body: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      weight_kg: z.number().nullable(),
      body_fat_pct: z.number().nullable(),
      muscle_kg: z.number().nullable(),
    }),
  ),
});

export async function syncGravl(store: Store, today = localDate()): Promise<{ food: number; workouts: number; body: number }> {
  const server = getIntegration(store, SERVER);
  if (server.settings.status !== 'connected') throw new Invalid('Connect Gravl first (Settings → Connections).');

  const read = async (tool: string, args: Record<string, unknown>) => {
    try {
      return await callTool(store, SERVER, tool, args);
    } catch (err) {
      return `(could not read ${tool}: ${err instanceof Error ? err.message : String(err)})`;
    }
  };
  const [foodToday, foodYesterday, workouts, body] = await Promise.all([
    read('get_food_log', { date: today, today }),
    read('get_food_log', { date: addDays(today, -1), today }),
    read('list_workouts', { from: `${addDays(today, -14)}T00:00:00Z` }),
    read('get_body_metrics', { from: addDays(today, -30), to: today, today }),
  ]);

  let rows: z.infer<typeof Rows>;
  try {
    rows = await think({
      store,
      task: `These are answers from the user's Gravl account (a workout and nutrition app). Turn them into rows for import. Today is ${today}.
Return {"food": [one row per logged food entry: external_id (Gravl's entry id, or null), date, time (HH:MM or null), name, amount, kcal, protein, carbs, fat in grams],
"workouts": [one row per completed workout: external_id (Gravl's workout id, or null), date, name, type (strength|run|walk|cycle|swim|cardio|mobility|sport|other), duration_min, distance_km, kcal, exercises with sets of reps and weight in kg],
"body": [one row per day with a weigh-in or measurement: date, weight_kg, body_fat_pct, muscle_kg]}.
Only include what the answers state; never invent entries. Use [] when a section has nothing.`,
      input: [
        wrapUntrusted('gravl get_food_log today', foodToday, 8000),
        wrapUntrusted('gravl get_food_log yesterday', foodYesterday, 8000),
        wrapUntrusted('gravl list_workouts', workouts, 10_000),
        wrapUntrusted('gravl get_body_metrics', body, 6000),
      ].join('\n\n'),
      schema: Rows,
    });
  } catch (err) {
    if (err instanceof NoBrain) throw new Invalid('Syncing Gravl needs a background brain (Settings → Brains).');
    throw err;
  }

  let food = 0;
  for (const f of rows.food) {
    const key = f.external_id ?? `${f.date}|${f.time ?? ''}|${f.name}|${Math.round(f.kcal)}`;
    food += logFood(store, f.date, f.time ?? '12:00', [{ name: f.name, amount: f.amount ?? '', kcal: f.kcal, protein: f.protein ?? 0, carbs: f.carbs ?? 0, fat: f.fat ?? 0 }], 'gravl', key, true).length;
  }
  let w = 0;
  for (const x of rows.workouts) {
    const key = x.external_id ?? `${x.date}|${x.name}`;
    const workout: Omit<Workout, 'id' | 'source'> = { date: x.date, name: x.name, type: x.type, durationMin: x.duration_min, distanceKm: x.distance_km, kcal: x.kcal, notes: '', exercises: x.exercises };
    if (logWorkout(store, workout, 'gravl', key, true)) w++;
  }
  let b = 0;
  for (const r of rows.body) {
    if (r.weight_kg === null && r.body_fat_pct === null && r.muscle_kg === null) continue;
    if (logBody(store, { date: r.date, weightKg: r.weight_kg, bodyFatPct: r.body_fat_pct, muscleKg: r.muscle_kg, visceralFat: null, waterPct: null, bmr: null }, 'gravl', r.date, true)) b++;
  }
  updateIntegration(store, ID, (rec) => (rec.state.last = { food, workouts: w, body: b }));
  return { food, workouts: w, body: b };
}

registerFeature({
  id: ID,
  integration: { configured: () => true },
  jobs: [{ id: ID, everyMs: 3 * 3_600_000, run: async (store) => void (await syncGravl(store)) }],
  routes: (app, { store, scheduler }) => {
    app.put('/api/integrations/gravl', async (c) => {
      const { enabled } = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
      updateIntegration(store, ID, (r) => (r.enabled = enabled !== false));
      if (enabled !== false) void scheduler.runNow(ID).catch(() => undefined);
      return c.json({ ok: true });
    });
    app.get('/api/integrations/gravl', (c) => {
      const rec = getIntegration(store, ID);
      return c.json({ id: ID, enabled: rec.enabled, configured: true, settings: { last: rec.state.last ?? null }, lastRunAt: rec.lastRunAt, lastOkAt: rec.lastOkAt, lastError: rec.lastError, running: scheduler.isRunning(ID) });
    });
  },
});
