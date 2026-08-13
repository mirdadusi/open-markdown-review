# Security model

## Trust boundary

The review package folder's access control is the authority in protocol 0.4. Actor IDs are self-asserted and events are unsigned. Do not use the pilot as legal proof of identity without an external signing profile.

## Client protections

- Raw Markdown HTML is disabled.
- Mermaid runs locally with `securityLevel: strict`.
- The rendered review uses a restrictive VS Code webview content-security policy.
- JavaScript and executable attachment media types are rejected.
- Plain HTTP resource capture is disabled by default.
- Remote resources have a configurable per-file size limit and a 15-second timeout.
- URL user credentials are rejected; common secret query fields are redacted from shared metadata.
- Local paths are normalized and must remain within the workspace.
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

## Reporting

For a private deployment, report issues through the owning organization's security channel and include the extension version, protocol version, diagnostic message, and reproduction steps. Do not attach confidential reviewed documents unless explicitly requested through an approved secure channel.
