# Professional review client specification

Status: implementation specification, draft 1, 2026-09-08. Product direction incorporates the review of 2026-09-08 and the requirement for equal review comfort in HTML and VS Code. These requirements are not a claim that client 0.4.6 implements them.

The words MUST, MUST NOT, SHOULD, and MAY describe requirements for the next professional pilot. This document owns product behavior and client architecture. [PROTOCOL-0.5.md](PROTOCOL-0.5.md) owns the proposed wire changes. [ACCEPTANCE.md](ACCEPTANCE.md) owns verification and work packages. Existing packages remain governed by [protocol 0.4](../protocol/README.md); their history MUST NOT be reinterpreted using new lifecycle rules.

## 1. Product contract and single source of truth

**AUTH-01. One review package is the complete, authoritative shared review record.** All clients read its manifest, immutable revision descriptors, content-addressed blobs, policy, event files, and audited artifacts. Two clients opening the same package MUST derive the same review state from the same valid file set.

**AUTH-02. HTML is the entrance and actionable user interface to that package.** `OpenMarkdownReview.html` contains generic application code, bundled validators/renderers/fonts, styling, and the review toolbox. It MUST NOT contain embedded Markdown, comments, decisions, approvals, a package-specific manifest, or a private review database. It works with VS Code closed and without a review server, localhost process, browser extension, CDN, or account service.

**AUTH-03. Source authoring and reviewed evidence have different purposes.** The selected source workspace contains editable Markdown. A published revision freezes the exact bytes being reviewed in the package. Frozen bytes are shared audit evidence, deduplicated by digest across revisions and clients. Rendered review, anchors, approval, and export MUST use those bytes; they MUST NOT substitute live source or refetch live images. This necessary snapshot is not a second client-owned review.

**AUTH-04. Client storage is non-authoritative.** Memory, IndexedDB, and native cache files MAY hold verified bytes and derived indexes. Deleting those caches MUST not lose a saved review action. Reconstructible caches MUST live outside the package. Local permissions, preferences, scroll positions, and reviewer profile are client settings. Unsubmitted drafts and a pending-publication journal are explicitly local work, are not reconstructed review state, and MUST never be displayed as saved/shared evidence.

**AUTH-05. Client software is replaceable.** Regenerating, replacing, or removing the HTML MUST not change the interpretation or bytes of any protocol file. Client installation/upgrades MUST not create a review event or update approval state. One identical HTML build MUST work beside different review packages without customization.

**AUTH-06. A copied/synchronized package retains its review ID.** Copies of that same review merge by union of immutable files; unrelated review IDs never merge. Divergent manifests with the same review ID are an integrity conflict. Creating an intentionally separate review generates a new review ID. A network share, local folder, Git checkout, OneDrive, or Syncthing is storage/transport, not a second authority.

## 2. Roles and mandatory capability parity

VS Code is the graphical authoring entry point. A parameter-driven CLI exposes the same authoring operations without VS Code installed. The browser is a full review participant and audit-export client. A browser participant does not need access to the author's source workspace.

| Capability | VS Code | Double-clicked HTML | CLI |
| --- | --- | --- | --- |
| Open an existing package, including without original source | Required | Required | Inspect/validate required |
| Browse all documents, revision history, and competing revision heads | Required | Required | Structured listing required |
| Render Mermaid, GFM tables, local/data/HTTPS frozen images and attachments | Required | Required | Same content validation/export renderer |
| Text, image, diagram, table, and individual table-cell comments | Required | Required | Optional participant commands |
| Replies, visible locations, navigation, and thread filtering | Required | Required | Structured state required |
| Accept/reject a comment separately from resolve/reopen | Required | Required | Optional participant commands |
| Suggest insert/replace/delete with visible strikeout and insertion | Required | Required | Optional participant commands |
| Inspect and accept/reject suggested edits | Required | Required | Optional participant commands |
| Approve/reject/withdraw an assertion for an exact revision | Required | Required | Optional participant commands |
| Show every assertion, reason, conflict, and verification status | Required | Required | Structured state required |
| Export and verify an audited PDF plus machine-readable inventory | Required | Required | Required |
| Create a review, choose source files/folders, storage, policy, and root document | Required visual workflow | Authoring operation not offered | Required parameters |
| Publish a subsequent/merge revision or change document scope/policy | Required | Authoring operation not offered | Required parameters |
| Apply an accepted suggestion to editable source | Required explicit action | Authoring operation not offered | Required explicit command |
| Install/update the generic HTML beside a package | Required | No self-update | Required |

