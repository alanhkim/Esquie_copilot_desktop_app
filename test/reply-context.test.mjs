import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { startServer } from '../src/server.mjs';

const appUrl = new URL('../public/app.js', import.meta.url);
const boardUrl = new URL('../public/task-board.mjs', import.meta.url);
const appScript = await readFile(appUrl, 'utf8');
const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const moduleScripts = new Map(await Promise.all(
  ['task-board.mjs', 'completed-work.mjs', 'account-search.mjs', 'account-workspace.mjs', 'outcome-import-workflow.mjs', 'outcome-export-workflow.mjs', 'pipeline-snapshots.mjs', 'portfolio-workspace.mjs'].map(async name => {
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
    const classes = new Set();
    this.classList = {
      toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
      contains: name => classes.has(name)
    };
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

async function setup(storageOrOptions = new Map(), fetchHandler = null) {
  const storageBackend = storageOrOptions instanceof Map || typeof storageOrOptions?.get === 'function' ||
    typeof storageOrOptions?.getItem === 'function'
    ? storageOrOptions : storageOrOptions?.storage || new Map();
  const selectedFetchHandler = storageOrOptions instanceof Map || typeof storageOrOptions?.get === 'function'
    ? fetchHandler : storageOrOptions?.fetchHandler || fetchHandler;
  const storage = {
    get(key) {
      return storageBackend instanceof Map || typeof storageBackend?.get === 'function'
        ? storageBackend.get(key) : storageBackend.getItem(key);
    },
    set(key, value) {
      return storageBackend instanceof Map || typeof storageBackend?.set === 'function'
        ? storageBackend.set(key, value) : storageBackend.setItem(key, value);
    },
    delete(key) {
      return storageBackend instanceof Map || typeof storageBackend?.delete === 'function'
        ? storageBackend.delete(key) : storageBackend.removeItem(key);
    }
  };
  const elements = new Map();
  const viewButtons = [];
  const viewSections = [];
  const outcomeButtons = ['impact', 'outcomes', 'engagements', 'ahead', 'suggestions'].map(outcomeView =>
    Object.assign(new Element('button'), { dataset: { outcomeView } }));
  const query = selector => {
    if (!elements.has(selector)) elements.set(selector, Object.assign(new Element(), { ownerDocument: document }));
    return elements.get(selector);
  };
  const document = {
    activeElement: null, querySelector: query,
    querySelectorAll: selector => selector === '[data-job]' ? genericButtons :
      selector === '[data-view]' ? viewButtons : selector === '[data-outcome-view]' ? outcomeButtons :
      selector === '.view' ? viewSections : [],
    createElement: tag => Object.assign(new Element(tag), { ownerDocument: document })
  };
  const genericButtons = ['task_summary', 'document', 'backup', 'source_refresh'].map(kind =>
    Object.assign(query(`#queue-${kind}`), { dataset: { job: kind } }));
  for (const view of ['ask', 'board', 'completed-work', 'drafts', 'demo', 'links', 'activity', 'operations', 'portfolio', 'ssps', 'heatmap']) {
    viewButtons.push(Object.assign(new Element('button'), { dataset: { view } }));
  }
  for (const [view, area] of [['board', 'work'], ['portfolio', 'portfolio'], ['pipeline', 'pipeline'], ['outcomes', 'outcomes']]) {
    viewButtons.push(Object.assign(new Element('button'), { dataset: { view, area }, ownerDocument: document }));
  }
  for (const view of ['setup', 'ask', 'board', 'completed-work', 'drafts', 'demo', 'links', 'activity', 'operations', 'portfolio', 'ssps', 'heatmap', 'pipeline', 'outcomes']) {
    viewSections.push(Object.assign(new Element('section'), { id: `view-${view}`, hidden: true }));
  }
  query('#sidebar-work').append(...viewButtons.filter(button => !button.dataset.area && !['portfolio', 'ssps', 'heatmap'].includes(button.dataset.view)));
  query('#sidebar-portfolio').append(...viewButtons.filter(button => !button.dataset.area && ['portfolio', 'ssps', 'heatmap'].includes(button.dataset.view)));
  query('#sidebar-outcomes').append(...outcomeButtons);
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
    'meeting-form': ['notes'],
    'fake-demo-form': ['format', 'confirmFakeOnly'],
    'task-owner-form': ['nextOwner'], 'conversation-form': ['text'], 'evidence-form': ['type', 'title', 'url', 'note'],
    'outcome-form': ['category', 'title', 'date', 'note'],
    'account-form': ['title', 'note', 'plan', 'stakeholders'],
    'account-metric-form': ['accountId', 'label', 'value', 'unit', 'date', 'confirmOwnerEntered'],
    'ssp-form': ['recordId', 'title', 'accountIds', 'confirmOwnerEntered'],
    'output-form': ['confirmPrivateNonSynced'],
    'demo-approval-form': ['confirmSyntheticLocalOnly'],
    'preferences-form': ['paused', 'automaticRefresh', 'dailyBackups', 'quietStart', 'quietEnd'],
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
  query('#evidence-form').elements.type.value = 'email';
  query('#evidence-form').elements.type.defaultValue = 'email';
  query('#outcome-import-form').elements = {
    text: new Element('textarea'), reviewed: new Element('input'),
    sourceMethod: Object.assign(new Element('select'), { value: 'pasted' })
  };
  query('#meeting-insight-detail-form').elements = { detailConsent: { checked: false, disabled: false } };
  const pipelineForm = query('#pipeline-snapshot-form');
  const pipelineControls = ['type', 'text', 'reviewed'].map(name =>
    Object.assign(new Element(name === 'text' ? 'textarea' : 'input'), { name }));
  pipelineControls[0].value = 'opportunities';
  pipelineForm.elements = Object.assign(pipelineControls, Object.fromEntries(
    pipelineControls.map((control, index) => [['type', 'text', 'reviewed'][index], control])
  ));
  const requests = [];
  const windowListeners = {};
  const location = { hash: '' };
  const historyCalls = [];
  const context = vm.createContext({
    document,
    window: { addEventListener(type, handler) { windowListeners[type] = handler; }, confirm: () => true }, confirm: () => true,
    location, history: { replaceState(...args) { historyCalls.push(args); location.hash = args[2]; } },
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    }, crypto: { randomUUID, subtle: webcrypto.subtle },
    URL, URLSearchParams, Headers, TextEncoder,
    FormData: class {
      constructor(form) { this.values = [...form.elements].filter(control => control.name && !control.disabled).map(control => [control.name, control.value]); }
      [Symbol.iterator]() { return this.values[Symbol.iterator](); }
    },
    setTimeout() {}, clearTimeout() {}, setInterval(callback) { context.backgroundRefresh = callback; },
    fetch: async (path, options) => {
      requests.push({ path, ...options });
      if (selectedFetchHandler) return selectedFetchHandler(path, options);
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
  assert.equal(run('completedWorkTasks'), modules.get(new URL('../public/completed-work.mjs', import.meta.url).href).namespace.completedWorkTasks);
  assert.equal(run('bindAccountFormSubmission'), modules.get(new URL('../public/account-workspace.mjs', import.meta.url).href).namespace.bindAccountFormSubmission);
  assert.equal(run('createOutcomeImportWorkflow'), modules.get(new URL('../public/outcome-import-workflow.mjs', import.meta.url).href).namespace.createOutcomeImportWorkflow);
  assert.equal(run('createOutcomeExportWorkflow'), modules.get(new URL('../public/outcome-export-workflow.mjs', import.meta.url).href).namespace.createOutcomeExportWorkflow);
  return {
    query, form, requests, context, run, historyCalls, windowListeners,
    navigation: view => viewButtons.find(button => button.dataset.view === view && !button.dataset.area),
    area: area => viewButtons.find(button => button.dataset.area === area),
    outcome: view => outcomeButtons.find(button => button.dataset.outcomeView === view),
    section: view => viewSections.find(section => section.id === `view-${view}`),
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

test('search containers show a contrasting focus indicator when their input receives focus', () => {
  assert.match(styles, /\.search:focus-within\s*\{\s*outline:\s*2px solid var\(--accent\);\s*outline-offset:\s*2px;\s*\}/);
});

test('real account metric save preserves unknown outcomes and reconciles without replay after reload', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-ui-account-metrics-'));
  const app = await startServer({ dataDir, port: 0, workerIntervalMs: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const headers = { Origin: app.url, 'X-Esquie-Access': app.accessToken, 'Content-Type': 'application/json' };
  const state = async () => (await fetch(`${app.url}/api/state`, { headers })).json();
  headers['X-Esquie-CSRF'] = (await state()).csrfToken;
  const send = async (path, body, method = 'POST') => fetch(`${app.url}${path}`, { method, headers, body: JSON.stringify(body) });
  const accounts = [];
  for (let index = 0; index < 2; index++) {
    accounts.push((await (await send('/api/records', { category: 'account', title: 'Identical synthetic account' })).json()).record);
  }
  for (const outcome of ['lost', 'malformed-4xx', 'rejected', 'refresh-failed']) {
    const values = new Map();
    const storage = {
      getItem: key => values.get(key) || '',
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    };
    const ui = await setup({ storage });
    const hydrate = async instance => {
      instance.context.loadedMetricState = await state();
      instance.run(`accessToken = ${JSON.stringify(app.accessToken)}; csrfToken = ${JSON.stringify(headers['X-Esquie-CSRF'])};
        workspace = loadedMetricState; renderRecords();`);
    };
    await hydrate(ui);
    const form = ui.query('#account-metric-form');
    assert.match(form.elements.accountId.textContent, new RegExp(accounts[0].id));
    assert.match(form.elements.accountId.textContent, new RegExp(accounts[1].id));
    assert.equal(form.elements.accountId.value, '', 'no account is inferred even with identical labels');
    const snapshot = { accountId: accounts[0].id, label: `<img onerror="fakeCommand()"> ${outcome}`, value: '0', unit: '', date: '' };
    for (const [key, value] of Object.entries(snapshot)) form.elements[key].value = value;
    form.elements.confirmOwnerEntered.checked = true;
    if (outcome === 'rejected') {
      const current = (await state()).records.find(record => record.id === accounts[0].id);
      assert.equal((await send(`/api/records/${current.id}`, {
        category: 'account', title: current.title, revision: current.revision
      }, 'PATCH')).status, 200);
    }
    const reply = deferred();
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (outcome === 'refresh-failed' && options.method !== 'POST') throw new Error('Synthetic display refresh unavailable');
      const browserHeaders = new Headers(options.headers);
      browserHeaders.set('Origin', app.url);
      const response = await fetch(`${app.url}${path}`, { ...options, headers: browserHeaders });
      if (options.method === 'POST') {
        await reply.promise;
        if (outcome === 'lost') { await response.json(); throw new Error('Synthetic lost committed response'); }
        if (outcome === 'malformed-4xx') { await response.json(); return Response.json({}, { status: 409 }); }
      }
      return response;
    };
    const pending = form.fire('submit');
    await form.fire('submit');
    assert.equal(form.elements.accountId.disabled, true);
    assert.match(ui.query('#account-metric-status').textContent, /save pending/);
    reply.resolve();
    await pending;
    const outcomeMessage = ui.query('#account-metric-status').textContent;
    await form.fire('submit');
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
    if (outcome === 'lost' || outcome === 'malformed-4xx') {
      assert.match(ui.query('#account-metric-status').textContent, /outcome is unknown/);
      const originalRequest = JSON.parse(ui.requests[0].body).requestId;
      const reload = await setup({ storage });
      await hydrate(reload);
      const restored = reload.query('#account-metric-form');
      assert.equal(restored.elements.accountId.disabled, true);
      assert.equal(restored.elements.accountId.value, accounts[0].id);
      assert.equal(restored.elements.label.value, snapshot.label);
      assert.match(reload.query('#account-metric-status').textContent, new RegExp(originalRequest));
      reload.context.fetch = async (path, options) => {
        reload.requests.push({ path, ...options });
        const browserHeaders = new Headers(options.headers);
        browserHeaders.set('Origin', app.url);
        return fetch(`${app.url}${path}`, { ...options, headers: browserHeaders });
      };
      await restored.fire('submit');
      assert.equal(reload.requests.length, 0, 'reload cannot create a fresh request while the original is uncertain');
      await reload.query('#account-metric-check').fire('click');
      assert.match(reload.query('#account-metric-status').textContent, /confirmed saved locally/);
      assert.equal(reload.requests.filter(request => request.method === 'POST').length, 0, 'reconciliation reads only');
      assert.equal(restored.elements.confirmOwnerEntered.checked, false);
      assert.equal(values.size, 0);
      assert.match(reload.query('#account-list').textContent, /<img onerror="fakeCommand\(\)">/);
      assert.match(reload.query('#account-list').textContent, /Observation date: Unknown/);
      assert.match(reload.query('#account-list').textContent, /: 0/);
      await restored.fire('submit');
      assert.equal(reload.requests.filter(request => request.method === 'POST').length, 0, 'fresh intent must be explicit');
      restored.elements.confirmOwnerEntered.checked = true;
      await restored.fire('submit');
      assert.match(reload.query('#account-metric-status').textContent, /Existing owner-entered.*Nothing was submitted/);
      assert.equal(reload.query('#account-metric-repeat').hidden, false);
      assert.equal(reload.requests.filter(request => request.method === 'POST').length, 0, 'exact repeats require a separate explicit choice, not a resubmitted form');
    } else {
      assert.equal(values.size, 0);
      assert.equal(form.elements.confirmOwnerEntered.checked, false);
      assert.match(outcomeMessage, outcome === 'rejected' ? /Metric was rejected/ : /confirmed saved locally; display refresh failed/);
      assert.equal(form.elements.label.value, snapshot.label);
    }
    const saved = await state();
    const metrics = saved.records.find(record => record.id === accounts[0].id).metrics || [];
    assert.equal(metrics.filter(metric => metric.label === snapshot.label).length, outcome === 'rejected' ? 0 : 1);
    assert.equal((saved.records.find(record => record.id === accounts[1].id).metrics || []).length, 0);
  }
});

test('metric form fails closed without durable identity storage and leaves missing receipts unresolved', async () => {
  for (const mode of ['storage-unavailable', 'missing-receipt']) {
    const values = new Map();
    const storage = {
      getItem: key => values.get(key) || '',
      setItem: (key, value) => {
        if (mode === 'storage-unavailable') throw new Error('Synthetic storage unavailable');
        values.set(key, value);
      },
      removeItem: key => values.delete(key)
    };
    const ui = await setup({ storage });
    ui.context.metricAccount = { id: randomUUID(), title: 'Fake account', category: 'account', revision: 1 };
    ui.run("workspace.records = [metricAccount]; renderRecords(); accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    const form = ui.query('#account-metric-form');
    form.elements.accountId.value = ui.context.metricAccount.id;
    form.elements.label.value = 'Fake sample';
    form.elements.value.value = '0';
    form.elements.confirmOwnerEntered.checked = true;
    ui.context.fetch = async (path, options) => { ui.requests.push({ path, ...options }); return Response.json({}); };
    await form.fire('submit');
    await form.fire('submit');
    assert.equal(ui.requests.length, mode === 'storage-unavailable' ? 0 : 1);
    assert.match(ui.query('#account-metric-status').textContent, mode === 'storage-unavailable' ? /Not submitted/ : /outcome is unknown/);
    assert.equal(form.elements.value.value, '0');
    if (mode === 'missing-receipt') {
      await ui.query('#account-metric-check').fire('click');
      assert.match(ui.query('#account-metric-status').textContent, /remains unresolved|remains unknown/);
      assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
    }
  }
});

test('mismatched metric receipts never clear the original identity or authorize another observation', async () => {
  for (const mismatch of [
    { requestId: randomUUID() }, { value: '1' }, { appliedRevision: 9 },
    { duplicateOf: randomUUID() }, { confirmSeparateObservation: true }
  ]) {
    const values = new Map();
    const storage = {
      getItem: key => values.get(key) || '',
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    };
    const ui = await setup({ storage });
    const account = { id: randomUUID(), category: 'account', title: 'Synthetic account', revision: 1 };
    ui.context.metricAccount = account;
    ui.run("workspace.records = [metricAccount]; renderRecords(); accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    const form = ui.query('#account-metric-form');
    form.elements.accountId.value = account.id;
    form.elements.label.value = 'My exact observation';
    form.elements.value.value = '0';
    form.elements.confirmOwnerEntered.checked = true;
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      const body = JSON.parse(options.body);
      return Response.json({
        record: { ...account, revision: 2 },
        metric: {
          id: randomUUID(), ...body, requestRevision: body.revision, appliedRevision: 2,
          provenance: 'owner-provided-unverified', ...mismatch
        }
      }, { status: 201 });
    };
    await form.fire('submit');
    await form.fire('submit');
    assert.match(ui.query('#account-metric-status').textContent, /outcome is unknown/);
    assert.equal(ui.requests.length, 1);
    assert.equal(values.size, 1);
    assert.equal(form.elements.accountId.disabled, true);
  }
});

test('work area retains the last work view across other areas and updates sidebar selection', async () => {
  const ui = await setup();
  await ui.area('work').fire('click');
  assert.equal(ui.context.location.hash, '#board');
  assert.equal(ui.navigation('board')['aria-current'], 'page');
  for (const view of ['ask', 'drafts', 'demo', 'links', 'activity', 'operations']) {
    await ui.navigation(view).fire('click');
    assert.equal(ui.area('work')['aria-current'], 'page');
    assert.equal(ui.area('work').classList.contains('selected'), true);
    assert.equal(ui.navigation(view)['aria-current'], 'page');
    assert.equal(ui.navigation('board')['aria-current'], 'false');
    assert.equal(ui.section(view).hidden, false);
    for (const area of ['portfolio', 'pipeline', 'outcomes']) {
      await ui.area(area).fire('click');
      assert.equal(ui.area('work')['aria-current'], 'false');
      assert.equal(ui.area('work').classList.contains('selected'), false);
      assert.equal(ui.area(area)['aria-current'], 'page');
      await ui.area('work').fire('click');
      assert.equal(ui.context.location.hash, `#${view}`);
      assert.equal(ui.navigation(view)['aria-current'], 'page');
    }
  }
  await ui.navigation('heatmap').fire('click');
  assert.equal(ui.area('portfolio')['aria-current'], 'page');
  assert.equal(ui.navigation('heatmap')['aria-current'], 'page');
  assert.equal(ui.navigation('portfolio')['aria-current'], 'false');
  ui.run('changeSetup = async () => {};');
  await ui.query('#resume-setup').fire('click');
  assert.equal(ui.area('work')['aria-current'], 'page');
  assert.equal(ui.query('#resume-setup')['aria-current'], 'page');
  await ui.area('pipeline').fire('click');
  assert.equal(ui.query('#resume-setup')['aria-current'], 'false');
  await ui.area('work').fire('click');
  assert.equal(ui.context.location.hash, '#setup');
  assert.equal(ui.query('#resume-setup')['aria-current'], 'page');
  assert.ok(ui.historyCalls.every(call => call[2].startsWith('#')));
});

test('initial and hash-driven navigation preserve deep links and onboarding precedence', async () => {
  const ui = await setup();
  ui.run('refreshState = async () => {}; workspace.onboarding = { status: "completed" };');
  ui.context.location.hash = '#drafts';
  await ui.run('start()');
  assert.equal(ui.section('drafts').hidden, false);
  assert.equal(ui.area('work')['aria-current'], 'page');
  ui.context.location.hash = '#ssps';
  const callsBeforeHashChange = ui.historyCalls.length;
  ui.windowListeners.hashchange();
  assert.equal(ui.historyCalls.length, callsBeforeHashChange);
  assert.equal(ui.area('portfolio')['aria-current'], 'page');
  assert.equal(ui.navigation('ssps')['aria-current'], 'page');
  await ui.area('work').fire('click');
  assert.equal(ui.context.location.hash, '#drafts');
  ui.context.location.hash = '#ask';
  ui.windowListeners.hashchange();
  assert.equal(ui.navigation('ask')['aria-current'], 'page');
  ui.run('workspace.onboarding = { status: "in-progress" };');
  ui.context.location.hash = '#pipeline';
  await ui.run('start()');
  assert.equal(ui.context.location.hash, '#setup');
  assert.equal(ui.query('#resume-setup')['aria-current'], 'page');
  assert.equal(ui.area('work')['aria-current'], 'page');
  const other = await setup();
  other.run('refreshState = async () => {}; workspace.onboarding = { status: "completed" };');
  other.context.location.hash = '#pipeline';
  await other.run('start()');
  assert.equal(other.area('pipeline')['aria-current'], 'page');
  await other.area('work').fire('click');
  assert.equal(other.context.location.hash, '#board');
});

test('unknown and inherited-key hashes leave the current view and work navigation unchanged', async () => {
  const ui = await setup();
  await ui.navigation('drafts').fire('click');
  for (const hash of ['#constructor', '#__proto__', '#not-a-view']) {
    const calls = ui.historyCalls.length;
    ui.context.location.hash = hash;
    ui.windowListeners.hashchange();
    assert.equal(ui.context.location.hash, hash);
    assert.equal(ui.historyCalls.length, calls);
    assert.equal(ui.section('drafts').hidden, false);
    assert.equal(ui.area('work')['aria-current'], 'page');
    assert.equal(ui.navigation('drafts')['aria-current'], 'page');
    assert.equal(ui.query('#breadcrumb').textContent, 'Draft Studio');
  }
  await ui.area('pipeline').fire('click');
  await ui.area('work').fire('click');
  assert.equal(ui.context.location.hash, '#drafts');
});

test('contextual sidebar switches by area and outcomes buttons use the existing local filter', async () => {
  const ui = await setup();
  const sections = ['work', 'portfolio', 'outcomes'];
  const checkArea = active => {
    for (const section of sections) assert.equal(ui.query(`#sidebar-${section}`).hidden, section !== active);
  };
  await ui.area('work').fire('click');
  checkArea('work');
  ui.query('#outcome-form').elements.title.value = 'Unsaved local draft';
  await ui.navigation('heatmap').fire('click');
  checkArea('portfolio');
  assert.equal(ui.area('portfolio')['aria-current'], 'page');
  await ui.area('pipeline').fire('click');
  checkArea('pipeline');
  await ui.area('outcomes').fire('click');
  checkArea('outcomes');
  for (const [view, unavailable] of [
    ['impact', /Workshop impact analysis is unavailable/],
    ['outcomes', null], ['engagements', null],
    ['ahead', /set a valid owner timezone/],
    ['suggestions', /Suggested wins are unavailable/]
  ]) {
    await ui.outcome(view).fire('click');
    assert.equal(ui.context.location.hash, `#outcomes/${view}`);
    assert.equal(ui.query('#outcome-view-filter').value, view);
    assert.equal(ui.outcome(view)['aria-pressed'], 'true');
    for (const other of ['impact', 'outcomes', 'engagements', 'ahead', 'suggestions'].filter(key => key !== view)) {
      assert.equal(ui.outcome(other)['aria-pressed'], 'false');
    }
    if (unavailable) assert.match(ui.query('#outcome-view-unavailable').textContent, unavailable);
  }
  assert.equal(ui.query('#outcome-form').elements.title.value, 'Unsaved local draft');
  ui.query('#outcome-view-filter').value = 'workshops';
  await ui.query('#outcome-view-filter').fire('change');
  assert.equal(ui.context.location.hash, '#outcomes/workshops');
  assert.ok(['impact', 'outcomes', 'engagements', 'ahead', 'suggestions'].every(view => ui.outcome(view)['aria-pressed'] === 'false'));
  ui.context.location.hash = '#outcomes/engagements';
  ui.windowListeners.hashchange();
  assert.equal(ui.query('#outcome-view-filter').value, 'engagements');
  assert.equal(ui.outcome('engagements')['aria-pressed'], 'true');
  for (const hash of ['#outcomes/__proto__', '#outcomes/constructor', '#outcomes/unknown']) {
    ui.context.location.hash = hash;
    ui.windowListeners.hashchange();
    assert.equal(ui.query('#outcome-view-filter').value, 'engagements');
    checkArea('outcomes');
  }
  ui.context.document.activeElement = ui.outcome('engagements');
  ui.context.location.hash = '#pipeline';
  ui.windowListeners.hashchange();
  checkArea('pipeline');
  assert.equal(ui.context.document.activeElement, ui.area('pipeline'));
  await ui.area('work').fire('click');
  checkArea('work');
  assert.equal(ui.context.location.hash, '#board');
  ui.run('refreshState = async () => {}; workspace.onboarding = { status: "completed" };');
  ui.context.location.hash = '#outcomes/impact';
  await ui.run('start()');
  checkArea('outcomes');
  assert.equal(ui.outcome('impact')['aria-pressed'], 'true');
  assert.match(ui.query('#outcome-view-unavailable').textContent, /Workshop impact analysis is unavailable/);
});

test('contextual menus use native buttons and preserve the existing select', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="sidebar-portfolio" hidden>/);
  assert.match(html, /<div id="sidebar-outcomes" hidden>/);
  for (const view of ['impact', 'outcomes', 'engagements', 'ahead', 'suggestions']) {
    assert.match(html, new RegExp(`<button type="button" data-outcome-view="${view}" aria-pressed="false">`));
  }
  assert.match(html, /<select id="outcome-view-filter"/);
});

test('returning to Outcomes keeps the selected local view in the URL and after reload', async () => {
  const ui = await setup();
  ui.context.fakeOutcomes = [
    { id: 'local-outcome', category: 'outcome', title: 'Local outcome' },
    { id: 'local-engagement', category: 'engagement', title: 'Local engagement' }
  ];
  ui.run('workspace.records = fakeOutcomes; renderRecords();');
  await ui.area('outcomes').fire('click');
  assert.equal(ui.context.location.hash, '#outcomes');
  await ui.outcome('engagements').fire('click');
  ui.query('#outcome-form').elements.title.value = 'Unsaved local draft';
  await ui.area('work').fire('click');
  await ui.area('outcomes').fire('click');
  assert.equal(ui.context.location.hash, '#outcomes/engagements');
  assert.equal(ui.query('#outcome-view-filter').value, 'engagements');
  assert.equal(ui.query('#outcome-form').elements.title.value, 'Unsaved local draft');
  assert.match(ui.query('#outcome-list').textContent, /Local engagement/);
  assert.doesNotMatch(ui.query('#outcome-list').textContent, /Local outcome/);

  const reloaded = await setup();
  reloaded.context.fakeOutcomes = ui.context.fakeOutcomes;
  reloaded.run('refreshState = async () => {}; workspace.onboarding = { status: "completed" }; workspace.records = fakeOutcomes;');
  reloaded.context.location.hash = ui.context.location.hash;
  await reloaded.run('start()');
  assert.equal(reloaded.query('#outcome-view-filter').value, 'engagements');
  assert.equal(reloaded.outcome('engagements')['aria-pressed'], 'true');
  assert.match(reloaded.query('#outcome-list').textContent, /Local engagement/);
  assert.doesNotMatch(reloaded.query('#outcome-list').textContent, /Local outcome/);

  const alias = await setup();
  alias.run('refreshState = async () => {}; workspace.onboarding = { status: "completed" };');
  alias.context.location.hash = '#outcomes';
  await alias.run('start()');
  assert.equal(alias.context.location.hash, '#outcomes');
  assert.equal(alias.section('outcomes').hidden, false);
});

test('bare Outcomes hash resets a previous filter to all in-session and after reload', async () => {
  const ui = await setup();
  ui.context.fakeOutcomes = [
    { id: 'local-outcome', category: 'outcome', title: 'Local outcome' },
    { id: 'local-engagement', category: 'engagement', title: 'Local engagement' }
  ];
  ui.run('workspace.records = fakeOutcomes; renderRecords();');
  await ui.outcome('engagements').fire('click');
  ui.query('#outcome-form').elements.title.value = 'Unsaved local draft';
  ui.context.location.hash = '#outcomes';
  const calls = ui.historyCalls.length;
  ui.windowListeners.hashchange();
  assert.equal(ui.historyCalls.length, calls);
  assert.equal(ui.context.location.hash, '#outcomes');
  assert.equal(ui.query('#outcome-view-filter').value, 'all');
  assert.equal(ui.outcome('engagements')['aria-pressed'], 'false');
  assert.equal(ui.query('#outcome-form').elements.title.value, 'Unsaved local draft');
  assert.match(ui.query('#outcome-list').textContent, /Local outcome/);
  assert.match(ui.query('#outcome-list').textContent, /Local engagement/);
  const reloaded = await setup();
  reloaded.context.fakeOutcomes = ui.context.fakeOutcomes;
  reloaded.run('refreshState = async () => { renderRecords(); }; workspace.onboarding = { status: "completed" }; workspace.records = fakeOutcomes;');
  reloaded.context.location.hash = '#outcomes';
  await reloaded.run('start()');
  assert.equal(reloaded.query('#outcome-view-filter').value || 'all', 'all');
  assert.match(reloaded.query('#outcome-list').textContent, /Local outcome/);
  assert.match(reloaded.query('#outcome-list').textContent, /Local engagement/);
});

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

test('outcome export retries stay bound to the original snapshot across reloads', async () => {
  const storage = new Map();
  const requestIdKey = 'esquie:outcome-export-request';
  const record = {
    id: 'synthetic-owner-outcome', revision: 1, category: 'outcome',
    title: 'Synthetic owner-entered outcome', note: 'Private synthetic detail', date: ''
  };
  let droppedPostCount = 0;
  const first = await setup(storage, async path => {
    if (path === '/api/outcomes/export') {
      droppedPostCount++;
      const marker = JSON.parse(storage.get(requestIdKey));
      assert.equal(marker.recordCount, 1);
      assert.match(marker.snapshotHash, /^[0-9a-f]{64}$/);
    }
    throw new Error('Synthetic request dropped before reaching the server.');
  });
  first.context.fakeOutcomes = [record];
  first.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; workspace.records = fakeOutcomes;");
  await first.query('#outcome-export').fire('click');
  assert.equal(droppedPostCount, 1);
  const persisted = JSON.parse(storage.get(requestIdKey));
  assert.deepEqual(Object.keys(persisted).sort(), ['recordCount', 'requestId', 'snapshotHash']);
  assert.equal(persisted.recordCount, 1);
  assert.match(persisted.snapshotHash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(storage.get(requestIdKey), /Synthetic owner-entered outcome|Private synthetic detail/);

  let changedSnapshotPosts = 0;
  const changed = await setup(storage, async () => {
    changedSnapshotPosts++;
    throw new Error('A retry must not be sent for changed records.');
  });
  changed.context.fakeOutcomes = [{ ...record, title: 'Edited after the original request' }];
  changed.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; workspace.records = fakeOutcomes;");
  await changed.query('#outcome-export-retry').fire('click');
  assert.equal(changedSnapshotPosts, 0);
  assert.match(changed.query('#outcome-export-status').textContent, /differ from the original export intent/i);
  assert.equal(JSON.parse(storage.get(requestIdKey)).requestId, persisted.requestId);

  const retryBodies = [];
  let simulatedFileWrites = 0;
  const restored = await setup(storage, async (path, options) => {
    if (path === '/api/outcomes/export') {
      const body = JSON.parse(options.body);
      retryBodies.push(body);
      const reused = true;
      if (!reused) simulatedFileWrites++;
      const exportReceipt = {
        id: body.requestId,
        format: 'xlsx',
        fileName: `monthly-outcomes-${body.requestId}.xlsx`,
        recordCount: body.recordCount,
        snapshotHash: body.snapshotHash,
        contentBytes: 1234,
        contentSha256: 'a'.repeat(64),
        createdAt: '2026-03-04T10:00:00.000Z'
      };
      return { ok: true, status: 200, json: async () => ({ reused, export: exportReceipt }) };
    }
    throw new Error('Synthetic workspace refresh unavailable.');
  });
  restored.context.fakeOutcomes = [record];
  restored.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; workspace.records = fakeOutcomes;");
  await restored.query('#outcome-export-retry').fire('click');
  assert.equal(retryBodies.length, 1);
  assert.equal(retryBodies[0].requestId, persisted.requestId);
  assert.equal(retryBodies[0].snapshotHash, persisted.snapshotHash);
  assert.equal(retryBodies[0].recordCount, persisted.recordCount);
  assert.equal(simulatedFileWrites, 0);
  assert.equal(storage.has(requestIdKey), false);

  const legacyStorage = new Map([[requestIdKey, persisted.requestId]]);
  const legacy = await setup(legacyStorage);
  legacy.context.fakeOutcomes = [record];
  legacy.run("workspace.records = fakeOutcomes;");
  assert.equal(legacy.query('#outcome-export-retry').disabled, true);
  assert.equal(legacy.query('#outcome-export-reset').disabled, false);
  await legacy.query('#outcome-export-retry').fire('click');
  assert.equal(legacy.requests.length, 0);
  assert.match(legacy.query('#outcome-export-status').textContent, /original export intent is unavailable/i);
});

function undoTask(fromStatus = 'next', toStatus = 'done') {
  return {
    id: randomUUID(), title: '<img src=x onerror="fakeCommand()"> Synthetic undo', status: toStatus, revision: 2,
    completedAt: toStatus === 'done' ? '2026-03-01T10:00:00Z' : null,
    history: [{
      id: randomUUID(), kind: toStatus === 'done' ? 'completed' : fromStatus === 'done' ? 'reopened' : 'status-changed',
      fromStatus, toStatus, at: '2026-03-01T10:00:00Z',
      undoReceipt: { revision: 2, beforeCompletedAt: fromStatus === 'done' ? '2026-02-01T10:00:00Z' : null, afterCompletedAt: toStatus === 'done' ? '2026-03-01T10:00:00Z' : null }
    }]
  };
}

async function setupUndoUi(task = undoTask()) {
  const ui = await setup();
  ui.context.undoFixture = task;
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; workspace.tasks = [undoFixture]; workspace.activity = []; renderActivity();");
  return { ui, task, button: ui.query('#activity-list').querySelectorAll('[data-undo-event]')[0] };
}

test('undo rendering makes no mutation, explicitly labels completed transitions, and is reachable in Activity with completed tasks hidden', async () => {
  for (const [from, to, label] of [['next', 'done', /Undo completion: reopen/], ['done', 'waiting', /Undo reopening: restore Completed/], ['next', 'doing', /Undo move: restore/]]) {
    const { ui, button } = await setupUndoUi(undoTask(from, to));
    ui.run("$('#show-completed').checked = false; renderTasks();");
    assert.match(button.textContent, label);
    assert.match(ui.query('#activity-list').textContent, /<img src=x onerror=/, 'titles stay inert text');
    assert.equal(ui.requests.length, 0);
    assert.equal(ui.run('workspace.tasks[0].status'), to);
    ui.run('workspace.tasks[0].revision++; renderActivity();');
    assert.equal(ui.query('#activity-list').querySelectorAll('[data-undo-event]').length, 0, 'later edits remove stale opportunities');
  }
});

test('actual undo button captures its displayed revision and serializes repeated events across refresh', async () => {
  const { ui, task, button } = await setupUndoUi();
  const pendingResponse = deferred();
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    return pendingResponse.promise;
  };
  ui.run("refreshState = async () => { throw new Error('Synthetic display unavailable'); };");
  const pending = button.fire('click');
  assert.equal(button.disabled, true);
  assert.match(button.textContent, /pending; no reversal confirmed/);
  await button.fire('click');
  ui.run('renderActivity()');
  assert.equal(ui.query('#activity-list').querySelectorAll('[data-undo-event]').length, 0);
  assert.match(ui.query('#activity-list').textContent, /No reversal is claimed/);
  const request = ui.requests[0];
  const body = JSON.parse(request.body);
  assert.equal(request.path, `/api/tasks/${task.id}/undo`);
  assert.equal(body.eventId, task.history[0].id);
  assert.equal(body.revision, 2);
  pendingResponse.resolve(Response.json({
    task: { id: task.id },
    undoReceipt: { id: randomUUID(), kind: 'task-undo', status: 'applied', taskId: task.id, ...body, requestRevision: body.revision, appliedRevision: 3 }
  }));
  await pending;
  await button.fire('click');
  assert.equal(ui.requests.length, 1);
  assert.match(ui.query('#activity-list').textContent, /Undo recorded at revision 3.*Display refresh failed/);
  assert.doesNotMatch(ui.query('#activity-list').textContent, /outcome is unknown/);
});

test('real-handler undo distinguishes structured rejection from lost/malformed receipts, including malformed 4xx, without replay', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-ui-undo-'));
  const app = await startServer({ dataDir, port: 0, workerIntervalMs: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const headers = { Origin: app.url, 'X-Esquie-Access': app.accessToken, 'Content-Type': 'application/json' };
  const initial = await (await fetch(`${app.url}/api/state`, { headers })).json();
  headers['X-Esquie-CSRF'] = initial.csrfToken;
  const send = async (path, body, method = 'POST') => fetch(`${app.url}${path}`, { method, headers, body: JSON.stringify(body) });
  for (const transport of ['lost', 'malformed', 'malformed-4xx-json', 'malformed-4xx-body', 'structured-rejection']) {
    let task = (await (await send('/api/tasks', { title: `Synthetic ${transport} undo` })).json()).task;
    task = (await (await send(`/api/tasks/${task.id}`, { status: 'done', revision: task.revision }, 'PATCH')).json()).task;
    const { ui, button } = await setupUndoUi(task);
    const rejected = transport === 'structured-rejection';
    if (rejected) {
      const edit = await send(`/api/tasks/${task.id}`, { title: 'Synthetic intervening edit', revision: task.revision }, 'PATCH');
      assert.equal(edit.status, 200);
    }
    ui.run(`accessToken = ${JSON.stringify(app.accessToken)}; csrfToken = ${JSON.stringify(initial.csrfToken)};
      refreshState = async () => { const result = await api('/api/state'); workspace.tasks = result.tasks; renderActivity(); };`);
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      const requestHeaders = new Headers(options.headers);
      requestHeaders.set('Origin', app.url);
      const response = await fetch(`${app.url}${path}`, { ...options, headers: requestHeaders });
      if (options.method === 'POST') {
        if (rejected) {
          assert.equal(response.status, 409);
          return response;
        }
        assert.equal(response.status, 200);
        await response.json();
        if (transport === 'lost') throw new Error('Synthetic lost saved response');
        if (transport === 'malformed-4xx-json') return Response.json({}, { status: 409 });
        if (transport === 'malformed-4xx-body') return new Response('Synthetic unreadable response', { status: 400 });
        return Response.json({ task: { id: task.id }, undoReceipt: { kind: 'not-an-undo' } });
      }
      return response;
    };
    await button.fire('click');
    await button.fire('click');
    const stableRequest = ui.run(`taskUndoRequests.get(${JSON.stringify(task.history.at(-1).id)}).requestId`);
    ui.run('renderActivity()');
    assert.match(ui.query('#activity-list').textContent, rejected ? /Undo was rejected/ : /outcome is unknown/);
    assert.doesNotMatch(ui.query('#activity-list').textContent, rejected ? /outcome is unknown/ : /Undo was rejected/);
    assert.equal(ui.query('#activity-list').querySelectorAll('[data-undo-event]').length, 0);
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
    const check = ui.query('#activity-list').querySelectorAll('[data-undo-check]')[0];
    if (rejected) {
      assert.equal(check, undefined, 'the initial structured rejection is definitive, not an unknown outcome');
    } else {
      await check.fire('click');
      assert.match(ui.query('#activity-list').textContent, /Undo was recorded at revision 3/);
    }
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1, 'reconciliation must never repost');
    assert.equal(ui.run(`taskUndoRequests.get(${JSON.stringify(task.history.at(-1).id)}).requestId`), stableRequest);
    const saved = await (await fetch(`${app.url}/api/state`, { headers })).json();
    const current = saved.tasks.find(item => item.id === task.id);
    assert.equal(current.status, rejected ? 'done' : 'next');
    assert.equal(current.history.filter(event => event.kind === 'undo-applied').length, rejected ? 0 : 1);
  }
});

test('rejected undo is not claimed successful and unconfirmed read-only checks never unlock blind replay', async () => {
  for (const rejected of [true, false]) {
    const { ui, button } = await setupUndoUi();
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      return rejected ? Response.json({ error: 'Synthetic revision conflict' }, { status: 409 }) : Response.json({});
    };
    await button.fire('click');
    await button.fire('click');
    assert.match(ui.query('#activity-list').textContent, rejected ? /Undo was rejected/ : /outcome is unknown/);
    assert.doesNotMatch(ui.query('#activity-list').textContent, /Undo recorded at/);
    if (!rejected) {
      ui.run('refreshState = async () => {};');
      await ui.query('#activity-list').querySelectorAll('[data-undo-check]')[0].fire('click');
      assert.match(ui.query('#activity-list').textContent, /remains unknown.*No matching saved receipt/);
    }
    assert.equal(ui.requests.length, 1);
  }
});

test('wrong undo receipt identity, revision and status never claim a reversal or permit another mutation', async () => {
  for (const mismatch of [{ taskId: randomUUID() }, { eventId: randomUUID() }, { requestId: randomUUID() }, { requestRevision: 1 }, { appliedRevision: 4 }, { status: 'queued' }, { id: '-'.repeat(36) }]) {
    const { ui, task, button } = await setupUndoUi();
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      const body = JSON.parse(options.body);
      return Response.json({
        task: { id: task.id },
        undoReceipt: { id: randomUUID(), kind: 'task-undo', status: 'applied', taskId: task.id,
          eventId: body.eventId, requestId: body.requestId, requestRevision: body.revision, appliedRevision: 3, ...mismatch }
      });
    };
    await button.fire('click');
    await button.fire('click');
    assert.match(ui.query('#activity-list').textContent, /outcome is unknown/);
    assert.equal(ui.requests.length, 1);
  }
});

test('malformed metric records do not adopt a separate receipt or clear the pending identity', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-ui-malformed-metrics-'));
  const app = await startServer({ dataDir, port: 0, workerIntervalMs: 0 });
  try {
    const headers = { Origin: app.url, 'X-Esquie-Access': app.accessToken, 'Content-Type': 'application/json' };
    const initial = await (await fetch(`${app.url}/api/state`, { headers })).json();
    headers['X-Esquie-CSRF'] = initial.csrfToken;
    const created = await fetch(`${app.url}/api/records`, {
      method: 'POST', headers, body: JSON.stringify({ category: 'account', title: 'Synthetic account' })
    });
    const account = (await created.json()).record;
    const state = await (await fetch(`${app.url}/api/state`, { headers })).json();
    const sendToServer = async (path, options) => {
      const requestHeaders = new Headers(options.headers);
      requestHeaders.set('Origin', app.url);
      return fetch(`${app.url}${path}`, { ...options, headers: requestHeaders });
    };
  for (const malformed of ['missing-metric', 'malformed-history']) {
    const storage = new Map();
    const ui = await setup({ storage });
    ui.context.loadedState = state;
    ui.run(`workspace = loadedState; renderRecords(); accessToken = ${JSON.stringify(app.accessToken)}; csrfToken = ${JSON.stringify(headers['X-Esquie-CSRF'])};`);
    const form = ui.query('#account-metric-form');
    Object.assign(form.elements.accountId, { value: account.id });
    form.elements.label.value = 'Synthetic measure';
    form.elements.value.value = '0';
    form.elements.unit.value = '';
    form.elements.date.value = '';
    form.elements.confirmOwnerEntered.checked = true;
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (options.method !== 'POST') return sendToServer(path, options);
      const body = JSON.parse(options.body);
      const metric = {
        id: randomUUID(), ...body, requestRevision: body.revision, appliedRevision: body.revision + 1,
        createdAt: '2026-03-01T10:00:00.000Z', provenance: 'owner-provided-unverified'
      };
      return Response.json({
        record: {
          ...account, revision: 2,
          metrics: malformed === 'missing-metric' ? [] : [metric],
          history: malformed === 'malformed-history' ? null : []
        },
        metric
      }, { status: 201 });
    };
    await form.fire('submit');
    assert.match(ui.query('#account-metric-status').textContent, /outcome is unknown/);
    assert.equal(ui.run(`workspace.records.find(record => record.id === ${JSON.stringify(account.id)}).revision`), 1, 'an inconsistent response must not be adopted');
    assert.equal(storage.size, 1, 'the original intent remains available for read-only inspection');
    await ui.query('#account-metric-check').fire('click');
    assert.match(ui.query('#account-metric-status').textContent, /remains unknown/);
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(ui.run(`workspace.records.find(record => record.id === ${JSON.stringify(account.id)}).revision`), 1);
  }
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('inconsistent SSP records remain unresolved, while valid later-revision receipts are accepted', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-ui-malformed-ssps-'));
  const app = await startServer({ dataDir, port: 0, workerIntervalMs: 0 });
  try {
    const headers = { Origin: app.url, 'X-Esquie-Access': app.accessToken, 'Content-Type': 'application/json' };
    const initial = await (await fetch(`${app.url}/api/state`, { headers })).json();
    headers['X-Esquie-CSRF'] = initial.csrfToken;
    const created = await fetch(`${app.url}/api/records`, {
      method: 'POST', headers, body: JSON.stringify({ category: 'account', title: 'Synthetic account' })
    });
    const account = (await created.json()).record;
    const state = await (await fetch(`${app.url}/api/state`, { headers })).json();
    const sendToServer = async (path, options) => {
      const requestHeaders = new Headers(options.headers);
      requestHeaders.set('Origin', app.url);
      return fetch(`${app.url}${path}`, { ...options, headers: requestHeaders });
    };
  for (const malformed of ['missing-account-ids', 'missing-history-receipt', 'mismatched-current-title', 'mismatched-current-account-ids']) {
    const storage = new Map();
    const ui = await setup({ storage });
    ui.context.loadedState = state;
    ui.run(`workspace = loadedState; renderRecords(); accessToken = ${JSON.stringify(app.accessToken)}; csrfToken = ${JSON.stringify(headers['X-Esquie-CSRF'])};`);
    await ui.query('#new-ssp').fire('click');
    const form = ui.query('#ssp-form');
    form.elements.title.value = 'Synthetic SSP';
    form.elements.accountIds.children.find(option => option.value === account.id).selected = true;
    await form.fire('input');
    form.elements.confirmOwnerEntered.checked = true;
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (options.method !== 'POST') return sendToServer(path, options);
      const body = JSON.parse(options.body);
      const receipt = {
        id: randomUUID(), kind: 'local-ssp-saved', requestId: body.requestId, requestRevision: body.revision,
        appliedRevision: body.revision + 1, title: body.title, accountIds: body.accountIds,
        createdAt: '2026-03-01T10:00:00.000Z', provenance: 'owner-provided-unverified'
      };
      const record = {
        id: path.split('/').at(-1), category: 'ssp',
        title: malformed === 'mismatched-current-title' ? 'Other current title' : body.title, revision: 1,
        accountIds: malformed === 'missing-account-ids' ? undefined :
          malformed === 'mismatched-current-account-ids' ? [] : body.accountIds,
        history: malformed === 'missing-history-receipt' ? [] : [receipt],
        provenance: 'owner-provided-unverified'
      };
      return Response.json({ record, receipt }, { status: 201 });
    };
    await form.fire('submit');
    assert.match(ui.query('#ssp-status').textContent, /outcome unknown/);
    assert.equal(ui.run('workspace.records.some(record => record.category === "ssp")'), false);
    assert.equal(storage.size, 1);
    await ui.query('#ssp-check').fire('click');
    assert.match(ui.query('#ssp-status').textContent, /remains unknown/);
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
  }

  const id = randomUUID();
  const requestId = randomUUID();
  const originalBody = { title: 'Original SSP title', accountIds: [account.id], revision: 0, requestId, confirmOwnerEntered: true };
  const originalResponse = await sendToServer(`/api/portfolio/ssps/${id}`, {
    method: 'POST', headers, body: JSON.stringify(originalBody)
  });
  assert.equal(originalResponse.status, 201);
  const original = await originalResponse.json();
  const laterResponse = await sendToServer(`/api/portfolio/ssps/${id}`, {
    method: 'POST', headers, body: JSON.stringify({
      title: 'Later SSP title', accountIds: [], revision: 1, requestId: randomUUID(), confirmOwnerEntered: true
    })
  });
  assert.equal(laterResponse.status, 201);
  const currentState = await (await sendToServer('/api/state', { method: 'GET', headers })).json();
  const storage = new Map([['esquie-local-ssp-editor-v1', JSON.stringify({
    id, revision: 0, title: original.receipt.title, accountIds: [...original.receipt.accountIds],
    savedTitle: original.receipt.title, savedAccountIds: [...original.receipt.accountIds], body: originalBody
  })]]);
  const ui = await setup({ storage });
  ui.context.loadedState = currentState;
  ui.run('workspace = loadedState; renderRecords();');
  ui.run(`accessToken = ${JSON.stringify(app.accessToken)}; csrfToken = ${JSON.stringify(headers['X-Esquie-CSRF'])};`);
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    return sendToServer(path, options);
  };
  await ui.query('#ssp-check').fire('click');
  assert.match(ui.query('#ssp-status').textContent, /confirmed saved locally/);
  assert.equal(ui.run('workspace.records.find(record => record.category === "ssp").title'), 'Later SSP title');
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 0, 'later-revision reconciliation remains read-only');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('account New, Edit and Cancel controls work after SSP initialization and pending saves block target switches', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-ui-account-controller-'));
  const app = await startServer({ dataDir, port: 0, workerIntervalMs: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const headers = { Origin: app.url, 'X-Esquie-Access': app.accessToken, 'Content-Type': 'application/json' };
  const state = async () => (await fetch(`${app.url}/api/state`, { headers })).json();
  headers['X-Esquie-CSRF'] = (await state()).csrfToken;
  const create = async title => (await (await fetch(`${app.url}/api/records`, {
    method: 'POST', headers, body: JSON.stringify({ category: 'account', title })
  })).json()).record;
  const accounts = [await create('Synthetic account A'), await create('Synthetic account B')];
  const ui = await setup();
  ui.context.loadedState = await state();
  ui.run(`workspace = loadedState; renderRecords(); accessToken = ${JSON.stringify(app.accessToken)}; csrfToken = ${JSON.stringify(headers['X-Esquie-CSRF'])};`);
  const form = ui.query('#account-form');
  const displayedAccounts = [...accounts].reverse();
  const editButtons = descendants(ui.query('#account-list')).filter(element =>
    element.tagName === 'BUTTON' && element.textContent === 'Edit account');
  assert.equal(editButtons.length, 2);
  await editButtons[0].fire('click');
  assert.equal(form.dataset.recordId, displayedAccounts[0].id);
  form.elements.note.value = 'Unsaved owner note';
  await ui.query('#new-account').fire('click');
  assert.equal(form.dataset.recordId, undefined);
  assert.equal(form.elements.note.value, '', 'the explicit New action completes normally');
  await editButtons[1].fire('click');
  assert.equal(form.dataset.recordId, displayedAccounts[1].id);
  form.elements.note.value = 'Discarded edit';
  await ui.query('#account-cancel-edit').fire('click');
  assert.equal(form.dataset.recordId, undefined);
  assert.equal(ui.query('#account-cancel-edit').hidden, true);

  await editButtons[0].fire('click');
  form.elements.note.value = 'Pending save text';
  const response = deferred();
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    const requestHeaders = new Headers(options.headers);
    requestHeaders.set('Origin', app.url);
    const result = await fetch(`${app.url}${path}`, { ...options, headers: requestHeaders });
    if (options.method === 'PATCH') {
      await response.promise;
      return result;
    }
    return result;
  };
  const pending = form.fire('submit');
  await ui.query('#new-account').fire('click');
  await editButtons[1].fire('click');
  await ui.query('#account-cancel-edit').fire('click');
  assert.equal(form.dataset.recordId, displayedAccounts[0].id, 'New, Edit and Cancel cannot switch an in-flight save target');
  assert.equal(form.elements.note.value, 'Pending save text', 'the pending text is retained');
  assert.match(ui.query('#notice').textContent, /Wait for the account save to finish/);
  response.resolve(Response.json({ record: { ...displayedAccounts[0], note: 'Pending save text', revision: 2 } }, { status: 200 }));
  await pending;
  assert.equal(ui.requests.filter(request => request.method === 'PATCH').length, 1);
});

test('identical metric review cannot carry permission across changed accounts, inputs or revisions', async () => {
  const ui = await setup();
  const metric = { id: randomUUID(), label: 'My sample', value: '1.00', unit: '', date: '', createdAt: '2026-03-01T10:00:00Z' };
  const first = { id: randomUUID(), category: 'account', title: 'Identical label', revision: 2, metrics: [metric] };
  const second = { ...first, id: randomUUID(), metrics: [{ ...metric, id: randomUUID() }] };
  ui.context.repeatAccounts = [first, second];
  ui.run('workspace.records = repeatAccounts; renderRecords();');
  const form = ui.query('#account-metric-form');
  const repeat = ui.query('#account-metric-repeat');
  for (const [name, value] of Object.entries({ accountId: first.id, label: metric.label, value: metric.value, unit: '', date: '' })) form.elements[name].value = value;
  form.elements.confirmOwnerEntered.checked = true;
  await form.fire('submit');
  assert.equal(ui.requests.length, 0);
  assert.match(ui.query('#account-metric-status').textContent, new RegExp(metric.id));
  assert.match(ui.query('#account-metric-status').textContent, /1\.00/);
  assert.equal(repeat.hidden, false);
  form.elements.accountId.value = second.id;
  await repeat.fire('click');
  assert.equal(ui.requests.length, 0);
  assert.match(ui.query('#account-metric-status').textContent, /review changed or is stale/);
  form.elements.accountId.value = first.id;
  await form.fire('submit');
  ui.run('workspace.records[0].revision++; renderRecords();');
  assert.equal(repeat.hidden, true);
  await repeat.fire('click');
  assert.equal(ui.requests.length, 0);
  await form.fire('submit');
  form.elements.value.value = '1.000';
  await form.fire('input');
  assert.equal(repeat.hidden, true);
  await repeat.fire('click');
  assert.equal(ui.requests.length, 0, 'changing scale does not preserve old identical-repeat permission');
});

test('separately confirmed identical metric saves preserve request identity through unknown receipts and reload, never auto-repeat', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-ui-separate-metric-'));
  const app = await startServer({ dataDir, port: 0, workerIntervalMs: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const headers = { Origin: app.url, 'X-Esquie-Access': app.accessToken, 'Content-Type': 'application/json' };
  const state = async () => (await fetch(`${app.url}/api/state`, { headers })).json();
  headers['X-Esquie-CSRF'] = (await state()).csrfToken;
  const send = async (path, body, method = 'POST') => fetch(`${app.url}${path}`, { method, headers, body: JSON.stringify(body) });
  for (const outcome of ['lost', 'malformed-4xx', 'stale', 'refresh-failed']) {
    const account = (await (await send('/api/records', { category: 'account', title: 'Synthetic repeat observation account' })).json()).record;
    const initialBody = { label: 'My precise observation', value: '1.00', unit: '', date: '', revision: account.revision, requestId: randomUUID(), confirmOwnerEntered: true };
    const original = await (await send(`/api/records/${account.id}/metrics`, initialBody)).json();
    const values = new Map();
    const storage = { getItem: key => values.get(key) || '', setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const ui = await setup({ storage });
    const hydrate = async instance => {
      instance.context.loadedRepeatState = await state();
      instance.run(`workspace = loadedRepeatState; accessToken = ${JSON.stringify(app.accessToken)}; csrfToken = ${JSON.stringify(headers['X-Esquie-CSRF'])}; renderRecords();`);
    };
    await hydrate(ui);
    const form = ui.query('#account-metric-form');
    for (const [name, value] of Object.entries({ accountId: account.id, label: initialBody.label, value: initialBody.value, unit: '', date: '' })) form.elements[name].value = value;
    form.elements.confirmOwnerEntered.checked = true;
    await form.fire('submit');
    await form.fire('submit');
    assert.equal(ui.requests.length, 0, 'primary submits only show the existing exact observation');
    assert.match(ui.query('#account-metric-status').textContent, new RegExp(original.metric.id));
    if (outcome === 'stale') {
      assert.equal((await send(`/api/records/${account.id}`, { category: 'account', title: 'Intervening owner edit', revision: original.record.revision }, 'PATCH')).status, 200);
    }
    const reply = deferred();
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (outcome === 'refresh-failed' && options.method !== 'POST') throw new Error('Synthetic display unavailable');
      const browserHeaders = new Headers(options.headers);
      browserHeaders.set('Origin', app.url);
      const response = await fetch(`${app.url}${path}`, { ...options, headers: browserHeaders });
      if (options.method === 'POST') {
        await reply.promise;
        if (outcome === 'lost') { await response.json(); throw new Error('Synthetic lost committed repeat receipt'); }
        if (outcome === 'malformed-4xx') { await response.json(); return Response.json({}, { status: 409 }); }
      }
      return response;
    };
    const repeat = ui.query('#account-metric-repeat');
    const pending = repeat.fire('click');
    await repeat.fire('click');
    await form.fire('submit');
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
    const submitted = JSON.parse(ui.requests[0].body);
    assert.equal(ui.requests[0].path, `/api/records/${account.id}/metrics`);
    assert.equal(submitted.revision, original.record.revision);
    assert.equal(submitted.duplicateOf, original.metric.id);
    assert.equal(submitted.confirmSeparateObservation, true);
    assert.equal(submitted.value, '1.00');
    reply.resolve();
    await pending;
    const outcomeMessage = ui.query('#account-metric-status').textContent;
    await repeat.fire('click');
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
    if (outcome === 'lost' || outcome === 'malformed-4xx') {
      assert.match(ui.query('#account-metric-status').textContent, /outcome is unknown/);
      const reload = await setup({ storage });
      await hydrate(reload);
      assert.equal(reload.query('#account-metric-repeat').hidden, true, 'unknown saved repeat permission is not a new repeat action');
      reload.context.fetch = async (path, options) => {
        reload.requests.push({ path, ...options });
        const browserHeaders = new Headers(options.headers);
        browserHeaders.set('Origin', app.url);
        return fetch(`${app.url}${path}`, { ...options, headers: browserHeaders });
      };
      await reload.query('#account-metric-form').fire('submit');
      await reload.query('#account-metric-repeat').fire('click');
      assert.equal(reload.requests.length, 0);
      await reload.query('#account-metric-check').fire('click');
      assert.match(reload.query('#account-metric-status').textContent, /confirmed saved locally/);
      assert.equal(reload.requests.filter(request => request.method === 'POST').length, 0);
      assert.equal(reload.query('#account-metric-form').elements.confirmOwnerEntered.checked, false);
      assert.match(reload.query('#account-list').textContent, /Separately confirmed observation/);
    } else assert.match(outcomeMessage, outcome === 'stale' ? /Metric was rejected/ : /confirmed saved locally; display refresh failed/);
    const current = (await state()).records.find(record => record.id === account.id);
    assert.equal(current.metrics.length, outcome === 'stale' ? 1 : 2);
    assert.deepEqual(current.metrics[0], original.metric);
    if (outcome !== 'stale') assert.equal(current.metrics[1].duplicateOf, original.metric.id);
  }
});

test('local metric matrix uses exact label/unit series, latest recorded values and explicit unknowns without name merging', async () => {
  const ui = await setup();
  const idA = randomUUID();
  const idB = randomUUID();
  ui.context.matrixRecords = [
    { id: idA, category: 'account', title: '<img onerror="fakeCommand()"> Same name', metrics: [
      { label: 'My sample', unit: 'units', value: '9', date: '2099-01-01', createdAt: '2026-01-01T10:00:00Z' },
      { label: 'My sample', unit: 'units', value: '0', date: '', createdAt: '2026-01-02T10:00:00Z' }
    ] },
    { id: idB, category: 'account', title: '<img onerror="fakeCommand()"> Same name', metrics: [
      { label: 'My sample', unit: 'other units', value: '7', date: '', createdAt: '2026-01-03T10:00:00Z' }
    ] }
  ];
  ui.run('workspace.records = matrixRecords; renderRecords();');
  await ui.navigation('heatmap').fire('click');
  assert.equal(ui.navigation('heatmap')['aria-current'], 'page');
  assert.equal(ui.navigation('ssps')['aria-current'], 'false');
  const host = ui.query('#account-heatmap');
  assert.match(host.textContent, new RegExp(idA));
  assert.match(host.textContent, new RegExp(idB));
  assert.match(host.textContent, /no conversion, thresholds or health colors/);
  assert.match(host.textContent, /<img onerror="fakeCommand\(\)"> Same name/);
  assert.equal(ui.query('#breadcrumb').textContent, 'Accounts Heatmap — local metric matrix');
  const table = host.children.find(element => element.tagName === 'TABLE');
  const rows = table.children.find(element => element.tagName === 'TBODY').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children.filter(element => element.tagName === 'TD').some(cell => cell.children[0]?.textContent === '0'), true);
  assert.equal(rows[0].textContent.includes('2099-01-01'), false, 'a later observed date is not mistaken for latest locally recorded');
  assert.match(rows[1].textContent, /Unknown: no owner-entered observation/);
  ui.context.matrixRecords = Array.from({ length: 51 }, (_, index) => ({
    id: randomUUID(), category: 'account', title: `Fake ${index}`, metrics: index ? [] : Array.from({ length: 21 }, (_, column) => ({ label: `Fake metric ${column}`, unit: '', value: '0' }))
  }));
  ui.run('workspace.records = matrixRecords; renderRecords();');
  assert.match(host.textContent, /Showing 50 of 51 accounts and 20 of 21/);
});

test('real SSP form preserves explicit IDs across unknown outcome/reload and never blindly resubmits', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-ui-local-ssps-'));
  const app = await startServer({ dataDir, port: 0, workerIntervalMs: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const headers = { Origin: app.url, 'X-Esquie-Access': app.accessToken, 'Content-Type': 'application/json' };
  const state = async () => (await fetch(`${app.url}/api/state`, { headers })).json();
  headers['X-Esquie-CSRF'] = (await state()).csrfToken;
  const send = async (path, body) => fetch(`${app.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const accounts = [];
  for (let index = 0; index < 2; index++) accounts.push((await (await send('/api/records', { category: 'account', title: 'Identical fake account' })).json()).record);
  for (const outcome of ['lost', 'malformed-4xx', 'rejected', 'refresh-failed']) {
    const values = new Map();
    const storage = { getItem: key => values.get(key) || '', setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const ui = await setup({ storage });
    const hydrate = async instance => {
      instance.context.loadedSspState = await state();
      instance.run(`workspace = loadedSspState; accessToken = ${JSON.stringify(app.accessToken)}; csrfToken = ${JSON.stringify(headers['X-Esquie-CSRF'])}; renderRecords(); navigate('ssps');`);
    };
    await hydrate(ui);
    const form = ui.query('#ssp-form');
    assert.equal(form.elements.title.disabled, true, 'a new local ID must be deliberately allocated first');
    await ui.query('#new-ssp').fire('click');
    const id = form.elements.recordId.value;
    assert.ok(id);
    form.elements.title.value = `<img onerror="fakeCommand()"> ${outcome}`;
    const option = form.elements.accountIds.children.find(item => item.value === accounts[0].id);
    option.selected = true;
    await form.fire('input');
    form.elements.confirmOwnerEntered.checked = true;
    if (outcome === 'rejected') {
      assert.equal((await send(`/api/portfolio/ssps/${id}`, {
        title: 'Concurrent local record', accountIds: [], revision: 0, requestId: randomUUID(), confirmOwnerEntered: true
      })).status, 201);
    }
    const reply = deferred();
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (outcome === 'refresh-failed' && options.method !== 'POST') throw new Error('Synthetic display refresh unavailable');
      const browserHeaders = new Headers(options.headers);
      browserHeaders.set('Origin', app.url);
      const response = await fetch(`${app.url}${path}`, { ...options, headers: browserHeaders });
      if (options.method === 'POST') {
        await reply.promise;
        if (outcome === 'lost') { await response.json(); throw new Error('Synthetic lost committed SSP receipt'); }
        if (outcome === 'malformed-4xx') { await response.json(); return Response.json({}, { status: 409 }); }
      }
      return response;
    };
    const pending = form.fire('submit');
    await form.fire('submit');
    await ui.query('#new-ssp').fire('click');
    assert.equal(form.elements.recordId.value, id, 'pending work cannot silently allocate a replacement ID');
    reply.resolve();
    await pending;
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
    if (outcome === 'lost' || outcome === 'malformed-4xx') {
      assert.match(ui.query('#ssp-status').textContent, /outcome unknown/);
      const original = JSON.parse(ui.requests[0].body);
      assert.deepEqual(original.accountIds, [accounts[0].id]);
      const reload = await setup({ storage });
      await hydrate(reload);
      const restored = reload.query('#ssp-form');
      assert.equal(restored.elements.recordId.value, id);
      assert.equal(restored.elements.title.disabled, true);
      assert.match(reload.query('#ssp-status').textContent, new RegExp(original.requestId));
      reload.context.fetch = async (path, options) => {
        reload.requests.push({ path, ...options });
        const browserHeaders = new Headers(options.headers);
        browserHeaders.set('Origin', app.url);
        return fetch(`${app.url}${path}`, { ...options, headers: browserHeaders });
      };
      await restored.fire('submit');
      assert.equal(reload.requests.length, 0);
      await reload.query('#ssp-check').fire('click');
      assert.match(reload.query('#ssp-status').textContent, /confirmed saved locally/);
      assert.equal(reload.requests.filter(request => request.method === 'POST').length, 0);
      assert.equal(restored.elements.confirmOwnerEntered.checked, false);
      assert.match(reload.query('#ssp-list').textContent, /<img onerror="fakeCommand\(\)">/);
      await restored.fire('submit');
      assert.equal(reload.requests.filter(request => request.method === 'POST').length, 0);
    } else assert.match(ui.query('#ssp-status').textContent, outcome === 'rejected' ? /save rejected/ : /confirmed saved locally; display refresh failed/);
    const saved = (await state()).records.find(record => record.id === id);
    assert.equal(saved.history.length, 1);
    assert.deepEqual(saved.accountIds, outcome === 'rejected' ? [] : [accounts[0].id]);
    if (outcome === 'refresh-failed') {
      form.elements.title.value = 'Owner explicitly revised this SSP';
      for (const choice of form.elements.accountIds.children) choice.selected = choice.value === accounts[1].id;
      await form.fire('input');
      form.elements.confirmOwnerEntered.checked = true;
      ui.context.fetch = async (path, options) => {
        ui.requests.push({ path, ...options });
        const browserHeaders = new Headers(options.headers);
        browserHeaders.set('Origin', app.url);
        return fetch(`${app.url}${path}`, { ...options, headers: browserHeaders });
      };
      await form.fire('submit');
      const current = (await state()).records.find(record => record.id === id);
      assert.equal(current.revision, 2);
      assert.deepEqual(current.accountIds, [accounts[1].id]);
      assert.deepEqual(current.history.slice(0, -1), saved.history);
      assert.equal(ui.requests.filter(request => request.method === 'POST').length, 2);
      assert.equal(form.elements.recordId.value, id, 'editing preserves the local SSP identity rather than creating another record');
    }
  }
});

test('SSP form fails closed on identity-storage failure and blocks unconfirmed receipts', async () => {
  for (const mode of ['unavailable-storage', 'missing-receipt']) {
    const values = new Map();
    const storage = {
      getItem: key => values.get(key) || '', removeItem: key => values.delete(key),
      setItem: (key, value) => { if (mode === 'unavailable-storage') throw new Error('Synthetic storage unavailable'); values.set(key, value); }
    };
    const ui = await setup({ storage });
    ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    await ui.query('#new-ssp').fire('click');
    const form = ui.query('#ssp-form');
    form.elements.title.value = 'Synthetic SSP';
    form.elements.confirmOwnerEntered.checked = true;
    ui.context.fetch = async (path, options) => { ui.requests.push({ path, ...options }); return Response.json({}, { status: 201 }); };
    await form.fire('submit');
    await form.fire('submit');
    assert.equal(ui.requests.length, mode === 'unavailable-storage' ? 0 : 1);
    assert.match(ui.query('#ssp-status').textContent, mode === 'unavailable-storage' ? /nothing was submitted/ : /outcome unknown/);
    assert.equal(ui.query('#new-ssp').disabled, true);
  }
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

test('completed-work real UI survives restart, composes exact account/search filters, and keeps evidence inert without mutating tasks', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-completed-work-ui-'));
  let now = new Date('2026-03-01T10:00:00.000Z');
  let app = await startServer({ dataDir, port: 0, workerIntervalMs: 0, clock: () => now });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const state = async () => (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  let current = await state();
  const headers = { Origin: app.url, 'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': current.csrfToken, 'Content-Type': 'application/json' };
  const request = async (path, body, method = 'POST') => fetch(`${app.url}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const accountA = (await (await request('/api/records', { category: 'account', title: 'Same local label' })).json()).record;
  const accountB = (await (await request('/api/records', { category: 'account', title: 'Same local label' })).json()).record;
  let completed = (await (await request('/api/tasks', {
    title: '<img src=x onerror=alert(1)> Synthetic completion', details: 'Owner-provided detail',
    accountId: accountA.id
  })).json()).task;
  await request(`/api/tasks/${completed.id}/conversation`, { text: 'Owner-only completion note needle.' });
  await request(`/api/tasks/${completed.id}/evidence`, {
    title: 'Synthetic proof', url: 'https://example.invalid/inert-proof', note: '<script>not executable</script>'
  });
  now = new Date('2026-03-31T12:00:00.000Z');
  completed = (await (await request(`/api/tasks/${completed.id}`, { status: 'done', revision: completed.revision }, 'PATCH')).json()).task;
  assert.equal(completed.completedAt, now.toISOString());
  const second = (await (await request('/api/tasks', { title: 'Different account completion', status: 'done', accountId: accountB.id })).json()).task;
  let reopened = (await (await request('/api/tasks', { title: 'Explicitly reopened task' })).json()).task;
  reopened = (await (await request(`/api/tasks/${reopened.id}`, { status: 'done', revision: reopened.revision }, 'PATCH')).json()).task;
  reopened = (await (await request(`/api/tasks/${reopened.id}`, { status: 'doing', revision: reopened.revision }, 'PATCH')).json()).task;
  assert.equal(reopened.completedAt, null);
  await app.close();
  app = await startServer({ dataDir, port: 0, workerIntervalMs: 0, clock: () => now });
  current = await state();
  headers.Origin = app.url;
  headers['X-Esquie-Access'] = app.accessToken;
  headers['X-Esquie-CSRF'] = current.csrfToken;
  const savedTasks = JSON.stringify(current.tasks);
  const uiState = structuredClone(current);
  const uiEvidence = uiState.tasks.find(task => task.id === completed.id).evidence;
  uiEvidence[0].provenance = 'owner-provided-unverified';
  uiEvidence.push(
    { title: 'Synthetic authorized-source evidence', note: 'Untrusted source text', provenance: 'authorized-source-untrusted-evidence' },
    { title: 'Synthetic unrecorded evidence', note: 'Unknown provenance' }
  );

  const ui = await setup();
  freezeUiDate(ui, now);
  ui.context.completedWorkState = { ...uiState, profile: { timezone: 'UTC' } };
  ui.run('workspace = completedWorkState; renderTasks();');
  const requestsBeforeView = ui.requests.length;
  await ui.navigation('completed-work').fire('click');
  assert.equal(ui.context.location.hash, '#completed-work');
  assert.equal(ui.section('completed-work').hidden, false);
  assert.equal(ui.section('board').hidden, true);
  assert.equal(ui.area('work')['aria-current'], 'page');
  assert.equal(ui.navigation('completed-work')['aria-current'], 'page');
  const history = ui.query('#completed-work-list');
  assert.match(history.textContent, /Synthetic completion/);
  assert.match(history.textContent, new RegExp(accountA.id));
  assert.match(history.textContent, /Created \(UTC\)/);
  assert.match(history.textContent, /Completed \(UTC\)/);
  assert.match(history.textContent, /Inert evidence/);
  assert.match(history.textContent, /2026-03-31T12:00:00.000Z/);
  assert.doesNotMatch(history.textContent, /Explicitly reopened task/);
  assert.match(history.textContent, /Owner-provided · unverified/);
  assert.match(history.textContent, /Authorized-source evidence · untrusted and unverified/);
  assert.match(history.textContent, /Provenance unrecorded · unverified/);
  assert.equal(descendants(history).some(element => ['IMG', 'SCRIPT', 'A'].includes(element.tagName)), false);
  assert.match(history.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(history.textContent, /<script>not executable<\/script>/);

  const search = ui.query('#completed-work-search');
  search.value = 'Synthetic ';
  await search.fire('input');
  assert.equal(search.value, 'Synthetic ');
  assert.equal(ui.query('#task-search').value, 'Synthetic ');
  assert.match(history.textContent, /Synthetic completion/);
  search.value += 'completion';
  await search.fire('input');
  assert.equal(search.value, 'Synthetic completion');
  assert.equal(ui.query('#task-search').value, 'Synthetic completion');
  assert.match(history.textContent, /Synthetic completion/);
  search.value = 'completion note needle';
  await search.fire('input');
  assert.equal(ui.query('#task-search').value, 'completion note needle');
  assert.match(history.textContent, /Synthetic completion/);
  const accountFilter = ui.query('#completed-work-account-filter');
  accountFilter.value = accountB.id;
  await accountFilter.fire('change');
  assert.equal(ui.query('#task-account-filter').value, accountB.id);
  assert.match(ui.query('#completed-work-status').textContent, /^0 completed tasks/);
  accountFilter.value = accountA.id;
  await accountFilter.fire('change');
  assert.match(history.textContent, /Synthetic completion/);
  assert.doesNotMatch(history.textContent, /Different account completion/);
  ui.query('#completed-work-period').value = 'last30';
  await ui.query('#completed-work-period').fire('change');
  assert.match(history.textContent, /Synthetic completion/);
  ui.context.completedWorkState.profile.timezone = 'Not/A_Timezone';
  ui.run('renderTasks();');
  assert.match(ui.query('#completed-work-status').textContent, /Unavailable: Set a valid owner timezone/);
  assert.equal(history.textContent.includes('Synthetic completion'), false);

  ui.context.completedWorkState.profile.timezone = 'UTC';
  ui.run('renderTasks();');
  ui.query('#show-done').checked = true;
  ui.run('renderTasks(); navigate("board");');
  const card = descendants(ui.query('#task-list')).find(element => element.className === 'task-card' && element.dataset.taskId === completed.id);
  assert.ok(card);
  const reopenControl = descendants(card).find(element => element.dataset.taskControl === 'complete');
  assert.equal(reopenControl?.['aria-label'], 'Reopen task');
  assert.equal(ui.requests.length, requestsBeforeView, 'navigation, filtering and rendering issue no mutation requests');
  assert.equal(JSON.stringify((await state()).tasks), savedTasks);
  assert.equal(current.tasks.find(task => task.id === second.id).status, 'done');
});

function deferred() {
  let resolve;
  const promise = new Promise(finish => { resolve = finish; });
  return { promise, resolve };
}

function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }

function dateKeyInTimezone(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(instant);
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${date.year}-${date.month}-${date.day}`;
}

function freezeUiDate(ui, instant) {
  ui.context.fixedInstant = instant.valueOf();
  const NativeDate = Date;
  ui.context.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [ui.context.fixedInstant])); }
    static now() { return ui.context.fixedInstant; }
  };
}

function genericReceipt(request, status = 'queued') {
  const body = JSON.parse(request.body);
  return {
    job: {
      id: randomUUID(), requestId: body.requestId, kind: body.kind, taskId: body.taskId || null, status,
      payload: body.kind === 'meeting_notes'
        ? { notes: body.notes.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim() } : {}
    }
  };
}

async function waitForQueueDispatch(ui) {
  const deadline = Date.now() + 5000;
  while (!ui.requests.some(request => request.method === 'POST') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(ui.requests.some(request => request.method === 'POST'), 'the guarded action must eventually dispatch');
}

test('generic action handlers serialize all queue kinds and never turn acceptance plus refresh failure into rejection', async () => {
  for (const kind of ['task_summary', 'document', 'backup', 'source_refresh', 'meeting_notes']) {
    const ui = await setup();
    const mutation = deferred();
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (options.method === 'POST') return mutation.promise;
      throw new Error('Synthetic display refresh failure');
    };
    ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    const form = ui.query('#meeting-form');
    form.elements.notes.value = 'Synthetic submitted meeting notes';
    const trigger = () => kind === 'meeting_notes' ? form.fire('submit') : ui.query(`#queue-${kind}`).fire('click');
    const pending = trigger();
    await trigger();
    await ui.query('#queue-backup').fire('click');
    await waitForQueueDispatch(ui);
    assert.equal(ui.requests.length, 1);
    assert.equal(form.elements.notes.disabled, true);
    form.elements.notes.value = 'Newer synthetic meeting notes retained';
    mutation.resolve(Response.json(genericReceipt(ui.requests[0]), { status: 202 }));
    await pending;
    assert.equal(form.elements.notes.value, 'Newer synthetic meeting notes retained');
    assert.equal(form.elements.notes.disabled, false);
    assert.match(ui.query('#generic-queue-status').textContent, /Accepted local job.*recorded state: queued.*not a completed result.*display refresh failed/);
    await trigger();
    await ui.query('#generic-queue-retry').fire('click');
    await ui.query('#generic-queue-new').fire('click');
    await trigger();
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
  }
});

test('unknown generic receipts block replacements and only an explicit absent-Activity check allows same-ID original-input recovery', async () => {
  for (const outcome of ['lost', 'server-error', 'malformed', 'malformed-4xx', 'unstructured-4xx', 'wrong-request', 'wrong-job', 'wrong-target', 'wrong-kind', 'wrong-state', 'wrong-notes', 'wrong-http-status']) {
    const ui = await setup();
    const form = ui.query('#meeting-form');
    form.elements.notes.value = 'Original synthetic meeting notes';
    ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {};");
    let recovered = false;
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (!options.method) return Response.json({ jobs: [] });
      if (recovered) return Response.json(genericReceipt(ui.requests.at(-1)), { status: 202 });
      if (outcome === 'lost') throw new TypeError('Synthetic lost response');
      if (outcome === 'server-error') return Response.json({ error: 'Synthetic uncertain server response' }, { status: 500 });
      if (outcome === 'malformed') return new Response('{bad', { status: 202 });
      if (outcome === 'malformed-4xx') return new Response('{bad', { status: 403 });
      if (outcome === 'unstructured-4xx') return Response.json({ message: 'Not a structured rejection' }, { status: 400 });
      const receipt = genericReceipt(ui.requests.at(-1));
      if (outcome === 'wrong-request') receipt.job.requestId = randomUUID();
      if (outcome === 'wrong-job') receipt.job.id = 'not-a-job-id';
      if (outcome === 'wrong-target') receipt.job.taskId = randomUUID();
      if (outcome === 'wrong-kind') receipt.job.kind = 'backup';
      if (outcome === 'wrong-state') receipt.job.status = 'successful';
      if (outcome === 'wrong-notes') receipt.job.payload.notes = 'Not the submitted notes';
      return Response.json(receipt, { status: outcome === 'wrong-http-status' ? 200 : 202 });
    };
    await form.fire('submit');
    assert.match(ui.query('#generic-queue-status').textContent, /outcome unknown/);
    form.elements.notes.value = 'Different synthetic notes must not be retried';
    await form.fire('submit');
    await ui.query('#generic-queue-retry').fire('click');
    assert.equal(ui.requests.length, 1);
    await ui.query('#generic-queue-inspect').fire('click');
    assert.equal(ui.query('#generic-queue-retry').hidden, false);
    recovered = true;
    await ui.query('#generic-queue-retry').fire('click');
    const writes = ui.requests.filter(request => request.method === 'POST');
    assert.equal(writes.length, 2);
    assert.equal(writes[1].body, writes[0].body);
    assert.equal(form.elements.notes.value, 'Different synthetic notes must not be retried');
    assert.match(ui.query('#generic-queue-status').textContent, /Accepted local job/);
  }
});

test('task queue responses and explicit recovery stay bound to the captured target despite later target changes', async () => {
  const ui = await setup();
  const original = randomUUID();
  const other = randomUUID();
  const mutation = deferred();
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (!options.method) return Response.json({ jobs: [] });
    return mutation.promise;
  };
  ui.context.originalTask = { id: original, title: 'Synthetic original task' };
  ui.context.otherTask = { id: other, title: 'Synthetic other task' };
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; conversationTaskId = originalTask.id;");
  const pending = ui.query('#summarize-task').fire('click');
  await ui.run('openConversation(otherTask)');
  assert.equal(ui.run('conversationTaskId'), original);
  mutation.resolve(new Response('{bad', { status: 202 }));
  await pending;
  await ui.run('openConversation(otherTask)');
  assert.equal(ui.run('conversationTaskId'), other);
  await ui.query('#generic-queue-inspect').fire('click');
  ui.run('conversationTaskId = otherTask.id;');
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (options.method === 'POST') return Response.json(genericReceipt(ui.requests.at(-1)), { status: 202 });
    throw new Error('Synthetic refresh failure');
  };
  await ui.query('#generic-queue-retry').fire('click');
  const writes = ui.requests.filter(request => request.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[1].body, writes[0].body);
  assert.equal(JSON.parse(writes[1].body).taskId, original);
  assert.equal(ui.run('conversationTaskId'), other);
});

test('Activity inspection preserves actual states and failed inspection never authorizes fresh work or replay', async () => {
  for (const status of ['queued', 'running', 'completed', 'partial', 'failed', 'interrupted']) {
    const ui = await setup();
    ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {};");
    let receipt;
    let inspectFails = false;
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (options.method === 'POST') {
        receipt = genericReceipt(ui.requests.at(-1), status);
        return Response.json(receipt, { status: ['queued', 'running'].includes(status) ? 202 : 200 });
      }
      if (inspectFails) throw new Error('Synthetic Activity failure');
      return Response.json({ jobs: [receipt.job] });
    };
    await ui.query('#queue-document').fire('click');
    assert.match(ui.query('#generic-queue-status').textContent, new RegExp(`recorded state: ${status}`));
    assert.equal(ui.query('#generic-queue-new').hidden, true);
    await ui.query('#generic-queue-inspect').fire('click');
    assert.match(ui.query('#generic-queue-status').textContent, new RegExp(`recorded state: ${status}`));
    assert.equal(ui.query('#generic-queue-new').hidden, ['queued', 'running'].includes(status));
    inspectFails = true;
    await ui.query('#generic-queue-inspect').fire('click');
    await ui.query('#generic-queue-new').fire('click');
    await ui.query('#generic-queue-retry').fire('click');
    await ui.query('#queue-document').fire('click');
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
    assert.match(ui.query('#generic-queue-status').textContent, /Activity could not confirm/);
  }
});

