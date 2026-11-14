// MCP connections: Terminus as an MCP client. Connect a remote MCP server (Gravl, for
// workouts and food), sign in with OAuth, and Seldon can use its tools.
//
// Seldon never gets a server's destructive tools (anything the server marks
// destructive, or named like a delete): like everything else in Terminus, the agent
// can add and change but not delete. A tool the server doesn't mark either way counts
// as destructive, as the MCP spec says, until the person allows it in Settings.
// "Read" mode offers only tools marked read-only.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { z } from 'zod';
import { registerToolSource, type ExternalTool } from '../agent/tools.ts';
import { read } from '../http.ts';
import { Invalid, NotFound, nowIso, type Store } from '../store.ts';
import type { McpServerView } from '../../../shared/types.ts';
import { getIntegration, removeIntegration, saveIntegration, updateIntegration, type IntegrationRecord } from './integrations.ts';
import { registerFeature } from './registry.ts';

const PREFIX = 'mcp:';
const GRAVL_SERVER = 'mcp:gravl';

interface McpSecrets {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}

/** Well-known servers offered in the app. */
export const KNOWN_SERVERS = [
  { name: 'Gravl', url: 'https://mcp.gravl.ai/mcp', blurb: 'Workouts, plus food, weight and measurements if you use Gravl Macros.' },
];

const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'server';

function records(store: Store): IntegrationRecord[] {
  const rows = store.db.prepare('SELECT id FROM integrations WHERE id LIKE ?').all(`${PREFIX}%`) as { id: string }[];
  return rows.map((r) => getIntegration(store, r.id));
}

const secretsOf = (rec: IntegrationRecord): McpSecrets => JSON.parse((rec.secrets.mcp as string | undefined) ?? '{}') as McpSecrets;

function saveSecrets(store: Store, id: string, change: (s: McpSecrets) => void): void {
  updateIntegration(store, id, (rec) => {
    const s = secretsOf(rec);
    change(s);
    rec.secrets = { mcp: JSON.stringify(s) };
  });
}

/** The OAuth client for one server, storing everything in its integration record. */
class Provider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  private readonly store: Store;
  private readonly id: string;
  constructor(store: Store, id: string) {
    this.store = store;
    this.id = id;
  }
  private rec() {
    return getIntegration(this.store, this.id);
  }
  get redirectUrl(): string {
    return String(this.rec().settings.redirectUrl ?? '');
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Terminus',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state(): string {
    const s = randomBytes(16).toString('hex');
    saveSecrets(this.store, this.id, (x) => (x.state = s));
    return s;
  }
  clientInformation() {
    return secretsOf(this.rec()).clientInformation;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    saveSecrets(this.store, this.id, (x) => (x.clientInformation = info));
  }
  tokens() {
    return secretsOf(this.rec()).tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    saveSecrets(this.store, this.id, (x) => (x.tokens = tokens));
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    saveSecrets(this.store, this.id, (x) => (x.codeVerifier = v));
  }
  codeVerifier() {
    const v = secretsOf(this.rec()).codeVerifier;
    if (!v) throw new Invalid('Sign-in expired; start again.');
    return v;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    saveSecrets(this.store, this.id, (x) => {
      if (scope === 'all' || scope === 'client') delete x.clientInformation;
      if (scope === 'all' || scope === 'tokens') delete x.tokens;
      if (scope === 'all' || scope === 'verifier') delete x.codeVerifier;
    });
  }
}

/** Open a session with a server. Throws UnauthorizedError when it needs signing in. */
export async function connect(store: Store, id: string): Promise<Client> {
  const rec = getIntegration(store, id);
  if (!rec.settings.url) throw new NotFound('MCP server');
  const client = new Client({ name: 'terminus', version: '0.2.0' });
  const transport = new StreamableHTTPClientTransport(new URL(String(rec.settings.url)), { authProvider: new Provider(store, id) });
  await client.connect(transport);
  return client;
}

