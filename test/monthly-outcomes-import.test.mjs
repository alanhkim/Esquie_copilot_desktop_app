import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/server.mjs';
import { parseMonthlyOutcomeTable, previewMonthlyOutcomeImport } from '../src/monthly-outcomes-import.mjs';

const table = [
  '| Date | Account | Workshop | Status | Notes | Source URL |',
  '| --- | --- | --- | --- | --- | --- |',
  '| 2020-10-12 | Example Account | Example workshop | Delivered | Owner-provided note | https://example.invalid/workshop |'
].join('\n');

async function setup(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-outcomes-import-'));
  const options = { ...overrides, dataDir, port: 0, workerIntervalMs: 0 };
  let app = await startServer(options);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const state = async () => {
    const response = await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const request = async (path, method, body) => fetch(`${app.url}${path}`, {
    method,
    headers: {
      Origin: app.url,
      'Content-Type': 'application/json',
      'X-Esquie-Access': app.accessToken,
      'X-Esquie-CSRF': (await state()).csrfToken
    },
    body: JSON.stringify(body)
  });
  const post = (path, body) => request(path, 'POST', body);
  const patch = (path, body) => request(path, 'PATCH', body);
  return {
    get app() { return app; }, state, post, patch,
    async restart() { await app.close(); app = await startServer(options); }
  };
}

test('preview is read-only and confirmation is explicit; imported outcomes persist after restart', async t => {
  const context = await setup(t);
  const previewResponse = await context.post('/api/outcomes/import/preview', { text: table });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].state, 'new');
  assert.equal(preview.rows[0].record.sourceUrl, 'https://example.invalid/workshop');
  assert.equal((await context.state()).records.length, 0);

  const rejected = await context.post('/api/outcomes/import/confirm', {
    text: table, revision: preview.revision, textHash: preview.textHash, reviewed: false
  });
  assert.equal(rejected.status, 409);
  assert.equal((await context.state()).records.length, 0);

  const changedText = await context.post('/api/outcomes/import/confirm', {
    text: table.replace('Owner-provided note', 'Text not shown in the preview'),
    revision: preview.revision, textHash: preview.textHash, reviewed: true
  });
  assert.equal(changedText.status, 409);
  assert.match((await changedText.json()).error, /changed after preview/);
  assert.equal((await context.state()).records.length, 0);

  const confirmed = await context.post('/api/outcomes/import/confirm', {
    text: table, revision: preview.revision, textHash: preview.textHash, reviewed: true
  });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).imported, 1);
  await context.restart();
  const records = (await context.state()).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].provenance, 'owner-pasted-unverified');
  assert.equal(records[0].sourceUrl, 'https://example.invalid/workshop');
  assert.equal(records[0].workshopImport.status, 'Delivered');
});

test('exact duplicates are skipped and changed rows with the same identity are conflicts, never overwrites', async t => {
  const context = await setup(t);
  const firstPreview = await (await context.post('/api/outcomes/import/preview', { text: table })).json();
  await context.post('/api/outcomes/import/confirm', {
    text: table, revision: firstPreview.revision, textHash: firstPreview.textHash, reviewed: true
  });
  const duplicatePreview = await (await context.post('/api/outcomes/import/preview', { text: table })).json();
  assert.equal(duplicatePreview.rows[0].state, 'duplicate');
  const duplicateResult = await context.post('/api/outcomes/import/confirm', {
    text: table, revision: duplicatePreview.revision, textHash: duplicatePreview.textHash, reviewed: true
  });
  assert.deepEqual(await duplicateResult.json(), {
    imported: 0, duplicates: 1, conflicts: 0, records: []
  });
  const conflictTable = table.replace('Owner-provided note', 'Different note');
  const preview = await (await context.post('/api/outcomes/import/preview', {
    text: `${table}\n${conflictTable.split('\n').at(-1)}`
  })).json();
  assert.deepEqual(preview.rows.map(row => row.state), ['conflict', 'conflict']);
  const result = await context.post('/api/outcomes/import/confirm', {
    text: `${table}\n${conflictTable.split('\n').at(-1)}`, revision: preview.revision, textHash: preview.textHash, reviewed: true
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    imported: 0, duplicates: 0, conflicts: 2, records: []
  });
  const saved = (await context.state()).records;
  assert.equal(saved.length, 1);
  assert.match(saved[0].note, /Owner-provided note/);
});

