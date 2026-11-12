import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { laneMove, matchingTasks } from '../public/task-board.mjs';

class Element {
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
    document, laneMove, matchingTasks, URLSearchParams,
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
  assert.equal(document.querySelector('#task-list').children[0].textContent, 'No tasks match that search.');
});
