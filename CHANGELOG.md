# Changelog

## 0.5.5

Regular release with known limitations; professional-pilot qualification remains incomplete. Core wire version remains 0.5.0. See [release notes](docs/releases/0.5.5.md).

- Add **Check for Updates** and **Open Update Source** commands to the public extension menu; Marketplace installation remains owned by VS Code's native Update action.
- Delegate public installation, platform selection, rollout delay, policy, and automatic updates to VS Code's native Marketplace subsystem.
- Add a reusable enterprise release provider with strict release identity, platform-aware artifact selection, authentication, bounded downloads, allowlisted redirects, SHA-256 verification, and safe VSIX installer fallback.
- Define a checked-in update-source contract so the public and enterprise derivatives cannot silently use each other's publisher or distribution channel.
- Require the public Marketplace version to exist before the corresponding enterprise release can be published.

## 0.5.4

Regular release with known limitations; professional-pilot qualification remains incomplete. Core wire version remains 0.5.0. See [release notes](docs/releases/0.5.4.md).

- Add a light-theme Marketplace icon and representative VS Code setup, VS Code review, and portable-browser screenshots based on a neutral example package.
- Improve the extension summary, keywords, gallery metadata, installation path, support information, and public vulnerability-reporting guidance.
- Add deterministic Marketplace presentation validation and repeatable portable/Windows x64 packaging with checksums and Marketplace-compatible README link rewriting.
- Document a local-first publication procedure using a short-lived, least-privilege Azure DevOps PAT. No CI publishing workflow or long-lived repository secret is added.
- Keep review behavior, file formats, schemas, and protocol 0.5.0 unchanged from 0.5.3.

## 0.5.3

Regular release with known limitations; professional-pilot qualification remains incomplete. Core wire version remains 0.5.0. See [release notes](docs/releases/0.5.3.md).

- Add a verified **Publish Review Copy** workflow that copies a complete package to an empty local, shared, synchronized, or Git folder; rejects links and unexpected package content; hashes every file; fully validates both packages; checks that the source did not change; switches VS Code to the destination; and leaves the old copy detached on disk.
- Add an explicit private **Link Local Source Workspace** workflow. It reports exact, changed, and missing reviewed documents, never stores native source paths in shared evidence, updates author-only source actions without reopening the toolbox, and removes the unsafe implicit fallback to the first workspace when revising a received package.
- Let new-review creation choose among multi-root VS Code workspace folders. Markdown scope remains one explicit source root; additional roots are resource-only until a separately versioned namespaced-source capability is specified.
- Recognize explicitly attached DOCX, legacy/current Visio, and EMF source artifacts so a review can carry the bounded originals behind rendered previews without executing them.
- Generate a review-named `Review-<name>.html` launcher with only review ID/title/manifest-digest binding, reject a selected folder with a different identity, automatically reconnect only when browser permission is already granted, and migrate the legacy generic filename through the backed-up explicit update path.
- Make cold open progressive: show an immediate blocking progress panel with manifest/event/rendering stages, admit ordinary Markdown revision descriptors without eagerly reading every frozen document/resource, and fetch only the selected document and its visible assets. Approval and audit export still perform complete fresh verification.

- Add the optional, fail-closed `sanitized-html-v1` protocol capability and `commonmark-gfm+sanitized-html-v1` renderer profile. New packages render one safe structural HTML subset in both VS Code and the portable browser while older packages keep inert raw HTML.
- Capture raw `<img>` and explicit attachment references as normal content-addressed resources, inventory raw external links, and add exact text/image/table/cell source anchors. Active tags, styles, event handlers and unsafe schemes remain inert.
- Use the same sanitized DOM for audited PDF export, including merged raw HTML tables, and cover authoring, malicious markup, source mapping, real Chromium rendering and export.
- Keep Comment and Suggest actions reachable after deep scrolling, link comments and suggested edits bidirectionally to their exact document positions, and show review findings from every Markdown document by default with an optional selected-document scope.
- Make finding control initiator-managed for new reviews: reviewers may reply while a thread is open; only the initiator may decide, close, or reopen; closed findings expose only Reopen to the initiator. Show each participant's current approval/rejection/withdrawal state and only the valid next stance actions.
- Add eventual live visibility for off-document findings, persistent VS Code discussion scope, clear empty states, and a responsive findings panel that remains reachable in narrow editor columns.
- Export a self-contained offline PDF review archive with a challenge register, per-document challenge maps, dedicated full comments/responses/findings history, participant stance history, exact frozen documents/resources, internal navigation, and a detached exact-byte audit inventory. The review package remains the sole authoritative record.
- Add deterministic archive-reference tests, multi-document and simultaneous-participant Chromium coverage, responsive viewport checks, PDF content/link verification, and extension-host regression checks.

