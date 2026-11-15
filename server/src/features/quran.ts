// Quran study: a place in the mushaf, the ayah there with its translation and a tafsir,
// a log of ayat studied, and reflections kept as notes in the Faith sphere.
//
// Text, translation (M.A.S. Abdel Haleem) and tafsir come from quran.com's public API,
// fetched by the server and kept in memory, so the page never shows Quran text that did
// not come from that source.

import { z } from 'zod';
import { registerSnapshotSection } from '../agent/snapshot-hooks.ts';
import { read, today as todayOf } from '../http.ts';
import { addDays, Invalid, NotFound, nowIso, type Store } from '../store.ts';
import type { Note, QuranChapter, QuranStudy, QuranTheme, QuranThemes, QuranVerse, TafsirBlock } from '../../../shared/types.ts';
import { NoBrain, think, wrapUntrusted } from '../agent/think.ts';
import { registerFeature } from './registry.ts';

const API = 'https://api.quran.com/api/v4';
const TRANSLATION = { id: 85, name: 'M.A.S. Abdel Haleem' };
export const TAFSIRS = [
  { id: 169, name: 'Ibn Kathir (Abridged)' },
  { id: 168, name: 'Maʿarif al-Qurʾan' },
  { id: 817, name: 'Tazkirul Quran' },
];

/** Tests swap the network for a fake. */
let net: typeof fetch = (...args) => fetch(...args);
export function setQuranFetch(f: typeof fetch | null): void {
  net = f ?? ((...args) => fetch(...args));
  chapterCache = null;
  verseCache.clear();
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await net(`${API}${path}`, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json', 'user-agent': 'Terminus (personal Quran study)' } });
  } catch {
    throw new Unavailable();
  }
  if (!res.ok) throw new Unavailable();
  return (await res.json()) as T;
}

export class Unavailable extends Error {
  constructor() {
    super('quran.com could not be reached just now. Try again in a moment.');
  }
}

// ── Chapters ────────────────────────────────────────────────────────────────

let chapterCache: QuranChapter[] | null = null;

export async function chapters(): Promise<QuranChapter[]> {
  if (chapterCache) return chapterCache;
  const d = await getJson<{ chapters: { id: number; name_simple: string; name_arabic: string; verses_count: number; translated_name: { name: string } }[] }>(
    '/chapters?language=en',
  );
  chapterCache = d.chapters.map((c) => ({ id: c.id, name: c.name_simple, nameArabic: c.name_arabic, meaning: c.translated_name.name, verses: c.verses_count }));
  return chapterCache;
}

export function parseKey(key: string): { surah: number; ayah: number } {
  const m = /^(\d{1,3}):(\d{1,3})$/.exec(key.trim());
  if (!m) throw new Invalid('An ayah is written surah:ayah, like 2:255');
  return { surah: Number(m[1]), ayah: Number(m[2]) };
}

/** Check a place against the mushaf: a real surah, and an ayah within it. */
async function checkKey(key: string): Promise<{ surah: number; ayah: number; key: string }> {
  const { surah, ayah } = parseKey(key);
  const list = await chapters();
  const ch = list[surah - 1];
  if (!ch) throw new Invalid('There are 114 surahs');
  if (ayah < 1 || ayah > ch.verses) throw new Invalid(`${ch.name} has ${ch.verses} ayat`);
  return { surah, ayah, key: `${surah}:${ayah}` };
}

/** The ayah after this one, on into the next surah; after the last, back to the first. */
export function nextKey(list: QuranChapter[], surah: number, ayah: number): string {
  if (ayah < list[surah - 1]!.verses) return `${surah}:${ayah + 1}`;
  return surah < 114 ? `${surah + 1}:1` : '1:1';
}

// ── Verses and tafsir ───────────────────────────────────────────────────────

const verseCache = new Map<string, QuranVerse>();

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
const strip = (s: string) => decode(s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim();
const ARABIC = /[؀-ۿ]/g;

/** quran.com's tafsir HTML as plain blocks: no markup reaches the page. */
export function tafsirBlocks(html: string): TafsirBlock[] {
  const out: TafsirBlock[] = [];
  const re = /<(h[1-6]|p|div|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = re.exec(html))) {
    found = true;
    const text = strip(m[2]!);
    if (!text) continue;
    const letters = text.replace(/[\s\d\p{P}]/gu, '');
    const arabic = (text.match(ARABIC) ?? []).length;
    const kind: TafsirBlock['kind'] = /^h/i.test(m[1]!) ? 'h' : letters && arabic / letters.length > 0.6 ? 'ar' : 'p';
    out.push({ kind, text });
  }
  if (!found) for (const para of strip(html).split(/\n{2,}/)) if (para.trim()) out.push({ kind: 'p', text: para.trim() });
  return out;
}

