import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { test } from 'node:test';
import { createMonthlyOutcomesWorkbook, MAX_MONTHLY_OUTCOMES_XLSX_BYTES } from '../src/monthly-outcomes-xlsx.mjs';
import { monthlyOutcomeRecords, monthlyOutcomesSnapshotHash } from '../public/outcome-export-workflow.mjs';
import { startServer } from '../src/server.mjs';
import { openStore } from '../src/store.mjs';

const exec = promisify(execFile);
const pythonExecutable = process.env.PYTHON || 'python';
const xstringCases = [
  ['_x0041_', '_x005F_x0041_'],
  ['_x000D_', '_x005F_x000D_'],
  ['_x005F_', '_x005F_x005F_'],
  ['_x0041__x0042_', '_x005F_x0041__x005F_x0042_'],
  ['_x0041_x0042_', '_x005F_x0041_x005F_x0042_'],
  ['_x005F_x0041_', '_x005F_x005F_x005F_x0041_'],
  ['before\r\nafter', 'before_x000D_\nafter'],
  ['_x00aF_ & <🐈>', '_x005F_x00aF_ &amp; &lt;🐈&gt;'],
  ['_xG041_ _x004_ plain_', '_xG041_ _x004_ plain_']
];
const pythonReader = `
import json
import sys
from openpyxl import load_workbook
from openpyxl.utils.escape import unescape

workbook = load_workbook(sys.argv[1], read_only=True, data_only=False)
sheet = workbook['Monthly Outcomes']
assert [sheet.cell(5, column).value for column in range(1, 10)] == [
    'Category', 'Date', 'Account', 'Workshop', 'Title', 'Status',
    'Notes', 'Source URL (not fetched)', 'Owner-provided provenance'
]
assert [sheet.cell(6, column).value for column in range(1, 10)] == [
    'outcome', '2026-03-04', 'Example', 'Café <synthetic> & workshop',
    '=1+1', 'Not provided', '+SUM(A1:A2)',
    'https://example.invalid/?q=%3D1%2B1', 'owner-pasted-unverified'
]
assert sheet['E6'].value == '=1+1'
assert sheet['E6'].data_type == 's'
assert sheet['G6'].value == '+SUM(A1:A2)'
assert sheet['H6'].value == 'https://example.invalid/?q=%3D1%2B1'
assert sheet['I6'].value == 'owner-pasted-unverified'
assert sheet['D6'].value == 'Café <synthetic> & workshop'
assert sheet['A6'].data_type == 's'
assert sheet['A5'].font.name == 'Arial'
assert sheet['A5'].font.bold
assert sheet['G7'].value == ''
assert sheet['E7'].value == '0'
assert sheet['E7'].data_type == 's'
expected_cases = json.loads(sys.argv[2])
for row, expected in enumerate(expected_cases, start=8):
    cell = sheet.cell(row, 5)
    assert cell.data_type == 's'
    assert unescape(cell.value) == expected
assert sheet.max_row == 7 + len(expected_cases)
assert not workbook._external_links
workbook.close()
`;

