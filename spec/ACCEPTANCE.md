# Professional pilot acceptance and work packages

Status: required acceptance evidence, 2026-09-08, with the scoped SMB exclusion below. Current executable coverage and remaining blockers are tracked in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md). A passing unit test does not close a whole multi-environment gate. Windows qualification runs only in CI; no participant production share or separately accessed Windows host is required. SMB tests are not scheduled.

This document verifies [PROFESSIONAL-V1.md](PROFESSIONAL-V1.md) and [PROTOCOL-0.5.md](PROTOCOL-0.5.md). Every gate is mandatory for the professional pilot except future optional work and the explicitly excluded SMB scope below. Test reports record client build, protocol profile, operating system, browser/VS Code/Node versions, storage provider, fixture digest, result, and diagnostic/timing evidence.

## SMB qualification exclusion

On 2026-09-08 the user requested skipping SMB qualification because an authorized CI-only share cannot be arranged. Real SMB transport, concurrent shared-drive publication, native browser grants on SMB, shared-drive ACL/recovery and real SMB performance are excluded from this candidate's required CI/release evidence. This applies only to the SMB portions of gates such as AT-02, AT-13, AT-19 and AT-23, the SMB environment row and the real-SMB performance run. UNC path parsing can still be tested without accessing a share.

The exclusion is recorded in `release-qualification.json` as **untested**, never passed. It changes qualification scope, not protocol correctness rules or runtime filesystem support. Local Windows native browser grants, local-disk and injected-slow-adapter behavior, other storage-provider tests, security, performance and user-task gates remain required. The retained native-picker fixture currently depends on SMB and has not run; its absence is not evidence that local browser folder permissions work. A release must not advertise SMB as qualified without separate future evidence.

## Findings and acceptance traceability

P1 means correctness, integrity, or mandatory-feature blocker. P2 means usability, efficiency, or release-quality blocker; P2 is not permission to omit a mandatory pilot feature.