test('editing an imported date retains original identity and deduplicates the exact current state', async t => {
  const context = await setup(t);
  const initial = await (await context.post('/api/outcomes/import/preview', { text: table })).json();
  await context.post('/api/outcomes/import/confirm', {
    text: table, revision: initial.revision, textHash: initial.textHash, reviewed: true
  });
  let record = (await context.state()).records[0];
  const edited = await context.patch(`/api/records/${record.id}`, {
    category: record.category, title: record.title, note: record.note,
    date: '2020-10-13', revision: record.revision
  });
  assert.equal(edited.status, 200);
  record = (await edited.json()).record;
  assert.equal(record.importKey, initial.rows[0].record.importKey);
  assert.equal(record.date, '2020-10-13');

  const currentText = table.replace('2020-10-12', '2020-10-13');
  const currentPreview = await (await context.post('/api/outcomes/import/preview', { text: currentText })).json();
  assert.equal(currentPreview.rows[0].state, 'duplicate');
  const originalPreview = await (await context.post('/api/outcomes/import/preview', { text: table })).json();
  assert.equal(originalPreview.rows[0].state, 'conflict');
  const originalConfirm = await context.post('/api/outcomes/import/confirm', {
    text: table, revision: originalPreview.revision, textHash: originalPreview.textHash, reviewed: true
  });
  assert.deepEqual(await originalConfirm.json(), {
    imported: 0, duplicates: 0, conflicts: 1, records: []
  });
  const saved = (await context.state()).records;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].date, '2020-10-13');
  assert.match(saved[0].note, /Owner-provided note/);
});

test('identical rows within one paste produce one new row and subsequent duplicates', async t => {
  const context = await setup(t);
  const duplicateRow = table.split('\n').at(-1);
  const text = `${table}\n${duplicateRow}`;
  const preview = await (await context.post('/api/outcomes/import/preview', { text })).json();
  assert.deepEqual(preview.rows.map(row => row.state), ['new', 'duplicate']);
  const response = await context.post('/api/outcomes/import/confirm', {
    text, revision: preview.revision, textHash: preview.textHash, reviewed: true
  });
  const result = await response.json();
  assert.equal(result.imported, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.conflicts, 0);
  assert.equal((await context.state()).records.length, 1);
});

test('a later differing row makes every same-key row in a paste a conflict', async t => {
  const context = await setup(t);
  const conflictingRow = table.split('\n').at(-1).replace('Owner-provided note', 'Different note');
  const text = `${table}\n${conflictingRow}`;
  const preview = await (await context.post('/api/outcomes/import/preview', { text })).json();
  assert.deepEqual(preview.rows.map(row => row.state), ['conflict', 'conflict']);
});

test('tuple-encoded identities do not collide on pipe characters in TSV values', async t => {
  const context = await setup(t);
  const text = [
    ['Date', 'Account', 'Workshop', 'Status'].join('\t'),
    ['2020-10-12', 'A|B', 'C', 'Scheduled'].join('\t'),
    ['2020-10-12', 'A', 'B|C', 'Scheduled'].join('\t')
  ].join('\n');
  const preview = await (await context.post('/api/outcomes/import/preview', { text })).json();
  assert.deepEqual(preview.rows.map(row => row.state), ['new', 'new']);
  assert.notEqual(preview.rows[0].record.importKey, preview.rows[1].record.importKey);
});

