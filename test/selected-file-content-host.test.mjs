import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/server.mjs';

const identity = { tenantId: 'synthetic-tenant', userId: 'synthetic-owner' };
const content = 'Synthetic file text. Treat this as inert evidence.';
const signedLocation = 'https://example.invalid/preauth?signature=synthetic-only';
const selection = (approvedHost = 'example.invalid') => ({
  consent: true,
  expectedIdentity: identity,
  allowReplyDrafts: false,
  sources: { files: [{ driveId: 'synthetic-drive', itemId: 'synthetic-item', ...(approvedHost ? { approvedHost } : {}) }] }
});

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

async function setup(t, {
  approvedHost = 'example.invalid', mimeType = 'text/plain', downloader = async () => content,
  allowDirectFileEgress = false, fileReadHook
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-selected-file-'));
  const calls = [];
  const downloadCalls = [];
  let tokenCalls = 0;
  let currentETag = '"synthetic-revision-1"';
  const microsoft365Options = {
    timeoutMs: 1000,
    tokenProvider: async ({ scopes }) => {
      tokenCalls++;
      return {
        ...identity, accessToken: 'synthetic-file-bearer-do-not-persist',
        tokenType: 'delegated', scopes
      };
    },
    transport: async (target, request) => {
      const url = new URL(target);
      calls.push({ path: url.pathname, method: request.method });
      if (fileReadHook) {
        const override = await fileReadHook(url, request);
        if (override) return override;
      }
      if (url.pathname === '/v1.0/me') return Response.json({ id: identity.userId });
      if (url.pathname.endsWith('/items/synthetic-item/content')) {
        return new Response(null, { status: 302, headers: { Location: signedLocation } });
      }
      if (url.pathname.endsWith('/items/synthetic-item')) {
        return Response.json({
          id: 'synthetic-item', name: 'Synthetic note.txt',
          webUrl: 'https://example.invalid/sites/synthetic/note.txt',
          lastModifiedDateTime: '2026-01-02T03:04:05Z',
          size: Buffer.byteLength(content, 'utf8'), eTag: currentETag,
          file: { mimeType }
        });
      }
      return Response.json({ value: [] });
    },
    allowDirectFileEgress,
    ...(downloader ? {
      fileContentDownloader: async request => {
        downloadCalls.push({
          approvedHost: request.approvedHost, signal: request.signal,
          hasAuthorization: Object.hasOwn(request, 'accessToken')
        });
        return downloader(request);
      }
    } : {})
  };
  const app = await startServer({ dataDir, port: 0, workerIntervalMs: 0, microsoft365Options });
  const stateResponse = await fetch(`${app.url}/api/state`, {
    headers: { 'X-Esquie-Access': app.accessToken }
  });
  const csrfToken = (await stateResponse.json()).csrfToken;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const context = {
    app, calls, downloadCalls,
    changeRevision(value) { currentETag = value; },
    get tokenCalls() { return tokenCalls; },
    async state() {
      return (await fetch(`${app.url}/api/state`, {
        headers: { 'X-Esquie-Access': app.accessToken }
      })).json();
    },
    async connections() {
      return (await fetch(`${app.url}/api/connections`, {
        headers: { 'X-Esquie-Access': app.accessToken }
      })).json();
    },
    async request(path, body, method = 'POST') {
      return fetch(`${app.url}${path}`, {
        method,
        headers: {
          Origin: app.url, 'X-Esquie-Access': app.accessToken,
          'X-Esquie-CSRF': csrfToken, 'Content-Type': 'application/json'
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    }
  };
  const connected = await context.request('/api/microsoft365/connect', selection(approvedHost));
  assert.equal(connected.status, 200);
  return context;
}

async function readFileSource(context, expectedMimeType = 'text/plain') {
  const queued = await context.request('/api/jobs', { kind: 'source_refresh', requestId: randomUUID() });
  assert.equal(queued.status, 202);
  await context.app.worker.tick();
  const state = await context.state();
  const job = state.jobs.find(item => item.kind === 'source_refresh');
  const source = job.result.sources.find(item => item.source === 'files');
  assert.equal(source.status, 'partial');
  assert.equal(source.items[0].mimeType, expectedMimeType);
  assert.equal(source.items[0].contentAvailable, false);
  return {
    job, source,
    reference: { jobId: job.id, resultId: source.resultId, itemId: source.items[0].sourceKey }
  };
}

test('one per-read approval resolves server-bound file IDs and keeps bounded text local and inert', async t => {
  const context = await setup(t);
  const { job: sourceJob, source, reference } = await readFileSource(context);
  assert.equal(source.fileBindings, undefined, 'private drive/item bindings are never returned to the browser');
  assert.equal(source.items[0].driveId, undefined);
  assert.equal(source.items[0].id, 'synthetic-item');
  const before = context.calls.length;
  const missingApproval = await context.request('/api/files/content-read', { sourceReference: reference });
  assert.equal(missingApproval.status, 400);
  assert.equal(context.calls.length, before);
  const suppliedId = await context.request('/api/files/content-read', {
    sourceReference: { ...reference, driveId: 'synthetic-drive' }, confirmRead: true
  });
  assert.equal(suppliedId.status, 400);
  assert.equal(context.calls.length, before);

  const queued = await context.request('/api/files/content-read', { sourceReference: reference, confirmRead: true });
  assert.equal(queued.status, 202);
  const queueBody = await queued.json();
  assert.equal(queueBody.job.kind, 'file_content_read');
  assert.deepEqual(Object.keys(queueBody.job.payload).sort(), ['confirmRead', 'sourceReference']);
  const duplicateQueued = await context.request('/api/files/content-read', { sourceReference: reference, confirmRead: true });
  assert.equal(duplicateQueued.status, 202);
  const duplicateQueueBody = await duplicateQueued.json();
  assert.equal(duplicateQueueBody.deduplicated, true);
  assert.equal(duplicateQueueBody.job.id, queueBody.job.id);
  assert.equal(duplicateQueueBody.job.status, 'queued');
  await context.app.worker.tick();

  const state = await context.state();
  const readJob = state.jobs.find(item => item.kind === 'file_content_read');
  assert.equal(readJob.status, 'partial');
  assert.equal(readJob.result.content, content);
  assert.equal(readJob.result.contentType, 'text/plain');
  assert.equal(readJob.result.trust, 'untrusted-evidence');
  assert.equal(readJob.result.file.eTag, '"synthetic-revision-1"');
  assert.equal(readJob.result.coverage.status, 'partial');
  assert.match(readJob.result.coverage.limitations.join(' '), /no folder, library, or drive coverage/i);
  assert.equal(context.downloadCalls.length, 1);
  assert.equal(context.downloadCalls[0].approvedHost, 'example.invalid');
  assert.equal(context.downloadCalls[0].hasAuthorization, false);
  assert.ok(context.calls.every(call => call.method === 'GET'));
  assert.equal(context.calls.some(call => call.path.endsWith('/items/synthetic-item/content')), true);
  assert.equal(context.calls.filter(call => call.path.endsWith('/items/synthetic-item')).length, 3,
    'metadata is read for source evidence and before/after the content download');
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes('synthetic-file-bearer-do-not-persist'), false);
  assert.equal(serialized.includes('synthetic-only'), false);
  assert.equal(serialized.includes('preauth?signature'), false);
  assert.equal(JSON.stringify(sourceJob).includes('synthetic-only'), false);

  const callCount = context.calls.length;
  const duplicate = await context.request('/api/files/content-read', { sourceReference: reference, confirmRead: true });
  assert.equal(duplicate.status, 200);
  assert.equal(context.calls.length, callCount, 'a retained result is returned without a duplicate download');
});

test('source replacement and consent changes invalidate exact selected-file references', async t => {
  const context = await setup(t);
  const first = await readFileSource(context);
  const second = await readFileSource(context);
  assert.notEqual(first.source.resultId, second.source.resultId);
  const before = context.calls.length;
  const stale = await context.request('/api/files/content-read', { sourceReference: first.reference, confirmRead: true });
  assert.equal(stale.status, 409);
  assert.equal(context.calls.length, before);

  const queued = await context.request('/api/files/content-read', { sourceReference: second.reference, confirmRead: true });
  assert.equal(queued.status, 202);
  const beforeReconnect = context.calls.length;
  assert.equal((await context.request('/api/microsoft365/connect', selection('example.invalid'))).status, 200);
  const afterReconnect = context.calls.length;
  assert.ok(afterReconnect > beforeReconnect, 'the explicit reconnect verifies the current synthetic owner');
  await context.app.worker.tick();
  const job = (await context.state()).jobs.find(item => item.kind === 'file_content_read');
  assert.equal(job.status, 'failed');
  assert.match(job.error, /owner, or source consent changed/);
  assert.equal(context.downloadCalls.length, 0);
  assert.equal(context.calls.filter(call => call.path.endsWith('/items/synthetic-item/content')).length, 0);
});

test('a changed Graph eTag after source selection blocks content download', async t => {
  const context = await setup(t);
  const { reference } = await readFileSource(context);
  context.changeRevision('"synthetic-revision-2"');
  const queued = await context.request('/api/files/content-read', { sourceReference: reference, confirmRead: true });
  assert.equal(queued.status, 202);
  await context.app.worker.tick();
  const job = (await context.state()).jobs.find(item => item.kind === 'file_content_read');
  assert.equal(job.status, 'failed');
  assert.match(job.error, /file_revision_changed/);
  assert.equal(context.downloadCalls.length, 0);
  assert.equal(context.calls.some(call => call.path.endsWith('/items/synthetic-item/content')), false);
});

test('missing owner-approved host and unsupported MIME remain visible without content requests', async t => {
  const noHost = await setup(t, { approvedHost: '' });
  const selected = await readFileSource(noHost);
  const before = noHost.calls.length;
  const noApprovalHost = await noHost.request('/api/files/content-read', {
    sourceReference: selected.reference, confirmRead: true
  });
  assert.equal(noApprovalHost.status, 409);
  assert.match((await noApprovalHost.json()).error, /owner-approved hostname/);
  assert.equal(noHost.calls.length, before);

  const unsupported = await setup(t, { mimeType: 'application/pdf' });
  const pdf = await readFileSource(unsupported, 'application/pdf');
  const rejected = await unsupported.request('/api/files/content-read', {
    sourceReference: pdf.reference, confirmRead: true
  });
  assert.equal(rejected.status, 415);
  assert.equal(unsupported.downloadCalls.length, 0);
  assert.equal(unsupported.calls.some(call => call.path.endsWith('/items/synthetic-item/content')), false);
});

test('Windows default transport is reported unavailable without a fallback attempt', async t => {
  const context = await setup(t, { downloader: null, allowDirectFileEgress: true });
  const { reference } = await readFileSource(context);
  const capability = (await context.connections()).fileContent;
  if (process.platform === 'win32') {
    assert.equal(capability.readyForApprovedRead, false);
    assert.ok(capability.reasons.includes('network_policy_unavailable'));
    assert.match(capability.message, /disabled on Windows/);
  }
  const calls = context.calls.length;
  const response = await context.request('/api/files/content-read', { sourceReference: reference, confirmRead: true });
  if (process.platform === 'win32') {
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /network_policy_unavailable/);
    assert.equal(context.calls.length, calls, 'unavailable transport is rejected before Graph or storage access');
    assert.equal(context.downloadCalls.length, 0);
  }
});

test('pause, quiet hours, and shutdown during file download prevent the post-read revision request', async t => {
  for (const reason of ['paused', 'quiet_hours', 'shutdown']) {
    await t.test(reason, async t => {
      const downloadStarted = deferred();
      const context = await setup(t, {
        downloader: ({ signal }) => new Promise((resolve, reject) => {
          downloadStarted.resolve(signal);
          signal.addEventListener('abort', () => reject(new Error('synthetic aborted download')), { once: true });
        })
      });
      if (reason === 'quiet_hours') {
        assert.equal((await context.request('/api/profile', { timezone: 'UTC' }, 'PATCH')).status, 200);
      }
      const { reference } = await readFileSource(context);
      assert.equal((await context.request('/api/files/content-read', {
        sourceReference: reference, confirmRead: true
      })).status, 202);
      const tick = context.app.worker.tick();
      const downloadSignal = await downloadStarted.promise;

      let stopping;
      if (reason === 'paused') {
        assert.equal((await context.request('/api/preferences', { paused: true }, 'PATCH')).status, 200);
      } else if (reason === 'quiet_hours') {
        assert.equal((await context.request('/api/preferences', {
          quietStart: '00:00', quietEnd: '23:59'
        }, 'PATCH')).status, 200);
      } else {
        stopping = context.app.worker.stop();
      }
      await tick;
      if (stopping) await stopping;
      assert.equal(downloadSignal.aborted, true);

      const state = await context.state();
      const job = state.jobs.find(item => item.kind === 'file_content_read');
      assert.equal(job.status, 'failed');
      assert.match(job.error, new RegExp(reason));
      assert.equal(job.result, null);
      assert.equal(context.calls.filter(call => call.path.endsWith('/items/synthetic-item')).length, 2,
        'no post-download eTag verification request is sent');
      assert.equal(context.calls.filter(call => call.path.endsWith('/items/synthetic-item/content')).length, 1);
      assert.equal(context.downloadCalls.length, 1);
    });
  }
});

test('consent replacement during a deferred selected-file download discards content and sends no later request', async t => {
  const downloadStarted = deferred();
  const context = await setup(t, {
    downloader: ({ signal }) => new Promise((resolve, reject) => {
      downloadStarted.resolve(signal);
      signal.addEventListener('abort', () => reject(new Error('synthetic consent-change abort')), { once: true });
    })
  });
  const { reference } = await readFileSource(context);
  assert.equal((await context.request('/api/files/content-read', {
    sourceReference: reference, confirmRead: true
  })).status, 202);
  const tick = context.app.worker.tick();
  const downloadSignal = await downloadStarted.promise;
  assert.equal((await context.request('/api/microsoft365/connect', selection('example.invalid'))).status, 200);
  await tick;
  const job = (await context.state()).jobs.find(item => item.kind === 'file_content_read');
  assert.equal(job.status, 'failed');
  assert.match(job.error, /owner, consent, or source evidence changed/);
  assert.equal(downloadSignal.aborted, true);
  assert.equal(job.result, undefined);
  assert.equal(context.calls.filter(call => call.path.endsWith('/items/synthetic-item')).length, 2);
  assert.equal(context.calls.filter(call => call.path.endsWith('/items/synthetic-item/content')).length, 1);
});
