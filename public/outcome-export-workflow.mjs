const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[0-9a-f]{64}$/i;
const maxWorkbookBytes = 1024 * 1024;
const storageKey = 'esquie:outcome-export-request';

export function monthlyOutcomeRecords(records) {
  if (!Array.isArray(records)) throw new Error('Local outcome records are unavailable.');
  return records.filter(record => record && ['outcome', 'engagement'].includes(record.category));
}

export function monthlyOutcomesSnapshotPayload(records) {
  const relevant = monthlyOutcomeRecords(records).map(record => ({
    id: record.id,
    revision: record.revision,
    category: record.category,
    title: record.title,
    note: record.note,
    date: record.date,
    importKey: record.importKey || '',
    sourceUrl: record.sourceUrl || '',
    workshopImport: record.workshopImport || null,
    provenance: record.provenance || ''
  })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return JSON.stringify(relevant);
}

export async function monthlyOutcomesSnapshotHash(records) {
  const bytes = new TextEncoder().encode(monthlyOutcomesSnapshotPayload(records));
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function validIntent(snapshotHash, recordCount) {
  return typeof snapshotHash === 'string' && digestPattern.test(snapshotHash) &&
    Number.isSafeInteger(recordCount) && recordCount >= 0;
}

function storedIntent(requestId, snapshotHash, recordCount) {
  return JSON.stringify({ requestId, snapshotHash, recordCount });
}

function parseStoredIntent(value) {
  if (typeof value !== 'string') return null;
  if (requestIdPattern.test(value)) return { requestId: value, snapshotHash: null, recordCount: null };
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        requestIdPattern.test(parsed.requestId || '') && validIntent(parsed.snapshotHash, parsed.recordCount)) {
      return parsed;
    }
  } catch {}
  return { requestId: null, snapshotHash: null, recordCount: null, unusable: true };
}

function validReceipt(result, ticket) {
  const receipt = result?.export;
  return Boolean(result && typeof result === 'object' && !Array.isArray(result) &&
    typeof result.reused === 'boolean' &&
    receipt && typeof receipt === 'object' && !Array.isArray(receipt) &&
    receipt.id === ticket.requestId && receipt.format === 'xlsx' &&
    receipt.recordCount === ticket.recordCount &&
    receipt.snapshotHash === ticket.snapshotHash &&
    Number.isSafeInteger(receipt.contentBytes) && receipt.contentBytes > 0 &&
    receipt.contentBytes <= maxWorkbookBytes &&
    typeof receipt.contentSha256 === 'string' && digestPattern.test(receipt.contentSha256) &&
    typeof receipt.fileName === 'string' && receipt.fileName === `monthly-outcomes-${ticket.requestId}.xlsx` &&
    typeof receipt.createdAt === 'string' && Number.isFinite(Date.parse(receipt.createdAt)));
}

