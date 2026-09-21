# 0.5 implementation and qualification status

Date: 2026-09-08. Status: **0.5.0 regular GitHub publication authorized with limitations; not cleared for the professional pilot**.

This report distinguishes implemented behavior from qualification evidence. Package version 0.5.0 identifies the candidate and its wire profile; it does not claim that all acceptance gates have passed. No remote push, merge or release is implied by a local build.

## Implemented architecture

`src/professional/` contains the shared exact-byte parser, precompiled schemas, graph/lifecycle/policy rules, rooted storage adapters, review sessions, authoring service, CLI, Markdown/source mapping, reviewer toolbox and audit exporter. The portable HTML and VS Code webview run the same toolbox. Only storage access and author-only source operations differ by host.

New review creation always emits a review-named HTML entry file bound to the review ID and exact manifest digest, without embedding reviewed content or events. Browsers open it directly, grant the adjacent folder once, and automatically reconnect only when the browser reports permission already granted; VS Code opens the same file through a custom editor. The VS Code extension uses its installed trusted client code when reading a received package. CLI creation calls the same authoring service, not VS Code automation.

Cold open now exposes manifest/event/rendering progress immediately and implements the partial-revision rule in VALID-05 for ordinary Markdown: descriptors and policy are admitted first, anchored-event validation fetches only referenced documents, and the visible document fetches only its used resources. Optional presentation profiles load their required profile evidence up front. Fresh approval/audit paths continue reading and verifying the complete required content set.

VS Code can publish an existing package to an empty shared/synchronized/Git destination using an exact link-free inventory, streaming hashes, exclusive destination files, manifest-last visibility, source recheck and full destination validation. It then switches to the destination and leaves the original disconnected on disk. Received or moved reviews use an explicit private source-link command that reports exact/changed/missing head documents; revising no longer falls back to the first unrelated workspace. Protocol 0.5 still has one Markdown source root, selected explicitly in multi-root workspaces.

The 0.4 reader is retained in VS Code without migration. The new HTML reader is 0.5-only; it does not reinterpret a 0.4 package using new lifecycle rules.

## Evidence recorded locally

- 78 core/legacy tests passed on macOS, including exact-byte parsing, anchors, receipt validation, order-independent causal conflicts, true cycles/depth bounds, cancellation before/after publication, safe source staging/recovery, CLI inputs, HTML-update backups, simultaneous partial-event preflight recovery and 10,000-event reconstruction.
- Two real Chromium integration scenarios passed: native file-backed toolbox/render/export and actual browser handles/IndexedDB with two simultaneous participants, stance changes and idempotent export retry. The normal Export button also recovered a deliberately partial PDF after closing/reloading the client, using the same operation and no duplicate export event.
- The actual VS Code extension-host smoke test passed: activation, command registration, same-file custom editor, and opening without protocol mutation. This is not full end-to-end VS Code interaction coverage.
- A five-page audit PDF was rendered and visually inspected. Captured SVG, Mermaid, table, both documents, comments, replies and exact event history were readable. The inspection caught and corrected unsupported PDF SVG styling and a blank trailing page.
- Full dependency audit returned zero known vulnerabilities at the time checked. Build metadata seeds conservative runtime dependency inventories, with embedded third-party/font/Unicode notices and fixed-hash script CSP.
- Native shared-module coverage was measured separately (80.18% lines / 76.99% branches for the measured run). The LCOV report excludes generated validators; it does not claim browser/webview coverage. Browser and extension interaction are separate executed suites.

The 10,000-event test uses an in-memory adapter, not a remote-share benchmark. It verifies cold/warm reconstruction equality and at most 64 event reads in the warm integrity sweep. It does not satisfy the specified reference-workload latency or memory gates.

## Acceptance mapping

“Automated coverage” means the listed behavior has an executable check, not that the whole multi-environment acceptance gate is closed.

