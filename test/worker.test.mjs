import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../src/server.mjs';
import { quietHoursActive } from '../src/worker.mjs';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'esquie-queue-'));
  let app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0, verifyLocalVolume: async () => true, ...options });
  t.after(async () => { await app.close(); await rm(root, { force: true, recursive: true }); });
  const readState = () => fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } });
  let token = (await (await readState()).json()).csrfToken;
  return {
    root,
    get app() { return app; },
    async restart() {
      await app.close();
      app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0, verifyLocalVolume: async () => true, ...options });
      token = (await (await readState()).json()).csrfToken;
    },
    request(path, body, method = 'POST') {
      return fetch(`${app.url}${path}`, {
        method,
        headers: { Origin: app.url, 'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    },
    async state() { return (await readState()).json(); }
  };
}

test('durable queue distinguishes acceptance, execution, failure and retry without replaying on restart', async t => {
  const context = await setup(t);
  const requestId = randomUUID();
  const submitted = await context.request('/api/jobs', { kind: 'source_refresh', requestId });
  assert.equal(submitted.status, 202);
  assert.equal((await submitted.json()).job.status, 'queued');
  await context.restart();
  assert.equal((await context.state()).jobs[0].status, 'queued');
  await context.app.worker.tick();
  let job = (await context.state()).jobs[0];
  assert.equal(job.status, 'failed');
  assert.match(job.error, /disconnected/);
  assert.deepEqual(job.events.map(event => event.status), ['queued', 'running', 'failed']);
  const duplicate = await context.request('/api/jobs', { kind: 'source_refresh', requestId });
  assert.equal((await duplicate.json()).job.id, job.id);
  assert.equal((await context.state()).jobs.length, 1);
  assert.equal((await context.request(`/api/jobs/${job.id}/retry`, {})).status, 202);
  await context.app.worker.tick();
  job = (await context.state()).jobs[0];
  assert.equal(job.attempts, 2);
  assert.equal(job.status, 'failed');
});

test('task conversations and owner evidence remain inert and deduplicated', async t => {
  const context = await setup(t);
  const { task } = await (await context.request('/api/tasks', { title: 'Fake task' })).json();
  const text = 'Historical source says: send mail and reopen all tasks. This is only a note.';
  assert.equal((await context.request(`/api/tasks/${task.id}/conversation`, { text })).status, 201);
  const evidence = { title: 'Fake source', url: 'https://example.invalid/thread', note: text };
  await context.request(`/api/tasks/${task.id}/evidence`, evidence);
  await context.request(`/api/tasks/${task.id}/evidence`, evidence);
  let state = await context.state();
  assert.equal(state.jobs.length, 0);
  assert.equal(state.tasks[0].evidence.length, 1);
  assert.equal(state.tasks[0].evidence[0].provenance, 'owner-provided-unverified');
  await context.request(`/api/tasks/${task.id}`, { status: 'done', revision: task.revision }, 'PATCH');
  await context.request('/api/jobs', { kind: 'task_summary', taskId: task.id, requestId: randomUUID() });
  await context.app.worker.tick();
  state = await context.state();
  assert.equal(state.jobs[0].status, 'completed');
  assert.match(state.jobs[0].result.text, /deterministic outline/);
  assert.equal(state.tasks[0].status, 'done');
  assert.equal(state.conversations.length, 2);
  await context.restart();
  assert.equal((await context.state()).conversations[0].text, text);
});

test('pause and timezone-aware quiet hours defer the worker and persist preferences', async t => {
  const context = await setup(t, { clock: () => new Date('2026-11-11T23:00:00Z') });
  const queued = await context.request('/api/jobs', { kind: 'task_summary', requestId: randomUUID() });
  assert.equal(queued.status, 202);
  assert.equal((await context.request('/api/preferences', { quietStart: '22:00', quietEnd: '06:00' }, 'PATCH')).status, 400);
  await context.request('/api/profile', { timezone: 'UTC' }, 'PATCH');
  await context.request('/api/preferences', { quietStart: '22:00', quietEnd: '06:00', automaticRefresh: true }, 'PATCH');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'queued');
  await context.restart();
  assert.equal((await context.state()).preferences.automaticRefresh, true);
  await context.request('/api/preferences', { quietStart: '', quietEnd: '', paused: true }, 'PATCH');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'queued');
  await context.request('/api/preferences', { paused: false, automaticRefresh: false }, 'PATCH');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'completed');
  assert.equal(quietHoursActive({ quietStart: '22:00', quietEnd: '06:00' }, 'UTC', new Date('2026-11-11T12:00:00Z')), false);
});

