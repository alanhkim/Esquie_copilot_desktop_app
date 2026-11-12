import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

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
  if (!state.profile || typeof state.profile !== 'object' || Array.isArray(state.profile)) throw new Error('Saved profile is invalid.');
  state.preferences = { ...newWorkspace().preferences, ...state.preferences };
  return state;
}

async function acquireLock(root) {
  const path = join(root, 'workspace.lock');
  const identity = { pid: process.pid, token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(identity));
      await handle.close();
      return async () => {
        const current = parseSavedJson(await readFile(path, 'utf8'), 'workspace lock');
        if (current.token !== identity.token) throw new Error('Workspace lock ownership changed.');
        await rm(path);
      };
    } catch (error) {
      if (handle) await handle.close();
      if (error.code !== 'EEXIST') throw error;
      const current = parseSavedJson(await readFile(path, 'utf8'), 'workspace lock');
      if (!Number.isInteger(current.pid) || current.pid <= 0) throw new Error('Invalid workspace lock; inspect it without deleting state.');
      try {
        process.kill(current.pid, 0);
      } catch (probeError) {
        if (probeError.code !== 'ESRCH') throw new Error('Workspace lock owner cannot be verified.');
        await rm(path);
        continue;
      }
      throw new Error('This workspace is already open in another process. Use its private launcher or quit its owning host first.');
    }
  }
  throw new Error('Workspace lock could not be acquired.');
}

export async function openStore(root) {
  const release = await acquireLock(root);
  let database;
  try {
    const path = join(root, 'workspace.sqlite');
    let existing = false;
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Workspace database must be a regular local file.');
      existing = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let legacy;
    if (!existing) {
      try { legacy = normalizeState(parseSavedJson(await readFile(join(root, 'workspace.json'), 'utf8'), 'workspace')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    database = new DatabaseSync(path);
    const version = database.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('This database needs a newer app version; it was not downgraded.');
    if (existing && version !== 1) throw new Error('Existing database format is not supported; it was not reset.');
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    database.exec('CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);');
    let row = database.prepare('SELECT body FROM workspace WHERE id=1').get();
    if (!row) {
      const initial = legacy || newWorkspace();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare('INSERT INTO workspace (id, body) VALUES (1, ?)').run(JSON.stringify(initial));
        database.exec('PRAGMA user_version = 1; COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      row = { body: JSON.stringify(initial) };
    }
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
