# Esquie local workspace

An independently authored, local-first chief-of-staff workspace: tasks and conversations, an unsent draft studio, a durable worker, local documents, owner-entered accounts/outcomes, and an optional Windows tray host. It is not a full reproduction of the private reference; see the [feature-by-feature parity report](docs/parity-report.md).

> **Incomplete source baseline, not a release-ready desktop distribution.** The desktop npm audit summary reported **six moderate issues**; advisory/package details were unavailable. No complete policy-compliant fresh desktop installation or real installer validation has been established. Earlier desktop artifacts have unverified policy provenance and must not be reused, distributed or published. Source publication does not resolve these limits; additional connector and identity assessments are still in progress.

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

[.env.example](.env.example) is a credential-free settings reference, **not automatically loaded**. Do not put credentials in it. The optional [Windows desktop host](desktop/README.md) provides a sandboxed window, close-to-tray, explicit Quit, single-instance behavior, and opt-in installed-app startup. It uses its own dynamic loopback port and stops only its own server. Its portable lockfile uses the approved configured registry. An isolated restore without lifecycle scripts passed. A separate fresh restore exited 0 but policy blocked `electron-winstaller@5.4.0`'s lifecycle script; a complete desktop installation, runtime and installer remain unverified. Never bypass package or organization policy.

For desktop, after quitting any existing desktop instance:

```powershell
npm --prefix desktop ci
npm --prefix desktop start
```

These commands require policy-permitted installation scripts and Electron downloads. The no-lifecycle-script validation does not establish a fresh complete desktop installation.

## Local workflows

- **Setup:** optional, resumable first-run profile/timezone, manager/people, portfolio, workspace label, writing style, outcomes, nonsecret source configuration and review. Skip/resume without losing saved progress; edit settings and local records later. Setup never verifies identity, authorizes sources, relocates storage or creates demo data.
- **Task board:** create/edit/search/prioritize/date/complete/reopen tasks; search includes each task's own local conversation text and evidence titles, notes and URLs, respecting the completed-task filter. Drag the handle between active lanes, or choose a destination and explicitly press Move using keyboard or touch. Selecting a lane alone changes nothing; completion/reopening requires its named button, never a drag. Moves preserve revision checks and completion/reopen history. Within-lane ordering is not customizable. Creation dates and per-task timelines record real changes, notes and evidence. Legacy unknown dates/history remain unknown. Optimistic revisions prevent stale edits from overwriting newer work.
- **Task notes:** retain owner conversations and original links as inert context. Exact links deduplicate within a task. Source-based tasks require explicit review and a currently verified owner; repeated imports retain the existing task, including its completed status.
- **Ask Esquie:** deterministic task outlines and preserved owner-provided meeting notes, explicitly not AI research. The production assistant reports its precise disconnected reason and never submits or stores rejected prompts.
- **Draft Studio:** editable local unsent drafts. A separate, explicitly authorized Outlook reply flow creates only an unsent same-thread reply/reply-all draft and verifies its body, unique reply text, conversation and draft flag. It never sends/deletes email or syncs local draft text automatically.

  Selecting **Review an unsent reply** retains that exact bounded source preview beside the reply editor as read-only, incomplete, untrusted evidence, not a complete thread or verified participants. Selection is window-memory only and does not fetch sources or authorize writes. Copy and clear any unsaved reply before switching previews or the exact message ID; changes reset reply-all, and manual ID changes clear the preview (typing an old ID back does not restore it). Pending draft requests lock the composer and source selection. Reload loses the unsaved reply/preview, not the durable operation ledger; inspect Outlook manually after an uncertain result.

  Preview-driven requests carry the stored job, source-result revision and item key. Before any draft operation or Graph request, the server requires that exact mail result/item/message ID to still exist and belong to the currently verified owner. Account switches, missing/replaced evidence and disconnection fail closed without falling back to an unbound reply. Older previews without a valid result revision visibly disable draft creation and explain the required new explicit bounded source check; attempted submission retains unsaved text without making a request or falling back to manual-ID mode. Manually entered IDs remain supported without a source-match claim; all existing authorization and same-conversation verification still apply.

  Activity's **Review a new local task** also binds task creation to the selected job/source/result revision/item. The server validates current evidence and the currently verified owner after reading the complete request body, before creating or deduplicating any task. A replaced result is rejected even if the same item key still exists; selecting a newer valid preview can retain an already-completed task without reopening or rewriting it. Legacy task previews visibly require a new explicit bounded check, and rejected saves retain entered task text without falling back to a manual task. Evidence never proves task ownership or an outstanding assignment.

  New source-created task evidence saves the validated local job/result UUIDs and hashed source item key alongside the selected title/link/excerpt. These historical provenance references and saved evidence survive restart and later source retries without being replaced during deduplication. Legacy evidence remains unchanged; missing provenance is never invented.
