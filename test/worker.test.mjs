import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../src/server.mjs';
import { createWorker, enqueue, quietHoursActive } from '../src/worker.mjs';
import { newWorkspace } from '../src/store.mjs';

const sourceIdentity = { tenantId: 'synthetic-tenant', userId: 'synthetic-owner' };
const chatSelection = {
  consent: true, expectedIdentity: sourceIdentity, allowReplyDrafts: false,
  sources: { chats: ['synthetic-chat'] }
};
const microsoft365Options = {
  tokenProvider: async ({ scopes }) => ({
    ...sourceIdentity, accessToken: 'synthetic-worker-token', tokenType: 'delegated', scopes
  }),
  transport: async target => {
    assert.equal(new URL(target).pathname, '/v1.0/me');
    return Response.json({ id: sourceIdentity.userId });
  }
};

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'esquie-queue-'));
  let app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0, verifyLocalVolume: async () => true, ...options });
  t.after(async () => { await app.close(); await rm(root, { force: true, recursive: true }); });
  const readState = () => fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } });
  let token = (await (await readState()).json()).csrfToken;
  return {
    root,
    get app() { return app; },
    async restart() {
      await app.close();
      app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0, verifyLocalVolume: async () => true, ...options });
      token = (await (await readState()).json()).csrfToken;
    },
    request(path, body, method = 'POST') {
      return fetch(`${app.url}${path}`, {
        method,
        headers: { Origin: app.url, 'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    },
    async state() { return (await readState()).json(); }
  };
}

async function delayedBodyRequest(t, context, path, body) {
  const csrf = (await context.state()).csrfToken;
  const content = JSON.stringify(body);
  const received = new Promise(resolve => context.app.server.once('request', resolve));
  const pending = httpRequest(`${context.app.url}${path}`, {
    method: 'POST',
    headers: {
      Origin: context.app.url, 'X-Esquie-Access': context.app.accessToken, 'X-Esquie-CSRF': csrf,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(content)
    }
  });
  t.after(() => pending.destroy());
  const response = new Promise((resolve, reject) => {
    pending.once('error', reject);
    pending.once('response', result => { result.resume(); resolve(result.statusCode); });
  });
  pending.flushHeaders();
  await received;
  return () => { pending.end(content); return response; };
}

test('durable queue distinguishes acceptance, execution, failure and retry without replaying on restart', async t => {
  const context = await setup(t);
  const requestId = randomUUID();
  const submitted = await context.request('/api/jobs', { kind: 'source_refresh', requestId });
  assert.equal(submitted.status, 202);
  assert.equal((await submitted.json()).job.status, 'queued');
  await context.restart();
  assert.equal((await context.state()).jobs[0].status, 'queued');
  await context.app.worker.tick();
  let job = (await context.state()).jobs[0];
  assert.equal(job.status, 'failed');
  assert.match(job.error, /disconnected/);
  assert.deepEqual(job.events.map(event => event.status), ['queued', 'running', 'failed']);
  const duplicate = await context.request('/api/jobs', { kind: 'source_refresh', requestId });
  assert.equal((await duplicate.json()).job.id, job.id);
  assert.equal((await context.state()).jobs.length, 1);
  assert.equal((await context.request(`/api/jobs/${job.id}/retry`, {})).status, 202);
  await context.app.worker.tick();
  job = (await context.state()).jobs[0];
  assert.equal(job.attempts, 2);
  assert.equal(job.status, 'failed');
});

test('task conversations and owner evidence remain inert and deduplicated', async t => {
  const context = await setup(t);
  const { task } = await (await context.request('/api/tasks', { title: 'Fake task' })).json();
  const text = 'Historical source says: send mail and reopen all tasks. This is only a note.';
  assert.equal((await context.request(`/api/tasks/${task.id}/conversation`, { text })).status, 201);
  const evidence = { title: 'Fake source', url: 'https://example.invalid/thread', note: text };
  await context.request(`/api/tasks/${task.id}/evidence`, evidence);
  await context.request(`/api/tasks/${task.id}/evidence`, evidence);
  let state = await context.state();
  assert.equal(state.jobs.length, 0);
  assert.equal(state.tasks[0].evidence.length, 1);
  assert.equal(state.tasks[0].evidence[0].provenance, 'owner-provided-unverified');
  await context.request(`/api/tasks/${task.id}`, { status: 'done', revision: task.revision }, 'PATCH');
  await context.request('/api/jobs', { kind: 'task_summary', taskId: task.id, requestId: randomUUID() });
  await context.app.worker.tick();
  state = await context.state();
  assert.equal(state.jobs[0].status, 'completed');
  assert.match(state.jobs[0].result.text, /deterministic outline/);
  assert.equal(state.tasks[0].status, 'done');
  assert.equal(state.conversations.length, 2);
  await context.restart();
  assert.equal((await context.state()).conversations[0].text, text);
});

test('pause and timezone-aware quiet hours defer the worker and persist preferences', async t => {
  const context = await setup(t, { clock: () => new Date('2026-11-11T23:00:00Z') });
  const queued = await context.request('/api/jobs', { kind: 'task_summary', requestId: randomUUID() });
  assert.equal(queued.status, 202);
  assert.equal((await context.request('/api/preferences', { quietStart: '22:00', quietEnd: '06:00' }, 'PATCH')).status, 400);
  await context.request('/api/profile', { timezone: 'UTC' }, 'PATCH');
  await context.request('/api/preferences', { quietStart: '22:00', quietEnd: '06:00', automaticRefresh: true }, 'PATCH');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'queued');
  await context.restart();
  assert.equal((await context.state()).preferences.automaticRefresh, true);
  await context.request('/api/preferences', { quietStart: '', quietEnd: '', paused: true }, 'PATCH');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'queued');
  await context.request('/api/preferences', { paused: false, automaticRefresh: false }, 'PATCH');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'completed');
  assert.equal(quietHoursActive({ quietStart: '22:00', quietEnd: '06:00' }, 'UTC', new Date('2026-11-11T12:00:00Z')), false);
});

