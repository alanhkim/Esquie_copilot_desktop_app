import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { createWorker, enqueue, quietHoursActive, quietHoursValid, timezoneAvailable, timezoneStatus } from './worker.mjs';
import { assertOutputAllowed, assertPlainLocalFile, verifyLocalVolume as defaultVerifyLocalVolume } from './local-output.mjs';
import { createMicrosoft365Connectors, ConnectorError } from './connectors/microsoft365.mjs';
import { environmentProxyConfigured, normalizeApprovedHost } from './connectors/safe-file-download.mjs';
import { createAssistantBridge } from './assistant/bridge.mjs';
import { assertPrivateDataDirectory, assertPrivateStorage } from './private-storage.mjs';
import { recoverLocalBackup } from './backups.mjs';
import { confirmMonthlyOutcomeImport, previewMonthlyOutcomeImport } from './monthly-outcomes-import.mjs';
import { createWindowsOcrService, decodeWindowsOcrImage, WindowsOcrError } from './windows-ocr.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const PUBLIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/task-board.mjs', ['task-board.mjs', 'text/javascript; charset=utf-8']],
  ['/account-search.mjs', ['account-search.mjs', 'text/javascript; charset=utf-8']],
  ['/account-workspace.mjs', ['account-workspace.mjs', 'text/javascript; charset=utf-8']],
  ['/outcome-import-workflow.mjs', ['outcome-import-workflow.mjs', 'text/javascript; charset=utf-8']]
]);
const TASK_STATUSES = new Set(['next', 'doing', 'waiting', 'done']);
const MAX_BODY_BYTES = 20_000;
// Escaped JSON for the four advertised account fields fits within this route-specific cap.
const MAX_ACCOUNT_BODY_BYTES = 80_000;
const MAX_OUTCOMES_IMPORT_BODY_BYTES = 128_000;
const MAX_OUTCOMES_OCR_BODY_BYTES = 8_500_000;
const MAX_ACTIVITY_ITEMS = 100;

function taskAccountId(state, value) {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ||
      !state.records.some(record => record.id === value && record.category === 'account')) {
    throw new HttpError(400, 'Choose an existing local account by its record ID, or leave the task unassigned.');
  }
  return value;
}

function privateLauncherContent(launchUrl) {
  return `<!-- Esquie private local launch file; generated -->\n<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Open your private Esquie workspace</title><h1>Your protected local workspace</h1><p>This private file contains a per-start owner capability. Do not share it.</p><a href="${launchUrl}" rel="noreferrer">Open Esquie on this device</a>\n`;
}

function isUnmodifiedPrivateLauncher(content) {
  const match = /href="(http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/#access=[A-Za-z0-9_-]{43})"/.exec(content);
  return Boolean(match && Number(match[2]) <= 65535 && content === privateLauncherContent(match[1]));
}

