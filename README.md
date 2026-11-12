# Esquie local workspace

> **STOP: Do not start this baseline until the workspace-ownership fix lands.** Startup can alter an unrelated existing database before proving it belongs to this recreation. Do not point it at an original installation or existing workspace. This source baseline is not safe to run pending that fix.

An independently authored, local-first chief-of-staff workspace: tasks and conversations, an unsent draft studio, a durable worker, local documents, owner-entered accounts/outcomes, and an optional Windows tray host. It is not a full reproduction of the private reference; see the [feature-by-feature parity report](docs/parity-report.md).

> **Incomplete source baseline, not a release-ready desktop distribution.** The desktop npm audit summary reported **six moderate issues**; advisory/package details were unavailable. No policy-compliant fresh Electron installation or real installer validation has been established. Earlier desktop artifacts have unverified policy provenance and must not be reused, distributed or published. Source publication does not resolve these limits; additional outcome-import and connector work is still in progress.

**Connections are disconnected by default.** Microsoft 365 adapters require a trustworthy, separately authorized host token provider; no sign-in provider is installed here. Copilot remains unavailable until an audited runtime and identity boundary exist. No tests access real accounts.

## Requirements and startup

- Node.js **22.13 or newer** with `node:sqlite` (a current stable Node 24 release is recommended).
- Windows for the desktop wrapper and verified Windows ACL protection.
- The web host also has POSIX permission checks, but macOS/Linux runtime parity has not been verified.

The web host has no third-party runtime dependencies:

```powershell
git clone https://github.com/alanhkim/Esquie_copilot_desktop_app.git
Set-Location Esquie_copilot_desktop_app
npm ci
npm start
```

Open the **private launch file** whose path is printed, then click **Open Esquie on this device**. A bare loopback address does not authorize workspace access. Keep the launch file private; its capability changes each startup and is removed on normal shutdown. Stop with `Ctrl+C`. The listener never binds to a LAN address. Another port, including `0` for an OS-selected port, can be selected before startup:

```powershell
$env:ESQUIE_PORT = '4318'
npm start
```

[.env.example](.env.example) is a credential-free settings reference, **not automatically loaded**. Do not put credentials in it. The optional [Windows desktop host](desktop/README.md) provides a sandboxed window, close-to-tray, explicit Quit, single-instance behavior, and opt-in installed-app startup. It uses its own dynamic loopback port and stops only its own server. Its portable lockfile uses the approved configured registry. An isolated restore without lifecycle scripts passed; a complete lifecycle-enabled install remains unverified. Never bypass package or organization policy.

For desktop, after quitting any existing desktop instance:

```powershell
npm --prefix desktop ci
npm --prefix desktop start
```

These commands require policy-permitted installation scripts and Electron downloads. The no-lifecycle-script validation does not establish a fresh complete desktop installation.

## Local workflows

- **Setup:** optional, resumable first-run profile/timezone, manager/people, portfolio, workspace label, writing style, outcomes, nonsecret source configuration and review. Skip/resume without losing saved progress; edit settings and local records later. Setup never verifies identity, authorizes sources, relocates storage or creates demo data.
- **Task board:** create/edit/search/prioritize/date/complete/reopen tasks; creation dates and per-task timelines record real changes, notes and evidence. Legacy unknown dates/history remain unknown. Optimistic revisions prevent stale edits from overwriting newer work.
- **Task notes:** retain owner conversations and original links as inert context. Exact links deduplicate within a task. Source-based tasks require explicit review and a currently verified owner; repeated imports retain the existing task, including its completed status.
- **Ask Esquie:** deterministic task outlines and preserved owner-provided meeting notes, explicitly not AI research. The production assistant reports its precise disconnected reason and never submits or stores rejected prompts.
- **Draft Studio:** editable local unsent drafts. A separate, explicitly authorized Outlook reply flow creates only an unsent same-thread reply/reply-all draft and verifies its body, unique reply text, conversation and draft flag. It never sends/deletes email or syncs local draft text automatically.
- **Activity:** durable queued/running/completed/partial/failed/interrupted states, attempt counts, explicit retries, bounded source evidence and local document results. Running work interrupted by host termination is not replayed.
- **Accounts / Monthly Outcomes:** owner-provided local notes and strategic-engagement entries, not imported or verified business reporting. Pipeline remains honestly unavailable.
- **Operations:** local display name, email, role, manager, timezone, writing preferences, connection/consent controls, pause and timezone-aware quiet hours.
- **Scheduling:** off by default; when enabled, bounded source attempts run no more than every 30 minutes while the host is open. Mail uses a trailing 14-day window and calendar a following 14-day window; pinned Teams/transcript/file reads have their own bounded coverage. These are not exhaustive task discovery or sync.
- **Documents / demo:** local Markdown output requires separately approved non-synced storage and fixed-volume verification. Demo configuration is off by default and each run needs an explicit fake-only request. The generator accepts no customer/source input and creates only a fixed synthetic local document, never a repository or cloud resource.
- **Backups:** manually queue a consistent private SQLite snapshot, or opt into one attempt per profile-local calendar day while the host is open, respecting pause/quiet hours. Output approval is rechecked. Coverage is explicitly partial: local document files are excluded (metadata only), and disconnected/unavailable sources are not checkpoints. Failures appear in Activity; no automatic pruning deletes old or unrelated files.

