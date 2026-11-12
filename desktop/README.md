# Windows desktop host

This is an independently authored Electron host for this repository's local dashboard.
It starts its own server on an operating-system-selected loopback port and never
attaches to, changes, or stops another installation. Closing the window hides it
to the tray; use the tray or app menu to reopen or quit. Quit waits for the owned
server's `close()` operation. The renderer is sandboxed with Node disabled and
context isolation enabled; external HTTP(S) links open in the default browser.
Device permissions and downloads are denied.

## Install, run, and update

Use Windows x64, Node 22.13 or newer, npm, and access to your approved npm
registry and Electron download hosts. The lockfile uses the configured registry
instead of embedding registry tarball locations. From the verified recreation's
checkout root, follow the guarded [desktop setup and launch](../README.md#requirements-and-startup)
instructions; they require an explicit verified recreation workspace. Stop all
other hosts first. For updates, follow the guarded
[update instructions](../README.md#storage-output-and-upgrades) and then the
desktop setup instructions. Never select the reference installation.

To run desktop verification from the checkout root, copy and run this entire
single line. This artifact-free test does not run Electron or build an installer:

```powershell
& { $ErrorActionPreference = 'Stop'; $null = Get-Command git -ErrorAction Stop; $null = Get-Command npm.cmd -ErrorAction Stop; $root = @(git rev-parse --show-toplevel 2>$null); if ($LASTEXITCODE -ne 0 -or $root.Count -ne 1 -or [System.IO.Path]::GetFullPath($root[0]) -ne [System.IO.Path]::GetFullPath((Get-Location).Path)) { throw 'Enter the verified recreation checkout root first.' }; $origin = @(git remote get-url origin 2>$null); if ($LASTEXITCODE -ne 0 -or $origin.Count -ne 1 -or $origin[0] -notmatch '^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)alanhkim/Esquie_copilot_desktop_app(\.git)?/?$') { throw 'Checkout origin is not the expected public recreation; stop and verify.' }; npm.cmd --prefix desktop test; if ($LASTEXITCODE -ne 0) { throw 'Desktop tests failed.' } }
```

Some npm installations restrict dependency install scripts or downloads. Follow
local policy for the required Electron installation; do not bypass organizational
restrictions. Run `npm audit` using an available advisory endpoint before release.

## Optional native validation

Only after independent source and policy review, on an approved isolated host
with policy-compliant dependencies and artifacts, an owner may deliberately run
the following separate line from the verified checkout root. `test:package`
creates an unpacked build with `electron-builder --dir`, not an installer; both
smoke checks launch Electron using temporary data. The sequence stops on failure.
It is not part of ordinary verification:

```powershell
& { $ErrorActionPreference = 'Stop'; $null = Get-Command git -ErrorAction Stop; $null = Get-Command npm.cmd -ErrorAction Stop; $root = @(git rev-parse --show-toplevel 2>$null); if ($LASTEXITCODE -ne 0 -or $root.Count -ne 1 -or [System.IO.Path]::GetFullPath($root[0]) -ne [System.IO.Path]::GetFullPath((Get-Location).Path)) { throw 'Enter the verified recreation checkout root first.' }; $origin = @(git remote get-url origin 2>$null); if ($LASTEXITCODE -ne 0 -or $origin.Count -ne 1 -or $origin[0] -notmatch '^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)alanhkim/Esquie_copilot_desktop_app(\.git)?/?$') { throw 'Checkout origin is not the expected public recreation; stop and verify.' }; npm.cmd --prefix desktop run test:package; if ($LASTEXITCODE -ne 0) { throw 'Package boundary checks failed; stopping native validation.' }; npm.cmd --prefix desktop run smoke -- --synthetic; if ($LASTEXITCODE -ne 0) { throw 'Synthetic smoke failed; stopping native validation.' }; npm.cmd --prefix desktop run smoke; if ($LASTEXITCODE -ne 0) { throw 'Desktop smoke failed.' } }
```

Installer creation is separate from both sequences. Only after independent source
and policy review may an owner deliberately run `npm.cmd --prefix desktop run dist`
from the checkout root; it creates an unsigned installer and does not establish
installer validation.

## Scoped desktop verification

The coordinator separately verified exactly
`a5fdb1a6f369ab7d3f733aa8f94c58e25d54a6ba`, not later commits. An isolated
`npm ci --no-audit --no-fund` exited 0 under unchanged settings, while existing
`allowScripts` policy blocked `electron-winstaller@5.4.0`'s Squirrel-only
lifecycle script. The configured NSIS target uses a separate builder path;
the blocked script was neither invoked nor approved. Do not describe this
restore as fully lifecycle-complete.

At that checkpoint, 7/7 desktop tests, synthetic and actual Electron startup,
package boundary checks and the unsigned NSIS build passed. Two independent
launches against a fake workspace preserved a task and displayed disconnected
Outlook. No older unverified artifacts were used or published. The installer
was not executed: install/upgrade/uninstall, autostart and native tray-menu
clicks remain unverified. Later Node host/resource checks do not extend this
native-runtime evidence to a later revision.

Earlier install/rebuild commands relaxed npm remote/script restrictions.
Their older graphical/build artifacts have unverified policy provenance:
do not reuse, distribute or publish them; existing artifacts/caches are left
untouched. The clean checkpoint does not retroactively approve those artifacts
or resolve the six-moderate npm audit summary. The earlier portable-lockfile
restore without lifecycle scripts is another separate result. See the
[validation record](../docs/parity-report.md) for precise limits.

`dist` builds a local unsigned per-user NSIS installer; it does not publish.
Install the generated `dist\Esquie-Local-Setup-0.1.0-x64.exe` interactively.
Windows or organizational policy may warn about or block unsigned installers;
do not bypass those policies. Run a newer locally built installer to update.
Quit the app before updating. There is no automatic update service or download.
Build from a trusted source tree: the package includes this repository's `src`
and `public` runtime files via an explicit allowlist, not a pre-existing workspace
or reference installation. Update the allowlist and packaging regression test
when the backend introduces a new runtime module or dashboard asset. The account
search and workspace modules are literal packaged assets; the resource check
copies the allowlisted files and verifies that both module URLs are served.
The local pipeline snapshot module is allowlisted and checked the same way.
It stores only explicitly reviewed owner-pasted tables as unverified, append-only
local snapshots; live reporting, source bindings, identity matching, and CRM
changes remain unavailable.
The Word summary writer and shared document-format validator are also explicit
runtime resources covered by the artifact-free allowlist test. They generate
local DOCX files; this does not establish native Word application rendering or
visual parity.

Workspace data is stored in `%LOCALAPPDATA%\EsquieLocal\Workspace`, outside the
installation. NSIS is configured with `deleteAppDataOnUninstall: false`, but
preservation by installer install, upgrade or uninstall has not been verified.
Make a separate backup before any installation change; no data migration or
downgrade is promised by this wrapper. The first launch initializes a new
workspace. The wrapper does not import any other installation or its data.
This desktop default differs from the standalone dashboard default. To use the
same **verified recreation** workspace, quit its current host and set
`ESQUIE_DATA_DIR` to that private local directory using the guarded later-launch
command in the repository's [startup instructions](../README.md#requirements-and-startup)
with `desktop` mode. Set it in the environment that launches the desktop app; a
shortcut or sign-in startup may not inherit a terminal-only setting. With no
override, the desktop default remains unchanged. The server applies the same
ownership, lock, private-storage and recovery checks as standalone; an unsafe or
already-open workspace is refused. No workspace is moved, copied, merged or
overwritten by this selection. For a separately prepared paused recovery or
explicit legacy adoption, quit the owning host and select the resulting verified
directory with that same guarded command; follow the repository's
[recovery guidance](../README.md#storage-output-and-upgrades) before resuming or
reconnecting. Never select the original installation.
Windows sign-in startup is **off by default** and can be enabled explicitly in
the application or tray menu for an installed build. It is unavailable in dev mode.
The synthetic smoke uses a fake server to verify protected launch and reload;
the ordinary smoke exercises the integrated backend in a temporary workspace.
`npm test` also checks the literal backend/public resource allowlist and starts
only those copied runtime files with disposable data and port zero, using Node
without Electron/build artifacts. Missing imported runtime modules fail this
check; it does not replace a real policy-compliant package/install validation.
The allowlist includes the task-board browser ES module and the backend's
`connectors/safe-file-download.mjs` import. Packaging these files does not enable
live selected content: explicit content UI is supplied, but no production
sign-in is installed and the default Windows downloader deliberately remains
unavailable.

## Integration and limitations

The backend must export `async startServer({ dataDir, port })` and return
`{ url, launchUrl, accessToken, close }`, listen on `127.0.0.1` with `port: 0`,
and serve unauthenticated `GET /api/health` on `url`. `launchUrl` must point to
that same dashboard as `${url}/#access=${accessToken}`, where `accessToken` is
the server's 43-character base64url capability; the host loads it without
logging it. `close()` must gracefully finish owned work. The packaged
server executes inside Electron's Node runtime, not the developer's Node process.
The smoke test checks that runtime's `node:sqlite` module. Additional backend
dependencies, native modules, worker processes, or non-`src`/`public` resources
must be explicitly packaged and tested when the backend starts using them.

The wrapper does not provide external source sign-in, notifications, retired
runners, remote updates, or reference-installation migration. System sign-out or
forced termination may interrupt work; the normal Quit path is graceful. The tray
uses a simple generated icon rather than private artwork. Smoke testing uses a
temporary workspace and never accesses the existing installation.
