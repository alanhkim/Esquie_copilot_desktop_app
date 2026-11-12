import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createOutcomeExportWorkflow,
  monthlyOutcomesSnapshotHash,
  outcomeExportStorageKey
} from '../public/outcome-export-workflow.mjs';

const requestId = 'c0d3d0c0-4b6a-4a14-8b10-a130749f3301';
const nextRequestId = 'cad0ca11-7a8a-4c50-a15c-511accc0ffee';
const records = [
  { id: 'b', revision: 1, category: 'outcome', title: '=1+1', note: 'Synthetic', date: '2026-03-04' },
  { id: 'a', revision: 2, category: 'engagement', title: 'Local row', note: '', date: '' }
];

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
}

function response(ticket, overrides = {}) {
  return {
    reused: false,
    export: {
      id: ticket.requestId,
      format: 'xlsx',
      fileName: `monthly-outcomes-${ticket.requestId}.xlsx`,
      recordCount: ticket.recordCount,
      snapshotHash: ticket.snapshotHash,
      contentBytes: 1234,
      contentSha256: 'a'.repeat(64),
      createdAt: '2026-03-04T10:00:00.000Z',
      ...overrides
    }
  };
}

function storedRequest(requestId, snapshotHash, recordCount) {
  return JSON.stringify({ requestId, snapshotHash, recordCount });
}

test('a successful receipt clears the persisted request and identical in-flight submits are blocked', async () => {
  const storage = fakeStorage();
  const workflow = createOutcomeExportWorkflow({ storage, idFactory: () => requestId });
  const snapshotHash = await monthlyOutcomesSnapshotHash(records);
  const ticket = workflow.begin({ snapshotHash, recordCount: records.length });
  assert.equal(ticket.requestId, requestId);
  assert.deepEqual(JSON.parse(storage.getItem(outcomeExportStorageKey())), {
    requestId, snapshotHash, recordCount: records.length
  });
  assert.equal(workflow.begin({ snapshotHash, recordCount: records.length }), null);
  assert.deepEqual(workflow.complete(ticket, response(ticket)), {
    status: 'completed',
    receipt: response(ticket).export
  });
  assert.equal(storage.getItem(outcomeExportStorageKey()), null);
  assert.deepEqual(workflow.snapshot(), {
    busy: false, requestId: null, uncertain: false, storageReady: true, retryIntentAvailable: false
  });
});

test('lost and malformed receipts stay uncertain until owner inspection explicitly clears the request ID', async () => {
  const snapshotHash = await monthlyOutcomesSnapshotHash(records);
  const storage = fakeStorage({
    [outcomeExportStorageKey()]: storedRequest(requestId, snapshotHash, records.length)
  });
  const workflow = createOutcomeExportWorkflow({ storage, idFactory: () => nextRequestId });
  const ticket = workflow.begin({ snapshotHash, recordCount: records.length, retryExisting: true });
  assert.equal(workflow.fail(ticket), true);
  assert.equal(workflow.begin({ snapshotHash, recordCount: records.length }), null);
  const retry = workflow.begin({ snapshotHash, recordCount: records.length, retryExisting: true });
  assert.equal(retry.requestId, requestId);
  const malformed = response(retry, { contentSha256: 'not-a-digest' });
  assert.equal(workflow.complete(retry, malformed).status, 'unknown');
  assert.deepEqual(JSON.parse(storage.getItem(outcomeExportStorageKey())), {
    requestId, snapshotHash, recordCount: records.length
  });
  assert.equal(workflow.begin({ snapshotHash, recordCount: records.length }), null);
  assert.equal(workflow.abandonAfterInspection(false), false);
  assert.equal(workflow.abandonAfterInspection(true), true);
  assert.equal(storage.getItem(outcomeExportStorageKey()), null);
  const next = workflow.begin({ snapshotHash, recordCount: records.length });
  assert.equal(next.requestId, nextRequestId);
});

test('a mismatched multi-record receipt is never accepted as a completed export', async () => {
  const storage = fakeStorage();
  const workflow = createOutcomeExportWorkflow({ storage, idFactory: () => requestId });
  const snapshotHash = await monthlyOutcomesSnapshotHash(records);
  const ticket = workflow.begin({ snapshotHash, recordCount: records.length });
  const invalid = response(ticket, { recordCount: 1 });
  assert.equal(workflow.complete(ticket, invalid).status, 'unknown');
  assert.deepEqual(JSON.parse(storage.getItem(outcomeExportStorageKey())), {
    requestId, snapshotHash, recordCount: records.length
  });
  assert.equal(workflow.snapshot().uncertain, true);
});

test('a server-adopted request can retry without browser storage and needs server resolution before reset', async () => {
  const workflow = createOutcomeExportWorkflow({ storage: null, idFactory: () => nextRequestId });
  const snapshotHash = await monthlyOutcomesSnapshotHash(records);
  assert.equal(workflow.observePendingRequest({ requestId, snapshotHash, recordCount: records.length }), true);
  assert.equal(workflow.snapshot().storageReady, false);
  const retry = workflow.begin({ snapshotHash, recordCount: records.length, retryExisting: true });
  assert.equal(retry.requestId, requestId);
  assert.equal(workflow.fail(retry), true);
  assert.equal(workflow.abandonAfterInspection(true), false);
  assert.equal(workflow.abandonAfterInspection(true, true), true);
  assert.throws(() => workflow.begin({ snapshotHash, recordCount: records.length }), /tracking is unavailable/);
});

test('changed snapshots and legacy UUID-only markers cannot retry', async () => {
  const snapshotHash = await monthlyOutcomesSnapshotHash(records);
  const changedHash = await monthlyOutcomesSnapshotHash([...records, {
    id: 'later', revision: 1, category: 'outcome', title: 'Edited later'
  }]);
  const storage = fakeStorage({
    [outcomeExportStorageKey()]: storedRequest(requestId, snapshotHash, records.length)
  });
  const restored = createOutcomeExportWorkflow({ storage });
  assert.throws(() => restored.begin({
    snapshotHash: changedHash, recordCount: records.length + 1, retryExisting: true
  }), /differ from the original export intent/);
  assert.equal(restored.snapshot().requestId, requestId);
  assert.equal(restored.snapshot().uncertain, true);

  const legacy = createOutcomeExportWorkflow({
    storage: fakeStorage({ [outcomeExportStorageKey()]: requestId })
  });
  assert.equal(legacy.snapshot().retryIntentAvailable, false);
  assert.throws(() => legacy.begin({
    snapshotHash, recordCount: records.length, retryExisting: true
  }), /original export intent is unavailable/);
  assert.equal(legacy.snapshot().requestId, requestId);
  assert.equal(legacy.snapshot().uncertain, true);
});
