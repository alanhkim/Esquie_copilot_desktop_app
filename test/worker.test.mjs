import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../src/server.mjs';
import { createWorker, enqueue, quietHoursActive } from '../src/worker.mjs';
import { newWorkspace, openStore } from '../src/store.mjs';
import { monthlyOutcomesSnapshotHash } from '../public/outcome-export-workflow.mjs';

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

test('insight results are discarded after cancellation at read completion or retention', async t => {
  for (const kind of ['meeting_insight_list', 'meeting_insight_detail']) {
    for (const boundary of ['read completion', 'retention']) {
      for (const action of ['paused', 'quiet_hours', 'shutdown']) {
        await t.test(`${kind}: ${boundary}: ${action}`, async () => {
          let now = new Date('2026-11-11T11:00:00Z');
          const state = {
            preferences: { paused: false, quietStart: '12:00', quietEnd: '13:00' },
            profile: { timezone: 'UTC' }, scheduler: {}, jobs: []
          };
          const store = { state, update: change => change(state) };
          enqueue(state, { kind, requestId: randomUUID(), payload: {
            meetingId: 'synthetic-meeting', insightId: 'synthetic-insight',
            connectionEpoch: 'synthetic-epoch', ownerReference: JSON.stringify(sourceIdentity),
            authorizationReference: 'synthetic-authorization'
          } }, now);
          const active = deferred();
          const finish = deferred();
          let signal;
          let stopping;
          const stop = () => {
            if (action === 'paused') state.preferences.paused = true;
            else if (action === 'quiet_hours') now = new Date('2026-11-11T12:05:00Z');
            else stopping = worker.stop();
          };
          const result = {
            verifiedOwner: true,
            items: [{ id: 'synthetic-insight', content: 'Must not be retained.' }],
            get coverage() {
              if (boundary === 'retention') stop();
              return { status: 'partial' };
            }
          };
          const connector = { read: async options => {
            signal = options.signal;
            active.resolve();
            await finish.promise;
            return result; // Intentionally ignores cancellation.
          } };
          const health = [];
          const worker = createWorker({
            store, intervalMs: 0, clock: () => now,
            sourceIdentity: () => sourceIdentity, sourceEpoch: () => 'synthetic-epoch',
            sourceAuthorization: () => 'synthetic-authorization',
            insightSelectionCurrent: () => true,
            insightListConnector: connector, insightSelectionConnector: connector,
            onSourceResult: result => health.push(result)
          });
          try {
            const tick = worker.tick();
            await active.promise;
            if (boundary === 'read completion') stop();
            finish.resolve();
            await tick;
            if (stopping) await stopping;
            assert.equal(signal.aborted, true);
            assert.equal(state.jobs[0].status, 'failed');
            assert.equal(state.jobs[0].result, null);
            assert.match(state.jobs[0].error, new RegExp(action));
            if (kind === 'meeting_insight_list') assert.equal(health.at(-1).status, 'deferred');
          } finally {
            finish.resolve();
            await worker.stop();
          }
        });
      }
    }
  }
});

