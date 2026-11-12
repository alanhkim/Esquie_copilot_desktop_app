import { laneMove, matchingTasks } from './task-board.mjs';
import { applyAccountSaveResult, bindAccountFormSubmission, canReplaceAccountTarget, createTextElement, inertHttpUrl, renderAccountRecords } from './account-workspace.mjs';
import {
  confirmOutcomeImport,
  createOutcomeImportWorkflow,
  readLocalApiResponse,
  refreshAfterOutcomeImport,
  syncOutcomeImportControls
} from './outcome-import-workflow.mjs';

const $ = selector => document.querySelector(selector);
const laneNames = { next: 'Next up', doing: 'In progress', waiting: 'Waiting', done: 'Completed' };
const viewNames = {
  setup: 'Workspace setup',
  ask: 'Ask Esquie',
  board: 'Task board',
  drafts: 'Draft Studio',
  links: 'Links',
  activity: 'Activity',
  operations: 'Operations',
  pipeline: 'Pipeline',
  outcomes: 'Monthly Outcomes',
  portfolio: 'Accounts',
  demo: 'Create Demo'
};

let workspace = { tasks: [], drafts: [], activity: [] };
const accountNoteDrafts = new Map();
const pendingAccountNotes = new Set();
const expandedAccountHistories = new Set();
let editingId = null;
let importingSource = null;
let sourceSettingsRendered = false;
let outlookRequestId = crypto.randomUUID();
let outlookMessageId = '';
let outlookSourcePreview = null;
let outlookSubmitting = false;
let meetingListAttempt = null;
const outlookSourceRecheckMessage = 'This historical preview cannot create a reply draft: its source-result revision is missing or invalid. Run a new bounded source check in Operations, then select the new mail preview in Activity. Your unsaved reply text is retained; copy it somewhere safe before clearing it to switch previews. No manual-ID fallback will be used.';
const taskSourceRecheckMessage = 'This historical preview cannot create a task: its source-result revision is missing or invalid. Run a new bounded source check in Operations, then explicitly select its preview in Activity. Entered task text is retained; no manual-task fallback will be used.';
let editingDraftId = null;
let editingRevision = 0;
let editingDraftRevision = 0;
let csrfToken = '';
let noticeTimer;
let conversationTaskId = null;
let conversationViewRevision = 0;
let conversationReadRevision = 0;
const localFormOperations = new WeakMap();
let profileRendered = false;
let preferencesRendered = false;
let refreshing = false;
let setupRevision = null;
let setupRecord = null;
let latestConnections = null;
let draggedTask = null;
let accessToken = '';
let accessStorageWarning = '';
const pendingSourceReadKeys = new Set();
const launchCapability = new URLSearchParams(location.hash.slice(1)).get('access');
try {
  if (launchCapability !== null) {
    if (/^[A-Za-z0-9_-]{43}$/.test(launchCapability)) {
      accessToken = launchCapability;
      sessionStorage.setItem('esquie-owner-access', accessToken);
    }
  } else {
    accessToken = sessionStorage.getItem('esquie-owner-access') || '';
  }
} catch {
  if (launchCapability && /^[A-Za-z0-9_-]{43}$/.test(launchCapability)) accessToken = launchCapability;
  accessStorageWarning = 'Per-window authorization storage is unavailable. This launch works in memory only; reopen the private launch file after a reload.';
}
if (launchCapability !== null) history.replaceState(null, '', '#board');

function showNotice(message, error = false) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4200);
}

async function api(path, options = {}, observeResponse = null, expectedStatus) {
  if (!path.startsWith('/api/')) throw new Error('Only local API paths are accepted.');
  if (!accessToken) throw new Error('Owner launch authorization is missing. Open your private Esquie launch file or the desktop application.');
  const headers = new Headers(options.headers || {});
  headers.set('X-Esquie-Access', accessToken);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('X-Esquie-CSRF', csrfToken);
  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  observeResponse?.(response);
  const data = await readLocalApiResponse(response);
  if (expectedStatus !== undefined && response.status !== expectedStatus) throw new Error('Unexpected response status.');
  return data;
}

function localFormBusy(form) {
  const operation = localFormOperations.get(form);
  if (!operation) return false;
  showNotice(operation.blocked
    ? 'Check the saved records after reloading before another save. Your text is retained; no retry was made.'
    : 'Wait for this save to finish before submitting, closing or changing targets. Your text is retained.', true);
  return true;
}

function localFormSnapshot(form) {
  return JSON.stringify([...form.elements].filter(control => control.name).map(control => [control.name, control.value, control.checked]));
}

function lockLocalForm(form) {
  const controls = [...form.elements].map(control => [control, control.disabled]);
  for (const [control] of controls) control.disabled = true;
  return () => { for (const [control, disabled] of controls) control.disabled = disabled; };
}

function savedLocalItem(item, expectedId = null, versioned = false) {
  if (!item || typeof item.id !== 'string' || !item.id || (expectedId && item.id !== expectedId) ||
      (versioned && !Number.isInteger(item.revision))) throw new Error('The saved item receipt does not match this editor.');
  return item;
}

async function saveLocalForm(form, { path, method, body, validate, accept, success, refresh = refreshState }) {
  if (localFormBusy(form)) return;
  const operation = { blocked: false };
  localFormOperations.set(form, operation);
  const snapshot = localFormSnapshot(form);
  const status = form.querySelector('[data-save-status]');
  status.textContent = 'Saving the submitted version locally. No automatic retry.';
  let unlock = lockLocalForm(form);
  let saved = false;
  let rejected = false;
  try {
    const result = await api(path, { method, body: JSON.stringify(body) }, response => { rejected = response.status >= 400 && response.status < 500; });
    validate?.(result);
    saved = true;
    const unchanged = snapshot === localFormSnapshot(form);
    unlock();
    accept?.(result, unchanged);
    unlock = lockLocalForm(form);
    const message = (typeof success === 'function' ? success(result) : success) +
      (unchanged ? '' : ' Newer edits are retained in the form and were not saved.');
    try { await refresh(); }
    catch (error) {
      status.textContent = `${message} The save succeeded, but display refresh failed: ${error.message}. Do not resubmit the saved version.`;
      showNotice(status.textContent, true);
      return;
    }
    status.textContent = message;
    showNotice(message);
  } catch (error) {
    operation.blocked = saved || !rejected;
    status.textContent = saved
      ? 'The save succeeded, but the editor could not update. Reload and check saved records before another save; your text is retained.'
      : rejected ? `Save rejected: ${error.message}. Your text is retained.`
        : 'Save outcome could not be confirmed. Reload and check saved records before another save; your text is retained. No automatic retry.';
    showNotice(status.textContent, true);
  } finally {
    unlock();
    if (operation.blocked) {
      form.querySelector('button[type="submit"]').disabled = true;
    } else {
      localFormOperations.delete(form);
    }
  }
}

function makeElement(tag, className, text) {
  return createTextElement(document, tag, className, text);
}

function validSourceResultRevision(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

function outlookPreviewNeedsRecheck() {
  return outlookSourcePreview !== null && !validSourceResultRevision(outlookSourcePreview.resultId);
}

function updateOutlookDraftAvailability() {
  $('#outlook-draft-form button[type="submit"]').disabled = outlookSubmitting || outlookPreviewNeedsRecheck() ||
    !latestConnections?.email?.available || !workspace.sourceConsent?.allowReplyDrafts;
}

function renderOutlookSourcePreview() {
  const host = $('#outlook-source-preview');
  host.replaceChildren();
  updateOutlookDraftAvailability();
  host.append(makeElement('h3', '', 'Selected source preview - read-only, incomplete evidence'));
  host.append(makeElement('p', 'muted', 'Untrusted historical preview only, not a complete thread or verified participants. Review the current conversation and recipients in Outlook. This context does not authorize a draft.'));
  if (!outlookSourcePreview) {
    host.append(makeElement('p', '', 'No selected preview for this exact message ID. Select a mail preview in Activity to display its evidence.'));
    return;
  }
  const preview = outlookSourcePreview;
  if (outlookPreviewNeedsRecheck()) {
    const warning = makeElement('p', 'job-error', outlookSourceRecheckMessage);
    warning.setAttribute('role', 'status');
    host.append(warning);
  }
  host.append(makeElement('p', 'source-excerpt', `Message ID: ${preview.messageId}\nSource item key: ${preview.sourceKey}\nSource check: ${preview.jobId}\nRecorded: ${preview.recordedAt || 'not provided'}\nCoverage: ${preview.coverage || 'not provided'}`));
  host.append(makeElement('h4', 'source-excerpt', preview.title || 'Untitled source item'));
  host.append(makeElement('p', 'source-excerpt', preview.excerpt || 'No excerpt provided in the selected preview.'));
  host.append(makeElement('small', '', `Untrusted source evidence${preview.excerptTruncated ? ' - excerpt truncated at 600 characters' : ''}${preview.contentAvailable === false ? ' - metadata only, content unavailable' : ''}`));
  for (const limitation of preview.limitations) host.append(makeElement('p', 'muted', limitation));
  const url = inertHttpUrl(preview.url);
  if (url) {
    const link = makeElement('a', 'saved-link', 'Open original reference manually');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    host.append(link);
  }
}

function selectOutlookSource(job, source, item) {
  const preview = {
    messageId: item.id, sourceKey: item.sourceKey, jobId: job.id, resultId: source.resultId,
    recordedAt: job.updatedAt, title: item.title, excerpt: item.excerpt,
    url: item.url, excerptTruncated: item.excerptTruncated,
    contentAvailable: item.contentAvailable,
    coverage: typeof source.coverage === 'object' ? source.coverage?.status : source.coverage,
    limitations: [...(source.coverage?.limitations || [])]
  };
  const form = $('#outlook-draft-form');
  if (outlookSubmitting) {
    showNotice('Wait for the current draft request to finish. Do not retry an uncertain outcome.', true);
    return;
  }
  if (JSON.stringify(preview) !== JSON.stringify(outlookSourcePreview)) {
    if (form.elements.text.value) {
      showNotice('Source not changed. Copy your unsaved reply somewhere safe, then clear the reply text before choosing another source.', true);
      return;
    }
    outlookSourcePreview = preview;
    outlookMessageId = item.id;
    form.elements.messageId.value = item.id;
    form.elements.replyAll.value = 'false';
    outlookRequestId = crypto.randomUUID();
    $('#outlook-draft-result').textContent = 'Source preview selected locally. No Outlook request has been made.';
  }
  renderOutlookSourcePreview();
  navigate('drafts');
  form.scrollIntoView({ block: 'center' });
}

function reconcileOutlookMessageId() {
  const form = $('#outlook-draft-form');
  if (form.elements.messageId.value === outlookMessageId) return true;
  if (outlookSubmitting || form.elements.text.value) {
    form.elements.messageId.value = outlookMessageId;
    showNotice('Message ID not changed. Wait for any pending request, then copy and clear the unsaved reply before changing its target.', true);
    return false;
  }
  outlookMessageId = form.elements.messageId.value;
  outlookSourcePreview = null;
  form.elements.replyAll.value = 'false';
  outlookRequestId = crypto.randomUUID();
  $('#outlook-draft-result').textContent = 'Message ID changed; selected evidence cleared. No Outlook request has been made.';
  renderOutlookSourcePreview();
  return true;
}

function sourceReadKey(kind, reference) {
  return JSON.stringify([kind, reference.jobId, reference.resultId, reference.itemId]);
}

function sourceReadReceiptMatches(result, kind, reference) {
  const job = result?.job;
  const receiptReference = job?.payload?.sourceReference;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (!job || job.kind !== kind || !uuid.test(job.id || '') ||
      receiptReference?.jobId !== reference.jobId ||
      receiptReference?.resultId !== reference.resultId ||
      receiptReference?.itemId !== reference.itemId ||
      (result.deduplicated !== undefined && typeof result.deduplicated !== 'boolean')) return false;
  if (['queued', 'running'].includes(job.status)) return true;
  return job.status === 'partial' && result.deduplicated === true;
}

function acceptedSourceReadMessage(result, label) {
  const job = result.job;
  if (job.status === 'partial') return `The existing ${label} result is retained (job ${job.id}); no new read was queued.`;
  return result.deduplicated
    ? `The ${label} is already ${job.status} as job ${job.id}; no duplicate read was queued.`
    : `${label} accepted as job ${job.id} (${job.status}).`;
}

async function submitSourceRead(path, kind, reference, body, label) {
  const key = sourceReadKey(kind, reference);
  if (pendingSourceReadKeys.has(key)) {
    showNotice(`This exact ${label.toLocaleLowerCase()} is already being submitted. Check Activity before trying again.`, true);
    return;
  }
  pendingSourceReadKeys.add(key);
  renderJobs();
  try {
    let result;
    try {
      result = await api(path, { method: 'POST', body: JSON.stringify(body) });
    } catch (error) {
      if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
        showNotice(error.message || 'The server rejected this source read.', true);
      } else {
        showNotice(`The ${label.toLocaleLowerCase()} queue outcome is unknown; it may have been accepted. Inspect Activity before retrying. No automatic retry was made.`, true);
      }
      return;
    }
    if (!sourceReadReceiptMatches(result, kind, reference)) {
      showNotice(`The ${label.toLocaleLowerCase()} queue receipt was missing, malformed, or for different source evidence. The read may have been accepted; Inspect Activity before retrying. No automatic retry was made.`, true);
      return;
    }
    try {
      await refreshState();
      showNotice(acceptedSourceReadMessage(result, label));
    } catch {
      showNotice(`${acceptedSourceReadMessage(result, label)} Activity could not be refreshed. Inspect Activity before retrying.`, true);
    }
  } finally {
    pendingSourceReadKeys.delete(key);
    renderJobs();
  }
}

