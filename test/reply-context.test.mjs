import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { startServer } from '../src/server.mjs';

const appUrl = new URL('../public/app.js', import.meta.url);
const boardUrl = new URL('../public/task-board.mjs', import.meta.url);
const appScript = await readFile(appUrl, 'utf8');
const moduleScripts = new Map(await Promise.all(
  ['task-board.mjs', 'account-search.mjs', 'account-workspace.mjs', 'outcome-import-workflow.mjs'].map(async name => {
    const url = new URL(`../public/${name}`, import.meta.url);
    return [url.href, await readFile(url, 'utf8')];
  })
));

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.value = '';
    this.disabled = false;
    this.dataset = {};
    this.classList = { toggle() {} };
  }
  set innerHTML(_) { throw new Error('Source HTML must never be parsed.'); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join('\n'); }
  append(...children) { for (const child of children) child.parentElement = this; this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  querySelectorAll(selector) {
    if (selector === '.task-card') {
      return this.children.flatMap(child => [
        ...(child.className?.split(' ').includes('task-card') ? [child] : []),
        ...child.querySelectorAll(selector)
      ]);
    }
    const match = /^(?:([a-z]+))?\[data-([a-z-]+)\]$/i.exec(selector);
    assert.ok(match, `Unsupported synthetic selector: ${selector}`);
    const key = match[2].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return this.children.flatMap(child => [
      ...((!match[1] || child.tagName === match[1].toUpperCase()) && Object.hasOwn(child.dataset, key) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  setAttribute(name, value) { this[name] = value; }
  scrollIntoView() {}
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  closest(selector) {
    if (selector === '.task-card' && this.className?.split(' ').includes('task-card')) return this;
    return this.parentElement?.closest(selector) || null;
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  reset() { for (const control of this.elements || []) if (control.name) control.value = control.defaultValue || ''; }
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
    if (!elements.has(selector)) elements.set(selector, Object.assign(new Element(), { ownerDocument: document }));
    return elements.get(selector);
  };
  const document = {
    activeElement: null, querySelector: query, querySelectorAll: () => [],
    createElement: tag => Object.assign(new Element(tag), { ownerDocument: document })
  };
  const form = query('#outlook-draft-form');
  const controls = ['messageId', 'text', 'replyAll'].map(() => new Element('input'));
  form.elements = Object.assign(controls, { messageId: controls[0], text: controls[1], replyAll: controls[2] });
  form.elements.replyAll.value = 'false';
  const submit = query('#outlook-draft-form button[type="submit"]');
  form.elements.push(submit);
  const taskForm = query('#task-form');
  const taskNames = ['title', 'details', 'status', 'priority', 'dueDate', 'accountId'];
  const taskControls = taskNames.map(name => Object.assign(new Element('input'), { name }));
  taskForm.elements = Object.assign(taskControls, Object.fromEntries(taskNames.map((name, index) => [name, taskControls[index]])));
  taskForm.elements.push(query('#task-form button[type="submit"]'));
  for (const [id, names] of Object.entries({
    'draft-form': ['recipient', 'subject', 'body'],
    'link-form': ['title', 'url'],
    'conversation-form': ['text'], 'evidence-form': ['title', 'url', 'note'],
    'outcome-form': ['category', 'title', 'date', 'note'],
    'account-form': ['title', 'note', 'plan', 'stakeholders'],
    'profile-form': ['displayName', 'timezone', 'email', 'role', 'manager', 'people', 'workspaceName', 'writingStyle']
  })) {
    const form = query(`#${id}`);
    const controls = names.map(name => Object.assign(new Element('input'), { name }));
    form.elements = Object.assign(controls, Object.fromEntries(names.map((name, index) => [name, controls[index]])));
    form.elements.push(query(`#${id} button[type="submit"]`));
  }
  for (const [selector, element] of elements) {
    element.id = selector.slice(1);
    element.querySelector = child => query(`${selector} ${child}`);
  }
  query('#outcome-import-form').elements = {
    text: new Element('textarea'), reviewed: new Element('input'),
    sourceMethod: Object.assign(new Element('select'), { value: 'pasted' })
  };
  const requests = [];
  const context = vm.createContext({
    document,
    window: { addEventListener() {}, confirm: () => true }, location: { hash: '' }, history: { replaceState() {} },
    sessionStorage: { getItem: () => '', setItem() {} }, crypto: { randomUUID },
    URL, URLSearchParams, Headers,
    FormData: class {
      constructor(form) { this.values = [...form.elements].filter(control => control.name && !control.disabled).map(control => [control.name, control.value]); }
      [Symbol.iterator]() { return this.values[Symbol.iterator](); }
    },
    setTimeout() {}, clearTimeout() {}, setInterval(callback) { context.backgroundRefresh = callback; },
    fetch: async (path, options) => {
      requests.push({ path, ...options });
      throw new Error('No external access permitted by this fake UI harness.');
    }
  });
  const modules = new Map([...moduleScripts].map(([identifier, source]) =>
    [identifier, new vm.SourceTextModule(source, { context, identifier })]));
  // Test-only lexical access preserves the application's original module imports.
  const appModule = new vm.SourceTextModule(`${appScript}\nexport const evaluateForTest = expression => eval(expression);`, {
    context, identifier: appUrl.href
  });
  await appModule.link((specifier, referencingModule) => {
    const identifier = new URL(specifier, referencingModule.identifier).href;
    assert.ok(modules.has(identifier), `Unexpected application import: ${identifier}`);
    return modules.get(identifier);
  });
  await appModule.evaluate();
  await new Promise(resolve => setImmediate(resolve));
  const run = appModule.namespace.evaluateForTest;
  assert.equal(run('laneMove'), modules.get(boardUrl.href).namespace.laneMove);
  assert.equal(run('matchingTasks'), modules.get(boardUrl.href).namespace.matchingTasks);
  assert.equal(run('bindAccountFormSubmission'), modules.get(new URL('../public/account-workspace.mjs', import.meta.url).href).namespace.bindAccountFormSubmission);
  assert.equal(run('createOutcomeImportWorkflow'), modules.get(new URL('../public/outcome-import-workflow.mjs', import.meta.url).href).namespace.createOutcomeImportWorkflow);
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

test('worker UI explains invalid quiet hours and unavailable timezones without hiding queued work', async () => {
  const ui = await setup();
  ui.run("workspace.jobs = [{ id: 'fake-queued', kind: 'source_refresh', status: 'queued', updatedAt: '2026-01-02T03:04:05Z' }];");
  for (const [status, message] of [
    [{ available: true, quietHoursInvalid: true }, /invalid or incomplete.*correct both times or clear both/i],
    [{ available: false, quietHoursBlocked: true }, /timezone unavailable.*quiet hours cannot be evaluated/i],
    [{ available: false, scheduledWorkBlocked: true }, /scheduled work is deferred; manual work remains available/i]
  ]) {
    ui.context.fakeTimezoneStatus = status;
    ui.run('workspace.timezoneStatus = fakeTimezoneStatus; renderJobs();');
    assert.match(ui.query('#worker-timezone-status').textContent, message);
    assert.match(ui.query('#worker-state').textContent, message);
    assert.match(ui.query('#job-list').textContent, /queued/i);
    assert.equal(ui.run('workspace.jobs[0].status'), 'queued');
  }
  ui.run('workspace.timezoneStatus = { available: true, quietHoursInvalid: false, quietHoursBlocked: false, scheduledWorkBlocked: false }; renderJobs();');
  assert.equal(ui.query('#worker-timezone-status').textContent, '');
  assert.match(ui.query('#worker-state').textContent, /local worker is running/i);
  assert.equal(ui.requests.length, 0);
});

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

function deferred() {
  let resolve;
  const promise = new Promise(finish => { resolve = finish; });
  return { promise, resolve };
}

function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }

test('a delayed local draft save cannot switch its target or discard newer text when refresh fails', async () => {
  const ui = await setup();
  ui.context.fakeDrafts = [
    { id: 'fake-draft-a', revision: 1, subject: 'Fake draft A', recipient: '', body: 'Original A' },
    { id: 'fake-draft-b', revision: 1, subject: 'Fake draft B', recipient: '', body: 'Original B' }
  ];
  ui.run('workspace.drafts = fakeDrafts; renderDrafts();');
  const edits = descendants(ui.query('#draft-list')).filter(element => element.tagName === 'BUTTON');
  await edits[0].fire('click');
  const form = ui.query('#draft-form');
  form.elements.body.value = 'Submitted A';
  const mutation = deferred();
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (options.method === 'PATCH') return mutation.promise;
    throw new Error('Synthetic display refresh failure');
  };
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  const pending = form.fire('submit');
  await form.fire('submit');
  await edits[1].fire('click');
  const pendingTarget = ui.run('editingDraftId');
  form.elements.body.value = 'Newer text retained for A';
  await form.fire('input');
  mutation.resolve(Response.json({ draft: { id: 'fake-draft-a', revision: 2 } }));
  await pending;
  assert.equal(pendingTarget, 'fake-draft-a');
  assert.equal(form.elements.body.value, 'Newer text retained for A');
  assert.equal(ui.run('editingDraftId'), 'fake-draft-a');
  assert.equal(ui.run('editingDraftRevision'), 2);
  assert.equal(ui.requests.filter(request => request.method === 'PATCH').length, 1);
  assert.match(ui.query('#notice').textContent, /saved.*refresh|Saved.*refresh/);
});

test('out-of-order conversation reads render only the current task and closing cannot reopen an old read', async () => {
  const ui = await setup();
  const reads = new Map([['fake-a', deferred()], ['fake-b', deferred()]]);
  ui.context.fetch = async path => reads.get(path.split('/')[3]).promise;
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  ui.context.fakeTasks = [
    { id: 'fake-a', title: 'Fake A', status: 'next', evidence: [] },
    { id: 'fake-b', title: 'Fake B', status: 'next', evidence: [] }
  ];
  ui.run('workspace.tasks = fakeTasks;');
  const buttons = ui.context.fakeTasks.map(task => {
    ui.context.fakeTask = task;
    return descendants(ui.run('renderTask(fakeTask)')).find(element => element.textContent === 'Notes & history');
  });
  const first = buttons[0].fire('click');
  const second = buttons[1].fire('click');
  reads.get('fake-b').resolve(Response.json({ history: [], messages: [{ role: 'owner', text: 'Notes for B only' }] }));
  await second;
  reads.get('fake-a').resolve(Response.json({ history: [], messages: [{ role: 'owner', text: 'Notes for A only' }] }));
  await first;
  assert.match(ui.query('#conversation-messages').textContent, /Notes for B only/);
  assert.doesNotMatch(ui.query('#conversation-messages').textContent, /Notes for A only/);
  reads.set('fake-a', deferred());
  const last = buttons[0].fire('click');
  await ui.query('#close-conversation').fire('click');
  reads.get('fake-a').resolve(Response.json({ history: [], messages: [{ role: 'owner', text: 'Late A' }] }));
  await last;
  assert.equal(ui.query('#conversation-dialog').open, false);
});

test('real account filter/change/search and task create/edit/source events use explicit IDs without inferring assignment', async () => {
  const ui = await setup();
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
  const label = '<img src=x onerror=alert(1)>';
  ui.context.fakeRecords = [
    { id: first, title: label, category: 'account' },
    { id: second, title: label, category: 'account' },
    { id: 'not-an-account', title: 'Not an account', category: 'outcome' }
  ];
  ui.run(`
    workspace.records = fakeRecords;
    workspace.tasks = [
      { id: 'first-task', title: 'First task', status: 'next', revision: 3, accountId: fakeRecords[0].id },
      { id: 'second-task', title: 'Second task', status: 'done', revision: 7, accountId: fakeRecords[1].id },
      { id: 'legacy-task', title: 'Legacy task', status: 'next', revision: 1 }
    ];
    workspace.conversations = workspace.tasks.map(task => ({ taskId: task.id, text: 'Local note needle' }));
    globalThis.savedRequests = [];
    globalThis.taskReceipt = (path, options) => ({
      task: {
        id: options.method === 'PATCH' ? path.split('/').at(-1) : 'saved-explicit-task',
        revision: (JSON.parse(options.body).revision || 0) + 1
      }
    });
    api = async (path, options) => { savedRequests.push({ path, ...options }); return taskReceipt(path, options); };
    refreshState = async () => {};
    renderTasks();
  `);
  const filter = ui.query('#task-account-filter');
  assert.equal(filter.children.length, 4);
  assert.equal(filter.children[2].textContent, `${label} [${first}]`);
  assert.equal(filter.children[3].textContent, `${label} [${second}]`);
  assert.notEqual(filter.children[2].value, filter.children[3].value);
  filter.value = second;
  await filter.fire('change');
  assert.doesNotMatch(ui.query('#task-list').textContent, /Second task/);
  ui.query('#show-done').checked = true;
  await ui.query('#show-done').fire('change');
  ui.query('#task-search').value = 'needle';
  await ui.query('#task-search').fire('input');
  assert.match(ui.query('#task-list').textContent, /Second task/);
  assert.doesNotMatch(ui.query('#task-list').textContent, /First task|Legacy task/);
  assert.equal(ui.run('savedRequests.length'), 0);
  filter.value = 'unassigned';
  await filter.fire('change');
  assert.match(ui.query('#task-list').textContent, /Legacy task/);
  assert.doesNotMatch(ui.query('#task-list').textContent, /First task|Second task/);
  filter.value = second;
  await filter.fire('change');
  await ui.query('#new-task').fire('click');
  const form = ui.query('#task-form');
  assert.equal(form.elements.accountId.value, '', 'the active account filter does not preassign a new task');
  form.elements.title.value = label;
  form.elements.accountId.value = first;
  await form.fire('submit');
  let saved = JSON.parse(ui.run('savedRequests.at(-1).body'));
  assert.equal(saved.accountId, first);
  assert.equal(ui.run('savedRequests.at(-1).path'), '/api/tasks');
  ui.run('openTaskDialog(workspace.tasks[1])');
  assert.equal(form.elements.accountId.value, second);
  form.elements.accountId.value = first;
  assert.equal(ui.run('savedRequests.length'), 1, 'choosing an account alone never saves');
  await form.fire('submit');
  saved = JSON.parse(ui.run('savedRequests.at(-1).body'));
  assert.equal(saved.accountId, first);
  assert.equal(saved.revision, 7);
  assert.equal(saved.status, 'done');
  assert.equal(ui.run('workspace.tasks[1].status'), 'done');
  ui.run("api = async (path, options, observeResponse) => { observeResponse?.({ status: 409 }); throw new Error('Task changed; stale revision was not applied.'); };");
  ui.run('openTaskDialog(workspace.tasks[1])');
  form.elements.accountId.value = first;
  await form.fire('submit');
  assert.match(ui.query('#notice').textContent, /stale revision was not applied/);
  assert.equal(ui.query('#task-dialog').open, true);
  assert.equal(form.elements.accountId.value, first, 'failed saves retain the explicit unsaved choice');
  assert.equal(ui.run('workspace.tasks[1].accountId'), second);
  assert.equal(ui.run('workspace.tasks[1].status'), 'done');
  ui.run('api = async (path, options) => { savedRequests.push({ path, ...options }); return taskReceipt(path, options); };');
  const job = fixture('fake-original', { title: label, excerpt: label });
  ui.context.fakeJob = job;
  ui.run('workspace.jobs = [fakeJob]; renderJobs();');
  const walk = element => [element, ...element.children.flatMap(walk)];
  const create = walk(ui.query('#job-list')).find(element => element.tagName === 'BUTTON' && element.textContent === 'Review a new local task');
  await create.fire('click');
  assert.equal(form.elements.accountId.value, '', 'source title/evidence do not preassign a task');
  await form.fire('submit');
  assert.equal(JSON.parse(ui.run('savedRequests.at(-1).body')).accountId, '');
  assert.equal(ui.run('savedRequests.at(-1).path'), '/api/tasks/from-evidence');
  await create.fire('click');
  form.elements.accountId.value = second;
  await form.fire('submit');
  assert.equal(JSON.parse(ui.run('savedRequests.at(-1).body')).accountId, second);
  assert.equal(ui.requests.length, 0);
});

test('real background refresh restores surviving task controls by ID and uses the refreshed revision and conversation search', async () => {
  const ui = await setup();
  ui.context.loadedState = {
    csrfToken: 'fake-csrf', tasks: [{ id: 'focused-task', title: 'Focus target', status: 'next', revision: 4 }],
    drafts: [], activity: [], conversations: [{ taskId: 'focused-task', text: 'Fresh note needle' }]
  };
  ui.run(`
    api = async path => {
      if (path !== '/api/state') throw new Error('Unexpected nonlocal request');
      return loadedState;
    };
    for (const name of ['renderDrafts', 'renderLinks', 'renderActivity', 'renderProfile', 'renderJobs', 'renderRecords', 'renderDraftOperations', 'renderBackups', 'renderSetup']) {
      eval(name + ' = () => {};');
    }
    renderConnections = async () => {};
    workspace.tasks = loadedState.tasks;
    renderTasks();
  `);
  const controls = () => ui.query('#task-list').querySelectorAll('[data-task-control]');
  for (const name of ['edit', 'notes', 'complete']) {
    const previous = controls().find(control => control.dataset.taskControl === name);
    previous.focus();
    assert.equal(ui.context.document.activeElement, previous);
    ui.context.loadedState.tasks = [{ id: 'focused-task', title: 'Focus target updated', status: 'waiting', revision: 5 }];
    ui.run('lastBackgroundRefresh = 0;');
    await ui.context.backgroundRefresh();
    const focused = ui.context.document.activeElement;
    assert.notEqual(focused, previous, 'the old DOM control was replaced');
    assert.equal(focused.dataset.taskControl, name);
    assert.equal(focused.closest('.task-card').dataset.taskId, 'focused-task');
    assert.ok(controls().includes(focused));
  }
  ui.run('globalThis.moves = []; updateTask = async (id, update) => { moves.push({ id, update }); };');
  await ui.context.document.activeElement.fire('click');
  assert.equal(ui.run('moves[0].update.revision'), 5);
  assert.equal(ui.run('moves[0].update.status'), 'done');
  assert.equal(ui.run('workspace.tasks[0].status'), 'waiting');
  ui.query('#task-search').value = 'needle';
  await ui.query('#task-search').fire('input');
  assert.match(ui.query('#task-list').textContent, /Focus target updated/);
  assert.equal(ui.requests.length, 0);
  const previous = ui.context.document.activeElement;
  ui.context.loadedState.tasks = [{ id: 'other-task', title: 'Do not steal focus', status: 'next', revision: 1 }];
  ui.query('#task-search').value = '';
  ui.run('lastBackgroundRefresh = 0;');
  await ui.context.backgroundRefresh();
  assert.equal(controls().includes(ui.context.document.activeElement), false, 'a missing task must not transfer focus to a different task');
  assert.equal(ui.context.document.activeElement, previous);
});

test('source-task deduplication visibly retains a different account association without applying the submitted choice', async () => {
  const ui = await setup();
  ui.context.fakeJob = fixture();
  ui.run('workspace.jobs = [fakeJob]; renderJobs();');
  const walk = element => [element, ...element.children.flatMap(walk)];
  const create = walk(ui.query('#job-list')).find(element => element.tagName === 'BUTTON' && element.textContent === 'Review a new local task');
  await create.fire('click');
  ui.query('#task-form').elements.accountId.value = '00000000-0000-4000-8000-000000000002';
  ui.context.retentionMessage = 'Existing account association retained; submitted account selection was not applied. Change it only by editing the existing task. Completed work was not reopened.';
  ui.run(`
    api = async () => ({ task: { id: 'existing-completed-task', revision: 3, status: 'done' }, deduplicated: true, accountSelectionRetained: true, message: retentionMessage });
    refreshState = async () => {};
  `);
  await ui.query('#task-form').fire('submit');
  assert.equal(ui.query('#notice').textContent, ui.context.retentionMessage);
  assert.equal(ui.query('#task-source-review').hidden, false);
  assert.equal(ui.query('#task-source-review').textContent, ui.context.retentionMessage);
  assert.equal(ui.query('#task-dialog').open, true, 'the explanation remains visible instead of disappearing with the dialog');
  assert.equal(ui.query('#task-form').elements.accountId.value, '00000000-0000-4000-8000-000000000002');
  assert.equal(ui.requests.length, 0);
});

test('meeting insight previews and coverage gaps render as inert evidence', async () => {
  const ui = await setup();
  const job = fixture('fake-insight', { excerpt: '<script>fakeAction()</script>' });
  job.result.sources[0].source = 'meetingInsights';
  job.result.sources[0].coverage.gaps = [{ sourceIndex: 1, code: 'permission_denied' }];
  ui.context.fakeJob = job;
  ui.run('workspace.jobs = [fakeJob]; renderJobs();');
  const content = ui.query('#job-list').textContent;
  assert.match(content, /<script>fakeAction\(\)<\/script>/);
  assert.match(content, /Selected source 2: permission_denied/);
  assert.match(content, /Untrusted source evidence/);
  assert.doesNotMatch(content, /Review an unsent reply/);
  assert.equal(ui.requests.length, 0);
});

test('meeting insight list metadata is inert and exposes no selection action', async () => {
  const ui = await setup();
  ui.context.fakeJob = {
    id: 'list-job', kind: 'meeting_insight_list', status: 'partial',
    result: { meetingInsightList: {
      meetingId: 'fake-meeting',
      coverage: { status: 'partial', limitations: ['Additional list items were omitted; coverage is partial.'] },
      items: [{ id: '<script>fakeAction()</script>', createdDateTime: 'fake-created', endDateTime: 'fake-ended' }]
    } }
  };
  ui.run('workspace.jobs = [fakeJob]; renderJobs();');
  const text = ui.query('#job-list').textContent;
  assert.match(text, /<script>fakeAction\(\)<\/script>/);
  assert.match(text, /fake-created/);
  assert.match(text, /coverage is partial/i);
  assert.match(text, /cannot authorize a detail read/);
  assert.doesNotMatch(text, /Review a new local task/);
  assert.doesNotMatch(text, /Explicitly retry/);
  assert.equal(ui.requests.length, 0);
});

test('meeting list form submits only the selected ID and explicit list consent', async () => {
  const ui = await setup();
  const form = ui.query('#meeting-insight-list-form');
  form.elements = {
    meetingId: { value: 'fake-meeting' },
    listConsent: { checked: true }
  };
  ui.run("accessToken = 'synthetic'; csrfToken = 'synthetic';");
  await form.fire('submit');
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].path, '/api/jobs');
  const body = JSON.parse(ui.requests[0].body);
  assert.equal(body.kind, 'meeting_insight_list');
  assert.equal(body.meetingId, 'fake-meeting');
  assert.equal(body.listConsent, true);
  assert.deepEqual(Object.keys(body).sort(), ['kind', 'listConsent', 'meetingId', 'requestId']);
});

test('meeting list blocks overlapping submits and distinguishes queued refresh failure', async () => {
  const ui = await setup();
  const form = ui.query('#meeting-insight-list-form');
  form.elements = { meetingId: { value: 'fake-meeting' }, listConsent: { checked: true } };
  ui.context.confirm = () => true;
  ui.run("accessToken = 'synthetic'; csrfToken = 'synthetic';");
  let release;
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (path === '/api/jobs') return new Promise(resolve => { release = resolve; });
    throw new Error('Synthetic refresh failure');
  };
  const first = form.fire('submit');
  await form.fire('submit');
  await ui.query('#meeting-insight-list-reset').fire('click');
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.query('#meeting-insight-list-form button[type="submit"]').disabled, true);
  const body = JSON.parse(ui.requests[0].body);
  release(Response.json({ job: { id: randomUUID(), kind: body.kind, requestId: body.requestId, payload: { meetingId: body.meetingId }, status: 'queued' } }, { status: 202 }));
  await first;
  assert.match(ui.query('#meeting-insight-list-status').textContent, /was queued.*could not be refreshed/);
  assert.match(ui.query('#meeting-insight-list-status').textContent, /do not blindly retry/i);
  assert.equal(form.elements.meetingId.value, 'fake-meeting');
  assert.equal(form.elements.listConsent.checked, false);
  assert.equal(ui.query('#meeting-insight-list-form button[type="submit"]').disabled, true);
  await form.fire('submit');
  assert.equal(ui.requests.filter(request => request.path === '/api/jobs').length, 1);
  await ui.query('#meeting-insight-list-reset').fire('click');
  assert.equal(form.elements.listConsent.checked, false);
  assert.equal(ui.query('#meeting-insight-list-form button[type="submit"]').disabled, false);
  await form.fire('submit');
  assert.equal(ui.requests.filter(request => request.path === '/api/jobs').length, 1);
});