- **Activity:** durable queued/running/completed/partial/failed/interrupted states, attempt counts, explicit retries, bounded source evidence and local document results. Running work interrupted by host termination is not replayed.
- **Accounts / Monthly Outcomes:** owner-provided local notes and strategic-engagement entries, plus a bounded Markdown/TSV workshop paste preview. Import requires explicit review, skips duplicates, reports conflicts without overwriting existing entries, preserves missing statuses as “Not provided,” and stores source URLs only as inert links. Future-delivered date checks use the configured owner timezone. This is not a Loop/CRM/reporting sync or verified business reporting. Pipeline remains honestly unavailable.
- **Operations:** local display name, email, role, manager, timezone, writing preferences, connection/consent controls, pause and timezone-aware quiet hours.
- **Scheduling:** off by default; when enabled, bounded source attempts run no more than every 30 minutes while the host is open. Mail uses a trailing 14-day window and calendar a following 14-day window; pinned Teams/transcript/file reads have their own bounded coverage. These are not exhaustive task discovery or sync.
- **Documents / demo:** local Markdown output requires separately approved non-synced storage and fixed-volume verification. Task summaries use the current board at file creation; general summaries exclude completed tasks, while an explicitly selected task is included even if completed. Demo configuration is off by default and each run needs an explicit fake-only request. The generator accepts no customer/source input and creates only a fixed synthetic local document, never a repository or cloud resource.
- **Backups:** manually queue a consistent private SQLite snapshot with eligible generated Markdown files, or opt into one attempt per profile-local calendar day while the host is open, respecting pause/quiet hours. Output approval is rechecked. Missing or unverifiable documents are reported as unavailable; disconnected/unavailable sources are not checkpoints. Failures appear in Activity; no automatic pruning deletes old or unrelated files.

## Connections and safety

The independently authored [Microsoft 365 adapter](docs/safe-source-connectors.md) supports bounded inbox/calendar reads, pinned read-only Teams chats/channels/transcripts, selected file metadata and unsent reply drafts. Source IDs, permissions and consent are explicit. Owner verification is **not** source permission verification: availability stays unverified until a successful bounded read, and is reset on failures/reconnect/disconnect. Source text/HTML is rendered as untrusted text, never commands.

An optional standalone adapter method can read one explicitly selected UTF-8 plain-text file through a separately approved exact host, with size/revision checks and destination-pinned HTTPS without forwarding Graph bearer or cookie headers. The short-lived signed download URL stays transient in memory. It has **no app route or content UI, no production sign-in, and no working default Windows transport**: Windows system/enterprise proxy policy cannot be established, so downloads fail closed before DNS. The app worker remains metadata-only. This is not a live connected source workflow; see the adapter documentation for the trusted-host and network-policy prerequisites.

`startServer({dataDir, port})` returns `{server, url, launchUrl, launchFile, accessToken, dataDir, worker, close}`; `close()` is idempotent. Trusted desktop hosts load `launchUrl`, never the bare `url`, and must not log the capability-bearing URL. Trusted integration hosts can additionally supply `microsoft365Options: {tokenProvider, transport?}`. Provider/transport functions are host-only, never browser inputs. A provider must authenticate and validate the current delegated principal through an approved authentication library; merely decoding a JWT or entering IDs is not sufficient. See the adapter's prerequisites and exact interface. No provider, token cache, app registration, device-code flow, or ambient account fallback is implemented.

The [assistant bridge](docs/assistant-bridge-integration.md) never exposes its synthetic test factory in production. The isolated runtime audit observed unwanted synthetic MCP process startup and managed-settings/team-customizations network attempts despite empty tool/MCP settings. This is a process/network isolation blocker, not just a version mismatch; an empty reported tool inventory is insufficient. No Copilot binary is bundled or downloaded by the application; production sessions stay disabled. Planner/To Do and Teams/reporting writes are unavailable.

All sensitive API reads and mutations require an unguessable, per-start owner capability. It is delivered only through the protected local launcher or trusted desktop host as `/#access=<43-character base64url token>`, never an HTTP query, log or unauthenticated API response. The renderer removes the fragment and retains it in per-window, origin-specific session storage for reloads. If that storage is unavailable, the UI warns that reopening the launcher is required after reload. Only minimal health and public shell assets are unauthenticated.

