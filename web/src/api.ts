import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type {
  AgentEvent,
  ChatContext,
  Conversation,
  ConversationSummary,
  FaithState,
  Goal,
  HealthState,
  TravelState,
  JobsState,
  IntegrationStatus,
  Memory,
  Metric,
  Note,
  NoteKind,
  Overview,
  SearchHit,
  Settings,
  Signal,
  SphereDetail,
  SphereWithStats,
  Task,
} from '../../shared/types.ts';
import { todayStr } from './lib.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Fired when the server says the session is gone, so the shell can show sign-in. */
export const SIGNED_OUT = 'terminus:signed-out';

async function fail(res: Response): Promise<never> {
  let message = `Request failed (${res.status})`;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    if (body.error) message = body.error;
    code = body.code;
  } catch {
    // Not JSON — keep the generic message.
  }
  if (res.status === 401) window.dispatchEvent(new Event(SIGNED_OUT));
  throw new ApiError(message, res.status, code);
}

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      // The server uses the browser's zone for "done today" and quiet days.
      headers: { 'x-timezone': ZONE, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('Could not reach your Terminus server.', 0);
  }
  if (!res.ok) return fail(res);
  return (await res.json()) as T;
}

const withDate = (path: string): string => `${path}${path.includes('?') ? '&' : '?'}date=${todayStr()}`;

// ── Queries ─────────────────────────────────────────────────────────────────

export const useAuth = () =>
  useQuery({ queryKey: ['auth'], queryFn: () => api<{ required: boolean; authenticated: boolean }>('GET', '/auth/status'), staleTime: Infinity });

export const useSettings = (enabled = true) =>
  useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('GET', '/settings'), enabled });

export const useOverview = () =>
  useQuery({ queryKey: ['overview', todayStr()], queryFn: () => api<Overview>('GET', withDate('/overview')) });

export const useSpheres = (archived = false) =>
  useQuery({
    queryKey: ['spheres', archived, todayStr()],
    queryFn: () => api<SphereWithStats[]>('GET', withDate(`/spheres${archived ? '?archived=1' : ''}`)),
  });

export const useSphere = (id: string) =>
  useQuery({ queryKey: ['sphere', id, todayStr()], queryFn: () => api<SphereDetail>('GET', withDate(`/spheres/${id}`)) });

export const useGoals = (status: 'active' | 'done' | 'all' | 'paused' = 'all') =>
  useQuery({ queryKey: ['goals', status], queryFn: () => api<Goal[]>('GET', `/goals?status=${status}`) });

export const useGoal = (id: string | null) =>
  useQuery({ queryKey: ['goal', id], queryFn: () => api<Goal>('GET', `/goals/${id}`), enabled: !!id });

export const useTasks = (params: { goalId?: string; status?: 'open' | 'done' | 'all' }) =>
  useQuery({
    queryKey: ['tasks', params],
    queryFn: () => api<Task[]>('GET', `/tasks?status=${params.status ?? 'open'}${params.goalId ? `&goalId=${params.goalId}` : ''}`),
  });

export const useMetrics = () => useQuery({ queryKey: ['metrics'], queryFn: () => api<Metric[]>('GET', '/metrics') });

export const useNotes = (filter: { kind?: NoteKind; sphereId?: string; q?: string; saved?: boolean; collection?: string }) =>
  useQuery({
    queryKey: ['notes', filter],
    queryFn: () => {
      const p = new URLSearchParams();
      if (filter.kind) p.set('kind', filter.kind);
      if (filter.sphereId) p.set('sphereId', filter.sphereId);
      if (filter.q) p.set('q', filter.q);
      if (filter.saved) p.set('saved', '1');
      if (filter.collection) p.set('collection', filter.collection);
      return api<Note[]>('GET', `/notes?${p}`);
    },
    placeholderData: (prev) => prev,
    // Saved links are read in the background: look again until they're done.
    refetchInterval: (q) => (q.state.data?.some((n) => n.status === 'processing') ? 2_000 : false),
  });

export const useMemories = () => useQuery({ queryKey: ['memories'], queryFn: () => api<Memory[]>('GET', '/memories') });

