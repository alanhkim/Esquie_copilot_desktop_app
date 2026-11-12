import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { link, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { adoptLegacyWorkspace, newWorkspace, openStore } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';

const execute = promisify(execFile);
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'esquie-ownership-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('workspace ownership persists across Node runtimes', async t => {
  const alternate = process.env.ESQUIE_TEST_OTHER_NODE;
  if (!alternate) return t.skip('Set ESQUIE_TEST_OTHER_NODE to a second Node executable.');
  const moduleUrl = new URL('../src/store.mjs', import.meta.url).href;
  const runOther = async root => execute(alternate, ['--input-type=module', '-e',
    `const { openStore } = await import(process.argv[2]); const store = await openStore(process.argv[1]); store.update(state => { state.profile.displayName = 'Synthetic other runtime'; }); await store.close();`,
    root, moduleUrl]);
  const first = await directory(t);
  let store = await openStore(first);
  await store.close();
  await runOther(first);
  store = await openStore(first);
  assert.equal(store.state.profile.displayName, 'Synthetic other runtime');
  await store.close();
  const second = await directory(t);
  await runOther(second);
  store = await openStore(second);
  assert.equal(store.state.profile.displayName, 'Synthetic other runtime');
  await store.close();
});

test('unrelated version-one database is unchanged and no lock or schema is created', async t => {
  const root = await directory(t);
  const path = join(root, 'workspace.sqlite');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('fake'); PRAGMA user_version=1;");
  db.close();
  const before = await readFile(path);
  await assert.rejects(startServer({ dataDir: root, port: 0 }), /ownership is not established/);
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readdir(root), ['workspace.sqlite']);
});

