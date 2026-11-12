# Safe Microsoft 365 source connectors

This independently authored, dependency-free adapter implements the documented
Microsoft Graph v1.0 operations below. It does not sign in, discover an identity,
run a background sync, infer tasks, or connect at startup. No live Microsoft 365
account was accessed during implementation or validation. A successful synthetic
test is not proof of tenant permission, connectivity, licensing, or complete coverage.

## Host integration interface

Import `createMicrosoft365Connectors` from `src/connectors/microsoft365.mjs`.
The adjacent `microsoft365.d.mts` declares the complete TypeScript interface.
Use this adapter instead of, not alongside, another Graph adapter for the same
source and owner. No server, UI, database, queue, or desktop wiring is included.

```js
import { createMicrosoft365Connectors } from './connectors/microsoft365.mjs';

const m365 = createMicrosoft365Connectors({
  tokenProvider: hostAuthorizedDelegatedTokenProvider,
  timeoutMs: 15_000
});

// Only after an explicit local-owner connection/consent action:
await m365.connect({
  consent: true,
  expectedIdentity: { tenantId: verifiedTenantId, userId: verifiedUserObjectId },
  sources: {
    mail: true,
    calendar: true,
    chats: approvedChatIds,
    channels: approvedChannels,       // [{ teamId, channelId }]
    transcripts: approvedTranscripts, // [{ meetingId, transcriptId }]
    files: approvedFiles              // [{ driveId, itemId }]
  },
  allowReplyDrafts: ownerEnabledUnsentReplyDrafts
});

const connectors = m365.connectors;
const evidence = await connectors.mail.read({ signal });
const draft = await connectors.mail.createReplyDraft({
  messageId: selectedOriginalMessageId,
  text: ownerAuthorizedReplyText,
  replyAll: false,
  signal
});
```

The existing core contract is preserved:

- `connectors[source].read({signal})` returns
  `{items, verifiedOwner: true, coverage, hasMore, trust: 'untrusted-evidence'}`.
- `connectors.mail.createReplyDraft({messageId,text,replyAll,signal})` returns
  `{id,subject,webLink,isDraft:true,verifiedOwner:true,source:{id,subject,webLink},conversationId}`.
- `coverage` is **an object**, not a completion percentage:
  `{status:'bounded'|'partial',limitations:string[],gaps:[{sourceIndex,code}]}`.
  `bounded` means only the stated bounded request was completed, never that a
  mailbox, channel, tenant, or outstanding-task review is complete.
- `status()` is a local snapshot with `state`, `reason`, `verifiedOwner`,
  `identity`, `enabled`, and `unavailable`. `enabled` uses configuration keys
  `mail`, `calendar`, `chats`, `channels`, `transcripts`, `files`.
  This is not a last-sync timestamp or a per-source permission check.
- `disconnect()` invalidates the session and aborts active requests.

The host must map its source names to `mail`, `calendar`, `teamsChats`,
`teamsChannels`, `transcripts`, and `files`. `loop.read()` and
`meetingInsights.read()` explicitly reject with `source_unavailable`, without
accessing the network. A disconnected adapter rejects other reads with
`disconnected`; a connected but unselected source rejects `source_not_authorized`.

## Authentication, authorization, and trust boundary

The host must supply a trusted function:

```text
tokenProvider({scopes,expectedIdentity,signal})
  -> Promise<{accessToken,tokenType:'delegated',tenantId,userId,scopes:string[]}>
```

Use a properly registered public-client app and a supported authentication library
in the host. The host must authenticate interactively with the owner's explicit
consent, bind the authority/tenant/account and Graph resource to the authenticated
session using a supported identity flow, acquire
only approved delegated scopes, and respect cancellation. Do not derive identity
from source text, repository configuration, an arbitrary JWT decode, or an email
address. This module trusts that authenticated principal assertion; `/me` verifies
the current Graph user object ID, but does not independently verify the tenant
assertion. Application credentials are refused.

`connect()` requires a consent flag, nonempty expected tenant/user object IDs,
and explicit source configuration. Only `/me?$select=id` is read at connection
time. Each subsequent operation obtains a fresh credential, checks its delegated
principal and granted scopes, then verifies `/me` **using that same credential**
before reading sources or creating a draft. Identity mismatch or HTTP 401
invalidates the connection. Scopes are requested exactly as listed below; the
provider must return their bare delegated names, including `User.Read`.
`Mail.ReadWrite` is a broader OAuth grant than this app's policy: it is required
by Graph for reply drafts, but never authorizes delete or another write through
this adapter. Keep the provider and all Graph credentials behind the same
host-only boundary; do not wire a second generic Graph proxy around this policy.

