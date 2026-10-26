# Go local companion — default native host in public 0.6.5

The Go host embeds the trusted shared browser toolbox and the existing TypeScript
protocol/RPC core in Goja. It does not require Node.js, Go, browser extensions,
application registration or a dedicated server on the reviewer's machine.
Organizational executable/loopback/browser policies still apply.

Implementation boundaries:

- `main.go`, `cli.go`: launch arguments, cryptographic randomness and safe
  argument-array default-browser opening on Windows, Linux and macOS.
- `server.go`: loopback-only HTTP, per-launch capability, exact Host/Origin,
  bounded admission/body/header sizes, embedding denial, timeouts and shutdown.
- `runtime.go`, `bridge.ts`: shared core integration, native ArrayBuffer transfer,
  serialized VM and real async retry timers. No textual source extraction.
- `sha256.ts`: the standard Go SHA-256 primitive behind the shared digest API.
  It does not replace canonicalization, content addressing or publication checks.
- `disabledLinkify.ts`: fail-closed omission of automatic linkifying in the
  validation-only bundle. The shared Markdown profile already disables it;
  explicit links and the rest of markdown-it are unchanged. The browser keeps
  its complete shared renderer.
- `storage.go`: rooted evidence access, no links, bounded reads, exclusive writes,
  exact-prefix recovery, sync and private journal replacement.
- `faults_*.go`: compile-time separation of test-only interrupted-write injection.
- `*_test.go`: host-specific tests; `../../test/companion*.ts` supplies the same
  protocol/security/browser assertions as Node.

## Build

Use the locked npm dependencies and **Go 1.27.3**, with CGO disabled for distributed
builds. `OMR_GO` may name an absolute Go executable. Go modules initially require
build-host network access; all are pinned by `go.mod`/`go.sum`. No module downloads
occur when the produced executable runs.

```sh
npm ci
npm run compile
npm run build:companion:go
# Or a subset:
node scripts/build-go-companion.mjs darwin-arm64
```

Targets: Windows x64, Linux x64 and macOS ARM64. The build embeds the same HTML,
neutral core, application/data/font/npm notices, actual Go module licenses and
Go toolchain license, and writes hashes and build receipts. Cross-building is
not target-platform qualification. Apple quarantine/notarization and Windows
application controls are not bypassed by this software.

```sh
cd clients/companion-go
go test -v ./...
go test -race ./...
go vet ./...
```

Rebuild the native Node reference from the same sources before comparison:

```sh
node scripts/package-legacy-node-companion.mjs
npm run test:companion:compare
node scripts/audit-go-companion.mjs
# Full actual VS Code UI + Node HTML + Go HTML, with PDF as final action:
OMR_GO_COMPANION=/absolute/path/to/dist/companion-go/darwin-arm64/StartReview \
  npm run test:clients:e2e
```

On Windows use `$env:OMR_GO_COMPANION` with the absolute `.exe` path. The test
opens only a disposable review with example.com identities and local evidence.
It does not touch an ongoing review. It activates the actual extension host,
drives the real Electron webview over a temporary loopback-only debug connection,
and launches both native companions. Debugging is test-only, never a product flag.

## Reviewer's launch

Use the **production distribution build**, never `.test`, next to `manifest.json`.
Double-click it to open the default browser, or use:

```sh
./StartReview --store /absolute/review/folder --no-open
```

Keep the helper running while reviewing. Stop from the browser toolbar or Ctrl+C.
On Windows its rooted directory handle prevents renaming/removing the review
folder while the companion is running; stop it before moving or deleting the
package. Where the OS permits live renaming, subsequent operations reject a
replaced review root. Per-file review-event synchronization remains independent.
`--help` and `--licenses` do not open a review. `--recovery-root` must be absolute
and outside the shared review. Local preferences are self-asserted identity, not
OS/Entra authentication. No protocol files need conversion when changing hosts.

## Evidence and limitations

Comparison logs and JSON go to `output/companion-comparison/{target}/`. Measurements
alternate seven native launches per implementation, warmups and exact-byte reads
at 64 KiB, 1 MiB and 8 MiB; they include base64/JSON/HTTP and SHA-256 verification.
RSS excludes the browser and is not peak memory. Seven startups are insufficient
for tail-latency certification. Network-share/OneDrive behavior is not measured.

The comparison also times actual 1 MiB publication with fsync/reread verification,
8 KiB anchored comment admission, and a 1 MiB private-journal round trip, using
independent copies of the same authored evidence and alternating native clients.
These are diagnostic measurements, not timing-based pass/fail thresholds.
Run benchmarks without concurrent builds/tests. See the
[public build qualification](../../docs/qualification/PUBLIC-0.6.5.md). Historical measurements from a different build are not qualification for these binaries.

For optional CPU/allocation stage profiling (no production profiling endpoints):

```sh
node scripts/profile-go-companion.mjs diagnostic
OMR_GO_PERF_FILTER=BenchmarkCompanionStages/validated-comment \
  node scripts/profile-go-companion.mjs comment-profile
node scripts/benchmark-companion-actions.mjs current
```

Profiling includes expensive legacy algorithms for comparison; those stages are
not active production paths. A pinned original control can be reproduced with
`scripts/build-go-performance-control.mjs COMMIT`, provided its original receipt
and embedded assets are retained. It refuses mismatched historical inputs.

Mixed-client evidence goes to `output/interoperability/{target}/`; an independently
verified final audit PDF goes to `output/pdf/`. A passing local run does not mark
Windows/Linux qualified. The default authoring catalog requires the Go production
build; Node is retained only under explicit legacy commands. Target-native CI
must pass before release publication. The qualification workflow itself never
tags, publishes a release or publishes Marketplace.

See [repository boundaries](../../ARCHITECTURE.md), [delivery and updates](../../docs/COMPANION-DELIVERY.md), and the dated performance reports above. Historical measurements are not current release qualification.
