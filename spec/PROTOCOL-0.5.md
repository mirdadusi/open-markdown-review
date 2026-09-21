# Protocol 0.5 implementation draft

Status: professional-pilot wire contract, implementation candidate, 2026-09-08. Schemas, shared types and clients now exist, but this is not a qualified release or migration instruction. See [implementation evidence and remaining gates](IMPLEMENTATION-STATUS.md). Implement together with [PROFESSIONAL-V1.md](PROFESSIONAL-V1.md) and its [acceptance gates](ACCEPTANCE.md).

This document specifies changes to the existing [0.4 wire contract](../protocol/README.md). Unchanged fields retain their 0.4 shapes. Rules here replace 0.4 only for new `protocolVersion: "0.5.0"` packages. Schemas, types, validators, fixtures, and all clients must be updated together before that version is emitted by a released client. Historical 0.4 acceptance/resolution semantics remain unchanged when reading old packages.

## Package and version declarations

```text
review-package/                         any chosen directory name
  manifest.json                         immutable package identity/profile
  events/<event-byte-sha256>.json        one immutable action per digest name
  revisions/<revision-id>.json           immutable native-author publication
  blobs/sha256/<first-two>/<sha256>      Markdown, resources, policy, verification inventory
  exports/<pdf-byte-sha256>.pdf          derived, audited artifact
  exports/<inventory-byte-sha256>.inventory.json
  Review-<portable-name>.html           required review-bound product entry file
  .gitattributes                        exact-byte Git preservation
```

There is no shared `comments.json`, mutable review database, active-revision pointer, identity cache, or client-specific sidecar. The HTML is not part of the event/revision inventory and is never interpreted as review evidence.

Every successful VS Code/CLI product creation installs this entry file. Its portable filename is deterministically derived from the review title using ASCII letters, digits, dot, underscore and hyphen; the `Review-` prefix and `.html` suffix are fixed. The file embeds only launcher schema version, review ID, title, and exact `manifest.json` digest. Double-click opens the browser toolbox (with an explicit first-use browser folder grant) and refuses a selected folder whose identity/digest differs; opening the same file in VS Code invokes the extension's custom editor. Missing/replaced HTML does not invalidate protocol evidence: creation is incomplete as a product deliverable until installation succeeds, while another conforming client can still read the package. Runtime JavaScript, Mermaid, fonts and PDF dependencies are permitted and bundled with the client. `OpenMarkdownReview.html` is accepted only as a legacy 0.5 client filename for explicit migration.

Manifest 0.5 retains `protocol`, `reviewId`, `title`, `createdAt`, `createdBy`, `documents`, the four portable directory fields, and `capabilities`. It requires these additional declarations:

| Field | Required value/meaning |
| --- | --- |
| `protocolVersion` | `0.5.0` |
| `eventLayout` | `sha256-flat-v1`; event filename is 64 lowercase hex digits plus `.json` |
| `identityProfile` | `self-asserted-v1`; no signature/authenticated-person claim |
| `limitsProfile` | `pilot-v1`, with the limits below |
| `creationOperationId` | Filename-safe operation ID used to identify resumable native creation |
| `requiredCapabilities` | Contains every core capability listed below; unsupported required entries prevent participant writing and approval |

Required core capabilities are `quote-anchor-v1`, `range-anchor-v1`, `semantic-anchor-v1`, `content-addressed-resources-v1`, `revision-parents-v1`, `thread-lifecycle-v2`, `suggested-edit-v2`, `review-stance-v1`, `review-policy-v1`, and `audit-inventory-v1`. `capabilities` contains at least these entries. A writer checks required semantics for every emitted family, not only their presence in a schema.

New packages produced by the current clients also require `creator-thread-control-v1`. Under that capability, `thread.decided`, `thread.resolved`, and `thread.reopened` are admitted only when `actor.id` exactly equals immutable `manifest.createdBy.id`; other actors may create comments and reply while a thread is open. This is a deterministic protocol role, not authentication: `self-asserted-v1` cannot prove who typed an actor ID. Older 0.5 packages without the capability retain their earlier lifecycle-admission behavior and are not reinterpreted; the current UI still presents the safer initiator-managed workflow.

