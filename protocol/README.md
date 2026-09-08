# Open Markdown Review protocol 0.4

This document defines the portable, serverless protocol. The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY indicate interoperability requirements.

This remains the normative contract for existing 0.4 packages. The [professional client specification](../spec/PROFESSIONAL-V1.md) and [0.5 implementation draft](../spec/PROTOCOL-0.5.md) define the next target, including CLI authoring, full HTML review parity, exact audit inventories, and changed lifecycle/publication rules. They do not retroactively change this protocol or claim the current implementation is conforming.

## Package layout

The review package is a directory, not a required directory name. `.review` is the conventional default, but `.architecture-review`, `safety-approval`, or any other filesystem-safe name is equivalent. It MAY be inside the Markdown source workspace or at a separate local/mounted location.

```text
source-workspace/                  review-package/ (any name/location)
├── architecture.md               ├── manifest.json
└── images/                        ├── events/<event-id>.json
                                   ├── revisions/<revision-id>.json
                                   ├── blobs/sha256/ab/<64-character-hash>
                                   └── exports/<export>.pdf
```

A client MAY register multiple review packages against one source workspace. Each package is independent and is identified by its manifest `reviewId`; events from different packages MUST NOT be merged merely because they refer to the same source documents.

The normative data shapes are:

- [`schemas/manifest.schema.json`](schemas/manifest.schema.json)
- [`schemas/revision.schema.json`](schemas/revision.schema.json)
- [`schemas/event.schema.json`](schemas/event.schema.json)

Equivalent TypeScript types and independent runtime validation live under [`../src/protocol/`](../src/protocol/).

[`STANDARDIZATION.md`](STANDARDIZATION.md) defines the complete client-neutral standardization boundary and the wire-format gaps that must close before a future protocol version is declared. It does not silently change the 0.4 wire format.

## Authority and client independence

The selected review-package directory is the only authoritative review record. A VS Code extension, browser client, CLI, or other implementation MUST read and write the same manifest, revisions, blobs, events, and exports. A conforming client MUST NOT require a client-private database to interpret shared state and MUST NOT place client-specific mutable state inside protocol directories.

Authority is divided deliberately:

- the source workspace is authoritative for editable Markdown used to create a later revision;
- frozen revision blobs are authoritative for the exact material being reviewed;
- admitted immutable events are authoritative for review actions and assertions;
- an export's bytes and detached `export.created` event are authoritative for that artifact;
- active-review choice, open panels, filesystem handles, indexes, and caches are client-local and non-authoritative.

Freezing Markdown and required resources is audit evidence, not duplication between clients. Blob identity is content digest, so identical bytes are stored once and MAY be referenced by several documents, resources, or revisions.

A client MAY keep a memory, IndexedDB, or local-disk cache outside the review package. Such a cache MUST be reconstructible from authoritative package files, MUST NOT be synchronized as protocol state, MUST NOT cause a full audit to trust missing shared bytes, and MAY be deleted without losing review information.

Non-protocol files MAY exist at the package root and MUST be ignored by the state fold. For example, `OpenMarkdownReview.html` is replaceable client software, not a manifest extension, revision, event, blob, export, identity record, or audit authority. It MUST NOT embed review-specific authoritative state.

## Client conformance and filesystem contract

Protocol conformance is by behavior, not product name. A core reader validates and reconstructs state. A participant writer additionally publishes review events. An authoring writer additionally publishes revisions and may apply accepted suggestions to a separately selected source workspace. An audit exporter additionally publishes verified detached artifacts. A client MAY implement several roles.

A 0.4 participant writer requires filesystem operations capable of exclusive creation of an event file. It MUST generate a collision-resistant ID, construct the complete UTF-8 bytes, create the final target without replacing an existing name, close it, and report any failure. A client whose API only uploads copies or downloads files elsewhere is a reader, not a conforming participant writer. A single-file browser application is not exempt from these requirements; browser packaging and permission grants are outside the wire protocol.

Readers and writers MUST NOT use modification time, directory enumeration order, advisory locks, filesystem owner/ACL metadata, or a presumed Windows identity as semantic input. Mounted-share permissions control access to the directory but do not authenticate the `actor` recorded inside an event.

