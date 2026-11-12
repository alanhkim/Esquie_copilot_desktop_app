import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adoptLegacyWorkspace, newWorkspace } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';
import { laneMove, matchingTasks } from '../public/task-board.mjs';

async function setup(t, legacy) {
  const root = await mkdtemp(join(tmpdir(), 'esquie-task-history-'));
  let source;
  if (legacy) {
    source = await mkdtemp(join(tmpdir(), 'esquie-task-legacy-'));
    t.after(() => rm(source, { force: true, recursive: true }));
    await writeFile(join(source, 'workspace.json'), JSON.stringify(legacy), { mode: 0o600 });
    await adoptLegacyWorkspace({ source, destination: root, confirmed: true });
  }
  let now = new Date('2026-03-04T10:00:00Z');
  let app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0, clock: () => now });
  t.after(async () => { await app.close(); await rm(root, { force: true, recursive: true }); });
  const state = async () => (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  const request = async (path, body, method = 'POST') => fetch(`${app.url}${path}`, {
    method, headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': (await state()).csrfToken },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return {
    root, source, state, request, clock(value) { now = new Date(value); },
    async restart() {
      await app.close();
      app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0, clock: () => now });
    }
  };
}

test('real task creation, completion/reopen, changes, notes and deduplicated evidence have a persistent timeline', async t => {
  const context = await setup(t);
  let task = (await (await context.request('/api/tasks', { title: 'Fake timeline task' })).json()).task;
  assert.equal(task.createdAt, '2026-03-04T10:00:00.000Z');
  context.clock('2026-03-04T11:00:00Z');
  task = (await (await context.request(`/api/tasks/${task.id}`, { status: 'done', revision: task.revision }, 'PATCH')).json()).task;
  assert.equal(task.completedAt, '2026-03-04T11:00:00.000Z');
  context.clock('2026-03-05T12:00:00Z');
  task = (await (await context.request(`/api/tasks/${task.id}`, { status: 'doing', revision: task.revision }, 'PATCH')).json()).task;
  assert.equal(task.completedAt, null);
  task = (await (await context.request(`/api/tasks/${task.id}`, { title: 'Fake revised title', priority: 'important', revision: task.revision }, 'PATCH')).json()).task;
  const evidence = { title: 'Fake reference', url: 'https://example.invalid/fake-evidence', note: 'Inert fake context.' };
  await context.request(`/api/tasks/${task.id}/evidence`, evidence);
  await context.request(`/api/tasks/${task.id}/evidence`, evidence);
  await context.request(`/api/tasks/${task.id}/conversation`, { text: 'Fake owner note.' });
  assert.equal((await context.request(`/api/tasks/${task.id}`, { status: 'done', revision: 1 }, 'PATCH')).status, 409);
  await context.restart();
  const timeline = await (await context.request(`/api/tasks/${task.id}/conversation`, undefined, 'GET')).json();
  assert.deepEqual(timeline.history.map(event => event.kind), ['created', 'completed', 'reopened', 'updated', 'evidence-added', 'note-added']);
  assert.deepEqual(timeline.history[3].fields, ['title', 'priority']);
  assert.equal(timeline.history[2].fromStatus, 'done');
  assert.equal(timeline.createdAt, '2026-03-04T10:00:00.000Z');
});

test('legacy tasks keep known creation dates/completed state and never receive invented dates or past transitions', async t => {
  const legacy = newWorkspace();
  const legacyEvidence = {
    id: randomUUID(), title: 'Fake legacy source preview', url: 'https://example.invalid/legacy-source',
    note: 'Historical synthetic evidence with no recorded source-result reference.',
    provenance: 'authorized-source-untrusted-evidence', source: 'mail', createdAt: '2025-01-02T03:04:05.000Z'
  };
  legacy.tasks = [
    { id: randomUUID(), title: 'Fake old undated completion', status: 'done', revision: 1, evidence: [legacyEvidence] },
    { id: randomUUID(), title: 'Fake old dated task', status: 'next', revision: 1, evidence: [], createdAt: '2025-01-02T03:04:05.000Z' }
  ];
  const context = await setup(t, legacy);
  await context.restart();
  let state = await context.state();
  assert.equal(state.tasks[0].status, 'done');
  assert.equal(state.tasks[0].createdAt, undefined);
  assert.equal(state.tasks[0].accountId, undefined);
  assert.equal(matchingTasks(state.tasks, state.conversations, '', true, 'unassigned').length, 2);
  assert.deepEqual(state.tasks[0].history, []);
  assert.deepEqual(state.tasks[0].evidence, [legacyEvidence]);
  assert.equal(Object.hasOwn(state.tasks[0].evidence[0], 'sourceReference'), false);
  assert.equal(state.tasks[1].createdAt, '2025-01-02T03:04:05.000Z');
  assert.deepEqual(state.tasks[1].history, []);
  await context.request(`/api/tasks/${state.tasks[0].id}`, { status: 'next', revision: 1 }, 'PATCH');
  state = await context.state();
  assert.deepEqual(state.tasks[0].history.map(event => event.kind), ['reopened']);
  assert.equal(state.tasks[0].createdAt, undefined);
  assert.equal(await readFile(join(context.source, 'workspace.json'), 'utf8'), JSON.stringify(legacy));
});

