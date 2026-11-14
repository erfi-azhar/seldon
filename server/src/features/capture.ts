// Capture: send Terminus anything — a link to a post, a TikTok, an article, a
// picture — and Seldon reads it and files it in the Library with a summary, tags, the
// sphere it belongs to and a collection. Things you can act on (an event, a
// deadline) become a suggested task in Needs you.
//
// Pages are fetched by the server through a guard that refuses private addresses;
// thumbnails are stored locally, so viewing your Library never contacts other sites.
// Page text is read by the background brain with no tools, as untrusted data.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { z } from 'zod';
import { NoBrain, think, wrapUntrusted } from '../agent/think.ts';
import { tool } from '../agent/tools.ts';
import { read } from '../http.ts';
import { Invalid, newId, NotFound, nowIso, type Store } from '../store.ts';
import type { CaptureKind, CaptureMeta, Note } from '../../../shared/types.ts';
import { FetchError, safeFetch } from './fetcher.ts';
import { registerFeature } from './registry.ts';
import { addSignal } from './signals.ts';

const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const MAX_IMAGE = 8_000_000;

// ── Files ───────────────────────────────────────────────────────────────────

export function saveFile(store: Store, data: Buffer, mime: string, name = ''): string {
  const id = newId();
  store.db.prepare('INSERT INTO files (id, mime, size, name, data, created_at) VALUES (?,?,?,?,?,?)').run(id, mime, data.length, name.slice(0, 200), data, nowIso());
  return id;
}

function getFile(store: Store, id: string): { mime: string; data: Uint8Array; name: string } | null {
  return (store.db.prepare('SELECT mime, data, name FROM files WHERE id = ?').get(id) as { mime: string; data: Uint8Array; name: string } | undefined) ?? null;
}

// ── Reading a link ──────────────────────────────────────────────────────────

export interface Extracted {
  kind: CaptureKind;
  title: string;
  description: string;
  site: string;
  author: string;
  text: string;
  imageUrl: string | null;
  /** A picture or PDF fetched directly. */
  file?: { data: Buffer; mime: string };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (html: string): string =>
  decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function meta(html: string, ...names: string[]): string {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name.replace(':', '\\:')}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decodeEntities(content).trim();
  }
  return '';
}