export function createOutcomeExportWorkflow({
  initialRequestId,
  storage = null,
  idFactory = () => globalThis.crypto.randomUUID()
} = {}) {
  if (storage === null) {
    try { storage = globalThis.localStorage; }
    catch { storage = null; }
  }
  let storageReady = Boolean(storage && typeof storage.getItem === 'function' &&
    typeof storage.setItem === 'function' && typeof storage.removeItem === 'function');
  let markerUnusable = false;
  let originalSnapshotHash = null;
  let originalRecordCount = null;
  if (initialRequestId === undefined) {
    try {
      const saved = storageReady ? parseStoredIntent(storage.getItem(storageKey)) : null;
      initialRequestId = saved?.requestId ?? null;
      originalSnapshotHash = saved?.snapshotHash ?? null;
      originalRecordCount = saved?.recordCount ?? null;
      markerUnusable = Boolean(saved?.unusable);
    }
    catch { storageReady = false; initialRequestId = null; }
  }
  let requestId = initialRequestId;
  if (requestId !== null && (typeof requestId !== 'string' || !requestIdPattern.test(requestId))) requestId = null;
  let inFlight = null;
  let uncertain = Boolean(requestId || markerUnusable);

  const snapshot = () => ({
    busy: Boolean(inFlight),
    requestId,
    uncertain,
    storageReady,
    retryIntentAvailable: Boolean(requestId && validIntent(originalSnapshotHash, originalRecordCount))
  });

  return {
    snapshot,
    begin({ snapshotHash, recordCount, retryExisting = false }) {
      if (inFlight || !validIntent(snapshotHash, recordCount)) return null;
      if (retryExisting) {
        if (!uncertain || !requestId) {
          throw new Error('The original export request is unavailable. Inspect Documents and Activity; no retry was sent.');
        }
        if (!validIntent(originalSnapshotHash, originalRecordCount)) {
          throw new Error('The original export intent is unavailable. Inspect Documents and Activity; no retry was sent.');
        }
        if (snapshotHash !== originalSnapshotHash || recordCount !== originalRecordCount) {
          throw new Error('Current outcome records differ from the original export intent. Inspect Documents and Activity; no retry was sent.');
        }
      }
      if (!storageReady && !requestId) {
        throw new Error('Persistent local export request tracking is unavailable; no workbook was requested.');
      }
      if (uncertain && !retryExisting) return null;
      if (!requestId) {
        const generated = idFactory();
        if (typeof generated !== 'string' || !requestIdPattern.test(generated)) {
          throw new Error('A safe export request identifier could not be created.');
        }
        try { storage.setItem(storageKey, storedIntent(generated, snapshotHash, recordCount)); }
        catch {
          storageReady = false;
          throw new Error('The original export intent could not be saved in browser storage; no workbook was requested.');
        }
        requestId = generated;
        originalSnapshotHash = snapshotHash;
        originalRecordCount = recordCount;
        markerUnusable = false;
      }
      inFlight = Object.freeze({ requestId, snapshotHash, recordCount });
      uncertain = true;
      return inFlight;
    },
    observePendingRequest(value) {
      const pending = typeof value === 'string' ? { requestId: value } : value;
      if (inFlight || !pending || typeof pending !== 'object' ||
          typeof pending.requestId !== 'string' || !requestIdPattern.test(pending.requestId) ||
          requestId && requestId !== pending.requestId) return false;
      if (!requestId && markerUnusable) return false;
      const hasIntent = validIntent(pending.snapshotHash, pending.recordCount);
      if (requestId && validIntent(originalSnapshotHash, originalRecordCount)) {
        if (hasIntent && (originalSnapshotHash !== pending.snapshotHash || originalRecordCount !== pending.recordCount)) return false;
      } else if (requestId && !validIntent(originalSnapshotHash, originalRecordCount)) {
        return true;
      } else if (hasIntent) {
        originalSnapshotHash = pending.snapshotHash;
        originalRecordCount = pending.recordCount;
      }
      requestId = pending.requestId;
      uncertain = true;
      if (hasIntent && storageReady) {
        try { storage.setItem(storageKey, storedIntent(requestId, originalSnapshotHash, originalRecordCount)); }
        catch { storageReady = false; }
      }
      return true;
    },
    complete(ticket, result) {
      if (ticket !== inFlight) return { status: 'unknown', message: 'The export result could not be matched to its request.' };
      inFlight = null;
      if (!validReceipt(result, ticket)) {
        uncertain = true;
        return { status: 'unknown', message: 'The export response was missing or did not match the requested workbook. Check Documents and Activity before taking further action.' };
      }
      try {
        storage?.removeItem(storageKey);
        requestId = null;
        uncertain = false;
        originalSnapshotHash = null;
        originalRecordCount = null;
        markerUnusable = false;
        return { status: 'completed', receipt: result.export };
      } catch {
        storageReady = false;
        uncertain = true;
        return { status: 'completed-needs-inspection', receipt: result.export };
      }
    },
    fail(ticket) {
      if (ticket !== inFlight) return false;
      inFlight = null;
      uncertain = true;
      return true;
    },
    abandonAfterInspection(confirmed, serverResolved = false) {
      if (inFlight || !uncertain || confirmed !== true || !requestId) return false;
      if (storage && typeof storage.removeItem === 'function') {
        try { storage.removeItem(storageKey); }
        catch { return false; }
      } else if (!serverResolved) return false;
      requestId = null;
      uncertain = false;
      originalSnapshotHash = null;
      originalRecordCount = null;
      markerUnusable = false;
      storageReady = Boolean(storage && typeof storage.setItem === 'function');
      return true;
    }
  };
}

export function outcomeExportStorageKey() {
  return storageKey;
}