test('meeting list authorization changes reject queued, in-flight and late results', async t => {
  for (const boundary of ['queued', 'read completion', 'retention']) {
    await t.test(boundary, async () => {
      let authorization = 'original-authorization';
      const state = {
        preferences: { paused: false, quietStart: '', quietEnd: '' },
        profile: { timezone: 'UTC' }, scheduler: {}, jobs: []
      };
      enqueue(state, { kind: 'meeting_insight_list', requestId: randomUUID(), payload: {
        meetingId: 'synthetic-meeting', connectionEpoch: 'synthetic-epoch',
        ownerReference: JSON.stringify(sourceIdentity), authorizationReference: authorization
      } });
      let reads = 0;
      const health = [];
      const worker = createWorker({
        store: { state, update: change => change(state) }, intervalMs: 0,
        sourceIdentity: () => sourceIdentity, sourceEpoch: () => 'synthetic-epoch',
        sourceAuthorization: () => authorization,
        insightListConnector: { read: async () => {
          reads++;
          if (boundary === 'read completion') authorization = 'changed-authorization';
          return {
            verifiedOwner: true, items: [{ id: 'synthetic-insight' }],
            get coverage() {
              if (boundary === 'retention') authorization = 'changed-authorization';
              return { status: 'partial' };
            }
          };
        } },
        onSourceResult: result => health.push(result)
      });
      try {
        if (boundary === 'queued') authorization = 'changed-authorization';
        await worker.tick();
        assert.equal(reads, boundary === 'queued' ? 0 : 1);
        assert.equal(state.jobs[0].status, 'failed');
        assert.equal(state.jobs[0].result, null);
        assert.equal(health.at(-1).status, 'deferred');
      } finally { await worker.stop(); }
    });
  }
});

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
    async updateSavedState(change) {
      await app.close();
      const store = await openStore(root);
      try { store.update(change); }
      finally { await store.close(); }
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
      meetingId: 'synthetic-meeting', ownerReference: JSON.stringify(owner), connectionEpoch: epoch,
      authorizationReference: authorization
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

test('approved Word summaries preserve local task text and expose only a verified local-file reference', async t => {
  const context = await setup(t);
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: true })).status, 200);
  const task = (await (await context.request('/api/tasks', {
    title: 'Synthetic <task> with line break\nSecond line',
    details: 'Owner-provided detail & untrusted text',
    dueDate: '2026-11-12'
  })).json()).task;
  const queued = await context.request('/api/jobs', { kind: 'word_document', taskId: task.id, requestId: randomUUID() });
  assert.equal(queued.status, 202);
  const { job } = await queued.json();
  await context.app.worker.tick();
  const state = await context.state();
  assert.equal(state.jobs.find(item => item.id === job.id).status, 'completed');
  const document = state.documents.find(item => item.id === job.id);
  assert.equal(document.format, 'docx');
  const path = join(context.root, 'documents', `${job.id}.docx`);
  const bytes = await readFile(path);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(document.contentBytes, bytes.length);
  assert.equal(document.contentSha256, createHash('sha256').update(bytes).digest('hex'));
  const detail = await context.request(`/api/documents/${job.id}`, undefined, 'GET');
  assert.equal(detail.status, 200, await detail.clone().text());
  const body = await detail.json();
  assert.equal(body.format, 'docx');
  assert.equal(body.contentBytes, bytes.length);
  assert.match(body.text, /Verified local Word file/);
  assert.doesNotMatch(JSON.stringify(body), /Owner-provided detail/);
  await context.restart();
  const afterRestart = await context.request(`/api/documents/${job.id}`, undefined, 'GET');
  assert.equal(afterRestart.status, 200, await afterRestart.clone().text());
  assert.equal((await afterRestart.json()).contentSha256, document.contentSha256);
});

test('Word and PowerPoint details distinguish root inspection from bounded file failures', async t => {
  for (const format of ['docx', 'pptx']) {
    await t.test(format, async t => {
      let volumeMode = 'available';
      const context = await setup(t, {
        verifyLocalVolume: async () => {
          if (volumeMode === 'throw') throw new Error(`synthetic-secret ${context.root}`);
          return volumeMode === 'available';
        }
      });
      assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: true })).status, 200);
      if (format === 'pptx') {
        assert.equal((await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: true })).status, 200);
      }
      const request = format === 'docx'
        ? { kind: 'word_document', requestId: randomUUID() }
        : { kind: 'fake_demo', requestId: randomUUID(), confirmFakeOnly: true, format: 'pptx' };
      const queued = await context.request('/api/jobs', request);
      assert.equal(queued.status, 202);
      const { job } = await queued.json();
      await context.app.worker.tick();
      const document = (await context.state()).documents.find(item => item.id === job.id);
      assert.ok(document);
      const file = join(context.root, 'documents', `${job.id}.${format}`);
      const original = await readFile(file);
      const endpoint = `/api/documents/${job.id}`;
      const rootError = 'The local workspace root or volume could not be verified; document reading was blocked.';
      const fileError = `The ${format === 'docx' ? 'Word' : 'PowerPoint'} file could not be verified as a bounded, single-link file on the workspace volume.`;
      async function expectError(expected) {
        const response = await context.request(endpoint, undefined, 'GET');
        assert.equal(response.status, 409);
        const body = await response.json();
        assert.deepEqual(body, { error: expected });
        assert.doesNotMatch(JSON.stringify(body), /synthetic-secret/);
        assert.equal(JSON.stringify(body).includes(context.root), false);
      }
      async function expectSuccess() {
        const response = await context.request(endpoint, undefined, 'GET');
        assert.equal(response.status, 200, await response.clone().text());
        const body = await response.json();
        assert.equal(body.format, format);
        assert.equal(body.contentSha256, document.contentSha256);
        assert.equal(body.contentBytes, original.length);
      }

      await expectSuccess();
      let fileOpenCalls = 0;
      const originalOpen = fs.promises.open;
      const openHook = t.mock.method(fs.promises, 'open', async (...args) => {
        if (args[0] === file) fileOpenCalls++;
        return originalOpen(...args);
      });
      syncBuiltinESMExports();
      try {
        for (volumeMode of ['unavailable', 'throw']) await expectError(rootError);
        assert.equal(fileOpenCalls, 0);
      } finally {
        volumeMode = 'available';
        openHook.mock.restore();
        syncBuiltinESMExports();
      }

      const originalLstat = fs.promises.lstat;
      let failingPath = context.root;
      const hook = t.mock.method(fs.promises, 'lstat', async (...args) => {
        if (args[0] === failingPath) throw new Error(`synthetic-secret ${context.root}`);
        return originalLstat(...args);
      });
      syncBuiltinESMExports();
      try {
        await expectError(rootError);
        failingPath = file;
        await expectError(fileError);
      } finally {
        hook.mock.restore();
        syncBuiltinESMExports();
      }

      const hardlink = join(context.root, `linked-synthetic.${format}`);
      await link(file, hardlink);
      try { await expectError(fileError); }
      finally { await unlink(hardlink); }

      const changed = Buffer.from(original);
      changed[0] ^= 0xff;
      await writeFile(file, changed);
      try {
        await expectError('The local document no longer matches its generation record; reading was blocked.');
      } finally { await writeFile(file, original); }
      assert.deepEqual((await context.state()).documents.find(item => item.id === job.id), document);
      await context.restart();
      await expectSuccess();
    });
  }
});

