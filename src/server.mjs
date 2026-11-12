import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { createWorker, enqueue } from './worker.mjs';
import { assertOutputAllowed, assertPlainLocalFile, verifyLocalVolume as defaultVerifyLocalVolume } from './local-output.mjs';
import { createMicrosoft365Connectors, ConnectorError } from './connectors/microsoft365.mjs';
import { createAssistantBridge } from './assistant/bridge.mjs';
import { assertPrivateDataDirectory, assertPrivateStorage } from './private-storage.mjs';
import { recoverLocalBackup } from './backups.mjs';
import { confirmMonthlyOutcomeImport, previewMonthlyOutcomeImport } from './monthly-outcomes-import.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const PUBLIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);
const TASK_STATUSES = new Set(['next', 'doing', 'waiting', 'done']);
const MAX_BODY_BYTES = 20_000;
const MAX_OUTCOMES_IMPORT_BODY_BYTES = 128_000;
const MAX_ACTIVITY_ITEMS = 100;

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

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected an object.');
    return body;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
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
  assertOnlyKeys(body, new Set(['id', 'revision', 'category', 'title', 'note', 'date']), 'Unsupported local record fields.');
  if (body.category !== category) throw new HttpError(400, 'Choose the record category for this setup step.');
  const record = body.id ? state.records.find(item => item.id === body.id && item.category === category) : null;
  if (body.id && !record) throw new HttpError(404, 'Local record not found.');
  const values = {
    title: safeText(body.title, 'Title', 160, { required: true }),
    note: Object.hasOwn(body, 'note') ? safeText(body.note, 'Note', 4000) : record?.note || '',
    date: Object.hasOwn(body, 'date') ? (body.date ? safeDate(body.date) : '') : record?.date || ''
  };
  if (record) {
    if (body.revision !== (record.revision || 0)) throw new HttpError(409, 'Local record changed. Refresh before updating.');
    Object.assign(record, values, { updatedAt: now, revision: (record.revision || 0) + 1 });
    return record;
  }
  const created = { id: randomUUID(), category, ...values, revision: 1, provenance: 'owner-provided-unverified', createdAt: now };
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
  assertOnlyKeys(sources, new Set(['mail', 'calendar', 'chats', 'channels', 'transcripts', 'files']), 'Only supported explicit source selections are accepted.');
  const selected = {};
  for (const key of ['mail', 'calendar']) if (Object.hasOwn(sources, key)) {
    if (typeof sources[key] !== 'boolean') throw new HttpError(400, `${key} selection must be a boolean.`);
    selected[key] = sources[key];
  }
  for (const [key, fields] of [
    ['chats', null], ['channels', ['teamId', 'channelId']],
    ['transcripts', ['meetingId', 'transcriptId']], ['files', ['driveId', 'itemId']]
  ]) if (Object.hasOwn(sources, key)) {
    if (!Array.isArray(sources[key]) || sources[key].length > 10) throw new HttpError(400, `${key} must contain at most 10 approved sources.`);
    selected[key] = sources[key].map(value => {
      if (!fields) return safeText(value, 'Approved chat ID', 2000, { required: true });
      object(value, 'Approved source pair');
      assertOnlyKeys(value, new Set(fields), 'Source pairs accept only their exact IDs, never credentials or source content.');
      return Object.fromEntries(fields.map(field => [field, safeText(value[field], field, 2000, { required: true })]));
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

export async function startServer({
  dataDir = process.env.ESQUIE_DATA_DIR || join(homedir(), '.esquie-local'),
  port = Number(process.env.ESQUIE_PORT || 4317),
  connectors = {},
  microsoft365Options = {},
  clock = () => new Date(),
  workerIntervalMs = 1000,
  verifyLocalVolume = defaultVerifyLocalVolume
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ESQUIE_PORT must be an integer from 0 to 65535.');
  const microsoft365 = createMicrosoft365Connectors(microsoft365Options);
  const assistant = createAssistantBridge();

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
  const verifyOutput = async () => {
    assertPrivateDataDirectory(root);
    await assertPrivateStorage(root);
    return assertOutputAllowed({ root, approved: store.state.preferences.localOutputApproved, redirected: outputRedirected, verifyVolume: verifyLocalVolume });
  };
  worker = createWorker({
    store, root, connectors: sourceConnectors, assistant, sourceIdentity, clock, intervalMs: workerIntervalMs, verifyOutput,
    onSourceResult: result => sourceHealth.set(result.source, result)
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
        jsonResponse(response, 200, { ...state, csrfToken, mode: 'local-only' });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/jobs') {
        jsonResponse(response, 200, { jobs: state.jobs });
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
          const names = { chats: 'teamsChats', channels: 'teamsChannels' };
          const selected = enabledKeys.filter(key => connection.enabled.includes(key)).map(key => names[key] || key);
          const lastReads = selected.map(key => sourceHealth.get(key)).filter(Boolean);
          const verified = selected.filter(key => {
            const health = sourceHealth.get(key);
            return health?.status === 'partial' && health.ownerReference === JSON.stringify(connection.identity);
          }).length;
          return {
            status: connection.state !== 'connected' ? connection.state : !selected.length ? 'not-authorized'
              : verified === selected.length ? 'bounded-read-verified' : verified ? 'partial-access' : 'access-unverified',
            available: connection.state === 'connected' && selected.length > 0 && verified === selected.length,
            ownerVerified: connection.verifiedOwner, access: 'read-only', lastReads
          };
        };
        jsonResponse(response, 200, {
          assistant: { status: assistant.status().state, code: assistant.status().code, available: false },
          email: { ...status('mail'), sendEnabled: false, access: 'draft-only' },
          calendar: status('calendar'),
          teams: status('teams', ['chats', 'channels', 'transcripts']),
          reporting: { status: 'disconnected', available: false, access: 'read-only' },
          sharepoint: status('files'),
          microsoft365: { ...connection, hostAuthenticationAvailable: typeof microsoft365Options.tokenProvider === 'function' },
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
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['consent', 'expectedIdentity', 'sources', 'allowReplyDrafts']), 'Only explicit owner identity, source selections, and consent are accepted; never provide tokens.');
        const consent = sourceConsent(body);
        sourceHealth.clear();
        try {
          const connection = await microsoft365.connect({ ...consent, signal: AbortSignal.timeout(30_000) });
          updateState(next => { next.sourceConsent = { expectedIdentity: connection.identity, sources: consent.sources, allowReplyDrafts: consent.allowReplyDrafts }; });
          jsonResponse(response, 200, { connection, message: 'Owner verified for selected operations, not synchronized. Run an explicit bounded source check.' });
        } catch (error) {
          const code = error instanceof ConnectorError ? error.code : 'connection_failed';
          jsonResponse(response, 503, { error: `Microsoft 365 is unavailable (${code}). No successful connection or synchronization is claimed.`, connection: microsoft365.status() });
        }
        return;
      }
      if (request.method === 'POST' && pathname === '/api/microsoft365/disconnect') {
        assertOnlyKeys(await readJson(request), new Set(), 'No disconnect parameters are accepted.');
        microsoft365.disconnect();
        sourceHealth.clear();
        jsonResponse(response, 200, { connection: microsoft365.status(), message: 'Disconnected. Stored local evidence remains historical context, not instructions.' });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/mail/reply-drafts') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['messageId', 'text', 'replyAll', 'requestId']), 'Only an exact message ID, reply text, replyAll flag, and UUID request ID are accepted.');
        const messageId = safeText(body.messageId, 'Message ID', 2000, { required: true });
        const text = safeText(body.text, 'Reply text', 12000, { required: true });
        if (typeof body.replyAll !== 'boolean') throw new HttpError(400, 'Choose reply or reply-all explicitly.');
        if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.requestId)) throw new HttpError(400, 'A UUID request ID is required.');
        const connector = microsoft365.connectors.mail;
        if (microsoft365.status().state !== 'connected') throw new HttpError(503, 'Outlook is disconnected. No draft was created.');
        const ownerReference = JSON.stringify(sourceIdentity());
        const fingerprint = createHash('sha256').update(JSON.stringify({ messageId, text, replyAll: body.replyAll })).digest('hex');
        const previous = store.state.draftOperations.find(item => item.requestId === body.requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint || previous.ownerReference !== ownerReference) throw new HttpError(409, 'This request ID belongs to different work.');
          if (previous.status === 'completed') {
            jsonResponse(response, 200, { draft: previous.draft, deduplicated: true, message: 'The prior verified draft is retained. No second draft was created.' });
            return;
          }
          throw new HttpError(409, 'This draft operation is pending, failed, or uncertain. Inspect Outlook; it was not retried.');
        }
        if (store.state.draftOperations.some(item => item.ownerReference === ownerReference && item.messageId === messageId && ['creating', 'unknown', 'completed'].includes(item.status))) {
          throw new HttpError(409, 'A draft for this source already exists or may exist. Inspect Outlook; no second draft was created.');
        }
        updateState(next => next.draftOperations.push({ requestId: body.requestId, messageId, ownerReference, fingerprint, status: 'creating', createdAt: clock().toISOString() }));
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

      if (request.method === 'PATCH' && pathname === '/api/preferences') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['paused', 'quietStart', 'quietEnd', 'automaticRefresh', 'dailyBackups']), 'Only supported worker preferences may be updated.');
        const preferences = updateState(next => {
          for (const key of ['paused', 'automaticRefresh', 'dailyBackups']) if (Object.hasOwn(body, key)) {
            if (typeof body[key] !== 'boolean') throw new HttpError(400, `${key} must be a boolean.`);
            next.preferences[key] = body[key];
          }
          for (const key of ['quietStart', 'quietEnd']) if (Object.hasOwn(body, key)) {
            if (typeof body[key] !== 'string' || (body[key] && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body[key]))) {
              throw new HttpError(400, 'Quiet hours must use HH:MM or be blank.');
            }
            next.preferences[key] = body[key];
          }
          if (Boolean(next.preferences.quietStart) !== Boolean(next.preferences.quietEnd)) {
            throw new HttpError(400, 'Set both quiet-hour times, or clear both.');
          }
          if ((next.preferences.quietStart || next.preferences.automaticRefresh || next.preferences.dailyBackups) && !next.profile.timezone) {
            throw new HttpError(400, 'Set your own timezone before enabling scheduled work or quiet hours.');
          }
          return next.preferences;
        });
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
        try { recovery = await recoverLocalBackup({ root, backup, now: clock(), verifyOutput }); }
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
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['confirmPrivateNonSynced']), 'Only explicit local output confirmation is supported.');
        if (typeof body.confirmPrivateNonSynced !== 'boolean') throw new HttpError(400, 'Confirm the local destination explicitly.');
        if (body.confirmPrivateNonSynced) {
          assertPrivateDataDirectory(root);
          await assertPrivateStorage(root);
          try { await assertOutputAllowed({ root, approved: true, redirected: outputRedirected, verifyVolume: verifyLocalVolume }); }
          catch (error) { throw new HttpError(403, error.message); }
        }
        updateState(next => { next.preferences.localOutputApproved = body.confirmPrivateNonSynced; });
        jsonResponse(response, 200, { approved: body.confirmPrivateNonSynced });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/demo-approval') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['confirmSyntheticLocalOnly']), 'Only approval of fixed local synthetic demos is supported.');
        if (typeof body.confirmSyntheticLocalOnly !== 'boolean') throw new HttpError(400, 'Approve or revoke the local demo configuration explicitly.');
        updateState(next => { next.preferences.demoApproved = body.confirmSyntheticLocalOnly; });
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
        assertOnlyKeys(body, new Set(['kind', 'taskId', 'notes', 'requestId', 'confirmFakeOnly']), 'Unsupported job fields.');
        if (!['task_summary', 'meeting_notes', 'source_refresh', 'document', 'fake_demo', 'backup'].includes(body.kind)) throw new HttpError(400, 'Unsupported job kind.');
        if (body.kind === 'backup' && body.taskId != null) throw new HttpError(400, 'Workspace backups do not accept task inputs.');
        if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.requestId)) throw new HttpError(400, 'A UUID request ID is required.');
        if (body.taskId != null) taskById(state, body.taskId);
        if (body.kind !== 'meeting_notes' && Object.hasOwn(body, 'notes')) throw new HttpError(400, 'Only meeting-note jobs accept notes.');
        if (body.kind === 'fake_demo' && (!state.preferences.demoApproved || body.confirmFakeOnly !== true || body.taskId)) {
          throw new HttpError(403, 'Demo creation needs approved local synthetic-only configuration and explicit confirmation for this run; task/customer inputs are not accepted.');
        }
        if (body.kind !== 'fake_demo' && Object.hasOwn(body, 'confirmFakeOnly')) throw new HttpError(400, 'Fake-only confirmation applies only to demo jobs.');
        const payload = body.kind === 'meeting_notes' ? { notes: safeText(body.notes, 'Meeting notes', 8000, { required: true }) }
          : body.kind === 'fake_demo' ? { confirmFakeOnly: true } : {};
        let job;
        try {
          job = updateState(next => enqueue(next, { kind: body.kind, payload, requestId: body.requestId, taskId: body.taskId || null }, clock()));
        } catch (error) {
          if (error.message.includes('request ID')) throw new HttpError(409, error.message);
          throw error;
        }
        jsonResponse(response, 202, { job, message: 'Queued locally; no result is claimed until the worker finishes.' });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/records') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['category', 'title', 'note', 'date']), 'Only local record category, title, note, and date are supported.');
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
        assertOnlyKeys(body, new Set(['text']), 'Only pasted workshop text is accepted.');
        const preview = outcomesImportCall(() =>
          previewMonthlyOutcomeImport(state.records, body.text, { today: ownerLocalDate(clock(), state.profile.timezone) }));
        jsonResponse(response, 200, preview);
        return;
      }

      if (request.method === 'POST' && pathname === '/api/outcomes/import/confirm') {
        const body = await readJson(request, MAX_OUTCOMES_IMPORT_BODY_BYTES);
        assertOnlyKeys(body, new Set(['text', 'revision', 'textHash', 'reviewed']), 'Only the reviewed workshop preview is accepted.');
        const result = updateState(next => {
          const now = clock();
          const imported = outcomesImportCall(() => confirmMonthlyOutcomeImport(
            next, body.text, body.revision, body.textHash, body.reviewed, now.toISOString(),
            { today: ownerLocalDate(now, next.profile.timezone) }
          ));
          if (imported.imported) recordActivity(next, 'local-outcomes-import', `Imported ${imported.imported} owner-reviewed workshop outcomes locally.`, now.toISOString());
          return imported;
        });
        jsonResponse(response, 200, result);
        return;
      }

      const recordMatch = /^\/api\/records\/([0-9a-f-]{36})$/.exec(pathname);
      if (request.method === 'PATCH' && recordMatch) {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['category', 'title', 'note', 'date', 'revision']), 'Only editable local record fields are accepted.');
        const record = updateState(next => {
          const previous = next.records.find(item => item.id === recordMatch[1]);
          if (!previous) throw new HttpError(404, 'Local record not found.');
          return saveLocalRecord(next, { ...body, id: previous.id }, clock().toISOString(), previous.category);
        });
        jsonResponse(response, 200, { record });
        return;
      }

      const retryMatch = /^\/api\/jobs\/([0-9a-f-]{36})\/retry$/.exec(pathname);
      if (request.method === 'POST' && retryMatch) {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(), 'Retry accepts an empty JSON object.');
        const job = updateState(next => {
          const current = next.jobs.find(item => item.id === retryMatch[1]);
          if (!current) throw new HttpError(404, 'Job not found.');
          if (!['partial', 'failed', 'interrupted'].includes(current.status)) throw new HttpError(409, 'Only partial, failed, or interrupted jobs may be retried.');
          current.status = 'queued';
          current.previousResult = current.result;
          current.result = null;
          current.error = '';
          current.updatedAt = clock().toISOString();
          current.events.push({ status: 'queued', at: current.updatedAt });
          return current;
        });
        jsonResponse(response, 202, { job });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/tasks') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['title', 'details', 'status', 'priority', 'dueDate']), 'Only title, details, status, priority, and due date are supported.');
        const title = safeText(body.title, 'Title', 160, { required: true });
        const details = safeText(body.details ?? '', 'Details', 3000);
        const status = body.status === undefined ? 'next' : safeStatus(body.status);
        const priority = body.priority === undefined ? 'normal' : body.priority;
        if (!['normal', 'important'].includes(priority)) throw new HttpError(400, 'Choose a supported task priority.');
        const dueDate = body.dueDate === undefined ? '' : safeDate(body.dueDate);
        const now = clock().toISOString();
        const task = await updateState(next => {
          return addLocalTask(next, { title, details, status, priority, dueDate }, now);
        });
        jsonResponse(response, 201, { task });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/tasks/from-evidence') {
        const body = await readJson(request);
        assertOnlyKeys(body, new Set(['jobId', 'source', 'itemId', 'title', 'details', 'status', 'priority', 'dueDate']), 'Only a source-result reference and explicit local task fields are accepted.');
        const title = safeText(body.title, 'Title', 160, { required: true });
        const details = safeText(body.details ?? '', 'Details', 3000);
        const source = state.jobs.find(job => job.id === body.jobId)?.result?.sources?.find(item => item.source === body.source);
        const item = source?.items?.find(evidence => evidence.sourceKey === body.itemId && evidence.id);
        const identity = microsoft365.status().identity;
        if (!item || !identity || source.ownerReference !== JSON.stringify(identity) || microsoft365.status().state !== 'connected') {
          throw new HttpError(403, 'The evidence does not belong to the currently verified owner. Reconnect and explicitly check the source.');
        }
        const sourceKey = createHash('sha256').update(JSON.stringify([identity, body.source, item.sourceKey])).digest('hex');
        const existing = store.state.tasks.find(task => task.sourceKey === sourceKey);
        if (existing) {
          jsonResponse(response, 200, { task: existing, deduplicated: true, message: 'The existing task was retained; completed work was not reopened.' });
          return;
        }
        const priority = body.priority || 'normal';
        if (!['normal', 'important'].includes(priority)) throw new HttpError(400, 'Choose a supported task priority.');
        const now = clock().toISOString();
        const task = updateState(next => addLocalTask(next, {
          title, details, status: body.status === undefined ? 'next' : safeStatus(body.status),
          priority, dueDate: body.dueDate ? safeDate(body.dueDate) : '', sourceKey,
          evidence: [{
            id: randomUUID(), title: item.title, url: item.url, note: item.excerpt,
            provenance: 'authorized-source-untrusted-evidence', source: body.source, createdAt: now
          }]
        }, now));
        jsonResponse(response, 201, { task, message: 'You created this task explicitly. Source content is evidence, not proof of an outstanding assignment.' });
        return;
      }

      const taskMatch = /^\/api\/tasks\/([0-9a-f-]{36})$/.exec(pathname);
      if (request.method === 'PATCH' && taskMatch) {
        const body = await readJson(request);
        const allowed = new Set(['title', 'details', 'status', 'priority', 'dueDate', 'revision']);
        if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.has(key))) {
          throw new HttpError(400, 'Update only title, details, status, priority, or due date.');
        }
        const now = clock().toISOString();
        const task = await updateState(next => {
          const current = taskById(next, taskMatch[1]);
          if (!Number.isInteger(body.revision) || body.revision !== (current.revision || 0)) throw new HttpError(409, 'Task changed or its revision is missing. Refresh before updating; your edits were not applied.');
          const previous = { title: current.title, details: current.details, status: current.status, priority: current.priority, dueDate: current.dueDate };
          if (Object.hasOwn(body, 'title')) current.title = safeText(body.title, 'Title', 160, { required: true });
          if (Object.hasOwn(body, 'details')) current.details = safeText(body.details, 'Details', 3000);
          if (Object.hasOwn(body, 'status')) current.status = safeStatus(body.status);
          if (Object.hasOwn(body, 'priority')) {
            if (!['normal', 'important'].includes(body.priority)) throw new HttpError(400, 'Choose a supported task priority.');
            current.priority = body.priority;
          }
          if (Object.hasOwn(body, 'dueDate')) current.dueDate = safeDate(body.dueDate);
          if (current.status !== previous.status) {
            taskEvent(current, current.status === 'done' ? 'completed' : previous.status === 'done' ? 'reopened' : 'status-changed', now, { fromStatus: previous.status, toStatus: current.status });
            current.completedAt = current.status === 'done' ? now : null;
          }
          const fields = ['title', 'details', 'priority', 'dueDate'].filter(key => previous[key] !== current[key]);
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
        jsonResponse(response, 201, { draft, message: 'Saved locally as an unsent draft. No email integration is connected.' });
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
        const now = new Date().toISOString();
        const link = await updateState(next => {
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
      microsoft365.disconnect();
      assistant.disconnect();
      await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
      await worker.stop();
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
    microsoft365.disconnect();
    assistant.disconnect();
    try {
      if (server.listening) await new Promise((resolveClose, rejectClose) => server.close(failure => failure ? rejectClose(failure) : resolveClose()));
    } finally {
      try { await worker?.stop(); }
      finally { await closeStore(); }
    }
    throw error;
  }
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
