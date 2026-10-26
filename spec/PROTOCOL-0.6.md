# Open Markdown Review Core Protocol 0.6 implementation draft

Status: 0.6 wire contract, implementation candidate, 2026-09-23. Schemas, shared types and clients exist on the 0.6 development branch, but this is not yet a released or qualified standard. See [implementation evidence and remaining gates](IMPLEMENTATION-STATUS.md). This document and its versioned schemas define core interoperability. The [portable review package profile](PORTABLE-REVIEW-PROFILE-0.6.md) defines the generated HTML entry point and required offline PDF experience; [PROFESSIONAL-V1.md](PROFESSIONAL-V1.md) and [ACCEPTANCE.md](ACCEPTANCE.md) specify the reference-product requirements and qualification process, not additional core wire semantics.

This document extends the released [0.5 wire contract](PROTOCOL-0.5.md). Unchanged fields retain their 0.5 shapes. Rules here apply only to new `protocolVersion: "0.6.0"` packages. Protocol 0.5 packages remain valid and are validated and folded under their original schemas and capabilities; clients MUST NOT add 0.6 events to them or edit their immutable manifest to claim 0.6 support.

Normative requirements in this document describe interoperable package bytes, admission, causal state, authorization by declared protocol role, audit evidence, and version negotiation. The Creator Workbench name and layout, queue labels/order, sidebar placement, editor navigation, prompts, notifications, and styling are reference-client behavior rather than wire requirements. Other clients MAY use different UX if they expose the same admissible actions and derived conflict/evidence states without creating a second source of truth.

### Standard versus reference-client responsibility

| Must be specified by the open protocol | Deliberately left to each client |
| --- | --- |
| Version/capability negotiation and exact 0.5 fallback | Workbench, sidebar, menu and toolbar organization |
| Closed JSON shapes and exact-byte publication rules | Queue names, filter labels, sorting and visual badges |
| Actor-role admission for decision, lifecycle and addressing events | How identity, confirmation and reason prompts are presented |
| Accepted-decision dependencies, revision ancestry and document-digest linkage | VS Code source-editor navigation and local source bindings |
| Addressing/verification predecessor graphs, dangling dependencies and conflict fold | Browser polling cadence, arrival notifications and progress animation |
| Meaning of accepted, addressed, verified, challenged and conflicting evidence | Styling, responsive layout, keyboard shortcuts and local view preferences |
| Exact audit/export event and inventory evidence, when an exporter role is claimed | PDF typography/layout and optional productivity aids such as diffs or suggested next actions |

A conforming client is not required to reproduce the reference UI. It MUST, for every role it claims, prevent locally known invalid writes, expose unresolved conflicts without choosing a timestamp winner, preserve all admitted history, and make the current implementation and verification evidence inspectable. A local cache, task list, or source-workspace binding is disposable client state and MUST NOT become shared authority.

## Package and version declarations

```text
review-package/                         any chosen directory name
  manifest.json                         immutable package identity/profile
  events/<event-byte-sha256>.json        one immutable action per digest name
  revisions/<revision-id>.json           immutable native-author publication
  blobs/sha256/<first-two>/<sha256>      Markdown, resources, policy, verification inventory
  exports/...                            optional derived artifacts named by admitted export events
```

There is no shared `comments.json`, mutable review database, active-revision pointer, identity cache, or client-specific sidecar. Product launchers, Git attributes and local caches are outside core evidence and are never interpreted as review state.

Core conformance does not require an HTML file, a particular executable client, `.gitattributes`, or a PDF renderer. The reference product implements the separately versioned [portable review package profile](PORTABLE-REVIEW-PROFILE-0.6.md), which requires a review-bound HTML launcher, exact-byte Git preservation metadata and an offline archival PDF workflow. Missing or replaced product files can make that product profile incomplete without changing the validity of the authoritative core evidence.

Manifest 0.6 retains `protocol`, `reviewId`, `title`, `createdAt`, `createdBy`, `documents`, the four portable directory fields, and `capabilities`. It requires these additional declarations:

