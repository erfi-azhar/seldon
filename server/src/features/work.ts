// The Work board: the Work sphere as a project tracker. Each card is one piece of work (a PRD,
// a requirement) inside one of the Work projects. A card moves through stages on a kanban
// board, keeps the raw materials it came with (the PRD, meeting notes, recordings, Figma files,
// links), holds the breakdown of what the UX, UI and product design work is, and owns a
// timeline of to-dos. The to-dos are ordinary tasks in the card's project, so they show up
// with the rest of Work and on Today; work_card_tasks ties them to their card.

import { z } from 'zod';
import { registerSnapshotSection } from '../agent/snapshot-hooks.ts';
import { tool } from '../agent/tools.ts';
import { read } from '../http.ts';
import { Invalid, newId, NotFound, nowIso, registerUndo, type Store } from '../store.ts';
import type { Project, Task, WorkBreakdown, WorkCard, WorkCardDetail, WorkMaterial, WorkMaterialKind, WorkStage } from '../../../shared/types.ts';
import { registerFeature } from './registry.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export const STAGES: readonly WorkStage[] = ['intake', 'discovery', 'design', 'review', 'handoff', 'done'];
export const STAGE_LABEL: Record<WorkStage, string> = { intake: 'Intake', discovery: 'Discovery', design: 'Design', review: 'Review', handoff: 'Handoff', done: 'Done' };
const KINDS: readonly WorkMaterialKind[] = ['prd', 'notes', 'recording', 'figma', 'link', 'file'];
const KIND_LABEL: Record<WorkMaterialKind, string> = { prd: 'PRD', notes: 'Meeting notes', recording: 'Recording', figma: 'Figma', link: 'Link', file: 'File' };
const LISTS = ['goals', 'requirements', 'ux', 'ui', 'product', 'questions'] as const;

const stageSchema = z.enum(STAGES as [WorkStage, ...WorkStage[]]);
const kindSchema = z.enum(KINDS as [WorkMaterialKind, ...WorkMaterialKind[]]);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-01-31');
const lines = z.array(z.string().max(600)).max(60);

// ── Reading ─────────────────────────────────────────────────────────────────

function workSphereId(store: Store): string {
  const s = store.db.prepare("SELECT id FROM spheres WHERE key = 'work' AND archived = 0").get() as Row | undefined;
  if (!s) throw new Invalid('There is no Work sphere. Add it under Spheres first.');
  return s.id;
}

export function workProjects(store: Store): Project[] {
  return store.listProjects({ sphereId: workSphereId(store) });
}

function cleanBreakdown(raw: unknown): WorkBreakdown {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = {} as WorkBreakdown;
  for (const k of LISTS) {
    const v = src[k];
    out[k] = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 60) : [];
  }
  return out;
}

function cardFromRow(store: Store, r: Row): WorkCard {
  const counts = store.db
    .prepare('SELECT SUM(CASE WHEN t.done = 0 THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN t.done = 1 THEN 1 ELSE 0 END) AS done FROM work_card_tasks w JOIN tasks t ON t.id = w.task_id WHERE w.card_id = ?')
    .get(r.id) as Row;
  const next = store.db
    .prepare("SELECT t.title, t.due_date FROM work_card_tasks w JOIN tasks t ON t.id = w.task_id WHERE w.card_id = ? AND t.done = 0 ORDER BY COALESCE(t.due_date, '9999'), t.created_at LIMIT 1")
    .get(r.id) as Row | undefined;
  const project = r.project_id ? (store.db.prepare('SELECT name FROM projects WHERE id = ?').get(r.project_id) as Row | undefined) : undefined;
  let breakdown: WorkBreakdown;
  try {
    breakdown = cleanBreakdown(JSON.parse(r.breakdown));
  } catch {
    breakdown = cleanBreakdown({});
  }
  return {
    id: r.id,
    projectId: r.project_id,
    projectName: project?.name ?? null,
    title: r.title,
    summary: r.summary,
    breakdown,
    stage: r.stage,
    position: r.position,
    dueDate: r.due_date,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    materials: (store.db.prepare('SELECT COUNT(*) AS n FROM work_materials WHERE card_id = ?').get(r.id) as Row).n,
    tasksOpen: counts.open ?? 0,
    tasksDone: counts.done ?? 0,
    nextTask: next ? { title: next.title, dueDate: next.due_date } : null,
  };
}