**PARITY-01.** The browser MUST not silently omit suggestions, table-cell threads, previous revisions, decision reasons, approval identity, or diagnostics while allowing approval. Participant features cannot be deferred merely because VS Code has them.

**PARITY-02.** Comparable comfort means the same review tasks, evidence, navigation, selection behavior, recovery, keyboard accessibility, and responsiveness. Host-specific source editing, native dialogs, shortcuts, and theme integration may differ. Participant actions MUST not ask a browser reviewer to install VS Code to finish the review or export its audited evidence.

**PARITY-03.** Limited browser/runtime capability results in an explicit read-only or unsupported state, not a reduced client advertised as a full participant. No silently downloaded event file, upload-only directory view, or browser Print command satisfies the shared-write or audited-export requirements.

## 3. Shared implementation architecture

```text
VS Code setup --------+                     Shared review UI
CLI parameters -------+-> Authoring service   /             \
                           |             VS Code host    HTML shell
                           |                  \             /
                           |               Review session
                           |                     |
                           +------ Shared protocol core ----+
                                        |                   |
                                 Native file adapter   Browser folder adapter
                                        \                   /
                                          Review package
```

**CORE-01.** The shared protocol core owns version negotiation, structural and cross-file validation, exact-byte digests, content descriptors, causal state folding, policy evaluation, publication planning, and audit inventories. The same code and fixture corpus MUST run under Node and in the browser. Pure rules MUST not import `vscode`, DOM, or Node filesystem APIs. Hashing and byte I/O are explicit platform interfaces; browser checks MUST not be a weaker copy of native checks.

**CORE-02.** A shared review-session layer owns the opened package, pinned revision, admitted-event inventory, verification state, serialized refresh queue, drafts, and pending writes. UI components receive immutable view models and send typed intents. They MUST NOT assemble event JSON using mutable global review/revision variables.

**CORE-03.** A shared review UI and rendering pipeline own document parsing, source mapping, semantic targets, highlights, discussion cards, suggested-edit presentation, dialogs, and export preparation. Host bridges only implement file permissions, storage, source-editor integration, and host presentation. Host adapters MUST not redefine acceptance, approval, or unresolved-thread rules.

**CORE-04.** The authoring service takes one normalized request and produces a capture/publication plan. VS Code's setup view and the CLI both call that service. The CLI MUST not automate VS Code or require an extension host. The browser bundle excludes source discovery, creation, and source-write services.

**CORE-05.** Adapter contracts distinguish not-found, denied/revoked, unavailable, incomplete-transfer, byte-mismatch, name-collision, unsupported-operation, and cancellation. Core results carry stable diagnostic codes and package-relative locations. A caught error MUST not be converted into a successful validation or publication result.

## 4. Validation and revision admission

**VALID-01.** Admission is ordered: bounded exact-byte read; strict UTF-8/JSON parsing; declared-version/schema validation; path and byte-digest validation; manifest/review identity and capabilities; revision/parent/reference validation; event graph and anchor validation; deterministic state fold. Schema checks alone are insufficient.

**VALID-02.** The loader retains each event's exact file digest and byte length alongside its parsed value. Hashing `JSON.stringify(parsedEvent)` MUST NOT stand in for hashing the received bytes. Different formatting is permitted where the wire specification permits it and is still distinct byte evidence.

