// A stand-in for the Terminus server: replays responses recorded from the real server at each
// scenario's moment, and keeps to-do and plan ticks in memory so the cards respond.
type Json = any;
export interface Recording {
  trips: { id: string; title: string }[];
  travels: string | null;
  scenarios: Record<string, Record<string, Json>>;
}

let rec: Recording;
let current = '';
const realFetch = window.fetch.bind(window);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NO_AGENT = 'Seldon isn’t connected in this demo — on your own Terminus this would run.';

/** Every object in every scenario with this id, so a tick shows up wherever the thing appears. */
function each(id: string, fn: (o: Json) => void) {
  const walk = (v: Json) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.id === id) fn(v);
      for (const k in v) walk(v[k]);
    }
  };
  walk(rec.scenarios);
}

let n = 0;
async function handle(method: string, path: string, body: Json): Promise<Response> {
  const data = rec.scenarios[current]!;
  if (method === 'GET') {
    if (path in data) return json(data[path]);
    return json({ error: 'Not part of this demo.' }, 404);
  }
  let m: RegExpMatchArray | null;
  if (method === 'PATCH' && (m = path.match(/^\/tasks\/([^/]+)$/))) {
    let out: Json = null;
    each(m[1]!, (o) => {
      if (!('done' in o)) return;
      Object.assign(o, body, 'done' in body ? { doneAt: body.done ? new Date().toISOString() : null } : {});
      out = o;
    });
    return out ? json(out) : json({ error: 'No such task.' }, 404);
  }
  if (method === 'POST' && path === '/tasks') {
    const task = { id: `demo${++n}`, title: String(body.title ?? ''), notes: '', sphereId: body.sphereId ?? null, goalId: null, tripId: body.tripId ?? null, projectId: null, dueDate: body.dueDate ?? null, done: false, doneAt: null, createdAt: new Date().toISOString() };
    if (task.tripId) for (const s of Object.values(rec.scenarios)) s['/travel']?.trips?.find((t: Json) => t.id === task.tripId)?.todos.push({ ...task });
    return json(task, 201);
  }
  if (method === 'PATCH' && (m = path.match(/^\/travel\/itinerary\/([^/]+)$/))) {
    each(m[1]!, (o) => 'done' in o && Object.assign(o, body));
    return json(data['/travel']);
  }
  return json({ error: NO_AGENT }, 503);
}

export function installServer(r: Recording) {
  rec = r;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    await new Promise((ok) => setTimeout(ok, 60));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    return handle((init?.method ?? 'GET').toUpperCase(), url.pathname.slice(4), body);
  };
  // The live market feed is not part of the demo.
  (window as Json).EventSource = class {
    onmessage = null;
    onerror = null;
    addEventListener() {}
    close() {}
  };
}

export function useScenario(id: string) {
  current = id;
}
