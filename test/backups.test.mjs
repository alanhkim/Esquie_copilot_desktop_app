import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, readFile, readdir, rm, appendFile, mkdir, writeFile, link, unlink, rename, rmdir, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/server.mjs';
import { createLocalBackup, recoverLocalBackup } from '../src/backups.mjs';
import { openStore } from '../src/store.mjs';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'esquie-backup-test-'));
  let now = new Date('2026-03-04T10:00:00Z');
  let app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0, verifyLocalVolume: async () => true, clock: () => now, ...options });
  t.after(async () => { await app.close(); await rm(root, { force: true, recursive: true }); });
  const state = async () => (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  const request = async (path, body, method = 'POST') => fetch(`${app.url}${path}`, {
    method, headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': (await state()).csrfToken },
    body: JSON.stringify(body)
  });
  return {
    root, get app() { return app; }, state, request,
    clock(value) { now = new Date(value); },
    async restart() {
      await app.close();
      app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0, verifyLocalVolume: async () => true, clock: () => now, ...options });
    },
    async queue(kind) {
      const response = await request('/api/jobs', { kind, requestId: randomUUID() });
      assert.equal(response.status, 202);
      return (await response.json()).job;
    }
  };
}

for (const operation of ['backup', 'recovery']) {
  test(`${operation} does not create output when approval is revoked during its final volume check`, async t => {
    let enabled = false;
    let calls = 0;
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const context = await setup(t, {
      verifyLocalVolume: async () => {
        if (enabled && ++calls === 2) { entered(); await gate; }
        return true;
      }
    });
    await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
    let backup;
    if (operation === 'recovery') {
      await context.queue('document');
      await context.app.worker.tick();
      await context.queue('backup');
      await context.app.worker.tick();
      backup = (await context.state()).backups[0];
    }
    let running;
    let id;
    if (operation === 'backup') {
      id = (await context.queue('backup')).id;
      enabled = true;
      running = context.app.worker.tick();
    } else {
      enabled = true;
      running = context.request(`/api/backups/${backup.id}/recover`, { confirmSeparateWorkspace: true });
    }
    await waiting;
    assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: false })).status, 200);
    release();
    const result = await running;
    if (operation === 'backup') {
      assert.equal((await context.state()).jobs.find(job => job.id === id).status, 'failed');
      await assert.rejects(readFile(join(context.root, 'backups', id, 'workspace.sqlite')), { code: 'ENOENT' });
    } else {
      assert.equal(result.status, 409);
      await assert.rejects(readdir(join(context.root, 'recoveries')), { code: 'ENOENT' });
      assert.equal((await context.state()).recoveries.length, 0);
    }
  });
}

