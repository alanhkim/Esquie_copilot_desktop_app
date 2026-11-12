import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('literal runtime resource allowlist forms a standalone backend without Electron artifacts', async () => {
  const config = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
  const resources = config.build.extraResources;
  assert.deepEqual(resources.map(({ from, to }) => ({ from, to })), [
    { from: '../src', to: 'workspace/src' },
    { from: '../public', to: 'workspace/public' }
  ]);
  assert.ok(resources.find(resource => resource.to === 'workspace/public').filter.includes('task-board.mjs'));
  assert.ok(resources.find(resource => resource.to === 'workspace/src').filter.includes('connectors/safe-file-download.mjs'));
  assert.ok(resources.find(resource => resource.to === 'workspace/src').filter.includes('windows-ocr.mjs'));
  for (const resource of resources) {
    assert.ok(Array.isArray(resource.filter) && resource.filter.length > 0);
    for (const file of resource.filter) {
      assert.match(file, /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.[a-zA-Z0-9]+$/, 'Only explicit relative runtime filenames are allowed.');
    }
  }

  const temp = await mkdtemp(join(tmpdir(), 'esquie-resource-test-'));
  let app;
  try {
    for (const resource of resources) {
      for (const file of resource.filter) {
        const destination = join(temp, resource.to, file);
        await mkdir(dirname(destination), { recursive: true });
        await cp(resolve(desktop, resource.from, file), destination);
      }
    }
    const { startServer } = await import(pathToFileURL(join(temp, 'workspace', 'src', 'server.mjs')).href);
    app = await startServer({ dataDir: join(temp, 'private-data'), port: 0, workerIntervalMs: 0 });
    assert.equal((await fetch(`${app.url}/api/health`)).ok, true);
    assert.equal((await fetch(`${app.url}/api/state`)).status, 401);
    assert.equal((await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).ok, true);
    for (const asset of ['/', '/app.js', '/styles.css', '/task-board.mjs', '/account-search.mjs', '/account-workspace.mjs', '/outcome-import-workflow.mjs']) {
      const response = await fetch(`${app.url}${asset}`);
      assert.equal(response.ok, true, asset);
      if (asset.endsWith('.mjs')) {
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          await readFile(resolve(desktop, '..', 'public', asset.slice(1))),
          `${asset} must serve the exact allowlisted module.`
        );
      }
    }
    const module = await fetch(`${app.url}/task-board.mjs`);
    assert.match(module.headers.get('content-type'), /^text\/javascript(?:;|$)/);
    assert.equal(await module.text(), await readFile(join(desktop, '..', 'public', 'task-board.mjs'), 'utf8'));
  } finally {
    try {
      if (app) await app.close();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
});