function sanitizedPythonEnvironment() {
  const env = { PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return env;
}

async function openpyxlUnavailableReason(executable = pythonExecutable) {
  try {
    await exec(executable, ['-I', '-B', '-c', 'import openpyxl'], {
      env: sanitizedPythonEnvironment(),
      timeout: 10_000,
      maxBuffer: 100_000
    });
    return null;
  } catch (error) {
    if (error.code === 'ENOENT') return `Python executable "${executable}" is unavailable.`;
    if (error.code === 1 && /ModuleNotFoundError: No module named ['"]openpyxl['"]/.test(error.stderr || '')) {
      return 'openpyxl is unavailable to the isolated Python interpreter.';
    }
    throw error;
  }
}

function unzipStored(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0);
  const count = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedBytes = buffer.readUInt32LE(cursor + 20);
    const uncompressedBytes = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
    assert.equal(buffer.readUInt16LE(localOffset + 8), 0);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const contentStart = localOffset + 30 + localNameLength + localExtraLength;
    const content = buffer.subarray(contentStart, contentStart + compressedBytes);
    assert.equal(compressedBytes, uncompressedBytes);
    assert.equal(crc32(content) >>> 0, checksum);
    entries.set(name, content);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function syntheticRecord(overrides = {}) {
  return {
    id: randomUUID(), category: 'outcome', date: '2026-03-04',
    title: '=1+1', note: '+SUM(A1:A2)', sourceUrl: 'https://example.invalid/?q=%3D1%2B1',
    provenance: 'owner-pasted-unverified',
    workshopImport: { account: 'Example', workshop: 'Café <synthetic> & workshop', status: 'Not provided' },
    ...overrides
  };
}

function syntheticWorkbook() {
  return createMonthlyOutcomesWorkbook([
    syntheticRecord(),
    syntheticRecord({
      date: '', title: '0', note: '', sourceUrl: '', provenance: '',
      workshopImport: { account: '', workshop: '', status: '' }
    }),
    ...xstringCases.map(([title]) => syntheticRecord({ title }))
  ]);
}

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'esquie-xlsx-export-'));
  let app = await startServer({
    dataDir: root, port: 0, workerIntervalMs: 0, verifyLocalVolume: async () => true, ...options
  });
  t.after(async () => { await app.close(); await rm(root, { force: true, recursive: true }); });
  const state = async () => (await fetch(`${app.url}/api/state`, {
    headers: { 'X-Esquie-Access': app.accessToken }
  })).json();
  const request = async (path, body, method = 'POST') => fetch(`${app.url}${path}`, {
    method,
    headers: {
      Origin: app.url, 'Content-Type': 'application/json',
      'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': (await state()).csrfToken
    },
    body: JSON.stringify(body)
  });
  return {
    root, get app() { return app; }, state, request,
    async authorizeOutput() {
      const response = await request('/api/output-approval', { confirmPrivateNonSynced: true });
      assert.equal(response.status, 200);
    },
    async addOutcome(fields = {}) {
      const response = await request('/api/records', {
        category: 'outcome', title: 'Synthetic local outcome', note: 'Synthetic note', date: '2026-03-04', ...fields
      });
      assert.equal(response.status, 201);
      return (await response.json()).record;
    },
    async exportRequest({ requestId = randomUUID(), records } = {}) {
      const current = records || (await state()).records;
      const selected = monthlyOutcomeRecords(current);
      return request('/api/outcomes/export', {
        requestId, snapshotHash: await monthlyOutcomesSnapshotHash(selected), recordCount: selected.length
      });
    },
    async restart() {
      await app.close();
      app = await startServer({
        dataDir: root, port: 0, workerIntervalMs: 0, verifyLocalVolume: async () => true, ...options
      });
    }
  };
}

test('mandatory Node-only OOXML checks verify ZIP, headers, literal cells, and inert formula-like text', () => {
  const workbook = syntheticWorkbook();
  assert.ok(workbook.length > 0 && workbook.length <= MAX_MONTHLY_OUTCOMES_XLSX_BYTES);
  const entries = unzipStored(workbook);
  assert.deepEqual([...entries.keys()].sort(), [
    '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'
  ]);
  const sheet = entries.get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.match(sheet, /t="inlineStr"/);
  assert.doesNotMatch(sheet, /<f(?:\s|>)/);
  assert.doesNotMatch(sheet, /hyperlink|externalLinks/i);
  assert.match(sheet, /<t xml:space="preserve">Category<\/t>/);
  assert.match(sheet, /<t xml:space="preserve">Owner-provided provenance<\/t>/);
  assert.match(sheet, /r="E6"[^>]*t="inlineStr"><is><t xml:space="preserve">=1\+1<\/t>/);
  assert.match(sheet, /r="G6"[^>]*t="inlineStr"><is><t xml:space="preserve">\+SUM\(A1:A2\)<\/t>/);
  assert.match(sheet, /Café &lt;synthetic&gt; &amp; workshop/);
  assert.match(sheet, /r="G7"[^>]*t="inlineStr"><is><t xml:space="preserve"><\/t>/);
  assert.match(sheet, /r="E7"[^>]*t="inlineStr"><is><t xml:space="preserve">0<\/t>/);
});

