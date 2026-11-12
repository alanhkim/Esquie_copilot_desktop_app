import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const failure = 'Current-user-only storage protection could not be verified. Use a protected local folder; existing data and existing permissions were not replaced.';
const names = ['workspace.sqlite', 'workspace.sqlite-wal', 'workspace.sqlite-shm', 'workspace.sqlite-journal', 'workspace.owner', 'workspace.json', 'workspace.lock', 'esquie-launch.html', 'documents', 'backups', 'recoveries'];
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function assertPrivateDataDirectory(path) {
  const candidate = resolve(path);
  let customSyncRoots;
  try { customSyncRoots = JSON.parse(process.env.ESQUIE_SYNC_ROOTS || '[]'); }
  catch { throw new Error('ESQUIE_SYNC_ROOTS must be a JSON array of absolute local paths.'); }
  if (!Array.isArray(customSyncRoots) || customSyncRoots.some(value => typeof value !== 'string' || !isAbsolute(value))) {
    throw new Error('ESQUIE_SYNC_ROOTS must be a JSON array of absolute local paths.');
  }
  const pathContains = (parent, child) => {
    const rel = relative(parent, child);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const syncRoots = [
    process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer,
    process.env.Dropbox, process.env.GOOGLE_DRIVE, process.env.ICLOUD_DRIVE, ...customSyncRoots
  ].filter(Boolean).map(path => resolve(path));
  if (pathContains(appRoot, candidate) || /^\\\\/.test(candidate) ||
      syncRoots.some(syncRoot => pathContains(syncRoot, candidate)) ||
      /(?:^|[\\/])(?:onedrive(?:\s+-\s+[^\\/]+)?|sharepoint|dropbox(?:\s+\([^\\/]+\))?|google[\s-]?drive|my drive|icloud(?:drive)?|box(?: sync| drive)?|nextcloud|syncthing)(?:[\\/]|$)/i.test(candidate)) {
    throw new Error('Choose a local data directory outside the application repository and cloud-synced folders.');
  }
  return candidate;
}
const allowedPowerShellEnvironment = new Set(['ESQUIE_STORAGE_CHECK_PATH', 'ESQUIE_STORAGE_CREATE_PRIVATE', 'ESQUIE_IDENTITY_DRIVE']);

export function systemPowerShellPath() {
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== 'win32' || !systemRoot || !/^[a-z]:\\/i.test(systemRoot)) {
    throw new Error('The system PowerShell installation cannot be verified.');
  }
  const system32 = join(systemRoot, 'System32');
  const powerShell = join(system32, 'WindowsPowerShell', 'v1.0');
  return {
    executable: join(powerShell, 'powershell.exe'),
    environment: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATH: `${system32};${powerShell}`,
      PSModulePath: join(powerShell, 'Modules')
    }
  };
}

export function runSystemPowerShell(script, environment = {}, {
  input = '',
  timeoutMs = 15_000,
  maxBuffer = 1_000_000,
  signal,
  includeTemp = true,
  onSpawn
} = {}) {
  if (Object.entries(environment).some(([key, value]) => !allowedPowerShellEnvironment.has(key) || typeof value !== 'string')) {
    throw new Error('The PowerShell environment contains unsupported settings.');
  }
  const { executable, environment: baseEnvironment } = systemPowerShellPath();
  const systemRoot = baseEnvironment.SystemRoot;
  const env = {
    ...baseEnvironment,
    ...(includeTemp && process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(includeTemp && process.env.TMP ? { TMP: process.env.TMP } : {}),
    ...environment
  };
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

  return new Promise((resolveResult, rejectResult) => {
    let inputError = null;
    const child = execFile(executable, args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer,
      signal,
      env: { ...env, SystemRoot: systemRoot, WINDIR: systemRoot }
    }, (error, stdout, stderr) => {
      if (inputError) {
        inputError.stdout = stdout;
        inputError.stderr = stderr;
        rejectResult(inputError);
        return;
      }
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        rejectResult(error);
      } else resolveResult({ stdout, stderr });
    });
    child.stdin.once('error', error => {
      inputError = error;
      if (!child.killed) child.kill();
    });
    if (onSpawn) {
      try { onSpawn(child); }
      catch (error) {
        child.kill();
        rejectResult(error);
        return;
      }
    }
    child.stdin.end(input);
  });
}

