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