test('live snapshots recover verified documents and historical state into a separate paused workspace', async t => {
  const context = await setup(t);
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: true })).status, 200);
  const task = (await (await context.request('/api/tasks', { title: 'Fake snapshot task' })).json()).task;
  assert.equal((await context.request('/api/tasks/' + task.id + '/conversation', { text: 'Fake saved note.' })).status, 201);
  assert.equal((await context.request('/api/drafts', { recipient: 'fake@example.invalid', subject: 'Fake unsent draft', body: 'Fake text only.' })).status, 201);
  await context.queue('document');
  await context.app.worker.tick();
  await context.queue('backup');
  await context.queue('task_summary');
  await context.app.worker.tick();
  const state = await context.state();
  assert.equal(state.backups.length, 1);
  const backup = state.backups[0];
  assert.equal(backup.coverage.documents.status, 'included');
  assert.equal(backup.coverage.documents.metadataCount, 1);
  assert.equal(backup.coverage.documents.includedCount, 1);
  const directory = join(context.root, 'backups', backup.id);
  const documentId = state.documents[0].id;
  const original = await readFile(join(context.root, 'documents', `${documentId}.md`));
  assert.deepEqual((await readdir(directory)).sort(), ['documents', 'manifest.json', 'workspace.sqlite']);
  assert.deepEqual(await readFile(join(directory, 'documents', `${documentId}.md`)), original);
  for (const name of ['manifest.json', 'workspace.sqlite']) assert.equal((await readFile(join(directory, name))).includes(Buffer.from(context.app.accessToken)), false);
  await context.request(`/api/tasks/${task.id}`, { title: 'Fake newer current task', revision: task.revision }, 'PATCH');
  context.clock('2026-03-05T12:00:00Z');
  const response = await context.request(`/api/backups/${backup.id}/recover`, { confirmSeparateWorkspace: true });
  assert.equal(response.status, 201);
  const recovery = (await response.json()).recovery;
  const recovered = await startServer({ dataDir: recovery.directory, port: 0, workerIntervalMs: 0 });
  try {
    const restored = await (await fetch(`${recovered.url}/api/state`, { headers: { 'X-Esquie-Access': recovered.accessToken } })).json();
    assert.equal(restored.tasks[0].title, 'Fake snapshot task');
    assert.equal(restored.conversations.some(item => item.text === 'Fake saved note.'), true);
    assert.equal(restored.drafts[0].subject, 'Fake unsent draft');
    assert.equal(restored.drafts[0].sent, false);
    assert.equal(restored.preferences.paused, true);
    assert.equal(restored.preferences.localOutputApproved, false);
    assert.equal(restored.preferences.dailyBackups, false);
    assert.equal(restored.sourceConsent, null);
    assert.equal(restored.jobs.some(job => ['queued', 'running'].includes(job.status)), false);
    const interrupted = restored.jobs.find(job => job.kind === 'task_summary');
    assert.equal(interrupted.updatedAt, recovery.createdAt);
    assert.equal(interrupted.events.at(-1).at, recovery.createdAt);
    const restoredDocument = await fetch(`${recovered.url}/api/documents/${documentId}`, { headers: { 'X-Esquie-Access': recovered.accessToken } });
    assert.equal(restoredDocument.status, 200);
    assert.equal((await restoredDocument.json()).text, original.toString('utf8'));
    assert.deepEqual(await readFile(join(recovery.directory, 'documents', `${documentId}.md`)), original);
    assert.deepEqual(await readFile(join(context.root, 'documents', `${documentId}.md`)), original);
    assert.equal((await context.state()).tasks[0].title, 'Fake newer current task');
  } finally { await recovered.close(); }
  await context.restart();
  assert.equal((await context.state()).backups[0].id, backup.id);
  assert.equal((await fetch(`${context.app.url}/api/backups/${backup.id}/recover`, {
    method: 'POST', headers: { Origin: context.app.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmSeparateWorkspace: true })
  })).status, 401);
});

test('missing recorded documents are reported and remain visibly unavailable in recovery', async t => {
  const context = await setup(t);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await context.queue('document');
  await context.app.worker.tick();
  const documentId = (await context.state()).documents[0].id;
  await unlink(join(context.root, 'documents', `${documentId}.md`));
  await context.queue('backup');
  await context.app.worker.tick();
  const backup = (await context.state()).backups[0];
  assert.equal(backup.coverage.documents.status, 'partial');
  assert.deepEqual(backup.coverage.documents.unavailable, [{ id: documentId, reason: 'Document file is missing.' }]);
  const response = await context.request(`/api/backups/${backup.id}/recover`, { confirmSeparateWorkspace: true });
  assert.equal(response.status, 201);
  const recovery = (await response.json()).recovery;
  const restored = await startServer({ dataDir: recovery.directory, port: 0, workerIntervalMs: 0 });
  try {
    const state = await (await fetch(`${restored.url}/api/state`, { headers: { 'X-Esquie-Access': restored.accessToken } })).json();
    assert.match(state.documents[0].fileUnavailableReason, /missing/i);
    assert.equal((await fetch(`${restored.url}/api/documents/${documentId}`, { headers: { 'X-Esquie-Access': restored.accessToken } })).status, 410);
  } finally { await restored.close(); }
});

test('changed or unknown source files block backup without altering them', async t => {
  const context = await setup(t);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await context.queue('document');
  await context.app.worker.tick();
  const documentId = (await context.state()).documents[0].id;
  const file = join(context.root, 'documents', `${documentId}.md`);
  const original = await readFile(file);
  await appendFile(file, 'changed');
  const changed = await readFile(file);
  await context.queue('backup');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'failed');
  assert.deepEqual(await readFile(file), changed);
  assert.equal((await context.state()).backups.length, 0);
  await writeFile(file, original);
  const unknown = join(context.root, 'documents', 'unrelated.md');
  await writeFile(unknown, 'unrelated', { mode: 0o600 });
  await context.queue('backup');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'failed');
  assert.equal(await readFile(unknown, 'utf8'), 'unrelated');
  assert.deepEqual(await readFile(file), original);
  assert.equal((await context.state()).backups.length, 0);
});