async function reserveLoopbackPort(port) {
  const server = createServer((_request, response) => {
    response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end('{"status":"starting"}');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });
  return server;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isLoopbackAddress(address) {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  if (normalized === '::1' || normalized === '127.0.0.1') return true;
  return isIP(normalized) === 4 && normalized.startsWith('127.');
}

function safeText(value, label, maxLength, { required = false } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be text.`);
  const cleaned = value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (required && !cleaned) throw new HttpError(400, `${label} is required.`);
  if (cleaned.length > maxLength) throw new HttpError(400, `${label} is too long.`);
  return cleaned;
}

function outcomesImportCall(action) {
  try { return action(); }
  catch (error) {
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
      throw new HttpError(error.status, error.message);
    }
    throw error;
  }
}

function assertOnlyKeys(body, allowed, message) {
  if (Object.keys(body).some(key => !allowed.has(key))) throw new HttpError(400, message);
}

function safeStatus(value) {
  if (!TASK_STATUSES.has(value)) throw new HttpError(400, 'Choose a supported task status.');
  return value;
}

function safeDate(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'Due date must use YYYY-MM-DD.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new HttpError(400, 'Due date is not a valid calendar date.');
  return value;
}

function ownerLocalDate(value, timezone) {
  if (!timezone) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(value);
  } catch {
    throw new HttpError(400, 'The saved owner timezone is invalid. Update it in Operations before importing.');
  }
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${date.year}-${date.month}-${date.day}`;
}

function safeLinkUrl(value) {
  const text = safeText(value, 'URL', 2000, { required: true });
  let url;
  try { url = new URL(text); } catch { throw new HttpError(400, 'Enter a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new HttpError(400, 'Links must use HTTP or HTTPS and must not contain credentials.');
  }
  return url.href;
}

function jsonResponse(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  response.end(JSON.stringify(value));
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'Send JSON using Content-Type: application/json.');

  const maximumBytes = typeof maxBytes === 'function' ? MAX_ACCOUNT_BODY_BYTES : maxBytes;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected an object.');
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
  const permittedBytes = typeof maxBytes === 'function' ? maxBytes(body) : maxBytes;
  if (size > permittedBytes) throw new HttpError(413, 'Request body is too large.');
  return body;
}

function validOrigin(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
  const originValue = request.headers.origin;
  const hostValue = request.headers.host;
  if (typeof originValue !== 'string' || typeof hostValue !== 'string') return false;

  try {
    const origin = new URL(originValue);
    const host = new URL(`http://${hostValue}`);
    return origin.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(origin.hostname) &&
      origin.hostname === host.hostname &&
      origin.port === host.port &&
      origin.origin === `http://${host.host}`;
  } catch {
    return false;
  }
}

function validToken(provided, expected) {
  if (typeof provided !== 'string') return false;
  const actualBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function taskById(state, id) {
  const task = state.tasks.find(item => item.id === id);
  if (!task) throw new HttpError(404, 'Task not found.');
  return task;
}

function recordActivity(state, kind, message, now) {
  state.activity.unshift({ id: randomUUID(), kind, message, createdAt: now });
  state.activity = state.activity.slice(0, MAX_ACTIVITY_ITEMS);
}

function addLocalTask(state, values, now) {
  const task = { id: randomUUID(), ...values, revision: 1, evidence: values.evidence || [], createdAt: now, updatedAt: now, completedAt: values.status === 'done' ? now : null, history: [] };
  taskEvent(task, 'created', now, { toStatus: task.status });
  for (const evidence of task.evidence) taskEvent(task, 'evidence-added', now, { evidenceId: evidence.id });
  state.tasks.unshift(task);
  recordActivity(state, 'task-created', `Added task: ${task.title}`, now);
  return task;
}

function taskEvent(task, kind, at, details = {}) {
  task.history ||= [];
  task.history.push({ id: randomUUID(), kind, at, ...details });
}

function updateProfile(state, body) {
  const allowed = new Set(['displayName', 'timezone', 'email', 'manager', 'people', 'workspaceName', 'role', 'writingStyle']);
  if (!Object.keys(body).length) throw new HttpError(400, 'Enter supported local profile fields.');
  assertOnlyKeys(body, allowed, 'Unsupported local profile fields.');
  if (Object.hasOwn(body, 'timezone')) {
    const timezone = safeText(body.timezone, 'Timezone', 80);
    if (timezone) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { throw new HttpError(400, 'Enter a valid IANA timezone.'); }
    }
    if (!timezone && (state.preferences.quietStart || state.preferences.automaticRefresh || state.preferences.dailyBackups)) throw new HttpError(400, 'Disable scheduled work and quiet hours before clearing the timezone.');
    state.profile.timezone = timezone;
  }
  for (const [field, max] of [['displayName', 80], ['email', 320], ['manager', 160], ['people', 2000], ['workspaceName', 160], ['role', 160], ['writingStyle', 2000]]) {
    if (!Object.hasOwn(body, field)) continue;
    const text = safeText(body[field], field, max);
    if (field === 'email' && text && !/^[^@\s]+@[^@\s]+$/.test(text)) throw new HttpError(400, 'Enter your own valid email or leave it blank.');
    state.profile[field] = text;
  }
  return state.profile;
}

function saveLocalRecord(state, body, now, category) {
  assertOnlyKeys(body, new Set(['id', 'revision', 'category', 'title', 'note', 'date', 'plan', 'stakeholders']), 'Unsupported local record fields.');
  if (body.category !== category) throw new HttpError(400, 'Choose the record category for this setup step.');
  if (category !== 'account' && (Object.hasOwn(body, 'plan') || Object.hasOwn(body, 'stakeholders'))) {
    throw new HttpError(400, 'Account plans and stakeholders can only be saved on local account records.');
  }
  const record = body.id ? state.records.find(item => item.id === body.id && item.category === category) : null;
  if (body.id && !record) throw new HttpError(404, 'Local record not found.');
  const values = {
    title: safeText(body.title, 'Title', 160, { required: true }),
    note: Object.hasOwn(body, 'note') ? safeText(body.note, 'Note', 4000) : record?.note || '',
    date: Object.hasOwn(body, 'date') ? (body.date ? safeDate(body.date) : '') : record?.date || '',
    ...(category === 'account' ? {
      plan: Object.hasOwn(body, 'plan') ? safeText(body.plan, 'Account plan', 4000) : record?.plan || '',
      stakeholders: Object.hasOwn(body, 'stakeholders') ? safeText(body.stakeholders, 'Stakeholders', 4000) : record?.stakeholders || ''
    } : {})
  };
  if (record) {
    if (body.revision !== (record.revision || 0)) throw new HttpError(409, 'Local record changed. Refresh before updating.');
    Object.assign(record, values, {
      ...(category === 'account' ? { history: Array.isArray(record.history) ? record.history : [] } : {}),
      updatedAt: now,
      revision: (record.revision || 0) + 1
    });
    return record;
  }
  const created = {
    id: randomUUID(), category, ...values, revision: 1, provenance: 'owner-provided-unverified', createdAt: now,
    ...(category === 'account' ? { history: [] } : {})
  };
  state.records.unshift(created);
  return created;
}

function sourceConsent(body) {
  const object = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${label} must be an object.`);
    return value;
  };
  const identity = object(body.expectedIdentity, 'Expected identity');
  assertOnlyKeys(identity, new Set(['tenantId', 'userId']), 'Expected identity accepts only tenant and user IDs, never credentials.');
  const sources = object(body.sources, 'Source selections');
  assertOnlyKeys(sources, new Set(['mail', 'calendar', 'chats', 'channels', 'transcripts', 'oneNotePages', 'meetingInsights', 'meetingInsightMeetings', 'files']), 'Only supported explicit source selections are accepted.');
  const selected = {};
  for (const key of ['mail', 'calendar']) if (Object.hasOwn(sources, key)) {
    if (typeof sources[key] !== 'boolean') throw new HttpError(400, `${key} selection must be a boolean.`);
    selected[key] = sources[key];
  }
  for (const [key, fields] of [
    ['chats', null], ['oneNotePages', null], ['meetingInsightMeetings', null], ['channels', ['teamId', 'channelId']],
    ['transcripts', ['meetingId', 'transcriptId']], ['meetingInsights', ['meetingId', 'insightId']], ['files', ['driveId', 'itemId', 'approvedHost']]
  ]) if (Object.hasOwn(sources, key)) {
    if (!Array.isArray(sources[key]) || sources[key].length > 10) throw new HttpError(400, `${key} must contain at most 10 approved sources.`);
    selected[key] = sources[key].map(value => {
      if (!fields) return safeText(value, 'Approved source ID', 2000, { required: true });
      object(value, 'Approved source pair');
      assertOnlyKeys(value, new Set(fields), 'Source pairs accept only their exact IDs and optional selected-file hostname, never credentials or source content.');
      const selectedPair = Object.fromEntries(fields.filter(field => field !== 'approvedHost')
        .map(field => [field, safeText(value[field], field, 2000, { required: true })]));
      if (key === 'files' && Object.hasOwn(value, 'approvedHost')) {
        try { selectedPair.approvedHost = normalizeApprovedHost(value.approvedHost); }
        catch { throw new HttpError(400, 'A file approvedHost must be a canonical lowercase hostname without a scheme, port, or credentials.'); }
      }
      return selectedPair;
    });
  }
  if (typeof body.allowReplyDrafts !== 'boolean') throw new HttpError(400, 'Explicitly allow or disallow unsent reply drafts.');
  return {
    consent: body.consent === true,
    expectedIdentity: {
      tenantId: safeText(identity.tenantId, 'Tenant ID', 200, { required: true }),
      userId: safeText(identity.userId, 'User ID', 200, { required: true })
    },
    sources: selected, allowReplyDrafts: body.allowReplyDrafts
  };
}

function publicJobs(jobs) {
  return jobs.map(job => {
    const copy = structuredClone(job);
    for (const result of [copy.result, copy.previousResult]) {
      for (const source of result?.sources || []) {
        delete source.replyBindings;
        delete source.fileBindings;
      }
    }
    return copy;
  });
}

export async function startServer({
  dataDir = process.env.ESQUIE_DATA_DIR || join(homedir(), '.esquie-local'),
  port = Number(process.env.ESQUIE_PORT || 4317),
  connectors = {},
  microsoft365Options = {},
  clock = () => new Date(),
  workerIntervalMs = 1000,
  verifyLocalVolume = defaultVerifyLocalVolume,
  windowsOcrService = null
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ESQUIE_PORT must be an integer from 0 to 65535.');
  const microsoft365 = createMicrosoft365Connectors(microsoft365Options);
  const assistant = createAssistantBridge();
  let shuttingDown = false;
  let connectionDecision = 0;
  let appliedConnectionDecision = 0;
  let connectionEpoch = null;
  const pendingConnections = new Set();
  const disconnectMicrosoft365 = () => {
    connectionEpoch = null;
    for (const controller of pendingConnections) controller.abort();
    microsoft365.disconnect();
  };
  const checkConnectionDecision = decision => {
    if (shuttingDown) throw new HttpError(503, 'Workspace is shutting down. No connection was applied.');
    if (decision < appliedConnectionDecision) throw new HttpError(409, 'A newer owner connection decision was applied. Refresh before reconnecting.');
  };
  const outcomesOcr = windowsOcrService || createWindowsOcrService();

  let root = assertPrivateDataDirectory(dataDir);
  const csrfToken = randomBytes(32).toString('base64url');
  const accessToken = randomBytes(32).toString('base64url');
  const server = await reserveLoopbackPort(port);
  let store;
  let worker;
  let storeClosed = false;
  const closeStore = async () => {
    if (store && !storeClosed) { storeClosed = true; await store.close(); }
  };
  try {
  const created = await mkdir(root, { recursive: true, mode: 0o700 });
  const originalRoot = root;
  await assertPrivateStorage(root, { created: created !== undefined });
  root = assertPrivateDataDirectory(await realpath(root));
  const outputRedirected = originalRoot.toLowerCase() !== root.toLowerCase();
  store = await openStore(root);
  const updateState = change => store.update(change);
  const sourceConnectors = { ...microsoft365.connectors, ...connectors };
  const sourceIdentity = () => microsoft365.status().identity;
  const sourceHealth = new Map();
  let outputApprovalSequence = 0n;
  let latestOutputApproval = 0n;
  let demoApprovalSequence = 0n;
  let latestDemoApproval = 0n;
  const assertOutput = () => {
    if (!store.state.preferences.localOutputApproved) throw new Error('Local output approval is absent or has been revoked.');
  };
  let preferenceRequestRevision = 0;
  const preferenceRevisions = new Map();
  const sourceAuthorizationReference = source => {
    const connection = microsoft365.status();
    const consent = store.state.sourceConsent;
    if (connection.state !== 'connected' || !connection.verifiedOwner || !connection.identity ||
        !consent?.consentId || consent.expectedIdentity?.tenantId !== connection.identity.tenantId ||
        consent.expectedIdentity?.userId !== connection.identity.userId) return null;
    const sourceConfig = {
      mail: ['mail', consent.sources?.mail],
      calendar: ['calendar', consent.sources?.calendar],
      teamsChats: ['chats', consent.sources?.chats],
      teamsChannels: ['channels', consent.sources?.channels],
      transcripts: ['transcripts', consent.sources?.transcripts],
      oneNote: ['oneNotePages', consent.sources?.oneNotePages],
      meetingInsights: ['meetingInsights', consent.sources?.meetingInsights],
      meetingInsightList: ['meetingInsightMeetings', consent.sources?.meetingInsightMeetings],
      files: ['files', consent.sources?.files]
    }[source];
    if (!sourceConfig || !connection.enabled.includes(sourceConfig[0])) return null;
    const selection = sourceConfig[1];
    if (!(selection === true || Array.isArray(selection) && selection.length > 0)) return null;
    return createHash('sha256').update(JSON.stringify({
      consentId: consent.consentId, identity: connection.identity, source, selection
    })).digest('hex');
  };
  const teamsAuthorizationReference = () => sourceAuthorizationReference('teamsChannels');
  const filesAuthorizationReference = () => sourceAuthorizationReference('files');
  const sourceAuthorization = sourceAuthorizationReference;
  const fileContentTransport = () => {
    if (typeof microsoft365Options.fileContentDownloader === 'function') {
      return { available: true, code: null, message: 'A host-provided selected-file downloader is configured; it must preserve the adapter host, DNS, TLS, redirect, size, and credential boundaries.' };
    }
    if (process.platform === 'win32') {
      return { available: false, code: 'network_policy_unavailable', message: 'The default pinned HTTPS downloader is disabled on Windows because this host cannot establish that configured proxy and network policy are preserved; no fallback will be attempted.' };
    }
    if (microsoft365Options.allowDirectFileEgress !== true) {
      return { available: false, code: 'network_policy_unavailable', message: 'Owner-approved direct HTTPS egress is not enabled for selected-file reads.' };
    }
    if (environmentProxyConfigured()) {
      return { available: false, code: 'network_policy_unavailable', message: 'A proxy or TLS override is configured and cannot be proven to preserve the pinned destination and TLS boundary; no fallback will be attempted.' };
    }
    return { available: true, code: null, message: 'The pinned selected-file transport is configured; each content read still requires explicit approval.' };
  };
  const fileContentCapability = () => {
    const connection = microsoft365.status();
    const transport = fileContentTransport();
    const reasons = [];
    if (typeof microsoft365Options.tokenProvider !== 'function') reasons.push('token_provider_unavailable');
    else if (connection.state !== 'connected') reasons.push(connection.reason || 'disconnected');
    if (!filesAuthorizationReference()) reasons.push('file_source_not_authorized');
    if (!transport.available) reasons.push(transport.code);
    const readyForApprovedRead = reasons.length === 0;
    const messages = [];
    if (reasons.includes('token_provider_unavailable')) messages.push('Trusted delegated sign-in is unavailable.');
    else if (connection.state !== 'connected') messages.push('An explicit current-owner connection is required.');
    if (reasons.includes('file_source_not_authorized')) messages.push('No current owner-approved file selection is available.');
    if (!transport.available) messages.push(transport.message);
    if (readyForApprovedRead) messages.push('Ready for one explicit, bounded text/plain read; this is not a successful sync.');
    return {
      status: readyForApprovedRead ? 'ready-for-explicit-read' : 'unavailable',
      readyForApprovedRead, reasons: [...new Set(reasons)], message: messages.join(' ')
    };
  };
  const parseStoredSourceReference = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `A stored ${label} source reference is required.`);
    assertOnlyKeys(value, new Set(['jobId', 'resultId', 'itemId']), 'Only stored job, source-result and source-item keys are accepted.');
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    if (typeof value.jobId !== 'string' || !uuid.test(value.jobId) ||
        typeof value.resultId !== 'string' || !uuid.test(value.resultId) ||
        typeof value.itemId !== 'string' || !/^[0-9a-f]{64}$/.test(value.itemId)) {
      throw new HttpError(400, `The ${label} source reference must contain UUID job/result IDs and an exact source item key.`);
    }
    return { jobId: value.jobId, resultId: value.resultId, itemId: value.itemId };
  };
  const parseTeamsReplyReference = value => parseStoredSourceReference(value, 'Teams');
  const parseFileContentReference = value => parseStoredSourceReference(value, 'selected file');
  const resolveTeamsReplyEvidence = value => {
    const reference = parseTeamsReplyReference(value);
    const connection = microsoft365.status();
    const consent = store.state.sourceConsent;
    const authorizationReference = teamsAuthorizationReference();
    if (!authorizationReference || !connection.identity || typeof sourceConnectors.teamsChannels?.readReplies !== 'function') return null;
    const ownerReference = JSON.stringify(connection.identity);
    const job = store.state.jobs.find(item => item.id === reference.jobId && item.kind === 'source_refresh' &&
      ['partial', 'completed'].includes(item.status));
    const source = job?.result?.sources?.find(item => item.source === 'teamsChannels' && item.resultId === reference.resultId);
    const currentCheck = sourceHealth.get('teamsChannels');
    const item = source?.items?.find(evidence => evidence.sourceKey === reference.itemId && evidence.id);
    const binding = source?.replyBindings?.find(evidence => evidence.sourceKey === reference.itemId);
    if (!source || !item || !binding || binding.messageId !== item.id ||
        source.status !== 'partial' || source.ownerReference !== ownerReference ||
        source.authorizationReference !== authorizationReference ||
        currentCheck?.jobId !== reference.jobId || currentCheck?.resultId !== reference.resultId ||
        currentCheck?.status !== 'partial' || currentCheck?.ownerReference !== ownerReference ||
        currentCheck?.authorizationReference !== authorizationReference ||
        !consent.sources.channels.some(channel => channel.teamId === binding.teamId && channel.channelId === binding.channelId)) return null;
    return {
      sourceReference: reference, teamId: binding.teamId, channelId: binding.channelId,
      messageId: binding.messageId, parent: item, ownerReference, authorizationReference
    };
  };
  const resolveFileContentEvidence = value => {
    const reference = parseFileContentReference(value);
    const connection = microsoft365.status();
    const consent = store.state.sourceConsent;
    const authorizationReference = filesAuthorizationReference();
    if (!authorizationReference || !connection.identity || typeof sourceConnectors.files?.readContent !== 'function') return null;
    const ownerReference = JSON.stringify(connection.identity);
    const job = store.state.jobs.find(item => item.id === reference.jobId && item.kind === 'source_refresh' &&
      ['partial', 'completed'].includes(item.status));
    const source = job?.result?.sources?.find(item => item.source === 'files' && item.resultId === reference.resultId);
    const currentCheck = sourceHealth.get('files');
    const item = source?.items?.find(evidence => evidence.sourceKey === reference.itemId && evidence.id);
    const binding = source?.fileBindings?.find(evidence => evidence.sourceKey === reference.itemId);
    const selection = binding && consent?.sources?.files?.find(file =>
      file.driveId === binding.driveId && file.itemId === binding.itemId
    );
    if (!source || !item || !binding || binding.itemId !== item.id || !selection ||
        source.status !== 'partial' || source.ownerReference !== ownerReference ||
        source.authorizationReference !== authorizationReference ||
        currentCheck?.jobId !== reference.jobId || currentCheck?.resultId !== reference.resultId ||
        currentCheck?.status !== 'partial' || currentCheck?.ownerReference !== ownerReference ||
        currentCheck?.authorizationReference !== authorizationReference) return null;
    if (typeof item.eTag !== 'string' || !item.eTag ||
        !Number.isSafeInteger(item.size) || item.size < 0) return null;
    let approvedHost = '';
    if (selection.approvedHost) {
      try { approvedHost = normalizeApprovedHost(selection.approvedHost); }
      catch { return null; }
    }
    return {
      sourceReference: reference, driveId: binding.driveId, itemId: binding.itemId,
      mimeType: item.mimeType || '', eTag: item.eTag, size: item.size,
      approvedHost, ownerReference, authorizationReference
    };
  };
  const verifyOutput = async () => {
    assertPrivateDataDirectory(root);
    await assertPrivateStorage(root);
    await assertOutputAllowed({ root, approved: store.state.preferences.localOutputApproved, redirected: outputRedirected, verifyVolume: verifyLocalVolume });
    assertOutput();
  };
  worker = createWorker({
    store, root, connectors: sourceConnectors, assistant, sourceIdentity, clock, intervalMs: workerIntervalMs, verifyOutput, assertOutput,
    sourceAuthorization, authorizeTeamsReply: resolveTeamsReplyEvidence,
    authorizeFileContent: resolveFileContentEvidence, fileContentAvailability: fileContentCapability,
    sourceEpoch: () => connectionEpoch, insightListConnector: microsoft365.connectors.meetingInsightList,
    onSourceResult: result => {
      sourceHealth.set(result.source, result);
    }
  });

  server.removeAllListeners('request');
  server.on('request', async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");

    try {
      const state = store.state;
      const parsed = new URL(request.url, 'http://127.0.0.1');
      const pathname = parsed.pathname;
      if (['access', 'token', 'capability'].some(key => parsed.searchParams.has(key))) {
        throw new HttpError(400, 'Credentials in HTTP query strings are not accepted.');
      }
      const host = new URL(`http://${request.headers.host || ''}`);
      if (!isLoopbackAddress(request.socket.remoteAddress) ||
          !['127.0.0.1', 'localhost'].includes(host.hostname) ||
          Number(host.port || 80) !== server.address()?.port ||
          (request.headers['sec-fetch-site'] === 'cross-site' &&
            !(request.method === 'GET' && pathname === '/' && request.headers['sec-fetch-mode'] === 'navigate'))) {
        throw new HttpError(403, 'Only the current loopback workspace host is accepted.');
      }

      if (PUBLIC_FILES.has(pathname) && request.method === 'GET') {
        const [fileName, contentType] = PUBLIC_FILES.get(pathname);
        const content = await readFile(join(PUBLIC_DIR, fileName));
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        response.end(content);
        return;
      }

      if (!pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');

      if (request.method === 'GET' && pathname === '/api/health') {
        jsonResponse(response, 200, {
          product: 'esquie-local-workspace', version: '0.2.0', status: 'ok', mode: 'local-only',
          authenticatedApi: true
        });
        return;
      }
      if (!validToken(request.headers['x-esquie-access'], accessToken)) {
        throw new HttpError(401, 'Owner launch authorization is required. Reopen the private launch file or desktop application.');
      }
      if (request.method === 'GET' && pathname === '/api/state') {
        const safeState = { ...state, jobs: publicJobs(state.jobs) };
        if (safeState.sourceConsent) {
          safeState.sourceConsent = { ...safeState.sourceConsent };
          delete safeState.sourceConsent.consentId;
        }
        jsonResponse(response, 200, { ...safeState, timezoneStatus: timezoneStatus(state.preferences, state.profile.timezone, state.jobs), csrfToken, mode: 'local-only' });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/jobs') {
        jsonResponse(response, 200, { jobs: publicJobs(state.jobs) });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/output-settings') {
        jsonResponse(response, 200, { directory: root, approved: Boolean(state.preferences.localOutputApproved), note: 'Known cloud roots are blocked; unknown sync agents cannot be detected universally. Explicit owner confirmation and a fixed-volume check are required.' });
        return;
      }
      const conversationMatch = /^\/api\/tasks\/([0-9a-f-]{36})\/conversation$/.exec(pathname);
      if (request.method === 'GET' && conversationMatch) {
        const task = taskById(state, conversationMatch[1]);
        jsonResponse(response, 200, { messages: state.conversations.filter(message => message.taskId === conversationMatch[1]), history: task.history || [], createdAt: task.createdAt || null });
        return;
      }
      const documentMatch = /^\/api\/documents\/([0-9a-f-]{36})$/.exec(pathname);
      if (request.method === 'GET' && documentMatch) {
        if (!state.documents.some(item => item.id === documentMatch[1])) throw new HttpError(404, 'Document not found.');
        const unavailable = state.documents.find(item => item.id === documentMatch[1]).fileUnavailableReason;
        if (unavailable) throw new HttpError(410, unavailable);
        const path = join(root, 'documents', `${documentMatch[1]}.md`);
        try { await assertPlainLocalFile(path); }
        catch { throw new HttpError(403, 'Document is missing or redirected; reading was blocked.'); }
        const text = await readFile(path, 'utf8');
        jsonResponse(response, 200, { text, storage: 'local-only' });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/connections') {
        const connection = microsoft365.status();
        const status = (source, enabledKeys = [source]) => {
          if (connectors[source]) return { status: 'configured-unverified', available: false, access: 'read-only' };
          const names = { chats: 'teamsChats', channels: 'teamsChannels', oneNotePages: 'oneNote', meetingInsightMeetings: 'meetingInsightList' };
          const selected = enabledKeys.filter(key => connection.enabled.includes(key)).map(key => names[key] || key);
          const listedMeetings = store.state.sourceConsent?.sources?.meetingInsightMeetings?.length || 0;
          const lastReads = selected.map(key => sourceHealth.get(key)).filter(Boolean)
            .map(({ source, status, inspected, coverage, at }) => ({
              source, status, inspected, coverage: source === 'meetingInsightList' && status === 'partial' && listedMeetings > 1
                ? { ...coverage, limitations: [...(coverage?.limitations || []), `Only one of ${listedMeetings} selected meetings was listed; other selections remain access-unverified.`] }
                : coverage, at
            }));
          const checked = selected.filter(key => {
            const health = sourceHealth.get(key);
            const authorization = sourceAuthorization(key);
            return Boolean(authorization) && health?.status === 'partial' && health.coverage?.successfulRequests > 0 &&
              health.ownerReference === JSON.stringify(connection.identity) &&
              health.authorizationReference === authorization;
          });
          const verified = checked.filter(key => {
            const coverage = sourceHealth.get(key).coverage;
            return Array.isArray(coverage.gaps) && coverage.gaps.length === 0 &&
              (key !== 'meetingInsightList' || listedMeetings === 1);
          }).length;
          return {
            status: connection.state !== 'connected' ? connection.state : !selected.length ? 'not-authorized'
              : verified === selected.length ? 'bounded-read-verified' : checked.length ? 'partial-access' : 'access-unverified',
            available: connection.state === 'connected' && selected.length > 0 && verified === selected.length,
            ownerVerified: connection.verifiedOwner, access: 'read-only', lastReads
          };
        };
        jsonResponse(response, 200, {
          assistant: { status: assistant.status().state, code: assistant.status().code, available: false },
          email: { ...status('mail'), sendEnabled: false, access: 'draft-only' },
          calendar: status('calendar'),
          teams: status('teams', ['chats', 'channels', 'transcripts', 'meetingInsights', 'meetingInsightMeetings']),
          oneNote: status('oneNote', ['oneNotePages']),
          reporting: { status: 'disconnected', available: false, access: 'read-only' },
          sharepoint: status('files'),
          microsoft365: { ...connection, hostAuthenticationAvailable: typeof microsoft365Options.tokenProvider === 'function' },
          fileContent: fileContentCapability(),
          planner: { status: 'retired', available: false }
        });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/teams') {
        const connection = microsoft365.status();
        jsonResponse(response, 200, { available: false, access: 'read-only', items: [], connection: connection.state, message: 'This status endpoint does not read Teams. Explicit bounded source results appear in Activity; no complete synchronization is claimed.' });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/reports') {
        jsonResponse(response, 200, { available: false, access: 'read-only', reports: [], message: 'Reporting is disconnected; no business data has been queried.' });
        return;
      }

      if (pathname === '/api/teams' || pathname === '/api/reports') {
        jsonResponse(response, 405, { error: 'This surface is read-only.' }, { Allow: 'GET' });
        return;
      }

      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) {
        if (!validOrigin(request) || !validToken(request.headers['x-esquie-csrf'], csrfToken)) {
          throw new HttpError(403, 'Local origin and workspace CSRF token are required.');
        }
      }

      if (request.method === 'POST' && pathname === '/api/microsoft365/connect') {
        const decision = ++connectionDecision;
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['consent', 'expectedIdentity', 'sources', 'allowReplyDrafts']), 'Only explicit owner identity, source selections, and consent are accepted; never provide tokens.');
        const consent = sourceConsent(body);
        checkConnectionDecision(decision);
        sourceHealth.clear();
        connectionEpoch = null;
        const controller = new AbortController();
        pendingConnections.add(controller);
        try {
          const connection = await microsoft365.connect({ ...consent, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
          checkConnectionDecision(decision);
          try {
            updateState(next => { next.sourceConsent = { consentId: randomUUID(), expectedIdentity: connection.identity, sources: consent.sources, allowReplyDrafts: consent.allowReplyDrafts }; });
          } catch {
            microsoft365.disconnect();
            sourceHealth.clear();
            jsonResponse(response, 503, { error: 'Microsoft 365 is unavailable (consent_persistence_failed). The connection was disconnected; no successful connection or synchronization is claimed.', connection: microsoft365.status() });
            return;
          }
          appliedConnectionDecision = decision;
          connectionEpoch = randomUUID();
          jsonResponse(response, 200, { connection, message: 'Owner verified for selected operations, not synchronized. Run an explicit bounded source check.' });
        } catch (error) {
          if (error instanceof HttpError) throw error;
          const code = error instanceof ConnectorError ? error.code : 'connection_failed';
          jsonResponse(response, 503, { error: `Microsoft 365 is unavailable (${code}). No successful connection or synchronization is claimed.`, connection: microsoft365.status() });
        } finally {
          pendingConnections.delete(controller);
        }
        return;
      }
      if (request.method === 'POST' && pathname === '/api/microsoft365/disconnect') {
        const decision = ++connectionDecision;
        assertOnlyKeys(await readJson(request), new Set(), 'No disconnect parameters are accepted.');
        checkConnectionDecision(decision);
        disconnectMicrosoft365();
        sourceHealth.clear();
        appliedConnectionDecision = decision;
        jsonResponse(response, 200, { connection: microsoft365.status(), message: 'Disconnected. Stored local evidence remains historical context, not instructions.' });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/mail/reply-drafts') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['messageId', 'text', 'replyAll', 'requestId', 'sourceReference']), 'Only an exact message ID, reply text, replyAll flag, UUID request ID, and optional source-result reference are accepted.');
        const messageId = safeText(body.messageId, 'Message ID', 2000, { required: true });
        const text = safeText(body.text, 'Reply text', 12000, { required: true });
        if (typeof body.replyAll !== 'boolean') throw new HttpError(400, 'Choose reply or reply-all explicitly.');
        if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.requestId)) throw new HttpError(400, 'A UUID request ID is required.');
        const connector = microsoft365.connectors.mail;
        const connection = microsoft365.status();
        if (connection.state !== 'connected' || !connection.verifiedOwner || !connection.identity) throw new HttpError(503, 'Outlook is disconnected. No draft was created.');
        const ownerReference = JSON.stringify(connection.identity);
        let sourceReference;
        if (Object.hasOwn(body, 'sourceReference')) {
          const reference = body.sourceReference;
          if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw new HttpError(400, 'A bounded source-result reference is required for a preview-driven reply.');
          assertOnlyKeys(reference, new Set(['jobId', 'resultId', 'itemId']), 'Only jobId, resultId and itemId are accepted in a source-result reference.');
          const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
          if (typeof reference.jobId !== 'string' || !uuid.test(reference.jobId) ||
              typeof reference.resultId !== 'string' || !uuid.test(reference.resultId) ||
              typeof reference.itemId !== 'string' || !/^[0-9a-f]{64}$/.test(reference.itemId)) {
            throw new HttpError(400, 'The source-result reference must contain UUID job/result IDs and an exact source item key.');
          }
          const job = store.state.jobs.find(item => item.id === reference.jobId && item.kind === 'source_refresh');
          const source = job?.result?.sources?.find(item => item.source === 'mail' && item.resultId === reference.resultId);
          const item = source?.items?.find(evidence => evidence.sourceKey === reference.itemId && evidence.id === messageId);
          if (!item || source.ownerReference !== ownerReference) {
            throw new HttpError(403, 'The selected mail evidence is missing, changed, or belongs to another owner. Explicitly check and select the source again; no draft was attempted.');
          }
          sourceReference = { jobId: reference.jobId, resultId: reference.resultId, itemId: reference.itemId };
        }
        const fingerprint = createHash('sha256').update(JSON.stringify({ messageId, text, replyAll: body.replyAll, ...(sourceReference ? { sourceReference } : {}) })).digest('hex');
        const previous = store.state.draftOperations.find(item => item.requestId === body.requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint || previous.ownerReference !== ownerReference) throw new HttpError(409, 'This request ID belongs to different work.');
          if (previous.status === 'completed') {
            jsonResponse(response, 200, { draft: previous.draft, deduplicated: true, message: 'The prior verified draft is retained. No second draft was created.' });
            return;
          }
          throw new HttpError(409, 'This draft operation is pending, failed, or uncertain. Inspect Outlook; it was not retried.');
        }
        if (sourceReference) {
          const source = store.state.jobs.find(item => item.id === sourceReference.jobId)?.result?.sources
            ?.find(item => item.source === 'mail' && item.resultId === sourceReference.resultId);
          if (source?.authorizationReference !== sourceAuthorization('mail')) {
            throw new HttpError(403, 'The selected mail evidence is not authorized by the current source selection. Explicitly check and select the source again; no draft was attempted.');
          }
        }
        if (store.state.draftOperations.some(item => item.ownerReference === ownerReference && item.messageId === messageId && ['creating', 'unknown', 'completed'].includes(item.status))) {
          throw new HttpError(409, 'A draft for this source already exists or may exist. Inspect Outlook; no second draft was created.');
        }
        updateState(next => next.draftOperations.push({ requestId: body.requestId, messageId, ownerReference, fingerprint, ...(sourceReference ? { sourceReference } : {}), status: 'creating', createdAt: clock().toISOString() }));
        try {
          const draft = await connector.createReplyDraft({ messageId, text, replyAll: body.replyAll, signal: AbortSignal.timeout(30_000) });
          if (draft.isDraft !== true || draft.verifiedOwner !== true) throw new Error('Draft verification is missing.');
          updateState(next => Object.assign(next.draftOperations.find(item => item.requestId === body.requestId), { status: 'completed', draft }));
          jsonResponse(response, 201, { draft, message: 'A verified unsent reply draft was created. Review and send manually in Outlook.' });
        } catch (error) {
          const uncertain = error instanceof ConnectorError ? error.outcomeUnknown : true;
          updateState(next => { next.draftOperations.find(item => item.requestId === body.requestId).status = uncertain ? 'unknown' : 'failed'; });
          jsonResponse(response, 502, {
            error: 'The Outlook draft result could not be verified. Inspect Outlook before any retry; no automatic retry or send was attempted.',
            uncertain
          });
        }
        return;
      }

      if (request.method === 'POST' && pathname === '/api/teams/channel-replies') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['sourceReference']), 'Only a stored Teams source reference is accepted.');
        const reference = parseTeamsReplyReference(body.sourceReference);
        const evidence = resolveTeamsReplyEvidence(reference);
        if (!evidence) throw new HttpError(409, 'The selected Teams evidence, current owner, or consent is missing or stale. Run a fresh bounded source check and select the parent again; no Teams request was made.');
        const previous = store.state.jobs.find(job =>
          job.kind === 'teams_channel_replies' &&
          JSON.stringify(job.payload?.sourceReference) === JSON.stringify(reference)
        );
        if (previous) {
          if (['queued', 'running'].includes(previous.status)) {
            jsonResponse(response, 202, { job: publicJobs([previous])[0], deduplicated: true, message: 'The exact selected reply read is already queued or running.' });
            return;
          }
          if (previous.status === 'partial') {
            jsonResponse(response, 200, { job: publicJobs([previous])[0], deduplicated: true, message: 'The exact selected reply result is retained; no additional Teams request was made.' });
            return;
          }
          throw new HttpError(409, 'This selected reply read already failed or was interrupted. Inspect its result and explicitly retry it if the source remains current.');
        }
        const job = updateState(next => enqueue(next, {
          kind: 'teams_channel_replies', payload: { sourceReference: reference }, requestId: randomUUID()
        }, clock()));
        jsonResponse(response, 202, { job: publicJobs([job])[0], message: 'Queued a bounded read for the exact selected parent. Pause and quiet hours are respected; no Teams write is available.' });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/files/content-read') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['sourceReference', 'confirmRead']), 'Only a stored file source reference and explicit per-read approval are accepted.');
        if (body.confirmRead !== true) throw new HttpError(400, 'Confirm this one-time selected-file read explicitly.');
        const reference = parseFileContentReference(body.sourceReference);
        const capability = fileContentCapability();
        if (!capability.readyForApprovedRead) {
          throw new HttpError(503, `Selected file content is unavailable (${capability.reasons.join(', ')}). ${capability.message} No file read was attempted.`);
        }
        const evidence = resolveFileContentEvidence(reference);
        if (!evidence) {
          throw new HttpError(409, 'The selected file evidence, current owner, or source consent is missing or stale. Run a fresh bounded source check; no file request was made.');
        }
        if (evidence.mimeType.trim().toLowerCase() !== 'text/plain') {
          throw new HttpError(415, 'Only the selected text/plain format is supported; no file content request was made.');
        }
        if (!evidence.approvedHost) {
          throw new HttpError(409, 'Add a canonical owner-approved hostname to this selected file configuration, then reconnect and recheck; no file request was made.');
        }
        const previous = store.state.jobs.find(job =>
          job.kind === 'file_content_read' &&
          JSON.stringify(job.payload?.sourceReference) === JSON.stringify(reference)
        );
        if (previous) {
          if (['queued', 'running'].includes(previous.status)) {
            jsonResponse(response, 202, { job: publicJobs([previous])[0], deduplicated: true, message: 'The exact selected-file read is already queued or running.' });
            return;
          }
          if (previous.status === 'partial') {
            jsonResponse(response, 200, { job: publicJobs([previous])[0], deduplicated: true, message: 'The exact selected-file result is retained locally; no additional file request was made.' });
            return;
          }
          throw new HttpError(409, 'This selected-file read already failed or was interrupted. Inspect its result and explicitly approve a retry if the source remains current.');
        }
        const job = updateState(next => enqueue(next, {
          kind: 'file_content_read',
          payload: { sourceReference: reference, confirmRead: true },
          requestId: randomUUID()
        }, clock()));
        jsonResponse(response, 202, {
          job: publicJobs([job])[0],
          message: 'One explicitly approved bounded read was queued. The worker rechecks owner, source revision, consent, pause and quiet hours before dispatch.'
        });
        return;
      }

      if (request.method === 'PATCH' && pathname === '/api/preferences') {
        const requestRevision = ++preferenceRequestRevision;
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['paused', 'quietStart', 'quietEnd', 'automaticRefresh', 'dailyBackups']), 'Only supported worker preferences may be updated.');
        for (const key of ['paused', 'automaticRefresh', 'dailyBackups']) {
          if (Object.hasOwn(body, key) && typeof body[key] !== 'boolean') throw new HttpError(400, `${key} must be a boolean.`);
        }
        for (const key of ['quietStart', 'quietEnd']) {
          if (Object.hasOwn(body, key) &&
              (typeof body[key] !== 'string' || (body[key] && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body[key])))) {
            throw new HttpError(400, 'Quiet hours must use HH:MM or be blank.');
          }
        }
        const requestedGroups = [
          ...['paused', 'automaticRefresh', 'dailyBackups'].filter(key => Object.hasOwn(body, key)),
          ...(['quietStart', 'quietEnd'].some(key => Object.hasOwn(body, key)) ? ['quietHours'] : [])
        ];
        const conflictingGroups = requestedGroups.filter(group => requestRevision <= (preferenceRevisions.get(group) || 0));
        const acceptedGroups = requestedGroups.filter(group => !conflictingGroups.includes(group));
        const preferences = acceptedGroups.length ? updateState(next => {
          const previous = { ...next.preferences };
          for (const key of ['paused', 'automaticRefresh', 'dailyBackups']) {
            if (acceptedGroups.includes(key) && Object.hasOwn(body, key)) next.preferences[key] = body[key];
          }
          if (acceptedGroups.includes('quietHours')) {
            for (const key of ['quietStart', 'quietEnd']) if (Object.hasOwn(body, key)) next.preferences[key] = body[key];
          }
          if (acceptedGroups.includes('quietHours') && !quietHoursValid(next.preferences)) {
            throw new HttpError(400, 'Set both quiet-hour times in HH:MM, or clear both.');
          }
          if (!timezoneAvailable(next.profile.timezone) &&
              ((!previous.automaticRefresh && next.preferences.automaticRefresh) ||
               (!previous.dailyBackups && next.preferences.dailyBackups) ||
               (!(previous.quietStart || previous.quietEnd) && (next.preferences.quietStart || next.preferences.quietEnd)))) {
            throw new HttpError(400, 'Set a valid supported IANA timezone before enabling scheduled work or quiet hours.');
          }
          return next.preferences;
        }) : store.state.preferences;
        for (const group of acceptedGroups) preferenceRevisions.set(group, requestRevision);
        const fieldsFor = group => group === 'quietHours' ? ['quietStart', 'quietEnd'] : [group];
        const appliedFields = acceptedGroups.flatMap(fieldsFor);
        const conflictingFields = conflictingGroups.flatMap(fieldsFor);
        if (conflictingGroups.length) {
          const stopReason = preferences.paused ? 'paused'
            : quietHoursActive(preferences, store.state.profile.timezone, clock()) ? 'quiet_hours' : null;
          if (stopReason) worker.cancelCurrent(stopReason);
          jsonResponse(response, 409, {
            error: 'Some preference fields were not applied because a newer successful update already changed them.',
            appliedFields, conflictingFields, preferences
          });
          return;
        }
        const stopReason = preferences.paused ? 'paused'
          : quietHoursActive(preferences, store.state.profile.timezone, clock()) ? 'quiet_hours' : null;
        if (stopReason) worker.cancelCurrent(stopReason);
        jsonResponse(response, 200, { preferences });
        return;
      }

      const recoveryMatch = /^\/api\/backups\/([0-9a-f-]{36})\/recover$/.exec(pathname);
      if (request.method === 'POST' && recoveryMatch) {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['confirmSeparateWorkspace']), 'Recovery accepts only explicit separate-workspace confirmation.');
        if (body.confirmSeparateWorkspace !== true) throw new HttpError(400, 'Confirm recovery into a separate paused workspace.');
        const backup = state.backups.find(item => item.id === recoveryMatch[1]);
        if (!backup) throw new HttpError(404, 'Saved backup not found.');
        if (backup.fileUnavailableReason) throw new HttpError(410, backup.fileUnavailableReason);
        let recovery;
        try { recovery = await recoverLocalBackup({ root, backup, now: clock(), verifyOutput, assertOutput }); }
        catch { throw new HttpError(409, 'Private recovery was blocked or failed integrity/storage checks. Original workspace, backups and any pre-existing files were not overwritten. Check output approval and private storage.'); }
        updateState(next => next.recoveries.unshift(recovery));
        jsonResponse(response, 201, { recovery });
        return;
      }

      if (request.method === 'PATCH' && pathname === '/api/onboarding') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['action', 'revision', 'step', 'data', 'confirmReview']), 'Unsupported setup fields; setup never accepts credentials or authorization.');
        if (!['save', 'skip', 'resume', 'back', 'go', 'complete'].includes(body.action)) throw new HttpError(400, 'Choose a supported setup action.');
        const onboarding = updateState(next => {
          const progress = next.onboarding;
          if (!Number.isInteger(body.revision) || body.revision !== progress.revision) throw new HttpError(409, 'Setup changed. Refresh to resume without overwriting progress.');
          if (Object.hasOwn(body, 'data') && body.action !== 'save') throw new HttpError(400, 'Only saving a setup step accepts local data.');
          if (body.action === 'save') {
            const data = body.data;
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Setup data must be an object.');
            const fields = [['displayName', 'email', 'role', 'timezone'], ['manager', 'people'], ['record'], ['workspaceName'], ['writingStyle'], ['record'], ['configuration'], []][progress.step];
            assertOnlyKeys(data, new Set(fields), 'Only fields belonging to the current setup step are accepted.');
            if ([0, 1, 3, 4].includes(progress.step) && Object.keys(data).length) updateProfile(next, data);
            if ([2, 5].includes(progress.step) && data.record) saveLocalRecord(next, data.record, clock().toISOString(), progress.step === 2 ? 'account' : 'outcome');
            if (progress.step === 6 && Object.hasOwn(data, 'configuration')) {
              if (data.configuration === null) next.sourceConfigurationDraft = null;
              else {
                if (!data.configuration || typeof data.configuration !== 'object' || Array.isArray(data.configuration)) throw new HttpError(400, 'Source configuration must contain only nonsecret expected IDs and selections.');
                assertOnlyKeys(data.configuration, new Set(['expectedIdentity', 'sources']), 'Setup cannot authorize sources, accept tokens, or enable reply drafts.');
                const draft = sourceConsent({ ...data.configuration, allowReplyDrafts: false, consent: false });
                next.sourceConfigurationDraft = { expectedIdentity: draft.expectedIdentity, sources: draft.sources };
              }
            }
            progress.step = Math.min(progress.step + 1, 7);
            progress.status = 'in-progress';
          } else if (body.action === 'complete') {
            if (progress.step !== 7 || body.confirmReview !== true) throw new HttpError(400, 'Review setup and explicitly confirm; no source is authorized by finishing setup.');
            progress.status = 'complete';
          } else if (body.action === 'skip') progress.status = 'skipped';
          else {
            if (body.action === 'go') {
              if (!Number.isInteger(body.step) || body.step < 0 || body.step > 7) throw new HttpError(400, 'Choose a supported setup step.');
              progress.step = body.step;
            } else if (body.action === 'back') progress.step = Math.max(0, progress.step - 1);
            else if (progress.status === 'complete') progress.step = 0;
            progress.status = 'in-progress';
          }
          progress.revision++;
          progress.updatedAt = clock().toISOString();
          return progress;
        });
        jsonResponse(response, 200, { onboarding, authorized: false });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/output-approval') {
        const sequence = ++outputApprovalSequence;
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['confirmPrivateNonSynced']), 'Only explicit local output confirmation is supported.');
        if (typeof body.confirmPrivateNonSynced !== 'boolean') throw new HttpError(400, 'Confirm the local destination explicitly.');
        if (sequence < latestOutputApproval) throw new HttpError(409, 'A newer output approval decision superseded this request.');
        if (body.confirmPrivateNonSynced) {
          assertPrivateDataDirectory(root);
          await assertPrivateStorage(root);
          try { await assertOutputAllowed({ root, approved: true, redirected: outputRedirected, verifyVolume: verifyLocalVolume }); }
          catch (error) { throw new HttpError(403, error.message); }
        }
        if (sequence < latestOutputApproval) throw new HttpError(409, 'A newer output approval decision superseded this request.');
        updateState(next => { next.preferences.localOutputApproved = body.confirmPrivateNonSynced; });
        latestOutputApproval = sequence;
        jsonResponse(response, 200, { approved: body.confirmPrivateNonSynced });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/demo-approval') {
        const sequence = ++demoApprovalSequence;
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['confirmSyntheticLocalOnly']), 'Only approval of fixed local synthetic demos is supported.');
        if (typeof body.confirmSyntheticLocalOnly !== 'boolean') throw new HttpError(400, 'Approve or revoke the local demo configuration explicitly.');
        if (sequence < latestDemoApproval) throw new HttpError(409, 'A newer demo approval decision superseded this request.');
        updateState(next => { next.preferences.demoApproved = body.confirmSyntheticLocalOnly; });
        latestDemoApproval = sequence;
        jsonResponse(response, 200, { approved: body.confirmSyntheticLocalOnly, mode: 'fixed-synthetic-local-document-only' });
        return;
      }

      if (request.method === 'POST' && conversationMatch) {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['text']), 'Only a local note is accepted.');
        const text = safeText(body.text, 'Note', 4000, { required: true });
        const message = updateState(next => {
          const task = taskById(next, conversationMatch[1]);
          const item = { id: randomUUID(), taskId: conversationMatch[1], text, role: 'owner', kind: 'note', createdAt: clock().toISOString() };
          next.conversations.push(item);
          taskEvent(task, 'note-added', item.createdAt, { noteId: item.id });
          return item;
        });
        jsonResponse(response, 201, { message });
        return;
      }

      const evidenceMatch = /^\/api\/tasks\/([0-9a-f-]{36})\/evidence$/.exec(pathname);
      if (request.method === 'POST' && evidenceMatch) {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['title', 'url', 'note']), 'Evidence accepts only title, URL, and note.');
        const title = safeText(body.title, 'Evidence title', 160, { required: true });
        const url = safeLinkUrl(body.url);
        const note = safeText(body.note ?? '', 'Evidence note', 3000);
        const evidence = updateState(next => {
          const task = taskById(next, evidenceMatch[1]);
          task.evidence ||= [];
          const existing = task.evidence.find(item => item.url === url);
          if (existing) return existing;
          const item = { id: randomUUID(), title, url, note, provenance: 'owner-provided-unverified', createdAt: clock().toISOString() };
          task.evidence.push(item);
          taskEvent(task, 'evidence-added', item.createdAt, { evidenceId: item.id });
          return item;
        });
        jsonResponse(response, 201, { evidence });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/jobs') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['kind', 'taskId', 'notes', 'requestId', 'confirmFakeOnly', 'meetingId', 'listConsent']), 'Unsupported job fields.');
        if (!['task_summary', 'meeting_notes', 'source_refresh', 'meeting_insight_list', 'document', 'fake_demo', 'backup'].includes(body.kind)) throw new HttpError(400, 'Unsupported job kind.');
        if (body.kind === 'backup' && body.taskId != null) throw new HttpError(400, 'Workspace backups do not accept task inputs.');
        if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.requestId)) throw new HttpError(400, 'A UUID request ID is required.');
        if (body.taskId != null) taskById(state, body.taskId);
        if (body.kind !== 'meeting_notes' && Object.hasOwn(body, 'notes')) throw new HttpError(400, 'Only meeting-note jobs accept notes.');
        if (body.kind === 'fake_demo' && (!store.state.preferences.demoApproved || body.confirmFakeOnly !== true || body.taskId)) {
          throw new HttpError(403, 'Demo creation needs approved local synthetic-only configuration and explicit confirmation for this run; task/customer inputs are not accepted.');
        }
        if (body.kind !== 'fake_demo' && Object.hasOwn(body, 'confirmFakeOnly')) throw new HttpError(400, 'Fake-only confirmation applies only to demo jobs.');
        if (body.kind !== 'meeting_insight_list' && (Object.hasOwn(body, 'meetingId') || Object.hasOwn(body, 'listConsent'))) throw new HttpError(400, 'Meeting selection and list consent apply only to meeting insight listing.');
        let listPayload;
        if (body.kind === 'meeting_insight_list') {
          if (body.taskId != null || body.listConsent !== true) throw new HttpError(400, 'Explicit consent for one meeting insight list is required; task inputs are not accepted.');
          const meetingId = safeText(body.meetingId, 'Meeting ID', 2000, { required: true });
          const connection = microsoft365.status();
          if (!connectionEpoch || connection.state !== 'connected' || !connection.verifiedOwner ||
              !store.state.sourceConsent?.sources?.meetingInsightMeetings?.includes(meetingId)) {
            throw new HttpError(403, 'The meeting is not authorized for listing in the current connection.');
          }
          listPayload = { meetingId, connectionEpoch, ownerReference: JSON.stringify(connection.identity) };
        }
        const payload = body.kind === 'meeting_notes' ? { notes: safeText(body.notes, 'Meeting notes', 8000, { required: true }) }
          : body.kind === 'fake_demo' ? { confirmFakeOnly: true }
            : body.kind === 'meeting_insight_list' ? listPayload : {};
        const existingJob = store.state.jobs.find(item => item.requestId === body.requestId);
        let job;
        try {
          job = updateState(next => enqueue(next, { kind: body.kind, payload, requestId: body.requestId, taskId: body.taskId || null }, clock()));
        } catch (error) {
          if (error.message.includes('request ID')) throw new HttpError(409, error.message);
          throw error;
        }
        const pending = ['queued', 'running'].includes(job.status);
        const message = existingJob
          ? `This request ID already exists; its ${job.status} job was retained and was not queued again.`
          : 'Queued locally; no result is claimed until the worker finishes.';
        jsonResponse(response, pending ? 202 : 200, { job: publicJobs([job])[0], deduplicated: Boolean(existingJob), message });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/records') {
        const body = await readJson(request, body => body?.category === 'account' ? MAX_ACCOUNT_BODY_BYTES : MAX_BODY_BYTES);
        assertOnlyKeys(body, new Set(['category', 'title', 'note', 'date', 'plan', 'stakeholders']), 'Only owner-entered local record fields are supported.');
        if (!['account', 'outcome', 'engagement'].includes(body.category)) throw new HttpError(400, 'Choose a supported local record category.');
        const record = updateState(next => {
          const item = saveLocalRecord(next, body, clock().toISOString(), body.category);
          recordActivity(next, 'local-record', `Recorded local ${body.category}: ${item.title}`, item.createdAt);
          return item;
        });
        jsonResponse(response, 201, { record });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/outcomes/import/preview') {
        const body = await readJson(request, MAX_OUTCOMES_IMPORT_BODY_BYTES);
        assertOnlyKeys(body, new Set(['text', 'sourceMethod']), 'Only pasted or owner-stated OCR workshop text is accepted.');
        const preview = outcomesImportCall(() =>
          previewMonthlyOutcomeImport(state.records, body.text, {
            today: ownerLocalDate(clock(), state.profile.timezone),
            ...(body.sourceMethod === undefined ? {} : { sourceMethod: body.sourceMethod })
          }));
        jsonResponse(response, 200, preview);
        return;
      }

      if (request.method === 'POST' && pathname === '/api/outcomes/import/ocr') {
        const requestAbort = new AbortController();
        const abortRequest = () => requestAbort.abort();
        const abortOnDisconnect = () => { if (!response.writableEnded) requestAbort.abort(); };
        request.once('aborted', abortRequest);
        response.once('close', abortOnDisconnect);
        let image;
        let slot;
        try {
          const body = await readJson(request, MAX_OUTCOMES_OCR_BODY_BYTES);
          assertOnlyKeys(body, new Set(['mimeType', 'imageBase64']), 'Only one selected screenshot is accepted.');
          slot = reserveOcrIfConnected(outcomesOcr, request, response, requestAbort.signal);
          if (!slot) return;
          image = decodeWindowsOcrImage(body.mimeType, body.imageBase64);
          body.imageBase64 = '';
          const text = await slot.run(image, { signal: requestAbort.signal });
          jsonResponse(response, 200, { text, mode: 'on-device-windows-ocr', imported: false });
        } catch (error) {
          if (error instanceof WindowsOcrError) throw new HttpError(error.status, error.message);
          throw error;
        } finally {
          request.removeListener('aborted', abortRequest);
          response.removeListener('close', abortOnDisconnect);
          await slot?.release();
          image?.fill(0);
        }
        return;
      }

      if (request.method === 'POST' && pathname === '/api/outcomes/import/confirm') {
        const body = await readJson(request, MAX_OUTCOMES_IMPORT_BODY_BYTES);
        assertOnlyKeys(body, new Set(['text', 'revision', 'textHash', 'sourceMethod', 'sourceMethodHash', 'reviewed']), 'Only the reviewed workshop preview is accepted.');
        const result = updateState(next => {
          const now = clock();
          const imported = outcomesImportCall(() => confirmMonthlyOutcomeImport(
            next, body.text, body.revision, body.textHash, body.reviewed, now.toISOString(),
            {
              today: ownerLocalDate(now, next.profile.timezone),
              ...(body.sourceMethod === undefined ? {} : { sourceMethod: body.sourceMethod }),
              ...(body.sourceMethodHash === undefined ? {} : { sourceMethodHash: body.sourceMethodHash })
            }
          ));
          if (imported.imported) recordActivity(next, 'local-outcomes-import', `Imported ${imported.imported} owner-reviewed workshop outcomes locally.`, now.toISOString());
          return imported;
        });
        jsonResponse(response, 200, result);
        return;
      }

      const recordMatch = /^\/api\/records\/([0-9a-f-]{36})$/.exec(pathname);
      if (request.method === 'PATCH' && recordMatch) {
        const body = await readJson(request, body => body?.category === 'account' ? MAX_ACCOUNT_BODY_BYTES : MAX_BODY_BYTES);
        assertOnlyKeys(body, new Set(['category', 'title', 'note', 'date', 'plan', 'stakeholders', 'revision']), 'Only editable local record fields are accepted.');
        const record = updateState(next => {
          const previous = next.records.find(item => item.id === recordMatch[1]);
          if (!previous) throw new HttpError(404, 'Local record not found.');
          return saveLocalRecord(next, { ...body, id: previous.id }, clock().toISOString(), previous.category);
        });
        jsonResponse(response, 200, { record });
        return;
      }

      const accountNoteMatch = /^\/api\/records\/([0-9a-f-]{36})\/notes$/.exec(pathname);
      if (request.method === 'POST' && accountNoteMatch) {
        const body = await readJson(request, MAX_ACCOUNT_BODY_BYTES);
        assertOnlyKeys(body, new Set(['text', 'revision']), 'Only an account note and its current revision are accepted.');
        const result = updateState(next => {
          const record = next.records.find(item => item.id === accountNoteMatch[1]);
          if (!record) throw new HttpError(404, 'Local account not found.');
          if (record.category !== 'account') throw new HttpError(404, 'Local account not found.');
          if (body.revision !== (record.revision || 0)) throw new HttpError(409, 'Local account changed. Refresh before adding a note.');
          const text = safeText(body.text, 'Account note', 4000, { required: true });
          record.history = Array.isArray(record.history) ? record.history : [];
          const entry = { id: randomUUID(), text, createdAt: clock().toISOString(), provenance: 'owner-provided-unverified' };
          record.history.push(entry);
          record.revision = (record.revision || 0) + 1;
          record.updatedAt = entry.createdAt;
          recordActivity(next, 'local-account-note', `Added a local note to ${record.title}.`, entry.createdAt);
          return { record, entry };
        });
        jsonResponse(response, 201, result);
        return;
      }

      const retryMatch = /^\/api\/jobs\/([0-9a-f-]{36})\/retry$/.exec(pathname);
      if (request.method === 'POST' && retryMatch) {
        const body = await readJson(request);
        const current = store.state.jobs.find(item => item.id === retryMatch[1]);
        if (current?.kind === 'file_content_read') {
          assertOnlyKeys(body, new Set(['confirmRead']), 'A selected-file retry accepts only explicit per-read approval.');
          if (body.confirmRead !== true) throw new HttpError(400, 'Confirm this retry as a new one-time file read.');
          if (current.status === 'partial') throw new HttpError(409, 'This file read already completed; no additional download is available through retry.');
          const capability = fileContentCapability();
          if (!capability.readyForApprovedRead) {
            throw new HttpError(503, `Selected file content is unavailable (${capability.reasons.join(', ')}). ${capability.message} No retry was queued.`);
          }
          const evidence = resolveFileContentEvidence(current.payload?.sourceReference);
          if (!evidence || !evidence.approvedHost ||
              evidence.mimeType.trim().toLowerCase() !== 'text/plain') {
            throw new HttpError(409, 'The selected file evidence, approved host, current owner, or consent changed. Run a fresh bounded source check; no retry was queued.');
          }
        } else {
          assertOnlyKeys(body, new Set(), 'Retry accepts an empty JSON object.');
        }
        if (current?.kind === 'teams_channel_replies' && !resolveTeamsReplyEvidence(current.payload?.sourceReference)) {
          throw new HttpError(409, 'The selected Teams source evidence, current owner, or consent changed. Run a fresh bounded source check and select the parent again; no retry was queued.');
        }
        const job = updateState(next => {
          const current = next.jobs.find(item => item.id === retryMatch[1]);
          if (!current) throw new HttpError(404, 'Job not found.');
          if (current.kind === 'meeting_insight_list') throw new HttpError(409, 'Meeting insight lists require a new explicit consent in the list form; this job cannot be retried.');
          if (!['partial', 'failed', 'interrupted'].includes(current.status)) throw new HttpError(409, 'Only partial, failed, or interrupted jobs may be retried.');
          if (current.kind === 'file_content_read' && current.status === 'partial') {
            throw new HttpError(409, 'This file read already completed; no additional download is available through retry.');
          }
          current.status = 'queued';
          if (current.kind === 'file_content_read') current.payload.confirmRead = true;
          current.previousResult = current.result;
          current.result = null;
          current.error = '';
          current.updatedAt = clock().toISOString();
          current.events.push({ status: 'queued', at: current.updatedAt });
          return current;
        });
        jsonResponse(response, 202, { job: publicJobs([job])[0] });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/tasks') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['title', 'details', 'status', 'priority', 'dueDate', 'accountId']), 'Only title, details, status, priority, due date, and local account ID are supported.');
        const title = safeText(body.title, 'Title', 160, { required: true });
        const details = safeText(body.details ?? '', 'Details', 3000);
        const status = body.status === undefined ? 'next' : safeStatus(body.status);
        const priority = body.priority === undefined ? 'normal' : body.priority;
        if (!['normal', 'important'].includes(priority)) throw new HttpError(400, 'Choose a supported task priority.');
        const dueDate = body.dueDate === undefined ? '' : safeDate(body.dueDate);
        const now = clock().toISOString();
        const task = await updateState(next => {
          const accountId = taskAccountId(next, Object.hasOwn(body, 'accountId') ? body.accountId : '');
          return addLocalTask(next, { title, details, status, priority, dueDate, accountId }, now);
        });
        jsonResponse(response, 201, { task });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/tasks/from-evidence') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['jobId', 'source', 'resultId', 'itemId', 'title', 'details', 'status', 'priority', 'dueDate', 'accountId']), 'Only an exact source-result reference and explicit local task fields are accepted.');
        const title = safeText(body.title, 'Title', 160, { required: true });
        const details = safeText(body.details ?? '', 'Details', 3000);
        const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
        if (typeof body.jobId !== 'string' || !uuid.test(body.jobId) ||
            typeof body.resultId !== 'string' || !uuid.test(body.resultId) ||
            typeof body.source !== 'string' || body.source.length > 80 ||
            typeof body.itemId !== 'string' || !/^[0-9a-f]{64}$/.test(body.itemId)) {
          throw new HttpError(403, 'An exact source-result revision is required. Run a new bounded source check and explicitly select its preview; no task was created.');
        }
        const currentState = store.state;
        const accountId = taskAccountId(currentState, Object.hasOwn(body, 'accountId') ? body.accountId : '');
        const job = currentState.jobs.find(job => job.id === body.jobId && job.kind === 'source_refresh');
        const source = job?.result?.sources?.find(item => item.source === body.source && item.resultId === body.resultId);
        const item = source?.items?.find(evidence => evidence.sourceKey === body.itemId && evidence.id);
        const connection = microsoft365.status();
        const identity = connection.identity;
        const authorizationReference = sourceAuthorization(body.source);
        if (!item || !identity || !connection.verifiedOwner || source.ownerReference !== JSON.stringify(identity) ||
            connection.state !== 'connected' || !authorizationReference ||
            source.authorizationReference !== authorizationReference) {
          throw new HttpError(403, 'The selected evidence is missing, changed, or does not belong to the currently verified owner. Reconnect if needed, run a new bounded source check and explicitly select its preview; no task was created.');
        }
        const sourceKey = createHash('sha256').update(JSON.stringify([identity, body.source, item.sourceKey])).digest('hex');
        const existing = currentState.tasks.find(task => task.sourceKey === sourceKey);
        if (existing) {
          const accountSelectionRetained = (existing.accountId || '') !== accountId;
          jsonResponse(response, 200, {
            task: existing, deduplicated: true, accountSelectionRetained,
            message: accountSelectionRetained
              ? 'The existing task and its existing account association (including Unassigned) were retained; your submitted account selection was not applied. Change the association only by editing the existing task. Completed work was not reopened.'
              : 'The existing task was retained; completed work was not reopened.'
          });
          return;
        }
        const priority = body.priority || 'normal';
        if (!['normal', 'important'].includes(priority)) throw new HttpError(400, 'Choose a supported task priority.');
        const now = clock().toISOString();
        const task = updateState(next => addLocalTask(next, {
          title, details, status: body.status === undefined ? 'next' : safeStatus(body.status),
          priority, dueDate: body.dueDate ? safeDate(body.dueDate) : '', sourceKey, accountId,
          evidence: [{
            id: randomUUID(), title: item.title, url: item.url, note: item.excerpt,
            provenance: 'authorized-source-untrusted-evidence', source: body.source, createdAt: now,
            sourceReference: { jobId: job.id, resultId: source.resultId, itemId: item.sourceKey }
          }]
        }, now));
        jsonResponse(response, 201, { task, message: 'You created this task explicitly. Source content is evidence, not proof of an outstanding assignment.' });
        return;
      }

      const taskMatch = /^\/api\/tasks\/([0-9a-f-]{36})$/.exec(pathname);
      if (request.method === 'PATCH' && taskMatch) {
        const body = await readJson(request);
        const allowed = new Set(['title', 'details', 'status', 'priority', 'dueDate', 'accountId', 'revision']);
        if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.has(key))) {
          throw new HttpError(400, 'Update only title, details, status, priority, due date, or local account ID.');
        }
        const now = clock().toISOString();
        const task = await updateState(next => {
          const current = taskById(next, taskMatch[1]);
          if (!Number.isInteger(body.revision) || body.revision !== (current.revision || 0)) throw new HttpError(409, 'Task changed or its revision is missing. Refresh before updating; your edits were not applied.');
          const previous = { title: current.title, details: current.details, status: current.status, priority: current.priority, dueDate: current.dueDate, accountId: current.accountId || '' };
          if (Object.hasOwn(body, 'title')) current.title = safeText(body.title, 'Title', 160, { required: true });
          if (Object.hasOwn(body, 'details')) current.details = safeText(body.details, 'Details', 3000);
          if (Object.hasOwn(body, 'status')) current.status = safeStatus(body.status);
          if (Object.hasOwn(body, 'priority')) {
            if (!['normal', 'important'].includes(body.priority)) throw new HttpError(400, 'Choose a supported task priority.');
            current.priority = body.priority;
          }
          if (Object.hasOwn(body, 'dueDate')) current.dueDate = safeDate(body.dueDate);
          if (Object.hasOwn(body, 'accountId')) current.accountId = taskAccountId(next, body.accountId);
          if (current.status !== previous.status) {
            taskEvent(current, current.status === 'done' ? 'completed' : previous.status === 'done' ? 'reopened' : 'status-changed', now, { fromStatus: previous.status, toStatus: current.status });
            current.completedAt = current.status === 'done' ? now : null;
          }
          const fields = ['title', 'details', 'priority', 'dueDate', 'accountId'].filter(key => previous[key] !== (key === 'accountId' ? current.accountId || '' : current[key]));
          if (fields.length) taskEvent(current, 'updated', now, { fields });
          current.updatedAt = now;
          current.revision = (current.revision || 0) + 1;
          recordActivity(next, 'task-updated', `Updated task: ${current.title}`, now);
          return current;
        });
        jsonResponse(response, 200, { task });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/drafts') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['recipient', 'subject', 'body']), 'Only recipient, subject, and draft body are supported.');
        const recipient = safeText(body.recipient ?? '', 'Recipient', 320);
        const subject = safeText(body.subject, 'Subject', 240, { required: true });
        const text = safeText(body.body, 'Draft body', 12_000);
        if (!text) throw new HttpError(400, 'Draft body is required.');
        const now = new Date().toISOString();
        const draft = await updateState(next => {
          const created = { id: randomUUID(), recipient, subject, body: text, revision: 1, sent: false, storage: 'local-only', createdAt: now, updatedAt: now };
          next.drafts.unshift(created);
          recordActivity(next, 'draft-saved', `Saved local unsent draft: ${subject}`, now);
          return created;
        });
        jsonResponse(response, 201, { draft, message: 'Saved locally as an unsent draft. It was not synced; authorized Outlook reply drafts require separate explicit setup.' });
        return;
      }

      const draftMatch = /^\/api\/drafts\/([0-9a-f-]{36})$/.exec(pathname);
      if (request.method === 'PATCH' && draftMatch) {
        const body = await readJson(request);
        const allowed = new Set(['recipient', 'subject', 'body', 'revision']);
        if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.has(key))) {
          throw new HttpError(400, 'Update only recipient, subject, or draft body.');
        }
        const now = new Date().toISOString();
        const draft = await updateState(next => {
          const current = next.drafts.find(item => item.id === draftMatch[1]);
          if (!current) throw new HttpError(404, 'Draft not found.');
          if (!Number.isInteger(body.revision) || body.revision !== (current.revision || 0)) throw new HttpError(409, 'Draft changed or its revision is missing. Your edits were not applied; reload the latest version before saving.');
          if (Object.hasOwn(body, 'recipient')) current.recipient = safeText(body.recipient, 'Recipient', 320);
          if (Object.hasOwn(body, 'subject')) current.subject = safeText(body.subject, 'Subject', 240, { required: true });
          if (Object.hasOwn(body, 'body')) {
            current.body = safeText(body.body, 'Draft body', 12_000);
            if (!current.body) throw new HttpError(400, 'Draft body is required.');
          }
          current.sent = false;
          current.storage = 'local-only';
          current.updatedAt = now;
          current.revision = (current.revision || 0) + 1;
          recordActivity(next, 'draft-updated', `Updated local unsent draft: ${current.subject}`, now);
          return current;
        });
        jsonResponse(response, 200, { draft, message: 'Updated locally; this draft remains unsent.' });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/links') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['title', 'url']), 'Only a link title and URL are supported.');
        const title = safeText(body.title, 'Link title', 160, { required: true });
        const url = safeLinkUrl(body.url);
        const existing = store.state.links.find(link => link.url === url && link.title === title);
        if (existing) {
          jsonResponse(response, 200, { link: existing, deduplicated: true });
          return;
        }
        const now = new Date().toISOString();
        const link = updateState(next => {
          const created = { id: randomUUID(), title, url, createdAt: now };
          next.links.unshift(created);
          recordActivity(next, 'link-saved', `Saved local link: ${title}`, now);
          return created;
        });
        jsonResponse(response, 201, { link });
        return;
      }

      if (request.method === 'PATCH' && pathname === '/api/profile') {
        const body = await readJson(request);
        const profile = updateState(next => updateProfile(next, body));
        jsonResponse(response, 200, { profile });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/assistant') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['prompt']), 'Only a prompt field is accepted.');
        safeText(body.prompt, 'Prompt', 8000, { required: true });
        const status = assistant.status();
        if (status.state !== 'connected' || status.simulation || status.availability !== 'available') {
          jsonResponse(response, 503, { available: false, submitted: false, code: status.code, error: 'Assistant is disconnected or its runtime is unverified. Your message was not submitted or stored.' });
          return;
        }
        const job = updateState(next => enqueue(next, { kind: 'assistant', payload: { prompt: body.prompt }, requestId: randomUUID() }, clock()));
        jsonResponse(response, 202, { job });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/assistant/connect') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['explicitUserAuthorization', 'currentUserOnly', 'allowModelRequest']), 'Only explicit current-user assistant consent is accepted.');
        const status = assistant.connect(body);
        jsonResponse(response, 503, { status, error: `Assistant is unavailable (${status.code}); no SDK, CLI, account, or model was accessed.` });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/assistant/disconnect') {
        assertOnlyKeys(await readJson(request), new Set(), 'No disconnect parameters are accepted.');
        jsonResponse(response, 200, { status: assistant.disconnect() });
        return;
      }
      if (pathname === '/api/drafts/send' || pathname === '/api/send') {
        jsonResponse(response, 405, { error: 'Sending email is not supported.' }, { Allow: 'GET' });
        return;
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('[esquie] local request failed; no external-provider details were logged.');
      jsonResponse(response, status, { error: status === 500 ? 'The local workspace could not complete this request.' : error.message });
    }
  });

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const launchUrl = `${url}/#access=${accessToken}`;
  const launchFile = join(root, 'esquie-launch.html');
  const launchContent = privateLauncherContent(launchUrl);
  let launchWritten = false;
  let closing;
  const close = () => closing ||= (async () => {
      shuttingDown = true;
      const workerStopping = worker.stop();
      disconnectMicrosoft365();
      await outcomesOcr.close();
      await workerStopping;
      assistant.disconnect();
      await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
      try {
        if (launchWritten) {
          let content;
          try { content = await readFile(launchFile, 'utf8'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (content !== undefined) {
            if (content !== launchContent) throw new Error('The launch file changed; it was not deleted.');
            await rm(launchFile);
          }
        }
      } finally { await closeStore(); }
    })();
  try {
    try {
      await assertPlainLocalFile(launchFile);
      if (!isUnmodifiedPrivateLauncher(await readFile(launchFile, 'utf8'))) throw new Error('An unrelated launch file or modified generated launcher exists; it was not overwritten.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(launchFile, launchContent, { mode: 0o600 });
    launchWritten = true;
  } catch (error) {
    await close();
    throw error;
  }
  return { server, url, launchUrl, launchFile, accessToken, dataDir: root, worker, close };
  } catch (error) {
    shuttingDown = true;
    disconnectMicrosoft365();
    assistant.disconnect();
    await outcomesOcr.close();
    try {
      if (server.listening) await new Promise((resolveClose, rejectClose) => server.close(failure => failure ? rejectClose(failure) : resolveClose()));
    } finally {
      try { await worker?.stop(); }
      finally { await closeStore(); }
    }
    throw error;
  }
}

export function reserveOcrIfConnected(service, request, response, signal) {
  if (signal.aborted || request.aborted || response.destroyed || response.socket?.destroyed) return null;
  return service.reserve();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = await startServer();
    console.log(`Esquie local workspace listening at ${app.url}`);
    console.log(`Open this private launch file in your browser: ${app.launchFile}`);
    const shutdown = () => app.close().then(() => process.exit(0), error => {
      console.error('[esquie] shutdown failed:', error.message);
      process.exit(1);
    });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error('[esquie] startup failed:', error.message);
    process.exitCode = 1;
  }
}
