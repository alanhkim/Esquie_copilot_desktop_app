import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDashboardUrl, isExternalWebUrl, startOwnedServer, workspaceDataDir } from '../host.mjs';
import { active } from './fixtures/server.mjs';

const serverPath = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));

test('workspace selection prefers injected data, then environment, then the existing desktop default', () => {
  const env = { ESQUIE_DATA_DIR: 'selected-workspace', LOCALAPPDATA: 'local-app-data' };
  assert.equal(workspaceDataDir({ dataDir: 'injected-workspace', env, userDataDir: 'user-data' }), 'injected-workspace');
  assert.equal(workspaceDataDir({ env, userDataDir: 'user-data' }), 'selected-workspace');
  assert.equal(workspaceDataDir({ env: { ...env, ESQUIE_DATA_DIR: '' }, userDataDir: 'user-data' }),
    join('local-app-data', 'EsquieLocal', 'Workspace'));
  assert.equal(workspaceDataDir({ env: {}, userDataDir: 'user-data' }),
    join('user-data', 'EsquieLocal', 'Workspace'));
});

test('selected workspaces retain backend safety checks and cannot be opened twice', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-desktop-selection-'));
  let host;
  t.after(async () => {
    if (host) await host.close();
    await rm(root, { recursive: true, force: true });
  });
  const actualServer = fileURLToPath(new URL('../../src/server.mjs', import.meta.url));
  const selected = workspaceDataDir({ env: { ESQUIE_DATA_DIR: root }, userDataDir: 'unused' });
  const { startServer } = await import(pathToFileURL(actualServer).href);
  host = await startServer({ dataDir: selected, port: 0, workerIntervalMs: 0 });
  const headers = { 'X-Esquie-Access': host.accessToken };
  const state = await (await fetch(`${host.url}/api/state`, { headers })).json();
  const created = await fetch(`${host.url}/api/tasks`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Origin: host.url, 'X-Esquie-CSRF': state.csrfToken },
    body: JSON.stringify({ title: 'Synthetic shared workspace task' })
  });
  assert.equal(created.status, 201);
  await host.close();
  host = await startOwnedServer({ serverPath: actualServer, dataDir: selected });
  const reopened = await (await fetch(`${host.url}/api/state`, {
    headers: { 'X-Esquie-Access': host.accessToken }
  })).json();
  assert.equal(reopened.tasks[0].title, 'Synthetic shared workspace task');
  const before = await readFile(join(root, 'workspace.sqlite'));
  await assert.rejects(startOwnedServer({ serverPath: actualServer, dataDir: selected }), /already open|unverified lock/i);
  assert.deepEqual(await readFile(join(root, 'workspace.sqlite')), before);
  assert.equal((await fetch(`${host.url}/api/health`)).ok, true);

  const unsafe = workspaceDataDir({
    env: { ESQUIE_DATA_DIR: fileURLToPath(new URL('../../', import.meta.url)) }, userDataDir: 'unused'
  });
  await assert.rejects(startOwnedServer({ serverPath: actualServer, dataDir: unsafe }), /outside.*repository/i);
});

test('only the exact local origin is allowed in the dashboard window', () => {
  const origin = 'http://127.0.0.1:1234';
  assert.equal(isDashboardUrl(`${origin}/tasks`, origin), true);
  for (const url of ['http://127.0.0.1:1235/', 'http://localhost:1234/', 'https://127.0.0.1:1234/',
    'http://user@127.0.0.1:1234/', 'file:///test', 'javascript:alert(1)', 'not a URL']) {
    assert.equal(isDashboardUrl(url, origin), false, url);
  }
  assert.equal(isExternalWebUrl('https://example.com/'), true);
  assert.equal(isExternalWebUrl('file:///test'), false);
  assert.equal(isExternalWebUrl('https://user@example.com/'), false);
});

test('independent servers use isolated ephemeral ports and stop only their owner', async () => {
  let first;
  let second;
  try {
    first = await startOwnedServer({ serverPath, dataDir: 'first' });
    second = await startOwnedServer({ serverPath, dataDir: 'second' });
    assert.notEqual(first.url, second.url);
    await first.close();
    first = null;
    assert.equal((await fetch(`${second.url}/api/health`)).ok, true);
  } finally {
    if (first) await first.close();
    if (second) await second.close();
  }
});

test('failed health checks close the newly owned server', async () => {
  let endpoint;
  await assert.rejects(startOwnedServer({
    serverPath, dataDir: 'health-fail',
    fetchImpl: async (url, options) => {
      assert.equal(url.pathname, '/api/health');
      assert.equal(url.search, '');
      assert.equal(url.hash, '');
      assert.equal(options.headers, undefined);
      endpoint = url.origin;
      return { ok: false, status: 503 };
    }
  }), /health check failed/);
  await assert.rejects(fetch(`${endpoint}/api/health`));
});

test('invalid launch contracts fail closed without leaking capabilities and stop the server', async () => {
  for (const dataDir of ['no-backend', 'missing-launch', 'invalid-launch', 'wrong-origin', 'wrong-token',
    'missing-token', 'bad-token', 'token-in-query', 'other-path', 'bad-base']) {
    await assert.rejects(startOwnedServer({
      serverPath, dataDir,
      fetchImpl: () => { throw new Error('Health check must not run for invalid contracts.'); }
    }), error => {
      assert.match(error.message, /invalid endpoint|invalid launch capability/);
      assert.doesNotMatch(error.message, /access=|not a url/);
      return true;
    });
    assert.equal(active.size, 0, `${dataDir} leaked an owned listener`);
  }
});
