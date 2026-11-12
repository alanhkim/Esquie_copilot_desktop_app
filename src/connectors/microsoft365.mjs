const GRAPH = 'https://graph.microsoft.com/v1.0';
const DAY = 86_400_000;
const MAX_BYTES = 1_048_576;
const MESSAGE_FIELDS = 'id,subject,webLink,conversationId,isDraft,receivedDateTime,from,toRecipients,ccRecipients,replyTo,body';
const READ_PATHS = [
  /^\/me$/,
  /^\/me\/mailFolders\/inbox\/messages$/,
  /^\/me\/calendar\/calendarView$/,
  /^\/me\/messages\/[^/]+$/,
  /^\/chats\/[^/]+\/messages$/,
  /^\/teams\/[^/]+\/channels\/[^/]+\/messages$/,
  /^\/me\/onlineMeetings\/[^/]+\/transcripts\/[^/]+\/content$/,
  /^\/drives\/[^/]+\/items\/[^/]+$/
];

export class ConnectorError extends Error {
  constructor(code, { outcomeUnknown = false } = {}) {
    super(`Microsoft 365 connector: ${code}`);
    this.name = 'ConnectorError';
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}

function fail(code) {
  throw new ConnectorError(code);
}

function segment(value) {
  if (typeof value !== 'string' || value.length > 2048 ||
      !/^[A-Za-z0-9_+=:@.!-]+$/.test(value) || value === '.' || value === '..') fail('invalid_source_id');
  return encodeURIComponent(value);
}

function list(value, map) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) fail('invalid_source_configuration');
  return value.map(map);
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function link(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function people(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 100).map(value => ({
    name: text(value?.emailAddress?.name),
    address: text(value?.emailAddress?.address)
  }));
}

function message(value) {
  if (!value || typeof value.id !== 'string' || !value.id ||
      typeof value.isDraft !== 'boolean') fail('invalid_response');
  return {
    id: value.id, subject: text(value.subject), webLink: link(value.webLink),
    conversationId: text(value.conversationId), isDraft: value.isDraft === true,
    receivedDateTime: text(value.receivedDateTime),
    from: people([value.from])[0], toRecipients: people(value.toRecipients),
    ccRecipients: people(value.ccRecipients), replyTo: people(value.replyTo),
    body: { contentType: text(value.body?.contentType), content: text(value.body?.content) },
    trust: 'untrusted-evidence'
  };
}

function normalizedDraftText(value) {
  return value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
    .replace(/[ \t]+(?=\n|$)/g, '').trim();
}

function approvedReplyPresent(body, uniqueBody, replyText) {
  if (typeof body?.content !== 'string' || typeof uniqueBody?.content !== 'string' ||
      text(body.contentType).toLowerCase() !== 'text' ||
      text(uniqueBody.contentType).toLowerCase() !== 'text') return false;
  const approved = normalizedDraftText(replyText);
  if (!approved || normalizedDraftText(uniqueBody.content) !== approved) return false;
  const fullBody = normalizedDraftText(body.content);
  return fullBody === approved || fullBody.startsWith(`${approved}\n`);
}

function query(path, parameters) {
  return `${path}?${new URLSearchParams(parameters)}`;
}

function dates(start, end, maxDays) {
  const first = timestamp(start);
  const last = timestamp(end);
  if (last <= first ||
      last - first > maxDays * DAY) fail('invalid_time_window');
  return [new Date(first).toISOString(), new Date(last).toISOString()];
}

function timestamp(value) {
  if (typeof value !== 'string') fail('invalid_time_window');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('invalid_time_window');
  return parsed;
}

/**
 * Host-only adapter. Never expose tokenProvider, transport, or connect options to
 * source content or an unrestricted HTTP/agent tool.
 * @param {{tokenProvider?: Function, transport?: typeof fetch, timeoutMs?: number}} options
 */
