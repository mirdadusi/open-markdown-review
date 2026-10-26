# Public 0.6.5 build qualification

This report covers the public publisher identity and build inputs. It does not reuse private release receipts or infer native execution from cross-compilation. Raw fresh logs and exact VSIX qualification receipts are retained in the maintainer's build output; the hash-bound local Mac receipt is also inside both complete authoring VSIXs.

## Checks

- Shared TypeScript/schema/protocol and packaging suite: 252 passed, one explicitly skipped case, zero failures (26 October 2026).
- Full application dependency audit, including packaging tools, and the isolated Slidev author fixture: zero reported vulnerabilities after the public-build dependency fixes. The formerly excepted fixture advisory was withdrawn upstream; the current fixture policy has no exceptions.
- Go 1.27.3 source and actual Mac production binary vulnerability scans: no reported vulnerabilities.
- Native Mac production browser/launcher/PDF and VS Code creation: passed, bound to the current catalog. The Mac receipt ships inside both authoring VSIXs.
- Actual VS Code webview, legacy Node and Go mixed-client participation, concurrent replies, initiator resolution, participant completion and both PDF profiles: passed. The independent export inspection verified eight review-PDF pages, native comment/reply annotations, image inclusion, Unicode markers and the absence of review data from the clean export.
- Reading/identity browser regressions: five passed, including narrow-layout panel separation at 640/390 pixels. Screenshots were captured from the real light-themed VS Code and Go browser clients using fictional content.
- Actual installed offline VSIX qualification is required separately for final artifacts; unpacked-source execution is not an installation test.
- Native Windows/Linux execution of these public artifacts: pending; a cross-built binary is not native qualification.

## Boundaries

Both portable and Windows x64 VSIX packages must contain the catalog-pinned Windows x64, Linux x64 and locally qualified macOS ARM64 Go companions, toolbox and required notices. No Node companion is delivered by default. Offline authoring checks disable networking and authentication processes and verify all three delivered executable hashes.

The public release contains only two complete VSIXs and their two checksum files. Companion build inputs, seeds and native executables are not separate final release assets or participant downloads.

Real SMB and multi-device synchronized-folder qualification, managed-endpoint approval, production signing/notarization and independent professional-pilot acceptance remain separate. See [implementation status](../../spec/IMPLEMENTATION-STATUS.md). Identity assertions by email are not authenticated identities, and folder permissions remain the actual write-access boundary.
