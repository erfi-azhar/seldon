// The HTTP API. Thin: validate, call the Store, return JSON.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { chat, listModels, providerFor } from './agent/index.ts';
import { ProviderError } from './agent/types.ts';
import type { DB } from './db.ts';
import { Invalid, localDate, NotFound, nowIso, Store } from './store.ts';
import { CATALOG_BY_KEY } from '../../shared/catalog.ts';
import type { AgentEvent, Screenings } from '../../shared/types.ts';

export interface AppOptions {
  db: DB;
  /** When set, every API call needs a signed-in session. */
  passphrase?: string;
  /** Extra hostnames the app may be reached at ("*" for any). Loopback is always allowed. */
  allowedHosts?: string[];
}

const SESSION_COOKIE = 'lifeos_session';
const SESSION_DAYS = 30;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const sameSecret = (a: string, b: string): boolean => timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));

// ── Request shapes ──────────────────────────────────────────────────────────

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().max(max);
const horizon = z.enum(['quarter', 'year', 'someday']);
const status = z.enum(['active', 'paused', 'done', 'dropped']);
const direction = z.enum(['up', 'down', 'none']);
const cadence = z.enum(['daily', 'weekly']);

const S = {
  login: z.object({ passphrase: z.string() }),
  onboarding: z.object({
    userName: text(80),
    agentName: text(40),
    sphereKeys: z.array(z.string()).max(40),
  }),
  sphereCreate: z.object({
    key: z.string().nullable().optional(),
    name: text(60).optional(),
    icon: text(40).optional(),
    hue: z.number().min(0).max(360).optional(),
    vision: text(600).optional(),
  }),
  spherePatch: z.object({
    name: text(60).optional(),
    icon: text(40).optional(),
    hue: z.number().min(0).max(360).optional(),
    vision: text(600).optional(),
    archived: z.boolean().optional(),
  }),
  reorder: z.object({ ids: z.array(z.string()).max(100) }),
  goalCreate: z.object({
    sphereId: z.string(),
    title: text(200),
    why: text(600).optional(),
    horizon: horizon.optional(),
    targetDate: date.nullable().optional(),
    metricId: z.string().nullable().optional(),
    startValue: z.number().nullable().optional(),
    targetValue: z.number().nullable().optional(),
    milestones: z.array(text(200)).max(30).optional(),
  }),
  goalPatch: z.object({
    sphereId: z.string().optional(),
    title: text(200).optional(),
    why: text(600).optional(),
    status: status.optional(),
    horizon: horizon.optional(),
    targetDate: date.nullable().optional(),
    metricId: z.string().nullable().optional(),
    startValue: z.number().nullable().optional(),
    targetValue: z.number().nullable().optional(),
    manualProgress: z.number().min(0).max(100).optional(),
  }),
  milestoneCreate: z.object({ title: text(200) }),
  milestonePatch: z.object({ title: text(200).optional(), done: z.boolean().optional() }),
  taskCreate: z.object({
    title: text(200),
    notes: text(2000).optional(),
    sphereId: z.string().nullable().optional(),
    goalId: z.string().nullable().optional(),
    dueDate: date.nullable().optional(),
  }),
  taskPatch: z.object({
    title: text(200).optional(),
    notes: text(2000).optional(),
    sphereId: z.string().nullable().optional(),
    goalId: z.string().nullable().optional(),
    dueDate: date.nullable().optional(),
    done: z.boolean().optional(),
  }),
  habitCreate: z.object({
    sphereId: z.string(),
    name: text(120),
    cadence: cadence.optional(),
    targetPerWeek: z.number().int().min(1).max(7).optional(),
  }),
  habitPatch: z.object({
    name: text(120).optional(),
    cadence: cadence.optional(),
    targetPerWeek: z.number().int().min(1).max(7).optional(),
    archived: z.boolean().optional(),
  }),
  habitLog: z.object({ date: date.optional(), done: z.boolean().optional() }),
  metricCreate: z.object({ sphereId: z.string(), name: text(120), unit: text(12).optional(), direction: direction.optional() }),
  metricPatch: z.object({ name: text(120).optional(), unit: text(12).optional(), direction: direction.optional() }),
  entryCreate: z.object({ value: z.number(), date: date.optional(), note: text(300).optional() }),
  noteCreate: z.object({
    kind: z.enum(['note', 'link']).optional(),
    title: text(200).optional(),
    body: text(50_000).optional(),
    url: text(2000).optional(),
    sphereId: z.string().nullable().optional(),
  }),
  notePatch: z.object({
    title: text(200).optional(),
    body: text(50_000).optional(),
    url: text(2000).optional(),
    sphereId: z.string().nullable().optional(),
    pinned: z.boolean().optional(),
  }),
  journal: z.object({ body: text(50_000) }),
  memory: z.object({ content: text(500) }),
  settings: z.object({
    profile: z.object({ userName: text(80), agentName: text(40), onboarded: z.boolean() }).partial().optional(),
    model: z
      .object({
        provider: z.enum(['anthropic', 'openai-compatible']).nullable(),
        preset: z.string().nullable(),
        baseUrl: text(300),
        model: text(200),
        effort: z.enum(['auto', 'low', 'medium', 'high']),
        apiKey: z.string().max(500).nullable(),
      })
      .partial()
      .optional(),
  }),
  chat: z.object({
    conversationId: z.string().optional(),
    message: z.string().min(1).max(20_000),
    context: z.object({
      date,
      time: text(10),
      timezone: text(60),
      viewing: text(200),
    }),
  }),
};