test('real Word worker preserves supplementary Unicode and visible line breaks before and after restart', async t => {
  const context = await setup(t);
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: true })).status, 200);
  const title = 'Synthetic multilingual title \u{1F9ED}\r\nSecond line\rThird line\nFourth\tline';
  const details = 'Synthetic detail \u{1F30D}\r\nSecond detail\rThird detail\nFourth\tdetail';
  const response = await context.request('/api/tasks', { title, details });
  assert.equal(response.status, 201);
  const { task } = await response.json();

  for (const persisted of [false, true]) {
    if (persisted) await context.restart();
    const queued = await context.request('/api/jobs', {
      kind: 'word_document', taskId: task.id, requestId: randomUUID()
    });
    assert.equal(queued.status, 202);
    const { job } = await queued.json();
    await context.app.worker.tick();
    const state = await context.state();
    assert.equal(state.jobs.find(item => item.id === job.id).status, 'completed');
    const document = state.documents.find(item => item.id === job.id);
    const bytes = await readFile(join(context.root, 'documents', `${job.id}.docx`));
    const xml = bytes.toString('utf8');
    assert.ok(bytes.includes(Buffer.from('\u{1F9ED}', 'utf8')));
    assert.ok(bytes.includes(Buffer.from('\u{1F30D}', 'utf8')));
    const paragraphs = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)].map(([paragraph]) => paragraph);
    const visibleText = paragraph => [...paragraph.matchAll(/<w:t xml:space="preserve">([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
      .map(([token, text]) => token === '<w:tab/>' ? '\t' : token === '<w:br/>' ? '\n' : text)
      .join('');
    const titleParagraph = paragraphs.find(paragraph => paragraph.includes('Synthetic multilingual title'));
    assert.ok(titleParagraph);
    assert.equal(visibleText(titleParagraph), `Synthetic multilingual title \u{1F9ED}\nSecond line\nThird line\nFourth\tline [next]`);
    const detailsIndex = paragraphs.findIndex(paragraph => paragraph.includes('Synthetic detail'));
    assert.deepEqual(paragraphs.slice(detailsIndex, detailsIndex + 4).map(visibleText), [
      `Synthetic detail \u{1F30D}`, 'Second detail', 'Third detail', 'Fourth\tdetail'
    ]);
    assert.equal(document.contentBytes, bytes.length);
    assert.equal(document.contentSha256, createHash('sha256').update(bytes).digest('hex'));

    const detail = await context.request(`/api/documents/${job.id}`, undefined, 'GET');
    assert.equal(detail.status, 200, await detail.clone().text());
    const body = await detail.json();
    assert.equal(body.format, 'docx');
    assert.match(body.text, /Verified local Word file/);
    assert.doesNotMatch(body.text, /Synthetic multilingual title|Second detail/);
    assert.equal(state.tasks.find(item => item.id === task.id).title, title);
    assert.equal(state.tasks.find(item => item.id === task.id).details, details);
  }
});

test('invalid XML text fails in the real Word worker without recording an artifact before and after restart', async t => {
  const context = await setup(t);
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: true })).status, 200);
  const tasks = [];
  for (const [field, invalid] of [
    ...['title', 'details'].flatMap(field => ['\uFFFE', '\uFFFF', '\uD800', '\uDFFF'].map(value => [field, value]))
  ]) {
    const response = await context.request('/api/tasks', {
      title: field === 'title' ? `Synthetic invalid ${invalid}` : 'Synthetic invalid details',
      details: field === 'details' ? `Synthetic ${invalid} detail` : ''
    });
    assert.equal(response.status, 201);
    tasks.push((await response.json()).task);
  }

  for (const persisted of [false, true]) {
    if (persisted) {
      await context.updateSavedState(state => {
        for (const [index, invalid] of ['\u0000', '\u000B'].entries()) {
          state.tasks.push({
            ...tasks[0], id: randomUUID(), title: `Synthetic legacy invalid ${index}`,
            details: `Persisted invalid ${invalid} text`
          });
        }
      });
      tasks.push(...(await context.state()).tasks.filter(task => task.title.startsWith('Synthetic legacy invalid')));
    }

    for (const task of tasks) {
      const queued = await context.request('/api/jobs', {
        kind: 'word_document', taskId: task.id, requestId: randomUUID()
      });
      assert.equal(queued.status, 202);
      const { job } = await queued.json();
      await context.app.worker.tick();
      const state = await context.state();
      const failed = state.jobs.find(item => item.id === job.id);
      assert.equal(failed.status, 'failed');
      assert.match(failed.error, /XML 1\.0-invalid characters or unpaired surrogates/);
      assert.equal(failed.result, null);
      assert.equal(state.documents.some(document => document.id === job.id), false);
      assert.equal(state.tasks.find(item => item.id === task.id).title, task.title);
      assert.equal(state.tasks.find(item => item.id === task.id).details, task.details);
      await assert.rejects(readFile(join(context.root, 'documents', `${job.id}.docx`)), { code: 'ENOENT' });
    }
  }
});

