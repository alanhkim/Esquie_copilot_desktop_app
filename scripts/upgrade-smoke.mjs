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
const saveOnboardingStep = async data => {
  const { onboarding } = await state();
  return request('/api/onboarding', { action: 'save', revision: onboarding.revision, data }, 'PATCH');
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
  await saveOnboardingStep({
    displayName: 'Synthetic Upgrade Owner', email: 'owner@example.invalid', role: 'Synthetic role', timezone: 'UTC'
  });
  await saveOnboardingStep({ manager: 'Synthetic Manager', people: 'Synthetic Person A; Synthetic Person B' });
  await saveOnboardingStep({
    record: {
      category: 'account', title: 'Synthetic upgrade account', note: 'Fake account context.',
      plan: 'Synthetic nonempty account plan.', stakeholders: 'Synthetic stakeholder A; Synthetic stakeholder B'
    }
  });
  await saveOnboardingStep({ workspaceName: 'Synthetic Upgrade Workspace' });
  await saveOnboardingStep({ writingStyle: 'Fake concise style' });
  await saveOnboardingStep({
    record: { category: 'outcome', title: 'Synthetic upgrade outcome', note: 'Fake manual outcome.' }
  });
  await saveOnboardingStep({
    configuration: { expectedIdentity: identity, sources: { mail: true, calendar: false } }
  });
  const ownerAccount = (await state()).records.find(record => record.category === 'account');
  assert.ok(ownerAccount?.plan && ownerAccount?.stakeholders, 'Synthetic account fixture must exercise nonempty legacy-supported fields.');
  const { task } = await request('/api/tasks', {
    title: 'Synthetic upgrade task', details: 'Fake local context only.', accountId: ownerAccount.id
  }, 'POST', 201);
  await request(`/api/records/${ownerAccount.id}/notes`, {
    text: 'Synthetic account history note.', revision: ownerAccount.revision
  }, 'POST', 201);
  await request(`/api/tasks/${task.id}/conversation`, { text: 'Synthetic durable conversation note.' }, 'POST', 201);
  await request(`/api/tasks/${task.id}/evidence`, {
    title: 'Synthetic owner evidence', url: 'https://example.invalid/upgrade-owner-evidence', note: 'Unverified fake evidence.'
  }, 'POST', 201);
  const current = (await state()).tasks.find(item => item.id === task.id);
  await request(`/api/tasks/${task.id}`, { status: 'done', revision: current.revision }, 'PATCH');
  const { draft } = await request('/api/drafts', {
    subject: 'Synthetic unsent upgrade draft', body: 'Fake local draft; never send.'
  }, 'POST', 201);
  await request(`/api/drafts/${draft.id}`, {
    subject: 'Edited synthetic unsent upgrade draft', body: 'Edited fake local draft; still never send.', revision: draft.revision
  }, 'PATCH');
  await request('/api/links', {
    title: 'Synthetic local link', url: 'https://example.invalid/synthetic-upgrade-link'
  }, 'POST', 201);
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
  assert.ok(before.activity.some(item =>
    item.kind === 'task-created' && item.message === 'Added task: Synthetic upgrade task'
  ), 'Synthetic task-created Activity entry must exist before upgrade.');
  assert.ok(before.activity.some(item =>
    item.kind === 'draft-updated' && item.message === 'Updated local unsent draft: Edited synthetic unsent upgrade draft'
  ), 'Synthetic draft-updated Activity entry must exist before upgrade.');
  assert.ok(before.conversations.some(item =>
    item.taskId === task.id && item.text === 'Synthetic durable conversation note.'
  ), 'Synthetic task conversation must exist before upgrade.');
  assert.deepEqual({
    paused: before.preferences.paused,
    automaticRefresh: before.preferences.automaticRefresh,
    dailyBackups: before.preferences.dailyBackups,
    quietStart: before.preferences.quietStart,
    quietEnd: before.preferences.quietEnd,
    localOutputApproved: before.preferences.localOutputApproved,
    demoApproved: before.preferences.demoApproved
  }, {
    paused: true,
    automaticRefresh: true,
    dailyBackups: true,
    quietStart: '23:00',
    quietEnd: '06:00',
    localOutputApproved: true,
    demoApproved: true
  }, 'Synthetic non-default preferences and approval flags must exist before upgrade.');
  assert.ok(before.tasks.find(item => item.id === task.id).completedAt);
  assert.equal(before.tasks.find(item => item.id === task.id).accountId, ownerAccount.id);
  assert.ok(before.tasks.find(item => item.id !== task.id).evidence[0].sourceReference.resultId);
  const expectedAccount = before.records.find(record => record.id === ownerAccount.id);
  assert.equal(expectedAccount.plan, 'Synthetic nonempty account plan.');
  assert.equal(expectedAccount.stakeholders, 'Synthetic stakeholder A; Synthetic stakeholder B');
  assert.equal(expectedAccount.history.length, 1);
  assert.equal(expectedAccount.history[0].text, 'Synthetic account history note.');
  assert.equal(expectedAccount.history[0].provenance, 'owner-provided-unverified');
  assert.ok(expectedAccount.history[0].id);
  assert.equal(before.profile.displayName, 'Synthetic Upgrade Owner');
  assert.equal(before.profile.email, 'owner@example.invalid');
  assert.equal(before.profile.timezone, 'UTC');
  assert.equal(before.profile.manager, 'Synthetic Manager');
  assert.equal(before.profile.people, 'Synthetic Person A; Synthetic Person B');
  assert.equal(before.profile.workspaceName, 'Synthetic Upgrade Workspace');
  assert.equal(before.profile.role, 'Synthetic role');
  assert.equal(before.profile.writingStyle, 'Fake concise style');
  assert.equal(before.onboarding.status, 'in-progress');
  assert.equal(before.onboarding.step, 7);
  assert.deepEqual(before.sourceConfigurationDraft, {
    expectedIdentity: identity, sources: { mail: true, calendar: false }
  });
  assert.equal(before.links.length, 1);
  const expectedLink = before.links[0];
  assert.equal(expectedLink.title, 'Synthetic local link');
  assert.equal(expectedLink.url, 'https://example.invalid/synthetic-upgrade-link');
  assert.equal(before.drafts[0].subject, 'Edited synthetic unsent upgrade draft');
  assert.equal(before.drafts[0].body, 'Edited fake local draft; still never send.');
  assert.equal(before.drafts[0].revision, 2);
  const oldAccessToken = app.accessToken;
  await app.close();
  app = await startServer({
    dataDir, port: 0, workerIntervalMs: 0,
    microsoft365Options: { tokenProvider: unexpectedProvider, transport: unexpectedProvider }
  });
  const after = await state();
  const exactFields = [
    'tasks', 'conversations', 'drafts', 'links', 'records', 'profile', 'preferences', 'jobs',
    'sourceConsent', 'sourceConfigurationDraft', 'onboarding', 'scheduler'
  ];
  for (const field of exactFields) {
    assert.deepEqual(after[field], before[field], `Upgrade changed persisted ${field}`);
  }
  for (const savedActivity of before.activity) {
    assert.deepEqual(
      after.activity.find(item => item.id === savedActivity.id),
      savedActivity,
      `Upgrade changed or removed Activity entry ${savedActivity.id}`
    );
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
  for (const field of [...exactFields, 'activity']) {
    assert.deepEqual(restarted[field], after[field], `Candidate restart changed ${field}`);
  }
  console.log('Upgrade passed: exact exported public source -> candidate -> candidate restart; task IDs/completion/history/account association, conversations, owner/source evidence provenance, edited unsent draft/revision, local link, nonempty account plan/stakeholders/history, profile fields, onboarding progress, nonsecret source-configuration draft, preferences, approval flags, jobs, Activity and scheduler preserved. Source consent is historical only; connection/capabilities are intentionally not restored. Zero candidate-upgrade source/credential requests. This does not verify a desktop installer, arbitrary legacy fields, Outlook receipts or live cloud compatibility.');
} finally {
  if (app) await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