test('spoofed application ID with unrelated schema is never opened or changed', async t => {
  const fixture = await directory(t);
  const fakePath = join(fixture, 'fake.sqlite');
  const db = new DatabaseSync(fakePath);
  db.exec('CREATE TABLE unrelated (value TEXT); PRAGMA application_id=1163088213; PRAGMA user_version=1; PRAGMA journal_mode=WAL;');
  db.close();
  const fake = await readFile(fakePath);
  for (const withExistingMarker of [false, true]) {
    const root = await directory(t);
    if (withExistingMarker) {
      const store = await openStore(root);
      await store.close();
    }
    await writeFile(join(root, 'workspace.sqlite'), fake);
    if (withExistingMarker) {
      const markerPath = join(root, 'workspace.owner');
      const marker = JSON.parse(await readFile(markerPath, 'utf8'));
      marker.schema = createHash('sha256').update(fake.subarray(100, 4096)).digest('hex');
      await writeFile(markerPath, JSON.stringify(marker));
    }
    const names = (await readdir(root)).sort();
    const bytes = await Promise.all(names.map(name => readFile(join(root, name))));
    const changes = [];
    const watcher = watch(root, (_event, name) => changes.push(String(name)));
    try {
      await assert.rejects(startServer({ dataDir: root, port: 0 }), /ownership is not established/);
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally { watcher.close(); }
    assert.deepEqual(changes.filter(name => /workspace\.(?:lock|sqlite)/.test(name)), []);
    assert.deepEqual((await readdir(root)).sort(), names);
    assert.deepEqual(await Promise.all(names.map(name => readFile(join(root, name)))), bytes);
  }
});

test('a schema change in WAL is rejected before locking or modifying sidecars', async t => {
  const root = await directory(t);
  const store = await openStore(root);
  await store.close();
  const db = new DatabaseSync(join(root, 'workspace.sqlite'));
  try {
    db.exec('PRAGMA wal_autocheckpoint=0; CREATE TABLE unrelated (value TEXT);');
    const names = (await readdir(root)).sort();
    const before = await Promise.all(names.map(name => readFile(join(root, name))));
    const changes = [];
    const watcher = watch(root, (_event, name) => changes.push(String(name)));
    try {
      await assert.rejects(startServer({ dataDir: root, port: 0 }), /ownership is not established/);
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally { watcher.close(); }
    assert.deepEqual(changes.filter(name => /workspace\.(?:lock|sqlite)/.test(name)), []);
    assert.deepEqual((await readdir(root)).sort(), names);
    assert.deepEqual(await Promise.all(names.map(name => readFile(join(root, name)))), before);
  } finally { db.close(); }
});

test('owned workspaces retain committed state still in WAL during restart', async t => {
  const root = await directory(t);
  let store = await openStore(root);
  await store.close();
  const db = new DatabaseSync(join(root, 'workspace.sqlite'));
  try {
    db.exec('PRAGMA wal_autocheckpoint=0;');
    const state = JSON.parse(db.prepare('SELECT body FROM workspace WHERE id=1').get().body);
    for (let index = 0; index < 3; index++) {
      state.tasks.push({ id: randomUUID(), title: `Synthetic WAL task ${index}`, status: 'next' });
      db.prepare('UPDATE workspace SET body=? WHERE id=1').run(JSON.stringify(state));
    }
    store = await openStore(root);
    assert.equal(store.state.tasks.at(-1).title, 'Synthetic WAL task 2');
    await store.close();
  } finally { db.close(); }
  store = await openStore(root);
  assert.equal(store.state.tasks.at(-1).title, 'Synthetic WAL task 2');
  await store.close();
});

test('a valid WAL with the opposite checksum byte order retains committed state', async t => {
  const root = await directory(t);
  let store = await openStore(root);
  await store.close();
  const path = join(root, 'workspace.sqlite');
  const base = await readFile(path);
  const db = new DatabaseSync(path);
  let wal;
  try {
    db.exec('PRAGMA wal_autocheckpoint=0;');
    const state = JSON.parse(db.prepare('SELECT body FROM workspace WHERE id=1').get().body);
    state.tasks.push({ id: randomUUID(), title: 'Synthetic alternate-byte-order WAL', status: 'next' });
    db.prepare('UPDATE workspace SET body=? WHERE id=1').run(JSON.stringify(state));
    wal = await readFile(path + '-wal');
  } finally { db.close(); }
  assert.ok(wal.length >= 32 + 24 + 4096);
  const oldMagic = wal.readUInt32BE(0);
  assert.ok([0x377f0682, 0x377f0683].includes(oldMagic));
  const magic = oldMagic === 0x377f0682 ? 0x377f0683 : 0x377f0682;
  wal.writeUInt32BE(magic, 0);
  let s0 = 0;
  let s1 = 0;
  const checksum = data => {
    for (let offset = 0; offset < data.length; offset += 8) {
      const read = magic === 0x377f0682 ? 'readUInt32LE' : 'readUInt32BE';
      s0 = (s0 + data[read](offset) + s1) >>> 0;
      s1 = (s1 + data[read](offset + 4) + s0) >>> 0;
    }
  };
  checksum(wal.subarray(0, 24));
  wal.writeUInt32BE(s0, 24);
  wal.writeUInt32BE(s1, 28);
  for (let offset = 32; offset < wal.length; offset += 24 + 4096) {
    checksum(wal.subarray(offset, offset + 8));
    checksum(wal.subarray(offset + 24, offset + 24 + 4096));
    wal.writeUInt32BE(s0, offset + 16);
    wal.writeUInt32BE(s1, offset + 20);
  }
  await writeFile(path, base);
  await writeFile(path + '-wal', wal, { mode: 0o600 });
  store = await openStore(root);
  assert.equal(store.state.tasks.at(-1).title, 'Synthetic alternate-byte-order WAL');
  await store.close();
});

test('corrupt WAL header, frame, payload and recycled trailing frames are preserved without locking', async t => {
  const cases = [
    ['short header', wal => wal.subarray(0, 20)],
    ['incomplete frame', wal => wal.subarray(0, wal.length - 1)],
    ['format version', wal => { wal[7] ^= 1; return wal; }],
    ['header checksum', wal => { wal[24] ^= 1; return wal; }],
    ['header salt', wal => { wal[16] ^= 1; return wal; }],
    ['frame salt', wal => { wal[40] ^= 1; return wal; }],
    ['frame checksum', wal => { wal[48] ^= 1; return wal; }],
    ['frame commit size', wal => { wal[36] ^= 1; return wal; }],
    ['frame page number', wal => { wal[35] ^= 1; return wal; }],
    ['page payload', wal => { wal[56 + 123] ^= 1; return wal; }],
    ['newest committed frame', wal => { wal[wal.length - 1] ^= 1; return wal; }],
    ['stale trailing frame', wal => {
      const stale = Buffer.from(wal.subarray(32, 32 + 24 + 4096));
      stale[8] ^= 1;
      return Buffer.concat([wal, stale]);
    }]
  ];
  for (const [label, corrupt] of cases) {
    const root = await directory(t);
    const store = await openStore(root);
    await store.close();
    const path = join(root, 'workspace.sqlite');
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA wal_autocheckpoint=0;');
      const state = JSON.parse(db.prepare('SELECT body FROM workspace WHERE id=1').get().body);
      for (let index = 0; index < 3; index++) {
        state.tasks.push({ id: randomUUID(), title: `Synthetic committed WAL data ${index}`, status: 'next' });
        db.prepare('UPDATE workspace SET body=? WHERE id=1').run(JSON.stringify(state));
      }
      const walPath = path + '-wal';
      const wal = await readFile(walPath);
      assert.ok(wal.length >= 32 + 24 + 4096, label);
      await writeFile(walPath, corrupt(wal));
      const names = (await readdir(root)).sort();
      const before = await Promise.all(names.map(name => readFile(join(root, name))));
      const changes = [];
      const watcher = watch(root, (_event, name) => changes.push(String(name)));
      try {
        await assert.rejects(startServer({ dataDir: root, port: 0 }), /WAL integrity could not be verified/, label);
        await new Promise(resolve => setTimeout(resolve, 100));
      } finally { watcher.close(); }
      assert.deepEqual(changes.filter(name => /workspace\.(?:lock|sqlite)/.test(name)), [], label);
      assert.deepEqual((await readdir(root)).sort(), names, label);
      assert.deepEqual(await Promise.all(names.map(name => readFile(join(root, name)))), before, label);
    } finally { db.close(); }
  }
});

test('unexpected rollback journal is preserved without opening the workspace', async t => {
  const root = await directory(t);
  const store = await openStore(root);
  await store.close();
  await writeFile(join(root, 'workspace.sqlite-journal'), 'Synthetic journal to preserve.', { mode: 0o600 });
  const names = (await readdir(root)).sort();
  const before = await Promise.all(names.map(name => readFile(join(root, name))));
  const changes = [];
  const watcher = watch(root, (_event, name) => changes.push(String(name)));
  try {
    await assert.rejects(startServer({ dataDir: root, port: 0 }), /Unexpected SQLite rollback journal/);
    await new Promise(resolve => setTimeout(resolve, 100));
  } finally { watcher.close(); }
  assert.deepEqual(changes.filter(name => /workspace\.(?:lock|sqlite)/.test(name)), []);
  assert.deepEqual((await readdir(root)).sort(), names);
  assert.deepEqual(await Promise.all(names.map(name => readFile(join(root, name)))), before);
});

test('multiply linked database and sidecars are refused without modifying either alias', async t => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const root = await directory(t);
    const outside = await directory(t);
    const store = await openStore(root);
    await store.close();
    const path = join(root, 'workspace.sqlite' + suffix);
    if (suffix) await writeFile(path, 'Synthetic sidecar.', { mode: 0o600 });
    const alias = join(outside, 'alias');
    await link(path, alias);
    const names = (await readdir(root)).sort();
    const before = await Promise.all(names.map(name => readFile(join(root, name))));
    const changes = [];
    const watcher = watch(root, (_event, name) => changes.push(String(name)));
    try {
      await assert.rejects(startServer({ dataDir: root, port: 0 }), /verifiable single link/);
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally { watcher.close(); }
    assert.deepEqual(changes.filter(name => /workspace\.(?:lock|sqlite)/.test(name)), [], suffix);
    assert.deepEqual((await readdir(root)).sort(), names, suffix);
    assert.deepEqual(await Promise.all(names.map(name => readFile(join(root, name)))), before, suffix);
    assert.deepEqual(await readFile(alias), await readFile(path), suffix);
  }
});

