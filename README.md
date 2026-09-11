# Open Markdown Review 0.5.2

A local-first Markdown review protocol with one shared reviewer toolbox for VS Code and a double-clicked HTML file. No application server, browser extension, cloud account, or separate review database.

Version **0.5.2 is a regular GitHub release with known limitations**, not a qualified professional pilot. Download it from the [0.5.2 release page](https://github.com/mirdadusi/open-markdown-review/releases/tag/v0.5.2) and read the [release notes and limitations](docs/releases/0.5.2.md). It adds safe review-removal actions and fixes reviewer identity handover and the unified VS Code sidebar. Markdown and optional Slidev review retain framework-neutral core wire version 0.5.0. Existing 0.4 packages keep their legacy VS Code reader; they are never silently migrated.

For Windows x64 install `open-markdown-review-0.5.2-win32-x64.vsix`; for other supported VS Code platforms install `open-markdown-review-0.5.2-portable.vsix`. Both have SHA-256 checksum files and standard VSIX metadata without a pre-release marker. Use **Extensions: Install from VSIX** in VS Code. Previous release tags and original assets remain unchanged.

## Install

Download the VSIX and matching SHA-256 checksum from the [0.5.2 release](https://github.com/mirdadusi/open-markdown-review/releases/tag/v0.5.2). In VS Code run **Extensions: Install from VSIX**, select the package for your platform, and reload when prompted. Browser-only participants receive the review folder with its generated HTML launcher and do not install an extension.

## Tested status and known limits

The release source passed its recorded unit/protocol, real-browser, VS Code extension-host, dependency-audit, and packaging checks on its supported release platforms. Passing automation is not complete browser, transport, security, or usability qualification.

- **SMB remains untested**, because no authorized test share was available. No SMB compatibility or performance claim is made.
- Remaining professional-pilot requirements are tracked in the [implementation status](spec/IMPLEMENTATION-STATUS.md).
- Identities are self-asserted and events are unsigned. Exact-byte audit hashes do not authenticate a reviewer or prove that every disconnected participant has synchronized.

## Open a review someone sent you

1. Open its folder in Explorer/Finder.
2. Double-click **OpenMarkdownReview.html** in a supported Chrome/Edge browser.
3. Choose that same review folder when the browser asks for access.
4. Enter a stable reviewer ID and your name. Select the pinned revision if there are competing heads.
5. Select text or click a diagram, image, table, or cell, then choose **Comment** or **Suggest edit**.

The folder grant is a browser security requirement. An HTML file cannot silently obtain access to its neighboring files or inherit a verified Windows login. Remembered access is best effort and may require reconnection. Unsupported/restricted browsers show an explicit explanation; they do not simulate saving.

With the extension installed, opening **the same OpenMarkdownReview.html file in VS Code** opens the review custom editor. **Markdown Review: Connect Existing Review** also accepts a package folder. VS Code uses its installed trusted toolbox, not arbitrary JavaScript found in a received package.

## What is implemented

- One shared validation, session, renderer, action toolbox, and PDF exporter in both hosts.
- Markdown, GFM tables and cells, Mermaid, frozen local/data/HTTPS images, and explicit attachments.
- Anchored comments, replies, visible highlights, click-through navigation, and searchable/paged discussion history.
- Separate accept/reject decisions and resolve/reopen status. Accepting a concern does not resolve it.
- Exact-string insertion, replacement and strikeout suggestions; accept/reject and explicit author-only source application.
- Revision approval, rejection and withdrawal with freshly verified evidence and confirmation of the observed state.
- Multiple packages and explicit immutable revision selection; arriving revisions never silently retarget a draft.
- Independent content-addressed event files, conflict detection, partial-write recovery, and eventual synchronization.
- Whole-revision PDF exports containing documents, diagrams, tables, comments, responses, reasons, suggestions and event history. UI filters never shrink an audit export.
- CLI creation/revision/export/inspection/validation and safe HTML installation/update.

Graphical creation is in VS Code; the same authoring service is available from the CLI. A participant browser does not need the source workspace.

## Create in VS Code

Open a Markdown source workspace, select the Review icon in the left Activity Bar, and choose **Create New Review**. The visual setup selects individual documents or folders, the start document, title and storage folder/name. Additional prompts allow an approval quorum and explicitly granted external-resource folders.

## Remove or delete a review in VS Code

Right-click a review in the **Reviews** list, or use the matching **Markdown Review** command from the Command Palette:

- **Remove Review from List** disconnects it locally. Shared files remain unchanged; use **Connect Existing Review** to add it again. This also works when its folder is unavailable.
- **Delete Review…** checks the folder and asks before moving the **entire review package** to OS Trash/Recycle Bin, including comments, replies, revisions, frozen content, exports and HTML. The confirmation shows the exact folder and file count. Original source files outside that package are untouched.

Both actions close that review's toolbox tabs and discard unsaved drafts after confirmation. They clear the removed review's active selection and local authoring-resume shortcuts; private recovery journals remain on disk. Other reviews stay connected. Legacy reviews are not rediscovered automatically after removal; reconnect explicitly.

Deletion refuses source/workspace roots, linked folders/junctions, Git metadata, unexpected top-level files and detected unfinished writes. If you opened the review package itself as the VS Code workspace, open its parent/source workspace first. Local review operations must finish before deletion, and the folder is checked again after confirmation. Inspection is bounded to 100,000 entries and 32 levels.

**Stop all other browser, VS Code and CLI writers before deleting a shared review.** Deletion can propagate to other participants through sync; these checks do not lock other machines or eliminate filesystem races. On a share without Trash/Recycle Bin support, the operation reports failure and does **not** retry with permanent deletion. Inspect the folder after any storage error. To recover a successfully trashed package, restore it using the OS and reconnect it. OS trash behavior on Windows/shared drives is not locally qualified; SMB testing remains skipped.

No protocol events are edited or removed individually and no `review.deleted` event is invented: whole-package deletion is filesystem lifecycle, outside the append-only review history. In Git, inspect and commit the resulting deletions yourself; the extension never commits or pushes them.

## Slidev presentations

Choose **Slidev presentation** during creation to capture the root deck and its local `src:` imports with the installed, explicitly trusted Slidev 52.19.1 runtime. Select whether speaker notes are included or removed. Browser participants need no Slidev installation: they get slide navigation, frozen themed images, whole-slide comments, exact source-text comments/suggestions, replies, decisions and audited PDFs in the same toolbox as VS Code.

This uses three layers: the unchanged core protocol, a separately versioned Slidev profile, and a shared client adapter. All source, profile data and frozen slides remain in the one review package. The HTML file remains a generic door/toolbox, not a second deck or discussion store.

Static previews preserve Mermaid, tables, images and rendered theme/component styling. Interactive behavior, animations, video, custom preparsers/addons and pixel-region anchors are outside v1. Authors must inspect captures; excluded notes are not a general secret-removal guarantee. Ordinary Markdown clients must understand the optional profile to participate; old clients fail closed.

See the [Slidev creation/review guide](docs/SLIDEV.md), [profile specification](spec/SLIDEV-PROFILE-V1.md), [transport rules](protocol/profiles/README.md) and [example deck](examples/slidev/slides.md). Author-only runtime dependencies and their narrow, isolated test-fixture advisory exceptions are documented there; they are not shipped to reviewers.

Creation captures saved disk bytes. Unsaved editors require an explicit save/use-disk choice. Every successful creation installs the HTML entry file with JavaScript, Mermaid, fonts and PDF runtime bundled; reviewers need no CDN or npm installation.

Creation can be cancelled before final publication. Its private capture checkpoints remain intact; run Create again to choose a saved operation to resume. Once final publication starts, the client finishes and reports the actual result.

To update documents, choose **Choose Documents and Create Revision**. Existing review evidence stays immutable. Parents are selected explicitly; a merge revision does not transfer earlier comments or approvals to new content.

### Reviewer identity and active review

Version 0.5.2 uses one **Reviews** list for current and legacy packages. Creating/opening a review or focusing its toolbox selects it in **Active Review** and the status bar. The selection remains when the toolbox is closed and is restored in the same workspace; sidebar actions reopen the toolbox when needed.

The identity entered during creation prefills the VS Code toolbox. Later ID/name edits are remembered privately per review in the local VS Code profile. A fresh participant never inherits the creator identity from the shared manifest, HTML or received workspace settings. Browser participants continue choosing their own identity.

## One source of truth

```text
any-review-folder/
  manifest.json
  revisions/<revision-id>.json
  blobs/sha256/<first-two>/<digest>
  events/<exact-event-byte-digest>.json
  exports/<pdf-digest>.pdf
  exports/<inventory-digest>.inventory.json
  OpenMarkdownReview.html
  .gitattributes
```

The editable source is used only for creating revisions and explicitly applying accepted edits. Frozen blobs are the material being reviewed; events are the review history. Both clients read that same package. Identical content is stored once by digest. The HTML contains application code and licenses, not copies of review content or comments.

Caches, remembered directory handles, identities and recovery journals remain client-local. Removing a cache cannot remove published history. An unacknowledged action may need its original local journal to resume safely.

Any filesystem-safe folder name is allowed. The design accepts filesystem paths inside Git, on a normal disk, on a mounted SMB share/mapped drive, or in a synchronized folder. **SMB behavior is unqualified:** its CI testing is excluded by user decision because an authorized test share is unavailable. Use a filesystem path, such as a mapped drive or UNC path on Windows; an `smb://` URL is not a native directory path. Neither client hosts a server.

For Git, commit the complete package. The generated `.gitattributes` disables line-ending conversion, filters and encoding transformations inside the package. The extension does not automatically pull, merge or push Git.

## Synchronization and performance

The active toolbox polls after the previous scan finishes: every three seconds in the foreground, fifteen seconds in the background. This is eventual visibility after the storage provider delivers complete bytes, not a guarantee that disconnected users have synchronized.

Warm scans reuse verified state and unchanged rendering. A bounded 64-event integrity sweep detects rewritten historical event files over time; explicit audits freshly verify the complete observed package. Native/browser adapters admit at most four concurrent file operations per process. An audit attempt deduplicates reads of files referenced by many earlier receipts.

Missing, partial, changed or conflicting evidence is disclosed. Approval and export fail closed. These optimizations have regression tests, including 10,000 events, but do not establish Windows latency or real SMB performance; SMB qualification is excluded and untested.

## Build, test and package

Use Node.js 22 or newer.

```sh
npm ci
npm test
npx playwright install chromium
node scripts/install-slidev-fixture.mjs
npm run test:browser
npm run test:extension
node scripts/package-release.mjs portable candidate
```

The VSIX is created at the repository root. Install it using VS Code's **Extensions: Install from VSIX**. This does not install a browser extension. The development launch configuration also supports F5.

The browser tests use real Chromium and real browser directory handles/IndexedDB; their deterministic adapter test uses origin-private storage and is explicitly not a native folder-permission test. Windows local-storage browser and VS Code checks run in CI. SMB testing is excluded by user decision; the retained SMB-dependent native-picker fixture has not run, so actual local native folder grants remain unqualified.

Build outputs include the generic HTML, CLI, extension, conservative dependency inventory and third-party notices. The HTML embeds its license notices and has a fixed-script-hash CSP, without `unsafe-eval`.

## Command line

No VS Code process is required. From a built checkout:

```sh
node dist/cli.js review create --source ./docs --store ./reviews/design --root-document architecture.md --actor-id mira --operation-id design-001 --json
node dist/cli.js review inspect --store ./reviews/design --json
node dist/cli.js review validate --store ./reviews/design --full --json
node dist/cli.js review export --store ./reviews/design --actor-id mira --operation-id export-001 --json
node dist/cli.js --help
```

Repeat `--include FILE`, `--include-dir DIR`, `--exclude PATH`, or `--resource-root PATH` as needed. `--policy FILE` accepts the policy schema. `revision create` uses the same parameters plus repeatable `--parent REVISION_ID`. Creation `--dry-run` reads local Markdown but creates no package, journal or remote capture and does not require an operation ID. Ctrl+C cancels creation before final publication with exit code 6; progress goes to stderr, leaving JSON stdout clean.

Use the original `--operation-id` with `--resume` after interrupted creation or source application. Already captured Markdown/resources and published bytes are reused. Different parameters are refused.

Accepted source edits are staged separately before replacing the source file; original bytes remain in the private recovery plan. A failed review-event publication after the source save is explicitly reported and retries only the pending evidence. Continue to use source control/backups: platform durability and external editor races are not fully qualified.

If an export fails, use Export again—even after reopening the same client—to resume its recorded operation. It does not invent another export event for that retry. Private binary recovery plans use compact base64; this is not a claim that the maximum PDF/history memory workload is qualified.

`client install --store PATH` adds a missing generic HTML file. `client update --store PATH --expect-client-digest sha256:HEX` explicitly replaces that exact current HTML and retains a backup outside protocol directories. In VS Code use **Update Portable Browser Client** and confirm. Do not install untrusted HTML supplied as a software update.

CLI export uses the same toolbox PDF engine through headless Chromium and requires the installed Playwright browser runtime. It does not require a server. CLI stdout is JSON; supported flags are checked per command. Exit codes follow the [CLI contract](spec/PROFESSIONAL-V1.md#10-authoring-service-and-cli-contract).

## Images, diagrams and references

```markdown
![Captured image](images/diagram.svg)
[Captured attachment](evidence.pdf "review:attach")
[Ordinary external reference](https://example.org/reference)
```

Embedded images and explicit attachments must be captured successfully. Ordinary web links are described but are not archived. Parent-relative image/attachment paths work when their resolved location is inside an explicitly granted root. HTTPS capture is bounded and rejects embedded credentials/secret query parameters. Secrets already present in Markdown must be removed from source before sharing.

Raw Markdown HTML is disabled. Mermaid uses strict configuration; embedded Mermaid configuration directives/front matter are rejected in this candidate. Invalid or unsupported rendering blocks a complete audit PDF rather than silently omitting the item.

## Examples, protocol and assurance

Run `node scripts/create-professional-example.mjs` after building to prepare the concrete example's HTML entry file. Open `examples/professional/review/OpenMarkdownReview.html`, not the unconnected build template.

- [Protocol 0.5 contract](spec/PROTOCOL-0.5.md), [JSON schemas](protocol/schemas/v0.5), [shared TypeScript types](src/professional/types.ts)
- [Professional requirements](spec/PROFESSIONAL-V1.md), [acceptance gates](spec/ACCEPTANCE.md), [current evidence and limitations](spec/IMPLEMENTATION-STATUS.md)
- [Security model](SECURITY.md), [legacy 0.4 documentation](docs/LEGACY-0.4.md)

Identities are self-asserted and events are unsigned. Audit hashes show exact captured bytes, not authenticated identity or global completeness. Organizational sign-off needs an additional identity/signing profile.

Project code is available under [MIT](LICENSE); the non-binding project culture is described in [M.I.R.D.A. philosophy](PHILOSOPHY.md). Third-party runtime/font/data components retain their own licenses.
