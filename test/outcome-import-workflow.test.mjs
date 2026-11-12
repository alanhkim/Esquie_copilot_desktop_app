import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  confirmOutcomeImport,
  createOutcomeImportWorkflow,
  readLocalApiResponse,
  refreshAfterOutcomeImport,
  syncOutcomeImportControls
} from '../public/outcome-import-workflow.mjs';

const firstImportedRecord = {
  category: 'outcome',
  title: 'Example Account - Example workshop',
  note: 'Status: Delivered\nSynthetic notes',
  date: '2026-10-12',
  sourceUrl: 'https://example.invalid/first',
  importKey: JSON.stringify(['2026-10-12', 'example account', 'example workshop']),
  workshopImport: { account: 'Example Account', workshop: 'Example workshop', status: 'Delivered' }
};
const secondImportedRecord = {
  category: 'outcome',
  title: 'Second Account - Second workshop',
  note: 'Status: Scheduled\nAnother synthetic note',
  date: '2026-11-03',
  sourceUrl: 'https://example.invalid/second',
  importKey: JSON.stringify(['2026-11-03', 'second account', 'second workshop']),
  workshopImport: { account: 'Second Account', workshop: 'Second workshop', status: 'Scheduled' }
};
const preview = {
  sourceMethod: 'pasted',
  sourceMethodHash: 'paste-hash',
  rows: [{ state: 'new', record: firstImportedRecord }]
};

function reviewedImport(records = [firstImportedRecord], sourceMethod = 'pasted') {
  const workflow = createOutcomeImportWorkflow('owner-reviewed workshop table');
  if (sourceMethod !== 'pasted') assert.equal(workflow.setSourceMethod(sourceMethod), true);
  const previewTicket = workflow.beginPreview();
  assert.equal(workflow.resolvePreview(previewTicket, {
    ...preview,
    sourceMethod,
    sourceMethodHash: `${sourceMethod}-hash`,
    rows: records.map(record => ({ state: 'new', record }))
  }), true);
  assert.equal(workflow.setReviewed(true), true);
  return { workflow, confirmation: workflow.beginConfirm() };
}

test('non-empty workshop text is preserved until OCR replacement is explicitly approved', () => {
  const workflow = createOutcomeImportWorkflow('unsaved workshop edits');
  assert.equal(workflow.beginOcr().status, 'replacement-required');
  assert.equal(workflow.snapshot().text, 'unsaved workshop edits');

  const operation = workflow.beginOcr({ replaceExisting: true });
  assert.equal(operation.status, 'started');
  assert.equal(workflow.snapshot().text, 'unsaved workshop edits');
  assert.equal(workflow.rejectOcr(operation.ticket), true);
  assert.equal(workflow.snapshot().text, 'unsaved workshop edits');
  assert.equal(workflow.snapshot().ocrBusy, false);
});

test('OCR invalidates an in-flight preview so its late response cannot become actionable', () => {
  const workflow = createOutcomeImportWorkflow();
  workflow.editText('current table');
  const previewRequest = workflow.beginPreview();
  assert.equal(workflow.snapshot().previewPending, true);

  const operation = workflow.beginOcr({ replaceExisting: true });
  assert.equal(operation.status, 'started');
  assert.equal(workflow.snapshot().preview, null);
  assert.equal(workflow.resolvePreview(previewRequest, { ...preview, sourceMethod: 'pasted' }), false);
  assert.equal(workflow.canConfirm(), false);
  assert.equal(workflow.resolveOcr(operation.ticket, 'OCR text requiring review'), true);
  assert.equal(workflow.snapshot().text, 'OCR text requiring review');
  assert.equal(workflow.snapshot().preview, null);
  assert.equal(workflow.canConfirm(), false);
});

