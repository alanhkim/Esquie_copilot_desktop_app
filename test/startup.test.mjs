import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { startServer } from '../src/server.mjs';

async function occupy() {
  const server = createServer((_request, response) => response.end('Synthetic occupied-port fixture.'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('occupied-port startup never creates fresh storage or changes existing disposable workspace bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-startup-boundary-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  await app.close();
  const database = new DatabaseSync(join(root, 'workspace.sqlite'));
  const saved = JSON.parse(database.prepare('SELECT body FROM workspace WHERE id=1').get().body);
  saved.jobs.push({ id: 'fake-running-job', status: 'running', error: '', updatedAt: '2026-03-04T10:00:00Z', events: [] });
  saved.draftOperations.push({ requestId: 'fake-creating-receipt', status: 'creating' });
  database.prepare('UPDATE workspace SET body=? WHERE id=1').run(JSON.stringify(saved));
  database.close();
  const before = await readFile(join(root, 'workspace.sqlite'));
  const names = (await readdir(root)).sort();
  const occupied = await occupy();
  const port = occupied.address().port;
  try {
    await assert.rejects(startServer({ dataDir: root, port }), { code: 'EADDRINUSE' });
    assert.equal((await readFile(join(root, 'workspace.sqlite'))).equals(before), true);
    assert.deepEqual((await readdir(root)).sort(), names);
    const fresh = join(root, 'must-not-be-created');
    await assert.rejects(startServer({ dataDir: fresh, port }), { code: 'EADDRINUSE' });
    await assert.rejects(lstat(fresh), { code: 'ENOENT' });
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});

test('post-bind initialization failure closes its reserved listener and releases any workspace lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-startup-cleanup-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const probe = await occupy();
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const path = join(root, 'esquie-launch.html');
  await writeFile(path, 'Fake unrelated owner file.', { mode: 0o600 });
  await assert.rejects(startServer({ dataDir: root, port, workerIntervalMs: 0 }), /ownership is not established/);
  assert.equal(await readFile(path, 'utf8'), 'Fake unrelated owner file.');
  await assert.rejects(lstat(join(root, 'workspace.lock')), { code: 'ENOENT' });
  await rm(path);
  const reopened = await startServer({ dataDir: root, port, workerIntervalMs: 0 });
  await reopened.close();
});
