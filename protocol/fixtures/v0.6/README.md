# Protocol 0.6 conformance fixtures

`conformant-core/` is a checked-in, launcher-independent core package. It contains two linked revisions, Markdown, a frozen SVG, Mermaid, a table, external-reference metadata, comments, a reply, an accepted decision, a suggested edit and application, creator addressing, reviewer verification, closure, approval, rejection and withdrawal receipts. Exact filenames and digests are stable fixture evidence.

The fixture intentionally has no HTML launcher or `.gitattributes`: those belong to the [portable review package profile](../../../spec/PORTABLE-REVIEW-PROFILE-0.6.md), not core validity. End-to-end tests copy the fixture, install the current trusted launcher, and open that same evidence in the real browser and VS Code storage bridge.

`invalid-cases.json` contains deterministic mutations over the conformant package. JSON Pointer identifies the value to replace or remove. A conformance runner applies one mutation at a time and must reject or quarantine the named object with the expected protocol error category; it must never repair the fixture silently.

Regenerate the conformant package only when intentionally changing the 0.6 wire fixture:

```bash
npm run compile
npm run generate:fixture:v06
```

The generator refuses to overwrite an existing fixture. Review protocol changes by generating into a clean branch/directory and comparing every byte.