test('unrelated stale locks are never removed, even in an owned workspace', async t => {
  for (const owned of [false, true]) {
    const root = await directory(t);
    if (owned) {
      const store = await openStore(root);
      await store.close();
    }
    const path = join(root, 'workspace.lock');
    const original = Buffer.from('{"pid":2147483647,"other":"synthetic"}');
    await writeFile(path, original, { mode: 0o600 });
    const names = (await readdir(root)).sort();
    const db = owned ? await readFile(join(root, 'workspace.sqlite')) : null;
    await assert.rejects(startServer({ dataDir: root, port: 0 }), /ownership is not established|unverified lock/);
    assert.deepEqual(await readFile(path), original);
    assert.deepEqual((await readdir(root)).sort(), names);
    if (owned) assert.deepEqual(await readFile(join(root, 'workspace.sqlite')), db);
  }
});

test('markerless SQLite requires explicit adoption into an empty separate workspace', async t => {
  const source = await directory(t);
  const destination = await directory(t);
  const path = join(source, 'workspace.sqlite');
  const legacy = newWorkspace();
  legacy.tasks.push({ id: 'fake-task', title: 'Synthetic legacy task', status: 'next' });
  legacy.profile.displayName = 'Synthetic owner';
  Object.assign(legacy.preferences, { paused: false, automaticRefresh: true, dailyBackups: true, localOutputApproved: true, demoApproved: true });
  legacy.sourceConsent = { consent: true };
  legacy.jobs.push({ id: randomUUID(), status: 'queued', events: [] }, { id: randomUUID(), status: 'running', events: [] });
  const documentId = randomUUID();
  const backupId = randomUUID();
  legacy.documents.push({ id: documentId, title: 'Synthetic document' });
  legacy.backups.push({ id: backupId, createdAt: '2026-01-01T00:00:00Z' });
  legacy.recoveries.push({ id: randomUUID(), directory: 'old-private-directory' });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); PRAGMA user_version=1;');
  db.prepare('INSERT INTO workspace VALUES (1, ?)').run(JSON.stringify(legacy));
  db.close();
  const before = await readFile(path);
  await assert.rejects(startServer({ dataDir: source, port: 0 }), /ownership is not established/);
  await assert.rejects(adoptLegacyWorkspace({ source, destination }), /Explicit confirmation/);
  await assert.rejects(adoptLegacyWorkspace({ source, destination: source, confirmed: true }), /separate empty destination/);
  assert.deepEqual(await readdir(destination), []);
  await adoptLegacyWorkspace({ source, destination, confirmed: true });
  assert.deepEqual(await readFile(path), before);
  let store = await openStore(destination);
  assert.equal(store.state.tasks[0].title, 'Synthetic legacy task');
  assert.equal(store.state.profile.displayName, 'Synthetic owner');
  assert.deepEqual(
    Object.fromEntries(['paused', 'automaticRefresh', 'dailyBackups', 'localOutputApproved', 'demoApproved'].map(key => [key, store.state.preferences[key]])),
    { paused: true, automaticRefresh: false, dailyBackups: false, localOutputApproved: false, demoApproved: false }
  );
  assert.equal(store.state.sourceConsent, null);
  assert.deepEqual(store.state.jobs.map(job => job.status), ['interrupted', 'interrupted']);
  for (const job of store.state.jobs) assert.equal(job.events.at(-1).status, 'interrupted');
  for (const record of [store.state.documents[0], store.state.backups[0], store.state.recoveries[0]]) assert.match(record.fileUnavailableReason, /not copied/);
  store.update(state => { state.tasks[0].title = 'Synthetic updated task'; });
  await store.close();
  store = await openStore(destination);
  assert.equal(store.state.tasks[0].title, 'Synthetic updated task');
  await store.close();
  assert.deepEqual(await readFile(path), before);
  const app = await startServer({ dataDir: destination, port: 0, workerIntervalMs: 0 });
  try {
    const headers = { 'X-Esquie-Access': app.accessToken };
    const state = await (await fetch(`${app.url}/api/state`, { headers })).json();
    await app.worker.tick();
    const afterTick = await (await fetch(`${app.url}/api/state`, { headers })).json();
    assert.deepEqual(afterTick.jobs.map(job => job.status), ['interrupted', 'interrupted']);
    const document = await fetch(`${app.url}/api/documents/${documentId}`, { headers });
    assert.equal(document.status, 410);
    assert.match((await document.json()).error, /not copied/);
    const recovery = await fetch(`${app.url}/api/backups/${backupId}/recover`, {
      method: 'POST', headers: { ...headers, Origin: app.url, 'X-Esquie-CSRF': state.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmSeparateWorkspace: true })
    });
    assert.equal(recovery.status, 410);
  } finally { await app.close(); }
});