export const useSearch = (q: string) =>
  useQuery({
    queryKey: ['search', q],
    queryFn: () => api<SearchHit[]>('GET', `/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
  });

export const useConversations = (enabled: boolean) =>
  useQuery({ queryKey: ['conversations'], queryFn: () => api<ConversationSummary[]>('GET', '/conversations'), enabled });

export const fetchConversation = (id: string) => api<Conversation>('GET', `/conversations/${id}`);

// ── Mutations ───────────────────────────────────────────────────────────────

/**
 * A write. This is a single-person app with small data, so after any change we simply
 * refresh everything on screen rather than tracking which queries a write touches.
 */
export function useWrite<V = void, R = unknown>(fn: (vars: V) => Promise<R>): UseMutationResult<R, Error, V> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => qc.invalidateQueries(),
  });
}

export const write = {
  post: <T,>(path: string, body: unknown = {}) => api<T>('POST', path, body),
  patch: <T,>(path: string, body: unknown) => api<T>('PATCH', path, body),
  put: <T,>(path: string, body: unknown) => api<T>('PUT', path, body),
  del: (path: string) => api<{ ok: true }>('DELETE', path),
};

// ── Agent stream ────────────────────────────────────────────────────────────

/** POST a message and read the event stream. Resolves when the stream ends. */
export async function streamChat(
  body: { conversationId?: string; connectionId?: string; message: string; context: ChatContext },
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  });
  if (!res.ok) return fail(res);
  if (!res.body) throw new ApiError('The server sent an empty reply.', 0);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) onEvent(JSON.parse(data) as AgentEvent);
    }
  }
}

// ── Signals & integrations ──────────────────────────────────────────────────

export const useSignals = (filter: { sphereId?: string; source?: string } = {}) =>
  useQuery({
    queryKey: ['signals', filter],
    queryFn: () => {
      const p = new URLSearchParams();
      if (filter.sphereId) p.set('sphereId', filter.sphereId);
      if (filter.source) p.set('source', filter.source);
      return api<Signal[]>('GET', `/signals?${p}`);
    },
    // Background jobs add signals while the app is open.
    refetchInterval: 60_000,
  });

export const useIntegration = (id: string) =>
  useQuery({ queryKey: ['integration', id], queryFn: () => api<IntegrationStatus>('GET', `/integrations/${id}`), refetchInterval: (q) => (q.state.data?.running ? 3_000 : 30_000) });

export const useFaith = () =>
  useQuery({ queryKey: ['faith', todayStr()], queryFn: () => api<FaithState>('GET', withDate('/faith')), refetchInterval: 60_000 });

export const faithWrite = {
  settings: (body: object) => api<FaithState>('PUT', withDate('/faith/settings'), body),
  log: (body: object) => api<FaithState>('POST', withDate('/faith/log'), body),
  qada: (body: object) => api<FaithState>('POST', withDate('/faith/qada'), body),
};

export const useHealth = () => useQuery({ queryKey: ['health', todayStr()], queryFn: () => api<HealthState>('GET', withDate('/health')) });

export async function postForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`/api${withDate(path)}`, { method: 'POST', body: form, headers: { 'x-timezone': ZONE }, credentials: 'same-origin' });
  if (!res.ok) return fail(res);
  return (await res.json()) as T;
}

export const healthWrite = {
  post: (path: string, body: object) => api<HealthState>('POST', withDate(`/health${path}`), body),
  targets: (body: object) => api<HealthState>('PUT', withDate('/health/targets'), body),
  del: (path: string) => api<{ ok: true }>('DELETE', `/health${path}`),
};

export const useTravel = () =>
  useQuery({ queryKey: ['travel', todayStr()], queryFn: () => api<TravelState>('GET', withDate('/travel')), refetchInterval: 5 * 60_000 });

export const travelWrite = {
  post: (path: string, body: object = {}) => api<TravelState & { created?: string }>('POST', withDate(`/travel${path}`), body),
  patch: (path: string, body: object) => api<TravelState>('PATCH', withDate(`/travel${path}`), body),
  put: (path: string, body: object) => api<TravelState>('PUT', withDate(`/travel${path}`), body),
  del: (path: string) => api<TravelState>('DELETE', withDate(`/travel${path}`)),
};

export const useJobs = () => useQuery({ queryKey: ['jobs'], queryFn: () => api<JobsState>('GET', '/jobs'), refetchInterval: 10 * 60_000 });

export const jobsWrite = {
  watch: (body: { company: string; url: string }) => api<JobsState>('POST', '/jobs/watches', body),
  unwatch: (id: string) => api<JobsState>('DELETE', `/jobs/watches/${id}`),
  preferences: (body: object) => api<JobsState>('PUT', '/jobs/preferences', body),
  mark: (id: string, status: 'seen' | 'saved' | 'dismissed') => api<JobsState>('PATCH', `/jobs/postings/${id}`, { status }),
  check: () => api<unknown>('POST', '/integrations/jobs/run'),
};
