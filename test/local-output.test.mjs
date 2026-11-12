import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { startServer } from '../src/server.mjs';
import { assertOutputAllowed } from '../src/local-output.mjs';

test('known sync roots and configured custom sync roots are rejected without creating state', async () => {
  for (const name of ['Dropbox', 'Google Drive', 'My Drive', 'iCloudDrive', 'Box', 'Nextcloud']) {
    await assert.rejects(startServer({ dataDir: join(tmpdir(), name, 'esquie-synthetic-test'), port: 0 }), /outside the application repository and cloud-synced folders/);
  }
  const original = process.env.ESQUIE_SYNC_ROOTS;
  const custom = join(tmpdir(), 'custom-synthetic-sync-root');
  process.env.ESQUIE_SYNC_ROOTS = JSON.stringify([custom]);
  try {
    await assert.rejects(startServer({ dataDir: join(custom, 'private'), port: 0 }), /outside the application repository and cloud-synced folders/);
    for (const invalid of ['null', '{}', '["relative-path"]', '[123]', 'not-json']) {
      process.env.ESQUIE_SYNC_ROOTS = invalid;
      await assert.rejects(startServer({ dataDir: join(tmpdir(), 'esquie-config-shape-test'), port: 0 }), /JSON array of absolute local paths/);
    }
  } finally {
    if (original === undefined) delete process.env.ESQUIE_SYNC_ROOTS;
    else process.env.ESQUIE_SYNC_ROOTS = original;
  }
});

test('symlink/junction redirection and missing owner approval disable local file output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-output-path-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const destination = join(root, 'destination');
  const alias = join(root, 'alias');
  await mkdir(destination);
  await symlink(destination, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertOutputAllowed({ root: alias, approved: true, verifyVolume: async () => true }), /symlink or junction/);
  await assert.rejects(assertOutputAllowed({ root: destination, approved: false, verifyVolume: async () => true }), /disabled/);
  await assert.rejects(assertOutputAllowed({ root: destination, approved: true, verifyVolume: async () => false }), /fixed local output volume/);
});
