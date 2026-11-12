import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const project = resolve(desktop, '..');
const require = createRequire(import.meta.url);
const builder = require.resolve('electron-builder/out/cli/cli.js');
const electron = dirname(require.resolve('electron/package.json'));
const electronDist = join(electron, 'dist');
const expected = [
  'src/server.mjs', 'src/store.mjs', 'src/worker.mjs', 'src/backups.mjs', 'src/monthly-outcomes-import.mjs',
  'src/local-output.mjs', 'src/private-storage.mjs', 'src/assistant/bridge.mjs',
  'src/connectors/microsoft365.mjs', 'src/connectors/safe-file-download.mjs',
  'public/index.html', 'public/styles.css', 'public/app.js',
  'public/task-board.mjs'
];
const sentinels = [
  'src/private-sentinel.txt', 'src/private-sentinel.mjs',
  'src/scratch/private-sentinel.txt', 'src/node_modules/fake/sentinel.bin',
  'public/private-sentinel.txt', 'public/private-sentinel.js'
];

async function files(dir, root = dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await files(path, root));
    else found.push(relative(root, path).replaceAll('\\', '/'));
  }
  return found.sort();
}

const temp = await mkdtemp(join(tmpdir(), 'esquie-package-test-'));
try {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'ComSpec', 'PATH', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const name of ['home', 'appdata', 'localappdata', 'temp', 'npm-cache', 'electron-cache']) {
    await mkdir(join(temp, name));
  }
  Object.assign(env, {
    HOME: join(temp, 'home'), USERPROFILE: join(temp, 'home'),
    APPDATA: join(temp, 'appdata'), LOCALAPPDATA: join(temp, 'localappdata'),
    TEMP: join(temp, 'temp'), TMP: join(temp, 'temp'),
    npm_config_cache: join(temp, 'npm-cache'), electron_config_cache: join(temp, 'electron-cache'),
    ELECTRON_BUILDER_OFFLINE: 'true', ESQUIE_DATA_DIR: join(temp, 'data'), ESQUIE_PORT: '0'
  });
  for (const path of expected) {
    const destination = join(temp, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(project, path), destination);
  }
  for (const path of sentinels) {
    const destination = join(temp, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, 'Synthetic packaging boundary test only.');
  }
  const desktopTemp = join(temp, 'desktop');
  await mkdir(desktopTemp);
  for (const file of ['package.json', 'main.mjs', 'app.mjs', 'host.mjs']) {
    await cp(join(desktop, file), join(desktopTemp, file));
  }
  await exec(process.execPath, [
    builder, '--win', '--dir', '--x64', '--publish', 'never',
    '--config.npmRebuild=false', `--config.electronDist=${electronDist}`
  ], {
    cwd: desktopTemp, timeout: 180_000, maxBuffer: 2_000_000,
    env
  });
  const workspace = join(desktopTemp, 'dist', 'win-unpacked', 'resources', 'workspace');
  assert.deepEqual(await files(workspace), [...expected].sort());
  for (const path of expected) {
    assert.deepEqual(await readFile(join(workspace, path)), await readFile(join(project, path)), path);
  }
  const packagedServer = join(workspace, 'src', 'server.mjs');
  const script = [
    "import { pathToFileURL } from 'node:url';",
    "for (const name of ['NODE_OPTIONS', 'ESQUIE_SDK_PATH', 'SYNTHETIC_SECRET']) if (process.env[name]) throw new Error('Ambient environment leaked.');",
    "const modulePath = process.argv[1];",
    "process.argv[1] = '';",
    "const { startServer } = await import(pathToFileURL(modulePath).href);",
    "const app = await startServer({ dataDir: process.argv[2], port: 0, workerIntervalMs: 0 });",
    "try {",
    "  if (!(await fetch(`${app.url}/api/health`)).ok) throw new Error('Health check failed.');",
    "  const module = await fetch(`${app.url}/task-board.mjs`);",
    "  if (!module.ok || !/^text\\/javascript(?:;|$)/.test(module.headers.get('content-type'))) throw new Error('Task board module missing or not JavaScript.');",
    "  if (!(await module.text()).includes('export function matchingTasks')) throw new Error('Task board module content missing.');",
    "}",
    'finally { await app.close(); }'
  ].join('\n');
  await exec(process.execPath, ['--input-type=module', '-e', script, packagedServer, join(temp, 'data')], {
    cwd: temp, timeout: 30_000, maxBuffer: 1_000_000,
    env
  });
  console.log('Packaging boundary passed: exact runtime files, no synthetic private files, packaged backend starts.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
