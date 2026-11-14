// Health: food (calories and macros against targets), workouts, and body-composition
// readings from a smart scale or an InBody scan. Seldon can log all three from a
// sentence or a photo; Gravl syncs into the same tables (see gravl.ts).

import { z } from 'zod';
import { NoBrain, think, wrapUntrusted } from '../agent/think.ts';
import { registerSnapshotSection } from '../agent/snapshot-hooks.ts';
import { tool } from '../agent/tools.ts';
import { read, today as todayOf } from '../http.ts';
import { addDays, Invalid, newId, NotFound, nowIso, registerUndo, type Store } from '../store.ts';
import type { BodyReading, FoodEntry, HealthState, Macros, Meal, NutritionTargets, Workout } from '../../../shared/types.ts';
import { registerFeature } from './registry.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const r1 = (n: number) => Math.round(n * 10) / 10;

const healthSphere = (store: Store) => store.listSpheres().find((s) => s.key === 'health') ?? null;

// ── Food ────────────────────────────────────────────────────────────────────

const foodFromRow = (r: Row): FoodEntry => ({
  id: r.id,
  date: r.date,
  time: r.time,
  meal: r.meal,
  name: r.name,
  amount: r.amount,
  kcal: r.kcal,
  protein: r.protein,
  carbs: r.carbs,
  fat: r.fat,
  source: r.source,
});

export function mealFor(time: string): Meal {
  const h = Number(time.slice(0, 2));
  return h < 11 ? 'breakfast' : h < 15 ? 'lunch' : h >= 17 && h < 22 ? 'dinner' : 'snack';
}

export interface FoodInput {
  name: string;
  amount?: string;
  kcal: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  meal?: Meal;
}