/** Call one tool and return its text. */
export async function callTool(store: Store, id: string, name: string, args: Record<string, unknown>): Promise<string> {
  const client = await connect(store, id);
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = ((res.content ?? []) as { type: string; text?: string }[])
      .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`))
      .join('\n');
    if (res.isError) throw new Error(text || `${name} failed`);
    return text || JSON.stringify(res.structuredContent ?? {});
  } finally {
    await client.close().catch(() => undefined);
  }
}

interface CachedTools {
  at: number;
  tools: {
    name: string;
    description: string;
    schema: Record<string, unknown>;
    readOnly: boolean;
    /** Marked destructive, or named like a delete: never offered. */
    destructive: boolean;
    /** Not marked safe either way, so presumed destructive until the person allows it. */
    unconfirmed: boolean;
  }[];
}

/** Server views carry the tools waiting on the person's OK. */
type ServerView = McpServerView & { unconfirmed: { name: string; allowed: boolean }[] };

const DELETE_VERBS = new Set(['delete', 'del', 'remove', 'rm', 'destroy', 'purge', 'wipe', 'clear', 'erase', 'drop', 'trash', 'archive', 'revoke', 'unsubscribe', 'unlink']);

/** deleteFoodEntry, delete-workout, food_entry_delete, clear_food_log… */
function namedLikeDelete(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some((w) => DELETE_VERBS.has(w));
}

// A server's own words reach the model as tool descriptions; keep them from posing as our tags.
const neutralise = (text: string) => text.replace(/<\s*\/?\s*untrusted/gi, '‹untrusted');

const allowedOf = (rec: IntegrationRecord): string[] => (Array.isArray(rec.settings.allowed) ? (rec.settings.allowed as string[]) : []);

const toolCache = new Map<string, CachedTools>();

async function serverTools(store: Store, id: string, fresh = false): Promise<CachedTools['tools']> {
  const hit = toolCache.get(id);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.tools;
  const client = await connect(store, id);
  try {
    const out: CachedTools['tools'] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const t of page.tools) {
        const readOnly = t.annotations?.readOnlyHint === true;
        const destructive = t.annotations?.destructiveHint === true || namedLikeDelete(t.name);
        out.push({
          name: t.name,
          description: t.description ?? '',
          schema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
          readOnly,
          destructive,
          // The spec's default for destructiveHint is true unless the tool is read-only.
          unconfirmed: !destructive && !readOnly && t.annotations?.destructiveHint !== false,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    toolCache.set(id, { at: Date.now(), tools: out });
    return out;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** The tools Seldon is offered in this mode. */
function offered(rec: IntegrationRecord, tools: CachedTools['tools'], mode: string): CachedTools['tools'] {
  const allowed = allowedOf(rec);
  return tools.filter((t) => !t.destructive && (!t.unconfirmed || allowed.includes(t.name)) && (mode !== 'read' || t.readOnly));
}

function view(store: Store, rec: IntegrationRecord): ServerView {
  const cached = toolCache.get(rec.id)?.tools ?? [];
  const allowed = allowedOf(rec);
  return {
    id: rec.id.slice(PREFIX.length),
    name: String(rec.settings.name ?? ''),
    url: String(rec.settings.url ?? ''),
    mode: (rec.settings.mode as McpServerView['mode']) ?? 'write',
    status: (rec.settings.status as McpServerView['status']) ?? 'unknown',
    error: rec.lastError,
    toolCount: offered(rec, cached, 'write').length,
    withheld: cached.filter((t) => t.destructive).map((t) => t.name),
    unconfirmed: cached.filter((t) => t.unconfirmed).map((t) => ({ name: t.name, allowed: allowed.includes(t.name) })),
    connectedAt: (rec.settings.connectedAt as string | null) ?? null,
  };
}

/** Check a server: refresh its tool list and record whether it needs signing in. */
async function check(store: Store, id: string): Promise<void> {
  try {
    await serverTools(store, id, true);
    updateIntegration(store, id, (r) => {
      r.settings.status = 'connected';
      r.settings.connectedAt ??= nowIso();
      r.lastError = null;
      r.lastOkAt = nowIso();
    });
  } catch (err) {
    const needsAuth = err instanceof UnauthorizedError || /unauthori[sz]ed|401/i.test(String(err));
    updateIntegration(store, id, (r) => {
      r.settings.status = needsAuth ? 'needs_auth' : 'error';
      r.lastError = needsAuth ? null : err instanceof Error ? err.message : String(err);
    });
  }
}

/** Start OAuth: returns where to send the person, or null when already signed in. */
async function startAuth(store: Store, id: string): Promise<string | null> {
  const provider = new Provider(store, id);
  const result = await auth(provider, { serverUrl: String(getIntegration(store, id).settings.url) });
  if (result === 'AUTHORIZED') return null;
  if (!provider.authorizationUrl) throw new Error('The server did not offer a sign-in page.');
  return provider.authorizationUrl.toString();
}

/**
 * A model-safe tool name. Sanitising and the 64-character limit can make two names
 * the same ('food.log' and 'food_log'), so a clash gets a short hash of the original.
 */
function toolName(server: string, tool: string, taken: Set<string>): string {
  let name = `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  if (taken.has(name)) name = `${name.slice(0, 57)}_${createHash('sha256').update(`${server}/${tool}`).digest('hex').slice(0, 6)}`;
  taken.add(name);
  return name;
}

