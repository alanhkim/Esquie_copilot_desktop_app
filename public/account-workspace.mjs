import { matchesAccountSearch } from './account-search.mjs';

export function inertHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function createTextElement(document, tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function bindAccountMetricForm({ document, form, status, check, repeat, storage, randomUUID, getRecords, send, refresh, onRecorded }) {
  const key = 'esquie-account-metric-pending-v1';
  const names = ['accountId', 'label', 'value', 'unit', 'date'];
  const clean = value => value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  let operation = null;
  let pending = false;
  let blocked = false;
  let duplicateReview = null;
  const message = text => { status.textContent = text; };
  const sync = () => {
    for (const control of form.elements) control.disabled = Boolean(operation) || pending || blocked;
    check.hidden = !operation;
    check.disabled = pending;
    repeat.hidden = !duplicateReview;
    repeat.disabled = Boolean(operation) || pending || blocked;
  };
  const forget = () => {
    storage.removeItem(key);
    if (storage.getItem(key)) throw new Error('Pending request storage could not be cleared.');
    operation = null;
    blocked = false;
  };
  const matches = (record, metric) => {
    const fields = ['id', 'label', 'value', 'unit', 'date', 'duplicateOf', 'confirmSeparateObservation',
      'requestId', 'requestRevision', 'appliedRevision', 'createdAt', 'provenance'];
    const sameMetric = candidate => candidate && fields.every(name => candidate[name] === metric?.[name]);
    return record?.id === operation.accountId && record.category === 'account' &&
      typeof record.title === 'string' && Number.isSafeInteger(record.revision) &&
      record.revision >= metric?.appliedRevision && Array.isArray(record.history) && Array.isArray(record.metrics) &&
      typeof metric?.id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(metric.id) &&
      metric.requestId === operation.body.requestId && metric.requestRevision === operation.body.revision &&
      metric.appliedRevision === operation.body.revision + 1 && metric.provenance === 'owner-provided-unverified' &&
      (metric.duplicateOf || '') === (operation.body.duplicateOf || '') &&
      (metric.confirmSeparateObservation ?? false) === (operation.body.confirmSeparateObservation ?? false) &&
      ['label', 'value', 'unit', 'date'].every(name => metric[name] === operation.body[name]) &&
      record.metrics.some(saved => sameMetric(saved));
  };
  try {
    const raw = storage.getItem(key);
    if (raw) {
      const saved = JSON.parse(raw);
      if (typeof saved?.accountId !== 'string' || saved.accountId.length !== 36 ||
          !Number.isSafeInteger(saved.body?.revision) || saved.body.revision < 0 ||
          typeof saved.body.requestId !== 'string' || saved.body.requestId.length !== 36 ||
          !['label', 'value', 'unit', 'date'].every(name => typeof saved.body[name] === 'string' && saved.body[name].length <= 100)) {
        throw new Error('Unrecognized pending metric request.');
      }
      operation = saved;
      for (const name of names) form.elements[name].value = name === 'accountId' ? saved.accountId : saved.body[name];
      form.elements.confirmOwnerEntered.checked = false;
      message(`Prior metric request ${saved.body.requestId} has an unknown outcome. Check saved history; no retry will be sent.`);
    }
  } catch (error) {
    blocked = true;
    message(`Metric submission is blocked because pending-request storage cannot be read: ${error.message}. Review saved account history before using a new window.`);
  }
  const accept = result => {
    if (!matches(result?.record, result?.metric)) throw new Error('The saved metric receipt did not match this account and request.');
    onRecorded(result.record);
    form.elements.confirmOwnerEntered.checked = false;
    try { forget(); }
    catch (error) {
      blocked = true;
      message(`Metric confirmed saved locally, but request storage could not be cleared: ${error.message}. Do not repeat it.`);
      return false;
    }
    message('Owner-entered, UNVERIFIED metric confirmed saved locally. No source was read or reporting system updated.');
    return true;
  };
  async function submitMetric(separate = false) {
    if (operation || pending || blocked) return;
    const accountId = form.elements.accountId.value;
    const account = getRecords().find(item => item.id === accountId && item.category === 'account');
    if (!account || !form.elements.confirmOwnerEntered.checked) {
      message('Select an existing exact account ID and explicitly confirm your unverified observation. Nothing was submitted.');
      return;
    }
    const body = Object.fromEntries(['label', 'value', 'unit', 'date'].map(name => [name, clean(form.elements[name].value)]));
    const revision = account.revision || 0;
    const matching = (account.metrics || []).filter(metric => ['label', 'value', 'unit', 'date'].every(name => metric[name] === body[name]));
    let duplicateOf = '';
    if (separate) {
      if (!duplicateReview || duplicateReview.accountId !== accountId || duplicateReview.revision !== revision ||
          !matching.some(metric => metric.id === duplicateReview.metric.id) ||
          Object.keys(body).some(name => body[name] !== duplicateReview.values[name])) {
        duplicateReview = null;
        message('The exact-observation review changed or is stale. Nothing was submitted; submit the form again to review the current account and inputs.');
        sync();
        return;
      }
      duplicateOf = duplicateReview.metric.id;
    } else if (matching.length) {
      const metric = matching.at(-1);
      duplicateReview = { accountId, revision, metric, values: body };
      message(`Existing owner-entered, UNVERIFIED observation: ${metric.label} = ${metric.value} ${metric.unit || '(unit not provided)'}, observation date ${metric.date || 'Unknown'}, recorded ${metric.createdAt || 'Unknown'}, ID ${metric.id}. Account ${accountId}, revision ${revision}. Nothing was submitted. To preserve this entry and add another, explicitly choose “Record a separate identical observation”.`);
      sync();
      return;
    } else duplicateReview = null;
    Object.assign(body, { revision, requestId: randomUUID(), confirmOwnerEntered: true, duplicateOf, confirmSeparateObservation: separate });
    const candidate = { accountId, body };
    try {
      const encoded = JSON.stringify(candidate);
      storage.setItem(key, encoded);
      if (storage.getItem(key) !== encoded) throw new Error('Pending request identity could not be retained.');
    } catch (error) {
      blocked = true;
      message(`Not submitted: ${error.message}. Reliable per-window request storage is required.`);
      sync();
      return;
    }
    operation = candidate;
    duplicateReview = null;
    pending = true;
    sync();
    message('Metric save pending. No result is claimed and no retry will be sent.');
    let confirmed = false;
    try {
      const result = await send(accountId, body);
      if (!matches(result?.record, result?.metric)) throw new Error('The saved metric receipt did not match this account and request.');
      confirmed = true;
      if (accept(result)) {
        try { await refresh(); }
        catch (error) { message(`Metric confirmed saved locally; display refresh failed: ${error.message}. Do not submit it again.`); }
      }
    } catch (error) {
      if (!confirmed && error?.definitiveRejection === true) {
        try { forget(); }
        catch (storageError) { blocked = true; message(`Metric was rejected, but request storage could not be cleared: ${storageError.message}.`); return; }
        form.elements.confirmOwnerEntered.checked = false;
        message(`Metric was rejected: ${error.message}. Input retained; refresh and review before a new deliberate request.`);
      } else {
        message(`Metric outcome is unknown for request ${body.requestId}: ${error.message}. Check saved history; blind retries are blocked.`);
      }
    } finally { pending = false; sync(); }
  }
  form.addEventListener('submit', async event => { event.preventDefault(); await submitMetric(); });
  repeat.addEventListener('click', () => submitMetric(true));
  const invalidateReview = () => {
    if (!duplicateReview || operation || pending) return;
    duplicateReview = null;
    message('Observation inputs changed. Submit the form to review them; no separate-observation permission was retained.');
    sync();
  };
  form.addEventListener('input', invalidateReview);
  form.addEventListener('change', invalidateReview);
  check.addEventListener('click', async () => {
    if (!operation || pending) return;
    pending = true;
    sync();
    try {
      await refresh();
      const record = getRecords().find(item => item.id === operation.accountId && item.category === 'account');
      const metric = record?.metrics?.find(item => item.requestId === operation.body.requestId);
      if (metric) accept({ record, metric });
      else message(`Metric outcome remains unknown for request ${operation.body.requestId}. No saved receipt is visible; no retry was sent.`);
    } catch (error) {
      message(`Metric outcome remains unresolved: ${error.message}. No retry was sent.`);
    } finally { pending = false; sync(); }
  });
  sync();
  return {
    render(records) {
      if (duplicateReview && !records.some(record => record.id === duplicateReview.accountId && record.category === 'account' &&
          (record.revision || 0) === duplicateReview.revision)) {
        duplicateReview = null;
        message('The account changed since the exact-observation review. Nothing was submitted; review it again before recording another observation.');
      }
      const selected = operation?.accountId || form.elements.accountId.value;
      const select = form.elements.accountId;
      select.replaceChildren(createTextElement(document, 'option', '', 'Choose an exact local account'));
      select.children[0].value = '';
      for (const account of records.filter(item => item.category === 'account')) {
        const option = createTextElement(document, 'option', '', `${account.title} [${account.id}]`);
        option.value = account.id;
        select.append(option);
      }
      if (selected && !records.some(item => item.id === selected && item.category === 'account')) {
        const missing = createTextElement(document, 'option', '', `Unavailable account ID: ${selected}`);
        missing.value = selected;
        select.append(missing);
      }
      select.value = selected || '';
      sync();
    }
  };
}
export function bindAccountFormSubmission({
  form, submitButton, getValues, send, onSuccess, onError, refresh, onRefreshError, onRefreshed
}) {
  let pending = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    pending = true;
    const submitted = { ...getValues() };
    submitButton.disabled = true;
    try {
      let record;
      try {
        record = await send(submitted);
      } catch (error) {
        onError(error);
        return;
      }
      const current = { ...getValues() };
      try {
        await onSuccess({
          record,
          submitted,
          current,
          unchanged: JSON.stringify(submitted) === JSON.stringify(current)
        });
      } catch (error) {
        if (onRefreshError) onRefreshError(error, record);
        else onError(new Error(`The account was saved locally, but its view could not be updated: ${error.message}`));
        return;
      }
      try {
        await refresh?.();
      } catch (error) {
        if (onRefreshError) onRefreshError(error, record);
        else onError(new Error(`The account was saved locally, but its list could not be refreshed: ${error.message}`));
        return;
      }
      onRefreshed?.(record);
    } finally {
      pending = false;
      submitButton.disabled = false;
    }
  });
  return { isPending: () => pending };
}

