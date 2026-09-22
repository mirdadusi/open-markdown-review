# Security model

The 0.5 candidate shares validation, rendering and audit code between hosts, verifies exact bytes, precompiles schemas and inventories bundled dependencies. This is not a completed assurance result. See [implementation status and concrete remaining blockers](spec/IMPLEMENTATION-STATUS.md) and [acceptance gates](spec/ACCEPTANCE.md).

## Trust boundary

Filesystem/provider access control governs who can read or alter the package. Actor IDs are self-asserted and events are unsigned in both 0.4 and 0.5. A verified digest is not authentication, a signature, or protection against a writer deliberately replacing a whole package. Do not use this base profile as proof of identity.

## Client protections

- Undeclared raw Markdown HTML is inert. New reviews may require the closed [`sanitized-html-v1`](protocol/profiles/sanitized-html-v1.md) subset: tags are reconstructed from an allowlist; source scripts, styles, handlers, forms, frames, media/embed elements, raw SVG/MathML, unsafe schemes and non-allowlisted attributes cannot execute. Images and attachments resolve only to verified frozen resources.
- Mermaid runs locally with `securityLevel: strict`.
- The rendered review uses a restrictive VS Code webview content-security policy.
- The portable HTML client blocks network connections and arbitrary external scripts. Its fixed bundled script is authorized by a build-time CSP hash. JSON Schema validators are precompiled; `unsafe-eval` is not used. The client never fetches code or schema URLs supplied by a review.
- The portable client receives filesystem access only after a visible browser folder-picker grant. It remembers only the granted directory handle in browser-local IndexedDB, keyed by the HTML file URL. It does not infer Windows identity, traverse above the granted package handle, or embed review state.
- JavaScript and executable attachment media types are rejected.
- Plain HTTP resource capture is disabled by default.
- Remote resources have a configurable per-file size limit and a 15-second timeout.
- URL user credentials are rejected; common secret query fields are redacted from shared metadata.
- Local resources must remain inside the source root or explicitly granted additional roots. Package paths use a shared portable-path and Unicode-alias policy. Native operations reject links/junctions below the chosen root and recheck containment; the remaining adversarial path-swap race is documented, not claimed eliminated.
- Frozen bytes, revision descriptors, PDFs, and rendered diagrams are SHA-256 identified.
- Revision creation and PDF export fail closed when required content is missing.

## Operational guidance

- Use local filesystem, Git, mounted-share, or optional synchronization-provider permissions to restrict review membership.
- Avoid signed URLs containing sensitive query parameters; prefer local attachments or access-controlled shared files.
- Treat SVG, PDF, and office attachments as untrusted when opening them in external applications.
- Investigate any integrity warning before approving or exporting.
- Treat conflicting comment or suggested-edit decisions as unresolved governance; do not apply a conflicted suggestion.
- Suggested edits modify source only after explicit acceptance and an explicit apply action. Keep source control or backups enabled during the pilot.
- Keep VS Code, this extension, and the sync client updated.
- Distribute the generated portable HTML with the review package from a trusted extension build. It is replaceable executable client software, not signed audit evidence.
- Protocol 0.5 uses content-addressed event publication. The browser checks the target, writes/closes through its granted handle and verifies exact bytes; it does not claim OS-level exclusive creation. Matching concurrent bytes share one immutable target. Foreign/changed targets fail closed; only journal-owned partial bytes may be resumed.
- Mermaid rendering still lacks the specified hard interruptible deadline. Source application stages and verifies a separate file before directory-entry replacement, retaining original bytes in its private recovery plan. Source control/backups remain necessary: adversarial path/editor races and local Windows replacement, ACL and power-loss behavior are not qualified. These remain professional-pilot blockers.
- SMB qualification is excluded by user decision because an authorized CI share is unavailable. Shared-drive publication, permissions, ACL/recovery and performance remain untested; this exclusion is not security assurance or a waiver of local Windows requirements. See the [scoped acceptance exclusion](spec/ACCEPTANCE.md#smb-qualification-exclusion).

## Reporting

Report non-sensitive defects through the [public issue tracker](https://github.com/mirdadusi/open-markdown-review/issues). Include the extension version, protocol version, diagnostic message, storage type, operating system, and the smallest safe reproduction steps.

Report a suspected vulnerability through a [private GitHub security advisory](https://github.com/mirdadusi/open-markdown-review/security/advisories/new). If private reporting is unavailable, open a minimal issue requesting a private contact channel and do not disclose exploit details. Never attach confidential review packages, credentials, signed URLs, internal documents, or personal data to a public report.