test('lost and malformed queue receipts preserve the selected meeting and consent as unknown', async () => {
  for (const response of ['lost', 'malformed', 'wrong-request', 'wrong-meeting', 'wrong-kind', 'wrong-job-status', 'bad-json', 'wrong-status']) {
    const ui = await setup();
    const form = ui.query('#meeting-insight-list-form');
    form.elements = { meetingId: { value: 'fake-meeting' }, listConsent: { checked: true } };
    ui.run("accessToken = 'synthetic'; csrfToken = 'synthetic';");
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (response === 'lost') throw new Error('Synthetic response lost');
      if (response === 'bad-json') return new Response('not json', { status: 202 });
      const body = JSON.parse(options.body);
      return Response.json({ job: response === 'malformed' ? {} : {
        id: randomUUID(), kind: response === 'wrong-kind' ? 'source_refresh' : body.kind,
        requestId: response === 'wrong-request' ? randomUUID() : body.requestId,
        payload: { meetingId: response === 'wrong-meeting' ? 'different-meeting' : body.meetingId },
        status: response === 'wrong-job-status' ? 'failed' : 'queued'
      } }, { status: response === 'wrong-status' ? 200 : 202 });
    };
    await form.fire('submit');
    assert.match(ui.query('#meeting-insight-list-status').textContent, /outcome.*unknown/i);
    assert.match(ui.query('#meeting-insight-list-status').textContent, /do not blindly retry/i);
    assert.equal(form.elements.meetingId.value, 'fake-meeting');
    assert.equal(form.elements.listConsent.checked, true);
    assert.equal(form.elements.meetingId.disabled, true);
    assert.equal(form.elements.listConsent.disabled, true);
    assert.equal(ui.query('#meeting-insight-list-form button[type="submit"]').disabled, true);
    const requestId = JSON.parse(ui.requests[0].body).requestId;
    await form.fire('submit');
    assert.equal(ui.requests.length, 1);
    assert.match(ui.query('#meeting-insight-list-status').textContent, new RegExp(requestId));
  }
});

