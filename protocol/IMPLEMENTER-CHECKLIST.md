# Protocol 0.4 implementer checklist

This checklist is an implementation map for the normative requirements in [`README.md`](README.md). The protocol README takes precedence if wording differs.

For the next professional pilot, use the [client specification](../spec/PROFESSIONAL-V1.md), [0.5 wire draft](../spec/PROTOCOL-0.5.md), and [traceable acceptance gates](../spec/ACCEPTANCE.md). This legacy checklist remains specific to 0.4; in particular, it must not be used to silently apply 0.5 lifecycle or publication behavior to old packages.

## 0. Conformance role and authority

- Declare whether the implementation is a core reader, participant writer, authoring writer, audit exporter, or a combination.
- Treat the selected review package as the only authoritative shared review record, independent of VS Code, browser, CLI, or filesystem provider.
- Keep active-review selection, directory handles, indexes, UI state, and caches outside protocol directories.
- Make every cache reconstructible and disposable; a full audit must verify authoritative shared bytes.
- Do not infer event identity or semantic order from Windows/SMB identity, ACL owner, modification time, enumeration order, or advisory locks.
- Do not claim participant-writer conformance unless the storage API satisfies exclusive publication for protocol 0.4.

## 1. Package reader

- Select an explicit review-package root; never infer it from a hard-coded `.review` name.
- Parse `manifest.json` as UTF-8 JSON and validate `protocol`, version, paths, capabilities, IDs, and timestamps.
- Normalize every protocol path, reject unsafe segments, resolve it below the selected package root, and prevent link/junction escape.
- Enumerate only `events/*.json`; ignore temporary, conflict-copy, and unrelated files.
- Require each admitted event filename to equal `<event.id>.json`.
- Report malformed, unsupported, wrong-review, incomplete, and colliding files without changing valid files.

## 2. Revision admission

- Sort valid `revision.created` events by timestamp instant and ASCII event ID.
- Resolve the descriptor path, hash its exact bytes, validate its JSON, and verify manifest/event/revision identities.
- Require the root document, unique document paths, exact blob paths, byte lengths, media types, and digests.
- Verify resource/document ownership, semantic IDs, Mermaid source digests and ordinals, and diagnostics.
- Verify every content blob before presenting the revision.
- Treat missing files as retryable synchronization gaps and mismatches as integrity failures.
- Select only the latest fully valid publication for the default rendered view.

## 3. State fold

- Make state a pure function of the admitted immutable file set.
- Deduplicate identical event IDs and quarantine conflicting reuse of any logical object ID.
- Resolve roots before children so arrival order cannot affect results.
- Require every event to reference a published revision and every anchor digest to match its revision document.
- Keep unmatched children dangling and retry when new files arrive.
- Combine exact-package filesystem watching with bounded polling where near-real-time shared-folder updates are offered.
- Serialize/coalesce refreshes, retain the last known-good state during partial synchronization, and expose delayed state to the user.
- Order replies and presentation lists by timestamp instant then ASCII ID.
- Treat different thread decisions or accept/reject suggestion assertions as visible conflicts.
- Never infer an organization-wide approval from one actor assertion.

## 4. Writer

- Generate filename-safe, collision-resistant IDs and RFC-3339 UTC timestamps.
- Write every event to its own new file using exclusive-create semantics.
- Write content blobs first, the revision descriptor second, and `revision.created` last.
- Never modify or delete a published manifest, revision, blob, event, or audited export.
- On a name collision, compare content-addressed blobs only; fail for every other object.
- Preserve exact bytes under Git, including a package-local `.gitattributes` rule when appropriate.

## 5. Markdown capture and rendering

- Freeze every embedded image and every `review:attach` resource before revision publication.
- Bound protocols, redirects, time, and bytes; reject credentials and active attachment types.
- Record ordinary links without fetching them and redact secret-bearing metadata.
- Render from frozen document/resource blobs only, with raw HTML disabled.
- Render Mermaid locally with a recorded version and strict/sanitized output.
- Implement deterministic resource, reference, Mermaid, and table IDs exactly as specified.
- Support text, image, Mermaid, table, and table-cell anchors with quote/range fallback.

## 6. Review actions

- Create comments and suggestions only against an exact published revision and document digest.
- Preserve root comments, replies, decisions, resolutions, approvals, rejections, and suggestion lifecycle events independently.
- Display where a comment belongs and provide navigation between content, discussion, and available source.
- Apply a suggestion only after explicit acceptance, conflict checks, anchor recovery, and user action.
- Record before/after source digests and require a new revision for changed source.

## 7. Audit export

- Build the export solely from frozen revision bytes and admitted events.
- Include documents, images, Mermaid, tables, comments, replies, all decisions/conflicts, suggestions, approvals/rejections, references, versions, and digests.
- Fail if required frozen content or Mermaid output is unavailable.
- Write and hash the PDF before publishing `export.created`.
- Include each pre-existing represented event ID exactly once and every rendered Mermaid diagram digest exactly once.
- Verify a received export path and digest before describing it as audited.
- Accept a non-empty independent renderer client identifier; do not require the VS Code implementation name.

## 8. Required conformance tests

- JSON Schema and independent runtime validation for every object and event type.
- Permutation tests proving state is independent of filesystem/arrival order.
- Duplicate/colliding ID, wrong filename, wrong review, wrong revision, and dangling-child tests.
- Traversal, symlink/junction escape, malformed path, digest mismatch, and partial-file tests.
- Blob, descriptor, anchor-document, semantic-target, Mermaid-source, and export integrity tests.
- Concurrent exclusive-write tests on local disk and at least one supported mounted/synchronized filesystem.
- Missing/oversized/redirected/insecure remote resource and active-content rejection tests.
- Comment/reply/resolve/decision conflict and suggestion accept/reject/apply conflict tests.
- Render and PDF tests containing multiple documents, external/local images, Mermaid, wide tables, attachments, replies, and revision approval/rejection.
- Package-and-install smoke test that verifies all runtime assets are present in the VSIX.
- Cross-client test in which two independently identified implementations fold the same fixture and alternately publish comments, replies, decisions, approval/rejection, and an export event.
- Cache-deletion test proving that all shared semantic state reconstructs from the package alone.
- Browser/file-client capability test proving real package-directory write, close, reread, exclusive collision handling, and partial-write quarantine before claiming participant-writer support.

The reference client maps these responsibilities to `src/protocol/validation.ts`, `store.ts`, `state.ts`, `snapshot.ts`, `anchor.ts`, the VS Code client modules, and `test/protocol.test.ts`.
The future wire-format requirements and signed/browser-writer gaps are tracked in [`STANDARDIZATION.md`](STANDARDIZATION.md).