New packages produced by the current clients also require `sanitized-html-v1` and every revision uses renderer profile `commonmark-gfm+sanitized-html-v1`. Capability and profile MUST either both be present or both be absent. The profile defines a closed structural HTML subset, frozen raw-HTML image/attachment discovery, external-reference handling, exact anchors and audit-PDF behavior in [Sanitized Markdown HTML profile v1](../protocol/profiles/sanitized-html-v1.md). Unsupported clients disable participation instead of silently showing a different document. Earlier packages without the capability keep `commonmark-gfm`, in which raw Markdown HTML is inert literal text.

Optional extension declarations use `extensions[]` entries `{ id, schemaUri, schemaDigest, schemaBlobPath, affectsState }`. IDs are absolute namespace URIs. Schema bytes are captured as ordinary content-addressed blobs. Schema URI is descriptive, not permission to fetch or execute anything. Unsupported `affectsState: true` extensions put the package in inspect-only mode. Unsupported presentation-only extensions are preserved, disclosed, and cannot alter admission, lifecycle, policy, or audit conclusions. Base writers omit extensions unless their implementation explicitly supports their schema digest. Unknown ordinary object properties are rejected. Application 0.5.1 implements presentation-only data through the separately specified [presentation profile transport v1](../protocol/profiles/README.md): declared schema and descriptor are ordinary content-addressed attachment resources, with no extra event/revision fields. Packages using this transport require `presentation-profiles-v1`; unsupported clients disable participation rather than claim visual conformance. A generic `extensions` data object on events/revisions remains unimplemented and is not emitted.

The manifest is immutable. This pilot does not add mutable capability adoption: enabling new state-affecting semantics requires a later explicit protocol/profile design, not editing the manifest.

## Exact bytes, identifiers, and paths

All JSON is one UTF-8 object with no BOM, invalid UTF-8 sequences, unpaired surrogate escapes in strings, duplicate member names, or non-finite numbers. Native and browser parsers enforce identical rejection rules. Writers use LF termination; readers accept otherwise schema-valid JSON without a trailing newline. Digests always cover the bytes actually stored. JSON whitespace and member order are not semantic order and MUST NOT be normalized before byte verification.

Identifiers used as logical object IDs match `[A-Za-z0-9_-]{1,128}`. Actor IDs are case-sensitive strings of 1–128 Unicode scalar values without controls or leading/trailing whitespace; names are descriptive. Publication IDs use at least 128 random bits. Reader presentation order is timestamp instant, then ASCII event ID. Timestamps use full RFC-3339 date-times with seconds and an explicit timezone; date-only/local-time forms and leap seconds are rejected. Writers emit UTC with millisecond precision.

Stored JSON field paths and source document identifiers use `/`. Reject empty, dot, dot-dot, NUL/control, backslash, leading slash, drive-prefix, and colon-containing segments. Every segment is NFC-normalized, contains no trailing dot/space or Windows reserved device basename (including a device basename before an extension), and is at most 255 UTF-8 bytes; a path is at most 1,024 UTF-8 bytes. Reject aliases among a revision's paths under both exact NFC comparison and Unicode 15.1 full case folding. Both clients use the same shipped folding data. Preserve the accepted case of paths in events and resource-ID derivations.

These are protocol paths, not a ban on normal `../` Markdown resource links. Authoring resolves and checks Markdown destinations against explicitly granted native roots before producing safe package references. Package I/O also enforces actual filesystem containment; lexical validation does not replace it.

Source text uses its exact decoded bytes: CRLF is one line break, LF and lone CR are one line break each, and positions are zero-based UTF-16 code-unit offsets within a line. Ranges are half-open and cannot split a surrogate pair or exceed document bounds. `quote.exact` is the exact source substring including original intervening line endings. Rendering normalization must keep a reversible offset map.

## Revisions and references

Every new revision uses `schemaVersion: "0.5.0"` and retains the existing revision fields, with:

