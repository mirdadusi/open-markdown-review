# Dependency review — 16 October 2026

The complete application dependency audit, including development/packaging tools, reports **zero vulnerabilities** after this remediation. It has no advisory exceptions. This is dated evidence, not a permanent security guarantee or release approval. Run `npm ci`, `npm test` and `npm audit` on a fresh checkout.

Changes include VSCE 4.0.0, patched Markdown/linkification, URI parsing, DOMPurify, KaTeX and YAML dependencies. The delivered extension, browser toolbox, authoring CLI and Node companion use the same reviewed runtime code and keep their normal license inventories. No organization policy, browser permission or publication gate is bypassed.

## Preserving Slidev v1

The immutable Slidev v1 schema and its 52.19.1 source mapping are unchanged. The MIT-licensed pure parser modules are retained byte-for-byte as a small [local source distribution](../third-party/slidev-parser-core/README.md), rather than installing the otherwise unused `@slidev/types` editor/Vue/build-tool dependency tree in the application. This genuinely removes those dependencies; they are not hidden by audit filters. Each build checks upstream provenance/module/license hashes, inventories the retained code, and tests compare it with an independently installed upstream parser.

`npm audit` cannot inspect arbitrary vendored code. Upstream parser advisories and the retained module's source therefore also require review. Updating parser semantics is a separate profile-compatibility decision, not a silent dependency upgrade. Received projects are never executed by a participant.

## Isolated trusted author fixture: explicit residual risk

The independently locked `examples/slidev` fixture is a development test project, not a delivered client. Its former image-size exceptions were removed: the fixture now pins fixed image-size 2.0.4. [The upstream image advisory records the fix](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr).

One high-severity root advisory remains: [braces recursion/stack exhaustion](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), with no published upstream patch. The audit reports nine propagated high-severity package entries for this one advisory, plus six moderate entries. **This fixture is not audit-clean.** The existing high/critical gate admits only the explicitly approved high finding; moderate findings remain reported, not reclassified as fixed.

The project owner explicitly approved this residual test-fixture denial-of-service risk on **16 October 2026**, expiring **15 November 2026**. Thirty days is a review deadline, not a waiting period, technical requirement or claim of safety. No automatic renewal is allowed.

The [machine-checked policy](../examples/slidev/audit-exceptions.json) binds that single advisory to the reviewed lockfile SHA-256 and exact affected node versions. Expiry, graph changes, new high/critical findings, missing/incomplete audit results, or unexpected propagation fail closed. The fixture executes only the repository-owned trusted PNG deck with explicit author consent and bounded child-process execution. Never apply this exception to arbitrary received decks or to the application's audit. It does not certify a user's independent Slidev installation.

Remove the exception when the dependency is fixed or removed. Any proposed graph change or extension of the date requires another explicit review.

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

Windows/Linux execute these checks in the deployment repository's CI. macOS is qualified locally. Native companion artifacts must be rebuilt/re-pinned after runtime changes and tested on their target platforms. Production signing, managed-endpoint behavior, performance and the remaining professional-pilot gates stay separate.
