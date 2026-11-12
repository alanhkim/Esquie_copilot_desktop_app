import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { completedWorkTasks, recordedTimestamp } from '../public/completed-work.mjs';
import { laneMove, matchingTasks } from '../public/task-board.mjs';
import { createTextElement } from '../public/account-workspace.mjs';

class Element {
  dataset = {};
  children = [];
  listeners = {};
  attributes = {};
  value = '';
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  fire(name, event = {}) { return this.listeners[name]?.(event); }
}

async function board() {
  const elements = new Map();
  const document = {
    createElement: tag => Object.assign(new Element(), { tag }),
    querySelector: selector => {
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector);
    }
  };
  const context = vm.createContext({
    document, laneMove, matchingTasks, completedWorkTasks, recordedTimestamp, createTextElement, URLSearchParams,
    crypto: { randomUUID: () => 'fake-request' }, location: { hash: '' },
    sessionStorage: { getItem: () => null }
  });

  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('const $'), source.indexOf('function renderDrafts()')), context);
  vm.runInContext(`
    globalThis.calls = [];
    updateTask = async (id, update) => { calls.push({ id, update }); };
    globalThis.draw = state => { workspace = state; renderTasks(); };
  `, context);
  return { context, elements, document };
}

test('task board markup exposes a named, keyboard-focusable live region with a visible focus style', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  ]);
  const boards = [...html.matchAll(/<div\b[^>]*\bid="task-list"[^>]*>/g)];
  assert.equal(boards.length, 1);
  const tag = boards[0][0];
  assert.match(tag, /\bclass="[^"]*\btask-board\b[^"]*"/);
  assert.match(tag, /\brole="region"/);
  assert.match(tag, /\baria-label="[^"]*\S[^"]*"/);
  assert.match(tag, /\btabindex="0"/);
  assert.match(tag, /\baria-live="polite"/);
  assert.match(css, /\.task-board:focus-visible\s*\{[^}]*\boutline:\s*2px solid var\(--accent\)/);
  assert.match(html, /<button[^>]*data-view="completed-work"[^>]*>[\s\S]*?Completed work/);
  assert.match(html, /id="view-completed-work"[^>]*aria-labelledby="completed-work-heading"/);
  assert.match(html, /id="completed-work-list"[^>]*role="region"[^>]*aria-label="Completed work details"[^>]*tabindex="0"/);
  assert.match(html, /id="completed-work-period"[^>]*aria-label="Filter completed work by completion period"/);
  assert.match(css, /\.completed-work-region:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  const definitions = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
  for (const [, name] of css.matchAll(/var\((--[\w-]+)\)/g)) assert.ok(definitions.has(name), `${name} is undefined`);
});

test('desktop sidebar is scrollable without shrinking its content or changing mobile navigation', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /@media\s*\(min-width:\s*651px\)\s*\{\s*\.sidebar\s*\{\s*overflow-y:\s*auto;\s*\}\s*\.sidebar\s*>\s*\*\s*\{\s*flex-shrink:\s*0;\s*\}\s*\}/);
  assert.match(css, /@media\s*\(max-width:\s*650px\)[\s\S]*?\.sidebar\s*\{[^}]*position:\s*static/);
  assert.match(css, /@media\s*\(max-width:\s*650px\)[\s\S]*?\.navigation\s*\{[^}]*overflow-x:\s*auto/);
});

test('search matches only task-local notes and evidence and preserves completed filtering', () => {
  const tasks = [
    { id: 'a', title: 'Alpha', details: 'Local details', status: 'next', evidence: [{ title: 'Citation', note: '<img onerror=alert(1)>', url: 'https://example.invalid/proof' }] },
    { id: 'b', title: 'Beta', status: 'waiting' },
    { id: 'c', title: 'Completed', status: 'done' }
  ];
  const conversations = [
    { taskId: 'b', role: 'owner', text: 'Owner needle' },
    { taskId: 'a', role: 'assistant', text: 'Worker result' },
    { taskId: 'c', text: 'Owner needle' },
    { taskId: 'missing', text: 'Orphan note' }
  ];
  const find = (query, showDone = false) => matchingTasks(tasks, conversations, query, showDone).map(task => task.id);
  assert.deepEqual(find(' OWNER NEEDLE '), ['b']);
  assert.deepEqual(find('owner needle', true), ['b', 'c']);
  for (const query of ['citation', '<img', 'example.invalid/proof', 'worker result', 'local details']) {
    assert.deepEqual(find(query), ['a']);
  }
  assert.deepEqual(find('orphan note'), []);
  assert.deepEqual(find(''), ['a', 'b']);
  assert.equal(tasks[2].status, 'done');
});

