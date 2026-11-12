import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeFile as writeFileCallback } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertPlainLocalFile, verifyLocalVolume } from './local-output.mjs';
import { createLocalBackup, MAX_LOCAL_DOCUMENT_BYTES, readVerifiedLocalFile } from './backups.mjs';
import { documentFileName } from './document-format.mjs';
import { createFakeDemoPptx } from './fake-demo-pptx.mjs';
import { createWordTaskSummary, InvalidWordTextError } from './word-document.mjs';
import { MAX_FILE_CONTENT_BYTES } from './connectors/safe-file-download.mjs';

const FILE_READ_ERROR_CODES = new Set([
  'authentication_required', 'blocked_request', 'cancelled', 'disconnected',
  'file_content_consent_required', 'file_content_unavailable', 'file_revision_changed',
  'file_revision_unavailable', 'identity_mismatch', 'invalid_content_encoding',
  'invalid_content_host', 'invalid_response', 'network_policy_unavailable',
  'operation_paused', 'permission_denied', 'permission_required', 'response_too_large',
  'service_error', 'source_not_authorized', 'source_unavailable', 'throttled', 'timeout',
  'transport_error'
]);

const writeOpenFile = promisify(writeFileCallback);
const documentIdConflict = (message, untracked = false) =>
  Object.assign(new Error(message), { code: untracked ? 'local_document_untracked' : 'local_document_id_collision' });

export function timezoneAvailable(timezone) {
  if (typeof timezone !== 'string' || !timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export function quietHoursValid(preferences) {
  const { quietStart, quietEnd } = preferences;
  const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  return (quietStart === '' && quietEnd === '') || (validTime(quietStart) && validTime(quietEnd));
}

export function timezoneStatus(preferences, timezone, jobs = []) {
  const available = timezoneAvailable(timezone);
  return {
    available,
    quietHoursInvalid: !quietHoursValid(preferences),
    quietHoursBlocked: !available && Boolean(preferences.quietStart || preferences.quietEnd),
    scheduledWorkBlocked: !available && Boolean(preferences.automaticRefresh || preferences.dailyBackups ||
      jobs.some(job => job.status === 'queued' && job.origin === 'schedule' && ['backup', 'source_refresh'].includes(job.kind)))
  };
}

export function quietHoursActive(preferences, timezone, now = new Date()) {
  if (!quietHoursValid(preferences)) return true;
  if (!preferences.quietStart) return false;
  if (!timezoneAvailable(timezone)) return true;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const time = `${parts.find(part => part.type === 'hour').value}:${parts.find(part => part.type === 'minute').value}`;
  const { quietStart, quietEnd } = preferences;
  if (quietStart === quietEnd) return true;
  return quietStart < quietEnd ? time >= quietStart && time < quietEnd : time >= quietStart || time < quietEnd;
}

export function backupWindowDay(timezone, now) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const get = type => parts.find(part => part.type === type).value;
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  if (Number(get('hour')) >= 7) return day;
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
}

function lastBackupWindow(scheduler, timezone) {
  const timestamp = Date.parse(scheduler.lastBackupAttemptAt);
  if (Number.isFinite(timestamp)) return backupWindowDay(timezone, new Date(timestamp));
  return /^\d{4}-\d{2}-\d{2}$/.test(scheduler.lastBackupDay || '') ? scheduler.lastBackupDay : null;
}

export function enqueue(state, { kind, payload = {}, requestId, taskId = null, origin = 'owner' }, now = new Date()) {
  const existing = state.jobs.find(job => job.requestId === requestId);
  if (existing) {
    if (existing.kind !== kind || JSON.stringify(existing.payload) !== JSON.stringify(payload) || existing.taskId !== taskId) {
      throw new Error('This request ID was already used for different work.');
    }
    return existing;
  }
  const at = now.toISOString();
  const job = {
    id: randomUUID(), requestId, kind, payload, taskId, origin, status: 'queued',
    createdAt: at, updatedAt: at, result: null, error: '', attempts: 0,
    events: [{ status: 'queued', at }]
  };
  state.jobs.unshift(job);
  return job;
}

function preview(item) {
  const text = value => typeof value === 'string' ? value : '';
  let url = '';
  try {
    const parsed = new URL(item.webLink);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) url = parsed.href;
  } catch { /* Missing references remain visibly unavailable, never fetched. */ }
  return {
    id: text(item.id || item.transcriptId),
    sourceKey: createHash('sha256').update(JSON.stringify([
      item.driveId || '', item.chatId || '', item.teamId || '', item.channelId || '',
      item.meetingId || '', item.id || item.transcriptId || ''
    ])).digest('hex'),
    title: text(item.subject || item.name || item.transcriptId || item.id).slice(0, 160),
    excerpt: text(item.body?.content || item.content).slice(0, 600),
    excerptTruncated: text(item.body?.content || item.content).length > 600,
    url, contentAvailable: item.contentAvailable !== false,
    mimeType: text(item.mimeType), lastModifiedDateTime: text(item.lastModifiedDateTime),
    ...(typeof item.eTag === 'string' ? { eTag: item.eTag } : {}),
    ...(Number.isSafeInteger(item.size) ? { size: item.size } : {}),
    trust: 'untrusted-evidence'
  };
}

function operationSignal(control, timeoutMs) {
  return AbortSignal.any([control.controller.signal, AbortSignal.timeout(timeoutMs)]);
}

function connectorErrorCode(error) {
  return FILE_READ_ERROR_CODES.has(error?.code) ? error.code : 'read_failed';
}