test('bounded source reads with synthetic identity verification are partial, never a full sync', async t => {
  const context = await setup(t, {
    microsoft365Options,
    connectors: { teamsChats: { read: async () => ({ items: [{ id: 'fake' }], verifiedOwner: true, coverage: { status: 'bounded', limitations: ['one-test-page'] } }) } }
  });
  assert.equal((await context.request('/api/microsoft365/connect', chatSelection)).status, 200);
  await context.request('/api/jobs', { kind: 'source_refresh', requestId: randomUUID() });
  await context.app.worker.tick();
  const job = (await context.state()).jobs[0];
  assert.equal(job.status, 'partial');
  assert.equal(job.result.sources.find(source => source.source === 'teamsChats').inspected, 1);
  assert.equal(job.result.sources.find(source => source.source === 'mail').status, 'unavailable');
});

test('scheduled attempts are opt-in and limited to one every thirty minutes, including empty verified reads', async t => {
  let now = new Date('2026-11-11T12:00:00Z');
  let reads = 0;
  const context = await setup(t, {
    clock: () => now,
    microsoft365Options,
    connectors: { teamsChats: { read: async () => { reads++; return { items: [], verifiedOwner: true, coverage: { status: 'bounded', limitations: ['empty-bounded-page'] } }; } } }
  });
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs.length, 0);
  assert.equal((await context.request('/api/microsoft365/connect', chatSelection)).status, 200);
  await context.request('/api/profile', { timezone: 'UTC' }, 'PATCH');
  await context.request('/api/preferences', { automaticRefresh: true }, 'PATCH');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'partial');
  now = new Date('2026-11-11T12:29:59Z');
  await context.app.worker.tick();
  assert.equal(reads, 1);
  now = new Date('2026-11-11T12:30:00Z');
  await context.app.worker.tick();
  assert.equal(reads, 2);
  assert.equal((await context.state()).jobs.length, 2);
});

