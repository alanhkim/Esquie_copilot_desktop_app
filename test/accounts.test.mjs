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
