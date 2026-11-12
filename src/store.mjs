import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { closeSync, openSync, writeFile as writeFileCallback } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat, open, readFile, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { assertPrivateDataDirectory, assertPrivateStorage, runSystemPowerShell } from './private-storage.mjs';

const applicationId = 0x45535155;
// Hash of the canonical v1 schema page, excluding SQLite's mutable 100-byte header.
const schemaFingerprint = '86f3f6d1d89f9cca72d3a47b8f298e37481bae55781d74752427d263b3ad8af2';
const unowned = 'Workspace ownership is not established; existing files were left unchanged. See the documented legacy adoption procedure.';
const execute = promisify(execFile);
const writeOpenFile = promisify(writeFileCallback);

export function newWorkspace() {
  return {
    schemaVersion: 1,
    profile: { displayName: '', timezone: '' },
    preferences: { paused: false, quietStart: '', quietEnd: '', automaticRefresh: false, dailyBackups: false, localOutputApproved: false, demoApproved: false },
    tasks: [], drafts: [], links: [], activity: [], conversations: [], jobs: [], documents: [], records: [], draftOperations: [], backups: [], recoveries: [],
    sourceConsent: null,
    sourceConfigurationDraft: null,
    onboarding: { status: 'not-started', step: 0, revision: 0, updatedAt: null, legacy: false },
    scheduler: { lastRefreshAt: null, lastBackupDay: null, lastBackupAttemptAt: null }
  };
}

function parseSavedJson(content, subject) {
  try { return JSON.parse(content); }
  catch { throw new Error(`Saved ${subject} is invalid JSON; it was left unchanged.`); }
}

function normalizeState(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.tasks) || !Array.isArray(value.drafts) || !Array.isArray(value.activity)) {
    throw new Error('The saved workspace has an unsupported or invalid format; it was left unchanged.');
  }
  const state = { ...newWorkspace(), ...value };
  if (!value.onboarding) state.onboarding.legacy = true;
  if (!state.onboarding || !['not-started', 'in-progress', 'skipped', 'complete'].includes(state.onboarding.status) ||
      !Number.isInteger(state.onboarding.step) || state.onboarding.step < 0 || state.onboarding.step > 7 ||
      !Number.isInteger(state.onboarding.revision) || state.onboarding.revision < 0) throw new Error('Saved onboarding progress is invalid; the workspace was left unchanged.');
  for (const task of state.tasks) {
    if (task.history != null && !Array.isArray(task.history)) throw new Error('Saved task history is invalid; the workspace was left unchanged.');
    task.history ??= [];
  }
  for (const key of ['links', 'conversations', 'jobs', 'documents', 'records', 'draftOperations', 'backups', 'recoveries']) {
    if (!Array.isArray(state[key])) throw new Error(`Saved ${key} is invalid; the workspace was left unchanged.`);
  }
  for (const record of state.records) {
    if (record.category !== 'account') continue;
    if (record.history != null && !Array.isArray(record.history)) throw new Error('Saved account history is invalid; the workspace was left unchanged.');
    record.history ??= [];
    record.plan ??= '';
    record.stakeholders ??= '';
  }
  if (!state.profile || typeof state.profile !== 'object' || Array.isArray(state.profile)) throw new Error('Saved profile is invalid.');
  state.preferences = { ...newWorkspace().preferences, ...state.preferences };
  return state;
}

async function acquireLock(root, assertOutput) {
  const path = join(root, 'workspace.lock');
  const identity = { pid: process.pid, token: randomUUID() };
  let descriptor;
  try {
    assertOutput?.(path);
    descriptor = openSync(path, 'wx', 0o600);
    await writeOpenFile(descriptor, JSON.stringify(identity));
    closeSync(descriptor);
    descriptor = undefined;
    return async () => {
      const current = parseSavedJson(await readFile(path, 'utf8'), 'workspace lock');
      if (current.token !== identity.token) throw new Error('Workspace lock ownership changed.');
      await rm(path);
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error.code === 'EEXIST') throw new Error('This workspace is already open in another process or has an unverified lock; it was left unchanged.');
    throw error;
  }
}

async function regularFile(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Workspace files must be regular local files.');
    if (!Number.isInteger(metadata.nlink) || metadata.nlink !== 1) throw new Error('Workspace files must have a verifiable single link; existing files were left unchanged.');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function inspectSidecars(path) {
  for (const suffix of ['-wal', '-shm']) await regularFile(path + suffix);
  if (await regularFile(path + '-journal')) throw new Error('Unexpected SQLite rollback journal; workspace files were left unchanged.');
}

async function inspectHeader(path, identity) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(100);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== 100 || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') throw new Error(unowned);
    const version = header.readUInt32BE(60);
    if (version > 1) throw new Error('This database needs a newer app version; it was not downgraded.');
    if (version !== 1 || ![].concat(identity).includes(header.readUInt32BE(68))) throw new Error(unowned);
  } finally { await file.close(); }
}