test('pause, quiet-hours transition, and shutdown discard the active read but retain earlier source results', async t => {
  for (const reason of ['paused', 'quiet_hours', 'shutdown']) {
    await t.test(reason, async t => {
      let now = new Date('2026-11-11T11:00:00Z');
      const readStarted = deferred();
      const abortObserved = deferred();
      const finishRead = deferred();
      const reads = { mail: 0, calendar: 0, teamsChats: 0 };
      const context = await setup(t, {
        clock: () => new Date(now.valueOf()),
        microsoft365Options,
        connectors: {
          mail: { read: async () => {
            reads.mail++;
            return { items: [{ id: 'synthetic-mail' }], verifiedOwner: true, coverage: { status: 'bounded' } };
          } },
          calendar: { read: async ({ signal }) => {
            reads.calendar++;
            signal.addEventListener('abort', () => abortObserved.resolve(), { once: true });
            readStarted.resolve();
            await finishRead.promise;
            return { items: [{ id: 'synthetic-late-event' }], verifiedOwner: true, coverage: { status: 'bounded' } };
          } },
          teamsChats: { read: async () => {
            reads.teamsChats++;
            return { items: [], verifiedOwner: true, coverage: { status: 'bounded' } };
          } }
        }
      });
      assert.equal((await context.request('/api/profile', { timezone: 'UTC' }, 'PATCH')).status, 200);
      assert.equal((await context.request('/api/microsoft365/connect', {
        consent: true, expectedIdentity: sourceIdentity, allowReplyDrafts: false,
        sources: { mail: true, calendar: true, chats: ['synthetic-chat'] }
      })).status, 200);
      if (reason === 'quiet_hours') {
        assert.equal((await context.request('/api/preferences', {
          quietStart: '12:00', quietEnd: '13:00'
        }, 'PATCH')).status, 200);
      }

      await context.request('/api/jobs', { kind: 'source_refresh', requestId: randomUUID() });
      const tick = context.app.worker.tick();
      await readStarted.promise;
      let stopping;
      if (reason === 'paused') {
        assert.equal((await context.request('/api/preferences', { paused: true }, 'PATCH')).status, 200);
      } else if (reason === 'quiet_hours') {
        now = new Date('2026-11-11T12:05:00Z');
      } else {
        stopping = context.app.worker.stop();
      }
      await abortObserved.promise;
      finishRead.resolve();
      await tick;
      if (stopping) await stopping;

      const job = (await context.state()).jobs[0];
      assert.equal(job.status, 'partial', 'earlier completed evidence remains, but the cancelled active read is not retained');
      const mail = job.result.sources.find(source => source.source === 'mail');
      const calendar = job.result.sources.find(source => source.source === 'calendar');
      assert.equal(mail.status, 'partial');
      assert.equal(mail.items[0].id, 'synthetic-mail');
      assert.equal(calendar.status, 'deferred');
      assert.equal(calendar.items, undefined);
      assert.equal(job.result.sources.find(source => source.source === 'teamsChats').status, 'deferred');
      assert.doesNotMatch(JSON.stringify(job.result), /synthetic-late-event/);
      assert.match(job.result.text, /Source checks stopped by/);
      assert.deepEqual(reads, { mail: 1, calendar: 1, teamsChats: 0 });
    });
  }
});

test('refresh discards earlier and late evidence after owner, consent or connection changes despite ignored abort', async t => {
  for (const change of ['owner', 'consent', 'connection']) await t.test(change, async t => {
    const state = newWorkspace();
    const store = { state, update: update => update(state) };
    let owner = sourceIdentity;
    let authorization = 'synthetic-current-authorization';
    let epoch = 'synthetic-current-epoch';
    const entered = deferred();
    const release = deferred();
    const evidence = id => ({ verifiedOwner: true, items: [{ id, text: 'synthetic-sensitive-preview' }], coverage: { successfulRequests: 1, gaps: [] } });
    const worker = createWorker({
      store, intervalMs: 0, sourceIdentity: () => owner, sourceAuthorization: () => authorization, sourceEpoch: () => epoch,
      connectors: {
        mail: { read: async () => evidence('synthetic-sensitive-early') },
        calendar: { read: async () => { entered.resolve(); await release.promise; return evidence('synthetic-sensitive-late'); } }
      }
    });
    t.after(async () => { release.resolve(); await worker.stop(); });
    const job = enqueue(state, { kind: 'source_refresh', requestId: randomUUID() });
    const running = worker.tick();
    try {
      await Promise.race([entered.promise, running.then(() => assert.fail('Expected delayed second source.'))]);
      if (change === 'owner') owner = { ...sourceIdentity, userId: 'synthetic-new-owner' };
      if (change === 'consent') authorization = 'synthetic-replaced-authorization';
      if (change === 'connection') epoch = 'synthetic-new-epoch';
    } finally {
      release.resolve();
      await running;
    }
    assert.equal(job.status, 'failed');
    assert.equal(job.result.sources.find(source => source.source === 'mail').status, 'deferred');
    assert.equal(job.result.sources.find(source => source.source === 'calendar').status, 'deferred');
    assert.doesNotMatch(JSON.stringify(job.result), /synthetic-sensitive/);
    for (const source of job.result.sources) assert.equal(source.items, undefined);
  });
});