const materialFromRow = (r: Row): WorkMaterial => ({ id: r.id, cardId: r.card_id, kind: r.kind, title: r.title, url: r.url, body: r.body, createdAt: r.created_at });

function cardRow(store: Store, id: string): Row {
  const r = store.db.prepare('SELECT * FROM work_cards WHERE id = ? AND archived = 0').get(id) as Row | undefined;
  if (!r) throw new NotFound('Work card');
  return r;
}

/** Every card on the board, by stage and then where it sits in its column. */
export function listCards(store: Store): WorkCard[] {
  const rows = store.db.prepare('SELECT * FROM work_cards WHERE archived = 0 ORDER BY position, created_at').all() as Row[];
  return rows.map((r) => cardFromRow(store, r)).sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || a.position - b.position);
}

/** Open to-dos by date (undated after), then the done ones, oldest first. */
function timelineOrder(a: Task, b: Task): number {
  if (a.done !== b.done) return a.done ? 1 : -1;
  const da = a.dueDate ?? '9999';
  const db = b.dueDate ?? '9999';
  return da < db ? -1 : da > db ? 1 : a.createdAt.localeCompare(b.createdAt);
}

export function getCard(store: Store, id: string): WorkCardDetail {
  const card = cardFromRow(store, cardRow(store, id));
  const materials = (store.db.prepare('SELECT * FROM work_materials WHERE card_id = ? ORDER BY created_at').all(id) as Row[]).map(materialFromRow);
  const ids = (store.db.prepare('SELECT task_id FROM work_card_tasks WHERE card_id = ?').all(id) as Row[]).map((r) => r.task_id as string);
  const tasks = ids.map((t) => store.getTask(t)).sort(timelineOrder);
  return { card, materials, tasks };
}

// ── Writing ─────────────────────────────────────────────────────────────────

/** A Work project by id, or by name (made when it doesn't exist yet). */
function resolveProject(store: Store, project: string | null | undefined): string | null {
  if (!project) return null;
  const sphereId = workSphereId(store);
  const byId = store.db.prepare('SELECT id, sphere_id FROM projects WHERE id = ?').get(project) as Row | undefined;
  if (byId) {
    if (byId.sphere_id !== sphereId) throw new Invalid('That project is not in the Work sphere');
    return byId.id;
  }
  return store.createProject({ sphereId, name: project }).id;
}

const endOf = (store: Store, stage: WorkStage): number =>
  ((store.db.prepare('SELECT MAX(position) AS p FROM work_cards WHERE stage = ? AND archived = 0').get(stage) as Row).p ?? 0) + 1;

export interface CardInput {
  title: string;
  /** A project id, or the name of a Work project (made when new). */
  project?: string | null;
  summary?: string;
  breakdown?: Partial<WorkBreakdown>;
  dueDate?: string | null;
  stage?: WorkStage;
}

