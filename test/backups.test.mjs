import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/server.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'esquie-backup-test-'));
  let now = new Date('2026-03-04T10:00:00Z');
  let app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0, verifyLocalVolume: async () => true, clock: () => now });
  t.after(async () => { await app.close(); await rm(root, { force: true, recursive: true }); });
  const state = async () => (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  const request = async (path, body, method = 'POST') => fetch(`${app.url}${path}`, {
    method, headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': (await state()).csrfToken },
    body: JSON.stringify(body)
  });
  return {
    root, get app() { return app; }, state, request,
    clock(value) { now = new Date(value); },
    async restart() {
      await app.close();
      app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0, verifyLocalVolume: async () => true, clock: () => now });
    },
    async queue(kind) {
      const response = await request('/api/jobs', { kind, requestId: randomUUID() });
      assert.equal(response.status, 202);
      return (await response.json()).job;
    }
  };
}

test('live snapshots recover consistent historical state into a separate paused workspace without tokens or document-file claims', async t => {
  const context = await setup(t);
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: true })).status, 200);
  const task = (await (await context.request('/api/tasks', { title: 'Fake snapshot task' })).json()).task;
  assert.equal((await context.request('/api/tasks/' + task.id + '/conversation', { text: 'Fake saved note.' })).status, 201);
  assert.equal((await context.request('/api/drafts', { recipient: 'fake@example.invalid', subject: 'Fake unsent draft', body: 'Fake text only.' })).status, 201);
  await context.queue('document');
  await context.app.worker.tick();
  await context.queue('backup');
  await context.queue('task_summary');
  await context.app.worker.tick();
  const state = await context.state();
  assert.equal(state.backups.length, 1);
  const backup = state.backups[0];
  assert.equal(backup.coverage.documents.status, 'not-included');
  assert.equal(backup.coverage.documents.metadataCount, 1);
  const directory = join(context.root, 'backups', backup.id);
  assert.deepEqual((await readdir(directory)).sort(), ['manifest.json', 'workspace.sqlite']);
  for (const name of ['manifest.json', 'workspace.sqlite']) assert.equal((await readFile(join(directory, name))).includes(Buffer.from(context.app.accessToken)), false);
  await context.request(`/api/tasks/${task.id}`, { title: 'Fake newer current task', revision: task.revision }, 'PATCH');
  context.clock('2026-03-05T12:00:00Z');
  const response = await context.request(`/api/backups/${backup.id}/recover`, { confirmSeparateWorkspace: true });
  assert.equal(response.status, 201);
  const recovery = (await response.json()).recovery;
  const recovered = await startServer({ dataDir: recovery.directory, port: 0, workerIntervalMs: 0 });
  try {
    const restored = await (await fetch(`${recovered.url}/api/state`, { headers: { 'X-Esquie-Access': recovered.accessToken } })).json();
    assert.equal(restored.tasks[0].title, 'Fake snapshot task');
    assert.equal(restored.conversations.some(item => item.text === 'Fake saved note.'), true);
    assert.equal(restored.drafts[0].subject, 'Fake unsent draft');
    assert.equal(restored.drafts[0].sent, false);
    assert.equal(restored.preferences.paused, true);
    assert.equal(restored.preferences.localOutputApproved, false);
    assert.equal(restored.preferences.dailyBackups, false);
    assert.equal(restored.sourceConsent, null);
    assert.equal(restored.jobs.some(job => ['queued', 'running'].includes(job.status)), false);
    const interrupted = restored.jobs.find(job => job.kind === 'task_summary');
    assert.equal(interrupted.updatedAt, recovery.createdAt);
    assert.equal(interrupted.events.at(-1).at, recovery.createdAt);
    assert.equal((await fetch(`${recovered.url}/api/documents/${restored.documents[0].id}`, { headers: { 'X-Esquie-Access': recovered.accessToken } })).status, 410);
    assert.equal((await context.state()).tasks[0].title, 'Fake newer current task');
  } finally { await recovered.close(); }
  await context.restart();
  assert.equal((await context.state()).backups[0].id, backup.id);
  assert.equal((await fetch(`${context.app.url}/api/backups/${backup.id}/recover`, {
    method: 'POST', headers: { Origin: context.app.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmSeparateWorkspace: true })
  })).status, 401);
});

test('daily backup attempts respect quiet hours, pause, restart and failures without repeated daily writes or pruning', async t => {
  const context = await setup(t);
  await context.request('/api/profile', { timezone: 'UTC' }, 'PATCH');
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await context.request('/api/preferences', { dailyBackups: true, quietStart: '09:00', quietEnd: '11:00' }, 'PATCH');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs.length, 0);
  context.clock('2026-03-04T12:00:00Z');
  await context.app.worker.tick();
  assert.equal((await context.state()).backups.length, 1);
  await context.restart();
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs.length, 1);
  context.clock('2026-03-05T12:00:00Z');
  await context.request('/api/preferences', { paused: true }, 'PATCH');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs.length, 1);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: false });
  await context.request('/api/preferences', { paused: false }, 'PATCH');
  await context.app.worker.tick();
  await context.app.worker.tick();
  const state = await context.state();
  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.backups.length, 1);
  assert.equal((await readdir(join(context.root, 'backups'))).length, 1);
});

test('corrupt backups and pre-existing destinations fail closed without overwriting or deleting anything', async t => {
  const context = await setup(t);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  const blocked = await context.queue('backup');
  const directory = join(context.root, 'backups', blocked.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'owner-file.txt'), 'Fake owner file to preserve.', { mode: 0o600 });
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'failed');
  assert.equal(await readFile(join(directory, 'owner-file.txt'), 'utf8'), 'Fake owner file to preserve.');
  await context.queue('backup');
  await context.app.worker.tick();
  const backup = (await context.state()).backups[0];
  const snapshot = join(context.root, 'backups', backup.id, 'workspace.sqlite');
  await appendFile(snapshot, 'Fake corruption.');
  const before = await readFile(snapshot);
  assert.equal((await context.request(`/api/backups/${backup.id}/recover`, { confirmSeparateWorkspace: true })).status, 409);
  assert.equal((await readFile(snapshot)).equals(before), true);
  assert.equal((await context.state()).recoveries.length, 0);
});