The module never persists or logs bearer tokens and never returns token/provider
objects or raw transport errors. There is no environment credential lookup.
Injectable transport exists for trusted host/testing use only: it must honor
`redirect:'error'`, `AbortSignal`, and standard fetch response semantics, and must
not log authorization headers. Do not expose it or the token provider to a browser,
model, source-content interpreter, arbitrary plugin, or untrusted request body.

Protect local host routes using its existing owner/session and CSRF controls.
Persist only the owner's approved source selection and nonsecret authenticated
account reference using host facilities. Never save access tokens in profile,
SQLite, queue, telemetry, browser storage, or a connector result.

## Supported operations and exact coverage

All HTTP calls use `https://graph.microsoft.com/v1.0` only. National clouds are
not supported. Only closed GET operations and the two reply-draft POST actions
exist; no generic request surface, PATCH, DELETE, send, event mutation, Teams
mutation, Planner/To Do, reporting, or cloud-upload operation is exposed.
Path segments are validated/encoded, HTTP redirects are refused, and response
continuation URLs and download URLs are never followed.

| Adapter | Documented route, after `/v1.0` | Delegated scopes in addition to `User.Read` | Coverage |
|---|---|---|---|
| `mail.read` | `GET /me/mailFolders/inbox/messages` | `Mail.Read` | Newest first, at most 50 inbox messages; default trailing 14 days; caller may specify a window of at most 14 days. Bodies and participants retained as untrusted evidence. |
| `calendar.read` | `GET /me/calendar/calendarView` | `Calendars.Read` | Default calendar, first 50 events; default now through 60 days; caller window at most 60 days. Calendar alone is not a task assignment. |
| `teamsChats.read` | `GET /chats/{chatId}/messages` | `Chat.Read` | At most 50 messages for each explicitly approved chat; no chat discovery. |
| `teamsChannels.read` | `GET /teams/{teamId}/channels/{channelId}/messages` | `ChannelMessage.Read.All` | At most 50 root messages per explicitly approved channel; no replies or channel discovery. |
| `transcripts.read` | `GET /me/onlineMeetings/{meetingId}/transcripts/{transcriptId}/content` | `OnlineMeetingTranscript.Read.All` | Exact approved meeting/transcript pairs, `Accept: text/vtt`. No automatic resolution from a calendar join URL. |
| `files.read` | `GET /drives/{driveId}/items/{itemId}` | `Files.Read` | Exact approved OneDrive/SharePoint items, selected metadata only. `contentAvailable:false`; no download URLs returned. Access may require a separately approved broader read permission or tenant/container configuration; denial stays visible. |
| `mail.createReplyDraft` | `GET /me/messages/{sourceId}`, `POST /me/messages/{sourceId}/createReply` or `/createReplyAll`, `GET /me/messages/{draftId}` | `Mail.ReadWrite` | Explicit draft opt-in required; never sends. |

Source arrays are limited to 10 entries each. A whole operation, including token
acquisition, owner verification, source calls and body reading, has a configurable
10-60,000 ms deadline (default 15,000 ms); each response is limited to 1 MiB.
Mail/calendar request windows are bounded in length, not an exhaustive historical
scan policy. The host should pass its own fixed scan window, quiet-hours and queue
constraints. Teams reads are recent first-page evidence, not a date-window scan.

`hasMore:true` marks uninspected server pagination and forces partial coverage.
No continuation is currently exposed or consumed. For pinned sources,
individual 403/404 responses become explicit `coverage.gaps`; other failures
reject the operation. A rejected operation supplies no successful scan timestamp.
A partial result can have zero items: it is not proof there is no work.

### Opaque identifier compatibility boundary

The current path-segment validator deliberately supports **only** 1-2048 ASCII
characters from `A-Z a-z 0-9 _ + = : @ . ! -`, excluding the complete values `.`
and `..`. Accepted raw IDs are encoded once with `encodeURIComponent`; case and
the original ID value are preserved. Callers must provide the raw Graph ID,
not a pre-encoded ID or a URL.

