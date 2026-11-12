import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/server.mjs';
import { matchesAccountSearch } from '../public/account-search.mjs';

async function workspace(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-accounts-'));
  let app = await startServer({ dataDir, port: 0 });
  const initialState = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  const context = { app, dataDir, csrfToken: initialState.csrfToken };
  t.after(async () => {
    if (context.app) await context.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  context.request = (path, { method = 'GET', body } = {}) => fetch(`${context.app.url}${path}`, {
    method,
    headers: {
      'X-Esquie-Access': context.app.accessToken,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET' ? {} : { Origin: context.app.url, 'X-Esquie-CSRF': context.csrfToken })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  context.restart = async () => {
    await context.app.close();
    app = await startServer({ dataDir, port: 0 });
    context.app = app;
    const state = await (await context.request('/api/state')).json();
    context.csrfToken = state.csrfToken;
    return state;
  };
  context.state = async () => (await context.request('/api/state')).json();
  return context;
}

test('owner-entered exact metrics preserve account identity, zero/unknown and history through edits, replay and restart', async t => {
  const context = await workspace(t);
  const create = async () => (await (await context.request('/api/records', {
    method: 'POST', body: { category: 'account', title: 'Identical synthetic label', note: 'Retain existing context', plan: 'Owner plan' }
  })).json()).record;
  const first = await create();
  const second = await create();
  assert.notEqual(first.id, second.id);
  const body = { label: 'My sample count', value: '0', unit: '', date: '', revision: first.revision, requestId: randomUUID(), confirmOwnerEntered: true };
  const add = await context.request(`/api/records/${first.id}/metrics`, { method: 'POST', body });
  assert.equal(add.status, 201);
  const saved = await add.json();
  assert.equal(saved.metric.value, '0', 'zero is present, never treated as missing');
  assert.equal(saved.metric.date, '', 'an observation date is not invented');
  assert.ok(saved.metric.createdAt);
  assert.equal(saved.metric.provenance, 'owner-provided-unverified');
  assert.equal(saved.record.note, first.note);
  assert.equal(saved.record.plan, first.plan);
  assert.deepEqual(saved.record.history, first.history);
  let state = await context.restart();
  assert.equal((state.records.find(record => record.id === second.id).metrics || []).length, 0, 'matching names never imply association');
  assert.deepEqual(state.records.find(record => record.id === first.id).metrics, [saved.metric]);
  const edited = await context.request(`/api/records/${first.id}`, { method: 'PATCH', body: {
    category: 'account', title: 'Renamed exact account', revision: saved.record.revision, note: 'New owner context'
  } });
  assert.equal(edited.status, 200);
  const current = (await edited.json()).record;
  const replay = await context.request(`/api/records/${first.id}/metrics`, { method: 'POST', body });
  assert.equal(replay.status, 201);
  const repeated = await replay.json();
  assert.equal(repeated.deduplicated, true);
  assert.deepEqual(repeated.metric, saved.metric);
  assert.deepEqual(repeated.record, current, 'replay must not overwrite newer edits');
  assert.equal((await context.request(`/api/records/${second.id}/metrics`, { method: 'POST', body })).status, 409);
  assert.equal((await context.request(`/api/records/${first.id}/metrics`, { method: 'POST', body: { ...body, value: '1' } })).status, 409);
  const precise = { ...body, revision: current.revision, requestId: randomUUID(), value: '123456789012345678901234.123456789012', date: '2026-02-28' };
  const exact = await (await context.request(`/api/records/${first.id}/metrics`, { method: 'POST', body: precise })).json();
  assert.equal(exact.metric.value, precise.value, 'no floating point conversion or rounding');
  state = await context.restart();
  assert.deepEqual(state.records.find(record => record.id === first.id).metrics, [saved.metric, exact.metric]);
});

test('metric HTTP validation rejects forged, unknown, wrong-category, stale and unconfirmed exact duplicates atomically', async t => {
  const context = await workspace(t);
  const create = async category => (await (await context.request('/api/records', { method: 'POST', body: { category, title: 'Synthetic validation target' } })).json()).record;
  const account = await create('account');
  const outcome = await create('outcome');
  const body = { label: '<img onerror="fakeCommand()">', value: '-0.00', unit: 'My units', date: '', revision: account.revision, requestId: randomUUID(), confirmOwnerEntered: true };
  const path = `/api/records/${account.id}/metrics`;
  const before = await context.state();
  for (const change of [
    { value: 0 }, { value: '' }, { value: 'NaN' }, { value: 'Infinity' }, { value: '1e3' }, { value: '01' },
    { value: '1'.repeat(25) }, { value: `0.${'1'.repeat(13)}` }, { label: '' }, { label: 'x'.repeat(101) },
    { unit: 'x'.repeat(41) }, { date: '2026-02-30' }, { requestId: 'bad' }, { revision: '1' },
    { revision: -1 }, { confirmOwnerEntered: false }, { verified: true }
  ]) {
    assert.equal((await context.request(path, { method: 'POST', body: { ...body, ...change } })).status, 400, JSON.stringify(change));
  }
  for (const id of [randomUUID(), outcome.id]) {
    assert.equal((await context.request(`/api/records/${id}/metrics`, { method: 'POST', body })).status, 404);
  }
  assert.equal((await fetch(`${context.app.url}${path}`, { method: 'POST', headers: { Origin: context.app.url, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
  assert.equal((await fetch(`${context.app.url}${path}`, { method: 'POST', headers: { Origin: context.app.url, 'X-Esquie-Access': context.app.accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
  assert.deepEqual((await context.state()).records, before.records);
  const saved = await (await context.request(path, { method: 'POST', body })).json();
  const after = await context.state();
  assert.equal((await context.request(path, { method: 'POST', body: { ...body, requestId: randomUUID() } })).status, 409);
  assert.equal((await context.request(path, { method: 'POST', body: { ...body, revision: saved.record.revision, requestId: randomUUID() } })).status, 409);
  assert.deepEqual((await context.state()).records, after.records);
  assert.equal((await context.request(path, { method: 'POST', body: { ...body, value: '0', revision: saved.record.revision, requestId: randomUUID() } })).status, 201, 'different exact strings are distinct, including negative zero scale');
});

test('metric precision and separately confirmed identical observations survive replay, restart and later edits without collapsing history', async t => {
  const context = await workspace(t);
  const account = (await (await context.request('/api/records', { method: 'POST', body: { category: 'account', title: 'Synthetic precision account' } })).json()).record;
  const path = `/api/records/${account.id}/metrics`;
  const base = { label: 'My sample', value: '1.0', unit: 'My units', date: '2026-03-01', revision: account.revision, requestId: randomUUID(), confirmOwnerEntered: true };
  const first = await (await context.request(path, { method: 'POST', body: base })).json();
  const preciseBody = { ...base, value: '1.00', revision: first.record.revision, requestId: randomUUID() };
  const secondResponse = await context.request(path, { method: 'POST', body: preciseBody });
  assert.equal(secondResponse.status, 201);
  const second = await secondResponse.json();
  assert.deepEqual(second.record.metrics.map(metric => metric.value), ['1.0', '1.00']);
  const repeatBody = { ...preciseBody, revision: second.record.revision, requestId: randomUUID(), duplicateOf: second.metric.id, confirmSeparateObservation: true };
  const withoutChoice = await context.request(path, { method: 'POST', body: { ...repeatBody, duplicateOf: '', confirmSeparateObservation: false } });
  assert.equal(withoutChoice.status, 409);
  const duplicateError = (await withoutChoice.json()).error;
  assert.match(duplicateError, new RegExp(second.metric.id));
  assert.match(duplicateError, /1\.00/);
  assert.equal((await context.request(path, { method: 'POST', body: { ...repeatBody, duplicateOf: first.metric.id } })).status, 409);
  assert.equal((await context.request(path, { method: 'POST', body: { ...repeatBody, confirmSeparateObservation: false } })).status, 400);
  assert.equal((await context.request(path, { method: 'POST', body: { ...repeatBody, duplicateOf: '' } })).status, 400);
  const confirmedResponse = await context.request(path, { method: 'POST', body: repeatBody });
  assert.equal(confirmedResponse.status, 201);
  const confirmed = await confirmedResponse.json();
  assert.notEqual(confirmed.metric.id, second.metric.id);
  assert.equal(confirmed.metric.duplicateOf, second.metric.id);
  assert.equal(confirmed.metric.confirmSeparateObservation, true);
  assert.deepEqual(confirmed.record.metrics.slice(0, -1), second.record.metrics);
  assert.deepEqual(confirmed.record.metrics.map(metric => metric.value), ['1.0', '1.00', '1.00']);
  assert.equal((await context.request(path, { method: 'POST', body: { ...repeatBody, requestId: randomUUID() } })).status, 409, 'review choice is revision-bound');
  assert.equal((await context.request(path, { method: 'POST', body: { ...repeatBody, duplicateOf: '', confirmSeparateObservation: false } })).status, 409, 'replay identity includes the repeat choice');
  await context.restart();
  const replay = await (await context.request(path, { method: 'POST', body: repeatBody })).json();
  assert.equal(replay.deduplicated, true);
  assert.deepEqual(replay.metric, confirmed.metric);
  assert.deepEqual(replay.record.metrics, confirmed.record.metrics);
  const edited = await (await context.request(`/api/records/${account.id}`, { method: 'PATCH', body: {
    category: 'account', title: 'Later owner edit', revision: replay.record.revision
  } })).json();
  await context.restart();
  const afterEditReplay = await (await context.request(path, { method: 'POST', body: repeatBody })).json();
  assert.deepEqual(afterEditReplay.record, edited.record);
  assert.deepEqual(afterEditReplay.metric, confirmed.metric);
});

test('concurrent metric adds honor one displayed revision and identical request IDs never append twice', async t => {
  const context = await workspace(t);
  const account = (await (await context.request('/api/records', { method: 'POST', body: { category: 'account', title: 'Synthetic concurrent account' } })).json()).record;
  const path = `/api/records/${account.id}/metrics`;
  const body = { label: 'My observation', value: '2', unit: '', date: '', revision: account.revision, requestId: randomUUID(), confirmOwnerEntered: true };
  const responses = await Promise.all([context.request(path, { method: 'POST', body }), context.request(path, { method: 'POST', body })]);
  assert.deepEqual(responses.map(response => response.status), [201, 201]);
  const receipts = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(receipts[0].metric, receipts[1].metric);
  const accountAfter = (await context.state()).records[0];
  assert.equal(accountAfter.metrics.length, 1);
  const changes = await Promise.all(['3', '4'].map(value => context.request(path, {
    method: 'POST', body: { ...body, value, revision: accountAfter.revision, requestId: randomUUID() }
  })));
  assert.deepEqual(changes.map(response => response.status).sort(), [201, 409]);
  assert.equal((await context.restart()).records[0].metrics.length, 2);
});

test('metric history limit preserves all prior observations and legacy fields', async t => {
  const context = await workspace(t);
  const account = (await (await context.request('/api/records', { method: 'POST', body: { category: 'account', title: 'Synthetic bounded history', note: 'Keep legacy text' } })).json()).record;
  await context.app.close();
  const database = new DatabaseSync(join(context.dataDir, 'workspace.sqlite'));
  const state = JSON.parse(database.prepare('SELECT body FROM workspace WHERE id=1').get().body);
  state.records[0].metrics = Array.from({ length: 200 }, (_, index) => ({
    id: randomUUID(), requestId: randomUUID(), label: `Synthetic sample ${index}`, value: String(index), unit: '', date: '', provenance: 'owner-provided-unverified'
  }));
  database.prepare('UPDATE workspace SET body=? WHERE id=1').run(JSON.stringify(state));
  database.close();
  context.app = await startServer({ dataDir: context.dataDir, port: 0 });
  context.csrfToken = (await context.state()).csrfToken;
  const response = await context.request(`/api/records/${account.id}/metrics`, { method: 'POST', body: {
    label: 'Another sample', value: '1', revision: account.revision, requestId: randomUUID(), confirmOwnerEntered: true
  } });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /200 metric/);
  const persisted = (await context.restart()).records[0];
  assert.equal(persisted.metrics.length, 200);
  assert.deepEqual(persisted.metrics, state.records[0].metrics);
  assert.equal(persisted.note, account.note);
});

test('SSP IDs and explicit account selections persist, keep duplicate labels distinct and replay without overwriting newer edits', async t => {
  const context = await workspace(t);
  const accounts = [];
  for (let index = 0; index < 2; index++) accounts.push((await (await context.request('/api/records', {
    method: 'POST', body: { category: 'account', title: 'Identical synthetic account' }
  })).json()).record);
  const id = randomUUID();
  const path = `/api/portfolio/ssps/${id}`;
  const body = { title: '<img onerror="fakeCommand()"> SSP label', accountIds: [accounts[0].id], revision: 0, requestId: randomUUID(), confirmOwnerEntered: true };
  const created = await context.request(path, { method: 'POST', body });
  assert.equal(created.status, 201);
  const first = await created.json();
  assert.equal(first.record.id, id);
  assert.deepEqual(first.record.accountIds, [accounts[0].id]);
  assert.equal(first.receipt.provenance, 'owner-provided-unverified');
  const otherId = randomUUID();
  assert.equal((await context.request(`/api/portfolio/ssps/${otherId}`, {
    method: 'POST', body: { ...body, requestId: randomUUID(), accountIds: [] }
  })).status, 201, 'identical labels do not imply identical people or records');
  assert.equal((await context.request(`/api/records/${id}`, { method: 'PATCH', body: { category: 'ssp', title: 'Bypass', revision: 1 } })).status, 400);
  const edit = { ...body, title: 'Owner revised local label', accountIds: [accounts[1].id], revision: 1, requestId: randomUUID() };
  const second = await (await context.request(path, { method: 'POST', body: edit })).json();
  assert.deepEqual(second.record.history.slice(0, -1), first.record.history);
  assert.equal(second.record.revision, 2);
  const replay = await (await context.request(path, { method: 'POST', body })).json();
  assert.equal(replay.deduplicated, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.deepEqual(replay.record, second.record);
  assert.equal((await context.request(path, { method: 'POST', body: { ...body, requestId: randomUUID() } })).status, 409);
  assert.equal((await context.request(`/api/portfolio/ssps/${otherId}`, { method: 'POST', body })).status, 409);
  const state = await context.restart();
  assert.deepEqual(state.records.find(record => record.id === id), second.record);
  assert.equal(state.records.find(record => record.id === otherId).accountIds.length, 0);
  const afterRestart = await (await context.request(path, { method: 'POST', body: edit })).json();
  assert.equal(afterRestart.deduplicated, true);
  assert.deepEqual(afterRestart.record, second.record);
});

test('SSP validation and concurrent revisions reject forged links and never silently merge or overwrite', async t => {
  const context = await workspace(t);
  const create = async category => (await (await context.request('/api/records', { method: 'POST', body: { category, title: 'Synthetic local record' } })).json()).record;
  const account = await create('account');
  const outcome = await create('outcome');
  const id = randomUUID();
  const path = `/api/portfolio/ssps/${id}`;
  const body = { title: 'Owner SSP label', accountIds: [account.id], revision: 0, requestId: randomUUID(), confirmOwnerEntered: true };
  const before = await context.state();
  for (const fields of [
    { accountIds: [randomUUID()] }, { accountIds: [outcome.id] }, { accountIds: ['Synthetic local record'] },
    { accountIds: [account.id, account.id] }, { accountIds: 'all' }, { accountIds: Array(51).fill(account.id) },
    { requestId: [randomUUID()] }, { revision: '0' }, { title: '' }, { title: 'x'.repeat(101) },
    { confirmOwnerEntered: false }, { verifiedIdentity: true }
  ]) {
    assert.equal((await context.request(path, { method: 'POST', body: { ...body, ...fields } })).status, 400);
  }
  assert.deepEqual((await context.state()).records, before.records);
  const simultaneous = await Promise.all([context.request(path, { method: 'POST', body }), context.request(path, { method: 'POST', body })]);
  assert.deepEqual(simultaneous.map(response => response.status), [201, 201]);
  const edits = await Promise.all(['One', 'Two'].map(title => context.request(path, {
    method: 'POST', body: { ...body, title, revision: 1, requestId: randomUUID() }
  })));
  assert.deepEqual(edits.map(response => response.status).sort(), [201, 409]);
  const record = (await context.state()).records.find(item => item.id === id);
  assert.equal(record.history.length, 2);
  assert.equal(record.revision, 2);
  assert.equal((await context.request(`/api/portfolio/ssps/${account.id}`, { method: 'POST', body: { ...body, requestId: randomUUID() } })).status, 409);
  assert.equal((await context.request(path, { method: 'POST', body: { ...body, title: 'Changed intent' } })).status, 409);
});

test('SSP directory and append-only history bounds retain existing records at their exact limits', async t => {
  const context = await workspace(t);
  const id = randomUUID();
  const body = { title: 'Synthetic SSP', accountIds: [], revision: 0, requestId: randomUUID(), confirmOwnerEntered: true };
  await context.request(`/api/portfolio/ssps/${id}`, { method: 'POST', body });
  await context.app.close();
  const database = new DatabaseSync(join(context.dataDir, 'workspace.sqlite'));
  const state = JSON.parse(database.prepare('SELECT body FROM workspace WHERE id=1').get().body);
  const original = state.records[0];
  original.history = Array.from({ length: 100 }, () => ({ ...original.history[0], id: randomUUID(), requestId: randomUUID() }));
  for (let index = 1; index < 200; index++) state.records.push({ ...original, id: randomUUID(), history: [{ ...original.history[0], requestId: randomUUID() }] });
  database.prepare('UPDATE workspace SET body=? WHERE id=1').run(JSON.stringify(state));
  database.close();
  context.app = await startServer({ dataDir: context.dataDir, port: 0 });
  context.csrfToken = (await context.state()).csrfToken;
  const fullHistory = await context.request(`/api/portfolio/ssps/${id}`, { method: 'POST', body: { ...body, revision: 1, requestId: randomUUID() } });
  assert.equal(fullHistory.status, 409);
  assert.match((await fullHistory.json()).error, /100 saves/);
  const fullDirectory = await context.request(`/api/portfolio/ssps/${randomUUID()}`, { method: 'POST', body: { ...body, requestId: randomUUID() } });
  assert.equal(fullDirectory.status, 409);
  assert.match((await fullDirectory.json()).error, /200 records/);
  assert.deepEqual((await context.restart()).records, state.records);
});
test('upgrades legacy account records without dropping the prior note', async t => {
  const context = await workspace(t);
  const legacy = {
    id: randomUUID(),
    category: 'account',
    title: 'Fictional legacy account',
    note: 'Keep this existing local context.',
    revision: 1,
    provenance: 'owner-provided-unverified',
    createdAt: '2026-01-02T03:04:05.000Z'
  };
  await context.app.close();
  const database = new DatabaseSync(join(context.dataDir, 'workspace.sqlite'));
  const body = JSON.parse(database.prepare('SELECT body FROM workspace WHERE id=1').get().body);
  body.records.push(legacy);
  database.prepare('UPDATE workspace SET body=? WHERE id=1').run(JSON.stringify(body));
  database.close();
  context.app = await startServer({ dataDir: context.dataDir, port: 0 });
  context.csrfToken = (await context.state()).csrfToken;

  const state = await context.state();
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].note, legacy.note);
  assert.equal(state.records[0].plan, '');
  assert.equal(state.records[0].stakeholders, '');
  assert.deepEqual(state.records[0].history, []);

  const edited = await context.request(`/api/records/${legacy.id}`, {
    method: 'PATCH',
    body: {
      category: 'account',
      title: legacy.title,
      note: legacy.note,
      plan: 'Fictional local plan.',
      stakeholders: 'Fictional person — explicitly owner-entered.',
      revision: state.records[0].revision
    }
  });
  assert.equal(edited.status, 200);
  const persisted = await context.restart();
  assert.equal(persisted.records[0].plan, 'Fictional local plan.');
  assert.equal(persisted.records[0].stakeholders, 'Fictional person — explicitly owner-entered.');
  assert.equal(persisted.records[0].note, legacy.note);
});

test('account edits and append-only notes require the current revision', async t => {
  const context = await workspace(t);
  const response = await context.request('/api/records', {
    method: 'POST',
    body: {
      category: 'account',
      title: 'Example account',
      note: 'Manual context.',
      plan: 'Owner-authored plan.',
      stakeholders: 'Name and role explicitly entered by owner.'
    }
  });
  assert.equal(response.status, 201);
  const { record } = await response.json();
  assert.deepEqual(record.history, []);

  const notePath = `/api/records/${record.id}/notes`;
  const unauthorizedHeaders = { 'Content-Type': 'application/json', Origin: context.app.url, 'X-Esquie-CSRF': context.csrfToken };
  const noteBody = JSON.stringify({ text: 'Not authorized.', revision: record.revision });
  assert.equal((await fetch(`${context.app.url}${notePath}`, {
    method: 'POST', headers: unauthorizedHeaders, body: noteBody
  })).status, 401);
  assert.equal((await fetch(`${context.app.url}${notePath}`, {
    method: 'POST',
    headers: { ...unauthorizedHeaders, 'X-Esquie-Access': context.app.accessToken, 'X-Esquie-CSRF': '' },
    body: noteBody
  })).status, 403);

  const edited = await context.request(`/api/records/${record.id}`, {
    method: 'PATCH',
    body: { category: 'account', title: 'Example account updated', plan: 'Revised plan.', revision: record.revision }
  });
  assert.equal(edited.status, 200);
  const updated = (await edited.json()).record;
  assert.equal(updated.stakeholders, record.stakeholders);
  assert.equal(updated.note, record.note);

  const staleEdit = await context.request(`/api/records/${record.id}`, {
    method: 'PATCH',
    body: { category: 'account', title: 'Stale overwrite', revision: record.revision }
  });
  assert.equal(staleEdit.status, 409);

  const noteResponse = await context.request(notePath, {
    method: 'POST',
    body: { text: 'Follow-up note.', revision: updated.revision }
  });
  assert.equal(noteResponse.status, 201);
  const { record: noted } = await noteResponse.json();
  assert.equal(noted.history.length, 1);
  assert.equal(noted.history[0].text, 'Follow-up note.');
  assert.equal(noted.history[0].provenance, 'owner-provided-unverified');

  const staleNote = await context.request(notePath, {
    method: 'POST',
    body: { text: 'Stale note.', revision: updated.revision }
  });
  assert.equal(staleNote.status, 409);
  const persisted = await context.restart();
  assert.equal(persisted.records[0].history.length, 1);
  assert.equal(persisted.records[0].history[0].text, 'Follow-up note.');
});

test('account search checks only each local record and its explicitly entered text', () => {
  const account = {
    title: 'Fictional account',
    note: 'Existing manual context',
    plan: 'Renew the fictional pilot',
    stakeholders: 'Alex Example — owner-entered contact',
    history: [{ text: 'Follow up about the workshop' }]
  };
  assert.equal(matchesAccountSearch(account, 'FICTIONAL'), true);
  assert.equal(matchesAccountSearch(account, 'pilot'), true);
  assert.equal(matchesAccountSearch(account, 'alex example'), true);
  assert.equal(matchesAccountSearch(account, 'workshop'), true);
  assert.equal(matchesAccountSearch(account, 'unrelated account'), false);
  assert.equal(matchesAccountSearch({ title: account.title }, ''), true);
});

test('untrusted account text remains literal in saved state', async t => {
  const context = await workspace(t);
  const markup = '<img src=x onerror=alert(1)>';
  const created = await context.request('/api/records', {
    method: 'POST',
    body: { category: 'account', title: markup, note: '<script>not executable</script>' }
  });
  assert.equal(created.status, 201);
  const { record } = await created.json();
  assert.equal(record.title, markup);
  assert.equal(record.note, '<script>not executable</script>');
});

test('account payload limit accepts maximum multibyte fields and rejects oversized requests', async t => {
  const context = await workspace(t);
  const emoji = '🧪';
  const field = emoji.repeat(2000);
  const payload = {
    category: 'account',
    title: emoji.repeat(80),
    note: field,
    plan: field,
    stakeholders: field
  };
  assert.equal(payload.title.length, 160);
  assert.equal(payload.note.length, 4000);
  assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') > 20_000);
  const created = await context.request('/api/records', { method: 'POST', body: payload });
  assert.equal(created.status, 201);
  const { record } = await created.json();
  assert.equal(record.note, field);
  assert.equal(record.plan, field);
  assert.equal(record.stakeholders, field);

  const patch = {
    category: 'account',
    title: emoji.repeat(80),
    note: field,
    plan: field,
    stakeholders: field,
    revision: record.revision
  };
  assert.ok(Buffer.byteLength(JSON.stringify(patch), 'utf8') > 20_000);
  const updated = await context.request(`/api/records/${record.id}`, { method: 'PATCH', body: patch });
  assert.equal(updated.status, 200);

  const longNote = `x${'\u0001'.repeat(3999)}`;
  assert.equal(longNote.length, 4000);
  assert.ok(Buffer.byteLength(JSON.stringify({ text: longNote }), 'utf8') > 20_000);
  const appended = await context.request(`/api/records/${record.id}/notes`, {
    method: 'POST',
    body: { text: longNote, revision: (await updated.json()).record.revision }
  });
  assert.equal(appended.status, 201);
  assert.equal((await appended.json()).entry.text, 'x');

  const tooLongField = await context.request('/api/records', {
    method: 'POST',
    body: { category: 'account', title: 'Too long', plan: 'x'.repeat(4001) }
  });
  assert.equal(tooLongField.status, 400);

  const oversized = { category: 'account', title: 'Oversized', plan: '\u0001'.repeat(14_000) };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > 80_000);
  assert.equal((await context.request('/api/records', { method: 'POST', body: oversized })).status, 413);
});
