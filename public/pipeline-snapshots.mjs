import { createTextElement } from './account-workspace.mjs';

export function filterAndSortPipelineRows(snapshot, search = '', sortIndex = -1, direction = 'asc', filterIndex = -1, filterValue = '') {
  const query = search.trim().toLocaleLowerCase();
  const filter = filterValue.trim().toLocaleLowerCase();
  const rows = snapshot.rows.map((cells, index) => ({ cells, index }))
    .filter(({ cells }) =>
      (!query || cells.some(cell => String(cell).toLocaleLowerCase().includes(query)))
      && (!filter || (filterIndex < 0
        ? cells.some(cell => String(cell).toLocaleLowerCase().includes(filter))
        : String(cells[filterIndex] ?? '').toLocaleLowerCase().includes(filter)))
    );
  if (Number.isInteger(sortIndex) && sortIndex >= 0 && sortIndex < snapshot.headers.length) {
    const multiplier = direction === 'desc' ? -1 : 1;
    rows.sort((left, right) =>
      multiplier * String(left.cells[sortIndex]).localeCompare(String(right.cells[sortIndex]), undefined, { numeric: true, sensitivity: 'base' })
      || left.index - right.index
    );
  }
  return rows.map(({ cells }) => cells);
}

export function renderPipelineSnapshotTable(document, host, snapshot, {
  search = '',
  sortIndex = -1,
  direction = 'asc',
  filterIndex = -1,
  filterValue = '',
  caption = 'Owner-pasted, unverified snapshot. Values are displayed as text only.'
} = {}) {
  host.replaceChildren();
  const table = createTextElement(document, 'table', 'pipeline-table');
  const captionElement = createTextElement(document, 'caption', '', caption);
  table.append(captionElement);
  const head = createTextElement(document, 'thead');
  const headerRow = createTextElement(document, 'tr');
  for (const header of snapshot.headers) {
    const cell = createTextElement(document, 'th', '', header);
    cell.scope = 'col';
    headerRow.append(cell);
  }
  head.append(headerRow);
  table.append(head);

  const body = createTextElement(document, 'tbody');
  const rows = filterAndSortPipelineRows(snapshot, search, sortIndex, direction, filterIndex, filterValue);
  for (const values of rows) {
    const row = createTextElement(document, 'tr');
    for (const value of values) row.append(createTextElement(document, 'td', '', value));
    body.append(row);
  }
  table.append(body);
  host.append(table);
  if (!rows.length) host.append(createTextElement(document, 'p', 'muted', 'No rows match this local search.'));
  return rows;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validPipelineSnapshotReceipt(result, submitted, requestId) {
  if (!result || typeof result !== 'object' || result.saved !== true
    || typeof result.duplicate !== 'boolean' || typeof result.deduplicated !== 'boolean'
    || result.duplicate !== result.deduplicated) return false;
  const snapshot = result.snapshot;
  if (!snapshot || typeof snapshot !== 'object'
    || typeof snapshot.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(snapshot.id)
    || snapshot.type !== submitted.type || snapshot.contentHash !== submitted.textHash
    || snapshot.provenance !== 'owner-pasted-unverified' || snapshot.revision !== 1
    || snapshot.requestId !== requestId
    || typeof snapshot.createdAt !== 'string' || !Number.isFinite(Date.parse(snapshot.createdAt))
    || !sameJson(snapshot.headers, submitted.headers) || !sameJson(snapshot.rows, submitted.rows)) return false;
  return true;
}

export function bindPipelineSnapshotWorkflow({
  form, typeInput, textInput, reviewInput, previewButton, discardButton, confirmButton,
  refreshSavedButton, resolveSavedInput, resolveSavedButton, abandonSavedInput, abandonSavedButton,
  request, renderPreview, onNotice, onSaved, onRefreshSaved
}) {
  let preview = null;
  let generation = 0;
  let previewPending = false;
  let confirmPending = false;
  let savedListRefreshPending = false;
  let savedListRefreshed = false;
  let requestId = null;
  let uncertainConfirmation = null;
  let abandonedConfirmation = null;

  function render() {
    renderPreview({
      preview,
      uncertain: uncertainConfirmation,
      abandoned: abandonedConfirmation,
      reviewed: reviewInput.checked,
      pending: previewPending || confirmPending || savedListRefreshPending
    });
    confirmButton.textContent = uncertainConfirmation ? 'Retry same confirmation safely' : 'Confirm local snapshot';
    confirmButton.disabled = confirmPending || savedListRefreshPending || (uncertainConfirmation
      ? false
      : !preview || Boolean(preview.duplicateSnapshotId) || !reviewInput.checked);
    discardButton.disabled = previewPending || confirmPending || savedListRefreshPending || !preview || Boolean(uncertainConfirmation);
    previewButton.disabled = previewPending || confirmPending || savedListRefreshPending || Boolean(uncertainConfirmation);
    refreshSavedButton.hidden = !uncertainConfirmation;
    refreshSavedButton.disabled = !uncertainConfirmation || confirmPending || savedListRefreshPending;
    resolveSavedInput.disabled = !uncertainConfirmation || !savedListRefreshed || confirmPending || savedListRefreshPending;
    resolveSavedButton.disabled = !uncertainConfirmation || !savedListRefreshed || !resolveSavedInput.checked
      || confirmPending || savedListRefreshPending;
    abandonSavedInput.disabled = !uncertainConfirmation || !savedListRefreshed || confirmPending || savedListRefreshPending;
    abandonSavedButton.disabled = !uncertainConfirmation || !savedListRefreshed || !abandonSavedInput.checked
      || confirmPending || savedListRefreshPending;
  }

  function retainUncertainConfirmation(submitted, submittedRequestId) {
    uncertainConfirmation = { preview: submitted, requestId: submittedRequestId };
    savedListRefreshed = false;
    resolveSavedInput.checked = false;
    abandonSavedInput.checked = false;
  }

  function invalidate() {
    generation++;
    preview = null;
    requestId = null;
    reviewInput.checked = false;
    render();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (previewPending || confirmPending || savedListRefreshPending) return;
    if (uncertainConfirmation) {
      onNotice('A previous confirmation may have saved. Check saved snapshots and resolve it with the same confirmation before previewing another table.', true);
      return;
    }
    const submittedType = typeInput.value;
    const submittedText = textInput.value;
    const requestGeneration = ++generation;
    preview = null;
    requestId = null;
    reviewInput.checked = false;
    previewPending = true;
    render();
    try {
      const result = await request('/api/pipeline/snapshots/preview', {
        method: 'POST',
        body: JSON.stringify({ type: submittedType, text: submittedText })
      });
      if (requestGeneration !== generation || typeInput.value !== submittedType || textInput.value !== submittedText) {
        onNotice('The pasted table changed while previewing. The stale preview was discarded; preview the current text.', true);
        return;
      }
      preview = { ...result, type: submittedType, text: submittedText };
      if (abandonedConfirmation
        && preview.type === abandonedConfirmation.type
        && preview.textHash === abandonedConfirmation.textHash
        && preview.duplicateSnapshotId) {
        abandonedConfirmation = null;
      }
      onNotice(preview.duplicateSnapshotId
        ? 'This exact table is already saved; no new snapshot was added.'
        : 'Preview ready. Review the supplied values; no snapshot has been saved.');
    } catch (error) {
      if (requestGeneration === generation) {
        preview = null;
        reviewInput.checked = false;
        onNotice(error.message, true);
      }
    } finally {
      previewPending = false;
      render();
    }
  });

  typeInput.addEventListener('change', invalidate);
  textInput.addEventListener('input', invalidate);
  reviewInput.addEventListener('change', render);
  resolveSavedInput.addEventListener('change', () => {
    if (resolveSavedInput.checked) abandonSavedInput.checked = false;
    render();
  });
  abandonSavedInput.addEventListener('change', () => {
    if (abandonSavedInput.checked) resolveSavedInput.checked = false;
    render();
  });
  discardButton.addEventListener('click', () => {
    if (uncertainConfirmation) return;
    invalidate();
    onNotice('Preview discarded. No pipeline snapshot was changed.');
  });

  refreshSavedButton.addEventListener('click', async () => {
    if (!uncertainConfirmation || savedListRefreshPending || confirmPending) return;
    savedListRefreshPending = true;
    savedListRefreshed = false;
    resolveSavedInput.checked = false;
    abandonSavedInput.checked = false;
    render();
    try {
      await onRefreshSaved(uncertainConfirmation.preview.type);
      if (uncertainConfirmation) {
        savedListRefreshed = true;
        onNotice('Saved snapshots refreshed. Inspect the type and exact table values before resolving this request as already saved.');
      }
    } catch (error) {
      onNotice(`Could not refresh saved snapshots: ${error.message}. The earlier confirmation may still have saved; its request is retained.`, true);
    } finally {
      savedListRefreshPending = false;
      render();
    }
  });

  resolveSavedButton.addEventListener('click', () => {
    if (!uncertainConfirmation || !savedListRefreshed || !resolveSavedInput.checked || confirmPending || savedListRefreshPending) return;
    const resolved = uncertainConfirmation;
    uncertainConfirmation = null;
    savedListRefreshed = false;
    resolveSavedInput.checked = false;
    abandonSavedInput.checked = false;
    reviewInput.checked = false;
    if (preview === resolved.preview) preview = null;
    if (requestId === resolved.requestId) requestId = null;
    render();
    onNotice('Marked as already saved based on your review of the refreshed snapshots. No new confirmation was submitted.');
  });

  abandonSavedButton.addEventListener('click', () => {
    if (!uncertainConfirmation || !savedListRefreshed || !abandonSavedInput.checked || confirmPending || savedListRefreshPending) return;
    const abandoned = uncertainConfirmation;
    abandonedConfirmation = {
      type: abandoned.preview.type,
      textHash: abandoned.preview.textHash
    };
    uncertainConfirmation = null;
    savedListRefreshed = false;
    resolveSavedInput.checked = false;
    abandonSavedInput.checked = false;
    preview = null;
    requestId = null;
    reviewInput.checked = false;
    render();
    onNotice('The earlier confirmation remains unresolved and may still have saved. Its retry was abandoned only in this tab; your pasted text is unchanged. Preview again to start a separate reviewed request. Nothing was submitted by this action.', true);
  });

  confirmButton.addEventListener('click', async () => {
    if (confirmPending || savedListRefreshPending) return;
    const retryingUncertain = Boolean(uncertainConfirmation);
    if (!retryingUncertain && (!preview || !reviewInput.checked)) return;
    if (!retryingUncertain && (typeInput.value !== preview.type || textInput.value !== preview.text)) {
      invalidate();
      onNotice('The pasted table changed after preview. Preview the current text before confirming.', true);
      return;
    }
    if (retryingUncertain) savedListRefreshed = false;
    const submitted = uncertainConfirmation?.preview || preview;
    const submittedRequestId = uncertainConfirmation?.requestId || (requestId ||= crypto.randomUUID());
    confirmPending = true;
    render();
    try {
      const result = await request('/api/pipeline/snapshots/confirm', {
        method: 'POST',
        body: JSON.stringify({
          type: submitted.type,
          text: submitted.text,
          revision: submitted.revision,
          textHash: submitted.textHash,
          reviewed: true,
          requestId: submittedRequestId
        })
      });
      if (!validPipelineSnapshotReceipt(result, submitted, submittedRequestId)) {
        retainUncertainConfirmation(submitted, submittedRequestId);
        onNotice('The confirmation receipt was invalid. The snapshot may have been saved. Check saved snapshots before starting another confirmation; retrying this exact confirmation uses the same safe request ID.', true);
        return;
      }
      uncertainConfirmation = null;
      savedListRefreshed = false;
      resolveSavedInput.checked = false;
      abandonSavedInput.checked = false;
      if (abandonedConfirmation
        && submitted.type === abandonedConfirmation.type
        && submitted.textHash === abandonedConfirmation.textHash) {
        abandonedConfirmation = null;
      }
      if (preview === submitted) preview = null;
      if (requestId === submittedRequestId) requestId = null;
      if (typeInput.value === submitted.type && textInput.value === submitted.text) reviewInput.checked = false;
      render();
      try {
        await onSaved(result);
      } catch (error) {
        const state = result.saved
          ? 'The snapshot was saved locally'
          : 'An identical snapshot already exists';
        onNotice(`${state}, but the saved list could not be refreshed: ${error.message}`, true);
      }
    } catch (error) {
      if (error?.definitiveRejection === true && !retryingUncertain) {
        uncertainConfirmation = null;
        savedListRefreshed = false;
        resolveSavedInput.checked = false;
        abandonSavedInput.checked = false;
        if (preview === submitted) preview = null;
        if (requestId === submittedRequestId) requestId = null;
        if (typeInput.value === submitted.type && textInput.value === submitted.text) reviewInput.checked = false;
        onNotice(`Snapshot was not saved: ${error.message}`, true);
      } else if (retryingUncertain && Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
        retainUncertainConfirmation(submitted, submittedRequestId);
        onNotice(`This retry was rejected (HTTP ${error.status}), but the earlier confirmation may have saved. The reviewed table and request ID are retained; refresh saved snapshots before resolving it or retrying.`, true);
      } else {
        retainUncertainConfirmation(submitted, submittedRequestId);
        onNotice('The confirmation result is uncertain; the snapshot may have been saved. Check saved snapshots before starting another confirmation. Retrying this exact confirmation uses the same safe request ID.', true);
      }
    } finally {
      confirmPending = false;
      render();
    }
  });

  render();
  return {
    getPreview: () => preview,
    getUncertainConfirmation: () => uncertainConfirmation,
    isPending: () => previewPending || confirmPending || savedListRefreshPending
  };
}
