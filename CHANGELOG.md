# Changelog

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
