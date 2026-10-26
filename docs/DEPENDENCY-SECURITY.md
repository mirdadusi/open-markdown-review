# Dependency review — 26 October 2026

The complete application dependency audit, including development/packaging tools, reports **zero vulnerabilities** after this remediation. It has no advisory exceptions. This is dated evidence, not a permanent security guarantee or release approval. Run `npm ci`, `npm test` and `npm audit` on a fresh checkout.

Changes include VSCE 4.0.0, patched Markdown/linkification, URI parsing, DOMPurify, KaTeX and YAML dependencies. The public build additionally pins fixed MSAL Node 7.1.0 and fast-uri 3.1.9 for newly reported advisories. The Go companions use Go 1.27.3. The delivered extension, browser toolbox and authoring CLI share reviewed runtime code with the Go-hosted browser client; the Node host is retained as an explicit legacy development path. License inventories remain part of the VSIX. No organization policy, browser permission or publication gate is bypassed.

## Preserving Slidev v1

The immutable Slidev v1 schema and its 52.19.1 source mapping are unchanged. The MIT-licensed pure parser modules are retained byte-for-byte as a small [local source distribution](../third-party/slidev-parser-core/README.md), rather than installing the otherwise unused `@slidev/types` editor/Vue/build-tool dependency tree in the application. This genuinely removes those dependencies; they are not hidden by audit filters. Each build checks upstream provenance/module/license hashes, inventories the retained code, and tests compare it with an independently installed upstream parser.

`npm audit` cannot inspect arbitrary vendored code. Upstream parser advisories and the retained module's source therefore also require review. Updating parser semantics is a separate profile-compatibility decision, not a silent dependency upgrade. Received projects are never executed by a participant.

## Isolated trusted author fixture: no active advisory exception

The independently locked `examples/slidev` fixture is a development test project, not a delivered client. Its former image-size exceptions were removed: the fixture now pins fixed image-size 2.0.4. [The upstream image advisory records the fix](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr).

GitHub [withdrew the braces recursion advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) on **23 October 2026**, describing it as not practically exploitable. A fresh `npm audit --include=dev` on 26 October reports zero vulnerabilities for both the application and the isolated fixture. This is a withdrawal, not a claim that a patched braces version was installed.

The former 30-day exception is retired in the current public policy. Its historical file name, `audit-exceptions.json`, is retained for tooling compatibility, but its exception list is empty. There is no exception deadline to renew.

The [machine-checked policy](../examples/slidev/audit-exceptions.json) still binds the exact lockfile SHA-256 and fails on any high/critical finding or unavailable/incomplete audit. The fixture executes only the repository-owned trusted PNG deck with explicit author consent and bounded child-process execution. This does not certify a user's independent Slidev installation or make arbitrary received projects safe to execute. Regression tests retain the old bounded-policy cases to prevent historical exceptions from becoming general permissions.

## Verification

```sh
npm ci
npm test
npm audit
node scripts/install-slidev-fixture.mjs
node --test test/slidev-parser-parity.integration.mjs
node --test out/test/browser.integration.js
node scripts/test-extension.mjs
```

Windows/Linux qualification requires native target hosts; macOS is qualified locally. This public repository does not include organization-specific CI workflows. Native companion artifacts must be rebuilt/re-pinned after runtime changes and tested on their target platforms. Production signing, managed-endpoint behavior, performance and the remaining professional-pilot gates stay separate.
