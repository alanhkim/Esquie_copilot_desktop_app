import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertPlainLocalFile } from './local-output.mjs';
import { openRecoveredSnapshot } from './store.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function localDirectory(path, { exclusive = false } = {}) {
  await mkdir(path, { recursive: !exclusive, mode: 0o700 });
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) {
    throw new Error('Backup and recovery directories must not redirect.');
  }
}

export async function createLocalBackup({ root, store, id, now, verifyOutput }) {
  if (!uuid.test(id)) throw new Error('Invalid generated backup identifier.');
  await verifyOutput();
  await localDirectory(join(root, 'backups'));
  const directory = join(root, 'backups', id);
  await localDirectory(directory, { exclusive: true });
  const path = join(directory, 'workspace.sqlite');
  await store.snapshot(path);
  const bytes = await readFile(path);
  const backup = {
    id, createdAt: now.toISOString(), status: 'partial',
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    coverage: {
      workspace: 'consistent-sqlite-snapshot',
      documents: { status: 'not-included', metadataCount: store.state.documents.length, reason: 'Local document files are not included; only their metadata is saved.' },
      sources: 'partial-local-evidence-only; disconnected/unavailable sources are not checkpoints'
    }
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(backup, null, 2), { flag: 'wx', mode: 0o600 });
  await verifyOutput();
  return backup;
}

export async function recoverLocalBackup({ root, backup, now, verifyOutput }) {
  if (!uuid.test(backup.id)) throw new Error('Invalid saved backup identifier.');
  await verifyOutput();
  const directory = join(root, 'backups', backup.id);
  const path = join(directory, 'workspace.sqlite');
  const manifestPath = join(directory, 'manifest.json');
  await assertPlainLocalFile(path);
  await assertPlainLocalFile(manifestPath);
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { throw new Error('Backup manifest is invalid; recovery was refused.'); }
  const hash = createHash('sha256').update(await readFile(path)).digest('hex');
  if (manifest.id !== backup.id || manifest.sha256 !== backup.sha256 || hash !== backup.sha256) {
    throw new Error('Backup integrity verification failed; recovery was refused.');
  }
  await localDirectory(join(root, 'recoveries'));
  const id = randomUUID();
  const destination = join(root, 'recoveries', id);
  await localDirectory(destination, { exclusive: true });
  await copyFile(path, join(destination, 'workspace.sqlite'), constants.COPYFILE_EXCL);
  const recovered = await openRecoveredSnapshot(destination);
  try {
    recovered.update(state => {
      Object.assign(state.preferences, { paused: true, automaticRefresh: false, dailyBackups: false, localOutputApproved: false, demoApproved: false });
      state.sourceConsent = null;
      state.backups = [];
      state.recoveries = [];
      for (const document of state.documents) document.fileUnavailableReason = 'File excluded from this state-only backup; original document was not deleted.';
      for (const job of state.jobs) if (['queued', 'running'].includes(job.status)) {
        job.status = 'interrupted';
        job.updatedAt = now.toISOString();
        job.error = 'Recovered historical work was not replayed. Review before explicitly retrying.';
        job.events.push({ status: 'interrupted', at: now.toISOString() });
      }
    });
  } finally { await recovered.close(); }
  await verifyOutput();
  return {
    id, backupId: backup.id, createdAt: now.toISOString(), directory: destination,
    status: 'partial', coverage: backup.coverage,
    message: 'A separate paused workspace was prepared. Original workspace/backups are unchanged. Documents are metadata-only; sources remain partial. Quit this host before selecting the recovered workspace; reconnect and reapprove outputs explicitly.'
  };
}
