# Open Markdown Review 0.6.5

Review Markdown in VS Code or a browser, with comments, suggested edits and an auditable history stored beside frozen documents. There is no hosted review service or central database. A review folder is the shared source of truth; OneDrive, Syncthing, Git or another filesystem transport synchronizes its files.

[Install from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=mirdadusi.open-markdown-review) · [GitHub releases](https://github.com/mirdadusi/open-markdown-review/releases) · [Release notes](docs/releases/0.6.5.md) · [Protocol 0.6](spec/PROTOCOL-0.6.md)

## What 0.6.5 adds

- Self-contained Go browser companions for **Windows x64**, **macOS ARM64** and **Linux x64**, bundled inside every extension VSIX.
- Invited reviewer emails, initiator-only later invitations, and independent **Finish my review / Reopen my review** progress.
- A creator workbench for deciding findings, recording published fixes and requesting reviewer verification.
- Two PDF profiles: a review archive with native PDF comment annotations and reviewer progress, or a clean document-only export.
- Continuous reading with bounded rendering, precise source navigation and compact reading controls beside **Export PDF**, without an extra document header.
- Backed-up tooling upgrades that preserve the review manifest, frozen documents, comments, replies, approvals and completion events.

The application version is **0.6.5**; its current core protocol version is **0.6.0**. Supported older packages retain their original rules. Installing a new client does not silently convert review evidence.

## Install the authoring extension

Search for **Open Markdown Review**, publisher **mirdadusi**, in VS Code Extensions. Marketplace updates are handled by VS Code's native update mechanism. An extension update includes the HTML toolbox and all three Go companions together—there is no separate companion updater or participant-side download.

For manual installation, download a VSIX and its matching SHA-256 file from the [release](https://github.com/mirdadusi/open-markdown-review/releases/tag/v0.6.5):

| Extension host | Package |
| --- | --- |
| Native Windows x64 VS Code | `open-markdown-review-0.6.5-win32-x64.vsix` |
| macOS, Linux, WSL, SSH or Dev Container | `open-markdown-review-0.6.5-portable.vsix` |

Both packages contain all three participant platforms. The host-specific Windows package also carries its native image dependency; the portable package is the correct choice for a remote Linux extension host, even on a Windows desktop.

## Create a review

1. Open a Markdown workspace in VS Code and select the Review icon in the Activity Bar.
2. Choose **Create New Review**, select Markdown files or folders, and choose the initial document.
3. Choose an empty destination folder, a review title, your initiator ID/display name, and optional invited reviewer email addresses.
4. Select the participant platforms to include. Creation verifies and copies the bundled Go launchers; nothing is compiled or downloaded per review.
5. Share the **complete folder**, not just its HTML file or launcher. Use one authoritative shared location.

![VS Code review setup](docs/images/marketplace/vscode-setup.png)

The destination can be named `.review`, `design-review`, or any other filesystem-safe name. It can sit inside a Git repository or outside the source tree. Review capture freezes the selected Markdown and required assets into content-addressed blobs, so a shared package does not depend on the author's absolute paths. A private source-workspace binding supports later author edits without putting native source paths in the review.

For a later move, **Publish Verified Review Copy…** copies and verifies the complete package into an empty destination, then switches the active connection. The old copy remains on disk; do not keep writing to two unsynchronized copies.

## Participate in a browser

Synchronize the complete folder locally and make its files available offline. Launch the executable for your platform:

| Platform | Review-folder launcher |
| --- | --- |
| Windows x64 | `StartReview-windows-x64.exe` |
| macOS Apple Silicon | `StartReview-macos-arm64` |
| Linux x64 | `StartReview-linux-x64` |

The Go companion opens the default browser on a private, short-lived `127.0.0.1` session and accesses that folder. It is a local helper, not a central server or synchronization service. Each participant runs their own helper. Reviewers need no Node.js, Go, VS Code extension or application registration. Keep the launcher running until saves and exports finish.

Windows application controls, macOS quarantine/notarization and Linux executable permissions still apply. These builds are not a guarantee of organizational approval or support for every desktop/distribution. Intel Macs and Windows ARM64 are not provided as native companion targets.

The review-named HTML file is an alternative in a browser that supports writable directory access, such as an appropriately configured Edge or Chrome. Its first folder grant is a browser security requirement. Sandboxing or managed filesystem policies may block that route; the companion avoids the directory picker but does not bypass executable or loopback policies. Safari does not provide the complete direct-folder writing workflow.

![Browser review](docs/images/marketplace/browser-review.png)

For OneDrive, open the synchronized folder in the filesystem—not the website's preview. Git does not synchronize uncommitted events automatically. SMB/mapped-drive paths are filesystem transports; an `smb://` URL is not a native directory path. Real SMB and multi-device synchronization latency remain unqualified.

## Comments, processing and participant state

Select text or a semantic image, diagram, table or cell, then add a comment or suggested edit. Highlights and finding links connect the discussion to its source position. The findings panel can show all documents or only the selected document, with search and unresolved/workflow filters.

Reviewers can reply to open findings. For reviews declaring creator-controlled lifecycle, only the initiator may decide, close or reopen a finding. Resolved findings remain locked until reopened. The creator workbench distinguishes accepted-but-not-implemented work, published fixes, reviewer verification, renewed challenges and conflicts. Applying a source edit and publishing a new frozen revision are explicit author actions, not automatic rewrites of the reviewed evidence.

![VS Code review](docs/images/marketplace/vscode-review.png)

For a restricted roster, enter the email used in the invitation and a display name. The initiator can add reviewers later; ordinary reviewers cannot invite another participant. **Finish my review** records completion for that participant and revision; **Reopen my review** explicitly unlocks their feedback. Completion is separate from approval, rejection or withdrawal.

Email ownership is **self-asserted**, not verified. This is not Windows, Entra, smart-card or email authentication. Workflow controls do not prevent someone with arbitrary folder-write access from impersonating an actor or replacing an entire package. Filesystem/provider access controls remain essential.

Incoming immutable events are validated and reflected in the UI through polling. This is eventual visibility after the storage provider delivers files, not a guaranteed real-time collaboration service. Background updates do not intentionally move the reader or silently switch revisions.

## PDF exports

Choose the profile beside **Export PDF**:

- **With review comments** produces an offline review archive with native PDF comment annotations attached to challenged passages, replies and finding outcomes, reviewer progress and exact-byte audit evidence. Open the PDF reader's Comments/Annotations panel to inspect discussions. Annotation presentation varies by reader.
- **Clean document only** exports the frozen document content without review comments, the reviewer roster or review-summary material. It is not an approval record or replacement for the review archive.

Both profiles share the rendering/export implementation across VS Code and browser clients. Frozen Markdown, Mermaid, images, tables and supported sanitized HTML are rendered with bounded layout and embedded fonts. Wide/complex content and unusual glyphs still require visual inspection. Export result actions identify the saved file and offer open/reveal/download as supported by the host.

See [PDF profiles](spec/PDF-EXPORT-PROFILES.md) for exact scope, evidence and failure rules.

## Upgrade an existing review safely

Installing the extension updates its bundled tooling; it does **not** silently replace files in shared review folders.

1. Stop running companions for the review and open it in the updated VS Code extension.
2. Run **Markdown Review: Update Portable Browser Client**.
3. Keep every installed participant platform selected and confirm the backed-up upgrade.
4. Let synchronization finish, then relaunch the companion or reopen the HTML page.

The operation verifies the review identity, backs up prior HTML/launchers, stages matching bundled replacements, and checks that every pre-existing evidence file retains its exact bytes. Comments, replies, decisions, approvals and participant progress stay in the same event history. It does not create a new revision or migrate an older package's capabilities. An interrupted upgrade retains backups and reports failure rather than claiming success.

## One record, several clients

```text
design-review/
├── manifest.json
├── events/<sha256>.json
├── revisions/<revision-id>.json
├── blobs/sha256/<prefix>/<sha256>
├── exports/
├── Review-<name>.html
├── StartReview-windows-x64.exe    # if selected
├── StartReview-macos-arm64       # if selected
└── StartReview-linux-x64         # if selected
```

The core record is manifest, revisions, blobs and append-only events. HTML, launchers, caches and remembered identities are clients/tooling, not alternate review databases. Companion notices are embedded (`--licenses`); build receipts/checksums stay in the authoring distribution rather than cluttering the review root. Existing backups remain recoverable.

The [core protocol](spec/PROTOCOL-0.6.md), [portable review profile](spec/PORTABLE-REVIEW-PROFILE-0.6.md) and [local companion transport](spec/LOCAL-COMPANION-0.6.md) are separate layers. A Go host is not a second protocol implementation: it runs the shared validation/RPC core and the same HTML toolbox. [Slidev](docs/SLIDEV.md) is an optional versioned presentation profile with trusted author-side capture; participants review frozen evidence rather than execute a deck project.

## Build and validate

Development requires Node.js 22 and the locked npm dependencies. Rebuilding native companions additionally requires pinned Go 1.27.3; participant machines do not.

```sh
npm ci
npm run compile
# Stage the pinned clients from the matching public release VSIX:
node scripts/download-companion-bundle.mjs
npm test
npm run test:browser
npm run test:extension
npm run verify:marketplace
npm run package:marketplace -- portable
npm run package:marketplace -- win32-x64
```

For an unreleased client change, rebuild/re-pin all affected native clients and obtain a fresh Mac qualification before bundling; see [companion delivery and release maintenance](docs/COMPANION-DELIVERY.md). Test-only executables must never ship. The retained Node host is an explicit legacy/development option, not an automatic fallback. No public CI workflow or repository publishing secret is required by this project.

## Documentation and limits

- [Protocol 0.6 and its schemas](spec/PROTOCOL-0.6.md), [portable profile](spec/PORTABLE-REVIEW-PROFILE-0.6.md), [conformance fixture](protocol/fixtures/v0.6/README.md)
- [Architecture](ARCHITECTURE.md), [companion delivery](docs/COMPANION-DELIVERY.md), [reading/identity UX](spec/READING-AND-IDENTITY-UX.md)
- [Security model](SECURITY.md), [implementation and qualification status](spec/IMPLEMENTATION-STATUS.md), [support](SUPPORT.md), [contributing](CONTRIBUTING.md)
- [Legacy 0.4](protocol/README.md) and [protocol 0.5](spec/PROTOCOL-0.5.md) remain distinct compatibility contracts.

A standard release is not a certification of every browser, managed endpoint, network share or performance workload. Native execution and cross-compilation are different evidence. Signing/notarization, actual browser grants, synchronization/fault behavior, independent-client interoperability and remaining professional acceptance gates are documented explicitly.

## License

[MIT](LICENSE). [M.I.R.D.A.](PHILOSOPHY.md) describes the project's philosophy, not a second license or additional condition.