test('tampered or missing backed-up document and manifest never create a recovery or modify source artifacts', async t => {
  const context = await setup(t);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await context.queue('document');
  await context.app.worker.tick();
  await context.queue('backup');
  await context.app.worker.tick();
  const state = await context.state();
  const backup = state.backups[0];
  const folder = join(context.root, 'backups', backup.id);
  const file = join(folder, 'documents', `${state.documents[0].id}.md`);
  const original = await readFile(file);
  const source = await readFile(join(context.root, 'documents', `${state.documents[0].id}.md`));
  await appendFile(file, 'tampered');
  const tampered = await readFile(file);
  assert.equal((await context.request(`/api/backups/${backup.id}/recover`, { confirmSeparateWorkspace: true })).status, 409);
  assert.deepEqual(await readFile(file), tampered);
  await unlink(file);
  assert.equal((await context.request(`/api/backups/${backup.id}/recover`, { confirmSeparateWorkspace: true })).status, 409);
  await writeFile(file, original, { flag: 'wx', mode: 0o600 });
  const manifest = join(folder, 'manifest.json');
  await appendFile(manifest, ' ');
  const changedManifest = await readFile(manifest);
  assert.equal((await context.request(`/api/backups/${backup.id}/recover`, { confirmSeparateWorkspace: true })).status, 409);
  assert.deepEqual(await readFile(manifest), changedManifest);
  assert.deepEqual(await readFile(join(context.root, 'documents', `${state.documents[0].id}.md`)), source);
  assert.equal((await context.state()).recoveries.length, 0);
  await assert.rejects(readdir(join(context.root, 'recoveries')), { code: 'ENOENT' });
});

test('hardlinked recorded documents are refused without changing either link', async t => {
  const context = await setup(t);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await context.queue('document');
  await context.app.worker.tick();
  const file = join(context.root, 'documents', `${(await context.state()).documents[0].id}.md`);
  const alias = join(context.root, 'fake-alias');
  await link(file, alias);
  const before = await readFile(file);
  await context.queue('backup');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'failed');
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readFile(alias), before);
  assert.equal((await context.state()).backups.length, 0);
});

test('redirected document directories block backup without touching their targets', async t => {
  const context = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), 'esquie-backup-outside-'));
  t.after(() => rm(outside, { force: true, recursive: true }));
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await context.queue('document');
  await context.app.worker.tick();
  const name = `${(await context.state()).documents[0].id}.md`;
  const folder = join(context.root, 'documents');
  await rename(join(folder, name), join(outside, name));
  const before = await readFile(join(outside, name));
  await rmdir(folder);
  await symlink(outside, folder, process.platform === 'win32' ? 'junction' : 'dir');
  await context.queue('backup');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'failed');
  assert.deepEqual(await readFile(join(outside, name)), before);
  assert.deepEqual(await readdir(outside), [name]);
  assert.equal((await context.state()).backups.length, 0);
});

test('hardlinked and unknown backup artifacts prevent recovery without modifying either file', async t => {
  const context = await setup(t);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await context.queue('document');
  await context.app.worker.tick();
  await context.queue('backup');
  await context.app.worker.tick();
  const state = await context.state();
  const backup = state.backups[0];
  const folder = join(context.root, 'backups', backup.id);
  const document = join(folder, 'documents', `${state.documents[0].id}.md`);
  const alias = join(context.root, 'fake-backup-alias');
  await link(document, alias);
  const before = await readFile(document);
  assert.equal((await context.request(`/api/backups/${backup.id}/recover`, { confirmSeparateWorkspace: true })).status, 409);
  assert.deepEqual(await readFile(alias), before);
  assert.deepEqual(await readFile(document), before);
  await unlink(alias);
  const extra = join(folder, 'unrelated.txt');
  await writeFile(extra, 'leave unchanged', { mode: 0o600 });
  assert.equal((await context.request(`/api/backups/${backup.id}/recover`, { confirmSeparateWorkspace: true })).status, 409);
  assert.equal(await readFile(extra, 'utf8'), 'leave unchanged');
  assert.deepEqual(await readFile(document), before);
  await assert.rejects(readdir(join(context.root, 'recoveries')), { code: 'ENOENT' });
});