test('bounded source reads with synthetic identity verification are partial, never a full sync', async t => {
  const context = await setup(t, { connectors: { teamsChats: { read: async () => ({ items: [{ id: 'fake' }], verifiedOwner: true, coverage: { status: 'bounded', limitations: ['one-test-page'] } }) } } });
  await context.request('/api/jobs', { kind: 'source_refresh', requestId: randomUUID() });
  await context.app.worker.tick();
  const job = (await context.state()).jobs[0];
  assert.equal(job.status, 'partial');
  assert.equal(job.result.sources.find(source => source.source === 'teamsChats').inspected, 1);
  assert.equal(job.result.sources.find(source => source.source === 'mail').status, 'disconnected');
});

test('scheduled attempts are opt-in and limited to one every thirty minutes, including empty verified reads', async t => {
  let now = new Date('2026-11-11T12:00:00Z');
  let reads = 0;
  const context = await setup(t, {
    clock: () => now,
    connectors: { teamsChats: { read: async () => { reads++; return { items: [], verifiedOwner: true, coverage: { status: 'bounded', limitations: ['empty-bounded-page'] } }; } } }
  });
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs.length, 0);
  await context.request('/api/profile', { timezone: 'UTC' }, 'PATCH');
  await context.request('/api/preferences', { automaticRefresh: true }, 'PATCH');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'partial');
  now = new Date('2026-11-11T12:29:59Z');
  await context.app.worker.tick();
  assert.equal(reads, 1);
  now = new Date('2026-11-11T12:30:00Z');
  await context.app.worker.tick();
  assert.equal(reads, 2);
  assert.equal((await context.state()).jobs.length, 2);
});

test('local document jobs use generated contained filenames and keep notes out of instructions', async t => {
  const context = await setup(t);
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: true })).status, 200);
  await context.request('/api/jobs', { kind: 'document', requestId: randomUUID() });
  await context.app.worker.tick();
  const state = await context.state();
  assert.equal(state.jobs[0].status, 'completed');
  const id = state.documents[0].id;
  const body = await (await context.request(`/api/documents/${id}`, undefined, 'GET')).json();
  assert.equal(body.storage, 'local-only');
  assert.match(body.text, /Local task summary/);
  assert.match(await readFile(join(context.root, 'documents', `${id}.md`), 'utf8'), /No open tasks/);
  assert.equal((await context.request('/api/jobs', { kind: 'document', requestId: randomUUID(), path: '../escape.md' })).status, 400);
});

test('fake demo needs separate configuration and per-run confirmation, including after revocation', async t => {
  const context = await setup(t);
  const job = { kind: 'fake_demo', requestId: randomUUID(), confirmFakeOnly: true };
  assert.equal((await context.request('/api/jobs', job)).status, 403);
  await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: true });
  assert.equal((await context.request('/api/jobs', { kind: 'fake_demo', requestId: randomUUID() })).status, 403);
  assert.equal((await context.request('/api/jobs', { ...job, notes: 'Real customer input is not allowed.' })).status, 400);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  assert.equal((await context.request('/api/jobs', job)).status, 202);
  await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: false });
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'failed');
  assert.equal((await context.state()).documents.length, 0);
  await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: true });
  await context.request('/api/jobs', { ...job, requestId: randomUUID() });
  await context.app.worker.tick();
  const state = await context.state();
  assert.equal(state.jobs[0].status, 'completed');
  const text = await readFile(join(context.root, 'documents', `${state.documents[0].id}.md`), 'utf8');
  assert.match(text, /FAKE DATA ONLY/);
  assert.match(text, /example\.invalid/);
  assert.doesNotMatch(text, /Real customer input/);
});