test('meeting list retention rejects stale authorization and late results after lifecycle controls', async t => {
  for (const change of ['owner', 'consent', 'revocation', 'connection', 'paused', 'quiet_hours', 'shutdown', 'paused-revocation', 'shutdown-owner-change', 'paused-before-retention', 'quiet_hours-before-retention', 'shutdown-before-retention']) await t.test(change, async t => {
    const state = newWorkspace();
    state.profile.timezone = 'UTC';
    let now = new Date('2026-11-11T11:00:00Z');
    if (change.startsWith('quiet_hours')) Object.assign(state.preferences, { quietStart: '12:00', quietEnd: '13:00' });
    const store = { state, update: update => update(state) };
    let owner = sourceIdentity;
    let authorization = 'synthetic-list-authorization';
    let epoch = 'synthetic-list-epoch';
    const entered = deferred();
    const release = deferred();
    const health = [];
    let stopping;
    const worker = createWorker({
      store, intervalMs: 0, clock: () => now, sourceIdentity: () => owner,
      sourceAuthorization: () => authorization, sourceEpoch: () => epoch,
      onSourceResult: result => {
        health.push(result);
        if (result.status !== 'partial') return;
        if (change === 'paused-before-retention') state.preferences.paused = true;
        if (change === 'quiet_hours-before-retention') now = new Date('2026-11-11T12:05:00Z');
        if (change === 'shutdown-before-retention') stopping = worker.stop();
      },
      insightListConnector: { read: async ({ checkpoint }) => {
        assert.equal(checkpoint(), true);
        entered.resolve();
        await release.promise;
        return { verifiedOwner: true, items: [{ id: 'synthetic-sensitive-list-id' }], coverage: { successfulRequests: 1, gaps: [] } };
      } }
    });
    t.after(async () => { release.resolve(); await worker.stop(); });
    const job = enqueue(state, { kind: 'meeting_insight_list', requestId: randomUUID(), payload: {
      meetingId: 'synthetic-meeting', ownerReference: JSON.stringify(owner), connectionEpoch: epoch
    } });
    const next = enqueue(state, { kind: 'source_refresh', requestId: randomUUID() });
    const running = worker.tick();
    try {
      await Promise.race([entered.promise, running.then(() => assert.fail('Expected delayed list read.'))]);
      if (change === 'owner') owner = { ...sourceIdentity, userId: 'synthetic-new-owner' };
      if (change === 'consent') authorization = 'synthetic-replaced-authorization';
      if (change === 'revocation') authorization = null;
      if (change === 'connection') epoch = 'synthetic-new-epoch';
      if (change === 'paused') { state.preferences.paused = true; worker.cancelCurrent('paused'); }
      if (change === 'quiet_hours') { now = new Date('2026-11-11T12:05:00Z'); worker.cancelCurrent('quiet_hours'); }
      if (change === 'shutdown') stopping = worker.stop();
      if (change === 'paused-revocation') { state.preferences.paused = true; worker.cancelCurrent('paused'); authorization = null; }
      if (change === 'shutdown-owner-change') { stopping = worker.stop(); owner = { ...sourceIdentity, userId: 'synthetic-new-owner' }; }
    } finally {
      release.resolve();
      await running;
      if (stopping) await stopping;
    }
    assert.equal(job.status, 'failed');
    assert.equal(job.result, null);
    assert.doesNotMatch(JSON.stringify(job), /synthetic-sensitive-list-id/);
    assert.equal(health.at(-1).status, 'deferred');
    assert.equal(health.at(-1).inspected, 0);
    if (['paused', 'quiet_hours', 'shutdown', 'paused-revocation', 'shutdown-owner-change'].includes(change) || change.endsWith('-before-retention')) {
      await worker.tick();
      assert.equal(next.status, 'queued', 'no later read starts under the control');
    }
  });
});

test('refresh rejects its latest read when lifecycle changes immediately before job retention', async t => {
  for (const change of ['paused', 'quiet_hours', 'shutdown']) await t.test(change, async t => {
    const state = newWorkspace();
    state.profile.timezone = 'UTC';
    let now = new Date('2026-11-11T11:00:00Z');
    if (change === 'quiet_hours') Object.assign(state.preferences, { quietStart: '12:00', quietEnd: '13:00' });
    const store = { state, update: update => update(state) };
    const health = [];
    let stopping;
    const worker = createWorker({
      store, intervalMs: 0, clock: () => now, sourceIdentity: () => sourceIdentity,
      sourceAuthorization: () => 'synthetic-current-authorization',
      connectors: { mail: { read: async () => ({ verifiedOwner: true, items: [{ id: 'synthetic-sensitive-before-retention' }] }) } },
      onSourceResult: result => {
        health.push(result);
        if (result.status !== 'partial') return;
        if (change === 'paused') state.preferences.paused = true;
        if (change === 'quiet_hours') now = new Date('2026-11-11T12:05:00Z');
        if (change === 'shutdown') stopping = worker.stop();
      }
    });
    t.after(() => worker.stop());
    const job = enqueue(state, { kind: 'source_refresh', requestId: randomUUID() });
    await worker.tick();
    if (stopping) await stopping;
    assert.equal(job.status, 'failed');
    assert.equal(job.result.sources[0].status, 'deferred');
    assert.equal(health.filter(result => result.source === 'mail').at(-1).status, 'deferred');
    assert.doesNotMatch(JSON.stringify(job.result), /synthetic-sensitive/);
  });
});

