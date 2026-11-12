import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStore } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';
import { enqueue, quietHoursActive, timezoneAvailable } from '../src/worker.mjs';

async function setup(t, timezone, preferences = {}) {
  const root = await mkdtemp(join(tmpdir(), 'esquie-timezone-recovery-'));
  let app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  await app.close();
  const store = await openStore(root);
  try {
    store.update(state => {
      state.profile.timezone = timezone;
      state.profile.displayName = 'Synthetic owner';
      Object.assign(state.preferences, preferences);
      enqueue(state, { kind: 'source_refresh', requestId: randomUUID(), origin: 'schedule' });
      enqueue(state, { kind: 'task_summary', requestId: randomUUID() });
    });
  } finally { await store.close(); }
  const start = () => startServer({ dataDir: root, port: 0, workerIntervalMs: 0, clock: () => new Date('2026-03-04T12:00:00Z') });
  app = await start();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const state = async () => (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  return {
    get app() { return app; }, state,
    async patch(path, body) {
      const current = await state();
      return fetch(`${app.url}${path}`, {
        method: 'PATCH',
        headers: { Origin: app.url, 'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': current.csrfToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    },
    async restart() { await app.close(); app = await start(); }
  };
}

test('invalid saved timezone without quiet hours preserves manual work while deferring schedules across restart', async t => {
  const context = await setup(t, 'Invalid/Fake', { automaticRefresh: true, dailyBackups: true });
  await context.app.worker.tick();
  let state = await context.state();
  assert.equal(state.profile.timezone, 'Invalid/Fake');
  assert.equal(state.profile.displayName, 'Synthetic owner');
  assert.deepEqual(state.timezoneStatus, { available: false, quietHoursInvalid: false, quietHoursBlocked: false, scheduledWorkBlocked: true });
  assert.equal(state.jobs.find(job => job.kind === 'task_summary').status, 'completed');
  assert.equal(state.jobs.find(job => job.kind === 'source_refresh').status, 'queued');
  assert.equal(state.jobs.filter(job => job.kind === 'backup').length, 0);
  await context.restart();
  await context.app.worker.tick();
  state = await context.state();
  assert.equal(state.jobs.find(job => job.kind === 'source_refresh').status, 'queued');
  assert.equal((await context.patch('/api/profile', { timezone: 'UTC' })).status, 200);
  await context.app.worker.tick();
  state = await context.state();
  assert.equal(state.timezoneStatus.available, true);
  assert.equal(state.jobs.find(job => job.kind === 'source_refresh').status, 'failed');
  assert.equal(state.profile.displayName, 'Synthetic owner');
});

test('invalid saved timezone with scheduling disabled does not block manual work', async t => {
  const context = await setup(t, 'Invalid/Fake');
  await context.app.worker.tick();
  let state = await context.state();
  assert.equal(state.timezoneStatus.scheduledWorkBlocked, true);
  assert.equal(state.jobs.find(job => job.kind === 'task_summary').status, 'completed');
  assert.equal(state.jobs.find(job => job.kind === 'source_refresh').status, 'queued');
  const response = await fetch(`${context.app.url}/api/jobs`, {
    method: 'POST',
    headers: { Origin: context.app.url, 'X-Esquie-Access': context.app.accessToken, 'X-Esquie-CSRF': state.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'backup', requestId: randomUUID() })
  });
  assert.equal(response.status, 202);
  await context.app.worker.tick();
  state = await context.state();
  assert.equal(state.jobs.find(job => job.kind === 'backup').status, 'failed');
  assert.ok(state.scheduler.lastBackupAttemptAt);
  assert.equal(state.profile.timezone, 'Invalid/Fake');
});

test('invalid or missing legacy timezone blocks quiet hours but permits explicit safe preference repair', async t => {
  for (const zone of ['Invalid/Fake', '']) {
    await t.test(`saved timezone ${zone || '(missing)'}`, async t => {
      const context = await setup(t, zone, { quietStart: '22:00', quietEnd: '06:00', automaticRefresh: true, dailyBackups: true });
      await context.app.worker.tick();
      let state = await context.state();
      assert.equal(state.timezoneStatus.quietHoursBlocked, true);
      assert.equal(state.jobs.find(job => job.kind === 'task_summary').status, 'queued');
      const paused = await context.patch('/api/preferences', { paused: true });
      assert.equal(paused.status, 200);
      assert.equal((await context.state()).preferences.paused, true);
      const disabled = await context.patch('/api/preferences', { paused: false, quietStart: '', quietEnd: '', automaticRefresh: false, dailyBackups: false });
      assert.equal(disabled.status, 200);
      await context.app.worker.tick();
      state = await context.state();
      assert.equal(state.profile.timezone, zone);
      assert.equal(state.jobs.find(job => job.kind === 'task_summary').status, 'completed');
      assert.equal(state.jobs.find(job => job.kind === 'source_refresh').status, 'queued');
      assert.equal((await context.patch('/api/preferences', { automaticRefresh: true })).status, 400);
      assert.equal((await context.state()).preferences.automaticRefresh, false);
      await context.restart();
      assert.equal((await context.state()).profile.timezone, zone);
    });
  }
});

test('valid IANA timezones retain DST-aware quiet-hour behavior', () => {
  assert.equal(timezoneAvailable('America/New_York'), true);
  assert.equal(timezoneAvailable('Invalid/Fake'), false);
  assert.equal(timezoneAvailable(''), false);
  const preferences = { quietStart: '01:00', quietEnd: '03:00' };
  assert.equal(quietHoursActive(preferences, 'America/New_York', new Date('2026-03-08T06:30:00Z')), true);
  assert.equal(quietHoursActive(preferences, 'America/New_York', new Date('2026-03-08T07:00:00Z')), false);
  assert.equal(quietHoursActive(preferences, 'Invalid/Fake'), true);
});

test('malformed legacy quiet hours preserve records and defer work until explicitly cleared or repaired', async t => {
  for (const [label, quietStart, quietEnd, repair] of [
    ['partial', '22:00', '', { quietStart: '', quietEnd: '' }],
    ['non-string', 42, '06:00', { quietStart: '22:00', quietEnd: '06:00' }],
    ['invalid time', '25:60', '06:00', { quietStart: '', quietEnd: '' }]
  ]) {
    await t.test(label, async t => {
      const context = await setup(t, 'UTC', { quietStart, quietEnd });
      await context.app.worker.tick();
      let state = await context.state();
      assert.equal(state.timezoneStatus.quietHoursInvalid, true);
      assert.equal(state.jobs.find(job => job.kind === 'task_summary').status, 'queued');
      assert.equal(state.profile.displayName, 'Synthetic owner');
      assert.equal(state.preferences.quietStart, quietStart);
      assert.equal(state.preferences.quietEnd, quietEnd);
      assert.equal((await context.patch('/api/preferences', { paused: true })).status, 200);
      assert.equal((await context.patch('/api/preferences', { paused: false, ...repair })).status, 200);
      await context.app.worker.tick();
      await context.app.worker.tick();
      state = await context.state();
      assert.equal(state.timezoneStatus.quietHoursInvalid, false);
      assert.equal(state.jobs.find(job => job.kind === 'task_summary').status, 'completed');
      assert.equal(state.profile.displayName, 'Synthetic owner');
      await context.restart();
      state = await context.state();
      assert.equal(state.preferences.quietStart, repair.quietStart);
      assert.equal(state.preferences.quietEnd, repair.quietEnd);
    });
  }
});
