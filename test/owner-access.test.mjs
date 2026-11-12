import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { startServer } from '../src/server.mjs';

test('all workspace reads and mutations require the owner capability without weakening Origin or CSRF', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-owner-access-'));
  const app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  t.after(async () => { await app.close(); await rm(root, { force: true, recursive: true }); });
  const headers = { 'X-Esquie-Access': app.accessToken };
  for (const path of ['/api/state', '/api/jobs', '/api/connections', '/api/output-settings', '/api/reports', '/api/teams']) {
    const response = await fetch(`${app.url}${path}`);
    assert.equal(response.status, 401);
    assert.equal((await response.text()).includes(app.accessToken), false);
  }
  assert.equal((await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': 'synthetic-wrong-capability' } })).status, 401);
  const state = await (await fetch(`${app.url}/api/state`, { headers })).json();
  const mutation = { method: 'POST', body: JSON.stringify({ title: 'Fake protected task' }), headers: { 'Content-Type': 'application/json', Origin: app.url, 'X-Esquie-CSRF': state.csrfToken } };
  assert.equal((await fetch(`${app.url}/api/tasks`, mutation)).status, 401);
  assert.equal((await fetch(`${app.url}/api/tasks`, { ...mutation, headers: { ...mutation.headers, ...headers, 'X-Esquie-CSRF': '' } })).status, 403);
  assert.equal((await fetch(`${app.url}/api/tasks`, { ...mutation, headers: { ...mutation.headers, ...headers, Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await fetch(`${app.url}/api/tasks`, { ...mutation, headers: { ...mutation.headers, ...headers } })).status, 201);
  assert.equal((await fetch(`${app.url}/api/state`, { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${app.url}/api/state?access=synthetic-query-value`, { headers })).status, 400);
  const health = await (await fetch(`${app.url}/api/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(Object.hasOwn(health, 'automation'), false);
  assert.equal(JSON.stringify(health).includes(app.accessToken), false);
  assert.equal(JSON.stringify(state).includes(app.accessToken), false);
  assert.equal(new URL(app.launchUrl).search, '');
  assert.equal(new URL(app.launchUrl).hash.startsWith('#access='), true);
  assert.equal((await fetch(`${app.url}/esquie-launch.html`)).status, 404);
});

test('restart rotates owner capability, preserves data, replaces stale private launchers and removes its launcher on close', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-owner-restart-'));
  let app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  t.after(async () => { await app.close(); await rm(root, { force: true, recursive: true }); });
  const previous = app.accessToken;
  const port = app.server.address().port;
  const staleLauncher = await readFile(app.launchFile, 'utf8');
  const { csrfToken } = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': previous } })).json();
  assert.equal((await fetch(`${app.url}/api/tasks`, {
    method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Esquie-Access': previous, 'X-Esquie-CSRF': csrfToken },
    body: JSON.stringify({ title: 'Fake persisted protected task' })
  })).status, 201);
  await app.close();
  await assert.rejects(readFile(app.launchFile), { code: 'ENOENT' });
  await writeFile(app.launchFile, staleLauncher, { mode: 0o600 });
  app = await startServer({ dataDir: root, port, workerIntervalMs: 0 });
  assert.equal(app.accessToken === previous, false);
  assert.equal((await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': previous } })).status, 401);
  const state = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  assert.equal(state.tasks[0].title, 'Fake persisted protected task');
  const replacement = await readFile(app.launchFile, 'utf8');
  assert.equal(replacement.includes(previous), false);
  assert.equal(replacement.includes(app.accessToken), true);
});

test('unrelated or changed launcher files are preserved and failed cleanup releases the workspace lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-owner-preserve-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const initial = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  await initial.close();
  const launchFile = join(root, 'esquie-launch.html');
  await writeFile(launchFile, 'Fake owner-authored file, not an app launcher.', { mode: 0o600 });
  await assert.rejects(startServer({ dataDir: root, port: 0, workerIntervalMs: 0 }), /unrelated launch file/);
  assert.equal(await readFile(launchFile, 'utf8'), 'Fake owner-authored file, not an app launcher.');
  await rm(launchFile);
  const app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  t.after(async () => { if (app.server.listening) await app.close(); });
  const modified = `${await readFile(launchFile, 'utf8')}\n<!-- Fake owner modification. -->`;
  await writeFile(launchFile, modified, { mode: 0o600 });
  await assert.rejects(app.close(), /launch file changed/);
  assert.equal((await readFile(launchFile, 'utf8')) === modified, true);
  await assert.rejects(startServer({ dataDir: root, port: 0, workerIntervalMs: 0 }), /modified generated launcher/);
  assert.equal((await readFile(launchFile, 'utf8')) === modified, true);
  await rm(launchFile);
  const restarted = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  await restarted.close();
});

test('standalone startup logs only a harmless base origin and private filename, never the launch capability', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-owner-console-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const environment = Object.fromEntries(['SystemRoot', 'PATH', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
    env: { ...environment, ESQUIE_DATA_DIR: root, ESQUIE_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let diagnostics = '';
  child.stderr.on('data', data => { diagnostics += data.toString(); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated standalone startup timed out.')), 15_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated standalone host stopped before startup.')); });
      child.stdout.on('data', data => {
        output += data.toString();
        if (output.includes('Open this private launch file')) { clearTimeout(timer); resolve(); }
      });
    });
    const launcher = await readFile(join(root, 'esquie-launch.html'), 'utf8');
    const capability = /#access=([A-Za-z0-9_-]{43})/.exec(launcher)?.[1];
    assert.ok(capability, 'Private launcher must contain the per-start capability.');
    assert.equal((output + diagnostics).includes(capability), false);
    assert.equal(output.includes('#access='), false);
  } finally {
    if (child.exitCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      await exit;
    }
  }
});
