const sourceProvenance = Object.freeze({
  pasted: 'owner-pasted-unverified',
  'screenshot-ocr': 'owner-stated-screenshot-ocr-unverified',
  'screenshot-ocr-edited': 'owner-stated-screenshot-ocr-edited-unverified'
});

export function createOutcomeImportWorkflow(initialText = '') {
  let text = initialText;
  let preview = null;
  let previewTicket = null;
  let reviewed = false;
  let ocrOperation = null;
  let confirmOperation = null;
  let confirmOutcomeUnknown = false;
  let sourceMethod = 'pasted';
  let version = 0;

  const snapshot = () => ({
    text,
    preview,
    sourceMethod,
    reviewed,
    ocrBusy: Boolean(ocrOperation),
    confirmBusy: Boolean(confirmOperation),
    confirmOutcomeUnknown,
    previewPending: Boolean(previewTicket)
  });

  return {
    snapshot,
    editText(value) {
      if (ocrOperation || confirmOutcomeUnknown) return false;
      text = value;
      if (sourceMethod === 'screenshot-ocr') sourceMethod = 'screenshot-ocr-edited';
      version++;
      preview = null;
      previewTicket = null;
      reviewed = false;
      return true;
    },
    setSourceMethod(value) {
      if (ocrOperation || confirmOperation || confirmOutcomeUnknown ||
          !['pasted', 'screenshot-ocr', 'screenshot-ocr-edited'].includes(value)) return false;
      sourceMethod = value;
      version++;
      preview = null;
      previewTicket = null;
      reviewed = false;
      return true;
    },
    beginPreview() {
      if (ocrOperation || confirmOperation || confirmOutcomeUnknown) return null;
      version++;
      preview = null;
      reviewed = false;
      const ticket = Object.freeze({ version, text, sourceMethod });
      previewTicket = ticket;
      return ticket;
    },
    resolvePreview(ticket, value) {
      if (ticket !== previewTicket || ticket.version !== version || text !== ticket.text || !value ||
          value.sourceMethod !== ticket.sourceMethod || !value.sourceMethodHash || ocrOperation || confirmOperation) return false;
      previewTicket = null;
      preview = value;
      reviewed = false;
      return true;
    },
    rejectPreview(ticket) {
      if (ticket !== previewTicket) return false;
      previewTicket = null;
      preview = null;
      reviewed = false;
      return true;
    },
    beginOcr({ replaceExisting = false } = {}) {
      if (ocrOperation || confirmOperation || confirmOutcomeUnknown) return { status: 'busy' };
      if (text.trim() && !replaceExisting) return { status: 'replacement-required' };
      version++;
      preview = null;
      previewTicket = null;
      reviewed = false;
      const ticket = Object.freeze({ version });
      ocrOperation = { ticket };
      return { status: 'started', ticket };
    },
    resolveOcr(ticket, recognizedText) {
      if (ticket !== ocrOperation?.ticket) return false;
      text = recognizedText;
      sourceMethod = 'screenshot-ocr';
      version++;
      ocrOperation = null;
      preview = null;
      previewTicket = null;
      reviewed = false;
      return true;
    },
    rejectOcr(ticket) {
      if (ticket !== ocrOperation?.ticket) return false;
      version++;
      ocrOperation = null;
      preview = null;
      previewTicket = null;
      reviewed = false;
      return true;
    },
    setReviewed(value) {
      if (!preview || ocrOperation || confirmOperation || confirmOutcomeUnknown) return false;
      reviewed = value === true;
      return true;
    },
    canConfirm() {
      return Boolean(!ocrOperation && !confirmOperation && !confirmOutcomeUnknown && preview &&
        preview.sourceMethod === sourceMethod && preview.sourceMethodHash &&
        reviewed && preview.rows?.some(row => row.state === 'new'));
    },
    beginConfirm() {
      if (!this.canConfirm()) return null;
      confirmOperation = Object.freeze({ version, text, preview, sourceMethod });
      return confirmOperation;
    },
    finishConfirm(ticket, { clearText = false } = {}) {
      if (ticket !== confirmOperation) return null;
      const preservedText = version !== ticket.version || text !== ticket.text;
      confirmOperation = null;
      version++;
      preview = null;
      previewTicket = null;
      reviewed = false;
      const textCleared = clearText && !preservedText;
      if (textCleared) {
        text = '';
        sourceMethod = 'pasted';
      }
      return { accepted: true, preservedText, textCleared };
    },
    rejectConfirm(ticket) {
      if (ticket !== confirmOperation) return false;
      confirmOperation = null;
      version++;
      preview = null;
      previewTicket = null;
      reviewed = false;
      return true;
    },
    markConfirmOutcomeUnknown(ticket) {
      if (confirmOperation && ticket !== confirmOperation) return false;
      confirmOperation = null;
      confirmOutcomeUnknown = true;
      version++;
      preview = null;
      previewTicket = null;
      reviewed = false;
      return true;
    },
    clearPreview() {
      if (ocrOperation || confirmOperation || confirmOutcomeUnknown) return false;
      version++;
      preview = null;
      previewTicket = null;
      reviewed = false;
      return true;
    }
  };
}