test('definite generic submission rejection retains notes and requires an explicit correction action, not an automatic retry', async () => {
  const ui = await setup();
  const form = ui.query('#meeting-form');
  form.elements.notes.value = 'Synthetic notes not lost on rejection';
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    return Response.json({ error: 'Synthetic approval rejection' }, { status: 403 });
  };
  await form.fire('submit');
  await form.fire('submit');
  assert.equal(ui.requests.length, 1);
  assert.match(ui.query('#generic-queue-status').textContent, /Submission rejected/);
  assert.equal(form.elements.notes.value, 'Synthetic notes not lost on rejection');
  await ui.query('#generic-queue-new').fire('click');
  await form.fire('submit');
  assert.equal(ui.requests.length, 2);
  assert.notEqual(JSON.parse(ui.requests[0].body).requestId, JSON.parse(ui.requests[1].body).requestId);
});

test('a task-specific outline action with no current target cannot fall back to a workspace-wide job', async () => {
  const ui = await setup();
  await ui.query('#summarize-task').fire('click');
  assert.equal(ui.requests.length, 0);
  assert.match(ui.query('#notice').textContent, /Select the exact task/);
});

test('only an inspected terminal request permits explicitly separate work and releases its metadata-only recovery record', async () => {
  const storage = new Map();
  const ui = await setup(storage);
  const form = ui.query('#meeting-form');
  form.elements.notes.value = 'Synthetic first meeting';
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {};");
  let receipt;
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (!options.method) return Response.json({ jobs: [receipt.job] });
    receipt = genericReceipt(ui.requests.at(-1), 'partial');
    return Response.json(receipt, { status: 200 });
  };
  await form.fire('submit');
  await ui.query('#generic-queue-new').fire('click');
  await form.fire('submit');
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
  await ui.query('#generic-queue-inspect').fire('click');
  await ui.query('#generic-queue-new').fire('click');
  assert.equal(storage.has('esquie-generic-queue-request-v1'), false);
  assert.equal(form.elements.notes.value, 'Synthetic first meeting');
  form.elements.notes.value = 'Explicit different synthetic meeting';
  await form.fire('submit');
  const writes = ui.requests.filter(request => request.method === 'POST');
  assert.equal(writes.length, 2);
  assert.notEqual(JSON.parse(writes[0].body).requestId, JSON.parse(writes[1].body).requestId);
  assert.equal(JSON.parse(writes[1].body).notes, 'Explicit different synthetic meeting');
  const reloaded = await setup(storage);
  assert.equal(reloaded.run('genericQueueAttempt.body.requestId'), JSON.parse(writes[1].body).requestId);
  assert.equal(reloaded.query('#meeting-form').elements.notes.value, '');
});