| Field | Requirement |
| --- | --- |
| `parents` | Unique revision ID array, empty for the first revision; otherwise explicitly references published, verified revisions in the same review |
| `policy` | `StoredContent` reference with media type `application/json` to the immutable policy below |
| `creationOperationId` | Author operation ID; publication retries reuse the original descriptor and event bytes |
| `renderer.markdownProfile` | `commonmark-gfm`, or `commonmark-gfm+sanitized-html-v1` when and only when the immutable manifest requires `sanitized-html-v1` |

Each parent must have exactly one valid publication. The revision graph is acyclic. A missing parent is pending, a cycle or competing descriptor/publication identity is invalid. A head has no admitted child revision. Multiple heads are a branch conflict. A merge revision lists all heads selected by the author and captures its chosen complete document set; it does not silently merge source text or carry forward approvals/threads. Distinct simultaneous initial revisions are also competing heads.

All document paths, semantic IDs, resource ownership, byte lengths, and digest-derived paths are validated. Mermaid source is recomputed from the frozen Markdown, compared with the descriptor, and hashed. Table IDs retain the 0.4 document-plus-ordinal derivation; cells use row 0 for the header. IDs for images, attachments, diagrams, and references retain the 0.4 derivations using the exact parser-emitted reference before metadata redaction.

Resources retain their 0.4 fields; `sourceKind` adds `granted-root` for local resources explicitly authorized outside the source workspace. Absolute authoring roots are not stored as package configuration. URLs/paths already present in frozen source remain part of that source; metadata redaction does not erase secrets from Markdown. Creation must disclose detected secret-bearing references before capture, so the author can change source. Captured resource metadata uses sanitized origin descriptions.

Ordinary external references keep their 0.4 form for absolute URIs. Under `sanitized-html-v1`, raw anchors with absolute `http`, `https`, `mailto`, or `file` references enter the same inventory. Only `https` and `mailto` are actionable; other absolute schemes remain visible audit evidence but are blocked by the client. Internal document/heading links are resolved from frozen Markdown against the revision inventory and do not need an external-reference record. An outside local path is captured only as an explicit attachment under an authorized root, not automatically opened by a reviewer as a live filesystem link.

The HTML profile is not a parallel document or extension-data store. Sanitization never changes frozen Markdown bytes, and raw HTML images/attachments are normal revision resources with the existing semantic-ID and content-addressed-blob rules. Markdown tables and raw tables share one source-order ordinal space. Audit export renders the same sanitized structure and records the sanitizer version; it never executes or fetches source HTML.

## Event envelope and immutable identity

All 0.5 events require:

```ts
interface EventEnvelope05 {
  schemaVersion: "0.5.0";
  id: string;
  type: string;                 // one of the event families below
  reviewId: string;
  revisionId: string;
  revisionDigest: Sha256Digest; // exact descriptor bytes for that revision
  occurredAt: string;
  actor: { id: string; displayName?: string };
  operationId: string;          // local intent identity, stable across retry
}
```

The envelope's revision digest must match the unique `revision.created` publication. `revision.created` itself retains `revisionPath` and uses the envelope's `revisionDigest`. A logical ID naming different exact event bytes is a collision: all candidates and dependent actions are excluded from current reconstructed state and visibly quarantined. Same-byte transport copies do not count twice. Same `(actor.id, operationId)` naming different event bytes is also a conflict; one operation ID publishes one event. Authors allocate child operation IDs for distinct publication steps.

Load digest-named files only. A sync-provider conflict copy containing the exact bytes of an already admitted file is a redundant transport copy and may be ignored with a diagnostic. A differently named JSON file claiming a protocol action without a verified canonical counterpart is quarantined and disclosed; it must not disappear from an audit failure report. Clients never automatically rename/delete received files.

## Publication and retry

For events, blobs, verification inventories, and export artifacts, the expected digest is computed before opening the final path. The expected hash and extension determine the complete path. Assuming SHA-256 collision resistance, two different valid byte sequences cannot share a digest target; this provides content identity, not a native exclusive-create promise.

