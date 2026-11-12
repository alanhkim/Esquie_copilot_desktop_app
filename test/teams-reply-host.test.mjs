import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/server.mjs';

const identity = { tenantId: 'synthetic-tenant', userId: 'synthetic-owner' };
const selection = {
  consent: true,
  expectedIdentity: identity,
  allowReplyDrafts: false,
  sources: { channels: [{ teamId: 'synthetic-team', channelId: 'synthetic-channel' }] }
};
const parent = {
  id: 'synthetic-parent',
  channelIdentity: { teamId: 'synthetic-team', channelId: 'synthetic-channel' },
  webUrl: 'https://teams.example.invalid/parent',
  body: { contentType: 'text', content: 'Synthetic parent message.' }
};

async function setup(t, { graphHook } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-teams-replies-'));
  const calls = [];
  let tokenCalls = 0;
  let activeIdentity = identity;
  const microsoft365Options = {
    timeoutMs: 1000,
    tokenProvider: async ({ scopes }) => {
      tokenCalls++;
      return {
        ...activeIdentity, accessToken: 'synthetic-bearer-do-not-persist',
        tokenType: 'delegated', scopes
      };
    },
    transport: async (target, request) => {
      const url = new URL(target);
      calls.push({ path: url.pathname, method: request.method });
      if (graphHook) {
        const override = await graphHook(url, request);
        if (override) return override;
      }
      if (url.pathname === '/v1.0/me') return Response.json({ id: activeIdentity.userId });
      if (url.pathname.endsWith('/messages/synthetic-parent/replies')) {
        return Response.json({ value: [{
          id: 'synthetic-reply',
          replyToId: 'synthetic-parent',
          channelIdentity: { teamId: 'synthetic-team', channelId: 'synthetic-channel' },
          body: { contentType: 'text', content: '<script>not executable</script> Synthetic reply.' }
        }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/unfollowed-synthetic-link' });
      }
      if (url.pathname.endsWith('/messages/synthetic-parent')) return Response.json(parent);
      if (url.pathname.endsWith('/channels/synthetic-channel/messages')) {
        return Response.json({ value: [parent] });
      }
      return Response.json({ value: [] });
    }
  };
  let app = await startServer({ dataDir, port: 0, workerIntervalMs: 0, microsoft365Options });
  let csrfToken = (await (await fetch(`${app.url}/api/state`, {
    headers: { 'X-Esquie-Access': app.accessToken }
  })).json()).csrfToken;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const context = {
    calls,
    get app() { return app; },
    get tokenCalls() { return tokenCalls; },
    changeIdentity(next) { activeIdentity = next; },
    async state() {
      return (await fetch(`${app.url}/api/state`, {
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
  const connected = await context.request('/api/microsoft365/connect', selection);
  assert.equal(connected.status, 200);
  return context;
}

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

async function readChannelSource(context) {
  await context.request('/api/jobs', { kind: 'source_refresh', requestId: randomUUID() });
  await context.app.worker.tick();
  const job = (await context.state()).jobs[0];
  const source = job.result.sources.find(item => item.source === 'teamsChannels');
  assert.equal(source.status, 'partial');
  assert.equal(source.items[0].id, parent.id);
  return {
    job, source,
    reference: { jobId: job.id, resultId: source.resultId, itemId: source.items[0].sourceKey }
  };
}

test('completed source-refresh retries return a redacted retained job, not a false queued result', async t => {
  const context = await setup(t);
  const { job, source, reference } = await readChannelSource(context);
  const repeated = await context.request('/api/jobs', {
    kind: 'source_refresh', requestId: job.requestId
  });
  assert.equal(repeated.status, 200);
  const body = await repeated.json();
  assert.equal(body.deduplicated, true);
  assert.equal(body.job.status, 'partial');
  assert.match(body.message, /already exists.*partial job was retained/i);
  assert.equal(body.job.result.sources.find(item => item.source === 'teamsChannels').replyBindings, undefined);
  assert.equal(source.replyBindings, undefined);

  const queued = await context.request('/api/teams/channel-replies', { sourceReference: reference });
  assert.equal(queued.status, 202, 'server-only bindings remain available for the validated action');
  const firstReceipt = await queued.json();
  const duplicateQueued = await context.request('/api/teams/channel-replies', { sourceReference: reference });
  assert.equal(duplicateQueued.status, 202);
  const duplicateReceipt = await duplicateQueued.json();
  assert.equal(duplicateReceipt.deduplicated, true);
  assert.equal(duplicateReceipt.job.id, firstReceipt.job.id);
  assert.equal(duplicateReceipt.job.status, 'queued');
  assert.equal(JSON.stringify(duplicateReceipt.job).includes('replyBindings'), false);
});

test('selected parent replies run through stored evidence only and remain GET-only inert evidence', async t => {
  const context = await setup(t);
  const { source, reference } = await readChannelSource(context);
  assert.equal(source.replyBindings, undefined, 'server-only channel IDs must not be sent to the browser');
  assert.equal(source.items[0].teamId, undefined);
  assert.equal(source.items[0].channelId, undefined);
  assert.equal((await context.state()).sourceChecks, undefined);
  const listed = await context.request('/api/jobs', undefined, 'GET');
  const listedJob = (await listed.json()).jobs.find(item => item.result?.sources?.some(sourceResult => sourceResult.source === 'teamsChannels'));
  assert.equal(listedJob.result.sources.find(item => item.source === 'teamsChannels').replyBindings, undefined);
  const retried = await context.request(`/api/jobs/${reference.jobId}/retry`, {});
  assert.equal(retried.status, 202);
  const retriedJob = await retried.json();
  assert.equal(retriedJob.job.previousResult.sources.find(item => item.source === 'teamsChannels').replyBindings, undefined);
  await context.app.worker.tick();

  const queued = await context.request('/api/teams/channel-replies', { sourceReference: reference });
  assert.equal(queued.status, 409, 'an explicit source recheck replacement makes the old reference stale');
  const refreshed = await readChannelSource(context);
  const refreshedQueued = await context.request('/api/teams/channel-replies', { sourceReference: refreshed.reference });
  assert.equal(refreshedQueued.status, 202);
  await context.app.worker.tick();

  const state = await context.state();
  const job = state.jobs.find(item => item.kind === 'teams_channel_replies');
  assert.equal(job.status, 'partial');
  assert.equal(job.result.parent.excerpt, 'Synthetic parent message.');
  assert.equal(job.result.items.length, 1);
  assert.equal(job.result.hasMore, true);
  assert.equal(job.result.items[0].excerpt, '<script>not executable</script> Synthetic reply.');
  assert.deepEqual(job.payload, { sourceReference: refreshed.reference });
  assert.match(job.result.text, /historical evidence/);
  assert.ok(context.calls.some(call => call.path.endsWith('/messages/synthetic-parent/replies') && call.method === 'GET'));
  assert.ok(context.calls.some(call => call.path.endsWith('/messages/synthetic-parent') && call.method === 'GET'));
  assert.equal(context.calls.some(call => call.path.includes('unfollowed-synthetic-link')), false);
  assert.ok(context.calls.every(call => call.method === 'GET'));
  assert.equal(JSON.stringify(state).includes('synthetic-bearer-do-not-persist'), false);

  const callCount = context.calls.length;
  const duplicate = await context.request('/api/teams/channel-replies', { sourceReference: refreshed.reference });
  assert.equal(duplicate.status, 200);
  assert.equal(context.calls.length, callCount, 'duplicate selection returns retained evidence without another Graph read');
});

test('replacement source checks invalidate old references before queueing', async t => {
  const context = await setup(t);
  const first = await readChannelSource(context);
  const second = await readChannelSource(context);
  assert.notEqual(first.source.resultId, second.source.resultId);
  const calls = context.calls.length;
  const tokenCalls = context.tokenCalls;
  const stale = await context.request('/api/teams/channel-replies', { sourceReference: first.reference });
  assert.equal(stale.status, 409);
  assert.equal(context.calls.length, calls);
  assert.equal(context.tokenCalls, tokenCalls);
});

test('queued reply reads recheck consent and owner before the worker makes a Teams request', async t => {
  const context = await setup(t);
  const { reference } = await readChannelSource(context);
  const queued = await context.request('/api/teams/channel-replies', { sourceReference: reference });
  assert.equal(queued.status, 202);
  const beforeDisconnect = context.calls.length;
  assert.equal((await context.request('/api/microsoft365/disconnect', {})).status, 200);
  await context.app.worker.tick();
  const job = (await context.state()).jobs.find(item => item.kind === 'teams_channel_replies');
  assert.equal(job.status, 'failed');
  assert.match(job.error, /owner, or source consent changed/);
  assert.equal(context.calls.length, beforeDisconnect, 'disconnect and worker rejection must not make a Teams read');
  assert.equal((await context.request(`/api/jobs/${job.id}/retry`, {})).status, 409);
  assert.equal(context.calls.length, beforeDisconnect, 'stale evidence is rejected before explicit retry too');
});

test('consent revision and owner changes invalidate queued replies before the Teams source request', async t => {
  for (const change of ['consent', 'owner']) {
    await t.test(change, async t => {
      const context = await setup(t);
      const { reference } = await readChannelSource(context);
      const queued = await context.request('/api/teams/channel-replies', { sourceReference: reference });
      assert.equal(queued.status, 202);
      const beforeChange = context.calls.length;
      const nextIdentity = change === 'owner'
        ? { tenantId: 'synthetic-other-tenant', userId: 'synthetic-other-owner' }
        : identity;
      if (change === 'owner') context.changeIdentity(nextIdentity);
      const nextSelection = {
        ...selection,
        expectedIdentity: nextIdentity,
        sources: {
          channels: change === 'owner'
            ? selection.sources.channels
            : [{ teamId: 'synthetic-replacement-team', channelId: 'synthetic-replacement-channel' }]
        }
      };
      assert.equal((await context.request('/api/microsoft365/connect', nextSelection)).status, 200);
      const afterReconnect = context.calls.length;
      assert.ok(afterReconnect > beforeChange, 'explicit reconnect verifies the current synthetic owner');
      await context.app.worker.tick();
      const job = (await context.state()).jobs.find(item => item.kind === 'teams_channel_replies');
      assert.equal(job.status, 'failed');
      assert.ok(context.calls.every(call =>
        !call.path.endsWith('/messages/synthetic-parent') &&
        !call.path.endsWith('/messages/synthetic-parent/replies')
      ), 'stale owner/consent must not read the selected parent or replies');
    });
  }
});

test('paused and quiet-hour settings defer queued reply reads', async t => {
  const context = await setup(t);
  const { reference } = await readChannelSource(context);
  await context.request('/api/preferences', { paused: true }, 'PATCH');
  assert.equal((await context.request('/api/teams/channel-replies', { sourceReference: reference })).status, 202);
  await context.app.worker.tick();
  let job = (await context.state()).jobs.find(item => item.kind === 'teams_channel_replies');
  assert.equal(job.status, 'queued');
  assert.equal(context.calls.some(call => call.path.endsWith('/messages/synthetic-parent/replies')), false);

  await context.request('/api/preferences', { paused: false, quietStart: '00:00', quietEnd: '00:00' }, 'PATCH');
  await context.app.worker.tick();
  job = (await context.state()).jobs.find(item => item.kind === 'teams_channel_replies');
  assert.equal(job.status, 'queued');
  assert.equal(context.calls.some(call => call.path.endsWith('/messages/synthetic-parent/replies')), false);
});

test('pause, quiet hours, and shutdown between parent and replies prevent the second Teams request', async t => {
  for (const reason of ['paused', 'quiet_hours', 'shutdown']) {
    await t.test(reason, async t => {
      const parentStarted = deferred();
      const parentResponse = deferred();
      const context = await setup(t, {
        graphHook: async url => {
          if (url.pathname.endsWith('/messages/synthetic-parent')) {
            parentStarted.resolve();
            return parentResponse.promise;
          }
          return null;
        }
      });
      if (reason === 'quiet_hours') {
        assert.equal((await context.request('/api/profile', { timezone: 'UTC' }, 'PATCH')).status, 200);
      }
      const { reference } = await readChannelSource(context);
      assert.equal((await context.request('/api/teams/channel-replies', { sourceReference: reference })).status, 202);
      const tick = context.app.worker.tick();
      await Promise.race([parentStarted.promise, tick.then(async () => {
        throw new Error(`Reply read finished before the delayed parent: ${JSON.stringify((await context.state()).jobs[0])}`);
      })]);

      let closing;
      let allowClose;
      let stopped;
      if (reason === 'paused') {
        assert.equal((await context.request('/api/preferences', { paused: true }, 'PATCH')).status, 200);
      } else if (reason === 'quiet_hours') {
        assert.equal((await context.request('/api/preferences', {
          quietStart: '00:00', quietEnd: '00:00'
        }, 'PATCH')).status, 200);
      } else {
        allowClose = deferred();
        stopped = deferred();
        const stop = context.app.worker.stop.bind(context.app.worker);
        context.app.worker.stop = async () => {
          await stop();
          stopped.resolve();
          await allowClose.promise;
        };
        closing = context.app.close();
      }
      parentResponse.resolve(Response.json(parent));
      await tick;
      if (closing) {
        await stopped.promise;
      }

      try {
        const state = await context.state();
        const job = state.jobs.find(item => item.kind === 'teams_channel_replies');
        assert.equal(job.status, 'failed');
        assert.match(job.error, new RegExp(reason));
        assert.equal(context.calls.filter(call => call.path.endsWith('/messages/synthetic-parent')).length, 1);
        assert.equal(context.calls.some(call => call.path.endsWith('/messages/synthetic-parent/replies')), false);
        assert.equal(job.result, null);
      } finally {
        if (closing) {
          allowClose.resolve();
          await closing;
        }
      }
    });
  }
});

test('owner or consent replacement during a deferred parent read prevents the replies request', async t => {
  for (const change of ['owner', 'consent']) {
    await t.test(change, async t => {
      const parentStarted = deferred();
      const parentResponse = deferred();
      const context = await setup(t, {
        graphHook: async url => {
          if (url.pathname.endsWith('/messages/synthetic-parent')) {
            parentStarted.resolve();
            return parentResponse.promise;
          }
          return null;
        }
      });
      const { reference } = await readChannelSource(context);
      assert.equal((await context.request('/api/teams/channel-replies', { sourceReference: reference })).status, 202);
      const tick = context.app.worker.tick();
      await parentStarted.promise;
      const nextIdentity = change === 'owner'
        ? { tenantId: 'replacement-tenant', userId: 'replacement-owner' }
        : identity;
      if (change === 'owner') context.changeIdentity(nextIdentity);
      const nextSelection = {
        ...selection,
        expectedIdentity: nextIdentity,
        sources: {
          channels: change === 'owner'
            ? selection.sources.channels
            : [{ teamId: 'replacement-team', channelId: 'replacement-channel' }]
        }
      };
      assert.equal((await context.request('/api/microsoft365/connect', nextSelection)).status, 200);
      parentResponse.resolve(Response.json(parent));
      await tick;
      const job = (await context.state()).jobs.find(item => item.kind === 'teams_channel_replies');
      assert.equal(job.status, 'failed');
      assert.match(job.error, /owner, consent, or selected evidence changed/);
      assert.equal(context.calls.filter(call => call.path.endsWith('/messages/synthetic-parent')).length, 1);
      assert.equal(context.calls.some(call => call.path.endsWith('/messages/synthetic-parent/replies')), false);
      assert.equal(job.result, undefined);
    });
  }
});

test('raw IDs, paths, and malformed references cannot authorize a reply read', async t => {
  const context = await setup(t);
  const { reference } = await readChannelSource(context);
  const calls = context.calls.length;
  const tokenCalls = context.tokenCalls;
  const rejected = await context.request('/api/teams/channel-replies', {
    sourceReference: { ...reference, teamId: 'synthetic-team' }
  });
  assert.equal(rejected.status, 400);
  const stale = await context.request('/api/teams/channel-replies', {
    sourceReference: { jobId: randomUUID(), resultId: randomUUID(), itemId: 'a'.repeat(64) }
  });
  assert.equal(stale.status, 409);
  assert.equal(context.calls.length, calls);
  assert.equal(context.tokenCalls, tokenCalls);
});