test('confirmation remains gated by an accepted preview and explicit review', () => {
  const workflow = createOutcomeImportWorkflow();
  workflow.editText('owner-reviewed workshop table');
  const ticket = workflow.beginPreview();
  assert.equal(workflow.resolvePreview(ticket, preview), true);
  assert.equal(workflow.canConfirm(), false);
  assert.equal(workflow.setReviewed(true), true);
  assert.equal(workflow.canConfirm(), true);
  const confirmation = workflow.beginConfirm();
  assert.ok(confirmation);
  workflow.finishConfirm(confirmation, { clearText: true });
  assert.equal(workflow.snapshot().text, '');
  assert.equal(workflow.canConfirm(), false);
});

test('confirmation locks controls and a delayed response preserves newer unsaved input', async () => {
  const workflow = createOutcomeImportWorkflow();
  const textInput = new EventTarget();
  Object.assign(textInput, { value: '', disabled: false });
  const controls = {
    text: textInput,
    sourceMethod: { value: 'pasted', disabled: false },
    image: { files: [{}], disabled: false },
    ocrButton: { disabled: false },
    previewButton: { disabled: false },
    rejectButton: { disabled: false },
    reviewCheckbox: { disabled: false },
    confirmButton: { disabled: false }
  };
  const sync = () => syncOutcomeImportControls(workflow, controls);
  textInput.addEventListener('input', () => {
    workflow.editText(textInput.value);
    controls.sourceMethod.value = workflow.snapshot().sourceMethod;
    sync();
  });

  workflow.editText('recognized workshop text');
  workflow.resolveOcr(
    workflow.beginOcr({ replaceExisting: true }).ticket,
    'recognized workshop text'
  );
  textInput.value = workflow.snapshot().text;
  controls.sourceMethod.value = workflow.snapshot().sourceMethod;
  const previewTicket = workflow.beginPreview();
  assert.equal(workflow.resolvePreview(previewTicket, {
    ...preview, sourceMethod: 'screenshot-ocr', sourceMethodHash: 'ocr-hash'
  }), true);
  workflow.setReviewed(true);
  const confirmation = workflow.beginConfirm();
  assert.equal(confirmation.sourceMethod, 'screenshot-ocr');

  let resolveResponse;
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const pending = response.then(() => workflow.finishConfirm(confirmation, { clearText: true }));
  sync();
  assert.equal(workflow.snapshot().confirmBusy, true);
  for (const control of Object.values(controls)) assert.equal(control.disabled, true);
  assert.equal(workflow.beginPreview(), null);
  assert.equal(workflow.beginOcr({ replaceExisting: true }).status, 'busy');
  assert.equal(workflow.clearPreview(), false);

  textInput.value = 'new unsaved notes entered while the old request was pending';
  textInput.dispatchEvent(new Event('input'));
  assert.equal(workflow.snapshot().text, textInput.value);
  assert.equal(workflow.snapshot().sourceMethod, 'screenshot-ocr-edited');
  assert.equal(workflow.snapshot().confirmBusy, true);
  assert.equal(textInput.disabled, true);

  resolveResponse({ imported: 1 });
  const finished = await pending;
  assert.equal(finished.preservedText, true);
  assert.equal(finished.textCleared, false);
  assert.equal(workflow.snapshot().text, textInput.value);
  assert.equal(workflow.snapshot().confirmBusy, false);
  sync();
  assert.equal(textInput.disabled, false);
  assert.equal(controls.confirmButton.disabled, true);
});