**VALID-03.** Every anchored root must identify a published revision, a document in that revision, its exact digest, and a valid source or semantic target. Semantic IDs and table row/column bounds are checked against the frozen parsed document, not merely matched against a regular expression. Replies must name a comment in the same thread and revision. Missing dependencies are pending; malformed references and collisions are diagnosed and excluded.

**VALID-04.** Validation results distinguish `valid`, `pending`, `invalid`, `unsupported-required`, and `integrity-conflict`. Pending dependencies remain discoverable for retry. Unknown state-affecting features prevent writing and approval; optional presentation metadata may be preserved and disclosed without changing core state.

**VALID-05.** A revision descriptor may be admitted before all content is fetched. Each document/resource is displayed only after its own exact bytes verify. Unverified items have loading/unavailable placeholders. This is a partially loaded revision, not a fully verified package. A broken candidate MUST not replace an already verified active document. Whole-revision verification is mandatory for approval and audit export.

**VALID-06.** Revision selection is explicit and stable. A newly discovered revision is announced; it does not replace the reviewer’s pinned revision, selection, or draft. The UI offers a deliberate switch. Historical revisions remain navigable. Competing graph heads are visible together and do not acquire a winner through clock order.

## 5. Action contexts, decisions, and audit gates

**SESSION-01.** At the start of an action, capture an immutable context containing package-handle/session identity, review ID, manifest digest, revision ID and descriptor digest, document digest/anchor if relevant, actor, subject IDs, causal predecessor IDs, and an operation ID. Replies use the root thread's revision. The context survives every dialog and asynchronous step.

**SESSION-02.** Before publication, confirm the context still refers to the same package and subject and that its prerequisites hold. A revision arriving during editing does not retarget the action. The participant may save against the original valid revision, deliberately start a new action, or cancel. No automatic anchor migration is permitted. Changing reviewer identity during editing also requires explicit handling rather than changing the pending event author.

**SESSION-03.** Switching reviews increments the local session generation. Results from an older generation may finish a previously authorized write to its original package, but MUST NOT alter another package's state, cache, UI, or success message. Pending drafts remain associated with their original package/revision. A failed open of review B must never combine B's manifest with review A's revision.

**AUDIT-01.** Approval, rejection, withdrawal, and audited export require a successful fresh verification of the pinned revision and observed event set from authoritative storage. Verify the manifest, descriptor and all context revision descriptors, every selected-revision document/resource, policy, event bytes, and reference dependencies. Historical or competing-revision content needed to validate included anchors is also verified; unreferenced historical content need not be loaded. Any observed malformed/pending protocol file or integrity error blocks the operation with actionable diagnostics. Cached last-good content can remain readable but cannot authorize these operations.

**AUDIT-02.** The verifier returns a typed success receipt containing exact input digests, captured event frontier, verification timestamp, policy result, and session generation, or a failure. Callers MUST branch on that result. Logging a failure and returning a prior revision is forbidden. An operation receiving no success receipt cannot append an approval/export event.

**AUDIT-03.** After user input, obtain/renew the receipt and show the final revision/policy/open-work summary. If relevant observed state changes after that confirmation, require a renewed confirmation for a decision; an export may complete for its already captured inventory and clearly report its cutoff. The published decision records its verification inventory. No filesystem-only client can prove that another disconnected writer has no unseen events; UI and exports describe the observed inventory, not universal delivery or permanent completion.

**DECISION-01.** Accepting a comment means accepting its concern. It does not resolve the thread. Decision and resolution are separate registers; rejected, won't-fix, and duplicate decisions also require explicit resolution to close work. Reopening and superseding decisions use causal references defined in the wire draft. Conflict is always visible and blocks completion.

**DECISION-02.** Suggestions show their exact source, proposed edit, rationale, all decisions, and application status. Creating or accepting a suggestion never edits source. Applying it is a distinct authoring operation against explicitly selected source, with a refreshed acceptance check, exact source-byte precondition, guarded edit, persisted-byte verification, and before/after digests. If saving source succeeds but event publication fails, report “source changed; review record pending”; retry the same record without applying the edit twice.