## 0.5.2

Regular release with known limitations; professional-pilot qualification remains incomplete. Core wire version remains 0.5.0. See [release notes](docs/releases/0.5.2.md).

- Update Sharp/native/WASM packages to 0.35.4 and the affected js-yaml 4 dependency to 4.3.2 for newly reported high-severity advisories; preserve the dependency audit gates.
- Normalize Windows path comparisons across current/legacy review registration, selection, removal and reconnection. Casing aliases do not create duplicate reviews or lose the active state; original display and journal paths are preserved.

- Add **Remove Review from List** and confirmed **Delete Review…** actions for current and legacy packages. Delete only validated dedicated folders through OS Trash/Recycle Bin, never permanent fallback; protect source/workspace roots, reject links/foreign content, recheck the inventory, and coordinate local writes. Clear active/tab/resume state while preserving other reviews and supporting reconnection. Whole-package filesystem deletion does not change the append-only protocol.
- Cover cancellation, changed folders, unsafe targets, unavailable storage, trash failure, local-operation exclusion, duplicate toolbox tabs, late writes, legacy rediscovery suppression and reconnection with unit and VS Code-host tests. OS trash transport and SMB are not qualified by simulated-trash tests.

- Hand the creation Reviewer ID and Display Name to the VS Code review toolbox. Remember later identity edits privately per review, preserve deliberate edits during slow startup, and never adopt a received package's creator as the participant.
- Replace the separate “Review Packages (0.5)” list with one Reviews list for current and legacy packages. Creation, opening and tab focus update Active Review and the status bar; closing the toolbox preserves the selection, and sidebar actions reopen it safely.
- Add real-browser and VS Code-host regression coverage for identity handover, the first comment's author, private preferences, received reviews, active-review restoration and queued navigation. Slidev navigation tests wait for the selected slide's rendered evidence before checking anchors.

## 0.5.1

- Implemented the three-layer Slidev design: framework-neutral core protocol, an optional versioned profile/schema and one shared VS Code/HTML adapter. Core wire version stays 0.5.0.
- Added explicit trusted author-side capture through VS Code and CLI, pinned Slidev rendering, nested/ranged/repeated source imports and real speaker-note exclusion from shared snapshots.
- Added frozen slide navigation, visual and exact-source comments, shared-source/repeated-occurrence semantics, and existing replies/decisions/suggestions/approval workflows without new event types.
- Added frozen slides, included notes and profile/schema/image evidence to complete audit PDFs. Participant clients execute no Slidev project and need no network/runtime server.
- Added parser, schema, consent, containment, Unicode/CRLF, rendering and real Slidev-to-browser-to-PDF tests, exercised by Linux/Windows CI. The author fixture has a separate lockfile and narrow documented PPTX-only dependency exceptions; the main application audit remains unmodified.
- Prepared standard release packaging without a pre-release marker. Professional-pilot gates remain open and SMB remains untested/skipped. See [release notes](docs/releases/0.5.1.md).

## 0.5.0

Published as a regular GitHub release with a limitations note at the user's request; professional-pilot qualification remains incomplete. The original tag and CI-tested assets are unchanged, including their internal pre-release packaging marker. See [release notes and limitations](docs/releases/0.5.0.md).

### 0.5 implementation

- Added an explicitly authorized evaluation release channel, GitHub/VSIX pre-release labels and release-policy regression tests without changing professional-pilot approval or removing outstanding gates.