test('a verified queued receipt clears consent and requires new consent for another request', async () => {
  const ui = await setup();
  const form = ui.query('#meeting-insight-list-form');
  form.elements = { meetingId: { value: 'fake-meeting' }, listConsent: { checked: true } };
  ui.run("accessToken = 'synthetic'; csrfToken = 'synthetic'; refreshState = async () => {};");
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    const body = JSON.parse(options.body);
    return Response.json({ job: { id: randomUUID(), kind: body.kind, requestId: body.requestId, payload: { meetingId: body.meetingId }, status: 'queued' } }, { status: 202 });
  };
  await form.fire('submit');
  assert.match(ui.query('#meeting-insight-list-status').textContent, /was queued/);
  assert.equal(form.elements.listConsent.checked, false);
  assert.equal(form.elements.meetingId.disabled, false);
  await form.fire('submit');
  assert.equal(ui.requests.length, 1);
});

function findSourceReadButton(ui, kind) {
  const expected = kind === 'teams'
    ? ['Read replies for this exact parent', 'Teams reply read being submitted', 'Fresh Teams source check required']
    : ['Read selected text file (one-time approval)', 'Selected-file read being submitted', 'Fresh file source check required'];
  const walk = element => [element, ...element.children.flatMap(walk)];
  return walk(ui.query('#job-list')).find(element =>
    element.tagName === 'BUTTON' && expected.includes(element.textContent)
  );
}

