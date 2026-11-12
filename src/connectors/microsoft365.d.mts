export type SourceName =
  | 'mail' | 'calendar' | 'teamsChats' | 'teamsChannels'
  | 'transcripts' | 'files' | 'loop' | 'meetingInsights';

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
  startDateTime?: string;
  endDateTime?: string;
}

export interface Coverage {
  status: 'bounded' | 'partial';
  limitations: string[];
  gaps: Array<{ sourceIndex: number; code: 'permission_denied' | 'source_unavailable' }>;
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

export interface FileEvidence extends Evidence {
  driveId: string;
  id: string;
  name: string;
  webLink: string;
  lastModifiedDateTime: string;
  mimeType: string;
  contentAvailable: false;
}

export interface ReadResult<T extends Evidence> extends Evidence {
  items: T[];
  verifiedOwner: true;
  hasMore: boolean;
  coverage: Coverage;
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
  files?: Array<{ driveId: string; itemId: string }>;
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
  enabled: Array<'mail' | 'calendar' | 'chats' | 'channels' | 'transcripts' | 'files'>;
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
    teamsChannels: ReadConnector<TeamsEvidence>;
    transcripts: ReadConnector<TranscriptEvidence>;
    files: ReadConnector<FileEvidence>;
    loop: { read(options?: ReadOptions): Promise<never> };
    meetingInsights: { read(options?: ReadOptions): Promise<never> };
  };
}

export function createMicrosoft365Connectors(options?: {
  tokenProvider?: (request: TokenRequest) => Promise<DelegatedCredential>;
  transport?: typeof fetch;
  timeoutMs?: number;
}): Microsoft365Connectors;
