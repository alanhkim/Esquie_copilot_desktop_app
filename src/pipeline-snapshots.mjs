import { createHash, randomUUID } from 'node:crypto';

export const MAX_PIPELINE_TEXT_LENGTH = 16_000;
export const MAX_PIPELINE_ROWS = 100;
export const MAX_PIPELINE_COLUMNS = 30;
export const MAX_PIPELINE_SNAPSHOTS = 50;

const TYPES = new Set(['opportunities', 'milestones']);

function invalid(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cleanCell(value) {
  return value.normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function splitRow(line, markdown) {
  if (!markdown) return line.split('\t').map(cleanCell);
  const trimmed = line.trim();
  const cells = trimmed.split('|').map(cleanCell);
  if (trimmed.startsWith('|')) cells.shift();
  if (trimmed.endsWith('|')) cells.pop();
  return cells;
}

function isSeparator(cells) {
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function validType(type) {
  if (!TYPES.has(type)) throw invalid('Choose Opportunities or Milestones for this local snapshot.');
}

export function parsePipelineTable(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_PIPELINE_TEXT_LENGTH || text.includes('\0')) {
    throw invalid('Paste a non-empty table of at most 16,000 characters.');
  }
  const lines = text.split(/\r?\n/).filter(line => line.trim() || line.includes('\t'));
  if (lines.length < 2) throw invalid('Include a header row and at least one data row.');
  const headerLine = lines[0];
  const normalizedHeader = headerLine.trim();
  const hasHeaderPipe = normalizedHeader.includes('|');
  const hasHeaderTabs = normalizedHeader.includes('\t');
  const markdownHeaders = hasHeaderPipe ? splitRow(normalizedHeader, true) : [];
  const nextRowCells = hasHeaderPipe ? splitRow(lines[1], true) : [];
  const nextRowIsMarkdownDivider = hasHeaderPipe
    && isSeparator(nextRowCells)
    && nextRowCells.length === markdownHeaders.length;
  if (hasHeaderTabs && hasHeaderPipe && nextRowIsMarkdownDivider) {
    throw invalid('Ambiguous table format. Use a clearly tab-separated table or a pipe table with indentation only.');
  }
  const markdown = hasHeaderPipe && !hasHeaderTabs;
  if (!markdown && !hasHeaderTabs) throw invalid('Use a Markdown pipe table or a tab-separated table.');
  const headers = splitRow(lines[0], markdown);
  if (headers.length < 1 || headers.length > MAX_PIPELINE_COLUMNS) {
    throw invalid(`Include between 1 and ${MAX_PIPELINE_COLUMNS} columns.`);
  }
  if (headers.some(header => !header || header.length > 120)) {
    throw invalid('Every owner-provided column header must contain 1 to 120 characters.');
  }

  const rows = [];
  for (const [index, line] of lines.slice(1).entries()) {
    const cells = splitRow(line, markdown);
    if (markdown && index === 0 && cells.length === headers.length && isSeparator(cells)) continue;
    if (cells.length !== headers.length) throw invalid('Every row must have the same number of columns as the header.');
    if (cells.some(cell => cell.length > 4000)) throw invalid('Each table cell must be at most 4,000 characters.');
    rows.push(cells);
    if (rows.length > MAX_PIPELINE_ROWS) throw invalid(`Import at most ${MAX_PIPELINE_ROWS} rows per snapshot.`);
  }
  if (!rows.length) throw invalid('No data rows were found in the pasted table.');
  return { headers, rows };
}

function contentHash(type, text) {
  return createHash('sha256').update(JSON.stringify([type, text])).digest('hex');
}

function snapshotRevision(snapshots) {
  const values = snapshots.map(({ id, type, contentHash: hash, createdAt }) => ({ id, type, hash, createdAt }));
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function reviewedConflict(message) {
  return invalid(message, 409);
}

export function previewPipelineSnapshot(snapshots, type, text) {
  validType(type);
  const { headers, rows } = parsePipelineTable(text);
  const hash = contentHash(type, text);
  const duplicate = snapshots.find(snapshot => snapshot.type === type && snapshot.contentHash === hash);
  return {
    type,
    headers,
    rows,
    textHash: hash,
    revision: snapshotRevision(snapshots),
    duplicateSnapshotId: duplicate?.id || null,
    snapshotCount: snapshots.length,
    limit: MAX_PIPELINE_SNAPSHOTS
  };
}

export function confirmPipelineSnapshot(state, { type, text, revision, textHash, reviewed, requestId }, now) {
  validType(type);
  if (reviewed !== true) throw reviewedConflict('Review the exact table preview and explicitly confirm before saving.');
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw invalid('A unique confirmation request ID is required.');
  }
  const current = previewPipelineSnapshot(state.pipelineSnapshots, type, text);
  if (typeof textHash !== 'string' || current.textHash !== textHash) {
    throw reviewedConflict('Pasted table changed after preview. Preview the current text before confirming.');
  }

  const previousRequest = state.pipelineSnapshots.find(snapshot => snapshot.requestId === requestId);
  if (previousRequest) {
    if (previousRequest.type !== type || previousRequest.contentHash !== current.textHash) {
      throw reviewedConflict('This confirmation ID was already used for different snapshot content.');
    }
    return { saved: true, duplicate: true, deduplicated: true, snapshot: previousRequest };
  }

  if (typeof revision !== 'string' || current.revision !== revision) {
    throw reviewedConflict('Saved pipeline snapshots changed after preview. Refresh and review the current snapshot before saving.');
  }
  const duplicate = state.pipelineSnapshots.find(snapshot => snapshot.type === type && snapshot.contentHash === current.textHash);
  if (duplicate) return { saved: false, duplicate: true, deduplicated: false, snapshot: duplicate };
  if (state.pipelineSnapshots.length >= MAX_PIPELINE_SNAPSHOTS) {
    throw reviewedConflict(`The local snapshot limit (${MAX_PIPELINE_SNAPSHOTS}) has been reached. Existing snapshots were preserved; no data was removed.`);
  }

  const snapshot = {
    id: randomUUID(),
    type,
    headers: current.headers,
    rows: current.rows,
    contentHash: current.textHash,
    revision: 1,
    requestId,
    provenance: 'owner-pasted-unverified',
    createdAt: now
  };
  state.pipelineSnapshots.unshift(snapshot);
  return { saved: true, duplicate: false, deduplicated: false, snapshot };
}
