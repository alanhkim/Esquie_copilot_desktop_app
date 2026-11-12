import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.mjs';

const dataDir = await mkdtemp(join(tmpdir(), 'esquie-smoke-'));
let app;
try {
  app = await startServer({ dataDir, port: 0, workerIntervalMs: 0 });
  const page = await fetch(app.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /important work forward/);

  const initial = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  const post = (path, body) => fetch(`${app.url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Esquie-Access': app.accessToken,
      Origin: app.url,
      'X-Esquie-CSRF': initial.csrfToken
    },
    body: JSON.stringify(body)
  });
  const response = await post('/api/tasks', { title: 'Fake smoke-test task', details: 'Safe to delete with the isolated temp directory.' });
  assert.equal(response.status, 201);
  const { task } = await response.json();
  assert.equal((await post(`/api/tasks/${task.id}/conversation`, { text: 'Fake local context, not instructions.' })).status, 201);
  assert.equal((await post('/api/drafts', { subject: 'Fake unsent draft', body: 'Synthetic text only.' })).status, 201);
  assert.equal((await post('/api/jobs', { kind: 'task_summary', taskId: task.id, requestId: randomUUID() })).status, 202);
  await app.worker.tick();
  await app.close();
  app = await startServer({ dataDir, port: 0, workerIntervalMs: 0 });
  const restarted = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  assert.equal(restarted.tasks[0].title, 'Fake smoke-test task');
  assert.equal(restarted.tasks.length, 1);
  assert.equal(restarted.drafts[0].subject, 'Fake unsent draft');
  assert.equal(restarted.conversations.length, 2);
  assert.equal(restarted.jobs[0].status, 'completed');
  console.log('Smoke passed: fresh local UI, SQLite task/draft/notes/job persistence across restart, and isolated temporary data.');
} finally {
  if (app) await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