| Gate | Priority / source finding | Required behavior | Evidence that closes it |
| --- | --- | --- | --- |
| AT-01 | P1: single authoritative package | AUTH-01 through AUTH-06, CORE-01 through CORE-05 | Use identical HTML bytes beside packages A and B. Alternate native/browser comments and replies. Delete reconstructible caches, replace HTML, reopen without source, and recover the exact same state from package files. Inspect the HTML for absence of fixture-specific content. Check module boundaries: one shared validation/session/rendering core, host-only I/O bridges, and one authoring service called by both VS Code and CLI. |
| AT-02 | P1: failed full audit still authorizes actions | AUDIT-01, AUDIT-02 | After warm load, delete/corrupt a known event and separately a blob, descriptor, or policy. Attempt native/browser approval, rejection, and audit export. Each fails with no decision/export event; previous readable content remains visibly stale. Repeat after a failed share read. |
| AT-03 | P1: revision changes during a dialog | SESSION-01, SESSION-02, VALID-06 | Start comment/reply/decision/approval on R1, publish R2 elsewhere, then submit. Save only to the explicitly pinned R1 or require deliberate re-entry. No event combines R1's anchor with R2's ID; no approval targets R2 implicitly. |
| AT-04 | P1: cross-review session contamination | SESSION-03, UX-06 | Delay a write/refresh for A, switch to B, let A finish. B's manifest/revision/events/cache remain B's; completion identifies A. Make B fail during open and verify A is not presented under B's identity. |
| AT-05 | P1: ordinary image and attachment links fail | CONTENT-01 through CONTENT-03 | Render bare relative, dot-relative, parent-relative within granted roots, data, HTTPS, percent-encoded, Unicode, and reference-style destinations. Compare both DOMs and PDFs against captured resource inventories. Assert visible images and usable frozen attachments, not just successful capture. Include missing/mismatched Mermaid descriptors and syntax/render failures; they remain visible and block complete verification/export. |
| AT-06 | P1: validators disagree or omit relationships | VALID-01 through VALID-04 | One valid/invalid corpus runs in native and actual browser bundles. Include date-only timestamps, invalid UTF-8, duplicate JSON keys, wrong anchor digest, cross-thread replies, nonexistent cells, incorrect Mermaid sources, capabilities, and collisions. Admission and diagnostic codes match. |
| AT-07 | P1: failed candidate revision stops retrying | VALID-05, SYNC-02 | Deliver publication, descriptor, Markdown, image, attachment, and policy out of order, withholding each in turn. Keep last verified document usable. Deliver missing bytes without another event filename. Candidate verification recovers and an explicit switch opens complete content. |
| AT-08 | P1: false current status and overlapping polls | SYNC-01 through SYNC-04 | Make I/O exceed two polling intervals; trigger manual refresh and a watcher burst. Maximum active package scan is one. A deleted/rewritten event, malformed file, or permission loss remains visible until a successful recheck. “Up to date” cannot overwrite it. |
| AT-09 | P1: PDF hashes reserialized events | VALID-02, EXPORT-03 through EXPORT-05 | Store semantically valid events using compact, spaced, reordered-key JSON and optional trailing LF. Independently hash exact files. Verify every digest in PDF, inventory, and detached event against those bytes in all export clients. |
| AT-10 | P1: symlink/junction escape | SEC-01, SEC-02 | Native source, resource, event, blob, and output parent components contain links to harmless outside fixtures. Reject before outside reads/writes; repeat with Windows junctions and a path swapped during operation. Exercise actual browser handle containment. |
| AT-11 | P1: HTML omits review evidence | PARITY-01 through PARITY-03 | On a multi-document package containing all event families, both UIs show suggestions/strikeout, cells, actors, reasons, resolutions, withdrawals, conflicting decisions, and older revisions. Perform every mandatory participant action in each client without switching applications. |
| AT-12 | P1: convenience printing replaces audit export | EXPORT-01 through EXPORT-05 | In the browser select only document 2 and hide resolved threads, then Export audit PDF. It still exports the complete revision and all review evidence, writes PDF/inventory/event to the package, and passes independent verification with VS Code closed. |
| AT-13 | P1: browser publication cannot meet 0.4 contract | WRITE-01, WRITE-02, protocol publication rules | Two native/browser writers publish simultaneously on local disk and SMB. Inject failure before create, during write, at close, after close before reread, and after reread before acknowledgement. Retry identical bytes/IDs; no duplicate action, overwritten valid file, falsely acknowledged action, or admitted partial event. Deliberate logical-ID collisions are quarantined. |
| AT-14 | P1: acceptance incorrectly closes work | DECISION-01 through DECISION-03 | Accept a concern: it remains open. Resolve then reopen it; permute file arrival and create competing transitions. Check identical status/conflicts and distinct-actor quorum in all clients. Historical 0.4 fixture keeps its original closed-on-decision meaning. |
| AT-15 | P1: untrusted clocks select a revision winner | VALID-06, revision-parent rules | Create two revisions from one parent with opposite clock skews. Both are heads; neither silently replaces the pinned revision. Publish an explicit merge descriptor referencing both and verify old comments/approvals are retained on their original revisions. |
| AT-16 | P2: identity vanishes on narrow screens | UX-03 through UX-05 | At 320, 768, 1,024, and 1,440 CSS pixels and 200% zoom, a fresh reviewer can enter identity, compose, submit, and recover a failed draft. No inaccessible required field; keyboard-only completion works. |
| AT-17 | P2: duplicate/formatted text is hard to comment | ANCHOR-01 through ANCHOR-03 | Select the second identical phrase, formatted text, code spans, entities, emoji, multiline CRLF content, and each semantic target. Verify exact source mapping, click-through to the right discussion and back, overlapping highlights, and explicit orphan handling in both clients. |
| AT-18 | P2: full rerender on each event | CACHE-01 through CACHE-03, PERF-01 | Warm reply/decision/approval reads no unchanged Markdown or historical event files outside the separately measured integrity sweep, performs zero unchanged Mermaid renders, and retains scroll/selection/draft/focus. Run the workload below. |
| AT-19 | P2: only API presence tested | UX-01, UX-02, COMPAT-02 | Real double-click from local disk and mapped SMB in supported Edge/Chrome: first grant, close all tabs, restart, permission renewal/revocation, unavailable IndexedDB, moved package, changed manifest, wrong selected folder, and organization-blocked writes. No testing flags bypass production security behavior. |
| AT-20 | P2: shipped development dependencies escape audit | SEC-03 through SEC-05 | Audit the actual JS/HTML/native dependency graph, including bundled AJV/Mermaid and transitives. Inventory/version-match shipped assets, verify fixed-script CSP without unsafe-eval, and inspect sanitized malicious Markdown/SVG/Mermaid/attachment fixtures. Dependency exposure is assessed rather than inferred solely from npm categories. |
| AT-21 | P1: creation depends on VS Code | CREATE-01 through CREATE-06 | On a machine without VS Code, CLI parameters create a fully usable package with generic HTML. Browser opens it and native client later reads/writes it. Matching graphical and CLI inputs yield equal scope/resources/policy and validation decisions. |
| AT-22 | P1: creation/resume and source-apply failures | CREATE-02, CREATE-05, DECISION-02 | Fail capture, first publication, HTML install, and source-apply event publication separately. Resume matching journal/operation; never overwrite an existing review or apply a suggestion twice. JSON outcome/exit code distinguishes created-review/client-failed from no published revision and uncertain writes. |
| AT-23 | P2: CLI parameter and result ambiguity | CREATE-04 through CREATE-06 | Test repeatable include/folder/exclude flags, empty scope, missing root, quoted Windows/UNC paths, policy rejection, --dry-run, cancellation, --json stdout isolation, stderr progress, and exit codes. Dry-run performs no package/journal writes or remote capture. |
| AT-24 | P2: software update alters shared state | AUTH-05, SEC-05 | Install/update generic HTML via VS Code and CLI. Protocol file hashes are unchanged. User-modified HTML is not silently overwritten. Reopen after update; remembered permissions remain best effort and package identity is rechecked. |
| AT-25 | P1: delayed files or caches undermine audit cutoff | AUDIT-03, EXPORT-04 | Add events during verification/export and change UI filters/revision while it runs. The published artifact has one consistent captured inventory; approvals renew their confirmation when relevant observed state changed. No claim of seeing a disconnected writer's events. |
| AT-26 | P1: schema evolution/limits remain vague | VALID-04, PERF-02, COMPAT-01, RELEASE-01 | Reject unsupported required semantics, retain optional presentation extensions, and exercise each size/count/path/graph limit at and above its boundary. Cold reconstructed state equals warm state. Opening legacy data never renames files, mutates manifests, or transfers approvals. The release report maps every requirement/gate to evidence for the exact built artifacts and preserves unknown/not-run status rather than treating it as passed. |
| AT-27 | P1: source edits bypass accepted-state preconditions | DECISION-02 | Introduce a suggestion rejection while apply is being prepared, change source/editor version, and simulate save failure. Refuse unsafe application; hash actually persisted bytes. Publication failure after source save retains explicit pending evidence and a safe same-operation retry. |

