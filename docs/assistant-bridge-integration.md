# Copilot assistant bridge

## Availability and prerequisites

**Live Copilot is unavailable, not connected.** The default production interface
does not discover/load SDKs, launch processes, read profiles or credentials, or
call services. The separately authorized offline audit installed the official
CLI 1.0.109 and tested its extracted SDK: an empty model tool inventory still
allowed a profile-configured MCP process to start. Therefore the required
process/configuration boundary is not proved, and explicit consent alone cannot
override this gate. No real identity, authentication, connector, or model was
used. The synthetic interface remains a development harness, not a connection.

Node.js 20+ is sufficient for the bridge and its dependency-free synthetic tests:

```powershell
node --test test\assistant-bridge.test.mjs
```

The installed-runtime audit is opt-in and skipped by default. It requires the
exact approved CLI and extracted SDK fingerprints recorded below:

```powershell
$env:ASSISTANT_AUDIT_SDK_PATH = '<approved extracted SDK index.js>'
$env:ASSISTANT_AUDIT_CLI_PATH = '<approved standalone CLI copilot.exe>'
node --test test\assistant-bridge.test.mjs
```

These are trusted developer test settings, not production connection settings.
Tests verify hashes before importing code or starting the executable, use fresh
temporary profiles and loopback-only fake identity endpoints, and never send a
model prompt. The audit includes a deliberately configured local MCP probe that
only writes a marker inside its temporary test directory. Its unexpected startup
is a **negative capability finding**, not permission to enable that capability.

No reference-application source, branding, configuration, schema, personal content,
or credentials were imported. This is independently authored from the supplied
workflow requirements and public official SDK interfaces.

## Host contract

Import `createAssistantBridge` from `src/assistant/bridge.mjs`. Instantiate once
per local owner; never expose construction or test-provider injection over HTTP.
The bridge is not a queue, source adapter, authorization server, or durable store.
The core host owns origin/CSRF checks, OS-user access, queue persistence, UI states,
and any separately controlled source retrieval.

```js
const assistant = createAssistantBridge();
const connection = assistant.connect({
  explicitUserAuthorization: true,
  currentUserOnly: true,
  allowModelRequest: true
});
// connection.state === 'disconnected'; connection.code === 'runtime-unverified'
const result = await assistant.submit({
  request: 'Produce a brief using only the supplied evidence.',
  evidence: [{ id: 'source-1', text: 'Adapter-approved untrusted excerpt.' }],
  timeoutMs: 60000
}, { signal: abortController.signal });
```

`connect` accepts only the three true consent acknowledgements shown above.
These are not identity proof. Only the authenticated, current-user host may call
it after an explicit user connection action. A request or source transcript must
never be allowed to set consent. Consent is memory-only, is not persisted, and
must be renewed after restart. `disconnect()` revokes it and cancels in-flight
work. `status()` contains only fixed codes and booleans, not identity or content.

`submit` resolves to:

```js
{
  state: 'disconnected' | 'failed' | 'partial' | 'completed',
  code: 'fixed-machine-readable-code',
  simulation: false,
  text: '',
  outputKind: 'untrusted-text'
}
```

The production bridge currently returns only disconnected outcomes. Its fixed
codes are `authorization-required` and, after consent, `runtime-unverified`.
Status adds `availability: 'unavailable'`; do not render this as a successful
connection, sync, authentication, or completed work. There is no live enable flag.

The synthetic harness also exercises `invalid-request`, `invalid-signal`, `busy`,
`cancelled`, `timeout`, `disconnected`, `provider-failed`, `empty-response`,
`output-limit`, `unsafe-action-blocked`, `cleanup-failed`, and `generated`.
It always marks results `simulation: true` and status `synthetic-only`.
**Never enqueue or publish a simulated result as real completed work.**

The core queue owns `queued` and `running`. Mark work running only when execution
actually begins; map the returned terminal state without converting failures into
success. Cancellation with no output is failed/cancelled, with output is partial.
There is no automatic retry, session resume, conversation history import, or
scheduled/background runner. After process termination, the host must mark
interrupted running entries partial/failed; never infer completion.

Bounds are 8,000 UTF-16 code units for the request, 16 evidence entries (each only
`id` and `text`), 80 for an evidence id, 32,000 total evidence code units,
32,000 output code units, and 1-120,000 ms per execution (60,000 default).
Unknown request/evidence properties, empty text, and recognizable credential
patterns are rejected. No truncation of input happens silently. Output overflow
is explicitly partial. Cleanup gets a separate 1-second deadline.

