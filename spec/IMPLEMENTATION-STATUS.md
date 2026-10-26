# Implementation and qualification status — public 0.6.5

Application version and protocol version are independent. Public application 0.6.5 implements core protocol 0.6.0, with explicit compatibility paths for older packages. This is a standard release with documented limits, not blanket professional-pilot certification.

## Implemented reference workflow

- Shared strict byte/JSON/schema validation, immutable revision/resource capture, content-addressed event files and causal state reconstruction.
- One VS Code/browser toolbox with source-bound comments, replies, suggested edits, creator-controlled finding lifecycle and a published-fix/reviewer-verification workbench.
- Self-asserted email rosters, initiator-only later invitations, independent participant finish/reopen and approval/rejection/withdrawal state.
- Frozen Mermaid, images, tables, a closed sanitized HTML subset and an optional Slidev presentation profile.
- Review PDF archives with native comment annotations and participant progress, plus clean document-only export; exact-byte inventories and failure-safe publication.
- Lazy/bounded document rendering, continuous reading, explicit document/heading/finding navigation and non-jumping event refresh.
- Go companions bundled inside both authoring VSIX variants for Windows x64, Linux x64 and macOS ARM64. Creation verifies and copies selected platforms; no participant runtime installation or authoring-time download is needed.
- Explicit tooling upgrades with recoverable backups and preservation checks for all pre-existing manifest/event/revision/blob/export bytes.

The protocol core, portable-product profile, optional presentation profiles and runtime delivery metadata are separate contracts. A compiler, browser capability or executable target is not a core wire-format field.

## What verification establishes

The repository contains unit/security/conformance tests, real Chromium scenarios, isolated VS Code extension-host tests, native-companion tests and installed-VSIX offline creation checks. The delivered Go catalog binds binaries to the shared core, HTML and license inputs. The embedded Mac receipt records exact-binary local browser/launcher and VS Code creation checks.

Qualification must identify the actual source, artifact digest, operating system and test type. A package filename, successful cross-build, historical report, origin-private browser handle or simulated adapter is not native target qualification. Public distribution-specific evidence is recorded separately from historical implementation comparisons. Test counts are not a usability or security certificate.

No organization-specific CI configuration or private evidence links are published here. The same test commands can be run on appropriate native Windows/Linux hosts; local Mac execution does not close those platform gates. Release-channel authorization is separate from professional acceptance and does not convert pending gates into passes.

## Remaining acceptance boundaries

1. **Managed endpoints and executable trust.** Windows application controls, browser/loopback policies, macOS signing/notarization and Linux desktop configurations require environment-specific approval. Direct HTML still depends on actual writable-folder browser grants and restart/revocation behavior.
2. **Transport.** SMB, OneDrive/SharePoint/Syncthing multi-device delivery, real ACL/recovery behavior and reference-workload latency are not certified by local-disk tests. SMB remains excluded/untested, not passed. No transport functionality is advertised as a security-policy workaround.
3. **Identity.** Names/emails are self-asserted; event hashing is integrity addressing, not authentication or digital signing. Arbitrary folder writers can impersonate actors or replace a package. Provider access control remains necessary.
4. **Rendering and cancellation.** Mermaid calls have serialized rendering, size limits and caller cancellation/deadlines; a DOM-dependent library call already running on the UI thread is not forcibly terminated by a worker. Wide/complex PDFs and the full Unicode/accessibility corpus need visual and independent user-task review.
5. **Filesystem and source edits.** Path/link checks, staged replacement, exact-byte backups and same-intent recovery do not prove immunity to every adversarial parent-directory race or every platform's power-loss/ACL behavior. Source-application cancellation and all crash/fault boundaries remain incomplete.
6. **Independent conformance and performance.** Internal oracles and mixed-host tests are not an independently developed third-party protocol implementation. Full optional-extension, compatibility, percentile/memory and independently recorded user-task acceptance remain open.

See [mandatory acceptance requirements](ACCEPTANCE.md), [professional specification](PROFESSIONAL-V1.md), [security model](../SECURITY.md), and [release qualification record](../release-qualification.json). Existing review evidence must never be rewritten merely to claim a new client capability or qualification result.