## Wire format, identifiers, and paths

All protocol JSON files MUST contain exactly one JSON object encoded as UTF-8. Writers MUST emit valid JSON without a byte-order mark and SHOULD terminate it with one LF byte. Readers MUST hash the exact file bytes rather than parsed or reserialized JSON. Object member order and insignificant JSON whitespace have no semantic meaning except when the file itself is the subject of a digest.

Every identifier used as a filename or cross-reference MUST match `[A-Za-z0-9_-]+`. An event ID MUST be unique within a review and its only valid filename is `<event.id>.json`. A `threadId`, `commentId`, `suggestionId`, revision ID, resource ID, diagram ID, reference ID, and export ID MUST identify exactly one logical object within a review. Reuse of an identifier for different content is an identity collision: the conflicting files MUST be excluded from reconstructed state and reported. It is not a last-write-wins update.

Protocol paths use `/` separators, are relative to either the source workspace or selected review-package root, and MUST be normalized before publication. An empty segment, `.`, `..`, backslash, NUL, drive-qualified path, or leading `/` is invalid. A client MUST resolve the normalized path and verify it remains below the intended root before reading or writing. A client MUST NOT follow a symbolic link or filesystem junction that escapes that root.

Timestamps MUST be RFC 3339 date-time strings; writers SHOULD use UTC with millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`). Ordering compares the represented instant and then the ASCII event ID, so equivalent timestamps with different offsets produce the same order. Timestamps provide deterministic presentation order, not trusted causality or identity. Positions use zero-based lines and zero-based UTF-16 code-unit offsets. Ranges are half-open: `start` is included and `end` is excluded; `end` MUST NOT precede `start`.

## Version and capability negotiation

`protocolVersion` governs manifest and package-layout semantics. `schemaVersion` governs the shape of an individual revision or event. A client MUST validate both independently. It MUST reject an unknown major/minor schema for an object it needs to interpret and MAY preserve unknown files without presenting them.

Manifest capabilities are declarations, not permission grants. Before writing an optional event family, a client MUST confirm its capability is present: `thread-decision-v1` for `thread.decided`, `suggested-edit-v1` for suggestion events, `review-rejection-v1` for `review.rejected`, and `audit-export-v1` for `export.created`. All 0.4 writers MUST advertise `quote-anchor-v1`, `range-anchor-v1`, and `content-addressed-resources-v1`. A reader MAY render supported core content when an unrelated optional capability is unknown, but MUST NOT silently reinterpret that capability.

## Immutability and publication

`manifest.json` is created once. Revisions, events, and blobs are immutable after publication. A conforming client MUST NOT edit or delete them during normal review operation.

Writers MUST publish with exclusive-create semantics and MUST fail rather than replace an existing target. The reference client writes a temporary file in the target directory and normally creates an exclusive hard link at the final name. On SMB/NAS filesystems that do not expose hard links, it uses an exclusive copy fallback; readers validate and ignore any file observed before transfer is complete. Readers MUST tolerate files arriving in any order.

Event filenames MUST be `<event.id>.json`. Blob paths MUST be derived from their SHA-256 digest:

```text
sha256:abcdef... → blobs/sha256/ab/abcdef...
```

Digest values cover the exact stored bytes. A revision event's digest therefore covers the UTF-8 revision JSON file including its final newline.

Publication of a revision is a two-phase append-only transaction:

1. Publish every document and resource blob by digest.
2. Publish and hash the revision descriptor.
3. Publish exactly one `revision.created` event last.

Readers MAY observe any prefix of those steps during synchronization. They MUST present a revision only after the publication event, descriptor digest, descriptor identity, and all referenced blobs verify. Missing files are a retryable incomplete-sync condition; digest or identity mismatches are integrity failures. Neither condition authorizes a reader to repair, replace, or delete received files.

## Manifest

The manifest establishes one `reviewId`, title, creation identity, Markdown scope hints, fixed package-relative protocol directories, and advertised capabilities. Protocol 0.4 directory values are `events`, `revisions`, `blobs/sha256`, and `exports`; the physical package name is deliberately absent. A 0.4 client MUST continue reading valid 0.2/0.3 manifests whose directory references begin with `.review/`, resolving that prefix against the selected physical package root. It MUST reject other unsupported versions rather than guessing their meaning. Event schema 0.3 remains current; new lifecycle event types declare `schemaVersion: "0.3.0"`.

`manifest.json` does not embed an absolute source path or storage path. Source-to-package association and the choice of active review are client-local concerns, which keeps a copied or mounted package portable between machines.

Actor IDs are self-asserted strings. Display names are descriptive and MUST NOT be treated as authenticated identity unless an explicit profile adds verifiable signatures and authorization. Typing a name proves no more than self-declaration. SMB/Windows authentication may restrict access to the package, but browser and portable clients MUST NOT claim that filesystem access authenticates an event author.

## Review scope

`manifest.documents` records the initial document-selection hints. New clients SHOULD write exact workspace-relative Markdown paths; older clients MAY use glob hints such as `**/*.md` or `docs/**/*.md`.

The authoritative scope of a published revision is its `ReviewRevision.documents` array, not the current live workspace and not a mutable client preference. Every entry contains the exact path, digest, blob path, media type, and byte length frozen for that revision.

A client MAY let the user select individual Markdown files, complete folders, or a different start document for a later revision. It MUST publish that selection as a new immutable revision. It MUST NOT alter an existing revision or imply that comments on an earlier revision automatically cover newly selected documents. Folder selection is a client convenience that expands to exact file paths before publication.

## Immutable revisions

A revision freezes the material being reviewed. It contains:

- an ID, review ID, creator, and timestamp;
- the root document used for review and PDF ordering;
- every Markdown document as a content-addressed blob;
- captured embedded images and explicit attachments;
- ordinary external references;
- Mermaid source blocks and source digests;
- diagnostics and pinned renderer metadata.

A revision is not active merely because its descriptor exists. It becomes part of the review when a matching `revision.created` event references its path and digest. Clients MUST verify both before presenting or approving it.

The following cross-file invariants are REQUIRED:

- `manifest.reviewId`, `revision.created.reviewId`, and `revision.reviewId` are equal.
- `revision.created.revisionId` equals `revision.id`.
- `revision.created.revisionPath` equals `<manifest.revisionDirectory>/<revision.id>.json`.
- `rootDocument` occurs exactly once in `documents`; document paths are unique and their media type is `text/markdown`.
- Every resource, external reference, Mermaid descriptor, and diagnostic document refers to a document in the same revision.
- Every stored-content `blobPath` encodes the same lowercase hash as its `digest`: `<blobDirectory>/<first-two-hash-characters>/<64-character-hash>`.
- Resource IDs, reference IDs, and diagram IDs are unique within their respective arrays. Mermaid ordinals are contiguous from zero within each document, and `sourceDigest` hashes the UTF-8 Mermaid `source` exactly.
- A revision with an unresolved error diagnostic MUST NOT be published. Warnings MAY be published and MUST remain visible to reviewers.

The latest revision for display is the final `revision.created` event ordered by `(occurredAt, id)`. Clock skew can affect this presentation choice. It does not change the immutable contents or thread semantics of any revision.

## Resource and external-reference policy

Embedded Markdown images are REQUIRED review content. Clients MUST capture their bytes before publishing a revision, regardless of whether the source is relative, a data URI, or HTTPS. Failure to capture an embedded image MUST block revision publication unless a future policy profile explicitly permits incomplete revisions.

Ordinary Markdown links are recorded in `externalReferences` but are not fetched. This prevents an innocent review from archiving arbitrary websites, authentication flows, or mutable remote applications.

A link with the Markdown title `review:attach` declares that the linked bytes are review evidence:

```markdown
[Decision record](records/decision.pdf "review:attach")
[External evidence](https://example.org/evidence.pdf "review:attach")
```

Conforming clients MUST freeze these bytes as `RevisionResource.role = "attachment"`. Implementations MUST enforce size and timeout limits and SHOULD reject active content. References stored in shared metadata SHOULD redact URL credentials and common secret-bearing query fields after fetching.

Blob deduplication is by content digest. Multiple Markdown references MAY point to the same blob while retaining independent resource IDs and origin metadata.

### Deterministic semantic IDs

SHA-256 inputs below are UTF-8 and `NUL` means one zero byte. `first24` means the first 24 lowercase hexadecimal characters of the digest. These rules allow another client to reproduce semantic targets without client-private state:

| Object | Required derivation |
| --- | --- |
| Embedded image or attachment | `resource_` + `first24(SHA-256(document + NUL + original Markdown reference))` |
| Ordinary external reference | `reference_` + `first24(SHA-256(document + NUL + original URI))` |
| Mermaid diagram | `diagram_` + `first24(SHA-256(document + NUL + decimal ordinal + NUL + source))` |
| GFM table | `table_` + `first24(SHA-256(document + NUL + decimal ordinal))` |

The original reference/URI is the exact destination emitted by the Markdown parser before credential redaction. Mermaid `source` is the fenced block content with trailing line endings removed, and ordinals count Mermaid blocks in source order from zero. Table ordinals count GFM tables in source order from zero. For table-cell anchors, the header row is row `0`, body rows follow, and columns start at `0`.

## Mermaid and tables

Mermaid source remains part of the frozen Markdown and is additionally indexed by stable diagram ID, document, ordinal, and source digest. A client MUST NOT fetch Mermaid code or themes from a CDN. Renderers MUST record their Mermaid version.

The reference client stores SVG output from each exported diagram as a content-addressed blob and places its digest in `export.created`. Export MUST fail if any diagram cannot be rendered.

Tables use GitHub-Flavored Markdown semantics. Table-cell anchors identify the stable table ID plus zero-based row and column, while retaining a quote and source range for recovery.

## Anchors

Every root comment contains:

- `revisionId` on the event;
- the workspace-relative document path;
- the frozen document digest;
- a zero-based source range;
- exact quote plus optional prefix and suffix;
- an optional semantic target: text, image, Mermaid diagram, table, or table cell.

Clients SHOULD check the stored range first, then locate the exact quote and rank duplicate matches using context and proximity. Semantic IDs improve rendered navigation; quote and range selectors remain the interoperable fallback.

Before accepting an anchored event into state, a client MUST verify that the event and anchor reference the same published revision, that `anchor.document` occurs in that revision, and that `anchor.documentDigest` equals the frozen document digest. An image target MUST identify an image resource in that document; a Mermaid target MUST identify a diagram in that document; and a table target MUST use the deterministic table ID above. Invalid contextual events are ignored with a visible warning, not allowed to attach to similarly named live content.

If the stored range extracts `quote.exact`, it is the primary location. Otherwise a client SHOULD enumerate every exact-quote occurrence, score adjacent prefix and suffix matches before source-offset proximity, and use a deterministic lowest-offset tie break. If no exact occurrence exists, it MUST report an orphaned anchor and MAY show the stored block/range as a non-exact fallback. It MUST NOT silently attach the comment to different text.

## Events

Every event contains `schemaVersion`, `id`, `type`, `reviewId`, `revisionId`, `occurredAt`, and `actor`.

| Event | Meaning | Important fields |
| --- | --- | --- |
| `revision.created` | Publishes a frozen revision | `revisionPath`, `revisionDigest` |
| `comment.created` | Opens a revision-scoped thread | `threadId`, `commentId`, `anchor`, `body` |
| `comment.replied` | Adds an immutable reply | `threadId`, `commentId`, optional `inReplyTo`, `body` |
| `thread.resolved` | Closes a thread monotonically | `threadId`, optional `note` |
| `thread.decided` | Decides an individual comment | `threadId`, `decision`, optional `reason` |
| `review.approved` | Records one actor's approval of an exact revision | optional `note` |
| `review.rejected` | Records one actor's rejection of an exact revision | required `reason` |
| `suggestion.created` | Proposes an anchored text edit | `suggestionId`, `anchor`, `operation`, `rationale` |
| `suggestion.accepted` | Accepts a proposed edit | `suggestionId`, optional `note` |
| `suggestion.rejected` | Rejects a proposed edit | `suggestionId`, optional `reason` |
| `suggestion.applied` | Confirms an accepted edit was written to source | `suggestionId`, document, before/after digests |
| `export.created` | Records a detached audit artifact | PDF path/digest, included IDs, renderer metadata, diagram digests |

`thread.decided.decision` is one of `accepted`, `rejected`, `wont-fix`, or `duplicate`. Decisions are immutable. If synchronized clients publish different decisions for the same thread, clients MUST expose a decision conflict and MUST NOT silently use a last-write-wins rule. Multiple matching decisions MAY be presented as agreement.

`comment.replied.inReplyTo`, when present, MUST identify either the root comment or a reply in the same thread and revision. A missing parent is dangling until synchronization supplies it. Reply display order is `(occurredAt, id)`; nesting MAY be displayed, but flattening replies in that same deterministic order is conforming. A thread is open until at least one `thread.resolved` or unconflicted `thread.decided` assertion exists. Resolution is monotonic in protocol 0.4. If several resolution events exist, the first by `(occurredAt, id)` is the effective closing assertion and every assertion remains auditable.

Root IDs are not update keys. Multiple distinct `comment.created` events with one `threadId`, or multiple distinct `suggestion.created` events with one `suggestionId`, are identity conflicts and none of the competing roots may be chosen by last-write-wins. Child events whose root has not arrived, whose revision differs, or whose parent ID belongs to another object remain dangling and MUST NOT affect visible state.

Approval and rejection are actor assertions, not a mutable global flag. A revision can therefore contain several approvals, rejections, or both. Required counts and authority are client or organizational policy; an audit export MUST retain every assertion and its reason or note.

## Suggested edits

`suggestion.created` anchors an exact text string to a frozen document digest. Its operation is one of:

- `delete`: remove the anchored string;
- `replace`: replace it with `replacement`;
- `insert`: retain it and add `replacement` immediately `before` or `after`.

Clients SHOULD render replaced or deleted source using strikeout and proposed content as an insertion. This is a presentation of an immutable proposal; creating or accepting a suggestion MUST NOT modify Markdown.

A client MUST apply only a suggestion with an unambiguous `suggestion.accepted` event and no rejection conflict. Before applying it, the client MUST verify the frozen document digest or re-locate the exact quote using prefix/suffix context. It MUST require an explicit user action, write and save the source, compute the pre-edit and post-edit SHA-256 digests, and only then append `suggestion.applied`. Rejected or conflicted suggestions MUST NOT be applied. Updated source requires a new review revision; an applied event never mutates the frozen revision.

If both acceptance and rejection events exist for one suggestion, its status is `conflicted` independent of file arrival order. An `applied` event without an unambiguous acceptance MUST also be presented as a conflict or invalid lifecycle, never as a successful edit.

Multiple acceptance assertions without a rejection are agreement; multiple rejection assertions without an acceptance are agreement. The first assertion by `(occurredAt, id)` MAY supply the compact status label, but every assertion and note/reason remains in the audit history. `suggestion.applied.document` MUST equal the root anchor document, `sourceDigestBefore` MUST describe the bytes actually read before the write, and `sourceDigestAfter` MUST describe the successfully persisted bytes.

`export.created.includedEventIds` lists the pre-existing events represented in the PDF. The PDF's own digest is kept in the detached event because embedding a file's digest inside itself is mathematically self-referential.

`export.created.renderer.client` is a non-empty implementation identifier such as `open-markdown-review-vscode` or `open-markdown-review-browser`. It is audit metadata, not a required client brand. Readers MUST NOT reject an otherwise supported export because it was produced by an independent implementation.

## State reconstruction and synchronization

Clients MUST:

1. Validate the manifest.
2. Read complete `.json` files from `events/`.
3. Validate them and filter by `reviewId`.
4. Deduplicate by event ID.
5. Sort presentation order by `(occurredAt, id)`.
6. Resolve replies, thread decisions, and suggestion events only when their root object and `revisionId` match.
7. Retain or report dangling events and retry after synchronization.

The complete deterministic reconstruction procedure is therefore:

1. Admit valid, correctly named event files for the manifest `reviewId`.
2. Order them by the instant represented by RFC-3339 `occurredAt`, then by ASCII `id`.
3. Admit and verify published revisions independently of thread state.
4. Resolve root comments and suggestions by their unique IDs; quarantine identity collisions.
5. Attach only revision-matching replies and lifecycle assertions whose roots exist.
6. Derive conflicts from the set of immutable assertions, never from arrival order.
7. Select the latest valid published revision for presentation from the final ordered `revision.created` event.

An implementation MUST produce the same semantic state for every permutation of the same valid file set. Filesystem enumeration order, JSON member order, and synchronization arrival order MUST NOT change the result.

Invalid or partially synchronized files MUST be ignored with a warning and MUST NOT trigger mutation of valid files. SharePoint, OneDrive, SMB, Syncthing, Dropbox, and Git normally merge the protocol as a union of independently named immutable files.

A live client SHOULD combine filesystem notifications with a bounded polling fallback because mounted and synchronized filesystems may coalesce or omit notifications. Refresh work MUST be serialized or otherwise produce the same result as a serialized fold. A client observing incomplete files, dangling children, disappearance of previously admitted events, or mutation of an admitted event ID SHOULD retain its last known-good state, retry after a bounded delay, and expose delayed or integrity-failure synchronization rather than presenting regressed data as current. “Live” means near-real-time observation after files reach the local filesystem; the protocol does not promise network delivery latency or perform Git fetch/pull operations.

Plain local filesystems and mounted network shares require no provider-specific integration. For Git storage, clients SHOULD ensure that line-ending or clean/smudge filters do not alter package bytes. The reference client creates a package-local `.gitattributes` rule that marks review contents `-text`; repositories SHOULD commit it with the complete review package.

## Audit export

A conforming audit PDF SHOULD contain the frozen documents, captured images, rendered Mermaid, tables, comments, replies, comment decisions and conflicts, suggested edits and their lifecycle, approvals, rejections, document/resource digests, external references, renderer versions, and included-event digests.

The export MUST be produced from frozen revision blobs, not live workspace files or live URLs. An `export.created` event MUST be appended only after the final PDF bytes have been written and hashed successfully.

## Security and limits

Protocol files and attachment bytes are untrusted data. Clients MUST NOT execute them. Raw HTML SHOULD be disabled; SVG and Mermaid output MUST be sanitized or rendered in a strict sandbox; webviews SHOULD use a restrictive content-security policy. Source references MUST be resolved within the source workspace; protocol references MUST be resolved within the selected review-package root. Download size, redirects, protocols, and timeouts MUST be bounded.

Protocol 0.4 does not provide cryptographic actor signatures, event deletion/editing, thread reopening, or authenticated web capture. These can be added through explicit future events or profiles without weakening existing immutable history.

Protocol 0.4 also cannot make a browser grant filesystem access. A local HTML client MAY participate only when its runtime provides the required read/write and exclusive-publication behavior for the explicitly selected package. Read-only directory upload and downloaded event files do not satisfy participant-writer conformance.

## Conformance

A protocol 0.4 participant writer is conforming when it emits schema-valid files, follows exclusive append-only publication, satisfies every event invariant, and never emits an event family without its advertised capability. An authoring writer additionally satisfies every revision/resource invariant and freezes required resources. An audit exporter additionally builds from verified frozen inputs and publishes the detached artifact event. A reader is conforming when it validates and verifies before presentation, reconstructs deterministic state, exposes conflicts/dangling data/integrity failures, and does not execute untrusted content.

[`IMPLEMENTER-CHECKLIST.md`](IMPLEMENTER-CHECKLIST.md) maps these requirements to a client build sequence and required tests. The checked-in schemas are structural validation; the cross-file and state-machine rules in this document remain normative where JSON Schema cannot express them.

See [`fixtures/v0.4/`](fixtures/v0.4/) for the current portable-path conformance package with Markdown, Mermaid, a table, an embedded SVG, replies, comment decisions, a suggested edit, and approval. [`examples/`](examples/) is retained as a complete legacy 0.3 compatibility package with audited exports.