- Added one shared protocol/session/rendering/reviewer/export core for VS Code and generated file-based HTML, plus parameter-driven authoring, revision, inspection, validation, export and client-update CLI commands.
- Added exact-byte 0.5 schemas/types, content-addressed independent events, causal lifecycle/revision rules, verification receipts, policy evaluation, pinned contexts and durable publication/capture recovery.
- Made the generated HTML a VS Code custom-editor entry file as well as a double-clicked browser entry. Every successful new review includes it; review content remains solely in the package.
- Added browser-side audited PDF/inventory publication with complete responses and event history; visually verified Mermaid, images and tables after correcting PDF SVG rendering.
- Added global bounded file I/O, incremental warm refresh, deduplicated audit reads, discussion search/paging, raster header limits and backed-up explicit HTML updates.
- Added cancellable/resumable GUI and CLI capture, drained parallel failure handling, separately staged source edits with exact recovery, and normal-button PDF retry across client reloads. Compact binary recovery encoding avoids numeric-array JSON expansion.
- Added real Chromium and VS Code extension-host tests, 10,000-event reconstruction, and CI-only Windows validation. Linux validation/packaging and Windows core/browser/extension checks passed in CI; see the implementation status report for exact evidence and remaining gates.
- Excluded SMB qualification from CI and release checks by user decision after runner share creation was denied. SMB and its dependent native-picker fixture remain untested; local Windows checks and other release blockers are preserved. The dormant share fixtures are retained for future authorized CI use.
- Bundled dependency inventories and license notices, including the actual shipped Roboto font license and Unicode folding data. Precompiled validators remove the browser's unsafe-eval requirement.

The following entries describe the preceding design/prototype stages; they are not additional qualification claims for 0.5.

- Specified the next professional pilot: one authoritative review package, full HTML/VS Code reviewer parity, shared VS Code/CLI authoring, a concrete 0.5 wire draft, and 27 traceable acceptance gates covering the critical design review. These are target requirements, not implemented fixes or a protocol release.
- Defined the client-neutral authority, cache, conformance-role, filesystem, browser-writer, identity, lifecycle, policy, audit, and protocol 0.5 standardization requirements.
- Removed the VS Code-only restriction from `export.created.renderer.client` so independent browser and CLI exporters can produce conforming audit metadata.
- Added a VS Code participant-access choice that can publish a generic, self-contained `OpenMarkdownReview.html` client after the first immutable revision.
- Added browser-side schema/digest validation, lazy frozen Markdown/resource loading, GFM tables, captured images, Mermaid, attachments, highlighted threads, polling, comments, replies, resolution, decisions, approval, rejection, and print output containing responses.
- Added a command for attaching the portable client to an existing active review without overwriting an existing file.
- Remembered each portable HTML file's granted review-directory handle locally so subsequent double-clicks can enter the review without selecting the folder again while permission remains valid.

## 0.4.6

- Moved Windows validation and release packaging to a managed downstream Windows runner pool used by `task-orchestrator`.
- Made cache-audit diagnostics retain protocol-canonical paths on Windows and safely retry transient cache-eviction failures.
- Made native VSIX packaging invoke npm reliably under Node.js 22 on Windows and report process-launch failures explicitly.
- Verified the full protocol, PDF, dependency-audit, portable-package, and `win32-x64` package pipeline on the enterprise runners.

## 0.4.5

- Added a persistent validated event/content cache and immediate in-memory folding after local writes.
- Reduced live polling to one event-directory inventory and removed recursive workspace/blob watchers.
- Deferred frozen Markdown/image/attachment loading until the rendered review is opened; full audit operations still verify every shared blob.
- Bounded filesystem concurrency for Windows, SMB, NAS, and endpoint-scanned folders, with a configurable limit.
- Avoided republishing unchanged content-addressed blobs when creating later revisions.
- Added operation timing, performance diagnostics, cache rebuild, and progress feedback for long shared-folder operations.
- Added a Windows-native `win32-x64` VSIX release alongside the portable WASM-backed package.

## 0.4.4

- Added near-real-time local-first synchronization for simultaneous reviewers using exact active-package watchers plus a configurable polling fallback.
- Added live watching for customized review package folders outside the VS Code workspace, including mounted and synchronized drives.
- Coalesced bursty filesystem notifications into serialized refreshes so concurrent arrivals cannot race or repeatedly rebuild the client.
- Kept the last known-good review visible while partial, invalid, or out-of-order synchronized files are quarantined and retried with bounded backoff.
- Added visible live/delayed/disabled synchronization status and notifications for newly synchronized comments and replies.
- Preserved the active document, scroll positions, and focused thread across rendered-review updates.
- Added M.I.R.D.A. as a non-binding project philosophy alongside the sole MIT license and declared the dual-license choice in package metadata.