1. Validate the complete immutable intent and its current prerequisites. Record the exact bytes, expected digest/path, operation ID, and not-yet-acknowledged status in the client-local recovery journal before starting publication.
2. Read an existing target if present. Matching bytes/digest mean the same publication already exists; finish verification and reuse it. Different bytes are not silently replaced. A previously admitted file with changed bytes is an integrity failure.
3. When absent, write through the adapter. Native writers use exclusive publication where supported. Browser writers use their granted handle and staged write/close. Both verify the exact closed bytes by rereading and hashing before reporting saved.
4. After interruption or uncertain close, retry the same path and exact bytes. First check whether they are already complete. A client may finish its own unacknowledged, never-admitted partial target only when its recovery journal identifies that target/bytes and existing bytes are empty or an exact prefix of the intended bytes. Otherwise it reports a conflict/integrity failure and does not overwrite. Readers never repair partial files.
5. Use bounded retry for temporary unavailability. Permission loss pauses publication for user action. An uncertain result is not success, and retry never creates a fresh event ID for the same action.
6. Once acknowledged, the file is immutable. Provider disappearance/alteration is reported and cannot trigger automatic recreation as a new review action.

Writes of identical pending content may overlap; readers admit only exact complete digests. The normal reader never depends on atomic rename, advisory locks, modification time, filesystem owner, or exclusive-create support for the new digest layout. Failed writes that cannot be recovered remain explicit failures; local journal loss does not authorize guessing or replacing package files.

Native authoring publishes captured blobs and policy, then an exclusive revision descriptor, then its content-addressed `revision.created` event. The first manifest is exclusively created in a new/empty target; initialization without a published revision is visibly incomplete. Browser participant writers do not publish manifests or source revisions.

Copying or relocating a complete package is storage transport, not a protocol mutation. The copy retains the same exact manifest and review ID and creates no event. A client-assisted publication writes into an empty destination, copies exact package files without following links, writes `manifest.json` last, re-inventories and hashes both sides, fully validates the destination, and refuses activation if the source changed during the operation. The old copy is not another authority and is never automatically deleted. Clients warn against writing to two unsynchronized copies; convergence requires an external transport to union their immutable files.

Native editable-source roots are client-private bindings. They are never package fields and cannot be inferred from a reviewer's checkout path. Protocol 0.5 document identifiers are relative to one explicit authoring source root. Multi-root document authoring requires a future declared capability with collision-free portable namespaces; `granted-root` remains resource capture only.

## Causal registers and event families

0.5 retains the existing immutable root comments, replies, suggested operations, and applied-edit evidence. It adds causal lifecycle references so a correction or reopening does not overwrite history.

Each register is a directed acyclic graph. A transition lists the heads of that register observed by its actor. Empty predecessor lists mean no observed prior assertion. Concurrent transitions may share predecessors. Parents must belong to that same register/review/revision, be unique, and already exist before the child is admitted; missing parents remain pending. Cycles and self-reference are invalid. A register's heads have no admitted successor. Head ordering is display-only. Equal head values mean agreement; different head values mean a visible conflict. A transition naming all observed competing heads resolves those observed branches. An unseen branch arriving later can reintroduce conflict.