| Field | Required value/meaning |
| --- | --- |
| `protocolVersion` | `0.6.0` |
| `eventLayout` | `sha256-flat-v1`; event filename is 64 lowercase hex digits plus `.json` |
| `identityProfile` | `self-asserted-v1`; no signature/authenticated-person claim |
| `limitsProfile` | `pilot-v1`, with the limits below |
| `creationOperationId` | Filename-safe operation ID used to identify resumable native creation |
| `requiredCapabilities` | Contains every core capability listed below; unsupported required entries prevent participant writing and approval |

Required core capabilities are `quote-anchor-v1`, `range-anchor-v1`, `semantic-anchor-v1`, `content-addressed-resources-v1`, `revision-parents-v1`, `thread-lifecycle-v2`, `suggested-edit-v2`, `review-stance-v1`, `review-policy-v1`, and `audit-inventory-v1`. Protocol 0.6 additionally requires `creator-thread-control-v1` and `thread-addressing-v1`. `capabilities` contains at least these entries. A writer checks required semantics for every emitted family, not only their presence in a schema.

Under `creator-thread-control-v1`, `thread.decided`, `thread.resolved`, and `thread.reopened` are admitted only when `actor.id` exactly equals immutable `manifest.createdBy.id`; other actors may create comments and reply while a thread is open. This is a deterministic protocol role, not authentication: `self-asserted-v1` cannot prove who typed an actor ID. Historical 0.5 packages without the capability retain their earlier lifecycle-admission behavior and are not reinterpreted.

`thread-addressing-v1` adds auditable implementation and verification registers without turning the package into a task tracker. Only the immutable manifest creator ID may publish `thread.addressed`; any participant may publish `thread.verification.recorded`. A package that does not immutably advertise and require this capability MUST reject these event families; an existing package is not upgraded by editing its manifest.

The core permits the declared `commonmark-gfm` renderer profile. Packages produced under the portable review package profile additionally require `sanitized-html-v1` and use renderer profile `commonmark-gfm+sanitized-html-v1`. Capability and profile MUST either both be present or both be absent. The profile defines a closed structural HTML subset, frozen raw-HTML image/attachment discovery, external-reference handling, exact anchors and audit behavior in [Sanitized Markdown HTML profile v1](../protocol/profiles/sanitized-html-v1.md). Unsupported clients disable participation instead of silently showing a different document. Earlier packages without the capability keep `commonmark-gfm`, in which raw Markdown HTML is inert literal text.

Optional extension declarations use `extensions[]` entries `{ id, schemaUri, schemaDigest, schemaBlobPath, affectsState }`. IDs are absolute namespace URIs. Schema bytes are captured as ordinary content-addressed blobs. Schema URI is descriptive, not permission to fetch or execute anything. Unsupported `affectsState: true` extensions put the package in inspect-only mode. Unsupported presentation-only extensions are preserved, disclosed, and cannot alter admission, lifecycle, policy, or audit conclusions. Base writers omit extensions unless their implementation explicitly supports their schema digest. Unknown ordinary object properties are rejected. The reference application implements presentation-only data through the separately specified [presentation profile transport v1](../protocol/profiles/README.md): declared schema and descriptor are ordinary content-addressed attachment resources, with no extra event/revision fields. Packages using this transport require `presentation-profiles-v1`; unsupported clients disable participation rather than claim visual conformance. A generic `extensions` data object on events/revisions remains unimplemented and is not emitted.

The manifest is immutable. This pilot does not add mutable capability adoption: enabling new state-affecting semantics requires a later explicit protocol/profile design, not editing the manifest.

## Optional email roster and participant completion

`reviewer-completion-v1` defines a participant's finish/reopen register, independently of approval, finding disposition and discussion closure. The reference authoring clients advertise and require it for new packages. A 0.6 package without this capability remains readable but MUST NOT accept completion events. Protocol 0.5 schemas, manifests and event families are unchanged.

A creator MAY restrict participation by declaring `reviewer-roster-v1` in both capability arrays and adding immutable `reviewers: Array<{ id: string; email: string }>` to the manifest. The list contains 1–100 reviewers. A missing list means open participation; an empty list is invalid. A roster additionally requires `reviewer-completion-v1`. It controls admissible event actor IDs, not read access or authenticated authorization.