export async function verse(key: string, tafsirId: number): Promise<QuranVerse> {
  const k = await checkKey(key);
  const tafsir = TAFSIRS.find((t) => t.id === tafsirId) ?? TAFSIRS[0]!;
  const cacheKey = `${k.key}|${tafsir.id}`;
  const hit = verseCache.get(cacheKey);
  if (hit) return hit;
  const [v, t] = await Promise.all([
    getJson<{ verse: { text_uthmani: string; translations?: { text: string }[] } }>(`/verses/by_key/${k.key}?fields=text_uthmani&translations=${TRANSLATION.id}`),
    getJson<{ tafsir: { text: string; verses: Record<string, unknown> } }>(`/tafsirs/${tafsir.id}/by_ayah/${k.key}`).catch(() => null),
  ]);
  const out: QuranVerse = {
    key: k.key,
    surah: k.surah,
    ayah: k.ayah,
    arabic: v.verse.text_uthmani.trim(),
    // Translations carry footnote markers as <sup> tags; the words are kept, the markup dropped.
    translation: strip((v.verse.translations?.[0]?.text ?? '').replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '')),
    translator: TRANSLATION.name,
    tafsir: t?.tafsir?.text ? { id: tafsir.id, name: tafsir.name, covers: Object.keys(t.tafsir.verses ?? {}), blocks: tafsirBlocks(t.tafsir.text) } : null,
  };
  if (verseCache.size > 400) verseCache.delete(verseCache.keys().next().value!);
  verseCache.set(cacheKey, out);
  return out;
}

// ── Study state ─────────────────────────────────────────────────────────────

interface Saved {
  surah: number;
  ayah: number;
  tafsir: number;
}
const DEFAULTS: Saved = { surah: 1, ayah: 1, tafsir: 169 };

function getSaved(store: Store): Saved {
  const r = store.db.prepare("SELECT value FROM settings WHERE key = 'quran-study'").get() as { value: string } | undefined;
  return { ...DEFAULTS, ...(r ? (JSON.parse(r.value) as Partial<Saved>) : {}) };
}

function save(store: Store, s: Saved): void {
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('quran-study', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));
}

