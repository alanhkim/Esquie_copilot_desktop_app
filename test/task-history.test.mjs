import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adoptLegacyWorkspace, newWorkspace } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';

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
  legacy.tasks = [
    { id: randomUUID(), title: 'Fake old undated completion', status: 'done', revision: 1, evidence: [] },
    { id: randomUUID(), title: 'Fake old dated task', status: 'next', revision: 1, evidence: [], createdAt: '2025-01-02T03:04:05.000Z' }
  ];
  const context = await setup(t, legacy);
  await context.restart();
  let state = await context.state();
  assert.equal(state.tasks[0].status, 'done');
  assert.equal(state.tasks[0].createdAt, undefined);
  assert.deepEqual(state.tasks[0].history, []);
  assert.equal(state.tasks[1].createdAt, '2025-01-02T03:04:05.000Z');
  assert.deepEqual(state.tasks[1].history, []);
  await context.request(`/api/tasks/${state.tasks[0].id}`, { status: 'next', revision: 1 }, 'PATCH');
  state = await context.state();
  assert.deepEqual(state.tasks[0].history.map(event => event.kind), ['reopened']);
  assert.equal(state.tasks[0].createdAt, undefined);
  assert.equal(await readFile(join(context.source, 'workspace.json'), 'utf8'), JSON.stringify(legacy));
});
