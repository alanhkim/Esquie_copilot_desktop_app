import { laneMove, matchingTasks } from './task-board.mjs';

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
let editingId = null;
let importingSource = null;
let sourceSettingsRendered = false;
let outlookRequestId = crypto.randomUUID();
let outlookMessageId = '';
let outlookSourcePreview = null;
let outlookSubmitting = false;
const outlookSourceRecheckMessage = 'This historical preview cannot create a reply draft: its source-result revision is missing or invalid. Run a new bounded source check in Operations, then select the new mail preview in Activity. Your unsaved reply text is retained; copy it somewhere safe before clearing it to switch previews. No manual-ID fallback will be used.';
const taskSourceRecheckMessage = 'This historical preview cannot create a task: its source-result revision is missing or invalid. Run a new bounded source check in Operations, then explicitly select its preview in Activity. Entered task text is retained; no manual-task fallback will be used.';
let editingDraftId = null;
let editingRevision = 0;
let editingDraftRevision = 0;
let csrfToken = '';
let noticeTimer;
let conversationTaskId = null;
let profileRendered = false;
let preferencesRendered = false;
let refreshing = false;
let setupRevision = null;
let setupRecord = null;
let latestConnections = null;
let draggedTask = null;
let accessToken = '';
let accessStorageWarning = '';
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