function monday(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

export function studyState(store: Store, today: string): QuranStudy {
  const s = getSaved(store);
  const key = `${s.surah}:${s.ayah}`;
  const one = (sql: string, ...p: string[]) => (store.db.prepare(sql).get(...p) as { n: number }).n;
  const days = new Set((store.db.prepare('SELECT DISTINCT date FROM quran_study_log WHERE date >= ?').all(addDays(today, -400)) as { date: string }[]).map((r) => r.date));
  // A streak still stands on a day not yet studied, until that day is over.
  let streak = 0;
  for (let d = days.has(today) ? today : addDays(today, -1); days.has(d); d = addDays(d, -1)) streak++;
  return {
    surah: s.surah,
    ayah: s.ayah,
    key,
    tafsir: s.tafsir,
    tafsirs: TAFSIRS,
    studiedToday: one('SELECT COUNT(*) AS n FROM quran_study_log WHERE verse_key = ? AND date = ?', key, today) > 0,
    week: one('SELECT COUNT(DISTINCT verse_key) AS n FROM quran_study_log WHERE date >= ? AND date <= ?', monday(today), today),
    total: one('SELECT COUNT(DISTINCT verse_key) AS n FROM quran_study_log'),
    streak,
  };
}

export async function moveTo(store: Store, key: string): Promise<void> {
  const k = await checkKey(key);
  save(store, { ...getSaved(store), surah: k.surah, ayah: k.ayah });
}

/** Mark an ayah studied today, and move on to the one after it. */
export async function markStudied(store: Store, key: string, today: string): Promise<void> {
  const k = await checkKey(key);
  store.db.prepare('INSERT OR IGNORE INTO quran_study_log (verse_key, date, created_at) VALUES (?,?,?)').run(k.key, today, nowIso());
  const s = getSaved(store);
  if (s.surah === k.surah && s.ayah === k.ayah) {
    const next = parseKey(nextKey(await chapters(), k.surah, k.ayah));
    save(store, { ...s, surah: next.surah, ayah: next.ayah });
  }
}

// ── Reflections ─────────────────────────────────────────────────────────────

const ayahUrl = (key: string) => `https://quran.com/${key}`;

function faithSphere(store: Store): string | null {
  const r = store.db.prepare("SELECT id FROM spheres WHERE key = 'faith' AND archived = 0").get() as { id: string } | undefined;
  return r?.id ?? null;
}

export function reflections(store: Store, key: string): Note[] {
  const { surah, ayah } = parseKey(key);
  const ids = store.db.prepare("SELECT id FROM notes WHERE url = ? AND kind = 'note' ORDER BY created_at DESC").all(ayahUrl(`${surah}:${ayah}`)) as { id: string }[];
  return ids.map((r) => store.getNote(r.id));
}

export async function addReflection(store: Store, key: string, text: string): Promise<Note> {
  const k = await checkKey(key);
  const ch = (await chapters())[k.surah - 1]!;
  if (!text.trim()) throw new Invalid('Write a few words first');
  return store.createNote({ kind: 'note', title: `Reflection on ${ch.name} ${k.key}`, body: text.trim(), url: ayahUrl(k.key), sphereId: faithSphere(store) });
}

// ── Themes ──────────────────────────────────────────────────────────────────

const THEME_KINDS = ['meaning', 'context', 'lesson', 'virtue', 'language', 'ruling'] as const;
const themeSchema = z.object({
  themes: z
    .array(z.object({ kind: z.enum(THEME_KINDS), title: z.string().min(1).max(80), summary: z.string().min(1).max(600) }))
    .min(1)
    .max(6),
});
/** Themes being written right now, so two asks for one passage share one model call. */
const writing = new Map<string, Promise<QuranTheme[]>>();

/**
 * The tafsir passage on this ayah, drawn into a few themes by the background model. The model
 * sees only the passage (as data), is told to add nothing it doesn't say, and to attribute
 * views to the commentator. A passage covering several ayat is written once for all of them.
 */
export async function themes(store: Store, key: string, tafsirId: number): Promise<QuranThemes> {
  const v = await verse(key, tafsirId);
  const t = v.tafsir;
  if (!t || !t.blocks.length) return { status: 'none', reason: 'This tafsir has no passage on this ayah.' };
  const passage = t.covers[0] ?? v.key;
  const cached = store.db.prepare('SELECT themes FROM quran_themes WHERE passage = ? AND tafsir = ?').get(passage, t.id) as { themes: string } | undefined;
  if (cached) return { status: 'ready', tafsir: t.name, covers: t.covers, themes: JSON.parse(cached.themes) as QuranTheme[] };

  const id = `${passage}|${t.id}`;
  let job = writing.get(id);
  if (!job) {
    const ch = (await chapters())[v.surah - 1]!;
    const span = t.covers.length > 1 ? `${t.covers[0]}–${t.covers.at(-1)!.split(':')[1]}` : v.key;
    const text = t.blocks.map((b) => (b.kind === 'h' ? `## ${b.text}` : b.text)).join('\n\n');
    job = think({
      store,
      task:
        `Below is the commentary "${t.name}" on Quran ${span} (Surah ${ch.name}). Draw out the 3 to 5 main themes it discusses, for someone studying these ayat. ` +
        `Use only what this commentary says. Do not add Quranic verses, hadith, rulings, scholars or opinions that it does not contain, and do not quote Arabic. ` +
        `Where it reports a view or a narration, say whose it is as the commentary does (for example "Ibn Kathir notes…" or "a narration from Abu Hurayrah…"). ` +
        `For each theme give: kind (one of ${THEME_KINDS.join(', ')}: meaning = what the words mean; context = when or why it was revealed, or where it sits; ` +
        `lesson = guidance for living; virtue = the merit of reciting or knowing it; language = a word or grammar point; ruling = a legal point), ` +
        `title (2 to 6 words), and summary (one or two plain sentences). Reply as {"themes": [{"kind": "...", "title": "...", "summary": "..."}]}.`,
      input: wrapUntrusted(`${t.name} on ${span}`, text, 30_000),
      schema: themeSchema,
      signal: AbortSignal.timeout(60_000),
    }).then((out) => {
      store.db.prepare('INSERT OR REPLACE INTO quran_themes (passage, tafsir, themes, created_at) VALUES (?,?,?,?)').run(passage, t.id, JSON.stringify(out.themes), nowIso());
      return out.themes;
    });
    writing.set(id, job);
    void job.finally(() => writing.delete(id)).catch(() => undefined);
  }
  try {
    return { status: 'ready', tafsir: t.name, covers: t.covers, themes: await job };
  } catch (err) {
    if (err instanceof NoBrain) return { status: 'none', reason: 'Connect a model for background work in Settings to see themes.' };
    if (err instanceof Unavailable) throw err;
    console.warn('[quran] could not draw themes:', err instanceof Error ? err.message : err);
    return { status: 'none', reason: 'Seldon couldn’t read this passage just now. Try again later.' };
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────

registerSnapshotSection<Store>('Quran study', (store, today) => {
  const r = store.db.prepare("SELECT 1 AS x FROM settings WHERE key = 'quran-study'").get();
  if (!r) return null;
  const s = studyState(store, today);
  const name = chapterCache?.[s.surah - 1]?.name;
  return `Studying the Quran, now at ${s.key}${name ? ` (${name})` : ''}. ${s.week} ayat studied this week, ${s.total} in all${s.streak > 1 ? `, ${s.streak}-day streak` : ''}.`;
});

const keyParam = z.string().regex(/^\d{1,3}:\d{1,3}$/, 'An ayah is written surah:ayah, like 2:255');

registerFeature({
  id: 'quran',
  tables: ['quran_study_log', 'quran_themes'],
  routes: (app, { store }) => {
    // quran.com being down is not the user's fault: say so plainly, as a 503.
    const guard = async (c: { json: (b: unknown, s?: number) => Response }, fn: () => Promise<unknown>) => {
      try {
        return c.json(await fn());
      } catch (err) {
        if (err instanceof Unavailable) return c.json({ error: err.message }, 503);
        throw err;
      }
    };
    app.get('/api/quran/chapters', (c) => guard(c, () => chapters()));
    app.get('/api/quran/verse', (c) => {
      const key = keyParam.safeParse(c.req.query('key'));
      if (!key.success) throw new Invalid('An ayah is written surah:ayah, like 2:255');
      return guard(c, () => verse(key.data, Number(c.req.query('tafsir')) || getSaved(store).tafsir));
    });
    app.get('/api/quran/themes', (c) => {
      const key = keyParam.safeParse(c.req.query('key'));
      if (!key.success) throw new Invalid('An ayah is written surah:ayah, like 2:255');
      return guard(c, () => themes(store, key.data, Number(c.req.query('tafsir')) || getSaved(store).tafsir));
    });
    app.get('/api/quran/study', (c) => c.json(studyState(store, todayOf(c))));
    app.put('/api/quran/study', async (c) => {
      const input = await read(c, z.object({ key: keyParam.optional(), tafsir: z.number().int().optional() }));
      return guard(c, async () => {
        if (input.key) await moveTo(store, input.key);
        if (input.tafsir !== undefined) {
          if (!TAFSIRS.some((t) => t.id === input.tafsir)) throw new Invalid('Unknown tafsir');
          save(store, { ...getSaved(store), tafsir: input.tafsir });
        }
        return studyState(store, todayOf(c));
      });
    });
    app.post('/api/quran/study/mark', async (c) => {
      const input = await read(c, z.object({ key: keyParam }));
      return guard(c, async () => {
        await markStudied(store, input.key, todayOf(c));
        return studyState(store, todayOf(c));
      });
    });
    app.get('/api/quran/reflections', (c) => {
      const key = keyParam.safeParse(c.req.query('key'));
      if (!key.success) throw new NotFound('Ayah');
      return c.json(reflections(store, key.data));
    });
    app.post('/api/quran/reflections', async (c) => {
      const input = await read(c, z.object({ key: keyParam, text: z.string().min(1).max(5000) }));
      return guard(c, () => addReflection(store, input.key, input.text));
    });
  },
});
