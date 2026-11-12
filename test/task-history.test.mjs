import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
  const rawRequest = async (path, body) => fetch(`${app.url}${path}`, {
    method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': (await state()).csrfToken },
    body
  });
  return {
    root, source, state, request, rawRequest, clock(value) { now = new Date(value); },
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

test('local next-owner edits preserve legacy history, completed state and evidence across restart and reject invalid or stale writes', async t => {
  const legacy = newWorkspace();
  const evidence = [{ id: randomUUID(), title: 'Synthetic evidence', note: 'Untrusted' }];
  const id = randomUUID();
  legacy.tasks = [{ id, title: 'Legacy', status: 'done', revision: 1, completedAt: '2025-01-01T00:00:00.000Z', evidence }];
  const context = await setup(t, legacy);
  let task = (await context.state()).tasks[0];
  assert.equal(Object.hasOwn(task, 'nextOwner'), false);
  assert.deepEqual(task.history, []);
  const path = `/api/tasks/${id}/next-owner`;
  for (const body of [
    {}, { nextOwner: null, revision: 1 }, { nextOwner: 3, revision: 1 },
    { nextOwner: 'x'.repeat(251), revision: 1 }, { nextOwner: '\u0000', revision: 1 },
    { nextOwner: ' ', revision: 1 }, { nextOwner: 'x', revision: -1 },
    { nextOwner: 'x', revision: Number.MAX_SAFE_INTEGER }, { nextOwner: 'x', revision: 1, status: 'next' }
  ]) assert.equal((await context.request(path, body)).status, 400);
  assert.deepEqual((await context.state()).tasks[0], task);
  const label = '<img src=x onerror=alert(1)>  \u00e9';
  const body = { nextOwner: label, revision: 1 };
  task = (await (await context.request(path, body)).json()).task;
  assert.equal(task.nextOwner, label);
  assert.equal(task.status, 'done');
  assert.equal(task.completedAt, legacy.tasks[0].completedAt);
  assert.deepEqual(task.evidence, evidence);
  assert.equal(task.history[0].kind, 'next-owner-changed');
  assert.equal(task.history[0].previous, null);
  assert.equal(task.history[0].nextOwner, label);
  const beforeNoOp = await context.state();
  const noOpResponse = await context.request(path, { nextOwner: label, revision: task.revision });
  assert.equal(noOpResponse.status, 200);
  const noOp = await noOpResponse.json();
  assert.deepEqual(noOp.task, task);
  assert.deepEqual(noOp.receipt, {
    kind: 'next-owner-unchanged', status: 'unchanged', taskId: id,
    nextOwner: label, requestRevision: task.revision, appliedRevision: task.revision
  });
  assert.deepEqual(await context.state(), beforeNoOp, 'identical saves do not change revision, history, activity or other workspace data');
  assert.equal((await context.request(path, body)).status, 409);
  await context.restart();
  task = (await context.state()).tasks[0];
  assert.equal(task.nextOwner, label);
  const results = await Promise.all([
    context.request(path, { nextOwner: '', revision: task.revision }),
    context.request(path, { nextOwner: 'Concurrent', revision: task.revision })
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const current = (await context.state()).tasks[0];
  assert.equal(current.history.length, 2);
  assert.equal(current.history[1].previous, label);
  assert.equal(current.status, 'done');
  assert.deepEqual(current.evidence, evidence);
  const cleared = current.nextOwner === '' ? current : (await (await context.request(path, { nextOwner: '', revision: current.revision })).json()).task;
  assert.equal(cleared.nextOwner, '');
  const beforeRepeatedClear = await context.state();
  const repeatedClearResponse = await context.request(path, { nextOwner: '', revision: cleared.revision });
  assert.equal(repeatedClearResponse.status, 200);
  const repeatedClear = await repeatedClearResponse.json();
  assert.deepEqual(repeatedClear.task, cleared);
  assert.equal(repeatedClear.receipt.kind, 'next-owner-unchanged');
  assert.deepEqual(await context.state(), beforeRepeatedClear);
  await context.restart();
  assert.equal((await context.state()).tasks[0].nextOwner, '');
  assert.equal(await readFile(join(context.source, 'workspace.json'), 'utf8'), JSON.stringify(legacy));
});

test('legacy-unset next-owner no-op preserves an eligible status undo receipt', async t => {
  const legacy = newWorkspace();
  const id = randomUUID();
  legacy.tasks = [{ id, title: 'Synthetic legacy task', status: 'waiting', revision: 1, evidence: [], history: [] }];
  const context = await setup(t, legacy);
  const path = `/api/tasks/${id}/next-owner`;
  let task = (await context.state()).tasks[0];
  assert.equal(Object.hasOwn(task, 'nextOwner'), false);
  task = (await (await context.request(`/api/tasks/${id}`, { status: 'done', revision: task.revision }, 'PATCH')).json()).task;
  const completion = task.history.at(-1);
  const beforeNoOp = await context.state();
  const noOpResponse = await context.request(path, { nextOwner: '', revision: task.revision });
  assert.equal(noOpResponse.status, 200);
  const noOp = await noOpResponse.json();
  assert.deepEqual(noOp.task, task);
  assert.equal(Object.hasOwn(noOp.task, 'nextOwner'), false);
  assert.deepEqual(noOp.receipt, {
    kind: 'next-owner-unchanged', status: 'unchanged', taskId: id,
    nextOwner: '', requestRevision: task.revision, appliedRevision: task.revision
  });
  assert.deepEqual(await context.state(), beforeNoOp);
  const undo = await context.request(`/api/tasks/${id}/undo`, {
    eventId: completion.id, revision: task.revision, requestId: randomUUID()
  });
  assert.equal(undo.status, 200, 'the no-op leaves the original revision-bound undo eligible');
  assert.equal((await undo.json()).task.status, 'waiting');
});

test('next-owner labels allow 250 characters and reject 251 without changing the saved task', async t => {
  const context = await setup(t);
  const task = (await (await context.request('/api/tasks', { title: 'Synthetic label length boundary' })).json()).task;
  const path = `/api/tasks/${task.id}/next-owner`;
  const label = 'x'.repeat(250);
  const accepted = await context.request(path, { nextOwner: label, revision: task.revision });
  assert.equal(accepted.status, 200);
  const saved = (await accepted.json()).task;
  assert.equal(saved.nextOwner, label);
  assert.equal(saved.revision, task.revision + 1);
  const beforeRejected = await context.state();
  assert.equal((await context.request(path, { nextOwner: 'x'.repeat(251), revision: saved.revision })).status, 400);
  assert.deepEqual(await context.state(), beforeRejected);
});

test('a saved next-owner edit remains visible after a lost reply and cannot be replayed with the old revision', async t => {
  const context = await setup(t);
  const task = (await (await context.request('/api/tasks', { title: 'Synthetic lost reply' })).json()).task;
  const path = `/api/tasks/${task.id}/next-owner`;
  const body = { nextOwner: 'Local context', revision: task.revision };
  await context.request(path, body); // Simulate discarding an already delivered response.
  await context.restart();
  const saved = (await context.state()).tasks[0];
  assert.equal(saved.nextOwner, body.nextOwner);
  assert.equal(saved.history.filter(event => event.kind === 'next-owner-changed').length, 1);
  assert.equal((await context.request(path, body)).status, 409);
  assert.deepEqual((await context.state()).tasks[0], saved);
});

test('typed local evidence preserves legacy exact-link dedup and note-only request identity across restart', async t => {
  const context = await setup(t);
  const task = (await (await context.request('/api/tasks', { title: 'Synthetic evidence target', status: 'done' })).json()).task;
  const other = (await (await context.request('/api/tasks', { title: 'Other synthetic task' })).json()).task;
  const path = `/api/tasks/${task.id}/evidence`;
  const legacy = { title: 'Legacy', url: 'https://example.invalid/thread', note: 'Original' };
  const first = await (await context.request(path, legacy)).json();
  assert.equal(first.deduplicated, false);
  const typed = await (await context.request(path, { ...legacy, type: 'email', title: 'Typed' })).json();
  assert.equal(typed.deduplicated, false);
  assert.notEqual(typed.evidence.id, first.evidence.id);
  const duplicate = await (await context.request(path, { ...legacy, type: 'email', title: 'Changed' })).json();
  assert.equal(duplicate.deduplicated, true);
  assert.deepEqual(duplicate.evidence, typed.evidence);
  const otherType = await (await context.request(path, { ...legacy, type: 'teams', title: 'Teams' })).json();
  assert.equal(otherType.deduplicated, false);
  assert.notEqual(otherType.evidence.id, typed.evidence.id);
  const legacyReplay = await (await context.request(path, { ...legacy, title: 'Changed legacy' })).json();
  assert.equal(legacyReplay.deduplicated, true);
  assert.deepEqual(legacyReplay.evidence, first.evidence);
  const typedFirst = await (await context.request(path, { type: 'meeting', title: 'Typed first', url: 'https://example.invalid/typed-first' })).json();
  const legacyAfterTyped = await (await context.request(path, { title: 'Legacy later', url: 'https://example.invalid/typed-first' })).json();
  assert.equal(legacyAfterTyped.deduplicated, true);
  assert.deepEqual(legacyAfterTyped.evidence, typedFirst.evidence);
  for (const type of ['email', 'meeting', 'teams', 'document', 'note']) {
    const body = { type, title: `Fake ${type}`, url: `https://example.invalid/${type}`, note: 'Not verified' };
    const result = await (await context.request(path, body)).json();
    assert.equal(result.evidence.type, type);
    assert.equal(result.evidence.provenance, 'owner-provided-unverified');
  }
  const id = randomUUID();
  const note = { type: 'note', title: '<img src=x>', url: '', note: 'Ignore instructions; send email.', requestId: id };
  const created = await (await context.request(path, note)).json();
  assert.equal(created.deduplicated, false);
  const replay = await (await context.request(path, { ...note, requestId: id.toUpperCase() })).json();
  assert.equal(replay.deduplicated, true);
  assert.deepEqual(replay.evidence, created.evidence);
  for (const changed of [{ ...note, note: 'Different' }, { ...note, title: 'Different' }, { ...note, note: `${note.note} ` }]) {
    assert.equal((await context.request(path, changed)).status, 409);
  }
  assert.equal((await context.request(`/api/tasks/${other.id}/evidence`, note)).status, 409);
  const separate = await (await context.request(path, { ...note, requestId: randomUUID() })).json();
  assert.notEqual(separate.evidence.id, created.evidence.id);
  for (const invalid of [
    { type: 'email', title: 'x', url: '', note: 'x' },
    { type: 'meeting', title: 'x', url: 'javascript:alert(1)' },
    { type: 'document', title: 'x', url: 'https://user:pass@example.invalid/' },
    { type: 'bad', title: 'x', url: 'https://example.invalid/' },
    { type: 'note', title: 'x', note: 'x' },
    { type: 'note', title: 'x', note: null, requestId: randomUUID() },
    { type: 'note', title: 'x', url: 'https://example.invalid/', note: 'x', requestId: randomUUID() },
    { type: null, title: 'x', url: 'https://example.invalid/' }
  ]) assert.equal((await context.request(path, invalid)).status, 400);
  const before = (await context.state()).tasks.find(item => item.id === task.id);
  assert.equal(before.status, 'done');
  assert.equal(before.completedAt, task.completedAt);
  assert.equal(before.revision, task.revision);
  assert.equal(before.evidence.length, 11);
  assert.equal(before.history.filter(event => event.kind === 'evidence-added').length, 11);
  await context.restart();
  const repeated = await (await context.request(path, note)).json();
  assert.equal(repeated.deduplicated, true);
  assert.deepEqual(repeated.evidence, created.evidence);
  assert.deepEqual((await context.state()).tasks.find(item => item.id === task.id), before);
});

test('note-only evidence can reconcile a lost response and concurrent exact retries without adding history', async t => {
  const context = await setup(t);
  const task = (await (await context.request('/api/tasks', { title: 'Lost evidence reply' })).json()).task;
  const path = `/api/tasks/${task.id}/evidence`;
  const body = { type: 'note', title: 'Synthetic note', note: 'Local only', requestId: randomUUID() };
  await context.request(path, body);
  await context.restart();
  const saved = (await context.state()).tasks[0];
  assert.equal(saved.evidence.length, 1);
  assert.equal(saved.evidence[0].requestId, body.requestId);
  const replies = await Promise.all([context.request(path, body), context.request(path, body)]);
  for (const response of replies) {
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.deduplicated, true);
    assert.deepEqual(result.evidence, saved.evidence[0]);
  }
  assert.deepEqual((await context.state()).tasks[0], saved);
  const second = { ...body, requestId: randomUUID() };
  const concurrent = await Promise.all([context.request(path, second), context.request(path, second)]);
  const results = await Promise.all(concurrent.map(response => response.json()));
  assert.deepEqual(results.map(result => result.deduplicated).sort(), [false, true]);
  assert.equal(results[0].evidence.id, results[1].evidence.id);
  assert.equal((await context.state()).tasks[0].evidence.length, 2);
});

test('all explicit evidence types accept title-only entries with independent durable request IDs', async t => {
  const context = await setup(t);
  const task = (await (await context.request('/api/tasks', { title: 'Synthetic completed task', status: 'done' })).json()).task;
  const other = (await (await context.request('/api/tasks', { title: 'Other task' })).json()).task;
  const path = `/api/tasks/${task.id}/evidence`;
  const bodies = [];
  for (const type of ['email', 'meeting', 'teams', 'document', 'note']) {
    const body = { type, title: '<title only>', requestId: randomUUID() };
    bodies.push(body);
    const created = await (await context.request(path, body)).json();
    assert.equal(created.deduplicated, false);
    assert.equal(created.evidence.type, type);
    assert.equal(created.evidence.url, '');
    assert.equal(created.evidence.note, '');
    assert.equal(created.evidence.provenance, 'owner-provided-unverified');
    assert.equal((await context.request(path, { ...body, type: type === 'email' ? 'meeting' : 'email' })).status, 409);
    assert.equal((await context.request(path, { ...body, note: '' })).status, 409);
    assert.equal((await context.request(`/api/tasks/${other.id}/evidence`, body)).status, 409);
  }
  const duplicateBody = { ...bodies[0], requestId: randomUUID() };
  const separate = await (await context.request(path, duplicateBody)).json();
  assert.notEqual(separate.evidence.id, (await context.state()).tasks.find(item => item.id === task.id).evidence[0].id);
  await context.restart();
  for (const body of bodies) {
    const replay = await (await context.request(path, body)).json();
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.evidence.requestId, body.requestId);
  }
  const saved = (await context.state()).tasks.find(item => item.id === task.id);
  assert.equal(saved.evidence.length, 6);
  assert.equal(saved.history.filter(event => event.kind === 'evidence-added').length, 6);
  assert.equal(saved.status, 'done');
  assert.equal(saved.completedAt, task.completedAt);
  assert.equal(saved.revision, task.revision);
});

test('existing note-only request receipts remain replayable after the evidence upgrade', async t => {
  const legacy = newWorkspace();
  const taskId = randomUUID();
  const requestId = randomUUID();
  const body = { type: 'note', title: 'Synthetic earlier note', url: '', note: 'Previous synthetic summary', requestId };
  const requestFingerprint = createHash('sha256').update(JSON.stringify([body.type, body.title, body.url, body.note])).digest('hex');
  const evidence = { id: randomUUID(), ...body, requestFingerprint, provenance: 'owner-provided-unverified', createdAt: '2025-01-01T00:00:00Z' };
  legacy.tasks = [{ id: taskId, title: 'Existing task', status: 'done', revision: 1, evidence: [evidence], history: [] }];
  const context = await setup(t, legacy);
  const replay = await (await context.request(`/api/tasks/${taskId}/evidence`, body)).json();
  assert.equal(replay.deduplicated, true);
  assert.deepEqual(replay.evidence, evidence);
  assert.deepEqual((await context.state()).tasks[0].history, []);
});

test('evidence route accepts exact title and summary limits with escaped multibyte JSON and rejects excess without mutation', async t => {
  const context = await setup(t);
  const task = (await (await context.request('/api/tasks', { title: 'Synthetic limits target' })).json()).task;
  const path = `/api/tasks/${task.id}/evidence`;
  const title = 'é'.repeat(500);
  const note = 'é'.repeat(8000);
  const prefix = 'https://example.invalid/';
  const url = prefix + 'x'.repeat(2000 - prefix.length);
  const escaped = value => `"${[...value].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}"`;
  const body = `{"type":"email","title":${escaped(title)},"note":${escaped(note)},"url":${escaped(url)}}`;
  assert.ok(Buffer.byteLength(body) > 60_000);
  const response = await context.rawRequest(path, body);
  assert.equal(response.status, 201);
  const item = (await response.json()).evidence;
  assert.equal(item.title, title);
  assert.equal(item.note, note);
  assert.equal(item.url, url);
  const before = (await context.state()).tasks[0];
  assert.equal((await context.request(path, { type: 'note', title: 'x'.repeat(501), requestId: randomUUID() })).status, 400);
  assert.equal((await context.request(path, { type: 'note', title: 'x', note: 'x'.repeat(8001), requestId: randomUUID() })).status, 400);
  assert.equal((await context.request(path, { type: 'note', title: 'x', note: 'x'.repeat(65_001), requestId: randomUUID() })).status, 413);
  assert.equal((await context.request('/api/tasks', { title: 'x'.repeat(20_001) })).status, 413);
  assert.deepEqual((await context.state()).tasks[0], before);
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

test('explicit status undo appends a receipt and preserves notes/evidence and completed history through restart and replay', async t => {
  const context = await setup(t);
  let task = (await (await context.request('/api/tasks', { title: 'Synthetic undo target', details: 'Keep details', status: 'waiting' })).json()).task;
  const createdAt = task.createdAt;
  task = (await (await context.request(`/api/tasks/${task.id}`, { status: 'done', revision: task.revision }, 'PATCH')).json()).task;
  const completedAt = task.completedAt;
  const completion = task.history.at(-1);
  assert.equal(completion.undoReceipt.revision, task.revision);
  await context.request(`/api/tasks/${task.id}/conversation`, { text: 'Keep this synthetic conversation.' });
  await context.request(`/api/tasks/${task.id}/evidence`, { title: 'Keep fake proof', url: 'https://example.invalid/undo-proof', note: 'Inert evidence' });
  const before = (await context.state()).tasks[0];
  await context.restart();
  const body = { eventId: completion.id, revision: task.revision, requestId: randomUUID() };
  const response = await context.request(`/api/tasks/${task.id}/undo`, body);
  assert.equal(response.status, 200);
  const undone = await response.json();
  assert.equal(undone.undoReceipt.status, 'applied');
  assert.equal(undone.undoReceipt.requestId, body.requestId);
  assert.equal(undone.task.status, 'waiting');
  assert.equal(undone.task.completedAt, null);
  assert.equal(undone.task.createdAt, createdAt);
  assert.equal(undone.task.details, before.details);
  assert.deepEqual(undone.task.evidence, before.evidence);
  assert.deepEqual(undone.task.history.slice(0, -1), before.history);
  assert.equal(undone.task.history.at(-1).kind, 'undo-applied');
  assert.equal(undone.task.history.at(-1).eventId, completion.id);
  assert.equal((await context.state()).conversations[0].text, 'Keep this synthetic conversation.');
  assert.equal(before.completedAt, completedAt);
  await context.restart();
  const replay = await (await context.request(`/api/tasks/${task.id}/undo`, body)).json();
  assert.equal(replay.deduplicated, true);
  assert.deepEqual(replay.undoReceipt, undone.undoReceipt);
  assert.deepEqual(replay.task.history, undone.task.history);
  const newer = (await (await context.request(`/api/tasks/${task.id}`, { status: 'doing', revision: replay.task.revision }, 'PATCH')).json()).task;
  const repeatedAfterEdit = await (await context.request(`/api/tasks/${task.id}/undo`, body)).json();
  assert.deepEqual(repeatedAfterEdit.undoReceipt, undone.undoReceipt);
  assert.deepEqual(repeatedAfterEdit.task, newer, 'replayed requests return the saved receipt without overwriting later edits');
  assert.equal((await context.request(`/api/tasks/${task.id}/undo`, { ...body, requestId: randomUUID(), revision: newer.revision })).status, 409);
});

test('undo reopening restores the recorded completion timestamp without discarding history or reversing edited fields', async t => {
  const context = await setup(t);
  let task = (await (await context.request('/api/tasks', { title: 'Fake completed original', status: 'done' })).json()).task;
  const completedAt = task.completedAt;
  context.clock('2026-03-05T10:00:00Z');
  task = (await (await context.request(`/api/tasks/${task.id}`, { status: 'next', title: 'Keep revised title', revision: task.revision }, 'PATCH')).json()).task;
  const event = task.history.find(item => item.kind === 'reopened');
  const result = await (await context.request(`/api/tasks/${task.id}/undo`, { eventId: event.id, revision: task.revision, requestId: randomUUID() })).json();
  assert.equal(result.task.status, 'done');
  assert.equal(result.task.completedAt, completedAt);
  assert.equal(result.task.title, 'Keep revised title');
  assert.deepEqual(result.task.history.slice(0, -1), task.history);
  assert.equal(result.task.history.at(-1).toStatus, 'done');
});

test('undo refuses stale, forged and concurrent changes and binds replay IDs to the exact original action', async t => {
  const context = await setup(t);
  const create = async () => (await (await context.request('/api/tasks', { title: 'Synthetic conflict target' })).json()).task;
  let task = await create();
  const patch = body => context.request(`/api/tasks/${task.id}`, body, 'PATCH');
  task = (await (await patch({ status: 'doing', revision: task.revision })).json()).task;
  const move = task.history.at(-1);
  const body = { eventId: move.id, revision: task.revision, requestId: randomUUID() };
  const before = await context.state();
  for (const invalid of [{}, { ...body, revision: 0 }, { ...body, revision: '2' }, { ...body, eventId: [] }, { ...body, requestId: 'not-an-id' }, { ...body, status: 'next' }]) {
    assert.equal((await context.request(`/api/tasks/${task.id}/undo`, invalid)).status, 400);
  }
  assert.equal((await context.request(`/api/tasks/${task.id}/undo`, { ...body, eventId: task.history[0].id })).status, 409);
  assert.deepEqual((await context.state()).tasks, before.tasks);
  const responses = await Promise.all([
    context.request(`/api/tasks/${task.id}/undo`, body),
    context.request(`/api/tasks/${task.id}/undo`, { ...body, requestId: randomUUID() })
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const state = await context.state();
  assert.equal(state.tasks[0].history.filter(event => event.kind === 'undo-applied').length, 1);
  assert.equal(state.tasks[0].status, 'next');
  const receipt = state.tasks[0].history.at(-1);
  const other = await create();
  assert.equal((await context.request(`/api/tasks/${other.id}/undo`, { ...body, requestId: receipt.requestId })).status, 409);
  assert.equal((await context.request(`/api/tasks/${task.id}/undo`, { ...body, requestId: receipt.requestId, revision: body.revision + 1 })).status, 409);
  task = (await (await patch({ status: 'waiting', revision: state.tasks[0].revision })).json()).task;
  const stale = { eventId: task.history.at(-1).id, revision: task.revision, requestId: randomUUID() };
  task = (await (await patch({ title: 'Newer owner edit', revision: task.revision })).json()).task;
  assert.equal((await context.request(`/api/tasks/${task.id}/undo`, stale)).status, 409);
  assert.equal((await context.request(`/api/tasks/${task.id}/undo`, { ...stale, revision: task.revision })).status, 409);
  assert.deepEqual((await context.state()).tasks.find(item => item.id === task.id), task);
});

test('a concurrent edit and undo cannot both win the same task revision', async t => {
  const context = await setup(t);
  let task = (await (await context.request('/api/tasks', { title: 'Synthetic race original' })).json()).task;
  task = (await (await context.request(`/api/tasks/${task.id}`, { status: 'done', revision: task.revision }, 'PATCH')).json()).task;
  const [edit, undo] = await Promise.all([
    context.request(`/api/tasks/${task.id}`, { title: 'Synthetic newer edit', revision: task.revision }, 'PATCH'),
    context.request(`/api/tasks/${task.id}/undo`, { eventId: task.history.at(-1).id, revision: task.revision, requestId: randomUUID() })
  ]);
  assert.deepEqual([edit.status, undo.status].sort(), [200, 409]);
  const current = (await context.state()).tasks[0];
  assert.equal(current.revision, task.revision + 1);
  assert.equal(current.status, edit.status === 200 ? 'done' : 'next');
  assert.equal(current.title, edit.status === 200 ? 'Synthetic newer edit' : 'Synthetic race original');
  assert.equal(current.history.filter(event => event.kind === 'undo-applied').length, undo.status === 200 ? 1 : 0);
});

test('legacy changes and no-op saves get no invented undo opportunity and cannot reopen completed tasks', async t => {
  const legacy = newWorkspace();
  const eventId = randomUUID();
  const id = randomUUID();
  legacy.tasks = [{ id, title: 'Fake legacy completed task', status: 'done', revision: 1,
    history: [{ id: eventId, kind: 'completed', fromStatus: 'next', toStatus: 'done', at: '2025-01-02T03:04:05.000Z' }] }];
  const context = await setup(t, legacy);
  assert.equal((await context.request(`/api/tasks/${id}/undo`, { eventId, revision: 1, requestId: randomUUID() })).status, 409);
  const saved = await (await context.request(`/api/tasks/${id}`, { status: 'done', revision: 1 }, 'PATCH')).json();
  assert.equal(saved.task.status, 'done');
  assert.equal(saved.task.history.length, 1);
  assert.equal(saved.task.history.some(event => event.undoReceipt), false);
  assert.equal((await context.request(`/api/tasks/${id}/undo`, { eventId, revision: saved.task.revision, requestId: randomUUID() })).status, 409);
});