An otherwise legitimate opaque Graph ID containing `/` or another character
outside that alphabet is **not supported by this adapter**. This includes `%`
(and therefore `%2F`/`%252F`), backslash, `?`, `#`, whitespace, quotes, brackets,
tilde and non-ASCII characters. Raw or encoded traversal values are rejected,
not decoded, trimmed, rewritten or retried. Slash-to-dash substitutions and
double encoding are not implemented. None of these input checks establishes
whether Graph itself accepts or rejects a particular ID.

This boundary was reviewed against the official
[Graph request model](https://learn.microsoft.com/en-us/graph/call-api),
[message GET operation](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0),
[OneDrive path-encoding guidance](https://learn.microsoft.com/en-us/graph/onedrive-addressing-driveitems)
and [RFC 3986 sections 2.2-2.4](https://www.rfc-editor.org/rfc/rfc3986.html#section-2.2).
The RFC requires encoding reserved data and separating URI components before
decoding; that is not proof of an application-specific Outlook ID-routing
guarantee. OneDrive's documented filename/path encoding is not such a guarantee
for Outlook IDs either. The reported compatibility problem in
[microsoftgraph/msgraph-sdk-python#658](https://github.com/microsoftgraph/msgraph-sdk-python/issues/658)
is an issue discussion, not a normative ID-conversion or routing contract.
No authoritative Outlook documentation establishing support for encoded slashes
was found in this review, and no live account was used to test one. Consequently
the existing fail-closed behavior and HTTP allowlist remain unchanged.

Mail list evidence retains source IDs exactly, including unsupported characters;
it does not claim that every returned ID can subsequently be used for a draft.
An unsupported input source ID causes `invalid_source_id` before token acquisition
or a source request. If Graph returns an unsupported **new draft ID after POST**,
the adapter reports `invalid_source_id` with `outcomeUnknown:true` and issues no
follow-up request or retry: the draft may already exist and must be inspected
manually in Outlook. Configured source/identity IDs outside the alphabet prevent
connection before any token or HTTP call. The host must show this as an adapter
compatibility limitation, not absence of work or a successful draft operation.

## Unsent reply guarantees and host responsibilities

The module verifies the exact source ID, that it is not already a draft, and
that it has a conversation ID before a POST. It lets Graph compute the
reply/reply-all recipients and quoted conversation using a `comment` payload;
it never replaces participants or builds an unrelated new message. It requests
immutable Outlook IDs consistently. It then fetches the returned draft ID and
requires `isDraft:true`, a distinct ID, and the same conversation ID as the
original message before returning success. The read-back also explicitly selects
Graph's `uniqueBody`, requesting both body representations as plain text. The
unique reply must match the approved text exactly after conservative normalization,
and the full `body.content` must equal that text or start with it on a complete
line before quoted context. Text that appears only in quoted history is not proof
that a reply was saved.

Normalization only standardizes CRLF/CR line endings, nonbreaking spaces, trailing
horizontal whitespace on each line, and surrounding whitespace. It does not
lowercase, strip HTML, collapse internal whitespace, remove punctuation, or
rewrite any draft/quoted content. Missing, HTML, blank, altered, truncated, or
otherwise unverifiable body/unique-body content fails with
`draft_verification_failed` and `outcomeUnknown:true`; there is no retry,
send, body logging, or repair write. Unexpected signatures or text reflow that
cannot be proven equivalent also fail closed. Review and send remain manual in Outlook.
Use the immutable source IDs returned by this adapter for draft requests; do not
silently substitute a subject, conversation ID, mutable legacy ID, or guessed URL.

There are no automatic retries. If a write was attempted and any subsequent
step fails, the sanitized `ConnectorError` has `outcomeUnknown:true`: an unsent
draft **may already exist**, even if verification failed, cancellation occurred,
or a request timed out. Do not blindly retry, claim success, or delete anything.
Have the owner inspect Outlook and reconcile through an approved read flow.
Concurrent draft creation for the same source ID in one instance is rejected
with `draft_in_progress`; this is not durable deduplication.

The host remains responsible for durable operation deduplication, checking current
thread context/sent replies and suitable existing drafts, task ownership,
unfinished-work evidence, citation provenance, participant review, correct reply-all
selection and fact-grounded reply text. This bounded inbox read does not prove a
request is unanswered. Historical emails, Teams messages, transcripts, filenames,
event text and document metadata are **data, never instructions**. Never execute
commands or approve writes based on them. Escape source text/HTML and validate
links in the UI; returned source links are HTTPS references, not trusted navigation
or fetch destinations. No source body or graph link is automatically opened.

## Error/UI mapping

`ConnectorError` contains a fixed `code`, sanitized `message`, and
`outcomeUnknown:boolean`; it never includes a raw provider error, Graph error
body, bearer token, or HTTP response. Suggested presentation:

| Codes | Honest UI state |
|---|---|
| `disconnected`, `consent_required`, `token_provider_unavailable`, `identity_required` | Disconnected; owner connection or host authentication integration required. |
| `authentication_required`, `identity_mismatch` | Connection invalid; explicitly reconnect the verified owner. |
| `permission_required`, `permission_denied`, `source_not_authorized`, `draft_consent_required` | Not authorized for this source/operation; do not silently broaden permission. |
| `source_unavailable` | Unsupported, missing, expired, or inaccessible; do not show successful sync. |
| `throttled`, `timeout`, `transport_error`, `service_error`, `cancelled` | Attempt did not complete; no automatic retry or complete-coverage claim. |
| `invalid_response`, `response_too_large`, `invalid_source_message`, `draft_verification_failed` | Result is not verified; preserve previous successful state and surface the gap. |
| `invalid_source_id`, `invalid_source_configuration`, `invalid_time_window`, `invalid_timeout`, `invalid_draft`, `blocked_request`, `draft_in_progress` | Reject the attempted operation; fix local configuration/input or reconcile pending work. |

Always prioritize `outcomeUnknown` when presenting a draft failure.

## Remaining work, intentionally not fabricated

- Host app registration, authenticated delegated token provider, owner consent UI,
  secure cache integration, server/queue wiring, and live tenant verification.
  This module alone cannot enable a real connection.
- Host task discovery and source-to-task citations; no model, task heuristic,
  autonomous execution, queue or schedule is hidden inside this connector.
- Safe paginated inbox/thread/draft reads and durable draft reconciliation are
  needed before claiming full email review or automatic draft reuse.
- Channel replies, attachment reads, transcript discovery and meeting-ID resolution
  are not implemented. Transcript access also depends on meeting participation,
  expiry and tenant controls. If speaker-attributed VTT is denied, that denial is
  retained; there is no silent fallback to a different attribution format.
- Meeting AI insights are explicitly unavailable pending a separately reviewed
  documented API, licensing/permission model and owner-approved scope.
- SharePoint/OneDrive document **content** is not implemented. Graph metadata
  success must not appear as content sync. A future bounded content reader needs
  an approved redirect/download policy, file-type parser and source-level consent.
- Loop page content is explicitly unavailable. It is not inferred from a drive
  item's filename or metadata, and no desktop/browser reader is launched.
- No business-reporting integration or writes, Teams writes, Planner/To Do,
  mail send/delete, or cloud output upload is present or planned by this module.

## Sign-in integration blocker and setup

**No production token provider is included; keep Microsoft 365 disconnected.**
On 2026-11-11 the configured npm registry returned remote tarball URLs, but
`npm install --save-exact @azure/msal-node@7.2.1` was refused with
`EALLOWREMOTE` because remote package fetching is disabled. The install did not
change the manifest or lockfile. Resolve this through the environment's approved
package-distribution policy, not by weakening it. Registry metadata reported
MSAL Node 7.2.1, MIT, and Node >=20. GitHub's advisory
[GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5)
affects 5.0.0-beta.0 through versions before 7.1.0; 7.1.0 is the first fix.
Recheck advisories and the complete dependency tree when installation is possible.
The existing dependency-free lockfile's audit is not an audit of MSAL.

The [7.2.1 interactive implementation](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/msal-node-v7.2.1/lib/msal-node/src/client/PublicClientApplication.ts)
creates its own loopback listener and closes it only in its `finally` block;
the [request type](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/msal-node-v7.2.1/lib/msal-node/src/request/InteractiveRequest.ts)
exposes no cancellation signal or listener handle. Racing its promise against
an abort would not stop that listener or prevent later token acquisition.
The connector's 15-second default deadline also includes token acquisition, so
an interactive sign-in must not be started inside its provider callback.
Before enabling sign-in, establish and test a supported cancellable flow, including
closing the listener, invalidating late results and clearing the in-memory cache.
Do not treat a timeout, abandoned browser, or dismissed dialog as cancellation.

Device code is a documented alternative, not a way around the installation
blocker. Microsoft describes its [device authorization protocol](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
and MSAL's [device-code request cancellation](https://azuread.github.io/microsoft-authentication-library-for-js/ref/types/_azure_msal_node.DeviceCodeRequest.html).
In the [7.2.1 implementation](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/msal-node-v7.2.1/lib/msal-node/src/client/DeviceCodeClient.ts),
the cancel flag is checked between polling iterations; it does not abort an
in-flight token request, and a successful in-flight response can still be
processed after cancellation. A host must independently reject late results,
prevent their use, and clear the library's in-memory cache. Device-code
cancellation does not imply server-side revocation.

A dependency-free protocol implementation is theoretically possible, but is
not included: Node's cryptographic primitives do not themselves implement
OIDC validation. A custom implementation would need independent security review
of strict signed ID-token validation, trusted tenant-specific discovery and key
rollover, all claim and algorithm checks, bounded network handling, and
cancellation races. Synthetic signatures alone cannot establish that the real
tenant's metadata and policy interoperate. Microsoft recommends a standard
library for [signing-key rollover](https://learn.microsoft.com/en-us/entra/identity-platform/signing-key-rollover);
no approved identity/validation library was installable here. This is a risk
and dependency blocker, not a claim that the device protocol is impossible.
Microsoft also identifies [device code as high-risk](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-authentication-flows)
and recommends blocking it where possible; tenant policy may prohibit it.
Do not weaken Conditional Access or imply the flow was verified. Obtain an
approved, maintained validation implementation and complete adversarial synthetic
tests and security review before a separately authorized live tenant validation.

For a future integration, an administrator must register a public client in the
intended organizational tenant, supply its application/client ID and tenant ID,
and configure the applicable desktop redirect URI (the MSAL system-browser flow
uses `http://localhost`); tenant policy and administrator consent may be needed
for the selected Graph delegated permissions. See Microsoft's
[desktop registration guidance](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration)
and [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference).
No client secret, certificate, existing profile, account, or credentials should
be supplied or inferred. Sovereign clouds are unsupported by this connector.

The host must initiate sign-in from an owner-controlled action, not source content;
display the authenticated account and tenant and require explicit owner confirmation.
Use immutable tenant and user object IDs from the authenticated identity flow,
not email or username, and then call `connect` with those IDs and explicitly
approved source IDs. `/me` must match that same user ID on every operation.
Have the owner separately enable drafts before requesting `Mail.ReadWrite`.
Only request the fixed delegated permissions in the table for chosen sources;
do not request `Mail.Send` or expose a general Graph or Teams-write API.
Keep tokens and identity-library cache solely in host memory. Disconnect must
invalidate pending work and clear that cache; restart requires fresh sign-in.
Protect all host actions with the existing local origin, session and CSRF checks,
and never expose tokens, provider objects, auth response details, or raw errors
to source content, logs, storage, renderer IPC, or connector results. Report
expired, cancelled, denied, mismatched and unavailable states explicitly.
This is an integration requirement, not a claim that the flow is implemented
or has been verified against a live tenant.

## Verification and official references

Run `node --test test\safe-source-connectors.test.mjs`. Tests use fake principals,
messages and injected transports only; they do not obtain tokens or contact Graph.

Public Microsoft documentation consulted 2026-11-11:

- [Current user and delegated `/me`](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0)
- [List mail messages and filter/order constraints](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)
- [Calendar view](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0)
- [Chat messages](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0)
- [Channel root messages](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0)
- [Transcript content and tenant controls](https://learn.microsoft.com/en-us/graph/api/calltranscript-get?view=graph-rest-1.0)
- [Drive item metadata](https://learn.microsoft.com/en-us/graph/api/driveitem-get?view=graph-rest-1.0)
- [Create reply draft](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0)
- [Create reply-all draft](https://learn.microsoft.com/en-us/graph/api/message-createreplyall?view=graph-rest-1.0)
- [Immutable Outlook IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id)
- [Message read-back and plain-text body preference](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0)
- [Documented unique-body property](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0)

The reference application's public-facing local README was inspected read-only to
understand observable draft-only/read-only workflows and coverage reporting.
No reference implementation, private configuration, identifiers, schemas,
personal data, or organizational reporting logic was copied.