test('literal Xstring tokens, overlap, and carriage returns round-trip in one decode pass', () => {
  const sheet = unzipStored(syntheticWorkbook()).get('xl/worksheets/sheet1.xml').toString('utf8');
  for (const [index, [original, encoded]] of xstringCases.entries()) {
    const row = index + 8;
    const match = sheet.match(new RegExp(`<c r="E${row}" t="inlineStr"><is><t xml:space="preserve">([\\s\\S]*?)</t></is></c>`));
    assert.ok(match, `missing literal text cell E${row}`);
    assert.equal(match[1], encoded);
    const xmlDecoded = match[1].replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'"
    })[entity]);
    const decoded = xmlDecoded.replace(/_x([0-9a-fA-F]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    assert.equal(decoded, original);
  }
});

test('optional openpyxl reader verifies the generated workbook when Python and openpyxl are available', async t => {
  const unavailable = await openpyxlUnavailableReason();
  if (unavailable) {
    t.skip(`Optional independent workbook parse skipped: ${unavailable}`);
    return;
  }
  const workbook = syntheticWorkbook();
  const directory = await mkdtemp(join(tmpdir(), 'esquie-openpyxl-reader-'));
  const path = join(directory, 'synthetic.xlsx');
  t.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(path, workbook, { mode: 0o600 });
  await exec(pythonExecutable, ['-I', '-B', '-c', pythonReader, path, JSON.stringify(xstringCases.map(([value]) => value))], {
    env: sanitizedPythonEnvironment(),
    timeout: 30_000, maxBuffer: 1_000_000
  });
});

test('empty workbooks load and oversized or XML-invalid records fail visibly', async () => {
  const empty = createMonthlyOutcomesWorkbook([]);
  const entries = unzipStored(empty);
  assert.doesNotMatch(entries.get('xl/worksheets/sheet1.xml').toString('utf8'), /<autoFilter/);
  assert.throws(() => createMonthlyOutcomesWorkbook([
    syntheticRecord({ note: 'x'.repeat(4_000) }),
    ...Array.from({ length: 300 }, () => syntheticRecord({ note: 'x'.repeat(4_000) }))
  ]), /1 MiB/);
  assert.throws(() => createMonthlyOutcomesWorkbook(
    Array.from({ length: 140 }, () => syntheticRecord({ note: '_x0041_'.repeat(571) }))
  ), /1 MiB/);
  assert.throws(() => createMonthlyOutcomesWorkbook([syntheticRecord({ title: 'bad\u0001cell' })]), /character/);
});

