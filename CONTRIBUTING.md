# Contributing

## Development

Use Node.js 22 or newer and VS Code 1.90 or newer.

```sh
npm ci
npm test
npm run package:vsix -- --out open-markdown-review-local.vsix
```

Open the repository in VS Code and press `F5` to run the Extension Development Host.

## Protocol changes

A protocol change must update all affected layers in one pull request:

1. Normative behavior in `protocol/README.md`.
2. JSON Schemas in `protocol/schemas/` when the wire shape changes.
3. TypeScript types and runtime/cross-file validation in `src/protocol/`.
4. The current fixture in `protocol/fixtures/v0.4/` or a new versioned fixture.
5. Deterministic state, integrity, security, and compatibility tests.
6. `CHANGELOG.md` and the implementer checklist when responsibilities change.

Never edit a published fixture event, revision, blob, or export merely to simulate an update. Add a new immutable event or a new versioned fixture instead.

## Pull requests

- Keep generated dependencies and local VSIX files out of Git.
- Run `npm test` and the production dependency audit before requesting review.
- Describe protocol compatibility and migration impact explicitly.
- Include evidence for UI changes and PDF layout changes where applicable.
- Do not commit secrets, synchronized-drive credentials, or private review packages.