test('lane intents retain the displayed revision, ignore same-lane drops and never drag completed work', () => {
  const task = { id: 'fake', status: 'next', revision: 3 };
  assert.deepEqual(laneMove(task, 'waiting', { drag: true }), { status: 'waiting', revision: 3 });
  assert.equal(laneMove(task, 'next'), null);
  assert.equal(laneMove(task, 'done', { drag: true }), null);
  assert.equal(laneMove({ ...task, status: 'done' }, 'next', { drag: true }), null);
  assert.deepEqual(laneMove({ ...task, status: 'done' }, 'doing'), { status: 'doing', revision: 3 });
  assert.throws(() => laneMove(task, 'unknown'), /supported task lane/);
  assert.equal(task.status, 'next');
});

test('completed-work periods use recorded timestamps and owner calendar boundaries, keeping unknown and reopened tasks distinct', () => {
  const now = new Date('2026-06-15T00:30:00.000Z');
  const tasks = [
    { id: 'window-start', status: 'done', completedAt: '2026-05-16T07:00:00.000Z' },
    { id: 'before-window', status: 'done', completedAt: '2026-05-16T06:59:59.000Z' },
    { id: 'quarter-start', status: 'done', completedAt: '2026-04-01T07:00:00.000Z' },
    { id: 'before-quarter', status: 'done', completedAt: '2026-04-01T06:59:59.000Z' },
    { id: 'year-start', status: 'done', completedAt: '2026-01-01T08:00:00.000Z' },
    { id: 'prior-year', status: 'done', completedAt: '2026-01-01T07:59:59.000Z' },
    { id: 'ninety-start', status: 'done', completedAt: '2026-03-17T07:00:00.000Z' },
    { id: 'before-ninety-start', status: 'done', completedAt: '2026-03-17T06:59:59.000Z' },
    { id: 'today', status: 'done', completedAt: '2026-06-15T06:30:00.000Z' },
    { id: 'future-owner-day', status: 'done', completedAt: '2026-06-15T07:00:00.000Z' },
    { id: 'missing', status: 'done', completedAt: null, updatedAt: '2026-06-14T12:00:00.000Z' },
    { id: 'invalid', status: 'done', completedAt: 'not-a-date' },
    { id: 'timezone-less', status: 'done', completedAt: '2026-06-14T10:00:00' },
    { id: 'reopened', status: 'next', completedAt: '2026-06-14T12:00:00.000Z' }
  ];
  const select = period => completedWorkTasks(tasks, [], '', '', period, 'America/Los_Angeles', now);
  const ids = period => select(period).tasks.map(task => task.id);
  assert.deepEqual(ids('last30'), ['window-start', 'today']);
  assert.deepEqual(ids('last90'), ['window-start', 'before-window', 'quarter-start', 'before-quarter', 'ninety-start', 'today']);
  assert.deepEqual(ids('quarter'), ['window-start', 'before-window', 'quarter-start', 'today']);
  assert.deepEqual(ids('year'), ['window-start', 'before-window', 'quarter-start', 'before-quarter', 'year-start', 'ninety-start', 'before-ninety-start', 'today']);
  assert.deepEqual(ids('unknown'), ['missing', 'invalid', 'timezone-less']);
  assert.deepEqual(ids('all'), tasks.filter(task => task.status === 'done').map(task => task.id));
  assert.equal(recordedTimestamp('2026-02-31T00:00:00.000Z'), '');
  assert.equal(recordedTimestamp('2026-03-31T10:00:00'), '');
  assert.equal(select('last30').available, true);
  for (const timezone of ['', 'Not/A_Timezone']) {
    const unavailable = completedWorkTasks(tasks, [], '', '', 'last30', timezone, now);
    assert.equal(unavailable.available, false);
    assert.match(unavailable.reason, /owner timezone/);
    assert.equal(completedWorkTasks(tasks, [], '', '', 'all', timezone, now).available, true);
    assert.equal(completedWorkTasks(tasks, [], '', '', 'unknown', timezone, now).available, true);
    assert.deepEqual(
      completedWorkTasks(tasks, [], '', '', 'unknown', timezone, now).tasks.map(task => task.id),
      ['missing', 'invalid', 'timezone-less']
    );
  }
  const snapshot = JSON.stringify(tasks);
  assert.equal(select('all').tasks.some(task => task.id === 'reopened'), false);
  assert.equal(JSON.stringify(tasks), snapshot, 'filtering and formatting do not mutate saved task state');
});