async function fileIdentity(path) {
  const file = await lstat(path, { bigint: true });
  if (!file.isFile() || file.isSymbolicLink() || file.ino === 0n) throw new Error('Workspace file identity cannot be verified; existing files were left unchanged.');
  let device = file.dev.toString();
  if (process.platform === 'win32') {
    const drive = /^([a-z]):\\/i.exec(resolve(path))?.[1]?.toUpperCase();
    if (!drive) throw new Error('Workspace volume identity cannot be verified; existing files were left unchanged.');
    try {
      const { stdout } = await runSystemPowerShell(`
$ErrorActionPreference = 'Stop'
$disk = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $env:ESQUIE_IDENTITY_DRIVE + ":'")
if ($null -eq $disk -or $disk.DriveType -ne 3 -or $disk.VolumeSerialNumber -notmatch '^[0-9A-Fa-f]{8}$') { throw 'Unverified volume.' }
$disk.VolumeSerialNumber.ToUpperInvariant()
`, { ESQUIE_IDENTITY_DRIVE: drive });
      const serial = stdout.trim();
      if (!/^[0-9A-F]{8}$/.test(serial)) throw new Error('Unverified volume.');
      device = `volume:${serial}`;
    } catch {
      throw new Error('Workspace volume identity cannot be verified; existing files were left unchanged.');
    }
  }
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(100);
    if ((await handle.read(header, 0, 100, 0)).bytesRead !== 100) throw new Error(unowned);
    const encodedPageSize = header.readUInt16BE(16);
    const pageSize = encodedPageSize === 1 ? 65536 : encodedPageSize;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1))) throw new Error(unowned);
    const schemaPage = Buffer.alloc(pageSize - 100);
    if ((await handle.read(schemaPage, 0, schemaPage.length, 100)).bytesRead !== schemaPage.length) throw new Error(unowned);
    const schema = createHash('sha256').update(schemaPage).digest('hex');
    if (schema !== schemaFingerprint) throw new Error(unowned);
    return { device, file: file.ino.toString(), schema };
  } finally { await handle.close(); }
}

async function writeOwnership(root, assertOutput) {
  const identity = await fileIdentity(join(root, 'workspace.sqlite'));
  const path = join(root, 'workspace.owner');
  assertOutput?.(path);
  const descriptor = openSync(path, 'wx', 0o600);
  try { await writeOpenFile(descriptor, JSON.stringify({ kind: 'esquie-local-workspace', version: 1, ...identity })); }
  finally { closeSync(descriptor); }
}

async function inspectOwnership(root) {
  const marker = join(root, 'workspace.owner');
  if (!await regularFile(marker)) throw new Error(unowned);
  const owner = parseSavedJson(await readFile(marker, 'utf8'), 'workspace ownership marker');
  const identity = await fileIdentity(join(root, 'workspace.sqlite'));
  if (owner?.kind !== 'esquie-local-workspace' || owner.version !== 1 || owner.device !== identity.device || owner.file !== identity.file || owner.schema !== identity.schema) throw new Error(unowned);
}

async function inspectWal(path) {
  const wal = path + '-wal';
  if (!await regularFile(wal)) return;
  const handle = await open(wal, 'r');
  try {
    const before = await handle.stat();
    if (before.size === 0) return;
    const header = Buffer.alloc(32);
    const invalidWal = 'Workspace WAL integrity could not be verified; all workspace files were left unchanged.';
    if ((await handle.read(header, 0, 32, 0)).bytesRead !== 32) throw new Error(invalidWal);
    const magic = header.readUInt32BE(0);
    const pageSize = header.readUInt32BE(8);
    if (![0x377f0682, 0x377f0683].includes(magic) || header.readUInt32BE(4) !== 3007000 || pageSize !== 4096 ||
        (before.size - 32) % (24 + pageSize) !== 0) throw new Error(invalidWal);
    let s0 = 0;
    let s1 = 0;
    const checksum = data => {
      for (let i = 0; i < data.length; i += 8) {
        const x0 = magic === 0x377f0682 ? data.readUInt32LE(i) : data.readUInt32BE(i);
        const x1 = magic === 0x377f0682 ? data.readUInt32LE(i + 4) : data.readUInt32BE(i + 4);
        s0 = (s0 + x0 + s1) >>> 0;
        s1 = (s1 + x1 + s0) >>> 0;
      }
    };
    checksum(header.subarray(0, 24));
    if (header.readUInt32BE(24) !== s0 || header.readUInt32BE(28) !== s1) throw new Error(invalidWal);
    const frame = Buffer.alloc(24);
    const page = Buffer.alloc(pageSize);
    for (let offset = 32; offset < before.size; offset += 24 + pageSize) {
      if ((await handle.read(frame, 0, frame.length, offset)).bytesRead !== frame.length ||
          (await handle.read(page, 0, page.length, offset + 24)).bytesRead !== page.length ||
          frame.readUInt32BE(0) === 0 || frame.readUInt32BE(0) === 0xffffffff ||
          !frame.subarray(8, 16).equals(header.subarray(16, 24))) throw new Error(invalidWal);
      checksum(frame.subarray(0, 8));
      checksum(page);
      if (frame.readUInt32BE(16) !== s0 || frame.readUInt32BE(20) !== s1) throw new Error(invalidWal);
      if (frame.readUInt32BE(0) === 1 && (page.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' ||
          page.readUInt32BE(60) !== 1 || page.readUInt32BE(68) !== applicationId ||
          createHash('sha256').update(page.subarray(100)).digest('hex') !== schemaFingerprint)) throw new Error(unowned);
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Workspace WAL changed during inspection; it was left unchanged.');
  } finally { await handle.close(); }
}

function inspectOpenedDatabase(database, identity) {
  const version = database.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) throw new Error('This database needs a newer app version; it was not downgraded.');
  if (version !== 1 || database.prepare('PRAGMA application_id').get().application_id !== identity) throw new Error(unowned);
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if (tables.length !== 1 || tables[0].name !== 'workspace') throw new Error(unowned);
  const rows = database.prepare('SELECT id, body FROM workspace').all();
  if (rows.length !== 1 || rows[0].id !== 1 || typeof rows[0].body !== 'string') throw new Error(unowned);
  return normalizeState(parseSavedJson(rows[0].body, 'workspace'));
}

