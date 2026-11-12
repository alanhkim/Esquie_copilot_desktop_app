export type SourceName =
  | 'mail' | 'calendar' | 'teamsChats' | 'teamsChannels'
  | 'transcripts' | 'oneNote' | 'files' | 'loop' | 'meetingInsights';

export interface Identity {
  tenantId: string;
  userId: string;
}

export interface TokenRequest {
  scopes: string[];
  expectedIdentity: Identity;
  signal: AbortSignal;
}

/** Authentication is performed and validated by the trusted host, not this adapter. */
export interface DelegatedCredential extends Identity {
  accessToken: string;
  tokenType: 'delegated';
  scopes: string[];
}

export interface ReadOptions {
  signal?: AbortSignal;
  /** Host-only guard checked before each request in a multi-request read. */
  checkpoint?: () => boolean;
  startDateTime?: string;
  endDateTime?: string;
}

export interface FileContentReadOptions extends ReadOptions {
  driveId: string;
  itemId: string;
  /** Source-check revision required by the local host before content download. */
  expectedETag?: string;
  expectedSize?: number;
  /** Canonical hostname explicitly approved by the owner for this read. */
  approvedHost: string;
  confirmRead: true;
}

export interface FileContentDownloadRequest {
  url: string;
  approvedHost: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface Coverage {
  status: 'bounded' | 'partial';
  successfulRequests?: number;
  limitations: string[];
  gaps: Array<{
    sourceIndex: number;
    code: 'permission_denied' | 'source_unavailable' | 'invalid_response' |
      'response_too_large' | 'invalid_content_encoding';
  }>;
}

export interface Evidence {
  trust: 'untrusted-evidence';
}

export interface Person {
  name: string;
  address: string;
}

export interface Body {
  contentType: string;
  content: string;
}

export interface MailEvidence extends Evidence {
  id: string;
  subject: string;
  webLink: string;
  conversationId: string;
  isDraft: boolean;
  receivedDateTime: string;
  from: Person;
  toRecipients: Person[];
  ccRecipients: Person[];
  replyTo: Person[];
  body: Body;
}

export interface CalendarEvidence extends Evidence {
  id: string;
  subject: string;
  webLink: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  organizer: Person;
  attendees: Person[];
  body: Body;
  isCancelled: boolean;
  joinUrl: string;
}

export interface TeamsEvidence extends Evidence {
  id: string;
  chatId?: string;
  teamId?: string;
  channelId?: string;
  replyToId?: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  webLink: string;
  body: Body;
  senderId: string;
}

export interface TranscriptEvidence extends Evidence {
  meetingId: string;
  transcriptId: string;
  content: string;
  contentType: 'text/vtt';
}

export interface OneNotePageEvidence extends Evidence {
  id: string;
  content: string;
  contentType: 'text/html';
}

export interface MeetingInsightEvidence extends Evidence {
  meetingId: string;
  id: string;
  content: string;
}

export interface MeetingInsightMetadata extends Evidence {
  meetingId: string;
  id: string;
  createdDateTime: string;
  endDateTime: string;
}

export interface FileEvidence extends Evidence {
  driveId: string;
  id: string;
  name: string;
  webLink: string;
  lastModifiedDateTime: string;
  mimeType: string;
  contentAvailable: boolean;
  content?: string;
  eTag?: string;
  contentType?: 'text/plain';
  provenance?: 'explicit-owner-approved-sharepoint-read';
  size?: number;
}

export interface ReadResult<T extends Evidence> extends Evidence {
  items: T[];
  verifiedOwner: true;
  hasMore: boolean;
  coverage: Coverage;
}

export interface ChannelReplyReadOptions extends ReadOptions {
  /** Must identify a channel already pinned in the current connection. */
  teamId: string;
  channelId: string;
  /** Exact root message selected from persisted current channel evidence. */
  messageId: string;
}

export interface ChannelThreadReadResult extends ReadResult<TeamsEvidence> {
  parent: TeamsEvidence;
}

export interface ReadConnector<T extends Evidence> {
  read(options?: ReadOptions): Promise<ReadResult<T>>;
}

export interface ReplyDraftOptions {
  messageId: string;
  text: string;
  replyAll?: boolean;
  signal?: AbortSignal;
}

export interface ReplyDraft {
  id: string;
  subject: string;
  webLink: string;
  isDraft: true;
  verifiedOwner: true;
  source: { id: string; subject: string; webLink: string };
  conversationId: string;
}

export interface SourceConfiguration {
  mail?: boolean;
  calendar?: boolean;
  chats?: string[];
  channels?: Array<{ teamId: string; channelId: string }>;
  transcripts?: Array<{ meetingId: string; transcriptId: string }>;
  files?: Array<{ driveId: string; itemId: string; approvedHost?: string }>;
  oneNotePages?: string[];
  meetingInsights?: Array<{ meetingId: string; insightId: string }>;
  meetingInsightMeetings?: string[];
}

export interface ConnectOptions {
  consent: true;
  expectedIdentity: Identity;
  sources?: SourceConfiguration;
  allowReplyDrafts?: boolean;
  signal?: AbortSignal;
}

export interface ConnectionStatus {
  state: 'disconnected' | 'connected' | 'error';
  reason: string | null;
  verifiedOwner: boolean;
  identity: Identity | null;
  enabled: Array<'mail' | 'calendar' | 'chats' | 'channels' | 'transcripts' | 'oneNotePages' | 'meetingInsights' | 'meetingInsightMeetings' | 'files'>;
  unavailable: string[];
}

export class ConnectorError extends Error {
  constructor(code: string, options?: { outcomeUnknown?: boolean });
  code: string;
  outcomeUnknown: boolean;
}

export interface Microsoft365Connectors {
  connect(options: ConnectOptions): Promise<ConnectionStatus>;
  disconnect(): void;
  status(): ConnectionStatus;
  connectors: {
    mail: ReadConnector<MailEvidence> & {
      createReplyDraft(options: ReplyDraftOptions): Promise<ReplyDraft>;
    };
    calendar: ReadConnector<CalendarEvidence>;
    teamsChats: ReadConnector<TeamsEvidence>;
    teamsChannels: ReadConnector<TeamsEvidence> & {
      readReplies(options: ChannelReplyReadOptions): Promise<ChannelThreadReadResult>;
    };
    transcripts: ReadConnector<TranscriptEvidence>;
    oneNote: ReadConnector<OneNotePageEvidence>;
    files: ReadConnector<FileEvidence> & {
      /** Reads one selected text/plain item only after a per-read host approval. */
      readContent(options: FileContentReadOptions): Promise<ReadResult<FileEvidence>>;
    };
    loop: { read(options?: ReadOptions): Promise<never> };
    meetingInsights: ReadConnector<MeetingInsightEvidence>;
    meetingInsightList: { read(options: { meetingId: string; signal?: AbortSignal; checkpoint?: () => boolean }): Promise<ReadResult<MeetingInsightMetadata>> };
    /** Host must validate an exact current-owner list result and separate per-read consent first. */
    meetingInsightSelection: { read(options: { meetingId: string; insightId: string; consent: true; signal?: AbortSignal; checkpoint?: () => boolean }): Promise<ReadResult<MeetingInsightEvidence>> };
  };
}

export function createMicrosoft365Connectors(options?: {
  tokenProvider?: (request: TokenRequest) => Promise<DelegatedCredential>;
  transport?: typeof fetch;
  timeoutMs?: number;
  /** Enable direct HTTPS only after trusted-host review confirms it is allowed by network policy. */
  allowDirectFileEgress?: boolean;
  /** Trusted host/test seam; the default downloader enforces the documented HTTPS boundary. */
  fileContentDownloader?: (request: FileContentDownloadRequest) => Promise<string>;
}): Microsoft365Connectors;