test('completed-work day windows follow owner-local calendar dates across a daylight-saving transition', () => {
  const tasks = [
    { id: 'first-local-date', status: 'done', completedAt: '2026-02-07T08:00:00.000Z' },
    { id: 'before-first-local-date', status: 'done', completedAt: '2026-02-07T07:59:59.000Z' },
    { id: 'dst-today', status: 'done', completedAt: '2026-03-08T08:30:00.000Z' },
    { id: 'next-owner-date', status: 'done', completedAt: '2026-03-09T07:00:00.000Z' }
  ];
  const result = completedWorkTasks(tasks, [], '', '', 'last30', 'America/Los_Angeles', new Date('2026-03-08T08:30:00.000Z'));
  assert.equal(result.available, true);
  assert.deepEqual(result.tasks.map(task => task.id), ['first-local-date', 'dst-today']);
});

test('completed-work filters compose exact account IDs and local task notes/evidence without inferred assignments', () => {
  const tasks = [
    { id: 'account-a', title: 'Same label', status: 'done', accountId: 'account-id-a', completedAt: '2026-03-15T12:00:00.000Z', evidence: [{ title: 'Evidence needle', url: 'https://example.invalid/inert' }] },
    { id: 'account-b', title: 'Same label', status: 'done', accountId: 'account-id-b', completedAt: '2026-03-15T12:00:00.000Z' },
    { id: 'unassigned', title: 'Unassigned work', status: 'done', completedAt: '2026-03-15T12:00:00.000Z' },
    { id: 'open', title: 'Matching open task', status: 'doing', completedAt: '2026-03-15T12:00:00.000Z' }
  ];
  const conversations = [{ taskId: 'account-b', role: 'owner', text: 'Private note needle' }];
  const find = (query, account) => completedWorkTasks(
    tasks, conversations, query, account, 'last30', 'UTC', new Date('2026-03-20T12:00:00Z')
  ).tasks.map(task => task.id);
  assert.deepEqual(find('', 'account-id-a'), ['account-a']);
  assert.deepEqual(find('note needle', ''), ['account-b']);
  assert.deepEqual(find('evidence needle', 'account-id-a'), ['account-a']);
  assert.deepEqual(find('', 'account-id-b'), ['account-b']);
  assert.deepEqual(find('', 'unassigned'), ['unassigned']);
  assert.deepEqual(find('inert', 'account-id-b'), []);
});

test('rendering, search, lane selection and cancelled drag do not mutate status; buttons and drops carry explicit revisions', async () => {
  const { context, elements, document } = await board();
  const title = '<img src=x onerror=alert(1)>';
  const task = { id: 'fake', title, status: 'next', revision: 4 };
  const state = { tasks: [task], conversations: [] };
  context.draw(state);
  const lanes = elements.get('#task-list').children;
  const card = lanes[0].children[1];
  const content = card.children[1];
  assert.equal(content.children[0].textContent, title);
  const [select, move, handle] = content.children.at(-1).children;
  assert.equal(select.attributes['aria-label'], `Destination lane for ${title}`);
  assert.equal(move.disabled, true);
  select.value = 'waiting';
  select.fire('change');
  assert.equal(context.calls.length, 0);
  assert.equal(task.status, 'next');
  await move.fire('click');
  assert.equal(context.calls[0].update.revision, 4);
  assert.equal(context.calls[0].update.status, 'waiting');
  select.value = 'done';
  select.fire('change');
  assert.equal(move.textContent, 'Complete task');
  assert.equal(context.calls.length, 1);
  const event = { preventDefault() {}, dataTransfer: { setData() {} } };
  handle.fire('dragstart', event);
  handle.fire('dragend');
  lanes[2].fire('drop', event);
  assert.equal(context.calls.length, 1);
  handle.fire('dragstart', event);
  lanes[0].fire('drop', event);
  assert.equal(context.calls.length, 1);
  handle.fire('dragstart', event);
  lanes[2].fire('drop', event);
  assert.equal(context.calls[1].update.status, 'waiting');
  assert.equal(context.calls[1].update.revision, 4);
  assert.equal(task.status, 'next');
  elements.get('#show-done').checked = true;
  context.draw({ tasks: [{ ...task, status: 'done' }], conversations: [] });
  const completed = elements.get('#task-list').children[3].children[1];
  const completedMoves = completed.children[1].children.at(-1).children;
  assert.equal(completedMoves.length, 2);
  completedMoves[0].value = 'doing';
  completedMoves[0].fire('change');
  assert.equal(completedMoves[1].textContent, 'Reopen in In progress');
  assert.equal(context.calls.length, 2);
  elements.get('#task-search').value = 'no match';
  context.draw(state);
  assert.equal(context.calls.length, 2);
  assert.equal(document.querySelector('#task-list').children[0].textContent, 'No tasks match that search or account filter.');
});