async function api(path, options = {}) {
  if (!path.startsWith('/api/')) throw new Error('Only local API paths are accepted.');
  if (!accessToken) throw new Error('Owner launch authorization is missing. Open your private Esquie launch file or the desktop application.');
  const headers = new Headers(options.headers || {});
  headers.set('X-Esquie-Access', accessToken);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('X-Esquie-CSRF', csrfToken);
  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function inertHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
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

function formatDate(value) {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function renderTasks() {
  const host = $('#task-list');
  const query = $('#task-search').value.trim().toLocaleLowerCase();
  const showDone = $('#show-done').checked;
  const matching = matchingTasks(workspace.tasks, workspace.conversations || [], query, showDone);
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
  if (!matching.length && query) host.prepend(makeElement('p', 'empty-panel', 'No tasks match that search.'));
}

function renderTask(task) {
  const card = makeElement('article', 'task-card');
  const complete = makeElement('button', `task-marker${task.status === 'done' ? ' done' : ''}`, task.status === 'done' ? '✓' : '');
  complete.type = 'button';
  complete.setAttribute('aria-label', task.status === 'done' ? 'Reopen task' : 'Complete task');
  complete.addEventListener('click', () => updateTask(task.id, laneMove(task, task.status === 'done' ? 'next' : 'done')));

  const content = makeElement('div', 'task-content');
  content.append(makeElement('h3', 'task-title', task.title));
  if (task.details) content.append(makeElement('p', 'task-details', task.details));
  const metadata = [
    laneNames[task.status] || 'Next up',
    task.priority === 'important' ? 'Important' : '',
    task.dueDate ? `Due ${task.dueDate}` : '',
    `Created ${formatDate(task.createdAt) || 'unknown (legacy)'}`,
    `Updated ${formatDate(task.updatedAt)}`
  ].filter(Boolean);
  content.append(makeElement('div', 'task-meta', metadata.join(' · ')));

  const actions = makeElement('div', 'task-actions');
  const edit = makeElement('button', '', 'Edit');
  edit.type = 'button';
  edit.addEventListener('click', () => openTaskDialog(task));
  const notes = makeElement('button', '', 'Notes & history');
  notes.type = 'button';
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
  $('#worker-state').textContent = paused ? 'Worker paused. Queued work is retained.' : 'Local worker is running while this host is open. Quiet hours defer work in your profile timezone.';
  if (!jobs.length) host.append(makeElement('p', 'empty-lane', 'No jobs requested.'));
  for (const job of jobs.slice(0, 50)) {
    const card = makeElement('article', 'surface job-card');
    const heading = makeElement('div', 'section-title');
    heading.append(makeElement('h3', '', job.kind.replaceAll('_', ' ')), makeElement('span', `tag job-${job.status}`, job.status.toUpperCase()));
    card.append(heading);
    card.append(makeElement('p', 'muted', `Attempt ${job.attempts} · ${formatDate(job.updatedAt)} · ${job.origin === 'schedule' ? 'Opt-in scheduled attempt' : 'Explicit local request'}`));
    if (job.error) card.append(makeElement('p', 'job-error', job.error));
    if (job.result?.text) card.append(makeElement('pre', 'job-result', job.result.text));
    if (job.result?.sources) {
      for (const source of job.result.sources) {
        const coverage = typeof source.coverage === 'object' ? source.coverage?.status : source.coverage;
        const section = makeElement('details', 'source-preview');
        section.append(makeElement('summary', '', `${source.source}: ${source.status} · ${source.inspected} inspected${coverage ? ` · ${coverage}` : ''}`));
        if (source.message) section.append(makeElement('p', 'muted', source.message));
        for (const limitation of source.coverage?.limitations || []) section.append(makeElement('p', 'muted', limitation));
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
          }
          section.append(evidence);
        }
        card.append(section);
      }
    }
    if (['failed', 'partial', 'interrupted'].includes(job.status)) {
      const retry = makeElement('button', 'button', 'Explicitly retry');
      retry.type = 'button';
      retry.addEventListener('click', async () => {
        try {
          await api(`/api/jobs/${job.id}/retry`, { method: 'POST', body: '{}' });
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
  for (const [selector, categories] of [['#account-list', ['account']], ['#outcome-list', ['outcome', 'engagement']]]) {
    const host = $(selector);
    host.replaceChildren();
    const records = (workspace.records || []).filter(record => categories.includes(record.category));
    if (!records.length) host.append(makeElement('p', 'empty-lane', 'No owner-provided entries yet.'));
    for (const record of records) {
      const card = makeElement('article', 'surface draft-card');
      card.append(makeElement('strong', '', record.title), makeElement('small', '', `${record.category} · ${record.date || 'No date'} · Owner-provided, unverified`));
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
        const form = $(record.category === 'account' ? '#account-form' : '#outcome-form');
        form.dataset.recordId = record.id;
        form.dataset.revision = String(record.revision || 0);
        form.dataset.category = record.category;
        for (const key of ['title', 'note', 'date']) if (form.elements[key]) form.elements[key].value = record[key] || '';
        if (form.elements.category) { form.elements.category.value = record.category; form.elements.category.disabled = true; }
        form.querySelector('[type="submit"]').textContent = 'Save entry changes locally';
        form.elements.title.focus();
      });
      card.append(edit);
      host.append(card);
    }
  }
}

let outcomesImportPreview = null;
const outcomeImportForm = $('#outcome-import-form');
const outcomeImportText = outcomeImportForm.elements.text;
const outcomeImportResult = $('#outcome-import-preview-result');
const outcomeImportReview = outcomeImportForm.elements.reviewed;
const outcomeImportConfirm = $('#outcome-import-confirm');
const outcomeImportReject = $('#outcome-import-reject');

function renderOutcomeImportPreview() {
  outcomeImportResult.replaceChildren();
  const rows = outcomesImportPreview?.rows || [];
  if (outcomesImportPreview) {
    const summary = makeElement('p', 'muted', `Preview: ${rows.filter(row => row.state === 'new').length} new, ${rows.filter(row => row.state === 'duplicate').length} duplicate, ${rows.filter(row => row.state === 'conflict').length} conflict. Conflicts and duplicates are not overwritten.`);
    outcomeImportResult.append(summary);
    const list = makeElement('div', 'draft-list');
    for (const { state, record } of rows) {
      const card = makeElement('article', 'draft-card');
      card.append(makeElement('strong', '', `${state}: ${record.title}`));
      card.append(makeElement('small', '', `${record.date} · ${record.workshopImport.status} · owner-pasted, unverified`));
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
  $('#outcome-import-review-row').hidden = !outcomesImportPreview || !hasNew;
  outcomeImportConfirm.disabled = !outcomesImportPreview || !hasNew || !outcomeImportReview.checked;
  outcomeImportReject.disabled = !outcomesImportPreview;
}

outcomeImportText.addEventListener('input', () => {
  outcomesImportPreview = null;
  outcomeImportReview.checked = false;
  renderOutcomeImportPreview();
});
outcomeImportForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#outcome-import-preview');
  button.disabled = true;
  try {
    outcomesImportPreview = await api('/api/outcomes/import/preview', {
      method: 'POST', body: JSON.stringify({ text: outcomeImportText.value })
    });
    outcomeImportReview.checked = false;
    renderOutcomeImportPreview();
    showNotice('Preview ready. Review each row; nothing has been imported.');
  } catch (error) {
    outcomesImportPreview = null;
    outcomeImportReview.checked = false;
    renderOutcomeImportPreview();
    showNotice(error.message, true);
  } finally { button.disabled = false; }
});
outcomeImportReview.addEventListener('change', renderOutcomeImportPreview);
outcomeImportReject.addEventListener('click', () => {
  outcomesImportPreview = null;
  outcomeImportReview.checked = false;
  renderOutcomeImportPreview();
  showNotice('Preview discarded. No outcomes were changed.');
});
outcomeImportConfirm.addEventListener('click', async () => {
  if (!outcomesImportPreview || !outcomeImportReview.checked) return;
  outcomeImportConfirm.disabled = true;
  try {
    const result = await api('/api/outcomes/import/confirm', {
      method: 'POST',
      body: JSON.stringify({
        text: outcomeImportText.value,
        revision: outcomesImportPreview.revision,
        textHash: outcomesImportPreview.textHash,
        reviewed: true
      })
    });
    outcomesImportPreview = null;
    outcomeImportReview.checked = false;
    renderOutcomeImportPreview();
    await refreshState();
    showNotice(`Imported ${result.imported}; skipped ${result.duplicates} duplicate and ${result.conflicts} conflicting rows.`);
  } catch (error) {
    showNotice(error.message, true);
    outcomesImportPreview = null;
    outcomeImportReview.checked = false;
    renderOutcomeImportPreview();
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

async function openConversation(task) {
  conversationTaskId = task.id;
  $('#conversation-title').textContent = task.title;
  await renderConversation();
  $('#conversation-dialog').showModal();
}

async function renderConversation() {
  if (!conversationTaskId) return;
  try {
    const result = await api(`/api/tasks/${conversationTaskId}/conversation`);
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
    for (const item of workspace.tasks.find(task => task.id === conversationTaskId)?.evidence || []) {
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
  } catch (error) { showNotice(error.message, true); }
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
  teams: ['Teams', 'Selected authorized chats, channels and transcripts are read-only; no interaction or exhaustive sync.'],
  reporting: ['Reporting', 'Disconnected. If configured later, business reporting is read-only.'],
  sharepoint: ['SharePoint / OneDrive', 'Selected authorized file metadata only; content and Loop pages remain unavailable. Never a document output destination.'],
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
      }
      host.append(card);
    }
    const m365 = connections.microsoft365;
    $('#microsoft365-status').textContent = m365.hostAuthenticationAvailable
      ? `${m365.state}${m365.reason ? ` · ${m365.reason}` : ''}. Owner verification does not imply source permission or synchronization.`
      : 'Unavailable: this host has no trustworthy authenticated delegated token provider. IDs and consent alone cannot enable a connection.';
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
  } catch (error) {
    latestConnections = null;
    updateOutlookDraftAvailability();
    host.replaceChildren(makeElement('p', 'empty-panel', `Connection status unavailable: ${error.message}`));
  }
}

async function refreshState() {
  const loaded = await api('/api/state');
  csrfToken = loaded.csrfToken;
  workspace = {
    tasks: loaded.tasks,
    drafts: loaded.drafts,
    links: loaded.links || [],
    activity: loaded.activity,
    profile: loaded.profile || { displayName: '', timezone: '' },
    jobs: loaded.jobs || [],
    preferences: loaded.preferences || {},
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
  $('#task-form button[type="submit"]').disabled = needsRecheck;
}

function openTaskDialog(task = null) {
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
  $('#task-dialog-title').textContent = task ? 'A small change.' : 'Make a little progress.';
  $('#task-dialog').showModal();
  form.elements.title.focus();
}

$('#new-task').addEventListener('click', () => openTaskDialog());
$('#close-task').addEventListener('click', () => $('#task-dialog').close());
$('#cancel-task').addEventListener('click', () => $('#task-dialog').close());
$('#task-search').addEventListener('input', renderTasks);
$('#show-done').addEventListener('change', renderTasks);
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
  const data = Object.fromEntries(new FormData(form));
  try {
    if (editingId) {
      await api(`/api/tasks/${encodeURIComponent(editingId)}`, { method: 'PATCH', body: JSON.stringify({ ...data, revision: editingRevision }) });
      showNotice('Task updated locally.');
    } else {
      const result = await api(importingSource ? '/api/tasks/from-evidence' : '/api/tasks', { method: 'POST', body: JSON.stringify({ ...data, ...importingSource }) });
      showNotice(result.deduplicated ? 'Existing task retained; completed work was not reopened.' : 'Task saved locally at your explicit request.');
    }
    await refreshState();
    $('#task-dialog').close();
  } catch (error) {
    if (importingSource) {
      $('#task-source-review').hidden = false;
      $('#task-source-review').textContent = error.message;
    }
    showNotice(error.message, true);
  }
});

$('#draft-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    if (editingDraftId) {
      await api(`/api/drafts/${encodeURIComponent(editingDraftId)}`, { method: 'PATCH', body: JSON.stringify({ ...data, revision: editingDraftRevision }) });
    } else {
      await api('/api/drafts', { method: 'POST', body: JSON.stringify(data) });
    }
    form.reset();
    editingDraftId = null;
    form.querySelector('h2').textContent = 'New local draft';
    $('#draft-save').textContent = 'Save unsent draft';
    await refreshState();
    showNotice('Saved locally as an unsent draft. No email was sent.');
  } catch (error) {
    showNotice(error.message, true);
  }
});