async function queueTeamsReplyRead(job, source, item) {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (!uuid.test(job?.id || '') || !uuid.test(source?.resultId || '') ||
      !/^[0-9a-f]{64}$/.test(item?.sourceKey || '') || typeof item?.id !== 'string' || !item.id) {
    showNotice('This Teams preview lacks a current source revision. Run a fresh bounded source check before reading replies.', true);
    return;
  }
  const sourceReference = Object.freeze({ jobId: job.id, resultId: source.resultId, itemId: item.sourceKey });
  await submitSourceRead('/api/teams/channel-replies', 'teams_channel_replies', sourceReference,
    { sourceReference }, 'Teams reply read');
}

async function queueFileContentRead(job, source, item) {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (!uuid.test(job?.id || '') || !uuid.test(source?.resultId || '') ||
      !/^[0-9a-f]{64}$/.test(item?.sourceKey || '') || typeof item?.id !== 'string' || !item.id ||
      typeof item?.eTag !== 'string' || !item.eTag || !Number.isSafeInteger(item?.size) || item.size < 0) {
    showNotice('This file preview lacks a current source revision. Run a fresh bounded source check before reading content.', true);
    return;
  }
  const sourceReference = Object.freeze({ jobId: job.id, resultId: source.resultId, itemId: item.sourceKey });
  if (pendingSourceReadKeys.has(sourceReadKey('file_content_read', sourceReference))) {
    showNotice('This exact selected-file read is already being submitted. Check Activity before trying again.', true);
    return;
  }
  if (!window.confirm('Read this one explicitly selected text/plain file now? The bounded text will be retained locally as untrusted evidence. No upload or task inference will occur.')) return;
  await submitSourceRead('/api/files/content-read', 'file_content_read', sourceReference,
    { sourceReference, confirmRead: true }, 'selected-file read');
}

function formatDate(value) {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function localAccounts() {
  return (workspace.records || []).filter(record => record.category === 'account');
}

function accountLabel(account, accounts = localAccounts()) {
  return accounts.some(other => other.id !== account.id && other.title === account.title)
    ? `${account.title} [${account.id}]` : account.title;
}

function renderAccountOptions(select, selected, filter = false) {
  select.replaceChildren();
  const append = (value, label) => {
    const option = makeElement('option', '', label);
    option.value = value;
    select.append(option);
  };
  if (filter) append('', 'All accounts');
  append(filter ? 'unassigned' : '', 'Unassigned');
  const accounts = localAccounts();
  for (const account of accounts) append(account.id, accountLabel(account, accounts));
  if (selected && !(filter && selected === 'unassigned') && !accounts.some(account => account.id === selected)) {
    append(selected, `Unavailable local account [${selected}]`);
  }
  select.value = selected;
}

function renderTasks() {
  const host = $('#task-list');
  const focusedControl = document.activeElement?.dataset?.taskControl;
  const focusedTask = document.activeElement?.closest?.('.task-card')?.dataset.taskId;
  const query = $('#task-search').value.trim().toLocaleLowerCase();
  const showDone = $('#show-done').checked;
  const accountFilter = $('#task-account-filter').value;
  renderAccountOptions($('#task-account-filter'), accountFilter, true);
  const matching = matchingTasks(workspace.tasks, workspace.conversations || [], query, showDone, accountFilter);
  const openCount = workspace.tasks.filter(task => task.status !== 'done').length;
  $('#open-count').textContent = String(openCount);
  $('#stat-open').textContent = String(openCount);
  $('#stat-waiting').textContent = String(workspace.tasks.filter(task => task.status === 'waiting').length);
  $('#stat-done').textContent = String(workspace.tasks.filter(task => task.status === 'done').length);
  host.replaceChildren();

  for (const status of ['next', 'doing', 'waiting', ...(showDone ? ['done'] : [])]) {
    const tasks = matching.filter(task => task.status === status);
    const lane = makeElement('section', 'task-lane');
    if (status !== 'done') {
      lane.addEventListener('dragover', event => {
        if (!draggedTask || !laneMove(draggedTask, status, { drag: true })) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      });
      lane.addEventListener('drop', event => {
        event.preventDefault();
        if (!draggedTask) return;
        const task = draggedTask;
        draggedTask = null;
        const update = laneMove(task, status, { drag: true });
        if (update) updateTask(task.id, update);
      });
    }
    const heading = makeElement('div', 'lane-heading');
    heading.append(makeElement('h2', '', laneNames[status]), makeElement('span', '', `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`));
    lane.append(heading);
    if (!tasks.length) {
      lane.append(makeElement('p', 'empty-lane', status === 'next' ? 'Nothing waiting here. Add a task when you are ready.' : 'No tasks in this section.'));
    } else {
      for (const task of tasks) lane.append(renderTask(task));
    }
    host.append(lane);
  }
  if (!matching.length && (query || accountFilter)) host.prepend(makeElement('p', 'empty-panel', 'No tasks match that search or account filter.'));
  if (focusedTask && focusedControl) {
    const card = [...host.querySelectorAll('.task-card')].find(item => item.dataset.taskId === focusedTask);
    const control = [...(card?.querySelectorAll('[data-task-control]') || [])].find(item => item.dataset.taskControl === focusedControl);
    control?.focus({ preventScroll: true });
  }
}

function renderTask(task) {
  const card = makeElement('article', 'task-card');
  card.dataset.taskId = task.id;
  const complete = makeElement('button', `task-marker${task.status === 'done' ? ' done' : ''}`, task.status === 'done' ? '✓' : '');
  complete.type = 'button';
  complete.dataset.taskControl = 'complete';
  complete.setAttribute('aria-label', task.status === 'done' ? 'Reopen task' : 'Complete task');
  complete.addEventListener('click', () => updateTask(task.id, laneMove(task, task.status === 'done' ? 'next' : 'done')));

  const content = makeElement('div', 'task-content');
  content.append(makeElement('h3', 'task-title', task.title));
  if (task.details) content.append(makeElement('p', 'task-details', task.details));
  const account = localAccounts().find(item => item.id === task.accountId);
  const metadata = [
    laneNames[task.status] || 'Next up',
    task.accountId ? `Account: ${account ? accountLabel(account) : `Unavailable [${task.accountId}]`}` : 'Unassigned',
    task.priority === 'important' ? 'Important' : '',
    task.dueDate ? `Due ${task.dueDate}` : '',
    `Created ${formatDate(task.createdAt) || 'unknown (legacy)'}`,
    `Updated ${formatDate(task.updatedAt)}`
  ].filter(Boolean);
  content.append(makeElement('div', 'task-meta', metadata.join(' · ')));

  const actions = makeElement('div', 'task-actions');
  const edit = makeElement('button', '', 'Edit');
  edit.type = 'button';
  edit.dataset.taskControl = 'edit';
  edit.addEventListener('click', () => openTaskDialog(task));
  const notes = makeElement('button', '', 'Notes & history');
  notes.type = 'button';
  notes.dataset.taskControl = 'notes';
  notes.addEventListener('click', () => openConversation(task));
  actions.append(edit, notes);
  const moves = makeElement('div', 'task-moves');
  const destination = makeElement('select', '');
  destination.setAttribute('aria-label', `Destination lane for ${task.title}`);
  for (const [status, name] of Object.entries(laneNames)) {
    const option = makeElement('option', '', name);
    option.value = status;
    destination.append(option);
  }
  destination.value = task.status;
  const move = makeElement('button', '', 'Move');
  move.type = 'button';
  move.disabled = true;
  destination.addEventListener('change', () => {
    move.disabled = destination.value === task.status;
    move.textContent = destination.value === 'done' ? 'Complete task'
      : task.status === 'done' ? `Reopen in ${laneNames[destination.value]}` : 'Move';
  });
  move.addEventListener('click', () => {
    const update = laneMove(task, destination.value);
    if (update) updateTask(task.id, update);
  });
  moves.append(destination, move);
  if (task.status !== 'done') {
    const handle = makeElement('span', 'task-drag', 'Drag to move');
    handle.draggable = true;
    handle.title = 'Drag between active lanes, or use the destination and Move controls';
    handle.addEventListener('dragstart', event => {
      draggedTask = { ...task };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', task.id);
    });
    handle.addEventListener('dragend', () => { draggedTask = null; });
    moves.append(handle);
  }
  content.append(moves);
  card.append(complete, content, actions);
  return card;
}

async function updateTask(id, update) {
  try {
    const revision = update.revision ?? workspace.tasks.find(task => task.id === id)?.revision ?? 0;
    const { task } = await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ ...update, revision }) });
    workspace.tasks = workspace.tasks.map(current => current.id === task.id ? task : current);
    await refreshState();
    showNotice(task.status === 'done' ? 'Task completed locally.' : 'Task updated locally.');
  } catch (error) {
    showNotice(error.message, true);
  }
}