test('Word detail reads fail closed on replacement and growth during bounded descriptor reads', async t => {
  const context = await setup(t);
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: true })).status, 200);
  const queued = await context.request('/api/jobs', { kind: 'word_document', requestId: randomUUID() });
  assert.equal(queued.status, 202);
  const { job } = await queued.json();
  await context.app.worker.tick();
  const document = (await context.state()).documents.find(item => item.id === job.id);
  const file = join(context.root, 'documents', `${job.id}.docx`);
  const original = await readFile(file);
  const originalOpen = fs.promises.open;

  for (const change of ['replace-identical', 'grow']) {
    await writeFile(file, original);
    let intercepted = false;
    let requestedBytes = 0;
    const hook = t.mock.method(fs.promises, 'open', async (...args) => {
      const descriptor = await originalOpen(...args);
      if (args[0] !== file) return descriptor;
      const originalRead = descriptor.read.bind(descriptor);
      descriptor.read = async (...readArgs) => {
        requestedBytes += readArgs[2];
        const result = await originalRead(...readArgs);
        if (!intercepted) {
          intercepted = true;
          if (change === 'replace-identical') {
            const displaced = join(context.root, 'displaced-synthetic.docx');
            await rename(file, displaced);
            await copyFile(displaced, file);
          } else {
            await fs.promises.appendFile(file, Buffer.alloc(1024 * 1024));
          }
        }
        return result;
      };
      return descriptor;
    });
    syncBuiltinESMExports();
    try {
      const response = await context.request(`/api/documents/${job.id}`, undefined, 'GET');
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.match(body.error, /could not be verified as a bounded, single-link file on the workspace volume/);
      assert.doesNotMatch(JSON.stringify(body), /documents[\\/][0-9a-f-]+\.docx/i);
      assert.equal(intercepted, true);
      assert.ok(requestedBytes <= original.length + 2, `read ${requestedBytes} bytes from a ${original.length}-byte file`);
      assert.deepEqual((await context.state()).documents.find(item => item.id === job.id), document);
    } finally {
      hook.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test('Word details fail closed on invalid receipts, tampering, oversized files and linked paths', async t => {
  const context = await setup(t);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  const queued = await context.request('/api/jobs', { kind: 'word_document', requestId: randomUUID() });
  const { job } = await queued.json();
  await context.app.worker.tick();
  const document = (await context.state()).documents.find(item => item.id === job.id);
  const file = join(context.root, 'documents', `${job.id}.docx`);
  const original = await readFile(file);

  for (const invalid of ['missing-hash', 'missing-size', 'malformed-hash', 'malformed-size']) {
    await context.updateSavedState(state => {
      const saved = state.documents.find(item => item.id === job.id);
      if (invalid === 'missing-hash') delete saved.contentSha256;
      else if (invalid === 'missing-size') delete saved.contentBytes;
      else if (invalid === 'malformed-hash') saved.contentSha256 = 'not-a-digest';
      else saved.contentBytes = 'not-a-size';
    });
    const response = await context.request(`/api/documents/${job.id}`, undefined, 'GET');
    assert.equal(response.status, 409, invalid);
    await context.updateSavedState(state => {
      const saved = state.documents.find(item => item.id === job.id);
      saved.contentBytes = document.contentBytes;
      saved.contentSha256 = document.contentSha256;
    });
  }

  await writeFile(file, Buffer.from('tampered replacement'));
  assert.equal((await context.request(`/api/documents/${job.id}`, undefined, 'GET')).status, 409);
  await writeFile(file, original);
  await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
  assert.equal((await context.request(`/api/documents/${job.id}`, undefined, 'GET')).status, 409);
  await writeFile(file, original);

  const hardlink = join(context.root, 'linked-word.docx');
  await link(file, hardlink);
  assert.equal((await context.request(`/api/documents/${job.id}`, undefined, 'GET')).status, 409);
  await unlink(hardlink);

  await t.test('redirected file', async t => {
    const outside = join(context.root, 'redirected-word.docx');
    await writeFile(outside, original);
    await unlink(file);
    try {
      await symlink(outside, file, 'file');
    } catch (error) {
      await writeFile(file, original);
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      return t.skip(`The environment does not permit file symlink tests (${error.code}).`);
    }
    assert.equal((await context.request(`/api/documents/${job.id}`, undefined, 'GET')).status, 409);
    await unlink(file);
    await writeFile(file, original);
  });
});

test('worker does not reuse tampered existing Word or PowerPoint files', async t => {
  for (const format of ['docx', 'pptx']) {
    await t.test(format, async t => {
      const context = await setup(t);
      await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
      let request;
      let extension;
      if (format === 'docx') {
        request = { kind: 'word_document', requestId: randomUUID() };
        extension = 'docx';
      } else {
        await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: true });
        request = { kind: 'fake_demo', requestId: randomUUID(), confirmFakeOnly: true, format: 'pptx' };
        extension = 'pptx';
      }
      const queued = await context.request('/api/jobs', request);
      assert.equal(queued.status, 202);
      const { job } = await queued.json();
      await context.app.worker.tick();
      const before = await context.state();
      const document = before.documents.find(item => item.id === job.id);
      const file = join(context.root, 'documents', `${job.id}.${extension}`);
      const tampered = Buffer.from('different replacement bytes');
      await writeFile(file, tampered);
      await context.updateSavedState(state => {
        const savedJob = state.jobs.find(item => item.id === job.id);
        savedJob.status = 'queued';
        savedJob.result = null;
        savedJob.error = '';
      });
      await context.app.worker.tick();
      const after = await context.state();
      assert.equal(after.jobs.find(item => item.id === job.id).status, 'failed');
      assert.match(after.jobs.find(item => item.id === job.id).error, /blocked or failed/i);
      assert.deepEqual(after.documents.find(item => item.id === job.id), document);
      assert.deepEqual(await readFile(file), tampered, 'the conflicting existing file is retained, not overwritten');
    });
  }
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

test('fake demo needs output and separate configuration approvals plus fresh confirmation, including after revocation', async t => {
  const context = await setup(t);
  const job = { kind: 'fake_demo', requestId: randomUUID(), confirmFakeOnly: true, format: 'markdown' };
  assert.equal((await context.request('/api/jobs', job)).status, 403);
  await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: true });
  assert.equal((await context.request('/api/jobs', { kind: 'fake_demo', requestId: randomUUID(), confirmFakeOnly: true, format: 'markdown' })).status, 403);
  assert.equal((await context.request('/api/jobs', { ...job, requestId: randomUUID(), format: undefined })).status, 400);
  assert.equal((await context.request('/api/jobs', { ...job, notes: 'Real customer input is not allowed.' })).status, 400);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  assert.equal((await context.request('/api/jobs', job)).status, 202);
  await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: false });
  await context.app.worker.tick();
  const firstState = await context.state();
  assert.equal(firstState.jobs[0].status, 'failed');
  assert.equal((await context.state()).documents.length, 0);
  const failedJob = firstState.jobs[0];
  await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: true });
  const completed = await (await context.request('/api/jobs', { ...job, requestId: randomUUID() })).json();
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs.find(item => item.id === completed.job.id).status, 'completed');
  const beforeRetry = structuredClone(failedJob);
  const retryResponse = await context.request(`/api/jobs/${failedJob.id}/retry`, {});
  assert.equal(retryResponse.status, 409);
  assert.match((await retryResponse.json()).error, /cannot be retried.*fresh explicit request/i);
  assert.deepEqual((await context.state()).jobs.find(item => item.id === failedJob.id), beforeRetry);
  const replay = await context.request('/api/jobs', { ...job, requestId: failedJob.requestId });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).job.id, failedJob.id);
  assert.equal((await context.state()).jobs.length, 2, 'reused receipt IDs do not create or rerun another job');
  assert.equal((await context.request('/api/jobs', { ...job, requestId: failedJob.requestId, format: 'pptx' })).status, 409);
  const task = await (await context.request('/api/tasks', { title: 'Fake demo bypass test' })).json();
  assert.equal((await context.request('/api/jobs', { ...job, requestId: randomUUID(), taskId: task.task.id })).status, 403);
  assert.equal((await context.request('/api/jobs', { ...job, requestId: randomUUID(), customerName: 'Synthetic forbidden input' })).status, 400);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: false });
  assert.equal((await context.request('/api/jobs', { ...job, requestId: randomUUID() })).status, 403);
  assert.equal((await context.state()).jobs.length, 2, 'revoked output approval prevents new demo requests');
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  const next = await context.request('/api/jobs', { ...job, requestId: randomUUID() });
  assert.equal(next.status, 202);
  const nextReceipt = await next.json();
  assert.notEqual(nextReceipt.job.id, failedJob.id);
  await context.restart();
  const repeatedAfterRestart = await context.request('/api/jobs', { ...job, requestId: failedJob.requestId });
  assert.equal(repeatedAfterRestart.status, 200);
  assert.equal((await repeatedAfterRestart.json()).job.id, failedJob.id);
  assert.equal((await context.state()).jobs.length, 3);
  await context.app.worker.tick();
  const finalState = await context.state();
  assert.equal(finalState.jobs.find(item => item.id === nextReceipt.job.id).status, 'completed');
  const firstCompleted = finalState.documents.find(item => item.id === completed.job.id);
  const text = await readFile(join(context.root, 'documents', `${firstCompleted.id}.md`), 'utf8');
  assert.match(text, /FAKE DATA ONLY/);
  assert.match(text, /example\.invalid/);
  assert.doesNotMatch(text, /Real customer input/);
});

