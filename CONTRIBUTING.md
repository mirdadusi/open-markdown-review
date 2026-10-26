# Contributing

## Development

Use Node.js 22 or newer and VS Code 1.90 or newer.

```sh
npm ci
npm test
npm audit
```

Open the repository in VS Code and press `F5` to run the Extension Development Host.

Complete authoring packages require the three catalog-pinned Go companions and a fresh local Mac qualification. Follow [companion delivery](docs/COMPANION-DELIVERY.md) to build or stage the matching artifacts before packaging. Never substitute binaries from a different version or publisher build. Public extension updates use the native Marketplace channel; companions travel inside the same VSIX, not through a separate updater.

## Protocol changes

A protocol change must update all affected layers in one pull request:

1. Normative behavior in the applicable versioned `spec/PROTOCOL-*.md` and profile specifications; `protocol/README.md` is the entry point.
2. JSON Schemas in `protocol/schemas/` when the wire shape changes.
3. TypeScript types and runtime/cross-file validation in `src/professional/`, with legacy behavior in `src/protocol/` where applicable.
4. The matching versioned fixture, including `protocol/fixtures/v0.6/` for current core behavior.
5. Deterministic state, integrity, security, and compatibility tests.
6. `CHANGELOG.md` and the implementer checklist when responsibilities change.

Never edit a published fixture event, revision, blob, or export merely to simulate an update. Add a new immutable event or a new versioned fixture instead.

## Pull requests

- Keep generated dependencies and local VSIX files out of Git.
- Run `npm test` and the production dependency audit before requesting review.
- Describe protocol compatibility and migration impact explicitly.
- Include evidence for UI changes and PDF layout changes where applicable.
- Do not commit secrets, synchronized-drive credentials, or private review packages.