**DECISION-03.** Counts distinguish assertions from distinct actors. The default package records self-asserted decisions without claiming organizational completion. A chosen completion policy is immutable and revision-bound. Repeated approvals by one actor do not increase quorum; contradictory causal heads are conflicts. Policy satisfaction is an evaluation of a captured inventory and can change as events arrive.

## 6. Synchronization, publication, and caches

**SYNC-01.** One serialized queue per package merges watcher, timer, manual refresh, and local-publication notifications. At most one enumeration/admission pass runs per package. A new notification requests one later pass; it does not start overlapping work. Two open clients are independent writers; cross-process correctness comes from immutable publication, not a client-local mutex.

**SYNC-02.** Assemble candidate state separately and publish it to the UI only at a consistent boundary. Incomplete candidate revisions, changed/removed previously admitted files, and invalid events do not erase the last-good view. Revision/content retries track actual verification, never just a selected revision ID. Dependency arrival schedules validation even when no new publication filename appears.

**SYNC-03.** Status includes disconnected, permission-required, loading, partially-loaded, current-observed, delayed, integrity-error, and unsupported. Informational rendering or polling MUST NOT overwrite a higher-priority unresolved diagnostic. Integrity errors clear only after a successful authoritative recheck, or after the user explicitly disconnects that package. Invalid files are identified without altering them.

**SYNC-04.** Default active polling is 3 seconds; hidden/background polling is 15 seconds and immediate on resume. Retry delays are 0.5, 1.5, 3, 6, 12, and 30 seconds, capped at 30 seconds. One pending retry per package is allowed; retries continue while connected, pause on permission loss, and support cancellation. These are observation intervals after files reach storage, not a transport latency promise.

**CACHE-01.** Warm refresh reads newly discovered or explicitly changed events, not every historical file. Cached exact digests provide a baseline for rechecks. A background integrity sweep checks at most 64 known events per pass and rotates through the inventory; Manual Verify and audit operations perform a full authoritative audit. Changes to bytes with unchanged filenames must eventually be diagnosed even if notifications were lost. Cache deletions must preserve the same reconstructed semantic state.

**CACHE-02.** Cache keys include review ID, manifest digest, immutable content digest, protocol/parser version, and renderer version where applicable. A render cache for a diagram depends on its source digest and renderer configuration, not on comment counts. Identical blobs use one cache entry. Default content-cache budget is 512 MiB with bounded eviction; local drafts and uncertain writes are tracked separately and never silently evicted as cache entries.

**CACHE-03.** A reply, decision, approval, or changed thread highlight patches the relevant view models and DOM. It MUST NOT reload Markdown or rerender unchanged Mermaid/images. Keep selections, scroll positions, focused discussions, and drafts. Diagram rendering and hashing use bounded work queues; long work yields to interaction or runs in workers.