function renderDrafts() {
  const host = $('#draft-list');
  host.replaceChildren();
  $('#draft-count').textContent = String(workspace.drafts.length);
  if (!workspace.drafts.length) {
    host.append(makeElement('p', 'empty-lane', 'No local drafts yet.'));
    return;
  }
  for (const draft of workspace.drafts) {
    const card = makeElement('article', 'draft-card');
    const heading = makeElement('div', 'draft-heading');
    heading.append(makeElement('strong', '', draft.subject));
    const edit = makeElement('button', '', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', () => {
      if (localFormBusy($('#draft-form'))) return;
      $('#draft-form').querySelector('[data-save-status]').textContent = '';
      editingDraftId = draft.id;
      editingDraftRevision = draft.revision || 0;
      const form = $('#draft-form');
      form.elements.recipient.value = draft.recipient;
      form.elements.subject.value = draft.subject;
      form.elements.body.value = draft.body;
      form.querySelector('h2').textContent = 'Edit local draft';
      $('#draft-save').textContent = 'Save changes locally';
      form.elements.subject.focus();
    });
    heading.append(edit);
    card.append(heading);
    if (draft.recipient) card.append(makeElement('small', '', `To: ${draft.recipient} · Local only`));
    card.append(makeElement('p', '', draft.body));
    card.append(makeElement('small', '', `Unsent · Saved ${formatDate(draft.updatedAt)}`));
    host.append(card);
  }
}

function renderLinks() {
  const host = $('#link-list');
  host.replaceChildren();
  const links = workspace.links || [];
  $('#link-count').textContent = String(links.length);
  if (!links.length) {
    host.append(makeElement('p', 'empty-lane', 'No links saved yet.'));
    return;
  }
  for (const item of links) {
    const card = makeElement('article', 'draft-card');
    const link = makeElement('a', 'saved-link', item.title);
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    card.append(link, makeElement('small', '', item.url));
    host.append(card);
  }
}

function renderProfile() {
  const form = $('#profile-form');
  if (!form || profileRendered) return;
  form.elements.displayName.value = workspace.profile?.displayName || '';
  form.elements.timezone.value = workspace.profile?.timezone || '';
  for (const field of ['email', 'role', 'manager', 'people', 'workspaceName', 'writingStyle']) form.elements[field].value = workspace.profile?.[field] || '';
  $('#output-form').elements.confirmPrivateNonSynced.checked = Boolean(workspace.preferences?.localOutputApproved);
  $('#demo-approval-form').elements.confirmSyntheticLocalOnly.checked = Boolean(workspace.preferences?.demoApproved);
  profileRendered = true;
  if (!preferencesRendered) {
    const preferences = $('#preferences-form');
    for (const key of ['paused', 'automaticRefresh', 'dailyBackups']) preferences.elements[key].checked = Boolean(workspace.preferences?.[key]);
    for (const key of ['quietStart', 'quietEnd']) preferences.elements[key].value = workspace.preferences?.[key] || '';
    preferencesRendered = true;
  }
}

function renderJobs() {
  const jobs = workspace.jobs || [];
  const host = $('#job-list');
  host.replaceChildren();
  const paused = workspace.preferences?.paused;
  const timezone = workspace.timezoneStatus;
  const timezoneMessage = timezone?.quietHoursInvalid
    ? 'Saved quiet hours are invalid or incomplete. Queued work is paused; correct both times or clear both in Operations.'
    : timezone?.quietHoursBlocked
    ? 'Timezone unavailable or unsupported. Quiet hours cannot be evaluated; queued work is paused. Set a supported IANA timezone or clear both quiet-hour settings in Operations.'
    : timezone?.scheduledWorkBlocked
      ? 'Timezone unavailable or unsupported. Scheduled work is deferred; manual work remains available. Set a supported IANA timezone or disable scheduling in Operations. Previously queued scheduled work stays deferred until the timezone is repaired.'
      : '';
  $('#worker-timezone-status').textContent = timezoneMessage;
  $('#worker-state').textContent = paused ? 'Worker paused. Queued work is retained.' : timezoneMessage || 'Local worker is running while this host is open. Quiet hours defer work in your profile timezone.';
  if (!jobs.length) host.append(makeElement('p', 'empty-lane', 'No jobs requested.'));
  for (const job of jobs.slice(0, 50)) {
    const card = makeElement('article', 'surface job-card');
    const heading = makeElement('div', 'section-title');
    heading.append(makeElement('h3', '', job.kind.replaceAll('_', ' ')), makeElement('span', `tag job-${job.status}`, job.status.toUpperCase()));
    card.append(heading);
    card.append(makeElement('p', 'muted', `Attempt ${job.attempts} · ${formatDate(job.updatedAt)} · ${job.origin === 'schedule' ? 'Opt-in scheduled attempt' : 'Explicit local request'}`));
    if (job.kind === 'meeting_insight_list') card.append(makeElement('p', 'muted', `List request: ${job.requestId} · Meeting: ${job.payload?.meetingId || 'unavailable'}`));
    if (job.error) card.append(makeElement('p', 'job-error', job.error));
    if (job.result?.text) card.append(makeElement('pre', 'job-result', job.result.text));
    if (job.kind === 'file_content_read' && job.result?.file) {
      const file = makeElement('section', 'source-preview');
      file.append(makeElement('h4', '', job.result.file.title || 'Selected text file'));
      file.append(makeElement('small', 'muted', `Untrusted evidence · ${job.result.file.mimeType || 'unknown format'} · ${job.result.file.byteLength || 0} UTF-8 bytes${job.result.file.eTag ? ` · revision ${job.result.file.eTag}` : ''}`));
      if (job.result.file.lastModifiedDateTime) file.append(makeElement('small', 'muted', `Modified: ${formatDate(job.result.file.lastModifiedDateTime)}`));
      if (job.result.file.webLink) {
        const link = inertHttpUrl(job.result.file.webLink);
        if (link) {
          const anchor = makeElement('a', 'saved-link', 'Open original reference manually');
          anchor.href = link;
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
          file.append(anchor);
        }
      }
      file.append(makeElement('p', 'muted', `Coverage: ${job.result.coverage?.status || 'partial'} · ${job.result.file.provenance || 'owner-approved selected-file read'}. Displayed as inert text only.`));
      for (const limitation of job.result.coverage?.limitations || []) file.append(makeElement('p', 'muted', limitation));
      file.append(makeElement('pre', 'source-content', job.result.content || ''));
      card.append(file);
    }
    if (job.kind === 'teams_channel_replies') {
      const thread = makeElement('section', 'source-preview');
      thread.append(makeElement('h4', '', 'Read-only replies for the selected parent'));
      thread.append(makeElement('p', 'muted', 'Historical, untrusted evidence only. No reply, reaction, membership change, task, or notification was created.'));
      if (job.result?.coverage?.status) {
        thread.append(makeElement('small', 'muted', `Coverage: ${job.result.coverage.status}${job.result.hasMore ? ' · more replies were not inspected' : ''}`));
      }
      if (job.result?.parent) {
        thread.append(makeElement('strong', '', `Parent: ${job.result.parent.title || 'Untitled message'}`));
        if (job.result.parent.excerpt) thread.append(makeElement('pre', 'source-excerpt', job.result.parent.excerpt));
      }
      for (const limitation of job.result?.coverage?.limitations || []) thread.append(makeElement('p', 'muted', limitation));
      if (!(job.result?.items || []).length) thread.append(makeElement('p', 'muted', 'No replies were returned, or the read did not complete.'));
      for (const reply of job.result?.items || []) {
        const evidence = makeElement('article', 'draft-card');
        evidence.append(makeElement('small', 'muted', `Historical reply · ${reply.title || 'Untitled message'}`));
        if (reply.excerpt) evidence.append(makeElement('pre', 'source-excerpt', reply.excerpt));
        evidence.append(makeElement('small', 'muted', 'Untrusted source evidence; displayed as text only.'));
        thread.append(evidence);
      }
      card.append(thread);
    }
    if (job.result?.meetingInsightList) {
      const list = job.result.meetingInsightList;
      card.append(makeElement('p', 'muted', `Historical untrusted list for meeting ${list.meetingId}. Coverage: ${list.coverage.status}. List results cannot authorize a detail read.`));
      for (const limitation of list.coverage.limitations) card.append(makeElement('p', 'muted', limitation));
      for (const item of list.items) {
        const evidence = makeElement('pre', 'source-excerpt', `Insight ID: ${item.id}\nCreated: ${item.createdDateTime || 'not provided'}\nEnded: ${item.endDateTime || 'not provided'}`);
        card.append(evidence);
      }
    }
    if (job.result?.sources) {
      for (const source of job.result.sources) {
        const coverage = typeof source.coverage === 'object' ? source.coverage?.status : source.coverage;
        const section = makeElement('details', 'source-preview');
        section.append(makeElement('summary', '', `${source.source}: ${source.status} · ${source.inspected} inspected${coverage ? ` · ${coverage}` : ''}`));
        if (source.message) section.append(makeElement('p', 'muted', source.message));
        for (const limitation of source.coverage?.limitations || []) section.append(makeElement('p', 'muted', limitation));
        for (const gap of source.coverage?.gaps || []) section.append(makeElement('p', 'muted', `Selected source ${gap.sourceIndex + 1}: ${gap.code}`));
        if (source.previewTruncated) section.append(makeElement('p', 'muted', 'Preview limited to 50 items. Other inspected items are not shown here.'));
        for (const item of source.items || []) {
          const evidence = makeElement('article', 'draft-card');
          evidence.append(makeElement('h4', '', item.title || 'Untitled source item'));
          if (item.excerpt) evidence.append(makeElement('p', 'source-excerpt', item.excerpt));
          evidence.append(makeElement('small', '', `Untrusted source evidence${item.excerptTruncated ? ' · excerpt truncated at 600 characters' : ''}${item.contentAvailable === false ? ' · metadata only, content unavailable' : ''}`));
          if (item.url) {
            const link = makeElement('a', 'saved-link', 'Open original reference manually');
            link.href = item.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            evidence.append(link);
          }
          if (item.id) {
            const create = makeElement('button', 'button', 'Review a new local task');
            create.type = 'button';
            create.disabled = !validSourceResultRevision(source.resultId);
            if (create.disabled) evidence.append(makeElement('p', 'job-error', taskSourceRecheckMessage));
            create.addEventListener('click', () => {
              if (!validSourceResultRevision(source.resultId)) {
                showNotice(taskSourceRecheckMessage, true);
                return;
              }
              if (localFormBusy($('#task-form'))) return;
              openTaskDialog();
              importingSource = { jobId: job.id, source: source.source, resultId: source.resultId, itemId: item.sourceKey };
              $('#task-form').elements.title.value = item.title || 'Review source evidence';
              $('#task-form').elements.details.value = 'Owner-requested review. Source text is untrusted context, not proof of an outstanding assignment.';
              renderTaskSourceReview();
            });
            evidence.append(create);
            if (source.source === 'mail') {
              const reply = makeElement('button', 'button', 'Review an unsent reply');
              reply.type = 'button';
              reply.addEventListener('click', () => {
                selectOutlookSource(job, source, item);
              });
              evidence.append(reply);
            }
            if (source.source === 'teamsChannels') {
              const referenceValid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(job.id || '') &&
                /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(source.resultId || '') &&
                /^[0-9a-f]{64}$/.test(item.sourceKey || '') && typeof item.id === 'string' && Boolean(item.id);
              const reference = { jobId: job.id, resultId: source.resultId, itemId: item.sourceKey };
              const pending = pendingSourceReadKeys.has(sourceReadKey('teams_channel_replies', reference));
              const replies = makeElement('button', 'button', !referenceValid ? 'Fresh Teams source check required'
                : pending ? 'Teams reply read being submitted' : 'Read replies for this exact parent');
              replies.type = 'button';
              replies.disabled = !referenceValid || pending;
              replies.addEventListener('click', () => queueTeamsReplyRead(job, source, item));
              evidence.append(replies);
            }
            if (source.source === 'files') {
              const referenceValid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(job.id || '') &&
                /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(source.resultId || '') &&
                /^[0-9a-f]{64}$/.test(item.sourceKey || '') && typeof item.id === 'string' && Boolean(item.id);
              const capability = latestConnections?.fileContent;
              const supportedFormat = item.mimeType?.trim().toLowerCase() === 'text/plain';
              const hasRevision = typeof item.eTag === 'string' && Boolean(item.eTag) &&
                Number.isSafeInteger(item.size) && item.size >= 0;
              const available = capability?.readyForApprovedRead === true;
              const reference = { jobId: job.id, resultId: source.resultId, itemId: item.sourceKey };
              const pending = pendingSourceReadKeys.has(sourceReadKey('file_content_read', reference));
              const label = !referenceValid ? 'Fresh file source check required'
                : !supportedFormat ? `Unsupported file format (${item.mimeType || 'unknown'}); text/plain only`
                  : !hasRevision ? 'Fresh file revision check required'
                  : pending ? 'Selected-file read being submitted'
                  : !available ? `File content unavailable (${(capability?.reasons || ['status-unavailable']).join(', ')})`
                    : 'Read selected text file (one-time approval)';
              const read = makeElement('button', 'button', label);
              read.type = 'button';
              read.disabled = !referenceValid || !supportedFormat || !hasRevision || !available || pending;
              read.addEventListener('click', () => queueFileContentRead(job, source, item));
              evidence.append(read);
            }
          }
          section.append(evidence);
        }
        card.append(section);
      }
    }
    if (job.kind !== 'meeting_insight_list' && ['failed', 'partial', 'interrupted'].includes(job.status) &&
        !(job.kind === 'file_content_read' && job.status === 'partial')) {
      const retry = makeElement('button', 'button', 'Explicitly retry');
      retry.type = 'button';
      retry.addEventListener('click', async () => {
        if (job.kind === 'file_content_read' &&
            !window.confirm('Approve a new one-time download attempt for this selected file?')) return;
        try {
          await api(`/api/jobs/${job.id}/retry`, {
            method: 'POST',
            body: JSON.stringify(job.kind === 'file_content_read' ? { confirmRead: true } : {})
          });
          await refreshState();
          showNotice('Retry queued; no successful result is claimed.');
        } catch (error) { showNotice(error.message, true); }
      });
      card.append(retry);
    }
    host.append(card);
  }
  const documents = $('#document-list');
  documents.replaceChildren();
  if (!workspace.documents?.length) documents.append(makeElement('p', 'empty-lane', 'No local documents created.'));
  for (const document of workspace.documents || []) {
    if (document.fileUnavailableReason) {
      documents.append(makeElement('p', 'muted', `${document.title} · ${document.fileUnavailableReason}`));
      continue;
    }
    const button = makeElement('button', 'button', `${document.title} · ${formatDate(document.createdAt)}`);
    button.addEventListener('click', async () => {
      try {
        const result = await api(`/api/documents/${document.id}`);
        $('#document-text').textContent = result.text;
        $('#document-dialog').showModal();
      } catch (error) { showNotice(error.message, true); }
    });
    documents.append(button);
  }
}