test('explicit PowerPoint demo is format-bound, local-only, typed, hashed and preserved by backup and recovery', async t => {
  const context = await setup(t);
  const requestId = randomUUID();
  const request = { kind: 'fake_demo', requestId, confirmFakeOnly: true, format: 'pptx' };
  assert.equal((await context.request('/api/jobs', request)).status, 403, 'output and demo approvals are both required');
  await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: true });
  assert.equal((await context.request('/api/jobs', request)).status, 403, 'local output approval is separately required');
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  assert.equal((await context.request('/api/jobs', { ...request, format: '' })).status, 400, 'format is a deliberate choice');
  assert.equal((await context.request('/api/jobs', { ...request, format: 'ppt' })).status, 400);
  assert.equal((await context.request('/api/jobs', { ...request, taskId: randomUUID() })).status, 404);
  const accepted = await context.request('/api/jobs', request);
  assert.equal(accepted.status, 202);
  const receipt = await accepted.json();
  assert.equal(receipt.job.payload.format, 'pptx');
  const duplicate = await context.request('/api/jobs', request);
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).deduplicated, true);
  assert.equal((await context.request('/api/jobs', { ...request, format: 'markdown' })).status, 409);

  await context.app.worker.tick();
  let state = await context.state();
  const job = state.jobs.find(item => item.id === receipt.job.id);
  const document = state.documents.find(item => item.id === receipt.job.id);
  const file = join(context.root, 'documents', `${job.id}.pptx`);
  const original = await readFile(file);
  assert.equal(job.status, 'completed');
  assert.equal(job.result.format, 'pptx');
  assert.match(job.result.text, /synthetic speaker notes.*not visually rendered/i);
  assert.equal(document.format, 'pptx');
  assert.equal(document.contentBytes, original.length);
  assert.equal(document.contentSha256, createHash('sha256').update(original).digest('hex'));
  assert.equal(state.documents.length, 1, 'same-ID format dedup creates one typed artifact record');
  assert.equal((await context.request(`/api/jobs/${job.id}/retry`, {})).status, 409);
  const preview = await (await context.request(`/api/documents/${document.id}`, undefined, 'GET')).json();
  assert.equal(preview.format, 'pptx');
  assert.equal(preview.contentBytes, original.length);
  assert.match(preview.text, /not rendered in this app/);
  assert.doesNotMatch(preview.text, /north@example\.invalid|Fictional facilitator/);
  await assert.rejects(readFile(join(context.root, 'documents', `${job.id}.md`)), { code: 'ENOENT' });

  await context.request('/api/jobs', { kind: 'backup', requestId: randomUUID() });
  await context.app.worker.tick();
  state = await context.state();
  const backup = state.backups[0];
  assert.equal(backup.coverage.documents.includedCount, 1);
  const backupFile = join(context.root, 'backups', backup.id, 'documents', `${document.id}.pptx`);
  assert.deepEqual(await readFile(backupFile), original);
  const manifest = JSON.parse(await readFile(join(context.root, 'backups', backup.id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.documents.files[0].format, 'pptx');

  const recoveredResponse = await context.request(`/api/backups/${backup.id}/recover`, { confirmSeparateWorkspace: true });
  assert.equal(recoveredResponse.status, 201);
  const recoveredInfo = (await recoveredResponse.json()).recovery;
  const recovered = await startServer({ dataDir: recoveredInfo.directory, port: 0, workerIntervalMs: 0, verifyLocalVolume: async () => true });
  try {
    const restored = await (await fetch(`${recovered.url}/api/state`, { headers: { 'X-Esquie-Access': recovered.accessToken } })).json();
    assert.equal(restored.documents[0].format, 'pptx');
    assert.equal(restored.documents[0].contentBytes, original.length);
    assert.equal(restored.documents[0].contentSha256, document.contentSha256);
    assert.deepEqual(await readFile(join(recoveredInfo.directory, 'documents', `${document.id}.pptx`)), original);
    const restoredPreview = await (await fetch(`${recovered.url}/api/documents/${document.id}`, { headers: { 'X-Esquie-Access': recovered.accessToken } })).json();
    assert.equal(restoredPreview.format, 'pptx');
  } finally { await recovered.close(); }
  await context.restart();
  assert.equal((await context.state()).documents[0].format, 'pptx');
  assert.deepEqual(await readFile(file), original);
});

