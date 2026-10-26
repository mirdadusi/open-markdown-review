# Local companion transport — 0.6.0

Status: optional implementation profile, 2026-10-16. This extends client deployment, not the Open Markdown Review Core event vocabulary, package identity or authority model. The [portable package profile](PORTABLE-REVIEW-PROFILE-0.6.md) and [core protocol](PROTOCOL-0.6.md) remain the evidence semantics.

## Purpose and user consent

A reviewer MAY explicitly run a native local companion when browser directory grants are unavailable. It serves the trusted toolbox and a narrowly scoped storage bridge from the same ephemeral loopback origin. A static HTTP server which still uses browser directory pickers does not implement this profile.

The standalone executable uses its containing directory when placed beside `manifest.json`, or an explicit absolute `--store` argument. A development Node launch defaults to the current directory. VS Code uses the explicitly selected registered review. Do not scan other folders or infer a source workspace. An invalid review fails without initializing or repairing a package. HTML cannot launch native code by itself: users must run an approved executable or choose the VS Code command.

One companion belongs to one OS user and one review. It MUST NOT bind a LAN interface, accept remote reviewers, or become a central review server. Each reviewer runs their own instance against accessible synchronized/mounted storage. Browser File System Access policy is not changed: native operations are a distinct application capability subject to OS permissions and endpoint controls.

## Single source of truth and interoperability

Manifest, revisions, blobs, content-addressed events and audit exports in the selected folder remain authoritative. No second Markdown tree or mutable comment database is introduced. HTTP is a transport, not an alternative protocol history. Cross-client exchange remains existing file synchronization/shared storage.

Documents, Mermaid, images, tables, sanitized HTML, external references, anchors, comments/replies/suggestions, participant stances and completion use the shared toolbox. PDF bytes, inventory and `export.created` use the shared exporter/publication rules. Do not fetch live resources. Authoring/revision publication, source writes and applying edits are absent from the participant HTTP API.

Clients MUST reread and verify closed publications before acknowledgement. The host MUST independently enforce schema, exact digest/name, revision binding, anchors, invitation dependencies, roles, lifecycle, receipts, causal prerequisites and immutable retries using the shared session. It MUST reject revision/source-authoring requests even when an HTTP caller bypasses the UI. Retain event/operation IDs on retry. Self-asserted participant IDs MUST NOT be presented as cryptographic authentication or verified Windows/Entra identity.

## Listener and HTTP security