test('JSON adoption pauses prior approvals and leaves the source unchanged', async t => {
  const source = await directory(t);
  const destination = await directory(t);
  const state = newWorkspace();
  Object.assign(state.preferences, { automaticRefresh: true, dailyBackups: true, localOutputApproved: true, demoApproved: true });
  state.jobs.push({ id: randomUUID(), status: 'queued', events: [] });
  const path = join(source, 'workspace.json');
  const before = Buffer.from(JSON.stringify(state));
  await writeFile(path, before, { mode: 0o600 });
  await adoptLegacyWorkspace({ source, destination, confirmed: true });
  const store = await openStore(destination);
  assert.equal(store.state.preferences.paused, true);
  for (const key of ['automaticRefresh', 'dailyBackups', 'localOutputApproved', 'demoApproved']) assert.equal(store.state.preferences[key], false);
  assert.equal(store.state.jobs[0].status, 'interrupted');
  await store.close();
  assert.deepEqual(await readFile(path), before);
});

test('a prior recreation database with application ID but no owner marker can be explicitly adopted', async t => {
  const source = await directory(t);
  const destination = await directory(t);
  const path = join(source, 'workspace.sqlite');
  const state = newWorkspace();
  state.profile.displayName = 'Synthetic previous recreation';
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); PRAGMA application_id=1163088213; PRAGMA user_version=1;');
  db.prepare('INSERT INTO workspace VALUES (1, ?)').run(JSON.stringify(state));
  db.close();
  const before = await readFile(path);
  await adoptLegacyWorkspace({ source, destination, confirmed: true });
  const store = await openStore(destination);
  assert.equal(store.state.profile.displayName, 'Synthetic previous recreation');
  assert.equal(store.state.preferences.paused, true);
  await store.close();
  assert.deepEqual(await readFile(path), before);
});

