import { lstat, realpath, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runSystemPowerShell } from './private-storage.mjs';

export async function verifyLocalVolume(root) {
  if (process.platform === 'win32') {
    const drive = /^([a-z]):\\/i.exec(root)?.[1];
    if (!drive) return false;
    const { stdout } = await runSystemPowerShell(
      `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive.toUpperCase()}:'" | Select-Object DriveType,ProviderName | ConvertTo-Json -Compress)`
    );
    const volume = JSON.parse(stdout);
    return volume.DriveType === 3 && !volume.ProviderName;
  }
  const { type } = await statfs(root);
  // Only explicitly recognized local filesystems qualify; unknown/network/FUSE mounts fail closed.
  return new Set([0xef53, 0x9123683e, 0x58465342, 0x2fc12fc1, 0x1a, 0x4253584e, 0x794c7630]).has(type);
}

export async function assertOutputAllowed({ root, approved, redirected = false, verifyVolume = verifyLocalVolume }) {
  if (!approved) throw new Error('Local document output is disabled. Confirm a private, non-synced destination in Operations first.');
  if (redirected || (await lstat(root)).isSymbolicLink() || resolve(root) !== await realpath(root)) {
    throw new Error('The output workspace is redirected through a symlink or junction; file output is disabled.');
  }
  if (!await verifyVolume(root)) throw new Error('A fixed local output volume could not be established; file output is disabled.');
}

export async function assertPlainLocalFile(path) {
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || resolve(path) !== await realpath(path)) {
    throw new Error('Local document files must not be redirected through symlinks or junctions.');
  }
}