export function createCard(store: Store, input: CardInput): WorkCard {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new Invalid('A card needs a title');
  const stage = input.stage ?? 'intake';
  return store.tx(() => {
    const projectId = resolveProject(store, input.project);
    const id = newId();
    const now = nowIso();
    store.db
      .prepare('INSERT INTO work_cards (id, project_id, title, summary, breakdown, stage, position, due_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, title, (input.summary ?? '').trim().slice(0, 4000), JSON.stringify(cleanBreakdown(input.breakdown)), stage, endOf(store, stage), input.dueDate ?? null, now, now);
    store.record('created', 'work_card', id, workSphereId(store), `New work: ${title}`);
    return cardFromRow(store, cardRow(store, id));
  });
}

registerUndo('created:work_card', (db, id) => void db.prepare('DELETE FROM work_cards WHERE id = ?').run(id));

export interface CardPatch {
  title?: string;
  project?: string | null;
  summary?: string;
  /** Lists given here replace the card's; lists left out stay as they are. */
  breakdown?: Partial<WorkBreakdown>;
  dueDate?: string | null;
  stage?: WorkStage;
  position?: number;
}

export function updateCard(store: Store, id: string, patch: CardPatch): WorkCard {
  return store.tx(() => {
    const r = cardRow(store, id);
    const next: Row = { ...r };
    if (patch.title !== undefined) next.title = patch.title.trim().slice(0, 200) || r.title;
    if (patch.project !== undefined) next.project_id = resolveProject(store, patch.project);
    if (patch.summary !== undefined) next.summary = patch.summary.trim().slice(0, 4000);
    if (patch.breakdown !== undefined) {
      const current = cardFromRow(store, r).breakdown;
      next.breakdown = JSON.stringify(cleanBreakdown({ ...current, ...patch.breakdown }));
    }
    if (patch.dueDate !== undefined) next.due_date = patch.dueDate;
    if (patch.stage !== undefined && patch.stage !== r.stage) {
      next.stage = patch.stage;
      // A card moved to another column goes to its end, unless told where.
      if (patch.position === undefined) next.position = endOf(store, patch.stage);
    }
    if (patch.position !== undefined) next.position = patch.position;
    store.db
      .prepare('UPDATE work_cards SET title = ?, project_id = ?, summary = ?, breakdown = ?, stage = ?, position = ?, due_date = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.project_id, next.summary, next.breakdown, next.stage, next.position, next.due_date, nowIso(), id);
    if (patch.stage !== undefined && patch.stage !== r.stage) store.record('updated', 'work_card', id, workSphereId(store), `${next.title}: moved to ${STAGE_LABEL[patch.stage]}`);
    return cardFromRow(store, cardRow(store, id));
  });
}

/** Take a card off the board. Its to-dos stay, in its project. */
export function deleteCard(store: Store, id: string): void {
  if (store.db.prepare('DELETE FROM work_cards WHERE id = ?').run(id).changes === 0) throw new NotFound('Work card');
}

export interface MaterialInput {
  kind: WorkMaterialKind;
  title?: string;
  url?: string;
  body?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function addMaterial(store: Store, cardId: string, input: MaterialInput): WorkMaterial {
  const card = cardRow(store, cardId);
  const url = (input.url ?? '').trim();
  const body = (input.body ?? '').trim();
  if (!url && !body) throw new Invalid('A material needs a link or some text');
  if (url && !/^https?:\/\//i.test(url)) throw new Invalid('Links start with http:// or https://');
  const title = (input.title ?? '').trim().slice(0, 200) || (url ? hostOf(url) : '') || KIND_LABEL[input.kind];
  const id = newId();
  store.db.prepare('INSERT INTO work_materials (id, card_id, kind, title, url, body, created_at) VALUES (?,?,?,?,?,?,?)').run(id, cardId, input.kind, title, url, body, nowIso());
  store.db.prepare('UPDATE work_cards SET updated_at = ? WHERE id = ?').run(nowIso(), cardId);
  store.record('created', 'work_material', id, workSphereId(store), `${KIND_LABEL[input.kind]} added to ${card.title}: ${title}`);
  return materialFromRow(store.db.prepare('SELECT * FROM work_materials WHERE id = ?').get(id) as Row);
}

registerUndo('created:work_material', (db, id) => void db.prepare('DELETE FROM work_materials WHERE id = ?').run(id));

export function deleteMaterial(store: Store, id: string): void {
  if (store.db.prepare('DELETE FROM work_materials WHERE id = ?').run(id).changes === 0) throw new NotFound('Material');
}

export interface StepInput {
  title: string;
  dueDate?: string | null;
  notes?: string;
}

/** A to-do on a card's timeline: a task in the card's project (or in Work), tied to the card. */
export function addStep(store: Store, cardId: string, step: StepInput): Task {
  const card = cardRow(store, cardId);
  const task = store.createTask({
    title: step.title,
    notes: step.notes,
    dueDate: step.dueDate ?? null,
    ...(card.project_id ? { projectId: card.project_id } : { sphereId: workSphereId(store) }),
  });
  store.db.prepare('INSERT INTO work_card_tasks (task_id, card_id) VALUES (?,?)').run(task.id, cardId);
  return task;
}

/** Several to-dos at once: the breakdown of a card into its steps. */
export function planCard(store: Store, cardId: string, steps: StepInput[]): Task[] {
  return store.tx(() => steps.map((s) => addStep(store, cardId, s)));
}

// ── For Seldon ──────────────────────────────────────────────────────────────

registerSnapshotSection<Store>('Work board', (store) => {
  let cards: WorkCard[];
  try {
    cards = listCards(store).filter((c) => c.stage !== 'done');
  } catch {
    return null;
  }
  if (!cards.length) return null;
  return cards
    .slice(0, 25)
    .map((c) => `- [${STAGE_LABEL[c.stage]}] ${c.title}${c.projectName ? ` (${c.projectName})` : ''}${c.dueDate ? ` · due ${c.dueDate}` : ''} · ${c.tasksDone}/${c.tasksOpen + c.tasksDone} to-dos done · id ${c.id}`)
    .join('\n');
});

const cardView = (c: WorkCard) => ({
  id: c.id,
  title: c.title,
  project: c.projectName,
  project_id: c.projectId,
  stage: c.stage,
  due_date: c.dueDate,
  to_dos: `${c.tasksDone}/${c.tasksOpen + c.tasksDone} done`,
  next: c.nextTask ?? undefined,
  materials: c.materials,
  page: `/work/${c.id}`,
});

const breakdownInput = {
  goals: lines.optional().describe('What the work is for: the outcomes the PRD wants, one per line'),
  requirements: lines.optional().describe('The requirements, one short line each'),
  ux: lines.optional().describe('UX work: research, flows, information architecture, edge cases, states'),
  ui: lines.optional().describe('UI work: screens, components, visual design, motion, specs'),
  product: lines.optional().describe('Product design work: alignment, metrics, experiments, reviews, handoff'),
  questions: lines.optional().describe('Open questions to take back to PM, RD or stakeholders'),
};
const pickBreakdown = (i: Partial<Record<(typeof LISTS)[number], string[]>>): Partial<WorkBreakdown> =>
  Object.fromEntries(LISTS.filter((k) => i[k] !== undefined).map((k) => [k, i[k]])) as Partial<WorkBreakdown>;

const stepSchema = z.object({ title: z.string().min(1).max(200), due_date: dateStr.nullable().optional(), notes: z.string().max(2000).optional() });

registerFeature({
  id: 'work',
  tables: ['work_cards', 'work_materials', 'work_card_tasks'],
  tools: [
    tool(
      'list_work_cards',
      "Read the Work board: the Work projects (id and name) and every card (one piece of work, like a PRD, inside a project) with its stage, due date and to-do progress. Call this before making a card, to offer the user their projects.",
      z.object({}),
      (_, { store }) => ({
        data: { projects: workProjects(store).map((p) => ({ id: p.id, name: p.name })), stages: STAGES, cards: listCards(store).map(cardView) },
        summary: 'Read the Work board',
      }),
    ),
    tool(
      'get_work_card',
      'Read one Work card in full: its breakdown, every raw material (PRD text, notes, links) and its to-dos in timeline order.',
      z.object({ card_id: z.string().min(1).describe('The card id, from list_work_cards') }),
      ({ card_id }, { store }) => {
        const d = getCard(store, card_id);
        return {
          data: {
            ...cardView(d.card),
            summary: d.card.summary,
            breakdown: d.card.breakdown,
            materials: d.materials.map((m) => ({ id: m.id, kind: m.kind, title: m.title, url: m.url || undefined, text: m.body ? m.body.slice(0, 20_000) : undefined })),
            to_dos: d.tasks.map((t) => ({ id: t.id, title: t.title, due_date: t.dueDate, done: t.done })),
          },
          summary: `Read ${d.card.title}`,
        };
      },
    ),
    tool(
      'create_work_card',
      "Put a new piece of work on the Work board, usually from a PRD the user shared. Ask the user first which project it belongs to and when it is due, unless they said. Write the breakdown from the PRD: a two or three sentence summary, the goals, the requirements, and the UX, UI and product design work it needs, plus open questions. Then attach the raw materials with add_work_material and lay out the to-dos with plan_work_card.",
      z.object({
        title: z.string().min(1).max(200).describe('A short name for the work, like "One-click loan activation"'),
        project: z.string().min(1).max(80).describe('A Work project id from list_work_cards, or the name of a new project'),
        due_date: dateStr.nullable().optional(),
        stage: stageSchema.default('intake'),
        summary: z.string().max(4000).default(''),
        ...breakdownInput,
      }),
      (i, { store }) => {
        const c = createCard(store, { title: i.title, project: i.project, dueDate: i.due_date ?? null, stage: i.stage, summary: i.summary, breakdown: pickBreakdown(i) });
        return { data: { ok: true, ...cardView(c) }, summary: `New work: ${c.title}${c.projectName ? ` in ${c.projectName}` : ''}` };
      },
    ),
    tool(
      'update_work_card',
      "Change a Work card: move it to another stage (intake, discovery, design, review, handoff, done), set its due date, project, title or summary, or replace any of the breakdown's lists.",
      z.object({
        card_id: z.string().min(1),
        title: z.string().min(1).max(200).optional(),
        project: z.string().min(1).max(80).optional(),
        due_date: dateStr.nullable().optional(),
        stage: stageSchema.optional(),
        summary: z.string().max(4000).optional(),
        ...breakdownInput,
      }),
      (i, { store }) => {
        const b = pickBreakdown(i);
        const c = updateCard(store, i.card_id, { title: i.title, project: i.project, dueDate: i.due_date, stage: i.stage, summary: i.summary, breakdown: Object.keys(b).length ? b : undefined });
        return { data: { ok: true, ...cardView(c) }, summary: i.stage ? `${c.title}: ${STAGE_LABEL[c.stage]}` : `Updated ${c.title}` };
      },
    ),
    tool(
      'add_work_material',
      "Attach a raw material to a Work card: the PRD (kind prd; paste its full text as text, and its link if there is one), meeting notes (notes), a recording (recording: its link, and the transcript or summary as text), a Figma file (figma), or any other link (link) or document (file). Keep the user's own words; don't summarise them away.",
      z.object({
        card_id: z.string().min(1),
        kind: kindSchema,
        title: z.string().max(200).optional(),
        url: z.string().max(2000).optional(),
        text: z.string().max(100_000).optional(),
      }),
      (i, { store }) => {
        const m = addMaterial(store, i.card_id, { kind: i.kind, title: i.title, url: i.url, body: i.text });
        return { data: { ok: true, id: m.id, title: m.title }, summary: `${KIND_LABEL[m.kind]} added: ${m.title}` };
      },
    ),
    tool(
      'plan_work_card',
      "Lay out a Work card's to-dos: the concrete steps the user has to do for the UX, UI and product design work, each with a due date working back from the card's due date (working days, leaving room for reviews before handoff). They join the card's timeline and the user's Work to-dos.",
      z.object({ card_id: z.string().min(1), to_dos: z.array(stepSchema).min(1).max(40) }),
      ({ card_id, to_dos }, { store }) => {
        const tasks = planCard(store, card_id, to_dos.map((t) => ({ title: t.title, dueDate: t.due_date ?? null, notes: t.notes })));
        return { data: { ok: true, to_dos: tasks.map((t) => ({ id: t.id, title: t.title, due_date: t.dueDate })) }, summary: `Planned ${tasks.length} to-dos` };
      },
    ),
  ],
  routes: (app, { store }) => {
    app.get('/api/work/cards', (c) => c.json({ stages: STAGES, projects: workProjects(store), cards: listCards(store) }));
    app.post('/api/work/cards', async (c) => {
      const i = await read(
        c,
        z.object({ title: z.string().min(1).max(200), project: z.string().max(80).nullable().optional(), summary: z.string().max(4000).optional(), dueDate: dateStr.nullable().optional(), stage: stageSchema.optional() }),
      );
      return c.json(createCard(store, i), 201);
    });
    app.get('/api/work/cards/:id', (c) => c.json(getCard(store, c.req.param('id'))));
    app.patch('/api/work/cards/:id', async (c) => {
      const i = await read(
        c,
        z.object({
          title: z.string().max(200).optional(),
          project: z.string().max(80).nullable().optional(),
          summary: z.string().max(4000).optional(),
          breakdown: z.object(Object.fromEntries(LISTS.map((k) => [k, lines.optional()]))).partial().optional(),
          dueDate: dateStr.nullable().optional(),
          stage: stageSchema.optional(),
          position: z.number().finite().optional(),
        }),
      );
      return c.json(updateCard(store, c.req.param('id'), i as CardPatch));
    });
    app.delete('/api/work/cards/:id', (c) => {
      deleteCard(store, c.req.param('id'));
      return c.json({ ok: true });
    });
    app.post('/api/work/cards/:id/materials', async (c) => {
      const i = await read(c, z.object({ kind: kindSchema, title: z.string().max(200).optional(), url: z.string().max(2000).optional(), body: z.string().max(100_000).optional() }));
      return c.json(addMaterial(store, c.req.param('id'), i), 201);
    });
    app.delete('/api/work/materials/:id', (c) => {
      deleteMaterial(store, c.req.param('id'));
      return c.json({ ok: true });
    });
    app.post('/api/work/cards/:id/tasks', async (c) => {
      const i = await read(c, z.object({ title: z.string().min(1).max(200), dueDate: dateStr.nullable().optional(), notes: z.string().max(2000).optional() }));
      return c.json(addStep(store, c.req.param('id'), i), 201);
    });
  },
});
