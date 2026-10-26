# Repository architecture and runtime boundaries

This is one product and one open file protocol, not three separately maintained
review systems. A review folder (`manifest.json`, immutable revisions, blobs and
independent event files) is the only shared source of truth. Client caches,
identity preferences, private recovery journals and executable build receipts
are not review evidence and do not grant identity or role authority.

## Maintained layout

| Location | Responsibility | Must not contain |
| --- | --- | --- |
| `protocol/`, `spec/` | Versioned JSON schemas, normative file/event/role/anchor/export semantics, interoperability fixtures | OS builds, ports, Goja/Node requirements |
| `src/professional/` | Shared TypeScript reference core: strict bytes/JSON, validation, reducer, session, publication, rendering, PDF and profiles | A second copy of protocol rules for each host |
| `src/professional/companionRpc.ts` | Host-neutral companion request validation, authorization, exact evidence publication and private identity handling | HTTP, filesystem or Node imports |
| `src/extension.ts`, `src/professional/extensionHost.ts`, `src/webview/` | VS Code registration, source-authoring workflow, selection handover, sidebar and editor bridge | Go subprocess as a prerequisite for authoring |
| `src/professional/toolbox.ts`, `media/professional-shell.html` | The single browser/VS Code review UI and PDF renderer | A separate Go HTML UI or duplicate evidence store |
| `src/professional/goCompanion.ts`, `companionLauncher.ts` | Installed hash-pinned Go process lifecycle for VS Code and author CLI | Executing a received review's binary or silent runtime fallback |
| `src/professional/companion.ts`, `companionCli.ts`, `nativeStorage.ts`, `legacy/node/` | Retained legacy Node host and shared native authoring storage adapter | Alternative role/event rules or default participant delivery |
| `clients/companion-go/` | Go loopback/CLI host, rooted native filesystem, VM/timers, byte bridge and native tests | A Go port of the reducer/validator or review-supplied JavaScript |
| `scripts/` | Reproducible build, packaging, verification, benchmarks and qualification orchestration | Participant runtime downloads or author credentials in output |
| `test/` | Shared security/conformance assertions, actual browser/VS Code and mixed-client E2E | Relaxed expectations for a particular host |
| `companions/` | Pinned Go delivery catalog, runtime discriminator and exact-input build receipts | A Node or test-only executable substituted for Go |
| `dist/legacy-node/{target}/`, `dist/companion-go/{target}/` | Explicit legacy Node / default Go build outputs, checksums and receipts | Hand-edited source or claims that cross-building is qualification |
| `output/companion-comparison/{target}/`, `output/interoperability/{target}/` | Ignored measured evidence, logs and screenshots | Capability URLs or real company review content |

The root extension manifest and existing TypeScript source paths deliberately
stay compatible. Splitting every component into independent npm packages would
add dependency/version churn without making the wire protocol more open. If
independent package publication becomes useful, move the core behind public
exports in a separately reviewed migration; do not copy it into client folders.

## Execution model

VS Code uses its native bridge; direct-file HTML uses granted browser filesystem
access. The Node and Go companions each serve the *same trusted bundled HTML*
through an ephemeral `127.0.0.1` origin. Each participant runs their own helper
and accesses the same folder. Neither host is a central server or sync engine.
Polling discovers independently appended events; the storage provider transports
files. No local capability token or remembered identity belongs in the folder.

Both hosts import `createCompanionRpc`; Go embeds its neutral esbuild output in
Goja. No source-text extraction or separate Go protocol implementation remains.
The Go filesystem boundary uses `os.Root`, bounded byte reads, independent host
journals and exact-prefix recovery. File bytes cross into the VM as ArrayBuffer
views; only the browser RPC uses base64. The VM is serialized, with actual timer
jobs executed on its owning thread. An execution deadline makes an unresponsive
VM fail, rather than granting new operations indefinitely.

The Go validation bundle substitutes the standard native SHA-256 primitive, not
digest naming, canonicalization or admission rules. Its validation-only
markdown-it dependency omits automatic linkifying, which the shared profile
already disables; any attempt to use it fails closed. Explicit Markdown/HTML
links, references, tables and Mermaid still use the same parser. The browser
toolbox is unchanged. Native response JSON encoding happens only after trusted
results are exported under the VM lock. Untrusted input retains the shared
strict scanner. Journals keep binary bytes in memory and explicit existing
base64/array formats at disk and legacy VS Code boundaries. See the
[public build qualification](docs/qualification/PUBLIC-0.6.5.md) and the reproducible benchmark commands in the Go client guide.

Goja's raw JSON decoder replaces lone surrogate escapes. The shared strict JSON
scanner validates the **original code units before decoding**; all participant
requests and review evidence pass that boundary. Valid Unicode and invalid-input
cases are tested in Node, Go and browsers. This is protocol conformance, not a
claim that Goja implements every ECMAScript edge case identically to V8.

## Go default, legacy retention and release qualification

Public version 0.6.5 uses Go as the native companion on all three
supported participant platforms. VS Code authoring and native review remain
TypeScript; only opening its external browser starts the installed Go host.
The old Node host remains explicitly buildable under legacy commands and is
used as an interoperability reference. There is no automatic Node fallback.
Earlier published public artifacts are not replaced. Release qualification still requires
target-native security, mixed-client participation/export and packaging evidence.

Build outputs distinguish `StartReview`/`StartReview.exe` from `StartReview.test`
(`.test.exe` on Windows). Only the test variant accepts a fault-injection flag;
the distribution build rejects it. Test binaries never enter authoring VSIXs,
review folders or release assets. The candidate workflow uploads them as plainly
labelled CI test evidence only, not a product release.

Application and protocol versions remain independent. A new host does not change
the file protocol or invalidate existing review evidence. Runtime target/digest/
license/build/qualification records belong to delivery metadata, not the manifest.
The version-2 distribution catalog explicitly requires runtime `go` and checks
the neutral shared-core, toolbox, notices and native binary digests. All authoring
VSIXs contain all three offline binaries and the exact locally qualified Mac
receipt. Go-only delivery metadata is not a new protocol capability. An explicit
tooling upgrade backs up old launchers/HTML and verifies preservation of every
pre-existing evidence file; concurrent new peer publications are not an error.

CI executes Windows x64 and Linux x64 on native runners; macOS ARM64 qualification
is local. Cross-compiled Mac artifacts in Linux/Windows jobs are not accepted as
Mac execution evidence. SMB provisioning remains excluded by the user's decision;
local-filesystem tests do not establish real OneDrive/SMB synchronization latency,
managed execution-policy approval, signing/notarization or all filesystem races.
