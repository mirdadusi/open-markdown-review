# Open protocol standardization boundary

This document records what the Open Markdown Review standard must specify so that independently implemented file-based clients can interoperate. It is the design contract for the next protocol revision. [`README.md`](README.md) remains the normative protocol 0.4 specification until the wire-format changes below have schemas, fixtures, and two independent implementations.

Update, 2026-09-08: the [professional client specification](../spec/PROFESSIONAL-V1.md), [0.5 implementation draft](../spec/PROTOCOL-0.5.md), and [acceptance/work-package plan](../spec/ACCEPTANCE.md) turn this earlier design boundary into the concrete next-pilot contract. Those documents take precedence for next-pilot scope and detailed behavior. This document remains the broader roadmap; signed identity, automatic transport, and migration are future profiles rather than mandatory 0.5 pilot features. HTML is the generic full reviewer interface to the same package; source authoring is one service exposed by VS Code and CLI.

The standard is deliberately about files and deterministic state, not VS Code, a browser brand, SMB, Git, or a hosted service.

## Product invariants

Every protocol version MUST preserve these invariants:

1. A selected review-package directory is the only authoritative review record.
2. VS Code, a browser client, a command-line tool, and a future client read and write the same package; no client owns a private canonical database.
3. Published revisions and actions are immutable. Concurrent writers normally create different files.
4. State is a deterministic function of the same admitted file set, independent of enumeration and arrival order.
5. An exact reviewed revision remains reproducible after source files, remote images, and external sites change or disappear.
6. Local caches are disposable projections and never participate in synchronization or audit authority.
7. The protocol requires no review server. Filesystem access control, synchronization, Git transport, and optional organizational identity binding are external mechanisms.

## Authority model

The standard MUST distinguish these authorities explicitly:

| Information | Authority | Required behavior |
| --- | --- | --- |
| Editable Markdown | Source workspace | Used to create a later revision and, when available, apply an accepted suggestion. |
| Reviewed Markdown and required resources | Frozen revision blobs | Used for rendering, anchors, approval, rejection, and export. Live source MUST NOT substitute for missing frozen bytes. |
| Comments, replies, lifecycle assertions, approvals, and rejections | Admitted immutable event files | Folded identically by every client. |
| Audit artifact | Export bytes plus its detached event/inventory | Verified by exact digest before being described as audited. |
| Client registration, active-review choice, UI state, and cache | Client-local storage | MUST NOT change shared semantic state and MAY be deleted without information loss. |

Freezing a revision is audit evidence, not a second client-owned source of truth. Content-addressed storage MUST deduplicate identical Markdown, image, attachment, and rendered-diagram bytes across references and revisions.

## Required conformance roles

Conformance MUST be claimed by role rather than by product name:

- **Core reader**: validates a package and reconstructs deterministic state without writing.
- **Participant writer**: additionally publishes comments, replies, decisions, thread lifecycle actions, and revision approval/rejection.
- **Authoring writer**: additionally freezes source content, publishes revisions, and applies accepted suggestions to an explicitly selected source workspace.
- **Audit exporter**: additionally produces and verifies detached audit artifacts from frozen inputs.
- **Signed-profile verifier/writer**: additionally verifies or creates identity authorization and event proofs.

A client MAY implement several roles. A browser participant is not required to have the source workspace. A client MUST NOT claim a writer role when its filesystem API cannot satisfy that version's publication contract.

The 0.4.6 reference extension can optionally place a generic self-contained browser pilot at the package root. That HTML is explicitly non-authoritative and uses the same manifest, revision, blob, and event files. Its read/render path exercises the core-reader boundary; its event-write path uses absence preflight and exact post-write readback, but is not claimed as a conforming 0.4 participant writer because the browser folder API lacks atomic exclusive create. This concrete limitation is the reason for the next-version publication requirement below.

## Package and filesystem contract

The standard MUST define, independently of operating system APIs:

- explicit selection of a package root and the absence of a required physical folder name;
- safe relative-path syntax, root containment, link/junction escape prevention, Unicode handling, and collision behavior on case-insensitive filesystems;
- exact UTF-8 and digest rules, including line endings and byte-order marks;
- immutable directory purposes and which extra files readers ignore;
- minimum writer operations: create directory, read, enumerate, write and close, verify exact bytes, and publish without intentionally replacing different content;
- which files require exclusive-create, which are content-addressed and idempotent, and how a constrained writer proves successful publication;
- stable-read and retry behavior for a file observed while SMB or a sync provider is transferring it;
- prohibition on semantic use of modification times, enumeration order, advisory locks, or filesystem-owner metadata;
- bounded retry, I/O concurrency, file count, depth, individual file size, aggregate revision size, and attachment download limits;
- Git byte preservation and behavior on SMB/NFS/NAS or synchronized directories.

### Browser-safe publication requirement

Protocol 0.4 requires exclusive creation of `<event.id>.json`, which a normal browser directory handle may not be able to guarantee. The next writer profile MUST remove this hidden Node/filesystem dependency.

The candidate v0.5 event layout is content-addressed publication:

```text
events/<64-lowercase-sha256-of-exact-event-bytes>.json
```

The event keeps its logical `id`; the filename establishes byte integrity, not logical identity. A writer computes the complete bytes before opening the final name, refuses an existing different file, closes the write, reads the file back, and verifies its filename digest. A reader ignores an incomplete or digest-mismatched file, retries it as a synchronization gap, and never admits it into state. Two different events cannot silently replace one another under a valid digest name.

The manifest MUST declare its event layout so 0.4 ID-named packages remain readable. VS Code and browser clients MUST use the same declared layout for one package.

Revisions remain a publish-last transaction: blobs, descriptor, then the event that makes the revision visible. Exports remain bytes first and detached event last.

## Wire format and portable semantics

The standard MUST specify:

- JSON Schema version and the normative relationship between schema validation and cross-file validation;
- exact digest coverage and a canonicalization algorithm wherever a signature covers a JSON object rather than file bytes;
- collision-resistant IDs, their character set, uniqueness scope, and identity-collision quarantine;
- timestamp syntax and the fact that self-reported time is neither identity nor trusted causality;
- path separators, normalization, forbidden segments, reserved names, and comparison rules;
- zero-based positions, UTF-16 code-unit offsets, half-open ranges, and exact CR/LF/CRLF line interpretation;
- Markdown profile, raw-HTML policy, Unicode decoding failures, and renderer metadata;
- deterministic IDs for images, attachments, Mermaid diagrams, tables, and table cells;
- unknown-property and unknown-event handling so older readers preserve rather than reinterpret future data.

Protocol-internal filenames SHOULD remain portable ASCII. Source document paths MAY contain Unicode, but a revision MUST reject two document paths that alias on the selected source filesystem or collide after the protocol's defined normalization comparison.

## Versioning, capabilities, and extensions

The standard MUST separate:

- package-layout version;
- object schema version;
- optional semantic capability;
- client conformance role;
- security/identity profile.

Capabilities declare semantics present in a package; they are not user permissions. An immutable manifest creates a future-evolution problem, so the next version MUST define either a complete initial profile set or an append-only capability-adoption event with explicit predecessor and conflict rules.

Third-party extensions MUST use a collision-resistant namespace, publish a stable schema identifier and digest, declare whether they affect core state, and define downgrade behavior. An unknown extension MUST NOT silently change approval, resolution, or audit conclusions in a core-only reader.

## Revision model

The standard MUST define:

- exact selected document inventory and root-document ordering;
- content-addressed Markdown/resources and byte verification;
- resolution and capture of relative, data, HTTPS, file, and mounted-share references;
- which resources are mandatory frozen evidence and which remain recorded external links;
- redirects, credentials, URL redaction, MIME validation, active-content rejection, timeout, and byte limits;
- Markdown, Mermaid, GFM-table, image, and attachment rendering requirements;
- revision diagnostics and which severities block publication;
- revision ancestry and branch handling.

Protocol 0.4 chooses a display revision by untrusted timestamp. The next version MUST instead include parent revision IDs. A package with one graph head has an unambiguous current revision; concurrent heads are an explicit branch conflict until an author publishes a merge/superseding revision. Clock order MAY remain presentation metadata but MUST NOT choose a semantic winner.

## Anchors

Every anchored action MUST bind to an exact revision, document path, frozen document digest, source range, and quote selector. The standard MUST define:

- source-range interpretation for all line-ending forms;
- exact quote, prefix, and suffix extraction;
- deterministic recovery and tie breaking;
- orphan behavior without silent relocation;
- semantic targets for text, images, Mermaid, tables, and cells;
- validation against the referenced frozen revision;
- rendered-content-to-source mapping expected of a participant client.

Applying an accepted suggestion to live source is an authoring operation, never an implicit consequence of accepting it.

## Events, object identity, and lifecycle

For every event family, the standard MUST specify required capabilities, root identity, valid children, causal references, conflict rules, and derived status. At minimum it must cover:

- revision publication;
- root comments and nested/flat replies;
- resolution and reopening;
- comment decisions including accepted, rejected, won't-fix, and duplicate;
- suggested insert, replace, and delete operations and their accept/reject/apply lifecycle;
- revision approval, rejection, and optional withdrawal;
- audit export publication;
- identity registration, authorization, key rotation, and revocation in a signed profile;
- review closure or archival if introduced.

Last-write-wins based on timestamp or file arrival is forbidden for semantic conflicts. A lifecycle that can move more than once MUST carry an explicit predecessor event ID. Competing children of the same predecessor form a visible branch conflict. This rule is required for deterministic thread reopening and withdrawal without trusting clocks.

Published comment text is not edited in place. A future correction/redaction mechanism MUST retain the original digest and make its legal/security limitations explicit; it cannot promise erasure from already synchronized copies.

## Synchronization and consistency

The consistency model is an eventually observed union of immutable valid files. The standard MUST define:

- deterministic admission and fold independent of file arrival;
- dangling children and retry behavior;
- identity collisions and competing-root quarantine;
- mutation, disappearance, rollback, and partial-transfer detection;
- last-known-good behavior;
- polling and notification semantics without promising delivery latency;
- offline writes and later union merge;
- no automatic Git fetch, pull, merge, commit, or push unless a client explicitly provides that separate feature.

“Live” means that a client notices files after they become visible through its selected filesystem. It does not mean server push. Background-browser throttling and provider latency are presentation concerns and MUST NOT alter semantic state.

## Identity, authentication, and authorization

The base protocol MUST label actor assurance truthfully:

- **self-asserted**: an actor typed a name or reused a local random ID;
- **key-authenticated**: the event proves possession of an authorized local private key;
- **externally bound**: a separate, named profile binds that key to an organizational identity.

Windows/SMB access control establishes who may access a directory but is not an event identity assertion. Browser JavaScript does not portably inherit the Windows account, and a client MUST NOT claim that it did. Filesystem owner, creator, or ACL metadata is non-portable and MUST NOT be part of the deterministic fold.

A no-server signed profile SHOULD use:

- RFC 8785 JSON Canonicalization Scheme over the event with `proof` omitted;
- Ed25519 signatures encoded as unpadded base64url;
- public keys as Ed25519 JWK objects;
- `keyId = "key_" + first24(SHA-256(canonical-public-JWK))`;
- immutable registration, owner authorization, role grant, key rotation, and revocation events;
- a manifest trust anchor or a separately distributed package fingerprint;
- deterministic handling of missing, invalid, revoked, and unauthorized proofs.

Possession of a signing key authenticates the key, not automatically a legal person. Trust-on-first-use and owner approval MUST be distinguished from an externally verified identity. A new client cannot detect total package replacement or rollback without a trusted fingerprint/checkpoint held outside the package; the standard MUST state this limitation.

## Review policy and decisions

Approval and rejection events are individual assertions. Whether a review is organizationally complete requires a versioned policy snapshot that defines, at minimum:

- eligible roles or actor IDs;
- required approval count and whether distinct actors are required;
- effect of any rejection;
- required resolution/decision state for comments and suggestions;
- whether unsigned or self-asserted actors count;
- which exact revision and policy digest the result covers.

Without such a policy, clients MUST display assertions but MUST NOT claim organization-wide approval. A future policy change MUST be append-only, revision-scoped, and conflict-visible.

## Audit evidence

A professional export MUST be independently verifiable. The next audit inventory MUST contain:

- manifest exact-byte digest;
- revision descriptor digest and every document/resource digest;
- every included event ID and exact event-file digest;
- omitted, invalid, dangling, conflicting, or unsupported event inventory;
- renderer implementation identifier and version without constraining it to VS Code;
- Markdown, Mermaid, PDF, font, sanitization, and schema versions;
- generated artifact path, media type, byte length, and digest;
- signed-proof verification results and policy conclusion when those profiles are used.

