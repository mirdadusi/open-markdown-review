# Companion-enabled review creation (0.6)

The VS Code creation form offers Windows x64, macOS Apple Silicon and Linux x64 checkboxes under Participant access. Leave them empty for HTML/VS Code only. Multiple platforms can coexist in one package. This is client deployment, not a protocol extension or a separate review database.

The creator needs no Go compiler or target-platform machine. The client resolves prebuilt distributions before publishing review evidence. It first checks matching build-tree files, then its private checksum-addressed cache, then downloads the exact release assets pinned by the catalog shipped with the installed extension. A first uncached download requires connectivity; later creation can use the verified cache offline. Downloads are streamed, cancellable, bounded and checked by exact length and SHA-256. HTTPS redirects are restricted to the release provider and its asset CDN. Received review folders cannot supply executable code or a replacement catalog to this resolver.

An explicitly selected platform that is unavailable, altered, unsupported or stale stops creation before a manifest/revision/event is published. Dry run never downloads or installs companions. Once core publication has completed, a delivery error is reported as a valid review with incomplete client delivery; resume the same operation instead of recreating or deleting evidence. Existing unexpected or changed client files are not overwritten. A manually altered/partial final executable fails closed rather than being silently repaired.

## Generated files

Each selected platform contributes its executable and matching `.sha256`, `.build.json` and `.NOTICES.txt` files:

| Target | Executable |
| --- | --- |
| Windows x64 | `StartReview-windows-x64.exe` |
| macOS Apple Silicon | `StartReview-macos-arm64` |
| Linux x64 | `StartReview-linux-x64` |

`START-HERE.txt` describes the selected clients and their boundaries. Executables sit beside `manifest.json`, so their default review is their containing folder. They are generic versioned clients, not compiled per review. No source content, reviewer identity or recovery journal is embedded into them. The review-named HTML and VS Code still open the same evidence. Copying/removing a dedicated review recognizes the optional files without executing them.

Reviewers first hydrate the complete synchronized folder. Windows users double-click the approved executable; macOS/Linux users can run the corresponding executable (Finder/file-manager behavior and OS execution permissions differ). Keep it running until saves finish. The default browser opens a private loopback session without a directory picker. Company application/localhost policies still apply; never disable security controls. Signing status is recorded honestly, and a checksum beside an executable is not publisher authentication. Email identity is still self-asserted.

Linux builds target glibc-based x64 desktop environments; this is not an Alpine/musl, ARM, headless-desktop, or every-distribution compatibility claim. Automatic browser opening requires an available default-browser opener. Windows ARM64 and Intel Macs are not offered by this creation form.

## CLI parity

```sh
node dist/cli.js review create --source /absolute/docs --store /absolute/review \
  --root-document index.md --actor-id creator@example.com --operation-id creation-001 \
  --companion-target win32-x64 --companion-target darwin-arm64 --companion-target linux-x64
```

The optional `--companion-catalog /absolute/trusted/catalog.json` explicitly trusts another local catalog for development/offline distribution. It must match the bundled toolbox and companion code. Do not use a catalog supplied by an untrusted review or workspace.

## Distribution and qualification

Build with the exact pinned Node version recorded in the receipts (currently 22.23.1):

```sh
npm ci
npm run compile
node scripts/package-companion.mjs win32-x64
node scripts/package-companion.mjs linux-x64
node scripts/package-companion.mjs darwin-arm64
node scripts/companion-catalog.mjs generate
npm run verify:companions
node scripts/test-native-companion.mjs
node scripts/test-native-companion.mjs extension
```

macOS packaging/signing and execution are local on a Mac. Windows/Linux execution belongs in the deployment repository's CI; cross-building on the Mac alone is not execution qualification. The native tests create a review with the selected platform, run its delivered executable from outside the source project, deny browser directory picking, exercise independent participants, comments/replies, lifecycle, completion, PDF publication/download, and stop the helpers. The VS Code suite also drives the creation form's platform selection and verifies active-review registration.

`companions/catalog.json` pins all three distributions. The VSIX contains this small catalog, not hundreds of megabytes of executables. `dist/companion-release/` contains upload-ready artifacts and checksums. Publish those exact assets together with the client version before distributing the extension to uncached authors. Before 0.6 is published, development checkouts use their verified local build artifacts; release URLs intentionally do not point at an unapproved build. Rebuild/re-pin after companion/toolbox changes. Never silently replace bytes under an already published version/hash. Signing changes executable hashes, so final signed artifacts require a newly generated catalog and subsequent qualification.

Ordinary builds verify the committed PDF font asset against source font hashes, decoded bytes and metrics; they do not recompress it. gzip headers contain an OS marker, so regenerating during every build would produce different toolbox/executable hashes across macOS, Linux and Windows. Use `node scripts/build-pdf-fonts.mjs --generate` only for an intentional, reviewed font update, then rebuild all client distributions and regenerate the catalog. Common PDF code imports only the client version, never publisher/repository metadata.

SEA packaging uses a fixed relative main filename and one versioned payload containing the toolbox and notices. This avoids embedding a developer/CI checkout path or depending on the host C++ asset-map ordering. A regression test compares preparation blobs from independent staging directories; CI still verifies each final executable against its release pin before execution.

CI success does not grant professional-pilot or publication approval. Native Windows signing/endpoint behavior, macOS notarization, performance budgets, fault qualification and the other recorded release gates remain explicit. SMB qualification remains excluded and untested.