test('document records predating generation hashes are excluded and reported without reading their content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-old-documents-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const store = await openStore(root);
  try {
    const id = randomUUID();
    store.update(state => state.documents.push({ id, title: 'Old synthetic document' }));
    await mkdir(join(root, 'documents'), { mode: 0o700 });
    const original = join(root, 'documents', `${id}.md`);
    await writeFile(original, 'Old content', { mode: 0o600 });
    const backup = await createLocalBackup({ root, store, id: randomUUID(), now: new Date(), verifyOutput: async () => {}, assertOutput: () => {} });
    assert.equal(backup.coverage.documents.includedCount, 0);
    assert.equal(backup.coverage.documents.unavailable[0].id, id);
    assert.match(backup.coverage.documents.unavailable[0].reason, /no verified generation record/);
    assert.equal(await readFile(original, 'utf8'), 'Old content');
    const recovery = await recoverLocalBackup({ root, backup, now: new Date(), verifyOutput: async () => {}, assertOutput: () => {} });
    const restored = await openStore(recovery.directory);
    try { assert.match(restored.state.documents[0].fileUnavailableReason, /no verified generation record/); }
    finally { await restored.close(); }
  } finally { await store.close(); }
});

test('document size boundary accepts one MiB and refuses larger content without modifying it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-document-limit-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const store = await openStore(root);
  try {
    const id = randomUUID();
    const bytes = Buffer.alloc(1024 * 1024, 65);
    const record = content => ({
      id, title: 'Synthetic boundary', contentBytes: content.length,
      contentSha256: createHash('sha256').update(content).digest('hex')
    });
    store.update(state => state.documents.push(record(bytes)));
    await mkdir(join(root, 'documents'), { mode: 0o700 });
    const path = join(root, 'documents', `${id}.md`);
    await writeFile(path, bytes, { mode: 0o600 });
    const backup = await createLocalBackup({ root, store, id: randomUUID(), now: new Date(), verifyOutput: async () => {}, assertOutput: () => {} });
    assert.equal(backup.coverage.documents.includedCount, 1);
    const oversized = Buffer.concat([bytes, Buffer.from('A')]);
    await writeFile(path, oversized);
    store.update(state => { state.documents[0] = record(oversized); });
    const failedId = randomUUID();
    await assert.rejects(createLocalBackup({ root, store, id: failedId, now: new Date(), verifyOutput: async () => {}, assertOutput: () => {} }), /size limit/);
    assert.deepEqual(await readFile(path), oversized);
    await assert.rejects(readdir(join(root, 'backups', failedId)), { code: 'ENOENT' });
  } finally { await store.close(); }
});

test('revocation at backup file boundaries preserves source and leaves later files uncreated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-backup-boundaries-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const store = await openStore(root);
  try {
    const ids = [randomUUID(), randomUUID()];
    const content = Buffer.from('Synthetic saved Markdown');
    await mkdir(join(root, 'documents'), { mode: 0o700 });
    for (const id of ids) await writeFile(join(root, 'documents', `${id}.md`), content, { mode: 0o600 });
    store.update(state => {
      state.preferences.localOutputApproved = true;
      state.documents = ids.map(id => ({
        id, title: 'Synthetic', contentBytes: content.length,
        contentSha256: createHash('sha256').update(content).digest('hex')
      }));
    });
    for (const boundary of ['snapshot', 'first-document', 'second-document', 'manifest']) {
      store.update(state => { state.preferences.localOutputApproved = true; });
      const id = randomUUID();
      const folder = join(root, 'backups', id);
      const targets = {
        snapshot: join(folder, 'workspace.sqlite'),
        'first-document': join(folder, 'documents', `${ids[0]}.md`),
        'second-document': join(folder, 'documents', `${ids[1]}.md`),
        manifest: join(folder, 'manifest.json')
      };
      let reached = false;
      const assertOutput = path => {
        if (path === targets[boundary]) {
          reached = true;
          store.update(state => { state.preferences.localOutputApproved = false; });
        }
        if (!store.state.preferences.localOutputApproved) throw new Error('Approval revoked');
      };
      await assert.rejects(createLocalBackup({ root, store, id, now: new Date(), verifyOutput: async () => {}, assertOutput }), /Approval revoked/);
      assert.equal(reached, true);
      await assert.rejects(readFile(targets[boundary]), { code: 'ENOENT' });
      if (boundary === 'second-document' || boundary === 'manifest') {
        assert.deepEqual(await readFile(targets['first-document']), content);
      }
      if (boundary === 'manifest') assert.deepEqual(await readFile(targets['second-document']), content);
      for (const documentId of ids) assert.deepEqual(await readFile(join(root, 'documents', `${documentId}.md`)), content);
    }
  } finally { await store.close(); }
});

