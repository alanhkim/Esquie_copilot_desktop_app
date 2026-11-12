import { createTextElement as text, canReplaceAccountTarget } from './account-workspace.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

export function renderMetricMatrix({ document, host, records, formatDate }) {
  const accounts = records.filter(record => record.category === 'account');
  const series = new Map();
  for (const account of accounts) for (const metric of account.metrics || []) {
    series.set(JSON.stringify([metric.label, metric.unit]), { label: metric.label, unit: metric.unit });
  }
  const columns = [...series].sort(([left], [right]) => left.localeCompare(right)).slice(0, 20);
  host.replaceChildren();
  host.append(text(document, 'p', 'muted', `Showing ${Math.min(accounts.length, 50)} of ${accounts.length} accounts and ${columns.length} of ${series.size} exact label/unit series. Limits: 50 rows, 20 columns; remaining entries are available in Accounts, not silently aggregated.`));
  if (!accounts.length || !columns.length) {
    host.append(text(document, 'p', 'empty-lane', 'No local metric matrix is available. Missing observations are unknown, not zero.'));
    return;
  }
  const table = text(document, 'table', 'local-metric-matrix');
  table.append(text(document, 'caption', '', 'OWNER-ENTERED, UNVERIFIED. Latest means last recorded locally, not latest observation date, verified health or live source status. Exact labels/units define columns; no conversion, thresholds or health colors.'));
  const head = text(document, 'thead');
  const header = text(document, 'tr');
  const accountHeader = text(document, 'th', '', 'Exact local account');
  accountHeader.scope = 'col';
  header.append(accountHeader);
  for (const [, column] of columns) {
    const th = text(document, 'th', '', `${column.label} (${column.unit || 'unit not provided'})`);
    th.scope = 'col';
    header.append(th);
  }
  head.append(header);
  table.append(head);
  const body = text(document, 'tbody');
  for (const account of accounts.slice(0, 50)) {
    const row = text(document, 'tr');
    const label = text(document, 'th', '', `${account.title} [${account.id}]`);
    label.scope = 'row';
    row.append(label);
    for (const [key] of columns) {
      const metric = [...(account.metrics || [])].reverse().find(item => JSON.stringify([item.label, item.unit]) === key);
      const cell = text(document, 'td');
      if (!metric) cell.append(text(document, 'p', 'muted', 'Unknown: no owner-entered observation'));
      else {
        cell.append(text(document, 'strong', '', metric.value));
        cell.append(text(document, 'small', '', `Observation date: ${metric.date || 'Unknown'}; recorded: ${formatDate(metric.createdAt) || 'Unknown'}`));
      }
      row.append(cell);
    }
    body.append(row);
  }
  table.append(body);
  host.append(table);
}

