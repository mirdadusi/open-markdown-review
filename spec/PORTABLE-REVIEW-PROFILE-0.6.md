# Portable Review Package Profile 0.6

Status: implementation candidate, 2026-09-23. This is a product/package profile layered on the [Open Markdown Review Core Protocol 0.6](PROTOCOL-0.6.md). It does not create another source of truth.

## Purpose and conformance

This profile makes a review folder directly usable by ordinary participants without installing a server or browser extension. A conforming package contains the authoritative core evidence plus a review-bound, double-clickable HTML client. The HTML, its runtime dependencies, local caches and visual state are tools for reading and writing the core package; none is review evidence.

A product claims this profile only when all mandatory requirements below pass. A valid core package can still be opened by another conforming client if its HTML launcher is missing, damaged or deliberately omitted.

## Required product files

```text
review-package/
  manifest.json
  events/
  revisions/
  blobs/sha256/
  exports/
  Review-<portable-name>.html
  .gitattributes
```

The launcher filename is deterministically derived from the review title using ASCII letters, digits, dot, underscore and hyphen; `Review-` and `.html` are fixed. It contains only trusted executable client assets and an inert binding with launcher schema version, review ID, title and exact `manifest.json` digest. It MUST NOT embed mutable review state, frozen Markdown, comments or a second event database.

The launcher opens the adjacent authoritative folder after the browser grants a directory capability. It refuses a folder whose review ID or manifest digest differs from its binding. Opening the same file in VS Code MAY invoke a registered custom editor. Browser permission handles, participant identity, view preferences, drafts and caches remain local and disposable.

`.gitattributes` disables text conversion, filters and working-tree encoding for every package byte. It is transport protection rather than protocol evidence.

## Required content profile

Packages require `sanitized-html-v1`; revisions use `commonmark-gfm+sanitized-html-v1`. Markdown, GFM tables, sanitized structural HTML, Mermaid source, images, attachments and external-reference metadata follow the core descriptors and the [sanitized HTML profile](../protocol/profiles/sanitized-html-v1.md).

All local images and attachments needed for review are frozen as content-addressed resources. HTTPS and mail references can remain actionable external references but MUST be marked as not archived. File, HTTP and unsupported schemes remain visible audit evidence and are not opened. No live reference is fetched during offline rendering or export.

Runtime JavaScript, Mermaid, fonts, Unicode data and PDF libraries MAY be bundled in the launcher. Runtime code is never copied into manifest, revision or event semantics.

## Participant and exporter experience

The optional [local companion transport](LOCAL-COMPANION-0.6.md) serves the same toolbox through a review-scoped native loopback host when browser directory grants are unavailable. It is an explicit deployment choice, not a browser-policy change or new evidence store. The native adapter must verify closed bytes and enforce the same event admission rules. Optional launcher binaries/notices are client artifacts, not executable review content or required core capabilities.

The rendering-only SVG sanitizer `omr-svg-static-2` may remove a single prolog `PUBLIC` declaration with the exact SVG 1.0 or 1.1 W3C public identifier and its allowlisted W3C DTD URL (HTTP or HTTPS). It MUST reject internal subsets, entity declarations, custom/SYSTEM DTDs, misplaced/duplicate declarations, active elements/attributes and external SVG resource references. It MUST remove the permitted declaration before XML parsing, never fetch a DTD, and preserve the original frozen blob/digest. Audited exports record the actual sanitizer version. This compatibility rule changes rendering, not authoritative source bytes or core event schemas.

The browser client implements core-reader and participant-writer roles only when its granted directory API can reread and verify closed bytes. Read-only grants provide inspection only. The client exposes all documents, anchored comments, replies, decisions, lifecycle state, suggestions, participant stances, implementation evidence, verification results, conflicts and history. It periodically rescans the folder; the polling cadence and visual notification style are client choices.

The profile requires an offline archival PDF exporter backed by an admitted `export.created` event and detached inventory. Clickable navigation, reviewer status and full findings/discussions precede the reviewed documents so readers do not need to search hundreds of pages for review evidence. The archive contains all frozen reviewed documents and renderable resources, comments, replies, decisions, implementation/verification evidence, stances and superseded history. It identifies missing or non-archived external references and does not fetch the network. Tables and images fit their containing printable area, supported local links resolve offline, and fonts cover emitted text or export reports unsupported glyphs without publishing a misleading artifact. PDF typography and pagination are not deterministic protocol state; the exact PDF bytes and actual renderer/font metadata are. These quality requirements belong to this client profile, not new core event fields or a second source of truth.

New reference packages require `reviewer-completion-v1`. Creation optionally accepts an immutable initial list of reviewer email addresses and declares `reviewer-roster-v1` and `reviewer-invitations-v1`. Only the initiator sees Add reviewers in either toolbox; the shared writer and reader also reject reviewer-authored invitations. Additions are independent `reviewer.invited` files, not manifest changes. A reviewer enters a matching email, which the client maps to its stable ID and, for additions, its explicit invitation dependency, and may finish or reopen only their own review of the pinned revision. Both clients show the entire effective reviewer list, including not-started reviewers, finish/reopen times and conflicts. Invitations refresh across open clients, survive reconnect and do not alter approval policy or existing completion. Adding someone does not grant folder access or send an email; the UI explains the separate OneDrive/shared-folder step. Capability-absent packages cannot be silently upgraded. Finishing locks participant feedback until reopened; initiator finding-processing and invitation controls remain available. Approval/rejection controls and completion remain independent. The PDF contains the effective roster, current completion status, full transition history and all initiator invitation records at the export cutoff. Browser autofill is a hint, not identity verification; stored identity preferences remain private per review and disposable.

## Creation

The reference VS Code and CLI authoring clients install the bound launcher only after publishing and verifying the core manifest and first revision. Failure to install the launcher is reported as incomplete product creation without rolling back or disguising already published core evidence. An explicit trusted-client update retains the replaced launcher in `client-backups/`; that backup is not review evidence.

## Security boundary

The launcher does not inherit Windows identity. Protocol 0.6 uses `self-asserted-v1`; filesystem ACLs control folder access while actor IDs provide deterministic workflow identity only. Authenticated creator privileges require a future signed-identity profile. The client MUST display this limitation wherever identity or creator-only controls could otherwise be mistaken for authentication.
