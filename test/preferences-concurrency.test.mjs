import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/server.mjs';

async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-preferences-race-'));
  const app = await startServer({ dataDir, port: 0, workerIntervalMs: 0 });
  const state = await (await fetch(`${app.url}/api/state`, {
    headers: { 'X-Esquie-Access': app.accessToken }
  })).json();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return {
    app, csrfToken: state.csrfToken,
    async patch(body) {
      return fetch(`${app.url}/api/preferences`, {
        method: 'PATCH',
        headers: {
          Origin: app.url, 'X-Esquie-Access': app.accessToken,
          'X-Esquie-CSRF': state.csrfToken, 'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    },
    async state() {
      return (await fetch(`${app.url}/api/state`, {
        headers: { 'X-Esquie-Access': app.accessToken }
      })).json();
    }
  };
}

function delayedPatch(app, csrfToken, prefix) {
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const request = httpRequest(`${app.url}/api/preferences`, {
    method: 'PATCH',
    headers: {
      Origin: app.url, 'X-Esquie-Access': app.accessToken,
      'X-Esquie-CSRF': csrfToken, 'Content-Type': 'application/json'
    }
  }, incoming => {
    const chunks = [];
    incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => resolveResponse({
      status: incoming.statusCode,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }));
  });
  request.on('error', rejectResponse);
  request.flushHeaders();
  request.write(prefix);
  return {
    response,
    finish(suffix) { request.end(suffix); }
  };
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('newer applied pause and quiet-hours decisions win; unrelated older fields are reported and retained', async t => {
  const context = await setup(t);
  const profile = await fetch(`${context.app.url}/api/profile`, {
    method: 'PATCH',
    headers: {
      Origin: context.app.url, 'X-Esquie-Access': context.app.accessToken,
      'X-Esquie-CSRF': context.csrfToken, 'Content-Type': 'application/json'
    },
    body: JSON.stringify({ timezone: 'UTC' })
  });
  assert.equal(profile.status, 200);

  const older = delayedPatch(
    context.app, context.csrfToken,
    '{"paused":false,"automaticRefresh":true,"quietStart":"22:00","quietEnd":"06:00"'
  );
  await delay(30);
  const newer = await context.patch({
    paused: true, quietStart: '00:00', quietEnd: '00:00'
  });
  assert.equal(newer.status, 200);
  older.finish('}');
  const stale = await older.response;
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.appliedFields, ['automaticRefresh']);
  assert.deepEqual(stale.body.conflictingFields, ['paused', 'quietStart', 'quietEnd']);
  assert.equal(stale.body.preferences.paused, true);
  assert.equal(stale.body.preferences.automaticRefresh, true);
  assert.equal(stale.body.preferences.quietStart, '00:00');
  assert.equal(stale.body.preferences.quietEnd, '00:00');
});

test('a malformed newer preference body does not supersede a valid delayed update', async t => {
  const context = await setup(t);
  const older = delayedPatch(context.app, context.csrfToken, '{"paused":false');
  await delay(30);
  const malformed = await context.patch({ paused: 'false' });
  assert.equal(malformed.status, 400);
  older.finish('}');
  const applied = await older.response;
  assert.equal(applied.status, 200);
  assert.equal(applied.body.preferences.paused, false);
  assert.equal((await context.state()).preferences.paused, false);
});
