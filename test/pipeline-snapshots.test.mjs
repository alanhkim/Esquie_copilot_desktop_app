import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/server.mjs';
import { MAX_PIPELINE_SNAPSHOTS, confirmPipelineSnapshot, parsePipelineTable, previewPipelineSnapshot } from '../src/pipeline-snapshots.mjs';

const table = [
  'Opportunity\tOwner-entered phase\tFormula-like text',
  'Example opportunity\tOwner-entered phase\t=1+1',
  'Another example\tDifferent phase\t<script>literal</script>'
].join('\n');

async function setup(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-pipeline-snapshots-'));
  const options = { ...overrides, dataDir, port: 0, workerIntervalMs: 0 };
  let app = await startServer(options);
  t.after(async () => {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const state = async () => {
    const response = await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const request = async (path, method, body, { token, origin } = {}) => fetch(`${app.url}${path}`, {
    method,
    headers: {
      Origin: origin ?? app.url,
      'Content-Type': 'application/json',
      'X-Esquie-Access': app.accessToken,
      'X-Esquie-CSRF': token ?? (await state()).csrfToken
    },
    body: JSON.stringify(body)
  });
  return {
    get app() { return app; },
    state,
    post: (path, body, options) => request(path, 'POST', body, options),
    async restart() {
      await app.close();
      app = await startServer(options);
    }
  };
}

test('pipeline parser preserves arbitrary owner headers and cell text without mapping or evaluation', () => {
  const parsed = parsePipelineTable(table);
  assert.deepEqual(parsed.headers, ['Opportunity', 'Owner-entered phase', 'Formula-like text']);
  assert.deepEqual(parsed.rows[0], ['Example opportunity', 'Owner-entered phase', '=1+1']);
  assert.equal(parsed.rows[1][2], '<script>literal</script>');
  assert.deepEqual(parsePipelineTable('| A | B |\n| --- | --- |\n| x | y |'), {
    headers: ['A', 'B'], rows: [['x', 'y']]
  });
  assert.deepEqual(parsePipelineTable('|Owner\tStage\n|literal pipe\tOpen'), {
    headers: ['|Owner', 'Stage'],
    rows: [['|literal pipe', 'Open']]
  });
  assert.deepEqual(parsePipelineTable('Owner|entered\tLast column\n\tRight value\nLeft value\t'), {
    headers: ['Owner|entered', 'Last column'],
    rows: [['', 'Right value'], ['Left value', '']]
  });
  assert.deepEqual(parsePipelineTable('Name\tStage\n---\t---\n\t'), {
    headers: ['Name', 'Stage'],
    rows: [['---', '---'], ['', '']]
  });
  assert.deepEqual(parsePipelineTable('| A | B |\n| --- | --- |\n| x | y |\n| --- | --- |'), {
    headers: ['A', 'B'], rows: [['x', 'y'], ['---', '---']]
  });
  assert.deepEqual(parsePipelineTable('\t| A | B |\n\t| --- | --- |\n\t| x | y |'), {
    headers: ['A', 'B'], rows: [['x', 'y']]
  });
  assert.deepEqual(parsePipelineTable('\tA | B\n\t--- | ---\n\tx | y'), {
    headers: ['A', 'B'], rows: [['x', 'y']]
  });
  assert.throws(() => parsePipelineTable('| A | B |\n| --- |\n| x | y |'), /same number of columns/);
  assert.deepEqual(parsePipelineTable('| A | B |\n| -- | --- |\n| x | y |'), {
    headers: ['A', 'B'], rows: [['--', '---'], ['x', 'y']]
  });
  assert.throws(
    () => parsePipelineTable('| A\t| B |\n| --- | --- |\n| x\t| y |'),
    /Ambiguous table format/
  );
});

test('malformed, unsupported, and oversized pipeline tables are refused', () => {
  assert.throws(() => parsePipelineTable(''), /non-empty table/);
  assert.throws(() => parsePipelineTable('not a table\nrow'), /Markdown pipe table or a tab-separated table/);
  assert.throws(() => parsePipelineTable('A\tB\nonly-one-cell'), /same number of columns/);
  assert.deepEqual(parsePipelineTable('A\tB\n\t'), { headers: ['A', 'B'], rows: [['', '']] });
  assert.throws(() => parsePipelineTable('A\tB\n\t\t'), /same number of columns/);
  assert.throws(() => parsePipelineTable(`A\n${'x'.repeat(16_001)}`), /16,000 characters/);
  assert.throws(() => parsePipelineTable(`${Array(31).fill('A').join('\t')}\n${Array(31).fill('x').join('\t')}`), /between 1 and 30 columns/);
  assert.throws(() => parsePipelineTable(`Name\tStage\n${Array(101).fill('row\tvalue').join('\n')}`), /at most 100 rows/);
  assert.equal(parsePipelineTable(`Name\tStage\n${Array(100).fill('row\tvalue').join('\n')}`).rows.length, 100);
  assert.throws(() => previewPipelineSnapshot([], 'accounts', table), /Choose Opportunities or Milestones/);
});

test('pipeline snapshot UI module is served from the explicit public resource map', async t => {
  const context = await setup(t);
  const response = await fetch(`${context.app.url}/pipeline-snapshots.mjs`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /export function bindPipelineSnapshotWorkflow/);
});

test('preview is read-only and an explicitly confirmed owner snapshot persists after restart', async t => {
  const context = await setup(t);
  const previewResponse = await context.post('/api/pipeline/snapshots/preview', { type: 'opportunities', text: table });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.deepEqual(preview.headers, ['Opportunity', 'Owner-entered phase', 'Formula-like text']);
  assert.equal(preview.rows.length, 2);
  assert.equal(preview.type, 'opportunities');
  assert.equal((await context.state()).pipelineSnapshots.length, 0);

  const rejected = await context.post('/api/pipeline/snapshots/confirm', {
    type: 'opportunities', text: table, revision: preview.revision, textHash: preview.textHash,
    reviewed: false, requestId: randomUUID()
  });
  assert.equal(rejected.status, 409);
  assert.equal((await context.state()).pipelineSnapshots.length, 0);

  const confirmed = await context.post('/api/pipeline/snapshots/confirm', {
    type: 'opportunities', text: table, revision: preview.revision, textHash: preview.textHash,
    reviewed: true, requestId: randomUUID()
  });
  assert.equal(confirmed.status, 201);
  const result = await confirmed.json();
  assert.equal(result.saved, true);
  assert.equal(result.snapshot.provenance, 'owner-pasted-unverified');
  assert.equal(result.snapshot.rows[0][2], '=1+1');
  await context.restart();
  const saved = (await context.state()).pipelineSnapshots;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].type, 'opportunities');
  assert.deepEqual(saved[0].rows, preview.rows);
});

test('tabular rows with empty edge cells and a pipe in a TSV header persist exactly after restart', async t => {
  const context = await setup(t);
  const text = 'Owner|entered\tLast column\n\tRight value\nLeft value\t';
  const preview = await (await context.post('/api/pipeline/snapshots/preview', { type: 'milestones', text })).json();
  assert.deepEqual(preview.headers, ['Owner|entered', 'Last column']);
  assert.deepEqual(preview.rows, [['', 'Right value'], ['Left value', '']]);
  const response = await context.post('/api/pipeline/snapshots/confirm', {
    type: 'milestones', text, revision: preview.revision, textHash: preview.textHash,
    reviewed: true, requestId: randomUUID()
  });
  assert.equal(response.status, 201);
  await context.restart();
  assert.deepEqual((await context.state()).pipelineSnapshots[0].rows, [['', 'Right value'], ['Left value', '']]);
});

test('tab-indented Markdown skips only its matching divider and persists empty and all-dash rows', async t => {
  const context = await setup(t);
  const text = '\t| A | B |\n\t| --- | --- |\n\t| --- | --- |\n\t| | |';
  const preview = await (await context.post('/api/pipeline/snapshots/preview', { type: 'milestones', text })).json();
  assert.deepEqual(preview.headers, ['A', 'B']);
  assert.deepEqual(preview.rows, [['---', '---'], ['', '']]);
  const response = await context.post('/api/pipeline/snapshots/confirm', {
    type: 'milestones', text, revision: preview.revision, textHash: preview.textHash,
    reviewed: true, requestId: randomUUID()
  });
  assert.equal(response.status, 201);
  await context.restart();
  assert.deepEqual((await context.state()).pipelineSnapshots[0].rows, [['---', '---'], ['', '']]);
});

test('confirmation fences changed text and concurrent stale previews without replacing prior snapshots', async t => {
  const context = await setup(t);
  const firstPreview = await (await context.post('/api/pipeline/snapshots/preview', { type: 'opportunities', text: table })).json();
  const changedText = await context.post('/api/pipeline/snapshots/confirm', {
    type: 'opportunities', text: `${table}\nNew row\tNew value\tnew`, revision: firstPreview.revision,
    textHash: firstPreview.textHash, reviewed: true, requestId: randomUUID()
  });
  assert.equal(changedText.status, 409);
  assert.equal((await context.state()).pipelineSnapshots.length, 0);

  const opportunityPreview = await (await context.post('/api/pipeline/snapshots/preview', { type: 'opportunities', text: table })).json();
  const milestonePreview = await (await context.post('/api/pipeline/snapshots/preview', { type: 'milestones', text: table })).json();
  const first = context.post('/api/pipeline/snapshots/confirm', {
    type: 'opportunities', text: table, revision: firstPreview.revision,
    textHash: firstPreview.textHash, reviewed: true, requestId: randomUUID()
  });
  const second = context.post('/api/pipeline/snapshots/confirm', {
    type: 'milestones', text: table, revision: firstPreview.revision,
    textHash: milestonePreview.textHash,
    reviewed: true, requestId: randomUUID()
  });
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const results = await Promise.all(responses.map(response => response.json()));
  const saved = (await context.state()).pipelineSnapshots;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].type, results.find(result => result.saved)?.snapshot.type);
  assert.equal(opportunityPreview.revision, milestonePreview.revision);
});