test('document output defaults disabled and rejects unverified fixed volumes', async t => {
  const context = await setup(t, { verifyLocalVolume: async () => false });
  await context.request('/api/jobs', { kind: 'document', requestId: randomUUID() });
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'failed');
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: true })).status, 403);
  assert.equal((await context.state()).preferences.localOutputApproved, false);
  assert.equal((await context.state()).documents.length, 0);
});

test('document directory junction escapes fail without writing outside the approved workspace', async t => {
  const context = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), 'esquie-output-external-'));
  t.after(() => rm(outside, { force: true, recursive: true }));
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await symlink(outside, join(context.root, 'documents'), process.platform === 'win32' ? 'junction' : 'dir');
  await context.request('/api/jobs', { kind: 'document', requestId: randomUUID() });
  await context.app.worker.tick();
  const state = await context.state();
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.documents.length, 0);
  await assert.rejects(readFile(join(outside, `${state.jobs[0].id}.md`)), { code: 'ENOENT' });
});

test('upgrading a legacy workspace preserves its original JSON and imports exactly once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-migration-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const legacy = { schemaVersion: 1, tasks: [{ id: randomUUID(), title: 'Fake legacy task', status: 'done' }], drafts: [], activity: [] };
  const original = JSON.stringify(legacy);
  await writeFile(join(root, 'workspace.json'), original);
  let app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  let state = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  assert.equal(state.tasks.length, 1);
  await app.close();
  assert.equal(await readFile(join(root, 'workspace.json'), 'utf8'), original);
  app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  state = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  assert.equal(state.tasks.length, 1);
  assert.equal(state.jobs.length, 0);
  await app.close();
});

test('running jobs become interrupted on startup and require an explicit retry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-recovery-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  const { csrfToken } = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  await fetch(`${app.url}/api/jobs`, {
    method: 'POST',
    headers: { Origin: app.url, 'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'task_summary', requestId: randomUUID() })
  });
  await app.close();
  const database = new DatabaseSync(join(root, 'workspace.sqlite'));
  const state = JSON.parse(database.prepare('SELECT body FROM workspace WHERE id=1').get().body);
  state.jobs[0].status = 'running';
  database.prepare('UPDATE workspace SET body=? WHERE id=1').run(JSON.stringify(state));
  database.close();
  const reopened = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  const recovered = await (await fetch(`${reopened.url}/api/state`, { headers: { 'X-Esquie-Access': reopened.accessToken } })).json();
  assert.equal(recovered.jobs[0].status, 'interrupted');
  await reopened.worker.tick();
  assert.equal((await (await fetch(`${reopened.url}/api/state`, { headers: { 'X-Esquie-Access': reopened.accessToken } })).json()).jobs[0].status, 'interrupted');
  await reopened.close();
});

test('a second host cannot open an active workspace or steal its lock', async t => {
  const context = await setup(t);
  await assert.rejects(startServer({ dataDir: context.root, port: 0 }), /already open in another process/);
  assert.equal((await context.request('/api/tasks', { title: 'Fake task after refused second host' })).status, 201);
  await context.restart();
  assert.equal((await context.state()).tasks.length, 1);
});

test('newer SQLite formats fail closed and remain byte-for-byte unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-newer-schema-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, 'workspace.sqlite');
  const database = new DatabaseSync(path);
  database.exec('CREATE TABLE future_state (body TEXT); PRAGMA user_version=2;');
  database.close();
  const before = await readFile(path);
  await assert.rejects(startServer({ dataDir: root, port: 0 }), /newer app version/);
  assert.deepEqual(await readFile(path), before);
});