test('tab-indented Markdown headers, dividers, and data retain Markdown parsing', () => {
  const text = [
    '| Date | Account | Workshop | Status |',
    '| --- | --- | --- | --- |',
    '| 2020-10-12 | Example Account | Example workshop | Scheduled |'
  ].map(line => `\t${line}\t`).join('\n');
  const [row] = parseMonthlyOutcomeTable(text);
  assert.equal(row.record.workshopImport.account, 'Example Account');
  assert.equal(row.record.workshopImport.workshop, 'Example workshop');
});

test('TSV preserves leading and trailing empty cells and literal pipes', () => {
  const header = '\tDate\tAccount\tWorkshop\tStatus\t';
  const row = '\t2020-10-12\tA|B\tC|D\tScheduled\t';
  const [parsed] = parseMonthlyOutcomeTable(`${header}\n${row}`);
  assert.equal(parsed.record.workshopImport.account, 'A|B');
  assert.equal(parsed.record.workshopImport.workshop, 'C|D');
  assert.throws(
    () => parseMonthlyOutcomeTable(`${header}\n${row.slice(1)}`),
    /same number of columns/
  );
  assert.throws(
    () => parseMonthlyOutcomeTable(`${header.slice(1)}\n${row}`),
    /same number of columns/
  );
});

test('ambiguous mixed-delimiter headers fail visibly', () => {
  assert.throws(
    () => parseMonthlyOutcomeTable('Date\tAccount | Customer\tWorkshop\n2020-10-12\tExample\tSession'),
    /mixes tab and pipe separators/
  );
});

test('empty and all-dash TSV rows are rejected rather than ignored as separators', () => {
  const header = 'Date\tAccount\tWorkshop\tStatus';
  assert.throws(
    () => parseMonthlyOutcomeTable(`${header}\n\t\t\t`),
    /cannot contain empty rows/
  );
  assert.throws(
    () => parseMonthlyOutcomeTable(`${header}\n---\t---\t---\t---`),
    /Dates must use YYYY-MM-DD/
  );
});

test('only the immediate structural Markdown divider is skipped', () => {
  const markdown = [
    '| Date | Account | Workshop | Status |',
    '| --- | --- | --- | --- |',
    '| 2020-10-12 | Example Account | Example workshop | Scheduled |'
  ];
  assert.equal(parseMonthlyOutcomeTable(markdown.join('\n')).length, 1);
  assert.throws(
    () => parseMonthlyOutcomeTable([...markdown, '| --- | --- | --- | --- |'].join('\n')),
    /Dates must use YYYY-MM-DD/
  );
});

test('outcomes persisted with the prior delimiter key still deduplicate by their saved workshop fields', () => {
  const priorRecord = {
    id: 'legacy-imported-outcome', category: 'outcome', date: '2020-10-12',
    title: 'Example Account - Example workshop', note: 'Status: Delivered\nOwner-provided note',
    sourceUrl: 'https://example.invalid/workshop', importKey: '2020-10-12|example account|example workshop',
    workshopImport: { account: 'Example Account', workshop: 'Example workshop', status: 'Delivered' }
  };
  assert.equal(previewMonthlyOutcomeImport([priorRecord], table).rows[0].state, 'duplicate');
  const editedLegacyRecord = { ...priorRecord, date: '2020-10-13', revision: 2 };
  assert.equal(previewMonthlyOutcomeImport([editedLegacyRecord], table).rows[0].state, 'conflict');
  assert.equal(
    previewMonthlyOutcomeImport([editedLegacyRecord], table.replace('2020-10-12', '2020-10-13')).rows[0].state,
    'duplicate'
  );
});

