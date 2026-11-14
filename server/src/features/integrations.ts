// Per-integration configuration and run status. Secrets live in `secrets` and are
// never returned to the client or included in exports.

import { nowIso, type Store } from '../store.ts';
import type { IntegrationStatus } from '../../../shared/types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface IntegrationRecord {
  id: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
  /** Cursor and bookkeeping the integration keeps between runs. */
  state: Record<string, unknown>;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
}

export function getIntegration(store: Store, id: string): IntegrationRecord {
  const r = store.db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as Row | undefined;
  if (!r) return { id, enabled: false, settings: {}, secrets: {}, state: {}, lastRunAt: null, lastOkAt: null, lastError: null };
  return {
    id,
    enabled: !!r.enabled,
    settings: JSON.parse(r.settings),
    secrets: JSON.parse(r.secrets),
    state: JSON.parse(r.state),
    lastRunAt: r.last_run_at,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
  };
}

export function saveIntegration(store: Store, rec: IntegrationRecord): void {
  store.db
    .prepare(
      `INSERT INTO integrations (id, enabled, settings, secrets, state, last_run_at, last_ok_at, last_error)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, settings = excluded.settings, secrets = excluded.secrets,
         state = excluded.state, last_run_at = excluded.last_run_at, last_ok_at = excluded.last_ok_at, last_error = excluded.last_error`,
    )
    .run(rec.id, Number(rec.enabled), JSON.stringify(rec.settings), JSON.stringify(rec.secrets), JSON.stringify(rec.state), rec.lastRunAt, rec.lastOkAt, rec.lastError);
}

export function updateIntegration(store: Store, id: string, change: (rec: IntegrationRecord) => void): IntegrationRecord {
  const rec = getIntegration(store, id);
  change(rec);
  saveIntegration(store, rec);
  return rec;
}

export function removeIntegration(store: Store, id: string): void {
  store.db.prepare('DELETE FROM integrations WHERE id = ?').run(id);
}

export function integrationStatus(store: Store, id: string, running: boolean, configured: (rec: IntegrationRecord) => boolean): IntegrationStatus {
  const rec = getIntegration(store, id);
  return {
    id,
    enabled: rec.enabled,
    configured: configured(rec),
    settings: rec.settings,
    lastRunAt: rec.lastRunAt,
    lastOkAt: rec.lastOkAt,
    lastError: rec.lastError,
    running,
  };
}

export function markRun(store: Store, id: string, error: string | null): void {
  updateIntegration(store, id, (rec) => {
    const now = nowIso();
    rec.lastRunAt = now;
    if (error) rec.lastError = error;
    else {
      rec.lastOkAt = now;
      rec.lastError = null;
    }
  });
}