test('PowerPoint details require a bounded exact file and valid generation receipt', async t => {
  const context = await setup(t);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: true });
  const queued = await context.request('/api/jobs', {
    kind: 'fake_demo', requestId: randomUUID(), confirmFakeOnly: true, format: 'pptx'
  });
  const job = (await queued.json()).job;
  await context.app.worker.tick();
  const originalDocument = (await context.state()).documents.find(item => item.id === job.id);
  const file = join(context.root, 'documents', `${job.id}.pptx`);
  const original = await readFile(file);
  const details = () => context.request(`/api/documents/${job.id}`, undefined, 'GET');
  assert.equal((await details()).status, 200);

  for (const [label, change] of [
    ['missing byte length', document => { delete document.contentBytes; }],
    ['malformed content hash', document => { document.contentSha256 = 'not-a-digest'; }]
  ]) {
    await context.updateSavedState(state => change(state.documents.find(item => item.id === job.id)));
    assert.equal((await details()).status, 409, label);
    await context.updateSavedState(state => {
      state.documents = state.documents.map(item => item.id === job.id ? { ...originalDocument } : item);
    });
  }

  await writeFile(file, Buffer.from('tampered synthetic bytes'), { mode: 0o600 });
  assert.equal((await details()).status, 409, 'same-path tampering is not returned as verified');
  await writeFile(file, Buffer.alloc(1024 * 1024 + 1, 0x41), { mode: 0o600 });
  assert.equal((await details()).status, 409, 'oversized binary is rejected before an unbounded read');
  await unlink(file);
  await writeFile(file, Buffer.from('replacement synthetic bytes'), { mode: 0o600 });
  assert.equal((await details()).status, 409, 'a replaced path must match the generation receipt');
  await writeFile(file, original, { mode: 0o600 });
  assert.equal((await details()).status, 200);

  await t.test('redirected paths are rejected when symlinks are supported', async nested => {
    const outside = join(context.root, 'outside.pptx');
    await writeFile(outside, original, { mode: 0o600 });
    await unlink(file);
    try { await symlink(outside, file, 'file'); }
    catch (error) {
      await writeFile(file, original, { mode: 0o600 });
      if (['EACCES', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
        nested.skip(`Symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.notEqual((await details()).status, 200);
    await unlink(file);
    await writeFile(file, original, { mode: 0o600 });
    await unlink(outside);
  });

  await t.test('hardlinked paths are rejected when hard links are supported', async nested => {
    const alias = join(context.root, 'linked.pptx');
    try { await link(file, alias); }
    catch (error) {
      if (['EACCES', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) {
        nested.skip(`Hard-link creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    try { assert.notEqual((await details()).status, 200); }
    finally { await unlink(alias); }
  });
});

test('a different pre-existing PowerPoint file is never overwritten or adopted as a generated demo', async t => {
  const context = await setup(t);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: true });
  const response = await context.request('/api/jobs', {
    kind: 'fake_demo', requestId: randomUUID(), confirmFakeOnly: true, format: 'pptx'
  });
  const job = (await response.json()).job;
  await mkdir(join(context.root, 'documents'), { recursive: true });
  const target = join(context.root, 'documents', `${job.id}.pptx`);
  await writeFile(target, Buffer.from('Keep pre-existing synthetic bytes.'), { mode: 0o600 });
  const before = await readFile(target);
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs.find(item => item.id === job.id).status, 'failed');
  assert.equal((await context.state()).documents.length, 0);
  assert.deepEqual(await readFile(target), before);
});