test('local lane moves persist history, reject stale revisions and preserve completed tasks during note/evidence search', async t => {
  const context = await setup(t);
  const created = await (await context.request('/api/tasks', { title: 'Fake movable task' })).json();
  const snapshot = created.task;
  const patch = update => context.request(`/api/tasks/${snapshot.id}`, update, 'PATCH');
  let task = (await (await patch(laneMove(snapshot, 'waiting'))).json()).task;
  assert.equal(task.status, 'waiting');
  assert.equal((await patch(laneMove(snapshot, 'doing'))).status, 409);
  assert.equal((await context.state()).tasks[0].status, 'waiting');
  task = (await (await patch(laneMove(task, 'done'))).json()).task;
  const completedAt = task.completedAt;
  await context.request(`/api/tasks/${task.id}/conversation`, { text: 'Fake searchable conversation' });
  await context.request(`/api/tasks/${task.id}/evidence`, { title: 'Fake proof', url: 'https://example.invalid/unique-proof', note: 'Fake evidence needle' });
  await context.restart();
  const state = await context.state();
  assert.equal(state.tasks[0].status, 'done');
  assert.equal(state.tasks[0].completedAt, completedAt);
  assert.deepEqual(matchingTasks(state.tasks, state.conversations, 'searchable conversation', false), []);
  assert.equal(matchingTasks(state.tasks, state.conversations, 'searchable conversation', true)[0].id, task.id);
  assert.equal(matchingTasks(state.tasks, state.conversations, 'evidence needle', true)[0].id, task.id);
  assert.equal(matchingTasks(state.tasks, state.conversations, 'unique-proof', true)[0].id, task.id);
  const reopened = await (await patch(laneMove(state.tasks[0], 'doing'))).json();
  assert.equal(reopened.task.completedAt, null);
  assert.deepEqual(reopened.task.history.map(event => event.kind), ['created', 'status-changed', 'completed', 'note-added', 'evidence-added', 'reopened']);
});

test('explicit account IDs persist without name inference, preserve completed work and reject invalid or stale edits atomically', async t => {
  const context = await setup(t);
  const record = async category => (await (await context.request('/api/records', { category, title: 'Same fake account' })).json()).record;
  const first = await record('account');
  const second = await record('account');
  const outcome = await record('outcome');
  const create = async body => context.request('/api/tasks', { title: 'Same fake account', details: first.title, ...body });
  let task = (await (await create({ accountId: first.id, status: 'done' })).json()).task;
  const noSelection = (await (await create({})).json()).task;
  assert.equal(noSelection.accountId, '');
  const before = await context.state();
  for (const accountId of [null, 17, {}, [], false, 'Same fake account', ' ', first.id.toUpperCase(), randomUUID(), outcome.id]) {
    assert.equal((await create({ accountId })).status, 400);
    assert.equal((await context.request(`/api/tasks/${task.id}`, { accountId, title: 'Must not persist', revision: task.revision }, 'PATCH')).status, 400);
  }
  assert.deepEqual((await context.state()).tasks, before.tasks);
  const staleRevision = task.revision;
  const completedAt = task.completedAt;
  task = (await (await context.request(`/api/tasks/${task.id}`, { accountId: second.id, revision: task.revision }, 'PATCH')).json()).task;
  assert.equal(task.status, 'done');
  assert.equal(task.completedAt, completedAt);
  assert.deepEqual(task.history.at(-1).fields, ['accountId']);
  assert.equal((await context.request(`/api/tasks/${task.id}`, { accountId: first.id, revision: staleRevision }, 'PATCH')).status, 409);
  const renamed = await context.request(`/api/records/${second.id}`, { category: 'account', title: 'Renamed fake account', revision: second.revision }, 'PATCH');
  assert.equal(renamed.status, 200);
  task = (await (await context.request(`/api/tasks/${task.id}`, { title: 'Renamed fake task', revision: task.revision }, 'PATCH')).json()).task;
  assert.equal(task.accountId, second.id, 'unrelated edits and account renames preserve the exact association');
  await context.request(`/api/tasks/${task.id}/conversation`, { text: 'Fake account note needle' });
  await context.restart();
  const state = await context.state();
  task = state.tasks.find(item => item.id === task.id);
  assert.equal(task.accountId, second.id);
  assert.equal(state.records.find(item => item.id === task.accountId).title, 'Renamed fake account');
  assert.equal(task.status, 'done');
  assert.deepEqual(matchingTasks(state.tasks, state.conversations, 'needle', false, second.id), []);
  assert.deepEqual(matchingTasks(state.tasks, state.conversations, 'needle', true, first.id), []);
  assert.equal(matchingTasks(state.tasks, state.conversations, 'needle', true, second.id)[0].id, task.id);
  assert.equal(matchingTasks(state.tasks, state.conversations, first.title, true, 'unassigned')[0].id, noSelection.id);
  task = (await (await context.request(`/api/tasks/${task.id}`, { accountId: '', revision: task.revision }, 'PATCH')).json()).task;
  assert.equal(task.accountId, '');
  assert.equal(task.status, 'done');
  assert.equal(task.completedAt, completedAt);
});