## Connections and safety

The independently authored [Microsoft 365 adapter](docs/safe-source-connectors.md) supports bounded inbox/calendar reads, pinned read-only Teams chats/channels/transcripts, selected file metadata and unsent reply drafts. Source IDs, permissions and consent are explicit. Owner verification is **not** source permission verification: availability stays unverified until a successful bounded read, and is reset on failures/reconnect/disconnect. Source text/HTML is rendered as untrusted text, never commands.

`startServer({dataDir, port})` returns `{server, url, launchUrl, launchFile, accessToken, dataDir, worker, close}`; `close()` is idempotent. Trusted desktop hosts load `launchUrl`, never the bare `url`, and must not log the capability-bearing URL. Trusted integration hosts can additionally supply `microsoft365Options: {tokenProvider, transport?}`. Provider/transport functions are host-only, never browser inputs. A provider must authenticate and validate the current delegated principal through an approved authentication library; merely decoding a JWT or entering IDs is not sufficient. See the adapter's prerequisites and exact interface. No provider, token cache, app registration, device-code flow, or ambient account fallback is implemented.

The [assistant bridge](docs/assistant-bridge-integration.md) never exposes its synthetic test factory in production. The isolated runtime audit observed unwanted synthetic MCP process startup and managed-settings/team-customizations network attempts despite empty tool/MCP settings. This is a process/network isolation blocker, not just a version mismatch; an empty reported tool inventory is insufficient. No Copilot binary is bundled or downloaded by the application; production sessions stay disabled. Planner/To Do and Teams/reporting writes are unavailable.

All sensitive API reads and mutations require an unguessable, per-start owner capability. It is delivered only through the protected local launcher or trusted desktop host as `/#access=<43-character base64url token>`, never an HTTP query, log or unauthenticated API response. The renderer removes the fragment and retains it in per-window, origin-specific session storage for reloads. If that storage is unavailable, the UI warns that reopening the launcher is required after reload. Only minimal health and public shell assets are unauthenticated.

Mutation APIs additionally require the current loopback Host, same-origin request and a separate per-start CSRF token. Sensitive cross-site requests are refused and a restrictive CSP is applied; only navigation to the harmless public root shell is permitted for the private launch link. A stale crash launcher is safely replaced under the exclusive workspace lock; old capabilities stop working after restart. A modified/unrelated launcher is never silently overwritten or deleted. This owner-scoped capability is **not human identity proof or encryption**: an administrator, malware, another same-user process, or a compromised browser profile remains outside the boundary. Do not share the launch file or copy its link into chat, screenshots or backups intended for other users.

## Storage, output and upgrades

| Host | Default data location |
|---|---|
| Web | `%USERPROFILE%\.esquie-local` |
| Windows desktop | `%LOCALAPPDATA%\EsquieLocal\Workspace` |

These are **separate default workspaces**, not automatically shared state. Safe reuse/attachment to another running host is not implemented. To use the desktop workspace from standalone, first explicitly **Quit** the desktop host (closing its window only hides it), then run:

```powershell
$env:ESQUIE_DATA_DIR = Join-Path $env:LOCALAPPDATA 'EsquieLocal\Workspace'
npm start
```