async function setupSourceReadUi(kind) {
  const ui = await setup();
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {}; ");
  const source = kind === 'teams'
    ? {
        source: 'teamsChannels', resultId: '00000000-0000-4000-8000-000000000032',
        items: [{ id: 'synthetic-parent-id', sourceKey: 'e'.repeat(64), title: 'Synthetic parent' }]
      }
    : {
        source: 'files', resultId: '00000000-0000-4000-8000-000000000042',
        items: [{
          id: 'synthetic-file-id', sourceKey: 'f'.repeat(64), title: 'Synthetic note.txt',
          mimeType: 'text/plain', eTag: '"synthetic-revision"', size: 12
        }]
      };
  const job = {
    id: kind === 'teams' ? '00000000-0000-4000-8000-000000000031' : '00000000-0000-4000-8000-000000000041',
    kind: 'source_refresh', status: 'partial', result: { sources: [source] }
  };
  ui.context.fakeJob = job;
  ui.context.confirmCalls = 0;
  ui.context.window.confirm = () => { ui.context.confirmCalls++; return true; };
  ui.run(kind === 'files'
    ? "latestConnections = { fileContent: { readyForApprovedRead: true, reasons: [] } }; workspace.jobs = [fakeJob]; renderJobs();"
    : "workspace.jobs = [fakeJob]; renderJobs();");
  return { ui, job, source, reference: {
    jobId: job.id, resultId: source.resultId, itemId: source.items[0].sourceKey
  } };
}

function sourceReadReceipt(kind, reference, { id = '00000000-0000-4000-8000-000000000051', status = 'queued', deduplicated, message } = {}) {
  return {
    ...(message ? { message } : {}),
    ...(deduplicated !== undefined ? { deduplicated } : {}),
    job: { id, kind: kind === 'teams' ? 'teams_channel_replies' : 'file_content_read', status, payload: { sourceReference: reference } }
  };
}

test('permission gaps remain visible inert text for partial, unavailable and failed source results', async () => {
  const ui = await setup();
  for (const status of ['partial', 'unavailable', 'failed']) {
    const job = fixture();
    const source = job.result.sources[0];
    source.status = status;
    source.inspected = 0;
    source.items = [];
    source.coverage.gaps = [{ sourceIndex: 0, code: '<img src=x onerror="fakeAction()"> permission_denied' }];
    ui.context.fakeJob = job;
    ui.run('workspace.jobs = [fakeJob]; renderJobs()');
    assert.match(ui.query('#job-list').textContent, /Selected source 1: <img.*permission_denied/);
    const walk = element => [element, ...element.children.flatMap(walk)];
    assert.equal(walk(ui.query('#job-list')).some(element => element.tagName === 'IMG'), false);
  }
  assert.equal(ui.requests.length, 0);
});