test('a runtime-specific previous owner marker can be explicitly adopted without changes', async t => {
  const source = await directory(t);
  const destination = await directory(t);
  const store = await openStore(source);
  store.update(state => { state.profile.displayName = 'Synthetic previous marker'; });
  await store.close();
  const ownerPath = join(source, 'workspace.owner');
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  owner.device = 'legacy-runtime-device';
  await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
  const names = (await readdir(source)).sort();
  const before = await Promise.all(names.map(name => readFile(join(source, name))));
  await assert.rejects(openStore(source), /ownership is not established/);
  await adoptLegacyWorkspace({ source, destination, confirmed: true });
  const adopted = await openStore(destination);
  assert.equal(adopted.state.profile.displayName, 'Synthetic previous marker');
  await adopted.close();
  assert.deepEqual((await readdir(source)).sort(), names);
  assert.deepEqual(await Promise.all(names.map(name => readFile(join(source, name)))), before);
});

test('unmarked JSON is not read or imported during normal startup', async t => {
  const root = await directory(t);
  const path = join(root, 'workspace.json');
  const content = Buffer.from('not even JSON');
  await writeFile(path, content, { mode: 0o600 });
  await assert.rejects(startServer({ dataDir: root, port: 0 }), /ownership is not established/);
  assert.deepEqual(await readFile(path), content);
  assert.deepEqual(await readdir(root), ['workspace.json']);
});

test('legacy adoption refuses WAL sidecars without modifying source files or creating a destination', async t => {
  const source = await directory(t);
  const destination = await directory(t);
  const path = join(source, 'workspace.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE workspace (id INTEGER PRIMARY KEY, body TEXT NOT NULL); PRAGMA user_version=1;');
    const state = newWorkspace();
    state.profile.displayName = 'Synthetic WAL state';
    db.prepare('INSERT INTO workspace VALUES (1, ?)').run(JSON.stringify(state));
    const names = ['workspace.sqlite', 'workspace.sqlite-wal', 'workspace.sqlite-shm'];
    const before = await Promise.all(names.map(name => readFile(join(source, name))));
    await assert.rejects(adoptLegacyWorkspace({ source, destination, confirmed: true }), /sidecars are present/);
    const after = await Promise.all(names.map(name => readFile(join(source, name))));
    assert.deepEqual(after, before);
    assert.deepEqual(await readdir(destination), []);
  } finally { db.close(); }
});

test('concurrent fresh starts do not create multiple owners', async t => {
  const root = await directory(t);
  const results = await Promise.allSettled([openStore(root), openStore(root)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  await results.find(result => result.status === 'fulfilled').value.close();
  const store = await openStore(root);
  await store.close();
});
