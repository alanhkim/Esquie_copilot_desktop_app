import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { isDashboardUrl, isExternalWebUrl, startOwnedServer } from '../host.mjs';
import { active } from './fixtures/server.mjs';

const serverPath = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));

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
