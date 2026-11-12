import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAccountSaveResult, bindAccountFormSubmission, canReplaceAccountTarget, renderAccountRecords } from '../public/account-workspace.mjs';

class SyntheticElement {
  constructor(document, tag) {
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.value = '';
    this.disabled = false;
    this.open = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.selectionDirection = 'none';
    this._textContent = '';
    this._innerHTML = '';
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  get textContent() {
    return this._textContent || this.children.map(child => child.textContent).join('');
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
    const tag = /<\s*([a-z][a-z0-9-]*)/i.exec(this._innerHTML)?.[1];
    if (tag) this.append(new SyntheticElement(this.ownerDocument, tag));
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatchEvent(event) {
    event.target ??= this;
    event.currentTarget = this;
    event.preventDefault ??= () => { event.defaultPrevented = true; };
    for (const listener of this.listeners.get(event.type) || []) await listener(event);
    return !event.defaultPrevented;
  }

  append(...elements) {
    for (const element of elements) {
      element.parentNode = this;
      this.children.push(element);
    }
  }

  replaceChildren(...elements) {
    this.children = [];
    this.append(...elements);
  }

  querySelectorAll(selector) {
    const match = /^(?:([a-z]+))?\[data-([a-z-]+)\]$/i.exec(selector);
    if (!match) return [];
    const tag = match[1]?.toUpperCase();
    const property = match[2].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const found = [];
    const visit = element => {
      if ((!tag || element.tagName === tag) && Object.hasOwn(element.dataset, property)) found.push(element);
      for (const child of element.children) visit(child);
    };
    visit(this);
    return found;
  }

  contains(target) {
    return target === this || this.children.some(child => child.contains(target));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  setSelectionRange(start, end, direction = 'none') {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
}

class SyntheticDocument {
  activeElement = null;
  createElement(tag) {
    return new SyntheticElement(this, tag);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function createAccountRenderer({ document, host, records, noteDrafts, pendingNotes, expandedHistory, callbacks = {} }) {
  return () => renderAccountRecords({
    document,
    host,
    records,
    query: '',
    noteDrafts,
    pendingNotes,
    expandedHistory,
    formatDate: () => 'Synthetic date',
    onEdit: callbacks.onEdit || (() => {}),
    saveNote: callbacks.saveNote || (async () => {}),
    refresh: callbacks.refresh || (async () => {}),
    notify: callbacks.notify || (() => {}),
    onError: callbacks.onError || (error => { throw error; }),
    onSettled: callbacks.onSettled || (() => {})
  });
}

test('account form submit gate blocks duplicates and preserves edits made while saving', async () => {
  const document = new SyntheticDocument();
  const form = document.createElement('form');
  const submitButton = document.createElement('button');
  const cancelButton = document.createElement('button');
  cancelButton.hidden = true;
  const gate = deferred();
  let values = { title: 'Submitted title', plan: 'Submitted plan' };
  let sends = 0;
  let success;
  let baseline;
  let reset = false;
  const submission = bindAccountFormSubmission({
    form,
    submitButton,
    getValues: () => values,
    send: async submitted => {
      sends++;
      assert.deepEqual(submitted, { title: 'Submitted title', plan: 'Submitted plan' });
      await gate.promise;
      return { id: 'synthetic-account', revision: 2 };
    },
    onSuccess: result => {
      success = result;
      baseline = applyAccountSaveResult({
        form,
        submitButton,
        cancelButton,
        submitted: result.submitted,
        current: result.current,
        record: result.record,
        reset: () => { reset = true; }
      });
    },
    onError: error => { throw error; }
  });

  const pending = form.dispatchEvent({ type: 'submit' });
  assert.equal(submission.isPending(), true);
  assert.equal(submitButton.disabled, true);
  let askedToConfirmSwitch = false;
  assert.equal(canReplaceAccountTarget({
    saving: submission.isPending(),
    dirty: true,
    confirmDiscard: () => { askedToConfirmSwitch = true; return true; }
  }), false);
  assert.equal(askedToConfirmSwitch, false);
  values = { title: 'Newer typed title', plan: 'Newer typed plan' };
  await form.dispatchEvent({ type: 'submit' });
  assert.equal(sends, 1);
  gate.resolve();
  await pending;

  assert.equal(submission.isPending(), false);
  assert.equal(canReplaceAccountTarget({ saving: false, dirty: true, confirmDiscard: () => false }), false);
  assert.equal(submitButton.disabled, false);
  assert.equal(success.unchanged, false);
  assert.deepEqual(success.submitted, { title: 'Submitted title', plan: 'Submitted plan' });
  assert.deepEqual(success.current, { title: 'Newer typed title', plan: 'Newer typed plan' });
  assert.equal(reset, false);
  assert.deepEqual(form.dataset, { recordId: 'synthetic-account', revision: '2', category: 'account' });
  assert.equal(cancelButton.hidden, false);
  assert.equal(submitButton.textContent, 'Save account changes');
  assert.equal(baseline, JSON.stringify(success.submitted));
});

test('failed account save releases the gate without resetting entered fields', async () => {
  const document = new SyntheticDocument();
  const form = document.createElement('form');
  const submitButton = document.createElement('button');
  const values = { title: 'Keep my draft', plan: 'Keep this plan' };
  let failure;
  const submission = bindAccountFormSubmission({
    form,
    submitButton,
    getValues: () => values,
    send: async () => { throw new Error('Synthetic local save failure.'); },
    onSuccess: () => assert.fail('A failed save must not report success.'),
    onError: error => { failure = error; }
  });

  await form.dispatchEvent({ type: 'submit' });
  assert.equal(submission.isPending(), false);
  assert.equal(submitButton.disabled, false);
  assert.deepEqual(values, { title: 'Keep my draft', plan: 'Keep this plan' });
  assert.equal(failure.message, 'Synthetic local save failure.');
});

test('successful account save with a failed refresh reports the committed save separately', async () => {
  const document = new SyntheticDocument();
  const form = document.createElement('form');
  const submitButton = document.createElement('button');
  const values = { title: 'Saved account', plan: 'Saved plan' };
  let savedRecord;
  let saveError;
  let refreshError;
  const submission = bindAccountFormSubmission({
    form,
    submitButton,
    getValues: () => values,
    send: async () => ({ id: 'synthetic-account', revision: 1 }),
    onSuccess: ({ record }) => { savedRecord = record; },
    refresh: async () => { throw new Error('Synthetic refresh failure.'); },
    onRefreshError: (error, record) => { refreshError = { error, record }; },
    onRefreshed: () => assert.fail('A failed refresh must not report a complete refresh.'),
    onError: error => { saveError = error; }
  });

  await form.dispatchEvent({ type: 'submit' });
  assert.equal(submission.isPending(), false);
  assert.equal(savedRecord.id, 'synthetic-account');
  assert.equal(saveError, undefined);
  assert.equal(refreshError.record, savedRecord);
  assert.match(refreshError.error.message, /Synthetic refresh failure/);
});

test('account note submit preserves newer text, focus, selection, and expanded history during refresh', async () => {
  const document = new SyntheticDocument();
  const host = document.createElement('div');
  const record = {
    id: 'synthetic-account',
    category: 'account',
    title: 'Synthetic account',
    revision: 1,
    history: []
  };
  const records = [record];
  const noteDrafts = new Map();
  const pendingNotes = new Set();
  const expandedHistory = new Set();
  const gate = deferred();
  let saves = 0;
  let refreshes = 0;
  const render = createAccountRenderer({
    document, host, records, noteDrafts, pendingNotes, expandedHistory,
    callbacks: {
      saveNote: async (target, text) => {
        saves++;
        assert.equal(text, 'Submitted note');
        await gate.promise;
        target.history.push({ text, createdAt: '2026-01-01T00:00:00.000Z' });
        target.revision++;
      },
      refresh: async () => { refreshes++; render(); },
      onSettled: () => render()
    }
  });
  render();

  let textarea = host.querySelectorAll('textarea[data-account-note-record-id]')[0];
  let details = host.querySelectorAll('details[data-account-history-id]')[0];
  textarea.value = 'Submitted note';
  await textarea.dispatchEvent({ type: 'input' });
  details.open = true;
  await details.dispatchEvent({ type: 'toggle' });

  const noteForm = host.querySelectorAll('form[data-record-id]')[0];
  const pending = noteForm.dispatchEvent({ type: 'submit' });
  assert.equal(pendingNotes.has(record.id), true);
  textarea.value = 'Newer unsaved note';
  textarea.setSelectionRange(3, 10, 'forward');
  textarea.focus();
  await textarea.dispatchEvent({ type: 'input' });
  await noteForm.dispatchEvent({ type: 'submit' });
  assert.equal(saves, 1);

  gate.resolve();
  await pending;
  assert.equal(refreshes, 1);
  assert.equal(record.history.length, 1);
  assert.equal(noteDrafts.get(record.id), 'Newer unsaved note');

  textarea = host.querySelectorAll('textarea[data-account-note-record-id]')[0];
  details = host.querySelectorAll('details[data-account-history-id]')[0];
  assert.equal(textarea.value, 'Newer unsaved note');
  assert.equal(document.activeElement, textarea);
  assert.deepEqual([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection], [3, 10, 'forward']);
  assert.equal(details.open, true);
  assert.equal(host.querySelectorAll('form[data-record-id]')[0].children.find(element => element.tagName === 'BUTTON').disabled, false);
  assert.equal(pendingNotes.has(record.id), false);
});

test('unchanged successful note save clears a replacement editor after an intervening render', async () => {
  const document = new SyntheticDocument();
  const host = document.createElement('div');
  const record = { id: 'synthetic-account', category: 'account', title: 'Synthetic account', revision: 1, history: [] };
  const noteDrafts = new Map();
  const pendingNotes = new Set();
  const gate = deferred();
  let refreshes = 0;
  const render = createAccountRenderer({
    document, host, records: [record], noteDrafts, pendingNotes, expandedHistory: new Set(),
    callbacks: {
      saveNote: async (target, text) => {
        await gate.promise;
        target.history.push({ text, createdAt: '2026-01-01T00:00:00.000Z' });
      },
      refresh: async () => { refreshes++; render(); },
      onSettled: () => render()
    }
  });
  render();
  const originalTextarea = host.querySelectorAll('textarea[data-account-note-record-id]')[0];
  const submitted = 'Already saved note';
  originalTextarea.value = submitted;
  await originalTextarea.dispatchEvent({ type: 'input' });

  const pending = host.querySelectorAll('form[data-record-id]')[0].dispatchEvent({ type: 'submit' });
  render();
  let displayedTextarea = host.querySelectorAll('textarea[data-account-note-record-id]')[0];
  assert.notEqual(displayedTextarea, originalTextarea);
  assert.equal(displayedTextarea.value, submitted);

  gate.resolve();
  await pending;
  assert.equal(record.history.length, 1);
  assert.equal(refreshes, 1);
  assert.equal(noteDrafts.has(record.id), false);
  displayedTextarea = host.querySelectorAll('textarea[data-account-note-record-id]')[0];
  assert.equal(displayedTextarea.value, '');
  render();
  assert.equal(host.querySelectorAll('textarea[data-account-note-record-id]')[0].value, '');
});

test('note save preserves a newer value entered in the replacement editor even when the map is stale', async () => {
  const document = new SyntheticDocument();
  const host = document.createElement('div');
  const record = { id: 'synthetic-account', category: 'account', title: 'Synthetic account', revision: 1, history: [] };
  const noteDrafts = new Map();
  const pendingNotes = new Set();
  const gate = deferred();
  const render = createAccountRenderer({
    document, host, records: [record], noteDrafts, pendingNotes, expandedHistory: new Set(),
    callbacks: {
      saveNote: async (target, text) => {
        await gate.promise;
        target.history.push({ text, createdAt: '2026-01-01T00:00:00.000Z' });
      },
      refresh: async () => render(),
      onSettled: () => render()
    }
  });
  render();
  const originalTextarea = host.querySelectorAll('textarea[data-account-note-record-id]')[0];
  originalTextarea.value = 'Submitted note';
  await originalTextarea.dispatchEvent({ type: 'input' });
  const pending = host.querySelectorAll('form[data-record-id]')[0].dispatchEvent({ type: 'submit' });
  render();

  const replacementTextarea = host.querySelectorAll('textarea[data-account-note-record-id]')[0];
  replacementTextarea.value = 'Newer replacement draft';
  assert.equal(noteDrafts.get(record.id), 'Submitted note');
  gate.resolve();
  await pending;

  assert.equal(record.history.length, 1);
  assert.equal(noteDrafts.get(record.id), 'Newer replacement draft');
  assert.equal(host.querySelectorAll('textarea[data-account-note-record-id]')[0].value, 'Newer replacement draft');
});

test('successful note save with a failed refresh does not report a failed save', async () => {
  const document = new SyntheticDocument();
  const host = document.createElement('div');
  const record = { id: 'synthetic-account', category: 'account', title: 'Synthetic account', revision: 1, history: [] };
  const errors = [];
  let notices = 0;
  const render = createAccountRenderer({
    document, host, records: [record], noteDrafts: new Map(), pendingNotes: new Set(), expandedHistory: new Set(),
    callbacks: {
      saveNote: async (target, text) => { target.history.push({ text, createdAt: '2026-01-01T00:00:00.000Z' }); },
      refresh: async () => { throw new Error('Synthetic refresh failure.'); },
      notify: () => { notices++; },
      onError: error => errors.push(error.message)
    }
  });
  render();
  const textarea = host.querySelectorAll('textarea[data-account-note-record-id]')[0];
  textarea.value = 'Committed note';
  await textarea.dispatchEvent({ type: 'input' });
  await host.querySelectorAll('form[data-record-id]')[0].dispatchEvent({ type: 'submit' });

  assert.equal(record.history.length, 1);
  assert.equal(notices, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /note was saved locally, but the account list could not be refreshed/);
  assert.match(errors[0], /Synthetic refresh failure/);
  assert.equal(host.querySelectorAll('textarea[data-account-note-record-id]')[0].value, '');
});

test('account records render untrusted titles and notes as literal text, never elements', () => {
  const document = new SyntheticDocument();
  const host = document.createElement('div');
  const title = '<img src=x onerror=alert(1)>';
  const note = '<script>not executable</script>';
  const render = createAccountRenderer({
    document,
    host,
    records: [{
      id: 'synthetic-account',
      category: 'account',
      title,
      note,
      history: [{ text: '<svg onload=alert(2)>', createdAt: '2026-01-01T00:00:00.000Z' }]
    }],
    noteDrafts: new Map(),
    pendingNotes: new Set(),
    expandedHistory: new Set()
  });
  render();

  const descendants = [];
  const visit = element => {
    descendants.push(element);
    for (const child of element.children) visit(child);
  };
  visit(host);
  assert.equal(descendants.find(element => element.tagName === 'STRONG').textContent, title);
  assert.equal(descendants.find(element => element.tagName === 'P' && element.textContent === note).textContent, note);
  assert.equal(descendants.some(element => ['IMG', 'SCRIPT', 'SVG'].includes(element.tagName)), false);
});

test('account source links remain explicit and inert when missing or unsafe', () => {
  const document = new SyntheticDocument();
  const host = document.createElement('div');
  const records = [
    { id: 'valid', category: 'account', title: 'Valid link', sourceUrl: 'https://example.invalid/account', history: [] },
    { id: 'unsafe', category: 'account', title: 'Unsafe link', sourceUrl: 'javascript:alert(1)', history: [] },
    { id: 'credentials', category: 'account', title: 'Credential link', sourceUrl: 'https://owner:secret@example.invalid/account', history: [] },
    { id: 'legacy', category: 'account', title: 'Legacy record', history: [] }
  ];
  const render = createAccountRenderer({
    document, host, records, noteDrafts: new Map(), pendingNotes: new Set(), expandedHistory: new Set()
  });
  render();

  const links = host.querySelectorAll('a[data-account-focus-key]');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.invalid/account');
  assert.equal(links[0].target, '_blank');
  assert.equal(links[0].rel, 'noopener noreferrer');
  const unsafe = host.children.find(card => card.children.some(child => child.textContent === 'Unsafe link'));
  assert.equal(unsafe.children.some(child => child.tagName === 'A'), false);
  assert.equal(unsafe.children.some(child => child.textContent === 'Invalid source link not opened'), true);
  const credentials = host.children.find(card => card.children.some(child => child.textContent === 'Credential link'));
  assert.equal(credentials.children.some(child => child.tagName === 'A'), false);
  const legacy = host.children.find(card => card.children.some(child => child.textContent === 'Legacy record'));
  assert.equal(legacy.children.some(child => child.className === 'saved-link'), false);
});

test('account rerenders restore focus to actionable controls that remain present', () => {
  const document = new SyntheticDocument();
  const host = document.createElement('div');
  const record = {
    id: 'synthetic-account',
    category: 'account',
    title: 'Synthetic account',
    sourceUrl: 'https://example.invalid/account',
    history: []
  };
  const render = createAccountRenderer({
    document, host, records: [record], noteDrafts: new Map(), pendingNotes: new Set(), expandedHistory: new Set()
  });
  render();

  for (const key of ['edit:synthetic-account', 'history-summary:synthetic-account', 'note-submit:synthetic-account', 'source:synthetic-account']) {
    const focused = host.querySelectorAll('[data-account-focus-key]')
      .find(element => element.dataset.accountFocusKey === key);
    assert.ok(focused, `expected control ${key}`);
    focused.focus();
    render();
    assert.equal(document.activeElement.dataset.accountFocusKey, key);
  }
});