| Event | Fields beyond envelope / retained payload | Register/value |
| --- | --- | --- |
| `revision.created` | `revisionPath`; descriptor includes parents | Revision graph, no mutable latest pointer |
| `comment.created` | Existing `threadId`, `commentId`, `anchor`, `body` | Unique immutable root |
| `comment.replied` | Existing `threadId`, `commentId`, optional `inReplyTo`, `body` | Immutable reply; parent is in the same thread/revision |
| `thread.decided` | Existing decision/reason plus `decisionPredecessors: string[]` | Per thread decision: accepted/rejected/wont-fix/duplicate |
| `thread.resolved` | `threadId`, optional `note`, `statusPredecessors: string[]` | Per thread status: resolved |
| `thread.reopened` | `threadId`, required `reason`, nonempty `statusPredecessors: string[]` | Per thread status: open |
| `suggestion.created` | Existing exact anchor, operation, rationale, suggestion ID | Unique immutable root |
| `suggestion.accepted` | Suggestion ID, optional note, `decisionPredecessors: string[]` | Per suggestion decision: accepted |
| `suggestion.rejected` | Suggestion ID, required reason, `decisionPredecessors: string[]` | Per suggestion decision: rejected |
| `suggestion.applied` | Existing source before/after digests, document, suggestion ID; `acceptanceIds: string[]` | Application evidence for exactly named accepted decision heads |
| `review.approved` | Optional note, `stancePredecessors: string[]`, `verification: StoredContent` | Per actor + revision stance: approved |
| `review.rejected` | Required reason, `stancePredecessors: string[]`, `verification: StoredContent` | Per actor + revision stance: rejected |
| `review.withdrawn` | Required reason, nonempty `stancePredecessors: string[]`, `verification: StoredContent` | Per actor + revision stance: withdrawn |
| `export.created` | PDF and inventory references and renderer metadata specified below | Immutable artifact publication |

A thread starts open. Under `creator-thread-control-v1`, only the review initiator may add `thread.decided`, `thread.resolved`, or `thread.reopened`; other participants may comment and reply while it is open. `thread.decided` and decision conflicts do not change the independent open/closed register. A status conflict is open; otherwise a `thread.resolved` head closes the thread and it stays closed until an admitted `thread.reopened` successor. While the current fold is closed, conforming writers reject new replies and thread decisions and refresh immediately before publication so a close observed during composition retains the user's unsaved draft instead of publishing it. A reply that was genuinely concurrent with the close can still arrive later because reply events in 0.5 do not carry a lifecycle predecessor; it remains visible as history but does not reopen the thread. Decision conflicts remain visible and block policy completion even when the lifecycle is closed. The UI explicitly distinguishes accepted-but-open, closed-with-decision-conflict, and unambiguously closed.

Suggested edits start open. Unambiguous acceptance makes them eligible for source application, not completed work. Application must name accepted leaves valid in its causal view, match the root document, and record persisted before/after bytes. Later competing rejection is a visible conflict and never undoes source automatically. Repeated application with different before/after digests is a conflict; identical evidence may be displayed as repeated assertions but never triggers a second edit. A rejected or validly applied suggestion is closed for completion policy; open, accepted-unapplied, and conflicted suggestions are not.

Stance predecessors must belong to the same actor and revision; display names cannot authorize changing another actor's stance. An actor with an active approval or rejection must withdraw that stance before recording another approval or rejection, and withdrawal requires an active stance. Thread decision/lifecycle control likewise compares stable actor IDs, never display names. In this base profile the actor ID is still self-asserted, so these are deterministic consistency rules rather than authenticated access control. All superseded and withdrawn assertions remain in history and export. Reopening a thread or revising a stance never edits its earlier event.

## Policy and approval verification inventory

Policy bytes use media type `application/json` and this closed shape:

```json
{
  "schemaVersion": "0.5.0",
  "kind": "review-policy",
  "mode": "assertions-only"
}
```

The alternative `mode: "quorum-v1"` requires `eligibleActorIds: string[]` (unique, nonempty), `minimumApprovals: integer` (1 through eligible count), `blockOnRejection: boolean`, `requireResolvedThreads: boolean`, and `requireClosedSuggestions: boolean`. All identities remain self-asserted under the manifest profile. UI defaults for the three booleans are true; they are explicit in stored policy. Policy changes require a new revision with a new policy digest, retaining earlier policy/evidence.

For a captured event set: fold actor stance registers; count distinct eligible actors whose heads unanimously approve. Any stance conflict for an eligible actor blocks satisfaction. An eligible actor's current rejection blocks when configured. Apply thread/suggestion gates to the selected revision, and require a fully verified revision with no observed validation failures. `assertions-only` yields `not-evaluated`; quorum yields `satisfied`, `unsatisfied`, or `conflicted`. None means externally authenticated or permanently closed. A deliberate approval assertion may coexist with unresolved work or an unsatisfied policy after explicit summary confirmation; the client must not relabel the package complete.