export function logFood(store: Store, date: string, time: string, items: FoodInput[], source = 'manual', externalId: string | null = null, quiet = false): FoodEntry[] {
  if (items.length === 0) throw new Invalid('Nothing to log');
  const sphere = healthSphere(store);
  const out: FoodEntry[] = [];
  for (const item of items) {
    if (externalId && store.db.prepare('SELECT 1 AS x FROM food_log WHERE source = ? AND external_id = ?').get(source, externalId)) continue;
    const id = newId();
    store.db
      .prepare('INSERT INTO food_log (id, date, time, meal, name, amount, kcal, protein, carbs, fat, source, external_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, date, time, item.meal ?? mealFor(time), item.name.trim().slice(0, 120), (item.amount ?? '').slice(0, 60), r1(item.kcal), r1(item.protein ?? 0), r1(item.carbs ?? 0), r1(item.fat ?? 0), source, externalId, nowIso());
    if (!quiet) store.record('created', 'food', id, sphere?.id ?? null, `Logged ${item.name} — ${Math.round(item.kcal)} kcal`);
    out.push(foodFromRow(store.db.prepare('SELECT * FROM food_log WHERE id = ?').get(id) as Row));
  }
  return out;
}

const totals = (entries: Macros[]): Macros =>
  entries.reduce((t, e) => ({ kcal: r1(t.kcal + e.kcal), protein: r1(t.protein + e.protein), carbs: r1(t.carbs + e.carbs), fat: r1(t.fat + e.fat) }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });

function getTargets(store: Store): NutritionTargets {
  const r = store.db.prepare("SELECT value FROM settings WHERE key = 'nutrition_targets'").get() as { value: string } | undefined;
  return { kcal: null, protein: null, carbs: null, fat: null, ...(r ? (JSON.parse(r.value) as Partial<NutritionTargets>) : {}) };
}

function setTargets(store: Store, t: Partial<NutritionTargets>): NutritionTargets {
  const next = { ...getTargets(store), ...t };
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('nutrition_targets', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  return next;
}

const Estimate = z.object({
  items: z.array(
    z.object({
      name: z.string().max(120),
      amount: z.string().max(60),
      kcal: z.number().min(0).max(5000),
      protein: z.number().min(0).max(500),
      carbs: z.number().min(0).max(1000),
      fat: z.number().min(0).max(500),
    }),
  ),
});

/** Turn "two eggs and toast" (or a photo of a plate) into entries, via the background brain. */
export async function estimateFood(store: Store, text: string, image?: { data: Buffer; mime: string }): Promise<FoodInput[]> {
  const res = await think({
    store,
    task: `Estimate the calories and macros (grams of protein, carbs, fat) of this food, split into separate items. Use typical portions where none are given, and Singapore/Southeast Asian portion norms for local dishes. Reply {"items": [{"name", "amount" (e.g. "1 plate", "2 eggs"), "kcal", "protein", "carbs", "fat"}]}.`,
    input: wrapUntrusted('food description', text || 'See the photo.', 2000),
    images: image ? [{ mediaType: image.mime, data: image.data.toString('base64') }] : undefined,
    schema: Estimate,
  });
  return res.items;
}

// ── Workouts ────────────────────────────────────────────────────────────────

const workoutFromRow = (r: Row): Workout => ({
  id: r.id,
  date: r.date,
  name: r.name,
  type: r.type,
  durationMin: r.duration_min,
  distanceKm: r.distance_km,
  kcal: r.kcal,
  notes: r.notes,
  exercises: JSON.parse(r.exercises),
  source: r.source,
});

export function logWorkout(store: Store, w: Omit<Workout, 'id' | 'source'>, source = 'manual', externalId: string | null = null, quiet = false): Workout | null {
  if (externalId) {
    const existing = store.db.prepare('SELECT * FROM workouts WHERE source = ? AND external_id = ?').get(source, externalId) as Row | undefined;
    if (existing) return null;
  }
  const id = newId();
  store.db
    .prepare('INSERT INTO workouts (id, date, name, type, duration_min, distance_km, kcal, notes, exercises, source, external_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, w.date, w.name.slice(0, 120), w.type, w.durationMin, w.distanceKm, w.kcal, w.notes.slice(0, 2000), JSON.stringify(w.exercises.slice(0, 40)), source, externalId, nowIso());
  const sphere = healthSphere(store);
  const detail = [w.durationMin ? `${w.durationMin} min` : '', w.distanceKm ? `${w.distanceKm} km` : '', w.exercises.length ? `${w.exercises.length} exercises` : ''].filter(Boolean).join(', ');
  if (!quiet) store.record('created', 'workout', id, sphere?.id ?? null, `Workout: ${w.name}${detail ? ` (${detail})` : ''}`);
  return workoutFromRow(store.db.prepare('SELECT * FROM workouts WHERE id = ?').get(id) as Row);
}

// ── Body composition ────────────────────────────────────────────────────────

const bodyFromRow = (r: Row): BodyReading => ({
  id: r.id,
  date: r.date,
  weightKg: r.weight_kg,
  bodyFatPct: r.body_fat_pct,
  muscleKg: r.muscle_kg,
  visceralFat: r.visceral_fat,
  waterPct: r.water_pct,
  bmr: r.bmr,
  source: r.source,
  notes: r.notes,
});

export function logBody(store: Store, b: Omit<BodyReading, 'id' | 'source' | 'notes'> & { notes?: string }, source = 'manual', externalId: string | null = null, quiet = false): BodyReading | null {
  if ([b.weightKg, b.bodyFatPct, b.muscleKg, b.visceralFat, b.waterPct, b.bmr].every((v) => v === null || v === undefined)) throw new Invalid('Add at least one reading');
  if (externalId && store.db.prepare('SELECT 1 AS x FROM body_readings WHERE source = ? AND external_id = ?').get(source, externalId)) return null;
  const id = newId();
  store.db
    .prepare('INSERT INTO body_readings (id, date, weight_kg, body_fat_pct, muscle_kg, visceral_fat, water_pct, bmr, source, external_id, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, b.date, b.weightKg ?? null, b.bodyFatPct ?? null, b.muscleKg ?? null, b.visceralFat ?? null, b.waterPct ?? null, b.bmr ?? null, source, externalId, (b.notes ?? '').slice(0, 500), nowIso());
  const sphere = healthSphere(store);
  const parts = [b.weightKg != null ? `${b.weightKg} kg` : '', b.bodyFatPct != null ? `${b.bodyFatPct}% fat` : '', b.muscleKg != null ? `${b.muscleKg} kg muscle` : ''].filter(Boolean);
  if (!quiet) store.record('created', 'body_reading', id, sphere?.id ?? null, `Body composition: ${parts.join(', ') || 'new reading'}`);
  // Keep the Weight metric (and any goal it drives) in step.
  if (b.weightKg != null && sphere) {
    const weight = store.listMetrics(sphere.id).find((m) => /^(body )?weight$/i.test(m.name));
    if (weight) store.addMetricEntry(weight.id, { value: b.weightKg, date: b.date, note: 'from body composition' });
  }
  return bodyFromRow(store.db.prepare('SELECT * FROM body_readings WHERE id = ?').get(id) as Row);
}

const BodyScan = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  weight_kg: z.number().nullable(),
  body_fat_pct: z.number().nullable(),
  muscle_kg: z.number().nullable().describe('Skeletal muscle mass'),
  visceral_fat: z.number().nullable(),
  water_pct: z.number().nullable(),
  bmr: z.number().nullable(),
});

export async function readBodyScan(store: Store, image: { data: Buffer; mime: string }) {
  return think({
    store,
    task: 'Read this body-composition result (an InBody sheet, a smart-scale app screenshot or similar). Convert pounds to kilograms. Reply {"date": "YYYY-MM-DD" or null, "weight_kg", "body_fat_pct", "muscle_kg" (skeletal muscle mass), "visceral_fat" (level), "water_pct" (total body water as % of weight, or null), "bmr" (kcal)} using null for anything not shown.',
    input: 'The image is the only input.',
    images: [{ mediaType: image.mime, data: image.data.toString('base64') }],
    schema: BodyScan,
  });
}

// ── Reads ───────────────────────────────────────────────────────────────────

export function healthState(store: Store, date: string): HealthState {
  const entries = (store.db.prepare('SELECT * FROM food_log WHERE date = ? ORDER BY time, created_at').all(date) as Row[]).map(foodFromRow);
  const from = addDays(date, -13);
  const rows = store.db.prepare('SELECT date, SUM(kcal) AS kcal, SUM(protein) AS protein, SUM(carbs) AS carbs, SUM(fat) AS fat FROM food_log WHERE date >= ? AND date <= ? GROUP BY date').all(from, date) as Row[];
  const byDate = new Map(rows.map((r) => [r.date as string, r]));
  const days = Array.from({ length: 14 }, (_, i) => addDays(from, i)).map((d) => {
    const r = byDate.get(d);
    return { date: d, kcal: r1(r?.kcal ?? 0), protein: r1(r?.protein ?? 0), carbs: r1(r?.carbs ?? 0), fat: r1(r?.fat ?? 0) };
  });
  const workouts = (store.db.prepare('SELECT * FROM workouts ORDER BY date DESC, created_at DESC LIMIT 30').all() as Row[]).map(workoutFromRow);
  const thisWeek = workouts.filter((w) => w.date > addDays(date, -7) && w.date <= date);
  const body = (store.db.prepare('SELECT * FROM (SELECT * FROM body_readings ORDER BY date DESC, created_at DESC LIMIT 120) ORDER BY date, created_at').all() as Row[]).map(bodyFromRow);
  return {
    date,
    targets: getTargets(store),
    today: { entries, totals: totals(entries) },
    days,
    workouts,
    week: {
      sessions: thisWeek.length,
      minutes: thisWeek.reduce((n, w) => n + (w.durationMin ?? 0), 0),
      strength: thisWeek.filter((w) => w.type === 'strength').length,
      cardio: thisWeek.filter((w) => ['run', 'walk', 'cycle', 'swim', 'cardio'].includes(w.type)).length,
    },
    body,
  };
}

// ── Undo ────────────────────────────────────────────────────────────────────

registerUndo('created:food', (db, id) => void db.prepare('DELETE FROM food_log WHERE id = ?').run(id));
registerUndo('created:workout', (db, id) => void db.prepare('DELETE FROM workouts WHERE id = ?').run(id));
registerUndo('created:body_reading', (db, id) => void db.prepare('DELETE FROM body_readings WHERE id = ?').run(id));

// ── Agent ───────────────────────────────────────────────────────────────────

registerSnapshotSection<Store>('Nutrition and training', (store, today) => {
  const h = healthState(store, today);
  if (!h.today.entries.length && !h.workouts.length && !h.body.length && h.targets.kcal === null) return null;
  const t = h.targets;
  const lines = [
    `Eaten today: ${Math.round(h.today.totals.kcal)} kcal${t.kcal ? ` of ${t.kcal}` : ''}, protein ${h.today.totals.protein} g${t.protein ? ` of ${t.protein}` : ''}, carbs ${h.today.totals.carbs} g, fat ${h.today.totals.fat} g (${h.today.entries.length} items).`,
    `Training in the last 7 days: ${h.week.sessions} sessions, ${h.week.minutes} minutes.${h.workouts[0] ? ` Last: ${h.workouts[0].name} on ${h.workouts[0].date}.` : ''}`,
  ];
  const b = h.body.at(-1);
  if (b) lines.push(`Latest body composition (${b.date}): ${[b.weightKg && `${b.weightKg} kg`, b.bodyFatPct && `${b.bodyFatPct}% body fat`, b.muscleKg && `${b.muscleKg} kg skeletal muscle`].filter(Boolean).join(', ')}.`);
  return lines.join('\n');
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const meal = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);
const foodItem = z.object({
  name: z.string().min(1).max(120),
  amount: z.string().max(60).optional(),
  kcal: z.number().min(0).max(5000),
  protein: z.number().min(0).max(500).optional(),
  carbs: z.number().min(0).max(1000).optional(),
  fat: z.number().min(0).max(500).optional(),
  meal: meal.optional(),
});
const workoutInput = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['strength', 'run', 'walk', 'cycle', 'swim', 'cardio', 'mobility', 'sport', 'other']),
  duration_min: z.number().min(0).max(1440).nullable().optional(),
  distance_km: z.number().min(0).max(1000).nullable().optional(),
  kcal: z.number().min(0).max(10000).nullable().optional(),
  notes: z.string().max(2000).optional(),
  exercises: z.array(z.object({ name: z.string().max(120), sets: z.array(z.object({ reps: z.number().nullable(), weight: z.number().nullable() })).max(30) })).max(40).optional(),
  date: dateStr.optional(),
});
const bodyInput = z.object({
  weight_kg: z.number().min(20).max(400).nullable().optional(),
  body_fat_pct: z.number().min(1).max(75).nullable().optional(),
  muscle_kg: z.number().min(5).max(150).nullable().optional(),
  visceral_fat: z.number().min(0).max(60).nullable().optional(),
  water_pct: z.number().min(20).max(80).nullable().optional(),
  bmr: z.number().min(500).max(5000).nullable().optional(),
  date: dateStr.optional(),
  notes: z.string().max(500).optional(),
});
const toWorkout = (w: z.infer<typeof workoutInput>, today: string): Omit<Workout, 'id' | 'source'> => ({
  date: w.date ?? today,
  name: w.name,
  type: w.type,
  durationMin: w.duration_min ?? null,
  distanceKm: w.distance_km ?? null,
  kcal: w.kcal ?? null,
  notes: w.notes ?? '',
  exercises: w.exercises ?? [],
});
const toBody = (b: z.infer<typeof bodyInput>, today: string) => ({
  date: b.date ?? today,
  weightKg: b.weight_kg ?? null,
  bodyFatPct: b.body_fat_pct ?? null,
  muscleKg: b.muscle_kg ?? null,
  visceralFat: b.visceral_fat ?? null,
  waterPct: b.water_pct ?? null,
  bmr: b.bmr ?? null,
  notes: b.notes,
});
const nowHHMM = () => new Date().toTimeString().slice(0, 5);