test('a structured rejection after an unknown generic submission cannot erase the earlier uncertainty or authorize a new UUID', async () => {
  const ui = await setup();
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  let retry = false;
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (!options.method) return Response.json({ jobs: [] });
    if (retry) return Response.json({ error: 'Synthetic approval revoked after original unknown submission' }, { status: 403 });
    throw new TypeError('Synthetic original response lost');
  };
  await ui.query('#queue-backup').fire('click');
  await ui.query('#generic-queue-inspect').fire('click');
  retry = true;
  await ui.query('#generic-queue-retry').fire('click');
  assert.match(ui.query('#generic-queue-status').textContent, /outcome unknown/);
  assert.equal(ui.query('#generic-queue-new').hidden, true);
  await ui.query('#generic-queue-new').fire('click');
  await ui.query('#queue-backup').fire('click');
  const writes = ui.requests.filter(request => request.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[1].body, writes[0].body);
});

test('missing or mismatched Activity evidence cannot authorize replay of a previously accepted job', async () => {
  for (const mismatch of ['missing', 'wrong-job-id', 'wrong-notes', 'malformed']) {
    const ui = await setup();
    const form = ui.query('#meeting-form');
    form.elements.notes.value = 'Synthetic captured meeting';
    ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {};");
    let receipt;
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (options.method === 'POST') {
        receipt = genericReceipt(ui.requests.at(-1), 'completed');
        return Response.json(receipt);
      }
      if (mismatch === 'malformed') return Response.json({ jobs: null });
      if (mismatch === 'missing') return Response.json({ jobs: [] });
      const changed = structuredClone(receipt.job);
      if (mismatch === 'wrong-job-id') changed.id = randomUUID();
      if (mismatch === 'wrong-notes') changed.payload.notes = 'Different synthetic notes';
      return Response.json({ jobs: [changed] });
    };
    await form.fire('submit');
    await ui.query('#generic-queue-inspect').fire('click');
    await ui.query('#generic-queue-retry').fire('click');
    await ui.query('#generic-queue-new').fire('click');
    await form.fire('submit');
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
    assert.match(ui.query('#generic-queue-status').textContent, /Activity could not confirm/);
  }
});