test('refresh failure remains a committed import and preserves newer OCR text without inviting retry', async () => {
  const workflow = createOutcomeImportWorkflow();
  const ocr = workflow.beginOcr({ replaceExisting: true });
  assert.equal(workflow.resolveOcr(ocr.ticket, 'reviewed screenshot text'), true);
  const previewTicket = workflow.beginPreview();
  assert.equal(workflow.resolvePreview(previewTicket, {
    ...preview, sourceMethod: 'screenshot-ocr', sourceMethodHash: 'ocr-hash'
  }), true);
  workflow.setReviewed(true);
  const confirmation = workflow.beginConfirm();
  workflow.editText('new unsaved workshop notes');
  const committed = await confirmOutcomeImport(workflow, confirmation, async () => ({
    imported: 1,
    duplicates: 0,
    conflicts: 0,
    records: [{
      id: '11111111-1111-4111-8111-111111111111',
      ...firstImportedRecord,
      provenance: 'owner-stated-screenshot-ocr-unverified'
    }]
  }), { clearText: true });
  assert.equal(committed.status, 'committed');
  const { result, finished } = committed;
  assert.equal(finished.preservedText, true);

  const refreshError = new Error('synthetic refresh failure');
  let refreshCalls = 0;
  const outcome = await refreshAfterOutcomeImport(result, async () => {
    refreshCalls++;
    throw refreshError;
  }, finished.preservedText);

  assert.equal(refreshCalls, 1);
  assert.equal(outcome.status, 'refresh-failed');
  assert.strictEqual(outcome.result, result);
  assert.strictEqual(outcome.error, refreshError);
  assert.equal(workflow.snapshot().text, 'new unsaved workshop notes');
  assert.match(outcome.message, /committed locally/);
  assert.match(outcome.message, /newer unsaved text was preserved/);
  assert.match(outcome.message, /Do not retry/);
});

test('lost confirmation response preserves text and locks out blind resubmission', async () => {
  const { workflow, confirmation } = reviewedImport();
  const transportError = new TypeError('synthetic connection lost');
  const outcome = await confirmOutcomeImport(workflow, confirmation, async () => {
    throw transportError;
  });

  assert.equal(outcome.status, 'unknown');
  assert.strictEqual(outcome.error, transportError);
  assert.match(outcome.message, /may have committed/);
  assert.match(outcome.message, /text is preserved/);
  assert.match(outcome.message, /retry is disabled/);
  assert.equal(workflow.snapshot().text, 'owner-reviewed workshop table');
  assert.equal(workflow.snapshot().confirmOutcomeUnknown, true);
  assert.equal(workflow.beginPreview(), null);
  assert.equal(workflow.beginOcr({ replaceExisting: true }).status, 'busy');
  assert.equal(workflow.canConfirm(), false);

  const controls = {
    text: { disabled: false, readOnly: false },
    sourceMethod: { disabled: false },
    image: { files: [{}], disabled: false },
    ocrButton: { disabled: false },
    previewButton: { disabled: false },
    rejectButton: { disabled: false },
    reviewCheckbox: { disabled: false },
    confirmButton: { disabled: false }
  };
  syncOutcomeImportControls(workflow, controls);
  assert.equal(controls.text.disabled, false);
  assert.equal(controls.text.readOnly, true);
  for (const control of Object.values(controls).slice(1)) assert.equal(control.disabled, true);
});

test('malformed success receipts are unknown and do not clear reviewed text', async () => {
  const malformedReceipts = [
    { imported: 1, duplicates: 0, conflicts: 0 },
    { imported: 2, duplicates: 0, conflicts: 0, records: [{ id: 'one' }, { id: 'two' }] },
    { imported: 1, duplicates: 0, conflicts: 0, records: [{}] }
  ];
  for (const receipt of malformedReceipts) {
    const { workflow, confirmation } = reviewedImport();
    const outcome = await confirmOutcomeImport(workflow, confirmation, async () => receipt, { clearText: true });
    assert.equal(outcome.status, 'unknown');
    assert.equal(workflow.snapshot().text, 'owner-reviewed workshop table');
    assert.equal(workflow.snapshot().confirmOutcomeUnknown, true);
    assert.equal(workflow.beginPreview(), null);
  }
});