async function imageFrom(form: FormData) {
  const f = form.get('file');
  if (!f || typeof f === 'string') throw new Invalid('Add a photo');
  if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) throw new Invalid('Photos must be PNG, JPEG, WebP or GIF');
  if (f.size > 5_000_000) throw new Invalid('That photo is too large (5 MB at most)');
  return { data: Buffer.from(await f.arrayBuffer()), mime: f.type };
}

registerFeature({
  id: 'health',
  tables: ['food_log', 'workouts', 'body_readings'],
  tools: [
    tool(
      'log_food',
      'Log food the user ate, with calories and macros. When they do not give numbers, estimate them yourself from typical portions (Singapore portions for local dishes) and say they are estimates. Split a meal into its items. Date defaults to today; time to now.',
      z.object({ items: z.array(foodItem).min(1).max(20), date: dateStr.optional(), time: z.string().regex(/^\d{2}:\d{2}$/).optional() }),
      ({ items, date, time }, { store, today }) => {
        const logged = logFood(store, date ?? today, time ?? nowHHMM(), items, 'seldon');
        const kcal = logged.reduce((n, e) => n + e.kcal, 0);
        return { data: { ok: true, logged: logged.length, kcal, day: healthState(store, date ?? today).today.totals }, summary: `Logged ${logged.map((e) => e.name).join(', ')} — ${Math.round(kcal)} kcal` };
      },
    ),
    tool(
      'log_workout',
      'Log a workout the user did: strength (with exercises and sets when they say them), a run, walk, ride, swim, class or sport. Date defaults to today.',
      workoutInput,
      (w, { store, today }) => {
        const saved = logWorkout(store, toWorkout(w, today), 'seldon')!;
        return { data: { ok: true, id: saved.id }, summary: `Logged workout: ${saved.name}` };
      },
    ),
    tool(
      'log_body_composition',
      'Record a body-composition reading (smart scale, InBody): weight, body fat %, skeletal muscle mass, visceral fat level, body water %, BMR. Weight also updates their Weight metric.',
      bodyInput,
      (b, { store, today }) => {
        const saved = logBody(store, toBody(b, today), 'seldon')!;
        return { data: { ok: true, id: saved.id }, summary: `Logged body composition${saved.weightKg ? ` — ${saved.weightKg} kg` : ''}` };
      },
    ),
    tool(
      'get_nutrition_and_training',
      'Read the user\'s food log for a day with totals against their targets, the last two weeks of daily totals, recent workouts, and body-composition history. Call this before advising on eating or training.',
      z.object({ date: dateStr.optional() }),
      ({ date }, { store, today }) => {
        const h = healthState(store, date ?? today);
        return { data: { ...h, workouts: h.workouts.slice(0, 10), body: h.body.slice(-10) }, summary: 'Read nutrition and training' };
      },
    ),
    tool(
      'set_nutrition_targets',
      'Set the user\'s daily calorie and macro targets (grams). Only when they agree on the numbers.',
      z.object({ kcal: z.number().min(800).max(6000).nullable().optional(), protein: z.number().min(0).max(500).nullable().optional(), carbs: z.number().min(0).max(1000).nullable().optional(), fat: z.number().min(0).max(400).nullable().optional() }),
      (t, { store }) => ({ data: setTargets(store, t), summary: 'Updated nutrition targets' }),
    ),
  ],
  routes: (app, { store }) => {
    app.get('/api/health', (c) => c.json(healthState(store, todayOf(c))));
    app.put('/api/health/targets', async (c) => {
      const t = await read(c, z.object({ kcal: z.number().min(0).max(8000).nullable(), protein: z.number().min(0).max(600).nullable(), carbs: z.number().min(0).max(1200).nullable(), fat: z.number().min(0).max(500).nullable() }).partial());
      setTargets(store, t);
      return c.json(healthState(store, todayOf(c)));
    });
    app.post('/api/health/food', async (c) => {
      const { items, time } = await read(c, z.object({ items: z.array(foodItem).min(1).max(20), time: z.string().regex(/^\d{2}:\d{2}$/).optional() }));
      logFood(store, todayOf(c), time ?? nowHHMM(), items);
      return c.json(healthState(store, todayOf(c)), 201);
    });
    app.post('/api/health/food/describe', async (c) => {
      const type = c.req.header('content-type') ?? '';
      let text = '';
      let image: { data: Buffer; mime: string } | undefined;
      let time = nowHHMM();
      if (type.includes('multipart/form-data')) {
        const form = await c.req.formData();
        text = String(form.get('text') ?? '');
        if (form.get('file')) image = await imageFrom(form);
        time = String(form.get('time') ?? time);
      } else {
        const input = await read(c, z.object({ text: z.string().min(1).max(1000), time: z.string().regex(/^\d{2}:\d{2}$/).optional() }));
        text = input.text;
        time = input.time ?? time;
      }
      try {
        const items = await estimateFood(store, text, image);
        logFood(store, todayOf(c), time, items, 'estimate');
      } catch (err) {
        if (err instanceof NoBrain) throw new Invalid('Connect a brain in Settings to describe food, or add the numbers yourself.');
        throw err;
      }
      return c.json(healthState(store, todayOf(c)), 201);
    });
    app.delete('/api/health/food/:id', (c) => {
      if (!store.db.prepare('DELETE FROM food_log WHERE id = ?').run(c.req.param('id')).changes) throw new NotFound('Entry');
      return c.json({ ok: true });
    });
    app.post('/api/health/workouts', async (c) => {
      logWorkout(store, toWorkout(await read(c, workoutInput), todayOf(c)));
      return c.json(healthState(store, todayOf(c)), 201);
    });
    app.delete('/api/health/workouts/:id', (c) => {
      if (!store.db.prepare('DELETE FROM workouts WHERE id = ?').run(c.req.param('id')).changes) throw new NotFound('Workout');
      return c.json({ ok: true });
    });
    app.post('/api/health/body', async (c) => {
      logBody(store, toBody(await read(c, bodyInput), todayOf(c)));
      return c.json(healthState(store, todayOf(c)), 201);
    });
    app.post('/api/health/body/scan', async (c) => {
      const image = await imageFrom(await c.req.formData());
      try {
        const r = await readBodyScan(store, image);
        logBody(store, { date: r.date ?? todayOf(c), weightKg: r.weight_kg, bodyFatPct: r.body_fat_pct, muscleKg: r.muscle_kg, visceralFat: r.visceral_fat, waterPct: r.water_pct, bmr: r.bmr, notes: 'read from a photo' }, 'scan');
      } catch (err) {
        if (err instanceof NoBrain) throw new Invalid('Connect a brain that can read images to scan a result.');
        throw err;
      }
      return c.json(healthState(store, todayOf(c)), 201);
    });
    app.delete('/api/health/body/:id', (c) => {
      if (!store.db.prepare('DELETE FROM body_readings WHERE id = ?').run(c.req.param('id')).changes) throw new NotFound('Reading');
      return c.json({ ok: true });
    });
  },
});
