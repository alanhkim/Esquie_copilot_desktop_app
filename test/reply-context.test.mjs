import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const appUrl = new URL('../public/app.js', import.meta.url);
const boardUrl = new URL('../public/task-board.mjs', import.meta.url);
const appScript = await readFile(appUrl, 'utf8');
const boardScript = await readFile(boardUrl, 'utf8');

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.value = '';
    this.disabled = false;
    this.classList = { toggle() {} };
  }
  set innerHTML(_) { throw new Error('Source HTML must never be parsed.'); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join('\n'); }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  setAttribute(name, value) { this[name] = value; }
  scrollIntoView() {}
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  async fire(type) {
    for (const handler of this.listeners[type] || []) await handler({ currentTarget: this, preventDefault() {} });
  }
}

function fixture(id = 'fake-original', extra = {}) {
  return {
    id: 'fake-check', kind: 'source_refresh', updatedAt: '2026-01-02T03:04:05Z', status: 'partial',
    result: { sources: [{
      source: 'mail', resultId: '00000000-0000-4000-8000-000000000001', status: 'bounded', inspected: 1,
      coverage: { status: 'partial', limitations: ['Only a synthetic bounded preview.'] },
      items: [{
        id, sourceKey: `fake-key-${id}`, title: 'Synthetic question',
        excerpt: 'Synthetic original preview, not a thread.',
        url: 'https://example.invalid/original', excerptTruncated: true, contentAvailable: false,
        ...extra
      }]
    }] }
  };
}

async function setup() {
  const elements = new Map();
  const query = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const form = query('#outlook-draft-form');
  const controls = ['messageId', 'text', 'replyAll'].map(() => new Element('input'));
  form.elements = Object.assign(controls, { messageId: controls[0], text: controls[1], replyAll: controls[2] });
  form.elements.replyAll.value = 'false';
  const submit = query('#outlook-draft-form button[type="submit"]');
  form.elements.push(submit);
  const taskForm = query('#task-form');
  const taskNames = ['title', 'details', 'status', 'priority', 'dueDate'];
  const taskControls = taskNames.map(name => Object.assign(new Element('input'), { name }));
  taskForm.elements = Object.assign(taskControls, Object.fromEntries(taskNames.map((name, index) => [name, taskControls[index]])));
  query('#outcome-import-form').elements = { text: new Element('textarea'), reviewed: new Element('input') };
  const requests = [];
  const context = vm.createContext({
    document: { querySelector: query, querySelectorAll: () => [], createElement: tag => new Element(tag) },
    window: { addEventListener() {} }, location: { hash: '' }, history: { replaceState() {} },
    sessionStorage: { getItem: () => '', setItem() {} }, crypto: { randomUUID },
    URL, URLSearchParams, Headers,
    FormData: class {
      constructor(form) { this.values = [...form.elements].filter(control => control.name).map(control => [control.name, control.value]); }
      [Symbol.iterator]() { return this.values[Symbol.iterator](); }
    },
    setTimeout() {}, clearTimeout() {}, setInterval() {},
    fetch: async (path, options) => {
      requests.push({ path, ...options });
      throw new Error('No external access permitted by this fake UI harness.');
    }
  });
  const boardModule = new vm.SourceTextModule(boardScript, {
    context, identifier: boardUrl.href
  });
  // Test-only lexical access preserves the application's original module imports.
  const appModule = new vm.SourceTextModule(`${appScript}\nexport const evaluateForTest = expression => eval(expression);`, {
    context, identifier: appUrl.href
  });
  await appModule.link((specifier, referencingModule) => {
    assert.equal(new URL(specifier, referencingModule.identifier).href, boardUrl.href);
    return boardModule;
  });
  await appModule.evaluate();
  await new Promise(resolve => setImmediate(resolve));
  const run = appModule.namespace.evaluateForTest;
  assert.equal(run('laneMove'), boardModule.namespace.laneMove);
  assert.equal(run('matchingTasks'), boardModule.namespace.matchingTasks);
  return {
    query, form, requests, context, run,
    async select(job = fixture(), buttonText = 'Review an unsent reply') {
      context.fakeJob = job;
      run('workspace.jobs = [fakeJob]; renderJobs();');
      const walk = element => [element, ...element.children.flatMap(walk)];
      const button = walk(query('#job-list')).find(element => element.tagName === 'BUTTON' && element.textContent === buttonText);
      assert.ok(button, 'the source result must expose the actual review button');
      await button.fire('click');
      return button;
    }
  };
}