function renderBackups() {
  const host = $('#backup-list');
  host.replaceChildren();
  if (!workspace.backups.length) host.append(makeElement('p', 'muted', 'No verified state snapshots saved.'));
  for (const backup of workspace.backups) {
    const card = makeElement('article', 'job-card');
    if (backup.fileUnavailableReason) {
      card.append(makeElement('p', 'muted', `${formatDate(backup.createdAt)} · ${backup.fileUnavailableReason}`));
      host.append(card);
      continue;
    }
    card.append(makeElement('p', '', `${formatDate(backup.createdAt)} · Consistent state snapshot · Partial coverage`));
    const docs = backup.coverage.documents;
    const docSummary = docs.includedCount === undefined
      ? `${docs.metadataCount} document records; files excluded (legacy state-only snapshot).`
      : `${docs.includedCount} of ${docs.metadataCount} document files included; ${docs.unavailable.length} unavailable or excluded.`;
    card.append(makeElement('small', '', `${docSummary} Sources: partial local evidence only.`));
    for (const item of docs.unavailable || []) card.append(makeElement('small', '', `${item.id}: ${item.reason}`));
    const button = makeElement('button', 'button', 'Prepare separate paused recovery');
    button.type = 'button';
    button.addEventListener('click', async () => {
      if (!confirm(`Prepare a separate paused workspace? This never overwrites your current workspace. ${docSummary}`)) return;
      try {
        await api(`/api/backups/${backup.id}/recover`, { method: 'POST', body: JSON.stringify({ confirmSeparateWorkspace: true }) });
        await refreshState();
        showNotice('Separate paused recovery prepared. Original workspace is unchanged.');
      } catch (error) { showNotice(error.message, true); }
    });
    card.append(button);
    host.append(card);
  }
  const recoveries = $('#recovery-list');
  recoveries.replaceChildren();
  for (const recovery of workspace.recoveries) recoveries.append(makeElement('p', 'muted', recovery.fileUnavailableReason || `${recovery.message} Recovered directory: ${recovery.directory}`));
}

function renderRecords() {
  const allRecords = workspace.records || [];
  const accountRecords = allRecords.filter(record => record.category === 'account');
  const matchingAccounts = renderAccountRecords({
    document,
    host: $('#account-list'),
    records: accountRecords,
    query: $('#account-search').value,
    noteDrafts: accountNoteDrafts,
    pendingNotes: pendingAccountNotes,
    expandedHistory: expandedAccountHistories,
    formatDate,
    onEdit: openAccountForEdit,
    saveNote: (record, text) => api(`/api/records/${encodeURIComponent(record.id)}/notes`, {
      method: 'POST',
      body: JSON.stringify({ text, revision: record.revision || 0 })
    }),
    refresh: refreshState,
    notify: message => showNotice(message),
    onError: error => showNotice(error.message, true),
    onSettled: renderRecords
  });
  const totalAccounts = accountRecords.length;
  $('#account-count').textContent = `${matchingAccounts.length} of ${totalAccounts} ${totalAccounts === 1 ? 'account' : 'accounts'}`;

  const outcomeHost = $('#outcome-list');
  outcomeHost.replaceChildren();
  const outcomes = allRecords.filter(record => ['outcome', 'engagement'].includes(record.category));
  if (!outcomes.length) outcomeHost.append(makeElement('p', 'empty-lane', 'No owner-provided entries yet.'));
  for (const record of outcomes) {
    const card = makeElement('article', 'surface draft-card');
      const provenance = {
        'owner-pasted-unverified': 'Owner-pasted, unverified',
        'owner-stated-screenshot-ocr-unverified': 'Owner-stated screenshot OCR, unverified',
        'owner-stated-screenshot-ocr-edited-unverified': 'Owner-stated screenshot OCR, possibly edited, unverified'
      }[record.provenance] || 'Owner-provided, unverified';
      card.append(makeElement('strong', '', record.title), makeElement('small', '', `${record.category} · ${record.date || 'No date'} · ${provenance}`));
      if (record.note) card.append(makeElement('p', '', record.note));
      if (record.sourceUrl) {
        const href = inertHttpUrl(record.sourceUrl);
        const source = makeElement(href ? 'a' : 'small', 'saved-link', href ? 'Open saved source link' : 'Invalid source link not opened');
        if (href) source.href = href;
        if (href) {
          source.target = '_blank';
          source.rel = 'noopener noreferrer';
        }
        card.append(source);
      }
      const edit = makeElement('button', 'button', 'Edit local entry');
      edit.type = 'button';
      edit.addEventListener('click', () => {
        const form = $('#outcome-form');
        if (localFormBusy(form)) return;
        form.querySelector('[data-save-status]').textContent = '';
        form.dataset.recordId = record.id;
        form.dataset.revision = String(record.revision || 0);
        form.dataset.category = record.category;
        for (const key of ['title', 'note', 'date']) if (form.elements[key]) form.elements[key].value = record[key] || '';
        if (form.elements.category) { form.elements.category.value = record.category; form.elements.category.disabled = true; }
        form.querySelector('[type="submit"]').textContent = 'Save entry changes locally';
        form.elements.title.focus();
      });
      card.append(edit);
    outcomeHost.append(card);
  }
}

function openAccountForEdit(record) {
  const form = $('#account-form');
  if (form.dataset.recordId === record.id || !confirmAccountFormReplacement()) return;
  form.dataset.recordId = record.id;
  form.dataset.revision = String(record.revision || 0);
  form.dataset.category = record.category;
  for (const key of ['title', 'note', 'plan', 'stakeholders']) form.elements[key].value = record[key] || '';
  form.querySelector('[type="submit"]').textContent = 'Save account changes';
  $('#account-cancel-edit').hidden = false;
  accountFormBaseline = accountFormSnapshot();
  form.elements.title.focus();
}

function accountFormSnapshot() {
  return JSON.stringify(Object.fromEntries(new FormData($('#account-form'))));
}

function accountFormHasUnsavedChanges() {
  return accountFormBaseline !== null && accountFormSnapshot() !== accountFormBaseline;
}

function confirmAccountFormReplacement() {
  const saving = accountSubmission?.isPending() || false;
  const allowed = canReplaceAccountTarget({
    saving,
    dirty: accountFormHasUnsavedChanges(),
    confirmDiscard: () => confirm('Discard these unsaved account changes?')
  });
  if (!allowed && saving) {
    showNotice('Wait for the account save to finish before switching accounts.', true);
  }
  return allowed;
}

function resetAccountForm() {
  const form = $('#account-form');
  form.reset();
  delete form.dataset.recordId;
  delete form.dataset.revision;
  delete form.dataset.category;
  form.querySelector('[type="submit"]').textContent = 'Save local account';
  $('#account-cancel-edit').hidden = true;
  accountFormBaseline = accountFormSnapshot();
}

let accountFormBaseline = null;
let accountSubmission = null;

const outcomeImportWorkflow = createOutcomeImportWorkflow();
const outcomeImportForm = $('#outcome-import-form');
const outcomeImportText = outcomeImportForm.elements.text;
const outcomeImportSourceMethod = outcomeImportForm.elements.sourceMethod;
const outcomeImportResult = $('#outcome-import-preview-result');
const outcomeImportReview = outcomeImportForm.elements.reviewed;
const outcomeImportConfirm = $('#outcome-import-confirm');
const outcomeImportReject = $('#outcome-import-reject');
const outcomeImportPreviewButton = $('#outcome-import-preview');
const outcomeImportImage = $('#outcome-import-image');
const outcomeImportOcrButton = $('#outcome-import-ocr');
const outcomeImportOcrStatus = $('#outcome-import-ocr-status');
const outcomeImportControls = {
  text: outcomeImportText,
  sourceMethod: outcomeImportSourceMethod,
  image: outcomeImportImage,
  ocrButton: outcomeImportOcrButton,
  previewButton: outcomeImportPreviewButton,
  rejectButton: outcomeImportReject,
  reviewCheckbox: outcomeImportReview,
  confirmButton: outcomeImportConfirm
};