Decision `verification` references a content-addressed JSON blob with:

```ts
interface VerificationInventory05 {
  schemaVersion: "0.5.0";
  kind: "verification-inventory";
  reviewId: string;
  revisionId: string;
  verifiedAt: string;
  manifest: FileEvidence;
  revision: FileEvidence;
  policy: FileEvidence;
  contextRevisions: FileEvidence[];
  documents: FileEvidence[];
  resources: FileEvidence[];
  events: EventEvidence[];      // observed admitted events across the package
  policyResult: "not-evaluated" | "satisfied" | "unsatisfied" | "conflicted";
}
interface FileEvidence {
  path: string;
  digest: Sha256Digest;
  byteLength: number;
  mediaType: string;
}
interface EventEvidence extends FileEvidence {
  eventId: string;
  revisionId: string;
}
```

Verification inventories contain no copies of event bodies or Markdown, only references/digests. `contextRevisions` contains the distinct descriptors other than the selected revision needed for included events, including competing branches and transitive parents. `documents` and `resources` contain the selected revision's complete inventory plus any historical bytes needed for contextual anchor validation, deduplicated by package blob path. The event list is sorted by ASCII event ID, other lists by protocol path. Duplicate IDs/paths are invalid. The asserting event itself is excluded; its envelope and verification reference bind it to that inventory. Referenced events must have been published beforehand; cyclic verification/export dependencies are invalid, missing dependencies are pending. Readers hash referenced exact bytes to verify a receipt; its existence alone is not proof of validity.

The audit reader enumerates, reads/verifies, and re-enumerates the observed event-name set; a changed set requires another bounded pass or an explicit delayed result. It verifies admitted digests and file presence again before issuing success. This defines an observed snapshot, not an atomic global transaction across disconnected writers. Decisions cannot claim to include unseen remote events. Later events do not retroactively change a stored verification inventory.

## Audited PDF and detached inventory

Export uses a successful verification receipt and frozen renderer inputs. The export inventory is JSON containing all fields of `VerificationInventory05` except `kind`, which is `audit-export-inventory`, plus:

| Field | Shape / meaning |
| --- | --- |
| `exportId` | Filename-safe immutable artifact ID |
| `pdf` | `FileEvidence` for the complete PDF bytes |
| `representedEventIds` | Unique IDs from `events` rendered as selected-revision review evidence; remaining event references supply package/ancestry/validation context |
| `renderedDiagrams` | Sorted entries `{ diagramId, sourceDigest, svg: FileEvidence }`, exactly one per selected-revision diagram |
| `diagnostics` | Entries `{ code, severity, path?, message }` for disclosed nonblocking warnings; blocking failures cannot produce a successful audit export |
| `renderer` | `{ client, clientVersion, markdownVersion, mermaidVersion, pdfEngine, fontSetDigest, sanitizerVersion, schemaSetDigest }` with actual used versions/digests |

The PDF is a derived, human-readable offline review archive using those exact event-file digests. It does not become protocol state and never replaces the package. Every current and superseded action on the selected revision is represented, including decision reasons, replies, withdrawals, conflicts, and application evidence. Prior export events are referenced as prior artifacts without recursively copying their PDF content.

A conforming archive presents, in this logical order:

1. Review identity, revision, export identity, verification cutoff, policy result, actor assurance, and a challenge register.
2. Every frozen document in protocol order with its digest, rendered frozen evidence, resource/external-reference disclosure, and a per-document challenge map.
3. One comments/findings section containing every root comment and suggested edit exactly once, with the anchor location/quote and complete reply, decision, lifecycle, suggestion, and application history.
4. Complete per-actor approval/rejection/withdrawal history and current stance at the cutoff.
5. Complete selected-revision event history plus the exact human-readable file inventory.