test('committed export receipts replay historical snapshots across record changes and restart', async t => {
  const context = await setup(t);
  await context.authorizeOutput();
  const record = await context.addOutcome({ title: '=1+1', note: '+SUM(A1:A2)' });
  const requestId = randomUUID();
  const first = await context.exportRequest({ requestId });
  assert.equal(first.status, 200);
  const response = await first.json();
  assert.equal(response.reused, false);
  assert.equal(response.export.id, requestId);
  assert.equal(response.export.format, 'xlsx');
  assert.ok(response.export.contentBytes > 0 && response.export.contentBytes <= MAX_MONTHLY_OUTCOMES_XLSX_BYTES);
  assert.equal(response.export.contentSha256, createHash('sha256')
    .update(await readFile(join(context.root, 'documents', response.export.fileName))).digest('hex'));
  const inspection = await context.request('/api/outcomes/export/status', { requestId });
  assert.equal(inspection.status, 200);
  assert.equal((await inspection.json()).status, 'committed');
  assert.equal((await fetch(`${context.app.url}/api/documents/${requestId}`, {
    headers: { 'X-Esquie-Access': context.app.accessToken }
  })).status, 409);

  const file = join(context.root, 'documents', response.export.fileName);
  const original = await readFile(file);
  const changedIntent = await context.exportRequest({ requestId, records: [] });
  assert.equal(changedIntent.status, 409);

  const retry = await context.exportRequest({ requestId, records: [record] });
  assert.equal(retry.status, 200);
  const retryReceipt = await retry.json();
  assert.equal(retryReceipt.reused, true);
  assert.deepEqual(retryReceipt.export, response.export);
  assert.deepEqual(await readFile(file), original);

  await context.addOutcome({ title: 'Later synthetic outcome' });
  const changedRecordsReplay = await context.exportRequest({ requestId, records: [record] });
  assert.equal(changedRecordsReplay.status, 200);
  const changedRecordsReceipt = await changedRecordsReplay.json();
  assert.equal(changedRecordsReceipt.reused, true);
  assert.deepEqual(changedRecordsReceipt.export, response.export);
  assert.deepEqual(await readFile(file), original);
  assert.equal((await context.state()).documents.length, 1);
  assert.deepEqual((await readdir(join(context.root, 'documents'))).sort(), [response.export.fileName]);

  const staleNewRequest = await context.exportRequest({ requestId: randomUUID(), records: [record] });
  assert.equal(staleNewRequest.status, 409);
  assert.deepEqual(await readFile(file), original);
  assert.equal((await context.state()).documents.length, 1);
  assert.equal(record.title, '=1+1');

  await context.restart();
  const restarted = await context.state();
  assert.equal(restarted.documents.length, 1);
  assert.equal(restarted.documents[0].contentSha256, response.export.contentSha256);
  assert.deepEqual(await readFile(file), original);
  const afterRestart = await context.exportRequest({ requestId, records: [record] });
  assert.equal(afterRestart.status, 200);
  const afterRestartReceipt = await afterRestart.json();
  assert.equal(afterRestartReceipt.reused, true);
  assert.deepEqual(afterRestartReceipt.export, response.export);
  assert.deepEqual(await readFile(file), original);
  assert.equal((await context.state()).documents.length, 1);
});

test('a verified workbook round-trips through typed backup and paused recovery; tampering is refused', async t => {
  const context = await setup(t);
  await context.authorizeOutput();
  await context.addOutcome({ title: 'Synthetic backup outcome' });
  const response = await context.exportRequest();
  const exported = await response.json();
  assert.equal(response.status, 200);
  const sourcePath = join(context.root, 'documents', exported.export.fileName);
  const content = await readFile(sourcePath);
  const queued = await context.request('/api/jobs', { kind: 'backup', requestId: randomUUID() });
  assert.equal(queued.status, 202);
  const jobId = (await queued.json()).job.id;
  await context.app.worker.tick();
  const backup = (await context.state()).backups[0];
  assert.equal((await context.state()).jobs.find(item => item.id === jobId).status, 'partial');
  assert.equal(backup.coverage.documents.includedCount, 1);
  const backupPath = join(context.root, 'backups', backup.id, 'documents', exported.export.fileName);
  assert.deepEqual(await readFile(backupPath), content);

  const recoveredResponse = await context.request(`/api/backups/${backup.id}/recover`, { confirmSeparateWorkspace: true });
  assert.equal(recoveredResponse.status, 201);
  const recovery = (await recoveredResponse.json()).recovery;
  const recoveredStateStore = await openStore(recovery.directory);
  try {
    const document = recoveredStateStore.state.documents.find(item => item.id === exported.export.id);
    assert.equal(document.format, 'xlsx');
    assert.equal(document.contentSha256, exported.export.contentSha256);
    assert.equal(document.fileUnavailableReason, undefined);
  } finally { await recoveredStateStore.close(); }
  assert.deepEqual(await readFile(join(recovery.directory, 'documents', exported.export.fileName)), content);

  await writeFile(backupPath, Buffer.from('tampered synthetic workbook'), { mode: 0o600 });
  const rejected = await context.request(`/api/backups/${backup.id}/recover`, { confirmSeparateWorkspace: true });
  assert.equal(rejected.status, 409);
  assert.equal(await readFile(backupPath, 'utf8'), 'tampered synthetic workbook');
  assert.deepEqual(await readFile(sourcePath), content);
});