function renderOutcomeImportPreview() {
  outcomeImportResult.replaceChildren();
  const workflow = outcomeImportWorkflow.snapshot();
  const rows = workflow.preview?.rows || [];
  if (workflow.preview) {
    const summary = makeElement('p', 'muted', `Preview: ${rows.filter(row => row.state === 'new').length} new, ${rows.filter(row => row.state === 'duplicate').length} duplicate, ${rows.filter(row => row.state === 'conflict').length} conflict. Conflicts and duplicates are not overwritten.`);
    outcomeImportResult.append(summary);
    const list = makeElement('div', 'draft-list');
    for (const { state, record } of rows) {
      const card = makeElement('article', 'draft-card');
      card.append(makeElement('strong', '', `${state}: ${record.title}`));
      const sourceLabel = {
        pasted: 'owner-pasted, unverified',
        'screenshot-ocr': 'owner-stated screenshot OCR, unverified',
        'screenshot-ocr-edited': 'owner-stated screenshot OCR, possibly edited, unverified'
      }[workflow.sourceMethod];
      card.append(makeElement('small', '', `${record.date} · ${record.workshopImport.status} · ${sourceLabel}`));
      if (record.note) card.append(makeElement('p', '', record.note));
      if (record.sourceUrl) {
        const href = inertHttpUrl(record.sourceUrl);
        const link = makeElement(href ? 'a' : 'small', 'saved-link', href ? 'Saved source link (not fetched)' : 'Invalid source link not opened');
        if (href) {
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        card.append(link);
      }
      list.append(card);
    }
    outcomeImportResult.append(list);
  }
  const hasNew = rows.some(row => row.state === 'new');
  $('#outcome-import-review-row').hidden = !workflow.preview || !hasNew;
  syncOutcomeImportControls(outcomeImportWorkflow, outcomeImportControls);
}

outcomeImportText.addEventListener('input', () => {
  outcomeImportWorkflow.editText(outcomeImportText.value);
  outcomeImportSourceMethod.value = outcomeImportWorkflow.snapshot().sourceMethod;
  outcomeImportReview.checked = false;
  renderOutcomeImportPreview();
});
outcomeImportSourceMethod.addEventListener('change', () => {
  if (!outcomeImportWorkflow.setSourceMethod(outcomeImportSourceMethod.value)) return;
  outcomeImportReview.checked = false;
  renderOutcomeImportPreview();
});
outcomeImportImage.addEventListener('change', () => {
  const file = outcomeImportImage.files[0];
  outcomeImportOcrStatus.textContent = file
    ? 'Selected locally; it is not processed or saved until you request OCR.'
    : 'On Windows, the selected image is processed by the installed local OCR engine. Before confirmation, the app creates no screenshot or OCR-text file and makes no cloud request. The operating system, browser, crash dumps, or other same-user software may retain data outside app control. OCR text is never imported automatically; inspect and correct it before previewing and explicitly confirming.';
  syncOutcomeImportControls(outcomeImportWorkflow, outcomeImportControls);
});
outcomeImportOcrButton.addEventListener('click', async () => {
  const file = outcomeImportImage.files[0];
  if (!file) return;
  const extension = file.name.toLowerCase().split('.').pop();
  const mimeType = file.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp' })[extension];
  if (!['image/png', 'image/jpeg', 'image/bmp'].includes(mimeType)) {
    outcomeImportOcrStatus.textContent = 'Choose a PNG, JPEG or BMP screenshot.';
    return;
  }
  if (!file.size || file.size > 4 * 1024 * 1024) {
    outcomeImportOcrStatus.textContent = 'Choose a non-empty screenshot no larger than 4 MiB.';
    return;
  }
  const hasUnsavedText = Boolean(outcomeImportWorkflow.snapshot().text.trim());
  const replaceExisting = hasUnsavedText && window.confirm(
    'Replace the non-empty unsaved workshop text with text from this screenshot? The current text is kept unless OCR succeeds.'
  );
  if (hasUnsavedText && !replaceExisting) {
    outcomeImportOcrStatus.textContent = 'Screenshot OCR cancelled. The existing workshop text was preserved.';
    return;
  }
  const operation = outcomeImportWorkflow.beginOcr({ replaceExisting });
  if (operation.status === 'busy') {
    outcomeImportOcrStatus.textContent = 'Screenshot OCR is already running. Wait for it to finish.';
    return;
  }
  if (operation.status !== 'started') {
    outcomeImportOcrStatus.textContent = 'Clear or explicitly replace the existing workshop text before OCR.';
    return;
  }
  outcomeImportReview.checked = false;
  renderOutcomeImportPreview();
  outcomeImportReject.disabled = true;
  outcomeImportOcrStatus.textContent = 'Reading the selected image with on-device Windows OCR. Nothing is being imported.';
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result || '')));
      reader.addEventListener('error', () => reject(new Error('The selected screenshot could not be read locally.')));
      reader.readAsDataURL(file);
    });
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('The selected screenshot could not be read locally.');
    const result = await api('/api/outcomes/import/ocr', {
      method: 'POST',
      body: JSON.stringify({ mimeType, imageBase64: dataUrl.slice(comma + 1) })
    });
    if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('Windows OCR returned no readable text.');
    if (!outcomeImportWorkflow.resolveOcr(operation.ticket, result.text)) return;
    outcomeImportText.value = result.text;
    outcomeImportSourceMethod.value = outcomeImportWorkflow.snapshot().sourceMethod;
    outcomeImportOcrStatus.textContent = 'OCR text is unverified. Correct it as needed, then select Preview import; nothing has been merged.';
    showNotice('Text extracted locally. Review and correct it before previewing; no outcomes were changed.');
  } catch (error) {
    if (outcomeImportWorkflow.rejectOcr(operation.ticket)) {
      outcomeImportOcrStatus.textContent = error.message;
      showNotice(error.message, true);
    }
  } finally {
    syncOutcomeImportControls(outcomeImportWorkflow, outcomeImportControls);
  }
});
outcomeImportForm.addEventListener('submit', async event => {
  event.preventDefault();
  const ticket = outcomeImportWorkflow.beginPreview();
  if (!ticket) {
    showNotice('Wait for screenshot OCR to finish before previewing.', true);
    return;
  }
  renderOutcomeImportPreview();
  outcomeImportPreviewButton.disabled = true;
  try {
    const preview = await api('/api/outcomes/import/preview', {
      method: 'POST', body: JSON.stringify({ text: ticket.text, sourceMethod: ticket.sourceMethod })
    });
    if (!outcomeImportWorkflow.resolvePreview(ticket, preview)) return;
    outcomeImportReview.checked = false;
    renderOutcomeImportPreview();
    showNotice('Preview ready. Review each row; nothing has been imported.');
  } catch (error) {
    if (outcomeImportWorkflow.rejectPreview(ticket)) {
      outcomeImportReview.checked = false;
      renderOutcomeImportPreview();
      showNotice(error.message, true);
    }
  } finally {
    syncOutcomeImportControls(outcomeImportWorkflow, outcomeImportControls);
  }
});
outcomeImportReview.addEventListener('change', () => {
  outcomeImportWorkflow.setReviewed(outcomeImportReview.checked);
  renderOutcomeImportPreview();
});
outcomeImportReject.addEventListener('click', () => {
  if (!outcomeImportWorkflow.clearPreview()) return;
  outcomeImportReview.checked = false;
  renderOutcomeImportPreview();
  showNotice('Preview discarded. No outcomes were changed.');
});
outcomeImportConfirm.addEventListener('click', async () => {
  const confirmation = outcomeImportWorkflow.beginConfirm();
  if (!confirmation) return;
  const screenshotAtConfirmation = outcomeImportImage.files[0];
  syncOutcomeImportControls(outcomeImportWorkflow, outcomeImportControls);
  try {
    const confirmationResult = await confirmOutcomeImport(
      outcomeImportWorkflow,
      confirmation,
      () => api('/api/outcomes/import/confirm', {
        method: 'POST',
        body: JSON.stringify({
          text: confirmation.text,
          revision: confirmation.preview.revision,
          textHash: confirmation.preview.textHash,
          sourceMethod: confirmation.sourceMethod,
          sourceMethodHash: confirmation.preview.sourceMethodHash,
          reviewed: true
        })
      }),
      { clearText: confirmation.sourceMethod !== 'pasted' }
    );
    if (confirmationResult.status === 'rejected') {
      showNotice(confirmationResult.error.message, true);
      outcomeImportReview.checked = false;
      renderOutcomeImportPreview();
      return;
    }
    if (confirmationResult.status === 'unknown') {
      outcomeImportReview.checked = false;
      outcomeImportOcrStatus.textContent = `${confirmationResult.message} ${confirmationResult.detail}`;
      renderOutcomeImportPreview();
      showNotice(confirmationResult.message, true);
      return;
    }
    const { result, finished } = confirmationResult;
    outcomeImportReview.checked = false;
    if (finished.textCleared) outcomeImportText.value = '';
    outcomeImportSourceMethod.value = outcomeImportWorkflow.snapshot().sourceMethod;
    let screenshotRemoved = false;
    if (finished.textCleared && screenshotAtConfirmation &&
        outcomeImportImage.files[0] === screenshotAtConfirmation) {
      outcomeImportImage.value = '';
      screenshotRemoved = true;
    }
    if (finished.preservedText) {
      outcomeImportOcrStatus.textContent = 'The confirmed import completed; newer unsaved workshop text was preserved.';
    } else if (finished.textCleared) {
      outcomeImportOcrStatus.textContent = screenshotRemoved
        ? 'The selected screenshot was removed and OCR text cleared from the import field after confirmation.'
        : 'OCR text was cleared from the import field after confirmation.';
    }
    renderOutcomeImportPreview();
    const refreshed = await refreshAfterOutcomeImport(result, refreshState, finished.preservedText);
    if (refreshed.status === 'refresh-failed') {
      outcomeImportOcrStatus.textContent = `${refreshed.message} ${refreshed.error.message}`;
      showNotice(refreshed.message, true);
      return;
    }
    showNotice(`Imported ${result.imported}; skipped ${result.duplicates} duplicate and ${result.conflicts} conflicting rows.`);
  } finally {
    syncOutcomeImportControls(outcomeImportWorkflow, outcomeImportControls);
  }
});

const setupTitles = ['Your profile', 'Manager and people', 'Account portfolio', 'Workspace', 'Writing style', 'Monthly outcomes', 'Source configuration', 'Review'];