The human-readable PDF and machine-readable inventory SHOULD be separate artifacts covered by the same detached publication event. Export MUST use frozen bytes, not live source or live URLs.

## Security, privacy, and operational limits

The standard MUST define a threat model covering malicious Markdown, Mermaid, SVG, attachments, event floods, decompression/resource bombs, path traversal, link/junction escape, secret-bearing URLs, signature/key compromise, package rollback, and untrusted client metadata.

It MUST distinguish integrity/authorship from confidentiality. The base package is not encrypted; disk/SMB ACLs or an explicit future encryption profile provide confidentiality. Signatures do not prevent a storage administrator from deleting files, and append-only semantics do not guarantee secure erasure.

Implementations MUST use bounded parsing, rendering, downloads, filesystem concurrency, retries, cache size, and export resources. The standard SHOULD publish conservative interoperability defaults while allowing clients to enforce stricter local limits and report them.

## Client packaging is outside the wire protocol

The same protocol may be implemented by a VS Code extension, a native application, a CLI, or a single bundled HTML client. The protocol MUST NOT depend on any of those packaging forms.

A double-clicked `file://` HTML client is conforming as a writer only if its browser grants a stable read/write directory handle and it satisfies the publication and verification contract. If the browser grants read-only uploads or downloads files elsewhere, that client can be a core reader but not a participant writer. The standard cannot override the browser sandbox.

The HTML application code MUST NOT embed a mutable copy of review state. It opens the authoritative package selected by the user. Any in-memory or browser storage cache is a disposable projection.

## Standardization roadmap and next-pilot scope

The following roadmap gaps require schemas, types, fixtures, fold algorithms, and tests in their respective implementing profiles. The [0.5 draft](../spec/PROTOCOL-0.5.md) specifies the subset required for the professional pilot; optional signed identity and extension evolution must not be mistaken for implemented or mandatory pilot capabilities:

| Change | Reason |
| --- | --- |
| Manifest-declared event filename/layout profile | Permit integrity-verifiable publication by constrained browser writers while retaining 0.4 readability. |
| Revision parent IDs and graph-head rules | Remove clock-based semantic “latest revision” selection. |
| Generic exporter implementation identifier | Permit browser and independent audit exporters. This backward-compatible correction is also applied to the 0.4 schema. |
| Exact event digests in audit inventories | Make PDF evidence independently reproducible and verifiable. |
| Explicit actor assurance and optional signed-event proof | Distinguish typed names from authenticated keys. |
| Identity authorization/revocation events and trust bootstrap | Make no-server authenticated participation deterministic. |
| Causal lifecycle transitions | Support reopening/withdrawal without last-write-wins. |
| Review-policy descriptor and revision binding | Separate individual assertions from a defensible approval conclusion. |
| Portable Unicode/path-collision rules | Prevent Windows/macOS/Linux clients from referring to different physical files. |
| Extension namespace and schema-digest rules | Allow open evolution without silent semantic downgrade. |
| Machine-readable audit inventory artifact | Verify all exact inputs, conflicts, omissions, tools, and outputs. |
| Normative resource and parser limits | Prevent incompatible or unsafe implementations from accepting radically different packages. |

## Exit criteria for a new protocol version

Protocol 0.5 MUST NOT be labeled final until:

1. JSON Schemas, TypeScript types, independent runtime validation, and normative prose agree.
2. A checked-in fixture exercises every required feature and error condition.
3. Permutation and concurrent-publication tests prove deterministic state.
4. A VS Code client and an independently built browser/file client read the same package and produce equivalent state.
5. Each client observes the other's comments, replies, lifecycle actions, approvals/rejections, and export records.
6. Both verify exact frozen Markdown, images, Mermaid, tables, attachments, external-reference metadata, and audit inventories.
7. Windows local disk and a real mapped SMB share pass concurrent-writer, partial-transfer, permission-loss, reconnect, and performance tests.
8. The signed profile, if claimed, passes tamper, wrong-key, revoked-key, unknown-key, rollback-disclosure, and conflicting-authorization tests.
