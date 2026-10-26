# Public 0.6.5 build qualification

This report covers the public publisher identity and build inputs. It does not reuse private release receipts or infer native execution from cross-compilation. Raw fresh logs and exact VSIX qualification receipts are retained in the maintainer's build output; the hash-bound local Mac receipt is also inside both complete authoring VSIXs.

Final qualification was recorded on **26 October 2026**, after candidate commit `de6f5c7be5fec777561dcbc4909836ca840e794b`. Tag `v0.6.5` and the published VSIX bytes remain bound to that tested source. This post-qualification documentation update does not rebuild or replace the release artifacts.

## Checks

- Shared TypeScript/schema/protocol and packaging suite: 252 passed, one explicitly skipped case, zero failures (26 October 2026).
- Full application dependency audit, including packaging tools, and the isolated Slidev author fixture: zero reported vulnerabilities after the public-build dependency fixes. The formerly excepted fixture advisory was withdrawn upstream; the current fixture policy has no exceptions.
- Go 1.27.3 source and actual production-binary vulnerability scans on all three native qualification platforms: no reported vulnerabilities.
- Native Mac production browser/launcher/PDF and VS Code creation: passed, bound to the current catalog. The Mac receipt ships inside both authoring VSIXs.
- Actual VS Code webview, legacy Node and Go mixed-client participation, concurrent replies, initiator resolution, participant completion and both PDF profiles: passed. The independent export inspection verified eight review-PDF pages, native comment/reply annotations, image inclusion, Unicode markers and the absence of review data from the clean export.
- Reading/identity browser regressions: five passed, including narrow-layout panel separation at 640/390 pixels. Screenshots were captured from the real light-themed VS Code and Go browser clients using fictional content.
- Actual installed offline VSIX qualification passed on native Windows x64 and Linux x64, and locally on macOS ARM64. Each run installed the real package in an isolated VS Code profile, verified offline creation with all three delivered companions, and exercised native browser collaboration/PDF plus installed-extension creation/launch.
- Windows/Linux source builds reproduced the exact catalog-pinned native Go executables. Shared host security, test-only interrupted-write recovery, source/binary audits and native Go tests passed. A cross-build alone was not counted as execution.

## Exact released artifacts

| Package | SHA-256 |
| --- | --- |
| Portable, qualified on Linux x64 and macOS ARM64 | `6b4e1ed2b5cee444bdf23a1d7c886de018cd2a2c39614fbb71f2ce0f20e3ba98` |
| Windows x64, qualified on Windows x64 | `098d9ba833005b0a8464a6e72ebdcaad134e99ae7d5708981d142a7d101da6c9` |

Both packages carry the same three Go pins: Windows `eef6cce001e23e2d6a52dfcc57794c65cd22ae13f093b2d41ed62df604c23d21`, macOS `4fea6cc33436a006c45cc0e20d425b1b51b639ad7b5751ba8503b3288a75f8c9`, and Linux `ffb614a12d26ed6cf8fd07769c00dae9d444ed0222dee89805491b2d61817cf3`. The final verifier matched source commits, all four release-file checksums, both native installed-VSIX proof records, all companion pins and the local Mac proof before publication.

## Boundaries

Both portable and Windows x64 VSIX packages must contain the catalog-pinned Windows x64, Linux x64 and locally qualified macOS ARM64 Go companions, toolbox and required notices. No Node companion is delivered by default. Offline authoring checks disable networking and authentication processes and verify all three delivered executable hashes.

The public release contains only two complete VSIXs and their two checksum files. Companion build inputs, seeds and native executables are not separate final release assets or participant downloads.

Real SMB and multi-device synchronized-folder qualification, managed-endpoint approval, production signing/notarization and independent professional-pilot acceptance remain separate. See [implementation status](../../spec/IMPLEMENTATION-STATUS.md). Identity assertions by email are not authenticated identities, and folder permissions remain the actual write-access boundary.