function renderSetup(force = false) {
  const progress = workspace.onboarding;
  if (!progress || setupRevision === progress.revision || (!force && $('#setup-form').contains(document.activeElement))) return;
  setupRevision = progress.revision;
  setupRecord = null;
  $('#setup-progress').textContent = `${progress.status} · Step ${progress.step + 1} of ${setupTitles.length}. Save persists this step. Skipping keeps previously saved data.`;
  $('#setup-title').textContent = setupTitles[progress.step];
  $('#setup-help').textContent = 'Optional local context, not identity proof. Return here or edit Operations, Accounts and Outcomes later.';
  $('#setup-back').disabled = progress.step === 0;
  $('#setup-save').textContent = progress.step === 7 ? 'Confirm review and finish' : 'Save and continue';
  const steps = $('#setup-steps');
  steps.replaceChildren();
  setupTitles.forEach((title, index) => {
    const button = makeElement('button', 'button', `${index + 1}. ${title}`);
    button.type = 'button';
    button.setAttribute('aria-current', index === progress.step ? 'step' : 'false');
    button.addEventListener('click', () => changeSetup('go', { step: index }));
    steps.append(button);
  });
  const fields = $('#setup-fields');
  fields.replaceChildren();
  const input = (name, title, value = '', multiline = false, max = 2000) => {
    const label = makeElement('label', '', title);
    const control = makeElement(multiline ? 'textarea' : 'input');
    control.name = name;
    control.value = value;
    control.maxLength = max;
    if (multiline) control.rows = 4;
    label.append(control);
    fields.append(label);
  };
  if (progress.step === 0) {
    for (const [name, title, max] of [['displayName', 'Display name', 80], ['email', 'Your email (not sign-in)', 320], ['role', 'Your role', 160], ['timezone', 'IANA timezone, e.g. America/Los_Angeles', 80]]) input(name, title, workspace.profile[name] || '', false, max);
  } else if (progress.step === 1) {
    input('manager', 'Manager (owner-entered, not directory-verified)', workspace.profile.manager || '', false, 160);
    input('people', 'People and relationship context', workspace.profile.people || '', true);
  } else if ([2, 5].includes(progress.step)) {
    setupRecord = workspace.records.find(record => record.category === (progress.step === 2 ? 'account' : 'outcome')) || null;
    input('title', progress.step === 2 ? 'Account name (optional)' : 'Outcome title (optional)', setupRecord?.title || '', false, 160);
    input('note', 'Owner-provided context, not verified reporting', setupRecord?.note || '', true, 4000);
    fields.append(makeElement('p', 'muted', 'This edits the first local entry. Add or edit more in Accounts or Monthly Outcomes.'));
  } else if (progress.step === 3) {
    input('workspaceName', 'Workspace name (local label only)', workspace.profile.workspaceName || '', false, 160);
    fields.append(makeElement('p', 'muted', 'The host-selected directory is shown in Operations. This never moves data or attaches another backend. Web and desktop defaults are separate; quit the owning host before selecting a different directory.'));
  } else if (progress.step === 4) input('writingStyle', 'Writing preferences', workspace.profile.writingStyle || '', true);
  else if (progress.step === 6) {
    input('configuration', 'Optional nonsecret source configuration JSON: expectedIdentity and sources only. No tokens or consent.', workspace.sourceConfigurationDraft ? JSON.stringify(workspace.sourceConfigurationDraft, null, 2) : '', true, 12000);
    fields.append(makeElement('p', 'muted', `Microsoft 365: ${latestConnections?.microsoft365?.state || 'status unavailable'}. Assistant: ${latestConnections?.assistant?.code || 'unavailable'}. Saving selections never connects, grants permissions or enables Outlook writes. Use the separate explicit consent controls in Operations when an approved host provider exists.`));
  } else {
    const summary = makeElement('pre', 'note-bubble setup-review', JSON.stringify({
      profile: workspace.profile, portfolioAndOutcomes: workspace.records,
      configuredSources: workspace.sourceConfigurationDraft,
      microsoft365: latestConnections?.microsoft365?.state || 'status-unavailable',
      assistant: latestConnections?.assistant?.code || 'unavailable',
      outputApproved: workspace.preferences.localOutputApproved
    }, null, 2));
    fields.append(summary, makeElement('p', 'muted', 'Finishing does not authorize connections, change scheduling/output approvals, or create demo data.'));
  }
}

async function changeSetup(action, extra = {}) {
  try {
    await api('/api/onboarding', { method: 'PATCH', body: JSON.stringify({ action, revision: setupRevision ?? workspace.onboarding.revision, ...extra }) });
    setupRevision = null;
    profileRendered = false;
    $('#setup-form').querySelector(':focus')?.blur();
    await refreshState();
    renderSetup(true);
    if (['skip', 'complete'].includes(action)) navigate('board');
  } catch (error) { showNotice(error.message, true); }
}

function renderDraftOperations() {
  const host = $('#remote-draft-ledger');
  host.replaceChildren();
  if (!workspace.draftOperations.length) host.append(makeElement('p', 'muted', 'No Outlook draft operations have been requested.'));
  for (const operation of workspace.draftOperations) {
    const card = makeElement('article', 'draft-card');
    card.append(makeElement('strong', '', operation.draft?.subject || 'Explicit Outlook reply-draft request'));
    card.append(makeElement('p', 'muted', `${operation.status.toUpperCase()} · ${formatDate(operation.createdAt)}`));
    card.append(makeElement('small', '', operation.status === 'completed'
      ? 'Verified unsent draft at creation time. Inspect its current status manually in Outlook.'
      : 'No successful draft result is claimed. Inspect Outlook before any new request; this operation will not be replayed.'));
    host.append(card);
  }
}

function conversationBusy() {
  return localFormBusy($('#conversation-form')) || localFormBusy($('#evidence-form'));
}

function conversationHasText() {
  return [$('#conversation-form'), $('#evidence-form')].some(form =>
    [...form.elements].some(control => control.name && control.value));
}

async function openConversation(task) {
  if (conversationBusy()) return;
  if (conversationTaskId !== task.id && conversationHasText()) {
    showNotice('Task not changed. Copy and clear the unsaved note/evidence before switching tasks.', true);
    return;
  }
  if (conversationTaskId !== task.id) {
    conversationTaskId = task.id;
    conversationViewRevision++;
    for (const selector of ['#task-timeline', '#conversation-messages', '#task-evidence']) $(selector).replaceChildren();
    for (const selector of ['#conversation-form', '#evidence-form']) $(selector).querySelector('[data-save-status]').textContent = '';
  }
  $('#conversation-title').textContent = task.title;
  if (!$('#conversation-dialog').open) $('#conversation-dialog').showModal();
  try { await renderConversation(); }
  catch (error) { showNotice(`Task conversation could not load: ${error.message}`, true); }
}

function closeConversation(event) {
  event?.preventDefault();
  if (conversationBusy()) return;
  $('#conversation-dialog').close();
  conversationViewRevision++;
  if (!conversationHasText()) conversationTaskId = null;
}

