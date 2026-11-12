import { createHash, randomUUID } from 'node:crypto';

const MAX_TEXT_LENGTH = 16_000;
const MAX_ROWS = 100;

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalize(value) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function dateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid('Dates must use YYYY-MM-DD.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw invalid('A workshop date is not a valid calendar date.');
  }
  return value;
}

function linkValue(value) {
  if (!value) return '';
  if (value.length > 2000) throw invalid('Source links must be at most 2,000 characters.');
  let url;
  try { url = new URL(value); } catch { throw invalid('Source links must be valid HTTP or HTTPS URLs.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw invalid('Source links must use HTTP or HTTPS and must not contain credentials.');
  }
  return url.href;
}

function splitRow(line) {
  if (line.includes('\t')) return line.split('\t').map(cell => cell.trim());
  if (!line.includes('|')) throw invalid('Paste a Markdown table or tab-separated table with a header row.');
  const cells = line.trim().split('|').map(cell => cell.trim());
  if (line.trim().startsWith('|')) cells.shift();
  if (line.trim().endsWith('|')) cells.pop();
  return cells;
}

function fieldIndex(headers, names, required = false) {
  const index = headers.findIndex(header => names.includes(normalize(header).replace(/[^a-z0-9]/g, '')));
  if (required && index < 0) throw invalid(`The table needs a ${names[0]} column.`);
  return index;
}

function importKey(row) {
  return JSON.stringify([row.date, normalize(row.account), normalize(row.workshop)]);
}

function storedImportKeys(record) {
  const source = record.workshopImport;
  const keys = new Set();
  if (typeof record.importKey === 'string' && record.importKey) {
    keys.add(record.importKey);
    const originalDate = /^(\d{4}-\d{2}-\d{2})\|/.exec(record.importKey)?.[1];
    if (originalDate && typeof source?.account === 'string' && typeof source?.workshop === 'string') {
      keys.add(importKey({ date: originalDate, account: source.account, workshop: source.workshop }));
    }
  }
  if (typeof record.date === 'string' && typeof source?.account === 'string' && typeof source?.workshop === 'string') {
    keys.add(importKey({ date: record.date, account: source.account, workshop: source.workshop }));
  }
  return [...keys];
}

function digest(records) {
  const relevant = records.filter(record => ['outcome', 'engagement'].includes(record.category))
    .map(({ id, revision, category, title, note, date, importKey: key, sourceUrl, workshopImport }) =>
      ({ id, revision, category, title, note, date, importKey: key || '', sourceUrl: sourceUrl || '', workshopImport: workshopImport || null }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}

export function parseMonthlyOutcomeTable(text, { today = null } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH || text.includes('\0')) {
    throw invalid('Paste a non-empty workshop table of at most 16,000 characters.');
  }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) throw invalid('Include a header row and at least one workshop row.');
  const headers = splitRow(lines[0]).map(value => normalize(value).replace(/[^a-z0-9]/g, ''));
  const dateIndex = fieldIndex(headers, ['date'], true);
  const accountIndex = fieldIndex(headers, ['account', 'customer'], true);
  const workshopIndex = fieldIndex(headers, ['workshop', 'session', 'title'], true);
  const statusIndex = fieldIndex(headers, ['status']);
  const notesIndex = fieldIndex(headers, ['notes', 'note', 'details']);
  const sourceIndex = fieldIndex(headers, ['sourceurl', 'source', 'link']);

  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = splitRow(line);
    if (cells.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    if (cells.length !== headers.length) throw invalid('Every pasted row must have the same number of columns as the header.');
    const at = index => index < 0 ? '' : cells[index];
    const date = dateValue(at(dateIndex));
    const account = at(accountIndex).trim();
    const workshop = at(workshopIndex).trim();
    if (!account || !workshop || account.length > 100 || workshop.length > 100) {
      throw invalid('Each row needs an account and workshop of at most 100 characters.');
    }
    const title = `${account} - ${workshop}`;
    if (title.length > 160) throw invalid('The combined account and workshop title must be at most 160 characters.');
    const status = at(statusIndex).trim() || 'Not provided';
    if (!/^(delivered|completed|scheduled|upcoming|not provided)$/i.test(status)) {
      throw invalid('Status must be Delivered, Completed, Scheduled, Upcoming, or Not provided.');
    }
    if (today && /^(delivered|completed)$/i.test(status) && date > today) {
      throw invalid('Future workshops cannot be marked delivered; use Scheduled or Upcoming.');
    }
    const notes = at(notesIndex).trim();
    if (notes.length > 3500) throw invalid('Workshop notes must be at most 3,500 characters.');
    const sourceUrl = linkValue(at(sourceIndex).trim());
    const note = [`Status: ${status}`, notes].filter(Boolean).join('\n');
    const record = {
      category: 'outcome', title, note, date, sourceUrl,
      importKey: importKey({ date, account, workshop }),
      workshopImport: { account, workshop, status }
    };
    rows.push({ state: 'new', record });
    if (rows.length > MAX_ROWS) throw invalid('Import at most 100 workshop rows at a time.');
  }
  if (!rows.length) throw invalid('No workshop rows were found in the pasted table.');
  return rows;
}

export function previewMonthlyOutcomeImport(records, text, { today = null } = {}) {
  const rows = parseMonthlyOutcomeTable(text, { today });
  const current = (records || []).filter(record => ['outcome', 'engagement'].includes(record.category));
  const byKey = new Map();
  for (const record of current) {
    for (const key of storedImportKeys(record)) {
      const matches = byKey.get(key) || [];
      matches.push(record);
      byKey.set(key, matches);
    }
  }
  const pasteByKey = new Map();
  for (const item of rows) {
    const key = item.record.importKey;
    const previousPaste = pasteByKey.get(key);
    const same = candidate => candidate &&
      candidate.title === item.record.title &&
      candidate.date === item.record.date &&
      candidate.note === item.record.note &&
      (candidate.sourceUrl || '') === item.record.sourceUrl;
    if (previousPaste) {
      if (!same(previousPaste[0].record)) {
        for (const duplicate of previousPaste) duplicate.state = 'conflict';
        item.state = 'conflict';
      } else item.state = 'duplicate';
      previousPaste.push(item);
      continue;
    }
    pasteByKey.set(key, [item]);
    const existing = byKey.get(key) || [];
    if (existing.length) item.state = existing.every(same) ? 'duplicate' : 'conflict';
    else if (current.some(record => !record.importKey && record.date === item.record.date && record.title === item.record.title)) item.state = 'conflict';
  }
  for (const items of pasteByKey.values()) {
    if (items.some(item => item.state === 'conflict')) for (const item of items) item.state = 'conflict';
  }
  return {
    revision: digest(records || []),
    textHash: createHash('sha256').update(text).digest('hex'),
    rows
  };
}

export function confirmMonthlyOutcomeImport(state, text, revision, textHash, reviewed, now, options = {}) {
  if (reviewed !== true) {
    const error = new Error('Review the workshop preview and explicitly confirm before importing.');
    error.status = 409;
    throw error;
  }
  const preview = previewMonthlyOutcomeImport(state.records, text, options);
  if (typeof textHash !== 'string' || preview.textHash !== textHash) {
    const error = new Error('Pasted text changed after preview. Preview the current text before confirming.');
    error.status = 409;
    throw error;
  }
  if (typeof revision !== 'string' || preview.revision !== revision) {
    const error = new Error('Local outcomes changed after preview. Refresh the preview before confirming.');
    error.status = 409;
    throw error;
  }
  const imported = [];
  for (const item of preview.rows) {
    if (item.state !== 'new') continue;
    const record = {
      id: randomUUID(), ...item.record, revision: 1,
      provenance: 'owner-pasted-unverified', createdAt: now
    };
    state.records.unshift(record);
    imported.push(record);
  }
  return {
    imported: imported.length,
    duplicates: preview.rows.filter(item => item.state === 'duplicate').length,
    conflicts: preview.rows.filter(item => item.state === 'conflict').length,
    records: imported
  };
}