function taskSummary(state, taskId) {
  const tasks = taskId ? state.tasks.filter(task => task.id === taskId) : state.tasks.filter(task => task.status !== 'done');
  return [
    '# Local task summary',
    '',
    'Generated from your local board only. This is a deterministic outline, not AI research or source verification.',
    '',
    ...tasks.map(task => `- ${task.title} [${task.status}]${task.dueDate ? ` - due ${task.dueDate}` : ''}${task.details ? `\n  ${task.details}` : ''}`),
    ...(tasks.length ? [] : ['No open tasks are recorded.'])
  ].join('\n');
}

export function createWorker({ store, root, connectors = {}, assistant, sourceIdentity = () => null, sourceAuthorization, authorizeTeamsReply = () => null, authorizeFileContent = () => null, fileContentAvailability = () => ({ readyForApprovedRead: false, reasons: ['unavailable'] }), sourceEpoch = () => null, insightListConnector, insightSelectionConnector, insightSelectionCurrent = () => false, onSourceResult = () => {}, clock = () => new Date(), intervalMs = 1000, verifyOutput, assertOutput }) {
  let stopping = false;
  let current = null;
  let currentControl = null;
  const hasSourceAuthorization = typeof sourceAuthorization === 'function';
  const authorizationFor = source => hasSourceAuthorization ? sourceAuthorization(source) : undefined;
  const stopReason = () => {
    if (stopping) return 'shutdown';
    const state = store.state;
    if (state.preferences.paused) return 'paused';
    if (quietHoursActive(state.preferences, state.profile.timezone, clock())) return 'quiet_hours';
    return null;
  };
  const checkpoint = control => {
    if (control.stopReason) return false;
    const reason = stopReason();
    if (reason) {
      control.stopReason = reason;
      control.controller.abort();
      return false;
    }
    return !control.controller.signal.aborted;
  };
  const cancelCurrent = reason => {
    if (!currentControl || currentControl.controller.signal.aborted) return;
    currentControl.stopReason = reason;
    currentControl.controller.abort();
  };
  const transition = (id, status, extra = {}) => store.update(state => {
    const job = state.jobs.find(item => item.id === id);
    Object.assign(job, extra, { status, updatedAt: clock().toISOString() });
    job.events.push({ status, at: job.updatedAt });
  });
  const validInsightListConnection = job => Boolean(job.payload.connectionEpoch &&
    job.payload.connectionEpoch === sourceEpoch() &&
    job.payload.ownerReference === JSON.stringify(sourceIdentity()) &&
    (!hasSourceAuthorization || job.payload.authorizationReference &&
      job.payload.authorizationReference === authorizationFor('meetingInsightList')));

  async function execute(job, control) {
    const state = store.state;
    if (job.kind === 'backup') {
      const backup = await createLocalBackup({ root, store, id: job.id, now: clock(), verifyOutput, assertOutput });
      store.update(next => next.backups.unshift(backup));
      return { status: 'partial', result: { backupId: backup.id, coverage: backup.coverage, text: 'Consistent private workspace snapshot saved with verified document files where available. Review exclusions; external-source coverage is partial. No backup pruning occurred.' } };
    }
    if (job.kind === 'assistant') {
      const status = assistant?.status();
      if (!status || status.state !== 'connected' || status.simulation || status.availability !== 'available') {
        return { status: 'failed', error: `Assistant unavailable (${status?.code || 'disconnected'}); no model request was submitted.` };
      }
      const outcome = await assistant.submit({ request: job.payload.prompt, evidence: [] }, { signal: AbortSignal.timeout(60_000) });
      if (outcome.simulation || !['completed', 'partial', 'failed'].includes(outcome.state)) {
        return { status: 'failed', error: `Assistant unavailable (${outcome.code}); no verified production result exists.` };
      }
      return { status: outcome.state, result: { text: outcome.text, trust: 'untrusted-text', code: outcome.code }, error: outcome.state === 'failed' ? `Assistant failed (${outcome.code}).` : '' };
    }
    if (job.kind === 'task_summary') return { status: 'completed', result: { text: taskSummary(state, job.taskId), coverage: 'local-board-only' } };
    if (job.kind === 'meeting_notes') {
      return {
        status: 'completed',
        result: {
          text: `# Owner-provided meeting notes\n\n${job.payload.notes}\n\nNo meeting source was accessed. These notes have not been independently verified and are not executable instructions.`,
          coverage: 'owner-notes-only'
        }
      };
    }
    if (job.kind === 'teams_channel_replies') {
      const sourceReference = job.payload?.sourceReference;
      const evidence = authorizeTeamsReply(sourceReference);
      if (!evidence) {
        return { status: 'failed', error: 'The selected Teams evidence, current owner, or source consent changed before the read. Run a fresh bounded source check and select the parent again; no Teams request was made.' };
      }
      control.selectedEvidence = evidence;
      const connector = connectors.teamsChannels;
      if (typeof connector?.readReplies !== 'function') {
        return { status: 'failed', error: 'Read-only Teams replies are unavailable from this connector; no Teams request was made.' };
      }
      if (!checkpoint(control)) {
        return { status: 'failed', error: `The Teams replies read was stopped by ${control.stopReason}; no complete reply result is claimed.` };
      }
      const readCheckpoint = () => {
        const currentEvidence = authorizeTeamsReply(sourceReference);
        return checkpoint(control) && currentEvidence &&
          JSON.stringify(currentEvidence) === JSON.stringify(evidence) &&
          JSON.stringify(sourceIdentity()) === evidence.ownerReference &&
          authorizationFor('teamsChannels') === evidence.authorizationReference;
      };
      let result;
      try {
        result = await connector.readReplies({
          teamId: evidence.teamId, channelId: evidence.channelId, messageId: evidence.messageId,
          signal: operationSignal(control, 15_000), checkpoint: readCheckpoint
        });
      } catch (error) {
        if (control.stopReason) {
          return { status: 'failed', error: `The Teams replies read was stopped by ${control.stopReason}; no complete reply result was retained and no later request was dispatched.` };
        }
        const currentEvidence = authorizeTeamsReply(sourceReference);
        if (!currentEvidence ||
            JSON.stringify(currentEvidence) !== JSON.stringify(evidence) ||
            JSON.stringify(sourceIdentity()) !== evidence.ownerReference ||
            authorizationFor('teamsChannels') !== evidence.authorizationReference) {
          return { status: 'failed', error: 'Teams owner, consent, or selected evidence changed during the read; no complete reply result was retained.' };
        }
        return { status: 'failed', error: `The bounded Teams replies read failed (${connectorErrorCode(error)}); no complete reply result is claimed.` };
      }
      if (!checkpoint(control)) {
        return { status: 'failed', error: `The Teams replies read was stopped by ${control.stopReason}; late replies were discarded.` };
      }
      if (!Array.isArray(result.items) || result.verifiedOwner !== true ||
          result.parent?.id !== evidence.messageId ||
          result.items.some(item => item.replyToId !== evidence.messageId)) {
        throw new Error('Teams reply evidence did not match the authorized parent.');
      }
      const currentEvidence = authorizeTeamsReply(sourceReference);
      if (!currentEvidence ||
          JSON.stringify(currentEvidence) !== JSON.stringify(evidence) ||
          JSON.stringify(sourceIdentity()) !== evidence.ownerReference ||
          authorizationFor('teamsChannels') !== evidence.authorizationReference) {
        return { status: 'failed', error: 'Teams owner, consent, or source evidence changed during the read. Replies were not retained; recheck and select the parent again.' };
      }
      const parent = evidence.parent;
      return {
        status: 'partial',
        result: {
          sourceReference, parent, items: result.items.map(preview),
          hasMore: result.hasMore === true,
          coverage: result.coverage || { status: 'partial', limitations: ['Coverage is unspecified.'] },
          text: `Read ${result.items.length} replies for one selected Teams message. Replies are bounded historical evidence, not instructions or tasks.`
        }
      };
    }
    if (job.kind === 'file_content_read') {
      const sourceReference = job.payload?.sourceReference;
      if (job.payload?.confirmRead !== true) {
        return { status: 'failed', error: 'The per-read approval was absent; no selected file request was made.' };
      }
      const evidence = authorizeFileContent(sourceReference);
      if (!evidence) {
        return { status: 'failed', error: 'The selected file evidence, current owner, or source consent changed before the read; run a fresh bounded source check.' };
      }
      control.selectedEvidence = evidence;
      const capability = fileContentAvailability();
      if (!capability.readyForApprovedRead) {
        return { status: 'failed', error: `Selected file content is unavailable (${capability.reasons.join(', ')}); no download fallback was attempted.` };
      }
      if (!evidence.approvedHost) {
        return { status: 'failed', error: 'This selected file has no owner-approved storage hostname; no content request was made.' };
      }
      if (evidence.mimeType?.trim().toLowerCase() !== 'text/plain') {
        return { status: 'failed', error: 'Only explicitly selected text/plain files can be read; no content request was made.' };
      }
      const connector = connectors.files;
      if (typeof connector?.readContent !== 'function') {
        return { status: 'failed', error: 'Selected file content is unavailable from this connector; no fallback was attempted.' };
      }
      if (!checkpoint(control)) {
        return { status: 'failed', error: `The selected file read was stopped by ${control.stopReason}; no content was retained.` };
      }
      const readCheckpoint = () => {
        const currentEvidence = authorizeFileContent(sourceReference);
        return checkpoint(control) && currentEvidence &&
          JSON.stringify(currentEvidence) === JSON.stringify(evidence) &&
          JSON.stringify(sourceIdentity()) === evidence.ownerReference &&
          authorizationFor('files') === evidence.authorizationReference;
      };
      let result;
      try {
        result = await connector.readContent({
          driveId: evidence.driveId, itemId: evidence.itemId, approvedHost: evidence.approvedHost,
          expectedETag: evidence.eTag, expectedSize: evidence.size,
          confirmRead: true, signal: operationSignal(control, 30_000),
          checkpoint: readCheckpoint
        });
      } catch (error) {
        if (control.stopReason) {
          return { status: 'failed', error: `The selected file read was stopped by ${control.stopReason}; no content was retained and no later request was dispatched.` };
        }
        const currentEvidence = authorizeFileContent(sourceReference);
        if (!currentEvidence ||
            JSON.stringify(currentEvidence) !== JSON.stringify(evidence) ||
            JSON.stringify(sourceIdentity()) !== evidence.ownerReference ||
            authorizationFor('files') !== evidence.authorizationReference) {
          return { status: 'failed', error: 'The selected file owner, consent, or source evidence changed during the read; no content was retained.' };
        }
        return { status: 'failed', error: `Selected file content is unavailable (${connectorErrorCode(error)}); no fallback was attempted.` };
      }
      if (!checkpoint(control)) {
        return { status: 'failed', error: `The selected file read was stopped by ${control.stopReason}; late content was discarded.` };
      }
      if (!Array.isArray(result.items) || result.items.length !== 1 || result.verifiedOwner !== true) {
        throw new Error('Selected file read returned invalid or unverified evidence.');
      }
      const file = result.items[0];
      if (file.driveId !== evidence.driveId || file.id !== evidence.itemId ||
          file.contentAvailable !== true || file.contentType !== 'text/plain' ||
          file.mimeType?.trim().toLowerCase() !== 'text/plain' ||
          file.eTag !== evidence.eTag || file.size !== evidence.size ||
          typeof file.content !== 'string' ||
          Buffer.byteLength(file.content, 'utf8') > MAX_FILE_CONTENT_BYTES) {
        throw new Error('Selected file content did not match the authorized bounded read.');
      }
      const currentEvidence = authorizeFileContent(sourceReference);
      if (!currentEvidence ||
          JSON.stringify(currentEvidence) !== JSON.stringify(evidence) ||
          JSON.stringify(sourceIdentity()) !== evidence.ownerReference ||
          authorizationFor('files') !== evidence.authorizationReference) {
        return { status: 'failed', error: 'The selected file owner, consent, or source evidence changed during the read; content was discarded.' };
      }
      const limitations = [
        ...(Array.isArray(result.coverage?.limitations) ? result.coverage.limitations : []),
        'Only this exact selected file was read; no folder, library, or drive coverage is implied.'
      ];
      return {
        status: 'partial',
        result: {
          sourceReference, file: {
            title: file.name, webLink: file.webLink, lastModifiedDateTime: file.lastModifiedDateTime,
            eTag: file.eTag, mimeType: 'text/plain', provenance: file.provenance,
            trust: 'untrusted-evidence', byteLength: Buffer.byteLength(file.content, 'utf8')
          },
          content: file.content, contentType: 'text/plain', trust: 'untrusted-evidence',
          coverage: { ...(result.coverage || {}), status: 'partial', limitations },
          text: 'One explicitly approved text/plain file was read and retained locally as untrusted evidence. No broader synchronization, upload, or task inference occurred.'
        }
      };
    }
    if (job.kind === 'meeting_insight_list') {
      if (!validInsightListConnection(job) || !insightListConnector) {
        return { status: 'failed', error: 'The authorized connection changed. Select and consent to a new list request.' };
      }
      const authorizationReference = authorizationFor('meetingInsightList');
      control.listAuthorization = authorizationReference;
      if (hasSourceAuthorization && !authorizationReference) {
        return { status: 'failed', error: 'Current meeting-list consent is unavailable; no read was started.' };
      }
      const readCheckpoint = () => checkpoint(control) && validInsightListConnection(job) &&
        (!hasSourceAuthorization || authorizationReference === authorizationFor('meetingInsightList'));
      const reportList = (status, coverage, inspected = 0) => onSourceResult({
        jobId: job.id, source: 'meetingInsightList', status, coverage,
        ownerReference: job.payload.ownerReference, authorizationReference,
        inspected, at: clock().toISOString()
      });
      reportList('running');
      try {
        const result = await insightListConnector.read({
          meetingId: job.payload.meetingId, signal: operationSignal(control, 15_000), checkpoint: readCheckpoint
        });
        if (!checkpoint(control)) {
          reportList('deferred');
          return { status: 'failed', error: `The meeting insight list was stopped by ${control.stopReason}; late metadata was discarded.` };
        }
        if (!validInsightListConnection(job) ||
            (hasSourceAuthorization && authorizationReference !== authorizationFor('meetingInsightList')) ||
            result.verifiedOwner !== true || !Array.isArray(result.items)) {
          reportList('failed');
          return { status: 'failed', error: 'The authorized connection changed or the list could not be verified. No result was retained.' };
        }
        reportList('partial', result.coverage, result.items.length);
        return {
          status: 'partial',
          result: {
            text: 'First-page metadata only. This does not authorize or initiate any detail read.',
            meetingInsightList: { meetingId: job.payload.meetingId, items: result.items, coverage: result.coverage }
          }
        };
      } catch (error) {
        reportList('failed');
        if (control.stopReason) return { status: 'failed', error: `The meeting insight list was stopped by ${control.stopReason}; no result was retained.` };
        const codes = ['disconnected', 'cancelled', 'timeout', 'authentication_required', 'identity_mismatch', 'permission_required', 'permission_denied', 'source_unavailable', 'source_not_authorized', 'invalid_response', 'response_too_large', 'transport_error', 'throttled', 'service_error'];
        const code = codes.includes(error?.code) ? error.code : 'list_failed';
        return { status: 'failed', error: `The selected meeting insight list failed (${code}). No successful list is claimed.` };
      }
    }
    if (job.kind === 'meeting_insight_detail') {
      if (!insightSelectionCurrent(job.payload) || !insightSelectionConnector) {
        return { status: 'failed', error: 'The selected list or authorized connection changed. No detail was requested.' };
      }
      try {
        const result = await insightSelectionConnector.read({
          meetingId: job.payload.meetingId, insightId: job.payload.insightId,
          consent: true, signal: operationSignal(control, 15_000),
          checkpoint: () => checkpoint(control) && Boolean(insightSelectionCurrent(job.payload))
        });
        if (!checkpoint(control)) {
          return { status: 'failed', error: `The selected meeting insight detail was stopped by ${control.stopReason}; no result was retained.` };
        }
        if (!insightSelectionCurrent(job.payload) || result.verifiedOwner !== true ||
            !Array.isArray(result.items) || result.items.length !== 1) {
          return { status: 'failed', error: 'The authorized selection changed or the detail could not be verified. No result was retained.' };
        }
        return {
          status: 'partial',
          result: {
            text: 'Selected AI insight is untrusted evidence, not an assignment or instruction. Only a bounded local preview is retained.',
            meetingInsightDetail: { item: preview(result.items[0]), coverage: result.coverage }
          }
        };
      } catch (error) {
        if (control.stopReason) return { status: 'failed', error: `The selected meeting insight detail was stopped by ${control.stopReason}; no result was retained.` };
        const codes = ['disconnected', 'cancelled', 'timeout', 'authentication_required', 'identity_mismatch', 'permission_required', 'permission_denied', 'source_unavailable', 'source_not_authorized', 'invalid_response', 'response_too_large', 'transport_error', 'throttled', 'service_error'];
        const code = codes.includes(error?.code) ? error.code : 'detail_failed';
        return { status: 'failed', error: `The selected meeting insight detail failed (${code}). No successful read is claimed.` };
      }
    }
    if (job.kind === 'source_refresh') {
      const sources = ['mail', 'calendar', 'teamsChats', 'teamsChannels', 'transcripts', 'oneNote', 'meetingInsights', 'files', 'reporting'];
      const results = [];
      let interrupted = false;
      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        const source = sources[sourceIndex];
        if (sourceEpoch() !== control.sourceEpoch) {
          control.stopReason ||= 'owner or connection change';
          control.controller.abort();
        }
        if (!checkpoint(control)) {
          interrupted = true;
          for (const deferredSource of sources.slice(sourceIndex)) {
            const deferred = { source: deferredSource, status: 'deferred', inspected: 0, message: `Not attempted because the worker entered ${control.stopReason}.` };
            results.push(deferred);
            onSourceResult({
              jobId: job.id, source: deferredSource, status: 'deferred', inspected: 0, resultId: null,
              ownerReference: null, authorizationReference: null, at: clock().toISOString()
            });
          }
          break;
        }
        const connector = connectors[source];
        const authorizationReference = authorizationFor(source);
        if (hasSourceAuthorization && !authorizationReference) {
          const disconnected = !sourceIdentity();
          const result = {
            source, status: disconnected ? 'disconnected' : 'unavailable', inspected: 0,
            message: `Current owner and explicit ${source} selection could not be verified; no read was attempted.`
          };
          results.push(result);
          onSourceResult({ jobId: job.id, source, status: result.status, inspected: 0, resultId: null, ownerReference: null, authorizationReference: null, at: clock().toISOString() });
          continue;
        }
        if (!connector) {
          const result = { source, status: 'disconnected', inspected: 0 };
          results.push(result);
          onSourceResult({ jobId: job.id, source, status: result.status, inspected: 0, resultId: null, ownerReference: null, authorizationReference, at: clock().toISOString() });
          continue;
        }
        const ownerReference = JSON.stringify(sourceIdentity());
        const sourceStillCurrent = () => sourceEpoch() === control.sourceEpoch &&
          ownerReference === JSON.stringify(sourceIdentity()) &&
          (!hasSourceAuthorization || authorizationReference === authorizationFor(source));
        const readCheckpoint = () => checkpoint(control) && sourceStillCurrent();
        try {
          const end = clock();
          const window = source === 'mail'
            ? { startDateTime: new Date(end.valueOf() - 14 * 86400_000).toISOString(), endDateTime: end.toISOString() }
            : source === 'calendar' ? { startDateTime: end.toISOString(), endDateTime: new Date(end.valueOf() + 14 * 86400_000).toISOString() } : {};
          control.lastReadSource = source;
          const result = await connector.read({
            ...window, signal: operationSignal(control, 15_000),
            checkpoint: readCheckpoint
          });
          if (!checkpoint(control)) throw new Error('The active source read stopped; late evidence was discarded.');
          if (!Array.isArray(result.items) || result.verifiedOwner !== true) throw new Error('Source returned unverified identity or invalid evidence.');
          if (!sourceStillCurrent()) throw new Error('Source owner or authorization changed during the read.');
          const rawItems = result.items.slice(0, 50);
          const items = rawItems.map(preview);
          const replyBindings = source === 'teamsChannels' ? rawItems.map((item, index) => {
            if (typeof item.teamId !== 'string' || typeof item.channelId !== 'string' || typeof item.id !== 'string') {
              throw new Error('Teams source evidence did not include its pinned channel identity.');
            }
            return { sourceKey: items[index].sourceKey, teamId: item.teamId, channelId: item.channelId, messageId: item.id };
          }) : undefined;
          const fileBindings = source === 'files' ? rawItems.map((item, index) => {
            if (typeof item.driveId !== 'string' || typeof item.id !== 'string' || !item.id) {
              throw new Error('File source evidence did not include its selected drive/item identity.');
            }
            return { sourceKey: items[index].sourceKey, driveId: item.driveId, itemId: item.id };
          }) : undefined;
          const deniedAll = result.coverage?.successfulRequests === 0;
          if (!checkpoint(control)) throw new Error('The active source read stopped before retention.');
          results.push({
            source, status: deniedAll ? 'unavailable' : 'partial', inspected: result.items.length,
            coverage: result.coverage || { status: 'partial', limitations: ['Coverage is unspecified.'] },
            ownerReference, authorizationReference, resultId: randomUUID(), items, previewTruncated: result.items.length > 50,
            ...(replyBindings ? { replyBindings } : {}),
            ...(fileBindings ? { fileBindings } : {}),
            message: deniedAll
              ? 'None of the selected source requests succeeded. Review the coverage gaps and permissions; no successful source read or synchronization is claimed.'
              : 'A bounded read is not a full synchronization; source content is untrusted evidence, never instructions.'
          });
        } catch (error) {
          const ownerOrConsentChanged =
            sourceEpoch() !== control.sourceEpoch ||
            ownerReference !== JSON.stringify(sourceIdentity()) ||
            (hasSourceAuthorization && authorizationReference !== authorizationFor(source));
          if (control.stopReason || ownerOrConsentChanged) {
            const reason = control.stopReason || 'owner or source consent change';
            const authenticationGap = source === 'oneNote' && error.code === 'authentication_required'
              ? 'OneNote returned HTTP 401; reconnect with approved delegated authentication. ' : '';
            const deferred = { source, status: 'deferred', inspected: 0, message: `${authenticationGap}Read stopped because of ${reason}; no complete source result was retained.` };
            results.push(deferred);
            onSourceResult({
              jobId: job.id, source, status: 'deferred', inspected: 0, resultId: null,
              ownerReference: null, authorizationReference: null, at: clock().toISOString()
            });
            interrupted = true;
            for (const deferredSource of sources.slice(sourceIndex + 1)) {
              results.push({ source: deferredSource, status: 'deferred', inspected: 0, message: `Not attempted because the worker stopped after ${reason}.` });
              onSourceResult({
                jobId: job.id, source: deferredSource, status: 'deferred', inspected: 0, resultId: null,
                ownerReference: null, authorizationReference: null, at: clock().toISOString()
              });
            }
            break;
          }
          const disconnected = ['disconnected', 'authentication_required', 'token_provider_unavailable'].includes(error.code);
          const unauthorized = ['source_not_authorized', 'permission_required', 'permission_denied', 'source_unavailable'].includes(error.code);
          const message = source === 'oneNote' && error.code === 'authentication_required'
            ? 'OneNote returned HTTP 401 or current-owner verification failed. Reconnect with this same owner account and approve delegated Notes.Read; no page content is claimed.'
            : 'Read unavailable, failed, or identity could not be verified. Check source consent and authentication; no successful scan is claimed.';
          results.push({ source, status: disconnected ? 'disconnected' : unauthorized ? 'unavailable' : 'failed', inspected: 0, message });
        }
        if (interrupted) break;
        const result = results.at(-1);
        onSourceResult({
          jobId: job.id, source, status: result.status, inspected: result.inspected,
          resultId: result.resultId || null, ownerReference: result.ownerReference || null,
          coverageStatus: result.coverage?.status,
          coverage: result.coverage,
          authorizationReference: result.authorizationReference || null, at: clock().toISOString()
        });
      }
      return {
        status: results.some(result => result.status === 'partial') ? 'partial' : 'failed',
        result: { sources: results, text: interrupted ? `Source checks stopped by ${control.stopReason || 'an owner or consent change'}; no later source request was dispatched.` : 'Source attempts finished; no task discovery or full source coverage is claimed.' },
        error: interrupted ? `Source checks stopped by ${control.stopReason || 'an owner or consent change'}; the remaining sources were not read.` :
          results.every(result => ['disconnected', 'unavailable'].includes(result.status)) ? 'All external sources are disconnected or unavailable.' : ''
      };
    }
    if (job.kind === 'document' || job.kind === 'word_document' || job.kind === 'fake_demo') {
      const demo = job.kind === 'fake_demo';
      const word = job.kind === 'word_document';
      const format = word ? 'docx' : demo ? job.payload.format : 'markdown';
      if ((!demo && !['markdown', 'docx'].includes(format)) || (demo && !['markdown', 'pptx'].includes(format))) {
        return { status: 'failed', error: 'The local document format is missing or unsupported; no file was created.' };
      }
      const assertApprovals = () => {
        if (!store.state.preferences.localOutputApproved) throw new Error('Local output approval is absent or has been revoked.');
        if (demo && (!store.state.preferences.demoApproved || job.payload.confirmFakeOnly !== true || job.taskId || !['markdown', 'pptx'].includes(job.payload.format))) {
          throw new Error('Synthetic local demo approval or exact format selection is absent or has been revoked.');
        }
      };
      const documentId = job.id;
      const assertDocumentIdAvailable = () => {
        const existing = store.state.documents.find(item => item.id === documentId);
        if (existing && (existing.format || 'markdown') !== format) {
          throw documentIdConflict(`This job ID is already recorded for ${existing.format || 'markdown'}; no ${format} document was created.`);
        }
        if ((store.state.outcomeExportRequests || []).some(item => item.requestId === documentId)) {
          throw documentIdConflict('This job ID is reserved by an unresolved XLSX export; no worker document was created.');
        }
      };
      assertApprovals();
      assertDocumentIdAvailable();
      await verifyOutput();
      assertDocumentIdAvailable();
      const outputDir = join(root, 'documents');
      assertApprovals();
      mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      if ((await lstat(outputDir)).isSymbolicLink() || await realpath(outputDir) !== outputDir) {
        throw new Error('Local document directory must not redirect outside the workspace.');
      }
      assertDocumentIdAvailable();
      const path = join(outputDir, documentFileName({ id: documentId, format }));
      // Do not yield between checking approvals and creating the file.
      assertApprovals();
      assertDocumentIdAvailable();
      const text = demo
        ? '# FAKE DATA ONLY - Local demo\n\nThis fixed synthetic example is not customer or production data.\n\n| Account | Contact | Sample status |\n| --- | --- | --- |\n| Example North | north@example.invalid | Fictional |\n| Example South | south@example.invalid | Fictional |\n\nNo cloud resources or repositories were created. No secrets are included.\n'
        : taskSummary(store.state, job.taskId);
      const content = word ? createWordTaskSummary(store.state.tasks, job.taskId)
        : demo && format === 'pptx' ? createFakeDemoPptx() : Buffer.from(text, 'utf8');
      const existingDocument = store.state.documents.find(item => item.id === documentId);
      if (existingDocument && format !== 'markdown' &&
          (!Number.isSafeInteger(existingDocument.contentBytes) || existingDocument.contentBytes < 1 ||
            existingDocument.contentBytes > MAX_LOCAL_DOCUMENT_BYTES ||
            !/^[0-9a-f]{64}$/.test(existingDocument.contentSha256 || ''))) {
        throw new Error('The existing binary document has no valid bounded generation record; it was not reused.');
      }
      let descriptor;
      try { descriptor = openSync(path, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      if (descriptor !== undefined) {
        try { await writeOpenFile(descriptor, content); }
        finally { closeSync(descriptor); }
      }
      let saved;
      if (format === 'docx' || format === 'pptx') {
        const rootMetadata = await lstat(root, { bigint: true });
        if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() ||
            await realpath(root) !== root || !await verifyLocalVolume(root)) {
          throw new Error('The binary document workspace volume could not be verified.');
        }
        saved = await readVerifiedLocalFile(path, { limit: MAX_LOCAL_DOCUMENT_BYTES, volume: rootMetadata.dev });
      } else {
        await assertPlainLocalFile(path);
        saved = await readFile(path);
      }
      if (!saved.equals(content)) throw new Error('The existing document differs; it was not overwritten.');
      if (existingDocument && format !== 'markdown' &&
          (saved.length !== existingDocument.contentBytes ||
            createHash('sha256').update(saved).digest('hex') !== existingDocument.contentSha256)) {
        throw new Error('The existing binary document differs from its verified generation record; it was not reused.');
      }
      assertDocumentIdAvailable();
      store.update(next => {
        const existing = next.documents.find(item => item.id === documentId);
        if (existing && (existing.format || 'markdown') !== format) {
          throw documentIdConflict(`A ${format} file was created but its ID became reserved for ${existing.format || 'markdown'} before its document record could be saved. The file remains untracked for inspection.`, true);
        }
        if ((next.outcomeExportRequests || []).some(item => item.requestId === documentId)) {
          throw documentIdConflict('A worker file was created but its ID became reserved by an XLSX export before its document record could be saved. The file remains untracked for inspection.', true);
        }
        if (!existing) {
          next.documents.unshift({
            id: documentId, title: demo ? `Fake-only local demo (${format === 'pptx' ? 'PowerPoint' : 'Markdown'})` : `Local ${word ? 'Word ' : ''}task summary`,
            format, createdAt: clock().toISOString(),
            contentSha256: createHash('sha256').update(content).digest('hex'), contentBytes: content.length
          });
        }
      });
      return { status: 'completed', result: { documentId, format, text: demo
        ? format === 'pptx'
          ? 'Saved a fixed fake-only PowerPoint with synthetic speaker notes. The package contains no external relationships, linked media, hyperlinks, macros, or embedded objects; it was not visually rendered.'
          : 'Saved a fixed fake-only Markdown demo. No cloud resources or repositories were created.'
        : word ? 'Saved a local Word task summary. No upload or sharing occurred.'
          : 'Saved a local Markdown task summary. No upload or sharing occurred.', coverage: demo ? 'synthetic-only' : 'local-board-only' } };
    }
    throw new Error('Unsupported job kind.');
  }

  async function runTick() {
    const now = clock();
    if (stopping || store.state.preferences.paused || quietHoursActive(store.state.preferences, store.state.profile.timezone, now)) return;
    const state = store.state;
    const available = timezoneAvailable(state.profile.timezone);
    const backupDay = available
      ? backupWindowDay(state.profile.timezone, now)
      : null;
    const lastWindow = backupDay ? lastBackupWindow(state.scheduler, state.profile.timezone) : null;
    if (state.preferences.dailyBackups && backupDay && (!lastWindow || lastWindow < backupDay) &&
        !state.jobs.some(job => job.kind === 'backup' && ['queued', 'running'].includes(job.status))) {
      store.update(next => {
        enqueue(next, { kind: 'backup', requestId: randomUUID(), origin: 'schedule' }, now);
        next.scheduler.lastBackupDay = backupDay;
        next.scheduler.lastBackupAttemptAt = now.toISOString();
      });
    }
    const elapsed = now.valueOf() - Date.parse(state.scheduler.lastRefreshAt || '1970-01-01');
    if (available && state.preferences.automaticRefresh && elapsed >= 30 * 60_000 && !state.jobs.some(job => job.kind === 'source_refresh' && ['queued', 'running'].includes(job.status))) {
      store.update(next => {
        enqueue(next, { kind: 'source_refresh', requestId: randomUUID(), origin: 'schedule' }, clock());
        next.scheduler.lastRefreshAt = clock().toISOString();
      });
    }
    const job = [...store.state.jobs].reverse().find(item => item.status === 'queued' &&
      (available || item.origin !== 'schedule' || !['backup', 'source_refresh'].includes(item.kind)));
    if (!job) return;
    const control = { controller: new AbortController(), stopReason: null, sourceEpoch: sourceEpoch() };
    currentControl = control;
    const monitor = setInterval(() => checkpoint(control), 25);
    monitor.unref();
    transition(job.id, 'running', { attempts: job.attempts + 1, error: '' });
    if (job.kind === 'backup') store.update(next => {
      const attemptAt = clock();
      const validTimezone = timezoneAvailable(next.profile.timezone);
      const attemptDay = validTimezone ? backupWindowDay(next.profile.timezone, attemptAt) : null;
      const previousDay = validTimezone ? lastBackupWindow(next.scheduler, next.profile.timezone) : null;
      const previousTime = Date.parse(next.scheduler.lastBackupAttemptAt);
      if ((!next.scheduler.lastBackupDay || validTimezone || Number.isFinite(previousTime)) &&
          (!attemptDay || !previousDay || attemptDay >= previousDay) &&
          (!Number.isFinite(previousTime) || attemptAt.valueOf() >= previousTime)) {
        if (validTimezone) next.scheduler.lastBackupDay = attemptDay;
        next.scheduler.lastBackupAttemptAt = attemptAt.toISOString();
      }
    });
    try {
      const outcome = !checkpoint(control)
        ? { status: 'failed', error: `The operation was stopped by ${control.stopReason}; no new work was dispatched.` }
        : await execute(job, control);
      if (['meeting_insight_list', 'meeting_insight_detail', 'teams_channel_replies', 'file_content_read'].includes(job.kind) && !checkpoint(control)) {
        if (job.kind === 'meeting_insight_list') onSourceResult({
          jobId: job.id, source: 'meetingInsightList', status: 'deferred', inspected: 0,
          ownerReference: null, authorizationReference: null, at: clock().toISOString()
        });
        transition(job.id, 'failed', { result: null, error: `The source operation was stopped by ${control.stopReason}; no late result was retained.` });
        return;
      }
      if (outcome.result && ['teams_channel_replies', 'file_content_read'].includes(job.kind)) {
        const evidence = job.kind === 'file_content_read'
          ? authorizeFileContent(job.payload.sourceReference) : authorizeTeamsReply(job.payload.sourceReference);
        const source = job.kind === 'file_content_read' ? 'files' : 'teamsChannels';
        if (!evidence || JSON.stringify(evidence) !== JSON.stringify(control.selectedEvidence) ||
            sourceEpoch() !== control.sourceEpoch || JSON.stringify(sourceIdentity()) !== evidence.ownerReference ||
            authorizationFor(source) !== evidence.authorizationReference) {
          transition(job.id, 'failed', { result: null, error: 'The current owner, consent or selected evidence changed; no result was retained.' });
          return;
        }
      }
      if (job.kind === 'meeting_insight_list' && (!validInsightListConnection(job) ||
          (hasSourceAuthorization && (!control.listAuthorization ||
            control.listAuthorization !== authorizationFor('meetingInsightList'))))) {
        onSourceResult({
          jobId: job.id, source: 'meetingInsightList', status: 'deferred', inspected: 0,
          ownerReference: null, authorizationReference: null, at: clock().toISOString()
        });
        transition(job.id, 'failed', { result: null, error: 'The authorized connection changed. No list result was retained.' });
        return;
      }
      if (job.kind === 'source_refresh' && outcome.result?.sources) {
        let discarded = false;
        outcome.result.sources = outcome.result.sources.map(result => {
          if (!result.ownerReference) return result;
          const stoppedRead = result.source === control.lastReadSource && !checkpoint(control);
          if (!stoppedRead && sourceEpoch() === control.sourceEpoch &&
              result.ownerReference === JSON.stringify(sourceIdentity()) &&
              (!hasSourceAuthorization || result.authorizationReference === authorizationFor(result.source))) return result;
          discarded = true;
          const deferred = {
            source: result.source, status: 'deferred', inspected: 0,
            message: stoppedRead ? `The active source stopped by ${control.stopReason} before retention; late evidence was discarded.`
              : 'Owner, connection or source consent changed before retention; stale evidence was discarded.'
          };
          onSourceResult({ ...deferred, jobId: job.id, ownerReference: null, authorizationReference: null, at: clock().toISOString() });
          return deferred;
        });
        if (discarded) {
          outcome.status = outcome.result.sources.some(result => result.status === 'partial') ? 'partial' : 'failed';
          outcome.error = 'Source retention checks rejected stale or stopped evidence; no rejected result was retained.';
          outcome.result.text = outcome.error;
        }
      }
      if (job.kind === 'meeting_insight_detail' && !insightSelectionCurrent(job.payload)) {
        transition(job.id, 'failed', { result: null, error: 'The selected list or authorized connection changed. No detail result was retained.' });
        return;
      }
      transition(job.id, outcome.status, { result: outcome.result, error: outcome.error || '' });
      if (job.taskId) store.update(next => next.conversations.push({
        id: randomUUID(), taskId: job.taskId, role: 'system', kind: 'job-result', jobId: job.id,
        text: outcome.result?.text || outcome.error || 'Job finished.', createdAt: clock().toISOString()
      }));
    } catch (error) {
      console.error('[esquie] worker operation failed; no source content or provider error was logged.');
      const errorMessage = error instanceof InvalidWordTextError ? error.message
        : error?.code === 'local_document_untracked'
        ? 'A local output file was created, but a cross-format ID collision prevented its receipt from being saved. The file remains untracked for inspection; do not retry blindly.'
        : error?.code === 'local_document_id_collision'
          ? 'The document ID conflicts with another local output; no new file was created.'
          : job.kind === 'backup'
            ? 'Private backup was blocked or failed. Check output approval, private local storage and volume eligibility. Existing workspace/backups were preserved; no pruning or cloud fallback occurred.'
            : ['document', 'word_document', 'fake_demo'].includes(job.kind)
              ? 'Local file output was blocked or failed. Check output approval, destination containment and fixed-volume verification in Operations; no cloud fallback was used.'
              : 'The local operation failed. Existing state was preserved; inspect host diagnostics before retrying.';
      transition(job.id, 'failed', { error: errorMessage });
    } finally {
      clearInterval(monitor);
      if (currentControl === control) currentControl = null;
    }
  }
  function tick() {
    if (!current) current = runTick().finally(() => { current = null; });
    return current;
  }
  const timer = intervalMs > 0 ? setInterval(() => tick().catch(error => {
    console.error('[esquie] worker tick failed; no source content or provider error was logged.');
  }), intervalMs) : null;
  timer?.unref();
  return {
    tick,
    cancelCurrent,
    async stop() {
      stopping = true;
      cancelCurrent('shutdown');
      if (timer) clearInterval(timer);
      if (current) await current;
    }
  };
}