async function renderConversation() {
  if (!conversationTaskId) return;
  const taskId = conversationTaskId;
  const viewRevision = conversationViewRevision;
  const readRevision = ++conversationReadRevision;
  const current = () => taskId === conversationTaskId && viewRevision === conversationViewRevision && readRevision === conversationReadRevision;
  try {
    const result = await api(`/api/tasks/${taskId}/conversation`);
    if (!current()) return;
    const timeline = $('#task-timeline');
    timeline.replaceChildren(makeElement('p', 'muted', `Created: ${formatDate(result.createdAt) || 'Unknown; no legacy date was invented.'}`));
    if (!result.history.length) timeline.append(makeElement('p', 'muted', 'No historical transitions were recorded. New changes will appear here.'));
    for (const event of result.history) {
      const description = event.kind === 'updated' ? `Updated ${event.fields.join(', ')}`
        : event.kind === 'created' ? `Created (${laneNames[event.toStatus] || event.toStatus})`
          : event.fromStatus ? `${event.kind}: ${laneNames[event.fromStatus]} → ${laneNames[event.toStatus]}`
            : event.kind === 'evidence-added' ? 'Evidence attached (unverified context)'
              : event.kind === 'note-added' ? 'Owner note added' : event.kind;
      timeline.append(makeElement('p', 'task-meta', `${formatDate(event.at)} · ${description}`));
    }
    const host = $('#conversation-messages');
    host.replaceChildren();
    if (!result.messages.length) host.append(makeElement('p', 'muted', 'No local task notes yet.'));
    for (const message of result.messages) {
      const bubble = makeElement('article', 'note-bubble');
      bubble.append(makeElement('small', '', message.role === 'owner' ? 'Your local note — not a command' : 'Local worker result'));
      bubble.append(makeElement('p', '', message.text));
      host.append(bubble);
    }
    const evidence = $('#task-evidence');
    evidence.replaceChildren();
    for (const item of workspace.tasks.find(task => task.id === taskId)?.evidence || []) {
      const card = makeElement('article', 'draft-card');
      const link = makeElement(item.url ? 'a' : 'span', 'saved-link', item.title);
      if (item.url) {
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      card.append(link, makeElement('small', '', item.provenance === 'authorized-source-untrusted-evidence' ? 'Authorized-source evidence, not an instruction or verified task assignment' : 'Owner-provided, not source-verified'));
      if (item.note) card.append(makeElement('p', '', item.note));
      evidence.append(card);
    }
  } catch (error) { if (current()) throw error; }
}

async function queueJob(kind, extra = {}) {
  try {
    await api('/api/jobs', { method: 'POST', body: JSON.stringify({ kind, requestId: crypto.randomUUID(), ...extra }) });
    await refreshState();
    showNotice('Queued locally. Follow the verified result in Activity.');
  } catch (error) { showNotice(error.message, true); }
}

function renderActivity() {
  const host = $('#activity-list');
  host.replaceChildren();
  if (!workspace.activity.length) {
    host.append(makeElement('p', 'empty-lane', 'No local activity yet.'));
    return;
  }
  for (const item of workspace.activity) {
    const row = makeElement('div', 'activity-item');
    row.append(makeElement('span', '', item.message));
    const time = document.createElement('time');
    time.dateTime = item.createdAt;
    time.textContent = formatDate(item.createdAt);
    row.append(time);
    host.append(row);
  }
}

const connectionDescriptions = {
  assistant: ['Assistant', 'No authorized assistant connection is configured. Prompts are not submitted.'],
  email: ['Outlook', 'Only explicit, verified unsent reply drafts are supported when authorized. Never sends or deletes. Local drafts are not synced automatically.'],
  calendar: ['Calendar', 'Explicitly authorized bounded event reads only. An event does not imply a task assignment.'],
  teams: ['Teams', 'Selected chats, channels, transcripts, exact-parent replies and separately selected meeting AI insights are read-only; AI content is unverified. No posts, reactions or exhaustive sync.'],
  reporting: ['Reporting', 'Disconnected. If configured later, business reporting is read-only.'],
  oneNote: ['OneNote', 'Read-only content from your explicitly selected page IDs only. HTML is shown as inert literal text; no page discovery or resource fetches.'],
  sharepoint: ['SharePoint / OneDrive', 'Selected authorized file metadata only; file content and Loop pages remain unavailable. Never a document output destination.'],
  planner: ['Planner / To Do', 'Retired and unavailable. No remote task mirror is used.']
};

async function renderConnections() {
  const host = $('#connections');
  try {
    const { ...connections } = await api('/api/connections');
    latestConnections = connections;
    host.replaceChildren();
    for (const [key, [title, description]] of Object.entries(connectionDescriptions)) {
      const status = connections[key]?.status || 'disconnected';
      const card = makeElement('article', 'connection-item');
      card.append(makeElement('h2', '', title));
      card.append(makeElement('p', '', description));
      card.append(makeElement('span', 'tag', status.toUpperCase()));
      for (const read of connections[key]?.lastReads || []) {
        card.append(makeElement('small', '', `${read.source}: ${read.status}, ${read.inspected} inspected · ${formatDate(read.at)}`));
        for (const limitation of read.coverage?.limitations || []) card.append(makeElement('p', 'muted', limitation));
        for (const gap of read.coverage?.gaps || []) card.append(makeElement('p', 'muted', `Selected source ${gap.sourceIndex + 1}: ${gap.code}`));
      }
      host.append(card);
    }
    const m365 = connections.microsoft365;
    $('#microsoft365-status').textContent = m365.hostAuthenticationAvailable
      ? `${m365.state}${m365.reason ? ` · ${m365.reason}` : ''}. Owner verification does not imply source permission or synchronization.`
      : 'Unavailable: this host has no trustworthy authenticated delegated token provider. IDs and consent alone cannot enable a connection.';
    const fileContent = connections.fileContent || { status: 'unavailable', readyForApprovedRead: false, reasons: ['status-unavailable'], message: 'The host did not report selected-file transport availability.' };
    $('#file-content-status').textContent = `Selected file content: ${fileContent.status}${fileContent.reasons?.length ? ` (${fileContent.reasons.join(', ')})` : ''}. ${fileContent.message} Only one explicitly approved text/plain file can be read; no broader sync is implied.`;
    $('#microsoft365-connect').disabled = !m365.hostAuthenticationAvailable;
    updateOutlookDraftAvailability();
    $('#assistant-status').textContent = `Unavailable: ${connections.assistant.code}. No audited production runtime is connected; prompts are not submitted.`;
    if (!sourceSettingsRendered && (workspace.sourceConsent || workspace.sourceConfigurationDraft)) {
      const selected = workspace.sourceConsent || workspace.sourceConfigurationDraft;
      const form = $('#microsoft365-form');
      form.elements.tenantId.value = selected.expectedIdentity?.tenantId || '';
      form.elements.userId.value = selected.expectedIdentity?.userId || '';
      form.elements.sources.value = JSON.stringify(selected.sources, null, 2);
      form.elements.allowReplyDrafts.checked = Boolean(workspace.sourceConsent?.allowReplyDrafts);
      sourceSettingsRendered = true;
    }
    const output = await api('/api/output-settings');
    $('#output-directory').textContent = `Local destination: ${output.directory} · ${output.approved ? 'Owner-approved; rechecked on every write' : 'Not approved; file output disabled'}`;
    renderJobs();
  } catch (error) {
    latestConnections = null;
    updateOutlookDraftAvailability();
    host.replaceChildren(makeElement('p', 'empty-panel', `Connection status unavailable: ${error.message}`));
    $('#file-content-status').textContent = 'Selected file content unavailable: host connection status could not be verified; no read was attempted.';
    renderJobs();
  }
}

async function refreshState() {
  const loaded = await api('/api/state');
  csrfToken = loaded.csrfToken;
  workspace = {
    tasks: loaded.tasks,
    conversations: loaded.conversations || [],
    drafts: loaded.drafts,
    links: loaded.links || [],
    activity: loaded.activity,
    profile: loaded.profile || { displayName: '', timezone: '' },
    jobs: loaded.jobs || [],
    preferences: loaded.preferences || {},
    timezoneStatus: loaded.timezoneStatus,
    documents: loaded.documents || [],
    records: loaded.records || [],
    sourceConsent: loaded.sourceConsent || null,
    draftOperations: loaded.draftOperations || [],
    backups: loaded.backups || [],
    recoveries: loaded.recoveries || [],
    onboarding: loaded.onboarding, sourceConfigurationDraft: loaded.sourceConfigurationDraft
  };
  renderTasks();
  renderDrafts();
  renderLinks();
  renderActivity();
  renderProfile();
  renderJobs();
  renderRecords();
  renderDraftOperations();
  renderBackups();
  await renderConnections();
  renderSetup();
}

function navigate(view) {
  if (!viewNames[view]) return;
  document.querySelectorAll('.view').forEach(section => { section.hidden = section.id !== `view-${view}`; });
  document.querySelectorAll('[data-view]').forEach(button => {
    const selected = button.dataset.view === view;
    button.classList.toggle('selected', selected);
    if (button.tagName === 'BUTTON') button.setAttribute('aria-current', selected ? 'page' : 'false');
  });
  $('#breadcrumb').textContent = viewNames[view];
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
}

function renderTaskSourceReview() {
  const needsRecheck = importingSource !== null && !validSourceResultRevision(importingSource.resultId);
  const status = $('#task-source-review');
  status.hidden = !importingSource;
  status.textContent = needsRecheck ? taskSourceRecheckMessage
    : importingSource ? 'Selected source preview is incomplete, untrusted evidence, not proof of task ownership or an outstanding assignment. Its exact source-result revision and current owner are checked again when saving.' : '';
  $('#task-form button[type="submit"]').disabled = needsRecheck || localFormOperations.has($('#task-form'));
}

function openTaskDialog(task = null) {
  if (localFormBusy($('#task-form'))) return;
  $('#task-form').querySelector('[data-save-status]').textContent = '';
  importingSource = null;
  editingId = task?.id || null;
  editingRevision = task?.revision || 0;
  const form = $('#task-form');
  form.elements.title.value = task?.title || '';
  form.elements.details.value = task?.details || '';
  form.elements.status.value = task?.status || 'next';
  form.elements.priority.value = task?.priority || 'normal';
  form.elements.dueDate.value = task?.dueDate || '';
  renderTaskSourceReview();
  renderAccountOptions(form.elements.accountId, task?.accountId || '');
  $('#task-dialog-title').textContent = task ? 'A small change.' : 'Make a little progress.';
  $('#task-dialog').showModal();
  form.elements.title.focus();
}

$('#new-task').addEventListener('click', () => openTaskDialog());
function closeTaskDialog() {
  if (!localFormBusy($('#task-form'))) $('#task-dialog').close();
}
$('#close-task').addEventListener('click', closeTaskDialog);
$('#cancel-task').addEventListener('click', closeTaskDialog);
$('#task-dialog').addEventListener('cancel', event => { if (localFormBusy($('#task-form'))) event.preventDefault(); });
$('#task-search').addEventListener('input', renderTasks);
$('#show-done').addEventListener('change', renderTasks);
$('#task-account-filter').addEventListener('change', renderTasks);
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
window.addEventListener('hashchange', () => navigate(location.hash.slice(1) || 'board'));

$('#task-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (importingSource && !validSourceResultRevision(importingSource.resultId)) {
    renderTaskSourceReview();
    showNotice(taskSourceRecheckMessage, true);
    return;
  }
  const form = event.currentTarget;
  if (localFormBusy(form)) return;
  const data = Object.fromEntries(new FormData(form));
  const taskId = editingId;
  const source = importingSource ? { ...importingSource } : null;
  await saveLocalForm(form, {
    path: taskId ? `/api/tasks/${encodeURIComponent(taskId)}` : source ? '/api/tasks/from-evidence' : '/api/tasks',
    method: taskId ? 'PATCH' : 'POST',
    body: taskId ? { ...data, revision: editingRevision } : { ...data, ...source },
    validate: result => savedLocalItem(result.task, taskId, result.deduplicated !== true),
    accept(result, unchanged) {
      const task = result.task;
      if (result.accountSelectionRetained) {
        $('#task-source-review').hidden = false;
        $('#task-source-review').textContent = result.message;
        return;
      }
      if (result.deduplicated !== true) {
        editingId = task.id;
        editingRevision = task.revision;
        importingSource = null;
        $('#task-source-review').hidden = true;
        $('#task-source-review').textContent = '';
      }
      if (unchanged) $('#task-dialog').close();
    },
    success: result => result.deduplicated === true ? result.message || 'Existing task retained; completed work was not reopened.'
      : taskId ? 'Task updated locally.' : 'Task saved locally at your explicit request.'
  });
});

$('#draft-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (localFormBusy(form)) return;
  const data = Object.fromEntries(new FormData(form));
  const draftId = editingDraftId;
  await saveLocalForm(form, {
    path: draftId ? `/api/drafts/${encodeURIComponent(draftId)}` : '/api/drafts',
    method: draftId ? 'PATCH' : 'POST', body: draftId ? { ...data, revision: editingDraftRevision } : data,
    validate: result => savedLocalItem(result.draft, draftId, true),
    accept(result, unchanged) {
      const draft = result.draft;
      if (unchanged) {
        form.reset();
        editingDraftId = null;
        form.querySelector('h2').textContent = 'New local draft';
        $('#draft-save').textContent = 'Save unsent draft';
      } else {
        editingDraftId = draft.id;
        editingDraftRevision = draft.revision;
        form.querySelector('h2').textContent = 'Edit local draft';
        $('#draft-save').textContent = 'Save changes locally';
      }
    },
    success: 'Saved locally as an unsent draft. No email was sent.'
  });
});

$('#link-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (localFormBusy(form)) return;
  const data = Object.fromEntries(new FormData(form));
  await saveLocalForm(form, {
    path: '/api/links', method: 'POST', body: data,
    validate(result) {
      const link = savedLocalItem(result.link);
      const title = data.title.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
      const url = data.url.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
      if (link.url !== new URL(url).href || link.title !== title) throw new Error('The saved link receipt does not match the submitted label and URL.');
    },
    accept(result, unchanged) { if (unchanged && !result.deduplicated) form.reset(); },
    success: result => result.deduplicated
      ? 'Existing link with this label and URL retained. No duplicate was created; your text is retained.'
      : 'Link saved locally. Esquie did not open or fetch it.'
  });
});

$('#profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (localFormBusy(form)) return;
  const data = Object.fromEntries(new FormData(form));
  profileRendered = true;
  await saveLocalForm(form, {
    path: '/api/profile', method: 'PATCH', body: data,
    validate(result) {
      if (!result.profile || typeof result.profile !== 'object' || Array.isArray(result.profile)) throw new Error('The saved profile receipt is missing.');
    },
    success: 'Profile saved locally.'
  });
});