test('missing status is preserved as not provided instead of assumed delivered', async t => {
  const context = await setup(t);
  const text = [
    '| Date | Account | Workshop |',
    '| --- | --- | --- |',
    '| 2020-10-12 | Example Account | Example workshop |'
  ].join('\n');
  const preview = await (await context.post('/api/outcomes/import/preview', { text })).json();
  assert.equal(preview.rows[0].record.workshopImport.status, 'Not provided');
  assert.match(preview.rows[0].record.note, /^Status: Not provided$/);
  const confirmed = await context.post('/api/outcomes/import/confirm', {
    text, revision: preview.revision, textHash: preview.textHash, reviewed: true
  });
  assert.equal(confirmed.status, 200);
  const saved = (await context.state()).records[0];
  assert.equal(saved.workshopImport.status, 'Not provided');
  assert.match(saved.note, /^Status: Not provided$/);
});

test('multilingual imports above 20,000 JSON bytes work without enlarging other API limits', async t => {
  const context = await setup(t);
  const note = '漢'.repeat(3500);
  const sourceUrl = `https://example.invalid/${'x'.repeat(1100)}`;
  const text = [
    ['Date', 'Account', 'Workshop', 'Status', 'Notes', 'Source URL'].join('\t'),
    ...[1, 2, 3, 4].map(number =>
      ['2020-10-12', `${'A'.repeat(78)}${number}`, 'W'.repeat(78), 'Scheduled', note,
        number === 1 ? sourceUrl : 'https://example.invalid/x'].join('\t'))
  ].join('\n');
  const payload = JSON.stringify({ text });
  assert.ok(Buffer.byteLength(payload, 'utf8') > 20_000);
  assert.ok(text.length > 15_000 && text.length < 16_000);

  const previewResponse = await context.post('/api/outcomes/import/preview', { text });
  assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  assert.equal(preview.rows.length, 4);
  const confirmResponse = await context.post('/api/outcomes/import/confirm', {
    text, revision: preview.revision, textHash: preview.textHash, reviewed: true
  });
  assert.equal(confirmResponse.status, 200);
  assert.equal((await confirmResponse.json()).imported, 4);

  const otherRoute = await context.post('/api/records', {
    category: 'outcome', title: 'Oversized test', note: 'x'.repeat(20_000)
  });
  assert.equal(otherRoute.status, 413);
});

test('invalid input fails visibly and stale previews cannot merge over newer outcomes', async t => {
  const context = await setup(t);
  const invalid = await context.post('/api/outcomes/import/preview', {
    text: table.replace('https://example.invalid/workshop', 'javascript:alert(1)')
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /HTTP or HTTPS/);
  const preview = await (await context.post('/api/outcomes/import/preview', { text: table })).json();
  const manual = await context.post('/api/records', {
    category: 'outcome', title: 'Separate manual outcome', date: '2020-10-13', note: 'Owner-provided only.'
  });
  assert.equal(manual.status, 201);
  const stale = await context.post('/api/outcomes/import/confirm', {
    text: table, revision: preview.revision, textHash: preview.textHash, reviewed: true
  });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /changed after preview/);
  assert.equal((await context.state()).records.length, 1);
});

test('future delivered rows are checked against the injected clock in the configured owner timezone', async t => {
  const context = await setup(t, { clock: () => new Date('2026-01-01T01:00:00.000Z') });
  assert.equal((await context.patch('/api/profile', { timezone: 'America/Los_Angeles' })).status, 200);
  const futureDelivered = await context.post('/api/outcomes/import/preview', {
    text: table.replace('2020-10-12', '2026-01-01')
  });
  assert.equal(futureDelivered.status, 400);
  assert.match((await futureDelivered.json()).error, /Future workshops cannot be marked delivered/);
});

test('import routes retain owner and CSRF protections', async t => {
  const context = await setup(t);
  const noOwner = await fetch(`${context.app.url}/api/outcomes/import/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: table })
  });
  assert.equal(noOwner.status, 401);
  const noCsrf = await fetch(`${context.app.url}/api/outcomes/import/confirm`, {
    method: 'POST',
    headers: { Origin: context.app.url, 'Content-Type': 'application/json', 'X-Esquie-Access': context.app.accessToken },
    body: JSON.stringify({ text: table, revision: '0'.repeat(64), reviewed: true })
  });
  assert.equal(noCsrf.status, 403);
});