test('Connections distinguishes mixed access and denied reads and renders only inert coverage gaps', async () => {
  const ui = await setup();
  ui.context.connectionFixture = {
    teams: { status: 'partial-access', available: false, lastReads: [{
      source: 'teamsChats', status: 'partial', inspected: 0,
      coverage: { limitations: ['Only one of 2 selected meetings was listed.'], gaps: [{ sourceIndex: 1, code: '<img src=x onerror="fakeAction()"> permission_denied' }] }
    }] },
    microsoft365: { state: 'connected', hostAuthenticationAvailable: true },
    assistant: { code: 'unavailable' }
  };
  ui.run("sourceSettingsRendered = true; api = async path => path === '/api/connections' ? connectionFixture : { directory: 'synthetic local output', approved: false };");
  await ui.run('renderConnections()');
  assert.match(ui.query('#connections').textContent, /PARTIAL-ACCESS/);
  assert.match(ui.query('#connections').textContent, /Selected source 2: <img.*permission_denied/);
  assert.match(ui.query('#connections').textContent, /Only one of 2 selected meetings/);
  assert.equal(descendants(ui.query('#connections')).some(element => element.tagName === 'IMG'), false);
  ui.context.connectionFixture.teams.status = 'access-unverified';
  ui.context.connectionFixture.teams.lastReads[0].status = 'unavailable';
  await ui.run('renderConnections()');
  assert.match(ui.query('#connections').textContent, /ACCESS-UNVERIFIED/);
  assert.match(ui.query('#connections').textContent, /Selected source 2: <img.*permission_denied/);
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

test('Teams reply UI submits only the persisted source-result reference', async () => {
  const ui = await setup();
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  const sourceJob = {
    id: '00000000-0000-4000-8000-000000000001', kind: 'source_refresh',
    updatedAt: '2026-01-02T03:04:05Z', status: 'partial',
    result: { sources: [{
      source: 'teamsChannels', resultId: '00000000-0000-4000-8000-000000000002',
      status: 'partial', inspected: 1,
      items: [{
        id: 'synthetic-parent-id', sourceKey: 'a'.repeat(64),
        title: 'Synthetic parent', excerpt: 'Untrusted historical text.'
      }]
    }] }
  };
  const expectedReference = {
    jobId: sourceJob.id,
    resultId: sourceJob.result.sources[0].resultId,
    itemId: 'a'.repeat(64)
  };
  ui.run('refreshState = async () => {};');
  ui.context.fetch = async (path, options = {}) => {
    ui.requests.push({ path, ...options });
    if (path === '/api/teams/channel-replies') return Response.json({
      job: {
        id: '00000000-0000-4000-8000-000000000003', kind: 'teams_channel_replies', status: 'queued',
        payload: { sourceReference: expectedReference }
      },
      message: 'Queued a bounded read.'
    }, { status: 202 });
    if (path === '/api/state') return Response.json({
      csrfToken: 'synthetic-csrf', tasks: [], drafts: [], links: [], activity: [],
      profile: {}, jobs: [sourceJob], preferences: {}, documents: [], records: [],
      sourceConsent: null, draftOperations: [], backups: [], recoveries: [],
      onboarding: { status: 'not-started', step: 0 }
    });
    if (path === '/api/connections') return Response.json({
      assistant: { code: 'disconnected' }, email: { available: false },
      calendar: {}, teams: {}, reporting: {}, sharepoint: {}, planner: {},
      microsoft365: { hostAuthenticationAvailable: false, state: 'disconnected' }
    });
    if (path === '/api/output-settings') return Response.json({ directory: 'synthetic-only', approved: false });
    throw new Error(`Unexpected fake request: ${path}`);
  };
  ui.context.fakeJob = sourceJob;
  ui.run('workspace.jobs = [fakeJob]; renderJobs();');
  const walk = element => [element, ...element.children.flatMap(walk)];
  const button = walk(ui.query('#job-list')).find(element =>
    element.tagName === 'BUTTON' && element.textContent === 'Read replies for this exact parent'
  );
  assert.ok(button);
  assert.equal(button.disabled, false);
  await button.fire('click');
  const request = ui.requests.find(item => item.path === '/api/teams/channel-replies');
  assert.ok(request);
  const payload = JSON.parse(request.body);
  assert.deepEqual(Object.keys(payload), ['sourceReference']);
  assert.deepEqual(Object.keys(payload.sourceReference).sort(), ['itemId', 'jobId', 'resultId']);
  assert.deepEqual(payload.sourceReference, expectedReference);
  assert.match(ui.query('#notice').textContent, /accepted as job .* \(queued\)/);
  assert.equal(JSON.stringify(payload).includes('synthetic-parent-id'), false);
});

test('Teams reply results render historical content as inert text', async () => {
  const ui = await setup();
  const untrusted = '<img src=x onerror="sendTeamsMessage()">';
  ui.context.fakeJob = {
    id: 'synthetic-reply-job', kind: 'teams_channel_replies', status: 'partial',
    attempts: 1, updatedAt: '2026-01-02T03:04:05Z',
    result: {
      text: 'Read one bounded reply.',
      parent: { title: 'Synthetic parent', excerpt: 'Parent evidence.' },
      items: [{ title: 'Synthetic reply', excerpt: untrusted }],
      hasMore: true, coverage: { status: 'partial', limitations: ['Only replies to the selected parent were read.'] }
    }
  };
  ui.run('workspace.jobs = [fakeJob]; renderJobs();');
  assert.ok(ui.query('#job-list').textContent.includes(untrusted));
  assert.ok(ui.query('#job-list').textContent.includes('Historical, untrusted evidence only'));
  assert.ok(ui.query('#job-list').textContent.includes('more replies were not inspected'));
});

test('legacy Teams previews without a result revision visibly require a fresh check', async () => {
  const ui = await setup();
  ui.context.fakeJob = {
    id: '00000000-0000-4000-8000-000000000001', kind: 'source_refresh', status: 'partial',
    result: { sources: [{
      source: 'teamsChannels', status: 'partial', items: [{
        id: 'synthetic-parent-id', sourceKey: 'b'.repeat(64), title: 'Old preview'
      }]
    }] }
  };
  ui.run('workspace.jobs = [fakeJob]; renderJobs();');
  const walk = element => [element, ...element.children.flatMap(walk)];
  const button = walk(ui.query('#job-list')).find(element =>
    element.tagName === 'BUTTON' && element.textContent === 'Fresh Teams source check required'
  );
  assert.ok(button);
  assert.equal(button.disabled, true);
  assert.equal(ui.requests.length, 0);
});

test('malformed legacy Teams item references are visibly non-actionable', async () => {
  const ui = await setup();
  ui.context.fakeJob = {
    id: '00000000-0000-4000-8000-000000000001', kind: 'source_refresh', status: 'partial',
    result: { sources: [{
      source: 'teamsChannels', resultId: 'legacy-result', status: 'partial', items: [{
        id: 'legacy-parent-id', sourceKey: '../raw-message-id', title: 'Legacy preview'
      }]
    }] }
  };
  ui.run('workspace.jobs = [fakeJob]; renderJobs();');
  const walk = element => [element, ...element.children.flatMap(walk)];
  const button = walk(ui.query('#job-list')).find(element =>
    element.tagName === 'BUTTON' && element.textContent === 'Fresh Teams source check required'
  );
  assert.ok(button);
  assert.equal(button.disabled, true);
  await button.fire('click');
  assert.equal(ui.requests.length, 0);
});

test('selected text file action sends only stored references after explicit approval', async () => {
  const ui = await setup();
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  const sourceJob = {
    id: '00000000-0000-4000-8000-000000000011', kind: 'source_refresh', status: 'partial',
    result: { sources: [{
      source: 'files', resultId: '00000000-0000-4000-8000-000000000012', status: 'partial',
      items: [{
        id: 'synthetic-item-id', sourceKey: 'c'.repeat(64), title: 'Synthetic note.txt',
        mimeType: 'text/plain', eTag: '"revision-1"', size: 15, contentAvailable: false,
        url: 'https://example.invalid/source'
      }]
    }] }
  };
  ui.context.fakeJob = sourceJob;
  ui.context.confirmText = '';
  ui.context.window.confirm = message => { ui.context.confirmText = message; return true; };
  ui.run("latestConnections = { fileContent: { status: 'ready-for-explicit-read', readyForApprovedRead: true, reasons: [] } }; refreshState = async () => {}; workspace.jobs = [fakeJob]; renderJobs();");
  ui.context.fetch = async (path, options = {}) => {
    ui.requests.push({ path, ...options });
    if (path === '/api/files/content-read') return Response.json({
      job: {
        id: '00000000-0000-4000-8000-000000000013', kind: 'file_content_read', status: 'queued',
        payload: { sourceReference: {
          jobId: sourceJob.id, resultId: sourceJob.result.sources[0].resultId,
          itemId: 'c'.repeat(64)
        } }
      },
      message: 'One file read queued.'
    }, { status: 202 });
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const walk = element => [element, ...element.children.flatMap(walk)];
  const button = walk(ui.query('#job-list')).find(element =>
    element.tagName === 'BUTTON' && element.textContent === 'Read selected text file (one-time approval)'
  );
  assert.ok(button);
  assert.equal(button.disabled, false);
  await button.fire('click');
  assert.match(ui.context.confirmText, /one explicitly selected text\/plain file/);
  const request = ui.requests.find(item => item.path === '/api/files/content-read');
  const payload = JSON.parse(request.body);
  assert.deepEqual(Object.keys(payload).sort(), ['confirmRead', 'sourceReference']);
  assert.deepEqual(Object.keys(payload.sourceReference).sort(), ['itemId', 'jobId', 'resultId']);
  assert.deepEqual(payload.sourceReference, {
    jobId: sourceJob.id, resultId: sourceJob.result.sources[0].resultId, itemId: 'c'.repeat(64)
  });
  assert.equal(payload.confirmRead, true);
  assert.equal(JSON.stringify(payload).includes('synthetic-item-id'), false);
  assert.equal(JSON.stringify(payload).includes('example.invalid'), false);
});

test('selected file content is displayed as inert text and unavailable transport disables reads', async () => {
  const ui = await setup();
  const content = '<img src=x onerror="createTask()">';
  ui.context.fakeJob = {
    id: 'synthetic-file-read', kind: 'file_content_read', status: 'partial',
    result: {
      text: 'One file read.',
      file: { title: 'Synthetic note.txt', mimeType: 'text/plain', provenance: 'explicit-owner-approved-sharepoint-read', byteLength: 33 },
      content, coverage: { status: 'partial', limitations: ['One file only.'] }
    }
  };
  ui.run('workspace.jobs = [fakeJob]; renderJobs();');
  assert.ok(ui.query('#job-list').textContent.includes(content));
  assert.ok(ui.query('#job-list').textContent.includes('One file only.'));
  assert.equal(ui.query('#job-list').children.some(element => element.tagName === 'IMG'), false);

  ui.context.fakeJob = {
    id: '00000000-0000-4000-8000-000000000021', kind: 'source_refresh', status: 'partial',
    result: { sources: [{
      source: 'files', resultId: '00000000-0000-4000-8000-000000000022', status: 'partial', items: [{
        id: 'synthetic-item', sourceKey: 'd'.repeat(64), title: 'Blocked note',
        mimeType: 'text/plain', eTag: '"revision-1"', size: 15
      }]
    }] }
  };
  ui.run("latestConnections = { fileContent: { status: 'unavailable', readyForApprovedRead: false, reasons: ['network_policy_unavailable'] } }; workspace.jobs = [fakeJob]; renderJobs();");
  const walk = element => [element, ...element.children.flatMap(walk)];
  const read = walk(ui.query('#job-list')).find(element =>
    element.tagName === 'BUTTON' && element.textContent.includes('File content unavailable')
  );
  assert.ok(read);
  assert.equal(read.disabled, true);
  assert.equal(ui.requests.length, 0);
});

test('selected-source submission is guarded across rapid clicks and rerenders', async t => {
  for (const kind of ['teams', 'files']) {
    await t.test(kind, async () => {
      const { ui, reference } = await setupSourceReadUi(kind);
      let postCount = 0;
      let resolveResponse;
      ui.context.fetch = (path, options) => {
        assert.equal(path, kind === 'teams' ? '/api/teams/channel-replies' : '/api/files/content-read');
        assert.equal(options.method, 'POST');
        postCount++;
        return new Promise(resolve => { resolveResponse = resolve; });
      };

      const button = findSourceReadButton(ui, kind);
      assert.ok(button);
      const firstSubmit = button.fire('click');
      assert.equal(postCount, 1);
      const rerenderedButton = findSourceReadButton(ui, kind);
      assert.ok(rerenderedButton);
      assert.equal(rerenderedButton.disabled, true);
      assert.match(rerenderedButton.textContent, /being submitted/);

      await button.fire('click');
      assert.equal(postCount, 1, 'a stale button handler cannot bypass the pending-source guard');
      assert.match(ui.query('#notice').textContent, /already being submitted/);
      assert.equal(ui.context.confirmCalls, kind === 'files' ? 1 : 0,
        'a duplicate file click does not trigger a second approval prompt');

      resolveResponse(Response.json(sourceReadReceipt(kind, reference), { status: 202 }));
      await firstSubmit;
      assert.equal(postCount, 1);
      assert.match(ui.query('#notice').textContent, /accepted as job/);
      assert.equal(findSourceReadButton(ui, kind).disabled, false);
    });
  }
});

test('lost and malformed selected-source receipts are unknown and never trigger automatic retries', async t => {
  const cases = [
    ['lost response', async () => { throw new Error('synthetic connection reset'); }],
    ['malformed receipt', async () => Response.json({ message: 'synthetic success without a job receipt' }, { status: 202 })],
    ['wrong source receipt', async (_path, _options, reference, kind) => Response.json(
      sourceReadReceipt(kind, { ...reference, itemId: '0'.repeat(64) }), { status: 202 }
    )]
  ];
  for (const kind of ['teams', 'files']) {
    for (const [label, response] of cases) {
      await t.test(`${kind}: ${label}`, async () => {
        const { ui, reference } = await setupSourceReadUi(kind);
        let postCount = 0;
        let refreshCount = 0;
        ui.context.refreshState = async () => { refreshCount++; };
        ui.context.fetch = async (path, options) => {
          postCount++;
          return response(path, options, reference, kind);
        };
        const button = findSourceReadButton(ui, kind);
        await button.fire('click');
        assert.equal(postCount, 1);
        assert.equal(refreshCount, 0, 'unverified receipts do not trigger a success refresh');
        assert.match(ui.query('#notice').textContent, /outcome is unknown|receipt was missing, malformed, or for different source evidence/);
        assert.match(ui.query('#notice').textContent, /Inspect Activity before retrying/);
        assert.equal(ui.requests.length, 0, 'no second POST or implicit API request was made');
      });
    }
  }
});

test('known rejections, accepted jobs with refresh failure, and deduplicated retained jobs are distinct', async t => {
  for (const kind of ['teams', 'files']) {
    await t.test(`${kind}: known rejection`, async () => {
      const { ui } = await setupSourceReadUi(kind);
      let postCount = 0;
      ui.context.fetch = async () => {
        postCount++;
        return Response.json({ error: 'Synthetic stale source rejection.' }, { status: 409 });
      };
      await findSourceReadButton(ui, kind).fire('click');
      assert.equal(postCount, 1);
      assert.equal(ui.query('#notice').textContent, 'Synthetic stale source rejection.');
      assert.doesNotMatch(ui.query('#notice').textContent, /outcome is unknown/);
    });

    await t.test(`${kind}: accepted but refresh failed`, async () => {
      const { ui, reference } = await setupSourceReadUi(kind);
      let postCount = 0;
      ui.context.refreshState = async () => { throw new Error('synthetic refresh failure'); };
      ui.run('refreshState = globalThis.refreshState');
      ui.context.fetch = async () => {
        postCount++;
        return Response.json(sourceReadReceipt(kind, reference), { status: 202 });
      };
      await findSourceReadButton(ui, kind).fire('click');
      assert.equal(postCount, 1);
      assert.match(ui.query('#notice').textContent, /accepted as job/);
      assert.match(ui.query('#notice').textContent, /Activity could not be refreshed/);
      assert.match(ui.query('#notice').textContent, /Inspect Activity before retrying/);
    });

    await t.test(`${kind}: retained deduplicated result`, async () => {
      const { ui, reference } = await setupSourceReadUi(kind);
      let postCount = 0;
      let refreshCount = 0;
      ui.context.refreshState = async () => { refreshCount++; };
      ui.run('refreshState = globalThis.refreshState');
      ui.context.fetch = async () => {
        postCount++;
        return Response.json(sourceReadReceipt(kind, reference, {
          status: 'partial', deduplicated: true,
          message: `Synthetic ${kind} result is retained; no additional read was made.`
        }), { status: 200 });
      };
      await findSourceReadButton(ui, kind).fire('click');
      assert.equal(postCount, 1);
      assert.equal(refreshCount, 1);
      assert.match(ui.query('#notice').textContent, /result is retained.*no new read was queued/);
    });
  }
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
  assert.match(ui.query('#task-form [data-save-status]').textContent, /selected evidence changed/);
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

test('task saves block duplicate submits/target switches and preserve newer edits with the saved revision', async () => {
  const ui = await setup();
  await ui.query('#new-task').fire('click');
  const form = ui.query('#task-form');
  form.elements.title.value = 'Submitted synthetic task';
  const mutation = deferred();
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (options.method === 'POST' || options.method === 'PATCH') return mutation.promise;
    throw new Error('Synthetic display refresh failure');
  };
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  const pending = form.fire('submit');
  assert.equal(form.elements.every(control => control.disabled), true);
  await form.fire('submit');
  await ui.query('#cancel-task').fire('click');
  assert.equal(ui.query('#task-dialog').open, true);
  ui.context.otherTask = { id: 'fake-other', title: 'Wrong target' };
  ui.run('openTaskDialog(otherTask);');
  assert.equal(form.elements.title.value, 'Submitted synthetic task');
  form.elements.title.value = 'Newer synthetic task edits';
  await form.fire('input');
  mutation.resolve(Response.json({ task: { id: 'fake-saved-task', revision: 1 } }));
  await pending;
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(ui.run('editingId'), 'fake-saved-task');
  assert.equal(ui.run('editingRevision'), 1);
  assert.equal(form.elements.title.value, 'Newer synthetic task edits');
  assert.equal(ui.query('#task-dialog').open, true);
  assert.match(ui.query('#task-form [data-save-status]').textContent, /save succeeded.*refresh failed/);
  await form.fire('submit');
  const next = ui.requests.find(request => request.method === 'PATCH');
  assert.equal(next.path, '/api/tasks/fake-saved-task');
  assert.equal(JSON.parse(next.body).revision, 1);
});

test('completed and revision-less legacy dedup receipts retain tasks without an implicit edit, invented revision or reopening', async () => {
  for (const revision of [4, undefined]) {
    const ui = await setup();
    await ui.select(fixture(), 'Review a new local task');
    const form = ui.query('#task-form');
    const mutation = deferred();
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (options.method === 'POST') return mutation.promise;
      throw new Error('Synthetic display refresh failure');
    };
    ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    const pending = form.fire('submit');
    form.elements.title.value = 'Keep newer text without editing completed task';
    mutation.resolve(Response.json({ deduplicated: true, task: { id: 'fake-completed', status: 'done', revision } }));
    await pending;
    assert.equal(ui.run('editingId'), null);
    assert.equal(ui.run('editingRevision'), 0);
    assert.equal(ui.run('importingSource !== null'), true);
    assert.equal(form.elements.title.value, 'Keep newer text without editing completed task');
    assert.match(ui.query('#task-form [data-save-status]').textContent, /completed work was not reopened/);
    await form.fire('submit');
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 2);
    assert.equal(ui.requests.some(request => request.method === 'PATCH'), false);
    assert.equal(ui.requests.filter(request => request.method === 'POST').every(request => request.path === '/api/tasks/from-evidence'), true);
  }
});

test('task create receipts still require a revision unless explicitly marked as non-mutating deduplication', async () => {
  for (const deduplicated of [false, 'not-a-boolean']) {
    const ui = await setup();
    const form = ui.query('#task-form');
    form.elements.title.value = 'Synthetic task text to retain';
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      return Response.json({ task: { id: 'fake-task-without-revision' }, deduplicated });
    };
    ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    await form.fire('submit');
    assert.equal(ui.run('editingId'), null);
    assert.equal(form.elements.title.value, 'Synthetic task text to retain');
    assert.match(ui.query('#task-form [data-save-status]').textContent, /outcome could not be confirmed/);
    await form.fire('submit');
    assert.equal(ui.requests.length, 1);
  }
});

test('manual outcome saves retain the original record/revision and never duplicate a committed create after refresh failure', async () => {
  const ui = await setup();
  const form = ui.query('#outcome-form');
  ui.context.fakeRecord = { id: 'fake-other-outcome', title: 'Other outcome', category: 'outcome', revision: 3 };
  ui.run('workspace.records = [fakeRecord]; renderRecords();');
  const otherEdit = descendants(ui.query('#outcome-list')).find(element => element.tagName === 'BUTTON');
  form.elements.category.value = 'outcome';
  form.elements.title.value = 'Submitted synthetic outcome';
  const mutation = deferred();
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (options.method === 'POST' || options.method === 'PATCH') return mutation.promise;
    throw new Error('Synthetic display refresh failure');
  };
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  const pending = form.fire('submit');
  await form.fire('submit');
  await otherEdit.fire('click');
  assert.equal(form.dataset.recordId, undefined);
  assert.equal(form.elements.title.value, 'Submitted synthetic outcome');
  form.elements.note.value = 'Newer outcome notes';
  mutation.resolve(Response.json({ record: { id: 'fake-outcome', revision: 1, category: 'outcome' } }));
  await pending;
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(form.dataset.recordId, 'fake-outcome');
  assert.equal(form.dataset.revision, '1');
  assert.equal(form.elements.note.value, 'Newer outcome notes');
  assert.equal(form.elements.category.disabled, true);
  await form.fire('submit');
  const patch = ui.requests.find(request => request.method === 'PATCH');
  assert.equal(patch.path, '/api/records/fake-outcome');
  assert.equal(JSON.parse(patch.body).category, 'outcome');
  assert.equal(JSON.parse(patch.body).revision, 1);
});