$('#microsoft365-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#microsoft365-connect');
  button.disabled = true;
  try {
    let sources;
    try { sources = JSON.parse(form.elements.sources.value); }
    catch { throw new Error('Source selections must be valid JSON. Do not enter credentials.'); }
    await api('/api/microsoft365/connect', {
      method: 'POST',
      body: JSON.stringify({
        consent: form.elements.consent.checked,
        expectedIdentity: { tenantId: form.elements.tenantId.value, userId: form.elements.userId.value },
        sources, allowReplyDrafts: form.elements.allowReplyDrafts.checked
      })
    });
    await refreshState();
    showNotice('Owner verified for selected operations only. Run a bounded source check; no sync is claimed.');
  } catch (error) {
    showNotice(error.message, true);
    await renderConnections();
  }
});
$('#microsoft365-disconnect').addEventListener('click', async () => {
  try {
    await api('/api/microsoft365/disconnect', { method: 'POST', body: '{}' });
    await refreshState();
    showNotice('Disconnected. Historical local source evidence was not replayed or deleted.');
  } catch (error) { showNotice(error.message, true); }
});
$('#meeting-insight-list-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (meetingListAttempt) return;
  const meetingId = form.elements.meetingId.value.trim().normalize('NFC');
  if (!form.elements.listConsent.checked || !meetingId || meetingId.length > 2000 ||
      !/^[A-Za-z0-9_+=:@.!-]+$/.test(meetingId) || meetingId === '.' || meetingId === '..') {
    $('#meeting-insight-list-status').textContent = 'Enter a supported exact meeting ID and explicitly consent before requesting its list.';
    return;
  }
  form.elements.meetingId.value = meetingId;
  const attempt = { requestId: crypto.randomUUID(), meetingId, phase: 'pending' };
  meetingListAttempt = attempt;
  form.elements.meetingId.disabled = true;
  form.elements.listConsent.disabled = true;
  $('#meeting-insight-list-form button[type="submit"]').disabled = true;
  const status = $('#meeting-insight-list-status');
  status.textContent = `Submitting list request ${attempt.requestId}. Do not submit another request.`;
  try {
    const receipt = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'meeting_insight_list', meetingId: attempt.meetingId,
        listConsent: true, requestId: attempt.requestId
      })
    }, null, 202);
    const job = receipt?.job;
    if (!job || typeof job.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(job.id) ||
        job.kind !== 'meeting_insight_list' || job.requestId !== attempt.requestId ||
        job.payload?.meetingId !== attempt.meetingId || job.status !== 'queued') throw new Error('Invalid receipt.');
    form.elements.listConsent.checked = false;
    try {
      await refreshState();
      status.textContent = `List request ${attempt.requestId} was queued. Check Activity for its result; no detail is authorized.`;
      meetingListAttempt = null;
      form.elements.meetingId.disabled = false;
      form.elements.listConsent.disabled = false;
      $('#meeting-insight-list-form button[type="submit"]').disabled = false;
    } catch {
      attempt.phase = 'queued-refresh-failed';
      status.textContent = `List request ${attempt.requestId} was queued, but Activity could not be refreshed. Check Activity before starting another request; do not blindly retry.`;
      $('#meeting-insight-list-reset').hidden = false;
    }
  } catch {
    attempt.phase = 'unknown';
    form.elements.meetingId.value = attempt.meetingId;
    form.elements.listConsent.checked = true;
    status.textContent = `The queue outcome for list request ${attempt.requestId} is unknown. The meeting and consent are retained. Check Activity before starting another request; do not blindly retry.`;
    $('#meeting-insight-list-reset').hidden = false;
  }
});
$('#meeting-insight-list-reset').addEventListener('click', () => {
  if (!meetingListAttempt || meetingListAttempt.phase === 'pending' ||
      !confirm('Have you checked Activity for this request? Starting another request can repeat a read.')) return;
  meetingListAttempt = null;
  const form = $('#meeting-insight-list-form');
  form.elements.meetingId.disabled = false;
  form.elements.listConsent.disabled = false;
  form.elements.listConsent.checked = false;
  $('#meeting-insight-list-form button[type="submit"]').disabled = false;
  $('#meeting-insight-list-reset').hidden = true;
  $('#meeting-insight-list-status').textContent = 'To request another list, review the meeting and give new consent.';
});
$('#assistant-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/assistant', { method: 'POST', body: JSON.stringify({ prompt: event.currentTarget.elements.prompt.value }) });
    await refreshState();
    showNotice('Assistant request queued; Activity will show its actual result.');
  } catch (error) { showNotice(error.message, true); }
});
$('#outlook-draft-form').addEventListener('input', () => {
  if (!outlookSubmitting && reconcileOutlookMessageId()) outlookRequestId = crypto.randomUUID();
});
$('#outlook-draft-form').addEventListener('change', () => {
  if (!outlookSubmitting && reconcileOutlookMessageId()) outlookRequestId = crypto.randomUUID();
});
$('#outlook-draft-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (outlookSubmitting || !reconcileOutlookMessageId()) return;
  if (outlookPreviewNeedsRecheck()) {
    $('#outlook-draft-result').textContent = outlookSourceRecheckMessage;
    showNotice('Reply draft blocked. Run a new bounded source check; your unsaved reply text has been retained.', true);
    updateOutlookDraftAvailability();
    return;
  }
  const form = event.currentTarget;
  outlookSubmitting = true;
  for (const control of form.elements) control.disabled = true;
  try {
    const result = await api('/api/mail/reply-drafts', {
      method: 'POST',
      body: JSON.stringify({
        messageId: form.elements.messageId.value, text: form.elements.text.value,
        replyAll: form.elements.replyAll.value === 'true', requestId: outlookRequestId,
        ...(outlookSourcePreview ? {
          sourceReference: {
            jobId: outlookSourcePreview.jobId, resultId: outlookSourcePreview.resultId,
            itemId: outlookSourcePreview.sourceKey
          }
        } : {})
      })
    });
    $('#outlook-draft-result').textContent = `${result.message} Subject: ${result.draft.subject}. Review the exact draft manually in Outlook.`;
    showNotice('Unsent draft retained for manual review. No email was sent.');
  } catch (error) {
    $('#outlook-draft-result').textContent = error.message;
    showNotice(error.message, true);
  } finally {
    outlookSubmitting = false;
    for (const control of form.elements) control.disabled = false;
    $('#outlook-draft-form button[type="submit"]').disabled = true;
    await renderConnections();
  }
});

$('#preferences-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = {
    paused: form.elements.paused.checked,
    automaticRefresh: form.elements.automaticRefresh.checked,
    dailyBackups: form.elements.dailyBackups.checked,
    quietStart: form.elements.quietStart.value,
    quietEnd: form.elements.quietEnd.value
  };
  try {
    await api('/api/preferences', { method: 'PATCH', body: JSON.stringify(data) });
    await refreshState();
    showNotice('Worker preferences saved locally.');
  } catch (error) { showNotice(error.message, true); }
});

for (const [id, endpoint, field] of [
  ['#output-form', '/api/output-approval', 'confirmPrivateNonSynced'],
  ['#demo-approval-form', '/api/demo-approval', 'confirmSyntheticLocalOnly']
]) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault();
    const approved = event.currentTarget.elements[field].checked;
    try {
      await api(endpoint, { method: 'POST', body: JSON.stringify({ [field]: approved }) });
      await refreshState();
      await renderConnections();
      showNotice(approved ? 'Explicit local approval saved.' : 'Approval revoked; queued work is rechecked before execution.');
    } catch (error) { showNotice(error.message, true); }
  });
}
$('#fake-demo-form').addEventListener('submit', async event => {
  event.preventDefault();
  await queueJob('fake_demo', { confirmFakeOnly: event.currentTarget.elements.confirmFakeOnly.checked });
});

$('#close-conversation').addEventListener('click', closeConversation);
$('#conversation-dialog').addEventListener('cancel', closeConversation);
$('#close-document').addEventListener('click', () => $('#document-dialog').close());
$('#conversation-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (conversationBusy() || !conversationTaskId) return;
  const text = form.elements.text.value;
  const taskId = conversationTaskId;
  await saveLocalForm(form, {
    path: `/api/tasks/${taskId}/conversation`, method: 'POST', body: { text },
    validate: result => savedLocalItem(result.message),
    accept(result, unchanged) { if (unchanged) form.reset(); },
    refresh: renderConversation,
    success: 'Note saved locally; no command or external action executed.'
  });
});
$('#evidence-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (conversationBusy() || !conversationTaskId) return;
  const taskId = conversationTaskId;
  const body = Object.fromEntries(new FormData(form));
  await saveLocalForm(form, {
    path: `/api/tasks/${taskId}/evidence`, method: 'POST', body,
    validate: result => savedLocalItem(result.evidence),
    accept(result, unchanged) { if (unchanged) form.reset(); },
    refresh: async () => { await refreshState(); await renderConversation(); },
    success: 'Evidence attached as owner-provided, unverified context.'
  });
});
$('#summarize-task').addEventListener('click', () => queueJob('task_summary', { taskId: conversationTaskId }));
document.querySelectorAll('[data-job]').forEach(button => button.addEventListener('click', () => queueJob(button.dataset.job)));
$('#meeting-form').addEventListener('submit', async event => {
  event.preventDefault();
  await queueJob('meeting_notes', { notes: event.currentTarget.elements.notes.value });
});
accountSubmission = bindAccountFormSubmission({
  form: $('#account-form'),
  submitButton: $('#account-form').querySelector('[type="submit"]'),
  getValues: () => Object.fromEntries(new FormData($('#account-form'))),
  send: async values => {
    const form = $('#account-form');
    const updating = Boolean(form.dataset.recordId);
    const body = { ...values, category: 'account' };
    if (updating) body.revision = Number(form.dataset.revision);
    const result = await api(updating ? `/api/records/${encodeURIComponent(form.dataset.recordId)}` : '/api/records', {
      method: updating ? 'PATCH' : 'POST',
      body: JSON.stringify(body)
    });
    return result.record;
  },
  onSuccess: async ({ record, submitted }) => {
    const form = $('#account-form');
    const baseline = applyAccountSaveResult({
      form,
      submitButton: form.querySelector('[type="submit"]'),
      cancelButton: $('#account-cancel-edit'),
      submitted,
      current: Object.fromEntries(new FormData(form)),
      record,
      reset: resetAccountForm
    });
    if (baseline !== null) accountFormBaseline = baseline;
  },
  refresh: refreshState,
  onRefreshError: error => showNotice(`The account was saved locally, but the account list could not be refreshed: ${error.message}`, true),
  onRefreshed: () => showNotice('Saved as owner-provided local context, not source-verified.'),
  onError: error => showNotice(error.message, true)
});

const outcomeForm = $('#outcome-form');
outcomeForm.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (localFormBusy(form)) return;
  const body = Object.fromEntries(new FormData(form));
  if (form.dataset.recordId) { body.category = form.dataset.category; body.revision = Number(form.dataset.revision); }
  const recordId = form.dataset.recordId;
  await saveLocalForm(form, {
    path: recordId ? `/api/records/${recordId}` : '/api/records',
    method: recordId ? 'PATCH' : 'POST', body,
    validate: result => savedLocalItem(result.record, recordId, true),
    accept(result, unchanged) {
      const record = result.record;
      if (unchanged) {
        form.reset();
        delete form.dataset.recordId;
        delete form.dataset.revision;
        delete form.dataset.category;
        form.elements.category.disabled = false;
        form.querySelector('[type="submit"]').textContent = 'Save local entry';
      } else {
        form.dataset.recordId = record.id;
        form.dataset.revision = String(record.revision);
        form.dataset.category = record.category;
        form.elements.category.disabled = true;
        form.querySelector('[type="submit"]').textContent = 'Save entry changes locally';
      }
    },
    success: 'Saved as owner-provided local context, not source-verified.'
  });
});

$('#account-search').addEventListener('input', renderRecords);
$('#new-account').addEventListener('click', () => {
  if (!confirmAccountFormReplacement()) return;
  resetAccountForm();
  $('#account-form').elements.title.focus();
});
$('#account-cancel-edit').addEventListener('click', () => {
  if (!confirmAccountFormReplacement()) return;
  resetAccountForm();
});

$('#resume-setup').addEventListener('click', async () => { await changeSetup('resume'); navigate('setup'); });
$('#setup-back').addEventListener('click', () => changeSetup('back'));
$('#setup-skip').addEventListener('click', () => changeSetup('skip'));
$('#setup-form').addEventListener('submit', event => {
  event.preventDefault();
  const step = workspace.onboarding.step;
  if (step === 7) { changeSetup('complete', { confirmReview: true }); return; }
  const values = Object.fromEntries(new FormData(event.currentTarget));
  let data = values;
  if ([2, 5].includes(step)) data = values.title.trim() ? { record: { ...values, category: step === 2 ? 'account' : 'outcome', ...(setupRecord ? { id: setupRecord.id, revision: setupRecord.revision || 0 } : {}) } } : {};
  if (step === 6) {
    try { data = { configuration: values.configuration.trim() ? JSON.parse(values.configuration) : null }; }
    catch { showNotice('Source configuration must be valid JSON without credentials.', true); return; }
  }
  changeSetup('save', { data });
});

async function start() {
  try {
    accountFormBaseline = accountFormSnapshot();
    await refreshState();
    const setup = workspace.onboarding;
    navigate(setup?.status === 'in-progress' || (setup?.status === 'not-started' && !setup.legacy) ? 'setup' : location.hash.slice(1) || 'board');
    if (accessStorageWarning) showNotice(accessStorageWarning, true);
  } catch (error) {
    $('#task-list').replaceChildren(makeElement('p', 'empty-panel', `Workspace could not load: ${error.message}`));
    showNotice(`The local workspace could not be loaded: ${error.message}`, true);
  }
}

renderOutlookSourcePreview();
start();

let lastBackgroundRefresh = 0;
setInterval(async () => {
  if (refreshing || document.hidden || draggedTask || document.activeElement?.closest('.task-moves, #task-account-filter')) return;
  const active = workspace.jobs?.some(job => ['queued', 'running'].includes(job.status));
  if (!active && Date.now() - lastBackgroundRefresh < 15_000) return;
  lastBackgroundRefresh = Date.now();
  refreshing = true;
  try {
    await refreshState();
    if (conversationTaskId && $('#conversation-dialog').open) await renderConversation();
  } catch (error) {
    showNotice(`Workspace refresh failed: ${error.message}`, true);
  } finally { refreshing = false; }
}, 1500);