test('a queued worker document ID is reserved against Monthly Outcomes XLSX export', async t => {
  const context = await setup(t);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await context.request('/api/demo-approval', { confirmSyntheticLocalOnly: true });
  const queued = await context.request('/api/jobs', {
    kind: 'fake_demo', requestId: randomUUID(), confirmFakeOnly: true, format: 'pptx'
  });
  const job = (await queued.json()).job;
  const snapshotHash = await monthlyOutcomesSnapshotHash([]);
  const exportResponse = await context.request('/api/outcomes/export', {
    requestId: job.id, snapshotHash, recordCount: 0
  });
  assert.equal(exportResponse.status, 409);
  assert.match((await exportResponse.json()).error, /reserved by a local document job/i);
  assert.equal((await context.state()).outcomeExportRequests.length, 0);
  assert.equal((await context.state()).jobs[0].status, 'queued');
  await context.app.worker.tick();
  const state = await context.state();
  assert.equal(state.jobs[0].status, 'completed');
  assert.equal(state.documents.length, 1);
  assert.equal(state.documents[0].id, job.id);
  assert.equal(state.documents[0].format, 'pptx');
  await assert.rejects(readFile(join(context.root, 'documents', `monthly-outcomes-${job.id}.xlsx`)), { code: 'ENOENT' });
});

