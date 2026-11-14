// The signals inbox: one place where integrations put things that may need you.

import { z } from 'zod';
import { tool } from '../agent/tools.ts';
import { read } from '../http.ts';
import { Invalid, newId, nowIso, NotFound, type Store } from '../store.ts';
import { features, registerFeature } from './registry.ts';
import type { Signal, SignalAction, SignalStatus } from '../../../shared/types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function fromRow(r: Row): Signal {
  return {
    id: r.id,
    source: r.source,
    kind: r.kind,
    title: r.title,
    body: r.body,
    url: r.url,
    sphereId: r.sphere_id,
    priority: r.priority,
    actions: JSON.parse(r.actions) as SignalAction[],
    status: r.status,
    createdAt: r.created_at,
    occurredAt: r.occurred_at,
    data: JSON.parse(r.data) as Record<string, unknown>,
  };
}

export interface NewSignal {
  source: string;
  kind: string;
  /** Stable id from the source (message id, job id) so a signal is only raised once. */
  externalId: string;
  title: string;
  body?: string;
  url?: string;
  sphereId?: string | null;
  priority?: number;
  actions?: SignalAction[];
  occurredAt?: string;
  data?: Record<string, unknown>;
}

/** Raise a signal. Returns null when this source already raised one for externalId. */
export function addSignal(store: Store, s: NewSignal): Signal | null {
  const exists = store.db.prepare('SELECT 1 AS x FROM signals WHERE source = ? AND external_id = ?').get(s.source, s.externalId);
  if (exists) return null;
  const id = newId();
  const now = nowIso();
  store.db
    .prepare(
      `INSERT INTO signals (id, source, kind, external_id, title, body, url, sphere_id, priority, actions, status, data, created_at, occurred_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'new',?,?,?)`,
    )
    .run(
      id,
      s.source,
      s.kind,
      s.externalId,
      s.title.slice(0, 300),
      (s.body ?? '').slice(0, 4000),
      s.url ?? '',
      s.sphereId ?? null,
      Math.max(0, Math.min(3, s.priority ?? 1)),
      JSON.stringify(s.actions ?? []),
      JSON.stringify(s.data ?? {}),
      now,
      s.occurredAt ?? now,
    );
  return getSignal(store, id);
}

export function hasSignal(store: Store, source: string, externalId: string): boolean {
  return !!store.db.prepare('SELECT 1 AS x FROM signals WHERE source = ? AND external_id = ?').get(source, externalId);
}

export function getSignal(store: Store, id: string): Signal {
  const r = store.db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Signal');
  return fromRow(r);
}

export function listSignals(store: Store, filter: { status?: 'open' | 'all'; source?: string; sphereId?: string; limit?: number } = {}): Signal[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if ((filter.status ?? 'open') === 'open') where.push("status IN ('new', 'seen')");
  if (filter.source) {
    where.push('source = ?');
    params.push(filter.source);
  }
  if (filter.sphereId) {
    where.push('sphere_id = ?');
    params.push(filter.sphereId);
  }
  const rows = store.db
    .prepare(`SELECT * FROM signals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY priority DESC, occurred_at DESC LIMIT ?`)
    .all(...params, filter.limit ?? 50) as Row[];
  return rows.map(fromRow);
}

export function setSignalStatus(store: Store, id: string, status: SignalStatus): Signal {
  getSignal(store, id);
  store.db.prepare('UPDATE signals SET status = ? WHERE id = ?').run(status, id);
  return getSignal(store, id);
}

/** Old, settled signals go after a month so the table stays small. */
export function pruneSignals(store: Store): void {
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  store.db.prepare("DELETE FROM signals WHERE status IN ('done', 'dismissed') AND created_at < ?").run(cutoff);
}

// ── The signals inbox as a feature ─────────────────────────────────────────

registerFeature({
  id: 'signals',
  tables: ['signals'],
  tools: [
    tool(
      'list_signals',
      "Read the user's inbox of signals: important emails, new job openings, trip alerts and other things integrations surfaced, each with suggested follow-ups. Call this when they ask what needs their attention, about their email, or when planning the day.",
      z.object({ source: z.string().optional().describe('Only one source, e.g. "gmail" or "jobs"') }),
      ({ source }, { store }) => ({
        data: listSignals(store, { source, limit: 30 }).map((s) => ({
          source: s.source,
          kind: s.kind,
          title: s.title,
          detail: s.body,
          priority: ['low', 'normal', 'important', 'urgent'][s.priority],
          when: s.occurredAt,
          suggestions: s.actions.map((a) => a.label),
        })),
        summary: `Checked the inbox${source ? ` (${source})` : ''}`,
      }),
    ),
  ],
  routes: (app, { store }) => {
    app.get('/api/signals', (c) => {
      const status = c.req.query('status') === 'all' ? 'all' : 'open';
      return c.json(listSignals(store, { status, source: c.req.query('source') || undefined, sphereId: c.req.query('sphereId') || undefined }));
    });
    app.patch('/api/signals/:id', async (c) => {
      const { status } = await read(c, z.object({ status: z.enum(['new', 'seen', 'done', 'dismissed']) }));
      return c.json(setSignalStatus(store, c.req.param('id'), status));
    });
    app.post('/api/signals/:id/act', async (c) => {
      const { index, body } = await read(c, z.object({ index: z.number().int().min(0), body: z.string().max(5000).optional() }));
      const signal = getSignal(store, c.req.param('id'));
      const action = signal.actions[index];
      if (!action) throw new NotFound('Action');
      let message: string;
      if (action.type === 'task') {
        const t = store.createTask({ title: action.title, dueDate: action.dueDate ?? null, sphereId: action.sphereId ?? signal.sphereId, notes: action.notes ?? (signal.url ? `From: ${signal.url}` : '') });
        message = `Added task: ${t.title}`;
      } else if (action.type === 'link') {
        message = 'Opened';
      } else {
        const handler = features().map((f) => f.actions?.[action.type]).find(Boolean);
        if (!handler) throw new Invalid('Nothing is connected that can do that.');
        // You can edit a suggested reply before it is saved.
        message = await handler(store, action.type === 'reply' && body !== undefined ? { ...action, body } : action);
      }
      setSignalStatus(store, signal.id, 'done');
      pruneSignals(store);
      return c.json({ ok: true, message });
    });
  },
});