test('a repeated uncertain confirmation ID returns the same saved snapshot, never a second copy', async t => {
  const context = await setup(t);
  const preview = await (await context.post('/api/pipeline/snapshots/preview', { type: 'milestones', text: table })).json();
  const requestId = randomUUID();
  const body = {
    type: 'milestones', text: table, revision: preview.revision,
    textHash: preview.textHash, reviewed: true, requestId
  };
  const first = await context.post('/api/pipeline/snapshots/confirm', body);
  await context.restart();
  const retry = await context.post('/api/pipeline/snapshots/confirm', body);
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).deduplicated, true);

  const changedText = table.replace('Example opportunity', 'Changed opportunity');
  const changedPreview = await (await context.post('/api/pipeline/snapshots/preview', {
    type: 'milestones', text: changedText
  })).json();
  const reusedId = await context.post('/api/pipeline/snapshots/confirm', {
    type: 'milestones', text: changedText, revision: changedPreview.revision,
    textHash: changedPreview.textHash, reviewed: true, requestId
  });
  assert.equal(reusedId.status, 409);
  assert.equal((await context.state()).pipelineSnapshots.length, 1);
});

test('identical content is not duplicated and different types remain distinct', async t => {
  const context = await setup(t);
  const opportunityPreview = await (await context.post('/api/pipeline/snapshots/preview', { type: 'opportunities', text: table })).json();
  await context.post('/api/pipeline/snapshots/confirm', {
    type: 'opportunities', text: table, revision: opportunityPreview.revision,
    textHash: opportunityPreview.textHash, reviewed: true, requestId: randomUUID()
  });
  const duplicate = await (await context.post('/api/pipeline/snapshots/preview', { type: 'opportunities', text: table })).json();
  assert.ok(duplicate.duplicateSnapshotId);
  const milestonePreview = await (await context.post('/api/pipeline/snapshots/preview', { type: 'milestones', text: table })).json();
  assert.equal(milestonePreview.duplicateSnapshotId, null);
  const milestone = await context.post('/api/pipeline/snapshots/confirm', {
    type: 'milestones', text: table, revision: milestonePreview.revision,
    textHash: milestonePreview.textHash, reviewed: true, requestId: randomUUID()
  });
  assert.equal(milestone.status, 201);
  assert.deepEqual((await context.state()).pipelineSnapshots.map(snapshot => snapshot.type), ['milestones', 'opportunities']);
});