test('reply UI retains real board module search and revision-bound lane behavior', async () => {
  const ui = await setup();
  ui.run(`
    workspace.tasks = [
      { id: 'fake-search-target', title: 'Matching local task', status: 'next', revision: 4 },
      { id: 'fake-other-task', title: 'Unrelated local task', status: 'waiting', revision: 1 }
    ];
    workspace.conversations = [{ taskId: 'fake-search-target', text: 'Synthetic note needle' }];
  `);
  ui.query('#task-search').value = 'needle';
  ui.run('renderTasks();');
  assert.match(ui.query('#task-list').textContent, /Matching local task/);
  assert.doesNotMatch(ui.query('#task-list').textContent, /Unrelated local task/);
  assert.equal(ui.run("laneMove(workspace.tasks[0], 'waiting').revision"), 4);
  assert.equal(ui.run("laneMove(workspace.tasks[0], 'done', { drag: true })"), null);
  assert.equal(ui.run('workspace.tasks[0].status'), 'next');
  assert.equal(ui.requests.length, 0);
});

test('reviewing a source preserves its exact inert preview without authorizing or mutating anything', async () => {
  const ui = await setup();
  const html = '<img src=x onerror="sendMail()"><script>sendMail()</script>';
  const job = fixture('fake-original', { title: html, excerpt: html, url: 'javascript:sendMail()' });
  await ui.select(job);
  const preview = ui.query('#outlook-source-preview');
  assert.ok(preview.textContent.includes(html));
  assert.match(preview.textContent, /read-only, incomplete evidence/);
  assert.match(preview.textContent, /not a complete thread or verified participants/);
  assert.match(preview.textContent, /fake-original/);
  assert.match(preview.textContent, /fake-check/);
  assert.match(preview.textContent, /excerpt truncated at 600 characters/);
  assert.match(preview.textContent, /metadata only, content unavailable/);
  assert.match(preview.textContent, /Only a synthetic bounded preview/);
  assert.equal(preview.children.some(child => child.tagName === 'A'), false);
  assert.equal(ui.form.elements.messageId.value, 'fake-original');
  assert.equal(ui.query('#breadcrumb').textContent, 'Draft Studio');
  assert.equal(ui.form.elements.text.value, '');
  assert.equal(ui.requests.length, 0);
  job.result.sources[0].items[0].excerpt = 'Changed backing preview';
  ui.run('renderOutlookSourcePreview();');
  assert.ok(preview.textContent.includes(html), 'selection is a snapshot, not a mutable source reference');
});

test('switching a source blocks unsaved reply reuse, including a new preview of the same ID', async () => {
  const ui = await setup();
  await ui.select();
  ui.form.elements.text.value = 'Synthetic unsaved reply for original only.';
  ui.form.elements.replyAll.value = 'true';
  const requestId = ui.run('outlookRequestId');
  for (const next of [fixture('fake-other'), fixture('fake-original', { excerpt: 'Different historical preview' })]) {
    await ui.select(next);
    assert.equal(ui.form.elements.messageId.value, 'fake-original');
    assert.equal(ui.form.elements.text.value, 'Synthetic unsaved reply for original only.');
    assert.equal(ui.run('outlookRequestId'), requestId);
    assert.match(ui.query('#notice').textContent, /Source not changed/);
    assert.doesNotMatch(ui.query('#outlook-source-preview').textContent, /Different historical preview/);
  }
  await ui.select();
  assert.equal(ui.run('outlookRequestId'), requestId, 'reselecting the exact snapshot is not a new request');
  ui.form.elements.text.value = '';
  await ui.select(fixture('fake-other', { excerpt: 'New synthetic context' }));
  assert.equal(ui.form.elements.messageId.value, 'fake-other');
  assert.equal(ui.form.elements.replyAll.value, 'false');
  assert.match(ui.query('#outlook-source-preview').textContent, /New synthetic context/);
  assert.doesNotMatch(ui.query('#outlook-source-preview').textContent, /Synthetic original preview/);
  assert.notEqual(ui.run('outlookRequestId'), requestId);
  assert.equal(ui.requests.length, 0);
});

test('exact ID edits clear evidence without restoring it when the old ID is typed back', async () => {
  const ui = await setup();
  await ui.select();
  ui.form.elements.replyAll.value = 'true';
  ui.form.elements.messageId.value = 'fake-other';
  await ui.form.fire('input');
  assert.equal(ui.run('outlookSourcePreview'), null);
  assert.equal(ui.form.elements.replyAll.value, 'false');
  assert.match(ui.query('#outlook-source-preview').textContent, /No selected preview/);
  ui.form.elements.messageId.value = 'fake-original';
  await ui.form.fire('change');
  assert.equal(ui.run('outlookSourcePreview'), null);
  ui.form.elements.text.value = 'Original target reply';
  ui.form.elements.messageId.value = 'fake-other';
  await ui.form.fire('input');
  assert.equal(ui.form.elements.messageId.value, 'fake-original', 'nonempty replies keep their original target');
  assert.equal(ui.form.elements.text.value, 'Original target reply');
  assert.match(ui.query('#notice').textContent, /Message ID not changed/);
  assert.equal(ui.requests.length, 0);
});