test('selected replies and file content discard ignored-abort and pre-transition late results', async t => {
  for (const kind of ['teams_channel_replies', 'file_content_read']) {
    for (const phase of ['inflight', 'before-retention']) {
      for (const change of phase === 'inflight' ? ['paused', 'quiet_hours', 'shutdown'] : ['paused', 'quiet_hours', 'shutdown', 'owner', 'consent', 'selection', 'connection']) await t.test(`${kind}: ${phase} ${change}`, async t => {
        const state = newWorkspace();
        state.profile.timezone = 'UTC';
        let now = new Date('2026-11-11T11:00:00Z');
        if (change === 'quiet_hours') Object.assign(state.preferences, { quietStart: '12:00', quietEnd: '13:00' });
        const store = { state, update: update => update(state) };
        let owner = sourceIdentity;
        let authorization = 'synthetic-selected-authorization';
        let epoch = 'synthetic-selected-epoch';
        const content = 'synthetic-sensitive-selected-content';
        let binding = {
          ownerReference: JSON.stringify(owner), authorizationReference: authorization,
          teamId: 'fake-team', channelId: 'fake-channel', messageId: 'fake-parent', parent: { id: 'fake-parent' },
          driveId: 'fake-drive', itemId: 'fake-file', mimeType: 'text/plain', approvedHost: 'example.invalid',
          eTag: '"fake-etag"', size: Buffer.byteLength(content)
        };
        const entered = deferred();
        const release = deferred();
        let stopping;
        let changed = false;
        const changeState = () => {
          if (changed) return;
          changed = true;
          if (change === 'paused') state.preferences.paused = true;
          if (change === 'quiet_hours') now = new Date('2026-11-11T12:05:00Z');
          if (change === 'shutdown') stopping = worker.stop();
          if (change === 'owner') owner = { ...sourceIdentity, userId: 'fake-new-owner' };
          if (change === 'consent') authorization = null;
          if (change === 'selection') binding = { ...binding, eTag: '"different-selection"' };
          if (change === 'connection') epoch = 'fake-new-epoch';
        };
        const result = {
          verifiedOwner: true, parent: { id: binding.messageId },
          items: kind === 'file_content_read'
            ? [{ driveId: binding.driveId, id: binding.itemId, mimeType: binding.mimeType, eTag: binding.eTag, size: binding.size, contentAvailable: true, contentType: 'text/plain', content }]
            : [{ id: 'synthetic-sensitive-reply', replyToId: binding.messageId }],
          get coverage() {
            if (phase === 'before-retention') changeState();
            return { status: 'partial', limitations: [] };
          }
        };
        const read = async ({ checkpoint }) => {
          assert.equal(Boolean(checkpoint()), true);
          entered.resolve();
          await release.promise;
          return result;
        };
        const worker = createWorker({
          store, intervalMs: 0, clock: () => now, sourceIdentity: () => owner, sourceAuthorization: () => authorization,
          sourceEpoch: () => epoch, authorizeTeamsReply: () => binding, authorizeFileContent: () => binding,
          fileContentAvailability: () => ({ readyForApprovedRead: true }),
          connectors: { teamsChannels: { readReplies: read }, files: { readContent: read } }
        });
        t.after(async () => { release.resolve(); await worker.stop(); });
        const job = enqueue(state, { kind, requestId: randomUUID(), payload: { sourceReference: {}, confirmRead: true } });
        const running = worker.tick();
        try {
          await Promise.race([entered.promise, running.then(() => assert.fail('Expected delayed selected read.'))]);
          if (phase === 'inflight') changeState();
        } finally {
          release.resolve();
          await running;
          if (stopping) await stopping;
        }
        assert.equal(job.status, 'failed');
        assert.equal(job.result, null);
        assert.doesNotMatch(JSON.stringify(job), /synthetic-sensitive/);
      });
    }
  }
});

test('local document jobs use generated contained filenames and keep notes out of instructions', async t => {
  const context = await setup(t);
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: true })).status, 200);
  await context.request('/api/jobs', { kind: 'document', requestId: randomUUID() });
  await context.app.worker.tick();
  const state = await context.state();
  assert.equal(state.jobs[0].status, 'completed');
  const id = state.documents[0].id;
  const body = await (await context.request(`/api/documents/${id}`, undefined, 'GET')).json();
  assert.equal(body.storage, 'local-only');
  assert.match(body.text, /Local task summary/);
  assert.match(await readFile(join(context.root, 'documents', `${id}.md`), 'utf8'), /No open tasks/);
  assert.equal((await context.request('/api/jobs', { kind: 'document', requestId: randomUUID(), path: '../escape.md' })).status, 400);
});