The challenge register assigns deterministic archive-local references (`F-001`, `F-002`, ...) by document order, then zero-based anchor line/character order, kind, and event ID; displayed locations are one-based. These references and internal PDF destinations are presentation aids, not wire identities, and can change when a later export observes more events. Current status and conflicts are derived by the protocol fold. The archive includes bounded quotes in indexes and exact quotes in finding details. Full comments/replies are not duplicated into the document body; document challenge maps and internal links connect reviewed content to the dedicated findings section. A renderer without working internal PDF destinations must still print both the finding reference and exact location so a paper/offline reader can correlate them.

Frozen renderable images, diagrams, and tables are embedded for offline reading. Captured non-renderable resources are listed with their content digest and package reference. Uncaptured live external references are explicitly marked as not archived/offline evidence. No network fetch is permitted during export.

`export.created` contains `exportId`, `format: "application/pdf"`, `pdf: FileEvidence`, `inventory: FileEvidence`, and the same `renderer` object. It replaces the legacy `includedEventIds`/reconstructed-hash approach for 0.5; readers access the verified inventory for exact inputs. The event envelope pins its revision and descriptor digest. Inventory, PDF, and event identities and all references must agree.

Publication order is: verified input snapshot; generated/sanitized diagram blobs; complete PDF; exact PDF digest; inventory including that PDF digest; inventory digest; detached event. Neither inventory nor PDF includes its own digest or the final event's digest. Inventory does not reference itself. Publication retries preserve generated bytes and IDs; they do not regenerate a different artifact under the same operation ID.

## Pilot limits and failure semantics

`pilot-v1` is a fixed interoperable support envelope, not values inferred from local RAM. A client may impose stricter local limits but must then identify the package as unsupported by that client; it cannot omit oversized evidence and claim a complete review.

| Item | Limit |
| --- | --- |
| Manifest / policy / one event | 1 MiB / 256 KiB / 256 KiB |
| One comment/reply/reason/replacement text | 32 KiB UTF-8 |
| Events per package / aggregate event bytes | 10,000 / 64 MiB |
| Revision descriptors per package / one descriptor | 1,000 / 4 MiB |
| Documents per revision / one Markdown document | 100 / 2 MiB |
| Resources per revision / one captured resource | 1,000 / 20 MiB |
| Total unique document/resource bytes per revision | 512 MiB |
| Mermaid blocks per revision / one source / render deadline | 100 / 128 KiB / 20 seconds |
| Decoded raster image | 25 million pixels |
| Verification/export inventory / resulting PDF | 32 MiB / 256 MiB |
| Path segments / JSON nesting / causal graph depth | 32 / 64 / 1,024 |
| HTTPS capture redirect hops / per-resource deadline | 5 / 15 seconds |

Check sizes before allocating where APIs expose size, and enforce streamed limits as bytes arrive. Inspect decoded image dimensions before full raster allocation. Rendering deadlines terminate bounded workers/tasks rather than leaving overlapping background work. File-count, graph, and aggregate limits are checked before recursive interpretation. A package beyond the envelope remains preserved and can be inspected diagnostically, but cannot receive a conforming completion/audit result from a limited client.

All errors identify whether they are missing/temporarily unavailable, invalid, unsupported, or an integrity conflict. No rule here permits modifying published history to make it pass validation. Exact diagnostic codes and error-result parity are part of the shared core's test corpus.

## Compatibility and release

Readers select validation, lifecycle, and publication rules by the manifest version, never by whichever client version last opened the folder. Native legacy writing may continue under its existing exclusive-publication contract. Browser legacy writing is disabled unless that runtime actually satisfies the legacy contract.

The first professional release supports new 0.5 review creation through both CLI and VS Code. It does not convert or rename existing event files, rewrite old manifests, or transfer old approvals to new content. Optional future migration, signed identity, automatic Git transport, and additional wire layouts require their own explicit specifications.

Before release, add complete 0.5 JSON Schemas, generated TypeScript types, browser-compatible validation, valid/invalid fixtures, causal permutation tests, exact-byte artifact verification, and native/browser writer-interoperability tests. Until those pass, version 0.5 remains a draft even if these documents are committed.