test('submit rejects a target changed without an input event; reload retains no preview or reply', async () => {
  const ui = await setup();
  await ui.select();
  ui.form.elements.text.value = 'Original target reply';
  ui.form.elements.messageId.value = 'fake-other';
  await ui.form.fire('submit');
  assert.equal(ui.form.elements.messageId.value, 'fake-original');
  assert.equal(ui.requests.length, 0);
  const reloaded = await setup();
  assert.equal(reloaded.run('outlookSourcePreview'), null);
  assert.equal(reloaded.form.elements.text.value, '');
  assert.match(reloaded.query('#outlook-source-preview').textContent, /No selected preview/);
});

test('pending requests lock target selection and do not replay on selection or failure', async () => {
  const ui = await setup();
  await ui.select();
  ui.form.elements.text.value = 'Synthetic approved reply';
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  let finish;
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (path === '/api/mail/reply-drafts') return new Promise(resolve => { finish = resolve; });
    if (path === '/api/connections') return Response.json({
      microsoft365: { hostAuthenticationAvailable: false }, email: { available: false },
      assistant: { code: 'runtime-unverified' }
    });
    if (path === '/api/output-settings') return Response.json({ directory: 'fake-only', approved: false });
    throw new Error('Unexpected fake request');
  };
  const pending = ui.form.fire('submit');
  assert.equal(ui.form.elements.every(control => control.disabled), true);
  await ui.form.fire('submit');
  await ui.select(fixture('fake-other'));
  assert.equal(ui.form.elements.messageId.value, 'fake-original');
  assert.match(ui.query('#notice').textContent, /Wait for the current draft request/);
  await ui.run('renderConnections();');
  assert.equal(ui.query('#outlook-draft-form button[type="submit"]').disabled, true);
  finish(Response.json({ error: 'Synthetic unknown outcome; inspect Outlook manually.' }, { status: 502 }));
  await pending;
  const writes = ui.requests.filter(request => request.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/api/mail/reply-drafts');
  const payload = JSON.parse(writes[0].body);
  assert.equal(payload.messageId, 'fake-original');
  assert.equal(payload.text, 'Synthetic approved reply');
  assert.deepEqual(Object.keys(payload).sort(), ['messageId', 'replyAll', 'requestId', 'sourceReference', 'text']);
  assert.deepEqual(payload.sourceReference, {
    jobId: 'fake-check', resultId: '00000000-0000-4000-8000-000000000001', itemId: 'fake-key-fake-original'
  });
  assert.match(ui.query('#outlook-draft-result').textContent, /unknown outcome/);
  assert.equal(ui.form.elements.messageId.disabled, false);
  assert.equal(ui.query('#outlook-draft-form button[type="submit"]').disabled, true);
  assert.equal(ui.form.elements.text.value, 'Synthetic approved reply');
});

test('a failed connection-status refresh cannot re-enable submission after a failed request', async () => {
  const ui = await setup();
  await ui.select();
  ui.form.elements.text.value = 'Synthetic approved reply';
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  await ui.form.fire('submit');
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(ui.query('#outlook-draft-form button[type="submit"]').disabled, true);
  assert.equal(ui.form.elements.text.disabled, false);
  assert.equal(ui.form.elements.text.value, 'Synthetic approved reply');
});

test('explicitly entered IDs submit without a source-match claim, never falling back from selected evidence', async () => {
  const ui = await setup();
  await ui.select();
  ui.form.elements.messageId.value = 'fake-manual';
  await ui.form.fire('input');
  ui.form.elements.text.value = 'Synthetic manual-ID reply';
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  await ui.form.fire('submit');
  const payload = JSON.parse(ui.requests.find(request => request.method === 'POST').body);
  assert.equal(payload.messageId, 'fake-manual');
  assert.equal(Object.hasOwn(payload, 'sourceReference'), false);
  assert.match(ui.query('#outlook-source-preview').textContent, /No selected preview/);
});