test('a later failed Activity inspection revokes an earlier absent-request retry permission', async () => {
  const ui = await setup();
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  let inspectFails = false;
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (options.method === 'POST' || inspectFails) throw new TypeError('Synthetic missing local response');
    return Response.json({ jobs: [] });
  };
  await ui.query('#queue-backup').fire('click');
  await ui.query('#generic-queue-inspect').fire('click');
  assert.equal(ui.query('#generic-queue-retry').hidden, false);
  inspectFails = true;
  await ui.query('#generic-queue-inspect').fire('click');
  assert.equal(ui.query('#generic-queue-retry').hidden, true);
  await ui.query('#generic-queue-retry').fire('click');
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
});

test('a pending Activity reinspection cannot release a terminal attempt or allow a competing queue submission', async () => {
  const ui = await setup();
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {};");
  let receipt;
  let delayed = false;
  const inspection = deferred();
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (options.method === 'POST') {
      receipt = genericReceipt(ui.requests.at(-1), 'completed');
      return Response.json(receipt);
    }
    return delayed ? inspection.promise : Response.json({ jobs: [receipt.job] });
  };
  await ui.query('#queue-backup').fire('click');
  await ui.query('#generic-queue-inspect').fire('click');
  assert.equal(ui.query('#generic-queue-new').hidden, false);
  delayed = true;
  const pending = ui.query('#generic-queue-inspect').fire('click');
  await ui.query('#generic-queue-inspect').fire('click');
  await ui.query('#generic-queue-new').fire('click');
  await ui.query('#queue-backup').fire('click');
  assert.equal(ui.query('#generic-queue-new').hidden, true);
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(ui.requests.filter(request => !request.method).length, 2);
  inspection.resolve(Response.json({ jobs: [receipt.job] }));
  await pending;
  assert.match(ui.query('#generic-queue-status').textContent, /Activity confirms job.*completed/);
});