async function inspectLegacyDatabase(path) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (await regularFile(path + suffix)) throw new Error('Legacy SQLite sidecars are present; adoption was refused to avoid missing changes or modifying the source.');
  }
  await inspectHeader(path, [0, applicationId]);
  const before = await lstat(path);
  const script = [
    'import json, pathlib, sqlite3, sys',
    "uri = pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro&immutable=1'",
    'db = sqlite3.connect(uri, uri=True)',
    "tables = db.execute(\"SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'\").fetchall()",
    "rows = db.execute('SELECT id, body FROM workspace').fetchall() if tables == [('workspace',)] else []",
    "print(json.dumps([db.execute('PRAGMA user_version').fetchone()[0], db.execute('PRAGMA application_id').fetchone()[0], tables, rows]))",
    'db.close()'
  ].join('\n');
  let stdout;
  try {
    ({ stdout } = await execute(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', '-c', script, path], { maxBuffer: 256 * 1024 * 1024 }));
  } catch {
    throw new Error('Read-only legacy SQLite inspection failed; install Python 3 with sqlite3 or inspect the source safely. No source files were changed.');
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (await regularFile(path + suffix)) throw new Error('Legacy SQLite sidecars appeared during inspection; adoption was refused.');
  }
  const after = await lstat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Legacy SQLite changed during inspection; adoption was refused.');
  const [version, identity, tables, rows] = JSON.parse(stdout);
  if (version !== 1 || ![0, applicationId].includes(identity) || tables.length !== 1 || tables[0][0] !== 'workspace' ||
      rows.length !== 1 || rows[0][0] !== 1 || typeof rows[0][1] !== 'string') throw new Error(unowned);
  return normalizeState(parseSavedJson(rows[0][1], 'workspace'));
}

export async function adoptLegacyWorkspace({ source, destination, confirmed }) {
  if (confirmed !== true) throw new Error('Explicit confirmation is required for legacy adoption.');
  source = resolve(source);
  destination = assertPrivateDataDirectory(destination);
  await assertPrivateStorage(source);
  await assertPrivateStorage(destination);
  const isWithin = (parent, child) => {
    const path = relative(parent, child);
    return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
  };
  if (isWithin(source, destination) || isWithin(destination, source)) throw new Error('Legacy adoption requires a separate empty destination.');
  if ((await readdir(destination)).length) throw new Error('Legacy adoption requires a separate empty destination.');
  if (await regularFile(join(source, 'workspace.lock'))) throw new Error('The legacy workspace has a lock; stop its host and inspect it before adoption.');
  const path = join(source, 'workspace.sqlite');
  let state;
  if (await regularFile(path)) {
    state = await inspectLegacyDatabase(path);
  } else {
    const json = join(source, 'workspace.json');
    if (!await regularFile(json)) throw new Error('No legacy workspace database or JSON was found.');
    state = normalizeState(parseSavedJson(await readFile(json, 'utf8'), 'workspace'));
  }
  if (await regularFile(join(source, 'workspace.lock'))) throw new Error('The legacy workspace acquired a lock during inspection; adoption was refused.');
  Object.assign(state.preferences, { paused: true, automaticRefresh: false, dailyBackups: false, localOutputApproved: false, demoApproved: false });
  state.sourceConsent = null;
  for (const document of state.documents) document.fileUnavailableReason = 'Document file was not copied during adoption; the source remains unchanged.';
  for (const backup of state.backups) backup.fileUnavailableReason = 'Backup files were not copied during adoption; the source remains unchanged.';
  for (const recovery of state.recoveries) recovery.fileUnavailableReason = 'Recovery files were not copied during adoption; the source remains unchanged.';
  const now = new Date().toISOString();
  for (const job of state.jobs) if (['queued', 'running'].includes(job.status)) {
    job.status = 'interrupted';
    job.updatedAt = now;
    job.error = 'Adopted historical work was not replayed. Review before explicitly retrying.';
    job.events.push({ status: 'interrupted', at: now });
  }
  const store = await openStore(destination, { initialState: state });
  await store.close();
}

export async function openRecoveredSnapshot(root, { prepareState, assertOutput } = {}) {
  const path = join(root, 'workspace.sqlite');
  if ((await readdir(root)).length !== 1 || !await regularFile(path)) throw new Error('Recovery destination is not an exclusive snapshot.');
  await inspectHeader(path, applicationId);
  assertOutput?.(path);
  const readonly = new DatabaseSync(path, { readOnly: true });
  let state;
  try { state = inspectOpenedDatabase(readonly, applicationId); }
  finally { readonly.close(); }
  if (prepareState) {
    prepareState(state);
    assertOutput?.(path);
    const database = new DatabaseSync(path);
    try {
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare('UPDATE workspace SET body=? WHERE id=1').run(JSON.stringify(state));
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    } finally { database.close(); }
  }
  await writeOwnership(root, assertOutput);
  return openStore(root, { assertOutput });
}

export async function openStore(root, { initialState, assertOutput } = {}) {
  const path = join(root, 'workspace.sqlite');
  const existing = await regularFile(path);
  if (existing) {
    if ((await readdir(root)).includes('workspace.lock')) throw new Error('This workspace is already open in another process or has an unverified lock; it was left unchanged.');
    await inspectSidecars(path);
    await inspectHeader(path, applicationId);
    await inspectOwnership(root);
    await inspectWal(path);
  } else if ((await readdir(root)).length) {
    throw new Error(unowned);
  }
  const release = await acquireLock(root, assertOutput);
  let database;
  try {
    if (existing) {
      if (!await regularFile(path)) throw new Error(unowned);
      await inspectSidecars(path);
      await inspectOwnership(root);
      await inspectHeader(path, applicationId);
      await inspectWal(path);
    } else {
      if ((await readdir(root)).some(name => name !== 'workspace.lock')) throw new Error(unowned);
      assertOutput?.(path);
      const file = openSync(path, 'wx', 0o600);
      closeSync(file);
    }
    if (existing) {
      assertOutput?.(path);
      const readonly = new DatabaseSync(path, { readOnly: true });
      try { inspectOpenedDatabase(readonly, applicationId); }
      finally { readonly.close(); }
    }
    assertOutput?.(path);
    database = new DatabaseSync(path);
    if (!existing) {
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec(`CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); PRAGMA application_id = ${applicationId}; PRAGMA user_version = 1;`);
        database.prepare('INSERT INTO workspace (id, body) VALUES (1, ?)').run(JSON.stringify(initialState ?? newWorkspace()));
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
    inspectOpenedDatabase(database, applicationId);
    if (!existing) await writeOwnership(root, assertOutput);
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    const row = database.prepare('SELECT body FROM workspace WHERE id=1').get();
    let state = normalizeState(parseSavedJson(row.body, 'workspace'));
    if (process.platform !== 'win32') await chmod(path, 0o600);
    const save = database.prepare('UPDATE workspace SET body=? WHERE id=1');
    function update(change) {
      const next = structuredClone(state);
      const result = change(next);
      database.exec('BEGIN IMMEDIATE');
      try {
        save.run(JSON.stringify(next));
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      state = next;
      return result;
    }
    assertOutput?.(path);
    update(next => {
      for (const operation of next.draftOperations) {
        if (operation.status === 'creating') operation.status = 'unknown';
      }
      for (const job of next.jobs) {
        if (job.status === 'running') {
          job.status = 'interrupted';
          job.error = 'The host stopped during execution. Review the result before explicitly retrying.';
          job.updatedAt = new Date().toISOString();
          job.events.push({ status: 'interrupted', at: job.updatedAt });
        }
      }
    });
    return {
      get state() { return state; },
      update,
      async snapshot(destination) {
        database.prepare('VACUUM INTO ?').run(destination);
        if (process.platform !== 'win32') await chmod(destination, 0o600);
      },
      async close() {
        database.close();
        await release();
      }
    };
  } catch (error) {
    database?.close();
    await release();
    throw error;
  }
}