The profile supports unquoted ASCII mailboxes with a local part of at most 64 characters and a dot-separated DNS domain. Addresses are trimmed and lowercased in their entirety, contain at most 254 characters, and MUST use canonical form in the manifest. Local parts cannot start/end with a dot or contain consecutive dots; domain labels contain 1–63 ASCII letters/digits/hyphens and cannot start/end with a hyphen. The accepted local-part characters are ASCII letters, digits and `.!#$%&'*+/=?^_` plus backtick, braces, vertical bar, tilde and hyphen. Internationalized/quoted addresses require a future profile. This deliberately case-insensitive matching convention provides workflow consistency, not proof of mailbox equivalence or ownership.

`id = "reviewer_" + first24hex(SHA-256(UTF-8(canonical-email)))`. IDs are stable within the declared roster; email addresses are never filesystem paths. Manifest entries MUST be sorted by canonical email in ASCII order with unique emails and IDs. Authoring MAY normalize/deduplicate user input before creation; readers MUST reject noncanonical received manifests rather than repair them. The email roster is visible shared review evidence and appears in archive exports.

When a roster is present, event actors MUST match an initial roster ID, an admitted invitation under the capability below, or the immutable creator ID. Unknown actors and their dependent events are excluded with an explicit admission diagnostic. Creator privileges continue to compare `manifest.createdBy.id`; an invited email does not grant creator privileges. Client identity entry maps a matching email to its declared ID, while remembered identities remain private client preferences. There is no OneDrive, Windows, Entra or email-ownership verification in `self-asserted-v1`.

### Initiator-only additions after creation

`reviewer-invitations-v1` MAY be advertised and required only by a restricted 0.6 review that also requires `reviewer-roster-v1` and `reviewer-completion-v1`. New restricted reference-client packages require this capability. Existing packages without it MUST reject invitations; neither a client update nor editing the immutable manifest enables it. Open reviews remain open and MUST NOT use invitation events to become restricted.

The additive event is `reviewer.invited`, with required `reviewer: { id: string; email: string }`. The canonical email and derived ID use the exact initial-roster rules. Its actor MUST equal `manifest.createdBy.id`; a reviewer cannot add another reviewer. It uses the normal event envelope, binding the action to an existing verified revision, but its membership effect is review-wide, across past and future revisions. It never grants the creator role. The manifest, HTML binding, frozen documents, completed-review records and approval policy are not rewritten.

The effective roster is the initial roster union all admitted invitations, deduplicated by canonical email/derived ID and displayed in ASCII email order. Concurrent additions of different reviewers commute. Duplicate invitations of the same reviewer are valid immutable history but create one membership and one progress row; a client SHOULD skip already-listed emails before publishing. There is no last-writer-wins roster replacement or removal in this capability. Up to 100 initial addresses and 100 addresses per UI batch are supported; cumulative additions are bounded by the package-wide 10,000-event / 64-MiB event limits, not a concurrency-sensitive aggregate roster cap. One invitation creates one event file. Partial batch failures disclose and retain already-published invitations; retries reuse the exact prepared event bytes and operation IDs.

Every event by a reviewer outside the initial roster MUST include envelope `reviewerInvitationId`, naming one valid `reviewer.invited` event in this review for the same actor ID. This is a required causal dependency even when the invitation was recorded against another revision. Initial-roster actors, the creator and open-review actors MUST NOT include this field. Missing or invalid invitations keep dependent actions out of reconstructed state; a later arriving complete valid invitation permits admission without changing those actions. A forged, foreign-review, wrong-actor, unsupported-capability or invalid-revision invitation and its dependents MUST fail closed. Writers may choose the ASCII-smallest admitted invitation ID when duplicates exist; readers accept any valid matching invitation, so a later duplicate never invalidates existing evidence.