const genericStorageKey = 'esquie-generic-queue-request-v1';

async function lostGenericRequest(storage, notes = 'Original synthetic meeting notes') {
  const ui = await setup(storage);
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  ui.query('#meeting-form').elements.notes.value = notes;
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    throw new TypeError('Synthetic lost queue receipt');
  };
  await ui.query('#meeting-form').fire('submit');
  return ui;
}

test('a pending generic dispatch persists only salted metadata before network and reload requires matching re-entered inputs', async () => {
  const storage = new Map();
  const ui = await setup(storage);
  const originalNotes = '  Cafe\u0301\u0001 synthetic notes  ';
  const form = ui.query('#meeting-form');
  form.elements.notes.value = originalNotes;
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  const mutation = deferred();
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    const record = JSON.parse(storage.get(genericStorageKey));
    assert.equal(record.requestId, JSON.parse(options.body).requestId, 'identity must exist before dispatch');
    assert.deepEqual(Object.keys(record).sort(), ['version', 'requestId', 'kind', 'taskId', 'salt', 'fingerprint', 'jobId'].sort());
    assert.match(record.fingerprint, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(storage.get(genericStorageKey), /"notes"\s*:|Cafe|synthetic-owner-capability|synthetic-csrf/);
    return mutation.promise;
  };
  const pending = form.fire('submit');
  await waitForQueueDispatch(ui);
  const record = JSON.parse(storage.get(genericStorageKey));
  const reloaded = await setup(storage);
  assert.equal(reloaded.requests.length, 0, 'reload must not replay or automatically inspect');
  assert.equal(reloaded.query('#meeting-form').elements.notes.value, '', 'no notes can be restored from metadata');
  assert.equal(reloaded.run('genericQueueAttempt.body.requestId'), record.requestId);
  reloaded.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {};");
  reloaded.context.fetch = async (path, options) => {
    reloaded.requests.push({ path, ...options });
    if (!options.method) return Response.json({ jobs: [] });
    return Response.json(genericReceipt(reloaded.requests.at(-1)), { status: 202 });
  };
  await reloaded.query('#queue-backup').fire('click');
  await reloaded.query('#generic-queue-retry').fire('click');
  await reloaded.query('#generic-queue-new').fire('click');
  assert.equal(reloaded.requests.length, 0);
  await reloaded.query('#generic-queue-inspect').fire('click');
  const reloadedForm = reloaded.query('#meeting-form');
  reloadedForm.elements.notes.value = 'Changed synthetic notes';
  await reloaded.query('#generic-queue-retry').fire('click');
  assert.equal(reloaded.requests.filter(request => request.method === 'POST').length, 0);
  assert.match(reloaded.query('#generic-queue-status').textContent, /do not match.*Nothing was submitted/);
  assert.equal(reloadedForm.elements.notes.value, 'Changed synthetic notes');
  reloadedForm.elements.notes.value = 'Café synthetic notes';
  const recovering = reloaded.query('#generic-queue-retry').fire('click');
  await reloaded.query('#generic-queue-retry').fire('click');
  await reloaded.query('#queue-document').fire('click');
  await recovering;
  const writes = reloaded.requests.filter(request => request.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].body).requestId, record.requestId);
  assert.equal(JSON.parse(writes[0].body).notes, 'Café synthetic notes', 'server-normalized equivalent inputs may recover');
  assert.equal(JSON.parse(storage.get(genericStorageKey)).fingerprint, record.fingerprint);
  mutation.resolve(new Response('{bad', { status: 202 }));
  await pending;
});

test('reload reconciles exact generic Activity fingerprints without replay and blocks changed, duplicate or malformed evidence', async () => {
  for (const mismatch of [null, 'notes', 'kind', 'task', 'duplicate', 'malformed']) {
    const storage = new Map();
    const original = await lostGenericRequest(storage);
    const job = genericReceipt(original.requests[0], 'partial').job;
    if (mismatch === 'notes') job.payload.notes = 'Changed source payload';
    if (mismatch === 'kind') job.kind = 'backup';
    if (mismatch === 'task') job.taskId = randomUUID();
    const ui = await setup(storage);
    ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      assert.equal(options.method, undefined, 'inspection must be read-only');
      return Response.json({ jobs: mismatch === 'malformed' ? null : mismatch === 'duplicate' ? [job, job] : [job] });
    };
    await ui.query('#generic-queue-inspect').fire('click');
    await ui.query('#generic-queue-retry').fire('click');
    await ui.query('#queue-backup').fire('click');
    assert.equal(ui.requests.length, 1);
    assert.equal(ui.query('#generic-queue-retry').hidden, true);
    if (mismatch) {
      assert.match(ui.query('#generic-queue-status').textContent, /Activity could not confirm/);
      assert.equal(ui.query('#generic-queue-new').hidden, true);
    } else {
      assert.match(ui.query('#generic-queue-status').textContent, /Activity confirms job.*partial.*No work was replayed/);
      assert.equal(JSON.parse(storage.get(genericStorageKey)).jobId, job.id);
      assert.equal(ui.query('#generic-queue-new').hidden, false);
    }
  }
});

test('reloaded accepted generic identities require the same job ID and cannot replay a missing or substituted job', async () => {
  for (const missing of [false, true]) {
    const storage = new Map();
    const original = await setup(storage);
    let receipt;
    original.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    original.context.fetch = async (path, options) => {
      original.requests.push({ path, ...options });
      if (!options.method) throw new Error('Synthetic accepted-but-refresh-failed');
      receipt = genericReceipt(original.requests.at(-1), 'completed');
      return Response.json(receipt);
    };
    await original.query('#queue-document').fire('click');
    assert.match(original.query('#generic-queue-status').textContent, /Accepted.*display refresh failed/);
    const ui = await setup(storage);
    ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      return Response.json({ jobs: missing ? [] : [{ ...receipt.job, id: randomUUID() }] });
    };
    await ui.query('#generic-queue-inspect').fire('click');
    await ui.query('#generic-queue-retry').fire('click');
    await ui.query('#generic-queue-new').fire('click');
    await ui.query('#queue-backup').fire('click');
    assert.equal(ui.requests.length, 1);
    assert.match(ui.query('#generic-queue-status').textContent, /Activity could not confirm/);
  }
});

test('reloaded absent generic task requests retain their original target and prior uncertainty despite current task changes and structured 4xx', async () => {
  const storage = new Map();
  const original = await setup(storage);
  const taskId = randomUUID();
  original.context.targetId = taskId;
  original.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; conversationTaskId = targetId;");
  original.context.fetch = async (path, options) => {
    original.requests.push({ path, ...options });
    throw new TypeError('Synthetic lost response');
  };
  await original.query('#summarize-task').fire('click');
  const ui = await setup(storage);
  ui.context.otherTaskId = randomUUID();
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; conversationTaskId = otherTaskId;");
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (!options.method) return Response.json({ jobs: [] });
    return Response.json({ error: 'Synthetic approval revoked since uncertain original' }, { status: 403 });
  };
  await ui.query('#generic-queue-inspect').fire('click');
  await ui.query('#generic-queue-retry').fire('click');
  const write = ui.requests.find(request => request.method === 'POST');
  assert.equal(write.body, original.requests[0].body);
  assert.equal(JSON.parse(write.body).taskId, taskId);
  assert.equal(ui.run('conversationTaskId'), ui.context.otherTaskId);
  assert.match(ui.query('#generic-queue-status').textContent, /outcome unknown/);
  assert.equal(ui.query('#generic-queue-new').hidden, true);
  assert.equal(storage.has(genericStorageKey), true);
});

test('generic recovery stores salted identities, clears definite first rejections, and never saves inputs or approvals', async () => {
  const firstStorage = new Map();
  const secondStorage = new Map();
  await lostGenericRequest(firstStorage);
  await lostGenericRequest(secondStorage);
  const first = JSON.parse(firstStorage.get(genericStorageKey));
  const second = JSON.parse(secondStorage.get(genericStorageKey));
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.fingerprint, second.fingerprint, 'identical note inputs must not expose an unsalted hash');
  assert.doesNotMatch(firstStorage.get(genericStorageKey), /Original synthetic|"notes"\s*:|token|consent|source content/i);
  const storage = new Map();
  const ui = await setup(storage);
  ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    return Response.json({ error: 'Synthetic structured rejection' }, { status: 403 });
  };
  await ui.query('#queue-source_refresh').fire('click');
  assert.equal(storage.has(genericStorageKey), false);
  assert.match(ui.query('#generic-queue-status').textContent, /Submission rejected/);
  const reloaded = await setup(storage);
  assert.equal(reloaded.run('genericQueueAttempt'), null, 'a confirmed first rejection need not survive as uncertainty');
});

test('corrupt or unreadable generic recovery metadata fails closed without clearing records or posting work', async () => {
  const seed = new Map();
  await lostGenericRequest(seed);
  const record = JSON.parse(seed.get(genericStorageKey));
  for (const saved of ['', '{bad', JSON.stringify({ ...record, version: 2 }),
    JSON.stringify({ ...record, notes: 'Forbidden raw content' }),
    JSON.stringify({ ...record, requestId: [record.requestId] }),
    JSON.stringify({ ...record, kind: 'backup', taskId: randomUUID() }),
    JSON.stringify({ ...record, salt: 'not-a-salt' }), 'x'.repeat(2001), null]) {
    const storage = new Map([[genericStorageKey, saved]]);
    if (saved === null) {
      const get = storage.get.bind(storage);
      storage.get = key => { if (key === genericStorageKey) throw new Error('Synthetic unavailable storage'); return get(key); };
    }
    const ui = await setup(storage);
    ui.query('#meeting-form').elements.notes.value = 'Retain entered text';
    await ui.query('#meeting-form').fire('submit');
    await ui.query('#queue-backup').fire('click');
    await ui.query('#generic-queue-retry').fire('click');
    await ui.query('#generic-queue-new').fire('click');
    assert.equal(ui.requests.length, 0);
    assert.match(ui.query('#generic-queue-status').textContent, /unavailable or corrupt.*blocked/);
    assert.equal(ui.query('#meeting-form').elements.notes.value, 'Retain entered text');
    assert.equal(ui.run('genericQueueStorageProblem'), true);
    assert.equal(ui.run('unresolvedDemoRequest'), null, 'a generic record must not replace the specialized demo lock');
    if (saved !== null) assert.equal(storage.get(genericStorageKey), saved, 'corruption must not be silently erased');
  }
});

test('generic persistence and fingerprint failures prevent dispatch; post-acceptance and release failures remain visibly blocked', async () => {
  for (const failure of ['write', 'fingerprint', 'accepted-write', 'remove']) {
    const storage = new Map();
    const ui = await setup(storage);
    ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {};");
    let receipt;
    let writes = 0;
    if (failure === 'fingerprint') ui.context.crypto.subtle = { digest: async () => { throw new Error('Synthetic hashing unavailable'); } };
    ui.context.sessionStorage.setItem = (key, value) => {
      if (failure === 'write' || (failure === 'accepted-write' && ++writes > 1)) throw new Error('Synthetic storage write unavailable');
      storage.set(key, value);
    };
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (!options.method) return Response.json({ jobs: [receipt.job] });
      receipt = genericReceipt(ui.requests.at(-1), 'completed');
      return Response.json(receipt);
    };
    await ui.query('#queue-document').fire('click');
    if (failure === 'remove') {
      await ui.query('#generic-queue-inspect').fire('click');
      ui.context.sessionStorage.removeItem = () => { throw new Error('Synthetic storage removal unavailable'); };
      await ui.query('#generic-queue-new').fire('click');
    }
    await ui.query('#queue-backup').fire('click');
    await ui.query('#generic-queue-retry').fire('click');
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, ['write', 'fingerprint'].includes(failure) ? 0 : 1);
    assert.match(ui.query('#generic-queue-status').textContent, /unavailable or corrupt.*blocked/);
    if (failure === 'accepted-write') assert.match(ui.query('#generic-queue-status').textContent, /Accepted local job/);
    if (failure === 'write' || failure === 'fingerprint') assert.match(ui.query('#generic-queue-status').textContent, /not dispatched|No replacement request/);
  }
});