Stop standalone before reopening desktop. Never remove the exclusive lock to run both against one workspace.

An ordinary browser can also use the existing desktop host's protected `esquie-launch.html` without starting another server; keep the file/link private. Automatic desktop attachment/handoff to an existing standalone host and workspace selection in the desktop UI are not implemented.

`ESQUIE_DATA_DIR` can select another private, local, non-synced directory. State lives in `workspace.sqlite`, with transactional SQLite WAL persistence and an exclusive host lock. Do not open the same workspace in two hosts. A first upgrade from the earlier `workspace.json` imports it once and leaves the original unchanged. Unknown/newer formats fail closed instead of being reset or downgraded.

On Windows, a newly created empty app directory receives current-user/SYSTEM/Administrators ACLs. Existing directory and app-state ACLs are inspected, **not replaced**; shared grants, unverifiable ownership or unsafe ancestor replacement permissions block startup. System PowerShell runs with an allowlisted environment and system module path; unavailable permission inspection also blocks startup. On POSIX, current-owner/private mode checks apply. Storage is plaintext, not encrypted; use protected-device encryption and private local backups.

Document output is off until the owner attests that the destination is private and not synchronized. Every write rechecks approval, known/custom sync roots, symlink/junction containment and fixed-local-volume eligibility. Network/removable/redirected/unverifiable destinations are blocked. **Unknown sync agents cannot be detected universally.** Do not approve a synced folder; add custom roots through `ESQUIE_SYNC_ROOTS`, a JSON array of absolute paths. Documents use generated filenames and are never uploaded.

To update, quit the host, back up the private data directory locally, update application code through your normal Git workflow, then run `npm ci` and restart. Do not delete the data folder or force-reset local changes. Installer updates also keep data separate; downgrade is not supported. Recent activity display is limited to 100 entries; durable job/document/draft-operation records are retained separately.

From a clean checkout, with all hosts stopped and private data backed up:

```powershell
git status --short
# Proceed only if the checkout is clean; preserve any local changes first.
git pull --ff-only
npm ci
# Also restore desktop dependencies if you use the desktop host:
npm --prefix desktop ci
```

For an in-app snapshot, approve the private non-synced local destination in Operations, then choose **Queue private backup**. A daily failure is not repeatedly retried that day. Snapshots and SHA-256 manifests live under `backups`; they exclude the owner launch capability, lock, and document file contents. Partial/incomplete artifacts are preserved for review rather than silently pruned.

**Prepare separate paused recovery** verifies snapshot integrity and creates a new generated directory under `recoveries`, never overwriting the active workspace. It disables schedules/output/demo approval, disconnects saved source consent and interrupts historical queued work. Document metadata remains visibly unavailable. Quit the owning host, set `ESQUIE_DATA_DIR` to the displayed recovered directory and start standalone to inspect it; explicitly reconnect/reapprove/resume only after review. Desktop workspace selection is not implemented. Keep a separate private cold copy of document files if needed; state-only snapshots do not restore them.

## Verification

```powershell
npm test
npm run smoke
npm --prefix desktop test
```

Tests use fresh synthetic data, injected transports and temporary storage. The smoke check serves the actual UI, creates a fake task/draft/note/job, closes the server, restarts against SQLite, verifies persistence and removes its temporary data.

**Desktop validation provenance correction:** earlier successful dependency install/rebuild commands relaxed npm remote/script restrictions. Graphical lifecycle, file-origin navigation, packaged-resource and unsigned-build results were observed using artifacts with unverified policy provenance, not a clean policy-compliant install. Those artifacts must not be reused, distributed or published; existing artifacts/caches are left untouched. The later portable-lockfile restore without lifecycle scripts and official Node 22.13 checks are separate results. Native tray-menu clicks and installer install/upgrade/uninstall remain unverified. Exact results, audit limitations, remaining functionality and unavailable reference screenshots are recorded in the [parity report](docs/parity-report.md).

## Provenance

No private reference source/history, reporting schemas/business logic, profile/configuration data, credentials, databases, logs, caches or bundled binaries were copied. The reference has no selected open-source license and organizational publication approval was not established. This is not a licensed redistribution of that application. Obtain the necessary permissions before importing its source, artwork, branding or private-derived material.
