// Personal access tokens: let another program — Claude Code, a script — act as Seldon on
// your Terminus. You create and revoke them in Settings; only a hash is stored. A token is
// either read-only or read and write, may expire, and never reaches the parts of the API
// that hold secrets, manage tokens, export or import, or delete anything. Its writes are
// attributed to Seldon in the activity feed, so each one can be undone.

import { createHash, randomBytes } from 'node:crypto';
import type { AccessToken, AccessScope } from '../../shared/types.ts';
import { Invalid, newId, NotFound, nowIso, type Store } from './store.ts';

const PREFIX = 'tmn_';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const fromRow = (r: Row): AccessToken => ({
  id: r.id,
  name: r.name,
  scope: r.scope,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
});

export function listTokens(store: Store): AccessToken[] {
  return (store.db.prepare('SELECT * FROM access_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC').all() as Row[]).map(fromRow);
}

/** Make a token. Its value is returned once, here, and never again. */
export function createToken(store: Store, name: string, scope: AccessScope, days: number | null): { token: string; record: AccessToken } {
  const label = name.trim().slice(0, 60);
  if (!label) throw new Invalid('Give the token a name, such as "Claude Code"');
  const token = PREFIX + randomBytes(32).toString('base64url');
  const id = newId();
  const expires = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
  store.db.prepare('INSERT INTO access_tokens (id, name, token_hash, scope, created_at, expires_at) VALUES (?,?,?,?,?,?)').run(id, label, sha256(token), scope, nowIso(), expires);
  return { token, record: fromRow(store.db.prepare('SELECT * FROM access_tokens WHERE id = ?').get(id) as Row) };
}

export function revokeToken(store: Store, id: string): void {
  if (!store.db.prepare('UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), id).changes) throw new NotFound('Token');
}

/** The token in an Authorization header, if it is one of ours. Undefined when there is none. */
export function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m && m[1]!.startsWith(PREFIX) ? m[1] : undefined;
}

/** The live token for this value, marking it used; null when unknown, revoked or expired. */
export function checkToken(store: Store, token: string): AccessToken | null {
  const r = store.db.prepare('SELECT * FROM access_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(token)) as Row | undefined;
  if (!r || (r.expires_at && r.expires_at <= nowIso())) return null;
  // Note when it was last used, at most once a minute.
  if (!r.last_used_at || Date.parse(r.last_used_at) < Date.now() - 60_000) store.db.prepare('UPDATE access_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), r.id);
  return fromRow(r);
}

/** Paths a token never reaches, whatever its scope: secrets, tokens, sign-in, export and import. */
const NEVER = [
  /^\/api\/auth\//,
  /^\/api\/tokens/,
  /^\/api\/export/,
  /^\/api\/import/,
  /^\/api\/connections/,
  /^\/api\/brains/,
  /^\/api\/settings/,
  /^\/api\/capture\/token/,
  /^\/api\/integrations\/gmail$/,
  /^\/api\/integrations\/calendar$/,
  /^\/api\/mcp\//,
];

/** Tools that only read, which a read-only token may use. */
export const isReadTool = (name: string) => /^(get_|list_|read_|search$)/.test(name);

/** Why a token may not make this request, or null when it may. */
export function refusal(token: AccessToken, method: string, path: string): string | null {
  if (NEVER.some((re) => re.test(path))) return 'Access tokens cannot use this part of Terminus.';
  if (method === 'DELETE') return 'Access tokens cannot delete anything.';
  const reads = method === 'GET' || method === 'HEAD';
  if (token.scope === 'read' && !reads) {
    // A read-only token may still run tools that only read.
    const tool = /^\/api\/agent\/tools\/([a-z0-9_]+)$/.exec(path)?.[1];
    if (!(method === 'POST' && tool && isReadTool(tool))) return 'This token is read-only.';
  }
  return null;
}