test('profile saves serialize submissions and retain newer writing preferences without treating refresh errors as rejection', async () => {
  const ui = await setup();
  const form = ui.query('#profile-form');
  form.elements.writingStyle.value = 'Submitted synthetic writing style';
  const mutation = deferred();
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (options.method === 'PATCH') return mutation.promise;
    throw new Error('Synthetic profile display refresh failure');
  };
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  const pending = form.fire('submit');
  await form.fire('submit');
  form.elements.writingStyle.value = 'Newer synthetic writing preference';
  mutation.resolve(Response.json({ profile: { writingStyle: 'Submitted synthetic writing style' } }));
  await pending;
  assert.equal(ui.requests.filter(request => request.method === 'PATCH').length, 1);
  assert.equal(form.elements.writingStyle.value, 'Newer synthetic writing preference');
  assert.equal(ui.run('profileRendered'), true);
  assert.match(ui.query('#profile-form [data-save-status]').textContent, /Profile saved locally.*refresh failed/);
  assert.equal(form.elements.writingStyle.disabled, false);
});

test('pending note/evidence saves cannot switch, clear or post into another task and dirty notes retain their task binding after close', async () => {
  for (const selector of ['#conversation-form', '#evidence-form']) {
    const ui = await setup();
    ui.run("conversationTaskId = 'fake-task-a';");
    ui.query('#conversation-dialog').showModal();
    const form = ui.query(selector);
    if (selector === '#conversation-form') form.elements.text.value = 'Submitted synthetic note A';
    else {
      form.elements.title.value = 'Submitted evidence A';
      form.elements.url.value = 'https://example.invalid/evidence-a';
    }
    const mutation = deferred();
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (options.method === 'POST') return mutation.promise;
      throw new Error('Synthetic conversation refresh failure');
    };
    ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    const pending = form.fire('submit');
    await form.fire('submit');
    await ui.query('#close-conversation').fire('click');
    ui.context.otherTask = { id: 'fake-task-b', title: 'Fake B' };
    await ui.run('openConversation(otherTask);');
    assert.equal(ui.run('conversationTaskId'), 'fake-task-a');
    assert.equal(ui.query('#conversation-dialog').open, true);
    const field = selector === '#conversation-form' ? form.elements.text : form.elements.note;
    field.value = 'Newer synthetic A text';
    mutation.resolve(Response.json(selector === '#conversation-form' ? { message: { id: 'fake-note' } } : { evidence: { id: 'fake-evidence' } }));
    await pending;
    const writes = ui.requests.filter(request => request.method === 'POST');
    assert.equal(writes.length, 1);
    assert.ok(writes[0].path.includes('/fake-task-a/'));
    assert.equal(field.value, 'Newer synthetic A text');
    assert.match(ui.query(`${selector} [data-save-status]`).textContent, /save succeeded.*refresh failed/);
    await ui.query('#close-conversation').fire('click');
    assert.equal(ui.query('#conversation-dialog').open, false);
    await ui.run('openConversation(otherTask);');
    assert.equal(ui.run('conversationTaskId'), 'fake-task-a');
    assert.equal(field.value, 'Newer synthetic A text');
  }
});