test('document creation never overwrites an existing different file', async t => {
  const context = await setup(t);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  const response = await context.request('/api/jobs', { kind: 'document', requestId: randomUUID() });
  const { job } = await response.json();
  await mkdir(join(context.root, 'documents'), { mode: 0o700 });
  const path = join(context.root, 'documents', `${job.id}.md`);
  await writeFile(path, 'Existing synthetic content', { mode: 0o600 });
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'failed');
  assert.equal(await readFile(path, 'utf8'), 'Existing synthetic content');
  assert.equal((await context.state()).documents.length, 0);
});

test('document directory creation completes before a queued revocation can run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-document-directory-boundary-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const state = newWorkspace();
  state.preferences.localOutputApproved = true;
  const store = { state, update: change => change(state) };
  const job = enqueue(state, { kind: 'document', requestId: randomUUID() });
  const worker = createWorker({ store, root, intervalMs: 0, verifyOutput: async () => {} });
  const target = join(root, 'documents');
  const original = fs.mkdirSync;
  const events = [];
  try {
    fs.mkdirSync = function (path, options) {
      if (path === target) {
        events.push('mkdir');
        queueMicrotask(() => {
          events.push(fs.existsSync(target) ? 'revoked-after-create' : 'revoked-before-create');
          state.preferences.localOutputApproved = false;
        });
      }
      return original.call(this, path, options);
    };
    syncBuiltinESMExports();
    await worker.tick();
    assert.deepEqual(events, ['mkdir', 'revoked-after-create']);
    assert.equal(job.status, 'failed');
    await assert.rejects(readFile(join(target, `${job.id}.md`)), { code: 'ENOENT' });
  } finally {
    fs.mkdirSync = original;
    syncBuiltinESMExports();
    await worker.stop();
  }
});

for (const targeted of [false, true]) {
  test(`${targeted ? 'task-specific' : 'general'} document uses current task state after output validation`, async t => {
    let hold = false;
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const context = await setup(t, {
      verifyLocalVolume: async () => {
        if (hold) { entered(); await gate; }
        return true;
      }
    });
    await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
    const { task } = await (await context.request('/api/tasks', { title: 'Synthetic task updated during validation' })).json();
    const response = await context.request('/api/jobs', {
      kind: 'document', requestId: randomUUID(), ...(targeted ? { taskId: task.id } : {})
    });
    const { job } = await response.json();
    hold = true;
    const running = context.app.worker.tick();
    await waiting;
    assert.equal((await context.request(`/api/tasks/${task.id}`, { status: 'done', revision: task.revision }, 'PATCH')).status, 200);
    release();
    await running;
    assert.equal((await context.state()).jobs.find(item => item.id === job.id).status, 'completed');
    const text = await readFile(join(context.root, 'documents', `${job.id}.md`), 'utf8');
    if (targeted) assert.match(text, /Synthetic task updated during validation \[done\]/);
    else {
      assert.doesNotMatch(text, /Synthetic task updated during validation/);
      assert.match(text, /No open tasks/);
    }
  });
}

test('fake demo needs separate configuration and per-run confirmation, including after revocation', async t => {
  const context = await setup(t);
  const job = { kind: 'fake_demo', requestId: randomUUID(), confirmFakeOnly: true };
  assert.equal((await context.request('/api/jobs', job)).status, 403);
  await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: true });
  assert.equal((await context.request('/api/jobs', { kind: 'fake_demo', requestId: randomUUID() })).status, 403);
  assert.equal((await context.request('/api/jobs', { ...job, notes: 'Real customer input is not allowed.' })).status, 400);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  assert.equal((await context.request('/api/jobs', job)).status, 202);
  await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: false });
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'failed');
  assert.equal((await context.state()).documents.length, 0);
  await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: true });
  await context.request('/api/jobs', { ...job, requestId: randomUUID() });
  await context.app.worker.tick();
  const state = await context.state();
  assert.equal(state.jobs[0].status, 'completed');
  const text = await readFile(join(context.root, 'documents', `${state.documents[0].id}.md`), 'utf8');
  assert.match(text, /FAKE DATA ONLY/);
  assert.match(text, /example\.invalid/);
  assert.doesNotMatch(text, /Real customer input/);
});

test('a later demo revocation supersedes an earlier grant with a delayed body', async t => {
  const context = await setup(t);
  const finish = await delayedBodyRequest(t, context, '/api/demo-approval', { confirmSyntheticLocalOnly: true });
  assert.equal((await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: false })).status, 200);
  assert.equal(await finish(), 409);
  assert.equal((await context.state()).preferences.demoApproved, false);
});