$('#link-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    await api('/api/links', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    await refreshState();
    showNotice('Link saved locally. Esquie did not open or fetch it.');
  } catch (error) {
    showNotice(error.message, true);
  }
});

$('#profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api('/api/profile', { method: 'PATCH', body: JSON.stringify(data) });
    await refreshState();
    showNotice('Profile saved locally.');
  } catch (error) {
    showNotice(error.message, true);
  }
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

$('#close-conversation').addEventListener('click', () => { $('#conversation-dialog').close(); conversationTaskId = null; });
$('#close-document').addEventListener('click', () => $('#document-dialog').close());
$('#conversation-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const text = form.elements.text.value;
  try {
    await api(`/api/tasks/${conversationTaskId}/conversation`, { method: 'POST', body: JSON.stringify({ text }) });
    form.reset();
    await renderConversation();
    showNotice('Note saved locally; no command or external action executed.');
  } catch (error) { showNotice(error.message, true); }
});
$('#evidence-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api(`/api/tasks/${conversationTaskId}/evidence`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset();
    await refreshState();
    await renderConversation();
    showNotice('Evidence attached as owner-provided, unverified context.');
  } catch (error) { showNotice(error.message, true); }
});
$('#summarize-task').addEventListener('click', () => queueJob('task_summary', { taskId: conversationTaskId }));
document.querySelectorAll('[data-job]').forEach(button => button.addEventListener('click', () => queueJob(button.dataset.job)));
$('#meeting-form').addEventListener('submit', async event => {
  event.preventDefault();
  await queueJob('meeting_notes', { notes: event.currentTarget.elements.notes.value });
});
for (const [id, fixedCategory] of [['#account-form', 'account'], ['#outcome-form', null]]) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    if (fixedCategory) body.category = fixedCategory;
    if (form.dataset.recordId) { body.category = form.dataset.category; body.revision = Number(form.dataset.revision); }
    try {
      await api(form.dataset.recordId ? `/api/records/${form.dataset.recordId}` : '/api/records', { method: form.dataset.recordId ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      form.reset();
      delete form.dataset.recordId;
      delete form.dataset.revision;
      delete form.dataset.category;
      if (form.elements.category) form.elements.category.disabled = false;
      form.querySelector('[type="submit"]').textContent = 'Save local entry';
      await refreshState();
      showNotice('Saved as owner-provided local context, not source-verified.');
    } catch (error) { showNotice(error.message, true); }
  });
}

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
  if (refreshing || document.hidden || draggedTask || document.activeElement?.closest('.task-moves')) return;
  const active = workspace.jobs?.some(job => ['queued', 'running'].includes(job.status));
  if (!active && Date.now() - lastBackgroundRefresh < 15_000) return;
  lastBackgroundRefresh = Date.now();
  refreshing = true;
  try {
    await refreshState();
    if (conversationTaskId) await renderConversation();
  } catch (error) {
    showNotice(`Workspace refresh failed: ${error.message}`, true);
  } finally { refreshing = false; }
}, 1500);