test('a legacy preview is visibly non-actionable, preserves unsaved text and never falls back to a manual-ID request', async () => {
  const ui = await setup();
  const historical = fixture();
  delete historical.result.sources[0].resultId;
  await ui.select(historical);
  assert.match(ui.query('#outlook-source-preview').textContent, /Run a new bounded source check in Operations/);
  assert.match(ui.query('#outlook-source-preview').textContent, /No manual-ID fallback/);
  assert.equal(ui.query('#outlook-draft-form button[type="submit"]').disabled, true);
  ui.form.elements.text.value = 'Synthetic reply';
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (path === '/api/connections') return Response.json({
      microsoft365: { hostAuthenticationAvailable: true }, email: { available: true },
      assistant: { code: 'runtime-unverified' }
    });
    if (path === '/api/output-settings') return Response.json({ directory: 'fake-only', approved: false });
    throw new Error('Legacy preview must not make any draft request.');
  };
  ui.run('workspace.sourceConsent = { allowReplyDrafts: true }; sourceSettingsRendered = true;');
  await ui.run('renderConnections();');
  assert.equal(ui.query('#outlook-draft-form button[type="submit"]').disabled, true, 'authorized status cannot enable a legacy preview');
  const requestId = ui.run('outlookRequestId');
  const calls = ui.requests.length;
  await ui.form.fire('submit');
  assert.equal(ui.requests.length, calls);
  assert.match(ui.query('#outlook-draft-result').textContent, /Run a new bounded source check/);
  assert.equal(ui.form.elements.text.value, 'Synthetic reply');
  assert.equal(ui.form.elements.messageId.value, 'fake-original');
  assert.equal(ui.run('outlookSourcePreview.jobId'), 'fake-check');
  assert.equal(ui.run('outlookRequestId'), requestId);
  assert.equal(ui.form.elements.text.disabled, false);
  await ui.select();
  assert.equal(ui.run('outlookSourcePreview.resultId'), undefined, 'unsaved text also blocks selecting a replacement preview');
  assert.equal(ui.form.elements.text.value, 'Synthetic reply');
  ui.form.elements.text.value = '';
  await ui.select();
  assert.equal(ui.query('#outlook-draft-form button[type="submit"]').disabled, false);
  assert.doesNotMatch(ui.query('#outlook-source-preview').textContent, /Run a new bounded source check/);
});

test('task review captures the selected exact source revision and retains edits when stale evidence is rejected', async () => {
  const ui = await setup();
  const original = fixture();
  await ui.select(original, 'Review a new local task');
  const taskForm = ui.query('#task-form');
  assert.equal(ui.query('#task-dialog').open, true);
  assert.equal(taskForm.elements.title.value, 'Synthetic question');
  assert.match(ui.query('#task-source-review').textContent, /not proof of task ownership/);
  taskForm.elements.title.value = 'Owner-entered synthetic task title';
  taskForm.elements.details.value = 'Owner-entered synthetic details';
  original.result.sources[0].resultId = '00000000-0000-4000-8000-000000000002';
  original.result.sources[0].items[0].excerpt = 'Changed backing evidence';
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    return Response.json({ error: 'The selected evidence changed. Run a new bounded source check.' }, { status: 403 });
  };
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  await taskForm.fire('submit');
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].path, '/api/tasks/from-evidence');
  const payload = JSON.parse(ui.requests[0].body);
  assert.equal(payload.resultId, '00000000-0000-4000-8000-000000000001');
  assert.equal(payload.itemId, 'fake-key-fake-original');
  assert.equal(payload.jobId, 'fake-check');
  assert.equal(payload.source, 'mail');
  assert.equal(payload.title, 'Owner-entered synthetic task title');
  assert.equal(taskForm.elements.title.value, payload.title);
  assert.equal(taskForm.elements.details.value, payload.details);
  assert.equal(ui.query('#task-dialog').open, true);
  assert.match(ui.query('#task-source-review').textContent, /selected evidence changed/);
  assert.equal(ui.run('importingSource.resultId'), payload.resultId);
});

test('legacy task previews visibly require recheck, preserve entered task text and never become manual tasks', async () => {
  const ui = await setup();
  await ui.select(fixture(), 'Review a new local task');
  const taskForm = ui.query('#task-form');
  taskForm.elements.title.value = 'Keep this synthetic title';
  taskForm.elements.details.value = 'Keep these synthetic details';
  const legacy = fixture();
  delete legacy.result.sources[0].resultId;
  const button = await ui.select(legacy, 'Review a new local task');
  assert.equal(button.disabled, true);
  assert.match(ui.query('#job-list').textContent, /historical preview cannot create a task/);
  assert.match(ui.query('#job-list').textContent, /Run a new bounded source check in Operations/);
  assert.equal(taskForm.elements.title.value, 'Keep this synthetic title');
  assert.equal(taskForm.elements.details.value, 'Keep these synthetic details');
  assert.equal(ui.run('importingSource.resultId'), '00000000-0000-4000-8000-000000000001');
  ui.run('delete importingSource.resultId; renderTaskSourceReview();');
  assert.equal(ui.query('#task-form button[type="submit"]').disabled, true);
  assert.match(ui.query('#task-source-review').textContent, /no manual-task fallback/);
  await taskForm.fire('submit');
  assert.equal(ui.requests.length, 0);
  assert.equal(taskForm.elements.title.value, 'Keep this synthetic title');
  assert.equal(taskForm.elements.details.value, 'Keep these synthetic details');
  assert.equal(ui.run('importingSource !== null'), true);
});
