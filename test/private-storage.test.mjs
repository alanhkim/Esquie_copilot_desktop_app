import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test, mock } from 'node:test';
import { assertPrivateStorage, runSystemPowerShell, systemPowerShellPath } from '../src/private-storage.mjs';
import { startServer } from '../src/server.mjs';

test('Windows inspection uses a scoped finite budget and fails closed on timeout or denial without caching', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-private-inspection-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const results = [
    { stdout: '{"private":true}' },
    { error: Object.assign(new Error('synthetic private detail'), { killed: true, signal: 'SIGTERM' }) },
    { error: new Error('synthetic private detail'), stderr: 'Storage is shared with another principal. synthetic private detail' },
    { stdout: '{"private":false}' },
    { error: Object.assign(new Error('synthetic private detail'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' }) },
    { stdout: 'ok' }
  ];
  const observed = [];
  mock.method(childProcess, 'execFile', (_executable, _args, options, callback) => {
    observed.push(options.timeout);
    const child = { stdin: new EventEmitter(), killed: false, kill() { this.killed = true; } };
    child.stdin.end = () => {
      const result = results.shift();
      process.nextTick(() => callback(result.error || null, result.stdout || '', result.stderr || ''));
    };
    return child;
  });
  syncBuiltinESMExports();
  try {
    await assertPrivateStorage(root);
    await assert.rejects(assertPrivateStorage(root), error => {
      assert.match(error.message, /inspection was interrupted or timed out/i);
      assert.doesNotMatch(error.message, /synthetic private detail/);
      return true;
    });
    await assert.rejects(assertPrivateStorage(root), error => {
      assert.match(error.message, /shared with another principal/i);
      assert.doesNotMatch(error.message, /synthetic private detail/);
      return true;
    });
    await assert.rejects(assertPrivateStorage(root), /protection could not be verified/i);
    await assert.rejects(assertPrivateStorage(root), error => {
      assert.match(error.message, /inspection failed or is unavailable/i);
      assert.doesNotMatch(error.message, /timed out|synthetic private detail/i);
      return true;
    });
    await runSystemPowerShell('synthetic');
    assert.deepEqual(observed, [60_000, 60_000, 60_000, 60_000, 60_000, 15_000]);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

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
  for (const target of ['directory', 'file', 'journal']) {
    const root = join(parent, target);
    await mkdir(root, { mode: 0o700 });
    await assertPrivateStorage(root, { created: true });
    const path = target === 'directory' ? root : join(root, target === 'journal' ? 'workspace.sqlite-journal' : 'workspace.json');
    if (target !== 'directory') await writeFile(path, '{"fake":true}', { mode: 0o600 });
    if (process.platform === 'win32') {
      const { stdout: before } = await runSystemPowerShell(`
$ErrorActionPreference = 'Stop'
$path = $env:ESQUIE_STORAGE_CHECK_PATH
$directory = (Get-Item -LiteralPath $path).PSIsContainer
$sections = [System.Security.AccessControl.AccessControlSections]::Access
$acl = if ($directory) { [IO.Directory]::GetAccessControl($path, $sections) } else { [IO.File]::GetAccessControl($path, $sections) }
$sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'ReadAndExecute', 'Allow'))
if ($directory) { [IO.Directory]::SetAccessControl($path, $acl) } else { [IO.File]::SetAccessControl($path, $acl) }
(Get-Acl -LiteralPath $path).Sddl
`, { ESQUIE_STORAGE_CHECK_PATH: path });
      await assert.rejects(assertPrivateStorage(root), /Storage is shared with another principal/);
      const { stdout: after } = await runSystemPowerShell('(Get-Acl -LiteralPath $env:ESQUIE_STORAGE_CHECK_PATH).Sddl', { ESQUIE_STORAGE_CHECK_PATH: path });
      assert.equal(after, before);
    } else {
      await chmod(path, target === 'directory' ? 0o755 : 0o644);
      const before = (await stat(path)).mode;
      await assert.rejects(assertPrivateStorage(root), /Current-user-only storage protection/);
      assert.equal((await stat(path)).mode, before);
    }
    if (target !== 'directory') assert.equal(await readFile(path, 'utf8'), '{"fake":true}');
  }
});

test('system PowerShell ignores attacker PATH and ambient secret, proxy and module settings', { skip: process.platform !== 'win32' }, async t => {
  const parent = await mkdtemp(join(tmpdir(), 'esquie-powershell-path-'));
  t.after(() => rm(parent, { force: true, recursive: true }));
  await writeFile(join(parent, 'powershell.exe'), 'not a Windows executable');
  const original = Object.fromEntries(['PATH', 'PSModulePath', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'ESQUIE_TEST_SECRET']
    .map(key => [key, process.env[key]]));
  const identityDrive = 'X:\\synthetic-owner-drive';
  process.env.PATH = parent;
  process.env.PSModulePath = parent;
  process.env.HTTP_PROXY = 'http://attacker.invalid:8181';
  process.env.HTTPS_PROXY = 'http://attacker.invalid:8181';
  process.env.ALL_PROXY = 'http://attacker.invalid:8181';
  process.env.NO_PROXY = '*';
  process.env.ESQUIE_TEST_SECRET = 'synthetic secret sentinel';
  try {
    const { executable, environment } = systemPowerShellPath();
    const { stdout } = await runSystemPowerShell(`
$ProgressPreference = 'SilentlyContinue'
$expectedPath = Join-Path $env:SystemRoot 'System32'
$powerShellPath = Join-Path $expectedPath 'WindowsPowerShell\\v1.0'
[Console]::Out.WriteLine('ENV_RESULT:' + ([pscustomobject]@{
  executable = (Get-Process -Id $PID).Path
  path = $env:PATH
  modulePath = $env:PSModulePath
  secretVisible = [bool](Test-Path Env:ESQUIE_TEST_SECRET)
  proxyVisible = [bool]((Test-Path Env:HTTP_PROXY) -or (Test-Path Env:HTTPS_PROXY) -or (Test-Path Env:ALL_PROXY) -or (Test-Path Env:NO_PROXY))
  identityDrive = $env:ESQUIE_IDENTITY_DRIVE
  input = [Console]::In.ReadToEnd()
} | ConvertTo-Json -Compress))
`, { ESQUIE_IDENTITY_DRIVE: identityDrive }, { input: 'synthetic input', includeTemp: false });
    const output = stdout.split(/\r?\n/).find(line => line.startsWith('ENV_RESULT:'));
    assert.ok(output);
    const observed = JSON.parse(output.slice('ENV_RESULT:'.length));
    assert.equal(observed.executable, executable);
    assert.equal(observed.path, environment.PATH);
    assert.ok(!observed.modulePath.toLowerCase().includes(parent.toLowerCase()), 'ambient PowerShell module paths must not be inherited');
    assert.equal(observed.secretVisible, false);
    assert.equal(observed.proxyVisible, false);
    assert.equal(observed.identityDrive, identityDrive);
    assert.equal(observed.input, 'synthetic input');
    assert.throws(() => runSystemPowerShell('Write-Output ok', { PATH: parent }), /unsupported settings/);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
