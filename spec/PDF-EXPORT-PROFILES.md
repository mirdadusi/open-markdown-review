# Client PDF export profiles

These are client rendering profiles, not a new wire-protocol version. Protocol 0.6.0 files remain the single source of truth. All clients use the same renderer and frozen input validation; Go/legacy Node companions provide transport, not another PDF engine.

Interactive export lists concrete verified snapshots and defaults to the unique
latest head, not necessarily the displayed snapshot. Competing heads require an
explicit choice; timestamps never choose a branch. Changing the export selection
does not move the document view. The selection applies to either mode below and
binds its audit/recovery context. Findings on other snapshots are not reanchored
onto selected text. See [the snapshot guide](../docs/COMMENTS-AND-EXPORT-SNAPSHOTS.md).

## Review PDF: `omr-review-annotations-v1`

The default `review` mode is an offline review archive. Fresh verification captures an immutable revision and observed event inventory. The PDF contains reviewer progress, current review decisions, frozen documents/resources, reference inventory and audit details. Reviewer completion and participation is a concise table; invitation details, completion/reopen notes and participant event IDs are not duplicated below it. The detached inventory identifies exact input/output bytes and represented events; `export.created` is appended only after PDF/inventory publication succeeds.

Findings use PDF 1.7 markup with Unicode author/content, timestamps, popup records and reply relationships (`IRT`/`RT`). Highlights mark text, strikeouts show proposed deletion/replacement without changing the frozen source, and bounded squares mark semantic objects. Cross-page continuation annotations share the finding subject/root event; reply references remain on one page as required by the PDF format. Overlapping findings retain independent identities. Nested replies point to their actual parent. Decisions and resolution/reopening history remain annotation replies; state/model entries are PDF text strings. Invisible source anchors become explicitly labeled source-only notes at the corresponding document, not guessed highlights. Original navigation is preserved. See the [Adobe PDF annotation reference](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.6.pdf).

Comments belong in the PDF reader’s Comments/Annotations panel, not extra findings pages. The toolbox explains this; it cannot force every reader to show a sidebar. A reader without annotation support will not show complete discussion. PDF comments are derived output: editing them never writes back to protocol files.

Reviewer progress uses text labels plus orange for in-progress/reopened and green for finished. Not-started remains neutral. Completion is independent of approval. Verification timing remains in the machine-readable inventory's `verifiedAt`, not a visible verification-cutoff field. These presentation changes do not remove any underlying event evidence.

## Clean document PDF: `omr-document-only-v1`

The `clean` mode projects every document in the selected frozen revision, root first then deterministic path order, with frozen images, Mermaid, tables and supported document links. It MUST omit client-generated review covers/titles, IDs, participants, progress, finding markup, discussion, review decisions, audit appendices and hidden review attachments. Original document text may itself name people or reviews; export does not redact or rewrite source content.

Clean output is not audit evidence and MUST NOT append `export.created`, pretend to represent events, or weaken inventory validation. It may save optional content-addressed `exports/<sha256>.pdf` bytes. A private client-local recovery plan binds mode, review, revision, actor, operation, output digest and length. No plan or reviewer data is embedded in the PDF or copied into shared review state. Existing protocol 0.6 readers may ignore unreferenced optional exports. Successful clean output does not imply review approval or completion.

## Recovery, access and conformance

The export dialog exposes **Include document list (table of contents)**,
independent of template selection. It initially defaults to on for an archive
and off for a clean document. Disabling it removes only the index, never source
documents/slides, their content links or native review comments. A clean list
contains document/slide titles and page numbers, not review identifiers or
participation data. The confirmed choice is private per client/review.
See the [presentation profile](../protocol/profiles/pdf-templates-v1.md#optional-document-list)
for its renderer token and compatibility rules. Recovery must reject changed
document-list settings under the same operation ID.

- GUI and CLI expose explicit `review|clean` selection, defaulting to review. Unknown modes fail before rendering. CLI: `omr review export ... --export-mode clean`.
- Retry pointers are isolated by mode, revision and actor. Interrupted immutable publication resumes identical planned bytes, never a replacement under the same digest.
- Native open/reveal accepts an admitted audit event ID or a verified private clean operation, never an unchecked path. Download verifies PDF length/digest first. Foreign/stale/tampered plans and outputs fail closed.
- Both modes preserve frozen UTF-8 bytes; supported fonts, image ratios, table bounds, local links and unsupported-glyph failure apply equally.
- Both modes share the [frozen chapter-aware document order](../protocol/profiles/document-order-v1.md) with the reader. Folder names do not move a numbered Scope chapter behind all feature documents. Existing export plans still recover their exact original bytes.
- Tests inspect annotations/parents, Unicode, geometry, links, no clean review metadata/annotations/attachments, cancellation, uncertain-write recovery and cross-client creation/participation/export.
