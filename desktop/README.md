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
instead of embedding registry tarball locations. From the repository's `desktop`
directory:

```powershell
npm ci
npm test
npm run test:package
npm run smoke -- --synthetic
npm run smoke
npm start
npm run dist
```

Some npm installations restrict dependency install scripts or downloads. Follow
local policy for the required Electron installation; do not bypass organizational
restrictions. Run `npm audit` using an available advisory endpoint before release.

Validation caveat: earlier install/rebuild commands relaxed npm remote/script
restrictions. Observed graphical/build results used artifacts with unverified
policy provenance, not a clean policy-compliant install. Do not reuse,
distribute or publish those artifacts; existing artifacts/caches are left
untouched. The later portable-lockfile restore without lifecycle scripts is
separate and does not establish a fresh complete desktop installation.
See the [validation record](../docs/parity-report.md) for precise limits.

`dist` builds a local unsigned per-user NSIS installer; it does not publish.
Install the generated `dist\Esquie-Local-Setup-0.1.0-x64.exe` interactively.
Windows or organizational policy may warn about or block unsigned installers;
do not bypass those policies. Run a newer locally built installer to update.
Quit the app before updating. There is no automatic update service or download.
Build from a trusted source tree: the package includes this repository's `src`
and `public` runtime files via an explicit allowlist, not a pre-existing workspace
or reference installation. Update the allowlist and packaging regression test
when the backend introduces a new runtime module or dashboard asset.

Workspace data is stored in `%LOCALAPPDATA%\EsquieLocal\Workspace`, outside the
installation. Program updates and normal uninstall do not delete it. Back it up
before upgrading, particularly when changing backend versions; no data migration
or downgrade is promised by this wrapper. The first launch initializes a new
workspace. The wrapper does not import any other installation or its data.
Windows sign-in startup is **off by default** and can be enabled explicitly in
the application or tray menu for an installed build. It is unavailable in dev mode.
The synthetic smoke uses a fake server to verify protected launch and reload;
the ordinary smoke exercises the integrated backend in a temporary workspace.
`npm test` also checks the literal backend/public resource allowlist and starts
only those copied runtime files with disposable data and port zero, using Node
without Electron/build artifacts. Missing imported runtime modules fail this
check; it does not replace a real policy-compliant package/install validation.

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
