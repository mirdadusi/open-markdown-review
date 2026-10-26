# Clients and shared implementation

- **VS Code authoring and participation:** `src/extension.ts`,
  `src/professional/extensionHost.ts`, `src/webview/` and the shared toolbox.
- **One HTML review UI:** `src/professional/toolbox.ts` and
  `media/professional-shell.html`; used inside VS Code, directly from a file with
  a browser folder grant, or through either local companion.
- **Node companion:** `src/professional/companion.ts`, `companionCli.ts` and
  `nativeStorage.ts`. Current production runtime and comparison baseline.
- **[Go companion](companion-go/README.md):** native host with embedded Goja;
  candidate builds for Windows x64, Linux x64 and locally qualified macOS ARM64.

Protocol schemas/specifications remain in `protocol/` and `spec/`. Review rules
and companion publication authorization remain shared in `src/professional/`.
There is no duplicate Go HTML or second mutable review database.

The root manifest and source paths are retained for extension/build compatibility;
the Go implementation has an independently pinned Go module. See the complete
[repository architecture and migration policy](../ARCHITECTURE.md).