## Execution layers and required environments

Run pure rules and adapter tests first, then actual browser/extension/CLI interaction. Mocks provide deterministic fault injection but cannot substitute for native folder-picker grants, file-origin behavior, Windows junction handling, or network-share publication.

| Environment | Minimum required evidence |
| --- | --- |
| Node shared-core corpus on Windows, macOS, Linux | Validation, exact hashes, causal permutations, CLI request/results and native publication |
| VS Code extension host on Windows and macOS | Setup, review switching, source selection/apply, shared review UI, export and installation |
| Edge and Chrome stable on Windows, local disk | First grant, restart/regrant, all reviewer actions, actual package writes, audited export |
| Edge or Chrome on Windows, real mapped SMB share | **Excluded / untested for this candidate.** Future qualification: two participants and one VS Code author; interruptions, concurrent publication, ACL loss/recovery, performance |
| Chrome stable on macOS, local disk | Full HTML parity and permission/restart checks against the native client |
| Native CLI without VS Code installed | Create/revise/validate/export/client-install/apply workflow solely from parameters |
| Git checkout across Windows and macOS/Linux | Exact bytes preserved, independent events union without JSON merges, no automatic fetch/push claim |
| At least one asynchronous folder sync provider | Out-of-order arrival, duplicate/conflict copies, offline drafts, convergence after delivery |
| Unsupported/restricted browser | Clear unsupported/read-only outcome, no simulated shared save, drafts retained where possible |

Enterprise policy settings, SMB server/filesystem, endpoint protection, browser version, connection latency, and hardware are recorded. Windows runner packaging alone does not satisfy the Windows interaction/share rows. No authentication profile is claimed by these base-profile tests.

## Performance workload and budgets

These are acceptance targets, not results from the current implementation. Keep functional correctness at the boundary even when a target fails. Never hide incomplete verification to achieve a timing target.

Standard fixture: 20 Markdown documents, 40 captured resources including attachments, 10 Mermaid diagrams, 20 MiB total frozen content, and 1,000 events. Scale fixture: 100 documents, 100 diagrams, 10,000 events and 200 MiB frozen content, within the wire profile's remaining limits. Include repeated text, wide tables, and threads distributed across documents and revisions.

Reference machine: at least 4 CPU cores and 8 GiB RAM, with exact model recorded. Run local SSD and an injected slow adapter with 100 ms latency per operation and 5 MiB/s throughput. The real mapped SMB run is excluded for this candidate under the decision above; injected latency is not a substitute for SMB qualification. Native/browser comparison uses the same host and same package bytes. Record cold start separately from warm cache, permission UI separately from application latency, and storage time separately from CPU/render time.

