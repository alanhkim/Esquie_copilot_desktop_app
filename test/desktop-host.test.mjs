import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { startOwnedServer } from '../desktop/host.mjs';

test('desktop host validates the actual protected backend, isolates ownership and preserves its workspace on restart', async t => {
  const firstDir = await mkdtemp(join(tmpdir(), 'esquie-desktop-first-'));
  const secondDir = await mkdtemp(join(tmpdir(), 'esquie-desktop-second-'));
  const hosts = [];
  t.after(async () => {
    for (const host of hosts) await host.close();
    await rm(firstDir, { recursive: true, force: true });
    await rm(secondDir, { recursive: true, force: true });
  });
  const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  const fetchImpl = (url, options) => {
    assert.equal(url.pathname, '/api/health');
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.equal(options.headers, undefined);
    return fetch(url, options);
  };
  const first = await startOwnedServer({ serverPath, dataDir: firstDir, fetchImpl });
  hosts.push(first);
  const second = await startOwnedServer({ serverPath, dataDir: secondDir, fetchImpl });
  hosts.push(second);
  assert.notEqual(first.url, second.url);
  assert.equal((await fetch(`${first.url}/api/state`)).status, 401);
  const { csrfToken } = await (await fetch(`${first.url}/api/state`, { headers: { 'X-Esquie-Access': first.accessToken } })).json();
  assert.equal((await fetch(`${first.url}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: first.url, 'X-Esquie-Access': first.accessToken, 'X-Esquie-CSRF': csrfToken },
    body: JSON.stringify({ title: 'Fake desktop restart task' })
  })).status, 201);
  await first.close();
  await assert.rejects(readFile(first.launchFile), { code: 'ENOENT' });
  assert.equal((await fetch(`${second.url}/api/health`)).ok, true);
  const restarted = await startOwnedServer({ serverPath, dataDir: firstDir, fetchImpl });
  hosts.push(restarted);
  assert.equal(first.accessToken === restarted.accessToken, false);
  const state = await (await fetch(`${restarted.url}/api/state`, { headers: { 'X-Esquie-Access': restarted.accessToken } })).json();
  assert.equal(state.tasks[0].title, 'Fake desktop restart task');
});