test('multi-row receipts with unrelated imported fields remain unknown', async () => {
  const mismatches = [
    { ...secondImportedRecord, title: 'Unrelated workshop' },
    { ...secondImportedRecord, importKey: '["2026-11-03","different account","different workshop"]' }
  ];
  for (const alteredSecondRecord of mismatches) {
    const { workflow, confirmation } = reviewedImport([firstImportedRecord, secondImportedRecord]);
    const outcome = await confirmOutcomeImport(workflow, confirmation, async () => ({
      imported: 2,
      duplicates: 0,
      conflicts: 0,
      records: [
        { id: '11111111-1111-4111-8111-111111111111', ...firstImportedRecord, provenance: 'owner-pasted-unverified' },
        { id: '22222222-2222-4222-8222-222222222222', ...alteredSecondRecord, provenance: 'owner-pasted-unverified' }
      ]
    }));
    assert.equal(outcome.status, 'unknown');
    assert.equal(workflow.snapshot().text, 'owner-reviewed workshop table');
    assert.equal(workflow.snapshot().confirmOutcomeUnknown, true);
    assert.equal(workflow.beginPreview(), null);
  }
});

test('multi-row receipts with duplicate server IDs remain unknown', async () => {
  const { workflow, confirmation } = reviewedImport([firstImportedRecord, secondImportedRecord]);
  const outcome = await confirmOutcomeImport(workflow, confirmation, async () => ({
    imported: 2,
    duplicates: 0,
    conflicts: 0,
    records: [
      { id: 'abcdef12-3456-4abc-8def-1234567890ab', ...firstImportedRecord, provenance: 'owner-pasted-unverified' },
      { id: 'ABCDEF12-3456-4ABC-8DEF-1234567890AB', ...secondImportedRecord, provenance: 'owner-pasted-unverified' }
    ]
  }));
  assert.equal(outcome.status, 'unknown');
  assert.equal(workflow.snapshot().text, 'owner-reviewed workshop table');
  assert.equal(workflow.snapshot().confirmOutcomeUnknown, true);
  assert.equal(workflow.beginPreview(), null);
});

test('valid multi-row receipt matches exact preview fields and preserves OCR provenance', async () => {
  const { workflow, confirmation } = reviewedImport(
    [firstImportedRecord, secondImportedRecord],
    'screenshot-ocr-edited'
  );
  const provenance = 'owner-stated-screenshot-ocr-edited-unverified';
  const outcome = await confirmOutcomeImport(workflow, confirmation, async () => ({
    imported: 2,
    duplicates: 0,
    conflicts: 0,
    records: [
      { id: '22222222-2222-4222-8222-222222222222', ...secondImportedRecord, provenance },
      { id: '11111111-1111-4111-8111-111111111111', ...firstImportedRecord, provenance }
    ]
  }), { clearText: true });
  assert.equal(outcome.status, 'committed');
  assert.equal(outcome.finished.textCleared, true);
  assert.equal(workflow.snapshot().text, '');
  assert.equal(workflow.snapshot().confirmOutcomeUnknown, false);
});

test('structured client rejection remains a rejection instead of an unknown outcome', async () => {
  const { workflow, confirmation } = reviewedImport();
  const outcome = await confirmOutcomeImport(workflow, confirmation, async () => {
    return readLocalApiResponse({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Preview is stale.' })
    });
  });

  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.error.message, 'Preview is stale.');
  assert.equal(workflow.snapshot().confirmOutcomeUnknown, false);
  assert.equal(workflow.snapshot().text, 'owner-reviewed workshop table');
  assert.ok(workflow.beginPreview());
});

test('unreadable and server-error responses are not treated as definitive rejection', async () => {
  const responses = [
    { ok: true, status: 200, json: async () => { throw new SyntaxError('invalid JSON'); } },
    { ok: false, status: 409, json: async () => { throw new SyntaxError('invalid JSON'); } },
    { ok: false, status: 500, json: async () => ({ error: 'Server error.' }) }
  ];
  for (const response of responses) {
    const { workflow, confirmation } = reviewedImport();
    const outcome = await confirmOutcomeImport(workflow, confirmation, async () => readLocalApiResponse(response));
    assert.equal(outcome.status, 'unknown');
    assert.equal(workflow.snapshot().confirmOutcomeUnknown, true);
    assert.equal(workflow.snapshot().text, 'owner-reviewed workshop table');
  }
});