export function canReplaceAccountTarget({ saving, dirty, confirmDiscard }) {
  return !saving && (!dirty || confirmDiscard());
}

export function applyAccountSaveResult({ form, submitButton, cancelButton, submitted, current, record, reset }) {
  if (JSON.stringify(submitted) === JSON.stringify(current)) {
    reset();
    return null;
  }
  form.dataset.recordId = record.id;
  form.dataset.revision = String(record.revision || 0);
  form.dataset.category = 'account';
  submitButton.textContent = 'Save account changes';
  cancelButton.hidden = false;
  return JSON.stringify(submitted);
}

export function renderAccountRecords({
  document, host, records, query, noteDrafts, pendingNotes, expandedHistory, formatDate,
  onEdit, saveNote, refresh, notify, onError, onSettled
}) {
  const active = document.activeElement;
  const focusedControlKey = host.contains(active) ? active?.dataset?.accountFocusKey || null : null;
  const focusedNoteId = active?.dataset?.accountNoteRecordId || null;
  const selection = focusedNoteId ? {
    start: active.selectionStart,
    end: active.selectionEnd,
    direction: active.selectionDirection
  } : null;

  for (const textarea of host.querySelectorAll('textarea[data-account-note-record-id]')) {
    const id = textarea.dataset.accountNoteRecordId;
    if (textarea.value) noteDrafts.set(id, textarea.value);
    else noteDrafts.delete(id);
  }
  for (const details of host.querySelectorAll('details[data-account-history-id]')) {
    const id = details.dataset.accountHistoryId;
    if (details.open) expandedHistory.add(id);
    else expandedHistory.delete(id);
  }

  const matching = records.filter(record => matchesAccountSearch(record, query));
  host.replaceChildren();
  if (!matching.length) {
    host.append(createTextElement(document, 'p', 'empty-lane',
      query.trim() ? 'No local accounts match that search.' : 'No owner-provided entries yet.'));
    return matching;
  }

  for (const record of matching) {
    const card = createTextElement(document, 'article', 'surface draft-card');
    card.append(
      createTextElement(document, 'strong', '', record.title),
      createTextElement(document, 'small', '', `${record.category} · ${record.date || 'No date'} · Owner-provided, unverified`)
    );
    if (record.note) card.append(createTextElement(document, 'p', '', record.note));
    if (record.sourceUrl) {
      const href = inertHttpUrl(record.sourceUrl);
      const source = createTextElement(document, href ? 'a' : 'small', 'saved-link',
        href ? 'Open saved source link' : 'Invalid source link not opened');
      source.dataset.accountFocusKey = `source:${record.id}`;
      if (href) {
        source.href = href;
        source.target = '_blank';
        source.rel = 'noopener noreferrer';
      }
      card.append(source);
    }
    if (record.plan) {
      card.append(createTextElement(document, 'h3', 'account-detail-heading', 'Account plan'));
      card.append(createTextElement(document, 'p', 'account-detail', record.plan));
    }
    if (record.stakeholders) {
      card.append(createTextElement(document, 'h3', 'account-detail-heading', 'Explicitly named stakeholders'));
      card.append(createTextElement(document, 'p', 'account-detail', record.stakeholders));
    }

    const history = Array.isArray(record.history) ? record.history : [];
    const historyPanel = createTextElement(document, 'details', 'account-history');
    historyPanel.dataset.accountHistoryId = record.id;
    historyPanel.open = expandedHistory.has(record.id);
    historyPanel.addEventListener('toggle', () => {
      if (historyPanel.open) expandedHistory.add(record.id);
      else expandedHistory.delete(record.id);
    });
    const historySummary = createTextElement(document, 'summary', '', `Local notes & history (${history.length})`);
    historySummary.dataset.accountFocusKey = `history-summary:${record.id}`;
    historyPanel.append(historySummary);
    if (history.length) {
      const entries = createTextElement(document, 'div', 'conversation-messages');
      for (const entry of [...history].reverse()) {
        const note = createTextElement(document, 'article', 'note-bubble');
        note.append(createTextElement(document, 'small', '', `${formatDate(entry.createdAt) || 'Unknown date'} · Owner-provided, unverified`));
        note.append(createTextElement(document, 'p', '', entry.text));
        entries.append(note);
      }
      historyPanel.append(entries);
    } else {
      historyPanel.append(createTextElement(document, 'p', 'muted', 'No account notes have been added.'));
    }
    card.append(historyPanel);
    card.append(createTextElement(document, 'small', '', `Local account ID: ${record.id}`));
    card.append(createTextElement(document, 'h3', 'account-detail-heading', 'Owner-entered metric history — UNVERIFIED'));
    if (!record.metrics?.length) {
      card.append(createTextElement(document, 'p', 'muted', 'No metric observations recorded. Values are unknown, not zero.'));
    }
    for (const metric of [...(record.metrics || [])].reverse()) {
      const entry = createTextElement(document, 'article', 'note-bubble');
      entry.append(createTextElement(document, 'p', '', `${metric.label}: ${metric.value}${metric.unit ? ` ${metric.unit}` : ''}`));
      entry.append(createTextElement(document, 'small', '', `Observation date: ${metric.date || 'Unknown (not provided)'} · Recorded: ${formatDate(metric.createdAt) || 'Unknown'} · Owner-entered, UNVERIFIED · Request ${metric.requestId}`));
      if (metric.duplicateOf) entry.append(createTextElement(document, 'small', '', `Separately confirmed observation; existing entry ${metric.duplicateOf} was retained.`));
      card.append(entry);
    }

    const noteForm = createTextElement(document, 'form', 'form account-note-form');
    noteForm.dataset.recordId = record.id;
    noteForm.dataset.revision = String(record.revision || 0);
    const label = createTextElement(document, 'label', '', 'Add a local note');
    const textarea = createTextElement(document, 'textarea');
    textarea.name = 'text';
    textarea.rows = 2;
    textarea.maxLength = 4000;
    textarea.required = true;
    textarea.dataset.accountNoteRecordId = record.id;
    textarea.dataset.accountFocusKey = `note-input:${record.id}`;
    textarea.value = noteDrafts.get(record.id) || '';
    textarea.addEventListener('input', () => {
      if (textarea.value) noteDrafts.set(record.id, textarea.value);
      else noteDrafts.delete(record.id);
    });
    label.append(textarea);
    const submit = createTextElement(document, 'button', 'button', 'Add note');
    submit.type = 'submit';
    submit.dataset.accountFocusKey = `note-submit:${record.id}`;
    submit.disabled = pendingNotes.has(record.id);
    noteForm.append(label, submit);
    noteForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (pendingNotes.has(record.id)) return;
      const submitted = textarea.value;
      pendingNotes.add(record.id);
      submit.disabled = true;
      try {
        try {
          await saveNote(record, submitted);
        } catch (error) {
          onError(error);
          return;
        }
        const displayedTextarea = [...host.querySelectorAll('textarea[data-account-note-record-id]')]
          .find(current => current.dataset.accountNoteRecordId === record.id);
        const mappedDraft = noteDrafts.get(record.id);
        if (displayedTextarea) {
          if (displayedTextarea.value === submitted
            && (!noteDrafts.has(record.id) || mappedDraft === submitted)) {
            displayedTextarea.value = '';
            noteDrafts.delete(record.id);
          } else if (displayedTextarea.value !== submitted) {
            if (displayedTextarea.value) noteDrafts.set(record.id, displayedTextarea.value);
            else if (mappedDraft === submitted) noteDrafts.delete(record.id);
          } else if (mappedDraft) {
            displayedTextarea.value = mappedDraft;
          }
        } else if (mappedDraft === submitted) {
          noteDrafts.delete(record.id);
        }
        try {
          await refresh();
        } catch (error) {
          onError(new Error(`The account note was saved locally, but the account list could not be refreshed: ${error.message}`));
          return;
        }
        notify('Account note saved locally; no source was checked.');
      } finally {
        pendingNotes.delete(record.id);
        onSettled();
      }
    });
    card.append(noteForm);

    const edit = createTextElement(document, 'button', 'button', 'Edit account');
    edit.type = 'button';
    edit.dataset.accountFocusKey = `edit:${record.id}`;
    edit.addEventListener('click', () => onEdit(record));
    card.append(edit);
    host.append(card);
  }

  if (focusedControlKey) {
    const replacement = [...host.querySelectorAll('[data-account-focus-key]')]
      .find(element => element.dataset.accountFocusKey === focusedControlKey);
    if (replacement) {
      replacement.focus({ preventScroll: true });
      if (focusedNoteId && selection?.start != null && selection?.end != null) {
        replacement.setSelectionRange(selection.start, selection.end, selection.direction || 'none');
      }
    }
  }
  return matching;
}
