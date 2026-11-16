import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { runTool } from '../src/agent/tools.ts';
import { addMaterial, addStep, createCard, deleteCard, getCard, listCards, planCard, updateCard } from '../src/features/work.ts';
import { Store } from '../src/store.ts';
import '../src/features/index.ts';

const TODAY = '2026-11-16';

function fresh(): Store {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['work', 'health'] });
  store.setZone('Asia/Singapore');
  return store;
}
const workId = (store: Store) => store.listSpheres(TODAY).find((s) => s.key === 'work')!.id;

test('a card lives in a Work project, keeps its materials and plans its to-dos as tasks in that project', () => {
  const store = fresh();
  const kyc = store.createProject({ sphereId: workId(store), name: 'KYC' });
  const card = createCard(store, {
    title: 'Selfie retry flow',
    project: 'KYC',
    dueDate: '2026-12-04',
    summary: 'Let people retake a failed selfie without starting over.',
    breakdown: { requirements: ['Retry up to 3 times', ' ', 'Explain why it failed'], ux: ['Map the failure states'], ui: ['Retry screen'] },
  });
  assert.equal(card.projectId, kyc.id, 'a project named by its name is found');
  assert.equal(card.stage, 'intake');
  assert.deepEqual(card.breakdown.requirements, ['Retry up to 3 times', 'Explain why it failed'], 'blank lines dropped');
  assert.deepEqual(card.breakdown.goals, []);

  addMaterial(store, card.id, { kind: 'prd', title: 'PRD v2', body: 'The whole PRD text…', url: 'https://docs.example.com/prd' });
  addMaterial(store, card.id, { kind: 'figma', url: 'https://www.figma.com/design/abc/KYC' });
  assert.throws(() => addMaterial(store, card.id, { kind: 'link' }), /link or some text/);
  assert.throws(() => addMaterial(store, card.id, { kind: 'link', url: 'ftp://x' }), /http/);

  planCard(store, card.id, [
    { title: 'Hi-fi retry screens', dueDate: '2026-11-27' },
    { title: 'Map the failure states', dueDate: '2026-11-20' },
    { title: 'Handoff to RD' },
  ]);
  const d = getCard(store, card.id);
  assert.deepEqual(d.materials.map((m) => m.title), ['PRD v2', 'figma.com'], 'a link without a title is named by its site');
  assert.deepEqual(d.tasks.map((t) => t.title), ['Map the failure states', 'Hi-fi retry screens', 'Handoff to RD'], 'timeline order: by date, undated last');
  assert.ok(d.tasks.every((t) => t.projectId === kyc.id && t.sphereId === workId(store)), 'ordinary Work to-dos in the project');
  assert.equal(d.card.materials, 2);
  assert.equal(d.card.tasksOpen, 3);
  assert.deepEqual(d.card.nextTask, { title: 'Map the failure states', dueDate: '2026-11-20' });

  store.updateTask(d.tasks[0]!.id, { done: true });
  const after = getCard(store, card.id);
  assert.equal(after.card.tasksDone, 1);
  assert.equal(after.tasks.at(-1)!.title, 'Map the failure states', 'done to-dos sink to the end');
});

test('a new project name makes the project; a card without one files its to-dos in Work', () => {
  const store = fresh();
  const card = createCard(store, { title: 'Landing page revamp', project: 'Personal Loan (VN)' });
  assert.ok(store.listProjects({ sphereId: workId(store) }).some((p) => p.name === 'Personal Loan (VN)'));
  assert.equal(card.projectName, 'Personal Loan (VN)');
  const loose = createCard(store, { title: 'Quick audit' });
  const t = addStep(store, loose.id, { title: 'Audit the checkout' });
  assert.equal(t.sphereId, workId(store));
  assert.equal(t.projectId, null);
  const health = store.listSpheres(TODAY).find((s) => s.key === 'health')!.id;
  const other = store.createProject({ sphereId: health, name: 'Not work' });
  assert.throws(() => createCard(store, { title: 'x', project: other.id }), /not in the Work sphere/);
});

test('moving a card puts it at the end of its new column; deleting it leaves its to-dos', () => {
  const store = fresh();
  const a = createCard(store, { title: 'A' });
  const b = createCard(store, { title: 'B' });
  const c = createCard(store, { title: 'C', stage: 'design' });
  assert.deepEqual(listCards(store).map((x) => x.title), ['A', 'B', 'C']);
  updateCard(store, a.id, { stage: 'design' });
  assert.deepEqual(listCards(store).map((x) => `${x.stage}:${x.title}`), ['intake:B', 'design:C', 'design:A']);
  updateCard(store, a.id, { position: c.position - 1 });
  assert.deepEqual(listCards(store).filter((x) => x.stage === 'design').map((x) => x.title), ['A', 'C'], 'dropped above C');
  updateCard(store, b.id, { breakdown: { ux: ['Flows'] } });
  updateCard(store, b.id, { breakdown: { ui: ['Screens'] } });
  assert.deepEqual(getCard(store, b.id).card.breakdown.ux, ['Flows'], 'lists left out stay');

  const t = addStep(store, b.id, { title: 'Keep me' });
  deleteCard(store, b.id);
  assert.throws(() => getCard(store, b.id), /Work card/);
  assert.equal(store.getTask(t.id).title, 'Keep me');
});