test('a reloaded identity reconciles a lost real local receipt after a same-origin restart without re-enqueue or duplicate output', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'esquie-ui-queue-recovery-'));
  let app;
  t.after(async () => {
    try { if (app) await app.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  const storage = new Map();
  let ui = await setup(storage);
  let port = 0;
  async function start() {
    app = await startServer({ dataDir, port, workerIntervalMs: 0 });
    port = Number(new URL(app.url).port);
    const state = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
    ui.context.testAccess = app.accessToken;
    ui.context.testCsrf = state.csrfToken;
    ui.run('accessToken = testAccess; csrfToken = testCsrf;');
  }
  await start();
  ui.context.fetch = async (path, options) => {
    assert.ok(['/api/jobs', '/api/state'].includes(path), 'only synthetic loopback queue/state endpoints may be used');
    ui.requests.push({ path, ...options });
    const headers = new Headers(options.headers);
    if (options.method === 'POST') headers.set('Origin', app.url);
    const response = await fetch(`${app.url}${path}`, { ...options, headers });
    if (options.method === 'POST') { await response.json(); throw new TypeError('Synthetic lost receipt after commit'); }
    return response;
  };
  await ui.query('#queue-task_summary').fire('click');
  assert.match(ui.query('#generic-queue-status').textContent, /outcome unknown/);
  const body = JSON.parse(ui.requests[0].body);
  await app.worker.tick();
  await app.close();
  ui = await setup(storage);
  await start();
  ui.context.fetch = async (path, options) => {
    assert.equal(path, '/api/jobs', 'reload recovery must only inspect durable local Activity');
    ui.requests.push({ path, ...options });
    return fetch(`${app.url}${path}`, options);
  };
  await ui.query('#generic-queue-inspect').fire('click');
  assert.match(ui.query('#generic-queue-status').textContent, /Activity confirms job.*recorded state: completed/);
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 0);
  const retry = await fetch(`${app.url}/api/jobs`, {
    method: 'POST', headers: { Origin: app.url, 'X-Esquie-Access': app.accessToken, 'X-Esquie-CSRF': ui.context.testCsrf, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(retry.status, 200);
  const receipt = await retry.json();
  assert.equal(receipt.deduplicated, true);
  assert.equal(receipt.job.requestId, body.requestId);
  assert.equal(receipt.job.status, 'completed');
  assert.equal(receipt.job.attempts, 1);
  const state = await (await fetch(`${app.url}/api/state`, { headers: { 'X-Esquie-Access': app.accessToken } })).json();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].events.filter(event => event.status === 'completed').length, 1);
  assert.deepEqual(state.documents, []);
});
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
  ui.run("api = async () => { throw Object.assign(new Error('Task changed; stale revision was not applied.'), { definitiveRejection: true }); };");
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

function currentInsightFixture(ui) {
  const identity = { tenantId: 'fake-tenant', userId: 'fake-owner' };
  const job = {
    id: randomUUID(), kind: 'meeting_insight_list', status: 'partial',
    payload: { connectionEpoch: 'fake-epoch', ownerReference: JSON.stringify(identity), meetingId: 'fake-meeting', authorizationReference: 'fake-authorization' },
    result: { meetingInsightList: {
      meetingId: 'fake-meeting', coverage: { status: 'bounded', limitations: [] },
      items: [{ id: 'fake-insight', meetingId: 'fake-meeting', createdDateTime: 'fake-time', endDateTime: '' }]
    } }
  };
  ui.context.fakeJob = job;
  ui.context.fakeIdentity = identity;
  ui.run(`workspace.jobs = [fakeJob];
    workspace.sourceConsent = { expectedIdentity: fakeIdentity, sources: { meetingInsightMeetings: ['fake-meeting'] } };
    latestConnections = { microsoft365: { state: 'connected', verifiedOwner: true, identity: fakeIdentity, listSelectionEpoch: 'fake-epoch', listAuthorizationReference: 'fake-authorization' } };
    renderJobs();`);
  const walk = element => [element, ...element.children.flatMap(walk)];
  return {
    job,
    selection: () => walk(ui.query('#job-list')).find(element => element.tagName === 'BUTTON' && element.textContent === 'Select this insight for separate approval')
  };
}

test('selecting a current list item is inert and exact detail needs separate consent', async () => {
  const ui = await setup();
  const { job, selection } = currentInsightFixture(ui);
  const unsaved = { value: 'Unrelated unsaved source settings' };
  ui.query('#microsoft365-form').elements = { sources: unsaved };
  assert.ok(selection());
  await selection().fire('click');
  assert.equal(unsaved.value, 'Unrelated unsaved source settings');
  assert.equal(ui.requests.length, 0);
  assert.match(ui.query('#meeting-insight-detail-selection').textContent, /fake-meeting/);
  const form = ui.query('#meeting-insight-detail-form');
  assert.equal(form.elements.detailConsent.checked, false);
  await form.fire('submit');
  assert.equal(ui.requests.length, 0);
  ui.run("accessToken = 'synthetic'; csrfToken = 'synthetic'; refreshState = async () => {};");
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    const body = JSON.parse(options.body);
    return Response.json({ job: { id: randomUUID(), kind: body.kind, requestId: body.requestId, payload: { meetingId: 'fake-meeting', listJobId: body.listJobId, insightId: body.insightId }, status: 'queued' } }, { status: 202 });
  };
  form.elements.detailConsent.checked = true;
  await form.fire('submit');
  assert.equal(ui.requests.length, 1);
  const body = JSON.parse(ui.requests[0].body);
  assert.equal(body.kind, 'meeting_insight_detail');
  assert.equal(body.listJobId, job.id);
  assert.equal(body.insightId, 'fake-insight');
  assert.equal(body.detailConsent, true);
  assert.equal(form.elements.detailConsent.checked, false);
  assert.equal(unsaved.value, 'Unrelated unsaved source settings');
});

test('stale insight selections are not offered and cannot be submitted', async () => {
  for (const change of [
    "latestConnections.microsoft365.listSelectionEpoch = 'new-epoch'",
    "latestConnections.microsoft365.listAuthorizationReference = 'new-authorization'",
    "latestConnections.microsoft365.identity = { tenantId: 'other', userId: 'other' }",
    "workspace.sourceConsent.sources.meetingInsightMeetings = []"
  ]) {
    const ui = await setup();
    const { selection } = currentInsightFixture(ui);
    await selection().fire('click');
    ui.query('#meeting-insight-detail-form').elements.detailConsent.checked = true;
    ui.run(`${change}; renderJobs();`);
    assert.equal(selection(), undefined);
    assert.match(ui.query('#meeting-insight-detail-selection').textContent, /stale or unverified/);
    await ui.query('#meeting-insight-detail-form').fire('submit');
    assert.equal(ui.requests.length, 0);
  }
});

test('detail submit blocks overlap and retains the selection and consent on unknown receipt', async () => {
  const ui = await setup();
  const { selection } = currentInsightFixture(ui);
  await selection().fire('click');
  const form = ui.query('#meeting-insight-detail-form');
  form.elements.detailConsent.checked = true;
  ui.run("accessToken = 'synthetic'; csrfToken = 'synthetic';");
  let release;
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    return new Promise(resolve => { release = resolve; });
  };
  const first = form.fire('submit');
  await form.fire('submit');
  await selection().fire('click');
  assert.equal(ui.requests.length, 1);
  release(Response.json({ job: {} }, { status: 202 }));
  await first;
  assert.match(ui.query('#meeting-insight-detail-status').textContent, /outcome.*unknown/i);
  assert.equal(form.elements.detailConsent.checked, true);
  assert.equal(form.elements.detailConsent.disabled, true);
  assert.match(ui.query('#meeting-insight-detail-selection').textContent, /fake-insight/);
  await form.fire('submit');
  assert.equal(ui.requests.length, 1);
});

test('lost and mismatched detail receipts remain uncertain without replay', async () => {
  for (const kind of ['lost', 'mismatch']) {
    const ui = await setup();
    const { selection } = currentInsightFixture(ui);
    await selection().fire('click');
    const form = ui.query('#meeting-insight-detail-form');
    form.elements.detailConsent.checked = true;
    ui.run("accessToken = 'synthetic'; csrfToken = 'synthetic';");
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (kind === 'lost') throw new Error('Synthetic lost receipt');
      const body = JSON.parse(options.body);
      return Response.json({ job: {
        id: randomUUID(), kind: body.kind, requestId: body.requestId,
        payload: { meetingId: 'other-meeting', listJobId: body.listJobId, insightId: body.insightId }, status: 'queued'
      } }, { status: 202 });
    };
    await form.fire('submit');
    assert.match(ui.query('#meeting-insight-detail-status').textContent, /outcome.*unknown/i);
    assert.match(ui.query('#meeting-insight-detail-status').textContent, /do not blindly retry/i);
    assert.equal(form.elements.detailConsent.checked, true);
    await form.fire('submit');
    assert.equal(ui.requests.length, 1);
  }
});

test('a queued detail with failed refresh is not mistaken for an unknown queue outcome', async () => {
  const ui = await setup();
  const { selection } = currentInsightFixture(ui);
  await selection().fire('click');
  const form = ui.query('#meeting-insight-detail-form');
  form.elements.detailConsent.checked = true;
  ui.context.confirm = () => true;
  ui.run("accessToken = 'synthetic'; csrfToken = 'synthetic';");
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    if (path !== '/api/jobs') throw new Error('Synthetic refresh failure');
    const body = JSON.parse(options.body);
    return Response.json({ job: { id: randomUUID(), kind: body.kind, requestId: body.requestId, payload: { meetingId: 'fake-meeting', listJobId: body.listJobId, insightId: body.insightId }, status: 'queued' } }, { status: 202 });
  };
  await form.fire('submit');
  assert.match(ui.query('#meeting-insight-detail-status').textContent, /was queued.*could not be refreshed/);
  assert.match(ui.query('#meeting-insight-detail-status').textContent, /do not blindly retry/i);
  assert.equal(form.elements.detailConsent.checked, false);
  assert.equal(form.elements.detailConsent.disabled, true);
  await form.fire('submit');
  assert.equal(ui.requests.filter(request => request.path === '/api/jobs').length, 1);
  await ui.query('#meeting-insight-detail-reset').fire('click');
  assert.equal(form.elements.detailConsent.checked, false);
  assert.equal(form.elements.detailConsent.disabled, false);
});