/** The page's readable text: the article or main element, without scripts and chrome. */
export function readableText(html: string): string {
  const cleaned = html.replace(/<(script|style|noscript|svg|nav|header|footer|form|aside|iframe|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const main = cleaned.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? cleaned.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? cleaned.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? cleaned;
  return stripTags(main).slice(0, 15_000);
}

const OEMBED: { test: RegExp; endpoint: (u: string) => string; kind: CaptureKind; site: string }[] = [
  { test: /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\/[^/]+\/status\/\d+/i, endpoint: (u) => `https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(u)}`, kind: 'tweet', site: 'X' },
  { test: /^https?:\/\/(www\.|vm\.|vt\.)?tiktok\.com\//i, endpoint: (u) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}`, kind: 'video', site: 'TikTok' },
  { test: /^https?:\/\/((www|m)\.)?(youtube\.com\/(watch|shorts)|youtu\.be\/)/i, endpoint: (u) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}`, kind: 'video', site: 'YouTube' },
  { test: /^https?:\/\/(www\.)?vimeo\.com\/\d+/i, endpoint: (u) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(u)}`, kind: 'video', site: 'Vimeo' },
];

export async function extract(url: string): Promise<Extracted> {
  const known = OEMBED.find((o) => o.test.test(url));
  if (known) {
    try {
      const res = await safeFetch(known.endpoint(url), { accept: 'application/json', maxBytes: 500_000 });
      if (res.status === 200) {
        const o = JSON.parse(res.body.toString('utf8')) as { title?: string; author_name?: string; html?: string; thumbnail_url?: string };
        const text = o.html ? stripTags(o.html.replace(/<a[^>]*>(pic\.twitter\.com|https?:\/\/t\.co)[^<]*<\/a>/gi, '')) : '';
        return {
          kind: known.kind,
          title: o.title?.trim() || (known.kind === 'tweet' ? `${o.author_name ?? 'Post'} on X` : known.site),
          description: '',
          site: known.site,
          author: o.author_name ?? '',
          text: known.kind === 'tweet' ? text.replace(/—\s*[^—]*$/, '').trim() : text,
          imageUrl: o.thumbnail_url ?? null,
        };
      }
    } catch {
      // Fall back to reading the page itself.
    }
  }

  const res = await safeFetch(url, { maxBytes: MAX_IMAGE });
  if (res.status >= 400) throw new FetchError(`The site answered ${res.status}`);
  const host = new URL(res.url).hostname.replace(/^www\./, '');
  const type = res.contentType.split(';')[0]!.trim();
  if (RASTER.has(type)) return { kind: 'image', title: decodeURIComponent(new URL(res.url).pathname.split('/').pop() || host), description: '', site: host, author: '', text: '', imageUrl: null, file: { data: res.body, mime: type } };
  if (type === 'application/pdf') return { kind: 'pdf', title: decodeURIComponent(new URL(res.url).pathname.split('/').pop() || host), description: '', site: host, author: '', text: '', imageUrl: null, file: { data: res.body, mime: type } };
  if (!/html|xml|text\/plain/.test(type)) return { kind: 'link', title: host, description: '', site: host, author: '', text: '', imageUrl: null };

  const html = res.body.toString('utf8');
  if (type === 'text/plain') return { kind: 'article', title: host, description: '', site: host, author: '', text: html.slice(0, 15_000), imageUrl: null };
  const title = meta(html, 'og:title', 'twitter:title') || decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim() || host;
  const ogType = meta(html, 'og:type');
  const image = meta(html, 'og:image', 'og:image:url', 'twitter:image');
  return {
    kind: /video/.test(ogType) ? 'video' : /article/.test(ogType) || /<article/i.test(html) ? 'article' : 'link',
    title: title.slice(0, 300),
    description: meta(html, 'og:description', 'description', 'twitter:description').slice(0, 1000),
    site: meta(html, 'og:site_name') || host,
    author: meta(html, 'author', 'article:author', 'twitter:creator'),
    text: readableText(html),
    imageUrl: image ? new URL(image, res.url).toString() : null,
  };
}

async function fetchThumbnail(store: Store, url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await safeFetch(url, { maxBytes: 3_000_000, accept: 'image/*' });
    const type = res.contentType.split(';')[0]!.trim();
    return res.status === 200 && RASTER.has(type) ? saveFile(store, res.body, type, 'thumbnail') : null;
  } catch {
    return null;
  }
}

// ── Organising ──────────────────────────────────────────────────────────────

const Organised = z.object({
  title: z.string().max(200),
  kind: z.enum(['tweet', 'video', 'article', 'image', 'pdf', 'link', 'text']),
  summary: z.string().max(600),
  key_points: z.array(z.string().max(300)).max(6),
  tags: z.array(z.string().max(30)).max(6),
  sphere: z.string().nullable(),
  collection: z.string().max(40).nullable(),
  task: z.object({ title: z.string().max(200), due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }).nullable().optional(),
});

function collectionsInUse(store: Store): string[] {
  const rows = store.db.prepare("SELECT DISTINCT json_extract(capture, '$.collection') AS c FROM notes WHERE capture IS NOT NULL").all() as { c: string | null }[];
  return rows.map((r) => r.c).filter((c): c is string => !!c);
}

async function organise(store: Store, x: Extracted, url: string, userNote: string, image?: { data: Buffer; mime: string }) {
  const spheres = store.listSpheres().map((s) => s.name);
  const collections = collectionsInUse(store);
  return think({
    store,
    task: `Something was saved to the user's library${url ? ` from ${url}` : ''}. Organise it.
Return {"title": a clear title (rewrite clickbait plainly), "kind": one of tweet|video|article|image|pdf|link|text, "summary": 2-3 sentences on what it is and why someone would keep it, "key_points": up to 5 short takeaways (empty for a simple picture), "tags": 3-6 lowercase tags, "sphere": the best match from [${spheres.join(', ')}] or null, "collection": a short group name for browsing — reuse one of [${collections.join(', ')}] when it fits, else a new one like "Recipes" or "Design inspiration", "task": only if it contains something to act on (an event, a deadline, a booking, something to buy) give {"title", "due_date"}, else null}.`,
    input: [
      userNote ? `Note from the user (trusted): ${userNote}` : '',
      wrapUntrusted('saved item', [`site: ${x.site}`, `author: ${x.author}`, `title: ${x.title}`, `description: ${x.description}`, '', x.text].join('\n'), 12_000),
    ]
      .filter(Boolean)
      .join('\n\n'),
    images: image && RASTER.has(image.mime) && image.data.length < 5_000_000 ? [{ mediaType: image.mime, data: image.data.toString('base64') }] : undefined,
    schema: Organised,
  });
}

// ── The pipeline ────────────────────────────────────────────────────────────

let queue: Promise<unknown> = Promise.resolve();
/** Resolves once every capture queued so far has been processed (for tests). */
export function capturesSettled(): Promise<unknown> {
  return queue;
}

function setCapture(store: Store, id: string, fields: { title?: string; body?: string; sphereId?: string | null; status: Note['status']; capture: CaptureMeta }): void {
  store.db
    .prepare('UPDATE notes SET title = COALESCE(?, title), body = COALESCE(?, body), sphere_id = COALESCE(?, sphere_id), status = ?, capture = ?, updated_at = ? WHERE id = ?')
    .run(fields.title ?? null, fields.body ?? null, fields.sphereId ?? null, fields.status, JSON.stringify(fields.capture), nowIso(), id);
}

async function process(store: Store, id: string, input: { url?: string; text?: string; file?: { data: Buffer; mime: string } }, via: string): Promise<void> {
  const base: CaptureMeta = { kind: 'link', site: '', author: '', imageFileId: null, summary: '', keyPoints: [], tags: [], collection: '', via };
  const userNote = input.url ? (input.text ?? '') : '';
  let x: Extracted;
  try {
    if (input.file) {
      x = { kind: input.file.mime === 'application/pdf' ? 'pdf' : 'image', title: 'Saved picture', description: '', site: '', author: '', text: '', imageUrl: null, file: input.file };
    } else if (input.url) {
      x = await extract(input.url);
    } else {
      x = { kind: 'text', title: (input.text ?? '').split('\n')[0]!.slice(0, 80), description: '', site: '', author: '', text: input.text ?? '', imageUrl: null };
    }
  } catch (err) {
    setCapture(store, id, { status: 'failed', capture: { ...base, error: err instanceof Error ? err.message : String(err) } });
    return;
  }

  const imageFileId = x.file && RASTER.has(x.file.mime) ? saveFile(store, x.file.data, x.file.mime, x.title) : await fetchThumbnail(store, x.imageUrl);
  let meta: CaptureMeta = { ...base, kind: x.kind, site: x.site, author: x.author, imageFileId, summary: x.description };
  let title = x.title;
  let sphereId: string | null = null;
  try {
    const o = await organise(store, x, input.url ?? '', userNote, x.file);
    title = o.title || title;
    meta = { ...meta, kind: o.kind, summary: o.summary, keyPoints: o.key_points, tags: o.tags.map((t) => t.toLowerCase()), collection: o.collection ?? '' };
    sphereId = store.listSpheres().find((s) => s.name.toLowerCase() === (o.sphere ?? '').toLowerCase())?.id ?? null;
    if (o.task) {
      addSignal(store, {
        source: 'capture',
        kind: 'saved',
        externalId: id,
        title: `From something you saved: ${o.task.title}`,
        body: o.summary,
        url: input.url ?? '',
        sphereId,
        actions: [{ type: 'task', label: 'Add as a task', title: o.task.title, dueDate: o.task.due_date ?? null, sphereId }, ...(input.url ? [{ type: 'link' as const, label: 'Open', url: input.url }] : [])],
      });
    }
  } catch (err) {
    // Without a brain, keep what the page said about itself.
    if (!(err instanceof NoBrain)) meta.error = `Saved, but could not be organised: ${err instanceof Error ? err.message : String(err)}`;
  }
  const body = [meta.summary, ...meta.keyPoints.map((p) => `• ${p}`), userNote ? `\n${userNote}` : ''].filter(Boolean).join('\n');
  setCapture(store, id, { title, body: input.file || input.url ? body : undefined, sphereId, status: 'ready', capture: meta });
}

/** Save something and read it in the background. Returns the note straight away. */
export function capture(store: Store, input: { url?: string; text?: string; file?: { data: Buffer; mime: string; name?: string } }, via: string): Note {
  let url = input.url?.trim();
  let text = input.text?.trim() ?? '';
  // Shared text often carries the link inside it.
  if (!url && text) {
    const found = text.match(/https?:\/\/[^\s<>"']+/i)?.[0];
    if (found) {
      url = found.replace(/[).,!?]+$/, '');
      text = text.replace(found, '').trim();
    }
  }
  if (input.file) {
    if (!RASTER.has(input.file.mime) && input.file.mime !== 'application/pdf') throw new Invalid('Pictures (PNG, JPEG, GIF, WebP) and PDFs can be saved.');
    if (input.file.data.length > MAX_IMAGE) throw new Invalid('That file is too large (8 MB at most).');
  } else if (!url && !text) {
    throw new Invalid('Send a link, some text or a picture.');
  }
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    } catch {
      throw new Invalid('That is not a link Terminus can open.');
    }
  }

  const id = newId();
  const now = nowIso();
  const pending: CaptureMeta = { kind: input.file ? 'image' : url ? 'link' : 'text', site: url ? new URL(url).hostname.replace(/^www\./, '') : '', author: '', imageFileId: null, summary: '', keyPoints: [], tags: [], collection: '', via };
  store.db
    .prepare("INSERT INTO notes (id, kind, title, body, url, created_at, updated_at, capture, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing')")
    .run(id, url ? 'link' : 'note', url ? pending.site : input.file ? (input.file.name ?? 'Saved picture') : text.split('\n')[0]!.slice(0, 80), url ? text : text, url ?? '', now, now, JSON.stringify(pending));
  store.record('created', 'note', id, null, `Saved ${url ? `a link from ${pending.site}` : input.file ? 'a picture' : 'a note'}`);
  const job = queue.then(() => process(store, id, { url, text, file: input.file }, via)).catch(() => undefined);
  queue = job;
  return store.getNote(id);
}