test('a tampered source workbook blocks backup without modifying the source', async t => {
  const context = await setup(t);
  await context.authorizeOutput();
  await context.addOutcome();
  const exported = await (await context.exportRequest()).json();
  const path = join(context.root, 'documents', exported.export.fileName);
  const original = await readFile(path);
  const tampered = Buffer.concat([original, Buffer.from('synthetic edit')]);
  await writeFile(path, tampered, { mode: 0o600 });
  const queued = await context.request('/api/jobs', { kind: 'backup', requestId: randomUUID() });
  assert.equal(queued.status, 202);
  await context.app.worker.tick();
  const state = await context.state();
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.backups.length, 0);
  assert.deepEqual(await readFile(path), tampered);
});

test('a tampered exported workbook is neither reused nor overwritten and is reported unverified', async t => {
  const context = await setup(t);
  await context.authorizeOutput();
  await context.addOutcome();
  const requestId = randomUUID();
  const first = await context.exportRequest({ requestId });
  const receipt = (await first.json()).export;
  const path = join(context.root, 'documents', receipt.fileName);
  const tampered = Buffer.concat([await readFile(path), Buffer.from('synthetic edit')]);
  await writeFile(path, tampered, { mode: 0o600 });
  const retry = await context.exportRequest({ requestId });
  assert.equal(retry.status, 409);
  assert.deepEqual(await readFile(path), tampered);
  const inspection = await context.request('/api/outcomes/export/status', { requestId });
  assert.equal((await inspection.json()).status, 'unverified');
});

test('approval revoked before exclusive creation prevents a delayed workbook from being written', async t => {
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const context = await setup(t, {
    buildMonthlyOutcomesWorkbook: async records => {
      entered();
      await gate;
      return createMonthlyOutcomesWorkbook(records);
    }
  });
  await context.authorizeOutput();
  await context.addOutcome();
  const requestId = randomUUID();
  const pending = context.exportRequest({ requestId });
  await waiting;
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: false })).status, 200);
  release();
  const response = await pending;
  assert.equal(response.status, 403);
  await assert.rejects(readdir(join(context.root, 'documents')), { code: 'ENOENT' });
  assert.equal((await context.state()).documents.length, 0);
  const inspection = await context.request('/api/outcomes/export/status', { requestId });
  assert.equal((await inspection.json()).status, 'interrupted');
  assert.equal((await context.state()).outcomeExportRequests.length, 1);
});

test('revocation after exclusive file creation preserves the completed and verified generation receipt', async t => {
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const context = await setup(t, {
    writeMonthlyOutcomesFile: async (descriptor, workbook) => {
      entered();
      await gate;
      writeFileSync(descriptor, workbook);
    }
  });
  await context.authorizeOutput();
  await context.addOutcome();
  const pending = context.exportRequest();
  await waiting;
  assert.equal((await context.request('/api/output-approval', { confirmPrivateNonSynced: false })).status, 200);
  release();
  const response = await pending;
  assert.equal(response.status, 200);
  const receipt = (await response.json()).export;
  const state = await context.state();
  assert.equal(state.preferences.localOutputApproved, false);
  assert.equal(state.documents.length, 1);
  assert.equal(state.documents[0].contentBytes, receipt.contentBytes);
  assert.equal(state.documents[0].contentSha256, receipt.contentSha256);
  assert.equal(createHash('sha256').update(await readFile(join(context.root, 'documents', receipt.fileName))).digest('hex'), receipt.contentSha256);
});