export function bindLocalSspDirectory({ document, form, newButton, check, status, host, storage, randomUUID, getRecords, send, refresh, onRecorded, confirmDiscard, formatDate }) {
  const key = 'esquie-local-ssp-editor-v1';
  let editor = null;
  let pending = false;
  let blocked = false;
  const message = value => { status.textContent = value; };
  const selections = () => [...form.elements.accountIds.children].filter(option => option.selected).map(option => option.value).sort();
  const lock = () => {
    for (const control of form.elements) control.disabled = !editor || Boolean(editor.body) || pending || blocked;
    newButton.disabled = pending || Boolean(editor?.body) || blocked;
    for (const edit of host.querySelectorAll('[data-ssp-edit]')) edit.disabled = pending || Boolean(editor?.body) || blocked;
    check.hidden = !editor?.body;
    check.disabled = pending;
  };
  const persist = () => {
    const encoded = JSON.stringify(editor);
    storage.setItem(key, encoded);
    if (storage.getItem(key) !== encoded) throw new Error('Editor/request identity could not be retained.');
  };
  const fill = () => {
    form.elements.recordId.value = editor?.id || '';
    form.elements.title.value = editor?.title || '';
    form.elements.confirmOwnerEntered.checked = false;
  };
  const dirty = () => editor && (form.elements.title.value !== (editor.savedTitle || '') || JSON.stringify(selections()) !== JSON.stringify(editor.savedAccountIds || []));
  const choose = next => {
    if (!canReplaceAccountTarget({ saving: pending || Boolean(editor?.body) || blocked, dirty: dirty(), confirmDiscard })) {
      message('The SSP editor was not switched. Review unsaved text or resolve the pending request first.');
      return;
    }
    editor = next;
    try { persist(); fill(); render(); message('Local SSP context only: explicitly select accounts; no identity or affiliation is verified.'); }
    catch (error) { blocked = true; message(`Editor unavailable; nothing was submitted: ${error.message}`); lock(); }
  };
  try {
    const raw = storage.getItem(key);
    if (raw) {
      const saved = JSON.parse(raw);
      if (!uuid(saved?.id) || !Number.isSafeInteger(saved.revision) || saved.revision < 0 ||
          typeof saved.title !== 'string' || saved.title.length > 100 || !Array.isArray(saved.accountIds) ||
          saved.accountIds.length > 50 || saved.accountIds.some(id => !uuid(id)) ||
          (saved.body && (!uuid(saved.body.requestId) || saved.body.revision !== saved.revision ||
            typeof saved.body.title !== 'string' || !Array.isArray(saved.body.accountIds)))) throw new Error('Unrecognized saved SSP editor.');
      editor = saved;
      fill();
      message(editor.body ? `SSP outcome unknown for request ${editor.body.requestId}. Check saved history; no retry will be sent.` : 'Unsubmitted local SSP editor restored; no request was sent.');
    }
  } catch (error) { blocked = true; message(`SSP editor blocked: ${error.message}. Review the saved directory before using a new window.`); }
  const valid = result => {
    const record = result?.record;
    const receipt = result?.receipt;
    const accountIdsValid = ids => Array.isArray(ids) && ids.length <= 50 &&
      ids.every(uuid) && new Set(ids).size === ids.length;
    const matchesReceipt = entry => entry && receipt && entry.id === receipt.id && entry.kind === receipt.kind &&
      entry.requestId === receipt.requestId && entry.requestRevision === receipt.requestRevision &&
      entry.appliedRevision === receipt.appliedRevision && entry.title === receipt.title &&
      JSON.stringify(entry.accountIds) === JSON.stringify(receipt.accountIds) &&
      entry.createdAt === receipt.createdAt && entry.provenance === receipt.provenance;
    const currentMatchesAppliedReceipt = record?.revision !== receipt?.appliedRevision ||
      (record.title === receipt.title && JSON.stringify(record.accountIds) === JSON.stringify(receipt.accountIds));
    return record?.id === editor.id && record.category === 'ssp' &&
      typeof record.title === 'string' && record.title.length <= 100 && record.provenance === 'owner-provided-unverified' &&
      Number.isSafeInteger(record.revision) && record.revision >= 1 && Array.isArray(record.history) &&
      accountIdsValid(record.accountIds) && record.history.some(matchesReceipt) && currentMatchesAppliedReceipt &&
      uuid(receipt?.id) && receipt.kind === 'local-ssp-saved' && receipt.provenance === 'owner-provided-unverified' &&
      receipt.requestId === editor.body.requestId && receipt.requestRevision === editor.body.revision &&
      receipt.appliedRevision === editor.body.revision + 1 && receipt.title === editor.body.title &&
      accountIdsValid(receipt.accountIds) && JSON.stringify(receipt.accountIds) === JSON.stringify(editor.body.accountIds);
  };
  const accept = result => {
    if (!valid(result)) throw new Error('SSP save receipt does not match the selected local ID and submitted intent.');
    onRecorded(result.record);
    editor = { id: result.record.id, revision: result.record.revision, title: result.record.title, accountIds: [...result.record.accountIds],
      savedTitle: result.record.title, savedAccountIds: [...result.record.accountIds] };
    try { persist(); }
    catch (error) { blocked = true; message(`SSP confirmed saved locally, but editor storage failed: ${error.message}. Do not repeat the save.`); return false; }
    blocked = false;
    fill();
    render();
    message('SSP context confirmed saved locally, UNVERIFIED. No identity, affiliation or reporting source was checked.');
    return true;
  };
  form.addEventListener('input', () => {
    if (!editor || editor.body || pending || blocked) return;
    Object.assign(editor, { title: form.elements.title.value, accountIds: selections() });
    try { persist(); }
    catch (error) { blocked = true; message(`Editor storage unavailable; nothing was submitted: ${error.message}`); lock(); }
  });
  form.addEventListener('change', () => {
    if (!editor || editor.body || pending || blocked) return;
    editor.accountIds = selections();
    try { persist(); }
    catch (error) { blocked = true; message(`Editor storage unavailable; nothing was submitted: ${error.message}`); lock(); }
  });
  newButton.addEventListener('click', () => choose({ id: randomUUID(), revision: 0, title: '', accountIds: [], savedTitle: '', savedAccountIds: [] }));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!editor || editor.body || pending || blocked) return;
    if (!form.elements.confirmOwnerEntered.checked) { message('Explicitly confirm this owner-entered, unverified local context. Nothing was submitted.'); return; }
    const title = form.elements.title.value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    editor = { ...editor, title, accountIds: selections(), body: { title, accountIds: selections(), revision: editor.revision, requestId: randomUUID(), confirmOwnerEntered: true } };
    try { persist(); }
    catch (error) { blocked = true; message(`Not submitted: request identity storage failed: ${error.message}`); lock(); return; }
    pending = true;
    lock();
    message('SSP save pending; no result is claimed and no retry will be sent.');
    let confirmed = false;
    try {
      const result = await send(editor.id, editor.body);
      if (!valid(result)) throw new Error('SSP save receipt did not match this request.');
      confirmed = true;
      if (accept(result)) {
        try { await refresh(); }
        catch (error) { message(`SSP confirmed saved locally; display refresh failed: ${error.message}. Do not repeat the save.`); }
      }
    } catch (error) {
      if (!confirmed && error?.definitiveRejection === true) {
        delete editor.body;
        form.elements.confirmOwnerEntered.checked = false;
        try { persist(); message(`SSP save rejected: ${error.message}. Input and local ID retained; review current records before editing again.`); }
        catch (storageError) { blocked = true; message(`SSP rejected, but editor storage failed: ${storageError.message}`); }
      } else message(`SSP outcome unknown for request ${editor.body?.requestId || 'recorded intent'}: ${error.message}. Blind retries are blocked; check saved history.`);
    } finally { pending = false; lock(); }
  });
  check.addEventListener('click', async () => {
    if (!editor?.body || pending) return;
    pending = true;
    lock();
    try {
      await refresh();
      const record = getRecords().find(item => item.id === editor.id && item.category === 'ssp');
      const receipt = record?.history.find(item => item.requestId === editor.body.requestId);
      if (receipt) accept({ record, receipt });
      else message(`SSP outcome remains unknown for request ${editor.body.requestId}. No saved receipt is visible; no retry was sent.`);
    } catch (error) { message(`SSP outcome remains unresolved: ${error.message}. No retry was sent.`); }
    finally { pending = false; lock(); }
  });
  function render() {
    const records = getRecords();
    const accounts = records.filter(record => record.category === 'account');
    const selected = editor ? [...editor.accountIds] : [];
    form.elements.accountIds.replaceChildren();
    for (const id of new Set([...accounts.map(record => record.id), ...selected])) {
      const account = accounts.find(record => record.id === id);
      const option = text(document, 'option', '', account ? `${account.title} [${id}]` : `Unavailable account [${id}]`);
      option.value = id;
      option.selected = selected.includes(id);
      form.elements.accountIds.append(option);
    }
    host.replaceChildren();
    const ssps = records.filter(record => record.category === 'ssp');
    if (!ssps.length) host.append(text(document, 'p', 'empty-lane', 'No owner-entered local SSP records. No directory lookup was performed.'));
    for (const record of ssps) {
      const card = text(document, 'article', 'surface draft-card');
      card.append(text(document, 'strong', '', record.title), text(document, 'small', '', `Local SSP record ID: ${record.id} · revision ${record.revision} · OWNER-ENTERED, UNVERIFIED`));
      for (const id of record.accountIds) card.append(text(document, 'p', '', `${accounts.find(account => account.id === id)?.title || 'Unavailable account'} [${id}] — explicitly selected, not a verified affiliation`));
      if (!record.accountIds.length) card.append(text(document, 'p', 'muted', 'No accounts explicitly selected; none were inferred.'));
      const history = text(document, 'details', 'account-history');
      history.append(text(document, 'summary', '', `Local save history (${record.history.length})`));
      for (const receipt of [...record.history].reverse()) history.append(text(document, 'p', '', `${formatDate(receipt.createdAt) || 'Unknown date'} · ${receipt.title} · selected IDs: ${receipt.accountIds.join(', ') || 'None'} · request ${receipt.requestId}`));
      card.append(history);
      const edit = text(document, 'button', 'button', 'Edit this local SSP record');
      edit.type = 'button';
      edit.dataset.sspEdit = record.id;
      edit.disabled = pending || Boolean(editor?.body) || blocked;
      edit.addEventListener('click', () => choose({ id: record.id, revision: record.revision, title: record.title, accountIds: [...record.accountIds], savedTitle: record.title, savedAccountIds: [...record.accountIds] }));
      card.append(edit);
      host.append(card);
    }
    lock();
  }
  render();
  return { render };
}