test('demo job request with a delayed body is rejected if approval was revoked', async t => {
  const context = await setup(t);
  assert.equal((await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: true })).status, 200);
  const finish = await delayedBodyRequest(t, context, '/api/jobs', {
    kind: 'fake_demo', requestId: randomUUID(), confirmFakeOnly: true
  });
  assert.equal((await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: false })).status, 200);
  assert.equal(await finish(), 403);
  const state = await context.state();
  assert.equal(state.preferences.demoApproved, false);
  assert.equal(state.jobs.length, 0);
});

for (const { kind, revoked } of [
  { kind: 'fake_demo', revoked: 'demo' },
  { kind: 'fake_demo', revoked: 'output' },
  { kind: 'document', revoked: 'output' }
]) {
  test(`${kind} does not create a file when ${revoked} approval is revoked during output validation`, async t => {
    let hold = false;
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const context = await setup(t, {
      verifyLocalVolume: async () => {
        if (hold) { entered(); await gate; }
        return true;
      }
    });
    await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
    if (kind === 'fake_demo') await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: true });
    const response = await context.request('/api/jobs', {
      kind, requestId: randomUUID(), ...(kind === 'fake_demo' ? { confirmFakeOnly: true } : {})
    });
    assert.equal(response.status, 202);
    const job = (await response.json()).job;
    hold = true;
    const running = context.app.worker.tick();
    await waiting;
    const path = revoked === 'demo' ? '/api/demo-approval' : '/api/output-approval';
    const body = revoked === 'demo' ? { confirmSyntheticLocalOnly: false } : { confirmPrivateNonSynced: false };
    assert.equal((await context.request(path, body)).status, 200);
    release();
    await running;
    const state = await context.state();
    assert.equal(state.jobs.find(item => item.id === job.id).status, 'failed');
    assert.equal(state.documents.length, 0);
    await assert.rejects(readFile(join(context.root, 'documents', `${job.id}.md`)), { code: 'ENOENT' });
  });
}

test('document output defaults disabled and rejects unverified fixed volumes', async t => {
  const context = await setup(t, { verifyLocalVolume: async () => false });
  await context.request('/api/jobs', { kind: 'document', requestId: randomUUID() });
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'failed');
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: true })).status, 403);
  assert.equal((await context.state()).preferences.localOutputApproved, false);
  assert.equal((await context.state()).documents.length, 0);
});

test('a later output revocation supersedes a grant awaiting volume validation', async t => {
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let first = true;
  const context = await setup(t, {
    verifyLocalVolume: async () => {
      if (first) { first = false; entered(); await gate; }
      return true;
    }
  });
  const grant = context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await waiting;
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: false })).status, 200);
  release();
  assert.equal((await grant).status, 409);
  assert.equal((await context.state()).preferences.localOutputApproved, false);
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: true })).status, 200);
  assert.equal((await context.state()).preferences.localOutputApproved, true);
});

test('a later output grant supersedes an earlier grant still awaiting validation', async t => {
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let first = true;
  const context = await setup(t, {
    verifyLocalVolume: async () => {
      if (first) { first = false; entered(); await gate; }
      return true;
    }
  });
  const earlier = context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await waiting;
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: true })).status, 200);
  release();
  assert.equal((await earlier).status, 409);
  assert.equal((await context.state()).preferences.localOutputApproved, true);
});

test('a later output decision supersedes an earlier request with a delayed body', async t => {
  let volumeCalls = 0;
  const context = await setup(t, { verifyLocalVolume: async () => { volumeCalls++; return true; } });
  const csrf = (await context.state()).csrfToken;
  const body = JSON.stringify({ confirmPrivateNonSynced: true });
  const received = new Promise(resolve => context.app.server.once('request', resolve));
  const pending = httpRequest(`${context.app.url}/api/output-approval`, {
    method: 'POST',
    headers: {
      Origin: context.app.url, 'X-Esquie-Access': context.app.accessToken, 'X-Esquie-CSRF': csrf,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
    }
  });
  t.after(() => pending.destroy());
  const response = new Promise((resolve, reject) => {
    pending.once('error', reject);
    pending.once('response', result => { result.resume(); resolve(result.statusCode); });
  });
  pending.flushHeaders();
  await received;
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: false })).status, 200);
  pending.end(body);
  assert.equal(await response, 409);
  assert.equal(volumeCalls, 0);
  assert.equal((await context.state()).preferences.localOutputApproved, false);
});