- Bind IPv4 `127.0.0.1` only, on an OS-assigned port unless a trusted native caller explicitly supplies one. Reject unexpected Host headers and non-loopback peers. No arbitrary origin/domain aliases.
- Generate a cryptographically random 256-bit capability per launch. Deliver it only in the startup URL fragment; move it into tab session storage and remove it from the address bar when available. Never put it in query parameters, shared files, referrers, telemetry or HTTP access logs. Storage-denied browsers may retain the fragment; permissionless resume is not promised.
- Require exact same-origin POST, JSON content type and capability header on every RPC. Check Fetch Metadata when supplied, reject null/cross-site origins/preflights and do not enable wildcard CORS. This capability authorizes access to the local process, not reviewer identity.
- Serve only trusted application HTML, never executable HTML supplied by a review. Preserve script hashes/restrictive CSP and allow same-origin API connections only. Send `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, no-store and no-referrer. No HTTP directory listing or arbitrary file route.
- Expose allowlisted evidence paths/directories only. Reject absolute/traversal paths, links/junctions below the granted root, client programs, private journals and source files. Recheck root identity/immutable manifest before publication. Retain the existing native adapter's containment checks and limitations; do not claim stronger adversarial filesystem isolation.
- Bound bodies, request count, operation/path lengths, binary sizes and timeouts. Use canonical base64 rather than numeric JSON arrays. Serialize native mutations. Keep recovery/preferences private to the OS user, outside the shared package. A client-supplied acknowledgement flag is not proof that shared bytes exist.
- Enforce the shared strict JSON/UTF-8 rules before a host decoder can discard duplicate keys or replace unpaired UTF-16 escapes. Runtime substitution MUST NOT silently normalize malformed input into an accepted operation. The same negative encoding tests apply to each transport/runtime.

Host publication journals and browser recovery hints MUST be independent. Both are scoped to the immutable manifest fingerprint as well as the native review connection; reusing a retired filesystem path must not inherit another review's acknowledgements or identity. Only the host's original exact-intent record can authorize native partial-publication recovery. A disappeared acknowledged file fails closed; browser journal edits cannot authorize recreating it.

## Runtime-neutral conformance and evidence

The implementation language and embedded JavaScript engine are not wire protocol
features. A conforming client MUST preserve the original publication bytes and
apply the same admission, role, invitation, lifecycle and verification rules.
Sharing a reference core is an implementation choice, not a requirement that
third-party implementations use TypeScript, Node or Go.

Validation MUST inspect original JSON strings, including escaped keys and
surrogate code units, before a runtime decoder can replace or normalize them.
A passing rendering test is not byte/encoding conformance. Valid Unicode pairs,
escaped literal backslashes, duplicate/escaped duplicate keys, lone/high/low
surrogates, malformed UTF-8 and rejected-input non-mutation require explicit
negative and positive coverage on each host.

A native participant bridge, including the VS Code webview bridge, MUST verify
publication digests and independently authorize actions; trusting that a button
was hidden in the HTML is insufficient. Source authoring remains a separate
capability. Host-owned recovery acknowledgement records MUST NOT be writable
through participant journal operations.

Runtime qualification SHOULD include a mixed-client scenario: author a review,
share immutable scope and referenced resources, exchange anchored comments and
replies through different hosts, exercise creator-only decisions and participant
completion, restart clients, then export. The final archive MUST disclose its
cutoff and preserve the challenged topics, responses, states and participant
roster from that cutoff. Independent reconstruction, exact file digests, archive
content and offline navigation SHOULD be checked, not only a successful UI toast.

Cross-compilation does not establish target-native correctness. Evidence MUST
identify the executable and shared-code/toolbox digests, target, actual test
results, measurement workload and exclusions. Benchmarks MUST distinguish raw
disk operations from end-to-end RPC/encoding/hash verification and report memory
scope. Runtime migration MUST NOT weaken security/encoding assertions, silently
repair evidence or replace an already published release artifact.

## Lifecycle and deployment

Creation MAY select `win32-x64`, `darwin-arm64` and `linux-x64` client distributions independently of the creator's OS. The selected artifacts MUST match a trusted client-owned, versioned catalog binding the companion code, toolbox, exact executable length/digest, notices and build receipt. Resolve all selected artifacts before core publication; unavailable/altered clients must not leave a half-created core review. Downloads/cache and executable copies must be bounded and verified. Do not trust a review-supplied catalog or execute a received program automatically. Runtime selection is private authoring input/client delivery metadata, never mutable manifest state or a protocol capability.

An authoring distribution MAY bundle every supported participant platform for offline creation. When a client advertises this mode, missing/altered installed artifacts MUST fail preflight rather than silently requiring network access or credentials. Selected prebuilt clients are copied, not compiled per review. The authoring platform need not match participant platforms. Qualification evidence MUST identify the exact executed binary and host; cross-building alone does not establish target execution. New runtime/payload distributions require a new product release, not replacement of already published artifacts. These deployment choices do not add review evidence, change the wire version or establish reviewer identity. In the reference implementation, `bundled-v1` is private installed-catalog metadata, not a manifest field or mandatory vendor-neutral wire capability.

Platform-specific names (`StartReview-windows-x64.exe`, `StartReview-macos-arm64`, `StartReview-linux-x64`) and their `.sha256`, `.build.json` and `.NOTICES.txt` files MAY coexist beside the same manifest. They are optional client artifacts, not independent reviews. Creation MUST report a post-publication delivery failure without deleting or rewriting published evidence. Retry retains the original authoring intent; existing different client bytes fail closed. Signed binaries must be re-pinned and re-qualified before distributing the corresponding catalog. No runtime installer or compiler is required on a reviewer's computer.

Show companion mode and expose Stop. Stop closes the listener after active requests complete; closing VS Code stops its instances. Ten minutes without authenticated activity stops an idle helper. An active review poll keeps it alive. Connection loss is an actionable unacknowledged operation, never success. Shutdown never deletes review evidence.

Packages MAY contain `StartReview.exe`/`StartReview`, their checksum, `START-HERE.txt`, `LICENSE`, `THIRD-PARTY-NOTICES.txt` and `build.json`. These are optional client artifacts, not evidence or manifest capabilities. Relocation may inventory/copy them but MUST NOT execute them or treat a colocated checksum as publisher authentication. Client updates are explicit trusted distribution steps.

Bundle the runtime/toolbox and record exact app/runtime versions, official runtime checksum, executable/toolbox digests and actual signing status. Production signing/notarization/endpoint approval remain release tasks. A cross-built Windows executable is not evidence it ran on Windows.

## Acceptance evidence

Required checks: loopback-only startup; capability/origin/Host/embedding denial; path/size bounds; root/manifest replacement; private identity/recovery; host-side role/anchor/event admission; exact-byte idempotent publication; two independent helper/browser sessions; directory picker unavailable; offline Markdown/Mermaid/images/tables; source highlights; reply/close/reopen; participant finish/reopen and roster updates; audited PDF archive/download; idle/explicit shutdown; extension ownership/cleanup; standalone launch without project dependencies.

Offline authoring claims additionally require checking the actual packaged archive for every advertised platform, hashes/notices/receipts and target qualification, then creating from the unpacked distribution with network/authentication access disabled. A required locally qualified Mac client must be present in every authoring variant, not merely offered as an external release asset. Runtime migrations must rerun the same security/E2E assertions and report failed/untested gates explicitly; smaller binaries alone are not sufficient evidence.

Run Node/Chromium tests on local disks on macOS and Windows CI. Actual managed-policy settings, endpoint code execution, default-browser launching and signed binary behavior need target evidence; simulated picker denial is not full enterprise qualification. Windows qualification belongs in enterprise CI, not a newly added public workflow. SMB qualification remains excluded under [ACCEPTANCE.md](ACCEPTANCE.md). Do not test against participants' production folders.