test('backup directory creation completes before a queued revocation can run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-backup-directory-boundary-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const store = await openStore(root);
  const target = join(root, 'backups');
  const original = fs.mkdirSync;
  const events = [];
  let approved = true;
  try {
    fs.mkdirSync = function (path, options) {
      if (path === target) events.push('mkdir');
      return original.call(this, path, options);
    };
    syncBuiltinESMExports();
    const assertOutput = path => {
      if (!approved) throw new Error('Approval revoked');
      if (path === target) {
        events.push('checked');
        queueMicrotask(() => {
          events.push(fs.existsSync(target) ? 'revoked-after-create' : 'revoked-before-create');
          approved = false;
        });
      }
    };
    const id = randomUUID();
    await assert.rejects(createLocalBackup({ root, store, id, now: new Date(), verifyOutput: async () => {}, assertOutput }), /Approval revoked/);
    assert.deepEqual(events, ['checked', 'mkdir', 'revoked-after-create']);
    await assert.rejects(readFile(join(target, id, 'workspace.sqlite')), { code: 'ENOENT' });
  } finally {
    fs.mkdirSync = original;
    syncBuiltinESMExports();
    await store.close();
  }
});

test('revocation during recovery prevents later files and leaves partial workspaces paused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-recovery-boundaries-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const store = await openStore(root);
  try {
    const ids = [randomUUID(), randomUUID()];
    const content = Buffer.from('Synthetic recovery Markdown');
    await mkdir(join(root, 'documents'), { mode: 0o700 });
    for (const id of ids) await writeFile(join(root, 'documents', `${id}.md`), content, { mode: 0o600 });
    store.update(state => {
      state.preferences.localOutputApproved = true;
      state.preferences.demoApproved = true;
      state.documents = ids.map(id => ({
        id, title: 'Synthetic', contentBytes: content.length,
        contentSha256: createHash('sha256').update(content).digest('hex')
      }));
    });
    const approved = () => {
      if (!store.state.preferences.localOutputApproved) throw new Error('Approval revoked');
    };
    const backup = await createLocalBackup({ root, store, id: randomUUID(), now: new Date(), verifyOutput: async () => {}, assertOutput: approved });
    const backupDirectory = join(root, 'backups', backup.id);
    const originalBackup = await readFile(join(backupDirectory, 'workspace.sqlite'));
    const originalManifest = await readFile(join(backupDirectory, 'manifest.json'));
    for (const boundary of ['snapshot', 'marker', 'lock', 'second-document']) {
      store.update(state => { state.preferences.localOutputApproved = true; });
      let target;
      const assertOutput = path => {
        const name = boundary === 'snapshot' ? 'workspace.sqlite'
          : boundary === 'marker' ? 'workspace.owner'
            : boundary === 'lock' ? 'workspace.lock' : `${ids[1]}.md`;
        if (path.endsWith(`\\${name}`) || path.endsWith(`/${name}`)) {
          target = path;
          store.update(state => { state.preferences.localOutputApproved = false; });
        }
        approved();
      };
      await assert.rejects(recoverLocalBackup({ root, backup, now: new Date(), verifyOutput: async () => {}, assertOutput }), /Approval revoked/);
      assert.ok(target, `did not reach ${boundary}`);
      await assert.rejects(readFile(target), { code: 'ENOENT' });
      if (boundary === 'second-document') {
        const destination = join(target, '..', '..');
        assert.deepEqual(await readFile(join(destination, 'documents', `${ids[0]}.md`)), content);
        const partial = await openStore(destination);
        try {
          assert.equal(partial.state.preferences.paused, true);
          assert.equal(partial.state.preferences.localOutputApproved, false);
          assert.equal(partial.state.preferences.demoApproved, false);
          assert.ok(partial.state.documents.every(document => document.fileUnavailableReason));
        } finally { await partial.close(); }
      }
      assert.deepEqual(await readFile(join(backupDirectory, 'workspace.sqlite')), originalBackup);
      assert.deepEqual(await readFile(join(backupDirectory, 'manifest.json')), originalManifest);
      for (const id of ids) {
        assert.deepEqual(await readFile(join(root, 'documents', `${id}.md`)), content);
        assert.deepEqual(await readFile(join(backupDirectory, 'documents', `${id}.md`)), content);
      }
    }
  } finally { await store.close(); }
});