**WRITE-01.** The proposed protocol 0.5 uses exact-byte content-addressed event names. All clients use the same manifest-declared layout and [publication algorithm](PROTOCOL-0.5.md#publication-and-retry). The browser does not pretend to provide native exclusive-create semantics. Legacy packages keep their old layout and rules; a browser without those primitives opens legacy packages read-only.

**WRITE-02.** An action is “saved to this folder” only after close and exact reread verification. A failed/uncertain write retains its operation ID, exact bytes, and digest for idempotent retry. Checking publication state precedes resubmission. Offline drafts or Downloads are not shared review evidence. A provider's later synchronization is separately reported and is not acknowledged as observed by other reviewers.

## 7. Markdown, resources, and anchors

**CONTENT-01.** All clients use one declared Markdown profile and deterministic source mapping. Required fixtures include bare relative destinations (`images/flow.svg`), `./` and `../` paths, spaces/percent encoding, Unicode, data images, HTTPS images, reference-style links, explicit attachments, and document/heading links. Safe relative destinations are parsed normally and rewritten to verified frozen resources; a blanket scheme allowlist MUST NOT turn valid images into literal Markdown.

**CONTENT-02.** Embedded images and `review:attach` links are required captured evidence. The authoring service resolves them against the containing Markdown file, enforces authorized roots or HTTPS rules, captures once, and hashes the bytes. Missing or unsupported required evidence blocks publication. Ordinary web links are recorded, labeled external/live, and opened only by user action. Links to included Markdown documents and headings navigate within the pinned revision; missing targets are disclosed.

**CONTENT-03.** Mermaid source, source digest, ordinal, and semantic ID must agree with the frozen Markdown. Render locally with pinned configuration and sanitization. A syntax/render failure remains visible and blocks complete review/export; it must not produce an apparently successful blank diagram. Both clients use the same validated diagram output for display and PDF export.

**ANCHOR-01.** DOM selections map to frozen source offsets through parser/source-map data. Repeated strings are disambiguated by the actual selected occurrence, range, prefix/suffix, and document digest. Inline formatting, code spans, links, entities, emoji, and CRLF are supported. A range that cannot be expressed exactly offers a clearly identified block comment; it is never silently attached elsewhere.

**ANCHOR-02.** Semantic comments store the actual source slice covering the image/diagram/table/cell as `quote.exact`, with a separate human label. “Table” or “Mermaid diagram 1” is not a substitute for an exact source quote. Validate table ID and cell coordinates against the frozen table. Overlapping comments retain all thread IDs. Existing text and semantic anchors remain navigable in both directions, including resolved threads and table cells.

**ANCHOR-03.** Suggestions require an exact editable source mapping. Ambiguous mappings cannot be applied. If an anchor is orphaned, show its stored quote and reason; navigation must explain the failure rather than silently doing nothing. Historical anchors never drift to a newer revision.

## 8. Reviewer experience and browser entry

**UX-01.** Opening the generic HTML shows the application immediately, explains any required folder grant in plain language, opens/validates the selected package, and presents its title and revision. A remembered handle is an optional shortcut, bound locally to HTML location plus the verified manifest/review identity. A replaced manifest or a different selected package requires an explicit choice. Offer Change folder, Reconnect, Forget remembered folder, and a read-only mode where available.

**UX-02.** Directory selection and permission renewal happen from a fresh user gesture. A slow failed reconnection must not automatically call another picker after user activation has expired; show a Choose folder action. Handle storage/serialization failures must not block a usable granted session. Browser file-origin support, restart persistence, and enterprise policy are verified on actual target browsers; method presence alone does not establish support. See [browser permission behavior](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api) and the [File System Access draft](https://wicg.github.io/file-system-access/).

**UX-03.** Identity setup appears before the first writing task and remains accessible at every supported width, including 320 CSS pixels and 200% zoom. It uses a stable actor ID plus display name and clearly identifies the base profile as self-asserted. Storage access must not be presented as inherited Windows identity. Missing identity cannot discard a composed comment; drafts survive recovery.

**UX-04.** Both UIs provide document search/navigation, an explicit revision selector, review identity, read/write status, thread/suggestion filtering, reply composition, decision buttons, resolve/reopen, and audited export. Decision values are choices, not strings reviewers must type. Conflicts, reasons, timestamps, actors, and history are inspectable. Important diagnostics are persistent and accessible, not only console logs or disappearing toasts.

**UX-05.** Keyboard users can select a review target, reach its discussion, reply, decide, and return to content. Focus remains predictable after refresh and dialogs. Both clients support light/dark themes, readable tables with scrolling on screen, diagram zoom, attachment opening/download, and clear pending/saved/error feedback. The same essential controls remain available in a compact layout.

**UX-06.** Multiple reviews have separate sessions and local drafts. VS Code retains the Activity Bar entry, clear active-review indication, Create/Connect controls, and a recent-review list. HTML may open another package in a separate tab/session. No shared mutable global active package may route an action to a different review.

## 9. Audited exports in every participant client

**EXPORT-01.** HTML, VS Code, and CLI invoke the same export planning and inventory logic. Browser export is local and writes into the granted package. It does not call VS Code, a local server, or a cloud PDF service. Browser Print MAY remain as a convenience action but MUST be labeled as unaudited and does not satisfy Export audit PDF.

**EXPORT-02.** The PDF contains all selected revision documents in deterministic order, frozen images, readable tables, Mermaid, attachment inventory, external references, comments/replies, all decisions and reasons, suggestion changes/lifecycle, approvals/rejections/withdrawals, actor assurance, policy result, verification cutoff, diagnostics, and renderer versions. Export is independent of the currently visible document, filters, or collapsed discussion cards.

**EXPORT-03.** The machine-readable inventory identifies exact manifest, revision, policy, document/resource, event, diagram-output, and PDF bytes. Omitted or invalid observed files and conflicts are disclosed; ordinary successful audited export requires no unresolved validation failures. A separate diagnostic report may describe a failing package but MUST NOT be labeled an approved/audited review export.

**EXPORT-04.** Freeze an immutable export input snapshot. The renderer consumes the verified bytes and events from that snapshot, not mutable current-session variables or unchecked files. Record actual bundled renderer/font/sanitizer versions. The same inputs need equivalent content and evidence coverage across clients; PDF bytes need not be identical across export times/platforms, and each artifact records its own digest.

**EXPORT-05.** Publish PDF and inventory bytes first and verify them; append `export.created` last. The inventory excludes the export's own event and its own digest to avoid circular hashes. Its exact shape and the detached references are defined in the wire draft. Receiving clients verify both artifacts and show the evidence cutoff, not a global claim that no later events exist.

## 10. Authoring service and CLI contract

**CREATE-01.** Graphical setup selects a source root, individual files/folders, exclusions, start document, title, actor, optional completion policy, and package location/name. Every successful creation installs the generic HTML entry file, including its bundled JavaScript, Mermaid and PDF runtime dependencies. The same inputs are accepted as CLI parameters. Normal disks, user-mounted shares, and Git folders are first-class locations; no storage-provider account is required.

**CREATE-02.** New creation requires a new or empty target directory. It never overwrites an existing manifest or silently adds another review to an existing package. The service resolves selections to exact, portable Markdown paths; captures blobs/policy/descriptor; publishes the first revision last; then installs the generic HTML. A failed capture yields a recoverable incomplete initialization, not a published review. Client installation failure after publication yields an existing valid review with a distinct client-installation error.

**CREATE-03.** Source scopes and explicit additional resource roots are local authoring inputs, not absolute paths in the manifest. Relative resource references are allowed only inside those deliberately granted roots. Browser participation never receives source-write permission. Remote creation/capture work must report progress and support cancellation before final publication.

**CREATE-04.** The CLI executable is proposed as `omr`; examples are a target interface, not currently available commands. It is non-interactive unless an explicit interactive mode is added later. Required missing parameters fail with a useful diagnostic; stdin is never unexpectedly used for prompts.

```sh
omr review create --source ./docs --store ./reviews/architecture --title "Architecture review" --include-dir architecture --include requirements.md --root-document architecture/overview.md --actor-id mira --actor-name "Miroslav Dusek" --operation-id create_architecture_01 --json
omr review create --source ./docs --store ./reviews/architecture --title "Architecture review" --include-dir architecture --root-document architecture/overview.md --actor-id mira --dry-run --json
omr revision create --source ./docs --store ./reviews/architecture --include-dir architecture --root-document architecture/overview.md --parent revision_01 --actor-id mira --operation-id revision_architecture_02 --json
omr review inspect --store ./reviews/architecture --json
omr review validate --store ./reviews/architecture --full --json
omr review export --store ./reviews/architecture --revision revision_01 --actor-id mira --operation-id export_architecture_01 --json
omr client install --store ./reviews/architecture --json
omr client update --store ./reviews/architecture --json
omr suggestion apply --source ./docs --store ./reviews/architecture --revision revision_01 --suggestion suggestion_01 --expect-source-digest sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef --actor-id mira --operation-id apply_architecture_01 --json
```

The revision/suggestion IDs above are illustrative; use the IDs returned by earlier commands. Windows uses the same flags with ordinary native paths, for example `--source "C:\Docs" --store "R:\Reviews\Architecture"`. An `smb://` URL is not a native folder path; the user supplies a mounted/mapped location or a supported native UNC path.

| Parameter | Defined behavior |
| --- | --- |
| `--source PATH`, `--store PATH` | Required native roots for creation. Inspect/validate/export/client installation require only store. No implicit current workspace is used by the CLI. |
| `--include PATH` | Repeatable exact source-relative `.md` file. |
| `--include-dir PATH` | Repeatable source-relative recursive directory. No shell glob expansion. Discovery excludes `.git`, `node_modules`, client caches/build outputs, and detected review packages. |
| `--exclude PATH` | Repeatable exact source-relative file or directory subtree, applied after the include union. |
| `--resource-root PATH` | Repeatable explicit additional root for capturing local resources only; not a document scope or permission to edit that root. |
| `--root-document PATH` | Required member of the final document set. Root first, remaining paths in deterministic protocol order. Empty selections fail. |
| `--title TEXT` | Required on new review creation. Later revisions retain the immutable review title. |
| `--actor-id ID`, `--actor-name TEXT` | Explicit stable actor ID and optional display name for writing commands. Display name is not used as an identity key. |
| `--policy PATH` | Optional local JSON policy matching the wire draft. New review defaults to assertions-only. Later revisions inherit policy unless explicitly changed. |
| HTML entry file | Always installed after publication; no opt-out flag. It does not change protocol semantics or silently rewrite an existing client. |
| `--parent REVISION_ID` | Repeatable exact parent for revision creation. A single known graph head is the default if omitted; competing heads require an explicit complete parent set for a merge. |
| `--operation-id ID` | Required for mutation commands that publish evidence. Reuses a local durable operation journal and exact pending bytes on retry; no second revision/event for an already completed operation. Generated internally for VS Code. |
| `--resume` | Explicitly resume a creation/publication operation in a nonempty incomplete target using its matching local journal. Missing journal, changed target identity, or changed frozen plan fails; never infer overwrite permission. |
| `--dry-run` | Creation/revision/apply planning only: resolve inputs, report scope, resources, policy, intended paths, and missing preconditions. No package/journal writes or network capture; remote availability remains unverified. No operation ID is required. |
| `--json` | Exactly one versioned result on stdout; progress/diagnostics on stderr. Never mix prose into machine output. |

**CREATE-05.** VS Code and CLI normalize inputs through the same service. Equivalent selections and settings produce the same scope, resource identities, validation results, and policy; unique IDs and timestamps need not match. Creation captures persisted source bytes; VS Code discloses relevant unsaved editors and requires saving or an explicit choice to capture the existing disk version before planning. Source bytes are read into a bounded immutable capture plan; retry uses that plan, not whatever source happens to contain later. Local journals are recovery aids and are not required to reconstruct a published package. If journal recovery is unavailable, inspect the package and require an explicit new operation rather than claiming idempotency.

**CREATE-06.** CLI result schema `omr-cli-result/1` contains `ok`, `command`, optional `operationId`, `outcome` (`planned`, `completed`, `already-completed`, `failed`, `uncertain`, `review-created-client-failed`), optional `reviewId`, `revisionId`, artifact paths/digests, and `diagnostics[]` entries with `code`, `severity`, `message`, and optional path. Exit codes are 0 success/planned/already-completed, 2 invalid inputs/unsupported feature, 3 validation or integrity failure, 4 access/I/O failure, 5 conflict/precondition failure, 6 cancellation, and 7 uncertain or partially completed mutation. Errors preserve the original package.

## 11. Storage security and client distribution

**SEC-01.** Native adapters validate real filesystem targets and parent directories against explicitly granted roots. The first professional pilot rejects links/junctions within protocol paths and source/resource capture paths; the explicitly selected root may itself be a resolved mounted location. Resolve, reject escaping/reparse components, and recheck before publication. Where safe handle-based containment cannot be guaranteed, refuse that operation and report the unsupported path. Lexical `path.resolve` checks alone are insufficient.

**SEC-02.** Browser I/O starts only from explicitly granted directory handles and descends through validated relative segments; it never reconstructs arbitrary absolute paths. Verify actual platform containment behavior with link/junction fixtures. Reconnection never interprets file access as authenticated actor identity.

**SEC-03.** Raw Markdown HTML is disabled; Mermaid is strict and sanitized. SVG is sanitized for inline use or rendered in a non-scriptable image context. Attachment MIME and content are validated; active content is never opened in the application's scripting origin. Unsupported files can be safely downloaded with a clear label where policy permits, but required unsupported evidence blocks publication. HTTPS redirects are bounded and revalidated at every hop; HTTP downgrade and embedded credentials are rejected.

**SEC-04.** Compile schema validators at build time. The HTML uses a restrictive CSP with hashes for its fixed scripts and does not need `unsafe-eval`. No review-supplied executable plugin code is loaded. Release auditing covers all shipped code, including dependencies classified as development-only but bundled into HTML/webviews. Produce a dependency inventory and address or explicitly assess advisories against the bundled versions.

**SEC-05.** Version/hash metadata identifies the HTML build without embedding review state. `client update` verifies a trusted installed release artifact, updates only the recognized generated HTML, and preserves a recoverable prior client file outside protocol directories. Unknown/user-modified HTML requires an explicit replacement choice. Updating executable HTML on a shared folder must be announced as a client update. A checksum stored beside modifiable software is not an independent trust anchor.

## 12. Performance, compatibility, and release boundary

**PERF-01.** UI feedback and draft editing must remain responsive while storage is slow. Enumeration, hashing, validation, rendering, and export have separate measured timings. Defaults and acceptance workloads are fixed in [ACCEPTANCE.md](ACCEPTANCE.md); they are targets, not claims of current measurements.

**PERF-02.** Readers enforce published limits before allocation and report unsupported size instead of exhausting memory or omitting content. Native file size, browser File size, streamed remote bytes, aggregate capture, renderer time, and cache growth are bounded. Adapter concurrency defaults to 4, independently of the serialized package-state queue.

**COMPAT-01.** Existing 0.2/0.3/0.4 histories retain original digests and meanings. Browser writing is enabled only for the new publication profile after its real-file acceptance tests pass. No automatic manifest rewrite, event renaming, approval carryover, or in-place migration is authorized. The first professional pilot creates new 0.5 packages; legacy readers remain available. A future migration must be separately specified and preserve original evidence.

**COMPAT-02.** The signed-identity/organizational-authentication profile is separate future work. Self-asserted review participation is allowed and clearly labeled in this pilot. Browser restrictions do not justify introducing a mandatory review server, browser extension, or local helper process. Required HTML functionality that cannot pass the target browser tests remains a release blocker.

Git-backed packages must preserve exact bytes through effective line-ending, filter, and encoding attributes, including inherited attributes. Creation inspects those settings, installs package-local preservation rules without replacing user-owned rules, and blocks or reports incompatible transformations. A fresh checkout is hash-verified in acceptance tests; having a `.gitattributes` filename alone is not sufficient.

**RELEASE-01.** Every requirement maps to executable or recorded acceptance evidence. A passing packaging/syntax check or an exposed browser API is not a permission, concurrency, or usability test. No professional-pilot claim is made until the required two-client, CLI, Windows/share, audit, and user-task gates pass.
