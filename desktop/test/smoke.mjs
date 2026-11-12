import { app } from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktop } from '../app.mjs';

const temp = mkdtempSync(join(tmpdir(), 'esquie-desktop-smoke-'));
app.setPath('userData', join(temp, 'electron'));
const synthetic = process.argv.includes('--synthetic');
const serverPath = synthetic ? fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url)) : undefined;
const desktop = createDesktop({ dataDir: join(temp, 'workspace'), serverPath });
let failure;
let endpoint;
app.on('will-quit', () => {
  Promise.resolve().then(async () => {
    if (endpoint) {
      try {
        await fetch(`${endpoint}/api/health`, { signal: AbortSignal.timeout(2000) });
        throw new Error('Owned backend remained available after quit.');
      } catch (error) {
        if (error.message === 'Owned backend remained available after quit.') throw error;
      }
    }
    await rm(temp, { recursive: true, force: true });
  }).then(() => process.exit(failure ? 1 : 0), error => {
    console.error(error);
    process.exit(1);
  });
});
if (!desktop.register()) {
  console.error('Could not acquire the isolated smoke-test instance lock.');
  process.exit(1);
}
const timeout = setTimeout(() => {
  failure = new Error('Desktop smoke test timed out.');
  console.error(failure);
  app.quit();
}, 30000);
desktop.ready().then(async () => {
  const window = desktop.getWindow();
  const backend = desktop.getBackend();
  endpoint = backend.url;
  assert.ok(window.isVisible());
  if (synthetic) assert.ok(window.webContents.getURL() === backend.launchUrl, 'Synthetic launch URL was not loaded.');
  assert.equal((await fetch(`${backend.url}/api/health`)).ok, true);
  assert.ok(await import('node:sqlite'));
  window.close();
  assert.equal(window.isVisible(), false);
  desktop.show();
  assert.equal(window.isVisible(), true);
  await new Promise((resolve, reject) => {
    window.webContents.once('did-finish-load', resolve);
    window.webContents.once('did-fail-load', (_event, code, message) => reject(new Error(`${code}: ${message}`)));
    window.reload();
  });
  if (synthetic) assert.ok(window.webContents.getURL() === backend.launchUrl, 'Synthetic launch URL was not retained after reload.');
  console.log('Windows Electron smoke: health, node:sqlite, window, hide and reopen passed.');
}).catch(error => {
  failure = error;
  console.error(error);
}).finally(() => {
  clearTimeout(timeout);
  app.quit();
});
