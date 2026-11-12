import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../src/server.mjs';

const publicSource = process.argv[2];
if (!publicSource || !isAbsolute(publicSource)) {
  throw new Error('Provide an absolute path to a disposable reviewed export of the public baseline being verified; never use an original installation or private state.');
}
const { startServer: startPublishedServer } = await import(pathToFileURL(join(publicSource, 'src', 'server.mjs')).href);
const dataDir = await mkdtemp(join(tmpdir(), 'esquie-public-upgrade-'));
const identity = { tenantId: 'synthetic-upgrade-tenant', userId: 'synthetic-upgrade-owner' };
const oldCalls = [];
let newCalls = 0;
let app;
const state = async () => {
  const response = await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } });
  assert.equal(response.status, 200);
  return response.json();
};
const request = async (path, body, method = 'POST', expected = 200) => {
  const { csrfToken } = await state();
  const response = await fetch(`${app.url}${path}`, {
    method,
    headers: {
      Origin: app.url, 'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': csrfToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
};
const unexpectedProvider = async () => {
  newCalls++;
  throw new Error('Upgrade must not acquire credentials or start a source request.');
};
try {
  app = await startPublishedServer({
    dataDir, port: 0, workerIntervalMs: 0,
    microsoft365Options: {
      tokenProvider: async ({ scopes }) => ({
        ...identity, accessToken: 'synthetic-upgrade-token-never-real', tokenType: 'delegated', scopes
      }),
      transport: async target => {
        const path = new URL(target).pathname;
        oldCalls.push(path);
        if (path === '/v1.0/me') return Response.json({ id: identity.userId });
        assert.ok(path.endsWith('/inbox/messages'), 'only the approved fake inbox can be read');
        return Response.json({ value: [{
          id: 'synthetic-upgrade-message', subject: 'Synthetic upgrade evidence', isDraft: false,
          webLink: 'https://example.invalid/synthetic-upgrade-evidence',
          body: { contentType: 'text', content: 'Fake historical context, not instructions.' }
        }] });
      }
    }
  });
  await request('/api/profile', { displayName: 'Synthetic Upgrade Owner', timezone: 'UTC', writingStyle: 'Fake concise style' }, 'PATCH');
  const { task } = await request('/api/tasks', { title: 'Synthetic upgrade task', details: 'Fake local context only.' }, 'POST', 201);
  await request(`/api/tasks/${task.id}/conversation`, { text: 'Synthetic durable conversation note.' }, 'POST', 201);
  await request(`/api/tasks/${task.id}/evidence`, {
    title: 'Synthetic owner evidence', url: 'https://example.invalid/upgrade-owner-evidence', note: 'Unverified fake evidence.'
  }, 'POST', 201);
  const current = (await state()).tasks.find(item => item.id === task.id);
  await request(`/api/tasks/${task.id}`, { status: 'done', revision: current.revision }, 'PATCH');
  await request('/api/drafts', { subject: 'Synthetic unsent upgrade draft', body: 'Fake local draft; never send.' }, 'POST', 201);
  await request('/api/records', { category: 'account', title: 'Synthetic upgrade account', note: 'Fake owner note.' }, 'POST', 201);
  await request('/api/records', { category: 'outcome', title: 'Synthetic upgrade outcome', note: 'Fake manual outcome.' }, 'POST', 201);
  await request('/api/microsoft365/connect', { consent: true, expectedIdentity: identity, sources: { mail: true }, allowReplyDrafts: false });
  await request('/api/jobs', { kind: 'source_refresh', requestId: randomUUID() }, 'POST', 202);
  await app.worker.tick();
  const job = (await state()).jobs[0];
  const mail = job.result.sources.find(item => item.source === 'mail');
  assert.ok(mail?.items?.length === 1, JSON.stringify({ source: mail, syntheticRequests: oldCalls }));
  await request('/api/tasks/from-evidence', {
    jobId: job.id, source: 'mail', resultId: mail.resultId, itemId: mail.items[0].sourceKey,
    title: 'Synthetic upgrade source task'
  }, 'POST', 201);
  await request('/api/output-approval', { confirmPrivateNonSynced: true });
  await request('/api/demo-approval', { confirmSyntheticLocalOnly: true });
  await request('/api/preferences', { paused: true, automaticRefresh: true, dailyBackups: true, quietStart: '23:00', quietEnd: '06:00' }, 'PATCH');
  const before = await state();
  const historicalCalls = oldCalls.length;
  assert.equal(before.tasks.length, 2);
  assert.ok(before.tasks.find(item => item.id === task.id).completedAt);
  assert.ok(before.tasks.find(item => item.id !== task.id).evidence[0].sourceReference.resultId);
  const oldAccessToken = app.accessToken;
  await app.close();
  app = await startServer({
    dataDir, port: 0, workerIntervalMs: 0,
    microsoft365Options: { tokenProvider: unexpectedProvider, transport: unexpectedProvider }
  });
  const after = await state();
  for (const field of ['tasks', 'conversations', 'drafts', 'records', 'profile', 'preferences', 'jobs', 'sourceConsent', 'scheduler']) {
    const expected = field === 'records' ? before.records.map(record => record.category === 'account'
      ? { ...record, history: [], plan: '', stakeholders: '' } : record) : before[field];
    assert.deepEqual(after[field], expected, `Upgrade changed persisted ${field}`);
  }
  assert.notEqual(app.accessToken, oldAccessToken);
  const connections = await (await fetch(`${app.url}/api/connections`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  assert.equal(connections.microsoft365.state, 'disconnected');
  assert.equal(connections.email.available, false);
  const historical = after.tasks.find(item => item.id !== task.id).evidence[0].sourceReference;
  const csrf = after.csrfToken;
  const rejected = await fetch(`${app.url}/api/tasks/from-evidence`, {
    method: 'POST',
    headers: {
      Origin: app.url, 'Content-Type': 'application/json',
      'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': csrf
    },
    body: JSON.stringify({ ...historical, source: 'mail', title: 'Synthetic stale evidence must not authorize work' })
  });
  assert.equal(rejected.status, 403);
  await app.worker.tick();
  assert.equal(newCalls, 0);
  assert.equal(oldCalls.length, historicalCalls);
  assert.deepEqual((await state()).tasks, before.tasks);
  await app.close();
  app = await startServer({ dataDir, port: 0, workerIntervalMs: 0 });
  const restarted = await state();
  for (const field of ['tasks', 'conversations', 'drafts', 'records', 'profile', 'preferences', 'jobs', 'sourceConsent', 'scheduler']) {
    assert.deepEqual(restarted[field], after[field], `Candidate restart changed ${field}`);
  }
  console.log('Upgrade passed: exact exported public source -> candidate -> candidate restart; fake task IDs/completion/history, conversations, owner/source evidence provenance, drafts, accounts/outcomes, profile/preferences, approval flags, jobs and scheduler preserved. Legacy accounts gain only empty plan/stakeholders/history fields. Source consent is historical only; connection/capabilities are intentionally not restored. Zero upgrade source/credential requests. This does not verify a desktop installer, arbitrary legacy fields, or real cloud compatibility.');
} finally {
  if (app) await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