test('older state-only snapshots recover with document files marked unavailable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-legacy-backup-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const store = await openStore(root);
  const documentId = randomUUID();
  store.update(state => state.documents.push({ id: documentId, title: 'Old synthetic document' }));
  const id = randomUUID();
  const directory = join(root, 'backups', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const snapshot = join(directory, 'workspace.sqlite');
  await store.snapshot(snapshot);
  const bytes = await readFile(snapshot);
  const backup = {
    id, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    coverage: { documents: { status: 'not-included', metadataCount: 1 } }
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(backup), { mode: 0o600 });
  const recovery = await recoverLocalBackup({ root, backup, now: new Date(), verifyOutput: async () => {}, assertOutput: () => {} });
  const restored = await openStore(recovery.directory);
  try {
    assert.equal(restored.state.preferences.paused, true);
    assert.match(restored.state.documents[0].fileUnavailableReason, /state-only/);
    assert.deepEqual(await readdir(directory), ['manifest.json', 'workspace.sqlite']);
  } finally { await restored.close(); await store.close(); }
});

test('daily backup attempts respect quiet hours, pause, restart and failures without repeated daily writes or pruning', async t => {
  const context = await setup(t);
  await context.request('/api/profile', { timezone: 'UTC' }, 'PATCH');
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  await context.request('/api/preferences', { dailyBackups: true, quietStart: '09:00', quietEnd: '11:00' }, 'PATCH');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs.length, 0);
  context.clock('2026-03-04T12:00:00Z');
  await context.app.worker.tick();
  assert.equal((await context.state()).backups.length, 1);
  await context.restart();
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs.length, 1);
  context.clock('2026-03-05T12:00:00Z');
  await context.request('/api/preferences', { paused: true }, 'PATCH');
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs.length, 1);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: false });
  await context.request('/api/preferences', { paused: false }, 'PATCH');
  await context.app.worker.tick();
  await context.app.worker.tick();
  const state = await context.state();
  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.backups.length, 1);
  assert.equal((await readdir(join(context.root, 'backups'))).length, 1);
});

test('corrupt backups and pre-existing destinations fail closed without overwriting or deleting anything', async t => {
  const context = await setup(t);
  await context.request('/api/output-approval', { confirmPrivateNonSynced: true });
  const blocked = await context.queue('backup');
  const directory = join(context.root, 'backups', blocked.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'owner-file.txt'), 'Fake owner file to preserve.', { mode: 0o600 });
  await context.app.worker.tick();
  assert.equal((await context.state()).jobs[0].status, 'failed');
  assert.equal(await readFile(join(directory, 'owner-file.txt'), 'utf8'), 'Fake owner file to preserve.');
  await context.queue('backup');
  await context.app.worker.tick();
  const backup = (await context.state()).backups[0];
  const snapshot = join(context.root, 'backups', backup.id, 'workspace.sqlite');
  await appendFile(snapshot, 'Fake corruption.');
  const before = await readFile(snapshot);
  assert.equal((await context.request(`/api/backups/${backup.id}/recover`, { confirmSeparateWorkspace: true })).status, 409);
  assert.equal((await readFile(snapshot)).equals(before), true);
  assert.equal((await context.state()).recoveries.length, 0);
});