// Connected servers' tools join Seldon's toolbox. What they return is wrapped as
// untrusted by the toolbox before the model sees it.
registerToolSource(async (store): Promise<ExternalTool[]> => {
  const out: ExternalTool[] = [];
  const taken = new Set<string>();
  for (const rec of records(store)) {
    const mode = (rec.settings.mode as string) ?? 'write';
    if (!rec.enabled || mode === 'off' || rec.settings.status !== 'connected') continue;
    const tools = await serverTools(store, rec.id).catch(() => []);
    const server = String(rec.settings.name ?? rec.id.slice(PREFIX.length));
    for (const t of offered(rec, tools, mode)) {
      out.push({
        name: toolName(rec.id.slice(PREFIX.length), t.name, taken),
        description: neutralise(`[${server}] ${t.description}`).slice(0, 1024),
        schema: t.schema,
        run: async (input) => {
          const text = await callTool(store, rec.id, t.name, (input ?? {}) as Record<string, unknown>);
          return { data: text, summary: `${server}: ${t.name.replaceAll('_', ' ')}` };
        },
      });
    }
  }
  return out;
});

/**
 * Point OAuth's redirect at the address the person is using now. The client was
 * registered with the old address, and an authorization server that checks
 * redirect_uri exactly would refuse it, so a new address means a new registration
 * and a fresh sign-in (tokens issued to the old client can't be refreshed by a new one).
 */
function setRedirect(store: Store, id: string, origin: string): void {
  const redirectUrl = `${origin}/api/mcp/callback?server=${encodeURIComponent(id.slice(PREFIX.length))}`;
  updateIntegration(store, id, (r) => {
    if (r.settings.redirectUrl === redirectUrl) return;
    r.settings.redirectUrl = redirectUrl;
    const s = secretsOf(r);
    delete s.clientInformation;
    delete s.tokens;
    delete s.codeVerifier;
    delete s.state;
    r.secrets = { mcp: JSON.stringify(s) };
  });
}

// OAuth sends the person back to this address; it must be how they reach Terminus.
const originOf = (c: Context) => c.req.header('origin') ?? new URL(c.req.url).origin;

