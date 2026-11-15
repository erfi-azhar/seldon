// Travel guides: a place you're researching, the materials you gather for it (links, notes,
// pictures, PDFs, read and filed by capture like anything else you save), and the guide Seldon
// builds from them: an overview, sections of things to see, do and eat (halal), areas, getting
// around, safety and the rest, and sample days, each item pointing back to the materials it
// came from.

import type { Context } from 'hono';
import { z } from 'zod';
import { think, wrapUntrusted } from '../agent/think.ts';
import { tool } from '../agent/tools.ts';
import { read } from '../http.ts';
import { Invalid, newId, NotFound, nowIso, type Store } from '../store.ts';
import type { Note, PlaceGuide, TravelGuide, TravelGuideSummary } from '../../../shared/types.ts';
import { capture } from './capture.ts';
import { registerFeature } from './registry.ts';

type Row = Record<string, unknown>;

const travelsSphere = (store: Store) => store.listSpheres().find((s) => s.key === 'travels')?.id ?? null;
const clean = (s: string | undefined | null, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function materials(store: Store, guideId: string): Note[] {
  const ids = store.db.prepare('SELECT note_id FROM travel_guide_notes WHERE guide_id = ? ORDER BY added_at').all(guideId) as { note_id: string }[];
  return ids.flatMap((r) => {
    try {
      return [store.getNote(r.note_id)];
    } catch {
      return [];
    }
  });
}

function fromRow(store: Store, r: Row): TravelGuide {
  return {
    id: String(r.id),
    place: String(r.place),
    notes: String(r.notes ?? ''),
    createdAt: String(r.created_at),
    builtAt: (r.built_at as string | null) ?? null,
    guide: r.guide ? (JSON.parse(String(r.guide)) as PlaceGuide) : null,
    materials: materials(store, String(r.id)),
  };
}

export function getGuide(store: Store, id: string): TravelGuide {
  const r = store.db.prepare('SELECT * FROM travel_guides WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new NotFound('Travel guide');
  return fromRow(store, r);
}

export function listGuides(store: Store): TravelGuideSummary[] {
  const rows = store.db
    .prepare('SELECT g.*, (SELECT COUNT(*) FROM travel_guide_notes n WHERE n.guide_id = g.id) AS materials FROM travel_guides g ORDER BY COALESCE(g.built_at, g.created_at) DESC')
    .all() as Row[];
  return rows.map((r) => ({ id: String(r.id), place: String(r.place), materials: Number(r.materials), builtAt: (r.built_at as string | null) ?? null, createdAt: String(r.created_at) }));
}

export function createGuide(store: Store, place: string, notes = ''): TravelGuide {
  const name = clean(place, 80);
  if (!name) throw new Invalid('Name the place');
  const id = newId();
  store.db.prepare('INSERT INTO travel_guides (id, place, notes, created_at) VALUES (?, ?, ?, ?)').run(id, name, clean(notes, 2000), nowIso());
  store.record('created', 'travel_guide', id, travelsSphere(store), `Started a travel guide for ${name}`);
  return getGuide(store, id);
}

export function updateGuide(store: Store, id: string, p: { place?: string; notes?: string }): TravelGuide {
  const g = getGuide(store, id);
  store.db.prepare('UPDATE travel_guides SET place = ?, notes = ? WHERE id = ?').run(clean(p.place ?? g.place, 80) || g.place, clean(p.notes ?? g.notes, 2000), id);
  return getGuide(store, id);
}

/** Add something to a guide's materials: it is saved and read like anything captured, filed under Travels. */
export function addMaterial(store: Store, guideId: string, input: { url?: string; text?: string; file?: { data: Buffer; mime: string; name?: string } }, via = 'app'): TravelGuide {
  getGuide(store, guideId);
  const note = capture(store, { ...input, typedInApp: via === 'app' }, via);
  const sphere = travelsSphere(store);
  if (sphere) store.updateNote(note.id, { sphereId: sphere });
  store.db.prepare('INSERT OR IGNORE INTO travel_guide_notes (guide_id, note_id, added_at) VALUES (?, ?, ?)').run(guideId, note.id, nowIso());
  return getGuide(store, guideId);
}

/** Link something already in the Library to a guide. */
export function linkMaterial(store: Store, guideId: string, noteId: string): TravelGuide {
  getGuide(store, guideId);
  store.getNote(noteId);
  store.db.prepare('INSERT OR IGNORE INTO travel_guide_notes (guide_id, note_id, added_at) VALUES (?, ?, ?)').run(guideId, noteId, nowIso());
  return getGuide(store, guideId);
}

/** Take a material off a guide; it stays in the Library. */
export function unlinkMaterial(store: Store, guideId: string, noteId: string): TravelGuide {
  store.db.prepare('DELETE FROM travel_guide_notes WHERE guide_id = ? AND note_id = ?').run(guideId, noteId);
  return getGuide(store, guideId);
}

const sectionKinds = ['see', 'do', 'food', 'areas', 'stay', 'transport', 'safety', 'money', 'etiquette', 'shopping', 'budget', 'tips'] as const;
const guideInput = z.object({
  overview: z.string().max(1200),
  bestTime: z.string().max(300).optional(),
  sections: z
    .array(
      z.object({
        kind: z.enum(sectionKinds),
        title: z.string().max(60),
        items: z.array(z.object({ name: z.string().max(100), text: z.string().max(500), sources: z.array(z.string()).max(6).optional() })).max(12),
      }),
    )
    .max(14),
  days: z.array(z.object({ title: z.string().max(80), items: z.array(z.string().max(240)).max(8) })).max(7).optional(),
});

/** Save a built guide, keeping only sources that are this guide's materials, and empty sections out. */
export function saveGuideContent(store: Store, id: string, g: z.infer<typeof guideInput>): TravelGuide {
  const known = new Set(getGuide(store, id).materials.map((m) => m.id));
  const tidy: PlaceGuide = {
    overview: clean(g.overview, 1200),
    bestTime: g.bestTime ? clean(g.bestTime, 300) : undefined,
    sections: g.sections
      .map((s) => ({
        kind: s.kind,
        title: clean(s.title, 60),
        items: s.items.filter((i) => i.name || i.text).map((i) => ({ name: clean(i.name, 100), text: clean(i.text, 500), sources: (i.sources ?? []).filter((x) => known.has(x)) })),
      }))
      .filter((s) => s.items.length),
    days: (g.days ?? []).map((d) => ({ title: clean(d.title, 80), items: d.items.map((x) => clean(x, 240)).filter(Boolean) })).filter((d) => d.items.length),
  };
  store.db.prepare('UPDATE travel_guides SET guide = ?, built_at = ? WHERE id = ?').run(JSON.stringify(tidy), nowIso(), id);
  return getGuide(store, id);
}

/** Build the guide from its materials (and what the model knows of the place, said as such). */
export async function buildGuide(store: Store, id: string): Promise<TravelGuide> {
  const g = getGuide(store, id);
  const ready = g.materials.filter((m) => m.status !== 'processing');
  const res = await think({
    store,
    task: `Build a travel guide for ${g.place} from the materials the traveller gathered (below, each with an id). Use them first: what they recommend, warn about and plan. Fill gaps with what you know, but keep to well-established facts and say when something should be checked.
Reply {"overview": 2–4 sentences on the place and what these materials suggest the trip is about, "bestTime": one line, "sections": [{"kind": ${sectionKinds.map((k) => `"${k}"`).join('|')}, "title", "items": [{"name", "text": one or two practical sentences, "sources": [ids of the materials it came from]}]}], "days": [{"title": "Day 1: …", "items": [stops in order]}] (1–4 sample days)}.
They are Muslim: food should say what is halal or how to check, and include where to pray. Lead with what the materials care about most. Put "safety" in whenever there is something real to know.`,
    input: [
      wrapUntrusted('the place', `${g.place}${g.notes ? `\nTheir notes: ${g.notes}` : ''}`, 2200),
      ready.length
        ? wrapUntrusted(
            'materials',
            ready
              .map((m) => {
                const c = m.capture;
                return [`[${m.id}] ${m.title}${m.url ? ` (${m.url})` : ''}`, c?.summary, c?.keyPoints?.length ? c.keyPoints.map((k) => `- ${k}`).join('\n') : '', m.body.slice(0, 1500)].filter(Boolean).join('\n');
              })
              .join('\n\n'),
            24_000,
          )
        : 'No materials yet: build from what you know, and say the guide will get better as they add research.',
    ].join('\n'),
    schema: guideInput,
  });
  return saveGuideContent(store, id, res);
}

async function materialFrom(c: Context): Promise<{ url?: string; text?: string; file?: { data: Buffer; mime: string; name: string } }> {
  if ((c.req.header('content-type') ?? '').includes('multipart/form-data')) {
    const form = await c.req.formData();
    const f = form.get('file');
    const text = [form.get('text'), form.get('url')].filter((v): v is string => typeof v === 'string' && !!v).join('\n');
    if (f && typeof f !== 'string') return { file: { data: Buffer.from(await f.arrayBuffer()), mime: f.type, name: f.name }, text };
    return { text };
  }
  return read(c, z.object({ url: z.string().max(2000).optional(), text: z.string().max(20_000).optional() }));
}

registerFeature({
  id: 'travel_guides',
  tables: ['travel_guides', 'travel_guide_notes'],
  routes: (app, { store }) => {
    app.get('/api/guides', (c) => c.json({ guides: listGuides(store) }));
    app.post('/api/guides', async (c) => {
      const { place, notes } = await read(c, z.object({ place: z.string().min(1).max(80), notes: z.string().max(2000).optional() }));
      return c.json(createGuide(store, place, notes), 201);
    });
    app.get('/api/guides/:id', (c) => c.json(getGuide(store, c.req.param('id'))));
    app.patch('/api/guides/:id', async (c) => c.json(updateGuide(store, c.req.param('id'), await read(c, z.object({ place: z.string().max(80).optional(), notes: z.string().max(2000).optional() })))));
    app.delete('/api/guides/:id', (c) => {
      const g = getGuide(store, c.req.param('id'));
      store.db.prepare('DELETE FROM travel_guides WHERE id = ?').run(g.id);
      return c.json({ ok: true });
    });
    app.post('/api/guides/:id/materials', async (c) => c.json(addMaterial(store, c.req.param('id'), await materialFrom(c)), 201));
    app.post('/api/guides/:id/materials/link', async (c) => {
      const { noteId } = await read(c, z.object({ noteId: z.string().min(1) }));
      return c.json(linkMaterial(store, c.req.param('id'), noteId));
    });
    app.delete('/api/guides/:id/materials/:noteId', (c) => c.json(unlinkMaterial(store, c.req.param('id'), c.req.param('noteId'))));
    app.post('/api/guides/:id/build', async (c) => c.json(await buildGuide(store.as('agent'), c.req.param('id'))));
    app.put('/api/guides/:id/guide', async (c) => c.json(saveGuideContent(store, c.req.param('id'), await read(c, guideInput))));
  },
  tools: [
    tool('list_travel_guides', 'List the places the user is building travel guides for, with how many materials each has and when it was last built.', z.object({}), (_, { store }) => {
      const g = listGuides(store);
      return { data: g, summary: `${g.length} travel guide${g.length === 1 ? '' : 's'}` };
    }),
    tool(
      'read_travel_guide',
      'Read one travel guide: the place, the user\'s notes, every material gathered for it (title, link, summary, key points, text) and the guide built so far.',
      z.object({ guide_id: z.string().min(1) }),
      ({ guide_id }, { store }) => {
        const g = getGuide(store, guide_id);
        return { data: { ...g, materials: g.materials.map((m) => ({ id: m.id, title: m.title, url: m.url, status: m.status, summary: m.capture?.summary, keyPoints: m.capture?.keyPoints, text: m.body.slice(0, 2000) })) }, summary: `Read the ${g.place} guide` };
      },
    ),
    tool('create_travel_guide', 'Start a travel guide for a place the user wants to research or visit.', z.object({ place: z.string().min(1).max(80), notes: z.string().max(2000).optional() }), ({ place, notes }, { store }) => {
      const g = createGuide(store, place, notes);
      return { data: { ok: true, id: g.id }, summary: `Started a guide for ${g.place}` };
    }),
    tool(
      'add_guide_material',
      'Add research to a travel guide: a link (it is read and summarised) or some text. It is also saved to the Library under Travels.',
      z.object({ guide_id: z.string().min(1), url: z.string().max(2000).optional(), text: z.string().max(20_000).optional() }),
      ({ guide_id, url, text }, { store }) => {
        const g = addMaterial(store, guide_id, { url, text }, 'seldon');
        return { data: { ok: true }, summary: `Added to the ${g.place} guide` };
      },
    ),
    tool(
      'save_travel_guide',
      'Save the built travel guide for a place, drawn from its materials (read_travel_guide first): an overview, the best time to go, sections (see, do, food with halal and prayer, areas, stay, transport, safety, money, etiquette, shopping, budget, tips) whose items cite the material ids they came from, and 1–4 sample days. Replaces the guide.',
      guideInput.extend({ guide_id: z.string().min(1) }),
      ({ guide_id, ...g }, { store }) => {
        const saved = saveGuideContent(store, guide_id, g);
        return { data: { ok: true }, summary: `Saved the ${saved.place} guide` };
      },
    ),
  ],
});
