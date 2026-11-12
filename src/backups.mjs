import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, writeFile as writeFileCallback } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { openRecoveredSnapshot } from './store.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;
const maxDocumentBytes = 1024 * 1024;
const maxTotalDocumentBytes = 16 * 1024 * 1024;
const maxDocuments = 1000;
const maxSnapshotBytes = 256 * 1024 * 1024;
const maxManifestBytes = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const writeOpenFile = promisify(writeFileCallback);

async function localDirectory(path, { exclusive = false, create = true, volume, assertOutput } = {}) {
  if (create) {
    assertOutput?.(path);
    mkdirSync(path, { recursive: !exclusive, mode: 0o700 });
  }
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (volume !== undefined && metadata.dev !== volume) ||
      await realpath(path) !== resolve(path)) {
    throw new Error('Backup and recovery directories must not redirect.');
  }
}

async function writeNewFile(path, content, assertOutput) {
  // Keep the approval check and exclusive creation in the same event-loop turn.
  assertOutput(path);
  const descriptor = openSync(path, 'wx', 0o600);
  try { await writeOpenFile(descriptor, content); }
  finally { closeSync(descriptor); }
}

function sameFile(a, b) {
  // Node 22 on Windows reports zero for lstat.dev even when fstat.dev is nonzero.
  const sameDevice = a.dev === b.dev || (process.platform === 'win32' && (a.dev === 0n || b.dev === 0n));
  return sameDevice && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function fileMetadata(path, volume) {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n ||
      metadata.ino === 0n || metadata.dev !== volume || await realpath(path) !== resolve(path)) {
    throw new Error('Backup files must be ordinary, single-link local files without redirection.');
  }
  return metadata;
}

async function readVerifiedFile(path, limit, volume) {
  const before = await fileMetadata(path, volume);
  if (before.size > BigInt(limit)) throw new Error('Backup file exceeds the supported size limit.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await file.stat({ bigint: true });
    if (opened.nlink !== 1n || !sameFile(before, opened)) throw new Error('Backup file changed during inspection.');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await file.stat({ bigint: true });
    const current = await fileMetadata(path, volume);
    if (!sameFile(before, after) || !sameFile(after, current) || BigInt(bytes.length) !== after.size) {
      throw new Error('Backup file changed during inspection.');
    }
    return bytes;
  } finally { await file.close(); }
}

function validateDocuments(documents) {
  if (!Array.isArray(documents) || documents.length > maxDocuments) throw new Error('Too many document records for a backup.');
  const seen = new Set();
  for (const document of documents) {
    if (!document || !uuid.test(document.id) || seen.has(document.id.toLowerCase())) throw new Error('Invalid or duplicate document record.');
    seen.add(document.id.toLowerCase());
  }
}