async function read<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const json: unknown = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Invalid(z.prettifyError(parsed.error));
  return parsed.data;
}

const today = (c: Context): string => {
  const d = c.req.query('date');
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : localDate();
};

// ── App ─────────────────────────────────────────────────────────────────────

export function createApp(opts: AppOptions): Hono {
  const store = new Store(opts.db);
  const app = new Hono();
  const anyHost = opts.allowedHosts?.includes('*') ?? false;
  const allowedHosts = new Set([...LOOPBACK, ...(opts.allowedHosts ?? []).map((h) => h.toLowerCase())]);
  const failedLogins: number[] = [];

  const signedIn = (c: Context): boolean => {
    if (!opts.passphrase) return true;
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return false;
    const row = opts.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sha256(token)) as
      | { expires_at: string }
      | undefined;
    return !!row && row.expires_at > nowIso();
  };

  app.onError((err, c) => {
    if (err instanceof NotFound) return c.json({ error: err.message }, 404);
    if (err instanceof Invalid) return c.json({ error: err.message }, 400);
    if (err instanceof ProviderError) return c.json({ error: err.message }, 502);
    console.error(err);
    return c.json({ error: 'Something went wrong on the server.' }, 500);
  });

  app.use('/api/*', async (c, next) => {
    // Without a passphrase the only thing keeping other sites out is that this server
    // answers to a known name. Refusing unknown Host headers blocks DNS rebinding.
    if (!opts.passphrase && !anyHost && !allowedHosts.has(new URL(c.req.url).hostname.toLowerCase())) {
      return c.json({ error: 'This host is not allowed. Set LIFEOS_ALLOWED_HOSTS or a passphrase.' }, 403);
    }
    // Other websites must not be able to make this browser change anything here.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const site = c.req.header('sec-fetch-site');
      const origin = c.req.header('origin');
      const crossSite = site
        ? site !== 'same-origin' && site !== 'none'
        : !!origin && new URL(origin).host !== new URL(c.req.url).host;
      if (crossSite) return c.json({ error: 'Cross-site requests are not allowed.' }, 403);
    }
    if (!c.req.path.startsWith('/api/auth/') && !signedIn(c)) {
      return c.json({ error: 'Sign in first.' }, 401);
    }
    await next();
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  app.get('/api/auth/status', (c) => c.json({ required: !!opts.passphrase, authenticated: signedIn(c) }));

  app.post('/api/auth/login', async (c) => {
    if (!opts.passphrase) return c.json({ ok: true });
    const cutoff = Date.now() - 5 * 60_000;
    while (failedLogins.length && failedLogins[0]! < cutoff) failedLogins.shift();
    if (failedLogins.length >= 8) return c.json({ error: 'Too many attempts. Wait a few minutes.' }, 429);

    const { passphrase } = await read(c, S.login);
    if (!sameSecret(passphrase, opts.passphrase)) {
      failedLogins.push(Date.now());
      return c.json({ error: 'That passphrase is not right.' }, 401);
    }
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    opts.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
    opts.db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run(sha256(token), expires.toISOString());
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      expires,
      secure: new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https',
    });
    return c.json({ ok: true });
  });

  app.post('/api/auth/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) opts.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // ── Overview, search, activity ────────────────────────────────────────────

  app.get('/api/overview', (c) => c.json(store.overview(today(c))));
  app.get('/api/search', (c) => c.json(store.search(c.req.query('q') ?? '')));
  app.get('/api/activity', (c) => c.json(store.listActivity({ limit: Math.min(200, Number(c.req.query('limit')) || 40) })));
  app.post('/api/activity/:id/undo', (c) => {
    const ok = store.undo(Number(c.req.param('id')));
    return ok ? c.json({ ok }) : c.json({ error: 'That can no longer be undone.' }, 409);
  });

  // ── Spheres ───────────────────────────────────────────────────────────────

  app.get('/api/spheres', (c) => c.json(store.listSpheres(today(c), c.req.query('archived') === '1')));
  app.post('/api/spheres', async (c) => {
    const input = await read(c, S.sphereCreate);
    if (input.key && !CATALOG_BY_KEY[input.key]) throw new Invalid('Unknown sphere template');
    return c.json(store.createSphere(input), 201);
  });
  app.post('/api/spheres/reorder', async (c) => {
    store.reorderSpheres((await read(c, S.reorder)).ids);
    return c.json({ ok: true });
  });
  app.get('/api/spheres/:id', (c) => c.json(store.sphereDetail(c.req.param('id'), today(c))));
  app.patch('/api/spheres/:id', async (c) => c.json(store.updateSphere(c.req.param('id'), await read(c, S.spherePatch))));
  app.delete('/api/spheres/:id', (c) => {
    store.deleteSphere(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Goals ─────────────────────────────────────────────────────────────────

  app.get('/api/goals', (c) => {
    const st = c.req.query('status');
    const parsed = st === 'all' ? ('all' as const) : status.safeParse(st).data;
    return c.json(store.listGoals({ sphereId: c.req.query('sphereId') || undefined, status: parsed }));
  });
  app.post('/api/goals', async (c) => c.json(store.createGoal(await read(c, S.goalCreate)), 201));
  app.get('/api/goals/:id', (c) => c.json(store.getGoal(c.req.param('id'))));
  app.patch('/api/goals/:id', async (c) => c.json(store.updateGoal(c.req.param('id'), await read(c, S.goalPatch))));
  app.delete('/api/goals/:id', (c) => {
    store.deleteGoal(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/goals/:id/milestones', async (c) =>
    c.json(store.addMilestone(c.req.param('id'), (await read(c, S.milestoneCreate)).title), 201),
  );
  app.patch('/api/milestones/:id', async (c) => c.json(store.updateMilestone(c.req.param('id'), await read(c, S.milestonePatch))));
  app.delete('/api/milestones/:id', (c) => {
    store.deleteMilestone(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Tasks ─────────────────────────────────────────────────────────────────

  app.get('/api/tasks', (c) => {
    const st = z.enum(['open', 'done', 'all']).safeParse(c.req.query('status')).data;
    return c.json(store.listTasks({ status: st, sphereId: c.req.query('sphereId') || undefined, goalId: c.req.query('goalId') || undefined }));
  });
  app.post('/api/tasks', async (c) => c.json(store.createTask(await read(c, S.taskCreate)), 201));
  app.get('/api/tasks/:id', (c) => c.json(store.getTask(c.req.param('id'))));
  app.patch('/api/tasks/:id', async (c) => c.json(store.updateTask(c.req.param('id'), await read(c, S.taskPatch))));
  app.delete('/api/tasks/:id', (c) => {
    store.deleteTask(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Habits ────────────────────────────────────────────────────────────────

  app.get('/api/habits', (c) => c.json(store.listHabits(today(c), c.req.query('sphereId') || undefined)));
  app.post('/api/habits', async (c) => c.json(store.createHabit(await read(c, S.habitCreate)), 201));
  app.get('/api/habits/:id', (c) => c.json(store.getHabit(c.req.param('id'), today(c))));
  app.patch('/api/habits/:id', async (c) => c.json(store.updateHabit(c.req.param('id'), await read(c, S.habitPatch))));
  app.delete('/api/habits/:id', (c) => {
    store.deleteHabit(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/habits/:id/log', async (c) => {
    const { date: d, done } = await read(c, S.habitLog);
    return c.json(store.setHabitLog(c.req.param('id'), d ?? today(c), done, today(c)));
  });

  // ── Metrics ───────────────────────────────────────────────────────────────

  app.get('/api/metrics', (c) => c.json(store.listMetrics(c.req.query('sphereId') || undefined)));
  app.post('/api/metrics', async (c) => c.json(store.createMetric(await read(c, S.metricCreate)), 201));
  app.patch('/api/metrics/:id', async (c) => c.json(store.updateMetric(c.req.param('id'), await read(c, S.metricPatch))));
  app.delete('/api/metrics/:id', (c) => {
    store.deleteMetric(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/metrics/:id/entries', async (c) => {
    const input = await read(c, S.entryCreate);
    return c.json(store.addMetricEntry(c.req.param('id'), { ...input, date: input.date ?? today(c) }), 201);
  });
  app.delete('/api/metric-entries/:id', (c) => {
    store.deleteMetricEntry(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Notes, journal, memory ────────────────────────────────────────────────

  app.get('/api/notes', (c) => {
    const kind = z.enum(['note', 'link', 'journal']).safeParse(c.req.query('kind')).data;
    return c.json(store.listNotes({ kind, sphereId: c.req.query('sphereId') || undefined, q: c.req.query('q') || undefined }));
  });
  app.post('/api/notes', async (c) => c.json(store.createNote(await read(c, S.noteCreate)), 201));
  app.get('/api/notes/:id', (c) => c.json(store.getNote(c.req.param('id'))));
  app.patch('/api/notes/:id', async (c) => c.json(store.updateNote(c.req.param('id'), await read(c, S.notePatch))));
  app.delete('/api/notes/:id', (c) => {
    store.deleteNote(c.req.param('id'));
    return c.json({ ok: true });
  });

  const dayParam = (c: Context): string => {
    const d = date.safeParse(c.req.param('date'));
    if (!d.success) throw new Invalid('Dates look like 2026-01-31');
    return d.data;
  };
  app.get('/api/journal/:date', (c) => c.json(store.getJournal(dayParam(c))));
  app.put('/api/journal/:date', async (c) => c.json(store.putJournal(dayParam(c), (await read(c, S.journal)).body)));

  // One document; the shape is owned by the client (shared/types.ts → Screenings).
  const screenings = z.looseObject({
    title: z.string().max(200),
    visits: z.array(z.looseObject({ label: z.string() })).min(1).max(2),
    results: z.array(z.looseObject({ g: z.string(), n: z.string() })).max(1000),
  });
  app.get('/api/screenings', (c) => c.json(store.getScreenings()));
  app.put('/api/screenings', async (c) => {
    store.putScreenings((await read(c, screenings)) as unknown as Screenings);
    return c.json({ ok: true });
  });
  app.delete('/api/screenings', (c) => {
    store.putScreenings(null);
    return c.json({ ok: true });
  });

  app.get('/api/memories', (c) => c.json(store.listMemories()));
  app.post('/api/memories', async (c) => c.json(store.addMemory((await read(c, S.memory)).content), 201));
  app.delete('/api/memories/:id', (c) => {
    store.deleteMemory(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Settings & data ───────────────────────────────────────────────────────

  app.get('/api/settings', (c) => c.json(store.getSettings()));
  app.put('/api/settings', async (c) => c.json(store.updateSettings(await read(c, S.settings))));
  app.post('/api/onboarding', async (c) => c.json(store.onboard(await read(c, S.onboarding))));

  app.get('/api/models', async (c) => {
    const cfg = store.getModelConfig();
    if (!cfg) throw new Invalid('Choose a model provider first.');
    return c.json(await listModels(cfg));
  });

  app.get('/api/export', (c) => {
    c.header('content-disposition', `attachment; filename="lifeos-${localDate()}.json"`);
    return c.json(store.exportAll());
  });
  app.post('/api/import', async (c) => {
    store.importAll(await c.req.json().catch(() => null));
    return c.json({ ok: true });
  });

  // ── Agent ─────────────────────────────────────────────────────────────────

  app.get('/api/conversations', (c) => c.json(store.listConversations()));
  app.get('/api/conversations/:id', (c) => c.json(store.getConversation(c.req.param('id'))));
  app.delete('/api/conversations/:id', (c) => {
    store.deleteConversation(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/agent/chat', async (c) => {
    const input = await read(c, S.chat);
    const cfg = store.getModelConfig();
    if (!cfg) return c.json({ error: 'No model is connected yet.', code: 'no_model' }, 409);
    if (cfg.provider === 'anthropic' && !cfg.apiKey) {
      return c.json({ error: 'Add your Anthropic API key in Settings → Model.', code: 'no_model' }, 409);
    }
    if (input.conversationId) store.getConversationSystem(input.conversationId);
    const provider = providerFor(cfg);

    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      // Events are produced synchronously; write them out in order.
      let queue: Promise<unknown> = Promise.resolve();
      const emit = (event: AgentEvent): void => {
        queue = queue.then(() => stream.writeSSE({ data: JSON.stringify(event) })).catch(() => undefined);
      };
      await chat({
        store,
        provider,
        conversationId: input.conversationId,
        message: input.message,
        context: input.context,
        emit,
        signal: abort.signal,
      });
      await queue;
    });
  });

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  return app;
}
