import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertPrivateStorage, runSystemPowerShell } from '../src/private-storage.mjs';
import { startServer } from '../src/server.mjs';

test('a fresh app directory is current-user protected and can restart without permission replacement', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'esquie-private-fresh-'));
  t.after(() => rm(parent, { force: true, recursive: true }));
  const root = join(parent, 'workspace');
  const app = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  await app.close();
  await assertPrivateStorage(root);
  const restarted = await startServer({ dataDir: root, port: 0, workerIntervalMs: 0 });
  await restarted.close();
});

test('shared existing directories and state files are rejected without rewriting their permissions', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'esquie-private-existing-'));
  t.after(() => rm(parent, { force: true, recursive: true }));
  for (const target of ['directory', 'file']) {
    const root = join(parent, target);
    await mkdir(root, { mode: 0o700 });
    await assertPrivateStorage(root, { created: true });
    const path = target === 'directory' ? root : join(root, 'workspace.json');
    if (target === 'file') await writeFile(path, '{"fake":true}', { mode: 0o600 });
    if (process.platform === 'win32') {
      const { stdout: before } = await runSystemPowerShell(`
$ErrorActionPreference = 'Stop'
$path = $env:ESQUIE_TEST_PERMISSION_PATH
$directory = (Get-Item -LiteralPath $path).PSIsContainer
$sections = [System.Security.AccessControl.AccessControlSections]::Access
$acl = if ($directory) { [IO.Directory]::GetAccessControl($path, $sections) } else { [IO.File]::GetAccessControl($path, $sections) }
$sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'ReadAndExecute', 'Allow'))
if ($directory) { [IO.Directory]::SetAccessControl($path, $acl) } else { [IO.File]::SetAccessControl($path, $acl) }
(Get-Acl -LiteralPath $path).Sddl
`, { ESQUIE_TEST_PERMISSION_PATH: path });
      await assert.rejects(assertPrivateStorage(root), /Current-user-only storage protection/);
      const { stdout: after } = await runSystemPowerShell('(Get-Acl -LiteralPath $env:ESQUIE_TEST_PERMISSION_PATH).Sddl', { ESQUIE_TEST_PERMISSION_PATH: path });
      assert.equal(after, before);
    } else {
      await chmod(path, target === 'directory' ? 0o755 : 0o644);
      const before = (await stat(path)).mode;
      await assert.rejects(assertPrivateStorage(root), /Current-user-only storage protection/);
      assert.equal((await stat(path)).mode, before);
    }
  }
});