test("Seldon's tools build a card from a PRD, and undo takes it back", async () => {
  const store = fresh();
  const ctx = { store, today: TODAY };
  const ok = (r: Awaited<ReturnType<typeof runTool>>) => {
    assert.ok(!r.isError, r.content);
    return JSON.parse(r.content);
  };
  ok(await runTool('list_work_cards', {}, ctx));
  const made = ok(await runTool(
    'create_work_card',
    { title: 'One-click activation', project: 'Personal Loan (BR)', due_date: '2026-12-11', summary: 'Activate a loan in one tap.', requirements: ['One tap from the offer'], ux: ['Flow from offer to funds'], questions: ['Which KYC level is needed?'] },
    ctx,
  ));
  const id = made.id as string;
  ok(await runTool('add_work_material', { card_id: id, kind: 'prd', title: 'PRD', text: 'Full PRD' }, ctx));
  ok(await runTool('plan_work_card', { card_id: id, to_dos: [{ title: 'Flow', due_date: '2026-11-20' }, { title: 'UI', due_date: '2026-12-01' }] }, ctx));
  ok(await runTool('update_work_card', { card_id: id, stage: 'discovery' }, ctx));
  const data = ok(await runTool('get_work_card', { card_id: id }, ctx)) as { stage: string; breakdown: { questions: string[] }; materials: unknown[]; to_dos: unknown[]; page: string };
  assert.equal(data.stage, 'discovery');
  assert.deepEqual(data.breakdown.questions, ['Which KYC level is needed?']);
  assert.equal(data.materials.length, 1);
  assert.equal(data.to_dos.length, 2);
  assert.equal(data.page, `/work/${id}`);

  const act = store.listActivity({ limit: 20 }).find((a) => a.summary === 'New work: One-click activation')!;
  assert.ok(store.undo(act.id));
  assert.equal(listCards(store).length, 0);
});

test('stakeholders: kept on the card, cleaned, and replaced as a list', async () => {
  const store = fresh();
  const card = createCard(store, { title: 'Appeal flow', stakeholders: [{ name: ' Ginny Guo ', role: 'PM', team: 'PIPO Compliance' }, { name: '', role: 'RD' }] });
  assert.deepEqual(card.stakeholders, [{ name: 'Ginny Guo', role: 'PM', team: 'PIPO Compliance', note: '' }], 'trimmed; nameless dropped');
  updateCard(store, card.id, { title: 'Appeal flow v2' });
  assert.equal(getCard(store, card.id).card.stakeholders.length, 1, 'other edits leave them alone');
  const ctx = { store, today: TODAY };
  const r = await runTool('update_work_card', { card_id: card.id, stakeholders: [{ name: 'Linjie Fang', role: 'UX writer' }, { name: 'Jie Ren', role: 'DA', note: 'event tracking' }] }, ctx);
  assert.ok(!r.isError, r.content);
  assert.deepEqual(getCard(store, card.id).card.stakeholders.map((x) => `${x.role}:${x.name}`), ['UX writer:Linjie Fang', 'DA:Jie Ren'], 'the list replaces the old one');
  const read = JSON.parse((await runTool('get_work_card', { card_id: card.id }, ctx)).content);
  assert.equal(read.stakeholders[1].note, 'event tracking');
});

test('the HTTP routes: board, card, materials and to-dos', async () => {
  const db = openDb(':memory:');
  new Store(db).onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['work'] });
  const app = createApp({ db });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const made = await call('POST', '/work/cards', { title: 'Disbursement', project: 'Personal Loan (MX)', dueDate: '2026-12-18' });
  assert.equal(made.status, 201);
  const id = made.json.id;
  assert.equal((await call('POST', `/work/cards/${id}/materials`, { kind: 'notes', title: 'Kickoff', body: 'Notes' })).status, 201);
  assert.equal((await call('POST', `/work/cards/${id}/tasks`, { title: 'Wireframes', dueDate: '2026-11-25' })).status, 201);
  assert.equal((await call('PATCH', `/work/cards/${id}`, { stage: 'review', breakdown: { ui: ['Status screen'] } })).json.stage, 'review');
  assert.equal((await call('PATCH', `/work/cards/${id}`, { stakeholders: [{ name: 'Qiaoxin Liu', role: 'PM' }] })).json.stakeholders[0].name, 'Qiaoxin Liu');
  const board = await call('GET', '/work/cards');
  assert.deepEqual(board.json.stages, ['intake', 'discovery', 'design', 'review', 'handoff', 'done']);
  assert.equal(board.json.projects[0].name, 'Personal Loan (MX)');
  const d = await call('GET', `/work/cards/${id}`);
  assert.equal(d.json.materials[0].title, 'Kickoff');
  assert.equal(d.json.tasks[0].title, 'Wireframes');
  assert.deepEqual(d.json.card.breakdown.ui, ['Status screen']);
  assert.equal((await call('DELETE', `/work/materials/${d.json.materials[0].id}`)).status, 200);
  assert.equal((await call('DELETE', `/work/cards/${id}`)).status, 200);
  assert.equal((await call('GET', `/work/cards/${id}`)).status, 404);
});