| Gates | Implemented / automated coverage | Remaining qualification |
| --- | --- | --- |
| AT-01, 03, 04 | Shared core, pinned contexts, separate sessions and review-bound HTML launcher | Full cross-review delayed-UI and cache-deletion matrix |
| AT-02, 07, 08, 25 | Fresh exact audits, pending dependency retries, serialized scans, changed-frontier confirmation | Full corruption/arrival-order/provider and delayed-UI corpus |
| AT-05, 09, 12 | Images, Mermaid, tables, attachments; whole-revision export; exact hashes and detached inventory | Large/wide document PDF corpus and every reference-form/renderer-failure fixture |
| AT-06, 14, 15, 26 | Closed 0.5 schemas, semantic checks, causal registers, revision graph, explicit limits; retained legacy reader | Complete shared browser/native invalid corpus, all limit boundaries and optional-extension profile |
| AT-10, 13 | Rooted handles, symlink/junction rejection, independent publication and same-intent retries; Windows core/browser CI passed | Every fault boundary and adversarial parent-path replacement race; SMB excluded / untested |
| AT-11, 16, 17 | Shared participant actions, narrow-screen identity, repeated-text and source-map checks | Full keyboard/zoom/screen-reader, formatted-selection and semantic-target matrix |
| AT-18 | Global four-operation admission, warm state/render reuse, deduplicated audit reads, paged history | Required latency/memory percentiles and injected-slow/reference-size workloads |
| AT-19 | Browser grant/reconnect UX; native-picker fixture retained but dependent on excluded SMB setup | Actual local native folder grants and restart/revocation/policy/moved-package matrix remain unqualified |
| AT-20 | CSP, strict Markdown/Mermaid, raster header limits, dependency closure/notices | Complete malicious-content corpus and interruptible Mermaid render deadline |
| AT-21, 22, 23, 24, 27 | Shared GUI/CLI creation; cancellation/resume checkpoints; staged source replacement and same-operation retry; confirmed HTML updates | Remaining cancellation/error-class parity, all crash points and Windows filesystem replacement/ACL behavior |
| User-task gate | Working shared UI and example review | Five independent participants' recorded tasks are not performed by automated tests |
| AT-28 | Exact verified package-copy implementation, manifest-last destination, full source/destination validation, symlink/nonempty refusal, private exact/changed/missing source-binding inspection, explicit VS Code commands | Native Windows relocation and filesystem-change fault injection remain to be qualified; SMB remains excluded / untested |

## Concrete remaining implementation limitations

These are release blockers under the full professional specification, not claimed completed work:

1. Mermaid rendering is serialized, cached and source-size limited, but still executes its DOM-dependent renderer on the UI thread. The specified hard, interruptible 20-second task deadline is not implemented. Configuration directives/front matter are explicitly rejected.
2. Creation/capture now accepts cancellation before final revision publication, aborts remote capture, drains started file work, and retains exact checkpoints. VS Code offers saved operations for resume; CLI signals return code 6 before publication. Once final publication starts it completes and reports the actual outcome. Uniform cancellation of participant rendering/export/source application and the complete CLI error-class contract remain incomplete.
3. Native containment checks reject links/junctions and recheck paths, but Node pathname operations cannot prove immunity to every adversarial parent-directory swap. Source edits now stage and verify a separate file, preserve POSIX permission bits and original bytes in the private recovery journal, recheck source/acceptance, and replace the directory entry rather than stream over live source. Tests cover partial staging, changed source, new rejection, unrelated staging bytes and publication failure after replacement. Power-loss durability, concurrent external editor races, and local Windows replacement/ACL semantics still require qualification; SMB semantics are excluded and untested. No cross-process compare-and-swap is claimed.
4. Optional presentation-extension schemas are declared by the draft but their complete schema-blob retention/disclosure/conformance workflow is not yet implemented. Unsupported state-affecting capabilities are rejected.
5. The 0.5 client has bounded in-session caches, not a qualified persisted cold-start cache. Full-history audit memory and the complete performance workload remain unqualified.
6. Diagram zoom, search, paged history and keyboard-selectable semantic targets are implemented. Full navigation/accessibility and the complete formatted-selection corpus remain to be qualified; passing the repeated-phrase test alone is not comprehensive anchor assurance.

## Windows policy and release decision

Windows testing is CI-only. Run 4842206, commit `7a2ebb9`, passed all Linux validation/packaging and Windows core tests, the browser storage probe, both browser integration scenarios and the VS Code extension-host test. Windows then failed to provision its disposable SMB share (`New-SmbShare: Access is denied`), so no SMB or real native folder-picker tests ran; Windows audit/packaging were skipped in that run.

On 2026-09-08 the user confirmed that a CI-only SMB share cannot be arranged and requested skipping it. Both CI and release validation now exclude SMB qualification, recording it as **untested, not passed**. Fixtures are retained but not scheduled. The exclusion covers only SMB; real local Windows browser folder grants and remaining permission/restart scenarios still require evidence. Neither origin-private browser handles nor the native storage bridge establishes that evidence. See the [scoped acceptance exclusion](ACCEPTANCE.md#smb-qualification-exclusion).

The professional pilot remains on hold until the concrete blockers and all non-excluded required gates are closed. The SMB exclusion does not waive any other requirement or establish SMB compatibility.

`release-qualification.json` explicitly keeps professional-pilot approval disabled and records both the SMB exclusion and the user's separate authorization for regular publication with a limitations note. Publication classification does not establish qualification. The workflow marks evaluation builds as pre-release and standard builds as regular, runs browser/extension checks on local storage, and refuses to overwrite existing release assets. For 0.5.0 only the GitHub classification and notes changed: the source tag and CI-tested binaries retain their original evaluation metadata. The default qualification command still refuses professional-pilot approval.