test('unknown local save outcomes retain text and block retries, while explicit HTTP rejections allow correction', async () => {
  for (const outcome of ['transport', 'server-error', 'invalid-receipt', 'rejected']) {
    const rejected = outcome === 'rejected';
    const ui = await setup();
    const form = ui.query('#draft-form');
    form.elements.subject.value = 'Synthetic draft';
    form.elements.body.value = 'Retain this synthetic text';
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (rejected) return Response.json({ error: 'Synthetic validation rejection' }, { status: 400 });
      if (outcome === 'server-error') return Response.json({ error: 'Synthetic server error after unknown processing' }, { status: 500 });
      if (outcome === 'invalid-receipt') return new Response('{invalid', { status: 200 });
      throw new TypeError('Synthetic missing mutation response');
    };
    ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    await form.fire('submit');
    assert.equal(form.elements.body.value, 'Retain this synthetic text');
    assert.equal(ui.query('#draft-form button[type="submit"]').disabled, !rejected);
    await form.fire('submit');
    assert.equal(ui.requests.length, rejected ? 2 : 1);
    assert.match(ui.query('#draft-form [data-save-status]').textContent, rejected ? /Save rejected/ : /outcome could not be confirmed/);
  }
});

test('malformed or mismatched 2xx receipts remain unconfirmed without clearing text, retargeting or another mutation', async () => {
  for (const receipt of [{}, { draft: { id: 'fake-wrong-draft', revision: 2 } }, { draft: { id: 'fake-original-draft' } }]) {
    const ui = await setup();
    const form = ui.query('#draft-form');
    ui.run("editingDraftId = 'fake-original-draft'; editingDraftRevision = 1; accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    form.elements.subject.value = 'Synthetic original subject';
    form.elements.body.value = 'Keep the original synthetic text';
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      return Response.json(receipt);
    };
    await form.fire('submit');
    assert.equal(form.elements.body.value, 'Keep the original synthetic text');
    assert.equal(ui.run('editingDraftId'), 'fake-original-draft');
    assert.equal(ui.run('editingDraftRevision'), 1);
    const status = ui.query('#draft-form [data-save-status]').textContent;
    assert.match(status, /outcome could not be confirmed.*Reload and check saved records/);
    assert.doesNotMatch(status, /succeeded|Saved locally/);
    await form.fire('submit');
    assert.equal(ui.requests.length, 1);
  }
});