test('snapshot capacity refuses new saves without pruning and owner/CSRF checks remain required', async t => {
  const context = await setup(t);
  const unauthorized = await fetch(`${context.app.url}/api/pipeline/snapshots/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'opportunities', text: table })
  });
  assert.equal(unauthorized.status, 401);
  const badCsrf = await context.post('/api/pipeline/snapshots/preview', { type: 'opportunities', text: table }, { token: 'wrong' });
  assert.equal(badCsrf.status, 403);

  const state = { pipelineSnapshots: Array.from({ length: MAX_PIPELINE_SNAPSHOTS }, (_, index) => ({
    id: `snapshot-${index}`, type: 'opportunities', contentHash: `hash-${index}`, createdAt: '2026-01-01T00:00:00.000Z'
  })) };
  const preview = previewPipelineSnapshot(state.pipelineSnapshots, 'milestones', table);
  assert.throws(() => confirmPipelineSnapshot(state, {
    type: 'milestones', text: table, revision: preview.revision, textHash: preview.textHash, reviewed: true, requestId: randomUUID()
  }, '2026-01-02T00:00:00.000Z'), /limit \(50\) has been reached/);
  assert.equal(state.pipelineSnapshots.length, MAX_PIPELINE_SNAPSHOTS);
});

test('pipeline request bodies are bounded independently of table parser limits', async t => {
  const context = await setup(t);
  const maximumText = [
    'A\tB',
    ...Array(4).fill(`Row\t${'漢'.repeat(3994)}`)
  ].join('\n') + ' ';
  assert.equal(maximumText.length, 16_000);
  const boundary = await context.post('/api/pipeline/snapshots/preview', {
    type: 'opportunities', text: maximumText
  });
  assert.equal(boundary.status, 200);
  const overTextLimit = await context.post('/api/pipeline/snapshots/preview', {
    type: 'opportunities', text: `${maximumText}x`
  });
  assert.equal(overTextLimit.status, 400);
  assert.match((await overTextLimit.json()).error, /16,000 characters/);

  const response = await context.post('/api/pipeline/snapshots/preview', {
    type: 'opportunities', text: 'x'.repeat(130_000)
  });
  assert.equal(response.status, 413);
});