registerFeature({
  id: 'mcp',
  routes: (app, { store }) => {
    app.get('/api/mcp/servers', (c) => c.json({ servers: records(store).map((r) => view(store, r)), known: KNOWN_SERVERS }));

    app.post('/api/mcp/servers', async (c) => {
      const input = await read(c, z.object({ name: z.string().min(1).max(40), url: z.string().url().max(500) }));
      const url = new URL(input.url);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Invalid('MCP servers must use https (or http on this machine).');
      const id = `${PREFIX}${slug(input.name)}`;
      const existing = getIntegration(store, id);
      const sameUrl = existing.settings.url === url.toString();
      // 'Notion' and 'notion!' share an id; don't let one silently replace the other.
      if (existing.settings.url && !sameUrl && existing.settings.name !== input.name) {
        throw new Invalid(`${String(existing.settings.name)} is already connected under a name like that. Pick another name, or disconnect it first.`);
      }
      saveIntegration(store, {
        ...existing,
        enabled: true,
        settings: { ...existing.settings, name: input.name, url: url.toString(), mode: existing.settings.mode ?? 'write', status: 'unknown', ...(sameUrl ? {} : { allowed: [] }) },
        secrets: sameUrl ? existing.secrets : {},
      });
      setRedirect(store, id, originOf(c));
      await check(store, id);
      const needs = getIntegration(store, id).settings.status === 'needs_auth';
      const authorizeUrl = needs ? await startAuth(store, id) : null;
      return c.json({ server: view(store, getIntegration(store, id)), authorizeUrl }, 201);
    });

    app.post('/api/mcp/servers/:id/auth', async (c) => {
      const id = `${PREFIX}${c.req.param('id')}`;
      if (!getIntegration(store, id).settings.url) throw new NotFound('MCP server');
      setRedirect(store, id, originOf(c));
      return c.json({ authorizeUrl: await startAuth(store, id) });
    });

    // Where the server's sign-in page sends the person back (a top-level navigation).
    app.get('/api/mcp/callback', async (c) => {
      const id = `${PREFIX}${c.req.query('server') ?? ''}`;
      const rec = getIntegration(store, id);
      const code = c.req.query('code');
      const state = c.req.query('state');
      const back = (status: string) => c.redirect(`/settings?mcp=${encodeURIComponent(status)}#connections`, 302);
      if (!rec.settings.url || !code) return back('cancelled');
      if (!state || state !== secretsOf(rec).state) return back('failed');
      try {
        await auth(new Provider(store, id), { serverUrl: String(rec.settings.url), authorizationCode: code });
        saveSecrets(store, id, (x) => {
          delete x.codeVerifier;
          delete x.state;
        });
        await check(store, id);
        return back('connected');
      } catch (err) {
        updateIntegration(store, id, (r) => (r.lastError = err instanceof Error ? err.message : String(err)));
        return back('failed');
      }
    });

    app.patch('/api/mcp/servers/:id', async (c) => {
      const id = `${PREFIX}${c.req.param('id')}`;
      const { mode, allow } = await read(
        c,
        z.object({ mode: z.enum(['off', 'read', 'write']).optional(), allow: z.object({ tool: z.string().max(200), allowed: z.boolean() }).optional() }),
      );
      if (!getIntegration(store, id).settings.url) throw new NotFound('MCP server');
      // Only a tool that isn't marked or named destructive can be allowed.
      if (allow && !(toolCache.get(id)?.tools ?? []).some((t) => t.unconfirmed && t.name === allow.tool)) throw new Invalid('That tool can\'t be allowed.');
      updateIntegration(store, id, (r) => {
        if (mode) r.settings.mode = mode;
        if (allow) r.settings.allowed = [...allowedOf(r).filter((n) => n !== allow.tool), ...(allow.allowed ? [allow.tool] : [])];
      });
      return c.json(view(store, getIntegration(store, id)));
    });

    app.post('/api/mcp/servers/:id/check', async (c) => {
      const id = `${PREFIX}${c.req.param('id')}`;
      if (!getIntegration(store, id).settings.url) throw new NotFound('MCP server');
      await check(store, id);
      return c.json(view(store, getIntegration(store, id)));
    });

    app.delete('/api/mcp/servers/:id', (c) => {
      const id = `${PREFIX}${c.req.param('id')}`;
      if (!getIntegration(store, id).settings.url) throw new NotFound('MCP server');
      removeIntegration(store, id);
      toolCache.delete(id);
      // The Gravl sync reads from the Gravl server and stops with it. Other ids (gmail,
      // travel, jobs) belong to built-in features that don't depend on any server.
      if (id === GRAVL_SERVER && getIntegration(store, 'gravl').enabled) updateIntegration(store, 'gravl', (r) => (r.enabled = false));
      return c.json({ ok: true });
    });
  },
});