const windowsCheck = `
$ErrorActionPreference = 'Stop'
$path = $env:ESQUIE_STORAGE_CHECK_PATH
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($env:ESQUIE_STORAGE_CREATE_PRIVATE -eq 'true') {
  if (@(Get-ChildItem -LiteralPath $path -Force).Count -ne 0) { throw 'New storage is not empty.' }
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($user)
  $security.SetAccessRuleProtection($true, $false)
  foreach ($id in $allowed) {
    $sid = [System.Security.Principal.SecurityIdentifier]::new($id)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $security.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $security
}
$paths = @($path)
foreach ($name in @('workspace.sqlite','workspace.sqlite-wal','workspace.sqlite-shm','workspace.sqlite-journal','workspace.owner','workspace.json','workspace.lock','esquie-launch.html','documents','backups','recoveries')) {
  $candidate = Join-Path $path $name
  if (Test-Path -LiteralPath $candidate) {
    $paths += $candidate
    $item = Get-Item -LiteralPath $candidate -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected storage.' }
    if ($name -eq 'documents') {
      foreach ($document in @(Get-ChildItem -LiteralPath $candidate -Force)) {
        if ($document.PSIsContainer -or ($document.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected document storage.' }
        $paths += $document.FullName
      }
    }
    if ($name -in @('backups','recoveries')) {
      if (-not $item.PSIsContainer) { throw 'Unexpected backup storage.' }
      $directories = [System.Collections.Generic.List[string]]::new()
      $directories.Add($candidate)
      for ($index = 0; $index -lt $directories.Count; $index++) {
        foreach ($child in @(Get-ChildItem -LiteralPath $directories[$index] -Force)) {
          if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected storage.' }
          $paths += $child.FullName
          if ($child.PSIsContainer) { $directories.Add($child.FullName) }
        }
      }
    }
  }
}
foreach ($candidate in $paths) {
  $acl = Get-Acl -LiteralPath $candidate
  if ($allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Unverified storage owner.' }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne 'Allow') { continue }
    $id = $rule.IdentityReference.Value
    if ($id -eq 'S-1-3-0' -and ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    if ($allowed -notcontains $id) { throw 'Storage is shared with another principal.' }
  }
}
$parent = (Get-Item -LiteralPath $path -Force).Parent
$dangerous = [System.Security.AccessControl.FileSystemRights]'DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
while ($null -ne $parent) {
  $acl = Get-Acl -LiteralPath $parent.FullName
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value -and
        -not ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -and
        ($rule.FileSystemRights -band $dangerous)) { throw 'An ancestor permits storage replacement.' }
  }
  $parent = $parent.Parent
}
'{"private":true}'
`;

export async function assertPrivateStorage(root, { created = false } = {}) {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || resolve(root) !== await realpath(root)) throw new Error(failure);
  if (process.platform === 'win32') {
    try {
      const { stdout } = await runSystemPowerShell(windowsCheck, { ESQUIE_STORAGE_CHECK_PATH: root, ESQUIE_STORAGE_CREATE_PRIVATE: String(created) }, { timeoutMs: 60_000 });
      if (JSON.parse(stdout).private !== true) throw new Error(failure);
    } catch (error) {
      const reason = error.code == null && error.killed === true && error.signal === 'SIGTERM'
        ? 'Permission inspection was interrupted or timed out; retry when the system is less busy.'
        : [
          'New storage is not empty.', 'Redirected storage.', 'Unexpected document storage.', 'Unexpected backup storage.',
          'Unverified storage owner.', 'Storage is shared with another principal.',
          'An ancestor permits storage replacement.'
        ].find(message => error.stderr?.includes(message)) || 'Permission inspection failed or is unavailable.';
      throw new Error(`${failure} ${reason}`);
    }
    return;
  }
  const paths = [root, ...names.map(name => join(root, name))];
  for (const path of paths) {
    let file;
    try { file = await lstat(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new Error(failure); }
    if (file.isSymbolicLink() || file.uid !== process.getuid() || (file.mode & 0o077)) throw new Error(failure);
    if (path !== root && file.isDirectory()) paths.push(...(await readdir(path)).map(name => join(path, name)));
  }
}
