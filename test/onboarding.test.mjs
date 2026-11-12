import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { newWorkspace } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';

async function setup(t, legacy) {
  const root = await mkdtemp(join(tmpdir(), 'esquie-onboarding-'));
  if (legacy) await writeFile(join(root, 'workspace.json'), JSON.stringify(legacy), { mode: 0o600 });
  let tokenCalls = 0;
  const options = { dataDir: root, port: 0, workerIntervalMs: 0, microsoft365Options: { tokenProvider: async () => { tokenCalls++; throw new Error('Fake provider must never be reached by setup.'); } } };
  let app = await startServer(options);
  t.after(async () => { await app.close(); await rm(root, { force: true, recursive: true }); });
  const state = async () => (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  const request = async (path, body, overrides = {}) => fetch(`${app.url}${path}`, {
    method: 'PATCH', headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': (await state()).csrfToken },
    body: JSON.stringify(body), ...overrides
  });
  return {
    get app() { return app; }, get tokenCalls() { return tokenCalls; }, state, request,
    async change(action, extra = {}) { return request('/api/onboarding', { action, revision: (await state()).onboarding.revision, ...extra }); },
    async restart() { await app.close(); app = await startServer(options); }
  };
}

test('fresh setup is resumable/skippable, preserves saved steps and does not infer identity or create demo data', async t => {
  const context = await setup(t);
  assert.equal((await context.state()).onboarding.status, 'not-started');
  assert.equal((await context.change('save', { data: { displayName: 'Fake owner', timezone: 'UTC', email: 'fake@example.invalid' } })).status, 200);
  await context.restart();
  let state = await context.state();
  assert.equal(state.onboarding.step, 1);
  assert.equal(state.profile.displayName, 'Fake owner');
  await context.change('skip');
  await context.restart();
  assert.equal((await context.state()).onboarding.status, 'skipped');
  await context.change('resume');
  assert.equal((await context.state()).onboarding.step, 1);
  await context.change('save', { data: { manager: 'Fake manager', people: 'Fictional colleague only.' } });
  await context.change('save', { data: { record: { category: 'account', title: 'Fictional account', note: 'Owner-provided fake context.' } } });
  await context.change('save', { data: { workspaceName: 'Fake private workspace' } });
  await context.change('save', { data: { writingStyle: 'Concise owner preference.' } });
  await context.change('save', { data: { record: { category: 'outcome', title: 'Fictional outcome' } } });
  await context.change('save', { data: { configuration: { expectedIdentity: { tenantId: 'fake-tenant', userId: 'fake-user' }, sources: { mail: true } } } });
  assert.equal((await context.change('complete')).status, 400);
  assert.equal((await context.change('complete', { confirmReview: true })).status, 200);
  await context.restart();
  state = await context.state();
  assert.equal(state.onboarding.status, 'complete');
  assert.equal(state.records.length, 2);
  assert.equal(state.sourceConsent, null);
  assert.equal(state.sourceConfigurationDraft.sources.mail, true);
  assert.equal(state.preferences.demoApproved, false);
  assert.equal(state.jobs.length, 0);
  assert.equal(context.tokenCalls, 0);
  await context.change('resume');
  assert.equal((await context.state()).onboarding.step, 0);
});

test('returning users retain existing settings/data and legacy setup never invents completion or resets preferences', async t => {
  const legacy = newWorkspace();
  delete legacy.onboarding;
  legacy.profile = { displayName: 'Fake returning owner', timezone: 'UTC', writingStyle: 'Keep existing style.' };
  legacy.preferences.paused = true;
  legacy.preferences.automaticRefresh = true;
  const context = await setup(t, legacy);
  let state = await context.state();
  assert.equal(state.onboarding.legacy, true);
  assert.equal(state.onboarding.status, 'not-started');
  await context.change('resume');
  await context.change('save', { data: { displayName: 'Fake changed name' } });
  await context.change('go', { step: 7 });
  await context.change('complete', { confirmReview: true });
  state = await context.state();
  assert.equal(state.preferences.paused, true);
  assert.equal(state.preferences.automaticRefresh, true);
  assert.equal(state.profile.timezone, 'UTC');
  assert.equal(state.profile.writingStyle, 'Keep existing style.');
});

test('setup cannot bypass owner/CSRF checks, stale revisions, source authorization or credential-field rejection', async t => {
  const context = await setup(t);
  assert.equal((await fetch(`${context.app.url}/api/onboarding`, { method: 'PATCH', body: '{}' })).status, 401);
  assert.equal((await context.request('/api/onboarding', { action: 'skip', revision: 0 }, { headers: { 'X-Esquie-Access': context.app.accessToken } })).status, 403);
  assert.equal((await context.change('save', { data: { timezone: 'Invalid/FakeZone' } })).status, 400);
  await context.change('skip');
  assert.equal((await context.request('/api/onboarding', { action: 'save', revision: 0, data: { displayName: 'Fake stale overwrite' } })).status, 409);
  await context.change('go', { step: 6 });
  assert.equal((await context.change('save', { data: { configuration: { token: 'synthetic-not-a-token' } } })).status, 400);
  assert.equal((await context.change('save', { data: { configuration: { consent: true, expectedIdentity: {}, sources: {} } } })).status, 400);
  assert.equal((await context.state()).sourceConsent, null);
  assert.equal(context.tokenCalls, 0);
});

test('later local record/profile edits preserve record dates and reject stale edits', async t => {
  const context = await setup(t);
  await context.change('go', { step: 5 });
  await context.change('save', { data: { record: { category: 'outcome', title: 'Fake dated outcome', date: '2026-03-04' } } });
  const record = (await context.state()).records[0];
  assert.equal((await context.request(`/api/records/${record.id}`, { category: 'outcome', title: 'Fake edited outcome', revision: record.revision })).status, 200);
  assert.equal((await context.state()).records[0].date, '2026-03-04');
  assert.equal((await context.request(`/api/records/${record.id}`, { category: 'outcome', title: 'Fake stale outcome', revision: record.revision })).status, 409);
  assert.equal((await context.request('/api/profile', { people: 'Fake local context', workspaceName: 'Fake label' })).status, 200);
});
