import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertPlainLocalFile } from './local-output.mjs';
import { createLocalBackup } from './backups.mjs';

export function quietHoursActive(preferences, timezone, now = new Date()) {
  if (!preferences.quietStart || !preferences.quietEnd) return false;
  if (!timezone) return true;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const time = `${parts.find(part => part.type === 'hour').value}:${parts.find(part => part.type === 'minute').value}`;
  const { quietStart, quietEnd } = preferences;
  if (quietStart === quietEnd) return true;
  return quietStart < quietEnd ? time >= quietStart && time < quietEnd : time >= quietStart || time < quietEnd;
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
    url, contentAvailable: item.contentAvailable !== false, trust: 'untrusted-evidence'
  };
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

export function createWorker({ store, root, connectors = {}, assistant, sourceIdentity = () => null, onSourceResult = () => {}, clock = () => new Date(), intervalMs = 1000, verifyOutput }) {
  let stopping = false;
  let current = null;
  const transition = (id, status, extra = {}) => store.update(state => {
    const job = state.jobs.find(item => item.id === id);
    Object.assign(job, extra, { status, updatedAt: clock().toISOString() });
    job.events.push({ status, at: job.updatedAt });
  });

  async function execute(job) {
    const state = store.state;
    if (job.kind === 'backup') {
      const backup = await createLocalBackup({ root, store, id: job.id, now: clock(), verifyOutput });
      store.update(next => next.backups.unshift(backup));
      return { status: 'partial', result: { backupId: backup.id, coverage: backup.coverage, text: 'Consistent private workspace snapshot saved. Document files are excluded and external-source coverage is partial. No backup pruning occurred.' } };
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
    if (job.kind === 'source_refresh') {
      const sources = ['mail', 'calendar', 'teamsChats', 'teamsChannels', 'transcripts', 'files', 'reporting'];
      const results = [];
      for (const source of sources) {
        const connector = connectors[source];
        if (!connector) { results.push({ source, status: 'disconnected', inspected: 0 }); continue; }
        try {
          const end = clock();
          const window = source === 'mail'
            ? { startDateTime: new Date(end.valueOf() - 14 * 86400_000).toISOString(), endDateTime: end.toISOString() }
            : source === 'calendar' ? { startDateTime: end.toISOString(), endDateTime: new Date(end.valueOf() + 14 * 86400_000).toISOString() } : {};
          const ownerReference = JSON.stringify(sourceIdentity());
          const result = await connector.read({ ...window, signal: AbortSignal.timeout(15_000) });
          if (!Array.isArray(result.items) || result.verifiedOwner !== true) throw new Error('Source returned unverified identity or invalid evidence.');
          if (ownerReference !== JSON.stringify(sourceIdentity())) throw new Error('Source owner changed during the read.');
          results.push({
            source, status: 'partial', inspected: result.items.length,
            coverage: result.coverage || { status: 'partial', limitations: ['Coverage is unspecified.'] },
            ownerReference, items: result.items.slice(0, 50).map(preview), previewTruncated: result.items.length > 50,
            message: 'A bounded read is not a full synchronization; source content is untrusted evidence, never instructions.'
          });
        } catch (error) {
          const disconnected = ['disconnected', 'authentication_required', 'token_provider_unavailable'].includes(error.code);
          const unauthorized = ['source_not_authorized', 'permission_required', 'permission_denied', 'source_unavailable'].includes(error.code);
          results.push({ source, status: disconnected ? 'disconnected' : unauthorized ? 'unavailable' : 'failed', inspected: 0, message: 'Read unavailable, failed, or identity could not be verified. Check source consent and authentication; no successful scan is claimed.' });
        }
        const result = results.at(-1);
        onSourceResult({ source, status: result.status, inspected: result.inspected, ownerReference: result.ownerReference, at: clock().toISOString() });
      }
      return { status: results.some(result => result.status === 'partial') ? 'partial' : 'failed', result: { sources: results, text: 'Source attempts finished; no task discovery or full source coverage is claimed.' }, error: results.every(result => result.status === 'disconnected') ? 'All external sources are disconnected.' : '' };
    }
    if (job.kind === 'document' || job.kind === 'fake_demo') {
      if (job.kind === 'fake_demo' && (!store.state.preferences.demoApproved || job.payload.confirmFakeOnly !== true || job.taskId)) {
        throw new Error('Synthetic local demo approval is absent or has been revoked.');
      }
      await verifyOutput();
      const documentId = job.id;
      const demo = job.kind === 'fake_demo';
      const text = demo
        ? '# FAKE DATA ONLY - Local demo\n\nThis fixed synthetic example is not customer or production data.\n\n| Account | Contact | Sample status |\n| --- | --- | --- |\n| Example North | north@example.invalid | Fictional |\n| Example South | south@example.invalid | Fictional |\n\nNo cloud resources or repositories were created. No secrets are included.\n'
        : taskSummary(state, job.taskId);
      const outputDir = join(root, 'documents');
      await mkdir(outputDir, { recursive: true, mode: 0o700 });
      if ((await lstat(outputDir)).isSymbolicLink() || await realpath(outputDir) !== outputDir) {
        throw new Error('Local document directory must not redirect outside the workspace.');
      }
      const path = join(outputDir, `${documentId}.md`);
      try { await writeFile(path, text, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await assertPlainLocalFile(path);
        if (await readFile(path, 'utf8') !== text) throw new Error('The existing document differs; it was not overwritten.');
      }
      store.update(next => {
        if (!next.documents.some(item => item.id === documentId)) {
          next.documents.unshift({ id: documentId, title: demo ? 'Fake-only local demo' : 'Local task summary', createdAt: clock().toISOString() });
        }
      });
      return { status: 'completed', result: { documentId, text: demo ? 'Saved a fixed fake-only local demo. No cloud resources or repositories were created.' : 'Saved a local Markdown task summary. No upload or sharing occurred.', coverage: demo ? 'synthetic-only' : 'local-board-only' } };
    }
    throw new Error('Unsupported job kind.');
  }

  async function runTick() {
    if (stopping || store.state.preferences.paused || quietHoursActive(store.state.preferences, store.state.profile.timezone, clock())) return;
    const state = store.state;
    const backupDay = state.profile.timezone
      ? new Intl.DateTimeFormat('en-CA', { timeZone: state.profile.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(clock())
      : null;
    if (state.preferences.dailyBackups && backupDay && state.scheduler.lastBackupDay !== backupDay &&
        !state.jobs.some(job => job.kind === 'backup' && ['queued', 'running'].includes(job.status))) {
      store.update(next => {
        enqueue(next, { kind: 'backup', requestId: randomUUID(), origin: 'schedule' }, clock());
        next.scheduler.lastBackupDay = backupDay;
        next.scheduler.lastBackupAttemptAt = clock().toISOString();
      });
    }
    const elapsed = clock().valueOf() - Date.parse(state.scheduler.lastRefreshAt || '1970-01-01');
    if (state.preferences.automaticRefresh && elapsed >= 30 * 60_000 && !state.jobs.some(job => job.kind === 'source_refresh' && ['queued', 'running'].includes(job.status))) {
      store.update(next => {
        enqueue(next, { kind: 'source_refresh', requestId: randomUUID(), origin: 'schedule' }, clock());
        next.scheduler.lastRefreshAt = clock().toISOString();
      });
    }
    const job = [...store.state.jobs].reverse().find(item => item.status === 'queued');
    if (!job) return;
    transition(job.id, 'running', { attempts: job.attempts + 1, error: '' });
    if (job.kind === 'backup') store.update(next => {
      next.scheduler.lastBackupDay = backupDay;
      next.scheduler.lastBackupAttemptAt = clock().toISOString();
    });
    try {
      const outcome = await execute(job);
      transition(job.id, outcome.status, { result: outcome.result, error: outcome.error || '' });
      if (job.taskId) store.update(next => next.conversations.push({
        id: randomUUID(), taskId: job.taskId, role: 'system', kind: 'job-result', jobId: job.id,
        text: outcome.result?.text || outcome.error || 'Job finished.', createdAt: clock().toISOString()
      }));
    } catch (error) {
      console.error('[esquie] worker operation failed; no source content or provider error was logged.');
      transition(job.id, 'failed', { error: job.kind === 'backup' ? 'Private backup was blocked or failed. Check output approval, private local storage and volume eligibility. Existing workspace/backups were preserved; no pruning or cloud fallback occurred.' : ['document', 'fake_demo'].includes(job.kind) ? 'Local file output was blocked or failed. Check output approval, destination containment and fixed-volume verification in Operations; no cloud fallback was used.' : 'The local operation failed. Existing state was preserved; inspect host diagnostics before retrying.' });
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
    async stop() { stopping = true; if (timer) clearInterval(timer); if (current) await current; }
  };
}