## No-tools boundary and synthetic provider contract

`createSyntheticAssistantBridge({ createSession })` accepts a fake SDK-shaped
factory written in trusted test code. This seam is **not** a production SDK
loader or a security sandbox for arbitrary JavaScript. Never pass a real SDK,
credentials, CLI path, browser-supplied factory, or live transport to it.

The fake receives frozen session options: `availableTools: []`, `tools: []`,
`mcpServers: {}`, `customAgents: []`, `skillDirectories: []`, a deny-all
`onPermissionRequest`, and rejecting user interaction. Configuration discovery,
skills, hooks, host git operations, shared session storage, instruction discovery,
session telemetry, memory, and scheduling are explicitly disabled. Instructions,
plugin roots, hook roots, builtin skills, and additional directories are empty;
custom instructions are skipped, permission mode is manual, and MCP OAuth and
embedding-cache storage are memory-only. These explicit session controls match
the pinned public interfaces below; they do not prove an installed runtime
implements them. The fake returns:

- `on(listener)`: subscribe to SDK-shaped delta/error/tool events, returning an
  unsubscribe function.
- `sendAndWait({ prompt })`: return an assistant message with `data.content`.
- `abort()`: stop outstanding work on cancellation, timeout, disconnection, or a
  denied action.
- `disconnect()`: release the isolated test session, after abort if interrupted.
  An abort failure still attempts disconnection and quarantines the bridge.

The pinned SDK exposes session `abort()` and `disconnect()`, not `destroy()`.
Session disconnection is not proof that the CLI process exited or persisted
history was erased. A future real provider must also own its client and verify
`client.stop()` results and process exit; it cannot pass a raw SDK session to the
synthetic seam and assume safe teardown.

No shell, filesystem, unrestricted MCP, Planner/To Do, mail send/delete, Teams
writes, reporting mutation, cloud output, attachments, or adapter callbacks are
registered. Permission requests are rejected by host code, not just prompt prose.
Any attempted tool event or permission request fails closed and discards output.
This is defense in depth for the fake, not evidence that an unknown real runtime
cannot execute a tool before emitting an event.

Each explicit request creates a fresh session. Historical messages/transcripts
are serialized under `untrustedEvidence`, separate from `explicitUserRequest`;
they never modify session configuration or become system instructions.
Delimiters do not eliminate model prompt injection. The actual action boundary
is the absence of tools and absence of any output executor.

Model output is **always untrusted plain text**. Render with text-safe controls,
not HTML, and never parse it into commands, source queries, URLs to fetch,
connection operations, or automatic task/draft mutations. Draft text requires
human review and can only be saved locally as unsent text by a separate host
action. Nothing here creates or sends Outlook messages. Teams/reporting remain
read-only and separately authorized; no cloud document writes are implemented.
Research is synthesis of supplied evidence, not live autonomous research.

## Secrets and local state

There are no credential parameters, files, logging hooks, console output, or
durable bridge state. Provider exceptions and cancellation reasons are converted
to fixed codes; raw errors, event metadata, and tool arguments are not returned.
Only bounded plain text deltas/final content enter the result. Familiar GitHub
tokens, bearer strings, private-key blocks, JWT-shaped strings, credential URLs,
and key/value secret patterns are
rejected on input and redacted on output as additional defense. Pattern matching
is not a universal secret detector: **do not supply credentials in content**.
The host/adapters must filter secrets and approved evidence before submission;
the model can repeat anything submitted to it. Do not log prompts or results.

The bridge stores no prompts/results beyond execution and does not guarantee
memory erasure in JavaScript. The host must keep any durable queue, evidence,
local drafts, and future SDK state outside source control and cloud-synced
folders, with private current-user permissions/Windows ACLs. Never store
credentials in queue rows or connection settings. Do not persist consent or
serialize provider/session objects. A failed cleanup quarantines the bridge;
late-created cancelled test sessions are aborted and disconnected when they
arrive. An uncooperative fake can outlive a deadline; this harness cannot kill an
arbitrary provider or guarantee process termination. No real process is started.

## Live integration gaps and required verification

Official interfaces audited on 2026-11-11, pinned to SDK release `v1.0.31`, tag
commit `15de061c7c871e34698a74e353e9afbf0250a1a3`:

