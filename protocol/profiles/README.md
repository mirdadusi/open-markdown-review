# Optional presentation profiles, transport v1

Core Open Markdown Review 0.5 remains framework-neutral. It defines frozen documents/resources, exact source anchors, events, causal decisions and audit evidence. It does not define Slidev, Vue, themes, slide syntax or presentation layouts.

An independently versioned profile describes how a particular presentation format binds its source and frozen views to those existing core primitives. A client adapter interprets that profile. Rendering code and caches are never review authority.

## Normative file binding

The key words MUST, MUST NOT and SHOULD express conformance requirements.

1. A presentation review MUST advertise and require `presentation-profiles-v1` in its immutable manifest. A client that does not implement this capability MUST disable participation; it MUST NOT silently treat the package as ordinary Markdown.
2. Each profile MUST have a unique, versioned URI in `manifest.extensions[].id`. Its `schemaUri`, `schemaDigest` and `schemaBlobPath` identify exact locally stored schema bytes. URIs identify schemas; they are NOT instructions to download or execute anything. `affectsState` MUST be false for this presentation-only transport.
3. Each revision MUST retain exactly one JSON attachment resource whose `originalReference` equals the profile URI. This resource is the profile descriptor. Its `document` MUST be the revision root document. Its content-addressed blob contains profile data; no second mutable profile file exists.
4. Each revision MUST also retain the declared JSON schema as an attachment resource whose `originalReference` is the schema URI and whose blob path/digest match the declaration. Schema resources use the root document as owner.
5. All profile-referenced source, image and attachment evidence MUST be existing revision documents/resources. Resource identifiers are references, not paths to files outside the package. Missing blobs, unsupported schemas, ambiguous bindings and invalid ownership MUST prevent revision admission.
6. The descriptor, schema and every frozen view MUST use normal immutable content-addressed publication. Their resources MUST be included in verification and export inventories. The `revision.created` event is published last. A new view requires a new revision; replacing a PNG or profile in place is an integrity violation.
7. A manifest's profile declarations are immutable. Changing profile families requires another review. A client may retain ordinary Markdown-only behavior for a package that does not require this capability.

## State and interoperability

No profile-specific comment, reply, decision, stance or export event is introduced. Whole-view comments use existing image targets; exact wording comments use existing source range/quote targets. The profile defines the relationship between those targets and its presentation views.

A client MUST understand every required profile before accepting actions or issuing assertions/exports. An unsupported client may inspect raw evidence in a clearly labeled read-only tool, but MUST NOT claim presentation conformance. This implementation reports an unsupported-profile diagnostic and does not admit the revision.

Schema validation alone is insufficient: implementations also verify digests, ownership, exact ranges, identifiers, bounds and required evidence. A supplied schema is evidence, not executable validation code; this client uses bundled, precompiled validators for recognized schema digests.

## Implemented profile

- [Slidev static review v1](../../spec/SLIDEV-PROFILE-V1.md), with its [JSON schema](slidev/v1.schema.json).

The application release is 0.5.1. Core wire version remains 0.5.0; profile versioning is separate. Ordinary 0.5 packages retain their existing format and behavior.