## 0.4.3

- Closed protocol interoperability gaps with normative wire-format, path, ID, timestamp, publication, anchor, semantic-ID, lifecycle, conflict, and conformance rules.
- Added deterministic table-ID derivation and a protocol 0.4 portable-path conformance fixture.
- Added cross-file validation for manifest/revision publication identity, anchored document digests, semantic targets, Mermaid inventories, blob paths, and revision structure.
- Quarantined incorrectly named event files and competing root objects instead of choosing state by arrival order.
- Expanded the suite to 24 protocol, storage, rendering, PDF, and packaging tests.
- Added reproducible GitHub Actions CI and tag-driven VSIX release automation.

## 0.4.2

- Highlighted exact commented text in the frozen rendered review and marked comments attached to images, Mermaid diagrams, tables, and cells.
- Made highlighted content open and focus its discussion card; made the card location return to the anchored content.
- Displayed replies directly below their root comment in the rendered review.
- Added source-editor decorations, a gutter marker, and a hover action for comments anchored to the active immutable revision.
- Added keyboard navigation and fallback block highlighting when an exact inline anchor cannot be rendered.
- Added regression coverage for rendered comment linkage and visible reply content.

## 0.4.1

- Fixed installed-extension PDF export by packaging PDFKit's built-in font metrics and color profile beside the bundled runtime.
- Added regression coverage for packaged PDF assets and inclusion of comment replies in the audit event inventory.
- Made **Connect Existing Review** usable with no source workspace open by opening a received package directly as a frozen review.
- Automatically recognizes a review package when its folder itself is opened in VS Code.
- Falls back to the frozen rendered review when a received package does not include the sender's source checkout.

## 0.4.0

- Made the physical review-package directory freely nameable and independently locatable; `.review` is now only the default.
- Added portable package-relative protocol directories with read compatibility for protocol 0.2/0.3 `.review/...` references.
- Added multiple registered reviews per Markdown workspace with an explicit active-review switch.
- Added a dedicated Markdown Review Activity Bar icon with Reviews and Active Review views.
- Added create/connect flows for packages on local disks, mounted network shares, Git worktrees, or synchronized folders.
- Added package-local `.gitattributes` byte preservation for Git-backed audit integrity.
- Separated source-workspace paths from review-package paths throughout snapshots, rendering, attachments, events, and PDF export.
- Added custom-package and multi-review isolation tests.

## 0.3.1

- Added a visual Review Setup webview for non-technical onboarding.
- Added a searchable folder tree with folder/file checkboxes, select-all/clear, selected count, and start-document selection.
- Initialization now creates the first revision directly from the chosen documents.
- Existing reviews can reopen setup and create a new immutable revision with a different document scope.
- Snapshot capture now freezes only the exact selected Markdown paths.
- Added scope expansion, validation, selective-capture tests, and clearer Explorer onboarding.

## 0.3.0

- Added immutable per-comment decisions: accepted, rejected, won't-fix, and duplicate.
- Added exact-string insert, replace, and delete suggestions with rendered strikeout/insertion previews.
- Added suggestion acceptance, rejection, conflict detection, and explicit safe application to Markdown.
- Added before/after source hashes for applied edits.
- Added revision rejection with required reason.
- Added all new decisions and suggested edits to deterministic state, schemas, examples, UI, and audit PDF.
- Retained read compatibility with protocol/event version 0.2 files.

## 0.2.0

- Added immutable revision descriptors and content-addressed document/resource blobs.
- Added automatic local, HTTPS, and data-URI image capture.
- Added explicit `review:attach` Markdown attachments.
- Added external-reference inventory and URL secret redaction.
- Added rendered multi-document review with Mermaid, GFM tables, and frozen images.
- Added text, image, Mermaid, table, and table-cell comments.
- Scoped comments, resolution, and approval to exact revisions.
- Added client-side audit PDF generation and `export.created` events.
- Added atomic exclusive publication and integrity verification.
- Added JSON Schema conformance, security tests, PDF tests, pilot plan, and threat model.

## 0.1.0

- Initial append-only event-log proof of concept.