// ── Capture tokens (for iOS Shortcuts and other apps) ───────────────────────

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export function newCaptureToken(store: Store): string {
  const token = `tc_${randomBytes(24).toString('base64url')}`;
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('capture_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(sha(token)));
  return token;
}

/** True when the request carries the capture token (Authorization: Bearer …). */
export function hasCaptureToken(store: Store, c: Context): boolean {
  const header = c.req.header('authorization') ?? '';
  const token = header.match(/^Bearer\s+(tc_[A-Za-z0-9_-]+)$/)?.[1];
  if (!token) return false;
  const r = store.db.prepare("SELECT value FROM settings WHERE key = 'capture_token'").get() as { value: string } | undefined;
  if (!r) return false;
  const want = Buffer.from(JSON.parse(r.value) as string);
  const got = Buffer.from(sha(token));
  return want.length === got.length && timingSafeEqual(want, got);
}

async function fileFrom(form: FormData): Promise<{ data: Buffer; mime: string; name: string } | undefined> {
  const f = form.get('file');
  if (!f || typeof f === 'string') return undefined;
  return { data: Buffer.from(await f.arrayBuffer()), mime: f.type, name: f.name };
}

registerFeature({
  id: 'capture',
  tools: [
    tool(
      'save_link',
      'Save a link (or a short piece of text) to the library. Seldon reads it in the background and files it with a summary, tags and a collection. Call this when the user shares a link and wants it kept, or says "save this".',
      z.object({ url: z.string().max(2000).describe('The link'), note: z.string().max(1000).optional().describe('Why they are saving it, in their words') }),
      ({ url, note }, { store }) => {
        const n = capture(store, { url, text: note }, 'seldon');
        return { data: { ok: true, id: n.id, status: 'reading it now' }, summary: `Saving ${n.title}` };
      },
    ),
  ],
  routes: (app, { store }) => {
    app.post('/api/capture', async (c) => {
      const type = c.req.header('content-type') ?? '';
      if (type.includes('multipart/form-data')) {
        const form = await c.req.formData();
        const file = await fileFrom(form);
        const text = [form.get('title'), form.get('text'), form.get('url')].filter((v): v is string => typeof v === 'string' && !!v).join('\n');
        return c.json(capture(store, { file, text }, String(form.get('via') ?? 'app')), 201);
      }
      const input = await read(c, z.object({ url: z.string().max(2000).optional(), text: z.string().max(20_000).optional(), via: z.string().max(20).optional() }));
      return c.json(capture(store, input, input.via ?? 'app'), 201);
    });
    // The installed app's share target (Android): the OS posts here, then we show the Library.
    app.post('/api/share', async (c) => {
      const form = await c.req.formData();
      const file = await fileFrom(form);
      const text = [form.get('title'), form.get('text'), form.get('url')].filter((v): v is string => typeof v === 'string' && !!v).join('\n');
      try {
        capture(store, { file, text }, 'share');
      } catch {
        // Nothing usable was shared; land on the Library anyway.
      }
      return c.redirect('/library?shared=1', 303);
    });
    app.post('/api/capture/token', (c) => c.json({ token: newCaptureToken(store) }));
    app.get('/api/capture/collections', (c) => c.json(collectionsInUse(store).sort()));
    app.post('/api/notes/:id/reprocess', (c) => {
      const n = store.getNote(c.req.param('id'));
      if (!n.capture) throw new Invalid('Only saved links can be read again.');
      store.db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
      return c.json(capture(store, { url: n.url || undefined, text: n.url ? '' : n.body }, n.capture.via), 201);
    });
    app.get('/api/files/:id', (c) => {
      const f = getFile(store, c.req.param('id'));
      if (!f) throw new NotFound('File');
      const safe = RASTER.has(f.mime);
      return c.body(Buffer.from(f.data), 200, {
        'content-type': safe ? f.mime : 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=31536000, immutable',
        'content-security-policy': "default-src 'none'",
        ...(safe ? {} : { 'content-disposition': `attachment; filename="${f.name.replace(/[^\w.-]+/g, '_') || 'file'}"` }),
      });
    });
  },
});