export function syncOutcomeImportControls(workflow, controls) {
  const state = workflow.snapshot();
  const busy = state.ocrBusy || state.confirmBusy || state.confirmOutcomeUnknown;
  controls.text.disabled = state.ocrBusy || state.confirmBusy;
  controls.text.readOnly = state.confirmOutcomeUnknown;
  controls.sourceMethod.disabled = busy;
  controls.image.disabled = busy;
  controls.ocrButton.disabled = busy || !controls.image.files?.[0];
  controls.previewButton.disabled = busy || state.previewPending;
  controls.rejectButton.disabled = busy || !state.preview;
  controls.reviewCheckbox.disabled = busy || !state.preview || !state.preview.rows?.some(row => row.state === 'new');
  controls.confirmButton.disabled = busy || !workflow.canConfirm();
}

function validConfirmationReceipt(result, preview) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (!Array.isArray(preview?.rows) ||
      !preview.rows.every(row => row && typeof row === 'object' &&
        ['new', 'duplicate', 'conflict'].includes(row.state))) return false;
  if (!Object.hasOwn(sourceProvenance, preview.sourceMethod)) return false;
  const expectedProvenance = sourceProvenance[preview.sourceMethod];
  const newRows = preview.rows.filter(row => row.state === 'new');
  const expected = {
    imported: newRows.length,
    duplicates: preview.rows.filter(row => row.state === 'duplicate').length,
    conflicts: preview.rows.filter(row => row.state === 'conflict').length
  };
  if (expected.imported < 1 ||
      !Number.isSafeInteger(result.imported) || result.imported !== expected.imported ||
      !Number.isSafeInteger(result.duplicates) || result.duplicates !== expected.duplicates ||
      !Number.isSafeInteger(result.conflicts) || result.conflicts !== expected.conflicts ||
      !Array.isArray(result.records) || result.records.length !== expected.imported) return false;
  const expectedByKey = new Map();
  for (const { record } of newRows) {
    if (!record || !['category', 'title', 'note', 'date', 'sourceUrl', 'importKey']
      .every(field => typeof record[field] === 'string') || !record.importKey ||
        !record.workshopImport || typeof record.workshopImport !== 'object' ||
        !['account', 'workshop', 'status'].every(field => typeof record.workshopImport[field] === 'string') ||
        expectedByKey.has(record.importKey)) return false;
    expectedByKey.set(record.importKey, record);
  }
  const ids = new Set();
  for (const record of result.records) {
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        typeof record.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id) ||
        ids.has(record.id.toLowerCase())) return false;
    const expectedRecord = expectedByKey.get(record.importKey);
    if (!expectedRecord ||
        record.category !== expectedRecord.category ||
        record.title !== expectedRecord.title ||
        record.note !== expectedRecord.note ||
        record.date !== expectedRecord.date ||
        record.sourceUrl !== expectedRecord.sourceUrl ||
        record.importKey !== expectedRecord.importKey ||
        record.workshopImport?.account !== expectedRecord.workshopImport.account ||
        record.workshopImport?.workshop !== expectedRecord.workshopImport.workshop ||
        record.workshopImport?.status !== expectedRecord.workshopImport.status ||
        record.provenance !== expectedProvenance) return false;
    ids.add(record.id.toLowerCase());
    expectedByKey.delete(record.importKey);
  }
  return expectedByKey.size === 0;
}

function createLocalResponseError(message, status, structuredError = false) {
  const error = new Error(message);
  error.status = status;
  error.definitiveRejection = status >= 400 && status < 500 && structuredError;
  return error;
}

export async function readLocalApiResponse(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw createLocalResponseError('The local server response could not be read.', response.status);
  }
  if (!response.ok) {
    const hasErrorMessage = data && typeof data === 'object' && !Array.isArray(data) &&
      typeof data.error === 'string' && data.error.length > 0;
    throw createLocalResponseError(
      hasErrorMessage ? data.error : `Request failed (${response.status}).`,
      response.status,
      hasErrorMessage
    );
  }
  return data;
}

function unknownConfirmation(error) {
  return {
    status: 'unknown',
    error,
    detail: error instanceof Error && error.message ? error.message : 'No valid confirmation receipt was received.',
    message: 'Confirmation outcome is unknown: the server may have committed this import. Your text is preserved here, but retry is disabled. Copy it, reload Monthly Outcomes, and check saved entries before retrying.'
  };
}

export async function confirmOutcomeImport(workflow, ticket, request, { clearText = false } = {}) {
  let result;
  try {
    result = await request();
  } catch (error) {
    if (error?.definitiveRejection === true) {
      workflow.rejectConfirm(ticket);
      return { status: 'rejected', error };
    }
    workflow.markConfirmOutcomeUnknown(ticket);
    return unknownConfirmation(error);
  }
  if (!validConfirmationReceipt(result, ticket.preview)) {
    workflow.markConfirmOutcomeUnknown(ticket);
    return unknownConfirmation(new Error('The local server returned an invalid import confirmation receipt.'));
  }
  const finished = workflow.finishConfirm(ticket, { clearText });
  if (!finished?.accepted) {
    workflow.markConfirmOutcomeUnknown(ticket);
    return unknownConfirmation(new Error('The import may have committed, but its local confirmation state changed.'));
  }
  return { status: 'committed', result, finished };
}

export async function refreshAfterOutcomeImport(result, refresh, preservedText = false) {
  try {
    await refresh();
    return { status: 'refreshed', result };
  } catch (error) {
    const message = preservedText
      ? 'Import committed locally; newer unsaved text was preserved, but workspace refresh failed. Do not retry this import; reload to verify saved entries.'
      : 'Import committed locally, but workspace refresh failed. Do not retry this import; reload to verify saved entries.';
    return { status: 'refresh-failed', result, error, message };
  }
}