export function createMicrosoft365Connectors({
  tokenProvider, transport = globalThis.fetch, timeoutMs = 15_000
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60_000) fail('invalid_timeout');
  let connection;
  let generation = 0;
  let state = 'disconnected';
  let reason = 'explicit_connection_required';
  const controllers = new Set();
  const activeDrafts = new Set();

  function disconnect() {
    generation++;
    connection = undefined;
    state = 'disconnected';
    reason = 'explicit_connection_required';
    for (const controller of controllers) controller.abort();
  }

  function status() {
    return {
      state, reason, verifiedOwner: state === 'connected',
      identity: connection ? { ...connection.identity } : null,
      enabled: connection ? [...connection.enabled] : [],
      unavailable: ['loop', 'meetingInsights', 'fileContent']
    };
  }

  async function session(config, scopes, signal, action) {
    const revision = generation;
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let removeAbort;
    const aborted = new Promise((_, reject) => {
      const onAbort = () => reject(new ConnectorError(timedOut ? 'timeout' : 'cancelled'));
      removeAbort = () => controller.signal.removeEventListener('abort', onAbort);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    let writeAttempted = false;
    const check = () => {
      if (revision !== generation) fail('disconnected');
      if (controller.signal.aborted) fail(timedOut ? 'timeout' : 'cancelled');
    };
    try {
      return await Promise.race([aborted, (async () => {
        check();
        let auth;
        try {
          auth = await tokenProvider({
            scopes: [...new Set(['User.Read', ...scopes])],
            expectedIdentity: { ...config.identity }, signal: controller.signal
          });
        } catch {
          fail('authentication_required');
        }
        check();
        if (!auth || auth.tokenType !== 'delegated' ||
            auth.tenantId !== config.identity.tenantId || auth.userId !== config.identity.userId) {
          fail('identity_mismatch');
        }
        if (!Array.isArray(auth.scopes) ||
            !['User.Read', ...scopes].every(scope => auth.scopes.includes(scope))) fail('permission_required');
        if (typeof auth.accessToken !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(auth.accessToken)) {
          fail('authentication_required');
        }

        // Routes are generated only by the closed operations below, never by a caller URL.
        async function request(path, { method = 'GET', body, accept = 'application/json' } = {}) {
          check();
          const url = new URL(`${GRAPH}${path}`);
          if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/')) {
            fail('blocked_request');
          }
          if (method === 'GET' && !READ_PATHS.some(pattern => pattern.test(url.pathname.slice(5)))) {
            fail('blocked_request');
          }
          if (method !== 'GET' && !(method === 'POST' &&
              /^\/me\/messages\/[^/?]+\/createReply(?:All)?$/.test(path))) fail('blocked_request');
          if (method === 'POST') writeAttempted = true;
          let response;
          try {
            response = await transport(url.href, {
              method, redirect: 'error', signal: controller.signal,
              headers: {
                Authorization: `Bearer ${auth.accessToken}`, Accept: accept,
                Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"',
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) })
            });
          } catch {
            check();
            fail('transport_error');
          }
          check();
          if (response.status === 401) fail('authentication_required');
          if (response.status === 403) fail('permission_denied');
          if (response.status === 404) fail('source_unavailable');
          if (response.status === 429) fail('throttled');
          if (!response.ok || response.status < 200 || response.status >= 300) fail('service_error');
          if (!response.body?.getReader) fail('invalid_response');
          const reader = response.body.getReader();
          const cancelRead = () => { reader.cancel().catch(() => {}); };
          controller.signal.addEventListener('abort', cancelRead, { once: true });
          const chunks = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              check();
              if (done) break;
              size += value.byteLength;
              if (size > MAX_BYTES) fail('response_too_large');
              chunks.push(value);
            }
          } finally {
            controller.signal.removeEventListener('abort', cancelRead);
            await reader.cancel().catch(() => {});
          }
          const content = Buffer.concat(chunks).toString('utf8');
          if (accept !== 'application/json') return content;
          try {
            return JSON.parse(content);
          } catch {
            fail('invalid_response');
          }
        }

        const owner = await request('/me?$select=id');
        if (owner?.id !== config.identity.userId) fail('identity_mismatch');
        check();
        return action(request, check);
      })()]);
    } catch (error) {
      const code = error instanceof ConnectorError ? error.code : 'invalid_response';
      if (revision === generation && ['identity_mismatch', 'authentication_required'].includes(code)) {
        disconnect();
        state = 'error';
        reason = code;
      }
      throw new ConnectorError(code, { outcomeUnknown: writeAttempted });
    } finally {
      clearTimeout(timer);
      removeAbort?.();
      signal?.removeEventListener('abort', cancel);
      controllers.delete(controller);
    }
  }

  async function connect({
    consent, expectedIdentity, sources = {}, allowReplyDrafts = false, signal
  } = {}) {
    disconnect();
    if (consent !== true) fail('consent_required');
    if (typeof tokenProvider !== 'function') fail('token_provider_unavailable');
    if (!expectedIdentity || !expectedIdentity.tenantId || !expectedIdentity.userId) fail('identity_required');
    segment(expectedIdentity.tenantId);
    segment(expectedIdentity.userId);
    const config = {
      identity: { tenantId: expectedIdentity.tenantId, userId: expectedIdentity.userId },
      mail: sources.mail === true, calendar: sources.calendar === true,
      chats: list(sources.chats, id => ({ id, path: `/chats/${segment(id)}/messages` })),
      channels: list(sources.channels, ({ teamId, channelId }) => ({
        teamId, channelId, path: `/teams/${segment(teamId)}/channels/${segment(channelId)}/messages`
      })),
      transcripts: list(sources.transcripts, ({ meetingId, transcriptId }) => ({
        meetingId, transcriptId,
        path: `/me/onlineMeetings/${segment(meetingId)}/transcripts/${segment(transcriptId)}/content`
      })),
      files: list(sources.files, ({ driveId, itemId }) => ({
        driveId, itemId, path: `/drives/${segment(driveId)}/items/${segment(itemId)}`
      })),
      allowReplyDrafts: allowReplyDrafts === true
    };
    config.enabled = [
      ...(config.mail ? ['mail'] : []), ...(config.calendar ? ['calendar'] : []),
      ...['chats', 'channels', 'transcripts', 'files'].filter(key => config[key].length)
    ];
    await session(config, [], signal, async () => {
      connection = config;
      state = 'connected';
      reason = null;
    });
    return status();
  }

  function requireSource(source) {
    if (!connection || state !== 'connected') fail('disconnected');
    if (!connection[source] || (Array.isArray(connection[source]) && !connection[source].length)) {
      fail('source_not_authorized');
    }
    return connection;
  }

  function result(items, limitations, hasMore = false, gaps = []) {
    return {
      items, verifiedOwner: true, hasMore,
      coverage: { status: gaps.length || hasMore ? 'partial' : 'bounded', limitations, gaps },
      trust: 'untrusted-evidence'
    };
  }

  function page(value) {
    if (!value || !Array.isArray(value.value) || value.value.length > 50) fail('invalid_response');
    // Never follow a server-supplied URL, including nextLink or download URLs.
    return { values: value.value, hasMore: Boolean(value['@odata.nextLink']) };
  }

  async function readMail({ signal, startDateTime, endDateTime } = {}) {
    const config = requireSource('mail');
    const end = endDateTime ?? new Date().toISOString();
    const start = startDateTime ?? new Date(timestamp(end) - 14 * DAY).toISOString();
    const [first, last] = dates(start, end, 14);
    return session(config, ['Mail.Read'], signal, async request => {
      const data = page(await request(query('/me/mailFolders/inbox/messages', {
        '$top': '50', '$select': MESSAGE_FIELDS,
        '$filter': `receivedDateTime ge ${first} and receivedDateTime le ${last}`,
        '$orderby': 'receivedDateTime desc'
      })));
      return result(data.values.map(message), [
        'Inbox only, first 50 messages in the requested window (maximum 14 days).',
        'Other folders, sent replies, attachments and subsequent pages are not inspected.',
        'Evidence is not an assignment or instruction; ownership and unfinished work require host review.'
      ], data.hasMore);
    });
  }

  async function readCalendar({ signal, startDateTime, endDateTime } = {}) {
    const config = requireSource('calendar');
    const start = startDateTime ?? new Date().toISOString();
    const end = endDateTime ?? new Date(timestamp(start) + 60 * DAY).toISOString();
    const [first, last] = dates(start, end, 60);
    return session(config, ['Calendars.Read'], signal, async request => {
      const data = page(await request(query('/me/calendar/calendarView', {
        startDateTime: first, endDateTime: last, '$top': '50',
        '$select': 'id,subject,webLink,start,end,organizer,attendees,body,isCancelled,onlineMeeting'
      })));
      return result(data.values.map(value => {
        if (!value || typeof value.id !== 'string' || !value.id) fail('invalid_response');
        return {
          id: value.id, subject: text(value.subject), webLink: link(value.webLink),
          start: { dateTime: text(value.start?.dateTime), timeZone: text(value.start?.timeZone) },
          end: { dateTime: text(value.end?.dateTime), timeZone: text(value.end?.timeZone) },
          organizer: people([value.organizer])[0], attendees: people(value.attendees),
          body: { contentType: text(value.body?.contentType), content: text(value.body?.content) },
          isCancelled: value.isCancelled === true,
          joinUrl: link(value.onlineMeeting?.joinUrl), trust: 'untrusted-evidence'
        };
      }), ['Default calendar only, first 50 events; calendar entries alone are not action tasks.'], data.hasMore);
    });
  }

  async function readPinned(source, scope, { signal } = {}) {
    const config = requireSource(source);
    return session(config, [scope], signal, async request => {
      const items = [];
      const gaps = [];
      let hasMore = false;
      for (const pinned of config[source]) {
        try {
          if (source === 'transcripts') {
            const content = await request(pinned.path, { accept: 'text/vtt' });
            if (!/^\uFEFF?WEBVTT(?:[ \t\r\n]|$)/.test(content)) fail('invalid_response');
            items.push({
              meetingId: pinned.meetingId, transcriptId: pinned.transcriptId,
              content, contentType: 'text/vtt', trust: 'untrusted-evidence'
            });
          } else if (source === 'files') {
            const value = await request(query(pinned.path, {
              '$select': 'id,name,webUrl,lastModifiedDateTime,size,file,folder'
            }));
            if (value?.id !== pinned.itemId) fail('invalid_response');
            items.push({
              driveId: pinned.driveId, id: value.id, name: text(value.name),
              webLink: link(value.webUrl), lastModifiedDateTime: text(value.lastModifiedDateTime),
              mimeType: text(value.file?.mimeType), contentAvailable: false,
              trust: 'untrusted-evidence'
            });
          } else {
            const data = page(await request(query(pinned.path, { '$top': '50' })));
            hasMore ||= data.hasMore;
            items.push(...data.values.map(value => {
              if (!value || typeof value.id !== 'string' || !value.id) fail('invalid_response');
              return {
                id: value.id, chatId: pinned.id,
                teamId: pinned.teamId, channelId: pinned.channelId,
                createdDateTime: text(value.createdDateTime),
                lastModifiedDateTime: text(value.lastModifiedDateTime),
                webLink: link(value.webUrl),
                body: { contentType: text(value.body?.contentType), content: text(value.body?.content) },
                senderId: text(value.from?.user?.id), trust: 'untrusted-evidence'
              };
            }));
          }
        } catch (error) {
          if (!(error instanceof ConnectorError) ||
              !['permission_denied', 'source_unavailable'].includes(error.code)) throw error;
          gaps.push({ sourceIndex: config[source].indexOf(pinned), code: error.code });
        }
      }
      return result(items, [
        'Explicitly selected sources only; no tenant-wide discovery or completeness claim.',
        ...(source === 'files' ? ['Metadata only; document and Loop content are not read.'] :
          source === 'transcripts' ? ['Only configured meeting/transcript pairs; no meeting lookup or insights.'] :
            ['First 50 messages per selected source; channel replies and attachments are not inspected.'])
      ], hasMore, gaps);
    });
  }

  async function createReplyDraft({ messageId, text: replyText, replyAll = false, signal } = {}) {
    const config = requireSource('mail');
    if (!config.allowReplyDrafts) fail('draft_consent_required');
    const path = `/me/messages/${segment(messageId)}`;
    if (typeof replyText !== 'string' || !replyText.trim() || replyText.length > 32_000 ||
        typeof replyAll !== 'boolean') fail('invalid_draft');
    if (activeDrafts.has(messageId)) fail('draft_in_progress');
    activeDrafts.add(messageId);
    try {
      return await session(config, ['Mail.ReadWrite'], signal, async (request, check) => {
        const source = message(await request(query(path, { '$select': MESSAGE_FIELDS })));
        if (source.id !== messageId || source.isDraft || !source.conversationId) fail('invalid_source_message');
        check();
        const created = await request(`${path}/${replyAll ? 'createReplyAll' : 'createReply'}`, {
          method: 'POST', body: { comment: replyText }
        });
        const draftPath = `/me/messages/${segment(created?.id)}`;
        const readBack = await request(query(draftPath, { '$select': `${MESSAGE_FIELDS},uniqueBody` }));
        const draft = message(readBack);
        if (draft.id !== created.id || draft.id === source.id || !draft.isDraft ||
            draft.conversationId !== source.conversationId ||
            !approvedReplyPresent(draft.body, readBack.uniqueBody, replyText)) fail('draft_verification_failed');
        return {
          id: draft.id, subject: draft.subject, webLink: draft.webLink,
          isDraft: true, verifiedOwner: true,
          source: { id: source.id, subject: source.subject, webLink: source.webLink },
          conversationId: draft.conversationId
        };
      });
    } finally {
      activeDrafts.delete(messageId);
    }
  }

  const unavailable = Object.freeze({ read: async () => fail('source_unavailable') });
  return Object.freeze({
    connect, disconnect, status,
    connectors: Object.freeze({
      mail: Object.freeze({ read: readMail, createReplyDraft }),
      calendar: Object.freeze({ read: readCalendar }),
      teamsChats: Object.freeze({ read: options => readPinned('chats', 'Chat.Read', options) }),
      teamsChannels: Object.freeze({ read: options => readPinned('channels', 'ChannelMessage.Read.All', options) }),
      transcripts: Object.freeze({ read: options => readPinned('transcripts', 'OnlineMeetingTranscript.Read.All', options) }),
      files: Object.freeze({ read: options => readPinned('files', 'Files.Read', options) }),
      loop: unavailable, meetingInsights: unavailable
    })
  });
}
