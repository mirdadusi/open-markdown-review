# Offline companion delivery and release maintenance

## One extension update

Both public authoring VSIX variants include the HTML toolbox, shared protocol/RPC core and **all three Go companions** under `dist/bundled-companions/`. VS Code's native Marketplace update installs them together. There is no separate companion updater or participant download.

Review creation selects Windows x64, macOS ARM64 and/or Linux x64, verifies each bundled executable against `companions/catalog.json`, and copies only the selected launchers into the destination. It does not compile per review, contact GitHub, prompt for a token, or silently fall back to Node. Missing or changed installed bytes fail before publishing review evidence.

The review root receives the selected executables, review-bound HTML and `START-HERE.txt`; build receipts/checksum/notice sidecars are not added there. Third-party notices are embedded and available through `--licenses`. Required notices, receipts and exact local Mac qualification remain inside the trusted VSIX.

## Participant workflow

The launcher uses its containing folder by default, or an explicit absolute `--store`. It opens a short-lived local browser session. Each participant has a private process/capability/journal and accesses the same synchronized review; the helper is not a central review service.

```text
StartReview-windows-x64.exe
./StartReview-macos-arm64
./StartReview-linux-x64 --store /absolute/review/folder
```

Keep it running while reviewing and until saves/exports finish. Stop through the browser's Stop local companion button or Ctrl+C. The Go binary needs no installed Node.js, Go or VS Code on the participant machine. Executable permission, application controls, signing/notarization, a usable default browser and allowed loopback access remain prerequisites. No security controls are disabled.

## Existing reviews

Updating the extension does not silently update a shared folder. Stop old companions, open the review in VS Code and run **Markdown Review: Update Portable Browser Client**. Keep every existing participant platform selected, confirm the backed-up upgrade, let synchronization finish and relaunch.

The upgrade checks review identity and the expected tooling fingerprint; preflights all replacement bytes; backs up prior HTML/executables; stages and verifies files; and then atomically replaces individual directory entries. Known old companion sidecars are moved into recoverable backup directories. Pre-existing evidence files must retain their digest and length. New peer events may arrive normally and are not rolled back.

The operation does not create comments, revisions, approvals, invitations or completion events. It does not migrate capabilities in an older manifest. Multi-file replacement is not one filesystem transaction: interruption is reported with retained backups/staging, never as success. Stop and inspect a reported failure before launching that package again.

## Build-time provenance, not a second update channel

`release/update-source.json` binds the **extension** to its public Marketplace identity. `release/companion-source.json` identifies the public GitHub **build-input** source used by maintainer/development tooling. Installed `bundled-v1` delivery does not call the legacy network/cache resolver. Received review folders cannot supply a trusted catalog or substitute executable code.

From a matching published tag, stage the pinned clients from its complete portable VSIX:

```sh
npm ci
npm run compile
node scripts/download-companion-bundle.mjs
node scripts/companion-bundle.mjs verify
```

The build-input downloader verifies the whole VSIX/checksum, every bundled executable, license notice and Mac receipt against the committed catalog. It does not download standalone companion release assets. Public published inputs need no maintainer credential; reading a private draft seed does.

For an unreleased change, use the pinned **Go 1.27.3** compiler (or set `OMR_GO` to its absolute executable), rebuild all affected platforms, regenerate the catalog and execute the target-native qualification:

```sh
npm run compile
node scripts/build-go-companion.mjs
node scripts/companion-catalog.mjs generate
node scripts/companion-catalog.mjs verify
node scripts/test-native-companion.mjs
node scripts/test-native-companion.mjs extension
node scripts/audit-go-companion.mjs
```

Mac qualification is produced on macOS ARM64 with `node scripts/qualify-macos-companion.mjs`; stage its exact files with `node scripts/companion-bundle.mjs stage dist/companion-release`. The receipt binds successful native browser/launcher and VS Code creation suites to the binary/core/toolbox hashes. It is publisher-recorded evidence, not an independent attestation or notarization.

## Packaging and publication

```sh
npm run package:marketplace -- portable
npm run package:marketplace -- win32-x64
node scripts/test-offline-vsix.mjs /absolute/path/to/portable.vsix
```

Both final VSIX packages must retain all three production Go binaries and Unix execute permissions. Test-fault binaries and raw source build directories are excluded. Native Windows/Linux execution is separate from cross-building their files. Do not infer full platform or transport qualification from Mac tests.

Publish the exact same two verified VSIX files to GitHub and Marketplace, plus their checksum files on GitHub: **four final GitHub assets, no standalone companions**. A draft-only authoring seed, if used by a maintainer's qualification pipeline, is also a complete VSIX and must be removed before final publication. Never replace published bytes without an explicit, separately reviewed release-replacement decision; ordinary maintenance uses a new version.

`npm run package:companion:legacy` retains the Node host as a development/interoperability reference under `dist/legacy-node/`. It is neither bundled nor selected automatically. See [architecture](../ARCHITECTURE.md), [local companion transport](../spec/LOCAL-COMPANION-0.6.md) and [qualification limits](../spec/IMPLEMENTATION-STATUS.md).