A completion, stance or export receipt made by an added reviewer MUST include their named invitation and its full causal closure. Archived PDF rosters are derived from the exact events in the export cutoff, not from a later current-session roster. Exports include all additions, the initiator identity, timestamps, originating revision and exact event IDs, including duplicate invitation history. New members start **not started** on revisions where they have no activity. An addition does not reopen other reviewers, withdraw their stances or silently expand a revision's eligible approval IDs/quorum. Changing that policy requires an explicit new revision/policy. Inviting a reviewer does not send an email or grant OneDrive/shared-folder permissions; those remain external storage administration.

Completion uses these events:

| Type | Required payload | Meaning |
| --- | --- | --- |
| `review.completed` | `completionPredecessors: string[]`, `verification: StoredContent`; optional `note` | Participant finished reviewing the pinned revision and exact verified event inventory |
| `review.reopened` | Nonempty `completionPredecessors: string[]`; optional `note` | The same participant resumes reviewing that revision |

The register key is `(revisionId, actor.id)`. Predecessors MUST belong to that exact register. A first finish has no predecessors. A later finish MUST name at least one reopened predecessor; a reopen MUST name at least one finished predecessor. Writers name all observed current heads and recheck them immediately before publication. They reject stale transitions and retry uncertain publications with identical bytes and operation IDs. Display names cannot change another participant's register. The creator does not finish or reopen another participant's review.

No activity yields **not started**. Other participant activity without completion transitions yields **in progress**. Unanimously finished heads yield **finished**, unanimously reopened heads yield **reopened**, and mixed heads yield **conflicted**. Multiple equal heads are retained and do not count as multiple reviewers. Resolve a mixed register explicitly by reopening with all observed heads; timestamps never choose a winner. A finish receipt MUST satisfy the same exact-byte, complete-content and causal-closure checks as stance verification, including a fresh-frontier comparison before save. Missing verification dependencies remain pending.

Conforming writers lock that participant's new comments, replies, suggestions, suggestion decisions, outcome verification and stance changes while finished or conflicted. An explicit reopen restores them. Inspection and audited export remain available; the creator may still decide/close/reopen findings, record implementation, publish revisions and apply accepted source edits. A finish does not close the entire package, finish other participants, resolve comments, approve/reject a revision, withdraw a stance or change quorum results. An unseen concurrent feedback event can arrive after a finish; it remains visible evidence and does not retroactively change the captured finish receipt. Completion describes the observed cutoff, not a globally atomic freeze across disconnected clients.

Every new revision starts a separate completion register, including for unchanged documents. Prior finish/reopen history remains associated with its original revision. Clients MUST show the roster including reviewers with no activity, current per-reviewer completion, transition times and conflicts for the selected revision. An initiator's own completion is also displayed and archived even when their actor ID is outside the invited roster; it does not change the invited-reviewer count. Product placement, labels, progress notifications and identity prompts remain client UX choices.

## Exact bytes, identifiers, and paths

All JSON is one UTF-8 object with no BOM, invalid UTF-8 sequences, unpaired surrogate escapes in strings, duplicate member names, or non-finite numbers. Native and browser parsers enforce identical rejection rules. Writers use LF termination; readers accept otherwise schema-valid JSON without a trailing newline. Digests always cover the bytes actually stored. JSON whitespace and member order are not semantic order and MUST NOT be normalized before byte verification.

Identifiers used as logical object IDs match `[A-Za-z0-9_-]{1,128}`. Actor IDs are case-sensitive strings of 1–128 Unicode scalar values without controls or leading/trailing whitespace; names are descriptive. Publication IDs use at least 128 random bits. Reader presentation order is timestamp instant, then ASCII event ID. Timestamps use full RFC-3339 date-times with seconds and an explicit timezone; date-only/local-time forms and leap seconds are rejected. Writers emit UTC with millisecond precision.

Stored JSON field paths and source document identifiers use `/`. Reject empty, dot, dot-dot, NUL/control, backslash, leading slash, drive-prefix, and colon-containing segments. Every segment is NFC-normalized, contains no trailing dot/space or Windows reserved device basename (including a device basename before an extension), and is at most 255 UTF-8 bytes; a path is at most 1,024 UTF-8 bytes. Reject aliases among a revision's paths under both exact NFC comparison and Unicode 15.1 full case folding. Both clients use the same shipped folding data. Preserve the accepted case of paths in events and resource-ID derivations.