async function collectDocuments(root, documents, volume) {
  validateDocuments(documents);
  const directory = join(root, 'documents');
  let names;
  try {
    await localDirectory(directory, { create: false, volume });
    names = await readdir(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    names = [];
  }
  const expected = new Set(documents.map(document => `${document.id}.md`));
  if (names.some(name => !expected.has(name))) throw new Error('Unknown document files were not included.');
  const files = [];
  const unavailable = [];
  let total = 0;
  for (const document of documents) {
    const name = `${document.id}.md`;
    if (!names.includes(name)) {
      unavailable.push({ id: document.id, reason: 'Document file is missing.' });
      continue;
    }
    const path = join(directory, name);
    await fileMetadata(path, volume);
    if (document.fileUnavailableReason || !digest.test(document.contentSha256 || '') ||
        !Number.isSafeInteger(document.contentBytes) || document.contentBytes < 0) {
      unavailable.push({ id: document.id, reason: 'Document content has no verified generation record or was already unavailable.' });
      continue;
    }
    const bytes = await readVerifiedFile(path, maxDocumentBytes, volume);
    if (bytes.length !== document.contentBytes || hash(bytes) !== document.contentSha256) {
      throw new Error('A recorded document changed after generation; backup was refused.');
    }
    total += bytes.length;
    if (total > maxTotalDocumentBytes) throw new Error('Documents exceed the supported backup size limit.');
    files.push({ id: document.id, sha256: document.contentSha256, bytes: bytes.length, content: bytes });
  }
  return { files, unavailable };
}

function inventory(collected) {
  return {
    version: 1,
    files: collected.files.map(({ id, sha256, bytes }) => ({ id, sha256, bytes })),
    unavailable: collected.unavailable
  };
}

async function directoryEntries(path, expected, volume) {
  await localDirectory(path, { create: false, volume });
  const names = await readdir(path);
  if (names.length !== expected.length || names.some(name => !expected.includes(name))) {
    throw new Error('Backup contains missing or unknown files.');
  }
}

export async function createLocalBackup({ root, store, id, now, verifyOutput, assertOutput }) {
  if (!uuid.test(id)) throw new Error('Invalid generated backup identifier.');
  if (typeof assertOutput !== 'function') throw new Error('Current output approval cannot be verified.');
  await verifyOutput();
  const volume = (await lstat(root, { bigint: true })).dev;
  const documents = structuredClone(store.state.documents);
  const collected = await collectDocuments(root, documents, volume);
  if (JSON.stringify(documents) !== JSON.stringify(store.state.documents)) throw new Error('Document records changed during backup.');
  await verifyOutput();
  await localDirectory(join(root, 'backups'), { volume, assertOutput });
  const directory = join(root, 'backups', id);
  await localDirectory(directory, { exclusive: true, volume, assertOutput });
  const path = join(directory, 'workspace.sqlite');
  // snapshot starts VACUUM INTO synchronously before its first await.
  assertOutput(path);
  await store.snapshot(path);
  if (JSON.stringify(documents) !== JSON.stringify(store.state.documents)) throw new Error('Document records changed during backup.');
  const checked = await collectDocuments(root, documents, volume);
  if (JSON.stringify(inventory(collected)) !== JSON.stringify(inventory(checked))) throw new Error('Documents changed during backup.');
  const bytes = await readVerifiedFile(path, maxSnapshotBytes, volume);
  if (collected.files.length) {
    const folder = join(directory, 'documents');
    await localDirectory(folder, { exclusive: true, volume, assertOutput });
    for (const file of collected.files) {
      const target = join(folder, `${file.id}.md`);
      await writeNewFile(target, file.content, assertOutput);
      if (hash(await readVerifiedFile(target, maxDocumentBytes, volume)) !== file.sha256) throw new Error('Document backup verification failed.');
    }
  }
  const backup = {
    id, createdAt: now.toISOString(), status: 'partial',
    sha256: hash(bytes), bytes: bytes.length,
    coverage: {
      workspace: 'consistent-sqlite-snapshot',
      documents: {
        status: collected.unavailable.length ? 'partial' : 'included',
        metadataCount: documents.length, includedCount: collected.files.length,
        unavailable: collected.unavailable
      },
      sources: 'partial-local-evidence-only; disconnected/unavailable sources are not checkpoints'
    }
  };
  const manifest = Buffer.from(JSON.stringify({ ...backup, documents: inventory(collected) }, null, 2));
  if (manifest.length > maxManifestBytes) throw new Error('Backup manifest exceeds the supported size limit.');
  await writeNewFile(join(directory, 'manifest.json'), manifest, assertOutput);
  backup.manifestSha256 = hash(manifest);
  await verifyOutput();
  return backup;
}

export async function recoverLocalBackup({ root, backup, now, verifyOutput, assertOutput }) {
  if (!uuid.test(backup.id)) throw new Error('Invalid saved backup identifier.');
  if (typeof assertOutput !== 'function') throw new Error('Current output approval cannot be verified.');
  await verifyOutput();
  const volume = (await lstat(root, { bigint: true })).dev;
  const directory = join(root, 'backups', backup.id);
  await localDirectory(join(root, 'backups'), { create: false, volume });
  await localDirectory(directory, { create: false, volume });
  const path = join(directory, 'workspace.sqlite');
  const manifestBytes = await readVerifiedFile(join(directory, 'manifest.json'), maxManifestBytes, volume);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw new Error('Backup manifest is invalid; recovery was refused.'); }
  const snapshot = await readVerifiedFile(path, maxSnapshotBytes, volume);
  if (manifest.id !== backup.id || manifest.sha256 !== backup.sha256 || hash(snapshot) !== backup.sha256 ||
      snapshot.length !== backup.bytes || (backup.manifestSha256 && hash(manifestBytes) !== backup.manifestSha256)) {
    throw new Error('Backup integrity verification failed; recovery was refused.');
  }
  const modern = backup.manifestSha256 !== undefined;
  if (modern && (!digest.test(backup.manifestSha256) || manifest.documents?.version !== 1)) throw new Error('Backup document manifest is invalid.');
  if (!modern && manifest.documents !== undefined) throw new Error('Unverified document manifest was refused.');
  const restoredFiles = new Map();
  let excluded = [];
  if (modern) {
    const entries = manifest.documents;
    if (!Array.isArray(entries.files) || !Array.isArray(entries.unavailable) ||
        entries.files.length + entries.unavailable.length > maxDocuments) throw new Error('Invalid document inventory.');
    const all = [...entries.files, ...entries.unavailable];
    validateDocuments(all);
    if (entries.unavailable.some(item => typeof item.reason !== 'string' || item.reason.length > 200)) throw new Error('Invalid document exclusions.');
    let total = 0;
    for (const file of entries.files) {
      if (!digest.test(file.sha256 || '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > maxDocumentBytes) throw new Error('Invalid document inventory.');
      total += file.bytes;
    }
    if (total > maxTotalDocumentBytes) throw new Error('Documents exceed the supported recovery size limit.');
    const names = ['manifest.json', 'workspace.sqlite', ...(entries.files.length ? ['documents'] : [])];
    await directoryEntries(directory, names, volume);
    if (entries.files.length) {
      const folder = join(directory, 'documents');
      await directoryEntries(folder, entries.files.map(file => `${file.id}.md`), volume);
      for (const file of entries.files) {
        const content = await readVerifiedFile(join(folder, `${file.id}.md`), maxDocumentBytes, volume);
        if (content.length !== file.bytes || hash(content) !== file.sha256) throw new Error('Document backup integrity verification failed.');
        restoredFiles.set(file.id, { ...file, content });
      }
    }
    excluded = entries.unavailable;
  } else {
    await directoryEntries(directory, ['manifest.json', 'workspace.sqlite'], volume);
  }
  await verifyOutput();
  await localDirectory(join(root, 'recoveries'), { volume, assertOutput });
  const id = randomUUID();
  const destination = join(root, 'recoveries', id);
  await localDirectory(destination, { exclusive: true, volume, assertOutput });
  await writeNewFile(join(destination, 'workspace.sqlite'), snapshot, assertOutput);
  const recovered = await openRecoveredSnapshot(destination, {
    assertOutput,
    prepareState(state) {
      if (modern) {
        validateDocuments(state.documents);
        const expected = new Set([...restoredFiles.keys(), ...excluded.map(item => item.id)]);
        if (expected.size !== state.documents.length || state.documents.some(document => !expected.has(document.id))) throw new Error('Document inventory does not match the saved workspace.');
        for (const document of state.documents) {
          const file = restoredFiles.get(document.id);
          if (file && (document.contentSha256 !== file.sha256 || document.contentBytes !== file.bytes || document.fileUnavailableReason)) throw new Error('Document inventory does not match its saved record.');
        }
      }
      Object.assign(state.preferences, { paused: true, automaticRefresh: false, dailyBackups: false, localOutputApproved: false, demoApproved: false });
      state.sourceConsent = null;
      state.backups = [];
      state.recoveries = [];
      for (const document of state.documents) {
        document.fileUnavailableReason = modern
          ? excluded.find(item => item.id === document.id)?.reason || 'Recovery did not finish copying this document.'
          : 'File excluded from this state-only backup; original document was not deleted.';
      }
      for (const job of state.jobs) if (['queued', 'running'].includes(job.status)) {
        job.status = 'interrupted';
        job.updatedAt = now.toISOString();
        job.error = 'Recovered historical work was not replayed. Review before explicitly retrying.';
        job.events.push({ status: 'interrupted', at: now.toISOString() });
      }
    }
  });
  try {
    if (restoredFiles.size) {
      const folder = join(destination, 'documents');
      await localDirectory(folder, { exclusive: true, volume, assertOutput });
      for (const file of restoredFiles.values()) {
        const target = join(folder, `${file.id}.md`);
        await writeNewFile(target, file.content, assertOutput);
        if (hash(await readVerifiedFile(target, maxDocumentBytes, volume)) !== file.sha256) throw new Error('Recovered document verification failed.');
      }
      assertOutput(join(destination, 'workspace.sqlite'));
      recovered.update(state => {
        for (const document of state.documents) if (restoredFiles.has(document.id)) delete document.fileUnavailableReason;
      });
    }
  } finally { await recovered.close(); }
  await verifyOutput();
  return {
    id, backupId: backup.id, createdAt: now.toISOString(), directory: destination,
    status: 'partial', coverage: backup.coverage,
    message: `A separate paused workspace was prepared. ${restoredFiles.size} verified document file(s) restored; ${modern ? excluded.length : 'all'} unavailable/excluded. Original workspace/backups are unchanged; sources remain partial. Quit this host before selecting the recovered workspace; reconnect and reapprove outputs explicitly.`
  };
}