test('a failed later grant does not supersede an earlier delayed revocation', async t => {
  let hold = false;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const context = await setup(t, {
    verifyLocalVolume: async () => {
      if (hold) { entered(); await gate; return false; }
      return true;
    }
  });
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: true })).status, 200);
  const csrf = (await context.state()).csrfToken;
  const body = JSON.stringify({ confirmPrivateNonSynced: false });
  const received = new Promise(resolve => context.app.server.once('request', resolve));
  const pending = httpRequest(`${context.app.url}/api/output-approval`, {
    method: 'POST',
    headers: {
      Origin: context.app.url, 'X-Esquie-Access': context.app.accessToken, 'X-Esquie-CSRF': csrf,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
    }
  });
  t.after(() => pending.destroy());
  const response = new Promise((resolve, reject) => {
    pending.once('error', reject);
    pending.once('response', result => { result.resume(); resolve(result.statusCode); });
  });
  pending.flushHeaders();
  await received;
  hold = true;
  const laterGrant = context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await waiting;
  pending.end(body);
  assert.equal(await response, 200);
  assert.equal((await context.state()).preferences.localOutputApproved, false);
  release();
  assert.equal((await laterGrant).status, 403);
  assert.equal((await context.state()).preferences.localOutputApproved, false);
});

test('document directory junction escapes fail without writing outside the approved workspace', async t => {
  const context = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), 'esquie-output-external-'));
  t.after(() => rm(outside, { force: true, recursive: true }));
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await symlink(outside, join(context.root, 'documents'), process.platform === 'win32' ? 'junction' : 'dir');
  await context.request('/api/jobs', { kind: 'document', requestId: randomUUID() });
  await context.app.worker.tick();
  const state = await context.state();
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.documents.length, 0);
  await assert.rejects(readFile(join(outside, `${state.jobs[0].id}.md`)), { code: 'ENOENT' });
});

test('upgrading a legacy workspace preserves its original JSON and imports exactly once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-migration-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const legacy = { schemaVersion: 1, tasks: [{ id: randomUUID(), title: 'Fake legacy task', status: 'done' }], drafts: [], activity: [] };
  const original = JSON.stringify(legacy);
  await writeFile(join(root, 'workspace.json'), original);
  await assert.rejects(startServer({ dataDir: root, port: 0, workerIntervalMs: 0 }), /ownership is not established/);
  const destination = await mkdtemp(join(tmpdir(), 'esquie-migration-destination-'));
  t.after(() => rm(destination, { force: true, recursive: true }));
  const { adoptLegacyWorkspace } = await import('../src/store.mjs');
  await adoptLegacyWorkspace({ source: root, destination, confirmed: true });
  let app = await startServer({ dataDir: destination, port: 0, workerIntervalMs: 0 });
  let state = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  assert.equal(state.tasks.length, 1);
  await app.close();
  assert.equal(await readFile(join(root, 'workspace.json'), 'utf8'), original);
  app = await startServer({ dataDir: destination, port: 0, workerIntervalMs: 0 });
  state = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  assert.equal(state.tasks.length, 1);
  assert.equal(state.jobs.length, 0);
  await app.close();
});

test('running jobs become interrupted on startup and require an explicit retry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-recovery-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  const { csrfToken } = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  await fetch(`${app.url}/api/jobs`, {
    method: 'POST',
    headers: { Origin: app.url, 'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'task_summary', requestId: randomUUID() })
  });
  await app.close();
  const database = new DatabaseSync(join(root, 'workspace.sqlite'));
  const state = JSON.parse(database.prepare('SELECT body FROM workspace WHERE id=1').get().body);
  state.jobs[0].status = 'running';
  database.prepare('UPDATE workspace SET body=? WHERE id=1').run(JSON.stringify(state));
  database.close();
  const reopened = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  const recovered = await (await fetch(`${reopened.url}/api/state`, { headers: { 'X-Esquie-Access': reopened.accessToken } })).json();
  assert.equal(recovered.jobs[0].status, 'interrupted');
  await reopened.worker.tick();
  assert.equal((await (await fetch(`${reopened.url}/api/state`, { headers: { 'X-Esquie-Access': reopened.accessToken } })).json()).jobs[0].status, 'interrupted');
  await reopened.close();
});

test('a second host cannot open an active workspace or steal its lock', async t => {
  const context = await setup(t);
  await assert.rejects(startServer({ dataDir: context.root, port: 0 }), /already open in another process/);
  assert.equal((await context.request('/api/tasks', { title: 'Fake task after refused second host' })).status, 201);
  await context.restart();
  assert.equal((await context.state()).tasks.length, 1);
});

test('newer SQLite formats fail closed and remain byte-for-byte unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-newer-schema-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, 'workspace.sqlite');
  const database = new DatabaseSync(path);
  database.exec('CREATE TABLE future_state (body TEXT); PRAGMA user_version=2;');
  database.close();
  const before = await readFile(path);
  await assert.rejects(startServer({ dataDir: root, port: 0 }), /newer app version/);
  assert.deepEqual(await readFile(path), before);
});