test('a delayed link save prevents duplicate submissions and retains newer input after a confirmed save and failed refresh', async () => {
  const ui = await setup();
  const form = ui.query('#link-form');
  form.elements.title.value = 'Synthetic submitted link';
  form.elements.url.value = 'https://example.invalid/submitted';
  const mutation = deferred();
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (options.method === 'POST') return mutation.promise;
    throw new Error('Synthetic links display refresh failure');
  };
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  const pending = form.fire('submit');
  const duplicate = form.fire('submit');
  const locked = form.elements.title.disabled && form.elements.url.disabled;
  const pendingWrites = ui.requests.filter(request => request.method === 'POST').length;
  form.elements.title.value = 'Newer synthetic link label';
  form.elements.url.value = 'https://example.invalid/newer';
  await form.fire('input');
  mutation.resolve(Response.json({ link: { id: 'fake-link', title: 'Synthetic submitted link', url: 'https://example.invalid/submitted' } }));
  await Promise.all([pending, duplicate]);
  assert.equal(locked, true);
  assert.equal(pendingWrites, 1);
  assert.equal(form.elements.title.value, 'Newer synthetic link label');
  assert.equal(form.elements.url.value, 'https://example.invalid/newer');
  assert.equal(form.elements.title.disabled, false);
  assert.match(ui.query('#link-form [data-save-status]').textContent, /Link saved locally.*Newer edits.*save succeeded.*refresh failed/);
  assert.deepEqual(JSON.parse(ui.requests[0].body), { title: 'Synthetic submitted link', url: 'https://example.invalid/submitted' });
  assert.equal(ui.requests.every(request => request.path.startsWith('/api/')), true);
});

test('confirmed new labeled links clear only unchanged input; identical label/URL retries explicitly retain the saved record', async () => {
  for (const [title, savedTitle] of [['Synthetic proposed label', 'Synthetic proposed label'], [' Cafe\u0301\u0007 ', 'Caf\u00e9']]) {
    for (const deduplicated of [false, true]) {
      const ui = await setup();
      const form = ui.query('#link-form');
      form.elements.title.value = title;
      form.elements.url.value = 'https://example.invalid/';
      ui.context.fetch = async (path, options) => {
        ui.requests.push({ path, ...options });
        return Response.json({ link: { id: 'fake-link', title: savedTitle, url: 'https://example.invalid/' }, deduplicated });
      };
      ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {};");
      await form.fire('submit');
      assert.equal(form.elements.title.value, deduplicated ? title : '');
      assert.equal(form.elements.url.value, deduplicated ? 'https://example.invalid/' : '');
      assert.match(ui.query('#link-form [data-save-status]').textContent, deduplicated ? /Existing link with this label and URL retained.*No duplicate was created/ : /Link saved locally/);
      assert.equal(ui.requests.length, 1);
    }
  }
});

test('the link submit handler confirms real local API receipts for decomposed URLs and sanitized controls', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-ui-link-receipts-'));
  let app;
  t.after(async () => {
    try { if (app) await app.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  app = await startServer({ dataDir, port: 0, workerIntervalMs: 0 });
  const state = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  const ui = await setup();
  ui.context.testAccess = app.accessToken;
  ui.context.testCsrf = state.csrfToken;
  ui.run('accessToken = testAccess; csrfToken = testCsrf; refreshState = async () => { workspace = await api("/api/state"); };');
  const statuses = [];
  ui.context.fetch = async (path, options) => {
    assert.ok(['/api/links', '/api/state'].includes(path), 'only the isolated local API may be requested');
    ui.requests.push({ path, ...options });
    const headers = new Headers(options.headers);
    if (options.method === 'POST') headers.set('Origin', app.url);
    const response = await fetch(`${app.url}${path}`, { ...options, headers });
    if (options.method === 'POST') statuses.push(response.status);
    return response;
  };
  const form = ui.query('#link-form');
  const inputs = [
    'https://example.invalid/cafe\u0301',
    'https://example.invalid/caf\u00e9',
    ' \u0007https://example.invalid/ca\u0008fe\u0301\u007f '
  ];
  for (const [index, url] of inputs.entries()) {
    form.elements.title.value = 'Synthetic normalized URL';
    form.elements.url.value = url;
    await form.fire('submit');
    assert.equal(statuses[index], index === 0 ? 201 : 200);
    const status = ui.query('#link-form [data-save-status]').textContent;
    assert.match(status, index === 0 ? /Link saved locally/ : /Existing link with this label and URL retained/);
    assert.doesNotMatch(status, /unconfirmed|could not be confirmed|refresh failed/);
    assert.equal(form.elements.url.value, index === 0 ? '' : url);
    assert.equal(ui.query('#link-form button[type="submit"]').disabled, false);
    const saved = ui.run('workspace.links');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].url, 'https://example.invalid/caf%C3%A9');
    assert.equal(ui.run('workspace.activity.filter(item => item.kind === "link-saved").length'), 1);
  }
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, inputs.length);
});

test('uncertain or mismatched link receipts preserve input and block retries; explicit rejection permits correction', async () => {
  for (const outcome of ['transport', 'server-error', 'invalid-json', 'wrong-url', 'wrong-title', 'missing-item', 'rejected']) {
    const ui = await setup();
    const form = ui.query('#link-form');
    form.elements.title.value = 'Keep synthetic label';
    form.elements.url.value = 'https://example.invalid/keep';
    const rejected = outcome === 'rejected';
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (rejected) return Response.json({ error: 'Synthetic URL rejection' }, { status: 400 });
      if (outcome === 'server-error') return Response.json({ error: 'Synthetic unknown server result' }, { status: 500 });
      if (outcome === 'invalid-json') return new Response('{invalid', { status: 201 });
      if (outcome === 'wrong-url') return Response.json({ link: { id: 'fake-other-link', url: 'https://example.invalid/other' } });
      if (outcome === 'wrong-title') return Response.json({ link: { id: 'fake-other-link', title: 'Different synthetic label', url: 'https://example.invalid/keep' } });
      if (outcome === 'missing-item') return Response.json({});
      throw new TypeError('Synthetic missing mutation response');
    };
    ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    await form.fire('submit');
    assert.equal(form.elements.title.value, 'Keep synthetic label');
    assert.equal(form.elements.url.value, 'https://example.invalid/keep');
    assert.equal(ui.query('#link-form button[type="submit"]').disabled, !rejected);
    await form.fire('submit');
    assert.equal(ui.requests.length, rejected ? 2 : 1);
    const status = ui.query('#link-form [data-save-status]').textContent;
    assert.match(status, rejected ? /Save rejected/ : /outcome could not be confirmed/);
    assert.doesNotMatch(status, /succeeded|Link saved locally/);
  }
});
