import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/server.mjs';

async function workspace(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-test-'));
  let app = await startServer({ dataDir, port: 0, ...options });
  const context = { app, baseUrl: app.url, dataDir };
  t.after(async () => {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  context.restart = async () => {
    await app.close();
    app = await startServer({ dataDir, port: 0, ...options });
    context.app = app;
    context.baseUrl = app.url;
    context.state = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
    return app;
  };
  context.state = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  context.request = (path, { method = 'GET', body, token = context.state.csrfToken, origin = app.url } = {}) =>
    fetch(`${app.url}${path}`, {
      method,
      headers: {
        'X-Esquie-Access': app.accessToken,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { Origin: origin, 'X-Esquie-CSRF': token })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  return context;
}

test('binds only to loopback and serves a hardened fresh-install shell', async t => {
  const { app, baseUrl } = await workspace(t);
  assert.equal(app.server.address().address, '127.0.0.1');
  const [health, page, appModule, importWorkflowModule] = await Promise.all([
    fetch(`${baseUrl}/api/health`),
    fetch(baseUrl),
    fetch(`${baseUrl}/app.js`),
    fetch(`${baseUrl}/outcome-import-workflow.mjs`)
  ]);
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ok');
  assert.equal(healthBody.authenticatedApi, true);
  assert.equal(Object.hasOwn(healthBody, 'automation'), false);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const module = await fetch(`${baseUrl}/task-board.mjs`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /text\/javascript/);
  assert.match(await module.text(), /export function matchingTasks/);
  const [pageText, appScript, workflowScript] = await Promise.all([page.text(), appModule.text(), importWorkflowModule.text()]);
  assert.match(pageText, /Your local workspace/);
  assert.match(pageText, /<script type="module" src="\/app\.js">/);
  assert.match(appScript, /from '\.\/outcome-import-workflow\.mjs'/);
  assert.match(workflowScript, /export function createOutcomeImportWorkflow/);
});

test('persists task and draft state across a server restart', async t => {
  const context = await workspace(t);
  const taskResponse = await context.request('/api/tasks', {
    method: 'POST',
    body: { title: 'Review the sample agenda', details: 'Fake test content only.', priority: 'important', dueDate: '2026-10-28' }
  });
  assert.equal(taskResponse.status, 201);
  const { task } = await taskResponse.json();
  assert.equal(task.status, 'next');
  assert.equal(task.priority, 'important');
  assert.equal(task.dueDate, '2026-10-28');

  const draftResponse = await context.request('/api/drafts', {
    method: 'POST',
    body: { recipient: 'fake@example.invalid', subject: 'Sample reply', body: 'A local unsent test draft.' }
  });
  assert.equal(draftResponse.status, 201);
  const { draft } = await draftResponse.json();
  const editResponse = await context.request(`/api/drafts/${draft.id}`, {
    method: 'PATCH',
    body: { subject: 'Updated sample reply', body: 'Still local and unsent.', revision: draft.revision }
  });
  assert.equal(editResponse.status, 200);
  assert.equal((await editResponse.json()).draft.sent, false);

  const profileResponse = await context.request('/api/profile', {
    method: 'PATCH',
    body: { displayName: 'Fake Owner', timezone: 'America/Los_Angeles' }
  });
  assert.equal(profileResponse.status, 200);
  const linkResponse = await context.request('/api/links', {
    method: 'POST',
    body: { title: 'Sample local reference', url: 'https://example.invalid/reference' }
  });
  assert.equal(linkResponse.status, 201);

  const restarted = await context.restart();
  const persisted = await (await fetch(`${restarted.url}/api/state`, { headers: { 'X-Esquie-Access': restarted.accessToken } })).json();
  assert.equal(persisted.tasks.length, 1);
  assert.equal(persisted.tasks[0].id, task.id);
  assert.equal(persisted.drafts.length, 1);
  assert.equal(persisted.drafts[0].sent, false);
  assert.equal(persisted.drafts[0].storage, 'local-only');
  assert.equal(persisted.drafts[0].subject, 'Updated sample reply');
  assert.deepEqual(persisted.profile, { displayName: 'Fake Owner', timezone: 'America/Los_Angeles' });
  assert.equal(persisted.links.length, 1);
  assert.equal(persisted.links[0].url, 'https://example.invalid/reference');
});

test('identical labeled-link retries deduplicate across restart while distinct labels and destinations remain saveable', async t => {
  const context = await workspace(t);
  const body = { title: 'Original synthetic label', url: 'https://EXAMPLE.invalid:443/reference' };
  const responses = await Promise.all([0, 1].map(() => context.request('/api/links', { method: 'POST', body })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  const results = await Promise.all(responses.map(response => response.json()));
  assert.equal(results[0].link.id, results[1].link.id);
  const original = results[0].link;
  assert.equal(original.url, 'https://example.invalid/reference');
  const unauthorized = await context.request('/api/links', { method: 'POST', token: '', body: { ...body, title: 'Blocked label' } });
  assert.equal(unauthorized.status, 403);
  await context.restart();
  const retry = await context.request('/api/links', {
    method: 'POST', body: { title: body.title, url: original.url }
  });
  assert.equal(retry.status, 200);
  const receipt = await retry.json();
  assert.equal(receipt.deduplicated, true);
  assert.deepEqual(receipt.link, original);
  const state = await (await context.request('/api/state')).json();
  assert.deepEqual(state.links, [original]);
  assert.equal(state.activity.filter(item => item.kind === 'link-saved').length, 1);
  const differentlyLabeled = await context.request('/api/links', {
    method: 'POST', body: { title: 'Different synthetic label', url: original.url }
  });
  assert.equal(differentlyLabeled.status, 201, 'the owner may intentionally save the same URL with another label');
  const second = (await differentlyLabeled.json()).link;
  assert.notEqual(second.id, original.id);
  await context.restart();
  const repeatedLabel = await context.request('/api/links', {
    method: 'POST', body: { title: second.title, url: second.url }
  });
  assert.deepEqual(await repeatedLabel.json(), { link: second, deduplicated: true });
  const retained = await (await context.request('/api/state')).json();
  assert.deepEqual(retained.links, [second, original]);
  assert.equal(retained.activity.filter(item => item.kind === 'link-saved').length, 2);
  const distinct = await context.request('/api/links', {
    method: 'POST', body: { title: body.title, url: 'https://example.invalid/different' }
  });
  assert.equal(distinct.status, 201, 'equal labels must not imply equal destinations');
});

test('rejects task mutations without a valid local origin and CSRF token', async t => {
  const { request } = await workspace(t);
  const noToken = await request('/api/tasks', { method: 'POST', token: '', body: { title: 'Blocked' } });
  assert.equal(noToken.status, 403);
  const foreignOrigin = await request('/api/tasks', { method: 'POST', origin: 'https://attacker.invalid', body: { title: 'Blocked' } });
  assert.equal(foreignOrigin.status, 403);
  const malformed = await request('/api/tasks', { method: 'POST', body: { title: '   ' } });
  assert.equal(malformed.status, 400);
  const invalidDueDate = await request('/api/tasks', { method: 'POST', body: { title: 'Fake date check', dueDate: '2026-02-31' } });
  assert.equal(invalidDueDate.status, 400);
  const unexpectedAction = await request('/api/tasks', { method: 'POST', body: { title: 'Fake action check', sendImmediately: true } });
  assert.equal(unexpectedAction.status, 400);
});

test('local draft creation cannot send email and reports disconnected mail', async t => {
  const { request } = await workspace(t);
  const response = await request('/api/drafts', {
    method: 'POST',
    body: { recipient: 'fake@example.invalid', subject: 'Fake-only subject', body: 'Fake-only body.' }
  });
  assert.equal(response.status, 201);
  const { draft } = await response.json();
  assert.equal(draft.sent, false);
  assert.equal(draft.storage, 'local-only');
  const mailStatus = await (await request('/api/connections')).json();
  assert.equal(mailStatus.email.status, 'disconnected');
  assert.equal(mailStatus.email.sendEnabled, false);
  const send = await request('/api/drafts/send', { method: 'POST', body: { id: draft.id } });
  assert.equal(send.status, 405);
  const invalidSend = await request('/api/send', { method: 'POST', body: { recipient: 'fake@example.invalid' } });
  assert.equal(invalidSend.status, 405);
  const sendFlag = await request('/api/drafts', {
    method: 'POST',
    body: { subject: 'Fake unsafe action', body: 'No external action.', sendImmediately: true }
  });
  assert.equal(sendFlag.status, 400);
});

test('Teams and reporting are disconnected read-only surfaces', async t => {
  const { request } = await workspace(t);
  const teams = await (await request('/api/teams')).json();
  const reports = await (await request('/api/reports')).json();
  assert.equal(teams.available, false);
  assert.equal(teams.access, 'read-only');
  assert.deepEqual(teams.items, []);
  assert.equal(reports.available, false);
  assert.equal(reports.access, 'read-only');
  assert.deepEqual(reports.reports, []);
  const teamsWrite = await request('/api/teams', { method: 'POST', body: {} });
  const reportingWrite = await request('/api/reports', { method: 'POST', body: {} });
  assert.equal(teamsWrite.status, 405);
  assert.equal(reportingWrite.status, 405);
});

test('assistant requests fail closed without storing or submitting their content', async t => {
  const { request } = await workspace(t);
  const response = await request('/api/assistant', { method: 'POST', body: { prompt: 'Fake test request' } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    available: false,
    submitted: false,
    code: 'authorization-required',
    error: 'Assistant is disconnected or its runtime is unverified. Your message was not submitted or stored.'
  });
  const state = await (await request('/api/state')).json();
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.drafts, []);
  assert.deepEqual(state.activity, []);
});

test('Outlook reply-draft endpoint requires CSRF and a verified connection', async t => {
  const { request } = await workspace(t);
  const body = { messageId: 'fake-source', text: 'Fake unsent reply only.', replyAll: false, requestId: randomUUID() };
  assert.equal((await request('/api/mail/reply-drafts', { method: 'POST', token: '', body })).status, 403);
  assert.equal((await request('/api/mail/reply-drafts', { method: 'POST', body })).status, 503);
  assert.equal((await request('/api/mail/reply-drafts', { method: 'POST', body: { ...body, sendImmediately: true } })).status, 400);
});

test('stale task and draft revisions cannot overwrite newer local edits', async t => {
  const { request } = await workspace(t);
  const { task } = await (await request('/api/tasks', { method: 'POST', body: { title: 'Fake revision task' } })).json();
  assert.equal((await request(`/api/tasks/${task.id}`, { method: 'PATCH', body: { title: 'New title', revision: task.revision } })).status, 200);
  assert.equal((await request(`/api/tasks/${task.id}`, { method: 'PATCH', body: { title: 'Stale title', revision: task.revision } })).status, 409);
  const { draft } = await (await request('/api/drafts', { method: 'POST', body: { subject: 'Fake draft', body: 'Fake text' } })).json();
  assert.equal((await request(`/api/drafts/${draft.id}`, { method: 'PATCH', body: { body: 'New fake text', revision: draft.revision } })).status, 200);
  assert.equal((await request(`/api/drafts/${draft.id}`, { method: 'PATCH', body: { body: 'Stale fake text', revision: draft.revision } })).status, 409);
  const state = await (await request('/api/state')).json();
  assert.equal(state.tasks[0].title, 'New title');
  assert.equal(state.drafts[0].body, 'New fake text');
});

test('rejects cloud-synced or repository-contained state paths', async () => {
  const repositoryPath = join(process.cwd(), 'local-test-state', randomUUID());
  const syncedPath = join(tmpdir(), 'OneDrive', `Esquie-${randomUUID()}`);
  await assert.rejects(startServer({ dataDir: repositoryPath, port: 0 }), /outside the application repository and cloud-synced folders/);
  await assert.rejects(startServer({ dataDir: syncedPath, port: 0 }), /outside the application repository and cloud-synced folders/);
});

test('validates manually saved links and owner-entered profile values', async t => {
  const { request } = await workspace(t);
  const badScheme = await request('/api/links', {
    method: 'POST',
    body: { title: 'Fake link', url: 'javascript:alert(1)' }
  });
  assert.equal(badScheme.status, 400);
  const credentials = await request('/api/links', {
    method: 'POST',
    body: { title: 'Fake link', url: 'https://user:pass@example.invalid/' }
  });
  assert.equal(credentials.status, 400);
  const invalidTimezone = await request('/api/profile', {
    method: 'PATCH',
    body: { timezone: 'Not/A_Timezone' }
  });
  assert.equal(invalidTimezone.status, 400);
});

test('does not expose Planner, To Do, demo creation, or source discovery routes', async t => {
  const { request } = await workspace(t);
  const connections = await (await request('/api/connections')).json();
  assert.equal(connections.planner.status, 'retired');
  assert.equal(connections.planner.available, false);
  assert.equal('todo' in connections, false);
  for (const path of ['/api/todo', '/api/demos', '/api/tasks/discovery', '/api/schedules']) {
    assert.equal((await request(path)).status, 404, `${path} should remain unavailable`);
  }
  assert.equal((await request('/api/demos', { method: 'POST', body: { name: 'Fake-only test' } })).status, 404);
});

test('preserves invalid workspace data instead of resetting it', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-invalid-state-'));
  const path = join(dataDir, 'workspace.json');
  const content = '{"schemaVersion":99,"privateMarker":"keep-me"}\n';
  await writeFile(path, content, 'utf8');
  await assert.rejects(startServer({ dataDir, port: 0 }), /ownership is not established/);
  assert.equal(await readFile(path, 'utf8'), content);
  await rm(dataDir, { recursive: true, force: true });
});

test('malformed saved workspace and lock errors never expose their private content', async () => {
  for (const filename of ['workspace.json', 'workspace.lock']) {
    const dataDir = await mkdtemp(join(tmpdir(), 'esquie-private-parse-'));
    const path = join(dataDir, filename);
    const content = 'synthetic-private-content-not-for-logs{';
    try {
      await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
      await assert.rejects(startServer({ dataDir, port: 0 }), error => {
        assert.match(error.message, /ownership is not established/);
        assert.equal(error.message.includes(content), false);
        return true;
      });
      assert.equal(await readFile(path, 'utf8'), content);
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  }
});