These are protocol paths, not a ban on normal `../` Markdown resource links. Authoring resolves and checks Markdown destinations against explicitly granted native roots before producing safe package references. Package I/O also enforces actual filesystem containment; lexical validation does not replace it.

Source text uses its exact decoded bytes: CRLF is one line break, LF and lone CR are one line break each, and positions are zero-based UTF-16 code-unit offsets within a line. Ranges are half-open and cannot split a surrogate pair or exceed document bounds. `quote.exact` is the exact source substring including original intervening line endings. Rendering normalization must keep a reversible offset map.

## Revisions and references

Every new revision uses `schemaVersion: "0.6.0"` and retains the existing revision fields, with:

| Field | Requirement |
| --- | --- |
| `parents` | Unique revision ID array, empty for the first revision; otherwise explicitly references published, verified revisions in the same review |
| `policy` | `StoredContent` reference with media type `application/json` to the immutable policy below |
| `creationOperationId` | Author operation ID; publication retries reuse the original descriptor and event bytes |
| `renderer.markdownProfile` | `commonmark-gfm`, or `commonmark-gfm+sanitized-html-v1` when and only when the immutable manifest requires `sanitized-html-v1` |

Each parent must have exactly one valid publication. The revision graph is acyclic. A missing parent is pending, a cycle or competing descriptor/publication identity is invalid. A head has no admitted child revision. Multiple heads are a branch conflict. A merge revision lists all heads selected by the author and captures its chosen complete document set; it does not silently merge source text or carry forward approvals/threads. Distinct simultaneous initial revisions are also competing heads.

All document paths, semantic IDs, resource ownership, byte lengths, and digest-derived paths are validated. Mermaid source is recomputed from the frozen Markdown, compared with the descriptor, and hashed. Table IDs retain the 0.4 document-plus-ordinal derivation; cells use row 0 for the header. IDs for images, attachments, diagrams, and references retain the 0.4 derivations using the exact parser-emitted reference before metadata redaction.

Resources retain their 0.4 fields; `sourceKind` adds `granted-root` for local resources explicitly authorized outside the source workspace. Absolute authoring roots are not stored as package configuration. URLs/paths already present in frozen source remain part of that source; metadata redaction does not erase secrets from Markdown. Creation must disclose detected secret-bearing references before capture, so the author can change source. Captured resource metadata uses sanitized origin descriptions.

Ordinary external references keep their 0.4 form for absolute URIs. Under `sanitized-html-v1`, Markdown links and raw anchors with absolute `http`, `https`, `mailto`, or `file` references enter the same inventory. Only `https` and `mailto` are actionable; HTTP and file references remain visible audit evidence but are blocked by the client. Other unsupported schemes remain inert source text and never become actionable links. Internal document/heading links are resolved from frozen Markdown against the revision inventory and do not need an external-reference record. An outside local path is captured only as an explicit attachment under an authorized root, not automatically opened by a reviewer as a live filesystem link.

The HTML profile is not a parallel document or extension-data store. Sanitization never changes frozen Markdown bytes, and raw HTML images/attachments are normal revision resources with the existing semantic-ID and content-addressed-blob rules. Markdown tables and raw tables share one source-order ordinal space. Audit export renders the same sanitized structure and records the sanitizer version; it never executes or fetches source HTML.

## Event envelope and immutable identity

All 0.6 events require:

```ts
interface EventEnvelope05 {
  schemaVersion: "0.6.0";
  id: string;
  type: string;                 // one of the event families below
  reviewId: string;
  revisionId: string;
  revisionDigest: Sha256Digest; // exact descriptor bytes for that revision
  occurredAt: string;
  actor: { id: string; displayName?: string };
  operationId: string;          // local intent identity, stable across retry
  reviewerInvitationId?: string; // required dependency for later-added actors
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

Native editable-source roots are client-private bindings. They are never package fields and cannot be inferred from a reviewer's checkout path. Protocol 0.6 document identifiers are relative to one explicit authoring source root. Multi-root document authoring requires a future declared capability with collision-free portable namespaces; `granted-root` remains resource capture only.

## Causal registers and event families

Protocol 0.6 retains the existing immutable root comments, replies, suggested operations, and applied-edit evidence. It adds implementation-addressing and verification registers; the causal lifecycle rules introduced in 0.5 remain unchanged.

Each register is a directed acyclic graph. A transition lists the heads of that register observed by its actor. Empty predecessor lists mean no observed prior assertion. Concurrent transitions may share predecessors. Parents must belong to that same register/review/revision, be unique, and already exist before the child is admitted; missing parents remain pending. Cycles and self-reference are invalid. A register's heads have no admitted successor. Head ordering is display-only. Equal head values normally mean agreement; different head values mean a visible conflict. The addressing register is stricter: more than one head is a conflict even when target revision/digest values match, because verification names one exact addressing event. A transition naming all observed competing heads resolves those observed branches. An unseen branch arriving later can reintroduce conflict.

| Event | Fields beyond envelope / retained payload | Register/value |
| --- | --- | --- |
| `revision.created` | `revisionPath`; descriptor includes parents | Revision graph, no mutable latest pointer |
| `comment.created` | Existing `threadId`, `commentId`, `anchor`, `body` | Unique immutable root |
| `comment.replied` | Existing `threadId`, `commentId`, optional `inReplyTo`, `body` | Immutable reply; parent is in the same thread/revision |
| `thread.decided` | Existing decision/reason plus `decisionPredecessors: string[]` | Per thread decision: accepted/rejected/wont-fix/duplicate |
| `thread.resolved` | `threadId`, optional `note`, `statusPredecessors: string[]` | Per thread status: resolved |
| `thread.reopened` | `threadId`, required `reason`, nonempty `statusPredecessors: string[]` | Per thread status: open |
| `thread.addressed` | `threadId`, descendant `toRevisionId`, root `document`, exact `sourceDigestBefore` / target `sourceDigestAfter`, required `summary`, nonempty accepted `decisionIds`, `addressingPredecessors: string[]` | Per thread implementation: exact published revision/document digest |
| `thread.verification.recorded` | `threadId`, current `addressedEventId`, `verdict: verified | challenged`, optional `note` (required when challenged), `verificationPredecessors: string[]` | Per addressed implementation verification verdict |
| `suggestion.created` | Existing exact anchor, operation, rationale, suggestion ID | Unique immutable root |
| `suggestion.accepted` | Suggestion ID, optional note, `decisionPredecessors: string[]` | Per suggestion decision: accepted |
| `suggestion.rejected` | Suggestion ID, required reason, `decisionPredecessors: string[]` | Per suggestion decision: rejected |
| `suggestion.applied` | Existing source before/after digests, document, suggestion ID; `acceptanceIds: string[]` | Application evidence for exactly named accepted decision heads |
| `review.approved` | Optional note, `stancePredecessors: string[]`, `verification: StoredContent` | Per actor + revision stance: approved |
| `review.rejected` | Required reason, `stancePredecessors: string[]`, `verification: StoredContent` | Per actor + revision stance: rejected |
| `review.withdrawn` | Required reason, nonempty `stancePredecessors: string[]`, `verification: StoredContent` | Per actor + revision stance: withdrawn |
| `review.completed` | `completionPredecessors: string[]`, `verification: StoredContent`, optional note | Per actor + revision completion: finished; requires `reviewer-completion-v1` |
| `review.reopened` | Nonempty `completionPredecessors: string[]`, optional note | Per actor + revision completion: reviewing again; requires `reviewer-completion-v1` |
| `reviewer.invited` | `reviewer: { id: string; email: string }` | Initiator-only additive, review-wide membership; requires `reviewer-invitations-v1` |
| `export.created` | PDF and inventory references and renderer metadata specified below | Immutable artifact publication |

A thread starts open. Under `creator-thread-control-v1`, only the review initiator may add `thread.decided`, `thread.resolved`, or `thread.reopened`; other participants may comment and reply while it is open. `thread.decided` and decision conflicts do not change the independent open/closed register. A status conflict is open; otherwise a `thread.resolved` head closes the thread and it stays closed until an admitted `thread.reopened` successor. While the current fold is closed, conforming writers reject new replies and thread decisions and refresh immediately before publication so a close observed during composition retains the user's unsaved draft instead of publishing it. A reply that was genuinely concurrent with the close can still arrive later because reply events do not carry a lifecycle predecessor; it remains visible as history but does not reopen the thread. Decision conflicts remain visible and block policy completion even when the lifecycle is closed. The UI explicitly distinguishes accepted-but-open, closed-with-decision-conflict, and unambiguously closed.

Finding processing has four independent axes: discussion lifecycle, creator disposition, implementation evidence, and verification. An accepted decision alone means implementation is planned, not completed. `thread.addressed` MUST name the unconflicted accepted decision heads observed by the creator, the original anchor document/digest, and a published descendant revision whose same-path document digest equals `sourceDigestAfter`. Its causal dependency set includes the target revision's `revision.created` event and that publication's ancestry; an audit receipt that omits them is not closed. The target revision is immutable review evidence; a live source file or local editor state is never sufficient. A new addressing event names all observed addressing heads and supersedes them without erasing history. Concurrent addressing heads are a visible implementation conflict until an explicit successor names all of them.

Verification is scoped to one exact addressing event. `thread.verification.recorded.addressedEventId` is an explicit causal dependency on an addressing event for the same thread and root revision. Verification predecessors belong to that same addressed-event register. A challenged verdict requires a note. A later addressing event creates a new verification register and therefore returns the finding to awaiting verification; verification of an older implementation remains audit history. Verification does not silently close or reopen the discussion lifecycle. Creator and reviewer clients MAY guide users to reopen a challenged thread, but closure still requires an explicit lifecycle event.

Suggested edits start open. Unambiguous acceptance makes them eligible for source application, not completed work. Application must name accepted leaves valid in its causal view, match the root document, and record persisted before/after bytes. Later competing rejection is a visible conflict and never undoes source automatically. Repeated application with different before/after digests is a conflict; identical evidence may be displayed as repeated assertions but never triggers a second edit. A rejected or validly applied suggestion is closed for completion policy; open, accepted-unapplied, and conflicted suggestions are not.

Stance predecessors must belong to the same actor and revision; display names cannot authorize changing another actor's stance. An actor with an active approval or rejection must withdraw that stance before recording another approval or rejection, and withdrawal requires an active stance. Thread decision/lifecycle control likewise compares stable actor IDs, never display names. In this base profile the actor ID is still self-asserted, so these are deterministic consistency rules rather than authenticated access control. All superseded and withdrawn assertions remain in history and export. Reopening a thread or revising a stance never edits its earlier event.

## Policy and approval verification inventory

Policy bytes use media type `application/json` and this closed shape:

```json
{
  "schemaVersion": "0.6.0",
  "kind": "review-policy",
  "mode": "assertions-only"
}
```

The alternative `mode: "quorum-v1"` requires `eligibleActorIds: string[]` (unique, nonempty), `minimumApprovals: integer` (1 through eligible count), `blockOnRejection: boolean`, `requireResolvedThreads: boolean`, and `requireClosedSuggestions: boolean`. All identities remain self-asserted under the manifest profile. UI defaults for the three booleans are true; they are explicit in stored policy. Policy changes require a new revision with a new policy digest, retaining earlier policy/evidence.

For a captured event set: fold actor stance registers; count distinct eligible actors whose heads unanimously approve. Any stance conflict for an eligible actor blocks satisfaction. An eligible actor's current rejection blocks when configured. Thread lifecycle, decision, addressing, verification, and suggestion conflicts yield `conflicted`; nonconflicting implementation/verification queue states remain independently visible and the existing `requireResolvedThreads` gate still evaluates the explicit lifecycle register. Apply thread/suggestion gates to the selected revision, and require a fully verified revision with no observed validation failures. `assertions-only` yields `not-evaluated`; quorum yields `satisfied`, `unsatisfied`, or `conflicted`. None means externally authenticated or permanently closed. A deliberate approval assertion may coexist with unresolved work or an unsatisfied policy after explicit summary confirmation; the client must not relabel the package complete.

Stance and completion `verification` references a content-addressed JSON blob with:

```ts
interface VerificationInventory06 {
  schemaVersion: "0.6.0";
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

## Audited export and detached inventory

Export uses a successful verification receipt and frozen renderer inputs. The export inventory is JSON containing all fields of `VerificationInventory05` except `kind`, which is `audit-export-inventory`, plus:

| Field | Shape / meaning |
| --- | --- |
| `exportId` | Filename-safe immutable artifact ID |
| `pdf` | `FileEvidence` for the complete PDF bytes |
| `representedEventIds` | Unique IDs from `events` rendered as selected-revision review evidence; remaining event references supply package/ancestry/validation context |
| `renderedDiagrams` | Sorted entries `{ diagramId, sourceDigest, svg: FileEvidence }`, exactly one per selected-revision diagram |
| `diagnostics` | Entries `{ code, severity, path?, message }` for disclosed nonblocking warnings; blocking failures cannot produce a successful audit export |
| `renderer` | `{ client, clientVersion, markdownVersion, mermaidVersion, pdfEngine, fontSetDigest, sanitizerVersion, schemaSetDigest }` with actual used versions/digests |

The base export family currently standardizes `application/pdf` so independent clients can verify the same detached artifact and inventory. An exporter-role implementation MUST satisfy these evidence rules, but a core reader/participant is not required to implement PDF generation. The portable review package profile requires the human-readable offline archive. The PDF does not become protocol state and never replaces the package. Every current and superseded action on the selected revision is represented, including decision reasons, replies, withdrawals, conflicts, and application evidence. Prior export events are referenced as prior artifacts without recursively copying their PDF content.

A conforming review archive preserves the following logical content, independent of physical pagination:

1. Review/revision/export identity, cutoff, policy result, actor assurance and navigable summary.
2. Effective initial/invited reviewer roster, no-activity participants, independent completion/stance status, transition times and full finish/reopen/invitation history at the cutoff. A prior revision's completion is not carried forward.
3. Complete per-actor approval/rejection/withdrawal history and current stance.
4. Every frozen document in protocol order, its digest, renderable evidence and reference disclosure; every comment/suggestion with exact anchor/quote, nested replies, decisions, implementation/verification/lifecycle/application history and conflicts.
5. Selected-revision event history and exact human-readable file inventory.

The renderer identifies its actual presentation profile in `renderer.pdfEngine`. The reference client's `omr-review-annotations-v1` profile uses native PDF 1.7 comments on final document geometry, not separate findings pages. Findings have deterministic export-local references (`F-001`, ...) in document/location/kind/event order; these are presentation aids, never wire identities. Source-only anchors are explicitly labeled. Cross-page continuation annotations share finding identity; PDF reply references remain on one page. A compatible PDF reader exposes full discussion in its Comments/Annotations panel. Original document links remain valid. See [PDF export profiles](PDF-EXPORT-PROFILES.md).

Earlier printed challenge-register/map/findings layouts remain valid historical presentations if their complete inventory/evidence obligations hold. Readers MUST NOT reject otherwise valid old artifacts because a newer renderer uses annotations. PDFs and edits made in PDF readers never replace or append protocol review state.

A clean document-only PDF is a client projection, not a conforming audit archive: it omits generated review information, does not represent event history and MUST NOT append `export.created` or relax inventory validation. Optional unreferenced content-addressed output and private recovery metadata do not alter wire semantics.

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

The 0.6 reference release creates new reviews through both CLI and VS Code while retaining a read/write path for conforming 0.5 packages under their original rules. It does not convert or rename existing event files, rewrite old manifests, or transfer old approvals to new content. Optional future migration, signed identity, automatic Git transport, and additional wire layouts require their own explicit specifications.

Before release, the complete 0.6 JSON Schemas, generated TypeScript types, browser-compatible validation, valid/invalid fixtures, causal permutation tests, exact-byte artifact verification, backward-compatibility tests, and native/browser writer-interoperability tests MUST pass. Until then, version 0.6 remains a draft even if these documents are committed.
