import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLocalApiResponse } from '../public/outcome-import-workflow.mjs';
import { bindPipelineSnapshotWorkflow, filterAndSortPipelineRows, renderPipelineSnapshotTable } from '../public/pipeline-snapshots.mjs';

class EventTarget {
  constructor() {
    this.listeners = new Map();
    this.disabled = false;
    this.checked = false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatch(type) {
    const event = { type, preventDefault() {} };
    for (const listener of this.listeners.get(type) || []) await listener(event);
  }
}

class Element extends EventTarget {
  constructor(document, tag) {
    super();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.textContent = '';
  }

  append(...items) {
    this.children.push(...items);
  }

  replaceChildren(...items) {
    this.children = items;
  }

  set innerHTML(_) {
    throw new Error('Production table rendering must not use innerHTML.');
  }
}

class Document {
  createElement(tag) {
    return new Element(this, tag);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function controls() {
  return {
    form: new EventTarget(),
    typeInput: Object.assign(new EventTarget(), { value: 'opportunities' }),
    textInput: Object.assign(new EventTarget(), { value: 'Name\tStage\nExample\tReview' }),
    reviewInput: new EventTarget(),
    previewButton: new EventTarget(),
    discardButton: new EventTarget(),
    confirmButton: new EventTarget(),
    refreshSavedButton: new EventTarget(),
    resolveSavedInput: new EventTarget(),
    resolveSavedButton: new EventTarget(),
    abandonSavedInput: new EventTarget(),
    abandonSavedButton: new EventTarget()
  };
}

const preview = {
  type: 'opportunities',
  headers: ['Name', 'Stage'],
  rows: [['Example', 'Review']],
  textHash: 'synthetic-hash',
  revision: 'synthetic-revision',
  duplicateSnapshotId: null
};

function validReceipt(submitted, requestId, overrides = {}) {
  return {
    saved: true,
    duplicate: false,
    deduplicated: false,
    snapshot: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      type: submitted.type,
      headers: submitted.headers,
      rows: submitted.rows,
      contentHash: submitted.textHash,
      revision: 1,
      requestId,
      provenance: 'owner-pasted-unverified',
      createdAt: '2026-01-02T03:04:05.000Z',
      ...overrides
    }
  };
}

test('pipeline table search, column filter, and sort use supplied values only', () => {
  const snapshot = {
    headers: ['Owner-entered name', 'Owner-entered stage'],
    rows: [['Bravo', 'Review'], ['alpha', 'Planning'], ['Charlie', 'Review']]
  };
  assert.deepEqual(filterAndSortPipelineRows(snapshot, '', 0, 'asc'), [
    ['alpha', 'Planning'], ['Bravo', 'Review'], ['Charlie', 'Review']
  ]);
  assert.deepEqual(filterAndSortPipelineRows(snapshot, 'char', -1, 'asc'), [['Charlie', 'Review']]);
  assert.deepEqual(filterAndSortPipelineRows(snapshot, '', -1, 'asc', 1, 'review'), [
    ['Bravo', 'Review'], ['Charlie', 'Review']
  ]);
});

test('preview changed while pending is discarded and never becomes confirmable', async () => {
  const ui = controls();
  const gate = deferred();
  const notices = [];
  let rendered;
  const workflow = bindPipelineSnapshotWorkflow({
    ...ui,
    request: async () => gate.promise,
    renderPreview: state => { rendered = state; },
    onNotice: (message, error) => notices.push({ message, error }),
    onSaved: () => assert.fail('A stale preview must never be saved.'),
    onRefreshSaved: async () => {}
  });

  const pending = ui.form.dispatch('submit');
  ui.textInput.value = 'Changed\ttext\nNew\tvalue';
  await ui.textInput.dispatch('input');
  gate.resolve(preview);
  await pending;
  assert.equal(workflow.getPreview(), null);
  assert.equal(ui.confirmButton.disabled, true);
  assert.equal(ui.textInput.value, 'Changed\ttext\nNew\tvalue');
  assert.match(notices.at(-1).message, /changed while previewing/);
  assert.equal(rendered.preview, null);
});

test('confirmation blocks concurrent submits and retries an uncertain result with the same request ID', async () => {
  const ui = controls();
  const gate = deferred();
  const notices = [];
  const confirmBodies = [];
  let confirmCalls = 0;
  let saved = 0;
  let previewState;
  const workflow = bindPipelineSnapshotWorkflow({
    ...ui,
    request: async (path, options) => {
      if (path.endsWith('/preview')) return preview;
      const body = JSON.parse(options.body);
      confirmBodies.push(body);
      confirmCalls++;
      if (confirmCalls === 1) {
        await gate.promise;
        throw new Error('Synthetic connection dropped after request.');
      }
      return validReceipt(preview, body.requestId);
    },
    renderPreview: state => { previewState = state; },
    onNotice: (message, error) => notices.push({ message, error }),
    onSaved: async () => { saved++; },
    onRefreshSaved: async () => {}
  });

  await ui.form.dispatch('submit');
  assert.equal(workflow.getPreview().text, ui.textInput.value);
  ui.reviewInput.checked = true;
  await ui.reviewInput.dispatch('change');
  const uncertain = ui.confirmButton.dispatch('click');
  await ui.confirmButton.dispatch('click');
  assert.equal(confirmCalls, 1);
  assert.equal(workflow.isPending(), true);
  gate.resolve();
  await uncertain;
  assert.equal(workflow.getPreview().text, ui.textInput.value);
  assert.equal(workflow.getPreview().textHash, preview.textHash);
  assert.equal(ui.confirmButton.disabled, false);
  await ui.confirmButton.dispatch('click');

  assert.equal(confirmCalls, 2);
  assert.equal(confirmBodies[0].requestId, confirmBodies[1].requestId);
  assert.equal(confirmBodies[0].textHash, confirmBodies[1].textHash);
  assert.equal(saved, 1);
  assert.equal(workflow.getPreview(), null);
  assert.equal(workflow.getUncertainConfirmation(), null);
  assert.equal(previewState.preview, null);
});

test('a rejected retry keeps a committed-first request uncertain until owner-reviewed resolution', async () => {
  const ui = controls();
  const notices = [];
  const confirmBodies = [];
  const persistedSnapshots = [];
  let confirmCalls = 0;
  let refreshCalls = 0;
  let ownerFoundExactSnapshot = false;
  const workflow = bindPipelineSnapshotWorkflow({
    ...ui,
    request: async (path, options) => {
      if (path.endsWith('/preview')) return preview;
      const body = JSON.parse(options.body);
      confirmBodies.push(body);
      confirmCalls++;
      if (confirmCalls === 1) {
        persistedSnapshots.push(validReceipt(preview, body.requestId).snapshot);
        throw new Error('Connection dropped after the server committed.');
      }
      const error = new Error('Authentication required.');
      error.status = 401;
      throw error;
    },
    renderPreview: () => {},
    onNotice: (message, error) => notices.push({ message, error }),
    onSaved: async () => {},
    onRefreshSaved: async () => {
      refreshCalls++;
      if (refreshCalls === 1) {
        const error = new Error('Authentication required.');
        error.status = 401;
        throw error;
      }
      ownerFoundExactSnapshot = persistedSnapshots.some(snapshot =>
        snapshot.type === preview.type && snapshot.contentHash === preview.textHash
          && JSON.stringify(snapshot.headers) === JSON.stringify(preview.headers)
          && JSON.stringify(snapshot.rows) === JSON.stringify(preview.rows));
    }
  });

  await ui.form.dispatch('submit');
  ui.reviewInput.checked = true;
  await ui.reviewInput.dispatch('change');
  await ui.confirmButton.dispatch('click');
  const submittedText = workflow.getPreview().text;
  assert.equal(workflow.getUncertainConfirmation().preview.text, submittedText);
  await ui.confirmButton.dispatch('click');

  assert.equal(confirmCalls, 2);
  assert.equal(confirmBodies[0].requestId, confirmBodies[1].requestId);
  assert.equal(confirmBodies[0].text, confirmBodies[1].text);
  assert.equal(workflow.getUncertainConfirmation().preview.text, submittedText);
  assert.match(notices.at(-1).message, /earlier confirmation may have saved/);
  assert.equal(ui.confirmButton.disabled, false);
  assert.equal(ui.previewButton.disabled, true);
  await ui.form.dispatch('submit');
  assert.equal(confirmCalls, 2);

  await ui.refreshSavedButton.dispatch('click');
  assert.equal(workflow.getUncertainConfirmation().preview.text, submittedText);
  assert.equal(ui.resolveSavedInput.disabled, true);
  await ui.refreshSavedButton.dispatch('click');
  assert.equal(ownerFoundExactSnapshot, true);
  assert.equal(ui.resolveSavedInput.disabled, false);
  ui.resolveSavedInput.checked = true;
  await ui.resolveSavedInput.dispatch('change');
  assert.equal(ui.resolveSavedButton.disabled, false);
  await ui.resolveSavedButton.dispatch('click');

  assert.equal(workflow.getUncertainConfirmation(), null);
  assert.equal(confirmCalls, 2);
  assert.equal(ui.textInput.value, submittedText);
  assert.match(notices.at(-1).message, /No new confirmation was submitted/);
});

test('owner can abandon an absent table after stale-revision rejection and explicitly preview again', async () => {
  const ui = controls();
  const notices = [];
  const confirmBodies = [];
  const refreshedPreview = { ...preview, revision: 'refreshed-revision' };
  let previewCalls = 0;
  let confirmCalls = 0;
  let rendered;
  const workflow = bindPipelineSnapshotWorkflow({
    ...ui,
    request: async (path, options) => {
      if (path.endsWith('/preview')) {
        previewCalls++;
        return previewCalls === 1 ? preview : refreshedPreview;
      }
      const body = JSON.parse(options.body);
      confirmBodies.push(body);
      confirmCalls++;
      if (confirmCalls === 1) throw new Error('Connection lost before a receipt arrived.');
      if (confirmCalls === 2) {
        const error = new Error('Snapshot revision changed.');
        error.status = 409;
        throw error;
      }
      return validReceipt(refreshedPreview, body.requestId);
    },
    renderPreview: state => { rendered = state; },
    onNotice: (message, error) => notices.push({ message, error }),
    onSaved: async () => {},
    onRefreshSaved: async type => {
      assert.equal(type, preview.type);
      // The refreshed complete list contains no matching owner-pasted table.
    }
  });

  const pastedText = ui.textInput.value;
  await ui.form.dispatch('submit');
  ui.reviewInput.checked = true;
  await ui.reviewInput.dispatch('change');
  await ui.confirmButton.dispatch('click');
  await ui.confirmButton.dispatch('click');
  assert.equal(confirmCalls, 2);
  assert.equal(confirmBodies[0].requestId, confirmBodies[1].requestId);
  assert.equal(workflow.getUncertainConfirmation().preview.text, pastedText);
  assert.match(notices.at(-1).message, /earlier confirmation may have saved/);

  await ui.refreshSavedButton.dispatch('click');
  assert.equal(ui.abandonSavedInput.disabled, false);
  assert.equal(ui.previewButton.disabled, true);
  ui.abandonSavedInput.checked = true;
  await ui.abandonSavedInput.dispatch('change');
  assert.equal(ui.resolveSavedInput.checked, false);
  assert.equal(ui.abandonSavedButton.disabled, false);
  await ui.abandonSavedButton.dispatch('click');

  assert.equal(workflow.getUncertainConfirmation(), null);
  assert.equal(workflow.getPreview(), null);
  assert.equal(ui.textInput.value, pastedText);
  assert.equal(ui.previewButton.disabled, false);
  assert.equal(ui.confirmButton.disabled, true);
  assert.equal(confirmCalls, 2);
  assert.equal(rendered.abandoned.type, preview.type);
  assert.match(notices.at(-1).message, /remains unresolved and may still have saved/);
  assert.match(notices.at(-1).message, /Nothing was submitted/);

  await ui.form.dispatch('submit');
  assert.equal(previewCalls, 2);
  assert.equal(workflow.getPreview().revision, 'refreshed-revision');
  assert.equal(ui.textInput.value, pastedText);
  ui.reviewInput.checked = true;
  await ui.reviewInput.dispatch('change');
  await ui.confirmButton.dispatch('click');

  assert.equal(confirmCalls, 3);
  assert.notEqual(confirmBodies[1].requestId, confirmBodies[2].requestId);
  assert.equal(confirmBodies[2].revision, 'refreshed-revision');
  assert.equal(rendered.abandoned, null);
});

test('an initial definitive 4xx rejection is reported as unsaved and clears the request', async () => {
  const ui = controls();
  const notices = [];
  const requestIds = [];
  let saved = 0;
  let confirmations = 0;
  const workflow = bindPipelineSnapshotWorkflow({
    ...ui,
    request: async (path, options) => {
      if (path.endsWith('/preview')) return preview;
      const body = JSON.parse(options.body);
      requestIds.push(body.requestId);
      confirmations++;
      if (confirmations === 1) {
        return readLocalApiResponse(new Response(JSON.stringify({ error: 'Forbidden.' }), { status: 403 }));
      }
      return validReceipt(preview, body.requestId);
    },
    renderPreview: () => {},
    onNotice: (message, error) => notices.push({ message, error }),
    onSaved: async () => { saved++; },
    onRefreshSaved: async () => {}
  });

  await ui.form.dispatch('submit');
  ui.reviewInput.checked = true;
  await ui.reviewInput.dispatch('change');
  await ui.confirmButton.dispatch('click');

  assert.equal(workflow.getUncertainConfirmation(), null);
  assert.equal(workflow.getPreview(), null);
  assert.match(notices.at(-1).message, /^Snapshot was not saved: Forbidden/);
  assert.equal(ui.previewButton.disabled, false);
  assert.equal(ui.confirmButton.disabled, true);

  await ui.form.dispatch('submit');
  ui.reviewInput.checked = true;
  await ui.reviewInput.dispatch('change');
  await ui.confirmButton.dispatch('click');
  assert.equal(confirmations, 2);
  assert.notEqual(requestIds[0], requestIds[1]);
  assert.equal(saved, 1);
});

test('malformed initial 4xx response from the shared parser remains uncertain in the real submit handler', async () => {
  const ui = controls();
  const notices = [];
  const workflow = bindPipelineSnapshotWorkflow({
    ...ui,
    request: async path => path.endsWith('/preview')
      ? preview
      : readLocalApiResponse(new Response('not json', { status: 403 })),
    renderPreview: () => {},
    onNotice: (message, error) => notices.push({ message, error }),
    onSaved: async () => assert.fail('A malformed 4xx response is not a confirmed save.'),
    onRefreshSaved: async () => {}
  });

  await ui.form.dispatch('submit');
  ui.reviewInput.checked = true;
  await ui.reviewInput.dispatch('change');
  await ui.confirmButton.dispatch('click');

  assert.equal(workflow.getUncertainConfirmation().preview.text, ui.textInput.value);
  assert.equal(ui.previewButton.disabled, true);
  assert.equal(ui.confirmButton.textContent, 'Retry same confirmation safely');
  assert.match(notices.at(-1).message, /may have been saved/);
  assert.doesNotMatch(notices.at(-1).message, /^Snapshot was not saved/);
});

test('malformed and mismatched successful receipts remain explicitly uncertain', async () => {
  const receipts = [
    { saved: true, snapshot: { id: 'incomplete' } },
    validReceipt(preview, '550e8400-e29b-41d4-a716-446655440001', { contentHash: 'wrong-hash' }),
    validReceipt(preview, '550e8400-e29b-41d4-a716-446655440001', { type: 'milestones' }),
    validReceipt(preview, '550e8400-e29b-41d4-a716-446655440001', { rows: [['different', 'values']] })
  ];

  for (const receipt of receipts) {
    const ui = controls();
    const notices = [];
    let saved = false;
    const workflow = bindPipelineSnapshotWorkflow({
      ...ui,
      request: async path => path.endsWith('/preview') ? preview : receipt,
      renderPreview: () => {},
      onNotice: (message, error) => notices.push({ message, error }),
      onSaved: async () => { saved = true; },
      onRefreshSaved: async () => {}
    });

    await ui.form.dispatch('submit');
    ui.reviewInput.checked = true;
    await ui.reviewInput.dispatch('change');
    await ui.confirmButton.dispatch('click');

    assert.equal(saved, false);
    assert.equal(workflow.getPreview().text, ui.textInput.value);
    assert.equal(workflow.getUncertainConfirmation().preview.textHash, preview.textHash);
    assert.match(notices.at(-1).message, /may have been saved.*Check saved snapshots/);
    assert.equal(ui.confirmButton.textContent, 'Retry same confirmation safely');
    assert.equal(ui.previewButton.disabled, true);
    assert.equal(ui.textInput.value, 'Name\tStage\nExample\tReview');
  }
});

test('transport uncertainty retains the reviewed request while preserving edits made in flight', async () => {
  const ui = controls();
  const gate = deferred();
  const bodies = [];
  let confirmCalls = 0;
  const workflow = bindPipelineSnapshotWorkflow({
    ...ui,
    request: async (path, options) => {
      if (path.endsWith('/preview')) return preview;
      const body = JSON.parse(options.body);
      bodies.push(body);
      confirmCalls++;
      if (confirmCalls === 1) {
        await gate.promise;
        throw new Error('Synthetic connection dropped after request.');
      }
      return validReceipt(preview, body.requestId);
    },
    renderPreview: () => {},
    onNotice: () => {},
    onSaved: async () => {},
    onRefreshSaved: async () => {}
  });
  await ui.form.dispatch('submit');
  ui.reviewInput.checked = true;
  await ui.reviewInput.dispatch('change');
  const pending = ui.confirmButton.dispatch('click');
  ui.textInput.value = 'New unsaved table\tNew header\nUser edit\tStill local';
  await ui.textInput.dispatch('input');
  gate.resolve();
  await pending;

  assert.equal(ui.textInput.value, 'New unsaved table\tNew header\nUser edit\tStill local');
  assert.equal(workflow.getPreview(), null);
  assert.equal(workflow.getUncertainConfirmation().preview.text, 'Name\tStage\nExample\tReview');
  assert.equal(ui.confirmButton.disabled, false);
  await ui.confirmButton.dispatch('click');

  assert.equal(confirmCalls, 2);
  assert.equal(bodies[0].requestId, bodies[1].requestId);
  assert.equal(bodies[0].text, bodies[1].text);
  assert.equal(ui.textInput.value, 'New unsaved table\tNew header\nUser edit\tStill local');
  assert.equal(workflow.getUncertainConfirmation(), null);
});

test('valid receipt followed by refresh failure is reported as saved, not as a duplicate or uncertain save', async () => {
  const ui = controls();
  const notices = [];
  let submittedRequestId;
  const workflow = bindPipelineSnapshotWorkflow({
    ...ui,
    request: async (path, options) => {
      if (path.endsWith('/preview')) return preview;
      const body = JSON.parse(options.body);
      submittedRequestId = body.requestId;
      return validReceipt(preview, body.requestId);
    },
    renderPreview: () => {},
    onNotice: (message, error) => notices.push({ message, error }),
    onSaved: async () => { throw new Error('Synthetic list refresh failure.'); },
    onRefreshSaved: async () => {}
  });
  await ui.form.dispatch('submit');
  ui.reviewInput.checked = true;
  await ui.reviewInput.dispatch('change');
  await ui.confirmButton.dispatch('click');

  assert.ok(submittedRequestId);
  assert.equal(workflow.getPreview(), null);
  assert.equal(workflow.getUncertainConfirmation(), null);
  assert.equal(ui.textInput.value, 'Name\tStage\nExample\tReview');
  assert.match(notices.at(-1).message, /^The snapshot was saved locally, but the saved list could not be refreshed/);
});

test('pipeline table renderer displays untrusted cell values literally without creating elements', () => {
  const document = new Document();
  const host = new Element(document, 'div');
  const dangerous = '<img src=x onerror=alert(1)>';
  renderPipelineSnapshotTable(document, host, {
    headers: ['Owner header'],
    rows: [[dangerous]]
  });
  const table = host.children[0];
  assert.equal(table.tagName, 'TABLE');
  assert.equal(table.children[1].children[0].children[0].textContent, 'Owner header');
  assert.equal(table.children[2].children[0].children[0].textContent, dangerous);
  const tags = [];
  const visit = element => {
    tags.push(element.tagName);
    for (const child of element.children) visit(child);
  };
  visit(host);
  assert.equal(tags.includes('IMG'), false);
});