Mutation APIs additionally require the current loopback Host, same-origin request and a separate per-start CSRF token. Sensitive cross-site requests are refused and a restrictive CSP is applied; only navigation to the harmless public root shell is permitted for the private launch link. Any existing workspace lock blocks startup and requires independent ownership/process review before manual action; it is never automatically removed. Only after exclusive workspace access is established can a recognized crash launcher be replaced; old capabilities stop working after restart. A modified/unrelated launcher is never silently overwritten or deleted. This owner-scoped capability is **not human identity proof or encryption**: an administrator, malware, another same-user process, or a compromised browser profile remains outside the boundary. Do not share the launch file or copy its link into chat, screenshots or backups intended for other users.

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

Desktop now honors an explicit `ESQUIE_DATA_DIR` override, with precedence **injected `createDesktop({dataDir})` > nonempty environment override > unchanged desktop default**. To select a verified recreation workspace after quitting its current host:

```powershell
$env:ESQUIE_DATA_DIR = 'C:\path\to\verified-recreation-workspace'
npm --prefix desktop start
```

Set the variable in the environment that actually launches desktop; shortcuts/sign-in startup may not inherit a terminal-only setting. The same privacy, file-ownership and exclusive-lock checks apply. Selection never moves, copies, merges or automatically migrates state. There is still no graphical selector or automatic attachment. Never select the original installation.

`ESQUIE_DATA_DIR` can select another private, local, non-synced directory. State lives in `workspace.sqlite`, with transactional SQLite WAL persistence and an exclusive host lock. A new workspace starts only in an empty directory. Existing workspaces require `workspace.owner`, bound to the local database file identity and canonical schema, plus this recreation's SQLite application ID and supported state. Before locking or opening SQLite, startup validates the WAL header and every frame's salts, checksum chain and schema. An invalid or incomplete WAL is preserved and blocks startup; this deliberately includes recycled WALs containing old trailing frames, even if those frames might be inactive. An unexpected rollback journal likewise blocks startup without modification. Preserve these files for expert recovery or use a verified clean snapshot; do not delete them to force startup. Database and SQLite sidecar files must have a verifiable single link; unsupported link counts and hard links fail closed. These checks prevent accidental misclassification, **not intentional same-user tampering**. Unknown, markerless, or newer data is left unchanged; JSON is never automatically imported. Copying a database to another file or filesystem invalidates its ownership binding: use the explicit adoption procedure below or the app's verified backup recovery instead. Filesystems without a verifiable file ID or compatible schema layout fail closed. Do not open the same workspace in two hosts. Any existing lock, including an apparently stale or malformed one, blocks startup and is never automatically removed. If a crash leaves a lock, first independently verify that the directory is your recreation workspace and all its hosts have stopped; inspect the lock and remove it manually only if you are certain it belongs to that workspace. Never remove an unverified lock.

On Windows, a newly created empty app directory receives current-user/SYSTEM/Administrators ACLs. Existing directory and app-state ACLs are inspected, **not replaced**; shared grants, unverifiable ownership or unsafe ancestor replacement permissions block startup. The workspace binding uses the fixed local volume serial from Windows CIM and the file ID, not Node's runtime-dependent device number. System PowerShell runs with an allowlisted environment and system module path; unavailable permission or volume inspection blocks startup. On POSIX, current-owner/private mode checks apply. Storage is plaintext, not encrypted; use protected-device encryption and private local backups.

Document output is off until the owner attests that the destination is private and not synchronized. A later successfully applied output-approval decision supersedes earlier requests still awaiting validation; a failed grant does not undo a revocation. Every write rechecks approval, known/custom sync roots, symlink/junction containment and fixed-local-volume eligibility. Document and demo approvals are checked again immediately before exclusive file creation; revocation after creation does not cancel a write already in progress. Network/removable/redirected/unverifiable destinations are blocked. **Unknown sync agents cannot be detected universally.** Do not approve a synced folder; add custom roots through `ESQUIE_SYNC_ROOTS`, a JSON array of absolute paths. Documents use generated filenames and are never uploaded.

To update, quit the host, back up the private data directory locally, update application code through your normal Git workflow, then run `npm ci` and restart. Do not delete the data folder or force-reset local changes. Installer updates also keep data separate; downgrade is not supported. Recent activity display is limited to 100 entries; durable job/document/draft-operation records are retained separately.

**Earlier recreation workspaces:** Earlier releases created markerless SQLite databases or `workspace.json`, and prerelease markers used a runtime-specific Windows device number. These cannot be reliably distinguished from unrelated data or opened across all Node runtimes. Never point the adoption command at the original installation or data you cannot identify. Stop the old host and make a private backup first. Create a separate, empty, private, local destination directory outside the source directory, then in an interactive terminal run:

```powershell
node scripts/adopt-legacy.mjs "C:\path\to\verified-recreation-workspace" "C:\path\to\empty-new-workspace"
```