- [Release metadata](https://github.com/github/copilot-sdk/releases/tag/v1.0.31)
- [SDK options and session types](https://github.com/github/copilot-sdk/blob/15de061c7c871e34698a74e353e9afbf0250a1a3/nodejs/src/types.ts)
- [Client implementation: empty mode, environment and shutdown](https://github.com/github/copilot-sdk/blob/15de061c7c871e34698a74e353e9afbf0250a1a3/nodejs/src/client.ts)
- [Session abort and disconnection interfaces](https://github.com/github/copilot-sdk/blob/15de061c7c871e34698a74e353e9afbf0250a1a3/nodejs/src/session.ts)
- [Local CLI configuration](https://github.com/github/copilot-sdk/blob/15de061c7c871e34698a74e353e9afbf0250a1a3/docs/setup/local-cli.md)
- [Authentication and session-scoped token providers](https://github.com/github/copilot-sdk/blob/15de061c7c871e34698a74e353e9afbf0250a1a3/docs/auth/authenticate.md)
- [Versioned source package metadata](https://github.com/github/copilot-sdk/blob/15de061c7c871e34698a74e353e9afbf0250a1a3/nodejs/package.json)

The current public SDK documents an `empty` client mode, explicit
`availableTools`, explicit runtime connection paths, `baseDirectory`,
`useLoggedInUser`, and permission handlers. Defaults are not acceptable here:
client mode defaults to CLI behavior, Node SDK can bundle a CLI, the runtime can
inherit environment variables, and logged-in-user credential lookup defaults on.
The previously consulted upstream main branch is mutable; the follow-up audit
uses the commit-pinned sources above, not main.
In particular, empty arrays or a deny handler alone do not prove suppression of
profile MCP servers, skills, plugins, ambient instructions, or runtime side effects.

### Authorized installation and actual runtime audit

The initial metadata-only inventory found workspace/global SDKs absent and older
CLI versions; no existing installation, profile, account or credential was used.
The subsequent clarification authorized pinned public dependency installation.
An isolated npm installation was attempted with empty user/global configuration,
an allowlisted environment, lifecycle scripts disabled and a private cache.
The npm registry failed with `ERR_SSL_TLS_ALERT_HANDSHAKE_FAILURE`. .NET, curl
(including TLS 1.2), and alternate registry checks also failed TLS negotiation.
TLS verification was never disabled, and user npm settings were not loaded.

The official [CLI 1.0.109 GitHub release](https://github.com/github/copilot-cli/releases/tag/v1.0.109)
was reachable. Its standalone Windows archive was downloaded, checked against
the release API's SHA-256, and extracted only into ignored audit dependencies.
Running `--help` under a new empty home exposed the official extension SDK.
This is the freshly installed public distribution, not an unrelated app's SDK.
No SDK/CLI source or binary is committed or redistributed by this change.

| Audited artifact | Exact SHA-256 |
| --- | --- |
| Official `copilot-win32-x64.zip`, release 1.0.109 | `794c16bcc5535cdf478598d6cf4af3228daec3b7801bfa3540c56b8d3524beee` |
| Extracted standalone `copilot.exe`, PE version 1.0.109 | `83967cd5f12ac86df19b816e6595d997bc4479fa56f1822a4f776894affa2d0a` |
| CLI-extracted `copilot-sdk/index.js` | `46937940a1bb3fb72498e70c3df3526347dca50c7d6f32e2a98337dbf78ff6f0` |

The embedded SDK is pinned by its official distribution and exact file hash; its
generated CLI-version constant is a development placeholder. It is **not**
claimed to be the independently installed npm SDK 1.0.31. Public CDN metadata
for that npm version was readable and declares CLI 1.0.109, but its complete
registry artifact/dependency integrity was not established or installed. The
SDK source requires Node `^20.19.0 || >=22.12.0`; tests here ran on
`v27.0.0-alpha.0.0.0`, not a certified stable production Node release.

The committed opt-in tests use the actual SDK and standalone CLI, not a fake
SDK that merely accepts unknown options. They explicitly pass stdio paths,
`mode: "empty"`, a new state directory and working directory, a replacing
environment, `useLoggedInUser: false`, `logLevel: "none"`, all bridge policy
controls, and these supported CLI options:

```text
--disable-builtin-mcps --disable-client-telemetry
--no-eager-powershell-resolution --no-custom-instructions
--no-experimental --sync-session=off --no-bash-env
```

`HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, and
`COPILOT_HOME` point only to temporary audit locations. Keychain access and
OpenTelemetry are disabled. The SDK's `internalTestOptions` routes synthetic
GitHub/Copilot API traffic exclusively to a loopback mock; these unsupported
test-only overrides are never used as production configuration.

| Gate | Actual observed result |
| --- | --- |
| SDK/runtime compatibility | Handshake reports CLI 1.0.109 and protocol 3; missing `availableTools` is rejected in empty mode |
| Visible tool inventory | `initializeAndValidate()` followed by `getCurrentMetadata()` returns `{ tools: [] }`; permission mode is manual |
| Ambient profile process startup | **Failed safety expectation:** a controlled MCP configured in the temporary `mcp-config.json` starts and writes its marker despite `mcpServers: {}`, discovery disabled and empty visible tools |
| Source MCP fixture | Separate `.mcp.json` fixture did not start its marker process in the observed run |
| Authorization cancellation | Synthetic `gitHubTokenProvider` cancellation rejects session creation; no fallback identity/API request occurs |
| Account configuration reads | Fake identity acquisition automatically issues GETs for `/copilot_internal/managed_settings` and `/copilot_internal/team_customizations`, even with `enableManagedSettings: false` and empty organization instructions |
| Local credential persistence probe | The invented token does not appear in files under the complete temporary audit root after shutdown |
| Runtime shutdown | `session.disconnect()` plus `client.stop()` completes with no reported errors; the SDK-owned child PID no longer exists |
| Production gate | Remains disconnected with `runtime-unverified`; the tested runtime cannot be enabled merely because its inventory is empty |

The profile MCP fixture runs only a bounded Node program that writes one marker
inside its own temporary directory and exits. No real MCP, cloud source, shell
tool, personal content, real token, live authentication, or model prompt is used.
The negative-capability test asserts the observed startup gap **and** asserts
that production stays unavailable. Passing this audit test means the application
did not misclassify the runtime as safe; it does not mean the vendor behavior met
the safety expectation.

An inventory check occurs too late to prevent the demonstrated configuration
side effect. A fresh private home is necessary, but was not established as
sufficient for every remotely supplied customization, plugin, hook, or error
path. The observed remote reads are requests to a synthetic loopback server, not
proof that real enterprise data was loaded or that those responses became model
instructions. No inference about untested versions is made.

**Concrete blocker:** supported no-tools/discovery settings alone are not a
proved no-process/no-ambient-configuration boundary for this exact installed
distribution. No guarded live provider was enabled. Solving this requires a
verified suppression mechanism or an independently enforced process/filesystem/
network boundary, not a stronger prompt, inventory-only preflight, or assumption
that an SDK silently honors a flag. Real current-user broker integration and all
live model/service behavior also remain untested.

Before adding a production provider, a separate reviewed implementation must:

1. Select approved, integrity-verified SDK and separately installed CLI artifacts,
   using a stable supported Node release. No bundled CLI, runtime download,
   retired runner, PATH guessing, or remote attachment during production use.
2. Resolve and re-test the demonstrated ambient MCP startup gap before sending
   content, including remote customizations, plugins, hooks, deferred MCP tools
   and subagents. A tool inventory of zero is not sufficient. Missing or ignored
   controls must make the provider unavailable, not trigger fallback.
3. Use an isolated private state directory and allowlisted environment, never
   the source checkout or ambient user profiles. Disable content telemetry/logs.
   Verify subprocess shutdown and no persistence outside the protected directory.
4. Implement explicit current-user identity authorization without ambient
   token/profile fallback, identity switching, or tokens in host state/logs.
   This task deliberately did not inspect or exercise the user's identity.
5. Extend the installed-runtime harness to all denial, refresh, crash and cleanup
   paths; verify no content/credentials in SDK host console output as well as
   runtime files. Enable real model calls only after separate authorization.
6. Wire the queue and separately controlled evidence adapters. No live SDK,
   source retrieval, cloud draft creation, queue persistence, HTTP endpoint, or
   desktop connection UI is implemented in this scoped change.

Until then, the default disconnected production bridge is the enforced boundary,
not a pretend successful connection. The installed-runtime tests demonstrate
specific capabilities and a specific blocking gap, not Copilot service access,
universal SDK safety, or permission to use a real account.