test('a cross-format record appearing at commit leaves worker output explicitly untracked', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-document-id-race-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const state = newWorkspace();
  state.preferences.localOutputApproved = true;
  state.preferences.demoApproved = true;
  const job = enqueue(state, {
    kind: 'fake_demo', requestId: randomUUID(),
    payload: { confirmFakeOnly: true, format: 'pptx' }
  });
  const output = join(root, 'documents', `${job.id}.pptx`);
  let insertedCollision = false;
  const store = {
    state,
    update(change) {
      if (!insertedCollision && fs.existsSync(output)) {
        state.documents.push({
          id: job.id, kind: 'monthly-outcomes-xlsx', format: 'xlsx',
          fileName: `monthly-outcomes-${job.id}.xlsx`
        });
        insertedCollision = true;
      }
      return change(state);
    }
  };
  const worker = createWorker({
    store, root, intervalMs: 0, verifyOutput: async () => {}, assertOutput: () => {}
  });
  try {
    await worker.tick();
    assert.equal(insertedCollision, true);
    assert.equal(job.status, 'failed');
    assert.match(job.error, /file remains untracked for inspection/i);
    assert.equal(state.documents.length, 1);
    assert.equal(state.documents[0].format, 'xlsx');
    assert.equal(fs.existsSync(output), true, 'the conflicting worker file is retained, not deleted');
  } finally { await worker.stop(); }
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
    kind: 'fake_demo', requestId: randomUUID(), confirmFakeOnly: true, format: 'markdown'
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
      kind, requestId: randomUUID(), ...(kind === 'fake_demo' ? { confirmFakeOnly: true, format: 'markdown' } : {})
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