After verifying both paths, type `ADOPT RECREATION WORKSPACE` only if you explicitly approve copying this recreation's saved state. The command reads the source without modifying or copying its database, then writes the approved state to a marked workspace in the destination. SQLite adoption additionally requires Python 3 with its standard `sqlite3` module (`python` on Windows, `python3` elsewhere) for immutable read-only inspection; ordinary startup and JSON adoption do not. SQLite adoption refuses any WAL, shared-memory or journal sidecar rather than risk losing uncheckpointed data. Stop the old host normally first; if sidecars remain, preserve them and use a verified clean snapshot instead. The command reads JSON only when there is no database. After quitting every owning host, set `ESQUIE_DATA_DIR` to the destination and start either standalone (`npm start`) or desktop (`npm --prefix desktop start`), never both. Adoption retains records but starts paused, clears source consent and destination/output, demo and scheduling approvals, and interrupts queued or running work. Review before explicitly reconnecting, reapproving or retrying. Document, backup and recovery records are marked unavailable because their files were not copied; the old workspace and backups remain intact. Old markerless snapshots cannot be automatically recovered by the new recovery flow; to inspect one, explicitly adopt its verified snapshot directory into another empty workspace. Desktop supports only the explicit environment override, not a graphical selector or automatic attachment. Interrupted adoption may leave a partial destination; preserve it for inspection and choose another empty destination rather than resetting it.

From a clean checkout, with all hosts stopped and private data backed up:

```powershell
git status --short
# Proceed only if the checkout is clean; preserve any local changes first.
git pull --ff-only
npm ci
# Also restore desktop dependencies if you use the desktop host:
npm --prefix desktop ci
```

For an in-app snapshot, approve the private non-synced local destination in Operations, then choose **Queue private backup**. A daily failure is not repeatedly retried that day. Snapshots and SHA-256 manifests live under `backups`; they exclude the owner launch capability and lock. Only UUID-named documents recorded by this recreation with matching generation-time hashes are included; older records without hashes, already-unavailable files and missing files are listed as unavailable. Unknown, redirected, hardlinked or changed files block the backup, rather than being copied. Limits are 1,000 document records, 1 MiB per file and 16 MiB total, plus a 256 MiB SQLite snapshot. Approval is rechecked immediately before directory and file creation and SQLite setup; revocation does not cancel a file write or SQLite operation already started, including closing/checkpointing a partial recovery. Partial/incomplete artifacts are preserved for review rather than silently pruned. Hashes detect accidental changes, not malicious tampering by someone who can change the workspace and its backup record.

**Prepare separate paused recovery** verifies the snapshot, manifest and every included document hash before creating a new generated directory under `recoveries`, never overwriting the active workspace or backup. It disables schedules/output/demo approval, disconnects saved source consent and interrupts historical queued work. Included files are restored; excluded files remain visibly unavailable. Earlier state-only snapshots with a supported owned-database format remain recoverable, but cannot restore their document files; markerless snapshots still require the explicit adoption procedure above. Quit the owning host, set `ESQUIE_DATA_DIR` to the displayed recovered directory and start either standalone (`npm start`) or desktop (`npm --prefix desktop start`) to inspect it, never both; explicitly reconnect/reapprove/resume only after review. Desktop selection uses the launching process's environment, not a graphical selector or automatic attachment. Keep a separate private cold copy of anything not included.

## Verification

```powershell
npm test
npm run smoke
npm --prefix desktop test
```

Tests use fresh synthetic data, injected transports and temporary storage. The smoke check serves the actual UI, creates a fake task/draft/note/job, closes the server, restarts against SQLite, verifies persistence and removes its temporary data.

`npm test` enables Node's experimental VM-module API only for tests. The isolated reply-context UI harness evaluates the unchanged app imports and real task-board source as ES modules; it does not strip imports or substitute board helpers. A direct focused run of that test also needs `--experimental-vm-modules`. Normal `npm start` and the desktop runtime do not use this flag.

**Desktop validation provenance correction:** earlier successful dependency install/rebuild commands relaxed npm remote/script restrictions. Graphical lifecycle, file-origin navigation, packaged-resource and unsigned-build results were observed using artifacts with unverified policy provenance, not a clean policy-compliant install. Those artifacts must not be reused, distributed or published; existing artifacts/caches are left untouched. The later portable-lockfile restore without lifecycle scripts and official Node 22.13 checks are separate results. Native tray-menu clicks and installer install/upgrade/uninstall remain unverified. Exact results, audit limitations, remaining functionality and unavailable reference screenshots are recorded in the [parity report](docs/parity-report.md).

## Provenance

No private reference source/history, reporting schemas/business logic, profile/configuration data, credentials, databases, logs, caches or bundled binaries were copied. The reference has no selected open-source license and organizational publication approval was not established. This is not a licensed redistribution of that application. Obtain the necessary permissions before importing its source, artwork, branding or private-derived material.
