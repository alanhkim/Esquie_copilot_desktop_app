import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWindowsOcrService, decodeWindowsOcrImage, recognizeWindowsScreenshot } from '../src/windows-ocr.mjs';
import { runSystemPowerShell } from '../src/private-storage.mjs';
import { reserveOcrIfConnected, startServer } from '../src/server.mjs';

function pngHeader(width, height) {
  const image = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  image.writeUInt32BE(13, 8);
  image.write('IHDR', 12, 'ascii');
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return image.toString('base64');
}

async function makeSyntheticScreenshot() {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = [System.Drawing.Bitmap]::new(1000, 220)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$stream = [System.IO.MemoryStream]::new()
try {
  $graphics.Clear([System.Drawing.Color]::White)
  $font = [System.Drawing.Font]::new('Arial', 42, [System.Drawing.FontStyle]::Regular)
  $graphics.DrawString('SYNTHETIC WORKSHOP 2026', $font, [System.Drawing.Brushes]::Black, 20, 60)
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [Console]::Out.WriteLine('SYNTHETIC_IMAGE:' + [Convert]::ToBase64String($stream.ToArray()))
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
  $stream.Dispose()
}
`;
  try {
    const { stdout } = await runSystemPowerShell(script, {}, {
      timeoutMs: 15_000, maxBuffer: 1_000_000, includeTemp: false
    });
    const base64 = stdout.match(/^SYNTHETIC_IMAGE:([A-Za-z0-9+/=]+)$/m)?.[1];
    return base64 ? Buffer.from(base64, 'base64') : null;
  } catch {
    return null;
  }
}

function longPowerShellExecutor(onSpawn, failure = false) {
  const script = failure
    ? "$ErrorActionPreference='Stop'; throw 'synthetic process failure'"
    : "[Console]::Out.WriteLine('SYNTHETIC_OCR_STARTED'); Start-Sleep -Seconds 30";
  return (_ocrScript, _environment, options) => runSystemPowerShell(script, {}, {
    ...options,
    input: '',
    onSpawn: child => child.once('spawn', () => onSpawn(child.pid))
  });
}

function processStarted() {
  let resolvePid;
  const promise = new Promise(resolve => { resolvePid = resolve; });
  return { promise, resolve: resolvePid };
}

async function assertProcessExited(pid) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`PowerShell child ${pid} remained active after cancellation.`);
}

test('Windows OCR image validation enforces format, byte, and pixel limits', () => {
  assert.throws(() => decodeWindowsOcrImage('image/png', 'not-base64'), error => error.status === 400);
  assert.throws(() => decodeWindowsOcrImage('image/gif', 'AAAA'), error => error.status === 415);
  assert.throws(() => decodeWindowsOcrImage('image/png', pngHeader(4096, 4096)), error => error.status === 413);
  const oversized = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
  assert.throws(() => decodeWindowsOcrImage('image/png', oversized), error => error.status === 413);
  const image = decodeWindowsOcrImage('image/png', pngHeader(1200, 900));
  assert.equal(image.readUInt32BE(16), 1200);
  image.fill(0);
});

test('OCR route does not reserve a child when disconnect state predates listener registration', () => {
  const signal = new AbortController().signal;
  let reservations = 0;
  const service = { reserve() { reservations++; return {}; } };
  assert.equal(reserveOcrIfConnected(service, { aborted: false }, { destroyed: true }, signal), null);
  assert.equal(reservations, 0);
  assert.deepEqual(reserveOcrIfConnected(service, { aborted: false }, { destroyed: false, socket: { destroyed: false } }, signal), {});
  assert.equal(reservations, 1);
});

test('Node child-process timeout shapes are reported as OCR timeouts', async () => {
  const timeout = Object.assign(new Error('PowerShell was terminated.'), {
    code: null, signal: 'SIGTERM', killed: true
  });
  await assert.rejects(
    recognizeWindowsScreenshot(Buffer.from('synthetic screenshot'), {
      platform: 'win32',
      execute: async () => { throw timeout; }
    }),
    error => error.status === 504 && /timed out/.test(error.message)
  );
});

test('PowerShell stdin errors fail the operation and stop the child', { skip: process.platform !== 'win32' }, async () => {
  const child = processStarted();
  const operation = runSystemPowerShell('Start-Sleep -Seconds 30', {}, {
    timeoutMs: 10_000,
    onSpawn: process => process.once('spawn', () => {
      child.resolve(process.pid);
      process.stdin.destroy(new Error('synthetic stdin failure'));
    })
  });
  const pid = await child.promise;
  await assert.rejects(operation, /synthetic stdin failure/);
  await assertProcessExited(pid);
});

test('authenticated screenshot OCR stays local and does not import outcomes automatically', { skip: process.platform !== 'win32' }, async t => {
  const screenshot = await makeSyntheticScreenshot();
  if (!screenshot) {
    t.skip('Windows synthetic screenshot generation is unavailable.');
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-windows-ocr-'));
  const decoyPath = await mkdtemp(join(tmpdir(), 'esquie-fake-powershell-'));
  await writeFile(join(decoyPath, 'powershell.exe'), 'not a Windows executable');
  t.after(() => rm(decoyPath, { force: true, recursive: true }));
  const imageBase64 = screenshot.toString('base64');
  let commandLine;
  let receivedInput;
  let scriptContainsImage;
  let tempEnabled;
  const service = createWindowsOcrService({
    execute: (script, environment, options) => {
      receivedInput = options.input;
      scriptContainsImage = script.includes(imageBase64) || JSON.stringify(environment).includes(imageBase64);
      tempEnabled = options.includeTemp;
      return runSystemPowerShell(script, environment, {
        ...options,
        onSpawn: child => { commandLine = child.spawnargs.join(' '); }
      });
    }
  });
  let app = await startServer({ dataDir, port: 0, workerIntervalMs: 0, windowsOcrService: service });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const body = JSON.stringify({ mimeType: 'image/png', imageBase64 });
  const endpoint = `${app.url}/api/outcomes/import/ocr`;
  const origin = { Origin: app.url, 'Content-Type': 'application/json' };

  const unauthorized = await fetch(endpoint, { method: 'POST', headers: origin, body });
  assert.equal(unauthorized.status, 401);
  const csrfToken = (await (await fetch(`${app.url}/api/state`, {
    headers: { 'X-Esquie-Access': app.accessToken }
  })).json()).csrfToken;
  const filesBeforeOcr = (await readdir(dataDir)).sort();
  const missingCsrf = await fetch(endpoint, {
    method: 'POST', headers: { ...origin, 'X-Esquie-Access': app.accessToken }, body
  });
  assert.equal(missingCsrf.status, 403);

  const parentPath = process.env.PATH;
  process.env.PATH = decoyPath;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...origin, 'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': csrfToken },
      body
    });
  } finally {
    if (parentPath === undefined) delete process.env.PATH;
    else process.env.PATH = parentPath;
  }
  if (response.status === 503) {
    assert.match((await response.json()).error, /Windows OCR|language pack/);
    assert.equal((await (await fetch(`${app.url}/api/state`, {
      headers: { 'X-Esquie-Access': app.accessToken }
    })).json()).records.length, 0);
    assert.deepEqual((await readdir(dataDir)).sort(), filesBeforeOcr);
    screenshot.fill(0);
    return;
  }
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.mode, 'on-device-windows-ocr');
  assert.equal(result.imported, false);
  assert.match(result.text, /SYNTHETIC WORKSHOP 2026/i);
  assert.equal(receivedInput, imageBase64);
  assert.equal(tempEnabled, false);
  assert.equal(scriptContainsImage, false);
  assert.equal(commandLine.includes(imageBase64), false);
  const state = await (await fetch(`${app.url}/api/state`, {
    headers: { 'X-Esquie-Access': app.accessToken }
  })).json();
  assert.equal(state.records.length, 0);
  assert.equal(JSON.stringify(state).includes(imageBase64), false);
  assert.deepEqual((await readdir(dataDir)).sort(), filesBeforeOcr);
  screenshot.fill(0);
});

test('one OCR process is allowed; concurrent requests see busy and disconnect reaps the child', { skip: process.platform !== 'win32' }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-ocr-busy-'));
  const child = processStarted();
  const service = createWindowsOcrService({ execute: longPowerShellExecutor(child.resolve) });
  const app = await startServer({ dataDir, port: 0, workerIntervalMs: 0, windowsOcrService: service });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const ownerState = await (await fetch(`${app.url}/api/state`, {
    headers: { 'X-Esquie-Access': app.accessToken, Connection: 'close' }
  })).json();
  const headers = {
    Origin: app.url,
    'Content-Type': 'application/json',
    'X-Esquie-Access': app.accessToken,
    'X-Esquie-CSRF': ownerState.csrfToken,
    Connection: 'close'
  };
  const body = JSON.stringify({ mimeType: 'image/png', imageBase64: pngHeader(1200, 900) });
  const abort = new AbortController();
  const first = fetch(`${app.url}/api/outcomes/import/ocr`, {
    method: 'POST', headers, body, signal: abort.signal
  });
  const pid = await child.promise;

  const busy = await fetch(`${app.url}/api/outcomes/import/ocr`, { method: 'POST', headers, body });
  assert.equal(busy.status, 429);
  assert.match((await busy.json()).error, /already in progress/);
  abort.abort();
  await assert.rejects(first);
  await assertProcessExited(pid);
  assert.equal((await (await fetch(`${app.url}/api/state`, {
    headers: { 'X-Esquie-Access': app.accessToken }
  })).json()).records.length, 0);
});

test('server shutdown cancels and reaps its active OCR child', { skip: process.platform !== 'win32' }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-ocr-shutdown-'));
  const child = processStarted();
  const service = createWindowsOcrService({ execute: longPowerShellExecutor(child.resolve) });
  const app = await startServer({ dataDir, port: 0, workerIntervalMs: 0, windowsOcrService: service });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const ownerState = await (await fetch(`${app.url}/api/state`, {
    headers: { 'X-Esquie-Access': app.accessToken, Connection: 'close' }
  })).json();
  const responsePromise = fetch(`${app.url}/api/outcomes/import/ocr`, {
    method: 'POST',
    headers: {
      Origin: app.url,
      'Content-Type': 'application/json',
      'X-Esquie-Access': app.accessToken,
      'X-Esquie-CSRF': ownerState.csrfToken,
      Connection: 'close'
    },
    body: JSON.stringify({ mimeType: 'image/png', imageBase64: pngHeader(1200, 900) })
  }).then(async response => ({ status: response.status, body: await response.json() }));
  const pid = await child.promise;
  await app.close();
  const response = await responsePromise;
  assert.equal(response.status, 503);
  assert.match(response.body.error, /cancelled|shutting down/);
  await assertProcessExited(pid);
});

test('a failed OCR process exits and releases the active slot', { skip: process.platform !== 'win32' }, async () => {
  const child = processStarted();
  const service = createWindowsOcrService({ execute: longPowerShellExecutor(child.resolve, true) });
  const slot = service.reserve();
  const operation = slot.run(Buffer.from('synthetic screenshot'));
  const pid = await child.promise;
  await assert.rejects(operation, error => error.status === 422);
  await slot.release();
  await assertProcessExited(pid);
  await service.close();
  assert.throws(() => service.reserve(), error => error.status === 503);
});

test('non-Windows hosts report OCR unavailable instead of using a remote fallback', { skip: process.platform === 'win32' }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-no-windows-ocr-'));
  let app = await startServer({ dataDir, port: 0, workerIntervalMs: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const ownerState = await (await fetch(`${app.url}/api/state`, {
    headers: { 'X-Esquie-Access': app.accessToken }
  })).json();
  const response = await fetch(`${app.url}/api/outcomes/import/ocr`, {
    method: 'POST',
    headers: {
      Origin: app.url,
      'Content-Type': 'application/json',
      'X-Esquie-Access': app.accessToken,
      'X-Esquie-CSRF': ownerState.csrfToken
    },
    body: JSON.stringify({ mimeType: 'image/png', imageBase64: pngHeader(1200, 900) })
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /unavailable here/);
  assert.equal((await (await fetch(`${app.url}/api/state`, {
    headers: { 'X-Esquie-Access': app.accessToken }
  })).json()).records.length, 0);
});