| Metric | Gate |
| --- | --- |
| First visible reaction to a user action | p95 <= 100 ms; storage work shows progress and supports the specified cancellation |
| Warm open to usable pinned document, standard fixture | p95 <= 2 s local; <= 5 s injected slow adapter, after permission is granted |
| Cold open, standard fixture | <= 10 s local; <= 60 s injected slow adapter; show progress within 100 ms |
| Saved-event UI update after verified publication | p95 <= 200 ms, excluding file I/O; no unchanged diagram rendering |
| One remote action to visible update, active foreground client | p95 <= 5 s after complete bytes become visible at the local adapter, including default polling |
| Burst of 100 newly delivered events | <= 10 s on injected slow adapter with bounded concurrency; one coalesced state update per completed pass |
| Ordinary warm refresh with no changes | No historical event-body reads except separately budgeted integrity sweep; no Markdown/blob reads; no Mermaid work |
| Standard fixture complete audit/export | <= 120 s injected slow adapter; accurate progress and bounded memory; record PDF rendering versus storage time |
| Standard fixture steady-state incremental application memory | <= 512 MiB above browser/extension-host baseline; worker/cache accounting included |
| Scale fixture | No crash, lost action, overlapping scan, or input freeze; cold/warm/audit times and peak memory recorded before release, with regression baseline |

Use at least 20 measured action/warm runs after setup; report p50, p95, sample count, and all failures. Repeat cold tests at least three times with reconstructible caches empty. A failed metric creates a tracked release issue; changing the workload or limit is a specification change, not a test waiver. Browser background throttling is tested for eventual catch-up, not subjected to foreground timing promises.

## User-task acceptance

At least five participants who did not implement the client complete the same tasks in both UIs: open a supplied package, identify its revision, comment on the second repeated phrase, comment on a cell and diagram, reply, propose a strikeout/replacement, decide then resolve a concern, inspect a prior revision, approve/reject with the correct identity, and export a complete audited PDF.

Every participant must be able to finish with the in-product guidance and no developer intervention. Record task completion, time, mistaken target/revision, lost draft, inaccessible control, and any need to switch client. Any wrong-package/revision action, hidden required evidence, or false saved/verified message is a blocker. Differences in styling or shortcuts are acceptable; missing reviewer capability is not.

Separately, an author creates equivalent reviews through graphical setup and CLI parameters, including an externally stored/custom-named package and two reviews attached to the same source workspace.

## Ordered work packages

| Work package | Deliverable and completion boundary | Dependencies / gates |
| --- | --- | --- |
| WP-01: protocol contract and shared core | 0.5 schemas/types, exact-byte loader, validation/causal/policy fold, storage-neutral errors, legacy readers, invalid corpus | First; AT-01, AT-06, AT-14, AT-15, AT-26 |
| WP-02: publication and consistent sessions | Native/browser adapters, content-addressed writes, recovery journal, pinned action contexts, serialized refresh, verification receipts, sticky failures | WP-01; AT-02, AT-03, AT-04, AT-07, AT-08, AT-13, AT-25 |
| WP-03: shared rendering and review toolbox | Common Markdown/source map, semantic targets, responsive/accessible UI, replies/suggestions/history/decisions in both hosts, incremental rendering | WP-01/02; AT-05, AT-11, AT-16, AT-17, AT-18, user-task gate |
| WP-04: authoring service and CLI | One normalized creation/revision/apply service, VS Code setup adapter, parameter CLI/results, durable recovery, generic-client install/update | WP-01/02; AT-21, AT-22, AT-23, AT-24, AT-27 |
| WP-05: common audited export | Frozen export plan, browser-capable PDF generation, exact inventory/detached publication, CLI/native/browser verifier | WP-01/02/03; AT-09, AT-12, AT-25 |
| WP-06: containment, permission and release security | Native real-path/handle checks, browser grant/recovery UX, sanitization, CSP build, complete dependency inventory, trusted client update | Integrated throughout WP-02/03/04/05; AT-10, AT-19, AT-20, AT-24 |
| WP-07: deployment qualification | Complete environment matrix, injected failures, performance baselines, real-user tasks, release artifacts and gate report | All preceding work; every AT gate and required environment row |

Work-package completion requires its deliverables and gate evidence, not just code changes. A shared core and UX component set may be built once and bundled into both clients; independent fixtures/verification must still detect client-specific divergence. No work package introduces a mandatory server or client-owned authoritative database.

## Pilot entry decision

The professional pilot may start only when all non-excluded P1 and P2 gate requirements, required environment rows, performance gates, and user tasks pass for the exact release artifacts. The only current exclusion is the SMB scope above. Unverified behavior is reported as unverified. The release notes declare the supported protocol profiles and browser/storage combinations, explicitly preserve the SMB exclusion, and distinguish self-asserted participation from authenticated organizational sign-off.

Signed identity, remote authentication, automatic Git transport, and legacy migration are optional future specifications, not prerequisites silently substituted for the requested serverless pilot. Full HTML reviewer parity, audited export, and parameter-driven CLI creation are prerequisites.