test('real UI handler selects and queues a separately approved synthetic host detail', async t => {
  const root = await mkdtemp(join(tmpdir(), 'esquie-insight-ui-'));
  const calls = [];
  const identity = { tenantId: 'fake-tenant', userId: 'fake-owner' };
  const app = await startServer({
    dataDir: root, port: 0, workerIntervalMs: 0,
    microsoft365Options: {
      tokenProvider: async ({ scopes }) => ({ ...identity, scopes, tokenType: 'delegated', accessToken: 'synthetic.bearer.only' }),
      transport: async (target, options) => {
        const path = new URL(target).pathname;
        calls.push({ path, method: options.method });
        if (path === '/v1.0/me') return Response.json({ id: identity.userId });
        if (path.endsWith('/aiInsights')) return Response.json({ value: [{ id: 'fake-insight', createdDateTime: 'fake-time' }] });
        if (path.endsWith('/aiInsights/fake-insight')) return Response.json({ id: 'fake-insight', meetingNotes: [{ text: 'Synthetic detail' }] });
        throw new Error('Unexpected synthetic route');
      }
    }
  });
  t.after(async () => { await app.close(); await rm(root, { force: true, recursive: true }); });
  const headers = { 'X-Esquie-Access': app.accessToken };
  const initial = await (await fetch(`${app.url}/api/state`, { headers })).json();
  const post = (path, body) => fetch(`${app.url}${path}`, {
    method: 'POST', headers: { ...headers, Origin: app.url, 'X-Esquie-CSRF': initial.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal((await post('/api/microsoft365/connect', {
    consent: true, expectedIdentity: identity, sources: { meetingInsightMeetings: ['fake-meeting'] }, allowReplyDrafts: false
  })).status, 200);
  assert.equal((await post('/api/jobs', {
    kind: 'meeting_insight_list', meetingId: 'fake-meeting', listConsent: true, requestId: randomUUID()
  })).status, 202);
  await app.worker.tick();
  const state = await (await fetch(`${app.url}/api/state`, { headers })).json();
  const connections = await (await fetch(`${app.url}/api/connections`, { headers })).json();
  const ui = await setup();
  ui.context.testState = state;
  ui.context.testConnections = connections;
  ui.context.testAccess = app.accessToken;
  ui.run('workspace = testState; latestConnections = testConnections; accessToken = testAccess; csrfToken = testState.csrfToken; refreshState = async () => {}; renderJobs();');
  ui.context.fetch = async (path, options) => {
    ui.requests.push({ path, ...options });
    const requestHeaders = new Headers(options.headers);
    requestHeaders.set('Origin', app.url);
    return fetch(`${app.url}${path}`, { ...options, headers: requestHeaders });
  };
  const walk = element => [element, ...element.children.flatMap(walk)];
  const select = walk(ui.query('#job-list')).find(element => element.tagName === 'BUTTON' && element.textContent === 'Select this insight for separate approval');
  assert.ok(select);
  await select.fire('click');
  assert.equal(ui.requests.length, 0);
  assert.equal(calls.filter(call => call.path.includes('/aiInsights/')).length, 0);
  const form = ui.query('#meeting-insight-detail-form');
  form.elements.detailConsent.checked = true;
  await form.fire('submit');
  assert.match(ui.query('#meeting-insight-detail-status').textContent, /was queued/);
  assert.equal(calls.filter(call => call.path.includes('/aiInsights/')).length, 0);
  await app.worker.tick();
  const after = await (await fetch(`${app.url}/api/state`, { headers })).json();
  assert.match(after.jobs[0].result.meetingInsightDetail.item.excerpt, /Synthetic detail/);
  assert.equal(after.tasks.length, 0);
  assert.equal(calls.filter(call => call.path.includes('/aiInsights/')).length, 1);
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

test('fake demo submission requires fresh explicit confirmation and a matching queue receipt', async () => {
  const ui = await setup();
  const form = ui.query('#fake-demo-form');
  const button = form.querySelector('button[type="submit"]');
  const confirmation = form.elements.confirmFakeOnly;
  form.elements.format.value = 'markdown';
  const requestId = '12345678-1234-4234-8234-123456789abc';
  const receipt = {
    message: 'Queued locally.',
    job: {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', requestId, kind: 'fake_demo',
      taskId: null, status: 'queued', payload: { confirmFakeOnly: true, format: 'markdown' }
    }
  };
  let release;
  ui.run(`
    crypto.randomUUID = () => '${requestId}';
    globalThis.demoRequests = [];
    api = async (path, options) => {
      demoRequests.push({ path, options });
      return await new Promise(resolve => { globalThis.releaseDemoReceipt = resolve; });
    };
    refreshState = async () => {};
  `);
  await form.fire('submit');
  assert.equal(ui.run('demoRequests.length'), 0, 'unselected consent never reaches the queue API');
  assert.match(ui.query('#notice').textContent, /explicitly check/i);
  assert.equal(button.disabled, false);
  confirmation.checked = true;
  form.elements.format.value = '';
  await form.fire('submit');
  assert.equal(ui.run('demoRequests.length'), 0, 'missing output-format selection never reaches the queue API');
  assert.match(ui.query('#notice').textContent, /Choose Markdown or PowerPoint explicitly/);
  form.elements.format.value = 'markdown';
  const first = form.fire('submit');
  assert.equal(button.disabled, true);
  const concurrent = await form.fire('submit');
  assert.equal(ui.run('demoRequests.length'), 1);
  assert.match(ui.query('#notice').textContent, /still in progress.*Do not retry/);
  ui.context.releaseDemoReceipt(receipt);
  await first;
  assert.equal(button.disabled, false);
  assert.equal(confirmation.checked, false);
  assert.match(ui.query('#notice').textContent, /accepted.*No result is claimed/);
  assert.equal(ui.run("JSON.parse(demoRequests[0].options.body).requestId"), requestId);
  assert.equal(ui.run('demoRequests[0].path'), '/api/jobs');
  assert.equal(ui.requests.length, 0);
});

test('demo form consumes fresh consent on each request and distinguishes rejection, unknown and post-acceptance refresh failure', async () => {
  for (const [label, failure] of [
    ['revoked approval', Object.assign(new Error('Demo approval is no longer active.'), { status: 403 })],
    ['server error', Object.assign(new Error('The host could not confirm the queue transaction.'), { status: 503 })],
    ['missing receipt', null],
    ['malformed receipt', { message: 'Accepted', job: { kind: 'fake_demo', id: 'not-a-uuid' } }],
    ['lost receipt', new Error('Socket closed before the queue receipt arrived.')]
  ]) {
    const ui = await setup();
    const form = ui.query('#fake-demo-form');
    const confirmation = form.elements.confirmFakeOnly;
    const button = form.querySelector('button[type="submit"]');
    form.elements.format.value = 'markdown';
    confirmation.checked = true;
    ui.run(`api = async () => { throw Object.assign(new Error('${label}'), { status: 403, definitiveRejection: true }); };`);
    if (label === 'server error') ui.run("api = async () => { throw Object.assign(new Error('Host could not confirm the transaction.'), { status: 503 }); };");
    if (label === 'missing receipt') ui.run('api = async () => ({});');
    if (label === 'malformed receipt') ui.context.badReceipt = failure, ui.run('api = async () => badReceipt;');
    if (label === 'lost receipt') ui.run("api = async () => { throw new Error('Socket closed before the queue receipt arrived.'); };");
    await form.fire('submit');
    assert.equal(confirmation.checked, false, `${label}: every attempt consumes fresh explicit consent`);
    assert.equal(button.disabled, label !== 'revoked approval', `${label}: unknown outcomes remain blocked`);
    assert.match(ui.query('#notice').textContent, label === 'revoked approval' ? /rejected.*no queue receipt/ : /unknown.*Inspect Activity.*do not blindly retry/);
  }

  const ui = await setup();
  const form = ui.query('#fake-demo-form');
  const confirmation = form.elements.confirmFakeOnly;
  confirmation.checked = true;
  form.elements.format.value = 'markdown';
  ui.run(`
    api = async () => ({ message: 'Accepted', job: {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', requestId: '12345678-1234-4234-8234-123456789abc',
      kind: 'fake_demo', taskId: null, status: 'queued', payload: { confirmFakeOnly: true, format: 'markdown' }
    } });
    crypto.randomUUID = () => '12345678-1234-4234-8234-123456789abc';
    refreshState = async () => { throw new Error('Synthetic display refresh failed.'); };
  `);
  await form.fire('submit');
  assert.equal(confirmation.checked, false);
  assert.match(ui.query('#notice').textContent, /was accepted, but the workspace could not refresh.*Inspect Activity.*do not submit another request/);
});

test('demo receipt validation rejects mismatched IDs, kind, confirmation and malformed job state', async () => {
  const ui = await setup();
  const requestId = '12345678-1234-4234-8234-123456789abc';
  const valid = {
    message: 'Accepted', job: {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', requestId, kind: 'fake_demo',
      taskId: null, status: 'queued', payload: { confirmFakeOnly: true, format: 'markdown' }
    }
  };
  ui.context.valid = valid;
  const variants = [
    'null', '({})',
    `({...valid, job: {...valid.job, requestId: 'different'}})`,
    `({...valid, job: {...valid.job, kind: 'document'}})`,
    `({...valid, job: {...valid.job, payload: {confirmFakeOnly: false}}})`,
    `({...valid, job: {...valid.job, payload: {confirmFakeOnly: true, format: 'pptx'}}})`,
    `({...valid, job: {...valid.job, taskId: 'forged'}})`,
    `({...valid, job: {...valid.job, status: 'unknown'}})`,
    `({...valid, job: {...valid.job, id: 'not-a-uuid'}})`,
    `({...valid, message: ''})`
  ];
  for (const variant of variants) {
    ui.query('#demo-reviewed').checked = true;
    await ui.query('#demo-allow-new').fire('click');
    const form = ui.query('#fake-demo-form');
    form.elements.confirmFakeOnly.checked = true;
    form.elements.format.value = 'markdown';
    ui.run(`api = async () => ${variant};`);
    await form.fire('submit');
    assert.equal(form.elements.confirmFakeOnly.checked, false);
    assert.match(ui.query('#notice').textContent, /unknown.*Inspect Activity.*do not blindly retry/);
  }
});

test('PowerPoint UI binds the chosen format to the request ID, stored uncertainty and matching receipt', async () => {
  const storage = new Map();
  const ui = await setup(storage);
  const form = ui.query('#fake-demo-form');
  const requestId = '12345678-1234-4234-8234-123456789abc';
  form.elements.format.value = 'pptx';
  form.elements.confirmFakeOnly.checked = true;
  ui.run(`
    crypto.randomUUID = () => '${requestId}';
    globalThis.demoRequests = [];
    api = async (path, options) => {
      demoRequests.push({path, options});
      return await new Promise(resolve => { globalThis.finishDemo = resolve; });
    };
    refreshState = async () => {};
  `);
  const pending = form.fire('submit');
  const submitted = JSON.parse(ui.run('demoRequests[0].options.body'));
  assert.deepEqual(submitted, { kind: 'fake_demo', requestId, confirmFakeOnly: true, format: 'pptx' });
  assert.deepEqual(JSON.parse(storage.get('esquie-unresolved-demo-request')), { requestId, format: 'pptx' });
  ui.context.finishDemo({
    message: 'Queued', job: {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', requestId, kind: 'fake_demo',
      taskId: null, status: 'queued', payload: {confirmFakeOnly: true, format: 'pptx'}
    }
  });
  await pending;
  assert.equal(storage.has('esquie-unresolved-demo-request'), false, 'a matching receipt clears the recovery lock');
  assert.match(ui.query('#notice').textContent, /PowerPoint demo request accepted/);
  assert.equal(form.elements.format.value, '');
  assert.equal(form.elements.confirmFakeOnly.checked, false);

  const unknown = await setup();
  unknown.query('#fake-demo-form').elements.format.value = 'pptx';
  unknown.query('#fake-demo-form').elements.confirmFakeOnly.checked = true;
  unknown.context.goodFormat = {
    message: 'Queued', job: {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', requestId, kind: 'fake_demo', taskId: null,
      status: 'queued', payload: { confirmFakeOnly: true, format: 'markdown' }
    }
  };
  unknown.run(`crypto.randomUUID = () => '${requestId}'; api = async () => goodFormat;`);
  await unknown.query('#fake-demo-form').fire('submit');
  assert.match(unknown.query('#notice').textContent, /outcome is unknown/);
  assert.equal(unknown.query('#fake-demo-form button[type="submit"]').disabled, true);
});

test('lost, 5xx and malformed demo receipts block repeated submits across reload until explicit review and fresh consent', async () => {
  for (const outcome of ['lost', 'malformed', '5xx']) {
    const storage = new Map();
    const ui = await setup(storage);
    const form = ui.query('#fake-demo-form');
    ui.run(`
      globalThis.demoPosts = [];
      api = async (path, options) => {
        demoPosts.push({ path, options });
        ${outcome === 'malformed' ? "return {job: {kind: 'fake_demo'}};" : `throw Object.assign(new Error('Lost queue response'), {status: ${outcome === '5xx' ? 503 : 0}});`}
      };
    `);
    form.elements.confirmFakeOnly.checked = true;
    form.elements.format.value = 'markdown';
    await form.fire('submit');
    const originalId = JSON.parse(ui.run('demoPosts[0].options.body')).requestId;
    assert.equal(JSON.parse(storage.get('esquie-unresolved-demo-request')).requestId, originalId);
    assert.equal(JSON.parse(storage.get('esquie-unresolved-demo-request')).format, 'markdown');
    assert.equal(form.querySelector('button[type="submit"]').disabled, true);
    await form.fire('submit');
    await form.fire('submit');
    assert.equal(ui.run('demoPosts.length'), 1);
    assert.match(ui.query('#demo-recovery-status').textContent, new RegExp(originalId));
    const reloaded = await setup(storage);
    const nextForm = reloaded.query('#fake-demo-form');
    nextForm.elements.confirmFakeOnly.checked = true;
    nextForm.elements.format.value = 'markdown';
    await nextForm.fire('submit');
    assert.equal(reloaded.requests.length, 0, 'reload never resubmits the unresolved attempt');
    assert.equal(nextForm.querySelector('button[type="submit"]').disabled, true);
    await reloaded.query('#demo-allow-new').fire('click');
    assert.equal(nextForm.querySelector('button[type="submit"]').disabled, true);
    await reloaded.query('#demo-review-activity').fire('click');
    assert.equal(reloaded.query('#breadcrumb').textContent, 'Activity');
    reloaded.query('#demo-reviewed').checked = true;
    await reloaded.query('#demo-allow-new').fire('click');
    assert.equal(nextForm.elements.confirmFakeOnly.checked, false);
    assert.equal(storage.has('esquie-unresolved-demo-request'), false);
    reloaded.run(`
      globalThis.newPosts = [];
      api = async (path, options) => {
        newPosts.push({path, options});
        const request = JSON.parse(options.body);
        return {message: 'Queued', job: {
          kind: 'fake_demo', id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          requestId: request.requestId, payload: {confirmFakeOnly: true, format: request.format}, taskId: null, status: 'queued'
        }};
      };
      refreshState = async () => { throw new Error('Synthetic display failure'); };
    `);
    await nextForm.fire('submit');
    assert.equal(reloaded.run('newPosts.length'), 0, 'review acknowledgment is not fake-only consent');
    nextForm.elements.confirmFakeOnly.checked = true;
    nextForm.elements.format.value = 'markdown';
    await nextForm.fire('submit');
    assert.equal(reloaded.run('newPosts.length'), 1);
    assert.notEqual(JSON.parse(reloaded.run('newPosts[0].options.body')).requestId, originalId);
    assert.match(reloaded.query('#notice').textContent, /was accepted, but.*could not refresh/);
    assert.equal(nextForm.elements.confirmFakeOnly.checked, false);
    await nextForm.fire('submit');
    assert.equal(reloaded.run('newPosts.length'), 1, 'accepted refresh failures cannot reuse the previous consent');
  }
});

test('demo uses the real ESM parser to distinguish structured rejection from malformed 4xx and server uncertainty', async () => {
  for (const outcome of ['structured-4xx', 'malformed-4xx', 'unstructured-4xx', '5xx']) {
    const storage = new Map();
    const ui = await setup(storage);
    const form = ui.query('#fake-demo-form');
    ui.run("accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    form.elements.confirmFakeOnly.checked = true;
    form.elements.format.value = 'markdown';
    ui.context.fetch = async (path, options) => {
      ui.requests.push({ path, ...options });
      if (outcome === 'malformed-4xx') return new Response('{bad', { status: 403 });
      if (outcome === 'unstructured-4xx') return Response.json({ message: 'Not a structured rejection' }, { status: 403 });
      return Response.json({ error: 'Synthetic rejection or uncertain server error' }, { status: outcome === '5xx' ? 500 : 403 });
    };
    await form.fire('submit');
    const rejected = outcome === 'structured-4xx';
    assert.match(ui.query('#notice').textContent, rejected ? /rejected.*no queue receipt/ : /outcome is unknown/);
    assert.equal(storage.has('esquie-unresolved-demo-request'), !rejected);
    await form.fire('submit');
    assert.equal(ui.requests.length, 1);
    if (rejected) {
      form.elements.confirmFakeOnly.checked = true;
      form.elements.format.value = 'markdown';
      await form.fire('submit');
      assert.equal(ui.requests.length, 2, 'a structured rejection allows a later fresh-consent request');
    }
    if (!rejected) {
      const reloaded = await setup(storage);
      reloaded.query('#fake-demo-form').elements.confirmFakeOnly.checked = true;
      reloaded.query('#fake-demo-form').elements.format.value = 'markdown';
      await reloaded.query('#fake-demo-form').fire('submit');
      assert.equal(reloaded.requests.length, 0);
    }
  }
});

test('demo recovery storage failures fail closed without sending a job', async () => {
  const ui = await setup();
  const form = ui.query('#fake-demo-form');
  form.elements.confirmFakeOnly.checked = true;
  form.elements.format.value = 'markdown';
  ui.run(`
    sessionStorage.setItem = () => { throw new Error('Storage unavailable'); };
    globalThis.demoPosts = 0;
    api = async () => { demoPosts++; };
  `);
  await form.fire('submit');
  assert.equal(ui.run('demoPosts'), 0);
  assert.equal(form.elements.confirmFakeOnly.checked, true);
  assert.match(ui.query('#notice').textContent, /not submitted.*recovery storage is unavailable/);
});

test('failed fake demos show fresh-request guidance instead of the generic retry control', async () => {
  const ui = await setup();
  ui.context.failedDemo = {
    id: 'fake-demo-job', kind: 'fake_demo', status: 'failed',
    error: 'Synthetic local output failed.', events: [], payload: { confirmFakeOnly: true }
  };
  ui.run('workspace.jobs = [failedDemo]; renderJobs();');
  const walk = element => [element, ...element.children.flatMap(walk)];
  const buttons = walk(ui.query('#job-list')).filter(element => element.tagName === 'BUTTON');
  assert.equal(buttons.some(button => button.textContent === 'Explicitly retry'), false);
  assert.match(ui.query('#job-list').textContent, /cannot be retried.*fresh fake-only demo using the form/i);
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

test('Monthly Outcomes searches local workshop fields, keeps duplicate labels distinct, and exposes honest unavailable views', async () => {
  const ui = await setup();
  const records = [
    {
      id: 'workshop-record-a', category: 'outcome', title: 'Shared title', date: '9999-12-31',
      note: 'Owner-provided workshop notes', provenance: 'owner-pasted-unverified',
      workshopImport: { account: 'Twin account label', workshop: 'Quarterly session', status: 'Not provided' }
    },
    {
      id: 'owner-outcome-record', category: 'outcome', title: 'Shared title', date: '',
      note: 'Owner-entered outcome note'
    },
    {
      id: 'engagement-record', category: 'engagement', title: 'Strategic meeting', date: '9999-12-31',
      note: 'Planning only'
    }
  ];
  ui.context.fakeOutcomes = records;
  ui.run('workspace.profile = { timezone: "UTC" }; workspace.records = fakeOutcomes; renderRecords();');
  const host = ui.query('#outcome-list');
  const cards = () => descendants(host).filter(element => element.tagName === 'ARTICLE');
  assert.equal(cards().length, 3);
  assert.deepEqual(cards().map(card => card.textContent.match(/Local record ID: ([^\n]+)/)?.[1]), [
    'workshop-record-a', 'owner-outcome-record', 'engagement-record'
  ]);
  assert.match(host.textContent, /Date unknown \(not provided\)/);
  assert.match(host.textContent, /Status unknown \(not recorded\)/);
  assert.match(host.textContent, /Owner-provided workshop status: Not provided/);
  assert.equal((host.textContent.match(/Shared title/g) || []).length, 2);

  const search = ui.query('#outcome-search');
  search.value = 'Twin account label';
  await search.fire('input');
  assert.equal(cards().length, 1);
  assert.match(host.textContent, /workshop-record-a/);
  assert.doesNotMatch(host.textContent, /owner-outcome-record/);

  search.value = '';
  const filter = ui.query('#outcome-view-filter');
  filter.value = 'outcomes';
  await filter.fire('change');
  assert.equal(cards().length, 1);
  assert.match(host.textContent, /owner-outcome-record/);
  filter.value = 'engagements';
  await filter.fire('change');
  assert.equal(cards().length, 1);
  assert.match(host.textContent, /engagement-record/);
  filter.value = 'workshops';
  await filter.fire('change');
  assert.equal(cards().length, 1);
  assert.match(host.textContent, /workshop-record-a/);
  filter.value = 'ahead';
  await filter.fire('change');
  assert.equal(cards().length, 2);
  assert.doesNotMatch(host.textContent, /owner-outcome-record/);
  assert.match(ui.query('#outcome-view-note').textContent, /does not infer delivery, commitment, customer wins or account relationships/);

  const unavailable = ui.query('#outcome-view-unavailable');
  for (const [view, message] of [
    ['suggestions', /Suggested wins are unavailable/],
    ['impact', /Workshop impact analysis is unavailable/],
    ['reporting', /Business reporting is unavailable/]
  ]) {
    filter.value = view;
    await filter.fire('change');
    assert.equal(unavailable.hidden, false);
    assert.match(unavailable.textContent, message);
    assert.equal(cards().length, 0);
  }

  filter.value = 'all';
  ui.context.fakeOutcomes = [];
  ui.run('workspace.records = fakeOutcomes; renderRecords();');
  assert.equal(cards().length, 0);
  assert.match(host.textContent, /No owner-supplied local entries match this view/);

  ui.context.fakeOutcomes = records;
  ui.run('workspace.records = fakeOutcomes; renderRecords();');
  const workshopCard = cards().find(card => card.textContent.includes('workshop-record-a'));
  const edit = workshopCard.children.find(element => element.tagName === 'BUTTON');
  await edit.fire('click');
  const form = ui.query('#outcome-form');
  assert.equal(form.dataset.recordId, 'workshop-record-a');
  assert.equal(form.dataset.revision, '0');
  assert.equal(form.elements.title.value, 'Shared title');
  assert.equal(form.elements.category.disabled, true);
});

test("What's ahead uses the owner timezone instead of the device date", async () => {
  const ui = await setup();
  const instant = new Date('2026-11-12T02:30:00.000Z');
  const machineTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const machineToday = dateKeyInTimezone(instant, machineTimezone);
  const ownerTimezone = ['Pacific/Kiritimati', 'Pacific/Pago_Pago']
    .find(timezone => dateKeyInTimezone(instant, timezone) !== machineToday);
  assert.ok(ownerTimezone, 'choose an IANA zone with a different date from the device at this fixed instant');
  const ownerToday = dateKeyInTimezone(instant, ownerTimezone);
  const tomorrow = new Date(`${ownerToday}T00:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const records = [
    { id: 'device-date', category: 'outcome', title: 'Device boundary', date: machineToday },
    { id: 'owner-date', category: 'outcome', title: 'Owner boundary', date: ownerToday },
    { id: 'owner-tomorrow', category: 'engagement', title: 'Owner tomorrow', date: tomorrow.toISOString().slice(0, 10) }
  ];
  ui.context.profileTimezone = ownerTimezone;
  ui.context.fakeOutcomes = records;
  ui.query('#outcome-view-filter').value = 'ahead';
  freezeUiDate(ui, instant);
  ui.run('workspace.profile = { timezone: profileTimezone }; workspace.records = fakeOutcomes; renderRecords();');
  const visibleIds = descendants(ui.query('#outcome-list'))
    .filter(element => element.tagName === 'ARTICLE')
    .map(card => card.textContent.match(/Local record ID: ([^\n]+)/)?.[1]);
  assert.deepEqual(visibleIds, records.filter(record => record.date > ownerToday).map(record => record.id));
  assert.match(ui.query('#outcome-view-note').textContent, /profile timezone/);
});

test("What's ahead follows local calendar dates across the spring DST boundary", async () => {
  const ui = await setup();
  ui.context.profileTimezone = 'America/Los_Angeles';
  ui.context.fakeOutcomes = [
    { id: 'dst-day', category: 'outcome', title: 'DST date', date: '2026-03-08' },
    { id: 'after-dst-day', category: 'engagement', title: 'Next date', date: '2026-03-09' }
  ];
  ui.query('#outcome-view-filter').value = 'ahead';
  for (const [instant, expected] of [
    ['2026-03-08T07:59:59.000Z', ['dst-day', 'after-dst-day']],
    ['2026-03-08T08:00:00.000Z', ['after-dst-day']],
    ['2026-03-08T10:00:00.000Z', ['after-dst-day']]
  ]) {
    freezeUiDate(ui, new Date(instant));
    ui.run('workspace.profile = { timezone: profileTimezone }; workspace.records = fakeOutcomes; renderRecords();');
    const visibleIds = descendants(ui.query('#outcome-list'))
      .filter(element => element.tagName === 'ARTICLE')
      .map(card => card.textContent.match(/Local record ID: ([^\n]+)/)?.[1]);
    assert.deepEqual(visibleIds, expected, instant);
  }
});

test("What's ahead requires a valid owner timezone without disabling other local views", async () => {
  for (const [timezone, message] of [
    ['', /set a valid owner timezone in Operations/],
    ['Not/A_Timezone', /saved owner timezone is invalid/]
  ]) {
    const ui = await setup();
    ui.context.profileTimezone = timezone;
    ui.context.fakeOutcomes = [{ id: 'local-outcome', category: 'outcome', title: 'Owner note', date: '9999-12-31' }];
    ui.query('#outcome-view-filter').value = 'ahead';
    freezeUiDate(ui, new Date('2026-11-11T12:00:00.000Z'));
    ui.run('workspace.profile = { timezone: profileTimezone }; workspace.records = fakeOutcomes; renderRecords();');
    assert.equal(ui.query('#outcome-view-unavailable').hidden, false);
    assert.match(ui.query('#outcome-view-unavailable').textContent, message);
    assert.equal(descendants(ui.query('#outcome-list')).some(element => element.tagName === 'ARTICLE'), false);

    ui.query('#outcome-view-filter').value = 'outcomes';
    ui.run('renderRecords();');
    assert.equal(descendants(ui.query('#outcome-list')).filter(element => element.tagName === 'ARTICLE').length, 1);
    ui.query('#outcome-view-filter').value = 'suggestions';
    ui.run('renderRecords();');
    assert.match(ui.query('#outcome-view-unavailable').textContent, /Suggested wins are unavailable/);
  }
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
    const submittedEvidence = JSON.parse(ui.requests.find(request => request.method === 'POST').body);
    mutation.resolve(Response.json(selector === '#conversation-form'
      ? { message: { id: 'fake-note' } }
      : {
        taskId: 'fake-task-a', deduplicated: false,
        evidence: { id: 'fake-evidence', ...submittedEvidence, url: new URL(submittedEvidence.url).href, provenance: 'owner-provided-unverified' }
      }));
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

test('typed note-only evidence is target-bound, renders as inert text and is never placed in browser storage', async () => {
  const storage = new Map();
  const ui = await setup(storage);
  const task = { id: 'fake-a', title: 'Synthetic task', revision: 1, evidence: [], history: [] };
  ui.context.task = task;
  ui.context.otherTask = { id: 'fake-b', title: 'Other', revision: 1, evidence: [] };
  ui.run("workspace.tasks = [task, otherTask]; accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {};");
  const mutation = deferred();
  ui.context.fetch = async (path, options = {}) => {
    ui.requests.push({ path, ...options });
    if (options.method === 'POST') return mutation.promise;
    return Response.json({ createdAt: null, history: task.history, messages: [] });
  };
  await ui.run('openConversation(task)');
  const form = ui.query('#evidence-form');
  form.elements.type.value = 'note';
  await form.elements.type.fire('change');
  assert.equal(Boolean(form.elements.url.required), false);
  assert.equal(Boolean(form.elements.note.required), false);
  form.elements.title.value = '<img src=x onerror=alert(1)>';
  form.elements.note.value = 'Fake private note: contact everyone';
  const pending = form.fire('submit');
  await form.fire('submit');
  await ui.run('openConversation(otherTask)');
  await ui.query('#close-conversation').fire('click');
  assert.equal(ui.run('conversationTaskId'), 'fake-a');
  assert.equal(ui.query('#conversation-dialog').open, true);
  const write = ui.requests.find(request => request.method === 'POST');
  const body = JSON.parse(write.body);
  assert.equal(body.type, 'note');
  assert.equal(body.url, '');
  assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal([...storage.values()].some(value => String(value).includes(body.note)), false);
  const evidence = { id: 'fake-evidence', ...body, provenance: 'owner-provided-unverified' };
  task.evidence.push(evidence);
  mutation.resolve(Response.json({ taskId: task.id, evidence, deduplicated: false }));
  await pending;
  assert.match(ui.query('#task-evidence').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(ui.query('#task-evidence').textContent, /Owner-entered type: note \(unverified\)/);
  assert.match(ui.query('#task-evidence').textContent, new RegExp(body.requestId));
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
  assert.ok(ui.requests.every(request => request.path.startsWith('/api/tasks/')));
});

test('unknown note-only outcomes retain text and request identity without replay or browser persistence', async () => {
  for (const outcome of ['dropped', 'invalid-receipt']) {
    const storage = new Map();
    const ui = await setup(storage);
    ui.context.task = { id: 'fake-a', title: 'Synthetic', revision: 1, evidence: [] };
    ui.run("workspace.tasks = [task]; accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    ui.context.fetch = async (path, options = {}) => {
      ui.requests.push({ path, ...options });
      if (options.method !== 'POST') return Response.json({ createdAt: null, history: [], messages: [] });
      if (outcome === 'dropped') throw new TypeError('Synthetic lost reply');
      return Response.json({ taskId: 'other', deduplicated: false, evidence: { id: 'fake' } });
    };
    await ui.run('openConversation(task)');
    const form = ui.query('#evidence-form');
    form.elements.type.value = 'note';
    await form.elements.type.fire('change');
    form.elements.title.value = 'Synthetic note';
    form.elements.note.value = 'Private synthetic context';
    await form.fire('submit');
    const body = JSON.parse(ui.requests.find(request => request.method === 'POST').body);
    assert.match(ui.query('#evidence-form [data-save-status]').textContent, new RegExp(body.requestId));
    assert.match(ui.query('#evidence-form [data-save-status]').textContent, /outcome could not be confirmed/);
    assert.equal(form.elements.note.value, body.note);
    assert.equal(ui.query('#evidence-form button[type="submit"]').disabled, true);
    await form.fire('submit');
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal([...storage.values()].some(value => String(value).includes(body.note)), false);
  }
});

test('typed linked evidence duplicate preserves submitted text that was not applied', async () => {
  const ui = await setup();
  ui.context.task = { id: 'fake-a', title: 'Synthetic', revision: 1, evidence: [] };
  ui.context.otherTask = { id: 'fake-b', title: 'Other', revision: 1, evidence: [] };
  ui.run("workspace.tasks = [task, otherTask]; accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {};");
  ui.context.fetch = async (path, options = {}) => {
    ui.requests.push({ path, ...options });
    if (options.method === 'POST') return Response.json({
      deduplicated: true, taskId: 'fake-a',
      evidence: {
        id: 'old', title: 'Existing', note: 'Previously saved note', type: 'document',
        url: 'https://example.invalid/old', provenance: 'owner-provided-unverified'
      }
    });
    return Response.json({ createdAt: null, history: [], messages: [] });
  };
  await ui.run('openConversation(task)');
  const form = ui.query('#evidence-form');
  form.elements.type.value = 'document';
  await form.elements.type.fire('change');
  assert.equal(Boolean(form.elements.url.required), false);
  await ui.run('openConversation(otherTask)');
  assert.equal(ui.run('conversationTaskId'), 'fake-a');
  form.elements.title.value = 'New fake title';
  form.elements.note.value = 'New fake note';
  form.elements.url.value = 'https://example.invalid/old';
  await form.fire('submit');
  const body = JSON.parse(ui.requests.find(request => request.method === 'POST').body);
  assert.equal(body.type, 'document');
  assert.equal(Object.hasOwn(body, 'requestId'), false);
  assert.match(ui.query('#evidence-form [data-save-status]').textContent, /submitted title and note were not applied and remain available in the form/);
  assert.equal(form.elements.title.value, 'New fake title');
  assert.equal(form.elements.note.value, 'New fake note');
  assert.equal(form.elements.url.value, 'https://example.invalid/old');
  assert.equal(form.elements.type.value, 'document');
});

test('linked evidence rejects mismatched 2xx receipts and keeps the submitted form locked', async () => {
  const cases = [
    ['wrong task', result => ({ ...result, taskId: 'fake-b' })],
    ['wrong URL', result => ({ ...result, evidence: { ...result.evidence, url: 'https://example.invalid/wrong' } })],
    ['wrong type', result => ({ ...result, evidence: { ...result.evidence, type: 'email' } })],
    ['missing deduplication status', ({ taskId, evidence }) => ({ taskId, evidence })],
    ['wrong normalized title', result => ({ ...result, evidence: { ...result.evidence, title: 'Other title' } })],
    ['wrong normalized note', result => ({ ...result, evidence: { ...result.evidence, note: 'Other note' } })],
    ['wrong provenance', result => ({ ...result, evidence: { ...result.evidence, provenance: 'authorized-source-untrusted-evidence' } })]
  ];
  for (const [label, alter] of cases) {
    const ui = await setup();
    ui.context.task = { id: 'fake-a', title: 'Synthetic', revision: 1, evidence: [] };
    ui.run("workspace.tasks = [task]; accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {}; ");
    ui.context.fetch = async (path, options = {}) => {
      ui.requests.push({ path, ...options });
      if (options.method !== 'POST') return Response.json({ createdAt: null, history: [], messages: [] });
      const body = JSON.parse(options.body);
      const clean = value => value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
      const result = {
        taskId: 'fake-a', deduplicated: false,
        evidence: {
          id: 'new-evidence', title: clean(body.title), note: clean(body.note), type: body.type,
          url: 'https://example.invalid/path', provenance: 'owner-provided-unverified'
        }
      };
      return Response.json(alter(result));
    };
    await ui.run('openConversation(task)');
    const form = ui.query('#evidence-form');
    form.elements.type.value = 'document';
    form.elements.title.value = '  Synthetic title  ';
    form.elements.url.value = 'HTTPS://EXAMPLE.INVALID/path';
    form.elements.note.value = '  Synthetic note  ';
    await form.fire('submit');
    assert.match(ui.query('#evidence-form [data-save-status]').textContent, /outcome could not be confirmed/, label);
    assert.equal(form.elements.title.value, '  Synthetic title  ', label);
    assert.equal(form.elements.url.value, 'HTTPS://EXAMPLE.INVALID/path', label);
    assert.equal(form.elements.note.value, '  Synthetic note  ', label);
    assert.equal(form.elements.type.value, 'document', label);
    assert.equal(form.querySelector('button[type="submit"]').disabled, true, label);
    await form.fire('submit');
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1, label);
  }
});

test('linked evidence validates normalized new-record receipts and resets only after creation', async () => {
  const ui = await setup();
  ui.context.task = { id: 'fake-a', title: 'Synthetic', revision: 1, evidence: [] };
  ui.run("workspace.tasks = [task]; accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {}; ");
  ui.context.fetch = async (path, options = {}) => {
    ui.requests.push({ path, ...options });
    if (options.method !== 'POST') return Response.json({ createdAt: null, history: [], messages: [] });
    const body = JSON.parse(options.body);
    const clean = value => value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    return Response.json({
      taskId: 'fake-a', deduplicated: false,
      evidence: {
        id: 'new-evidence', title: clean(body.title), note: clean(body.note), type: body.type,
        url: new URL(clean(body.url)).href, provenance: 'owner-provided-unverified'
      }
    });
  };
  await ui.run('openConversation(task)');
  const form = ui.query('#evidence-form');
  form.elements.type.value = 'document';
  form.elements.title.value = '  Synthetic title  ';
  form.elements.url.value = 'HTTPS://EXAMPLE.INVALID/path';
  form.elements.note.value = '  Synthetic note  ';
  await form.fire('submit');
  assert.equal(form.elements.title.value, '');
  assert.equal(form.elements.url.value, '');
  assert.equal(form.elements.note.value, '');
  assert.equal(form.elements.type.value, 'email');
  assert.match(form.querySelector('[data-save-status]').textContent, /Evidence attached as owner-provided, unverified context/);
});

test('all non-note types submit URL-free title-only evidence with bound receipts', async () => {
  for (const type of ['email', 'meeting', 'teams', 'document']) {
    const storage = new Map();
    const ui = await setup(storage);
    ui.context.task = { id: 'fake-a', title: 'Synthetic', revision: 1, evidence: [] };
    ui.context.otherTask = { id: 'fake-b', title: 'Other', revision: 1, evidence: [] };
    ui.run("workspace.tasks = [task, otherTask]; accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {};");
    const mutation = deferred();
    ui.context.fetch = async (path, options = {}) => {
      ui.requests.push({ path, ...options });
      if (options.method === 'POST') return mutation.promise;
      return Response.json({ createdAt: null, history: [], messages: [] });
    };
    await ui.run('openConversation(task)');
    const form = ui.query('#evidence-form');
    form.elements.type.value = type;
    form.elements.title.value = '<synthetic title>';
    assert.equal(Boolean(form.elements.url.required), false);
    assert.equal(Boolean(form.elements.note.required), false);
    const pending = form.fire('submit');
    await ui.run('openConversation(otherTask)');
    assert.equal(ui.run('conversationTaskId'), 'fake-a');
    const body = JSON.parse(ui.requests.find(request => request.method === 'POST').body);
    assert.equal(body.type, type);
    assert.equal(body.url, '');
    assert.equal(body.note, '');
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    const evidence = { id: 'fake', ...body, provenance: 'owner-provided-unverified' };
    ui.context.task.evidence.push(evidence);
    mutation.resolve(Response.json({ taskId: 'fake-a', evidence, deduplicated: false }));
    await pending;
    assert.match(ui.query('#task-evidence').textContent, new RegExp(`Owner-entered type: ${type} \\(unverified\\)`));
    assert.match(ui.query('#task-evidence').textContent, new RegExp(`Local evidence request ID: ${body.requestId}`));
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal([...storage.values()].some(value => String(value).includes(body.title)), false);
    assert.ok(ui.requests.every(request => request.path.startsWith('/api/tasks/')));
  }
});

test('URL-free non-note uncertain saves retain text and never replay or persist it in browser storage', async () => {
  for (const type of ['email', 'meeting', 'teams', 'document']) {
    const storage = new Map();
    const ui = await setup(storage);
    ui.context.task = { id: 'fake-a', title: 'Synthetic', revision: 1, evidence: [] };
    ui.run("workspace.tasks = [task]; accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    ui.context.fetch = async (path, options = {}) => {
      ui.requests.push({ path, ...options });
      if (options.method === 'POST') throw new TypeError('Synthetic lost reply');
      return Response.json({ createdAt: null, history: [], messages: [] });
    };
    await ui.run('openConversation(task)');
    const form = ui.query('#evidence-form');
    form.elements.type.value = type;
    form.elements.title.value = 'Synthetic private title';
    form.elements.note.value = 'Synthetic private summary';
    await form.fire('submit');
    const body = JSON.parse(ui.requests.find(request => request.method === 'POST').body);
    assert.match(ui.query('#evidence-form [data-save-status]').textContent, new RegExp(body.requestId));
    assert.match(ui.query('#evidence-form [data-save-status]').textContent, /outcome could not be confirmed/);
    assert.equal(form.elements.note.value, body.note);
    await form.fire('submit');
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal([...storage.values()].some(value => String(value).includes(body.note)), false);
  }
});

test('URL-free evidence unlocks only for structured definitive 4xx rejection', async () => {
  for (const outcome of ['raw', 'malformed', 'unstructured', 'structured']) {
    const ui = await setup();
    ui.context.task = { id: 'fake-a', title: 'Synthetic', revision: 1, evidence: [] };
    ui.run("workspace.tasks = [task]; accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    ui.context.fetch = async (path, options = {}) => {
      ui.requests.push({ path, ...options });
      if (options.method !== 'POST') return Response.json({ createdAt: null, history: [], messages: [] });
      if (outcome === 'raw') return new Response('Synthetic proxy rejection', { status: 400 });
      if (outcome === 'malformed') return new Response('{not json', { status: 409, headers: { 'Content-Type': 'application/json' } });
      if (outcome === 'unstructured') return Response.json({ message: 'Not a structured error' }, { status: 400 });
      return Response.json({ error: 'Synthetic validation error' }, { status: 400 });
    };
    await ui.run('openConversation(task)');
    const form = ui.query('#evidence-form');
    form.elements.type.value = 'email';
    form.elements.title.value = 'Retain synthetic title';
    form.elements.note.value = 'Retain synthetic summary';
    await form.fire('submit');
    const first = JSON.parse(ui.requests.find(request => request.method === 'POST').body);
    const status = ui.query('#evidence-form [data-save-status]').textContent;
    const rejected = outcome === 'structured';
    assert.match(status, rejected ? /Save rejected/ : /outcome could not be confirmed/);
    assert.equal(form.elements.note.value, first.note);
    assert.equal(ui.query('#evidence-form button[type="submit"]').disabled, !rejected);
    if (!rejected) assert.match(status, new RegExp(first.requestId));
    await form.fire('submit');
    const writes = ui.requests.filter(request => request.method === 'POST');
    assert.equal(writes.length, rejected ? 2 : 1);
    if (rejected) assert.notEqual(JSON.parse(writes[1].body).requestId, first.requestId);
  }
});

test('append-only task note forms also retain unknown malformed 4xx outcomes and unlock structured rejections', async () => {
  for (const outcome of ['raw', 'malformed', 'unstructured', 'structured']) {
    const ui = await setup();
    ui.run("conversationTaskId = 'fake-a'; accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    const form = ui.query('#conversation-form');
    form.elements.text.value = 'Synthetic retained note';
    ui.context.fetch = async (path, options = {}) => {
      ui.requests.push({ path, ...options });
      if (outcome === 'raw') return new Response('Synthetic proxy rejection', { status: 400 });
      if (outcome === 'malformed') return new Response('{not json', { status: 409, headers: { 'Content-Type': 'application/json' } });
      if (outcome === 'unstructured') return Response.json({ message: 'Not a structured error' }, { status: 400 });
      return Response.json({ error: 'Synthetic validation error' }, { status: 400 });
    };
    await form.fire('submit');
    const rejected = outcome === 'structured';
    assert.match(ui.query('#conversation-form [data-save-status]').textContent, rejected ? /Save rejected/ : /outcome could not be confirmed/);
    assert.equal(form.elements.text.value, 'Synthetic retained note');
    assert.equal(ui.query('#conversation-form button[type="submit"]').disabled, !rejected);
    await form.fire('submit');
    assert.equal(ui.requests.filter(request => request.method === 'POST').length, rejected ? 2 : 1);
  }
});

test('evidence trust and type labels preserve unknown and source provenance without owner attribution', async () => {
  const ui = await setup();
  ui.context.task = { id: 'fake-a', title: 'Synthetic', revision: 1, evidence: [
    { title: '<source>', type: 'email', provenance: 'authorized-source-untrusted-evidence' },
    { title: '<unknown>', type: 'teams' },
    { title: '<other>', type: 'meeting', provenance: 'other' },
    { title: '<owner>', type: 'document', provenance: 'owner-provided-unverified' }
  ] };
  ui.run("workspace.tasks = [task]; accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
  ui.context.fetch = async () => Response.json({ createdAt: null, history: [], messages: [] });
  await ui.run('openConversation(task)');
  const cards = ui.query('#task-evidence').children;
  assert.match(cards[0].textContent, /Authorized-source evidence/);
  assert.match(cards[0].textContent, /Evidence type: email \(unverified\)/);
  for (const card of cards.slice(0, 3)) {
    assert.doesNotMatch(card.textContent, /Owner-provided|Owner-entered/);
  }
  assert.match(cards[1].textContent, /Provenance unknown; not source-verified/);
  assert.match(cards[2].textContent, /Provenance unknown; not source-verified/);
  assert.match(cards[3].textContent, /Owner-provided.*Owner-entered type: document \(unverified\)/s);
  assert.match(cards[0].textContent, /<source>/);
});

test('typed evidence markup labels its fields and explains their unverified local scope', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<label>Evidence type<select name="type">/);
  for (const type of ['email', 'meeting', 'teams', 'document', 'note']) {
    assert.match(html, new RegExp(`<option value="${type}">`));
  }
  assert.match(html, /Nothing is fetched or contacted when saved/);
  assert.match(html, /<form id="evidence-form"[\s\S]*?<p data-save-status[^>]*role="status"/);
  assert.match(html, /<input name="title" required maxlength="500">/);
  assert.match(html, /<textarea name="note" maxlength="8000"/);
});

test('task next-owner editor binds exact text and revision to its target, protects pending edits and renders inert history', async () => {
  const ui = await setup();
  const task = { id: 'fake-a', title: 'Synthetic task', revision: 4, status: 'done', evidence: [], history: [] };
  ui.context.task = task;
  ui.context.otherTask = { id: 'fake-b', title: 'Other', revision: 1 };
  ui.run("workspace.tasks = [task, otherTask]; accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf'; refreshState = async () => {};");
  let mutation = deferred();
  ui.context.fetch = async (path, options = {}) => {
    ui.requests.push({ path, ...options });
    if (options.method === 'POST') return mutation.promise;
    return Response.json({ createdAt: null, history: task.history, messages: [] });
  };
  await ui.run('openConversation(task)');
  assert.match(ui.query('#task-owner-current').textContent, /Unknown/);
  const form = ui.query('#task-owner-form');
  const unchanged = form.fire('submit');
  assert.deepEqual(JSON.parse(ui.requests.find(request => request.method === 'POST').body), { nextOwner: '', revision: 4 });
  mutation.resolve(Response.json({
    task,
    receipt: { kind: 'next-owner-unchanged', status: 'unchanged', taskId: task.id, nextOwner: '', requestRevision: 4, appliedRevision: 4 }
  }));
  await unchanged;
  assert.equal(task.revision, 4);
  assert.deepEqual(task.history, []);
  assert.match(form.querySelector('[data-save-status]').textContent, /already matches; no task history or activity was changed/);
  mutation = deferred();
  const label = '<img src=x onerror=alert(1)> & fake';
  form.elements.nextOwner.value = label;
  await ui.run('openConversation(otherTask)');
  assert.equal(ui.run('conversationTaskId'), 'fake-a');
  const pending = form.fire('submit');
  await form.fire('submit');
  await ui.query('#close-conversation').fire('click');
  assert.equal(ui.query('#conversation-dialog').open, true);
  assert.deepEqual(JSON.parse(ui.requests.filter(request => request.method === 'POST').at(-1).body), { nextOwner: label, revision: 4 });
  task.revision = 5;
  task.nextOwner = label;
  task.history = [{ kind: 'next-owner-changed', previous: null, nextOwner: label, requestRevision: 4, appliedRevision: 5 }];
  mutation.resolve(Response.json({ task }));
  await pending;
  assert.match(ui.query('#task-owner-current').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(ui.query('#task-timeline').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 2);
  mutation = deferred();
  form.elements.nextOwner.value = '';
  const clear = form.fire('submit');
  assert.deepEqual(JSON.parse(ui.requests.filter(request => request.method === 'POST').at(-1).body), { nextOwner: '', revision: 5 });
  task.revision = 6;
  task.nextOwner = '';
  task.history.push({ kind: 'next-owner-changed', previous: label, nextOwner: '', requestRevision: 5, appliedRevision: 6 });
  mutation.resolve(Response.json({ task }));
  await clear;
  assert.match(ui.query('#task-owner-current').textContent, /Unknown/);
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 3);
  mutation = deferred();
  const repeatedClear = form.fire('submit');
  mutation.resolve(Response.json({
    task,
    receipt: { kind: 'next-owner-unchanged', status: 'unchanged', taskId: task.id, nextOwner: '', requestRevision: 6, appliedRevision: 6 }
  }));
  await repeatedClear;
  assert.equal(task.revision, 6);
  assert.equal(task.history.length, 2);
  assert.match(form.querySelector('[data-save-status]').textContent, /already matches; no task history or activity was changed/);
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 4);
  assert.ok(ui.requests.every(request => request.path.startsWith('/api/tasks/')));
});

test('next-owner markup exposes a labeled local edit and a live save status', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<form id="task-owner-form"[\s\S]*?<label>Next owner label<input name="nextOwner"[^>]*><\/label>/);
  assert.match(html, /<label>Next owner label<input name="nextOwner" maxlength="250"/);
  assert.match(html, /<form id="task-owner-form"[\s\S]*?<p data-save-status[^>]*role="status"/);
  assert.match(html, /does not identify an account, assign work, contact anyone, or authorize any action/);
});

test('uncertain next-owner saves retain the exact target and text and never retry', async () => {
  for (const outcome of ['dropped', 'invalid-receipt', 'stale']) {
    const ui = await setup();
    ui.context.task = { id: 'fake-a', title: 'Synthetic', revision: 2, evidence: [], history: [] };
    ui.context.otherTask = { id: 'fake-b', title: 'Other', revision: 1 };
    ui.run("workspace.tasks = [task, otherTask]; accessToken = 'synthetic-owner-capability'; csrfToken = 'synthetic-csrf';");
    ui.context.fetch = async (path, options = {}) => {
      ui.requests.push({ path, ...options });
      if (options.method !== 'POST') return Response.json({ createdAt: null, history: [], messages: [] });
      if (outcome === 'dropped') throw new TypeError('Synthetic lost reply');
      if (outcome === 'stale') return Response.json({ error: 'Task changed' }, { status: 409 });
      return Response.json({ task: { id: 'fake-a', revision: 3, nextOwner: 'wrong', history: [] } });
    };
    await ui.run('openConversation(task)');
    const form = ui.query('#task-owner-form');
    form.elements.nextOwner.value = 'Keep this text';
    await form.fire('submit');
    assert.equal(form.elements.nextOwner.value, 'Keep this text');
    assert.match(ui.query('#task-owner-form [data-save-status]').textContent, outcome === 'stale' ? /Save rejected/ : /outcome could not be confirmed/);
    await ui.run('openConversation(otherTask)');
    assert.equal(ui.run('conversationTaskId'), 'fake-a');
    if (outcome !== 'stale') {
      await form.fire('submit');
      assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
      assert.equal(ui.query('#task-owner-form button[type="submit"]').disabled, true);
    }
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