test('an existing file without a receipt is preserved and never replaced', async t => {
  const context = await setup(t);
  await context.authorizeOutput();
  const requestId = randomUUID();
  const path = join(context.root, 'documents', `monthly-outcomes-${requestId}.xlsx`);
  const folder = join(context.root, 'documents');
  await mkdir(folder, { mode: 0o700 });
  const original = Buffer.from('untracked synthetic file');
  await writeFile(path, original, { mode: 0o600 });
  const response = await context.exportRequest({ requestId });
  assert.equal(response.status, 409);
  assert.deepEqual(await readFile(path), original);
  assert.equal((await context.state()).documents.length, 0);
  const inspection = await context.request('/api/outcomes/export/status', { requestId });
  assert.equal((await inspection.json()).status, 'untracked');
});

test('concurrent identical submits share one generated workbook and one saved receipt', async t => {
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let builds = 0;
  t.after(() => release());
  const context = await setup(t, {
    buildMonthlyOutcomesWorkbook: async records => {
      builds++;
      entered();
      await gate;
      return createMonthlyOutcomesWorkbook(records);
    }
  });
  await context.authorizeOutput();
  await context.addOutcome();
  const requestId = randomUUID();
  const first = context.exportRequest({ requestId });
  await waiting;
  const inspection = await context.request('/api/outcomes/export/status', { requestId });
  assert.equal((await inspection.json()).status, 'running');
  const second = context.exportRequest({ requestId });
  release();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(builds, 1);
  assert.equal((await firstResponse.json()).reused, false);
  assert.equal((await secondResponse.json()).reused, true);
  assert.equal((await context.state()).documents.length, 1);
  assert.deepEqual((await readdir(join(context.root, 'documents'))).sort(), [`monthly-outcomes-${requestId}.xlsx`]);
});

test('unresolved requests survive restart, block a new ID, and clear only after explicit inspection', async t => {
  let failGeneration = true;
  const context = await setup(t, {
    buildMonthlyOutcomesWorkbook(records) {
      if (failGeneration) throw new Error('synthetic generation interruption');
      return createMonthlyOutcomesWorkbook(records);
    }
  });
  await context.authorizeOutput();
  const record = await context.addOutcome();
  const requestId = randomUUID();
  assert.equal((await context.exportRequest({ requestId })).status, 500);
  assert.equal((await context.state()).outcomeExportRequests.length, 1);
  await context.restart();

  const inspection = await context.request('/api/outcomes/export/status', { requestId });
  assert.equal((await inspection.json()).status, 'interrupted');
  await context.addOutcome({ title: 'Later synthetic unresolved outcome' });
  const staleUnresolvedReplay = await context.exportRequest({ requestId, records: [record] });
  assert.equal(staleUnresolvedReplay.status, 409);
  assert.equal((await context.state()).outcomeExportRequests.length, 1);
  const documentDirectory = join(context.root, 'documents');
  const files = await readdir(documentDirectory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.equal(files.length, 0);
  const blocked = await context.exportRequest({ requestId: randomUUID() });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /unresolved/i);
  assert.equal((await context.request('/api/outcomes/export/resolve', { requestId })).status, 400);
  const resolved = await context.request('/api/outcomes/export/resolve', { requestId, inspected: true });
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).inspection.status, 'interrupted');
  assert.equal((await context.state()).outcomeExportRequests.length, 0);
  assert.ok((await context.state()).activity.some(item => item.kind === 'local-outcomes-export-resolved'));

  failGeneration = false;
  assert.equal((await context.exportRequest({ requestId: randomUUID() })).status, 200);
});

test('an active request cannot be resolved while workbook generation is delayed', async t => {
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const context = await setup(t, {
    buildMonthlyOutcomesWorkbook: async records => {
      entered();
      await gate;
      return createMonthlyOutcomesWorkbook(records);
    }
  });
  await context.authorizeOutput();
  await context.addOutcome();
  const requestId = randomUUID();
  const pending = context.exportRequest({ requestId });
  await waiting;
  const response = await context.request('/api/outcomes/export/resolve', { requestId, inspected: true });
  assert.equal(response.status, 409);
  assert.equal((await context.state()).outcomeExportRequests.length, 1);
  release();
  assert.equal((await pending).status, 200);
  assert.equal((await context.state()).outcomeExportRequests.length, 0);
});
